'use client';
import { useAuth } from '@clerk/nextjs';
import type { Operation } from '@pactwoven/contracts';
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react';
import { capsuleMatchesSession, observeOriginalIdentity, verifyAccessCapsule, type AccessCapsule, type OriginalObservation } from '../lib/access-capsule';
import { accessRecoveryStored, recoveryMatchesScope, settleAccessRecovery, type AccessRecovery } from '../lib/access-recovery';
import { initialRecoveryFlow, originalOperation, recoveryFlow, recoveryFailureKind, retryOriginalAccess, RETRY_REVIEW_LIFETIME_MS, type RecoveryEvent, type RecoveryFlow, type RetryContext } from '../lib/access-retry';
import { ACCESS_CLOSURE_OBSERVATION_MS, ACCESS_CLOSURE_FACTOR_MS, accessCloseFlow, accessClosureScope, accessClosureTime, checkAccessRecovery, closeAccessRecovery, closureLocatorScope, closureObservationCurrent, closureVerificationCurrent, initialAccessCloseFlow, prepareAccessClosure, type AccessCloseEvent, type AccessCloseFlow, type AccessCloseReview, type AccessClosureContext, type AccessClosureObservation, type AccessFencedResult } from '../lib/access-closure';
import { isAccessOwner } from '../lib/access-review';
import { RequestError } from '../lib/api';
import { browserRecoveryStorage } from '../lib/bootstrap-recovery';
import { getApiBase } from '../lib/config';
import { revealAccessTarget } from '../lib/access-viewport';
import { useWorkspace } from './workspace-provider';
import { useAccessRecoveryMemory } from './access-recovery-memory';
import { OriginalAccessReview } from './original-access-review';
import { AccessClosureReceipt, AccessClosureReview } from './access-closure-review';
import { MfaVerification } from './mfa-verification';
import { ActionLabel, Alert, Panel } from './ui';
import { useArrival, useMotion } from './motion';

type RecoveryFact = { kind: 'operation'; operation: Operation } | { kind: 'fence'; result: AccessFencedResult };
export function AccessRecoveryPanel({ recovery, onOutcome, onFenced, onAccessLost }: { recovery: AccessRecovery; onOutcome: (operation: Operation, remaining: AccessRecovery | null) => void; onFenced: (result: AccessFencedResult, remaining: AccessRecovery | null) => void; onAccessLost: () => void }) {
  const { session } = useWorkspace(), auth = useAuth(), memory = useAccessRecoveryMemory(), { mode, keyboard } = useMotion();
  const available = memory.capsule;
  const capsule = recovery.version === 2 && available && available.key === recovery.key && available.original.kind === recovery.kind && capsuleMatchesSession(available, session, auth, getApiBase()) ? available : null;
  const [flow, setFlow] = useState(initialRecoveryFlow), flowRef = useRef<RecoveryFlow>(initialRecoveryFlow);
  const [closeFlow, setCloseFlow] = useState(initialAccessCloseFlow), closeFlowRef = useRef<AccessCloseFlow>(initialAccessCloseFlow);
  const [review, setReview] = useState<{ capsule: AccessCapsule; observation: OriginalObservation } | null>(null);
  const [closure, setClosure] = useState<AccessCloseReview | null>(null), [observation, setObservation] = useState<AccessClosureObservation | null>(null), [fact, setFact] = useState<RecoveryFact | null>(null);
  const [busy, setBusy] = useState<'check' | 'review' | 'retry' | 'closure-review' | 'close' | null>(null), [verifyRound, setVerifyRound] = useState(0), [, tick] = useState(0);
  const [message, setMessage] = useState('The original request has no confirmed outcome. Check its typed result before reviewing an exact retry or administrative closure. New access changes remain locked.');
  const [denied, setDenied] = useState(false), running = useRef(false), controller = useRef<AbortController | null>(null), mounted = useRef(true);
  const context = useRef<RetryContext>({ session, auth, apiBase: getApiBase() }), selected = useRef<AccessRecovery | null>(recovery);
  useLayoutEffect(() => { context.current = { session, auth, apiBase: getApiBase() }; selected.current = recovery; });
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; selected.current = null; controller.current?.abort(); }; }, []);
  function transition(event: RecoveryEvent) { const next = recoveryFlow(flowRef.current, event); flowRef.current = next; setFlow(next); return next; }
  function closeTransition(event: AccessCloseEvent) { const next = accessCloseFlow(closeFlowRef.current, event); closeFlowRef.current = next; setCloseFlow(next); return next; }
  function resetReviews() { transition({ type: 'reset' }); closeTransition({ type: 'reset' }); setReview(null); setClosure(null); setObservation(null); setVerifyRound(round => round + 1); }
  useLayoutEffect(() => { resetReviews(); }, [available?.integrityHash]);
  useEffect(() => { if (flow.phase !== 'verified' || flow.verifiedAt === null) return; const timer = setTimeout(() => { transition({ type: 'verification-invalidated' }); setVerifyRound(round => round + 1); setMessage('The verification review expired. Verify both factors again before an explicit retry.'); }, Math.max(0, flow.verifiedAt + RETRY_REVIEW_LIFETIME_MS - Date.now())); return () => clearTimeout(timer); }, [flow.phase, flow.verifiedAt]);
  const closureNow = closure ? accessClosureTime(closure) : observation ? accessClosureTime({ ...observation, observedAt: observation.result.observedAt }) : Date.now();
  const closureFresh = closure ? closureObservationCurrent(closure.observedAt, closureNow) : false;
  useEffect(() => {
    if (!closure && !observation) return;
    const observedAt = closure?.observedAt ?? observation!.result.observedAt;
    const deadlines = [Date.parse(observedAt) + ACCESS_CLOSURE_OBSERVATION_MS - closureNow, ...(closeFlow.verifiedAt !== null ? [closeFlow.verifiedAt + ACCESS_CLOSURE_FACTOR_MS - Date.now()] : [])].filter(delay => delay > 0);
    if (!deadlines.length) return;
    const timer = setTimeout(() => { tick(n => n + 1); if (closeFlowRef.current.verifiedAt !== null && !closureVerificationCurrent(closeFlowRef.current.verifiedAt)) { closeTransition({ type: 'invalidate' }); setVerifyRound(n => n + 1); } }, Math.max(1, Math.min(...deadlines)));
    return () => clearTimeout(timer);
  }, [closure, observation, closeFlow.verifiedAt, closureNow]);
  const reviewVisible = !denied && !fact && capsule && review?.capsule.integrityHash === capsule.integrityHash && ['reviewed', 'verified', 'retrying'].includes(flow.phase) ? review : null;
  const closureVisible = !denied && !fact && !available && closure && ['reviewed', 'verified', 'closing'].includes(closeFlow.phase) ? closure : null;
  const showingReview = Boolean(reviewVisible || closureVisible), arrival = useArrival(showingReview, 120), reviewFocus = useRef<HTMLDivElement>(null), statusFocus = useRef<HTMLDivElement>(null);
  const reveal = useEffectEvent(() => revealAccessTarget(showingReview ? reviewFocus.current : statusFocus.current, { mode, keyboard: keyboard.current, prefersReducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches, hidden: document.hidden }));
  const wasReviewVisible = useRef(false);
  useLayoutEffect(() => { if (showingReview || wasReviewVisible.current) reveal(); wasReviewVisible.current = showingReview; }, [showingReview]);
  function assertCurrent(signal: AbortSignal) {
    signal.throwIfAborted(); const current = context.current;
    const scope = { userId: current.auth.userId ?? '', organizationId: current.auth.orgId ?? '', apiBase: current.apiBase ?? '', environment: current.session.actor.environment, internalOrganizationId: current.session.organization.id, actorId: current.session.actor.actorId };
    if (!mounted.current || current.auth.sessionId !== auth.sessionId || !isAccessOwner(current.session) || !recoveryMatchesScope(recovery, scope) || selected.current?.key !== recovery.key || selected.current.kind !== recovery.kind) throw new RequestError('RECOVERY_SCOPE_CHANGED', 'Current owner access could not be verified.', 403);
  }
  function freshToken(signal: AbortSignal) { return async () => { assertCurrent(signal); const token = await auth.getToken({ skipCache: true, organizationId: recovery.organizationId }); assertCurrent(signal); return token; }; }
  function closureContext(signal: AbortSignal): AccessClosureContext { return { current: () => context.current, selected: () => selected.current, hasOriginal: memory.hasOriginal, getToken: freshToken(signal), signal }; }
  function begin(kind: NonNullable<typeof busy>) { if (running.current || memory.inFlight) return null; running.current = true; setBusy(kind); const request = new AbortController(); controller.current = request; return request; }
  function end() { running.current = false; if (mounted.current) setBusy(null); }
  function failed(error: unknown) {
    if (!mounted.current) return;
    resetReviews(); const failure = recoveryFailureKind(error);
    setMessage(failure === 'verification-expired' ? 'Fresh verification is required. The original reference and any retained input remain unchanged. Check the result, review the intended action and verify both factors again.' : error instanceof RequestError && [404, 503].includes(error.status) ? 'Typed access recovery is unavailable. No absence or closure has been assumed. Check again after the service is available; no resend or close is enabled by this error.' : 'The original result or this attempt could not be confirmed. Check the original result again. No error cancels or closes the request key.');
    if (failure === 'scope-denied') { setDenied(true); setFact(null); memory.purge(); onAccessLost(); }
  }
  function settle(found: RecoveryFact, signal: AbortSignal) {
    assertCurrent(signal); setFact(found); resetReviews();
    const outcome = settleAccessRecovery(browserRecoveryStorage(), recovery, closureLocatorScope(accessClosureScope(context.current)));
    if (!outcome.cleared) { setMessage('The recorded result is confirmed, but the local reference could not be cleared and checked. New changes remain blocked. Check the original result again to retry local cleanup.'); return true; }
    memory.resolve(recovery.key, recovery.kind);
    if (found.kind === 'operation') onOutcome(found.operation, outcome.remaining); else onFenced(found.result, outcome.remaining);
    return true;
  }
  function resolveOperation(operation: Operation, signal: AbortSignal) {
    assertCurrent(signal); originalOperation(operation, context.current.session.actor.environment, capsule);
    if (operation.status !== 'succeeded' && operation.status !== 'failed') return false;
    return settle({ kind: 'operation', operation }, signal);
  }
  async function check() {
    const request = begin('check'); if (!request) return; resetReviews();
    try {
      const checked = await checkAccessRecovery(recovery, closureContext(request.signal)); assertCurrent(request.signal);
      if (checked.result.disposition === 'fenced') { settle({ kind: 'fence', result: checked.result }, request.signal); return; }
      if (checked.result.disposition === 'recorded') {
        if (resolveOperation(checked.result.operation, request.signal)) return;
        setObservation(checked); setMessage(`The service reports ${checked.result.operation.status}. The original request remains unresolved. Administrative closure cannot replace a recorded operation.`); transition({ type: 'check-result' }); return;
      }
      if (fact) throw new RequestError('RECOVERY_RESPONSE_UNVERIFIED', 'A previous recorded result cannot become mere absence.');
      setObservation(checked); transition({ type: 'check-result' }); closeTransition({ type: 'checked' });
      setMessage('No result is recorded for this check. The original request may still arrive. Retained input supports exact retry; missing input supports a separate administrative closure review.');
    } catch (error) { failed(error); } finally { end(); }
  }
  async function openReview() {
    if (!capsule || flowRef.current.phase !== 'checked' || fact) return; const request = begin('review'); if (!request) return;
    try { assertCurrent(request.signal); const original = await verifyAccessCapsule(capsule, capsule.scope); const observed = await observeOriginalIdentity(original, freshToken(request.signal), request.signal); assertCurrent(request.signal); if (!capsuleMatchesSession(original, context.current.session, context.current.auth, context.current.apiBase)) throw new RequestError('RECOVERY_SCOPE_CHANGED', 'The original session changed.', 403); setClosure(null); closeTransition({ type: 'reset' }); setReview({ capsule: original, observation: observed }); transition({ type: 'review', hash: original.integrityHash }); setMessage('Review the complete original request below, verify both factors, then choose the separate retry action.'); }
    catch (error) { failed(error); } finally { end(); }
  }
  async function retry() {
    if (!reviewVisible || flowRef.current.phase !== 'verified' || fact) return; const request = begin('retry'); if (!request) return;
    const permission = transition({ type: 'retry-click', now: Date.now() }); let release: (() => void) | null = null;
    try { release = memory.beginAction(recovery.key, 'retry'); const operation = await retryOriginalAccess(reviewVisible.capsule, permission, () => context.current, freshToken(request.signal), request.signal); if (resolveOperation(operation, request.signal)) return; resetReviews(); setMessage(`The service reports ${operation.status}. The original request remains unresolved. Check its result before considering another retry.`); }
    catch (error) { failed(error); } finally { release?.(); end(); }
  }
  async function openClosureReview() {
    if (!observation || memory.hasOriginal() || closeFlowRef.current.phase !== 'checked' || fact) return; const request = begin('closure-review'); if (!request) return;
    try { assertCurrent(request.signal); const value = await prepareAccessClosure(observation, recovery, context.current, memory.hasOriginal()); assertCurrent(request.signal); if (memory.hasOriginal()) throw new RequestError('ORIGINAL_INPUT_AVAILABLE', 'Original input is retained.'); setReview(null); transition({ type: 'reset' }); setClosure(value); closeTransition({ type: 'review', hash: value.integrityHash }); }
    catch (error) { failed(error); } finally { end(); }
  }
  async function closeKey() {
    if (!closureVisible || fact || memory.hasOriginal()) return; const request = begin('close'); if (!request) return;
    const permission = closeTransition({ type: 'close', now: Date.now() }); const release: { current: (() => void) | null } = { current: null };
    try {
      release.current = memory.beginAction(recovery.key, 'close');
      const result = await closeAccessRecovery(closureVisible, permission, closureContext(request.signal), () => {
        assertCurrent(request.signal);
        if (!running.current || controller.current !== request || release.current === null) throw new RequestError('RECOVERY_ACTION_CHANGED', 'This close action no longer owns its pending request. No closure was sent.');
        if (!accessRecoveryStored(browserRecoveryStorage(), recovery)) throw new RequestError('RECOVERY_REFERENCE_CHANGED', 'The original stored reference changed. No closure was sent.');
        return undefined;
      });
      assertCurrent(request.signal);
      if (result.disposition === 'fenced') { settle({ kind: 'fence', result }, request.signal); return; }
      if (resolveOperation(result.operation, request.signal)) return;
      resetReviews(); setMessage(`An original operation was recorded first and is ${result.operation.status}. Its outcome remains unresolved; closure did not replace or undo it.`);
    } catch (error) { failed(error); } finally { release.current?.(); end(); }
  }
  if (denied) return <Alert title="Current owner access could not be verified" tone="red"><p>Private review input has been cleared. The minimal unresolved reference remains available only in its matching authorized scope.</p></Alert>;
  const canReviewClosure = !available && !fact && observation?.result.disposition === 'not_recorded' && closeFlow.phase === 'checked' && closureObservationCurrent(observation.result.observedAt, closureNow);
  return <div className="access-recovery"><div ref={statusFocus} tabIndex={-1} className="access-heading-focus"><Alert title="Confirm the original access request" tone="amber"><p>{message}</p><p className="fine">Request: {recovery.key} · {recovery.kind}</p><div className="actions"><button type="button" className="button secondary" disabled={Boolean(busy) || memory.inFlight} onClick={() => void check()}><ActionLabel label={busy === 'check' ? 'Checking original request…' : 'Check original result'} reserve={['Checking original request…']}/></button>{capsule && flow.phase === 'checked' && !fact && <button type="button" className="button secondary" disabled={Boolean(busy) || memory.inFlight} onClick={() => void openReview()}><ActionLabel label={busy === 'review' ? 'Verifying original identity…' : 'Review original request'} reserve={['Verifying original identity…']}/></button>}{canReviewClosure && <button type="button" className="button secondary" disabled={Boolean(busy) || memory.inFlight} onClick={() => void openClosureReview()}><ActionLabel label={busy === 'closure-review' ? 'Preparing closure review…' : 'Review closure'} reserve={['Preparing closure review…']}/></button>}</div><p className="fine">Checking only reads the result. It never resends or closes the request. You can inspect members and use workspace navigation while this reference remains unresolved.</p>{!available && !fact && <p className="review-note">The exact original input is unavailable. It cannot be reconstructed for retry. A qualified missing-result observation can support a separate current-owner closure review.</p>}{available && !capsule && <p className="review-note">Retained input does not match this review. Neither original retry nor missing-input closure is available from this inconsistent state.</p>}{observation?.result.disposition === 'not_recorded' && !closureObservationCurrent(observation.result.observedAt, closureNow) && <p className="review-note">This observation has expired. Check the original result again before preparing closure.</p>}</Alert></div>
    {fact && (fact.kind === 'fence' ? <AccessClosureReceipt receipt={{ ...fact.result.fence, kind: fact.result.kind, key: fact.result.key }}/> : <Alert title={fact.operation.status === 'succeeded' ? 'Original access change recorded' : 'Original access change failed'} tone={fact.operation.status === 'succeeded' ? 'blue' : 'red'}><p>Operation {fact.operation.id} records member version {fact.operation.aggregateVersion}. Current access is checked separately. This is an operation receipt, not an administrative fence.</p></Alert>)}
    <div ref={arrival}>{showingReview && <div ref={reviewFocus} tabIndex={-1} className="access-heading-focus"><h2>{reviewVisible ? 'Review the original access request' : 'Review request-key closure'}</h2></div>}{reviewVisible && <><OriginalAccessReview capsule={reviewVisible.capsule} observation={reviewVisible.observation} sites={session.sites}/><Panel title="Fresh verification for this retry"><MfaVerification key={`retry:${verifyRound}`} onComplete={() => transition({ type: 'verified', at: Date.now() })} onInvalidated={() => transition({ type: 'verification-invalidated' })}/></Panel><footer className="form-footer"><p>{busy === 'retry' ? 'Waiting for the original request result…' : 'Verification does not resend the request. Retry sends the exact original input and key once.'}</p><div className="actions"><button type="button" className="button secondary" disabled={Boolean(busy)} onClick={resetReviews}>Close original review</button><button type="button" className={`button ${reviewVisible.capsule.original.kind === 'revoke' ? 'danger' : ''}`} disabled={Boolean(busy) || memory.inFlight || flow.phase !== 'verified'} onClick={() => void retry()}><ActionLabel label={busy === 'retry' ? 'Retrying original request…' : 'Retry original request'} reserve={['Retrying original request…']}/></button></div></footer></>}
      {closureVisible && <><AccessClosureReview review={closureVisible} organizationName={session.organization.name}/><Panel title="Verify this administrative closure"><MfaVerification key={`close:${verifyRound}`} purpose="access-recovery-close" onComplete={() => closeTransition({ type: 'verified', at: Date.now() })} onInvalidated={() => closeTransition({ type: 'invalidate' })}/></Panel>{!closureFresh && <Alert title="A fresh result check is needed"><p>The closure observation expired. Check the original result and review the current closure context again.</p></Alert>}<footer className="form-footer"><p>Verification does not close the key. Only the separate close action requests administrative closure.</p><div className="actions"><button type="button" className="button secondary" disabled={Boolean(busy)} onClick={resetReviews}>Leave closure review</button><button type="button" className="button danger" disabled={Boolean(busy) || memory.inFlight || !closureFresh || closeFlow.phase !== 'verified' || !closureVerificationCurrent(closeFlow.verifiedAt)} onClick={() => void closeKey()}><ActionLabel label={busy === 'close' ? 'Closing original request key…' : 'Close original request key'} reserve={['Closing original request key…']}/></button></div></footer></>}
    </div>
  </div>;
}
