import type { Pool } from 'pg';
import type { z } from 'zod';
import { DomainError } from '../../domain/src/errors';
import { ActorContextSchema, EnvironmentSchema, IdSchema, IdempotencyKeySchema, type ActorContext, type Environment } from '../../contracts/src/core';
import { NativeWorkConversationSchema, NativeWorkInstructionUpdateSchema, NativeWorkInstructionReceiptSchema, NativeWorkInstructionRecoverySchema,
  type NativeWorkConversationRepository, type NativeWorkInstructionUpdate } from '../../contracts/src/native-work-conversation';

function fail(error: unknown): never {
  if (error instanceof DomainError) throw error;
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
  if (code === 'ND001' || code === 'NM001') throw new DomainError('FORBIDDEN', 403, 'Current work access is required.');
  if (code === 'ND004') throw new DomainError('VALIDATION_FAILED', 422, 'Check the instruction details.');
  if (code === 'ND009' || code === '23505') throw new DomainError('ROOT_CONFLICT', 409, 'The work changed. Review its current state.');
  if (code === 'NI003') throw new DomainError('IDEMPOTENCY_CONFLICT', 409, 'This request reference belongs to different instructions.');
  if (code === 'NM007') throw new DomainError('INSTRUCTION_LIMIT', 409, 'This work has reached its execution limit.');
  throw new DomainError('DURABLE_SERVICE_UNAVAILABLE', 503, 'The instruction update has not been confirmed. Recover the original request before trying again.');
}

export class PostgresNativeWorkConversationRepository implements NativeWorkConversationRepository {
  constructor(private readonly pool: Pick<Pool, 'query'>, private readonly environment: Environment) { EnvironmentSchema.parse(environment); }
  private context(value: ActorContext, rootTaskId: string, siteId: string) {
    const actor = ActorContextSchema.parse(value), root = IdSchema.parse(rootTaskId), site = IdSchema.parse(siteId);
    if (actor.environment !== this.environment || actor.principalKind !== 'human') throw new DomainError('FORBIDDEN', 403, 'An authenticated human is required.');
    return { actor, root, site };
  }
  private async query<T>(sql: string, values: unknown[], schema: z.ZodType<T>, verify: (value: T) => boolean): Promise<T> {
    try {
      const result = await this.pool.query<{ response: unknown }>(sql, values);
      if (result.rows.length !== 1) throw Error('Missing instruction response.');
      const parsed = schema.parse(result.rows[0]!.response);
      if (!verify(parsed)) throw Error('Instruction response binding is invalid.');
      return parsed;
    } catch (error) { return fail(error); }
  }
  read(value: ActorContext, rootTaskId: string, siteId: string) {
    const { actor, root, site } = this.context(value, rootTaskId, siteId);
    return this.query('SELECT pactwoven.native_work_conversation_read($1::jsonb,$2,$3) AS response', [JSON.stringify(actor), root, site], NativeWorkConversationSchema,
      result => result.scope.environment === actor.environment && result.scope.organizationId === actor.organizationId && result.scope.siteId === site && result.rootTaskId === root);
  }
  update(value: ActorContext, rootTaskId: string, siteId: string, requestKey: string, input: NativeWorkInstructionUpdate) {
    const { actor, root, site } = this.context(value, rootTaskId, siteId), key = IdempotencyKeySchema.parse(requestKey), command = NativeWorkInstructionUpdateSchema.parse(input);
    return this.query('SELECT pactwoven.native_work_instruction_update($1::jsonb,$2,$3,$4,$5::jsonb) AS response', [JSON.stringify(actor), root, site, key, JSON.stringify(command)], NativeWorkInstructionReceiptSchema,
      result => result.scope.environment === actor.environment && result.scope.organizationId === actor.organizationId && result.scope.siteId === site && result.rootTaskId === root &&
        result.requestKey === key && result.instructionVersion === command.expectedInstructionVersion + 1 && result.controlVersion === command.expectedControlVersion + 1 && result.entry.text === command.text);
  }
  recover(value: ActorContext, rootTaskId: string, siteId: string, requestKey: string) {
    const { actor, root, site } = this.context(value, rootTaskId, siteId), key = IdempotencyKeySchema.parse(requestKey);
    return this.query('SELECT pactwoven.native_work_instruction_recover($1::jsonb,$2,$3,$4) AS response', [JSON.stringify(actor), root, site, key], NativeWorkInstructionRecoverySchema,
      result => result.scope.environment === actor.environment && result.scope.organizationId === actor.organizationId && result.scope.siteId === site && result.rootTaskId === root && result.requestKey === key);
  }
}
