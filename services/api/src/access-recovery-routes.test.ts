import { describe, expect, it, vi } from 'vitest';
import { AccessRecoveryResultSchema, type AccessRecoveryGateway, type CloseAccessRecoveryIntent } from '@pactwoven/contracts';
import type { VerifiedIdentity } from '@pactwoven/db';
import { createApp } from './app.js';

const key = 'original-access-key-001', root = 'http://localhost:8787', path = '/v1/member-access/recovery';
const intent: CloseAccessRecoveryIntent = { schemaVersion: 1, kind: 'revise', reason: 'original_input_unavailable', expectedEnvironment: 'development',
  expectedOrganizationId: 'internal_org', expectedActorId: 'current_owner', expectedExternalMembershipId: 'provider_member', expectedAuthorityEpoch: 7 };
const headers = { Authorization: 'Bearer fixture.token', 'Content-Type': 'application/json', 'Idempotency-Key': key, Origin: 'http://localhost:3001' };
function fixture() {
  const now = new Date().toISOString(), identity: VerifiedIdentity = { subject: 'provider_user', externalOrganizationId: 'provider_org', externalOrganizationName: 'Fixture organization',
    externalMembershipId: 'provider_member', externalRole: 'org:admin', membershipObservedAt: now, sessionId: 'fixture_session', authenticatedAt: now };
  const base = { schemaVersion: 1 as const, environment: 'development' as const, organizationId: 'internal_org', externalOrganizationId: 'provider_org', kind: 'revise' as const, key,
    observedAt: now, reviewer: { actorId: 'current_owner', externalMembershipId: 'provider_member', authorityEpoch: 7 } };
  const read = AccessRecoveryResultSchema.parse({ ...base, disposition: 'not_recorded' });
  const closed = { ...base, disposition: 'fenced' as const, fence: { id: 'fence_a', closedAt: now } };
  const gateway = { get: vi.fn<AccessRecoveryGateway['get']>(async () => structuredClone(read)), close: vi.fn<AccessRecoveryGateway['close']>(async () => structuredClone(closed)) };
  const verifyIdentity = vi.fn(async () => identity), app = createApp({ allowedOrigins: ['http://localhost:3001'], verifyIdentity, accessRecoveryGateway: gateway });
  const get = (query = '?kind=revise&key=' + key, method = 'GET') => app.request(root + path + query, { method, headers });
  const close = (body: unknown = intent, suffix = '', inputHeaders = headers) => app.request(root + path + '/close' + suffix, { method: 'POST', headers: inputHeaders, body: JSON.stringify(body) });
  return { read, closed, gateway, verifyIdentity, app, get, close };
}
describe('public access recovery routes', () => {
  it('returns typed absence with private no-store headers and exact original query', async () => {
    const f = fixture(), response = await f.get(); expect(response.status).toBe(200); expect(await response.json()).toEqual(f.read);
    expect(response.headers.get('cache-control')).toBe('private, no-store'); expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(f.gateway.get).toHaveBeenCalledWith('fixture.token', { kind: 'revise', key }, expect.any(String)); expect(f.gateway.close).not.toHaveBeenCalled();
  });
  it('returns an exact fence and forwards only parsed close intent plus the original key', async () => {
    const f = fixture(), response = await f.close(); expect(response.status).toBe(200); expect(await response.json()).toEqual(f.closed);
    expect(f.gateway.close).toHaveBeenCalledWith('fixture.token', key, intent, expect.any(String));
  });
  it.each(['?kind=revise&kind=grant&key=' + key, '?kind=revise&key=' + key + '&key=another-original-key', '?kind=revise&key=' + key + '&extra=1', '?kind=member.revise&key=' + key, '?kind=revise'])('rejects malformed query %s before recovery lookup', async query => {
    const f = fixture(); expect((await f.get(query)).status).toBe(422); expect(f.gateway.get).not.toHaveBeenCalled();
  });
  it.each(['HEAD', 'PUT', 'DELETE'])('does not map %s into a recovery GET', async method => {
    const f = fixture(); expect((await f.get('?kind=revise&key=' + key, method)).status).toBe(404); expect(f.gateway.get).not.toHaveBeenCalled();
  });
  it('does not close through GET or accept query fields on a close', async () => {
    const f = fixture(); expect((await f.app.request(root + path + '/close', { headers })).status).toBe(404);
    expect((await f.close(intent, '?retry=true')).status).toBe(422); expect(f.gateway.close).not.toHaveBeenCalled();
  });
  it.each(['proof', 'nonce', 'originalCommand', 'key', 'targetActorId'])('rejects caller-supplied %s rather than treating it as private evidence', async field => {
    const f = fixture(); expect((await f.close({ ...intent, [field]: 'fixture' })).status).toBe(422); expect(f.gateway.close).not.toHaveBeenCalled();
  });
  it('requires bearer authentication, approved origin, JSON body and original key', async () => {
    const f = fixture();
    for (const change of [{ Authorization: '' }, { Origin: 'https://unapproved.example' }, { 'Content-Type': 'text/plain' }, { 'Idempotency-Key': '' }]) {
      const response = await f.close(intent, '', { ...headers, ...change }); expect(response.status).toBeGreaterThanOrEqual(400);
    }
    expect(f.gateway.close).not.toHaveBeenCalled();
  });
  it('keeps unavailable recovery separate from existing application setup', async () => {
    const app = createApp({ allowedOrigins: ['http://localhost:3001'], verifyIdentity: fixture().verifyIdentity });
    expect((await app.request(root + path + '?kind=revise&key=' + key, { headers })).status).toBe(503);
  });
  it.each(['key', 'kind', 'externalOrganizationId'])('fails closed on a foreign %s in the read result', async field => {
    const f = fixture(); (f.read as Record<string, unknown>)[field] = field === 'kind' ? 'grant' : 'foreign';
    const response = await f.get(); expect(response.status).toBe(503); expect((await response.json()).error.code).toBe('DURABLE_SERVICE_UNAVAILABLE');
  });
  it('cannot turn absence or a foreign reviewer into a successful close receipt', async () => {
    const f = fixture(); f.gateway.close.mockResolvedValueOnce(f.read as never); expect((await f.close()).status).toBe(503);
    f.closed.reviewer.actorId = 'other_owner'; expect((await f.close()).status).toBe(503);
  });
  it('returns an existing receipt with the current epoch without comparing it to the old review epoch', async () => {
    const f = fixture(); f.closed.reviewer.authorityEpoch = 9;
    const response = await f.close(); expect(response.status).toBe(200); expect((await response.json()).reviewer.authorityEpoch).toBe(9);
  });
  it('discards unexpected exception details without confirming closure', async () => {
    const f = fixture(); f.gateway.close.mockRejectedValueOnce(new Error('private fixture error detail'));
    const response = await f.close(); expect(response.status).toBe(503); expect(await response.text()).not.toContain('private fixture error detail');
  });
});
