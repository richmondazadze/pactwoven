import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CustodyApiRecoveryContext, Responsibility, Session } from '@pactwoven/contracts';
import { createCustodyRecoveryBootstrap, createCustodyRecoveryClock, qualifyCustodyRecoveryContext, readCustodyRecoveryContext } from './custody-setup-context';

const at = Date.parse('2026-11-15T16:00:00.000Z'), iso = (n: number) => new Date(n).toISOString(), base = 'https://api.example.test';
function fixture() {
  const session: Session = { actor: { actorId: 'owner_a', principalKind: 'human', organizationId: 'org_a', environment: 'development', roles: ['owner'],
    siteIds: ['site_a'], actionSiteIds: ['site_a'], sessionId: 'session_a', authenticatedAt: iso(at - 60000), correlationId: 'fixture_trace' },
    organization: { id: 'org_a', name: 'Synthetic', authorityEpoch: 2 }, sites: [{ id: 'site_a', name: 'Site', timeZone: 'UTC' }] };
  const auth = { isLoaded: true, isSignedIn: true, userId: 'user_a', orgId: 'provider_org', sessionId: 'session_a' };
  const record: Responsibility = { id: 'responsibility_a', organizationId: 'org_a', ownerId: 'owner_a', environment: 'development', version: 1,
    executionState: 'DRAFT', authorityState: null, coverageState: 'UNKNOWN', title: 'Synthetic responsibility', description: '', siteId: 'site_a',
    window: { startsAt: iso(at), endsAt: iso(at + 3600000), timeZone: 'UTC' }, requirements: [], acceptancePolicy: '', createdAt: iso(at - 1000), updatedAt: iso(at - 1000) };
  const bootstrap = createCustodyRecoveryBootstrap(session, auth, base, record, record.id);
  const context: CustodyApiRecoveryContext = { schemaVersion: 1, environment: 'development', organizationId: 'org_a', externalOrganizationId: 'provider_org',
    responsibilityId: record.id, owner: { actorId: 'owner_a', membershipVersion: 3, externalMembershipId: 'member_a', subject: 'user_a', sessionId: 'session_a' },
    observedAt: iso(at - 1000), expiresAt: iso(at + 19000) };
  const selected = { value: bootstrap as typeof bootstrap | null }, fetcher = vi.fn(async () => json(context)), getToken = vi.fn(async () => 'fixture_token');
  const controller = new AbortController(), adapters = { currentBootstrap: () => selected.value, getToken, fetch: fetcher, wallTime: () => at, monotonic: () => 100 };
  return { session, auth, record, bootstrap, context, selected, fetcher, getToken, controller, adapters, read: () => readCustodyRecoveryContext(bootstrap, adapters, controller.signal) };
}
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'private, no-store' } });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const realFetch = vi.fn(() => { throw new Error('Unexpected real fetch'); });
beforeEach(() => { vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', base); realFetch.mockClear(); vi.stubGlobal('fetch', realFetch); });
afterEach(() => { expect(realFetch).not.toHaveBeenCalled(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('native custody recovery bootstrap', () => {
  it('uses server owner membership facts and binds complete current user/session/record scope', () => {
    const f = fixture(), observation = qualifyCustodyRecoveryContext(f.context, f.bootstrap, at, 100);
    expect(observation.scope.owner.externalMembershipId).toBe('member_a'); expect(observation.scope.owner.membershipVersion).toBe(3);
    expect(Object.isFrozen(observation.scope.owner)).toBe(true); expect(Object.isFrozen(observation.bootstrap)).toBe(true);
    f.context.owner.membershipVersion = 9; f.session.actor.siteIds.length = 0;
    expect(observation.scope.owner.membershipVersion).toBe(3); expect(observation.bootstrap.siteIds).toEqual(['site_a']);
  });
  it.each(['signed-out', 'not-loaded', 'session', 'nonowner', 'service', 'production', 'organization', 'route', 'read-site', 'action-site', 'record-org'])(
    'does not form an owner bootstrap for %s', change => {
      const f = fixture(); let route = f.record.id;
      if (change === 'signed-out') f.auth.isSignedIn = false; if (change === 'not-loaded') f.auth.isLoaded = false;
      if (change === 'session') f.auth.sessionId = 'other'; if (change === 'nonowner') f.session.actor.roles = ['finance'];
      if (change === 'service') f.session.actor.principalKind = 'service'; if (change === 'production') f.session.actor.environment = 'production';
      if (change === 'organization') f.session.actor.organizationId = 'other'; if (change === 'route') route = 'another_record';
      if (change === 'read-site') f.session.actor.siteIds = []; if (change === 'action-site') f.session.actor.actionSiteIds = [];
      if (change === 'record-org') f.record.organizationId = 'other';
      expect(() => createCustodyRecoveryBootstrap(f.session, f.auth, base, f.record, route)).toThrow();
    });
  it.each(['organization', 'provider-org', 'responsibility', 'actor', 'subject', 'session', 'environment'])(
    'refuses a returned %s mismatch', change => {
      const f = fixture(); const value: any = structuredClone(f.context);
      if (change === 'organization') value.organizationId = 'other'; if (change === 'provider-org') value.externalOrganizationId = 'other';
      if (change === 'responsibility') value.responsibilityId = 'other'; if (change === 'actor') value.owner.actorId = 'other';
      if (change === 'subject') value.owner.subject = 'other'; if (change === 'session') value.owner.sessionId = 'other';
      if (change === 'environment') value.environment = 'production';
      expect(() => qualifyCustodyRecoveryContext(value, f.bootstrap, at, 100)).toThrow();
    });
  it.each(['future', 'expired', 'long', 'noncanonical', 'clock', 'monotonic'])(
    'refuses %s freshness rather than extending it', change => {
      const f = fixture(); if (change === 'future') f.context.observedAt = iso(at + 1);
      if (change === 'expired') f.context.expiresAt = iso(at); if (change === 'long') f.context.expiresAt = iso(at + 20001);
      if (change === 'noncanonical') f.context.observedAt = '2026-11-15T15:59:59Z';
      expect(() => qualifyCustodyRecoveryContext(f.context, f.bootstrap, change === 'clock' ? NaN : at, change === 'monotonic' ? -1 : 100)).toThrow();
    });
  it('cannot extend an observation by wall-clock rollback after a forward jump', () => {
    const f = fixture(), observation = qualifyCustodyRecoveryContext(f.context, f.bootstrap, at, 100); let wall = at, mono = 100;
    const now = createCustodyRecoveryClock(observation, () => wall, () => mono);
    wall = at + 15000; expect(now()).toBe(at + 15000); wall = at - 30000; mono += 1000; expect(now()).toBe(at + 15000);
    mono += 19000; expect(now()).toBe(at + 20000); mono--; expect(now).toThrow();
  });
});

describe('bounded explicit owner context read', () => {
  it('makes one exact GET with a fresh organization token and no private context fields', async () => {
    const f = fixture(), result = await f.read(); expect(result.scope.owner.membershipVersion).toBe(3);
    expect(f.getToken).toHaveBeenCalledWith({ organizationId: 'provider_org', skipCache: true });
    const [url, init] = f.fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(base + '/v1/responsibilities/responsibility_a/custody-setups/recovery-context');
    expect(init).toMatchObject({ method: 'GET', cache: 'no-store', credentials: 'omit', redirect: 'error' });
    expect(init.body).toBeUndefined(); expect(f.fetcher).toHaveBeenCalledOnce();
  });
  it.each(['departure', 'session', 'origin'])('a %s change during token wait prevents dispatch', async change => {
    const f = fixture(), token = deferred<string>(); f.getToken.mockReturnValueOnce(token.promise); const pending = f.read();
    if (change === 'departure') f.controller.abort(); if (change === 'session') f.selected.value = { ...f.bootstrap, sessionId: 'other' };
    if (change === 'origin') vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', 'https://other.example.test');
    token.resolve('fixture_token'); await expect(pending).rejects.toMatchObject({ code: 'scope' }); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it.each(['token', 'response', 'body'])('classifies an ordinary %s deadline as unconfirmed', async phase => {
    const f = fixture(); vi.useFakeTimers();
    if (phase === 'token') f.getToken.mockReturnValueOnce(new Promise(() => {}));
    if (phase === 'response') f.fetcher.mockReturnValueOnce(new Promise(() => {}));
    if (phase === 'body') f.fetcher.mockResolvedValueOnce(new Response(new ReadableStream({}), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } }));
    const pending = f.read().catch(error => error); await vi.advanceTimersByTimeAsync(10001); expect(await pending).toMatchObject({ code: 'unconfirmed' });
  });
  it('scope departure wins after the deadline marker but before rejection handling', async () => {
    const f = fixture(); vi.useFakeTimers(); f.getToken.mockReturnValueOnce(new Promise(() => {})); const pending = f.read().catch(error => error);
    vi.advanceTimersByTime(10000); f.controller.abort(); expect(await pending).toMatchObject({ code: 'scope' }); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('cancels an unread response rejected before JSON reading', async () => {
    const f = fixture(), cancel = vi.fn();
    f.fetcher.mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'private, no-store' } }));
    await expect(f.read()).rejects.toMatchObject({ code: 'unconfirmed' }); expect(cancel).toHaveBeenCalledOnce();
    expect((f.fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].signal?.aborted).toBe(true);
  });
  it('cancels a response that arrives after the observation departed', async () => {
    const f = fixture(), response = deferred<Response>(), cancel = vi.fn(); f.fetcher.mockReturnValueOnce(response.promise);
    const pending = f.read().catch(error => error); await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledOnce()); f.controller.abort();
    expect(await pending).toMatchObject({ code: 'scope' });
    response.resolve(new Response(new ReadableStream({ cancel }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } }));
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  });
  it.each(['redirect', 'cache', 'type', 'duplicate', 'large', 'invalid', 'private-extra'])('refuses %s context output', async mode => {
    const f = fixture(); let response = json(f.context);
    if (mode === 'redirect') response = new Response(null, { status: 302 });
    if (mode === 'cache') response = Response.json(f.context, { headers: { 'Cache-Control': 'private="no-store"' } });
    if (mode === 'type') response = new Response('{}', { headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'private, no-store' } });
    if (mode === 'duplicate') response = new Response('{"schemaVersion":1,"schemaVersion":1}', { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } });
    if (mode === 'large') response = new Response('x'.repeat(8193), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } });
    if (mode === 'invalid') response = json({}); if (mode === 'private-extra') response = json({ ...f.context, tokenHash: 'a'.repeat(64) });
    f.fetcher.mockResolvedValueOnce(response); await expect(f.read()).rejects.toMatchObject({ code: 'unconfirmed' });
  });
  it.each([['AUTH_REQUIRED', 'scope'], ['FORBIDDEN', 'scope'], ['SETUP_REQUIRED', 'unavailable'], ['CUSTODY_EXPIRED', 'expired'], ['UNKNOWN', 'unconfirmed']])(
    'sanitizes %s without leaking provider text', async (code, expected) => {
      const f = fixture(); f.fetcher.mockResolvedValueOnce(json({ error: { code, message: 'private SQL diagnostic' } }, 403));
      const error = await f.read().catch(error => error); expect(error.code).toBe(expected); expect(error.message).not.toContain('private SQL diagnostic');
    });
});
