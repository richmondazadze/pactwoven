import { describe, expect, it, vi } from 'vitest';
import type { NativeDispatchMessage, NativeDispatchWorkerRepository } from '@pactwoven/contracts';
import type { NativeCoordinator } from '@pactwoven/coordinator';
import { consumeNativeDispatch, NativeDeliveryRetry } from './consume.js';
const now = Date.parse('2026-11-18T12:00:00.000Z');
const message: NativeDispatchMessage = { schemaVersion: 1, engineRevision: 'native-advice-v1', environment: 'development', organizationId: 'org_a', taskId: 'task_a', generation: 1 };
function fixture() {
  const repository: NativeDispatchWorkerRepository = { claimTarget: vi.fn(async () => ({ kind: 'stale' as const })), yieldClaim: vi.fn() };
  const coordinator: Pick<NativeCoordinator, 'runClaimSlice'> = { runClaimSlice: vi.fn() };
  return { repository, coordinator, environment: 'development' as const, workerId: 'worker_a', now: () => now, deadlineAt: now + 300000 };
}
const claim = { environment: 'development' as const, organizationId: 'org_a', actorId: 'actor_a',
  leaseToken: '42f80c74-8c92-400a-a69f-b1f5f22885d4', checkpoint: {}, task: { id: 'task_a', title: 'Compare options', siteId: 'site_a',
    status: 'running' as const, phase: 'Working', createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
    version: 1, availableActions: ['pause' as const], prompt: 'Compare my options', mode: 'advise' as const,
    steps: [], messages: [], artifacts: [], events: [] } };
describe('native private queue consumer', () => {
  it('rejects malformed, private, cross-environment and incompatible dispatch before storage', async () => {
    const deps = fixture();
    for (const payload of [null, { ...message, prompt: 'private' }, { ...message, environment: 'production' }, { ...message, engineRevision: 'other' }]) {
      expect(await consumeNativeDispatch(payload, deps)).toBe('discarded');
    }
    expect(deps.repository.claimTarget).not.toHaveBeenCalled(); expect(deps.coordinator.runClaimSlice).not.toHaveBeenCalled();
  });
  it('acknowledges stale and inactive messages without model execution', async () => {
    for (const kind of ['stale', 'not_found', 'inactive', 'revoked', 'revision_mismatch', 'quarantined'] as const) {
      const deps = fixture(); vi.mocked(deps.repository.claimTarget).mockResolvedValue({ kind });
      expect(await consumeNativeDispatch(message, deps)).toBe('discarded'); expect(deps.coordinator.runClaimSlice).not.toHaveBeenCalled();
    }
  });
  it('delays lease contention and future work rather than dropping or executing it', async () => {
    for (const kind of ['busy', 'not_ready'] as const) {
      const deps = fixture(); vi.mocked(deps.repository.claimTarget).mockResolvedValue({ kind, retryAfterMilliseconds: 2501 });
      await expect(consumeNativeDispatch(message, deps)).rejects.toMatchObject({ afterSeconds: 3 });
      expect(deps.coordinator.runClaimSlice).not.toHaveBeenCalled();
    }
  });
  it('uses the original invocation deadline and does not claim after its reserve is exhausted', async () => {
    const deps = fixture(); deps.deadlineAt = now + 10000;
    await expect(consumeNativeDispatch(message, deps)).rejects.toBeInstanceOf(NativeDeliveryRetry);
    expect(deps.repository.claimTarget).not.toHaveBeenCalled();
  });
  it('acknowledges only durable outcome or continuation statuses', async () => {
    for (const status of ['completed', 'waiting', 'failed', 'yielded', 'interrupted', 'idle'] as const) {
      const deps = fixture(); vi.mocked(deps.repository.claimTarget).mockResolvedValue({ kind: 'claimed', claim, dispatch: message });
      vi.mocked(deps.coordinator.runClaimSlice).mockResolvedValue({ status, taskId: message.taskId });
      const work = consumeNativeDispatch(message, deps);
      if (['interrupted', 'idle'].includes(status)) await expect(work).rejects.toBeInstanceOf(NativeDeliveryRetry);
      else await expect(work).resolves.toBe('settled');
      expect(deps.coordinator.runClaimSlice).toHaveBeenCalledWith({ claim, dispatch: message }, { deadlineAt: deps.deadlineAt });
    }
  });
  it('does not run a claim returned for another task or generation', async () => {
    const deps = fixture(); vi.mocked(deps.repository.claimTarget).mockResolvedValue({ kind: 'claimed', claim, dispatch: { ...message, generation: 2 } });
    await expect(consumeNativeDispatch(message, deps)).rejects.toBeInstanceOf(NativeDeliveryRetry);
    expect(deps.coordinator.runClaimSlice).not.toHaveBeenCalled();
    vi.mocked(deps.repository.claimTarget).mockResolvedValue({ kind: 'claimed', claim: { ...claim, organizationId: 'other' }, dispatch: message });
    await expect(consumeNativeDispatch(message, deps)).rejects.toThrow();
    expect(deps.coordinator.runClaimSlice).not.toHaveBeenCalled();
  });
});
