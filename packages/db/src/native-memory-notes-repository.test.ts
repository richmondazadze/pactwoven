import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { beforeAll,beforeEach,afterAll,describe,expect,it } from 'vitest';
import type { ActorContext } from '../../contracts/src/core';
import type { NativeMemoryNoteCommand,NativeMemoryNoteDetail } from '../../contracts/src/native-memory-http';
import type { NativeMemoryActiveRecord,NativeMemoryReference,NativeMemorySourceRecord,NativeMemorySourceReference } from '../../contracts/src/native-memory';
import { PostgresNativeMemoryNotesRepository } from './native-memory-notes-repository';
const url=process.env.PACTWOVEN_MEMORY_TEST_DATABASE_URL;
describe.skipIf(!url)('atomic human memory notes PostgreSQL',()=>{
 let admin:Pool,pool:Pool,repo:PostgresNativeMemoryNotesRepository,actor:ActorContext;
 beforeAll(async()=>{
  const u=new URL(url!);if(!['127.0.0.1','localhost'].includes(u.hostname)||!u.pathname.startsWith('/pactwoven_native_memory_'))throw new Error('Disposable local memory database required');
  admin=new Pool({connectionString:url,max:3});
  await admin.query(`DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='pactwoven_note_test_api') THEN CREATE ROLE pactwoven_note_test_api LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;END IF;END $$;
    GRANT pactwoven_native_delegation_api TO pactwoven_note_test_api;
    INSERT INTO pactwoven.native_delegation_services(environment,service_id,identity,purpose) VALUES('simulation','notes_api','{"serviceId":"notes_api","serviceVersion":1,"workloadIdentityId":"notes_api"}','api') ON CONFLICT DO NOTHING;
    INSERT INTO pactwoven.native_delegation_service_bindings(role_name,role_oid,environment,purpose,service_id) SELECT rolname,oid,'simulation','api','notes_api' FROM pg_roles WHERE rolname='pactwoven_note_test_api' ON CONFLICT DO NOTHING;`);
  const suppliedPassword=process.env.PACTWOVEN_MEMORY_NOTES_TEST_API_PASSWORD;
  if(process.env.CI==='true'&&!suppliedPassword)throw new Error('Dedicated note API test password is required in CI.');
  const apiPassword=suppliedPassword??randomUUID().replaceAll('-','')+randomUUID().replaceAll('-','');
  const passwordSql=await admin.query<{sql:string}>("SELECT format('ALTER ROLE pactwoven_note_test_api PASSWORD %L',$1::text) AS sql",[apiPassword]);
  await admin.query(passwordSql.rows[0]!.sql);
  u.username='pactwoven_note_test_api';u.password=apiPassword;pool=new Pool({connectionString:u.toString(),max:2});repo=new PostgresNativeMemoryNotesRepository(pool,'simulation');
 });
 beforeEach(async()=>{
  const org='notes_'+randomUUID(),id=randomUUID(),site=randomUUID();
  await admin.query("INSERT INTO pactwoven.organizations(environment,id,external_organization_id,name) VALUES('simulation',$1,$1,'Notes fixture')",[org]);
  await admin.query("INSERT INTO pactwoven.memberships(environment,organization_id,actor_id,external_subject,roles,display_name) VALUES('simulation',$1,$2,$2,ARRAY['owner'],'Test person')",[org,id]);
  await admin.query("INSERT INTO pactwoven.sites(environment,organization_id,id,name,time_zone) VALUES('simulation',$1,$2,'Test office','America/Chicago')",[org,site]);
  await admin.query("INSERT INTO pactwoven.member_action_sites(environment,organization_id,actor_id,site_id) VALUES('simulation',$1,$2,$3)",[org,id,site]);
  actor={actorId:id,principalKind:'human',environment:'simulation',organizationId:org,roles:['owner'],siteIds:[site],actionSiteIds:[site],sessionId:randomUUID(),authenticatedAt:new Date().toISOString(),correlationId:randomUUID()};
 });
 afterAll(async()=>{await Promise.allSettled([admin?.end(),pool?.end()]);});
 const site=()=>actor.siteIds[0]!;
 const intent=(overrides:Record<string,unknown>={}):NativeMemoryNoteCommand=>({kind:'remember',siteId:site(),title:'Chair preference',text:'Prefer blue chairs.',purpose:'Buying office chairs',reviewBy:new Date(Date.now()+600000).toISOString(),...overrides} as NativeMemoryNoteCommand);
 const create=async()=>{const result=await repo.command(actor,randomUUID(),intent());expect(result.current).not.toBeNull();return result.current!;};
 const correction=(n:NativeMemoryNoteDetail,overrides:Record<string,unknown>={})=>intent({kind:'correct',noteId:n.id,expected:n.editToken,title:n.title,text:n.text,purpose:n.purpose,reviewBy:n.reviewBy,...overrides});
 const counts=async()=> (await admin.query(`SELECT jsonb_build_object('sources',(SELECT count(*) FROM pactwoven.native_memory_source_revisions WHERE organization_id=$1),
 'memories',(SELECT count(*) FROM pactwoven.native_memory_revisions WHERE organization_id=$1),'notes',(SELECT count(*) FROM pactwoven.native_memory_notes WHERE organization_id=$1),
 'operations',(SELECT count(*) FROM pactwoven.native_memory_note_operations WHERE organization_id=$1),'outbox',(SELECT count(*) FROM pactwoven.native_memory_invalidation_outbox WHERE organization_id=$1)) AS counts`,[actor.organizationId])).rows[0].counts;
 const currentRecords=async(id:string)=>(await admin.query<{memory:NativeMemoryActiveRecord;memory_ref:NativeMemoryReference;source:NativeMemorySourceRecord;source_ref:NativeMemorySourceReference}>(`SELECT
  m.record AS memory,pactwoven.native_memory_ref(m.record) AS memory_ref,s.record AS source,pactwoven.native_memory_ref(s.record,true) AS source_ref
  FROM pactwoven.native_memory_notes n JOIN pactwoven.native_memory_heads mh USING(environment,organization_id,site_id,memory_id)
  JOIN pactwoven.native_memory_revisions m USING(environment,organization_id,site_id,memory_id,revision,digest)
  JOIN pactwoven.native_memory_source_heads sh ON(sh.environment,sh.organization_id,sh.site_id,sh.source_id)=(n.environment,n.organization_id,n.site_id,n.source_id)
  JOIN pactwoven.native_memory_source_revisions s ON(s.environment,s.organization_id,s.site_id,s.source_id,s.revision,s.digest)=(sh.environment,sh.organization_id,sh.site_id,sh.source_id,sh.revision,sh.digest)
  WHERE n.organization_id=$1 AND n.id=$2`,[actor.organizationId,id])).rows[0]!;
 const peer=async()=>{
  const id=randomUUID();await admin.query("INSERT INTO pactwoven.memberships(environment,organization_id,actor_id,external_subject,roles,display_name) VALUES('simulation',$1,$2,$2,ARRAY['operations'],'Peer contributor')",[actor.organizationId,id]);
  await admin.query("INSERT INTO pactwoven.site_memberships(environment,organization_id,actor_id,site_id) VALUES('simulation',$1,$2,$3)",[actor.organizationId,id,site()]);
  await admin.query("INSERT INTO pactwoven.member_action_sites(environment,organization_id,actor_id,site_id) VALUES('simulation',$1,$2,$3)",[actor.organizationId,id,site()]);
  return {...actor,actorId:id,roles:['operations'],sessionId:randomUUID()} as ActorContext;
 };
 const correctSource=async(who:ActorContext,id:string,overrides:Partial<NativeMemorySourceRecord>={})=>{
  const r=await currentRecords(id);await pool.query('SELECT pactwoven.native_memory_human_source($1::jsonb,$2,$3::jsonb)',[who,randomUUID(),
   {kind:'correct',expected:r.source_ref,record:{...r.source,revision:r.source.revision+1,provenance:{kind:'user',actorId:who.actorId},...overrides}}]);
 };
 const correctMemory=async(who:ActorContext,id:string,overrides:Partial<NativeMemoryActiveRecord>={})=>{
  const r=await currentRecords(id);await pool.query('SELECT pactwoven.native_memory_human_mutate($1::jsonb,$2,$3::jsonb)',[who,randomUUID(),
   {kind:'correct',expected:r.memory_ref,record:{...r.memory,revision:r.memory.revision+1,previous:r.memory_ref,inputs:{sources:[r.source_ref],memories:[]},provenance:{kind:'user',actorId:who.actorId},...overrides}}]);
 };
 const shareWith=async(id:string,who:ActorContext)=>{
  const r=await currentRecords(id),access={...r.source.access,readers:[...r.source.access.readers,{kind:'user' as const,id:who.actorId}]};
  await correctSource(actor,id,{access});await correctMemory(actor,id,{access});
 };
 it('lists an empty authorized site without creating a storage scope',async()=>{
  expect(await repo.list(actor,{siteId:site(),status:'all',limit:20})).toMatchObject({items:[],nextCursor:null});
  expect(await repo.recover(actor,site(),randomUUID())).toBeNull();
 });
 it('atomically creates a human note and returns readable current projections',async()=>{
  const n=await create();expect(n).toMatchObject({title:'Chair preference',text:'Prefer blue chairs.',purpose:'Buying office chairs',siteName:'Test office',suppliedBy:'Test person',status:'available',historyRetained:true});
  expect(await counts()).toEqual({sources:1,memories:1,notes:1,operations:1,outbox:2});
  expect((await repo.get(actor,site(),n.id)).note).toEqual(n);
  const page=await repo.list(actor,{siteId:site(),status:'all',limit:20});expect(page.items).toHaveLength(1);expect(page.items[0]).not.toHaveProperty('text');expect(page.items[0]).not.toHaveProperty('editToken');
 });
 it('uses server identities/timestamps and never returns source or authority internals',async()=>{
  const op=await repo.command(actor,randomUUID(),intent());const raw=JSON.stringify(op);
  for(const k of ['sourceId','memoryId','grantId','grantVersion','digest','leaseToken','provenance'])expect(raw).not.toContain('"'+k+'"');
  const record=(await admin.query('SELECT record FROM pactwoven.native_memory_source_revisions WHERE organization_id=$1',[actor.organizationId])).rows[0].record;
  expect(record.kind).toBe('user_statement');expect(record.verification).toBe('unverified');expect(record.provenance).toEqual({kind:'user',actorId:actor.actorId});
 });
 it('recovers exact original intent despite a later retry clock',async()=>{
  const key=randomUUID(),q=intent(),a=await repo.command(actor,key,q);await admin.query('SELECT pg_sleep(0.03)');const b=await repo.command(actor,key,q);
  expect(a).toEqual(b);expect(await repo.recover(actor,site(),key)).toEqual(a);expect(await counts()).toEqual({sources:1,memories:1,notes:1,operations:1,outbox:2});
  await expect(repo.command(actor,key,intent({text:'Different'}))).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
 });
 it('serializes identical concurrent intents to a single original result',async()=>{
  const key=randomUUID(),q=intent(),[a,b]=await Promise.all([repo.command(actor,key,q),repo.command(actor,key,q)]);expect(a).toEqual(b);expect((await counts()).operations).toBe(1);
 });
 it('corrects source and primary memory atomically with exact token CAS',async()=>{
  const n=await create(),q=correction(n,{text:'Prefer green chairs.'}),op=await repo.command(actor,randomUUID(),q);
  expect(op.current?.text).toBe('Prefer green chairs.');expect(op.current?.editToken).not.toBe(n.editToken);
  await expect(repo.command(actor,randomUUID(),q)).rejects.toMatchObject({code:'VERSION_CONFLICT'});
  expect(await counts()).toEqual({sources:2,memories:2,notes:1,operations:2,outbox:4});
 });
 it('keeps removal current projections content-free while retaining immutable history',async()=>{
  const q=intent(),key=randomUUID(),op=await repo.command(actor,key,q),n=op.current!;
  const removed=await repo.command(actor,randomUUID(),{kind:'remove',siteId:site(),noteId:n.id,expected:n.editToken!});
  expect(removed.current).toMatchObject({title:'Removed note',status:'removed',text:null,purpose:null,editToken:null,reviewBy:null,historyRetained:true});
  const recovered=await repo.recover(actor,site(),key);expect(recovered?.operationId).toBe(op.operationId);expect(recovered?.current?.text).toBeNull();
  expect((await repo.command(actor,key,q)).current?.text).toBeNull();
  expect((await admin.query("SELECT record#>>'{content,summary}' AS text FROM pactwoven.native_memory_revisions WHERE organization_id=$1 AND revision=1",[actor.organizationId])).rows[0].text).toBe('Prefer blue chairs.');
  await expect(repo.command(actor,randomUUID(),correction(n))).rejects.toMatchObject({code:'VERSION_CONFLICT'});
 });
 it('supports read-only maintenance of expired notes while marking them ineligible',async()=>{
  const n=await repo.command(actor,randomUUID(),intent({reviewBy:new Date(Date.now()+250).toISOString()}));await admin.query('SELECT pg_sleep(0.3)');
  const detail=(await repo.get(actor,site(),n.noteId)).note;expect(detail.status).toBe('needs_review');expect(detail.text).toBe('Prefer blue chairs.');expect(detail.editToken).not.toBeNull();
  expect((await repo.list(actor,{siteId:site(),status:'available',limit:20})).items).toEqual([]);
  expect((await repo.list(actor,{siteId:site(),status:'needs_review',limit:20})).items).toHaveLength(1);
 });
 it('pages deterministically and binds opaque cursors to actor/site/filter',async()=>{
  for(let i=0;i<5;i++)await repo.command(actor,randomUUID(),intent({title:'Note '+i}));
  const first=await repo.list(actor,{siteId:site(),status:'all',limit:2});expect(first.items).toHaveLength(2);expect(first.nextCursor).not.toBeNull();
  const second=await repo.list(actor,{siteId:site(),status:'all',limit:2,cursor:first.nextCursor!});expect(second.items).toHaveLength(2);expect(new Set([...first.items,...second.items].map(n=>n.id)).size).toBe(4);
  const third=await repo.list(actor,{siteId:site(),status:'all',limit:2,cursor:second.nextCursor!});expect(third.items).toHaveLength(1);expect(third.nextCursor).toBeNull();
  await expect(repo.list(actor,{siteId:site(),status:'removed',limit:2,cursor:first.nextCursor!})).rejects.toMatchObject({code:'VALIDATION_FAILED'});
 });
 it('denies foreign identities and forged live-role claims',async()=>{
  const n=await create();await admin.query("UPDATE pactwoven.memberships SET roles=ARRAY['auditor'] WHERE organization_id=$1 AND actor_id=$2",[actor.organizationId,actor.actorId]);
  expect((await repo.get(actor,site(),n.id)).note.editToken).toBeNull();
  await expect(repo.command(actor,randomUUID(),correction(n))).rejects.toMatchObject({code:'FORBIDDEN'});
  await expect(repo.get({...actor,actorId:'stranger'},site(),n.id)).rejects.toMatchObject({code:'FORBIDDEN'});
 });
 it('rolls back source/memory/outbox when the parent receipt fails after both writes',async()=>{
  await admin.query(`CREATE FUNCTION pactwoven.notes_test_fail() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN RAISE EXCEPTION USING ERRCODE='NM009',MESSAGE='Synthetic receipt failure';END $$;
   REVOKE ALL ON FUNCTION pactwoven.notes_test_fail() FROM PUBLIC;CREATE TRIGGER notes_test_fail BEFORE INSERT ON pactwoven.native_memory_note_operations FOR EACH ROW EXECUTE FUNCTION pactwoven.notes_test_fail();`);
  const key=randomUUID();try{await expect(repo.command(actor,key,intent())).rejects.toMatchObject({code:'MEMORY_INTEGRITY'});expect(await counts()).toEqual({sources:0,memories:0,notes:0,operations:0,outbox:0});expect(await repo.recover(actor,site(),key)).toBeNull();}
  finally{await admin.query('DROP TRIGGER notes_test_fail ON pactwoven.native_memory_note_operations;DROP FUNCTION pactwoven.notes_test_fail()');}
 });
 it('rechecks finite membership expiry after scope lock waits',async()=>{
  await create();const blocker=await admin.connect();
  await admin.query("UPDATE pactwoven.memberships SET expires_at=clock_timestamp()+interval '0.4 seconds' WHERE organization_id=$1 AND actor_id=$2",[actor.organizationId,actor.actorId]);
  try{await blocker.query('BEGIN');await blocker.query('SELECT generation FROM pactwoven.native_memory_scope_fences WHERE organization_id=$1 FOR UPDATE',[actor.organizationId]);
   const pending=expect(repo.command(actor,randomUUID(),intent())).rejects.toMatchObject({code:'EVIDENCE_STALE'});await admin.query('SELECT pg_sleep(0.55)');await blocker.query('COMMIT');await pending;expect((await counts()).notes).toBe(1);
  }finally{await blocker.query('ROLLBACK');blocker.release();}
 });
 it('does not grant direct note rows or private projection helpers to API roles',async()=>{
  for(const q of ['SELECT * FROM pactwoven.native_memory_notes','SELECT * FROM pactwoven.native_memory_note_operations',"SELECT pactwoven.native_memory_notes_project_locked('{}','id')"])
   await expect(pool.query(q)).rejects.toMatchObject({code:'42501'});
 });
 it('rejects raw SQL attempts to supply provider trust and stale deadlines',async()=>{
  for(const q of [{...intent(),verification:'verified'},intent({reviewBy:'2020-01-01T00:00:00Z'}),intent({title:' '})])
   await expect(pool.query('SELECT pactwoven.native_memory_notes_command($1::jsonb,$2,$3::jsonb)',[actor,randomUUID(),q])).rejects.toBeDefined();
  expect((await counts()).notes).toBe(0);
 });
 it('recovers a committed command after a simulated lost transport response',async()=>{
  const key=randomUUID(),q=intent(),uncertain=new PostgresNativeMemoryNotesRepository({query:async(...args:unknown[])=>{await (pool.query as (...a:unknown[])=>Promise<unknown>)(...args);throw new Error('Synthetic response loss');}} as unknown as Pool,'simulation');
  await expect(uncertain.command(actor,key,q)).rejects.toMatchObject({code:'DURABLE_SERVICE_UNAVAILABLE'});
  const recovered=await repo.recover(actor,site(),key);expect(recovered?.current?.text).toBe('Prefer blue chairs.');
  expect((await repo.command(actor,key,q)).operationId).toBe(recovered?.operationId);expect((await counts()).operations).toBe(1);
 });
 it('recovers original metadata in a freshly authenticated session without replaying old body',async()=>{
  const key=randomUUID(),op=await repo.command(actor,key,intent()),n=op.current!;
  await repo.command(actor,randomUUID(),correction(n,{text:'Updated preference.'}));
  await admin.query("INSERT INTO pactwoven.session_revocations(environment,session_id) VALUES('simulation',$1)",[actor.sessionId]);
  await expect(repo.recover(actor,site(),key)).rejects.toMatchObject({code:'FORBIDDEN'});
  const fresh={...actor,sessionId:randomUUID(),authenticatedAt:new Date().toISOString()};const recovered=await repo.recover(fresh,site(),key);
  expect(recovered?.operationId).toBe(op.operationId);expect(recovered?.action).toBe('remember');expect(recovered?.current?.text).toBe('Updated preference.');
 });
 it('serializes a request key across two sites and rolls back the losing intent',async()=>{
  const other=randomUUID();await admin.query("INSERT INTO pactwoven.sites(environment,organization_id,id,name,time_zone) VALUES('simulation',$1,$2,'Second office','America/Chicago')",[actor.organizationId,other]);
  await admin.query("INSERT INTO pactwoven.member_action_sites(environment,organization_id,actor_id,site_id) VALUES('simulation',$1,$2,$3)",[actor.organizationId,actor.actorId,other]);
  actor={...actor,siteIds:[site(),other],actionSiteIds:[site(),other]};const key=randomUUID();
  const results=await Promise.allSettled([repo.command(actor,key,intent()),repo.command(actor,key,intent({siteId:other}))]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);const failed=results.find(r=>r.status==='rejected');expect(failed?.status==='rejected'&&failed.reason.code).toBe('IDEMPOTENCY_CONFLICT');
  expect((await counts()).notes).toBe(1);expect((await counts()).sources).toBe(1);
 });
 it('preserves a narrowed source audience during a readable-note correction',async()=>{
  const n=await create();const source=(await admin.query(`SELECT v.record,pactwoven.native_memory_ref(v.record,true) AS ref FROM pactwoven.native_memory_notes n
   JOIN pactwoven.native_memory_source_heads h USING(environment,organization_id,site_id,source_id) JOIN pactwoven.native_memory_source_revisions v USING(environment,organization_id,site_id,source_id,revision,digest)
   WHERE n.organization_id=$1 AND n.id=$2`,[actor.organizationId,n.id])).rows[0];
  const narrowed={...source.record,revision:2,access:{readers:[{kind:'user',id:actor.actorId}],purposes:['human_review']}};
  await pool.query('SELECT pactwoven.native_memory_human_source($1::jsonb,$2,$3::jsonb)',[actor,randomUUID(),{kind:'correct',expected:source.ref,record:narrowed}]);
  const current=(await repo.get(actor,site(),n.id)).note;const corrected=await repo.command(actor,randomUUID(),correction(current,{text:'New statement.'}));expect(corrected.current?.text).toBe('New statement.');
  const rows=(await admin.query("SELECT record->'access' AS access FROM pactwoven.native_memory_source_revisions WHERE organization_id=$1 AND revision=3",[actor.organizationId])).rows;
  expect(rows[0].access).toEqual(narrowed.access);
 });

 it('attributes a peer correction to current matching provenance without transferring maintenance ownership',async()=>{
  const n=await create(),b=await peer();await shareWith(n.id,b);
  const body={title:n.title,text:'Peer supplied new statement.',purpose:n.purpose};
  const digest=(await admin.query("SELECT pactwoven.native_memory_hash(jsonb_build_object('namespace','pactwoven/human-memory-statement/v1','body',$1::jsonb)) AS value",[body])).rows[0].value;
  await correctSource(b,n.id,{contentDigest:digest});const before=await currentRecords(n.id);
  await correctMemory(b,n.id,{content:{...before.memory.content,summary:body.text}});
  const detail=(await repo.get(actor,site(),n.id)).note;
  expect(detail).toMatchObject({text:body.text,suppliedBy:'Peer contributor',status:'available',sourceLabel:'Human statement — not independently verified'});
  expect((await repo.list(actor,{siteId:site(),status:'available',limit:20})).items[0]?.suppliedBy).toBe('Peer contributor');
  await expect(repo.get(b,site(),n.id)).rejects.toMatchObject({code:'NOT_FOUND'});
  await expect(repo.command(b,randomUUID(),correction(detail))).rejects.toMatchObject({code:'NOT_FOUND'});
  const after=await currentRecords(n.id);expect(after.memory.access).toEqual(before.memory.access);expect(after.source.access).toEqual(before.source.access);
  expect((await repo.command(actor,randomUUID(),correction(detail))).current?.suppliedBy).toBe('Test person');
 });
 it('marks divergent human provenance for review without naming either contributor',async()=>{
  const n=await create(),b=await peer();await shareWith(n.id,b);await correctMemory(b,n.id);
  const detail=(await repo.get(actor,site(),n.id)).note;
  expect(detail).toMatchObject({text:n.text,status:'needs_review',suppliedBy:'Multiple contributors',sourceLabel:'Source attribution needs review'});
  expect((await repo.list(actor,{siteId:site(),status:'available',limit:20})).items).toEqual([]);
  expect((await repo.list(actor,{siteId:site(),status:'needs_review',limit:20})).items[0]?.suppliedBy).toBe('Multiple contributors');
 });
 it.each(['revoked','expired','blank'] as const)('uses a generic label when the current contributor membership is %s',async condition=>{
  const n=await create(),b=await peer();await shareWith(n.id,b);await correctSource(b,n.id);await correctMemory(b,n.id);
  if(condition==='revoked')await admin.query("UPDATE pactwoven.memberships SET status='revoked' WHERE organization_id=$1 AND actor_id=$2",[actor.organizationId,b.actorId]);
  if(condition==='expired')await admin.query("UPDATE pactwoven.memberships SET expires_at=clock_timestamp()-interval '1 second' WHERE organization_id=$1 AND actor_id=$2",[actor.organizationId,b.actorId]);
  if(condition==='blank')await admin.query("UPDATE pactwoven.memberships SET display_name=' ' WHERE organization_id=$1 AND actor_id=$2",[actor.organizationId,b.actorId]);
  expect((await repo.get(actor,site(),n.id)).note).toMatchObject({status:'available',suppliedBy:'Workspace contributor',sourceLabel:'Human statement — not independently verified'});
 });
 it.each(['document','verified','agent'] as const)('does not label an unsupported %s source as a human statement',async condition=>{
  const n=await create(),r=await currentRecords(n.id),source={...r.source,revision:r.source.revision+1,
   ...(condition==='document'?{kind:'document' as const}:condition==='verified'?{verification:'verified' as const}:{provenance:{kind:'agent' as const,agentId:'fixture-agent',taskId:'fixture-task',handoffId:'fixture-handoff'}})};
  // Trusted-owner fixture only: public human ingress rejects these source kinds.
  // Append a valid descriptor and advance its head with every guard still enabled.
  const client=await admin.connect();try{await client.query('BEGIN');
   await client.query(`INSERT INTO pactwoven.native_memory_source_revisions(environment,organization_id,site_id,source_id,revision,digest,record,previous_revision,previous_digest)
    SELECT $1::jsonb->>'environment',$1::jsonb->>'organizationId',$1::jsonb->>'siteId',$1::jsonb->>'sourceId',($1::jsonb->>'revision')::bigint,pactwoven.native_memory_ref($1::jsonb,true)->>'digest',$1::jsonb,($2::jsonb->>'revision')::bigint,$2::jsonb->>'digest'`,[source,r.source_ref]);
   await client.query(`UPDATE pactwoven.native_memory_source_heads SET revision=($1::jsonb->>'revision')::bigint,digest=pactwoven.native_memory_ref($1::jsonb,true)->>'digest'
    WHERE(environment,organization_id,site_id,source_id)=($1::jsonb->>'environment',$1::jsonb->>'organizationId',$1::jsonb->>'siteId',$1::jsonb->>'sourceId')`,[source]);
   await client.query('COMMIT');
  }finally{await client.query('ROLLBACK');client.release();}
  await correctMemory(actor,n.id);
  expect((await repo.get(actor,site(),n.id)).note).toMatchObject({status:'needs_review',suppliedBy:'Contributor needs review',sourceLabel:'Source attribution needs review',text:n.text});
 });
 it('keeps removed content hidden when terminal source provenance differs from memory provenance',async()=>{
  const n=await create(),b=await peer();await shareWith(n.id,b);const r=await currentRecords(n.id);
  await pool.query('SELECT pactwoven.native_memory_human_source($1::jsonb,$2,$3::jsonb)',[b,randomUUID(),{kind:'delete',expected:r.source_ref,
   record:{...r.source,revision:r.source.revision+1,status:'deleted',provenance:{kind:'user',actorId:b.actorId}}}]);
  expect((await repo.get(actor,site(),n.id)).note).toMatchObject({status:'removed',title:'Removed note',text:null,purpose:null,reviewBy:null,editToken:null,
   suppliedBy:'Multiple contributors',sourceLabel:'Source attribution needs review'});
 });

 it('returns a bounded empty filtered page with a continuation until the scan completes',async()=>{
  for(let i=0;i<257;i++)await repo.command(actor,randomUUID(),intent({title:'Note '+i}));
  const first=await repo.list(actor,{siteId:site(),status:'removed',limit:20});expect(first.items).toEqual([]);expect(first.nextCursor).not.toBeNull();
  const last=await repo.list(actor,{siteId:site(),status:'removed',limit:20,cursor:first.nextCursor!});expect(last.items).toEqual([]);expect(last.nextCursor).toBeNull();
 },30_000);

});
