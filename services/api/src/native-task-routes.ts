import type { Hono } from 'hono';
import {
  CreateNativeTaskSchema, IdempotencyKeySchema, IdSchema, NativeTaskControlSchema,
  NativeTaskPageSchema, NativeTaskReplySchema, NativeTaskResponseSchema, NativeTaskSearchQuerySchema,
  NativeWorkIntentProvenanceResponseSchema, type NativeWorkIntentRepository, type ActorContext, type NativeTaskRepository,
} from '@pactwoven/contracts';
import { NativeWorkContinuationSchema } from '../../../packages/contracts/src/native-work-continuation';
import { DomainError } from '@pactwoven/domain';
import type { ApiEnv } from './app.js';

const unavailable = () => new DomainError('DURABLE_SERVICE_UNAVAILABLE', 503, 'Your work could not be confirmed. Please try again.');
const scope = (actor: ActorContext) => ({ environment: actor.environment, organizationId: actor.organizationId });

function taskResponse(actor: ActorContext, value: unknown, expectedId?: string) {
  const parsed = NativeTaskResponseSchema.safeParse({ scope: scope(actor), task: value });
  if (!parsed.success || !actor.siteIds.includes(parsed.data.task.siteId) ||
      (expectedId !== undefined && parsed.data.task.id !== expectedId)) throw unavailable();
  return parsed.data;
}

// Registered after identity and current-session resolution. Repository functions
// repeat current membership/ownership checks at the database effect boundary.
export function registerNativeTaskRoutes(app: Hono<ApiEnv>, repository?: NativeTaskRepository,
  provenance?: Pick<NativeWorkIntentRepository, 'provenance'>) {
  function ready(): NativeTaskRepository {
    if (!repository) throw new DomainError('SETUP_REQUIRED', 503, 'Agent work is not connected yet.');
    return repository;
  }

  async function continuations(actor: ActorContext, tasks: { id: string; siteId: string }[]) {
    const found = new Map<string, { id: string; siteId: string; kind: 'agent_work' }>();
    if (!provenance) return found;
    for (const siteId of new Set(tasks.map(task => task.siteId))) {
      const ids = tasks.filter(task => task.siteId === siteId).map(task => task.id);
      const value = NativeWorkIntentProvenanceResponseSchema.safeParse(await provenance.provenance(actor, siteId, ids));
      if (!value.success || value.data.scope.environment !== actor.environment || value.data.scope.organizationId !== actor.organizationId ||
        value.data.scope.siteId !== siteId || value.data.items.some(item => !ids.includes(item.provenanceId)) ||
        new Set(value.data.items.map(item => item.provenanceId)).size !== value.data.items.length) throw unavailable();
      for (const item of value.data.items) found.set(item.provenanceId, { kind: 'agent_work', id: item.rootTaskId, siteId });
    }
    return found;
  }
  async function requireLegacyTask(actor: ActorContext, id: string) {
    const response = taskResponse(actor, await ready().get(actor, id), id);
    if ((await continuations(actor, [response.task])).size) throw new DomainError('WORK_CONTINUES_ELSEWHERE', 409, 'Open this work from its current page.');
    return response;
  }

  app.get('/v1/tasks', async c => {
    const parameters = new URL(c.req.url).searchParams;
    if ([...parameters.keys()].some(key => parameters.getAll(key).length !== 1)) {
      throw new DomainError('VALIDATION_FAILED', 422, 'Use each filter only once.');
    }
    const query = NativeTaskSearchQuerySchema.parse(c.req.query());
    const actor = c.get('session').actor;
    const page = await ready().search(actor, query);
    const parsed = NativeTaskPageSchema.safeParse({ ...page, scope: scope(actor) });
    if (!parsed.success || parsed.data.items.length > query.limit || parsed.data.items.some(task => !actor.siteIds.includes(task.siteId)) ||
        (parsed.data.nextCursor !== null && parsed.data.items.length !== query.limit) ||
        parsed.data.nextCursor === query.cursor || new Set(parsed.data.items.map(task => task.id)).size !== parsed.data.items.length) throw unavailable();
    const moved = await continuations(actor, parsed.data.items);
    // Keep the original scan cursor even when every row on this page was an
    // inert provenance record. Clients can continue without skipping history.
    return c.json({ ...parsed.data, items: parsed.data.items.filter(task => !moved.has(task.id)) });
  });

  app.get('/v1/tasks/:id/continuation', async c => {
    const id = IdSchema.parse(c.req.param('id')), actor = c.get('session').actor;
    const response = taskResponse(actor, await ready().get(actor, id), id);
    const moved = await continuations(actor, [response.task]);
    return c.json(NativeWorkContinuationSchema.parse({ scope: scope(actor), taskId: id, continuation: moved.get(id) ?? null }));
  });

  app.get('/v1/tasks/:id', async c => {
    const id = IdSchema.parse(c.req.param('id'));
    const actor = c.get('session').actor;
    return c.json(await requireLegacyTask(actor, id));
  });

  app.post('/v1/tasks', async c => {
    const input = CreateNativeTaskSchema.parse(c.get('requestBody'));
    const key = IdempotencyKeySchema.parse(c.req.header('Idempotency-Key'));
    const actor = c.get('session').actor;
    if (actor.principalKind !== 'human' || !actor.roles.some(role => role === 'owner' || role === 'operations') ||
        !actor.actionSiteIds.includes(input.siteId)) {
      throw new DomainError('FORBIDDEN', 403, 'You do not have permission to start work for this site.');
    }
    const response = taskResponse(actor, await ready().create(actor, key, input));
    if (response.task.siteId !== input.siteId || response.task.prompt !== input.prompt) throw unavailable();
    c.header('Location', `/v1/tasks/${encodeURIComponent(response.task.id)}`);
    return c.json(response, 201);
  });

  app.post('/v1/tasks/:id/control', async c => {
    const id = IdSchema.parse(c.req.param('id'));
    const input = NativeTaskControlSchema.parse(c.get('requestBody'));
    const actor = c.get('session').actor;
    if (provenance) await requireLegacyTask(actor, id);
    return c.json(taskResponse(actor, await ready().control(actor, id, input), id));
  });

  app.post('/v1/tasks/:id/messages', async c => {
    const id = IdSchema.parse(c.req.param('id'));
    const input = NativeTaskReplySchema.parse(c.get('requestBody'));
    const key = IdempotencyKeySchema.parse(c.req.header('Idempotency-Key'));
    const actor = c.get('session').actor;
    if (provenance) await requireLegacyTask(actor, id);
    return c.json(taskResponse(actor, await ready().reply(actor, id, key, input), id));
  });
}
