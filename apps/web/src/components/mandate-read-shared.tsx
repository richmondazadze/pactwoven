'use client';
import { useAuth } from '@clerk/nextjs';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react';
import type { MandateEffectiveAuthority, MandateEligibility, MandateHead, MandatePage, MandateReview } from '@pactwoven/contracts';
import { createMandateReadScope, displayedAuthority, mandateBlockerText, mandateObservationTime, mandateReadError, MANDATE_OBSERVATION_LIFETIME_MS, type MandateObservation, type MandateReadScope } from '../lib/mandates';
import { getApiBase } from '../lib/config';
import { RequestError } from '../lib/api';
import { revealAccessTarget } from '../lib/access-viewport';
import { useWorkspace } from './workspace-provider';
import { useMandateAuthoringMemory } from './mandate-authoring-memory';
import { useMandateRecoveryMemory } from './mandate-recovery-memory';
import { useArrival, useMotion } from './motion';
import { ActionLabel, Alert, ButtonLink, Disclosure, Panel, StatusBadge } from './ui';
import { Icon } from './icon';
export function useMandateRouteScope(id:string) {
  const {session,getToken}=useWorkspace();const auth=useAuth();
  try{return {scope:createMandateReadScope(session,auth,getApiBase(),id),session,getToken,error:null};}catch(error){return {scope:null,session,getToken,error};}
}
export function useMandateScopeLifetime(scope:MandateReadScope) {
  const current=useRef<MandateReadScope|null>(scope);
  useLayoutEffect(()=>{current.current=scope;return()=>{current.current=null;};},[scope]);
  return current;
}
export function useMandateReadPrivacy(error:unknown) {
  const client=useQueryClient();const [denied,setDenied]=useState<RequestError|null>(null);
  const authoring=useMandateAuthoringMemory();const authoringRef=useRef(authoring);authoringRef.current=authoring;
  const memory=useMandateRecoveryMemory();const recovery=useRef(memory);recovery.current=memory;
  useLayoutEffect(()=>{if(error instanceof RequestError&&[401,403].includes(error.status)){setDenied(error);recovery.current.deny();authoringRef.current.deny();void client.cancelQueries({queryKey:['mandate-documents']});client.removeQueries({queryKey:['mandate-documents']});void client.cancelQueries({queryKey:['mandates']});client.removeQueries({queryKey:['mandates']});void client.invalidateQueries({queryKey:['session']});}},[error,client]);
  return denied??((memory.hidden||authoring.hidden)?new RequestError('MANDATE_SCOPE_CHANGED','Current mandate access needs checking.',403):null);
}
export function useMandateClock(observation:MandateObservation<MandatePage|MandateReview>|undefined) {
  const [,tick]=useState(0);
  const data=observation?.data;const view=data&&('envelope'in data?data.envelope:data);
  const now=observation&&view?mandateObservationTime(view.observedAt,observation):Date.now();
  const deadlines=view?[Date.parse(view.observedAt)+MANDATE_OBSERVATION_LIFETIME_MS,...(view.head?[Date.parse(view.head.expiresAt)]:[]),...('items'in view?view.items.map(item=>Date.parse(item.expiresAt)):view.proposal?[Date.parse(view.proposal.expiresAt)]:[])]:[];
  const next=Math.min(...deadlines.filter(deadline=>deadline>now));
  useEffect(()=>{if(!observation)return;const update=()=>tick(value=>value+1);const timer=Number.isFinite(next)?setTimeout(update,Math.min(2_147_483_647,Math.max(1,next-now))):null;document.addEventListener('visibilitychange',update);window.addEventListener('focus',update);return()=>{if(timer!==null)clearTimeout(timer);document.removeEventListener('visibilitychange',update);window.removeEventListener('focus',update);};},[observation,next]);
  return now;
}
export function useMandatePageArrival(transition:string) {
  const {mode,keyboard}=useMotion();const heading=useRef<HTMLDivElement>(null);const arrival=useArrival(transition,120);
  const reveal=useEffectEvent(()=>revealAccessTarget(heading.current,{mode,keyboard:keyboard.current,prefersReducedMotion:window.matchMedia('(prefers-reduced-motion: reduce)').matches,hidden:document.hidden}));
  useLayoutEffect(()=>{reveal();},[transition]);return {heading,arrival};
}
export function MandateReadFailure({error,onRetry,busy=false,responsibilityId}:{error:unknown;onRetry?:(()=>void)|undefined;busy?:boolean;responsibilityId?:string}) {
  const message=mandateReadError(error);
  return <Alert title={message.title} tone="red"><p>{message.detail}</p><div className="actions">{onRetry&&<button type="button" className="button secondary" disabled={busy} onClick={onRetry}><Icon name="repeat-arrows"/><ActionLabel label={busy?'Checking observation…':'Check again'} reserve={['Checking observation…']}/></button>}<ButtonLink href={responsibilityId?`/app/responsibilities/${encodeURIComponent(responsibilityId)}`:'/app/responsibilities'} secondary>{responsibilityId?'Back to responsibility':'View responsibilities'}</ButtonLink></div></Alert>;
}
export const mandateStateLabel=(state:string)=>state==='NONE'?'No accepted mandate':state==='STALE'?'Needs a fresh review':state.slice(0,1)+state.slice(1).toLowerCase();
export const mandateStateTone=(state:string):'neutral'|'blue'|'amber'|'red'=>state==='ACTIVE'?'blue':['REVOKED','EXPIRED','REJECTED'].includes(state)?'red':['STALE','PAUSED','SUPERSEDED'].includes(state)?'amber':'neutral';
export function MandateTime({value}:{value:string}) {return <time dateTime={value}>{new Intl.DateTimeFormat('en',{dateStyle:'medium',timeStyle:'short',timeZone:'UTC'}).format(new Date(value))} UTC</time>;}
export function MandateCurrentAuthority({authority,head,observedAt,now,organizationEpoch,acceptedVersion}:{authority:MandateEffectiveAuthority;head:MandateHead|null;observedAt:string;now:number;organizationEpoch:number;acceptedVersion:number|null}) {
  const displayed=displayedAuthority(authority,head,observedAt,now,organizationEpoch);
  return <section className="mandate-live-authority" aria-label="Current effective authority"><div><span className="mandate-caption">Current effective authority</span><h2>{displayed.state==='ACTIVE'?'Active for advice only':mandateStateLabel(displayed.state)}</h2><p>{displayed.state==='ACTIVE'?'This mandate permits recommendations. It does not authorize purchases, supplier orders, money movement or outbound messages.':displayed.blockers.map(mandateBlockerText).join(' ')}</p></div><div className="mandate-authority-facts"><StatusBadge tone={mandateStateTone(displayed.state)}>{mandateStateLabel(displayed.state)}</StatusBadge>{acceptedVersion!==null&&<span>Accepted mandate version {acceptedVersion}</span>}{head&&<span>Authority expires <MandateTime value={head.expiresAt}/></span>}<span>Observed <MandateTime value={observedAt}/></span></div></section>;
}
export function MandateEligibilityGuidance({items,stale=false}:{items:MandateEligibility[];stale?:boolean}) {
  const labels:Record<MandateEligibility['action'],string>={PROPOSE:'Proposal preparation',AUTHORIZE:'Independent authorization',REJECT:'Proposal rejection',PAUSE:'Pause authority',REVOKE:'Revoke authority',RESUME:'Resume authority'};
  return <Panel title="Review context"><p className="review-note">These are service-reported checks at the observation time. Passing a check does not authorize an action. Available decisions require a separate exact review and explicit action.</p>{stale?<p className="review-note">Refresh to read the current review requirements.</p>:<dl className="mandate-eligibility">{items.map(item=><div key={item.action}><dt>{labels[item.action]}</dt><dd>{item.eligible?'No blockers reported at observation.':item.blockers.map(mandateBlockerText).join(' ')}{item.requiresStepUp&&<span> Fresh multi-factor verification would be required for this action.</span>}</dd></div>)}</dl>}<Disclosure title="Service check references"><dl className="review-key-values">{items.map(item=><div key={item.action}><dt>{item.action}</dt><dd>{item.blockers.length?item.blockers.join(', '):'No reported blockers'}</dd></div>)}</dl></Disclosure></Panel>;
}
