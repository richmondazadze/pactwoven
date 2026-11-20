'use client';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RequestError } from '../lib/api';
import { agentWorkIdentity, agentWorkScope, agentWorkDetailSchema, agentWorkRequest, agentWorkReadDenied } from '../lib/native-agent-work';
import { useWorkspace } from './workspace-provider';

export function canObserveAgentWork() {
  return typeof document==='undefined'||document.visibilityState!=='hidden'&&(typeof navigator==='undefined'||navigator.onLine!==false);
}
export function useAgentWorkBinding(siteId:string) {
  const {session,getToken}=useWorkspace(),identity=agentWorkIdentity(session,siteId);
  const latest=useRef(session);latest.current=session;
  const latestIdentity=useRef(identity);latestIdentity.current=identity;
  const live=useRef(true),controller=useRef(new AbortController());
  useLayoutEffect(()=>{live.current=true;controller.current=new AbortController();return()=>{live.current=false;controller.current.abort();};},[identity]);
  const scope=agentWorkScope(session,siteId);
  const current=()=>{if(!live.current||latestIdentity.current!==identity||agentWorkIdentity(latest.current,siteId)!==identity)throw new RequestError('SCOPE_CHANGED','Your workspace changed.');return agentWorkScope(latest.current,siteId);};
  return {session,getToken,identity,scope,current,live,controller};
}
export function useAgentWorkDetail(siteId:string,id:string) {
  const binding=useAgentWorkBinding(siteId),client=useQueryClient();
  const [visible,setVisible]=useState(canObserveAgentWork);
  const current=()=>{if(!canObserveAgentWork())throw new RequestError('OBSERVATION_PAUSED','Return to this tab and reconnect.');return binding.current();};
  const key=['native-agent-work',binding.identity,id] as const;
  const query=useQuery({queryKey:key,enabled:visible,queryFn:({signal})=>agentWorkRequest(`/v1/agent-work/${encodeURIComponent(id)}?siteId=${encodeURIComponent(siteId)}`,
    agentWorkDetailSchema(binding.scope,id),binding.scope,binding.getToken,current,{signal:AbortSignal.any([signal,binding.controller.current.signal,AbortSignal.timeout(15000)])}),
    refetchInterval:query=>visible&&query.state.data&&['queued','working','waiting'].includes(query.state.data.work.state)&&!query.state.error?3500:false,
    refetchIntervalInBackground:false,retry:false,staleTime:0,gcTime:0,refetchOnWindowFocus:false,refetchOnReconnect:false});
  useEffect(()=>{const change=()=>{const shown=canObserveAgentWork();setVisible(shown);if(!shown)void client.cancelQueries({queryKey:key,exact:true});};
    document.addEventListener('visibilitychange',change);window.addEventListener('online',change);window.addEventListener('offline',change);
    return()=>{document.removeEventListener('visibilitychange',change);window.removeEventListener('online',change);window.removeEventListener('offline',change);void client.cancelQueries({queryKey:key,exact:true});client.removeQueries({queryKey:key,exact:true});};
  },[client,binding.identity,id]);
  return {...query,data:agentWorkReadDenied(query.error)?undefined:query.data,visible};
}
