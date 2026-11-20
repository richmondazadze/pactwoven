import { z } from 'zod';
import { IdSchema, MandateOperationResultSchema, type MandateOperationResult } from '@pactwoven/contracts';
import { canonicalJson } from '@pactwoven/contracts/canonical';
import { apiRequest, RequestError } from './api';
import { getApiBase } from './config';
import { MandateCapsuleScopeSchema, immutableMandate } from './mandate-capsule';
import { authorityAvailable, MandateAuthorityCapsuleSchema, qualifyAuthorityOperation, qualifyAuthorityReceipt, verifyAuthorityCapsule, type MandateAuthorityCapsule, type MandateAuthorityReceipt, type MandateAuthorityObservation } from './mandate-authority';
import { assertAuthorityRecovery, authorityWork, listAuthorityRecovery, locatorFromAuthorityCapsule, MandateAuthorityLocatorSchema, readAuthorityRecovery, removeAuthorityRecovery, storeAuthorityRecovery, type MandateAuthorityLocator } from './mandate-authority-recovery';
import { mandateOperationSucceeded, verificationCurrent } from './mandate-actions';
import { mandateRecoveryScope } from './mandate-recovery';
import { mandateWorkAllowed, type MandateGrantPreparation, type MandateWorkCoordinator, type MandateWorkRequest, type MandateWorkTicket } from './mandate-work-coordination';
import type { RecoveryStorage } from './bootstrap-recovery';
import type { MandateTransportContext } from './mandate-retry';
import type { MandateReadScope } from './mandates';

const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
// Private UI observation only. Genuine purpose-bound evidence is built by the
// service from the signed provider token when this exact intent is submitted.
const localVerificationSchema = z.strictObject({ integrityHash: z.string().regex(/^[a-f0-9]{64}$/), generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), verifiedAt: z.number().finite() });
export type AuthorityLocalVerification = z.infer<typeof localVerificationSchema>;
export type AuthorityRetryFlow = { phase: 'check' | 'checked' | 'reviewed' | 'verified' | 'retrying'; reviewedHash: string | null; verification?: AuthorityLocalVerification };
export const initialAuthorityRetry: AuthorityRetryFlow = Object.freeze({ phase: 'check', reviewedHash: null });
export type AuthorityRetryEvent = { type: 'checked' | 'reset' | 'invalidate' } | { type: 'retry'; action?: 'PAUSE' | 'REVOKE' | 'RESUME'; now?: number } | { type: 'review'; hash: string } | { type: 'verified'; verification: AuthorityLocalVerification };
export function authorityRetryFlow(flow: AuthorityRetryFlow, event: AuthorityRetryEvent): AuthorityRetryFlow {
  if (event.type === 'reset') return initialAuthorityRetry;
  if (event.type === 'checked') return { phase: 'checked', reviewedHash: null };
  if (event.type === 'review' && flow.phase === 'checked') return { phase: 'reviewed', reviewedHash: event.hash };
  if (event.type === 'invalidate' && flow.verification) return { phase: 'reviewed', reviewedHash: flow.reviewedHash };
  if (event.type === 'verified' && flow.phase === 'reviewed') {
    const parsed = localVerificationSchema.safeParse(event.verification);
    if (parsed.success && parsed.data.integrityHash === flow.reviewedHash) return { ...flow, phase: 'verified', verification: immutableMandate(parsed.data) };
  }
  if (event.type === 'retry') {
    if (event.action === 'RESUME') {
      if (flow.phase === 'verified' && flow.verification && event.now !== undefined && verificationCurrent(flow.verification.verifiedAt, event.now)) return { ...flow, phase: 'retrying' };
    } else if (flow.phase === 'reviewed') return { ...flow, phase: 'retrying' };
  }
  return flow;
}
export type AuthorityTransportContext = MandateTransportContext & {
  storage: () => RecoveryStorage | null; work: MandateWorkCoordinator;
  selected: () => { integrityHash: string } | null;
  recorded: (locator: MandateAuthorityLocator) => MandateOperationResult | null;
  onRecorded: (locator: MandateAuthorityLocator, result: MandateOperationResult) => void;
  onPending?: (locator: MandateAuthorityLocator) => void;
  onQualified?: (receipt: MandateAuthorityReceipt) => void;
};
export type AuthorityResumeVerificationContext = { currentGeneration: () => number; currentVerification: () => AuthorityLocalVerification | null };
export type AuthoritySendPermission =
  | { kind: 'first'; now: () => number; resume?: AuthorityResumeVerificationContext & { preparation: MandateGrantPreparation; currentObservation: () => MandateAuthorityObservation | null } }
  | { kind: 'retry'; currentFlow: () => AuthorityRetryFlow; resume?: AuthorityResumeVerificationContext };
function guard(scope: MandateReadScope, context: MandateTransportContext): undefined {
  context.signal.throwIfAborted(); if (getApiBase() !== scope.apiBase || !same(scope, context.current())) throw new RequestError('MANDATE_SCOPE_CHANGED', 'The current authenticated authority-control scope changed.', 403); return undefined;
}
function guardLocator(scope: MandateReadScope, locator: MandateAuthorityLocator) { if (!same(locator.scope, mandateRecoveryScope(scope)) || locator.responsibilityId !== scope.responsibilityId) throw new RequestError('MANDATE_SCOPE_CHANGED', 'This original authority request belongs to a different scope.', 403); }
function token(scope: MandateReadScope, context: MandateTransportContext) { return async () => { guard(scope, context); const value = await context.getToken(); guard(scope, context); return value; }; }
export const authorityPath = (responsibilityId: string, mandateId: string) => `/v1/responsibilities/${IdSchema.parse(responsibilityId)}/mandates/${IdSchema.parse(mandateId)}/authority`;
function localWork(request: MandateWorkRequest, context: AuthorityTransportContext, ignoreOriginal: boolean) {
  const inventory = listAuthorityRecovery(context.storage(), request.scope);
  const originalKind = request.kind === 'PAUSE' ? 'mandate.pause' : request.kind === 'REVOKE' ? 'mandate.revoke' : request.kind === 'RESUME' ? 'mandate.resume' : null;
  if (!originalKind) throw new RequestError('AUTHORITY_REVIEW_REQUIRED', 'An exact authority-control kind is required.');
  const records = inventory.locators.filter(value => !ignoreOriginal || value.kind !== originalKind || value.key !== request.key).map(authorityWork);
  if ((inventory.blocked && request.action === 'send') || !mandateWorkAllowed(request, { blocked: inventory.blocked, records })) throw new RequestError('AUTHORITY_RECOVERY_CHANGED', 'An original authority request or unreadable local reference needs checking.');
}
export async function sendMandateAuthority(input: MandateAuthorityCapsule, context: AuthorityTransportContext, permissionInput: AuthoritySendPermission) {
  const snapshot = immutableMandate(MandateAuthorityCapsuleSchema.parse(structuredClone(input))), scope = snapshot.scope, locator = locatorFromAuthorityCapsule(snapshot), permission = { ...permissionInput, ...(permissionInput.resume ? { resume: { ...permissionInput.resume } } : {}) } as AuthoritySendPermission;
  const initialVerification = snapshot.intent.action === 'RESUME' ? localVerificationSchema.safeParse(permission.resume?.currentVerification()) : null;
  const verification = initialVerification?.success ? immutableMandate(initialVerification.data) : null;
  let persisted = permission.kind === 'retry';
  function preflight(): undefined {
    guard(scope, context);
    if (!same(input, snapshot) || !same(context.selected(), { integrityHash: snapshot.integrityHash })) throw new RequestError('AUTHORITY_REVIEW_REQUIRED', 'The selected original authority review changed.');
    if (context.recorded(locator)) throw new RequestError('AUTHORITY_ALREADY_RECORDED', 'Finish the recorded receipt. Do not send this original control again.');
    if (snapshot.intent.action === 'RESUME') {
      const resume = permission.resume;
      if (!resume || !verification || verification.integrityHash !== snapshot.integrityHash || resume.currentGeneration() !== verification.generation || !same(resume.currentVerification(), verification) || !verificationCurrent(verification.verifiedAt, Date.now())) throw new RequestError('STEP_UP_REQUIRED', 'Verify both factors for this exact resume review before its separate send.', 403);
      if (permission.kind === 'first') {
        const grant = permission.resume?.preparation, observation = permission.resume?.currentObservation();
        if (!grant || !context.work.preparationCurrent(grant) || grant.kind !== 'RESUME' || grant.integrityHash !== snapshot.integrityHash || !same(grant.scope, locator.scope) || grant.responsibilityId !== locator.responsibilityId || grant.targetId !== locator.mandate.id || grant.key !== locator.key || !observation || !same(observation, snapshot.observation)) throw new RequestError('AUTHORITY_REVIEW_REQUIRED', 'The current accepted resume review or its unsent preparation changed.');
      } else if (!same(permission.currentFlow().verification ?? null, verification)) throw new RequestError('STEP_UP_REQUIRED', 'Verify the retained exact original resume before retrying it.', 403);
    }
    if (permission.kind === 'first') {
      if (!authorityAvailable(snapshot.observation.data, scope, snapshot.intent.action, permission.now())) throw new RequestError('AUTHORITY_REVIEW_REQUIRED', 'Refresh and separately review the current accepted authority before a new control.');
      if (!persisted && readAuthorityRecovery(context.storage(), locator).state !== 'empty') throw new RequestError('AUTHORITY_RECOVERY_CHANGED', 'Preserve the original request reference before continuing.');
    } else {
      const flow = permission.currentFlow(); if (flow.phase !== 'retrying' || flow.reviewedHash !== snapshot.integrityHash) throw new RequestError('AUTHORITY_REVIEW_REQUIRED', 'Check the original result, review its retained exact input, then choose a separate same-key retry.');
    }
    if (persisted) assertAuthorityRecovery(context.storage(), locator);
    return undefined;
  }
  preflight();
  const request: MandateWorkRequest = { ...authorityWork(locator), action: permission.kind === 'first' ? 'send' : 'retry', hasHead: true, eligible: true };
  localWork(request, context, false);
  // Stop acquisition invalidates unsent grants. Verify the complete immutable
  // capsule first, then recheck current state before making that ownership change.
  const capsule = await verifyAuthorityCapsule(snapshot);
  preflight(); localWork(request, context, false); const ticket = context.work.acquire(request);
  function allowed(): undefined { preflight(); context.work.assert(ticket); localWork(request, context, permission.kind === 'first' && persisted); return undefined; }
  try {
    if (snapshot.intent.action === 'RESUME' && permission.kind === 'first') context.work.bindPreparation(permission.resume!.preparation, ticket);
    allowed();
    const getToken = async () => { allowed(); const value = await context.getToken(); allowed(); return value; };
    const result = await apiRequest(authorityPath(scope.responsibilityId, capsule.intent.mandate.id), MandateOperationResultSchema, getToken, {
      body: capsule.intent, idempotencyKey: capsule.key, signal: context.signal,
      beforeDispatch: () => {
        allowed(); if (permission.kind === 'first') { storeAuthorityRecovery(context.storage(), locator); persisted = true; } else assertAuthorityRecovery(context.storage(), locator);
        context.onPending?.(locator); allowed(); context.work.markDispatched(ticket); return undefined;
      },
    });
    guard(scope, context); context.work.assert(ticket); assertAuthorityRecovery(context.storage(), locator);
    const qualified = qualifyAuthorityOperation(result, locator); if (mandateOperationSucceeded(qualified)) context.onRecorded(locator, qualified); return qualified;
  } finally { context.work.release(ticket); }
}
function readOwnership(locator: MandateAuthorityLocator, scope: MandateReadScope, context: AuthorityTransportContext) {
  guard(scope, context); guardLocator(scope, locator); assertAuthorityRecovery(context.storage(), locator); return context.work.acquire({ ...authorityWork(locator), action: 'check' });
}
function readGuard(locator: MandateAuthorityLocator, scope: MandateReadScope, context: AuthorityTransportContext, ticket: MandateWorkTicket): undefined { guard(scope, context); context.work.assert(ticket); assertAuthorityRecovery(context.storage(), locator); return undefined; }
export async function lookupMandateAuthority(input: MandateAuthorityLocator, scopeInput: MandateReadScope, context: AuthorityTransportContext) {
  const locator = immutableMandate(MandateAuthorityLocatorSchema.parse(input)), scope = immutableMandate(MandateCapsuleScopeSchema.parse(scopeInput)), ticket = readOwnership(locator, scope, context);
  try {
    const result = await apiRequest(`/v1/mandate-operations?kind=${locator.kind}&key=${encodeURIComponent(locator.key)}`, MandateOperationResultSchema, token(scope, context), { signal: context.signal, beforeDispatch: () => readGuard(locator, scope, context, ticket) });
    readGuard(locator, scope, context, ticket); const qualified = qualifyAuthorityOperation(result, locator); if (mandateOperationSucceeded(qualified)) context.onRecorded(locator, qualified); return qualified;
  } finally { context.work.release(ticket); }
}
// Historical receipt settlement only; current authority must be read separately.
export async function settleMandateAuthorityReceipt(input: MandateAuthorityLocator, resultInput: MandateOperationResult, scopeInput: MandateReadScope, context: AuthorityTransportContext, originalInput: MandateAuthorityCapsule | null = null) {
  const locator = immutableMandate(MandateAuthorityLocatorSchema.parse(input)), scope = immutableMandate(MandateCapsuleScopeSchema.parse(scopeInput)), receipt = qualifyAuthorityReceipt(resultInput, locator), original = originalInput ? immutableMandate(structuredClone(originalInput)) : null, ticket = readOwnership(locator, scope, context);
  try {
    if (original) { await verifyAuthorityCapsule(original); readGuard(locator, scope, context, ticket); if (!same(locatorFromAuthorityCapsule(original), locator)) throw new RequestError('AUTHORITY_REVIEW_REQUIRED', 'The retained authority input differs from this original request reference.'); }
    readGuard(locator, scope, context, ticket); context.onRecorded(locator, receipt.result); readGuard(locator, scope, context, ticket); context.onQualified?.(receipt); readGuard(locator, scope, context, ticket);
    if (!removeAuthorityRecovery(context.storage(), locator)) throw new RequestError('AUTHORITY_STORAGE_UNAVAILABLE', 'The original recorded receipt is verified, but its local reference could not be settled. Keep the original and check it again.');
    return receipt;
  } finally { context.work.release(ticket); }
}
