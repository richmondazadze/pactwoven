import type { Hono } from 'hono';
import { z } from 'zod';
import { IdSchema, IdempotencyKeySchema, type ActorContext } from '@pactwoven/contracts';
import { NativeWorkIntentPrepareSchema, NativeWorkIntentConfirmSchema, NativeWorkIntentPrepareResponseSchema,
  NativeWorkIntentRecoveryResponseSchema, NativeWorkIntentOperationSchema, NativeWorkIntentSessionObservationSchema,
  type NativeWorkIntentRepository, type NativeWorkIntentScope, type NativeWorkIntentReview,
  type NativeWorkIntentOperation } from '../../../packages/contracts/src/native-work-intent';
import { DomainError } from '@pactwoven/domain';
import type { ApiEnv } from './app.js';

const SiteQuery = z.strictObject({ siteId: IdSchema });
const EmptyQuery = z.strictObject({});
const unconfirmed = () => new DomainError('DURABLE_SERVICE_UNAVAILABLE', 503, 'This work request could not be confirmed. Recover the original request before replacing it.');
export function query(url: string) {
  const values = new URL(url).searchParams;
  if ([...values.keys()].some(key => values.getAll(key).length !== 1)) throw new DomainError('VALIDATION_FAILED', 422, 'Use each filter once.');
  return Object.fromEntries(values);
}
export function eligible(actor: ActorContext, siteId?: string, write = false) {
  if (actor.principalKind !== 'human' || (siteId !== undefined && !actor.siteIds.includes(siteId)) ||
    (write && (!actor.roles.some(role => role === 'owner' || role === 'operations') ||
      (siteId === undefined ? actor.actionSiteIds.length === 0 : !actor.actionSiteIds.includes(siteId))))) {
    throw new DomainError('FORBIDDEN', 403, 'Your current access does not permit this work request.');
  }
}
export function sameScope(actor: ActorContext, scope: NativeWorkIntentScope, siteId?: string) {
  if (scope.environment !== actor.environment || scope.organizationId !== actor.organizationId ||
    !actor.siteIds.includes(scope.siteId) || (siteId !== undefined && scope.siteId !== siteId)) throw unconfirmed();
}
export function checkReview(review: NativeWorkIntentReview) {
  const prepared = Date.parse(review.preparedAt), confirm = Date.parse(review.confirmBy), expires = Date.parse(review.expiresAt);
  if (confirm <= prepared || confirm > prepared + 300_000 || expires <= confirm || expires > prepared + 86_400_000 ||
    new Set(review.body.selectedNotes.map(note => note.noteId)).size !== review.body.selectedNotes.length) throw unconfirmed();
}
export function checkOperation(actor: ActorContext, operation: NativeWorkIntentOperation, scope: NativeWorkIntentScope, review?: NativeWorkIntentReview | null) {
  sameScope(actor, operation.scope, scope.siteId);
  if (Date.parse(operation.committedAt) >= Date.parse(operation.expiresAt) ||
    (review && (operation.reviewId !== review.id || operation.title !== review.body.title || operation.expiresAt !== review.expiresAt))) throw unconfirmed();
}

/** Only the server observer can supply issuance evidence. The database derives
 * the current authority and atomically binds exact human-reviewed context. */
export function registerNativeWorkIntentRoutes(app: Hono<ApiEnv>, repository?: NativeWorkIntentRepository) {
  const ready = () => {
    if (!repository) throw new DomainError('SETUP_REQUIRED', 503, 'Background advisory work is not connected yet.');
    return repository;
  };
  app.post('/v1/agent-work/prepare', async c => {
    EmptyQuery.parse(query(c.req.url));
    const input = NativeWorkIntentPrepareSchema.parse(c.get('requestBody'));
    const key = IdempotencyKeySchema.parse(c.req.header('Idempotency-Key')), actor = c.get('session').actor;
    eligible(actor, input.siteId, true);
    const parsed = NativeWorkIntentPrepareResponseSchema.safeParse(await ready().prepare(actor, key, input));
    if (!parsed.success) throw unconfirmed();
    const value = parsed.data; sameScope(actor, value.scope, input.siteId); checkReview(value.review);
    if (value.review.body.title !== input.title || value.review.body.prompt !== input.prompt ||
      value.review.body.selectedNotes.length !== input.selections.length ||
      value.review.body.selectedNotes.some(note => !input.selections.some(selected => selected.noteId === note.noteId))) throw unconfirmed();
    if (value.operation) checkOperation(actor, value.operation, value.scope, value.review);
    return c.json(value);
  });
  app.post('/v1/agent-work/confirm', async c => {
    EmptyQuery.parse(query(c.req.url));
    const input = NativeWorkIntentConfirmSchema.parse(c.get('requestBody'));
    const key = IdempotencyKeySchema.parse(c.req.header('Idempotency-Key')), actor = c.get('session').actor;
    eligible(actor, undefined, true);
    const verified = c.get('identityObservation');
    if (!verified || verified.identity.sessionId !== actor.sessionId || verified.identity.authenticatedAt !== actor.authenticatedAt) {
      throw new DomainError('IDENTITY_UNAVAILABLE', 503, 'Current sign-in verification is required before starting background work.');
    }
    const observation = NativeWorkIntentSessionObservationSchema.safeParse({ providerIssuer: verified.observation.issuer,
      sessionVerifiedAt: verified.observation.observedAt, sessionExpiresAt: verified.observation.expiresAt });
    const now = Date.now();
    if (!observation.success || Date.parse(observation.data.sessionVerifiedAt) > now ||
      Date.parse(observation.data.sessionVerifiedAt) < now - 20_000 || Date.parse(observation.data.sessionExpiresAt) <= now) {
      throw new DomainError('AUTH_REQUIRED', 401, 'Refresh your sign-in before confirming this review.');
    }
    const parsed = NativeWorkIntentOperationSchema.safeParse(await ready().confirm(actor, key, input, observation.data));
    if (!parsed.success || parsed.data.reviewId !== input.reviewId) throw unconfirmed();
    sameScope(actor, parsed.data.scope);
    if (!actor.actionSiteIds.includes(parsed.data.scope.siteId)) throw unconfirmed();
    checkOperation(actor, parsed.data, parsed.data.scope);
    return c.json(parsed.data);
  });
  app.get('/v1/agent-work/operations/:key', async c => {
    const input = SiteQuery.parse(query(c.req.url)), key = IdempotencyKeySchema.parse(c.req.param('key'));
    const actor = c.get('session').actor; eligible(actor, input.siteId);
    const parsed = NativeWorkIntentRecoveryResponseSchema.safeParse(await ready().recover(actor, input.siteId, key));
    if (!parsed.success) throw unconfirmed();
    const value = parsed.data; sameScope(actor, value.scope, input.siteId);
    if (value.review) checkReview(value.review);
    if (value.operation) checkOperation(actor, value.operation, value.scope, value.review);
    return c.json(value);
  });
}
