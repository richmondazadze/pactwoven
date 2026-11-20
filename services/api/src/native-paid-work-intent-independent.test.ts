import { createHash } from 'node:crypto';
import { commandDigest } from '../../../packages/contracts/src/canonical';
import { describe, expect, it, vi } from 'vitest';
import type { Session } from '@pactwoven/contracts';
import type { FoundationRepository } from '@pactwoven/db';
import type { ClerkIdentityObservation } from './auth';
import { createApp } from './app';
import { createNativeHttpHandler } from '../../native-api/src/http';

const origin='https://pactwoven.vercel.app',key='original_paid_work_request';
const headers={Authorization:'Bearer synthetic',Origin:origin,'Content-Type':'application/json','Idempotency-Key':key};
async function fixture(configured=true){
  const now=Date.now(),at=new Date(now).toISOString();
  const scope={environment:'development' as const,organizationId:'org',siteId:'site'};
  const session:Session={actor:{actorId:'human',principalKind:'human',organizationId:'org',environment:'development',roles:['owner'],siteIds:['site'],actionSiteIds:['site'],sessionId:'session',authenticatedAt:at,correlationId:'test'},organization:{id:'org',name:'Company',authorityEpoch:1},sites:[{id:'site',name:'Office',timeZone:'America/Chicago'}]};
  const observation:ClerkIdentityObservation={identity:{subject:'external',externalOrganizationId:'org_external',sessionId:'session',externalOrganizationName:'Company',externalMembershipId:'member',externalRole:'org:admin',authenticatedAt:at,membershipObservedAt:at},observation:{issuer:'https://pactwoven.clerk.accounts.dev',tokenHash:'a'.repeat(64),tokenIssuedAt:at,observedAt:at,expiresAt:new Date(now+60000).toISOString()}};
  const policy={serviceId:'equipment_optimizer_v1' as const,maximumComputationBaseUnits:'10000',maximumFeeLamports:'10000',authorization:'separate_quote_required' as const};
  const paidPolicy={...policy,policyReviewHash:createHash('sha256').update(JSON.stringify({namespace:'pactwoven.paid-intent-review.v1',policy:{authorization:policy.authorization,maximumComputationBaseUnits:policy.maximumComputationBaseUnits,maximumFeeLamports:policy.maximumFeeLamports,serviceId:policy.serviceId},workReviewId:'review',workReviewToken:'b'.repeat(64)})).digest('hex')};
  const work={siteId:'site',title:'Workshop',prompt:'Compare equipment for the workshop.',selections:[],continuesAfterSignOut:true as const};
  const review={id:'review',token:'b'.repeat(64),preparedAt:at,confirmBy:new Date(now+300000).toISOString(),expiresAt:new Date(now+86400000).toISOString(),body:{title:work.title,prompt:work.prompt,siteName:'Office',selectedNotes:[],allowedWork:['Research public sources','Draft advice'],continuesAfterSignOut:true,externalEffects:'forbidden'}};
  const operation={scope,id:'operation',reviewId:'review',rootTaskId:'root',title:work.title,committedAt:at,expiresAt:review.expiresAt,continuesAfterSignOut:true,kind:'delegated_advice'};
  const prepared={work:{scope,review,operation:null},paidPolicy};
  const confirmed={work:operation,paidPolicy};
  const recovered={work:{scope,review,operation,reviewUnavailable:false},paidPolicy};
  const repository={prepare:vi.fn(async()=>prepared),confirm:vi.fn(async()=>confirmed),recover:vi.fn(async()=>recovered)};
  const foundation={getSession:vi.fn(async()=>session)} as unknown as FoundationRepository;
  const verify=vi.fn(async()=>observation);
  const app=createApp({allowedOrigins:[origin],repository:foundation,verifyObservedIdentity:verify,
    nativePaidWorkOrganizationId:'org', nativePaidWorkIntentRepository:repository as never,...configured?{nativePaidWorkPolicy:policy}:{}},{surface:'native'});
  const post=(path:string,body:unknown,custom=headers)=>app.request('/v1/agent-work/paid/'+path,{method:'POST',headers:custom,body:JSON.stringify(body)});
  const input={work,paidPolicy:policy};const confirm={work:{reviewId:'review',reviewToken:review.token,continuesAfterSignOut:true},policyReviewHash:paidPolicy.policyReviewHash};
  return {app,post,repository,verify,session,observation,policy,paidPolicy,prepared,confirmed,recovered,input,confirm};
}
describe('independent paid intent policy binding',()=>{
 it('accepts exact canonical review-policy hash',async()=>{const f=await fixture();expect((await f.post('prepare',f.input)).status).toBe(200);expect((await f.post('confirm',f.confirm)).status).toBe(200);});
 it('rejects substituted prepare policy review hash',async()=>{const f=await fixture();f.prepared.paidPolicy.policyReviewHash='f'.repeat(64);expect((await f.post('prepare',f.input)).status).toBe(503);});
 it('rejects changed confirmed ceilings under unchanged review hash',async()=>{const f=await fixture();f.confirmed.paidPolicy.maximumFeeLamports='20000';expect((await f.post('confirm',f.confirm)).status).toBe(503);});
 it('rejects changed recovered ceilings under unchanged review hash',async()=>{const f=await fixture();f.recovered.paidPolicy.maximumComputationBaseUnits='20000';expect((await f.app.request('/v1/agent-work/paid/operations/'+key+'?siteId=site',{headers})).status).toBe(503);});
 it('rejects lost paid policy when source review is unavailable but original root exists',async()=>{const f=await fixture();Object.assign(f.recovered,{work:{...f.recovered.work,review:null,reviewUnavailable:true},paidPolicy:null});expect((await f.app.request('/v1/agent-work/paid/operations/'+key+'?siteId=site',{headers})).status).toBe(503);});
 it('preserves original policy recovery after configuration is disabled',async()=>{const f=await fixture(false);const response=await f.app.request('/v1/agent-work/paid/operations/'+key+'?siteId=site',{headers});expect(response.status).toBe(200);expect((await response.json()).paidPolicy).toEqual(f.paidPolicy);});
 it('hides paid options for another organization and blocks both write ports',async()=>{const f=await fixture();f.session.actor.organizationId='other_org';f.session.organization.id='other_org';const options=await f.app.request('/v1/agent-work/paid/options',{headers});expect(options.status).toBe(200);expect(await options.json()).toEqual({enabled:false});expect((await f.post('prepare',f.input)).status).toBe(422);expect((await f.post('confirm',f.confirm)).status).toBe(403);expect(f.repository.prepare).not.toHaveBeenCalled();expect(f.repository.confirm).not.toHaveBeenCalled();});
 it('disabled options prevent new prepared or confirmed paid work',async()=>{const f=await fixture(false);expect(await(await f.app.request('/v1/agent-work/paid/options',{headers})).json()).toEqual({enabled:false});expect((await f.post('prepare',f.input)).status).toBe(503);expect((await f.post('confirm',f.confirm)).status).toBe(503);expect(f.repository.prepare).not.toHaveBeenCalled();expect(f.repository.confirm).not.toHaveBeenCalled();});
 it('never nudges after ambiguous confirmed response',async()=>{const nudge=vi.fn(async()=>undefined),pending:Promise<unknown>[]=[];const handler=createNativeHttpHandler({app:vi.fn(),workApp:async()=>({fetch:async()=>Response.json({error:{code:'DURABLE_SERVICE_UNAVAILABLE'}},{status:503})}),nudge,defer:p=>pending.push(p)});const response=await handler(new Request('https://native.example/v1/agent-work/paid/confirm',{method:'POST'}));await Promise.all(pending);expect(response.status).toBe(503);expect(nudge).not.toHaveBeenCalled();});
});
