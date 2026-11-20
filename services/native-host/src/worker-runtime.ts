import { attachDatabasePool } from '@vercel/functions';
import { createNativeTaskPool, PostgresNativeTaskWorkerRepository, PostgresNativeDispatchWorkerRepository } from '@pactwoven/db';
import { NativeCoordinator, createAzureGateway, createAzureNodeFetch, createSourceEvidenceReader } from '@pactwoven/coordinator';
import { readNativeWorkerConfig } from './config.js';
import { consumeNativeDispatch, NativeDeliveryRetry } from './consume.js';
import { publishNativeWork } from './dispatch-runtime.js';
import { createAuthorityBoundRepositories, createNativeAuthorityClient } from './authority.js';

async function initialize() {
  const config = readNativeWorkerConfig(process.env);
  const pool = await createNativeTaskPool(config.databaseUrl, config.environment, 'worker');
  attachDatabasePool(pool);
  return { config, authority: createNativeAuthorityClient(config.apiOrigin), repository: new PostgresNativeTaskWorkerRepository(pool, config.environment),
    dispatchRepository: new PostgresNativeDispatchWorkerRepository(pool, config.environment) };
}
let initialized: ReturnType<typeof initialize> | undefined;
function resources() {
  if (initialized) return initialized;
  initialized = initialize().catch(() => { initialized = undefined; throw new NativeDeliveryRetry(); });
  return initialized;
}
export async function runNativeQueueMessage(payload: unknown, deadlineAt: number) {
  const { config, repository, dispatchRepository, authority } = await resources();
  const workerId = `queue-${crypto.randomUUID()}`;
  const bound = createAuthorityBoundRepositories({ repository, dispatchRepository, authority, deadlineAt });
  const gateway = createAzureGateway({ endpoint: config.endpoint, apiKey: config.apiKey }, createAzureNodeFetch());
  const evidence = createSourceEvidenceReader();
  let result: 'discarded' | 'settled';
  try {
    const coordinator = new NativeCoordinator({ repository: bound.repository, dispatchRepository: bound.dispatchRepository, workerId,
      heartbeatMilliseconds: 10_000,
      gateway: { complete: request => { bound.assertCurrent(); return gateway.complete(request); } },
      evidenceReader: { read: request => { bound.assertCurrent(); return evidence.read(request); } },
      onUsage: event => { console.info(JSON.stringify({ kind: 'native-model-usage', role: event.role, ...event.usage })); },
    });
    result = await consumeNativeDispatch(payload, { repository: bound.dispatchRepository,
      coordinator: { runClaimSlice: (work, options) => coordinator.runClaimSlice(work, { ...options, signal: bound.signal }) },
      environment: config.environment, workerId, deadlineAt });
  } finally { bound.close(); }
  if (result === 'settled') {
    try { await publishNativeWork(deadlineAt); }
    catch { console.error('Native continuation remains in the durable dispatch outbox.'); }
  }
}
