'use client';
import Link from 'next/link';
import { useEffect, useId, useState } from 'react';
import { getNativeApiBase } from '../lib/config';
import { canWriteMemory, memoryError, memoryIdentity, memoryPath, memoryScope, memoryStatusLabels, previousMemoryConnection, readableMemorySites, readMemoryAttempt, type MemoryFilter } from '../lib/native-memory';
import { useMemoryList } from './native-memory-hooks';
import { useWorkspace } from './workspace-provider';
import { ActionLabel, Alert, EmptyState, LoadingState, PageHeading, StatusBadge } from './ui';
import { Icon } from './icon';
import '../app/native-memory.css';

export function MemoryPendingNotice({ siteId }: { siteId: string }) {
  const { session } = useWorkspace();
  const [notice, setNotice] = useState<{ href?: string; message: string } | null>(null);
  useEffect(() => {
    try {
      const scope = memoryScope(session, siteId);
      if (previousMemoryConnection(window.sessionStorage, scope)) { setNotice({ message: 'An update belongs to your previous service connection. Restore that connection to recover its original result.' }); return; }
      const attempt = readMemoryAttempt(window.sessionStorage, scope);
      setNotice(attempt ? { href: memoryPath(siteId, attempt.input.kind === 'remember' ? 'new' : attempt.input.noteId), message: 'An earlier update needs confirmation. Its original details are retained in this tab.' } : null);
    } catch (error) { setNotice({ message: memoryError(error) }); }
  }, [siteId, session]);
  return notice && <Alert title="Check your saved update" tone="blue"><p>{notice.message}</p>{notice.href && <Link href={notice.href} className="button secondary">Open original update</Link>}</Alert>;
}
export function NativeMemoryPage({ initialSite }: { initialSite?: string | undefined }) {
  const { session } = useWorkspace();
  if (!getNativeApiBase()) return <Alert title="Memory is not connected" tone="blue"><p>Saved memory is not connected yet.</p></Alert>;
  return <MemorySiteList key={memoryIdentity(session, '')} initialSite={initialSite}/>;
}
function MemorySiteList({ initialSite }: { initialSite?: string | undefined }) {
  const { session } = useWorkspace();
  const sites = readableMemorySites(session);
  const [siteId, setSiteId] = useState(initialSite ?? sites[0]?.id ?? '');
  const permitted = sites.some(site => site.id === siteId);
  return <div className="memory-page"><PageHeading title="Memory" description="Useful context for permitted work at each site." action={permitted && canWriteMemory(session, siteId) ? <Link className="button" href={memoryPath(siteId, 'new')}><Icon name="plus" size={18}/>Remember something</Link> : undefined}/>
    <label className="memory-site">Site<select aria-label="Site" value={siteId} onChange={event => setSiteId(event.target.value)}>{!permitted && <option value={siteId}>Choose an accessible site</option>}{sites.map(site => <option value={site.id} key={site.id}>{site.name}</option>)}</select></label>
    {permitted ? <MemorySiteResults key={siteId} siteId={siteId}/> : <EmptyState title="Choose a site you can read." icon="shield-lock">Saved notes are scoped to your assigned sites.</EmptyState>}
  </div>;
}
function MemorySiteResults({ siteId }: { siteId: string }) {
  const [status, setStatus] = useState<MemoryFilter>('all');
  const query = useMemoryList(siteId, status);
  const resultsId = useId();
  const notes = [...new Map((query.data?.pages.flatMap(page => page.items) ?? []).map(note => [note.id, note])).values()];
  return <><MemoryPendingNotice siteId={siteId}/><section className="memory-collection" aria-label="Saved notes">
    <div className="memory-toolbar"><label>Show<select aria-label="Show" value={status} aria-controls={resultsId} onChange={event => setStatus(event.target.value as MemoryFilter)}><option value="all">All notes</option>{Object.entries(memoryStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><button type="button" className="button secondary" disabled={query.isFetching} onClick={() => void query.refresh()}><ActionLabel pending={query.isFetching && !query.isFetchingNextPage} label={query.isFetching && !query.isFetchingNextPage ? 'Refreshing…' : 'Refresh notes'} reserve={['Refreshing…','Refresh notes']}/></button></div>
    {query.error && <Alert title="Notes could not be refreshed" tone="red"><p>{memoryError(query.error, 'read')}</p>{query.data && <p>Showing the last confirmed notes.</p>}</Alert>}
    <div id={resultsId} aria-busy={Boolean(query.data) && query.isFetching}>{!query.data && !query.error ? <LoadingState variant="list" label="Loading saved notes"/> : query.data && !notes.length ? <EmptyState title={query.hasNextPage ? 'No matches in this part of your notes.' : 'No notes in this view.'}>{query.hasNextPage ? 'Continue through the remaining notes or choose another filter.' : 'Save useful context or choose another filter.'}</EmptyState> : <ul className="memory-rows">{notes.map(note => <li key={note.id}><Link href={memoryPath(siteId, note.id)} className="memory-row"><span className="memory-symbol"><Icon name="layers" size={21}/></span><div><h2>{note.title}</h2><p>{note.siteName} · Supplied by {note.suppliedBy}</p><span>Updated {new Intl.DateTimeFormat('en', { dateStyle: 'medium' }).format(new Date(note.updatedAt))}</span></div><StatusBadge tone={note.status === 'available' ? 'green' : note.status === 'needs_review' ? 'amber' : 'neutral'}>{memoryStatusLabels[note.status]}</StatusBadge><Icon name="arrow-right" size={18}/></Link></li>)}</ul>}</div>
    {query.data && <div className="memory-list-footer"><p role="status" aria-live="polite">{notes.length} {notes.length === 1 ? 'note' : 'notes'} shown.{query.data.pageParams[0] !== undefined ? ' Earlier pages have left this view. Refresh to return to the beginning.' : ''}</p>{query.hasNextPage && <button type="button" className="button secondary" disabled={query.isFetching} onClick={() => void query.fetchNextPage({ cancelRefetch: false })}><ActionLabel pending={query.isFetchingNextPage} label={query.isFetchingNextPage ? 'Loading more…' : 'Load more notes'} reserve={['Loading more…','Load more notes']}/></button>}</div>}
  </section><p className="memory-footnote">Saved notes are human statements, not independently verified facts. Removing a note stops future use; prior records remain.</p></>;
}
