'use client';
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { NativeAgentWork } from '../../../../packages/contracts/src/native-agent-work';
import { RequestError } from '../lib/api';
import { agentWorkRequest } from '../lib/native-agent-work';
import { nativeWorkTeamActivitySchema, teamActivityMatchesWork } from '../lib/native-work-team-activity';
import { canObserveAgentWork, useAgentWorkBinding } from './native-agent-work-hooks';

export function useNativeWorkTeamActivity(siteId: string, work: NativeAgentWork, enabled = true) {
  const binding = useAgentWorkBinding(siteId), client = useQueryClient(), [visible, setVisible] = useState(canObserveAgentWork);
  const key = ['native-work-team-activity', binding.identity, work.id, work.controlVersion, work.updatedAt] as const;
  const current = () => { if (!canObserveAgentWork()) throw new RequestError('OBSERVATION_PAUSED', 'Return to this tab and reconnect.'); return binding.current(); };
  const query = useQuery({ queryKey: key, enabled: visible && enabled && work.state === 'waiting',
    queryFn: ({ signal }) => agentWorkRequest(`/v1/agent-work/${encodeURIComponent(work.id)}/team-activity?siteId=${encodeURIComponent(siteId)}`,
      nativeWorkTeamActivitySchema(binding.scope, work.id), binding.scope, binding.getToken, current,
      { signal: AbortSignal.any([signal, binding.controller.current.signal, AbortSignal.timeout(15000)]) }),
    refetchInterval: query => visible && enabled && !query.state.error && work.state === 'waiting' ? 3500 : false,
    refetchIntervalInBackground: false, retry: false, staleTime: 0, gcTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false,
  });
  useEffect(() => {
    const change = () => { const shown = canObserveAgentWork();
      if (shown) void client.invalidateQueries({ queryKey: key, exact: true, refetchType: 'none' });
      else void client.cancelQueries({ queryKey: key, exact: true });
      setVisible(shown);
    };
    document.addEventListener('visibilitychange', change); window.addEventListener('online', change); window.addEventListener('offline', change);
    return () => { document.removeEventListener('visibilitychange', change); window.removeEventListener('online', change); window.removeEventListener('offline', change);
      void client.cancelQueries({ queryKey: key, exact: true }); client.removeQueries({ queryKey: key, exact: true }); };
  }, [client, binding.identity, work.id, work.controlVersion, work.updatedAt]);
  const candidate = query.error || !enabled || work.state !== 'waiting' ? undefined : query.data?.teamActivity;
  return { ...query, activity: candidate && teamActivityMatchesWork(candidate, work) ? candidate : undefined,
    visible: visible && enabled, setupRequired: query.error instanceof RequestError && query.error.code === 'SETUP_REQUIRED',
    revisionChanged: Boolean(candidate && !teamActivityMatchesWork(candidate, work)) };
}
