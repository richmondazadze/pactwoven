import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll,beforeAll,beforeEach,describe,expect,it } from 'vitest';
import type { ActorContext } from '@pactwoven/contracts';
import type { NativeMemorySourceRecord,NativeMemoryActiveRecord,NativeMemoryReference,NativeMemorySourceReference } from '../../contracts/src/native-memory';
import { snapshotNativeMemory,snapshotNativeMemorySource,nativeMemorySelectionDigest,assessNativeMemoryRetrieval } from '../../domain/src/native-memory';
import { PostgresNativeMemoryRepository } from './native-memory-repository';
import { assertNativeMemoryPool } from './native-memory-pool';
import type { NativeMemoryRecovery } from './native-memory-persistence-schema';
const url=process.env.PACTWOVEN_MEMORY_TEST_DATABASE_URL;

describe.skipIf(!url)('scoped memory PostgreSQL persistence',()=>{
 let admin:Pool,apiPool:Pool,workerPool:Pool,api:PostgresNativeMemoryRepository,actor:ActorContext;
 beforeAll(async()=>{
  const parsed=new URL(url!);
  if(!['127.0.0.1','localhost'].includes(parsed.hostname)||!parsed.pathname.startsWith('/pactwoven_native_memory_'))throw new Error('A disposable local memory database is required.');
  admin=new Pool({connectionString:url,max:3});
  await admin.query(`DO $$ BEGIN
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='pactwoven_memory_test_api') THEN CREATE ROLE pactwoven_memory_test_api LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='pactwoven_memory_test_worker') THEN CREATE ROLE pactwoven_memory_test_worker LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;END IF;
  END $$;
  GRANT pactwoven_native_delegation_api TO pactwoven_memory_test_api;
  GRANT pactwoven_native_delegation_worker TO pactwoven_memory_test_worker;
  INSERT INTO pactwoven.native_delegation_services(environment,service_id,identity,purpose)
    VALUES('simulation','memory_api','{"serviceId":"memory_api","serviceVersion":1,"workloadIdentityId":"memory_api"}','api'),
      ('simulation','memory_worker','{"serviceId":"memory_worker","serviceVersion":1,"workloadIdentityId":"memory_worker"}','worker') ON CONFLICT DO NOTHING;
  INSERT INTO pactwoven.native_delegation_service_bindings(role_name,role_oid,environment,purpose,service_id)
    SELECT rolname,oid,'simulation',CASE WHEN rolname='pactwoven_memory_test_api' THEN 'api' ELSE 'worker' END,
      CASE WHEN rolname='pactwoven_memory_test_api' THEN 'memory_api' ELSE 'memory_worker' END FROM pg_roles
      WHERE rolname IN ('pactwoven_memory_test_api','pactwoven_memory_test_worker')
    ON CONFLICT(role_name,environment,purpose) DO UPDATE SET role_oid=excluded.role_oid,enabled=true;`);
  const apiPassword=randomBytes(32).toString('base64url'),workerPassword=randomBytes(32).toString('base64url');
  for(const [role,password]of [['pactwoven_memory_test_api',apiPassword],['pactwoven_memory_test_worker',workerPassword]]){
   const update=await admin.query<{sql:string}>("SELECT format('ALTER ROLE %I PASSWORD %L',$1::text,$2::text) AS sql",[role,password]);
   await admin.query(update.rows[0]!.sql);
  }
  const apiUrl=new URL(parsed);apiUrl.username='pactwoven_memory_test_api';apiUrl.password=apiPassword;
  const workerUrl=new URL(parsed);workerUrl.username='pactwoven_memory_test_worker';workerUrl.password=workerPassword;
  apiPool=new Pool({connectionString:apiUrl.toString(),max:2});workerPool=new Pool({connectionString:workerUrl.toString(),max:1});
  api=new PostgresNativeMemoryRepository(apiPool,'simulation');
 });
 beforeEach(async()=>{
  const org='memory_'+randomUUID(),id=randomUUID(),site=randomUUID();
  await admin.query("INSERT INTO pactwoven.organizations(environment,id,external_organization_id,name) VALUES('simulation',$1,$1,'Memory fixture')",[org]);
  await admin.query("INSERT INTO pactwoven.memberships(environment,organization_id,actor_id,external_subject,roles) VALUES('simulation',$1,$2,$2,ARRAY['owner'])",[org,id]);
  await admin.query("INSERT INTO pactwoven.sites(environment,organization_id,id,name,time_zone) VALUES('simulation',$1,$2,'Fixture site','America/Chicago')",[org,site]);
  await admin.query("INSERT INTO pactwoven.member_action_sites(environment,organization_id,actor_id,site_id) VALUES('simulation',$1,$2,$3)",[org,id,site]);
  actor={actorId:id,organizationId:org,environment:'simulation',principalKind:'human',roles:['owner'],siteIds:[site],actionSiteIds:[site],sessionId:randomUUID(),authenticatedAt:new Date().toISOString(),correlationId:randomUUID()};
 });
 afterAll(async()=>{await Promise.allSettled([admin?.end(),apiPool?.end(),workerPool?.end()]);});
 const scope=()=>({environment:'simulation' as const,organizationId:actor.organizationId,siteId:actor.siteIds[0]!});
 const access=()=>({readers:[{kind:'user' as const,id:actor.actorId},{kind:'agent' as const,id:'memory_worker'}],purposes:['human_review' as const,'audit' as const,'task_context' as const]});
 const instant=(offset=0)=>new Date(Date.now()+offset).toISOString();
 const sourceRecord=(overrides:Partial<NativeMemorySourceRecord>={}):NativeMemorySourceRecord=>({schemaVersion:1,...scope(),sourceId:randomUUID(),revision:1,kind:'user_statement',status:'active',contentDigest:'a'.repeat(64),provenance:{kind:'user',actorId:actor.actorId},observedAt:instant(-1000),validFrom:instant(-1000),validUntil:instant(600000),access:access(),conflict:'clear',verification:'unverified',...overrides});
 const memoryRecord=(ref:NativeMemorySourceReference,overrides:Partial<NativeMemoryActiveRecord>={}):NativeMemoryActiveRecord=>({schemaVersion:1,...scope(),memoryId:randomUUID(),revision:1,previous:null,subject:{kind:'preference',id:'chairs'},key:'color',recordedAt:instant(-1000),provenance:{kind:'user',actorId:actor.actorId},state:'active',content:{title:'Chair preference',summary:'Blue chairs',attributes:{color:'blue'}},access:access(),validFrom:instant(-1000),validUntil:instant(600000),confidence:'high',conflict:'clear',inputs:{sources:[ref],memories:[]},...overrides});
 const refMemory=(r:NativeMemoryRecovery)=>{if(r.kind!=='memory')throw new Error();return r.originalReference;};
 const refSource=(r:NativeMemoryRecovery)=>{if(r.kind!=='source')throw new Error();return r.originalReference;};
 const source=async(overrides:Partial<NativeMemorySourceRecord>={})=>refSource(await api.source(actor,randomUUID(),{kind:'create',expected:null,record:sourceRecord(overrides)}));
 const memory=async(s:NativeMemorySourceReference,overrides:Partial<NativeMemoryActiveRecord>={})=>refMemory(await api.mutate(actor,randomUUID(),{kind:'create',expected:null,record:memoryRecord(s,overrides)}));
 const read=(reference:NativeMemoryReference)=>api.read(actor,{reference,requestId:randomUUID(),purpose:'human_review'});
 const stored=async(ref:NativeMemoryReference|NativeMemorySourceReference)=>{
  const source='sourceId' in ref;
  return (await admin.query(`SELECT record FROM pactwoven.native_memory_${source?'source_':''}revisions WHERE environment=$1 AND organization_id=$2 AND site_id=$3 AND ${source?'source':'memory'}_id=$4 AND revision=$5`,
   [ref.environment,ref.organizationId,ref.siteId,source?ref.sourceId:ref.memoryId,ref.revision])).rows[0].record;
 };
 const taskContext=()=>({...scope(),reader:{kind:'agent',id:'memory_worker'},purpose:'task_context',usage:{kind:'task',taskId:randomUUID(),generation:1,handoffId:randomUUID()},authority:{kind:'delegated',grantId:randomUUID(),grantVersion:1,revocationEpoch:1,grantDigest:'d'.repeat(64)},assignmentVersion:1,validUntil:instant(300000)});
 const select=async(ctx:ReturnType<typeof taskContext>,ref:NativeMemoryReference)=>(await admin.query('SELECT pactwoven.native_memory_select_locked($1::jsonb,$2::jsonb,$3::timestamptz) AS r',[ctx,ref,ctx.validUntil])).rows[0].r;
 const assertUsage=async(ctx:ReturnType<typeof taskContext>,refs:unknown[],digest='f'.repeat(64))=>admin.query('SELECT pactwoven.native_memory_assert_usage_locked($1,$2::jsonb,$3::jsonb,$4) AS r',['simulation',ctx,JSON.stringify(refs),digest]);
 it('admits exact combined service pools and denies direct tables/private seams',async()=>{
  await assertNativeMemoryPool(apiPool,'simulation','api');await assertNativeMemoryPool(workerPool,'simulation','worker');
  for(const q of ['SELECT * FROM pactwoven.native_memory_revisions',"SELECT pactwoven.native_memory_hash('{}'::jsonb)","SELECT pactwoven.native_memory_assert_usage_locked('simulation','{}','[]','x')"])
   await expect(apiPool.query(q)).rejects.toMatchObject({code:'42501'});
  await expect(workerPool.query("SELECT pactwoven.native_memory_human_recover('{}','site','key')")).rejects.toMatchObject({code:'42501'});
 });
 it('round-trips current content, authoritative times and matching SQL/domain digests',async()=>{
  const s=await source(),m=await memory(s);const result=await read(m);
  expect(result.memory.content.summary).toBe('Blue chairs');
  expect((await snapshotNativeMemory(await stored(m))).reference).toEqual(m);
  expect((await snapshotNativeMemorySource(await stored(s))).reference).toEqual(s);
  expect(await nativeMemorySelectionDigest(result.receipt.selection)).toBe(result.receipt.digest);
  expect(result.receipt.selection.sources).toEqual([s]);
  const inventory={sources:[await snapshotNativeMemorySource(await stored(s))],memories:[await snapshotNativeMemory(await stored(m))]};
  const pure=await assessNativeMemoryRetrieval(m,result.receipt.selection.context,inventory,result.observedAt);
  expect(pure.eligible).toBe(true);if(pure.eligible)expect(pure.receipt).toEqual(result.receipt);
 });
 it('does not allow a caller to attest provider observations or verified outcomes',async()=>{
  for(const record of [sourceRecord({kind:'provider_observation'}),sourceRecord({kind:'verified_outcome',verification:'verified'}),sourceRecord({provenance:{kind:'agent',agentId:'memory_worker',taskId:'task',handoffId:'handoff'}})])
   await expect(api.source(actor,randomUUID(),{kind:'create',expected:null,record})).rejects.toMatchObject({code:'FORBIDDEN'});
 });
 it('does not trust claimed actor roles, another session, or a foreign scoped reference',async()=>{
  const s=await source(),m=await memory(s);
  await expect(read({...m,siteId:'other'})).rejects.toMatchObject({code:'FORBIDDEN'});
  await admin.query("INSERT INTO pactwoven.session_revocations(environment,session_id) VALUES('simulation',$1)",[actor.sessionId]);
  await expect(read(m)).rejects.toMatchObject({code:'FORBIDDEN'});
 });
 it('recovers an original mutation without duplicate revision/outbox and rejects changed request bytes',async()=>{
  const s=await source(),record=memoryRecord(s),key=randomUUID(),q={kind:'create' as const,expected:null,record};
  const one=await api.mutate(actor,key,q),two=await api.mutate(actor,key,q);
  expect(two).toEqual(one);expect(await api.recover(actor,record.siteId,key)).toEqual(one);
  await expect(api.mutate(actor,key,{...q,record:{...record,content:{...record.content,summary:'Different'}}})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
  expect((await admin.query('SELECT count(*)::int AS n FROM pactwoven.native_memory_revisions WHERE organization_id=$1',[actor.organizationId])).rows[0].n).toBe(1);
  expect((await admin.query('SELECT count(*)::int AS n FROM pactwoven.native_memory_invalidation_outbox WHERE organization_id=$1',[actor.organizationId])).rows[0].n).toBe(2);
 });
 it('serializes simultaneous identical mutation retries to one durable revision',async()=>{
  const s=await source(),record=memoryRecord(s),key=randomUUID(),q={kind:'create' as const,expected:null,record};
  const [a,b]=await Promise.all([api.mutate(actor,key,q),api.mutate(actor,key,q)]);expect(a).toEqual(b);
 });
 it('uses exact CAS and exposes content-free recovery after terminal deletion',async()=>{
  const s=await source(),record=memoryRecord(s),key=randomUUID();const m=refMemory(await api.mutate(actor,key,{kind:'create',expected:null,record}));
  const current=await stored(m),next={...current,revision:2,previous:m,content:{...current.content,summary:'Green chairs'}};
  const m2=refMemory(await api.mutate(actor,randomUUID(),{kind:'correct',expected:m,record:next}));
  await expect(api.mutate(actor,randomUUID(),{kind:'correct',expected:m,record:next})).rejects.toMatchObject({code:'VERSION_CONFLICT'});
  const tombstone={schemaVersion:1 as const,...scope(),memoryId:m.memoryId,revision:3,previous:m2,subject:current.subject,key:current.key,recordedAt:instant(),provenance:current.provenance,state:'tombstone' as const,reason:'deleted' as const};
  await api.mutate(actor,randomUUID(),{kind:'delete',expected:m2,record:tombstone});
  const recovered=await api.recover(actor,m.siteId,key);
  expect(recovered).toEqual({kind:'memory',originalReference:m,currentReference:null,availability:'unavailable'});
  expect(await api.mutate(actor,key,{kind:'create',expected:null,record})).toEqual(recovered);
  await expect(read(m2)).rejects.toMatchObject({code:'VERSION_CONFLICT'});
  await expect(api.mutate(actor,randomUUID(),{kind:'create',expected:null,record})).rejects.toMatchObject({code:'VERSION_CONFLICT'});
 });
 it('invalidates derived reads and saved task uses after a source correction',async()=>{
  const s=await source(),m=await memory(s),ctx=taskContext(),usage=await select(ctx,m);
  const r=await stored(s);await api.source(actor,randomUUID(),{kind:'correct',expected:s,record:{...r,revision:2,contentDigest:'b'.repeat(64)}});
  await expect(read(m)).rejects.toMatchObject({code:'VERSION_CONFLICT'});
  await expect(assertUsage(ctx,[{usageId:usage.usageId,selectionDigest:usage.receipt.digest}])).rejects.toMatchObject({code:'NM005'});
 });
 it('requires all durable task usages including when the worker supplies an empty list',async()=>{
  const s=await source(),m=await memory(s),ctx=taskContext(),u=await select(ctx,m);
  await expect(assertUsage(ctx,[])).rejects.toMatchObject({code:'NM005'});
  const refs=[{usageId:u.usageId,selectionDigest:u.receipt.digest}];
  await assertUsage(ctx,refs);await expect(assertUsage({...ctx,assignmentVersion:2},refs)).rejects.toMatchObject({code:'NM005'});
  await expect(assertUsage(ctx,[...refs,...refs])).rejects.toMatchObject({code:'NM004'});
  await expect(assertUsage(ctx,[{...refs[0],selectionDigest:'c'.repeat(64)}])).rejects.toMatchObject({code:'NM005'});
 });
 it('allows a renewed live deadline while pinning authority version and exact publication body',async()=>{
  const s=await source(),m=await memory(s),ctx=taskContext(),u=await select(ctx,m);const refs=[{usageId:u.usageId,selectionDigest:u.receipt.digest}];
  await assertUsage({...ctx,validUntil:instant(400000)},refs);
  await expect(assertUsage({...ctx,authority:{...ctx.authority,grantVersion:2}},refs)).rejects.toMatchObject({code:'NM005'});
  await admin.query('SELECT pactwoven.native_memory_bind_artifact_locked($1,$2::jsonb,$3::jsonb,$4)',['simulation',ctx,JSON.stringify(refs),'f'.repeat(64)]);
  await assertUsage(ctx,refs);await expect(assertUsage(ctx,refs,'e'.repeat(64))).rejects.toMatchObject({code:'NM005'});
 });
 it('denies cross-task use without treating an integrity receipt as authority',async()=>{
  const s=await source(),m=await memory(s),ctx=taskContext(),u=await select(ctx,m);const refs=[{usageId:u.usageId,selectionDigest:u.receipt.digest}];
  await expect(assertUsage({...ctx,usage:{...ctx.usage,handoffId:randomUUID()}},refs)).rejects.toMatchObject({code:'NM005'});
  await expect(workerPool.query('SELECT pactwoven.native_memory_task_read($1,$2::jsonb,$3::jsonb)',['simulation',{organizationId:actor.organizationId,taskId:ctx.usage.taskId,generation:1,handoffId:ctx.usage.handoffId,leaseToken:randomUUID()},m])).rejects.toBeDefined();
 });
 it.each(['clear','unresolved'] as const)('stores %s data and enforces its retrieval eligibility',async conflict=>{
  const s=await source(),m=await memory(s,{conflict});
  if(conflict==='clear')expect((await read(m)).memory.reference).toEqual(m);else await expect(read(m)).rejects.toMatchObject({code:'MEMORY_UNAVAILABLE'});
 });
 it('fails safe on source tombstones and preserves original chronology',async()=>{
  const s=await source(),m=await memory(s),r=await stored(s);
  await api.source(actor,randomUUID(),{kind:'delete',expected:s,record:{...r,revision:2,status:'revoked'}});
  await expect(read(m)).rejects.toMatchObject({code:'VERSION_CONFLICT'});
  await expect(api.source(actor,randomUUID(),{kind:'create',expected:null,record:{...r,revision:1}})).rejects.toMatchObject({code:'VERSION_CONFLICT'});
 });
 it('retains immutable history even against accidental owner DML',async()=>{
  const s=await source(),m=await memory(s);
  for(const query of ["UPDATE pactwoven.native_memory_revisions SET record=record WHERE organization_id=$1",'DELETE FROM pactwoven.native_memory_heads WHERE organization_id=$1'])
   await expect(admin.query(query,[actor.organizationId])).rejects.toMatchObject({code:'NM005'});
  await expect(admin.query('TRUNCATE pactwoven.native_memory_usages')).rejects.toMatchObject({code:'NM005'});
  expect((await read(m)).memory.reference).toEqual(m);
 });
 it('rejects malformed null or unknown fields at the database boundary',async()=>{
  const s=await source(),r=memoryRecord(s);
  for(const invalid of [null,[],{...r,validUntil:null},{...r,confidence:null},{...r,extra:true},{...r,content:{...r.content,attributes:[]}}]) {
   const result=await admin.query('SELECT pactwoven.native_memory_record_valid($1::jsonb) AS valid',[JSON.stringify(invalid)]);expect(result.rows[0].valid).toBe(false);
   await expect(apiPool.query('SELECT pactwoven.native_memory_human_mutate($1::jsonb,$2,$3::jsonb)',[actor,randomUUID(),JSON.stringify({kind:'create',expected:null,record:invalid})])).rejects.toMatchObject({code:'NM004'});
  }
 });
 it('serializes publication validation with source mutation under the scope fence',async()=>{
  const s=await source(),m=await memory(s),ctx=taskContext(),u=await select(ctx,m),client=await admin.connect();
  try {
   await client.query('BEGIN');await client.query('SELECT pactwoven.native_memory_assert_usage_locked($1,$2::jsonb,$3::jsonb,$4)',['simulation',ctx,JSON.stringify([{usageId:u.usageId,selectionDigest:u.receipt.digest}]),'f'.repeat(64)]);
   const r=await stored(s);const change=api.source(actor,randomUUID(),{kind:'correct',expected:s,record:{...r,revision:2}});
   await admin.query('SELECT pg_sleep(0.05)');
   expect((await admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND usename='pactwoven_memory_test_api' AND wait_event_type='Lock'")).rows[0].n).toBe(1);
   await client.query('COMMIT');await change;
   await expect(assertUsage(ctx,[{usageId:u.usageId,selectionDigest:u.receipt.digest}])).rejects.toMatchObject({code:'NM005'});
  }finally{await client.query('ROLLBACK');client.release();}
 });
 it('allows longest depth16 and rejects17 with no orphan revision, request or outbox',async()=>{
  const s=await source();let head=await memory(s);const all=[head];
  for(let i=1;i<16;i++){head=await memory(s,{inputs:{sources:[],memories:[head]}});all.push(head);}
  expect((await read(head)).receipt.selection.memories).toHaveLength(16);
  const record=memoryRecord(s,{inputs:{sources:[],memories:[all[8]!,head]}}),key=randomUUID();
  await expect(api.mutate(actor,key,{kind:'create',expected:null,record})).rejects.toMatchObject({code:'MEMORY_LIMIT'});
  expect(await api.recover(actor,record.siteId,key)).toBeNull();
  expect((await admin.query('SELECT count(*)::int n FROM pactwoven.native_memory_revisions WHERE organization_id=$1',[actor.organizationId])).rows[0].n).toBe(16);
  expect((await admin.query('SELECT count(*)::int n FROM pactwoven.native_memory_invalidation_outbox WHERE organization_id=$1',[actor.organizationId])).rows[0].n).toBe(17);
 });
 it('bounds the combined graph at128 and rejects129',async()=>{
  const refs:NativeMemorySourceReference[]=[];for(let i=0;i<124;i++)refs.push(await source());
  const branches:NativeMemoryReference[]=[];
  for(let i=0;i<4;i++)branches.push(await memory(refs[0]!,{inputs:{sources:refs.slice(i*31,i===3?123:(i+1)*31),memories:[]}}));
  const root=await memory(refs[0]!,{inputs:{sources:[],memories:branches}});
  const readResult=await read(root);expect(readResult.receipt.selection.memories.length+readResult.receipt.selection.sources.length).toBe(128);
  const fourth=await memory(refs[0]!,{inputs:{sources:refs.slice(93),memories:[]}});
  await expect(memory(refs[0]!,{inputs:{sources:[],memories:[...branches.slice(0,3),fourth]}})).rejects.toMatchObject({code:'MEMORY_LIMIT'});
 });
 it('allows only one winner when two corrections race on one exact predecessor',async()=>{
  const s=await source(),m=await memory(s),r=await stored(m);
  const correction=(summary:string)=>api.mutate(actor,randomUUID(),{kind:'correct',expected:m,record:{...r,revision:2,previous:m,content:{...r.content,summary}}});
  const results=await Promise.allSettled([correction('Green'),correction('Red')]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  const failure=results.find(r=>r.status==='rejected');expect(failure?.status==='rejected'&&failure.reason.code).toBe('VERSION_CONFLICT');
 });
 it('denies a correction that closes a logical dependency cycle',async()=>{
  const s=await source(),a=await memory(s),b=await memory(s,{inputs:{sources:[],memories:[a]}}),r=await stored(a);
  await expect(api.mutate(actor,randomUUID(),{kind:'correct',expected:a,record:{...r,revision:2,previous:a,inputs:{sources:[],memories:[b]}}})).rejects.toMatchObject({code:'VERSION_CONFLICT'});
  expect((await read(a)).memory.reference).toEqual(a);
 });
 it('rechecks expiring human membership after waiting for the memory fence',async()=>{
  const s=await source(),m=await memory(s),client=await admin.connect();
  await admin.query("UPDATE pactwoven.memberships SET expires_at=clock_timestamp()+interval '0.4 seconds' WHERE environment='simulation' AND organization_id=$1 AND actor_id=$2",[actor.organizationId,actor.actorId]);
  try {
   await client.query('BEGIN');await client.query('SELECT generation FROM pactwoven.native_memory_scope_fences WHERE organization_id=$1 FOR UPDATE',[actor.organizationId]);
   const pending=expect(read(m)).rejects.toMatchObject({code:'EVIDENCE_STALE'});
   await admin.query('SELECT pg_sleep(0.55)');await client.query('COMMIT');await pending;
  }finally{await client.query('ROLLBACK');client.release();}
 });
 it('rolls back usage binding when authority expires after its candidate write',async()=>{
  const s=await source(),m=await memory(s),ctx=taskContext(),u=await select(ctx,m);ctx.validUntil=instant(350);
  await admin.query(`CREATE FUNCTION pactwoven.memory_test_delay() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN PERFORM pg_sleep(0.5);RETURN NEW;END $$;
    REVOKE ALL ON FUNCTION pactwoven.memory_test_delay() FROM PUBLIC;
    CREATE TRIGGER memory_test_delay AFTER UPDATE ON pactwoven.native_memory_usages FOR EACH ROW EXECUTE FUNCTION pactwoven.memory_test_delay();`);
  try{
   await expect(admin.query('SELECT pactwoven.native_memory_bind_artifact_locked($1,$2::jsonb,$3::jsonb,$4)',['simulation',ctx,JSON.stringify([{usageId:u.usageId,selectionDigest:u.receipt.digest}]),'f'.repeat(64)])).rejects.toMatchObject({code:'NM008'});
   expect((await admin.query('SELECT publication_digest FROM pactwoven.native_memory_usages WHERE id=$1',[u.usageId])).rows[0].publication_digest).toBeNull();
  }finally{await admin.query('DROP TRIGGER memory_test_delay ON pactwoven.native_memory_usages;DROP FUNCTION pactwoven.memory_test_delay()');}
 });
 it('matches UTF16 text limits and rejects noncanonical clock fields',async()=>{
  const s=await source();const m=await memory(s,{content:{title:'🧶'.repeat(90),summary:'Line\nquote " / \\ Ω',attributes:{safe:Number.MAX_SAFE_INTEGER,low:-Number.MAX_SAFE_INTEGER}}});
  expect((await snapshotNativeMemory(await stored(m))).reference).toEqual(m);
  expect((await admin.query('SELECT pactwoven.native_memory_text($1::jsonb,1,180) AS ok',[JSON.stringify('🧶'.repeat(91))])).rows[0].ok).toBe(false);
  for(const value of ['2026-11-18T24:00:00Z','2026-11-18T10:59:60Z','2026-02-30T10:00:00Z','2026-11-18T10:00:00.1234Z'])
   expect((await admin.query('SELECT pactwoven.native_memory_time($1::jsonb) AS value',[JSON.stringify(value)])).rows[0].value).toBeNull();
 });

 it('exposes original data expiry separately from a shorter renewed authority bound',async()=>{
  const sourceEnd=instant(5000),s=await source({validUntil:sourceEnd}),m=await memory(s),ctx=taskContext(),u=await select(ctx,m);
  ctx.validUntil=instant(2000);const refs=[{usageId:u.usageId,selectionDigest:u.receipt.digest}];
  const checked=(await assertUsage(ctx,refs)).rows[0].r;
  expect(checked.dataValidUntil).toBe(sourceEnd);expect(checked.validUntil).toBe(ctx.validUntil);
  const empty=(await assertUsage(taskContext(),[])).rows[0].r;expect(empty.dataValidUntil).toBeNull();
  const bound=(await admin.query('SELECT pactwoven.native_memory_bind_artifact_locked($1,$2::jsonb,$3::jsonb,$4) AS r',['simulation',ctx,JSON.stringify(refs),'f'.repeat(64)])).rows[0].r;
  expect(bound).toEqual(checked);
 });

 it('resolves identical source/memory IDs only in the exact current scope and revision',async()=>{
  const firstSite=actor.siteIds[0]!,aSource=await source({sourceId:'shared_source'}),aMemory=await memory(aSource,{memoryId:'shared_memory'});
  const other=randomUUID();await admin.query("INSERT INTO pactwoven.sites(environment,organization_id,id,name,time_zone) VALUES('simulation',$1,$2,'Other site','America/Chicago')",[actor.organizationId,other]);
  await admin.query("INSERT INTO pactwoven.member_action_sites(environment,organization_id,actor_id,site_id) VALUES('simulation',$1,$2,$3)",[actor.organizationId,actor.actorId,other]);
  actor={...actor,siteIds:[other,firstSite],actionSiteIds:[other,firstSite]};
  const bSource=await source({sourceId:'shared_source'}),bMemory=await memory(bSource,{memoryId:'shared_memory'});
  await expect(memory({...aSource,siteId:other})).rejects.toMatchObject({code:'VERSION_CONFLICT'});
  await expect(memory(bSource,{inputs:{sources:[],memories:[{...aMemory,siteId:other}]}})).rejects.toMatchObject({code:'VERSION_CONFLICT'});
  expect((await read(await memory(bSource,{inputs:{sources:[],memories:[bMemory]}}))).receipt.selection.sources).toEqual([bSource]);
  const ownActor=actor,foreignOrg='foreign_'+randomUUID(),foreignActor=randomUUID();
  await admin.query("INSERT INTO pactwoven.organizations(environment,id,external_organization_id,name) VALUES('simulation',$1,$1,'Foreign scope')",[foreignOrg]);
  await admin.query("INSERT INTO pactwoven.memberships(environment,organization_id,actor_id,external_subject,roles) VALUES('simulation',$1,$2,$2,ARRAY['owner'])",[foreignOrg,foreignActor]);
  await admin.query("INSERT INTO pactwoven.sites(environment,organization_id,id,name,time_zone) VALUES('simulation',$1,$2,'Same site identity elsewhere','America/Chicago')",[foreignOrg,other]);
  await admin.query("INSERT INTO pactwoven.member_action_sites(environment,organization_id,actor_id,site_id) VALUES('simulation',$1,$2,$3)",[foreignOrg,foreignActor,other]);
  actor={...actor,organizationId:foreignOrg,actorId:foreignActor,siteIds:[other],actionSiteIds:[other],sessionId:randomUUID()};
  const foreignSource=await source({sourceId:'shared_source'}),foreignMemory=await memory(foreignSource,{memoryId:'shared_memory'});actor=ownActor;
  await expect(memory({...foreignSource,organizationId:actor.organizationId})).rejects.toMatchObject({code:'VERSION_CONFLICT'});
  await expect(memory(bSource,{inputs:{sources:[],memories:[{...foreignMemory,organizationId:actor.organizationId}]}})).rejects.toMatchObject({code:'VERSION_CONFLICT'});
  const old=await stored(bSource);await api.source(actor,randomUUID(),{kind:'correct',expected:bSource,record:{...old,revision:2}});
  await expect(memory(bSource)).rejects.toMatchObject({code:'VERSION_CONFLICT'});
  actor={...actor,siteIds:[firstSite,other],actionSiteIds:[firstSite,other]};expect((await read(aMemory)).receipt.selection.sources).toEqual([aSource]);
 });

});
