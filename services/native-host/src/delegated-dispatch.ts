import { z } from 'zod';
import { EnvironmentSchema, type Environment } from '../../../packages/contracts/src/core';
import { canonicalJson, commandDigest } from '../../../packages/contracts/src/canonical';
import { NativeServiceIdentitySchema } from '../../../packages/contracts/src/native-delegation';
import { NativeDelegationTargetSchema, type PostgresNativeDelegationDispatchRepository } from '../../../packages/db/src/native-delegation-repository';
import type { PostgresNativeRootDispatchRepository } from '../../../packages/db/src/native-root-lifecycle-repository';

export const DelegatedQueueMessageSchema = z.strictObject({ schemaVersion: z.literal(1), environment: EnvironmentSchema,
  kind: z.enum(['root', 'specialist']), target: NativeDelegationTargetSchema });
export type DelegatedQueueMessage = z.infer<typeof DelegatedQueueMessageSchema>;
export type DelegatedQueueSend = (message: DelegatedQueueMessage, options: { idempotencyKey: string; retentionSeconds: number }) => Promise<unknown>;
const Route = z.strictObject({ kind: z.enum(['root', 'specialist']), identity: NativeServiceIdentitySchema });
async function bounded<T>(work: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('Delivery was not confirmed.')), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
/** Every replay uses the same environment/task/generation identity. A missing
 * queue response is unknown acceptance; leave the original outbox recoverable. */
export async function publishDelegatedWork(options: { environment: Environment;
  repository: Pick<PostgresNativeDelegationDispatchRepository, 'claim' | 'acknowledge'>;
  router: Pick<PostgresNativeRootDispatchRepository, 'route'>; send: DelegatedQueueSend; deadlineAt: number; now?: () => number;
}) {
  const now = options.now ?? Date.now, environment = EnvironmentSchema.parse(options.environment);
  if (!Number.isFinite(options.deadlineAt)) throw Error('A delivery deadline is required.');
  const counts = { accepted: 0, discarded: 0, unconfirmed: 0 };
  for (let index = 0; index < 5 && options.deadlineAt - now() >= 20000; index++) {
    const claimed = await options.repository.claim(1);
    if (!claimed.length) break;
    if (claimed.length !== 1) throw Error('Invalid outbox claim.');
    const item = z.strictObject({ target: NativeDelegationTargetSchema, token: z.uuid() }).parse(claimed[0]);
    const route = Route.nullable().parse(await options.router.route(item.target));
    if (options.deadlineAt - now() < 15000) break;
    if (route === null) { if (await options.repository.acknowledge(item.target, item.token)) counts.discarded++; continue; }
    const message = DelegatedQueueMessageSchema.parse({ schemaVersion: 1, environment, target: item.target, kind: route.kind });
    const idempotencyKey = await commandDigest({ namespace: 'pactwoven/delegated-queue/v1', environment, target: item.target });
    if (options.deadlineAt - now() < 15000) break;
    try {
      await bounded(options.send(message, { idempotencyKey, retentionSeconds: 86400 }), Math.min(10000, options.deadlineAt - now() - 5000));
      if (!await options.repository.acknowledge(item.target, item.token)) throw Error('Delivery acknowledgement was not confirmed.');
      counts.accepted++;
    } catch { counts.unconfirmed++; break; }
  }
  return counts;
}

export function sameDelegatedRoute(left: unknown, right: unknown): boolean { return canonicalJson(Route.parse(left)) === canonicalJson(Route.parse(right)); }
