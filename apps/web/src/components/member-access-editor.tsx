'use client';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@clerk/nextjs';
import { AccessRoleSchema, AccessScopeSchema, OperationSchema, type AccessScope, type Operation } from '@pactwoven/contracts';
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { accessFailureKind, accessScopeOf, buildAccessIntent, effectiveReadingDescription, type AccessIntent, type AccessSelection } from '@/lib/access-review';
import { saveAccessRecovery, removeAccessRecovery, readAccessRecovery, recoveryFromCapsule, type AccessRecovery, type AccessRecoveryScope } from '@/lib/access-recovery';
import { createAccessCapsule,readCurrentAccessMember,type AccessCapsule } from '@/lib/access-capsule';
import { originalOperation } from '@/lib/access-retry';
import { useAccessRecoveryMemory } from './access-recovery-memory';
import { browserRecoveryStorage } from '@/lib/bootstrap-recovery';
import { apiRequest, RequestError } from '@/lib/api';
import { zonedDateTimeToIso } from '@/lib/time';
import { useWorkspace } from './workspace-provider';
import { ActionLabel, Alert, PageHeading, Panel } from './ui';
import { Icon } from './icon';
import { MfaVerification } from './mfa-verification';
import { MemberAccessReview, RevokedMemberReview } from './member-access-review';
import { useArrival, useMotion } from './motion';
import { revealAccessTarget } from '@/lib/access-viewport';
const roleDescription: Record<AccessScope['roles'][number],string>={owner:'Manage organization access and authority; read permitted records across all organization sites.',operations:'Coordinate responsibilities and permitted work.',finance:'Read permitted records across all organization sites and review financial decisions.',receiver:'Check delivery and acceptance at assigned sites and assigned responsibilities.',auditor:'Read permitted records across all organization sites, even with no assigned sites. No action grants.'};
type MemberAccessEditorProps = { selection: AccessSelection; authorityEpoch: number; recoveryScope: AccessRecoveryScope; onBack:()=>void; onOutcome:(operation:Operation)=>void; onUnresolved:(recovery:AccessRecovery)=>void };
export function MemberAccessEditor(props: MemberAccessEditorProps) {
  if(props.selection.kind!=='grant' && props.selection.member.status==='revoked')return <RevokedMemberInspection member={props.selection.member} onBack={props.onBack}/>;
  return <EditableMemberAccess {...props}/>;
}
function RevokedMemberInspection({member,onBack}:{member:Extract<AccessSelection,{kind:'revise'|'revoke'}>['member'];onBack:()=>void}) {
  const {session}=useWorkspace();const {mode,keyboard}=useMotion();const arrival=useArrival(member.actorId,120);const heading=useRef<HTMLDivElement>(null);
  const revealHeading=useEffectEvent(()=>revealAccessTarget(heading.current,{mode,keyboard:keyboard.current,prefersReducedMotion:window.matchMedia('(prefers-reduced-motion: reduce)').matches,hidden:document.hidden}));
  useLayoutEffect(()=>{revealHeading();},[member.actorId]);
  return <div className="access-editor" ref={arrival}><button type="button" className="back-link" onClick={onBack}><Icon name="arrow-left"/>People & authority</button><div ref={heading} id="member-access-heading" tabIndex={-1} className="access-heading-focus"><PageHeading title="Revoked member record" description={`${member.displayName} · ${session.organization.name}`}/></div><RevokedMemberReview member={member} sites={session.sites}/></div>;
}
function EditableMemberAccess({ selection, authorityEpoch, recoveryScope, onBack, onOutcome, onUnresolved }: MemberAccessEditorProps) {
  const {mode,keyboard}=useMotion();const {session}=useWorkspace(); const auth=useAuth(); const client=useQueryClient();const memory=useAccessRecoveryMemory();
  const [scope,setScope]=useState<AccessScope>(()=>selection.kind==='grant'?{roles:[],siteIds:[],actionSiteIds:[],expiresAt:null}:accessScopeOf(selection.member));
  const [expiry,setExpiry]=useState(()=>scope.expiresAt?new Date(scope.expiresAt).toISOString().slice(0,16):''); const [reason,setReason]=useState('');
  const [intent,setIntent]=useState<AccessIntent|null>(null); const [verified,setVerified]=useState(false); const [verifyRound,setVerifyRound]=useState(0);
  const [accessLost,setAccessLost]=useState(false); const [error,setError]=useState<RequestError|null>(null); const [busy,setBusy]=useState(false); const [rejected,setRejected]=useState(false);
  const requestController=useRef<AbortController|null>(null); const sending=useRef(false); const mounted=useRef(true); const requestKey=useRef<string|null>(null); const heading=useRef<HTMLDivElement>(null);
  const arrival=useArrival(intent?'review':'edit',120);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;requestController.current?.abort();};},[]);
  const revealHeading=useEffectEvent(()=>revealAccessTarget(heading.current,{mode,keyboard:keyboard.current,prefersReducedMotion:window.matchMedia('(prefers-reduced-motion: reduce)').matches,hidden:document.hidden}));
  useLayoutEffect(()=>{revealHeading();},[Boolean(intent)]);
  useEffect(()=>{const warn=(event:BeforeUnloadEvent)=>{if(busy)event.preventDefault();};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[busy]);
  const person=selection.kind==='grant'?selection.candidate:selection.member;
  const isSelf=person.externalSubject===auth.userId || (selection.kind!=='grant' && selection.member.actorId===session.actor.actorId);
  function toggle(field:'siteIds'|'actionSiteIds',id:string) { setScope(current=>({...current,[field]:current[field].includes(id)?current[field].filter(value=>value!==id):[...current[field],id]})); }
  function review(event:FormEvent) {
    event.preventDefault();setError(null);
    try {
      if(isSelf)throw new Error('Your own access cannot be changed through this flow. Another current owner must review the change.');
      const nextScope=AccessScopeSchema.parse({...scope,expiresAt:expiry?zonedDateTimeToIso(expiry,'UTC'):null});
      if(selection.kind!=='revoke' && nextScope.expiresAt && Date.parse(nextScope.expiresAt)<=Date.now())throw new Error('Choose an access expiry in the future.');
      if(selection.kind!=='revoke' && !nextScope.roles.some(role=>['owner','operations','finance','receiver'].includes(role)) && nextScope.actionSiteIds.length)throw new Error('A read-only role cannot have action sites. Remove those grants or review the role.');
      if(selection.kind!=='revoke' && !nextScope.roles.some(role=>['owner','finance'].includes(role)) && nextScope.actionSiteIds.some(id=>!nextScope.siteIds.includes(id)))throw new Error('Each action site must also be assigned for reading with these roles.');
      if(selection.kind!=='revoke' && [...nextScope.siteIds,...nextScope.actionSiteIds].some(id=>!session.sites.some(site=>site.id===id)))throw new Error('Some site details are unavailable. Refresh the current member record before changing access.');
      const result=buildAccessIntent(selection,nextScope,reason,authorityEpoch);setScope(nextScope);setIntent(result);setVerified(false);requestKey.current=crypto.randomUUID();
    } catch(e) { setError(new RequestError('INVALID_REVIEW',e instanceof Error && !('issues' in e)?e.message:'Select at least one role and review the required fields.')); }
  }
  async function submit() {
    if(sending.current || !intent || !verified || rejected || isSelf || !requestKey.current)return;
    if(readAccessRecovery(browserRecoveryStorage(),recoveryScope)||memory.capsule){setError(new RequestError('ORIGINAL_REQUEST_PENDING','An original access request is unresolved. Return to People & authority to check it.'));return;}
    sending.current=true;setBusy(true);setError(null);
    let recovery:AccessRecovery|null=null;let capsule:AccessCapsule|null=null;let attempted=false;let retained=false;
    const controller=new AbortController();requestController.current=controller;
    try {
      if(!auth.orgId||!auth.userId||!auth.sessionId||auth.orgId!==recoveryScope.organizationId||auth.userId!==recoveryScope.userId)throw new RequestError('SESSION_REQUIRED','Your organization session changed. Sign in again before submitting.',401);
      const freshToken=()=>auth.getToken({skipCache:true,organizationId:recoveryScope.organizationId});
      const requester=await readCurrentAccessMember(session.actor.actorId,freshToken,controller.signal);
      if(!requester||requester.externalSubject!==auth.userId||requester.status!=='active'||!requester.roles.includes('owner'))throw new RequestError('FORBIDDEN','Current owner membership could not be verified.',403);
      capsule=await createAccessCapsule({userId:auth.userId,organizationId:auth.orgId,sessionId:auth.sessionId,apiBase:recoveryScope.apiBase,environment:session.actor.environment,internalOrganizationId:session.organization.id,actorId:session.actor.actorId,requesterMembershipId:requester.externalMembershipId},selection,intent,requestKey.current);
      controller.signal.throwIfAborted();memory.retain(capsule);retained=true;recovery=recoveryFromCapsule(capsule);
      if(!saveAccessRecovery(browserRecoveryStorage(),recovery))throw new RequestError('RECOVERY_UNAVAILABLE','This browser cannot retain the original request reference. No command was sent.');
      attempted=true;
      const operation=originalOperation(await apiRequest(capsule.original.path,OperationSchema,freshToken,{body:capsule.original.command,idempotencyKey:capsule.key,signal:controller.signal}),capsule.scope.environment,capsule);
      if(operation.status==='succeeded'||operation.status==='failed'){removeAccessRecovery(browserRecoveryStorage(),recovery);memory.resolve(capsule.key);}
      if(mounted.current){if(operation.status==='succeeded'||operation.status==='failed')onOutcome(operation);else onUnresolved(recovery);}
    } catch(e) {
      const issue=e instanceof RequestError?e:new RequestError(attempted?'UNCONFIRMED':'PREPARATION_FAILED',attempted?'The service outcome could not be confirmed.':'The original request could not be prepared. No command was sent.');
      const kind=accessFailureKind(issue);
      if(!attempted||kind!=='unknown'){if(recovery)removeAccessRecovery(browserRecoveryStorage(),recovery);if(retained&&capsule)memory.resolve(capsule.key);}
      if(mounted.current){
        setError(issue);setVerified(false);
        if(issue.status===401||(issue.status===403&&issue.code==='FORBIDDEN')){memory.purge();setAccessLost(true);void client.cancelQueries({queryKey:['members']});client.removeQueries({queryKey:['members']});client.removeQueries({queryKey:['member-candidates']});void client.invalidateQueries({queryKey:['session']});}
        if(kind==='step-up')setVerifyRound(value=>value+1);
        else if(attempted&&kind==='rejected')setRejected(true);
        else if(attempted&&recovery)onUnresolved(recovery);
      }
    } finally {sending.current=false;if(mounted.current)setBusy(false);}
  }
  if(accessLost)return <Alert title="Your access changed" tone="red"><p>This private review has been cleared. Current organization access is being checked again.</p></Alert>;
  return <div className="access-editor" ref={arrival}><button type="button" className="back-link" disabled={busy} onClick={onBack}><Icon name="arrow-left"/>People & authority</button><div ref={heading} id="member-access-heading" tabIndex={-1} className="access-heading-focus"><PageHeading title={intent?'Review the exact change':selection.kind==='grant'?'Grant app access':selection.kind==='revise'?'Revise member access':'Revoke member access'} description={`${person.displayName} · ${session.organization.name}`}/></div>
    {isSelf && <Alert title="Another owner must change your access" tone="amber"><p>You cannot use this flow to change your own role or site grants.</p></Alert>}
    {!intent?<form onSubmit={review} noValidate><div className="detail-columns"><div><Panel title="Pinned organization identity"><dl className="review-key-values"><div><dt>Name</dt><dd>{person.displayName}</dd></div><div><dt>Subject</dt><dd><code>{person.externalSubject}</code></dd></div><div><dt>Membership</dt><dd><code>{person.externalMembershipId}</code></dd></div></dl><p className="review-note">Access stays bound to this existing membership. Changing a display name does not change the person receiving access.</p></Panel>{selection.kind==='revoke'?<Panel title="Reason for revocation"><label className="field">Why is this access ending?<textarea value={reason} onChange={event=>setReason(event.target.value)} maxLength={500} rows={4} required/><small>Access history will retain this reason.</small></label></Panel>:<><Panel title="Roles"><fieldset className="access-options" aria-label="Role grants" disabled={isSelf}>{AccessRoleSchema.options.map(role=><label key={role} className="access-option"><input type="checkbox" checked={scope.roles.includes(role)} onChange={()=>setScope(current=>({...current,roles:current.roles.includes(role)?current.roles.filter(value=>value!==role):[...current.roles,role]}))}/><span><strong>{role.slice(0,1).toUpperCase()+role.slice(1)}</strong><small>{roleDescription[role]}</small></span></label>)}</fieldset></Panel><Panel title="Site access"><p className="review-note">Assigned read sites and action sites are separate. Owner, finance and auditor roles can read permitted records across all organization sites, even when the assigned list is empty. Receivers also require responsibility assignment.</p><dl className="review-key-values"><div><dt>Effective reading scope</dt><dd>{effectiveReadingDescription(scope)}</dd></div></dl><fieldset className="access-sites" aria-label="Assigned read and action sites" disabled={isSelf}>{session.sites.map(site=><div className="access-site" key={site.id}><div><strong>{site.name}</strong><code>{site.id}</code></div><label><input type="checkbox" aria-label={`Assigned read access to ${site.name}`} checked={scope.siteIds.includes(site.id)} onChange={()=>toggle('siteIds',site.id)}/>Assigned read</label><label><input type="checkbox" aria-label={`Action access to ${site.name}`} checked={scope.actionSiteIds.includes(site.id)} onChange={()=>toggle('actionSiteIds',site.id)}/>Action site</label></div>)}{!session.sites.length&&<p className="review-note">No organization sites are available in this session.</p>}</fieldset>{[...new Set([...scope.siteIds,...scope.actionSiteIds])].filter(id=>!session.sites.some(site=>site.id===id)).map(id=><Alert key={id} title="Site details unavailable" tone="amber"><p>Existing scope includes <code>{id}</code>. Refresh the member record before changing it.</p></Alert>)}</Panel><Panel title="Access duration"><label className="field">Expiry in UTC<input type="datetime-local" value={expiry} onChange={event=>setExpiry(event.target.value)}/><small>Leave empty for no scheduled expiry. The service enforces current membership and authority on every request.</small></label></Panel></>}</div><aside><Panel title="A deliberate access change"><ol className="preparation-list"><li><Icon name="users"/><div><strong>Choose exact grants</strong><p>Review the person, role and each site.</p></div></li><li><Icon name="key"/><div><strong>Verify both factors</strong><p>Use your password and authenticator.</p></div></li><li><Icon name="shield-lock"/><div><strong>Submit once</strong><p>The service checks current authority and records the result.</p></div></li></ol></Panel></aside></div>{error&&<Alert title="Review the access details" tone="red"><p>{error.message}</p></Alert>}<footer className="form-footer"><p>No access change is sent until you review, verify and submit.</p><button className="button" type="submit" disabled={isSelf || (selection.kind==='revoke'&&!reason.trim())}>Review exact change<Icon name="arrow-right"/></button></footer></form>:<><MemberAccessReview selection={selection} intent={intent} sites={session.sites}/>{error&&<Alert title={rejected?'The access change was rejected':'Verification is required'} tone="red"><p>{error.message}</p>{error.correlationId&&<p className="fine">Reference: {error.correlationId}</p>}</Alert>}{!rejected&&<Panel title="Verify before submitting"><MfaVerification key={verifyRound} onComplete={()=>setVerified(true)} onInvalidated={()=>setVerified(false)}/></Panel>}<footer className="form-footer"><div><p>{busy?'Waiting for the service result…':rejected?'Refresh the current member record before starting a new review.':'The access change remains unsubmitted until you choose Submit.'}</p>{requestKey.current&&<p className="fine">Request reference: {requestKey.current}</p>}</div><div className="actions"><button className="button secondary" type="button" disabled={busy} onClick={()=>{if(rejected){onBack();return;}setIntent(null);setVerified(false);setError(null);requestKey.current=null;}}>{rejected?'Refresh members':'Edit draft'}</button><button className={`button ${intent.kind==='revoke'?'danger':''}`} type="button" disabled={!verified||busy||rejected||isSelf} onClick={()=>void submit()}><ActionLabel label={busy?'Submitting…':intent.kind==='revoke'?'Submit revocation':'Submit access change'} reserve={['Submit access change','Submit revocation']}/></button></div></footer></>}
  </div>;
}
