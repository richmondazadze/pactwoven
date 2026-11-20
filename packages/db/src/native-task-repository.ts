import { Pool } from 'pg';
import { z } from 'zod';
import {
  ActorContextSchema, CreateNativeTaskSchema, EnvironmentSchema, IdempotencyKeySchema, IdSchema, InstantSchema,
  NativeTaskArtifactSchema, NativeTaskControlSchema, NativeTaskEventSchema, NativeTaskMessageSchema,
  NativeTaskReplySchema, NativeTaskSchema, NativeTaskStepSchema, NativeTaskSummarySchema,
  NativeTaskSearchFilterSchema, NativeTaskSearchQuerySchema, NativeTaskSearchResultSchema,
  type ActorContext, type CreateNativeTask, type Environment, type NativeTask, type NativeTaskClaim,
  type NativeTaskControl, type NativeTaskProgress, type NativeTaskReply, type NativeTaskRepository,
  type NativeTaskSummary, type NativeTaskWorkerRepository, type NativeTaskSearchQuery, type NativeTaskSearchResult,
} from '@pactwoven/contracts';
import { DomainError } from '@pactwoven/domain';

const LeaseDurationSchema = z.number().int().min(1_000).max(300_000);
const CheckpointSchema = z.record(z.string(), z.unknown()).refine(value => {
  try { return new TextEncoder().encode(JSON.stringify(value)).byteLength <= 262_144; } catch { return false; }
}, 'The task checkpoint exceeds its storage limit.');
const ClaimSchema = z.strictObject({ task: NativeTaskSchema, environment: EnvironmentSchema,
  organizationId: IdSchema, actorId: IdSchema, leaseToken: z.uuid(), checkpoint: CheckpointSchema });
const ProgressSchema = z.strictObject({
  title: z.string().min(1).max(180).optional(), phase: z.string().min(1).max(180),
  status: z.enum(['running', 'waiting_for_input', 'waiting_for_reply', 'completed', 'failed']).optional(),
  evidenceValidUntil: InstantSchema.optional(),
  event: NativeTaskEventSchema.omit({ sequence: true, createdAt: true }), steps: z.array(NativeTaskStepSchema).max(32).optional(),
  message: NativeTaskMessageSchema.omit({ createdAt: true }).extend({ role: z.literal('assistant') }).optional(),
  artifact: NativeTaskArtifactSchema.omit({ createdAt: true }).optional(), checkpoint: CheckpointSchema,
}).refine(value => value.status === 'completed' || value.status === 'failed'
  ? value.event.kind === value.status : ['progress', 'message', 'artifact'].includes(value.event.kind), 'Progress must match the task state.')
  .refine(value => value.evidenceValidUntil === undefined || value.status === 'completed', 'Evidence validity only applies to final publication.');
const ListSchema = z.array(NativeTaskSummarySchema).max(100);
const CursorPayloadSchema = z.strictObject({
  v: z.literal(1), environment: EnvironmentSchema, organizationId: IdSchema, actorId: IdSchema,
  q: z.string().max(180), filter: NativeTaskSearchFilterSchema, createdAt: InstantSchema, id: IdSchema,
});
const SearchDatabaseResultSchema = z.strictObject({ items: ListSchema, next: CursorPayloadSchema.nullable() });
function decodeCursor(cursor: string | undefined, actor: ActorContext, query: NativeTaskSearchQuery) {
  if (cursor === undefined) return null;
  try {
    const bytes = Buffer.from(cursor, 'base64url');
    if (bytes.toString('base64url') !== cursor) throw new Error('Noncanonical cursor');
    const result = CursorPayloadSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    if (result.environment !== actor.environment || result.organizationId !== actor.organizationId || result.actorId !== actor.actorId ||
        result.q !== query.q || result.filter !== query.filter) throw new Error('Cursor context changed');
    return result;
  } catch { throw new DomainError('VALIDATION_FAILED', 422, 'This work page has changed. Refresh the list to continue.'); }
}

function databaseError(error: unknown): never {
  if (error instanceof DomainError) throw error;
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
  const known = {
    NT001: ['FORBIDDEN', 403, 'Current company and task access is required.'],
    NT002: ['NOT_FOUND', 404, 'Task not found.'],
    NT003: ['IDEMPOTENCY_CONFLICT', 409, 'This request reference was already used for a different update.'],
    NT004: ['VALIDATION_FAILED', 422, 'Check the task details.'],
    NT005: ['VERSION_CONFLICT', 409, 'This task changed. Review its latest state before updating it.'],
    NT006: ['INVALID_TASK_STATE', 409, 'That action is not available for this task now.'],
    NT007: ['TASK_CAPACITY_REACHED', 409, 'This task has reached its conversation or result limit. Start a new task to continue.'],
    NT008: ['EVIDENCE_STALE', 409, 'The evidence must be refreshed before this recommendation can be published.'],
  } as const;
  if (typeof code === 'string' && Object.hasOwn(known, code)) {
    const [name, status, message] = known[code as keyof typeof known];
    throw new DomainError(name, status, message);
  }
  // A lost response may follow a committed mutation. Never turn it into a
  // failure or silently issue a different command/key; the API exposes recovery.
  throw new DomainError('DURABLE_SERVICE_UNAVAILABLE', 503, 'The task service is temporarily unavailable. Your latest update has not been confirmed.');
}

export class PostgresNativeTaskRepository implements NativeTaskRepository {
  constructor(private readonly pool: Pool, private readonly environment: Environment) { EnvironmentSchema.parse(environment); }
  private actor(input: ActorContext): ActorContext {
    const actor = ActorContextSchema.parse(input);
    if (actor.environment !== this.environment || actor.principalKind !== 'human') {
      throw new DomainError('FORBIDDEN', 403, 'Current company and task access is required.');
    }
    return actor;
  }
  private async task(sql: string, parameters: unknown[]): Promise<NativeTask> {
    try {
      const result = await this.pool.query<{ response: unknown }>(sql, parameters);
      if (result.rows.length !== 1) throw new Error('Missing task response');
      return NativeTaskSchema.parse(result.rows[0]?.response);
    } catch (error) { return databaseError(error); }
  }
  async create(actor: ActorContext, key: string, input: CreateNativeTask): Promise<NativeTask> {
    return this.task('SELECT pactwoven.native_task_create($1::jsonb,$2,$3::jsonb) AS response',
      [JSON.stringify(this.actor(actor)), IdempotencyKeySchema.parse(key), JSON.stringify(CreateNativeTaskSchema.parse(input))]);
  }
  async list(actor: ActorContext, limit: number): Promise<NativeTaskSummary[]> {
    const parameters = [JSON.stringify(this.actor(actor)), z.number().int().min(1).max(100).parse(limit)];
    try {
      const result = await this.pool.query<{ response: unknown }>('SELECT pactwoven.native_task_read($1::jsonb,NULL,$2) AS response', parameters);
      if (result.rows.length !== 1) throw new Error('Missing task page');
      return ListSchema.parse(result.rows[0]?.response);
    } catch (error) { return databaseError(error); }
  }
  async search(inputActor: ActorContext, input: NativeTaskSearchQuery): Promise<NativeTaskSearchResult> {
    const actor = this.actor(inputActor), query = NativeTaskSearchQuerySchema.parse(input);
    const after = decodeCursor(query.cursor, actor, query);
    try {
      const result = await this.pool.query<{ response: unknown }>('SELECT pactwoven.native_task_search($1::jsonb,$2::jsonb) AS response',
        [JSON.stringify(actor), JSON.stringify({ limit: query.limit, q: query.q, filter: query.filter, after })]);
      if (result.rows.length !== 1) throw new Error('Missing task page');
      const page = SearchDatabaseResultSchema.parse(result.rows[0]?.response);
      if (page.items.length > query.limit || (page.next !== null && (page.items.length !== query.limit ||
          page.next.id !== page.items.at(-1)?.id || page.next.createdAt !== page.items.at(-1)?.createdAt))) throw new Error('Invalid task page');
      const nextCursor = page.next === null ? null : Buffer.from(JSON.stringify(page.next), 'utf8').toString('base64url');
      if (nextCursor !== null) decodeCursor(nextCursor, actor, query);
      return NativeTaskSearchResultSchema.parse({ items: page.items, nextCursor });
    } catch (error) { return databaseError(error); }
  }
  async get(actor: ActorContext, id: string): Promise<NativeTask> {
    return this.task('SELECT pactwoven.native_task_read($1::jsonb,$2,NULL) AS response', [JSON.stringify(this.actor(actor)), IdSchema.parse(id)]);
  }
  async control(actor: ActorContext, id: string, input: NativeTaskControl): Promise<NativeTask> {
    return this.task("SELECT pactwoven.native_task_command($1::jsonb,$2,'control',NULL,$3::jsonb) AS response",
      [JSON.stringify(this.actor(actor)), IdSchema.parse(id), JSON.stringify(NativeTaskControlSchema.parse(input))]);
  }
  async reply(actor: ActorContext, id: string, key: string, input: NativeTaskReply): Promise<NativeTask> {
    return this.task("SELECT pactwoven.native_task_command($1::jsonb,$2,'reply',$3,$4::jsonb) AS response",
      [JSON.stringify(this.actor(actor)), IdSchema.parse(id), IdempotencyKeySchema.parse(key), JSON.stringify(NativeTaskReplySchema.parse(input))]);
  }
}

export class PostgresNativeTaskWorkerRepository implements NativeTaskWorkerRepository {
  constructor(private readonly pool: Pool, private readonly environment: Environment) { EnvironmentSchema.parse(environment); }
  async claim(workerId: string, leaseMilliseconds: number): Promise<NativeTaskClaim | null> {
    const parameters = [this.environment, IdSchema.parse(workerId), LeaseDurationSchema.parse(leaseMilliseconds)];
    try {
      const result = await this.pool.query<{ response: unknown }>('SELECT pactwoven.native_task_claim($1,$2,$3) AS response', parameters);
      if (result.rows.length !== 1 || result.rows[0]?.response === undefined) throw new Error('Missing claim response');
      if (result.rows[0].response === null) return null;
      const claim = ClaimSchema.parse(result.rows[0].response);
      if (claim.environment !== this.environment) throw new Error('Invalid claim scope');
      return claim;
    } catch (error) { return databaseError(error); }
  }
  private async lease(input: NativeTaskClaim, kind: 'renew' | 'release' | 'progress', milliseconds: number | null, update: NativeTaskProgress | null): Promise<boolean> {
    // A claim is an internal capability. Only use its immutable selector and
    // lease token; do not send task JSON back as evidence of current state.
    const claim = ClaimSchema.parse(input);
    if (claim.environment !== this.environment) throw new DomainError('FORBIDDEN', 403, 'This task belongs to another environment.');
    const progress = update === null ? null : ProgressSchema.parse(update);
    try {
      const result = await this.pool.query<{ response: unknown }>('SELECT pactwoven.native_task_lease($1,$2,$3,$4::uuid,$5,$6,$7::jsonb) AS response',
        [this.environment, claim.organizationId, claim.task.id, claim.leaseToken, kind, milliseconds, progress === null ? null : JSON.stringify(progress)]);
      if (result.rows.length !== 1 || typeof result.rows[0]?.response !== 'boolean') throw new Error('Missing lease response');
      return result.rows[0].response;
    } catch (error) { return databaseError(error); }
  }
  async renew(claim: NativeTaskClaim, leaseMilliseconds: number): Promise<boolean> {
    return this.lease(claim, 'renew', LeaseDurationSchema.parse(leaseMilliseconds), null);
  }
  async progress(claim: NativeTaskClaim, update: NativeTaskProgress): Promise<boolean> {
    return this.lease(claim, 'progress', null, update);
  }
  async release(claim: NativeTaskClaim): Promise<void> { await this.lease(claim, 'release', null, null); }
}
