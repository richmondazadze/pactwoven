import { z } from 'zod';
import { ActorContextSchema, EnvironmentSchema, IdSchema, IdempotencyKeySchema, InstantSchema } from './core';
import { NativeDelegationReferenceSchema } from './native-delegation';

// Separate read consent. No schema here authorizes sending mail, calendar
// writes, money, or changes to the existing advisory delegation.
export const NATIVE_COMMUNICATION_LIMITS = Object.freeze({ consentMs: 86_400_000, observationMs: 20_000, reviewMs: 300_000 });
const Version = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const Epoch = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const ProviderKey = z.string().min(1).max(512).regex(/^[^\s\u0000-\u001f\u007f]+$/);
const Mailbox = z.email().max(254).refine(value => value === value.trim());
const unique = <T>(values: T[]) => new Set(values).size === values.length;
export const NativeCommunicationScopeSchema = z.strictObject({ environment: EnvironmentSchema, organizationId: IdSchema, siteId: IdSchema });
export const NativeCommunicationOAuthScopeSchema = z.enum([
  'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/calendar.events.readonly',
]);
export const NativeChannelTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('gmail_reply'), threadId: ProviderKey, parentMessageId: ProviderKey,
    allowedSenders: z.array(Mailbox).min(1).max(20).refine(unique), replyTokenHash: Digest }),
  z.strictObject({ kind: z.literal('calendar_change'), calendarId: ProviderKey, eventId: ProviderKey, expectedEtag: ProviderKey }),
]);
export const NativeCommunicationConnectionSchema = z.strictObject({
  id: IdSchema, version: Version, environment: EnvironmentSchema, organizationId: IdSchema, actorId: IdSchema,
  provider: z.literal('google'), accountSubject: ProviderKey, status: z.enum(['connected', 'revoked', 'unavailable']),
  oauthScopes: z.array(NativeCommunicationOAuthScopeSchema).min(1).max(2).refine(unique),
  observedAt: InstantSchema, validUntil: InstantSchema,
}).refine(value => Date.parse(value.validUntil) > Date.parse(value.observedAt) &&
  Date.parse(value.validUntil) - Date.parse(value.observedAt) <= NATIVE_COMMUNICATION_LIMITS.observationMs);
export const NativeCommunicationRootSchema = z.strictObject({
  scope: NativeCommunicationScopeSchema, rootTaskId: IdSchema, actorId: IdSchema, authority: NativeDelegationReferenceSchema,
  generation: Version, controlVersion: Version,
  // Future durable adapter mapping; current 0029 does not gain this state.
  state: z.enum(['ready', 'running', 'waiting_external', 'paused', 'cancelled', 'completed', 'blocked']),
  expiresAt: InstantSchema,
});
export const NativeCommunicationHumanAuthoritySchema = z.strictObject({
  scope: NativeCommunicationScopeSchema, actorId: IdSchema, membershipVersion: Version, organizationEpoch: Epoch,
  state: z.enum(['current', 'denied', 'unavailable']), observedAt: InstantSchema, validUntil: InstantSchema,
}).refine(value => Date.parse(value.validUntil) > Date.parse(value.observedAt) &&
  Date.parse(value.validUntil) - Date.parse(value.observedAt) <= NATIVE_COMMUNICATION_LIMITS.observationMs);
// A server-resolved review candidate, not an HTTP body or OAuth credential.
export const NativeChannelConsentRequestSchema = z.strictObject({
  id: IdSchema, requestKey: IdempotencyKeySchema, scope: NativeCommunicationScopeSchema, actorId: IdSchema,
  rootTaskId: IdSchema, rootAuthority: NativeDelegationReferenceSchema, connectionId: IdSchema, connectionVersion: Version,
  accountSubject: ProviderKey, membershipVersion: Version, organizationEpoch: Epoch, target: NativeChannelTargetSchema,
  purpose: z.string().trim().min(1).max(1000), expiresAt: InstantSchema,
  permission: z.literal('read_correlated_inbound'), outboundEffects: z.literal('forbidden'), continuesAfterSignOut: z.literal(true),
});
export const NativeChannelConsentApprovalSchema = z.strictObject({
  actor: ActorContextSchema, reviewDigest: Digest, confirmedAt: InstantSchema, sessionVerifiedAt: InstantSchema, sessionExpiresAt: InstantSchema,
});
export const NativeChannelConsentSchema = z.strictObject({
  schemaVersion: z.literal(1), request: NativeChannelConsentRequestSchema, digest: Digest, issuedAt: InstantSchema,
  approval: z.strictObject({ sessionId: z.string().min(1).max(256), authenticatedAt: InstantSchema, confirmedAt: InstantSchema }),
}).refine(value => Date.parse(value.request.expiresAt) > Date.parse(value.issuedAt) &&
  Date.parse(value.request.expiresAt) - Date.parse(value.issuedAt) <= NATIVE_COMMUNICATION_LIMITS.consentMs &&
  Date.parse(value.approval.authenticatedAt) <= Date.parse(value.approval.confirmedAt) && Date.parse(value.approval.confirmedAt) <= Date.parse(value.issuedAt));
export const NativeChannelConsentHeadSchema = z.strictObject({ consentId: IdSchema, digest: Digest, version: Version, state: z.enum(['active', 'revoked']) });
const Artifact = z.strictObject({ scope: NativeCommunicationScopeSchema, id: IdSchema, revision: Version, digest: Digest });
export const NativeIncomingSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('gmail_reply'), messageId: ProviderKey, threadId: ProviderKey, parentMessageId: ProviderKey,
    sender: Mailbox, replyTokenHash: Digest }),
  z.strictObject({ kind: z.literal('calendar_change'), calendarId: ProviderKey, eventId: ProviderKey,
    etag: ProviderKey, previousEtag: ProviderKey, change: z.enum(['updated', 'deleted']) }),
]);
// Only adapter-fetched immutable metadata and a private content reference.
// Notification delivery IDs/timestamps and self-asserted authentication flags
// are deliberately absent. Gmail IDs identify messages; calendar ETags identify revisions.
export const NativeIncomingMessageSchema = z.strictObject({
  schemaVersion: z.literal(1), scope: NativeCommunicationScopeSchema, connectionId: IdSchema, connectionVersion: Version,
  accountSubject: ProviderKey, source: NativeIncomingSourceSchema, occurredAt: InstantSchema, content: Artifact.nullable(),
}).refine(value => (value.content === null ? value.source.kind === 'calendar_change' && value.source.change === 'deleted'
  : value.content.scope.environment === value.scope.environment && value.content.scope.organizationId === value.scope.organizationId &&
    value.content.scope.siteId === value.scope.siteId && !(value.source.kind === 'calendar_change' && value.source.change === 'deleted')));
// Returned only by the trusted transport+provider-fetch verifier callback.
export const NativeIncomingVerificationSchema = z.strictObject({
  messageDigest: Digest, identityDigest: Digest, connectionId: IdSchema, connectionVersion: Version, accountSubject: ProviderKey,
  authenticatedSender: Mailbox.nullable(), observedAt: InstantSchema, validUntil: InstantSchema,
}).refine(value => Date.parse(value.validUntil) > Date.parse(value.observedAt) &&
  Date.parse(value.validUntil) - Date.parse(value.observedAt) <= NATIVE_COMMUNICATION_LIMITS.observationMs);
export const NativeReplyWaitSchema = z.strictObject({
  id: IdSchema, version: Version, scope: NativeCommunicationScopeSchema, rootTaskId: IdSchema, rootAuthority: NativeDelegationReferenceSchema,
  rootGeneration: Version, rootControlVersion: Version, consentId: IdSchema, consentDigest: Digest, consentVersion: Version,
  armedAt: InstantSchema, expiresAt: InstantSchema, state: z.enum(['armed', 'satisfied', 'cancelled', 'superseded']),
}).refine(value => Date.parse(value.expiresAt) > Date.parse(value.armedAt) && Date.parse(value.expiresAt) - Date.parse(value.armedAt) <= NATIVE_COMMUNICATION_LIMITS.consentMs);
export const NativeSameRootWakeIntentSchema = z.strictObject({
  schemaVersion: z.literal(1), id: Digest, scope: NativeCommunicationScopeSchema, rootTaskId: IdSchema,
  rootGeneration: Version, rootControlVersion: Version, rootAuthority: NativeDelegationReferenceSchema,
  waitId: IdSchema, expectedWaitVersion: Version, inboxIdentity: Digest,
  reason: z.literal('correlated_inbound'), permission: z.literal('recheck_only'), outboundEffects: z.literal('forbidden'),
});
export const NativeInboxReceiptSchema = z.strictObject({
  schemaVersion: z.literal(1), identityDigest: Digest, messageDigest: Digest, scope: NativeCommunicationScopeSchema,
  connectionId: IdSchema, accountSubject: ProviderKey, waitId: IdSchema, waitVersion: Version, rootTaskId: IdSchema,
  admittedAt: InstantSchema, disposition: z.enum(['wake_planned', 'ignored']),
  reason: z.enum(['correlated', 'before_wait', 'wait_expired', 'wait_closed', 'root_stopped', 'root_changed', 'calendar_changed']),
  wake: NativeSameRootWakeIntentSchema.nullable(),
}).refine(value => value.disposition === 'wake_planned' ? value.reason === 'correlated' && value.wake !== null &&
  value.wake.inboxIdentity === value.identityDigest && value.wake.waitId === value.waitId && value.wake.expectedWaitVersion === value.waitVersion &&
  value.wake.rootTaskId === value.rootTaskId && JSON.stringify(value.wake.scope) === JSON.stringify(value.scope)
  : value.reason !== 'correlated' && value.wake === null);
export type NativeChannelTarget = z.infer<typeof NativeChannelTargetSchema>;
export type NativeCommunicationConnection = z.infer<typeof NativeCommunicationConnectionSchema>;
export type NativeCommunicationRoot = z.infer<typeof NativeCommunicationRootSchema>;
export type NativeCommunicationHumanAuthority = z.infer<typeof NativeCommunicationHumanAuthoritySchema>;
export type NativeChannelConsentRequest = z.infer<typeof NativeChannelConsentRequestSchema>;
export type NativeChannelConsentApproval = z.infer<typeof NativeChannelConsentApprovalSchema>;
export type NativeChannelConsent = z.infer<typeof NativeChannelConsentSchema>;
export type NativeChannelConsentHead = z.infer<typeof NativeChannelConsentHeadSchema>;
export type NativeIncomingMessage = z.infer<typeof NativeIncomingMessageSchema>;
export type NativeIncomingVerification = z.infer<typeof NativeIncomingVerificationSchema>;
export type NativeReplyWait = z.infer<typeof NativeReplyWaitSchema>;
export type NativeInboxReceipt = z.infer<typeof NativeInboxReceiptSchema>;
export type NativeSameRootWakeIntent = z.infer<typeof NativeSameRootWakeIntentSchema>;
