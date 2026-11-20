import type { Hono } from 'hono';
import { z } from 'zod';
import { IdSchema, IdempotencyKeySchema, InstantSchema, type ActorContext, type Session } from '@pactwoven/contracts';
import { DomainError } from '@pactwoven/domain';
import { NativeRootViewSchema, NativeRootControlReceiptSchema, type NativeRootControl } from '../../../packages/db/src/native-root-lifecycle-schema';
import { NativeWorkIntentScopeSchema } from '../../../packages/contracts/src/native-work-intent';
import { NativeAgentWorkControlSchema, NativeAgentWorkResponseSchema, NativeAgentWorkControlReceiptSchema,
  NativeAgentWorkListQuerySchema, NativeAgentWorkPageSchema, type NativeAgentWorkListRepository,
  type NativeAgentWork, type NativeAgentWorkControl } from '../../../packages/contracts/src/native-agent-work';
import type { ApiEnv } from './app.js';

export interface NativeAgentWorkRepository {
  read(actor: ActorContext, id: string): Promise<unknown>;
  control(actor: ActorContext, key: string, input: NativeRootControl): Promise<unknown>;
  recover(actor: ActorContext, id: string, key: string): Promise<unknown>;
}
// These fields must come from the database, never from a caller-selected site.
const RawView = NativeRootViewSchema.extend({ scope: NativeWorkIntentScopeSchema, updatedAt: InstantSchema,
  expiresAt: InstantSchema, evidenceUnavailable: z.boolean() });
const RawControl = NativeRootControlReceiptSchema.extend({ scope: NativeWorkIntentScopeSchema });
const Query = z.strictObject({ siteId: IdSchema });
const unconfirmed = () => new DomainError('DURABLE_SERVICE_UNAVAILABLE', 503, 'This work could not be confirmed. Check its current status before trying again.');
function queryValues(url: string) {
  const values = new URL(url).searchParams;
  if ([...values.keys()].some(key => values.getAll(key).length !== 1)) throw new DomainError('VALIDATION_FAILED', 422, 'Use each filter once.');
  return Object.fromEntries(values);
}
const siteQuery = (url: string) => Query.parse(queryValues(url));
function writeAccess(actor: ActorContext, siteId: string) {
  return actor.principalKind === 'human' && actor.siteIds.includes(siteId) && actor.actionSiteIds.includes(siteId) &&
    actor.roles.some(role => role === 'owner' || role === 'operations');
}
function scopeAccess(actor: ActorContext, siteId: string, write = false) {
  if (actor.principalKind !== 'human' || !actor.siteIds.includes(siteId) || (write && !writeAccess(actor, siteId))) {
    throw new DomainError('FORBIDDEN', 403, 'Your current access does not permit this work request.');
  }
}
function checkScope(actor: ActorContext, siteId: string, scope: z.infer<typeof NativeWorkIntentScopeSchema>) {
  if (scope.environment !== actor.environment || scope.organizationId !== actor.organizationId || scope.siteId !== siteId) throw unconfirmed();
}
const states = { ready: 'queued', running: 'working', yielded: 'working', waiting_children: 'waiting', paused: 'paused',
  cancelled: 'cancelled', completed: 'completed', blocked: 'needs_review' } as const;
const statusText = { ready: 'Queued for the agent team', running: 'The agent team is working', yielded: 'Continuing saved work',
  waiting_children: 'Waiting for specialist results', paused: 'Paused by you', cancelled: 'Work cancelled',
  completed: 'Advice is ready', blocked: 'This work needs review before it can continue' } as const;
function actions(raw: z.infer<typeof RawView>, actor: ActorContext): NativeAgentWorkControl['action'][] {
  if (!writeAccess(actor, raw.scope.siteId) || ['completed', 'cancelled', 'blocked'].includes(raw.state)) return [];
  return raw.state === 'paused' ? ['resume', 'cancel'] : ['pause', 'cancel'];
}
export function projectNativeAgentWork(session: Session, id: string, siteId: string, value: unknown) {
  const parsed = RawView.safeParse(value);
  if (!parsed.success || parsed.data.id !== id) throw unconfirmed();
  const raw = parsed.data; checkScope(session.actor, siteId, raw.scope);
  const site = session.sites.find(site => site.id === raw.scope.siteId);
  if (!site || (raw.evidenceUnavailable && (raw.checkpoint !== null || raw.result !== null)) ||
    (raw.result !== null && !['completed', 'blocked'].includes(raw.state))) throw unconfirmed();
  const work: NativeAgentWork = { id: raw.id, title: raw.title, prompt: raw.prompt, siteName: site.name,
    state: states[raw.state], statusText: raw.evidenceUnavailable ? 'Earlier evidence is no longer available to this view' : statusText[raw.state],
    controlVersion: raw.controlVersion, updatedAt: raw.updatedAt, expiresAt: raw.expiresAt, availableActions: actions(raw, session.actor),
    progress: raw.checkpoint ? { summary: raw.checkpoint.summary, steps: raw.checkpoint.steps, historical: raw.checkpointHistorical } : null,
    result: raw.result ? { title: raw.result.title, summary: raw.result.summary, artifacts: raw.result.artifacts,
      evidenceValidUntil: raw.result.evidenceValidUntil, advisoryOnly: true } : null,
    evidenceUnavailable: raw.evidenceUnavailable, continuesAfterSignOut: true, externalEffects: 'forbidden' };
  return NativeAgentWorkResponseSchema.parse({ scope: raw.scope, work });
}
function projectControl(actor: ActorContext, id: string, siteId: string, value: unknown, action?: NativeAgentWorkControl['action']) {
  const parsed = RawControl.safeParse(value);
  if (!parsed.success || parsed.data.rootTaskId !== id || (action && parsed.data.action !== action)) throw unconfirmed();
  const raw = parsed.data; checkScope(actor, siteId, raw.scope);
  return NativeAgentWorkControlReceiptSchema.parse({ scope: raw.scope, operationId: raw.operationId, rootTaskId: raw.rootTaskId,
    action: raw.action, controlVersion: raw.controlVersion, state: states[raw.state], committedAt: raw.committedAt });
}
export function registerNativeAgentWorkRoutes(app: Hono<ApiEnv>, repository?: NativeAgentWorkRepository, lists?: NativeAgentWorkListRepository) {
  const ready = () => {
    if (!repository) throw new DomainError('SETUP_REQUIRED', 503, 'Background advisory work is not connected yet.');
    return repository;
  };
  app.get('/v1/agent-work', async c => {
    const query = NativeAgentWorkListQuerySchema.parse(queryValues(c.req.url)), actor = c.get('session').actor;
    scopeAccess(actor, query.siteId);
    if (!lists) throw new DomainError('SETUP_REQUIRED', 503, 'Background advisory work is not connected yet.');
    const parsed = NativeAgentWorkPageSchema.safeParse(await lists.list(actor, query));
    if (!parsed.success) throw unconfirmed();
    const page = parsed.data;checkScope(actor, query.siteId, page.scope);
    if (page.items.length > query.limit || new Set(page.items.map(item => item.id)).size !== page.items.length ||
      (page.nextCursor && (page.items.length !== query.limit || page.nextCursor === query.cursor)) ||
      page.items.some(item => query.filter === 'completed' ? item.state !== 'completed' : query.filter === 'active' && ['completed', 'cancelled'].includes(item.state))) throw unconfirmed();
    return c.json(page);
  });
  app.get('/v1/agent-work/:id', async c => {
    const id = IdSchema.parse(c.req.param('id')), { siteId } = siteQuery(c.req.url), session = c.get('session');
    scopeAccess(session.actor, siteId);
    return c.json(projectNativeAgentWork(session, id, siteId, await ready().read(session.actor, id)));
  });
  app.post('/v1/agent-work/:id/control', async c => {
    const id = IdSchema.parse(c.req.param('id')), { siteId } = siteQuery(c.req.url), session = c.get('session');
    const input = NativeAgentWorkControlSchema.parse(c.get('requestBody')), key = IdempotencyKeySchema.parse(c.req.header('Idempotency-Key'));
    scopeAccess(session.actor, siteId, true);
    // Verify immutable root/site binding before dispatch. The SQL command repeats
    // current authority, original-key and version checks in its transaction.
    projectNativeAgentWork(session, id, siteId, await ready().read(session.actor, id));
    return c.json(projectControl(session.actor, id, siteId, await ready().control(session.actor, key, { ...input, rootTaskId: id }), input.action));
  });
  app.get('/v1/agent-work/:id/controls/:key', async c => {
    const id = IdSchema.parse(c.req.param('id')), key = IdempotencyKeySchema.parse(c.req.param('key'));
    const { siteId } = siteQuery(c.req.url), session = c.get('session'); scopeAccess(session.actor, siteId);
    projectNativeAgentWork(session, id, siteId, await ready().read(session.actor, id));
    const operation = await ready().recover(session.actor, id, key);
    return c.json({ operation: operation === null ? null : projectControl(session.actor, id, siteId, operation) });
  });
}
