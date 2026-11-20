import { z } from 'zod';
import { EnvironmentSchema, IdSchema, InstantSchema } from './core';
import { NativeTaskSchema, type NativeTaskClaim, type NativeTaskProgress } from './native-tasks';

export const NATIVE_DISPATCH_ENGINE_REVISION = 'native-advice-v1' as const;
export const NativeDispatchMessageSchema = z.strictObject({
  schemaVersion: z.literal(1), engineRevision: z.literal(NATIVE_DISPATCH_ENGINE_REVISION),
  environment: EnvironmentSchema, organizationId: IdSchema, taskId: IdSchema,
  generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export const NativeDispatchPublicationSchema = z.strictObject({
  message: NativeDispatchMessageSchema, publicationToken: z.uuid(),
  idempotencyKey: z.string().regex(/^native-[a-f0-9]{64}$/), notBefore: InstantSchema,
});
const CheckpointSchema = z.record(z.string(), z.unknown()).refine(value => {
  try { return new TextEncoder().encode(JSON.stringify(value)).byteLength <= 262_144; } catch { return false; }
});
export const NativeDispatchClaimSchema = z.strictObject({
  claim: z.strictObject({ task: NativeTaskSchema, environment: EnvironmentSchema, organizationId: IdSchema,
    actorId: IdSchema, leaseToken: z.uuid(), checkpoint: CheckpointSchema }),
  dispatch: NativeDispatchMessageSchema,
}).refine(value => value.claim.environment === value.dispatch.environment &&
  value.claim.organizationId === value.dispatch.organizationId && value.claim.task.id === value.dispatch.taskId);
export const NativeDispatchClaimResultSchema = z.union([
  z.strictObject({ kind: z.literal('claimed'), claim: NativeDispatchClaimSchema.shape.claim, dispatch: NativeDispatchMessageSchema })
    .refine(value => value.claim.environment === value.dispatch.environment && value.claim.organizationId === value.dispatch.organizationId && value.claim.task.id === value.dispatch.taskId),
  z.strictObject({ kind: z.enum(['stale', 'not_found', 'inactive', 'revoked', 'revision_mismatch', 'quarantined']) }),
  z.strictObject({ kind: z.enum(['busy', 'not_ready']), retryAfterMilliseconds: z.number().int().min(1).max(86_400_000) }),
]);
export const NativeDispatchRecoverySchema = z.strictObject({
  recoveredWorkerLeases: z.number().int().nonnegative(), recoveredDeliveries: z.number().int().nonnegative(),
  repairedPublications: z.number().int().nonnegative(), quarantined: z.number().int().nonnegative(), moreDue: z.boolean(),
});
export type NativeDispatchMessage = z.infer<typeof NativeDispatchMessageSchema>;
export type NativeDispatchPublication = z.infer<typeof NativeDispatchPublicationSchema>;
export type NativeDispatchClaim = { claim: NativeTaskClaim; dispatch: NativeDispatchMessage };
export type NativeDispatchClaimResult = z.infer<typeof NativeDispatchClaimResultSchema>;
export type NativeDispatchRecovery = z.infer<typeof NativeDispatchRecoverySchema>;
export interface NativeDispatchPublisherRepository {
  claimPublications(publisherId: string, limit: number, leaseMilliseconds: number): Promise<NativeDispatchPublication[]>;
  acknowledgePublication(publication: NativeDispatchPublication): Promise<boolean>;
  retryPublication(publication: NativeDispatchPublication, delayMilliseconds: number): Promise<boolean>;
  recoverDue(limit: number): Promise<NativeDispatchRecovery>;
}
export interface NativeDispatchWorkerRepository {
  claimTarget(message: NativeDispatchMessage, workerId: string, leaseMilliseconds: number): Promise<NativeDispatchClaimResult>;
  yieldClaim(work: NativeDispatchClaim, progress: NativeTaskProgress, delayMilliseconds?: number): Promise<boolean>;
}
