import { mkdtemp, writeFile, chmod, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { financialFenceTables, financialFenceControlRoutines } from './financial-fences-schema';
import { PostgresFoundationRepository } from './repository';
import { PostgresAccessRepository, type VerifiedStepUpIdentity } from './access-repository';
import { financialFenceFixtureConfig, financialFenceFixtureEnvironment, readFinancialFenceFixtureConfig, financialFenceFixture,
  financialFenceFixtureEnabled, fenceBackendPid, fenceIdentity, waitForFinancialFenceBlock, type FinancialFenceFixture } from './financial-fences.test-support';

const fakeUrl = new URL('postgresql://127.0.0.1:55439/pactwoven_financial_fences_fa0_test');
fakeUrl.username = 'synthetic';
fakeUrl.password = 'never-used';
const fake = fakeUrl.href;
describe('FA-0 fixture target and credential isolation', () => {
  it('pins exact target without inheriting PostgreSQL or Pactwoven configuration', () => {
    expect(financialFenceFixtureConfig(fake, {})).toMatchObject({ host: '127.0.0.1', port: 55439, database: 'pactwoven_financial_fences_fa0_test', ssl: false });
    for (const value of [fake.replace('127.0.0.1','localhost'), fake.replace('55439','55440'), fake.replace('fa0_test','dev'), fake+'?host=elsewhere', fake+'#test', fake.replace('postgresql:','https:'), fake.replace(':never-used','')])
      expect(() => financialFenceFixtureConfig(value, {})).toThrow();
    expect(financialFenceFixtureEnvironment({ PATH: '/test', PACTWOVEN_DATABASE_URL: 'forbidden', PGHOST: 'forbidden', PGOPTIONS: '-c role=other' })).toEqual({ PATH: '/test' });
  });
  it.each(['postgres', 'postgresql'])('accepts only the fixed %s CI transport with both literal flags', protocol => {
    const target = fake.replace('postgresql:', protocol + ':').replace('55439', '55440');
    expect(financialFenceFixtureConfig(target, { CI: 'true', GITHUB_ACTIONS: 'true' })).toEqual({
      host: '127.0.0.1', port: 55440, database: 'pactwoven_financial_fences_fa0_test',
      user: 'synthetic', password: 'never-used', ssl: false, max: 8, connectionTimeoutMillis: 3000, statement_timeout: 10000,
    });
    expect(financialFenceFixtureConfig(fake, { CI: 'true', GITHUB_ACTIONS: 'true' }).port).toBe(55439);
  });
  it.each([
    {}, { CI: 'true' }, { GITHUB_ACTIONS: 'true' },
    { CI: 'false', GITHUB_ACTIONS: 'true' }, { CI: 'true', GITHUB_ACTIONS: 'false' },
    { CI: '1', GITHUB_ACTIONS: 'true' }, { CI: 'true', GITHUB_ACTIONS: '1' },
    { CI: 'TRUE', GITHUB_ACTIONS: 'true' }, { CI: 'true', GITHUB_ACTIONS: 'true ' },
  ])('rejects the CI transport without exact paired context %j', environment => {
    expect(() => financialFenceFixtureConfig(fake.replace('55439', '55440'), environment)).toThrow();
  });
  it.each(['', '5432', '55438', '55441', '65535'])('rejects arbitrary/default port %s even in CI', port => {
    const target = fake.replace(':55439', port ? ':' + port : '');
    expect(() => financialFenceFixtureConfig(target, { CI: 'true', GITHUB_ACTIONS: 'true' })).toThrow();
  });
  it('retains exact host, database, protocol, query, fragment and credential limits in CI', () => {
    const target = fake.replace('55439', '55440');
    for (const value of [
      target.replace('127.0.0.1', 'localhost'), target.replace('127.0.0.1', '127.0.0.2'),
      target.replace('127.0.0.1', '[::1]'), target.replace('127.0.0.1', 'remote.test'),
      target.replace('fa0_test', 'dev'), target.replace('/pactwoven_', '/%70actwoven_'), target + '/',
      target + '?host=/tmp', target + '?port=55439', target + '?sslmode=require', target + '?options=-c%20role%3Dpostgres', target + '#test',
      target.replace('postgresql:', 'https:'), target.replace(':never-used', ''), target.replace('synthetic:', ':'),
      target.replace('synthetic', 'synthetic%00'), target.replace('never-used', 'never-used%00'), target.replace('never-used', 'never-used%zz'),
    ]) expect(() => financialFenceFixtureConfig(value, { CI: 'true', GITHUB_ACTIONS: 'true' })).toThrow();
  });
  it('rejects insecure, empty, oversized and symlink credential files', async () => {
    const directory = await mkdtemp(join(tmpdir(),'pactwoven-fa0-'));
    try {
      const file=join(directory,'url'), link=join(directory,'link');
      await writeFile(file,fake,{mode:0o600});
      expect((await readFinancialFenceFixtureConfig(file)).database).toBe('pactwoven_financial_fences_fa0_test');
      await symlink(file,link); await expect(readFinancialFenceFixtureConfig(link)).rejects.toThrow();
      await chmod(file,0o644); await expect(readFinancialFenceFixtureConfig(file)).rejects.toThrow();
      await chmod(file,0o600); await writeFile(file,''); await expect(readFinancialFenceFixtureConfig(file)).rejects.toThrow();
      await writeFile(file,'x'.repeat(8193)); await expect(readFinancialFenceFixtureConfig(file)).rejects.toThrow();
      await expect(readFinancialFenceFixtureConfig(directory)).rejects.toThrow();
    } finally { await rm(directory,{recursive:true,force:true}); }
  });
});
const suite=financialFenceFixtureEnabled?describe:describe.skip;
suite('FA-0 real database privileges and ordered lock races', () => {
  let fixture: FinancialFenceFixture | undefined;
  const clients: PoolClient[]=[];
  afterEach(async () => {
    for (const client of clients.splice(0)) { await client.query('ROLLBACK'); client.release(); }
    await fixture?.close(); fixture=undefined;
  });
  const client = async (pool: Pool) => { const connection=await pool.connect(); clients.push(connection); return connection; };
  const queryOutcome = (promise: Promise<unknown>) => promise.then(value=>({ok:true as const,value}),error=>({ok:false as const,error:error as {code:string}}));
  it('leaves every new table/routine ungranted to actual runtime, mandate, observer, provisioner, access and stranger logins', async () => {
    fixture=await financialFenceFixture();
    for (const login of [fixture.runtime,fixture.mandate,fixture.observer,fixture.bootstrap,fixture.access,fixture.stranger]) {
      for (const table of financialFenceTables) {
        const permission=(await fixture.admin.query('SELECT has_table_privilege($1,$2,\'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER\') AS allowed',[login.role,`pactwoven.${table}`])).rows[0];
        expect(permission.allowed,`${login.role}/${table}`).toBe(false);
        await expect(login.pool.query(`SELECT * FROM pactwoven.${table}`)).rejects.toMatchObject({code:'42501'});
        await expect(login.pool.query(`DELETE FROM pactwoven.${table}`)).rejects.toMatchObject({code:'42501'});
      }
      for (const routine of financialFenceControlRoutines) expect((await fixture.admin.query("SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed",[login.role,routine])).rows[0].allowed).toBe(false);
      expect((await login.pool.query("SELECT count(*)::int AS count FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='pactwoven' AND p.proname LIKE 'financial_%' AND has_function_privilege(current_user,p.oid,'EXECUTE')")).rows[0].count).toBe(0);
      await expect(login.pool.query('SELECT pactwoven.financial_next_generation(0)')).rejects.toMatchObject({code:'42501'});
      await expect(login.pool.query("SELECT pactwoven.financial_update_asset_control($1,0,$2,1,true,null)",[fixture.assetKey,'a'.repeat(64)])).rejects.toMatchObject({code:'42501'});
      await expect(login.pool.query("UPDATE pactwoven.financial_authority_fences SET family='legacy'")).rejects.toMatchObject({code:'42501'});
    }
  });
  it('initializes concurrent foundation responsibilities without upgrading their shared organization locks', async () => {
    fixture=await financialFenceFixture();
    const a=await client(fixture.runtime.pool), b=await client(fixture.runtime.pool);
    const session=await new PostgresFoundationRepository(fixture.runtime.pool,'development').getSession(fenceIdentity('operations_a'),'trace');
    const heldPool=(connection:PoolClient)=>({async connect(){return {async query(sql:string,values?:unknown[]) {
      if(sql==='BEGIN')return connection.query('SAVEPOINT fixture_command');
      if(sql==='COMMIT')return connection.query('RELEASE SAVEPOINT fixture_command');
      if(sql==='ROLLBACK')return connection.query('ROLLBACK TO SAVEPOINT fixture_command');
      return connection.query(sql,values);
    },release(){}};}} as unknown as Pool);
    await a.query('BEGIN'); await b.query('BEGIN');
    const command={expectedVersion:0,mandateVersion:null,authorityEpoch:null,payload:{title:'Concurrent event',description:'',siteId:'site_a',
      window:{startsAt:new Date().toISOString(),endsAt:new Date(Date.now()+3600000).toISOString(),timeZone:'America/Chicago'},requirements:[],acceptancePolicy:'Signed evidence.'}};
    // Each real repository call remains uncommitted, proving that neither needs an organization UPDATE lock.
    const first=await new PostgresFoundationRepository(heldPool(a),'development').createResponsibility(session.actor,'concurrent_create_0001',command);
    const second=await new PostgresFoundationRepository(heldPool(b),'development').createResponsibility(session.actor,'concurrent_create_0002',command);
    await a.query('COMMIT'); await b.query('COMMIT');
    expect(first.aggregateId).not.toBe(second.aggregateId);
    expect((await fixture.admin.query("SELECT count(*)::int AS count FROM pactwoven.financial_authority_fences WHERE family='none' AND generation=0")).rows[0].count).toBe(3);
  });
  it.each(['organization','member','expiry','session'] as const)('rechecks %s authority after an observed PostgreSQL wait',async kind=>{
    fixture=await financialFenceFixture(); const holder=await client(fixture.admin), waiter=await client(fixture.mandate.pool);
    const waiterPid=await fenceBackendPid(waiter),holderPid=await fenceBackendPid(holder);
    await holder.query('BEGIN'); await waiter.query('BEGIN');
    if(kind==='session') await holder.query("INSERT INTO pactwoven.session_revocations(environment,session_id) VALUES('development','session_finance_a')");
    else await holder.query("SELECT id FROM pactwoven.organizations WHERE id='org_a' FOR UPDATE");
    const pending=queryOutcome(waiter.query("SELECT pactwoven.mandate_resolve_context('development',$1::jsonb,'responsibility_a',true,'wait')",[JSON.stringify(fenceIdentity())]));
    await waitForFinancialFenceBlock(fixture.admin,waiterPid,holderPid);
    if(kind==='organization')await holder.query("UPDATE pactwoven.organizations SET status='suspended' WHERE id='org_a'");
    if(kind==='member')await holder.query("UPDATE pactwoven.memberships SET status='revoked' WHERE actor_id='finance_a'");
    if(kind==='expiry')await holder.query("UPDATE pactwoven.memberships SET expires_at=clock_timestamp()-interval '1 second' WHERE actor_id='finance_a'");
    await holder.query('COMMIT'); const result=await pending; expect(result.ok).toBe(false); if(!result.ok)expect(result.error?.code).toBe('PM001');
  });
  it('serializes source-only then combined binding control in the shared organization prefix',async()=>{
    fixture=await financialFenceFixture();const {admin,accountA}=fixture;
    const holder=await client(admin),waiter=await client(admin),waiterPid=await fenceBackendPid(waiter),holderPid=await fenceBackendPid(holder);
    const source=(await admin.query("SELECT * FROM pactwoven.financial_source_fences WHERE source_id='source_org_a'")).rows[0],binding=(await admin.query("SELECT * FROM pactwoven.financial_source_binding_fences WHERE source_id='source_org_a'")).rows[0];
    await holder.query('BEGIN');await waiter.query('BEGIN');
    await holder.query("SELECT pactwoven.financial_update_source_control('source_org_a',$1,$2,1,false,null)",[source.generation,source.control_hash]);
    const pending=queryOutcome(waiter.query("SELECT pactwoven.financial_update_source_binding_control('source_org_a',$1,$2,$3,false,null) AS body",[accountA,binding.generation,binding.control_hash]));
    await waitForFinancialFenceBlock(admin,waiterPid,holderPid);await holder.query('COMMIT');expect((await pending).ok).toBe(true);await waiter.query('COMMIT');
    expect((await admin.query("SELECT generation FROM pactwoven.financial_source_fences WHERE source_id='source_org_a'")).rows[0].generation).toBe(1);
    expect((await admin.query("SELECT generation FROM pactwoven.financial_source_binding_fences WHERE source_id='source_org_a'")).rows[0].generation).toBe(1);
  });
  it('revokes a global asset while two tenant consumers hold organizations without tenant lock fanout',async()=>{
    fixture=await financialFenceFixture();const {admin,assetKey}=fixture;
    const assetOwner=await client(admin),tenantA=await client(admin),tenantB=await client(admin);
    const pids=await Promise.all([assetOwner,tenantA,tenantB].map(fenceBackendPid));
    await assetOwner.query('BEGIN');await tenantA.query('BEGIN');await tenantB.query('BEGIN');
    await tenantA.query("SELECT id FROM pactwoven.organizations WHERE id='org_a' FOR UPDATE");await tenantB.query("SELECT id FROM pactwoven.organizations WHERE id='org_b' FOR UPDATE");
    await assetOwner.query('SELECT asset_key FROM pactwoven.finance_physical_assets WHERE asset_key=$1 FOR UPDATE',[assetKey]);
    const a=queryOutcome(tenantA.query('SELECT asset_key FROM pactwoven.finance_physical_assets WHERE asset_key=$1 FOR SHARE',[assetKey]));
    const b=queryOutcome(tenantB.query('SELECT asset_key FROM pactwoven.finance_physical_assets WHERE asset_key=$1 FOR SHARE',[assetKey]));
    await waitForFinancialFenceBlock(admin,pids[1]!,pids[0]!);await waitForFinancialFenceBlock(admin,pids[2]!,pids[0]!);
    const initial=(await assetOwner.query('SELECT * FROM pactwoven.financial_asset_fences WHERE asset_key=$1',[assetKey])).rows[0];
    await assetOwner.query('SELECT pactwoven.financial_update_asset_control($1,$2,$3,1,false,clock_timestamp())',[assetKey,initial.generation,initial.control_hash]);
    await assetOwner.query('COMMIT');expect((await a).ok).toBe(true);expect((await b).ok).toBe(true);
    for(const tenant of [tenantA,tenantB]){
      const fresh=(await tenant.query('SELECT c.revoked_at,f.generation FROM pactwoven.finance_asset_controls c JOIN pactwoven.financial_asset_fences f USING(asset_key) WHERE asset_key=$1 FOR SHARE OF c,f',[assetKey])).rows[0];
      expect(fresh.generation).toBe(1);expect(fresh.revoked_at).not.toBeNull();await tenant.query('COMMIT');
    }
  });
  it.each(['site','asset','account','source','binding'] as const)('rejects stale %s expected control after the conflicting writer commits',async kind=>{
    fixture=await financialFenceFixture();const {admin,assetKey,accountA}=fixture;
    const holder=await client(admin),waiter=await client(admin),holderPid=await fenceBackendPid(holder),waiterPid=await fenceBackendPid(waiter);
    const table={site:'financial_site_fences',asset:'financial_asset_fences',account:'financial_account_fences',source:'financial_source_fences',binding:'financial_source_binding_fences'}[kind];
    const filter=kind==='site'?"site_id='site_a'":kind==='asset'?'true':kind==='account'?`account_key='${accountA}'`:"source_id='source_org_a'";
    const current=(await admin.query(`SELECT * FROM pactwoven.${table} WHERE ${filter}`)).rows[0];
    let sql:string,values:unknown[];
    if(kind==='site'){sql="SELECT pactwoven.financial_update_site_control('development','org_a','site_a',0,$1,'Site A','America/Chicago',false)";values=[current.record_hash];}
    else if(kind==='binding'){sql="SELECT pactwoven.financial_update_source_binding_control('source_org_a',$1,0,$2,false,null)";values=[accountA,current.control_hash];}
    else {sql=`SELECT pactwoven.financial_update_${kind}_control($1,0,$2,1,false,null)`;values=[kind==='asset'?assetKey:kind==='account'?accountA:'source_org_a',current.control_hash];}
    await holder.query('BEGIN');await waiter.query('BEGIN');await holder.query(sql,values);
    const pending=queryOutcome(waiter.query(sql,values));await waitForFinancialFenceBlock(admin,waiterPid,holderPid);await holder.query('COMMIT');
    const result=await pending;expect(result.ok).toBe(false);if(!result.ok)expect(result.error.code).toBe('FA002');
  });
  it('fails row-first trusted maintenance promptly instead of waiting backwards for an organization',async()=>{
    fixture=await financialFenceFixture();const holder=await client(fixture.admin),raw=await client(fixture.admin);
    await holder.query('BEGIN');await holder.query("SELECT id FROM pactwoven.organizations WHERE id='org_a' FOR UPDATE");
    await raw.query('BEGIN');
    await expect(raw.query("UPDATE pactwoven.sites SET name='Wrong lock order' WHERE id='site_a'")).rejects.toMatchObject({code:'55P03'});
    await raw.query('ROLLBACK');await raw.query('BEGIN');
    await expect(raw.query("UPDATE pactwoven.responsibilities SET row_version=row_version+1,title='Wrong lock order' WHERE id='responsibility_a'")).rejects.toMatchObject({code:'55P03'});
  });
  it('shares the original organization epoch with a real member-access revocation',async()=>{
    fixture=await financialFenceFixture();const revoker=await client(fixture.access.pool),reader=await client(fixture.mandate.pool),revokerPid=await fenceBackendPid(revoker),readerPid=await fenceBackendPid(reader);
    const identity=fenceIdentity('owner_a'),issued=Math.floor(Date.now()/1000)*1000;
    const proof:VerifiedStepUpIdentity={identity,evidence:{id:crypto.randomUUID(),purpose:'member_access',subject:identity.subject,externalOrganizationId:identity.externalOrganizationId,
      externalMembershipId:identity.externalMembershipId,sessionId:identity.sessionId,issuer:'https://fixture.clerk.accounts.dev',tokenHash:'a'.repeat(64),
      tokenIssuedAt:new Date(issued).toISOString(),firstFactorAgeMinutes:0,secondFactorAgeMinutes:0,verifiedAt:new Date(issued-60_000).toISOString(),observedAt:new Date().toISOString(),expiresAt:new Date(issued+60_000).toISOString()}};
    await revoker.query('BEGIN');await reader.query('BEGIN');
    const operation=await new PostgresAccessRepository(revoker as unknown as Pool,'development').changeAccess(proof,'fa0_access_revoke_0001',{
      kind:'revoke',actorId:'finance_a',target:null,command:{expectedVersion:1,mandateVersion:null,authorityEpoch:2,payload:{reason:'FA-0 revocation interleaving'}}},'fa0_access');
    expect(operation.status).toBe('succeeded');
    const pending=queryOutcome(reader.query("SELECT pactwoven.mandate_resolve_context('development',$1::jsonb,'responsibility_a',true,'wait')",[JSON.stringify(fenceIdentity())]));
    await waitForFinancialFenceBlock(fixture.admin,readerPid,revokerPid);await revoker.query('COMMIT');
    const result=await pending;expect(result.ok).toBe(false);if(!result.ok)expect(result.error.code).toBe('PM001');
    expect((await fixture.admin.query("SELECT authority_epoch FROM pactwoven.organizations WHERE id='org_a'")).rows[0].authority_epoch).toBe(3);
    expect((await fixture.admin.query('SELECT generation FROM pactwoven.financial_authority_fences')).rows[0].generation).toBe(0);
  });
});
