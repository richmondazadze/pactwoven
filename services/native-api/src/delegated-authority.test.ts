import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NativeDelegatedAuthorityPrepare as NativeAuthorityPrepareResult, NativeDelegatedAuthorityVerdict as NativeAuthorityVerdict } from '@pactwoven/contracts';
import { createNativeDelegatedAuthorityHandler as createNativeAuthorityHandler, type NativeDelegatedAuthorityResources as NativeAuthorityResources } from './delegated-authority.js';
import { createNativeHttpHandler } from './http.js';

const target = { organizationId: 'organization_a', taskId: 'task_a', generation: 1 };
const issuer = 'https://pactwoven-fixture.clerk.accounts.dev';
const context = { subject: 'user_private', externalOrganizationId: 'org_private',
  externalMembershipId: 'orgmem_private', requiredRole: null };
const nonce = 'd4e03f81-b2f5-4d87-bd48-3a0e4c8b6d35';
function setup() {
  const start = Date.now();
  const prepared: NativeAuthorityPrepareResult = { kind: 'prepared', nonce, target, providerIssuer: issuer,
    preparedAt: new Date(start).toISOString(), deadlineAt: new Date(start + 8000).toISOString(), context };
  const verdict: NativeAuthorityVerdict = { state: 'allowed', reason: 'current', observationStartedAt: new Date(start).toISOString(),
    observationCompletedAt: new Date(start + 100).toISOString() };
  const allowed = { state: 'allowed' as const, observedAt: new Date(start).toISOString(), validUntil: new Date(start + 20_000).toISOString() };
  const order: string[] = [];
  const prepare = vi.fn(async (): Promise<NativeAuthorityPrepareResult> => { order.push('prepare'); return prepared; });
  const observe = vi.fn<NativeAuthorityResources['observe']>(async () => { order.push('observe'); return verdict; });
  const finish = vi.fn(async () => { order.push('finish'); return allowed; });
  const verify = vi.fn(async () => { order.push('verify'); return true; });
  const resources = vi.fn(async () => { order.push('resources'); return { repository: { prepare, finish }, issuer, observe }; });
  const dependencies = { verify, resources, deadlineAt: start + 60_000 };
  return { prepared, verdict, allowed, prepare, observe, finish, verify, resources, dependencies, order };
}
function request(body: unknown = { schemaVersion: 1, target }, options: RequestInit = {}) {
  return new Request('https://pactwoven-native-api.vercel.app/internal/native-delegated-authority', {
    method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer workload' },
    body: JSON.stringify(body), ...options,
  });
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('executor-to-API provider authority', () => {
  it('observes only the private prepared context and returns the database-bound result', async () => {
    const s = setup();
    const response = await createNativeAuthorityHandler(s.dependencies)(request());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ schemaVersion: 1, target, result: s.allowed });
    expect(s.order).toEqual(['verify', 'resources', 'prepare', 'observe', 'finish']);
    expect(s.prepare).toHaveBeenCalledWith(target, issuer);
    expect(s.observe.mock.calls[0]?.[0]).toEqual(context);
    expect(s.finish).toHaveBeenCalledWith(nonce, s.verdict);
    expect(JSON.stringify(body)).not.toMatch(/sess_private|orgmem_private|user_private|providerExpiresAt|nonce|secret/);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });
  it('rejects caller identity, endpoint, nonce and verdict fields before DB or provider access', async () => {
    const s = setup(), handler = createNativeAuthorityHandler(s.dependencies);
    for (const extra of [{ context }, { nonce }, { issuer: 'https://evil.test' }, { result: s.allowed },
      { callback: 'https://evil.test' }, { secretKey: 'caller-key' }]) {
      expect((await handler(request({ schemaVersion: 1, target, ...extra }))).status).toBe(400);
    }
    expect((await handler(request({ schemaVersion: 1, target: { ...target, environment: 'other' } }))).status).toBe(400);
    expect(s.resources).not.toHaveBeenCalled(); expect(s.observe).not.toHaveBeenCalled();
  });
  it('authenticates before consuming a stream or loading credentials', async () => {
    const s = setup(); s.verify.mockResolvedValue(false);
    const cancel = vi.fn(); const stream = new ReadableStream({ cancel });
    const response = await createNativeAuthorityHandler(s.dependencies)(request(undefined,
      { body: stream, duplex: 'half' } as RequestInit & { duplex: 'half' }));
    expect(response.status).toBe(401); expect(cancel).not.toHaveBeenCalled();
    expect(s.resources).not.toHaveBeenCalled();
  });
  it('rejects methods and query/path confusion before verification', async () => {
    const s = setup(), handler = createNativeAuthorityHandler(s.dependencies);
    expect((await handler(new Request('https://api.test/internal/native-delegated-authority'))).status).toBe(405);
    for (const path of ['/internal/native-delegated-authority?task=x', '/internal/native-delegated-authority/', '/internal/nudge']) {
      expect((await handler(new Request(`https://api.test${path}`, { method: 'POST' }))).status).toBe(404);
    }
    expect(s.verify).not.toHaveBeenCalled();
  });
  it('bounds declared and streamed bodies and rejects invalid JSON or encoding', async () => {
    const s = setup(), handler = createNativeAuthorityHandler(s.dependencies);
    for (const headers of [{ 'content-type': 'text/plain' }, { 'content-type': 'application/json', 'content-encoding': 'gzip' }]) {
      expect((await handler(request(undefined, { headers }))).status).toBe(400);
    }
    expect((await handler(request(undefined, { headers: { 'content-type': 'application/json', 'content-length': '8193' } }))).status).toBe(413);
    expect((await handler(request(undefined, { body: ' '.repeat(8193) }))).status).toBe(413);
    expect((await handler(request(undefined, { body: 'not json' }))).status).toBe(400);
    const invalid = new Uint8Array([0xff]);
    expect((await handler(request(undefined, { body: invalid }))).status).toBe(400);
    expect(s.resources).not.toHaveBeenCalled();
  });
  it('bounds endless empty chunks so they cannot starve timeout processing', async () => {
    const s = setup(); const cancel = vi.fn();
    const stream = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array()); }, cancel });
    expect((await createNativeAuthorityHandler(s.dependencies)(request(undefined,
      { body: stream, duplex: 'half' } as RequestInit & { duplex: 'half' }))).status).toBe(413);
    expect(cancel).toHaveBeenCalledOnce(); expect(s.resources).not.toHaveBeenCalled();
  });
  it('coalesces pending work without a second provider observation', async () => {
    const s = setup(); s.prepare.mockResolvedValue({ kind: 'pending', retryAfterMilliseconds: 1000 });
    const response = await createNativeAuthorityHandler(s.dependencies)(request());
    expect(await response.json()).toEqual({ schemaVersion: 1, target,
      result: { state: 'unavailable', observedAt: null, validUntil: null, retryAfterMilliseconds: 1000 } });
    expect(s.observe).not.toHaveBeenCalled(); expect(s.finish).not.toHaveBeenCalled();
  });
  it('returns a stale/denied settled task without reviving it or consulting the provider', async () => {
    const s = setup();
    s.prepare.mockResolvedValue({ kind: 'settled', result: { state: 'stale' } });
    expect((await (await createNativeAuthorityHandler(s.dependencies)(request())).json()).result).toEqual({ state: 'stale', observedAt: null, validUntil: null });
    expect(s.observe).not.toHaveBeenCalled(); expect(s.finish).not.toHaveBeenCalled();
  });
  it('rejects changed target/issuer from preparation without provider calls', async () => {
    const s = setup();
    if (s.prepared.kind !== 'prepared') throw Error('fixture');
    for (const change of [{ target: { ...target, generation: 2 } }, { providerIssuer: 'https://other.clerk.accounts.dev' }]) {
      s.prepare.mockResolvedValue({ ...s.prepared, ...change });
      expect((await createNativeAuthorityHandler(s.dependencies)(request())).status).toBe(503);
    }
    expect(s.observe).not.toHaveBeenCalled();
  });
  it('does not publish an allow when finishing has an unknown outcome or malformed result', async () => {
    const s = setup(); s.finish.mockRejectedValue(Error('private database/credential data'));
    const response = await createNativeAuthorityHandler(s.dependencies)(request());
    expect(response.status).toBe(503); expect(await response.text()).toBe('');
    s.finish.mockResolvedValue({ ...s.allowed, validUntil: new Date(Date.now() + 120_000).toISOString() });
    expect((await createNativeAuthorityHandler(s.dependencies)(request())).status).toBe(503);
  });
  it('rejects malformed observation rather than handing it to the database', async () => {
    const s = setup(); s.observe.mockResolvedValue({ ...s.verdict, reason: 'network' });
    expect((await createNativeAuthorityHandler(s.dependencies)(request())).status).toBe(503);
    expect(s.finish).not.toHaveBeenCalled();
  });
  it('counts slow preparation against the observation budget without comparing host clocks', async () => {
    const s = setup(); let clock = Date.now(); const before = clock;
    if (s.prepared.kind !== 'prepared') throw Error('fixture');
    s.prepared.preparedAt = new Date(before + 60_000).toISOString();
    s.prepared.deadlineAt = new Date(before + 68_000).toISOString();
    s.prepare.mockImplementation(async () => { clock += 5000; return s.prepared; });
    await createNativeAuthorityHandler({ ...s.dependencies, now: () => clock })(request());
    expect(s.observe.mock.calls[0]?.[1]).toMatchObject({ deadlineAt: before + 7900 });
  });
  it('does not begin a provider call when preparation used its entire window', async () => {
    const s = setup(); let clock = Date.now();
    s.prepare.mockImplementation(async () => { clock += 8000; return s.prepared; });
    const response = await createNativeAuthorityHandler({ ...s.dependencies, now: () => clock })(request());
    expect((await response.json()).result.state).toBe('unavailable');
    expect(s.observe).not.toHaveBeenCalled(); expect(s.finish).not.toHaveBeenCalled();
  });
  it('a late authentication result cannot initialize resources after timeout', async () => {
    vi.useFakeTimers(); const s = setup(); let release!: (value: boolean) => void;
    s.verify.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const pending = createNativeAuthorityHandler({ ...s.dependencies, deadlineAt: Date.now() + 1100 })(request());
    await vi.advanceTimersByTimeAsync(1000); expect((await pending).status).toBe(503);
    release(true); await vi.advanceTimersByTimeAsync(0); expect(s.resources).not.toHaveBeenCalled();
  });
  it('a late DB preparation cannot start observation after the caller disconnects', async () => {
    const s = setup(); const controller = new AbortController(); let release!: (value: NativeAuthorityPrepareResult) => void;
    s.prepare.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const pending = createNativeAuthorityHandler(s.dependencies)(request(undefined, { signal: controller.signal }));
    await vi.waitFor(() => expect(s.prepare).toHaveBeenCalledOnce()); controller.abort();
    expect((await pending).status).toBe(503); release(s.prepared); await Promise.resolve();
    expect(s.observe).not.toHaveBeenCalled(); expect(s.finish).not.toHaveBeenCalled();
  });
  it('aborts in-flight observation on timeout and does not begin a late finish', async () => {
    vi.useFakeTimers(); const s = setup(); let signal: AbortSignal | undefined;
    let release!: (value: NativeAuthorityVerdict) => void;
    s.observe.mockImplementation(async (_context, options) => { signal = options.signal; return new Promise(resolve => { release = resolve; }); });
    const pending = createNativeAuthorityHandler({ ...s.dependencies, deadlineAt: Date.now() + 1100 })(request());
    await vi.advanceTimersByTimeAsync(1000); expect((await pending).status).toBe(503); expect(signal?.aborted).toBe(true);
    release(s.verdict); await vi.advanceTimersByTimeAsync(0); expect(s.finish).not.toHaveBeenCalled();
  });
  it('does not allow a session-shaped context or session verdict in this protocol', async () => {
    const s = setup();
    if (s.prepared.kind !== 'prepared') throw Error('fixture');
    const prepared = { ...s.prepared, context: { ...context, sessionId: 'session_old' } };
    s.prepare.mockResolvedValue(prepared);
    expect((await createNativeAuthorityHandler(s.dependencies)(request())).status).toBe(503);
    expect(s.observe).not.toHaveBeenCalled();
    s.prepare.mockResolvedValue(s.prepared);
    s.observe.mockResolvedValue({ ...s.verdict, state: 'denied', reason: 'session_expired' });
    expect((await createNativeAuthorityHandler(s.dependencies)(request())).status).toBe(503);
    expect(s.finish).not.toHaveBeenCalled();
  });
  it.each(['organizationId', 'taskId', 'generation'] as const)('rejects changed prepared %s', async field => {
    const s = setup();
    if (s.prepared.kind !== 'prepared') throw Error('fixture');
    s.prepare.mockResolvedValue({ ...s.prepared, target: { ...target, [field]: field === 'generation' ? 2 : 'foreign' } });
    expect((await createNativeAuthorityHandler(s.dependencies)(request())).status).toBe(503);
    expect(s.observe).not.toHaveBeenCalled();
  });
  it('rejects an overlong prepared window', async () => {
    const s = setup();
    if (s.prepared.kind !== 'prepared') throw Error('fixture');
    s.prepare.mockResolvedValue({ ...s.prepared, deadlineAt: new Date(Date.parse(s.prepared.preparedAt) + 8001).toISOString() });
    expect((await createNativeAuthorityHandler(s.dependencies)(request())).status).toBe(503);
    expect(s.observe).not.toHaveBeenCalled();
  });
  it('rejects local clock rollback without publishing the observation', async () => {
    const s = setup(); let time = Date.now();
    s.observe.mockImplementation(async () => { time -= 1; return s.verdict; });
    expect((await createNativeAuthorityHandler({ ...s.dependencies, now: () => time })(request())).status).toBe(503);
    expect(s.finish).not.toHaveBeenCalled();
  });
  it('rejects an observation that ignores its shorter deadline', async () => {
    const s = setup(); let time = Date.now();
    s.observe.mockImplementation(async () => { time += 8000; return s.verdict; });
    expect((await createNativeAuthorityHandler({ ...s.dependencies, now: () => time })(request())).status).toBe(503);
    expect(s.finish).not.toHaveBeenCalled();
  });
  it('routes v2 proof requests without initializing v1 or scheduling execution', async () => {
    const s = setup(), app = vi.fn(), authority = vi.fn(), nudge = vi.fn(), defer = vi.fn();
    const handler = createNativeHttpHandler({ app, authority, nudge, defer, delegatedAuthority: createNativeAuthorityHandler(s.dependencies) });
    expect((await handler(request())).status).toBe(200);
    expect(app).not.toHaveBeenCalled(); expect(authority).not.toHaveBeenCalled();
    expect(nudge).not.toHaveBeenCalled(); expect(defer).not.toHaveBeenCalled();
    expect((await createNativeHttpHandler({ app, nudge, defer })(request())).status).toBe(503);
  });
});
