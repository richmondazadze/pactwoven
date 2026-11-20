import { createHash, createPublicKey, verify } from 'node:crypto';
import { BaseUnitsSchema, InstantSchema } from '../../../packages/contracts/src/core.js';
import { decodeSolanaBase58, encodeSolanaBase58, FINANCE_DEVNET_ASSET, SolanaPublicKeySchema } from '../../../packages/contracts/src/finance-provenance.js';
import { decodeOriginalSolanaMint, decodeOriginalSolanaTokenAccount } from '../../../packages/adapters/src/solana/token-accounts.js';
import type { SolanaReadEvidence } from '../../../packages/adapters/src/solana/types.js';
import { CHAIN0_MINT_AUTHORITY, CHAIN0_FREEZE_AUTHORITY } from '../../../programs/pactwoven/client/src/identity.js';
import { redecodePaidToolEvidence } from './solana-evidence.js';

const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export type PaidTransferIntent = {
  genesis: string; mint: string; tokenProgram: string; decimals: 6;
  sourceAccount: string; sourceOwner: string; destinationAccount: string; destinationOwner: string; feePayer: string;
  amountBaseUnits: string; blockhash: string; lastValidBlockHeight: string;
  feeLamports: string; maximumFeeLamports: string; minimumAccountSlot: string; validUntil: string;
};
export class PaidTransferError extends Error {
  constructor(readonly code: 'INVALID' | 'MESSAGE_MISMATCH' | 'SIGNATURE_INVALID' | 'ACCOUNT_UNAVAILABLE' | 'CUSTODY_MISMATCH' | 'CONTEXT_STALE' | 'INSUFFICIENT_FUNDS') {
    super(`Paid-tool Solana check rejected: ${code}`); this.name = 'PaidTransferError';
  }
}
const assert = (value: unknown, code: PaidTransferError['code'] = 'INVALID'): void => { if (!value) throw new PaidTransferError(code); };
const units = (value: string) => BigInt(BaseUnitsSchema.parse(value));
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const address = (value: string) => SolanaPublicKeySchema.parse(value);
export function validatePaidTransferIntent(input: PaidTransferIntent): Readonly<PaidTransferIntent> {
  const value = structuredClone(input);
  assert(Object.keys(value).sort().join(',') === ['amountBaseUnits','blockhash','decimals','destinationAccount','destinationOwner','feeLamports','feePayer','genesis','lastValidBlockHeight','maximumFeeLamports','mint','minimumAccountSlot','sourceAccount','sourceOwner','tokenProgram','validUntil'].sort().join(','));
  assert(value.genesis === FINANCE_DEVNET_ASSET.genesis && value.mint === FINANCE_DEVNET_ASSET.mint &&
    value.tokenProgram === FINANCE_DEVNET_ASSET.tokenProgram && value.decimals === 6);
  for (const key of ['sourceAccount', 'sourceOwner', 'destinationAccount', 'destinationOwner', 'feePayer', 'blockhash'] as const) address(value[key]);
  const keys = [value.feePayer, ...(value.feePayer === value.sourceOwner ? [] : [value.sourceOwner]), value.sourceAccount, value.destinationAccount, value.mint, value.tokenProgram];
  assert(new Set(keys).size === keys.length && value.sourceOwner !== value.destinationOwner);
  assert(![value.sourceAccount, value.destinationAccount, value.mint, value.tokenProgram].includes(value.destinationOwner));
  assert(units(value.amountBaseUnits) > 0n && units(value.feeLamports) > 0n && units(value.feeLamports) <= units(value.maximumFeeLamports));
  units(value.lastValidBlockHeight); units(value.minimumAccountSlot); InstantSchema.parse(value.validUntil);
  return Object.freeze(value);
}

export type PaidTransferMessage = Readonly<{ messageBase64: string; messageHash: string; accountKeys: readonly string[];
  signerAddresses: readonly string[]; sourceIndex: number; destinationIndex: number; mintIndex: number; programIndex: number; instructionHex: string }>;
/** Deterministic unsigned legacy message, not a signing permission. No fee
 * instructions, token-account creation, memo, lookup table or extra instruction. */
export function buildPaidTransferMessage(input: PaidTransferIntent): PaidTransferMessage {
  const value = validatePaidTransferIntent(input), separatePayer = value.feePayer !== value.sourceOwner;
  const signerAddresses = separatePayer ? [value.feePayer, value.sourceOwner] : [value.sourceOwner];
  const accountKeys = [...signerAddresses, value.sourceAccount, value.destinationAccount, value.mint, value.tokenProgram];
  const sourceIndex = signerAddresses.length, destinationIndex = sourceIndex + 1, mintIndex = sourceIndex + 2, programIndex = sourceIndex + 3;
  const instruction = Buffer.alloc(10); instruction[0] = 12; instruction.writeBigUInt64LE(units(value.amountBaseUnits), 1); instruction[9] = 6;
  const bytes = Buffer.concat([Buffer.from([signerAddresses.length, separatePayer ? 1 : 0, 2, accountKeys.length]),
    ...accountKeys.map(key => Buffer.from(decodeSolanaBase58(key, 32))), Buffer.from(decodeSolanaBase58(value.blockhash, 32)),
    Buffer.from([1, programIndex, 4, sourceIndex, mintIndex, destinationIndex, separatePayer ? 1 : 0, 10]), instruction]);
  assert(1 + signerAddresses.length * 64 + bytes.length <= 1232);
  return Object.freeze({ messageBase64: bytes.toString('base64'), messageHash: hash(bytes), accountKeys: Object.freeze(accountKeys),
    signerAddresses: Object.freeze(signerAddresses), sourceIndex, destinationIndex, mintIndex, programIndex, instructionHex: instruction.toString('hex') });
}
class Reader {
  private at = 0;
  constructor(private readonly bytes: Buffer) {}
  take(size: number): Buffer { assert(this.at + size <= this.bytes.length, 'MESSAGE_MISMATCH'); const out = this.bytes.subarray(this.at, this.at + size); this.at += size; return out; }
  byte() { return this.take(1)[0]!; }
  key() { return encodeSolanaBase58(this.take(32)); }
  end() { assert(this.at === this.bytes.length, 'MESSAGE_MISMATCH'); }
}
/** Strict decoder for the two canonical layouts emitted above. Even valid
 * Solana messages using any other instruction/layout are intentionally refused. */
export function decodePaidTransferMessage(input: Uint8Array) {
  assert(input instanceof Uint8Array && input.length > 0 && input.length <= 1232, 'MESSAGE_MISMATCH');
  const bytes = Buffer.from(input), reader = new Reader(bytes), signers = reader.byte(), readonlySigners = reader.byte(), readonlyOthers = reader.byte();
  assert((signers === 1 && readonlySigners === 0 || signers === 2 && readonlySigners === 1) && readonlyOthers === 2, 'MESSAGE_MISMATCH');
  const count = reader.byte(); assert(count === signers + 4, 'MESSAGE_MISMATCH');
  const keys = Array.from({ length: count }, () => reader.key()); assert(new Set(keys).size === count, 'MESSAGE_MISMATCH');
  const blockhash = reader.key(); assert(reader.byte() === 1 && reader.byte() === signers + 3 && reader.byte() === 4, 'MESSAGE_MISMATCH');
  const indexes = [...reader.take(4)]; assert(indexes.join(',') === [signers, signers + 2, signers + 1, signers === 2 ? 1 : 0].join(','), 'MESSAGE_MISMATCH');
  assert(reader.byte() === 10, 'MESSAGE_MISMATCH'); const data = reader.take(10); reader.end();
  assert(data[0] === 12 && data[9] === 6 && data.readBigUInt64LE(1) > 0n && keys[signers + 2] === FINANCE_DEVNET_ASSET.mint && keys[signers + 3] === FINANCE_DEVNET_ASSET.tokenProgram, 'MESSAGE_MISMATCH');
  return Object.freeze({ messageHash: hash(bytes), feePayer: keys[0]!, sourceOwner: keys[signers === 2 ? 1 : 0]!,
    sourceAccount: keys[signers]!, destinationAccount: keys[signers + 1]!, blockhash, amountBaseUnits: data.readBigUInt64LE(1).toString(),
    accountKeys: Object.freeze(keys), signerAddresses: Object.freeze(keys.slice(0, signers)), instructionHex: data.toString('hex') });
}

export type VerifiedPaidTransferWire = Readonly<{ signature: string; wireHash: string; messageHash: string; wireBase64: string; signerAddresses: readonly string[] }>;
const verifiedWires = new WeakMap<VerifiedPaidTransferWire, Readonly<PaidTransferIntent>>();
/** Cryptographic byte check only. This neither creates permission nor proves
 * submission/finality. Caller must quarantine bytes before invoking verifier. */
export function verifyPaidTransferWire(input: Uint8Array, intentInput: PaidTransferIntent): VerifiedPaidTransferWire {
  assert(input instanceof Uint8Array && input.length > 0 && input.length <= 1232, 'MESSAGE_MISMATCH');
  const wire = Buffer.from(input), intent = validatePaidTransferIntent(intentInput), expected = buildPaidTransferMessage(intent);
  const count = wire[0]!; assert(count === expected.signerAddresses.length, 'MESSAGE_MISMATCH');
  const message = wire.subarray(1 + count * 64); decodePaidTransferMessage(message);
  assert(message.equals(Buffer.from(expected.messageBase64, 'base64')), 'MESSAGE_MISMATCH');
  const signatures: string[] = [];
  for (let index = 0; index < count; index++) {
    const bytes = wire.subarray(1 + index * 64, 1 + (index + 1) * 64);
    const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(decodeSolanaBase58(expected.signerAddresses[index]!, 32))]), format: 'der', type: 'spki' });
    assert(bytes.length === 64 && verify(null, message, key, bytes), 'SIGNATURE_INVALID'); signatures.push(encodeSolanaBase58(bytes));
  }
  const result = Object.freeze({ signature: signatures[0]!, wireHash: hash(wire), messageHash: expected.messageHash,
    wireBase64: wire.toString('base64'), signerAddresses: expected.signerAddresses });
  verifiedWires.set(result, intent); return result;
}
export function verifiedPaidTransferIntent(wire: VerifiedPaidTransferWire): Readonly<PaidTransferIntent> {
  const intent = verifiedWires.get(wire); assert(intent, 'SIGNATURE_INVALID'); return intent!;
}

/** Source evidence is decoded by the private configured RPC adapter. These
 * observed balances are not an allocation or proof of exclusive custody. */
export async function inspectPaidTransferAccounts(input: PaidTransferIntent, genesisInput: SolanaReadEvidence, accountsInput: SolanaReadEvidence, nowInput: string) {
  const intent = validatePaidTransferIntent(input), now = Date.parse(InstantSchema.parse(nowInput));
  const [genesis, accounts] = await Promise.all([redecodePaidToolEvidence(genesisInput), redecodePaidToolEvidence(accountsInput)]);
  assert(now < Date.parse(intent.validUntil), 'CONTEXT_STALE');
  assert(genesis.outcome.kind === 'decoded' && genesis.outcome.data.method === 'getGenesisHash' && genesis.outcome.data.genesis === intent.genesis && genesis.evidence, 'ACCOUNT_UNAVAILABLE');
  if (accounts.outcome.kind !== 'decoded' || accounts.outcome.data.method !== 'getMultipleAccounts' || !accounts.evidence) throw new PaidTransferError('ACCOUNT_UNAVAILABLE');
  const observed = accounts.outcome.data;
  assert(units(observed.context.slot) >= units(intent.minimumAccountSlot), 'CONTEXT_STALE');
  const expected = [intent.mint, intent.sourceAccount, intent.destinationAccount, intent.feePayer, ...(intent.sourceOwner === intent.feePayer ? [] : [intent.sourceOwner])];
  assert(observed.accounts.length === expected.length && observed.accounts.every((account, index) => account?.address === expected[index]), 'CUSTODY_MISMATCH');
  const mint = decodeOriginalSolanaMint(observed.accounts[0]!), source = decodeOriginalSolanaTokenAccount(observed.accounts[1]!), destination = decodeOriginalSolanaTokenAccount(observed.accounts[2]!);
  assert(mint.initialized && mint.mintAuthority === CHAIN0_MINT_AUTHORITY && mint.freezeAuthority === CHAIN0_FREEZE_AUTHORITY, 'CUSTODY_MISMATCH');
  for (const token of [source, destination]) assert(token.state === 'initialized' && token.delegate === null && token.delegatedAmountBaseUnits === '0' && token.nativeReserveBaseUnits === null && token.closeAuthority === null, 'CUSTODY_MISMATCH');
  assert(source.authority === intent.sourceOwner && destination.authority === intent.destinationOwner, 'CUSTODY_MISMATCH');
  for (const wallet of observed.accounts.slice(3)) assert(wallet && wallet.owner === SYSTEM_PROGRAM && !wallet.executable && wallet.dataHex === '' && (wallet.space === null || wallet.space === '0'), 'CUSTODY_MISMATCH');
  assert(units(source.amountBaseUnits) >= units(intent.amountBaseUnits) && units(observed.accounts[3]!.lamports) >= units(intent.maximumFeeLamports), 'INSUFFICIENT_FUNDS');
  return Object.freeze({ authority: 'none' as const, sourceBalanceBaseUnits: source.amountBaseUnits, destinationBalanceBaseUnits: destination.amountBaseUnits,
    feePayerLamports: observed.accounts[3]!.lamports, slot: observed.context.slot, evidenceRef: accounts.evidence.reference, evidenceHash: accounts.evidence.sha256 });
}
