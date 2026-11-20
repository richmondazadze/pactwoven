import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ resources: vi.fn() }));
vi.mock('./delegated-runtime.js', () => ({ nativeDelegatedResources: mocks.resources }));
beforeEach(() => { vi.resetModules(); vi.resetAllMocks(); });
const authority = { repository: {}, observe: vi.fn(), issuer: 'https://fixture.clerk.accounts.dev' };
describe('delegated authority shared-resource adapter', () => {
  it('stays lazy and returns the exact shared authority without exposing app or work intent resources', async () => {
    mocks.resources.mockResolvedValue({ authority, app: { fetch: vi.fn() }, workIntent: { provenance: vi.fn() } });
    const { nativeDelegatedAuthorityResources } = await import('./delegated-authority-runtime.js');
    expect(mocks.resources).not.toHaveBeenCalled();
    expect(await nativeDelegatedAuthorityResources()).toBe(authority);
    expect(mocks.resources).toHaveBeenCalledOnce();
  });
  it('allows concurrent callers to receive the same initializer-owned authority', async () => {
    let resolve!: (value: { authority: typeof authority }) => void;
    const pending = new Promise<{ authority: typeof authority }>(yes => { resolve = yes; });
    mocks.resources.mockReturnValue(pending);
    const { nativeDelegatedAuthorityResources } = await import('./delegated-authority-runtime.js');
    const first = nativeDelegatedAuthorityResources(), second = nativeDelegatedAuthorityResources();
    resolve({ authority });expect(await first).toBe(authority);expect(await second).toBe(authority);
    expect(mocks.resources).toHaveBeenCalledTimes(2);
  });
  it('propagates the shared safe initialization failure and permits its next attempt', async () => {
    const error = Error('Delegated service initialization failed.');
    mocks.resources.mockRejectedValueOnce(error).mockResolvedValueOnce({ authority });
    const { nativeDelegatedAuthorityResources } = await import('./delegated-authority-runtime.js');
    await expect(nativeDelegatedAuthorityResources()).rejects.toBe(error);
    expect(await nativeDelegatedAuthorityResources()).toBe(authority);expect(mocks.resources).toHaveBeenCalledTimes(2);
  });
});
