import { describe, expect, it, vi } from 'vitest';
import type { Session } from '@pactwoven/contracts';
import type { FoundationRepository, OrganizationProvisioner, VerifiedIdentity } from '@pactwoven/db';
import { DomainError } from '@pactwoven/domain';
import { createApp } from './app.js';

const origin = 'http://localhost:3001';
const session: Session = {
  actor: { actorId: 'actor_a', organizationId: 'org_a', environment: 'development', principalKind: 'human', roles: ['owner'], siteIds: ['site_a'], actionSiteIds: ['site_a'],
    sessionId: 'session_a', authenticatedAt: '2026-11-14T00:00:00.000Z', correlationId: 'trace_a' },
  organization: { id: 'org_a', name: 'Harbor Events', authorityEpoch: 0 }, sites: [{ id: 'site_a', name: 'Harbor Hall', timeZone: 'America/Chicago' }],
};
const identity: VerifiedIdentity = { subject: 'user_a', externalOrganizationId: 'external_a', sessionId: 'session_a',
  externalOrganizationName: 'Harbor Events', externalMembershipId: 'membership_a', externalRole: 'org:admin',
  authenticatedAt: session.actor.authenticatedAt, membershipObservedAt: '2026-11-14T00:00:00.000Z' };
function fixture() {
  const repository: FoundationRepository = {
    getSession: vi.fn(async (_identity, correlationId) => ({ ...session, actor: { ...session.actor, correlationId } })),
    listResponsibilities: vi.fn(async () => ({ items: [], nextCursor: null })),
    getResponsibility: vi.fn(async () => { throw new DomainError('NOT_FOUND', 404, 'Responsibility not found.'); }),
    createResponsibility: vi.fn<FoundationRepository['createResponsibility']>(async () => ({ id: 'operation_a', environment: 'development', status: 'succeeded', aggregateId: 'record_a', aggregateVersion: 1,
      financialState: null, evidenceRefs: [], nextCheckAt: null, error: null })),
  };
  const provisioner: OrganizationProvisioner = {
    bootstrapOrganization: vi.fn<OrganizationProvisioner['bootstrapOrganization']>(async () => ({ id: 'bootstrap_a', environment: 'development', status: 'succeeded', aggregateId: 'org_a', aggregateVersion: 1,
      financialState: null, evidenceRefs: [], nextCheckAt: null, error: null })),
  };
  const verifyIdentity = vi.fn(async () => identity);
  const app = createApp({ repository, provisioner, verifyIdentity, allowedOrigins: [origin] });
  return { app, repository, provisioner, verifyIdentity };
}
const headers = { Authorization: 'Bearer verified-test-token', Origin: origin, 'Content-Type': 'application/json', 'Idempotency-Key': 'create_http_request_0001' };
const command = { expectedVersion: 0, mandateVersion: null, authorityEpoch: null, payload: { title: 'Harbor Hall', description: '', siteId: 'site_a',
  window: { startsAt: '2026-11-20T13:00:00Z', endsAt: '2026-11-20T14:00:00Z', timeZone: 'America/Chicago' }, requirements: [], acceptancePolicy: '' } };
const bootstrapCommand = { expectedVersion: 0, mandateVersion: null, authorityEpoch: null,
  payload: { initialSite: { name: 'Harbor Hall', timeZone: 'America/Chicago' } } };

describe('API protocol and input boundaries', () => {
  it('reports missing setup explicitly and never exposes protected data without authentication', async () => {
    expect((await createApp({ allowedOrigins: [origin] }).request('/v1/session')).status).toBe(503);
    const { app, repository } = fixture();
    expect((await app.request('/v1/session')).status).toBe(401);
    expect(repository.getSession).not.toHaveBeenCalled();
    const result = await app.request('/v1/session', { headers });
    expect(result.status).toBe(200);
    expect(result.headers.get('cache-control')).toBe('private, no-store');
    expect((await result.json()).actor.actorId).toBe('actor_a');
  });
  it('rejects untrusted origins and allows only the required preflight methods and headers', async () => {
    const { app } = fixture();
    expect((await app.request('/v1/session', { headers: { ...headers, Origin: 'https://attacker.example' } })).status).toBe(403);
    const preflight = await app.request('/v1/responsibilities', { method: 'OPTIONS', headers: { Origin: origin,
      'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, content-type, idempotency-key, x-correlation-id' } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(origin);
    expect((await app.request('/v1/responsibilities', { method: 'OPTIONS', headers: { Origin: origin,
      'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-actor-id' } })).status).toBe(403);
  });
  it('takes actor only from verified session and rejects unexpected request fields', async () => {
    const { app, repository } = fixture();
    const invalid = await app.request('/v1/responsibilities', { method: 'POST', headers, body: JSON.stringify({ ...command, actorId: 'attacker' }) });
    expect(invalid.status).toBe(422);
    expect(repository.createResponsibility).not.toHaveBeenCalled();
    const valid = await app.request('/v1/responsibilities', { method: 'POST', headers, body: JSON.stringify(command) });
    expect(valid.status).toBe(201);
    expect(valid.headers.get('location')).toBe('/v1/responsibilities/record_a');
    expect(repository.createResponsibility).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'actor_a', organizationId: 'org_a' }), headers['Idempotency-Key'], command);
  });
  it('bounds JSON and pagination and rejects malformed payloads before mutation', async () => {
    const { app, repository } = fixture();
    expect((await app.request('/v1/responsibilities', { method: 'POST', headers, body: '{' })).status).toBe(422);
    expect((await app.request('/v1/responsibilities', { method: 'POST', headers: { ...headers, 'Content-Type': 'text/plain' }, body: '{}' })).status).toBe(415);
    expect((await app.request('/v1/responsibilities', { method: 'POST', headers, body: JSON.stringify({ value: 'x'.repeat(70_000) }) })).status).toBe(413);
    expect((await app.request('/v1/responsibilities?limit=1000', { headers })).status).toBe(422);
    expect(repository.createResponsibility).not.toHaveBeenCalled();
  });
  it('returns safe errors rather than raw database or provider detail', async () => {
    const { app, repository } = fixture();
    const privateDatabase = new URL('postgres://secret@private-db/customer');
    privateDatabase.password = 'fixture';
    vi.mocked(repository.listResponsibilities).mockRejectedValueOnce(new Error(privateDatabase.href));
    const response = await app.request('/v1/responsibilities', { headers });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('password');
  });
  it('bootstraps from live identity without requiring an existing internal member', async () => {
    const { app, repository, provisioner } = fixture();
    vi.mocked(repository.getSession).mockRejectedValue(new DomainError('ORGANIZATION_SETUP_REQUIRED', 409, 'Set up this organization.'));
    const missing = await app.request('/v1/session', { headers });
    expect(missing.status).toBe(409);
    vi.mocked(repository.getSession).mockClear();
    const response = await app.request('/v1/organizations/bootstrap', { method: 'POST', headers, body: JSON.stringify(bootstrapCommand) });
    expect(response.status).toBe(201);
    expect(response.headers.get('location')).toBe('/v1/session');
    expect(provisioner.bootstrapOrganization).toHaveBeenCalledWith(identity, headers['Idempotency-Key'], bootstrapCommand, expect.any(String));
    expect(repository.getSession).not.toHaveBeenCalled();
  });
  it('denies non-admin bootstrap and caller-controlled authority or organization fields', async () => {
    const { app, provisioner, verifyIdentity } = fixture();
    for (const extra of [{ actorId: 'other' }, { organizationId: 'other' }, { roles: ['owner'] }]) {
      expect((await app.request('/v1/organizations/bootstrap', { method: 'POST', headers,
        body: JSON.stringify({ ...bootstrapCommand, ...extra }) })).status).toBe(422);
    }
    verifyIdentity.mockResolvedValue({ ...identity, externalRole: 'org:member' });
    expect((await app.request('/v1/organizations/bootstrap', { method: 'POST', headers, body: JSON.stringify(bootstrapCommand) })).status).toBe(403);
    expect(provisioner.bootstrapOrganization).not.toHaveBeenCalled();
  });
  it.each(['/v1/responsibilities', '/v1/organizations/bootstrap'])('revalidates after a delayed body at %s', async route => {
    const { app, repository, provisioner, verifyIdentity } = fixture();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    const request = new Request(`http://localhost${route}`, { method: 'POST', headers, body, duplex: 'half' } as RequestInit);
    const pending = app.request(request);
    await Promise.resolve();
    expect(verifyIdentity).not.toHaveBeenCalled();
    verifyIdentity.mockRejectedValue(new DomainError('AUTH_REQUIRED', 401, 'This session expired or was revoked.'));
    controller.enqueue(new TextEncoder().encode(JSON.stringify(route.endsWith('bootstrap') ? bootstrapCommand : command)));
    controller.close();
    expect((await pending).status).toBe(401);
    expect(verifyIdentity).toHaveBeenCalledTimes(1);
    expect(repository.createResponsibility).not.toHaveBeenCalled();
    expect(provisioner.bootstrapOrganization).not.toHaveBeenCalled();
  });
  it('times out a stalled body before authorization and returns no private error detail', async () => {
    vi.useFakeTimers();
    try {
      const { app, verifyIdentity, provisioner } = fixture();
      const cancel = vi.fn();
      const body = new ReadableStream<Uint8Array>({ cancel });
      const pending = app.request(new Request('http://localhost/v1/organizations/bootstrap',
        { method: 'POST', headers, body, duplex: 'half' } as RequestInit));
      await vi.advanceTimersByTimeAsync(5_001);
      const response = await pending;
      expect(response.status).toBe(408);
      expect((await response.json()).error.code).toBe('REQUEST_TIMEOUT');
      expect(cancel).toHaveBeenCalled();
      expect(verifyIdentity).not.toHaveBeenCalled();
      expect(provisioner.bootstrapOrganization).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});
