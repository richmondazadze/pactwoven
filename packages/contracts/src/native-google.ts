import { z } from 'zod';
import { ActorContextSchema, EnvironmentSchema, IdSchema, InstantSchema } from './core';
import { NativeChannelConsentRequestSchema, NativeIncomingMessageSchema, NativeIncomingVerificationSchema } from './native-communication';

// PRIVATE SERVER CONTRACT. Intentionally absent from the public barrel. Envelopes,
// token payloads, PKCE material and session proofs must never enter task/browser JSON.
export const GOOGLE_CALENDAR_READ_SCOPE = 'https://www.googleapis.com/auth/calendar.events.readonly' as const;
export const GOOGLE_READ_SCOPES = ['openid', 'email', GOOGLE_CALENDAR_READ_SCOPE] as const;
const Version = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Opaque = z.string().min(1).max(512).regex(/^[^\s\u0000-\u001f\u007f]+$/);
const B64 = z.string().regex(/^[A-Za-z0-9_-]+$/);
export const NativeGoogleSessionSchema = z.strictObject({
  actor: ActorContextSchema, subject: IdSchema, proofId: IdSchema, verifiedAt: InstantSchema, expiresAt: InstantSchema,
});
export const NativeGoogleBindingSchema = z.strictObject({
  environment: EnvironmentSchema, organizationId: IdSchema, actorId: IdSchema, connectionId: IdSchema,
  connectionVersion: Version, credentialVersion: Version,
});
export const NativeGoogleEnvelopeSchema = z.strictObject({
  schemaVersion: z.literal(1), algorithm: z.literal('A256GCM'), keyId: IdSchema,
  nonce: B64.length(16), ciphertext: B64.min(2).max(48000), tag: B64.length(22),
});
export const NativeGoogleTokensSchema = z.strictObject({
  accessToken: z.string().min(1).max(8192), refreshToken: z.string().min(1).max(8192), expiresAt: InstantSchema,
});
export const NativeGoogleAttemptSchema = z.strictObject({
  id: IdSchema, stateHash: Digest, session: NativeGoogleSessionSchema, binding: NativeGoogleBindingSchema,
  clientId: Opaque, redirectUri: z.url().max(2048), expectedEmail: z.email().max(254),
  createdAt: InstantSchema, expiresAt: InstantSchema, verifier: NativeGoogleEnvelopeSchema,
});
export const NativeGoogleRecoverySchema = z.strictObject({ status: z.enum(['pending','reserved','failed','connected','refreshing','revoked','unavailable']), connectionId: IdSchema.nullable() });
export type NativeGoogleRecovery = z.infer<typeof NativeGoogleRecoverySchema>;
export const NativeGoogleConnectionSchema = z.strictObject({
  binding: NativeGoogleBindingSchema, accountSubject: Opaque, accountEmail: z.email().max(254),
  clientId: Opaque, scopes: z.array(z.enum(['openid', 'email', GOOGLE_CALENDAR_READ_SCOPE])).length(3).refine(value => value.join(' ') === GOOGLE_READ_SCOPES.join(' ')),
  status: z.enum(['connected', 'refreshing', 'revoked', 'unavailable']), tokens: NativeGoogleEnvelopeSchema,
});
// Resolved from current approved consent + root + authority in a protected SQL
// bridge. A browser/event notification cannot supply this record as authority.
export const NativeGoogleReadSchema = z.strictObject({
  providerReference: IdSchema, request: NativeChannelConsentRequestSchema,
  observedAt: InstantSchema, validUntil: InstantSchema,
});
export const NativeGoogleSnapshotSchema = z.strictObject({ read: NativeGoogleReadSchema, connection: NativeGoogleConnectionSchema });
export const NativeGoogleProvenanceSchema = z.strictObject({
  provenanceId: IdSchema, providerReference: IdSchema, eventDigest: Digest,
  message: NativeIncomingMessageSchema, verification: NativeIncomingVerificationSchema,
});
export const NativeGoogleEventSchema = z.object({
  kind: z.literal('calendar#event'), id: Opaque, etag: Opaque, status: z.enum(['confirmed','tentative','cancelled']), updated: InstantSchema,
  summary: z.string().max(4096).optional(), description: z.string().max(131072).optional(), location: z.string().max(8192).optional(),
  start: z.object({ date: z.string().max(16).optional(), dateTime: InstantSchema.optional(), timeZone: z.string().max(128).optional() }).optional(),
  end: z.object({ date: z.string().max(16).optional(), dateTime: InstantSchema.optional(), timeZone: z.string().max(128).optional() }).optional(),
});
export type NativeGoogleSession = z.infer<typeof NativeGoogleSessionSchema>;
export type NativeGoogleBinding = z.infer<typeof NativeGoogleBindingSchema>;
export type NativeGoogleEnvelope = z.infer<typeof NativeGoogleEnvelopeSchema>;
export type NativeGoogleTokens = z.infer<typeof NativeGoogleTokensSchema>;
export type NativeGoogleAttempt = z.infer<typeof NativeGoogleAttemptSchema>;
export type NativeGoogleConnection = z.infer<typeof NativeGoogleConnectionSchema>;
export type NativeGoogleRead = z.infer<typeof NativeGoogleReadSchema>;
export type NativeGoogleSnapshot = z.infer<typeof NativeGoogleSnapshotSchema>;
export type NativeGoogleProvenance = z.infer<typeof NativeGoogleProvenanceSchema>;
export type NativeGoogleEvent = z.infer<typeof NativeGoogleEventSchema>;
export interface NativeGoogleSignedSessionSource {
  /** Mount actual Clerk signed identity observation + internal current actor resolver.
   * proofId must identify the protected observation the SQL session bridge verifies.
   * A schema parse, caller actor JSON or test fixture is not authentication. */
  resolve(bearer: string, signal: AbortSignal): Promise<NativeGoogleSession>;
}
export interface NativeGoogleContentSource {
  /** Retain a private, scope-bound immutable event projection, idempotently by
   * approved reference + exact event digest so re-fetch returns the same artifact. SQL independently
   * verifies its exact artifact reference through the protected artifact bridge. */
  retain(read: NativeGoogleRead, event: NativeGoogleEvent, digest: string, signal: AbortSignal): Promise<NonNullable<NativeGoogleProvenance['message']['content']>>;
}
export interface NativeGoogleStore {
  createAttempt(attempt: NativeGoogleAttempt): Promise<void>;
  reserveAttempt(stateHash: string, session: NativeGoogleSession, operationId: string): Promise<NativeGoogleAttempt>;
  completeAttempt(attemptId: string, session: NativeGoogleSession, operationId: string, connection: NativeGoogleConnection): Promise<void>;
  recoverAttempt(stateHash: string, session: NativeGoogleSession): Promise<NativeGoogleRecovery>;
  failAttempt(attemptId: string, operationId: string): Promise<void>;
  revoke(connectionId: string, session: NativeGoogleSession, expectedVersion: number): Promise<void>;
  resolveRead(connectionId: string, providerReference: string): Promise<NativeGoogleSnapshot>;
  reserveRefresh(read: NativeGoogleRead, credentialVersion: number, operationId: string): Promise<NativeGoogleConnection>;
  completeRefresh(read: NativeGoogleRead, operationId: string, connection: NativeGoogleConnection): Promise<void>;
  failRefresh(connectionId: string, operationId: string): Promise<void>;
  retainObservation(read: NativeGoogleRead, provenance: NativeGoogleProvenance): Promise<NativeGoogleProvenance>;
}
export class NativeGoogleError extends Error {
  constructor(readonly code: 'GOOGLE_DENIED'|'GOOGLE_UNAVAILABLE'|'GOOGLE_CONFLICT'|'GOOGLE_NO_CHANGE'|'GOOGLE_INTEGRATION_REQUIRED'|'GOOGLE_OUTCOME_UNKNOWN') {
    super({ GOOGLE_DENIED: 'Current Google read access is required.', GOOGLE_UNAVAILABLE: 'The Google read could not be verified.',
      GOOGLE_CONFLICT: 'The private connection changed. Recover its current state.', GOOGLE_NO_CHANGE: 'No new approved Calendar revision is available.',
      GOOGLE_INTEGRATION_REQUIRED: 'The protected Google connection adapters are not mounted.',
      GOOGLE_OUTCOME_UNKNOWN: 'The credential operation was not confirmed. Reconnect instead of replaying it.' }[code]);
    this.name = 'NativeGoogleError';
  }
}
