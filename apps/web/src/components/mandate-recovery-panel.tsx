'use client';
import Link from 'next/link';
import { useAuth } from '@clerk/nextjs';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MandateOperationResult } from '@pactwoven/contracts';
import { verifyMandateCapsule, type MandateCapsule } from '../lib/mandate-capsule';
import { MANDATE_VERIFICATION_LIFETIME_MS, sameMandateValue, verificationCurrent } from '../lib/mandate-actions';
import { initialMandateRetry, lookupMandateDecision, mandateFailureKind, mandateOperationSucceeded, mandateRetryFlow, readMandateDecisionReceipt, sendMandateDecision, type MandateRetryEvent, type MandateRetryFlow } from '../lib/mandate-retry';
import { mandateProposalHref, type MandateReadScope } from '../lib/mandates';
import { RequestError } from '../lib/api';
import { useMandateScopeLifetime } from './mandate-read-shared';
import { decisionWork, type MandateWorkTicket } from '../lib/mandate-work-coordination';
import { useMandateAuthoringMemory } from './mandate-authoring-memory';
import { useMandateRecoveryMemory, MandateRecoveryNotice } from './mandate-recovery-memory';
import { OriginalMandateReview } from './original-mandate-review';
import { MfaVerification } from './mfa-verification';
import { ActionLabel, Alert, Disclosure, Panel } from './ui';
import { useArrival } from './motion';

export function MandateRecoveryPanel({ scope, proposalId, version, onOutcome }: { scope: MandateReadScope; proposalId: string; version: number; onOutcome: () => void }) {
  const memory = useMandateRecoveryMemory();
  if (memory.hidden) return <Alert title="Mandate access needs checking" tone="red"><p>Private original input is hidden. The unresolved reference remains restricted to its original scope.</p></Alert>;
  if (!memory.ready || memory.slot.state !== 'pending') return null;
  const locator = memory.slot.locator;
  if (locator.responsibilityId !== scope.responsibilityId || locator.proposal.id !== proposalId || locator.proposal.version !== version) return <MandateRecoveryNotice/>;
  return <ScopedMandateRecovery key={`${locator.kind}:${locator.key}`} scope={scope} onOutcome={onOutcome}/>;
}
function ScopedMandateRecovery({ scope, onOutcome }: { scope: MandateReadScope; onOutcome: () => void }) {
  const work = useMandateAuthoringMemory().work, ticket = useRef<MandateWorkTicket | null>(null);
  const auth = useAuth(), memory = useMandateRecoveryMemory(), client = useQueryClient(), current = useMandateScopeLifetime(scope);
  const locator = memory.slot.state === 'pending' ? memory.slot.locator : null;
  const available = memory.capsule && locator && memory.capsule.key === locator.key && sameMandateValue(memory.capsule.scope, scope) ? memory.capsule : null;
  const [flow, setFlow] = useState(initialMandateRetry), flowRef = useRef<MandateRetryFlow>(initialMandateRetry);
  const [original, setOriginal] = useState<MandateCapsule | null>(null), [busy, setBusy] = useState<'check' | 'review' | 'retry' | null>(null), [verifyRound, setVerifyRound] = useState(0);
  const [message, setMessage] = useState('The outcome is not yet confirmed. Checking reads the original result; it never sends another decision.');
  const running = useRef(false), mounted = useRef(true), controller = useRef<AbortController | null>(null), reviewFocus = useRef<HTMLDivElement>(null), statusFocus = useRef<HTMLDivElement>(null);
  const arrival = useArrival(Boolean(original), 120);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; controller.current?.abort(); }; }, []);
  useLayoutEffect(() => { if (original) reviewFocus.current?.focus({ preventScroll: true }); }, [original]);
  function transition(event: MandateRetryEvent) { const value = mandateRetryFlow(flowRef.current, event); flowRef.current = value; setFlow(value); return value; }
  useLayoutEffect(() => { setOriginal(null); transition({ type: 'reset' }); }, [available?.integrityHash]);
  useEffect(() => { if (flow.verifiedAt === null) return; const timer = setTimeout(() => { transition({ type: 'invalidate' }); setVerifyRound(n => n + 1); }, Math.max(0, flow.verifiedAt + MANDATE_VERIFICATION_LIFETIME_MS - Date.now())); return () => clearTimeout(timer); }, [flow.verifiedAt]);
  function assertCurrent(signal: AbortSignal) { signal.throwIfAborted(); if (!mounted.current || !sameMandateValue(current.current, scope)) throw new RequestError('MANDATE_SCOPE_CHANGED', 'The original authenticated scope changed.', 403); }
  function context(signal: AbortSignal) { return { current: () => current.current, signal, getToken: () => auth.getToken({ skipCache: true, organizationId: scope.externalOrganizationId }) }; }
  function begin(kind: 'check' | 'review' | 'retry') { if (running.current || memory.inFlight || !locator) return null; try { ticket.current = work.acquire({ ...decisionWork(locator), action: kind === 'retry' ? 'retry' : 'check' }); } catch (error) { fail(error); return null; } running.current = true; setBusy(kind); const request = new AbortController(); controller.current = request; return request; }
  function end() { if (ticket.current) work.release(ticket.current); ticket.current = null; running.current = false; if (mounted.current) setBusy(null); }
  function fail(error: unknown) {
    if (!mounted.current) return;
    setOriginal(null); transition({ type: 'reset' }); setVerifyRound(n => n + 1);
    if (mandateFailureKind(error) === 'scope-denied') { memory.deny(); void client.cancelQueries({ queryKey: ['mandates'] }); client.removeQueries({ queryKey: ['mandates'] }); void client.invalidateQueries({ queryKey: ['session'] }); }
    setMessage(mandateFailureKind(error) === 'verification-expired' ? 'Fresh verification is required. The exact original input is retained. Check the result and review it again before a separate retry.' : 'The exact decision record could not be checked. Any recorded operation remains recorded; no resend has been enabled. ' + (error instanceof RequestError && error.status === 404 ? 'No record was returned by this read.' : 'Check the original result again.'));
  }
  async function resolve(result: MandateOperationResult, signal: AbortSignal) {
    assertCurrent(signal); if (!locator || !mandateOperationSucceeded(result)) return false;
    memory.confirm(locator, result);
    await readMandateDecisionReceipt(locator, result, scope, context(signal), available);
    assertCurrent(signal);
    if (memory.resolve(locator)) onOutcome();
    else setMessage('The exact decision is verified, but its local reference could not be cleared. Check the recorded decision again; it will not be resent.');
    return true;
  }
  async function check() {
    const request = begin('check'); if (!request || !locator) return;
    transition({ type: 'reset' }); setOriginal(null); setVerifyRound(n => n + 1);
    let readingReceipt = Boolean(memory.confirmed);
    try {
      const result = memory.confirmed?.result ?? await lookupMandateDecision(locator, scope, context(request.signal));
      readingReceipt = mandateOperationSucceeded(result);
      if (await resolve(result, request.signal)) return;
      setMessage(`The service reports ${result.operation.status}. The original decision remains unresolved. Any retry requires its retained exact input.`); transition({ type: 'checked' });
    } catch (error) {
      if (!readingReceipt && error instanceof RequestError && error.status === 404) {
        try { assertCurrent(request.signal); setMessage('No result was returned for this check. The original may still finish. A retry is available only with the exact retained input and original key.'); transition({ type: 'checked' }); } catch (stale) { fail(stale); }
      } else fail(error);
    } finally { end(); }
  }
  async function openOriginal() {
    if (!available || flowRef.current.phase !== 'checked' || memory.confirmed) return;
    const request = begin('review'); if (!request) return;
    try { assertCurrent(request.signal); const value = await verifyMandateCapsule(available, scope); assertCurrent(request.signal); setOriginal(value); transition({ type: 'review', hash: value.integrityHash }); }
    catch (error) { fail(error); } finally { end(); }
  }
  async function retry() {
    if (!original || !locator || memory.confirmed) return;
    const request = begin('retry'); if (!request) return;
    const permission = transition({ type: 'retry', action: original.intent.action, now: Date.now() });
    try { const owned = ticket.current; if (!owned) throw new RequestError('MANDATE_WORK_CONFLICT', 'The original request is no longer owned.'); const result = await sendMandateDecision(original, context(request.signal), { kind: 'retry', flow: permission, now: Date.now }, () => memory.resume(original), { work, ticket: owned }); if (await resolve(result, request.signal)) return; transition({ type: 'reset' }); setOriginal(null); setMessage('This attempt has no confirmed terminal result. Check the original decision again.'); }
    catch (error) { fail(error); } finally { memory.finish(); end(); }
  }
  if (!locator) return null;
  const reviewing = original && available && !memory.confirmed && original.integrityHash === available.integrityHash;
  const retryReady = reviewing && (original.intent.action === 'REJECT' ? flow.phase === 'reviewed' : flow.phase === 'verified' && verificationCurrent(flow.verifiedAt, Date.now()));
  return <section id="mandate-recovery" className="mandate-decision-recovery" aria-label="Original mandate decision recovery"><div ref={statusFocus} tabIndex={-1} className="access-heading-focus"><Alert title={memory.confirmed ? 'Decision recorded; exact review needs checking' : 'Confirm the original mandate decision'} tone={memory.confirmed ? 'blue' : 'amber'}><p>{memory.inFlight ? 'Waiting for the original decision response. Leaving this page does not cancel it.' : message}</p>{memory.confirmed && <p>The service confirmed this historical {locator.kind === 'mandate.authorize' ? 'authorization' : 'rejection'}. Its current review is unavailable until the exact record is checked. No repeat decision will be sent.</p>}<div className="actions"><button type="button" className="button secondary" disabled={Boolean(busy) || memory.inFlight} onClick={() => void check()}><ActionLabel label={busy === 'check' ? 'Checking original decision…' : memory.confirmed ? 'Read recorded decision' : 'Check original result'} reserve={['Checking original decision…']}/></button>{available && flow.phase === 'checked' && !memory.confirmed && <button type="button" className="button secondary" disabled={Boolean(busy)} onClick={() => void openOriginal()}><ActionLabel label={busy === 'review' ? 'Checking original input…' : 'Review original decision'} reserve={['Checking original input…']}/></button>}</div>{!available && <p className="review-note">The exact original input is no longer available in this session. This reference supports lookup only. A missing result does not cancel the request or permit a new-key resend.</p>}<Link href={mandateProposalHref(locator.responsibilityId, locator.proposal.id, locator.proposal.version)}>Read original proposal version {locator.proposal.version}</Link></Alert></div><Disclosure title="Original recovery reference"><dl className="review-key-values"><div><dt>Request</dt><dd><code>{locator.key}</code></dd></div><div><dt>Action</dt><dd>{locator.kind}</dd></div>{memory.confirmed && <div><dt>Recorded operation</dt><dd><code>{memory.confirmed.result.operation.id}</code></dd></div>}</dl></Disclosure><div ref={arrival}>{reviewing && <><div ref={reviewFocus} tabIndex={-1} className="access-heading-focus"><h2>Review the original decision</h2></div><OriginalMandateReview capsule={original}/>{original.intent.action === 'AUTHORIZE' && <Panel title="Fresh verification for this retry"><MfaVerification key={verifyRound} purpose="mandate-authorization" onComplete={() => transition({ type: 'verified', at: Date.now() })} onInvalidated={() => transition({ type: 'invalidate' })}/></Panel>}<footer className="form-footer"><p>Retry sends this unchanged original decision and key once.</p><div className="actions"><button type="button" className="button secondary" disabled={Boolean(busy)} onClick={() => { setOriginal(null); transition({ type: 'reset' }); statusFocus.current?.focus({ preventScroll: true }); }}>Close original review</button><button type="button" className={`button ${original.intent.action === 'REJECT' ? 'danger' : ''}`} disabled={Boolean(busy) || !retryReady} onClick={() => void retry()}><ActionLabel label={busy === 'retry' ? 'Retrying original decision…' : 'Retry original decision'} reserve={['Retrying original decision…']}/></button></div></footer></>}</div></section>;
}
