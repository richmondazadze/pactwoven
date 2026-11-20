import type {DelegatedPaidEquipmentCoordinator} from '../../coordinator/src/delegated-paid-equipment';
import { canonicalJson } from '../../../packages/contracts/src/canonical';
import type { Environment } from '../../../packages/contracts/src/core';
import type { DelegatedServiceRoster } from '../../../packages/contracts/src/delegated-execution';
import { PostgresNativeDelegationDispatchRepository, PostgresNativeDelegationWorkerRepository } from '../../../packages/db/src/native-delegation-repository';
import { PostgresNativeRootCoordinatorRepository, PostgresNativeRootDispatchRepository, PostgresNativeRootWorkerRepository } from '../../../packages/db/src/native-root-lifecycle-repository';
import { PostgresNativeRootRefreshCoordinatorRepository, PostgresNativeRootRefreshWorkerRepository } from '../../../packages/db/src/native-root-refresh-repository';
import { PostgresNativeRootInstructionCoordinatorRepository, PostgresNativeRootInstructionWorkerRepository } from '../../../packages/db/src/native-root-instruction-repository';
import type { NativeRootProtocol } from '../../../packages/db/src/native-root-protocol-pool';
import { PostgresNativeMemoryTaskRepository } from '../../../packages/db/src/native-memory-repository';
import { DelegatedCoordinator } from '../../coordinator/src/delegated-coordinator';
import { DelegatedSpecialist } from '../../coordinator/src/delegated-specialist';
import type { NativeModelGateway, ModelUsage, ReasoningRole } from '../../coordinator/src/azure-gateway';
import type { NativeEvidenceReader } from '../../coordinator/src/native-evidence';
import type { DelegatedAuthorityObserver } from '../../coordinator/src/delegated-lease';
import { consumeDelegatedWork } from './delegated-consume';
import type { DelegatedDiagnosticReporter } from '../../coordinator/src/delegated-diagnostics';
import { publishDelegatedWork, type DelegatedQueueSend } from './delegated-dispatch';

/** The host supplies independently verified delegation-root pools. This module
 * neither reads environment credentials nor changes the existing v1 runtime. */
export function createDelegatedRuntime(options: { environment: Environment; services: DelegatedServiceRoster; protocol?: NativeRootProtocol;
  pools: { coordinator: ConstructorParameters<typeof PostgresNativeRootCoordinatorRepository>[0]; worker: ConstructorParameters<typeof PostgresNativeRootWorkerRepository>[0]; dispatcher: ConstructorParameters<typeof PostgresNativeRootDispatchRepository>[0] }; gateway: NativeModelGateway;
  externalCalendar?: unknown;
  paidEquipment?: Pick<DelegatedPaidEquipmentCoordinator,'beforeSynthesis'>;
  observe: DelegatedAuthorityObserver; send: DelegatedQueueSend; evidenceReader?: NativeEvidenceReader;
  onDiagnostic?: DelegatedDiagnosticReporter;
  onUsage?: (event: { taskId: string; role: ReasoningRole; usage: ModelUsage }) => void;
}) {
  const { environment, pools } = options;
  if (options.externalCalendar !== undefined) throw Error('Calendar is unavailable in this bounded runtime.');
  if (options.protocol !== undefined && options.protocol !== 'legacy' && options.protocol !== 'refresh' && options.protocol !== 'instructions') throw Error('Unknown root protocol.');
  const router = new PostgresNativeRootDispatchRepository(pools.dispatcher, environment);
  const outbox = new PostgresNativeDelegationDispatchRepository(pools.dispatcher, environment);
  const coordinator = new DelegatedCoordinator({ environment, services: options.services,
    repository: new PostgresNativeRootCoordinatorRepository(pools.coordinator, environment),
    ...(options.protocol === 'refresh' ? { refresh: new PostgresNativeRootRefreshCoordinatorRepository(pools.coordinator, environment) } : {}),
    ...(options.protocol === 'instructions' ? { instructions: new PostgresNativeRootInstructionCoordinatorRepository(pools.coordinator, environment) } : {}),
    renewal: new PostgresNativeDelegationWorkerRepository(pools.coordinator, environment),
    ...(options.paidEquipment ? {paidEquipment:options.paidEquipment} : {}),
    gateway: options.gateway, observe: options.observe, ...(options.onUsage ? { onUsage: options.onUsage } : {}), ...(options.onDiagnostic ? { onDiagnostic: options.onDiagnostic } : {}) });
  const specialist = new DelegatedSpecialist({ environment, identity: options.services.research,
    repository: new PostgresNativeDelegationWorkerRepository(pools.worker, environment),
    ...(options.protocol === 'refresh' ? { refresh: new PostgresNativeRootRefreshWorkerRepository(pools.worker, environment) } : {}),
    ...(options.protocol === 'instructions' ? { instructions: new PostgresNativeRootInstructionWorkerRepository(pools.worker, environment) } : {}),
    materials: new PostgresNativeRootWorkerRepository(pools.worker, environment), memory: new PostgresNativeMemoryTaskRepository(pools.worker, environment),
    gateway: options.gateway, observe: options.observe, ...(options.evidenceReader ? { evidenceReader: options.evidenceReader } : {}),
    ...(options.onUsage ? { onUsage: options.onUsage } : {}), ...(options.onDiagnostic ? { onDiagnostic: options.onDiagnostic } : {}) });
  if (canonicalJson(options.services.research) !== canonicalJson(options.services.planning) ||
      canonicalJson(options.services.research) !== canonicalJson(options.services.escalation)) throw Error('This host requires one enrolled specialist identity.');
  const publish = (deadlineAt: number) => publishDelegatedWork({ environment, repository: outbox, router, send: options.send, deadlineAt });
  return {
    publish,
    consume: (payload: unknown, slice: { deadlineAt: number; signal?: AbortSignal }) => consumeDelegatedWork(payload, { environment,
      coordinatorIdentity: options.services.coordinator, specialistIdentity: options.services.research,
      router, coordinator, specialist, ...slice }),
    async recover(deadlineAt: number) {
      let recovered = 0;
      for (let batch = 0; batch < 4 && Date.now() + 20000 < deadlineAt; batch++) {
        const results = await router.recover(20); recovered += results.length; await publish(deadlineAt);
        if (results.length < 20) break;
      }
      return { recovered };
    },
  };
}
