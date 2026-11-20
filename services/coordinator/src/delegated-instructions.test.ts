import {describe,it,expect,vi} from 'vitest';
import {DelegatedCoordinator} from './delegated-coordinator';
import {DomainError} from '../../../packages/domain/src/errors';
import {commandDigest} from '../../../packages/contracts/src/canonical';
import {NATIVE_ROOT_BLOCKED_RESULT} from '../../../packages/db/src/native-root-lifecycle-schema';
import {NativeGatewayError} from './azure-gateway';
import { nativeInstructionDigest, nativeRootInstructionInputDigest } from '../../../packages/db/src/native-root-instruction-schema';
import {runtimeFixture} from './delegated-instruction-test-fixture';
function qualityReview(input:any,reject=false){const criteria=input.frozenCriteria??['deliverables','consistency','grounding','scope'].map(category=>({category,requirement:`Evaluate ${category}.`}));return{verdict:reject?'reject':'accept',checks:criteria.map((criterion:any,index:number)=>({...('criterionId' in criterion?{criterionId:criterion.criterionId}:criterion),status:reject&&index===0?'missing':'satisfied',passageIds:[input.candidate.passages[0].id]})),repairGuidance:reject?'Supply missing advice.':null};}
async function fixture(){
 const f=await runtimeFixture(),calls:string[]=[],complete:any[]=[],inputCommands:any[]=[],refreshCommands:any[]=[],models:any[]=[];
 let clock:number|undefined;let claimAttempt=1;
 let frame:any={schemaVersion:3,refreshEpoch:0,work:structuredClone(f.baseWork),refresh:null};
 const repository:any={claim:async()=>({selector:f.selector,validUntil:f.instant(30000),identity:f.services.coordinator,authority:f.authority,attempt:claimAttempt,handoff:null}),work:vi.fn(async()=>{throw Error('Legacy work called')}),checkpoint:vi.fn(),yield:vi.fn(),handoff:vi.fn(),inputs:vi.fn(),complete:vi.fn()};
 const initialMetadata={rootDeadlineAt:f.instant(120000),instructionRevision:0,instructionDigest:await nativeInstructionDigest(0,[]),instructions:[],lifetimeChildCount:1,usageFloor:{inputTokens:0,outputTokens:0,totalTokens:0}}; Object.assign(frame,initialMetadata);
 const port:any={workV3:vi.fn(async()=>{calls.push('work');frame.lifetimeChildCount=Math.max(frame.lifetimeChildCount,frame.work.children.length);return structuredClone(frame)}),
  inputsV3:vi.fn(async(_s:any,q:any)=>{inputCommands.push(q);return{schemaVersion:3,instructionRevision:frame.instructionRevision,refreshEpoch:frame.refreshEpoch,receipt:{receipt:{receiptId:'8edee1cf-dc38-4c8a-9894-a16f174da906',digest:'c'.repeat(64)},generation:f.target.generation,dataValidUntil:f.instant(60000),results:q.command.results.map((r:any)=>({...r,outcome:'advice_ready',artifacts:[{reference:f.reference,body:f.body}]}))}};}),
  checkpointV3:vi.fn(async(_s:any,q:any)=>{calls.push('checkpoint');frame.work.checkpointVersion++;return{schemaVersion:3,instructionRevision:frame.instructionRevision,refreshEpoch:frame.refreshEpoch,receipt:{checkpointVersion:frame.work.checkpointVersion,generation:f.target.generation,attempt:claimAttempt,continuation:'running',requestKey:q.command.requestKey}}}),
  yieldV3:vi.fn(async(_s:any,q:any)=>{calls.push('yield');return{schemaVersion:3,instructionRevision:frame.instructionRevision,refreshEpoch:frame.refreshEpoch,receipt:{checkpointVersion:frame.work.checkpointVersion+1,generation:f.target.generation+1,attempt:claimAttempt,continuation:q.command.waitFor.length?'waiting_children':'yielded',requestKey:q.command.requestKey}}}),
  completeV3:vi.fn(async(_s:any,q:any)=>{complete.push(q);return{schemaVersion:3,instructionRevision:frame.instructionRevision,refreshEpoch:frame.refreshEpoch,receipt:{kind:'accepted',publicationDigest:'d'.repeat(64),rootTaskId:f.target.taskId,execution:q.command.result.outcome==='blocked'?'none':'advisory_only',domainCompletion:false}}}),
  refreshV3:vi.fn(async(_s:any,q:any)=>{refreshCommands.push(q);return{schemaVersion:3,instructionRevision:frame.instructionRevision,kind:'refresh',requestKey:q.requestKey,intentDigest:await commandDigest(q),rootTaskId:f.target.taskId,previousGeneration:f.target.generation,generation:f.target.generation+1,previousEpoch:frame.refreshEpoch,refreshEpoch:frame.refreshEpoch+1,attempt:claimAttempt+1,checkpointVersion:frame.work.checkpointVersion+1,lineageDigest:'e'.repeat(64),admittedTaskIds:[],pendingCount:1,continuation:'yielded',domainCompletion:false}}),
  handoffV3:vi.fn(),refreshDispatchV3:vi.fn(),refreshOperationV3:vi.fn()};
 const gateway:any={complete:vi.fn(async(request:any)=>{models.push(JSON.parse(request.input));return{value:request.schemaName==='delegated_advice_quality'?qualityReview(JSON.parse(request.input)):{...f.advice,findings:[]},usage:{inputTokens:2,outputTokens:1,totalTokens:3},deployment:request.role==='escalation'?'gpt-6-astra':'gpt-6.1-sol'}})};
 const run=(signal?:AbortSignal)=>new DelegatedCoordinator({environment:'simulation',services:f.services,repository,instructions:port,now:()=>clock??Date.now(),renewal:{renew:async()=>({validUntil:f.instant(30000)})},gateway,observe:async()=>({result:{state:'allowed'},usableUntil:f.at+30000})}).run(f.target,{deadlineAt:f.at+60000,...(signal?{signal}:{})});
 async function epochOne(pending=false){
  claimAttempt=2;
  const original=structuredClone(f.state); const replacement={...f.child,taskId:'replacement_child',handoffId:'replacement_handoff',state:pending?'ready':'settled',publicationDigest:pending?null:'f'.repeat(64),outcome:pending?null:'advice_ready'};
  frame={...initialMetadata,schemaVersion:3,refreshEpoch:1,work:{...structuredClone(f.baseWork),plannerState:'STALE_DERIVED_CHECKPOINT_MUST_NOT_REACH_MODEL',children:pending?[f.child]:[f.child,replacement]},refresh:{lineageDigest:'e'.repeat(64),planBasis:{checkpointVersion:1,plannerState:JSON.stringify(original),plannerDigest:await commandDigest(original)},usage:{inputTokens:8,outputTokens:2,totalTokens:10},slots:[{logicalTaskId:f.child.taskId,originalTaskId:f.child.taskId,predecessorTaskId:f.child.taskId,taskId:replacement.taskId,handoffId:replacement.handoffId,requestKey:'replacement_request_key',assignment:f.assignment,kind:'replacement',admission:pending?'pending':'admitted'}],operations:[{kind:'refresh',requestKey:'prior_refresh_request',intentDigest:'a'.repeat(64),rootTaskId:f.target.taskId,previousGeneration:2,generation:3,previousEpoch:0,refreshEpoch:1,attempt:2,checkpointVersion:2,lineageDigest:'e'.repeat(64),admittedTaskIds:[],pendingCount:1,continuation:'yielded',domainCompletion:false}]}};
  return replacement;
 }
 return{f,port,repository,run,gateway,setAttempt:(value:number)=>{claimAttempt=value},setClock:(value:number)=>{clock=value},complete,inputCommands,refreshCommands,models,calls,epochOne,get frame(){return frame}};
}
describe('revision-bound coordinator durable source refresh',()=>{
 it.each(['accepted','rejected','unknown'] as const)('keeps the existing refresh fence when evidence expires during %s review, without claiming durable usage',async mode=>{
  const x=await fixture();let clock=x.f.at;const usage:any[]=[],calls:string[]=[];
  const original=x.port.inputsV3.getMockImplementation()!;x.port.inputsV3.mockImplementation(async(...args:any[])=>{const result=await original(...args);result.receipt.dataValidUntil=x.f.instant(20000);return result;});
  const gateway:any={complete:async(request:any)=>{calls.push(request.schemaName);if(request.schemaName==='delegated_advice_quality'){clock=x.f.at+21000;if(mode==='unknown')throw new NativeGatewayError('NETWORK');return{value:mode==='accepted'?qualityReview(JSON.parse(request.input)):qualityReview(JSON.parse(request.input),true),usage:{inputTokens:2,outputTokens:1,totalTokens:3},deployment:'gpt-6-astra'};}return{value:{...x.f.advice,findings:[]},usage:{inputTokens:2,outputTokens:1,totalTokens:3},deployment:'gpt-6.1-sol'};}};
  const runner=new DelegatedCoordinator({environment:'simulation',services:x.f.services,repository:x.repository,instructions:x.port,now:()=>clock,renewal:{renew:async()=>({validUntil:x.f.instant(30000)})},gateway,onUsage:event=>usage.push(event),observe:async()=>({result:{state:'allowed'},usableUntil:x.f.at+30000})});
  expect(await runner.run(x.f.target,{deadlineAt:x.f.at+60000})).toMatchObject({state:'yielded'});
  expect(calls).toEqual(['delegated_root_advice','delegated_advice_quality']);expect(x.port.refreshV3).toHaveBeenCalledTimes(1);expect(x.complete).toHaveLength(0);expect(x.port.checkpointV3).not.toHaveBeenCalled();
  expect(usage.map(item=>item.usage.totalTokens)).toEqual(mode==='unknown'?[3]:[3,3]);
 });

 it('turns confirmed pre-input expiry into one durable same-root refresh without a replacement handoff or completion',async()=>{const x=await fixture();x.port.inputsV3.mockRejectedValue(new DomainError('EVIDENCE_STALE',409,'expired'));expect(await x.run()).toMatchObject({state:'yielded'});expect(x.refreshCommands).toHaveLength(1);expect(x.refreshCommands[0]).toMatchObject({expectedRefreshEpoch:0,expectedCheckpointVersion:2,results:[{handoffId:x.f.child.handoffId,publicationDigest:x.f.child.publicationDigest}]});expect(x.complete).toHaveLength(0);expect(x.models).toHaveLength(0);expect(x.repository.handoff).not.toHaveBeenCalled();});
 it('refreshes withheld checkpoint work without reading old derived text into a model',async()=>{const x=await fixture();x.frame.work.plannerState=null;x.frame.work.checkpoint=null;x.frame.work.historical=true;expect(await x.run()).toMatchObject({state:'yielded'});expect(x.refreshCommands).toHaveLength(1);expect(x.models).toHaveLength(0);});
 it('stops at unknown refresh acknowledgement and never starts a completion or second refresh',async()=>{const x=await fixture();x.port.inputsV3.mockRejectedValue(new DomainError('EVIDENCE_STALE',409,'expired'));x.port.refreshV3.mockRejectedValue(Error('acknowledgement lost'));expect(await x.run()).toMatchObject({state:'unconfirmed'});expect(x.port.refreshV3).toHaveBeenCalledTimes(1);expect(x.complete).toHaveLength(0);expect(x.models).toHaveLength(0);});
 it('confirms exact accepted refresh metadata after a lost acknowledgement without using the fenced lease',async()=>{const x=await fixture();x.port.inputsV3.mockRejectedValue(new DomainError('EVIDENCE_STALE',409,'expired'));const original=x.port.refreshV3.getMockImplementation()!;x.port.refreshV3.mockImplementation(async(...args:any[])=>{const receipt=await original(...args);x.port.refreshOperationV3.mockResolvedValue(receipt);throw Error('accepted response lost');});expect(await x.run()).toMatchObject({state:'yielded'});expect(x.port.refreshOperationV3).toHaveBeenCalledExactlyOnceWith(x.f.target,{instructionRevision:x.frame.instructionRevision,kind:'refresh',requestKey:x.refreshCommands[0].requestKey,intentDigest:await commandDigest(x.refreshCommands[0])});expect(x.complete).toHaveLength(0);expect(x.models).toHaveLength(0);expect(x.port.refreshV3).toHaveBeenCalledTimes(1);});
 it.each(['absent','failed'])('preserves unknown refresh acceptance when metadata lookup is %s',async mode=>{const x=await fixture();x.port.inputsV3.mockRejectedValue(new DomainError('EVIDENCE_STALE',409,'expired'));x.port.refreshV3.mockRejectedValue(Error('ack lost'));if(mode==='absent')x.port.refreshOperationV3.mockResolvedValue(null);else x.port.refreshOperationV3.mockRejectedValue(Error('lookup failed'));expect(await x.run()).toMatchObject({state:'unconfirmed'});expect(x.port.refreshOperationV3).toHaveBeenCalledTimes(1);expect(x.port.refreshV3).toHaveBeenCalledTimes(1);expect(x.complete).toHaveLength(0);expect(x.models).toHaveLength(0);});
 it('preserves the fixed blocked result if SQL confirms memory expiry is not refreshable',async()=>{const x=await fixture();x.port.inputsV3.mockRejectedValue(new DomainError('EVIDENCE_STALE',409,'expired'));x.port.refreshV3.mockRejectedValue(new DomainError('EVIDENCE_STALE',409,'semantic memory expiry'));expect(await x.run()).toMatchObject({state:'settled'});expect(x.complete[0].command.result).toEqual(NATIVE_ROOT_BLOCKED_RESULT);expect(x.complete[0].command.coverage).toEqual([{taskId:x.f.child.taskId,disposition:'advice_ready'}]);});
 it('treats a misbound operation receipt as unknown rather than issuing another write',async()=>{const x=await fixture();x.port.inputsV3.mockRejectedValue(new DomainError('EVIDENCE_STALE',409,'expired'));const fn=x.port.refreshV3.getMockImplementation()!;x.port.refreshV3.mockImplementation(async(...args:any[])=>({...await fn(...args),requestKey:'different_request_key'}));expect(await x.run()).toMatchObject({state:'unconfirmed'});expect(x.complete).toHaveLength(0);});
 it('discards aggregate model output when its final checkpoint expires and refreshes once',async()=>{const x=await fixture();x.port.checkpointV3.mockRejectedValue(new DomainError('EVIDENCE_STALE',409,'expired after model'));expect(await x.run()).toMatchObject({state:'yielded'});expect(x.models).toHaveLength(2);expect(x.refreshCommands).toHaveLength(1);expect(x.complete).toHaveLength(0);});
 it('refreshes when the completion transaction rejects expiry after a confirmed checkpoint',async()=>{const x=await fixture();x.port.completeV3.mockRejectedValue(new DomainError('EVIDENCE_STALE',409,'expired at completion'));expect(await x.run()).toMatchObject({state:'yielded'});expect(x.port.completeV3).toHaveBeenCalledTimes(1);expect(x.refreshCommands[0].expectedCheckpointVersion).toBe(3);expect(x.port.refreshV3).toHaveBeenCalledTimes(1);});
 it('discards returned model output when its input evidence expires before publication',async()=>{const x=await fixture();const inputs=x.port.inputsV3.getMockImplementation()!;x.port.inputsV3.mockImplementation(async(...args:any[])=>{const r=await inputs(...args);r.receipt.dataValidUntil=x.f.instant(5000);return r;});x.setClock(x.f.at);const model={...x.f.advice,summary:'expired model output'};x.port.workV3.mockImplementation(async()=>structuredClone(x.frame));// Assert the evidence boundary by advancing only the injected runtime clock.
 const engine=new DelegatedCoordinator({environment:'simulation',services:x.f.services,repository:x.repository,instructions:x.port,now:()=>x.models.length?x.f.at+6000:x.f.at,renewal:{renew:async()=>({validUntil:x.f.instant(30000)})},gateway:{complete:async(request)=>{x.models.push({returned:true});return{value:request.schema.parse({...model,findings:[]}),usage:{inputTokens:2,outputTokens:1,totalTokens:3},deployment:'gpt-6.1-sol' as const}}},observe:async()=>({result:{state:'allowed'},usableUntil:x.f.at+30000})});
 expect(await engine.run(x.f.target,{deadlineAt:x.f.at+60000})).toMatchObject({state:'yielded'});expect(x.models).toHaveLength(1);expect(x.complete).toHaveLength(0);expect(x.refreshCommands).toHaveLength(1);
 });
 it('cancels the bounded imminent-expiry wait immediately when the operator signal aborts',async()=>{const x=await fixture();const original=x.port.inputsV3.getMockImplementation()!;x.port.inputsV3.mockImplementation(async(...args:any[])=>{const value=await original(...args);value.receipt.dataValidUntil=x.f.instant(3500);return value;});const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),20);try{expect(await x.run(controller.signal)).toMatchObject({state:'interrupted'});}finally{clearTimeout(timer);}expect(x.port.refreshV3).not.toHaveBeenCalled();expect(x.models).toHaveLength(0);expect(x.complete).toHaveLength(0);});
 it('consumes only active replacement publication and keeps original successful coverage',async()=>{const x=await fixture();const replacement=await x.epochOne();expect(await x.run()).toMatchObject({state:'settled'});expect(x.inputCommands[0].command.results).toEqual([{handoffId:replacement.handoffId,publicationDigest:replacement.publicationDigest}]);expect(JSON.stringify(x.models)).not.toContain('STALE_DERIVED');expect(x.models[0].plan).toEqual(x.f.plan);expect(x.complete[0].command.coverage).toEqual([{taskId:x.f.child.taskId,disposition:'advice_ready'},{taskId:replacement.taskId,disposition:'advice_ready'}]);expect(x.complete[0].expectedRefreshEpoch).toBe(1);});
 it('admits pending replacement via DB dispatch and waits only on the materialized task',async()=>{const x=await fixture();const replacement=await x.epochOne(true);x.port.refreshDispatchV3.mockImplementation(async(_s:any,q:any)=>{x.frame.refresh.slots[0].admission='admitted';x.frame.work.children.push(replacement);return{schemaVersion:3,instructionRevision:x.frame.instructionRevision,kind:'dispatch',requestKey:q.requestKey,intentDigest:await commandDigest(q),rootTaskId:x.f.target.taskId,previousGeneration:3,generation:3,previousEpoch:1,refreshEpoch:1,attempt:2,checkpointVersion:2,lineageDigest:'e'.repeat(64),admittedTaskIds:[replacement.taskId],pendingCount:0,continuation:'running',domainCompletion:false}});expect(await x.run()).toMatchObject({state:'yielded'});expect(x.port.refreshDispatchV3).toHaveBeenCalledTimes(1);expect(x.repository.handoff).not.toHaveBeenCalled();expect(x.port.yieldV3.mock.calls[0][1].command.waitFor).toEqual([replacement.taskId]);expect(x.complete).toHaveLength(0);});
 it('reserves more slots than concurrency but admits only the available window and waits only on real children',async()=>{const x=await fixture();const replacement=await x.epochOne(true);x.f.grant.scope.limits.maxConcurrentChildren=1;x.frame.work.grant.scope.limits.maxConcurrentChildren=1;x.f.authority.grantDigest=await commandDigest(x.f.grant);const secondAssignment={...x.f.assignment,stepId:'second_step',title:'Second original task'};const original=JSON.parse(x.frame.refresh.planBasis.plannerState);original.slots.push({taskId:'second_original',handoffId:'second_original_handoff',requestKey:'second_original_key',assignment:secondAssignment});x.frame.refresh.planBasis.plannerState=JSON.stringify(original);x.frame.refresh.planBasis.plannerDigest=await commandDigest(original);x.frame.work.children.push({...x.f.child,taskId:'second_original',handoffId:'second_original_handoff',assignment:secondAssignment});x.frame.refresh.slots.push({...x.frame.refresh.slots[0],logicalTaskId:'second_original',originalTaskId:'second_original',predecessorTaskId:'second_original',taskId:'second_replacement',handoffId:'second_replacement_handoff',requestKey:'second_replacement_key',assignment:secondAssignment});x.port.refreshDispatchV3.mockImplementation(async(_s:any,q:any)=>{x.frame.refresh.slots[0].admission='admitted';x.frame.work.children.push(replacement);return{schemaVersion:3,instructionRevision:x.frame.instructionRevision,kind:'dispatch',requestKey:q.requestKey,intentDigest:await commandDigest(q),rootTaskId:x.f.target.taskId,previousGeneration:3,generation:3,previousEpoch:1,refreshEpoch:1,attempt:2,checkpointVersion:2,lineageDigest:'e'.repeat(64),admittedTaskIds:[replacement.taskId],pendingCount:1,continuation:'running',domainCompletion:false}});expect(await x.run()).toMatchObject({state:'yielded'});expect(x.port.refreshDispatchV3).toHaveBeenCalledTimes(1);expect(x.port.yieldV3.mock.calls[0][1].command.waitFor).toEqual([replacement.taskId]);expect(x.frame.refresh.slots[1].admission).toBe('pending');expect(x.repository.handoff).not.toHaveBeenCalled();});
 it('does not continue or yield after an unknown admission response',async()=>{const x=await fixture();await x.epochOne(true);x.port.refreshDispatchV3.mockRejectedValue(Error('lost dispatch acknowledgement'));expect(await x.run()).toMatchObject({state:'unconfirmed'});expect(x.port.refreshDispatchV3).toHaveBeenCalledTimes(1);expect(x.port.yieldV3).not.toHaveBeenCalled();expect(x.complete).toHaveLength(0);});
 it('discovers an accepted refresh after a lost acknowledgement without creating another epoch',async()=>{
  const x=await fixture();x.port.inputsV3.mockRejectedValue(new DomainError('EVIDENCE_STALE',409,'expired'));
  const original=x.port.refreshV3.getMockImplementation()!;let replacement:any;
  x.port.refreshV3.mockImplementation(async(...args:any[])=>{const receipt=await original(...args);replacement=await x.epochOne(true);x.frame.work.checkpointVersion=3;const {schemaVersion:_schema,instructionRevision:_revision,...operation}=receipt;x.frame.refresh.operations=[operation];throw Error('accepted refresh acknowledgement lost');});
  expect(await x.run()).toMatchObject({state:'unconfirmed'});
  x.f.target.generation=4;x.f.selector.generation=4;
  x.repository.claim=async()=>({selector:x.f.selector,validUntil:x.f.instant(30000),identity:x.f.services.coordinator,authority:x.f.authority,attempt:2,handoff:null});
  x.port.refreshDispatchV3.mockImplementation(async(_s:any,q:any)=>{x.frame.refresh.slots[0].admission='admitted';x.frame.work.children.push(replacement);return{schemaVersion:3,instructionRevision:x.frame.instructionRevision,kind:'dispatch',requestKey:q.requestKey,intentDigest:await commandDigest(q),rootTaskId:x.f.target.taskId,previousGeneration:4,generation:4,previousEpoch:1,refreshEpoch:1,attempt:2,checkpointVersion:3,lineageDigest:'e'.repeat(64),admittedTaskIds:[replacement.taskId],pendingCount:0,continuation:'running',domainCompletion:false}});
  x.port.yieldV3.mockImplementation(async(_s:any,q:any)=>({schemaVersion:3,instructionRevision:x.frame.instructionRevision,refreshEpoch:1,receipt:{checkpointVersion:4,generation:5,attempt:2,continuation:'waiting_children',requestKey:q.command.requestKey}}));
  expect(await x.run()).toMatchObject({state:'yielded'});expect(x.port.refreshV3).toHaveBeenCalledTimes(1);expect(x.port.refreshDispatchV3).toHaveBeenCalledTimes(1);expect(x.complete).toHaveLength(0);
 });
 it('discovers an accepted admission after acknowledgement loss and does not materialize it twice',async()=>{
  const x=await fixture();const replacement=await x.epochOne(true);
  x.port.refreshDispatchV3.mockImplementation(async(_s:any,q:any)=>{x.frame.refresh.slots[0].admission='admitted';x.frame.work.children.push(replacement);x.frame.refresh.operations.push({kind:'dispatch',requestKey:q.requestKey,intentDigest:await commandDigest(q),rootTaskId:x.f.target.taskId,previousGeneration:3,generation:3,previousEpoch:1,refreshEpoch:1,attempt:2,checkpointVersion:2,lineageDigest:'e'.repeat(64),admittedTaskIds:[replacement.taskId],pendingCount:0,continuation:'running',domainCompletion:false});throw Error('accepted admission acknowledgement lost');});
  expect(await x.run()).toMatchObject({state:'unconfirmed'});x.f.target.generation=4;x.f.selector.generation=4;
  x.repository.claim=async()=>({selector:x.f.selector,validUntil:x.f.instant(30000),identity:x.f.services.coordinator,authority:x.f.authority,attempt:3,handoff:null});
  x.port.yieldV3.mockImplementation(async(_s:any,q:any)=>({schemaVersion:3,instructionRevision:x.frame.instructionRevision,refreshEpoch:1,receipt:{checkpointVersion:3,generation:5,attempt:3,continuation:'waiting_children',requestKey:q.command.requestKey}}));
  expect(await x.run()).toMatchObject({state:'yielded'});expect(x.port.refreshDispatchV3).toHaveBeenCalledTimes(1);expect(x.port.refreshV3).not.toHaveBeenCalled();expect(x.port.yieldV3.mock.calls[0][1].command.waitFor).toEqual([replacement.taskId]);
 });
 it('rejects refresh work that omits its committed epoch operation metadata',async()=>{const x=await fixture();await x.epochOne();x.frame.refresh.operations=[];expect(await x.run()).toMatchObject({state:'interrupted'});expect(x.inputCommands).toHaveLength(0);expect(x.models).toHaveLength(0);expect(x.complete).toHaveLength(0);});
});

const changedText = 'Revise to a fully remote two-hour workshop with one 10-minute break. Preserve the practical exercises.';
async function amendedFixture() {
  const x = await fixture();
  x.frame.instructionRevision = 1;
  x.frame.instructions = [{sequence: 1, text: changedText, recordedAt: x.f.instant(-1000)}];
  x.frame.instructionDigest = await nativeInstructionDigest(1, x.frame.instructions);
  x.frame.refreshEpoch = 4; x.frame.refresh = null;
  x.frame.lifetimeChildCount = 3;
  x.frame.usageFloor = {inputTokens: 7, outputTokens: 2, totalTokens: 9};
  x.frame.work = {...x.frame.work, title: 'Team workshop', prompt: 'Plan a four-hour in-person workshop with practical exercises.', plannerState: null, checkpoint: null, children: [], inputReceipts: [], historical: true};
  x.setAttempt(2);
  const implementation = x.gateway.complete.getMockImplementation()!;
  x.gateway.complete.mockImplementation(async(request:any) => {
    if (request.schemaName !== 'delegated_operator_plan') return implementation(request);
    x.models.push(JSON.parse(request.input));
    return {value: request.schema.parse({objective: 'A remote two-hour workshop with practical exercises and one ten-minute break.', steps: [], limitations: [], question: null}), usage: {inputTokens: 2, outputTokens: 1, totalTokens: 3}, deployment: 'gpt-6.1-sol'};
  });
  return x;
}
describe('same-root ordered operator constraints', () => {
  it('keeps immutable original text and full ordered updates in planning, synthesis and quality with global epoch4 and no active refresh', async() => {
    const x = await amendedFixture(); expect(await x.run()).toMatchObject({state: 'settled', taskId: x.f.target.taskId});
    expect(x.models).toHaveLength(3);
    for (const context of [x.models[0], x.models[1], x.models[2].context]) {
      expect(context.prompt).toBe(x.frame.work.prompt); expect(context.operatorInstructions).toEqual(x.frame.instructions);
      expect(context).not.toHaveProperty('instructionDigest'); expect(JSON.stringify(context)).not.toContain('requestKey');
    }
    expect(x.models[0].specialistLimit).toBe(6);
    const saved = JSON.parse(x.port.checkpointV3.mock.calls.at(-1)[1].command.plannerState);
    expect(saved.usage).toEqual({inputTokens:13,outputTokens:5,totalTokens:18}); expect(saved.attempt).toBe(2);
    expect(saved.inputDigest).toBe(await nativeRootInstructionInputDigest(x.frame.work,1,x.frame.instructionDigest));
    for (const call of [...x.port.checkpointV3.mock.calls,...x.port.completeV3.mock.calls]) expect(call[1]).toMatchObject({schemaVersion:3,expectedInstructionRevision:1,expectedRefreshEpoch:4});
    expect(x.port.refreshV3).not.toHaveBeenCalled();
    for(const method of ['work','checkpoint','yield','inputs','handoff','complete']) expect(x.repository[method]).not.toHaveBeenCalled();
  });
  it('passes all sixteen4000-character updates intact and in order to every model', async() => {
    const x=await amendedFixture();x.frame.instructionRevision=16;x.frame.instructions=Array.from({length:16},(_,i)=>({sequence:i+1,text:String(i+1).padEnd(4000,'x'),recordedAt:x.f.instant(-1000)}));x.frame.instructionDigest=await nativeInstructionDigest(16,x.frame.instructions);
    expect(await x.run()).toMatchObject({state:'settled'});for(const m of x.models)expect((m.context??m).operatorInstructions).toEqual(x.frame.instructions);
  });
  it.each(['digest','order','unknown_metadata'] as const)('rejects malformed immutable update history before any model or mutation: %s', async mode => {
    const x=await amendedFixture();if(mode==='digest')x.frame.instructions[0].text+=' altered';else if(mode==='order')x.frame.instructions[0].sequence=2;else x.frame.instructions[0].requestKey='private-key';
    expect(await x.run()).toMatchObject({state:'interrupted'});expect(x.models).toHaveLength(0);expect(x.port.checkpointV3).not.toHaveBeenCalled();expect(x.complete).toHaveLength(0);
  });
  it('rejects an obsolete cached original plan before using old assignments or outputs',async()=>{
    const x=await amendedFixture();x.frame.work.plannerState=JSON.stringify(x.f.state);expect(await x.run()).toMatchObject({state:'interrupted'});expect(x.models).toHaveLength(0);expect(x.port.inputsV3).not.toHaveBeenCalled();expect(x.complete).toHaveLength(0);
  });
  it('does not downgrade to v2 or legacy when v3 work is unavailable',async()=>{
    const x=await amendedFixture();x.port.workV3.mockRejectedValue(Error('unsupported v3'));expect(await x.run()).toMatchObject({state:'interrupted'});expect(x.repository.work).not.toHaveBeenCalled();expect(x.models).toHaveLength(0);
  });
  it('preserves lifetime child capacity although all previous-revision children are excluded',async()=>{
    const x=await amendedFixture();x.frame.lifetimeChildCount=12;expect(await x.run()).toMatchObject({state:'settled'});expect(x.models[0].specialistLimit).toBe(0);expect(x.port.handoffV3).not.toHaveBeenCalled();expect(x.complete[0].command.coverage).toEqual([]);
  });
  it('rejects a cached state that resets cumulative root usage below the immutable floor',async()=>{
    const x=await amendedFixture();x.frame.work.plannerState=JSON.stringify({...x.f.state,slots:[],inputDigest:await nativeRootInstructionInputDigest(x.frame.work,1,x.frame.instructionDigest)});expect(await x.run()).toMatchObject({state:'interrupted'});expect(x.models).toHaveLength(0);expect(x.complete).toHaveLength(0);
  });
  it('treats a mismatched revision checkpoint acknowledgement as unknown and cannot complete',async()=>{
    const x=await amendedFixture();const save=x.port.checkpointV3.getMockImplementation()!;x.port.checkpointV3.mockImplementation(async(...args:any[])=>({...await save(...args),instructionRevision:2}));expect(await x.run()).toMatchObject({state:'unconfirmed'});expect(x.models).toHaveLength(1);expect(x.port.checkpointV3).toHaveBeenCalledOnce();expect(x.complete).toHaveLength(0);
  });
  it('never retries a possibly committed checkpoint after acknowledgement loss',async()=>{
    const x=await amendedFixture();x.port.checkpointV3.mockRejectedValue(Error('ack lost'));expect(await x.run()).toMatchObject({state:'unconfirmed'});expect(x.port.checkpointV3).toHaveBeenCalledOnce();expect(x.complete).toHaveLength(0);expect(x.models).toHaveLength(1);
  });
  it.each(['revision','history','originalPrompt','usageFloor','lifetimeCount','rootDeadline','site'] as const)('does not rebind changed %s after an accepted handoff',async mode=>{
    const x=await amendedFixture();const plan=x.gateway.complete.getMockImplementation()!;x.gateway.complete.mockImplementation(async(q:any)=>{const model=await plan(q);if(q.schemaName==='delegated_operator_plan')model.value.steps=[{title:'Review remote workshop',brief:'Use the current two-hour workshop constraint.',role:'planning'}];return model;});
    x.port.handoffV3.mockImplementation(async(_s:any,q:any)=>{
      const receipt={schemaVersion:3,instructionRevision:1,refreshEpoch:4,receipt:{kind:'accepted',execution:'advisory_only',digest:await commandDigest(q.command.handoff)}};
      if(mode==='revision'){x.frame.instructions.push({sequence:2,text:'Newer update',recordedAt:x.f.instant()});x.frame.instructionRevision=2;x.frame.instructionDigest=await nativeInstructionDigest(2,x.frame.instructions);}
      else if(mode==='history'){x.frame.instructions[0].text='changed immutable history';x.frame.instructionDigest=await nativeInstructionDigest(1,x.frame.instructions);}
      else if(mode==='originalPrompt')x.frame.work.prompt='rewritten source authority';
      else if(mode==='usageFloor')x.frame.usageFloor={inputTokens:8,outputTokens:2,totalTokens:10};
      else if(mode==='lifetimeCount')x.frame.lifetimeChildCount=2;
      else if(mode==='rootDeadline')x.frame.rootDeadlineAt=x.f.instant(600000);
      else x.frame.work.siteId='different_site';
      return receipt;
    });
    expect(await x.run()).toMatchObject({state:'interrupted'});expect(x.port.handoffV3).toHaveBeenCalledOnce();expect(x.port.yieldV3).not.toHaveBeenCalled();expect(x.complete).toHaveLength(0);expect(x.models).toHaveLength(1);
  });
  it('fences a pending quality call on cancellation and cannot save or publish the obsolete review',async()=>{
    const x=await amendedFixture(),controller=new AbortController();const model=x.gateway.complete.getMockImplementation()!;x.gateway.complete.mockImplementation(async(q:any)=>{if(q.schemaName==='delegated_advice_quality')controller.abort();return model(q);});
    expect(await x.run(controller.signal)).toMatchObject({state:'interrupted'});expect(x.port.checkpointV3).toHaveBeenCalledTimes(1);expect(x.complete).toHaveLength(0);
  });
  it('refreshes only current-revision results using the current instruction version and lifetime epoch',async()=>{
    const x=await amendedFixture();const state={...x.f.state,usage:x.frame.usageFloor,inputDigest:await nativeRootInstructionInputDigest(x.frame.work,1,x.frame.instructionDigest)};x.frame.work.plannerState=JSON.stringify(state);x.frame.work.children=[x.f.child];
    x.port.inputsV3.mockRejectedValue(new DomainError('EVIDENCE_STALE',409,'current evidence expired'));
    expect(await x.run()).toMatchObject({state:'yielded'});expect(x.refreshCommands[0]).toMatchObject({schemaVersion:3,expectedInstructionRevision:1,expectedRefreshEpoch:4,results:[{handoffId:x.f.child.handoffId,publicationDigest:x.f.child.publicationDigest}]});expect(x.models).toHaveLength(0);expect(x.complete).toHaveLength(0);
  });
  it('rejects a refresh plan basis from an earlier revision even if its planner hash is internally valid',async()=>{
    const x=await fixture();await x.epochOne();x.frame.instructionRevision=1;x.frame.instructions=[{sequence:1,text:changedText,recordedAt:x.f.instant(-1000)}];x.frame.instructionDigest=await nativeInstructionDigest(1,x.frame.instructions);
    expect(await x.run()).toMatchObject({state:'interrupted'});expect(x.models).toHaveLength(0);expect(x.port.inputsV3).not.toHaveBeenCalled();
  });
});
describe('original root deadline after paused instruction updates',()=>{
 it('caps the exact new child envelope to the original root deadline after elapsed time',async()=>{
  const x=await amendedFixture();x.frame.rootDeadlineAt=x.f.instant(45000);const plan=x.gateway.complete.getMockImplementation()!;
  x.gateway.complete.mockImplementation(async(q:any)=>{const value=await plan(q);if(q.schemaName==='delegated_operator_plan')value.value.steps=[{title:'Prepare remote exercises',brief:'Draft exercises for two hours.',role:'planning'}];return value;});
  x.port.handoffV3.mockImplementation(async(_s:any,q:any)=>{const {handoff,assignment}=q.command;expect(handoff.deadlineAt).toBe(x.frame.rootDeadlineAt);expect(handoff.authority).toEqual(x.f.authority);expect(handoff.attemptLimit).toBe(4);x.frame.work.children.push({taskId:handoff.childTaskId,handoffId:handoff.handoffId,generation:1,assignmentVersion:1,state:'ready',publicationDigest:null,outcome:null,assignment});x.frame.lifetimeChildCount++;return{schemaVersion:3,instructionRevision:1,refreshEpoch:4,receipt:{kind:'accepted',execution:'advisory_only',digest:await commandDigest(handoff)}};});
  expect(await x.run()).toMatchObject({state:'yielded'});expect(x.port.handoffV3).toHaveBeenCalledOnce();expect(x.port.yieldV3).toHaveBeenCalledOnce();expect(x.models).toHaveLength(1);
 });
 it('does not start a planner when the original root deadline is expired',async()=>{
  const x=await amendedFixture();x.frame.rootDeadlineAt=x.f.instant(-1);expect(await x.run()).toMatchObject({state:'interrupted'});expect(x.models).toHaveLength(0);expect(x.port.checkpointV3).not.toHaveBeenCalled();expect(x.port.handoffV3).not.toHaveBeenCalled();
 });
});
describe('v3 irreversible-invocation fences',()=>{
 it('never retries a potentially accepted child handoff or falls through to legacy',async()=>{
  const x=await amendedFixture();const plan=x.gateway.complete.getMockImplementation()!;x.gateway.complete.mockImplementation(async(q:any)=>{const value=await plan(q);if(q.schemaName==='delegated_operator_plan')value.value.steps=[{title:'Prepare exercises',brief:'Draft the remote two-hour plan.',role:'planning'}];return value;});x.port.handoffV3.mockRejectedValue(Error('possible accepted write'));
  expect(await x.run()).toMatchObject({state:'unconfirmed'});expect(x.port.handoffV3).toHaveBeenCalledOnce();expect(x.port.workV3).toHaveBeenCalledOnce();expect(x.port.yieldV3).not.toHaveBeenCalled();expect(x.repository.handoff).not.toHaveBeenCalled();expect(x.complete).toHaveLength(0);
 });
 it('does not accept refresh recovery metadata from another instruction revision',async()=>{
  const x=await fixture();x.port.inputsV3.mockRejectedValue(new DomainError('EVIDENCE_STALE',409,'expired'));const refresh=x.port.refreshV3.getMockImplementation()!;x.port.refreshV3.mockImplementation(async(...args:any[])=>{const receipt=await refresh(...args);x.port.refreshOperationV3.mockResolvedValue({...receipt,instructionRevision:1});throw Error('ack lost');});
  expect(await x.run()).toMatchObject({state:'unconfirmed'});expect(x.port.refreshV3).toHaveBeenCalledOnce();expect(x.port.refreshOperationV3).toHaveBeenCalledOnce();expect(x.complete).toHaveLength(0);
 });
 it('rejects simultaneous refresh and instruction runtime ports before claiming',async()=>{
  const x=await fixture();expect(()=>new DelegatedCoordinator({environment:'simulation',services:x.f.services,repository:x.repository,refresh:x.port,instructions:x.port,renewal:{renew:async()=>({validUntil:x.f.instant(30000)})},gateway:x.gateway,observe:async()=>({result:{state:'allowed'},usableUntil:x.f.at+30000})})).toThrow();expect(x.port.workV3).not.toHaveBeenCalled();
 });
});
