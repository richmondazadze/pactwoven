'use client';
import { useEffect,useState } from 'react';
import { useQuery,useQueryClient } from '@tanstack/react-query';
import type { NativePaidToolView } from '../../../../packages/contracts/src/native-paid-tool';
import { RequestError } from '../lib/api';
import { readPaidEquipment } from '../lib/native-paid-equipment';
import { canObserveAgentWork,useAgentWorkBinding } from './native-agent-work-hooks';

/** Optional result enrichment; this read never changes the original purchase or authorizes payment. */
export function useNativePaidEquipment(siteId:string,rootTaskId:string,revisionKey:string,receipt:NativePaidToolView|undefined,enabled=true){
  const binding=useAgentWorkBinding(siteId),client=useQueryClient(),[visible,setVisible]=useState(canObserveAgentWork);
  const eligible=Boolean(enabled&&receipt?.rootTaskId===rootTaskId&&receipt.state==='completed'&&receipt.resultApplicability==='current'&&receipt.delivery?.result.status==='feasible');
  const key=['native-paid-equipment',binding.identity,rootTaskId,revisionKey,receipt?.operationId??null,receipt?.version??null,receipt?.instructionRevision??null,receipt?.delivery?.result.catalogueHash??null,receipt?.delivery?.result.requestHash??null] as const;
  const current=()=>{if(!canObserveAgentWork())throw new RequestError('OBSERVATION_PAUSED','Reconnect before checking the selected equipment.');return binding.current();};
  const query=useQuery({queryKey:key,enabled:eligible&&visible,queryFn:({signal})=>readPaidEquipment(receipt!,binding.scope,binding.getToken,current,AbortSignal.any([signal,binding.controller.current.signal,AbortSignal.timeout(15000)])),retry:false,staleTime:0,gcTime:0,refetchInterval:false,refetchOnWindowFocus:false,refetchOnReconnect:false});
  useEffect(()=>{const change=()=>{const shown=canObserveAgentWork();if(shown)void client.invalidateQueries({queryKey:key,exact:true,refetchType:'none'});else void client.cancelQueries({queryKey:key,exact:true});setVisible(shown);};document.addEventListener('visibilitychange',change);window.addEventListener('online',change);window.addEventListener('offline',change);return()=>{document.removeEventListener('visibilitychange',change);window.removeEventListener('online',change);window.removeEventListener('offline',change);void client.cancelQueries({queryKey:key,exact:true});client.removeQueries({queryKey:key,exact:true});};},[binding.identity,rootTaskId,revisionKey,receipt?.operationId,receipt?.version,receipt?.instructionRevision,receipt?.delivery?.result.catalogueHash,receipt?.delivery?.result.requestHash,client]);
  return{...query,data:eligible&&visible&&!query.error?query.data:undefined,enabled:eligible&&visible};
}
