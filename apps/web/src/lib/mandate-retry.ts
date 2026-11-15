import { MandateOperationResultSchema, MandateReviewSchema, type MandateOperationResult } from '@pactwoven/contracts';
import { apiRequest, RequestError, type TokenSource } from './api';
import { getApiBase } from './config';
import { decisionAvailable, decisionPath, mandateOperationSucceeded, qualifyMandateDecisionReceipt, qualifyMandateOperation, sameMandateValue, verificationCurrent } from './mandate-actions';
import { immutableMandate, verifyMandateCapsule, type MandateCapsule } from './mandate-capsule';
import { locatorFromCapsule, matchesMandateRecoveryScope, type MandateRecovery } from './mandate-recovery';
import { mandateReviewPath, type MandateReadScope } from './mandates';
import type { MandateWorkCoordinator, MandateWorkTicket } from './mandate-work-coordination';

export type MandateTransportContext = { current: () => MandateReadScope | null; getToken: TokenSource; signal: AbortSignal };
function guard(scope: MandateReadScope, context: MandateTransportContext) { context.signal.throwIfAborted(); if (getApiBase() !== scope.apiBase || !sameMandateValue(scope, context.current())) throw new RequestError('MANDATE_SCOPE_CHANGED', 'The authenticated mandate scope changed.', 403); }
function token(scope: MandateReadScope, context: MandateTransportContext) { return async () => { guard(scope, context); const value = await context.getToken(); guard(scope, context); return value; }; }
export function mandateFailureKind(error: unknown) { return error instanceof RequestError && error.status === 403 && error.code === 'STEP_UP_REQUIRED' ? 'verification-expired' : error instanceof RequestError && [401, 403].includes(error.status) ? 'scope-denied' : 'unconfirmed'; }
export async function lookupMandateDecision(locator: MandateRecovery, scope: MandateReadScope, context: MandateTransportContext) {
  guard(scope, context);
  if (!matchesMandateRecoveryScope(locator, scope) || scope.responsibilityId !== locator.responsibilityId) throw new RequestError('MANDATE_SCOPE_CHANGED', 'The original reference belongs to a different scope.', 403);
  const result = await apiRequest(`/v1/mandate-operations?kind=${locator.kind}&key=${encodeURIComponent(locator.key)}`, MandateOperationResultSchema, token(scope, context), { signal: context.signal });
  guard(scope, context); return qualifyMandateOperation(result, locator);
}
export async function readMandateDecisionReceipt(locator: MandateRecovery, result: MandateOperationResult, scope: MandateReadScope, context: MandateTransportContext, capsule: MandateCapsule | null = null) {
  guard(scope, context);
  if (!matchesMandateRecoveryScope(locator, scope) || scope.responsibilityId !== locator.responsibilityId) throw new RequestError('MANDATE_SCOPE_CHANGED', 'The original reference belongs to a different scope.', 403);
  const record = await apiRequest(mandateReviewPath(locator.responsibilityId, locator.proposal.id, locator.proposal.version), MandateReviewSchema, token(scope, context), { signal: context.signal });
  guard(scope, context); const review = await qualifyMandateDecisionReceipt(record, scope, locator, result, capsule?.intent); guard(scope, context); return review;
}
export type MandateRetryFlow = { phase: 'check' | 'checked' | 'reviewed' | 'verified' | 'retrying'; reviewedHash: string | null; verifiedAt: number | null };
export const initialMandateRetry: MandateRetryFlow = { phase: 'check', reviewedHash: null, verifiedAt: null };
export type MandateRetryEvent = { type: 'checked' } | { type: 'review'; hash: string } | { type: 'verified'; at: number } | { type: 'retry'; action: MandateCapsule['intent']['action']; now: number } | { type: 'reset' } | { type: 'invalidate' };
export function mandateRetryFlow(flow: MandateRetryFlow, event: MandateRetryEvent): MandateRetryFlow {
  if (event.type === 'reset') return initialMandateRetry;
  if (event.type === 'checked') return { phase: 'checked', reviewedHash: null, verifiedAt: null };
  if (event.type === 'review' && flow.phase === 'checked') return { phase: 'reviewed', reviewedHash: event.hash, verifiedAt: null };
  if (event.type === 'verified' && flow.phase === 'reviewed') return { ...flow, phase: 'verified', verifiedAt: event.at };
  if (event.type === 'invalidate' && flow.phase === 'verified') return { ...flow, phase: 'reviewed', verifiedAt: null };
  if (event.type === 'retry' && ((event.action === 'REJECT' && flow.phase === 'reviewed') || (event.action === 'AUTHORIZE' && flow.phase === 'verified' && verificationCurrent(flow.verifiedAt, event.now)))) return { ...flow, phase: 'retrying' };
  return flow;
}
export type MandateDispatchOwnership = { work: Pick<MandateWorkCoordinator, 'assert' | 'markDispatched'>; ticket: MandateWorkTicket };
export async function sendMandateDecision(capsule: MandateCapsule, context: MandateTransportContext, permission: { kind: 'first'; verifiedAt: number | null; now: () => number } | { kind: 'retry'; flow: MandateRetryFlow; now: () => number }, onDispatch: () => void, ownership?: MandateDispatchOwnership) {
  const snapshot = immutableMandate(structuredClone(capsule)), scope = snapshot.scope;
  function allowed() {
    guard(scope, context);
    ownership?.work.assert(ownership.ticket);
    if (!sameMandateValue(capsule, snapshot)) throw new RequestError('MANDATE_REVIEW_REQUIRED', 'The exact original decision changed. No replacement input will be sent.');
    if (permission.kind === 'first') {
      if (!decisionAvailable(snapshot.originalReview, scope, snapshot.intent.action, permission.now())) throw new RequestError('MANDATE_REVIEW_REQUIRED', 'The original review is no longer current. Refresh and review before sending.');
    } else if (permission.flow.phase !== 'retrying' || permission.flow.reviewedHash !== snapshot.integrityHash) throw new RequestError('MANDATE_REVIEW_REQUIRED', 'Check the original result and review the exact original input first.');
    const verifiedAt = permission.kind === 'first' ? permission.verifiedAt : permission.flow.verifiedAt;
    if (snapshot.intent.action === 'AUTHORIZE' && !verificationCurrent(verifiedAt, Date.now())) throw new RequestError('STEP_UP_REQUIRED', 'Verify both factors again before this separate action.', 403);
  }
  allowed(); const original = await verifyMandateCapsule(snapshot, scope); allowed();
  const getToken = async () => { allowed(); const value = await context.getToken(); allowed(); if (!value) throw new RequestError('SESSION_REQUIRED', 'Sign in again before deciding this proposal.', 401); return value; };
  const result = await apiRequest(decisionPath(scope.responsibilityId, original.intent.proposal.id), MandateOperationResultSchema, getToken, {
    body: original.intent, idempotencyKey: original.key, signal: context.signal,
    beforeDispatch: () => {
      allowed(); onDispatch();
      // Storage effects may synchronously change scope, permission or ownership. No await
      // remains after these checks and the dispatch mark; existing locators are never erased.
      allowed(); ownership?.work.markDispatched(ownership.ticket); return undefined;
    },
  });
  guard(scope, context); return qualifyMandateOperation(result, locatorFromCapsule(original));
}
export { mandateOperationSucceeded };
