'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { CreateNativeTaskSchema } from '@pactwoven/contracts';
import {
  canStartNativeTask, clearTaskAttempt, createTaskAttempt, nativeTaskError, nativeTaskListKey,
  nativeTaskPath, nativeTaskQueryKey, readTaskAttempt, sendTaskAttempt, storeTaskAttempt,
  taskAttemptScope, taskAttemptWasRejected, previousTaskRequests, requireCurrentTaskConnection, type PreviousTaskRequest, type NativeTaskAttempt,
} from '../lib/native-tasks';
import { RequestError } from '../lib/api';
import { getNativeApiBase } from '../lib/config';
import { useWorkspace } from './workspace-provider';
import { useTaskLifetime } from './native-task-hooks';
import { Icon } from './icon';
import { Alert } from './ui';
import { NativePreviousConnection } from './native-previous-connection';
import '../app/native-tasks.css';

const suggestions = [
  { title: 'Compare options', prompt: 'Compare the options in these sources and recommend the best fit for my requirements:\n\n' },
  { title: 'Plan an outcome', prompt: 'Help me make a practical plan for this outcome, including dependencies and open questions:\n\n' },
  { title: 'Review evidence', prompt: 'Review this information, identify what is supported, and list what still needs verifying:\n\n' },
];
export function NativeTaskComposer({ compact = false }: { compact?: boolean }) {
  const base = getNativeApiBase();
  if (!base) return <section className="native-composer"><Alert title="The work service is not connected" tone="blue"><p>Your saved requests remain in this tab. Try again after the service connection is restored. Your existing work records are still available.</p></Alert></section>;
  return <ConnectedNativeTaskComposer key={base} compact={compact} />;
}
function ConnectedNativeTaskComposer({ compact }: { compact: boolean }) {
  const { session, getToken, drafts } = useWorkspace();
  const router = useRouter();
  const client = useQueryClient();
  const sites = session.sites.filter(site => session.actor.actionSiteIds.includes(site.id));
  const [prompt, setPrompt] = useState(() => typeof drafts.get('native-task-prompt') === 'string' ? drafts.get('native-task-prompt') as string : '');
  const [siteId, setSiteId] = useState(sites[0]?.id ?? '');
  const [attempt, setAttempt] = useState<NativeTaskAttempt | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [blocked, setBlocked] = useState(false);
  const [previousRequests, setPreviousRequests] = useState<PreviousTaskRequest[]>([]);
  const pending = useRef<NativeTaskAttempt | null>(null);
  const sending = useRef(false);
  const { live, controller } = useTaskLifetime();
  const scope = taskAttemptScope(session);
  const currentScope = useRef(scope); currentScope.current = scope;
  const inputId = useId();
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    try {
      setPreviousRequests(previousTaskRequests(window.sessionStorage, scope));
      const saved = readTaskAttempt(window.sessionStorage, scope);
      pending.current = saved; setAttempt(saved);
      if (saved?.kind === 'create') { setPrompt(saved.input.prompt); setSiteId(saved.input.siteId); }
    } catch (failure) { setError(failure); setBlocked(true); }
    setReady(true);
  }, []);

  async function submit(recover = false) {
    if (sending.current || blocked || !ready || (!recover && (pending.current || previousRequests.length > 0))) return;
    const parsed = CreateNativeTaskSchema.safeParse({ prompt, siteId, mode: 'advise' });
    if (!recover && !parsed.success) { setError(new RequestError('VALIDATION_FAILED', 'Describe your outcome and choose a site.', 422)); input.current?.focus(); return; }
    sending.current = true; setBusy(true); setError(null);
    let dispatched = false;
    try {
      if (!recover) requireCurrentTaskConnection(window.sessionStorage, scope);
      const request = recover ? pending.current : createTaskAttempt(scope, parsed.data!);
      if (!request || request.kind !== 'create') return;
      // Persist the exact original payload before any network effect.
      storeTaskAttempt(window.sessionStorage, request);
      pending.current = request; setAttempt(request);
      controller.current = new AbortController();
      const response = await sendTaskAttempt(request, session, getToken, {
        signal: controller.current.signal, currentScope: () => currentScope.current,
        beforeDispatch: () => { dispatched = true; },
      });
      if (!live.current) return;
      clearTaskAttempt(window.sessionStorage, request);
      pending.current = null; setAttempt(null); drafts.delete('native-task-prompt');
      client.setQueryData(nativeTaskQueryKey(session, response.task.id), response);
      void client.invalidateQueries({ queryKey: nativeTaskListKey(session) });
      router.push(nativeTaskPath(response.task.id));
    } catch (failure) {
      if (!live.current) return;
      // A token or browser failure before dispatch cannot create a task.
      if (pending.current && ((!dispatched && !recover) || taskAttemptWasRejected(failure, recover))) {
        try { clearTaskAttempt(window.sessionStorage, pending.current); pending.current = null; setAttempt(null); } catch { /* Keep the recoverable request if storage cannot be updated. */ }
      }
      setError(failure);
    } finally { sending.current = false; if (live.current) setBusy(false); }
  }

  if (!canStartNativeTask(session)) return <section className="native-composer"><h2>Follow your work in one place.</h2><p>Your current access allows you to review work. Starting a new task needs permission for an assigned site.</p></section>;
  return <section className={`native-composer ${compact ? 'compact' : ''}`} aria-labelledby={`${inputId}-heading`}>
    <div className="native-composer-heading"><span className="native-fold"><img src="/brand/symbol-small.svg" alt="" width="26" height="26" /></span><div><h2 id={`${inputId}-heading`}>{compact ? 'Start something new' : 'What would you like to get done?'}</h2><p>Bring an outcome, a question, or information to work through.</p></div></div>
    <form onSubmit={event => { event.preventDefault(); void submit(); }}>
      <label htmlFor={inputId} className="sr-only">Describe your outcome</label>
      <textarea id={inputId} ref={input} value={prompt} maxLength={12_000} rows={compact ? 3 : 4} required readOnly={Boolean(attempt)} disabled={!ready || blocked || previousRequests.length > 0}
        placeholder="Describe the outcome, what matters, and any sources you want reviewed…"
        aria-describedby={`${inputId}-mode`}
        onChange={event => { setPrompt(event.target.value); drafts.set('native-task-prompt', event.target.value); }} />
      <div className="native-composer-footer">
        <div className="native-composer-context">{sites.length > 1 ? <label><Icon name="map-pin" size={16} /><span className="sr-only">Site for this work</span><select value={siteId} disabled={Boolean(attempt) || busy || !ready || previousRequests.length > 0} onChange={event => setSiteId(event.target.value)}>{sites.map(site => <option key={site.id} value={site.id}>{site.name}</option>)}</select></label> : <span><Icon name="map-pin" size={16} />{sites[0]?.name ?? 'Assigned site'}</span>}<span className="native-advice-label"><Icon name="clipboard" size={15} />Research & advice</span></div>
        <button className="button native-start" type="submit" disabled={busy || !ready || blocked || previousRequests.length > 0 || Boolean(attempt) || prompt.trim().length === 0} aria-busy={busy}>{busy ? 'Starting…' : 'Start work'}<Icon name="arrow-right" size={18} /></button>
      </div>
    </form>
    <p id={`${inputId}-mode`} className="native-mode-note">This task prepares advice. It does not contact suppliers, place orders, or move money. Include sources for claims that need verification.</p>
    <NativePreviousConnection requests={previousRequests} />
    {attempt && !busy && <Alert title="A saved request needs confirmation" tone="blue"><p>Your original details are retained in this tab. Check the same request to recover the task.</p><button type="button" className="button secondary" disabled={busy} onClick={() => void submit(true)}>Check saved task</button></Alert>}
    {error !== null && <Alert title={attempt ? 'Task not yet confirmed' : 'Unable to start work'} tone="red"><p>{nativeTaskError(error, Boolean(attempt))}</p>{blocked && <Link className="native-text-link" href="/app/work">Review your work<Icon name="arrow-right" size={16} /></Link>}</Alert>}
    {!compact && !attempt && <div className="native-suggestions" aria-label="Starting points">{suggestions.map(suggestion => <button key={suggestion.title} type="button" disabled={busy || blocked || !ready || previousRequests.length > 0} onClick={() => { setPrompt(suggestion.prompt); drafts.set('native-task-prompt', suggestion.prompt); input.current?.focus(); }}>{suggestion.title}<Icon name="plus" size={15} /></button>)}</div>}
  </section>;
}
