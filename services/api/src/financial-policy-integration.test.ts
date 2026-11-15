import { describe, expect, it, vi } from 'vitest';
import { FinancialPolicyHttpContextSchema } from '@pactwoven/contracts';
import { DomainError } from '@pactwoven/domain';
import { createApp } from './app.js';
import type { FinancialPolicyGateway } from './financial-policy-service.js';

const origin = 'http://localhost:3001';
const headers = { Authorization: 'Bearer financial-integration-fixture', Origin: origin, 'X-Correlation-Id': 'financial_integration' };
const responsibility = '/v1/responsibilities/responsibility_a';
const key = 'financial_original_0001', digest = 'a'.repeat(64);
function fixture(configured = true) {
  const verifyIdentity = vi.fn(async () => { throw new Error('Generic identity must not authorize a financial route.'); });
  const reject = () => vi.fn(async () => { throw new DomainError('FINANCIAL_POLICY_SCOPE_CHANGED', 409, 'private diagnostic'); });
  const gateway: FinancialPolicyGateway = { context: reject(), index: reject(), get: reject(), recover: reject() };
  const app = createApp({ allowedOrigins: [origin], verifyIdentity, ...(configured ? { financialPolicyGateway: gateway } : {}) });
  return { app, verifyIdentity, gateway };
}
const reads = [
  [`${responsibility}/financial-policies/context`, 'context'],
  [`${responsibility}/financial-policies`, 'index'],
  [`${responsibility}/financial-policies/draft_a/versions/1`, 'get'],
  [`${responsibility}/financial-policy-documents/document_a/versions/1`, 'get'],
  ['/v1/financial-governance/context', 'context'],
  ['/v1/financial-governance', 'index'],
  ['/v1/financial-governance/proposal_a/versions/1', 'get'],
  ['/v1/financial-governance/documents/document_a/versions/1', 'get'],
  [`${responsibility}/financial-policy-operations/${key}?kind=save_draft&targetId=draft_a&requestHash=${digest}`, 'recover'],
  [`/v1/financial-governance/operations/${key}?kind=propose_governance&targetId=proposal_a&requestHash=${digest}`, 'recover'],
] as const;

describe('financial reads in the shared development API', () => {
  it.each(reads)('routes %s only through its dedicated gateway', async (path, method) => {
    const f = fixture(), response = await f.app.request(path, { headers });
    expect(response.status).toBe(409); expect(f.gateway[method]).toHaveBeenCalledOnce();
    expect(f.verifyIdentity).not.toHaveBeenCalled();
    for (const [name, fn] of Object.entries(f.gateway)) if (name !== method) expect(fn).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({ error: { code: 'FINANCIAL_POLICY_SCOPE_CHANGED',
      message: 'The policy scope changed. Refresh the review.', correlationId: 'financial_integration' } });
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('access-control-allow-origin')).toBe(origin);
  });
  it('returns the sanitized configured context with no foundation identity or repository dependency', async () => {
    const context = FinancialPolicyHttpContextSchema.parse({ schemaVersion: 1, kind: 'organization', responsibilityId: null,
      scope: { environment: 'development', organizationId: 'org_a', actor: { actorId: 'owner_a', membershipVersion: 1 },
        organizationEpoch: 0, roles: ['owner'], siteIds: [], actionSiteIds: [] },
      observation: { observedAt: '2026-11-15T12:00:00.000Z', expiresAt: '2026-11-15T12:00:20.000Z' },
      effectiveAuthority: false, financialState: null, configurationVisibility: 'full', draftScope: null,
      asset: null, control: null, acceptedConfiguration: null, periods: [], documents: [], actions: [],
      blockers: ['ASSET_MISSING', 'FINANCIAL_AUTHORITY_UNAVAILABLE', 'GOVERNANCE_MISSING', 'TRUST_UNAVAILABLE'] });
    const f = fixture(); vi.mocked(f.gateway.context).mockResolvedValue(context);
    const response = await f.app.request('/v1/financial-governance/context', { headers });
    expect(response.status).toBe(200); expect(await response.json()).toEqual(context);
    expect(f.gateway.context).toHaveBeenCalledExactlyOnceWith('financial-integration-fixture', null, null);
    expect(f.verifyIdentity).not.toHaveBeenCalled();
  });
  it.each(reads)('keeps unconfigured %s unavailable without invoking generic authentication', async path => {
    const f = fixture(false), response = await f.app.request(path, { headers });
    expect(response.status).toBe(503); expect((await response.json()).error.code).toBe('SETUP_REQUIRED');
    expect(f.verifyIdentity).not.toHaveBeenCalled();
  });
  it.each([
    '/v1/financial-governance/context?assetKey=wrong',
    '/v1/financial-governance/context?assetKey=' + digest + '&assetKey=' + digest,
    '/v1/financial-governance?limit=01',
    '/v1/financial-governance?actorId=other',
    '/v1/financial-governance/%63ontext',
    '/v1/financial-governance/context/',
    '/v1/financial-governance/documents/document_a/versions/01',
    responsibility + '/financial-policies?%6cimit=1',
  ])('rejects noncanonical selectors before all provider work: %s', async path => {
    const f = fixture(), response = await f.app.request(path, { headers });
    expect(response.status).toBe(422); expect(f.verifyIdentity).not.toHaveBeenCalled();
    for (const fn of Object.values(f.gateway)) expect(fn).not.toHaveBeenCalled();
  });
  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'])('rejects %s before body parsing or provider work', async method => {
    const f = fixture(), response = await f.app.request('/v1/financial-governance/context', { method, headers });
    expect(response.status).toBe(404); expect(f.verifyIdentity).not.toHaveBeenCalled();
    for (const fn of Object.values(f.gateway)) expect(fn).not.toHaveBeenCalled();
  });
  it('preserves common CORS and bearer rejection ahead of the dedicated gateway', async () => {
    const f = fixture(), path = '/v1/financial-governance/context';
    expect((await f.app.request(path, { headers: { ...headers, Origin: 'https://denied.example.test' } })).status).toBe(403);
    expect((await f.app.request(path, { headers: { Origin: origin } })).status).toBe(401);
    expect((await f.app.request(path, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'GET' } })).status).toBe(204);
    expect(f.verifyIdentity).not.toHaveBeenCalled();
    for (const fn of Object.values(f.gateway)) expect(fn).not.toHaveBeenCalled();
  });
  it('retains the generic identity path for unrelated requests and keeps health public', async () => {
    const f = fixture(); expect((await f.app.request('/health')).status).toBe(200);
    expect(f.verifyIdentity).not.toHaveBeenCalled();
    expect((await f.app.request('/v1/session', { headers })).status).toBe(503);
    expect(f.verifyIdentity).toHaveBeenCalledOnce();
    for (const fn of Object.values(f.gateway)) expect(fn).not.toHaveBeenCalled();
  });
});
