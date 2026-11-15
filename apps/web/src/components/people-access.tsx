'use client';
import { useAuth } from '@clerk/nextjs';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { MemberAccessPageSchema, MemberCandidatePageSchema, OperationSchema, type Operation } from '@pactwoven/contracts';
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react';
import { isAccessOwner, type AccessSelection } from '@/lib/access-review';
import { readAccessRecovery, removeAccessRecovery, type AccessRecovery, type AccessRecoveryScope } from '@/lib/access-recovery';
import { browserRecoveryStorage } from '@/lib/bootstrap-recovery';
import { revealAccessTarget } from '@/lib/access-viewport';
import { useMotion } from './motion';
import { visibleAccessReceipt } from '@/lib/access-feedback';
import { useAccessFeedback } from './access-feedback';
import { getApiBase } from '@/lib/config';
import { apiRequest, RequestError } from '@/lib/api';
import { useWorkspace } from './workspace-provider';
import { ActionLabel, Alert, ButtonLink, EmptyState, LoadingState, PageHeading, Panel, StatusBadge } from './ui';
import { Icon } from './icon';
import { MemberAccessEditor } from './member-access-editor';
export function PeopleAccess() {
  const {session}=useWorkspace();
  if(!isAccessOwner(session))return <EmptyState title="Owner access is required" icon="shield-lock" action={<ButtonLink href="/app/organization/security" secondary>View your security settings</ButtonLink>}>Only a current organization owner can read or change member grants.</EmptyState>;
  return <OwnerPeopleAccess/>;
}
function OwnerPeopleAccess() {
  const {mode,keyboard}=useMotion();const {session,getToken}=useWorkspace();const feedback=useAccessFeedback();const outcome=visibleAccessReceipt(feedback.notice,session);const auth=useAuth();const client=useQueryClient();
  const scope:AccessRecoveryScope={userId:auth.userId??'',organizationId:auth.orgId??'',apiBase:getApiBase()??''};
  const [selection,setSelection]=useState<AccessSelection|null>(null); const [showCandidates,setShowCandidates]=useState(false);
  const [recovery,setRecovery]=useState<AccessRecovery|null>(()=>readAccessRecovery(browserRecoveryStorage(),scope));
  const [accessLost,setAccessLost]=useState(false); const focus=useRef<HTMLDivElement>(null);const resultFocus=useRef<HTMLDivElement>(null);
  const members=useInfiniteQuery({queryKey:['members',session.organization.id],initialPageParam:'',queryFn:({signal,pageParam})=>apiRequest(`/v1/members?limit=25${pageParam?`&cursor=${encodeURIComponent(pageParam)}`:''}`,MemberAccessPageSchema,getToken,{signal}),getNextPageParam:page=>page.nextCursor??undefined,retry:false});
  const candidates=useInfiniteQuery({queryKey:['member-candidates',session.organization.id],enabled:showCandidates&&!recovery,initialPageParam:'',queryFn:({signal,pageParam})=>apiRequest(`/v1/members/candidates?limit=25${pageParam?`&cursor=${encodeURIComponent(pageParam)}`:''}`,MemberCandidatePageSchema,getToken,{signal}),getNextPageParam:page=>page.nextCursor??undefined,retry:false});
  const memberAccessDenied=(members.error instanceof RequestError && [401,403].includes(members.error.status)) || (candidates.error instanceof RequestError && [401,403].includes(candidates.error.status));
  useEffect(()=>{if(memberAccessDenied){setAccessLost(true);client.removeQueries({queryKey:['member-candidates']});void client.invalidateQueries({queryKey:['session']});}},[memberAccessDenied,client]);
  const rows=members.data?.pages.flatMap(page=>page.items)??[];
  const available=candidates.data?.pages.flatMap(page=>page.items).filter(candidate=>candidate.externalOrganizationId===auth.orgId && !rows.some(member=>member.externalMembershipId===candidate.externalMembershipId) && candidate.externalSubject!==auth.userId)??[];
  const observedEpoch=members.data?.pages[0]?.authorityEpoch;
  const revealResult=useEffectEvent(()=>revealAccessTarget((outcome||recovery)?resultFocus.current:focus.current,{mode,keyboard:keyboard.current,prefersReducedMotion:window.matchMedia('(prefers-reduced-motion: reduce)').matches,hidden:document.hidden}));
  // Read current motion preferences at a workflow transition; preference changes alone must retain focus.
  useLayoutEffect(()=>{if(!selection)revealResult();},[selection,outcome?.id,recovery?.key]);
  async function refresh() { await client.invalidateQueries({queryKey:['members']});await client.invalidateQueries({queryKey:['member-candidates']});await client.invalidateQueries({queryKey:['session']}); }
  function complete(operation:Operation) {setRecovery(null);setSelection(null);feedback.record(session,operation);void refresh();}
  if(accessLost||memberAccessDenied)return <Alert title="Current owner access could not be verified" tone="red"><p>Private member information has been cleared while your organization session is checked.</p></Alert>;
  if(selection && observedEpoch!==undefined)return <MemberAccessEditor selection={selection} authorityEpoch={observedEpoch} recoveryScope={scope} onBack={()=>{setSelection(null);void refresh();}} onOutcome={complete} onUnresolved={value=>{setRecovery(value);setSelection(null);}}/>;
  return <><div ref={focus} id="people-access-heading" tabIndex={-1} className="access-heading-focus"><PageHeading title="People & authority" description="Give each person deliberate access to the organization and the sites where they act." action={<ButtonLink href="/app/organization/security" secondary><Icon name="shield-lock"/>Your security</ButtonLink>}/></div>
    {(recovery||outcome)&&<div ref={resultFocus} id="access-operation-feedback" tabIndex={-1} role="region" aria-label="Access request result" className="access-heading-focus">{recovery&&<AccessRecoveryPanel recovery={recovery} onOutcome={complete} onAccessLost={()=>{setAccessLost(true);client.removeQueries({queryKey:['members']});client.removeQueries({queryKey:['member-candidates']});void client.invalidateQueries({queryKey:['session']});}}/>}
    {outcome&&<Alert title={outcome.status==='succeeded'?'Access change recorded':'Access change failed'} tone={outcome.status==='succeeded'?'blue':'red'}><p>{outcome.status==='succeeded'?`The service recorded member version ${outcome.aggregateVersion}. This receipt records the completed request; current access is checked separately.`:'The service returned a terminal failure. Review the current membership before starting a new change.'}</p><p className="fine">Operation: {outcome.id}</p><button className="text-action" type="button" onClick={feedback.dismiss}><Icon name="close" size={16}/>Dismiss receipt</button></Alert>}</div>}
    <Panel title="Organization members" action={<button type="button" className="text-action" disabled={members.isFetching} onClick={()=>void refresh()}><Icon name="repeat-arrows" size={16}/><ActionLabel label={members.isFetching?'Refreshing…':'Refresh'} reserve={['Refreshing…']}/></button>}>
      {members.isPending?<LoadingState label="Loading current member grants"/>:members.isError?<Alert title="Member access unavailable" tone="red"><p>{members.error.message}</p></Alert>:<><div className="member-list">{rows.map(member=><article className="member-row" key={member.actorId}><span className="access-avatar">{member.displayName.slice(0,1)}</span><div className="member-description"><strong>{member.displayName}</strong><span>{member.status==='revoked'?'Revoked grant · no active action access':`${member.roles.join(', ')} · ${member.actionSiteIds.length} action ${member.actionSiteIds.length===1?'site':'sites'}`}</span><code>{member.externalSubject}</code></div><StatusBadge tone={member.status==='active'?'neutral':'red'}>{member.status}</StatusBadge><div className="actions"><button className="button secondary" type="button" disabled={Boolean(recovery)||member.externalSubject===auth.userId||member.actorId===session.actor.actorId} onClick={()=>{feedback.dismiss();setSelection({kind:'revise',member});}}>{member.status==='revoked'?'Inspect record':'Review access'}</button><button className="icon-button" type="button" aria-label={`Revoke access for ${member.displayName}`} disabled={Boolean(recovery)||member.status==='revoked'||member.externalSubject===auth.userId||member.actorId===session.actor.actorId} onClick={()=>{feedback.dismiss();setSelection({kind:'revoke',member});}}><Icon name="ban-circle"/></button></div></article>)}</div>{!rows.length&&<p className="review-note">No app members were returned for this page.</p>}{members.hasNextPage&&<button className="button secondary" type="button" disabled={members.isFetchingNextPage} onClick={()=>void members.fetchNextPage()}><ActionLabel label={members.isFetchingNextPage?'Loading…':'Load more members'} reserve={['Load more members']}/></button>}<p className="review-note">Your own access changes require another current owner. Revoked grants and their history remain visible.</p></>}
    </Panel>
    <Panel title="Grant access to an existing member" action={<button className="button secondary" type="button" disabled={Boolean(recovery)||members.isError||members.isPending} aria-expanded={showCandidates} onClick={()=>setShowCandidates(value=>!value)}><Icon name={showCandidates?'close':'plus'}/><ActionLabel label={showCandidates?'Close candidates':'Choose a member'} reserve={['Close candidates','Choose a member']}/></button>}>
      <p className="review-note">Choose someone who already belongs to this identity-provider organization. App grants are separate from their provider role.</p>
      {showCandidates&&!recovery&&(candidates.isPending?<LoadingState label="Checking existing organization memberships"/>:candidates.isError?<Alert title="Membership candidates unavailable" tone="red"><p>{candidates.error.message}</p><button type="button" className="button secondary" onClick={()=>void candidates.refetch()}>Check again</button></Alert>:<><div className="member-list">{available.map(candidate=><article className="member-row" key={candidate.externalMembershipId}><span className="access-avatar"><Icon name="users"/></span><div className="member-description"><strong>{candidate.displayName}</strong><span>Provider role: {candidate.externalRole}</span><code>{candidate.externalSubject}</code></div><button className="button secondary" type="button" disabled={members.isError||members.isFetching} onClick={()=>{feedback.dismiss();setSelection({kind:'grant',candidate});}}>Review grant<Icon name="arrow-right" size={16}/></button></article>)}</div>{!available.length&&<p className="review-note">No eligible ungranted memberships were returned on the loaded pages. Existing members are managed above.</p>}{candidates.hasNextPage&&<button className="button secondary" type="button" disabled={candidates.isFetchingNextPage} onClick={()=>void candidates.fetchNextPage()}><ActionLabel label={candidates.isFetchingNextPage?'Loading…':'Load more candidates'} reserve={['Load more candidates']}/></button>}</>)}
    </Panel><p className="workspace-note"><Icon name="shield-lock"/>Every change requires current owner authority and fresh multi-factor verification. No invitations are sent from this page.</p>
  </>;
}
function AccessRecoveryPanel({recovery,onOutcome,onAccessLost}:{recovery:AccessRecovery;onOutcome:(operation:Operation)=>void;onAccessLost:()=>void}) {
  const {getToken}=useWorkspace();const [busy,setBusy]=useState(false);const [message,setMessage]=useState('The original request has no confirmed outcome. New access changes remain locked while you check its result.');const running=useRef(false);const mounted=useRef(true);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  async function check() {
    if(running.current)return;running.current=true;setBusy(true);
    try {const operation=await apiRequest(`/v1/member-access/operations?kind=${recovery.kind}&key=${encodeURIComponent(recovery.key)}`,OperationSchema,getToken);
      if(operation.status==='succeeded'||operation.status==='failed') {removeAccessRecovery(browserRecoveryStorage(),recovery);if(mounted.current)onOutcome(operation);}
      else if(mounted.current)setMessage(`The service reports ${operation.status}. The original command remains unresolved; check again without submitting a new command.`);
    } catch(error) {if(mounted.current && error instanceof RequestError && [401,403].includes(error.status))onAccessLost();if(mounted.current)setMessage(error instanceof RequestError&&error.status===404?'No recorded operation was found yet. This does not prove that the earlier request failed. Keep the original reference and check again.':error instanceof Error?error.message:'The original operation could not be checked.');}
    finally {running.current=false;if(mounted.current)setBusy(false);}
  }
  return <Alert title="Confirm the original access request" tone="amber"><p>{message}</p><p className="fine">Request: {recovery.key} · {recovery.kind}</p><button type="button" className="button secondary" disabled={busy} onClick={()=>void check()}><ActionLabel label={busy?'Checking original request…':'Check original request'} reserve={['Checking original request…']}/></button><p className="fine">This only reads the operation result. It does not resend the access command.</p></Alert>;
}
