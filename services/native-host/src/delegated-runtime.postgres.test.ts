import { createSourceEvidenceReader } from '../../coordinator/src/source-evidence';
import { createDelegatedRuntime } from './delegated-runtime';
import { DelegatedQueueMessageSchema, type DelegatedQueueMessage } from './delegated-dispatch';
import { DelegatedCoordinator } from '../../coordinator/src/delegated-coordinator';
import { DelegatedSpecialist } from '../../coordinator/src/delegated-specialist';
import type { DelegatedDiagnosticReporter } from '../../coordinator/src/delegated-diagnostics';
import { NativeGatewayError, createAzureGateway, azureDeployments, type NativeModelGateway, type ModelRequest } from '../../coordinator/src/azure-gateway';
import { randomBytes,randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { z } from 'zod';
import { beforeAll,afterAll,describe,it,expect,vi } from 'vitest';
import type { ActorContext } from '../../../packages/contracts/src/core';
import { commandDigest } from '../../../packages/contracts/src/canonical';
import { NativeAdvisoryGrantSchema,type NativeAdvisoryHandoff } from '../../../packages/contracts/src/native-delegation';
import { PostgresNativeDelegationRepository,PostgresNativeDelegationWorkerRepository,type NativeDelegationPublication,type NativeDelegationTarget } from '../../../packages/db/src/native-delegation-repository';
import { PostgresNativeRootRepository,PostgresNativeRootCoordinatorRepository,PostgresNativeRootWorkerRepository,PostgresNativeRootDispatchRepository } from '../../../packages/db/src/native-root-lifecycle-repository';
import { PostgresNativeMemoryNotesRepository } from '../../../packages/db/src/native-memory-notes-repository';
import { PostgresNativeMemoryTaskRepository } from '../../../packages/db/src/native-memory-repository';
import { NATIVE_ROOT_BLOCKED_RESULT,type NativeRootCheckpointCommand,type NativeRootCompleteCommand } from '../../../packages/db/src/native-root-lifecycle-schema';
const url=process.env.PACTWOVEN_DELEGATED_RUNTIME_TEST_DATABASE_URL;
const at=(ms=0)=>new Date(Date.now()+ms).toISOString();
const id=()=>randomUUID().replaceAll('-','_');
const issuer='https://root-fixture.clerk.accounts.dev';
const identity=(serviceId:string)=>({serviceId,serviceVersion:1,workloadIdentityId:serviceId});
describe.skipIf(!url)('actual delegated coordinator and specialist PostgreSQL integration',()=>{
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
  await admin.query("UPDATE pactwoven.native_delegation_root_runs r SET manual_paused=true WHERE EXISTS(SELECT 1 FROM pactwoven.organizations o WHERE(o.environment,o.id)=(r.environment,r.organization_id) AND o.name='Delegated runtime fixture')");
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
 async function fixture(maxAttempts=4,withNote=false,bind=true,noRootAccess=false,prompt='Compare office chairs',childLimit=32){
  const org=id(),actorId=id(),siteId=id(),legacy=id(),rootId=id();
  await admin.query("INSERT INTO pactwoven.organizations(environment,id,external_organization_id,name) VALUES('simulation',$1,$1,'Delegated runtime fixture')",[org]);
  await admin.query("INSERT INTO pactwoven.memberships(environment,organization_id,actor_id,external_subject,external_membership_id,grant_basis,roles,display_name) VALUES('simulation',$1,$2,$2,$3,'internal',ARRAY['owner'],'Operator')",[org,actorId,'member_'+id()]);
  await admin.query("INSERT INTO pactwoven.sites(environment,organization_id,id,name,time_zone) VALUES('simulation',$1,$2,'Office','UTC')",[org,siteId]);
  await admin.query("INSERT INTO pactwoven.member_action_sites VALUES('simulation',$1,$2,$3)",[org,actorId,siteId]);
  await admin.query("INSERT INTO pactwoven.native_delegation_policies VALUES('simulation',$1,1,true)",[org]);
  const actor:ActorContext={environment:'simulation',organizationId:org,actorId,principalKind:'human',roles:['owner'],siteIds:[siteId],actionSiteIds:[siteId],sessionId:id(),authenticatedAt:at(-100),correlationId:id()};
  await admin.query("INSERT INTO pactwoven.native_tasks(environment,organization_id,id,actor_id,session_id,site_id,title,prompt,status,phase) VALUES('simulation',$1,$2,$3,$4,$5,'Choose chairs',$6,'paused','Delegated provenance')",[org,legacy,actorId,actor.sessionId,siteId,prompt]);
  const member=(await admin.query('SELECT external_membership_id FROM pactwoven.memberships WHERE organization_id=$1',[org])).rows[0];
  const scope={environment:'simulation' as const,organizationId:org,issuer:{actorId,providerIssuer:issuer,subject:actorId,externalOrganizationId:org,externalMembershipId:member.external_membership_id,membershipVersion:1},
   organizationEpoch:0,policyVersion:1,purpose:'Compare office chairs',sites:[{siteId,siteVersion:1}],capabilityVersion:1,capabilities:['draft_advice','read_scoped_memory','research_public_sources'],
   limits:{maxDepth:3,maxConcurrentChildren:Math.min(3,childLimit),maxChildren:childLimit,maxAttempts,taskTimeoutMs:300000}};
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

 const services={coordinator:coordinatorId,research:workerId,planning:workerId,escalation:workerId};
 const modelCalls: Array<{role:string;input:string;schemaName:string}>=[];
 const defaultAdvice={title:'Chair review',summary:'Review the options before choosing.',findings:[],recommendations:['Confirm dimensions.'],limitations:['No order was placed.'],question:null};
 const plan={objective:'Compare office chair options',steps:[{title:'Review available evidence',brief:'Compare the operator evidence.',role:'research'},{title:'Compare options',brief:'Explain practical tradeoffs.',role:'planning'}],limitations:[],question:null};
 const qualityCategories=['deliverables','consistency','grounding','scope'];
 function qualityReview(data:any,reject=false){
  const criteria=data.frozenCriteria??qualityCategories.map(category=>({category,requirement:`Evaluate ${category}.`}));
  return {verdict:reject?'reject':'accept',checks:criteria.map((criterion:any,index:number)=>({...('criterionId' in criterion?{criterionId:criterion.criterionId}:criterion),status:reject&&index===0?'missing':'satisfied',passageIds:[data.candidate.passages[0].id]})),repairGuidance:reject?'Supply the actual requested advice.':null};
 }
 const gateway:NativeModelGateway={async complete<T>(request:ModelRequest<T>){
  modelCalls.push({role:request.role,input:request.input,schemaName:request.schemaName});
  const data=JSON.parse(request.input),excerpts=data.evidenceExcerpts as Array<{id:string;text:string}>|undefined;
  const evidence=excerpts?.[0];
  const value=request.schemaName==='delegated_advice_quality'?qualityReview(data):request.schemaName==='delegated_operator_plan'?plan:evidence?{...defaultAdvice,findings:[{kind:'source_statement',text:'A preference was recorded.',citations:[{id:evidence.id,quote:evidence.text.slice(0,Math.min(30,evidence.text.length))}]}]}:defaultAdvice;
  return {value:request.schema.parse(value),usage:{inputTokens:7,outputTokens:3,totalTokens:10},deployment:azureDeployments[request.role]};
 }};
 const observer=async(target:NativeDelegationTarget)=>{
  const result=await allow(target);
  return {result,usableUntil:result.state==='allowed'?Math.min(Date.parse(result.validUntil!),Date.now()+15000):null};
 };
 function engine(model:NativeModelGateway=gateway,repo=coordinator,onDiagnostic?:DelegatedDiagnosticReporter){return new DelegatedCoordinator({environment:'simulation',services,repository:repo,renewal:genericCoordinator,gateway:model,observe:observer,...(onDiagnostic?{onDiagnostic}:{})});}
 function specialist(model:NativeModelGateway=gateway,repo=worker){return new DelegatedSpecialist({environment:'simulation',identity:workerId,repository:repo,materials,memory,gateway:model,observe:observer});}
 const slice=()=>({deadlineAt:Date.now()+60000});
 async function children(f:Awaited<ReturnType<typeof fixture>>){
  const rows=await admin.query('SELECT id,generation,state FROM pactwoven.native_delegation_tasks WHERE parent_task_id=$1 ORDER BY id',[f.rootId]);
  return rows.rows.map((row:{id:string;generation:string;state:string})=>({organizationId:f.actor.organizationId,taskId:row.id,generation:Number(row.generation),state:row.state}));
 }
 async function completeChildren(f:Awaited<ReturnType<typeof fixture>>,model:NativeModelGateway=gateway){for(const child of await children(f))if(child.state==='ready')expect(await specialist(model).run({organizationId:child.organizationId,taskId:child.taskId,generation:child.generation},slice())).toMatchObject({state:'settled'});}
 async function nextTarget(f:Awaited<ReturnType<typeof fixture>>){return {...f.target,generation:(await roots.read(f.actor,f.rootId)).generation};}
 it.each([
  {withNote:true,childLimit:32,specialistLimit:5}, {withNote:false,childLimit:32,specialistLimit:6},
  {withNote:true,childLimit:2,specialistLimit:1}, {withNote:false,childLimit:2,specialistLimit:2},
  {withNote:true,childLimit:1,specialistLimit:0},
 ])('enforces planner capacity before dispatch and completes every assignment: $withNote/$childLimit',async({withNote,childLimit,specialistLimit})=>{
  const f=await fixture(4,withNote,true,false,'Compare all workshop options and produce one complete recommendation',childLimit);
  let offered=-1,modelInput:Record<string,unknown>={},syntheses=0;
  const capacityModel:NativeModelGateway={async complete<T>(request:ModelRequest<T>){
   if(request.schemaName==='delegated_operator_plan'){
    const steps=z.toJSONSchema(request.schema).properties?.['steps'];offered=steps&&typeof steps==='object'?steps.maxItems??-1:-1;
    modelInput=JSON.parse(request.input);
    return {value:request.schema.parse({...plan,steps:Array.from({length:offered},(_,i)=>({title:`Work area ${i+1}`,brief:`Cover objective area ${i+1} completely.`,role:'planning'}))}),usage:{inputTokens:1,outputTokens:1,totalTokens:2},deployment:'gpt-6.1-sol'};
   }
   if(request.schemaName==='delegated_root_advice')syntheses++;
   return gateway.complete(request);
  }};
  expect(await engine(capacityModel).run(f.target,slice())).toMatchObject({state:'yielded'});
  for(let n=0;n<8;n++){
   await completeChildren(f,capacityModel);await engine(capacityModel).run(await nextTarget(f),slice());
   if(['completed','blocked'].includes((await roots.read(f.actor,f.rootId)).state))break;
  }
  const view=await roots.read(f.actor,f.rootId);
  expect(view.state).toBe('completed');expect(syntheses).toBe(1);expect(offered).toBe(specialistLimit);
  expect(modelInput.specialistLimit).toBe(specialistLimit);expect(modelInput.prompt).toBe('Compare all workshop options and produce one complete recommendation');
  expect(await children(f)).toHaveLength(specialistLimit+(withNote?1:0));expect(view.coverage.every(item=>item.disposition==='advice_ready')).toBe(true);
  const checkpoints=(await admin.query('SELECT planner_state FROM pactwoven.native_delegation_root_checkpoints WHERE root_task_id=$1',[f.rootId])).rows;
  expect(checkpoints.every((row:{planner_state:string})=>JSON.parse(row.planner_state).bounded===false)).toBe(true);
 });
 it('rejects an over-capacity planner response before any checkpoint or child is dispatched',async()=>{
  const f=await fixture(4,true),diagnostic=vi.fn();let calls=0;
  const invalid:NativeModelGateway={async complete<T>(){calls++;return {value:{...plan,steps:Array.from({length:6},(_,i)=>({title:`Unbounded ${i}`,brief:'A required area of the complete objective.',role:'planning'}))} as T,usage:{inputTokens:1,outputTokens:1,totalTokens:2},deployment:'gpt-6.1-sol'};}};
  expect(await engine(invalid,coordinator,diagnostic).run(f.target,slice())).toMatchObject({state:'interrupted'});
  expect(calls).toBe(1);expect(await children(f)).toHaveLength(0);expect((await roots.read(f.actor,f.rootId)).checkpointVersion).toBe(0);
  expect(diagnostic.mock.calls).toEqual([[{runner:'coordinator',stage:'plan',failure:'invalid_shape'}]]);
 });
 it('executes plan, durable handoffs, child models, fresh input consumption and root advice using real SQL',async()=>{
  modelCalls.length=0;const f=await fixture(4,true);
  expect(await engine().run(f.target,slice())).toMatchObject({state:'yielded'});
  let view=await roots.read(f.actor,f.rootId);expect(view).toMatchObject({state:'waiting_children',attempt:1,generation:2});
  expect((await children(f)).length).toBe(3);await completeChildren(f);
  expect(await engine().run(await nextTarget(f),slice())).toMatchObject({state:'settled'});
  view=await roots.read(f.actor,f.rootId);expect(view).toMatchObject({state:'completed',attempt:1,domainCompletion:false});expect(view.coverage.every(x=>x.disposition==='advice_ready')).toBe(true);
  expect(modelCalls.map(call=>call.role).sort()).toEqual(['coordinator','coordinator','escalation','planning','research','research']);
  const planCall=modelCalls.find(call=>call.schemaName==='delegated_operator_plan')!;expect(planCall.input).not.toContain('Prefer blue chairs');
  const specialistInputs=modelCalls.filter(call=>call.schemaName==='delegated_specialist_advice');expect(specialistInputs.filter(call=>call.input.includes('Prefer blue chairs')).length).toBe(1);
  expect((await admin.query('SELECT count(*)::int n FROM pactwoven.native_memory_usages WHERE organization_id=$1',[f.actor.organizationId])).rows[0].n).toBe(1);
  expect((await admin.query('SELECT count(*)::int n FROM pactwoven.native_delegation_root_inputs WHERE root_task_id=$1',[f.rootId])).rows[0].n).toBe(1);
  expect((await admin.query('SELECT status FROM pactwoven.native_tasks WHERE id=$1',[f.legacy])).rows[0].status).toBe('paused');
 });
 async function rootUsage(f:Awaited<ReturnType<typeof fixture>>){
  const rows=(await admin.query('SELECT planner_state FROM pactwoven.native_delegation_root_checkpoints WHERE root_task_id=$1 ORDER BY version DESC LIMIT 1',[f.rootId])).rows;
  return JSON.parse(rows[0].planner_state).usage;
 }
 function qualityModel(outcome:'repair'|'reject_twice'|'unknown_review',calls:string[]):NativeModelGateway{
  let reviews=0;
  return {async complete<T>(request:ModelRequest<T>){
   calls.push(request.schemaName);
   if(request.schemaName==='delegated_root_advice')return {value:request.schema.parse({...defaultAdvice,recommendations:[':00']}),usage:{inputTokens:7,outputTokens:3,totalTokens:10},deployment:azureDeployments[request.role]};
   if(request.schemaName==='delegated_advice_quality'){
    if(outcome==='unknown_review')throw new NativeGatewayError('NETWORK');
    if(++reviews===1||outcome==='reject_twice')return {value:request.schema.parse(qualityReview(JSON.parse(request.input),true)),usage:{inputTokens:7,outputTokens:3,totalTokens:10},deployment:azureDeployments[request.role]};
   }
   return gateway.complete(request);
  }};
 }
 it('repairs one confirmed semantic fragment then requires review before publishing and preserves all known root usage',async()=>{
  const f=await fixture(),calls:string[]=[],model=qualityModel('repair',calls);
  await engine(model).run(f.target,slice());await completeChildren(f);calls.length=0;
  expect(await engine(model).run(await nextTarget(f),slice())).toMatchObject({state:'settled'});
  expect(calls).toEqual(['delegated_root_advice','delegated_advice_quality','delegated_root_advice_repair','delegated_advice_quality']);
  const view=await roots.read(f.actor,f.rootId);expect(view.state).toBe('completed');expect(view.result?.artifacts[0]?.text).toContain('Confirm dimensions.');expect(view.result?.artifacts[0]?.text).not.toContain(':00');
  expect(await rootUsage(f)).toEqual({inputTokens:35,outputTokens:15,totalTokens:50});
 });
 it('settles a second semantic rejection as fixed blocked, retains usage and does not replay it',async()=>{
  const f=await fixture(),calls:string[]=[],model=qualityModel('reject_twice',calls);
  await engine(model).run(f.target,slice());await completeChildren(f);calls.length=0;const target=await nextTarget(f);
  expect(await engine(model).run(target,slice())).toMatchObject({state:'settled'});
  expect((await roots.read(f.actor,f.rootId)).result).toEqual(NATIVE_ROOT_BLOCKED_RESULT);
  expect(await rootUsage(f)).toEqual({inputTokens:35,outputTokens:15,totalTokens:50});
  expect(calls).toEqual(['delegated_root_advice','delegated_advice_quality','delegated_root_advice_repair','delegated_advice_quality']);
  expect(await engine(model).run(target,slice())).toMatchObject({state:'interrupted'});expect(calls).toHaveLength(4);expect(await dispatcher.route(target)).toBeNull();
 });
 it('settles an unknown reviewer network outcome as fixed blocked without retry or fabricated usage',async()=>{
  const f=await fixture(),calls:string[]=[],model=qualityModel('unknown_review',calls);
  await engine(model).run(f.target,slice());await completeChildren(f);calls.length=0;
  expect(await engine(model).run(await nextTarget(f),slice())).toMatchObject({state:'settled'});
  expect((await roots.read(f.actor,f.rootId)).result).toEqual(NATIVE_ROOT_BLOCKED_RESULT);
  expect(await rootUsage(f)).toEqual({inputTokens:14,outputTokens:6,totalTokens:20});
  expect(calls).toEqual(['delegated_root_advice','delegated_advice_quality']);
 });
 it.each(['delegated_root_advice','delegated_advice_quality','delegated_root_advice_repair'])('persists actual Azure malformed-envelope usage at %s before fixed blocked output',async(schemaName)=>{
  const f=await fixture(),calls:string[]=[],model=qualityModel('repair',calls);await engine().run(f.target,slice());await completeChildren(f);
  let requests=0;const actual=createAzureGateway({endpoint:'https://fixture.openai.azure.com/openai/v1',apiKey:'synthetic'},async()=>{requests++;return new Response(JSON.stringify({status:'completed',output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'{"invalid":true}'}]}],usage:{input_tokens:7,output_tokens:3,total_tokens:10}}));});
  const wrapped:NativeModelGateway={complete:request=>request.schemaName===schemaName?actual.complete(request):model.complete(request)};
  expect(await engine(wrapped).run(await nextTarget(f),slice())).toMatchObject({state:'settled'});
  expect((await roots.read(f.actor,f.rootId)).result).toEqual(NATIVE_ROOT_BLOCKED_RESULT);expect(requests).toBe(1);
  const known=schemaName==='delegated_root_advice'?20:schemaName==='delegated_advice_quality'?30:40;
  expect((await rootUsage(f)).totalTokens).toBe(known);
 });
 it('aborts a pending semantic review on cancellation with no publication, repair or post-abort checkpoint',async()=>{
  const f=await fixture();await engine().run(f.target,slice());await completeChildren(f);
  let started!:()=>void;const ready=new Promise<void>(resolve=>{started=resolve;});let signal:AbortSignal|undefined,writes=0;const calls:string[]=[];
  const model:NativeModelGateway={complete:request=>{calls.push(request.schemaName);if(request.schemaName==='delegated_advice_quality'){signal=request.signal;started();return new Promise(()=>{});}return gateway.complete(request);}};
  const wrapped=new PostgresNativeRootCoordinatorRepository({query:async(...args:unknown[])=>{if(String(args[0]).includes('root_checkpoint')||String(args[0]).includes('root_complete'))writes++;return (coordinatorPool.query as (...args:unknown[])=>Promise<unknown>)(...args);}} as unknown as Pool,'simulation');
  const controller=new AbortController(),pending=engine(model,wrapped).run(await nextTarget(f),{...slice(),signal:controller.signal});
  await ready;await roots.control(f.actor,id(),{rootTaskId:f.rootId,expectedVersion:1,action:'cancel'});controller.abort();
  expect(await pending).toMatchObject({state:'interrupted'});expect(signal?.aborted).toBe(true);expect(writes).toBe(0);
  expect(calls).toEqual(['delegated_root_advice','delegated_advice_quality']);
  expect((await admin.query('SELECT count(*)::int n FROM pactwoven.native_delegation_root_completions WHERE root_task_id=$1',[f.rootId])).rows[0].n).toBe(0);
 });
 it('never retries a lost quality-usage checkpoint acknowledgement or publishes after it',async()=>{
  const f=await fixture();await engine().run(f.target,slice());await completeChildren(f);let writes=0,completions=0;
  const wrapped=new PostgresNativeRootCoordinatorRepository({query:async(...args:unknown[])=>{if(String(args[0]).includes('root_complete'))completions++;const result=await (coordinatorPool.query as (...args:unknown[])=>Promise<unknown>)(...args);if(String(args[0]).includes('root_checkpoint')){writes++;throw new Error('Synthetic committed quality usage response loss');}return result;}} as unknown as Pool,'simulation');
  const diagnostic=vi.fn();
  expect(await engine(gateway,wrapped,diagnostic).run(await nextTarget(f),slice())).toMatchObject({state:'unconfirmed'});
  expect(writes).toBe(1);expect(completions).toBe(0);expect((await roots.read(f.actor,f.rootId)).result).toBeNull();
  expect(await rootUsage(f)).toEqual({inputTokens:21,outputTokens:9,totalTokens:30});
  expect(diagnostic.mock.calls).toEqual([[{runner:'coordinator',stage:'checkpoint',failure:'persistence_unknown'}]]);
 });
 it('keeps normal yielding on the same logical attempt without replanning or duplicate handoffs',async()=>{
  modelCalls.length=0;const f=await fixture();await engine().run(f.target,slice());const before=await children(f);
  await completeChildren(f);await engine().run(await nextTarget(f),slice());
  expect((await children(f)).map(x=>x.taskId)).toEqual(before.map(x=>x.taskId));expect(modelCalls.filter(x=>x.schemaName==='delegated_operator_plan')).toHaveLength(1);
  expect((await roots.read(f.actor,f.rootId)).attempt).toBe(1);
 });
 it('retains accepted children across human pause/resume and replaces only unfinished work within lifetime budget',async()=>{
  const f=await fixture();await engine().run(f.target,slice());const original=await children(f),first=original[0]!;
  await specialist().run({organizationId:first.organizationId,taskId:first.taskId,generation:first.generation},slice());
  const paused=await roots.control(f.actor,id(),{rootTaskId:f.rootId,expectedVersion:1,action:'pause'});
  await roots.control(f.actor,id(),{rootTaskId:f.rootId,expectedVersion:paused.controlVersion,action:'resume'});
  expect(await engine().run(await nextTarget(f),slice())).toMatchObject({state:'yielded'});
  const current=await children(f);expect(current).toHaveLength(3);expect(current.find(x=>x.taskId===first.taskId)?.state).toBe('settled');
  await completeChildren(f);expect(await engine().run(await nextTarget(f),slice())).toMatchObject({state:'settled'});
  // All current assignments complete; the prior abandoned attempt remains in exact coverage.
  const final=await roots.read(f.actor,f.rootId);expect(final).toMatchObject({state:'completed',attempt:1});expect(final.coverage.some(x=>x.disposition==='abandoned')).toBe(true);
 });
 it('publishes no advice when a memory read acknowledgement is lost and does not select it again',async()=>{
  const f=await fixture(4,true);await engine().run(f.target,slice());
  const assigned=(await admin.query("SELECT t.id,t.generation FROM pactwoven.native_delegation_tasks t JOIN pactwoven.native_delegation_root_assignments a ON(a.environment,a.organization_id,a.task_id,a.generation)=(t.environment,t.organization_id,t.id,t.generation) WHERE t.parent_task_id=$1 AND jsonb_array_length(a.assignment->'memoryReferences')>0",[f.rootId])).rows[0];
  let reads=0;const lostMemory={read:async(...args:Parameters<typeof memory.read>)=>{reads++;await memory.read(...args);throw new Error('Synthetic response loss');}};
  const diagnostic=vi.fn(()=>{throw new Error('Diagnostic sink unavailable');});
  const runner=new DelegatedSpecialist({environment:'simulation',identity:workerId,repository:worker,materials,memory:lostMemory,gateway,observe:observer,onDiagnostic:diagnostic});
  expect(await runner.run({organizationId:f.actor.organizationId,taskId:assigned.id,generation:Number(assigned.generation)},slice())).toMatchObject({state:'unconfirmed'});expect(reads).toBe(1);
  expect(diagnostic.mock.calls).toEqual([[{runner:'specialist',stage:'memory',failure:'persistence_unknown'}]]);
  expect((await admin.query('SELECT count(*)::int n FROM pactwoven.native_delegation_results WHERE organization_id=$1',[f.actor.organizationId])).rows[0].n).toBe(0);
 });
 it('settles blocked without rereading revoked child evidence or calling the aggregate model',async()=>{
  const f=await fixture(4,true);await engine().run(f.target,slice());await completeChildren(f);
  await notes.command(f.actor,id(),{kind:'remove',siteId:f.siteId,noteId:f.note!.id,expected:f.note!.editToken!});
  modelCalls.length=0;expect(await engine().run(await nextTarget(f),slice())).toMatchObject({state:'settled'});
  expect((await roots.read(f.actor,f.rootId)).result).toEqual(NATIVE_ROOT_BLOCKED_RESULT);expect(modelCalls).toHaveLength(0);
 });
 it('aborts a noncooperating child model on operator cancellation and never publishes a fabricated result',async()=>{
  const f=await fixture();await engine().run(f.target,slice());const child=(await children(f))[0]!;
  let started!:()=>void;const ready=new Promise<void>(resolve=>{started=resolve;});let signal:AbortSignal|undefined;
  const slow:NativeModelGateway={complete:request=>{signal=request.signal;started();return new Promise(()=>{});}};
  const controller=new AbortController(),pending=specialist(slow).run({organizationId:child.organizationId,taskId:child.taskId,generation:child.generation},{...slice(),signal:controller.signal});
  await ready;await roots.control(f.actor,id(),{rootTaskId:f.rootId,expectedVersion:1,action:'cancel'});controller.abort();
  expect(await pending).toMatchObject({state:'interrupted'});expect(signal?.aborted).toBe(true);
  expect((await admin.query('SELECT count(*)::int n FROM pactwoven.native_delegation_results WHERE organization_id=$1',[f.actor.organizationId])).rows[0].n).toBe(0);
 });
 it('does not replay a checkpoint after its acknowledgement is lost',async()=>{
  const f=await fixture();let writes=0;
  const uncertain=new PostgresNativeRootCoordinatorRepository({query:async(...args:unknown[])=>{const result=await (coordinatorPool.query as (...args:unknown[])=>Promise<unknown>)(...args);if(String(args[0]).includes('root_checkpoint')){writes++;throw new Error('Synthetic response loss');}return result;}} as unknown as Pool,'simulation');
  const diagnostic=vi.fn();
  expect(await engine(gateway,uncertain,diagnostic).run(f.target,slice())).toMatchObject({state:'unconfirmed'});expect(writes).toBe(1);expect(await children(f)).toHaveLength(0);
  expect(diagnostic.mock.calls).toEqual([[{runner:'coordinator',stage:'checkpoint',failure:'persistence_unknown'}]]);
  expect((await roots.read(f.actor,f.rootId)).checkpointVersion).toBe(1);
 });
 it('publishes actual failed child result for model rejection and a generic blocked root',async()=>{
  const f=await fixture();await engine().run(f.target,slice());const failed:NativeModelGateway={async complete(){throw new NativeGatewayError('REFUSED');}};
  await completeChildren(f,failed);expect(await engine().run(await nextTarget(f),slice())).toMatchObject({state:'settled'});
  expect((await roots.read(f.actor,f.rootId)).result).toEqual(NATIVE_ROOT_BLOCKED_RESULT);
 });

 it('recovers a crashed claimed root within its original total attempt limit without replaying the plan',async()=>{
  const f=await fixture(2);await engine().run(f.target,slice());await completeChildren(f);
  const target=await nextTarget(f);await allow(target);const claim=await coordinator.claim(target);
  await admin.query("UPDATE pactwoven.native_delegation_tasks SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[f.rootId]);
  expect((await dispatcher.recover(20)).find(row=>row.rootTaskId===f.rootId)).toMatchObject({attempt:2,action:'recovered'});
  modelCalls.length=0;expect(await engine().run(await nextTarget(f),slice())).toMatchObject({state:'settled'});
  expect(modelCalls.map(call=>call.schemaName)).toEqual(['delegated_root_advice','delegated_advice_quality']);expect((await roots.read(f.actor,f.rootId)).attempt).toBe(2);
  await expect(coordinator.checkpoint(claim.selector,{requestKey:id(),expectedCheckpointVersion:2,checkpoint:{stage:'ready',summary:'Old',steps:[]},plannerState:'{}',inputReceipts:[]})).rejects.toBeDefined();
 });
 it('consumes new generation receipts after a normal yield and never reuses generated synthesis',async()=>{
  const f=await fixture();await engine().run(f.target,slice());await completeChildren(f);
  const start=Date.now();let clock=start;
  const wrapped=new PostgresNativeRootCoordinatorRepository({query:async(...args:unknown[])=>{const result=await (coordinatorPool.query as (...args:unknown[])=>Promise<unknown>)(...args);if(String(args[0]).includes('root_inputs'))clock=start+6000;return result;}} as unknown as Pool,'simulation');
  const yielding=new DelegatedCoordinator({environment:'simulation',services,repository:wrapped,renewal:genericCoordinator,gateway,observe:observer,now:()=>clock});
  modelCalls.length=0;expect(await yielding.run(await nextTarget(f),{deadlineAt:start+20000})).toMatchObject({state:'yielded'});expect(modelCalls).toHaveLength(0);
  expect(await engine().run(await nextTarget(f),slice())).toMatchObject({state:'settled'});
  const receipts=(await admin.query('SELECT id,generation FROM pactwoven.native_delegation_root_inputs WHERE root_task_id=$1 ORDER BY generation',[f.rootId])).rows;
  expect(receipts).toHaveLength(2);expect(receipts[0].id).not.toBe(receipts[1].id);expect(Number(receipts[1].generation)).toBe(Number(receipts[0].generation)+1);
  expect(modelCalls.map(call=>call.schemaName)).toEqual(['delegated_root_advice','delegated_advice_quality']);
 });
 it('does not retry after accepted handoff, input or final publication acknowledgements are lost',async()=>{
  for(const operation of ['root_handoff','root_inputs','root_complete']){
   const f=await fixture();if(operation!=='root_handoff'){await engine().run(f.target,slice());await completeChildren(f);}
   let writes=0;const wrapped=new PostgresNativeRootCoordinatorRepository({query:async(...args:unknown[])=>{const result=await (coordinatorPool.query as (...args:unknown[])=>Promise<unknown>)(...args);if(String(args[0]).includes(operation)){writes++;throw new Error('Synthetic committed response loss');}return result;}} as unknown as Pool,'simulation');
   expect(await engine(gateway,wrapped).run(await nextTarget(f),slice())).toMatchObject({state:'unconfirmed'});expect(writes).toBe(1);
   if(operation==='root_handoff')expect(await children(f)).toHaveLength(1);
   if(operation==='root_inputs')expect((await roots.read(f.actor,f.rootId)).result).toBeNull();
   if(operation==='root_complete')expect((await roots.read(f.actor,f.rootId)).state).toBe('completed');
  }
 });
 it('delivers actual SQL outbox messages through the composed runtime with metadata only',async()=>{
  // Earlier independent cases leave synthetic outboxes intentionally unacknowledged.
  // This dedicated fixture owns these rows; exclude them from this delivery case.
  await admin.query("UPDATE pactwoven.native_delegation_outbox SET state='suppressed',token=NULL,lease_until=NULL WHERE environment='simulation'");
  const f=await fixture(4,true),queue:DelegatedQueueMessage[]=[],sentKeys:string[]=[];
  const runtime=createDelegatedRuntime({environment:'simulation',services,pools:{coordinator:coordinatorPool,worker:workerPool,dispatcher:dispatcherPool},gateway,observe:observer,
   send:async(message,options)=>{queue.push(DelegatedQueueMessageSchema.parse(message));sentKeys.push(options.idempotencyKey);return{};}});
  for(let iteration=0;iteration<8;iteration++){
   await runtime.publish(Date.now()+60000);
   const next=queue.shift();if(next)expect(await runtime.consume(next,slice())).toBe('settled');
   else if((await roots.read(f.actor,f.rootId)).state==='completed')break;
  }
  expect((await roots.read(f.actor,f.rootId)).state).toBe('completed');expect(sentKeys).toHaveLength(5);expect(new Set(sentKeys).size).toBe(5);
  expect(await runtime.consume({schemaVersion:1,environment:'simulation',kind:'root',target:f.target},slice())).toBe('discarded');
 });

 it('recovers an expired specialist lease and its unknown memory debt through a new root generation',async()=>{
  const f=await fixture(2,true);await engine().run(f.target,slice());const all=await children(f);
  const assigned=(await admin.query("SELECT t.id,t.generation FROM pactwoven.native_delegation_tasks t JOIN pactwoven.native_delegation_root_assignments a ON(a.environment,a.organization_id,a.task_id,a.generation)=(t.environment,t.organization_id,t.id,t.generation) WHERE t.parent_task_id=$1 AND jsonb_array_length(a.assignment->'memoryReferences')>0",[f.rootId])).rows[0];
  const saved=all.find(child=>child.taskId!==assigned.id)!;await specialist().run({organizationId:saved.organizationId,taskId:saved.taskId,generation:saved.generation},slice());
  const target={organizationId:f.actor.organizationId,taskId:assigned.id,generation:Number(assigned.generation)};await allow(target);const lease=await worker.claim(target),material=await materials.materials(lease.selector);
  await memory.read({...lease.selector,handoffId:lease.selector.handoffId!},material.assignment.memoryReferences[0]!);
  await admin.query("UPDATE pactwoven.native_delegation_tasks SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[assigned.id]);
  const recovered=(await dispatcher.recover(20)).find(row=>row.rootTaskId===f.rootId);expect(recovered).toMatchObject({action:'recovered',attempt:2});
  expect(await engine().run(await nextTarget(f),slice())).toMatchObject({state:'yielded'});await completeChildren(f);
  expect(await engine().run(await nextTarget(f),slice())).toMatchObject({state:'settled'});
  const view=await roots.read(f.actor,f.rootId);expect(view).toMatchObject({state:'completed',attempt:2});expect(view.coverage.find(row=>row.taskId===saved.taskId)?.disposition).toBe('advice_ready');
  expect((await admin.query('SELECT count(*)::int n FROM pactwoven.native_memory_usages WHERE organization_id=$1',[f.actor.organizationId])).rows[0].n).toBe(2);
 });
 it('blocks a stranded specialist tree at the original attempt bound and never wakes a manual pause',async()=>{
  for(const pause of [false,true]){
   const f=await fixture(1);await engine().run(f.target,slice());const child=(await children(f))[0]!,target={organizationId:child.organizationId,taskId:child.taskId,generation:child.generation};
   await allow(target);await worker.claim(target);
   if(pause)await roots.control(f.actor,id(),{rootTaskId:f.rootId,expectedVersion:1,action:'pause'});
   else await admin.query("UPDATE pactwoven.native_delegation_tasks SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[child.taskId]);
   const recovered=(await dispatcher.recover(20)).find(row=>row.rootTaskId===f.rootId);
   if(pause){expect(recovered).toBeUndefined();expect((await roots.read(f.actor,f.rootId)).state).toBe('paused');}
   else {expect(recovered).toMatchObject({action:'blocked',attempt:1});expect((await roots.read(f.actor,f.rootId)).state).toBe('blocked');}
   expect(await dispatcher.route(target)).toBeNull();
  }
 });
 it('does not admit concurrent managed root or specialist claims to the same lease',async()=>{
  const root=await fixture();await allow(root.target);await coordinator.claim(root.target);await expect(coordinator.claim(root.target)).rejects.toBeDefined();
  const f=await fixture();await engine().run(f.target,slice());const child=(await children(f))[0]!,target={organizationId:child.organizationId,taskId:child.taskId,generation:child.generation};
  await allow(target);await worker.claim(target);await expect(worker.claim(target)).rejects.toBeDefined();
 });

 it('settles a rejected original note admission without a model call or fictitious memory receipt',async()=>{
  const f=await fixture(4,true);await engine().run(f.target,slice());
  await notes.command(f.actor,id(),{kind:'remove',siteId:f.siteId,noteId:f.note!.id,expected:f.note!.editToken!});
  const assigned=(await admin.query("SELECT t.id,t.generation FROM pactwoven.native_delegation_tasks t JOIN pactwoven.native_delegation_root_assignments a ON(a.environment,a.organization_id,a.task_id,a.generation)=(t.environment,t.organization_id,t.id,t.generation) WHERE t.parent_task_id=$1 AND jsonb_array_length(a.assignment->'memoryReferences')>0",[f.rootId])).rows[0];
  modelCalls.length=0;expect(await specialist().run({organizationId:f.actor.organizationId,taskId:assigned.id,generation:Number(assigned.generation)},slice())).toMatchObject({state:'settled'});expect(modelCalls).toHaveLength(0);
  expect((await admin.query('SELECT count(*)::int n FROM pactwoven.native_memory_usages WHERE organization_id=$1',[f.actor.organizationId])).rows[0].n).toBe(0);
  await completeChildren(f);expect(await engine().run(await nextTarget(f),slice())).toMatchObject({state:'settled'});expect((await roots.read(f.actor,f.rootId)).result).toEqual(NATIVE_ROOT_BLOCKED_RESULT);
 });

 it('uses Astra for immutable escalation assignments and root review while keeping drafting on Sol',async()=>{
  const f=await fixture(),roles:string[]=[];
  const model:NativeModelGateway={async complete<T>(request:ModelRequest<T>){roles.push(request.role);if(request.schemaName==='delegated_operator_plan')return {value:request.schema.parse({...plan,steps:[{title:'Resolve ambiguity',brief:'Explain the uncertain tradeoff.',role:'escalation'}]}),usage:{inputTokens:1,outputTokens:1,totalTokens:2},deployment:'gpt-6.1-sol'};return gateway.complete(request);}};
  await engine(model).run(f.target,slice());await completeChildren(f,model);await engine(model).run(await nextTarget(f),slice());
  expect(roles).toEqual(['coordinator','escalation','coordinator','escalation']);expect((await roots.read(f.actor,f.rootId)).state).toBe('completed');
 });
 it('reads only original operator URLs and never fetches a model-suggested URL',async()=>{
  const f=await fixture(4,false,true,false,'Review https://example.com/chairs'),urls:string[]=[];
  const model:NativeModelGateway={async complete<T>(request:ModelRequest<T>){if(request.schemaName==='delegated_operator_plan')return {value:request.schema.parse({...plan,steps:[{title:'Review sources',brief:'Read https://model-injected.example/stolen',role:'research'}]}),usage:{inputTokens:1,outputTokens:1,totalTokens:2},deployment:'gpt-6.1-sol'};return gateway.complete(request);}};
  await engine(model).run(f.target,slice());const child=(await children(f))[0]!;
  const reader=createSourceEvidenceReader(async(url)=>{urls.push(url);return {title:'Chair page',url,text:'Blue upholstery is available.',observedAt:at()};});
  const runner=new DelegatedSpecialist({environment:'simulation',identity:workerId,repository:worker,materials,memory,gateway:model,observe:observer,evidenceReader:reader});
  expect(await runner.run({organizationId:child.organizationId,taskId:child.taskId,generation:child.generation},slice())).toMatchObject({state:'settled'});
  expect(urls).toEqual(['https://example.com/chairs']);expect(await engine(model).run(await nextTarget(f),slice())).toMatchObject({state:'settled'});
 });
 it('rejects planner-cache assignment substitution against immutable child work',async()=>{
  const f=await fixture();await engine().run(f.target,slice());await completeChildren(f);
  const wrapped=new PostgresNativeRootCoordinatorRepository({query:async(...args:unknown[])=>{const result=await (coordinatorPool.query as (...args:unknown[])=>Promise<{rows:Array<{response:any}>}>)(...args);if(String(args[0]).includes('root_work')){const work=result.rows[0]!.response,state=JSON.parse(work.plannerState);state.slots[0].assignment.brief='Unapproved replacement';work.plannerState=JSON.stringify(state);}return result;}} as unknown as Pool,'simulation');
  modelCalls.length=0;expect(await engine(gateway,wrapped).run(await nextTarget(f),slice())).toMatchObject({state:'interrupted'});expect(modelCalls).toHaveLength(0);expect((await roots.read(f.actor,f.rootId)).result).toBeNull();
 });

 it('revalidates after aggregate reasoning and settles only generic blocked text if original memory was revoked',async()=>{
  const f=await fixture(4,true);await engine().run(f.target,slice());await completeChildren(f);
  const model:NativeModelGateway={async complete<T>(request:ModelRequest<T>){const result=await gateway.complete(request);await notes.command(f.actor,id(),{kind:'remove',siteId:f.siteId,noteId:f.note!.id,expected:f.note!.editToken!});return result;}};
  expect(await engine(model).run(await nextTarget(f),slice())).toMatchObject({state:'settled'});
  const view=await roots.read(f.actor,f.rootId);expect(view).toMatchObject({result:null,checkpoint:null,evidenceUnavailable:true,state:'blocked'});
  const retained=(await admin.query("SELECT publication->'result' AS result FROM pactwoven.native_delegation_root_completions WHERE organization_id=$1 AND root_task_id=$2",[f.actor.organizationId,f.rootId])).rows[0];
  expect(retained.result).toEqual(NATIVE_ROOT_BLOCKED_RESULT);
  expect(JSON.stringify(view.result)).not.toContain('Prefer blue chairs');
 });
 it('waits for an in-flight authority preparation before publishing the exact completed child',async()=>{
  const f=await fixture();await engine().run(f.target,slice());const original=await children(f),child=original[0]!;
  let releaseModel!:()=>void,releaseObservation!:()=>void,prepared!:()=>void,published!:()=>void,modelFinished!:()=>void;
  const modelGate=new Promise<void>(resolve=>{releaseModel=resolve;}),observationGate=new Promise<void>(resolve=>{releaseObservation=resolve;});
  const modelFinishedSignal=new Promise<void>(resolve=>{modelFinished=resolve;});
  const preparedSignal=new Promise<void>(resolve=>{prepared=resolve;}),publicationSignal=new Promise<void>(resolve=>{published=resolve;});
  let observations=0,publications=0;const diagnostics:unknown[]=[];
  const heldObserver=async(target:NativeDelegationTarget)=>{
   if(++observations!==2)return observer(target);
   const challenge=await api.prepare(target,issuer);if(challenge.kind!=='prepared')throw Error('Fresh authority preparation required');
   prepared();await observationGate;
   const result=await api.finish(challenge.nonce,{state:'allowed',reason:'current',observationStartedAt:at(-10),observationCompletedAt:at()});
   return {result,usableUntil:result.state==='allowed'?Math.min(Date.parse(result.validUntil!),Date.now()+15000):null};
  };
  const slow:NativeModelGateway={async complete<T>(request:ModelRequest<T>){await modelGate;const result=await gateway.complete(request);modelFinished();return result;}};
  const publication={claim:worker.claim.bind(worker),renew:worker.renew.bind(worker),result:async(...args:Parameters<typeof worker.result>)=>{publications++;try{return await worker.result(...args);}finally{published();}}};
  const runner=new DelegatedSpecialist({environment:'simulation',identity:workerId,repository:publication,materials,memory,gateway:slow,observe:heldObserver,onDiagnostic:event=>{diagnostics.push(event);}});
  const pending=runner.run({organizationId:child.organizationId,taskId:child.taskId,generation:child.generation},slice());
  await preparedSignal;
  const heldProof=(await admin.query('SELECT verdict,valid_until FROM pactwoven.native_delegation_proofs WHERE task_id=$1',[child.taskId])).rows[0];
  releaseModel();await modelFinishedSignal;await Promise.race([publicationSignal,new Promise<void>(resolve=>setTimeout(resolve,200))]);const enteredWhileUnknown=publications>0;
  releaseObservation();const outcome=await pending;
  const resultCount=(await admin.query('SELECT count(*)::int n FROM pactwoven.native_delegation_results WHERE organization_id=$1 AND handoff_id=(SELECT handoff_id FROM pactwoven.native_delegation_tasks WHERE id=$2)',[f.actor.organizationId,child.taskId])).rows[0].n;
  expect((await children(f)).map(item=>item.taskId)).toEqual(original.map(item=>item.taskId));
  expect(heldProof).toEqual({verdict:'unknown',valid_until:null});expect(enteredWhileUnknown).toBe(false);
  expect(outcome.state).toBe('settled');expect(publications).toBe(1);expect(resultCount).toBe(1);expect(diagnostics).toEqual([]);
 });
});
