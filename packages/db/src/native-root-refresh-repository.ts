import type { Pool } from 'pg';
import { z } from 'zod';
import { EnvironmentSchema, type Environment } from '../../contracts/src/core';
import { commandDigest } from '../../contracts/src/canonical';
import { DomainError } from '../../domain/src/errors';
import { NativeDelegationClaimSelectorSchema, NativeDelegationTargetSchema,
  type NativeDelegationClaimSelector, type NativeDelegationTarget } from './native-delegation-repository';
import {
  NativeRootWorkV2Schema, NativeRootMaterialsV2Schema,
  NativeRootInputsV2CommandSchema, NativeRootInputsV2ReceiptSchema,
  NativeRootCheckpointV2CommandSchema, NativeRootCheckpointV2ReceiptSchema,
  NativeRootYieldV2CommandSchema, NativeRootYieldV2ReceiptSchema,
  NativeRootCompleteV2CommandSchema, NativeRootCompleteV2ReceiptSchema,
  NativeRootRefreshCommandSchema, NativeRootRefreshDispatchCommandSchema,
  NativeRootRefreshOperationReceiptSchema, NativeRootRefreshOperationLookupSchema,
  NativeDelegationPublicationV2Schema, NativeDelegationPublicationV2ReceiptSchema,
  type NativeRootRefreshCommand, type NativeRootRefreshDispatchCommand, type NativeRootRefreshOperationLookup,
  type NativeDelegationPublicationV2,
} from './native-root-refresh-schema';

type Inputs = z.infer<typeof NativeRootInputsV2CommandSchema>;
type Checkpoint = z.infer<typeof NativeRootCheckpointV2CommandSchema>;
type Yield = z.infer<typeof NativeRootYieldV2CommandSchema>;
type Complete = z.infer<typeof NativeRootCompleteV2CommandSchema>;

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

export class PostgresNativeRootRefreshCoordinatorRepository extends RefreshRepository {
  workV2(input: NativeDelegationClaimSelector) {
    const selector = NativeDelegationClaimSelectorSchema.parse(input);
    return this.call('SELECT pactwoven.native_delegation_root_work_v2($1,$2::jsonb) AS response', this.values(selector), NativeRootWorkV2Schema, async value => {
      if (value.work.grant.scope.environment !== this.environment || value.work.grant.scope.organizationId !== selector.organizationId ||
        !value.work.grant.scope.sites.some(site => site.siteId === value.work.siteId)) return false;
      if (value.refresh && (value.refresh.planBasis.plannerDigest !== await commandDigest(JSON.parse(value.refresh.planBasis.plannerState)) ||
        value.refresh.operations.some(operation => operation.rootTaskId !== selector.taskId || operation.refreshEpoch > value.refreshEpoch))) return false;
      return true;
    });
  }
  inputsV2(input: NativeDelegationClaimSelector, value: Inputs) {
    const selector = NativeDelegationClaimSelectorSchema.parse(input), command = NativeRootInputsV2CommandSchema.parse(value);
    return this.call('SELECT pactwoven.native_delegation_root_inputs_v2($1,$2::jsonb,$3::jsonb) AS response', this.values(selector, command), NativeRootInputsV2ReceiptSchema,
      result => result.refreshEpoch === command.expectedRefreshEpoch && result.receipt.generation === selector.generation &&
        result.receipt.results.length === command.command.results.length && result.receipt.results.every((item, index) =>
          item.handoffId === command.command.results[index]!.handoffId && item.publicationDigest === command.command.results[index]!.publicationDigest));
  }
  checkpointV2(input: NativeDelegationClaimSelector, value: Checkpoint) {
    const selector = NativeDelegationClaimSelectorSchema.parse(input), command = NativeRootCheckpointV2CommandSchema.parse(value);
    return this.call('SELECT pactwoven.native_delegation_root_checkpoint_v2($1,$2::jsonb,$3::jsonb) AS response', this.values(selector, command), NativeRootCheckpointV2ReceiptSchema,
      result => result.refreshEpoch === command.expectedRefreshEpoch && result.receipt.generation === selector.generation &&
        result.receipt.continuation === 'running' && result.receipt.requestKey === command.command.requestKey &&
        result.receipt.checkpointVersion === command.command.expectedCheckpointVersion + 1);
  }
  yieldV2(input: NativeDelegationClaimSelector, value: Yield) {
    const selector = NativeDelegationClaimSelectorSchema.parse(input), command = NativeRootYieldV2CommandSchema.parse(value);
    return this.call('SELECT pactwoven.native_delegation_root_yield_v2($1,$2::jsonb,$3::jsonb) AS response', this.values(selector, command), NativeRootYieldV2ReceiptSchema,
      result => result.refreshEpoch === command.expectedRefreshEpoch && result.receipt.generation === selector.generation + 1 &&
        result.receipt.requestKey === command.command.requestKey && result.receipt.checkpointVersion === command.command.expectedCheckpointVersion + 1 &&
        result.receipt.continuation === (command.command.continuation === 'wait_children' ? 'waiting_children' : 'yielded'));
  }
  async completeV2(input: NativeDelegationClaimSelector, value: Complete) {
    const selector = NativeDelegationClaimSelectorSchema.parse(input), command = NativeRootCompleteV2CommandSchema.parse(value);
    const digest = await commandDigest(command.command);
    return this.call('SELECT pactwoven.native_delegation_root_complete_v2($1,$2::jsonb,$3::jsonb) AS response', this.values(selector, command), NativeRootCompleteV2ReceiptSchema,
      result => result.refreshEpoch === command.expectedRefreshEpoch && result.receipt.rootTaskId === selector.taskId &&
        result.receipt.publicationDigest === digest && result.receipt.execution ===
          (result.receipt.kind === 'accepted' && command.command.result.outcome === 'advice_ready' ? 'advisory_only' : 'none'));
  }
  async refresh(input: NativeDelegationClaimSelector, value: NativeRootRefreshCommand) {
    const selector = NativeDelegationClaimSelectorSchema.parse(input), command = NativeRootRefreshCommandSchema.parse(value), digest = await commandDigest(command);
    return this.call('SELECT pactwoven.native_delegation_root_refresh($1,$2::jsonb,$3::jsonb) AS response', this.values(selector, command), NativeRootRefreshOperationReceiptSchema,
      result => result.kind === 'refresh' && result.rootTaskId === selector.taskId && result.previousGeneration === selector.generation &&
        result.checkpointVersion === command.expectedCheckpointVersion + 1 &&
        result.previousEpoch === command.expectedRefreshEpoch && result.requestKey === command.requestKey && result.intentDigest === digest);
  }
  async refreshDispatch(input: NativeDelegationClaimSelector, value: NativeRootRefreshDispatchCommand) {
    const selector = NativeDelegationClaimSelectorSchema.parse(input), command = NativeRootRefreshDispatchCommandSchema.parse(value), digest = await commandDigest(command);
    return this.call('SELECT pactwoven.native_delegation_root_refresh_dispatch($1,$2::jsonb,$3::jsonb) AS response', this.values(selector, command), NativeRootRefreshOperationReceiptSchema,
      result => result.kind === 'dispatch' && result.rootTaskId === selector.taskId && result.previousGeneration === selector.generation &&
        result.checkpointVersion === command.expectedCheckpointVersion &&
        result.previousEpoch === command.expectedRefreshEpoch && result.lineageDigest === command.lineageDigest &&
        result.requestKey === command.requestKey && result.intentDigest === digest);
  }
  refreshOperation(input: NativeDelegationTarget, value: NativeRootRefreshOperationLookup) {
    const target = NativeDelegationTargetSchema.parse(input), lookup = NativeRootRefreshOperationLookupSchema.parse(value);
    return this.call('SELECT pactwoven.native_delegation_root_refresh_operation($1,$2::jsonb,$3::jsonb) AS response',
      [this.environment, JSON.stringify(target), JSON.stringify(lookup)], NativeRootRefreshOperationReceiptSchema.nullable(),
      result => result === null || result.rootTaskId === target.taskId && result.previousGeneration === target.generation &&
        result.kind === lookup.kind && result.requestKey === lookup.requestKey && result.intentDigest === lookup.intentDigest);
  }
}

export class PostgresNativeRootRefreshWorkerRepository extends RefreshRepository {
  materialsV2(input: NativeDelegationClaimSelector) {
    const selector = NativeDelegationClaimSelectorSchema.parse(input);
    return this.call('SELECT pactwoven.native_delegation_root_materials_v2($1,$2::jsonb) AS response', this.values(selector), NativeRootMaterialsV2Schema);
  }
  async resultV2(input: NativeDelegationClaimSelector, value: NativeDelegationPublicationV2) {
    const selector = NativeDelegationClaimSelectorSchema.parse(input), command = NativeDelegationPublicationV2Schema.parse(value), publication = command.publication;
    if (publication.result.environment !== this.environment || publication.result.organizationId !== selector.organizationId ||
      publication.result.childTaskId !== selector.taskId || publication.result.handoffId !== selector.handoffId || publication.result.generation !== selector.generation) {
      throw new DomainError('VALIDATION_FAILED', 422, 'The publication belongs to different work.');
    }
    const digest = await commandDigest(publication), provenance = command.observations.length ? await commandDigest(command.observations) : null;
    return this.call('SELECT pactwoven.native_delegation_result_commit_v2($1,$2::jsonb,$3::jsonb) AS response', this.values(selector, command), NativeDelegationPublicationV2ReceiptSchema,
      result => result.refreshEpoch === command.expectedRefreshEpoch && result.publicationDigest === digest && result.provenanceDigest === provenance);
  }
}
