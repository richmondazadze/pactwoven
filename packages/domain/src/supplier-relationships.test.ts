import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Role, SupplierRelationshipCommand, SupplierRelationshipSnapshot } from '@pactwoven/contracts';
import { commandDigest } from './canonical.js';
import { planSupplierRelationshipMutation, projectSupplierRelationship, supplierRelationshipProposalDigest } from './supplier-relationships.js';

type Party = 'buyer' | 'supplier';
const now = '2026-11-15T10:00:00Z';
const expiry = '2026-11-15T12:00:00Z';
const approvalExpiry = '2026-11-15T11:00:00Z';
const scope = { environment: 'simulation' as const, buyerOrganizationId: 'buyer', supplierOrganizationId: 'supplier', supplierRelationshipId: 'relationship' };
const terms = () => ({ buyerSiteIds: ['site_one'], serviceCategoryIds: ['logistics'], expiresAt: expiry });
const member = (party: Party, role?: Role) => ({
  id: `${party}_${role ?? 'admin'}_membership`, actorId: `${party}_${role ?? 'admin'}`, principalKind: 'human' as const, organizationId: party, environment: 'simulation' as const,
  version: 1, organizationEpoch: 0, status: 'ACTIVE' as const, roles: [role ?? (party === 'buyer' ? 'owner' : 'supplier_admin')] as Role[],
  validFrom: '2026-11-15T09:00:00Z', expiresAt: expiry,
});
const organization = (party: Party) => ({ id: party, environment: 'simulation' as const, version: 1, authorityEpoch: 0,
  status: 'ACTIVE' as const, validFrom: '2026-11-15T09:00:00Z', expiresAt: expiry });
const reference = (state: SupplierRelationshipSnapshot) => ({ id: state.proposal.scope.supplierRelationshipId, version: state.proposal.version, hash: state.proposalHash });
const head = (state: SupplierRelationshipSnapshot) => ({ scope: state.proposal.scope, revision: state.revision, proposal: reference(state), status: state.status });
const facts = (state: SupplierRelationshipSnapshot | null, party: Party = 'buyer', role?: Role) => {
  const membership = member(party, role);
  return {
    schemaVersion: 1, scope: { ...scope }, observedAt: now, expiresAt: '2026-11-15T10:00:30Z',
    actor: { actorId: membership.actorId, principalKind: 'human', organizationId: party, environment: 'simulation', roles: [...membership.roles],
      siteIds: ['site_one'], actionSiteIds: ['site_one'], sessionId: `${party}_session`, authenticatedAt: '2026-11-15T09:59:00Z', correlationId: 'test_correlation' },
    membership, session: { id: `${party}_session`, actorId: membership.actorId, organizationId: party, environment: 'simulation', authenticatedAt: '2026-11-15T09:59:00Z',
      membershipId: membership.id, membershipVersion: 1, organizationVersion: 1, organizationEpoch: 0, status: 'ACTIVE', expiresAt: expiry },
    organizations: { buyer: organization('buyer'), supplier: organization('supplier') },
    approvalMemberships: [member('buyer'), member('supplier')], head: state === null ? null : head(state),
    participation: { scope: { ...scope }, membershipId: membership.id, membershipVersion: 1, organizationEpoch: 0,
      fromRevision: 1, throughRevision: Number.MAX_SAFE_INTEGER, validFrom: '2026-11-15T09:00:00Z', expiresAt: expiry },
    policy: { maximumAuthenticationAgeMs: 300_000, buyerSiteIds: ['site_one', 'site_two'], serviceCategoryIds: ['logistics', 'storage'] },
  };
};
const request = (state: SupplierRelationshipSnapshot | null, payload: SupplierRelationshipCommand['payload'], party: Party = 'buyer', key?: string) => ({
  idempotencyKey: key ?? `${party}_${payload.action}_${state?.revision ?? 0}_request`,
  command: { scope: { ...scope }, expectedVersion: state?.revision ?? 0, mandateVersion: null, authorityEpoch: 0,
    targetProposal: state === null ? null : reference(state), payload },
});
async function transition(state: SupplierRelationshipSnapshot | null, payload: SupplierRelationshipCommand['payload'], party: Party = 'buyer') {
  const result = await planSupplierRelationshipMutation(request(state, payload, party), facts(state, party), state, null, now);
  if (result.kind !== 'PROPOSED_TRANSITION') throw new Error('Fixture expected a new pure transition.');
  return result;
}
async function active() {
  const created = await transition(null, { action: 'create', terms: terms() });
  const buyer = await transition(created.next, { action: 'approve', expiresAt: approvalExpiry });
  return transition(buyer.next, { action: 'approve', expiresAt: approvalExpiry }, 'supplier');
}
afterEach(() => vi.restoreAllMocks());

describe('versioned supplier relationship lifecycle', () => {
  it.each(['buyer', 'supplier'] as const)('requires two separate exact approvals when %s proposes', async party => {
    const created = await transition(null, { action: 'create', terms: terms() }, party);
    expect(created.next).toMatchObject({ revision: 1, proposal: { version: 1 }, status: 'PROPOSED', approvals: { buyer: null, supplier: null } });
    const first = await transition(created.next, { action: 'approve', expiresAt: approvalExpiry }, party);
    expect(first.next.status).toBe('PROPOSED');
    const second = await transition(first.next, { action: 'approve', expiresAt: approvalExpiry }, party === 'buyer' ? 'supplier' : 'buyer');
    expect(second.next).toMatchObject({ revision: 3, proposal: { version: 1 }, status: 'ACTIVE' });
    expect(second.next.approvals.buyer?.proposal).toEqual(reference(second.next));
    expect(second.next.approvals.supplier?.proposal).toEqual(reference(second.next));
    expect(second).toMatchObject({ authentication: 'NOT_ESTABLISHED', persistence: 'NOT_ESTABLISHED', bookingAuthority: false, contractualAcceptance: false, paymentAuthority: false });
  });
  it('invalidates earlier approvals whenever scope is revised', async () => {
    const prior = (await active()).next;
    const revised = await transition(prior, { action: 'revise', terms: { ...terms(), buyerSiteIds: ['site_two'] } }, 'supplier');
    expect(revised.next).toMatchObject({ revision: 4, proposal: { version: 2, previousVersionHash: prior.proposalHash }, status: 'PROPOSED', approvals: { buyer: null, supplier: null } });
    expect(prior.status).toBe('ACTIVE');
    expect(prior.proposal.terms.buyerSiteIds).toEqual(['site_one']);
    const stale = request(revised.next, { action: 'approve', expiresAt: approvalExpiry });
    stale.command.targetProposal = reference(prior);
    await expect(planSupplierRelationshipMutation(stale, facts(revised.next), revised.next, null, now)).rejects.toMatchObject({ code: 'SUPPLIER_RELATIONSHIP_VERSION_CONFLICT' });
  });
  it.each(['buyer', 'supplier'] as const)('allows %s to suspend, but requires a fresh proposal and both approvals to reopen', async party => {
    const original = (await active()).next;
    const suspended = (await transition(original, { action: 'suspend' }, party)).next;
    expect(suspended).toMatchObject({ revision: 4, status: 'SUSPENDED', approvals: { buyer: null, supplier: null } });
    await expect(transition(suspended, { action: 'approve', expiresAt: approvalExpiry }, party)).rejects.toMatchObject({ code: 'SUPPLIER_RELATIONSHIP_NOT_PROPOSED' });
    const revised = (await transition(suspended, { action: 'revise', terms: terms() }, party)).next;
    const first = (await transition(revised, { action: 'approve', expiresAt: approvalExpiry }, party)).next;
    expect(first.status).toBe('PROPOSED');
    expect((await transition(first, { action: 'approve', expiresAt: approvalExpiry }, party === 'buyer' ? 'supplier' : 'buyer')).next.status).toBe('ACTIVE');
  });
  it('makes revocation terminal and rejects duplicate approval with a different key', async () => {
    const created = (await transition(null, { action: 'create', terms: terms() })).next;
    const approved = (await transition(created, { action: 'approve', expiresAt: approvalExpiry })).next;
    await expect(transition(approved, { action: 'approve', expiresAt: approvalExpiry })).rejects.toMatchObject({ code: 'SUPPLIER_RELATIONSHIP_ALREADY_APPROVED' });
    const revoked = (await transition(approved, { action: 'revoke' }, 'supplier')).next;
    for (const payload of [{ action: 'revise', terms: terms() }, { action: 'approve', expiresAt: approvalExpiry }, { action: 'suspend' }] as const) {
      await expect(transition(revoked, payload)).rejects.toMatchObject({ code: 'SUPPLIER_RELATIONSHIP_REVOKED' });
    }
  });
  it('rejects creation identity collision, stale aggregate revision and changed scope bytes', async () => {
    const state = (await active()).next;
    await expect(planSupplierRelationshipMutation(request(null, { action: 'create', terms: terms() }), facts(state), state, null, now)).rejects.toMatchObject({ code: 'SUPPLIER_RELATIONSHIP_VERSION_CONFLICT' });
    const stale = request(state, { action: 'suspend' });
    stale.command.expectedVersion--;
    await expect(planSupplierRelationshipMutation(stale, facts(state), state, null, now)).rejects.toMatchObject({ code: 'SUPPLIER_RELATIONSHIP_VERSION_CONFLICT' });
    const changed = structuredClone(state);
    changed.proposal.terms.buyerSiteIds = ['site_two'];
    await expect(planSupplierRelationshipMutation(request(changed, { action: 'suspend' }), facts(changed), changed, null, now)).rejects.toMatchObject({ code: 'SUPPLIER_RELATIONSHIP_HASH_CONFLICT' });
  });
  it('rejects unauthorized scope and out-of-bounds approval expiry', async () => {
    for (const proposed of [{ ...terms(), buyerSiteIds: ['unknown'] }, { ...terms(), serviceCategoryIds: ['unknown'] }, { ...terms(), expiresAt: now }]) {
      await expect(transition(null, { action: 'create', terms: proposed })).rejects.toMatchObject({ code: 'SUPPLIER_RELATIONSHIP_SCOPE_INVALID' });
    }
    const state = (await transition(null, { action: 'create', terms: terms() })).next;
    for (const expiresAt of [now, '2026-11-16T10:00:00Z']) await expect(transition(state, { action: 'approve', expiresAt })).rejects.toMatchObject({ code: 'SUPPLIER_RELATIONSHIP_APPROVAL_EXPIRY_INVALID' });
  });
});

describe('current private-resolver facts and party-specific authority', () => {
  it.each(['operations', 'finance', 'receiver', 'supplier_dispatcher', 'auditor', 'support', 'service'] as Role[])('does not let %s mutate relationships', async role => {
    const state = (await active()).next;
    await expect(planSupplierRelationshipMutation(request(state, { action: 'revoke' }), facts(state, 'buyer', role), state, null, now)).rejects.toMatchObject({ code: 'SUPPLIER_RELATIONSHIP_ACCESS_DENIED' });
  });
  it('does not exchange buyer and supplier administrative roles or allow service principals', async () => {
    const state = (await active()).next;
    for (const [party, role] of [['buyer', 'supplier_admin'], ['supplier', 'owner']] as const) {
      await expect(planSupplierRelationshipMutation(request(state, { action: 'suspend' }, party), facts(state, party, role), state, null, now)).rejects.toMatchObject({ code: 'SUPPLIER_RELATIONSHIP_ACCESS_DENIED' });
    }
    const context = facts(state);
    context.actor.principalKind = 'service';
    await expect(planSupplierRelationshipMutation(request(state, { action: 'revoke' }), context, state, null, now)).rejects.toMatchObject({ code: 'SUPPLIER_RELATIONSHIP_ACCESS_DENIED' });
  });
  it('rejects stale membership, session, organization, environment and resolution facts', async () => {
    const state = (await active()).next;
    const base = facts(state);
    for (const changed of [
      { ...base, membership: { ...base.membership, status: 'REVOKED' } },
      { ...base, membership: { ...base.membership, version: 2 } },
      { ...base, membership: { ...base.membership, expiresAt: now } },
      { ...base, session: { ...base.session, status: 'REVOKED' } },
      { ...base, session: { ...base.session, id: 'other_session' } },
      { ...base, session: { ...base.session, actorId: 'other_actor' } },
      { ...base, session: { ...base.session, organizationId: 'supplier' } },
      { ...base, session: { ...base.session, expiresAt: now } },
      { ...base, organizations: { ...base.organizations, buyer: { ...base.organizations.buyer, authorityEpoch: 1 } } },
      { ...base, organizations: { ...base.organizations, buyer: { ...base.organizations.buyer, version: 2 } } },
      { ...base, actor: { ...base.actor, environment: 'production' } },
      { ...base, organizations: { ...base.organizations, buyer: { ...base.organizations.buyer, id: 'competitor' } } },
      { ...base, expiresAt: now }, { ...base, observedAt: '2026-11-15T10:00:01Z' }, { ...base, expiresAt: expiry },
    ]) await expect(planSupplierRelationshipMutation(request(state, { action: 'suspend' }), changed, state, null, now)).rejects.toMatchObject({ code: 'SUPPLIER_RELATIONSHIP_ACCESS_DENIED' });
  });
  it('requires fresh authentication and an exact command organization epoch', async () => {
    const state = (await active()).next;
    const context = facts(state);
    context.actor.authenticatedAt = '2026-11-15T09:00:00Z';
    context.session.authenticatedAt = context.actor.authenticatedAt;
    await expect(planSupplierRelationshipMutation(request(state, { action: 'revoke' }), context, state, null, now)).rejects.toMatchObject({ code: 'SUPPLIER_RELATIONSHIP_FRESH_AUTH_REQUIRED' });
    const stale = request(state, { action: 'revoke' });
    stale.command.authorityEpoch = 1;
    await expect(planSupplierRelationshipMutation(stale, facts(state), state, null, now)).rejects.toMatchObject({ code: 'SUPPLIER_RELATIONSHIP_ACCESS_DENIED' });
  });
  it('revalidates the first approver before the second approval activates the relationship', async () => {
    const created = (await transition(null, { action: 'create', terms: terms() })).next;
    const approved = (await transition(created, { action: 'approve', expiresAt: approvalExpiry })).next;
    const context = facts(approved, 'supplier');
    context.approvalMemberships[0]!.version = 2;
    await expect(planSupplierRelationshipMutation(request(approved, { action: 'approve', expiresAt: approvalExpiry }, 'supplier'), context, approved, null, now)).rejects.toMatchObject({ code: 'SUPPLIER_RELATIONSHIP_APPROVAL_STALE' });
  });
  it('allows restriction when the counterparty organization is inactive, without restoring approval', async () => {
    const state = (await active()).next;
    const context = facts(state);
    const inactive = { ...context, organizations: { ...context.organizations, supplier: { ...context.organizations.supplier, status: 'SUSPENDED' } } };
    const restricted = await planSupplierRelationshipMutation(request(state, { action: 'suspend' }), inactive, state, null, now);
    expect(restricted.kind === 'PROPOSED_TRANSITION' && restricted.next.status).toBe('SUSPENDED');
    await expect(planSupplierRelationshipMutation(request(state, { action: 'revise', terms: terms() }), inactive, state, null, now)).rejects.toMatchObject({ code: 'SUPPLIER_RELATIONSHIP_ORGANIZATION_INACTIVE' });
  });
});

describe('minimal participation projection and history', () => {
  it.each(['operations', 'finance', 'receiver', 'auditor'] as Role[])('requires an explicit relationship grant for buyer %s', async role => {
    const state = (await active()).next;
    const context = facts(state, 'buyer', role);
    const projected = await projectSupplierRelationship(state, context, now);
    expect(projected).toMatchObject({ kind: 'RELATIONSHIP_STATUS_ONLY', relationshipGate: 'SATISFIED', paymentAuthority: false, bookingAuthority: false, contractualAcceptance: false });
    expect(Object.keys(projected).sort()).toEqual(['kind', 'scope', 'revision', 'proposal', 'status', 'expiresAt', 'viewerParty', 'current', 'approvalsRecorded', 'relationshipGate', 'gateReason', 'authentication', 'businessVerification', 'payeeVerification', 'bookingAuthority', 'contractualAcceptance', 'paymentAuthority'].sort());
    await expect(projectSupplierRelationship(state, { ...context, participation: null }, now)).rejects.toMatchObject({ code: 'SUPPLIER_RELATIONSHIP_ACCESS_DENIED' });
  });
  it('denies supplier competitors, unrelated relationships, expired grants and unsupported roles', async () => {
    const state = (await active()).next;
    const context = facts(state, 'supplier', 'supplier_dispatcher');
    expect((await projectSupplierRelationship(state, context, now)).viewerParty).toBe('supplier');
    for (const participation of [
      { ...context.participation, scope: { ...scope, buyerOrganizationId: 'other_buyer' } },
      { ...context.participation, scope: { ...scope, supplierRelationshipId: 'other_relationship' } },
      { ...context.participation, membershipVersion: 2 }, { ...context.participation, expiresAt: now },
      { ...context.participation, throughRevision: 2 },
    ]) await expect(projectSupplierRelationship(state, { ...context, participation }, now)).rejects.toMatchObject({ code: 'SUPPLIER_RELATIONSHIP_ACCESS_DENIED' });
    for (const role of ['operations', 'support', 'service'] as Role[]) await expect(projectSupplierRelationship(state, facts(state, 'supplier', role), now)).rejects.toMatchObject({ code: 'SUPPLIER_RELATIONSHIP_ACCESS_DENIED' });
  });
  it('keeps recorded ACTIVE status readable while stale approval facts block new effects', async () => {
    const state = (await active()).next;
    const context = facts(state, 'supplier');
    const buyer = member('buyer');
    for (const invalid of [
      { ...buyer, version: 2 }, { ...buyer, status: 'REVOKED' }, { ...buyer, roles: ['operations'] },
      { ...buyer, principalKind: 'service' },
      { ...buyer, expiresAt: now }, { ...buyer, organizationEpoch: 1 }, { ...buyer, validFrom: '2026-11-15T10:00:01Z' },
    ]) {
      const result = await projectSupplierRelationship(state, { ...context, approvalMemberships: [invalid, member('supplier')] }, now);
      expect(result).toMatchObject({ status: 'ACTIVE', approvalsRecorded: { buyer: true, supplier: true }, relationshipGate: 'BLOCKED', gateReason: 'APPROVAL_NOT_CURRENT', paymentAuthority: false });
    }
    const expiredApproval = await projectSupplierRelationship(state, { ...context, observedAt: approvalExpiry, expiresAt: '2026-11-15T11:00:30Z' }, approvalExpiry);
    expect(expiredApproval.gateReason).toBe('APPROVAL_NOT_CURRENT');
  });
  it('labels a historical ACTIVE version without using it as current authority', async () => {
    const prior = (await active()).next;
    const revoked = (await transition(prior, { action: 'revoke' })).next;
    const projected = await projectSupplierRelationship(prior, facts(revoked, 'supplier', 'supplier_dispatcher'), now);
    expect(projected).toMatchObject({ status: 'ACTIVE', revision: 3, current: false, relationshipGate: 'BLOCKED', gateReason: 'NOT_CURRENT_REVISION' });
    expect((await projectSupplierRelationship(revoked, facts(revoked, 'supplier'), now)).gateReason).toBe('NOT_ACTIVE');
  });
  it('exposes proposal expiry as a blocked prerequisite without hiding history', async () => {
    const created = (await transition(null, { action: 'create', terms: { ...terms(), expiresAt: '2026-11-15T10:30:00Z' } })).next;
    const first = (await transition(created, { action: 'approve', expiresAt: '2026-11-15T10:20:00Z' })).next;
    const state = (await transition(first, { action: 'approve', expiresAt: '2026-11-15T10:20:00Z' }, 'supplier')).next;
    const result = await projectSupplierRelationship(state, { ...facts(state, 'supplier'), observedAt: '2026-11-15T10:30:00Z', expiresAt: '2026-11-15T10:30:30Z' }, '2026-11-15T10:30:00Z');
    expect(result).toMatchObject({ status: 'ACTIVE', relationshipGate: 'BLOCKED', gateReason: 'PROPOSAL_EXPIRED' });
  });
  it('blocks a removed site scope or changed organization version without rewriting approval history', async () => {
    const state = (await active()).next;
    const context = facts(state, 'supplier');
    expect((await projectSupplierRelationship(state, { ...context, policy: { ...context.policy, buyerSiteIds: [] } }, now)).gateReason).toBe('SCOPE_NOT_CURRENT');
    expect((await projectSupplierRelationship(state, { ...context, organizations: { ...context.organizations, buyer: { ...context.organizations.buyer, version: 2 } } }, now)).gateReason).toBe('APPROVAL_NOT_CURRENT');
    const proposed = (await transition(state, { action: 'revise', terms: terms() })).next;
    const denied = facts(proposed);
    denied.policy.buyerSiteIds = [];
    await expect(planSupplierRelationshipMutation(request(proposed, { action: 'approve', expiresAt: approvalExpiry }), denied, proposed, null, now)).rejects.toMatchObject({ code: 'SUPPLIER_RELATIONSHIP_SCOPE_INVALID' });
  });
});

describe('idempotency, proposal digest and mutation isolation', () => {
  it('replays the exact original result after suspension without returning a next state', async () => {
    const approved = await active();
    const originalInput = request({ ...approved.next, revision: 2, status: 'PROPOSED', approvals: { buyer: approved.next.approvals.buyer, supplier: null } }, { action: 'approve', expiresAt: approvalExpiry }, 'supplier');
    const suspended = (await transition(approved.next, { action: 'suspend' })).next;
    const result = await planSupplierRelationshipMutation(originalInput, facts(suspended, 'supplier'), suspended, approved.receipt, now);
    expect(result.kind).toBe('EXACT_REPLAY');
    if (result.kind !== 'EXACT_REPLAY') throw new Error('Expected historical receipt replay.');
    expect(result.originalReceipt).toEqual(approved.receipt);
    expect(result.current).toMatchObject({ revision: 4, status: 'SUSPENDED', proposal: reference(suspended) });
    expect('next' in result).toBe(false);
    expect(result.paymentAuthority).toBe(false);
  });
  it('conflicts on the same key with different content, identity, or fabricated result fences', async () => {
    const created = await transition(null, { action: 'create', terms: terms() });
    const input = request(null, { action: 'create', terms: terms() });
    const changed = structuredClone(input);
    changed.command.payload = { action: 'create', terms: { ...terms(), serviceCategoryIds: ['storage'] } };
    await expect(planSupplierRelationshipMutation(changed, facts(created.next), created.next, created.receipt, now)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(planSupplierRelationshipMutation(input, facts(created.next, 'supplier'), created.next, created.receipt, now)).rejects.toMatchObject({ code: 'SUPPLIER_RELATIONSHIP_RECEIPT_SCOPE_CONFLICT' });
    await expect(planSupplierRelationshipMutation(input, facts(created.next), created.next, { ...created.receipt, result: { ...created.receipt.result, status: 'ACTIVE' } }, now)).rejects.toMatchObject({ code: 'SUPPLIER_RELATIONSHIP_RECEIPT_CONFLICT' });
  });
  it.each(['create', 'revise'] as const)('rejects a changed %s receipt proposal hash after a later approval', async action => {
    const prior = action === 'create' ? null : (await transition(null, { action: 'create', terms: terms() })).next;
    const payload: SupplierRelationshipCommand['payload'] = action === 'create'
      ? { action: 'create', terms: terms() }
      : { action: 'revise', terms: { ...terms(), buyerSiteIds: ['site_two'] } };
    const originalInput = request(prior, payload);
    const original = await transition(prior, payload);
    const current = (await transition(original.next, { action: 'approve', expiresAt: approvalExpiry })).next;
    expect(current.revision).toBe(original.next.revision + 1);
    expect(reference(current)).toEqual(reference(original.next));
    const changed = structuredClone(original.receipt);
    changed.result.proposal.hash = original.receipt.result.proposal.hash === 'a'.repeat(64) ? 'b'.repeat(64) : 'a'.repeat(64);
    await expect(planSupplierRelationshipMutation(originalInput, facts(current), current, changed, now))
      .rejects.toMatchObject({ code: 'SUPPLIER_RELATIONSHIP_RECEIPT_CONFLICT' });
    const replay = await planSupplierRelationshipMutation(originalInput, facts(current), current, original.receipt, now);
    expect(replay).toMatchObject({ kind: 'EXACT_REPLAY', originalReceipt: original.receipt, current: head(current), paymentAuthority: false });
    expect('next' in replay).toBe(false);
  });
  it.each(['create', 'revise'] as const)('requires the %s receipt timestamp to agree at the current aggregate revision', async action => {
    const prior = action === 'create' ? null : (await transition(null, { action: 'create', terms: terms() })).next;
    const payload: SupplierRelationshipCommand['payload'] = action === 'create'
      ? { action: 'create', terms: terms() }
      : { action: 'revise', terms: { ...terms(), serviceCategoryIds: ['storage'] } };
    const originalInput = request(prior, payload);
    const original = await transition(prior, payload);
    for (const recordedAt of ['2026-11-15T09:59:59Z', '2026-11-15T10:00:00.0001Z']) {
      const changed = { ...original.receipt, recordedAt };
      await expect(planSupplierRelationshipMutation(originalInput, facts(original.next), original.next, changed, now))
        .rejects.toMatchObject({ code: 'SUPPLIER_RELATIONSHIP_RECEIPT_CONFLICT' });
    }
    const replay = await planSupplierRelationshipMutation(originalInput, facts(original.next), original.next, original.receipt, now);
    expect(replay).toMatchObject({ kind: 'EXACT_REPLAY', originalReceipt: original.receipt, current: head(original.next) });
    expect('next' in replay).toBe(false);
  });
  it('retains a valid original receipt after the proposal itself is superseded', async () => {
    const original = await transition(null, { action: 'create', terms: terms() });
    const current = (await transition(original.next, { action: 'revise', terms: { ...terms(), buyerSiteIds: ['site_two'] } })).next;
    expect(current.proposal.version).toBe(original.next.proposal.version + 1);
    expect(current.proposalHash).not.toBe(original.next.proposalHash);
    const replay = await planSupplierRelationshipMutation(request(null, { action: 'create', terms: terms() }), facts(current), current, original.receipt, now);
    expect(replay).toMatchObject({ kind: 'EXACT_REPLAY', originalReceipt: original.receipt, current: head(current), paymentAuthority: false });
    expect('next' in replay).toBe(false);
  });
  it('namespaces proposal scope, versions, author and time while retaining array order', async () => {
    const created = (await transition(null, { action: 'create', terms: terms() })).next;
    const proposal = created.proposal;
    expect(created.proposalHash).toBe(await commandDigest({ namespace: 'pactwoven/supplier-relationship-proposal/v1', proposal }));
    expect(created.proposalHash).not.toBe(await commandDigest(proposal));
    for (const changed of [
      { ...proposal, terms: { ...terms(), buyerSiteIds: ['site_two'] } },
      { ...proposal, terms: { ...terms(), serviceCategoryIds: ['storage'] } },
      { ...proposal, terms: { ...terms(), expiresAt: '2026-11-15T13:00:00Z' } },
      { ...proposal, version: 2, previousVersionHash: created.proposalHash },
      { ...proposal, scope: { ...scope, environment: 'development' } },
      { ...proposal, scope: { ...scope, supplierRelationshipId: 'other' } },
      { ...proposal, scope: { ...scope, supplierOrganizationId: 'other' } },
      { ...proposal, createdBy: { ...proposal.createdBy, organizationVersion: 2 } },
      { ...proposal, createdBy: { ...proposal.createdBy, actorId: 'other' } },
      { ...proposal, createdAt: '2026-11-15T10:00:01Z' },
    ]) expect(await supplierRelationshipProposalDigest(changed)).not.toBe(created.proposalHash);
    const ordered = { ...proposal, terms: { ...terms(), buyerSiteIds: ['site_one', 'site_two'] } };
    expect(await supplierRelationshipProposalDigest(ordered)).not.toBe(await supplierRelationshipProposalDigest({ ...ordered, terms: { ...ordered.terms, buyerSiteIds: ['site_two', 'site_one'] } }));
    const { schemaVersion, ...otherKeys } = proposal;
    expect(await supplierRelationshipProposalDigest({ ...otherKeys, schemaVersion })).toBe(created.proposalHash);
  });
  it('snapshots command, current state, resolver facts and stored receipt before digest awaits', async () => {
    const created = await transition(null, { action: 'create', terms: terms() });
    const current = structuredClone(created.next);
    const context = facts(current);
    const input = request(null, { action: 'create', terms: terms() });
    const receipt = structuredClone(created.receipt);
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (algorithm, data) => { await gate; return digest(algorithm, data); });
    const pending = planSupplierRelationshipMutation(input, context, current, receipt, now);
    current.proposal.terms.buyerSiteIds[0] = 'mutated';
    context.membership.roles[0] = 'supplier_admin';
    context.organizations.buyer.authorityEpoch = 999;
    input.command.payload = { action: 'create', terms: { ...terms(), serviceCategoryIds: ['storage'] } };
    receipt.result.revision = 999;
    release();
    const replay = await pending;
    expect(replay.kind).toBe('EXACT_REPLAY');
    if (replay.kind !== 'EXACT_REPLAY') throw new Error('Expected stable replay.');
    expect(replay.originalReceipt).toEqual(created.receipt);
    expect(replay.current).toEqual(head(created.next));
    expect(Object.isFrozen(replay.originalReceipt.result)).toBe(true);
    expect(Object.isFrozen(current)).toBe(false);
  });
});
