import { IdSchema, type Environment } from '../../../packages/contracts/src/core';
import type { NativeDelegationTarget } from '../../../packages/db/src/native-delegation-repository';
import { NativeRootRefreshV3CommandSchema, NativeRootRefreshDispatchV3CommandSchema, nativeRootRefreshV3RequestKey } from '../../../packages/db/src/native-root-instruction-schema';
import { DelegatedOutputRejected } from './delegated-output';
import { orderedRefreshPublications } from './delegated-refresh-identity';

type Context = { environment: Environment; target: NativeDelegationTarget };
type Publication = { handoffId: string; publicationDigest: string };
type Basis = { schemaVersion: 3; expectedInstructionRevision: number; expectedRefreshEpoch: number; expectedCheckpointVersion: number };
const digest = /^[a-f0-9]{64}$/;
export async function refreshOperationCommand(context: Context, basis: Omit<Basis, 'schemaVersion'> & { results: Publication[] }) {
  const command = { schemaVersion: 3 as const, expectedInstructionRevision: basis.expectedInstructionRevision,
    expectedRefreshEpoch: basis.expectedRefreshEpoch, expectedCheckpointVersion: basis.expectedCheckpointVersion,
    results: orderedRefreshPublications(basis.results) };
  const requestKey = await nativeRootRefreshV3RequestKey('refresh', { environment: context.environment,
    organizationId: context.target.organizationId, rootTaskId: context.target.taskId, generation: context.target.generation }, command);
  return NativeRootRefreshV3CommandSchema.parse({ ...command, requestKey });
}

export async function refreshDispatchOperationCommand(context: Context, basis: Omit<Basis, 'schemaVersion'> & { lineageDigest: string; logicalTaskId: string }) {
  IdSchema.parse(basis.logicalTaskId);
  if (!digest.test(basis.lineageDigest)) throw new DelegatedOutputRejected();
  const command = { schemaVersion: 3 as const, expectedInstructionRevision: basis.expectedInstructionRevision,
    expectedRefreshEpoch: basis.expectedRefreshEpoch, expectedCheckpointVersion: basis.expectedCheckpointVersion,
    lineageDigest: basis.lineageDigest, logicalTaskId: basis.logicalTaskId };
  const requestKey = await nativeRootRefreshV3RequestKey('dispatch', { environment: context.environment,
    organizationId: context.target.organizationId, rootTaskId: context.target.taskId, generation: context.target.generation }, command);
  return NativeRootRefreshDispatchV3CommandSchema.parse({ ...command, requestKey });
}
