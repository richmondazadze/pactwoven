import type { Pool } from 'pg';
import { z } from 'zod';
import { DomainError } from '@pactwoven/domain';
import { ActorContextSchema, EnvironmentSchema, IdSchema, InstantSchema, type ActorContext, type Environment } from '../../contracts/src/core';
import { NativeWorkIntentScopeSchema } from '../../contracts/src/native-work-intent';
import { NativeAgentWorkListQuerySchema, NativeAgentWorkPageSchema, NativeAgentWorkSummarySchema,
  type NativeAgentWorkListRepository, type NativeAgentWorkListQuery } from '../../contracts/src/native-agent-work';
const Position = z.strictObject({ createdAt: InstantSchema, id: IdSchema });
const Cursor = z.strictObject({ version: z.literal(1), scope: NativeWorkIntentScopeSchema, actorId: IdSchema,
  q: z.string().max(180), filter: z.enum(['all', 'active', 'completed']), after: Position });
const DatabasePage = z.strictObject({ scope: NativeWorkIntentScopeSchema, items: z.array(NativeAgentWorkSummarySchema).max(50), next: Position.nullable() });
export class PostgresNativeAgentWorkListRepository implements NativeAgentWorkListRepository {
  constructor(private readonly pool: Pool, private readonly environment: Environment) { EnvironmentSchema.parse(environment); }
  async list(inputActor: ActorContext, input: NativeAgentWorkListQuery) {
    const actor = ActorContextSchema.parse(inputActor), query = NativeAgentWorkListQuerySchema.parse(input);
    if (actor.environment !== this.environment || actor.principalKind !== 'human' || !actor.siteIds.includes(query.siteId)) throw new DomainError('FORBIDDEN', 403, 'Current work access is required.');
    const scope = { environment: this.environment, organizationId: actor.organizationId, siteId: query.siteId };
    let after: z.infer<typeof Position> | null = null;
    if (query.cursor) {
      try {
        const bytes = Buffer.from(query.cursor, 'base64url'); if (bytes.toString('base64url') !== query.cursor) throw Error();
        const cursor = Cursor.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
        if (cursor.scope.environment !== scope.environment || cursor.scope.organizationId !== scope.organizationId || cursor.scope.siteId !== scope.siteId ||
          cursor.actorId !== actor.actorId || cursor.q !== query.q || cursor.filter !== query.filter) throw Error();
        after = cursor.after;
      } catch { throw new DomainError('VALIDATION_FAILED', 422, 'Refresh your work list to continue.'); }
    }
    try {
      const result = await this.pool.query<{ response: unknown }>('SELECT pactwoven.native_agent_work_list($1::jsonb,$2::jsonb) AS response',
        [actor, { siteId: query.siteId, limit: query.limit, q: query.q, filter: query.filter, after }]);
      if (result.rows.length !== 1) throw Error(); const page = DatabasePage.parse(result.rows[0]?.response);
      if (page.scope.environment !== scope.environment || page.scope.organizationId !== scope.organizationId || page.scope.siteId !== scope.siteId ||
        page.items.length > query.limit || new Set(page.items.map(item => item.id)).size !== page.items.length ||
        (page.next && (page.items.length !== query.limit || page.next.id !== page.items.at(-1)?.id || page.next.createdAt !== page.items.at(-1)?.createdAt || page.next.id === after?.id)) ||
        page.items.some(item => query.filter === 'completed' ? item.state !== 'completed' : query.filter === 'active' && ['completed', 'cancelled'].includes(item.state))) throw Error();
      const nextCursor = page.next ? Buffer.from(JSON.stringify({ version: 1, scope, actorId: actor.actorId, q: query.q, filter: query.filter, after: page.next })).toString('base64url') : null;
      return NativeAgentWorkPageSchema.parse({ scope, items: page.items, nextCursor });
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error) {
        if (['NW001', 'ND001', 'NM001'].includes(String(error.code))) throw new DomainError('FORBIDDEN', 403, 'Current work access is required.');
        if (error.code === 'NW004') throw new DomainError('VALIDATION_FAILED', 422, 'Check your work filters.');
      }
      throw new DomainError('DURABLE_SERVICE_UNAVAILABLE', 503, 'Your work list could not be loaded.');
    }
  }
}
