import { afterEach, describe, expect, it, vi } from 'vitest';
import { supplierRelationshipProposalDigest, supplierScopeCategoryDigest, supplierScopePolicyDigest } from '@pactwoven/domain';
import {
  SupplierPrivateRequestSchema, SupplierExternalObservationSchema, SupplierPrivatePrincipalBindingSchema,
  SupplierMembershipObservationSchema,
  snapshotSupplierPersistenceRequest, snapshotSupplierResolverEnvelope, snapshotSupplierPersistenceResult,
} from './supplier-relationship-persistence-schema.js';

const NOW = Date.parse('2026-11-16T12:00:00.000Z'), iso = (value: number) => new Date(value).toISOString(), H = 'a'.repeat(64);
const pair = { environment: 'simulation' as const, buyerOrganizationId: 'buyer', supplierOrganizationId: 'supplier' };
const scope = { ...pair, supplierRelationshipId: 'relationship' }, actor = { environment: 'simulation', organizationId: 'buyer', actorId: 'owner' };
const administrator = { actorId: 'owner', organizationId: 'buyer', membershipId: 'member', membershipVersion: 1, organizationVersion: 1, organizationEpoch: 0 };
const binding = () => ({ reference: { id: 'private_binding', version: 1, hash: H }, environment: 'simulation', effectiveOrganizationId: 'buyer',
  verifier: { oid: 101, name: 'supplier_verifier' }, authorizer: { oid: 102, name: 'supplier_authorizer' }, status: 'ACTIVE', validFrom: iso(NOW - 3_600_000), expiresAt: iso(NOW + 3_600_000) });
const observation = () => ({ subject: 'subject', externalOrganizationId: 'org_buyer', externalMembershipId: 'ext_member', externalRole: 'org:admin',
  sessionId: 'session', authenticatedAt: iso(NOW - 120_000), membershipObservedAt: iso(NOW - 1000), issuer: 'https://synthetic.invalid',
  tokenHash: H, tokenIssuedAt: iso(NOW - 10_000), sessionExpiresAt: iso(NOW + 60_000), observedAt: iso(NOW), expiresAt: iso(NOW + 20_000) });
const membershipObservation = () => ({ issuer: 'https://synthetic.invalid', subject: 'subject', externalOrganizationId: 'org_buyer',
  externalMembershipId: 'ext_member', externalRole: 'org:admin', status: 'ACTIVE', observedAt: iso(NOW), expiresAt: iso(NOW + 20_000) });
const relationshipRequest = () => ({ kind: 'relationship-command', purpose: 'supplier_relationship_create', mutation: {
  idempotencyKey: 'relationship_create_request', command: { scope: { ...scope }, expectedVersion: 0, mandateVersion: null, authorityEpoch: 0,
    targetProposal: null, payload: { action: 'create', terms: { buyerSiteIds: ['site'], serviceCategoryIds: ['delivery'], expiresAt: iso(NOW + 3_600_000) } } },
} });
const policyRequest = () => ({ kind: 'policy-command', purpose: 'supplier_scope_policy_issue', mutation: {
  idempotencyKey: 'scope_policy_issue_request', command: { pair: { ...pair }, expectedVersion: 0, predecessor: null, buyerOrganizationVersion: 1, authorityEpoch: 0,
    payload: { action: 'issue', terms: { buyerSiteIds: ['site'], categories: [{ id: 'delivery', label: 'Delivery', definition: 'Transport sealed goods.' }], requestedValidityMs: 3_600_000 } } },
} });
async function resolver(request: unknown = relationshipRequest()) {
  const descriptor = await snapshotSupplierPersistenceRequest(request, actor);
  const organization = (id: string) => ({ id, environment: 'simulation', externalOrganizationId: 'org_' + id, version: 1, authorityEpoch: 0,
    status: 'ACTIVE', validFrom: iso(NOW - 3_600_000), expiresAt: null });
  return {
    schemaVersion: 1, requestIdentity: structuredClone(descriptor.identity), requestDigest: descriptor.requestDigest,
    context: { phase: 'RESOLVE', databaseOid: 20, sessionUserOid: 102, backendPid: 500, fullTransactionId: '1000', isolation: 'read committed',
      binding: binding(), evidence: { id: 'evidence', version: 1, hash: H }, observedAt: iso(NOW), expiresAt: iso(NOW + 20_000) },
    organizations: { buyer: organization('buyer'), supplier: organization('supplier') },
    acting: {
      actor: { ...actor, principalKind: 'human', roles: ['owner'], siteIds: [] as string[], actionSiteIds: [] as string[], sessionId: 'session', authenticatedAt: iso(NOW - 120_000), correlationId: 'synthetic' },
      membership: { id: 'member', actorId: 'owner', organizationId: 'buyer', environment: 'simulation', version: 1, organizationEpoch: 0,
        principalKind: 'human', status: 'ACTIVE', roles: ['owner'], validFrom: iso(NOW - 3_600_000), expiresAt: null,
        subject: 'subject', externalMembershipId: 'ext_member', grantBasis: 'clerk_admin_bootstrap' }, observation: observation(),
    },
    approvers: [] as unknown[],
    policy: { head: null, current: null, selectedVersion: null, originalReceipt: null,
      selectedBuyerSites: [] as Array<{ environment: string; organizationId: string; id: string }>,
      categoryHistory: [] as Array<{ id: string; category: null }> },
    relationship: { head: null, current: null, originalReceipt: null },
    participation: null, observedAt: iso(NOW), expiresAt: iso(NOW + 20_000),
  };
}
async function relationshipRecords() {
  const request = relationshipRequest(), descriptor = await snapshotSupplierPersistenceRequest(request, actor);
  const proposal = { schemaVersion: 1, scope, version: 1, previousVersionHash: null,
    terms: request.mutation.command.payload.terms, createdBy: administrator, createdAt: iso(NOW) };
  const proposalHash = await supplierRelationshipProposalDigest(proposal);
  const proposalRef = { id: 'relationship', version: 1, hash: proposalHash };
  const snapshot = { schemaVersion: 1, revision: 1, proposal, proposalHash, status: 'PROPOSED', approvals: { buyer: null, supplier: null },
    changedBy: administrator, updatedAt: iso(NOW) };
  const head = { scope, revision: 1, proposal: proposalRef, status: 'PROPOSED' };
  const receipt = { identity: { scope, actorId: 'owner', organizationId: 'buyer', idempotencyKey: request.mutation.idempotencyKey },
    commandDigest: descriptor.mutationDigest!, result: head, recordedAt: iso(NOW) };
  const policy = { pair, version: 1, hash: H };
  const privateBinding = { schemaVersion: 1, scope, proposal: proposalRef, policy, producingReceipt: receipt };
  return { request, snapshot, head, receipt, privateBinding, policy,
    result: { kind: 'relationship-command', outcome: 'APPENDED', receipt: { receipt, policy }, record: { snapshot, policyBinding: privateBinding }, currentHead: head } };
}
async function policyRecords() {
  const request = policyRequest(), descriptor = await snapshotSupplierPersistenceRequest(request, actor), category = request.mutation.command.payload.terms.categories[0]!;
  const policy = { schemaVersion: 1, pair, version: 1, predecessor: null, status: 'ACTIVE', buyerSiteIds: ['site'],
    categories: [{ ...category, definitionHash: await supplierScopeCategoryDigest(pair, category) }], issuedAt: iso(NOW), validFrom: iso(NOW), expiresAt: iso(NOW + 3_600_000),
    organizations: { buyer: { externalOrganizationId: 'org_buyer', version: 1, authorityEpoch: 0 }, supplier: { externalOrganizationId: 'org_supplier', version: 1, authorityEpoch: 0 } },
    issuer: { ...administrator, subject: 'subject', externalOrganizationId: 'org_buyer', externalMembershipId: 'ext_member', sessionId: 'session', factorEvidence: { id: 'factors', version: 1, hash: H } },
    commandIdentity: { pair, actorId: 'owner', organizationId: 'buyer', idempotencyKey: request.mutation.idempotencyKey }, commandDigest: descriptor.mutationDigest! };
  const record = { policy, policyHash: await supplierScopePolicyDigest(policy) };
  return { request, record, reference: { pair, version: 1, hash: record.policyHash },
    result: { kind: 'policy-command', outcome: 'APPENDED', receipt: { identity: policy.commandIdentity, commandDigest: descriptor.mutationDigest!, result: record, recordedAt: iso(NOW) }, current: record } };
}
afterEach(() => vi.restoreAllMocks());

describe('supplier private request identities', () => {
  it('separates normalized policy commands, relationship commands, reads and exact recovery', async () => {
    const policy = policyRequest(), relation = relationshipRequest();
    const a = await snapshotSupplierPersistenceRequest(policy, actor), b = await snapshotSupplierPersistenceRequest(relation, actor);
    expect(a.authentication).toBe('NOT_ESTABLISHED');
    expect(a.requestDigest).not.toBe(b.requestDigest);
    expect(a.mutationDigest).not.toBe(a.requestDigest);
    expect(a.identity).toMatchObject({ pair, relationshipId: null, purpose: 'supplier_scope_policy_issue' });
    expect(b.identity).toMatchObject({ relationshipId: 'relationship', purpose: 'supplier_relationship_create' });
    const spaced = policyRequest(); spaced.mutation.command.payload.terms.categories[0]!.definition = '  Transport sealed goods.  ';
    expect((await snapshotSupplierPersistenceRequest(spaced, actor)).requestDigest).toBe(a.requestDigest);
    const status = await snapshotSupplierPersistenceRequest({ kind: 'relationship-status', purpose: 'supplier_relationship_status', query: { scope, revision: null } }, actor);
    expect(status.mutationDigest).toBeNull();
    expect(status.identity.originalKey).toBeNull();
  });
  it('rejects purpose substitution, unknown command fields, arbitrary query filters and wrong actors', async () => {
    for (const changed of [
      { ...policyRequest(), purpose: 'supplier_scope_policy_revoke' },
      { ...relationshipRequest(), purpose: 'supplier_relationship_approve' },
      { ...relationshipRequest(), table: 'memberships' },
      { kind: 'relationship-status', purpose: 'supplier_relationship_status', query: { scope, revision: null, filter: 'all' } },
    ]) expect(SupplierPrivateRequestSchema.safeParse(changed).success).toBe(false);
    await expect(snapshotSupplierPersistenceRequest(policyRequest(), { ...actor, organizationId: 'supplier' })).rejects.toThrow();
    await expect(snapshotSupplierPersistenceRequest(relationshipRequest(), { ...actor, environment: 'production' })).rejects.toThrow();
    const request = { kind: 'relationship-recover', purpose: 'supplier_relationship_recover',
      query: { identity: { scope, actorId: 'other', organizationId: 'buyer', idempotencyKey: 'original_recovery_key' }, action: 'create', commandDigest: H } };
    await expect(snapshotSupplierPersistenceRequest(request, actor)).rejects.toThrow('exact original actor');
  });
  it('requires finite exact principal and observation shapes without treating them as authentication', () => {
    expect(SupplierPrivatePrincipalBindingSchema.safeParse(binding()).success).toBe(true);
    for (const change of [{ expiresAt: null }, { authorizer: binding().verifier }, { role: 'owner' }, { grant: true }]) {
      expect(SupplierPrivatePrincipalBindingSchema.safeParse({ ...binding(), ...change }).success).toBe(false);
    }
    for (const change of [{ token: 'secret' }, { expiresAt: null }, { tokenIssuedAt: iso(NOW + 1) }, { membershipObservedAt: iso(NOW + 1) },
      { expiresAt: iso(NOW + 30_001) }]) expect(SupplierExternalObservationSchema.safeParse({ ...observation(), ...change }).success).toBe(false);
  });
});

describe('private resolver snapshots', () => {
  it('snapshots a bounded resolver packet without constructing trusted facts or write authority', async () => {
    const input = await resolver();
    const result = await snapshotSupplierResolverEnvelope(input, relationshipRequest(), actor, iso(NOW));
    expect(result).toMatchObject({ kind: 'STRUCTURAL_RESOLVER_SNAPSHOT', authentication: 'NOT_ESTABLISHED', locking: 'NOT_ESTABLISHED' });
    expect(Object.isFrozen(result.value.acting.membership)).toBe(true);
    expect(result.value.participation).toBeNull();
    expect(Object.isFrozen(input)).toBe(false);
  });
  it('rejects wrong binding/engine/pair/identity, stale observations and unsupported isolation', async () => {
    const changes: Array<(value: Awaited<ReturnType<typeof resolver>>) => void> = [
      value => { value.context.binding.status = 'REVOKED'; },
      value => { value.context.sessionUserOid = 101; },
      value => { value.context.isolation = 'repeatable read'; },
      value => { value.context.phase = 'WRITE'; },
      value => { value.organizations.supplier.id = 'other'; },
      value => { value.organizations.buyer.environment = 'production'; },
      value => { value.acting.membership.actorId = 'other'; },
      value => { value.acting.membership.status = 'REVOKED'; },
      value => { value.acting.actor.roles = ['supplier_admin']; value.acting.membership.roles = ['supplier_admin']; },
      value => { value.acting.observation.externalMembershipId = 'other'; },
      value => { value.acting.observation.externalRole = 'org:member'; },
      value => { value.acting.actor.siteIds = ['unrequested_site']; },
      value => { value.context.expiresAt = iso(NOW + 25_000); },
      value => { value.acting.observation.membershipObservedAt = iso(NOW - 20_001); },
      value => { value.observedAt = iso(NOW - 20_001); },
      value => { value.expiresAt = iso(NOW); },
      value => { value.requestDigest = 'f'.repeat(64); },
    ];
    for (const change of changes) {
      const input = await resolver(); change(input);
      await expect(snapshotSupplierResolverEnvelope(input, relationshipRequest(), actor, iso(NOW))).rejects.toThrow();
    }
    await expect(snapshotSupplierResolverEnvelope({ ...await resolver(), participation: { role: 'supplier_admin' } }, relationshipRequest(), actor, iso(NOW))).rejects.toThrow();
  });
  it('rejects unrequested site/category/approver enumeration and duplicates', async () => {
    const input = await resolver();
    input.policy.selectedBuyerSites = [{ environment: 'simulation', organizationId: 'buyer', id: 'site' }];
    await expect(snapshotSupplierResolverEnvelope(input, relationshipRequest(), actor, iso(NOW))).rejects.toThrow('enumerate');
    const duplicated = await resolver();
    duplicated.approvers = Array.from({ length: 3 }, () => ({ membership: { ...duplicated.acting.membership }, observation: observation() }));
    await expect(snapshotSupplierResolverEnvelope(duplicated, relationshipRequest(), actor, iso(NOW))).rejects.toThrow();
    const foreign = await resolver();
    foreign.policy.selectedBuyerSites = [{ environment: 'simulation', organizationId: 'supplier', id: 'site' }];
    await expect(snapshotSupplierResolverEnvelope(foreign, relationshipRequest(), actor, iso(NOW))).rejects.toThrow();
  });
  it('resolves only the exact policy command sites and immutable category history', async () => {
    const data = await policyRecords(), base = await resolver(data.request);
    const input = { ...base, relationship: null, policy: { ...base.policy,
      selectedBuyerSites: [{ environment: 'simulation', organizationId: 'buyer', id: 'site' }],
      categoryHistory: [{ id: 'delivery', category: null }] } };
    expect((await snapshotSupplierResolverEnvelope(input, data.request, actor, iso(NOW))).value.policy.head).toBeNull();
    for (const policy of [
      { ...input.policy, selectedBuyerSites: [] },
      { ...input.policy, selectedBuyerSites: [...input.policy.selectedBuyerSites, ...input.policy.selectedBuyerSites] },
      { ...input.policy, categoryHistory: [] },
      { ...input.policy, categoryHistory: [{ id: 'other', category: null }] },
      { ...input.policy, categoryHistory: [{ id: 'delivery', category: { ...data.record.policy.categories[0]!, definitionHash: H } }] },
    ]) await expect(snapshotSupplierResolverEnvelope({ ...input, policy }, data.request, actor, iso(NOW))).rejects.toThrow();
    const current = { ...input, policy: { ...input.policy, head: data.reference, current: data.record,
      originalReceipt: data.result.receipt, categoryHistory: [{ id: 'delivery', category: data.record.policy.categories[0]! }] } };
    expect((await snapshotSupplierResolverEnvelope(current, data.request, actor, iso(NOW))).value.policy.originalReceipt).toEqual(data.result.receipt);
    await expect(snapshotSupplierResolverEnvelope({ ...current, policy: { ...current.policy, categoryHistory: [{ id: 'delivery', category: null }] } }, data.request, actor, iso(NOW))).rejects.toThrow('current definition');
  });
  it('reads exact historical policy versions while retaining a later revoked head', async () => {
    const data = await policyRecords();
    const laterPolicy = { ...data.record.policy, version: 2, predecessor: data.reference, status: 'REVOKED', expiresAt: iso(NOW) };
    const later = { policy: laterPolicy, policyHash: await supplierScopePolicyDigest(laterPolicy) };
    const request = { kind: 'policy-read', purpose: 'supplier_scope_policy_read', query: { policy: data.reference } };
    const base = await resolver(request), input = { ...base, relationship: null, policy: { ...base.policy,
      head: { pair, version: 2, hash: later.policyHash }, current: later, selectedVersion: data.record } };
    const result = await snapshotSupplierResolverEnvelope(input, request, actor, iso(NOW));
    expect(result.value.policy.current?.policy.status).toBe('REVOKED');
    expect(result.value.policy.selectedVersion).toEqual(data.record);
    for (const policy of [
      { ...input.policy, head: data.reference },
      { ...input.policy, current: null, head: null },
      { ...input.policy, selectedVersion: later },
      { ...input.policy, selectedVersion: { ...data.record, policyHash: H } },
    ]) await expect(snapshotSupplierResolverEnvelope({ ...input, policy }, request, actor, iso(NOW))).rejects.toThrow();
  });
  it('retains current and historical relationship revisions under the exact current head', async () => {
    const data = await relationshipRecords();
    const request = { kind: 'relationship-status', purpose: 'supplier_relationship_status', query: { scope, revision: 1 } };
    const base = await resolver(request), record = data.result.record;
    const current = { ...base, relationship: { head: data.head, current: record, originalReceipt: null } };
    expect((await snapshotSupplierResolverEnvelope(current, request, actor, iso(NOW))).value.relationship?.current?.snapshot.revision).toBe(1);
    const historical = { ...current, relationship: { ...current.relationship, head: { ...data.head, revision: 3, status: 'SUSPENDED' } } };
    expect((await snapshotSupplierResolverEnvelope(historical, request, actor, iso(NOW))).value.relationship?.head?.revision).toBe(3);
    await expect(snapshotSupplierResolverEnvelope(historical, { ...request, query: { scope, revision: null } }, actor, iso(NOW))).rejects.toThrow();
    const changed = structuredClone(current); changed.relationship.head.status = 'SUSPENDED';
    await expect(snapshotSupplierResolverEnvelope(changed, request, actor, iso(NOW))).rejects.toThrow();
    const rehashed = structuredClone(current); rehashed.relationship.current.snapshot.proposal.terms.buyerSiteIds = ['other'];
    await expect(snapshotSupplierResolverEnvelope(rehashed, request, actor, iso(NOW))).rejects.toThrow('hash');
  });
  it('rejects contradictory original receipt times for the resolved current revision', async () => {
    const data = await relationshipRecords(), base = await resolver(data.request);
    const input = { ...base, relationship: { head: data.head, current: data.result.record,
      originalReceipt: { receipt: structuredClone(data.receipt), policy: data.policy } } };
    expect((await snapshotSupplierResolverEnvelope(input, data.request, actor, iso(NOW + 100))).value.relationship?.originalReceipt?.receipt).toEqual(data.receipt);
    for (const recordedAt of [iso(NOW - 1), iso(NOW + 1)]) {
      const changed = structuredClone(input); changed.relationship.originalReceipt.receipt.recordedAt = recordedAt;
      await expect(snapshotSupplierResolverEnvelope(changed, data.request, actor, iso(NOW + 100))).rejects.toThrow();
    }
  });
  it('preserves historical receipts while rejecting later times or a contradictory producing receipt', async () => {
    const data = await relationshipRecords(), base = await resolver(data.request);
    const approval = { ...administrator, party: 'buyer', proposal: data.head.proposal,
      approvedAt: iso(NOW + 100), expiresAt: iso(NOW + 1000) };
    const snapshot = { ...data.snapshot, revision: 2, approvals: { buyer: approval, supplier: null }, updatedAt: iso(NOW + 100) };
    const input = { ...base, relationship: { head: { ...data.head, revision: 2 },
      current: { snapshot, policyBinding: structuredClone(data.privateBinding) },
      originalReceipt: { receipt: structuredClone(data.receipt), policy: data.policy } } };
    const result = await snapshotSupplierResolverEnvelope(input, data.request, actor, iso(NOW + 200));
    expect(result.value.relationship?.originalReceipt).toEqual({ receipt: data.receipt, policy: data.policy });
    for (const recordedAt of [iso(NOW - 1), iso(NOW + 50), iso(NOW + 101)]) {
      const changed = structuredClone(input); changed.relationship.originalReceipt.receipt.recordedAt = recordedAt;
      await expect(snapshotSupplierResolverEnvelope(changed, data.request, actor, iso(NOW + 200))).rejects.toThrow();
    }
    const exchanged = structuredClone(input);
    exchanged.relationship.current.policyBinding.producingReceipt.identity.idempotencyKey = 'another_producing_key';
    await expect(snapshotSupplierResolverEnvelope(exchanged, data.request, actor, iso(NOW + 200))).rejects.toThrow();
  });
  it('limits approver resolution to stamped members and preserves revoked members for gate evaluation', async () => {
    const data = await relationshipRecords(), request = { kind: 'relationship-status', purpose: 'supplier_relationship_status', query: { scope, revision: null } };
    const base = await resolver(request), approval = { ...administrator, party: 'buyer', proposal: data.head.proposal, approvedAt: iso(NOW), expiresAt: iso(NOW + 1000) };
    const snapshot = { ...data.snapshot, revision: 2, approvals: { buyer: approval, supplier: null } };
    const member = { ...base.acting.membership, version: 2, status: 'REVOKED' };
    // A different current actor can inspect the revoked original approver without making it current authority.
    const who = { ...actor, actorId: 'new_owner' };
    const descriptor = await snapshotSupplierPersistenceRequest(request, who);
    const input = { ...base, requestIdentity: descriptor.identity, requestDigest: descriptor.requestDigest,
      acting: { ...base.acting, actor: { ...base.acting.actor, actorId: 'new_owner' },
        membership: { ...base.acting.membership, actorId: 'new_owner', id: 'new_member', subject: 'new_subject', externalMembershipId: 'new_external_member' },
        observation: { ...base.acting.observation, subject: 'new_subject', externalMembershipId: 'new_external_member' } },
      approvers: [{ membership: member, approval, observation: membershipObservation() }],
      relationship: { head: { ...data.head, revision: 2 }, current: { snapshot, policyBinding: data.privateBinding }, originalReceipt: null } };
    expect((await snapshotSupplierResolverEnvelope(input, request, who, iso(NOW))).value.approvers[0]?.membership.status).toBe('REVOKED');
    await expect(snapshotSupplierResolverEnvelope({ ...input, approvers: [{ membership: { ...member, actorId: 'unrequested' }, approval, observation: membershipObservation() }] }, request, who, iso(NOW))).rejects.toThrow('Unrequested approver');
    await expect(snapshotSupplierResolverEnvelope({ ...input, approvers: [...input.approvers, ...input.approvers] }, request, who, iso(NOW))).rejects.toThrow('Duplicate');
    await expect(snapshotSupplierResolverEnvelope({ ...input, approvers: [] }, request, who, iso(NOW))).rejects.toThrow('every exact fresh');
    const changedStamp = { ...approval, membershipVersion: 2 };
    await expect(snapshotSupplierResolverEnvelope({ ...input, approvers: [{ membership: member, approval: changedStamp, observation: membershipObservation() }] }, request, who, iso(NOW))).rejects.toThrow('Unrequested approver');
  });
  it('snapshots resolver/request/actor values before the first digest await', async () => {
    const input = await resolver(), request = relationshipRequest(), who = { ...actor };
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (algorithm, data) => { await gate; return digest(algorithm, data); });
    const pending = snapshotSupplierResolverEnvelope(input, request, who, iso(NOW));
    input.acting.membership.roles = ['supplier_admin'];
    request.mutation.command.payload.terms.buyerSiteIds = ['changed'];
    who.actorId = 'changed'; release();
    expect((await pending).value.acting.membership.roles).toEqual(['owner']);
  });
});

describe('private result and original recovery boundaries', () => {
  it('separates private observation planning from public status and all mutation purposes', async () => {
    const data = await relationshipRecords();
    const request = { kind: 'relationship-observation-plan', purpose: 'supplier_relationship_observation_plan', query: { scope } };
    const descriptor = await snapshotSupplierPersistenceRequest(request, actor);
    expect(descriptor.mutationDigest).toBeNull();
    expect(descriptor.identity.originalKey).toBeNull();
    const status = { kind: 'relationship-status', purpose: 'supplier_relationship_status', query: { scope, revision: null } };
    expect((await snapshotSupplierPersistenceRequest(status, actor)).requestDigest).not.toBe(descriptor.requestDigest);
    const result = { kind: 'relationship-observation-plan', plan: { scope, head: data.head, approvers: [] } };
    expect((await snapshotSupplierPersistenceResult(result, request, actor)).value).toEqual(result);
    await expect(snapshotSupplierPersistenceResult(result, status, actor)).rejects.toThrow('family');
    await expect(snapshotSupplierPersistenceResult({ ...result, projection: {} }, request, actor)).rejects.toThrow();
    await expect(snapshotSupplierPersistenceRequest({ ...request, query: { scope, revision: 1 } }, actor)).rejects.toThrow();
    const input = await resolver(request);
    expect((await snapshotSupplierResolverEnvelope(input, request, actor, iso(NOW))).value.context.phase).toBe('RESOLVE');
  });
  it('returns only bounded exact original approval stamps and membership locators in a private plan', async () => {
    const data = await relationshipRecords(), head = { ...data.head, revision: 2 };
    const approval = { ...administrator, party: 'buyer', proposal: head.proposal, approvedAt: iso(NOW), expiresAt: iso(NOW + 1000) };
    const request = { kind: 'relationship-observation-plan', purpose: 'supplier_relationship_observation_plan', query: { scope } };
    const entry = { approval, subject: 'subject', externalOrganizationId: 'org_buyer', externalMembershipId: 'ext_member' };
    const result = { kind: 'relationship-observation-plan', plan: { scope, head, approvers: [entry] } };
    expect((await snapshotSupplierPersistenceResult(result, request, actor)).value).toEqual(result);
    for (const plan of [
      { ...result.plan, approvers: [entry, entry] },
      { ...result.plan, head: null },
      { ...result.plan, head: { ...head, status: 'ACTIVE' } },
      { ...result.plan, approvers: [{ ...entry, approval: { ...approval, organizationId: 'supplier' } }] },
      { ...result.plan, approvers: [{ ...entry, approval: { ...approval, proposal: { ...head.proposal, hash: 'f'.repeat(64) } } }] },
      { ...result.plan, approvers: [{ ...entry, roles: ['owner'], token: 'must_not_leak' }] },
    ]) await expect(snapshotSupplierPersistenceResult({ ...result, plan }, request, actor)).rejects.toThrow();
    expect((await snapshotSupplierPersistenceResult({ ...result, plan: { scope, head: null, approvers: [] } }, request, actor)).value.kind).toBe('relationship-observation-plan');
  });
  it('refuses token/session/factor fields in counterpart membership observations', () => {
    expect(SupplierMembershipObservationSchema.safeParse(membershipObservation()).success).toBe(true);
    for (const extra of [{ tokenHash: H }, { sessionId: 'session' }, { tokenIssuedAt: iso(NOW) }, { factors: {} }, { authenticatedAt: iso(NOW) }]) {
      expect(SupplierMembershipObservationSchema.safeParse({ ...membershipObservation(), ...extra }).success).toBe(false);
    }
    expect(SupplierMembershipObservationSchema.safeParse({ ...membershipObservation(), expiresAt: iso(NOW + 30_001) }).success).toBe(false);
  });
  it('retains the original immutable receipt and policy pin on appended relationship results', async () => {
    const data = await relationshipRecords();
    const result = await snapshotSupplierPersistenceResult(data.result, data.request, actor);
    expect(result).toMatchObject({ authentication: 'NOT_ESTABLISHED', persistence: 'NOT_ESTABLISHED' });
    expect(result.value.kind === 'relationship-command' && result.value.receipt.policy).toEqual(data.policy);
    for (const mutate of [
      (value: typeof data.result) => { value.receipt.policy = { ...value.receipt.policy, version: 2 }; },
      (value: typeof data.result) => { value.receipt.receipt.commandDigest = 'f'.repeat(64); },
      (value: typeof data.result) => { value.record.snapshot.proposal.terms.buyerSiteIds = ['other']; },
      (value: typeof data.result) => { value.currentHead.revision++; },
    ]) {
      const changed = structuredClone(data.result); mutate(changed);
      await expect(snapshotSupplierPersistenceResult(changed, data.request, actor)).rejects.toThrow();
    }
  });
  it('checks exact policy hashes, versions and command receipts', async () => {
    const data = await policyRecords();
    expect((await snapshotSupplierPersistenceResult(data.result, data.request, actor)).value.kind).toBe('policy-command');
    const read = { kind: 'policy-read', purpose: 'supplier_scope_policy_read', query: { policy: data.reference } };
    expect((await snapshotSupplierPersistenceResult({ kind: 'policy-read', record: data.record }, read, actor)).value.kind).toBe('policy-read');
    const changed = structuredClone(data.result); changed.current.policy.categories[0]!.definition = 'Changed.';
    await expect(snapshotSupplierPersistenceResult(changed, data.request, actor)).rejects.toThrow();
    await expect(snapshotSupplierPersistenceResult({ kind: 'policy-read', record: data.record }, { ...read, query: { policy: { ...data.reference, version: 2 } } }, actor)).rejects.toThrow();
    const rehashed = structuredClone(data.result);
    rehashed.receipt.result.policy.buyerSiteIds = ['unrequested'];
    rehashed.receipt.result.policyHash = await supplierScopePolicyDigest(rehashed.receipt.result.policy);
    rehashed.current = rehashed.receipt.result;
    await expect(snapshotSupplierPersistenceResult(rehashed, data.request, actor)).rejects.toThrow('mismatch');
  });
  it('keeps policy replay historical and rejects same-version rewrites and broken immediate lineage', async () => {
    const data = await policyRecords();
    const policy = { ...data.record.policy, version: 2, predecessor: data.reference, status: 'REVOKED', expiresAt: iso(NOW) };
    const current = { policy, policyHash: await supplierScopePolicyDigest(policy) };
    const replay = { ...data.result, outcome: 'EXACT_REPLAY', current };
    expect((await snapshotSupplierPersistenceResult(replay, data.request, actor)).value.kind).toBe('policy-command');
    const rewritten = structuredClone(data.record); rewritten.policy.buyerSiteIds = ['other']; rewritten.policyHash = await supplierScopePolicyDigest(rewritten.policy);
    await expect(snapshotSupplierPersistenceResult({ ...replay, current: rewritten }, data.request, actor)).rejects.toThrow();
    const broken = structuredClone(current); broken.policy.predecessor.hash = H; broken.policyHash = await supplierScopePolicyDigest(broken.policy);
    await expect(snapshotSupplierPersistenceResult({ ...replay, current: broken }, data.request, actor)).rejects.toThrow();
  });
  it('rejects rehashed proposal substitution and replacement of its producing receipt', async () => {
    const data = await relationshipRecords(), changed = structuredClone(data.result);
    changed.record.snapshot.proposal.terms.buyerSiteIds = ['unrequested'];
    const hash = await supplierRelationshipProposalDigest(changed.record.snapshot.proposal);
    changed.record.snapshot.proposalHash = hash;
    changed.record.policyBinding.proposal.hash = hash;
    changed.record.policyBinding.producingReceipt.result.proposal.hash = hash;
    changed.receipt.receipt.result.proposal.hash = hash;
    changed.currentHead.proposal.hash = hash;
    await expect(snapshotSupplierPersistenceResult(changed, data.request, actor)).rejects.toThrow('exact command terms');
    const exchanged = structuredClone(data.result);
    exchanged.record.policyBinding.producingReceipt = { ...exchanged.record.policyBinding.producingReceipt,
      identity: { ...exchanged.record.policyBinding.producingReceipt.identity, idempotencyKey: 'other_producing_receipt' } };
    await expect(snapshotSupplierPersistenceResult(exchanged, data.request, actor)).rejects.toThrow('producing receipt');
  });
  it('validates an approval receipt and later exact replay against the original proposal pin', async () => {
    const data = await relationshipRecords();
    const request = { kind: 'relationship-command', purpose: 'supplier_relationship_approve', mutation: {
      idempotencyKey: 'approval_original_key', command: { ...data.request.mutation.command, expectedVersion: 1, targetProposal: data.head.proposal,
        payload: { action: 'approve', expiresAt: iso(NOW + 1000) } } } };
    const descriptor = await snapshotSupplierPersistenceRequest(request, actor);
    const approval = { ...administrator, party: 'buyer', proposal: data.head.proposal, approvedAt: iso(NOW), expiresAt: iso(NOW + 1000) };
    const snapshot = { ...data.snapshot, revision: 2, approvals: { buyer: approval, supplier: null } };
    const head = { ...data.head, revision: 2 }, receipt = { ...data.receipt, identity: { ...data.receipt.identity, idempotencyKey: request.mutation.idempotencyKey }, commandDigest: descriptor.mutationDigest!, result: head };
    const result = { ...data.result, receipt: { receipt, policy: data.policy }, record: { snapshot, policyBinding: data.privateBinding }, currentHead: head };
    expect((await snapshotSupplierPersistenceResult(result, request, actor)).value.kind).toBe('relationship-command');
    const replay = { ...result, outcome: 'EXACT_REPLAY', currentHead: { ...head, revision: 3, status: 'SUSPENDED' } };
    expect((await snapshotSupplierPersistenceResult(replay, request, actor)).value.kind).toBe('relationship-command');
    const changed = structuredClone(result); changed.record.snapshot.approvals.buyer.expiresAt = iso(NOW + 999);
    await expect(snapshotSupplierPersistenceResult(changed, request, actor)).rejects.toThrow('approval terms');
    await expect(snapshotSupplierPersistenceResult({ ...replay, currentHead: { ...head, status: 'SUSPENDED' } }, request, actor)).rejects.toThrow();
  });
  it('recovers only the exact original actor/key/digest/action and retains the old policy pin', async () => {
    const data = await relationshipRecords();
    const query = { kind: 'relationship-recover', purpose: 'supplier_relationship_recover',
      query: { identity: data.receipt.identity, commandDigest: data.receipt.commandDigest, action: 'create' } };
    const result = { kind: 'relationship-recover', original: { mutation: data.request.mutation,
      receipt: { receipt: data.receipt, policy: data.policy }, binding: data.privateBinding, currentHead: { ...data.head, revision: 4 } } };
    const recovered = await snapshotSupplierPersistenceResult(result, query, actor);
    expect(recovered.value.kind === 'relationship-recover' && recovered.value.original?.receipt.policy).toEqual(data.policy);
    for (const changed of [{ ...query, query: { ...query.query, commandDigest: 'f'.repeat(64) } },
      { ...query, query: { ...query.query, action: 'approve' } },
      { ...query, query: { ...query.query, identity: { ...query.query.identity, idempotencyKey: 'another_original_key' } } }]) {
      await expect(snapshotSupplierPersistenceResult(result, changed, actor)).rejects.toThrow();
    }
    const repinned = structuredClone(result); repinned.original.receipt.policy = { ...repinned.original.receipt.policy, version: 2 };
    await expect(snapshotSupplierPersistenceResult(repinned, query, actor)).rejects.toThrow();
    const rekeyed = structuredClone(result); rekeyed.original.binding.producingReceipt = { ...rekeyed.original.binding.producingReceipt,
      identity: { ...rekeyed.original.binding.producingReceipt.identity, idempotencyKey: 'other_producing_receipt' } };
    await expect(snapshotSupplierPersistenceResult(rekeyed, query, actor)).rejects.toThrow();
    expect((await snapshotSupplierPersistenceResult({ kind: 'relationship-recover', original: null }, query, actor)).value).toEqual({ kind: 'relationship-recover', original: null });
  });
  it('recovers later actions at equal or later times but never before the producing receipt', async () => {
    const data = await relationshipRecords();
    const request = { kind: 'relationship-command', purpose: 'supplier_relationship_approve', mutation: {
      idempotencyKey: 'approval_chronology_key', command: { ...data.request.mutation.command, expectedVersion: 1,
        targetProposal: data.head.proposal, payload: { action: 'approve', expiresAt: iso(NOW + 1000) } } } };
    const descriptor = await snapshotSupplierPersistenceRequest(request, actor), head = { ...data.head, revision: 2 };
    const receipt = { ...data.receipt, identity: { ...data.receipt.identity, idempotencyKey: request.mutation.idempotencyKey },
      commandDigest: descriptor.mutationDigest!, result: head };
    const query = { kind: 'relationship-recover', purpose: 'supplier_relationship_recover',
      query: { identity: receipt.identity, commandDigest: receipt.commandDigest, action: 'approve' } };
    const result = { kind: 'relationship-recover', original: { mutation: request.mutation,
      receipt: { receipt, policy: data.policy }, binding: data.privateBinding, currentHead: head } };
    for (const recordedAt of [iso(NOW), iso(NOW + 100)]) {
      const valid = structuredClone(result); valid.original.receipt.receipt.recordedAt = recordedAt;
      expect((await snapshotSupplierPersistenceResult(valid, query, actor)).value.kind).toBe('relationship-recover');
    }
    const reversed = structuredClone(result); reversed.original.receipt.receipt.recordedAt = iso(NOW - 1);
    await expect(snapshotSupplierPersistenceResult(reversed, query, actor)).rejects.toThrow();
  });
  it('rejects public status leakage, wrong family and wrong requested revision', async () => {
    const data = await relationshipRecords();
    const projection = { kind: 'RELATIONSHIP_STATUS_ONLY', scope, revision: 1, proposal: data.head.proposal, status: 'PROPOSED', expiresAt: iso(NOW + 3_600_000),
      viewerParty: 'buyer', current: true, approvalsRecorded: { buyer: false, supplier: false }, relationshipGate: 'BLOCKED', gateReason: 'NOT_ACTIVE',
      authentication: 'NOT_ESTABLISHED', businessVerification: 'NOT_ESTABLISHED', payeeVerification: 'NOT_ESTABLISHED',
      bookingAuthority: false, contractualAcceptance: false, paymentAuthority: false };
    const request = { kind: 'relationship-status', purpose: 'supplier_relationship_status', query: { scope, revision: 1 } };
    expect((await snapshotSupplierPersistenceResult({ kind: 'relationship-status', projection }, request, actor)).value.kind).toBe('relationship-status');
    await expect(snapshotSupplierPersistenceResult({ kind: 'relationship-status', projection: { ...projection, contacts: [] } }, request, actor)).rejects.toThrow();
    await expect(snapshotSupplierPersistenceResult({ kind: 'relationship-status', projection }, { ...request, query: { scope, revision: 2 } }, actor)).rejects.toThrow();
    await expect(snapshotSupplierPersistenceResult({ kind: 'relationship-status', projection: { ...projection, viewerParty: 'supplier' } }, request, actor)).rejects.toThrow('viewer');
    await expect(snapshotSupplierPersistenceResult(data.result, request, actor)).rejects.toThrow();
  });
  it('snapshots result, request and actor before any asynchronous content check', async () => {
    const data = await relationshipRecords(), original = structuredClone(data.result), who = { ...actor };
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (algorithm, bytes) => { await gate; return digest(algorithm, bytes); });
    const pending = snapshotSupplierPersistenceResult(data.result, data.request, who);
    data.result.receipt.policy.version = 99;
    data.request.mutation.idempotencyKey = 'changed_original_key';
    who.actorId = 'changed'; release();
    expect((await pending).value).toEqual(original);
  });
});
