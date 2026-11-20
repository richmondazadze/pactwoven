import {paidCoordinatorBridge} from './paid-runtime';
import type { Pool } from 'pg';
import { attachDatabasePool } from '@vercel/functions';
import { createNativeDelegationPool } from '../../../packages/db/src/native-delegation-pool';
import { createNativeRootProtocolPool, type NativeRootProtocol } from '../../../packages/db/src/native-root-protocol-pool';
import { PostgresNativeDelegationDispatchRepository } from '../../../packages/db/src/native-delegation-repository';
import { PostgresNativeRootDispatchRepository } from '../../../packages/db/src/native-root-lifecycle-repository';
import { createAzureGateway } from '../../coordinator/src/azure-gateway';
import { createAzureNodeFetch } from '../../coordinator/src/azure-node-transport';
import { createSourceEvidenceReader } from '../../coordinator/src/source-evidence';
import { createNativeDelegatedAuthorityClient } from './delegated-authority';
import { readDelegatedHostConfig, readDelegatedHostDispatchConfig } from './delegated-host-config';
import { createDelegatedRuntime } from './delegated-runtime';
import { DelegatedQueueMessageSchema, publishDelegatedWork } from './delegated-dispatch';
import { sendDelegatedQueueMessage } from './delegated-queue';
import { NativeDeliveryRetry } from './consume';
import { withDelegatedTrace, traceDelegatedAuthority, traceDelegatedGateway, delegatedTraceFields } from './delegated-trace';

const remaining = (deadlineAt: number, minimum: number) => Number.isSafeInteger(deadlineAt) && deadlineAt - Date.now() >= minimum;
const initializationDeadline = (deadlineAt: number) => Math.min(Date.now() + 20000, deadlineAt - 5000);
const retry = (error: unknown) => error instanceof NativeDeliveryRetry ? error : new NativeDeliveryRetry();
async function closePools(pools: Pool[]) {
  if (!pools.length) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Begin disposal of every owned pool. A noncooperating driver's shutdown must
  // not extend the host bootstrap indefinitely; none of these pools is reused.
  try { await Promise.race([Promise.allSettled(pools.map(async pool => { await pool.end(); })),
    new Promise<void>(resolve => { timer = setTimeout(resolve, 1000); })]); }
  finally { clearTimeout(timer); }
}
/** A timed-out creator may still return a pool. Dispose that late result rather
 * than caching it or attaching it to another invocation. No creation is retried. */
async function openPool(url: string, purpose: 'coordinator' | 'worker' | 'dispatcher', deadlineAt: number): Promise<{ pool: Pool; protocol: NativeRootProtocol }> {
  if (!remaining(deadlineAt, 1)) throw new NativeDeliveryRetry();
  let expired = false, timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const creation = purpose === 'dispatcher'
      ? createNativeDelegationPool(url, 'development', purpose, 'delegation-root').then(pool => ({ pool, protocol: 'legacy' as const }))
      : createNativeRootProtocolPool(url, 'development', purpose);
    const pending = creation.then(resource => {
      if (expired || !remaining(deadlineAt, 1)) { void closePools([resource.pool]); throw new NativeDeliveryRetry(); }
      return resource;
    });
    return await Promise.race([pending, new Promise<never>((_, reject) => {
      timer = setTimeout(() => { expired = true; reject(new NativeDeliveryRetry()); }, Math.max(0, deadlineAt - Date.now()));
    })]);
  } finally { clearTimeout(timer); }
}
async function initializeDispatcher(deadlineAt: number) {
  const config = readDelegatedHostDispatchConfig(process.env), opened: Pool[] = [];
  try {
    const { pool } = await openPool(config.databaseUrl, 'dispatcher', initializationDeadline(deadlineAt)); opened.push(pool);
    const repository = new PostgresNativeDelegationDispatchRepository(pool, config.environment);
    const router = new PostgresNativeRootDispatchRepository(pool, config.environment);
    attachDatabasePool(pool);
    return { config, pool, repository, router };
  } catch (error) { await closePools(opened); throw retry(error); }
}
let dispatchInitialization: ReturnType<typeof initializeDispatcher> | undefined;
function dispatcher(deadlineAt: number) {
  if (!dispatchInitialization) dispatchInitialization = initializeDispatcher(deadlineAt).catch(error => { dispatchInitialization = undefined; throw retry(error); });
  return dispatchInitialization;
}
async function initializeExecutor(deadlineAt: number) {
  const config = readDelegatedHostConfig(process.env), deadline = initializationDeadline(deadlineAt), opened: Pool[] = [];
  try {
    const dispatch = await dispatcher(deadlineAt);
    if (dispatch.config.environment !== config.environment || dispatch.config.databaseUrl !== config.databases.dispatcher) throw new NativeDeliveryRetry();
    const coordinatorBinding = await openPool(config.databases.coordinator, 'coordinator', deadline);
    const coordinator = coordinatorBinding.pool; opened.push(coordinator);
    const workerBinding = await openPool(config.databases.worker, 'worker', deadline);
    const worker = workerBinding.pool; opened.push(worker);
    // An upgrade committed between audience checks must be retried as a whole.
    if (coordinatorBinding.protocol !== workerBinding.protocol) throw new NativeDeliveryRetry();
    const paidEquipment=await paidCoordinatorBridge(coordinator,deadlineAt);
    if(paidEquipment && coordinatorBinding.protocol!=='instructions')throw new NativeDeliveryRetry();
    const runtime = createDelegatedRuntime({ environment: config.environment, services: config.services, protocol: coordinatorBinding.protocol,
      pools: { coordinator, worker, dispatcher: dispatch.pool },
      ...(paidEquipment ? {paidEquipment} : {}),
      gateway: traceDelegatedGateway(createAzureGateway({ endpoint: config.endpoint, apiKey: config.apiKey }, createAzureNodeFetch())),
      observe: traceDelegatedAuthority(createNativeDelegatedAuthorityClient(config.apiOrigin)), evidenceReader: createSourceEvidenceReader(), send: sendDelegatedQueueMessage,
      onDiagnostic: event => { console.warn(JSON.stringify({ kind: 'delegated-execution-interruption',
        runner: event.runner, stage: event.stage, failure: event.failure, ...delegatedTraceFields() })); },
      onUsage: event => { console.info(JSON.stringify({ kind: 'delegated-model-usage', role: event.role,
        inputTokens: event.usage.inputTokens, outputTokens: event.usage.outputTokens, totalTokens: event.usage.totalTokens, ...delegatedTraceFields() })); } });
    attachDatabasePool(coordinator); attachDatabasePool(worker);
    return runtime;
  } catch (error) { await closePools(opened); throw retry(error); }
}
let executionInitialization: ReturnType<typeof initializeExecutor> | undefined;
function executor(deadlineAt: number) {
  if (!executionInitialization) executionInitialization = initializeExecutor(deadlineAt).catch(error => { executionInitialization = undefined; throw retry(error); });
  return executionInitialization;
}

export async function publishDelegatedHostWork(deadlineAt: number) {
  if (!Number.isSafeInteger(deadlineAt)) throw new NativeDeliveryRetry();
  if (!remaining(deadlineAt, 20000)) return { accepted: 0, discarded: 0, unconfirmed: 0 };
  try {
    const resources = await dispatcher(deadlineAt);
    return await publishDelegatedWork({ environment: resources.config.environment, repository: resources.repository, router: resources.router,
      send: sendDelegatedQueueMessage, deadlineAt });
  } catch (error) { throw retry(error); }
}
export async function recoverDelegatedHostWork(deadlineAt: number) {
  if (!Number.isSafeInteger(deadlineAt)) throw new NativeDeliveryRetry();
  if (!remaining(deadlineAt, 20000)) return { recovered: 0 };
  try {
    const resources = await dispatcher(deadlineAt); let recovered = 0;
    for (let batch = 0; batch < 4 && remaining(deadlineAt, 20000); batch++) {
      const results = await resources.router.recover(20); recovered += results.length;
      await publishDelegatedHostWork(deadlineAt);
      if (results.length < 20) break;
    }
    return { recovered };
  } catch (error) { throw retry(error); }
}
export async function runDelegatedQueueMessage(payload: unknown, deadlineAt: number): Promise<'discarded' | 'settled'> {
  const parsed = DelegatedQueueMessageSchema.safeParse(payload);
  if (!parsed.success || parsed.data.environment !== 'development') return 'discarded';
  if (!remaining(deadlineAt, 25000)) throw new NativeDeliveryRetry();
  return withDelegatedTrace(parsed.data, async () => {
  try {
    const runtime = await executor(deadlineAt);
    // A delivery can be the only wake after a worker loses its lease. Recover
    // one bounded batch before routing; SQL preserves settled work and fences
    // stale generations. Do not wait for the slower schedule or rerun locally.
    if (remaining(deadlineAt, 45000)) {
      const resources = await dispatcher(deadlineAt);
      const recovered = await resources.router.recover(20);
      if (recovered.length) {
        const published = await publishDelegatedHostWork(deadlineAt);
        if (published.unconfirmed) throw new NativeDeliveryRetry();
      }
    }
    if (!remaining(deadlineAt, 25000)) throw new NativeDeliveryRetry();
    const result = await runtime.consume(parsed.data, { deadlineAt });
    if (result === 'settled' && remaining(deadlineAt, 20000)) {
      try { await runtime.publish(deadlineAt); }
      catch { console.error('Delegated continuation remains in the durable dispatch outbox.'); }
    }
    return result;
  } catch (error) { throw retry(error); }
  });
}
