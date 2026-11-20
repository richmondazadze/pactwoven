import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { commandDigest } from '../../contracts/src/canonical';
import { NativeRootRefreshCommandSchema, nativeRootRefreshRequestKey } from './native-root-refresh-schema';
import { PostgresNativeRootRefreshCoordinatorRepository, PostgresNativeRootRefreshWorkerRepository } from './native-root-refresh-repository';
const hash='a'.repeat(64),selector={organizationId:'org',taskId:'root',generation:1,handoffId:null,leaseToken:'b8878b4d-a35f-4c5e-8abc-a89174c570bf'};
const commandBase={schemaVersion:2 as const,expectedRefreshEpoch:0,expectedCheckpointVersion:1,results:[{handoffId:'handoff',publicationDigest:hash}]};
async function fixture(){
 const key=await nativeRootRefreshRequestKey('refresh',{environment:'simulation',organizationId:'org',rootTaskId:'root',generation:1},commandBase),command=NativeRootRefreshCommandSchema.parse({...commandBase,requestKey:key});
 const receipt={kind:'refresh' as const,requestKey:key,intentDigest:await commandDigest(command),rootTaskId:'root',previousGeneration:1,generation:2,previousEpoch:0,refreshEpoch:1,attempt:2,checkpointVersion:2,lineageDigest:hash,admittedTaskIds:[],pendingCount:1,continuation:'yielded' as const,domainCompletion:false as const};
 const query=vi.fn().mockResolvedValue({rows:[{response:receipt}]}),repo=new PostgresNativeRootRefreshCoordinatorRepository({query}as unknown as Pool,'simulation');return{query,repo,command,receipt};
}
describe('refresh repository preserves authoritative response bindings',()=>{
 it('sends only copied, strict JSON and returns exact immutable operation metadata',async()=>{
  const f=await fixture();expect(await f.repo.refresh(selector,f.command)).toEqual(f.receipt);
  expect(f.query).toHaveBeenCalledExactlyOnceWith('SELECT pactwoven.native_delegation_root_refresh($1,$2::jsonb,$3::jsonb) AS response',['simulation',JSON.stringify(selector),JSON.stringify(f.command)]);
 });
 it.each(['rootTaskId','requestKey','intentDigest','previousGeneration','previousEpoch','checkpointVersion'])('treats mismatched %s after a possible write as unknown',async field=>{
  const f=await fixture();f.query.mockResolvedValue({rows:[{response:{...f.receipt,[field]:typeof(f.receipt as Record<string,unknown>)[field]==='number'?9:'b'.repeat(64)}}]});
  await expect(f.repo.refresh(selector,f.command)).rejects.toMatchObject({code:'DURABLE_SERVICE_UNAVAILABLE',status:503});expect(f.query).toHaveBeenCalledTimes(1);
 });
 it('does not retry an ambiguous committed request',async()=>{
  const f=await fixture();f.query.mockRejectedValue(Error('private transport diagnostics'));await expect(f.repo.refresh(selector,f.command)).rejects.toMatchObject({code:'DURABLE_SERVICE_UNAVAILABLE',message:'The work update has not been confirmed.'});expect(f.query).toHaveBeenCalledTimes(1);
 });
 it.each([['ND001','FORBIDDEN'],['ND009','ROOT_CONFLICT'],['NM005','EVIDENCE_STALE'],['ND004','VALIDATION_FAILED'],['NM007','MEMORY_LIMIT'],['NM002','MEMORY_UNAVAILABLE']])('preserves confirmed SQL rollback %s',async(sql,code)=>{
  const f=await fixture();f.query.mockRejectedValue({code:sql,message:'private data'});await expect(f.repo.refresh(selector,f.command)).rejects.toMatchObject({code});
 });
 it('recovers only matching original operation after the issuing lease is gone',async()=>{
  const f=await fixture(),lookup={kind:'refresh' as const,requestKey:f.command.requestKey,intentDigest:f.receipt.intentDigest};
  expect(await f.repo.refreshOperation({organizationId:'org',taskId:'root',generation:1},lookup)).toEqual(f.receipt);
  await expect(f.repo.refreshOperation({organizationId:'org',taskId:'other',generation:1},lookup)).rejects.toMatchObject({code:'DURABLE_SERVICE_UNAVAILABLE'});
  f.query.mockResolvedValue({rows:[{response:null}]});expect(await f.repo.refreshOperation({organizationId:'org',taskId:'root',generation:1},lookup)).toBeNull();
 });
 it('snapshots inputs before asynchronous digest/transport',async()=>{
  const f=await fixture(),input=structuredClone(f.command),target=structuredClone(selector),pending=f.repo.refresh(target,input);target.taskId='changed';input.results[0]!.handoffId='changed';await pending;
  expect(JSON.parse(f.query.mock.calls[0]![1][1]).taskId).toBe('root');expect(JSON.parse(f.query.mock.calls[0]![1][2]).results[0].handoffId).toBe('handoff');
 });
 it('rejects caller authority extension before a database request',async()=>{
  const f=await fixture();await expect(f.repo.refresh(selector,{...f.command,authority:{allowed:true}}as never)).rejects.toBeDefined();expect(f.query).not.toHaveBeenCalled();
 });
 it('binds checkpoint receipt to the current epoch, version and exact operation',async()=>{
  const query=vi.fn().mockResolvedValue({rows:[{response:{schemaVersion:2,refreshEpoch:1,receipt:{checkpointVersion:2,generation:1,attempt:2,continuation:'running',requestKey:'original_checkpoint'}}}]}),repo=new PostgresNativeRootRefreshCoordinatorRepository({query}as unknown as Pool,'simulation');
  const c={schemaVersion:2 as const,expectedRefreshEpoch:1,command:{requestKey:'original_checkpoint',expectedCheckpointVersion:1,checkpoint:{stage:'working' as const,summary:'Refreshing sources.',steps:[]},plannerState:'{}',inputReceipts:[]}};
  await expect(repo.checkpointV2(selector,c)).resolves.toMatchObject({refreshEpoch:1});query.mockResolvedValue({rows:[{response:{schemaVersion:2,refreshEpoch:2,receipt:{checkpointVersion:2,generation:1,attempt:2,continuation:'running',requestKey:'original_checkpoint'}}}]});await expect(repo.checkpointV2(selector,c)).rejects.toMatchObject({code:'DURABLE_SERVICE_UNAVAILABLE'});
 });
 it.each(['yielded','waiting_children'] as const)('rejects a checkpoint response that claims %s',async continuation=>{
  const query=vi.fn().mockResolvedValue({rows:[{response:{schemaVersion:2,refreshEpoch:1,receipt:{checkpointVersion:2,generation:1,attempt:2,continuation,requestKey:'original_checkpoint'}}}]}),repo=new PostgresNativeRootRefreshCoordinatorRepository({query}as unknown as Pool,'simulation');
  const command={requestKey:'original_checkpoint',expectedCheckpointVersion:1,checkpoint:{stage:'working' as const,summary:'Refreshing sources.',steps:[]},plannerState:'{}',inputReceipts:[]};
  await expect(repo.checkpointV2(selector,{schemaVersion:2,expectedRefreshEpoch:1,command})).rejects.toMatchObject({code:'DURABLE_SERVICE_UNAVAILABLE'});
 });
 it.each(['accepted','duplicate'] as const)('confirms exact %s completion without claiming a second execution',async kind=>{
  const command={requestKey:'completion_original',expectedCheckpointVersion:1,inputReceipts:[],coverage:[],result:{outcome:'advice_ready' as const,title:'Advice',summary:'Current advice.',artifacts:[{id:'advice',title:'Advice',text:'Current advice.'}],evidenceValidUntil:'2026-11-19T05:00:00Z'}};
  const receipt={kind,rootTaskId:'root',publicationDigest:await commandDigest(command),execution:kind==='accepted'?'advisory_only':'none',domainCompletion:false};
  const query=vi.fn().mockResolvedValue({rows:[{response:{schemaVersion:2,refreshEpoch:1,receipt}}]}),repo=new PostgresNativeRootRefreshCoordinatorRepository({query}as unknown as Pool,'simulation');
  await expect(repo.completeV2(selector,{schemaVersion:2,expectedRefreshEpoch:1,command})).resolves.toMatchObject({receipt});
  query.mockResolvedValue({rows:[{response:{schemaVersion:2,refreshEpoch:1,receipt:{...receipt,publicationDigest:'b'.repeat(64)}}}]});
  await expect(repo.completeV2(selector,{schemaVersion:2,expectedRefreshEpoch:1,command})).rejects.toMatchObject({code:'DURABLE_SERVICE_UNAVAILABLE'});
 });
 it('rejects foreign result publication before touching persistence',async()=>{
  const query=vi.fn(),repo=new PostgresNativeRootRefreshWorkerRepository({query}as unknown as Pool,'simulation');
  const result={schemaVersion:1 as const,resultId:'result',handoffId:'handoff',handoffDigest:hash,environment:'simulation' as const,organizationId:'other',siteId:'site',childTaskId:'child',assignmentVersion:1,generation:1,authority:{kind:'delegated' as const,grantId:'grant',grantVersion:1,revocationEpoch:0,grantDigest:hash},sender:{serviceId:'worker',serviceVersion:1,workloadIdentityId:'worker'},recipient:{serviceId:'coordinator',serviceVersion:1,workloadIdentityId:'coordinator'},attempt:1,outcome:'failed' as const,artifacts:[],finishedAt:'2026-11-19T04:00:00Z',evidenceValidUntil:null};
  await expect(repo.resultV2({...selector,taskId:'child',handoffId:'handoff'},{schemaVersion:2,expectedRefreshEpoch:1,publication:{result,artifacts:[],inputArtifacts:[],memoryUsage:[]},observations:[]})).rejects.toMatchObject({code:'VALIDATION_FAILED'});expect(query).not.toHaveBeenCalled();
 });
});
