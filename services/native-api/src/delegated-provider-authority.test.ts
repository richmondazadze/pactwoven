import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClerkDelegatedProviderAuthorityObserver, createDelegatedProviderAuthorityObserver,
  type DelegatedProviderContext } from './delegated-provider-authority.js';

const start = Date.parse('2026-11-18T12:00:00.000Z');
const context = (): DelegatedProviderContext => ({ subject: 'user_test', externalOrganizationId: 'org_test',
  externalMembershipId: 'orgmem_test', requiredRole: 'org:admin' });
const user = () => ({ id: 'user_test', banned: false, locked: false, deprovisioned: false });
const member = () => ({ id: 'orgmem_test', role: 'org:admin', organization: { id: 'org_test' }, public_user_data: { user_id: 'user_test' } });
const page = () => ({ data: [member()], total_count: 1 });
const readers = () => ({ user: vi.fn(async () => user()), membership: vi.fn(async () => page()) });
const options = () => ({ deadlineAt: start + 8_000 });
afterEach(() => vi.useRealTimers());

describe('current identity behind an explicit delegated grant', () => {
  it('uses current user and exact membership without reading an issuing session', async () => {
    const read = { ...readers(), session: vi.fn(() => { throw Error('No issuing session exists.'); }) };
    const observe = createDelegatedProviderAuthorityObserver(read, { now: () => start });
    expect(await observe(context(), options())).toEqual({ state: 'allowed', reason: 'current',
      observationStartedAt: new Date(start).toISOString(), observationCompletedAt: new Date(start).toISOString() });
    expect(read.user).toHaveBeenCalledWith('user_test', expect.any(AbortSignal));
    expect(read.membership).toHaveBeenCalledWith('org_test', 'user_test', expect.any(AbortSignal));
    expect(read.session).not.toHaveBeenCalled();
  });
  it.each([['banned', 'user_banned'], ['locked', 'user_locked'], ['deprovisioned', 'user_deprovisioned']] as const)(
    'denies a currently %s issuer', async (flag, reason) => {
      const read = readers(); read.user.mockResolvedValue({ ...user(), [flag]: true });
      expect(await createDelegatedProviderAuthorityObserver(read, { now: () => start })(context(), options())).toMatchObject({ state: 'denied', reason });
    });
  it.each([
    [{ data: [], total_count: 0 }, 'membership_removed'],
    [{ data: [{ ...member(), id: 'orgmem_recreated' }], total_count: 1 }, 'membership_replaced'],
    [{ data: [{ ...member(), role: 'org:member' }], total_count: 1 }, 'required_role_removed'],
  ])('does not preserve stale organization authority', async (value, reason) => {
    const read = readers(); read.membership.mockResolvedValue(value as ReturnType<typeof page>);
    expect(await createDelegatedProviderAuthorityObserver(read, { now: () => start })(context(), options())).toMatchObject({ state: 'denied', reason });
  });
  it('does not impose an organization role where local policy requires none', async () => {
    const read = readers(); read.membership.mockResolvedValue({ data: [{ ...member(), role: 'org:member' }], total_count: 1 });
    expect(await createDelegatedProviderAuthorityObserver(read, { now: () => start })({ ...context(), requiredRole: null }, options())).toMatchObject({ state: 'allowed' });
  });
  it.each([
    { data: [member(), member()], total_count: 2 },
    { data: [member()], total_count: 0 },
    { data: [{ ...member(), organization: { id: 'other' } }], total_count: 1 },
    { data: [{ ...member(), public_user_data: { user_id: 'other' } }], total_count: 1 },
  ])('rejects ambiguous or differently scoped membership observations', async value => {
    const read = readers(); read.membership.mockResolvedValue(value);
    expect(await createDelegatedProviderAuthorityObserver(read, { now: () => start })(context(), options())).toMatchObject({ state: 'unavailable', reason: 'malformed_response' });
  });
  it('rejects the wrong user record', async () => {
    const read = readers(); read.user.mockResolvedValue({ ...user(), id: 'other' });
    expect(await createDelegatedProviderAuthorityObserver(read, { now: () => start })(context(), options())).toMatchObject({ state: 'unavailable', reason: 'malformed_response' });
  });
  it.each([[401, 'provider_auth'], [403, 'provider_auth'], [429, 'rate_limited'], [500, 'provider_unavailable']] as const)(
    'retains unknown state for provider failure %s', async (status, reason) => {
      const read = readers(); read.user.mockRejectedValue({ status }); read.membership.mockResolvedValue({ data: [], total_count: 0 });
      expect(await createDelegatedProviderAuthorityObserver(read, { now: () => start })(context(), options())).toMatchObject({ state: 'unavailable', reason });
    });
  it.each(['user', 'membership'] as const)('denies definitive %s absence', async field => {
    const read = readers(); read[field].mockRejectedValue({ status: 404 });
    expect(await createDelegatedProviderAuthorityObserver(read, { now: () => start })(context(), options())).toMatchObject({
      state: 'denied', reason: field === 'user' ? 'user_missing' : 'organization_missing' });
  });
  it('retains unknown on network failure despite another definite absence', async () => {
    const read = readers(); read.user.mockRejectedValue(Error('Offline')); read.membership.mockRejectedValue({ status: 404 });
    expect(await createDelegatedProviderAuthorityObserver(read, { now: () => start })(context(), options())).toMatchObject({ state: 'unavailable', reason: 'network' });
  });
  it('snapshots identity before asynchronous readers run', async () => {
    const input = context(), read = readers();
    read.user.mockImplementation(async () => { input.externalMembershipId = 'other'; input.requiredRole = null; return user(); });
    read.membership.mockResolvedValue({ data: [{ ...member(), role: 'org:member' }], total_count: 1 });
    expect(await createDelegatedProviderAuthorityObserver(read, { now: () => start })(input, options())).toMatchObject({ state: 'denied', reason: 'required_role_removed' });
  });
  it('checks the exclusive deadline after the reads settle', async () => {
    let time = start; const read = readers(); read.membership.mockImplementation(async () => { time += 8_000; return page(); });
    expect(await createDelegatedProviderAuthorityObserver(read, { now: () => time })(context(), options())).toMatchObject({ state: 'unavailable', reason: 'deadline_exceeded' });
  });
  it('checks the final verdict clock again', async () => {
    const times = [start, start + 7_999, start + 8_000];
    expect(await createDelegatedProviderAuthorityObserver(readers(), { now: () => times.shift()! })(context(), options())).toMatchObject({ state: 'unavailable', reason: 'deadline_exceeded' });
  });
  it('fails closed when the clock moves backwards or leaves four-digit ISO time', async () => {
    for (const changed of [start - 1, NaN, Date.parse('+010000-01-01T00:00:00.000Z')]) {
      const times = [start, start, changed];
      expect(await createDelegatedProviderAuthorityObserver(readers(), { now: () => times.shift()! })(context(), options())).toMatchObject({ state: 'unavailable', reason: 'clock_invalid' });
    }
  });
  it('aborts even a reader that ignores its signal', async () => {
    vi.useFakeTimers(); const read = readers(); read.user.mockImplementation(() => new Promise(() => {}));
    const pending = createDelegatedProviderAuthorityObserver(read, { now: () => start })(context(), { deadlineAt: start + 60_000 });
    await vi.advanceTimersByTimeAsync(8_000);
    expect(await pending).toMatchObject({ state: 'unavailable', reason: 'deadline_exceeded' });
    expect(vi.getTimerCount()).toBe(0);
  });
  it('propagates cancellation to both reads without leaving a grant', async () => {
    const abort = new AbortController(); const read = readers();
    read.user.mockImplementation(async () => { abort.abort(); return user(); });
    expect(await createDelegatedProviderAuthorityObserver(read, { now: () => start })(context(), { ...options(), signal: abort.signal })).toMatchObject({ state: 'unavailable', reason: 'cancelled' });
  });
  it.each([{ ...context(), sessionId: 'session_added' }, { ...context(), subject: '../users' }, { ...context(), requiredRole: undefined }])(
    'does not read a malformed or session-extended identity', async value => {
      const read = readers();
      expect(await createDelegatedProviderAuthorityObserver(read, { now: () => start })(value as DelegatedProviderContext, options())).toMatchObject({ state: 'unavailable', reason: 'invalid_context' });
      expect(read.user).not.toHaveBeenCalled(); expect(read.membership).not.toHaveBeenCalled();
    });
  it.each([NaN, 0, start, -1, Infinity])('does not start provider calls for invalid/past deadline %s', async deadlineAt => {
    const read = readers();
    expect(await createDelegatedProviderAuthorityObserver(read, { now: () => start })(context(), { deadlineAt })).toMatchObject({ state: 'unavailable' });
    expect(read.user).not.toHaveBeenCalled(); expect(read.membership).not.toHaveBeenCalled();
  });
  it('uses only the fixed user and membership REST endpoints with fresh bounded reads', async () => {
    const paths: string[] = [];
    const observe = createClerkDelegatedProviderAuthorityObserver({ secretKey: 'sk_test_syntheticOnly' }, { now: () => start,
      fetch: async (url, init) => {
        expect(url.origin).toBe('https://api.clerk.com');
        expect(init).toMatchObject({ method: 'GET', redirect: 'error', cache: 'no-store', credentials: 'omit' });
        paths.push(url.pathname + url.search);
        return Response.json(url.pathname.startsWith('/v1/users/') ? user() : page());
      },
    });
    expect(await observe(context(), options())).toMatchObject({ state: 'allowed' });
    expect(paths).toEqual(['/v1/users/user_test', '/v1/organizations/org_test/memberships?user_id=user_test&limit=2']);
  });
  it('does not admit oversized or malformed REST payloads', async () => {
    for (const body of ['x'.repeat(65_537), '{}']) {
      const observe = createClerkDelegatedProviderAuthorityObserver({ secretKey: 'sk_test_syntheticOnly' }, {
        now: () => start, fetch: async () => new Response(body, { headers: { 'content-type': 'application/json' } }),
      });
      expect(await observe(context(), options())).toMatchObject({ state: 'unavailable', reason: 'malformed_response' });
    }
  });
});
