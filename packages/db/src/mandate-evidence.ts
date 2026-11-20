import { z } from 'zod';
import { HashSchema, IdempotencyKeySchema, MandateAuthorityIntentSchema, MandateDecisionIntentSchema } from '@pactwoven/contracts';
import type { VerifiedIdentity } from './repository.js';

// Private service input only. Public commands cannot submit evidence or choose its purpose.
export const MandateVerificationRequestSchema = z.strictObject({
  nonce: z.uuid(), key: IdempotencyKeySchema,
  intent: z.union([MandateDecisionIntentSchema, MandateAuthorityIntentSchema])
    .refine(intent => intent.action === 'AUTHORIZE' || intent.action === 'RESUME', 'Only authorization and resume require mandate MFA'),
});
export type MandateVerificationRequest = z.infer<typeof MandateVerificationRequestSchema>;

// Shape validation is not provider authentication. Only the private verifier creates this evidence.
export const MandateMfaEvidenceSchema = z.strictObject({
  id: z.uuid(), purpose: z.enum(['mandate_authorization', 'mandate_control']),
  intentHash: HashSchema, requestNonce: z.uuid(), requestHash: HashSchema,
  subject: z.string().min(1).max(128), externalOrganizationId: z.string().min(1).max(128),
  externalMembershipId: z.string().min(1).max(128), sessionId: z.string().min(1).max(256),
  issuer: z.string().url(), tokenHash: HashSchema, tokenIssuedAt: z.iso.datetime(),
  firstFactorAgeMinutes: z.number().int().nonnegative().max(1_000_000),
  secondFactorAgeMinutes: z.number().int().nonnegative().max(1_000_000),
  verifiedAt: z.iso.datetime(), observedAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
}).refine(evidence => {
  const verifiedAt = Date.parse(evidence.verifiedAt), observedAt = Date.parse(evidence.observedAt);
  const expiresAt = Date.parse(evidence.expiresAt), issuedAt = Date.parse(evidence.tokenIssuedAt);
  return issuedAt <= observedAt && verifiedAt === issuedAt - (Math.max(evidence.firstFactorAgeMinutes, evidence.secondFactorAgeMinutes) + 1) * 60_000 &&
    verifiedAt <= observedAt && observedAt < expiresAt && expiresAt <= verifiedAt + 300_000;
}, 'Fresh, conservatively aged signed factors are required');
export type MandateMfaEvidence = z.infer<typeof MandateMfaEvidenceSchema>;
export type VerifiedMandateStepUpIdentity = { identity: VerifiedIdentity; evidence: MandateMfaEvidence };
