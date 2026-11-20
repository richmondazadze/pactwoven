import { z } from 'zod';
import { ActorContextSchema, EnvironmentSchema, IdSchema, IdempotencyKeySchema, InstantSchema } from './core';
import { NativeProviderIssuerSchema } from './native-authority';

// Technical ceilings for the first advisory grant version, not provider spend
// budgets. No schema in this module admits orders, messages, payments or signing.
export const NATIVE_DELEGATION_CEILINGS = Object.freeze({ lifetimeMs: 86_400_000,
  depth: 3, concurrency: 3, children: 32, attempts: 4, taskTimeoutMs: 300_000, observationMs: 20_000 });
const Revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const Epoch = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const ProviderId = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/);
const unique = (values: string[]) => new Set(values).size === values.length;

export const NativeAdvisoryCapabilitySchema = z.enum(['research_public_sources', 'read_scoped_memory', 'draft_advice']);
export const NativeDelegationLimitsSchema = z.strictObject({
  maxDepth: z.number().int().min(0).max(NATIVE_DELEGATION_CEILINGS.depth),
  maxConcurrentChildren: z.number().int().min(1).max(NATIVE_DELEGATION_CEILINGS.concurrency),
  maxChildren: z.number().int().min(0).max(NATIVE_DELEGATION_CEILINGS.children),
  maxAttempts: z.number().int().min(1).max(NATIVE_DELEGATION_CEILINGS.attempts),
  taskTimeoutMs: z.number().int().min(1_000).max(NATIVE_DELEGATION_CEILINGS.taskTimeoutMs),
});
export const NativeDelegationSiteSchema = z.strictObject({ siteId: IdSchema, siteVersion: Revision });
export const NativeDelegationIssuerSchema = z.strictObject({
  actorId: IdSchema, providerIssuer: NativeProviderIssuerSchema, subject: ProviderId,
  externalOrganizationId: ProviderId, externalMembershipId: ProviderId, membershipVersion: Revision,
});
export const NativeAdvisoryScopeSchema = z.strictObject({
  environment: EnvironmentSchema, organizationId: IdSchema, issuer: NativeDelegationIssuerSchema,
  organizationEpoch: Epoch, policyVersion: Revision, purpose: z.string().trim().min(1).max(1_000),
  sites: z.array(NativeDelegationSiteSchema).min(1).max(64).refine(values => unique(values.map(v => v.siteId))),
  capabilityVersion: z.literal(1),
  capabilities: z.array(NativeAdvisoryCapabilitySchema).min(1).max(3).refine(unique),
  limits: NativeDelegationLimitsSchema,
});
export const NativeDelegationRequestSchema = z.strictObject({
  grantId: IdSchema, requestKey: IdempotencyKeySchema, mode: z.literal('advise'),
  externalEffects: z.literal('forbidden'), scope: NativeAdvisoryScopeSchema,
  expiresAt: InstantSchema, continuesAfterSignOut: z.literal(true),
});
// A server-owned record of a signed-in human's exact review, not a reusable
// credential or a client-supplied replacement for authentication/step-up.
export const NativeDelegationConsentSchema = z.strictObject({
  actorId: IdSchema, sessionId: ProviderId, scopeDigest: Digest, confirmedAt: InstantSchema,
  continuesAfterSignOut: z.literal(true),
});
export const NativeDelegationIssuanceContextSchema = z.strictObject({
  actor: ActorContextSchema, sessionVerifiedAt: InstantSchema, sessionExpiresAt: InstantSchema,
  consent: NativeDelegationConsentSchema,
});
export const NativeAdvisoryGrantSchema = z.strictObject({
  schemaVersion: z.literal(1), id: IdSchema, version: Revision, revocationEpoch: Epoch,
  mode: z.literal('advise'), externalEffects: z.literal('forbidden'), scope: NativeAdvisoryScopeSchema,
  issuedAt: InstantSchema, expiresAt: InstantSchema,
  issuance: z.strictObject({ requestKey: IdempotencyKeySchema, sessionId: ProviderId,
    authenticatedAt: InstantSchema, confirmedAt: InstantSchema, scopeDigest: Digest,
    continuesAfterSignOut: z.literal(true) }),
  revocation: z.strictObject({ requestKey: IdempotencyKeySchema, actorId: IdSchema, revokedAt: InstantSchema }).nullable(),
}).refine(value => {
  const issued = Date.parse(value.issuedAt), expires = Date.parse(value.expiresAt);
  return expires > issued && expires - issued <= NATIVE_DELEGATION_CEILINGS.lifetimeMs &&
    Date.parse(value.issuance.authenticatedAt) <= Date.parse(value.issuance.confirmedAt) &&
    Date.parse(value.issuance.confirmedAt) <= issued &&
    (!value.revocation || Date.parse(value.revocation.revokedAt) >= issued);
}, 'Grant issuance, confirmation, expiry and revocation must be ordered and bounded.');
export const NativeDelegationReferenceSchema = z.strictObject({
  kind: z.literal('delegated'), grantId: IdSchema, grantVersion: Revision, revocationEpoch: Epoch, grantDigest: Digest,
});
// No default or fallback: an interactive task cannot acquire unattended scope.
export const NativeTaskAuthoritySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('interactive_session'), sessionId: ProviderId, providerIssuer: NativeProviderIssuerSchema }),
  NativeDelegationReferenceSchema,
]);
// Trusted current provider/local-policy observation. Deliberately contains no
// issuing-session status: after explicit issuance, logout is not grant revoke.
export const NativeDelegationCurrentAuthoritySchema = z.strictObject({
  state: z.enum(['current', 'denied', 'unavailable']), scope: NativeAdvisoryScopeSchema,
  observedAt: InstantSchema, validUntil: InstantSchema,
}).refine(value => Date.parse(value.validUntil) > Date.parse(value.observedAt) &&
  Date.parse(value.validUntil) - Date.parse(value.observedAt) <= NATIVE_DELEGATION_CEILINGS.observationMs);
export const RevokeNativeDelegationSchema = z.strictObject({
  grantId: IdSchema, expectedVersion: Revision, expectedRevocationEpoch: Epoch, requestKey: IdempotencyKeySchema,
});

export const NativeServiceIdentitySchema = z.strictObject({
  serviceId: IdSchema, serviceVersion: Revision, workloadIdentityId: IdSchema,
});
export const NativeDelegationArtifactReferenceSchema = z.strictObject({
  environment: EnvironmentSchema, organizationId: IdSchema, siteId: IdSchema,
  artifactId: IdSchema, revision: Revision, digest: Digest,
});
const artifacts = z.array(NativeDelegationArtifactReferenceSchema).max(32)
  .refine(values => unique(values.map(v => v.artifactId)), 'An artifact may occur only once per envelope.');
export const NativeAdvisoryHandoffSchema = z.strictObject({
  schemaVersion: z.literal(1), handoffId: IdSchema, environment: EnvironmentSchema,
  organizationId: IdSchema, siteId: IdSchema, authority: NativeDelegationReferenceSchema,
  rootTaskId: IdSchema, parentTaskId: IdSchema, childTaskId: IdSchema,
  assignmentVersion: Revision, generation: Revision,
  sender: NativeServiceIdentitySchema, recipient: NativeServiceIdentitySchema,
  capability: NativeAdvisoryCapabilitySchema, capabilityVersion: z.literal(1),
  depth: z.number().int().min(1).max(NATIVE_DELEGATION_CEILINGS.depth),
  attemptLimit: z.number().int().min(1).max(NATIVE_DELEGATION_CEILINGS.attempts),
  taskTimeoutMs: z.number().int().min(1_000).max(NATIVE_DELEGATION_CEILINGS.taskTimeoutMs),
  issuedAt: InstantSchema, deadlineAt: InstantSchema, inputArtifacts: artifacts,
  outputContract: z.literal('advisory_artifacts_v1'), correlationId: IdSchema,
}).refine(value => {
  const duration = Date.parse(value.deadlineAt) - Date.parse(value.issuedAt);
  return value.childTaskId !== value.parentTaskId && value.childTaskId !== value.rootTaskId &&
    (value.depth === 1 ? value.rootTaskId === value.parentTaskId : value.rootTaskId !== value.parentTaskId) &&
    value.sender.serviceId !== value.recipient.serviceId && duration > 0 && duration <= value.taskTimeoutMs &&
    value.inputArtifacts.every(ref => ref.environment === value.environment && ref.organizationId === value.organizationId && ref.siteId === value.siteId);
}, 'Handoff lineage, time window and artifact scope must agree.');
export const NativeAdvisoryResultSchema = z.strictObject({
  schemaVersion: z.literal(1), resultId: IdSchema, handoffId: IdSchema, handoffDigest: Digest,
  environment: EnvironmentSchema, organizationId: IdSchema, siteId: IdSchema,
  childTaskId: IdSchema, assignmentVersion: Revision, generation: Revision,
  authority: NativeDelegationReferenceSchema, sender: NativeServiceIdentitySchema, recipient: NativeServiceIdentitySchema,
  attempt: z.number().int().min(1).max(NATIVE_DELEGATION_CEILINGS.attempts),
  outcome: z.enum(['advice_ready', 'failed']), artifacts,
  finishedAt: InstantSchema, evidenceValidUntil: InstantSchema.nullable(),
}).refine(value => value.artifacts.every(ref => ref.environment === value.environment &&
  ref.organizationId === value.organizationId && ref.siteId === value.siteId) &&
  (value.outcome === 'advice_ready' ? value.artifacts.length > 0 && value.evidenceValidUntil !== null &&
    Date.parse(value.evidenceValidUntil) > Date.parse(value.finishedAt) : value.artifacts.length === 0 && value.evidenceValidUntil === null),
'Only scoped advisory artifacts with a validity deadline constitute an advice result.');
// Loaded from durable assignment state, never copied from the incoming envelope.
export const NativeHandoffParentSchema = z.strictObject({
  environment: EnvironmentSchema, organizationId: IdSchema, siteId: IdSchema,
  rootTaskId: IdSchema, taskId: IdSchema, authority: NativeDelegationReferenceSchema,
  depth: z.number().int().min(0).max(NATIVE_DELEGATION_CEILINGS.depth),
  service: NativeServiceIdentitySchema, state: z.enum(['running', 'paused', 'cancelled', 'completed']),
  ancestorTaskIds: z.array(IdSchema).min(1).max(NATIVE_DELEGATION_CEILINGS.depth + 1).refine(unique),
}).refine(value => value.ancestorTaskIds.length === value.depth + 1 &&
  value.ancestorTaskIds[0] === value.rootTaskId && value.ancestorTaskIds.at(-1) === value.taskId,
'The retained ancestry must match the parent depth and root.');
// Counters cover the entire grant tree, excluding the proposed new child.
// Read and reserve them atomically with inbox/assignment admission in storage.
export const NativeDelegationUsageSchema = z.strictObject({
  grantId: IdSchema, grantVersion: Revision, revocationEpoch: Epoch,
  activeChildren: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  childrenCreated: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).refine(value => value.activeChildren <= value.childrenCreated);
export const NativeHandoffAssignmentSchema = z.strictObject({
  handoffId: IdSchema, childTaskId: IdSchema, assignmentVersion: Revision, generation: Revision,
  attempt: z.number().int().min(1).max(NATIVE_DELEGATION_CEILINGS.attempts),
  recipient: NativeServiceIdentitySchema, state: z.enum(['ready', 'running', 'paused', 'cancelled', 'settled']),
});
export const NativeAdvisoryArtifactValidationSchema = z.strictObject({
  referenceDigest: Digest, observedAt: InstantSchema, validUntil: InstantSchema,
}).refine(value => Date.parse(value.validUntil) > Date.parse(value.observedAt));

export type NativeAdvisoryCapability = z.infer<typeof NativeAdvisoryCapabilitySchema>;
export type NativeAdvisoryScope = z.infer<typeof NativeAdvisoryScopeSchema>;
export type NativeDelegationRequest = z.infer<typeof NativeDelegationRequestSchema>;
export type NativeAdvisoryGrant = z.infer<typeof NativeAdvisoryGrantSchema>;
export type NativeDelegationReference = z.infer<typeof NativeDelegationReferenceSchema>;
export type NativeTaskAuthority = z.infer<typeof NativeTaskAuthoritySchema>;
export type NativeDelegationCurrentAuthority = z.infer<typeof NativeDelegationCurrentAuthoritySchema>;
export type NativeDelegationIssuanceContext = z.infer<typeof NativeDelegationIssuanceContextSchema>;
export type RevokeNativeDelegation = z.infer<typeof RevokeNativeDelegationSchema>;
export type NativeServiceIdentity = z.infer<typeof NativeServiceIdentitySchema>;
export type NativeDelegationArtifactReference = z.infer<typeof NativeDelegationArtifactReferenceSchema>;
export type NativeAdvisoryHandoff = z.infer<typeof NativeAdvisoryHandoffSchema>;
export type NativeAdvisoryResult = z.infer<typeof NativeAdvisoryResultSchema>;
export type NativeHandoffParent = z.infer<typeof NativeHandoffParentSchema>;
export type NativeDelegationUsage = z.infer<typeof NativeDelegationUsageSchema>;
export type NativeHandoffAssignment = z.infer<typeof NativeHandoffAssignmentSchema>;
export type NativeAdvisoryArtifactValidation = z.infer<typeof NativeAdvisoryArtifactValidationSchema>;
