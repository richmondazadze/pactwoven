import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import type { createDelegatedRuntime } from './delegated-runtime';

const mocks = vi.hoisted(() => ({
  attach: vi.fn(), pool: vi.fn(), dispatchRepository: vi.fn(), router: vi.fn(),
  config: vi.fn(), dispatchConfig: vi.fn(), compose: vi.fn(), gateway: vi.fn(), transport: vi.fn(),
  observe: vi.fn(), evidence: vi.fn(), send: vi.fn(), publish: vi.fn(), consume: vi.fn(), recover: vi.fn(),
}));
vi.mock('@vercel/functions', () => ({ attachDatabasePool: mocks.attach }));
vi.mock('../../../packages/db/src/native-delegation-pool', () => ({ createNativeDelegationPool: mocks.pool }));
vi.mock('../../../packages/db/src/native-delegation-repository', async importOriginal => ({
  ...await importOriginal<object>(), PostgresNativeDelegationDispatchRepository: mocks.dispatchRepository,
}));
vi.mock('../../../packages/db/src/native-root-lifecycle-repository', () => ({ PostgresNativeRootDispatchRepository: mocks.router }));
vi.mock('./delegated-host-config', () => ({ readDelegatedHostConfig: mocks.config, readDelegatedHostDispatchConfig: mocks.dispatchConfig }));
vi.mock('./delegated-runtime', () => ({ createDelegatedRuntime: mocks.compose }));
vi.mock('../../coordinator/src/azure-gateway', () => ({ createAzureGateway: mocks.gateway }));
vi.mock('../../coordinator/src/azure-node-transport', () => ({ createAzureNodeFetch: mocks.transport }));
vi.mock('../../coordinator/src/source-evidence', () => ({ createSourceEvidenceReader: mocks.evidence }));
vi.mock('./delegated-authority', () => ({ createNativeDelegatedAuthorityClient: mocks.observe }));
vi.mock('./delegated-queue', () => ({ sendDelegatedQueueMessage: mocks.send }));
vi.mock('./delegated-dispatch', async importOriginal => ({ ...await importOriginal<object>(), publishDelegatedWork: mocks.publish }));

const identity = (serviceId: string) => ({ serviceId, serviceVersion: 1, workloadIdentityId: serviceId });
const configuration = { environment: 'development', databases: { coordinator: 'coordinator-db', worker: 'worker-db', dispatcher: 'dispatch-db' },
  services: { coordinator: identity('coordinator'), research: identity('worker'), planning: identity('worker'), escalation: identity('worker') },
  endpoint: 'synthetic-endpoint', apiKey: 'synthetic-key', apiOrigin: 'synthetic-authority' };
const payload = { schemaVersion: 1, environment: 'development', kind: 'root', target: { organizationId: 'org', taskId: 'root', generation: 1 } };
const counts = { accepted: 1, discarded: 0, unconfirmed: 0 };
function pool(name: string) { return { name, end: vi.fn(async () => {}) }; }
function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function flush() { for (let index = 0; index < 30; index++) await Promise.resolve(); }
async function fixture() {
  const pools = { coordinator: pool('coordinator'), worker: pool('worker'), dispatcher: pool('dispatcher') };
  const runtimePublish = vi.fn(async (_deadline: number) => counts);
  mocks.pool.mockImplementation(async (_url: string, _environment: string, purpose: keyof typeof pools) => pools[purpose]);
  mocks.config.mockReturnValue(configuration);
  mocks.dispatchConfig.mockReturnValue({ environment: 'development', databaseUrl: configuration.databases.dispatcher });
  mocks.dispatchRepository.mockImplementation(function () {});
  mocks.router.mockImplementation(function () { return { recover: mocks.recover }; });
  mocks.consume.mockResolvedValue('settled'); mocks.publish.mockResolvedValue(counts); mocks.recover.mockResolvedValue([]);
  mocks.compose.mockReturnValue({ consume: mocks.consume, publish: runtimePublish });
  mocks.transport.mockReturnValue('node-transport'); mocks.gateway.mockReturnValue('model-gateway');
  mocks.evidence.mockReturnValue('source-reader'); mocks.observe.mockReturnValue('authority-observer');
  const { NativeDeliveryRetry } = await import('./consume');
  const host = await import('./delegated-host-runtime');
  return { ...host, pools, runtimePublish, NativeDeliveryRetry, deadline: Date.now() + 60000 };
}
beforeEach(() => { vi.resetModules(); vi.resetAllMocks(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('delegated host initialization boundaries', () => {
  it('initializes dispatch without Azure, authority, roster or executor pools', async () => {
    const f = await fixture(); expect(await f.publishDelegatedHostWork(f.deadline)).toEqual(counts);
    expect(mocks.pool.mock.calls).toEqual([['dispatch-db', 'development', 'dispatcher', 'delegation-root']]);
    expect(mocks.config).not.toHaveBeenCalled(); expect(mocks.gateway).not.toHaveBeenCalled(); expect(mocks.compose).not.toHaveBeenCalled();
    expect(mocks.attach.mock.calls).toEqual([[f.pools.dispatcher]]);
    expect(mocks.publish).toHaveBeenCalledWith(expect.objectContaining({ environment: 'development', send: mocks.send, deadlineAt: f.deadline }));
  });
  it('composes three verified audiences with the existing transport, reader, authority and separate queue', async () => {
    const f = await fixture(); expect(await f.runDelegatedQueueMessage(payload, f.deadline)).toBe('settled');
    expect(mocks.pool.mock.calls).toEqual([
      ['dispatch-db', 'development', 'dispatcher', 'delegation-root'], ['coordinator-db', 'development', 'coordinator', 'delegation-root'],
      ['worker-db', 'development', 'worker', 'delegation-root'],
    ]);
    expect(mocks.compose).toHaveBeenCalledWith(expect.objectContaining({ environment: 'development', services: configuration.services,
      pools: f.pools, gateway: 'model-gateway', observe: 'authority-observer', evidenceReader: 'source-reader', send: mocks.send }));
    expect(mocks.gateway).toHaveBeenCalledWith({ endpoint: configuration.endpoint, apiKey: configuration.apiKey }, 'node-transport');
    expect(mocks.observe).toHaveBeenCalledWith(configuration.apiOrigin);
    expect(mocks.consume).toHaveBeenCalledWith(payload, { deadlineAt: f.deadline });
    expect(mocks.attach).toHaveBeenCalledTimes(3); expect(f.runtimePublish).toHaveBeenCalledWith(f.deadline);
  });
  it('shares pending initialization between concurrent publication and execution callers', async () => {
    const f = await fixture(), pending = deferred<Pool>(); mocks.pool.mockImplementationOnce(() => pending.promise);
    const tasks = [f.publishDelegatedHostWork(f.deadline), f.runDelegatedQueueMessage(payload, f.deadline), f.runDelegatedQueueMessage(payload, f.deadline)];
    await flush(); expect(mocks.pool).toHaveBeenCalledOnce();
    pending.resolve(f.pools.dispatcher as unknown as Pool); await Promise.all(tasks);
    expect(mocks.pool).toHaveBeenCalledTimes(3); expect(mocks.compose).toHaveBeenCalledOnce(); expect(mocks.consume).toHaveBeenCalledTimes(2);
  });
  it('retries failed dispatcher initialization on the next invocation with sanitized errors', async () => {
    const f = await fixture(); mocks.pool.mockRejectedValueOnce(Error('private-connection-value'));
    await expect(f.publishDelegatedHostWork(f.deadline)).rejects.toThrow(f.NativeDeliveryRetry);
    expect(await f.publishDelegatedHostWork(f.deadline)).toEqual(counts); expect(mocks.pool).toHaveBeenCalledTimes(2);
  });
  it('closes a partial executor and retains the independently verified dispatcher for another attempt', async () => {
    const f = await fixture(); mocks.pool.mockImplementation(async (_url: string, _environment: string, purpose: keyof typeof f.pools) => {
      if (purpose === 'worker') throw Error('private-worker-value'); return f.pools[purpose];
    });
    await expect(f.runDelegatedQueueMessage(payload, f.deadline)).rejects.toThrow(f.NativeDeliveryRetry);
    expect(f.pools.coordinator.end).toHaveBeenCalledOnce(); expect(f.pools.dispatcher.end).not.toHaveBeenCalled();
    expect(mocks.compose).not.toHaveBeenCalled(); expect(mocks.attach.mock.calls).toEqual([[f.pools.dispatcher]]);
    const coordinator = pool('replacement-coordinator');
    mocks.pool.mockImplementation(async (_url: string, _environment: string, purpose: keyof typeof f.pools) => purpose === 'coordinator' ? coordinator : f.pools[purpose]);
    await f.runDelegatedQueueMessage(payload, f.deadline);
    expect(mocks.pool.mock.calls.filter(call => call[2] === 'dispatcher')).toHaveLength(1); expect(mocks.compose).toHaveBeenCalledOnce();
  });
  it('refuses a changed dispatcher binding before opening executor pools', async () => {
    const f = await fixture(); mocks.config.mockReturnValue({ ...configuration, databases: { ...configuration.databases, dispatcher: 'other-dispatch-db' } });
    await expect(f.runDelegatedQueueMessage(payload, f.deadline)).rejects.toThrow(f.NativeDeliveryRetry);
    expect(mocks.pool).toHaveBeenCalledOnce(); expect(mocks.compose).not.toHaveBeenCalled(); expect(f.pools.dispatcher.end).not.toHaveBeenCalled();
  });
  it.each(['composition', 'attachment'])('closes both owned pools after %s failure and leaves dispatcher usable', async failure => {
    const f = await fixture();
    if (failure === 'composition') mocks.compose.mockImplementationOnce(() => { throw Error('private-composition-value'); });
    else mocks.attach.mockImplementation((item: unknown) => { if (item === f.pools.coordinator) throw Error('private-attachment-value'); });
    await expect(f.runDelegatedQueueMessage(payload, f.deadline)).rejects.toThrow(f.NativeDeliveryRetry);
    expect(f.pools.coordinator.end).toHaveBeenCalledOnce(); expect(f.pools.worker.end).toHaveBeenCalledOnce();
    expect(f.pools.dispatcher.end).not.toHaveBeenCalled(); expect(await f.publishDelegatedHostWork(f.deadline)).toEqual(counts);
  });
  it('closes a dispatcher that failed repository composition and reinitializes it', async () => {
    const f = await fixture(); mocks.router.mockImplementationOnce(() => { throw Error('private-router-value'); });
    await expect(f.publishDelegatedHostWork(f.deadline)).rejects.toThrow(f.NativeDeliveryRetry);
    expect(f.pools.dispatcher.end).toHaveBeenCalledOnce(); expect(mocks.attach).not.toHaveBeenCalled();
    await f.publishDelegatedHostWork(f.deadline); expect(mocks.pool).toHaveBeenCalledTimes(2);
  });
  it('attempts all pool cleanup when one pool end throws synchronously', async () => {
    const f = await fixture(); mocks.compose.mockImplementationOnce(() => { throw Error('private-compose-value'); });
    f.pools.coordinator.end.mockImplementation(() => { throw Error('private-end-value'); });
    await expect(f.runDelegatedQueueMessage(payload, f.deadline)).rejects.toThrow(f.NativeDeliveryRetry);
    expect(f.pools.coordinator.end).toHaveBeenCalledOnce(); expect(f.pools.worker.end).toHaveBeenCalledOnce();
  });
  it('bounds shutdown of a noncooperating partial pool without delaying disposal of the other pool', async () => {
    vi.useFakeTimers(); const f = await fixture(); mocks.compose.mockImplementationOnce(() => { throw Error('private-compose-value'); });
    f.pools.coordinator.end.mockImplementation(() => new Promise(() => {}));
    const outcome = f.runDelegatedQueueMessage(payload, f.deadline).catch(error => error); await flush();
    expect(f.pools.coordinator.end).toHaveBeenCalledOnce(); expect(f.pools.worker.end).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000); expect(await outcome).toBeInstanceOf(f.NativeDeliveryRetry);
    expect(vi.getTimerCount()).toBe(0); expect(f.pools.dispatcher.end).not.toHaveBeenCalled();
  });
  it('preserves a deliberate initialization retry delay', async () => {
    const f = await fixture(), error = new f.NativeDeliveryRetry(91); mocks.pool.mockRejectedValueOnce(error);
    await expect(f.runDelegatedQueueMessage(payload, f.deadline)).rejects.toBe(error);
    expect(mocks.pool).toHaveBeenCalledOnce(); expect(mocks.consume).not.toHaveBeenCalled();
  });
  it.each(['dispatcher', 'coordinator', 'worker'] as const)('disposes a late %s result after bounded initialization expires', async purpose => {
    vi.useFakeTimers(); const f = await fixture(), pending = deferred<Pool>();
    mocks.pool.mockImplementation(async (_url: string, _environment: string, candidate: keyof typeof f.pools) => candidate === purpose ? pending.promise : f.pools[candidate]);
    const outcome = f.runDelegatedQueueMessage(payload, f.deadline).catch(error => error);
    await flush(); await vi.advanceTimersByTimeAsync(20000); expect(await outcome).toBeInstanceOf(f.NativeDeliveryRetry);
    pending.resolve(f.pools[purpose] as unknown as Pool); await flush();
    expect(f.pools[purpose].end).toHaveBeenCalledOnce(); expect(mocks.compose).not.toHaveBeenCalled();
    if (purpose === 'worker') expect(f.pools.coordinator.end).toHaveBeenCalledOnce();
    if (purpose !== 'dispatcher') expect(f.pools.dispatcher.end).not.toHaveBeenCalled();
    expect(mocks.attach.mock.calls).not.toContainEqual([f.pools[purpose]]); expect(vi.getTimerCount()).toBe(0);
  });
  it('checks wall-clock expiry when a pool resolves before its delayed timer fires', async () => {
    vi.useFakeTimers(); const f = await fixture(), pending = deferred<Pool>(); mocks.pool.mockImplementationOnce(() => pending.promise);
    const outcome = f.publishDelegatedHostWork(f.deadline).catch(error => error); await flush();
    vi.setSystemTime(Date.now() + 20001); pending.resolve(f.pools.dispatcher as unknown as Pool);
    expect(await outcome).toBeInstanceOf(f.NativeDeliveryRetry); await flush();
    expect(f.pools.dispatcher.end).toHaveBeenCalledOnce(); expect(mocks.attach).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('does not let a late failed initialization overwrite or close a replacement cache', async () => {
    vi.useFakeTimers(); const f = await fixture(), pending = deferred<Pool>(), replacement = pool('replacement-dispatcher');
    mocks.pool.mockImplementationOnce(() => pending.promise).mockResolvedValueOnce(replacement);
    const outcome = f.publishDelegatedHostWork(f.deadline).catch(error => error); await flush();
    await vi.advanceTimersByTimeAsync(20000); expect(await outcome).toBeInstanceOf(f.NativeDeliveryRetry);
    await f.publishDelegatedHostWork(f.deadline); pending.resolve(f.pools.dispatcher as unknown as Pool); await flush();
    await f.publishDelegatedHostWork(f.deadline);
    expect(mocks.pool).toHaveBeenCalledTimes(2); expect(mocks.attach.mock.calls).toEqual([[replacement]]);
    expect(f.pools.dispatcher.end).toHaveBeenCalledOnce(); expect(replacement.end).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('uses one initialization budget across sequential pool verification', async () => {
    vi.useFakeTimers(); const f = await fixture(), dispatcher = deferred<Pool>(), worker = deferred<Pool>();
    mocks.pool.mockImplementation(async (_url: string, _environment: string, purpose: keyof typeof f.pools) =>
      purpose === 'dispatcher' ? dispatcher.promise : purpose === 'worker' ? worker.promise : f.pools.coordinator);
    const outcome = f.runDelegatedQueueMessage(payload, f.deadline).catch(error => error); await flush();
    await vi.advanceTimersByTimeAsync(15000); dispatcher.resolve(f.pools.dispatcher as unknown as Pool); await flush();
    await vi.advanceTimersByTimeAsync(5000); expect(await outcome).toBeInstanceOf(f.NativeDeliveryRetry);
    worker.resolve(f.pools.worker as unknown as Pool); await flush();
    expect(f.pools.coordinator.end).toHaveBeenCalledOnce(); expect(f.pools.worker.end).toHaveBeenCalledOnce(); expect(mocks.compose).not.toHaveBeenCalled();
  });
  it('does not disclose task IDs, text or credentials in usage logging', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => {}), f = await fixture(); await f.runDelegatedQueueMessage(payload, f.deadline);
    const options = mocks.compose.mock.calls[0]![0] as Parameters<typeof createDelegatedRuntime>[0];
    options.onUsage!({ taskId: 'private-task-id', role: 'coordinator', usage: { inputTokens: 4, outputTokens: 6, totalTokens: 10 } });
    expect(log.mock.calls).toEqual([[JSON.stringify({ kind: 'delegated-model-usage', role: 'coordinator', inputTokens: 4, outputTokens: 6, totalTokens: 10 })]]);
  });
});

describe('delegated host delivery behavior', () => {
  it.each([null, { ...payload, extra: true }, { ...payload, environment: 'production' }, { ...payload, environment: 'simulation' },
    { ...payload, target: { ...payload.target, generation: 0 } }])('discards invalid or foreign metadata without initialization', async invalid => {
    const f = await fixture(); expect(await f.runDelegatedQueueMessage(invalid, f.deadline)).toBe('discarded');
    expect(mocks.config).not.toHaveBeenCalled(); expect(mocks.pool).not.toHaveBeenCalled();
  });
  it.each([NaN, Infinity, -Infinity, 1.1])('rejects invalid deadline %s without initialization', async deadline => {
    const f = await fixture();
    await expect(f.runDelegatedQueueMessage(payload, deadline)).rejects.toThrow(f.NativeDeliveryRetry);
    await expect(f.publishDelegatedHostWork(deadline)).rejects.toThrow(f.NativeDeliveryRetry);
    await expect(f.recoverDelegatedHostWork(deadline)).rejects.toThrow(f.NativeDeliveryRetry); expect(mocks.pool).not.toHaveBeenCalled();
  });
  it('avoids initialization and work when the remaining host slice is insufficient', async () => {
    const f = await fixture(), deadline = Date.now() + 19000;
    expect(await f.publishDelegatedHostWork(deadline)).toEqual({ accepted: 0, discarded: 0, unconfirmed: 0 });
    expect(await f.recoverDelegatedHostWork(deadline)).toEqual({ recovered: 0 });
    await expect(f.runDelegatedQueueMessage(payload, Date.now() + 24000)).rejects.toThrow(f.NativeDeliveryRetry); expect(mocks.pool).not.toHaveBeenCalled();
  });
  it('does not publish a discarded delivery', async () => {
    const f = await fixture(); mocks.consume.mockResolvedValue('discarded');
    expect(await f.runDelegatedQueueMessage(payload, f.deadline)).toBe('discarded'); expect(f.runtimePublish).not.toHaveBeenCalled();
  });
  it('preserves retry delay and does not rerun interrupted or unconfirmed work in process', async () => {
    const f = await fixture(), retry = new f.NativeDeliveryRetry(73); mocks.consume.mockRejectedValue(retry);
    await expect(f.runDelegatedQueueMessage(payload, f.deadline)).rejects.toBe(retry);
    expect(mocks.consume).toHaveBeenCalledOnce(); expect(f.runtimePublish).not.toHaveBeenCalled();
  });
  it('sanitizes unexpected runner errors without a local retry', async () => {
    const f = await fixture(); mocks.consume.mockRejectedValue(Error('private-model-output'));
    const error = await f.runDelegatedQueueMessage(payload, f.deadline).catch(error => error);
    expect(error).toBeInstanceOf(f.NativeDeliveryRetry); expect(String(error)).not.toContain('private-model-output'); expect(mocks.consume).toHaveBeenCalledOnce();
  });
  it.each(['publish', 'recover'] as const)('sanitizes unexpected %s errors without a local retry', async operation => {
    const f = await fixture(), dependency = operation === 'publish' ? mocks.publish : mocks.recover;
    dependency.mockRejectedValueOnce(Error('private-database-value'));
    const run = operation === 'publish' ? f.publishDelegatedHostWork : f.recoverDelegatedHostWork;
    const error = await run(f.deadline).catch(error => error);
    expect(error).toBeInstanceOf(f.NativeDeliveryRetry); expect(String(error)).not.toContain('private-database-value'); expect(dependency).toHaveBeenCalledOnce();
    const retry = new f.NativeDeliveryRetry(87); dependency.mockRejectedValueOnce(retry); await expect(run(f.deadline)).rejects.toBe(retry);
  });
  it('keeps saved settlement when opportunistic continuation publication fails', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {}), f = await fixture();
    f.runtimePublish.mockRejectedValue(Error('private-queue-value'));
    expect(await f.runDelegatedQueueMessage(payload, f.deadline)).toBe('settled'); expect(mocks.consume).toHaveBeenCalledOnce();
    expect(log.mock.calls).toEqual([['Delegated continuation remains in the durable dispatch outbox.']]);
  });
  it('leaves durable continuation for later dispatch when settlement exhausts the host slice', async () => {
    vi.useFakeTimers(); const f = await fixture(); mocks.consume.mockImplementation(async () => { vi.setSystemTime(f.deadline - 19999); return 'settled'; });
    expect(await f.runDelegatedQueueMessage(payload, f.deadline)).toBe('settled'); expect(f.runtimePublish).not.toHaveBeenCalled();
  });
  it('bounds recovery at four batches of twenty and publishes after each batch', async () => {
    const f = await fixture(); mocks.recover.mockResolvedValue(Array.from({ length: 20 }, () => ({})));
    expect(await f.recoverDelegatedHostWork(f.deadline)).toEqual({ recovered: 80 });
    expect(mocks.recover.mock.calls).toEqual([[20], [20], [20], [20]]); expect(mocks.publish).toHaveBeenCalledTimes(4);
    expect(mocks.config).not.toHaveBeenCalled(); expect(mocks.pool).toHaveBeenCalledOnce();
  });
  it('stops recovery after a short batch and keeps the original publication deadline', async () => {
    const f = await fixture(); mocks.recover.mockResolvedValue([{}]);
    expect(await f.recoverDelegatedHostWork(f.deadline)).toEqual({ recovered: 1 }); expect(mocks.recover).toHaveBeenCalledOnce();
    expect(mocks.publish).toHaveBeenCalledWith(expect.objectContaining({ deadlineAt: f.deadline }));
  });
  it('stops recovery when the slice cannot accommodate another bounded batch', async () => {
    vi.useFakeTimers(); const f = await fixture(); mocks.recover.mockImplementation(async () => { vi.setSystemTime(f.deadline - 19999); return Array.from({ length: 20 }, () => ({})); });
    expect(await f.recoverDelegatedHostWork(f.deadline)).toEqual({ recovered: 20 }); expect(mocks.recover).toHaveBeenCalledOnce(); expect(mocks.publish).not.toHaveBeenCalled();
  });
});
