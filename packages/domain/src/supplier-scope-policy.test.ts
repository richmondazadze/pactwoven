import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupplierScopePolicyCommand, SupplierScopePolicySnapshot, SupplierScopeCategory } from '@pactwoven/contracts';
import {
  planSupplierScopePolicyMutation, supplierScopePolicyCommandDigest, supplierScopeCategoryDigest, supplierScopePolicyDigest,
  bindSupplierRelationshipScopePolicy, assessSupplierRelationshipScopePolicy, applySupplierRelationshipScopePolicy,
  type SupplierScopePolicyIssuerFacts, type SupplierScopePolicyReadFacts,
} from './supplier-scope-policy.js';
import { supplierRelationshipProposalDigest } from './supplier-relationships.js';

const NOW = Date.parse('2026-11-16T10:00:00.000Z'), iso = (at: number) => new Date(at).toISOString();
const pair = { environment: 'simulation' as const, buyerOrganizationId: 'buyer', supplierOrganizationId: 'supplier' };
const definition = { id: 'delivery', label: 'Delivery', definition: 'Transport sealed goods between selected buyer sites.' };
const storage = { id: 'storage', label: 'Storage', definition: 'Store sealed goods indoors at selected buyer sites.' };
const terms = () => ({ buyerSiteIds: ['site_one'], categories: [{ ...definition }], requestedValidityMs: 3_600_000 });
const reference = (state: SupplierScopePolicySnapshot) => ({ pair: state.policy.pair, version: state.policy.version, hash: state.policyHash });
const organization = (id: 'buyer' | 'supplier') => ({
  id, environment: 'simulation' as const, externalOrganizationId: 'org_' + id, version: 1, authorityEpoch: 0,
  status: 'ACTIVE' as const, validFrom: iso(NOW - 86_400_000), expiresAt: null,
});
const request = (current: SupplierScopePolicySnapshot | null, payload: SupplierScopePolicyCommand['payload']) => ({
  idempotencyKey: 'scope_' + payload.action + '_request_' + (current?.policy.version ?? 0),
  command: { pair: { ...pair }, expectedVersion: current?.policy.version ?? 0, predecessor: current === null ? null : reference(current),
    buyerOrganizationVersion: 1, authorityEpoch: 0, payload } satisfies SupplierScopePolicyCommand,
});
async function facts(input: ReturnType<typeof request>, current: SupplierScopePolicySnapshot | null, at = NOW, known = current?.policy.categories ?? []): Promise<SupplierScopePolicyIssuerFacts> {
  const selected = input.command.payload.action === 'revoke' ? null : input.command.payload.terms;
  return structuredClone<SupplierScopePolicyIssuerFacts>({
    schemaVersion: 1, pair: { ...pair }, observedAt: iso(at), expiresAt: iso(at + 20_000),
    organizations: { buyer: organization('buyer'), supplier: organization('supplier') }, head: current === null ? null : reference(current),
    actor: { actorId: 'owner', principalKind: 'human', organizationId: 'buyer', environment: 'simulation', roles: ['owner'],
      siteIds: [], actionSiteIds: [], sessionId: 'session_owner', authenticatedAt: iso(at - 60_000), correlationId: 'fixture' },
    membership: { id: 'member', actorId: 'owner', organizationId: 'buyer', environment: 'simulation', principalKind: 'human',
      version: 1, organizationEpoch: 0, roles: ['owner'], status: 'ACTIVE', validFrom: iso(at - 86_400_000), expiresAt: null,
      subject: 'user_owner', externalMembershipId: 'external_member', grantBasis: 'clerk_admin_bootstrap' },
    session: { id: 'session_owner', actorId: 'owner', organizationId: 'buyer', environment: 'simulation', subject: 'user_owner',
      externalOrganizationId: 'org_buyer', externalMembershipId: 'external_member', externalRole: 'org:admin',
      membershipId: 'member', membershipVersion: 1, organizationVersion: 1, organizationEpoch: 0, status: 'ACTIVE',
      authenticatedAt: iso(at - 60_000), expiresAt: iso(at + 60_000), membershipObservedAt: iso(at - 1000),
      issuer: 'https://synthetic.invalid', tokenHash: 'a'.repeat(64) },
    factors: { reference: { id: 'private_factor_evidence', version: 1, hash: 'b'.repeat(64) }, purpose: 'supplier_scope_policy',
      pair: { ...pair }, requestDigest: await supplierScopePolicyCommandDigest(input, 'owner'), sessionId: 'session_owner', subject: 'user_owner',
      externalOrganizationId: 'org_buyer', externalMembershipId: 'external_member', issuer: 'https://synthetic.invalid', tokenHash: 'a'.repeat(64),
      tokenIssuedAt: iso(at - 10_000), observedAt: iso(at), expiresAt: iso(at + 20_000),
      firstFactorAt: iso(at - 60_000), secondFactorAt: iso(at - 60_000) },
    buyerSites: (selected?.buyerSiteIds ?? []).map(id => ({ environment: 'simulation', organizationId: 'buyer', id })),
    categoryHistory: { pair: { ...pair }, head: current === null ? null : reference(current),
      entries: (selected?.categories ?? []).map(category => ({ id: category.id, category: known.find(value => value.id === category.id) ?? null })) },
  });
}
function readFacts(current: SupplierScopePolicySnapshot | null, at = NOW): SupplierScopePolicyReadFacts {
  return { schemaVersion: 1, pair: { ...pair }, observedAt: iso(at), expiresAt: iso(at + 20_000),
    organizations: { buyer: organization('buyer'), supplier: organization('supplier') }, head: current === null ? null : reference(current) };
}
async function transition(current: SupplierScopePolicySnapshot | null, payload: SupplierScopePolicyCommand['payload'], at = NOW, known?: SupplierScopeCategory[]) {
  const input = request(current, payload), context = await facts(input, current, at, known);
  const result = await planSupplierScopePolicyMutation(input, context, current, null, iso(at));
  if (result.kind !== 'PROPOSED_TRANSITION') throw new Error('Expected a new pure proposal.');
  return result;
}
async function relationship(version = 1, at = NOW) {
  const scope = { ...pair, supplierRelationshipId: 'relationship' };
  const proposal = { schemaVersion: 1 as const, scope, version, previousVersionHash: version === 1 ? null : 'c'.repeat(64),
    terms: { buyerSiteIds: ['site_one'], serviceCategoryIds: ['delivery'], expiresAt: iso(at + 3_600_000) },
    createdBy: { actorId: 'owner', organizationId: 'buyer', membershipId: 'member', membershipVersion: 1, organizationVersion: 1, organizationEpoch: 0 },
    createdAt: iso(at) };
  const proposalRef = { id: 'relationship', version, hash: await supplierRelationshipProposalDigest(proposal) };
  const receipt = { identity: { scope, actorId: 'owner', organizationId: 'buyer', idempotencyKey: 'relationship_revision_' + version },
    commandDigest: 'd'.repeat(64), result: { scope, revision: version, proposal: proposalRef, status: 'PROPOSED' as const }, recordedAt: iso(at) };
  const projection = { kind: 'RELATIONSHIP_STATUS_ONLY' as const, scope, revision: version + 2, proposal: proposalRef, status: 'ACTIVE' as const,
    expiresAt: proposal.terms.expiresAt, viewerParty: 'buyer' as const, current: true, approvalsRecorded: { buyer: true, supplier: true },
    relationshipGate: 'SATISFIED' as const, gateReason: null, authentication: 'NOT_ESTABLISHED' as const,
    businessVerification: 'NOT_ESTABLISHED' as const, payeeVerification: 'NOT_ESTABLISHED' as const,
    bookingAuthority: false as const, contractualAcceptance: false as const, paymentAuthority: false as const };
  return { proposal, receipt, projection };
}
afterEach(() => vi.restoreAllMocks());

describe('current access with historical policy identity and gate precedence', () => {
  it('recovers unchanged originals across current authority changes but denies a new append with the old stamp', async () => {
    const original = await transition(null, { action: 'issue', terms: terms() });
    const current = (await transition(original.next, { action: 'revoke' })).next;
    for (const changed of ['version', 'epoch', 'both']) {
      const input = request(null, { action: 'issue', terms: terms() });
      const context = await facts(input, current, NOW + 1000);
      if (changed !== 'epoch') context.organizations.buyer.version = context.session.organizationVersion = 2;
      if (changed !== 'version') {
        context.organizations.buyer.authorityEpoch = context.membership.organizationEpoch = context.session.organizationEpoch = 1;
      }
      const recovered = await planSupplierScopePolicyMutation(input, context, current, original.receipt, iso(NOW + 1000));
      expect(recovered).toMatchObject({ kind: 'EXACT_REPLAY', originalReceipt: original.receipt,
        current: { reference: reference(current), status: 'REVOKED' } });
      expect('next' in recovered).toBe(false);
      await expect(planSupplierScopePolicyMutation(input, context, current, null, iso(NOW + 1000)))
        .rejects.toMatchObject({ code: 'SUPPLIER_SCOPE_POLICY_ACCESS_DENIED' });
      input.command.buyerOrganizationVersion = context.organizations.buyer.version;
      input.command.authorityEpoch = context.organizations.buyer.authorityEpoch;
      context.factors.requestDigest = await supplierScopePolicyCommandDigest(input, 'owner');
      await expect(planSupplierScopePolicyMutation(input, context, current, original.receipt, iso(NOW + 1000)))
        .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    }
  });

  it('places failed scope before stale approvals while preserving earlier blocked reasons and never promoting a gate', async () => {
    const original = (await transition(null, { action: 'issue', terms: terms() })).next;
    const relation = await relationship();
    const binding = await bindSupplierRelationshipScopePolicy(relation.proposal, relation.receipt, original, readFacts(original), null, iso(NOW));
    const renewed = (await transition(original, { action: 'replace', terms: terms() })).next;
    const approvalBlocked = { ...relation.projection, relationshipGate: 'BLOCKED', gateReason: 'APPROVAL_NOT_CURRENT' };
    expect(await applySupplierRelationshipScopePolicy(approvalBlocked, binding, relation.proposal, renewed, readFacts(renewed), iso(NOW)))
      .toMatchObject({ relationshipGate: 'BLOCKED', gateReason: 'SCOPE_NOT_CURRENT' });
    expect(await applySupplierRelationshipScopePolicy(approvalBlocked, binding, relation.proposal, original, readFacts(original), iso(NOW)))
      .toEqual(approvalBlocked);
    const earlier = [
      { ...relation.projection, current: false, relationshipGate: 'BLOCKED', gateReason: 'NOT_CURRENT_REVISION' },
      { ...relation.projection, status: 'REVOKED', approvalsRecorded: { buyer: false, supplier: false }, relationshipGate: 'BLOCKED', gateReason: 'NOT_ACTIVE' },
      { ...relation.projection, expiresAt: iso(NOW), relationshipGate: 'BLOCKED', gateReason: 'PROPOSAL_EXPIRED' },
      { ...relation.projection, relationshipGate: 'BLOCKED', gateReason: 'SCOPE_NOT_CURRENT' },
    ];
    for (const projection of earlier) {
      expect(await applySupplierRelationshipScopePolicy(projection, binding, relation.proposal, renewed, readFacts(renewed), iso(NOW)))
        .toEqual(projection);
    }
  });
});

describe('pure buyer-issued scope policy', () => {
  it('issues an immutable exact-pair decision without role, site, grant or financial effects', async () => {
    const created = await transition(null, { action: 'issue', terms: terms() });
    expect(created).toMatchObject({ kind: 'PROPOSED_TRANSITION', authentication: 'NOT_ESTABLISHED', persistence: 'NOT_ESTABLISHED',
      supplierRoleGranted: false, participationGranted: false, bookingAuthority: false, contractualAcceptance: false, paymentAuthority: false });
    expect(created.next.policy).toMatchObject({ pair, version: 1, predecessor: null, status: 'ACTIVE', issuedAt: iso(NOW), validFrom: iso(NOW), expiresAt: iso(NOW + 3_600_000) });
    expect(created.receipt.result).toEqual(created.next);
    expect(created.next.policyHash).toBe(await supplierScopePolicyDigest(created.next.policy));
    expect(Object.isFrozen(created.next.policy.categories[0])).toBe(true);
  });
  it('permits one millisecond and thirty days, and caps only configured durable issuer ends', async () => {
    for (const requestedValidityMs of [1, 30 * 86_400_000]) {
      const value = await transition(null, { action: 'issue', terms: { ...terms(), requestedValidityMs } });
      expect(value.next.policy.expiresAt).toBe(iso(NOW + requestedValidityMs));
    }
    const input = request(null, { action: 'issue', terms: terms() }), context = await facts(input, null);
    context.membership.expiresAt = iso(NOW + 1500);
    context.organizations.buyer.expiresAt = iso(NOW + 1000);
    const value = await planSupplierScopePolicyMutation(input, context, null, null, iso(NOW));
    expect(value.kind === 'PROPOSED_TRANSITION' && value.next.policy.expiresAt).toBe(iso(NOW + 1000));
  });
  it('namespaces normalized meanings by ordered pair and retains exact interior content', async () => {
    const hash = await supplierScopeCategoryDigest(pair, definition);
    expect(await supplierScopeCategoryDigest(pair, { ...definition, label: '  Delivery  ', definition: '  ' + definition.definition + '  ' })).toBe(hash);
    for (const changedPair of [{ ...pair, supplierOrganizationId: 'other' }, { ...pair, environment: 'development' },
      { ...pair, buyerOrganizationId: 'supplier', supplierOrganizationId: 'buyer' }]) {
      expect(await supplierScopeCategoryDigest(changedPair, definition)).not.toBe(hash);
    }
    expect(await supplierScopeCategoryDigest(pair, { ...definition, definition: definition.definition.replace('sealed goods', 'sealed  goods') })).not.toBe(hash);
  });
  it('requires exact latest predecessor and rejects stale head or tampered content', async () => {
    const first = (await transition(null, { action: 'issue', terms: terms() })).next;
    const second = (await transition(first, { action: 'replace', terms: terms() })).next;
    const stale = request(first, { action: 'replace', terms: terms() });
    await expect(planSupplierScopePolicyMutation(stale, await facts(stale, second), second, null, iso(NOW)))
      .rejects.toMatchObject({ code: 'SUPPLIER_SCOPE_POLICY_VERSION_CONFLICT' });
    const wrongHash = request(second, { action: 'replace', terms: terms() });
    wrongHash.command.predecessor = { ...reference(second), hash: 'e'.repeat(64) };
    await expect(planSupplierScopePolicyMutation(wrongHash, await facts(wrongHash, second), second, null, iso(NOW)))
      .rejects.toMatchObject({ code: 'SUPPLIER_SCOPE_POLICY_VERSION_CONFLICT' });
    const input = request(second, { action: 'revoke' }), context = await facts(input, second);
    context.head = reference(first);
    await expect(planSupplierScopePolicyMutation(input, context, second, null, iso(NOW))).rejects.toMatchObject({ code: 'SUPPLIER_SCOPE_POLICY_VERSION_CONFLICT' });
    const altered = structuredClone(second);
    altered.policy.categories[0]!.definition = 'Altered bytes.';
    await expect(planSupplierScopePolicyMutation(input, await facts(input, altered), altered, null, iso(NOW))).rejects.toMatchObject({ code: 'SUPPLIER_SCOPE_POLICY_HASH_CONFLICT' });
  });
  it('rejects a command for another ordered pair or a stale buyer authority stamp', async () => {
    const input = request(null, { action: 'issue', terms: terms() });
    const context = await facts(input, null);
    for (const changed of [
      { ...input, command: { ...input.command, pair: { ...pair, supplierOrganizationId: 'other' } } },
      { ...input, command: { ...input.command, pair: { ...pair, buyerOrganizationId: 'supplier', supplierOrganizationId: 'buyer' } } },
      { ...input, command: { ...input.command, buyerOrganizationVersion: 2 } },
      { ...input, command: { ...input.command, authorityEpoch: 1 } },
    ]) {
      context.factors.requestDigest = await supplierScopePolicyCommandDigest(changed, 'owner');
      await expect(planSupplierScopePolicyMutation(changed, context, null, null, iso(NOW)))
        .rejects.toMatchObject({ code: 'SUPPLIER_SCOPE_POLICY_ACCESS_DENIED' });
    }
  });
  it('retains meanings after removal and revocation, requiring a new ID for changed meaning', async () => {
    const first = (await transition(null, { action: 'issue', terms: terms() })).next;
    const removed = (await transition(first, { action: 'replace', terms: { ...terms(), categories: [storage] } })).next;
    const historical = [...first.policy.categories, ...removed.policy.categories];
    for (const current of [removed, (await transition(removed, { action: 'revoke' })).next]) {
      const input = request(current, { action: 'replace', terms: { ...terms(), categories: [{ ...definition, definition: 'A different meaning.' }] } });
      await expect(planSupplierScopePolicyMutation(input, await facts(input, current, NOW, historical), current, null, iso(NOW)))
        .rejects.toMatchObject({ code: 'SUPPLIER_SCOPE_POLICY_CATEGORY_MEANING_CONFLICT' });
    }
    const restored = await transition(removed, { action: 'replace', terms: terms() }, NOW, historical);
    expect(restored.next.policy.categories).toEqual(first.policy.categories);
    const renamed = await transition(restored.next, { action: 'replace', terms: { ...terms(), categories: [{ ...definition, id: 'delivery_v2', definition: 'A different meaning.' }] } }, NOW, historical);
    expect(renamed.next.policy.categories[0]!.id).toBe('delivery_v2');
  });
  it('rejects missing, duplicate, foreign or stale site/category lookup facts', async () => {
    const input = request(null, { action: 'issue', terms: terms() });
    const changes: Array<(value: SupplierScopePolicyIssuerFacts) => void> = [
      value => { value.buyerSites = []; },
      value => { value.buyerSites[0]!.organizationId = 'supplier'; },
      value => { value.buyerSites[0]!.environment = 'production'; },
      value => { value.buyerSites[0]!.id = 'unknown'; },
      value => { value.buyerSites.push(value.buyerSites[0]!); },
      value => { value.categoryHistory.entries = []; },
      value => { value.categoryHistory.entries[0]!.id = 'other'; },
      value => { value.categoryHistory.entries.push(value.categoryHistory.entries[0]!); },
      value => { value.categoryHistory.pair.supplierOrganizationId = 'other'; },
      value => { value.categoryHistory.head = { pair, version: 1, hash: 'a'.repeat(64) }; },
    ];
    for (const change of changes) {
      const context = await facts(input, null); change(context);
      await expect(planSupplierScopePolicyMutation(input, context, null, null, iso(NOW))).rejects.toThrow();
    }
  });
  it('revokes immediately while preserving audit definitions and permits only a fresh replacement', async () => {
    const original = (await transition(null, { action: 'issue', terms: terms() })).next;
    const revoked = (await transition(original, { action: 'revoke' })).next;
    expect(revoked.policy).toMatchObject({ version: 2, status: 'REVOKED', expiresAt: iso(NOW), validFrom: iso(NOW), categories: original.policy.categories });
    await expect(transition(revoked, { action: 'revoke' })).rejects.toMatchObject({ code: 'SUPPLIER_SCOPE_POLICY_ALREADY_REVOKED' });
    const renewed = (await transition(revoked, { action: 'replace', terms: terms() })).next;
    expect(renewed.policy).toMatchObject({ version: 3, status: 'ACTIVE', predecessor: reference(revoked) });
    const expiredAt = NOW + 3_600_000;
    expect((await transition(original, { action: 'replace', terms: terms() }, expiredAt)).next.policy.issuedAt).toBe(iso(expiredAt));
  });
  it('does not treat a current category as new when the history lookup contradicts the head', async () => {
    const current = (await transition(null, { action: 'issue', terms: terms() })).next;
    const input = request(current, { action: 'replace', terms: { ...terms(), categories: [{ ...definition, definition: 'Changed meaning.' }] } });
    const context = await facts(input, current);
    context.categoryHistory.entries[0]!.category = null;
    await expect(planSupplierScopePolicyMutation(input, context, current, null, iso(NOW)))
      .rejects.toMatchObject({ code: 'SUPPLIER_SCOPE_POLICY_CATEGORY_HISTORY_CONFLICT' });
  });
});

describe('current private buyer identity and original factor facts', () => {
  it('rejects stale, revoked, service, wrong-party or mismatched issuer facts', async () => {
    const input = request(null, { action: 'issue', terms: terms() });
    const changes: Array<(value: SupplierScopePolicyIssuerFacts) => void> = [
      value => { value.actor.principalKind = 'service'; value.membership.principalKind = 'service'; },
      value => { value.actor.roles = ['supplier_admin']; value.membership.roles = ['supplier_admin']; },
      value => { value.actor.organizationId = 'supplier'; },
      value => { value.membership.status = 'REVOKED'; },
      value => { value.membership.version++; },
      value => { value.membership.expiresAt = iso(NOW); },
      value => { value.membership.externalMembershipId = 'other'; },
      value => { value.membership.subject = 'other'; },
      value => { value.session.externalOrganizationId = 'other'; },
      value => { value.session.externalRole = 'org:member'; },
      value => { value.session.status = 'REVOKED'; },
      value => { value.session.expiresAt = iso(NOW); },
      value => { value.session.membershipObservedAt = iso(NOW - 20_001); },
      value => { value.organizations.buyer.version++; },
      value => { value.organizations.buyer.authorityEpoch++; },
      value => { value.organizations.buyer.status = 'SUSPENDED'; },
      value => { value.organizations.supplier.id = 'other'; },
      value => { value.organizations.supplier.environment = 'production'; },
      value => { value.observedAt = iso(NOW - 20_001); },
    ];
    for (const change of changes) {
      const context = await facts(input, null); change(context);
      await expect(planSupplierScopePolicyMutation(input, context, null, null, iso(NOW))).rejects.toMatchObject({ code: 'SUPPLIER_SCOPE_POLICY_ACCESS_DENIED' });
    }
  });
  it('requires both genuine-purpose factors within five minutes and original observations within twenty seconds', async () => {
    const input = request(null, { action: 'issue', terms: terms() });
    const boundary = await facts(input, null);
    boundary.observedAt = boundary.factors.observedAt = boundary.session.membershipObservedAt = iso(NOW - 20_000);
    boundary.expiresAt = boundary.factors.expiresAt = iso(NOW + 1000);
    boundary.factors.tokenIssuedAt = iso(NOW - 20_000);
    boundary.factors.firstFactorAt = boundary.factors.secondFactorAt = iso(NOW - 300_000);
    expect((await planSupplierScopePolicyMutation(input, boundary, null, null, iso(NOW))).kind).toBe('PROPOSED_TRANSITION');
    const changes: Array<(value: SupplierScopePolicyIssuerFacts) => void> = [
      value => { value.factors.firstFactorAt = iso(NOW - 300_001); },
      value => { value.factors.secondFactorAt = iso(NOW - 300_001); },
      value => { value.factors.firstFactorAt = iso(NOW + 1); },
      value => { value.factors.observedAt = iso(NOW - 20_001); },
      value => { value.factors.observedAt = iso(NOW + 1); },
      value => { value.factors.expiresAt = iso(NOW); },
      value => { value.factors.externalMembershipId = 'other'; },
      value => { value.factors.pair.supplierOrganizationId = 'other'; },
      value => { value.factors.tokenHash = 'c'.repeat(64); },
      value => { value.factors.sessionId = 'other'; },
    ];
    for (const change of changes) {
      const context = await facts(input, null); change(context);
      await expect(planSupplierScopePolicyMutation(input, context, null, null, iso(NOW))).rejects.toMatchObject({ code: 'SUPPLIER_SCOPE_POLICY_FRESH_FACTORS_REQUIRED' });
    }
    const context = await facts(input, null);
    await expect(planSupplierScopePolicyMutation(input, { ...context, factors: { ...context.factors, purpose: 'member_access' } }, null, null, iso(NOW))).rejects.toThrow();
    context.factors.requestDigest = 'f'.repeat(64);
    await expect(planSupplierScopePolicyMutation(input, context, null, null, iso(NOW))).rejects.toMatchObject({ code: 'SUPPLIER_SCOPE_POLICY_EVIDENCE_CONFLICT' });
  });
  it('requires an active counterparty for issuance but permits buyer revocation while it is suspended', async () => {
    const original = (await transition(null, { action: 'issue', terms: terms() })).next;
    for (const payload of [{ action: 'replace', terms: terms() }, { action: 'revoke' }] as const) {
      const input = request(original, payload), context = await facts(input, original);
      context.organizations.supplier.status = 'SUSPENDED';
      const pending = planSupplierScopePolicyMutation(input, context, original, null, iso(NOW));
      if (payload.action === 'replace') await expect(pending).rejects.toMatchObject({ code: 'SUPPLIER_SCOPE_POLICY_ORGANIZATION_INACTIVE' });
      else expect((await pending).kind).toBe('PROPOSED_TRANSITION');
    }
  });
});

describe('exact replay without restoration', () => {
  it('returns the original immutable result after revocation, never a next active version', async () => {
    const original = await transition(null, { action: 'issue', terms: terms() });
    const current = (await transition(original.next, { action: 'revoke' })).next;
    const input = request(null, { action: 'issue', terms: terms() });
    const result = await planSupplierScopePolicyMutation(input, await facts(input, current), current, original.receipt, iso(NOW));
    expect(result).toMatchObject({ kind: 'EXACT_REPLAY', originalReceipt: original.receipt, current: { reference: reference(current), status: 'REVOKED' } });
    expect('next' in result).toBe(false);
  });
  it('rejects altered replay content, actor, pair, receipt and current issuer authority', async () => {
    const original = await transition(null, { action: 'issue', terms: terms() });
    const altered = request(null, { action: 'issue', terms: { ...terms(), requestedValidityMs: 1000 } });
    await expect(planSupplierScopePolicyMutation(altered, await facts(altered, original.next), original.next, original.receipt, iso(NOW))).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    const input = request(null, { action: 'issue', terms: terms() }), context = await facts(input, original.next);
    context.membership.status = 'REVOKED';
    await expect(planSupplierScopePolicyMutation(input, context, original.next, original.receipt, iso(NOW))).rejects.toMatchObject({ code: 'SUPPLIER_SCOPE_POLICY_ACCESS_DENIED' });
    for (const mutate of [
      (value: typeof original.receipt) => { value.identity.actorId = 'other'; },
      (value: typeof original.receipt) => { value.identity.pair.supplierOrganizationId = 'other'; },
      (value: typeof original.receipt) => { value.result.policy.categories[0]!.definition = 'Changed receipt result.'; },
      (value: typeof original.receipt) => { value.result.policyHash = 'f'.repeat(64); },
    ]) {
      const changed = structuredClone(original.receipt); mutate(changed);
      await expect(planSupplierScopePolicyMutation(input, await facts(input, original.next), original.next, changed, iso(NOW))).rejects.toThrow();
    }
  });
  it('allows a fresh current owner to replace a departed issuer but not recover the old actor receipt', async () => {
    const original = await transition(null, { action: 'issue', terms: terms() });
    const input = request(original.next, { action: 'replace', terms: terms() });
    const context = await facts(input, original.next);
    context.actor.actorId = context.membership.actorId = context.session.actorId = 'new_owner';
    context.actor.sessionId = context.session.id = context.factors.sessionId = 'new_session';
    context.membership.id = context.session.membershipId = 'new_member';
    context.membership.subject = context.session.subject = context.factors.subject = 'new_subject';
    context.membership.externalMembershipId = context.session.externalMembershipId = context.factors.externalMembershipId = 'new_external_member';
    context.factors.requestDigest = await supplierScopePolicyCommandDigest(input, 'new_owner');
    const next = await planSupplierScopePolicyMutation(input, context, original.next, null, iso(NOW));
    expect(next.kind === 'PROPOSED_TRANSITION' && next.next.policy.issuer.actorId).toBe('new_owner');
    const replay = request(null, { action: 'issue', terms: terms() });
    context.factors.requestDigest = await supplierScopePolicyCommandDigest(replay, 'new_owner');
    await expect(planSupplierScopePolicyMutation(replay, context, original.next, original.receipt, iso(NOW)))
      .rejects.toMatchObject({ code: 'SUPPLIER_SCOPE_POLICY_RECEIPT_CONFLICT' });
  });
  it('snapshots all inputs before hash callbacks, including private facts and receipts', async () => {
    const original = await transition(null, { action: 'issue', terms: terms() });
    const current = structuredClone(original.next), input = request(null, { action: 'issue', terms: terms() });
    const context = await facts(input, current), receipt = structuredClone(original.receipt);
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (algorithm, data) => { await gate; return digest(algorithm, data); });
    const pending = planSupplierScopePolicyMutation(input, context, current, receipt, iso(NOW));
    current.policy.categories[0]!.definition = 'Changed while hashing.';
    input.command.payload = { action: 'issue', terms: { ...terms(), buyerSiteIds: ['other'] } };
    context.membership.roles = ['supplier_admin'];
    context.categoryHistory.entries = [];
    receipt.result.policyHash = 'f'.repeat(64);
    release();
    const result = await pending;
    expect(result).toMatchObject({ kind: 'EXACT_REPLAY', originalReceipt: original.receipt });
    expect(Object.isFrozen(current)).toBe(false);
  });
});

describe('private relationship policy pin and frozen public gate', () => {
  it('blocks missing, revoked, expired, wrong-pair and superseded policy pins', async () => {
    const original = (await transition(null, { action: 'issue', terms: terms() })).next;
    const relation = await relationship();
    const binding = await bindSupplierRelationshipScopePolicy(relation.proposal, relation.receipt, original, readFacts(original), null, iso(NOW));
    expect((await assessSupplierRelationshipScopePolicy(binding, relation.proposal, original, readFacts(original), iso(NOW))).relationshipGate).toBe('SATISFIED');
    const revoked = (await transition(original, { action: 'revoke' })).next;
    const renewed = (await transition(revoked, { action: 'replace', terms: terms() })).next;
    for (const current of [null, revoked, renewed]) {
      const gate = await assessSupplierRelationshipScopePolicy(binding, relation.proposal, current, readFacts(current), iso(NOW));
      expect(gate).toMatchObject({ relationshipGate: 'BLOCKED', gateReason: 'SCOPE_NOT_CURRENT' });
    }
    expect((await assessSupplierRelationshipScopePolicy(null, relation.proposal, original, readFacts(original), iso(NOW))).relationshipGate).toBe('BLOCKED');
    const expiredAt = NOW + 3_600_000;
    expect((await assessSupplierRelationshipScopePolicy(binding, relation.proposal, original, readFacts(original, expiredAt), iso(expiredAt))).relationshipGate).toBe('BLOCKED');
    const other = readFacts(original); other.pair = { ...pair, supplierOrganizationId: 'other' };
    other.organizations.supplier = { ...other.organizations.supplier, id: 'other', externalOrganizationId: 'org_other' };
    other.head = { ...reference(original), pair: other.pair };
    expect((await assessSupplierRelationshipScopePolicy(binding, relation.proposal, original, other, iso(NOW))).relationshipGate).toBe('BLOCKED');
  });
  it('requires a fresh revision under renewal and never overrides missing approvals or terminal relationship revocation', async () => {
    const original = (await transition(null, { action: 'issue', terms: terms() })).next, relation = await relationship();
    const oldBinding = await bindSupplierRelationshipScopePolicy(relation.proposal, relation.receipt, original, readFacts(original), null, iso(NOW));
    const renewed = (await transition(original, { action: 'replace', terms: terms() })).next;
    await expect(bindSupplierRelationshipScopePolicy(relation.proposal, relation.receipt, renewed, readFacts(renewed), oldBinding, iso(NOW)))
      .rejects.toMatchObject({ code: 'SUPPLIER_SCOPE_POLICY_BINDING_EXISTS' });
    expect(await applySupplierRelationshipScopePolicy(relation.projection, oldBinding, relation.proposal, renewed, readFacts(renewed), iso(NOW)))
      .toMatchObject({ relationshipGate: 'BLOCKED', gateReason: 'SCOPE_NOT_CURRENT' });
    const revised = await relationship(2);
    const newBinding = await bindSupplierRelationshipScopePolicy(revised.proposal, revised.receipt, renewed, readFacts(renewed), null, iso(NOW));
    const proposed = { ...revised.projection, status: 'PROPOSED', approvalsRecorded: { buyer: false, supplier: false }, relationshipGate: 'BLOCKED', gateReason: 'NOT_ACTIVE' };
    expect(await applySupplierRelationshipScopePolicy(proposed, newBinding, revised.proposal, renewed, readFacts(renewed), iso(NOW)))
      .toMatchObject({ status: 'PROPOSED', relationshipGate: 'BLOCKED', gateReason: 'NOT_ACTIVE' });
    const revoked = { ...proposed, status: 'REVOKED' };
    expect(await applySupplierRelationshipScopePolicy(revoked, newBinding, revised.proposal, renewed, readFacts(renewed), iso(NOW)))
      .toMatchObject({ status: 'REVOKED', relationshipGate: 'BLOCKED', gateReason: 'NOT_ACTIVE' });
    expect(await applySupplierRelationshipScopePolicy(revised.projection, newBinding, revised.proposal, renewed, readFacts(renewed), iso(NOW))).toEqual(revised.projection);
  });
  it('keeps issued policy valid after issuer departure while current organization suspension still blocks', async () => {
    const current = (await transition(null, { action: 'issue', terms: terms() })).next, relation = await relationship();
    const binding = await bindSupplierRelationshipScopePolicy(relation.proposal, relation.receipt, current, readFacts(current), null, iso(NOW));
    // There is deliberately no issuer membership in policy-read facts.
    const changed = readFacts(current); changed.organizations.buyer.version++; changed.organizations.buyer.authorityEpoch++;
    expect((await assessSupplierRelationshipScopePolicy(binding, relation.proposal, current, changed, iso(NOW))).relationshipGate).toBe('SATISFIED');
    changed.organizations.buyer.status = 'SUSPENDED';
    expect((await assessSupplierRelationshipScopePolicy(binding, relation.proposal, current, changed, iso(NOW))).relationshipGate).toBe('BLOCKED');
  });
  it('rejects binding an old proposal, substituted receipt or a proposal outside policy scope', async () => {
    const current = (await transition(null, { action: 'issue', terms: terms() })).next, relation = await relationship();
    await expect(bindSupplierRelationshipScopePolicy(relation.proposal, relation.receipt, current, readFacts(current, NOW + 1), null, iso(NOW + 1)))
      .rejects.toMatchObject({ code: 'SUPPLIER_SCOPE_POLICY_NOT_CURRENT' });
    await expect(bindSupplierRelationshipScopePolicy(relation.proposal, { ...relation.receipt, identity: { ...relation.receipt.identity, actorId: 'other' } },
      current, readFacts(current), null, iso(NOW))).rejects.toMatchObject({ code: 'SUPPLIER_SCOPE_POLICY_NOT_CURRENT' });
    const outside = { ...relation.proposal, terms: { ...relation.proposal.terms, serviceCategoryIds: ['unknown'] } };
    await expect(bindSupplierRelationshipScopePolicy(outside, relation.receipt, current, readFacts(current), null, iso(NOW)))
      .rejects.toMatchObject({ code: 'SUPPLIER_SCOPE_POLICY_NOT_CURRENT' });
  });
  it('snapshots private policy binding, proposal, current policy and read facts before hashing', async () => {
    const current = (await transition(null, { action: 'issue', terms: terms() })).next, relation = await relationship();
    const binding = await bindSupplierRelationshipScopePolicy(relation.proposal, relation.receipt, current, readFacts(current), null, iso(NOW));
    const copy = structuredClone(binding), policy = structuredClone(current), proposal = structuredClone(relation.proposal), context = readFacts(current);
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (algorithm, data) => { await gate; return digest(algorithm, data); });
    const pending = assessSupplierRelationshipScopePolicy(copy, proposal, policy, context, iso(NOW));
    copy.policy.version++; proposal.terms.serviceCategoryIds = ['changed']; policy.policy.status = 'REVOKED';
    context.organizations.buyer.status = 'SUSPENDED'; release();
    expect((await pending).relationshipGate).toBe('SATISFIED');
  });
});
