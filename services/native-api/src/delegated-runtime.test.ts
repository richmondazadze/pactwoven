import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({
  foundation: { end: vi.fn(async () => undefined) }, delegated: { end: vi.fn(async () => undefined) },
  createFoundation: vi.fn(), createDelegated: vi.fn(), attach: vi.fn(), createApp: vi.fn(),
  verifyObserved: vi.fn(), observeAuthority: vi.fn(), readBase: vi.fn(), readDelegated: vi.fn(),
  instructions: false, activity: false, createActivity: vi.fn(), createConversation: vi.fn(), createWorkIntent: vi.fn(), workIntent: { provenance: vi.fn() },
}));
vi.mock('@vercel/functions', () => ({ attachDatabasePool: f.attach }));
vi.mock('@pactwoven/api/native-host', () => ({ createNativeTaskApp: f.createApp, createClerkIdentityObservationVerifier: f.verifyObserved }));
vi.mock('@pactwoven/db', () => ({ createRuntimePool: f.createFoundation, createNativeDelegationPool: f.createDelegated,
  PostgresFoundationRepository: class {}, PostgresNativeMemoryNotesRepository: class {},
  PostgresNativeRootRepository: class {}, PostgresNativeWorkIntentRepository: f.createWorkIntent, PostgresNativeAgentWorkListRepository: class {}, PostgresNativeDelegationRepository: class {} }));
vi.mock('../../../packages/db/src/native-work-protocol-pool', () => ({ createNativeWorkProtocolPool: (...args: unknown[]) => f.createDelegated(...args).then((pool: typeof f.delegated) => ({ pool, instructions: f.instructions, activity: f.activity })) }));
vi.mock('../../../packages/db/src/native-work-conversation-repository', () => ({ PostgresNativeWorkConversationRepository: f.createConversation }));
vi.mock('../../../packages/db/src/native-work-activity-repository', () => ({ PostgresNativeWorkActivityRepository: f.createActivity }));
vi.mock('./config.js', () => ({ readNativeApiConfig: f.readBase, readNativeDelegatedApiConfig: f.readDelegated }));
vi.mock('./delegated-provider-authority.js', () => ({ createClerkDelegatedProviderAuthorityObserver: f.observeAuthority }));
beforeEach(() => {
  vi.resetModules();vi.resetAllMocks();f.instructions = false; f.activity = false;
  f.createConversation.mockImplementation(function () { return {}; });
  f.createActivity.mockImplementation(function () { return {}; });
  f.foundation.end.mockResolvedValue(undefined);f.delegated.end.mockResolvedValue(undefined);
  f.createFoundation.mockResolvedValue(f.foundation);f.createDelegated.mockResolvedValue(f.delegated);
  f.createApp.mockReturnValue({ fetch: vi.fn() });f.attach.mockReturnValue(undefined);
  f.verifyObserved.mockReturnValue(vi.fn());f.observeAuthority.mockReturnValue(vi.fn());
  f.readBase.mockReturnValue({ foundationDatabaseUrl: 'protected-foundation', allowedOrigins: ['https://app.example'] });
  f.readDelegated.mockReturnValue({ environment: 'development', delegationDatabaseUrl: 'protected-delegation', identity: { issuer: 'https://identity.example' } });
  f.createWorkIntent.mockImplementation(function () { return f.workIntent; });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; });return { promise, resolve }; }
async function flush() { for (let index = 0; index < 30; index++) await Promise.resolve(); }
describe('shared delegated API initialization', () => {
  it.each(['key', 'voice'] as const)('keeps core work available when optional voice %s configuration is invalid', async field => {
    vi.stubEnv('ELEVENLABS_API_KEY', field === 'key' ? 'invalid whitespace key' : 'synthetic-review-key');
    vi.stubEnv('ELEVENLABS_VOICE_ID', field === 'voice' ? '../invalid-voice' : 'valid_voice');
    const { nativeWorkApp } = await import('./delegated-runtime');
    const app = await nativeWorkApp();
    expect(app).toHaveProperty('fetch');
    expect(f.createApp.mock.calls[0]![0].nativeVoiceGateway).toBeUndefined();
    expect(f.foundation.end).not.toHaveBeenCalled(); expect(f.delegated.end).not.toHaveBeenCalled();
    expect(f.attach).toHaveBeenCalledTimes(2);
  });
  it('mounts a valid optional voice gateway without contacting its provider', async () => {
    vi.stubEnv('ELEVENLABS_API_KEY', 'synthetic-review-key'); vi.stubEnv('ELEVENLABS_VOICE_ID', 'valid_voice');
    const { nativeWorkApp } = await import('./delegated-runtime'); await nativeWorkApp();
    expect(f.createApp.mock.calls[0]![0].nativeVoiceGateway).toMatchObject({ transcribe: expect.any(Function), speak: expect.any(Function) });
  });
  it('mounts activity only when the complete activity profile is admitted', async () => {
    f.instructions = true; f.activity = true;
    const { nativeWorkApp } = await import('./delegated-runtime'); await nativeWorkApp();
    expect(f.createActivity).toHaveBeenCalledExactlyOnceWith(f.delegated, 'development');
    expect(f.createApp.mock.calls[0]![0].nativeWorkActivityRepository).toBeDefined();
  });
  it('constructs conversation access only after the complete instruction profile is admitted', async () => {
    f.instructions = true;
    const { nativeWorkApp } = await import('./delegated-runtime');
    await nativeWorkApp();
    expect(f.createConversation).toHaveBeenCalledExactlyOnceWith(f.delegated, 'development');
    expect(f.createApp.mock.calls[0]![0].nativeWorkConversationRepository).toBeDefined();
    expect(f.attach).toHaveBeenCalledTimes(2);
  });
  it('does not connect on import, then shares one exact admitted pool across all v2 surfaces', async () => {
    const { nativeWorkApp } = await import('./delegated-runtime');
    const { nativeMemoryApp } = await import('./memory-runtime');
    const { nativeDelegatedAuthorityResources } = await import('./delegated-authority-runtime');
    expect(f.createDelegated).not.toHaveBeenCalled();
    const [work, memory, authority] = await Promise.all([nativeWorkApp(), nativeMemoryApp(), nativeDelegatedAuthorityResources()]);
    expect(work).toBe(memory);expect(authority.issuer).toBe('https://identity.example');
    expect(f.createDelegated).toHaveBeenCalledExactlyOnceWith('protected-delegation', 'development');
    expect(f.createConversation).not.toHaveBeenCalled();
    expect(f.createFoundation).toHaveBeenCalledOnce();expect(f.verifyObserved).toHaveBeenCalledOnce();
    expect(f.createApp.mock.calls[0]![0]).toHaveProperty('verifyObservedIdentity');
    expect(f.attach).toHaveBeenCalledTimes(2);
    const resources = await (await import('./delegated-runtime')).nativeDelegatedResources();
    expect(resources.workIntent).toBe(f.workIntent);expect(f.createApp.mock.calls[0]![0].nativeWorkIntentRepository).toBe(resources.workIntent);
    expect(f.createWorkIntent).toHaveBeenCalledExactlyOnceWith(f.delegated, 'development');
  });
  it('closes a partial foundation pool when role admission fails and permits a fresh initialization', async () => {
    f.createDelegated.mockRejectedValueOnce(Error('private-credential-details'));
    const { nativeWorkApp } = await import('./delegated-runtime');
    await expect(nativeWorkApp()).rejects.toThrow('Delegated service initialization failed.');
    expect(f.foundation.end).toHaveBeenCalledOnce();expect(f.delegated.end).not.toHaveBeenCalled();expect(f.attach).not.toHaveBeenCalled();
    await nativeWorkApp();expect(f.createDelegated).toHaveBeenCalledTimes(2);
  });
  it('closes both owned pools if app creation fails without exposing its exception', async () => {
    f.createApp.mockImplementationOnce(() => { throw Error('private-key-value'); });
    const { nativeWorkApp } = await import('./delegated-runtime');
    await expect(nativeWorkApp()).rejects.toThrow('Delegated service initialization failed.');
    expect(f.foundation.end).toHaveBeenCalledOnce();expect(f.delegated.end).toHaveBeenCalledOnce();expect(f.attach).not.toHaveBeenCalled();
  });
  it.each(['foundation', 'delegated'] as const)('bounds stalled %s admission and closes its late result', async purpose => {
    vi.useFakeTimers();const pending = deferred<typeof f.foundation>();
    (purpose === 'foundation' ? f.createFoundation : f.createDelegated).mockImplementationOnce(() => pending.promise);
    const { nativeDelegatedResources } = await import('./delegated-runtime');
    const outcome = nativeDelegatedResources().catch(error => error);await flush();
    await vi.advanceTimersByTimeAsync(10000);expect(String(await outcome)).toBe('Error: Delegated service initialization failed.');
    expect(f.attach).not.toHaveBeenCalled();expect(f.createApp).not.toHaveBeenCalled();
    pending.resolve(f[purpose]);await flush();expect(f[purpose].end).toHaveBeenCalledOnce();
    if (purpose === 'delegated') expect(f.foundation.end).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('resets a timed-out cache without allowing its late pool to replace a new initialization', async () => {
    vi.useFakeTimers();const pending = deferred<typeof f.foundation>(), old = { end: vi.fn(async () => undefined) };
    f.createFoundation.mockImplementationOnce(() => pending.promise);
    const { nativeDelegatedResources } = await import('./delegated-runtime');
    const outcome = nativeDelegatedResources().catch(error => error);await flush();await vi.advanceTimersByTimeAsync(10000);await outcome;
    const resources = await nativeDelegatedResources();pending.resolve(old);await flush();
    expect(await nativeDelegatedResources()).toBe(resources);expect(f.createFoundation).toHaveBeenCalledTimes(2);
    expect(old.end).toHaveBeenCalledOnce();expect(f.foundation.end).not.toHaveBeenCalled();expect(f.delegated.end).not.toHaveBeenCalled();
    expect(f.attach.mock.calls).toEqual([[f.foundation], [f.delegated]]);expect(vi.getTimerCount()).toBe(0);
  });
  it('shares one total bootstrap budget across sequential pool admissions', async () => {
    vi.useFakeTimers();const foundation = deferred<typeof f.foundation>(), delegated = deferred<typeof f.delegated>();
    f.createFoundation.mockImplementationOnce(() => foundation.promise);f.createDelegated.mockImplementationOnce(() => delegated.promise);
    const { nativeDelegatedResources } = await import('./delegated-runtime');
    const outcome = nativeDelegatedResources().catch(error => error);await flush();
    await vi.advanceTimersByTimeAsync(8000);foundation.resolve(f.foundation);await flush();
    await vi.advanceTimersByTimeAsync(2000);expect(String(await outcome)).toContain('initialization failed');
    delegated.resolve(f.delegated);await flush();expect(f.foundation.end).toHaveBeenCalledOnce();expect(f.delegated.end).toHaveBeenCalledOnce();
    expect(f.createApp).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
  });
  it('uses a caller-supplied earlier deadline and reserves cleanup time', async () => {
    vi.useFakeTimers();const pending = deferred<typeof f.delegated>();f.createDelegated.mockImplementationOnce(() => pending.promise);
    const { nativeDelegatedResources } = await import('./delegated-runtime');
    const outcome = nativeDelegatedResources(Date.now() + 4000).catch(error => error);await flush();
    await vi.advanceTimersByTimeAsync(3000);expect(String(await outcome)).toContain('initialization failed');
    expect(f.foundation.end).toHaveBeenCalledOnce();pending.resolve(f.delegated);await flush();expect(f.delegated.end).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('bounds a shorter concurrent caller without abandoning another caller’s valid shared initialization', async () => {
    vi.useFakeTimers();const pending = deferred<typeof f.foundation>();f.createFoundation.mockImplementationOnce(() => pending.promise);
    const { nativeDelegatedResources } = await import('./delegated-runtime');
    const first = nativeDelegatedResources(), shorter = nativeDelegatedResources(Date.now() + 2000).catch(error => error);await flush();
    await vi.advanceTimersByTimeAsync(2000);expect(String(await shorter)).toContain('initialization failed');
    pending.resolve(f.foundation);expect((await first).workIntent).toBe(f.workIntent);expect(f.createFoundation).toHaveBeenCalledOnce();
    expect(f.foundation.end).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
  });
  it('checks actual time when a pool arrives before a delayed timeout callback', async () => {
    vi.useFakeTimers();const pending = deferred<typeof f.foundation>();f.createFoundation.mockImplementationOnce(() => pending.promise);
    const { nativeDelegatedResources } = await import('./delegated-runtime');
    const outcome = nativeDelegatedResources().catch(error => error);await flush();vi.setSystemTime(Date.now() + 10001);
    pending.resolve(f.foundation);expect(String(await outcome)).toContain('initialization failed');await flush();
    expect(f.foundation.end).toHaveBeenCalledOnce();expect(f.createDelegated).not.toHaveBeenCalled();expect(f.attach).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
  });
  it('attempts both pool shutdowns when the first throws synchronously', async () => {
    f.createApp.mockImplementationOnce(() => { throw Error('private-app-detail'); });
    f.foundation.end.mockImplementationOnce(() => { throw Error('private-end-detail'); });
    const { nativeDelegatedResources } = await import('./delegated-runtime');
    await expect(nativeDelegatedResources()).rejects.toThrow('Delegated service initialization failed.');
    expect(f.foundation.end).toHaveBeenCalledOnce();expect(f.delegated.end).toHaveBeenCalledOnce();
  });
  it('limits the wait for shutdown that never settles and retries initialization on the next request', async () => {
    vi.useFakeTimers();f.createApp.mockImplementationOnce(() => { throw Error('private-app-detail'); });
    f.foundation.end.mockImplementationOnce(() => new Promise(() => {}));
    const { nativeDelegatedResources } = await import('./delegated-runtime');
    const outcome = nativeDelegatedResources().catch(error => error);await flush();
    expect(f.delegated.end).toHaveBeenCalledOnce();await vi.advanceTimersByTimeAsync(1000);expect(String(await outcome)).toContain('initialization failed');
    expect((await nativeDelegatedResources()).workIntent).toBe(f.workIntent);expect(f.createFoundation).toHaveBeenCalledTimes(2);expect(vi.getTimerCount()).toBe(0);
  });
  it('closes both pools when attachment fails and does not cache the composed app', async () => {
    f.attach.mockImplementationOnce(() => { throw Error('private-attach-detail'); });
    const { nativeDelegatedResources } = await import('./delegated-runtime');
    await expect(nativeDelegatedResources()).rejects.toThrow('Delegated service initialization failed.');
    expect(f.foundation.end).toHaveBeenCalledOnce();expect(f.delegated.end).toHaveBeenCalledOnce();
    await nativeDelegatedResources();expect(f.createApp).toHaveBeenCalledTimes(2);
  });
  it('refuses to cache or attach a composition that crosses the bootstrap deadline', async () => {
    vi.useFakeTimers();f.createApp.mockImplementationOnce(() => { vi.setSystemTime(Date.now() + 10001);return { fetch: vi.fn() }; });
    const { nativeDelegatedResources } = await import('./delegated-runtime');
    await expect(nativeDelegatedResources()).rejects.toThrow('Delegated service initialization failed.');
    expect(f.attach).not.toHaveBeenCalled();expect(f.foundation.end).toHaveBeenCalledOnce();expect(f.delegated.end).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([NaN, Infinity, 1.1, 0])('rejects invalid or expired deadline %s before opening a pool', async deadline => {
    const { nativeDelegatedResources } = await import('./delegated-runtime');
    await expect(nativeDelegatedResources(deadline)).rejects.toThrow('Delegated service initialization failed.');expect(f.createFoundation).not.toHaveBeenCalled();
  });
});
