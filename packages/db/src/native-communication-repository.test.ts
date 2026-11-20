import type { Pool } from 'pg';
import { describe,expect,it,vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ActorContext } from '../../contracts/src/core';
import type { NativeChannelConsentRequest,NativeIncomingMessage,NativeIncomingVerification } from '../../contracts/src/native-communication';
import { nativeChannelConsentDigest } from '../../domain/src/native-communication';
import { commandDigest } from '../../contracts/src/canonical';
import { nativeIncomingIdentityDigest } from '../../domain/src/native-communication';
const id=()=>randomUUID().replaceAll('-','_');
const at=(delta=0)=>new Date(Date.now()+delta).toISOString();
async function fixtureData(kind:'gmail_reply'|'calendar_change'='gmail_reply') {
 const scope={environment:'simulation' as const,organizationId:id(),siteId:id()}, actor:ActorContext={...scope,actorId:id(),principalKind:'human',roles:['owner'],siteIds:[scope.siteId],actionSiteIds:[scope.siteId],sessionId:id(),authenticatedAt:at(-1000),correlationId:id()};
 delete (actor as any).siteId;
 const root={scope,rootTaskId:id(),actorId:actor.actorId,authority:{kind:'delegated' as const,grantId:id(),grantVersion:1,revocationEpoch:0,grantDigest:'a'.repeat(64)},generation:4,controlVersion:2,state:'ready' as const,expiresAt:at(3600000)};
 const connection={id:id(),version:1,environment:'simulation' as const,organizationId:scope.organizationId,actorId:actor.actorId,provider:'google' as const,accountSubject:id(),status:'connected' as const,oauthScopes:['https://www.googleapis.com/auth/gmail.readonly' as const,'https://www.googleapis.com/auth/calendar.events.readonly' as const],observedAt:at(-50),validUntil:at(19000)};
 const authority={scope,actorId:actor.actorId,membershipVersion:1,organizationEpoch:0,state:'current' as const,observedAt:at(-50),validUntil:at(19000)};
 const target=kind==='gmail_reply'?{kind,threadId:id(),parentMessageId:id(),allowedSenders:['sender@example.test'],replyTokenHash:'b'.repeat(64)}:{kind,calendarId:id(),eventId:id(),expectedEtag:'prior'};
 const request:NativeChannelConsentRequest={id:id(),requestKey:id(),scope,actorId:actor.actorId,rootTaskId:root.rootTaskId,rootAuthority:root.authority,connectionId:connection.id,connectionVersion:1,accountSubject:connection.accountSubject,membershipVersion:1,organizationEpoch:0,target,purpose:'Synthetic permitted reply',expiresAt:at(120000),permission:'read_correlated_inbound',outboundEffects:'forbidden',continuesAfterSignOut:true};
 const approval={actor,reviewDigest:await nativeChannelConsentDigest(request),confirmedAt:at(-30),sessionVerifiedAt:at(),sessionExpiresAt:at(60000)};
 const content={scope,id:id(),revision:1,digest:'c'.repeat(64)};
 const source=target.kind==='gmail_reply'?{kind:'gmail_reply' as const,messageId:id(),threadId:target.threadId,parentMessageId:target.parentMessageId,sender:target.allowedSenders[0]!,replyTokenHash:target.replyTokenHash}:{kind:'calendar_change' as const,calendarId:target.calendarId,eventId:target.eventId,etag:'next',previousEtag:'prior',change:'updated' as const};
 const message:NativeIncomingMessage={schemaVersion:1,scope,connectionId:connection.id,connectionVersion:1,accountSubject:connection.accountSubject,source,occurredAt:at(),content};
 return {scope,actor,root,connection,authority,request,approval,content,message};
}
async function verified(message:NativeIncomingMessage):Promise<NativeIncomingVerification>{return {messageDigest:await commandDigest({namespace:'pactwoven/incoming-message/v1',message}),identityDigest:await nativeIncomingIdentityDigest(message),connectionId:message.connectionId,connectionVersion:message.connectionVersion,accountSubject:message.accountSubject,authenticatedSender:message.source.kind==='gmail_reply'?message.source.sender:null,observedAt:at(),validUntil:at(15000)};}

import { PostgresNativeCommunicationProviderRepository,PostgresNativeCommunicationRepository,PostgresNativeCommunicationOutboxRepository } from './native-communication-repository';
const pool=()=>({query:vi.fn()});
describe('native communication repository boundaries',()=>{
 it('fetches through a required provider source and persists only a bound observation',async()=>{
  const f=await fixtureData(),p=pool();p.query.mockResolvedValue({rows:[{response:'11111111-1111-4111-8111-111111111111'}]});
  const source={fetchVerified:vi.fn(async()=>({provenanceId:'read_one',message:f.message,verification:await verified(f.message)}))};
  const repo=new PostgresNativeCommunicationProviderRepository(p as unknown as Pool,'simulation',source);
  await repo.retain({connectionId:f.connection.id,providerReference:'notification_reference'},new AbortController().signal);
  expect(source.fetchVerified).toHaveBeenCalledOnce();expect(p.query.mock.calls[0]?.[0]).toContain('native_communication_retain_observation');
  expect(p.query.mock.calls[0]?.[1]).not.toContain('notification_reference');
 });
 it.each(['identityDigest','messageDigest','accountSubject','connectionVersion'])('rejects forged %s before SQL',async key=>{
  const f=await fixtureData(),p=pool(),v=await verified(f.message);
  const repo=new PostgresNativeCommunicationProviderRepository(p as unknown as Pool,'simulation',{fetchVerified:async()=>({provenanceId:'read_one',message:f.message,verification:{...v,[key]:key==='connectionVersion'?2:'d'.repeat(64)}})});
  await expect(repo.retain({connectionId:f.connection.id,providerReference:'x'},new AbortController().signal)).rejects.toBeDefined();expect(p.query).not.toHaveBeenCalled();
 });
 it('does not accept arbitrary verification flags or provider failure',async()=>{
  const f=await fixtureData(),p=pool(),repo=new PostgresNativeCommunicationProviderRepository(p as unknown as Pool,'simulation',{fetchVerified:async()=>({provenanceId:'read_one',message:f.message,verification:{verified:true} as never})});
  await expect(repo.retain({connectionId:f.connection.id,providerReference:'x'},new AbortController().signal)).rejects.toBeDefined();expect(p.query).not.toHaveBeenCalled();
 });
 it('keeps database private detail out of errors and preserves uncertainty',async()=>{
  const p=pool();p.query.mockRejectedValue({code:'08006',detail:'private subject and token'});
  const repo=new PostgresNativeCommunicationRepository(p as unknown as Pool,'simulation');
  await expect(repo.admit('11111111-1111-4111-8111-111111111111','wait_one')).rejects.toMatchObject({code:'DURABLE_SERVICE_UNAVAILABLE'});
 });
 it('names missing integration rather than substituting an allow decision',async()=>{
  const p=pool();p.query.mockRejectedValue({code:'NC010'});const repo=new PostgresNativeCommunicationRepository(p as unknown as Pool,'simulation');
  await expect(repo.admit('11111111-1111-4111-8111-111111111111','wait_one')).rejects.toMatchObject({code:'COMMUNICATION_INTEGRATION_REQUIRED'});
 });
 it('bounds scanning before SQL',async()=>{
  const p=pool(),repo=new PostgresNativeCommunicationOutboxRepository(p as unknown as Pool,'simulation');await expect(repo.claim(100)).rejects.toBeDefined();expect(p.query).not.toHaveBeenCalled();
 });
});
