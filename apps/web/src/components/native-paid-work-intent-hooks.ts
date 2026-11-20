'use client';
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RequestError } from '../lib/api';
import { paidWorkIntentRequest, paidWorkOptionsSchema } from '../lib/native-paid-work-intent';
import { canObserveAgentWork, useAgentWorkBinding } from './native-agent-work-hooks';

export function usePaidWorkOptions(siteId: string, enabled = true) {
  const binding = useAgentWorkBinding(siteId), client = useQueryClient(), [visible,setVisible] = useState(canObserveAgentWork);
  const key = ['paid-work-options',binding.identity] as const;
  const current = () => { if (!canObserveAgentWork()) throw new RequestError('OBSERVATION_PAUSED','Return to this tab and reconnect.'); return binding.current(); };
  const query = useQuery({queryKey:key,enabled:enabled&&visible,queryFn:({signal})=>paidWorkIntentRequest('/v1/agent-work/paid/options',paidWorkOptionsSchema,binding.scope,binding.getToken,current,{signal:AbortSignal.any([signal,binding.controller.current.signal,AbortSignal.timeout(15000)])}),retry:false,staleTime:0,gcTime:0,refetchOnWindowFocus:false,refetchOnReconnect:false});
  useEffect(()=>{const changed=()=>{const shown=canObserveAgentWork();if(shown)void client.invalidateQueries({queryKey:key,exact:true,refetchType:'none'});else void client.cancelQueries({queryKey:key,exact:true});setVisible(shown);};document.addEventListener('visibilitychange',changed);window.addEventListener('online',changed);window.addEventListener('offline',changed);return()=>{document.removeEventListener('visibilitychange',changed);window.removeEventListener('online',changed);window.removeEventListener('offline',changed);void client.cancelQueries({queryKey:key,exact:true});client.removeQueries({queryKey:key,exact:true});};},[binding.identity,client]);
  return {...query,data:enabled&&!query.error?query.data:undefined,visible:visible&&enabled};
}
