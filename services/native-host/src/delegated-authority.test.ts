import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NativeAuthorityResult, NativeDelegatedAuthorityTarget } from '@pactwoven/contracts';
import { createNativeDelegatedAuthorityClient } from './delegated-authority.js';

const at = Date.parse('2026-11-18T12:00:00Z');
const timestamp = new Date(at).toISOString();
const target: NativeDelegatedAuthorityTarget = { organizationId: 'org-one', taskId: 'task-one', generation: 1 };
const credential = 'synthetic.workload.token';
const allowed = (start = Date.now()): NativeAuthorityResult => ({ state: 'allowed', observedAt: new Date(start).toISOString(), validUntil: new Date(start + 20_000).toISOString() });
const unavailable: NativeAuthorityResult = { state: 'unavailable', observedAt: null, validUntil: null, retryAfterMilliseconds: 1300 };
const response = (result = allowed(), value = target) => Response.json({ schemaVersion: 1, target: value, result });
const deadline = () => Date.now() + 300_000;
function clock() { vi.useFakeTimers(); vi.setSystemTime(at); }
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('bounded reverse authority client', () => {
  it('uses the fixed API route, one workload token and a snapshotted exact target', async () => {
    clock(); const token = vi.fn(async () => credential), request = vi.fn<typeof fetch>(async () => response());
    const input = { ...target }, observe = createNativeDelegatedAuthorityClient('https://native-api.vercel.app', { token, fetch: request });
    const pending = observe(input, { deadlineAt: deadline() }); input.organizationId = 'changed'; input.generation++;
    expect(await pending).toEqual({ result: allowed(), usableUntil: at + 20_000 });
    expect(token).toHaveBeenCalledOnce(); expect(request).toHaveBeenCalledOnce();
    const [url, init] = request.mock.calls[0]!;
    expect(String(url)).toBe('https://native-api.vercel.app/internal/native-delegated-authority');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', cache: 'no-store', credentials: 'omit', signal: expect.any(AbortSignal) });
    expect(new Headers(init!.headers).get('authorization')).toBe(`Bearer ${credential}`);
    expect(new Headers(init!.headers).get('x-vercel-trusted-oidc-idp-token')).toBe(credential);
    expect(JSON.parse(String(init!.body))).toEqual({ schemaVersion: 1, target });
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['http://native.vercel.app', 'https://evil.test', 'https://a.vercel.app.evil.test', 'https://a.b.vercel.app',
    'https://a.vercel.app/path', 'https://a.vercel.app?token=x', 'https://a.vercel.app#x', 'https://user@a.vercel.app', 'https://a.vercel.app:444'])('rejects unsafe configured origin %s', value => {
    expect(() => createNativeDelegatedAuthorityClient(value)).toThrow('authority');
  });
  it('starts no token or network operation for invalid target, prior cancellation or an exhausted deadline', async () => {
    clock(); const token = vi.fn(), request = vi.fn(), cancelled = new AbortController(); cancelled.abort();
    const observe = createNativeDelegatedAuthorityClient('https://native-api.vercel.app', { token, fetch: request });
    for (const value of [{ ...target, subject: 'injected' }, { ...target, generation: 0 }]) {
      expect((await observe(value, { deadlineAt: deadline() })).result.state).toBe('unavailable');
    }
    expect((await observe(target, { deadlineAt: at })).result.state).toBe('unavailable');
    expect((await observe(target, { deadlineAt: NaN })).result.state).toBe('unavailable');
    expect((await observe(target, { deadlineAt: deadline(), signal: cancelled.signal })).result.state).toBe('unavailable');
    expect(token).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
  });
  it.each(['private non-token', 'a.b.c\nsecret', 'a'.repeat(16_385)])('does not send malformed or oversized platform credentials', async value => {
    clock(); const request = vi.fn();
    expect((await createNativeDelegatedAuthorityClient('https://native-api.vercel.app', { token: async () => value, fetch: request })(target, { deadlineAt: deadline() })).result.state).toBe('unavailable');
    expect(request).not.toHaveBeenCalled();
  });
  it('bounds late OIDC acquisition without issuing a request after timeout', async () => {
    clock(); let finish!: (value: string) => void;
    const request = vi.fn(), token = () => new Promise<string>(resolve => { finish = resolve; });
    const pending = createNativeDelegatedAuthorityClient('https://native-api.vercel.app', { token, fetch: request })(target, { deadlineAt: deadline() });
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await pending).result.state).toBe('unavailable'); finish(credential); await Promise.resolve();
    expect(request).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('shares the original ten-second budget across token and actual network cancellation', async () => {
    clock(); const token = () => new Promise<string>(resolve => setTimeout(() => resolve(credential), 8000));
    const request = vi.fn<typeof fetch>(() => new Promise(() => {}));
    const pending = createNativeDelegatedAuthorityClient('https://native-api.vercel.app', { token, fetch: request })(target, { deadlineAt: deadline() });
    await vi.advanceTimersByTimeAsync(9999); expect(request).toHaveBeenCalledOnce(); expect(request.mock.calls[0]![1]!.signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1); expect((await pending).result.state).toBe('unavailable');
    expect(request.mock.calls[0]![1]!.signal!.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });
  it('cancels a stalled response body on the parent signal', async () => {
    clock(); const parent = new AbortController(), cancel = vi.fn();
    const request = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({ cancel }), { headers: { 'Content-Type': 'application/json' } }));
    const pending = createNativeDelegatedAuthorityClient('https://native-api.vercel.app', { token: async () => credential, fetch: request })(target, { deadlineAt: deadline(), signal: parent.signal });
    await vi.advanceTimersByTimeAsync(1); parent.abort();
    expect((await pending).result.state).toBe('unavailable'); expect(cancel).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]![1]!.signal!.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });
  it.each([401, 403, 429, 500, 302])('treats HTTP %s as unavailable and exposes no private error', async status => {
    clock(); const request = vi.fn<typeof fetch>(async () => new Response('private-provider-secret', { status }));
    const result = await createNativeDelegatedAuthorityClient('https://native-api.vercel.app', { token: async () => credential, fetch: request })(target, { deadlineAt: deadline() });
    expect(result.result.state).toBe('unavailable'); expect(JSON.stringify(result)).not.toContain('private'); expect(request).toHaveBeenCalledOnce();
  });
  it.each(['declared_large', 'stream_large', 'wrong_mime', 'invalid_json', 'invalid_utf8', 'extra_field', 'too_long', 'expired'])('rejects %s response', async mode => {
    clock(); let value: Response;
    if (mode === 'declared_large') value = new Response('{}', { headers: { 'Content-Type': 'application/json', 'Content-Length': '8193' } });
    else if (mode === 'stream_large') value = new Response(' '.repeat(8193), { headers: { 'Content-Type': 'application/json' } });
    else if (mode === 'wrong_mime') value = new Response('{}', { headers: { 'Content-Type': 'text/html' } });
    else if (mode === 'invalid_json') value = new Response('private-invalid', { headers: { 'Content-Type': 'application/json' } });
    else if (mode === 'invalid_utf8') value = new Response(new Uint8Array([255]), { headers: { 'Content-Type': 'application/json' } });
    else if (mode === 'extra_field') value = Response.json({ schemaVersion: 1, target, result: allowed(), secret: 'private' });
    else if (mode === 'too_long') value = response({ ...allowed(), validUntil: new Date(at + 20_001).toISOString() });
    else value = response(allowed(at - 30_000));
    const result = await createNativeDelegatedAuthorityClient('https://native-api.vercel.app', { token: async () => credential, fetch: async () => value })(target, { deadlineAt: deadline() });
    expect(result.result.state).toBe('unavailable');
  });
  it.each(['organizationId', 'taskId', 'generation'] as const)('rejects another %s in the authority response', async field => {
    clock(); const changed = { ...target, [field]: field === 'generation' ? 2 : 'other' } as NativeDelegatedAuthorityTarget;
    const result = await createNativeDelegatedAuthorityClient('https://native-api.vercel.app', { token: async () => credential, fetch: async () => response(allowed(), changed) })(target, { deadlineAt: deadline() });
    expect(result.result.state).toBe('unavailable');
  });
  it('starts conservative validity before the request and subtracts elapsed time despite a DB clock ahead', async () => {
    clock(); const observed = allowed(at + 60_000);
    const request = async () => { await new Promise(resolve => setTimeout(resolve, 3000)); return response(observed); };
    const pending = createNativeDelegatedAuthorityClient('https://native-api.vercel.app', { token: async () => credential, fetch: request })(target, { deadlineAt: deadline() });
    await vi.advanceTimersByTimeAsync(3000);
    expect(await pending).toEqual({ result: observed, usableUntil: at + 20_000 });
  });
  it('preserves explicit denied/stale/unavailable semantics without inventing a proof', async () => {
    clock();
    for (const state of ['denied', 'stale', 'unavailable'] as const) {
      const result = { state, observedAt: null, validUntil: null };
      expect(await createNativeDelegatedAuthorityClient('https://native-api.vercel.app', { token: async () => credential, fetch: async () => response(result) })(target, { deadlineAt: deadline() }))
        .toEqual({ result, usableUntil: null });
    }
  });
});

