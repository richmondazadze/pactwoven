'use client';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { RequestError } from '../lib/api';
import { memoryDetailSchema, memoryIdentity, memoryKey, memoryListPath, memoryPageSchema, memoryReadDenied, memoryRequest, memoryScope, type MemoryFilter } from '../lib/native-memory';
import { useWorkspace } from './workspace-provider';

export function useMemoryBinding(siteId: string) {
  const { session, getToken } = useWorkspace();
  const identity = memoryIdentity(session, siteId);
  const currentSession = useRef(session); currentSession.current = session;
  const currentIdentity = useRef(identity); currentIdentity.current = identity;
  const live = useRef(true);
  const controller = useRef(new AbortController());
  useLayoutEffect(() => {
    live.current = true; controller.current = new AbortController();
    return () => { live.current = false; controller.current.abort(); };
  }, [identity]);
  const scope = memoryScope(session, siteId);
  const current = () => {
    if (!live.current || currentIdentity.current !== identity || memoryIdentity(currentSession.current, siteId) !== identity) throw new RequestError('SCOPE_CHANGED', 'Your workspace changed.');
    return memoryScope(currentSession.current, siteId);
  };
  return { session, getToken, identity, scope, current, live, controller };
}
export function useMemoryList(siteId: string, status: MemoryFilter) {
  const binding = useMemoryBinding(siteId);
  const client = useQueryClient();
  const key = [...memoryKey(binding.session, siteId), 'list', status];
  const identity = JSON.stringify(key);
  const query = useInfiniteQuery({
    queryKey: key, initialPageParam: undefined as string | undefined,
    queryFn: ({ signal, pageParam }) => memoryRequest(memoryListPath(siteId, status, pageParam), memoryPageSchema(binding.scope, status, pageParam), binding.scope, binding.getToken, binding.current,
      { signal: AbortSignal.any([signal, binding.controller.current.signal, AbortSignal.timeout(15_000)]) }),
    getNextPageParam: (last, _pages, lastCursor, cursors) => last.nextCursor && last.nextCursor !== lastCursor && !cursors.includes(last.nextCursor) ? last.nextCursor : undefined,
    maxPages: 5, retry: false, staleTime: 0, gcTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false,
  });
  useEffect(() => () => { void client.cancelQueries({ queryKey: key, exact: true }); client.removeQueries({ queryKey: key, exact: true }); }, [client, identity]);
  return { ...query, data: memoryReadDenied(query.error) ? undefined : query.data,
    refresh: () => client.resetQueries({ queryKey: key, exact: true }) };
}
export function useMemoryNote(siteId: string, id?: string) {
  const binding = useMemoryBinding(siteId);
  const client = useQueryClient();
  const key = [...memoryKey(binding.session, siteId), 'note', id ?? 'new'];
  const identity = JSON.stringify(key);
  const query = useQuery({ queryKey: key, enabled: Boolean(id),
    queryFn: ({ signal }) => memoryRequest(`/v1/memory/${encodeURIComponent(id!)}?siteId=${encodeURIComponent(siteId)}`, memoryDetailSchema(binding.scope, id!), binding.scope, binding.getToken, binding.current,
      { signal: AbortSignal.any([signal, binding.controller.current.signal, AbortSignal.timeout(15_000)]) }),
    retry: false, staleTime: 0, gcTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false,
  });
  useEffect(() => () => { void client.cancelQueries({ queryKey: key, exact: true }); client.removeQueries({ queryKey: key, exact: true }); }, [client, identity]);
  return { ...query, data: memoryReadDenied(query.error) ? undefined : query.data };
}
