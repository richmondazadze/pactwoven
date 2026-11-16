import { z } from 'zod';
import {
  ActorContextSchema, EnvironmentSchema, IdSchema, InstantSchema, RoleSchema, SupplierScopeSchema,
  SupplierRelationshipHeadSchema, SupplierRelationshipMutationSchema, SupplierRelationshipProjectionSchema,
  SupplierRelationshipProposalSchema, SupplierRelationshipReceiptSchema, SupplierRelationshipSnapshotSchema,
  supplierScopesMatch, type SupplierRelationshipApproval, type SupplierRelationshipHead,
  type SupplierRelationshipProposal, type SupplierRelationshipSnapshot,
} from '@pactwoven/contracts';
import { canonicalJson, commandDigest } from './canonical.js';
import { DomainError } from './errors.js';
import { immutable, nextVersion } from './financial-primitives.js';

const version = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const epoch = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const ids = z.array(IdSchema).max(100).refine(values => new Set(values).size === values.length);
const membershipSchema = z.strictObject({
  id: IdSchema, actorId: IdSchema, principalKind: z.enum(['human', 'service']), organizationId: IdSchema, environment: EnvironmentSchema,
  version, organizationEpoch: epoch, status: z.enum(['ACTIVE', 'SUSPENDED', 'REVOKED']),
  roles: z.array(RoleSchema).min(1).max(9).refine(values => new Set(values).size === values.length),
  validFrom: InstantSchema, expiresAt: InstantSchema,
});
const organizationSchema = z.strictObject({
  id: IdSchema, environment: EnvironmentSchema, version, authorityEpoch: epoch,
  status: z.enum(['ACTIVE', 'SUSPENDED', 'REVOKED']), validFrom: InstantSchema, expiresAt: InstantSchema,
});
// PRIVATE RESOLVER INPUT CONTRACT, not a public authorization constructor. This schema checks
// shape only. A future server must authenticate the session and load/fence these facts itself.
// Never deserialize facts from a request, model output or supplier message. All results below
// remain pure proposals/assessments, with authentication and persistence not established.
const resolverFactsSchema = z.strictObject({
  schemaVersion: z.literal(1), scope: SupplierScopeSchema, observedAt: InstantSchema, expiresAt: InstantSchema,
  actor: ActorContextSchema, membership: membershipSchema,
  session: z.strictObject({
    id: z.string().min(1).max(256), actorId: IdSchema, organizationId: IdSchema, environment: EnvironmentSchema, authenticatedAt: InstantSchema,
    membershipId: IdSchema, membershipVersion: version, organizationVersion: version, organizationEpoch: epoch,
    status: z.enum(['ACTIVE', 'REVOKED']), expiresAt: InstantSchema,
  }),
  organizations: z.strictObject({ buyer: organizationSchema, supplier: organizationSchema }),
  approvalMemberships: z.array(membershipSchema).max(2), head: SupplierRelationshipHeadSchema.nullable(),
  participation: z.strictObject({
    scope: SupplierScopeSchema, membershipId: IdSchema, membershipVersion: version, organizationEpoch: epoch,
    fromRevision: version, throughRevision: version, validFrom: InstantSchema, expiresAt: InstantSchema,
  }).nullable(),
  policy: z.strictObject({ maximumAuthenticationAgeMs: z.number().int().min(1).max(900_000), buyerSiteIds: ids, serviceCategoryIds: ids }),
});
type Facts = z.infer<typeof resolverFactsSchema>;
type Party = 'buyer' | 'supplier';
const equal = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
const ms = (value: string) => Date.parse(value);
function fail(code: string, status: 403 | 409 | 422, message: string): never { throw new DomainError(code, status, message); }
const currentInterval = (value: { validFrom: string; expiresAt: string }, at: number) => ms(value.validFrom) <= at && at < ms(value.expiresAt);
const activeOrganization = (facts: Facts, party: Party, at: number) => facts.organizations[party].status === 'ACTIVE' && currentInterval(facts.organizations[party], at);
const adminRole = (party: Party) => party === 'buyer' ? 'owner' : 'supplier_admin';
const stamp = (facts: Facts) => ({ actorId: facts.actor.actorId, organizationId: facts.actor.organizationId,
  membershipId: facts.membership.id, membershipVersion: facts.membership.version, organizationEpoch: facts.membership.organizationEpoch,
  organizationVersion: facts.actor.organizationId === facts.scope.buyerOrganizationId ? facts.organizations.buyer.version : facts.organizations.supplier.version });
const reference = (state: SupplierRelationshipSnapshot) => ({ id: state.proposal.scope.supplierRelationshipId, version: state.proposal.version, hash: state.proposalHash });
const head = (state: SupplierRelationshipSnapshot): SupplierRelationshipHead => ({ scope: state.proposal.scope, revision: state.revision, proposal: reference(state), status: state.status });
const digestProposal = (proposal: SupplierRelationshipProposal) => commandDigest({ namespace: 'pactwoven/supplier-relationship-proposal/v1', proposal });
const scopePermitted = (terms: SupplierRelationshipProposal['terms'], facts: Facts) => terms.buyerSiteIds.every(id => facts.policy.buyerSiteIds.includes(id)) &&
  terms.serviceCategoryIds.every(id => facts.policy.serviceCategoryIds.includes(id));

/** Digesting exact proposal bytes is not authentication or administrative acceptance. */
export async function supplierRelationshipProposalDigest(input: unknown): Promise<string> {
  return digestProposal(immutable(SupplierRelationshipProposalSchema.parse(input)));
}

function validateFacts(facts: Facts, at: number): Party {
  const actor = facts.actor;
  const member = facts.membership;
  const session = facts.session;
  const party = actor.organizationId === facts.scope.buyerOrganizationId ? 'buyer' : actor.organizationId === facts.scope.supplierOrganizationId ? 'supplier' : null;
  if (party === null || actor.principalKind !== 'human' || actor.environment !== facts.scope.environment ||
      ms(facts.observedAt) > at || ms(facts.expiresAt) <= at || ms(facts.expiresAt) - ms(facts.observedAt) > 30_000 || ms(actor.authenticatedAt) > at ||
      member.actorId !== actor.actorId || member.principalKind !== actor.principalKind || member.organizationId !== actor.organizationId || member.environment !== actor.environment ||
      member.status !== 'ACTIVE' || !currentInterval(member, at) || !equal([...member.roles].sort(), [...actor.roles].sort()) ||
      session.id !== actor.sessionId || session.actorId !== actor.actorId || session.organizationId !== actor.organizationId ||
      session.environment !== actor.environment || session.authenticatedAt !== actor.authenticatedAt ||
      session.status !== 'ACTIVE' || ms(session.expiresAt) <= at || session.membershipId !== member.id ||
      session.membershipVersion !== member.version || session.organizationEpoch !== member.organizationEpoch) {
    fail('SUPPLIER_RELATIONSHIP_ACCESS_DENIED', 403, 'Current scoped human membership and session facts are required.');
  }
  for (const side of ['buyer', 'supplier'] as const) {
    const organization = facts.organizations[side];
    if (organization.id !== (side === 'buyer' ? facts.scope.buyerOrganizationId : facts.scope.supplierOrganizationId) || organization.environment !== facts.scope.environment) {
      fail('SUPPLIER_RELATIONSHIP_ACCESS_DENIED', 403, 'Organization facts do not match this relationship.');
    }
  }
  if (!activeOrganization(facts, party, at) || facts.organizations[party].authorityEpoch !== member.organizationEpoch || facts.organizations[party].version !== session.organizationVersion ||
      (facts.head !== null && !supplierScopesMatch(facts.head.scope, facts.scope))) {
    fail('SUPPLIER_RELATIONSHIP_ACCESS_DENIED', 403, 'Organization or relationship context is no longer current.');
  }
  const membershipKeys = facts.approvalMemberships.map(value => `${value.environment}/${value.organizationId}/${value.id}`);
  if (new Set(membershipKeys).size !== membershipKeys.length) fail('SUPPLIER_RELATIONSHIP_FACT_CONFLICT', 409, 'Approval membership resolution is ambiguous.');
  // Two resolutions of the same membership must not disagree during one evaluation.
  const own = facts.approvalMemberships.find(value => value.environment === member.environment && value.organizationId === member.organizationId && value.id === member.id);
  if (own && !equal(own, member)) fail('SUPPLIER_RELATIONSHIP_FACT_CONFLICT', 409, 'Current membership facts disagree.');
  return party;
}

function requireAdministrator(facts: Facts, party: Party, at: number): void {
  if (!facts.membership.roles.includes(adminRole(party))) fail('SUPPLIER_RELATIONSHIP_ACCESS_DENIED', 403, 'Only a party administrator may manage that party.');
  if (at - ms(facts.actor.authenticatedAt) > facts.policy.maximumAuthenticationAgeMs) fail('SUPPLIER_RELATIONSHIP_FRESH_AUTH_REQUIRED', 403, 'Relationship changes require fresh server-verified authentication.');
}

function approvalCurrent(approval: SupplierRelationshipApproval | null, facts: Facts, party: Party, at: number): boolean {
  if (approval === null || !activeOrganization(facts, party, at) || ms(approval.approvedAt) > at || ms(approval.expiresAt) <= at) return false;
  const member = facts.approvalMemberships.find(value => value.id === approval.membershipId && value.organizationId === approval.organizationId && value.environment === facts.scope.environment);
  return member !== undefined && member.principalKind === 'human' && member.status === 'ACTIVE' && currentInterval(member, at) && ms(member.validFrom) <= ms(approval.approvedAt) &&
    member.actorId === approval.actorId && member.version === approval.membershipVersion && member.organizationEpoch === approval.organizationEpoch &&
    member.organizationEpoch === facts.organizations[party].authorityEpoch && approval.organizationVersion === facts.organizations[party].version && member.roles.includes(adminRole(party));
}

function requireRead(facts: Facts, party: Party, revision: number, at: number): void {
  if (facts.membership.roles.includes(adminRole(party))) return;
  const roles = party === 'buyer' ? ['operations', 'finance', 'receiver', 'auditor'] : ['supplier_dispatcher', 'auditor'];
  const grant = facts.participation;
  if (!facts.membership.roles.some(role => roles.includes(role)) || grant === null || !supplierScopesMatch(grant.scope, facts.scope) ||
      grant.membershipId !== facts.membership.id || grant.membershipVersion !== facts.membership.version ||
      grant.organizationEpoch !== facts.membership.organizationEpoch || !currentInterval(grant, at) ||
      revision < grant.fromRevision || revision > grant.throughRevision) {
    fail('SUPPLIER_RELATIONSHIP_ACCESS_DENIED', 403, 'A current explicit relationship participation grant is required.');
  }
}

/** Status/history visibility and the relationship prerequisite are distinct from effect authority. */
export async function projectSupplierRelationship(input: unknown, factsInput: unknown, now: string) {
  const state = immutable(SupplierRelationshipSnapshotSchema.parse(input));
  const facts = immutable(resolverFactsSchema.parse(factsInput));
  const at = ms(InstantSchema.parse(now));
  const party = validateFacts(facts, at);
  requireRead(facts, party, state.revision, at);
  if (!supplierScopesMatch(state.proposal.scope, facts.scope) || facts.head === null || state.revision > facts.head.revision ||
      ms(state.updatedAt) > at || (state.revision === facts.head.revision && !equal(head(state), facts.head))) {
    fail('SUPPLIER_RELATIONSHIP_VERSION_CONFLICT', 409, 'The requested record does not match resolved relationship history.');
  }
  if (state.proposalHash !== await digestProposal(state.proposal)) fail('SUPPLIER_RELATIONSHIP_HASH_CONFLICT', 409, 'Proposal content does not match its immutable hash.');
  const current = state.revision === facts.head.revision;
  const reason = !current ? 'NOT_CURRENT_REVISION' : state.status !== 'ACTIVE' ? 'NOT_ACTIVE' : ms(state.proposal.terms.expiresAt) <= at ? 'PROPOSAL_EXPIRED' :
    !scopePermitted(state.proposal.terms, facts) ? 'SCOPE_NOT_CURRENT' :
    !approvalCurrent(state.approvals.buyer, facts, 'buyer', at) || !approvalCurrent(state.approvals.supplier, facts, 'supplier', at) ? 'APPROVAL_NOT_CURRENT' : null;
  return immutable(SupplierRelationshipProjectionSchema.parse({
    kind: 'RELATIONSHIP_STATUS_ONLY', ...head(state), expiresAt: state.proposal.terms.expiresAt, viewerParty: party, current,
    approvalsRecorded: { buyer: state.approvals.buyer !== null, supplier: state.approvals.supplier !== null },
    relationshipGate: reason === null ? 'SATISFIED' : 'BLOCKED', gateReason: reason,
    authentication: 'NOT_ESTABLISHED', businessVerification: 'NOT_ESTABLISHED', payeeVerification: 'NOT_ESTABLISHED',
    bookingAuthority: false, contractualAcceptance: false, paymentAuthority: false,
  }));
}

/** Pure mutation plan. The future private server must revalidate/fence all facts and atomically
 * persist the next revision plus receipt with creation uniqueness. Returning this object does
 * not authenticate anyone, persist a relationship, communicate, book or accept an agreement.
 * Commit must fence the head revision/proposal, organization versions/epochs/status, acting and
 * approving membership versions/roles/status/expiry, verified session and current scope policy.
 * Even a well-formed resolver snapshot younger than 30 seconds is not authenticated authority. */
export async function planSupplierRelationshipMutation(input: unknown, factsInput: unknown, currentInput: unknown, receiptInput: unknown, now: string) {
  // Snapshot every caller-owned value before any digest awaits, including original receipts.
  const request = immutable(SupplierRelationshipMutationSchema.parse(input));
  const facts = immutable(resolverFactsSchema.parse(factsInput));
  const current = currentInput === null ? null : immutable(SupplierRelationshipSnapshotSchema.parse(currentInput));
  const stored = receiptInput === null ? null : immutable(SupplierRelationshipReceiptSchema.parse(receiptInput));
  const at = ms(InstantSchema.parse(now));
  const party = validateFacts(facts, at);
  requireAdministrator(facts, party, at);
  const command = request.command;
  if (!supplierScopesMatch(command.scope, facts.scope) || command.authorityEpoch !== facts.membership.organizationEpoch) fail('SUPPLIER_RELATIONSHIP_ACCESS_DENIED', 403, 'The command does not match the current acting party scope.');
  if (current === null ? facts.head !== null : facts.head === null || !equal(head(current), facts.head) || ms(current.updatedAt) > at) fail('SUPPLIER_RELATIONSHIP_VERSION_CONFLICT', 409, 'Load the exact current relationship before mutation.');
  if (current !== null && current.proposalHash !== await digestProposal(current.proposal)) fail('SUPPLIER_RELATIONSHIP_HASH_CONFLICT', 409, 'Proposal content does not match its immutable hash.');
  const identity = { scope: facts.scope, actorId: facts.actor.actorId, organizationId: facts.actor.organizationId, idempotencyKey: request.idempotencyKey };
  const digest = await commandDigest({ namespace: 'pactwoven/supplier-relationship-command/v1', identity, command });
  const limitations = { authentication: 'NOT_ESTABLISHED' as const, persistence: 'NOT_ESTABLISHED' as const,
    businessVerification: 'NOT_ESTABLISHED' as const, payeeVerification: 'NOT_ESTABLISHED' as const,
    bookingAuthority: false as const, contractualAcceptance: false as const, paymentAuthority: false as const };
  if (stored !== null) {
    if (!equal(stored.identity, identity)) fail('SUPPLIER_RELATIONSHIP_RECEIPT_SCOPE_CONFLICT', 409, 'The receipt belongs to another original command identity.');
    if (stored.commandDigest !== digest) fail('IDEMPOTENCY_CONFLICT', 409, 'This idempotency key was used with different command content.');
    const action = command.payload.action;
    const originalProposalMatches = action === 'create' ? stored.result.proposal.version === 1 : action === 'revise' ?
      stored.result.proposal.version === (command.targetProposal?.version ?? 0) + 1 : equal(stored.result.proposal, command.targetProposal);
    const originalStatusMatches = action === 'create' || action === 'revise' ? stored.result.status === 'PROPOSED' :
      action === 'approve' ? stored.result.status === 'PROPOSED' || stored.result.status === 'ACTIVE' :
      stored.result.status === (action === 'suspend' ? 'SUSPENDED' : 'REVOKED');
    if (current === null || !originalProposalMatches || !originalStatusMatches || stored.result.revision !== command.expectedVersion + 1 || stored.result.revision > current.revision ||
        (stored.result.proposal.version === current.proposal.version && !equal(stored.result.proposal, reference(current))) ||
        ms(stored.recordedAt) > ms(current.updatedAt) || (stored.result.revision === current.revision &&
          (!equal(stored.result, head(current)) || stored.recordedAt !== current.updatedAt))) {
      fail('SUPPLIER_RELATIONSHIP_RECEIPT_CONFLICT', 409, 'The original receipt is inconsistent with current durable history.');
    }
    // Never return an old ACTIVE snapshot as a next state or restore authority on replay.
    return immutable({ kind: 'EXACT_REPLAY' as const, ...limitations, originalReceipt: stored, current: head(current) });
  }
  if (current === null ? command.payload.action !== 'create' : command.payload.action === 'create' || command.expectedVersion !== current.revision || !equal(command.targetProposal, reference(current))) {
    fail('SUPPLIER_RELATIONSHIP_VERSION_CONFLICT', 409, 'Both aggregate revision and proposal reference must match.');
  }
  if (current?.status === 'REVOKED') fail('SUPPLIER_RELATIONSHIP_REVOKED', 409, 'Revocation is terminal for this relationship identity.');
  const action = command.payload.action;
  if ((action === 'create' || action === 'revise' || action === 'approve') && (!activeOrganization(facts, 'buyer', at) || !activeOrganization(facts, 'supplier', at))) {
    fail('SUPPLIER_RELATIONSHIP_ORGANIZATION_INACTIVE', 409, 'Both organizations must be current and active before extending approval.');
  }
  const administrator = stamp(facts);
  const revision = nextVersion(current?.revision ?? 0);
  let next: SupplierRelationshipSnapshot;
  if (command.payload.action === 'create' || command.payload.action === 'revise') {
    const terms = command.payload.terms;
    if (ms(terms.expiresAt) <= at || !scopePermitted(terms, facts)) fail('SUPPLIER_RELATIONSHIP_SCOPE_INVALID', 422, 'A current explicit site/category scope is required.');
    const proposal = immutable(SupplierRelationshipProposalSchema.parse({ schemaVersion: 1, scope: facts.scope,
      version: nextVersion(current?.proposal.version ?? 0), previousVersionHash: current?.proposalHash ?? null,
      terms, createdBy: administrator, createdAt: now }));
    next = { schemaVersion: 1, revision, proposal, proposalHash: await digestProposal(proposal), status: 'PROPOSED',
      approvals: { buyer: null, supplier: null }, changedBy: administrator, updatedAt: now };
  } else {
    if (current === null) fail('SUPPLIER_RELATIONSHIP_VERSION_CONFLICT', 409, 'An existing relationship is required.');
    if (command.payload.action === 'approve') {
      if (current.status !== 'PROPOSED') fail('SUPPLIER_RELATIONSHIP_NOT_PROPOSED', 409, 'Only a current proposal can be approved; a suspension requires a new proposal.');
      if (!scopePermitted(current.proposal.terms, facts)) fail('SUPPLIER_RELATIONSHIP_SCOPE_INVALID', 422, 'The proposal scope is no longer permitted.');
      if (current.approvals[party] !== null) fail('SUPPLIER_RELATIONSHIP_ALREADY_APPROVED', 409, 'This party already approved; revise to renew approvals.');
      const otherParty = party === 'buyer' ? 'supplier' : 'buyer';
      if (current.approvals[otherParty] !== null && !approvalCurrent(current.approvals[otherParty], facts, otherParty, at)) fail('SUPPLIER_RELATIONSHIP_APPROVAL_STALE', 409, 'The other approval is no longer current; revise and obtain both approvals again.');
      if (ms(current.proposal.terms.expiresAt) <= at || ms(command.payload.expiresAt) <= at ||
          ms(command.payload.expiresAt) > Math.min(ms(current.proposal.terms.expiresAt), ms(facts.membership.expiresAt), ms(facts.organizations[party].expiresAt))) {
        fail('SUPPLIER_RELATIONSHIP_APPROVAL_EXPIRY_INVALID', 422, 'Approval must fit the current proposal and administrative validity interval.');
      }
      const approval = { ...administrator, party, proposal: reference(current), approvedAt: now, expiresAt: command.payload.expiresAt };
      const approvals = { ...current.approvals, [party]: approval };
      next = { ...current, revision, status: approvals.buyer !== null && approvals.supplier !== null ? 'ACTIVE' : 'PROPOSED', approvals, changedBy: administrator, updatedAt: now };
    } else {
      if (command.payload.action === 'suspend' && current.status === 'SUSPENDED') fail('SUPPLIER_RELATIONSHIP_ALREADY_SUSPENDED', 409, 'This relationship is already suspended.');
      next = { ...current, revision, status: command.payload.action === 'suspend' ? 'SUSPENDED' : 'REVOKED',
        approvals: { buyer: null, supplier: null }, changedBy: administrator, updatedAt: now };
    }
  }
  const snapshot = immutable(SupplierRelationshipSnapshotSchema.parse(next));
  const receipt = immutable(SupplierRelationshipReceiptSchema.parse({ identity, commandDigest: digest, result: head(snapshot), recordedAt: now }));
  return immutable({ kind: 'PROPOSED_TRANSITION' as const, ...limitations, next: snapshot, receipt });
}
