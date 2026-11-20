import { z } from 'zod';
import {
  ActorContextSchema, EnvironmentSchema, HashSchema, IdSchema, InstantSchema, RoleSchema, VersionReferenceSchema,
  SupplierScopePolicyPairSchema, SupplierScopePolicyReferenceSchema, SupplierScopeCategoryInputSchema, SupplierScopeCategorySchema,
  SupplierScopePolicyMutationSchema, SupplierScopePolicyVersionSchema, SupplierScopePolicySnapshotSchema, SupplierScopePolicyReceiptSchema,
  SupplierRelationshipPolicyBindingSchema, SupplierRelationshipProposalSchema, SupplierRelationshipReceiptSchema,
  SupplierRelationshipProjectionSchema, supplierScopePolicyPairsMatch, supplierScopesMatch,
  type SupplierScopePolicyPair, type SupplierScopePolicySnapshot, type SupplierScopePolicyCommandIdentity,
  type SupplierScopePolicyVersion, type SupplierRelationshipProposal,
} from '@pactwoven/contracts';
import { canonicalJson, commandDigest } from './canonical.js';
import { immutable, nextVersion } from './financial-primitives.js';
import { DomainError } from './errors.js';

const version = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const epoch = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const externalId = z.string().min(1).max(256);
const organizationSchema = z.strictObject({
  id: IdSchema, environment: EnvironmentSchema, externalOrganizationId: externalId, version, authorityEpoch: epoch,
  status: z.enum(['ACTIVE', 'SUSPENDED', 'REVOKED']), validFrom: InstantSchema, expiresAt: InstantSchema.nullable(),
});
// PRIVATE trusted-loader facts. Parsing checks shape, never authenticates the source.
// The server must resolve current local/external identities, lock both organizations in
// order, and recheck time, head and selected sites after waits. No request may supply facts.
const readFactsSchema = z.strictObject({
  schemaVersion: z.literal(1), pair: SupplierScopePolicyPairSchema, observedAt: InstantSchema, expiresAt: InstantSchema,
  organizations: z.strictObject({ buyer: organizationSchema, supplier: organizationSchema }),
  head: SupplierScopePolicyReferenceSchema.nullable(),
});
const issuerFactsSchema = readFactsSchema.extend({
  actor: ActorContextSchema,
  membership: z.strictObject({
    id: IdSchema, actorId: IdSchema, organizationId: IdSchema, environment: EnvironmentSchema,
    principalKind: z.enum(['human', 'service']), version, organizationEpoch: epoch,
    roles: z.array(RoleSchema).min(1).max(9).refine(values => new Set(values).size === values.length),
    status: z.enum(['ACTIVE', 'SUSPENDED', 'REVOKED']), validFrom: InstantSchema, expiresAt: InstantSchema.nullable(),
    subject: externalId, externalMembershipId: externalId, grantBasis: z.enum(['internal', 'clerk_admin_bootstrap', 'owner_grant']),
  }),
  session: z.strictObject({
    id: externalId, actorId: IdSchema, organizationId: IdSchema, environment: EnvironmentSchema,
    subject: externalId, externalOrganizationId: externalId, externalMembershipId: externalId, externalRole: externalId,
    membershipId: IdSchema, membershipVersion: version, organizationVersion: version, organizationEpoch: epoch,
    status: z.enum(['ACTIVE', 'REVOKED']), authenticatedAt: InstantSchema, expiresAt: InstantSchema,
    membershipObservedAt: InstantSchema, issuer: z.url().max(2048), tokenHash: HashSchema,
  }),
  factors: z.strictObject({
    reference: VersionReferenceSchema, purpose: z.literal('supplier_scope_policy'), pair: SupplierScopePolicyPairSchema,
    requestDigest: HashSchema, sessionId: externalId, subject: externalId, externalOrganizationId: externalId,
    externalMembershipId: externalId, issuer: z.url().max(2048), tokenHash: HashSchema, tokenIssuedAt: InstantSchema,
    observedAt: InstantSchema, expiresAt: InstantSchema, firstFactorAt: InstantSchema, secondFactorAt: InstantSchema,
  }),
  // Existing exact selected rows, not an automatic site grant and not a site creator.
  buyerSites: z.array(z.strictObject({ environment: EnvironmentSchema, organizationId: IdSchema, id: IdSchema })).max(100),
  // One complete lookup per requested ID over ALL prior versions, including removed or
  // revoked categories. Null certifies that this pair has never used the ID. The loader
  // must not derive this from just the current active version or silently omit entries.
  categoryHistory: z.strictObject({
    pair: SupplierScopePolicyPairSchema, head: SupplierScopePolicyReferenceSchema.nullable(),
    entries: z.array(z.strictObject({ id: IdSchema, category: SupplierScopeCategorySchema.nullable() })).max(100),
  }),
});
export type SupplierScopePolicyReadFacts = z.infer<typeof readFactsSchema>;
export type SupplierScopePolicyIssuerFacts = z.infer<typeof issuerFactsSchema>;
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const ms = (value: string) => Date.parse(value);
const reference = (snapshot: SupplierScopePolicySnapshot) => ({ pair: snapshot.policy.pair, version: snapshot.policy.version, hash: snapshot.policyHash });
const currentInterval = (value: { validFrom: string; expiresAt: string | null }, at: number) =>
  ms(value.validFrom) <= at && (value.expiresAt === null || at < ms(value.expiresAt));
const fresh = (value: string, at: number) => ms(value) <= at && at - ms(value) <= 20_000;
const activeOrganization = (value: z.infer<typeof organizationSchema>, at: number) => value.status === 'ACTIVE' && currentInterval(value, at);
function fail(code: string, status: 403 | 409 | 422, message: string): never { throw new DomainError(code, status, message); }
const limitations = {
  authentication: 'NOT_ESTABLISHED' as const, persistence: 'NOT_ESTABLISHED' as const,
  businessVerification: 'NOT_ESTABLISHED' as const, payeeVerification: 'NOT_ESTABLISHED' as const,
  supplierRoleGranted: false as const, participationGranted: false as const,
  bookingAuthority: false as const, contractualAcceptance: false as const, paymentAuthority: false as const,
};
const categoryDigest = (pair: SupplierScopePolicyPair, category: z.infer<typeof SupplierScopeCategoryInputSchema>) =>
  commandDigest({ namespace: 'pactwoven/supplier-scope-category/v1', pair, category });
const policyDigest = (policy: SupplierScopePolicyVersion) => commandDigest({ namespace: 'pactwoven/supplier-scope-policy/v1', policy });
const requestDigest = (identity: SupplierScopePolicyCommandIdentity, command: z.infer<typeof SupplierScopePolicyMutationSchema>['command']) =>
  commandDigest({ namespace: 'pactwoven/supplier-scope-policy-command/v1', identity, command });
const proposalDigest = (proposal: SupplierRelationshipProposal) => commandDigest({ namespace: 'pactwoven/supplier-relationship-proposal/v1', proposal });

/** Canonical digests identify normalized bytes; they do not attest authority. */
export async function supplierScopeCategoryDigest(pairInput: unknown, categoryInput: unknown) {
  const pair = immutable(SupplierScopePolicyPairSchema.parse(pairInput));
  const category = immutable(SupplierScopeCategoryInputSchema.parse(categoryInput));
  return categoryDigest(pair, category);
}
export async function supplierScopePolicyDigest(input: unknown) {
  return policyDigest(immutable(SupplierScopePolicyVersionSchema.parse(input)));
}
export async function supplierScopePolicyCommandDigest(input: unknown, actorIdInput: unknown) {
  const request = immutable(SupplierScopePolicyMutationSchema.parse(input));
  const actorId = IdSchema.parse(actorIdInput);
  return requestDigest({ pair: request.command.pair, organizationId: request.command.pair.buyerOrganizationId, actorId, idempotencyKey: request.idempotencyKey }, request.command);
}
function validateReadFacts(facts: SupplierScopePolicyReadFacts, at: number) {
  if (!fresh(facts.observedAt, at) || ms(facts.expiresAt) <= at || ms(facts.expiresAt) - ms(facts.observedAt) > 30_000) {
    fail('SUPPLIER_SCOPE_POLICY_ACCESS_DENIED', 403, 'Original current private observations are required.');
  }
  for (const side of ['buyer', 'supplier'] as const) {
    const organization = facts.organizations[side];
    const id = side === 'buyer' ? facts.pair.buyerOrganizationId : facts.pair.supplierOrganizationId;
    if (organization.id !== id || organization.environment !== facts.pair.environment ||
      (organization.expiresAt !== null && ms(organization.expiresAt) <= ms(organization.validFrom))) {
      fail('SUPPLIER_SCOPE_POLICY_ACCESS_DENIED', 403, 'Both exact organization identities must be resolved.');
    }
  }
  if (facts.head !== null && !supplierScopePolicyPairsMatch(facts.pair, facts.head.pair)) {
    fail('SUPPLIER_SCOPE_POLICY_VERSION_CONFLICT', 409, 'The resolved head belongs to another ordered pair.');
  }
}
function validateIssuer(facts: SupplierScopePolicyIssuerFacts, at: number) {
  validateReadFacts(facts, at);
  const { actor, membership: member, session, factors, organizations: { buyer } } = facts;
  if (!activeOrganization(buyer, at) || actor.principalKind !== 'human' || member.principalKind !== 'human' ||
    actor.organizationId !== buyer.id || actor.environment !== facts.pair.environment || member.environment !== actor.environment ||
    member.actorId !== actor.actorId || member.organizationId !== buyer.id || member.status !== 'ACTIVE' || !currentInterval(member, at) ||
    member.organizationEpoch !== buyer.authorityEpoch || !member.roles.includes('owner') || !same([...actor.roles].sort(), [...member.roles].sort()) ||
    session.id !== actor.sessionId || session.actorId !== actor.actorId || session.organizationId !== buyer.id || session.environment !== actor.environment ||
    session.membershipId !== member.id || session.membershipVersion !== member.version || session.organizationVersion !== buyer.version ||
    session.organizationEpoch !== buyer.authorityEpoch || session.subject !== member.subject || session.externalMembershipId !== member.externalMembershipId ||
    session.externalOrganizationId !== buyer.externalOrganizationId || session.authenticatedAt !== actor.authenticatedAt ||
    ms(session.authenticatedAt) > at || session.status !== 'ACTIVE' || ms(session.expiresAt) <= at ||
    !fresh(session.membershipObservedAt, at) || (member.grantBasis === 'clerk_admin_bootstrap' && session.externalRole !== 'org:admin')) {
    fail('SUPPLIER_SCOPE_POLICY_ACCESS_DENIED', 403, 'A current pinned buyer human owner and live external membership/session are required.');
  }
  if (!supplierScopePolicyPairsMatch(factors.pair, facts.pair) || factors.sessionId !== session.id || factors.subject !== member.subject ||
    factors.externalOrganizationId !== buyer.externalOrganizationId || factors.externalMembershipId !== member.externalMembershipId ||
    factors.issuer !== session.issuer || factors.tokenHash !== session.tokenHash || !fresh(factors.observedAt, at) ||
    ms(factors.expiresAt) <= at || ms(factors.expiresAt) - ms(factors.observedAt) > 30_000 ||
    ms(factors.tokenIssuedAt) > ms(factors.observedAt) ||
    [factors.firstFactorAt, factors.secondFactorAt].some(value => ms(value) > ms(factors.tokenIssuedAt) || at - ms(value) > 300_000)) {
    fail('SUPPLIER_SCOPE_POLICY_FRESH_FACTORS_REQUIRED', 403, 'Original supplier-purpose evidence for both factors within five minutes is required.');
  }
}
async function assertSnapshot(snapshot: SupplierScopePolicySnapshot) {
  if (snapshot.policyHash !== await policyDigest(snapshot.policy)) fail('SUPPLIER_SCOPE_POLICY_HASH_CONFLICT', 409, 'Policy bytes do not match their immutable digest.');
  for (const { definitionHash, ...category } of snapshot.policy.categories) {
    if (definitionHash !== await categoryDigest(snapshot.policy.pair, category)) fail('SUPPLIER_SCOPE_POLICY_HASH_CONFLICT', 409, 'Category meaning does not match its pair-local digest.');
  }
}
async function selectedCategories(request: z.infer<typeof SupplierScopePolicyMutationSchema>, facts: SupplierScopePolicyIssuerFacts, current: SupplierScopePolicySnapshot | null) {
  if (request.command.payload.action === 'revoke') return [];
  const terms = request.command.payload.terms, history = facts.categoryHistory;
  if (!supplierScopePolicyPairsMatch(history.pair, facts.pair) || !same(history.head, facts.head) ||
    history.entries.length !== terms.categories.length || new Set(history.entries.map(value => value.id)).size !== history.entries.length ||
    history.entries.some(value => !terms.categories.some(category => category.id === value.id))) {
    fail('SUPPLIER_SCOPE_POLICY_CATEGORY_HISTORY_CONFLICT', 409, 'A complete pair-local historical category lookup at this exact head is required.');
  }
  if (facts.buyerSites.length !== terms.buyerSiteIds.length || new Set(facts.buyerSites.map(value => value.id)).size !== facts.buyerSites.length ||
    facts.buyerSites.some(value => value.environment !== facts.pair.environment || value.organizationId !== facts.pair.buyerOrganizationId || !terms.buyerSiteIds.includes(value.id))) {
    fail('SUPPLIER_SCOPE_POLICY_SITE_INVALID', 422, 'Only explicitly selected existing buyer sites may enter this policy.');
  }
  const result = [];
  for (const category of terms.categories) {
    const entry = history.entries.find(value => value.id === category.id)!;
    const present = current?.policy.categories.find(value => value.id === category.id);
    if (present !== undefined && !same(entry.category, present)) {
      fail('SUPPLIER_SCOPE_POLICY_CATEGORY_HISTORY_CONFLICT', 409, 'Historical lookup cannot contradict a category in the current policy.');
    }
    const next = { ...category, definitionHash: await categoryDigest(facts.pair, category) };
    if (entry.category !== null && !same(entry.category, next)) {
      fail('SUPPLIER_SCOPE_POLICY_CATEGORY_MEANING_CONFLICT', 409, 'A previously used category ID keeps its exact meaning forever within this pair.');
    }
    result.push(next);
  }
  return result;
}

/** Pure proposed append only. All inputs are private snapshots before the first hash await.
 * Future persistence must fence the head, identity, time and complete category history,
 * then atomically append exactly one version and reciprocal receipt. No SQL runs here. */
export async function planSupplierScopePolicyMutation(input: unknown, factsInput: unknown, currentInput: unknown, receiptInput: unknown, now: string) {
  const request = immutable(SupplierScopePolicyMutationSchema.parse(input));
  const facts = immutable(issuerFactsSchema.parse(factsInput));
  const current = currentInput === null ? null : immutable(SupplierScopePolicySnapshotSchema.parse(currentInput));
  const stored = receiptInput === null ? null : immutable(SupplierScopePolicyReceiptSchema.parse(receiptInput));
  const at = ms(InstantSchema.parse(now)), acceptedAt = new Date(at).toISOString();
  validateIssuer(facts, at);
  const command = request.command, action = command.payload.action;
  if (!supplierScopePolicyPairsMatch(command.pair, facts.pair)) {
    fail('SUPPLIER_SCOPE_POLICY_ACCESS_DENIED', 403, 'The command must bind the exact resolved pair.');
  }
  if (current === null ? facts.head !== null : !same(reference(current), facts.head) || ms(current.policy.issuedAt) > at) {
    fail('SUPPLIER_SCOPE_POLICY_VERSION_CONFLICT', 409, 'Load the exact latest policy, including revoked or expired heads.');
  }
  if (current !== null && (['buyer', 'supplier'] as const).some(side =>
    current.policy.organizations[side].externalOrganizationId !== facts.organizations[side].externalOrganizationId)) {
    fail('SUPPLIER_SCOPE_POLICY_ACCESS_DENIED', 403, 'Current local parties must retain the pinned external organization identities.');
  }
  const identity = { pair: facts.pair, organizationId: facts.pair.buyerOrganizationId, actorId: facts.actor.actorId, idempotencyKey: request.idempotencyKey };
  const digest = await requestDigest(identity, command);
  if (digest !== facts.factors.requestDigest) fail('SUPPLIER_SCOPE_POLICY_EVIDENCE_CONFLICT', 403, 'Private factor evidence must bind this exact original command.');
  if (current !== null) await assertSnapshot(current);
  if (stored !== null) {
    if (!same(stored.identity, identity)) fail('SUPPLIER_SCOPE_POLICY_RECEIPT_CONFLICT', 409, 'The receipt belongs to another original actor, key or pair.');
    if (stored.commandDigest !== digest) fail('IDEMPOTENCY_CONFLICT', 409, 'This original key was used with different command content.');
    await assertSnapshot(stored.result);
    const original = stored.result.policy;
    if (current === null || original.version !== command.expectedVersion + 1 || original.version > current.policy.version ||
      !same(original.predecessor, command.predecessor) || original.status !== (action === 'revoke' ? 'REVOKED' : 'ACTIVE') ||
      ms(original.issuedAt) > ms(current.policy.issuedAt) ||
      (original.version === current.policy.version && !same(stored.result, current)) ||
      (original.version + 1 === current.policy.version && !same(reference(stored.result), current.policy.predecessor))) {
      fail('SUPPLIER_SCOPE_POLICY_RECEIPT_CONFLICT', 409, 'The original result is inconsistent with the current immutable lineage.');
    }
    if (command.payload.action !== 'revoke' && (!same(original.buyerSiteIds, command.payload.terms.buyerSiteIds) ||
      !same(original.categories.map(({ definitionHash: _hash, ...category }) => category), command.payload.terms.categories) ||
      ms(original.expiresAt) - ms(original.issuedAt) > command.payload.terms.requestedValidityMs)) {
      fail('SUPPLIER_SCOPE_POLICY_RECEIPT_CONFLICT', 409, 'The original policy does not match the command terms.');
    }
    // A receipt is historical identity, never a next ACTIVE state or renewed permission.
    return immutable({ kind: 'EXACT_REPLAY' as const, ...limitations, originalReceipt: stored,
      current: { reference: reference(current), status: current.policy.status } });
  }
  // Historical recovery uses current actor access and the unchanged original
  // command. Only a new append must carry the current authority stamp.
  if (command.buyerOrganizationVersion !== facts.organizations.buyer.version ||
    command.authorityEpoch !== facts.organizations.buyer.authorityEpoch) {
    fail('SUPPLIER_SCOPE_POLICY_ACCESS_DENIED', 403, 'A new command must bind current buyer authority.');
  }
  if (current === null ? action !== 'issue' : action === 'issue' || command.expectedVersion !== current.policy.version ||
    !same(command.predecessor, reference(current))) fail('SUPPLIER_SCOPE_POLICY_VERSION_CONFLICT', 409, 'A new version must name the exact current predecessor.');
  if (action === 'revoke' && current?.policy.status === 'REVOKED') fail('SUPPLIER_SCOPE_POLICY_ALREADY_REVOKED', 409, 'The current policy is already revoked.');
  if (action !== 'revoke' && !activeOrganization(facts.organizations.supplier, at)) {
    fail('SUPPLIER_SCOPE_POLICY_ORGANIZATION_INACTIVE', 409, 'Both organizations must be current and active before scope is issued.');
  }
  const categories = await selectedCategories(request, facts, current);
  const expiry = command.payload.action === 'revoke' ? at : Math.min(at + command.payload.terms.requestedValidityMs,
    ...[facts.membership.expiresAt, facts.organizations.buyer.expiresAt].filter((value): value is string => value !== null).map(ms));
  const organizationStamp = (value: z.infer<typeof organizationSchema>) => ({
    externalOrganizationId: value.externalOrganizationId, version: value.version, authorityEpoch: value.authorityEpoch,
  });
  const policy = immutable(SupplierScopePolicyVersionSchema.parse({
    schemaVersion: 1, pair: facts.pair, version: nextVersion(current?.policy.version ?? 0),
    predecessor: current === null ? null : reference(current), status: action === 'revoke' ? 'REVOKED' : 'ACTIVE',
    buyerSiteIds: command.payload.action === 'revoke' ? current!.policy.buyerSiteIds : command.payload.terms.buyerSiteIds,
    categories: action === 'revoke' ? current!.policy.categories : categories,
    issuedAt: acceptedAt, validFrom: acceptedAt, expiresAt: new Date(expiry).toISOString(),
    organizations: { buyer: organizationStamp(facts.organizations.buyer), supplier: organizationStamp(facts.organizations.supplier) },
    issuer: { actorId: facts.actor.actorId, organizationId: facts.actor.organizationId, membershipId: facts.membership.id,
      membershipVersion: facts.membership.version, organizationVersion: facts.organizations.buyer.version,
      organizationEpoch: facts.organizations.buyer.authorityEpoch, subject: facts.membership.subject,
      externalOrganizationId: facts.organizations.buyer.externalOrganizationId, externalMembershipId: facts.membership.externalMembershipId,
      sessionId: facts.session.id, factorEvidence: facts.factors.reference },
    commandIdentity: identity, commandDigest: digest,
  }));
  const next = immutable(SupplierScopePolicySnapshotSchema.parse({ policy, policyHash: await policyDigest(policy) }));
  const receipt = immutable(SupplierScopePolicyReceiptSchema.parse({ identity, commandDigest: digest, result: next, recordedAt: acceptedAt }));
  return immutable({ kind: 'PROPOSED_TRANSITION' as const, ...limitations, next, receipt });
}

async function currentScope(policy: SupplierScopePolicySnapshot | null, facts: SupplierScopePolicyReadFacts, proposal: SupplierRelationshipProposal, at: number) {
  validateReadFacts(facts, at);
  if (policy === null) return false;
  await assertSnapshot(policy);
  return supplierScopePolicyPairsMatch(proposal.scope, facts.pair) && same(reference(policy), facts.head) &&
    policy.policy.status === 'ACTIVE' && currentInterval(policy.policy, at) &&
    activeOrganization(facts.organizations.buyer, at) && activeOrganization(facts.organizations.supplier, at) &&
    policy.policy.organizations.buyer.externalOrganizationId === facts.organizations.buyer.externalOrganizationId &&
    policy.policy.organizations.supplier.externalOrganizationId === facts.organizations.supplier.externalOrganizationId &&
    proposal.terms.buyerSiteIds.every(id => policy.policy.buyerSiteIds.includes(id)) &&
    proposal.terms.serviceCategoryIds.every(id => policy.policy.categories.some(category => category.id === id));
}
/** Private sidecar for a NEW create/revise result. It is not a public proposal field.
 * The loader must resolve the existing pin for this exact proposal. The repository
 * must enforce its creation uniqueness atomically with the producing receipt; replay
 * recovers that original pin and never invokes this constructor to replace it. */
export async function bindSupplierRelationshipScopePolicy(proposalInput: unknown, receiptInput: unknown, policyInput: unknown, factsInput: unknown, existingBindingInput: unknown, now: string) {
  const proposal = immutable(SupplierRelationshipProposalSchema.parse(proposalInput));
  const producingReceipt = immutable(SupplierRelationshipReceiptSchema.parse(receiptInput));
  const policy = policyInput === null ? null : immutable(SupplierScopePolicySnapshotSchema.parse(policyInput));
  const facts = immutable(readFactsSchema.parse(factsInput));
  const existing = existingBindingInput === null ? null : immutable(SupplierRelationshipPolicyBindingSchema.parse(existingBindingInput));
  const at = ms(InstantSchema.parse(now));
  if (existing !== null) fail('SUPPLIER_SCOPE_POLICY_BINDING_EXISTS', 409, 'An existing proposal policy pin cannot be replaced or renewed.');
  const hash = await proposalDigest(proposal);
  if (!await currentScope(policy, facts, proposal, at) || policy === null || ms(proposal.createdAt) !== at ||
    producingReceipt.recordedAt !== proposal.createdAt || producingReceipt.identity.actorId !== proposal.createdBy.actorId ||
    producingReceipt.identity.organizationId !== proposal.createdBy.organizationId) {
    fail('SUPPLIER_SCOPE_POLICY_NOT_CURRENT', 409, 'A fresh relationship revision must bind a current policy and its exact producing receipt.');
  }
  return immutable(SupplierRelationshipPolicyBindingSchema.parse({
    schemaVersion: 1, scope: proposal.scope, proposal: { id: proposal.scope.supplierRelationshipId, version: proposal.version, hash },
    policy: reference(policy), producingReceipt,
  }));
}
/** Additional scope prerequisite only; caller still needs relationship administration,
 * current bilateral approvals and every business/financial authorization gate. */
export async function assessSupplierRelationshipScopePolicy(bindingInput: unknown, proposalInput: unknown, policyInput: unknown, factsInput: unknown, now: string) {
  const binding = bindingInput === null ? null : immutable(SupplierRelationshipPolicyBindingSchema.parse(bindingInput));
  const proposal = immutable(SupplierRelationshipProposalSchema.parse(proposalInput));
  const policy = policyInput === null ? null : immutable(SupplierScopePolicySnapshotSchema.parse(policyInput));
  const facts = immutable(readFactsSchema.parse(factsInput));
  const at = ms(InstantSchema.parse(now));
  const hash = await proposalDigest(proposal);
  const current = await currentScope(policy, facts, proposal, at);
  const satisfied = current && policy !== null && binding !== null && same(binding.policy, reference(policy)) &&
    supplierScopesMatch(binding.scope, proposal.scope) && same(binding.proposal, { id: proposal.scope.supplierRelationshipId, version: proposal.version, hash }) &&
    binding.producingReceipt.recordedAt === proposal.createdAt &&
    binding.producingReceipt.identity.actorId === proposal.createdBy.actorId && binding.producingReceipt.identity.organizationId === proposal.createdBy.organizationId;
  return immutable({ kind: 'SCOPE_POLICY_PREREQUISITE_ONLY' as const, ...limitations,
    relationshipGate: satisfied ? 'SATISFIED' as const : 'BLOCKED' as const, gateReason: satisfied ? null : 'SCOPE_NOT_CURRENT' as const });
}
/** Preserve history/status/expiry precedence, then check scope before approvals.
 * Composition can only block; it never restores relationship or approval authority. */
export async function applySupplierRelationshipScopePolicy(projectionInput: unknown, bindingInput: unknown, proposalInput: unknown, policyInput: unknown, factsInput: unknown, now: string) {
  const projection = immutable(SupplierRelationshipProjectionSchema.parse(projectionInput));
  const binding = bindingInput === null ? null : immutable(SupplierRelationshipPolicyBindingSchema.parse(bindingInput));
  const proposal = immutable(SupplierRelationshipProposalSchema.parse(proposalInput));
  const policy = policyInput === null ? null : immutable(SupplierScopePolicySnapshotSchema.parse(policyInput));
  const facts = immutable(readFactsSchema.parse(factsInput));
  const acceptedNow = InstantSchema.parse(now);
  const hash = await proposalDigest(proposal);
  if (!supplierScopesMatch(projection.scope, proposal.scope) || !same(projection.proposal, { id: proposal.scope.supplierRelationshipId, version: proposal.version, hash })) {
    fail('SUPPLIER_SCOPE_POLICY_BINDING_CONFLICT', 409, 'The public projection must identify this exact proposal.');
  }
  const scope = await assessSupplierRelationshipScopePolicy(binding, proposal, policy, facts, acceptedNow);
  const scopePrecedes = projection.relationshipGate === 'SATISFIED' || projection.gateReason === 'APPROVAL_NOT_CURRENT';
  return immutable(SupplierRelationshipProjectionSchema.parse(scopePrecedes && scope.relationshipGate === 'BLOCKED' ?
    { ...projection, relationshipGate: 'BLOCKED', gateReason: 'SCOPE_NOT_CURRENT' } : projection));
}
