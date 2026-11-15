import { describe, expect, it, vi } from 'vitest';
import { FINANCE_DEVNET_ASSET, FinancialPolicyHttpMutationResponseSchema, FinancialPolicyHttpRequestSchema,
  type FinancialPolicyHttpDraft } from '@pactwoven/contracts';
import { DomainError, commandDigest, financialPolicyHttpRequestHash, physicalAssetKey, financialBudgetAccountId,
  financialBudgetPeriodId } from '@pactwoven/domain';
import { createApp } from './app.js';
import type { FinancialPolicyGateway } from './financial-policy-service.js';
import type { FinancialPolicyWriteGateway, FinancialPolicyWriteRequest } from './financial-policy-write-service.js';
import type { CustodySetupGateway } from './custody-setup-service.js';

const origin = 'http://localhost:3001', token = 'financial-integration-fixture', key = 'financial_original_0001', hash = 'a'.repeat(64);
const headers = { Authorization: `Bearer ${token}`, Origin: origin, 'X-Correlation-Id': 'financial_integration',
  'Idempotency-Key': key, 'Content-Type': 'application/json' };
const responsibility = '/v1/responsibilities/responsibility_a', docPath = `${responsibility}/financial-policy-documents/document_a`;
const reference = (id: string) => ({ id, version: 1, recordHash: hash });
const base = { schemaVersion: 1, organizationEpoch: 2, previous: null };
const documentBody = { ...base, purpose: 'financial_mandate', text: 'Exact mandate. Café 🧵' };
const reads = [
  [`${responsibility}/financial-policies/context`, 'context'], [`${responsibility}/financial-policies`, 'index'],
  [`${responsibility}/financial-policies/draft_a/versions/1`, 'get'], [`${docPath}/versions/1`, 'get'],
  ['/v1/financial-governance/context', 'context'], ['/v1/financial-governance', 'index'],
  ['/v1/financial-governance/proposal_a/versions/1', 'get'], ['/v1/financial-governance/documents/document_a/versions/1', 'get'],
  [`${responsibility}/financial-policy-operations/${key}?kind=save_draft&targetId=draft_a&requestHash=${hash}`, 'recover'],
  [`/v1/financial-governance/operations/${key}?kind=propose_governance&targetId=proposal_a&requestHash=${hash}`, 'recover'],
] as const;
function fixture(configured = true) {
  const verifyIdentity = vi.fn(async () => { throw new Error('Generic identity must not authorize a financial route.'); });
  const reject = () => vi.fn(async () => { throw new DomainError('FINANCIAL_POLICY_SCOPE_CHANGED', 409, 'private diagnostic'); });
  const read: FinancialPolicyGateway = { context: reject(), index: reject(), get: reject(), recover: reject() };
  const submit = vi.fn<FinancialPolicyWriteGateway['submit']>(async () => { throw new DomainError('FINANCIAL_POLICY_SCOPE_CHANGED', 409, 'private diagnostic'); });
  const app = createApp({ allowedOrigins: [origin], verifyIdentity, financialPolicyGateway: read,
    ...(configured ? { financialPolicyWriteGateway: { submit } } : {}) });
  return { app, verifyIdentity, read, submit };
}
function secure(response: Response) {
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(response.headers.get('access-control-allow-origin')).toBe(origin);
  expect(response.headers.get('x-correlation-id')).toBe('financial_integration');
}
function noProvider(f: ReturnType<typeof fixture>) {
  expect(f.submit).not.toHaveBeenCalled(); expect(f.verifyIdentity).not.toHaveBeenCalled();
  for (const method of Object.values(f.read)) expect(method).not.toHaveBeenCalled();
}
async function samples() {
  const instant = (offset: number) => new Date(Date.now() + offset).toISOString();
  const authority = { schemaVersion: 1 as const, responsibility: { id: 'responsibility_a', version: 1, hash, siteId: 'site_a' },
    generation: 0, family: 'none' as const, legacyHead: null };
  const draft: FinancialPolicyHttpDraft = {
    scope: { authority, authorityHash: await commandDigest({ namespace: 'pactwoven:financial-authority-fence:v1',
      record: { ...authority, environment: 'development', organizationId: 'org_a' } }), site: { id: 'site_a', generation: 0, recordHash: hash } },
    terms: { mode: 'PREPARE_FOR_APPROVAL', actions: ['allocate_funds'], category: 'supplier_principal', allocation: 'responsibility_earmark',
      supplier: null, acceptedTerms: null, payee: null, tool: null, withdrawal: null, branch: null,
      communication: { recipients: [], purposes: [], kinds: [], allowanceBaseUnits: '0' } },
    documents: [{ ...reference('document_a'), purpose: 'financial_mandate' }], governance: null, asset: null, account: null,
    trust: null, startsAt: instant(-60_000), expiresAt: instant(300_000),
  };
  const asset = { key: await physicalAssetKey(FINANCE_DEVNET_ASSET), version: 1, recordHash: hash, financialUseEpoch: 0 };
  const budgetAccountId = await financialBudgetAccountId('development', 'org_a', asset.key), startsAt = instant(-60_000), endsAt = instant(600_000);
  const bundle = { budgetAccountId, asset, category: 'supplier_principal', limits: { perOperation: '100', perResponsibility: '500', perPeriod: '1000' },
    period: { id: await financialBudgetPeriodId(budgetAccountId, startsAt, endsAt), startsAt, endsAt },
    approval: { requesterRoles: ['finance', 'operations', 'owner'], approverRoles: ['finance', 'owner'], independent: true,
      actionSiteIds: ['site_a'], action: 'allocate_funds', category: 'supplier_principal', thresholdBaseUnits: '50',
      maximumAuthenticationAgeSeconds: 300, maximumApprovalAgeSeconds: 300 },
    documents: [{ ...reference('approval_doc'), purpose: 'approval_policy' }, { ...reference('budget_doc'), purpose: 'budget_policy' }] };
  return [
    { path: docPath, body: documentBody, kind: 'save_document' },
    { path: '/v1/financial-governance/documents/budget_doc', body: { ...base, purpose: 'budget_policy', text: 'Exact budget.' }, kind: 'save_document' },
    { path: `${responsibility}/financial-policies/draft_a`, body: { ...base, draft }, kind: 'save_draft' },
    { path: `${responsibility}/financial-policies/draft_a/withdraw`, body: { ...base, previous: reference('draft_a') }, kind: 'withdraw_draft' },
    { path: '/v1/financial-governance/proposal_a', body: { ...base, bundle, expectedControl: { budgetAccountId, generation: 0, accepted: null },
      expiresAt: instant(300_000) }, kind: 'propose_governance' },
  ];
}
async function receipt(input: FinancialPolicyWriteRequest) {
  if (input.kind !== 'save_draft' && input.kind !== 'save_document') throw new Error('Only document/draft response fixture supported.');
  const actor = { actorId: 'owner_a', membershipVersion: 1 }, now = Date.now();
  const common = { schemaVersion: 1, environment: 'development', organizationId: 'org_a', responsibilityId: input.responsibilityId,
    id: input.id, version: (input.input.previous?.version ?? 0) + 1, predecessor: input.input.previous, actor,
    organizationEpoch: 2, operationId: '00000000-0000-0000-0000-000000000001', createdAt: new Date(now - 1000).toISOString() };
  const record = input.kind === 'save_document' ? { ...common, kind: 'document', purpose: input.input.purpose, text: input.input.text, contentHash: hash }
    : { ...common, kind: 'draft', state: 'DRAFT', requester: actor, draft: input.input.draft };
  return FinancialPolicyHttpMutationResponseSchema.parse({ schemaVersion: 1, status: 'recorded', effectiveAuthority: false, financialState: null,
    scope: { environment: 'development', organizationId: 'org_a', actor, organizationEpoch: 2, roles: ['owner'], siteIds: ['site_a'], actionSiteIds: ['site_a'] },
    observation: { observedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 19_000).toISOString() },
    receipt: { schemaVersion: 1, environment: 'development', organizationId: 'org_a', actor, responsibilityId: input.responsibilityId,
      operationId: common.operationId, kind: input.kind, key: input.key, publicRequestHash: await financialPolicyHttpRequestHash({
        environment: 'development', organizationId: 'org_a', actorId: 'owner_a' }, input),
      target: { id: input.id, version: common.version, recordHash: hash }, record, effectiveAuthority: false, financialState: null } });
}

describe('financial writers integrated before dedicated reads and generic middleware', () => {
  it('dispatches all five canonical writes exclusively through the dedicated writer', async () => {
    const f = fixture();
    for (const sample of await samples()) {
      const response = await f.app.request(sample.path, { method: 'POST', headers, body: JSON.stringify(sample.body) });
      expect(response.status).toBe(409); secure(response);
      const call = f.submit.mock.calls.at(-1)!; expect(call[0]).toBe(token);
      expect(FinancialPolicyHttpRequestSchema.parse(call[1])).toMatchObject({ kind: sample.kind, route: sample.path, input: sample.body, key });
      expect(await response.json()).toEqual({ error: { code: 'FINANCIAL_POLICY_SCOPE_CHANGED',
        message: 'The policy scope changed. Refresh the review.', correlationId: 'financial_integration' } });
    }
    expect(f.submit).toHaveBeenCalledTimes(5); expect(f.verifyIdentity).not.toHaveBeenCalled();
    for (const method of Object.values(f.read)) expect(method).not.toHaveBeenCalled();
  });
  it.each(['raw', 'escaped'] as const)('lets the document parser accept a maximum %s body larger than the generic 64 KiB cap', async encoding => {
    const f = fixture(), text = '🧵'.repeat(20_000), json = JSON.stringify({ ...documentBody, text });
    const body = encoding === 'raw' ? json : json.replaceAll('🧵', '\\ud83e\\uddf5');
    expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(64 * 1024);
    f.submit.mockImplementation(async (_token, input) => receipt(input));
    const response = await f.app.request(docPath, { method: 'POST', headers, body });
    expect(response.status).toBe(200); secure(response); expect((await response.json()).receipt.record.text).toBe(text);
    expect(f.submit).toHaveBeenCalledOnce(); expect(f.verifyIdentity).not.toHaveBeenCalled();
  });
  it('keeps all five unconfigured writers unavailable without a generic fallback', async () => {
    for (const sample of await samples()) {
      const f = fixture(false), response = await f.app.request(sample.path, { method: 'POST', headers, body: JSON.stringify(sample.body) });
      expect(response.status).toBe(503); expect((await response.json()).error.code).toBe('SETUP_REQUIRED'); noProvider(f);
    }
  });
  it.each(['{"text":1,"t\\u0065xt":2}', '{', JSON.stringify({ ...documentBody, actorId: 'forged' })])('rejects malformed or forged write input before providers: %s', async body => {
    const f = fixture(), response = await f.app.request(docPath, { method: 'POST', headers, body });
    expect(response.status).toBe(422); secure(response); noProvider(f);
  });
  it.each([docPath + '?actorId=other', docPath + '/', docPath.replace('document_a', '%64ocument_a'),
    '/v1/financial-governance/%63ontext', '/v1/financial-governance/proposal_a/accept',
    '/v1/financial-governance/proposal_a/reject', '/v1/financial-governance/proposal_a/proposer-observation'])('rejects aliases and excluded actions before providers: %s', async path => {
    const f = fixture(), response = await f.app.request(path, { method: 'POST', headers, body: JSON.stringify(documentBody) });
    expect(response.status).toBe(422); noProvider(f);
  });
  it.each(['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE'])('rejects unsupported %s on each writer', async method => {
    for (const sample of await samples()) {
      const f = fixture(), response = await f.app.request(sample.path, { method, headers });
      expect(response.status).toBe(404); noProvider(f);
    }
  });
  it.each(reads)('preserves the dedicated reader for %s', async (path, method) => {
    const f = fixture(), response = await f.app.request(path, { headers });
    expect(response.status).toBe(409); secure(response); expect(f.read[method]).toHaveBeenCalledOnce();
    expect(f.submit).not.toHaveBeenCalled(); expect(f.verifyIdentity).not.toHaveBeenCalled();
  });
  it.each(reads)('preserves method rejection before body parsing on read %s', async path => {
    for (const method of ['POST', 'HEAD', 'PUT', 'PATCH', 'DELETE']) {
      const f = fixture(), response = await f.app.request(path, { method, headers, ...(method === 'POST' ? { body: '{invalid' } : {}) });
      expect(response.status).toBe(404); noProvider(f);
    }
  });
  it('keeps origin, preflight and missing bearer checks ahead of all financial providers', async () => {
    const f = fixture();
    const denied = await f.app.request(docPath, { method: 'POST', headers: { ...headers, Origin: 'https://denied.example.test' }, body: '{' });
    expect(denied.status).toBe(403);
    const unauthenticated = await f.app.request(docPath, { method: 'POST', headers: { ...headers, Authorization: '' }, body: JSON.stringify(documentBody) });
    expect(unauthenticated.status).toBe(401);
    const preflight = await f.app.request(docPath, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'Authorization, Content-Type, Idempotency-Key' } });
    expect(preflight.status).toBe(204); expect(preflight.headers.get('access-control-allow-origin')).toBe(origin); noProvider(f);
  });
  it.each(['intact', 'substituted_scope', 'preflight_rejection'] as const)('preserves the accepted post-result unknown boundary in the full app: %s', async mode => {
    const f = fixture(), sample = (await samples())[2]!;
    f.submit.mockImplementation(async (_token, input) => {
      if (mode === 'preflight_rejection') throw new DomainError('FINANCIAL_POLICY_INVALID', 422, 'private preflight details');
      const result = await receipt(input);
      if (mode === 'substituted_scope') {
        result.scope.organizationId = 'other_org'; result.receipt.organizationId = 'other_org'; result.receipt.record.organizationId = 'other_org';
      }
      return FinancialPolicyHttpMutationResponseSchema.parse(result);
    });
    const response = await f.app.request(sample.path, { method: 'POST', headers, body: JSON.stringify(sample.body) });
    expect(response.status).toBe(mode === 'intact' ? 200 : mode === 'substituted_scope' ? 503 : 422); secure(response);
    if (mode !== 'intact') expect((await response.json()).error.code).toBe(mode === 'substituted_scope' ? 'FINANCIAL_POLICY_OUTCOME_UNKNOWN' : 'FINANCIAL_POLICY_INVALID');
    expect(f.submit).toHaveBeenCalledOnce(); expect(f.verifyIdentity).not.toHaveBeenCalled();
  });
  it('preserves public health, the generic identity path, and the generic body cap', async () => {
    const f = fixture(); expect((await f.app.request('/health')).status).toBe(200); noProvider(f);
    expect((await f.app.request('/v1/session', { headers })).status).toBe(503); expect(f.verifyIdentity).toHaveBeenCalledOnce();
    f.verifyIdentity.mockClear();
    expect((await f.app.request('/v1/responsibilities', { method: 'POST', headers, body: JSON.stringify({ value: 'x'.repeat(65_536) }) })).status).toBe(413);
    noProvider(f);
  });
  it('preserves custody branded body parsing, cap and generic identity ordering', async () => {
    const verifyIdentity = vi.fn(async () => ({ subject: 'owner_a', externalOrganizationId: 'clerk_org_a', externalOrganizationName: 'Synthetic',
      externalMembershipId: 'membership_owner_a', externalRole: 'org:member', sessionId: 'session_owner_a',
      membershipObservedAt: new Date().toISOString(), authenticatedAt: new Date().toISOString() }));
    const reject = () => vi.fn(async () => { throw new DomainError('CUSTODY_SCOPE_CHANGED', 409, 'private'); });
    const custody: CustodySetupGateway = { recoveryContext: reject(), prepare: reject(), challenge: reject(), confirmation: reject(),
      confirm: reject(), cancel: reject(), get: reject(), recover: reject() };
    const f = fixture(), app = createApp({ allowedOrigins: [origin], verifyIdentity, custodySetupGateway: custody,
      financialPolicyGateway: f.read, financialPolicyWriteGateway: { submit: f.submit } });
    const setupId = '10000000-0000-4000-8000-000000000001', path = `${responsibility}/custody-setups/${setupId}/cancel`;
    const body = JSON.stringify({ schemaVersion: 1, key, expectedSetupVersion: 1, expectedSetupHash: hash, expectedSetupControlGeneration: 0 });
    expect((await app.request(path, { method: 'POST', headers, body })).status).toBe(409);
    expect(custody.cancel).toHaveBeenCalledExactlyOnceWith(token, 'responsibility_a', setupId, JSON.parse(body), 'financial_integration');
    expect(verifyIdentity).toHaveBeenCalledOnce(); verifyIdentity.mockClear(); vi.mocked(custody.cancel).mockClear();
    expect((await app.request(path, { method: 'POST', headers, body: body + ' '.repeat(2048) })).status).toBe(413);
    expect(verifyIdentity).not.toHaveBeenCalled(); expect(custody.cancel).not.toHaveBeenCalled(); noProvider(f);
  });
});
