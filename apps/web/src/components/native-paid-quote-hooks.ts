'use client';
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RequestError } from '../lib/api';
import { paidQuoteDiscoverySchema, paidQuotePath, paidQuoteRequest } from '../lib/native-paid-quote';
import { canObserveAgentWork,useAgentWorkBinding } from './native-agent-work-hooks';
export function useNativeEquipmentDiscovery(siteId:string,rootTaskId:string,revisionKey:string,enabled=true){
  const binding=useAgentWorkBinding(siteId),client=useQueryClient(),[visible,setVisible]=useState(canObserveAgentWork);const key=['native-equipment',binding.identity,rootTaskId,revisionKey] as const;
  const current=()=>{if(!canObserveAgentWork())throw new RequestError('OBSERVATION_PAUSED','Return to this tab and reconnect.');return binding.current();};
  const query=useQuery({queryKey:key,enabled:enabled&&visible,queryFn:({signal})=>paidQuoteRequest(paidQuotePath(rootTaskId,siteId),paidQuoteDiscoverySchema(binding.scope,rootTaskId),binding.scope,binding.getToken,current,{signal:AbortSignal.any([signal,binding.controller.current.signal,AbortSignal.timeout(15000)])}),refetchInterval:q=>visible&&enabled&&!q.state.error&&q.state.data&&['planning','payment_in_progress'].includes(q.state.data.state)?3500:false,retry:false,staleTime:0,gcTime:0,refetchIntervalInBackground:false,refetchOnWindowFocus:false,refetchOnReconnect:false});
  useEffect(()=>{const change=()=>{const shown=canObserveAgentWork();if(shown)void client.invalidateQueries({queryKey:key,exact:true,refetchType:'none'});else void client.cancelQueries({queryKey:key,exact:true});setVisible(shown);};document.addEventListener('visibilitychange',change);window.addEventListener('online',change);window.addEventListener('offline',change);return()=>{document.removeEventListener('visibilitychange',change);window.removeEventListener('online',change);window.removeEventListener('offline',change);void client.cancelQueries({queryKey:key,exact:true});client.removeQueries({queryKey:key,exact:true});};},[binding.identity,rootTaskId,revisionKey,client]);
  return{...query,data:enabled&&!query.error?query.data:undefined,visible:visible&&enabled};
}
