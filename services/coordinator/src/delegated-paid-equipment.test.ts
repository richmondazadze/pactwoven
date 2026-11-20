import {describe,it,expect,vi} from 'vitest';
import {DelegatedCoordinator} from './delegated-coordinator';
import {DelegatedPaidEquipmentCoordinator} from './delegated-paid-equipment';
import {runtimeFixture} from './delegated-instruction-test-fixture';
import {DomainError} from '../../../packages/domain/src/errors';
import {commandDigest} from '../../../packages/contracts/src/canonical';
import {nativeInstructionDigest} from '../../../packages/db/src/native-root-instruction-schema';
import {equipmentRequestHash,equipmentResourceHash,optimizeEquipment,type EquipmentCatalogue} from '../../paid-tools/src/equipment-optimizer';
import {paidToolChallengeHash} from '../../paid-tools/src/quote-binding';
import {transferFixture} from '../../paid-tools/src/solana-fixtures.test-support';
import {PrivateEquipmentQuoteProducer} from '../../paid-tools/src/equipment-quote';
const catalogue:EquipmentCatalogue={version:1,currency:'USD',provenance:'controlled_demo_catalogue',offers:[{id:'package',label:'Workshop package',seats:20,microphones:1,projectors:0,priceMinor:20000}]};
const demand={seats:20,microphones:1,projectors:0,budgetMinor:30000};
async function fixture(mode:'disabled'|'new'|'waiting'|'ready'|'unavailable'='new'){
 const f=await runtimeFixture();f.grant.scope.environment='development';f.reference.environment='development';f.authority.grantDigest=await commandDigest(f.grant);
 const frame:any={schemaVersion:3,refreshEpoch:0,instructionRevision:0,instructionDigest:await nativeInstructionDigest(0,[]),instructions:[],rootDeadlineAt:f.instant(120000),lifetimeChildCount:1,usageFloor:{inputTokens:0,outputTokens:0,totalTokens:0},work:structuredClone(f.baseWork),refresh:null};
 const modelRequests:any[]=[],completed:any[]=[],checkpoints:any[]=[],waits:any[]=[],diagnostics:any[]=[];
 const repository:any={claim:async()=>({selector:f.selector,validUntil:f.instant(30000),identity:f.services.coordinator,authority:f.authority,attempt:frame.refresh?2:1,handoff:null}),work:vi.fn(),checkpoint:vi.fn(),yield:vi.fn(),handoff:vi.fn(),inputs:vi.fn(),complete:vi.fn()};
 const instructions:any={workV3:async()=>structuredClone(frame),inputsV3:vi.fn(async(_s:any,q:any)=>({schemaVersion:3,instructionRevision:0,refreshEpoch:frame.refreshEpoch,receipt:{receipt:{receiptId:'8edee1cf-dc38-4c8a-9894-a16f174da906',digest:'c'.repeat(64)},generation:f.target.generation,dataValidUntil:f.instant(60000),results:q.command.results.map((r:any)=>({...r,outcome:'advice_ready',artifacts:[{reference:f.reference,body:f.body}]}))}})),checkpointV3:vi.fn(async(_s:any,q:any)=>{checkpoints.push(q);frame.work.checkpointVersion++;return{schemaVersion:3,instructionRevision:0,refreshEpoch:frame.refreshEpoch,receipt:{checkpointVersion:frame.work.checkpointVersion,generation:f.target.generation,attempt:frame.refresh?2:1,continuation:'running',requestKey:q.command.requestKey}};}),yieldV3:vi.fn(),completeV3:vi.fn(async(_s:any,q:any)=>{completed.push(q);return{schemaVersion:3,instructionRevision:0,refreshEpoch:frame.refreshEpoch,receipt:{kind:'accepted',publicationDigest:'d'.repeat(64),rootTaskId:f.target.taskId,execution:q.command.result.outcome==='blocked'?'none':'advisory_only',domainCompletion:false}};}),refreshV3:vi.fn(),handoffV3:vi.fn(),refreshDispatchV3:vi.fn(),refreshOperationV3:vi.fn()};
 const gateway:any={complete:vi.fn(async(req:any)=>{modelRequests.push(req);const context=JSON.parse(req.input);let value:any;
 if(req.schemaName==='paid_equipment_service_selection')value={decision:'use_service',reason:'Compare workshop packages.',demand,supportingArtifactIds:['fixture_artifact'],assumptions:[]};
 else if(req.schemaName==='delegated_advice_quality')value={verdict:'accept',checks:['deliverables','consistency','grounding','scope'].map(category=>({category,requirement:`Check ${category}`,status:'satisfied',passageIds:[context.candidate.passages[0].id]})),repairGuidance:null};
 else value={...f.advice,findings:[]};return{value:req.schema.parse(value),usage:{inputTokens:2,outputTokens:1,totalTokens:3},deployment:req.role==='escalation'?'gpt-6-astra':'gpt-6.1-sol'};})};
 const scope={organizationId:f.target.organizationId,siteId:'fixture_site',rootTaskId:f.target.taskId,instructionRevision:0};
 const root:any={policy:vi.fn(async()=>mode==='disabled'?{enabled:false,rootTaskId:scope.rootTaskId,instructionRevision:0}:{enabled:true,rootTaskId:scope.rootTaskId,instructionRevision:0,maximumComputationBaseUnits:'10000',maximumFeeLamports:'10000',authorization:'separate_quote_required'}),read:vi.fn(async()=>mode==='new'||mode==='disabled'?{kind:'none',rootTaskId:scope.rootTaskId,instructionRevision:0}:{kind:mode,rootTaskId:scope.rootTaskId,instructionRevision:0,quoteId:'quote',operationId:mode==='ready'||mode==='unavailable'?'operation':null,dataValidUntil:f.instant(60000)}),wait:vi.fn(async(_s:any,q:any)=>{waits.push(q);return{rootTaskId:scope.rootTaskId,quoteId:q.quoteId,instructionRevision:0,checkpoint:{checkpointVersion:q.checkpoint.expectedCheckpointVersion+1,generation:f.target.generation+1,attempt:1,continuation:'waiting_children',requestKey:q.checkpoint.requestKey}};}),consume:vi.fn()};
 const quote={propose:vi.fn(async(_input:{rootDeadlineAt:string})=>({quoteId:'quote',quoteHash:'a'.repeat(64)}))};
 const revalidation:any={revalidation:vi.fn(async()=>({kind:'not_applicable',rootTaskId:scope.rootTaskId,instructionRevision:0})),revalidate:vi.fn(),park:vi.fn()};
 const paid=new DelegatedPaidEquipmentCoordinator({repository:root,revalidation,quote,catalogue});
 const run=()=>new DelegatedCoordinator({environment:'development',services:f.services as any,repository,instructions,paidEquipment:paid,gateway,onDiagnostic:event=>{diagnostics.push(event);},renewal:{renew:async()=>({validUntil:f.instant(30000)})},observe:async()=>({result:{state:'allowed'},usableUntil:f.at+30000})}).run(f.target,{deadlineAt:f.at+60000});
 return{f,frame,scope,root,revalidation,quote,gateway,run,waits,modelRequests,completed,checkpoints,instructions,diagnostics};
}
async function paidRecord(x:Awaited<ReturnType<typeof fixture>>){
 const f=transferFixture(),r=f.intent,hash='a'.repeat(64),ref={id:'ref',version:1,hash},expiresAt=x.f.instant(120000),requestHash=await equipmentRequestHash(demand),resourceHash=await equipmentResourceHash(catalogue);
 const challenge={id:'quote',providerId:'equipment_optimizer_v1',requestHash,resourceHash,payee:{id:'payee',version:1,environment:'development',network:'solana-devnet',recipient:r.destinationOwner,assetId:'devnet_usdc',mint:r.mint,tokenProgram:r.tokenProgram,verificationRef:'proof'},amountBaseUnits:'10000',expiresAt};
 const q={providerId:'equipment_optimizer_v1',request:{...ref,hash:requestHash},resource:{...ref,hash:resourceHash},allowlistPolicy:ref,deliveryPolicy:ref,challenge:{...challenge,hash:await paidToolChallengeHash(challenge)}};
 const result=await optimizeEquipment(demand,catalogue),resultHash=await commandDigest({namespace:'pactwoven.paid-tools.delivery.v1',result});
 const message={messageHash:f.message.messageHash,messageBase64:f.message.messageBase64,blockhash:r.blockhash,lastValidBlockHeight:r.lastValidBlockHeight,currentBlockHeight:'200',heightObservedAt:x.f.instant(-1000),heightEvidenceRef:'height',heightEvidenceHash:hash,feeLamports:r.feeLamports,sourceObservationId:'source',feeObservationId:'fee'};
 const attempt={id:'attempt',messageHash:message.messageHash,wireHash:f.wire.wireHash,signature:f.wire.signature,blockhash:r.blockhash,lastValidBlockHeight:r.lastValidBlockHeight};
 const payment={status:'finalized_transfer',signature:f.wire.signature,slot:'123',observedAt:x.f.instant(-500),genesis:r.genesis,mint:r.mint,tokenProgram:r.tokenProgram,sourceAccount:r.sourceAccount,sourceOwner:r.sourceOwner,destinationAccount:r.destinationAccount,destinationOwner:r.destinationOwner,amountBaseUnits:r.amountBaseUnits,feeLamports:r.feeLamports,messageHash:message.messageHash,transactionEvidenceRef:'transaction',transactionEvidenceHash:hash,statusEvidenceRef:'status',statusEvidenceHash:hash};
 const review={id:'review',...x.scope,quoteId:'quote',quoteHash:q.challenge.hash,providerId:'equipment_optimizer_v1',amountBaseUnits:r.amountBaseUnits,maximumFeeLamports:r.maximumFeeLamports,sourceAccount:r.sourceAccount,sourceOwner:r.sourceOwner,feePayer:r.feePayer,destinationAccount:r.destinationAccount,destinationOwner:r.destinationOwner,mint:r.mint,tokenProgram:r.tokenProgram,genesis:r.genesis,expiresAt,reviewHash:hash};
 const delivery={artifactRef:'artifact',resultHash,requestHash,resourceHash,paymentSignature:f.wire.signature,verifiedAt:x.f.instant(-100),resultBody:result};
 return {record:{snapshot:{operationId:'operation',review,version:7,status:'completed',approvedAt:x.f.instant(-2000),revokedAt:null,message,attempt,payment,delivery},quote:q,requestBody:demand,resourceBody:catalogue,wireBase64:null,receipt:null},resultHash,signature:f.wire.signature};
}
describe('real coordinator paid-equipment bridge',()=>{
 it('parks a24hour root using the actual bounded quote producer and preserves separate approval',async()=>{const x=await fixture(),p=await paidRecord(x);x.frame.rootDeadlineAt=x.f.instant(24*60*60*1000);const submitted:any[]=[];const actual=new PrivateEquipmentQuoteProducer({quote:async input=>{submitted.push(input);const expiry=Date.parse(input.quote.challenge.expiresAt);expect(expiry).toBeGreaterThan(Date.now());expect(expiry).toBeLessThanOrEqual(Date.now()+5*60_000);expect(expiry).toBeLessThan(Date.parse(x.frame.rootDeadlineAt));return{id:input.id,quoteHash:input.quote.challenge.hash};}},{catalogue,payee:p.record.quote.challenge.payee as any,allowlistPolicy:p.record.quote.allowlistPolicy,deliveryPolicy:p.record.quote.deliveryPolicy,priceBaseUnits:'10000'});x.quote.propose.mockImplementation((input:any,signal?:AbortSignal)=>actual.propose(input,signal!));expect(await x.run()).toMatchObject({state:'yielded'});expect(submitted).toHaveLength(1);expect(x.waits).toHaveLength(1);expect(x.completed).toHaveLength(0);expect(x.root.consume).not.toHaveBeenCalled();expect(x.modelRequests).toHaveLength(1);expect(x.diagnostics).toHaveLength(0);});

 it('reports a rejected paid selection without leaking model data before blocked completion',async()=>{const x=await fixture();x.gateway.complete.mockImplementation(async()=>{throw new Error('private model body and credentials must not be logged');});expect(await x.run()).toMatchObject({state:'settled'});expect(x.diagnostics).toContainEqual({runner:'coordinator',stage:'paid_equipment',failure:'unexpected'});expect(JSON.stringify(x.diagnostics)).not.toContain('private model');expect(x.completed).toHaveLength(1);expect(x.completed[0].command.result.outcome).toBe('blocked');expect(x.quote.propose).not.toHaveBeenCalled();});
 it('keeps disabled initial opt-in on the ordinary advisory path',async()=>{const x=await fixture('disabled');expect(await x.run()).toMatchObject({state:'settled'});expect(x.completed).toHaveLength(1);expect(x.root.read).not.toHaveBeenCalled();expect(x.quote.propose).not.toHaveBeenCalled();expect(x.modelRequests.some(r=>r.schemaName==='paid_equipment_service_selection')).toBe(false);});
 it('selects only after real current specialist input admission and parks the same unfinished root',async()=>{const x=await fixture();expect(await x.run()).toMatchObject({state:'yielded',taskId:x.f.target.taskId});expect(x.instructions.inputsV3).toHaveBeenCalledTimes(1);expect(x.completed).toHaveLength(0);expect(x.waits).toHaveLength(1);expect(x.waits[0].selection.candidate.supportingArtifacts[0].artifactId).toBe(x.f.reference.artifactId);expect(x.waits[0].selection.candidate.scope.rootTaskId).toBe(x.f.target.taskId);expect(x.quote.propose.mock.calls[0]![0].rootDeadlineAt).toBe(x.frame.rootDeadlineAt);expect(JSON.parse(x.waits[0].checkpoint.plannerState).usage.totalTokens).toBe(8);expect(x.modelRequests).toHaveLength(1);});
 it('re-parks an existing waiting quote without another selection or quote',async()=>{const x=await fixture('waiting');expect(await x.run()).toMatchObject({state:'yielded'});expect(x.waits[0].selection).toBeNull();expect(x.quote.propose).not.toHaveBeenCalled();expect(x.modelRequests).toHaveLength(0);});
 it('consumes the actual paid record under this root/revision and supplies structured result to synthesis and quality',async()=>{const x=await fixture('ready'),p=await paidRecord(x);x.root.consume.mockImplementation(async(_s:any,q:any)=>({rootTaskId:x.f.target.taskId,instructionRevision:0,generation:x.f.target.generation,quoteId:'quote',operationId:'operation',requestKey:q.requestKey,resultHash:p.resultHash,paymentSignature:p.signature,artifactRef:'artifact',resultBody:p.record.snapshot.delivery.resultBody,dataValidUntil:x.f.instant(60000),paidRecord:p.record}));expect(await x.run()).toMatchObject({state:'settled'});expect(x.root.consume).toHaveBeenCalledTimes(1);expect(x.quote.propose).not.toHaveBeenCalled();const synth=x.modelRequests.find(r=>r.schemaName==='delegated_root_advice'),quality=x.modelRequests.find(r=>r.schemaName==='delegated_advice_quality');expect(JSON.parse(synth.input).purchasedEquipment.result.totalMinor).toBe(20000);expect(JSON.parse(quality.input).context.purchasedEquipment.result.selectedOfferIds).toEqual(['package']);expect(synth.instructions).toContain('never claim equipment was ordered');expect(x.completed[0].command.result.outcome).toBe('advice_ready');});
 it('does not synthesize or issue another write after an inconsistent consumed purchase response',async()=>{const x=await fixture('ready'),p=await paidRecord(x);p.record.snapshot.review.instructionRevision=1;x.root.consume.mockImplementation(async(_s:any,q:any)=>({rootTaskId:x.f.target.taskId,instructionRevision:0,generation:x.f.target.generation,quoteId:'quote',operationId:'operation',requestKey:q.requestKey,resultHash:p.resultHash,paymentSignature:p.signature,artifactRef:'artifact',resultBody:p.record.snapshot.delivery.resultBody,dataValidUntil:x.f.instant(60000),paidRecord:p.record}));expect(await x.run()).toMatchObject({state:'unconfirmed'});expect(x.modelRequests).toHaveLength(0);expect(x.checkpoints).toHaveLength(0);expect(x.completed).toHaveLength(0);});
 it('treats a changed wait generation as unknown acceptance and avoids another mutation',async()=>{const x=await fixture();x.root.wait.mockImplementation(async(_s:any,q:any)=>({rootTaskId:x.f.target.taskId,quoteId:q.quoteId,instructionRevision:0,checkpoint:{checkpointVersion:q.checkpoint.expectedCheckpointVersion+1,generation:99,attempt:1,continuation:'waiting_children',requestKey:q.checkpoint.requestKey}}));expect(await x.run()).toMatchObject({state:'unconfirmed'});expect(x.checkpoints).toHaveLength(0);expect(x.completed).toHaveLength(0);});
 it('rejects changed specialist bytes before service selection or quote creation',async()=>{const x=await fixture();x.f.body.advice.summary='tampered';expect(await x.run()).toMatchObject({state:'interrupted'});expect(x.quote.propose).not.toHaveBeenCalled();expect(x.root.policy).not.toHaveBeenCalled();expect(x.completed).toHaveLength(0);});
 it('stops on unknown wait persistence without completion or another write',async()=>{const x=await fixture();x.root.wait.mockRejectedValue(Error('lost acknowledgement'));expect(await x.run()).toMatchObject({state:'unconfirmed'});expect(x.root.wait).toHaveBeenCalledTimes(1);expect(x.completed).toHaveLength(0);expect(x.checkpoints).toHaveLength(0);});
});

async function revalidationFixture(){
 const x=await fixture('unavailable'),p=await paidRecord(x);
 const preparation={kind:'required' as const,rootTaskId:x.scope.rootTaskId,instructionRevision:0,quoteId:'quote',operationId:'operation',requestHash:await equipmentRequestHash(demand),resourceHash:await equipmentResourceHash(catalogue),resultHash:p.resultHash};
 x.revalidation.revalidation.mockResolvedValue(preparation as any);
 x.revalidation.revalidate.mockImplementation(async(_s:any,q:any)=>{
  x.root.read.mockResolvedValue({kind:'ready',rootTaskId:x.scope.rootTaskId,instructionRevision:0,quoteId:'quote',operationId:'operation',dataValidUntil:x.f.instant(60000)});
  return {rootTaskId:x.scope.rootTaskId,instructionRevision:0,refreshEpoch:0,generation:x.f.target.generation,quoteId:'quote',operationId:'operation',requestKey:q.requestKey,resultHash:p.resultHash,dataValidUntil:x.f.instant(60000)};
 });
 x.root.consume.mockImplementation(async(_s:any,q:any)=>({rootTaskId:x.scope.rootTaskId,instructionRevision:0,generation:x.f.target.generation,quoteId:'quote',operationId:'operation',requestKey:q.requestKey,resultHash:p.resultHash,paymentSignature:p.signature,artifactRef:'artifact',resultBody:p.record.snapshot.delivery.resultBody,dataValidUntil:x.f.instant(60000),paidRecord:p.record}));
 return {...x,p,preparation};
}
describe('same paid computation with freshly accepted specialist evidence',()=>{
 it('revalidates current inputs and consumes the original completed operation without preparing another payment',async()=>{
  const x=await revalidationFixture();expect(await x.run()).toMatchObject({state:'settled'});
  expect(x.instructions.inputsV3).toHaveBeenCalledOnce();expect(x.revalidation.revalidate).toHaveBeenCalledOnce();
  expect(x.checkpoints).toHaveLength(2);expect(JSON.parse(x.checkpoints[0].command.plannerState).usage.totalTokens).toBe(8);
  expect(x.checkpoints[1].command.expectedCheckpointVersion).toBe(x.checkpoints[0].command.expectedCheckpointVersion+1);
  const q=x.revalidation.revalidate.mock.calls[0]![1];
  expect(q).toMatchObject({schemaVersion:1,expectedInstructionRevision:0,expectedRefreshEpoch:0,quoteId:'quote',operationId:'operation',inputReceipts:[{receiptId:'8edee1cf-dc38-4c8a-9894-a16f174da906',digest:'c'.repeat(64)}]});
  expect(q.selection.candidate.request).toEqual(demand);expect(q.selection.candidate.supportingArtifacts[0].artifactId).toBe(x.f.reference.artifactId);
  expect(x.root.consume).toHaveBeenCalledOnce();expect(x.quote.propose).not.toHaveBeenCalled();expect(x.root.wait).not.toHaveBeenCalled();
  const synthesis=x.modelRequests.find(r=>r.schemaName==='delegated_root_advice');expect(JSON.parse(synthesis.input).purchasedEquipment).toMatchObject({operationId:'operation',resultHash:x.p.resultHash});
  expect(x.completed[0].command.result.outcome).toBe('advice_ready');
 });
 it.each(['requestHash','resourceHash'] as const)('refuses changed %s instead of buying a replacement',async key=>{
  const x=await revalidationFixture();x.revalidation.revalidation.mockResolvedValue({...x.preparation,[key]:'b'.repeat(64)} as any);
  expect(await x.run()).toMatchObject({state:'settled'});expect(x.completed[0].command.result.outcome).toBe('blocked');
  expect(x.revalidation.revalidate).not.toHaveBeenCalled();expect(x.root.consume).not.toHaveBeenCalled();expect(x.quote.propose).not.toHaveBeenCalled();expect(x.root.wait).not.toHaveBeenCalled();
 });
 it.each(['rootTaskId','instructionRevision','quoteId','operationId'] as const)('rejects a mismatched preparation %s before selection',async key=>{
  const x=await revalidationFixture();x.revalidation.revalidation.mockResolvedValue({...x.preparation,[key]:key==='instructionRevision'?1:'wrong'} as any);
  await x.run();expect(x.modelRequests).toHaveLength(0);expect(x.revalidation.revalidate).not.toHaveBeenCalled();expect(x.root.consume).not.toHaveBeenCalled();expect(x.quote.propose).not.toHaveBeenCalled();
 });
 it('does not bypass the original purchase when fresh specialists no longer require the service',async()=>{
  const x=await revalidationFixture(),complete=x.gateway.complete.getMockImplementation()!;
  x.gateway.complete.mockImplementation(async(req:any)=>req.schemaName==='paid_equipment_service_selection'?{value:req.schema.parse({decision:'not_needed',reason:'No computation is needed.',demand:null,supportingArtifactIds:[],assumptions:[]}),usage:{inputTokens:1,outputTokens:1,totalTokens:2},deployment:'gpt-6.1-sol'}:complete(req));
  expect(await x.run()).toMatchObject({state:'settled'});expect(x.completed[0].command.result.outcome).toBe('blocked');expect(x.revalidation.revalidate).not.toHaveBeenCalled();expect(x.root.consume).not.toHaveBeenCalled();expect(x.quote.propose).not.toHaveBeenCalled();
 });
 it('retains model usage before unknown witness acknowledgement without later writes or completion',async()=>{
  const x=await revalidationFixture();x.revalidation.revalidate.mockRejectedValue(Error('response lost after possible commit'));
  expect(await x.run()).toMatchObject({state:'unconfirmed'});expect(x.revalidation.revalidate).toHaveBeenCalledOnce();expect(x.root.consume).not.toHaveBeenCalled();expect(x.checkpoints).toHaveLength(1);expect(x.completed).toHaveLength(0);expect(x.quote.propose).not.toHaveBeenCalled();
 });
 it.each(['rootTaskId','instructionRevision','refreshEpoch','generation','quoteId','operationId','requestKey','resultHash','dataValidUntil'] as const)('stops after inconsistent committed witness %s',async key=>{
  const x=await revalidationFixture(),write=x.revalidation.revalidate.getMockImplementation()!;
  x.revalidation.revalidate.mockImplementation(async(...args:any[])=>({...await write(...args),[key]:['instructionRevision','refreshEpoch','generation'].includes(key)?99:key==='dataValidUntil'?x.f.instant(-1):key==='resultHash'?'b'.repeat(64):'wrong'}));
  expect(await x.run()).toMatchObject({state:'unconfirmed'});expect(x.revalidation.revalidate).toHaveBeenCalledOnce();expect(x.root.consume).not.toHaveBeenCalled();expect(x.checkpoints).toHaveLength(1);expect(x.completed).toHaveLength(0);expect(x.quote.propose).not.toHaveBeenCalled();
 });
 it('does not fall back to quote creation when the post-witness read loses its original binding',async()=>{
  const x=await revalidationFixture(),write=x.revalidation.revalidate.getMockImplementation()!;
  x.revalidation.revalidate.mockImplementation(async(...args:any[])=>{const receipt=await write(...args);x.root.read.mockResolvedValue({kind:'none',rootTaskId:x.scope.rootTaskId,instructionRevision:0});return receipt;});
  expect(await x.run()).toMatchObject({state:'unconfirmed'});expect(x.root.consume).not.toHaveBeenCalled();expect(x.checkpoints).toHaveLength(1);expect(x.completed).toHaveLength(0);expect(x.quote.propose).not.toHaveBeenCalled();
 });
 it('retains the existing unavailable path when no completed reusable operation exists',async()=>{
  const x=await fixture('unavailable');expect(await x.run()).toMatchObject({state:'settled'});expect(x.completed[0].command.result.outcome).toBe('blocked');expect(x.revalidation.revalidate).not.toHaveBeenCalled();expect(x.modelRequests).toHaveLength(0);expect(x.quote.propose).not.toHaveBeenCalled();
 });
});

describe('pending already-approved computation after source expiry',()=>{
 async function pendingFixture(){
  const x=await fixture('unavailable');
  x.revalidation.revalidation.mockResolvedValue({kind:'pending',rootTaskId:x.scope.rootTaskId,instructionRevision:0,quoteId:'quote',operationId:'operation'});
  x.revalidation.park.mockImplementation(async(_s:any,q:any)=>({state:'waiting',rootTaskId:x.scope.rootTaskId,instructionRevision:0,refreshEpoch:0,generation:x.f.target.generation+1,quoteId:'quote',operationId:'operation',requestKey:q.requestKey}));
  return x;
 }
 it('parks the original unresolved purchase without revalidation, another quote, or blocked completion',async()=>{
  const x=await pendingFixture();expect(await x.run()).toMatchObject({state:'yielded'});expect(x.revalidation.park).toHaveBeenCalledOnce();
  expect(x.revalidation.park.mock.calls[0][1]).toMatchObject({schemaVersion:1,expectedInstructionRevision:0,expectedRefreshEpoch:0,quoteId:'quote',operationId:'operation'});
  expect(x.revalidation.revalidate).not.toHaveBeenCalled();expect(x.root.wait).not.toHaveBeenCalled();expect(x.root.consume).not.toHaveBeenCalled();expect(x.quote.propose).not.toHaveBeenCalled();expect(x.completed).toHaveLength(0);expect(x.checkpoints).toHaveLength(0);expect(x.modelRequests).toHaveLength(0);
 });
 it.each(['generation','quoteId','requestKey','instructionRevision'] as const)('stops after inconsistent pending park %s without another mutation',async key=>{
  const x=await pendingFixture(),park=x.revalidation.park.getMockImplementation()!;
  x.revalidation.park.mockImplementation(async(...args:any[])=>({...await park(...args),[key]:['generation','instructionRevision'].includes(key)?99:'wrong'}));
  expect(await x.run()).toMatchObject({state:'unconfirmed'});expect(x.revalidation.park).toHaveBeenCalledOnce();expect(x.completed).toHaveLength(0);expect(x.checkpoints).toHaveLength(0);expect(x.root.consume).not.toHaveBeenCalled();expect(x.quote.propose).not.toHaveBeenCalled();
 });
 it('stops on unknown park acknowledgement without retrying or completing',async()=>{
  const x=await pendingFixture();x.revalidation.park.mockRejectedValue(Error('possible accepted park'));
  expect(await x.run()).toMatchObject({state:'unconfirmed'});expect(x.revalidation.park).toHaveBeenCalledOnce();expect(x.completed).toHaveLength(0);expect(x.checkpoints).toHaveLength(0);expect(x.quote.propose).not.toHaveBeenCalled();
 });
});

describe('existing source refresh precedes reuse of a paid result',()=>{
 it('yields through0039 refresh before considering expired paid input witnesses',async()=>{
  const x=await revalidationFixture();x.instructions.inputsV3.mockRejectedValue(new DomainError('EVIDENCE_STALE',409,'Expired current sources.'));
  x.instructions.refreshV3.mockImplementation(async(_s:any,q:any)=>({schemaVersion:3,instructionRevision:0,kind:'refresh',requestKey:q.requestKey,intentDigest:await commandDigest(q),rootTaskId:x.scope.rootTaskId,previousGeneration:x.f.target.generation,generation:x.f.target.generation+1,previousEpoch:0,refreshEpoch:1,attempt:2,checkpointVersion:x.frame.work.checkpointVersion+1,lineageDigest:'e'.repeat(64),admittedTaskIds:[],pendingCount:1,continuation:'yielded',domainCompletion:false}));
  expect(await x.run()).toMatchObject({state:'yielded'});expect(x.instructions.refreshV3).toHaveBeenCalledOnce();
  expect(x.instructions.refreshV3.mock.calls[0][1]).toMatchObject({expectedInstructionRevision:0,expectedRefreshEpoch:0,results:[{handoffId:x.f.child.handoffId,publicationDigest:x.f.child.publicationDigest}]});
  expect(x.revalidation.revalidation).not.toHaveBeenCalled();expect(x.revalidation.revalidate).not.toHaveBeenCalled();expect(x.root.consume).not.toHaveBeenCalled();expect(x.quote.propose).not.toHaveBeenCalled();expect(x.completed).toHaveLength(0);expect(x.modelRequests).toHaveLength(0);
 });
 it('binds a later source epoch to revalidation and final completion without resetting it',async()=>{
  const x=await revalidationFixture();x.frame.refreshEpoch=2;
  const replacement={...x.f.child,taskId:'refreshed_child',handoffId:'refreshed_handoff',publicationDigest:'f'.repeat(64)};
  x.frame.lifetimeChildCount=2;x.frame.work.children.push(replacement);
  x.frame.refresh={lineageDigest:'e'.repeat(64),planBasis:{checkpointVersion:1,plannerState:JSON.stringify(x.f.state),plannerDigest:await commandDigest(x.f.state)},usage:{inputTokens:8,outputTokens:2,totalTokens:10},slots:[{logicalTaskId:x.f.child.taskId,originalTaskId:x.f.child.taskId,predecessorTaskId:x.f.child.taskId,taskId:replacement.taskId,handoffId:replacement.handoffId,requestKey:'replacement_request_key',assignment:x.f.assignment,kind:'replacement',admission:'admitted'}],operations:[{kind:'refresh',requestKey:'prior_refresh_request',intentDigest:'a'.repeat(64),rootTaskId:x.f.target.taskId,previousGeneration:2,generation:3,previousEpoch:1,refreshEpoch:2,attempt:2,checkpointVersion:2,lineageDigest:'e'.repeat(64),admittedTaskIds:[],pendingCount:1,continuation:'yielded',domainCompletion:false}]};
  const write=x.revalidation.revalidate.getMockImplementation()!;
  x.revalidation.revalidate.mockImplementation(async(...args:any[])=>({...await write(...args),refreshEpoch:2}));
  expect(await x.run()).toMatchObject({state:'settled'});expect(x.revalidation.revalidate.mock.calls[0][1].expectedRefreshEpoch).toBe(2);expect(x.completed[0].expectedRefreshEpoch).toBe(2);expect(x.quote.propose).not.toHaveBeenCalled();expect(x.root.wait).not.toHaveBeenCalled();
 });
});

describe('revalidation selection usage persistence',()=>{
 it('does not write a revalidation witness after an unknown usage checkpoint acknowledgement',async()=>{
  const x=await revalidationFixture();x.instructions.checkpointV3.mockRejectedValue(Error('checkpoint may have committed'));
  expect(await x.run()).toMatchObject({state:'unconfirmed'});expect(x.instructions.checkpointV3).toHaveBeenCalledOnce();expect(x.revalidation.revalidate).not.toHaveBeenCalled();expect(x.root.consume).not.toHaveBeenCalled();expect(x.completed).toHaveLength(0);expect(x.quote.propose).not.toHaveBeenCalled();
  expect(JSON.parse(x.instructions.checkpointV3.mock.calls[0][1].command.plannerState).usage.totalTokens).toBe(8);
 });
 it('keeps the known saved selection usage when the later witness response is unknown',async()=>{
  const x=await revalidationFixture();x.revalidation.revalidate.mockImplementation(async()=>{expect(x.checkpoints).toHaveLength(1);throw Error('lost witness acknowledgement');});
  expect(await x.run()).toMatchObject({state:'unconfirmed'});expect(x.checkpoints).toHaveLength(1);expect(JSON.parse(x.checkpoints[0].command.plannerState).usage.totalTokens).toBe(8);expect(x.root.consume).not.toHaveBeenCalled();expect(x.completed).toHaveLength(0);
 });
});
