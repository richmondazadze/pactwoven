import {describe,expect,it,vi} from 'vitest';
import type {AccessRepository,VerifiedIdentity,VerifiedStepUpIdentity} from '@pactwoven/db';
import type {GrantAccessCommand,MemberCandidate,MemberAccess,Operation} from '@pactwoven/contracts';
import {DomainError} from '@pactwoven/domain';
import {createAccessGateway,type MembershipDirectory} from './access-service.js';
import {createApp} from './app.js';
const identity:VerifiedIdentity={subject:'owner_a',externalOrganizationId:'clerk_org',externalOrganizationName:'Test',externalMembershipId:'member_owner',externalRole:'org:admin',sessionId:'session_owner',membershipObservedAt:new Date().toISOString(),authenticatedAt:new Date().toISOString()};
const command:GrantAccessCommand={expectedVersion:0,mandateVersion:null,authorityEpoch:0,payload:{externalSubject:'finance_a',externalMembershipId:'member_finance',roles:['finance'],siteIds:[],actionSiteIds:['site_a'],expiresAt:null}};
const candidate:MemberCandidate={externalOrganizationId:'clerk_org',externalSubject:'finance_a',externalMembershipId:'member_finance',displayName:'Finance',externalRole:'org:member',observedAt:new Date().toISOString()};
const member:MemberAccess={...command.payload,actorId:'actor_finance',displayName:'Finance',status:'active',version:1};
const operation:Operation={id:'operation_a',environment:'development',status:'succeeded',aggregateId:'actor_finance',aggregateVersion:1,financialState:null,evidenceRefs:['history_a'],nextCheckAt:null,error:null};
function fixture(){
 const events:string[]=[];
 const repository:AccessRepository={
  listMembers:vi.fn(async()=>{events.push('owner');return{items:[member],nextCursor:null,authorityEpoch:0,observedAt:new Date().toISOString()};}),
  getMember:vi.fn(async()=>{events.push('member');return member;}),getOperation:vi.fn(async()=>operation),
  changeAccess:vi.fn(async()=>{events.push('write');return operation;}),
 };
 const directory:MembershipDirectory={list:vi.fn(async()=>({items:[candidate],nextCursor:null,observedAt:new Date().toISOString()})),resolve:vi.fn(async()=>{events.push('target');return candidate;})};
 const verifyIdentity=vi.fn(async()=>{events.push('identity');return identity;});
 const verified={identity,evidence:{id:'trusted-proof'}} as unknown as VerifiedStepUpIdentity;
 const verifyStepUp=vi.fn(async()=>{events.push('MFA');return verified;});
 const gateway=createAccessGateway({repository,directory,verifyIdentity,verifyStepUp});
 return{repository,directory,verifyIdentity,verifyStepUp,gateway,events,verified};
}
describe('independent private access gateway',()=>{
 it('checks current owner before target discovery and obtains fresh MFA after provider lookup',async()=>{
  const f=fixture();expect(await f.gateway.grant('signed-original-token','grant_request_key_0001',command,'trace')).toEqual(operation);
  expect(f.events).toEqual(['identity','owner','target','MFA','write']);
  expect(f.repository.changeAccess).toHaveBeenCalledWith(f.verified,'grant_request_key_0001',{kind:'grant',command,target:candidate},'trace');
  expect(f.directory.resolve).toHaveBeenCalledWith(identity,'member_finance','finance_a');
 });
 it('stops before target lookup for a non-owner and never writes on MFA failure',async()=>{
  const f=fixture();vi.mocked(f.repository.listMembers).mockRejectedValueOnce(new DomainError('FORBIDDEN',403,'Denied'));
  await expect(f.gateway.grant('token','grant_request_key_0001',command,'trace')).rejects.toMatchObject({code:'FORBIDDEN'});
  expect(f.directory.resolve).not.toHaveBeenCalled();
  f.verifyStepUp.mockRejectedValueOnce(new DomainError('STEP_UP_REQUIRED',403,'Fresh MFA required'));
  await expect(f.gateway.grant('token','grant_request_key_0001',command,'trace')).rejects.toMatchObject({code:'STEP_UP_REQUIRED'});
  expect(f.repository.changeAccess).not.toHaveBeenCalled();
 });
 it('rechecks owner after candidate discovery and uses pinned member identity when revising',async()=>{
  const f=fixture();vi.mocked(f.repository.listMembers).mockResolvedValueOnce({items:[],nextCursor:null,authorityEpoch:0,observedAt:new Date().toISOString()}).mockRejectedValueOnce(new DomainError('FORBIDDEN',403,'Revoked'));
  await expect(f.gateway.listCandidates('token',{limit:25},'trace')).rejects.toMatchObject({code:'FORBIDDEN'});
  const {externalMembershipId:_membership,externalSubject:_subject,...scope}=command.payload;
  await f.gateway.revise('token','actor_finance','revise_request_key_0001',{expectedVersion:1,authorityEpoch:1,mandateVersion:null,payload:scope},'trace');
  expect(f.directory.resolve).toHaveBeenCalledWith(identity,member.externalMembershipId,member.externalSubject);
 });
 it('routes strict public commands only through the original-token gateway and supports safe recovery reads',async()=>{
  const f=fixture(),app=createApp({allowedOrigins:['http://localhost:3001'],verifyIdentity:f.verifyIdentity,accessGateway:f.gateway});
  const headers={Authorization:'Bearer signed-original-token',Origin:'http://localhost:3001','Content-Type':'application/json','Idempotency-Key':'grant_request_key_0001'};
  const response=await app.request('/v1/members/grant',{method:'POST',headers,body:JSON.stringify(command)});
  expect(response.status).toBe(201);expect(await response.json()).toEqual(operation);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  const recovery=await app.request('/v1/member-access/operations?kind=grant&key=grant_request_key_0001',{headers});expect(recovery.status).toBe(200);
  const bad=await app.request('/v1/members/grant',{method:'POST',headers,body:JSON.stringify({...command,actorId:'attacker'})});expect(bad.status).toBe(422);
  expect(f.repository.changeAccess).toHaveBeenCalledTimes(1);
  f.verifyStepUp.mockRejectedValueOnce(new DomainError('STEP_UP_REQUIRED',403,'Fresh MFA required'));
  expect((await app.request('/v1/members/grant',{method:'POST',headers,body:JSON.stringify(command)})).status).toBe(403);
  expect(f.repository.changeAccess).toHaveBeenCalledTimes(1);
 });
});
