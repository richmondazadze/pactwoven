import { z } from 'zod';
import { AccessRecoveryQuerySchema, AccessRecoveryResultSchema, CloseAccessRecoveryIntentSchema, CloseAccessRecoveryResultSchema, EnvironmentSchema, HashSchema, IdSchema, InstantSchema, type AccessRecoveryResult, type CloseAccessRecoveryIntent, type CloseAccessRecoveryResult } from '@pactwoven/contracts';
import { canonicalJson, commandDigest } from '@pactwoven/contracts/canonical';
import { apiRequest, RequestError, type TokenSource } from './api';
import { getApiBase } from './config';
import { isAccessOwner } from './access-review';
import { AccessRecoverySchema, recoveryMatchesScope, type AccessRecovery, type AccessRecoveryScope } from './access-recovery';
import type { RetryContext } from './access-retry';

export const ACCESS_CLOSURE_OBSERVATION_MS = 60_000;
export const ACCESS_CLOSURE_FACTOR_MS = 240_000;
const epoch = z.number().int().nonnegative().max(2_147_483_647);
export const AccessClosureScopeSchema = z.strictObject({ userId: IdSchema, externalOrganizationId: IdSchema, sessionId: z.string().min(1).max(256), apiBase: z.string().url().max(2048), environment: EnvironmentSchema, organizationId: IdSchema, actorId: IdSchema, roles: z.array(z.string().min(1)).max(20), siteIds: z.array(IdSchema).max(10000), actionSiteIds: z.array(IdSchema).max(10000) });
export type AccessClosureScope = z.infer<typeof AccessClosureScopeSchema>;
export type AccessFencedResult = Extract<AccessRecoveryResult, { disposition: 'fenced' }>;
export type AccessClosureObservation = { result: AccessRecoveryResult; scope: AccessClosureScope; receivedAt: number; receivedMonotonic: number; sessionAuthorityEpoch: number };
const CloseReviewSchema = z.strictObject({ version: z.literal(1), locator: AccessRecoverySchema, scope: AccessClosureScopeSchema, intent: CloseAccessRecoveryIntentSchema, observedAt: InstantSchema, receivedAt: z.number().finite(), receivedMonotonic: z.number().finite().nonnegative(), sessionAuthorityEpoch: epoch, integrityHash: HashSchema });
export type AccessCloseReview = z.infer<typeof CloseReviewSchema>;
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function immutable<T>(value: T): T { if (value && typeof value === 'object') { for (const item of Object.values(value)) immutable(item); Object.freeze(value); } return value; }
function scopeDenied(): never { throw new RequestError('RECOVERY_SCOPE_CHANGED', 'Current owner authority or the original recovery scope changed.', 403); }
function unverified(): never { throw new RequestError('RECOVERY_RESPONSE_UNVERIFIED', 'The service response does not match this original request and current reviewer. No outcome has been assumed.'); }
export function accessClosureScope(context: RetryContext): AccessClosureScope {
  if (!isAccessOwner(context.session) || context.session.actor.organizationId !== context.session.organization.id || !context.auth.userId || !context.auth.orgId || !context.auth.sessionId || !context.apiBase) scopeDenied();
  const actor = context.session.actor;
  return AccessClosureScopeSchema.parse({ userId: context.auth.userId, externalOrganizationId: context.auth.orgId, sessionId: context.auth.sessionId, apiBase: context.apiBase, environment: actor.environment, organizationId: context.session.organization.id, actorId: actor.actorId, roles: [...actor.roles], siteIds: [...actor.siteIds], actionSiteIds: [...actor.actionSiteIds] });
}
export const closureLocatorScope = (scope: AccessClosureScope): AccessRecoveryScope => ({ userId: scope.userId, organizationId: scope.externalOrganizationId, apiBase: scope.apiBase, environment: scope.environment, internalOrganizationId: scope.organizationId, actorId: scope.actorId });
export function qualifyAccessRecoveryResult(input: unknown, locatorInput: AccessRecovery, scope: AccessClosureScope, closeIntent?: CloseAccessRecoveryIntent): AccessRecoveryResult {
  const locator = AccessRecoverySchema.parse(locatorInput), result = (closeIntent ? CloseAccessRecoveryResultSchema : AccessRecoveryResultSchema).parse(input);
  if (!recoveryMatchesScope(locator, closureLocatorScope(scope))) scopeDenied();
  if (result.environment !== scope.environment || result.organizationId !== scope.organizationId || result.externalOrganizationId !== scope.externalOrganizationId || result.reviewer.actorId !== scope.actorId || result.kind !== locator.kind || result.key !== locator.key) unverified();
  if (closeIntent && (result.environment !== closeIntent.expectedEnvironment || result.organizationId !== closeIntent.expectedOrganizationId || result.reviewer.actorId !== closeIntent.expectedActorId || result.reviewer.externalMembershipId !== closeIntent.expectedExternalMembershipId || result.kind !== closeIntent.kind)) unverified();
  // Existing records report current reviewer epoch. It need not equal the earlier close-review epoch.
  return result;
}
export function accessRecoveryPath(locator: AccessRecovery) { const query = AccessRecoveryQuerySchema.parse({ kind: locator.kind, key: locator.key }); return `/v1/member-access/recovery?kind=${query.kind}&key=${encodeURIComponent(query.key)}`; }
export const accessClosurePath = '/v1/member-access/recovery/close';
export function accessClosureTime(observation: Pick<AccessCloseReview, 'observedAt' | 'receivedAt' | 'receivedMonotonic'>, wall = Date.now(), monotonic = performance.now()) { return Math.max(wall, Date.parse(observation.observedAt) + Math.max(0, wall - observation.receivedAt, monotonic - observation.receivedMonotonic)); }
export function closureObservationCurrent(observedAt: string, now: number) { return Number.isFinite(now) && now >= Date.parse(observedAt) && now < Date.parse(observedAt) + ACCESS_CLOSURE_OBSERVATION_MS; }
export function closureVerificationCurrent(at: number | null, now = Date.now()) { return at !== null && now >= at && now - at < ACCESS_CLOSURE_FACTOR_MS; }
export type AccessClosureContext = { current: () => RetryContext; selected: () => AccessRecovery | null; hasOriginal: () => boolean; getToken: TokenSource; signal: AbortSignal };
function guard(scope: AccessClosureScope, locator: AccessRecovery, context: AccessClosureContext) {
  context.signal.throwIfAborted();
  if (getApiBase() !== scope.apiBase || !equal(accessClosureScope(context.current()), scope) || !equal(context.selected(), locator) || !recoveryMatchesScope(locator, closureLocatorScope(scope))) scopeDenied();
}
export async function checkAccessRecovery(locatorInput: AccessRecovery, context: AccessClosureContext): Promise<AccessClosureObservation> {
  const locator = AccessRecoverySchema.parse(locatorInput), scope = accessClosureScope(context.current()), sessionAuthorityEpoch = context.current().session.organization.authorityEpoch;
  guard(scope, locator, context);
  const getToken = async () => { guard(scope, locator, context); const token = await context.getToken(); guard(scope, locator, context); return token; };
  const input = await apiRequest(accessRecoveryPath(locator), AccessRecoveryResultSchema, getToken, { signal: context.signal });
  guard(scope, locator, context); const result = qualifyAccessRecoveryResult(input, locator, scope);
  return immutable({ result, scope, receivedAt: Date.now(), receivedMonotonic: performance.now(), sessionAuthorityEpoch });
}
export async function prepareAccessClosure(observation: AccessClosureObservation, locatorInput: AccessRecovery, current: RetryContext, hasOriginal: boolean): Promise<AccessCloseReview> {
  const scope = accessClosureScope(current), locator = AccessRecoverySchema.parse(locatorInput), result = qualifyAccessRecoveryResult(observation.result, locator, scope);
  if (hasOriginal) throw new RequestError('ORIGINAL_INPUT_AVAILABLE', 'The original input is still retained. Use its exact review and retry path.');
  if (!equal(observation.scope, scope) || current.session.organization.authorityEpoch !== observation.sessionAuthorityEpoch || result.disposition !== 'not_recorded' || !closureObservationCurrent(result.observedAt, accessClosureTime({ ...observation, observedAt: result.observedAt }))) throw new RequestError('RECOVERY_REVIEW_REQUIRED', 'Check the original result again before reviewing closure.');
  const intent = CloseAccessRecoveryIntentSchema.parse({ schemaVersion: 1, kind: locator.kind, reason: 'original_input_unavailable', expectedEnvironment: result.environment, expectedOrganizationId: result.organizationId, expectedActorId: result.reviewer.actorId, expectedExternalMembershipId: result.reviewer.externalMembershipId, expectedAuthorityEpoch: result.reviewer.authorityEpoch });
  const body = { version: 1 as const, locator, scope, intent, observedAt: result.observedAt, receivedAt: observation.receivedAt, receivedMonotonic: observation.receivedMonotonic, sessionAuthorityEpoch: observation.sessionAuthorityEpoch };
  return immutable(CloseReviewSchema.parse({ ...body, integrityHash: await commandDigest(body) }));
}
export async function verifyAccessCloseReview(input: AccessCloseReview) {
  const value = CloseReviewSchema.parse(input), { integrityHash, ...body } = value;
  if (!equal(value, input) || await commandDigest(body) !== integrityHash || !recoveryMatchesScope(value.locator, closureLocatorScope(value.scope)) || value.intent.kind !== value.locator.kind || value.intent.expectedEnvironment !== value.scope.environment || value.intent.expectedOrganizationId !== value.scope.organizationId || value.intent.expectedActorId !== value.scope.actorId) throw new RequestError('RECOVERY_REVIEW_CHANGED', 'The reviewed closure changed. Check the original result and review closure again.');
  return immutable(value);
}
export type AccessCloseFlow = { phase: 'check' | 'checked' | 'reviewed' | 'verified' | 'closing'; reviewedHash: string | null; verifiedAt: number | null };
export const initialAccessCloseFlow: AccessCloseFlow = { phase: 'check', reviewedHash: null, verifiedAt: null };
export type AccessCloseEvent = { type: 'checked' } | { type: 'review'; hash: string } | { type: 'verified'; at: number } | { type: 'close'; now: number } | { type: 'reset' } | { type: 'invalidate' };
export function accessCloseFlow(flow: AccessCloseFlow, event: AccessCloseEvent): AccessCloseFlow {
  if (event.type === 'reset') return initialAccessCloseFlow;
  if (event.type === 'checked') return { phase: 'checked', reviewedHash: null, verifiedAt: null };
  if (event.type === 'review' && flow.phase === 'checked') return { phase: 'reviewed', reviewedHash: event.hash, verifiedAt: null };
  if (event.type === 'verified' && flow.phase === 'reviewed') return { ...flow, phase: 'verified', verifiedAt: event.at };
  if (event.type === 'invalidate' && flow.phase === 'verified') return { ...flow, phase: 'reviewed', verifiedAt: null };
  if (event.type === 'close' && flow.phase === 'verified' && closureVerificationCurrent(flow.verifiedAt, event.now)) return { ...flow, phase: 'closing' };
  return flow;
}
export async function closeAccessRecovery(reviewInput: AccessCloseReview, permission: AccessCloseFlow, context: AccessClosureContext, onDispatch: () => undefined): Promise<CloseAccessRecoveryResult> {
  const review = await verifyAccessCloseReview(reviewInput);
  function allowed() {
    guard(review.scope, review.locator, context);
    if (context.hasOriginal()) throw new RequestError('ORIGINAL_INPUT_AVAILABLE', 'Original input became available. Administrative closure is no longer available.');
    if (context.current().session.organization.authorityEpoch !== review.sessionAuthorityEpoch || !closureObservationCurrent(review.observedAt, accessClosureTime(review)) || permission.phase !== 'closing' || permission.reviewedHash !== review.integrityHash) throw new RequestError('RECOVERY_REVIEW_REQUIRED', 'Check the current result and review closure again before sending.');
    if (!closureVerificationCurrent(permission.verifiedAt)) throw new RequestError('STEP_UP_REQUIRED', 'Verify both factors again before the separate close action.', 403);
  }
  allowed();
  const getToken = async () => { allowed(); const token = await context.getToken(); allowed(); if (!token) throw new RequestError('SESSION_REQUIRED', 'Sign in again before closing a request key.', 401); return token; };
  // Token resolution leaves one async handoff in apiRequest. Recheck action and storage
  // synchronously after that handoff, with no await between this preflight and fetch.
  const beforeDispatch = (): undefined => { allowed(); onDispatch(); return undefined; };
  const result = await apiRequest(accessClosurePath, CloseAccessRecoveryResultSchema, getToken, { body: review.intent, idempotencyKey: review.locator.key, signal: context.signal, beforeDispatch });
  // After dispatch, a recorded/fenced fact may have a newer current epoch. Do not re-run new-fence expiry/epoch checks here.
  guard(review.scope, review.locator, context);
  return qualifyAccessRecoveryResult(result, review.locator, review.scope, review.intent) as CloseAccessRecoveryResult;
}
