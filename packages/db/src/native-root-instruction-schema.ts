import { z } from 'zod';
import { commandDigest } from '../../contracts/src/canonical';
import { EnvironmentSchema, IdSchema, InstantSchema } from '../../contracts/src/core';
import { DelegatedModelUsageSchema } from '../../contracts/src/delegated-execution';
import {
  NativeRootWorkSchema, NativeRootMaterialsSchema, NativeRootHandoffCommandSchema,
  NativeRootInputsCommandSchema, NativeRootInputReceiptSchema, NativeRootCheckpointCommandSchema,
  NativeRootCheckpointReceiptSchema, NativeRootYieldCommandSchema, NativeRootCompleteCommandSchema, NativeRootCompleteReceiptSchema,
} from './native-root-lifecycle-schema';
import {
  NativeRootWorkV2Schema, NativeRootMaterialsV2Schema, NativeRootRefreshCommandSchema,
  NativeRootRefreshDispatchCommandSchema, NativeRootRefreshOperationReceiptSchema, NativeRootRefreshOperationLookupSchema,
  NativeDelegationPublicationV2Schema, NativeDelegationPublicationV2ReceiptSchema,
} from './native-root-refresh-schema';

const Revision = z.number().int().min(0).max(16);
const Counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Instructions = z.array(z.strictObject({ sequence: Revision.refine(value => value > 0),
  text: z.string().min(1).max(4000).regex(/\S/), recordedAt: InstantSchema })).max(16);
const Metadata = z.strictObject({ instructionRevision: Revision, instructionDigest: Digest, instructions: Instructions });
const ordered = (value: { instructionRevision: number; instructions: z.infer<typeof Instructions> }) => value.instructions.length === value.instructionRevision &&
  value.instructions.every((entry, index) => entry.sequence === index + 1);
const Usage = DelegatedModelUsageSchema.refine(value => Number.isSafeInteger(value.inputTokens + value.outputTokens) &&
  value.totalTokens === value.inputTokens + value.outputTokens);

// Epochs remain lifetime-monotonic. After steering there is no current refresh
// until the new revision's own accepted plan requires refreshed evidence.
export const NativeRootWorkV3Schema = Metadata.extend({ schemaVersion: z.literal(3), refreshEpoch: Counter,
  work: NativeRootWorkSchema, refresh: NativeRootWorkV2Schema.shape.refresh,
  rootDeadlineAt: InstantSchema, lifetimeChildCount: z.number().int().min(0).max(32), usageFloor: Usage,
}).refine(ordered).refine(value => value.lifetimeChildCount >= value.work.children.length &&
  (!value.refresh || value.refreshEpoch > 0) && (value.instructionRevision !== 0 || (value.refreshEpoch === 0) === (value.refresh === null)));
export const NativeRootMaterialsV3Schema = Metadata.extend({ schemaVersion: z.literal(3), refreshEpoch: Counter,
  material: NativeRootMaterialsSchema, refresh: NativeRootMaterialsV2Schema.shape.refresh,
}).refine(ordered).refine(value => !value.refresh || value.refreshEpoch > 0);

const command = <T extends z.ZodType>(inner: T) => z.strictObject({ schemaVersion: z.literal(3), expectedInstructionRevision: Revision,
  expectedRefreshEpoch: Counter, command: inner });
const receipt = <T extends z.ZodType>(inner: T) => z.strictObject({ schemaVersion: z.literal(3), instructionRevision: Revision,
  refreshEpoch: Counter, receipt: inner });
export const NativeRootInputsV3CommandSchema = command(NativeRootInputsCommandSchema);
export const NativeRootInputsV3ReceiptSchema = receipt(NativeRootInputReceiptSchema);
export const NativeRootCheckpointV3CommandSchema = command(NativeRootCheckpointCommandSchema);
export const NativeRootCheckpointV3ReceiptSchema = receipt(NativeRootCheckpointReceiptSchema);
export const NativeRootYieldV3CommandSchema = command(NativeRootYieldCommandSchema);
export const NativeRootYieldV3ReceiptSchema = receipt(NativeRootCheckpointReceiptSchema);
export const NativeRootCompleteV3CommandSchema = command(NativeRootCompleteCommandSchema);
export const NativeRootCompleteV3ReceiptSchema = receipt(NativeRootCompleteReceiptSchema);
export const NativeRootHandoffV3CommandSchema = command(NativeRootHandoffCommandSchema);
export const NativeRootHandoffV3ReceiptSchema = receipt(z.strictObject({ kind: z.enum(['accepted', 'duplicate']), execution: z.enum(['advisory_only', 'none']), digest: Digest }));
export const NativeRootRefreshV3CommandSchema = z.strictObject({ ...NativeRootRefreshCommandSchema.shape, schemaVersion: z.literal(3), expectedInstructionRevision: Revision })
  .refine(value => { const { expectedInstructionRevision: _revision, ...base } = value; return NativeRootRefreshCommandSchema.safeParse({ ...base, schemaVersion: 2 }).success; });
export const NativeRootRefreshDispatchV3CommandSchema = NativeRootRefreshDispatchCommandSchema.extend({ schemaVersion: z.literal(3), expectedInstructionRevision: Revision });
export const NativeRootRefreshV3ReceiptSchema = NativeRootRefreshOperationReceiptSchema.safeExtend({ schemaVersion: z.literal(3), instructionRevision: Revision });
export const NativeRootRefreshV3LookupSchema = NativeRootRefreshOperationLookupSchema.extend({ instructionRevision: Revision });
export const NativeDelegationPublicationV3Schema = z.strictObject({ ...NativeDelegationPublicationV2Schema.shape, schemaVersion: z.literal(3), expectedInstructionRevision: Revision })
  .refine(value => { const { expectedInstructionRevision: _revision, ...base } = value; return NativeDelegationPublicationV2Schema.safeParse({ ...base, schemaVersion: 2 }).success; });
export const NativeDelegationPublicationV3ReceiptSchema = z.strictObject({ ...NativeDelegationPublicationV2ReceiptSchema.shape, schemaVersion: z.literal(3), instructionRevision: Revision })
  .refine(value => { const { instructionRevision: _revision, ...base } = value; return NativeDelegationPublicationV2ReceiptSchema.safeParse({ ...base, schemaVersion: 2 }).success; });

export async function nativeInstructionDigest(instructionRevision: number, instructions: z.infer<typeof Instructions>): Promise<string> {
  const parsed = Metadata.omit({ instructionDigest: true }).refine(ordered).parse({ instructionRevision, instructions });
  return commandDigest(parsed);
}
export async function nativeRootInstructionInputDigest(work: Pick<z.infer<typeof NativeRootWorkSchema>, 'title' | 'prompt' | 'memoryReferences'>,
  instructionRevision: number, instructionDigest: string): Promise<string> {
  Revision.parse(instructionRevision); Digest.parse(instructionDigest);
  const basis = { title: work.title, prompt: work.prompt, memoryReferences: work.memoryReferences };
  return commandDigest(instructionRevision === 0 ? basis : { ...basis, instructionRevision, instructionDigest });
}
export async function nativeRootRefreshV3RequestKey(kind: 'refresh' | 'dispatch',
  scope: { environment: string; organizationId: string; rootTaskId: string; generation: number },
  input: Omit<z.infer<typeof NativeRootRefreshV3CommandSchema>, 'requestKey'> | Omit<z.infer<typeof NativeRootRefreshDispatchV3CommandSchema>, 'requestKey'>) {
  const parsedScope = z.strictObject({ environment: EnvironmentSchema, organizationId: IdSchema, rootTaskId: IdSchema,
    generation: Counter.refine(value => value > 0) }).parse(scope);
  const parsed = (kind === 'refresh' ? NativeRootRefreshV3CommandSchema : NativeRootRefreshDispatchV3CommandSchema).parse({ ...input, requestKey: 'c3_pending_request' });
  const { requestKey: _key, ...body } = parsed;
  return 'c3_' + await commandDigest({ domain: kind === 'refresh' ? 'pactwoven.native.refresh.v3' : 'pactwoven.native.refresh-dispatch.v3', ...parsedScope, command: body });
}
export type NativeRootWorkV3 = z.infer<typeof NativeRootWorkV3Schema>;
export type NativeRootMaterialsV3 = z.infer<typeof NativeRootMaterialsV3Schema>;
export type NativeRootRefreshV3Command = z.infer<typeof NativeRootRefreshV3CommandSchema>;
export type NativeRootRefreshDispatchV3Command = z.infer<typeof NativeRootRefreshDispatchV3CommandSchema>;
export type NativeRootRefreshV3Lookup = z.infer<typeof NativeRootRefreshV3LookupSchema>;
export type NativeDelegationPublicationV3 = z.infer<typeof NativeDelegationPublicationV3Schema>;
