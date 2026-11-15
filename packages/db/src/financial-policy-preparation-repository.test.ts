import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { FINANCE_DEVNET_ASSET, decodeSolanaBase58, FinancialPolicyReadSchema } from '@pactwoven/contracts';
import { financialPolicyRecordRef, financialPolicyTextHash, commandDigest, financialBudgetAccountId, financialBudgetPeriodId, physicalAssetKey } from '@pactwoven/domain';
import { PostgresFinancialPolicyPreparationReader } from './financial-policy-preparation-repository.js';
import { FinancialPolicyPreparationSchema, type FinancialPolicyPreparation } from './financial-policy-preparation-schema.js';
vi.mock('pg', () => ({ Pool: class { constructor() { throw new Error('Real database effects forbidden in unit tests.'); } } }));

const now = Date.parse('2026-11-15T12:00:00.000Z'), hash = 'a'.repeat(64), evidence = '00000000-0000-0000-0000-000000000001';
const actor = { actorId: 'owner_a', membershipVersion: 2, subject: 'person_a', externalMembershipId: 'member_a', sessionId: 'session_a' };
const common = { schemaVersion: 1, environment: 'development', organizationId: 'org_a', version: 1, predecessor: null, actor,
  identityEvidence: { id: evidence, version: 1, recordHash: hash }, organizationEpoch: 2, operationId: evidence, createdAt: '2026-11-14T12:00:00.000Z' };
function base(): FinancialPolicyPreparation {
  return FinancialPolicyPreparationSchema.parse({ schemaVersion: 1,
    scope: { environment: 'development', organizationId: 'org_a', externalOrganizationId: 'clerk_org_a', actor, organizationEpoch: 2,
      roles: ['owner'], siteIds: ['site_a'], actionSiteIds: ['site_a'] }, responsibilityId: null,
    selection: { schemaVersion: 1, action: 'save_document', targetId: 'document_a', previous: null, purpose: 'budget_policy' },
    target: { state: 'absent', latestReference: null, record: null, historicalDocuments: [], control: null }, originalActorMatches: null,
    material: { action: 'save_document', purpose: 'budget_policy', organizationEpoch: 2, draftScope: null, siteActive: null },
    decision: { action: 'save_document', state: 'reviewable', reasons: [], requiredAuthentication: null },
    configurationWarnings: ['FINANCIAL_AUTHORITY_UNAVAILABLE', 'TRUST_UNAVAILABLE'], observedAt: new Date(now).toISOString(), expiresAt: new Date(now + 20_000).toISOString(),
    effectiveAuthority: false, financialState: null });
}
async function document(id = 'document_a', purpose = 'budget_policy', current = true) {
  const text = 'Exact complete synthetic terms. Café 🧵';
  const record = FinancialPolicyReadSchema.shape.record.parse({ ...common, id, responsibilityId: purpose === 'financial_mandate' ? 'responsibility_a' : null,
    kind: 'document', purpose, text, contentHash: await financialPolicyTextHash(text) });
  return FinancialPolicyReadSchema.parse({ record, reference: await financialPolicyRecordRef(record), current,
    state: current ? 'DOCUMENT' : 'SUPERSEDED', blockers: [], effectiveAuthority: false });
}
async function revision() {
  const d = await document();
  return FinancialPolicyPreparationSchema.parse({ ...base(), selection: { ...base().selection, previous: d.reference }, originalActorMatches: true,
    target: { state: 'exact', latestReference: d.reference, record: d, historicalDocuments: [], control: null } });
}
async function withdrawal() {
  const d = await document('old_mandate', 'financial_mandate', false);
  const authority = { schemaVersion: 1, environment: 'development', organizationId: 'org_a', responsibility: { id: 'responsibility_a', version: 1, hash, siteId: 'site_a' }, generation: 0, family: 'none', legacyHead: null };
  const draftScope = { authority, authorityHash: await commandDigest({ namespace: 'pactwoven:financial-authority-fence:v1', record: authority }), site: { id: 'site_a', generation: 0, recordHash: hash } };
  const record = FinancialPolicyReadSchema.shape.record.parse({ ...common, id: 'draft_a', responsibilityId: 'responsibility_a', kind: 'draft', state: 'DRAFT',
    requester: { ...actor, membershipVersion: 1, sessionId: 'session_original' }, draft: { scope: draftScope,
      terms: { mode: 'PREPARE_FOR_APPROVAL', actions: ['allocate_funds'], category: 'supplier_principal', allocation: 'responsibility_earmark',
        supplier: null, acceptedTerms: null, payee: null, tool: null, withdrawal: null, branch: null, communication: { recipients: [], purposes: [], kinds: [], allowanceBaseUnits: '0' } },
      documents: [{ ...d.reference, purpose: 'financial_mandate' }], asset: null, account: null, governance: null, trust: null,
      startsAt: '2025-01-01T00:00:00.000Z', expiresAt: '2025-01-02T00:00:00.000Z' } });
  const reference = await financialPolicyRecordRef(record), view = FinancialPolicyReadSchema.parse({ record, reference, current: true, state: 'EXPIRED',
    blockers: ['DRAFT_EXPIRED', 'SCOPE_CHANGED', 'DOCUMENT_CHANGED', 'TRUST_UNAVAILABLE', 'FINANCIAL_AUTHORITY_UNAVAILABLE'], effectiveAuthority: false });
  return FinancialPolicyPreparationSchema.parse({ ...base(), responsibilityId: 'responsibility_a',
    selection: { schemaVersion: 1, action: 'withdraw_draft', targetId: 'draft_a', previous: reference }, originalActorMatches: true,
    target: { state: 'exact', latestReference: reference, record: view, historicalDocuments: [d], control: null }, material: { action: 'withdraw_draft' },
    decision: { action: 'withdraw_draft', state: 'reviewable', reasons: [], requiredAuthentication: null } });
}
async function proposal() {
  const b = await document('budget', 'budget_policy'), a = await document('approval', 'approval_policy'), key = await physicalAssetKey(FINANCE_DEVNET_ASSET);
  const account = await financialBudgetAccountId('development', 'org_a', key), hex = (v: string) => Buffer.from(decodeSolanaBase58(v, 32)).toString('hex');
  return FinancialPolicyPreparationSchema.parse({ ...base(), selection: { schemaVersion: 1, action: 'propose_governance', targetId: 'proposal_a', previous: null,
    assetKey: key, budgetDocument: b.reference, approvalDocument: a.reference },
    material: { action: 'propose_governance', asset: { pin: { key, version: 1, recordHash: hash, financialUseEpoch: 0 },
      genesisHex: hex(FINANCE_DEVNET_ASSET.genesis), tokenProgramHex: hex(FINANCE_DEVNET_ASSET.tokenProgram), mintHex: hex(FINANCE_DEVNET_ASSET.mint), decimals: 6, policy: 'solana-original-devnet-usdc-v1' },
      budgetAccountId: account, control: { budgetAccountId: account, generation: 0, accepted: null }, acceptedConfiguration: null, periods: [],
      budgetDocument: b, approvalDocument: a, eligibleActionSites: [{ id: 'site_a', generation: 0, recordHash: hash }] },
    decision: { action: 'propose_governance', state: 'reviewable', reasons: [], requiredAuthentication: null } });
}
async function proposalRevision() {
  const v = await proposal(), m = v.material;
  if (m.action !== 'propose_governance' || !m.asset || !m.control || !m.budgetAccountId || !m.budgetDocument || !m.approvalDocument) throw new Error('Proposal fixture required.');
  const startsAt = '2026-11-14T00:00:00.000Z', endsAt = '2026-11-21T00:00:00.000Z';
  const period = { id: await financialBudgetPeriodId(m.budgetAccountId, startsAt, endsAt), startsAt, endsAt };
  const record = FinancialPolicyReadSchema.shape.record.parse({ ...common, id: v.selection.targetId, responsibilityId: null, kind: 'governance', state: 'OPEN',
    proposer: { ...actor, membershipVersion: 1, sessionId: 'original_session' }, expectedControl: m.control, decisionNonce: 'a'.repeat(42) + 'A',
    expiresAt: '2026-11-14T13:00:00.000Z', decision: null, bundle: { budgetAccountId: m.budgetAccountId, asset: m.asset.pin, category: 'supplier_principal',
      limits: { perOperation: '100', perResponsibility: '500', perPeriod: '1000' }, period,
      approval: { requesterRoles: ['finance', 'operations', 'owner'], approverRoles: ['finance', 'owner'], independent: true, actionSiteIds: ['site_a'],
        action: 'allocate_funds', category: 'supplier_principal', thresholdBaseUnits: '100', maximumAuthenticationAgeSeconds: 300, maximumApprovalAgeSeconds: 300 },
      documents: [{ ...m.approvalDocument.reference, purpose: 'approval_policy' }, { ...m.budgetDocument.reference, purpose: 'budget_policy' }] } });
  const reference = await financialPolicyRecordRef(record);
  return FinancialPolicyPreparationSchema.parse({ ...v, selection: { ...v.selection, previous: reference }, originalActorMatches: true,
    target: { state: 'exact', latestReference: reference, record: { record, reference, current: true, state: 'EXPIRED', blockers: [], effectiveAuthority: false },
      historicalDocuments: [m.approvalDocument, m.budgetDocument], control: m.control }, material: { ...m, periods: [period] } });
}
function fixture(response: unknown, beforeCommit?: () => void) {
  const capturedResponse = response instanceof Error ? response : structuredClone(response);
  const release = vi.fn(), query = vi.fn(async (sql: string, _params?: unknown[]) => {
    if (sql === 'COMMIT') beforeCommit?.();
    if (sql.includes(' AS safe')) return { rows: [{ safe: true }] };
    if (sql.includes(' AS response')) { if (capturedResponse instanceof Error) throw capturedResponse; return { rows: [{ response: capturedResponse }] }; }
    return { rows: [] };
  }), connect = vi.fn(async () => ({ query, release })), pool = { connect } as unknown as Pool;
  return { reader: new PostgresFinancialPolicyPreparationReader(pool), query, release, connect, pool };
}
const request = (v: FinancialPolicyPreparation) => ({ responsibilityId: v.responsibilityId, selection: v.selection });
const expectUnknown = async (v: unknown, original: FinancialPolicyPreparation) =>
  expect(fixture(v).reader.prepare(evidence, original.scope, request(original))).rejects.toMatchObject({ code: 'FINANCIAL_POLICY_OUTCOME_UNKNOWN' });

describe('private preparation repository with fake authorizer only', () => {
  beforeEach(() => { vi.spyOn(Date, 'now').mockReturnValue(now); });
  afterEach(() => { vi.restoreAllMocks(); });
  it('uses one checked READ COMMITTED transaction and only the fixed preparation routine', async () => {
    const v = base(), f = fixture(v);
    await expect(f.reader.prepare(evidence, v.scope, request(v))).resolves.toEqual(v);
    expect(f.connect).toHaveBeenCalledOnce(); expect(f.release).toHaveBeenCalledExactlyOnceWith(false);
    expect(f.query.mock.calls[0]?.[0]).toBe('BEGIN ISOLATION LEVEL READ COMMITTED'); expect(f.query.mock.calls.at(-1)?.[0]).toBe('COMMIT');
    const calls = f.query.mock.calls.filter(([sql]) => sql.includes(' AS response'));
    expect(calls).toEqual([['SELECT pactwoven.financial_policy_prepare($1,$2::jsonb,$3::jsonb) AS response', [evidence, JSON.stringify(v.scope), JSON.stringify(request(v))]]]);
  });
  it('captures scope, selectors and pool methods before a connection wait', async () => {
    const v = base(), f = fixture(v); let open!: () => void;
    const gate = new Promise<void>(resolve => { open = resolve; });
    const connect = vi.fn(async () => { await gate; return { query: f.query, release: f.release }; });
    const pool = { connect } as unknown as Pool, reader = new PostgresFinancialPolicyPreparationReader(pool), input = request(v), scope = structuredClone(v.scope);
    const pending = reader.prepare(evidence, scope, input); input.selection.targetId = 'changed'; scope.actor.subject = 'changed';
    pool.connect = vi.fn(() => { throw new Error('Replaced method must not be used.'); }) as never;
    open(); await expect(pending).resolves.toMatchObject({ selection: { targetId: 'document_a' }, scope: { actor: { subject: 'person_a' } } });
    expect(connect).toHaveBeenCalledOnce(); expect(pool.connect).not.toHaveBeenCalled();
  });
  it('rejects unscoped input before checkout', async () => {
    const v = base(), f = fixture(v);
    await expect(f.reader.prepare('not_uuid', v.scope, request(v))).rejects.toThrow();
    await expect(f.reader.prepare(evidence, v.scope, { ...request(v), responsibilityId: 'responsibility_a' })).rejects.toThrow();
    expect(f.connect).not.toHaveBeenCalled();
  });
  it('rejects scope/selection substitutions, future observations and expired material', async () => {
    const v = base();
    for (const r of [{ ...v, scope: { ...v.scope, actor: { ...actor, subject: 'other' } } }, { ...v, selection: { ...v.selection, targetId: 'other' } },
      { ...v, observedAt: new Date(now + 1).toISOString() }, { ...v, observedAt: new Date(now - 20_000).toISOString(), expiresAt: new Date(now).toISOString() },
      { ...v, unexpected: true }, null]) await expectUnknown(r, v);
  });
  it('checks text and raw record hashes instead of trusting source flags', async () => {
    const v = await revision(); expect(v.target.state).toBe('exact');
    await expect(fixture(v).reader.prepare(evidence, v.scope, request(v))).resolves.toEqual(v);
    if (v.target.state !== 'exact' || v.target.record.record.kind !== 'document') throw new Error('Synthetic document required.');
    const changed = structuredClone(v); if (changed.target.state !== 'exact' || changed.target.record.record.kind !== 'document') throw new Error('Synthetic document required.');
    changed.target.record.record.text = 'Different full text.';
    const forged = await financialPolicyRecordRef(changed.target.record.record);
    changed.target.record.reference = forged; changed.target.latestReference = forged; changed.selection.previous = forged;
    await expectUnknown(changed, changed);
    await expectUnknown({ ...v, target: { ...v.target, record: { ...v.target.record, reference: { ...v.target.record.reference, recordHash: hash } } } }, v);
  });
  it('permits stale/expired draft withdrawal without new basis or replacement terms', async () => {
    const v = await withdrawal();
    await expect(fixture(v).reader.prepare(evidence, v.scope, request(v))).resolves.toEqual(v);
    expect(v.material).toEqual({ action: 'withdraw_draft' });
    if (v.target.state !== 'exact' || v.target.record.record.kind !== 'draft') throw new Error('Synthetic draft required.');
    const changed = structuredClone(v); if (changed.target.state !== 'exact' || changed.target.record.record.kind !== 'draft') throw new Error('Synthetic draft required.');
    changed.target.record.record.requester.subject = 'different_original_person';
    const ref = await financialPolicyRecordRef(changed.target.record.record);
    changed.target.record.reference = ref; changed.target.latestReference = ref; changed.selection.previous = ref;
    await expectUnknown(changed, changed);
    changed.originalActorMatches = false; changed.decision = { ...changed.decision, state: 'blocked', reasons: ['ORIGINAL_ACTOR_REQUIRED'] };
    await expect(fixture(changed).reader.prepare(evidence, changed.scope, request(changed))).resolves.toEqual(changed);
  });
  it('rejects missing or substituted historical terms even when no new material is needed', async () => {
    const v = await withdrawal(); if (v.target.state !== 'exact') throw new Error('Exact fixture required.');
    await expectUnknown({ ...v, target: { ...v.target, historicalDocuments: [] } }, v);
    const replaced = structuredClone(v); if (replaced.target.state !== 'exact') throw new Error('Exact fixture required.');
    replaced.target.historicalDocuments[0]!.reference.recordHash = hash; await expectUnknown(replaced, v);
  });
  it('qualifies the actual selected asset tuple, stable account, periods and current terms', async () => {
    const v = await proposal(); await expect(fixture(v).reader.prepare(evidence, v.scope, request(v))).resolves.toEqual(v);
    if (v.material.action !== 'propose_governance' || !v.material.asset) throw new Error('Proposal fixture required.');
    for (const patch of [{ mintHex: hash }, { genesisHex: hash }, { tokenProgramHex: hash }, { decimals: 9 }, { policy: 'other_policy' }])
      await expectUnknown({ ...v, material: { ...v.material, asset: { ...v.material.asset, ...patch } } }, v);
    await expectUnknown({ ...v, material: { ...v.material, budgetAccountId: hash, control: { budgetAccountId: hash, generation: 0, accepted: null } } }, v);
    await expectUnknown({ ...v, material: { ...v.material, periods: [{ id: hash, startsAt: '2026-01-01T00:00:00.000Z', endsAt: '2026-01-02T00:00:00.000Z' }] } }, v);
    await expectUnknown({ ...v, material: { ...v.material, eligibleActionSites: [{ id: 'ungranted', generation: 0, recordHash: hash }] } }, v);
  });
  it('permits expired raw OPEN revision, preserves its fixed period, and rejects contradictory currentness', async () => {
    const v = await proposalRevision(); await expect(fixture(v).reader.prepare(evidence, v.scope, request(v))).resolves.toEqual(v);
    if (v.target.state !== 'exact' || v.material.action !== 'propose_governance') throw new Error('Exact proposal required.');
    await expectUnknown({ ...v, material: { ...v.material, periods: [] } }, v);
    await expectUnknown({ ...v, target: { ...v.target, record: { ...v.target.record, current: false, state: 'SUPERSEDED' } } }, v);
    const changed = structuredClone(v); if (changed.target.state !== 'exact' || changed.target.record.record.kind !== 'governance') throw new Error('Exact proposal required.');
    changed.target.record.record.proposer.subject = 'different_original_person';
    const ref = await financialPolicyRecordRef(changed.target.record.record);
    changed.target.latestReference = ref; changed.target.record.reference = ref; changed.selection.previous = ref;
    await expectUnknown(changed, changed);
    changed.originalActorMatches = false; changed.decision = { ...changed.decision, state: 'blocked', reasons: ['ORIGINAL_ACTOR_REQUIRED'] };
    await expect(fixture(changed).reader.prepare(evidence, changed.scope, request(changed))).resolves.toEqual(changed);
  });
  it('rejects oversized period/site lists, duplicated sites and missing selected material decisions', async () => {
    const v = await proposal(); if (v.material.action !== 'propose_governance') throw new Error('Proposal fixture required.');
    const site = v.material.eligibleActionSites[0]!;
    for (const material of [{ ...v.material, eligibleActionSites: [site, site] },
      { ...v.material, eligibleActionSites: Array.from({ length: 101 }, (_, i) => ({ ...site, id: `site_${String(i).padStart(3, '0')}` })) },
      { ...v.material, periods: Array.from({ length: 51 }, () => ({ id: hash, startsAt: '2026-01-01T00:00:00.000Z', endsAt: '2026-01-02T00:00:00.000Z' })) },
      { ...v.material, budgetDocument: null }, { ...v.material, approvalDocument: null }]) await expectUnknown({ ...v, material }, v);
  });
  it('never renews the original expiry after COMMIT and never retries a lost COMMIT reply', async () => {
    const v = base(), expired = fixture(v, () => { vi.mocked(Date.now).mockReturnValue(now + 20_000); });
    await expect(expired.reader.prepare(evidence, v.scope, request(v))).rejects.toMatchObject({ code: 'FINANCIAL_POLICY_OUTCOME_UNKNOWN' });
    expect(expired.connect).toHaveBeenCalledOnce();
    vi.mocked(Date.now).mockReturnValue(now);
    const lost = fixture(v, () => { throw new Error('Private lost COMMIT details.'); });
    await expect(lost.reader.prepare(evidence, v.scope, request(v))).rejects.toMatchObject({ code: 'FINANCIAL_POLICY_OUTCOME_UNKNOWN' });
    expect(lost.connect).toHaveBeenCalledOnce(); expect(lost.release).toHaveBeenCalledExactlyOnceWith(true);
  });
  it('maps private primitive failure to safe unavailable output without a fallback decision', async () => {
    const v = base(); await expectUnknown(Object.assign(new Error('Private corrupt original details.'), { code: 'FP008' }), v);
  });
});
