// Source-only until the lead integrates the new contracts barrel. Existing
// hosted/session authority does not import this module or gain a fallback.
import {
  NATIVE_DELEGATION_CEILINGS, NativeAdvisoryGrantSchema, NativeDelegationRequestSchema,
  NativeDelegationReferenceSchema, NativeDelegationCurrentAuthoritySchema, NativeDelegationIssuanceContextSchema,
  RevokeNativeDelegationSchema, NativeAdvisoryHandoffSchema, NativeAdvisoryResultSchema,
  NativeServiceIdentitySchema, NativeHandoffParentSchema, NativeHandoffAssignmentSchema,
  NativeAdvisoryArtifactValidationSchema,
  NativeDelegationUsageSchema,
  type NativeAdvisoryScope, type NativeAdvisoryGrant, type NativeDelegationRequest,
  type NativeDelegationReference, type NativeDelegationCurrentAuthority, type NativeDelegationIssuanceContext,
  type RevokeNativeDelegation, type NativeAdvisoryCapability, type NativeServiceIdentity,
  type NativeAdvisoryHandoff, type NativeAdvisoryResult, type NativeHandoffParent, type NativeHandoffAssignment,
  type NativeDelegationArtifactReference,
  type NativeAdvisoryArtifactValidation,
  type NativeDelegationUsage,
} from '../../contracts/src/native-delegation';
import { ActorContextSchema, InstantSchema, type ActorContext } from '@pactwoven/contracts';
import { canonicalJson, commandDigest } from './canonical.js';
import { immutable, nextVersion } from './financial-primitives.js';
import { DomainError } from './errors.js';

const time = (value: string) => Date.parse(InstantSchema.parse(value));
function deny(code: string, message: string): never { throw new DomainError(code, 409, message); }
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function scopeWithin(scope: NativeAdvisoryScope, current: NativeAdvisoryScope): boolean {
  return scope.environment === current.environment && scope.organizationId === current.organizationId &&
    same(scope.issuer, current.issuer) && scope.organizationEpoch === current.organizationEpoch &&
    scope.policyVersion === current.policyVersion && scope.capabilityVersion === current.capabilityVersion &&
    scope.sites.every(site => current.sites.some(now => same(site, now))) &&
    scope.capabilities.every(capability => current.capabilities.includes(capability)) &&
    Object.entries(scope.limits).every(([key, value]) => value <= current.limits[key as keyof typeof current.limits]);
}
function assertObservation(scope: NativeAdvisoryScope, current: NativeDelegationCurrentAuthority, now: string) {
  const at = time(now);
  if (current.state === 'unavailable') deny('DELEGATION_AUTHORITY_UNAVAILABLE', 'Current delegation authority is unavailable.');
  if (current.state !== 'current' || time(current.observedAt) > at || time(current.validUntil) <= at || !scopeWithin(scope, current.scope)) {
    deny('DELEGATION_AUTHORITY_CHANGED', 'The issuer, membership, site or policy authority changed or expired.');
  }
}
function scopeReview(request: NativeDelegationRequest) {
  return { grantId: request.grantId, requestKey: request.requestKey, mode: request.mode,
    externalEffects: request.externalEffects, scope: request.scope, expiresAt: request.expiresAt,
    continuesAfterSignOut: request.continuesAfterSignOut };
}
export async function nativeDelegationConsentDigest(input: NativeDelegationRequest): Promise<string> {
  return commandDigest(scopeReview(NativeDelegationRequestSchema.parse(input)));
}

/** Inputs are server-resolved identity/policy and a retained exact consent
 * receipt. The route must authenticate them; accepting this JSON from a client
 * is not authentication. Persist returned records under a unique request key. */
export async function issueNativeAdvisoryGrant(input: NativeDelegationRequest, context: {
  issuance: NativeDelegationIssuanceContext; currentAuthority: NativeDelegationCurrentAuthority;
  now: () => string; existing?: NativeAdvisoryGrant | null;
}): Promise<NativeAdvisoryGrant> {
  const request = immutable(NativeDelegationRequestSchema.parse(input));
  const issuance = immutable(NativeDelegationIssuanceContextSchema.parse(context.issuance));
  const current = immutable(NativeDelegationCurrentAuthoritySchema.parse(context.currentAuthority));
  const existing = context.existing ? immutable(NativeAdvisoryGrantSchema.parse(context.existing)) : null;
  const clock = context.now, digest = await commandDigest(scopeReview(request));
  const now = clock(), at = time(now), actor = issuance.actor, consent = issuance.consent;
  if (actor.principalKind !== 'human' || !actor.roles.some(role => role === 'owner' || role === 'operations') ||
      actor.environment !== request.scope.environment || actor.organizationId !== request.scope.organizationId ||
      actor.actorId !== request.scope.issuer.actorId || !request.scope.sites.every(site => actor.siteIds.includes(site.siteId)) ||
      actor.sessionId !== consent.sessionId || actor.actorId !== consent.actorId || consent.scopeDigest !== digest ||
      time(actor.authenticatedAt) > time(consent.confirmedAt) || time(consent.confirmedAt) > at ||
      at - time(consent.confirmedAt) > 300_000 || time(issuance.sessionVerifiedAt) > at ||
      at - time(issuance.sessionVerifiedAt) > NATIVE_DELEGATION_CEILINGS.observationMs || time(issuance.sessionExpiresAt) <= at) {
    deny('DELEGATION_CONSENT_REQUIRED', 'A currently signed-in eligible human must confirm this exact advisory scope.');
  }
  if (existing) {
    if (existing.id !== request.grantId || existing.issuance.requestKey !== request.requestKey ||
        existing.issuance.scopeDigest !== digest || !same(existing.scope, request.scope) || existing.expiresAt !== request.expiresAt) {
      deny('DELEGATION_IDEMPOTENCY_CONFLICT', 'This grant or request identity already has different scope.');
    }
    // A replay returns the retained record, including revocation. It never
    // issues a fresh lifetime/epoch or grants permission to run the task.
    return existing;
  }
  assertObservation(request.scope, current, now);
  return immutable(NativeAdvisoryGrantSchema.parse({ schemaVersion: 1, id: request.grantId,
    version: 1, revocationEpoch: 0, mode: 'advise', externalEffects: 'forbidden', scope: request.scope,
    issuedAt: now, expiresAt: request.expiresAt, issuance: { requestKey: request.requestKey,
      sessionId: actor.sessionId, authenticatedAt: actor.authenticatedAt, confirmedAt: consent.confirmedAt,
      scopeDigest: digest, continuesAfterSignOut: true }, revocation: null }));
}
export async function nativeDelegationReference(input: NativeAdvisoryGrant): Promise<NativeDelegationReference> {
  const grant = immutable(NativeAdvisoryGrantSchema.parse(input));
  const consentDigest = await nativeDelegationConsentDigest({ grantId: grant.id, requestKey: grant.issuance.requestKey,
    mode: grant.mode, externalEffects: grant.externalEffects, scope: grant.scope, expiresAt: grant.expiresAt,
    continuesAfterSignOut: grant.issuance.continuesAfterSignOut });
  if (consentDigest !== grant.issuance.scopeDigest) {
    deny('DELEGATION_AUTHORITY_CHANGED', 'The stored scope no longer matches the issuing human’s exact review.');
  }
  return immutable({ kind: 'delegated', grantId: grant.id, grantVersion: grant.version,
    revocationEpoch: grant.revocationEpoch, grantDigest: await commandDigest(grant) });
}
export async function assertNativeDelegationCurrent(context: {
  grant: NativeAdvisoryGrant; reference: NativeDelegationReference; currentAuthority: NativeDelegationCurrentAuthority;
  siteId: string; capability: NativeAdvisoryCapability; now: () => string;
}) {
  const grant = immutable(NativeAdvisoryGrantSchema.parse(context.grant));
  const reference = immutable(NativeDelegationReferenceSchema.parse(context.reference));
  const current = immutable(NativeDelegationCurrentAuthoritySchema.parse(context.currentAuthority));
  const { siteId, capability, now: clock } = context;
  const expected = await nativeDelegationReference(grant), now = clock();
  if (grant.revocation) deny('DELEGATION_REVOKED', 'This advisory delegation was revoked.');
  if (time(grant.issuedAt) > time(now) || time(grant.expiresAt) <= time(now)) deny('DELEGATION_EXPIRED', 'This advisory delegation is not current.');
  if (!same(reference, expected)) deny('DELEGATION_AUTHORITY_CHANGED', 'The exact grant version, epoch or scope changed.');
  if (!grant.scope.sites.some(site => site.siteId === siteId) || !grant.scope.capabilities.includes(capability)) {
    deny('DELEGATION_SCOPE_DENIED', 'The task is outside this advisory delegation.');
  }
  assertObservation(grant.scope, current, now);
  return immutable({ permission: 'advisory_only' as const, externalEffects: 'forbidden' as const,
    authority: reference, validUntil: new Date(Math.min(time(grant.expiresAt), time(current.validUntil))).toISOString() });
}
/** Caller must authenticate actor and lock/CAS the grant. Revocation remains
 * possible after grant expiry or policy/site change; it cannot widen scope. */
export function revokeNativeAdvisoryGrant(input: NativeAdvisoryGrant, command: RevokeNativeDelegation, actorInput: ActorContext, now: string): NativeAdvisoryGrant {
  const grant = NativeAdvisoryGrantSchema.parse(input), request = RevokeNativeDelegationSchema.parse(command), actor = ActorContextSchema.parse(actorInput);
  if (actor.principalKind !== 'human' || actor.actorId !== grant.scope.issuer.actorId ||
      actor.environment !== grant.scope.environment || actor.organizationId !== grant.scope.organizationId ||
      request.grantId !== grant.id || time(actor.authenticatedAt) > time(now)) {
    deny('DELEGATION_REVOKE_DENIED', 'The authenticated issuing human is required to revoke this delegation.');
  }
  if (grant.revocation) {
    if (grant.revocation.requestKey === request.requestKey && request.expectedVersion === grant.version - 1 &&
        request.expectedRevocationEpoch === grant.revocationEpoch - 1) return immutable(grant);
    deny('DELEGATION_IDEMPOTENCY_CONFLICT', 'This delegation already has a different revocation receipt.');
  }
  if (grant.version !== request.expectedVersion || grant.revocationEpoch !== request.expectedRevocationEpoch) {
    deny('DELEGATION_AUTHORITY_CHANGED', 'The delegation changed before revocation.');
  }
  return immutable(NativeAdvisoryGrantSchema.parse({ ...grant, version: nextVersion(grant.version),
    revocationEpoch: nextVersion(grant.revocationEpoch), revocation: { requestKey: request.requestKey, actorId: actor.actorId, revokedAt: now } }));
}

// Implemented by a trusted transport adapter using real verified credentials.
// There is deliberately no serializable `authenticated: true` envelope field.
export type NativeServiceAuthenticator = (binding: Readonly<{ kind: 'handoff' | 'result'; digest: string }>) => Promise<NativeServiceIdentity | null>;
type TransportContext = { authenticate: NativeServiceAuthenticator; receiver: NativeServiceIdentity; now: () => string };
async function authenticate(kind: 'handoff' | 'result', digest: string, sender: NativeServiceIdentity,
  verify: NativeServiceAuthenticator) {
  const principal = NativeServiceIdentitySchema.safeParse(await verify(Object.freeze({ kind, digest })));
  if (!principal.success || !same(principal.data, sender)) deny('NATIVE_SERVICE_UNAUTHENTICATED', 'The exact sending service identity is required.');
}
function assertAssignment(handoff: NativeAdvisoryHandoff, assignment: NativeHandoffAssignment, state: 'ready' | 'running') {
  if (assignment.handoffId !== handoff.handoffId || assignment.childTaskId !== handoff.childTaskId ||
      assignment.assignmentVersion !== handoff.assignmentVersion || assignment.generation !== handoff.generation ||
      !same(assignment.recipient, handoff.recipient) || assignment.state !== state || assignment.attempt > handoff.attemptLimit) {
    deny('NATIVE_ASSIGNMENT_CHANGED', 'The current task assignment or generation changed.');
  }
}
export async function admitNativeAdvisoryHandoff(input: NativeAdvisoryHandoff, context: TransportContext & {
  grant: NativeAdvisoryGrant; currentAuthority: NativeDelegationCurrentAuthority;
  parent: NativeHandoffParent; assignment: NativeHandoffAssignment; usage: NativeDelegationUsage; existing?: NativeAdvisoryHandoff | null;
}) {
  const handoff = immutable(NativeAdvisoryHandoffSchema.parse(input));
  const parent = immutable(NativeHandoffParentSchema.parse(context.parent));
  const assignment = immutable(NativeHandoffAssignmentSchema.parse(context.assignment));
  const usage = immutable(NativeDelegationUsageSchema.parse(context.usage));
  const grant = immutable(NativeAdvisoryGrantSchema.parse(context.grant));
  const current = immutable(NativeDelegationCurrentAuthoritySchema.parse(context.currentAuthority));
  const receiver = immutable(NativeServiceIdentitySchema.parse(context.receiver));
  const existing = context.existing ? immutable(NativeAdvisoryHandoffSchema.parse(context.existing)) : null;
  const { authenticate: verify, now: clock } = context, digest = await commandDigest(handoff);
  await authenticate('handoff', digest, handoff.sender, verify);
  if (!same(receiver, handoff.recipient) || !same(parent.service, handoff.sender) ||
      parent.environment !== handoff.environment || parent.organizationId !== handoff.organizationId || parent.siteId !== handoff.siteId ||
      parent.taskId !== handoff.parentTaskId || parent.rootTaskId !== handoff.rootTaskId || !same(parent.authority, handoff.authority)) {
    deny('NATIVE_HANDOFF_SCOPE_DENIED', 'The handoff must match its parent, tenant, site and receiving service.');
  }
  if (existing) {
    if (!same(existing, handoff)) deny('NATIVE_HANDOFF_IDEMPOTENCY_CONFLICT', 'The retained handoff identity has different contents.');
    return immutable({ disposition: 'duplicate' as const, execution: 'none' as const, digest });
  }
  assertAssignment(handoff, assignment, 'ready');
  const limits = grant.scope.limits;
  if (usage.grantId !== grant.id || usage.grantVersion !== grant.version || usage.revocationEpoch !== grant.revocationEpoch) {
    deny('NATIVE_ASSIGNMENT_CHANGED', 'Delegation usage must belong to the exact current grant.');
  }
  if (parent.state !== 'running' || handoff.depth !== parent.depth + 1 || handoff.depth > limits.maxDepth ||
      parent.ancestorTaskIds.includes(handoff.childTaskId) ||
      usage.activeChildren >= limits.maxConcurrentChildren || usage.childrenCreated >= limits.maxChildren ||
      handoff.attemptLimit > limits.maxAttempts || handoff.taskTimeoutMs > limits.taskTimeoutMs) {
    deny('NATIVE_DELEGATION_LIMIT', 'The parent is stopped or its bounded delegation allowance is exhausted.');
  }
  if (handoff.environment !== grant.scope.environment || handoff.organizationId !== grant.scope.organizationId ||
      time(handoff.issuedAt) < time(grant.issuedAt) || time(handoff.deadlineAt) > time(grant.expiresAt)) {
    deny('NATIVE_HANDOFF_SCOPE_DENIED', 'The handoff cannot extend grant scope or lifetime.');
  }
  const permission = await assertNativeDelegationCurrent({ grant, reference: handoff.authority, currentAuthority: current,
    siteId: handoff.siteId, capability: handoff.capability, now: clock });
  const admittedAt = time(clock());
  if (time(permission.validUntil) <= admittedAt) deny('DELEGATION_AUTHORITY_CHANGED', 'Delegation authority expired before handoff admission.');
  if (time(handoff.issuedAt) > admittedAt || time(handoff.deadlineAt) <= admittedAt) deny('NATIVE_HANDOFF_EXPIRED', 'The handoff deadline passed.');
  return immutable({ disposition: 'admissible' as const, permission: { ...permission,
    validUntil: new Date(Math.min(time(permission.validUntil), time(handoff.deadlineAt))).toISOString() }, digest, handoff });
}
export async function acceptNativeAdvisoryResult(input: NativeAdvisoryResult, context: TransportContext & {
  handoff: NativeAdvisoryHandoff; assignment: NativeHandoffAssignment; grant: NativeAdvisoryGrant;
  currentAuthority: NativeDelegationCurrentAuthority; existing?: NativeAdvisoryResult | null;
  validateArtifacts: (references: readonly NativeDelegationArtifactReference[]) => Promise<NativeAdvisoryArtifactValidation | null>;
}) {
  const result = immutable(NativeAdvisoryResultSchema.parse(input));
  const handoff = immutable(NativeAdvisoryHandoffSchema.parse(context.handoff));
  const assignment = immutable(NativeHandoffAssignmentSchema.parse(context.assignment));
  const grant = immutable(NativeAdvisoryGrantSchema.parse(context.grant));
  const current = immutable(NativeDelegationCurrentAuthoritySchema.parse(context.currentAuthority));
  const receiver = immutable(NativeServiceIdentitySchema.parse(context.receiver));
  const existing = context.existing ? immutable(NativeAdvisoryResultSchema.parse(context.existing)) : null;
  const { authenticate: verify, now: clock, validateArtifacts } = context;
  const digest = await commandDigest(result), handoffDigest = await commandDigest(handoff);
  await authenticate('result', digest, result.sender, verify);
  if (!same(receiver, result.recipient) || !same(handoff.sender, result.recipient) || !same(handoff.recipient, result.sender) ||
      result.handoffId !== handoff.handoffId || result.handoffDigest !== handoffDigest ||
      result.environment !== handoff.environment || result.organizationId !== handoff.organizationId || result.siteId !== handoff.siteId ||
      result.childTaskId !== handoff.childTaskId || result.assignmentVersion !== handoff.assignmentVersion ||
      result.generation !== handoff.generation || !same(result.authority, handoff.authority)) {
    deny('NATIVE_RESULT_SCOPE_DENIED', 'The result must match the exact authenticated handoff and intended receiver.');
  }
  if (existing) {
    if (!same(existing, result)) deny('NATIVE_RESULT_IDEMPOTENCY_CONFLICT', 'The retained result identity has different contents.');
    return immutable({ disposition: 'duplicate' as const, execution: 'none' as const, digest });
  }
  assertAssignment(handoff, assignment, 'running');
  if (result.attempt !== assignment.attempt) deny('NATIVE_ASSIGNMENT_CHANGED', 'A result from an earlier attempt cannot settle this assignment.');
  if (result.environment !== grant.scope.environment || result.organizationId !== grant.scope.organizationId ||
      time(result.finishedAt) < time(handoff.issuedAt) || time(result.finishedAt) > time(clock()) ||
      time(result.finishedAt) >= time(handoff.deadlineAt)) deny('NATIVE_RESULT_EXPIRED', 'The result is outside its assigned execution window.');
  // Reference validation must resolve exact revisions, ACLs and freshness in
  // trusted storage. A service transport receipt cannot replace this check.
  if (result.outcome === 'advice_ready') {
    const referenceDigest = await commandDigest(result.artifacts);
    const proof = NativeAdvisoryArtifactValidationSchema.safeParse(await validateArtifacts(result.artifacts));
    if (!proof.success || proof.data.referenceDigest !== referenceDigest || time(proof.data.observedAt) > time(clock()) ||
        time(proof.data.validUntil) <= time(clock()) || time(result.evidenceValidUntil!) > time(proof.data.validUntil)) {
      deny('NATIVE_RESULT_ARTIFACTS_INVALID', 'The referenced advisory artifacts are unavailable or changed.');
    }
  }
  const permission = await assertNativeDelegationCurrent({ grant, reference: handoff.authority, currentAuthority: current,
    siteId: handoff.siteId, capability: handoff.capability, now: clock });
  const acceptedAt = time(clock());
  if (time(permission.validUntil) <= acceptedAt) deny('DELEGATION_AUTHORITY_CHANGED', 'Delegation authority expired before result acceptance.');
  if (time(handoff.deadlineAt) <= acceptedAt || (result.evidenceValidUntil !== null && time(result.evidenceValidUntil) <= acceptedAt)) {
    deny('NATIVE_RESULT_EXPIRED', 'The result or its supporting evidence expired before acceptance.');
  }
  // Transactional CAS/inbox dedup and parent advancement are integration work.
  // This value cannot assert a supplier, financial or other external outcome.
  return immutable({ disposition: 'advisory_result_eligible' as const, domainCompletion: false as const,
    permission: { ...permission, validUntil: new Date(Math.min(time(permission.validUntil), time(handoff.deadlineAt),
      result.evidenceValidUntil === null ? Infinity : time(result.evidenceValidUntil))).toISOString() }, digest, result });
}
