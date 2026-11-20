import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ query: vi.fn(), end: vi.fn(), on: vi.fn(), create: vi.fn(), qualify: vi.fn() }));
vi.mock('pg', () => ({ Pool: class {
  constructor(options: unknown) { mocks.create(options); }
  query = mocks.query; end = mocks.end; on = mocks.on;
} }));
vi.mock('./native-delegation-pool', () => ({ assertNativeDelegationPool: mocks.qualify }));
import { createNativeWorkProtocolPool } from './native-work-protocol-pool';
describe('work conversation rollout admission', () => {
  beforeEach(() => { vi.resetAllMocks(); mocks.end.mockResolvedValue(undefined); mocks.qualify.mockResolvedValue(undefined); });
  it('admits activity only as the complete extended workspace profile', async () => {
    mocks.query.mockResolvedValue({ rows: [{ instructions: true, conversation: true, activity: true, execution: false }] });
    const result = await createNativeWorkProtocolPool('protected', 'simulation');
    expect(result.activity).toBe(true);
    expect(mocks.qualify).toHaveBeenCalledExactlyOnceWith(result.pool, 'simulation', 'api', 'delegation-workspace-activity');
  });
  it('enables only the admitted optional execution reader', async () => {
    mocks.query.mockResolvedValue({ rows: [{ instructions: true, conversation: true, activity: true, execution: true }] });
    expect((await createNativeWorkProtocolPool('protected', 'simulation')).execution).toBe(true);
  });
  it.each([undefined, 'true', true])('rejects malformed or standalone execution capability %s', async execution => {
    mocks.query.mockResolvedValue({ rows: [{ instructions: true, conversation: true, activity: false, execution }] });
    await expect(createNativeWorkProtocolPool('protected', 'simulation')).rejects.toMatchObject({ code: 'UNSAFE_DATABASE_ROLE' });
    expect(mocks.qualify).not.toHaveBeenCalled();
  });
  it('rejects an activity reader without the instruction lineage protocol', async () => {
    mocks.query.mockResolvedValue({ rows: [{ instructions: false, conversation: false, activity: true, execution: false }] });
    await expect(createNativeWorkProtocolPool('protected', 'simulation')).rejects.toMatchObject({ code: 'UNSAFE_DATABASE_ROLE' });
    expect(mocks.qualify).not.toHaveBeenCalled(); expect(mocks.end).toHaveBeenCalledOnce();
  });
  it.each([false, true])('admits the complete profile for instructions=%s', async instructions => {
    mocks.query.mockResolvedValue({ rows: [{ instructions, conversation: instructions, activity: false, execution: false }] });
    const result = await createNativeWorkProtocolPool('protected', 'simulation');
    expect(result.instructions).toBe(instructions);
    expect(mocks.qualify).toHaveBeenCalledExactlyOnceWith(result.pool, 'simulation', 'api', instructions ? 'delegation-workspace-instructions' : 'delegation-workspace');
    expect(mocks.query).toHaveBeenCalledOnce(); expect(mocks.end).not.toHaveBeenCalled();
  });
  it.each([
    [], [{ instructions: true, conversation: false }], [{ instructions: false, conversation: true }],
    [{ instructions: 'true', conversation: true }], [{ instructions: false }],
    [{ instructions: true, conversation: true, activity: false, execution: false }, { instructions: true, conversation: true, activity: false, execution: false }],
  ].map(rows => ({ rows })))('rejects an incomplete or malformed protocol snapshot %#', async ({ rows }) => {
    mocks.query.mockResolvedValue({ rows });
    await expect(createNativeWorkProtocolPool('protected', 'simulation')).rejects.toMatchObject({ code: 'UNSAFE_DATABASE_ROLE' });
    expect(mocks.qualify).not.toHaveBeenCalled(); expect(mocks.end).toHaveBeenCalledOnce();
  });
  it('does not fall back after extra or missing privileges fail admission', async () => {
    mocks.query.mockResolvedValue({ rows: [{ instructions: true, conversation: true, activity: false, execution: false }] }); mocks.qualify.mockRejectedValue(Error('private database details'));
    await expect(createNativeWorkProtocolPool('protected', 'simulation')).rejects.toMatchObject({ message: 'The work protocol could not be verified.' });
    expect(mocks.qualify).toHaveBeenCalledOnce(); expect(mocks.end).toHaveBeenCalledOnce();
  });
  it('closes after a transport failure without exposing diagnostics', async () => {
    mocks.query.mockRejectedValue(Error('private transport details')); mocks.end.mockRejectedValue(Error('private shutdown details'));
    await expect(createNativeWorkProtocolPool('protected', 'simulation')).rejects.toMatchObject({ message: 'The work protocol could not be verified.' });
    expect(mocks.query).toHaveBeenCalledOnce(); expect(mocks.qualify).not.toHaveBeenCalled();
  });
});
