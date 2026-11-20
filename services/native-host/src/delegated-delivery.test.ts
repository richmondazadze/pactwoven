import { afterEach, describe, expect, it, vi } from 'vitest';
import { publishDelegatedWork, type DelegatedQueueSend } from './delegated-dispatch';
import { consumeDelegatedWork } from './delegated-consume';
import { NativeDeliveryRetry } from './consume';
const target = { organizationId: 'org', taskId: 'root', generation: 1 };
const root = { serviceId: 'root-service', serviceVersion: 1, workloadIdentityId: 'root-workload' };
const worker = { serviceId: 'worker-service', serviceVersion: 1, workloadIdentityId: 'worker-workload' };
const payload = { schemaVersion: 1, environment: 'simulation', kind: 'root', target };
function publisher() {
  const repository = { claim: vi.fn().mockResolvedValueOnce([{ target, token: crypto.randomUUID() }]).mockResolvedValue([]), acknowledge: vi.fn(async () => true) };
  const router = { route: vi.fn(async () => ({ kind: 'root' as const, identity: root })) };
  return { environment: 'simulation' as const, repository, router, send: vi.fn<DelegatedQueueSend>(async () => ({})), deadlineAt: Date.now() + 60000 };
}
function consumer() {
  return { environment: 'simulation' as const, coordinatorIdentity: root, specialistIdentity: worker,
    router: { route: vi.fn(async () => ({ kind: 'root' as const, identity: root })) },
    coordinator: { run: vi.fn(async () => ({ state: 'yielded' as const, taskId: 'root' })) },
    specialist: { run: vi.fn(async () => ({ state: 'settled' as const, taskId: 'root' })) }, deadlineAt: Date.now() + 60000 };
}
afterEach(() => vi.useRealTimers());
describe('delegated outbox publication', () => {
  it('sends metadata only and acknowledges after confirmed send', async () => {
    const f = publisher(), calls: string[] = [];
    f.send.mockImplementation(async () => { calls.push('send'); return {}; });
    f.repository.acknowledge.mockImplementation(async () => { calls.push('ack'); return true; });
    expect(await publishDelegatedWork(f)).toEqual({ accepted: 1, discarded: 0, unconfirmed: 0 });
    expect(calls).toEqual(['send', 'ack']); expect(f.send.mock.calls[0]?.[0]).toEqual(payload);
    expect(Object.keys(f.send.mock.calls[0]?.[1] ?? {})).toEqual(['idempotencyKey', 'retentionSeconds']);
  });
  it('uses the same operation identity after uncertain delivery and a different claim token', async () => {
    const a = publisher(), b = publisher(); a.send.mockRejectedValue(Error('unknown acceptance'));
    expect((await publishDelegatedWork(a)).unconfirmed).toBe(1); expect(a.repository.acknowledge).not.toHaveBeenCalled();
    await publishDelegatedWork(b); expect(a.send.mock.calls[0]?.[1]).toEqual(b.send.mock.calls[0]?.[1]);
  });
  it('bounds a noncooperating send and does not acknowledge it', async () => {
    vi.useFakeTimers(); const f = publisher(); f.send.mockImplementation(() => new Promise(() => {}));
    const pending = publishDelegatedWork(f); await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce()); await vi.advanceTimersByTimeAsync(10000);
    expect((await pending).unconfirmed).toBe(1); expect(f.repository.acknowledge).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('does not send obsolete targets', async () => {
    const f = publisher(); f.router.route.mockResolvedValue(null as never);
    expect((await publishDelegatedWork(f)).discarded).toBe(1); expect(f.send).not.toHaveBeenCalled(); expect(f.repository.acknowledge).toHaveBeenCalledOnce();
  });
  it('rechecks the deadline after database claim and routing', async () => {
    let now = 0; const f = publisher(); f.deadlineAt = 30000;
    f.router.route.mockImplementation(async () => { now = 20000; return { kind: 'root', identity: root }; });
    await publishDelegatedWork({ ...f, now: () => now }); expect(f.send).not.toHaveBeenCalled(); expect(f.repository.acknowledge).not.toHaveBeenCalled();
  });
  it('treats failed acknowledgement as unconfirmed and stops the batch', async () => {
    const f = publisher(); f.repository.acknowledge.mockResolvedValue(false);
    expect((await publishDelegatedWork(f)).unconfirmed).toBe(1); expect(f.repository.claim).toHaveBeenCalledOnce();
  });
});
describe('delegated delivery consumer', () => {
  it('routes root work only after current protected identity resolution', async () => {
    const f = consumer(); expect(await consumeDelegatedWork(payload, f)).toBe('settled');
    expect(f.coordinator.run).toHaveBeenCalledWith(target, { deadlineAt: f.deadlineAt }); expect(f.specialist.run).not.toHaveBeenCalled();
  });
  it('routes the specialist with its independently enrolled identity', async () => {
    const f = consumer(); f.router.route.mockResolvedValue({ kind: 'specialist', identity: worker } as never);
    expect(await consumeDelegatedWork({ ...payload, kind: 'specialist' }, f)).toBe('settled'); expect(f.specialist.run).toHaveBeenCalledOnce();
  });
  it.each([{ ...payload, environment: 'production' }, { ...payload, prompt: 'injected work' }, { ...payload, target: { ...target, generation: 0 } }])('rejects malformed or foreign metadata before storage', async message => {
    const f = consumer(); expect(await consumeDelegatedWork(message, f)).toBe('discarded'); expect(f.router.route).not.toHaveBeenCalled();
  });
  it.each([null, { kind: 'specialist', identity: worker }, { kind: 'root', identity: worker }])('does not execute stale or misdirected deliveries', async route => {
    const f = consumer(); f.router.route.mockResolvedValue(route as never);
    expect(await consumeDelegatedWork(payload, f)).toBe('discarded'); expect(f.coordinator.run).not.toHaveBeenCalled();
  });
  it.each(['interrupted', 'unconfirmed'])('requests redelivery after %s without a new operation', async state => {
    const f = consumer(); f.coordinator.run.mockResolvedValue({ state, taskId: 'root' } as never);
    await expect(consumeDelegatedWork(payload, f)).rejects.toBeInstanceOf(NativeDeliveryRetry);
  });
  it('leaves work to a later invocation when settlement time is insufficient', async () => {
    const f = consumer(); f.deadlineAt = Date.now() + 20000;
    await expect(consumeDelegatedWork(payload, f)).rejects.toBeInstanceOf(NativeDeliveryRetry); expect(f.router.route).not.toHaveBeenCalled();
  });
});
