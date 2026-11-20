import {
  NATIVE_COMMUNICATION_LIMITS, NativeChannelConsentRequestSchema, NativeChannelConsentApprovalSchema, NativeChannelConsentSchema,
  NativeChannelConsentHeadSchema, NativeCommunicationConnectionSchema, NativeCommunicationHumanAuthoritySchema,
  NativeCommunicationRootSchema, NativeIncomingMessageSchema, NativeIncomingVerificationSchema, NativeReplyWaitSchema,
  NativeInboxReceiptSchema, NativeSameRootWakeIntentSchema,
  type NativeChannelConsentRequest, type NativeChannelConsentApproval, type NativeChannelConsent,
  type NativeChannelConsentHead, type NativeCommunicationConnection, type NativeCommunicationHumanAuthority,
  type NativeCommunicationRoot, type NativeIncomingMessage, type NativeReplyWait, type NativeInboxReceipt,
} from '../../contracts/src/native-communication';
import { IdSchema, InstantSchema } from '../../contracts/src/core';
import { canonicalJson, commandDigest } from './canonical.js';
import { immutable, nextVersion } from './financial-primitives.js';
import { DomainError } from './errors.js';

const time = (value: string) => Date.parse(InstantSchema.parse(value));
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const deny = (code: string, message: string): never => { throw new DomainError(code, 409, message); };
const oauthScope = (kind: NativeChannelConsentRequest['target']['kind']) => kind === 'gmail_reply'
  ? 'https://www.googleapis.com/auth/gmail.readonly' : 'https://www.googleapis.com/auth/calendar.events.readonly';
function current(request: NativeChannelConsentRequest, connection: NativeCommunicationConnection, authority: NativeCommunicationHumanAuthority, now: string) {
  const at = time(now);
  if (connection.status !== 'connected' || authority.state !== 'current' || time(connection.observedAt) > at || time(connection.validUntil) <= at ||
    time(authority.observedAt) > at || time(authority.validUntil) <= at || connection.id !== request.connectionId || connection.version !== request.connectionVersion ||
    connection.accountSubject !== request.accountSubject || connection.actorId !== request.actorId || connection.environment !== request.scope.environment ||
    connection.organizationId !== request.scope.organizationId || !connection.oauthScopes.includes(oauthScope(request.target.kind)) ||
    !same(authority.scope, request.scope) || authority.actorId !== request.actorId || authority.membershipVersion !== request.membershipVersion ||
    authority.organizationEpoch !== request.organizationEpoch) deny('CHANNEL_AUTHORITY_CHANGED', 'Current read consent and connection access are required.');
}
function rootBinding(request: NativeChannelConsentRequest, root: NativeCommunicationRoot) {
  if (!same(root.scope, request.scope) || root.rootTaskId !== request.rootTaskId || root.actorId !== request.actorId ||
    !same(root.authority, request.rootAuthority)) deny('CHANNEL_SCOPE_DENIED', 'The connection must belong to the original task and site.');
}
export async function nativeChannelConsentDigest(input: NativeChannelConsentRequest): Promise<string> {
  return commandDigest({ namespace: 'pactwoven/channel-read-consent/v1', request: NativeChannelConsentRequestSchema.parse(input) });
}
/** Authenticated identity and approval are server observations, never browser
 * flags. This returns a record to persist, not an OAuth grant or permission to send. */
export async function issueNativeChannelConsent(input: NativeChannelConsentRequest, context: {
  approval: NativeChannelConsentApproval; connection: NativeCommunicationConnection; authority: NativeCommunicationHumanAuthority;
  root: NativeCommunicationRoot; now: () => string;
}): Promise<NativeChannelConsent> {
  const request = immutable(NativeChannelConsentRequestSchema.parse(input));
  const approval = immutable(NativeChannelConsentApprovalSchema.parse(context.approval));
  const connection = immutable(NativeCommunicationConnectionSchema.parse(context.connection));
  const authority = immutable(NativeCommunicationHumanAuthoritySchema.parse(context.authority));
  const root = immutable(NativeCommunicationRootSchema.parse(context.root));
  const digest = await nativeChannelConsentDigest(request), now = context.now(), at = time(now), actor = approval.actor;
  current(request, connection, authority, now); rootBinding(request, root);
  if (actor.principalKind !== 'human' || actor.actorId !== request.actorId || actor.environment !== request.scope.environment ||
    actor.organizationId !== request.scope.organizationId || !actor.roles.some(role => role === 'owner' || role === 'operations') ||
    !actor.siteIds.includes(request.scope.siteId) || !actor.actionSiteIds.includes(request.scope.siteId) || approval.reviewDigest !== digest ||
    time(actor.authenticatedAt) > time(approval.confirmedAt) || time(approval.confirmedAt) > at || at - time(approval.confirmedAt) > NATIVE_COMMUNICATION_LIMITS.reviewMs ||
    time(approval.sessionVerifiedAt) > at || at - time(approval.sessionVerifiedAt) > NATIVE_COMMUNICATION_LIMITS.observationMs ||
    time(approval.sessionExpiresAt) <= at || time(approval.sessionVerifiedAt) < time(approval.confirmedAt)) {
    deny('CHANNEL_CONSENT_REQUIRED', 'A signed-in human must approve this exact read scope.');
  }
  if (!['ready', 'running', 'waiting_external'].includes(root.state) || time(request.expiresAt) <= at ||
    time(request.expiresAt) > time(root.expiresAt) || time(request.expiresAt) - at > NATIVE_COMMUNICATION_LIMITS.consentMs) {
    deny('CHANNEL_CONSENT_EXPIRED', 'The read scope must fit the existing task lifetime.');
  }
  return immutable(NativeChannelConsentSchema.parse({ schemaVersion: 1, request, digest, issuedAt: now,
    approval: { sessionId: actor.sessionId, authenticatedAt: actor.authenticatedAt, confirmedAt: approval.confirmedAt } }));
}
type LiveContext = { consent: NativeChannelConsent; consentHead: NativeChannelConsentHead; connection: NativeCommunicationConnection;
  authority: NativeCommunicationHumanAuthority; root: NativeCommunicationRoot; now: () => string };
function snapshots(context: LiveContext) {
  return { consent: immutable(NativeChannelConsentSchema.parse(context.consent)), head: immutable(NativeChannelConsentHeadSchema.parse(context.consentHead)),
    connection: immutable(NativeCommunicationConnectionSchema.parse(context.connection)), authority: immutable(NativeCommunicationHumanAuthoritySchema.parse(context.authority)),
    root: immutable(NativeCommunicationRootSchema.parse(context.root)) };
}
async function consentCurrent(values: ReturnType<typeof snapshots>, now: string) {
  const { consent, head, connection, authority, root } = values, request = consent.request;
  if (consent.digest !== await nativeChannelConsentDigest(request) || head.consentId !== request.id || head.digest !== consent.digest || head.state !== 'active') {
    deny('CHANNEL_CONSENT_REVOKED', 'The original read consent is unavailable or revoked.');
  }
  current(request, connection, authority, now); rootBinding(request, root);
  if (time(consent.issuedAt) > time(now) || time(request.expiresAt) <= time(now)) deny('CHANNEL_CONSENT_EXPIRED', 'The original read consent expired.');
}
/** Store this wait with the root's explicit waiting transition in one locked
 * transaction. It cannot create a root or reopen a paused task. */
export async function armNativeReplyWait(input: { id: string; expiresAt: string }, context: LiveContext): Promise<NativeReplyWait> {
  const id = IdSchema.parse(input.id), expiresAt = InstantSchema.parse(input.expiresAt), values = snapshots(context);
  await consentCurrent(values, context.now()); const now = context.now(); current(values.consent.request, values.connection, values.authority, now);
  if (values.root.state !== 'waiting_external' || time(expiresAt) <= time(now) || time(expiresAt) > time(values.root.expiresAt) ||
    time(expiresAt) > time(values.consent.request.expiresAt)) deny('REPLY_WAIT_DENIED', 'An existing permitted task must explicitly wait for this reply.');
  return immutable(NativeReplyWaitSchema.parse({ id, version: 1, scope: values.root.scope, rootTaskId: values.root.rootTaskId,
    rootAuthority: values.root.authority, rootGeneration: values.root.generation, rootControlVersion: values.root.controlVersion,
    consentId: values.consent.request.id, consentDigest: values.consent.digest, consentVersion: values.head.version,
    armedAt: now, expiresAt, state: 'armed' }));
}
export async function nativeIncomingIdentityDigest(input: NativeIncomingMessage): Promise<string> {
  const message = NativeIncomingMessageSchema.parse(input), source = message.source;
  return commandDigest({ namespace: 'pactwoven/incoming-identity/v1', environment: message.scope.environment,
    organizationId: message.scope.organizationId, connectionId: message.connectionId, accountSubject: message.accountSubject,
    identity: source.kind === 'gmail_reply' ? { kind: source.kind, messageId: source.messageId }
      : { kind: source.kind, calendarId: source.calendarId, eventId: source.eventId, etag: source.etag } });
}
export type NativeIncomingVerifier = (binding: Readonly<{ messageDigest: string; identityDigest: string;
  connectionId: string; connectionVersion: number; accountSubject: string }>) => Promise<unknown>;
function correlation(request: NativeChannelConsentRequest, message: NativeIncomingMessage, authenticatedSender: string | null) {
  const target = request.target, source = message.source;
  if (target.kind === 'gmail_reply' && source.kind === 'gmail_reply') {
    if (source.threadId !== target.threadId || source.parentMessageId !== target.parentMessageId || source.replyTokenHash !== target.replyTokenHash ||
      source.messageId === source.parentMessageId || authenticatedSender !== source.sender || !target.allowedSenders.includes(source.sender)) {
      deny('INCOMING_CORRELATION_DENIED', 'The reply does not match its approved conversation and sender.');
    }
  } else if (target.kind === 'calendar_change' && source.kind === 'calendar_change') {
    if (source.calendarId !== target.calendarId || source.eventId !== target.eventId || source.etag === source.previousEtag || authenticatedSender !== null) {
      deny('INCOMING_CORRELATION_DENIED', 'The change does not match its approved calendar item.');
    }
  } else deny('INCOMING_CORRELATION_DENIED', 'The incoming channel does not match its read consent.');
}
export type NativeInboxAdmission = Readonly<{
  disposition: 'admissible' | 'duplicate'; inbox: NativeInboxReceipt;
  waitTransition: Readonly<{ id: string; expectedVersion: number; version: number; state: 'satisfied' }> | null;
  outbox: NativeInboxReceipt['wake'];
}>;
/** The verifier must authenticate ingress AND independently fetch/bind provider
 * metadata, sender evidence and content digest. Signing caller-supplied JSON is
 * not verification. The adapter locks/reloads these snapshots and commits the
 * returned inbox, wait CAS and outbox together; this pure result is not durable. */
export async function admitNativeIncomingMessage(input: NativeIncomingMessage, context: LiveContext & {
  wait: NativeReplyWait; existing?: NativeInboxReceipt | null; verify: NativeIncomingVerifier;
}): Promise<NativeInboxAdmission> {
  const message = immutable(NativeIncomingMessageSchema.parse(input)), values = snapshots(context);
  const wait = immutable(NativeReplyWaitSchema.parse(context.wait));
  const existing = context.existing ? immutable(NativeInboxReceiptSchema.parse(context.existing)) : null;
  const identityDigest = await nativeIncomingIdentityDigest(message), messageDigest = await commandDigest({ namespace: 'pactwoven/incoming-message/v1', message });
  const binding = immutable({ messageDigest, identityDigest, connectionId: message.connectionId, connectionVersion: message.connectionVersion, accountSubject: message.accountSubject });
  const parsedVerification = NativeIncomingVerificationSchema.safeParse(await context.verify(binding));
  if (!parsedVerification.success) return deny('INCOMING_UNAUTHENTICATED', 'The provider message could not be verified.');
  const verification = parsedVerification.data;
  const now = context.now(), at = time(now), request = values.consent.request;
  if (Object.entries(binding).some(([key, value]) => verification[key as keyof typeof binding] !== value) ||
    time(verification.observedAt) > at || time(verification.validUntil) <= at) {
    deny('INCOMING_UNAUTHENTICATED', 'The provider message could not be verified.');
  }
  await consentCurrent(values, now);
  // Parsing and hashing may yield: no stale observation may be admitted afterward.
  const admittedAt = context.now(); current(request, values.connection, values.authority, admittedAt);
  if (time(verification.validUntil) <= time(admittedAt) || time(request.expiresAt) <= time(admittedAt)) deny('INCOMING_STALE', 'The observation expired before admission.');
  if (!same(message.scope, request.scope) || message.connectionId !== request.connectionId || message.connectionVersion !== request.connectionVersion ||
    message.accountSubject !== request.accountSubject || !same(wait.scope, request.scope) || wait.rootTaskId !== request.rootTaskId ||
    !same(wait.rootAuthority, request.rootAuthority) || wait.consentId !== request.id || wait.consentDigest !== values.consent.digest ||
    wait.consentVersion !== values.head.version || time(wait.armedAt) < time(values.consent.issuedAt) ||
    time(wait.expiresAt) > time(request.expiresAt) || time(wait.expiresAt) > time(values.root.expiresAt)) {
    deny('INCOMING_SCOPE_DENIED', 'The message and wait must retain their exact task and connection scope.');
  }
  correlation(request, message, verification.authenticatedSender);
  if (time(message.occurredAt) > time(admittedAt)) deny('INCOMING_STALE', 'The message timestamp is in the future.');
  if (existing) {
    if (existing.identityDigest !== identityDigest || existing.messageDigest !== messageDigest || !same(existing.scope, message.scope) ||
      existing.connectionId !== message.connectionId || existing.accountSubject !== message.accountSubject || existing.waitId !== wait.id ||
      existing.rootTaskId !== wait.rootTaskId) deny('INCOMING_IDENTITY_CONFLICT', 'This provider identity already has a different retained message or task.');
    return immutable({ disposition: 'duplicate', inbox: existing, waitTransition: null, outbox: null });
  }
  let reason: NativeInboxReceipt['reason'] = 'correlated';
  if (time(message.occurredAt) < time(wait.armedAt)) reason = 'before_wait';
  else if (time(wait.expiresAt) <= time(admittedAt)) reason = 'wait_expired';
  else if (wait.state !== 'armed') reason = 'wait_closed';
  else if (values.root.state !== 'waiting_external') reason = 'root_stopped';
  else if (values.root.generation !== wait.rootGeneration || values.root.controlVersion !== wait.rootControlVersion || time(values.root.expiresAt) <= time(admittedAt)) reason = 'root_changed';
  else if (request.target.kind === 'calendar_change' && message.source.kind === 'calendar_change' && message.source.previousEtag !== request.target.expectedEtag) reason = 'calendar_changed';
  const wake = reason === 'correlated' ? NativeSameRootWakeIntentSchema.parse({ schemaVersion: 1,
    id: await commandDigest({ namespace: 'pactwoven/reply-wake/v1', identityDigest, waitId: wait.id, waitVersion: wait.version }),
    scope: wait.scope, rootTaskId: wait.rootTaskId, rootGeneration: wait.rootGeneration, rootControlVersion: wait.rootControlVersion,
    rootAuthority: wait.rootAuthority, waitId: wait.id, expectedWaitVersion: wait.version, inboxIdentity: identityDigest,
    reason: 'correlated_inbound', permission: 'recheck_only', outboundEffects: 'forbidden' }) : null;
  const finalAt = context.now(); current(request, values.connection, values.authority, finalAt);
  if (time(verification.validUntil) <= time(finalAt) || time(request.expiresAt) <= time(finalAt) ||
    (wake && (time(wait.expiresAt) <= time(finalAt) || time(values.root.expiresAt) <= time(finalAt)))) deny('INCOMING_STALE', 'The admission window expired.');
  const inbox = NativeInboxReceiptSchema.parse({ schemaVersion: 1, identityDigest, messageDigest, scope: message.scope,
    connectionId: message.connectionId, accountSubject: message.accountSubject, waitId: wait.id, waitVersion: wait.version,
    rootTaskId: wait.rootTaskId, admittedAt: finalAt, disposition: wake ? 'wake_planned' : 'ignored', reason, wake });
  return immutable({ disposition: 'admissible', inbox,
    waitTransition: wake ? { id: wait.id, expectedVersion: wait.version, version: nextVersion(wait.version), state: 'satisfied' as const } : null, outbox: wake });
}
