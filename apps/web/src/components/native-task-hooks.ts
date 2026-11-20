'use client';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { type NativeTask } from '@pactwoven/contracts';
import {
  nativeTaskSearchKey, nativeTaskSearchPath, nativeTaskQueryKey, newerNativeTask, scopedNativeTaskPageSchema, type NativeTaskListView,
  scopedNativeTaskSchema, taskReadDenied, taskAttemptScope, scopedNativeApiRequest,
} from '../lib/native-tasks';
import { useWorkspace } from './workspace-provider';

// A hidden or offline tab stops observing; the server's work is independent.
export function useNativeTaskObservation() {
  const [observing, setObserving] = useState(false);
  useEffect(() => {
    const update = () => setObserving(document.visibilityState === 'visible' && navigator.onLine);
    update();
    document.addEventListener('visibilitychange', update);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      document.removeEventListener('visibilitychange', update);
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  return observing;
}
export function useNativeTaskList(view: NativeTaskListView) {
  const { session, getToken } = useWorkspace();
  const client = useQueryClient();
  const currentSession = useRef(session); currentSession.current = session;
  const observing = useNativeTaskObservation();
  const key = nativeTaskSearchKey(session, view);
  const identity = JSON.stringify(key);
  const [denial, setDenial] = useState<{ identity: string; error: Error } | null>(null);
  const denied = denial?.identity === identity ? denial.error : null;
  const query = useInfiniteQuery({
    queryKey: key,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ signal, pageParam }) => scopedNativeApiRequest(nativeTaskSearchPath(view, pageParam), scopedNativeTaskPageSchema(session), session, getToken, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]), currentScope: () => taskAttemptScope(currentSession.current),
    }),
    getNextPageParam: (last, _pages, lastCursor, cursors) => last.nextCursor && last.nextCursor !== lastCursor && !cursors.includes(last.nextCursor) ? last.nextCursor : undefined,
    // Keep a bounded reading window. Explicit paging still reaches the entire history.
    maxPages: 5, gcTime: 60_000,
    enabled: observing && !denied, staleTime: 15_000, retry: false,
    refetchOnWindowFocus: false, refetchOnReconnect: false,
  });
  const previousIdentity = useRef(identity);
  useLayoutEffect(() => {
    if (previousIdentity.current !== identity && query.data && (query.data.pages.length > 1 || query.data.pageParams[0] !== undefined)) {
      void client.resetQueries({ queryKey: key, exact: true });
    }
    previousIdentity.current = identity;
  }, [identity, client]);
  useEffect(() => {
    if (!observing) void client.cancelQueries({ queryKey: key, exact: true });
    return () => { void client.cancelQueries({ queryKey: key, exact: true }); };
  }, [observing, client, identity]);
  useEffect(() => {
    if (taskReadDenied(query.error) && query.error instanceof Error && !denied) {
      setDenial({ identity, error: query.error });
      client.removeQueries({ queryKey: key, exact: true });
    } else if (query.data && !query.error && denied) setDenial(null);
  }, [query.error, query.data, denied, client, identity]);
  async function refresh() {
    if (!observing || query.isFetching) return;
    setDenial(null);
    // Reset the cursor as well as the rows, including after the oldest page rolled off.
    await client.resetQueries({ queryKey: key, exact: true });
  }
  return { ...query, refresh, observing, error: denied ?? query.error, data: denied || taskReadDenied(query.error) ? undefined : query.data };
}
export function useNativeTask(id: string) {
  const { session, getToken } = useWorkspace();
  const client = useQueryClient();
  const currentSession = useRef(session); currentSession.current = session;
  const observing = useNativeTaskObservation();
  const key = nativeTaskQueryKey(session, id);
  const [denial, setDenial] = useState<Error | null>(null);
  const query = useQuery({
    queryKey: key,
    queryFn: async ({ signal }) => {
      const next = await scopedNativeApiRequest(`/v1/tasks/${encodeURIComponent(id)}`, scopedNativeTaskSchema(session, id), session, getToken, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]), currentScope: () => taskAttemptScope(currentSession.current),
      });
      signal.throwIfAborted();
      const previous = client.getQueryData<{ task: NativeTask }>(key);
      return { ...next, task: newerNativeTask(previous?.task, next.task) };
    },
    enabled: observing && !denial, staleTime: 1_500, retry: false,
    refetchInterval: state => taskReadDenied(state.state.error) ? false : state.state.error ? 15_000 :
      state.state.data && ['completed', 'cancelled', 'failed'].includes(state.state.data.task.status) ? 15_000 : 2_500,
    refetchIntervalInBackground: false,
  });
  useEffect(() => {
    if (!observing) void client.cancelQueries({ queryKey: key, exact: true });
  }, [observing, client, ...key]);
  useEffect(() => {
    if (taskReadDenied(query.error) && query.error instanceof Error && !denial) {
      setDenial(query.error);
      client.removeQueries({ queryKey: key, exact: true });
    } else if (query.data && !query.error && denial) setDenial(null);
  }, [query.error, query.data, denial, client, ...key]);
  return { ...query, observing, error: denial ?? query.error, data: denial || taskReadDenied(query.error) ? undefined : query.data };
}
export function useTaskLifetime() {
  const controller = useRef<AbortController | null>(null);
  const live = useRef(false);
  useEffect(() => { live.current = true; return () => { live.current = false; controller.current?.abort(); }; }, []);
  return { live, controller };
}
