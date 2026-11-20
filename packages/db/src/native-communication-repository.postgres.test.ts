import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ActorContext } from '../../contracts/src/core';
import type { NativeChannelConsentRequest,NativeIncomingMessage,NativeIncomingVerification } from '../../contracts/src/native-communication';
import { nativeChannelConsentDigest } from '../../domain/src/native-communication';
import { commandDigest } from '../../contracts/src/canonical';
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
async function setupFixture(admin:Pool,pools:Record<string,Pool>,kind:'gmail_reply'|'calendar_change'='gmail_reply'){
 const f=await fixtureData(kind),api=new PostgresNativeCommunicationRepository(pools.api!,'simulation');
 await admin.query('INSERT INTO pactwoven.native_communication_fixture_connections VALUES($1,$2)',[f.connection.id,f.connection]);
 await admin.query('INSERT INTO pactwoven.native_communication_fixture_authority VALUES($1,$2)',[f.root.rootTaskId,{actor:f.actor,authority:f.authority,root:f.root}]);
 await admin.query('INSERT INTO pactwoven.native_communication_fixture_artifacts(id,reference) VALUES($1,$2)',[f.content.id,f.content]);
 const reviews=new PostgresNativeCommunicationReviewRepository(pools.review!,'simulation',{resolveApproved:async()=>({request:f.request,approval:f.approval})});
 const reviewId=await reviews.retain(id(),new AbortController().signal),consent=await api.issue(f.actor,reviewId);
 const wait=await api.arm(f.actor,consent.request.id,id(),at(90000));f.message.occurredAt=at();
 const retain=async(message:NativeIncomingMessage=f.message,override:Partial<NativeIncomingVerification>={})=>new PostgresNativeCommunicationProviderRepository(pools.provider!,'simulation',{fetchVerified:async()=>({provenanceId:id(),message,verification:{...await verified(message),...override}})}).retain({connectionId:message.connectionId,providerReference:'synthetic_read'},new AbortController().signal);
 return {...f,api,reviewId,consent,wait,retain};
}

import { PostgresNativeCommunicationRepository,PostgresNativeCommunicationOutboxRepository,PostgresNativeCommunicationReviewRepository,PostgresNativeCommunicationProviderRepository } from './native-communication-repository';
import { nativeIncomingIdentityDigest } from '../../domain/src/native-communication';
const fixturePath=process.env.PACTWOVEN_COMMUNICATION_FIXTURE;
describe.skipIf(!fixturePath)('isolated communication transactional PostgreSQL draft',()=>{
 let admin:Pool,pools:Record<string,Pool>,admission:PostgresNativeCommunicationRepository,outbox:PostgresNativeCommunicationOutboxRepository;
 beforeAll(async()=>{
  const config=JSON.parse(readFileSync(fixturePath!,'utf8')),url=new URL(config.adminUrl);
  if(url.hostname!=='127.0.0.1'||url.pathname!=='/pactwoven_native_communication_r1')throw Error('Owned synthetic communication fixture required');
  admin=new Pool({connectionString:url.href,max:2});pools={};
  const bridge=(await admin.query("SELECT to_regprocedure('pactwoven.native_communication_bridge_connection(jsonb,jsonb)') IS NOT NULL installed")).rows[0].installed;
  if(!bridge){const client=await admin.connect();try{await client.query('BEGIN');await client.query('GRANT CREATE ON SCHEMA pactwoven TO pactwoven_nc_owner_r1');await client.query('SET LOCAL ROLE pactwoven_nc_owner_r1');await client.query(readFileSync('.local/native-communication/fixture-bridges.sql','utf8'));await client.query('RESET ROLE');await client.query('REVOKE CREATE ON SCHEMA pactwoven FROM pactwoven_nc_owner_r1');await client.query('COMMIT');}finally{client.release();}}
  for(const [lane,value]of Object.entries(config.roles)as [string,{name:string;password:string}][]){const service=new URL(url);service.username=value.name;service.password=value.password;pools[lane]=new Pool({connectionString:service.href,max:2});}
  admission=new PostgresNativeCommunicationRepository(pools.admission!,'simulation');outbox=new PostgresNativeCommunicationOutboxRepository(pools.outbox!,'simulation');
 });
 afterAll(async()=>{await Promise.allSettled([admin,...Object.values(pools??{})].filter(Boolean).map(p=>p.end()));});
 const fixture=(kind:'gmail_reply'|'calendar_change'='gmail_reply')=>setupFixture(admin,pools,kind);
 const claimFor=async(wakeId:string,leaseMs=15000)=>{for(let scan=0;scan<10;scan++){const found=(await outbox.claim(20,leaseMs)).find(v=>v.intent.id===wakeId);if(found)return found;}throw Error('Owned fixture backlog did not yield the requested wake');};
 const counts=async(waitId:string)=>(await admin.query(`SELECT (SELECT count(*)::int FROM pactwoven.native_communication_inbox WHERE wait_id=$1) inbox,(SELECT count(*)::int FROM pactwoven.native_communication_outbox WHERE wait_id=$1) outbox,(SELECT body->>'state' FROM pactwoven.native_communication_waits WHERE id=$1) wait`,[waitId])).rows[0];
 it.each(['gmail_reply','calendar_change']as const)('commits one %s receipt, exact wait CAS and content-free outbox',async kind=>{
  const f=await fixture(kind),proof=await f.retain(),receipt=await admission.admit(proof,f.wait.id);expect(receipt.disposition).toBe('wake_planned');expect(receipt.wake?.expectedWaitVersion).toBe(1);
  expect(await counts(f.wait.id)).toEqual({inbox:1,outbox:1,wait:'satisfied'});expect(JSON.stringify(receipt.wake)).not.toContain('sender@example.test');expect(JSON.stringify(receipt.wake)).not.toContain(f.content.id);
 });
 it('concurrent identical admissions recover exactly the original receipt',async()=>{
  const f=await fixture(),proof=await f.retain(),values=await Promise.all(Array.from({length:6},()=>admission.admit(proof,f.wait.id)));expect(values.every(v=>JSON.stringify(v)===JSON.stringify(values[0]))).toBe(true);expect(await counts(f.wait.id)).toEqual({inbox:1,outbox:1,wait:'satisfied'});
 });
 it('two different replies race to one wait transition',async()=>{
  const f=await fixture(),second=structuredClone(f.message);if(second.source.kind!=='gmail_reply')throw Error();second.source.messageId=id();const proofs=await Promise.all([f.retain(),f.retain(second)]);
  const receipts=await Promise.all(proofs.map(p=>admission.admit(p,f.wait.id)));expect(receipts.map(r=>r.disposition).sort()).toEqual(['ignored','wake_planned']);expect(await counts(f.wait.id)).toEqual({inbox:2,outbox:1,wait:'satisfied'});
 });
 it('changed artifact revision under the same provider identity conflicts immutably',async()=>{
  const f=await fixture(),first=await admission.admit(await f.retain(),f.wait.id),changed=structuredClone(f.message);changed.content!.revision=2;
  await admin.query('UPDATE pactwoven.native_communication_fixture_artifacts SET reference=$2 WHERE id=$1',[f.content.id,changed.content]);
  await expect(admission.admit(await f.retain(changed),f.wait.id)).rejects.toMatchObject({code:'COMMUNICATION_IDENTITY_CONFLICT'});expect(await counts(f.wait.id)).toEqual({inbox:1,outbox:1,wait:'satisfied'});
  expect((await admin.query('SELECT receipt FROM pactwoven.native_communication_inbox WHERE identity_digest=$1',[first.identityDigest])).rows[0].receipt).toEqual(first);
 });
 it('same consent issuance and wait replay preserve original time and cannot refresh revoked consent',async()=>{
  const f=await fixture();expect(await f.api.issue(f.actor,f.reviewId)).toEqual(f.consent);expect(await f.api.arm(f.actor,f.consent.request.id,f.wait.id,f.wait.expiresAt)).toEqual(f.wait);
  expect(await f.api.revoke(f.actor,f.consent.request.id,1)).toBe(2);expect(await f.api.issue(f.actor,f.reviewId)).toEqual(f.consent);
  await expect(admission.admit(await f.retain(),f.wait.id)).rejects.toMatchObject({code:'FORBIDDEN'});expect(await counts(f.wait.id)).toEqual({inbox:0,outbox:0,wait:'armed'});
 });
 it.each(['connection','membership','generation','paused']as const)('rechecks current %s after locking',async changed=>{
  const f=await fixture(),proof=await f.retain();
  if(changed==='connection')await admin.query(`UPDATE pactwoven.native_communication_fixture_connections SET body=jsonb_set(body,'{status}','"revoked"') WHERE id=$1`,[f.connection.id]);
  else await admin.query(`UPDATE pactwoven.native_communication_fixture_authority SET body=jsonb_set(body,$2,$3) WHERE root_id=$1`,[f.root.rootTaskId,changed==='membership'?'{authority,membershipVersion}':changed==='generation'?'{root,generation}':'{root,state}',changed==='paused'?'"paused"':'5']);
  if(changed==='connection'||changed==='membership'){await expect(admission.admit(proof,f.wait.id)).rejects.toMatchObject({code:'FORBIDDEN'});expect((await counts(f.wait.id)).inbox).toBe(0);}
  else{expect((await admission.admit(proof,f.wait.id)).disposition).toBe('ignored');expect((await counts(f.wait.id)).outbox).toBe(0);}
 });
 it('canonical identity includes the account connection but never creates identity by wait/site',async()=>{
  const f=await fixture(),before=await nativeIncomingIdentityDigest(f.message),changed=structuredClone(f.message);changed.scope.siteId=id();changed.content!.scope.siteId=changed.scope.siteId;expect(await nativeIncomingIdentityDigest(changed)).toBe(before);
  await admission.admit(await f.retain(),f.wait.id);await expect(admission.admit(await f.retain(changed),f.wait.id)).rejects.toMatchObject({code:'FORBIDDEN'});expect((await counts(f.wait.id)).outbox).toBe(1);
 });
 it('expired proof after waiting for the connection lock cannot commit',async()=>{
  const f=await fixture(),proof=await f.retain(f.message,{observedAt:at(-50),validUntil:at(200)}),lock=await admin.connect();await lock.query('BEGIN');await lock.query('SELECT 1 FROM pactwoven.native_communication_fixture_connections WHERE id=$1 FOR UPDATE',[f.connection.id]);
  const pending=admission.admit(proof,f.wait.id);await new Promise(resolve=>setTimeout(resolve,260));await lock.query('COMMIT');lock.release();await expect(pending).rejects.toMatchObject({code:'COMMUNICATION_STALE'});expect((await counts(f.wait.id)).inbox).toBe(0);
 });
 it('original recovery returns the retained receipt and refuses deleted private content',async()=>{
  const f=await fixture(),receipt=await admission.admit(await f.retain(),f.wait.id);expect(await f.api.recover(f.actor,receipt.identityDigest)).toEqual(receipt);
  await admin.query('UPDATE pactwoven.native_communication_fixture_artifacts SET available=false WHERE id=$1',[f.content.id]);await expect(f.api.recover(f.actor,receipt.identityDigest)).rejects.toMatchObject({code:'FORBIDDEN'});
 });
 it('claimed wake queues only the original root and exact lease replay does not queue twice',async()=>{
  const f=await fixture(),receipt=await admission.admit(await f.retain(),f.wait.id);
  const claim=await claimFor(receipt.wake!.id);expect(claim).toBeDefined();
  expect(await outbox.deliver(claim!)).toEqual({id:receipt.wake!.id,status:'delivered'});expect(await outbox.deliver(claim!)).toEqual({id:receipt.wake!.id,status:'delivered'});
  expect((await admin.query('SELECT count(*)::int n FROM pactwoven.native_communication_fixture_queue WHERE id=$1',[receipt.wake!.id])).rows[0].n).toBe(1);
 });
 it('pause during an outbox lease suppresses delivery without unpausing',async()=>{
  const f=await fixture(),receipt=await admission.admit(await f.retain(),f.wait.id),claim=await claimFor(receipt.wake!.id);expect(claim).toBeDefined();
  await admin.query(`UPDATE pactwoven.native_communication_fixture_authority SET body=jsonb_set(body,'{root,state}','"paused"') WHERE root_id=$1`,[f.root.rootTaskId]);expect((await outbox.deliver(claim)).status).toBe('suppressed');
  expect((await admin.query(`SELECT body#>>'{root,state}' state FROM pactwoven.native_communication_fixture_authority WHERE root_id=$1`,[f.root.rootTaskId])).rows[0].state).toBe('paused');
 });
 it('wrong SQL lane and arbitrary accepted-table writes are rejected',async()=>{
  const f=await fixture();await expect(pools.api!.query('SELECT pactwoven.native_communication_admit($1,$2,$3)',['simulation',await f.retain(),f.wait.id])).rejects.toMatchObject({code:'42501'});
  await expect(pools.admission!.query('INSERT INTO pactwoven.native_communication_inbox VALUES($1,$2,$3,$4,$5,$6)',['simulation',f.scope.organizationId,'x',f.wait.id,await f.retain(),{}])).rejects.toMatchObject({code:'42501'});
 });
 it('connection revocation that wins a lock race prevents admission',async()=>{
  const f=await fixture(),proof=await f.retain(),lock=await admin.connect();await lock.query('BEGIN');await lock.query('SELECT 1 FROM pactwoven.native_communication_fixture_connections WHERE id=$1 FOR UPDATE',[f.connection.id]);
  const pending=admission.admit(proof,f.wait.id);await new Promise(resolve=>setTimeout(resolve,25));await lock.query(`UPDATE pactwoven.native_communication_fixture_connections SET body=jsonb_set(body,'{status}','"revoked"') WHERE id=$1`,[f.connection.id]);await lock.query('COMMIT');lock.release();
  await expect(pending).rejects.toMatchObject({code:'FORBIDDEN'});expect(await counts(f.wait.id)).toEqual({inbox:0,outbox:0,wait:'armed'});
 });
 it.each(['native_communication_inbox','native_communication_waits','native_communication_outbox','native_communication_deliveries'])('fault after %s rolls back the whole admission',async table=>{
  await admin.query(`CREATE OR REPLACE FUNCTION pactwoven.native_communication_fixture_abort() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN IF current_setting('pactwoven.fixture_fault',true)=TG_TABLE_NAME THEN RAISE EXCEPTION USING ERRCODE='NC999',MESSAGE='Synthetic statement failure';END IF;RETURN NEW;END $$`);
  await admin.query(`CREATE OR REPLACE TRIGGER communication_fixture_abort AFTER INSERT OR UPDATE ON pactwoven.${table} FOR EACH ROW EXECUTE FUNCTION pactwoven.native_communication_fixture_abort()`);
  const f=await fixture(),proof=await f.retain(),client=await pools.admission!.connect();
  try{await client.query('BEGIN');await client.query("SELECT set_config('pactwoven.fixture_fault',$1,true)",[table]);await expect(client.query('SELECT pactwoven.native_communication_admit($1,$2,$3)',['simulation',proof,f.wait.id])).rejects.toMatchObject({code:'NC999'});await client.query('ROLLBACK');}finally{client.release();}
  expect(await counts(f.wait.id)).toEqual({inbox:0,outbox:0,wait:'armed'});expect((await admission.admit(proof,f.wait.id)).disposition).toBe('wake_planned');
 });
 it('lease expiry recovers the same wake and fences the old worker token',async()=>{
  const f=await fixture(),receipt=await admission.admit(await f.retain(),f.wait.id),first=await claimFor(receipt.wake!.id,1000);expect(first).toBeDefined();
  await new Promise(resolve=>setTimeout(resolve,1050));const restarted=new PostgresNativeCommunicationOutboxRepository(pools.outbox!,'simulation');
  const second=await claimFor(receipt.wake!.id);expect(second.token).not.toBe(first.token);expect(second.attempt).toBe(first.attempt+1);expect(second.intent).toEqual(first.intent);
  expect((await restarted.deliver(first)).status).toBe('lease_lost');expect((await restarted.deliver(second)).status).toBe('delivered');
 });
});
