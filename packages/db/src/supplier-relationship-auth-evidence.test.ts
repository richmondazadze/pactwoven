import { afterEach, describe, expect, it, vi } from 'vitest';
import { SupplierAuthenticationEvidenceSchema, snapshotSupplierAuthenticationEvidence } from './supplier-relationship-auth-evidence.js';
import { snapshotSupplierPersistenceRequest } from './supplier-relationship-persistence-schema.js';

const NOW = Date.parse('2026-11-16T12:00:00.000Z'), iso = (at: number) => new Date(at).toISOString(), H = 'a'.repeat(64);
const pair = { environment: 'simulation', buyerOrganizationId: 'buyer', supplierOrganizationId: 'supplier' }, scope = { ...pair, supplierRelationshipId: 'relationship' };
const actor = () => ({ environment: 'simulation', organizationId: 'buyer', actorId: 'owner', principalKind: 'human',
  membershipId: 'member', membershipVersion: 1, organizationVersion: 1, organizationEpoch: 0,
  subject: 'subject', externalOrganizationId: 'org_buyer', externalMembershipId: 'ext_member', sessionId: 'session' });
const binding = () => ({ reference: { id: 'private_binding', version: 1, hash: H }, environment: 'simulation', effectiveOrganizationId: 'buyer',
  verifier: { oid: 101, name: 'supplier_verifier' }, authorizer: { oid: 102, name: 'supplier_authorizer' }, status: 'ACTIVE', validFrom: iso(NOW - 3_600_000), expiresAt: iso(NOW + 3_600_000) });
const command = () => ({ kind: 'relationship-command', purpose: 'supplier_relationship_create', mutation: {
  idempotencyKey: 'relationship_create_request', command: { scope, expectedVersion: 0, mandateVersion: null, authorityEpoch: 0, targetProposal: null,
    payload: { action: 'create', terms: { buyerSiteIds: ['site'], serviceCategoryIds: ['delivery'], expiresAt: iso(NOW + 3_600_000) } } },
} });
async function fixture(requestInput: unknown = command()) {
  const who = actor(), principal = binding();
  const request = await snapshotSupplierPersistenceRequest(requestInput, { environment: who.environment, organizationId: who.organizationId, actorId: who.actorId });
  const observation = { subject: who.subject, externalOrganizationId: who.externalOrganizationId, externalMembershipId: who.externalMembershipId,
    externalRole: 'org:admin', sessionId: who.sessionId, authenticatedAt: iso(NOW - 120_000), membershipObservedAt: iso(NOW - 1000),
    issuer: 'https://synthetic.invalid', tokenHash: H, tokenIssuedAt: iso(NOW - 10_000), sessionExpiresAt: iso(NOW + 60_000),
    observedAt: iso(NOW), expiresAt: iso(NOW + 20_000) };
  const source = { kind: 'CLERK_FVA', tokenHash: H, tokenIssuedAt: observation.tokenIssuedAt,
    firstFactorAgeMinutes: 0, secondFactorAgeMinutes: 0, firstFactorAt: iso(NOW - 70_000), secondFactorAt: iso(NOW - 70_000), verifiedAt: iso(NOW - 70_000) };
  const evidence = SupplierAuthenticationEvidenceSchema.parse({
    schemaVersion: 1, id: 'b5f81400-2222-4333-8444-123456789abc', actor: who, binding: principal, observedBy: principal.verifier,
    request: request.request, requestDigest: request.requestDigest, mutationDigest: request.mutationDigest,
    observation, observedAt: observation.observedAt, expiresAt: observation.expiresAt,
    ...(request.mutationDigest === null ? { kind: 'identity' } : { kind: 'factors', source }),
  });
  return { evidence, request: structuredClone(request.request), actor: who, binding: principal };
}
afterEach(() => vi.restoreAllMocks());

describe('supplier private source-bound evidence', () => {
  it('uses identity-only private plans that cannot be reused as a later command or public status', async () => {
    const request = { kind: 'relationship-observation-plan', purpose: 'supplier_relationship_observation_plan', query: { scope } };
    const data = await fixture(request);
    expect((await snapshotSupplierAuthenticationEvidence(data.evidence, request, data.actor, data.binding, iso(NOW))).evidence.kind).toBe('identity');
    await expect(snapshotSupplierAuthenticationEvidence(data.evidence, command(), data.actor, data.binding, iso(NOW))).rejects.toThrow();
    const status = { kind: 'relationship-status', purpose: 'supplier_relationship_status', query: { scope, revision: null } };
    await expect(snapshotSupplierAuthenticationEvidence(data.evidence, status, data.actor, data.binding, iso(NOW))).rejects.toThrow();
  });
  it('binds bounded original approval stamps to live membership-only observations and the exact new request', async () => {
    const proposal = { id: 'relationship', version: 1, hash: H };
    const base = command(), request = { ...base, purpose: 'supplier_relationship_revise', mutation: { ...base.mutation,
      command: { ...base.mutation.command, expectedVersion: 2, targetProposal: proposal,
        payload: { ...base.mutation.command.payload, action: 'revise' } } } };
    const data = await fixture(request), entry = {
      head: { scope, revision: 2, proposal, status: 'PROPOSED' as const },
      approval: { actorId: 'owner', organizationId: 'buyer', membershipId: 'member', membershipVersion: 1, organizationVersion: 1,
        organizationEpoch: 0, party: 'buyer' as const, proposal, approvedAt: iso(NOW - 1000), expiresAt: iso(NOW + 1000) },
      observation: { issuer: 'https://synthetic.invalid', subject: 'subject', externalOrganizationId: 'org_buyer', externalMembershipId: 'ext_member',
        externalRole: 'org:admin', status: 'ACTIVE' as const, observedAt: iso(NOW - 1000), expiresAt: iso(NOW + 20_000) },
    };
    const evidence = { ...data.evidence, approvers: [entry] };
    const snapshot = await snapshotSupplierAuthenticationEvidence(evidence, request, data.actor, data.binding, iso(NOW));
    expect(snapshot.evidence.approvers).toEqual([entry]);
    expect(Object.isFrozen(snapshot.evidence.approvers?.[0]?.observation)).toBe(true);
    for (const approvers of [
      [entry, entry], [entry, entry, entry],
      [{ ...entry, head: { ...entry.head, revision: 3 } }],
      [{ ...entry, head: { ...entry.head, scope: { ...scope, supplierOrganizationId: 'other' } } }],
      [{ ...entry, approval: { ...entry.approval, proposal: { ...proposal, hash: 'f'.repeat(64) } } }],
      [{ ...entry, observation: { ...entry.observation, issuer: 'https://other.invalid' } }],
      [{ ...entry, observation: { ...entry.observation, observedAt: iso(NOW - 20_001), expiresAt: iso(NOW + 1) } }],
      [{ ...entry, observation: { ...entry.observation, sessionId: 'invented_session' } }],
    ]) await expect(snapshotSupplierAuthenticationEvidence({ ...evidence, approvers }, request, data.actor, data.binding, iso(NOW))).rejects.toThrow();
    const plan = await fixture({ kind: 'relationship-observation-plan', purpose: 'supplier_relationship_observation_plan', query: { scope } });
    expect(SupplierAuthenticationEvidenceSchema.safeParse({ ...plan.evidence, approvers: [entry] }).success).toBe(false);
  });
  it('preserves original source times and returns no authenticated or persisted capability', async () => {
    const data = await fixture();
    const result = await snapshotSupplierAuthenticationEvidence(data.evidence, data.request, data.actor, data.binding, iso(NOW));
    expect(result).toMatchObject({ kind: 'STRUCTURAL_EVIDENCE_SNAPSHOT', authentication: 'NOT_ESTABLISHED',
      providerVerification: 'NOT_ESTABLISHED', persistence: 'NOT_ESTABLISHED' });
    expect(result.evidence.observation).toEqual(data.evidence.observation);
    expect(result.evidence.observedAt).toBe(iso(NOW));
    expect(Object.isFrozen(result.evidence.observation)).toBe(true);
    expect(Object.isFrozen(data.evidence)).toBe(false);
  });
  it('separates identity reads/recovery from mutation factor purposes', async () => {
    const query = { kind: 'relationship-status', purpose: 'supplier_relationship_status', query: { scope, revision: null } };
    const data = await fixture(query);
    expect(data.evidence.kind).toBe('identity');
    expect((await snapshotSupplierAuthenticationEvidence(data.evidence, query, data.actor, data.binding, iso(NOW))).evidence.kind).toBe('identity');
    const mutation = await fixture();
    const { source: _source, ...withoutSource } = mutation.evidence.kind === 'factors' ? mutation.evidence : { ...mutation.evidence, source: null };
    expect(SupplierAuthenticationEvidenceSchema.safeParse({ ...withoutSource, kind: 'identity' }).success).toBe(false);
    expect(SupplierAuthenticationEvidenceSchema.safeParse({ ...data.evidence, kind: 'factors', source: {} }).success).toBe(false);
    await expect(snapshotSupplierAuthenticationEvidence(data.evidence, command(), data.actor, data.binding, iso(NOW))).rejects.toThrow();
  });
  it('binds each scope-policy action and prevents issue/replace/revoke substitution', async () => {
    for (const action of ['issue', 'replace', 'revoke']) {
      const terms = { buyerSiteIds: ['site'], categories: [{ id: 'delivery', label: 'Delivery', definition: 'Transport sealed goods.' }], requestedValidityMs: 1000 };
      const request = { kind: 'policy-command', purpose: 'supplier_scope_policy_' + action, mutation: {
        idempotencyKey: 'scope_policy_' + action + '_request', command: { pair, expectedVersion: action === 'issue' ? 0 : 1,
          predecessor: action === 'issue' ? null : { pair, version: 1, hash: H }, buyerOrganizationVersion: 1, authorityEpoch: 0,
          payload: action === 'revoke' ? { action } : { action, terms } },
      } };
      const data = await fixture(request);
      expect((await snapshotSupplierAuthenticationEvidence(data.evidence, request, data.actor, data.binding, iso(NOW))).evidence.request.purpose).toBe(request.purpose);
      const changed = { ...data.evidence, request: { ...data.request, purpose: 'supplier_relationship_revoke' } };
      expect(SupplierAuthenticationEvidenceSchema.safeParse(changed).success).toBe(false);
    }
  });
  it('rejects future/stale observations, expired sessions/bindings and altered original factor times', async () => {
    const data = await fixture();
    if (data.evidence.kind !== 'factors') throw new Error('Expected factor fixture.');
    const e = data.evidence;
    for (const changed of [
      { ...e, observedAt: iso(NOW + 1) },
      { ...e, observation: { ...e.observation, tokenIssuedAt: iso(NOW + 1) } },
      { ...e, observation: { ...e.observation, membershipObservedAt: iso(NOW - 20_001) } },
      { ...e, source: { ...e.source, firstFactorAt: iso(NOW) } },
      { ...e, source: { ...e.source, secondFactorAt: iso(NOW) } },
      { ...e, source: { ...e.source, verifiedAt: iso(NOW) } },
      { ...e, source: { ...e.source, tokenHash: 'f'.repeat(64) } },
      { ...e, source: { ...e.source, tokenIssuedAt: iso(NOW) } },
      { ...e, observation: { ...e.observation, sessionExpiresAt: iso(NOW) } },
    ]) await expect(snapshotSupplierAuthenticationEvidence(changed, data.request, data.actor, data.binding, iso(NOW))).rejects.toThrow();
    await expect(snapshotSupplierAuthenticationEvidence(e, data.request, data.actor, data.binding, iso(NOW + 20_000))).rejects.toThrow();
    const revoked = { ...data.binding, status: 'REVOKED' };
    await expect(snapshotSupplierAuthenticationEvidence({ ...e, binding: revoked }, data.request, data.actor, revoked, iso(NOW))).rejects.toThrow();
  });
  it('uses conservative original FVA/token bounds at the exact five-minute boundary', async () => {
    const data = await fixture();
    if (data.evidence.kind !== 'factors') throw new Error('Expected factors.');
    const e = data.evidence;
    e.observation.tokenIssuedAt = iso(NOW);
    e.source.tokenIssuedAt = iso(NOW);
    e.source.firstFactorAgeMinutes = e.source.secondFactorAgeMinutes = 4;
    e.source.firstFactorAt = e.source.secondFactorAt = e.source.verifiedAt = iso(NOW - 300_000);
    expect((await snapshotSupplierAuthenticationEvidence(e, data.request, data.actor, data.binding, iso(NOW))).evidence.kind).toBe('factors');
    await expect(snapshotSupplierAuthenticationEvidence(e, data.request, data.actor, data.binding, iso(NOW + 1))).rejects.toThrow('five minutes');
    e.source.secondFactorAgeMinutes = 5;
    e.source.secondFactorAt = e.source.verifiedAt = iso(NOW - 360_000);
    await expect(snapshotSupplierAuthenticationEvidence(e, data.request, data.actor, data.binding, iso(NOW))).rejects.toThrow('five minutes');
  });
  it('refuses source refresh, extra provider secrets, different actor/version or different private verifier', async () => {
    const data = await fixture(), e = data.evidence;
    for (const extra of [{ token: 'raw_token' }, { secretKey: 'raw_key' }, { verified: true }, { role: 'owner' }, { grant: {} }]) {
      expect(SupplierAuthenticationEvidenceSchema.safeParse({ ...e, ...extra }).success).toBe(false);
    }
    expect(SupplierAuthenticationEvidenceSchema.safeParse({ ...e, observation: { ...e.observation, rawClaims: {} } }).success).toBe(false);
    await expect(snapshotSupplierAuthenticationEvidence(e, data.request, { ...data.actor, membershipVersion: 2 }, data.binding, iso(NOW))).rejects.toThrow();
    await expect(snapshotSupplierAuthenticationEvidence(e, data.request, data.actor, { ...data.binding, reference: { ...data.binding.reference, version: 2 } }, iso(NOW))).rejects.toThrow();
    expect(SupplierAuthenticationEvidenceSchema.safeParse({ ...e, observedBy: data.binding.authorizer }).success).toBe(false);
    const changed = structuredClone(e);
    changed.observedAt = changed.observation.observedAt = iso(NOW + 10_000);
    changed.expiresAt = changed.observation.expiresAt = iso(NOW + 30_000);
    await expect(snapshotSupplierAuthenticationEvidence(changed, data.request, data.actor, data.binding, iso(NOW + 30_001))).rejects.toThrow();
  });
  it('rejects altered command digests and retains every caller input before async hashing', async () => {
    const data = await fixture();
    await expect(snapshotSupplierAuthenticationEvidence({ ...data.evidence, requestDigest: 'f'.repeat(64) }, data.request, data.actor, data.binding, iso(NOW))).rejects.toThrow('digest');
    const original = structuredClone(data.evidence);
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (algorithm, bytes) => { await gate; return digest(algorithm, bytes); });
    const pending = snapshotSupplierAuthenticationEvidence(data.evidence, data.request, data.actor, data.binding, iso(NOW));
    data.evidence.observation.subject = 'changed';
    data.actor.membershipVersion++;
    data.binding.status = 'REVOKED';
    if (data.request.kind === 'relationship-command' && data.request.mutation.command.payload.action === 'create') {
      data.request.mutation.idempotencyKey = 'changed_original_key';
      data.evidence.request = { ...data.request, mutation: { ...data.request.mutation, idempotencyKey: 'changed_evidence_key' } };
    }
    release();
    expect((await pending).evidence).toEqual(original);
  });
});
