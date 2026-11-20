import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { financialPolicyOriginalClosureReceiptHash, type FinancialPolicyCommand } from '@pactwoven/contracts';
import { assertFinancialAuthorityConnection, assertFinancialPolicyClosureConnection } from './financial-authority-pool.js';
import { PostgresFinancialPolicyClosureRepository } from './financial-policy-closure-repository.js';
import { closureFixtureConfig, closureFixtureEnabled, financialPolicyClosureFixture, type FinancialPolicyClosureFixture } from './financial-policy-closure.test-support.js';

const capture=async<T>(p:Promise<T>)=>{try{return {value:await p};}catch(error){return {error};}};
const errorCode=(v:unknown)=>typeof v==='object'&&v!==null&&'code' in v?v.code:undefined;
const queryClose=(c:PoolClient,p:any)=>c.query('SELECT pactwoven.financial_policy_close_original($1,$2::jsonb,$3::jsonb) AS response',[p.evidence.id,JSON.stringify(p.scope),JSON.stringify(p.intent)]);
const queryOriginal=(c:PoolClient,p:any)=>c.query('SELECT pactwoven.financial_policy_command($1,$2::jsonb) AS response',[p.evidence.id,JSON.stringify(p.command)]);
it.each(['localhost','example.test'])('rejects nonliteral fixture host %s',host=>{
 const url=new URL(`postgresql://${host}:55443/pactwoven_financial_policy_closure_test`);
 url.username='financial_policy_closure_fixture_admin';url.password=randomUUID();
 expect(()=>closureFixtureConfig(url.href)).toThrow();
});

describe.skipIf(!closureFixtureEnabled)('financial original request closure on a fresh managed PostgreSQL owner',()=>{
 let f:FinancialPolicyClosureFixture;
 beforeAll(async()=>{f=await financialPolicyClosureFixture();},60000);
 afterAll(async()=>{await f?.close();});
 async function counts(org:string) {return (await f.admin.query(`SELECT
  (SELECT count(*)::int FROM pactwoven.financial_policy_request_fences WHERE organization_id=$1) AS fences,
  (SELECT count(*)::int FROM pactwoven.financial_policy_operations WHERE organization_id=$1) AS operations,
  (SELECT count(*)::int FROM pactwoven.financial_policy_records WHERE organization_id=$1) AS records,
  (SELECT count(*)::int FROM pactwoven.financial_policy_audit a JOIN pactwoven.financial_policy_operations o ON o.id=a.operation_id WHERE o.organization_id=$1) AS audits,
  (SELECT count(*)::int FROM pactwoven.financial_policy_outbox a JOIN pactwoven.financial_policy_operations o ON o.id=a.operation_id WHERE o.organization_id=$1) AS outbox`,[org])).rows[0];}
 async function blocked(pid:number) {
  const deadline=Date.now()+2500;
  while(Date.now()<deadline){if((await f.admin.query("SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1",[pid])).rows[0]?.waiting)return;
   await new Promise(r=>setTimeout(r,10));}
  throw Error('Expected genuine PostgreSQL lock wait was not observed.');
 }
 async function authorityCheck(requireClosure=false) {const c=await f.authorizer.pool.connect();try{await c.query('BEGIN ISOLATION LEVEL READ COMMITTED');
  const r=await capture(requireClosure?assertFinancialPolicyClosureConnection(c):assertFinancialAuthorityConnection(c,'authorizer'));await c.query('ROLLBACK');return r;
 }finally{c.release();}}
 it('supports complete historical 14 and 17 profiles but requires complete 19 for closure',()=>{
  expect(f.historical).toEqual([{migration:14,base:true,closure:false},{migration:17,base:true,closure:false},{migration:19,base:true,closure:true}]);
 });
 it('returns a missing observation without creating a fence or a policy record',async()=>{
  const c=await f.createCase(),p=await c.prepare();expect(await f.closures.status(p.evidence.id,p.scope,p.locator)).toEqual({status:'not_recorded',original:null,closure:null});
  expect(await counts(c.organizationId)).toEqual({fences:0,operations:0,records:0,audits:0,outbox:0});
 });
 it.each([null,'responsibility_a'])('creates one self-auditing closure in %s scope without financial mutations',async rid=>{
  const c=await f.createCase(),p=await c.prepare(c.document(undefined,rid));
  const baseline=async()=> (await f.admin.query(`SELECT authority_epoch,(SELECT jsonb_agg(to_jsonb(a) ORDER BY a.responsibility_id) FROM pactwoven.financial_authority_fences a WHERE a.organization_id=$1) AS authority,
   (SELECT count(*)::int FROM pactwoven.financial_budget_accounts WHERE organization_id=$1) AS budget_accounts,
   (SELECT count(*)::int FROM pactwoven.financial_governance_controls WHERE organization_id=$1) AS governance
   FROM pactwoven.organizations WHERE environment='development' AND id=$1`,[c.organizationId])).rows[0];
  const before=await baseline(),result=await f.closures.close(p.evidence.id,p.scope,p.intent);
  expect(result.status).toBe('closed');if(result.status!=='closed')throw Error();
  expect(result.closure.recordHash).toBe(await financialPolicyOriginalClosureReceiptHash(result.closure));
  expect(result.closure).toMatchObject({locator:p.locator,effectiveAuthority:false,financialState:null,expected:{actor:{actorId:'owner_a'},organizationEpoch:2}});
  expect(JSON.stringify(result)).not.toMatch(/tokenHash|issuer|sessionId|identityEvidence|authorizer_oid/);
  expect(await f.closures.status(p.evidence.id,p.scope,p.locator)).toEqual(result);
  expect(await f.closures.close(p.evidence.id,p.scope,p.intent)).toEqual(result);
  expect(await counts(c.organizationId)).toEqual({fences:1,operations:0,records:0,audits:0,outbox:0});
  expect(await baseline()).toEqual(before);
 });
 it.each([null,'responsibility_a'])('closes and exactly recovers an unsorted multi-role membership in %s scope',async rid=>{
  const c=await f.createCase();
  await f.admin.query("UPDATE pactwoven.memberships SET roles=ARRAY['owner','finance'],row_version=row_version+1 WHERE environment='development' AND organization_id=$1 AND actor_id='owner_a'",[c.organizationId]);
  const p=await c.prepare(c.document(undefined,rid));expect(p.scope.roles).toEqual(['finance','owner']);
  const closed=await f.closures.close(p.evidence.id,p.scope,p.intent);expect(closed.status).toBe('closed');
  expect((await f.admin.query("SELECT scope->'roles' AS scope_roles,context->'roles' AS retained_roles FROM pactwoven.financial_policy_request_fences WHERE organization_id=$1",[c.organizationId])).rows)
   .toEqual([{scope_roles:['finance','owner'],retained_roles:['owner','finance']}]);
  const next=await c.identity();expect(next.scope.roles).toEqual(['finance','owner']);
  expect(await f.closures.status(next.evidence.id,next.scope,p.locator)).toEqual(closed);
  expect(await f.closures.close(next.evidence.id,next.scope,p.intent)).toEqual(closed);
  expect(await counts(c.organizationId)).toEqual({fences:1,operations:0,records:0,audits:0,outbox:0});
 });
 it('an existing reciprocal original wins and is never shadowed by a closure',async()=>{
  const c=await f.createCase(),p=await c.prepare(),original=await f.repository.mutate(p.evidence.id,p.command);
  const expected={status:'recorded',original:{command:p.command,result:original},closure:null};
  expect(await f.closures.close(p.evidence.id,p.scope,p.intent)).toEqual(expected);expect(await f.closures.status(p.evidence.id,p.scope,p.locator)).toEqual(expected);
  expect(await counts(c.organizationId)).toEqual({fences:0,operations:1,records:1,audits:1,outbox:1});
 });
 it.each(['target','responsibility','hash'] as const)('a broad-key recorded %s mismatch conflicts and never establishes absence',async changed=>{
  const c=await f.createCase(),p=await c.prepare();await f.repository.mutate(p.evidence.id,p.command);
  const q=structuredClone(p.locator);if(changed==='target')q.targetId='other_target';if(changed==='responsibility')q.responsibilityId=null;if(changed==='hash')q.publicRequestHash='b'.repeat(64);
  const intent={...p.intent,locator:q,expected:changed==='responsibility'?{organizationEpoch:2,draftScope:null}:p.intent.expected};
  await expect(f.closures.status(p.evidence.id,p.scope,q)).rejects.toMatchObject({code:'FINANCIAL_POLICY_KEY_CONFLICT'});
  await expect(f.closures.close(p.evidence.id,p.scope,intent)).rejects.toMatchObject({code:'FINANCIAL_POLICY_KEY_CONFLICT'});
  expect((await counts(c.organizationId)).fences).toBe(0);
 });
 it.each(['target','hash'] as const)('a closed key cannot be replaced with changed %s',async changed=>{
  const c=await f.createCase(),p=await c.prepare();await f.closures.close(p.evidence.id,p.scope,p.intent);
  const q={...p.locator,...(changed==='target'?{targetId:'different_target'}:{publicRequestHash:'b'.repeat(64)})};
  await expect(f.closures.close(p.evidence.id,p.scope,{...p.intent,locator:q})).rejects.toMatchObject({code:'FINANCIAL_POLICY_KEY_CONFLICT'});
  const command={...p.command,...(changed==='target'?{id:'different_target'}:{text:'Changed original payload'})};
  await expect(f.repository.mutate(p.evidence.id,command)).rejects.toMatchObject({code:'FINANCIAL_POLICY_KEY_CONFLICT'});
  expect(await counts(c.organizationId)).toEqual({fences:1,operations:0,records:0,audits:0,outbox:0});
 });
 it('a new separately reviewed key can use the same target after closure',async()=>{
  const c=await f.createCase(),p=await c.prepare();await f.closures.close(p.evidence.id,p.scope,p.intent);
  const next={...p.command,key:`fresh_${crypto.randomUUID()}`};expect((await f.repository.mutate(p.evidence.id,next)).body.id).toBe(p.command.id);
  expect((await counts(c.organizationId))).toMatchObject({fences:1,operations:1,records:1});
 });
 it('fences an incomplete draft with the same exact namespace and current responsibility pins',async()=>{
  const c=await f.createCase(),document=await c.prepare(),saved=await f.repository.mutate(document.evidence.id,document.command);
  const command:FinancialPolicyCommand={...c.document('draft_original'),kind:'save_draft',responsibilityId:c.rid,
   draft:{scope:document.intent.expected.draftScope!,terms:{mode:'PREPARE_FOR_APPROVAL',actions:['allocate_funds'],category:'supplier_principal',allocation:'responsibility_earmark',
    supplier:null,acceptedTerms:null,payee:null,tool:null,withdrawal:null,branch:null,communication:{recipients:[],purposes:[],kinds:[],allowanceBaseUnits:'0'}},
    documents:[{...saved.target,purpose:'financial_mandate'}],asset:null,account:null,governance:null,trust:null,startsAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString()}};
  // Remove document-only fields rather than let a fixture bypass exact schemas.
  delete (command as unknown as Record<string,unknown>).purpose;delete (command as unknown as Record<string,unknown>).text;
  const p=await c.prepare(command,'operations_a');expect((await f.closures.close(p.evidence.id,p.scope,p.intent)).status).toBe('closed');
  await expect(f.repository.mutate(p.evidence.id,command)).rejects.toMatchObject({code:'FINANCIAL_POLICY_KEY_CONFLICT'});
  expect((await counts(c.organizationId))).toMatchObject({fences:1,operations:1,records:1});
 });
 it('the insertion fence catches direct late operation inserts without relying on the command body',async()=>{
  const c=await f.createCase(),p=await c.prepare();await f.closures.close(p.evidence.id,p.scope,p.intent);
  await expect(f.admin.query(`INSERT INTO pactwoven.financial_policy_operations(id,environment,organization_id,actor_id,responsibility_id,kind,key,command_hash,command,result)
   VALUES($1,'development',$2,'owner_a',$3,'save_document',$4,$5,$6::jsonb,'{}')`,[crypto.randomUUID(),c.organizationId,c.rid,p.command.key,'a'.repeat(64),JSON.stringify(p.command)]))
   .rejects.toMatchObject({code:'FP005'});
  expect((await counts(c.organizationId)).operations).toBe(0);
 });
 it('the symmetric insertion guard rejects a direct fence inserted against a committed original',async()=>{
  const c=await f.createCase(),p=await c.prepare();await f.repository.mutate(p.evidence.id,p.command);
  await expect(f.admin.query(`INSERT INTO pactwoven.financial_policy_request_fences(id,environment,organization_id,actor_id,kind,key,locator,intent,scope,context,identity_evidence_id,identity_evidence_hash,authorizer_oid,authorizer_name,authorizer_version,closed_at,body)
   VALUES($1,'development',$2,'owner_a','save_document',$3,'{}','{}','{}','{}',$4,'invalid',10,'invalid',1,clock_timestamp(),'{}')`,[crypto.randomUUID(),c.organizationId,p.command.key,p.evidence.id]))
   .rejects.toMatchObject({code:'FP005'});expect((await counts(c.organizationId)).fences).toBe(0);
 });
 it.each(['close','original'] as const)('serializes real competing transactions when %s owns the organization lock first',async first=>{
  const c=await f.createCase(),p=await c.prepare(),a=await f.authorizer.pool.connect(),b=await f.authorizer.pool.connect();
  try{await a.query('BEGIN');await b.query('BEGIN');const pid=(await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
   const won=await(first==='close'?queryClose(a,p):queryOriginal(a,p));
   const pending=capture(first==='close'?queryOriginal(b,p):queryClose(b,p));await blocked(pid);await a.query('COMMIT');const second=await pending;
   if(first==='close'){expect(errorCode('error' in second?second.error:null)).toBe('FP005');await b.query('ROLLBACK');}
   else{expect('value' in second&&second.value?.rows[0].response.status).toBe('recorded');await b.query('COMMIT');expect(won.rows[0].response.id).toBe('value' in second?second.value?.rows[0].response.original.result.id:null);}
   expect((await f.closures.status(p.evidence.id,p.scope,p.locator)).status).toBe(first==='close'?'closed':'recorded');
  }finally{await a.query('ROLLBACK');await b.query('ROLLBACK');a.release();b.release();}
 });
 it.each(['close','original'] as const)('allows the competing outcome after the first %s rolls back',async first=>{
  const c=await f.createCase(),p=await c.prepare(),a=await f.authorizer.pool.connect(),b=await f.authorizer.pool.connect();
  try{await a.query('BEGIN');await b.query('BEGIN');const pid=(await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
   await(first==='close'?queryClose(a,p):queryOriginal(a,p));const pending=capture(first==='close'?queryOriginal(b,p):queryClose(b,p));await blocked(pid);await a.query('ROLLBACK');
   const result=await pending;expect(result).not.toHaveProperty('error');await b.query('COMMIT');
   expect((await f.closures.status(p.evidence.id,p.scope,p.locator)).status).toBe(first==='close'?'recorded':'closed');
  }finally{await a.query('ROLLBACK');await b.query('ROLLBACK');a.release();b.release();}
 });
 it('concurrent closures return the same single immutable receipt',async()=>{
  const c=await f.createCase(),p=await c.prepare(),a=await f.authorizer.pool.connect(),b=await f.authorizer.pool.connect();
  try{await a.query('BEGIN');await b.query('BEGIN');const pid=(await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
   const first=(await queryClose(a,p)).rows[0].response,pending=queryClose(b,p);await blocked(pid);await a.query('COMMIT');const second=(await pending).rows[0].response;await b.query('COMMIT');
   expect(second).toEqual(first);expect((await counts(c.organizationId)).fences).toBe(1);
  }finally{await a.query('ROLLBACK');await b.query('ROLLBACK');a.release();b.release();}
 });
 it.each(['membership','site','session','epoch','authorizer','verifier'] as const)('rejects current identity or pins changed by %s while genuinely waiting',async changed=>{
  const c=await f.createCase(),p=await c.prepare(),lock=await f.admin.connect(),writer=await f.authorizer.pool.connect();
  try{await lock.query('BEGIN');await lock.query("SELECT id FROM pactwoven.organizations WHERE environment='development' AND id=$1 FOR UPDATE",[c.organizationId]);
   const pid=(await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,pending=capture(queryClose(writer,p));await blocked(pid);
   if(changed==='membership')await lock.query("UPDATE pactwoven.memberships SET status='revoked',row_version=row_version+1 WHERE environment='development' AND organization_id=$1 AND actor_id='owner_a'",[c.organizationId]);
   if(changed==='site')await lock.query("DELETE FROM pactwoven.member_action_sites WHERE environment='development' AND organization_id=$1 AND actor_id='owner_a'",[c.organizationId]);
   if(changed==='epoch')await lock.query("UPDATE pactwoven.organizations SET authority_epoch=authority_epoch+1 WHERE environment='development' AND id=$1",[c.organizationId]);
   if(changed==='session')await lock.query("INSERT INTO pactwoven.session_revocations(environment,session_id) VALUES('development',$1)",[p.scope.actor.sessionId]);
   if(changed==='authorizer'||changed==='verifier')await lock.query(`INSERT INTO pactwoven.financial_policy_principals
    SELECT principal_oid,principal_name,environment,organization_id,capability,version+1,false,expires_at FROM pactwoven.financial_policy_principals
    WHERE environment='development' AND organization_id=$1 AND capability=$2 ORDER BY version DESC LIMIT 1`,[c.organizationId,changed]);
   await lock.query('COMMIT');const result=await pending;expect(['FP001','FP002']).toContain(errorCode('error' in result?result.error:null));expect((await counts(c.organizationId)).fences).toBe(0);
  }finally{await lock.query('ROLLBACK');lock.release();writer.release();}
 });
 it('lost COMMIT acknowledgement retains the exact closure for explicit status recovery',async()=>{
  const c=await f.createCase(),p=await c.prepare();let commits=0,discards=0;
  const pool={connect:async()=>{const client=await f.authorizer.pool.connect();return {query:async(...args:any[])=>{
   const r=await(client.query as any)(...args);if(args[0]==='COMMIT'){commits++;throw Error('Synthetic transport loss after real database COMMIT');}return r;},
   release:(discard?:boolean)=>{if(discard)discards++;client.release(discard);}} as unknown as PoolClient;}} as Pool;
  await expect(new PostgresFinancialPolicyClosureRepository(pool).close(p.evidence.id,p.scope,p.intent)).rejects.toMatchObject({code:'FINANCIAL_POLICY_OUTCOME_UNKNOWN'});
  expect(commits).toBe(1);expect(discards).toBe(1);expect((await f.closures.status(p.evidence.id,p.scope,p.locator)).status).toBe('closed');
  expect(await counts(c.organizationId)).toEqual({fences:1,operations:0,records:0,audits:0,outbox:0});
 });
 it('rejects identity expiry occurring during a real organization-lock wait',async()=>{
  const c=await f.createCase(),p=await c.prepare(),now=Date.now(),short={...p.evidence,id:crypto.randomUUID(),observedAt:new Date(now).toISOString(),expiresAt:new Date(now+1200).toISOString()};
  await f.authentication.append(short);p.evidence=short;
  const lock=await f.admin.connect(),writer=await f.authorizer.pool.connect();
  try{await lock.query('BEGIN');await lock.query("SELECT id FROM pactwoven.organizations WHERE environment='development' AND id=$1 FOR UPDATE",[c.organizationId]);
   const pid=(await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,pending=capture(queryClose(writer,p));await blocked(pid);
   await new Promise(r=>setTimeout(r,1400));await lock.query('COMMIT');const result=await pending;
   expect(errorCode('error' in result?result.error:null)).toBe('FP001');expect((await counts(c.organizationId)).fences).toBe(0);
  }finally{await lock.query('ROLLBACK');lock.release();writer.release();}
 });
 it('rejects REPEATABLE READ rather than run mutual exclusion under a stale snapshot',async()=>{
  const c=await f.createCase(),p=await c.prepare(),client=await f.authorizer.pool.connect();
  try{await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');const result=await capture(queryClose(client,p));
   expect(errorCode('error' in result?result.error:null)).toBe('FA001');await client.query('ROLLBACK');expect((await counts(c.organizationId)).fences).toBe(0);
  }finally{await client.query('ROLLBACK');client.release();}
 });
 it('recovers the original immutable closure after membership, epoch and responsibility basis advance',async()=>{
  const c=await f.createCase(),p=await c.prepare(),closed=await f.closures.close(p.evidence.id,p.scope,p.intent);
  await f.admin.query("UPDATE pactwoven.memberships SET row_version=row_version+1 WHERE environment='development' AND organization_id=$1 AND actor_id='owner_a'",[c.organizationId]);
  await f.admin.query("UPDATE pactwoven.organizations SET authority_epoch=authority_epoch+1 WHERE environment='development' AND id=$1",[c.organizationId]);
  await f.admin.query("UPDATE pactwoven.responsibilities SET row_version=row_version+1,title='Revised synthetic responsibility' WHERE environment='development' AND organization_id=$1 AND id=$2",[c.organizationId,c.rid]);
  const next=await c.identity();expect(next.scope.actor.membershipVersion).toBeGreaterThan(p.scope.actor.membershipVersion);expect(next.scope.organizationEpoch).toBeGreaterThan(p.scope.organizationEpoch);
  expect(await f.closures.status(next.evidence.id,next.scope,p.locator)).toEqual(closed);
  expect(await f.closures.close(next.evidence.id,next.scope,p.intent)).toEqual(closed);
 });
 it.each(['hash','evidence','context','body'] as const)('rejects corrupted stored closure %s using rollback-only corruption',async changed=>{
  const c=await f.createCase(),p=await c.prepare(),closed=await f.closures.close(p.evidence.id,p.scope,p.intent),other=await c.identity('owner_b'),client=await f.admin.connect();
  try{await client.query('BEGIN');await client.query('ALTER TABLE pactwoven.financial_policy_request_fences DISABLE TRIGGER financial_policy_no_mutation');
   const expression=changed==='hash'?"identity_evidence_hash=repeat('b',64)":changed==='evidence'?"identity_evidence_id=$2::uuid":changed==='context'?"context=jsonb_set(context,'{organizationEpoch}','999')":"body=jsonb_set(body,'{expected,organizationEpoch}','999')";
   await client.query('SET CONSTRAINTS ALL DEFERRED');
   await client.query(`UPDATE pactwoven.financial_policy_request_fences SET ${expression} WHERE organization_id=$1`,changed==='evidence'?[c.organizationId,other.evidence.id]:[c.organizationId]);
   const result=await capture(client.query('SELECT pactwoven.financial_policy_closure_audit(f) FROM pactwoven.financial_policy_request_fences f WHERE organization_id=$1',[c.organizationId]));
   expect(errorCode('error' in result?result.error:null)).toBe('FP008');
  }finally{await client.query('ROLLBACK');client.release();}
  expect(await f.closures.status(p.evidence.id,p.scope,p.locator)).toEqual(closed);
 });
 it.each([{label:'role set',roles:['owner','operations']},{label:'role multiplicity',roles:['owner','finance','owner']}])('rejects changed retained $label using rollback-only corruption',async({roles})=>{
  const c=await f.createCase();
  await f.admin.query("UPDATE pactwoven.memberships SET roles=ARRAY['owner','finance'],row_version=row_version+1 WHERE environment='development' AND organization_id=$1 AND actor_id='owner_a'",[c.organizationId]);
  const p=await c.prepare(),closed=await f.closures.close(p.evidence.id,p.scope,p.intent),client=await f.admin.connect();
  try{await client.query('BEGIN');await client.query('ALTER TABLE pactwoven.financial_policy_request_fences DISABLE TRIGGER financial_policy_no_mutation');
   await client.query("UPDATE pactwoven.financial_policy_request_fences SET context=jsonb_set(context,'{roles}',$2::jsonb) WHERE organization_id=$1",[c.organizationId,JSON.stringify(roles)]);
   const result=await capture(client.query('SELECT pactwoven.financial_policy_closure_audit(f) FROM pactwoven.financial_policy_request_fences f WHERE organization_id=$1',[c.organizationId]));
   expect(errorCode('error' in result?result.error:null)).toBe('FP008');
  }finally{await client.query('ROLLBACK');client.release();}
  expect(await f.closures.status(p.evidence.id,p.scope,p.locator)).toEqual(closed);
  expect(await f.closures.close(p.evidence.id,p.scope,p.intent)).toEqual(closed);
 });
 it.each(['organizationEpoch','authorityHash','site'] as const)('rejects a changed fresh %s pin before establishing a fence',async changed=>{
  const c=await f.createCase(),p=await c.prepare(),intent=structuredClone(p.intent);
  if(changed==='organizationEpoch')intent.expected.organizationEpoch++;else if(changed==='authorityHash')intent.expected.draftScope!.authorityHash='b'.repeat(64);else intent.expected.draftScope!.site.generation++;
  await expect(f.closures.close(p.evidence.id,p.scope,intent)).rejects.toMatchObject({code:'FINANCIAL_POLICY_SCOPE_CHANGED'});expect((await counts(c.organizationId)).fences).toBe(0);
 });
 it('only the authenticated original actor namespace is affected',async()=>{
  const c=await f.createCase(),p=await c.prepare();await f.closures.close(p.evidence.id,p.scope,p.intent);
  const other=await c.identity('owner_b');expect(await f.closures.status(other.evidence.id,other.scope,p.locator)).toMatchObject({status:'not_recorded'});
  expect((await f.repository.mutate(other.evidence.id,p.command)).actorId).toBe('owner_b');expect((await counts(c.organizationId))).toMatchObject({fences:1,operations:1});
 });
 it('an organization-scoped new fence requires owner authority',async()=>{
  const c=await f.createCase(),p=await c.prepare(c.document(undefined,null),'finance_a');
  await expect(f.closures.close(p.evidence.id,p.scope,p.intent)).rejects.toMatchObject({code:'FINANCIAL_POLICY_ACCESS_DENIED'});expect((await counts(c.organizationId)).fences).toBe(0);
 });
 it.each(['update','delete','truncate'] as const)('prevents privileged %s of immutable closure records',async action=>{
  const c=await f.createCase(),p=await c.prepare();await f.closures.close(p.evidence.id,p.scope,p.intent);
  const sql=action==='update'?"UPDATE pactwoven.financial_policy_request_fences SET key='changed_original_key' WHERE organization_id=$1":action==='delete'?"DELETE FROM pactwoven.financial_policy_request_fences WHERE organization_id=$1":"TRUNCATE pactwoven.financial_policy_request_fences";
  await expect(f.admin.query(sql,action==='truncate'?[]:[c.organizationId])).rejects.toMatchObject({code:'FP007'});
 });
 it('keeps verifier, stranger and authorizer table access outside the new capability',async()=>{
  const c=await f.createCase(),p=await c.prepare();
  for(const principal of [f.verifier,f.stranger])for(const fn of ['financial_policy_close_original','financial_policy_original_status'])
   await expect(principal.pool.query(`SELECT pactwoven.${fn}($1,$2::jsonb,$3::jsonb)`,[p.evidence.id,JSON.stringify(p.scope),JSON.stringify(fn.endsWith('status')?p.locator:p.intent)])).rejects.toMatchObject({code:'42501'});
  for(const principal of [f.verifier,f.stranger,f.authorizer])await expect(principal.pool.query('SELECT * FROM pactwoven.financial_policy_request_fences')).rejects.toMatchObject({code:'42501'});
  await expect(f.authorizer.pool.query("SELECT pactwoven.financial_policy_closure_hash('{}')")).rejects.toMatchObject({code:'42501'});
 });
 it('rejects any extra application helper privilege and restores baseline admission after revoke',async()=>{
  await f.admin.query('GRANT EXECUTE ON FUNCTION pactwoven.financial_policy_closure_hash(jsonb) TO pactwoven_financial_authorizer');
  try{expect(await authorityCheck()).toHaveProperty('error');}finally{await f.admin.query('REVOKE EXECUTE ON FUNCTION pactwoven.financial_policy_closure_hash(jsonb) FROM pactwoven_financial_authorizer');}
  expect(await authorityCheck(true)).not.toHaveProperty('error');
 });
 it('fails closed on either missing entrypoint, including ordinary policy admission',async()=>{
  for(const fn of ['financial_policy_close_original','financial_policy_original_status']){
   const name=`pactwoven.${fn}(uuid,jsonb,jsonb)`,definition=(await f.admin.query('SELECT pg_get_functiondef($1::regprocedure) AS source',[name])).rows[0].source;
   await f.owner.query(`DROP FUNCTION ${name}`);
   try{expect(await authorityCheck()).toHaveProperty('error');expect(await authorityCheck(true)).toHaveProperty('error');}
   finally{await f.owner.query(definition);await f.owner.query(`REVOKE ALL ON FUNCTION ${name} FROM PUBLIC`);await f.owner.query(`GRANT EXECUTE ON FUNCTION ${name} TO pactwoven_financial_authorizer`);}
  }
 });
 it('fails closed when the extension table loses RLS or its expected owner',async()=>{
  await f.owner.query('ALTER TABLE pactwoven.financial_policy_request_fences DISABLE ROW LEVEL SECURITY');
  try{expect(await authorityCheck()).toHaveProperty('error');}finally{await f.owner.query('ALTER TABLE pactwoven.financial_policy_request_fences ENABLE ROW LEVEL SECURITY');}
  await f.admin.query('ALTER TABLE pactwoven.financial_policy_request_fences OWNER TO CURRENT_USER');
  try{expect(await authorityCheck()).toHaveProperty('error');}finally{await f.admin.query('ALTER TABLE pactwoven.financial_policy_request_fences OWNER TO pactwoven_closure_fixture_owner');}
  expect(await authorityCheck(true)).not.toHaveProperty('error');
 });
 // Last: this intentionally leaves only this fresh disposable fixture with an incomplete extension.
 it('fails closed when only the extension table is absent',async()=>{
  await f.owner.query('DROP TABLE pactwoven.financial_policy_request_fences CASCADE');
  expect(await authorityCheck()).toHaveProperty('error');expect(await authorityCheck(true)).toHaveProperty('error');
 });
});
