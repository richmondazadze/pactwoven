import { z } from 'zod';
import { AccessOperationQuerySchema } from './access';
import { EnvironmentSchema, IdSchema, InstantSchema, OperationSchema } from './core';

const epoch = z.number().int().nonnegative().max(2_147_483_647);
export const AccessRecoveryQuerySchema = AccessOperationQuerySchema;
export type AccessRecoveryQuery = z.infer<typeof AccessRecoveryQuerySchema>;

/** These pins constrain a new administrative review; they are never lost original input. */
export const CloseAccessRecoveryIntentSchema = z.strictObject({
  schemaVersion: z.literal(1), kind: AccessOperationQuerySchema.shape.kind,
  reason: z.literal('original_input_unavailable'),
  expectedEnvironment: EnvironmentSchema, expectedOrganizationId: IdSchema,
  expectedActorId: IdSchema, expectedExternalMembershipId: IdSchema, expectedAuthorityEpoch: epoch,
});
export type CloseAccessRecoveryIntent = z.infer<typeof CloseAccessRecoveryIntentSchema>;

const envelope = {
  schemaVersion: z.literal(1), environment: EnvironmentSchema,
  organizationId: IdSchema, externalOrganizationId: IdSchema,
  kind: AccessOperationQuerySchema.shape.kind, key: AccessOperationQuerySchema.shape.key,
  observedAt: InstantSchema,
  // The current verified reader supplies the next close review, not historical requester evidence.
  reviewer: z.strictObject({ actorId: IdSchema, externalMembershipId: IdSchema, authorityEpoch: epoch }),
};
const recorded = z.strictObject({ ...envelope, disposition: z.literal('recorded'), operation: OperationSchema });
const fenced = z.strictObject({
  ...envelope, disposition: z.literal('fenced'),
  // The immutable fence is its own audit record. Its ID is also the authorized audit reference.
  fence: z.strictObject({ id: IdSchema, closedAt: InstantSchema }),
});
const notRecorded = z.strictObject({ ...envelope, disposition: z.literal('not_recorded') });

function coherent(value: z.infer<typeof recorded> | z.infer<typeof fenced> | z.infer<typeof notRecorded>): boolean {
  if (value.disposition === 'recorded') {
    return value.operation.environment === value.environment && value.operation.financialState === null;
  }
  return value.disposition !== 'fenced' || Date.parse(value.fence.closedAt) <= Date.parse(value.observedAt);
}

/** Parsing validates shape only; consumers must also match verified scope and exact kind/key. */
export const AccessRecoveryResultSchema = z.discriminatedUnion('disposition', [recorded, fenced, notRecorded])
  .refine(coherent, 'Recovery must preserve operation environment, nonfinancial state and observation order');
export type AccessRecoveryResult = z.infer<typeof AccessRecoveryResultSchema>;

/** A successful close returns a committed fact, never mere absence. A recorded operation may still be pending. */
export const CloseAccessRecoveryResultSchema = z.discriminatedUnion('disposition', [recorded, fenced])
  .refine(coherent, 'Recovery must preserve operation environment, nonfinancial state and observation order');
export type CloseAccessRecoveryResult = z.infer<typeof CloseAccessRecoveryResultSchema>;

/** Original bearer stays in Authorization; public JSON carries no proof, nonce or reconstructed command. */
export interface AccessRecoveryGateway {
  get(token: string, query: AccessRecoveryQuery, correlationId: string): Promise<AccessRecoveryResult>;
  close(token: string, key: string, intent: CloseAccessRecoveryIntent, correlationId: string): Promise<CloseAccessRecoveryResult>;
}
