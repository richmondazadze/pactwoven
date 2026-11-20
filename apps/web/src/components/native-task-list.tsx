'use client';
import Link from 'next/link';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { type NativeTaskSummary, type Session } from '@pactwoven/contracts';
import { nativeTaskError, nativeTaskLabels, nativeTaskPath, nativeTaskTone } from '../lib/native-tasks';
import { siteName } from '../lib/responsibilities';
import { useNativeTaskList } from './native-task-hooks';
import { useWorkspace } from './workspace-provider';
import { Icon } from './icon';
import { Alert, EmptyState, LoadingState, StatusBadge } from './ui';
import '../app/native-tasks.css';

export function NativeTaskRows({ tasks, session }: { tasks: NativeTaskSummary[]; session: Session }) {
  return <ul className="native-task-rows">{tasks.map(task => <li key={task.id} data-task-row={task.id}><Link className="native-task-row" href={nativeTaskPath(task.id)}>
    <span className={`native-task-symbol ${task.status === 'completed' ? 'complete' : ''}`}><Icon name={task.status === 'completed' ? 'circle-check' : task.status === 'paused' ? 'pause-circle' : 'clipboard'} size={21} /></span>
    <div className="native-task-row-copy"><h3>{task.title}</h3><p>{task.phase}</p><div><span>{siteName(session, task.siteId)}</span><time dateTime={task.createdAt} title="Created">Created {new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(task.createdAt))}</time></div></div>
    <StatusBadge tone={nativeTaskTone(task.status)}>{nativeTaskLabels[task.status]}</StatusBadge><Icon name="arrow-right" className="native-task-row-arrow" size={18} />
  </Link></li>)}</ul>;
}
export function NativeTaskList({ overview = false }: { overview?: boolean }) {
  const { session } = useWorkspace();
  const [filter, setFilter] = useState<'all' | 'active' | 'completed'>('all');
  const [search, setSearch] = useState('');
  const [settledSearch, setSettledSearch] = useState('');
  useEffect(() => { const timer = setTimeout(() => setSettledSearch(search.trim()), 300); return () => clearTimeout(timer); }, [search]);
  const query = useNativeTaskList({ q: overview ? '' : settledSearch, filter: overview ? 'all' : filter, limit: overview ? 5 : 50 });
  const headingId = useId(), resultsId = useId();
  const panel = useRef<HTMLElement>(null);
  const anchor = useRef<{ id: string; top: number } | null>(null);
  const paging = useRef(false);
  const [announcement, setAnnouncement] = useState('');
  const view = `${filter}:${settledSearch}`;
  const announced = useRef('');
  const shown = [...new Map((query.data?.pages.flatMap(page => page.items) ?? []).map(task => [task.id, task])).values()];
  const rolled = query.data?.pageParams[0] !== undefined;
  const searching = !overview && search.trim() !== settledSearch;
  const filtered = filter !== 'all' || Boolean(settledSearch);
  const stamp = `${view}:${query.dataUpdatedAt}`;
  useEffect(() => {
    if (!query.data || query.isFetching || searching || announced.current === stamp) return;
    announced.current = stamp;
    setAnnouncement(`${shown.length} ${shown.length === 1 ? 'task' : 'tasks'} shown${filtered ? ' for this view' : ''}.${query.hasNextPage && !overview ? ' More work is available.' : ''}`);
  }, [stamp, query.data, query.isFetching, searching, shown.length, filtered, overview, query.hasNextPage]);
  useLayoutEffect(() => {
    if (query.isFetchingNextPage || !anchor.current) return;
    const saved = anchor.current; anchor.current = null;
    const row = Array.from(panel.current?.querySelectorAll<HTMLElement>('[data-task-row]') ?? []).find(item => item.dataset.taskRow === saved.id);
    if (row) window.scrollBy({ top: row.getBoundingClientRect().top - saved.top, behavior: 'instant' });
  }, [query.data, query.isFetchingNextPage]);
  async function loadMore() {
    if (paging.current || query.isFetching || !query.observing || !query.hasNextPage || searching) return;
    paging.current = true;
    const visible = Array.from(panel.current?.querySelectorAll<HTMLElement>('[data-task-row]') ?? []).find(row => row.getBoundingClientRect().bottom > 100);
    if (visible) anchor.current = { id: visible.dataset.taskRow!, top: visible.getBoundingClientRect().top };
    try { await query.fetchNextPage({ cancelRefetch: false }); } finally { paging.current = false; }
  }
  return <section ref={panel} className="native-work-panel" aria-labelledby={headingId}>
    <div className="native-panel-heading"><div><h2 id={headingId}>{overview ? 'Your recent work' : 'Your work'}</h2><p>{overview ? 'Follow a task, add context, or open its results.' : 'Find saved tasks across your full work history.'}</p></div><button type="button" className="icon-button" aria-label="Refresh your work" disabled={query.isFetching || !query.observing || searching} onClick={() => void query.refresh()}><Icon name="repeat-arrows" size={18} /></button></div>
    {!overview && <div className="native-work-filters"><div className="native-filter-options" role="group" aria-label="Filter work">{(['all', 'active', 'completed'] as const).map(value => <button type="button" key={value} aria-controls={resultsId} aria-pressed={value === filter} onClick={() => setFilter(value)}>{value === 'all' ? 'All work' : value === 'active' ? 'In progress' : 'Completed'}</button>)}</div><label className="native-work-search"><Icon name="search" size={18} /><span className="sr-only">Search all work by title</span><input type="search" aria-controls={resultsId} value={search} onChange={event => setSearch(event.target.value)} placeholder="Find work by name" maxLength={180} /></label></div>}
    <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{searching ? 'Searching work…' : announcement}</p>
    {!query.observing && <p className="native-list-connection">Updates resume when this tab is visible and connected. Saved results remain available.</p>}
    {query.error && <div className="native-inline-notice"><Alert title={query.isFetchNextPageError ? 'Older work could not be loaded' : 'Work could not be refreshed'} tone="red"><p>{nativeTaskError(query.error)}</p>{query.data && <p>Showing the last confirmed records.</p>}<button type="button" className="button secondary" disabled={query.isFetching || !query.observing || searching} onClick={() => void (query.isFetchNextPageError ? loadMore() : query.refresh())}>Try again</button></Alert></div>}
    <div id={resultsId} aria-busy={query.isFetching || searching}>
      {!query.data ? !query.error ? <LoadingState label={query.observing ? 'Loading your work' : 'Waiting for a connection'} /> : null : shown.length === 0 ? <EmptyState icon="clipboard" title={filtered ? 'No tasks match this view.' : 'Your next outcome starts above.'}>{filtered ? 'Try another name or show all work.' : 'Describe what you want to achieve. Your task, its progress and results will stay together here.'}</EmptyState> : <NativeTaskRows tasks={shown} session={session} />}
    </div>
    {query.data && <div className="native-work-footer"><p>{overview ? 'Your newest tasks. Refresh for the latest changes.' : `${shown.length} ${shown.length === 1 ? 'task' : 'tasks'} shown${filtered ? ' in this view' : ''}. Newest first. ${rolled ? 'Earlier pages have left this view; refresh to return to the newest work.' : query.hasNextPage ? 'Load more to see older work.' : 'You have reached the end of this view.'}`}</p>{overview ? <Link className="native-text-link" href="/app/work">View all work<Icon name="arrow-right" size={16} /></Link> : (query.hasNextPage || query.data.pageParams.length > 1) && <button type="button" className="button secondary native-load-more" aria-disabled={query.isFetching || !query.observing || !query.hasNextPage || searching} aria-controls={resultsId} onClick={() => void loadMore()}>{query.isFetchingNextPage ? 'Loading older work…' : query.hasNextPage ? 'Load more work' : 'All matching work loaded'}</button>}</div>}
  </section>;
}
