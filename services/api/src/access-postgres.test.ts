import {readFile} from 'node:fs/promises';
import {describe,it,expect} from 'vitest';
import {createRuntimePool,createProvisionerPool,createAccessPool,PostgresAccessRepository,PostgresOrganizationProvisioner,PostgresFoundationRepository,assertAccessPool,assertProvisionerPool,assertRuntimePool,type VerifiedIdentity,type VerifiedStepUpIdentity} from '@pactwoven/db';
import {createAccessGateway} from './access-service.js';
import {createApp} from './app.js';
const suite=process.env.PACTWOVEN_RUN_ACCESS_DB_TESTS==='1'?describe:describe.skip;
suite('API to real PostgreSQL access path — no schema reset',()=>{
 it('grants an accepted member through gateway, scope validation, database function and recovery route',async()=>{
  const names=['PACTWOVEN_TEST_DATABASE_URL_FILE','PACTWOVEN_TEST_PROVISIONER_DATABASE_URL_FILE','PACTWOVEN_TEST_ACCESS_DATABASE_URL_FILE'];
  const pools:Awaited<ReturnType<typeof createRuntimePool>>[]=[];
  const factories=[createRuntimePool,createProvisionerPool,createAccessPool];
  try {
   for(const name of names){const file=process.env[name];if(!file)throw new Error('Protected test DSN required');const url=new URL((await readFile(file,'utf8')).trim());
    if(url.pathname!='/pactwoven_backend_test'||!['127.0.0.1','localhost'].includes(url.hostname))throw new Error('Dedicated disposable database required');pools.push(await factories[pools.length]!(url.href));}
   await assertRuntimePool(pools[0]!);await assertProvisionerPool(pools[1]!);await assertAccessPool(pools[2]!);
   const suffix=crypto.randomUUID().replaceAll('-','');
   const identity:VerifiedIdentity={subject:`owner_${suffix}`,externalOrganizationId:`org_${suffix}`,externalOrganizationName:'API access fixture',externalMembershipId:`membership_owner_${suffix}`,externalRole:'org:admin',sessionId:`session_${suffix}`,authenticatedAt:new Date(Date.now()-3600000).toISOString(),membershipObservedAt:new Date().toISOString()};
   const provisioner=new PostgresOrganizationProvisioner(pools[1]!,'development');
   await provisioner.bootstrapOrganization(identity,`bootstrap_${suffix}`,{expectedVersion:0,mandateVersion:null,authorityEpoch:null,payload:{initialSite:{name:'Test site',timeZone:'UTC'}}},'fixture_trace');
   const foundation=new PostgresFoundationRepository(pools[0]!,'development');const session=await foundation.getSession(identity,'fixture_trace');
   const candidate={externalOrganizationId:identity.externalOrganizationId,externalSubject:`finance_${suffix}`,externalMembershipId:`membership_finance_${suffix}`,externalRole:'org:member',displayName:'Accepted finance fixture',observedAt:new Date().toISOString()};
   const currentIdentity=()=>({...identity,membershipObservedAt:new Date().toISOString()});
   const verifyStepUp=async():Promise<VerifiedStepUpIdentity>=>{const iat=Math.floor(Date.now()/1000)*1000;return{identity:currentIdentity(),evidence:{id:crypto.randomUUID(),purpose:'member_access',subject:identity.subject,externalOrganizationId:identity.externalOrganizationId,externalMembershipId:identity.externalMembershipId,sessionId:identity.sessionId,issuer:'https://fixture.clerk.accounts.dev',tokenHash:'b'.repeat(64),tokenIssuedAt:new Date(iat).toISOString(),firstFactorAgeMinutes:0,secondFactorAgeMinutes:0,verifiedAt:new Date(iat-60000).toISOString(),observedAt:new Date().toISOString(),expiresAt:new Date(iat+60000).toISOString()}};};
   const repository=new PostgresAccessRepository(pools[2]!,'development');
   const gateway=createAccessGateway({repository,verifyIdentity:async()=>currentIdentity(),verifyStepUp,directory:{list:async()=>({items:[candidate],nextCursor:null,observedAt:new Date().toISOString()}),resolve:async()=>({...candidate,observedAt:new Date().toISOString()})}});
   const app=createApp({allowedOrigins:['http://localhost:3001'],verifyIdentity:async()=>currentIdentity(),accessGateway:gateway});
   const key=`grant_${suffix}`,headers={Authorization:'Bearer test-only-identity-evidence',Origin:'http://localhost:3001','Content-Type':'application/json','Idempotency-Key':key};
   const command={expectedVersion:0,authorityEpoch:0,mandateVersion:null,payload:{externalMembershipId:candidate.externalMembershipId,externalSubject:candidate.externalSubject,roles:['finance'],siteIds:[],actionSiteIds:[session.sites[0]!.id],expiresAt:null}};
   const response=await app.request('/v1/members/grant',{method:'POST',headers,body:JSON.stringify(command)});expect(response.status).toBe(201);const operation=await response.json();
   expect(operation.status).toBe('succeeded');const recovery=await app.request(`/v1/member-access/operations?kind=grant&key=${key}`,{headers});expect(await recovery.json()).toEqual(operation);
   const finance=await foundation.getSession({...currentIdentity(),subject:candidate.externalSubject,externalMembershipId:candidate.externalMembershipId,externalRole:'org:member',sessionId:`finance_session_${suffix}`},'fixture_trace');
   expect(finance.actor.roles).toEqual(['finance']);expect(finance.actor.actionSiteIds).toEqual([session.sites[0]!.id]);
  } finally {await Promise.all(pools.map(pool=>pool.end()));}
 });
});
