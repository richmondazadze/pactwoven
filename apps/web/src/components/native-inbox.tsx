'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { getNativeApiBase } from '../lib/config';
import { agentWorkError, agentWorkIdentity, agentWorkPath, agentWorkReadDenied, agentWorkRequest, agentWorkTime, readableAgentWorkSites } from '../lib/native-agent-work';
import { inboxPageSchema, inboxPath, inboxRequestPath, inboxScanCopy } from '../lib/native-inbox';
import { useAgentWorkBinding } from './native-agent-work-hooks';
import { useNativeTaskObservation } from './native-task-hooks';
import { useWorkspace } from './workspace-provider';
import { Alert, EmptyState, LoadingState, PageHeading, StatusBadge } from './ui';
import { Icon } from './icon';
import '../app/native-tasks.css';

export function NativeInbox({ initialSite }: { initialSite?: string | undefined }) {
  const { session } = useWorkspace(), router = useRouter(), sites = readableAgentWorkSites(session);
  const siteId = initialSite ?? sites[0]?.id ?? '', permitted = sites.some(site => site.id === siteId);
  if (!getNativeApiBase()) return <Alert title="Inbox is not connected" tone="blue"><p>Your saved work remains available when the connection returns.</p></Alert>;
  return <div className="native-work-page"><PageHeading title="Inbox" description="Find agent tasks that need your review, then open the original work to decide what comes next."/>
    {(sites.length > 1 || !permitted) && <label className="native-work-site">Site<select aria-label="Site" value={siteId} onChange={event => router.push(inboxPath(event.target.value))}>
      {!permitted && <option value={siteId}>Choose an accessible site</option>}{sites.map(site => <option key={site.id} value={site.id}>{site.name}</option>)}</select></label>}
    {permitted ? <InboxItems key={`${agentWorkIdentity(session, siteId)}:${siteId}`} siteId={siteId}/>
      : <EmptyState icon="shield-lock" title="Choose a site you can access.">Your inbox follows your work permissions.</EmptyState>}
    <p className="muted">This inbox covers agent-team tasks that need review. Earlier conversations remain in <Link href={agentWorkPath(siteId)}>Work</Link>.</p>
  </div>;
}

function InboxItems({ siteId }: { siteId: string }) {
  const binding = useAgentWorkBinding(siteId), client = useQueryClient(), observing = useNativeTaskObservation(), heading = useId();
  const key = ['native-agent-attention', binding.identity] as const;
  const query = useInfiniteQuery({ queryKey: key, initialPageParam: undefined as string | undefined, enabled: observing,
    queryFn: ({ pageParam, signal }) => agentWorkRequest(inboxRequestPath(siteId, pageParam), inboxPageSchema(binding.scope, pageParam),
      binding.scope, binding.getToken, binding.current, { signal: AbortSignal.any([signal, binding.controller.current.signal, AbortSignal.timeout(15000)]) }),
    getNextPageParam: (page, _pages, previous, cursors) => page.nextCursor && page.nextCursor !== previous && !cursors.includes(page.nextCursor) ? page.nextCursor : undefined,
    retry: false, gcTime: 0, staleTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false, refetchIntervalInBackground: false,
  });
  useEffect(() => {
    if (!observing) void client.cancelQueries({ queryKey: key, exact: true });
    return () => { void client.cancelQueries({ queryKey: key, exact: true }); };
  }, [client, binding.identity, observing]);
  const denied = agentWorkReadDenied(query.error), data = denied ? undefined : query.data;
  const items = [...new Map((data?.pages.flatMap(page => page.items) ?? []).map(item => [item.id, item])).values()];
  const last = data?.pages.at(-1), complete = last?.scanComplete === true, busy = query.isFetching || !observing;
  const cursorConflict = Boolean(last?.nextCursor && !query.hasNextPage);
  return <section className="native-work-panel" aria-labelledby={heading}><div className="native-panel-heading"><div><h2 id={heading}>Needs your attention</h2><p>Current review requests from the agent team.</p></div>
    <button className="button secondary" disabled={busy} onClick={() => void client.resetQueries({ queryKey: key, exact: true })}>Refresh inbox</button></div>
    {!observing && <Alert title="Updates are paused" tone="blue"><p>Reconnect and return to this tab to refresh your inbox. Your team’s permitted background work can continue.</p></Alert>}
    {(query.error || cursorConflict) && <Alert title="Inbox needs checking" tone="red"><p>{cursorConflict ? 'The next page could not be verified. Refresh the inbox before continuing.' : agentWorkError(query.error)}</p></Alert>}
    {data && query.error && <p>Showing the last checked work. Refresh for current status.</p>}
    {!data && !query.error && <LoadingState label={observing ? 'Checking your work' : 'Waiting for a connection'}/>}
    {data && <>
      {items.length === 0 ? <EmptyState icon="circle-check" title={complete ? 'No review requests found.' : 'No review requests on this page.'}>
        {inboxScanCopy(0, complete, data.pageParams[0] === undefined)}</EmptyState>
        : <ul className="native-task-rows">{items.map(item => <li key={item.id}><Link className="native-task-row" href={agentWorkPath(siteId, item.id)}><span className="native-task-symbol"><Icon name="inbox" size={21}/></span>
          <div className="native-task-row-copy"><h3>{item.title}</h3><p>Open the saved task to review its result or what prevented it from continuing.</p><p className="muted">Updated <time dateTime={item.updatedAt}>{agentWorkTime(item.updatedAt)}</time></p></div>
          <StatusBadge tone="amber">Needs review</StatusBadge><Icon name="arrow-right" className="native-task-row-arrow" size={18}/></Link></li>)}</ul>}
      <div className="native-work-footer"><p role="status" aria-live="polite">{query.isFetchingNextPage ? 'Checking more work…' : inboxScanCopy(items.length, complete, data.pageParams[0] === undefined)}</p>
        {query.hasNextPage && <button className="button secondary" disabled={busy} onClick={() => void query.fetchNextPage({ cancelRefetch: false })}>
          {query.isFetchingNextPage ? 'Checking more work…' : 'Check more work'}</button>}</div>
    </>}
  </section>;
}
