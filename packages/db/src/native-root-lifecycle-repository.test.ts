import { describe,expect,it,vi } from 'vitest';
import type { Pool } from 'pg';
import type { ActorContext } from '../../contracts/src/core';
import { PostgresNativeRootCoordinatorRepository,PostgresNativeRootDispatchRepository,PostgresNativeRootRepository } from './native-root-lifecycle-repository';
import { NativeRootCheckpointCommandSchema,NativeRootBindNotesCommandSchema } from './native-root-lifecycle-schema';
const selector={organizationId:'org',taskId:'root',generation:1,handoffId:null,leaseToken:'b8878b4d-a35f-4c5e-8abc-a89174c570bf'};
const checkpoint={requestKey:'checkpoint_intent_1',expectedCheckpointVersion:0,checkpoint:{stage:'planning',summary:'Compare supplies.',steps:[]},plannerState:'{}',inputReceipts:[]};
const actor:ActorContext={environment:'simulation',actorId:'human',organizationId:'org',principalKind:'human',roles:['owner'],siteIds:['site'],actionSiteIds:['site'],sessionId:'session',authenticatedAt:'2026-11-18T00:00:00Z',correlationId:'correlation'};
describe('root lifecycle client boundary',()=>{
 it('bounds inert planner state and refuses arbitrary authority fields',()=>{
  expect(NativeRootCheckpointCommandSchema.safeParse({...checkpoint,plannerState:'x'.repeat(65537)}).success).toBe(false);
  expect(NativeRootCheckpointCommandSchema.safeParse({...checkpoint,authority:{allowed:true}}).success).toBe(false);
  expect(NativeRootCheckpointCommandSchema.safeParse(checkpoint).success).toBe(true);
 });
 it('requires an exact reviewed token for every selected note',()=>{
  expect(NativeRootBindNotesCommandSchema.safeParse({rootTaskId:'root',selections:[{noteId:'note'}]}).success).toBe(false);
  expect(NativeRootBindNotesCommandSchema.safeParse({rootTaskId:'root',selections:[{noteId:'note',expected:'a'.repeat(64)}]}).success).toBe(true);
  expect(NativeRootBindNotesCommandSchema.safeParse({rootTaskId:'root',selections:[],actorId:'forged'}).success).toBe(false);
 });
 it('keeps unknown commit outcomes distinct from a rejected checkpoint',async()=>{
  const query=vi.fn().mockRejectedValue(new Error('Transport ended after possible commit'));
  const repo=new PostgresNativeRootCoordinatorRepository({query} as unknown as Pool,'simulation');
  await expect(repo.checkpoint(selector,NativeRootCheckpointCommandSchema.parse(checkpoint))).rejects.toMatchObject({code:'DURABLE_SERVICE_UNAVAILABLE'});
  expect(query.mock.calls[0]?.[0]).toBe('SELECT pactwoven.native_delegation_root_checkpoint($1,$2::jsonb,$3::jsonb) AS response');
 });
 it('fails closed on extra or malformed stored route material',async()=>{
  const repo=new PostgresNativeRootDispatchRepository({query:vi.fn().mockResolvedValue({rows:[{response:{kind:'root',identity:{serviceId:'coordinator',serviceVersion:1,workloadIdentityId:'workload'},authority:'forged'}}]})} as unknown as Pool,'simulation');
  await expect(repo.route({organizationId:'org',taskId:'root',generation:1})).rejects.toMatchObject({code:'DURABLE_SERVICE_UNAVAILABLE'});
 });
 it('does not send foreign-environment actors to persistence',()=>{
  const query=vi.fn(),repo=new PostgresNativeRootRepository({query} as unknown as Pool,'simulation');
  expect(()=>repo.read({environment:'development',actorId:'human',organizationId:'org',principalKind:'human',roles:['owner'],siteIds:['site'],actionSiteIds:['site'],sessionId:'session',authenticatedAt:'2026-11-18T00:00:00Z',correlationId:'correlation'},'root')).toThrow();
  expect(query).not.toHaveBeenCalled();
 });
 it.each(['scope','id','redaction'] as const)('rejects misbound %s human root projection',async kind=>{
  const view={scope:{environment:'simulation',organizationId:'org',siteId:'site'},id:'root',title:'Supplies',prompt:'Compare supplies.',controlVersion:1,
   updatedAt:'2026-11-18T00:00:00Z',expiresAt:'2026-11-19T00:00:00Z',evidenceUnavailable:false,state:'running',reason:'none',
   checkpointVersion:1,checkpoint:checkpoint.checkpoint,checkpointHistorical:false,attempt:1,attemptLimit:4,generation:1,coverage:[],result:null,domainCompletion:false};
  const query=vi.fn().mockResolvedValue({rows:[{response:view}]}),repo=new PostgresNativeRootRepository({query}as unknown as Pool,'simulation');
  expect(await repo.read(actor,'root')).toEqual(view);
  if(kind==='scope')view.scope.organizationId='foreign';if(kind==='id')view.id='other';if(kind==='redaction')view.evidenceUnavailable=true;
  await expect(repo.read(actor,'root')).rejects.toMatchObject({code:'DURABLE_SERVICE_UNAVAILABLE'});
 });
 it('binds current and recovered controls to their actual organization and task',async()=>{
  const response={scope:{environment:'simulation',organizationId:'org',siteId:'site'},operationId:'b8878b4d-a35f-4c5e-8abc-a89174c570bf',rootTaskId:'root',action:'pause',controlVersion:2,generation:2,state:'paused',committedAt:'2026-11-18T00:00:00Z'};
  const query=vi.fn().mockResolvedValue({rows:[{response}]}),repo=new PostgresNativeRootRepository({query}as unknown as Pool,'simulation'),input={rootTaskId:'root',expectedVersion:1,action:'pause' as const};
  expect(await repo.control(actor,'original_control_key',input)).toEqual(response);expect(await repo.recover(actor,'root','original_control_key')).toEqual(response);
  response.scope.organizationId='foreign';await expect(repo.control(actor,'original_control_key',input)).rejects.toMatchObject({code:'DURABLE_SERVICE_UNAVAILABLE'});
  await expect(repo.recover(actor,'root','original_control_key')).rejects.toMatchObject({code:'DURABLE_SERVICE_UNAVAILABLE'});
 });
});
