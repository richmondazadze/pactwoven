import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { Socket } from 'node:net';
import { TLSSocket } from 'node:tls';
import { Pool, type PoolClient, type PoolConfig } from 'pg';
import { financialPolicyHttpRequestFromStoredCommand, financialPolicyHttpRequestHash } from '@pactwoven/domain';
import type { FinancialPolicyCommand } from '@pactwoven/contracts';
import type { FinancialAuthEvidence } from './financial-auth-evidence.js';
import { loadMigrations } from './migrate.js';
import { observerMigrationPins } from './supplier-observer-fixture-admission.js';
import { assertFinancialAuthorityConnection, assertFinancialPolicyClosureConnection } from './financial-authority-pool.js';
import { PostgresFinancialAuthenticationRepository } from './financial-authentication-repository.js';
import { PostgresFinancialPolicyRepository } from './financial-policy-repository.js';
import { PostgresFinancialPolicyReaders } from './financial-policy-read-repository.js';
import { PostgresFinancialPolicyClosureRepository } from './financial-policy-closure-repository.js';
import type { FinancialPolicyOriginalClosureIntent } from './financial-policy-closure-schema.js';

export const closureFixtureVariable='PACTWOVEN_FINANCIAL_POLICY_CLOSURE_TEST_ADMIN_URL_FILE';
export const closureConsentVariable='PACTWOVEN_FINANCIAL_POLICY_CLOSURE_DISPOSABLE';
export const closureFixtureEnabled=Boolean(process.env[closureFixtureVariable]||process.env[closureConsentVariable]);
export const closureFixturePort=55443,closureFixtureDatabase='pactwoven_financial_policy_closure_test';
export function closureFixtureConfig(value:string):PoolConfig {
 const u=new URL(value),user=decodeURIComponent(u.username),password=decodeURIComponent(u.password);
 if(!['postgres:','postgresql:'].includes(u.protocol)||u.hostname!=='127.0.0.1'||u.port!==String(closureFixturePort)||u.pathname!==`/${closureFixtureDatabase}`||u.search||u.hash||
  user!=='financial_policy_closure_fixture_admin'||!password||password.includes('\0'))throw Error('Exact new local closure fixture required.');
 return {host:'127.0.0.1',port:closureFixturePort,database:closureFixtureDatabase,user,password,ssl:false,max:3,connectionTimeoutMillis:3000,
  statement_timeout:10000,idle_in_transaction_session_timeout:8000,options:'-c transaction_timeout=15s',application_name:'financial-closure-disposable-test'};
}
export async function readClosureFixtureConfig(environment:NodeJS.ProcessEnv=process.env) {
 const path=environment[closureFixtureVariable],uid=process.getuid?.();
 if(!path||!isAbsolute(path)||environment[closureConsentVariable]!=='YES_NEW_LOCAL_ONLY'||Object.keys(environment).some(k=>k.startsWith('PG')||k.startsWith('PACTWOVEN_')&&![closureFixtureVariable,closureConsentVariable].includes(k)))
  throw Error('Explicit closure-only admission and scrubbed environment required.');
 const before=await lstat(path);
 if(uid===undefined||uid===0||!before.isFile()||before.isSymbolicLink()||before.uid!==uid||(before.mode&0o777)!==0o600||before.size<1||before.size>8192)throw Error('Private owned closure credential file required.');
 const fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const actual=await fd.stat();if(actual.dev!==before.dev||actual.ino!==before.ino||actual.uid!==uid||!actual.isFile()||(actual.mode&0o777)!==0o600||actual.size!==before.size)throw Error('Closure credential changed.');
  const value=await fd.readFile('utf8'),after=await fd.stat(),named=await lstat(path);
  if(after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs||named.dev!==after.dev||named.ino!==after.ino||named.isSymbolicLink())throw Error('Closure credential changed during read.');
  return closureFixtureConfig(value.trim());
 }finally{await fd.close();}
}
export async function assertClosureSocket(client:PoolClient,config:PoolConfig) {
 const stream=(client as PoolClient&{connection?:{stream?:unknown}}).connection?.stream;
 if(!(stream instanceof Socket)||stream instanceof TLSSocket||stream.destroyed||stream.readyState!=='open'||stream.remotePort!==closureFixturePort||!['127.0.0.1','::ffff:127.0.0.1'].includes(stream.remoteAddress??''))throw Error('Exact closure loopback socket required.');
 const r=(await client.query("SELECT current_database() AS database,current_user AS principal,session_user AS session,current_setting('server_version_num')::int AS version")).rows[0];
 if(r.database!==closureFixtureDatabase||r.principal!==config.user||r.session!==config.user||![170011,170012].includes(r.version))throw Error('Exact closure fixture server and login required.');
}
const ident=(s:string)=>'"'+s.replaceAll('"','""')+'"',literal=(s:string)=>"'"+s.replaceAll("'","''")+"'";
export async function financialPolicyClosureFixture() {
 const config=await readClosureFixtureConfig(),admin=new Pool(config),pools:Pool[]=[admin],historical:{migration:number;base:boolean;closure:boolean}[]=[];
 let counter=0;
 try {
  const a=await admin.connect();try{await assertClosureSocket(a,config);
   const r=(await a.query("SELECT r.oid,r.rolsuper,(SELECT count(*)::int FROM pg_namespace WHERE nspname='pactwoven') AS schemas,(SELECT count(*)::int FROM pg_roles WHERE rolname LIKE 'pactwoven_%') AS roles FROM pg_roles r WHERE rolname=SESSION_USER")).rows[0];
   if(r.oid!==10||!r.rolsuper||r.schemas!==0||r.roles!==0)throw Error('A completely new dedicated cluster is required; retained fixtures are never reset.');
  }finally{a.release();}
  const secret=randomBytes(32).toString('base64url'),ownerName='pactwoven_closure_fixture_owner';
  await admin.query(`CREATE ROLE ${ident(ownerName)} LOGIN INHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB CREATEROLE NOREPLICATION PASSWORD ${literal(secret)}`);
  await admin.query(`GRANT CREATE ON DATABASE ${ident(closureFixtureDatabase)} TO ${ident(ownerName)}`);
  const owner=new Pool({...config,user:ownerName,password:secret});pools.push(owner);
  const migrations=(await loadMigrations()).slice(0,19);
  const pins=[...observerMigrationPins,['0017_managed_postgres_qualification.sql','5889ae41058e87e5242370ce0a1bfd599a6403ec89a9ece64bf56d01184c6013'],
   ['0018_bootstrap_site_read_grant.sql','901dda475616a04408db613efb69b7bd22f1a04ad8cc983afb47afca0f41ed55']];
  if(migrations.length!==19||migrations[18]?.filename!=='0019_financial_policy_request_fences.sql'||migrations.slice(0,18).some((m,i)=>m.number!==i+1||m.filename!==pins[i]?.[0]||m.checksum!==pins[i]?.[1]))throw Error('Exact historical migrations and assigned closure migration required.');
  const login=async(label:string,group:string|null)=>{const role=`pactwoven_closure_${label}`,password=randomBytes(32).toString('base64url');
   await owner.query(`CREATE ROLE ${ident(role)} LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD ${literal(password)}`);
   if(group)await owner.query(`GRANT ${ident(group)} TO ${ident(role)} WITH ADMIN FALSE, INHERIT TRUE, SET TRUE`);
   const pool=new Pool({...config,user:role,password});pools.push(pool);return {role,pool};};
  let authorizer!:Awaited<ReturnType<typeof login>>,verifier!:Awaited<ReturnType<typeof login>>,stranger!:Awaited<ReturnType<typeof login>>;
  for(const m of migrations){const c=await owner.connect();try{await c.query('BEGIN');for(const sql of m.statements){const query={text:sql,queryMode:'extended'};await c.query(query);}await c.query('COMMIT');}
   catch(error){await c.query('ROLLBACK');throw Error(`Closure fixture migration ${m.number} failed`,{cause:error});}finally{c.release();}
   if(m.number===14){authorizer=await login('authorizer','pactwoven_financial_authorizer');verifier=await login('verifier','pactwoven_financial_verifier');stranger=await login('stranger',null);}
   if([14,17,19].includes(m.number)){const c=await authorizer.pool.connect();try{await c.query('BEGIN ISOLATION LEVEL READ COMMITTED');await assertFinancialAuthorityConnection(c,'authorizer');
    let closure=true;try{await assertFinancialPolicyClosureConnection(c);}catch{closure=false;}
    historical.push({migration:m.number,base:true,closure});await c.query('ROLLBACK');}finally{c.release();}}
  }
  await admin.query(`REVOKE CREATE ON DATABASE ${ident(closureFixtureDatabase)} FROM ${ident(ownerName)}`);
  const authentication=new PostgresFinancialAuthenticationRepository(verifier.pool),repository=new PostgresFinancialPolicyRepository(authorizer.pool),
   readers=new PostgresFinancialPolicyReaders(authorizer.pool,verifier.pool),closures=new PostgresFinancialPolicyClosureRepository(authorizer.pool);
  const createCase=async()=>{
   const organizationId=`closure_org_${++counter}`,externalOrganizationId=`external_${organizationId}`,rid='responsibility_a',siteId='site_a';
   await admin.query("INSERT INTO pactwoven.organizations(environment,id,external_organization_id,name,authority_epoch) VALUES('development',$1,$2,'Synthetic closure fixture',2)",[organizationId,externalOrganizationId]);
   for(const [actor,roles] of [['owner_a',['owner']],['owner_b',['owner']],['finance_a',['finance']],['operations_a',['operations']]] as const)
    await admin.query("INSERT INTO pactwoven.memberships(environment,organization_id,actor_id,external_subject,external_membership_id,roles,grant_basis) VALUES('development',$1,$2,$2,$3,$4,'internal')",[organizationId,actor,`membership_${organizationId}_${actor}`,roles]);
   await admin.query("INSERT INTO pactwoven.sites VALUES('development',$1,$2,'Synthetic closure site','America/Chicago')",[organizationId,siteId]);
   await admin.query("INSERT INTO pactwoven.site_memberships SELECT environment,organization_id,actor_id,$2 FROM pactwoven.memberships WHERE organization_id=$1",[organizationId,siteId]);
   await admin.query("INSERT INTO pactwoven.member_action_sites SELECT environment,organization_id,actor_id,$2 FROM pactwoven.memberships WHERE organization_id=$1",[organizationId,siteId]);
   await admin.query("INSERT INTO pactwoven.responsibilities(environment,organization_id,id,owner_id,site_id,title,description,starts_at,ends_at,time_zone,requirements,acceptance_policy) VALUES('development',$1,$2,'owner_a',$3,'Closure test','',now(),now()+interval '2 days','UTC','[]','No effective authority')",[organizationId,rid,siteId]);
   for(const [role,cap] of [[authorizer.role,'authorizer'],[verifier.role,'verifier']])await admin.query("INSERT INTO pactwoven.financial_policy_principals SELECT oid,rolname,'development',$1,$2,1,true,now()+interval '1 day' FROM pg_roles WHERE rolname=$3",[organizationId,cap,role]);
   const identity=async(actorId='owner_a')=>{const row=(await admin.query("SELECT row_version FROM pactwoven.memberships WHERE environment='development' AND organization_id=$1 AND actor_id=$2",[organizationId,actorId])).rows[0];
    const now=Date.now(),iso=(n:number)=>new Date(n).toISOString(),e:FinancialAuthEvidence={schemaVersion:1,id:crypto.randomUUID(),environment:'development',organizationId,kind:'identity',purpose:'financial_policy_observation',
     actor:{actorId,membershipVersion:row.row_version,subject:actorId,externalMembershipId:`membership_${organizationId}_${actorId}`,sessionId:`session_${actorId}_${organizationId}`},
     observedAt:iso(now),expiresAt:iso(now+240000),sessionExpiresAt:iso(now+240000),externalOrganizationId,externalRole:'org:admin',issuer:'https://synthetic.invalid',tokenHash:'a'.repeat(64),tokenIssuedAt:iso(now-1000)};
    await authentication.append(e);const scope=await readers.resolveObserver('development',{identity:{subject:actorId,externalOrganizationId,externalOrganizationName:'Synthetic closure fixture',externalMembershipId:e.actor.externalMembershipId,
     externalRole:e.externalRole,sessionId:e.actor.sessionId,membershipObservedAt:e.observedAt,authenticatedAt:e.tokenIssuedAt},observation:{issuer:e.issuer,tokenHash:e.tokenHash,tokenIssuedAt:e.tokenIssuedAt,observedAt:e.observedAt,expiresAt:e.expiresAt}});
    return {evidence:e,scope};};
   const document=(id=`document_${crypto.randomUUID()}`,responsibilityId:string|null=rid):FinancialPolicyCommand=>({schemaVersion:1,environment:'development',organizationId,responsibilityId,kind:'save_document',id,key:`original_${crypto.randomUUID()}`,previous:null,organizationEpoch:2,
    purpose:responsibilityId?'financial_mandate':'budget_policy',text:'Exact synthetic original text. No spending authority.'});
   const prepare=async(command:FinancialPolicyCommand=document(),actorId='owner_a')=>{const auth=await identity(actorId),context=await readers.context(auth.evidence.id,auth.scope,{responsibilityId:command.responsibilityId,assetKey:null,documents:[]});
    const request=await financialPolicyHttpRequestFromStoredCommand({environment:'development',organizationId,actorId},command),locator={responsibilityId:command.responsibilityId,kind:command.kind as 'save_document'|'save_draft',key:command.key,targetId:command.id,
     publicRequestHash:await financialPolicyHttpRequestHash({environment:'development',organizationId,actorId},request)};
    const intent:FinancialPolicyOriginalClosureIntent={schemaVersion:1,purpose:'financial_policy_original_close',reason:'original_input_unavailable',locator,expected:{organizationEpoch:auth.scope.organizationEpoch,draftScope:context.draftScope}};
    return {...auth,command,locator,intent};};
   return {organizationId,externalOrganizationId,rid,siteId,identity,document,prepare};
  };
  return {admin,owner,authorizer,verifier,stranger,repository,authentication,readers,closures,historical,createCase,close:async()=>{for(const p of pools.reverse())await p.end();}};
 }catch(error){for(const p of pools.reverse())await p.end();throw error;}
}
export type FinancialPolicyClosureFixture=Awaited<ReturnType<typeof financialPolicyClosureFixture>>;
