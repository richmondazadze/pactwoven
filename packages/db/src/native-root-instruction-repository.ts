import type { Pool } from 'pg';
import { z } from 'zod';
import { EnvironmentSchema, type Environment } from '../../contracts/src/core';
import { commandDigest } from '../../contracts/src/canonical';
import { DomainError } from '../../domain/src/errors';
import { NativeDelegationClaimSelectorSchema, NativeDelegationTargetSchema,
  type NativeDelegationClaimSelector, type NativeDelegationTarget } from './native-delegation-repository';
import {
  NativeRootWorkV3Schema, NativeRootMaterialsV3Schema,
  NativeRootInputsV3CommandSchema, NativeRootInputsV3ReceiptSchema,
  NativeRootCheckpointV3CommandSchema, NativeRootCheckpointV3ReceiptSchema,
  NativeRootYieldV3CommandSchema, NativeRootYieldV3ReceiptSchema,
  NativeRootCompleteV3CommandSchema, NativeRootCompleteV3ReceiptSchema,
  NativeRootRefreshV3CommandSchema, NativeRootRefreshDispatchV3CommandSchema,
  NativeRootRefreshV3ReceiptSchema, NativeRootRefreshV3LookupSchema,
  NativeDelegationPublicationV3Schema, NativeDelegationPublicationV3ReceiptSchema,
  type NativeRootRefreshV3Command, type NativeRootRefreshDispatchV3Command, type NativeRootRefreshV3Lookup,
  type NativeDelegationPublicationV3,
  NativeRootHandoffV3CommandSchema, NativeRootHandoffV3ReceiptSchema, nativeInstructionDigest,
} from './native-root-instruction-schema';

type Inputs = z.infer<typeof NativeRootInputsV3CommandSchema>;
type Checkpoint = z.infer<typeof NativeRootCheckpointV3CommandSchema>;
type Yield = z.infer<typeof NativeRootYieldV3CommandSchema>;
type Complete = z.infer<typeof NativeRootCompleteV3CommandSchema>;

function fail(error: unknown): never {
  if (error instanceof DomainError) throw error;
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
  if (code === 'ND001' || code === 'NM001') throw new DomainError('FORBIDDEN', 403, 'Current work access is required.');
  if (code === 'ND004' || code === 'NM004') throw new DomainError('VALIDATION_FAILED', 422, 'The work update is invalid.');
  if (code === 'ND009' || code === '23505') throw new DomainError('ROOT_CONFLICT', 409, 'The retained work changed.');
  if (code === 'NM002') throw new DomainError('MEMORY_UNAVAILABLE', 409, 'The selected memory is no longer available.');
  if (code === 'NM007') throw new DomainError('MEMORY_LIMIT', 409, 'The retained work reached its permitted limit.');
  if (['NM005', 'NM006', 'NM008', 'NM009'].includes(String(code))) throw new DomainError('EVIDENCE_STALE', 409, 'Original evidence needs review.');
  // A timeout, malformed response or failed response-binding check can follow a
  // committed write. Preserve uncertainty; never label it a definite rejection.
  throw new DomainError('DURABLE_SERVICE_UNAVAILABLE', 503, 'The work update has not been confirmed.');
}

class RefreshRepository {
  constructor(protected readonly pool: Pick<Pool, 'query'>, protected readonly environment: Environment) { EnvironmentSchema.parse(environment); }
  protected async call<T>(sql: string, values: unknown[], schema: z.ZodType<T>, verify?: (value: T) => boolean | Promise<boolean>): Promise<T> {
    try {
      const result = await this.pool.query<{ response: unknown }>(sql, values);
      if (result.rows.length !== 1) throw Error('Missing work response.');
      const parsed = schema.parse(result.rows[0]!.response);
      if (verify && !await verify(parsed)) throw Error('Work response binding is invalid.');
      return parsed;
    } catch (error) { return fail(error); }
  }
  protected values(selector: NativeDelegationClaimSelector, command?: unknown) {
    // Serialize parsed copies before awaiting a transport: caller mutations can
    // neither alter the SQL request nor its subsequent response comparisons.
    return [this.environment, JSON.stringify(selector), ...(command === undefined ? [] : [JSON.stringify(command)])];
  }
}

export class PostgresNativeRootInstructionCoordinatorRepository extends RefreshRepository {
  workV3(input: NativeDelegationClaimSelector) {
    const selector = NativeDelegationClaimSelectorSchema.parse(input);
    return this.call('SELECT pactwoven.native_delegation_root_work_v3($1,$2::jsonb) AS response', this.values(selector), NativeRootWorkV3Schema, async value => {
      if (value.instructionDigest !== await nativeInstructionDigest(value.instructionRevision, value.instructions)) return false;
      if (value.work.grant.scope.environment !== this.environment || value.work.grant.scope.organizationId !== selector.organizationId ||
        !value.work.grant.scope.sites.some(site => site.siteId === value.work.siteId)) return false;
      if (value.refresh && (value.refresh.planBasis.plannerDigest !== await commandDigest(JSON.parse(value.refresh.planBasis.plannerState)) ||
        value.refresh.operations.some(operation => operation.rootTaskId !== selector.taskId || operation.refreshEpoch > value.refreshEpoch))) return false;
      return true;
    });
  }
  inputsV3(input: NativeDelegationClaimSelector, value: Inputs) {
    const selector = NativeDelegationClaimSelectorSchema.parse(input), command = NativeRootInputsV3CommandSchema.parse(value);
    return this.call('SELECT pactwoven.native_delegation_root_inputs_v3($1,$2::jsonb,$3::jsonb) AS response', this.values(selector, command), NativeRootInputsV3ReceiptSchema,
      result => result.instructionRevision === command.expectedInstructionRevision && result.refreshEpoch === command.expectedRefreshEpoch && result.receipt.generation === selector.generation &&
        result.receipt.results.length === command.command.results.length && result.receipt.results.every((item, index) =>
          item.handoffId === command.command.results[index]!.handoffId && item.publicationDigest === command.command.results[index]!.publicationDigest));
  }
  checkpointV3(input: NativeDelegationClaimSelector, value: Checkpoint) {
    const selector = NativeDelegationClaimSelectorSchema.parse(input), command = NativeRootCheckpointV3CommandSchema.parse(value);
    return this.call('SELECT pactwoven.native_delegation_root_checkpoint_v3($1,$2::jsonb,$3::jsonb) AS response', this.values(selector, command), NativeRootCheckpointV3ReceiptSchema,
      result => result.instructionRevision === command.expectedInstructionRevision && result.refreshEpoch === command.expectedRefreshEpoch && result.receipt.generation === selector.generation &&
        result.receipt.continuation === 'running' && result.receipt.requestKey === command.command.requestKey &&
        result.receipt.checkpointVersion === command.command.expectedCheckpointVersion + 1);
  }
  yieldV3(input: NativeDelegationClaimSelector, value: Yield) {
    const selector = NativeDelegationClaimSelectorSchema.parse(input), command = NativeRootYieldV3CommandSchema.parse(value);
    return this.call('SELECT pactwoven.native_delegation_root_yield_v3($1,$2::jsonb,$3::jsonb) AS response', this.values(selector, command), NativeRootYieldV3ReceiptSchema,
      result => result.instructionRevision === command.expectedInstructionRevision && result.refreshEpoch === command.expectedRefreshEpoch && result.receipt.generation === selector.generation + 1 &&
        result.receipt.requestKey === command.command.requestKey && result.receipt.checkpointVersion === command.command.expectedCheckpointVersion + 1 &&
        result.receipt.continuation === (command.command.continuation === 'wait_children' ? 'waiting_children' : 'yielded'));
  }
  async completeV3(input: NativeDelegationClaimSelector, value: Complete) {
    const selector = NativeDelegationClaimSelectorSchema.parse(input), command = NativeRootCompleteV3CommandSchema.parse(value);
    const digest = await commandDigest(command.command);
    return this.call('SELECT pactwoven.native_delegation_root_complete_v3($1,$2::jsonb,$3::jsonb) AS response', this.values(selector, command), NativeRootCompleteV3ReceiptSchema,
      result => result.instructionRevision === command.expectedInstructionRevision && result.refreshEpoch === command.expectedRefreshEpoch && result.receipt.rootTaskId === selector.taskId &&
        result.receipt.publicationDigest === digest && result.receipt.execution ===
          (result.receipt.kind === 'accepted' && command.command.result.outcome === 'advice_ready' ? 'advisory_only' : 'none'));
  }
  async handoffV3(input: NativeDelegationClaimSelector, value: z.infer<typeof NativeRootHandoffV3CommandSchema>) {
    const selector = NativeDelegationClaimSelectorSchema.parse(input), command = NativeRootHandoffV3CommandSchema.parse(value);
    const digest = await commandDigest(command.command.handoff);
    return this.call('SELECT pactwoven.native_delegation_root_handoff_v3($1,$2::jsonb,$3::jsonb) AS response', this.values(selector, command), NativeRootHandoffV3ReceiptSchema,
      result => result.instructionRevision === command.expectedInstructionRevision && result.refreshEpoch === command.expectedRefreshEpoch && result.receipt.digest === digest);
  }
  async refreshV3(input: NativeDelegationClaimSelector, value: NativeRootRefreshV3Command) {
    const selector = NativeDelegationClaimSelectorSchema.parse(input), command = NativeRootRefreshV3CommandSchema.parse(value), digest = await commandDigest(command);
    return this.call('SELECT pactwoven.native_delegation_root_refresh_v3($1,$2::jsonb,$3::jsonb) AS response', this.values(selector, command), NativeRootRefreshV3ReceiptSchema,
      result => result.instructionRevision === command.expectedInstructionRevision && result.kind === 'refresh' && result.rootTaskId === selector.taskId && result.previousGeneration === selector.generation &&
        result.checkpointVersion === command.expectedCheckpointVersion + 1 &&
        result.previousEpoch === command.expectedRefreshEpoch && result.requestKey === command.requestKey && result.intentDigest === digest);
  }
  async refreshDispatchV3(input: NativeDelegationClaimSelector, value: NativeRootRefreshDispatchV3Command) {
    const selector = NativeDelegationClaimSelectorSchema.parse(input), command = NativeRootRefreshDispatchV3CommandSchema.parse(value), digest = await commandDigest(command);
    return this.call('SELECT pactwoven.native_delegation_root_refresh_dispatch_v3($1,$2::jsonb,$3::jsonb) AS response', this.values(selector, command), NativeRootRefreshV3ReceiptSchema,
      result => result.instructionRevision === command.expectedInstructionRevision && result.kind === 'dispatch' && result.rootTaskId === selector.taskId && result.previousGeneration === selector.generation &&
        result.checkpointVersion === command.expectedCheckpointVersion &&
        result.previousEpoch === command.expectedRefreshEpoch && result.lineageDigest === command.lineageDigest &&
        result.requestKey === command.requestKey && result.intentDigest === digest);
  }
  refreshOperationV3(input: NativeDelegationTarget, value: NativeRootRefreshV3Lookup) {
    const target = NativeDelegationTargetSchema.parse(input), lookup = NativeRootRefreshV3LookupSchema.parse(value);
    return this.call('SELECT pactwoven.native_delegation_root_refresh_operation_v3($1,$2::jsonb,$3::jsonb) AS response',
      [this.environment, JSON.stringify(target), JSON.stringify(lookup)], NativeRootRefreshV3ReceiptSchema.nullable(),
      result => result === null || result.instructionRevision === lookup.instructionRevision && result.rootTaskId === target.taskId && result.previousGeneration === target.generation &&
        result.kind === lookup.kind && result.requestKey === lookup.requestKey && result.intentDigest === lookup.intentDigest);
  }
}

export class PostgresNativeRootInstructionWorkerRepository extends RefreshRepository {
  materialsV3(input: NativeDelegationClaimSelector) {
    const selector = NativeDelegationClaimSelectorSchema.parse(input);
    return this.call('SELECT pactwoven.native_delegation_root_materials_v3($1,$2::jsonb) AS response', this.values(selector), NativeRootMaterialsV3Schema, async value => value.instructionDigest === await nativeInstructionDigest(value.instructionRevision, value.instructions));
  }
  async resultV3(input: NativeDelegationClaimSelector, value: NativeDelegationPublicationV3) {
    const selector = NativeDelegationClaimSelectorSchema.parse(input), command = NativeDelegationPublicationV3Schema.parse(value), publication = command.publication;
    if (publication.result.environment !== this.environment || publication.result.organizationId !== selector.organizationId ||
      publication.result.childTaskId !== selector.taskId || publication.result.handoffId !== selector.handoffId || publication.result.generation !== selector.generation) {
      throw new DomainError('VALIDATION_FAILED', 422, 'The publication belongs to different work.');
    }
    const digest = await commandDigest(publication), provenance = command.observations.length ? await commandDigest(command.observations) : null;
    return this.call('SELECT pactwoven.native_delegation_result_commit_v3($1,$2::jsonb,$3::jsonb) AS response', this.values(selector, command), NativeDelegationPublicationV3ReceiptSchema,
      result => result.instructionRevision === command.expectedInstructionRevision && result.refreshEpoch === command.expectedRefreshEpoch && result.publicationDigest === digest && result.provenanceDigest === provenance);
  }
}
