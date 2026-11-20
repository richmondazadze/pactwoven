import {describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {commandDigest} from '../../../packages/contracts/src/canonical.js';
import type {NativeModelGateway,ModelRequest} from '../../coordinator/src/azure-gateway.js';
import {selectEquipmentService} from './equipment-selection.js';
import type {EquipmentCatalogue} from './equipment-optimizer.js';
const scope={organizationId:'org',siteId:'site',rootTaskId:'root',instructionRevision:1};
const catalogue:EquipmentCatalogue={version:1,currency:'USD',provenance:'controlled_demo_catalogue',offers:[{id:'seats',label:'Twenty seats',seats:20,microphones:0,projectors:0,priceMinor:5000},{id:'av',label:'Audio and projection',seats:0,microphones:2,projectors:1,priceMinor:8000}]};
const defaultOutput={decision:'use_service',reason:'Find the cheapest package matching the workshop needs.',demand:{seats:20,microphones:2,projectors:1,budgetMinor:30000},supportingArtifactIds:['planning_artifact'],assumptions:[]};
async function fixture(output:unknown=defaultOutput){
 const body={schemaVersion:1,kind:'delegated_advice_v1',advisoryOnly:true,domainCompletion:false,stepId:'equipment',role:'planning',advice:{title:'Workshop equipment',summary:'Twenty seats and audio are needed.',findings:[{text:'Plan seating for twenty people.',kind:'inference',citations:[]}],recommendations:['Compare compatible equipment bundles within $300.'],limitations:[],question:null},evidence:[],deployment:'gpt-6.1-sol',usage:{inputTokens:20,outputTokens:30,totalTokens:50}};
 const accepted=[{scope,artifactId:'planning_artifact',digest:await commandDigest(body),body}];
 const complete=vi.fn(async<T>(request:ModelRequest<T>)=>({value:request.schema.parse(output),usage:{inputTokens:100,outputTokens:50,totalTokens:150},deployment:'gpt-6.1-sol'}));
 const gateway:NativeModelGateway={async complete<T>(request:ModelRequest<T>){const result=await complete(request);return {...result,value:request.schema.parse(result.value)};}};return {options:{scope,inputReceipt:{receiptId:randomUUID(),digest:'a'.repeat(64)},operatorPrompt:'Plan an in-person workshop for twenty people with $300 equipment budget.',accepted,catalogue,gateway,signal:new AbortController().signal},complete};
}
describe('actual-specialist structured service selection boundary',()=>{
 it('returns an inert structured demand tied to exact accepted artifact and input receipt',async()=>{
  const f=await fixture(),result=await selectEquipmentService(f.options);expect(result.candidate).toMatchObject({authority:'none',decision:'use_service',scope,request:defaultOutput.demand,supportingArtifacts:[{artifactId:'planning_artifact',role:'planning'}]});
  expect(result.candidate.inputReceipt).toEqual(f.options.inputReceipt);expect(result.candidate.requestHash).toMatch(/^[a-f0-9]{64}$/);expect(result.selectionHash).toMatch(/^[a-f0-9]{64}$/);expect(f.complete).toHaveBeenCalledTimes(1);
  expect(f.complete.mock.calls[0]![0].input).toContain('Twenty seats and audio');expect(JSON.stringify(result)).not.toContain('approved');
 });
 it('lets the model decline an irrelevant service without manufacturing a demand',async()=>{
  const f=await fixture({...defaultOutput,decision:'not_needed',demand:null,supportingArtifactIds:[]});expect((await selectEquipmentService(f.options)).candidate.requestHash).toBeNull();
 });
 it('rejects altered artifact bytes, stale revision and duplicate contributions before any model call',async()=>{
  for(const variant of ['body','revision','duplicate']){const f=await fixture();if(variant==='body')f.options.accepted[0]!.body.advice.summary='changed';if(variant==='revision')f.options.accepted[0]!.scope={...scope,instructionRevision:0};if(variant==='duplicate')f.options.accepted.push(f.options.accepted[0]!);await expect(selectEquipmentService(f.options)).rejects.toThrow();expect(f.complete).not.toHaveBeenCalled();}
 });
 it('rejects fabricated specialist references and impossible equipment counts',async()=>{
  for(const output of [{...defaultOutput,supportingArtifactIds:['invented']},{...defaultOutput,demand:{...defaultOutput.demand,seats:999}},{...defaultOutput,demand:null},{...defaultOutput,decision:'not_needed'}]){const f=await fixture(output);await expect(selectEquipmentService(f.options)).rejects.toThrow();}
 });
 it('never calls a model when the execution signal is already cancelled',async()=>{
  const f=await fixture(),abort=new AbortController();abort.abort();await expect(selectEquipmentService({...f.options,signal:abort.signal})).rejects.toThrow('ABORTED');expect(f.complete).not.toHaveBeenCalled();
 });
});
