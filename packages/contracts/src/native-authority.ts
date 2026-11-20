import { z } from 'zod';
import { InstantSchema } from './core';
import { NativeDispatchMessageSchema, type NativeDispatchMessage } from './native-dispatch';

// Canonical server configuration, never a URL accepted from an HTTP caller.
export const NativeProviderIssuerSchema = z.string().max(261)
  .regex(/^https:\/\/(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/)
  .refine(value => new URL(value).hostname.split('.').every(label => label.length <= 63));
const ProviderIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/);
export const NativeAuthorityContextSchema = z.strictObject({
  sessionId: ProviderIdSchema, subject: ProviderIdSchema, externalOrganizationId: ProviderIdSchema,
  externalMembershipId: ProviderIdSchema, requiredRole: z.literal('org:admin').nullable(),
});
export const NativeAuthorityReasonSchema = z.enum(['current', 'session_missing', 'session_inactive', 'session_expired',
  'user_missing', 'user_banned', 'user_locked', 'user_deprovisioned', 'organization_missing', 'membership_removed',
  'membership_replaced', 'required_role_removed', 'invalid_context', 'invalid_deadline', 'cancelled', 'deadline_exceeded',
  'clock_invalid', 'provider_auth', 'rate_limited', 'provider_unavailable', 'network', 'malformed_response']);
const denialReasons = new Set(['session_missing', 'session_inactive', 'session_expired', 'user_missing', 'user_banned',
  'user_locked', 'user_deprovisioned', 'organization_missing', 'membership_removed', 'membership_replaced', 'required_role_removed']);
export const NativeAuthorityVerdictSchema = z.strictObject({
  state: z.enum(['allowed', 'denied', 'unavailable']), reason: NativeAuthorityReasonSchema,
  observationStartedAt: InstantSchema, observationCompletedAt: InstantSchema, providerExpiresAt: InstantSchema.nullable(),
}).refine(value => Date.parse(value.observationCompletedAt) >= Date.parse(value.observationStartedAt), 'Observation times must be ordered.')
  .refine(value => value.state === 'allowed' ? value.reason === 'current' && value.providerExpiresAt !== null &&
    Date.parse(value.providerExpiresAt) > Date.parse(value.observationCompletedAt) : value.state === 'denied'
    ? denialReasons.has(value.reason) : value.reason !== 'current' && !denialReasons.has(value.reason) && value.providerExpiresAt === null,
  'The observation state, reason and expiry must agree.');

export const NativeAuthorityResultSchema = z.strictObject({
  state: z.enum(['allowed', 'denied', 'unavailable', 'stale']), observedAt: InstantSchema.nullable(), validUntil: InstantSchema.nullable(),
  retryAfterMilliseconds: z.number().int().min(1).max(20_000).optional(),
}).refine(value => value.state === 'allowed' ? value.observedAt !== null && value.validUntil !== null &&
  Date.parse(value.validUntil) > Date.parse(value.observedAt) && Date.parse(value.validUntil) - Date.parse(value.observedAt) <= 20_000
  : value.validUntil === null, 'Only an allowed observation has a bounded validity interval.');
export const NativeAuthorityPrepareResultSchema = z.union([
  z.strictObject({ kind: z.literal('prepared'), nonce: z.uuid(), dispatch: NativeDispatchMessageSchema,
    providerIssuer: NativeProviderIssuerSchema, preparedAt: InstantSchema, deadlineAt: InstantSchema, context: NativeAuthorityContextSchema })
    .refine(value => Date.parse(value.deadlineAt) > Date.parse(value.preparedAt) &&
      Date.parse(value.deadlineAt) - Date.parse(value.preparedAt) <= 8_000),
  z.strictObject({ kind: z.literal('pending'), retryAfterMilliseconds: z.number().int().min(1).max(8_000) }),
  z.strictObject({ kind: z.literal('settled'), result: NativeAuthorityResultSchema }),
]);
// Only these envelopes cross the executor/API boundary. Prepared provider
// identity, nonce and raw observations stay inside the trusted API audience.
export const NativeAuthorityRequestSchema = z.strictObject({ schemaVersion: z.literal(1), dispatch: NativeDispatchMessageSchema });
export const NativeAuthorityResponseSchema = z.strictObject({ schemaVersion: z.literal(1), dispatch: NativeDispatchMessageSchema,
  result: NativeAuthorityResultSchema });
export type NativeAuthorityContext = z.infer<typeof NativeAuthorityContextSchema>;
export type NativeAuthorityVerdict = z.infer<typeof NativeAuthorityVerdictSchema>;
export type NativeAuthorityResult = z.infer<typeof NativeAuthorityResultSchema>;
export type NativeAuthorityPrepareResult = z.infer<typeof NativeAuthorityPrepareResultSchema>;
export type NativeAuthorityRequest = z.infer<typeof NativeAuthorityRequestSchema>;
export type NativeAuthorityResponse = z.infer<typeof NativeAuthorityResponseSchema>;
export interface NativeAuthorityRepository {
  prepare(dispatch: NativeDispatchMessage, expectedIssuer: string): Promise<NativeAuthorityPrepareResult>;
  finish(nonce: string, verdict: NativeAuthorityVerdict): Promise<NativeAuthorityResult>;
}
