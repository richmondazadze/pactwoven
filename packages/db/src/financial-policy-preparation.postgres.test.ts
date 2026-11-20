import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FinancialPolicyPreparationRequest, type FinancialPolicyRef } from '@pactwoven/contracts';
import { financialBudgetPeriodId } from '@pactwoven/domain';
import { financialPolicyReadFixture, financialPolicyReadFixtureEnabled, type FinancialPolicyReadFixture } from './financial-policy-read.test-support.js';
import { PostgresFinancialPolicyPreparationReader } from './financial-policy-preparation-repository.js';

// Root must review source/fixture guards before enabling this existing exclusive fixture.
// No consent/MFA helper is used: accepted-control advancement is a separate dispatch.
const documentSelection = (id = 'document_new', purpose: 'budget_policy' | 'approval_policy' | 'financial_mandate' = 'budget_policy', previous: FinancialPolicyRef | null = null): FinancialPolicyPreparationRequest =>
  ({ schemaVersion: 1, action: 'save_document', targetId: id, previous, purpose });
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const counts = async (f: FinancialPolicyReadFixture) => (await f.admin.query(`SELECT
  (SELECT count(*) FROM pactwoven.financial_policy_records) AS records,(SELECT count(*) FROM pactwoven.financial_policy_operations) AS operations,
  (SELECT count(*) FROM pactwoven.financial_policy_audit) AS audit,(SELECT count(*) FROM pactwoven.financial_policy_outbox) AS outbox,
  (SELECT count(*) FROM pactwoven.financial_budget_accounts) AS accounts,(SELECT count(*) FROM pactwoven.financial_budget_periods) AS periods,
  (SELECT count(*) FROM pactwoven.financial_governance_controls) AS controls,(SELECT count(*) FROM pactwoven.financial_policy_evidence_uses) AS consent,
  (SELECT count(*) FROM pactwoven.financial_authority_fences WHERE family<>'none') AS authority`)).rows[0];

describe.skipIf(!financialPolicyReadFixtureEnabled)('FP-PREP1 exclusive PostgreSQL preparation', () => {
  let f: FinancialPolicyReadFixture, reader: PostgresFinancialPolicyPreparationReader;
  beforeEach(async () => { f = await financialPolicyReadFixture(); reader = new PostgresFinancialPolicyPreparationReader(f.authorizer.pool); }, 60_000);
  afterEach(async () => { await f?.close(); });
  async function prepare(selection: FinancialPolicyPreparationRequest, rid: string | null = null, actor = 'owner_a') {
    const { evidence, scope } = await f.readerIdentity(actor);
    return reader.prepare(evidence.id, scope, { responsibilityId: rid, selection });
  }
  async function siteActive(active: boolean) {
    const row = (await f.admin.query("SELECT generation,record_hash FROM pactwoven.financial_site_fences WHERE environment='development' AND organization_id='org_a' AND site_id='site_a'")).rows[0];
    await f.admin.query("SELECT pactwoven.financial_update_site_control('development','org_a','site_a',$1,$2,'Synthetic site','America/Chicago',$3)", [row.generation, row.record_hash, active]);
  }
  const proposalSelection = (p: Awaited<ReturnType<FinancialPolicyReadFixture['governance']>>, previous: FinancialPolicyRef | null = p.result.target): FinancialPolicyPreparationRequest =>
    ({ schemaVersion: 1, action: 'propose_governance', targetId: p.result.body.id, previous, assetKey: f.assetPin.key,
      budgetDocument: p.budget.result.target, approvalDocument: p.approval.result.target });

  it('grants only the one preparation routine to the existing authorizer capability', async () => {
    const { evidence, scope } = await f.readerIdentity(), query = JSON.stringify({ responsibilityId: null, selection: documentSelection() });
    for (const pool of [f.verifier.pool, f.stranger.pool]) await expect(pool.query('SELECT pactwoven.financial_policy_prepare($1,$2::jsonb,$3::jsonb)',
      [evidence.id, JSON.stringify(scope), query])).rejects.toMatchObject({ code: '42501' });
    for (const routine of ['pactwoven.financial_policy_prepare_schema()', 'pactwoven.financial_policy_prepare_document(text,text,text,jsonb,text,boolean)']) {
      const row = (await f.admin.query("SELECT has_function_privilege($1,$3,'EXECUTE') AS authorizer,has_function_privilege($2,$3,'EXECUTE') AS verifier", [f.authorizer.role, f.verifier.role, routine])).rows[0];
      expect(row).toEqual({ authorizer: false, verifier: false });
    }
  });
  it('observes a new organization document without creating policy, budget, consent or financial state', async () => {
    const { evidence, scope } = await f.readerIdentity(), before = await counts(f);
    const result = await reader.prepare(evidence.id, scope, { responsibilityId: null, selection: documentSelection() });
    expect(result).toMatchObject({ target: { state: 'absent', record: null }, decision: { state: 'reviewable', reasons: [] }, originalActorMatches: null,
      material: { purpose: 'budget_policy', organizationEpoch: 2, draftScope: null, siteActive: null }, effectiveAuthority: false, financialState: null });
    expect(Date.parse(result.expiresAt)).toBe(Date.parse(evidence.observedAt) + 20_000);
    expect(await counts(f)).toEqual(before);
  });
  it('keeps Finance disclosure blocked for authoring and rejects organization Operations access', async () => {
    expect((await prepare(documentSelection(), null, 'finance_a')).decision).toMatchObject({ state: 'blocked', reasons: ['ROLE_REQUIRED'] });
    await expect(prepare(documentSelection(), null, 'operations_a')).rejects.toMatchObject({ code: 'FINANCIAL_POLICY_ACCESS_DENIED' });
  });
  it('does not claim absence for a hidden kind, scope or immutable purpose collision', async () => {
    const organization = await f.saveDocument('budget_policy', 'occupied'), responsibility = await f.saveDocument('financial_mandate', 'scoped'), draft = await f.draft('draft_occupied');
    for (const [selection, rid] of [[documentSelection(organization.result.body.id, 'financial_mandate'), 'responsibility_a'],
      [documentSelection(responsibility.result.body.id), null], [documentSelection(draft.result.body.id, 'financial_mandate'), 'responsibility_a'],
      [documentSelection(organization.result.body.id, 'approval_policy'), null]] as const) {
      const result = await prepare(selection, rid);
      expect(result.target).toEqual({ state: 'unavailable', latestReference: null, record: null, historicalDocuments: [], control: null });
      expect(result.decision.reasons).toContain('TARGET_UNAVAILABLE'); expect(result.originalActorMatches).toBeNull();
    }
    expect((await prepare(documentSelection('missing', 'budget_policy', { ...organization.result.target, id: 'missing' }))).target.state).toBe('unavailable');
  });
  it('returns only an explicit new predecessor for changed targets, then exact full text for an exact selection', async () => {
    const d = await f.saveDocument('budget_policy', 'existing');
    const changed = await prepare(documentSelection(d.result.body.id));
    expect(changed.target).toEqual({ state: 'changed', latestReference: d.result.target, record: null, historicalDocuments: [], control: null });
    expect(changed.decision.reasons).toEqual(['PREDECESSOR_CHANGED']);
    const exact = await prepare(documentSelection(d.result.body.id, 'budget_policy', d.result.target));
    expect(exact.target).toMatchObject({ state: 'exact', record: { record: d.result.body }, historicalDocuments: [] });
    expect(exact.decision.state).toBe('reviewable');
    expect((await prepare(documentSelection(d.result.body.id, 'budget_policy', d.result.target), null, 'owner_b')).decision.reasons).toContain('ORIGINAL_ACTOR_REQUIRED');
  });
  it('prepares an incomplete draft only with current full selected mandate and active exact site basis', async () => {
    const d = await f.saveDocument('financial_mandate', 'mandate', 'operations_a');
    const selection: FinancialPolicyPreparationRequest = { schemaVersion: 1, action: 'save_draft', targetId: 'new_draft', previous: null, document: d.result.target };
    const value = await prepare(selection, 'responsibility_a', 'operations_a');
    expect(value.decision.state).toBe('reviewable'); expect(value.material).toMatchObject({ profile: 'incomplete', document: { record: d.result.body },
      siteActive: true, draftScope: { authority: { responsibility: { id: 'responsibility_a' } }, site: { id: 'site_a' } }, asset: null, account: null, governance: null, trust: null });
    expect(value.configurationWarnings).toEqual(expect.arrayContaining(['ASSET_MISSING', 'ACCOUNT_MISSING', 'GOVERNANCE_MISSING']));
    expect((await prepare({ ...selection, document: null }, 'responsibility_a', 'operations_a')).decision.reasons).toEqual(['DOCUMENT_REQUIRED']);
    const identity = await f.identity('operations_a');
    if (d.command.kind !== 'save_document') throw new Error('Document fixture required.');
    await f.repository.mutate(identity.id, { ...d.command, previous: d.result.target, key: `revision_${crypto.randomUUID()}`, text: 'New full terms.' });
    const stale = await prepare(selection, 'responsibility_a', 'operations_a');
    expect(stale.decision.reasons).toEqual(['DOCUMENT_CHANGED']); expect(stale.material).toMatchObject({ document: null });
    await siteActive(false);
    expect((await prepare(documentSelection('inactive_document', 'financial_mandate'), 'responsibility_a', 'operations_a')).decision.reasons).toContain('SCOPE_CHANGED');
  });
  it('permits raw expired DRAFT revision with separately selected current terms', async () => {
    const seed = await f.draft(); if (seed.command.kind !== 'save_draft') throw new Error('Draft fixture required.');
    const expiresAt = new Date(Date.now() + 1200).toISOString();
    const draft = await f.repository.mutate((await f.identity('operations_a')).id, { ...seed.command, id: 'short_draft', key: `short_${crypto.randomUUID()}`,
      draft: { ...seed.command.draft, startsAt: new Date(Date.now()).toISOString(), expiresAt } });
    await wait(Math.max(0, Date.parse(expiresAt) - Date.now() + 30));
    const result = await prepare({ schemaVersion: 1, action: 'save_draft', targetId: draft.body.id, previous: draft.target, document: seed.document.result.target }, 'responsibility_a', 'operations_a');
    expect(result.target).toMatchObject({ state: 'exact', record: { state: 'EXPIRED', current: true, record: { state: 'DRAFT' } } });
    expect(result.decision.state).toBe('reviewable');
  });
  it('withdraws stale inactive historical material without requiring a new basis or replacing text', async () => {
    const draft = await f.draft(); if (draft.document.command.kind !== 'save_document') throw new Error('Document fixture required.');
    await f.repository.mutate((await f.identity('operations_a')).id, { ...draft.document.command, previous: draft.document.result.target,
      key: `changed_${crypto.randomUUID()}`, text: 'Current replacement terms.' });
    await siteActive(false);
    const selection: FinancialPolicyPreparationRequest = { schemaVersion: 1, action: 'withdraw_draft', targetId: draft.result.body.id, previous: draft.result.target };
    const result = await prepare(selection, 'responsibility_a', 'operations_a');
    expect(result.decision.state).toBe('reviewable'); expect(result.material).toEqual({ action: 'withdraw_draft' });
    expect(result.target).toMatchObject({ historicalDocuments: [{ record: draft.document.result.body, current: false }] });
    const withdrawn = await f.repository.mutate((await f.identity('operations_a')).id, { ...f.base('withdraw_draft', draft.result.body.id, 'responsibility_a'),
      kind: 'withdraw_draft', responsibilityId: 'responsibility_a', previous: draft.result.target });
    expect((await prepare({ ...selection, previous: withdrawn.target }, 'responsibility_a', 'operations_a')).decision.reasons).toEqual(['DRAFT_WITHDRAWN']);
  });
  it('blocks incomplete revision of nonnull optional material while preserving eligible withdrawal', async () => {
    const seed = await f.draft(); if (seed.command.kind !== 'save_draft') throw new Error('Draft fixture required.');
    const draft = await f.repository.mutate((await f.identity('operations_a')).id, { ...seed.command, id: 'asset_draft', key: `asset_${crypto.randomUUID()}`,
      draft: { ...seed.command.draft, asset: f.assetPin } });
    const save = await prepare({ schemaVersion: 1, action: 'save_draft', targetId: draft.body.id, previous: draft.target, document: seed.document.result.target }, 'responsibility_a', 'operations_a');
    expect(save.decision.reasons).toEqual(['DRAFT_MATERIAL_UNSUPPORTED']);
    expect(save.target).toMatchObject({ record: { record: { draft: { asset: f.assetPin } } } });
    expect((await prepare({ schemaVersion: 1, action: 'withdraw_draft', targetId: draft.body.id, previous: draft.target }, 'responsibility_a', 'operations_a')).decision.state).toBe('reviewable');
  });
  it('rejects subject reassignment and forged private identity under the same public actor ID', async () => {
    const draft = await f.draft(), { evidence, scope } = await f.readerIdentity('operations_a'), before = await counts(f);
    // The existing membership boundary forbids the original fixture's attempted rebinding.
    // Preserve that control; exercise both verifier and preparation rejection without bypassing it.
    await expect(f.admin.query("UPDATE pactwoven.memberships SET external_subject='replacement_person',row_version=row_version+1 WHERE environment='development' AND organization_id='org_a' AND actor_id='operations_a'"))
      .rejects.toMatchObject({ code: 'PA001' });
    const forged = { ...evidence, id: crypto.randomUUID(), actor: { ...evidence.actor, subject: 'replacement_person' } };
    await expect(f.authentication.append(forged)).rejects.toMatchObject({ code: 'FINANCIAL_POLICY_ACCESS_DENIED' });
    const query = { responsibilityId: 'responsibility_a', selection: {
      schemaVersion: 1 as const, action: 'withdraw_draft' as const, targetId: draft.result.body.id, previous: draft.result.target } };
    await expect(reader.prepare(evidence.id, { ...scope, actor: { ...scope.actor, subject: 'replacement_person' } }, query))
      .rejects.toMatchObject({ code: 'FINANCIAL_POLICY_ACCESS_DENIED' });
    const result = await reader.prepare(evidence.id, scope, query);
    expect(result.originalActorMatches).toBe(true); expect(result.decision.state).toBe('reviewable');
    expect(await counts(f)).toEqual(before);
  });
  it('co-observes selected proposal configuration and generation-zero control without creating a budget account', async () => {
    const b = await f.saveDocument('budget_policy'), a = await f.saveDocument('approval_policy'), before = await counts(f);
    const selection: FinancialPolicyPreparationRequest = { schemaVersion: 1, action: 'propose_governance', targetId: 'new_proposal', previous: null,
      assetKey: f.assetPin.key, budgetDocument: b.result.target, approvalDocument: a.result.target };
    const result = await prepare(selection);
    expect(result.decision.state).toBe('reviewable'); expect(result.material).toMatchObject({ asset: { pin: f.assetPin, decimals: 6 },
      control: { generation: 0, accepted: null }, acceptedConfiguration: null, periods: [], eligibleActionSites: [{ id: 'site_a' }],
      budgetDocument: { record: b.result.body }, approvalDocument: { record: a.result.body } });
    expect(await counts(f)).toEqual(before);
    const missing = await prepare({ ...selection, assetKey: null, budgetDocument: null });
    expect(missing.decision.reasons).toEqual(['ASSET_MISSING', 'DOCUMENT_REQUIRED']);
    await f.admin.query('UPDATE pactwoven.finance_asset_controls SET accepts_observations=false WHERE asset_key=$1', [f.assetPin.key]);
    const changed = await prepare(selection); expect(changed.decision.reasons).toEqual(['ASSET_CHANGED']);
    expect(changed.material).toMatchObject({ asset: null, budgetAccountId: null, control: null, periods: [] });
  });
  it('prepares a latest raw expired OPEN proposal without renewing its original dates', async () => {
    const p = await f.governance(); if (p.command.kind !== 'propose_governance') throw new Error('Proposal fixture required.');
    const expiresAt = new Date(Date.now() + 1200).toISOString(), record = await f.repository.mutate((await f.identity()).id,
      { ...p.command, id: 'short_proposal', key: `short_${crypto.randomUUID()}`, expiresAt });
    await wait(Math.max(0, Date.parse(expiresAt) - Date.now() + 30));
    const result = await prepare({ ...proposalSelection(p), targetId: record.body.id, previous: record.target });
    expect(result.target).toMatchObject({ record: { state: 'EXPIRED', record: { state: 'OPEN', expiresAt } } });
    expect(result.decision.state).toBe('reviewable');
  });
  it('fails closed on corrupt reciprocal originals without reporting target absence', async () => {
    const d = await f.saveDocument('budget_policy');
    // Deliberate corruption is confined to the already guarded disposable fixture.
    await f.admin.query('ALTER TABLE pactwoven.financial_policy_outbox DISABLE TRIGGER financial_policy_no_mutation');
    try { await f.admin.query('DELETE FROM pactwoven.financial_policy_outbox WHERE operation_id=$1', [d.result.id]); }
    finally { await f.admin.query('ALTER TABLE pactwoven.financial_policy_outbox ENABLE TRIGGER financial_policy_no_mutation'); }
    await expect(prepare(documentSelection(d.result.body.id, 'budget_policy', d.result.target))).rejects.toMatchObject({ code: 'FINANCIAL_POLICY_OUTCOME_UNKNOWN' });
    await expect(prepare({ schemaVersion: 1, action: 'propose_governance', targetId: 'new_after_corruption', previous: null,
      assetKey: null, budgetDocument: { ...d.result.target, recordHash: 'f'.repeat(64) }, approvalDocument: null })).rejects.toMatchObject({ code: 'FINANCIAL_POLICY_OUTCOME_UNKNOWN' });
  });
  it('refuses a period inventory over fifty instead of silently returning a truncated complete list', async () => {
    const p = await f.governance(); if (p.command.kind !== 'propose_governance') throw new Error('Proposal fixture required.');
    const start = Date.parse(p.command.bundle.period.endsAt);
    for (let i = 0; i < 50; i++) {
      const startsAt = new Date(start + i * 86_400_000).toISOString(), endsAt = new Date(start + (i + 1) * 86_400_000).toISOString();
      await f.repository.mutate((await f.identity()).id, { ...p.command, id: `period_proposal_${i}`, key: `period_${crypto.randomUUID()}`,
        bundle: { ...p.command.bundle, period: { id: await financialBudgetPeriodId(p.command.bundle.budgetAccountId, startsAt, endsAt), startsAt, endsAt } } });
    }
    await expect(prepare(proposalSelection(p))).rejects.toMatchObject({ code: 'FINANCIAL_POLICY_UNAVAILABLE' });
  });
  it.each(['roles', 'grants', 'epoch', 'session'] as const)('rechecks current %s after preparation identity resolution', async change => {
    const { evidence, scope } = await f.readerIdentity('operations_a');
    if (change === 'roles') await f.admin.query("UPDATE pactwoven.memberships SET roles=ARRAY['receiver'] WHERE environment='development' AND organization_id='org_a' AND actor_id='operations_a'");
    if (change === 'grants') await f.admin.query("DELETE FROM pactwoven.member_action_sites WHERE environment='development' AND organization_id='org_a' AND actor_id='operations_a'");
    if (change === 'epoch') await f.admin.query("UPDATE pactwoven.organizations SET authority_epoch=authority_epoch+1 WHERE environment='development' AND id='org_a'");
    if (change === 'session') await f.admin.query("INSERT INTO pactwoven.session_revocations(environment,session_id) VALUES('development',$1)", [evidence.actor.sessionId]);
    await expect(reader.prepare(evidence.id, scope, { responsibilityId: 'responsibility_a', selection: documentSelection('new', 'financial_mandate') })).rejects.toMatchObject({ code: 'FINANCIAL_POLICY_ACCESS_DENIED' });
  });
  it('retains the original expiry across an observed asset-control lock wait', async () => {
    const observedAt = Date.now() - 18_800, evidence = { ...await f.identity(), id: crypto.randomUUID(), observedAt: new Date(observedAt).toISOString(), tokenIssuedAt: new Date(observedAt - 1000).toISOString() };
    await f.authentication.append(evidence); const scope = await f.readers.resolveObserver('development', f.observation(evidence)), holder = await f.admin.connect();
    try {
      await holder.query('BEGIN'); await holder.query('SELECT asset_key FROM pactwoven.finance_asset_controls WHERE asset_key=$1 FOR UPDATE', [f.assetPin.key]);
      const pid = (await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const pending = reader.prepare(evidence.id, scope, { responsibilityId: null, selection: { schemaVersion: 1, action: 'propose_governance', targetId: 'waiting', previous: null,
        assetKey: f.assetPin.key, budgetDocument: null, approvalDocument: null } }).then(value => ({ value }), error => ({ error }));
      let blocked = false; const until = Date.now() + 700;
      while (Date.now() < until) { blocked = (await f.admin.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))) AS blocked', [pid])).rows[0].blocked; if (blocked) break; await wait(10); }
      expect(blocked).toBe(true); await wait(Math.max(0, observedAt + 20_030 - Date.now())); await holder.query('COMMIT');
      expect(await pending).toMatchObject({ error: { code: 'FINANCIAL_POLICY_ACCESS_DENIED' } });
    } finally { await holder.query('ROLLBACK'); holder.release(); }
  });
  it('observes a concurrent committed target and does not let prior preparation bypass final writer comparisons', async () => {
    const first = await prepare(documentSelection('race_target')); expect(first.target.state).toBe('absent');
    const d = await f.saveDocument('budget_policy', 'race_target');
    expect((await prepare(documentSelection('race_target'))).target).toMatchObject({ state: 'changed', latestReference: d.result.target });
    await expect(f.repository.mutate((await f.identity()).id, { ...f.base('save_document', 'race_target'), kind: 'save_document', purpose: 'budget_policy', text: 'Previously reviewed new text.' })).rejects.toMatchObject({ code: 'FINANCIAL_POLICY_SCOPE_CHANGED' });
  });
});
