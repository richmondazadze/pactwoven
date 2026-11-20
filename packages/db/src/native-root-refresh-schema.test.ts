import { describe, expect, it } from 'vitest';
import { commandDigest } from '../../contracts/src/canonical';
import { NativeCoordinatorStateSchema, NativeRootRefreshBindingSchema, NativeRootRefreshOperationReceiptSchema,
 NativeRootRefreshCommandSchema, NativeRootRefreshDispatchCommandSchema, NativeRootRefreshSlotSchema,
 NativePublicSourceObservationSchema, NativeRootOriginalPlanBasisSchema, nativeRootRefreshRequestKey } from './native-root-refresh-schema';
const digest='a'.repeat(64),scope={environment:'simulation' as const,organizationId:'org',rootTaskId:'root',generation:1};
const command={schemaVersion:2 as const,expectedRefreshEpoch:0,expectedCheckpointVersion:1,results:[{handoffId:'handoff_A',publicationDigest:digest}]};
const assignment={schemaVersion:1 as const,stepId:'step_1',title:'Review source',brief:'Use original evidence.',role:'research' as const,memoryReferences:[]};
const state={schemaVersion:1,inputDigest:digest,plan:{objective:'Review the source.',steps:[],limitations:[],question:null},slots:[{taskId:'task',handoffId:'handoff',requestKey:'original_request',assignment}],usage:{inputTokens:1,outputTokens:1,totalTokens:2},bounded:false,attempt:1};
const receipt={kind:'refresh',requestKey:'original_refresh_request',intentDigest:digest,rootTaskId:'root',previousGeneration:1,generation:2,previousEpoch:0,refreshEpoch:1,attempt:2,checkpointVersion:2,lineageDigest:digest,admittedTaskIds:[],pendingCount:1,continuation:'yielded',domainCompletion:false};
const observation={requestedUrl:'https://example.com/',finalUrl:'https://example.com/page',sourceDigest:digest,observedAt:'2026-11-19T04:00:00Z',validUntil:'2026-11-19T04:05:00Z',evidenceIds:['source_1']};
describe('refresh wire contracts and stable identity',()=>{
 it('derives the exact canonical operation key and includes scope/generation',async()=>{
  const expected='c3_'+await commandDigest({domain:'pactwoven.native.refresh.v2',...scope,command});
  expect(await nativeRootRefreshRequestKey('refresh',scope,command)).toBe(expected);
  expect(await nativeRootRefreshRequestKey('refresh',scope,{results:command.results,expectedCheckpointVersion:1,expectedRefreshEpoch:0,schemaVersion:2})).toBe(expected);
  for(const altered of[{...scope,organizationId:'other'},{...scope,rootTaskId:'other'},{...scope,generation:2}])expect(await nativeRootRefreshRequestKey('refresh',altered,command)).not.toBe(expected);
  expect(NativeRootRefreshCommandSchema.parse({...command,requestKey:expected}).requestKey).toBe(expected);
 });
 it('separates dispatch keys and binds exact pending slot',async()=>{
  const d={schemaVersion:2 as const,expectedRefreshEpoch:1,expectedCheckpointVersion:2,lineageDigest:digest,logicalTaskId:'slot_1'};
  const key=await nativeRootRefreshRequestKey('dispatch',scope,d);expect(key).toMatch(/^c3_[a-f0-9]{64}$/);
  expect(await nativeRootRefreshRequestKey('dispatch',scope,{...d,logicalTaskId:'slot_2'})).not.toBe(key);
  expect(NativeRootRefreshDispatchCommandSchema.safeParse({...d,requestKey:key,expectedRefreshEpoch:0}).success).toBe(false);
 });
 it.each(['duplicates','unsorted','changed_fields'])('rejects %s in refresh basis',kind=>{
  const results=kind==='duplicates'?[command.results[0],command.results[0]]:kind==='unsorted'?[{handoffId:'z',publicationDigest:digest},{handoffId:'a',publicationDigest:digest}]:command.results;
  expect(NativeRootRefreshCommandSchema.safeParse({...command,requestKey:'original_refresh_request',results,...(kind==='changed_fields'?{url:'https://forged.invalid'}:{})}).success).toBe(false);
 });
 it('never permits null lineage for a current epoch',()=>{
  expect(NativeRootRefreshBindingSchema.safeParse({refreshEpoch:0,lineageDigest:null}).success).toBe(true);
  expect(NativeRootRefreshBindingSchema.safeParse({refreshEpoch:1,lineageDigest:digest}).success).toBe(true);
  expect(NativeRootRefreshBindingSchema.safeParse({refreshEpoch:1,lineageDigest:null}).success).toBe(false);
  expect(NativeRootRefreshBindingSchema.safeParse({refreshEpoch:0,lineageDigest:digest}).success).toBe(false);
 });
 it('rejects impossible receipt generation, authority, and admission claims',()=>{
  expect(NativeRootRefreshOperationReceiptSchema.safeParse(receipt).success).toBe(true);
  for(const patch of[{generation:1},{refreshEpoch:0},{domainCompletion:true},{admittedTaskIds:['task']},{continuation:'running'},{attempt:5}])expect(NativeRootRefreshOperationReceiptSchema.safeParse({...receipt,...patch}).success).toBe(false);
 });
 it('accepts exactly one derived admission without resetting epoch or generation',()=>{
  const d={...receipt,kind:'dispatch',previousEpoch:1,previousGeneration:2,admittedTaskIds:['task'],continuation:'running'};
  expect(NativeRootRefreshOperationReceiptSchema.safeParse(d).success).toBe(true);
  for(const patch of[{admittedTaskIds:[]},{admittedTaskIds:['task','task']},{generation:3},{refreshEpoch:2}])expect(NativeRootRefreshOperationReceiptSchema.safeParse({...d,...patch}).success).toBe(false);
 });
 it('cannot call an unmaterialized slot retained success',()=>{
  const slot={logicalTaskId:'logical',originalTaskId:'original',predecessorTaskId:null,taskId:'task',handoffId:'handoff',requestKey:'original_request_key',assignment,kind:'retained',admission:'pending'};
  expect(NativeRootRefreshSlotSchema.safeParse(slot).success).toBe(false);expect(NativeRootRefreshSlotSchema.safeParse({...slot,kind:'replacement'}).success).toBe(true);
 });
 it('validates original plan shape and rejects duplicate identity slots',()=>{
  expect(NativeCoordinatorStateSchema.safeParse(state).success).toBe(true);
  expect(NativeCoordinatorStateSchema.safeParse({...state,slots:[state.slots[0],state.slots[0]]}).success).toBe(false);
  expect(NativeRootOriginalPlanBasisSchema.safeParse({checkpointVersion:1,plannerState:JSON.stringify(state),plannerDigest:digest}).success).toBe(true);
  expect(NativeRootOriginalPlanBasisSchema.safeParse({checkpointVersion:1,plannerState:'{"arbitrary":"derived advice"}',plannerDigest:digest}).success).toBe(false);
 });
 it('rejects inconsistent saved usage before restoring original planning state',()=>{
  expect(NativeCoordinatorStateSchema.safeParse({...state,usage:{inputTokens:2,outputTokens:3,totalTokens:4}}).success).toBe(false);
 });
 it.each(['http://example.com/','https://secret@example.com/','https://example.com/#secret','invalid'])('rejects invalid observation URL %s',url=>{
  expect(NativePublicSourceObservationSchema.safeParse({...observation,requestedUrl:url}).success).toBe(false);
 });
 it('rejects expired/inverted observation intervals and duplicate evidence IDs',()=>{
  expect(NativePublicSourceObservationSchema.safeParse(observation).success).toBe(true);
  expect(NativePublicSourceObservationSchema.safeParse({...observation,validUntil:observation.observedAt}).success).toBe(false);
  expect(NativePublicSourceObservationSchema.safeParse({...observation,evidenceIds:['x','x']}).success).toBe(false);
 });
});
