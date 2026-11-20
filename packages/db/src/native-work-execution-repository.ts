import type { Pool } from 'pg';
import { z } from 'zod';
import { ActorContextSchema, EnvironmentSchema, IdSchema, InstantSchema, type ActorContext, type Environment } from '../../contracts/src/core';
import { DomainError } from '../../domain/src/errors';
import { NativeRootViewSchema } from './native-root-lifecycle-schema';

const Version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const Child = z.strictObject({
  taskId: IdSchema, handoffId: IdSchema, assignmentVersion: Version, generation: Version,
  role: z.enum(['research', 'planning', 'escalation']), state: z.enum(['ready', 'running']),
  leaseUntil: InstantSchema.nullable(), current: z.literal(true),
});
export const NativeWorkExecutionFrameSchema = z.strictObject({
  root: NativeRootViewSchema,
  instructionRevision: z.number().int().min(0).max(16), observedAt: InstantSchema,
  currentExecution: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('unavailable'), validUntil: z.null(), children: z.array(Child).length(0) }),
    z.strictObject({ kind: z.literal('verified'), validUntil: InstantSchema, children: z.array(Child).min(1).max(32) }),
  ]),
}).superRefine((frame, ctx) => {
  const execution = frame.currentExecution;
  if (frame.root.evidenceUnavailable && (frame.root.checkpoint !== null || frame.root.result !== null)) {
    ctx.addIssue({ code: 'custom', message: 'Unavailable evidence must remain hidden.' });
  }
  if (execution.kind === 'unavailable') return;
  const observed = Date.parse(frame.observedAt), until = Date.parse(execution.validUntil);
  if (frame.root.state !== 'waiting_children' || frame.root.reason !== 'none' || frame.root.evidenceUnavailable ||
      until <= observed || until > observed + 10000 || until > Date.parse(frame.root.expiresAt) ||
      new Set(execution.children.map(child => child.taskId)).size !== execution.children.length ||
      new Set(execution.children.map(child => child.handoffId)).size !== execution.children.length ||
      execution.children.some(child => child.taskId === frame.root.id || (child.state === 'ready' ? child.leaseUntil !== null :
        child.leaseUntil === null || Date.parse(child.leaseUntil) < until))) {
    ctx.addIssue({ code: 'custom', message: 'The current execution observation is inconsistent.' });
  }
});
export type NativeWorkExecutionFrame = z.infer<typeof NativeWorkExecutionFrameSchema>;

/** Optional current metadata reader; never substitutes for result freshness. */
export class PostgresNativeWorkExecutionRepository {
  constructor(private readonly pool: Pick<Pool, 'query'>, private readonly environment: Environment) {
    EnvironmentSchema.parse(environment);
  }
  async read(input: ActorContext, id: string, siteId: string): Promise<NativeWorkExecutionFrame> {
    const actor = ActorContextSchema.parse(input);
    IdSchema.parse(id); IdSchema.parse(siteId);
    if (actor.environment !== this.environment || actor.principalKind !== 'human' || !actor.siteIds.includes(siteId)) {
      throw new DomainError('FORBIDDEN', 403, 'Current work access is required.');
    }
    try {
      const result = await this.pool.query<{ response: unknown }>(
        'SELECT pactwoven.native_work_execution_read($1::jsonb,$2,$3) AS response', [actor, id, siteId]);
      if (result.rows.length !== 1) throw new Error('Missing execution response');
      const frame = NativeWorkExecutionFrameSchema.parse(result.rows[0]?.response), scope = frame.root.scope;
      if (frame.root.id !== id || scope.environment !== actor.environment ||
          scope.organizationId !== actor.organizationId || scope.siteId !== siteId) throw new Error('Execution scope mismatch');
      return frame;
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
      if (code === 'ND001' || code === 'NM001') throw new DomainError('FORBIDDEN', 403, 'Current work access is required.');
      throw new DomainError('DURABLE_SERVICE_UNAVAILABLE', 503, 'Agent activity could not be refreshed.');
    }
  }
}
