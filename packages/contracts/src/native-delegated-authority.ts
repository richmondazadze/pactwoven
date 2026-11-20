import { z } from 'zod';
import { IdSchema, InstantSchema } from './core';
import { NativeAuthorityReasonSchema, NativeAuthorityResultSchema, NativeProviderIssuerSchema } from './native-authority';

export const NativeDelegatedAuthorityTargetSchema = z.strictObject({
  organizationId: IdSchema, taskId: IdSchema, generation: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
});
const ProviderId = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/);
export const NativeDelegatedAuthorityContextSchema = z.strictObject({
  subject: ProviderId, externalOrganizationId: ProviderId, externalMembershipId: ProviderId,
  requiredRole: z.literal('org:admin').nullable(),
});
const denialReasons = new Set(['user_missing', 'user_banned', 'user_locked', 'user_deprovisioned',
  'organization_missing', 'membership_removed', 'membership_replaced', 'required_role_removed']);
export const NativeDelegatedAuthorityVerdictSchema = z.strictObject({
  state: z.enum(['allowed', 'denied', 'unavailable']), reason: NativeAuthorityReasonSchema,
  observationStartedAt: InstantSchema, observationCompletedAt: InstantSchema,
}).refine(value => Date.parse(value.observationCompletedAt) >= Date.parse(value.observationStartedAt), 'Observation times must be ordered.')
  .refine(value => !value.reason.startsWith('session_') && (value.state === 'allowed' ? value.reason === 'current'
    : value.state === 'denied' ? denialReasons.has(value.reason) : value.reason !== 'current' && !denialReasons.has(value.reason)),
  'Delegated authority uses current identity and membership, independent of the issuing session.');
export const NativeDelegatedStoredAuthorityResultSchema = z.union([
  z.strictObject({ state: z.literal('stale') }),
  z.strictObject({ state: z.enum(['allowed', 'denied', 'unavailable']), observedAt: InstantSchema, validUntil: InstantSchema.nullable() })
    .refine(value => NativeAuthorityResultSchema.safeParse(value).success, 'Only an allowed result has a bounded validity interval.'),
]);
export const NativeDelegatedAuthorityPrepareSchema = z.union([
  z.strictObject({ kind: z.literal('pending'), retryAfterMilliseconds: z.literal(1000) }),
  z.strictObject({ kind: z.literal('settled'), result: NativeDelegatedStoredAuthorityResultSchema }),
  z.strictObject({ kind: z.literal('prepared'), target: NativeDelegatedAuthorityTargetSchema, nonce: z.uuid(),
    providerIssuer: NativeProviderIssuerSchema, preparedAt: InstantSchema, deadlineAt: InstantSchema,
    context: NativeDelegatedAuthorityContextSchema }).refine(value => {
    const duration = Date.parse(value.deadlineAt) - Date.parse(value.preparedAt);
    return duration > 0 && duration <= 8000;
  }, 'Preparation must have a bounded observation window.'),
]);
// These are the only envelopes crossing the executor/API boundary. Identity,
// nonce, provider observations and credentials remain inside the trusted API.
export const NativeDelegatedAuthorityRequestSchema = z.strictObject({
  schemaVersion: z.literal(1), target: NativeDelegatedAuthorityTargetSchema,
});
export const NativeDelegatedAuthorityResponseSchema = NativeDelegatedAuthorityRequestSchema.extend({ result: NativeAuthorityResultSchema });
export type NativeDelegatedAuthorityTarget = z.infer<typeof NativeDelegatedAuthorityTargetSchema>;
export type NativeDelegatedAuthorityVerdict = z.infer<typeof NativeDelegatedAuthorityVerdictSchema>;
export type NativeDelegatedAuthorityPrepare = z.infer<typeof NativeDelegatedAuthorityPrepareSchema>;
export type NativeDelegatedStoredAuthorityResult = z.infer<typeof NativeDelegatedStoredAuthorityResultSchema>;
export interface NativeDelegatedAuthorityRepository {
  prepare(target: NativeDelegatedAuthorityTarget, issuer: string): Promise<NativeDelegatedAuthorityPrepare>;
  finish(nonce: string, verdict: NativeDelegatedAuthorityVerdict): Promise<NativeDelegatedStoredAuthorityResult>;
}
