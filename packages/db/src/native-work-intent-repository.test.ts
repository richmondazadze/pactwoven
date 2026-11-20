import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import type { ActorContext } from '../../contracts/src/core';
import { PostgresNativeWorkIntentRepository } from './native-work-intent-repository';
const actor:ActorContext={environment:'development',organizationId:'org_one',actorId:'actor_one',principalKind:'human',roles:['owner'],siteIds:['site_one'],actionSiteIds:['site_one'],sessionId:'session_one',authenticatedAt:'2026-11-18T12:00:00.000Z',correlationId:'request_one'};
const input={siteId:'site_one',title:'Compare chairs',prompt:'Compare options.',selections:[],continuesAfterSignOut:true as const};
const key='request_key_original_001';
const response={scope:{environment:'development',organizationId:'org_one',siteId:'site_one'},review:{id:'review_one',token:'a'.repeat(64),preparedAt:'2026-11-18T12:00:00.000Z',confirmBy:'2026-11-18T12:05:00.000Z',expiresAt:'2026-11-19T12:00:00.000Z',body:{title:input.title,prompt:input.prompt,siteName:'Main office',selectedNotes:[],allowedWork:['Research public sources','Draft advice'],continuesAfterSignOut:true,externalEffects:'forbidden'}},operation:null};
const fixture=()=>{const query=vi.fn().mockResolvedValue({rows:[{response}]});return{query,repo:new PostgresNativeWorkIntentRepository({query}as unknown as Pool,'development')};};
describe('work intent repository boundary',()=>{
 it('submits only actor, original key and strict input to one atomic function',async()=>{
  const f=fixture();expect(await f.repo.prepare(actor,key,input)).toEqual(response);expect(f.query).toHaveBeenCalledWith('SELECT pactwoven.native_work_intent_prepare($1::jsonb,$2,$3::jsonb) AS response',[actor,key,input]);
 });
 it('rejects foreign environment without database access',()=>{
  const f=fixture();expect(()=>f.repo.prepare({...actor,environment:'production'},key,input)).toThrow();expect(f.query).not.toHaveBeenCalled();
 });
 it.each(['scope','title','prompt','reviewId'])('rejects misbound %s response',async kind=>{
  const f=fixture(),value=structuredClone(response);
  if(kind==='scope')value.scope.siteId='other';if(kind==='title')value.review.body.title='Unrelated';if(kind==='prompt')value.review.body.prompt='Unrelated';if(kind==='reviewId')value.review.id='';
  f.query.mockResolvedValue({rows:[{response:value}]});await expect(f.repo.prepare(actor,key,input)).rejects.toMatchObject({code:'DURABLE_SERVICE_UNAVAILABLE'});
 });
 it.each([['NW001','FORBIDDEN'],['NW003','IDEMPOTENCY_CONFLICT'],['NW005','REVIEW_CHANGED'],['NW006','REVIEW_EXPIRED'],['NW007','SETUP_REQUIRED'],['08006','DURABLE_SERVICE_UNAVAILABLE']])('maps %s without exposing database text',async(code,expected)=>{
  const f=fixture();f.query.mockRejectedValue({code,message:'private database diagnostics'});await expect(f.repo.prepare(actor,key,input)).rejects.toMatchObject({code:expected});await expect(f.repo.prepare(actor,key,input)).rejects.not.toThrow('private database diagnostics');
 });
 it('passes real observer evidence separately from public confirmation',async()=>{
  const f=fixture(),confirm={reviewId:'review_one',reviewToken:'a'.repeat(64),continuesAfterSignOut:true as const},observation={providerIssuer:'https://test.clerk.accounts.dev',sessionVerifiedAt:'2026-11-18T12:00:00.000Z',sessionExpiresAt:'2026-11-18T12:01:00.000Z'};
  f.query.mockResolvedValue({rows:[{response:{scope:response.scope,id:'op_one',reviewId:'review_one',rootTaskId:'root_one',title:input.title,committedAt:observation.sessionVerifiedAt,expiresAt:response.review.expiresAt,continuesAfterSignOut:true,kind:'delegated_advice'}}]});
  await f.repo.confirm(actor,key,confirm,observation);expect(f.query.mock.calls[0]?.[1]).toEqual([actor,key,confirm,observation]);
 });
 it('recovers the exact original operation without reconstructing a withheld review',async()=>{
  const f=fixture(),operation={scope:response.scope,id:'op_one',reviewId:'review_one',rootTaskId:'root_one',title:input.title,committedAt:response.review.preparedAt,expiresAt:response.review.expiresAt,continuesAfterSignOut:true,kind:'delegated_advice'};
  const recovered={scope:response.scope,review:null,operation,reviewUnavailable:true};
  f.query.mockResolvedValue({rows:[{response:recovered}]});expect(await f.repo.recover(actor,input.siteId,key)).toEqual(recovered);
  f.query.mockResolvedValue({rows:[{response:{...recovered,review:response.review}}]});await expect(f.repo.recover(actor,input.siteId,key)).rejects.toMatchObject({code:'DURABLE_SERVICE_UNAVAILABLE'});
 });
});
