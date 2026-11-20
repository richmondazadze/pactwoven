'use client';
import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { NativeTaskReplySchema, type NativeTask, type NativeTaskArtifact, type NativeTaskControl, type Session } from '@pactwoven/contracts';
import { RequestError } from '../lib/api';
import { executeNativeControl, nativeControlContext } from '../lib/native-task-control';
import { getNativeApiBase } from '../lib/config';
import {
  clearTaskAttempt, createTaskReplyAttempt, nativeAgentLabels, nativeStepPresentation, nativeTaskControlResponseSchema, nativeTaskError,
  nativeTaskLabels, nativeTaskListKey, nativeTaskQueryKey, nativeTaskTone, newerNativeTask, nativeTaskProgressAnnouncement,
  readTaskAttempt, sendTaskAttempt, storeTaskAttempt, taskAttemptScope,
  taskAttemptWasRejected, scopedNativeApiRequest, scopedNativeTaskSchema, previousTaskRequests, requireCurrentTaskConnection, type PreviousTaskRequest, type NativeTaskAttempt,
} from '../lib/native-tasks';
import { siteName } from '../lib/responsibilities';
import { useWorkspace } from './workspace-provider';
import { useNativeTask, useTaskLifetime } from './native-task-hooks';
import { Icon } from './icon';
import { Alert, LoadingState, StatusBadge } from './ui';
import { NativePreviousConnection } from './native-previous-connection';
import { NativeWorkContinuation } from './native-work-continuation';
import '../app/native-tasks.css';

function taskTime(value: string) {
  return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short' }).format(new Date(value));
}
export function NativeTaskText({ text }: { text: string }) {
  return <div className="native-task-text">{text.split(/\n{2,}/).map((block, index) => {
    const heading = /^#{1,3}\s+([^\n]+)$/.exec(block);
    if (heading) return <h3 key={index}>{heading[1]}</h3>;
    const lines = block.split('\n');
    if (lines.length > 0 && lines.every(line => /^[-*]\s+/.test(line))) return <ul key={index}>{lines.map((line, row) => <li key={row}>{line.replace(/^[-*]\s+/, '')}</li>)}</ul>;
    return <p key={index}>{block}</p>;
  })}</div>;
}
function NativeTaskDisclosure({ title, children, initiallyOpen = false, className = '' }: {
  title: React.ReactNode; children: React.ReactNode; initiallyOpen?: boolean; className?: string;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  return <details className={`native-task-disclosure ${className}`} open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{title}<Icon name="chevron-down" size={17} /></summary><div className="native-disclosure-body">{children}</div>
  </details>;
}
function ArtifactBody({ artifact }: { artifact: NativeTaskArtifact }) {
  return <><NativeTaskText text={artifact.text} />
    {artifact.sources.length > 0 && <div className="native-artifact-sources"><h4>Sources</h4><ul>{artifact.sources.map((source, index) => <li key={`${source.url}:${index}`}><a href={source.url} target="_blank" rel="noopener noreferrer">{source.title}<Icon name="link" size={14} /><span className="sr-only"> (opens in a new tab)</span></a></li>)}</ul></div>}
  </>;
}
function TaskArtifact({ artifact }: { artifact: NativeTaskArtifact }) {
  return <article className="native-artifact native-artifact-fold native-arriving"><NativeTaskDisclosure title={<span className="native-artifact-heading"><Icon name={artifact.kind === 'comparison' ? 'scales' : 'document-signature'} /><span><strong>{artifact.title}</strong><small>{artifact.kind === 'comparison' ? 'Comparison' : artifact.kind === 'plan' ? 'Plan' : artifact.kind === 'research' ? 'Research' : 'Report'}</small></span></span>}><ArtifactBody artifact={artifact} /></NativeTaskDisclosure></article>;
}
export function NativeTaskProgress({ task, observing }: { task: NativeTask; observing: boolean }) {
  const previous = useRef<NativeTask | undefined>(undefined);
  const [announcement, setAnnouncement] = useState({ text: '', version: 0 });
  useEffect(() => {
    if (!observing) return;
    const text = nativeTaskProgressAnnouncement(previous.current, task);
    if (!previous.current || task.version > previous.current.version) previous.current = task;
    if (text) setAnnouncement({ text, version: task.version });
  }, [task, observing]);
  return <p className="sr-only" role="status" aria-live="polite" aria-atomic="true"><span key={announcement.version}>{announcement.text}</span></p>;
}
export function NativeTaskContent({ task, session }: { task: NativeTask; session: Session }) {
  const roles = [...new Set(task.steps.map(step => step.agent))];
  const completed = task.status === 'completed';
  const primaryResult = completed ? task.artifacts.findLast(artifact => artifact.kind === 'report') ?? task.artifacts.at(-1) : undefined;
  const supporting = task.artifacts.filter(artifact => artifact.id !== primaryResult?.id);
  return <div className="native-task-content-grid">
    <div className="native-task-primary">
      {primaryResult && <section key="recommendation" className="native-task-section native-final-result" aria-labelledby="native-recommendation-heading"><div className="native-panel-heading"><div><h2 id="native-recommendation-heading">{primaryResult.kind === 'report' ? 'Your recommendation' : 'Your result'}</h2><p>The outcome, its limits, and the sources behind it.</p></div><Icon name="circle-check" size={20} /></div><div className="native-final-body"><ArtifactBody artifact={primaryResult} /></div></section>}
      <section key="conversation" className="native-task-section native-conversation-section" aria-label="Conversation"><NativeTaskDisclosure className="native-section-disclosure" initiallyOpen={!primaryResult} title={<h2>Conversation<span>Your instructions and the team’s responses.</span></h2>}>
        <div className="native-conversation">{task.messages.length === 0 ? <article className="native-message user"><strong>You</strong><NativeTaskText text={task.prompt} /></article> : task.messages.map(message => <article key={message.id} className={`native-message native-arriving ${message.role}`}><div className="native-message-byline"><strong>{message.role === 'user' ? 'You' : 'Pactwoven'}</strong><time dateTime={message.createdAt}>{taskTime(message.createdAt)}</time></div><NativeTaskText text={message.text} /></article>)}</div>
      </NativeTaskDisclosure></section>
      {supporting.length > 0 && <section key="supporting" className="native-task-section native-results" aria-labelledby="native-results-heading"><div className="native-panel-heading"><div><h2 id="native-results-heading">{primaryResult ? 'Supporting work' : 'Results so far'}</h2><p>Open a saved document to inspect the detail.</p></div><Icon name="folder" size={20} /></div><div className="native-artifacts">{supporting.map(artifact => <TaskArtifact key={artifact.id} artifact={artifact} />)}</div></section>}
    </div>
    <aside className="native-task-aside" aria-label="Task progress and activity">
      <section className="native-plan"><div className="native-aside-heading"><h2>The plan</h2><Icon name="split-route" size={18} /></div>{task.steps.length === 0 ? <p className="native-aside-empty">{task.status === 'queued' ? 'Your task is saved. The plan will appear when work begins.' : 'There are no recorded plan steps yet.'}</p> : <ol className="native-plan-steps">{task.steps.map(step => <li key={step.id} data-state={nativeStepPresentation(task.status, step).state}><span className="native-step-marker"><Icon name={step.status === 'completed' ? 'circle-check' : step.status === 'failed' ? 'circle-x' : step.status === 'waiting' ? 'clock' : 'circle-half'} size={18} /></span><div><h3>{step.title}</h3><span>{nativeAgentLabels[step.agent]} · {nativeStepPresentation(task.status, step).label}</span>{step.summary && <NativeTaskDisclosure className="native-note-disclosure" title="Step notes"><p>{step.summary}</p></NativeTaskDisclosure>}</div></li>)}</ol>}</section>
      {roles.length > 0 && <section className="native-team"><div className="native-aside-heading"><h2>Working together</h2><Icon name="connected-nodes" size={18} /></div><ul>{roles.map(role => { const steps = task.steps.filter(step => step.agent === role); const active = steps.some(step => nativeStepPresentation(task.status, step).active); return <li key={role} data-active={active}><span className="native-agent-mark"><Icon name={role === 'research' ? 'search' : role === 'planning' ? 'split-route' : role === 'evidence' ? 'document-signature' : role === 'supplier' ? 'package' : 'connected-nodes'} size={17} /></span><span>{nativeAgentLabels[role]}</span><small>{active ? 'Working' : steps.every(step => step.status === 'completed') ? 'Done' : steps.some(step => step.status === 'failed') ? 'Needs attention' : task.status === 'paused' ? 'Paused' : task.status === 'cancelled' ? 'Stopped' : 'Waiting'}</small></li>; })}</ul></section>}
      <section className="native-activity"><NativeTaskDisclosure className="native-activity-disclosure" initiallyOpen={!completed} title={<h2>Activity</h2>}>{task.events.length === 0 ? <p className="native-aside-empty">Updates will appear as work is recorded.</p> : <ol>{[...task.events].reverse().map(event => <li key={event.sequence}><strong>{event.title}</strong><time dateTime={event.createdAt}>{taskTime(event.createdAt)}</time>{event.detail && <NativeTaskDisclosure className="native-note-disclosure" title="Details"><p>{event.detail}</p></NativeTaskDisclosure>}</li>)}</ol>}</NativeTaskDisclosure></section>
      <div className="native-task-context"><Icon name="map-pin" size={16} /><span>{siteName(session, task.siteId)}</span><span>Research & advice</span></div>
    </aside>
  </div>;
}

export function NativeTaskWorkspace({ id }: { id: string }) {
  const base = getNativeApiBase();
  if (!base) return <section className="native-task-workspace"><Alert title="The work service is not connected" tone="blue"><p>Your saved requests remain in this tab. Try again after the service connection is restored.</p></Alert></section>;
  return <NativeWorkContinuation key={`${base}:${id}`} id={id}><ConnectedNativeTaskWorkspace id={id}/></NativeWorkContinuation>;
}
function ConnectedNativeTaskWorkspace({ id }: { id: string }) {
  const { session, getToken } = useWorkspace();
  const query = useNativeTask(id);
  const client = useQueryClient();
  const task = query.data?.task;
  const [reply, setReply] = useState('');
  const [replyFocused, setReplyFocused] = useState(false);
  const [pendingReply, setPendingReply] = useState<NativeTaskAttempt | null>(null);
  const pending = useRef<NativeTaskAttempt | null>(null);
  const [ready, setReady] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [previousRequests, setPreviousRequests] = useState<PreviousTaskRequest[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const inFlight = useRef(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const [controlUnknown, setControlUnknown] = useState(false);
  const [controlFeedback, setControlFeedback] = useState('');
  const { live, controller } = useTaskLifetime();
  const scope = taskAttemptScope(session);
  const currentScope = useRef(scope); currentScope.current = scope;
  const controlContext = nativeControlContext(session);
  const currentControl = useRef({ context: controlContext, observing: query.observing, error: query.error, task });
  currentControl.current = { context: controlContext, observing: query.observing, error: query.error, task };
  const replyId = useId();

  useEffect(() => {
    try {
      setPreviousRequests(previousTaskRequests(window.sessionStorage, scope, id));
      const saved = readTaskAttempt(window.sessionStorage, scope, id);
      pending.current = saved; setPendingReply(saved);
      if (saved?.kind === 'reply') setReply(saved.input.text);
    } catch (failure) { setError(failure); setBlocked(true); }
    setReady(true);
  }, [id]);
  function accept(response: NonNullable<typeof query.data>) {
    const saved = client.setQueryData<typeof response>(nativeTaskQueryKey(session, id), previous => ({ ...response, task: newerNativeTask(previous?.task, response.task) }));
    void client.invalidateQueries({ queryKey: nativeTaskListKey(session) });
    return saved?.task ?? response.task;
  }
  async function refresh() {
    const result = await query.refetch();
    if (!result.error && result.data) { setControlUnknown(false); setControlFeedback(''); setNotice('Task refreshed. Showing its latest confirmed state.'); if (!pending.current) setError(null); }
  }
  async function control(action: NativeTaskControl['action']) {
    if (!task || inFlight.current || controlUnknown || query.error || !query.observing || !task.availableActions.includes(action)) return;
    inFlight.current = true; setBusy(action); setError(null); setNotice(''); setControlFeedback('');
    controller.current = new AbortController();
    const signal = AbortSignal.any([controller.current.signal, AbortSignal.timeout(25_000)]);
    const assertCurrent = () => {
      signal.throwIfAborted();
      if (!live.current || currentControl.current.context !== controlContext || !currentControl.current.observing || currentControl.current.error) {
        throw new RequestError('SCOPE_CHANGED', 'The current task connection changed.');
      }
    };
    try {
      const result = await executeNativeControl({ action, task, assertCurrent,
        send: (command, beforeDispatch) => scopedNativeApiRequest(`/v1/tasks/${encodeURIComponent(id)}/control`, nativeTaskControlResponseSchema(session, id, command), session, getToken, {
          signal, body: command, currentScope: () => currentScope.current, beforeDispatch: () => {
            // A newer poll may have arrived while the token was being obtained.
            if ((currentControl.current.task?.version ?? 0) > command.expectedVersion) throw new RequestError('TASK_CHANGED', 'The task changed before dispatch.', 409);
            beforeDispatch();
          },
        }),
        read: () => scopedNativeApiRequest(`/v1/tasks/${encodeURIComponent(id)}`, scopedNativeTaskSchema(session, id), session, getToken, {
          signal, currentScope: () => currentScope.current, beforeDispatch: () => { assertCurrent(); },
        }),
      });
      if (!live.current || currentControl.current.context !== controlContext) return;
      if (result.kind !== 'confirmed') {
        if (result.latest) accept(result.latest);
        setError(result.error); setControlUnknown(result.kind === 'unknown');
        if (result.kind === 'rejected') setControlFeedback(result.error instanceof RequestError && result.error.status === 409
          ? `The action was not applied. ${result.latest ? 'The latest task state is shown. Review it before trying again.' : 'Refresh the task before trying again.'}`
          : `The action was not applied. ${nativeTaskError(result.error)}`);
        return;
      }
      const shown = accept(result.response);
      if (shown.status !== result.response.task.status) {
        setNotice('The action was confirmed. This task has since changed; its latest state is shown.');
        return;
      }
      setNotice(action === 'pause' ? 'Pause confirmed. You can resume when you are ready.' : action === 'resume' ? 'Resume confirmed. Work can continue.' : 'Cancellation confirmed. The saved conversation and results remain available.');
    } catch (failure) { if (live.current) setError(failure); }
    finally { inFlight.current = false; if (live.current) setBusy(null); }
  }
  async function sendReply(recover = false) {
    if (!task || inFlight.current || blocked || !ready || controlUnknown || Boolean(query.error) || !query.observing || (!recover && (pending.current || previousRequests.length > 0 || !task.availableActions.includes('message')))) return;
    const parsed = NativeTaskReplySchema.safeParse({ text: reply, expectedVersion: task.version });
    if (!recover && !parsed.success) return;
    inFlight.current = true; setBusy('message'); setError(null); setNotice(''); setControlFeedback('');
    let dispatched = false;
    try {
      if (!recover) requireCurrentTaskConnection(window.sessionStorage, scope, id);
      const request = recover ? pending.current : createTaskReplyAttempt(scope, id, parsed.data!);
      if (!request || request.kind !== 'reply') return;
      storeTaskAttempt(window.sessionStorage, request);
      pending.current = request; setPendingReply(request);
      controller.current = new AbortController();
      const response = await sendTaskAttempt(request, session, getToken, { signal: controller.current.signal,
        currentScope: () => currentScope.current, beforeDispatch: () => { dispatched = true; } });
      if (!live.current) return;
      clearTaskAttempt(window.sessionStorage, request);
      pending.current = null; setPendingReply(null); setReply(''); accept(response); setNotice('Your message is saved.');
    } catch (failure) {
      if (!live.current) return;
      if (pending.current && ((!dispatched && !recover) || taskAttemptWasRejected(failure, recover))) { try { clearTaskAttempt(window.sessionStorage, pending.current); pending.current = null; setPendingReply(null); } catch { /* Preserve recovery when local storage fails. */ } }
      setError(failure);
      if (taskAttemptWasRejected(failure, recover)) void query.refetch();
    } finally { inFlight.current = false; if (live.current) setBusy(null); }
  }

  if (!task) return <div className="native-task-workspace"><Link className="native-text-link" href="/app/work"><Icon name="arrow-left" size={16} />Back to work</Link>{query.error ? <Alert title="This work could not be opened" tone="red"><p>{nativeTaskError(query.error)}</p><button type="button" className="button secondary" disabled={query.isFetching || !query.observing} onClick={() => void refresh()}>Check again</button></Alert> : <LoadingState label={query.observing ? 'Opening your work' : 'Waiting for a connection'} />}<NativePreviousConnection requests={previousRequests} /></div>;
  const available = task.availableActions;
  const disabled = busy !== null || Boolean(query.error) || !query.observing || controlUnknown;
  return <div className="native-task-workspace">
    <NativeTaskProgress task={task} observing={query.observing && !query.error} />
    <Link className="native-text-link native-back" href="/app/work"><Icon name="arrow-left" size={16} />All work</Link>
    <header className="native-task-heading"><div><div className="native-task-status"><StatusBadge tone={nativeTaskTone(task.status)}>{nativeTaskLabels[task.status]}</StatusBadge><span>{query.error || !query.observing ? 'Last confirmed state' : 'Updates automatically'}</span></div><h1>{task.title}</h1><p>{task.phase}</p></div><div className="native-task-actions">{available.includes('message') && <button type="button" className="button secondary" onClick={() => document.getElementById(replyId)?.focus()}>Update instructions</button>}{available.includes('pause') && <button type="button" className="button secondary" disabled={disabled} onClick={() => void control('pause')}><Icon name="pause-circle" size={17} />{busy === 'pause' ? 'Pausing…' : 'Pause'}</button>}{available.includes('resume') && <button type="button" className="button" disabled={disabled} onClick={() => void control('resume')}><Icon name="return-arrow" size={17} />{busy === 'resume' ? 'Resuming…' : task.status === 'failed' ? 'Retry work' : 'Resume'}</button>}{available.includes('cancel') && <button type="button" className="button secondary" disabled={disabled} onClick={() => void control('cancel')}>{busy === 'cancel' ? 'Cancelling…' : 'Cancel task'}</button>}</div></header>
    {(query.error || !query.observing) && <Alert title="Live updates are paused" tone="amber"><p>{query.error ? nativeTaskError(query.error) : 'Updates will resume when this tab is visible and connected. Background work follows its current instructions.'}</p><button type="button" className="button secondary" disabled={query.isFetching || !query.observing} onClick={() => void refresh()}>Refresh task</button></Alert>}
    {error !== null && <Alert title={controlUnknown ? 'The action needs confirmation' : 'Your last request needs attention'} tone="red"><p>{controlFeedback || nativeTaskError(error, Boolean(pendingReply) || controlUnknown)}</p>{(controlUnknown || controlFeedback) && <button type="button" className="button secondary" disabled={query.isFetching || !query.observing} onClick={() => void refresh()}>Refresh task status</button>}</Alert>}
    <p className="native-action-notice" role="status" aria-live="polite">{notice}</p>
    <NativePreviousConnection requests={previousRequests} />
    {(available.includes('message') || pendingReply || reply.length > 0 || replyFocused) && <section className="native-reply"><h2>{task.status === 'paused' ? 'Update instructions while paused' : task.status === 'waiting_for_input' ? 'What the team needs from you' : 'Add context or steer the work'}</h2><p>{available.includes('message') ? task.status === 'paused' ? 'Your update will be saved with this task. Work stays paused until you resume.' : 'Keep new details and changes with the original task.' : 'This task is no longer accepting new messages. Your unsent text stays here so you can review or copy it.'}</p>{['paused', 'waiting_for_input'].includes(task.status) && task.messages.findLast(message => message.role === 'assistant') && <NativeTaskDisclosure title="Review the team’s latest message"><NativeTaskText text={task.messages.findLast(message => message.role === 'assistant')!.text} /></NativeTaskDisclosure>}<form onSubmit={event => { event.preventDefault(); void sendReply(); }}><label className="sr-only" htmlFor={replyId}>Your message</label><textarea id={replyId} rows={3} maxLength={12_000} required value={reply} readOnly={Boolean(pendingReply)} disabled={!ready || blocked || previousRequests.length > 0} placeholder="Add a requirement, answer a question, or clarify the outcome…" onFocus={() => setReplyFocused(true)} onBlur={() => setReplyFocused(false)} onChange={event => setReply(event.target.value)} /><div><span>Saved to this task’s conversation</span><button type="submit" className="button" disabled={disabled || !available.includes('message') || !ready || blocked || previousRequests.length > 0 || Boolean(pendingReply) || reply.trim().length === 0}>{busy === 'message' ? 'Saving…' : 'Send message'}<Icon name="arrow-right" size={17} /></button></div></form>{pendingReply && !busy && <Alert title="Your original message is retained" tone="blue"><p>Check the same saved request to confirm whether the message was recorded.</p><button type="button" className="button secondary" disabled={blocked || !ready || disabled} onClick={() => void sendReply(true)}>Check saved reply</button></Alert>}</section>}
    <NativeTaskContent task={task} session={session} />
  </div>;
}
