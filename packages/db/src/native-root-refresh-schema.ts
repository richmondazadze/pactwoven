import { z } from 'zod';
import { EnvironmentSchema, IdSchema, IdempotencyKeySchema, InstantSchema } from '../../contracts/src/core';
import { commandDigest } from '../../contracts/src/canonical';
import { DelegatedAssignmentSchema, DelegatedModelUsageSchema, DelegatedPlanOutputSchema } from '../../contracts/src/delegated-execution';
import { NativeAdvisoryResultSchema, NativeDelegationArtifactReferenceSchema } from '../../contracts/src/native-delegation';
import {
  NativeRootWorkSchema, NativeRootMaterialsSchema, NativeRootAssignmentSchema,
  NativeRootInputsCommandSchema, NativeRootInputReceiptSchema,
  NativeRootCheckpointCommandSchema, NativeRootCheckpointReceiptSchema,
  NativeRootYieldCommandSchema, NativeRootCompleteCommandSchema, NativeRootCompleteReceiptSchema,
} from './native-root-lifecycle-schema';

const Counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const Version = Counter.refine(value => value > 0);
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Attempt = z.number().int().min(1).max(4);
const unique = <T>(values: T[]) => new Set(values).size === values.length;
const RefreshUsage = DelegatedModelUsageSchema.refine(value =>
  Number.isSafeInteger(value.inputTokens + value.outputTokens) && value.totalTokens === value.inputTokens + value.outputTokens,
  'Saved usage must preserve its complete token total.');

/** The initial plan is shared data, never an import of executable coordinator code. */
export const NativeCoordinatorStateSchema = z.strictObject({
  schemaVersion: z.literal(1), inputDigest: Digest, plan: DelegatedPlanOutputSchema,
  slots: z.array(z.strictObject({ taskId: IdSchema, handoffId: IdSchema, requestKey: IdSchema, assignment: DelegatedAssignmentSchema })).max(6),
  usage: RefreshUsage, bounded: z.boolean(), attempt: Attempt,
}).refine(value => unique(value.slots.map(slot => slot.taskId)) && unique(value.slots.map(slot => slot.handoffId)) &&
  unique(value.slots.map(slot => slot.requestKey)) && unique(value.slots.map(slot => slot.assignment.stepId)), 'Plan identities must be unique.');

export const NativeRootRefreshBindingSchema = z.strictObject({ refreshEpoch: Counter, lineageDigest: Digest.nullable() })
  .refine(value => (value.refreshEpoch === 0) === (value.lineageDigest === null), 'Epoch and lineage must agree.');

export const NativeRootOriginalPlanBasisSchema = z.strictObject({
  checkpointVersion: Version, plannerState: z.string().min(1).max(65536).refine(value => {
    try { return NativeCoordinatorStateSchema.safeParse(JSON.parse(value)).success; } catch { return false; }
  }, 'The original plan is invalid.'), plannerDigest: Digest,
});

export const NativeRootRefreshSlotSchema = z.strictObject({
  logicalTaskId: IdSchema, originalTaskId: IdSchema, predecessorTaskId: IdSchema.nullable(),
  taskId: IdSchema, handoffId: IdSchema, requestKey: IdempotencyKeySchema, assignment: NativeRootAssignmentSchema,
  kind: z.enum(['retained', 'replacement']), admission: z.enum(['pending', 'admitted', 'abandoned']),
}).refine(value => value.kind !== 'retained' || value.admission === 'admitted', 'Retained work must already be admitted.');

export const NativeRootRefreshOperationReceiptSchema = z.strictObject({
  kind: z.enum(['refresh', 'dispatch']), requestKey: IdempotencyKeySchema, intentDigest: Digest,
  rootTaskId: IdSchema, previousGeneration: Version, generation: Version,
  previousEpoch: Counter, refreshEpoch: Counter, attempt: Attempt,
  checkpointVersion: Counter, lineageDigest: Digest, admittedTaskIds: z.array(IdSchema).max(3),
  pendingCount: Counter.refine(value => value <= 32), continuation: z.enum(['running', 'yielded', 'waiting_children']),
  domainCompletion: z.literal(false),
}).refine(value => unique(value.admittedTaskIds) && (value.kind === 'refresh'
  ? value.refreshEpoch === value.previousEpoch + 1 && value.generation === value.previousGeneration + 1 &&
    value.continuation === 'yielded' && value.admittedTaskIds.length === 0
  : value.refreshEpoch > 0 && value.refreshEpoch === value.previousEpoch && value.generation === value.previousGeneration &&
    value.continuation === 'running' && value.admittedTaskIds.length === 1), 'The operation transition is inconsistent.');

export const NativeRootRefreshOperationLookupSchema = z.strictObject({
  kind: z.enum(['refresh', 'dispatch']), requestKey: IdempotencyKeySchema, intentDigest: Digest,
});

export const NativeRootWorkV2Schema = z.strictObject({
  schemaVersion: z.literal(2), refreshEpoch: Counter, work: NativeRootWorkSchema,
  refresh: z.strictObject({
    lineageDigest: Digest, planBasis: NativeRootOriginalPlanBasisSchema,
    slots: z.array(NativeRootRefreshSlotSchema).min(1).max(6),
    usage: RefreshUsage, operations: z.array(NativeRootRefreshOperationReceiptSchema).max(64),
  }).nullable(),
}).refine(value => (value.refreshEpoch === 0) === (value.refresh === null), 'Epoch and refresh state must agree.')
  .refine(value => !value.refresh || unique(value.refresh.slots.map(slot => slot.logicalTaskId)) &&
    unique(value.refresh.slots.map(slot => slot.taskId)) && unique(value.refresh.slots.map(slot => slot.handoffId)) &&
    unique(value.refresh.slots.map(slot => slot.requestKey)) && unique(value.refresh.operations.map(operation => operation.requestKey)),
  'Refresh identities must be unique.');

export const NativeRootMaterialsV2Schema = z.strictObject({
  schemaVersion: z.literal(2), refreshEpoch: Counter, material: NativeRootMaterialsSchema,
  refresh: z.strictObject({ lineageDigest: Digest, logicalTaskId: IdSchema, originalTaskId: IdSchema,
    originalPublicationDigest: Digest.nullable(), requiresPublicObservation: z.boolean() }).nullable(),
}).refine(value => (value.refreshEpoch === 0) === (value.refresh === null), 'Epoch and material binding must agree.');

const commandV2 = <T extends z.ZodType>(command: T) => z.strictObject({ schemaVersion: z.literal(2), expectedRefreshEpoch: Counter, command });
const receiptV2 = <T extends z.ZodType>(receipt: T) => z.strictObject({ schemaVersion: z.literal(2), refreshEpoch: Counter, receipt });
export const NativeRootInputsV2CommandSchema = commandV2(NativeRootInputsCommandSchema);
export const NativeRootInputsV2ReceiptSchema = receiptV2(NativeRootInputReceiptSchema);
export const NativeRootCheckpointV2CommandSchema = commandV2(NativeRootCheckpointCommandSchema);
export const NativeRootCheckpointV2ReceiptSchema = receiptV2(NativeRootCheckpointReceiptSchema);
export const NativeRootYieldV2CommandSchema = commandV2(NativeRootYieldCommandSchema);
export const NativeRootYieldV2ReceiptSchema = receiptV2(NativeRootCheckpointReceiptSchema);
export const NativeRootCompleteV2CommandSchema = commandV2(NativeRootCompleteCommandSchema);
export const NativeRootCompleteV2ReceiptSchema = receiptV2(NativeRootCompleteReceiptSchema);

const PublicationReference = z.strictObject({ handoffId: IdSchema, publicationDigest: Digest });
const compareReference = (a: z.infer<typeof PublicationReference>, b: z.infer<typeof PublicationReference>) =>
  a.handoffId < b.handoffId ? -1 : a.handoffId > b.handoffId ? 1 : a.publicationDigest < b.publicationDigest ? -1 : a.publicationDigest > b.publicationDigest ? 1 : 0;
export const NativeRootRefreshCommandSchema = z.strictObject({
  schemaVersion: z.literal(2), requestKey: IdempotencyKeySchema, expectedRefreshEpoch: Counter,
  expectedCheckpointVersion: Counter, results: z.array(PublicationReference).min(1).max(32),
}).refine(value => unique(value.results.map(result => result.handoffId)) &&
  value.results.every((result, index) => index === 0 || compareReference(value.results[index - 1]!, result) < 0), 'Publication basis must be unique and sorted.');
export const NativeRootRefreshDispatchCommandSchema = z.strictObject({
  schemaVersion: z.literal(2), requestKey: IdempotencyKeySchema, expectedRefreshEpoch: Version,
  expectedCheckpointVersion: Counter, lineageDigest: Digest, logicalTaskId: IdSchema,
});

/** URL safety and original-input extraction belong to the trusted source reader.
 * This wire check rejects credential-bearing/non-HTTPS observations; SQL cannot
 * independently prove that a network fetch occurred from these metadata. */
const SourceUrl = z.string().min(1).max(2048).refine(value => {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.hash; } catch { return false; }
});
export const NativePublicSourceObservationSchema = z.strictObject({
  requestedUrl: SourceUrl, finalUrl: SourceUrl, sourceDigest: Digest, observedAt: InstantSchema, validUntil: InstantSchema,
  evidenceIds: z.array(IdSchema).max(32),
}).refine(value => Date.parse(value.observedAt) < Date.parse(value.validUntil) && unique(value.evidenceIds), 'Source validity and references must be consistent.');

// Keep the inner v1 publication unchanged. V2 persists its provenance alongside
// the same result/artifact digest in the single authoritative transaction.
const Publication = z.strictObject({
  result: NativeAdvisoryResultSchema,
  artifacts: z.array(z.strictObject({ reference: NativeDelegationArtifactReferenceSchema, body: z.record(z.string(), z.unknown()) })).max(32),
  inputArtifacts: z.array(NativeDelegationArtifactReferenceSchema).max(32),
  memoryUsage: z.array(z.strictObject({ usageId: z.uuid(), selectionDigest: Digest })).max(128),
});
export const NativeDelegationPublicationV2Schema = z.strictObject({
  schemaVersion: z.literal(2), expectedRefreshEpoch: Counter, publication: Publication,
  observations: z.array(NativePublicSourceObservationSchema).max(3),
}).refine(value => unique(value.observations.map(observation => observation.requestedUrl)) &&
  unique(value.observations.flatMap(observation => observation.evidenceIds)) &&
  (value.expectedRefreshEpoch !== 0 || value.observations.length === 0) &&
  (value.publication.result.outcome === 'advice_ready' || value.observations.length === 0), 'Publication observation binding is inconsistent.');
export const NativeDelegationPublicationV2ReceiptSchema = z.strictObject({
  schemaVersion: z.literal(2), refreshEpoch: Counter, publicationDigest: Digest, provenanceDigest: Digest.nullable(),
}).refine(value => value.refreshEpoch !== 0 || value.provenanceDigest === null, 'Legacy publication must have no refresh provenance.');

const KeyScope = z.strictObject({ environment: EnvironmentSchema, organizationId: IdSchema, rootTaskId: IdSchema, generation: Version });
export async function nativeRootRefreshRequestKey(
  kind: 'refresh' | 'dispatch', scope: z.infer<typeof KeyScope>,
  input: Omit<z.infer<typeof NativeRootRefreshCommandSchema>, 'requestKey'> | Omit<z.infer<typeof NativeRootRefreshDispatchCommandSchema>, 'requestKey'>,
): Promise<string> {
  const parsedScope = KeyScope.parse(scope);
  const parsed = kind === 'refresh' ? NativeRootRefreshCommandSchema.parse({ ...input, requestKey: 'c3_pending_request' })
    : NativeRootRefreshDispatchCommandSchema.parse({ ...input, requestKey: 'c3_pending_request' });
  const { requestKey: _key, ...command } = parsed;
  return 'c3_' + await commandDigest({ domain: kind === 'refresh' ? 'pactwoven.native.refresh.v2' : 'pactwoven.native.refresh-dispatch.v2', ...parsedScope, command });
}

export type NativeCoordinatorState = z.infer<typeof NativeCoordinatorStateSchema>;
export type NativeRootWorkV2 = z.infer<typeof NativeRootWorkV2Schema>;
export type NativeRootMaterialsV2 = z.infer<typeof NativeRootMaterialsV2Schema>;
export type NativeRootRefreshCommand = z.infer<typeof NativeRootRefreshCommandSchema>;
export type NativeRootRefreshDispatchCommand = z.infer<typeof NativeRootRefreshDispatchCommandSchema>;
export type NativeRootRefreshOperationReceipt = z.infer<typeof NativeRootRefreshOperationReceiptSchema>;
export type NativeRootRefreshOperationLookup = z.infer<typeof NativeRootRefreshOperationLookupSchema>;
export type NativePublicSourceObservation = z.infer<typeof NativePublicSourceObservationSchema>;
export type NativeDelegationPublicationV2 = z.infer<typeof NativeDelegationPublicationV2Schema>;
