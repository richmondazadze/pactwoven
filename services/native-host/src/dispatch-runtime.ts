import { attachDatabasePool } from '@vercel/functions';
import { createNativeTaskPool, PostgresNativeDispatchPublisherRepository } from '@pactwoven/db';
import { readNativeDispatchConfig } from './config.js';
import { publishNativeDispatch } from './dispatch.js';
import { nativeQueue, NATIVE_WORK_TOPIC } from './queue.js';

let initialized: Promise<PostgresNativeDispatchPublisherRepository> | undefined;
function publisher() {
  if (initialized) return initialized;
  initialized = (async () => {
    const config = readNativeDispatchConfig(process.env);
    const pool = await createNativeTaskPool(config.databaseUrl, config.environment, 'dispatcher');
    attachDatabasePool(pool);
    return new PostgresNativeDispatchPublisherRepository(pool, config.environment);
  })().catch(() => { initialized = undefined; throw Error('Native dispatch initialization failed.'); });
  return initialized;
}
export async function publishNativeWork(deadlineAt: number) {
  return publishNativeDispatch({ repository: await publisher(), deadlineAt,
    send: (message, options) => nativeQueue.send(NATIVE_WORK_TOPIC, message, options) });
}
export async function recoverNativeWork(deadlineAt: number) {
  const repository = await publisher();
  let batches = 0;
  while (Date.now() + 20_000 < deadlineAt && batches < 4) {
    const recovered = await repository.recoverDue(25);
    await publishNativeDispatch({ repository, deadlineAt, send: (message, options) => nativeQueue.send(NATIVE_WORK_TOPIC, message, options) });
    batches += 1;
    if (!recovered.moreDue) break;
  }
}
