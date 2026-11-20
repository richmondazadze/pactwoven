import { z } from 'zod';
import { AccessRecoveryQuerySchema, CloseAccessRecoveryIntentSchema, EnvironmentSchema, HashSchema, IdSchema,
  IdempotencyKeySchema, InstantSchema, type AccessRecoveryQuery, type AccessRecoveryResult,
  type CloseAccessRecoveryIntent, type CloseAccessRecoveryResult } from '@pactwoven/contracts';
import type { VerifiedIdentity } from './repository.js';

/** Private verified input only. Shape validation does not authenticate a bearer. */
export const AccessRecoveryIdentitySchema = z.strictObject({
  subject: IdSchema, externalOrganizationId: IdSchema, externalOrganizationName: z.string().min(1).max(180),
  externalMembershipId: IdSchema, externalRole: z.string().min(1).max(128), membershipObservedAt: InstantSchema,
  sessionId: z.string().min(1).max(256), authenticatedAt: InstantSchema,
}) satisfies z.ZodType<VerifiedIdentity>;

/** Resolved by the current-owner recovery read, never by copying expected pins. */
export const AccessRecoveryAuthorityScopeSchema = z.strictObject({
  environment: EnvironmentSchema, organizationId: IdSchema, actorId: IdSchema,
  externalOrganizationId: IdSchema, externalMembershipId: IdSchema,
});
export type AccessRecoveryAuthorityScope = z.infer<typeof AccessRecoveryAuthorityScopeSchema>;

/** Snapshot before provider awaits; the outer private dispatch supplies this nonce. */
export const AccessRecoveryVerificationRequestSchema = z.strictObject({
  nonce: z.uuid(), key: IdempotencyKeySchema, intent: CloseAccessRecoveryIntentSchema,
  scope: AccessRecoveryAuthorityScopeSchema,
});
export type AccessRecoveryVerificationRequest = z.infer<typeof AccessRecoveryVerificationRequestSchema>;

export const AccessRecoveryMfaEvidenceSchema = z.strictObject({
  id: z.uuid(), purpose: z.literal('member_access_recovery_close'),
  requestNonce: z.uuid(), kind: AccessRecoveryQuerySchema.shape.kind, key: IdempotencyKeySchema,
  intentHash: HashSchema, requestHash: HashSchema, scope: AccessRecoveryAuthorityScopeSchema,
  subject: IdSchema, externalOrganizationId: IdSchema, externalMembershipId: IdSchema,
  sessionId: z.string().min(1).max(256), issuer: z.string().url(), tokenHash: HashSchema,
  tokenIssuedAt: InstantSchema, firstFactorAgeMinutes: z.number().int().nonnegative().max(1_000_000),
  secondFactorAgeMinutes: z.number().int().nonnegative().max(1_000_000),
  verifiedAt: InstantSchema, observedAt: InstantSchema, expiresAt: InstantSchema,
}).refine(value => {
  const issued = Date.parse(value.tokenIssuedAt), observed = Date.parse(value.observedAt), verified = Date.parse(value.verifiedAt), expiry = Date.parse(value.expiresAt);
  return issued <= observed && verified === issued - (Math.max(value.firstFactorAgeMinutes, value.secondFactorAgeMinutes) + 1) * 60_000 &&
    verified <= observed && observed < expiry && expiry <= verified + 300_000;
}, 'Conservatively aged genuine signed factors are required');
export type AccessRecoveryMfaEvidence = z.infer<typeof AccessRecoveryMfaEvidenceSchema>;
export type VerifiedAccessRecoveryStepUpIdentity = { identity: VerifiedIdentity; evidence: AccessRecoveryMfaEvidence };

export interface AccessRecoveryRepository {
  get(identity: VerifiedIdentity, query: AccessRecoveryQuery, correlationId: string): Promise<AccessRecoveryResult>;
  close(verified: VerifiedAccessRecoveryStepUpIdentity, key: string, intent: CloseAccessRecoveryIntent, correlationId: string): Promise<CloseAccessRecoveryResult>;
}
