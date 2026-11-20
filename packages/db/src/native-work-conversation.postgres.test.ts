import { PostgresNativeWorkConversationRepository } from './native-work-conversation-repository';
import { PostgresNativeRootInstructionCoordinatorRepository, PostgresNativeRootInstructionWorkerRepository } from './native-root-instruction-repository';
import { nativeRootInstructionInputDigest } from './native-root-instruction-schema';
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
describe.skipIf(!url)('paused instruction PostgreSQL',()=>{
 let admin:Pool,apiPool:Pool,coordinatorPool:Pool,workerPool:Pool,dispatcherPool:Pool;
 let api:PostgresNativeDelegationRepository,roots:PostgresNativeRootRepository,coordinator:PostgresNativeRootCoordinatorRepository,
  worker:PostgresNativeDelegationWorkerRepository,genericCoordinator:PostgresNativeDelegationWorkerRepository,materials:PostgresNativeRootWorkerRepository,
  dispatcher:PostgresNativeRootDispatchRepository,notes:PostgresNativeMemoryNotesRepository,memory:PostgresNativeMemoryTaskRepository;
 const coordinatorId=identity('root_coordinator_'+id()),workerId=identity('root_worker_'+id());
 beforeAll(async()=>{
  const u=new URL(url!);if(!['127.0.0.1','localhost'].includes(u.hostname)||!/^\/pactwoven_(?:native_memory_|p3_steering_r)[a-zA-Z0-9_]+$/.test(u.pathname))throw new Error('Dedicated local root database required.');
  admin=new Pool({connectionString:url,max:3});const pools:Pool[]=[];
  // Retain old fixture evidence but exclude prior suite runs from this run's
  // environment-wide bounded recovery scan. This touches synthetic roots only.

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

 const conversation=()=>new PostgresNativeWorkConversationRepository(apiPool,'simulation');
 const v3=()=>new PostgresNativeRootInstructionCoordinatorRepository(coordinatorPool,'simulation');
 const w3=()=>new PostgresNativeRootInstructionWorkerRepository(workerPool,'simulation');
 async function paused(){const f=await fixture();const view=await roots.read(f.actor,f.rootId);const receipt=await roots.control(f.actor,id(),{rootTaskId:f.rootId,expectedVersion:view.controlVersion,action:'pause'});return{...f,pause:receipt};}
 const input=(control:number,version=0,text='Prioritize accessible seating.')=>({expectedControlVersion:control,expectedInstructionVersion:version,text});
 async function resumed(f:Awaited<ReturnType<typeof paused>>,control:number){const receipt=await roots.control(f.actor,id(),{rootTaskId:f.rootId,expectedVersion:control,action:'resume'});const target={...f.target,generation:receipt.generation};await allow(target);return coordinator.claim(target,30000);}
 async function plan(selector:any,usage={inputTokens:10,outputTokens:5,totalTokens:15}){const frame=await v3().workV3(selector);return{frame,command:{schemaVersion:3 as const,expectedInstructionRevision:frame.instructionRevision,expectedRefreshEpoch:frame.refreshEpoch,command:{...checkpoint({expectedCheckpointVersion:frame.work.checkpointVersion}),plannerState:JSON.stringify({schemaVersion:1,inputDigest:await nativeRootInstructionInputDigest(frame.work,frame.instructionRevision,frame.instructionDigest),plan:{objective:'Choose suitable chairs',steps:[],limitations:[],question:null},slots:[],usage,bounded:false,attempt:1})}}};}
 it('records immutable instructions only while manually paused, stays paused and recovers exact operation',async()=>{
  const f=await fixture(),repo=conversation();expect((await repo.read(f.actor,f.rootId,f.siteId)).updateUnavailableReason).toBe('pause_required');
  await expect(repo.update(f.actor,f.rootId,f.siteId,id(),input(1))).rejects.toMatchObject({code:'ROOT_CONFLICT'});
  const before=await roots.read(f.actor,f.rootId),pause=await roots.control(f.actor,id(),{rootTaskId:f.rootId,expectedVersion:before.controlVersion,action:'pause'});
  const key=id(),q=input(pause.controlVersion),saved=await repo.update(f.actor,f.rootId,f.siteId,key,q);
  expect(saved).toMatchObject({instructionVersion:1,controlVersion:pause.controlVersion+1,state:'paused',entry:{sequence:1,text:q.text,state:'recorded'}});
  expect(await repo.update(f.actor,f.rootId,f.siteId,key,q)).toEqual(saved);expect((await repo.recover(f.actor,f.rootId,f.siteId,key)).operation).toEqual(saved);
  const view=await roots.read(f.actor,f.rootId);expect(view.state).toBe('paused');expect(view.prompt).toBe(before.prompt);expect(view.expiresAt).toBe(before.expiresAt);
  expect((await repo.read(f.actor,f.rootId,f.siteId)).entries).toEqual([saved.entry]);
  await expect(repo.update(f.actor,f.rootId,f.siteId,key,{...q,text:'Changed intent'})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
 });
 it('CAS allows one concurrent instruction update and no version/control lost update',async()=>{
  const f=await paused(),repo=conversation(),q=input(f.pause.controlVersion);const outcomes=await Promise.allSettled([repo.update(f.actor,f.rootId,f.siteId,id(),q),repo.update(f.actor,f.rootId,f.siteId,id(),q)]);
  expect(outcomes.filter(x=>x.status==='fulfilled')).toHaveLength(1);expect(outcomes.filter(x=>x.status==='rejected')).toHaveLength(1);
  expect(await repo.read(f.actor,f.rootId,f.siteId)).toMatchObject({instructionVersion:1,controlVersion:f.pause.controlVersion+1});
 });
 it('rejects wrong root/site and access lost before read, write or recovery',async()=>{
  const f=await paused(),repo=conversation(),key=id(),q=input(f.pause.controlVersion);await repo.update(f.actor,f.rootId,f.siteId,key,q);
  await expect(repo.read(f.actor,f.rootId,id())).rejects.toMatchObject({code:'FORBIDDEN'});
  await admin.query('DELETE FROM pactwoven.member_action_sites WHERE organization_id=$1 AND actor_id=$2',[f.actor.organizationId,f.actor.actorId]);
  await expect(repo.update(f.actor,f.rootId,f.siteId,key,q)).rejects.toMatchObject({code:'FORBIDDEN'});
  await admin.query("UPDATE pactwoven.memberships SET status='revoked' WHERE organization_id=$1 AND actor_id=$2",[f.actor.organizationId,f.actor.actorId]);
  await expect(repo.read(f.actor,f.rootId,f.siteId)).rejects.toMatchObject({code:'FORBIDDEN'});await expect(repo.recover(f.actor,f.rootId,f.siteId,key)).rejects.toMatchObject({code:'FORBIDDEN'});
 });
 it('keeps old checkpoint historical, carries cumulative root usage, and applies only an accepted revised plan',async()=>{
  const f=await running(),initial=await plan(f.claim.selector);await v3().checkpointV3(f.claim.selector,initial.command);
  const originalDeadline=initial.frame.rootDeadlineAt;const view=await roots.read(f.actor,f.rootId),pause=await roots.control(f.actor,id(),{rootTaskId:f.rootId,expectedVersion:view.controlVersion,action:'pause'});
  const saved=await conversation().update(f.actor,f.rootId,f.siteId,id(),input(pause.controlVersion));expect((await conversation().read(f.actor,f.rootId,f.siteId)).entries[0]?.state).toBe('recorded');
  expect((await roots.read(f.actor,f.rootId)).checkpoint).toBeNull();
  const claim=await resumed({...f,pause},saved.controlVersion),frame=await v3().workV3(claim.selector);
  expect(frame).toMatchObject({instructionRevision:1,rootDeadlineAt:originalDeadline,usageFloor:{inputTokens:10,outputTokens:5,totalTokens:15},work:{checkpoint:null,plannerState:null,prompt:'Compare office chairs'}});
  await expect(coordinator.work(claim.selector)).rejects.toMatchObject({code:'FORBIDDEN'});
  const bad=await plan(claim.selector,{inputTokens:1,outputTokens:1,totalTokens:2});await expect(v3().checkpointV3(claim.selector,bad.command)).rejects.toMatchObject({code:'ROOT_CONFLICT'});
  const current=await plan(claim.selector,{inputTokens:20,outputTokens:8,totalTokens:28});await v3().checkpointV3(claim.selector,current.command);
  expect((await conversation().read(f.actor,f.rootId,f.siteId)).entries[0]?.state).toBe('applied');
  expect((await admin.query('SELECT count(*)::int n FROM pactwoven.native_delegation_root_checkpoints WHERE root_task_id=$1',[f.rootId])).rows[0].n).toBe(2);
 });
 it('fences an old leased worker and excludes prior children without resetting lifetime budget',async()=>{
  const f=await child(),view=await roots.read(f.actor,f.rootId),pause=await roots.control(f.actor,id(),{rootTaskId:f.rootId,expectedVersion:view.controlVersion,action:'pause'});
  const saved=await conversation().update(f.actor,f.rootId,f.siteId,id(),input(pause.controlVersion));const claim=await resumed({...f,pause},saved.controlVersion);
  const frame=await v3().workV3(claim.selector);expect(frame.work.children).toEqual([]);expect(frame.lifetimeChildCount).toBe(1);
  await expect(w3().materialsV3(f.childClaim.selector)).rejects.toMatchObject({code:'FORBIDDEN'});
  await expect(w3().resultV3(f.childClaim.selector,{schemaVersion:3,expectedInstructionRevision:0,expectedRefreshEpoch:0,publication:await publication(f),observations:[]})).rejects.toMatchObject({code:'ROOT_CONFLICT'});
  const next=await plan(claim.selector);await v3().checkpointV3(claim.selector,next.command);
  const oldAssignment=(await admin.query('SELECT intent FROM pactwoven.native_delegation_root_assignments WHERE task_id=$1',[f.h.childTaskId])).rows[0].intent;
  await expect(v3().handoffV3(claim.selector,{schemaVersion:3,expectedInstructionRevision:1,expectedRefreshEpoch:0,command:oldAssignment})).rejects.toMatchObject({code:'ROOT_CONFLICT'});
  const h={...f.h,handoffId:id(),childTaskId:id(),issuedAt:at(),deadlineAt:new Date(Math.min(Date.now()+240000,Date.parse(frame.rootDeadlineAt))).toISOString(),correlationId:id()};
  await v3().handoffV3(claim.selector,{schemaVersion:3,expectedInstructionRevision:1,expectedRefreshEpoch:0,command:{requestKey:id(),handoff:h,assignment:f.assignment}});
  expect((await v3().workV3(claim.selector)).lifetimeChildCount).toBe(2);
 });
 it('rejects terminal and revoked roots without recreating work',async()=>{
  const f=await paused();await roots.control(f.actor,id(),{rootTaskId:f.rootId,expectedVersion:f.pause.controlVersion,action:'cancel'});
  expect((await conversation().read(f.actor,f.rootId,f.siteId)).updateUnavailableReason).toBe('cancelled');await expect(conversation().update(f.actor,f.rootId,f.siteId,id(),input(f.pause.controlVersion+1))).rejects.toMatchObject({code:'ROOT_CONFLICT'});
  const done=await running();await coordinator.complete(done.claim.selector,complete());expect((await conversation().read(done.actor,done.rootId,done.siteId)).updateUnavailableReason).toBe('finished');
  const revoked=await paused();await api.revoke(revoked.actor,{grantId:revoked.grant.id,expectedVersion:1,expectedRevocationEpoch:0,requestKey:id()});
  await expect(conversation().update(revoked.actor,revoked.rootId,revoked.siteId,id(),input(revoked.pause.controlVersion))).rejects.toMatchObject({code:'FORBIDDEN'});
 });
 it('gives API and worker no raw table or private helper execution',async()=>{
  await expect(apiPool.query('SELECT * FROM pactwoven.native_instruction_updates')).rejects.toMatchObject({code:'42501'});
  await expect(workerPool.query("SELECT pactwoven.native_instruction_revision('simulation','x','x')")).rejects.toMatchObject({code:'42501'});
  await expect(apiPool.query("SELECT pactwoven.native_delegation_root_work_v3('simulation','{}')")).rejects.toMatchObject({code:'42501'});
 });
 it('retains sixteen ordered amendments and then makes instruction limit authoritative',async()=>{
  const f=await paused(),repo=conversation();let control=f.pause.controlVersion;
  const original=(await admin.query('SELECT body FROM pactwoven.native_delegation_grants WHERE id=$1',[f.grant.id])).rows[0].body;
  for(let revision=0;revision<16;revision++){const saved=await repo.update(f.actor,f.rootId,f.siteId,id(),input(control,revision,'Update '+(revision+1)));control=saved.controlVersion;}
  const view=await repo.read(f.actor,f.rootId,f.siteId);expect(view).toMatchObject({instructionVersion:16,canUpdate:false,updateUnavailableReason:'instruction_limit',controlVersion:control});
  expect(view.entries.map(x=>x.sequence)).toEqual(Array.from({length:16},(_,i)=>i+1));expect(view.entries.every(x=>x.state==='recorded')).toBe(true);
  expect((await admin.query('SELECT body FROM pactwoven.native_delegation_grants WHERE id=$1',[f.grant.id])).rows[0].body).toEqual(original);
  await expect(admin.query('UPDATE pactwoven.native_instruction_updates SET instruction_digest=$1 WHERE root_task_id=$2',['a'.repeat(64),f.rootId])).rejects.toBeDefined();
  await expect(admin.query('DELETE FROM pactwoven.native_instruction_updates WHERE root_task_id=$1',[f.rootId])).rejects.toBeDefined();
 });
 it('rechecks temporal membership expiry after waiting for the grant lock and rolls back the amendment',async()=>{
  const f=await paused(),repo=conversation(),key=id();
  await admin.query("UPDATE pactwoven.memberships SET expires_at=clock_timestamp()+interval '350 milliseconds' WHERE organization_id=$1 AND actor_id=$2",[f.actor.organizationId,f.actor.actorId]);
  const blocker=await admin.connect();await blocker.query('BEGIN');await blocker.query('SELECT 1 FROM pactwoven.native_delegation_grants WHERE id=$1 FOR UPDATE',[f.grant.id]);
  const pending=repo.update(f.actor,f.rootId,f.siteId,key,input(f.pause.controlVersion)).then(()=>({ok:true}),error=>({ok:false,error}));
  await new Promise(resolve=>setTimeout(resolve,450));await blocker.query('COMMIT');blocker.release();
  const result=await pending;expect(result.ok).toBe(false);
  expect((await admin.query('SELECT count(*)::int n FROM pactwoven.native_instruction_updates WHERE root_task_id=$1',[f.rootId])).rows[0].n).toBe(0);
  expect((await admin.query('SELECT control_version FROM pactwoven.native_delegation_root_runs WHERE root_task_id=$1',[f.rootId])).rows[0].control_version).toBe(String(f.pause.controlVersion));
 });
 it('acquires membership scope before the grant for v3 mutation, avoiding reversed authority lock order',async()=>{
  const f=await running(),next=await plan(f.claim.selector),blocker=await admin.connect();
  const pid=(await coordinatorPool.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  await blocker.query('BEGIN');await blocker.query('SELECT 1 FROM pactwoven.memberships WHERE organization_id=$1 AND actor_id=$2 FOR UPDATE',[f.actor.organizationId,f.actor.actorId]);
  let outcome:any;const pending=v3().checkpointV3(f.claim.selector,next.command).then(value=>{outcome={value};},error=>{outcome={error};});
  try{
   let waiting=false;for(let i=0;i<40;i++){waiting=(await admin.query('SELECT cardinality(pg_blocking_pids($1))>0 waiting',[pid])).rows[0].waiting;if(waiting)break;await new Promise(resolve=>setTimeout(resolve,5));}
   expect(waiting).toBe(true);
   await blocker.query('SELECT 1 FROM pactwoven.native_delegation_grants WHERE id=$1 FOR UPDATE NOWAIT',[f.grant.id]);
   await blocker.query('COMMIT');
  }finally{await blocker.query('ROLLBACK');blocker.release();}
  await pending;expect(outcome.error).toBeUndefined();expect(outcome.value.receipt.checkpointVersion).toBe(1);
 });

 it('matches public Unicode text limits and rejects whitespace-only SQL bypasses',async()=>{
  const f=await paused();
  expect((await admin.query("SELECT pactwoven.native_instruction_valid_text('v') valid")).rows[0].valid).toBe(true);
  for(const text of ['\u00a0\u2007\ufeff','\u000b','😀'.repeat(2001)])await expect(apiPool.query('SELECT pactwoven.native_work_instruction_update($1::jsonb,$2,$3,$4,$5::jsonb)',[f.actor,f.rootId,f.siteId,id(),input(f.pause.controlVersion,0,text)])).rejects.toMatchObject({code:'ND004'});
  expect((await conversation().update(f.actor,f.rootId,f.siteId,id(),input(f.pause.controlVersion,0,'😀'.repeat(2000)))).entry.text.length).toBe(4000);
 });

});
