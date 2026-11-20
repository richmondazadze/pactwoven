import { randomBytes,randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { beforeAll,afterAll,describe,it,expect } from 'vitest';
import type { ActorContext } from '../../contracts/src/core';
import { commandDigest } from '../../contracts/src/canonical';
import { NativeAdvisoryGrantSchema,type NativeAdvisoryHandoff } from '../../contracts/src/native-delegation';
import { PostgresNativeDelegationRepository,PostgresNativeDelegationWorkerRepository,type NativeDelegationPublication,type NativeDelegationTarget } from './native-delegation-repository';
import { PostgresNativeRootRepository,PostgresNativeRootCoordinatorRepository,PostgresNativeRootWorkerRepository,PostgresNativeRootDispatchRepository } from './native-root-lifecycle-repository';
import { PostgresNativeMemoryNotesRepository } from './native-memory-notes-repository';
import { PostgresNativeMemoryTaskRepository } from './native-memory-repository';
import { NATIVE_ROOT_BLOCKED_RESULT,type NativeRootCheckpointCommand,type NativeRootCompleteCommand } from './native-root-lifecycle-schema';
const url=process.env.PACTWOVEN_ROOT_TEST_DATABASE_URL;
const at=(ms=0)=>new Date(Date.now()+ms).toISOString();
const id=()=>randomUUID().replaceAll('-','_');
const issuer='https://root-fixture.clerk.accounts.dev';
const identity=(serviceId:string)=>({serviceId,serviceVersion:1,workloadIdentityId:serviceId});
describe.skipIf(!url)('durable root lifecycle PostgreSQL',()=>{
 let admin:Pool,apiPool:Pool,coordinatorPool:Pool,workerPool:Pool,dispatcherPool:Pool;
 let api:PostgresNativeDelegationRepository,roots:PostgresNativeRootRepository,coordinator:PostgresNativeRootCoordinatorRepository,
  worker:PostgresNativeDelegationWorkerRepository,genericCoordinator:PostgresNativeDelegationWorkerRepository,materials:PostgresNativeRootWorkerRepository,
  dispatcher:PostgresNativeRootDispatchRepository,notes:PostgresNativeMemoryNotesRepository,memory:PostgresNativeMemoryTaskRepository;
 const coordinatorId=identity('root_coordinator_'+id()),workerId=identity('root_worker_'+id());
 beforeAll(async()=>{
  const u=new URL(url!);if(!['127.0.0.1','localhost'].includes(u.hostname)||!u.pathname.startsWith('/pactwoven_native_memory_'))throw new Error('Dedicated local root database required.');
  admin=new Pool({connectionString:url,max:3});const pools:Pool[]=[];
  // Retain old fixture evidence but exclude prior suite runs from this run's
  // environment-wide bounded recovery scan. This touches synthetic roots only.
  await admin.query("UPDATE pactwoven.native_delegation_root_runs r SET manual_paused=true WHERE EXISTS(SELECT 1 FROM pactwoven.organizations o WHERE(o.environment,o.id)=(r.environment,r.organization_id) AND o.name='Root fixture')");
  for(const purpose of ['api','coordinator','worker','dispatcher'] as const){
   const service=purpose==='coordinator'?coordinatorId:purpose==='worker'?workerId:identity('root_'+purpose+'_'+id());
   const role='root_test_'+purpose+'_'+id().slice(0,10),password=randomBytes(32).toString('base64url');
   const sql=(await admin.query<{sql:string}>("SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD %L',$1::text,$2::text) AS sql",[role,password])).rows[0]!.sql;
   await admin.query(sql);await admin.query(`GRANT pactwoven_native_delegation_${purpose} TO ${role}`);
   await admin.query("INSERT INTO pactwoven.native_delegation_services VALUES('simulation',$1,$2::jsonb,$3,true)",[service.serviceId,service,purpose]);
   await admin.query("INSERT INTO pactwoven.native_delegation_service_bindings SELECT rolname,oid,'simulation',$2,$3,true FROM pg_roles WHERE rolname=$1",[role,purpose,service.serviceId]);
   const connection=new URL(u);connection.username=role;connection.password=password;pools.push(new Pool({connectionString:connection.href,max:1}));
  }
  [apiPool,coordinatorPool,workerPool,dispatcherPool]=pools as [Pool,Pool,Pool,Pool];
  api=new PostgresNativeDelegationRepository(apiPool,'simulation');roots=new PostgresNativeRootRepository(apiPool,'simulation');
  coordinator=new PostgresNativeRootCoordinatorRepository(coordinatorPool,'simulation');genericCoordinator=new PostgresNativeDelegationWorkerRepository(coordinatorPool,'simulation');
  worker=new PostgresNativeDelegationWorkerRepository(workerPool,'simulation');materials=new PostgresNativeRootWorkerRepository(workerPool,'simulation');
  dispatcher=new PostgresNativeRootDispatchRepository(dispatcherPool,'simulation');notes=new PostgresNativeMemoryNotesRepository(apiPool,'simulation');memory=new PostgresNativeMemoryTaskRepository(workerPool,'simulation');
 });
 afterAll(async()=>{await Promise.allSettled([admin,apiPool,coordinatorPool,workerPool,dispatcherPool].filter(Boolean).map(p=>p.end()));});
 async function fixture(maxAttempts=4,withNote=false,bind=true,noRootAccess=false){
  const org=id(),actorId=id(),siteId=id(),legacy=id(),rootId=id();
  await admin.query("INSERT INTO pactwoven.organizations(environment,id,external_organization_id,name) VALUES('simulation',$1,$1,'Root fixture')",[org]);
  await admin.query("INSERT INTO pactwoven.memberships(environment,organization_id,actor_id,external_subject,external_membership_id,grant_basis,roles,display_name) VALUES('simulation',$1,$2,$2,$3,'internal',ARRAY['owner'],'Operator')",[org,actorId,'member_'+id()]);
  await admin.query("INSERT INTO pactwoven.sites(environment,organization_id,id,name,time_zone) VALUES('simulation',$1,$2,'Office','UTC')",[org,siteId]);
  await admin.query("INSERT INTO pactwoven.member_action_sites VALUES('simulation',$1,$2,$3)",[org,actorId,siteId]);
  await admin.query("INSERT INTO pactwoven.native_delegation_policies VALUES('simulation',$1,1,true)",[org]);
  const actor:ActorContext={environment:'simulation',organizationId:org,actorId,principalKind:'human',roles:['owner'],siteIds:[siteId],actionSiteIds:[siteId],sessionId:id(),authenticatedAt:at(-100),correlationId:id()};
  await admin.query("INSERT INTO pactwoven.native_tasks(environment,organization_id,id,actor_id,session_id,site_id,title,prompt,status,phase) VALUES('simulation',$1,$2,$3,$4,$5,'Choose chairs','Compare office chairs','paused','Delegated provenance')",[org,legacy,actorId,actor.sessionId,siteId]);
  const member=(await admin.query('SELECT external_membership_id FROM pactwoven.memberships WHERE organization_id=$1',[org])).rows[0];
  const scope={environment:'simulation' as const,organizationId:org,issuer:{actorId,providerIssuer:issuer,subject:actorId,externalOrganizationId:org,externalMembershipId:member.external_membership_id,membershipVersion:1},
   organizationEpoch:0,policyVersion:1,purpose:'Compare office chairs',sites:[{siteId,siteVersion:1}],capabilityVersion:1,capabilities:['draft_advice','read_scoped_memory','research_public_sources'],
   limits:{maxDepth:3,maxConcurrentChildren:3,maxChildren:32,maxAttempts,taskTimeoutMs:300000}};
  const request={grantId:id(),requestKey:id(),mode:'advise',externalEffects:'forbidden',scope,expiresAt:at(600000),continuesAfterSignOut:true};
  const grant=NativeAdvisoryGrantSchema.parse({schemaVersion:1,id:request.grantId,version:1,revocationEpoch:0,mode:'advise',externalEffects:'forbidden',scope,issuedAt:at(),expiresAt:request.expiresAt,
   issuance:{requestKey:request.requestKey,sessionId:actor.sessionId,authenticatedAt:actor.authenticatedAt,confirmedAt:at(-20),scopeDigest:await commandDigest(request),continuesAfterSignOut:true},revocation:null});
  const issuance={rootTaskId:rootId,service:coordinatorId,sessionVerifiedAt:at(),sessionExpiresAt:at(60000)};
  const issued=await api.issue(actor,legacy,grant,issuance);
  let note=withNote?(await notes.command(actor,id(),{kind:'remember',siteId,title:'Chair preference',text:'Prefer blue chairs.',purpose:'Office seating choices',reviewBy:at(180000)})).current!:null;
  if(note&&noRootAccess){
   const rows=await admin.query(`SELECT m.record AS memory,s.record AS source FROM pactwoven.native_memory_notes n
    JOIN pactwoven.native_memory_heads mh USING(environment,organization_id,site_id,memory_id) JOIN pactwoven.native_memory_revisions m USING(environment,organization_id,site_id,memory_id,revision,digest)
    JOIN pactwoven.native_memory_source_heads sh ON(sh.environment,sh.organization_id,sh.site_id,sh.source_id)=(n.environment,n.organization_id,n.site_id,n.source_id)
    JOIN pactwoven.native_memory_source_revisions s ON(s.environment,s.organization_id,s.site_id,s.source_id,s.revision,s.digest)=(sh.environment,sh.organization_id,sh.site_id,sh.source_id,sh.revision,sh.digest) WHERE n.id=$1`,[note.id]);
   const {memory:m,source:s}=rows.rows[0],access={...s.access,readers:s.access.readers.filter((reader:{id:string})=>reader.id!==coordinatorId.serviceId)};
   const refs=(await admin.query('SELECT pactwoven.native_memory_ref($1::jsonb) AS m,pactwoven.native_memory_ref($2::jsonb,true) AS s',[m,s])).rows[0];
   const changed=(await apiPool.query('SELECT pactwoven.native_memory_human_source($1::jsonb,$2,$3::jsonb) AS r',[actor,id(),{kind:'correct',expected:refs.s,record:{...s,revision:2,access}}])).rows[0].r;
   await apiPool.query('SELECT pactwoven.native_memory_human_mutate($1::jsonb,$2,$3::jsonb)',[actor,id(),{kind:'correct',expected:refs.m,record:{...m,revision:2,previous:refs.m,access,inputs:{sources:[changed.originalReference],memories:[]}}}]);
   note=(await notes.get(actor,siteId,note.id)).note;
  }
  if(bind)await roots.bindNotes(actor,id(),{rootTaskId:rootId,selections:note?[{noteId:note.id,expected:note.editToken!}]:[]});
  return {actor,siteId,legacy,rootId,issued,grant,note,target:{organizationId:org,taskId:rootId,generation:1}};
 }
 async function allow(target:NativeDelegationTarget,state:'allowed'|'denied'='allowed'){
  const p=await api.prepare(target,issuer);if(p.kind!=='prepared')throw new Error('Expected new provider challenge');
  return api.finish(p.nonce,{state,reason:state==='allowed'?'current':'revoked',observationStartedAt:at(-10),observationCompletedAt:at()});
 }
 async function running(maxAttempts=4,withNote=false,noRootAccess=false){const f=await fixture(maxAttempts,withNote,true,noRootAccess);await allow(f.target);return {...f,claim:await coordinator.claim(f.target,30000)};}
 const checkpoint=(overrides:Partial<NativeRootCheckpointCommand>={}):NativeRootCheckpointCommand=>({requestKey:id(),expectedCheckpointVersion:0,
  checkpoint:{stage:'planning',summary:'Compare alternatives.',steps:[{id:'chairs',title:'Review chair choices',state:'planned'}]},plannerState:'{"version":1}',inputReceipts:[],...overrides});
 async function child(withNote=false,noRootAccess=false,maxAttempts=4){
  const f=await running(maxAttempts,withNote,noRootAccess),work=await coordinator.work(f.claim.selector);
  const h:NativeAdvisoryHandoff={schemaVersion:1,handoffId:id(),environment:'simulation',organizationId:f.actor.organizationId,siteId:f.siteId,authority:f.issued.authority,
   rootTaskId:f.rootId,parentTaskId:f.rootId,childTaskId:id(),assignmentVersion:1,generation:1,sender:coordinatorId,recipient:workerId,
   capability:withNote?'read_scoped_memory':'research_public_sources',capabilityVersion:1,depth:1,attemptLimit:maxAttempts,taskTimeoutMs:300000,issuedAt:at(),deadlineAt:at(240000),inputArtifacts:[],outputContract:'advisory_artifacts_v1',correlationId:id()};
  const assignment={schemaVersion:1 as const,stepId:'chairs',title:'Review chairs',brief:'Compare the requested chair choices.',role:'research' as const,memoryReferences:work.memoryReferences};
  await coordinator.handoff(f.claim.selector,{requestKey:id(),handoff:h,assignment});
  const target={organizationId:f.actor.organizationId,taskId:h.childTaskId,generation:1};await allow(target);
  return {...f,h,assignment,childTarget:target,childClaim:await worker.claim(target,30000)};
 }
 async function publication(f:Awaited<ReturnType<typeof child>>,uses:NativeDelegationPublication['memoryUsage']=[]):Promise<NativeDelegationPublication>{
  const body={title:'Chair advice',text:'Prefer blue upholstery.'},reference={environment:'simulation' as const,organizationId:f.actor.organizationId,siteId:f.siteId,artifactId:id(),revision:1,digest:await commandDigest(body)};
  return {result:{schemaVersion:1,resultId:id(),handoffId:f.h.handoffId,handoffDigest:await commandDigest(f.h),environment:'simulation',organizationId:f.actor.organizationId,siteId:f.siteId,
   childTaskId:f.h.childTaskId,assignmentVersion:1,generation:1,authority:f.issued.authority,sender:workerId,recipient:coordinatorId,attempt:1,outcome:'advice_ready',artifacts:[reference],finishedAt:at(),evidenceValidUntil:at(60000)},artifacts:[{reference,body}],inputArtifacts:[],memoryUsage:uses};
 }
 async function changeReaders(f:Awaited<ReturnType<typeof child>>,actor:ActorContext,readers:Array<{kind:string;id:string}>,part:'both'|'source'|'memory'='both'){
  const rows=await admin.query(`SELECT m.record AS memory,s.record AS source FROM pactwoven.native_memory_notes n
   JOIN pactwoven.native_memory_heads mh USING(environment,organization_id,site_id,memory_id) JOIN pactwoven.native_memory_revisions m USING(environment,organization_id,site_id,memory_id,revision,digest)
   JOIN pactwoven.native_memory_source_heads sh ON(sh.environment,sh.organization_id,sh.site_id,sh.source_id)=(n.environment,n.organization_id,n.site_id,n.source_id)
   JOIN pactwoven.native_memory_source_revisions s ON(s.environment,s.organization_id,s.site_id,s.source_id,s.revision,s.digest)=(sh.environment,sh.organization_id,sh.site_id,sh.source_id,sh.revision,sh.digest) WHERE n.id=$1`,[f.note!.id]);
  const {memory:m,source:s}=rows.rows[0],refs=(await admin.query('SELECT pactwoven.native_memory_ref($1::jsonb) AS m,pactwoven.native_memory_ref($2::jsonb,true) AS s',[m,s])).rows[0];
  let sourceRef=refs.s;
  if(part!=='memory')sourceRef=(await apiPool.query('SELECT pactwoven.native_memory_human_source($1::jsonb,$2,$3::jsonb) AS r',[actor,id(),{kind:'correct',expected:refs.s,record:{...s,revision:s.revision+1,access:{...s.access,readers},provenance:{kind:'user',actorId:actor.actorId}}}])).rows[0].r.originalReference;
  if(part!=='source')await apiPool.query('SELECT pactwoven.native_memory_human_mutate($1::jsonb,$2,$3::jsonb)',[actor,id(),{kind:'correct',expected:refs.m,record:{...m,revision:m.revision+1,previous:refs.m,access:{...m.access,readers},provenance:{kind:'user',actorId:actor.actorId},inputs:{sources:[sourceRef],memories:[]}}}]);
 }
 const complete=(overrides:Partial<NativeRootCompleteCommand>={}):NativeRootCompleteCommand=>({requestKey:id(),expectedCheckpointVersion:0,inputReceipts:[],coverage:[],
  result:{outcome:'advice_ready',title:'Chair recommendation',summary:'Review the shortlisted blue chairs.',artifacts:[{id:'advice',title:'Recommendation',text:'Prefer blue chairs.'}],evidenceValidUntil:at(30000)},...overrides});
 it('uses the original total attempt bound and preserves inert v1 provenance',async()=>{
  const f=await fixture(2);const view=await roots.read(f.actor,f.rootId);expect(view).toMatchObject({state:'ready',attempt:1,attemptLimit:2,title:'Choose chairs'});
  expect(view.scope).toEqual({environment:'simulation',organizationId:f.actor.organizationId,siteId:f.siteId});expect(view.expiresAt).toBe(f.grant.expiresAt);expect(view.evidenceUnavailable).toBe(false);
  expect(Date.parse(view.updatedAt)).toBeLessThanOrEqual(Date.now());
  expect((await admin.query('SELECT status FROM pactwoven.native_tasks WHERE id=$1',[f.legacy])).rows[0].status).toBe('paused');
  expect((await admin.query('SELECT count(*)::int n FROM pactwoven.native_dispatch_outbox WHERE task_id=$1',[f.legacy])).rows[0].n).toBe(0);
 });
 it('requires explicit immutable note binding even for an empty selection before either root claim',async()=>{
  const f=await fixture(4,false,false);await allow(f.target);
  await expect(coordinator.claim(f.target)).rejects.toMatchObject({code:'FORBIDDEN'});await expect(genericCoordinator.claim(f.target)).rejects.toMatchObject({code:'FORBIDDEN'});
  await roots.bindNotes(f.actor,id(),{rootTaskId:f.rootId,selections:[]});expect((await coordinator.claim(f.target)).attempt).toBe(1);
 });
 it('persists a checkpoint and engine state while keeping engine state out of human projection',async()=>{
  const f=await running(),q=checkpoint();expect((await coordinator.checkpoint(f.claim.selector,q)).checkpointVersion).toBe(1);
  expect(await coordinator.checkpoint(f.claim.selector,q)).toMatchObject({checkpointVersion:1});
  const work=await coordinator.work(f.claim.selector);expect(work.plannerState).toBe(q.plannerState);expect(work.checkpoint).toEqual(q.checkpoint);
  expect(JSON.stringify(await roots.read(f.actor,f.rootId))).not.toContain('plannerState');
  await expect(coordinator.checkpoint(f.claim.selector,checkpoint())).rejects.toMatchObject({code:'ROOT_CONFLICT'});
 });
 it('yields with a durable receipt and reacquires with fresh proof without consuming an attempt',async()=>{
  const f=await running(),q={...checkpoint(),continuation:'continue' as const,waitFor:[]};const yielded=await coordinator.yield(f.claim.selector,q);
  expect(yielded).toMatchObject({generation:2,attempt:1,continuation:'yielded'});expect(await coordinator.yield(f.claim.selector,q)).toEqual(yielded);
  const target={...f.target,generation:2};await expect(coordinator.claim(target)).rejects.toMatchObject({code:'FORBIDDEN'});
  await allow(target);await expect(genericCoordinator.claim(target)).rejects.toBeDefined();const next=await coordinator.claim(target);
  expect(next.attempt).toBe(1);expect(next.selector.leaseToken).not.toBe(f.claim.selector.leaseToken);
  await expect(coordinator.checkpoint(f.claim.selector,checkpoint({expectedCheckpointVersion:1}))).rejects.toMatchObject({code:'FORBIDDEN'});
 });
 it('waits for declared children and emits one wake on their accepted result',async()=>{
  const f=await child();const yielded=await coordinator.yield(f.claim.selector,{...checkpoint(),continuation:'wait_children',waitFor:[f.h.childTaskId]});
  const target={...f.target,generation:yielded.generation};await allow(target);await expect(coordinator.claim(target)).rejects.toMatchObject({code:'ROOT_CONFLICT'});
  const p=await publication(f);await worker.result(f.childClaim.selector,p);await worker.result(f.childClaim.selector,p);
  expect((await admin.query('SELECT count(*)::int n FROM pactwoven.native_delegation_outbox WHERE task_id=$1 AND generation=$2',[f.rootId,yielded.generation])).rows[0].n).toBe(1);
  expect((await coordinator.claim(target)).attempt).toBe(1);
 });
 it('hands workers their exact durable brief and permitted material',async()=>{
  const f=await child();expect(await materials.materials(f.childClaim.selector)).toMatchObject({rootTitle:'Choose chairs',rootPrompt:'Compare office chairs',assignment:f.assignment,inputArtifacts:[]});
  await expect(materials.materials(f.claim.selector)).rejects.toBeDefined();
 });
 it('collects immutable child advice and atomically completes a root with every receipt',async()=>{
  const f=await child(),p=await publication(f),accepted=await worker.result(f.childClaim.selector,p);
  const input=await coordinator.inputs(f.claim.selector,{requestKey:id(),results:[{handoffId:f.h.handoffId,publicationDigest:accepted.publicationDigest}]});
  expect(input.results[0]?.artifacts).toEqual(p.artifacts);
  const q=complete({inputReceipts:[input.receipt],coverage:[{taskId:f.h.childTaskId,disposition:'advice_ready'}]});
  expect(await coordinator.complete(f.claim.selector,q)).toMatchObject({kind:'accepted',execution:'advisory_only',domainCompletion:false});
  expect(await coordinator.complete(f.claim.selector,q)).toMatchObject({kind:'duplicate',execution:'none'});expect((await roots.read(f.actor,f.rootId)).state).toBe('completed');
 });
 it('rejects completion while a child is active or successful child evidence is omitted',async()=>{
  const f=await child();await expect(coordinator.complete(f.claim.selector,complete())).rejects.toMatchObject({code:'ROOT_CONFLICT'});
  await worker.result(f.childClaim.selector,await publication(f));await expect(coordinator.complete(f.claim.selector,complete({coverage:[{taskId:f.h.childTaskId,disposition:'advice_ready'}]}))).rejects.toMatchObject({code:'EVIDENCE_STALE'});
 });
 it('revalidates original memory and the root reader before accepting transitive input',async()=>{
  const f=await child(true),reference=f.assignment.memoryReferences[0]!;
  const read=await memory.read({...f.childClaim.selector,handoffId:f.h.handoffId},reference);
  const p=await publication(f,[{usageId:read.usageId,selectionDigest:read.receipt.digest}]);const accepted=await worker.result(f.childClaim.selector,p);
  const input=await coordinator.inputs(f.claim.selector,{requestKey:id(),results:[{handoffId:f.h.handoffId,publicationDigest:accepted.publicationDigest}]});expect(input.dataValidUntil).not.toBeNull();
  await notes.command(f.actor,id(),{kind:'remove',siteId:f.siteId,noteId:f.note!.id,expected:f.note!.editToken!});
  await expect(coordinator.complete(f.claim.selector,complete({inputReceipts:[input.receipt],coverage:[{taskId:f.h.childTaskId,disposition:'advice_ready'}]}))).rejects.toMatchObject({code:'EVIDENCE_STALE'});
 });
 it('fences all unfinished children on human pause and preserves original control recovery',async()=>{
  const f=await child(),key=id(),q={rootTaskId:f.rootId,expectedVersion:1,action:'pause' as const};const receipt=await roots.control(f.actor,key,q);
  expect(receipt.scope).toEqual({environment:'simulation',organizationId:f.actor.organizationId,siteId:f.siteId});
  expect(receipt.state).toBe('paused');expect(await roots.recover(f.actor,f.rootId,key)).toEqual(receipt);expect(await roots.control(f.actor,key,q)).toEqual(receipt);
  await expect(worker.result(f.childClaim.selector,await publication(f))).rejects.toBeDefined();await expect(coordinator.checkpoint(f.claim.selector,checkpoint())).rejects.toMatchObject({code:'FORBIDDEN'});
  const resumed=await roots.control(f.actor,id(),{rootTaskId:f.rootId,expectedVersion:receipt.controlVersion,action:'resume'});expect(resumed.state).toBe('ready');
  const view=await roots.read(f.actor,f.rootId);expect(view.attempt).toBe(2);expect(view.coverage).toEqual([{taskId:f.h.childTaskId,disposition:'abandoned'}]);
  await expect(coordinator.claim({...f.target,generation:resumed.generation})).rejects.toMatchObject({code:'FORBIDDEN'});
 });
 it('never resets an exhausted attempt allowance on manual resume',async()=>{
  const f=await running(1);const paused=await roots.control(f.actor,id(),{rootTaskId:f.rootId,expectedVersion:1,action:'pause'});
  const resumed=await roots.control(f.actor,id(),{rootTaskId:f.rootId,expectedVersion:paused.controlVersion,action:'resume'});expect(resumed.state).toBe('blocked');
  expect(await roots.read(f.actor,f.rootId)).toMatchObject({state:'blocked',reason:'attempts_exhausted',attempt:1,attemptLimit:1});
 });
 it('does not expose root APIs or private helpers to worker and API service audiences',async()=>{
  for(const q of ["SELECT pactwoven.native_delegation_root_claim('simulation','{}',1000)","SELECT * FROM pactwoven.native_delegation_root_runs"])
   await expect(workerPool.query(q)).rejects.toMatchObject({code:'42501'});
  await expect(apiPool.query("SELECT pactwoven.native_delegation_root_context('simulation','{}',false)")).rejects.toMatchObject({code:'42501'});
 });
 it('rejects binding a note which changed after the operator review',async()=>{
  const f=await fixture(4,true,false),n=f.note!;
  await notes.command(f.actor,id(),{kind:'correct',siteId:f.siteId,noteId:n.id,expected:n.editToken!,title:n.title,text:'Now green chairs.',purpose:n.purpose!,reviewBy:n.reviewBy!});
  await expect(roots.bindNotes(f.actor,id(),{rootTaskId:f.rootId,selections:[{noteId:n.id,expected:n.editToken!}]})).rejects.toMatchObject({code:'EVIDENCE_STALE'});
  expect((await admin.query('SELECT count(*)::int n FROM pactwoven.native_delegation_root_note_selections WHERE root_task_id=$1',[f.rootId])).rows[0].n).toBe(0);
 });
 it('does not silently bind a foreign note or replace a committed selection',async()=>{
  const a=await fixture(4,true,false),b=await fixture(4,true,false);
  await expect(roots.bindNotes(a.actor,id(),{rootTaskId:a.rootId,selections:[{noteId:b.note!.id,expected:b.note!.editToken!}]})).rejects.toMatchObject({code:'FORBIDDEN'});
  const key=id(),q={rootTaskId:a.rootId,selections:[{noteId:a.note!.id,expected:a.note!.editToken!}]};const bound=await roots.bindNotes(a.actor,key,q);expect(await roots.bindNotes(a.actor,key,q)).toEqual(bound);
  await expect(roots.bindNotes(a.actor,key,{rootTaskId:a.rootId,selections:[]})).rejects.toMatchObject({code:'ROOT_CONFLICT'});
  await expect(roots.bindNotes(b.actor,id(),q)).rejects.toMatchObject({code:'FORBIDDEN'});
 });
 it('denies unselected and stale references through the original memory task endpoint',async()=>{
  const f=await child(true),ref=f.assignment.memoryReferences[0]!;
  const selector={...f.childClaim.selector,handoffId:f.h.handoffId};
  await expect(memory.read(selector,{...ref,memoryId:id()})).rejects.toMatchObject({code:'FORBIDDEN'});
  await expect(memory.read(selector,{...ref,revision:ref.revision+1})).rejects.toMatchObject({code:'FORBIDDEN'});
  await expect(memory.read(selector,{...ref,siteId:id()})).rejects.toMatchObject({code:'FORBIDDEN'});
  expect((await admin.query('SELECT count(*)::int n FROM pactwoven.native_memory_usages WHERE organization_id=$1',[f.actor.organizationId])).rows[0].n).toBe(0);
 });
 it('does not treat a missing lifecycle assignment as legacy memory access',async()=>{
  const f=await child(true),h={...f.h,handoffId:id(),childTaskId:id(),issuedAt:at(),deadlineAt:at(240000)};
  await genericCoordinator.handoff(f.claim.selector,h);const target={organizationId:f.actor.organizationId,taskId:h.childTaskId,generation:1};await allow(target);
  await expect(worker.claim(target)).rejects.toMatchObject({code:'FORBIDDEN'});
  const forged={...target,handoffId:h.handoffId,leaseToken:randomUUID()};
  await expect(memory.read(forged,f.assignment.memoryReferences[0]!)).rejects.toMatchObject({code:'FORBIDDEN'});
  await expect(materials.materials(forged)).rejects.toMatchObject({code:'FORBIDDEN'});
 });
 it('cannot put unselected memory into a durable specialist assignment',async()=>{
  const f=await child(true),h={...f.h,handoffId:id(),childTaskId:id(),issuedAt:at(),deadlineAt:at(240000)};
  await expect(coordinator.handoff(f.claim.selector,{requestKey:id(),handoff:h,assignment:{...f.assignment,memoryReferences:[{...f.assignment.memoryReferences[0]!,memoryId:id()}]}})).rejects.toMatchObject({code:'FORBIDDEN'});
  expect((await admin.query('SELECT count(*)::int n FROM pactwoven.native_delegation_tasks WHERE id=$1',[h.childTaskId])).rows[0].n).toBe(0);
 });
 it.each(['current','yielded','recovered'] as const)('prevents new plaintext assignments after %s root consumption while preserving exact replay',async phase=>{
  const f=await child(true,false,2),lateIdentity=identity('late_worker_'+id()),role='late_worker_'+id().slice(0,10),password=randomBytes(32).toString('base64url');
  // Enroll after note creation: this recipient is outside the original ACL.
  const sql=(await admin.query<{sql:string}>("SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD %L',$1::text,$2::text) AS sql",[role,password])).rows[0]!.sql;
  await admin.query(sql);await admin.query(`GRANT pactwoven_native_delegation_worker TO ${role}`);
  await admin.query("INSERT INTO pactwoven.native_delegation_services VALUES('simulation',$1,$2::jsonb,'worker',true)",[lateIdentity.serviceId,lateIdentity]);
  await admin.query("INSERT INTO pactwoven.native_delegation_service_bindings SELECT rolname,oid,'simulation','worker',$2,true FROM pg_roles WHERE rolname=$1",[role,lateIdentity.serviceId]);
  const connection=new URL(url!);connection.username=role;connection.password=password;const latePool=new Pool({connectionString:connection.href,max:1});
  try{
   const lateWorker=new PostgresNativeDelegationWorkerRepository(latePool,'simulation'),lateMemory=new PostgresNativeMemoryTaskRepository(latePool,'simulation');
   const direct={...f.h,handoffId:id(),childTaskId:id(),recipient:lateIdentity,issuedAt:at(),deadlineAt:at(240000)};
   await coordinator.handoff(f.claim.selector,{requestKey:id(),handoff:direct,assignment:f.assignment});
   const target={organizationId:f.actor.organizationId,taskId:direct.childTaskId,generation:1};await allow(target);const directClaim=await lateWorker.claim(target);
   await expect(lateMemory.read({...directClaim.selector,handoffId:direct.handoffId},f.assignment.memoryReferences[0]!)).rejects.toMatchObject({code:'FORBIDDEN'});
   const used=await memory.read({...f.childClaim.selector,handoffId:f.h.handoffId},f.assignment.memoryReferences[0]!);
   const publicationValue=await publication(f,[{usageId:used.usageId,selectionDigest:used.receipt.digest}]),accepted=await worker.result(f.childClaim.selector,publicationValue);
   const input=await coordinator.inputs(f.claim.selector,{requestKey:id(),results:[{handoffId:f.h.handoffId,publicationDigest:accepted.publicationDigest}]});
   expect(input.results[0]?.artifacts[0]?.body).toEqual(publicationValue.artifacts[0]?.body);
   let selector=f.claim.selector;
   if(phase==='yielded'){
    const yielded=await coordinator.yield(selector,{...checkpoint({inputReceipts:[input.receipt]}),continuation:'continue',waitFor:[]});
    const resumed={...f.target,generation:yielded.generation};await allow(resumed);selector=(await coordinator.claim(resumed)).selector;
   }else if(phase==='recovered'){
    await admin.query("UPDATE pactwoven.native_delegation_tasks SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[f.rootId]);
    const recovered=(await dispatcher.recover(20)).find(row=>row.rootTaskId===f.rootId);expect(recovered?.action).toBe('recovered');
    const resumed={...f.target,generation:recovered!.generation};await allow(resumed);selector=(await coordinator.claim(resumed)).selector;
   }
   const replay=(await admin.query('SELECT intent,response FROM pactwoven.native_delegation_root_assignments WHERE task_id=$1',[f.h.childTaskId])).rows[0]!;
   expect(await coordinator.handoff(selector,replay.intent)).toEqual(replay.response);
   const leak={...f.h,handoffId:id(),childTaskId:id(),recipient:lateIdentity,capability:'research_public_sources' as const,issuedAt:at(),deadlineAt:at(240000)};
   await expect(coordinator.handoff(selector,{requestKey:id(),handoff:leak,assignment:{...f.assignment,brief:'Prefer blue upholstery.',memoryReferences:[]}})).rejects.toMatchObject({code:'FORBIDDEN'});
   const absent=(await admin.query(`SELECT (SELECT count(*)::int FROM pactwoven.native_delegation_tasks WHERE id=$1) tasks,
    (SELECT count(*)::int FROM pactwoven.native_delegation_root_assignments WHERE task_id=$1) assignments,
    (SELECT count(*)::int FROM pactwoven.native_delegation_outbox WHERE task_id=$1) outbox`,[leak.childTaskId])).rows[0];
   expect(absent).toEqual({tasks:0,assignments:0,outbox:0});
   expect((await admin.query('SELECT count(*)::int n FROM pactwoven.native_delegation_root_inputs WHERE root_task_id=$1 AND generation=1',[f.rootId])).rows[0].n).toBe(1);
   await expect(coordinator.handoff(selector,{...replay.intent,assignment:{...replay.intent.assignment,brief:'Changed replay'}})).rejects.toMatchObject({code:'ROOT_CONFLICT'});
  }finally{await latePool.end();}
 });
 it('rejects missing, duplicate, foreign and modified original consumption receipts',async()=>{
  const f=await child(),p=await publication(f),accepted=await worker.result(f.childClaim.selector,p);
  const input=await coordinator.inputs(f.claim.selector,{requestKey:id(),results:[{handoffId:f.h.handoffId,publicationDigest:accepted.publicationDigest}]});
  for(const refs of [[],[input.receipt,input.receipt],[{...input.receipt,digest:'a'.repeat(64)}],[{...input.receipt,receiptId:randomUUID()}]])
   await expect(coordinator.complete(f.claim.selector,complete({inputReceipts:refs,coverage:[{taskId:f.h.childTaskId,disposition:'advice_ready'}]}))).rejects.toMatchObject({code:'EVIDENCE_STALE'});
  expect((await admin.query('SELECT count(*)::int n FROM pactwoven.native_delegation_root_completions WHERE root_task_id=$1',[f.rootId])).rows[0].n).toBe(0);
 });
 it('binds consumption to the current root generation and rejects old receipt replay after yield',async()=>{
  const f=await child(),p=await publication(f),accepted=await worker.result(f.childClaim.selector,p);
  const input=await coordinator.inputs(f.claim.selector,{requestKey:id(),results:[{handoffId:f.h.handoffId,publicationDigest:accepted.publicationDigest}]});
  const yielded=await coordinator.yield(f.claim.selector,{...checkpoint({inputReceipts:[input.receipt]}),continuation:'continue',waitFor:[]});
  const target={...f.target,generation:yielded.generation};await allow(target);const claim=await coordinator.claim(target);
  await expect(coordinator.complete(claim.selector,complete({expectedCheckpointVersion:1,inputReceipts:[input.receipt],coverage:[{taskId:f.h.childTaskId,disposition:'advice_ready'}]}))).rejects.toMatchObject({code:'EVIDENCE_STALE'});
  const fresh=await coordinator.inputs(claim.selector,{requestKey:id(),results:[{handoffId:f.h.handoffId,publicationDigest:accepted.publicationDigest}]});expect(fresh.receipt.receiptId).not.toBe(input.receipt.receiptId);
 });
 it('rejects cross-root outcomes and altered immutable child publication digests',async()=>{
  const a=await child(),b=await child(),p=await publication(a),accepted=await worker.result(a.childClaim.selector,p);
  await expect(coordinator.inputs(b.claim.selector,{requestKey:id(),results:[{handoffId:a.h.handoffId,publicationDigest:accepted.publicationDigest}]})).rejects.toMatchObject({code:'FORBIDDEN'});
  await expect(coordinator.inputs(a.claim.selector,{requestKey:id(),results:[{handoffId:a.h.handoffId,publicationDigest:'a'.repeat(64)}]})).rejects.toMatchObject({code:'FORBIDDEN'});
 });
 it('does not publish evidence beyond the consumed child data deadline',async()=>{
  const f=await child(),p=await publication(f),accepted=await worker.result(f.childClaim.selector,p);
  const input=await coordinator.inputs(f.claim.selector,{requestKey:id(),results:[{handoffId:f.h.handoffId,publicationDigest:accepted.publicationDigest}]});
  const q=complete({inputReceipts:[input.receipt],coverage:[{taskId:f.h.childTaskId,disposition:'advice_ready'}]});q.result.evidenceValidUntil=at(120000);
  await expect(coordinator.complete(f.claim.selector,q)).rejects.toMatchObject({code:'EVIDENCE_STALE'});
 });
 it('recovers a stranded lease within the total attempt bound and requires fresh authority',async()=>{
  const f=await running(2);await admin.query("UPDATE pactwoven.native_delegation_tasks SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[f.rootId]);
  const result=await dispatcher.recover(20),entry=result.find(x=>x.rootTaskId===f.rootId);expect(entry).toMatchObject({action:'recovered',attempt:2,generation:2});
  await expect(coordinator.claim({...f.target,generation:2})).rejects.toMatchObject({code:'FORBIDDEN'});await allow({...f.target,generation:2});await coordinator.claim({...f.target,generation:2});
  await admin.query("UPDATE pactwoven.native_delegation_tasks SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[f.rootId]);
  expect((await dispatcher.recover(20)).find(x=>x.rootTaskId===f.rootId)).toMatchObject({action:'blocked',attempt:2});
  expect(await roots.read(f.actor,f.rootId)).toMatchObject({state:'blocked',reason:'attempts_exhausted',attempt:2});
 });
 it('redelivers deliberately yielded work without consuming its logical attempt',async()=>{
  const f=await running(),yielded=await coordinator.yield(f.claim.selector,{...checkpoint(),continuation:'continue',waitFor:[]});
  await admin.query("UPDATE pactwoven.native_delegation_outbox SET state='published' WHERE task_id=$1 AND generation=$2",[f.rootId,yielded.generation]);
  expect((await dispatcher.recover(20)).find(x=>x.rootTaskId===f.rootId)).toMatchObject({action:'redelivered',attempt:1,generation:2});
  expect((await roots.read(f.actor,f.rootId)).attempt).toBe(1);
 });
 it('cancels yielded work and never recovers it automatically',async()=>{
  const f=await running();await coordinator.yield(f.claim.selector,{...checkpoint(),continuation:'continue',waitFor:[]});
  const cancelled=await roots.control(f.actor,id(),{rootTaskId:f.rootId,expectedVersion:1,action:'cancel'});expect(cancelled.state).toBe('cancelled');
  expect((await dispatcher.recover(20)).some(x=>x.rootTaskId===f.rootId)).toBe(false);
  await expect(roots.control(f.actor,id(),{rootTaskId:f.rootId,expectedVersion:cancelled.controlVersion,action:'resume'})).rejects.toMatchObject({code:'ROOT_CONFLICT'});
 });
 it('fences provider-paused descendants before an explicit resumed root can continue',async()=>{
  const f=await child();await admin.query("UPDATE pactwoven.native_delegation_proofs SET verdict='unknown',valid_until=NULL WHERE task_id=$1",[f.rootId]);await allow(f.target,'denied');
  const view=await roots.read(f.actor,f.rootId);expect(view.state).toBe('paused');
  const resumed=await roots.control(f.actor,id(),{rootTaskId:f.rootId,expectedVersion:view.controlVersion,action:'resume'});expect(resumed.state).toBe('ready');
  expect((await admin.query('SELECT active_children FROM pactwoven.native_delegation_grants WHERE id=$1',[f.grant.id])).rows[0].active_children).toBe(0);
  expect((await roots.read(f.actor,f.rootId)).coverage).toEqual([{taskId:f.h.childTaskId,disposition:'abandoned'}]);
 });
 it('routes exact current root and specialist identities and rejects stale targets',async()=>{
  const f=await child();expect(await dispatcher.route(f.target)).toEqual({kind:'root',identity:coordinatorId});expect(await dispatcher.route(f.childTarget)).toEqual({kind:'specialist',identity:workerId});
  expect(await dispatcher.route({...f.target,generation:99})).toBeNull();
 });
 it('requires the root reader ACL independently of the specialist original evidence ACL',async()=>{
  const f=await child(true,true),ref=f.assignment.memoryReferences[0]!;
  const selected=await memory.read({...f.childClaim.selector,handoffId:f.h.handoffId},ref);
  const p=await publication(f,[{usageId:selected.usageId,selectionDigest:selected.receipt.digest}]);const accepted=await worker.result(f.childClaim.selector,p);
  await expect(coordinator.inputs(f.claim.selector,{requestKey:id(),results:[{handoffId:f.h.handoffId,publicationDigest:accepted.publicationDigest}]})).rejects.toMatchObject({code:'FORBIDDEN'});
  expect((await admin.query('SELECT count(*)::int n FROM pactwoven.native_delegation_root_inputs WHERE root_task_id=$1',[f.rootId])).rows[0].n).toBe(0);
 });
 it('does not return revoked derived text through a saved planner checkpoint',async()=>{
  const f=await child(true),ref=f.assignment.memoryReferences[0]!,selected=await memory.read({...f.childClaim.selector,handoffId:f.h.handoffId},ref);
  const accepted=await worker.result(f.childClaim.selector,await publication(f,[{usageId:selected.usageId,selectionDigest:selected.receipt.digest}]));
  const input=await coordinator.inputs(f.claim.selector,{requestKey:id(),results:[{handoffId:f.h.handoffId,publicationDigest:accepted.publicationDigest}]});
  await coordinator.checkpoint(f.claim.selector,checkpoint({inputReceipts:[input.receipt],plannerState:'{"derived":"Prefer blue chairs"}'}));
  expect((await coordinator.work(f.claim.selector)).plannerState).toContain('Prefer blue chairs');
  await notes.command(f.actor,id(),{kind:'remove',siteId:f.siteId,noteId:f.note!.id,expected:f.note!.editToken!});
  expect(await coordinator.work(f.claim.selector)).toMatchObject({checkpointVersion:1,checkpoint:null,plannerState:null,historical:true});
  const q=complete({expectedCheckpointVersion:1,inputReceipts:[input.receipt],coverage:[{taskId:f.h.childTaskId,disposition:'advice_ready'}],result:NATIVE_ROOT_BLOCKED_RESULT});
  await expect(coordinator.complete(f.claim.selector,{...q,result:{...q.result,summary:'Prefer blue chairs from old evidence.'}})).rejects.toMatchObject({code:'EVIDENCE_STALE'});
  expect(await coordinator.complete(f.claim.selector,q)).toMatchObject({kind:'accepted',execution:'none',domainCompletion:false});
  expect(await roots.read(f.actor,f.rootId)).toMatchObject({state:'blocked',reason:'reconciliation',evidenceUnavailable:true,checkpoint:null,result:null});
  expect((await admin.query("SELECT publication->'result' AS result FROM pactwoven.native_delegation_root_completions WHERE root_task_id=$1",[f.rootId])).rows[0].result).toEqual(q.result);
 });
 it('recovers a yielded checkpoint after the response is lost without replaying work',async()=>{
  const f=await running(),q={...checkpoint(),continuation:'continue' as const,waitFor:[]};
  const uncertain=new PostgresNativeRootCoordinatorRepository({query:async(...args:unknown[])=>{await (coordinatorPool.query as (...args:unknown[])=>Promise<unknown>)(...args);throw new Error('Synthetic response loss');}} as unknown as Pool,'simulation');
  await expect(uncertain.yield(f.claim.selector,q)).rejects.toMatchObject({code:'DURABLE_SERVICE_UNAVAILABLE'});
  expect(await coordinator.yield(f.claim.selector,q)).toMatchObject({generation:2,checkpointVersion:1,attempt:1});
  expect((await admin.query('SELECT count(*)::int n FROM pactwoven.native_delegation_root_checkpoints WHERE root_task_id=$1',[f.rootId])).rows[0].n).toBe(1);
 });
 it('rejects foreign and repeated wait identities without changing checkpoint or generation',async()=>{
  const f=await child();for(const waits of [[id()],[f.h.childTaskId,f.h.childTaskId]])
   await expect(coordinator.yield(f.claim.selector,{...checkpoint(),continuation:'wait_children',waitFor:waits})).rejects.toMatchObject({code:'VALIDATION_FAILED'});
  expect(await roots.read(f.actor,f.rootId)).toMatchObject({checkpointVersion:0,generation:1,state:'running'});
 });
 it('allows exactly one winner between final publication and manual pause',async()=>{
  const f=await running();const results=await Promise.allSettled([coordinator.complete(f.claim.selector,complete()),roots.control(f.actor,id(),{rootTaskId:f.rootId,expectedVersion:1,action:'pause'})]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(['completed','paused']).toContain((await roots.read(f.actor,f.rootId)).state);
 });
 it('rolls back publication and retained commands when a final insert fails',async()=>{
  const f=await running();await admin.query(`CREATE FUNCTION pactwoven.root_test_fail() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN RAISE EXCEPTION USING ERRCODE='ND009',MESSAGE='Synthetic publication failure';END $$;
   REVOKE ALL ON FUNCTION pactwoven.root_test_fail() FROM PUBLIC;CREATE TRIGGER root_test_fail AFTER INSERT ON pactwoven.native_delegation_root_completions FOR EACH ROW EXECUTE FUNCTION pactwoven.root_test_fail();`);
  try{await expect(coordinator.complete(f.claim.selector,complete())).rejects.toMatchObject({code:'ROOT_CONFLICT'});
   expect((await admin.query('SELECT count(*)::int n FROM pactwoven.native_delegation_root_completions WHERE root_task_id=$1',[f.rootId])).rows[0].n).toBe(0);
   expect((await roots.read(f.actor,f.rootId)).state).toBe('running');
  }finally{await admin.query('DROP TRIGGER root_test_fail ON pactwoven.native_delegation_root_completions;DROP FUNCTION pactwoven.root_test_fail()');}
 });
 it('keeps cancel available without provider proof and fences delayed result publication',async()=>{
  const f=await child();await admin.query("UPDATE pactwoven.native_delegation_proofs SET verdict='unknown',valid_until=NULL WHERE task_id=$1",[f.rootId]);
  const result=await roots.control(f.actor,id(),{rootTaskId:f.rootId,expectedVersion:1,action:'cancel'});expect(result.state).toBe('cancelled');
  await expect(worker.result(f.childClaim.selector,await publication(f))).rejects.toBeDefined();expect(await dispatcher.route(f.childTarget)).toBeNull();
 });
 it('rechecks the current human session and membership for control and recovery',async()=>{
  const f=await running();await admin.query("INSERT INTO pactwoven.session_revocations VALUES('simulation',$1)",[f.actor.sessionId]);
  await expect(roots.control(f.actor,id(),{rootTaskId:f.rootId,expectedVersion:1,action:'pause'})).rejects.toMatchObject({code:'FORBIDDEN'});
  await expect(roots.recover(f.actor,f.rootId,id())).rejects.toMatchObject({code:'FORBIDDEN'});
 });
 it('revokes a yielded tree without making old queue targets authoritative',async()=>{
  const f=await child();await coordinator.yield(f.claim.selector,{...checkpoint(),continuation:'wait_children',waitFor:[f.h.childTaskId]});
  await api.revoke(f.actor,{grantId:f.grant.id,expectedVersion:1,expectedRevocationEpoch:0,requestKey:id()});
  expect((await roots.read(f.actor,f.rootId)).state).toBe('cancelled');await expect(worker.result(f.childClaim.selector,await publication(f))).rejects.toBeDefined();
  expect((await dispatcher.recover(20)).some(row=>row.rootTaskId===f.rootId)).toBe(false);
 });
 it('bounds dispatch recovery and does not starve later work behind queued targets',async()=>{
  // Prior cases use live leases; these ready roots each have a stranded
  // published delivery and must advance through batches of at most20.
  const ids:string[]=[];for(let i=0;i<25;i++){const f=await fixture();ids.push(f.rootId);await admin.query("UPDATE pactwoven.native_delegation_outbox SET state='published' WHERE task_id=$1",[f.rootId]);}
  const first=await dispatcher.recover(20);expect(first.length).toBeLessThanOrEqual(20);
  const second=await dispatcher.recover(20);const recovered=[...first,...second].filter(row=>ids.includes(row.rootTaskId));expect(new Set(recovered.map(row=>row.rootTaskId)).size).toBe(25);
  await expect(dispatcherPool.query("SELECT pactwoven.native_delegation_root_recover('simulation',21)")).rejects.toMatchObject({code:'ND004'});
 });
 it('recovers expired waited child work while retaining accepted siblings and original memory receipts',async()=>{
  const f=await child(true,false,2),used=await memory.read({...f.childClaim.selector,handoffId:f.h.handoffId},f.assignment.memoryReferences[0]!);
  const sibling={...f.h,handoffId:id(),childTaskId:id(),capability:'research_public_sources' as const,issuedAt:at(),deadlineAt:at(240000)};
  await coordinator.handoff(f.claim.selector,{requestKey:id(),handoff:sibling,assignment:{...f.assignment,stepId:'sibling',memoryReferences:[]}});
  const target={organizationId:f.actor.organizationId,taskId:sibling.childTaskId,generation:1};await allow(target);const siblingClaim=await worker.claim(target,30000);
  const accepted=await worker.result(siblingClaim.selector,await publication({...f,h:sibling,childClaim:siblingClaim}));
  await coordinator.yield(f.claim.selector,{...checkpoint(),continuation:'wait_children',waitFor:[f.h.childTaskId,sibling.childTaskId]});
  await admin.query("UPDATE pactwoven.native_delegation_tasks SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[f.h.childTaskId]);
  await expect(worker.claim(f.childTarget)).rejects.toMatchObject({code:'DELEGATION_CONFLICT'});
  const recovered=(await dispatcher.recover(20)).find(row=>row.rootTaskId===f.rootId);expect(recovered).toMatchObject({action:'recovered',attempt:2,generation:3});
  const rows=(await admin.query('SELECT id,state,generation::int AS generation FROM pactwoven.native_delegation_tasks WHERE root_task_id=$1 ORDER BY depth,id',[f.rootId])).rows;
  expect(rows.find(row=>row.id===f.h.childTaskId)).toMatchObject({state:'cancelled',generation:2});expect(rows.find(row=>row.id===sibling.childTaskId)).toMatchObject({state:'settled',generation:1});
  expect((await admin.query('SELECT id,publication_digest FROM pactwoven.native_memory_usages WHERE organization_id=$1',[f.actor.organizationId])).rows).toEqual([{id:used.usageId,publication_digest:null}]);
  expect((await admin.query('SELECT digest FROM pactwoven.native_delegation_results WHERE handoff_id=$1',[sibling.handoffId])).rows[0].digest).toBe(accepted.publicationDigest);
  expect((await admin.query('SELECT children_created,active_children FROM pactwoven.native_delegation_grants WHERE id=$1',[f.grant.id])).rows[0]).toEqual({children_created:2,active_children:0});
  await expect(worker.result(f.childClaim.selector,await publication(f,[{usageId:used.usageId,selectionDigest:used.receipt.digest}]))).rejects.toBeDefined();
  await allow({...f.target,generation:3});const root=await coordinator.claim({...f.target,generation:3});
  expect((await coordinator.inputs(root.selector,{requestKey:id(),results:[{handoffId:sibling.handoffId,publicationDigest:accepted.publicationDigest}]})).results).toHaveLength(1);
 });
 it('blocks an exhausted root when its required child lease expires',async()=>{
  const f=await child(false,false,1);await coordinator.yield(f.claim.selector,{...checkpoint(),continuation:'wait_children',waitFor:[f.h.childTaskId]});
  await admin.query("UPDATE pactwoven.native_delegation_tasks SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[f.h.childTaskId]);
  expect((await dispatcher.recover(20)).find(row=>row.rootTaskId===f.rootId)).toMatchObject({action:'blocked',attempt:1,generation:3});
  expect(await roots.read(f.actor,f.rootId)).toMatchObject({state:'blocked',reason:'attempts_exhausted',attempt:1});
  expect((await dispatcher.recover(20)).some(row=>row.rootTaskId===f.rootId)).toBe(false);
 });
 it('recovers a waited ready child whose undelivered work passed its deadline',async()=>{
  const f=await child(false,false,2),h={...f.h,handoffId:id(),childTaskId:id(),issuedAt:at(),deadlineAt:at(240000)};
  await coordinator.handoff(f.claim.selector,{requestKey:id(),handoff:h,assignment:f.assignment});
  await coordinator.yield(f.claim.selector,{...checkpoint(),continuation:'wait_children',waitFor:[h.childTaskId]});
  await admin.query("UPDATE pactwoven.native_delegation_tasks SET deadline_at=clock_timestamp()-interval '1 second' WHERE id=$1",[h.childTaskId]);
  expect((await dispatcher.recover(20)).find(row=>row.rootTaskId===f.rootId)).toMatchObject({action:'recovered',attempt:2});
  expect((await admin.query('SELECT state FROM pactwoven.native_delegation_tasks WHERE id=$1',[h.childTaskId])).rows[0].state).toBe('cancelled');
 });
 it.each(['pause','cancel','provider'] as const)('does not recover stranded waited work after %s fencing',async action=>{
  const f=await child(false,false,2),yielded=await coordinator.yield(f.claim.selector,{...checkpoint(),continuation:'wait_children',waitFor:[f.h.childTaskId]});
  if(action==='provider')await allow({...f.target,generation:yielded.generation},'denied');
  else await roots.control(f.actor,id(),{rootTaskId:f.rootId,expectedVersion:1,action});
  await admin.query("UPDATE pactwoven.native_delegation_tasks SET deadline_at=clock_timestamp()-interval '1 second' WHERE id=$1",[f.h.childTaskId]);
  expect((await dispatcher.recover(20)).some(row=>row.rootTaskId===f.rootId)).toBe(false);
  expect(await roots.read(f.actor,f.rootId)).toMatchObject({state:action==='cancel'?'cancelled':'paused',attempt:1});
 });
 it('gives concurrent managed root claims exactly one owner and rejects generic queue duplicates',async()=>{
  const f=await fixture();await allow(f.target);const otherPool=new Pool({...coordinatorPool.options,max:1});
  try{
   const other=new PostgresNativeRootCoordinatorRepository(otherPool,'simulation');
   const sessions=await Promise.all([coordinatorPool.query('SELECT pg_backend_pid() id'),otherPool.query('SELECT pg_backend_pid() id')]);expect(sessions[0].rows[0].id).not.toBe(sessions[1].rows[0].id);
   const results=await Promise.allSettled([coordinator.claim(f.target),other.claim(f.target)]);expect(results.filter(row=>row.status==='fulfilled')).toHaveLength(1);
   await expect(coordinator.claim(f.target)).rejects.toMatchObject({code:'ROOT_CONFLICT'});
   await expect(genericCoordinator.claim(f.target)).rejects.toMatchObject({code:'DELEGATION_CONFLICT'});
  }finally{await otherPool.end();}
 });
 it('gives concurrent managed specialist claims exactly one owner and no shared lease for queue duplicates',async()=>{
  const f=await child(true),h={...f.h,handoffId:id(),childTaskId:id(),issuedAt:at(),deadlineAt:at(240000)};
  await coordinator.handoff(f.claim.selector,{requestKey:id(),handoff:h,assignment:f.assignment});
  const target={organizationId:f.actor.organizationId,taskId:h.childTaskId,generation:1};await allow(target);const otherPool=new Pool({...workerPool.options,max:1});
  try{
   const other=new PostgresNativeDelegationWorkerRepository(otherPool,'simulation');
   const results=await Promise.allSettled([worker.claim(target),other.claim(target)]);expect(results.filter(row=>row.status==='fulfilled')).toHaveLength(1);
   const winner=results.find(row=>row.status==='fulfilled');if(winner?.status!=='fulfilled')throw new Error('Missing exclusive claim');
   await memory.read({...winner.value.selector,handoffId:h.handoffId},f.assignment.memoryReferences[0]!);
   await expect(worker.claim(target)).rejects.toMatchObject({code:'DELEGATION_CONFLICT'});
   expect((await admin.query("SELECT count(*)::int n FROM pactwoven.native_memory_usages WHERE context#>>'{usage,taskId}'=$1",[h.childTaskId])).rows[0].n).toBe(1);
  }finally{await otherPool.end();}
 });
 it.each([
  ['active','both'],['completed','both'],['carried','both'],['active','source'],['completed','memory'],
 ] as const)('withholds %s human evidence after a peer revokes %s reader access',async(phase,part)=>{
  const f=await child(true),selected=await memory.read({...f.childClaim.selector,handoffId:f.h.handoffId},f.assignment.memoryReferences[0]!);
  const p=await publication(f,[{usageId:selected.usageId,selectionDigest:selected.receipt.digest}]),accepted=await worker.result(f.childClaim.selector,p);
  const input=await coordinator.inputs(f.claim.selector,{requestKey:id(),results:[{handoffId:f.h.handoffId,publicationDigest:accepted.publicationDigest}]});
  const protectedText=String(input.results[0]!.artifacts[0]!.body.text),body={stage:'reviewing' as const,summary:protectedText,steps:[]};
  const saved=await coordinator.checkpoint(f.claim.selector,checkpoint({checkpoint:body,plannerState:JSON.stringify({summary:protectedText}),inputReceipts:[input.receipt]}));
  if(phase==='completed')await coordinator.complete(f.claim.selector,complete({expectedCheckpointVersion:saved.checkpointVersion,inputReceipts:[input.receipt],coverage:[{taskId:f.h.childTaskId,disposition:'advice_ready'}],result:{outcome:'advice_ready',title:'Review',summary:protectedText,artifacts:[{id:'quoted',title:'Recorded advice',text:protectedText}],evidenceValidUntil:at(30000)}}));
  if(phase==='carried'){
   const yielded=await coordinator.yield(f.claim.selector,{...checkpoint({expectedCheckpointVersion:saved.checkpointVersion,checkpoint:body,inputReceipts:[input.receipt]}),continuation:'continue',waitFor:[]});
   const target={...f.target,generation:yielded.generation};await allow(target);const resumed=await coordinator.claim(target);
   await coordinator.checkpoint(resumed.selector,checkpoint({expectedCheckpointVersion:yielded.checkpointVersion,checkpoint:body,inputReceipts:[]}));
  }
  const visible=await roots.read(f.actor,f.rootId);expect(visible.evidenceUnavailable).toBe(false);expect(visible.checkpoint).toEqual(body);
  if(phase==='completed')expect(visible.result?.summary).toBe(protectedText);
  const retained=(await admin.query(`SELECT (SELECT body FROM pactwoven.native_delegation_root_checkpoints WHERE root_task_id=$1 ORDER BY version DESC LIMIT 1) checkpoint,
   (SELECT publication FROM pactwoven.native_delegation_root_completions WHERE root_task_id=$1) completion`,[f.rootId])).rows[0];
  const peerId=id();await admin.query("INSERT INTO pactwoven.memberships(environment,organization_id,actor_id,external_subject,external_membership_id,grant_basis,roles,display_name) VALUES('simulation',$1,$2,$2,$3,'internal',ARRAY['owner'],'Peer reviewer')",[f.actor.organizationId,peerId,'member_'+id()]);
  await admin.query("INSERT INTO pactwoven.member_action_sites VALUES('simulation',$1,$2,$3)",[f.actor.organizationId,peerId,f.siteId]);
  const peer:ActorContext={...f.actor,actorId:peerId,sessionId:id(),authenticatedAt:at(-10),correlationId:id()},readers=[{kind:'user',id:f.actor.actorId},{kind:'user',id:peerId},{kind:'agent',id:coordinatorId.serviceId},{kind:'agent',id:workerId.serviceId}];
  await changeReaders(f,f.actor,readers);await changeReaders(f,peer,readers.filter(reader=>reader.id!==f.actor.actorId),part);
  await expect(notes.get(f.actor,f.siteId,f.note!.id)).rejects.toMatchObject({code:'NOT_FOUND'});
  const hidden=await roots.read(f.actor,f.rootId);expect(hidden.evidenceUnavailable).toBe(true);expect(hidden.checkpoint).toBeNull();expect(hidden.result).toBeNull();
  expect(hidden.state).toBe(visible.state);expect(hidden.scope).toEqual(visible.scope);expect(hidden.title).toBe(visible.title);expect(hidden.prompt).toBe(visible.prompt);expect(hidden.checkpointVersion).toBe(visible.checkpointVersion);
  expect(JSON.stringify(hidden)).not.toContain(protectedText);
  expect((await admin.query(`SELECT (SELECT body FROM pactwoven.native_delegation_root_checkpoints WHERE root_task_id=$1 ORDER BY version DESC LIMIT 1) checkpoint,
   (SELECT publication FROM pactwoven.native_delegation_root_completions WHERE root_task_id=$1) completion`,[f.rootId])).rows[0]).toEqual(retained);
  // Granting access to a newer revision cannot make old consumed evidence current.
  await changeReaders(f,peer,readers);expect((await roots.read(f.actor,f.rootId)).evidenceUnavailable).toBe(true);
 });
 it('withholds expired completed advice while retaining its lifecycle and immutable result',async()=>{
  const f=await child(),p=await publication(f),accepted=await worker.result(f.childClaim.selector,p),input=await coordinator.inputs(f.claim.selector,{requestKey:id(),results:[{handoffId:f.h.handoffId,publicationDigest:accepted.publicationDigest}]});
  const result={outcome:'advice_ready' as const,title:'Advice',summary:'Original advice',artifacts:[{id:'advice',title:'Advice',text:'Original advice'}],evidenceValidUntil:at(500)};
  await coordinator.complete(f.claim.selector,complete({inputReceipts:[input.receipt],coverage:[{taskId:f.h.childTaskId,disposition:'advice_ready'}],result}));
  expect((await roots.read(f.actor,f.rootId)).result).toEqual(result);await admin.query('SELECT pg_sleep(0.6)');
  expect(await roots.read(f.actor,f.rootId)).toMatchObject({state:'completed',evidenceUnavailable:true,checkpoint:null,result:null});
  expect((await admin.query('SELECT publication->\'result\' AS result FROM pactwoven.native_delegation_root_completions WHERE root_task_id=$1',[f.rootId])).rows[0].result).toEqual(result);
 });
 it('holds human evidence disclosure against concurrent note correction until commit',async()=>{
  const f=await child(true),selected=await memory.read({...f.childClaim.selector,handoffId:f.h.handoffId},f.assignment.memoryReferences[0]!);
  const accepted=await worker.result(f.childClaim.selector,await publication(f,[{usageId:selected.usageId,selectionDigest:selected.receipt.digest}]));
  const input=await coordinator.inputs(f.claim.selector,{requestKey:id(),results:[{handoffId:f.h.handoffId,publicationDigest:accepted.publicationDigest}]});
  await coordinator.checkpoint(f.claim.selector,checkpoint({inputReceipts:[input.receipt]}));
  const reader=await apiPool.connect(),changingPool=new Pool({...apiPool.options,max:1}),changing=await changingPool.connect();
  try{
   await reader.query('BEGIN');const view=(await reader.query('SELECT pactwoven.native_delegation_root_read($1::jsonb,$2) AS view',[f.actor,f.rootId])).rows[0].view;expect(view.evidenceUnavailable).toBe(false);
   await changing.query('BEGIN');await changing.query("SET LOCAL lock_timeout='100ms'");
   await expect(changing.query('SELECT pactwoven.native_memory_notes_command($1::jsonb,$2,$3::jsonb)',[f.actor,id(),{kind:'correct',siteId:f.siteId,noteId:f.note!.id,expected:f.note!.editToken!,title:f.note!.title,text:'Concurrent new choice',purpose:f.note!.purpose!,reviewBy:f.note!.reviewBy!}])).rejects.toMatchObject({code:'55P03'});
   await changing.query('ROLLBACK');await reader.query('COMMIT');
  }finally{await Promise.allSettled([reader.query('ROLLBACK'),changing.query('ROLLBACK')]);reader.release();changing.release();await changingPool.end();}
 });
});
