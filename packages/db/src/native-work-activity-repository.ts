import type { Pool } from 'pg';
import { z } from 'zod';
import { ActorContextSchema, EnvironmentSchema, IdSchema, InstantSchema, type ActorContext, type Environment } from '../../contracts/src/core';
import { DomainError } from '../../domain/src/errors';
import { NativeRootViewSchema } from './native-root-lifecycle-schema';

const Version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const NativeWorkActivityFrameSchema = z.strictObject({
  root: NativeRootViewSchema,
  instructionRevision: z.number().int().min(0).max(16),
  observedAt: InstantSchema,
  children: z.array(z.strictObject({
    taskId: IdSchema, handoffId: IdSchema, assignmentVersion: Version, generation: Version,
    role: z.enum(['research', 'planning', 'escalation']),
    state: z.enum(['ready', 'running', 'paused', 'cancelled', 'settled']),
    outcome: z.enum(['advice_ready', 'failed']).nullable(), current: z.literal(true),
  })).max(32),
}).superRefine((frame, ctx) => {
  if (new Set(frame.children.map(child => child.taskId)).size !== frame.children.length ||
      new Set(frame.children.map(child => child.handoffId)).size !== frame.children.length ||
      frame.children.some(child => child.taskId === frame.root.id || child.state !== 'settled' && child.outcome !== null) ||
      (frame.root.evidenceUnavailable || frame.root.checkpointHistorical) && frame.children.length > 0 ||
      frame.root.evidenceUnavailable && (frame.root.checkpoint !== null || frame.root.result !== null)) {
    ctx.addIssue({ code: 'custom', message: 'The recorded activity is inconsistent.' });
  }
});
export type NativeWorkActivityFrame = z.infer<typeof NativeWorkActivityFrameSchema>;

/** Human-scoped metadata only. No worker claims, provider credentials or artifact
 * bodies are available through this reader. Root and children share one call. */
export class PostgresNativeWorkActivityRepository {
  constructor(private readonly pool: Pick<Pool, 'query'>, private readonly environment: Environment) {
    EnvironmentSchema.parse(environment);
  }
  async read(input: ActorContext, id: string, siteId: string): Promise<NativeWorkActivityFrame> {
    const actor = ActorContextSchema.parse(input);
    IdSchema.parse(id); IdSchema.parse(siteId);
    if (actor.environment !== this.environment || actor.principalKind !== 'human' || !actor.siteIds.includes(siteId)) {
      throw new DomainError('FORBIDDEN', 403, 'Current work access is required.');
    }
    try {
      const result = await this.pool.query<{ response: unknown }>(
        'SELECT pactwoven.native_work_activity_read($1::jsonb,$2,$3) AS response', [actor, id, siteId]);
      if (result.rows.length !== 1) throw new Error('Missing activity response');
      const frame = NativeWorkActivityFrameSchema.parse(result.rows[0]?.response), scope = frame.root.scope;
      if (frame.root.id !== id || scope.environment !== actor.environment ||
          scope.organizationId !== actor.organizationId || scope.siteId !== siteId) throw new Error('Activity scope mismatch');
      return frame;
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
      if (code === 'ND001' || code === 'NM001') throw new DomainError('FORBIDDEN', 403, 'Current work access is required.');
      throw new DomainError('DURABLE_SERVICE_UNAVAILABLE', 503, 'Agent activity could not be refreshed.');
    }
  }
}
