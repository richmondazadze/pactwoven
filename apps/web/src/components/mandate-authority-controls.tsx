'use client';
import { useAuth } from '@clerk/nextjs';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { canonicalJson } from '@pactwoven/contracts/canonical';
import { RequestError } from '../lib/api';
import { authorityAvailable, createAuthorityCapsule, type MandateAuthorityCapsule, type MandateAuthorityObservation, type MandateAuthorityReceipt, type MandateStopAction } from '../lib/mandate-authority';
import { authorityWork, locatorFromAuthorityCapsule, type MandateAuthorityLocator } from '../lib/mandate-authority-recovery';
import { sendMandateAuthority, settleMandateAuthorityReceipt, type AuthorityTransportContext } from '../lib/mandate-authority-transport';
import { mandateOperationSucceeded } from '../lib/mandate-actions';
import { mandateFailureKind } from '../lib/mandate-retry';
import { mandateRecoveryScope } from '../lib/mandate-recovery';
import { mandateObservationTime, mandateScopeKey, type MandateReadScope } from '../lib/mandates';
import { mandateWorkAllowed } from '../lib/mandate-work-coordination';
import { useMandateAuthorityMemory } from './mandate-authority-memory';
import { MandateAuthorityReceiptView, MandateAuthorityReview, useAuthorityReveal } from './mandate-authority-review';
import { useMandateScopeLifetime } from './mandate-read-shared';
import { useArrival } from './motion';
import { ActionLabel, Alert, Panel } from './ui';

export function authorityObservationBasis(observation: MandateAuthorityObservation) {
  const e = 'envelope' in observation.data ? observation.data.envelope : observation.data;
  return canonicalJson([e.responsibilityReference, e.organizationEpoch, e.head, e.acceptedVersion ? { id: e.acceptedVersion.id, version: e.acceptedVersion.version } : null]);
}
export function MandateAuthorityControls({ observation, scope, now, onOutcome }: { observation: MandateAuthorityObservation; scope: MandateReadScope; now: number; onOutcome: () => void }) {
  const memory = useMandateAuthorityMemory(), auth = useAuth(), client = useQueryClient(), current = useMandateScopeLifetime(scope), inputId = useId();
  const [action, setAction] = useState<MandateStopAction>('PAUSE'), [reason, setReason] = useState(''), [prepared, setPrepared] = useState<MandateAuthorityCapsule | null>(null), [busy, setBusy] = useState(false), [status, setStatus] = useState<{ identity: string; error?: string; receipt?: MandateAuthorityReceipt } | null>(null);
  const alive = useRef(false), running = useRef(false), controller = useRef<AbortController | null>(null), selection = useRef(prepared), latest = useRef({ observation, memory }); selection.current = prepared; latest.current = { observation, memory };
  const reviewTarget = useRef<HTMLDivElement>(null), editTarget = useRef<HTMLDivElement>(null), statusTarget = useRef<HTMLDivElement>(null), scopeKey = mandateScopeKey(scope), basis = authorityObservationBasis(observation);
  const reveal = useAuthorityReveal(scopeKey, memory.hidden, busy, { review: reviewTarget, edit: editTarget, status: statusTarget }, { review: prepared?.integrityHash ?? '', edit: 'edit', status: status?.identity ?? '' }), arrival = useArrival(prepared?.integrityHash ?? '', 120);
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; controller.current?.abort(); if (selection.current) latest.current.memory.releaseSelection(selection.current); }; }, []);
  useLayoutEffect(() => () => { controller.current?.abort(); }, [scopeKey]);
  useEffect(() => { const hide = () => { if (document.hidden) controller.current?.abort(); }; document.addEventListener('visibilitychange', hide); return () => document.removeEventListener('visibilitychange', hide); }, []);
  useLayoutEffect(() => { if (memory.hidden) { controller.current?.abort(); setPrepared(null); setReason(''); setStatus(null); } }, [memory.hidden]);
  const e = 'envelope' in observation.data ? observation.data.envelope : observation.data;
  const available = (value: MandateStopAction) => authorityAvailable(observation.data, scope, value, now) && !memory.inventory.blocked && mandateWorkAllowed({ scope: mandateRecoveryScope(scope), responsibilityId: scope.responsibilityId, targetId: e.head?.mandateId ?? '', key: 'authority_preview', kind: value, action: 'send', hasHead: Boolean(e.head), eligible: true }, { blocked: memory.inventory.blocked, records: memory.inventory.locators.map(authorityWork) });
  const freshReview = prepared && prepared.intent.action !== 'RESUME' && basis === authorityObservationBasis(prepared.observation) && authorityAvailable(observation.data, scope, prepared.intent.action, now) && (busy || available(prepared.intent.action));
  function clock() { const value = latest.current.observation, record = 'envelope' in value.data ? value.data.envelope : value.data; return mandateObservationTime(record.observedAt, value); }
  function assertCurrent() { if (!alive.current || !current.current || mandateScopeKey(current.current) !== scopeKey || latest.current.memory.hidden) throw new RequestError('MANDATE_SCOPE_CHANGED', 'The current authority-control scope changed.', 403); }
  // An aborted observation never regains permission to request focus on return.
  function revealObserved(signal: AbortSignal, target: string, identity: string) { if (!signal.aborted && controller.current?.signal === signal) reveal(target, identity); }
  function fail(error: unknown, signal: AbortSignal) {
    if (!alive.current) return;
    if (mandateFailureKind(error) === 'scope-denied') { memory.deny(); void client.cancelQueries({ queryKey: ['mandates'] }); client.removeQueries({ queryKey: ['mandates'] }); void client.cancelQueries({ queryKey: ['mandate-documents'] }); client.removeQueries({ queryKey: ['mandate-documents'] }); void client.invalidateQueries({ queryKey: ['session'] }); return; }
    setStatus({ identity: 'error', error: error instanceof RequestError ? error.message : 'This authority control could not be confirmed. Preserve its original reference and check its result.' }); revealObserved(signal, 'status', 'error');
  }
  async function prepare() {
    if (running.current || !available(action) || document.hidden) return;
    running.current = true; setBusy(true); setStatus(null); const request = new AbortController(); controller.current = request;
    try {
      const value = await createAuthorityCapsule(scope, observation, action, reason, crypto.randomUUID(), clock()); assertCurrent();
      if (authorityObservationBasis(latest.current.observation) !== authorityObservationBasis(value.observation) || !authorityAvailable(latest.current.observation.data, scope, action, clock())) throw new RequestError('AUTHORITY_REVIEW_REQUIRED', 'The current accepted authority changed. Refresh and review its current state.');
      memory.retain(value); setPrepared(value); revealObserved(request.signal, 'review', value.integrityHash);
    } catch (error) { fail(error, request.signal); } finally { running.current = false; if (alive.current) setBusy(false); }
  }
  async function submit() {
    if (!prepared || running.current || !freshReview || document.hidden) return;
    running.current = true; setBusy(true); setStatus(null); const value = prepared, locator = locatorFromAuthorityCapsule(value), request = new AbortController(); controller.current = request; let owner: object | null = null;
    try {
      assertCurrent(); owner = memory.start(locator);
      const context: AuthorityTransportContext = { ...memory, current: () => current.current, signal: request.signal, getToken: () => auth.getToken({ skipCache: true, organizationId: scope.externalOrganizationId }), selected: () => {
        assertCurrent(); if (selection.current?.integrityHash !== value.integrityHash || authorityObservationBasis(latest.current.observation) !== authorityObservationBasis(value.observation) || !authorityAvailable(latest.current.observation.data, scope, value.intent.action, clock())) return null; return memory.selected();
      } };
      const result = await sendMandateAuthority(value, context, { kind: 'first', now: clock });
      if (!mandateOperationSucceeded(result)) throw new RequestError('AUTHORITY_UNCONFIRMED', 'This original authority request has no confirmed terminal result. Check the original result before continuing.');
      const receipt = await settleMandateAuthorityReceipt(locator, result, scope, context, value); assertCurrent(); memory.reload(); memory.releaseSelection(value); setPrepared(null); setReason(''); setStatus({ identity: canonicalJson(locator), receipt }); revealObserved(request.signal, 'status', canonicalJson(locator)); onOutcome();
    } catch (error) { if (alive.current) { memory.releaseSelection(value); setPrepared(null); } fail(error, request.signal); }
    finally { if (owner) memory.finish(locator, owner); running.current = false; if (alive.current) setBusy(false); }
  }
  if (memory.hidden || !memory.ready) return null;
  return <section className="mandate-authority-controls" aria-label="Current accepted authority controls"><Panel title="Control current accepted authority">
    <p className="review-note">These controls apply to the current accepted mandate, independently of any selected proposal. Existing obligations and recorded activity remain.</p>
    {status && <div ref={statusTarget} tabIndex={-1} className="access-heading-focus">{status.receipt ? <MandateAuthorityReceiptView receipt={status.receipt}/> : <Alert title="Authority control needs attention" tone="red"><p>{status.error}</p>{memory.inventory.blocked || memory.inventory.locators.some(value => value.responsibilityId === scope.responsibilityId) ? <a className="text-action" href="#mandate-authority-recovery">Check original authority references</a> : <button type="button" className="button secondary" onClick={() => reveal('edit', 'edit')}>Review authority input</button>}</Alert>}</div>}
    {!prepared && <div ref={editTarget} tabIndex={-1} className="access-heading-focus"><fieldset disabled={busy}><legend>Choose an authority stop</legend><div className="mandate-action-choices">{(['PAUSE', 'REVOKE'] as const).map(value => <label key={value}><input type="radio" name={inputId} checked={action === value} onChange={() => { setAction(value); setStatus(null); }}/><span>{value === 'PAUSE' ? 'Pause new use' : 'Permanently revoke authority'}</span></label>)}</div><label className="field" htmlFor={`${inputId}_reason`}>Reason to record<textarea id={`${inputId}_reason`} value={reason} onChange={event => setReason(event.target.value)} maxLength={1000} rows={3} required/><span className="fine">This reason forms part of the permanent authority-control record.</span></label></fieldset>
      {!available(action) && <p className="review-note">This stop is unavailable from the current observation or an original request needs checking. Refresh current authority and review its eligibility. No accepted head means there is nothing to stop.</p>}
      <button type="button" className="button secondary" disabled={busy || !available(action) || !reason.trim()} onClick={() => void prepare()}><ActionLabel label={busy ? 'Preparing exact review…' : 'Review authority stop'} reserve={['Preparing exact review…']}/></button></div>}
    <div ref={arrival}>{prepared && <><div ref={reviewTarget} tabIndex={-1} className="access-heading-focus"><h3>Review this exact authority stop</h3></div><MandateAuthorityReview capsule={prepared}/>{!freshReview && <p className="review-note">The accepted authority or its eligibility changed. Return to editing and refresh before reviewing a new control.</p>}<footer className="form-footer"><p>Only this separate action sends the reviewed stop.</p><div className="actions"><button type="button" className="button secondary" disabled={busy} onClick={() => { memory.releaseSelection(prepared); setPrepared(null); setStatus(null); reveal('edit', 'edit'); }}>Back to editing</button><button type="button" className={`button ${prepared.intent.action === 'REVOKE' ? 'danger' : ''}`} disabled={busy || !freshReview} onClick={() => void submit()}><ActionLabel label={busy ? 'Sending authority stop…' : prepared.intent.action === 'PAUSE' ? 'Pause accepted authority' : 'Revoke accepted authority'} reserve={['Sending authority stop…', 'Revoke accepted authority']}/></button></div></footer></>}</div>
  </Panel></section>;
}
