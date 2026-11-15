import { z } from 'zod';
import { EnvironmentSchema, IdSchema } from './core';
import { HashSchema } from './financial';

export const FinancialFenceVersionSchema = z.number().int().min(1).max(2_147_483_647);
export const FinancialFenceGenerationSchema = z.number().int().min(0).max(2_147_483_647);
export const FinancialLegacyHeadReferenceSchema = z.strictObject({
  mandateId: IdSchema, mandateVersion: FinancialFenceVersionSchema, mandateEpoch: FinancialFenceVersionSchema,
  hash: HashSchema, state: z.enum(['ACTIVE', 'PAUSED', 'REVOKED', 'EXPIRED']),
});
const scope = { environment: EnvironmentSchema, organizationId: IdSchema };
export const FinancialAuthorityFenceSchema = z.strictObject({
  schemaVersion: z.literal(1), ...scope,
  responsibility: z.strictObject({ id: IdSchema, version: FinancialFenceVersionSchema, hash: HashSchema, siteId: IdSchema }),
  generation: FinancialFenceGenerationSchema,
  // FA-0 cannot represent or promote an effective financial policy.
  family: z.enum(['none', 'legacy']), legacyHead: FinancialLegacyHeadReferenceSchema.nullable(),
}).refine(value => (value.family === 'none') === (value.legacyHead === null), 'The selected family must have exactly its own head.');
export const FinancialAuthorityHistorySchema = z.strictObject({
  previous: FinancialAuthorityFenceSchema.nullable(), current: FinancialAuthorityFenceSchema,
  basis: z.enum(['initial', 'migration_backfill', 'responsibility_change', 'legacy_head']), operationId: IdSchema.nullable(),
}).superRefine((value, context) => {
  const { previous, current, basis, operationId } = value;
  if (previous === null ? current.generation !== 0 || !['initial', 'migration_backfill'].includes(basis) :
    previous.environment !== current.environment || previous.organizationId !== current.organizationId ||
    previous.responsibility.id !== current.responsibility.id || previous.generation + 1 !== current.generation ||
    !['responsibility_change', 'legacy_head'].includes(basis)) context.addIssue({ code: 'custom', message: 'Exact contiguous scoped predecessor required.' });
  if (basis === 'legacy_head' ? operationId === null || current.family !== 'legacy' :
    basis === 'migration_backfill' ? (current.family === 'legacy') !== (operationId !== null) : operationId !== null)
    context.addIssue({ code: 'custom', message: 'Only an exact legacy transition or legacy backfill names its original operation.' });
  if (basis === 'initial' && current.family !== 'none') context.addIssue({ code: 'custom', message: 'A new responsibility starts without authority.' });
});
export const FinancialSiteFenceSchema = z.strictObject({ schemaVersion: z.literal(1), ...scope, siteId: IdSchema,
  generation: FinancialFenceGenerationSchema, active: z.boolean(), recordHash: HashSchema });
export const FinancialRegistryFenceSchema = z.strictObject({ schemaVersion: z.literal(1), kind: z.enum(['asset', 'account', 'source', 'binding']),
  key: z.string().min(1).max(128), accountKey: HashSchema.nullable(), generation: FinancialFenceGenerationSchema, controlHash: HashSchema,
}).refine(value => (value.kind === 'binding') === (value.accountKey !== null) &&
  (value.kind === 'asset' || value.kind === 'account' ? /^[a-f0-9]{64}$/.test(value.key) : /^[A-Za-z0-9_-]{1,128}$/.test(value.key)), 'Exact enduring registry identity required.');

// Inert references only. Successful parsing is neither qualification nor authority.
const qualification = { id: IdSchema, version: FinancialFenceVersionSchema, recordHash: HashSchema,
  control: z.strictObject({ key: HashSchema, epoch: FinancialFenceGenerationSchema }) };
export const B2bQualificationRefSchema = z.strictObject({ kind: z.enum(['asset', 'custody', 'source', 'opening', 'reconciliation']), ...qualification });
const ref = <T extends 'asset' | 'custody' | 'source' | 'opening' | 'reconciliation'>(kind: T) => z.strictObject({ kind: z.literal(kind), ...qualification });
export const RegistryPinSchema = z.strictObject({ key: HashSchema, version: FinancialFenceVersionSchema,
  recordHash: HashSchema, financialUseEpoch: FinancialFenceGenerationSchema });
export const SourcePinSchema = z.strictObject({ id: IdSchema, version: FinancialFenceVersionSchema, recordHash: HashSchema,
  financialUseEpoch: FinancialFenceGenerationSchema, binding: z.strictObject({ accountKey: HashSchema, recordHash: HashSchema,
    financialUseEpoch: FinancialFenceGenerationSchema }), qualification: ref('source') });
export const B2bFinancialTrustRefsV1Schema = z.strictObject({ schemaVersion: z.literal(1), ...scope,
  asset: RegistryPinSchema, account: RegistryPinSchema, assetQualification: ref('asset'), custodyQualification: ref('custody'),
  sources: z.array(SourcePinSchema).min(1).max(16),
}).refine(value => value.sources.every((source, index) => source.binding.accountKey === value.account.key &&
  (index === 0 || value.sources[index - 1]!.id < source.id)), 'Sources must be sorted, unique and bound to the enclosing account.');
export const B2bFinancialBasisRefsV1Schema = z.strictObject({ trust: B2bFinancialTrustRefsV1Schema,
  opening: ref('opening'), reconciliation: ref('reconciliation') });
export type FinancialAuthorityFence = z.infer<typeof FinancialAuthorityFenceSchema>;
export type FinancialAuthorityHistory = z.infer<typeof FinancialAuthorityHistorySchema>;
export type FinancialSiteFence = z.infer<typeof FinancialSiteFenceSchema>;
export type FinancialRegistryFence = z.infer<typeof FinancialRegistryFenceSchema>;
export type B2bQualificationRef = z.infer<typeof B2bQualificationRefSchema>;
export type RegistryPin = z.infer<typeof RegistryPinSchema>;
export type SourcePin = z.infer<typeof SourcePinSchema>;
export type B2bFinancialTrustRefsV1 = z.infer<typeof B2bFinancialTrustRefsV1Schema>;
export type B2bFinancialBasisRefsV1 = z.infer<typeof B2bFinancialBasisRefsV1Schema>;
