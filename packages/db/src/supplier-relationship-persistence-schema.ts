import { z } from 'zod';
import {
  ActorContextSchema, EnvironmentSchema, HashSchema, IdSchema, InstantSchema, RoleSchema, VersionReferenceSchema,
  SupplierScopeSchema, SupplierScopePolicyPairSchema, SupplierScopePolicyReferenceSchema, SupplierScopeCategorySchema,
  SupplierScopePolicyMutationSchema, SupplierScopePolicySnapshotSchema, SupplierScopePolicyReceiptSchema,
  SupplierRelationshipMutationSchema, SupplierRelationshipSnapshotSchema, SupplierRelationshipHeadSchema,
  SupplierRelationshipReceiptSchema, SupplierRelationshipPolicyBindingSchema, SupplierRelationshipProjectionSchema, SupplierRelationshipApprovalSchema,
  supplierScopePolicyPairsMatch, supplierScopesMatch,
} from '@pactwoven/contracts';
import { canonicalJson, commandDigest, immutable, supplierScopePolicyCommandDigest,
  supplierScopePolicyDigest, supplierScopeCategoryDigest, supplierRelationshipProposalDigest } from '@pactwoven/domain';

// Internal DB-module boundaries only. None is exported from the package barrel.
// Parsing, digesting or possessing these objects never authenticates a principal,
// verifies an external provider, acquires a lock or creates RESOLVE/WRITE authority.
const version = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const epoch = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const oid = z.number().int().min(1).max(4_294_967_295);
const externalId = z.string().min(1).max(256);
const interval = { validFrom: InstantSchema, expiresAt: InstantSchema.nullable() };
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const ms = (value: string) => Date.parse(value);
const unique = (values: string[]) => new Set(values).size === values.length;
const inInterval = (value: { validFrom: string; expiresAt: string | null }, at: number) =>
  ms(value.validFrom) <= at && (value.expiresAt === null || at < ms(value.expiresAt));
async function checkPolicyRecord(value: z.infer<typeof SupplierScopePolicySnapshotSchema>) {
  if (value.policyHash !== await supplierScopePolicyDigest(value.policy)) throw new Error('Private policy content hash mismatch.');
  for (const { definitionHash, ...category } of value.policy.categories) {
    if (definitionHash !== await supplierScopeCategoryDigest(value.policy.pair, category)) throw new Error('Private pair-local category hash mismatch.');
  }
}
async function checkRelationshipRecord(value: z.infer<typeof SupplierRelationshipSnapshotSchema>) {
  if (value.proposalHash !== await supplierRelationshipProposalDigest(value.proposal)) throw new Error('Private proposal content hash mismatch.');
}
function relationshipHead(value: z.infer<typeof SupplierRelationshipSnapshotSchema>) {
  return { scope: value.proposal.scope, revision: value.revision,
    proposal: { id: value.proposal.scope.supplierRelationshipId, version: value.proposal.version, hash: value.proposalHash }, status: value.status };
}
function policyReference(value: z.infer<typeof SupplierScopePolicySnapshotSchema>) {
  return { pair: value.policy.pair, version: value.policy.version, hash: value.policyHash };
}
function originalPolicyResult(mutation: z.infer<typeof SupplierScopePolicyMutationSchema>, receipt: z.infer<typeof SupplierScopePolicyReceiptSchema>) {
  const command = mutation.command, policy = receipt.result.policy;
  return policy.version === command.expectedVersion + 1 && same(policy.predecessor, command.predecessor) &&
    policy.status === (command.payload.action === 'revoke' ? 'REVOKED' : 'ACTIVE') &&
    policy.issuer.organizationVersion === command.buyerOrganizationVersion && policy.issuer.organizationEpoch === command.authorityEpoch &&
    (command.payload.action === 'revoke' || (same(policy.buyerSiteIds, command.payload.terms.buyerSiteIds) &&
      same(policy.categories.map(({ definitionHash: _hash, ...category }) => category), command.payload.terms.categories) &&
      ms(policy.expiresAt) - ms(policy.issuedAt) <= command.payload.terms.requestedValidityMs));
}
function relationshipReceiptWithinHead(receipt: z.infer<typeof SupplierRelationshipReceiptSchema>, head: z.infer<typeof SupplierRelationshipHeadSchema>) {
  return supplierScopesMatch(receipt.identity.scope, head.scope) && receipt.result.revision <= head.revision &&
    receipt.result.proposal.version <= head.proposal.version &&
    (receipt.result.proposal.version !== head.proposal.version || same(receipt.result.proposal, head.proposal)) &&
    (receipt.result.revision !== head.revision || same(receipt.result, head));
}
function policyRecordWithinHead(record: z.infer<typeof SupplierScopePolicySnapshotSchema>, current: z.infer<typeof SupplierScopePolicySnapshotSchema>) {
  return record.policy.version <= current.policy.version && ms(record.policy.issuedAt) <= ms(current.policy.issuedAt) &&
    (record.policy.version !== current.policy.version || same(record, current)) &&
    (record.policy.version + 1 !== current.policy.version || same(policyReference(record), current.policy.predecessor));
}
function originalRelationshipResult(mutation: z.infer<typeof SupplierRelationshipMutationSchema>, receipt: z.infer<typeof SupplierRelationshipReceiptSchema>) {
  const command = mutation.command, action = command.payload.action, result = receipt.result;
  const status = action === 'create' || action === 'revise' ? result.status === 'PROPOSED' :
    action === 'approve' ? ['PROPOSED', 'ACTIVE'].includes(result.status) : result.status === (action === 'suspend' ? 'SUSPENDED' : 'REVOKED');
  const proposal = action === 'create' ? result.proposal.version === 1 : action === 'revise' ?
    result.proposal.version === (command.targetProposal?.version ?? 0) + 1 : same(result.proposal, command.targetProposal);
  return result.revision === command.expectedVersion + 1 && status && proposal;
}
function recoveryActionMatches(action: z.infer<typeof SupplierRelationshipRecoveryQuerySchema>['action'], receipt: z.infer<typeof SupplierRelationshipReceiptSchema>) {
  const result = receipt.result;
  return action === 'create' ? result.status === 'PROPOSED' && result.proposal.version === 1 && result.revision === 1 :
    action === 'revise' ? result.status === 'PROPOSED' && result.proposal.version > 1 :
    action === 'approve' ? result.status === 'PROPOSED' || result.status === 'ACTIVE' :
    result.status === (action === 'suspend' ? 'SUSPENDED' : 'REVOKED');
}

export const SupplierPrivatePrincipalBindingSchema = z.strictObject({
  reference: VersionReferenceSchema, environment: EnvironmentSchema, effectiveOrganizationId: IdSchema,
  verifier: z.strictObject({ oid, name: z.string().min(1).max(63).regex(/^[a-z_][a-z0-9_]*$/) }),
  authorizer: z.strictObject({ oid, name: z.string().min(1).max(63).regex(/^[a-z_][a-z0-9_]*$/) }),
  status: z.enum(['ACTIVE', 'REVOKED']), validFrom: InstantSchema, expiresAt: InstantSchema,
}).refine(value => value.verifier.oid !== value.authorizer.oid && value.verifier.name !== value.authorizer.name &&
  ms(value.validFrom) < ms(value.expiresAt), 'Distinct private principals and a finite binding interval are required.');

/** Original provider observation fields. This is shape/provenance preservation, not verification. */
export const SupplierExternalObservationSchema = z.strictObject({
  subject: externalId, externalOrganizationId: externalId, externalMembershipId: externalId, externalRole: externalId,
  sessionId: externalId, authenticatedAt: InstantSchema, membershipObservedAt: InstantSchema,
  issuer: z.url().max(2048), tokenHash: HashSchema, tokenIssuedAt: InstantSchema, sessionExpiresAt: InstantSchema,
  observedAt: InstantSchema, expiresAt: InstantSchema,
}).refine(value => ms(value.authenticatedAt) <= ms(value.tokenIssuedAt) && ms(value.tokenIssuedAt) <= ms(value.observedAt) &&
  ms(value.membershipObservedAt) <= ms(value.observedAt) && ms(value.observedAt) < ms(value.expiresAt) &&
  ms(value.expiresAt) <= ms(value.sessionExpiresAt) && ms(value.expiresAt) - ms(value.observedAt) <= 30_000,
  'Original observation/token/session times must retain one finite ordered interval.');

/** Live membership facts only. Old approvers need no invented session or token. */
export const SupplierMembershipObservationSchema = z.strictObject({
  issuer: z.url().max(2048), subject: externalId, externalOrganizationId: externalId, externalMembershipId: externalId,
  externalRole: externalId, status: z.enum(['ACTIVE', 'INACTIVE', 'REVOKED']), observedAt: InstantSchema, expiresAt: InstantSchema,
}).refine(value => ms(value.observedAt) < ms(value.expiresAt) && ms(value.expiresAt) - ms(value.observedAt) <= 30_000,
  'Membership observation must retain its original finite interval.');
export const SupplierApproverObservationsSchema = z.array(z.strictObject({
  head: SupplierRelationshipHeadSchema, approval: SupplierRelationshipApprovalSchema, observation: SupplierMembershipObservationSchema,
})).max(2).superRefine((values, context) => {
  if (!unique(values.map(value => value.approval.organizationId + '/' + value.approval.membershipId)) || new Set(values.map(value => value.approval.party)).size !== values.length ||
    values.some(value => !same(value.head, values[0]?.head) || !same(value.approval.proposal, value.head.proposal) ||
      value.approval.organizationId !== (value.approval.party === 'buyer' ? value.head.scope.buyerOrganizationId : value.head.scope.supplierOrganizationId))) {
    context.addIssue({ code: 'custom', message: 'Membership observations must name one exact head and distinct original party approval stamps.' });
  }
});

const policyPurposes = ['supplier_scope_policy_issue', 'supplier_scope_policy_replace', 'supplier_scope_policy_revoke'] as const;
const relationshipPurposes = ['supplier_relationship_create', 'supplier_relationship_revise', 'supplier_relationship_approve',
  'supplier_relationship_suspend', 'supplier_relationship_revoke'] as const;
export const SupplierRelationshipStatusQuerySchema = z.strictObject({ scope: SupplierScopeSchema, revision: version.nullable() });
export const SupplierRelationshipObservationPlanQuerySchema = z.strictObject({ scope: SupplierScopeSchema });
export const SupplierRelationshipRecoveryQuerySchema = z.strictObject({
  identity: SupplierRelationshipReceiptSchema.shape.identity, commandDigest: HashSchema,
  action: z.enum(['create', 'revise', 'approve', 'suspend', 'revoke']),
});
export const SupplierScopePolicyReadQuerySchema = z.strictObject({ policy: SupplierScopePolicyReferenceSchema });
export const SupplierPrivateRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('policy-command'), purpose: z.enum(policyPurposes), mutation: SupplierScopePolicyMutationSchema }),
  z.strictObject({ kind: z.literal('relationship-command'), purpose: z.enum(relationshipPurposes), mutation: SupplierRelationshipMutationSchema }),
  z.strictObject({ kind: z.literal('policy-read'), purpose: z.literal('supplier_scope_policy_read'), query: SupplierScopePolicyReadQuerySchema }),
  z.strictObject({ kind: z.literal('relationship-status'), purpose: z.literal('supplier_relationship_status'), query: SupplierRelationshipStatusQuerySchema }),
  z.strictObject({ kind: z.literal('relationship-observation-plan'), purpose: z.literal('supplier_relationship_observation_plan'), query: SupplierRelationshipObservationPlanQuerySchema }),
  z.strictObject({ kind: z.literal('relationship-recover'), purpose: z.literal('supplier_relationship_recover'), query: SupplierRelationshipRecoveryQuerySchema }),
]).superRefine((value, context) => {
  if (value.kind === 'policy-command' && value.purpose !== 'supplier_scope_policy_' + value.mutation.command.payload.action) {
    context.addIssue({ code: 'custom', message: 'Policy action and private purpose must agree.' });
  }
  if (value.kind === 'relationship-command' && value.purpose !== 'supplier_relationship_' + value.mutation.command.payload.action) {
    context.addIssue({ code: 'custom', message: 'Relationship action and private purpose must agree.' });
  }
});
export type SupplierPrivateRequest = z.infer<typeof SupplierPrivateRequestSchema>;
const actorLocatorSchema = z.strictObject({ environment: EnvironmentSchema, organizationId: IdSchema, actorId: IdSchema });
const purposeSchema = z.enum([...policyPurposes, ...relationshipPurposes, 'supplier_scope_policy_read', 'supplier_relationship_status', 'supplier_relationship_observation_plan', 'supplier_relationship_recover']);
const requestIdentitySchema = z.strictObject({
  purpose: purposeSchema, pair: SupplierScopePolicyPairSchema, relationshipId: IdSchema.nullable(),
  effectiveOrganizationId: IdSchema, actorId: IdSchema, originalKey: z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/).nullable(),
});
function scopeOf(request: SupplierPrivateRequest) {
  if (request.kind === 'policy-command') return request.mutation.command.pair;
  if (request.kind === 'policy-read') return request.query.policy.pair;
  if (request.kind === 'relationship-command') return request.mutation.command.scope;
  if (request.kind === 'relationship-status' || request.kind === 'relationship-observation-plan') return request.query.scope;
  return request.query.identity.scope;
}
/** Structural request identity only; actor locators must come from a separately authenticated private caller. */
export async function snapshotSupplierPersistenceRequest(input: unknown, actorInput: unknown) {
  const request = immutable(SupplierPrivateRequestSchema.parse(input));
  const actor = immutable(actorLocatorSchema.parse(actorInput));
  const scope = scopeOf(request);
  const pair = SupplierScopePolicyPairSchema.parse({ environment: scope.environment, buyerOrganizationId: scope.buyerOrganizationId, supplierOrganizationId: scope.supplierOrganizationId });
  const policy = request.kind === 'policy-command' || request.kind === 'policy-read';
  if (actor.environment !== pair.environment || (policy ? actor.organizationId !== pair.buyerOrganizationId :
    ![pair.buyerOrganizationId, pair.supplierOrganizationId].includes(actor.organizationId))) throw new Error('Private request actor locator crosses scope.');
  if (request.kind === 'relationship-recover' && (request.query.identity.actorId !== actor.actorId ||
    request.query.identity.organizationId !== actor.organizationId)) throw new Error('Recovery must name the exact original actor and acting party.');
  const originalKey = request.kind === 'policy-command' || request.kind === 'relationship-command' ? request.mutation.idempotencyKey :
    request.kind === 'relationship-recover' ? request.query.identity.idempotencyKey : null;
  const identity = immutable(requestIdentitySchema.parse({ purpose: request.purpose, pair,
    relationshipId: 'supplierRelationshipId' in scope ? scope.supplierRelationshipId : null,
    effectiveOrganizationId: actor.organizationId, actorId: actor.actorId, originalKey }));
  const requestDigest = await commandDigest({ namespace: 'pactwoven/supplier-private-request/v1', identity, request });
  let mutationDigest: string | null = null;
  if (request.kind === 'policy-command') mutationDigest = await supplierScopePolicyCommandDigest(request.mutation, actor.actorId);
  if (request.kind === 'relationship-command') mutationDigest = await commandDigest({
    namespace: 'pactwoven/supplier-relationship-command/v1',
    identity: { scope: request.mutation.command.scope, organizationId: actor.organizationId, actorId: actor.actorId, idempotencyKey: request.mutation.idempotencyKey },
    command: request.mutation.command,
  });
  return immutable({ kind: 'STRUCTURAL_REQUEST_SNAPSHOT' as const, authentication: 'NOT_ESTABLISHED' as const,
    request, identity, requestDigest, mutationDigest });
}

export const SupplierPersistedRelationshipReceiptSchema = z.strictObject({
  receipt: SupplierRelationshipReceiptSchema, policy: SupplierScopePolicyReferenceSchema,
}).refine(value => supplierScopePolicyPairsMatch(value.receipt.identity.scope, value.policy.pair), 'Original receipt policy pin must retain its ordered pair.');
export const SupplierPersistedRelationshipVersionSchema = z.strictObject({
  snapshot: SupplierRelationshipSnapshotSchema, policyBinding: SupplierRelationshipPolicyBindingSchema,
}).refine(value => supplierScopesMatch(value.snapshot.proposal.scope, value.policyBinding.scope) &&
  value.snapshot.proposal.version === value.policyBinding.proposal.version && value.snapshot.proposalHash === value.policyBinding.proposal.hash &&
  value.snapshot.proposal.createdAt === value.policyBinding.producingReceipt.recordedAt &&
  value.policyBinding.producingReceipt.result.revision <= value.snapshot.revision &&
  value.snapshot.proposal.createdBy.actorId === value.policyBinding.producingReceipt.identity.actorId &&
  value.snapshot.proposal.createdBy.organizationId === value.policyBinding.producingReceipt.identity.organizationId,
  'Every immutable relationship revision retains the exact original proposal policy pin.');

const organizationSchema = z.strictObject({
  id: IdSchema, environment: EnvironmentSchema, externalOrganizationId: externalId, version, authorityEpoch: epoch,
  status: z.enum(['ACTIVE', 'SUSPENDED', 'REVOKED']), ...interval,
});
const membershipSchema = z.strictObject({
  id: IdSchema, actorId: IdSchema, organizationId: IdSchema, environment: EnvironmentSchema, version, organizationEpoch: epoch,
  principalKind: z.enum(['human', 'service']), status: z.enum(['ACTIVE', 'SUSPENDED', 'REVOKED']),
  roles: z.array(RoleSchema).min(1).max(9).refine(unique), ...interval,
  subject: externalId, externalMembershipId: externalId, grantBasis: z.enum(['internal', 'clerk_admin_bootstrap', 'owner_grant']),
});
const resolverSchema = z.strictObject({
  schemaVersion: z.literal(1), requestIdentity: requestIdentitySchema, requestDigest: HashSchema,
  context: z.strictObject({
    phase: z.literal('RESOLVE'), databaseOid: oid, sessionUserOid: oid, backendPid: z.number().int().min(1).max(2_147_483_647),
    fullTransactionId: z.string().regex(/^[1-9][0-9]{0,19}$/).refine(value => BigInt(value) <= 18_446_744_073_709_551_615n),
    isolation: z.literal('read committed'), binding: SupplierPrivatePrincipalBindingSchema,
    evidence: VersionReferenceSchema, observedAt: InstantSchema, expiresAt: InstantSchema,
  }),
  organizations: z.strictObject({ buyer: organizationSchema, supplier: organizationSchema }),
  acting: z.strictObject({ actor: ActorContextSchema, membership: membershipSchema, observation: SupplierExternalObservationSchema }),
  approvers: z.array(z.strictObject({ membership: membershipSchema, approval: SupplierRelationshipApprovalSchema, observation: SupplierMembershipObservationSchema })).max(2),
  policy: z.strictObject({
    head: SupplierScopePolicyReferenceSchema.nullable(), current: SupplierScopePolicySnapshotSchema.nullable(),
    selectedVersion: SupplierScopePolicySnapshotSchema.nullable(), originalReceipt: SupplierScopePolicyReceiptSchema.nullable(),
    selectedBuyerSites: z.array(z.strictObject({ environment: EnvironmentSchema, organizationId: IdSchema, id: IdSchema })).max(100),
    categoryHistory: z.array(z.strictObject({ id: IdSchema, category: SupplierScopeCategorySchema.nullable() })).max(100),
  }),
  relationship: z.strictObject({
    head: SupplierRelationshipHeadSchema.nullable(), current: SupplierPersistedRelationshipVersionSchema.nullable(),
    originalReceipt: SupplierPersistedRelationshipReceiptSchema.nullable(),
  }).nullable(),
  participation: z.null(), observedAt: InstantSchema, expiresAt: InstantSchema,
});
function currentObservation(value: z.infer<typeof SupplierExternalObservationSchema>, at: number) {
  return ms(value.observedAt) <= at && at - ms(value.observedAt) <= 20_000 &&
    ms(value.membershipObservedAt) <= at && at - ms(value.membershipObservedAt) <= 20_000 && at < ms(value.expiresAt);
}
function sameExternal(member: z.infer<typeof membershipSchema>, observation: z.infer<typeof SupplierExternalObservationSchema> | z.infer<typeof SupplierMembershipObservationSchema>, organization: z.infer<typeof organizationSchema>) {
  return member.environment === organization.environment && member.organizationId === organization.id &&
    member.subject === observation.subject && member.externalMembershipId === observation.externalMembershipId &&
    organization.externalOrganizationId === observation.externalOrganizationId;
}
/** Snapshot a PRIVATE resolver response for further domain validation. The schema is
 * deliberately not exported and this result does not attest engine fields or locks.
 * AUTH-SQL-01..04 still require actual connection/lock/non-owner verification. */
export async function snapshotSupplierResolverEnvelope(input: unknown, requestInput: unknown, actorInput: unknown, now: string) {
  const value = immutable(resolverSchema.parse(input));
  const request = immutable(SupplierPrivateRequestSchema.parse(requestInput));
  const actor = immutable(actorLocatorSchema.parse(actorInput));
  const at = ms(InstantSchema.parse(now));
  const expected = await snapshotSupplierPersistenceRequest(request, actor);
  if (!same(value.requestIdentity, expected.identity) || value.requestDigest !== expected.requestDigest) throw new Error('Resolver request identity mismatch.');
  const pair = expected.identity.pair, binding = value.context.binding;
  if (binding.environment !== pair.environment || binding.effectiveOrganizationId !== actor.organizationId ||
    binding.authorizer.oid !== value.context.sessionUserOid || binding.status !== 'ACTIVE' || !inInterval(binding, at)) throw new Error('Resolver paired principal context mismatch.');
  for (const side of ['buyer', 'supplier'] as const) {
    const organization = value.organizations[side], id = side === 'buyer' ? pair.buyerOrganizationId : pair.supplierOrganizationId;
    if (organization.id !== id || organization.environment !== pair.environment) throw new Error('Resolver organization scope mismatch.');
  }
  const side = actor.organizationId === pair.buyerOrganizationId ? 'buyer' : 'supplier';
  const organization = value.organizations[side], member = value.acting.membership, observation = value.acting.observation, localActor = value.acting.actor;
  if (member.actorId !== actor.actorId || member.organizationId !== actor.organizationId || localActor.actorId !== actor.actorId ||
    localActor.organizationId !== actor.organizationId || localActor.environment !== pair.environment || localActor.principalKind !== 'human' ||
    member.principalKind !== 'human' || member.status !== 'ACTIVE' || !inInterval(member, at) || organization.status !== 'ACTIVE' || !inInterval(organization, at) ||
    member.organizationEpoch !== organization.authorityEpoch || !member.roles.includes(side === 'buyer' ? 'owner' : 'supplier_admin') ||
    !same([...member.roles].sort(), [...localActor.roles].sort()) || localActor.sessionId !== observation.sessionId ||
    localActor.siteIds.length !== 0 || localActor.actionSiteIds.length !== 0 ||
    localActor.authenticatedAt !== observation.authenticatedAt || !sameExternal(member, observation, organization) || !currentObservation(observation, at)) throw new Error('Resolver acting identity facts disagree.');
  if (member.grantBasis === 'clerk_admin_bootstrap' && observation.externalRole !== 'org:admin') throw new Error('Resolver acting bootstrap authority is not current.');
  for (const intervalValue of [value, value.context]) {
    if (ms(intervalValue.observedAt) > at || at - ms(intervalValue.observedAt) > 20_000 || ms(intervalValue.expiresAt) <= at ||
      ms(intervalValue.expiresAt) - ms(intervalValue.observedAt) > 30_000) throw new Error('Resolver observation interval is not current.');
  }
  if (value.context.observedAt !== observation.observedAt || value.context.expiresAt !== observation.expiresAt ||
    ms(value.context.observedAt) < ms(binding.validFrom) || ms(value.context.expiresAt) > ms(binding.expiresAt) ||
    ms(value.observedAt) < ms(value.context.observedAt) || ms(value.expiresAt) > ms(value.context.expiresAt)) throw new Error('Resolver must retain the original bounded evidence interval.');
  const approverKeys = value.approvers.map(entry => entry.membership.environment + '/' + entry.membership.organizationId + '/' + entry.membership.id);
  if (!unique(approverKeys)) throw new Error('Duplicate approver resolution.');
  for (const entry of value.approvers) {
    const party = entry.membership.organizationId === pair.buyerOrganizationId ? 'buyer' :
      entry.membership.organizationId === pair.supplierOrganizationId ? 'supplier' : null;
    if (party === null || !sameExternal(entry.membership, entry.observation, value.organizations[party]) || entry.observation.issuer !== observation.issuer ||
      ms(entry.observation.observedAt) > at || at - ms(entry.observation.observedAt) > 20_000 || at >= ms(entry.observation.expiresAt)) throw new Error('Approver observation crosses the exact parties or original freshness window.');
    if (entry.membership.id === member.id && entry.membership.organizationId === member.organizationId && !same(entry.membership, member)) throw new Error('Acting and approver membership resolutions conflict.');
  }
  const policy = value.policy;
  if (policy.current === null ? policy.head !== null : !same(policy.head, policyReference(policy.current))) throw new Error('Resolver must retain the exact latest policy, including revocation.');
  for (const record of [policy.current, policy.selectedVersion, policy.originalReceipt?.result ?? null]) {
    if (record !== null) {
      if (!supplierScopePolicyPairsMatch(record.policy.pair, pair)) throw new Error('Resolver policy crosses ordered pair.');
      await checkPolicyRecord(record);
      if (ms(record.policy.issuedAt) > at || policy.current === null || !policyRecordWithinHead(record, policy.current)) throw new Error('Resolved policy history must retain the current immutable lineage.');
    }
  }
  if (policy.originalReceipt !== null && (request.kind !== 'policy-command' || policy.originalReceipt.commandDigest !== expected.mutationDigest ||
    !same(policy.originalReceipt.identity, { pair, organizationId: actor.organizationId, actorId: actor.actorId, idempotencyKey: request.mutation.idempotencyKey }) ||
    !originalPolicyResult(request.mutation, policy.originalReceipt))) throw new Error('Unrequested policy command receipt.');
  if (!unique(policy.selectedBuyerSites.map(site => site.id)) || policy.selectedBuyerSites.some(site => site.environment !== pair.environment || site.organizationId !== pair.buyerOrganizationId) ||
    !unique(policy.categoryHistory.map(entry => entry.id)) || policy.categoryHistory.some(entry => entry.category !== null && entry.id !== entry.category.id)) throw new Error('Selected site/category lookup is ambiguous or crosses scope.');
  if (request.kind === 'policy-command' && request.mutation.command.payload.action !== 'revoke') {
    const terms = request.mutation.command.payload.terms;
    if (!same([...terms.buyerSiteIds].sort(), policy.selectedBuyerSites.map(site => site.id).sort()) ||
      !same(terms.categories.map(category => category.id).sort(), policy.categoryHistory.map(entry => entry.id).sort())) throw new Error('Policy resolver must resolve exactly the selected sites/categories.');
    for (const entry of policy.categoryHistory) {
      if (entry.category !== null) {
        const { definitionHash, ...category } = entry.category;
        if (definitionHash !== await supplierScopeCategoryDigest(pair, category)) throw new Error('Private category history hash mismatch.');
      }
      const currentCategory = policy.current?.policy.categories.find(category => category.id === entry.id);
      if (currentCategory && !same(currentCategory, entry.category)) throw new Error('Category history must retain the current definition.');
    }
  } else if (policy.selectedBuyerSites.length || policy.categoryHistory.length) throw new Error('This request cannot enumerate site/category rows.');
  if (request.kind === 'policy-read') {
    if (policy.selectedVersion === null || !same(request.query.policy, { pair: policy.selectedVersion.policy.pair, version: policy.selectedVersion.policy.version, hash: policy.selectedVersion.policyHash })) throw new Error('Policy read must resolve the exact requested immutable version.');
  } else if (policy.selectedVersion !== null) throw new Error('Unrequested private policy version.');
  if (expected.identity.relationshipId === null) {
    if (value.relationship !== null || value.approvers.length) throw new Error('Policy resolution cannot return relationship or approver rows.');
  } else {
    const relationship = value.relationship;
    if (relationship === null) throw new Error('Relationship resolution is required.');
    const scope = scopeOf(request);
    if (relationship.head !== null && (!supplierScopesMatch(relationship.head.scope, scope as z.infer<typeof SupplierScopeSchema>))) throw new Error('Relationship head crosses request scope.');
    if (relationship.current !== null && (!supplierScopesMatch(relationship.current.snapshot.proposal.scope, scope as z.infer<typeof SupplierScopeSchema>) ||
      relationship.head === null || relationship.current.snapshot.revision > relationship.head.revision)) throw new Error('Resolved relationship version crosses scope/head.');
    if (relationship.current !== null) {
      await checkRelationshipRecord(relationship.current.snapshot);
      const selectedRevision = request.kind === 'relationship-status' ? request.query.revision : null;
      if ((selectedRevision !== null && relationship.current.snapshot.revision !== selectedRevision) ||
        ((selectedRevision === null || relationship.current.snapshot.revision === relationship.head?.revision) && !same(relationshipHead(relationship.current.snapshot), relationship.head)) ||
        ms(relationship.current.snapshot.updatedAt) > at || relationship.current.snapshot.proposal.version > relationship.head!.proposal.version ||
        (relationship.current.snapshot.proposal.version === relationship.head!.proposal.version && !same(relationshipHead(relationship.current.snapshot).proposal, relationship.head!.proposal))) throw new Error('Resolver returned an unrequested or inconsistent relationship revision.');
    } else if (relationship.head !== null) throw new Error('Current relationship record is missing.');
    if (relationship.originalReceipt !== null) {
      const original = relationship.originalReceipt.receipt;
      const identity = request.kind === 'relationship-command' ? { scope, organizationId: actor.organizationId, actorId: actor.actorId, idempotencyKey: request.mutation.idempotencyKey } :
        request.kind === 'relationship-recover' ? request.query.identity : null;
      const digest = request.kind === 'relationship-command' ? expected.mutationDigest : request.kind === 'relationship-recover' ? request.query.commandDigest : null;
      if (!same(original.identity, identity) || original.commandDigest !== digest || relationship.head === null ||
        !relationshipReceiptWithinHead(original, relationship.head) || ms(original.recordedAt) > at ||
        (request.kind === 'relationship-command' && !originalRelationshipResult(request.mutation, original)) ||
        (request.kind === 'relationship-recover' && !recoveryActionMatches(request.query.action, original)) ||
        (relationship.current !== null && original.result.proposal.version === relationship.current.snapshot.proposal.version &&
          !same(relationship.originalReceipt.policy, relationship.current.policyBinding.policy))) throw new Error('Original receipt crosses exact request identity or immutable history.');
      if (relationship.current !== null) {
        const current = relationship.current.snapshot, producing = relationship.current.policyBinding.producingReceipt;
        if (ms(original.recordedAt) > ms(current.updatedAt) ||
          (original.result.revision === current.revision && original.recordedAt !== current.updatedAt) ||
          (original.result.revision === producing.result.revision && !same(original, producing)) ||
          (original.result.revision > producing.result.revision && ms(original.recordedAt) < ms(producing.recordedAt))) {
          throw new Error('Original receipt time or producing copy contradicts resolved history.');
        }
      }
    }
    const approvals = relationship.current?.snapshot.approvals;
    const stamps = approvals ? [approvals.buyer, approvals.supplier].filter(approval => approval !== null) : [];
    if (value.approvers.some(entry => !stamps.some(stamp => same(stamp, entry.approval) && stamp.membershipId === entry.membership.id && stamp.organizationId === entry.membership.organizationId && stamp.actorId === entry.membership.actorId))) throw new Error('Unrequested approver rows.');
    if (request.kind === 'relationship-observation-plan' && value.approvers.length) throw new Error('Observation planning cannot assert fresh prior-approver observations.');
    const currentStatus = request.kind === 'relationship-status' && (request.query.revision === null || request.query.revision === relationship.head?.revision);
    const newApproval = request.kind === 'relationship-command' && request.mutation.command.payload.action === 'approve' && relationship.originalReceipt === null;
    if ((currentStatus || newApproval) && value.approvers.length !== stamps.length) throw new Error('Current approval evaluation requires every exact fresh original approver observation.');
  }
  return immutable({ kind: 'STRUCTURAL_RESOLVER_SNAPSHOT' as const, authentication: 'NOT_ESTABLISHED' as const,
    locking: 'NOT_ESTABLISHED' as const, value, digest: await commandDigest({ namespace: 'pactwoven/supplier-private-resolver/v1', value }) });
}

const resultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('relationship-status'), projection: SupplierRelationshipProjectionSchema }),
  z.strictObject({ kind: z.literal('relationship-observation-plan'), plan: z.strictObject({
    scope: SupplierScopeSchema, head: SupplierRelationshipHeadSchema.nullable(), approvers: z.array(z.strictObject({
      approval: SupplierRelationshipApprovalSchema, externalOrganizationId: externalId, externalMembershipId: externalId, subject: externalId,
    })).max(2),
  }) }),
  z.strictObject({ kind: z.literal('policy-read'), record: SupplierScopePolicySnapshotSchema }),
  z.strictObject({ kind: z.literal('relationship-recover'), original: z.strictObject({
    mutation: SupplierRelationshipMutationSchema, receipt: SupplierPersistedRelationshipReceiptSchema,
    binding: SupplierRelationshipPolicyBindingSchema, currentHead: SupplierRelationshipHeadSchema,
  }).nullable() }),
  z.strictObject({ kind: z.literal('policy-command'), receipt: SupplierScopePolicyReceiptSchema, current: SupplierScopePolicySnapshotSchema,
    outcome: z.enum(['APPENDED', 'EXACT_REPLAY']) }),
  z.strictObject({ kind: z.literal('relationship-command'), receipt: SupplierPersistedRelationshipReceiptSchema,
    record: SupplierPersistedRelationshipVersionSchema, currentHead: SupplierRelationshipHeadSchema, outcome: z.enum(['APPENDED', 'EXACT_REPLAY']) }),
]);
/** Private SQL result inspection. No result here proves commit or authenticated execution. */
export async function snapshotSupplierPersistenceResult(input: unknown, requestInput: unknown, actorInput: unknown) {
  const value = immutable(resultSchema.parse(input));
  const request = immutable(SupplierPrivateRequestSchema.parse(requestInput));
  const actor = immutable(actorLocatorSchema.parse(actorInput));
  const expected = await snapshotSupplierPersistenceRequest(request, actor), scope = scopeOf(request);
  if (value.kind !== request.kind) throw new Error('Result family must match exact request purpose.');
  if (value.kind === 'relationship-observation-plan' && request.kind === 'relationship-observation-plan') {
    const plan = value.plan;
    if (!supplierScopesMatch(plan.scope, request.query.scope) || (plan.head !== null && !supplierScopesMatch(plan.head.scope, plan.scope)) ||
      (plan.head === null && plan.approvers.length !== 0) || !unique(plan.approvers.map(entry => entry.approval.organizationId + '/' + entry.approval.membershipId)) ||
      plan.approvers.some(entry => !same(entry.approval.proposal, plan.head?.proposal) || entry.approval.organizationId !==
        (entry.approval.party === 'buyer' ? plan.scope.buyerOrganizationId : plan.scope.supplierOrganizationId))) throw new Error('Private observation plan crosses exact head or original approval scope.');
    if (plan.head?.status === 'ACTIVE' ? plan.approvers.length !== 2 || new Set(plan.approvers.map(entry => entry.approval.party)).size !== 2 :
      plan.head?.status === 'PROPOSED' ? plan.approvers.length > 1 : plan.approvers.length !== 0) throw new Error('Private observation plan must retain exactly the recorded party approvals.');
  }
  if (value.kind === 'relationship-status' && request.kind === 'relationship-status' &&
    (!supplierScopesMatch(value.projection.scope, request.query.scope) || (request.query.revision !== null && value.projection.revision !== request.query.revision) ||
      (request.query.revision === null && !value.projection.current) ||
      value.projection.viewerParty !== (actor.organizationId === request.query.scope.buyerOrganizationId ? 'buyer' : 'supplier'))) throw new Error('Status result crosses scope/revision/viewer.');
  if (value.kind === 'policy-read' && request.kind === 'policy-read' &&
    !same(request.query.policy, { pair: value.record.policy.pair, version: value.record.policy.version, hash: value.record.policyHash })) throw new Error('Policy result crosses exact reference.');
  if (value.kind === 'policy-read') await checkPolicyRecord(value.record);
  if (value.kind === 'policy-command' && request.kind === 'policy-command') {
    if (!same(value.receipt.identity, { pair: scope, actorId: actor.actorId, organizationId: actor.organizationId, idempotencyKey: request.mutation.idempotencyKey }) ||
      value.receipt.commandDigest !== expected.mutationDigest || !supplierScopePolicyPairsMatch(value.current.policy.pair, expected.identity.pair) ||
      !originalPolicyResult(request.mutation, value.receipt) || !policyRecordWithinHead(value.receipt.result, value.current) ||
      (value.outcome === 'APPENDED' && !same(value.receipt.result, value.current))) throw new Error('Policy command result/receipt mismatch.');
    await checkPolicyRecord(value.receipt.result);
    await checkPolicyRecord(value.current);
  }
  if (value.kind === 'relationship-command' && request.kind === 'relationship-command') {
    const receipt = value.receipt.receipt, state = value.record.snapshot, binding = value.record.policyBinding;
    if (!same(receipt.identity, { scope, actorId: actor.actorId, organizationId: actor.organizationId, idempotencyKey: request.mutation.idempotencyKey }) ||
      receipt.commandDigest !== expected.mutationDigest || !originalRelationshipResult(request.mutation, receipt) || !same(value.receipt.policy, binding.policy) ||
      !relationshipReceiptWithinHead(receipt, value.currentHead) || state.revision !== receipt.result.revision ||
      !same(relationshipHead(state), receipt.result) || state.updatedAt !== receipt.recordedAt ||
      state.changedBy.actorId !== actor.actorId || state.changedBy.organizationId !== actor.organizationId ||
      state.changedBy.organizationEpoch !== request.mutation.command.authorityEpoch ||
      (value.outcome === 'APPENDED' && !same(value.currentHead, receipt.result))) throw new Error('Relationship result must retain its original receipt and private policy pin.');
    const payload = request.mutation.command.payload;
    if (payload.action === 'create' || payload.action === 'revise') {
      if (!same(binding.producingReceipt, receipt) || !same(state.proposal.createdBy, state.changedBy) ||
        !same(state.proposal.terms, payload.terms) || state.approvals.buyer !== null || state.approvals.supplier !== null ||
        state.proposal.previousVersionHash !== (request.mutation.command.targetProposal?.hash ?? null)) throw new Error('New proposal result must retain exact command terms and producing receipt.');
    } else {
      if (binding.producingReceipt.result.revision >= state.revision) throw new Error('Later relationship action must follow the original proposal receipt.');
      if (payload.action === 'approve') {
        const party = actor.organizationId === state.proposal.scope.buyerOrganizationId ? 'buyer' : 'supplier', approval = state.approvals[party];
        if (approval === null) throw new Error('Approval result must record the acting party.');
        const { party: _party, proposal: _proposal, approvedAt, expiresAt, ...stamp } = approval;
        if (!same(stamp, state.changedBy) || approvedAt !== receipt.recordedAt || expiresAt !== payload.expiresAt) throw new Error('Approval result must retain the original approval terms.');
      }
    }
    await checkRelationshipRecord(state);
  }
  if (value.kind === 'relationship-recover' && request.kind === 'relationship-recover' && value.original !== null) {
    const original = value.original, receipt = original.receipt.receipt;
    const originalRequest = SupplierPrivateRequestSchema.parse({ kind: 'relationship-command', purpose: 'supplier_relationship_' + original.mutation.command.payload.action, mutation: original.mutation });
    const originalDigest = await snapshotSupplierPersistenceRequest(originalRequest, actor);
    if (!same(receipt.identity, request.query.identity) || receipt.commandDigest !== request.query.commandDigest ||
      originalDigest.mutationDigest !== request.query.commandDigest || original.mutation.command.payload.action !== request.query.action ||
      !originalRelationshipResult(original.mutation, receipt) ||
      !same(original.receipt.policy, original.binding.policy) || !same(receipt.result.proposal, original.binding.proposal) ||
      !supplierScopesMatch(original.binding.scope, receipt.identity.scope) || !relationshipReceiptWithinHead(receipt, original.currentHead) ||
      ms(original.binding.producingReceipt.recordedAt) > ms(receipt.recordedAt) ||
      (['create', 'revise'].includes(original.mutation.command.payload.action) ? !same(receipt, original.binding.producingReceipt) :
        original.binding.producingReceipt.result.revision >= receipt.result.revision)) throw new Error('Recovery must preserve exact original command identity, receipt and policy pin.');
  }
  return immutable({ kind: 'STRUCTURAL_RESULT_SNAPSHOT' as const, authentication: 'NOT_ESTABLISHED' as const,
    persistence: 'NOT_ESTABLISHED' as const, value, digest: await commandDigest({ namespace: 'pactwoven/supplier-private-result/v1', value }) });
}
