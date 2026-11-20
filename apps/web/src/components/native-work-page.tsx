'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { getNativeApiBase } from '../lib/config';
import { agentWorkError, agentWorkIdentity, agentWorkPath, agentWorkReadDenied, agentWorkRequest, readableAgentWorkSites } from '../lib/native-agent-work';
import { workListPath, workListSchema, workStateLabels, type WorkFilter } from '../lib/native-work-list';
import { useAgentWorkBinding } from './native-agent-work-hooks';
import { NativeAgentWorkComposer } from './native-agent-work-composer';
import { NativeTaskList } from './native-task-list';
import { useNativeTaskObservation } from './native-task-hooks';
import { useWorkspace } from './workspace-provider';
import { ActionLabel, Alert, AsyncFeedback, EmptyState, LoadingState, PageHeading, WorkStateBadge } from './ui';
import { Icon } from './icon';
import '../app/native-tasks.css';

export function NativeWorkPage({ initialSite }: { initialSite?: string | undefined }) {
  const { session } = useWorkspace();
  if (!getNativeApiBase()) return <Alert title="Work is not connected" tone="blue"><p>Your saved requests remain in this tab.</p></Alert>;
  return <WorkSite key={`${agentWorkIdentity(session, '')}:${initialSite ?? ''}`} initialSite={initialSite}/>;
}
export function WorkOverview() {
  const { session } = useWorkspace();
  if (!getNativeApiBase()) return <Alert title="Work is not connected" tone="blue"><p>Your saved requests remain in this tab.</p></Alert>;
  return <OverviewSite key={agentWorkIdentity(session, '')}/>;
}
function OverviewSite() {
  const { session } = useWorkspace(), sites = readableAgentWorkSites(session);
  const [siteId, setSiteId] = useState(sites[0]?.id ?? '');
  if (!sites.some(site => site.id === siteId)) return <EmptyState icon="shield-lock" title="No work site is available.">Your work needs a site assigned to you.</EmptyState>;
  return <div className="native-work-page">{sites.length > 1 && <label className="native-work-site">Site<select aria-label="Site" value={siteId} onChange={event => setSiteId(event.target.value)}>{sites.map(site => <option value={site.id} key={site.id}>{site.name}</option>)}</select></label>}<NativeAgentWorkComposer siteId={siteId}/><WorkResults key={agentWorkIdentity(session, siteId)} siteId={siteId}/><Link className="native-text-link" href={agentWorkPath(siteId)}>View all work<Icon name="arrow-right" size={16}/></Link></div>;
}
function WorkSite({ initialSite }: { initialSite?: string | undefined }) {
  const { session } = useWorkspace(), router = useRouter();
  const sites = readableAgentWorkSites(session), siteId = initialSite ?? sites[0]?.id ?? '';
  const permitted = sites.some(site => site.id === siteId);
  return <div className="native-work-page"><PageHeading title="Work" description="Give your team a goal. Follow the progress and keep the result."/>
    {(sites.length > 1 || !permitted) && <label className="native-work-site">Site<select aria-label="Site" value={siteId} onChange={event => router.push(agentWorkPath(event.target.value))}>{!permitted && <option value={siteId}>Choose an accessible site</option>}{sites.map(site => <option value={site.id} key={site.id}>{site.name}</option>)}</select></label>}
    {permitted ? <><NativeAgentWorkComposer siteId={siteId}/><WorkResults key={agentWorkIdentity(session, siteId)} siteId={siteId}/></> : <EmptyState icon="shield-lock" title="Choose a site you can access.">Your work stays within the sites assigned to you.</EmptyState>}
    <details className="native-task-disclosure native-earlier-work"><summary>Earlier conversations<Icon name="chevron-down" size={17}/></summary><div className="native-disclosure-body"><NativeTaskList/></div></details>
  </div>;
}
export function WorkResults({ siteId }: { siteId: string }) {
  const binding = useAgentWorkBinding(siteId), client = useQueryClient(), observing = useNativeTaskObservation();
  const [filter, setFilter] = useState<WorkFilter>('all'), [search, setSearch] = useState(''), [q, setQ] = useState('');
  const heading = useId(), results = useId(), panel = useRef<HTMLElement>(null), anchor = useRef<{ id: string; top: number } | null>(null);
  useEffect(() => { const timer = setTimeout(() => setQ(search.trim()), 300); return () => clearTimeout(timer); }, [search]);
  const key = ['native-agent-work-list', binding.identity, filter, q] as const, identity = JSON.stringify(key);
  const query = useInfiniteQuery({ queryKey: key, initialPageParam: undefined as string | undefined,
    queryFn: ({ signal, pageParam }) => agentWorkRequest(workListPath(siteId, q, filter, pageParam), workListSchema(binding.scope, filter, pageParam), binding.scope, binding.getToken, binding.current,
      { signal: AbortSignal.any([signal, binding.controller.current.signal, AbortSignal.timeout(15000)]) }),
    getNextPageParam: (page, _pages, previous, cursors) => page.nextCursor && page.nextCursor !== previous && !cursors.includes(page.nextCursor) ? page.nextCursor : undefined,
    enabled: observing, maxPages: 5, gcTime: 0, staleTime: 15000, retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false,
  });
  useEffect(() => { if (!observing) void client.cancelQueries({ queryKey: key, exact: true });
    return () => { void client.cancelQueries({ queryKey: key, exact: true }); }; }, [observing, client, identity]);
  const data = agentWorkReadDenied(query.error) ? undefined : query.data;
  const tasks = [...new Map((data?.pages.flatMap(page => page.items) ?? []).map(item => [item.id, item])).values()];
  const searching = q !== search.trim(), busy = query.isFetching || searching || !observing;
  useLayoutEffect(() => { if (query.isFetchingNextPage || !anchor.current) return;const saved = anchor.current;anchor.current = null;
    const row = Array.from(panel.current?.querySelectorAll<HTMLElement>('[data-work-row]') ?? []).find(row => row.dataset.workRow === saved.id);
    if (row) window.scrollBy({ top: row.getBoundingClientRect().top - saved.top, behavior: 'instant' }); }, [query.data, query.isFetchingNextPage]);
  const paging = useRef(false);
  async function more() { if (busy || paging.current || !query.hasNextPage) return;paging.current = true;
    const row = Array.from(panel.current?.querySelectorAll<HTMLElement>('[data-work-row]') ?? []).find(row => row.getBoundingClientRect().bottom > 100);
    if (row) anchor.current = { id: row.dataset.workRow!, top: row.getBoundingClientRect().top };
    try { await query.fetchNextPage({ cancelRefetch: false }); } finally { paging.current = false; }
  }
  return <section className="native-work-panel" ref={panel} aria-labelledby={heading}><div className="native-panel-heading"><div><h2 id={heading}>Your work</h2><p>Open a goal to follow your team or read the saved advice.</p></div><button type="button" className="icon-button" aria-label="Refresh your work" disabled={busy} onClick={() => void client.resetQueries({ queryKey: key, exact: true })}><Icon name="repeat-arrows" size={18}/></button></div>
    <div className="native-work-filters"><div className="native-filter-options" role="group" aria-label="Filter work">{(['all','active','completed'] as const).map(value => <button type="button" key={value} aria-pressed={filter === value} aria-controls={results} onClick={() => setFilter(value)}>{value === 'all' ? 'All work' : value === 'active' ? 'In progress' : 'Completed'}</button>)}</div><label className="native-work-search"><Icon name="search" size={18}/><span className="sr-only">Search work by title</span><input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Find work by name" maxLength={180} aria-controls={results}/></label></div>
    {!observing && <p className="native-list-connection">Updates resume when this tab is visible and connected.</p>}
    {query.error && <Alert title={query.isFetchNextPageError ? 'Older work could not be loaded' : 'Work could not be refreshed'} tone="red"><p>{agentWorkError(query.error)}</p>{data && <p>Showing the last confirmed records.</p>}<button className="button secondary" disabled={busy} onClick={() => void (query.isFetchNextPageError ? more() : client.resetQueries({ queryKey: key, exact: true }))}>Try again</button></Alert>}
    <div id={results} aria-busy={Boolean(data) && (query.isFetching || searching)}>{!data && !query.error ? <LoadingState variant="list" active={observing} label={observing ? 'Loading your work' : 'Waiting for a connection'}/> : data && !tasks.length ? <EmptyState title={filter !== 'all' || q ? 'No work matches this view.' : 'Your next outcome starts above.'} icon="clipboard">{filter !== 'all' || q ? 'Try another name or show all work.' : 'Describe a goal, review its scope, and let your team begin.'}</EmptyState> : <ul className="native-task-rows">{tasks.map(work => <li key={work.id} data-work-row={work.id}><Link className="native-task-row" href={agentWorkPath(siteId, work.id)}><span className={`native-task-symbol ${work.state === 'completed' ? 'complete' : ''}`}><Icon name={work.state === 'completed' ? 'circle-check' : 'connected-nodes'} size={21}/></span><div className="native-task-row-copy"><h3>{work.title}</h3><time dateTime={work.createdAt}>Started {new Intl.DateTimeFormat('en', { dateStyle: 'medium' }).format(new Date(work.createdAt))}</time></div><WorkStateBadge state={work.state} label={workStateLabels[work.state]}/><Icon name="arrow-right" className="native-task-row-arrow" size={18}/></Link></li>)}</ul>}</div>
    {data && <div className="native-work-footer"><p role="status" aria-live="polite">{query.isFetching && !query.isFetchingNextPage ? <AsyncFeedback label="Refreshing work…"/> : searching ? 'Searching…' : `${tasks.length} ${tasks.length === 1 ? 'goal' : 'goals'} shown. Newest first.`}{data.pageParams[0] !== undefined ? ' Refresh to return to the newest work.' : ''}</p>{query.hasNextPage && <button type="button" className="button secondary" disabled={busy} onClick={() => void more()}><ActionLabel pending={query.isFetchingNextPage} label={query.isFetchingNextPage ? 'Loading older work…' : 'Load more work'} reserve={['Loading older work…','Load more work']}/></button>}</div>}
  </section>;
}
