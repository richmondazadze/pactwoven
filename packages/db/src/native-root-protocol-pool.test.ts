import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ query: vi.fn(), end: vi.fn(), on: vi.fn(), create: vi.fn(), qualify: vi.fn() }));
vi.mock('pg', () => ({ Pool: class {
  constructor(options: unknown) { mocks.create(options); }
  query = mocks.query; end = mocks.end; on = mocks.on;
} }));
vi.mock('./native-delegation-pool', () => ({ assertNativeDelegationPool: mocks.qualify }));
import { createNativeRootProtocolPool } from './native-root-protocol-pool';

describe('root protocol rollout admission', () => {
  beforeEach(() => { vi.resetAllMocks(); mocks.end.mockResolvedValue(undefined); mocks.qualify.mockResolvedValue(undefined); });
  it.each([false, true])('qualifies exactly one fixed profile when refresh is %s', async refresh => {
    mocks.query.mockResolvedValue({ rows: [{ refresh, instructions: false, paid: false }] });
    const result = await createNativeRootProtocolPool('protected', 'simulation', 'coordinator');
    expect(result.protocol).toBe(refresh ? 'refresh' : 'legacy');
    expect(mocks.qualify).toHaveBeenCalledExactlyOnceWith(result.pool, 'simulation', 'coordinator', refresh ? 'delegation-root-refresh' : 'delegation-root');
    expect(mocks.query).toHaveBeenCalledTimes(1); expect(mocks.end).not.toHaveBeenCalled();
  });
  it('never falls back after a partial or overprivileged refresh role fails admission', async () => {
    mocks.query.mockResolvedValue({ rows: [{ refresh: true, instructions: false, paid: false }] }); mocks.qualify.mockRejectedValue(Error('private diagnosis'));
    await expect(createNativeRootProtocolPool('protected', 'simulation', 'worker')).rejects.toMatchObject({ code: 'UNSAFE_DATABASE_ROLE', message: 'The root protocol could not be verified.' });
    expect(mocks.qualify).toHaveBeenCalledTimes(1); expect(mocks.end).toHaveBeenCalledTimes(1);
  });
  it.each([{ rows: [] }, { rows: [{ refresh: 'true' }] }, { rows: [{ refresh: false }, { refresh: true }] }])('rejects malformed catalog response before role admission', async ({ rows }) => {
    mocks.query.mockResolvedValue({ rows });
    await expect(createNativeRootProtocolPool('protected', 'simulation', 'worker')).rejects.toMatchObject({ code: 'UNSAFE_DATABASE_ROLE' });
    expect(mocks.qualify).not.toHaveBeenCalled(); expect(mocks.end).toHaveBeenCalledTimes(1);
  });
  it('closes an unavailable transport without retry or credential diagnostics', async () => {
    mocks.query.mockRejectedValue(Error('credential-bearing transport error')); mocks.end.mockRejectedValue(Error('close error'));
    await expect(createNativeRootProtocolPool('protected', 'simulation', 'worker')).rejects.toMatchObject({ message: 'The root protocol could not be verified.' });
    expect(mocks.query).toHaveBeenCalledTimes(1); expect(mocks.qualify).not.toHaveBeenCalled();
  });
  it('rejects a human audience before opening a pool', async () => {
    await expect(createNativeRootProtocolPool('protected', 'simulation', 'api' as never)).rejects.toMatchObject({ code: 'UNSAFE_DATABASE_ROLE' });
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it.each(['coordinator', 'worker'] as const)('selects the complete instruction profile for %s', async purpose => {
    mocks.query.mockResolvedValue({ rows: [{ refresh: true, instructions: true, paid: false }] });
    const result = await createNativeRootProtocolPool('protected', 'simulation', purpose);
    expect(result.protocol).toBe('instructions');
    expect(mocks.qualify).toHaveBeenCalledExactlyOnceWith(result.pool, 'simulation', purpose, 'delegation-root-instructions');
  });
  it('rejects an instruction marker without the required refresh protocol', async () => {
    mocks.query.mockResolvedValue({ rows: [{ refresh: false, instructions: true, paid: false }] });
    await expect(createNativeRootProtocolPool('protected', 'simulation', 'worker')).rejects.toMatchObject({ code: 'UNSAFE_DATABASE_ROLE' });
    expect(mocks.qualify).not.toHaveBeenCalled(); expect(mocks.end).toHaveBeenCalledOnce();
  });
  it.each(['coordinator','worker'] as const)('qualifies paid roots without expanding %s unnecessarily',async purpose=>{
    mocks.query.mockResolvedValue({rows:[{refresh:true,instructions:true,paid:true}]});
    const result=await createNativeRootProtocolPool('protected','development',purpose);
    expect(mocks.qualify).toHaveBeenCalledExactlyOnceWith(result.pool,'development',purpose,purpose==='coordinator'?'delegation-root-paid':'delegation-root-instructions');
  });
  it('rejects a paid marker before instructions are installed',async()=>{
    mocks.query.mockResolvedValue({rows:[{refresh:true,instructions:false,paid:true}]});
    await expect(createNativeRootProtocolPool('protected','development','coordinator')).rejects.toMatchObject({code:'UNSAFE_DATABASE_ROLE'});
    expect(mocks.qualify).not.toHaveBeenCalled();
  });

});
