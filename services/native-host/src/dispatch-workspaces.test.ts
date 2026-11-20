import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const calls = vi.hoisted(() => ({ legacyPublish: vi.fn(), legacyRecover: vi.fn(), delegatedPublish: vi.fn(), delegatedRecover: vi.fn() }));
vi.mock('./dispatch-runtime', () => ({ publishNativeWork: calls.legacyPublish, recoverNativeWork: calls.legacyRecover }));
vi.mock('./delegated-host-runtime', () => ({ publishDelegatedHostWork: calls.delegatedPublish, recoverDelegatedHostWork: calls.delegatedRecover }));
import { publishWorkspaceWork, recoverWorkspaceWork } from './dispatch-workspaces';
beforeEach(() => { for (const call of Object.values(calls)) call.mockReset().mockResolvedValue(undefined); });
afterEach(() => { vi.useRealTimers(); });

it.each(['publish', 'recover'] as const)('starts both %s scans before either completes and preserves their absolute deadline', async operation => {
  let finish!: () => void;
  const legacy = operation === 'publish' ? calls.legacyPublish : calls.legacyRecover;
  const delegated = operation === 'publish' ? calls.delegatedPublish : calls.delegatedRecover;
  legacy.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  const deadline = Date.now() + 45000;
  const pending = operation === 'publish' ? publishWorkspaceWork(deadline) : recoverWorkspaceWork(deadline);
  await Promise.resolve();
  expect(delegated).toHaveBeenCalledExactlyOnceWith(deadline);
  expect(legacy).toHaveBeenCalledExactlyOnceWith(deadline);
  finish(); await pending;
});
it('bounds a stalled scan without cancelling the other queue or retrying either scan', async () => {
  vi.useFakeTimers();calls.legacyRecover.mockImplementation(() => new Promise(() => {}));
  const pending = recoverWorkspaceWork(Date.now() + 2000);
  const rejection = expect(pending).rejects.toThrow('Background dispatch remains pending.');
  await vi.advanceTimersByTimeAsync(2000);await rejection;
  expect(calls.delegatedRecover).toHaveBeenCalledOnce();expect(calls.legacyRecover).toHaveBeenCalledOnce();
});
it('rejects expired or invalid invocation deadlines before starting either queue', async () => {
  for (const deadline of [Date.now() - 1, NaN, Infinity]) await expect(publishWorkspaceWork(deadline)).rejects.toThrow('Background dispatch remains pending.');
  expect(calls.delegatedPublish).not.toHaveBeenCalled();expect(calls.legacyPublish).not.toHaveBeenCalled();
});

it.each(['legacyPublish', 'delegatedPublish', 'legacyRecover', 'delegatedRecover'] as const)('allows the other outbox to progress when %s fails without exposing private failures', async failed => {
  calls[failed].mockRejectedValue(Error('private database credential'));
  const publishing = failed.endsWith('Publish'), deadline = Date.now() + 45000;
  await expect(publishing ? publishWorkspaceWork(deadline) : recoverWorkspaceWork(deadline)).rejects.toThrow('Background dispatch remains pending.');
  expect(publishing ? calls.legacyPublish : calls.legacyRecover).toHaveBeenCalledOnce();
  expect(publishing ? calls.delegatedPublish : calls.delegatedRecover).toHaveBeenCalledOnce();
});
