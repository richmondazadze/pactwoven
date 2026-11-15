import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertFinanceProvenancePool } from './finance-provenance-pool';
import { financeCounts, financeFixture, financeFixtureConfig, financeFixtureEnabled, type FinanceFixture } from './finance-provenance.test-support';
import { assertRuntimePool } from './repository';
import { assertProvisionerPool } from './provisioner';
import { assertAccessPool } from './access-repository';
import { assertMandatePool } from './mandate-pool';

function syntheticFixtureUrl(target: string, username = 'a', password = 'b') {
  const url = new URL(target);
  url.username = username;
  url.password = password;
  return url.href;
}

describe('provenance fixture target boundary',()=>{
  it.each([
    syntheticFixtureUrl('postgresql://127.0.0.1:55439/pactwoven_dev'),
    syntheticFixtureUrl('postgresql://localhost:55439/pactwoven_finance_provenance_b2a_test'),
    syntheticFixtureUrl('postgresql://127.0.0.1:5432/pactwoven_finance_provenance_b2a_test'),
    syntheticFixtureUrl('postgresql://127.0.0.1:55439/pactwoven_finance_provenance_b2a_test?host=remote'),
    syntheticFixtureUrl('postgresql://127.0.0.1:55439/pactwoven_finance_provenance_b2a_test#other'),
  ])('rejects unsafe target before constructing a pool',url=>expect(()=>financeFixtureConfig(url)).toThrow());

  it.each(['postgres', 'postgresql'])('preserves the normal %s fixture without CI flags', protocol => {
    const url = syntheticFixtureUrl(`${protocol}://127.0.0.1:55439/pactwoven_finance_provenance_b2a_test`, 'a%2Bb', 'p@ss');
    const expected = { host: '127.0.0.1', port: 55439, database: 'pactwoven_finance_provenance_b2a_test',
      user: 'a+b', password: 'p@ss', ssl: false, max: 5, connectionTimeoutMillis: 3000, statement_timeout: 10000 };
    expect(financeFixtureConfig(url, {})).toEqual(expected);
    expect(financeFixtureConfig(url, { CI: 'true', GITHUB_ACTIONS: 'true' })).toEqual(expected);
  });

  it.each(['postgres', 'postgresql'])('allows the fixed %s CI port only in explicit GitHub Actions context', protocol => {
    const config = financeFixtureConfig(syntheticFixtureUrl(`${protocol}://127.0.0.1:55440/pactwoven_finance_provenance_b2a_test`, 'a%2Bb', 'p@ss'), { CI: 'true', GITHUB_ACTIONS: 'true' });
    expect(config).toEqual({ host: '127.0.0.1', port: 55440, database: 'pactwoven_finance_provenance_b2a_test',
      user: 'a+b', password: 'p@ss', ssl: false, max: 5, connectionTimeoutMillis: 3000, statement_timeout: 10000 });
  });

  it.each([
    {}, { CI: 'true' }, { GITHUB_ACTIONS: 'true' },
    { CI: 'false', GITHUB_ACTIONS: 'true' }, { CI: 'true', GITHUB_ACTIONS: 'false' },
    { CI: '1', GITHUB_ACTIONS: 'true' }, { CI: 'true', GITHUB_ACTIONS: '1' },
    { CI: 'TRUE', GITHUB_ACTIONS: 'true' }, { CI: 'true', GITHUB_ACTIONS: 'true ' },
  ])('rejects the CI port with incomplete or nonliteral CI context %j', environment => {
    expect(() => financeFixtureConfig(syntheticFixtureUrl('postgresql://127.0.0.1:55440/pactwoven_finance_provenance_b2a_test'), environment)).toThrow();
  });

  it.each(['', ':5432', ':55438', ':55441', ':65535'])('rejects arbitrary/default port %s even in CI', port => {
    const url = syntheticFixtureUrl(`postgresql://127.0.0.1${port}/pactwoven_finance_provenance_b2a_test`);
    expect(() => financeFixtureConfig(url, {})).toThrow();
    expect(() => financeFixtureConfig(url, { CI: 'true', GITHUB_ACTIONS: 'true' })).toThrow();
  });

  it.each([
    syntheticFixtureUrl('postgresql://localhost:55440/pactwoven_finance_provenance_b2a_test'),
    syntheticFixtureUrl('postgresql://127.0.0.2:55440/pactwoven_finance_provenance_b2a_test'),
    syntheticFixtureUrl('postgresql://[::1]:55440/pactwoven_finance_provenance_b2a_test'),
    syntheticFixtureUrl('postgresql://remote.test:55440/pactwoven_finance_provenance_b2a_test'),
    syntheticFixtureUrl('postgresql://127.0.0.1:55440/pactwoven_dev'),
    syntheticFixtureUrl('postgresql://127.0.0.1:55440/%70actwoven_finance_provenance_b2a_test'),
    syntheticFixtureUrl('postgresql://127.0.0.1:55440/pactwoven_finance_provenance_b2a_test/'),
    syntheticFixtureUrl('postgresql://127.0.0.1:55440/pactwoven_finance_provenance_b2a_test?host=/tmp'),
    syntheticFixtureUrl('postgresql://127.0.0.1:55440/pactwoven_finance_provenance_b2a_test?port=55439'),
    syntheticFixtureUrl('postgresql://127.0.0.1:55440/pactwoven_finance_provenance_b2a_test?sslmode=require'),
    syntheticFixtureUrl('postgresql://127.0.0.1:55440/pactwoven_finance_provenance_b2a_test?options=-c%20role%3Dpostgres'),
    syntheticFixtureUrl('postgresql://127.0.0.1:55440/pactwoven_finance_provenance_b2a_test#other'),
    syntheticFixtureUrl('https://127.0.0.1:55440/pactwoven_finance_provenance_b2a_test'),
    syntheticFixtureUrl('postgresql://127.0.0.1:55440/pactwoven_finance_provenance_b2a_test', 'a', ''),
    syntheticFixtureUrl('postgresql://127.0.0.1:55440/pactwoven_finance_provenance_b2a_test', '', 'b'),
    syntheticFixtureUrl('postgresql://127.0.0.1:55440/pactwoven_finance_provenance_b2a_test', 'a\0', 'b'),
    syntheticFixtureUrl('postgresql://127.0.0.1:55440/pactwoven_finance_provenance_b2a_test', 'a', 'b\0'),
    syntheticFixtureUrl('postgresql://127.0.0.1:55440/pactwoven_finance_provenance_b2a_test', 'a', 'b%zz'),
  ])('preserves endpoint, database and credential denials on the CI port: %s', url => {
    expect(() => financeFixtureConfig(url, { CI: 'true', GITHUB_ACTIONS: 'true' })).toThrow();
  });
});
describe.skipIf(!financeFixtureEnabled)('real provenance observer pool privileges',()=>{
  let f:FinanceFixture;beforeAll(async()=>{f=await financeFixture();},60000);afterAll(async()=>{await f?.close();});
  const identifier=(value:string)=>`"${value.replaceAll('"','""')}"`;
  async function databaseOwner(){
    const row=(await f.admin.query("SELECT datname,datdba::text AS oid,pg_get_userbyid(datdba) AS name FROM pg_database WHERE datname=current_database()")).rows[0];
    expect(row.datname).toBe('pactwoven_finance_provenance_b2a_test');return row as {datname:string;oid:string;name:string};
  }
  async function restoreDatabaseOwner(original:{datname:string;oid:string;name:string}){
    await f.admin.query(`ALTER DATABASE ${identifier(original.datname)} OWNER TO ${identifier(original.name)}`);
    expect(await databaseOwner()).toEqual(original);
  }
  it('accepts only an isolated observer and refuses privileged/legacy/unbound role families',async()=>{
    await expect(assertFinanceProvenancePool(f.a.pool)).resolves.toBeUndefined();
    for(const login of [f.admin,f.runtime.pool,f.bootstrap.pool,f.access.pool,f.mandate.pool,f.stranger.pool])await expect(assertFinanceProvenancePool(login)).rejects.toMatchObject({code:'UNSAFE_DATABASE_ROLE'});
  });
  it('preserves existing runtime, bootstrap, access and mandate pool isolation after the new migration',async()=>{
    await expect(assertRuntimePool(f.runtime.pool)).resolves.toBeUndefined();
    await expect(assertProvisionerPool(f.bootstrap.pool)).resolves.toBeUndefined();
    await expect(assertAccessPool(f.access.pool)).resolves.toBeUndefined();
    await expect(assertMandatePool(f.mandate.pool)).resolves.toBeUndefined();
  });
  it.each(['table','column','helper'])('rejects unexpected direct %s privileges on every checked-out connection',async privilege=>{
    const grant=privilege==='table'?'SELECT ON pactwoven.finance_deliveries':privilege==='column'?'UPDATE(receipt) ON pactwoven.finance_deliveries':'EXECUTE ON FUNCTION pactwoven.finance_hash(jsonb)';
    await f.admin.query(`GRANT ${grant} TO "${f.a.role}"`);
    const before=await financeCounts(f.admin);
    try{await expect(assertFinanceProvenancePool(f.a.pool)).rejects.toMatchObject({code:'UNSAFE_DATABASE_ROLE'});await expect(f.repository.append(await f.input(`unsafe_${privilege}`))).rejects.toMatchObject({code:'UNSAFE_DATABASE_ROLE'});expect(await financeCounts(f.admin)).toEqual(before);}
    finally{await f.admin.query(`REVOKE ${grant} FROM "${f.a.role}"`);}
    await expect(assertFinanceProvenancePool(f.a.pool)).resolves.toBeUndefined();
  });
  it('rejects transitive membership in legacy writer roles even through another login',async()=>{
    const bridge=await f.makeLogin('bridge',null);await f.admin.query(`GRANT pactwoven_mandate_writer TO "${bridge.role}"`);await f.admin.query(`GRANT "${bridge.role}" TO "${f.a.role}"`);
    try{await expect(assertFinanceProvenancePool(f.a.pool)).rejects.toMatchObject({code:'UNSAFE_DATABASE_ROLE'});}finally{await f.admin.query(`REVOKE "${bridge.role}" FROM "${f.a.role}"`);}
  });
  it('does not trust an attacker-selected connection search path',async()=>{
    const client=await f.a.pool.connect();try{await client.query('SET search_path=pg_temp,public,pactwoven');}finally{client.release();}
    await expect(assertFinanceProvenancePool(f.a.pool)).resolves.toBeUndefined();
  });
  it('rejects an unreviewed publicly executable definer helper outside the application schema',async()=>{
    await f.admin.query('CREATE FUNCTION public.fixture_provenance_unreviewed() RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT 1 $$');
    try{await expect(assertFinanceProvenancePool(f.a.pool)).rejects.toMatchObject({code:'UNSAFE_DATABASE_ROLE'});}finally{await f.admin.query('DROP FUNCTION public.fixture_provenance_unreviewed()');}
    await expect(assertFinanceProvenancePool(f.a.pool)).resolves.toBeUndefined();
  });
  it('rejects direct database ownership and implicit pg_database_owner/public CREATE capability',async()=>{
    const original=await databaseOwner(),before=await financeCounts(f.admin);
    try{
      await f.admin.query(`ALTER DATABASE ${identifier(original.datname)} OWNER TO ${identifier(f.a.role)}`);
      const capability=(await f.a.pool.query("SELECT pg_has_role(current_user,'pg_database_owner','USAGE') AS owner,has_schema_privilege(current_user,'public','CREATE') AS public_create")).rows[0];
      expect(capability).toEqual({owner:true,public_create:true});
      await expect(assertFinanceProvenancePool(f.a.pool)).rejects.toMatchObject({code:'UNSAFE_DATABASE_ROLE'});
      await expect(f.repository.append(await f.input('database_owner_denied'))).rejects.toMatchObject({code:'UNSAFE_DATABASE_ROLE'});
      expect(await financeCounts(f.admin)).toEqual(before);
    }finally{await restoreDatabaseOwner(original);}
    await expect(assertFinanceProvenancePool(f.a.pool)).resolves.toBeUndefined();
  });
  it.each([true,false])('rejects a transitively reachable database owner with inherited privileges %s',async inherit=>{
    const owner=await f.makeLogin(inherit?'database_owner_inherit':'database_owner_set',null),bridge=await f.makeLogin(inherit?'database_bridge_inherit':'database_bridge_set',null),original=await databaseOwner();
    try{
      await f.admin.query(`ALTER DATABASE ${identifier(original.datname)} OWNER TO ${identifier(owner.role)}`);
      await f.admin.query(`GRANT ${identifier(owner.role)} TO ${identifier(bridge.role)} WITH INHERIT ${inherit?'TRUE':'FALSE'}, SET TRUE`);
      await f.admin.query(`GRANT ${identifier(bridge.role)} TO ${identifier(f.a.role)} WITH INHERIT ${inherit?'TRUE':'FALSE'}, SET TRUE`);
      const capability=(await f.a.pool.query("SELECT pg_has_role(current_user,$1,'USAGE') AS inherited,pg_has_role(current_user,$1,'SET') AS can_set",[owner.role])).rows[0];
      expect(capability).toEqual({inherited:inherit,can_set:true});
      await expect(assertFinanceProvenancePool(f.a.pool)).rejects.toMatchObject({code:'UNSAFE_DATABASE_ROLE'});
    }finally{
      await restoreDatabaseOwner(original);await f.admin.query(`REVOKE ${identifier(bridge.role)} FROM ${identifier(f.a.role)}`);await f.admin.query(`REVOKE ${identifier(owner.role)} FROM ${identifier(bridge.role)}`);
    }
    await expect(assertFinanceProvenancePool(f.a.pool)).resolves.toBeUndefined();
  });
  it.each(['direct','inherited','set-only'] as const)('rejects %s ownership of the public schema',async mode=>{
    const original=(await f.admin.query("SELECT nspowner::text AS oid,pg_get_userbyid(nspowner) AS name FROM pg_namespace WHERE nspname='public'")).rows[0] as {oid:string;name:string};
    const owner=mode==='direct'?f.a:await f.makeLogin(`public_owner_${mode.replace('-','_')}`,null);
    try{
      await f.admin.query(`ALTER SCHEMA public OWNER TO ${identifier(owner.role)}`);
      if(mode!=='direct')await f.admin.query(`GRANT ${identifier(owner.role)} TO ${identifier(f.a.role)} WITH INHERIT ${mode==='inherited'?'TRUE':'FALSE'}, SET TRUE`);
      const capability=(await f.a.pool.query("SELECT pg_has_role(current_user,$1,'USAGE') AS inherited,pg_has_role(current_user,$1,'SET') AS can_set",[owner.role])).rows[0];
      expect(capability).toEqual({inherited:mode!=='set-only',can_set:true});await expect(assertFinanceProvenancePool(f.a.pool)).rejects.toMatchObject({code:'UNSAFE_DATABASE_ROLE'});
    }finally{
      await f.admin.query(`ALTER SCHEMA public OWNER TO ${identifier(original.name)}`);
      expect((await f.admin.query("SELECT nspowner::text AS oid,pg_get_userbyid(nspowner) AS name FROM pg_namespace WHERE nspname='public'")).rows[0]).toEqual(original);
      if(mode!=='direct')await f.admin.query(`REVOKE ${identifier(owner.role)} FROM ${identifier(f.a.role)}`);
    }
    await expect(assertFinanceProvenancePool(f.a.pool)).resolves.toBeUndefined();
  });
  it.each(['direct','inherited','set-only'] as const)('rejects %s public schema CREATE without ownership',async mode=>{
    const grantee=mode==='direct'?f.a:await f.makeLogin(`public_create_${mode.replace('-','_')}`,null);
    try{
      await f.admin.query(`GRANT CREATE ON SCHEMA public TO ${identifier(grantee.role)}`);
      if(mode!=='direct')await f.admin.query(`GRANT ${identifier(grantee.role)} TO ${identifier(f.a.role)} WITH INHERIT ${mode==='inherited'?'TRUE':'FALSE'}, SET TRUE`);
      expect((await f.a.pool.query("SELECT has_schema_privilege(current_user,'public','CREATE') AS allowed")).rows[0].allowed).toBe(mode!=='set-only');
      await expect(assertFinanceProvenancePool(f.a.pool)).rejects.toMatchObject({code:'UNSAFE_DATABASE_ROLE'});
    }finally{
      await f.admin.query(`REVOKE CREATE ON SCHEMA public FROM ${identifier(grantee.role)}`);
      if(mode!=='direct')await f.admin.query(`REVOKE ${identifier(grantee.role)} FROM ${identifier(f.a.role)}`);
    }
    await expect(assertFinanceProvenancePool(f.a.pool)).resolves.toBeUndefined();
  });
  it('rejects database-wide schema creation even without database ownership',async()=>{
    const original=await databaseOwner();
    try{
      await f.admin.query(`GRANT CREATE ON DATABASE ${identifier(original.datname)} TO ${identifier(f.a.role)}`);
      expect((await f.a.pool.query("SELECT pg_has_role(current_user,'pg_database_owner','USAGE') AS owner,has_database_privilege(current_user,current_database(),'CREATE') AS can_create")).rows[0]).toEqual({owner:false,can_create:true});
      await expect(assertFinanceProvenancePool(f.a.pool)).rejects.toMatchObject({code:'UNSAFE_DATABASE_ROLE'});
    }finally{await f.admin.query(`REVOKE CREATE ON DATABASE ${identifier(original.datname)} FROM ${identifier(f.a.role)}`);expect(await databaseOwner()).toEqual(original);}
    await expect(assertFinanceProvenancePool(f.a.pool)).resolves.toBeUndefined();
  });
});
