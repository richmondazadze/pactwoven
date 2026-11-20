import { z } from 'zod';
import { IdSchema, IdempotencyKeySchema, InstantSchema } from '@pactwoven/contracts';
import { PaidToolIntentPolicySchema, PaidToolIntentOptionsSchema, PaidToolIntentPrepareResponseSchema, PaidToolIntentConfirmResponseSchema, PaidToolIntentRecoveryResponseSchema } from '../../../../packages/contracts/src/native-paid-work-intent';
import { NativeWorkIntentPrepareSchema, NativeWorkIntentConfirmSchema, type NativeWorkIntentPrepare, type NativeWorkIntentReview } from '../../../../packages/contracts/src/native-work-intent';
import { RequestError, requestApiAtBase, type ApiRequestOptions, type TokenSource } from './api';
import { getNativeApiBase } from './config';
import { preparedWorkSchema, recoveredWorkSchema, workOperationSchema, type AgentWorkIntentAttempt, type AgentWorkScope, type AgentWorkStorage } from './native-agent-work';

export type PaidWorkPolicy = z.infer<typeof PaidToolIntentPolicySchema>;
const Scope = z.strictObject({ apiBase: z.string().min(1).max(2048), environment: z.enum(['simulation','development','staging','production']), organizationId: IdSchema, actorId: IdSchema, sessionId: z.string().min(1).max(256), siteId: IdSchema });
const Hash = z.string().regex(/^[0-9a-f]{64}$/);
const Prepared = z.strictObject({ reviewId: IdSchema, reviewToken: Hash, policyReviewHash: Hash, confirmBy: InstantSchema, expiresAt: InstantSchema });
const Attempt = z.strictObject({ kind: z.literal('paid-intent'), scope: Scope, key: IdempotencyKeySchema, input: NativeWorkIntentPrepareSchema,
  paidPolicy: PaidToolIntentPolicySchema, prepared: Prepared.nullable(), confirmation: NativeWorkIntentConfirmSchema.nullable(), reviewExpiresAt: InstantSchema.nullable() }).refine(value =>
  value.input.siteId === value.scope.siteId && (value.confirmation === null) === (value.reviewExpiresAt === null) && (!value.confirmation || value.prepared !== null &&
    value.confirmation.reviewId === value.prepared.reviewId && value.confirmation.reviewToken === value.prepared.reviewToken && value.reviewExpiresAt === value.prepared.expiresAt));
export type PaidWorkIntentAttempt = z.infer<typeof Attempt>;
export const samePaidWorkPolicy = (a: PaidWorkPolicy, b: PaidWorkPolicy) => a.serviceId === b.serviceId && a.authorization === b.authorization && a.maximumComputationBaseUnits === b.maximumComputationBaseUnits && a.maximumFeeLamports === b.maximumFeeLamports;
const sameScope = (a: AgentWorkScope, b: AgentWorkScope) => Object.keys(a).every(k => a[k as keyof AgentWorkScope] === b[k as keyof AgentWorkScope]);
const ordinary = (a: PaidWorkIntentAttempt): AgentWorkIntentAttempt => ({ kind: 'intent', scope: a.scope, key: a.key, input: a.input, confirmation: a.confirmation, reviewExpiresAt: a.reviewExpiresAt });
const policyMatches = (a: PaidWorkIntentAttempt, policy: PaidWorkPolicy & { policyReviewHash: string }) => samePaidWorkPolicy(a.paidPolicy, policy) && (!a.prepared || a.prepared.policyReviewHash === policy.policyReviewHash);
export const paidWorkOptionsSchema = PaidToolIntentOptionsSchema;
export const paidWorkPreparedSchema = (a: PaidWorkIntentAttempt) => PaidToolIntentPrepareResponseSchema.refine(value => preparedWorkSchema(ordinary(a)).safeParse(value.work).success && policyMatches(a,value.paidPolicy) &&
  (!a.prepared || value.work.review.id === a.prepared.reviewId && value.work.review.token === a.prepared.reviewToken && value.work.review.confirmBy === a.prepared.confirmBy && value.work.review.expiresAt === a.prepared.expiresAt));
export const paidWorkConfirmedSchema = (a: PaidWorkIntentAttempt) => PaidToolIntentConfirmResponseSchema.refine(value => Boolean(a.confirmation) && workOperationSchema(ordinary(a)).safeParse(value.work).success && policyMatches(a,value.paidPolicy));
export const paidWorkRecoveredSchema = (a: PaidWorkIntentAttempt) => PaidToolIntentRecoveryResponseSchema.refine(value => recoveredWorkSchema(ordinary(a)).safeParse(value.work).success &&
  (value.paidPolicy !== null ? policyMatches(a,value.paidPolicy) : !value.work.review && !value.work.operation) && (!a.prepared || !value.work.review || value.work.review.id === a.prepared.reviewId && value.work.review.token === a.prepared.reviewToken && value.work.review.confirmBy === a.prepared.confirmBy && value.work.review.expiresAt === a.prepared.expiresAt));

export async function paidWorkIntentRequest<T>(path: string, schema: z.ZodType<T>, scope: AgentWorkScope, getToken: TokenSource, current: () => AgentWorkScope, options: ApiRequestOptions = {}) {
  const read = path === '/v1/agent-work/paid/options' || /^\/v1\/agent-work\/paid\/operations\/[A-Za-z0-9_-]{16,128}\?siteId=[A-Za-z0-9_-]{1,128}$/.test(path);
  const write = ['/v1/agent-work/paid/prepare','/v1/agent-work/paid/confirm'].includes(path);
  if (!(options.body === undefined ? read : write)) throw new RequestError('INVALID_PATH','This equipment planning request is not supported.');
  const check = () => { if (getNativeApiBase() !== scope.apiBase || !sameScope(scope,current())) throw new RequestError('SCOPE_CHANGED','Your workspace changed.'); };
  check(); const result = await requestApiAtBase(scope.apiBase,path,schema,async () => { check(); return getToken(); },{ ...options,beforeDispatch: () => { check(); options.beforeDispatch?.(); } });
  options.signal?.throwIfAborted(); check(); return result;
}
const prefix = 'pactwoven:paid-work-intent:v1:';
const storageKey = (scope: AgentWorkScope) => prefix + encodeURIComponent(JSON.stringify(Scope.parse(scope)));
export function readPaidWorkIntent(storage: AgentWorkStorage, scope: AgentWorkScope): PaidWorkIntentAttempt | null {
  try { const raw = storage.getItem(storageKey(scope)); if (raw === null) return null; if (raw.length > 100000) throw Error(); const attempt = Attempt.parse(JSON.parse(raw)); if (!sameScope(scope,attempt.scope)) throw Error(); return attempt; }
  catch { throw new RequestError('LOCAL_RECOVERY_INVALID','The original equipment planning request needs recovery.'); }
}
export function previousPaidWorkConnection(storage: AgentWorkStorage, scope: AgentWorkScope) {
  try { if (!Number.isSafeInteger(storage.length) || storage.length > 10000) throw Error(); for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i); if (!key?.startsWith(prefix)) continue; const prior = Scope.parse(JSON.parse(decodeURIComponent(key.slice(prefix.length))));
    if (prior.apiBase !== scope.apiBase && prior.environment === scope.environment && prior.organizationId === scope.organizationId && prior.actorId === scope.actorId && prior.sessionId === scope.sessionId && prior.siteId === scope.siteId && readPaidWorkIntent(storage,prior)) return true;
  } return false; } catch { throw new RequestError('LOCAL_RECOVERY_INVALID','The original equipment planning connection needs checking.'); }
}
export function storePaidWorkIntent(storage: AgentWorkStorage, input: PaidWorkIntentAttempt) {
  const value = Attempt.parse(input); if (previousPaidWorkConnection(storage,value.scope)) throw new RequestError('PREVIOUS_CONNECTION_PENDING','Recover the original service connection.');
  const prior = readPaidWorkIntent(storage,value.scope), raw = JSON.stringify(value);
  if (prior) {
    const sameBase = JSON.stringify({ ...prior,prepared:null,confirmation:null,reviewExpiresAt:null }) === JSON.stringify({ ...value,prepared:null,confirmation:null,reviewExpiresAt:null });
    const progression = sameBase && (!prior.prepared || JSON.stringify(prior.prepared) === JSON.stringify(value.prepared)) && (!prior.confirmation || JSON.stringify(prior.confirmation) === JSON.stringify(value.confirmation) && prior.reviewExpiresAt === value.reviewExpiresAt);
    if (!progression) throw new RequestError('LOCAL_RECOVERY_INVALID','Keep the original equipment planning request.');
  }
  try { storage.setItem(storageKey(value.scope),raw); if (storage.getItem(storageKey(value.scope)) !== raw) throw Error(); }
  catch { throw new RequestError('LOCAL_RECOVERY_UNAVAILABLE','This tab cannot retain the original request.'); }
}
export function clearPaidWorkIntent(storage: AgentWorkStorage, attempt: PaidWorkIntentAttempt) {
  const prior = readPaidWorkIntent(storage,attempt.scope); if (prior && JSON.stringify(prior) !== JSON.stringify(attempt)) throw new RequestError('LOCAL_RECOVERY_INVALID','Another original request needs checking.');
  try { const key = storageKey(attempt.scope); storage.removeItem(key); if (storage.getItem(key) !== null) throw Error(); } catch { throw new RequestError('LOCAL_RECOVERY_UNAVAILABLE','The original request could not be cleared.'); }
}
export const createPaidWorkIntent = (scope: AgentWorkScope, input: NativeWorkIntentPrepare, paidPolicy: PaidWorkPolicy): PaidWorkIntentAttempt => Attempt.parse({ kind:'paid-intent',scope,key:crypto.randomUUID(),input,paidPolicy,prepared:null,confirmation:null,reviewExpiresAt:null });
export function retainPaidWorkReview(a: PaidWorkIntentAttempt, review: NativeWorkIntentReview, policy: PaidWorkPolicy & { policyReviewHash: string }) {
  if (!policyMatches(a,policy) || review.body.title !== a.input.title || review.body.prompt !== a.input.prompt || JSON.stringify(review.body.selectedNotes.map(n=>n.noteId)) !== JSON.stringify(a.input.selections.map(n=>n.noteId))) throw new RequestError('RESPONSE_UNVERIFIED','The original review could not be matched.');
  return Attempt.parse({ ...a,prepared:{reviewId:review.id,reviewToken:review.token,policyReviewHash:policy.policyReviewHash,confirmBy:review.confirmBy,expiresAt:review.expiresAt} });
}
export function confirmPaidWorkIntent(a: PaidWorkIntentAttempt, review: NativeWorkIntentReview) {
  if (!a.prepared || a.prepared.reviewId !== review.id || a.prepared.reviewToken !== review.token || a.prepared.confirmBy !== review.confirmBy || a.prepared.expiresAt !== review.expiresAt) throw new RequestError('REVIEW_CHANGED','Review the exact equipment planning request again.');
  return Attempt.parse({ ...a,confirmation:{reviewId:review.id,reviewToken:review.token,continuesAfterSignOut:true},reviewExpiresAt:review.expiresAt });
}
export function sendPaidWorkIntent(a: PaidWorkIntentAttempt, getToken: TokenSource, current: () => AgentWorkScope, options: ApiRequestOptions = {}) {
  Attempt.parse(a);
  if (a.confirmation) return paidWorkIntentRequest('/v1/agent-work/paid/confirm',paidWorkConfirmedSchema(a),a.scope,getToken,current,{...options,body:{work:a.confirmation,policyReviewHash:a.prepared!.policyReviewHash},idempotencyKey:a.key});
  return paidWorkIntentRequest('/v1/agent-work/paid/prepare',paidWorkPreparedSchema(a),a.scope,getToken,current,{...options,body:{work:a.input,paidPolicy:a.paidPolicy},idempotencyKey:a.key});
}
export const recoverPaidWorkIntent = (a: PaidWorkIntentAttempt, getToken: TokenSource, current: () => AgentWorkScope, signal: AbortSignal) =>
  paidWorkIntentRequest(`/v1/agent-work/paid/operations/${a.key}?siteId=${encodeURIComponent(a.scope.siteId)}`,paidWorkRecoveredSchema(a),a.scope,getToken,current,{signal});
