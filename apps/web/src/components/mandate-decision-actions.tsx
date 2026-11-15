'use client';
import { useAuth } from '@clerk/nextjs';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { MandateDecisionIntent, MandateReview } from '@pactwoven/contracts';
import { createMandateCapsule, type MandateCapsule } from '../lib/mandate-capsule';
import { decisionAvailable, MANDATE_VERIFICATION_LIFETIME_MS, prepareMandateDecision, verificationCurrent } from '../lib/mandate-actions';
import { locatorFromCapsule } from '../lib/mandate-recovery';
import { mandateFailureKind, mandateOperationSucceeded, readMandateDecisionReceipt, sendMandateDecision } from '../lib/mandate-retry';
import { mandateObservationTime, type MandateObservation, type MandateReadScope } from '../lib/mandates';
import { RequestError } from '../lib/api';
import { useMandateScopeLifetime } from './mandate-read-shared';
import { decisionWork, type MandateWorkTicket } from '../lib/mandate-work-coordination';
import { useMandateAuthoringMemory } from './mandate-authoring-memory';
import { useMandateRecoveryMemory } from './mandate-recovery-memory';
import { OriginalMandateReview } from './original-mandate-review';
import { MfaVerification } from './mfa-verification';
import { useArrival } from './motion';
import { ActionLabel, Alert, Panel } from './ui';

export function MandateDecisionActions({ observation, scope, now, onOutcome }: { observation: MandateObservation<MandateReview>; scope: MandateReadScope; now: number; onOutcome: () => void }) {
  const work = useMandateAuthoringMemory().work;
  const auth = useAuth(), memory = useMandateRecoveryMemory(), client = useQueryClient(), current = useMandateScopeLifetime(scope), inputId = useId();
  const [action, setAction] = useState<MandateDecisionIntent['action']>('AUTHORIZE'), [reason, setReason] = useState(''), [prepared, setPrepared] = useState<MandateCapsule | null>(null), [verifiedAt, setVerifiedAt] = useState<number | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [verifyRound, setVerifyRound] = useState(0);
  const running = useRef(false), mounted = useRef(true), controller = useRef<AbortController | null>(null), focus = useRef<HTMLDivElement>(null), editFocus = useRef<HTMLDivElement>(null);
  const arrival = useArrival(Boolean(prepared), 120), review = observation.data;
  const clock = () => mandateObservationTime(review.envelope.observedAt, observation);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; controller.current?.abort(); }; }, []);
  useLayoutEffect(() => { if (memory.hidden) { controller.current?.abort(); setPrepared(null); setReason(''); setVerifiedAt(null); } }, [memory.hidden]);
  useLayoutEffect(() => { if (prepared) focus.current?.focus({ preventScroll: true }); }, [prepared]);
  useEffect(() => { if (verifiedAt === null) return; const timer = setTimeout(() => { setVerifiedAt(null); setVerifyRound(n => n + 1); }, Math.max(0, verifiedAt + MANDATE_VERIFICATION_LIFETIME_MS - Date.now())); return () => clearTimeout(timer); }, [verifiedAt]);
  const allowed = decisionAvailable(review, scope, action, now), known = memory.receipt?.locator;
  function fail(error: unknown) {
    if (!mounted.current) return;
    setVerifiedAt(null); setVerifyRound(n => n + 1);
    if (mandateFailureKind(error) === 'scope-denied') { setPrepared(null); setReason(''); memory.deny(); void client.cancelQueries({ queryKey: ['mandates'] }); client.removeQueries({ queryKey: ['mandates'] }); void client.invalidateQueries({ queryKey: ['session'] }); }
    setError(error instanceof RequestError ? error.message : 'This decision could not be confirmed. Check its original result if a request reference was saved.');
  }
  async function prepare() {
    if (running.current || !allowed || memory.slot.state !== 'empty') return;
    running.current = true; setBusy(true); setError('');
    try {
      const intent = await prepareMandateDecision(review, scope, action, reason, clock());
      const capsule = await createMandateCapsule(scope, intent, review, crypto.randomUUID());
      if (!mounted.current || current.current === null) return;
      setPrepared(capsule); setVerifiedAt(null); setVerifyRound(n => n + 1);
    } catch (error) { fail(error); } finally { running.current = false; if (mounted.current) setBusy(false); }
  }
  async function submit() {
    if (!prepared || running.current || memory.slot.state !== 'empty') return;
    running.current = true; setBusy(true); setError(''); const request = new AbortController(); controller.current = request;
    const context = { current: () => current.current, signal: request.signal, getToken: () => auth.getToken({ skipCache: true, organizationId: scope.externalOrganizationId }) };
    let ticket: MandateWorkTicket | null = null;
    try {
      ticket = work.acquire({ ...decisionWork(locatorFromCapsule(prepared)), action: 'send' });
      const owned = ticket;
      const result = await sendMandateDecision(prepared, context, { kind: 'first', verifiedAt, now: clock }, () => memory.begin(prepared), { work, ticket: owned });
      if (mandateOperationSucceeded(result)) {
        const locator = locatorFromCapsule(prepared); memory.confirm(locator, result);
        await readMandateDecisionReceipt(locator, result, scope, context, prepared);
        memory.resolve(locator); setPrepared(null); setReason(''); onOutcome();
      }
    } catch (error) { fail(error); } finally { if (ticket) work.release(ticket); running.current = false; memory.finish(); if (mounted.current) setBusy(false); }
  }
  if (memory.hidden) return <Alert title="Mandate access needs checking" tone="red"><p>Private decision input is hidden. Check your current workspace access before continuing.</p></Alert>;
  if (!memory.ready) return null;
  if (memory.slot.state === 'pending') return null;
  if (memory.slot.state === 'blocked') return <Alert title="Decision recovery storage needs attention"><p>The original reference could not be checked. No new decision can be sent while storage is unavailable or an unreadable reference occupies this scope.</p><button type="button" className="button secondary" onClick={memory.reload}>Check recovery storage</button></Alert>;
  if (known && review.envelope.proposal && known.proposal.id === review.envelope.proposal.id && known.proposal.version === review.envelope.proposal.version) return <Alert title={known.kind === 'mandate.authorize' ? 'Authorization recorded' : 'Rejection recorded'} tone="blue"><p>The exact decision record was verified. Current authority is shown separately above.</p></Alert>;
  if (review.envelope.decision?.state !== 'OPEN') return null;
  return <section className="mandate-decision-actions" aria-label="Independent mandate decision"><Panel title="Independent decision"><p className="review-note">Review the complete original terms above. A different qualified owner or finance reviewer can record a decision.</p>{!prepared && <div ref={editFocus} tabIndex={-1} className="access-heading-focus"><fieldset disabled={busy}><legend>Choose a decision</legend><div className="mandate-action-choices">{(['AUTHORIZE', 'REJECT'] as const).map(value => <label key={value}><input type="radio" name={inputId} checked={action === value} onChange={() => { setAction(value); setError(''); setVerifiedAt(null); }}/><span>{value === 'AUTHORIZE' ? 'Authorize advice-only mandate' : 'Reject proposal'}</span></label>)}</div>{action === 'REJECT' && <label className="field" htmlFor={inputId}>Reason for rejection<textarea id={inputId} value={reason} onChange={e => setReason(e.target.value)} maxLength={1000} rows={4} required/><span className="fine">This reason is part of the permanent decision record.</span></label>}</fieldset>{!allowed && <p className="review-note">This decision is not available from the current observation. Check the review context and refresh the proposal.</p>}<button type="button" className="button secondary" disabled={busy || !allowed || (action === 'REJECT' && !reason.trim())} onClick={() => void prepare()}><ActionLabel label={busy ? 'Preparing exact review…' : 'Review decision'} reserve={['Preparing exact review…']}/></button></div>}<div ref={arrival}>{prepared && <><div ref={focus} tabIndex={-1} className="access-heading-focus"><h3>Review your exact decision</h3></div><OriginalMandateReview capsule={prepared}/>{action === 'AUTHORIZE' && <Panel title="Verify before authorizing"><MfaVerification key={verifyRound} purpose="mandate-authorization" onComplete={() => setVerifiedAt(Date.now())} onInvalidated={() => setVerifiedAt(null)}/></Panel>}{!allowed && <p className="review-note">This observation has expired or changed. Return to editing and refresh the proposal before reviewing again.</p>}<footer className="form-footer"><p>Only the separate action below sends this decision.</p><div className="actions"><button className="button secondary" type="button" disabled={busy} onClick={() => { setPrepared(null); setVerifiedAt(null); setError(''); requestAnimationFrame(() => editFocus.current?.focus({ preventScroll: true })); }}>Back to editing</button><button className={`button ${action === 'REJECT' ? 'danger' : ''}`} type="button" disabled={busy || !allowed || (action === 'AUTHORIZE' && !verificationCurrent(verifiedAt, Date.now()))} onClick={() => void submit()}><ActionLabel label={busy ? 'Sending decision…' : action === 'AUTHORIZE' ? 'Authorize advice-only mandate' : 'Reject proposal'} reserve={['Authorize advice-only mandate', 'Sending decision…']}/></button></div></footer></>}</div>{error && <Alert title="Decision needs attention" tone="red"><p>{error}</p></Alert>}</Panel></section>;
}
