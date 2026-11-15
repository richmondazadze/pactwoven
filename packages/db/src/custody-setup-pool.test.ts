import {Socket} from 'node:net';
import {TLSSocket} from 'node:tls';
import type {PoolClient} from 'pg';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {custodyFixture,custodyFixtureEnabled,custodyFixtureConfig,custodyFixtureEnvironment,assertCustodyFixture,type CustodyFixture} from './custody-setup.test-support.js';
import {assertCustodySetupPool} from './custody-setup-pool.js';
const syntheticFixtureUrl=(input:string,user='fixture',password='synthetic')=>{const url=new URL(input);url.username=user;url.password=password;return url.href;};
const fixtureUrl=(port=55439)=>syntheticFixtureUrl(`postgres://127.0.0.1:${port}/pactwoven_custody_setup_test`);
describe('custody fixture containment',()=>{
 afterEach(()=>vi.unstubAllEnvs());
 it('rejects normal databases, remote hosts, TLS overrides and unrelated ports',()=>{for(const url of [syntheticFixtureUrl('postgres://127.0.0.1:55439/pactwoven_dev'),syntheticFixtureUrl('postgres://localhost:55439/pactwoven_custody_setup_test'),syntheticFixtureUrl('postgres://127.0.0.1:5432/pactwoven_custody_setup_test'),syntheticFixtureUrl('postgres://127.0.0.1:55439/pactwoven_custody_setup_test?host=elsewhere')])expect(()=>custodyFixtureConfig(url)).toThrow();});
 it('scrubs inherited PG and product credentials from the test process',()=>expect(custodyFixtureEnvironment({PGHOST:'elsewhere',PGPASSWORD:'synthetic',PACTWOVEN_API:'synthetic',PATH:'/bin'})).toEqual({PATH:'/bin'}));
 it.each(['postgres','postgresql'])('retains the fixed local %s transport and allows CI only with both exact flags',protocol=>{
  const target=fixtureUrl(55440).replace('postgres:',protocol+':');
  expect(custodyFixtureConfig(fixtureUrl(),{})).toMatchObject({host:'127.0.0.1',port:55439,database:'pactwoven_custody_setup_test',ssl:false});
  expect(custodyFixtureConfig(target,{CI:'true',GITHUB_ACTIONS:'true'})).toEqual({host:'127.0.0.1',port:55440,database:'pactwoven_custody_setup_test',user:'fixture',password:'synthetic',ssl:false,max:8,connectionTimeoutMillis:3000,statement_timeout:10000});
 });
 it.each([{}, {CI:'true'}, {GITHUB_ACTIONS:'true'}, {CI:'false',GITHUB_ACTIONS:'true'}, {CI:'true',GITHUB_ACTIONS:'false'},
  {CI:'1',GITHUB_ACTIONS:'true'}, {CI:'true',GITHUB_ACTIONS:'1'}, {CI:'TRUE',GITHUB_ACTIONS:'true'}, {CI:'true',GITHUB_ACTIONS:'true '}])('rejects CI transport without literal paired flags %j',environment=>{
  expect(()=>custodyFixtureConfig(fixtureUrl(55440),environment)).toThrow();
 });
 it.each(['','5432','55438','55441','65535'])('rejects arbitrary or default port %s even with CI context',port=>{
  expect(()=>custodyFixtureConfig(fixtureUrl().replace(':55439',port?':'+port:''),{CI:'true',GITHUB_ACTIONS:'true'})).toThrow();
 });
 it('retains exact host, database, protocol, query, fragment and credential guards in CI',()=>{
  const target=fixtureUrl(55440);
  for(const url of [target.replace('127.0.0.1','localhost'),target.replace('127.0.0.1','127.0.0.2'),target.replace('127.0.0.1','[::1]'),target.replace('127.0.0.1','remote.test'),
   target.replace('pactwoven_custody_setup_test','pactwoven_dev'),target.replace('/pactwoven_','/%70actwoven_'),target+'/',target+'?host=/tmp',target+'?port=55439',target+'?sslmode=require',target+'?options=-c%20role%3Dpostgres',target+'#other',
   target.replace('postgres:','https:'),target.replace(':synthetic',''),target.replace('fixture:',':'),target.replace('fixture','fixture%00'),target.replace('synthetic','synthetic%00'),target.replace('synthetic','synthetic%zz')])expect(()=>custodyFixtureConfig(url,{CI:'true',GITHUB_ACTIONS:'true'})).toThrow();
 });
 // Unconnected Socket instances model peer metadata; these unit checks open no port.
 const socket=(properties:Record<string,unknown>={},tls=false)=>{const stream=tls?new TLSSocket(new Socket()):new Socket();
  for(const [key,value] of Object.entries({remotePort:55440,remoteAddress:'127.0.0.1',readyState:'open',destroyed:false,...properties}))Object.defineProperty(stream,key,{value,configurable:true});return stream;};
 const client=(stream:unknown,row={database:'pactwoven_custody_setup_test',current:'fixture',session:'fixture'})=>{
  const query=vi.fn().mockResolvedValue({rows:[row]});return{connection:{stream},query} as unknown as PoolClient&{query:typeof query};};
 it.each([55439,55440])('requires actual peer port %s to equal the fixed configured port',async port=>{
  vi.stubEnv('CI','true');vi.stubEnv('GITHUB_ACTIONS','true');const c=client(socket({remotePort:port}));
  await expect(assertCustodyFixture(c,custodyFixtureConfig(fixtureUrl(port)))).resolves.toBeUndefined();expect(c.query).toHaveBeenCalledOnce();
 });
 it.each([{}, {CI:'true'}, {GITHUB_ACTIONS:'true'}, {CI:'TRUE',GITHUB_ACTIONS:'true'}, {CI:'true',GITHUB_ACTIONS:'1'}])('rechecks actual process CI context before querying %j',environment=>{
  vi.stubEnv('CI',environment.CI);vi.stubEnv('GITHUB_ACTIONS',environment.GITHUB_ACTIONS);
  const c=client(socket()),config=custodyFixtureConfig(fixtureUrl(55440),{CI:'true',GITHUB_ACTIONS:'true'});
  return expect(assertCustodyFixture(c,config)).rejects.toThrow('Exact custody socket required.').then(()=>expect(c.query).not.toHaveBeenCalled());
 });
 it('keeps the default local socket independent of CI flags',async()=>{
  vi.stubEnv('CI',undefined);vi.stubEnv('GITHUB_ACTIONS',undefined);
  await expect(assertCustodyFixture(client(socket({remotePort:55439})),custodyFixtureConfig(fixtureUrl()))).resolves.toBeUndefined();
 });
 it.each([{remotePort:55439},{remotePort:55441},{remoteAddress:'127.0.0.2'},{remoteAddress:'::1'},{remoteAddress:undefined},{readyState:'closed'},{destroyed:true}])('rejects mismatched or unavailable peer metadata %j',async properties=>{
  vi.stubEnv('CI','true');vi.stubEnv('GITHUB_ACTIONS','true');const c=client(socket(properties));
  await expect(assertCustodyFixture(c,custodyFixtureConfig(fixtureUrl(55440)))).rejects.toThrow('Exact custody socket required.');expect(c.query).not.toHaveBeenCalled();
 });
 it('rejects a local config reaching the CI peer, non-sockets, TLS and forged config targets',async()=>{
  vi.stubEnv('CI','true');vi.stubEnv('GITHUB_ACTIONS','true');const config=custodyFixtureConfig(fixtureUrl(55440));
  for(const [stream,target] of [[socket(),custodyFixtureConfig(fixtureUrl())],[{},config],[socket({},true),config],[socket(),{...config,host:'localhost'}],[socket(),{...config,database:'pactwoven_dev'}],[socket(),{...config,port:55441}]] as const){
   const c=client(stream);await expect(assertCustodyFixture(c,target)).rejects.toThrow('Exact custody socket required.');expect(c.query).not.toHaveBeenCalled();
  }
 });
 it.each(['database','current','session'] as const)('requires exact queried %s identity after socket validation',async field=>{
  vi.stubEnv('CI','true');vi.stubEnv('GITHUB_ACTIONS','true');const c=client(socket(),{database:'pactwoven_custody_setup_test',current:'fixture',session:'fixture',[field]:'other'});
  await expect(assertCustodyFixture(c,custodyFixtureConfig(fixtureUrl(55440)))).rejects.toThrow('Exact custody database and authenticated principal required.');expect(c.query).toHaveBeenCalledOnce();
 });
});
describe.skipIf(!custodyFixtureEnabled)('custody exact connection privilege gates',()=>{let f:CustodyFixture;beforeEach(async()=>{f=await custodyFixture();},60000);afterEach(async()=>{await f?.close();});
 it('accepts the two separated capabilities and rejects owner/runtime or swapped credentials',async()=>{await expect(assertCustodySetupPool(f.writer.pool,'writer')).resolves.toBeUndefined();await expect(assertCustodySetupPool(f.verifier.pool,'verifier')).resolves.toBeUndefined();for(const [pool,cap] of [[f.admin,'writer'],[f.writer.pool,'verifier'],[f.verifier.pool,'writer']] as const)await expect(assertCustodySetupPool(pool,cap)).rejects.toMatchObject({code:'UNSAFE_DATABASE_ROLE'});});
 it('rejects direct column grants and extra helper execution',async()=>{await f.admin.query(`GRANT SELECT(body) ON pactwoven.custody_setup_evidence TO "${f.writer.role}"`);await expect(assertCustodySetupPool(f.writer.pool,'writer')).rejects.toMatchObject({code:'UNSAFE_DATABASE_ROLE'});await f.admin.query(`REVOKE SELECT(body) ON pactwoven.custody_setup_evidence FROM "${f.writer.role}"`);await f.admin.query(`GRANT EXECUTE ON FUNCTION pactwoven.custody_principal(text,text) TO "${f.writer.role}"`);await expect(assertCustodySetupPool(f.writer.pool,'writer')).rejects.toMatchObject({code:'UNSAFE_DATABASE_ROLE'});});
 it('rejects reachability to forbidden capabilities even with INHERIT FALSE',async()=>{await f.admin.query(`GRANT pactwoven_finance_observer TO "${f.writer.role}" WITH INHERIT FALSE,SET TRUE`);await expect(assertCustodySetupPool(f.writer.pool,'writer')).rejects.toMatchObject({code:'UNSAFE_DATABASE_ROLE'});});
});

// The application capability lists include exactly the dedicated private readers.
import {custodySetupRoutines} from './custody-setup-schema.js';
it('appends only the four exact private reader routines to their matching capabilities',()=>{
 expect(custodySetupRoutines.writer).toEqual(['pactwoven.custody_setup_command(uuid,jsonb)','pactwoven.custody_setup_read(uuid,text,uuid)','pactwoven.custody_setup_recover(uuid,jsonb)',
  'pactwoven.custody_setup_specification_read(uuid,text,jsonb)','pactwoven.custody_setup_record_read(uuid,text,uuid,uuid,text)','pactwoven.custody_setup_original_read(uuid,text,text,text)']);
 expect(custodySetupRoutines.verifier).toEqual(['pactwoven.custody_setup_attest(jsonb)','pactwoven.custody_setup_resolve_owner(jsonb,text)']);
});
