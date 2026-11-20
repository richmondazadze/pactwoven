import { afterEach, describe, expect, it, vi } from 'vitest';
import { NativeAuthorityVerdictSchema } from '@pactwoven/contracts';
import { createClerkProviderAuthorityObserver, createProviderAuthorityObserver, providerAuthorityMaximumResponseBytes,
  type ProviderAuthorityContext, type ProviderAuthorityFetch, type ProviderAuthorityReaders } from './provider-authority.js';

const time = Date.parse('2026-11-18T12:00:00Z');
const context: ProviderAuthorityContext = { sessionId: 'sess_pinned', subject: 'user_pinned', externalOrganizationId: 'org_pinned', externalMembershipId: 'member_pinned', requiredRole: 'org:admin' };
const secretKey = 'sk_test_synthetic_authority_fixture';
function values() {
  return {
    session: { id: context.sessionId, user_id: context.subject, status: 'active', actor: null, created_at: time - 60_000, expire_at: time + 120_000, abandon_at: time + 60_000 },
    user: { id: context.subject, banned: false, locked: false, deprovisioned: false },
    membership: { data: [{ id: context.externalMembershipId, role: 'org:admin', organization: { id: context.externalOrganizationId }, public_user_data: { user_id: context.subject } }], total_count: 1 },
  };
}
function fixture() {
  const data = values(); let at = time;
  const readers = { session: vi.fn(async () => data.session), user: vi.fn(async () => data.user), membership: vi.fn(async () => data.membership) };
  const observe = createProviderAuthorityObserver(readers, { now: () => at });
  return { data, readers, observe, setTime: (next: number) => { at = next; }, run: (input = context) => observe(input, { deadlineAt: time + 30_000 }) };
}
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const options = () => ({ deadlineAt: Date.now() + 30_000 });
afterEach(() => vi.useRealTimers());

describe('server-pinned provider authority observations', () => {
  it('returns only a verdict and conservative observation/expiry times', async () => {
    const f = fixture();
    f.readers.session.mockImplementation(async () => { f.setTime(time + 1000); return { ...f.data.session, private: secretKey }; });
    f.readers.user.mockImplementation(async () => { f.setTime(time + 2000); return f.data.user; });
    f.readers.membership.mockImplementation(async () => { f.setTime(time + 3000); return f.data.membership; });
    const result = await f.run();
    expect(result).toEqual({ state: 'allowed', reason: 'current', observationStartedAt: new Date(time).toISOString(),
      observationCompletedAt: new Date(time + 3000).toISOString(), providerExpiresAt: new Date(time + 60_000).toISOString() });
    expect(JSON.stringify(result)).not.toMatch(/sess_pinned|user_pinned|org_pinned|member_pinned|sk_test/);
    expect(f.readers.membership).toHaveBeenCalledWith('org_pinned', 'user_pinned', expect.any(AbortSignal));
  });
  it('does not depend on browser activity, browser JWT expiry or the active organization', async () => {
    const f = fixture();
    f.readers.session.mockResolvedValue({ ...f.data.session, last_active_organization_id: 'another_org', last_active_at: 0, browserTokenExp: time - 1 } as typeof f.data.session);
    expect(await f.run()).toMatchObject({ state: 'allowed' });
  });
  it('snapshots exact identity and required role before asynchronous reads', async () => {
    const f = fixture(), input = { ...context };
    f.data.membership.data[0]!.role = 'org:member';
    const pending = f.run(input);
    input.subject = 'attacker'; input.externalOrganizationId = 'other_org'; input.externalMembershipId = 'other_member'; input.requiredRole = null;
    expect(await pending).toMatchObject({ state: 'denied', reason: 'required_role_removed' });
    expect(f.readers.user).toHaveBeenCalledWith(context.subject, expect.any(AbortSignal));
    expect(f.readers.membership).toHaveBeenCalledWith(context.externalOrganizationId, context.subject, expect.any(AbortSignal));
  });
  it.each(['revoked', 'ended', 'expired', 'removed', 'replaced', 'abandoned', 'pending'])('denies explicit %s session state', async status => {
    const f = fixture(); f.data.session.status = status;
    expect(await f.run()).toMatchObject({ state: 'denied', reason: 'session_inactive' });
  });
  it.each(['banned', 'locked', 'deprovisioned'] as const)('denies a %s user', async restriction => {
    const f = fixture(); f.data.user[restriction] = true;
    expect(await f.run()).toMatchObject({ state: 'denied', reason: `user_${restriction}` });
  });
  it.each(['expire_at', 'abandon_at'] as const)('uses the exclusive provider %s boundary', async field => {
    const f = fixture(); f.data.session[field] = time;
    expect(await f.run()).toMatchObject({ state: 'denied', reason: 'session_expired', providerExpiresAt: new Date(time).toISOString() });
  });
  it('checks provider expiry again after other provider reads complete', async () => {
    const f = fixture(); f.data.session.expire_at = time + 1000;
    f.readers.membership.mockImplementation(async () => { f.setTime(time + 1000); return f.data.membership; });
    expect(await f.run()).toMatchObject({ state: 'denied', reason: 'session_expired' });
  });
  it.each(['expire_at', 'abandon_at'] as const)('rejects expanded-year provider %s without emitting an incompatible allow', async field => {
    const f = fixture(); f.data.session[field] = Date.parse('+010000-01-01T00:00:00Z');
    const verdict = await f.run();
    expect(verdict).toMatchObject({ state: 'unavailable', reason: 'malformed_response', providerExpiresAt: null });
    expect(NativeAuthorityVerdictSchema.safeParse(verdict).success).toBe(true);
  });
  it('keeps the supported upper provider timestamp compatible with the shared verdict', async () => {
    const f = fixture(); f.data.session.expire_at = f.data.session.abandon_at = Date.parse('9999-12-31T23:59:59.999Z');
    const verdict = await f.run();
    expect(verdict.state).toBe('allowed'); expect(NativeAuthorityVerdictSchema.safeParse(verdict).success).toBe(true);
  });
  it.each([['session', 'session_missing'], ['user', 'user_missing'], ['membership', 'organization_missing']] as const)('handles authoritative %s absence', async (resource, reason) => {
    const f = fixture(); f.readers[resource].mockRejectedValue({ status: 404, private: secretKey });
    expect(await f.run()).toMatchObject({ state: 'denied', reason, providerExpiresAt: null });
  });
  it('requires an authoritative empty filtered list before declaring membership removed', async () => {
    const f = fixture(); f.data.membership = { data: [], total_count: 0 };
    expect(await f.run()).toMatchObject({ state: 'denied', reason: 'membership_removed' });
    f.data.membership.total_count = 1;
    expect(await f.run()).toMatchObject({ state: 'unavailable', reason: 'malformed_response' });
  });
  it('rejects replacement membership and missing required role without accepting a different matching row', async () => {
    const f = fixture(); f.data.membership.data[0]!.id = 'new_membership';
    expect(await f.run()).toMatchObject({ state: 'denied', reason: 'membership_replaced' });
    f.data.membership.data.push(values().membership.data[0]!); f.data.membership.total_count = 2;
    expect(await f.run()).toMatchObject({ state: 'unavailable', reason: 'malformed_response' });
    f.data.membership = values().membership; f.data.membership.data[0]!.role = 'org:member';
    expect(await f.run()).toMatchObject({ state: 'denied', reason: 'required_role_removed' });
    expect(await f.run({ ...context, requiredRole: null })).toMatchObject({ state: 'allowed' });
  });
  it.each(['session_identity', 'session_subject', 'user_identity', 'membership_org', 'membership_subject', 'future_created', 'unknown_status', 'missing_restriction', 'impersonation'])('treats %s as malformed rather than valid authority', async change => {
    const f = fixture();
    if (change === 'session_identity') f.data.session.id = 'different';
    if (change === 'session_subject') f.data.session.user_id = 'different';
    if (change === 'user_identity') f.data.user.id = 'different';
    if (change === 'membership_org') f.data.membership.data[0]!.organization.id = 'different';
    if (change === 'membership_subject') f.data.membership.data[0]!.public_user_data.user_id = 'different';
    if (change === 'future_created') f.data.session.created_at = time + 1;
    if (change === 'unknown_status') f.data.session.status = 'invented_active';
    if (change === 'missing_restriction') f.readers.user.mockResolvedValue({ id: context.subject, banned: false, locked: false } as typeof f.data.user);
    if (change === 'impersonation') f.readers.session.mockResolvedValue({ ...f.data.session, actor: { sub: 'operator' } } as unknown as typeof f.data.session);
    expect(await f.run()).toMatchObject({ state: 'unavailable', reason: 'malformed_response' });
  });
  it.each([[401, 'provider_auth'], [403, 'provider_auth'], [429, 'rate_limited'], [500, 'provider_unavailable']] as const)('does not turn provider HTTP%s into an account revocation', async (status, reason) => {
    const f = fixture(); f.readers.membership.mockRejectedValue({ status, message: secretKey });
    const result = await f.run(); expect(result).toMatchObject({ state: 'unavailable', reason });
    expect(JSON.stringify(result)).not.toContain(secretKey);
  });
  it('does not refresh observation age after slow reads or a backwards clock', async () => {
    const f = fixture(); f.readers.membership.mockImplementation(async () => { f.setTime(time + 8000); return f.data.membership; });
    expect(await f.run()).toMatchObject({ state: 'unavailable', reason: 'deadline_exceeded' });
    const backwards = fixture(); backwards.readers.membership.mockImplementation(async () => { backwards.setTime(time - 1); return backwards.data.membership; });
    expect(await backwards.run()).toMatchObject({ state: 'unavailable', reason: 'clock_invalid' });
  });
  it('starts no reads for an invalid pin, exhausted deadline or prior cancellation', async () => {
    const f = fixture(); const controller = new AbortController(); controller.abort();
    for (const input of [{ ...context, subject: 'https://attacker.example' }, { ...context, secret: 'extra' }, { ...context, requiredRole: undefined }]) {
      expect(await f.run(input as ProviderAuthorityContext)).toMatchObject({ state: 'unavailable', reason: 'invalid_context' });
    }
    expect(await f.observe(context, { deadlineAt: time })).toMatchObject({ reason: 'deadline_exceeded' });
    expect(await f.observe(context, { deadlineAt: NaN })).toMatchObject({ reason: 'invalid_deadline' });
    expect(await f.observe(context, { deadlineAt: time + 1000, signal: controller.signal })).toMatchObject({ reason: 'cancelled' });
    for (const read of Object.values(f.readers)) expect(read).not.toHaveBeenCalled();
  });
});

describe('bounded official Clerk authority transport', () => {
  function transportFixture() {
    const data = values();
    const request = vi.fn<ProviderAuthorityFetch>(async url => json(url.pathname.includes('/sessions/') ? data.session : url.pathname.includes('/users/') ? data.user : data.membership));
    return { data, request, observe: createClerkProviderAuthorityObserver({ secretKey }, { fetch: request, now: () => time }) };
  }
  it('uses exactly three fixed authenticated GETs with official filtering, version and cancellation', async () => {
    const f = transportFixture();
    expect(await f.observe(context, { deadlineAt: time + 1000 })).toMatchObject({ state: 'allowed' });
    expect(f.request).toHaveBeenCalledTimes(3);
    const urls = f.request.mock.calls.map(([url]) => url);
    expect(urls.map(url => url.origin)).toEqual(Array(3).fill('https://api.clerk.com'));
    expect(urls[2]!.pathname).toBe('/v1/organizations/org_pinned/memberships');
    expect([...urls[2]!.searchParams.entries()]).toEqual([['user_id', 'user_pinned'], ['limit', '2']]);
    for (const [, init] of f.request.mock.calls) {
      expect(init).toMatchObject({ method: 'GET', redirect: 'error', cache: 'no-store', credentials: 'omit', signal: expect.any(AbortSignal) });
      const headers = new Headers(init.headers);
      expect(headers.get('authorization')).toBe(`Bearer ${secretKey}`); expect(headers.get('clerk-api-version')).toBe('2026-05-12');
      expect(headers.has('cookie')).toBe(false);
    }
  });
  it('keeps the captured secret when caller configuration changes', async () => {
    const f = transportFixture(), config = { secretKey };
    const observe = createClerkProviderAuthorityObserver(config, { fetch: f.request, now: () => time });
    config.secretKey = 'changed';
    expect(await observe(context, { deadlineAt: time + 1000 })).toMatchObject({ state: 'allowed' });
    expect(f.request.mock.calls.every(([, init]) => new Headers(init.headers).get('authorization') === `Bearer ${secretKey}`)).toBe(true);
  });
  it.each([401, 403, 429, 500, 302])('classifies HTTP%s without reading or leaking its private body', async status => {
    const request = vi.fn<ProviderAuthorityFetch>(async () => new Response(secretKey, { status, headers: { 'Content-Type': 'text/plain' } }));
    const result = await createClerkProviderAuthorityObserver({ secretKey }, { fetch: request, now: () => time })(context, { deadlineAt: time + 1000 });
    expect(result.state).toBe('unavailable'); expect(JSON.stringify(result)).not.toContain(secretKey); expect(request).toHaveBeenCalledTimes(3);
  });
  it.each(['oversized_declared', 'oversized_chunked', 'wrong_mime', 'invalid_json', 'invalid_utf8'])('rejects %s content within response limits', async mode => {
    let response: () => Response;
    if (mode === 'oversized_declared') response = () => new Response('{}', { headers: { 'Content-Type': 'application/json', 'Content-Length': String(providerAuthorityMaximumResponseBytes + 1) } });
    else if (mode === 'oversized_chunked') response = () => new Response(' '.repeat(providerAuthorityMaximumResponseBytes + 1), { headers: { 'Content-Type': 'application/json' } });
    else if (mode === 'wrong_mime') response = () => new Response('{}', { headers: { 'Content-Type': 'text/html' } });
    else if (mode === 'invalid_utf8') response = () => new Response(new Uint8Array([0xff]), { headers: { 'Content-Type': 'application/json' } });
    else response = () => new Response('{private invalid', { headers: { 'Content-Type': 'application/json' } });
    const request = vi.fn<ProviderAuthorityFetch>(async () => response());
    expect(await createClerkProviderAuthorityObserver({ secretKey }, { fetch: request, now: () => time })(context, { deadlineAt: time + 1000 }))
      .toMatchObject({ state: 'unavailable', reason: 'malformed_response' });
  });
  it('aborts the actual transport signal at the absolute deadline even if transport never settles', async () => {
    vi.useFakeTimers(); vi.setSystemTime(time);
    const request = vi.fn<ProviderAuthorityFetch>(() => new Promise(() => {}));
    const pending = createClerkProviderAuthorityObserver({ secretKey }, { fetch: request })(context, { deadlineAt: time + 150 });
    await vi.advanceTimersByTimeAsync(150);
    expect(await pending).toMatchObject({ state: 'unavailable', reason: 'deadline_exceeded' });
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls.every(([, init]) => init.signal?.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('caps an overlong caller deadline at eight seconds and never retries HTTP calls', async () => {
    vi.useFakeTimers(); vi.setSystemTime(time);
    const request = vi.fn<ProviderAuthorityFetch>(() => new Promise(() => {}));
    const pending = createClerkProviderAuthorityObserver({ secretKey }, { fetch: request })(context, { deadlineAt: time + 60_000 });
    await vi.advanceTimersByTimeAsync(8000);
    expect(await pending).toMatchObject({ state: 'unavailable', reason: 'deadline_exceeded' });
    expect(request).toHaveBeenCalledTimes(3); expect(vi.getTimerCount()).toBe(0);
  });
  it('cancels stalled response-body reads when the parent aborts', async () => {
    vi.useFakeTimers(); vi.setSystemTime(time); const controller = new AbortController(); const cancels: string[] = [];
    const request = vi.fn<ProviderAuthorityFetch>(async url => new Response(new ReadableStream({ cancel() { cancels.push(url.pathname); } }), { headers: { 'Content-Type': 'application/json' } }));
    const pending = createClerkProviderAuthorityObserver({ secretKey }, { fetch: request })(context, { ...options(), signal: controller.signal });
    await vi.advanceTimersByTimeAsync(1); controller.abort();
    expect(await pending).toMatchObject({ state: 'unavailable', reason: 'cancelled' });
    expect(cancels).toHaveLength(3); expect(request.mock.calls.every(([, init]) => init.signal?.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not start transport for invalid context or a cancelled request', async () => {
    const f = transportFixture(); const controller = new AbortController(); controller.abort();
    expect(await f.observe(context, { deadlineAt: time + 1000, signal: controller.signal })).toMatchObject({ reason: 'cancelled' });
    expect(await f.observe({ ...context, externalOrganizationId: '../users' }, { deadlineAt: time + 1000 })).toMatchObject({ reason: 'invalid_context' });
    expect(f.request).not.toHaveBeenCalled();
  });
});
