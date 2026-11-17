import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FinancialPolicyHttpContextSchema, FinancialPolicyHttpDraftSchema, FinancialPolicyHttpMutationResponseSchema,
  FinancialPolicyHttpRecordResponseSchema, FinancialPolicyOriginalStatusResponseSchema, FinancialPolicyHttpRequestSchema,
  type FinancialPolicyRef } from '@pactwoven/contracts';
import { PostgresFinancialPolicyClosureRepository } from '@pactwoven/db';
import { financialBudgetAccountId, financialBudgetPeriodId, financialPolicyHttpRequestHash, commandDigest } from '@pactwoven/domain';
import { financialPolicyReadFixture, financialPolicyReadFixtureEnabled, type FinancialPolicyReadFixture }
  from '../../../packages/db/src/financial-policy-read.test-support.js';
import { createFinancialPolicyApiVerifier } from './financial-policy-verifier.js';
import { createFinancialPolicyGateway } from './financial-policy-service.js';
import { createFinancialPolicyClosureGateway } from './financial-policy-closure-service.js';
import { createFinancialPolicyWriteGateway, type FinancialPolicyWriteGatewayDependencies,
  type FinancialPolicyWriteRequest } from './financial-policy-write-service.js';
import { createApp } from './app.js';

// Reviewed source must be approved before enabling this fixture. It resets only
// the exclusive loopback financial-policy-reads test schema and applies historical
// migrations 0001–0014 plus exact 0019 as a targeted API recovery compatibility profile.
// Identity is explicitly synthetic. No Clerk, devnet or provider qualification.
const issuer = 'https://synthetic.invalid', origin = 'http://localhost:3001', responsibilityId = 'responsibility_a';
const responsibility = `/v1/responsibilities/${responsibilityId}`;
const tokens = new Map(['owner_a', 'owner_b', 'finance_a', 'operations_a'].map(actor => [`financial-write-postgres-${actor}`, actor]));
const newKey = () => `write_${crypto.randomUUID()}`;
const base = () => ({ schemaVersion: 1, organizationEpoch: 2, previous: null });
type App = ReturnType<typeof createApp>;
type Mutate = FinancialPolicyWriteGatewayDependencies['repository']['mutate'];
function request(kind: FinancialPolicyWriteRequest['kind'], id: string, input: unknown, rid: string | null = null, key = newKey()): FinancialPolicyWriteRequest {
  const route = kind === 'save_document' ? rid === null ? `/v1/financial-governance/documents/${id}` : `${responsibility}/financial-policy-documents/${id}`
    : kind === 'propose_governance' ? `/v1/financial-governance/${id}` : `${responsibility}/financial-policies/${id}${kind === 'withdraw_draft' ? '/withdraw' : ''}`;
  return FinancialPolicyHttpRequestSchema.parse({ kind, id, responsibilityId: rid, key, route, input }) as FinancialPolicyWriteRequest;
}
const policyCounts = async (f: FinancialPolicyReadFixture) => (await f.admin.query(`SELECT
  (SELECT count(*)::int FROM pactwoven.financial_policy_operations) AS operations,
  (SELECT count(*)::int FROM pactwoven.financial_policy_records) AS records,
  (SELECT count(*)::int FROM pactwoven.financial_policy_audit) AS audit,
  (SELECT count(*)::int FROM pactwoven.financial_policy_outbox) AS outbox,
  (SELECT count(*)::int FROM pactwoven.financial_budget_accounts) AS accounts,
  (SELECT count(*)::int FROM pactwoven.financial_budget_periods) AS periods`)).rows[0] as Record<string, number>;
// Full-row snapshots, not just counts, for accepted controls, authority, custody,
// provenance and legacy mandate state. Proposal account/period metadata is excluded.
const inertRelations = ['financial_governance_controls', 'financial_policy_evidence_uses', 'financial_policy_request_fences',
  'financial_authority_fences', 'financial_authority_history', 'financial_site_fences', 'financial_site_history',
  'financial_asset_fences', 'financial_account_fences', 'financial_source_fences', 'financial_source_binding_fences',
  'financial_registry_history', 'mandate_heads', 'mandate_versions', 'mandate_operations',
  'custody_setup_anchors', 'custody_setup_records', 'custody_setup_controls', 'custody_setup_operations', 'custody_setup_evidence_uses',
  'finance_physical_assets', 'finance_asset_versions', 'finance_asset_controls', 'finance_physical_accounts', 'finance_account_versions',
  'finance_account_controls', 'finance_sources', 'finance_source_versions', 'finance_source_controls', 'finance_source_bindings',
  'finance_transfer_facts', 'finance_account_effects', 'finance_deliveries', 'finance_observation_links', 'finance_provenance_conflicts'] as const;
async function inertState(f: FinancialPolicyReadFixture) {
  const rows = await Promise.all(inertRelations.map(async table => [table, (await f.admin.query(
    `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM pactwoven.${table} t`)).rows[0].rows]));
  const mfa = (await f.admin.query("SELECT count(*)::int AS count FROM pactwoven.financial_policy_evidence WHERE kind<>'identity'")).rows[0].count;
  return { tables: Object.fromEntries(rows), mfa };
}
async function expectDelta(f: FinancialPolicyReadFixture, before: Record<string, number>, count: number, metadata = 0) {
  const after = await policyCounts(f);
  for (const name of ['operations', 'records', 'audit', 'outbox']) expect(after[name]).toBe(before[name]! + count);
  expect(after.accounts).toBe(before.accounts! + metadata); expect(after.periods).toBe(before.periods! + metadata);
}

describe.skipIf(!financialPolicyReadFixtureEnabled)('financial writes through the full API and actual private PostgreSQL capabilities', () => {
  let f: FinancialPolicyReadFixture;
  beforeEach(async () => {
    f = await financialPolicyReadFixture({ originalClosure: true });
    expect(f.appliedMigrationNumbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 19]);
  }, 30_000);
  afterEach(async () => { await f?.close(); });
  function app(mutate: Mutate = f.repository.mutate.bind(f.repository), observation: {
    lifetimeMilliseconds?: number; observedExpiry?: (expiresAt: number) => void;
  } = {}) {
    const verifier = createFinancialPolicyApiVerifier({ environment: 'development', issuer,
      async observe(token) {
        const actor = tokens.get(token); if (!actor) throw new Error('Unknown synthetic actor.');
        const now = Date.now(), observedAt = new Date(now).toISOString(), tokenIssuedAt = new Date(now - 1000).toISOString();
        const expiresAt = now + (observation.lifetimeMilliseconds ?? 240_000); observation.observedExpiry?.(expiresAt);
        return { identity: { subject: actor, externalOrganizationId: 'clerk_org_a', externalOrganizationName: 'Synthetic policy fixture',
          externalMembershipId: `membership_${actor}`, externalRole: 'org:member', sessionId: `session_${actor}`,
          membershipObservedAt: observedAt, authenticatedAt: tokenIssuedAt },
          observation: { issuer, tokenHash: createHash('sha256').update(token).digest('hex'), tokenIssuedAt, observedAt,
            expiresAt: new Date(expiresAt).toISOString() } };
      } });
    const repository = { mutate, readFinancialPolicy: f.repository.readFinancialPolicy.bind(f.repository),
      listFinancialPolicyDrafts: f.repository.listFinancialPolicyDrafts.bind(f.repository) };
    const dependencies = { environment: 'development' as const, issuer, verifier, readers: f.readers, repository, authentication: f.authentication };
    return createApp({ allowedOrigins: [origin], financialPolicyGateway: createFinancialPolicyGateway(dependencies),
      financialPolicyWriteGateway: createFinancialPolicyWriteGateway(dependencies),
      financialPolicyClosureGateway: createFinancialPolicyClosureGateway({ ...dependencies,
        closures: new PostgresFinancialPolicyClosureRepository(f.authorizer.pool) }) });
  }
  async function read(application: App, path: string, actor = 'owner_a') {
    const response = await application.request(path, { headers: { Origin: origin, Authorization: `Bearer financial-write-postgres-${actor}` } });
    return { response, body: await response.json() };
  }
  async function post(application: App, input: FinancialPolicyWriteRequest, actor = 'owner_a', escaped = false) {
    const json = JSON.stringify(input.input), response = await application.request(input.route, { method: 'POST',
      headers: { Origin: origin, Authorization: `Bearer financial-write-postgres-${actor}`, 'Content-Type': 'application/json', 'Idempotency-Key': input.key },
      body: escaped ? json.replaceAll('🧵', '\\ud83e\\uddf5') : json });
    expect(response.headers.get('cache-control')).toBe('private, no-store'); expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    return { response, body: await response.json() };
  }
  async function recorded(application: App, input: FinancialPolicyWriteRequest, actor = 'owner_a', escaped = false) {
    const result = await post(application, input, actor, escaped); expect(result.response.status).toBe(200);
    const value = FinancialPolicyHttpMutationResponseSchema.parse(result.body);
    expect(value).toMatchObject({ status: 'recorded', effectiveAuthority: false, financialState: null,
      receipt: { key: input.key, effectiveAuthority: false, financialState: null } });
    expect(JSON.stringify(value)).not.toMatch(/identityEvidence|mfaEvidence|decisionNonce|tokenHash|sessionId|commandHash/);
    return value;
  }
  async function document(application: App, purpose: 'financial_mandate' | 'budget_policy' | 'approval_policy', actor = 'owner_a', id = `doc_${crypto.randomUUID()}`) {
    const input = request('save_document', id, { ...base(), purpose, text: `Synthetic ${purpose}. No spending authority.` },
      purpose === 'financial_mandate' ? responsibilityId : null);
    return { input, result: await recorded(application, input, actor) };
  }
  async function draftInput(application: App, doc: FinancialPolicyRef, actor = 'operations_a') {
    const context = await read(application, `${responsibility}/financial-policies/context`, actor);
    expect(context.response.status).toBe(200);
    const view = FinancialPolicyHttpContextSchema.parse(context.body); expect(view.draftScope).not.toBeNull();
    return FinancialPolicyHttpDraftSchema.parse({ scope: view.draftScope,
      terms: { mode: 'PREPARE_FOR_APPROVAL', actions: ['allocate_funds'], category: 'supplier_principal', allocation: 'responsibility_earmark',
        supplier: null, acceptedTerms: null, payee: null, tool: null, withdrawal: null, branch: null,
        communication: { recipients: [], purposes: [], kinds: [], allowanceBaseUnits: '0' } },
      documents: [{ ...doc, purpose: 'financial_mandate' }], governance: null, asset: null, account: null, trust: null,
      startsAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  }
  async function governanceInput(application: App) {
    const budget = await document(application, 'budget_policy'), approval = await document(application, 'approval_policy');
    const budgetAccountId = await financialBudgetAccountId('development', 'org_a', f.assetPin.key);
    const startsAt = new Date(Math.floor(Date.now() / 86_400_000) * 86_400_000).toISOString();
    const endsAt = new Date(Date.parse(startsAt) + 7 * 86_400_000).toISOString();
    const documents = [{ ...budget.result.receipt.target, purpose: 'budget_policy' }, { ...approval.result.receipt.target, purpose: 'approval_policy' }]
      .sort((a, b) => a.id < b.id ? -1 : 1);
    const bundle = { budgetAccountId, asset: f.assetPin, category: 'supplier_principal', limits: { perOperation: '100', perResponsibility: '500', perPeriod: '1000' },
      period: { id: await financialBudgetPeriodId(budgetAccountId, startsAt, endsAt), startsAt, endsAt },
      approval: { requesterRoles: ['finance', 'operations', 'owner'], approverRoles: ['finance', 'owner'], independent: true, actionSiteIds: ['site_a'],
        action: 'allocate_funds', category: 'supplier_principal', thresholdBaseUnits: '100', maximumAuthenticationAgeSeconds: 300, maximumApprovalAgeSeconds: 300 }, documents };
    return { input: request('propose_governance', 'proposal_a', { ...base(), bundle,
      expectedControl: { budgetAccountId, generation: 0, accepted: null }, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }), budget, approval };
  }
  async function recover(application: App, input: FinancialPolicyWriteRequest, actor = 'owner_a') {
    const requestHash = await financialPolicyHttpRequestHash({ environment: 'development', organizationId: 'org_a', actorId: actor }, input);
    const path = input.responsibilityId === null ? '/v1/financial-governance/operations' : `${responsibility}/financial-policy-operations`;
    return read(application, `${path}/${input.key}?kind=${input.kind}&targetId=${input.id}&requestHash=${requestHash}`, actor);
  }
  async function expectRejected(application: App, input: FinancialPolicyWriteRequest, code: string, status: number, actor = 'owner_a') {
    const before = await policyCounts(f), inert = await inertState(f), result = await post(application, input, actor);
    expect(result.response.status).toBe(status); expect(result.body.error.code).toBe(code);
    expect(await policyCounts(f)).toEqual(before); expect(await inertState(f)).toEqual(inert);
    expect(JSON.stringify(result.body)).not.toMatch(/SQL|postgres|identityEvidence|tokenHash/);
  }
  function racingApp() {
    let arrivals = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    return { application: app(async (evidence, command) => {
      if (++arrivals === 2) release();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([gate, new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Synthetic race did not reach both mutation seams.')), 3000);
        })]);
      } finally { clearTimeout(timer); }
      return f.repository.mutate(evidence, command);
    }), arrivals: () => arrivals };
  }

  it.each(['raw', 'escaped'] as const)('stores and hydrates maximum astral document text through %s HTTP JSON, preserving revisions', async encoding => {
    const application = app(), before = await policyCounts(f), inert = await inertState(f), text = '🧵'.repeat(20_000);
    const input = request('save_document', 'large_mandate', { ...base(), purpose: 'financial_mandate', text }, responsibilityId);
    const first = await recorded(application, input, 'operations_a', encoding === 'escaped');
    const secondInput = request('save_document', input.id, { ...base(), previous: first.receipt.target, purpose: 'financial_mandate', text: 'Revised full terms. Café 🧵' }, responsibilityId);
    const second = await recorded(application, secondInput, 'operations_a'); expect(second.receipt.target.version).toBe(2);
    const history = await read(application, `${input.route}/versions/1`, 'operations_a'); expect(history.response.status).toBe(200);
    expect(FinancialPolicyHttpRecordResponseSchema.parse(history.body).policy.record).toMatchObject({ kind: 'document', text, version: 1 });
    expect((await f.admin.query('SELECT body->>\'text\' AS text FROM pactwoven.financial_policy_records WHERE id=$1 AND version=1', [input.id])).rows[0].text).toBe(text);
    await expectDelta(f, before, 2); expect(await inertState(f)).toEqual(inert);
  });
  it('saves, revises and withdraws an Operations draft with exact document and predecessor references', async () => {
    const application = app(), before = await policyCounts(f), inert = await inertState(f), doc = await document(application, 'financial_mandate', 'operations_a');
    const draft = await draftInput(application, doc.result.receipt.target);
    const input = request('save_draft', 'draft_a', { ...base(), draft }, responsibilityId), first = await recorded(application, input, 'operations_a');
    const revised = request('save_draft', input.id, { ...base(), previous: first.receipt.target,
      draft: { ...draft, expiresAt: new Date(Date.now() + 3_000_000).toISOString() } }, responsibilityId);
    const second = await recorded(application, revised, 'operations_a');
    const withdrawal = request('withdraw_draft', input.id, { ...base(), previous: second.receipt.target }, responsibilityId);
    const withdrawn = await recorded(application, withdrawal, 'operations_a');
    expect(withdrawn.receipt.record).toMatchObject({ kind: 'draft', state: 'WITHDRAWN', version: 3, predecessor: second.receipt.target });
    const history = await read(application, `${input.route}/versions/1`, 'operations_a'); expect(history.response.status).toBe(200);
    expect(FinancialPolicyHttpRecordResponseSchema.parse(history.body).documents[0]?.reference).toEqual(doc.result.receipt.target);
    await expectRejected(application, request('save_draft', input.id, { ...base(), previous: withdrawn.receipt.target, draft }, responsibilityId),
      'FINANCIAL_POLICY_OUTCOME_UNKNOWN', 503, 'operations_a');
    await expectDelta(f, before, 4); expect(await inertState(f)).toEqual(inert);
  });
  it('proposes and revises governance while creating only stable inert account and period metadata', async () => {
    const application = app(), before = await policyCounts(f), inert = await inertState(f), prepared = await governanceInput(application);
    if (prepared.input.kind !== 'propose_governance') throw new Error('Governance input required.');
    const first = await recorded(application, prepared.input);
    const revised = request('propose_governance', prepared.input.id, { ...prepared.input.input, previous: first.receipt.target,
      bundle: { ...prepared.input.input.bundle, limits: { perOperation: '200', perResponsibility: '500', perPeriod: '1000' } } });
    const second = await recorded(application, revised); expect(second.receipt.target.version).toBe(2);
    const history = await read(application, `${prepared.input.route}/versions/1`, 'finance_a'); expect(history.response.status).toBe(200);
    const reviewed = FinancialPolicyHttpRecordResponseSchema.parse(history.body);
    expect(reviewed.documents.map(d => d.reference)).toEqual(prepared.input.input.bundle.documents.map(({ purpose: _purpose, ...ref }) => ref));
    expect(reviewed.policy).toMatchObject({ budgetConfiguration: { status: 'unavailable', control: null, currentBudgetConfiguration: null } });
    await expectDelta(f, before, 4, 1); expect(await inertState(f)).toEqual(inert);
  });
  it('replays an exact original and rejects changed visible material under its original key', async () => {
    const application = app(), before = await policyCounts(f), inert = await inertState(f), doc = await document(application, 'budget_policy');
    expect((await recorded(application, doc.input)).receipt).toEqual(doc.result.receipt);
    await expectRejected(application, request('save_document', doc.input.id, { ...doc.input.input, text: 'Changed visible terms.' }, null, doc.input.key),
      'FINANCIAL_POLICY_KEY_CONFLICT', 409);
    await expectDelta(f, before, 1); expect(await inertState(f)).toEqual(inert);
  });
  it.each(['exact', 'conflicting'] as const)('commits one reciprocal policy effect when %s requests race after both original preflights', async mode => {
    const before = await policyCounts(f), inert = await inertState(f), race = racingApp();
    const left = request('save_document', 'race_doc', { ...base(), purpose: 'budget_policy', text: 'First reviewed text.' });
    const right = mode === 'exact' ? left : request('save_document', left.id, { ...left.input, text: 'Different reviewed text.' }, null, left.key);
    const results = await Promise.all([post(race.application, left), post(race.application, right)]);
    expect(race.arrivals()).toBe(2); expect(results.map(r => r.response.status).sort()).toEqual(mode === 'exact' ? [200, 200] : [200, 503]);
    if (mode === 'exact') expect(results[0]!.body.receipt).toEqual(results[1]!.body.receipt);
    else {
      const winner = results.findIndex(r => r.response.status === 200), loser = 1 - winner;
      expect(results[loser]!.body.error.code).toBe('FINANCIAL_POLICY_OUTCOME_UNKNOWN');
      const recovered = await recover(app(), winner === 0 ? left : right); expect(recovered.response.status).toBe(200);
      const original = FinancialPolicyOriginalStatusResponseSchema.parse(recovered.body);
      expect(original.receipt).toEqual(results[winner]!.body.receipt); expect(original.closure).toBeNull();
      const conflicting = await recover(app(), loser === 0 ? left : right);
      expect(conflicting.response.status).toBe(409); expect(conflicting.body.error.code).toBe('FINANCIAL_POLICY_KEY_CONFLICT');
    }
    await expectDelta(f, before, 1); expect(await inertState(f)).toEqual(inert);
  });
  it('recovers an acknowledgement lost after a real commit through a reconstructed app and the original GET', async () => {
    const before = await policyCounts(f), inert = await inertState(f); let mutations = 0;
    const lost = app(async (evidence, command) => { mutations++; await f.repository.mutate(evidence, command); throw new Error('Synthetic lost acknowledgement after commit.'); });
    const input = request('save_document', 'lost_doc', { ...base(), purpose: 'budget_policy', text: 'Recover this exact reviewed original.' });
    const initial = await post(lost, input); expect(initial.response.status).toBe(503); expect(initial.body.error.code).toBe('FINANCIAL_POLICY_OUTCOME_UNKNOWN');
    expect(mutations).toBe(1); await expectDelta(f, before, 1);
    const rebuilt = app(), recovered = await recover(rebuilt, input); expect(recovered.response.status).toBe(200);
    const original = FinancialPolicyOriginalStatusResponseSchema.parse(recovered.body);
    expect(original.status).toBe('recorded'); expect(original.closure).toBeNull();
    expect((await recorded(rebuilt, input)).receipt).toEqual(original.receipt);
    await expectDelta(f, before, 1); expect(await inertState(f)).toEqual(inert);
  });
  it('enforces current owner role for new organization material and original authorship for revisions', async () => {
    const application = app(), prepared = await governanceInput(application);
    for (const actor of ['finance_a', 'operations_a']) {
      await expectRejected(application, request('save_document', `denied_${actor}`, { ...base(), purpose: 'budget_policy', text: 'Denied new policy.' }),
        'FINANCIAL_POLICY_ACCESS_DENIED', 403, actor);
      await expectRejected(application, prepared.input, 'FINANCIAL_POLICY_ACCESS_DENIED', 403, actor);
    }
    const proposal = await recorded(application, prepared.input);
    await expectRejected(application, request('propose_governance', prepared.input.id, { ...prepared.input.input, previous: proposal.receipt.target }),
      'FINANCIAL_POLICY_OUTCOME_UNKNOWN', 503, 'owner_b');
    await expectRejected(application, request('save_document', prepared.budget.input.id, { ...prepared.budget.input.input, previous: prepared.budget.result.receipt.target }),
      'FINANCIAL_POLICY_OUTCOME_UNKNOWN', 503, 'owner_b');
  });
  it.each(['site_memberships', 'member_action_sites'] as const)('denies responsibility writes when %s is absent', async table => {
    const application = app(), doc = await document(application, 'financial_mandate', 'operations_a');
    const input = request('save_draft', 'denied_draft', { ...base(), draft: await draftInput(application, doc.result.receipt.target) }, responsibilityId);
    await f.admin.query(`DELETE FROM pactwoven.${table} WHERE environment='development' AND organization_id='org_a' AND actor_id='operations_a'`);
    await expectRejected(application, input, 'FINANCIAL_POLICY_ACCESS_DENIED', 403, 'operations_a');
    await expectRejected(application, request('save_document', 'denied_doc', { ...base(), purpose: 'financial_mandate', text: 'Denied scope.' }, responsibilityId),
      'FINANCIAL_POLICY_ACCESS_DENIED', 403, 'operations_a');
  });
  it('rejects a stale new epoch while recovering its earlier exact original unchanged', async () => {
    const application = app(), doc = await document(application, 'budget_policy');
    await f.admin.query("UPDATE pactwoven.organizations SET authority_epoch=authority_epoch+1 WHERE environment='development' AND id='org_a'");
    await expectRejected(application, request('save_document', 'stale_epoch', { ...base(), purpose: 'budget_policy', text: 'Stale epoch.' }),
      'FINANCIAL_POLICY_SCOPE_CHANGED', 409);
    const before = await policyCounts(f), replay = await recorded(application, doc.input);
    expect(replay.scope.organizationEpoch).toBe(3); expect(replay.receipt).toEqual(doc.result.receipt); expect(await policyCounts(f)).toEqual(before);
  });
  it('rejects stale predecessors and stale document references without durable policy effects', async () => {
    const application = app(), doc = await document(application, 'financial_mandate', 'operations_a');
    const draft = await draftInput(application, doc.result.receipt.target);
    await recorded(application, request('save_document', doc.input.id, { ...doc.input.input, previous: doc.result.receipt.target, text: 'Revised current document.' }, responsibilityId), 'operations_a');
    await expectRejected(application, request('save_document', doc.input.id, { ...doc.input.input, previous: doc.result.receipt.target, text: 'Stale predecessor revision.' }, responsibilityId),
      'FINANCIAL_POLICY_OUTCOME_UNKNOWN', 503, 'operations_a');
    await expectRejected(application, request('save_draft', 'stale_document_draft', { ...base(), draft }, responsibilityId),
      'FINANCIAL_POLICY_OUTCOME_UNKNOWN', 503, 'operations_a');
  });
  it('keeps database control, asset, authority and site comparisons authoritative after public validation', async () => {
    const application = app(), governance = await governanceInput(application);
    if (governance.input.kind !== 'propose_governance') throw new Error('Governance input required.');
    // Schema-valid reviewed snapshots with exact derived identities; SQL must refuse
    // these mismatches. Post-dispatch errors remain unknown to the caller.
    await expectRejected(application, request('propose_governance', 'wrong_control', { ...governance.input.input,
      expectedControl: { ...governance.input.input.expectedControl, generation: 1, accepted: { id: 'absent_control', version: 1, recordHash: 'a'.repeat(64) } } }),
      'FINANCIAL_POLICY_OUTCOME_UNKNOWN', 503);
    await expectRejected(application, request('propose_governance', 'wrong_asset', { ...governance.input.input,
      bundle: { ...governance.input.input.bundle, asset: { ...f.assetPin, recordHash: 'f'.repeat(64) } } }), 'FINANCIAL_POLICY_OUTCOME_UNKNOWN', 503);
    const doc = await document(application, 'financial_mandate', 'operations_a'), draft = await draftInput(application, doc.result.receipt.target);
    const authority = { ...draft.scope.authority, generation: draft.scope.authority.generation + 1 };
    const authorityHash = await commandDigest({ namespace: 'pactwoven:financial-authority-fence:v1', record: { ...authority, environment: 'development', organizationId: 'org_a' } });
    await expectRejected(application, request('save_draft', 'wrong_authority', { ...base(), draft: { ...draft, scope: { ...draft.scope, authority, authorityHash } } }, responsibilityId),
      'FINANCIAL_POLICY_OUTCOME_UNKNOWN', 503, 'operations_a');
    await expectRejected(application, request('save_draft', 'wrong_site', { ...base(), draft: { ...draft,
      scope: { ...draft.scope, site: { ...draft.scope.site, generation: draft.scope.site.generation + 1 } } } }, responsibilityId),
      'FINANCIAL_POLICY_OUTCOME_UNKNOWN', 503, 'operations_a');
  });
  it.each(['grant', 'epoch', 'asset_control'] as const)('rechecks an actual %s change made after the original preflight before SQL mutation', async change => {
    const preparation = app();
    let input: FinancialPolicyWriteRequest, actor = 'owner_a';
    if (change === 'grant') {
      actor = 'operations_a'; const doc = await document(preparation, 'financial_mandate', actor);
      input = request('save_draft', 'revoked_grant', { ...base(), draft: await draftInput(preparation, doc.result.receipt.target) }, responsibilityId);
    } else if (change === 'asset_control') input = (await governanceInput(preparation)).input;
    else input = request('save_document', 'changed_epoch', { ...base(), purpose: 'budget_policy', text: 'Review before epoch change.' });
    const before = await policyCounts(f); let invocations = 0, changedRows = 0, databaseError: unknown;
    let afterInvalidation: Awaited<ReturnType<typeof inertState>> | undefined;
    // This seam is reached only after identity evidence, the exact original
    // preflight and all new-write gates have completed. Each command remains exact.
    const application = app(async (evidence, command) => {
      invocations++;
      if (change === 'grant') changedRows = (await f.admin.query("DELETE FROM pactwoven.member_action_sites WHERE environment='development' AND organization_id='org_a' AND actor_id='operations_a' AND site_id='site_a'")).rowCount ?? 0;
      else if (change === 'epoch') changedRows = (await f.admin.query("UPDATE pactwoven.organizations SET authority_epoch=authority_epoch+1 WHERE environment='development' AND id='org_a'")).rowCount ?? 0;
      else changedRows = (await f.admin.query('UPDATE pactwoven.finance_asset_controls SET accepts_observations=false,revoked_at=clock_timestamp() WHERE asset_key=$1', [f.assetPin.key])).rowCount ?? 0;
      // The deliberate fixture invalidation is the new baseline: the attempted
      // application write must not add authority, provenance or policy effects.
      afterInvalidation = await inertState(f);
      try { return await f.repository.mutate(evidence, command); }
      catch (error) { databaseError = error; throw error; }
    });
    const result = await post(application, input, actor);
    expect(result.response.status).toBe(503); expect(result.body.error.code).toBe('FINANCIAL_POLICY_OUTCOME_UNKNOWN');
    expect(invocations).toBe(1); expect(changedRows).toBe(1);
    expect(databaseError).toMatchObject({ code: change === 'grant' ? 'FINANCIAL_POLICY_ACCESS_DENIED' : 'FINANCIAL_POLICY_SCOPE_CHANGED' });
    expect(afterInvalidation).toBeDefined(); expect(await inertState(f)).toEqual(afterInvalidation); expect(await policyCounts(f)).toEqual(before);
  });
  it('rechecks actual identity expiry after an observed SQL row-lock wait without retry or a durable write', async () => {
    const before = await policyCounts(f), inert = await inertState(f);
    let expiresAt = 0, invocations = 0, remainingAtLock = 0, blocked = false, expiredBeforeRelease = false, databaseError: unknown;
    const application = app(async (evidence, command) => {
      invocations++;
      const holder = await f.admin.connect();
      let pending: Promise<{ value: unknown } | { error: unknown }> | undefined;
      try {
        await holder.query('BEGIN');
        await holder.query("SELECT id FROM pactwoven.organizations WHERE environment='development' AND id='org_a' FOR UPDATE");
        const holderPid = (await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        remainingAtLock = expiresAt - Date.now();
        if (remainingAtLock < 250) throw new Error('Synthetic observation expired before the intended SQL wait.');
        pending = f.repository.mutate(evidence, command).then(value => ({ value }), error => ({ error }));
        const deadline = Math.min(Date.now() + 1000, expiresAt - 100);
        while (Date.now() < deadline) {
          blocked = (await f.admin.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
            WHERE datname=current_database() AND usename=$1 AND $2::int=ANY(pg_blocking_pids(pid))) AS blocked`, [f.authorizer.role, holderPid])).rows[0].blocked;
          if (blocked) break;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        if (!blocked) throw new Error('The actual policy writer did not reach the bounded SQL lock wait.');
        const remaining = expiresAt + 50 - Date.now();
        if (remaining < 0 || remaining > 2000) throw new Error('Synthetic expiry wait exceeded its bound.');
        await new Promise(resolve => setTimeout(resolve, remaining));
        expiredBeforeRelease = (await holder.query('SELECT clock_timestamp()>=$1::timestamptz AS expired', [new Date(expiresAt).toISOString()])).rows[0].expired;
        await holder.query('COMMIT');
        const outcome = await pending;
        if ('error' in outcome) { databaseError = outcome.error; throw outcome.error; }
        return outcome.value;
      } finally {
        try { await holder.query('ROLLBACK'); }
        finally {
          holder.release();
          // Drain the real query even on setup/assertion failures before fixture
          // cleanup; the repository owns its rollback and connection disposal.
          if (pending) await pending;
        }
      }
    }, { lifetimeMilliseconds: 1800, observedExpiry: value => { expiresAt = value; } });
    const input = request('save_document', 'wait_expired', { ...base(), purpose: 'budget_policy', text: 'Expires behind an actual SQL row lock.' });
    const result = await post(application, input);
    expect(result.response.status).toBe(503); expect(result.body.error.code).toBe('FINANCIAL_POLICY_OUTCOME_UNKNOWN');
    expect(invocations).toBe(1); expect(remainingAtLock).toBeGreaterThanOrEqual(250); expect(blocked).toBe(true); expect(expiredBeforeRelease).toBe(true);
    expect(databaseError).toMatchObject({ code: 'FINANCIAL_POLICY_ACCESS_DENIED' });
    expect(await policyCounts(f)).toEqual(before); expect(await inertState(f)).toEqual(inert);
  });
  // Live accepted governance-control advancement is intentionally deferred to a
  // consent-qualified fixture: changing it requires the excluded acceptance/MFA
  // flow. The wrong-control test above is a separate snapshot-mismatch check.
});
