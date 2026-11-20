import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { ApiEnv } from './app.js';
import type { FinancialPolicyGateway } from './financial-policy-service.js';
import type { FinancialPolicyClosureGateway } from './financial-policy-closure-service.js';
import { registerFinancialPolicyRoutes, FINANCIAL_POLICY_INDEX_DEFAULT_LIMIT } from './financial-policy-routes.js';

const hash = 'a'.repeat(64), key = 'original_key_12345', token = 'synthetic.token.only';
const auth = { Authorization: `Bearer ${token}` };
const envelope = () => ({ schemaVersion: 1, scope: { environment: 'development', organizationId: 'org_a',
  actor: { actorId: 'actor_a', membershipVersion: 9 }, organizationEpoch: 4, roles: ['owner'], siteIds: ['site_a'], actionSiteIds: ['site_a'] },
  observation: { observedAt: new Date(Date.now() - 500).toISOString(), expiresAt: new Date(Date.now() + 19_000).toISOString() }, effectiveAuthority: false, financialState: null });
const context = (rid: string | null) => ({ ...envelope(), kind: rid === null ? 'organization' : 'responsibility', responsibilityId: rid,
  configurationVisibility: 'full', draftScope: rid === null ? null : { authority: { schemaVersion: 1, responsibility: { id: rid, version: 1, hash, siteId: 'site_a' },
    generation: 0, family: 'none', legacyHead: null }, authorityHash: hash, site: { id: 'site_a', generation: 0, recordHash: hash } },
  asset: null, control: null, acceptedConfiguration: null, periods: [], documents: [],
  blockers: ['ASSET_MISSING', 'FINANCIAL_AUTHORITY_UNAVAILABLE', 'GOVERNANCE_MISSING', 'TRUST_UNAVAILABLE'], actions: [] });
const record = (rid: string | null, id: string, version = 1) => ({ ...envelope(), responsibilityId: rid, policy: {
  reference: { id, version, recordHash: hash }, record: { schemaVersion: 1, environment: 'development', organizationId: 'org_a', responsibilityId: rid,
    id, version, predecessor: version === 1 ? null : { id, version: version - 1, recordHash: hash }, actor: { actorId: 'actor_a', membershipVersion: 1 }, organizationEpoch: 2,
    operationId: '00000000-0000-0000-0000-000000000001', createdAt: '2026-11-15T11:59:00.000Z', kind: 'document',
    purpose: rid === null ? 'budget_policy' : 'financial_mandate', text: 'Synthetic exact text.', contentHash: hash },
  projection: { currentRecord: true, state: 'DOCUMENT', blockers: [] }, budgetConfiguration: null }, documents: [], actions: [] });
function fixture(setup = true) {
  const gateway = {
    context: vi.fn(async (_token: string, rid: string | null): Promise<unknown> => context(rid)),
    index: vi.fn(async (_token: string, rid: string | null, _query: unknown): Promise<unknown> => ({ ...envelope(), kind: rid === null ? 'organization' : 'responsibility', responsibilityId: rid, items: [], nextId: null })),
    get: vi.fn(async (_token: string, selector: { responsibilityId: string | null; id: string; version: number; kind: string }): Promise<unknown> => {
      if (selector.kind !== 'document') throw new Error('Synthetic absent record'); return record(selector.responsibilityId, selector.id, selector.version);
    }),
    recover: vi.fn(async (_token: string, locator: object): Promise<unknown> => ({ ...envelope(), ...locator, status: 'not_recorded', receipt: null })),
  };
  const app = new Hono<ApiEnv>(); app.use('*', async (c, next) => { c.set('correlationId', 'correlation_a'); await next(); });
  const closure = { close: vi.fn(), status: async (bearer: string, locator: object) => ({ ...await gateway.recover(bearer, locator) as object, closure: null }) };
  registerFinancialPolicyRoutes(app, setup ? gateway as unknown as FinancialPolicyGateway : undefined,
    setup ? closure as unknown as FinancialPolicyClosureGateway : undefined);
  const generic = vi.fn(async () => {}); app.use('/v1/*', async (_c, next) => { await generic(); await next(); });
  return { app, gateway, generic };
}
const cases = [
  ['/v1/responsibilities/responsibility_a/financial-policies/context', 'context'],
  ['/v1/responsibilities/responsibility_a/financial-policies', 'index'],
  ['/v1/responsibilities/responsibility_a/financial-policies/policy_a/versions/1', 'get'],
  ['/v1/responsibilities/responsibility_a/financial-policy-documents/document_a/versions/1', 'get'],
  ['/v1/financial-governance/context', 'context'], ['/v1/financial-governance', 'index'],
  ['/v1/financial-governance/proposal_a/versions/1', 'get'],
  ['/v1/financial-governance/documents/document_a/versions/1', 'get'],
  [`/v1/responsibilities/responsibility_a/financial-policy-operations/${key}?kind=save_document&targetId=document_a&requestHash=${hash}`, 'recover'],
  [`/v1/financial-governance/operations/${key}?kind=save_document&targetId=document_a&requestHash=${hash}`, 'recover'],
] as const;
function secure(response: Response) {
  expect(response.headers.get('cache-control')).toBe('private, no-store'); expect(response.headers.get('referrer-policy')).toBe('no-referrer');
}

describe('financial-policy ten strict GET routes (synthetic gateway)', () => {
  it('registers exactly ten endpoint paths with literal paths before parameter paths', () => {
    const { app } = fixture(), endpoints = app.routes.filter(route => !route.path.includes('*'));
    expect(endpoints).toHaveLength(10); expect(endpoints.every(route => route.method === 'ALL')).toBe(true);
    expect(endpoints.findIndex(route => route.path === '/v1/financial-governance/context')).toBeLessThan(endpoints.findIndex(route => route.path.includes(':proposalId')));
    expect(endpoints.findIndex(route => route.path.includes('/documents/'))).toBeLessThan(endpoints.findIndex(route => route.path.includes(':proposalId')));
  });
  it.each(cases)('dispatches %s through its captured %s gateway before generic identity middleware', async (url, operation) => {
    const { app, gateway, generic } = fixture(), response = await app.request(url, { headers: auth });
    secure(response); expect(gateway[operation]).toHaveBeenCalledOnce(); expect(gateway[operation].mock.calls[0]?.[0]).toBe(token);
    expect(Object.values(gateway).reduce((sum, fn) => sum + fn.mock.calls.length, 0)).toBe(1); expect(generic).not.toHaveBeenCalled();
    if (operation !== 'get' || url.includes('documents')) expect(response.status).toBe(200); else expect(response.status).toBe(503);
  });
  it('maps query requestHash to publicRequestHash and uses bounded index defaults', async () => {
    const { app, gateway } = fixture(); await app.request(cases[9][0], { headers: auth });
    expect(gateway.recover).toHaveBeenCalledWith(token, { responsibilityId: null, key, kind: 'save_document', targetId: 'document_a', publicRequestHash: hash });
    await app.request('/v1/financial-governance', { headers: auth });
    expect(gateway.index).toHaveBeenCalledWith(token, null, { afterId: null, limit: FINANCIAL_POLICY_INDEX_DEFAULT_LIMIT });
    await app.request('/v1/financial-governance?afterId=proposal_a&limit=50', { headers: auth });
    expect(gateway.index).toHaveBeenLastCalledWith(token, null, { afterId: 'proposal_a', limit: 50 });
  });
  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])('rejects unsupported %s without invoking identity or reads', async method => {
    const { app, gateway, generic } = fixture(), response = await app.request(cases[0][0], { method, headers: auth });
    expect(response.status).toBe(404); secure(response); expect(gateway.context).not.toHaveBeenCalled(); expect(generic).not.toHaveBeenCalled();
  });
  it.each([
    '/v1/financial-governance/context?actorId=actor_a', '/v1/financial-governance/context?environment=production',
    '/v1/financial-governance/context?organizationId=org_a', '/v1/financial-governance/context?proof=true',
    '/v1/financial-governance/context?assetKey=', `/v1/financial-governance/context?assetKey=${hash}&assetKey=${hash}`,
    `/v1/financial-governance/context?%61ssetKey=${hash}`, `/v1/financial-governance/context?assetKey=${hash}&`,
    '/v1/financial-governance?limit=01', '/v1/financial-governance?limit=0', '/v1/financial-governance?limit=51',
    '/v1/financial-governance?limit=1e1', '/v1/financial-governance?limit=1&limit=2', '/v1/financial-governance?afterId=%61',
    '/v1/financial-governance/context?', '/v1/financial-governance/context#alias', '/%761/financial-governance/context', '/v%31/financial-governance/context', '/v1/financial-governance/context/', '/v1/financial-governance//context', '/v1/financial-governance/%63ontext',
    '/v1/financial%2Dgovernance/context', '/v1/responsibilities/%61/financial-policies/context',
    '/v1/financial-governance/documents/document_a/versions/01', '/v1/financial-governance/documents/document_a/versions/0',
    '/v1/financial-governance/documents/document_a/versions/1e1', '/v1/financial-governance/documents/document_a/versions/9007199254740992',
    `/v1/financial-governance/operations/${key}?kind=save_document&targetId=document_a`,
    `/v1/financial-governance/operations/${key}?kind=save_draft&targetId=document_a&requestHash=${hash}`,
    `/v1/financial-governance/operations/${key}?kind=save_document&targetId=document_a&requestHash=${hash}&publicRequestHash=${hash}`,
    `/v1/financial-governance/operations/${key}?kind=save_document&targetId=document_a&requestHash=${hash}&kind=save_document`,
    '/v1/financial-governance/documents/document_a/versions/1?version=1',
  ])('rejects noncanonical/unknown query or route %s before any gateway await', async url => {
    const { app, gateway, generic } = fixture(), response = await app.request(url, { headers: auth });
    expect(response.status).toBe(422); secure(response);
    expect(await response.json()).toEqual({ error: { code: 'FINANCIAL_POLICY_INPUT_INVALID', message: 'Use the exact supported policy read parameters.', correlationId: 'correlation_a' } });
    expect(Object.values(gateway).every(fn => fn.mock.calls.length === 0)).toBe(true); expect(generic).not.toHaveBeenCalled();
  });
  it.each([{ 'Transfer-Encoding': 'chunked' }, { 'Content-Length': '1' }, { 'Content-Length': '00' }, { 'Content-Length': '-1' }])('rejects body-related headers %j', async headers => {
    const { app, gateway } = fixture(), response = await app.request(cases[0][0], { headers: { ...auth, ...headers } });
    expect(response.status).toBe(422); secure(response); expect(gateway.context).not.toHaveBeenCalled();
  });
  it('rejects a GET stream even without declared transfer metadata', async () => {
    const { app, gateway } = fixture(), request = new Request(`http://localhost${cases[0][0]}`, { headers: auth });
    Object.defineProperty(request, 'body', { value: new ReadableStream({ start(controller) { controller.close(); } }) });
    const response = await app.fetch(request); expect(response.status).toBe(422); secure(response); expect(gateway.context).not.toHaveBeenCalled();
  });
  it.each(['', 'Basic abc', 'Bearer ', 'bearer synthetic', 'Bearer a b'])('requires a strict original bearer value %s', async authorization => {
    const { app, gateway } = fixture(), response = await app.request(cases[0][0], { headers: { Authorization: authorization } });
    expect(response.status).toBe(401); secure(response); expect(gateway.context).not.toHaveBeenCalled();
  });
  it('returns safe setup-required for absent gateway', async () => {
    const { app, generic } = fixture(false), response = await app.request(cases[0][0], { headers: auth });
    expect(response.status).toBe(503); secure(response);
    expect(await response.json()).toEqual({ error: { code: 'SETUP_REQUIRED', message: 'Financial-policy reads are not configured.', correlationId: 'correlation_a' } });
    expect(generic).not.toHaveBeenCalled();
  });
  it('captures gateway methods and selector identities before callbacks can change them', async () => {
    const { app, gateway } = fixture(), original = gateway.get;
    original.mockImplementation(async (_token, selected) => { const result = record(selected.responsibilityId, selected.id, selected.version); selected.id = 'changed'; return result; });
    gateway.get = vi.fn(async () => { throw new Error('replacement'); });
    const response = await app.request(cases[3][0], { headers: auth });
    expect(response.status).toBe(200); expect((await response.json()).policy.record.id).toBe('document_a'); expect(gateway.get).not.toHaveBeenCalled();
  });
  it('rejects private fields and wrong original response instead of leaking or claiming absence', async () => {
    const { app, gateway } = fixture(); gateway.context.mockResolvedValue({ ...context(null), subject: 'private_subject' });
    const response = await app.request('/v1/financial-governance/context', { headers: auth });
    expect(response.status).toBe(503); secure(response); expect(await response.text()).not.toContain('private_subject');
    gateway.recover.mockImplementation(async (_token, q) => ({ ...envelope(), ...q, key: 'other_original_key', status: 'not_recorded', receipt: null }));
    expect((await app.request(cases[9][0], { headers: auth })).status).not.toBe(200);
  });
  it('maps unavailable dependencies to fixed errors without raw provider details', async () => {
    const { app, gateway } = fixture(); gateway.context.mockRejectedValue(new Error('secret token SQL private policy text'));
    const response = await app.request(cases[0][0], { headers: auth }); expect(response.status).toBe(503); secure(response);
    expect(await response.json()).toEqual({ error: { code: 'FINANCIAL_POLICY_OUTCOME_UNKNOWN', message: 'The financial-policy response could not be verified.', correlationId: 'correlation_a' } });
  });
});
