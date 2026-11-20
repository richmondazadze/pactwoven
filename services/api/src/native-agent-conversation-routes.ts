import type { Hono } from 'hono';
import { z } from 'zod';
import { IdSchema, IdempotencyKeySchema, type ActorContext } from '@pactwoven/contracts';
import { DomainError } from '@pactwoven/domain';
import { NativeWorkConversationSchema, NativeWorkInstructionUpdateSchema, NativeWorkInstructionReceiptSchema,
  NativeWorkInstructionRecoverySchema, type NativeWorkConversationRepository } from '../../../packages/contracts/src/native-work-conversation';
import type { ApiEnv } from './app';

const Query = z.strictObject({ siteId: IdSchema });
const unconfirmed = () => new DomainError('DURABLE_SERVICE_UNAVAILABLE', 503, 'This instruction update could not be confirmed. Check the saved conversation before trying again.');
function target(url: string) {
  const params = new URL(url).searchParams;
  if ([...params.keys()].some(key => params.getAll(key).length !== 1)) throw new DomainError('VALIDATION_FAILED', 422, 'Use each work selector once.');
  return Query.parse(Object.fromEntries(params));
}
function access(actor: ActorContext, siteId: string, write = false) {
  if (actor.principalKind !== 'human' || !actor.siteIds.includes(siteId) || write &&
    (!actor.actionSiteIds.includes(siteId) || !actor.roles.some(role => role === 'owner' || role === 'operations'))) {
    throw new DomainError('FORBIDDEN', 403, 'Your current access does not permit this instruction request.');
  }
}
function scope(actor: ActorContext, siteId: string, rootTaskId: string, value: {
  scope: { environment: string; organizationId: string; siteId: string }; rootTaskId: string;
}) {
  if (value.rootTaskId !== rootTaskId || value.scope.environment !== actor.environment ||
    value.scope.organizationId !== actor.organizationId || value.scope.siteId !== siteId) throw unconfirmed();
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value); if (!result.success) throw unconfirmed(); return result.data;
}

export function registerNativeAgentConversationRoutes(app: Hono<ApiEnv>, repository?: NativeWorkConversationRepository) {
  const ready = () => {
    if (!repository) throw new DomainError('SETUP_REQUIRED', 503, 'The saved conversation is not connected yet.');
    return repository;
  };
  app.get('/v1/agent-work/:id/conversation', async c => {
    const id = IdSchema.parse(c.req.param('id')), { siteId } = target(c.req.url), actor = c.get('session').actor;
    access(actor, siteId);
    const result = parse(NativeWorkConversationSchema, await ready().read(actor, id, siteId));
    scope(actor, siteId, id, result);
    // The database decides current task/grant state. Do not expose a write
    // affordance when the independently resolved session is read-only.
    if (result.canUpdate && (!actor.actionSiteIds.includes(siteId) || !actor.roles.some(role => role === 'owner' || role === 'operations'))) {
      return c.json({ ...result, canUpdate: false, updateUnavailableReason: 'authority_unavailable' as const });
    }
    return c.json(result);
  });
  app.post('/v1/agent-work/:id/instructions', async c => {
    const id = IdSchema.parse(c.req.param('id')), { siteId } = target(c.req.url), actor = c.get('session').actor;
    const input = NativeWorkInstructionUpdateSchema.parse(c.get('requestBody'));
    const key = IdempotencyKeySchema.parse(c.req.header('Idempotency-Key'));
    access(actor, siteId, true);
    // SQL binds root+site and checks current authority, both expected versions,
    // manual pause and the original request key in a single transaction.
    const receipt = parse(NativeWorkInstructionReceiptSchema, await ready().update(actor, id, siteId, key, input));
    scope(actor, siteId, id, receipt);
    if (receipt.requestKey !== key || receipt.instructionVersion !== input.expectedInstructionVersion + 1 ||
      receipt.controlVersion !== input.expectedControlVersion + 1 || receipt.entry.text !== input.text) throw unconfirmed();
    return c.json(receipt);
  });
  app.get('/v1/agent-work/:id/instructions/:key', async c => {
    const id = IdSchema.parse(c.req.param('id')), key = IdempotencyKeySchema.parse(c.req.param('key'));
    const { siteId } = target(c.req.url), actor = c.get('session').actor;
    access(actor, siteId);
    const result = parse(NativeWorkInstructionRecoverySchema, await ready().recover(actor, id, siteId, key));
    scope(actor, siteId, id, result);
    if (result.requestKey !== key) throw unconfirmed();
    return c.json(result);
  });
}
