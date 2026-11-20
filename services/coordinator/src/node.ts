import { setTimeout as delay } from 'node:timers/promises';
import { createNativeTaskPool, PostgresNativeTaskWorkerRepository } from '@pactwoven/db';
import { createAzureGateway } from './azure-gateway.js';
import { readCoordinatorConfig } from './config.js';
import { NativeCoordinator } from './native-coordinator.js';
import { createSourceEvidenceReader } from './source-evidence.js';
import { createAzureNodeFetch } from './azure-node-transport.js';

async function main() {
  const config = readCoordinatorConfig(process.env);
  const stop = new AbortController();
  const halt = () => stop.abort();
  process.once('SIGINT', halt);
  process.once('SIGTERM', halt);
  const pool = await createNativeTaskPool(config.databaseUrl, config.environment, 'worker');
  try {
    const coordinator = new NativeCoordinator({
      repository: new PostgresNativeTaskWorkerRepository(pool, config.environment),
      gateway: createAzureGateway({ endpoint: config.endpoint, apiKey: config.apiKey }, createAzureNodeFetch()),
      workerId: config.workerId, evidenceReader: createSourceEvidenceReader(),
    });
    console.info('Pactwoven native coordinator is ready.');
    let failures = 0;
    while (!stop.signal.aborted) {
      try {
        const result = await coordinator.runOnce({ signal: stop.signal });
        failures = 0;
        if (result.status !== 'idle') console.info(`Native work iteration: ${result.status}.`);
        await delay(result.status === 'idle' ? 2_000 : 100, undefined, { signal: stop.signal });
      } catch {
        if (stop.signal.aborted) break;
        failures = Math.min(failures + 1, 5);
        console.error('Native work is temporarily unavailable; saved work remains recoverable.');
        await delay(Math.min(30_000, 1_000 * 2 ** failures), undefined, { signal: stop.signal }).catch(() => {});
      }
    }
  } finally {
    await pool.end();
    process.removeListener('SIGINT', halt);
    process.removeListener('SIGTERM', halt);
  }
}

main().catch(() => {
  console.error('Pactwoven native coordinator could not start. Check its protected development bindings.');
  process.exitCode = 1;
});
