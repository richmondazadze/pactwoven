'use client';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { canonicalJson } from '@pactwoven/contracts/canonical';
import { MandateProposalContent } from './mandate-proposal-review';
import { getApiBase } from '../lib/config';
import { useMandateClock } from './mandate-read-shared';
import { RequestError } from '../lib/api';
import { verifyAuthoringCapsule, type MandateAuthoringCapsule } from '../lib/mandate-authoring';
import { authoringRetryFlow, initialAuthoringRetry, lookupAuthoringAttempt, readAuthoringReceipt, sendAuthoringAttempt, type AuthoringCompletion, type AuthoringRetryFlow, type AuthoringTransportContext } from '../lib/mandate-authoring-transport';
import { mandateOperationSucceeded } from '../lib/mandate-actions';
import type { AuthoringLocator } from '../lib/mandate-authoring-recovery';
import type { MandateReadScope } from '../lib/mandates';
import { MandateAuthoringReview, MandateSavedDocument } from './mandate-authoring-review';
import { useMandateAuthoringMemory } from './mandate-authoring-memory';
import { ActionLabel, Alert, Disclosure } from './ui';
import { useArrival } from './motion';

export function MandateAuthoringRecoveryPanel({ locator, scope, context, externalBusy, onComplete, onError }: { locator: AuthoringLocator; scope: MandateReadScope; context: (signal: AbortSignal) => AuthoringTransportContext; externalBusy: boolean; onComplete: (value: AuthoringCompletion) => void; onError: (error: unknown) => void }) {
  const memory = useMandateAuthoringMemory(), [flow, setFlow] = useState<AuthoringRetryFlow>(initialAuthoringRetry), currentFlow = useRef(flow), [original, setOriginal] = useState<MandateAuthoringCapsule | null>(null), [busy, setBusy] = useState(false), [message, setMessage] = useState('This original request needs its result checked. Reading never sends a replacement.');
  const running = useRef(false), mounted = useRef(false), controller = useRef<AbortController | null>(null), focus = useRef<HTMLDivElement>(null), reviewFocus = useRef<HTMLDivElement>(null), arrival = useArrival(original?.integrityHash, 120);
  useLayoutEffect(() => { mounted.current = true; focus.current?.focus({ preventScroll: true }); return () => { mounted.current = false; controller.current?.abort(); }; }, []);
  useLayoutEffect(() => { if (original) reviewFocus.current?.focus({ preventScroll: true }); }, [original?.integrityHash]);
  const available = memory.ready && !memory.hidden ? memory.original(locator) : null, recorded = memory.ready && !memory.hidden ? memory.recorded(locator) : null, qualified = memory.ready && !memory.hidden ? memory.qualified(locator) : null;
  const qualifiedObservation = useMemo(() => qualified && 'envelope' in qualified.record ? { data: qualified.record, receivedAt: Date.now(), receivedMonotonic: performance.now() } : undefined, [qualified]);
  const currentTime = useMandateClock(qualifiedObservation);
  function transition(event: Parameters<typeof authoringRetryFlow>[1]) { const value = authoringRetryFlow(currentFlow.current, event); currentFlow.current = value; setFlow(value); return value; }
  async function run(action: (signal: AbortSignal) => Promise<void>, focusResult = true) {
    if (running.current || externalBusy) return; running.current = true; setBusy(true); const request = new AbortController(); controller.current = request;
    let failed = false;
    try { await action(request.signal); }
    catch (error) { failed = true; if (mounted.current && !request.signal.aborted) { transition({ type: 'reset' }); setOriginal(null); setMessage(error instanceof RequestError ? error.message : 'The exact result could not be confirmed. Keep the original reference and check it again.'); onError(error); } }
    finally { running.current = false; try { memory.reload(); } catch { /* Denied memory stays hidden. */ } if (mounted.current) { setBusy(false); if (focusResult || failed) focus.current?.focus({ preventScroll: true }); } }
  }
  function check() { void run(async signal => {
    transition({ type: 'reset' }); setOriginal(null); const c = context(signal); let result;
    try { result = memory.recorded(locator) ?? await lookupAuthoringAttempt(locator, scope, c); }
    catch (error) { if (error instanceof RequestError && error.status === 404 && !memory.recorded(locator)) { signal.throwIfAborted(); if (getApiBase() !== scope.apiBase || canonicalJson(c.current()) !== canonicalJson(scope)) throw new RequestError('MANDATE_SCOPE_CHANGED', 'The original scope changed while checking.', 403); setMessage('No original result was returned. The request may still finish. Only its retained exact input can be reviewed for an original-key retry.'); transition({ type: 'checked' }); return; } throw error; }
    signal.throwIfAborted(); if (getApiBase() !== scope.apiBase || canonicalJson(c.current()) !== canonicalJson(scope)) throw new RequestError('MANDATE_SCOPE_CHANGED', 'The original preparation scope changed.', 403);
    if (mandateOperationSucceeded(result)) { onComplete(await readAuthoringReceipt(locator, result, scope, c, available)); return; }
    setMessage(`The service reports ${result.operation.status}. This original request remains unresolved. No replacement is permitted.`); transition({ type: 'checked' });
  }); }
  function reviewOriginal() { if (!available || recorded || currentFlow.current.phase !== 'checked') return; void run(async signal => { const value = await verifyAuthoringCapsule(available); signal.throwIfAborted(); memory.select(value); setOriginal(value); transition({ type: 'review', hash: value.integrityHash }); }, false); }
  function retry() { if (!original || recorded || currentFlow.current.phase !== 'reviewed') return; void run(async signal => { memory.select(original); transition({ type: 'retry' }); const c = context(signal), result = await sendAuthoringAttempt(original, c, { kind: 'retry', currentFlow: () => currentFlow.current }); if (mandateOperationSucceeded(result)) onComplete(await readAuthoringReceipt(locator, result, scope, c, original)); else { transition({ type: 'reset' }); setOriginal(null); setMessage('This retry has no confirmed terminal result. Check the original result again.'); } }); }
  if (memory.hidden) return null;
  return <section id="mandate-authoring-recovery" className="mandate-authoring-recovery" aria-label="Original mandate preparation recovery"><div ref={focus} tabIndex={-1} className="access-heading-focus"><Alert title={qualified ? 'Saved record verified; local progress needs checking' : recorded ? 'Operation recorded; exact saved record needs checking' : 'Check the original preparation result'} tone={recorded ? 'blue' : 'amber'}><p>{externalBusy || busy ? 'Checking this original request. Leaving the page stops observation; it does not cancel a durable operation.' : message}</p>{recorded && <p>The service recorded this {locator.step === 'proposal' ? 'proposal' : 'document save'}. It will not be sent again. Its exact saved record and local progress must both be checked before continuing.</p>}<div className="actions"><button className="button secondary" type="button" disabled={busy || externalBusy} onClick={check}><ActionLabel label={busy ? 'Checking original result…' : qualified ? 'Check saved record and progress' : recorded ? 'Read recorded result' : 'Check original result'} reserve={['Check saved record and progress', 'Checking original result…']}/></button>{available && !recorded && flow.phase === 'checked' && <button className="button secondary" type="button" disabled={busy || externalBusy} onClick={reviewOriginal}>Review retained original input</button>}</div>{!available && <p className="review-note">The original private input is no longer available in this session. This reference supports lookup only. A missing result does not cancel it or permit another request key.</p>}</Alert></div>
    {qualified && ('document' in qualified.record ? <MandateSavedDocument value={qualified.record}/> : <MandateProposalContent review={qualified.record} now={currentTime} organizationEpoch={scope.organizationEpoch} sites={[qualified.record.envelope.site]}/>)}
    <div ref={arrival}>{original && !recorded && <><div ref={reviewFocus} tabIndex={-1} className="access-heading-focus"><h3>Exact original input for retry</h3></div><MandateAuthoringReview capsule={original}/><p className="review-note">This retries the unchanged original command with its original key. It does not update the saved basis, documents or deadlines.</p><button className="button" type="button" disabled={busy || externalBusy || flow.phase !== 'reviewed'} onClick={retry}><ActionLabel label={busy ? 'Retrying original request…' : 'Retry exact original request'} reserve={['Retry exact original request', 'Retrying original request…']}/></button></>}</div>
    <Disclosure title="Original request reference"><dl className="review-key-values"><div><dt>Original step</dt><dd>{locator.step}</dd></div><div><dt>Request / preparation</dt><dd>{locator.key}<br/>{locator.preparationId}</dd></div><div><dt>Original target</dt><dd>{locator.target.id} · {locator.step === 'proposal' ? 'proposal' : 'document'} version {locator.target.version}</dd></div><div><dt>Original saved basis</dt><dd>Responsibility version {locator.basis.responsibility.version}; organization epoch {locator.basis.organizationEpoch}<br/><code>{locator.commandHash}</code></dd></div></dl></Disclosure>
  </section>;
}
