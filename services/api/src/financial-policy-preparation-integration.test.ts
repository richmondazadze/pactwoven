import { describe, expect, it, vi } from 'vitest';
import { FinancialPolicyPreparationResponseSchema, type FinancialPolicyPreparationRequest } from '@pactwoven/contracts';
import { DomainError, commandDigest } from '@pactwoven/domain';
import { createApp } from './app.js';
import type { FinancialPolicyGateway } from './financial-policy-service.js';
import type { FinancialPolicyWriteGateway } from './financial-policy-write-service.js';
import type { FinancialPolicyPreparationGateway } from './financial-policy-preparation-service.js';

vi.mock('pg', () => ({ Pool: class { constructor() { throw new Error('No database construction in offline preparation integration.'); } } }));
const origin = 'http://localhost:3001', rid = 'responsibility_a', token = 'synthetic-preparation-integration', hash = 'a'.repeat(64);
const path = `/v1/responsibilities/${rid}/financial-policy-preparation`, orgPath = '/v1/financial-governance-preparation';
const headers = { Origin: origin, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Correlation-Id': 'preparation_integration' };
const document: FinancialPolicyPreparationRequest = { schemaVersion: 1, action: 'save_document', targetId: 'mandate_a', previous: null, purpose: 'financial_mandate' };
async function fixture(configured = true, generic = true) {
  const verifyIdentity = vi.fn(async () => { throw new DomainError('AUTH_REQUIRED', 401, 'Generic identity path.'); });
  const failure = () => vi.fn(async () => { throw new DomainError('FINANCIAL_POLICY_SCOPE_CHANGED', 409, 'Dedicated financial path.'); });
  const read: FinancialPolicyGateway = { context: failure(), index: failure(), get: failure(), recover: failure() };
  const write: FinancialPolicyWriteGateway = { submit: failure() };
  const authority = { schemaVersion: 1, responsibility: { id: rid, version: 1, hash, siteId: 'site_a' }, generation: 0, family: 'none', legacyHead: null };
  const draftScope = { authority, authorityHash: await commandDigest({ namespace: 'pactwoven:financial-authority-fence:v1',
    record: { ...authority, environment: 'development', organizationId: 'org_a' } }), site: { id: 'site_a', generation: 0, recordHash: hash } };
  const prepare = vi.fn<FinancialPolicyPreparationGateway['prepare']>(async (_token, responsibilityId, selection) => {
    const now = Date.now();
    if (selection.action !== 'save_document') throw new DomainError('FINANCIAL_POLICY_SCOPE_CHANGED', 409, 'Synthetic blocked preparation.');
    return FinancialPolicyPreparationResponseSchema.parse({ schemaVersion: 1, responsibilityId, selection,
      scope: { environment: 'development', organizationId: 'org_a', actor: { actorId: 'owner_a', membershipVersion: 1 }, organizationEpoch: 2,
        roles: ['owner'], siteIds: ['site_a'], actionSiteIds: ['site_a'] },
      observation: { observedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 19_000).toISOString() },
      target: { state: 'absent', latestReference: null, record: null, historicalDocuments: [] },
      decision: { action: selection.action, state: 'reviewable', reasons: [], requiredAuthentication: null },
      material: { action: selection.action, purpose: selection.purpose, organizationEpoch: 2,
        draftScope: responsibilityId === null ? null : draftScope, siteActive: responsibilityId === null ? null : true },
      configurationWarnings: ['FINANCIAL_AUTHORITY_UNAVAILABLE', 'TRUST_UNAVAILABLE'], effectiveAuthority: false, financialState: null });
  });
  const app = createApp({ allowedOrigins: [origin], financialPolicyGateway: read, financialPolicyWriteGateway: write,
    ...(generic ? { verifyIdentity } : {}), ...(configured ? { financialPolicyPreparationGateway: { prepare } } : {}) });
  return { app, verifyIdentity, read, write, prepare };
}
function secure(response: Response) {
  expect(response.headers.get('cache-control')).toBe('private, no-store'); expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff'); expect(response.headers.get('access-control-allow-origin')).toBe(origin);
  expect(response.headers.get('x-correlation-id')).toBe('preparation_integration');
}
function untouched(f: Awaited<ReturnType<typeof fixture>>) {
  expect(f.prepare).not.toHaveBeenCalled(); expect(f.verifyIdentity).not.toHaveBeenCalled(); expect(f.write.submit).not.toHaveBeenCalled();
  for (const method of Object.values(f.read)) expect(method).not.toHaveBeenCalled();
}
const post = (f: Awaited<ReturnType<typeof fixture>>, url = path, value: unknown = document, override = headers) =>
  f.app.request(url, { method: 'POST', headers: override, body: JSON.stringify(value) });

describe('preparation composition in the actual API application', () => {
  it('places the two preparation families after health and before all existing financial routes', async () => {
    const f = await fixture(), paths = f.app.routes.filter(r => !r.path.includes('*')).map(r => r.path);
    expect(paths.indexOf('/health')).toBeLessThan(paths.indexOf(orgPath));
    expect(paths.indexOf(orgPath)).toBeLessThan(paths.indexOf('/v1/financial-governance/documents/:documentId'));
    expect(paths.indexOf('/v1/responsibilities/:id/financial-policy-preparation')).toBeLessThan(paths.indexOf('/v1/financial-governance/context'));
    const response = await f.app.request('/health', { headers }); expect(response.status).toBe(200); secure(response); untouched(f);
  });
  it.each([true, false])('prepares responsibility and organization documents with generic setup present=%s', async generic => {
    const f = await fixture(true, generic);
    for (const purpose of ['financial_mandate', 'budget_policy', 'approval_policy'] as const) {
      const url = purpose === 'financial_mandate' ? path : orgPath, input = { ...document, purpose }, response = await post(f, url, input);
      expect(response.status).toBe(200); secure(response); expect((await response.json()).selection).toEqual(input);
      expect(f.prepare.mock.calls.at(-1)).toEqual([token, purpose === 'financial_mandate' ? rid : null, input]);
    }
    expect(f.prepare).toHaveBeenCalledTimes(3); expect(f.verifyIdentity).not.toHaveBeenCalled(); expect(f.write.submit).not.toHaveBeenCalled();
    for (const method of Object.values(f.read)) expect(method).not.toHaveBeenCalled();
  });
  it('dispatches draft, withdrawal and governance selectors exclusively to preparation', async () => {
    const f = await fixture();
    const samples: FinancialPolicyPreparationRequest[] = [
      { schemaVersion: 1, action: 'save_draft', targetId: 'draft_a', previous: null, document: null },
      { schemaVersion: 1, action: 'withdraw_draft', targetId: 'draft_a', previous: { id: 'draft_a', version: 1, recordHash: hash } },
      { schemaVersion: 1, action: 'propose_governance', targetId: 'proposal_a', previous: null, assetKey: null, budgetDocument: null, approvalDocument: null },
    ];
    for (const input of samples) expect((await post(f, input.action === 'propose_governance' ? orgPath : path, input)).status).toBe(409);
    expect(f.prepare).toHaveBeenCalledTimes(3); expect(f.verifyIdentity).not.toHaveBeenCalled(); expect(f.write.submit).not.toHaveBeenCalled();
  });
  it.each([path, orgPath])('keeps missing preparation setup isolated at %s', async url => {
    const f = await fixture(false), input = { ...document, purpose: url === orgPath ? 'budget_policy' : 'financial_mandate' }, response = await post(f, url, input);
    expect(response.status).toBe(503); secure(response); expect((await response.json()).error.code).toBe('SETUP_REQUIRED'); untouched(f);
  });
  it.each([path + '?', path + '?assetKey=x', path + '#x', path + '/', path + '/submit', orgPath + ';alias',
    path.replace('/v1/', '/v%31/'), path.replace(rid, '%72esponsibility_a'), path.replace('/responsibilities/', '//responsibilities/'),
    path.replace('financial-policy-preparation', '%2566inancial-policy-preparation'),
    path.replace(rid, '%zz').replace('financial-policy-preparation', '%66inancial-policy-preparation')])
  ('rejects canonical-family violation %s before every identity path', async url => {
    const f = await fixture(), response = await post(f, url); expect(response.status).toBe(422); secure(response); untouched(f);
  });
  it.each([path + '#', path + '?#', orgPath + '#', orgPath + '?#'])('retains empty-marker rejection in createApp at %s', async url => {
    const f = await fixture(), input = { ...document, purpose: url.startsWith(orgPath) ? 'budget_policy' : 'financial_mandate' };
    const response = await post(f, url, input); expect(response.status).toBe(422); secure(response); untouched(f);
  });
  it.each(['GET', 'PUT', 'PATCH', 'DELETE', 'HEAD'])('rejects unsupported %s before financial/generic identity', async method => {
    const f = await fixture(), response = await f.app.request(path, { method, headers }); expect(response.status).toBe(404); secure(response); untouched(f);
  });
  it('uses the dedicated strict metadata parser before the generic parser', async () => {
    const f = await fixture();
    const duplicate = JSON.stringify(document).replace('"schemaVersion":1', '"schemaVersion":1,"\\u0073chemaVersion":1');
    expect((await f.app.request(path, { method: 'POST', headers, body: duplicate })).status).toBe(422);
    expect((await f.app.request(path, { method: 'POST', headers, body: JSON.stringify(document) + ' '.repeat(8193) })).status).toBe(413);
    expect((await post(f, path, document, { ...headers, 'Idempotency-Key': 'not_a_preparation_key' } as typeof headers)).status).toBe(422); untouched(f);
  });
  it('finishes allowed CORS preflight before preparation and rejects disallowed origins without calls', async () => {
    const f = await fixture(), preflight = await f.app.request(path, { method: 'OPTIONS', headers: { ...headers,
      'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'Authorization, Content-Type, X-Correlation-Id' } });
    expect(preflight.status).toBe(204); secure(preflight); expect(preflight.headers.get('access-control-allow-methods')).toBe('GET, POST');
    expect((await post(f, path, document, { ...headers, Origin: 'https://foreign.invalid' })).status).toBe(403); untouched(f);
  });
  it.each(['/v1/financial-governance/context', `/v1/responsibilities/${rid}/financial-policies/context`])('preserves existing read dispatch at %s', async url => {
    const f = await fixture(), response = await f.app.request(url, { headers }); expect(response.status).toBe(409);
    expect(f.read.context).toHaveBeenCalledOnce(); expect(f.prepare).not.toHaveBeenCalled(); expect(f.verifyIdentity).not.toHaveBeenCalled();
  });
  it.each(['/v1/financial-governance/documents/budget_a', `/v1/responsibilities/${rid}/financial-policy-documents/mandate_a`])
  ('preserves existing document write dispatch at %s', async url => {
    const f = await fixture(), response = await post(f, url, { schemaVersion: 1, organizationEpoch: 2, previous: null,
      purpose: url.includes('/responsibilities/') ? 'financial_mandate' : 'budget_policy', text: 'Explicit writer action.' },
    { ...headers, 'Idempotency-Key': 'original_write_key_123' } as typeof headers);
    expect(response.status).toBe(409); expect(f.write.submit).toHaveBeenCalledOnce(); expect(f.prepare).not.toHaveBeenCalled(); expect(f.verifyIdentity).not.toHaveBeenCalled();
  });
  it('preserves the generic identity path for an unrelated session request', async () => {
    const f = await fixture(), response = await f.app.request('/v1/session', { headers }); expect(response.status).toBe(401);
    expect(f.verifyIdentity).toHaveBeenCalledOnce(); expect(f.prepare).not.toHaveBeenCalled();
  });
});
