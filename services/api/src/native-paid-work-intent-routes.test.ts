import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Session } from '@pactwoven/contracts';
import type { FoundationRepository } from '@pactwoven/db';
import type { ClerkIdentityObservation } from './auth';
import { createApp } from './app';
import { createNativeHttpHandler } from '../../native-api/src/http';

const origin='https://pactwoven.vercel.app',key='original_paid_work_request';
const headers={Authorization:'Bearer synthetic',Origin:origin,'Content-Type':'application/json','Idempotency-Key':key};
function fixture(configured=true){
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
describe('atomic paid-demo work intent',()=>{
  it('offers only the server-configured planning ceilings',async()=>{
    const f=fixture();const r=await f.app.request('/v1/agent-work/paid/options',{headers});
    expect(r.status).toBe(200);expect(await r.json()).toEqual({enabled:true,paidPolicy:f.policy});expect(r.headers.get('cache-control')).toBe('private, no-store');
    f.session.actor.actionSiteIds=[];expect(await(await f.app.request('/v1/agent-work/paid/options',{headers})).json()).toEqual({enabled:false});
  });
  it('passes original input and key to one atomic preparation',async()=>{
    const f=fixture();expect(await(await f.post('prepare',f.input)).json()).toEqual(f.prepared);
    expect(f.repository.prepare).toHaveBeenCalledExactlyOnceWith(f.session.actor,key,f.input);
  });
  it.each(['maximumComputationBaseUnits','maximumFeeLamports'])('rejects altered %s before storage',async field=>{
    const f=fixture();expect((await f.post('prepare',{...f.input,paidPolicy:{...f.policy,[field]:'20000'}})).status).toBe(422);expect(f.repository.prepare).not.toHaveBeenCalled();
  });
  it('keeps the separate quote requirement mandatory',async()=>{
    const f=fixture();expect((await f.post('prepare',{...f.input,paidPolicy:{...f.policy,authorization:'automatic'}})).status).toBe(422);expect(f.repository.prepare).not.toHaveBeenCalled();
  });
  it('confirms both hashes using only fresh server identity evidence',async()=>{
    const f=fixture();const r=await f.post('confirm',f.confirm);expect(r.status).toBe(200);expect(await r.json()).toEqual(f.confirmed);
    expect(f.repository.confirm).toHaveBeenCalledExactlyOnceWith(f.session.actor,key,f.confirm,{providerIssuer:f.observation.observation.issuer,sessionVerifiedAt:f.observation.observation.observedAt,sessionExpiresAt:f.observation.observation.expiresAt});
  });
  it.each(['stale','future','expired','session'])('rejects %s identity before atomic confirmation',async kind=>{
    const f=fixture();if(kind==='stale')f.observation.observation.observedAt=new Date(Date.now()-21000).toISOString();
    if(kind==='future')f.observation.observation.observedAt=new Date(Date.now()+60000).toISOString();
    if(kind==='expired')f.observation.observation.expiresAt=new Date(Date.now()-1000).toISOString();
    if(kind==='session')f.observation.identity.sessionId='another';
    expect([401,503]).toContain((await f.post('confirm',f.confirm)).status);expect(f.repository.confirm).not.toHaveBeenCalled();
  });
  it('rejects client identity or direct payment authority fields',async()=>{
    const f=fixture();expect((await f.post('confirm',{...f.confirm,observation:f.observation})).status).toBe(422);
    expect((await f.post('confirm',{...f.confirm,approvePayment:true})).status).toBe(422);expect(f.repository.confirm).not.toHaveBeenCalled();
  });
  it('requires recovery when a committed response is misbound',async()=>{
    const f=fixture();f.confirmed.paidPolicy.policyReviewHash='d'.repeat(64);expect((await f.post('confirm',f.confirm)).status).toBe(503);
  });
  it('rejects substituted prepared text and policy',async()=>{
    const f=fixture();f.prepared.work.review.body.prompt='Different request';expect((await f.post('prepare',f.input)).status).toBe(503);
    const g=fixture();g.prepared.paidPolicy.maximumFeeLamports='30000';expect((await g.post('prepare',g.input)).status).toBe(503);
  });
  it('allows original recovery after writes are disabled',async()=>{
    const f=fixture(false);f.session.actor.roles=['auditor'];f.session.actor.actionSiteIds=[];
    const r=await f.app.request('/v1/agent-work/paid/operations/'+key+'?siteId=site',{headers});expect(r.status).toBe(200);expect(await r.json()).toEqual(f.recovered);
    expect((await f.post('prepare',f.input)).status).toBe(403);
  });
  it('rejects missing auth, foreign origin and duplicated site',async()=>{
    const f=fixture();expect((await f.post('prepare',f.input,{...headers,Authorization:''})).status).toBe(401);
    expect((await f.post('prepare',f.input,{...headers,Origin:'https://foreign.invalid'})).status).toBe(403);
    expect((await f.app.request('/v1/agent-work/paid/operations/'+key+'?siteId=site&siteId=other',{headers})).status).toBe(422);expect(f.repository.prepare).not.toHaveBeenCalled();expect(f.repository.recover).not.toHaveBeenCalled();
  });
  it('nudges only after confirmed original-root issuance',async()=>{
    for(const [path,status,wakes] of [['prepare',200,0],['confirm',200,1],['confirm',503,0]] as const){
      const nudge=vi.fn(async()=>undefined),pending:Promise<unknown>[]=[];
      const handler=createNativeHttpHandler({app:vi.fn(),workApp:async()=>({fetch:async()=>Response.json({}, {status})}),nudge,defer:p=>pending.push(p)});
      expect((await handler(new Request('https://native.example/v1/agent-work/paid/'+path,{method:'POST'}))).status).toBe(status);
      await Promise.all(pending);expect(nudge).toHaveBeenCalledTimes(wakes);
    }
  });
});
