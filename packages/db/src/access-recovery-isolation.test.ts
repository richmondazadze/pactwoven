import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterAll,beforeAll,beforeEach,describe,expect,it } from 'vitest';
import { assertAccessRecoveryIsolation,assertAccessRecoveryReady } from './access-recovery-isolation.js';
import { assertRuntimePool } from './repository.js';
import { assertProvisionerPool } from './provisioner.js';
import { assertAccessPool,type AccessMutation } from './access-repository.js';
import { assertMandatePool } from './mandate-pool.js';
import { fixture,closeProof,intentFor,rawClose,rawChange,accessProof,grant,identity,snapshot,type RecoveryFixture } from './access-recovery.test-support.js';

const suite=process.env.PACTWOVEN_RUN_ACCESS_RECOVERY_DB_TESTS==='1'?describe:describe.skip;
const table='pactwoven.member_access_key_fences', closeSignature='pactwoven.close_access_recovery(text,jsonb,jsonb,text,jsonb,text)';
const snapshotLevels=['REPEATABLE READ','SERIALIZABLE'] as const;
const extractMutation=(source:string)=>{
 const start=source.indexOf('CREATE OR REPLACE FUNCTION pactwoven.change_member_access');
 return source.slice(start,source.indexOf('\nREVOKE ALL ON FUNCTION',start)).trim();
};
suite('RECOVERY-01B capability isolation and permanent storage',()=>{
 let f:RecoveryFixture;
 beforeAll(async()=>{f=await fixture();});beforeEach(async()=>f.reset());afterAll(async()=>f?.close());
 const pool=(role:'runtime'|'bootstrap'|'access'|'mandate')=>f[role];
 const guard=(role:'runtime'|'bootstrap'|'access'|'mandate')=>role==='runtime'?assertRuntimePool:role==='bootstrap'?assertProvisionerPool:role==='access'?assertAccessPool:assertMandatePool;
 const login=(role:string)=>`pactwoven_recovery_b1_test_${role}`;
 it('accepts the four isolated roles and only marks function-only access ready',async()=>{
  for(const role of ['runtime','bootstrap','access','mandate'] as const)await expect(guard(role)(pool(role))).resolves.toBeUndefined();
  await expect(assertAccessRecoveryReady(f.access)).resolves.toBeUndefined();
  for(const role of ['runtime','bootstrap','mandate'] as const)await expect(assertAccessRecoveryReady(pool(role))).rejects.toBeDefined();
  await expect(assertAccessRecoveryReady(f.admin)).rejects.toMatchObject({code:'UNSAFE_DATABASE_ROLE'});
 });
 it('keeps legacy guards usable before 0006 while recovery readiness fails closed',async()=>{
  await f.admin.query('DROP SCHEMA pactwoven CASCADE');
  for(const file of ['0001_foundation.sql','0002_organization_bootstrap.sql','0003_identity_access.sql','0004_mandate_authority.sql','0005_access_acceptance.sql'])await f.admin.query(await readFile(new URL(`../migrations/${file}`,import.meta.url),'utf8'));
  try {
   await assertRuntimePool(f.runtime);await assertProvisionerPool(f.bootstrap);await assertAccessPool(f.access);
   await expect(assertAccessRecoveryReady(f.access)).rejects.toMatchObject({code:'SETUP_REQUIRED'});
  } finally {await f.admin.query(await readFile(new URL('../migrations/0006_access_recovery_fences.sql',import.meta.url),'utf8'));}
 });
 it('preserves a caller-owned transaction when existing guards receive a connected client',async()=>{
  const client=await f.access.connect(),key='guard_transaction_0001',intent=intentFor();
  try {
   await client.query('BEGIN');await rawClose(client,await closeProof(key,intent),key,intent);
   const before=(await client.query('SELECT txid_current()::text AS id')).rows[0].id;
   await assertAccessPool(client as unknown as Pool);await assertAccessRecoveryReady(client as unknown as Pool);
   expect((await client.query('SELECT txid_current()::text AS id')).rows[0].id).toBe(before);
   await client.query('ROLLBACK');expect((await f.admin.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n).toBe(0);
  } finally {await client.query('ROLLBACK');client.release();}
 });
 it.each(snapshotLevels)('refuses a caller-owned %s snapshot without altering its transaction or settings',async isolation=>{
  const client=await f.access.connect();
  try {
   await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
   const before=(await client.query("SELECT txid_current()::text AS id,pg_current_snapshot()::text AS snapshot,current_setting('transaction_isolation') AS actual,current_setting('default_transaction_isolation') AS configured")).rows[0];
   expect(before).toMatchObject({actual:isolation.toLowerCase(),configured:'read committed'});
   await expect(assertAccessPool(client as unknown as Pool)).rejects.toMatchObject({code:'SETUP_REQUIRED'});
   await expect(assertAccessRecoveryReady(client as unknown as Pool)).rejects.toMatchObject({code:'SETUP_REQUIRED'});
   expect((await client.query("SELECT txid_current()::text AS id,pg_current_snapshot()::text AS snapshot,current_setting('transaction_isolation') AS actual,current_setting('default_transaction_isolation') AS configured")).rows[0]).toEqual(before);
  } finally {await client.query('ROLLBACK');client.release();}
 });
 it.each(snapshotLevels)('refuses configured %s defaults even when the current transaction overrides them',async isolation=>{
  const file=process.env.PACTWOVEN_RECOVERY_TEST_ACCESS_URL_FILE!;
  const configured=new Pool({connectionString:(await readFile(file,'utf8')).trim(),max:1,options:`-c default_transaction_isolation=${isolation.toLowerCase().replaceAll(' ','\\ ')}`});
  try {
   expect((await configured.query("SELECT current_setting('transaction_isolation') AS actual,current_setting('default_transaction_isolation') AS configured")).rows[0]).toEqual({actual:isolation.toLowerCase(),configured:isolation.toLowerCase()});
   await expect(assertAccessPool(configured)).rejects.toMatchObject({code:'SETUP_REQUIRED'});
   await expect(assertAccessRecoveryReady(configured)).rejects.toMatchObject({code:'SETUP_REQUIRED'});
   await configured.query('BEGIN ISOLATION LEVEL READ COMMITTED');
   await expect(assertAccessPool(configured)).rejects.toMatchObject({code:'SETUP_REQUIRED'});
   await expect(assertAccessRecoveryReady(configured)).rejects.toMatchObject({code:'SETUP_REQUIRED'});
   expect((await configured.query("SELECT current_setting('transaction_isolation') AS actual,current_setting('default_transaction_isolation') AS configured")).rows[0]).toEqual({actual:'read committed',configured:isolation.toLowerCase()});
  } finally {await configured.query('ROLLBACK');await configured.end();}
 });
 it('preserves schema-optional legacy access under unsupported isolation before 0006 exists',async()=>{
  await f.admin.query('DROP SCHEMA pactwoven CASCADE');
  for(const file of ['0001_foundation.sql','0002_organization_bootstrap.sql','0003_identity_access.sql','0004_mandate_authority.sql','0005_access_acceptance.sql'])await f.admin.query(await readFile(new URL(`../migrations/${file}`,import.meta.url),'utf8'));
  const client=await f.access.connect();
  try {
   await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
   await expect(assertAccessPool(client as unknown as Pool)).resolves.toBeUndefined();
   await expect(assertAccessRecoveryReady(client as unknown as Pool)).rejects.toMatchObject({code:'SETUP_REQUIRED'});
  } finally {await client.query('ROLLBACK');client.release();await f.admin.query(await readFile(new URL('../migrations/0006_access_recovery_fences.sql',import.meta.url),'utf8'));}
 });
 it.each(['READ COMMITTED',...snapshotLevels].flatMap(isolation=>['current','restored-0005'].flatMap(body=>['grant','revise','revoke'].map(kind=>({isolation,body,kind:kind as AccessMutation['kind']})))))
 ('prevents $body $kind from crossing a later fence under $isolation',async({isolation,body,kind})=>{
  const current=extractMutation(await readFile(new URL('../migrations/0006_access_recovery_fences.sql',import.meta.url),'utf8'));
  let mutation=grant(),epoch=0;
  if(kind!=='grant'){
   const target=await rawChange(f.access,accessProof(),'snapshot_setup_key_001',grant());epoch=1;
   mutation=kind==='revise'?{kind,actorId:target.aggregateId,target:grant().target!,command:{expectedVersion:1,mandateVersion:null,authorityEpoch:epoch,payload:{roles:['auditor'],siteIds:['site_a'],actionSiteIds:[],expiresAt:null}}}
    :{kind,actorId:target.aggregateId,target:null,command:{expectedVersion:1,mandateVersion:null,authorityEpoch:epoch,payload:{reason:'Snapshot regression'}}};
  }
  if(body==='restored-0005')await f.admin.query(extractMutation(await readFile(new URL('../migrations/0005_access_acceptance.sql',import.meta.url),'utf8')));
  const stale=await f.access.connect(),key='snapshot_original_key_001';
  try {
   await stale.query(`BEGIN ISOLATION LEVEL ${isolation}`);await stale.query('SELECT pg_current_snapshot()');
   const owner=identity('owner_b'),intent=intentFor(kind,owner,epoch);
   expect((await rawClose(f.access,await closeProof(key,intent,owner),key,intent)).disposition).toBe('fenced');
   const before=await snapshot(f.admin);
   await expect(rawChange(stale,accessProof(),key,mutation)).rejects.toMatchObject({code:isolation==='READ COMMITTED'?'PA006':'PA007'});
   // COMMIT after the refused statement must roll back the caller's aborted transaction.
   expect((await stale.query('COMMIT')).command).toBe('ROLLBACK');
   expect(await snapshot(f.admin)).toEqual(before);
   expect((await f.admin.query(`SELECT (SELECT count(*)::int FROM ${table} WHERE idempotency_key=$1) AS fences,(SELECT count(*)::int FROM pactwoven.operations WHERE idempotency_key=$1) AS operations`,[key])).rows[0]).toEqual({fences:1,operations:0});
  } finally {await stale.query('ROLLBACK');stale.release();if(body==='restored-0005')await f.admin.query(current);}
 });
 it.each(snapshotLevels.flatMap(isolation=>['read','close'].flatMap(action=>['not_recorded','fenced','recorded'].map(disposition=>({isolation,action,disposition})))))
 ('refuses stale owner $action of $disposition under $isolation',async({isolation,action,disposition})=>{
  const key='snapshot_owner_key_001',intent=intentFor();
  if(disposition==='fenced')await rawClose(f.access,await closeProof(key,intent),key,intent);
  if(disposition==='recorded')await rawChange(f.access,accessProof(),key,grant());
  const stale=await f.access.connect();
  try {
   await stale.query(`BEGIN ISOLATION LEVEL ${isolation}`);await stale.query('SELECT pg_current_snapshot()');
   await f.admin.query("INSERT INTO pactwoven.session_revocations(environment,session_id) VALUES('development','session_owner_a')");
   const before=await snapshot(f.admin),fences=(await f.admin.query(`SELECT * FROM ${table}`)).rows;
   const attempt=action==='read'?stale.query("SELECT pactwoven.read_access_recovery('development',$1::jsonb,'grant',$2)",[JSON.stringify(identity()),key]):rawClose(stale,await closeProof(key,intent),key,intent);
   await expect(attempt).rejects.toMatchObject({code:'PA007'});
   expect((await stale.query('COMMIT')).command).toBe('ROLLBACK');
   expect(await snapshot(f.admin)).toEqual(before);expect((await f.admin.query(`SELECT * FROM ${table}`)).rows).toEqual(fences);
  } finally {await stale.query('ROLLBACK');stale.release();}
 });
 it.each(snapshotLevels)('guards fence insertion against an operation committed after a %s snapshot',async isolation=>{
  const seed='snapshot_fence_seed_001',key='snapshot_fence_insert_001',intent=intentFor();
  await rawClose(f.access,await closeProof(seed,intent),seed,intent);
  const stale=await f.admin.connect();
  try {
   await stale.query(`BEGIN ISOLATION LEVEL ${isolation}`);await stale.query('SELECT pg_current_snapshot()');
   await rawChange(f.access,accessProof(),key,grant());const before=await snapshot(f.admin);
   await expect(stale.query(`INSERT INTO ${table} SELECT environment,organization_id,kind,$1,'snapshot_copied_fence',closed_at,schema_version,reason,closed_by,external_membership_id,session_id,authority_epoch,identity,close_intent,close_intent_hash,request_hash,evidence FROM ${table} WHERE idempotency_key=$2`,[key,seed])).rejects.toMatchObject({code:'PA007'});
   expect((await stale.query('COMMIT')).command).toBe('ROLLBACK');expect(await snapshot(f.admin)).toEqual(before);
   expect((await f.admin.query(`SELECT count(*)::int AS n FROM ${table} WHERE idempotency_key=$1`,[key])).rows[0].n).toBe(0);
  } finally {await stale.query('ROLLBACK');stale.release();}
 });
 it.each(['runtime','bootstrap','access','mandate'] as const)('denies %s raw read/write/truncate and helper execution',async role=>{
  for(const sql of [`SELECT * FROM ${table}`,`INSERT INTO ${table}(environment) VALUES('development')`,`UPDATE ${table} SET reason='original_input_unavailable'`,`DELETE FROM ${table}`,`TRUNCATE ${table}`,"SELECT pactwoven.access_recovery_hash('{}')"])
   await expect(pool(role).query(sql)).rejects.toMatchObject({code:'42501'});
 });
 it.each(['runtime','bootstrap','mandate'] as const)('rejects direct recovery RPC capability on %s',async role=>{
  await f.admin.query(`GRANT EXECUTE ON FUNCTION ${closeSignature} TO ${login(role)}`);
  try{await expect(guard(role)(pool(role))).rejects.toMatchObject({code:'UNSAFE_DATABASE_ROLE'});}
  finally{await f.admin.query(`REVOKE EXECUTE ON FUNCTION ${closeSignature} FROM ${login(role)}`);}
 });
 it.each(['SELECT','INSERT','UPDATE','REFERENCES'] as const)('rejects column-only %s access to fence data',async privilege=>{
  await f.admin.query(`GRANT ${privilege}(reason) ON ${table} TO ${login('access')}`);
  try{await expect(assertAccessPool(f.access)).rejects.toMatchObject({code:'UNSAFE_DATABASE_ROLE'});}
  finally{await f.admin.query(`REVOKE ${privilege}(reason) ON ${table} FROM ${login('access')}`);}
 });
 it.each(['helper','overload'] as const)('rejects leaked %s execution without accepting its familiar name',async variant=>{
  const signature=variant==='helper'?'pactwoven.access_recovery_hash(jsonb)':'pactwoven.close_access_recovery(text)';
  if(variant==='overload')await f.admin.query('CREATE FUNCTION pactwoven.close_access_recovery(text) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$');
  await f.admin.query(`GRANT EXECUTE ON FUNCTION ${signature} TO ${login('access')}`);
  try{await expect(assertAccessPool(f.access)).rejects.toMatchObject({code:'UNSAFE_DATABASE_ROLE'});}
  finally{if(variant==='overload')await f.admin.query(`DROP FUNCTION ${signature}`);else await f.admin.query(`REVOKE EXECUTE ON FUNCTION ${signature} FROM ${login('access')}`);}
 });
 it.each(['noinherit','no-set-or-inherit'] as const)('detects reachable capability through a %s role edge',async mode=>{
  const indirect='pactwoven_recovery_b1_indirect';await f.admin.query(`CREATE ROLE ${indirect} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
  try {
   await f.admin.query(`GRANT EXECUTE ON FUNCTION ${closeSignature} TO ${indirect}`);
   await f.admin.query(`GRANT ${indirect} TO ${login('runtime')} WITH INHERIT FALSE, SET ${mode==='no-set-or-inherit'?'FALSE':'TRUE'}`);
   await expect(assertRuntimePool(f.runtime)).rejects.toMatchObject({code:'UNSAFE_DATABASE_ROLE'});
  } finally {await f.admin.query(`REVOKE ${indirect} FROM ${login('runtime')}`);await f.admin.query(`REVOKE EXECUTE ON FUNCTION ${closeSignature} FROM ${indirect}`);await f.admin.query(`DROP ROLE ${indirect}`);}
 });
 it.each(['access_recovery_immutable_row','access_recovery_immutable_table','access_recovery_fence_insert','access_recovery_operation_insert'] as const)('requires enabled %s for closure readiness',async trigger=>{
  const relation=trigger==='access_recovery_operation_insert'?'pactwoven.operations':table;await f.admin.query(`ALTER TABLE ${relation} DISABLE TRIGGER ${trigger}`);
  try{await expect(assertAccessRecoveryReady(f.access)).rejects.toMatchObject({code:'SETUP_REQUIRED'});}
  finally{await f.admin.query(`ALTER TABLE ${relation} ENABLE TRIGGER ${trigger}`);}
 });
 it('requires RLS and exact function privileges for readiness',async()=>{
  await f.admin.query(`ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY`);
  try{await expect(assertAccessRecoveryReady(f.access)).rejects.toMatchObject({code:'SETUP_REQUIRED'});}
  finally{await f.admin.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);}
 });
 it('ignores hostile search_path definitions and restores the caller setting',async()=>{
  await f.admin.query('CREATE SCHEMA recovery_b1_spoof');await f.admin.query(`GRANT USAGE ON SCHEMA recovery_b1_spoof TO ${login('access')}`);
  await f.admin.query('CREATE FUNCTION recovery_b1_spoof.eq(text,text) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$');
  await f.admin.query('CREATE OPERATOR recovery_b1_spoof.= (LEFTARG=text,RIGHTARG=text,FUNCTION=recovery_b1_spoof.eq)');
  const file=process.env.PACTWOVEN_RECOVERY_TEST_ACCESS_URL_FILE!, hostile=new Pool({connectionString:(await readFile(file,'utf8')).trim(),max:1,options:'-c search_path=recovery_b1_spoof,pg_catalog'});
  try {
   expect((await hostile.query("SELECT 'a'::text='b'::text AS spoofed")).rows[0].spoofed).toBe(true);await assertAccessRecoveryReady(hostile);
   await f.admin.query(`GRANT SELECT(reason) ON ${table} TO ${login('access')}`);await expect(assertAccessRecoveryIsolation(hostile,'access')).rejects.toMatchObject({code:'UNSAFE_DATABASE_ROLE'});
   expect((await hostile.query("SELECT 'a'::text='b'::text AS spoofed")).rows[0].spoofed).toBe(true);
  } finally{await hostile.end();await f.admin.query(`REVOKE SELECT(reason) ON ${table} FROM ${login('access')}`);await f.admin.query('DROP SCHEMA recovery_b1_spoof CASCADE');}
 });
 it('keeps committed fences immutable and prevents organization/closer deletion cascades',async()=>{
  const key='immutable_recovery_0001',intent=intentFor();await rawClose(f.access,await closeProof(key,intent),key,intent);
  for(const sql of [`UPDATE ${table} SET request_hash=repeat('b',64)`,`DELETE FROM ${table}`,`TRUNCATE ${table}`])await expect(f.admin.query(sql)).rejects.toMatchObject({code:'PA007'});
  await expect(f.admin.query("DELETE FROM pactwoven.memberships WHERE actor_id='owner_a'")).rejects.toMatchObject({code:'23503'});
  await expect(f.admin.query("DELETE FROM pactwoven.organizations WHERE id='org_a'")).rejects.toMatchObject({code:'23503'});
  expect((await f.admin.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n).toBe(1);
 });
 it('rejects opposing inserts at the shared storage boundary without changing unrelated operations',async()=>{
  const key='opposite_recovery_0001',intent=intentFor();await rawClose(f.access,await closeProof(key,intent),key,intent);
  await expect(f.admin.query("INSERT INTO pactwoven.operations(environment,organization_id,id,actor_id,kind,idempotency_key,command_hash,aggregate_id,response) VALUES('development','org_a','op_1','owner_a','member.grant',$1,repeat('a',64),'owner_b','{}')",[key])).rejects.toMatchObject({code:'PA006'});
  await f.admin.query("INSERT INTO pactwoven.operations(environment,organization_id,id,actor_id,kind,idempotency_key,command_hash,aggregate_id,response) VALUES('development','org_a','op_2','owner_a','responsibility.create',$1,repeat('a',64),'responsibility_a','{}')",[key]);
  const operation=await rawChange(f.access,accessProof(),'recorded_recovery_0001',grant());expect(operation.status).toBe('succeeded');
  await expect(f.admin.query(`INSERT INTO ${table} SELECT environment,organization_id,kind,'recorded_recovery_0001','copied_fence',closed_at,schema_version,reason,closed_by,external_membership_id,session_id,authority_epoch,identity,close_intent,close_intent_hash,request_hash,evidence FROM ${table} WHERE idempotency_key=$1`,[key])).rejects.toMatchObject({code:'PA007'});
 });
});
