'use client';
import {useEffect,useState} from 'react';
import {useQuery,useQueryClient} from '@tanstack/react-query';
import type {NativePaidQuoteView} from '../../../../packages/contracts/src/native-paid-quote';
import {NativePaidContributorsSchema,type NativePaidContributors} from '../../../../packages/contracts/src/native-paid-contributors';
import {RequestError} from '../lib/api';
import {readPaidContributors} from '../lib/native-paid-contributors';
import {canObserveAgentWork,useAgentWorkBinding} from './native-agent-work-hooks';
import {Icon} from './icon';

export function useNativePaidContributors(siteId:string,rootTaskId:string,revisionKey:string,controlVersion:number,quote:NativePaidQuoteView|null,enabled=true){
  const binding=useAgentWorkBinding(siteId),client=useQueryClient(),[visible,setVisible]=useState(canObserveAgentWork),[clock,setClock]=useState(Date.now);
  const eligible=enabled&&quote!==null&&Date.parse(quote.reviewBy)>Math.max(clock,Date.now());
  const key=['native-paid-contributors',binding.identity,rootTaskId,revisionKey,controlVersion,quote?.quoteId??null,quote?.instructionRevision??null] as const;
  const current=()=>{if(!canObserveAgentWork())throw new RequestError('OBSERVATION_PAUSED','Reconnect to check the recorded contributions.');return binding.current();};
  const query=useQuery({queryKey:key,enabled:eligible&&visible,queryFn:({signal})=>readPaidContributors(binding.scope,rootTaskId,controlVersion,quote!,binding.getToken,current,AbortSignal.any([signal,binding.controller.current.signal,AbortSignal.timeout(15000)])),retry:false,staleTime:0,gcTime:0,refetchInterval:q=>eligible&&visible&&!q.state.error?3500:false,refetchIntervalInBackground:false,refetchOnWindowFocus:false,refetchOnReconnect:false});
  useEffect(()=>{const change=()=>{const shown=canObserveAgentWork();if(shown)void client.invalidateQueries({queryKey:key,exact:true,refetchType:'none'});else void client.cancelQueries({queryKey:key,exact:true});setClock(Date.now());setVisible(shown);};document.addEventListener('visibilitychange',change);window.addEventListener('online',change);window.addEventListener('offline',change);return()=>{document.removeEventListener('visibilitychange',change);window.removeEventListener('online',change);window.removeEventListener('offline',change);void client.cancelQueries({queryKey:key,exact:true});client.removeQueries({queryKey:key,exact:true});};},[binding.identity,rootTaskId,revisionKey,controlVersion,quote?.quoteId,quote?.instructionRevision,client]);
  useEffect(()=>{const until=Math.min(quote?Date.parse(quote.reviewBy):Infinity,query.data?.availableUntil?Date.parse(query.data.availableUntil):Infinity);if(!Number.isFinite(until))return;const timer=setTimeout(()=>setClock(Date.now()),Math.max(0,Math.min(2147483647,until-Date.now()+1)));return()=>clearTimeout(timer);},[quote?.reviewBy,query.data?.availableUntil]);
  const data=query.data;
  return{...query,data:eligible&&visible&&!query.error&&data?.state==='recorded'&&data.availableUntil&&Date.parse(data.availableUntil)>Math.max(clock,Date.now())?data:undefined};
}
/** Completed source facts only; these cards never claim live execution. */
export function RecordedEquipmentContributors({value}:{value:NativePaidContributors}){
  const parsed=NativePaidContributorsSchema.safeParse(value);
  if(!parsed.success||parsed.data.state!=='recorded'||!parsed.data.availableUntil||Date.parse(parsed.data.availableUntil)<=Date.now())return null;
  const labels={research:'Research',planning:'Planning',escalation:'Review'} as const;
  return <section className="equipment-recorded-contributors" aria-label="Recorded contributions for this quote"><h3>Contributions used for this quote</h3><ul>{parsed.data.contributors.map(item=><li key={item.id}><Icon name="circle-check" size={20}/><div><strong>{labels[item.role]}</strong><span>Contribution recorded</span></div></li>)}</ul></section>;
}
