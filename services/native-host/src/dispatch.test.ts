import { describe, expect, it, vi } from 'vitest';
import type { NativeDispatchPublication, NativeDispatchPublisherRepository } from '@pactwoven/contracts';
import { publishNativeDispatch, type QueueSend } from './dispatch.js';
const now = Date.parse('2026-11-18T12:00:00.000Z');
const publication: NativeDispatchPublication = { message: { schemaVersion: 1, engineRevision: 'native-advice-v1', environment: 'development',
  organizationId: 'org_a', taskId: 'task_a', generation: 1 }, publicationToken: '42f80c74-8c92-400a-a69f-b1f5f22885d4',
  idempotencyKey: `native-${'a'.repeat(64)}`, notBefore: new Date(now).toISOString() };
function repository(): NativeDispatchPublisherRepository {
  return { claimPublications: vi.fn().mockResolvedValueOnce([publication]).mockResolvedValue([]),
    acknowledgePublication: vi.fn(async () => true), retryPublication: vi.fn(async () => true),
    recoverDue: vi.fn() };
}
describe('durable native queue publisher', () => {
  it('sends IDs only and acknowledges accepted delivery even without an immediate message ID', async () => {
    const store = repository(); const send = vi.fn(async () => ({ messageId: null }));
    expect(await publishNativeDispatch({ repository: store, send, now: () => now, deadlineAt: now + 60_000 })).toEqual({ accepted: 1, unconfirmed: 0 });
    expect(send).toHaveBeenCalledWith(publication.message, { idempotencyKey: publication.idempotencyKey, retentionSeconds: 86400, delaySeconds: 0 });
    expect(store.acknowledgePublication).toHaveBeenCalledWith(publication);
  });
  it('preserves publication identity after an unknown send result or unknown acknowledgement commit', async () => {
    for (const failAck of [false, true]) {
      const store = repository(); const send = vi.fn(async () => { if (!failAck) throw Error('unconfirmed'); });
      if (failAck) vi.mocked(store.acknowledgePublication).mockRejectedValueOnce(Error('commit unknown'));
      expect(await publishNativeDispatch({ repository: store, send, now: () => now, deadlineAt: now + 60_000 })).toEqual({ accepted: 0, unconfirmed: 1 });
      expect(store.retryPublication).toHaveBeenCalledWith(publication, 30000);
      expect(store.claimPublications).toHaveBeenCalledOnce();
    }
  });
  it('does not claim new work too close to the invocation deadline', async () => {
    const store = repository(); const send = vi.fn();
    expect(await publishNativeDispatch({ repository: store, send, now: () => now, deadlineAt: now + 10000 })).toEqual({ accepted: 0, unconfirmed: 0 });
    expect(store.claimPublications).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  });
  it('rechecks time consumed by the claim and never sends past the remaining reserve', async () => {
    for (const elapsed of [15_000, 26_000]) {
      const store = repository(); let clock = now;
      vi.mocked(store.claimPublications).mockReset().mockImplementation(async () => { clock += elapsed; return [publication]; });
      const send = vi.fn();
      await publishNativeDispatch({ repository: store, send, now: () => clock, deadlineAt: now + 25_000 });
      expect(send).not.toHaveBeenCalled();
      if (elapsed === 15_000) expect(store.retryPublication).toHaveBeenCalledWith(publication, 30000);
      else expect(store.retryPublication).not.toHaveBeenCalled();
    }
  });
  it('keeps not-before scheduling and bounds batch size', async () => {
    const store = repository(); vi.mocked(store.claimPublications).mockReset().mockResolvedValue([{ ...publication, notBefore: new Date(now + 30000).toISOString() }]);
    const send = vi.fn<QueueSend>(async () => undefined);
    expect((await publishNativeDispatch({ repository: store, send, now: () => now, deadlineAt: now + 60000 })).accepted).toBe(5);
    expect(send).toHaveBeenCalledTimes(5); expect(send.mock.calls[0]?.[1]).toMatchObject({ delaySeconds: 30 });
  });
  it('fails before sending if storage includes a private payload field', async () => {
    const store = repository();
    const malformed = { ...publication, message: { ...publication.message, prompt: 'private objective' } };
    vi.mocked(store.claimPublications).mockReset().mockResolvedValue([malformed]);
    const send = vi.fn();
    await expect(publishNativeDispatch({ repository: store, send, now: () => now, deadlineAt: now + 60000 })).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
});
