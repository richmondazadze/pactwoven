import type { Pool } from 'pg';
import type { z } from 'zod';
import { DomainError } from '@pactwoven/domain';
import { ActorContextSchema, EnvironmentSchema, IdSchema, IdempotencyKeySchema, type ActorContext, type Environment } from '../../contracts/src/core';
import {
  NativeWorkIntentPrepareSchema, NativeWorkIntentConfirmSchema, NativeWorkIntentSessionObservationSchema,
  NativeWorkIntentPrepareResponseSchema, NativeWorkIntentRecoveryResponseSchema, NativeWorkIntentOperationSchema,
  NativeWorkIntentProvenanceQuerySchema, NativeWorkIntentProvenanceResponseSchema,
  type NativeWorkIntentPrepare, type NativeWorkIntentConfirm, type NativeWorkIntentSessionObservation, type NativeWorkIntentRepository,
} from '../../contracts/src/native-work-intent';

function failure(error: unknown): never {
  if (error instanceof DomainError) throw error;
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
  const known = {
    NW001: ['FORBIDDEN', 403, 'Current human work access is required.'],
    NW002: ['NOT_FOUND', 404, 'This work request is unavailable.'],
    NW003: ['IDEMPOTENCY_CONFLICT', 409, 'This request reference belongs to different work.'],
    NW004: ['VALIDATION_FAILED', 422, 'Check the work request details.'],
    NW005: ['REVIEW_CHANGED', 409, 'The reviewed context or authority changed. Prepare a new review.'],
    NW006: ['REVIEW_EXPIRED', 409, 'This review expired. Prepare a new review.'],
    NW007: ['SETUP_REQUIRED', 503, 'Background advisory work is not configured for this workspace.'],
    ND001: ['FORBIDDEN', 403, 'Current delegation authority is required.'],
    ND004: ['VALIDATION_FAILED', 422, 'Check the work request details.'],
    ND009: ['REVIEW_CHANGED', 409, 'This work request conflicts with retained work.'],
    NM001: ['FORBIDDEN', 403, 'Current access to selected context is required.'],
    NM005: ['REVIEW_CHANGED', 409, 'Selected context changed. Prepare a new review.'],
    NM006: ['REVIEW_CHANGED', 409, 'Selected context is no longer eligible.'],
    NM008: ['REVIEW_EXPIRED', 409, 'Current review or context expired.'],
  } as const;
  if (typeof code === 'string' && Object.hasOwn(known, code)) { const [name, status, message] = known[code as keyof typeof known]; throw new DomainError(name, status, message); }
  throw new DomainError('DURABLE_SERVICE_UNAVAILABLE', 503, 'This work request could not be confirmed. Recover the original request before replacing it.');
}
export class PostgresNativeWorkIntentRepository implements NativeWorkIntentRepository {
  constructor(private readonly pool: Pool, private readonly environment: Environment) { EnvironmentSchema.parse(environment); }
  private actor(input: ActorContext) {
    const actor = ActorContextSchema.parse(input);
    if (actor.environment !== this.environment || actor.principalKind !== 'human') throw new DomainError('FORBIDDEN', 403, 'An authenticated human is required.');
    return actor;
  }
  private async query<T>(sql: string, values: unknown[], schema: z.ZodType<T>): Promise<T> {
    try { const result = await this.pool.query<{ response: unknown }>(sql, values); if (result.rows.length !== 1) throw new Error('Missing work response'); return schema.parse(result.rows[0]?.response); }
    catch (error) { return failure(error); }
  }
  prepare(inputActor: ActorContext, key: string, input: NativeWorkIntentPrepare) {
    const actor = this.actor(inputActor), command = NativeWorkIntentPrepareSchema.parse(input);
    return this.query('SELECT pactwoven.native_work_intent_prepare($1::jsonb,$2,$3::jsonb) AS response', [actor, IdempotencyKeySchema.parse(key), command],
      NativeWorkIntentPrepareResponseSchema.refine(value => value.scope.environment === actor.environment && value.scope.organizationId === actor.organizationId && value.scope.siteId === command.siteId &&
        value.review.body.title === command.title && value.review.body.prompt === command.prompt &&
        JSON.stringify(value.review.body.selectedNotes.map(note => note.noteId)) === JSON.stringify(command.selections.map(note => note.noteId))));
  }
  confirm(inputActor: ActorContext, key: string, input: NativeWorkIntentConfirm, observation: NativeWorkIntentSessionObservation) {
    const actor = this.actor(inputActor), command = NativeWorkIntentConfirmSchema.parse(input);
    return this.query('SELECT pactwoven.native_work_intent_confirm($1::jsonb,$2,$3::jsonb,$4::jsonb) AS response', [actor, IdempotencyKeySchema.parse(key), command, NativeWorkIntentSessionObservationSchema.parse(observation)],
      NativeWorkIntentOperationSchema.refine(value => value.scope.environment === actor.environment && value.scope.organizationId === actor.organizationId && value.reviewId === command.reviewId));
  }
  recover(inputActor: ActorContext, siteId: string, key: string) {
    const actor = this.actor(inputActor), site = IdSchema.parse(siteId);
    return this.query('SELECT pactwoven.native_work_intent_recover($1::jsonb,$2,$3) AS response', [actor, site, IdempotencyKeySchema.parse(key)],
      NativeWorkIntentRecoveryResponseSchema.refine(value => value.scope.environment === actor.environment && value.scope.organizationId === actor.organizationId && value.scope.siteId === site));
  }
  provenance(inputActor: ActorContext, siteId: string, ids: string[]) {
    const actor = this.actor(inputActor), query = NativeWorkIntentProvenanceQuerySchema.parse({ siteId, ids });
    return this.query('SELECT pactwoven.native_work_intent_provenance($1::jsonb,$2::jsonb) AS response', [actor, query],
      NativeWorkIntentProvenanceResponseSchema.refine(value => value.scope.environment === actor.environment && value.scope.organizationId === actor.organizationId && value.scope.siteId === query.siteId && value.items.every(item => query.ids.includes(item.provenanceId)) && new Set(value.items.map(item => item.provenanceId)).size === value.items.length));
  }
}
