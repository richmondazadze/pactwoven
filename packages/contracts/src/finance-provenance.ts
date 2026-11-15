import { z } from 'zod';
import { BaseUnitsSchema, EnvironmentSchema, IdSchema, InstantSchema } from './core';
import { HashSchema } from './financial';

const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function encodeSolanaBase58(bytes: Uint8Array): string {
  let value = 0n, encoded = '', zeros = 0;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  while (value) { encoded = alphabet[Number(value % 58n)] + encoded; value /= 58n; }
  return '1'.repeat(zeros) + encoded;
}
export function decodeSolanaBase58(text: string, size: 32 | 64): Uint8Array {
  if (typeof text !== 'string' || text.length < 1 || text.length > (size === 32 ? 44 : 88)) throw new Error('Invalid fixed-length Solana identity.');
  let value = 0n, zeros = 0;
  for (const char of text) { const digit = alphabet.indexOf(char); if (digit < 0) throw new Error('Invalid base58 alphabet.'); value = value * 58n + BigInt(digit); }
  while (text[zeros] === '1') zeros++;
  const tail: number[] = []; while (value) { tail.unshift(Number(value & 255n)); value >>= 8n; }
  const bytes = Uint8Array.from([...Array<number>(zeros).fill(0), ...tail]);
  if (bytes.length !== size || encodeSolanaBase58(bytes) !== text) throw new Error('Noncanonical Solana identity.');
  return bytes;
}
const base58 = (size: 32 | 64) => z.string().max(size === 32 ? 44 : 88).refine(value => {
  try { decodeSolanaBase58(value, size); return true; } catch { return false; }
}, 'Use a canonical fixed-length base58 identity.');
export const SolanaPublicKeySchema = base58(32);
export const SolanaSignatureSchema = base58(64);
export const FinanceProvenanceVersionSchema = z.number().int().positive().max(2_147_483_647);
export const FinanceEvidenceSchema = z.strictObject({ reference: z.string().min(1).max(512), sha256: HashSchema });
export const FinanceRegistryReferenceSchema = z.strictObject({ key: HashSchema, version: FinanceProvenanceVersionSchema });
export const FinanceSourceReferenceSchema = z.strictObject({ id: IdSchema, version: FinanceProvenanceVersionSchema });
export const FinancePhysicalAssetSchema = z.strictObject({ genesis: SolanaPublicKeySchema, tokenProgram: SolanaPublicKeySchema, mint: SolanaPublicKeySchema });
export const FinancePhysicalAccountSchema = z.strictObject({ genesis: SolanaPublicKeySchema, address: SolanaPublicKeySchema });
export const FINANCE_DEVNET_ASSET = Object.freeze({
  genesis: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
});
const versionEvidence = { version: FinanceProvenanceVersionSchema, policyHash: HashSchema, verifierVersion: IdSchema,
  evidence: z.array(FinanceEvidenceSchema).max(16) };
// Configuration records describe intended policy. They do not certify custody or funds.
export const FinanceAssetVersionSchema = z.strictObject({ ...versionEvidence, assetKey: HashSchema,
  policy: z.literal('solana-original-devnet-usdc-v1'), decimals: z.literal(6) });
export const FinanceAccountVersionSchema = z.strictObject({ ...versionEvidence, accountKey: HashSchema,
  assetKey: HashSchema, expectedAuthority: SolanaPublicKeySchema, incarnationEvidence: FinanceEvidenceSchema.nullable() });
export const FinanceSourceVersionSchema = z.strictObject({ ...versionEvidence, sourceId: IdSchema,
  endpointConfigurationHash: HashSchema, adapterVersion: IdSchema, normalizerVersion: IdSchema });

const position = z.number().int().nonnegative().max(65_534);
export const FinanceTransferLocatorSchema = z.strictObject({ genesis: SolanaPublicKeySchema, signature: SolanaSignatureSchema,
  outerInstructionIndex: position, innerInstructionOrdinal: position.nullable() });
export const FinanceTransferFactSchema = z.strictObject({ locator: FinanceTransferLocatorSchema,
  asset: FinancePhysicalAssetSchema, source: SolanaPublicKeySchema, destination: SolanaPublicKeySchema,
  amountBaseUnits: BaseUnitsSchema, instructionKind: z.enum(['Transfer', 'TransferChecked']),
  checkedDecimals: z.literal(6).nullable(), instructionDataHash: HashSchema,
}).refine(value => value.locator.genesis === value.asset.genesis &&
  (value.instructionKind === 'TransferChecked' ? value.checkedDecimals === 6 : value.checkedDecimals === null), 'Transfer identity or checked decimals mismatch.');
export const FinanceObservationContextSchema = z.strictObject({ observedAt: InstantSchema, slot: BaseUnitsSchema,
  commitment: z.enum(['processed', 'confirmed', 'finalized']), blockHash: SolanaPublicKeySchema.nullable(), evidence: FinanceEvidenceSchema });
const execution = z.strictObject({ transaction: z.literal('succeeded'), invocation: z.literal('succeeded'), evidence: FinanceEvidenceSchema,
  outerInstructionCount: z.number().int().positive().max(65_535), innerInstructionCount: z.number().int().nonnegative().max(65_535),
  stackHeight: z.number().int().positive().max(64).nullable() });
export const FinanceBalanceObservationSchema = z.strictObject({ kind: z.literal('balance'), context: FinanceObservationContextSchema,
  amountBaseUnits: BaseUnitsSchema, accountDataHex: z.string().regex(/^[0-9a-f]{330}$/) });
export const FinanceTransferObservationSchema = z.strictObject({ kind: z.literal('transfer'), context: FinanceObservationContextSchema,
  fact: FinanceTransferFactSchema, execution }).refine(value => value.fact.locator.outerInstructionIndex < value.execution.outerInstructionCount &&
    (value.fact.locator.innerInstructionOrdinal === null || value.fact.locator.innerInstructionOrdinal < value.execution.innerInstructionCount), 'Instruction position must exist in the retained original instruction arrays.');
export const FinanceFinalityObservationSchema = z.strictObject({ kind: z.literal('finality'), context: FinanceObservationContextSchema,
  locator: FinanceTransferLocatorSchema, transactionStatus: z.enum(['succeeded', 'failed', 'unknown']) });
export const FinanceTransactionObservationSchema = z.strictObject({ kind: z.literal('transaction'), context: FinanceObservationContextSchema,
  genesis: SolanaPublicKeySchema, signature: SolanaSignatureSchema, transactionStatus: z.enum(['succeeded', 'failed', 'unknown']),
  transactionVersion: z.union([z.literal('legacy'), z.literal(0)]), executionEvidence: FinanceEvidenceSchema });
// Retain exact opaque payloads before decoding; this variant has no normalized fact or claimed amount.
export const FinanceRawObservationSchema = z.strictObject({ kind: z.literal('raw'),
  reason: z.enum(['unparsed', 'unsupported', 'source_error']), detail: z.string().max(512) });
export const FinanceObservationSchema = z.union([FinanceBalanceObservationSchema, FinanceTransferObservationSchema,
  FinanceFinalityObservationSchema, FinanceTransactionObservationSchema, FinanceRawObservationSchema]);
export const FinanceDeliveryKeySchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:/-]+$/);
export const FinanceProvenanceAppendSchema = z.strictObject({ schemaVersion: z.literal(1), source: FinanceSourceReferenceSchema,
  account: FinanceRegistryReferenceSchema, asset: FinanceRegistryReferenceSchema, deliveryKey: FinanceDeliveryKeySchema,
  adapterVersion: IdSchema, normalizerVersion: IdSchema, payloadHex: z.string().min(2).max(262_144).regex(/^(?:[0-9a-f]{2})+$/), payloadHash: HashSchema,
  evidence: FinanceEvidenceSchema, providerMetadata: z.record(z.string().min(1).max(64).regex(/^[A-Za-z0-9_.:-]+$/), z.string().max(512)).refine(value => Object.keys(value).length <= 16),
  observation: FinanceObservationSchema });
export const FinanceProvenanceLookupSchema = z.strictObject({ sourceId: IdSchema, accountKey: HashSchema, deliveryKey: FinanceDeliveryKeySchema });
const receiptScope = { sourceId: IdSchema, accountKey: HashSchema, deliveryKey: FinanceDeliveryKeySchema,
  environment: EnvironmentSchema, organizationId: IdSchema };
export const FinanceDeliveryReceiptSchema = z.strictObject({ kind: z.literal('delivery'), ...receiptScope,
  receiptId: z.uuid(), sourceVersion: FinanceProvenanceVersionSchema, accountVersion: FinanceProvenanceVersionSchema,
  asset: FinanceRegistryReferenceSchema, payloadHash: HashSchema, inputHash: HashSchema, receivedAt: InstantSchema,
  disposition: z.enum(['recorded', 'quarantined']), observationKind: z.enum(['balance', 'transfer', 'finality', 'transaction', 'raw']),
  transferKey: HashSchema.nullable(), effectKey: HashSchema.nullable(), conflictId: z.uuid().nullable(),
}).refine(value => (value.disposition === 'quarantined') === (value.conflictId !== null), 'Quarantine must identify its immutable conflict.');
export const FinanceConflictReceiptSchema = z.strictObject({ kind: z.literal('conflict'), ...receiptScope,
  conflictId: z.uuid(), reason: z.enum(['DELIVERY_REUSE', 'TRANSFER_FACT_CONFLICT']), attemptHash: HashSchema,
  payloadHash: HashSchema, originalReceiptId: z.uuid(), receivedAt: InstantSchema });
export const FinanceProvenanceResultSchema = z.union([FinanceDeliveryReceiptSchema, FinanceConflictReceiptSchema]);
export type FinancePhysicalAsset = z.infer<typeof FinancePhysicalAssetSchema>;
export type FinancePhysicalAccount = z.infer<typeof FinancePhysicalAccountSchema>;
export type FinanceTransferLocator = z.infer<typeof FinanceTransferLocatorSchema>;
export type FinanceTransferFact = z.infer<typeof FinanceTransferFactSchema>;
export type FinanceProvenanceAppend = z.infer<typeof FinanceProvenanceAppendSchema>;
export type FinanceProvenanceLookup = z.infer<typeof FinanceProvenanceLookupSchema>;
export type FinanceDeliveryReceipt = z.infer<typeof FinanceDeliveryReceiptSchema>;
export type FinanceProvenanceResult = z.infer<typeof FinanceProvenanceResultSchema>;
