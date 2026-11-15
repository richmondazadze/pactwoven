'use client';
import { useAuth } from '@clerk/nextjs';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { MandateReview } from '@pactwoven/contracts';
import { canonicalJson } from '@pactwoven/contracts/canonical';
import { RequestError } from '../lib/api';
import { createAuthorityCapsule, resumeAvailable, type MandateAuthorityCapsule, type MandateAuthorityReceipt } from '../lib/mandate-authority';
import { authorityWork, locatorFromAuthorityCapsule, type MandateAuthorityLocator } from '../lib/mandate-authority-recovery';
import { sendMandateAuthority, settleMandateAuthorityReceipt, type AuthorityLocalVerification, type AuthorityTransportContext } from '../lib/mandate-authority-transport';
import { mandateOperationSucceeded, MANDATE_VERIFICATION_LIFETIME_MS, verificationCurrent } from '../lib/mandate-actions';
import { mandateFailureKind } from '../lib/mandate-retry';
import { mandateRecoveryScope } from '../lib/mandate-recovery';
import { mandateObservationTime, mandateScopeKey, type MandateObservation, type MandateReadScope } from '../lib/mandates';
import { mandateWorkAllowed, type MandateGrantPreparation } from '../lib/mandate-work-coordination';
import { useMandateAuthorityMemory } from './mandate-authority-memory';
import { MandateAuthorityReceiptView, useAuthorityReveal } from './mandate-authority-review';
import { MandateResumeReview } from './mandate-resume-review';
import { MfaVerification } from './mfa-verification';
import { useMandateScopeLifetime } from './mandate-read-shared';
import { useArrival } from './motion';
import { ActionLabel, Alert, Panel } from './ui';

const invalidationMessage = 'A separately reviewed authority stop invalidated this unsent resume. Refresh the accepted mandate and review it again before verifying.';
export function MandateResumeControls({ observation, scope, now, onOutcome }: { observation: MandateObservation<MandateReview>; scope: MandateReadScope; now: number; onOutcome: () => void }) {
  const memory = useMandateAuthorityMemory(), auth = useAuth(), client = useQueryClient(), current = useMandateScopeLifetime(scope), inputId = useId();
  const [reason, setReason] = useState(''), [prepared, setPrepared] = useState<MandateAuthorityCapsule | null>(null), [busy, setBusy] = useState(false), [status, setStatus] = useState<{ identity: string; error?: string; receipt?: MandateAuthorityReceipt; original?: { locator: MandateAuthorityLocator; scopeKey: string } } | null>(null);
  const [verification, setVerificationState] = useState<AuthorityLocalVerification | null>(null), [verifyRound, setVerifyRound] = useState(0);
  const alive = useRef(false), running = useRef(false), controller = useRef<AbortController | null>(null), selection = useRef(prepared), draft = useRef(reason), latest = useRef({ observation, memory }); selection.current = prepared; draft.current = reason; latest.current = { observation, memory };
  const round = useRef(0), verified = useRef<AuthorityLocalVerification | null>(null), grant = useRef<MandateGrantPreparation | null>(null), unwatch = useRef<(() => void) | null>(null), invalidated = useRef<MandateGrantPreparation | null>(null);
  const reviewTarget = useRef<HTMLDivElement>(null), editTarget = useRef<HTMLDivElement>(null), statusTarget = useRef<HTMLDivElement>(null), scopeKey = mandateScopeKey(scope), observationKey = canonicalJson(observation);
  // A separately recovered receipt replaces only its exact failure presentation.
  // Derive it without changing a newer draft, sending, or claiming recovery's focus.
  const recoveredReceipt = status?.error && status.original?.scopeKey === scopeKey && !memory.hidden && current.current && mandateScopeKey(current.current) === scopeKey ? memory.receipts.find(receipt => canonicalJson(receipt.locator) === canonicalJson(status.original!.locator)) : undefined;
  const statusReceipt = status?.receipt ?? recoveredReceipt, statusIdentity = statusReceipt ? canonicalJson(statusReceipt.locator) : status?.identity ?? '';
  const reveal = useAuthorityReveal(scopeKey, memory.hidden, busy, { review: reviewTarget, edit: editTarget, status: statusTarget }, { review: prepared?.integrityHash ?? '', edit: 'edit', status: statusIdentity }), arrival = useArrival(prepared?.integrityHash ?? '', 120);
  function setVerification(value: AuthorityLocalVerification | null) { verified.current = value; if (alive.current) setVerificationState(value); }
  function clearFactors() { round.current++; verified.current = null; if (alive.current) { setVerificationState(null); setVerifyRound(round.current); } }
  function releaseGrant() { unwatch.current?.(); unwatch.current = null; if (grant.current) memory.work.releasePreparation(grant.current); grant.current = null; }
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; controller.current?.abort(); clearFactors(); releaseGrant(); if (selection.current) latest.current.memory.releaseSelection(selection.current); }; }, []);
  useLayoutEffect(() => { setPrepared(null); setReason(''); setStatus(null); return () => { controller.current?.abort(); clearFactors(); releaseGrant(); }; }, [scopeKey]);
  // Each committed observation owns its in-flight preparation, even before selection.
  // Cleanup permanently revokes that gesture; restoring an old value cannot revive it.
  useLayoutEffect(() => { clearFactors(); if (selection.current && canonicalJson(selection.current.observation) !== observationKey) { controller.current?.abort(); memory.releaseSelection(selection.current); releaseGrant(); setPrepared(null); setStatus({ identity: 'review-changed', error: 'The accepted observation changed. Review it again before verifying a new resume.' }); } return () => controller.current?.abort(new RequestError('AUTHORITY_REVIEW_REQUIRED', 'The accepted observation changed. Review it again before verifying a new resume.')); }, [observationKey]);
  useEffect(() => { const hide = () => { if (document.hidden) { controller.current?.abort(); clearFactors(); } }; document.addEventListener('visibilitychange', hide); return () => document.removeEventListener('visibilitychange', hide); }, []);
  useLayoutEffect(() => { if (memory.hidden) { controller.current?.abort(); clearFactors(); releaseGrant(); setPrepared(null); setReason(''); setStatus(null); } }, [memory.hidden]);
  useEffect(() => { if (!verification) return; const timer = setTimeout(clearFactors, Math.max(0, verification.verifiedAt + MANDATE_VERIFICATION_LIFETIME_MS - Date.now())); return () => clearTimeout(timer); }, [verification]);
  function clock() { const value = latest.current.observation; return mandateObservationTime(value.data.envelope.observedAt, value); }
  function assertCurrent(signal: AbortSignal) { signal.throwIfAborted(); if (!alive.current || !current.current || mandateScopeKey(current.current) !== scopeKey || latest.current.memory.hidden) throw new RequestError('MANDATE_SCOPE_CHANGED', 'The current accepted resume scope changed.', 403); }
  function revealObserved(signal: AbortSignal, target: string, identity: string) { if (!signal.aborted && controller.current?.signal === signal) reveal(target, identity); }
  const available = resumeAvailable(observation.data, scope, now) && !memory.inventory.blocked && mandateWorkAllowed({ scope: mandateRecoveryScope(scope), responsibilityId: scope.responsibilityId, targetId: observation.data.envelope.head?.mandateId ?? '', kind: 'RESUME', key: 'resume_preview', action: 'send' }, { blocked: memory.inventory.blocked, records: memory.inventory.locators.map(authorityWork) });
  const freshReview = prepared?.intent.action === 'RESUME' && canonicalJson(prepared.observation) === observationKey && resumeAvailable(observation.data, scope, now) && (busy || available);
  function fail(error: unknown, signal: AbortSignal, original?: MandateAuthorityLocator) {
    if (!alive.current || latest.current.memory.hidden) return;
    clearFactors();
    if (mandateFailureKind(error) === 'scope-denied') { releaseGrant(); memory.deny(); void client.cancelQueries({ queryKey: ['mandates'] }); client.removeQueries({ queryKey: ['mandates'] }); void client.cancelQueries({ queryKey: ['mandate-documents'] }); client.removeQueries({ queryKey: ['mandate-documents'] }); void client.invalidateQueries({ queryKey: ['session'] }); return; }
    const identity = original ? `error:${canonicalJson(original)}` : 'error';
    setStatus({ identity, error: error instanceof RequestError ? error.message : 'This resume could not be confirmed. Keep any original reference and check its exact result before continuing.', ...(original ? { original: { locator: original, scopeKey } } : {}) }); revealObserved(signal, 'status', identity);
  }
  async function prepare() {
    if (running.current || !available || document.hidden) return;
    running.current = true; setBusy(true); setStatus(null); const request = new AbortController(); controller.current = request;
    try {
      const generation = memory.work.generation(scope, scope.responsibilityId);
      const value = await createAuthorityCapsule(scope, observation, 'RESUME', reason, crypto.randomUUID(), clock()); assertCurrent(request.signal);
      if (memory.work.generation(scope, scope.responsibilityId) !== generation) { setStatus({ identity: 'invalidated', error: invalidationMessage }); return; }
      if (canonicalJson(latest.current.observation) !== canonicalJson(value.observation) || draft.current !== reason || !resumeAvailable(latest.current.observation.data, scope, clock())) throw new RequestError('AUTHORITY_REVIEW_REQUIRED', 'The accepted observation or resume input changed. Refresh and review it again.');
      releaseGrant(); const registration = memory.work.registerPreparation({ ...authorityWork(locatorFromAuthorityCapsule(value)), kind: 'RESUME', integrityHash: value.integrityHash }, generation); grant.current = registration;
      unwatch.current = memory.work.watchPreparation(registration, () => {
        if (grant.current !== registration) return;
        invalidated.current = registration; releaseGrant(); controller.current?.abort(); clearFactors(); memory.releaseSelection(value);
        if (alive.current) { setPrepared(null); setStatus({ identity: 'invalidated', error: invalidationMessage }); }
      });
      if (!memory.work.preparationCurrent(registration)) return;
      memory.retain(value); setPrepared(value); clearFactors(); revealObserved(request.signal, 'review', value.integrityHash);
    } catch (error) { releaseGrant(); fail(error, request.signal); } finally { running.current = false; if (alive.current) setBusy(false); }
  }
  async function submit() {
    if (!prepared || prepared.intent.action !== 'RESUME' || running.current || !freshReview || !grant.current || !verificationCurrent(verified.current?.verifiedAt ?? null, Date.now()) || document.hidden) return;
    running.current = true; setBusy(true); setStatus(null); const value = prepared, submittedGrant = grant.current, locator = locatorFromAuthorityCapsule(value), request = new AbortController(); controller.current = request; let owner: object | null = null;
    try {
      assertCurrent(request.signal); owner = memory.start(locator);
      const context: AuthorityTransportContext = { ...memory, current: () => current.current, signal: request.signal, getToken: () => auth.getToken({ skipCache: true, organizationId: scope.externalOrganizationId }), selected: () => { assertCurrent(request.signal); return selection.current?.integrityHash === value.integrityHash ? memory.selected() : null; } };
      const result = await sendMandateAuthority(value, context, { kind: 'first', now: clock, resume: { preparation: submittedGrant, currentGeneration: () => round.current, currentVerification: () => verified.current, currentObservation: () => latest.current.observation } });
      if (!mandateOperationSucceeded(result)) throw new RequestError('AUTHORITY_UNCONFIRMED', 'This original resume has no confirmed terminal result. Check its original reference before continuing.');
      const receipt = await settleMandateAuthorityReceipt(locator, result, scope, context, value); assertCurrent(request.signal); memory.reload(); memory.releaseSelection(value); releaseGrant(); clearFactors(); setPrepared(null); setReason(''); setStatus({ identity: canonicalJson(locator), receipt }); revealObserved(request.signal, 'status', canonicalJson(locator)); onOutcome();
    } catch (error) {
      if (invalidated.current !== submittedGrant) { if (alive.current) { memory.releaseSelection(value); releaseGrant(); setPrepared(null); } fail(error, request.signal, locator); }
    } finally { if (owner) memory.finish(locator, owner); running.current = false; if (alive.current) setBusy(false); }
  }
  const renderedGrant = grant.current, renderedRound = verifyRound, renderedHash = prepared?.integrityHash;
  // Current factors may be revoked during token wait; only completion requires idle.
  const factorCurrent = () => alive.current && !document.hidden && !latest.current.memory.hidden && current.current !== null && mandateScopeKey(current.current) === scopeKey && round.current === renderedRound && renderedGrant !== null && grant.current === renderedGrant && memory.work.preparationCurrent(renderedGrant) && selection.current?.integrityHash === renderedHash && canonicalJson(latest.current.observation) === observationKey && resumeAvailable(latest.current.observation.data, scope, clock());
  if (memory.hidden || !memory.ready || !observation.data.envelope.acceptedVersion) return null;
  return <section className="mandate-resume-controls" aria-label="Resume current accepted authority"><Panel title="Resume accepted advice authority">
    <p className="review-note">Resume uses the accepted mandate and its complete original terms, independently of the selected proposal. A different qualified owner or finance reviewer must verify both factors before the separate resume action.</p>
    {status && <div ref={statusTarget} tabIndex={-1} className="access-heading-focus">{statusReceipt ? <MandateAuthorityReceiptView receipt={statusReceipt}/> : <Alert title="Resume needs attention" tone="red"><p>{status.error}</p>{memory.inventory.blocked || memory.inventory.locators.some(value => value.responsibilityId === scope.responsibilityId) ? <a className="text-action" href="#mandate-authority-recovery">Check original authority references</a> : <button type="button" className="button secondary" onClick={() => reveal('edit', 'edit')}>Review resume input</button>}</Alert>}</div>}
    {!prepared && <div ref={editTarget} tabIndex={-1} className="access-heading-focus"><fieldset disabled={busy}><legend>Reason for resuming</legend><label className="field" htmlFor={inputId}>Reason to record<textarea id={inputId} value={reason} onChange={event => setReason(event.target.value)} maxLength={1000} rows={3} required/><span className="fine">The reason becomes part of this exact authority-control record.</span></label></fieldset>{!available && <p className="review-note">Resume is unavailable from this observation or an original request needs checking. Refresh the accepted authority and its current review requirements. Revoked or expired authority requires a newly authorized proposal.</p>}<button type="button" className="button secondary" disabled={busy || !available || !reason.trim()} onClick={() => void prepare()}><ActionLabel label={busy ? 'Preparing resume review…' : 'Review accepted resume'} reserve={['Preparing resume review…']}/></button></div>}
    <div ref={arrival}>{prepared && <><div ref={reviewTarget} tabIndex={-1} className="access-heading-focus"><h3>Review this exact accepted resume</h3></div><MandateResumeReview capsule={prepared}/>{freshReview ? <Panel title="Verify before resuming"><fieldset disabled={busy} className="mandate-resume-verification"><MfaVerification key={verifyRound} purpose="mandate-resume" onComplete={() => { if (!running.current && !verified.current && factorCurrent() && renderedHash) setVerification({ integrityHash: renderedHash, generation: renderedRound, verifiedAt: Date.now() }); }} onInvalidated={() => { if (factorCurrent()) setVerification(null); }}/></fieldset></Panel> : <p className="review-note">This exact observation expired or changed. Return to editing and refresh before reviewing a new resume.</p>}<footer className="form-footer"><p>Only this separate action sends the reviewed resume.</p><div className="actions"><button type="button" className="button secondary" disabled={busy} onClick={() => { memory.releaseSelection(prepared); releaseGrant(); clearFactors(); setPrepared(null); setStatus(null); reveal('edit', 'edit'); }}>Back to resume input</button><button type="button" className="button" disabled={busy || !freshReview || !verificationCurrent(verification?.verifiedAt ?? null, Date.now())} onClick={() => void submit()}><ActionLabel label={busy ? 'Sending accepted resume…' : 'Resume accepted authority'} reserve={['Sending accepted resume…', 'Resume accepted authority']}/></button></div></footer></>}</div>
  </Panel></section>;
}
