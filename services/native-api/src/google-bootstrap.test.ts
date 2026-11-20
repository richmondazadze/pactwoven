import { afterEach, describe, expect, it, vi } from 'vitest';
import type { createRuntimePool } from '@pactwoven/db';
import type { readNativeGoogleConfig } from './google-config';
import { GOOGLE_FOREGROUND_LANES } from './google-config';
import { createNativeGoogleAppLoader } from './google-bootstrap';

type Pool = Awaited<ReturnType<typeof createRuntimePool>>;
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function fixture() {
  const pools = Object.fromEntries(['foundation', ...GOOGLE_FOREGROUND_LANES].map(name => [name, { end: vi.fn(async () => undefined) }])) as Record<'foundation' | typeof GOOGLE_FOREGROUND_LANES[number], Pool & { end: ReturnType<typeof vi.fn> }>;
  const config = { base: { environment: 'development', foundationDatabaseUrl: 'foundation' }, databaseUrls: Object.fromEntries(GOOGLE_FOREGROUND_LANES.map(name => [name, name])) } as unknown as ReturnType<typeof readNativeGoogleConfig>;
  const app = { fetch: vi.fn(async () => Response.json({ ready: true })) };
  const dependencies = { readConfig: vi.fn(() => config), openFoundation: vi.fn(async () => pools.foundation),
    openGoogle: vi.fn(async (_url: string, _environment: string, lane: typeof GOOGLE_FOREGROUND_LANES[number]) => pools[lane]),
    compose: vi.fn(() => app), attach: vi.fn() };
  return { pools, app, dependencies, load: createNativeGoogleAppLoader(dependencies) };
}
afterEach(() => vi.useRealTimers());
describe('foreground Google bootstrap', () => {
  it('stays lazy and shares exactly one admitted pool set across concurrent requests', async () => {
    const f = fixture(); expect(f.dependencies.readConfig).not.toHaveBeenCalled();
    const apps = await Promise.all([f.load(), f.load(), f.load()]);
    expect(apps).toEqual([f.app, f.app, f.app]); expect(f.dependencies.openFoundation).toHaveBeenCalledOnce();
    expect(f.dependencies.openGoogle.mock.calls.map(call => call[2])).toEqual(GOOGLE_FOREGROUND_LANES);
    expect(f.dependencies.compose).toHaveBeenCalledOnce(); expect(f.dependencies.attach).toHaveBeenCalledTimes(6);
    for (const pool of Object.values(f.pools)) expect(pool.end).not.toHaveBeenCalled();
  });
  it('does not open pools or expose sensitive config errors', async () => {
    const f = fixture(); f.dependencies.readConfig.mockImplementation(() => { throw Error('sensitive-config'); });
    await expect(f.load()).rejects.toThrow('Google connection initialization failed.');
    expect(f.dependencies.openFoundation).not.toHaveBeenCalled(); expect(f.dependencies.openGoogle).not.toHaveBeenCalled();
  });
  it.each(GOOGLE_FOREGROUND_LANES)('closes admitted pools after %s admission fails and permits a clean retry', async lane => {
    const f = fixture();
    f.dependencies.openGoogle.mockImplementation(async (_url, _environment, current) => { if (current === lane) throw Error('sensitive-pool'); return f.pools[current]; });
    await expect(f.load()).rejects.toThrow('Google connection initialization failed.');
    expect(f.dependencies.compose).not.toHaveBeenCalled(); expect(f.dependencies.attach).not.toHaveBeenCalled();
    for (const [name, pool] of Object.entries(f.pools)) expect(pool.end).toHaveBeenCalledTimes(name === lane ? 0 : 1);
    f.dependencies.openGoogle.mockImplementation(async (_url, _environment, current) => f.pools[current]);
    expect(await f.load()).toBe(f.app); expect(f.dependencies.openFoundation).toHaveBeenCalledTimes(2);
  });
  it('bounds pending admissions and disposes a pool that arrives after timeout', async () => {
    vi.useFakeTimers(); const f = fixture(), pending = deferred<typeof f.pools.auth>();
    f.dependencies.openGoogle.mockImplementation(async (_url, _environment, lane) => lane === 'auth' ? pending.promise : f.pools[lane]);
    const result = f.load().catch(error => error); await flush(); await vi.advanceTimersByTimeAsync(10000);
    expect(String(await result)).toBe('Error: Google connection initialization failed.');
    expect(f.dependencies.compose).not.toHaveBeenCalled();
    pending.resolve(f.pools.auth); await flush();
    for (const pool of Object.values(f.pools)) expect(pool.end).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('bounds a shorter waiter without abandoning another caller’s healthy initialization', async () => {
    vi.useFakeTimers(); const f = fixture(), pending = deferred<Pool>();
    f.dependencies.openFoundation.mockImplementation(() => pending.promise as Promise<typeof f.pools.foundation>);
    const first = f.load(), short = f.load(Date.now() + 2000).catch(error => error);
    await flush(); await vi.advanceTimersByTimeAsync(2000); expect(String(await short)).toContain('initialization failed');
    pending.resolve(f.pools.foundation); expect(await first).toBe(f.app); expect(await f.load()).toBe(f.app);
    expect(f.dependencies.openFoundation).toHaveBeenCalledOnce(); expect(f.pools.foundation.end).not.toHaveBeenCalled();
  });
  it('keeps the shared startup budget when its first caller has a short deadline', async () => {
    vi.useFakeTimers(); const f = fixture(), pending = deferred<typeof f.pools.foundation>();
    f.dependencies.openFoundation.mockImplementation(() => pending.promise);
    const short = f.load(Date.now() + 2000).catch(error => error), longer = f.load(Date.now() + 15000);
    await flush(); await vi.advanceTimersByTimeAsync(2000);
    expect(String(await short)).toContain('initialization failed');
    await vi.advanceTimersByTimeAsync(1000); pending.resolve(f.pools.foundation);
    expect(await longer).toBe(f.app); expect(await f.load()).toBe(f.app);
    expect(f.dependencies.openFoundation).toHaveBeenCalledOnce(); expect(f.pools.foundation.end).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('rejects invalid deadlines before reading configuration', async () => {
    const f = fixture();
    for (const deadline of [NaN, Infinity, 0, Date.now(), Date.now() + 500]) await expect(f.load(deadline)).rejects.toThrow('initialization failed');
    expect(f.dependencies.readConfig).not.toHaveBeenCalled();
  });
  it('closes all pools on a composition failure', async () => {
    const f = fixture(); f.dependencies.compose.mockImplementation(() => { throw Error('sensitive-composition'); });
    await expect(f.load()).rejects.toThrow('initialization failed');
    for (const pool of Object.values(f.pools)) expect(pool.end).toHaveBeenCalledOnce();
    expect(f.dependencies.attach).not.toHaveBeenCalled();
  });
  it('bounds cleanup even if one pool never acknowledges shutdown', async () => {
    vi.useFakeTimers(); const f = fixture(); f.pools.foundation.end.mockImplementation(() => new Promise(() => {}));
    f.dependencies.compose.mockImplementation(() => { throw Error('failed'); });
    const result = f.load().catch(error => error); await flush(); await vi.advanceTimersByTimeAsync(1000);
    expect(String(await result)).toContain('initialization failed'); expect(vi.getTimerCount()).toBe(0);
    for (const pool of Object.values(f.pools)) expect(pool.end).toHaveBeenCalledOnce();
  });
});
