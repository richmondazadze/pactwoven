import { NativeDispatchMessageSchema, NativeDispatchClaimSchema, type Environment,
  type NativeDispatchWorkerRepository } from '@pactwoven/contracts';
import type { NativeCoordinator } from '@pactwoven/coordinator';

export class NativeDeliveryRetry extends Error {
  constructor(readonly afterSeconds = 30) { super('Native work delivery should be retried from its saved state.'); }
}
export async function consumeNativeDispatch(payload: unknown, dependencies: {
  repository: NativeDispatchWorkerRepository; coordinator: Pick<NativeCoordinator, 'runClaimSlice'>;
  environment: Environment; workerId: string; deadlineAt: number; now?: () => number;
}): Promise<'discarded' | 'settled'> {
  const parsed = NativeDispatchMessageSchema.safeParse(payload);
  if (!parsed.success || parsed.data.environment !== dependencies.environment) return 'discarded';
  const now = dependencies.now ?? Date.now;
  if (!Number.isFinite(dependencies.deadlineAt) || dependencies.deadlineAt - now() < 25_000) throw new NativeDeliveryRetry();
  const result = await dependencies.repository.claimTarget(parsed.data, dependencies.workerId, 30_000);
  if (result.kind === 'busy' || result.kind === 'not_ready') {
    throw new NativeDeliveryRetry(Math.max(1, Math.min(86_400, Math.ceil(result.retryAfterMilliseconds / 1_000))));
  }
  if (result.kind !== 'claimed') return 'discarded';
  const work = NativeDispatchClaimSchema.parse({ claim: result.claim, dispatch: result.dispatch });
  if (JSON.stringify(work.dispatch) !== JSON.stringify(parsed.data)) throw new NativeDeliveryRetry();
  const outcome = await dependencies.coordinator.runClaimSlice(work, { deadlineAt: dependencies.deadlineAt });
  if (!['completed', 'waiting', 'failed', 'yielded'].includes(outcome.status)) throw new NativeDeliveryRetry();
  return 'settled';
}
