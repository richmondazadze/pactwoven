import type { Environment } from '../../../packages/contracts/src/core';
import type { NativeServiceIdentity } from '../../../packages/contracts/src/native-delegation';
import type { PostgresNativeRootDispatchRepository } from '../../../packages/db/src/native-root-lifecycle-repository';
import type { DelegatedCoordinator } from '../../coordinator/src/delegated-coordinator';
import type { DelegatedSpecialist } from '../../coordinator/src/delegated-specialist';
import { DelegatedQueueMessageSchema, sameDelegatedRoute } from './delegated-dispatch';
import { NativeDeliveryRetry } from './consume';

/** Queue metadata selects a runner only after a current protected route lookup.
 * Each runner then observes provider authority and claims its own SQL lease. */
export async function consumeDelegatedWork(payload: unknown, options: { environment: Environment;
  coordinatorIdentity: NativeServiceIdentity; specialistIdentity: NativeServiceIdentity;
  router: Pick<PostgresNativeRootDispatchRepository, 'route'>;
  coordinator: Pick<DelegatedCoordinator, 'run'>; specialist: Pick<DelegatedSpecialist, 'run'>;
  deadlineAt: number; signal?: AbortSignal; now?: () => number;
}): Promise<'discarded' | 'settled'> {
  const parsed = DelegatedQueueMessageSchema.safeParse(payload);
  if (!parsed.success || parsed.data.environment !== options.environment) return 'discarded';
  const now = options.now ?? Date.now;
  if (!Number.isFinite(options.deadlineAt) || options.deadlineAt - now() < 25000 || options.signal?.aborted) throw new NativeDeliveryRetry();
  const message = parsed.data, route = await options.router.route(message.target);
  if (route === null) return 'discarded';
  const identity = message.kind === 'root' ? options.coordinatorIdentity : options.specialistIdentity;
  if (!sameDelegatedRoute(route, { kind: message.kind, identity })) return 'discarded';
  const runner = message.kind === 'root' ? options.coordinator : options.specialist;
  const outcome = await runner.run(message.target, { deadlineAt: options.deadlineAt, ...(options.signal ? { signal: options.signal } : {}) });
  if (outcome.taskId !== message.target.taskId || !['settled', 'yielded'].includes(outcome.state)) throw new NativeDeliveryRetry();
  return 'settled';
}
