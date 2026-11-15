'use client';
import { useAuth } from '@clerk/nextjs';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { canonicalJson } from '@pactwoven/contracts/canonical';
import { RequestError } from '../lib/api';
import { verifyAuthorityCapsule, type MandateAuthorityCapsule, type MandateAuthorityReceipt } from '../lib/mandate-authority';
import { locatorFromAuthorityCapsule, type MandateAuthorityLocator } from '../lib/mandate-authority-recovery';
import { authorityRetryFlow, initialAuthorityRetry, lookupMandateAuthority, sendMandateAuthority, settleMandateAuthorityReceipt, type AuthorityRetryFlow, type AuthorityTransportContext } from '../lib/mandate-authority-transport';
import { mandateOperationSucceeded } from '../lib/mandate-actions';
import { mandateFailureKind } from '../lib/mandate-retry';
import { mandateScopeKey, type MandateReadScope } from '../lib/mandates';
import { useMandateAuthorityMemory } from './mandate-authority-memory';
import { MandateAuthorityReceiptView, MandateAuthorityReview, useAuthorityReveal } from './mandate-authority-review';
import { useMandateScopeLifetime } from './mandate-read-shared';
import { useArrival } from './motion';
import { ActionLabel, Alert, Disclosure } from './ui';

export function MandateAuthorityRecoveryPanel({ scope, onOutcome }: { scope: MandateReadScope; onOutcome: () => void }) {
  const memory = useMandateAuthorityMemory(), [error, setError] = useState('');
  if (!memory.ready || memory.hidden) return null;
  const records = new Map<string, { locator: MandateAuthorityLocator; receipt: MandateAuthorityReceipt | null }>();
  for (const locator of memory.inventory.locators) if (locator.responsibilityId === scope.responsibilityId) records.set(canonicalJson(locator), { locator, receipt: null });
  for (const receipt of memory.receipts) if (receipt.locator.responsibilityId === scope.responsibilityId) records.set(canonicalJson(receipt.locator), { locator: receipt.locator, receipt });
  return <section id="mandate-authority-recovery" className="mandate-authority-recovery" aria-label="Original authority-control results">
    {memory.inventory.blocked && <Alert title="Authority recovery storage needs attention" tone="amber"><p>Some original references could not be checked. Readable originals are preserved. No unreadable reference is treated as canceled.</p><button type="button" className="button secondary" onClick={() => { try { const result = memory.reload(); setError(result.blocked ? 'Storage was checked and still needs attention. Readable original references remain available below.' : 'Authority recovery storage was checked.'); } catch { setError('Recovery storage remains unavailable. Keep every original reference.'); } }}>Check authority recovery storage</button></Alert>}{error && <p role="status">{error}</p>}
    {[...records].map(([key, value]) => <MandateAuthorityRecoveryCard key={key} scope={scope} locator={value.locator} receipt={value.receipt} onOutcome={onOutcome}/>)}
  </section>;
}
export function MandateAuthorityRecoveryCard({ scope, locator, receipt, onOutcome }: { scope: MandateReadScope; locator: MandateAuthorityLocator; receipt: MandateAuthorityReceipt | null; onOutcome: () => void }) {
  const memory = useMandateAuthorityMemory(), auth = useAuth(), client = useQueryClient(), current = useMandateScopeLifetime(scope), scopeKey = mandateScopeKey(scope), identity = canonicalJson(locator);
  const [flow, setFlow] = useState<AuthorityRetryFlow>(initialAuthorityRetry), flowRef = useRef(flow), [original, setOriginal] = useState<MandateAuthorityCapsule | null>(null), [busy, setBusy] = useState(''), [message, setMessage] = useState('This original authority request may still finish. Check its exact result before considering a retry.');
  const alive = useRef(false), running = useRef(false), controller = useRef<AbortController | null>(null), selected = useRef(original), latest = useRef(memory); selected.current = original; latest.current = memory;
  const statusTarget = useRef<HTMLDivElement>(null), reviewTarget = useRef<HTMLDivElement>(null), reveal = useAuthorityReveal(scopeKey, memory.hidden, Boolean(busy), { status: statusTarget, review: reviewTarget }, { status: identity, review: original?.integrityHash ?? '' }), arrival = useArrival(original?.integrityHash ?? '', 120);
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; controller.current?.abort(); if (selected.current) latest.current.releaseSelection(selected.current); }; }, []);
  useLayoutEffect(() => () => { controller.current?.abort(); }, [scopeKey, identity]);
  useEffect(() => { const hide = () => { if (document.hidden) controller.current?.abort(); }; document.addEventListener('visibilitychange', hide); return () => document.removeEventListener('visibilitychange', hide); }, []);
  useLayoutEffect(() => { if (memory.hidden) { controller.current?.abort(); setOriginal(null); flowRef.current = initialAuthorityRetry; setFlow(initialAuthorityRetry); setMessage(''); } }, [memory.hidden]);
  function transition(event: Parameters<typeof authorityRetryFlow>[1]) { flowRef.current = authorityRetryFlow(flowRef.current, event); setFlow(flowRef.current); return flowRef.current; }
  function assertCurrent(signal: AbortSignal) { signal.throwIfAborted(); if (!alive.current || !current.current || mandateScopeKey(current.current) !== scopeKey || latest.current.hidden) throw new RequestError('MANDATE_SCOPE_CHANGED', 'The original authority recovery scope changed.', 403); }
  function context(signal: AbortSignal): AuthorityTransportContext { return { ...memory, current: () => current.current, signal, getToken: () => auth.getToken({ skipCache: true, organizationId: scope.externalOrganizationId }) }; }
  // Permission belongs to this observation, not to the page's later visibility.
  function revealObserved(signal: AbortSignal, target: string, identity: string) { if (!signal.aborted && controller.current?.signal === signal) reveal(target, identity); }
  function fail(error: unknown, signal: AbortSignal) {
    if (!alive.current) return;
    if (mandateFailureKind(error) === 'scope-denied') { memory.deny(); void client.cancelQueries({ queryKey: ['mandates'] }); client.removeQueries({ queryKey: ['mandates'] }); void client.cancelQueries({ queryKey: ['mandate-documents'] }); client.removeQueries({ queryKey: ['mandate-documents'] }); void client.invalidateQueries({ queryKey: ['session'] }); return; }
    transition({ type: 'reset' }); if (selected.current) memory.releaseSelection(selected.current); setOriginal(null);
    setMessage(error instanceof RequestError ? error.message : 'The original result could not be confirmed. Keep its original reference.'); revealObserved(signal, 'status', identity);
  }
  async function run(phase: string, task: (signal: AbortSignal) => Promise<void>) {
    if (running.current || memory.busy(locator) || document.hidden) return;
    running.current = true; setBusy(phase); const request = new AbortController(); controller.current = request; let owner: object | null = null;
    try { assertCurrent(request.signal); owner = memory.start(locator); await task(request.signal); }
    catch (error) { fail(error, request.signal); }
    finally { if (owner) memory.finish(locator, owner); running.current = false; if (alive.current) setBusy(''); }
  }
  async function settle(result: Parameters<typeof settleMandateAuthorityReceipt>[1], signal: AbortSignal) {
    if (!mandateOperationSucceeded(result)) { transition({ type: 'reset' }); setMessage('This original request has no confirmed terminal result. Keep its reference and check it again.'); revealObserved(signal, 'status', identity); return; }
    await settleMandateAuthorityReceipt(locator, result, scope, context(signal), selected.current ?? memory.original(locator)); assertCurrent(signal); memory.reload(); if (selected.current) memory.releaseSelection(selected.current); setOriginal(null); transition({ type: 'reset' }); revealObserved(signal, 'status', identity); onOutcome();
  }
  async function check() { await run('check', async signal => {
    try { const recorded = memory.recorded(locator), result = recorded ?? await lookupMandateAuthority(locator, scope, context(signal)); await settle(result, signal); }
    catch (error) { if (error instanceof RequestError && error.status === 404) { assertCurrent(signal); transition({ type: 'checked' }); setMessage('No result was found at this check. The original request may still finish. Only a separate review and same-key retry of retained exact input is available.'); revealObserved(signal, 'status', identity); } else throw error; }
  }); }
  async function openOriginal() { await run('review', async signal => {
    if (flowRef.current.phase !== 'checked' || memory.recorded(locator)) throw new RequestError('AUTHORITY_REVIEW_REQUIRED', 'Check this original result before reviewing a retry.');
    const available = memory.original(locator); if (!available) throw new RequestError('AUTHORITY_REVIEW_REQUIRED', 'The original input is no longer retained. This reference supports lookup only.');
    const value = await verifyAuthorityCapsule(available); assertCurrent(signal); if (memory.recorded(locator) || canonicalJson(locator) !== canonicalJson(locatorFromAuthorityCapsule(value))) throw new RequestError('AUTHORITY_REVIEW_REQUIRED', 'The original review or recorded result changed.');
    memory.select(value); setOriginal(value); transition({ type: 'review', hash: value.integrityHash }); revealObserved(signal, 'review', value.integrityHash);
  }); }
  async function retry() { await run('retry', async signal => {
    if (!original || flowRef.current.phase !== 'reviewed' || memory.recorded(locator)) throw new RequestError('AUTHORITY_REVIEW_REQUIRED', 'Review the retained exact original before a separate retry.');
    transition({ type: 'retry' }); const result = await sendMandateAuthority(original, context(signal), { kind: 'retry', currentFlow: () => flowRef.current }); await settle(result, signal);
  }); }
  if (memory.hidden) return null;
  const available = memory.original(locator), recorded = memory.recorded(locator), pending = memory.inventory.locators.some(value => canonicalJson(value) === identity), working = Boolean(busy) || memory.busy(locator);
  return <article className="mandate-authority-original" aria-label={`Original ${locator.kind === 'mandate.pause' ? 'pause' : locator.kind === 'mandate.revoke' ? 'revocation' : 'resume'} result`}>
    <div ref={statusTarget} tabIndex={-1} className="access-heading-focus">{receipt ? <MandateAuthorityReceiptView receipt={receipt}/> : <Alert title={recorded ? 'Authority transition recorded; local reference remains' : 'Check the original authority result'} tone={recorded ? 'blue' : 'amber'}><p>{working ? 'Waiting for this original request. Leaving does not cancel the recorded or pending operation.' : message}</p></Alert>}
      {pending && <><div className="actions"><button type="button" className="button secondary" disabled={working} onClick={() => void check()}><ActionLabel label={busy === 'check' ? 'Checking original result…' : recorded ? 'Finish recorded receipt' : 'Check original result'} reserve={['Checking original result…', 'Finish recorded receipt']}/></button>{available && flow.phase === 'checked' && !recorded && <button type="button" className="button secondary" disabled={working} onClick={() => void openOriginal()}><ActionLabel label={busy === 'review' ? 'Checking original input…' : 'Review original authority stop'} reserve={['Checking original input…']}/></button>}</div>{!available && <p className="review-note">The full original input is no longer retained. This reference supports lookup only; a missing result does not cancel it or permit a replacement request.</p>}{receipt && <p className="review-note">The historical receipt is verified, but its local reference still needs settlement. No repeat control will be sent.</p>}</>}
    </div><Disclosure title="Original authority request reference"><dl className="review-key-values"><div><dt>Action / original key</dt><dd>{locator.kind}<br/>{locator.key}</dd></div><div><dt>Accepted mandate</dt><dd>{locator.mandate.id} · version {locator.mandate.version}</dd></div><div><dt>Original / resulting head epoch</dt><dd>{locator.head.mandateEpoch} → {locator.expectedTarget.version}</dd></div></dl></Disclosure>
    <div ref={arrival}>{original && !recorded && <><div ref={reviewTarget} tabIndex={-1} className="access-heading-focus"><h3>Review the exact original authority stop</h3></div><MandateAuthorityReview capsule={original}/><footer className="form-footer"><p>This retry preserves the original reason, head, accepted version and key.</p><div className="actions"><button type="button" className="button secondary" disabled={working} onClick={() => { memory.releaseSelection(original); setOriginal(null); transition({ type: 'reset' }); reveal('status', identity); }}>Close original review</button><button type="button" className="button" disabled={working || flow.phase !== 'reviewed'} onClick={() => void retry()}><ActionLabel label={busy === 'retry' ? 'Retrying original stop…' : 'Retry original authority stop'} reserve={['Retrying original stop…']}/></button></div></footer></>}</div>
  </article>;
}
