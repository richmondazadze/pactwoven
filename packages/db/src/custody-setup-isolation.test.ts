import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {custodyFixture,custodyFixtureEnabled,custodyWaitForBlock,type CustodyFixture} from './custody-setup.test-support.js';
import {custodySpecificationHash} from '@pactwoven/domain';
import type {CustodyCommand} from '@pactwoven/contracts';
describe.skipIf(!custodyFixtureEnabled)('custody actual-PG isolation and races',()=>{let f:CustodyFixture;beforeEach(async()=>{f=await custodyFixture();},60000);afterEach(async()=>{await f?.close();});
 it('denies direct table/helper access, verifier-to-writer crossover and self-binding',async()=>{for(const table of ['custody_setup_principals','custody_setup_evidence','custody_setup_operations','custody_setup_specifications'])await expect(f.writer.pool.query(`SELECT * FROM pactwoven.${table}`)).rejects.toMatchObject({code:'42501'});
  await expect(f.writer.pool.query("SELECT pactwoven.custody_principal('org_a','writer')")).rejects.toMatchObject({code:'42501'});
  await expect(f.writer.pool.query("INSERT INTO pactwoven.custody_setup_principals SELECT oid,rolname,'org_a','development','writer',1,true,now()+interval '1 day' FROM pg_roles WHERE rolname=SESSION_USER")).rejects.toMatchObject({code:'42501'});
  await expect(f.verifier.pool.query('SELECT pactwoven.custody_setup_read($1,$2,$3)',[crypto.randomUUID(),'responsibility_a',crypto.randomUUID()])).rejects.toMatchObject({code:'42501'});
 });
 it('rejects public/SET-only/GUC forgery and unbound sibling principals',async()=>{const sibling=await f.login('unbound','pactwoven_custody_setup_writer'),p=await f.prepare();
  const c=await sibling.pool.connect();try{await c.query("SELECT set_config('pactwoven.organization_id','org_a',false),set_config('pactwoven.actor_id','owner_a',false)");await expect(c.query('SELECT pactwoven.custody_setup_read($1,$2,$3)',[p.identity.id,'responsibility_a',p.result.setupId])).rejects.toMatchObject({code:'CS001'});}finally{c.release();}
  const stranger=await f.stranger.pool.connect();try{await f.admin.query(`GRANT pactwoven_custody_setup_writer TO "${f.stranger.role}" WITH INHERIT FALSE,SET TRUE`);await stranger.query('SET ROLE pactwoven_custody_setup_writer');await expect(stranger.query('SELECT pactwoven.custody_setup_read($1,$2,$3)',[p.identity.id,'responsibility_a',p.result.setupId])).rejects.toMatchObject({code:'CS001'});}finally{await stranger.query('RESET ROLE');stranger.release();}
 });
 it('rejects altered strict SQL fields before creating any operation',async()=>{const p=await f.prepare(),v={...p.command,key:'another_setup_key_001',verified:true};await expect(f.writer.pool.query('SELECT pactwoven.custody_setup_command($1,$2::jsonb)',[p.identity.id,JSON.stringify(v)])).rejects.toMatchObject({code:'CS004'});});
 it('requires a fresh exact predecessor and preserves deterministic identity on draft revisions',async()=>{const p=await f.prepare(),s={...f.specification,version:2,predecessor:{id:f.specification.id,version:1,recordHash:await custodySpecificationHash(f.specification)},transactionPolicy:{...f.specification.transactionPolicy,maximumFeeLamports:'9000'}};
  await f.saveSpecification(s);await expect(f.prepare('revision_without_predecessor',s)).rejects.toMatchObject({code:'CUSTODY_SCOPE_CHANGED'});await expect(f.prepare('revision_wrong_predecessor',s,{...p.result.target,id:crypto.randomUUID()})).rejects.toMatchObject({code:'CUSTODY_SCOPE_CHANGED'});
  const next=await f.prepare('revision_exact_predecessor',s,p.result.target);expect(next.result.setupId).toBe(p.result.setupId);expect(next.result.target.version).toBe(2);await expect(f.prepare('revision_stale_predecessor',s,p.result.target)).rejects.toMatchObject({code:'CUSTODY_SCOPE_CHANGED'});
 });
 it('rejects membership and authority changes after a real organization lock wait',async()=>{const p=await f.prepare(),i=await f.identity(),h=await f.admin.connect(),w=await f.writer.pool.connect();
  try{await h.query('BEGIN');await h.query("SELECT id FROM pactwoven.organizations WHERE id='org_a' FOR UPDATE");const hp=(await h.query('SELECT pg_backend_pid() pid')).rows[0].pid,wp=(await w.query('SELECT pg_backend_pid() pid')).rows[0].pid;
   const v:CustodyCommand={schemaVersion:1,kind:'challenge',key:'scope_wait_challenge_001',responsibilityId:'responsibility_a',setupId:p.result.setupId,expectedSetupVersion:p.result.target.version,expectedSetupHash:p.result.target.recordHash};
   const pending=w.query('SELECT pactwoven.custody_setup_command($1,$2::jsonb)',[i.id,JSON.stringify(v)]).then(()=>null,e=>e);await custodyWaitForBlock(f.admin,wp,hp);await h.query("UPDATE pactwoven.organizations SET authority_epoch=authority_epoch+1 WHERE id='org_a'");await h.query('COMMIT');expect(await pending).toMatchObject({code:'CS002'});
  }finally{await h.query('ROLLBACK');h.release();w.release();}
 });
 it('rechecks membership expiry after waiting on a global asset control',async()=>{const p=await f.prepare(),i=await f.identity(),h=await f.admin.connect(),w=await f.writer.pool.connect();await f.admin.query("UPDATE pactwoven.memberships SET expires_at=clock_timestamp()+interval '250 milliseconds' WHERE actor_id='owner_a'");
  try{await h.query('BEGIN');await h.query('SELECT * FROM pactwoven.finance_asset_controls FOR UPDATE');const hp=(await h.query('SELECT pg_backend_pid() pid')).rows[0].pid,wp=(await w.query('SELECT pg_backend_pid() pid')).rows[0].pid;
   const v={schemaVersion:1,kind:'challenge',key:'expiry_wait_challenge_001',responsibilityId:'responsibility_a',setupId:p.result.setupId,expectedSetupVersion:1,expectedSetupHash:p.result.target.recordHash};const pending=w.query('SELECT pactwoven.custody_setup_command($1,$2::jsonb)',[i.id,JSON.stringify(v)]).then(()=>null,e=>e);await custodyWaitForBlock(f.admin,wp,hp);await new Promise(r=>setTimeout(r,300));await h.query('COMMIT');expect(await pending).toMatchObject({code:'CS001'});
  }finally{await h.query('ROLLBACK');h.release();w.release();}
 });
 it('invalidates observations when their exact verifier binding is revoked',async()=>{const p=await f.prepare();await f.admin.query("INSERT INTO pactwoven.custody_setup_principals SELECT principal_oid,principal_name,organization_id,environment,capability,version+1,false,expires_at FROM pactwoven.custody_setup_principals WHERE capability='verifier'");await expect(f.repository.get(p.identity.id,'responsibility_a',p.result.setupId)).rejects.toMatchObject({code:'CUSTODY_ACCESS_DENIED'});});
 it.each(['custody_setup_audit','custody_setup_outbox'])('rejects missing intermediate %s even when a later cancellation is complete',async table=>{const p=await f.prepare(),i=await f.identity(),c=await f.admin.connect();
  try{await c.query('BEGIN');await c.query(`ALTER TABLE pactwoven.${table} DISABLE TRIGGER custody_no_mutation`);await c.query(`SET SESSION AUTHORIZATION "${f.writer.role}"`);const base={schemaVersion:1,responsibilityId:'responsibility_a',setupId:p.result.setupId,expectedSetupVersion:1,expectedSetupHash:p.result.target.recordHash};const first=(await c.query('SELECT pactwoven.custody_setup_command($1,$2::jsonb) response',[i.id,JSON.stringify({...base,kind:'challenge',key:'complete_challenge_key_001'})])).rows[0].response;
   await c.query('SELECT pactwoven.custody_setup_command($1,$2::jsonb)',[i.id,JSON.stringify({...base,kind:'cancel',key:'complete_cancel_key_001',expectedSetupControlGeneration:0})]);await c.query('RESET SESSION AUTHORIZATION');await c.query(`DELETE FROM pactwoven.${table} WHERE operation_id=$1`,[first.id]);await expect(c.query('SET CONSTRAINTS ALL IMMEDIATE')).rejects.toMatchObject({code:'CS007'});
  }finally{await c.query('ROLLBACK');await c.query('RESET SESSION AUTHORIZATION');c.release();}
 });
 it('preserves SQL/JS specification hashes and rejects altered PDA or nil UUID even for trusted inserts',async()=>{const s=f.specification;expect((await f.admin.query("SELECT pactwoven.custody_hash('specification',$1::jsonb) hash",[JSON.stringify(s)])).rows[0].hash).toBe(await custodySpecificationHash(s));
  for(const broken of [{...s,registrationAddress:s.vaultAddress},{...s,organization:{...s.organization,registrationUuid:'00000000-0000-0000-0000-000000000000'}},{...s,ownerWalletPublicKey:s.registrar},{...s,asset:{...s.asset,decimals:9}}])expect((await f.admin.query('SELECT pactwoven.custody_spec_valid($1::jsonb) valid',[JSON.stringify(broken)]).catch(()=>({rows:[{valid:false}]}))).rows[0].valid).toBe(false);
 });
 it.each([
  ["UPDATE pactwoven.memberships SET row_version=row_version+1 WHERE actor_id='owner_a'",'CS001'],
  ["INSERT INTO pactwoven.session_revocations VALUES('development','session_owner_a',now())",'CS001'],
  ["UPDATE pactwoven.sites SET name='Changed synthetic site' WHERE id='site_a'",'CS002'],
  ["DELETE FROM pactwoven.member_action_sites WHERE actor_id='owner_a'",'CS001'],
 ])('rechecks a concurrent scope change after a real wait: %s',async(change,code)=>{const p=await f.prepare(),i=await f.identity(),h=await f.admin.connect(),w=await f.writer.pool.connect();
  try{await h.query('BEGIN');await h.query("SELECT id FROM pactwoven.organizations WHERE id='org_a' FOR UPDATE");const hp=(await h.query('SELECT pg_backend_pid() pid')).rows[0].pid,wp=(await w.query('SELECT pg_backend_pid() pid')).rows[0].pid;
   const v={schemaVersion:1,kind:'challenge',key:'concurrent_scope_challenge',responsibilityId:'responsibility_a',setupId:p.result.setupId,expectedSetupVersion:1,expectedSetupHash:p.result.target.recordHash};const pending=w.query('SELECT pactwoven.custody_setup_command($1,$2::jsonb)',[i.id,JSON.stringify(v)]).then(()=>null,e=>e);await custodyWaitForBlock(f.admin,wp,hp);await h.query(change);await h.query('COMMIT');expect(await pending).toMatchObject({code});
  }finally{await h.query('ROLLBACK');h.release();w.release();}
 });
 it.each(['custody_setup_evidence_uses','custody_setup_controls'])('rejects an incomplete binding missing %s',async table=>{const flow=await f.proofFlow(),i=await f.identity(),c=await f.admin.connect();
  try{await c.query('BEGIN');await c.query(`ALTER TABLE pactwoven.${table} DISABLE TRIGGER custody_no_mutation`);await c.query(`SET SESSION AUTHORIZATION "${f.writer.role}"`);const result=(await c.query('SELECT pactwoven.custody_setup_command($1,$2::jsonb) response',[i.id,JSON.stringify(flow.command)])).rows[0].response;await c.query('RESET SESSION AUTHORIZATION');await c.query(`DELETE FROM pactwoven.${table} WHERE operation_id=$1`,[result.id]);await expect(c.query('SET CONSTRAINTS ALL IMMEDIATE')).rejects.toMatchObject({code:'CS007'});
  }finally{await c.query('ROLLBACK');await c.query('RESET SESSION AUTHORIZATION');c.release();}
 });
 it('blocks stale specification controls and retains original challenge identity',async()=>{const p=await f.prepare();await f.admin.query("INSERT INTO pactwoven.custody_setup_specification_controls VALUES('synthetic_specification',1,1,false)");const v:CustodyCommand={schemaVersion:1,kind:'challenge',key:'changed_spec_control_challenge',responsibilityId:'responsibility_a',setupId:p.result.setupId,expectedSetupVersion:1,expectedSetupHash:p.result.target.recordHash};await expect(f.repository.mutate((await f.identity()).id,v)).rejects.toMatchObject({code:'CUSTODY_SCOPE_CHANGED'});expect((await f.admin.query('SELECT count(*) FROM pactwoven.custody_setup_anchors')).rows[0].count).toBe('1');
 });
 it.each([
  ['challenge','asset'],['challenge','specification'],['confirm','asset'],['confirm','specification'],
 ] as const)('keeps setup control available while %s waits at the earlier %s tier',async(kind,tier)=>{
  const flow=kind==='confirm'?await f.proofFlow():null,p=flow?.p??await f.prepare(),i=await f.identity();
  const command:CustodyCommand=flow?.command??{schemaVersion:1,kind:'challenge',key:'ordered_challenge_key_001',responsibilityId:'responsibility_a',setupId:p.result.setupId,expectedSetupVersion:1,expectedSetupHash:p.result.target.recordHash};
  const holder=await f.admin.connect(),writer=await f.writer.pool.connect(),probe=await f.admin.connect();
  let pending:Promise<{rows:unknown[]}|{code?:string}>|undefined;
  try{
   await holder.query('BEGIN');
   if(tier==='asset')await holder.query('SELECT * FROM pactwoven.finance_asset_controls WHERE asset_key=$1 FOR UPDATE',[f.specification.asset.key]);
   else await holder.query('SELECT * FROM pactwoven.custody_setup_specification_controls WHERE specification_id=$1 ORDER BY generation DESC LIMIT 1 FOR UPDATE',[f.specification.id]);
   const holderPid=(await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid,writerPid=(await writer.query('SELECT pg_backend_pid() pid')).rows[0].pid;
   pending=writer.query('SELECT pactwoven.custody_setup_command($1,$2::jsonb) response',[i.id,JSON.stringify(command)]).then(r=>r,e=>e);
   await custodyWaitForBlock(f.admin,writerPid,holderPid);
   await probe.query('BEGIN');
   const available=await probe.query('SELECT * FROM pactwoven.custody_setup_controls WHERE setup_id=$1 ORDER BY generation DESC LIMIT 1 FOR UPDATE NOWAIT',[p.result.setupId]);
   expect(available.rows).toHaveLength(1);expect(available.rows[0].generation).toBe(0);
   await probe.query('ROLLBACK');await holder.query('COMMIT');
   expect(await pending).toMatchObject({rows:[{response:{kind,setupId:p.result.setupId}}]});
  }finally{await probe.query('ROLLBACK');await holder.query('ROLLBACK');if(pending)await pending;holder.release();writer.release();probe.release();}
 });
 it('cancels an invalidated specification without waiting for the asset tier',async()=>{
  const p=await f.prepare(),i=await f.identity();await f.admin.query("INSERT INTO pactwoven.custody_setup_specification_controls VALUES('synthetic_specification',1,1,false)");
  const holder=await f.admin.connect();
  try{await holder.query('BEGIN');await holder.query('SELECT * FROM pactwoven.finance_asset_controls WHERE asset_key=$1 FOR UPDATE',[f.specification.asset.key]);
   const result=await f.repository.mutate(i.id,{schemaVersion:1,kind:'cancel',key:'cancel_invalidated_spec_key',responsibilityId:'responsibility_a',setupId:p.result.setupId,expectedSetupVersion:1,expectedSetupHash:p.result.target.recordHash,expectedSetupControlGeneration:0});
   expect(result.body.kind).toBe('cancellation');expect(result.financialState).toBeNull();
   expect((await f.repository.get(i.id,'responsibility_a',p.result.setupId))?.state).toBe('cancelled');
  }finally{await holder.query('ROLLBACK');holder.release();}
 });

});
