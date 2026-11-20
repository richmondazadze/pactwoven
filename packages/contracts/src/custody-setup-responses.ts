import { z } from 'zod';
import { IdSchema, IdempotencyKeySchema } from './core';
import { HashSchema } from './financial';
import { CustodyReadSchema, CustodyResultSchema, CustodySetupSpecificationSchema } from './custody-setup';

// Public wire shapes only. Services and clients must also check the exact
// request, scope, canonical hashes and linked records before accepting a result.
export const CustodyApiOperationKindSchema = z.enum(['prepare', 'challenge', 'confirmation', 'confirm', 'cancel']);
export const CustodyApiRecoveryQuerySchema = z.strictObject({ kind: CustodyApiOperationKindSchema, key: IdempotencyKeySchema });
export const CustodyApiMutationResponseSchema = z.strictObject({
  schemaVersion: z.literal(1), operation: CustodyResultSchema,
  review: CustodySetupSpecificationSchema.nullable(),
  message: z.strictObject({ bytes: z.string().max(16384), messageHash: HashSchema }).nullable(),
});
export const CustodyApiReadResponseSchema = z.strictObject({
  schemaVersion: z.literal(1), setup: CustodyReadSchema, review: CustodySetupSpecificationSchema,
});
export const CustodyApiRecoveryResponseSchema = z.strictObject({
  schemaVersion: z.literal(1), organizationId: IdSchema, actorId: IdSchema, responsibilityId: IdSchema,
  kind: CustodyApiOperationKindSchema, key: IdempotencyKeySchema,
  status: z.enum(['recorded', 'not_recorded']), operation: CustodyResultSchema.nullable(),
});
export type CustodyApiMutationResponse = z.infer<typeof CustodyApiMutationResponseSchema>;
export type CustodyApiReadResponse = z.infer<typeof CustodyApiReadResponseSchema>;
export type CustodyApiRecoveryResponse = z.infer<typeof CustodyApiRecoveryResponseSchema>;
