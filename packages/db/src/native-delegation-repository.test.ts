import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ActorContext } from '@pactwoven/contracts';
import { commandDigest } from '@pactwoven/contracts/canonical';
import { NativeAdvisoryGrantSchema, type NativeAdvisoryHandoff, type NativeServiceIdentity } from '../../contracts/src/native-delegation';
import { PostgresNativeDelegationRepository, PostgresNativeDelegationWorkerRepository, PostgresNativeDelegationDispatchRepository,
  type NativeDelegationPublication, type NativeDelegationTarget } from './native-delegation-repository.js';
import { assertNativeDelegationPool, createNativeDelegationPool, type NativeDelegationPoolPurpose } from './native-delegation-pool.js';
import { PostgresNativeMemoryRepository, PostgresNativeMemoryTaskRepository } from './native-memory-repository';
import { assertNativeTaskPool } from './native-task-pool.js';

const databaseUrl = process.env.PACTWOVEN_NATIVE_DELEGATION_TEST_DATABASE_URL;
const issuer = 'https://delegation-fixture.clerk.accounts.dev';
const id = () => randomUUID().replaceAll('-', '_');
const at = (delta = 0) => new Date(Date.now() + delta).toISOString();
const identity = (name: string): NativeServiceIdentity => ({ serviceId: name, serviceVersion: 1, workloadIdentityId: `${name}_workload` });

describe.skipIf(!databaseUrl)('additive delegated persistence PostgreSQL boundaries', () => {
  let admin: Pool, apiPool: Pool, coordinatorPool: Pool, workerPool: Pool, dispatcherPool: Pool, legacyPool: Pool;
  let api: PostgresNativeDelegationRepository, coordinator: PostgresNativeDelegationWorkerRepository, worker: PostgresNativeDelegationWorkerRepository;
  let dispatcher: PostgresNativeDelegationDispatchRepository;
  const coordinatorId = identity(`coordinator_${id()}`), workerId = identity(`worker_${id()}`);
  let catalogBefore: unknown, legacyBefore: unknown, legacyId: string;
  let withMemory=false;const pools: Pool[] = [];const roles: Partial<Record<NativeDelegationPoolPurpose,string>> = {};
  async function catalog() {
    return (await admin.query(`SELECT p.oid::regprocedure::text signature,pg_get_functiondef(p.oid) body,p.proacl::text acl
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='pactwoven' AND p.proname !~ '^native_delegation_' ORDER BY 1`)).rows;
  }
  async function legacySnapshot(taskId: string) {
    return (await admin.query(`SELECT jsonb_build_object('task',(SELECT to_jsonb(t) FROM pactwoven.native_tasks t WHERE id=$1),
      'outbox',(SELECT jsonb_agg(to_jsonb(d) ORDER BY generation) FROM pactwoven.native_dispatch_outbox d WHERE task_id=$1)) value`, [taskId])).rows[0].value;
  }
  async function human() {
    const organizationId = id(), actorId = id(), siteId = id();
    await admin.query("INSERT INTO pactwoven.organizations(environment,id,external_organization_id,name) VALUES('development',$1,$1,'Synthetic delegation fixture')", [organizationId]);
    await admin.query(`INSERT INTO pactwoven.memberships(environment,organization_id,actor_id,external_subject,external_membership_id,grant_basis,roles)
      VALUES('development',$1,$2,$2,$3,'internal',ARRAY['owner'])`, [organizationId,actorId,`membership_${id()}`]);
    await admin.query("INSERT INTO pactwoven.sites(environment,organization_id,id,name,time_zone) VALUES('development',$1,$2,'Office','UTC')", [organizationId,siteId]);
    await admin.query("INSERT INTO pactwoven.member_action_sites VALUES('development',$1,$2,$3)", [organizationId,actorId,siteId]);
    const actor: ActorContext = { environment:'development', organizationId, actorId, principalKind:'human', roles:['owner'], siteIds:[siteId], actionSiteIds:[siteId],
      sessionId:`session_${id()}`, authenticatedAt:at(-100), correlationId:id() };
    const legacy = id();
    await admin.query(`INSERT INTO pactwoven.native_tasks(environment,organization_id,id,actor_id,session_id,site_id,title,prompt,status,phase,checkpoint)
      VALUES('development',$1,$2,$3,$4,$5,'Historical advice','Compare supplies','paused','Review','{"preserved":true}')`, [organizationId,legacy,actorId,actor.sessionId,siteId]);
    return { actor, legacy, siteId };
  }
  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (!['127.0.0.1','localhost'].includes(url.hostname) || !url.pathname.startsWith('/pactwoven_native_delegation_')) throw new Error('Dedicated synthetic loopback delegation fixture required.');
    admin = new Pool({ connectionString:url.href,max:4 });
    const seed = await human();legacyId=seed.legacy;catalogBefore=await catalog();legacyBefore=await legacySnapshot(legacyId);
    const installed = (await admin.query("SELECT to_regprocedure('pactwoven.native_delegation_binding(text,text)') IS NOT NULL installed")).rows[0].installed;
    if (!installed) await admin.query(readFileSync(new URL('../migrations/0026_native_delegation.sql', import.meta.url),'utf8'));
    expect(await catalog()).toEqual(catalogBefore);expect(await legacySnapshot(legacyId)).toEqual(legacyBefore);
    withMemory=(await admin.query("SELECT to_regprocedure('pactwoven.native_memory_task_read(text,jsonb,jsonb)') IS NOT NULL installed")).rows[0].installed;
    await admin.query("INSERT INTO pactwoven.native_provider_instances VALUES('development',$1,true) ON CONFLICT(environment) DO UPDATE SET issuer=excluded.issuer,enabled=true",[issuer]);
    for (const purpose of ['api','coordinator','worker','dispatcher'] as const) {
      const service = purpose==='coordinator'?coordinatorId:purpose==='worker'?workerId:identity(`${purpose}_${id()}`);
      await admin.query("INSERT INTO pactwoven.native_delegation_services VALUES('development',$1,$2::jsonb,$3,true)",[service.serviceId,JSON.stringify(service),purpose]);
      const role=`delegation_${purpose}_${id().slice(0,12)}`;roles[purpose]=role;
      const password=randomBytes(32).toString('base64url');
      const create=await admin.query<{sql:string}>("SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD %L',$1::text,$2::text) AS sql",[role,password]);
      await admin.query(create.rows[0]!.sql);
      await admin.query(`GRANT pactwoven_native_delegation_${purpose} TO ${role}`);
      await admin.query("INSERT INTO pactwoven.native_delegation_service_bindings SELECT rolname,oid,'development',$2,$3,true FROM pg_roles WHERE rolname=$1",[role,purpose,service.serviceId]);
      const connection=new URL(url);connection.username=role;connection.password=password;
      pools.push(await createNativeDelegationPool(connection.href,'development',purpose,withMemory?'delegation-memory':'delegation'));
    }
    [apiPool,coordinatorPool,workerPool,dispatcherPool]=pools as [Pool,Pool,Pool,Pool];
    const legacyRole=`delegation_legacy_${id().slice(0,12)}`;
    const legacyPassword=randomBytes(32).toString('base64url');
    const legacyCreate=await admin.query<{sql:string}>("SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD %L',$1::text,$2::text) AS sql",[legacyRole,legacyPassword]);
    await admin.query(legacyCreate.rows[0]!.sql);
    await admin.query(`GRANT pactwoven_native_task_api TO ${legacyRole}`);
    await admin.query("INSERT INTO pactwoven.native_task_service_bindings SELECT rolname,oid,'development','api',true FROM pg_roles WHERE rolname=$1",[legacyRole]);
    const legacyUrl=new URL(url);legacyUrl.username=legacyRole;legacyUrl.password=legacyPassword;legacyPool=new Pool({connectionString:legacyUrl.href,max:1});
    api=new PostgresNativeDelegationRepository(apiPool,'development');coordinator=new PostgresNativeDelegationWorkerRepository(coordinatorPool,'development');
    worker=new PostgresNativeDelegationWorkerRepository(workerPool,'development');dispatcher=new PostgresNativeDelegationDispatchRepository(dispatcherPool,'development');
  });
  afterAll(async()=>{await Promise.allSettled([...pools,legacyPool,admin].filter(Boolean).map(p=>p.end()));});
  async function fixture(limits: Partial<{maxDepth:number;maxChildren:number;maxConcurrentChildren:number}> = {}) {
    const h=await human();await admin.query("INSERT INTO pactwoven.native_delegation_policies VALUES('development',$1,1,true)",[h.actor.organizationId]);
    const membership=(await admin.query('SELECT external_membership_id FROM pactwoven.memberships WHERE organization_id=$1',[h.actor.organizationId])).rows[0];
    const grantId=id(),requestKey=id(),expiresAt=at(3600000);const scope={environment:'development' as const,organizationId:h.actor.organizationId,
      issuer:{actorId:h.actor.actorId,providerIssuer:issuer,subject:h.actor.actorId,externalOrganizationId:h.actor.organizationId,externalMembershipId:membership.external_membership_id,membershipVersion:1},
      organizationEpoch:0,policyVersion:1,purpose:'Compare supplies',sites:[{siteId:h.siteId,siteVersion:1}],capabilityVersion:1 as const,
      capabilities:['research_public_sources','read_scoped_memory','draft_advice'] as const,
      limits:{maxDepth:3,maxConcurrentChildren:3,maxChildren:32,maxAttempts:4,taskTimeoutMs:300000,...limits}};
    const request={grantId,requestKey,mode:'advise',externalEffects:'forbidden',scope,expiresAt,continuesAfterSignOut:true};
    const grant=NativeAdvisoryGrantSchema.parse({schemaVersion:1,id:grantId,version:1,revocationEpoch:0,mode:'advise',externalEffects:'forbidden',scope,
      issuedAt:at(),expiresAt,issuance:{requestKey,sessionId:h.actor.sessionId,authenticatedAt:h.actor.authenticatedAt,confirmedAt:at(-20),scopeDigest:await commandDigest(request),continuesAfterSignOut:true},revocation:null});
    const issuance={rootTaskId:id(),service:coordinatorId,sessionVerifiedAt:at(),sessionExpiresAt:at(60000)};
    const issued=await api.issue(h.actor,h.legacy,grant,issuance);
    return {...h,grant,issuance,issued,target:{organizationId:h.actor.organizationId,taskId:issuance.rootTaskId,generation:1}};
  }
  async function allow(target: NativeDelegationTarget,state:'allowed'|'denied'|'unavailable'='allowed') {
    const p=await api.prepare(target,issuer);expect(p.kind).toBe('prepared');if(p.kind!=='prepared')throw new Error('Missing prepare');
    expect(p.context).not.toHaveProperty('sessionId');expect(p.target).toEqual(target);expect(Date.parse(p.deadlineAt)-Date.parse(p.preparedAt)).toBe(8000);
    const result=await api.finish(p.nonce,{state,reason:state==='allowed'?'current':state==='denied'?'membership_removed':'provider_unavailable',observationStartedAt:at(-10),observationCompletedAt:at()});
    expect(result.state).toBe(state);return {p,result};
  }
  async function running(limits = {}) {const f=await fixture(limits);await allow(f.target);return {...f,claim:await coordinator.claim(f.target)};}
  function envelope(f:Awaited<ReturnType<typeof running>>,patch:Partial<NativeAdvisoryHandoff>={}):NativeAdvisoryHandoff {
    return {schemaVersion:1,handoffId:id(),environment:'development',organizationId:f.actor.organizationId,siteId:f.siteId,authority:f.issued.authority,
      rootTaskId:f.target.taskId,parentTaskId:f.target.taskId,childTaskId:id(),assignmentVersion:1,generation:1,sender:coordinatorId,recipient:workerId,
      capability:'research_public_sources',capabilityVersion:1,depth:1,attemptLimit:4,taskTimeoutMs:300000,issuedAt:at(),deadlineAt:at(240000),inputArtifacts:[],outputContract:'advisory_artifacts_v1',correlationId:id(),...patch};
  }
  async function child() {const f=await running(),handoff=envelope(f);await coordinator.handoff(f.claim.selector,handoff);
    const target={organizationId:f.actor.organizationId,taskId:handoff.childTaskId,generation:1};await allow(target);return {...f,handoff,childTarget:target,childClaim:await worker.claim(target)};}
  async function publication(f:Awaited<ReturnType<typeof child>>):Promise<NativeDelegationPublication> {
    const body={title:'Advice',text:'Use the reviewed supply list.'};const reference={environment:'development' as const,organizationId:f.actor.organizationId,siteId:f.siteId,artifactId:id(),revision:1,digest:await commandDigest(body)};
    return {result:{schemaVersion:1,resultId:id(),handoffId:f.handoff.handoffId,handoffDigest:await commandDigest(f.handoff),environment:'development',organizationId:f.actor.organizationId,siteId:f.siteId,
      childTaskId:f.handoff.childTaskId,assignmentVersion:1,generation:1,authority:f.issued.authority,sender:workerId,recipient:coordinatorId,attempt:1,outcome:'advice_ready',artifacts:[reference],finishedAt:at(),evidenceValidUntil:at(60000)},
      artifacts:[{reference,body}],inputArtifacts:[],memoryUsage:[]};
  }
  async function snapshot(org:string) {return (await admin.query(`SELECT jsonb_build_object('grants',(SELECT jsonb_agg(to_jsonb(g)) FROM pactwoven.native_delegation_grants g WHERE organization_id=$1),
    'tasks',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM pactwoven.native_delegation_tasks t WHERE organization_id=$1),
    'envelopes',(SELECT jsonb_agg(to_jsonb(e) ORDER BY handoff_id,generation) FROM pactwoven.native_delegation_envelopes e WHERE organization_id=$1),
    'results',(SELECT jsonb_agg(to_jsonb(r)) FROM pactwoven.native_delegation_results r WHERE organization_id=$1),
    'artifacts',(SELECT jsonb_agg(to_jsonb(a)) FROM pactwoven.native_delegation_artifacts a WHERE organization_id=$1),
    'outbox',(SELECT jsonb_agg(to_jsonb(d) ORDER BY task_id,generation) FROM pactwoven.native_delegation_outbox d WHERE organization_id=$1)) value`,[org])).rows[0].value;}

  it('preserves populated v1 rows, function bodies, ACLs and old pool qualification',async()=>{
    expect(await catalog()).toEqual(catalogBefore);expect(await legacySnapshot(legacyId)).toEqual(legacyBefore);await expect(assertNativeTaskPool(legacyPool,'development','api')).resolves.toBeUndefined();
  });
  it.each(['api','coordinator','worker','dispatcher'] as const)('enforces the exact %s pool and rejects base/combined/other-purpose confusion',async purpose=>{
    const pool=pools[['api','coordinator','worker','dispatcher'].indexOf(purpose)]!;
    await expect(assertNativeDelegationPool(pool,'development',purpose,withMemory?'delegation-memory':'delegation')).resolves.toBeUndefined();
    await expect(assertNativeDelegationPool(pool,'simulation',purpose)).rejects.toMatchObject({code:'UNSAFE_DATABASE_ROLE'});
    await expect(assertNativeDelegationPool(pool,'development',purpose==='api'?'worker':'api')).rejects.toMatchObject({code:'UNSAFE_DATABASE_ROLE'});
    if(purpose!=='dispatcher')await expect(assertNativeDelegationPool(pool,'development',purpose,withMemory?'delegation':'delegation-memory')).rejects.toMatchObject({code:'UNSAFE_DATABASE_ROLE'});
  });
  it('denies raw tables, private gates and inherited extra function grants',async()=>{
    await expect(workerPool.query('SELECT * FROM pactwoven.native_delegation_grants')).rejects.toMatchObject({code:'42501'});
    await expect(workerPool.query("SELECT pactwoven.native_delegation_task_context_locked('development','{}','memory_read')")).rejects.toMatchObject({code:'42501'});
    await admin.query(`GRANT EXECUTE ON FUNCTION pactwoven.native_task_read(jsonb,text,integer) TO ${roles.worker}`);
    try{await expect(assertNativeDelegationPool(workerPool,'development','worker')).rejects.toMatchObject({code:'UNSAFE_DATABASE_ROLE'});}finally{await admin.query(`REVOKE EXECUTE ON FUNCTION pactwoven.native_task_read(jsonb,text,integer) FROM ${roles.worker}`);}
  });
  it.each([{z:'end',a:'start',ordered:[3,1,2]}, {'\u{10000}':'astral','\ue000':'bmp',quote:'"\n\\'}, {max:9007199254740991,min:-9007199254740991,zero:0}, {text:'é 日本語 🙂'}])('matches JavaScript canonical digests %#',async value=>{
    expect((await admin.query('SELECT pactwoven.native_delegation_hash($1::jsonb) digest',[JSON.stringify(value)])).rows[0].digest).toBe(await commandDigest(value));
  });
  it('rejects noncanonical unsafe/fractional SQL numbers',async()=>{
    for(const body of ['{"n":9007199254740992}','{"n":0.1}'])await expect(admin.query('SELECT pactwoven.native_delegation_hash($1::jsonb)',[body])).rejects.toMatchObject({code:'ND004'});
  });
  it('issues exactly once, retains original consent and conflicts on changed root/scope',async()=>{
    const f=await fixture(),before=await snapshot(f.actor.organizationId);expect((await api.issue(f.actor,f.legacy,f.grant,f.issuance)).kind).toBe('duplicate');
    expect(await snapshot(f.actor.organizationId)).toEqual(before);
    await expect(api.issue(f.actor,f.legacy,f.grant,{...f.issuance,rootTaskId:id()})).rejects.toMatchObject({code:'DELEGATION_CONFLICT'});
    expect(f.issued.authority.grantDigest).toBe(await commandDigest(f.grant));
  });
  it('continues after issuing-session local sign-out but explicit revoke fences all work and is idempotent',async()=>{
    const f=await running(),legacy=await legacySnapshot(f.legacy);
    await admin.query("INSERT INTO pactwoven.session_revocations VALUES('development',$1,clock_timestamp())",[f.actor.sessionId]);
    await allow(f.target);await expect(coordinator.renew(f.claim.selector)).resolves.toHaveProperty('validUntil');
    const signedIn={...f.actor,sessionId:`new_${id()}`,authenticatedAt:at()};const request={grantId:f.grant.id,expectedVersion:1,expectedRevocationEpoch:0,requestKey:id()};
    const revoked=await api.revoke(signedIn,request);expect(revoked.version).toBe(2);expect(await api.revoke(signedIn,request)).toEqual(revoked);
    await expect(coordinator.renew(f.claim.selector)).rejects.toMatchObject({code:'FORBIDDEN'});expect(await legacySnapshot(f.legacy)).toEqual(legacy);
  });
  it.each(['membership','policy','site','provider'] as const)('fences current work when %s authority changes',async change=>{
    const f=await running();
    if(change==='membership')await admin.query('UPDATE pactwoven.memberships SET row_version=row_version+1 WHERE organization_id=$1',[f.actor.organizationId]);
    if(change==='policy')await admin.query('UPDATE pactwoven.native_delegation_policies SET version=version+1 WHERE organization_id=$1',[f.actor.organizationId]);
    if(change==='site')await admin.query('DELETE FROM pactwoven.member_action_sites WHERE organization_id=$1',[f.actor.organizationId]);
    if(change==='provider')await admin.query("UPDATE pactwoven.native_provider_instances SET enabled=false WHERE environment='development'");
    try{await expect(coordinator.renew(f.claim.selector)).rejects.toMatchObject({code:'FORBIDDEN'});}finally{if(change==='provider')await admin.query("UPDATE pactwoven.native_provider_instances SET enabled=true WHERE environment='development'");}
  });
  it('uses nonce/barrier freshness and no session deadline for provider proof',async()=>{
    const f=await fixture(),{p,result}=await allow(f.target);if(result.state==='stale')throw new Error('Unexpected stale');
    expect(Date.parse(result.validUntil!)-Date.parse(p.preparedAt)).toBeLessThanOrEqual(20001);
    expect(await api.finish(p.nonce,{state:'allowed',reason:'current',observationStartedAt:at(),observationCompletedAt:at()})).toEqual({state:'stale'});
    expect(p.context).toEqual({subject:f.actor.actorId,externalOrganizationId:f.actor.organizationId,externalMembershipId:f.grant.scope.issuer.externalMembershipId,requiredRole:null});
  });
  it('distinguishes outage from denial and preserves legacy state',async()=>{
    const f=await running(),before=await snapshot(f.actor.organizationId);await allow(f.target,'unavailable');
    await expect(coordinator.renew(f.claim.selector)).rejects.toMatchObject({code:'FORBIDDEN'});expect(await snapshot(f.actor.organizationId)).toEqual(before);
    await allow(f.target,'denied');expect((await api.read(f.actor,f.grant.id)).tasks[0]?.state).toBe('paused');
  });
  it('reserves one child for duplicate deliveries and enforces grant-wide last-slot concurrency',async()=>{
    const f=await running({maxConcurrentChildren:1}),h=envelope(f);
    const both=await Promise.all([coordinator.handoff(f.claim.selector,h),coordinator.handoff(f.claim.selector,h)]);expect(both.map(v=>v.kind).sort()).toEqual(['accepted','duplicate']);
    const before=await snapshot(f.actor.organizationId);await expect(coordinator.handoff(f.claim.selector,envelope(f))).rejects.toMatchObject({code:'DELEGATION_CONFLICT'});
    expect(await snapshot(f.actor.organizationId)).toEqual(before);expect((await api.read(f.actor,f.grant.id)).childrenCreated).toBe(1);
  });
  it('serializes two different creates racing for the last grant-wide slot',async()=>{
    const f=await running({maxConcurrentChildren:1});const outcomes=await Promise.allSettled([coordinator.handoff(f.claim.selector,envelope(f)),coordinator.handoff(f.claim.selector,envelope(f))]);
    expect(outcomes.filter(v=>v.status==='fulfilled')).toHaveLength(1);expect((await api.read(f.actor,f.grant.id)).childrenCreated).toBe(1);
  });
  it('rejects wrong service, generation, lease and handoff envelope identity',async()=>{
    const f=await child();await expect(coordinator.claim(f.childTarget)).rejects.toMatchObject({code:'FORBIDDEN'});
    await expect(worker.renew({...f.childClaim.selector,generation:2})).rejects.toMatchObject({code:'FORBIDDEN'});
    await expect(worker.renew({...f.childClaim.selector,leaseToken:randomUUID()})).rejects.toMatchObject({code:'FORBIDDEN'});
    await expect(coordinator.handoff(f.claim.selector,{...f.handoff,correlationId:id()})).rejects.toMatchObject({code:'DELEGATION_CONFLICT'});
  });
  it('retries stable logical task under a new generation without new child or deadline',async()=>{
    const f=await child();await admin.query("UPDATE pactwoven.native_delegation_tasks SET lease_until=clock_timestamp()-interval '1 millisecond' WHERE id=$1",[f.handoff.childTaskId]);
    const retry={...f.handoff,generation:2};expect((await coordinator.retry(f.claim.selector,retry)).kind).toBe('accepted');
    expect((await coordinator.retry(f.claim.selector,retry)).kind).toBe('duplicate');expect((await api.read(f.actor,f.grant.id)).childrenCreated).toBe(1);
    await expect(worker.renew(f.childClaim.selector)).rejects.toMatchObject({code:'FORBIDDEN'});await allow({...f.childTarget,generation:2});
    expect((await worker.claim({...f.childTarget,generation:2})).attempt).toBe(2);
    expect((await admin.query('SELECT deadline_at FROM pactwoven.native_delegation_tasks WHERE id=$1',[f.handoff.childTaskId])).rows[0].deadline_at.toISOString()).toBe(f.handoff.deadlineAt);
  });
  it('persists exact result, original inputs and body hashes once with duplicate recovery',async()=>{
    const f=await child(),p=await publication(f);const result=await worker.result(f.childClaim.selector,p);expect(result).toMatchObject({kind:'accepted',domainCompletion:false,publicationDigest:await commandDigest(p)});
    const before=await snapshot(f.actor.organizationId);expect((await worker.result(f.childClaim.selector,p)).kind).toBe('duplicate');expect(await snapshot(f.actor.organizationId)).toEqual(before);
    expect((await api.read(f.actor,f.grant.id)).activeChildren).toBe(0);await expect(worker.result(f.childClaim.selector,{...p,result:{...p.result,resultId:id()}})).rejects.toMatchObject({code:'DELEGATION_CONFLICT'});
  });
  it('fails closed on memory use before0027, malformed body hash and omitted original input identity',async()=>{
    const f=await child(),p=await publication(f),before=await snapshot(f.actor.organizationId);
    await expect(worker.result(f.childClaim.selector,{...p,memoryUsage:[{usageId:randomUUID(),selectionDigest:'a'.repeat(64)}]})).rejects.toMatchObject({code:withMemory?'EVIDENCE_STALE':'FORBIDDEN'});
    await expect(worker.result(f.childClaim.selector,{...p,artifacts:[{...p.artifacts[0]!,body:{text:'changed'}}]})).rejects.toMatchObject({code:'VALIDATION_FAILED'});
    expect(await snapshot(f.actor.organizationId)).toEqual(before);
  });
  it('rechecks proof expiry after a grant lock wait without partial admission',async()=>{
    const f=await running();await admin.query("UPDATE pactwoven.native_delegation_proofs SET valid_until=clock_timestamp()+interval '200 milliseconds' WHERE task_id=$1",[f.target.taskId]);
    const before=await snapshot(f.actor.organizationId),lock=await admin.connect();await lock.query('BEGIN');await lock.query('SELECT 1 FROM pactwoven.native_delegation_grants WHERE id=$1 FOR UPDATE',[f.grant.id]);
    const pending=coordinator.handoff(f.claim.selector,envelope(f));const caught=pending.catch(e=>e);await lock.query("SELECT pg_sleep(0.3)");await lock.query('COMMIT');lock.release();
    expect(await caught).toMatchObject({code:'FORBIDDEN'});expect(await snapshot(f.actor.organizationId)).toEqual(before);
  });
  it('keeps result/artifact/evidence immutable and dispatcher ACK fenced',async()=>{
    const f=await child(),p=await publication(f);await worker.result(f.childClaim.selector,p);
    await expect(admin.query('UPDATE pactwoven.native_delegation_results SET result_id=$1 WHERE handoff_id=$2',[id(),f.handoff.handoffId])).rejects.toMatchObject({code:'FA007'});
    const batch=await dispatcher.claim(20);expect(batch.length).toBeGreaterThan(0);const item=batch[0]!;
    expect(await dispatcher.acknowledge(item.target,randomUUID())).toBe(false);expect(await dispatcher.acknowledge(item.target,item.token)).toBe(true);expect(await dispatcher.acknowledge(item.target,item.token)).toBe(false);
  });
  it('settles simultaneous exact result submissions once after a shared grant-lock wait',async()=>{
    const f=await child(),p=await publication(f);const results=await Promise.all([worker.result(f.childClaim.selector,p),worker.result(f.childClaim.selector,p)]);
    expect(results.map(v=>v.kind).sort()).toEqual(['accepted','duplicate']);expect((await api.read(f.actor,f.grant.id)).activeChildren).toBe(0);
  });
  it('accepts an explicit failed advisory result without manufacturing artifacts',async()=>{
    const f=await child(),p=await publication(f);p.result={...p.result,outcome:'failed',artifacts:[],evidenceValidUntil:null};p.artifacts=[];
    expect((await worker.result(f.childClaim.selector,p)).kind).toBe('accepted');expect((await snapshot(f.actor.organizationId)).artifacts).toBeNull();
  });
  it('fences a late provider allow after explicit revocation',async()=>{
    const f=await fixture(),prepared=await api.prepare(f.target,issuer);if(prepared.kind!=='prepared')throw new Error('Missing prepare');
    await api.revoke(f.actor,{grantId:f.grant.id,expectedVersion:1,expectedRevocationEpoch:0,requestKey:id()});
    expect(await api.finish(prepared.nonce,{state:'allowed',reason:'current',observationStartedAt:at(),observationCompletedAt:at()})).toEqual({state:'stale'});
  });
  it('denies a rotated service identity and preserves durable task state',async()=>{
    const f=await child(),before=await snapshot(f.actor.organizationId);
    await admin.query("UPDATE pactwoven.native_delegation_services SET identity=jsonb_set(identity,'{serviceVersion}','2') WHERE service_id=$1",[workerId.serviceId]);
    try{await expect(worker.renew(f.childClaim.selector)).rejects.toMatchObject({code:'FORBIDDEN'});expect(await snapshot(f.actor.organizationId)).toEqual(before);}
    finally{await admin.query('UPDATE pactwoven.native_delegation_services SET identity=$1::jsonb WHERE service_id=$2',[JSON.stringify(workerId),workerId.serviceId]);}
  });
  it('fails closed when an ancestor is paused while the child remains assigned',async()=>{
    const f=await child();await admin.query("UPDATE pactwoven.native_delegation_tasks SET state='paused',lease_token=NULL,lease_until=NULL WHERE id=$1",[f.target.taskId]);
    await expect(worker.renew(f.childClaim.selector)).rejects.toMatchObject({code:'FORBIDDEN'});
  });
  it('checks bounded attempts and retained child input/deadline identity on retry',async()=>{
    const f=await child();await admin.query("UPDATE pactwoven.native_delegation_tasks SET lease_until=clock_timestamp()-interval '1 millisecond',attempt=4 WHERE id=$1",[f.handoff.childTaskId]);
    const before=await snapshot(f.actor.organizationId);await expect(coordinator.retry(f.claim.selector,{...f.handoff,generation:2})).rejects.toMatchObject({code:'DELEGATION_CONFLICT'});
    expect(await snapshot(f.actor.organizationId)).toEqual(before);
  });
  it('does not admit children after an explicit grant revoke even under a queued lock',async()=>{
    const f=await running(),lock=await admin.connect();await lock.query('BEGIN');await lock.query('SELECT 1 FROM pactwoven.native_delegation_grants WHERE id=$1 FOR UPDATE',[f.grant.id]);
    const revoke=api.revoke(f.actor,{grantId:f.grant.id,expectedVersion:1,expectedRevocationEpoch:0,requestKey:id()});
    await lock.query('SELECT pg_sleep(0.03)');const pending=coordinator.handoff(f.claim.selector,envelope(f)).catch(e=>e);
    await lock.query('SELECT pg_sleep(0.03)');await lock.query('COMMIT');lock.release();await revoke;
    expect(await pending).toMatchObject({code:'FORBIDDEN'});expect((await api.read(f.actor,f.grant.id)).childrenCreated).toBe(0);
  });
  it('preserves invalid raw SQL records as rejected data, including extra fields and consent mismatch',async()=>{
    const f=await fixture();
    await expect(apiPool.query('SELECT pactwoven.native_delegation_issue($1::jsonb,$2,$3::jsonb,$4::jsonb)',[JSON.stringify(f.actor),f.legacy,JSON.stringify({...f.grant,extra:true}),JSON.stringify(f.issuance)])).rejects.toMatchObject({code:'ND004'});
    await expect(workerPool.query('SELECT pactwoven.native_delegation_claim($1,$2::jsonb,15000)',['development',JSON.stringify({...f.target,grantId:f.grant.id})])).rejects.toMatchObject({code:'ND004'});
  });

  it('joins real delegated task memory reads to exact result publication and rejects correction/omission',async()=>{
    if(!withMemory){await admin.query(readFileSync(new URL('../migrations/0027_native_memory.sql',import.meta.url),'utf8'));withMemory=true;}
    await assertNativeDelegationPool(apiPool,'development','api','delegation-memory');await assertNativeDelegationPool(workerPool,'development','worker','delegation-memory');
    const memoryApi=new PostgresNativeMemoryRepository(apiPool,'development'),memoryWorker=new PostgresNativeMemoryTaskRepository(workerPool,'development');
    for(const correct of [false,true]) {
      const f=await child(),scope={environment:'development' as const,organizationId:f.actor.organizationId,siteId:f.siteId};
      const access={readers:[{kind:'user' as const,id:f.actor.actorId},{kind:'agent' as const,id:workerId.serviceId}],purposes:['human_review' as const,'task_context' as const]};
      const record={schemaVersion:1 as const,...scope,sourceId:id(),revision:1,kind:'user_statement' as const,status:'active' as const,contentDigest:'a'.repeat(64),
        provenance:{kind:'user' as const,actorId:f.actor.actorId},observedAt:at(-1000),validFrom:at(-1000),validUntil:at(600000),access,conflict:'clear' as const,verification:'unverified' as const};
      const source=await memoryApi.source(f.actor,id(),{kind:'create',expected:null,record});if(source.kind!=='source')throw new Error('Expected source');
      const memory=await memoryApi.mutate(f.actor,id(),{kind:'create',expected:null,record:{schemaVersion:1,...scope,memoryId:id(),revision:1,previous:null,
        subject:{kind:'preference',id:'supplies'},key:'color',recordedAt:at(-1000),provenance:{kind:'user',actorId:f.actor.actorId},state:'active',
        content:{title:'Supply preference',summary:'Blue supplies',attributes:{color:'blue'}},access,validFrom:at(-1000),validUntil:at(600000),confidence:'high',conflict:'clear',inputs:{sources:[source.originalReference],memories:[]}}});
      if(memory.kind!=='memory')throw new Error('Expected memory');
      const selected=await memoryWorker.read({...f.childClaim.selector,handoffId:f.handoff.handoffId},memory.originalReference);expect(selected.memory.content.summary).toBe('Blue supplies');
      expect(Date.parse(selected.validUntil)).toBeLessThanOrEqual(Date.parse(f.childClaim.validUntil));
      const p=await publication(f),before=await snapshot(f.actor.organizationId);
      await expect(worker.result(f.childClaim.selector,p)).rejects.toMatchObject({code:'EVIDENCE_STALE'});expect(await snapshot(f.actor.organizationId)).toEqual(before);
      p.memoryUsage=[{usageId:selected.usageId,selectionDigest:selected.receipt.digest}];
      if(correct){
        await memoryApi.source(f.actor,id(),{kind:'correct',expected:source.originalReference,record:{...record,revision:2,contentDigest:'b'.repeat(64)}});
        await expect(worker.result(f.childClaim.selector,p)).rejects.toMatchObject({code:'EVIDENCE_STALE'});expect(await snapshot(f.actor.organizationId)).toEqual(before);
      }else{
        const result=await worker.result(f.childClaim.selector,p);expect(result.publicationDigest).toBe(await commandDigest(p));
        const usage=(await admin.query('SELECT publication_digest FROM pactwoven.native_memory_usages WHERE id=$1',[selected.usageId])).rows[0];expect(usage.publication_digest).toBe(result.publicationDigest);
        const artifact=(await admin.query('SELECT memory_derived,publication_digest FROM pactwoven.native_delegation_artifacts WHERE task_id=$1',[f.handoff.childTaskId])).rows[0];expect(artifact).toEqual({memory_derived:true,publication_digest:result.publicationDigest});
        expect((await worker.result(f.childClaim.selector,p)).kind).toBe('duplicate');
        await expect(coordinator.handoff(f.claim.selector,envelope(f,{inputArtifacts:p.result.artifacts}))).rejects.toMatchObject({code:'FORBIDDEN'});
      }
    }
  });

  it('holds provider enrollment through the accepted result transaction',async()=>{
    const f=await child(),p=await publication(f),held=await workerPool.connect(),writer=await admin.connect();
    try{
      await held.query('BEGIN');const result=await held.query('SELECT pactwoven.native_delegation_result_commit($1,$2::jsonb,$3::jsonb) response',['development',f.childClaim.selector,p]);
      expect(result.rows[0].response.kind).toBe('accepted');
      await writer.query('BEGIN');await writer.query("SET LOCAL lock_timeout='100ms'");
      await expect(writer.query("UPDATE pactwoven.native_provider_instances SET enabled=false WHERE environment='development'")).rejects.toMatchObject({code:'55P03'});
      await writer.query('ROLLBACK');await held.query('COMMIT');
      expect((await worker.result(f.childClaim.selector,p)).kind).toBe('duplicate');
    }finally{await held.query('ROLLBACK');await writer.query('ROLLBACK');held.release();writer.release();}
  });
  it.each([64,65,128])('publishes all %i valid task usages and never creates unpublishable read debt',async count=>{
    if(!withMemory){await admin.query(readFileSync(new URL('../migrations/0027_native_memory.sql',import.meta.url),'utf8'));withMemory=true;}
    const f=await child(),scope={environment:'development' as const,organizationId:f.actor.organizationId,siteId:f.siteId};
    const memoryApi=new PostgresNativeMemoryRepository(apiPool,'development'),memoryWorker=new PostgresNativeMemoryTaskRepository(workerPool,'development');
    const access={readers:[{kind:'user' as const,id:f.actor.actorId},{kind:'agent' as const,id:workerId.serviceId}],purposes:['human_review' as const,'task_context' as const]};
    const source=await memoryApi.source(f.actor,id(),{kind:'create',expected:null,record:{schemaVersion:1,...scope,sourceId:id(),revision:1,kind:'user_statement',status:'active',
      contentDigest:'a'.repeat(64),provenance:{kind:'user',actorId:f.actor.actorId},observedAt:at(-1000),validFrom:at(-1000),validUntil:at(600000),access,conflict:'clear',verification:'unverified'}});
    if(source.kind!=='source')throw new Error('Expected source');
    const memory=await memoryApi.mutate(f.actor,id(),{kind:'create',expected:null,record:{schemaVersion:1,...scope,memoryId:id(),revision:1,previous:null,subject:{kind:'preference',id:'supplies'},key:'color',
      recordedAt:at(-1000),provenance:{kind:'user',actorId:f.actor.actorId},state:'active',content:{title:'Supplies',summary:'Blue supplies',attributes:{}},access,validFrom:at(-1000),validUntil:at(600000),confidence:'high',conflict:'clear',inputs:{sources:[source.originalReference],memories:[]}}});
    if(memory.kind!=='memory')throw new Error('Expected memory');
    const p=await publication(f),selector={...f.childClaim.selector,handoffId:f.handoff.handoffId};
    for(let n=0;n<count;n++){const selected=await memoryWorker.read(selector,memory.originalReference);p.memoryUsage.push({usageId:selected.usageId,selectionDigest:selected.receipt.digest});}
    if(count===128){
      await expect(memoryWorker.read(selector,memory.originalReference)).rejects.toMatchObject({code:'MEMORY_LIMIT'});
      expect((await admin.query("SELECT count(*)::integer n FROM pactwoven.native_memory_usages WHERE context#>>'{usage,taskId}'=$1",[f.handoff.childTaskId])).rows[0].n).toBe(128);
      await expect(worker.result(f.childClaim.selector,{...p,memoryUsage:p.memoryUsage.slice(1)})).rejects.toMatchObject({code:'EVIDENCE_STALE'});
    }
    expect((await worker.result(f.childClaim.selector,p)).kind).toBe('accepted');
    expect((await admin.query("SELECT count(*)::integer n FROM pactwoven.native_memory_usages WHERE context#>>'{usage,taskId}'=$1 AND publication_digest=$2",[f.handoff.childTaskId,await commandDigest(p)])).rows[0].n).toBe(count);
  });

  it('bounds artifact evidence by memory data expiry independently from short authority proofs',async()=>{
    const f=await child(),scope={environment:'development' as const,organizationId:f.actor.organizationId,siteId:f.siteId},sourceExpiry=at(5000);
    const memoryApi=new PostgresNativeMemoryRepository(apiPool,'development'),memoryWorker=new PostgresNativeMemoryTaskRepository(workerPool,'development');
    const access={readers:[{kind:'user' as const,id:f.actor.actorId},{kind:'agent' as const,id:workerId.serviceId}],purposes:['human_review' as const,'task_context' as const]};
    const source=await memoryApi.source(f.actor,id(),{kind:'create',expected:null,record:{schemaVersion:1,...scope,sourceId:id(),revision:1,kind:'user_statement',status:'active',contentDigest:'a'.repeat(64),
      provenance:{kind:'user',actorId:f.actor.actorId},observedAt:at(-1000),validFrom:at(-1000),validUntil:sourceExpiry,access,conflict:'clear',verification:'unverified'}});
    if(source.kind!=='source')throw new Error('Expected source');
    const memory=await memoryApi.mutate(f.actor,id(),{kind:'create',expected:null,record:{schemaVersion:1,...scope,memoryId:id(),revision:1,previous:null,subject:{kind:'preference',id:'supplies'},key:'color',recordedAt:at(-1000),
      provenance:{kind:'user',actorId:f.actor.actorId},state:'active',content:{title:'Supplies',summary:'Blue supplies',attributes:{}},access,validFrom:at(-1000),validUntil:at(600000),confidence:'high',conflict:'clear',inputs:{sources:[source.originalReference],memories:[]}}});
    if(memory.kind!=='memory')throw new Error('Expected memory');
    const selected=await memoryWorker.read({...f.childClaim.selector,handoffId:f.handoff.handoffId},memory.originalReference);
    expect(selected.receipt.selection.validUntil).toBe(sourceExpiry);const p=await publication(f);p.memoryUsage=[{usageId:selected.usageId,selectionDigest:selected.receipt.digest}];
    const before=await snapshot(f.actor.organizationId);await expect(worker.result(f.childClaim.selector,p)).rejects.toMatchObject({code:'FORBIDDEN'});
    expect(await snapshot(f.actor.organizationId)).toEqual(before);expect((await admin.query('SELECT publication_digest FROM pactwoven.native_memory_usages WHERE id=$1',[selected.usageId])).rows[0].publication_digest).toBeNull();
    p.result.evidenceValidUntil=sourceExpiry;expect((await worker.result(f.childClaim.selector,p)).kind).toBe('accepted');
  });

});
