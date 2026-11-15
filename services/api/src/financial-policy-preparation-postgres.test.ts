import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FinancialPolicyPreparationResponseSchema, FinancialPolicyHttpRequestSchema, FinancialPolicyHttpDraftSchema,
  FinancialPolicyHttpMutationResponseSchema, type FinancialPolicyPreparationRequest, type FinancialPolicyPreparationResponse,
  type FinancialPolicyRef } from '@pactwoven/contracts';
import { PostgresFinancialPolicyPreparationReader, type FinancialPolicyPreparation } from '@pactwoven/db';
import { financialPolicyReadFixture, financialPolicyReadFixtureEnabled, type FinancialPolicyReadFixture }
  from '../../../packages/db/src/financial-policy-read.test-support.js';
import { createApp } from './app.js';
import { createFinancialPolicyApiVerifier } from './financial-policy-verifier.js';
import { createFinancialPolicyGateway } from './financial-policy-service.js';
import { createFinancialPolicyWriteGateway, type FinancialPolicyWriteRequest } from './financial-policy-write-service.js';
import { createFinancialPolicyPreparationGateway, type FinancialPolicyPreparationGatewayDependencies } from './financial-policy-preparation-service.js';

// Uses only the checked, exclusive policy-reads fixture and its
// exact thirteen-migration guard. Synthetic identity is not Clerk qualification.
const issuer = 'https://synthetic.invalid', origin = 'http://localhost:3001', rid = 'responsibility_a';
const responsibility = `/v1/responsibilities/${rid}`, preparationPath = `${responsibility}/financial-policy-preparation`;
const tokens = new Map(['owner_a', 'owner_b', 'finance_a', 'operations_a'].map(actor => [`preparation-postgres-${actor}`, actor]));
const selection = (id = 'document_a', purpose: 'financial_mandate' | 'budget_policy' | 'approval_policy' = 'budget_policy', previous: FinancialPolicyRef | null = null): FinancialPolicyPreparationRequest =>
  ({ schemaVersion: 1, action: 'save_document', targetId: id, previous, purpose });
const base = (epoch = 2) => ({ schemaVersion: 1, organizationEpoch: epoch, previous: null });
type BeforePrepare = NonNullable<FinancialPolicyPreparationGatewayDependencies['preparationReader']['prepare']>;
type Application = ReturnType<typeof createApp>;
const policyRelations = ['financial_policy_operations', 'financial_policy_records', 'financial_policy_audit', 'financial_policy_outbox',
  'financial_budget_accounts', 'financial_budget_periods', 'financial_governance_controls', 'financial_policy_evidence_uses',
  'financial_authority_fences', 'financial_authority_history', 'financial_site_fences', 'financial_site_history',
  'financial_asset_fences', 'financial_account_fences', 'financial_source_fences', 'financial_source_binding_fences', 'financial_registry_history',
  'mandate_heads', 'mandate_versions', 'mandate_operations', 'custody_setup_anchors', 'custody_setup_records', 'custody_setup_controls',
  'custody_setup_operations', 'custody_setup_evidence_uses', 'finance_physical_assets', 'finance_asset_versions', 'finance_asset_controls',
  'finance_physical_accounts', 'finance_account_versions', 'finance_account_controls', 'finance_sources', 'finance_source_versions',
  'finance_source_controls', 'finance_source_bindings', 'finance_transfer_facts', 'finance_account_effects', 'finance_deliveries',
  'finance_observation_links', 'finance_provenance_conflicts'] as const;
async function state(f: FinancialPolicyReadFixture) {
  const rows = await Promise.all(policyRelations.map(async table => [table, (await f.admin.query(
    `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM pactwoven.${table} t`)).rows[0].rows]));
  const nonidentity = (await f.admin.query("SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) AS rows FROM pactwoven.financial_policy_evidence t WHERE kind<>'identity'")).rows[0].rows;
  return { tables: Object.fromEntries(rows), nonidentity };
}
function writeRequest(kind: 'save_document' | 'save_draft', id: string, input: unknown, responsibilityId: string | null): FinancialPolicyWriteRequest {
  const route = kind === 'save_draft' ? `${responsibility}/financial-policies/${id}` : responsibilityId === null ?
    `/v1/financial-governance/documents/${id}` : `${responsibility}/financial-policy-documents/${id}`;
  return FinancialPolicyHttpRequestSchema.parse({ kind, id, responsibilityId, route, key: `prepare_write_${crypto.randomUUID()}`, input }) as FinancialPolicyWriteRequest;
}
async function metadata(application: Application, input: FinancialPolicyPreparationRequest, responsibilityId: string | null = null, actor = 'owner_a') {
  const response = await application.request(responsibilityId === null ? '/v1/financial-governance-preparation' : preparationPath, { method: 'POST',
    headers: { Origin: origin, Authorization: `Bearer preparation-postgres-${actor}`, 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  expect(response.headers.get('cache-control')).toBe('private, no-store'); expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  return { response, body: await response.json() };
}
async function prepared(application: Application, input: FinancialPolicyPreparationRequest, responsibilityId: string | null = null, actor = 'owner_a') {
  const result = await metadata(application, input, responsibilityId, actor); expect(result.response.status).toBe(200);
  const value = FinancialPolicyPreparationResponseSchema.parse(result.body);
  expect(value.selection).toEqual(input); expect(value.responsibilityId).toBe(responsibilityId);
  expect(value).toMatchObject({ effectiveAuthority: false, financialState: null });
  expect(JSON.stringify(value)).not.toMatch(/subject|sessionId|externalMembershipId|externalOrganizationId|identityEvidence|tokenHash|decisionNonce|originalActorMatches/);
  return value;
}
async function write(application: Application, input: FinancialPolicyWriteRequest, actor = 'owner_a') {
  const response = await application.request(input.route, { method: 'POST', headers: { Origin: origin,
    Authorization: `Bearer preparation-postgres-${actor}`, 'Content-Type': 'application/json', 'Idempotency-Key': input.key }, body: JSON.stringify(input.input) });
  return { response, body: await response.json() };
}
async function recorded(application: Application, input: FinancialPolicyWriteRequest, actor = 'owner_a') {
  const result = await write(application, input, actor); expect(result.response.status).toBe(200);
  return FinancialPolicyHttpMutationResponseSchema.parse(result.body);
}
function draftFrom(value: FinancialPolicyPreparationResponse) {
  if (value.material.action !== 'save_draft' || value.decision.state !== 'reviewable' || !value.material.draftScope || !value.material.document)
    throw new Error('Current complete draft preparation required by the test.');
  return FinancialPolicyHttpDraftSchema.parse({ scope: value.material.draftScope,
    terms: { mode: 'PREPARE_FOR_APPROVAL', actions: ['allocate_funds'], category: 'supplier_principal', allocation: 'responsibility_earmark',
      supplier: null, acceptedTerms: null, payee: null, tool: null, withdrawal: null, branch: null,
      communication: { recipients: [], purposes: [], kinds: [], allowanceBaseUnits: '0' } },
    documents: [{ ...value.material.document.reference, purpose: 'financial_mandate' }], asset: null, account: null, governance: null, trust: null,
    startsAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
}

describe.skipIf(!financialPolicyReadFixtureEnabled)('preparation through the full API and existing exclusive PostgreSQL fixture', () => {
  let f: FinancialPolicyReadFixture;
  beforeEach(async () => { f = await financialPolicyReadFixture(); }, 60_000);
  afterEach(async () => { await f?.close(); });
  function app(options: { lifetimeMilliseconds?: number; beforePrepare?: (...args: Parameters<BeforePrepare>) => Promise<void> } = {}) {
    const observations: { observedAt: string; expiresAt: string }[] = [], privateReads: FinancialPolicyPreparation[] = [];
    let preparationCalls = 0;
    const verifier = createFinancialPolicyApiVerifier({ environment: 'development', issuer, async observe(token) {
      const actor = tokens.get(token); if (!actor) throw new Error('Unknown synthetic fixture token.');
      const now = Date.now(), observedAt = new Date(now - 500).toISOString(), tokenIssuedAt = new Date(now - 1000).toISOString();
      const expiresAt = new Date(Date.parse(observedAt) + (options.lifetimeMilliseconds ?? 240_000)).toISOString();
      observations.push({ observedAt, expiresAt });
      return { identity: { subject: actor, externalOrganizationId: 'clerk_org_a', externalOrganizationName: 'Synthetic policy fixture',
        externalMembershipId: `membership_${actor}`, externalRole: 'org:member', sessionId: `session_${actor}`, membershipObservedAt: observedAt, authenticatedAt: tokenIssuedAt },
        observation: { issuer, tokenHash: createHash('sha256').update(token).digest('hex'), tokenIssuedAt, observedAt, expiresAt } };
    } });
    const dependencies = { environment: 'development' as const, issuer, verifier, readers: f.readers, repository: f.repository, authentication: f.authentication };
    const reader = new PostgresFinancialPolicyPreparationReader(f.authorizer.pool);
    const preparationReader: FinancialPolicyPreparationGatewayDependencies['preparationReader'] = {
      async prepare(evidenceId, scope, query) {
        preparationCalls++; await options.beforePrepare?.(evidenceId, scope, query);
        const result = await reader.prepare(evidenceId, scope, query); privateReads.push(result); return result;
      },
    };
    const application = createApp({ allowedOrigins: [origin], financialPolicyGateway: createFinancialPolicyGateway(dependencies),
      financialPolicyWriteGateway: createFinancialPolicyWriteGateway(dependencies),
      financialPolicyPreparationGateway: createFinancialPolicyPreparationGateway({ environment: dependencies.environment, issuer,
        verifier, readers: f.readers, authentication: f.authentication, preparationReader }) });
    return { application, observations, privateReads, preparationCalls: () => preparationCalls };
  }

  it('accepts the later real SQL observation while preserving original expiry and only appending identity evidence', async () => {
    const a = app(), before = await state(f), count = (await f.admin.query("SELECT count(*)::int AS n FROM pactwoven.financial_policy_evidence WHERE kind='identity'")).rows[0].n;
    const result = await prepared(a.application, selection());
    expect(result.decision.state).toBe('reviewable'); expect(result.target.state).toBe('absent');
    expect(a.preparationCalls()).toBe(1); expect(a.privateReads).toHaveLength(1); expect(a.observations).toHaveLength(1);
    expect(Date.parse(a.privateReads[0]!.observedAt)).toBeGreaterThan(Date.parse(a.observations[0]!.observedAt));
    expect(result.observation.observedAt).toBe(a.observations[0]!.observedAt);
    expect(Date.parse(result.observation.expiresAt)).toBe(Date.parse(a.observations[0]!.observedAt) + 20_000);
    expect(await state(f)).toEqual(before);
    expect((await f.admin.query("SELECT count(*)::int AS n FROM pactwoven.financial_policy_evidence WHERE kind='identity'")).rows[0].n).toBe(count + 1);
  });
  it('prepares full mandate text, writes separately, prepares its current reference, then writes only an incomplete draft', async () => {
    const a = app(), before = await state(f), docSelection = selection('journey_mandate', 'financial_mandate');
    const review = await prepared(a.application, docSelection, rid, 'operations_a'); expect(review.decision.state).toBe('reviewable'); expect(await state(f)).toEqual(before);
    const document = await recorded(a.application, writeRequest('save_document', docSelection.targetId,
      { ...base(review.scope.organizationEpoch), purpose: 'financial_mandate', text: 'Reviewed full mandate. Café 🧵' }, rid), 'operations_a');
    const draftSelection: FinancialPolicyPreparationRequest = { schemaVersion: 1, action: 'save_draft', targetId: 'journey_draft', previous: null, document: document.receipt.target };
    const beforeDraftReview = await state(f), draftReview = await prepared(a.application, draftSelection, rid, 'operations_a');
    expect(draftReview.material).toMatchObject({ action: 'save_draft', document: { reference: document.receipt.target,
      record: { text: 'Reviewed full mandate. Café 🧵' } }, asset: null, account: null, governance: null, trust: null });
    expect(await state(f)).toEqual(beforeDraftReview);
    const result = await recorded(a.application, writeRequest('save_draft', draftSelection.targetId,
      { ...base(draftReview.scope.organizationEpoch), draft: draftFrom(draftReview) }, rid), 'operations_a');
    expect(result.receipt.record).toMatchObject({ kind: 'draft', state: 'DRAFT', draft: { asset: null, account: null, governance: null, trust: null } });
    expect(result).toMatchObject({ effectiveAuthority: false, financialState: null });
    expect((await f.admin.query('SELECT count(*)::int AS n FROM pactwoven.financial_policy_records')).rows[0].n).toBe(2);
  });
  it('does not reserve an absent target and requires explicit reselection after another write', async () => {
    const a = app(), input = selection('shared_target'), before = await state(f);
    expect((await prepared(a.application, input)).target.state).toBe('absent'); expect((await prepared(a.application, input)).target.state).toBe('absent');
    expect(await state(f)).toEqual(before);
    const saved = await recorded(a.application, writeRequest('save_document', input.targetId, { ...base(), purpose: 'budget_policy', text: 'Explicit intervening write.' }, null));
    const afterWrite = await state(f), changed = await prepared(a.application, input);
    expect(changed.target).toEqual({ state: 'changed', latestReference: saved.receipt.target, record: null, historicalDocuments: [] });
    expect(changed.selection).toEqual(input); expect(changed.decision.reasons).toEqual(['PREDECESSOR_CHANGED']);
    const exact = await prepared(a.application, selection(input.targetId, 'budget_policy', saved.receipt.target));
    expect(exact.target).toMatchObject({ state: 'exact', record: { record: { text: 'Explicit intervening write.' } } }); expect(await state(f)).toEqual(afterWrite);
  });
  it('returns blocked selected-document changes without substituting new terms or creating policy effects', async () => {
    const a = app(), doc = await f.saveDocument('financial_mandate', 'selected_mandate', 'operations_a');
    const input: FinancialPolicyPreparationRequest = { schemaVersion: 1, action: 'save_draft', targetId: 'selected_draft', previous: null, document: doc.result.target };
    expect((await prepared(a.application, input, rid, 'operations_a')).decision.state).toBe('reviewable');
    await recorded(a.application, writeRequest('save_document', doc.result.body.id,
      { ...base(), previous: doc.result.target, purpose: 'financial_mandate', text: 'New current terms.' }, rid), 'operations_a');
    const before = await state(f), stale = await prepared(a.application, input, rid, 'operations_a');
    expect(stale.decision.reasons).toEqual(['DOCUMENT_CHANGED']); expect(stale.material).toMatchObject({ action: 'save_draft', document: null });
    expect(stale.selection).toEqual(input); expect(await state(f)).toEqual(before);
  });
  it('keeps final writer document comparisons authoritative after a successful preparation', async () => {
    const a = app(), doc = await f.saveDocument('financial_mandate', 'write_fence_mandate', 'operations_a');
    const review = await prepared(a.application, { schemaVersion: 1, action: 'save_draft', targetId: 'stale_draft', previous: null, document: doc.result.target }, rid, 'operations_a');
    const request = writeRequest('save_draft', 'stale_draft', { ...base(), draft: draftFrom(review) }, rid);
    await recorded(a.application, writeRequest('save_document', doc.result.body.id,
      { ...base(), previous: doc.result.target, purpose: 'financial_mandate', text: 'Concurrent revision before draft write.' }, rid), 'operations_a');
    const before = await state(f), result = await write(a.application, request, 'operations_a');
    expect(result.response.status).toBe(503); expect(result.body.error.code).toBe('FINANCIAL_POLICY_OUTCOME_UNKNOWN'); expect(await state(f)).toEqual(before);
  });
  it('cannot use preparation to bypass a later exact predecessor change at the writer', async () => {
    const a = app(), doc = await f.saveDocument('budget_policy', 'concurrent_predecessor');
    const input = selection(doc.result.body.id, 'budget_policy', doc.result.target), review = await prepared(a.application, input);
    expect(review.decision.state).toBe('reviewable');
    const current = await recorded(a.application, writeRequest('save_document', input.targetId,
      { ...base(), previous: doc.result.target, purpose: 'budget_policy', text: 'Concurrent current revision.' }, null));
    const before = await state(f), staleWrite = await write(a.application, writeRequest('save_document', input.targetId,
      { ...base(review.scope.organizationEpoch), previous: review.selection.previous, purpose: 'budget_policy', text: 'Based on earlier preparation.' }, null));
    expect(staleWrite.response.status).toBe(503); expect(staleWrite.body.error.code).toBe('FINANCIAL_POLICY_OUTCOME_UNKNOWN');
    const changed = await prepared(a.application, input);
    expect(changed.target).toEqual({ state: 'changed', latestReference: current.receipt.target, record: null, historicalDocuments: [] });
    expect(changed.selection).toEqual(input); expect(await state(f)).toEqual(before);
  });
  it.each(['site_memberships', 'member_action_sites'] as const)('requires the current %s grant for responsibility preparation', async table => {
    const a = app();
    expect((await f.admin.query(`DELETE FROM pactwoven.${table} WHERE environment='development' AND organization_id='org_a' AND actor_id='operations_a' AND site_id='site_a'`)).rowCount).toBe(1);
    const before = await state(f), result = await metadata(a.application, selection('denied_mandate', 'financial_mandate'), rid, 'operations_a');
    expect(result.response.status).toBe(403); expect(result.body.error.code).toBe('FINANCIAL_POLICY_ACCESS_DENIED'); expect(await state(f)).toEqual(before);
  });
  it('rechecks a grant removed after identity append and exact scope resolution before real SQL preparation', async () => {
    let changedRows = 0; let before: Awaited<ReturnType<typeof state>> | undefined;
    const a = app({ async beforePrepare() {
      changedRows = (await f.admin.query("DELETE FROM pactwoven.member_action_sites WHERE environment='development' AND organization_id='org_a' AND actor_id='operations_a' AND site_id='site_a'")).rowCount ?? 0;
      before = await state(f);
    } });
    const result = await metadata(a.application, selection('changed_grant_mandate', 'financial_mandate'), rid, 'operations_a');
    expect(a.preparationCalls()).toBe(1); expect(changedRows).toBe(1); expect(before).toBeDefined();
    expect(result.response.status).toBe(403); expect(result.body.error.code).toBe('FINANCIAL_POLICY_ACCESS_DENIED'); expect(await state(f)).toEqual(before);
  });
  it('refuses original identity expiry during a bounded pre-read wait without policy effects or retry', async () => {
    let expiredAtDatabase = false;
    const a = app({ lifetimeMilliseconds: 1800, async beforePrepare() {
      const expiry = Date.parse(a.observations.at(-1)!.expiresAt), remaining = expiry + 50 - Date.now();
      if (remaining < 50 || remaining > 2000) throw new Error('Original fixture observation cannot support the bounded wait.');
      await new Promise(resolve => setTimeout(resolve, remaining));
      expiredAtDatabase = (await f.admin.query('SELECT clock_timestamp()>=$1::timestamptz AS expired', [new Date(expiry).toISOString()])).rows[0].expired;
    } });
    const before = await state(f), result = await metadata(a.application, selection('expired_preparation'));
    expect(expiredAtDatabase).toBe(true); expect(a.preparationCalls()).toBe(1); expect(a.privateReads).toHaveLength(0);
    expect(result.response.status).toBe(403); expect(result.body.error.code).toBe('FINANCIAL_POLICY_ACCESS_DENIED'); expect(await state(f)).toEqual(before);
  });
  it('prepares registered generation-zero proposal material without creating account, period or accepted control', async () => {
    const a = app(), budget = await f.saveDocument('budget_policy'), approval = await f.saveDocument('approval_policy'), before = await state(f);
    const result = await prepared(a.application, { schemaVersion: 1, action: 'propose_governance', targetId: 'new_proposal', previous: null,
      assetKey: f.assetPin.key, budgetDocument: budget.result.target, approvalDocument: approval.result.target });
    expect(result.decision.state).toBe('reviewable'); expect(result.material).toMatchObject({ action: 'propose_governance', asset: { pin: f.assetPin },
      control: { generation: 0, accepted: null }, acceptedConfiguration: null, periods: [], eligibleActionSites: [{ id: 'site_a' }] });
    expect(await state(f)).toEqual(before);
  });
  it('allows Finance blocked organization disclosure while denying Operations without material leakage', async () => {
    const a = app(), before = await state(f), finance = await prepared(a.application, selection(), null, 'finance_a');
    expect(finance.decision.reasons).toEqual(['ROLE_REQUIRED']);
    const operations = await metadata(a.application, selection(), null, 'operations_a');
    expect(operations.response.status).toBe(403); expect(operations.body.error.code).toBe('FINANCIAL_POLICY_ACCESS_DENIED');
    expect(operations.body).not.toHaveProperty('target'); expect(operations.body).not.toHaveProperty('material'); expect(await state(f)).toEqual(before);
  });
});
