import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FinancialPolicyHttpRequestSchema, financialPolicyHttpRoute, type FinancialPolicyHttpScope,
  type FinancialPolicyHttpRecord, type FinancialPolicyHttpReceipt } from '@pactwoven/contracts';
import { createFinancialPolicyAttempt, financialPolicyPublicRequestHash, verifyFinancialPolicyAttempt,
  qualifyFinancialReceipt, qualifyFinancialRead, qualifyFinancialIndex, qualifyFinancialRecovery,
  qualifyFinancialRecordMaterial, FinancialPolicyReferenceSchema } from './financial-policy-contract';

const canonical = (v: unknown): string => v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v)
  ? `[${v.map(canonical).join(',')}]` : `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
const digest = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex');
const hash = 'a'.repeat(64), start = '2026-11-15T00:00:00.000Z', end = '2026-11-22T00:00:00.000Z';
const ref = (id = 'policy_a', version = 1) => ({ id, version, recordHash: hash });
const actor = { actorId: 'owner_a', membershipVersion: 1 };
const local = { environment: 'development' as const, organizationId: 'org_a', actorId: actor.actorId, responsibilityId: null, apiBase: 'https://api.example.test' };
const scope: FinancialPolicyHttpScope = { environment: 'development', organizationId: 'org_a', actor: { ...actor, membershipVersion: 8 },
  organizationEpoch: 2, roles: ['owner'], siteIds: ['site_a'], actionSiteIds: ['site_a'] };
const envelope = { schemaVersion: 1, scope, observation: { observedAt: start, expiresAt: '2026-11-15T00:00:20.000Z' }, effectiveAuthority: false, financialState: null };
function fixtures() {
  const asset = { key: 'b'.repeat(64), version: 1, recordHash: hash, financialUseEpoch: 0 };
  const budgetAccountId = digest({ namespace: 'pactwoven:financial-budget-account:v1', environment: local.environment,
    organizationId: local.organizationId, assetKey: asset.key, category: 'supplier_principal' });
  const period = { id: digest({ namespace: 'pactwoven:financial-budget-period:v1', budgetAccountId, startsAt: start, endsAt: end }), startsAt: start, endsAt: end };
  const bundle = { budgetAccountId, asset, category: 'supplier_principal', limits: { perOperation: '100', perResponsibility: '500', perPeriod: '1000' }, period,
    approval: { requesterRoles: ['finance', 'operations', 'owner'], approverRoles: ['finance', 'owner'], independent: true, actionSiteIds: ['site_a'],
      action: 'allocate_funds', category: 'supplier_principal', thresholdBaseUnits: '50', maximumAuthenticationAgeSeconds: 300, maximumApprovalAgeSeconds: 300 },
    documents: [{ ...ref('approval_doc'), purpose: 'approval_policy' }, { ...ref('budget_doc'), purpose: 'budget_policy' }] };
  const authority = { schemaVersion: 1, responsibility: { id: 'responsibility_a', version: 1, hash, siteId: 'site_a' }, generation: 0, family: 'none', legacyHead: null };
  const draft = { scope: { authority, authorityHash: digest({ namespace: 'pactwoven:financial-authority-fence:v1', record: { ...authority, environment: local.environment, organizationId: local.organizationId } }),
    site: { id: 'site_a', generation: 0, recordHash: hash } }, terms: { mode: 'PREPARE_FOR_APPROVAL', actions: ['allocate_funds'], category: 'supplier_principal',
    allocation: 'responsibility_earmark', supplier: null, acceptedTerms: null, payee: null, tool: null, withdrawal: null, branch: null,
    communication: { recipients: [], purposes: [], kinds: [], allowanceBaseUnits: '0' } }, documents: [{ ...ref('mandate_doc'), purpose: 'financial_mandate' }],
    governance: null, asset: null, account: null, trust: null, startsAt: start, expiresAt: end };
  const reviewed = { schemaVersion: 1, previous: null, organizationEpoch: 2 }, expectedControl = { budgetAccountId, generation: 0, accepted: null };
  const requests = [
    { kind: 'save_document', responsibilityId: null, input: { ...reviewed, purpose: 'budget_policy', text: 'Budget terms. Café 🧵' } },
    { kind: 'save_document', responsibilityId: 'responsibility_a', input: { ...reviewed, purpose: 'financial_mandate', text: 'Mandate terms.' } },
    { kind: 'save_draft', responsibilityId: 'responsibility_a', input: { ...reviewed, draft } },
    { kind: 'withdraw_draft', responsibilityId: 'responsibility_a', input: { ...reviewed, previous: ref() } },
    { kind: 'propose_governance', responsibilityId: null, input: { ...reviewed, bundle, expectedControl, expiresAt: end } },
    { kind: 'accept_governance', responsibilityId: null, input: { ...reviewed, previous: ref(), expectedControl } },
    { kind: 'reject_governance', responsibilityId: null, input: { ...reviewed, previous: ref(), expectedControl } },
  ].map(v => FinancialPolicyHttpRequestSchema.parse({ ...v, id: 'policy_a', key: 'original_policy_001',
    route: financialPolicyHttpRoute({ kind: v.kind, responsibilityId: v.responsibilityId, id: 'policy_a' }) }));
  return { requests, bundle, draft };
}
async function documentFixture() {
  const request = fixtures().requests[0]!, attempt = await createFinancialPolicyAttempt(local, request);
  if (request.kind !== 'save_document') throw Error('fixture');
  const record: FinancialPolicyHttpRecord = { schemaVersion: 1, environment: 'development', organizationId: 'org_a', id: 'policy_a', version: 1,
    predecessor: null, actor, organizationEpoch: 2, operationId: '00000000-0000-0000-0000-000000000001', createdAt: start,
    kind: 'document', responsibilityId: null, purpose: 'budget_policy', text: request.input.text,
    contentHash: digest({ namespace: 'pactwoven:financial-policy-text:v1', text: request.input.text }) };
  const receipt: FinancialPolicyHttpReceipt = { schemaVersion: 1, environment: 'development', organizationId: 'org_a', actor, responsibilityId: null,
    operationId: record.operationId, kind: 'save_document', key: request.key, publicRequestHash: attempt.reference.locator.publicRequestHash,
    target: ref(), record, effectiveAuthority: false, financialState: null };
  const policy = { reference: ref(), record, projection: { currentRecord: true, state: 'DOCUMENT', blockers: [] }, budgetConfiguration: null };
  return { attempt, record, receipt, response: { ...envelope, responsibilityId: null, policy, documents: [], actions: [] } };
}
describe('financial policy browser public contract', () => {
  it('matches the frozen HTTP0 preimage for all six kinds and both document routes', async () => {
    for (const request of fixtures().requests) {
      const inputScope = { environment: local.environment, organizationId: local.organizationId, actorId: local.actorId };
      expect(await financialPolicyPublicRequestHash(inputScope, request)).toBe(digest({ namespace: 'pactwoven:financial-policy-http-request:v1', ...inputScope,
        kind: request.kind, route: request.route, key: request.key, input: request.input }));
      const attempt = await createFinancialPolicyAttempt({ ...local, responsibilityId: request.responsibilityId }, request);
      expect(await verifyFinancialPolicyAttempt(attempt)).toEqual(attempt); expect(Object.isFrozen(attempt.request.input)).toBe(true);
      expect(FinancialPolicyReferenceSchema.safeParse({ ...attempt.reference, request }).success).toBe(false);
    }
  });
  it('snapshots public material before the first digest await', async () => {
    const request = fixtures().requests[4]!, inputScope = { environment: local.environment, organizationId: local.organizationId, actorId: local.actorId };
    const expected = digest({ namespace: 'pactwoven:financial-policy-http-request:v1', ...inputScope, kind: request.kind, route: request.route, key: request.key, input: request.input });
    const pending = financialPolicyPublicRequestHash(inputScope, request); inputScope.actorId = 'other'; request.key = 'changed_original';
    expect(await pending).toBe(expected);
  });
  it('rejects private inputs, invented public material hashes and route aliases', async () => {
    const { requests } = fixtures();
    for (const field of ['commandHash', 'recordHash', 'subject', 'sessionId', 'nonce', 'mfaEvidenceId', 'qualified'])
      await expect(createFinancialPolicyAttempt(local, { ...requests[0], [field]: 'private' })).rejects.toMatchObject({ code: 'input' });
    for (const request of [requests[2]!, requests[4]!]) {
      const copy = structuredClone(request);
      if (copy.kind === 'save_draft') copy.input.draft.scope.authorityHash = hash;
      if (copy.kind === 'propose_governance') copy.input.bundle.period.id = hash;
      await expect(createFinancialPolicyAttempt({ ...local, responsibilityId: copy.responsibilityId }, copy)).rejects.toMatchObject({ code: 'input' });
    }
    await expect(createFinancialPolicyAttempt(local, { ...requests[0], route: requests[0]!.route + '/' })).rejects.toMatchObject({ code: 'input' });
  });
  it('binds every identity and visible input change to the original digest', async () => {
    const request = fixtures().requests[0]!, inputScope = { environment: local.environment, organizationId: local.organizationId, actorId: local.actorId };
    const before = await financialPolicyPublicRequestHash(inputScope, request);
    for (const changed of [{ ...inputScope, actorId: 'other' }, { ...inputScope, organizationId: 'other' }, { ...inputScope, environment: 'simulation' }])
      expect(await financialPolicyPublicRequestHash(changed, request)).not.toBe(before);
    expect(await financialPolicyPublicRequestHash(inputScope, { ...request, key: 'different_original' })).not.toBe(before);
    if (request.kind === 'save_document') expect(await financialPolicyPublicRequestHash(inputScope, { ...request, input: { ...request.input, text: request.input.text + '.' } })).not.toBe(before);
  });
  it('qualifies immutable original receipts despite a newer viewer membership', async () => {
    const f = await documentFixture();
    const recovery = { ...envelope, ...f.attempt.reference.locator, status: 'recorded', receipt: f.receipt, closure: null };
    expect((await qualifyFinancialRecovery(recovery, scope, f.attempt.reference, f.attempt)).receipt?.actor.membershipVersion).toBe(1);
    for (const field of ['key', 'kind', 'targetId', 'publicRequestHash']) {
      const reference = structuredClone(f.attempt.reference);
      Object.assign(reference.locator, { [field]: field === 'kind' ? 'propose_governance' : field === 'publicRequestHash' ? hash : 'another_original' });
      await expect(qualifyFinancialReceipt(f.receipt, reference)).rejects.toBeDefined();
    }
    await expect(qualifyFinancialReceipt(f.receipt, { ...f.attempt.reference, scope: { ...local, actorId: 'other' } })).rejects.toMatchObject({ code: 'unconfirmed' });
    await expect(qualifyFinancialReceipt({ ...f.receipt, currentRecord: true }, f.attempt.reference)).rejects.toMatchObject({ code: 'input' });
  });
  it('compares receipt intent, exact version/hash and full text without reconstructing private record hashes', async () => {
    const f = await documentFixture(), target = { kind: 'document' as const, responsibilityId: null, id: 'policy_a', version: 1, recordHash: hash };
    expect((await qualifyFinancialRead(f.response, scope, target)).policy.reference.recordHash).toBe(hash);
    for (const changed of [{ ...target, version: 2 }, { ...target, id: 'other' }, { ...target, recordHash: 'f'.repeat(64) }])
      await expect(qualifyFinancialRead(f.response, scope, changed)).rejects.toMatchObject({ code: 'unconfirmed' });
    const changed = structuredClone(f.receipt); if (changed.record.kind !== 'document') throw Error('fixture');
    changed.record.text = 'Different text.'; changed.record.contentHash = digest({ namespace: 'pactwoven:financial-policy-text:v1', text: changed.record.text });
    await expect(qualifyFinancialReceipt(changed, f.attempt.reference, f.attempt)).rejects.toMatchObject({ code: 'unconfirmed' });
    await expect(qualifyFinancialRead(f.response, { ...scope, actor: { ...scope.actor, membershipVersion: 9 } }, target)).rejects.toMatchObject({ code: 'scope' });
  });
  it('keeps record currentness independent from current accepted configuration', async () => {
    const { bundle } = fixtures();
    const record = { schemaVersion: 1, environment: 'development', organizationId: 'org_a', id: 'policy_a', version: 2, predecessor: ref(),
      actor: { actorId: 'finance_a', membershipVersion: 1 }, organizationEpoch: 2, operationId: '00000000-0000-0000-0000-000000000001', createdAt: start,
      kind: 'governance', responsibilityId: null, state: 'ACCEPTED', proposer: actor, bundle, expectedControl: { budgetAccountId: bundle.budgetAccountId, generation: 0, accepted: null }, expiresAt: end };
    const policy = { record, reference: ref('policy_a', 2), projection: { currentRecord: true, state: 'ACCEPTED', blockers: [] },
      budgetConfiguration: { status: 'observed', control: { budgetAccountId: bundle.budgetAccountId, generation: 2, accepted: ref('new_configuration', 2) }, currentBudgetConfiguration: false } };
    const index = { ...envelope, kind: 'organization', responsibilityId: null, items: [{ policy, actions: [] }], nextId: null };
    const result = await qualifyFinancialIndex(index, scope, { responsibilityId: null, afterId: null, limit: 1 });
    expect(result.items[0]?.policy.projection.currentRecord).toBe(true);
    expect(result.items[0]?.policy.budgetConfiguration?.currentBudgetConfiguration).toBe(false);
    await expect(qualifyFinancialIndex(index, scope, { responsibilityId: null, afterId: 'policy_a', limit: 1 })).rejects.toMatchObject({ code: 'unconfirmed' });
    await expect(qualifyFinancialRecordMaterial({ ...record, version: 1, predecessor: null } as FinancialPolicyHttpRecord)).rejects.toMatchObject({ code: 'input' });
  });
});
