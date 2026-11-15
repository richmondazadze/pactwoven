import { IdSchema, MandateOperationResultSchema, MandateReviewSchema, type MandateOperationResult } from '@pactwoven/contracts';
import { canonicalJson } from '@pactwoven/contracts/canonical';
import { apiRequest, RequestError } from './api';
import { getApiBase } from './config';
import { immutableMandate, MandateCapsuleScopeSchema } from './mandate-capsule';
import { mandateOperationSucceeded } from './mandate-actions';
import { authoringAvailable, qualifyAuthoringOperation, qualifyAuthoringProposal, selectionFromDocument, verifyAuthoringCapsule, type MandateAuthoringCapsule } from './mandate-authoring';
import { assertAuthoringAttempt, AuthoringLocatorSchema, beginAuthoringAttempt, checkpointAuthoringAttempt, locatorFromAuthoringCapsule, type AuthoringLocator } from './mandate-authoring-recovery';
import { readMandateDocument } from './mandate-document-reads';
import { mandateRecoveryScope } from './mandate-recovery';
import { authoringWork, type MandateWorkCoordinator, type MandateWorkTicket } from './mandate-work-coordination';
import { mandateReviewPath, type MandateReadScope } from './mandates';
import type { MandateTransportContext } from './mandate-retry';
import type { RecoveryStorage } from './bootstrap-recovery';

const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
export type AuthoringRetryFlow = { phase: 'check' | 'checked' | 'reviewed' | 'retrying'; reviewedHash: string | null };
export const initialAuthoringRetry: AuthoringRetryFlow = Object.freeze({ phase: 'check', reviewedHash: null });
export function authoringRetryFlow(flow: AuthoringRetryFlow, event: { type: 'checked' | 'reset' | 'retry' } | { type: 'review'; hash: string }): AuthoringRetryFlow {
  if (event.type === 'reset') return initialAuthoringRetry;
  if (event.type === 'checked') return { phase: 'checked', reviewedHash: null };
  if (event.type === 'review' && flow.phase === 'checked') return { phase: 'reviewed', reviewedHash: event.hash };
  if (event.type === 'retry' && flow.phase === 'reviewed') return { ...flow, phase: 'retrying' };
  return flow;
}
export type AuthoringTransportContext = MandateTransportContext & {
  storage: () => RecoveryStorage | null;
  work: MandateWorkCoordinator;
  selected: () => { preparationId: string; integrityHash: string } | null;
  recorded: (locator: AuthoringLocator) => MandateOperationResult | null;
  onRecorded: (locator: AuthoringLocator, result: MandateOperationResult) => void;
};
function guard(scope: MandateReadScope, context: MandateTransportContext): undefined {
  context.signal.throwIfAborted();
  if (getApiBase() !== scope.apiBase || !same(scope, context.current())) throw new RequestError('MANDATE_SCOPE_CHANGED', 'The original authenticated mandate scope changed.', 403);
  return undefined;
}
function guardLocator(scope: MandateReadScope, locator: AuthoringLocator) {
  if (!same(locator.scope, mandateRecoveryScope(scope)) || locator.responsibilityId !== scope.responsibilityId) throw new RequestError('MANDATE_SCOPE_CHANGED', 'This original preparation belongs to a different scope.', 403);
}
function requestToken(scope: MandateReadScope, context: MandateTransportContext) { return async () => { guard(scope, context); const value = await context.getToken(); guard(scope, context); return value; }; }
export const authoringPath = (responsibilityId: string, kind: MandateAuthoringCapsule['kind']) => `/v1/responsibilities/${IdSchema.parse(responsibilityId)}/${kind === 'document' ? 'mandate-policy-documents' : 'mandate-proposals'}`;
export type AuthoringSendPermission = { kind: 'first'; now: () => number } | { kind: 'retry'; currentFlow: () => AuthoringRetryFlow };

// Sending and reading the connected receipt are separate, deliberate stages. A recorded save
// stays recorded if its subsequent document read fails; it must never be saved again for that reason.
export async function sendAuthoringAttempt(input: MandateAuthoringCapsule, context: AuthoringTransportContext, permission: AuthoringSendPermission) {
  const snapshot = immutableMandate(structuredClone(input)), scope = snapshot.scope, locator = locatorFromAuthoringCapsule(snapshot);
  const ticket = context.work.acquire({ ...authoringWork(locator), action: permission.kind === 'first' ? 'send' : 'retry' });
  function allowed(): undefined {
    guard(scope, context); context.work.assert(ticket);
    if (!same(input, snapshot) || !same(context.selected(), { preparationId: snapshot.manifest.preparationId, integrityHash: snapshot.integrityHash })) throw new RequestError('AUTHORING_REVIEW_REQUIRED', 'The exact reviewed preparation changed.');
    if (context.recorded(locator)) throw new RequestError('AUTHORING_ALREADY_RECORDED', 'Read the recorded result. Do not send this original command again.');
    if (permission.kind === 'first') {
      const now = permission.now();
      if (!authoringAvailable(snapshot.observation.data, scope, now) || (snapshot.kind === 'proposal' && (now >= Date.parse(snapshot.command.expiresAt) || now >= Date.parse(snapshot.command.policy.expiresAt)))) throw new RequestError('AUTHORING_REVIEW_REQUIRED', 'The exact original preparation expired. Refresh and review current context before a new attempt.');
    } else {
      const flow = permission.currentFlow();
      if (flow.phase !== 'retrying' || flow.reviewedHash !== snapshot.integrityHash) throw new RequestError('AUTHORING_REVIEW_REQUIRED', 'Check the original result and review its retained exact input before a separate retry.');
      const manifest = assertAuthoringAttempt(context.storage(), locator);
      if (manifest.completed.some(item => same(item.locator, locator))) throw new RequestError('AUTHORING_ALREADY_RECORDED', 'The exact saved reference is already recorded; finish its local checkpoint.');
    }
    return undefined;
  }
  try {
    allowed(); const capsule = await verifyAuthoringCapsule(snapshot); allowed();
    const result = await apiRequest(authoringPath(scope.responsibilityId, capsule.kind), MandateOperationResultSchema, requestToken(scope, context), {
      body: capsule.command, idempotencyKey: capsule.key, signal: context.signal,
      beforeDispatch: () => {
        allowed();
        if (permission.kind === 'first') beginAuthoringAttempt(context.storage(), capsule.manifest, locator);
        else assertAuthoringAttempt(context.storage(), locator);
        // Persistence is synchronous, but a hostile/custom storage adapter may revoke ownership.
        allowed(); context.work.markDispatched(ticket); return undefined;
      },
    });
    guard(scope, context); context.work.assert(ticket); assertAuthoringAttempt(context.storage(), locator);
    if (!same(input, snapshot) || !same(context.selected(), { preparationId: snapshot.manifest.preparationId, integrityHash: snapshot.integrityHash })) throw new RequestError('AUTHORING_REVIEW_REQUIRED', 'The original selection changed during the request. Its saved reference remains unresolved.');
    const qualified = qualifyAuthoringOperation(result, locator);
    if (mandateOperationSucceeded(qualified)) context.onRecorded(locator, qualified);
    return immutableMandate(qualified);
  } finally { context.work.release(ticket); }
}
export const sendMandateDocument = (capsule: MandateAuthoringCapsule & { kind: 'document' }, context: AuthoringTransportContext, permission: AuthoringSendPermission) => sendAuthoringAttempt(capsule, context, permission);
export const sendMandateProposal = (capsule: MandateAuthoringCapsule & { kind: 'proposal' }, context: AuthoringTransportContext, permission: AuthoringSendPermission) => sendAuthoringAttempt(capsule, context, permission);

function readOwnership(locator: AuthoringLocator, scope: MandateReadScope, context: AuthoringTransportContext) {
  guard(scope, context); guardLocator(scope, locator); assertAuthoringAttempt(context.storage(), locator);
  return context.work.acquire({ ...authoringWork(locator), action: 'check' });
}
function readGuard(locator: AuthoringLocator, scope: MandateReadScope, context: AuthoringTransportContext, ticket: MandateWorkTicket): undefined {
  guard(scope, context); context.work.assert(ticket); assertAuthoringAttempt(context.storage(), locator); return undefined;
}
export async function lookupAuthoringAttempt(input: AuthoringLocator, scopeInput: MandateReadScope, context: AuthoringTransportContext) {
  const locator = immutableMandate(AuthoringLocatorSchema.parse(input)), scope = immutableMandate(MandateCapsuleScopeSchema.parse(scopeInput)), ticket = readOwnership(locator, scope, context);
  try {
    const result = await apiRequest(`/v1/mandate-operations?kind=${locator.kind}&key=${encodeURIComponent(locator.key)}`, MandateOperationResultSchema, requestToken(scope, context), { signal: context.signal, beforeDispatch: () => readGuard(locator, scope, context, ticket) });
    readGuard(locator, scope, context, ticket); const qualified = qualifyAuthoringOperation(result, locator);
    if (mandateOperationSucceeded(qualified)) context.onRecorded(locator, qualified);
    return immutableMandate(qualified);
  } finally { context.work.release(ticket); }
}
export async function readAuthoringReceipt(input: AuthoringLocator, resultInput: MandateOperationResult, scopeInput: MandateReadScope, context: AuthoringTransportContext, originalInput: MandateAuthoringCapsule | null = null) {
  const locator = immutableMandate(AuthoringLocatorSchema.parse(input)), scope = immutableMandate(MandateCapsuleScopeSchema.parse(scopeInput)), result = immutableMandate(qualifyAuthoringOperation(resultInput, locator));
  if (!mandateOperationSucceeded(result)) throw new RequestError('AUTHORING_UNCONFIRMED', 'The original operation has not returned a qualified saved result.');
  const original = originalInput ? immutableMandate(structuredClone(originalInput)) : null, ticket = readOwnership(locator, scope, context);
  try {
    if (original) { await verifyAuthoringCapsule(original); readGuard(locator, scope, context, ticket); if (!same(locatorFromAuthoringCapsule(original), locator)) throw new RequestError('AUTHORING_REVIEW_REQUIRED', 'The retained original input differs from its locator.'); }
    context.onRecorded(locator, result);
    const guarded = () => readGuard(locator, scope, context, ticket);
    let record;
    if (locator.step !== 'proposal') {
      const purpose = locator.step === 'acceptance' ? 'ACCEPTANCE_POLICY' : 'MANDATE_POLICY';
      const observation = await readMandateDocument(scope, () => { guarded(); return context.current(); }, context.signal, context.getToken, { id: result.target.id, version: result.target.version, hash: result.target.hash }, purpose,
        { operationId: result.operation.id, commandHash: locator.commandHash, savedAgainst: locator.basis, actorId: locator.scope.actorId, ...(original?.kind === 'document' ? { text: original.command.command.text } : {}) });
      record = observation.data;
      if (!same(record.saveOperation, result)) throw new RequestError('AUTHORING_UNCONFIRMED', 'The connected document differs from the exact original save receipt.');
    } else {
      const raw = await apiRequest(mandateReviewPath(locator.responsibilityId, locator.target.id, locator.target.version), MandateReviewSchema, requestToken(scope, context), { signal: context.signal, beforeDispatch: guarded });
      guarded(); record = await qualifyAuthoringProposal(raw, scope, locator, result, original);
    }
    guarded();
    const manifest = checkpointAuthoringAttempt(context.storage(), locator, { locator, reference: { id: result.target.id, version: result.target.version, hash: result.target.hash }, operationId: result.operation.id, savedAt: result.observedAt }, 'document' in record ? selectionFromDocument(record) : undefined);
    return immutableMandate({ result, record, manifest });
  } finally { context.work.release(ticket); }
}
