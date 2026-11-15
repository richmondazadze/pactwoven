import { describe, expect, it, vi } from 'vitest';
import type { VerifiedIdentity } from '@pactwoven/db';
import { DomainError } from '@pactwoven/domain';
import { createApp } from './app.js';
import type { CustodySetupGateway } from './custody-setup-service.js';

const origin = 'http://localhost:3001';
const setupId = '10000000-0000-4000-8000-000000000001';
const root = '/v1/responsibilities/responsibility_a/custody-setups';
const challengePath = `${root}/${setupId}/owner-challenge`;
const key = 'custody_integration_0001';
const command = { schemaVersion: 1, key, expectedSetupVersion: 1, expectedSetupHash: 'a'.repeat(64) };
const identity: VerifiedIdentity = {
  subject: 'user_a', externalOrganizationId: 'external_org_a', sessionId: 'session_a',
  externalOrganizationName: 'Local test', externalMembershipId: 'membership_a', externalRole: 'org:admin',
  authenticatedAt: '2026-11-15T00:00:00.000Z', membershipObservedAt: '2026-11-15T00:00:00.000Z',
};
const headers = { Authorization: 'Bearer custody-integration-fixture', Origin: origin,
  'Content-Type': 'application/json', 'Idempotency-Key': key };
function fixture(configured = true) {
  const verifyIdentity = vi.fn(async () => identity);
  const reject = () => vi.fn(async () => { throw new DomainError('CUSTODY_SCOPE_CHANGED', 409, 'The exact setup or authority scope changed.'); });
  const gateway: CustodySetupGateway = { prepare: reject(), challenge: reject(), confirmation: reject(),
    confirm: reject(), cancel: reject(), get: reject(), recover: reject() };
  // Intentionally omit the foundation repository: these routes use their own private service boundary.
  const app = createApp({ allowedOrigins: [origin], verifyIdentity, ...(configured ? { custodySetupGateway: gateway } : {}) });
  return { app, verifyIdentity, gateway };
}

describe('custody setup integration into the common API', () => {
  it('uses the branded strict body before live identity and reaches the custody gateway', async () => {
    const f = fixture();
    const response = await f.app.request(challengePath, { method: 'POST', headers, body: JSON.stringify(command) });
    expect(response.status).toBe(409);
    expect(f.verifyIdentity).toHaveBeenCalledOnce();
    expect(f.gateway.challenge).toHaveBeenCalledWith('custody-integration-fixture', 'responsibility_a', setupId, command, expect.any(String));
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  });
  it.each([
    '{"schemaVersion":1,"schemaVersion":1}',
    '{"nested":{"key":"a","k\\u0065y":"b"}}',
    '{"key":"a"} {"key":"b"}',
  ])('rejects ambiguous raw JSON before any identity or gateway call: %s', async body => {
    const f = fixture();
    expect((await f.app.request(challengePath, { method: 'POST', headers, body })).status).toBe(422);
    expect(f.verifyIdentity).not.toHaveBeenCalled(); expect(f.gateway.challenge).not.toHaveBeenCalled();
  });
  it.each([
    [root, 8192], [`${root}/${setupId}/owner-challenge`, 2048],
    [`${root}/${setupId}/owner-confirmation-challenge`, 4096], [`${root}/${setupId}/confirm-owner`, 4096],
    [`${root}/${setupId}/cancel`, 2048],
  ] as const)('applies the route byte cap before identity: %s', async (path, cap) => {
    const f = fixture();
    const body = JSON.stringify({ value: 'é'.repeat(cap / 2) });
    expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(cap);
    expect((await f.app.request(path, { method: 'POST', headers, body })).status).toBe(413);
    expect(f.verifyIdentity).not.toHaveBeenCalled();
    for (const method of Object.values(f.gateway)) expect(method).not.toHaveBeenCalled();
  });
  it('fails closed when the custody service has not been wired', async () => {
    const f = fixture(false);
    const response = await f.app.request(challengePath, { method: 'POST', headers, body: JSON.stringify(command) });
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe('SETUP_REQUIRED');
  });
  it('keeps common origin and authentication checks ahead of custody', async () => {
    const f = fixture();
    expect((await f.app.request(challengePath, { method: 'POST', headers: { ...headers, Origin: 'https://denied.example' }, body: '{}' })).status).toBe(403);
    expect((await f.app.request(challengePath, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(401);
    expect(f.verifyIdentity).not.toHaveBeenCalled(); expect(f.gateway.challenge).not.toHaveBeenCalled();
  });
  it('does not reinterpret unrelated foundation requests as custody', async () => {
    const f = fixture();
    const response = await f.app.request('/v1/responsibilities', { method: 'POST', headers, body: '{"value":1,"value":2}' });
    expect(f.verifyIdentity).toHaveBeenCalledOnce();
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe('SETUP_REQUIRED');
    for (const method of Object.values(f.gateway)) expect(method).not.toHaveBeenCalled();
  });
});
