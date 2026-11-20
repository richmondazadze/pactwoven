import { describe, expect, it, vi } from 'vitest';
import type { ActorContext } from '../../contracts/src/core';
import type { NativeChannelConsentRequest, NativeCommunicationConnection, NativeCommunicationHumanAuthority, NativeCommunicationRoot, NativeIncomingMessage } from '../../contracts/src/native-communication';
import { admitNativeIncomingMessage, armNativeReplyWait, issueNativeChannelConsent, nativeChannelConsentDigest, nativeIncomingIdentityDigest } from './native-communication';
const start=Date.parse('2026-11-18T12:00:00Z'),at=(offset=0)=>new Date(start+offset).toISOString();
async function fixture(kind:'gmail_reply'|'calendar_change'='gmail_reply'){
 let clock=at();const now=()=>clock;
 const scope={environment:'development' as const,organizationId:'org',siteId:'site'};
 const actor:ActorContext={environment:scope.environment,organizationId:scope.organizationId,actorId:'human',principalKind:'human',roles:['owner'],siteIds:['site'],actionSiteIds:['site'],sessionId:'session',authenticatedAt:at(-1000),correlationId:'trace'};
 const authority:NativeCommunicationHumanAuthority={scope,actorId:'human',membershipVersion:1,organizationEpoch:0,state:'current',observedAt:at(-1000),validUntil:at(15000)};
 const connection:NativeCommunicationConnection={id:'connection',version:1,environment:'development',organizationId:'org',actorId:'human',provider:'google',accountSubject:'google-subject',status:'connected',oauthScopes:['https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/calendar.events.readonly'],observedAt:at(-1000),validUntil:at(15000)};
 const root:NativeCommunicationRoot={scope,rootTaskId:'root',actorId:'human',authority:{kind:'delegated',grantId:'grant',grantVersion:1,revocationEpoch:0,grantDigest:'a'.repeat(64)},generation:4,controlVersion:2,state:'waiting_external',expiresAt:at(3600000)};
 const target=kind==='gmail_reply'?{kind,threadId:'thread',parentMessageId:'parent',allowedSenders:['sender@example.test'],replyTokenHash:'b'.repeat(64)}:{kind,calendarId:'calendar',eventId:'event',expectedEtag:'old'};
 const request:NativeChannelConsentRequest={id:'consent',requestKey:'consent_request_0001',scope,actorId:'human',rootTaskId:'root',rootAuthority:root.authority,connectionId:connection.id,connectionVersion:1,accountSubject:connection.accountSubject,membershipVersion:1,organizationEpoch:0,target,purpose:'Read the expected update for this task',expiresAt:at(3600000),permission:'read_correlated_inbound',outboundEffects:'forbidden',continuesAfterSignOut:true};
 const approval={actor,reviewDigest:await nativeChannelConsentDigest(request),confirmedAt:at(),sessionVerifiedAt:at(),sessionExpiresAt:at(60000)};
 const consent=await issueNativeChannelConsent(request,{approval,connection,authority,root,now});
 const base={consent,consentHead:{consentId:consent.request.id,digest:consent.digest,version:1,state:'active' as const},connection,authority,root,now};
 clock=at(1000);const wait=await armNativeReplyWait({id:'wait',expiresAt:at(1800000)},base);clock=at(3000);
 const source=kind==='gmail_reply'?{kind,messageId:'message',threadId:'thread',parentMessageId:'parent',sender:'sender@example.test',replyTokenHash:'b'.repeat(64)}:{kind,calendarId:'calendar',eventId:'event',etag:'new',previousEtag:'old',change:'updated' as const};
 const message:NativeIncomingMessage={schemaVersion:1,scope,connectionId:connection.id,connectionVersion:1,accountSubject:connection.accountSubject,source,occurredAt:at(2000),content:{scope,id:'content',revision:1,digest:'c'.repeat(64)}};
 const verify=vi.fn(async(binding:Parameters<Parameters<typeof admitNativeIncomingMessage>[1]['verify']>[0])=>({...binding,authenticatedSender:kind==='gmail_reply'?'sender@example.test':null,observedAt:clock,validUntil:new Date(Date.parse(clock)+10000).toISOString()}));
 return {request,approval,base,wait,message,verify,context:{...base,wait,verify},setClock:(value:string)=>{clock=value;}};
}
describe('scoped channel consent',()=>{
 it('requires a distinct human-approved read scope and preserves advisory limits',async()=>{
  const f=await fixture();expect(f.base.consent.request.permission).toBe('read_correlated_inbound');expect(f.base.consent.request.outboundEffects).toBe('forbidden');
  expect(f.base.consent.request.rootAuthority).toEqual(f.base.root.authority);expect(Object.isFrozen(f.base.consent.request)).toBe(true);
 });
 it.each(['digest','session','human','action_site','member','connection','oauth','root','lifetime'])('rejects changed %s during consent issuance',async kind=>{
  const f=await fixture(),request=structuredClone(f.request),approval=structuredClone(f.approval),connection=structuredClone(f.base.connection),authority=structuredClone(f.base.authority),root=structuredClone(f.base.root);
  if(kind==='digest')approval.reviewDigest='f'.repeat(64);if(kind==='session')approval.sessionExpiresAt=at(-1);if(kind==='human')approval.actor.principalKind='service';if(kind==='action_site')approval.actor.actionSiteIds=[];
  if(kind==='member')authority.membershipVersion=2;if(kind==='connection')connection.accountSubject='foreign';if(kind==='oauth')connection.oauthScopes=['https://www.googleapis.com/auth/calendar.events.readonly'];if(kind==='root')root.rootTaskId='other';if(kind==='lifetime')request.expiresAt=at(3600001);
  await expect(issueNativeChannelConsent(request,{approval,connection,authority,root,now:f.base.now})).rejects.toBeDefined();
 });
 it('cannot create a wait for a paused root or beyond original consent',async()=>{
  const f=await fixture();await expect(armNativeReplyWait({id:'other',expiresAt:at(10000)},{...f.base,root:{...f.base.root,state:'paused'}})).rejects.toMatchObject({code:'REPLY_WAIT_DENIED'});
  await expect(armNativeReplyWait({id:'other',expiresAt:at(3600001)},f.base)).rejects.toMatchObject({code:'REPLY_WAIT_DENIED'});
 });
});
describe('incoming-message admission and same-root wake',()=>{
 it.each(['gmail_reply','calendar_change'] as const)('plans one atomic inbox/wait/outbox for a verified %s',async kind=>{
  const f=await fixture(kind),result=await admitNativeIncomingMessage(f.message,f.context);
  expect(result.disposition).toBe('admissible');expect(result.inbox.disposition).toBe('wake_planned');
  expect(result.outbox).toMatchObject({rootTaskId:'root',rootGeneration:4,rootControlVersion:2,permission:'recheck_only',outboundEffects:'forbidden',inboxIdentity:result.inbox.identityDigest});
  expect(result.waitTransition).toEqual({id:'wait',expectedVersion:1,version:2,state:'satisfied'});
  expect(JSON.stringify(result.outbox)).not.toContain('sender@example.test');expect(JSON.stringify(result.outbox)).not.toContain('content');
  expect(Object.isFrozen(result)).toBe(true);expect(f.verify).toHaveBeenCalledOnce();
 });
 it('recovers an exact original receipt after reload without another wait transition or outbox',async()=>{
  const f=await fixture(),first=await admitNativeIncomingMessage(f.message,f.context),stored=JSON.parse(JSON.stringify(first.inbox));
  const duplicate=await admitNativeIncomingMessage(f.message,{...f.context,wait:{...f.wait,state:'satisfied',version:2},root:{...f.base.root,state:'running',generation:5},existing:stored});
  expect(duplicate).toEqual({disposition:'duplicate',inbox:first.inbox,waitTransition:null,outbox:null});
 });
 it('treats changed content under the same provider identity as conflict',async()=>{
  const f=await fixture(),first=await admitNativeIncomingMessage(f.message,f.context),changed={...f.message,content:{...f.message.content!,digest:'d'.repeat(64)}};
  expect(await nativeIncomingIdentityDigest(changed)).toBe(first.inbox.identityDigest);
  await expect(admitNativeIncomingMessage(changed,{...f.context,existing:first.inbox})).rejects.toMatchObject({code:'INCOMING_IDENTITY_CONFLICT'});
 });
 it.each(['unverified','digest','account','sender','expired','future'])('rejects %s transport/provider observations',async kind=>{
  const f=await fixture();const verify=async(binding:Parameters<Parameters<typeof admitNativeIncomingMessage>[1]['verify']>[0])=>{
   if(kind==='unverified')return null;const v=await f.verify(binding);if(kind==='digest')v.messageDigest='f'.repeat(64);if(kind==='account')v.accountSubject='other';if(kind==='sender')v.authenticatedSender='forged@example.test';if(kind==='expired'){v.observedAt=at(-10000);v.validUntil=at(2999);}if(kind==='future'){v.observedAt=at(4000);v.validUntil=at(5000);}return v;
  };
  await expect(admitNativeIncomingMessage(f.message,{...f.context,verify})).rejects.toBeDefined();
 });
 it.each(['thread','parent','sender','token','root','site','connection','version','subject'])('rejects miscorrelated %s',async kind=>{
  const f=await fixture(),message=structuredClone(f.message),wait=structuredClone(f.wait);if(message.source.kind!=='gmail_reply')throw Error();
  if(kind==='thread')message.source.threadId='other';if(kind==='parent')message.source.parentMessageId='other';if(kind==='sender')message.source.sender='other@example.test';if(kind==='token')message.source.replyTokenHash='d'.repeat(64);if(kind==='root')wait.rootTaskId='other';
  if(kind==='site'){message.scope.siteId='other';message.content!.scope.siteId='other';}if(kind==='connection')message.connectionId='other';if(kind==='version')message.connectionVersion=2;if(kind==='subject')message.accountSubject='other';
  await expect(admitNativeIncomingMessage(message,{...f.context,wait})).rejects.toBeDefined();
 });
 it.each(['revoked','membership','epoch','connection','consent_version'])('fails closed after %s changes',async kind=>{
  const f=await fixture(),ctx=structuredClone({consentHead:f.base.consentHead,authority:f.base.authority,connection:f.base.connection});
  if(kind==='revoked')ctx.consentHead.state='revoked' as 'active';if(kind==='membership')ctx.authority.membershipVersion=2;if(kind==='epoch')ctx.authority.organizationEpoch=1;if(kind==='connection')ctx.connection.status='revoked';if(kind==='consent_version')ctx.consentHead.version=2;
  await expect(admitNativeIncomingMessage(f.message,{...f.context,...ctx})).rejects.toBeDefined();
 });
 it.each(['paused','cancelled','completed','blocked','running'] as const)('never resumes a %s root from an incoming reply',async state=>{
  const f=await fixture(),result=await admitNativeIncomingMessage(f.message,{...f.context,root:{...f.base.root,state}});
  expect(result.inbox).toMatchObject({disposition:'ignored',reason:'root_stopped'});expect(result.outbox).toBeNull();expect(result.waitTransition).toBeNull();
 });
 it.each(['old_message','expired_wait','closed_wait','generation','control_version'])('records %s without waking work',async kind=>{
  const f=await fixture(),message=structuredClone(f.message),wait=structuredClone(f.wait),root=structuredClone(f.base.root);
  if(kind==='old_message')message.occurredAt=at(999);if(kind==='expired_wait')wait.expiresAt=at(2500);if(kind==='closed_wait')wait.state='cancelled';if(kind==='generation')root.generation=5;if(kind==='control_version')root.controlVersion=3;
  const result=await admitNativeIncomingMessage(message,{...f.context,wait,root});expect(result.inbox.disposition).toBe('ignored');expect(result.outbox).toBeNull();
 });
 it('requires calendar reconciliation when the retained prior version changed',async()=>{
  const f=await fixture('calendar_change');if(f.message.source.kind!=='calendar_change')throw Error();f.message.source.previousEtag='unseen';
  const result=await admitNativeIncomingMessage(f.message,f.context);expect(result.inbox.reason).toBe('calendar_changed');expect(result.outbox).toBeNull();
 });
 it('does not confuse successive versions of the same calendar item with redelivery',async()=>{
  const f=await fixture('calendar_change'),original=await nativeIncomingIdentityDigest(f.message);if(f.message.source.kind!=='calendar_change')throw Error();f.message.source.etag='another';expect(await nativeIncomingIdentityDigest(f.message)).not.toBe(original);
 });
 it('rejects a future-dated message and observations expiring while verification waits',async()=>{
  const f=await fixture();await expect(admitNativeIncomingMessage({...f.message,occurredAt:at(3001)},f.context)).rejects.toMatchObject({code:'INCOMING_STALE'});
  await expect(admitNativeIncomingMessage(f.message,{...f.context,verify:async binding=>{const value=await f.verify(binding);f.setClock(at(16000));return value;}})).rejects.toBeDefined();
 });
 it('snapshots caller data before awaiting verifier code',async()=>{
  const f=await fixture(),wait=structuredClone(f.wait),originalRoot=wait.rootTaskId;
  const result=await admitNativeIncomingMessage(f.message,{...f.context,wait,verify:async binding=>{wait.rootTaskId='attacker_root';f.message.content!.digest='e'.repeat(64);return f.verify(binding);}});
  expect(result.outbox?.rootTaskId).toBe(originalRoot);
 });
});
