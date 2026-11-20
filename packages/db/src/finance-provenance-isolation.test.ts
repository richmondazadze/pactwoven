import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { decodeSolanaBase58, encodeSolanaBase58, FINANCE_DEVNET_ASSET } from '@pactwoven/contracts';
import { physicalAccountEffectKey, physicalTransferKey, provenanceHex } from '@pactwoven/domain';
import { financeCounts, financeFixture, financeFixtureEnabled, financeLookup, fixtureAddress, rawFinanceAppend, waitForFinanceBlock, type FinanceFixture } from './finance-provenance.test-support';
import { financeProvenanceTables } from './finance-provenance-schema';

describe.skipIf(!financeFixtureEnabled)('real PostgreSQL provenance isolation',()=>{
  let f:FinanceFixture;beforeAll(async()=>{f=await financeFixture();},60000);afterAll(async()=>{await f?.close();});
  const newSource=async(id:string,role=f.a.role)=>{
    await f.admin.query("INSERT INTO pactwoven.finance_sources VALUES($1,'simulation','finance_org_a')",[id]);
    await f.admin.query("INSERT INTO pactwoven.finance_source_versions SELECT $1,version,endpoint_configuration_hash,adapter_version,normalizer_version,policy_hash,verifier_version,evidence FROM pactwoven.finance_source_versions WHERE source_id='source_a'",[id]);
    await f.admin.query('INSERT INTO pactwoven.finance_source_controls VALUES($1,1,true,null)',[id]);
    await f.admin.query("INSERT INTO pactwoven.finance_source_bindings SELECT $1,$2,'simulation','finance_org_a',oid,rolname,true,null FROM pg_roles WHERE rolname=$3",[id,f.accountA,role]);
  };
  it('starts with an empty registry and owner-only physical account exclusivity across environment/tenant aliases',async()=>{
    expect(f.initialRegistryRows).toBe(0);
    const bytes=Buffer.from(decodeSolanaBase58(FINANCE_DEVNET_ASSET.genesis,32));
    for(const [environment,organization] of [['simulation','finance_org_b'],['development','finance_org_a']]){
      await expect(f.admin.query('INSERT INTO pactwoven.finance_physical_accounts(genesis,address,environment,organization_id) VALUES($1,$2,$3,$4)',[bytes,Buffer.from(new Uint8Array(32).fill(11)),environment,organization])).rejects.toMatchObject({code:'23505'});
    }
    await expect(f.admin.query("UPDATE pactwoven.finance_physical_accounts SET organization_id='finance_org_b' WHERE account_key=$1",[f.accountA])).rejects.toMatchObject({code:'PF007'});
    await expect(f.admin.query('DELETE FROM pactwoven.finance_physical_accounts WHERE account_key=$1',[f.accountA])).rejects.toMatchObject({code:'PF007'});
  });
  it('matches SQL and TypeScript decoded identities, locator encoding and domain-separated effect hashes',async()=>{
    for(const size of [32,64] as const)for(const fill of [0,1,127,255]){
      const bytes=new Uint8Array(size).fill(fill);bytes[0]=0;const text=encodeSolanaBase58(bytes);
      expect((await f.admin.query("SELECT encode(pactwoven.finance_base58($1,$2),'hex') AS value",[text,size])).rows[0].value).toBe(provenanceHex(bytes));
    }
    for(const outer of [0,1,255,65534])for(const inner of [null,0,255,65534]){
      const locator={genesis:FINANCE_DEVNET_ASSET.genesis,signature:encodeSolanaBase58(new Uint8Array(64).fill(51)),outerInstructionIndex:outer,innerInstructionOrdinal:inner};
      const key=await physicalTransferKey(locator);expect((await f.admin.query('SELECT pactwoven.finance_locator($1) AS value',[locator])).rows[0].value).toBe(key);
      expect((await f.admin.query('SELECT pactwoven.finance_effect_key($1,$2) AS value',[key,f.accountA])).rows[0].value).toBe(await physicalAccountEffectKey(locator,{genesis:locator.genesis,address:fixtureAddress(11)}));
    }
  });
  it('denies forged tenant GUCs, foreign source/account scope and direct configuration/history writes',async()=>{
    const input=await f.input('forged_scope'),client=await f.a.pool.connect();
    try{
      await client.query("SELECT set_config('pactwoven.organization_id','finance_org_b',false),set_config('pactwoven.environment','production',false)");
      const result=await rawFinanceAppend(client,input);expect(result).toMatchObject({environment:'simulation',organizationId:'finance_org_a'});
      await expect(rawFinanceAppend(client,{...input,source:{id:'source_c',version:1},account:{key:f.accountC,version:1}})).rejects.toMatchObject({code:'PF001'});
      await expect(rawFinanceAppend(client,{...input,account:{key:f.accountC,version:1}})).rejects.toMatchObject({code:'PF001'});
      for(const table of financeProvenanceTables)await expect(client.query(`SELECT * FROM pactwoven.${table}`)).rejects.toMatchObject({code:'42501'});
      await expect(client.query("UPDATE pactwoven.finance_source_controls SET accepts_observations=true")).rejects.toMatchObject({code:'42501'});
      await expect(client.query("SELECT pactwoven.finance_hash('{}')")).rejects.toMatchObject({code:'42501'});
    }finally{client.release(true);}
  });
  it('legacy and unbound login roles cannot execute observer entry points or reach its evidence',async()=>{
    const input=await f.input('legacy_attempt');
    for(const login of [f.runtime,f.bootstrap,f.access,f.mandate,f.stranger]){
      await expect(rawFinanceAppend(login.pool,input)).rejects.toMatchObject({code:'42501'});
      await expect(login.pool.query('SELECT * FROM pactwoven.finance_deliveries')).rejects.toMatchObject({code:'42501'});
    }
    await expect(f.a.pool.query("INSERT INTO pactwoven.mandate_operations(environment,organization_id,id) VALUES('simulation','finance_org_a','forbidden')")).rejects.toThrow();
    await expect(f.a.pool.query('UPDATE pactwoven.organizations SET authority_epoch=authority_epoch+1')).rejects.toMatchObject({code:'42501'});
  });
  it.each(['units','version','extra-authority','null-status','wrong-genesis','bad-position','bad-hash'])('validates %s even through raw SQL with no partial evidence',async fault=>{
    const input=await f.input(`invalid_${fault}`,'transfer');if(input.observation.kind!=='transfer')throw new Error('fixture');const invalid=structuredClone(input) as unknown as Record<string,any>;
    if(fault==='units')invalid.observation.fact.amountBaseUnits='18446744073709551616';if(fault==='version')invalid.source.version=2147483648;
    if(fault==='extra-authority')invalid.verified=true;if(fault==='null-status')invalid.observation.fact.instructionKind=null;
    if(fault==='wrong-genesis')invalid.observation.fact.locator.genesis=fixtureAddress(22);if(fault==='bad-position')invalid.observation.fact.locator.innerInstructionOrdinal=0;if(fault==='bad-hash')invalid.payloadHash='0'.repeat(64);
    const before=await financeCounts(f.admin);await expect(rawFinanceAppend(f.a.pool,invalid)).rejects.toMatchObject({code:'PF004'});expect(await financeCounts(f.admin)).toEqual(before);
  });
  it('keeps source principal OID/name binding after role drop and recreation, even under the same role name',async()=>{
    await newSource('source_dropped_login',f.stranger.role);
    const oldOid=(await f.admin.query('SELECT oid FROM pg_roles WHERE rolname=$1',[f.stranger.role])).rows[0].oid;
    await f.admin.query(`DROP OWNED BY "${f.stranger.role}"`);await f.admin.query(`DROP ROLE "${f.stranger.role}"`);
    const password=randomBytes(32).toString('hex');await f.admin.query(`CREATE ROLE "${f.stranger.role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`);await f.admin.query(`GRANT pactwoven_finance_observer TO "${f.stranger.role}"`);
    expect((await f.admin.query('SELECT oid FROM pg_roles WHERE rolname=$1',[f.stranger.role])).rows[0].oid).not.toBe(oldOid);
    const pool=new Pool({...f.config,user:f.stranger.role,password});try{const input=await f.input('recreated_login');input.source.id='source_dropped_login';await expect(rawFinanceAppend(pool,input)).rejects.toMatchObject({code:'PF001'});}finally{await pool.end();}
  });
  it('requires original session identity and READ COMMITTED under direct SQL',async()=>{
    const input=await f.input('role_switched'),client=await f.a.pool.connect();
    try{
      await client.query('SET ROLE pactwoven_finance_observer');await expect(rawFinanceAppend(client,input)).rejects.toMatchObject({code:'PF001'});await client.query('RESET ROLE');
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');await expect(rawFinanceAppend(client,input)).rejects.toMatchObject({code:'PF001'});await client.query('ROLLBACK');
    }finally{client.release(true);}
  });
  it.each(['source-version','source-revocation','binding-revocation','membership-revocation','asset-disabled','account-disabled'])('rechecks %s after an observed real organization lock wait',async change=>{
    const source=`wait_${change.replaceAll('-','_')}`;await newSource(source);const input=await f.input(source);input.source.id=source;
    const holder=await f.admin.connect(),writer=await f.a.pool.connect();let task:Promise<unknown>|undefined;
    try{
      const holderPid=(await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,writerPid=(await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await holder.query('BEGIN');await holder.query("SELECT 1 FROM pactwoven.organizations WHERE environment='simulation' AND id='finance_org_a' FOR UPDATE");
      task=rawFinanceAppend(writer,input);const rejected=expect(task).rejects.toMatchObject({code:change==='source-version'?'PF002':'PF001'});
      await waitForFinanceBlock(f.admin,writerPid,holderPid);
      if(change==='source-version'){
        await holder.query('INSERT INTO pactwoven.finance_source_versions SELECT source_id,2,endpoint_configuration_hash,adapter_version,normalizer_version,policy_hash,verifier_version,evidence FROM pactwoven.finance_source_versions WHERE source_id=$1 AND version=1',[source]);
        await holder.query('UPDATE pactwoven.finance_source_controls SET current_version=2 WHERE source_id=$1',[source]);
      }else if(change==='source-revocation')await holder.query('UPDATE pactwoven.finance_source_controls SET revoked_at=clock_timestamp() WHERE source_id=$1',[source]);
      else if(change==='binding-revocation')await holder.query('UPDATE pactwoven.finance_source_bindings SET revoked_at=clock_timestamp() WHERE source_id=$1',[source]);
      else if(change==='membership-revocation')await holder.query(`REVOKE pactwoven_finance_observer FROM "${f.a.role}"`);
      else if(change==='asset-disabled')await holder.query('UPDATE pactwoven.finance_asset_controls SET accepts_observations=false WHERE asset_key=$1',[f.assetKey]);
      else await holder.query('UPDATE pactwoven.finance_account_controls SET accepts_observations=false WHERE account_key=$1',[f.accountA]);
      await holder.query('COMMIT');await rejected;
      expect((await f.admin.query('SELECT count(*) AS count FROM pactwoven.finance_deliveries WHERE source_id=$1',[source])).rows[0].count).toBe('0');
    }finally{await holder.query('ROLLBACK');if(change==='membership-revocation')await f.admin.query(`GRANT pactwoven_finance_observer TO "${f.a.role}"`);if(change==='asset-disabled')await f.admin.query('UPDATE pactwoven.finance_asset_controls SET accepts_observations=true WHERE asset_key=$1',[f.assetKey]);if(change==='account-disabled')await f.admin.query('UPDATE pactwoven.finance_account_controls SET accepts_observations=true WHERE account_key=$1',[f.accountA]);await task?.catch(()=>{});writer.release(true);holder.release();}
  });
  it('prevents owners accidentally rewriting append-only evidence or reviving tombstones',async()=>{
    const input=await f.input('immutable_receipt');await f.repository.append(input);
    await expect(f.admin.query("UPDATE pactwoven.finance_deliveries SET receipt='{}'")).rejects.toMatchObject({code:'PF007'});
    await expect(f.admin.query('TRUNCATE pactwoven.finance_provenance_conflicts')).rejects.toMatchObject({code:'PF007'});
    await expect(f.admin.query("UPDATE pactwoven.finance_source_bindings SET principal_oid=1 WHERE source_id='source_a'")).rejects.toMatchObject({code:'PF007'});
    await expect(f.admin.query("UPDATE pactwoven.finance_source_controls SET revoked_at=null WHERE source_id='wait_source_revocation'")).rejects.toMatchObject({code:'PF007'});
    expect(await f.repository.get(financeLookup(input))).toMatchObject({kind:'delivery',disposition:'recorded'});
  });
});
