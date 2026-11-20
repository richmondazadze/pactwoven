import { generateKeyPairSync, sign } from 'node:crypto';
import { decodeSolanaBase58, encodeSolanaBase58, FINANCE_DEVNET_ASSET } from '../../../packages/contracts/src/finance-provenance.js';
import { prepareSolanaRead, decodeSolanaReadResponse } from '../../../packages/adapters/src/solana/rpc-read.js';
import type { SolanaReadCommand } from '../../../packages/adapters/src/solana/types.js';
import { CHAIN0_MINT_AUTHORITY, CHAIN0_FREEZE_AUTHORITY } from '../../../programs/pactwoven/client/src/identity.js';
import { buildPaidTransferMessage, verifyPaidTransferWire, type PaidTransferIntent } from './solana-transfer.js';

export const publicAddress = (n: number) => encodeSolanaBase58(new Uint8Array(32).fill(n));
export const now = '2026-11-19T16:00:00Z';
/** Disposable IN-MEMORY cryptographic fixtures only. No user key, wallet,
 * provider, filesystem key storage, or chain signing is accessed here. */
export function transferFixture(separatePayer = false) {
  const owner = generateKeyPairSync('ed25519'), payer = separatePayer ? generateKeyPairSync('ed25519') : owner;
  const key = (pair: typeof owner) => encodeSolanaBase58(pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
  const intent: PaidTransferIntent = { ...FINANCE_DEVNET_ASSET, decimals: 6, sourceAccount: publicAddress(1), sourceOwner: key(owner),
    destinationAccount: publicAddress(2), destinationOwner: publicAddress(3), feePayer: key(payer), amountBaseUnits: '10000',
    blockhash: publicAddress(4), lastValidBlockHeight: '300', feeLamports: separatePayer ? '10000' : '5000', maximumFeeLamports: '15000',
    minimumAccountSlot: '100', validUntil: '2026-11-19T16:05:00Z' };
  const message = buildPaidTransferMessage(intent), messageBytes = Buffer.from(message.messageBase64, 'base64');
  const signatures = (separatePayer ? [payer, owner] : [owner]).map(pair => sign(null, messageBytes, pair.privateKey));
  const wireBytes = Buffer.concat([Buffer.from([signatures.length]), ...signatures, messageBytes]);
  return { fixtureKeys: new Map([[key(owner), owner.privateKey], [key(payer), payer.privateKey]]), intent, message, messageBytes, wireBytes, wire: verifyPaidTransferWire(wireBytes, intent), signatures: signatures.map(encodeSolanaBase58) };
}
export async function readFixture(id: string, command: SolanaReadCommand, result: unknown) {
  const request = prepareSolanaRead(id, command);
  return decodeSolanaReadResponse(request, Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result })), `fixture_${id}`);
}
export function tokenBytes(owner: string, balance: bigint) {
  const bytes = Buffer.alloc(165); Buffer.from(decodeSolanaBase58(FINANCE_DEVNET_ASSET.mint, 32)).copy(bytes);
  Buffer.from(decodeSolanaBase58(owner, 32)).copy(bytes, 32); bytes.writeBigUInt64LE(balance, 64); bytes[108] = 1; return bytes;
}
export function accountFixture(intent: PaidTransferIntent) {
  const mint = Buffer.alloc(82); mint.writeUInt32LE(1); Buffer.from(decodeSolanaBase58(CHAIN0_MINT_AUTHORITY, 32)).copy(mint, 4);
  mint.writeBigUInt64LE(1_000_000_000n, 36); mint[44] = 6; mint[45] = 1; mint.writeUInt32LE(1, 46); Buffer.from(decodeSolanaBase58(CHAIN0_FREEZE_AUTHORITY, 32)).copy(mint, 50);
  const source = tokenBytes(intent.sourceOwner, 500_000n), destination = tokenBytes(intent.destinationOwner, 0n);
  const account = (bytes: Buffer, wallet = false) => ({ data: [bytes.toString('base64'), 'base64'], owner: wallet ? '11111111111111111111111111111111' : intent.tokenProgram,
    executable: false, lamports: wallet ? 1_000_000_000 : 2_039_280, rentEpoch: 1, space: bytes.length });
  return { source, destination, mint, addresses: [intent.mint, intent.sourceAccount, intent.destinationAccount, intent.feePayer, ...(intent.feePayer === intent.sourceOwner ? [] : [intent.sourceOwner])],
    result: { context: { slot: 120 }, value: [account(mint), account(source), account(destination), account(Buffer.alloc(0), true), ...(intent.feePayer === intent.sourceOwner ? [] : [account(Buffer.alloc(0), true)])] } };
}
export function transactionFixture(f: ReturnType<typeof transferFixture>) {
  const token = (index: number, owner: string, amount: string) => ({ accountIndex: index, mint: f.intent.mint, owner, programId: f.intent.tokenProgram,
    uiTokenAmount: { amount, decimals: 6, uiAmount: null, uiAmountString: amount } });
  const pre = f.message.accountKeys.map((_, index) => index === 0 ? 1_000_000_000 : 2_039_280);
  const post = pre.map((value, index) => index === 0 ? value - Number(f.intent.feeLamports) : value);
  return { slot: 123, blockTime: 1795104000, version: 'legacy',
    transaction: { signatures: f.signatures, message: { accountKeys: [...f.message.accountKeys],
      header: { numRequiredSignatures: f.signatures.length, numReadonlySignedAccounts: f.signatures.length === 2 ? 1 : 0, numReadonlyUnsignedAccounts: 2 },
      recentBlockhash: f.intent.blockhash, instructions: [{ programIdIndex: f.message.programIndex,
        accounts: [f.message.sourceIndex, f.message.mintIndex, f.message.destinationIndex, f.signatures.length === 2 ? 1 : 0],
        data: encodeSolanaBase58(Buffer.from(f.message.instructionHex, 'hex')) }] } },
    meta: { err: null, status: { Ok: null }, fee: Number(f.intent.feeLamports), preBalances: pre, postBalances: post, innerInstructions: [], logMessages: [],
      preTokenBalances: [token(f.message.sourceIndex, f.intent.sourceOwner, '500000'), token(f.message.destinationIndex, f.intent.destinationOwner, '0')],
      postTokenBalances: [token(f.message.sourceIndex, f.intent.sourceOwner, '490000'), token(f.message.destinationIndex, f.intent.destinationOwner, '10000')] } };
}
export async function finalityFixture(f: ReturnType<typeof transferFixture>, mutate: (value: ReturnType<typeof transactionFixture>) => void = () => {}) {
  const value = transactionFixture(f); mutate(value);
  return { genesis: await readFixture('genesis', { method: 'getGenesisHash' }, f.intent.genesis),
    status: await readFixture('status', { method: 'getSignatureStatuses', signatures: [f.wire.signature] }, {
      context: { slot: 130 }, value: [{ slot: 123, confirmations: null, err: null, status: { Ok: null }, confirmationStatus: 'finalized' }] }),
    transaction: await readFixture('transaction', { method: 'getTransaction', signature: f.wire.signature }, value) };
}
