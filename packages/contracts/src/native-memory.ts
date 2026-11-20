import { z } from 'zod';
import { EnvironmentSchema, IdSchema, InstantSchema } from './core';

export const NATIVE_MEMORY_MAX_GRAPH_RECORDS = 128;
export const NATIVE_MEMORY_MAX_GRAPH_DEPTH = 16;
export const NativeMemoryDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const NativeMemoryRevisionSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export const NativeMemoryScopeSchema = z.strictObject({ environment: EnvironmentSchema, organizationId: IdSchema, siteId: IdSchema });
export const NativeMemoryReaderSchema = z.strictObject({ kind: z.enum(['user', 'agent']), id: IdSchema });
export const NativeMemoryReadPurposeSchema = z.enum(['task_context', 'human_review', 'audit']);
export const NativeMemoryAccessSchema = z.strictObject({
  readers: z.array(NativeMemoryReaderSchema).min(1).max(100)
    .refine(rows => new Set(rows.map(row => `${row.kind}:${row.id}`)).size === rows.length, 'Readers must be unique.'),
  purposes: z.array(NativeMemoryReadPurposeSchema).min(1).max(3)
    .refine(rows => new Set(rows).size === rows.length, 'Purposes must be unique.'),
});
export const NativeMemoryProvenanceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('user'), actorId: IdSchema }),
  z.strictObject({ kind: z.literal('agent'), agentId: IdSchema, taskId: IdSchema, handoffId: IdSchema }),
]);
export const NativeMemoryReferenceSchema = NativeMemoryScopeSchema.extend({ memoryId: IdSchema, revision: NativeMemoryRevisionSchema, digest: NativeMemoryDigestSchema });
export const NativeMemorySourceReferenceSchema = NativeMemoryScopeSchema.extend({ sourceId: IdSchema, revision: NativeMemoryRevisionSchema, digest: NativeMemoryDigestSchema });
const unique = <T>(rows: T[], identify: (row: T) => string) => new Set(rows.map(identify)).size === rows.length;
const scopedId = (row: z.infer<typeof NativeMemoryScopeSchema>, id: string) => JSON.stringify([row.environment, row.organizationId, row.siteId, id]);
export const NativeMemoryInputsSchema = z.strictObject({
  sources: z.array(NativeMemorySourceReferenceSchema).max(32)
    .refine(rows => unique(rows, row => scopedId(row, row.sourceId)), 'Select only one revision per source.'),
  memories: z.array(NativeMemoryReferenceSchema).max(32)
    .refine(rows => unique(rows, row => scopedId(row, row.memoryId)), 'Select only one revision per memory.'),
}).refine(value => value.sources.length + value.memories.length > 0, 'Memory requires source provenance.');

export const NativeMemoryContentSchema = z.strictObject({
  title: z.string().min(1).max(180).refine(value => value.trim().length > 0),
  summary: z.string().min(1).max(8_000).refine(value => value.trim().length > 0),
  // Decimal/financial quantities remain strings. Memory never supplies authority
  // to an economic command, and this metadata is never executable instructions.
  attributes: z.record(IdSchema, z.union([z.string().max(2_000), z.boolean(), z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER), z.null()]))
    .refine(value => Object.keys(value).length <= 32, 'Memory attributes are bounded.'),
});
const identity = {
  schemaVersion: z.literal(1), ...NativeMemoryScopeSchema.shape, memoryId: IdSchema, revision: NativeMemoryRevisionSchema,
  previous: NativeMemoryReferenceSchema.nullable(),
  subject: z.strictObject({ kind: z.enum(['supplier', 'site', 'preference', 'document', 'verified_outcome']), id: IdSchema }),
  key: IdSchema, recordedAt: InstantSchema, provenance: NativeMemoryProvenanceSchema,
};
export const NativeMemoryActiveRecordSchema = z.strictObject({
  ...identity, state: z.literal('active'), content: NativeMemoryContentSchema, access: NativeMemoryAccessSchema,
  validFrom: InstantSchema, validUntil: InstantSchema, confidence: z.enum(['low', 'medium', 'high']),
  conflict: z.enum(['clear', 'unresolved']), inputs: NativeMemoryInputsSchema,
});
export const NativeMemoryTombstoneRecordSchema = z.strictObject({
  ...identity, state: z.literal('tombstone'), reason: z.enum(['deleted', 'revoked']),
});
export const NativeMemoryRecordSchema = z.discriminatedUnion('state', [NativeMemoryActiveRecordSchema, NativeMemoryTombstoneRecordSchema])
  .superRefine((value, ctx) => {
    const previous = value.previous;
    if ((value.revision === 1) !== (previous === null) || value.state === 'tombstone' && previous === null ||
        previous !== null && (previous.revision !== value.revision - 1 || scopedId(previous, previous.memoryId) !== scopedId(value, value.memoryId)))
      ctx.addIssue({ code: 'custom', message: 'A revision must name its exact scoped predecessor.' });
    if (value.state === 'active' && (Date.parse(value.validUntil) <= Date.parse(value.validFrom) || Date.parse(value.validUntil) <= Date.parse(value.recordedAt)))
      ctx.addIssue({ code: 'custom', message: 'Active memory needs a future exclusive validity deadline.' });
    if (value.state === 'active' && [...value.inputs.memories, ...value.inputs.sources].some(ref =>
      ref.environment !== value.environment || ref.organizationId !== value.organizationId || ref.siteId !== value.siteId))
      ctx.addIssue({ code: 'custom', message: 'Dependencies must retain the exact tenant and site.' });
  });
export const NativeMemorySnapshotSchema = z.strictObject({ record: NativeMemoryRecordSchema, reference: NativeMemoryReferenceSchema });

/** Fixed trusted-source-loader records; parsing or hashing is not verification
 * of a user's identity, a document, an external observation, or an outcome. */
export const NativeMemorySourceRecordSchema = z.strictObject({
  schemaVersion: z.literal(1), ...NativeMemoryScopeSchema.shape, sourceId: IdSchema, revision: NativeMemoryRevisionSchema,
  kind: z.enum(['user_statement', 'document', 'provider_observation', 'verified_outcome']),
  status: z.enum(['active', 'deleted', 'revoked']), contentDigest: NativeMemoryDigestSchema,
  provenance: NativeMemoryProvenanceSchema, observedAt: InstantSchema, validFrom: InstantSchema, validUntil: InstantSchema,
  access: NativeMemoryAccessSchema, conflict: z.enum(['clear', 'unresolved']), verification: z.enum(['unverified', 'verified']),
}).refine(value => Date.parse(value.validUntil) > Date.parse(value.validFrom) && Date.parse(value.validUntil) > Date.parse(value.observedAt),
  'Source validity must have an exclusive end after observation and start.');
export const NativeMemorySourceSnapshotSchema = z.strictObject({ record: NativeMemorySourceRecordSchema, reference: NativeMemorySourceReferenceSchema });

/** PRIVATE loader input. The caller supplies current heads, never a historical
 * cache presented as current. Persistence must serialize heads with publication. */
export const NativeMemoryInventorySchema = z.strictObject({
  memories: z.array(NativeMemorySnapshotSchema).max(NATIVE_MEMORY_MAX_GRAPH_RECORDS),
  sources: z.array(NativeMemorySourceSnapshotSchema).max(NATIVE_MEMORY_MAX_GRAPH_RECORDS),
});
export const NativeMemoryUsageSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('task'), taskId: IdSchema, generation: NativeMemoryRevisionSchema, handoffId: IdSchema.nullable() }),
  z.strictObject({ kind: z.literal('request'), requestId: IdSchema }),
]);
export const NativeMemoryReadContextSchema = NativeMemoryScopeSchema.extend({
  reader: NativeMemoryReaderSchema, purpose: NativeMemoryReadPurposeSchema, usage: NativeMemoryUsageSchema,
}).refine(value => (value.purpose !== 'task_context' || value.usage.kind === 'task') &&
  (value.reader.kind !== 'agent' || value.usage.kind === 'task' && value.usage.handoffId !== null),
  'Task use and agent reads need their exact task generation and handoff context.');
export const NativeMemorySelectionSchema = z.strictObject({
  schemaVersion: z.literal(1), context: NativeMemoryReadContextSchema, root: NativeMemoryReferenceSchema,
  memories: z.array(NativeMemoryReferenceSchema).min(1).max(NATIVE_MEMORY_MAX_GRAPH_RECORDS),
  sources: z.array(NativeMemorySourceReferenceSchema).min(1).max(NATIVE_MEMORY_MAX_GRAPH_RECORDS),
  selectedAt: InstantSchema, validUntil: InstantSchema,
}).refine(value => Date.parse(value.validUntil) > Date.parse(value.selectedAt), 'Selected evidence must still be current.');
// An integrity receipt, never a signed capability, authority grant or proof that
// the loader supplied authoritative state. Exact dependencies are rechecked.
export const NativeMemorySelectionReceiptSchema = z.strictObject({ selection: NativeMemorySelectionSchema, digest: NativeMemoryDigestSchema });
export const NativeMemoryMutationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('create'), expected: z.null(), record: NativeMemoryRecordSchema }),
  z.strictObject({ kind: z.literal('correct'), expected: NativeMemoryReferenceSchema, record: NativeMemoryRecordSchema }),
  z.strictObject({ kind: z.literal('delete'), expected: NativeMemoryReferenceSchema, record: NativeMemoryRecordSchema }),
]);

export type NativeMemoryScope = z.infer<typeof NativeMemoryScopeSchema>;
export type NativeMemoryReference = z.infer<typeof NativeMemoryReferenceSchema>;
export type NativeMemorySourceReference = z.infer<typeof NativeMemorySourceReferenceSchema>;
export type NativeMemoryReadContext = z.infer<typeof NativeMemoryReadContextSchema>;
export type NativeMemoryProvenance = z.infer<typeof NativeMemoryProvenanceSchema>;
export type NativeMemoryRecord = z.infer<typeof NativeMemoryRecordSchema>;
export type NativeMemoryActiveRecord = z.infer<typeof NativeMemoryActiveRecordSchema>;
export type NativeMemorySnapshot = z.infer<typeof NativeMemorySnapshotSchema>;
export type NativeMemorySourceRecord = z.infer<typeof NativeMemorySourceRecordSchema>;
export type NativeMemorySourceSnapshot = z.infer<typeof NativeMemorySourceSnapshotSchema>;
export type NativeMemoryInventory = z.infer<typeof NativeMemoryInventorySchema>;
export type NativeMemorySelection = z.infer<typeof NativeMemorySelectionSchema>;
export type NativeMemorySelectionReceipt = z.infer<typeof NativeMemorySelectionReceiptSchema>;
