import { DomainError } from '../../../packages/domain/src/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DelegatedInterrupted, DelegatedLease, DelegatedPersistenceUnknown } from './delegated-lease';
import type { NativeDelegationStoredClaim } from '../../../packages/db/src/native-delegation-repository';

const target = { organizationId: 'org', taskId: 'root', generation: 1 };
const instant = (offset: number) => new Date(Date.now() + offset).toISOString();
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  const claim: NativeDelegationStoredClaim = { selector: { ...target, handoffId: null, leaseToken: '2c1583e3-4767-4668-9e44-4134e9d4daf6' },
    identity: { serviceId: 'coordinator', serviceVersion: 1, workloadIdentityId: 'coordinator' },
    authority: { kind: 'delegated', grantId: 'grant', grantVersion: 1, revocationEpoch: 0, grantDigest: 'a'.repeat(64) },
    attempt: 1, validUntil: instant(5000), handoff: null };
  const options = { target, claim: vi.fn(async () => claim), renew: vi.fn(async () => ({ validUntil: instant(5000) })),
    observe: vi.fn(async () => ({ result: { state: 'allowed' }, usableUntil: Date.now() + 8000 })),
    heartbeatMilliseconds: 1000, leaseMilliseconds: 10000, deadlineAt: Date.now() + 20000 };
  return { claim, options };
}
describe('delegated lease authority and interruption', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime('2026-11-18T12:00:00Z'); });
  afterEach(() => { vi.useRealTimers(); });
  it('observes fresh proof before the sole claim and preserves the same logical attempt across renewals', async () => {
    const f = fixture(), calls: string[] = [];
    f.options.observe.mockImplementation(async () => { calls.push('observe'); return { result: { state: 'allowed' }, usableUntil: Date.now() + 8000 }; });
    f.options.claim.mockImplementation(async () => { calls.push('claim'); return f.claim; });
    const lease = await DelegatedLease.acquire(f.options);
    expect(calls).toEqual(['observe', 'claim']);
    await vi.advanceTimersByTimeAsync(6500);
    lease.assertCurrent(); expect(f.options.claim).toHaveBeenCalledOnce(); expect(f.options.renew).toHaveBeenCalledTimes(6);
    expect(lease.claim.attempt).toBe(1); expect(lease.claim.selector).toEqual(f.claim.selector); lease.close();
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['denied', 'unavailable', 'stale'])('does not claim without allowed fresh authority: %s', async state => {
    const f = fixture(); f.options.observe.mockResolvedValue({ result: { state }, usableUntil: Date.now() + 10000 });
    await expect(DelegatedLease.acquire(f.options)).rejects.toBeInstanceOf(DelegatedInterrupted);
    expect(f.options.claim).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('rejects a mismatched retained claim rather than adopting another generation', async () => {
    const f = fixture(); f.claim.selector.generation = 2;
    await expect(DelegatedLease.acquire(f.options)).rejects.toBeInstanceOf(DelegatedInterrupted);
    expect(f.options.claim).toHaveBeenCalledOnce(); expect(f.options.renew).not.toHaveBeenCalled();
  });
  it('aborts in-flight work when a fresh authority observation reports revocation', async () => {
    const f = fixture(), lease = await DelegatedLease.acquire(f.options); let aborted = false;
    lease.signal.addEventListener('abort', () => { aborted = true; });
    f.options.observe.mockResolvedValue({ result: { state: 'denied' }, usableUntil: Date.now() + 8000 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(aborted).toBe(true); expect(f.options.renew).not.toHaveBeenCalled(); expect(() => lease.assertCurrent()).toThrow(DelegatedInterrupted);
  });
  it('expires independently while authority observation is hung', async () => {
    const f = fixture(), lease = await DelegatedLease.acquire(f.options);
    f.options.observe.mockImplementation(() => new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(5000);
    expect(lease.signal.aborted).toBe(true); expect(f.options.renew).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('expires independently while database renewal is hung', async () => {
    const f = fixture(), lease = await DelegatedLease.acquire(f.options);
    f.options.renew.mockImplementation(() => new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(5000);
    expect(lease.signal.aborted).toBe(true); expect(f.options.renew).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it('external cancellation interrupts a noncooperating model promise and removes timers', async () => {
    const f = fixture(), abort = new AbortController(), lease = await DelegatedLease.acquire({ ...f.options, signal: abort.signal });
    const work = lease.read(() => new Promise(() => {})); const rejected = expect(work).rejects.toBeInstanceOf(DelegatedInterrupted);
    abort.abort(); await rejected; expect(vi.getTimerCount()).toBe(0);
  });
  it('a lost write response never retries or confirms the proposed checkpoint', async () => {
    const f = fixture(), lease = await DelegatedLease.acquire(f.options), saved = { version: 3 }, proposed = { version: 4 };
    const write = vi.fn(async () => { throw Error('Connection failed after possible commit'); });
    await expect(lease.write(write).then(() => Object.assign(saved, proposed))).rejects.toBeInstanceOf(DelegatedPersistenceUnknown);
    expect(saved.version).toBe(3); expect(write).toHaveBeenCalledOnce(); expect(lease.signal.aborted).toBe(true);
  });
  it('distinguishes an authoritative rolled-back evidence rejection from an unknown write', async () => {
    const f = fixture(), lease = await DelegatedLease.acquire(f.options);
    const error = new DomainError('MEMORY_UNAVAILABLE', 409, 'Saved memory is no longer available.');
    await expect(lease.write(async () => { throw error; })).rejects.toBe(error);
    expect(lease.signal.aborted).toBe(false); lease.assertCurrent(); lease.close();
  });
  it('a claim acknowledgement lost at proof expiry is unknown and never reclaimed in-process', async () => {
    const f = fixture(); f.options.claim.mockImplementation(() => new Promise(() => {}));
    const pending = DelegatedLease.acquire(f.options); const rejected = expect(pending).rejects.toBeInstanceOf(DelegatedPersistenceUnknown);
    await vi.advanceTimersByTimeAsync(8000); await rejected;
    expect(f.options.claim).toHaveBeenCalledOnce(); expect(f.options.observe).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it('host deadline overrides successfully renewed provider and database leases', async () => {
    const f = fixture(), lease = await DelegatedLease.acquire({ ...f.options, deadlineAt: Date.now() + 3500 });
    await vi.advanceTimersByTimeAsync(3500); expect(lease.signal.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });
  it('lets model reads finish while a write waits for both authority observation and renewal', async () => {
    const f = fixture(), lease = await DelegatedLease.acquire(f.options), events: string[] = [];
    const observed = deferred<Awaited<ReturnType<typeof f.options.observe>>>(), renewed = deferred<{ validUntil: string }>();
    f.options.observe.mockImplementation(() => { events.push('observe'); return observed.promise; });
    f.options.renew.mockImplementation(() => { events.push('renew'); return renewed.promise; });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(lease.read(async () => 'model finished')).resolves.toBe('model finished');
    const write = vi.fn(async () => { events.push('write'); return 'saved'; }), pending = lease.write(write);
    await vi.advanceTimersByTimeAsync(0); expect(write).not.toHaveBeenCalled();
    observed.resolve({ result: { state: 'allowed' }, usableUntil: Date.now() + 8000 });
    await vi.advanceTimersByTimeAsync(0); expect(events).toEqual(['observe', 'renew']); expect(write).not.toHaveBeenCalled();
    renewed.resolve({ validUntil: instant(5000) });
    await expect(pending).resolves.toBe('saved'); expect(events).toEqual(['observe', 'renew', 'write']);
    lease.close(); expect(vi.getTimerCount()).toBe(0);
  });
  it('does not withdraw authority while a submitted write is awaiting its confirmed outcome', async () => {
    const f = fixture(), lease = await DelegatedLease.acquire(f.options), saved = deferred<string>();
    const write = vi.fn(() => saved.promise), pending = lease.write(write);
    await vi.advanceTimersByTimeAsync(1000);
    expect(write).toHaveBeenCalledOnce(); expect(f.options.observe).toHaveBeenCalledOnce(); expect(f.options.renew).not.toHaveBeenCalled();
    saved.resolve('confirmed'); await expect(pending).resolves.toBe('confirmed');
    await vi.advanceTimersByTimeAsync(0);
    expect(f.options.observe).toHaveBeenCalledTimes(2); expect(f.options.renew).toHaveBeenCalledOnce();
    lease.close(); expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['revocation', 'cancellation', 'expiry'] as const)('never submits a queued write after %s during refresh', async reason => {
    const f = fixture(), abort = new AbortController(), lease = await DelegatedLease.acquire({ ...f.options, signal: abort.signal });
    const observed = deferred<Awaited<ReturnType<typeof f.options.observe>>>();
    f.options.observe.mockImplementation(() => observed.promise);
    await vi.advanceTimersByTimeAsync(1000);
    const write = vi.fn(async () => 'saved'), pending = lease.write(write);
    const rejected = expect(pending).rejects.toBeInstanceOf(DelegatedInterrupted);
    if (reason === 'revocation') observed.resolve({ result: { state: 'denied' }, usableUntil: Date.now() + 8000 });
    else if (reason === 'cancellation') abort.abort();
    else await vi.advanceTimersByTimeAsync(4000);
    await rejected;
    observed.resolve({ result: { state: 'allowed' }, usableUntil: Date.now() + 8000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(write).not.toHaveBeenCalled(); expect(f.options.renew).not.toHaveBeenCalled();
    expect(lease.signal.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });
  it('continues heartbeats during a noncooperating model read', async () => {
    const f = fixture(), lease = await DelegatedLease.acquire(f.options);
    const pending = lease.read(() => new Promise(() => {})), rejected = expect(pending).rejects.toBeInstanceOf(DelegatedInterrupted);
    await vi.advanceTimersByTimeAsync(6500);
    expect(f.options.renew).toHaveBeenCalledTimes(6); lease.assertCurrent();
    lease.close(); await rejected; expect(vi.getTimerCount()).toBe(0);
  });
  it('closes after an unknown write and starts neither queued writes nor queued refresh', async () => {
    const f = fixture(), lease = await DelegatedLease.acquire(f.options), saved = deferred<string>();
    const first = vi.fn(() => saved.promise), second = vi.fn(async () => 'second'), firstPending = lease.write(first), secondPending = lease.write(second);
    const unknown = expect(firstPending).rejects.toBeInstanceOf(DelegatedPersistenceUnknown), interrupted = expect(secondPending).rejects.toBeInstanceOf(DelegatedInterrupted);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.options.observe).toHaveBeenCalledOnce(); expect(second).not.toHaveBeenCalled();
    saved.reject(Error('Acknowledgement lost after possible commit'));
    await unknown; await interrupted; await vi.advanceTimersByTimeAsync(0);
    expect(first).toHaveBeenCalledOnce(); expect(second).not.toHaveBeenCalled(); expect(f.options.observe).toHaveBeenCalledOnce();
    expect(f.options.renew).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('expires a hung submitted write as unknown without starting queued effects even after its late result', async () => {
    const f = fixture(), lease = await DelegatedLease.acquire(f.options), saved = deferred<string>();
    const first = vi.fn(() => saved.promise), second = vi.fn(async () => 'second'), firstPending = lease.write(first), secondPending = lease.write(second);
    const unknown = expect(firstPending).rejects.toBeInstanceOf(DelegatedPersistenceUnknown), interrupted = expect(secondPending).rejects.toBeInstanceOf(DelegatedInterrupted);
    await vi.advanceTimersByTimeAsync(5000); await unknown; await interrupted;
    saved.resolve('late confirmation'); await vi.advanceTimersByTimeAsync(0);
    expect(first).toHaveBeenCalledOnce(); expect(second).not.toHaveBeenCalled(); expect(f.options.observe).toHaveBeenCalledOnce();
    expect(f.options.renew).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('releases the gate after a confirmed rollback without closing the lease', async () => {
    const f = fixture(), lease = await DelegatedLease.acquire(f.options);
    const rollback = new DomainError('VERSION_CONFLICT', 409, 'Version changed.');
    const rejected = expect(lease.write(async () => { throw rollback; })).rejects.toBe(rollback);
    const next = lease.write(async () => 'confirmed');
    await rejected; await expect(next).resolves.toBe('confirmed'); lease.assertCurrent();
    await vi.advanceTimersByTimeAsync(1000); expect(f.options.renew).toHaveBeenCalledOnce();
    lease.close(); expect(vi.getTimerCount()).toBe(0);
  });
});
