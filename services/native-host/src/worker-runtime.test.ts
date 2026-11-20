import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NativeDispatchClaim, NativeDispatchClaimResult } from '@pactwoven/contracts';

const fixtures = vi.hoisted(() => ({
  claimTarget: vi.fn(), yieldClaim: vi.fn(), renew: vi.fn(), progress: vi.fn(), release: vi.fn(), claim: vi.fn(),
  source: vi.fn(), model: vi.fn(), publish: vi.fn(), token: vi.fn(), request: vi.fn(),
}));
vi.mock('@vercel/functions', () => ({ attachDatabasePool: vi.fn() }));
vi.mock('@vercel/functions/oidc', () => ({ getVercelOidcToken: fixtures.token }));
vi.mock('@pactwoven/db', () => ({
  createNativeTaskPool: vi.fn(async () => ({})),
  PostgresNativeTaskWorkerRepository: class { claim = fixtures.claim; renew = fixtures.renew; progress = fixtures.progress; release = fixtures.release; },
  PostgresNativeDispatchWorkerRepository: class { claimTarget = fixtures.claimTarget; yieldClaim = fixtures.yieldClaim; },
}));
vi.mock('@pactwoven/coordinator', async importActual => ({
  ...await importActual<typeof import('@pactwoven/coordinator')>(),
  createAzureGateway: () => ({ complete: fixtures.model }), createAzureNodeFetch: vi.fn(),
  createSourceEvidenceReader: () => ({ read: fixtures.source }),
}));
vi.mock('./config.js', () => ({ readNativeWorkerConfig: () => ({ environment: 'development', databaseUrl: 'fixture',
  endpoint: 'https://fixture.openai.azure.com/openai/v1/responses', apiKey: 'synthetic', apiOrigin: 'https://native-api.vercel.app' }) }));
vi.mock('./dispatch-runtime.js', () => ({ publishNativeWork: fixtures.publish }));

const time = Date.parse('2026-11-18T12:00:00Z');
const timestamp = new Date(time).toISOString();
const work: NativeDispatchClaim = { dispatch: { schemaVersion: 1, engineRevision: 'native-advice-v1', environment: 'development', organizationId: 'org-one', taskId: 'task-one', generation: 1 },
  claim: { environment: 'development', organizationId: 'org-one', actorId: 'actor-one', leaseToken: '42f80c74-8c92-400a-a69f-b1f5f22885d4', checkpoint: {},
    task: { id: 'task-one', title: 'Compare options', siteId: 'site-one', status: 'running', phase: 'Working', createdAt: timestamp, updatedAt: timestamp,
      version: 1, availableActions: ['pause'], prompt: 'Compare my options.', mode: 'advise', steps: [], messages: [], artifacts: [], events: [] } } };
function authorityResponse(state: 'allowed' | 'unavailable' = 'allowed') {
  return Response.json({ schemaVersion: 1, dispatch: work.dispatch, result: { state, observedAt: state === 'allowed' ? new Date(Date.now()).toISOString() : null,
    validUntil: state === 'allowed' ? new Date(Date.now() + 20000).toISOString() : null } });
}
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(time);
  for (const fn of Object.values(fixtures)) fn.mockReset();
  fixtures.claimTarget.mockResolvedValue({ kind: 'claimed', ...structuredClone(work) } satisfies NativeDispatchClaimResult);
  fixtures.yieldClaim.mockResolvedValue(true); fixtures.renew.mockResolvedValue(true); fixtures.progress.mockResolvedValue(true);
  fixtures.source.mockResolvedValue([]); fixtures.token.mockResolvedValue('synthetic.workload.token');
  fixtures.request.mockImplementation(async () => authorityResponse()); vi.stubGlobal('fetch', fixtures.request);
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('mandatory hosted worker authority composition', () => {
  it('does not reach DB claims or tools when the reverse API is unavailable', async () => {
    fixtures.request.mockImplementation(async () => authorityResponse('unavailable'));
    const { runNativeQueueMessage } = await import('./worker-runtime.js');
    await expect(runNativeQueueMessage(work.dispatch, time + 300000)).rejects.toMatchObject({ afterSeconds: 1 });
    expect(fixtures.token).toHaveBeenCalledOnce(); expect(fixtures.claimTarget).not.toHaveBeenCalled();
    expect(fixtures.source).not.toHaveBeenCalled(); expect(fixtures.model).not.toHaveBeenCalled(); expect(fixtures.publish).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not treat an HTTP allow as permission when DB proof is not ready', async () => {
    fixtures.claimTarget.mockResolvedValue({ kind: 'not_ready', retryAfterMilliseconds: 1000 });
    const { runNativeQueueMessage } = await import('./worker-runtime.js');
    await expect(runNativeQueueMessage(work.dispatch, time + 300000)).rejects.toMatchObject({ afterSeconds: 1 });
    expect(fixtures.claimTarget).toHaveBeenCalledOnce(); expect(fixtures.source).not.toHaveBeenCalled(); expect(fixtures.model).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('uses actual coordinator checkpoints and signals, then publishes acknowledged continuation', async () => {
    const { runNativeQueueMessage } = await import('./worker-runtime.js');
    await runNativeQueueMessage(work.dispatch, time + 300000);
    expect(fixtures.request).toHaveBeenCalledTimes(2); // Target admission and pre-source renewal.
    expect(fixtures.source).toHaveBeenCalledOnce(); expect(fixtures.model).not.toHaveBeenCalled(); expect(fixtures.claim).not.toHaveBeenCalled();
    expect(fixtures.yieldClaim).toHaveBeenCalledOnce(); expect(fixtures.publish).toHaveBeenCalledWith(time + 300000);
    expect(fixtures.yieldClaim.mock.calls[0]![1].checkpoint.documentsLoaded).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('aborts the real source signal after an unavailable heartbeat and keeps saved work untouched', async () => {
    let started!: () => void, signal!: AbortSignal;
    const ready = new Promise<void>(resolve => { started = resolve; });
    fixtures.source.mockImplementation((request: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      signal = request.signal; started(); signal.addEventListener('abort', () => reject(Error('interrupted')), { once: true });
    }));
    const { runNativeQueueMessage } = await import('./worker-runtime.js');
    const pending = runNativeQueueMessage(work.dispatch, time + 300000), checked = expect(pending).rejects.toMatchObject({ afterSeconds: 30 });
    await ready; const writes = fixtures.progress.mock.calls.length;
    fixtures.request.mockImplementation(async () => authorityResponse('unavailable'));
    await vi.advanceTimersByTimeAsync(10000); await checked;
    expect(signal.aborted).toBe(true); expect(fixtures.progress).toHaveBeenCalledTimes(writes);
    expect(fixtures.yieldClaim).not.toHaveBeenCalled(); expect(fixtures.model).not.toHaveBeenCalled(); expect(fixtures.publish).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
