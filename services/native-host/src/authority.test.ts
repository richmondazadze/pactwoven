import { afterEach, describe, expect, it, vi } from 'vitest';
import { NativeCoordinator } from '@pactwoven/coordinator';
import type { NativeAuthorityResult, NativeDispatchClaim, NativeDispatchMessage, NativeDispatchWorkerRepository,
  NativeTaskClaim, NativeTaskProgress, NativeTaskWorkerRepository } from '@pactwoven/contracts';
import { createAuthorityBoundRepositories, createNativeAuthorityClient, type NativeAuthorityClient } from './authority.js';
import { consumeNativeDispatch, NativeDeliveryRetry } from './consume.js';

const at = Date.parse('2026-11-18T12:00:00Z');
const timestamp = new Date(at).toISOString();
const dispatch: NativeDispatchMessage = { schemaVersion: 1, engineRevision: 'native-advice-v1', environment: 'development', organizationId: 'org-one', taskId: 'task-one', generation: 1 };
const credential = 'synthetic.workload.token';
const allowed = (start = Date.now()): NativeAuthorityResult => ({ state: 'allowed', observedAt: new Date(start).toISOString(), validUntil: new Date(start + 20_000).toISOString() });
const unavailable: NativeAuthorityResult = { state: 'unavailable', observedAt: null, validUntil: null, retryAfterMilliseconds: 1300 };
const response = (result = allowed(), value = dispatch) => Response.json({ schemaVersion: 1, dispatch: value, result });
const deadline = () => Date.now() + 300_000;
function clock() { vi.useFakeTimers(); vi.setSystemTime(at); }
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('bounded reverse authority client', () => {
  it('uses the fixed API route, one workload token and a snapshotted exact dispatch', async () => {
    clock(); const token = vi.fn(async () => credential), request = vi.fn<typeof fetch>(async () => response());
    const input = { ...dispatch }, observe = createNativeAuthorityClient('https://native-api.vercel.app', { token, fetch: request });
    const pending = observe(input, { deadlineAt: deadline() }); input.organizationId = 'changed'; input.generation++;
    expect(await pending).toEqual({ result: allowed(), usableUntil: at + 20_000 });
    expect(token).toHaveBeenCalledOnce(); expect(request).toHaveBeenCalledOnce();
    const [url, init] = request.mock.calls[0]!;
    expect(String(url)).toBe('https://native-api.vercel.app/internal/native-authority');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', cache: 'no-store', credentials: 'omit', signal: expect.any(AbortSignal) });
    expect(new Headers(init!.headers).get('authorization')).toBe(`Bearer ${credential}`);
    expect(new Headers(init!.headers).get('x-vercel-trusted-oidc-idp-token')).toBe(credential);
    expect(JSON.parse(String(init!.body))).toEqual({ schemaVersion: 1, dispatch });
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['http://native.vercel.app', 'https://evil.test', 'https://a.vercel.app.evil.test', 'https://a.b.vercel.app',
    'https://a.vercel.app/path', 'https://a.vercel.app?token=x', 'https://a.vercel.app#x', 'https://user@a.vercel.app', 'https://a.vercel.app:444'])('rejects unsafe configured origin %s', value => {
    expect(() => createNativeAuthorityClient(value)).toThrow('authority');
  });
  it('starts no token or network operation for invalid dispatch, prior cancellation or an exhausted deadline', async () => {
    clock(); const token = vi.fn(), request = vi.fn(), cancelled = new AbortController(); cancelled.abort();
    const observe = createNativeAuthorityClient('https://native-api.vercel.app', { token, fetch: request });
    for (const value of [{ ...dispatch, subject: 'injected' }, { ...dispatch, generation: 0 }]) {
      expect((await observe(value, { deadlineAt: deadline() })).result.state).toBe('unavailable');
    }
    expect((await observe(dispatch, { deadlineAt: at })).result.state).toBe('unavailable');
    expect((await observe(dispatch, { deadlineAt: NaN })).result.state).toBe('unavailable');
    expect((await observe(dispatch, { deadlineAt: deadline(), signal: cancelled.signal })).result.state).toBe('unavailable');
    expect(token).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
  });
  it.each(['private non-token', 'a.b.c\nsecret', 'a'.repeat(16_385)])('does not send malformed or oversized platform credentials', async value => {
    clock(); const request = vi.fn();
    expect((await createNativeAuthorityClient('https://native-api.vercel.app', { token: async () => value, fetch: request })(dispatch, { deadlineAt: deadline() })).result.state).toBe('unavailable');
    expect(request).not.toHaveBeenCalled();
  });
  it('bounds late OIDC acquisition without issuing a request after timeout', async () => {
    clock(); let finish!: (value: string) => void;
    const request = vi.fn(), token = () => new Promise<string>(resolve => { finish = resolve; });
    const pending = createNativeAuthorityClient('https://native-api.vercel.app', { token, fetch: request })(dispatch, { deadlineAt: deadline() });
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await pending).result.state).toBe('unavailable'); finish(credential); await Promise.resolve();
    expect(request).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('shares the original ten-second budget across token and actual network cancellation', async () => {
    clock(); const token = () => new Promise<string>(resolve => setTimeout(() => resolve(credential), 8000));
    const request = vi.fn<typeof fetch>(() => new Promise(() => {}));
    const pending = createNativeAuthorityClient('https://native-api.vercel.app', { token, fetch: request })(dispatch, { deadlineAt: deadline() });
    await vi.advanceTimersByTimeAsync(9999); expect(request).toHaveBeenCalledOnce(); expect(request.mock.calls[0]![1]!.signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1); expect((await pending).result.state).toBe('unavailable');
    expect(request.mock.calls[0]![1]!.signal!.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });
  it('cancels a stalled response body on the parent signal', async () => {
    clock(); const parent = new AbortController(), cancel = vi.fn();
    const request = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({ cancel }), { headers: { 'Content-Type': 'application/json' } }));
    const pending = createNativeAuthorityClient('https://native-api.vercel.app', { token: async () => credential, fetch: request })(dispatch, { deadlineAt: deadline(), signal: parent.signal });
    await vi.advanceTimersByTimeAsync(1); parent.abort();
    expect((await pending).result.state).toBe('unavailable'); expect(cancel).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]![1]!.signal!.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });
  it.each([401, 403, 429, 500, 302])('treats HTTP %s as unavailable and exposes no private error', async status => {
    clock(); const request = vi.fn<typeof fetch>(async () => new Response('private-provider-secret', { status }));
    const result = await createNativeAuthorityClient('https://native-api.vercel.app', { token: async () => credential, fetch: request })(dispatch, { deadlineAt: deadline() });
    expect(result.result.state).toBe('unavailable'); expect(JSON.stringify(result)).not.toContain('private'); expect(request).toHaveBeenCalledOnce();
  });
  it.each(['declared_large', 'stream_large', 'wrong_mime', 'invalid_json', 'invalid_utf8', 'extra_field', 'too_long', 'expired'])('rejects %s response', async mode => {
    clock(); let value: Response;
    if (mode === 'declared_large') value = new Response('{}', { headers: { 'Content-Type': 'application/json', 'Content-Length': '8193' } });
    else if (mode === 'stream_large') value = new Response(' '.repeat(8193), { headers: { 'Content-Type': 'application/json' } });
    else if (mode === 'wrong_mime') value = new Response('{}', { headers: { 'Content-Type': 'text/html' } });
    else if (mode === 'invalid_json') value = new Response('private-invalid', { headers: { 'Content-Type': 'application/json' } });
    else if (mode === 'invalid_utf8') value = new Response(new Uint8Array([255]), { headers: { 'Content-Type': 'application/json' } });
    else if (mode === 'extra_field') value = Response.json({ schemaVersion: 1, dispatch, result: allowed(), secret: 'private' });
    else if (mode === 'too_long') value = response({ ...allowed(), validUntil: new Date(at + 20_001).toISOString() });
    else value = response(allowed(at - 30_000));
    const result = await createNativeAuthorityClient('https://native-api.vercel.app', { token: async () => credential, fetch: async () => value })(dispatch, { deadlineAt: deadline() });
    expect(result.result.state).toBe('unavailable');
  });
  it.each(['organizationId', 'taskId', 'generation', 'environment'] as const)('rejects another %s in the authority response', async field => {
    clock(); const changed = { ...dispatch, [field]: field === 'generation' ? 2 : field === 'environment' ? 'simulation' : 'other' } as NativeDispatchMessage;
    const result = await createNativeAuthorityClient('https://native-api.vercel.app', { token: async () => credential, fetch: async () => response(allowed(), changed) })(dispatch, { deadlineAt: deadline() });
    expect(result.result.state).toBe('unavailable');
  });
  it('starts conservative validity before the request and subtracts elapsed time despite a DB clock ahead', async () => {
    clock(); const observed = allowed(at + 60_000);
    const request = async () => { await new Promise(resolve => setTimeout(resolve, 3000)); return response(observed); };
    const pending = createNativeAuthorityClient('https://native-api.vercel.app', { token: async () => credential, fetch: request })(dispatch, { deadlineAt: deadline() });
    await vi.advanceTimersByTimeAsync(3000);
    expect(await pending).toEqual({ result: observed, usableUntil: at + 20_000 });
  });
  it('preserves explicit denied/stale/unavailable semantics without inventing a proof', async () => {
    clock();
    for (const state of ['denied', 'stale', 'unavailable'] as const) {
      const result = { state, observedAt: null, validUntil: null };
      expect(await createNativeAuthorityClient('https://native-api.vercel.app', { token: async () => credential, fetch: async () => response(result) })(dispatch, { deadlineAt: deadline() }))
        .toEqual({ result, usableUntil: null });
    }
  });
});

function claimed(): NativeTaskClaim {
  return { environment: 'development', organizationId: 'org-one', actorId: 'actor-one', leaseToken: '42f80c74-8c92-400a-a69f-b1f5f22885d4', checkpoint: {},
    task: { id: 'task-one', title: 'Compare options', siteId: 'site-one', status: 'running', phase: 'Working', createdAt: timestamp, updatedAt: timestamp,
      version: 1, availableActions: ['pause'], prompt: 'Compare options from my supplied context.', mode: 'advise', steps: [], messages: [], artifacts: [], events: [] } };
}
const update: NativeTaskProgress = { phase: 'Working', event: { kind: 'progress', title: 'Checking sources', detail: '', agent: 'research' }, checkpoint: { preserved: true } };
function binding() {
  const work: NativeDispatchClaim = { claim: claimed(), dispatch: { ...dispatch } };
  const updates: NativeTaskProgress[] = [];
  const repository = { claim: vi.fn(async () => work.claim), renew: vi.fn(async (_claim: NativeTaskClaim, _leaseMilliseconds: number) => true),
    progress: vi.fn(async (_claim: NativeTaskClaim, value: NativeTaskProgress) => { updates.push(structuredClone(value)); return true; }), release: vi.fn(async () => {}) } satisfies NativeTaskWorkerRepository;
  const dispatchRepository = { claimTarget: vi.fn(async () => ({ kind: 'claimed' as const, ...work })), yieldClaim: vi.fn(async () => true) } satisfies NativeDispatchWorkerRepository;
  const authority = vi.fn<NativeAuthorityClient>(async () => ({ result: allowed(), usableUntil: Date.now() + 20_000 }));
  const bound = createAuthorityBoundRepositories({ repository, dispatchRepository, authority, deadlineAt: deadline() });
  const acquire = () => bound.dispatchRepository.claimTarget(dispatch, 'worker-one', 30_000);
  return { work, repository, dispatchRepository, authority, bound, acquire, updates };
}
describe('generation-bound repository authority and cancellation', () => {
  it.each(['unavailable', 'denied', 'stale'] as const)('does not claim or execute when initial proof is %s', async state => {
    clock(); const f = binding(), runClaimSlice = vi.fn();
    f.authority.mockResolvedValue({ result: { ...unavailable, state }, usableUntil: null });
    const pending = consumeNativeDispatch(dispatch, { repository: f.bound.dispatchRepository, coordinator: { runClaimSlice }, environment: 'development', workerId: 'worker-one', deadlineAt: deadline() });
    if (state === 'unavailable') await expect(pending).rejects.toMatchObject({ afterSeconds: 2 });
    else await expect(pending).resolves.toBe('discarded');
    expect(f.dispatchRepository.claimTarget).not.toHaveBeenCalled(); expect(runClaimSlice).not.toHaveBeenCalled(); f.bound.close();
  });
  it('requires both API proof and the actual DB claim; disables unscoped claims', async () => {
    clock(); const f = binding();
    expect(await f.bound.repository.claim('worker-one', 30000)).toBe(null); expect(f.repository.claim).not.toHaveBeenCalled();
    f.dispatchRepository.claimTarget.mockResolvedValue({ kind: 'not_ready', retryAfterMilliseconds: 1000 } as never);
    expect(await f.acquire()).toEqual({ kind: 'not_ready', retryAfterMilliseconds: 1000 });
    expect(() => f.bound.assertCurrent()).toThrow(); f.bound.close();
  });
  it('does not inherit another task or generation returned by storage', async () => {
    clock(); const f = binding(); f.dispatchRepository.claimTarget.mockResolvedValue({ kind: 'claimed', ...f.work, dispatch: { ...dispatch, generation: 2 } });
    expect(await f.acquire()).toMatchObject({ kind: 'not_ready' }); expect(f.bound.signal.aborted).toBe(true);
  });
  it('coalesces simultaneous authority observations while retaining DB renewal checks', async () => {
    clock(); const f = binding(); expect((await f.acquire()).kind).toBe('claimed');
    let finish!: (value: Awaited<ReturnType<NativeAuthorityClient>>) => void;
    f.authority.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const one = f.bound.repository.renew(f.work.claim, 30000), two = f.bound.repository.renew(f.work.claim, 30000);
    expect(f.authority).toHaveBeenCalledTimes(2); finish({ result: allowed(), usableUntil: at + 20000 });
    expect(await one).toBe(true); expect(await two).toBe(true); expect(f.repository.renew).toHaveBeenCalledTimes(2); f.bound.close();
  });
  it.each(['unavailable', 'denied', 'stale'] as const)('aborts existing work on %s renewal without a fallback write', async state => {
    clock(); const f = binding(); await f.acquire();
    f.authority.mockResolvedValue({ result: { ...unavailable, state }, usableUntil: null });
    expect(await f.bound.repository.renew(f.work.claim, 30000)).toBe(false);
    expect(f.bound.signal.aborted).toBe(true); expect(f.repository.renew).not.toHaveBeenCalled();
    expect(await f.bound.repository.progress(f.work.claim, update)).toBe(false); expect(f.repository.progress).not.toHaveBeenCalled();
    expect(() => f.bound.assertCurrent()).toThrow();
  });
  it('expires active authority even while a refresh hangs and cannot resurrect it from a late allow', async () => {
    clock(); const f = binding(); await f.acquire(); let finish!: (value: Awaited<ReturnType<NativeAuthorityClient>>) => void;
    f.authority.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.bound.repository.renew(f.work.claim, 30000); await vi.advanceTimersByTimeAsync(20000);
    expect(f.bound.signal.aborted).toBe(true); finish({ result: allowed(), usableUntil: Date.now() + 20000 });
    expect(await pending).toBe(false); expect(f.repository.renew).not.toHaveBeenCalled(); expect(() => f.bound.assertCurrent()).toThrow();
  });
  it('checks again after slow writes, retaining storage errors for coordinator reconciliation', async () => {
    clock(); const f = binding(); await f.acquire();
    const stale = Object.assign(Error('evidence expired'), { code: 'EVIDENCE_STALE' });
    f.repository.progress.mockRejectedValueOnce(stale); await expect(f.bound.repository.progress(f.work.claim, update)).rejects.toBe(stale);
    f.repository.progress.mockImplementationOnce(async () => { await new Promise(resolve => setTimeout(resolve, 20000)); return true; });
    const pending = f.bound.repository.progress(f.work.claim, update); await vi.advanceTimersByTimeAsync(20000);
    expect(await pending).toBe(false); expect(f.bound.signal.aborted).toBe(true);
  });
  it('rejects another lease and generation without forwarding writes', async () => {
    clock(); const f = binding(); await f.acquire();
    expect(await f.bound.dispatchRepository.yieldClaim({ ...f.work, dispatch: { ...dispatch, generation: 2 } }, update)).toBe(false);
    expect(f.dispatchRepository.yieldClaim).not.toHaveBeenCalled();
    const second = binding(); await second.acquire();
    expect(await second.bound.repository.progress({ ...second.work.claim, leaseToken: 'another' }, update)).toBe(false);
    expect(second.repository.progress).not.toHaveBeenCalled();
  });
  it.each(['renew', 'progress', 'release', 'yield'] as const)('keeps independent affinity when the returned claim is mutated before %s', async operation => {
    clock(); const f = binding(), acquired = await f.acquire();
    expect(acquired.kind).toBe('claimed'); if (acquired.kind !== 'claimed') throw Error('Expected claim');
    acquired.claim.task.id = 'another-task'; acquired.claim.organizationId = 'another-org'; acquired.claim.leaseToken = 'another-lease';
    if (operation === 'renew') expect(await f.bound.repository.renew(acquired.claim, 30000)).toBe(false);
    if (operation === 'progress') expect(await f.bound.repository.progress(acquired.claim, update)).toBe(false);
    if (operation === 'release') await f.bound.repository.release(acquired.claim);
    if (operation === 'yield') expect(await f.bound.dispatchRepository.yieldClaim(acquired, update)).toBe(false);
    expect(f.repository.renew).not.toHaveBeenCalled(); expect(f.repository.progress).not.toHaveBeenCalled();
    expect(f.repository.release).not.toHaveBeenCalled(); expect(f.dispatchRepository.yieldClaim).not.toHaveBeenCalled();
    expect(f.authority).toHaveBeenCalledOnce(); expect(f.bound.signal.aborted).toBe(true);
  });
  it('snapshots renewal scope before awaiting a fresh authority observation', async () => {
    clock(); const f = binding(), acquired = await f.acquire(); if (acquired.kind !== 'claimed') throw Error('Expected claim');
    let finish!: (value: Awaited<ReturnType<NativeAuthorityClient>>) => void;
    f.authority.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.bound.repository.renew(acquired.claim, 30000);
    acquired.claim.task.id = 'changed-during-refresh'; acquired.claim.organizationId = 'changed-org'; acquired.claim.leaseToken = 'changed-lease';
    finish({ result: allowed(), usableUntil: at + 20000 }); expect(await pending).toBe(true);
    expect(f.repository.renew.mock.calls[0]![0]).toMatchObject({ organizationId: 'org-one', leaseToken: f.work.claim.leaseToken, task: { id: 'task-one' } });
    f.bound.close();
  });
  it('closes the proof timer and aborts pending observation on delivery cleanup', async () => {
    clock(); const f = binding(); await f.acquire(); f.bound.close();
    expect(f.bound.signal.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
    expect(await f.bound.repository.renew(f.work.claim, 30000)).toBe(false); expect(f.authority).toHaveBeenCalledOnce();
  });
});

describe('actual coordinator authority interruption', () => {
  async function run(f: ReturnType<typeof binding>, stage: 'source' | 'model', onStarted: (signal: AbortSignal) => void) {
    if (stage === 'model') {
      const input = JSON.stringify({ objective: f.work.claim.task.prompt, steering: [] });
      const fingerprint = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input)))].map(value => value.toString(16).padStart(2, '0')).join('');
      f.work.claim.checkpoint = { schemaVersion: 2, inputFingerprint: fingerprint, evidenceRevision: 0, resumedThrough: 0,
        attempts: { plan: 0, evidence: 1, research: 0, planning: 0, escalation: 0, synthesis: 0 }, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        plan: null, documents: [], documentsLoaded: true, research: null, planning: null, escalationComplete: false, synthesis: null };
    }
    const hold = (signal: AbortSignal): Promise<never> => new Promise((_resolve, reject) => { onStarted(signal); signal.addEventListener('abort', () => reject(Error('aborted')), { once: true }); });
    const coordinator = new NativeCoordinator({ repository: f.bound.repository, dispatchRepository: f.bound.dispatchRepository,
      workerId: 'worker-one', heartbeatMilliseconds: 10000,
      gateway: { complete: async request => { f.bound.assertCurrent(); return hold(request.signal); } },
      evidenceReader: { read: async request => { f.bound.assertCurrent(); return hold(request.signal); } },
    });
    return consumeNativeDispatch(dispatch, { repository: f.bound.dispatchRepository,
      coordinator: { runClaimSlice: (work, options) => coordinator.runClaimSlice(work, { ...options, signal: f.bound.signal }) },
      environment: 'development', workerId: 'worker-one', deadlineAt: deadline() });
  }
  it.each(['source', 'model'] as const)('stops an in-flight %s on the ten-second heartbeat and preserves the attempted checkpoint', async stage => {
    clock(); const f = binding(); let started!: () => void, seen!: AbortSignal;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const pending = run(f, stage, signal => { seen = signal; started(); });
    const checked = expect(pending).rejects.toBeInstanceOf(NativeDeliveryRetry);
    await ready; expect(seen.aborted).toBe(false); const before = structuredClone(f.updates);
    f.authority.mockResolvedValue({ result: unavailable, usableUntil: null });
    await vi.advanceTimersByTimeAsync(10000); await checked;
    expect(seen.aborted).toBe(true); expect(f.updates).toEqual(before);
    expect(f.updates.some(value => value.status === 'failed' || value.status === 'completed')).toBe(false);
    expect(f.dispatchRepository.yieldClaim).not.toHaveBeenCalled(); expect(f.repository.release).not.toHaveBeenCalled();
    expect(f.authority).toHaveBeenCalledTimes(3); f.bound.close(); expect(vi.getTimerCount()).toBe(0);
  });
  it('starts no source call when the attempt save outlives the authority proof', async () => {
    clock(); const f = binding(); let started = 0, saved!: () => void;
    const saving = new Promise<void>(resolve => { saved = resolve; });
    f.repository.progress.mockImplementationOnce(async () => { saved(); await new Promise(resolve => setTimeout(resolve, 21000)); return true; });
    // A slow refresh cannot extend the old proof while the write is blocked.
    f.authority.mockImplementationOnce(async () => ({ result: allowed(), usableUntil: at + 20000 }))
      .mockImplementationOnce(async () => ({ result: allowed(), usableUntil: at + 20000 }))
      .mockImplementation(() => new Promise(() => {}));
    const pending = run(f, 'source', () => { started++; }); const checked = expect(pending).rejects.toBeInstanceOf(NativeDeliveryRetry);
    await saving; await vi.advanceTimersByTimeAsync(21000); await checked;
    expect(started).toBe(0); expect(f.bound.signal.aborted).toBe(true); expect(f.dispatchRepository.yieldClaim).not.toHaveBeenCalled(); f.bound.close();
  });
});
