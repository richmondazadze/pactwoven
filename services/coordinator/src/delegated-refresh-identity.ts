import { IdSchema, type Environment } from '../../../packages/contracts/src/core';
import type { NativeDelegationTarget } from '../../../packages/db/src/native-delegation-repository';
import { NativeRootRefreshCommandSchema, NativeRootRefreshDispatchCommandSchema, nativeRootRefreshRequestKey } from '../../../packages/db/src/native-root-refresh-schema';
import { DelegatedOutputRejected } from './delegated-output';

type Context = { environment: Environment; target: NativeDelegationTarget };
type Publication = { handoffId: string; publicationDigest: string };
type Basis = { schemaVersion: 2; expectedRefreshEpoch: number; expectedCheckpointVersion: number };
const digest = /^[a-f0-9]{64}$/;
const lexical = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/** Stable binary ordering, never locale-dependent and never a stale subset
 * chosen by the model. Call with the entire active successful publication set. */
export function orderedRefreshPublications(values: Publication[]): Publication[] {
  if (!values.length || values.length > 32 || new Set(values.map(value => value.handoffId)).size !== values.length) throw new DelegatedOutputRejected();
  const parsed = values.map(value => {
    IdSchema.parse(value.handoffId);
    if (!digest.test(value.publicationDigest)) throw new DelegatedOutputRejected();
    return { handoffId: value.handoffId, publicationDigest: value.publicationDigest };
  });
  return parsed.sort((a, b) => lexical(a.handoffId, b.handoffId) || lexical(a.publicationDigest, b.publicationDigest));
}

export async function refreshOperationCommand(context: Context, basis: Omit<Basis, 'schemaVersion'> & { results: Publication[] }) {
  const command = { schemaVersion: 2 as const,
    expectedRefreshEpoch: basis.expectedRefreshEpoch, expectedCheckpointVersion: basis.expectedCheckpointVersion,
    results: orderedRefreshPublications(basis.results) };
  const requestKey = await nativeRootRefreshRequestKey('refresh', { environment: context.environment,
    organizationId: context.target.organizationId, rootTaskId: context.target.taskId, generation: context.target.generation }, command);
  return NativeRootRefreshCommandSchema.parse({ ...command, requestKey });
}

export async function refreshDispatchOperationCommand(context: Context, basis: Omit<Basis, 'schemaVersion'> & { lineageDigest: string; logicalTaskId: string }) {
  IdSchema.parse(basis.logicalTaskId);
  if (!digest.test(basis.lineageDigest)) throw new DelegatedOutputRejected();
  const command = { schemaVersion: 2 as const,
    expectedRefreshEpoch: basis.expectedRefreshEpoch, expectedCheckpointVersion: basis.expectedCheckpointVersion,
    lineageDigest: basis.lineageDigest, logicalTaskId: basis.logicalTaskId };
  const requestKey = await nativeRootRefreshRequestKey('dispatch', { environment: context.environment,
    organizationId: context.target.organizationId, rootTaskId: context.target.taskId, generation: context.target.generation }, command);
  return NativeRootRefreshDispatchCommandSchema.parse({ ...command, requestKey });
}
