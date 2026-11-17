import {readFile} from 'node:fs/promises';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {custodyPostgresVersions,custodySystemPrivilegePredicate} from './custody-setup-system-privileges.js';
import {assertCustodySetupConnection} from './custody-setup-pool.js';
import {custodyReadFixture,custodyReadFixtureEnabled,type CustodyReadFixture} from './custody-setup-read.test-support.js';

const rid='responsibility_a';
type Capability='writer'|'verifier';
const outcome=async(operation:()=>Promise<unknown>)=>{try{await operation();return 'accepted';}catch(error){return String((error as {code?:string}).code??'unknown');}};
const initialRestricted=`SELECT p.oid::regprocedure::text AS signature,p.proname,
  NOT has_function_privilege($1,p.oid,'EXECUTE') AS forbidden
 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
 JOIN pg_catalog.pg_init_privs i ON i.objoid=p.oid AND i.classoid='pg_catalog.pg_proc'::regclass AND i.objsubid=0 AND i.privtype='i'
 WHERE n.nspname='pg_catalog' AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(i.initprivs) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE')
 ORDER BY p.oid`;

it('keeps the SQL and connection predicates identical and preserves every original 0009 principal/evidence condition',async()=>{
 const [old,sql,current]=await Promise.all([readFile(new URL('../migrations/0009_custody_setup_owner_bindings.sql',import.meta.url),'utf8'),readFile(new URL('../migrations/0010_custody_setup_private_reads.sql',import.meta.url),'utf8'),readFile(new URL('../migrations/0017_managed_postgres_qualification.sql',import.meta.url),'utf8')]);
 const helper=sql.slice(sql.indexOf('CREATE FUNCTION pactwoven.custody_system_privileges_safe('),sql.indexOf('-- Preserve the published 0009 conditions'));
 expect(helper).toContain(`SELECT (${custodySystemPrivilegePredicate.replace(' IN(170011,170012)','=170011')}\n )`);
 expect(current).toContain(`SELECT (${custodySystemPrivilegePredicate}\n )`);
 expect(custodyPostgresVersions).toEqual([170011,170012]);
 for(const [name,next] of [['custody_principal','custody_evidence_current'],['custody_evidence_current','custody_context']]){
  const original=old.slice(old.indexOf(`CREATE FUNCTION pactwoven.${name}(`),old.indexOf(`CREATE FUNCTION pactwoven.${next}(`)).trim();
  const start=sql.indexOf(`CREATE OR REPLACE FUNCTION pactwoven.${name}(`),end=sql.indexOf('END $$;',start);
  const replacement=sql.slice(start,name==='custody_principal'?end+7:sql.indexOf('$$;',start)+3)
   .replace('CREATE OR REPLACE FUNCTION','CREATE FUNCTION')
   .replace(" IF NOT coalesce(pactwoven.custody_system_privileges_safe(r.oid),false) THEN RAISE EXCEPTION USING ERRCODE='CS001',MESSAGE='Restricted system authority is forbidden for custody';END IF;\n",'')
   .replace(' AND coalesce(pactwoven.custody_system_privileges_safe(r.oid),false)\n','');
  expect(replacement.trim()).toBe(original);
 }
});

describe.skipIf(!custodyReadFixtureEnabled)('custody restricted PostgreSQL authority closure',()=>{
 let f:CustodyReadFixture;
 beforeEach(async()=>{f=await custodyReadFixture();},60000);
 afterEach(async()=>{await f?.close();});
 const deny=async(capability:Capability,p:Awaited<ReturnType<CustodyReadFixture['prepare']>>)=>{
  const principal=f[capability],client=await principal.pool.connect();
  try{
   const sql=capability==='writer'
    ?await outcome(()=>client.query('SELECT pactwoven.custody_setup_original_read($1,$2,$3,$4)',[p.identity.id,rid,'prepare',p.command.key]))
    :await outcome(()=>client.query('SELECT pactwoven.custody_setup_resolve_owner($1::jsonb,$2)',[JSON.stringify(f.observation()),rid]));
   expect(sql).toBe('CS001');
   expect(await outcome(()=>assertCustodySetupConnection(client,capability))).toBe('UNSAFE_DATABASE_ROLE');
   const adapter=capability==='writer'
    ?await outcome(()=>f.readers.original(p.identity.id,f.scope(),{kind:'prepare',key:p.command.key},'system-privilege-test'))
    :await outcome(()=>f.readers.resolveOwner(f.observation(),rid,'system-privilege-test'));
   expect(adapter).not.toBe('accepted');
  }finally{client.release();}
 };

 it('matches the PG17.11 initdb restriction inventory and preserves ordinary approved built-ins',async()=>{
  expect(custodyPostgresVersions).toContain(Number((await f.admin.query("SELECT current_setting('server_version_num') AS version")).rows[0].version));
  const rows=(await f.admin.query(initialRestricted,[f.writer.role])).rows;
  expect(rows).toHaveLength(62);expect(rows.every(r=>r.forbidden)).toBe(true);
  for(const capability of ['writer','verifier'] as const){
   const client=await f[capability].pool.connect();try{
    await expect(assertCustodySetupConnection(client,capability)).resolves.toBeUndefined();
    expect((await client.query("SELECT lower('SAFE') AS value,jsonb_build_object('ok',true) AS object,has_function_privilege(SESSION_USER,'pg_catalog.sha256(bytea)','EXECUTE') AS hashing")).rows[0]).toEqual({value:'safe',object:{ok:true},hashing:true});
    await expect(client.query('SELECT pactwoven.custody_system_privileges_safe((SELECT oid FROM pg_roles WHERE rolname=SESSION_USER))')).rejects.toMatchObject({code:'42501'});
   }finally{client.release();}
  }
 });

 for(const capability of ['writer','verifier'] as const)it(`rejects direct EXECUTE on every restricted PG17.11 signature for ${capability}`,async()=>{
  const p=await f.prepare(),principal=f[capability],rows=(await f.admin.query(initialRestricted,[principal.role])).rows;
  expect(rows).toHaveLength(62);
  for(const row of rows){
   expect(row.forbidden).toBe(true);
   p.identity=await f.identity();
   // regprocedure is catalog-derived under pg_catalog; no caller-supplied SQL identifiers.
   const signature='pg_catalog.'+row.signature;
   try{await f.admin.query(`GRANT EXECUTE ON FUNCTION ${signature} TO "${principal.role}"`);expect((await principal.pool.query('SELECT has_function_privilege(SESSION_USER,$1,\'EXECUTE\') AS allowed',[signature])).rows[0].allowed).toBe(true);await deny(capability,p);}
   finally{await f.admin.query(`REVOKE EXECUTE ON FUNCTION ${signature} FROM "${principal.role}"`);}
  }
  console.info(JSON.stringify({probe:'all_restricted_pg17_signatures',capability,signatures:rows.length,restrictedFunctionsInvoked:false}));
 },60000);

 const representatives=['pg_read_binary_file(text,bigint,bigint,boolean)','lo_import(text,oid)','pg_stat_file(text,boolean)','pg_ls_dir(text,boolean,boolean)','pg_backup_stop(boolean)','pg_log_backend_memory_contexts(integer)'];
 for(const capability of ['writer','verifier'] as const)for(const mode of ['public','inherited','set-only'] as const)it(`rejects ${mode} restricted overload ACLs for ${capability}`,async()=>{
  const p=await f.prepare(),principal=f[capability],bridge=await f.login('system_bridge',null),ancestor=await f.login('system_ancestor',null),options=mode==='set-only'?' WITH INHERIT FALSE,SET TRUE':'';
  if(mode!=='public'){await f.admin.query(`GRANT "${ancestor.role}" TO "${bridge.role}"${options}`);await f.admin.query(`GRANT "${bridge.role}" TO "${principal.role}"${options}`);}
  try{for(const name of representatives){p.identity=await f.identity();const signature='pg_catalog.'+name,target=mode==='public'?'PUBLIC':`"${ancestor.role}"`;
   try{
    await f.admin.query(`GRANT EXECUTE ON FUNCTION ${signature} TO ${target}`);
    const direct=(await principal.pool.query("SELECT has_function_privilege(SESSION_USER,$1,'EXECUTE') AS execute",[signature])).rows[0].execute;
    expect(direct).toBe(mode!=='set-only');
    expect((await f.admin.query("SELECT has_function_privilege($1,$2,'EXECUTE') AS execute",[mode==='public'?principal.role:ancestor.role,signature])).rows[0].execute).toBe(true);
    await deny(capability,p);
   }finally{await f.admin.query(`REVOKE EXECUTE ON FUNCTION ${signature} FROM ${target}`);}
  }}finally{if(mode!=='public'){await f.admin.query(`REVOKE "${bridge.role}" FROM "${principal.role}"`);await f.admin.query(`REVOKE "${ancestor.role}" FROM "${bridge.role}"`);}}
  console.info(JSON.stringify({probe:'restricted_overload_acl_closure',capability,mode,signatures:representatives.length,restrictedFunctionsInvoked:false}));
 },60000);

 for(const capability of ['writer','verifier'] as const)it(`rejects other predefined PG17 capabilities for ${capability}`,async()=>{
  const p=await f.prepare(),principal=f[capability];
  for(const role of ['pg_read_all_settings','pg_read_all_stats','pg_stat_scan_tables','pg_signal_backend','pg_checkpoint','pg_maintain','pg_use_reserved_connections','pg_create_subscription']){
   p.identity=await f.identity();
   try{await f.admin.query(`GRANT ${role} TO "${principal.role}" WITH INHERIT FALSE,SET TRUE`);await deny(capability,p);}
   finally{await f.admin.query(`REVOKE ${role} FROM "${principal.role}"`);}
  }
 });

 for(const escalation of ['role','function','public'] as const)it(`rejects ${escalation} authority through existing direct custody entry points and retained verifier evidence`,async()=>{
  const p=await f.prepare(),lookup={responsibilityId:rid,kind:'prepare',key:p.command.key,commandHash:p.result.commandHash};
  const queries=[['SELECT pactwoven.custody_setup_command($1,$2::jsonb)',[p.identity.id,JSON.stringify(p.command)]],['SELECT pactwoven.custody_setup_read($1,$2,$3)',[p.identity.id,rid,p.result.setupId]],['SELECT pactwoven.custody_setup_recover($1,$2::jsonb)',[p.identity.id,JSON.stringify(lookup)]]] as const;
  for(const capability of ['writer','verifier'] as const){const principal=f[capability],target=escalation==='public'?'PUBLIC':`"${principal.role}"`;
   try{
    if(escalation==='role')await f.admin.query(`GRANT pg_execute_server_program TO ${target} WITH INHERIT FALSE,SET TRUE`);
    else await f.admin.query(`GRANT EXECUTE ON FUNCTION pg_catalog.pg_read_file(text) TO ${target}`);
    for(const [query,args] of queries)await expect(f.writer.pool.query(query,[...args])).rejects.toMatchObject({code:'CS001'});
    if(capability==='verifier')await expect(f.verifier.pool.query('SELECT pactwoven.custody_setup_attest($1::jsonb)',[JSON.stringify({...p.identity,id:crypto.randomUUID()})])).rejects.toMatchObject({code:'CS001'});
   }finally{
    if(escalation==='role')await f.admin.query(`REVOKE pg_execute_server_program FROM ${target}`);
    else await f.admin.query(`REVOKE EXECUTE ON FUNCTION pg_catalog.pg_read_file(text) FROM ${target}`);
   }
  }
  expect((await f.admin.query('SELECT (SELECT count(*) FROM pactwoven.custody_setup_operations) AS operations,(SELECT count(*) FROM pactwoven.custody_setup_evidence) AS evidence')).rows[0]).toEqual({operations:'1',evidence:'1'});
  expect(await f.readers.original(p.identity.id,f.scope(),{kind:'prepare',key:p.command.key},'system-privilege-test')).toEqual({command:p.command,result:p.result});
 });
});
