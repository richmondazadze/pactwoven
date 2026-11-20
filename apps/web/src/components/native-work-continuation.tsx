'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { NativeWorkContinuationSchema } from '../../../../packages/contracts/src/native-work-continuation';
import { agentWorkPath } from '../lib/native-agent-work';
import { nativeTaskQueryKey, scopedNativeApiRequest, taskAttemptScope, nativeTaskError, taskScopesMatch } from '../lib/native-tasks';
import { RequestError } from '../lib/api';
import { useWorkspace } from './workspace-provider';
import { useNativeTaskObservation } from './native-task-hooks';
import { Alert, LoadingState } from './ui';

export function NativeWorkContinuation({ id, children }: { id: string; children: React.ReactNode }) {
  const { session, getToken } = useWorkspace(), router = useRouter(), client = useQueryClient();
  const observing = useNativeTaskObservation(), latest = useRef(session);latest.current = session;
  const key = [...nativeTaskQueryKey(session, id), JSON.stringify([session.organization.authorityEpoch, session.actor.roles, session.actor.siteIds, session.actor.actionSiteIds]), 'continuation'], identity = JSON.stringify(key);
  const query = useQuery({ queryKey: key, enabled: observing, retry: false, gcTime: 0, staleTime: Infinity,
    queryFn: async ({ signal }) => { const result = await scopedNativeApiRequest(`/v1/tasks/${encodeURIComponent(id)}/continuation`,
      NativeWorkContinuationSchema.refine(value => value.scope.environment === session.actor.environment && value.scope.organizationId === session.organization.id &&
        value.taskId === id && (!value.continuation || session.actor.siteIds.includes(value.continuation.siteId))), session, getToken,
      { signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]), currentScope: () => taskAttemptScope(latest.current) });
      signal.throwIfAborted();
      if (!taskScopesMatch(taskAttemptScope(session), taskAttemptScope(latest.current))) throw new RequestError('SCOPE_CHANGED', 'Your workspace changed.');
      return result;
    },
    refetchOnWindowFocus: false, refetchOnReconnect: false,
  });
  useEffect(() => { if (!observing) void client.cancelQueries({ queryKey: key, exact: true });
    return () => { void client.cancelQueries({ queryKey: key, exact: true }); }; }, [client, identity, observing]);
  const destination = !query.error && query.data?.continuation ? agentWorkPath(query.data.continuation.siteId, query.data.continuation.id) : null;
  useEffect(() => { if (destination) router.replace(destination); }, [destination, router]);
  if (query.error) return <Alert title="This work could not be opened" tone="red"><p>{nativeTaskError(query.error)}</p><button className="button secondary" disabled={query.isFetching || !observing} onClick={() => void query.refetch()}>Try again</button></Alert>;
  if (destination) return <div><LoadingState label="Opening your team's work"/><Link href={destination} className="button secondary">Open work</Link></div>;
  if (!query.data) return <LoadingState label={observing ? 'Opening your work' : 'Waiting for a connection'}/>;
  return children;
}
