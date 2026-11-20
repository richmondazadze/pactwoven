import type { Hono } from 'hono';
import { z } from 'zod';
import { IdSchema, type ActorContext } from '@pactwoven/contracts';
import { DomainError } from '@pactwoven/domain';
import type { ApiEnv } from './app';
import { projectNativeWorkActivity } from './native-work-activity';

export interface NativeWorkActivityRepository {
  read(actor: ActorContext, id: string, siteId: string): Promise<unknown>;
}
const Query = z.strictObject({ siteId: IdSchema });
/** Mount only behind the same authenticated session middleware as agent-work. */
export function registerNativeWorkActivityRoutes(app: Hono<ApiEnv>, repository?: NativeWorkActivityRepository,
  now: () => string = () => new Date().toISOString()) {
  app.get('/v1/agent-work/:id/activity', async c => {
    c.header('Cache-Control', 'private, no-store');
    const values = new URL(c.req.url).searchParams;
    if ([...values.keys()].some(key => values.getAll(key).length !== 1)) {
      throw new DomainError('VALIDATION_FAILED', 422, 'Use each activity filter once.');
    }
    const id = IdSchema.parse(c.req.param('id')), { siteId } = Query.parse(Object.fromEntries(values));
    const session = c.get('session'), actor = session.actor;
    if (actor.principalKind !== 'human' || !actor.siteIds.includes(siteId) || !session.sites.some(site => site.id === siteId)) {
      throw new DomainError('FORBIDDEN', 403, 'Your current access does not permit this work request.');
    }
    if (!repository) throw new DomainError('SETUP_REQUIRED', 503, 'Recorded agent activity is not connected yet.');
    const frame = await repository.read(actor, id, siteId);
    return c.json(projectNativeWorkActivity(session, id, siteId, frame, now()));
  });
}
