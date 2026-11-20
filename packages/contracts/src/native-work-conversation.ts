import { z } from 'zod';
import { ActorContextSchema, EnvironmentSchema, IdSchema, IdempotencyKeySchema, InstantSchema } from './core';

export const NATIVE_WORK_INSTRUCTION_LIMIT = 16;
export const NATIVE_WORK_INSTRUCTION_TEXT_LIMIT = 4000;
const Version = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const Revision = z.number().int().min(0).max(NATIVE_WORK_INSTRUCTION_LIMIT);
const Text = z.string().min(1).max(NATIVE_WORK_INSTRUCTION_TEXT_LIMIT).regex(/\S/);
export const NativeWorkConversationScopeSchema = z.strictObject({ environment: EnvironmentSchema, organizationId: IdSchema, siteId: IdSchema });
export const NativeWorkInstructionEntrySchema = z.strictObject({
  sequence: Revision.refine(value => value > 0), text: Text, recordedAt: InstantSchema,
  state: z.enum(['recorded', 'applied']),
});
export const NativeWorkInstructionUnavailableReasonSchema = z.enum([
  'pause_required', 'finished', 'cancelled', 'authority_unavailable', 'instruction_limit', 'execution_limit',
]);
export const NativeWorkConversationSchema = z.strictObject({
  scope: NativeWorkConversationScopeSchema, rootTaskId: IdSchema, instructionVersion: Revision, controlVersion: Version,
  originalPrompt: z.string().min(1).max(12000).regex(/\S/),
  entries: z.array(NativeWorkInstructionEntrySchema).max(NATIVE_WORK_INSTRUCTION_LIMIT),
  canUpdate: z.boolean(), updateUnavailableReason: NativeWorkInstructionUnavailableReasonSchema.nullable(),
}).refine(value => value.entries.length === value.instructionVersion && value.entries.every((entry, index) => entry.sequence === index + 1), 'Instructions must be complete and ordered.')
  .refine(value => value.canUpdate === (value.updateUnavailableReason === null), 'Update availability must have an exact reason.')
  .refine(value => !value.canUpdate || value.instructionVersion < NATIVE_WORK_INSTRUCTION_LIMIT, 'The instruction history is full.');
export const NativeWorkInstructionUpdateSchema = z.strictObject({
  expectedInstructionVersion: Revision.refine(value => value < NATIVE_WORK_INSTRUCTION_LIMIT),
  expectedControlVersion: Version, text: Text,
});
export const NativeWorkInstructionReceiptSchema = z.strictObject({
  scope: NativeWorkConversationScopeSchema, rootTaskId: IdSchema, requestKey: IdempotencyKeySchema,
  instructionVersion: Revision.refine(value => value > 0), controlVersion: Version,
  entry: NativeWorkInstructionEntrySchema, committedAt: InstantSchema, state: z.literal('paused'),
}).refine(value => value.entry.sequence === value.instructionVersion && value.entry.state === 'recorded' && value.entry.recordedAt === value.committedAt,
  'The immutable receipt must bind its newly recorded instruction.');
export const NativeWorkInstructionRecoverySchema = z.strictObject({
  scope: NativeWorkConversationScopeSchema, rootTaskId: IdSchema, requestKey: IdempotencyKeySchema,
  operation: NativeWorkInstructionReceiptSchema.nullable(),
}).refine(value => !value.operation || value.operation.rootTaskId === value.rootTaskId && value.operation.requestKey === value.requestKey &&
  value.operation.scope.environment === value.scope.environment && value.operation.scope.organizationId === value.scope.organizationId &&
  value.operation.scope.siteId === value.scope.siteId, 'Recovery must return the original scoped instruction operation.');
export type NativeWorkConversation = z.infer<typeof NativeWorkConversationSchema>;
export type NativeWorkInstructionEntry = z.infer<typeof NativeWorkInstructionEntrySchema>;
export type NativeWorkInstructionUpdate = z.infer<typeof NativeWorkInstructionUpdateSchema>;
export type NativeWorkInstructionReceipt = z.infer<typeof NativeWorkInstructionReceiptSchema>;
export type NativeWorkInstructionRecovery = z.infer<typeof NativeWorkInstructionRecoverySchema>;
export interface NativeWorkConversationRepository {
  read(actor: z.infer<typeof ActorContextSchema>, rootTaskId: string, siteId: string): Promise<NativeWorkConversation>;
  update(actor: z.infer<typeof ActorContextSchema>, rootTaskId: string, siteId: string, requestKey: string, input: NativeWorkInstructionUpdate): Promise<NativeWorkInstructionReceipt>;
  recover(actor: z.infer<typeof ActorContextSchema>, rootTaskId: string, siteId: string, requestKey: string): Promise<NativeWorkInstructionRecovery>;
}
