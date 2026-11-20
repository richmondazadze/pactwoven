import type { Hono } from 'hono';
import { z } from 'zod';
import { IdSchema, IdempotencyKeySchema, NativeMemoryNoteCommandSchema, NativeMemoryNoteQuerySchema,
  NativeMemoryNotePageSchema, NativeMemoryNoteResponseSchema, NativeMemoryNoteOperationSchema,
  type NativeMemoryNotesRepository, type ActorContext } from '@pactwoven/contracts';
import { DomainError } from '@pactwoven/domain';
import type { ApiEnv } from './app.js';

const SiteQuery = z.strictObject({ siteId: IdSchema });
const unavailable = () => new DomainError('DURABLE_SERVICE_UNAVAILABLE', 503, 'This memory update could not be confirmed. Check the original request before trying again.');
function checkedScope(actor: ActorContext, siteId: string, value: { environment: string; organizationId: string; siteId: string }) {
  if (value.environment !== actor.environment || value.organizationId !== actor.organizationId || value.siteId !== siteId) throw unavailable();
}
function access(actor: ActorContext, siteId: string, write = false) {
  if (actor.principalKind !== 'human' || !actor.siteIds.includes(siteId) || (write && (!actor.actionSiteIds.includes(siteId) ||
    !actor.roles.some(role => role === 'owner' || role === 'operations')))) {
    throw new DomainError('FORBIDDEN', 403, 'You do not have permission to manage memory for this site.');
  }
}
function uniqueQuery(url: string) {
  const query = new URL(url).searchParams;
  if ([...query.keys()].some(key => query.getAll(key).length !== 1)) throw new DomainError('VALIDATION_FAILED', 422, 'Use each filter only once.');
  return Object.fromEntries(query);
}

/** Registered after live identity/session resolution; DB functions repeat
 * current author, membership, site and authority checks in the transaction. */
export function registerNativeMemoryRoutes(app: Hono<ApiEnv>, repository?: NativeMemoryNotesRepository) {
  const ready = () => {
    if (!repository) throw new DomainError('SETUP_REQUIRED', 503, 'Saved memory is not connected yet.');
    return repository;
  };
  app.get('/v1/memory', async c => {
    const query = NativeMemoryNoteQuerySchema.parse(uniqueQuery(c.req.url)), actor = c.get('session').actor;
    access(actor, query.siteId);
    const result = NativeMemoryNotePageSchema.safeParse(await ready().list(actor, query));
    if (!result.success) throw unavailable();
    const page = result.data;
    checkedScope(actor, query.siteId, page.scope);
    if (page.items.length > query.limit || new Set(page.items.map(item => item.id)).size !== page.items.length ||
      (query.cursor !== undefined && query.cursor === page.nextCursor) ||
      page.items.some(item => item.status === 'removed' && item.title !== 'Removed note') ||
      (query.status !== 'all' && page.items.some(item => item.status !== query.status))) throw unavailable();
    // Bounded scans may produce short or empty filtered pages with a next cursor.
    return c.json(page);
  });
  app.get('/v1/memory/operations/:key', async c => {
    const key = IdempotencyKeySchema.parse(c.req.param('key')), query = SiteQuery.parse(uniqueQuery(c.req.url));
    const actor = c.get('session').actor; access(actor, query.siteId);
    const result = NativeMemoryNoteOperationSchema.nullable().safeParse(await ready().recover(actor, query.siteId, key));
    if (!result.success) throw unavailable();
    if (result.data !== null) {
      checkedScope(actor, query.siteId, result.data.scope);
      if (result.data.current && result.data.current.id !== result.data.noteId) throw unavailable();
    }
    return c.json({ operation: result.data });
  });
  app.get('/v1/memory/:id', async c => {
    const id = IdSchema.parse(c.req.param('id')), query = SiteQuery.parse(uniqueQuery(c.req.url)), actor = c.get('session').actor;
    access(actor, query.siteId);
    const result = NativeMemoryNoteResponseSchema.safeParse(await ready().get(actor, query.siteId, id));
    if (!result.success || result.data.note.id !== id) throw unavailable();
    checkedScope(actor, query.siteId, result.data.scope);
    return c.json(result.data);
  });
  app.post('/v1/memory', async c => {
    SiteQuery.omit({ siteId: true }).parse(uniqueQuery(c.req.url));
    const input = NativeMemoryNoteCommandSchema.parse(c.get('requestBody')), key = IdempotencyKeySchema.parse(c.req.header('Idempotency-Key'));
    const actor = c.get('session').actor; access(actor, input.siteId, true);
    const result = NativeMemoryNoteOperationSchema.safeParse(await ready().command(actor, key, input));
    if (!result.success) throw unavailable();
    const operation = result.data;
    checkedScope(actor, input.siteId, operation.scope);
    if (operation.action !== input.kind || (input.kind !== 'remember' && operation.noteId !== input.noteId) ||
      (operation.current && operation.current.id !== operation.noteId)) throw unavailable();
    return c.json(operation);
  });
}
