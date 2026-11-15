import { decodeSolanaBase58, encodeSolanaBase58, FINANCE_DEVNET_ASSET, FinancePhysicalAccountSchema, FinancePhysicalAssetSchema,
  FinanceProvenanceAppendSchema, FinanceTransferFactSchema, FinanceTransferLocatorSchema, type FinancePhysicalAccount,
  type FinancePhysicalAsset, type FinanceProvenanceAppend, type FinanceTransferFact, type FinanceTransferLocator } from '@pactwoven/contracts';
import { canonicalJson, commandDigest } from './canonical.js';

const utf8 = new TextEncoder();
export const provenanceHex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
export function provenanceBytes(hex: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/.test(hex)) throw new Error('Canonical hexadecimal bytes required.');
  return Uint8Array.from(hex.match(/../g) ?? [], value => Number.parseInt(value, 16));
}
async function digestBytes(...parts: Uint8Array[]): Promise<string> {
  const input = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let position = 0; for (const part of parts) { input.set(part, position); position += part.length; }
  return provenanceHex(new Uint8Array(await crypto.subtle.digest('SHA-256', input)));
}
const tag = (name: string) => utf8.encode(`pactwoven:solana-${name}:v1\0`);
const uint32 = (value: number) => { const bytes = new Uint8Array(4); new DataView(bytes.buffer).setUint32(0, value, true); return bytes; };
export async function physicalAssetKey(input: FinancePhysicalAsset): Promise<string> {
  const asset = FinancePhysicalAssetSchema.parse(input);
  return digestBytes(tag('asset'), decodeSolanaBase58(asset.genesis, 32), decodeSolanaBase58(asset.tokenProgram, 32), decodeSolanaBase58(asset.mint, 32));
}
export async function physicalAccountKey(input: FinancePhysicalAccount): Promise<string> {
  const account = FinancePhysicalAccountSchema.parse(input);
  return digestBytes(tag('account'), decodeSolanaBase58(account.genesis, 32), decodeSolanaBase58(account.address, 32));
}
export async function physicalTransferKey(input: FinanceTransferLocator): Promise<string> {
  const value = FinanceTransferLocatorSchema.parse(input);
  return digestBytes(tag('transfer'), decodeSolanaBase58(value.genesis, 32), decodeSolanaBase58(value.signature, 64),
    uint32(value.outerInstructionIndex), Uint8Array.of(value.innerInstructionOrdinal === null ? 0 : 1),
    value.innerInstructionOrdinal === null ? new Uint8Array() : uint32(value.innerInstructionOrdinal));
}
export async function physicalAccountEffectKey(locator: FinanceTransferLocator, account: FinancePhysicalAccount): Promise<string> {
  if (locator.genesis !== account.genesis) throw new Error('Account and transfer chain differ.');
  return digestBytes(tag('account-effect'), provenanceBytes(await physicalTransferKey(locator)), provenanceBytes(await physicalAccountKey(account)));
}
export async function transferFactDigest(input: FinanceTransferFact): Promise<string> { return commandDigest(FinanceTransferFactSchema.parse(input)); }
export function transferFactsEqual(a: FinanceTransferFact, b: FinanceTransferFact): boolean {
  return canonicalJson(FinanceTransferFactSchema.parse(a)) === canonicalJson(FinanceTransferFactSchema.parse(b));
}
export function transferDirection(fact: FinanceTransferFact, account: FinancePhysicalAccount): 'incoming' | 'outgoing' | 'self' {
  FinanceTransferFactSchema.parse(fact); FinancePhysicalAccountSchema.parse(account);
  if (fact.locator.genesis !== account.genesis || (fact.source !== account.address && fact.destination !== account.address)) throw new Error('The affected account does not belong to this transfer.');
  return fact.source === account.address ? (fact.destination === account.address ? 'self' : 'outgoing') : 'incoming';
}
export function decodeProvenanceTokenAccount(hex: string) {
  const bytes = provenanceBytes(hex); if (bytes.length !== 165) throw new Error('Original token account layout required.');
  const view = new DataView(bytes.buffer), option = (offset: number, at: number) => {
    const present = view.getUint32(offset, true); if (present !== 0 && present !== 1) throw new Error('Invalid token account option.');
    return present ? encodeSolanaBase58(bytes.slice(at, at + 32)) : null;
  };
  const native = view.getUint32(109, true); if (native !== 0 && native !== 1 || bytes[108]! > 2) throw new Error('Invalid token account state.');
  return { mint: encodeSolanaBase58(bytes.slice(0, 32)), authority: encodeSolanaBase58(bytes.slice(32, 64)),
    amountBaseUnits: view.getBigUint64(64, true).toString(), delegate: option(72, 76), state: bytes[108]!,
    nativeReserveBaseUnits: native ? view.getBigUint64(113, true).toString() : null,
    delegatedAmountBaseUnits: view.getBigUint64(121, true).toString(), closeAuthority: option(129, 133) };
}
/** This verifies internal evidence consistency only. An authenticated source may still lie. */
export async function prepareProvenanceAppend(input: FinanceProvenanceAppend): Promise<FinanceProvenanceAppend> {
  const value = FinanceProvenanceAppendSchema.parse(structuredClone(input));
  if (await digestBytes(provenanceBytes(value.payloadHex)) !== value.payloadHash) throw new Error('The exact delivery bytes differ from their digest.');
  if (value.asset.key !== await physicalAssetKey(FINANCE_DEVNET_ASSET)) throw new Error('Unsupported physical asset policy.');
  const observation = value.observation;
  if (observation.kind === 'balance') {
    const account = decodeProvenanceTokenAccount(observation.accountDataHex);
    if (account.mint !== FINANCE_DEVNET_ASSET.mint || account.amountBaseUnits !== observation.amountBaseUnits) throw new Error('Balance evidence differs from the standard token account bytes.');
  } else if (observation.kind === 'transfer') {
    if (canonicalJson(observation.fact.asset) !== canonicalJson(FINANCE_DEVNET_ASSET)) throw new Error('Unsupported transfer asset.');
    const source = await physicalAccountKey({ genesis: observation.fact.locator.genesis, address: observation.fact.source });
    const destination = await physicalAccountKey({ genesis: observation.fact.locator.genesis, address: observation.fact.destination });
    if (value.account.key !== source && value.account.key !== destination) throw new Error('Transfer does not affect this physical account.');
  } else if (observation.kind !== 'raw' && (observation.kind === 'finality' ? observation.locator.genesis : observation.genesis) !== FINANCE_DEVNET_ASSET.genesis) throw new Error('Observation uses a different chain.');
  return value;
}
