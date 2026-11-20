import { createHash } from 'node:crypto';
import { InstantSchema } from '../../../packages/contracts/src/core.js';
import { FINANCE_DEVNET_ASSET, encodeSolanaBase58 as encodeSignature } from '../../../packages/contracts/src/finance-provenance.js';
import { parseSolanaJson, solanaJsonObject, solanaJsonArray, solanaJsonString, solanaIntegerText, solanaSmallInteger } from '../../../packages/adapters/src/solana/lossless-json.js';
import type { SolanaReadEvidence, SolanaHistoricalTokenBalance } from '../../../packages/adapters/src/solana/types.js';
import { buildPaidTransferMessage, verifiedPaidTransferIntent, type VerifiedPaidTransferWire } from './solana-transfer.js';
import { redecodePaidToolEvidence } from './solana-evidence.js';

export class PaidTransferFinalityError extends Error {
  constructor(readonly code: 'NOT_FINALIZED' | 'EVIDENCE_MISMATCH' | 'TRANSFER_MISMATCH' | 'FEE_MISMATCH') {
    super(`Paid-tool finality unavailable: ${code}`); this.name = 'PaidTransferFinalityError';
  }
}
function assert(value: unknown, code: PaidTransferFinalityError['code'] = 'EVIDENCE_MISMATCH'): void { if (!value) throw new PaidTransferFinalityError(code); }
function token(rows: readonly SolanaHistoricalTokenBalance[], index: number, owner: string) {
  const row = rows.find(item => item.accountIndex === index);
  assert(row && row.owner === owner && row.mint === FINANCE_DEVNET_ASSET.mint && row.decimals === 6 && row.tokenProgram === FINANCE_DEVNET_ASSET.tokenProgram, 'TRANSFER_MISMATCH');
  return BigInt(row!.amountBaseUnits);
}
function raw(evidence: SolanaReadEvidence) {
  assert(evidence.evidence && /^[0-9a-f]+$/.test(evidence.evidence.payloadHex));
  const bytes = Buffer.from(evidence.evidence!.payloadHex, 'hex');
  assert(bytes.length === evidence.evidence!.byteLength && createHash('sha256').update(bytes).digest('hex') === evidence.evidence!.sha256);
  const envelope = solanaJsonObject(parseSolanaJson(bytes), ['jsonrpc', 'id', 'result'], ['jsonrpc', 'id', 'result']);
  assert(envelope.jsonrpc === '2.0' && envelope.id === evidence.request.id);
  return envelope.result!;
}
/** Independent comparison of configured-provider decoded evidence to original
 * cryptographically verified bytes. This is not a network client or spend
 * permission. Null/pending/incomplete evidence never becomes a payment. */
export async function inspectPaidTransferFinality(wire: VerifiedPaidTransferWire, genesisInput: SolanaReadEvidence,
  statusInput: SolanaReadEvidence, transactionInput: SolanaReadEvidence, observedAtInput: string) {
  const observedAt = InstantSchema.parse(observedAtInput), intent = verifiedPaidTransferIntent(wire), expected = buildPaidTransferMessage(intent);
  const [genesis, statusEvidence, transactionEvidence] = await Promise.all([redecodePaidToolEvidence(genesisInput), redecodePaidToolEvidence(statusInput), redecodePaidToolEvidence(transactionInput)]);
  assert(genesis.outcome.kind === 'decoded' && genesis.outcome.data.method === 'getGenesisHash' && genesis.outcome.data.genesis === intent.genesis && genesis.evidence);
  assert(raw(genesis) === intent.genesis);
  if (statusEvidence.outcome.kind !== 'decoded' || statusEvidence.outcome.data.method !== 'getSignatureStatuses') throw new PaidTransferFinalityError('NOT_FINALIZED');
  const statuses = statusEvidence.outcome.data.statuses, status = statuses[0];
  assert(statuses.length === 1 && status?.signature === wire.signature && status.confirmationStatus === 'finalized' && status.confirmations === null && status.transactionStatus === 'succeeded', 'NOT_FINALIZED');
  if (transactionEvidence.outcome.kind !== 'decoded' || transactionEvidence.outcome.data.method !== 'getTransaction') throw new PaidTransferFinalityError('NOT_FINALIZED');
  const tx = transactionEvidence.outcome.data.transaction;
  assert(transactionEvidence.request.method === 'getTransaction' && statusEvidence.request.method === 'getSignatureStatuses');
  assert(tx.signature === wire.signature && tx.slot === status!.slot && BigInt(statusEvidence.outcome.data.context.slot) >= BigInt(tx.slot) &&
    tx.version === 'legacy' && tx.transactionStatus === 'succeeded' && tx.missingMetadata.length === 0 && tx.loadedReadonly.length === 0 && tx.loadedWritable.length === 0, 'NOT_FINALIZED');
  assert(tx.staticAccountKeys.join(',') === expected.accountKeys.join(',') && tx.resolvedAccountKeys.join(',') === expected.accountKeys.join(','));
  assert(tx.instructions.length === 1 && tx.innerInstructions?.length === 0, 'TRANSFER_MISMATCH');
  const instruction = tx.instructions[0]!;
  assert(instruction.programIdIndex === expected.programIndex && instruction.dataHex === expected.instructionHex &&
    instruction.accountIndexes.join(',') === [expected.sourceIndex, expected.mintIndex, expected.destinationIndex, expected.signerAddresses.length === 2 ? 1 : 0].join(','), 'TRANSFER_MISMATCH');
  assert(tx.feeLamports === intent.feeLamports && BigInt(tx.feeLamports!) <= BigInt(intent.maximumFeeLamports), 'FEE_MISMATCH');
  assert(tx.preTokenBalances?.length === 2 && tx.postTokenBalances?.length === 2, 'TRANSFER_MISMATCH');
  const sourceBefore = token(tx.preTokenBalances!, expected.sourceIndex, intent.sourceOwner), sourceAfter = token(tx.postTokenBalances!, expected.sourceIndex, intent.sourceOwner);
  const destinationBefore = token(tx.preTokenBalances!, expected.destinationIndex, intent.destinationOwner), destinationAfter = token(tx.postTokenBalances!, expected.destinationIndex, intent.destinationOwner);
  assert(sourceBefore - sourceAfter === BigInt(intent.amountBaseUnits) && destinationAfter - destinationBefore === BigInt(intent.amountBaseUnits), 'TRANSFER_MISMATCH');

  // Recheck evidence bytes that the general decoder does not retain in its
  // projection: exact signatures, header/blockhash and every lamport delta.
  const result = solanaJsonObject(raw(transactionEvidence), ['slot', 'blockTime', 'version', 'transaction', 'meta'], ['slot', 'version', 'transaction', 'meta']);
  const transaction = solanaJsonObject(result.transaction, ['signatures', 'message']);
  const signatures = solanaJsonArray(transaction.signatures, 2).map(value => solanaJsonString(value, 88));
  assert(signatures.length === expected.signerAddresses.length && signatures[0] === wire.signature);
  const wireBytes = Buffer.from(wire.wireBase64, 'base64');
  // All signatures were cryptographically checked by verifyPaidTransferWire.
  // Compare secondary signature strings to the original retained byte vector.
  if (signatures.length === 2) assert(signatures[1] === encodeSignature(wireBytes.subarray(65, 129)));
  const message = solanaJsonObject(transaction.message, ['accountKeys', 'header', 'recentBlockhash', 'instructions', 'addressTableLookups'], ['accountKeys', 'header', 'recentBlockhash', 'instructions']);
  const header = solanaJsonObject(message.header, ['numRequiredSignatures', 'numReadonlySignedAccounts', 'numReadonlyUnsignedAccounts']);
  assert(solanaSmallInteger(header.numRequiredSignatures, 2) === expected.signerAddresses.length &&
    solanaSmallInteger(header.numReadonlySignedAccounts, 1) === (expected.signerAddresses.length === 2 ? 1 : 0) &&
    solanaSmallInteger(header.numReadonlyUnsignedAccounts, 6) === 2 && solanaJsonString(message.recentBlockhash, 44) === intent.blockhash);
  const meta = solanaJsonObject(result.meta, ['err', 'status', 'fee', 'preBalances', 'postBalances', 'innerInstructions', 'logMessages', 'preTokenBalances', 'postTokenBalances',
    'rewards', 'loadedAddresses', 'returnData', 'computeUnitsConsumed', 'costUnits'], ['err', 'fee', 'preBalances', 'postBalances']);
  const pre = solanaJsonArray(meta.preBalances, 6).map(value => BigInt(solanaIntegerText(value))), post = solanaJsonArray(meta.postBalances, 6).map(value => BigInt(solanaIntegerText(value)));
  assert(pre.length === expected.accountKeys.length && post.length === pre.length && pre.every((balance, index) => balance - post[index]! === (index === 0 ? BigInt(intent.feeLamports) : 0n)), 'FEE_MISMATCH');
  raw(statusEvidence);
  return Object.freeze({ status: 'finalized_transfer' as const, signature: wire.signature, slot: tx.slot, observedAt,
    genesis: intent.genesis, mint: intent.mint, tokenProgram: intent.tokenProgram, sourceAccount: intent.sourceAccount,
    sourceOwner: intent.sourceOwner, destinationAccount: intent.destinationAccount, destinationOwner: intent.destinationOwner,
    amountBaseUnits: intent.amountBaseUnits, feeLamports: tx.feeLamports!, messageHash: wire.messageHash,
    transactionEvidenceRef: transactionEvidence.evidence!.reference, transactionEvidenceHash: transactionEvidence.evidence!.sha256,
    statusEvidenceRef: statusEvidence.evidence!.reference, statusEvidenceHash: statusEvidence.evidence!.sha256 });
}
