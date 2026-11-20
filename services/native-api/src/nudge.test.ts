import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendNativeExecutionNudge, sendNativeExecutionNudgeWithRecovery } from './nudge.js';

const origin = 'https://pactwoven-native.vercel.app';
const workloadToken = 'header.payload.signature';
function fixture() {
  const token = vi.fn(async () => workloadToken);
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 202 }));
  return { token, fetch, now: () => Date.now() };
}
afterEach(() => vi.useRealTimers());

describe('bodyless native execution wake-up', () => {
  it('uses only platform identity, a fixed configured path and no request payload', async () => {
    const deps = fixture();
    await sendNativeExecutionNudge(origin, Date.now() + 60_000, deps);
    expect(deps.token).toHaveBeenCalledExactlyOnceWith(); expect(deps.fetch).toHaveBeenCalledOnce();
    const [url, init] = deps.fetch.mock.calls[0]!;
    expect(String(url)).toBe(origin + '/internal/nudge');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${workloadToken}`, 'x-vercel-trusted-oidc-idp-token': workloadToken } });
    expect(Object.hasOwn(init!, 'body')).toBe(false);
    expect(Object.keys(init!.headers!)).toEqual(['Authorization', 'x-vercel-trusted-oidc-idp-token']);
  });
  it.each([200, 204, 301, 302, 401, 403, 503])('does not treat status %s as confirmed acceptance or retry it', async status => {
    const deps = fixture(); deps.fetch.mockResolvedValueOnce(new Response(null, { status }));
    await expect(sendNativeExecutionNudge(origin, Date.now() + 60_000, deps)).rejects.toThrow('not confirmed');
    expect(deps.fetch).toHaveBeenCalledOnce();
  });
  it('bounds a stalled token read and never issues a late HTTP request', async () => {
    vi.useFakeTimers(); const deps = fixture();
    let finish!: (value: string) => void;
    deps.token.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const result = sendNativeExecutionNudge(origin, Date.now() + 60_000, deps);
    const assertion = expect(result).rejects.toThrow('not confirmed');
    await vi.advanceTimersByTimeAsync(4_000); await assertion;
    finish(workloadToken); await vi.runAllTimersAsync();
    expect(deps.fetch).not.toHaveBeenCalled();
  });
  it('aborts a stalled network call within the same total budget without retry', async () => {
    vi.useFakeTimers(); const deps = fixture();
    deps.fetch.mockImplementationOnce(async () => new Promise<Response>(() => {}));
    const result = sendNativeExecutionNudge(origin, Date.now() + 60_000, deps);
    const assertion = expect(result).rejects.toThrow('not confirmed');
    await vi.advanceTimersByTimeAsync(4_000); await assertion;
    expect(deps.fetch).toHaveBeenCalledOnce(); expect(deps.fetch.mock.calls[0]![1]!.signal!.aborted).toBe(true);
  });
  it('shares its budget between OIDC and the HTTP request', async () => {
    vi.useFakeTimers(); const deps = fixture();
    deps.token.mockImplementationOnce(async () => { await new Promise(resolve => setTimeout(resolve, 3_000)); return workloadToken; });
    deps.fetch.mockImplementationOnce(async () => new Promise<Response>(() => {}));
    const result = sendNativeExecutionNudge(origin, Date.now() + 60_000, deps);
    const assertion = expect(result).rejects.toThrow('not confirmed');
    await vi.advanceTimersByTimeAsync(3_000); expect(deps.fetch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_000); await assertion;
    expect(deps.fetch.mock.calls[0]![1]!.signal!.aborted).toBe(true);
  });
  it('respects the remaining function deadline and avoids work after it expires', async () => {
    const deps = fixture();
    for (const deadline of [Date.now(), Number.NaN, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY]) {
      await expect(sendNativeExecutionNudge(origin, deadline, deps)).rejects.toThrow('not confirmed');
    }
    expect(deps.token).not.toHaveBeenCalled(); expect(deps.fetch).not.toHaveBeenCalled();
    vi.useFakeTimers(); deps.fetch.mockImplementationOnce(async () => new Promise<Response>(() => {}));
    const result = sendNativeExecutionNudge(origin, Date.now() + 500, deps);
    const assertion = expect(result).rejects.toThrow('not confirmed');
    await vi.advanceTimersByTimeAsync(400); await assertion;
    expect(deps.fetch.mock.calls[0]![1]!.signal!.aborted).toBe(true);
  });
  it('rejects malformed tokens and untrusted destinations before sending credentials', async () => {
    const deps = fixture();
    await expect(sendNativeExecutionNudge('https://other.example', Date.now() + 60_000, deps)).rejects.toThrow('not configured');
    expect(deps.token).not.toHaveBeenCalled();
    for (const token of ['', 'invalid', 'header.payload.signature\r\nInjected: true', 'a'.repeat(16_385)]) {
      deps.token.mockResolvedValueOnce(token);
      await expect(sendNativeExecutionNudge(origin, Date.now() + 60_000, deps)).rejects.toThrow('not confirmed');
    }
    expect(deps.fetch).not.toHaveBeenCalled();
  });
  it('sanitizes token and network failures without exposing credentials or reissuing work', async () => {
    const deps = fixture(); deps.token.mockRejectedValueOnce(Error('private-token-value'));
    const tokenError = await sendNativeExecutionNudge(origin, Date.now() + 60_000, deps).catch(error => String(error));
    expect(tokenError).not.toContain('private-token-value'); expect(deps.fetch).not.toHaveBeenCalled();
    deps.fetch.mockRejectedValueOnce(Error('private-network-value'));
    const networkError = await sendNativeExecutionNudge(origin, Date.now() + 60_000, deps).catch(error => String(error));
    expect(networkError).not.toContain('private-network-value'); expect(deps.fetch).toHaveBeenCalledOnce();
  });
});


describe('bounded recovery of an idempotent outbox wake', () => {
  it('recovers one failed initial wake without reissuing the user command',async()=>{
    vi.useFakeTimers();const deps=fixture();deps.fetch.mockRejectedValueOnce(Error('lost request'));
    const promise=sendNativeExecutionNudgeWithRecovery(origin,Date.now()+60_000,deps);
    await vi.advanceTimersByTimeAsync(250);await promise;
    expect(deps.fetch).toHaveBeenCalledTimes(2);
    for(const [url,options] of deps.fetch.mock.calls){expect(String(url)).toBe(origin+'/internal/nudge');expect(options).not.toHaveProperty('body');}
  });
  it('retries a missing acknowledgement with a fresh workload token and stops after acceptance',async()=>{
    vi.useFakeTimers();const deps=fixture();deps.fetch.mockImplementationOnce(async()=>new Promise<Response>(()=>{}));
    const promise=sendNativeExecutionNudgeWithRecovery(origin,Date.now()+60_000,deps);
    await vi.advanceTimersByTimeAsync(4250);await promise;
    expect(deps.fetch).toHaveBeenCalledTimes(2);expect(deps.token).toHaveBeenCalledTimes(2);
    expect(deps.fetch.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);expect(deps.fetch).toHaveBeenCalledTimes(2);
  });
  it('bounds prolonged failure to three attempts without extending the deadline',async()=>{
    vi.useFakeTimers();const deps=fixture();deps.fetch.mockImplementation(async()=>new Promise<Response>(()=>{}));
    const promise=sendNativeExecutionNudgeWithRecovery(origin,Date.now()+60_000,deps);
    const assertion=expect(promise).rejects.toThrow('not confirmed');
    await vi.advanceTimersByTimeAsync(13_000);await assertion;expect(deps.fetch).toHaveBeenCalledTimes(3);
    expect(deps.fetch.mock.calls.every(([,options])=>options!.signal!.aborted)).toBe(true);
  });
  it('never starts a retry after the original deadline and does not leak late token reads',async()=>{
    vi.useFakeTimers();const deps=fixture();let finish!:(v:string)=>void;
    deps.token.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve}));
    const promise=sendNativeExecutionNudgeWithRecovery(origin,Date.now()+500,deps);
    const assertion=expect(promise).rejects.toThrow('not confirmed');
    await vi.advanceTimersByTimeAsync(400);await assertion;
    finish(workloadToken);await vi.advanceTimersByTimeAsync(10_000);
    expect(deps.fetch).not.toHaveBeenCalled();expect(deps.token).toHaveBeenCalledOnce();
  });
});
