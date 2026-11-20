import type { Hono } from 'hono';
import { DomainError } from '@pactwoven/domain';
import { NativeAgentWorkPageSchema, type NativeAgentWorkListRepository } from '../../../packages/contracts/src/native-agent-work';
import { NativeAgentAttentionQuerySchema, NativeAgentAttentionPageSchema } from '../../../packages/contracts/src/native-agent-attention';
import type { ApiEnv } from './app';

const unavailable = () => new DomainError('DURABLE_SERVICE_UNAVAILABLE', 503, 'Your attention items could not be checked. Refresh the inbox to try again.');

/** Mount after signed current-session resolution and before /agent-work/:id.
 * Uses the existing scoped list capability; creates no operation or authority. */
export function registerNativeAgentAttentionRoutes(app: Hono<ApiEnv>, lists?: NativeAgentWorkListRepository) {
  app.get('/v1/agent-work/attention', async c => {
    c.header('Cache-Control', 'private, no-store');
    const values = new URL(c.req.url).searchParams;
    if ([...values.keys()].some(key => values.getAll(key).length !== 1)) {
      throw new DomainError('VALIDATION_FAILED', 422, 'Use each inbox filter once.');
    }
    const query = NativeAgentAttentionQuerySchema.parse(Object.fromEntries(values));
    const actor = c.get('session').actor;
    if (actor.principalKind !== 'human' || !actor.siteIds.includes(query.siteId)) {
      throw new DomainError('FORBIDDEN', 403, 'Your current access does not permit this inbox.');
    }
    if (!lists) throw new DomainError('SETUP_REQUIRED', 503, 'The work inbox is not connected yet.');
    let value: unknown;
    try {
      value = await lists.list(actor, { siteId: query.siteId, limit: query.limit, q: '', filter: 'active',
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }) });
    } catch (error) {
      if (error instanceof DomainError && error.status === 403) throw new DomainError('FORBIDDEN', 403, 'Your current access does not permit this inbox.');
      if (error instanceof DomainError && error.status === 422) throw new DomainError('VALIDATION_FAILED', 422, 'Refresh the inbox to check its current records.');
      throw unavailable();
    }
    const parsed = NativeAgentWorkPageSchema.safeParse(value);
    if (!parsed.success) throw unavailable();
    const page = parsed.data;
    if (page.scope.environment !== actor.environment || page.scope.organizationId !== actor.organizationId || page.scope.siteId !== query.siteId ||
      page.items.length > query.limit || new Set(page.items.map(item => item.id)).size !== page.items.length ||
      page.items.some(item => item.state === 'completed' || item.state === 'cancelled') ||
      (page.nextCursor !== null && (page.items.length !== query.limit || page.nextCursor === query.cursor))) throw unavailable();
    // Preserve the scan cursor, including empty attention pages, so older
    // attention records remain reachable without an unbounded server loop.
    return c.json(NativeAgentAttentionPageSchema.parse({ scope: page.scope,
      items: page.items.filter(item => item.state === 'needs_review'), nextCursor: page.nextCursor,
      scannedCount: page.items.length, scanComplete: page.nextCursor === null }));
  });
}
