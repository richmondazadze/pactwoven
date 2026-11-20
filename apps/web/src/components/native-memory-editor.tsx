'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { NativeMemoryNoteCommandSchema, type NativeMemoryNoteDetail, type NativeMemoryNoteOperation } from '@pactwoven/contracts';
import { RequestError } from '../lib/api';
import { getNativeApiBase } from '../lib/config';
import {
  canWriteMemory, clearMemoryAttempt, createMemoryAttempt, draftFromNote, memoryAttemptRejected, memoryError, memoryIdentity,
  memoryKey, memoryPath, memoryReadDenied, memoryReviewDateIsFuture, memoryStatusLabels, operationMessage, previousMemoryConnection, readableMemorySites,
  readMemoryAttempt, recoverMemoryAttempt, sendMemoryAttempt, storeMemoryAttempt, type MemoryAttempt, type MemoryDraft,
} from '../lib/native-memory';
import { useMemoryBinding, useMemoryNote } from './native-memory-hooks';
import { useWorkspace } from './workspace-provider';
import { Alert, LoadingState, PageHeading, StatusBadge } from './ui';
import { Icon } from './icon';
import '../app/native-memory.css';

const blankDraft = (): MemoryDraft => ({ title: '', text: '', purpose: '', reviewBy: '' });
// A local datetime control is presentation only. Keep the exact original instant
// until the user changes that control; do not silently truncate seconds on edits.
export function localMemoryDate(instant: string) {
  if (!instant) return '';
  const date = new Date(instant);
  if (!Number.isFinite(date.getTime())) return '';
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
export function MemoryProvenance({ note }: { note: NativeMemoryNoteDetail }) {
  return <aside className="memory-provenance" aria-label="Note source"><StatusBadge tone={note.status === 'available' ? 'green' : note.status === 'needs_review' ? 'amber' : 'neutral'}>{memoryStatusLabels[note.status]}</StatusBadge><p><strong>{note.sourceLabel}</strong></p><p>Supplied by {note.suppliedBy}</p><p>{note.siteName} · {note.usageLabel}</p>{note.reviewBy && <p>Review by <time dateTime={note.reviewBy}>{new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(note.reviewBy))}</time></p>}<p>Removing this note stops future use. Prior records remain.</p></aside>;
}
export function NativeMemoryEditor({ siteId, id }: { siteId: string; id?: string | undefined }) {
  const { session } = useWorkspace();
  if (!getNativeApiBase()) return <Alert title="Memory is not connected" tone="blue"><p>Saved memory is not connected yet.</p></Alert>;
  if (!readableMemorySites(session).some(site => site.id === siteId)) return <Alert title="This site is outside your access" tone="red"><p>Choose an accessible site from Memory.</p><Link href="/app/memory" className="button secondary">Open memory</Link></Alert>;
  return <MemoryEditor key={`${memoryIdentity(session, siteId)}:${id ?? 'new'}`} siteId={siteId} id={id}/>;
}
function MemoryEditor({ siteId, id }: { siteId: string; id?: string | undefined }) {
  const binding = useMemoryBinding(siteId);
  const query = useMemoryNote(siteId, id);
  const client = useQueryClient();
  const router = useRouter();
  const [draft, setDraft] = useState<MemoryDraft>(blankDraft);
  const [expected, setExpected] = useState<string | null>(null);
  const initialized = useRef(false);
  const [attempt, setAttempt] = useState<MemoryAttempt | null>(null);
  const pending = useRef<MemoryAttempt | null>(null);
  const [ready, setReady] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState('');
  const [retryOriginal, setRetryOriginal] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [reviewCurrent, setReviewCurrent] = useState(false);
  const [removeConfirm, setRemoveConfirm] = useState(false);
  const titleInput = useRef<HTMLInputElement>(null);
  const reviewDateInput = useRef<HTMLInputElement>(null);
  const pendingHere = attempt && (attempt.input.kind === 'remember' ? !id : attempt.input.noteId === id);
  const note = query.data?.note;
  const writeAccess = canWriteMemory(binding.session, siteId);
  const denied = memoryReadDenied(query.error) || memoryReadDenied(error);

  useEffect(() => {
    try {
      if (previousMemoryConnection(window.sessionStorage, binding.scope)) throw new RequestError('PREVIOUS_CONNECTION_PENDING', 'Original update needs checking.');
      const saved = readMemoryAttempt(window.sessionStorage, binding.scope);
      pending.current = saved; setAttempt(saved);
      if (saved && (saved.input.kind === 'remember' ? !id : saved.input.noteId === id)) {
        if (saved.input.kind !== 'remove') setDraft({ title: saved.input.title, text: saved.input.text, purpose: saved.input.purpose, reviewBy: saved.input.reviewBy });
        initialized.current = saved.input.kind !== 'remove';
      }
    } catch (failure) { setError(failure); setBlocked(true); }
    setReady(true);
  }, []);
  useEffect(() => {
    if (!ready || initialized.current || !note || note.status === 'removed') return;
    setDraft(draftFromNote(note)); setExpected(note.editToken); initialized.current = true;
  }, [ready, note]);

  const current = () => {
    const scope = binding.current();
    if (!canWriteMemory(binding.session, siteId)) throw new RequestError('FORBIDDEN', 'Your current role cannot update this note.', 403);
    return scope;
  };
  async function accept(operation: NativeMemoryNoteOperation, original: MemoryAttempt) {
    binding.current();
    clearMemoryAttempt(window.sessionStorage, original);
    pending.current = null; setAttempt(null); setRetryOriginal(false); setConflict(false); setReviewCurrent(false); setRemoveConfirm(false);
    setMessage(operationMessage(operation)); setError(null);
    void client.invalidateQueries({ queryKey: memoryKey(binding.session, siteId) });
    if (!id) { router.replace(memoryPath(siteId, operation.noteId)); return; }
    if (operation.current) {
      client.setQueryData([...memoryKey(binding.session, siteId), 'note', id], { scope: operation.scope, note: operation.current });
      if (operation.current.status !== 'removed') { setDraft(draftFromNote(operation.current)); setExpected(operation.current.editToken); }
    } else { initialized.current = false; await query.refetch(); }
  }
  async function save(kind: 'remember' | 'correct' | 'remove', original?: MemoryAttempt) {
    if (sending.current || !ready || blocked || !writeAccess || denied || (!original && (pending.current || conflict))) return;
    if (original && (!retryOriginal || original !== pending.current)) return;
    const input = original?.input ?? { kind, siteId, ...(kind === 'remember' ? {} : { noteId: id, expected }), ...(kind === 'remove' ? {} : draft) };
    const parsed = NativeMemoryNoteCommandSchema.safeParse(input);
    if (!parsed.success) { setError(new RequestError('VALIDATION_FAILED', 'Complete all the note fields.', 422)); titleInput.current?.focus(); return; }
    if (!original && !memoryReviewDateIsFuture(parsed.data)) { setError(new RequestError('REVIEW_DATE_PAST', 'Choose a future review date.')); reviewDateInput.current?.focus(); return; }
    sending.current = true; setBusy(true); setError(null); setMessage('');
    let dispatched = false;
    let request: MemoryAttempt | null = original ?? null;
    try {
      current();
      request ??= createMemoryAttempt(binding.scope, parsed.data);
      storeMemoryAttempt(window.sessionStorage, request);
      pending.current = request; setAttempt(request);
      const operation = await sendMemoryAttempt(request, binding.getToken, current, {
        signal: AbortSignal.any([binding.controller.current.signal, AbortSignal.timeout(25_000)]),
        beforeDispatch: () => {
          if (!original && !memoryReviewDateIsFuture(parsed.data)) throw new RequestError('REVIEW_DATE_PAST', 'Choose a future review date.');
          dispatched = true;
        },
      });
      await accept(operation, request);
    } catch (failure) {
      if (!binding.live.current) return;
      if (request && ((!original && !dispatched) || memoryAttemptRejected(failure, Boolean(original)))) {
        try { clearMemoryAttempt(window.sessionStorage, request); pending.current = null; setAttempt(null); }
        catch { setBlocked(true); }
      }
      if (failure instanceof RequestError && failure.code === 'VERSION_CONFLICT' && failure.status === 409) { setConflict(true); setReviewCurrent(false); setRemoveConfirm(false); void query.refetch(); }
      setError(failure); setRetryOriginal(false);
    } finally { sending.current = false; if (binding.live.current) setBusy(false); }
  }
  async function recover() {
    const original = pending.current;
    if (!original || !pendingHere || sending.current || blocked) return;
    sending.current = true; setBusy(true); setError(null); setRetryOriginal(false); setMessage('');
    try {
      const result = await recoverMemoryAttempt(original, binding.getToken, binding.current, AbortSignal.any([binding.controller.current.signal, AbortSignal.timeout(15_000)]));
      if (result.operation) await accept(result.operation, original);
      else { setRetryOriginal(true); setMessage('No saved result was found yet. You can send the same original update again; its details stay unchanged.'); }
    } catch (failure) { if (binding.live.current) setError(failure); }
    finally { sending.current = false; if (binding.live.current) setBusy(false); }
  }
  function submit(event: FormEvent) { event.preventDefault(); void save(id ? 'correct' : 'remember'); }
  function change(field: keyof MemoryDraft, value: string) { setDraft(previous => ({ ...previous, [field]: value })); setMessage(''); }
  const readOnly = !writeAccess || Boolean(attempt) || busy || conflict || !ready || blocked || denied || Boolean(id && (!note || !expected));
  return <div className="memory-page memory-editor-page"><Link className="memory-back" href={memoryPath(siteId)}><Icon name="arrow-left" size={16}/>Memory</Link>
    <PageHeading title={id ? 'Saved note' : 'Remember something'} description={binding.session.sites.find(site => site.id === siteId)?.name ?? 'Assigned site'}/>
    {message && <Alert title="Update status" tone="blue"><p>{message}</p></Alert>}
    {error !== null && <Alert title={attempt ? 'Update not yet confirmed' : 'Update needs attention'} tone="red"><p>{memoryError(error)}</p></Alert>}
    {attempt && !pendingHere && <Alert title="An earlier update needs confirmation" tone="blue"><p>Check the original update before starting another for this site.</p><Link className="button secondary" href={memoryPath(siteId, attempt.input.kind === 'remember' ? 'new' : attempt.input.noteId)}>Open original update</Link></Alert>}
    {pendingHere && <Alert title="Check the original update" tone="blue"><p>{attempt.input.kind === 'remove' ? 'The original removal is retained in this tab.' : 'The original note details are retained in this tab.'} Checking will recover the same request.</p><div className="actions"><button className="button secondary" type="button" disabled={busy || blocked} onClick={() => void recover()}>{busy ? 'Checking…' : 'Check saved update'}</button>{retryOriginal && writeAccess && <button className="button" type="button" disabled={busy || blocked} onClick={() => void save(attempt.input.kind, attempt)}>Retry original update</button>}</div></Alert>}
    {query.error && <Alert title="Note could not be refreshed" tone="red"><p>{memoryError(query.error, 'read')}</p><button className="button secondary" disabled={query.isFetching} onClick={() => void query.refetch()}>Refresh note</button></Alert>}
    {id && !note && !query.error ? <LoadingState label="Loading saved note"/> : null}
    {note?.status === 'removed' ? <section className="memory-removed"><h2>Removed from future work</h2><p>This note is no longer available for future use. Prior records remain.</p><MemoryProvenance note={note}/></section> : (!id || note) && !denied && <div className="memory-editor-layout"><section className="memory-form-panel" aria-label="Note details">
      <form onSubmit={submit}>
        <label>Title<input aria-label="Title" ref={titleInput} value={draft.title} required maxLength={180} readOnly={readOnly} onChange={event => change('title', event.target.value)} autoComplete="off"/></label>
        <label>Note<textarea aria-label="Note" rows={7} value={draft.text} required maxLength={8000} readOnly={readOnly} onChange={event => change('text', event.target.value)} placeholder="What should Pactwoven remember for this site?"/></label>
        <label>When this is useful<textarea aria-label="When this is useful" rows={2} value={draft.purpose} required maxLength={1000} readOnly={readOnly} onChange={event => change('purpose', event.target.value)} placeholder="Explain which work this context helps with."/></label>
        <label>Review by<input aria-label="Review by" ref={reviewDateInput} type="datetime-local" required value={localMemoryDate(draft.reviewBy)} readOnly={readOnly} onChange={event => change('reviewBy', event.target.value && Number.isFinite(new Date(event.target.value).getTime()) ? new Date(event.target.value).toISOString() : '')}/><span className="memory-field-help">Choose a future date and time, in your local time. Review this note again before relying on it after this date.</span></label>
        {id && writeAccess && note && !note.editToken && <p>This note’s current version is not available for editing. Refresh it before making changes. <button type="button" className="button secondary" disabled={query.isFetching} onClick={() => void query.refetch()}>Refresh note</button></p>}
        {writeAccess ? <button type="submit" className="button" disabled={readOnly} aria-busy={busy}>{busy ? 'Saving…' : id ? 'Save changes' : 'Remember this'}</button> : <p>Your access allows you to read this note. Updating it requires site permission.</p>}
      </form>
      {conflict && <Alert title="Review the current note" tone="blue"><p>Your draft above has been kept. Compare it with the current note before updating.</p>{!reviewCurrent ? <button type="button" className="button secondary" disabled={query.isFetching || Boolean(query.error)} onClick={() => setReviewCurrent(true)}>Review current note</button> : note && <div className="memory-current"><h3>{note.title}</h3><p>{note.text}</p><p><strong>When this is useful</strong><br/>{note.purpose}</p><MemoryProvenance note={note}/><button type="button" className="button secondary" disabled={query.isFetching || !note.editToken || Boolean(query.error)} onClick={() => { setExpected(note.editToken); setConflict(false); setReviewCurrent(false); setError(null); titleInput.current?.focus(); }}>Use current version and keep my draft</button></div>}</Alert>}
      {id && writeAccess && note?.editToken && !attempt && !conflict && <div className="memory-remove"><h2>Remove from future work</h2><p>This stops future use of the note. Prior records remain.</p>{removeConfirm ? <div><p>Remove this note from future work?</p><div className="actions"><button type="button" className="button danger" disabled={busy || blocked || denied} onClick={() => void save('remove')}>Confirm removal</button><button type="button" className="button secondary" disabled={busy} onClick={() => setRemoveConfirm(false)}>Keep note</button></div></div> : <button type="button" className="button secondary" disabled={busy || blocked || denied} onClick={() => setRemoveConfirm(true)}>Remove from future work</button>}</div>}
    </section>{note ? <MemoryProvenance note={note}/> : <aside className="memory-provenance"><span className="memory-symbol"><Icon name="layers" size={24}/></span><h2>Context worth keeping</h2><p>Save information that helps with permitted work at this site.</p><p>Your note is a human statement, not an independently verified fact. It cannot grant permission or authorize actions.</p><p>You can update it or remove it from future work. Prior records remain.</p></aside>}</div>}
  </div>;
}
