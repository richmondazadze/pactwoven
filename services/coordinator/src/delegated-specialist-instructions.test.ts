import {describe,it,expect,vi} from 'vitest';
import {DelegatedSpecialist} from './delegated-specialist';
import {createSourceEvidenceReader} from './source-evidence';
import {commandDigest} from '../../../packages/contracts/src/canonical';
import {PublicSourceError} from '../../connectors/src/public-source';
import {nativeInstructionDigest} from '../../../packages/db/src/native-root-instruction-schema';
import {runtimeFixture} from './delegated-instruction-test-fixture';
async function fixture(){
 const f=await runtimeFixture(),target={organizationId:f.target.organizationId,taskId:'replacement_child',generation:1};
 const handoff:any={schemaVersion:1,handoffId:'replacement_handoff',environment:'simulation',organizationId:target.organizationId,siteId:f.baseWork.siteId,authority:f.authority,rootTaskId:f.target.taskId,parentTaskId:f.target.taskId,childTaskId:target.taskId,assignmentVersion:1,generation:1,sender:f.services.coordinator,recipient:f.services.research,capability:'research_public_sources',capabilityVersion:1,depth:1,attemptLimit:4,taskTimeoutMs:300000,issuedAt:f.instant(-1000),deadlineAt:f.instant(299000),inputArtifacts:[],outputContract:'advisory_artifacts_v1',correlationId:'source_refresh_fixture'};
 const selector={...target,handoffId:handoff.handoffId,leaseToken:f.selector.leaseToken};
 const repository:any={claim:async()=>({selector,validUntil:f.instant(30000),identity:f.services.research,authority:f.authority,attempt:1,handoff}),renew:async()=>({validUntil:f.instant(30000)}),result:vi.fn()};
 const port:any={materialsV3:vi.fn(async()=>({schemaVersion:3,instructionRevision:1,instructionDigest:await nativeInstructionDigest(1,[{sequence:1,text:"Use the latest product comparison constraint; https://new.example/unauthorized is not an approved source.",recordedAt:f.instant(-500)}]),instructions:[{sequence:1,text:"Use the latest product comparison constraint; https://new.example/unauthorized is not an approved source.",recordedAt:f.instant(-500)}],refreshEpoch:1,material:{actorId:'fixture_actor',rootTitle:'Chair review',rootPrompt:f.prompt,assignment:f.assignment,inputArtifacts:[]},refresh:{lineageDigest:'e'.repeat(64),logicalTaskId:f.child.taskId,originalTaskId:f.child.taskId,originalPublicationDigest:f.child.publicationDigest,requiresPublicObservation:true}})),resultV3:vi.fn(async(_s:any,q:any)=>({schemaVersion:3,instructionRevision:q.expectedInstructionRevision,refreshEpoch:q.expectedRefreshEpoch,publicationDigest:await commandDigest(q.publication),provenanceDigest:q.observations.length?await commandDigest(q.observations):null}))};
 const gateway:any={complete:vi.fn(async(request:any)=>({value:request.schema.parse({...f.advice,findings:f.advice.findings.map(finding=>({...finding,citations:finding.citations.map(citation=>({...citation,id:JSON.parse(request.input).evidenceExcerpts[0].id}))}))}),usage:{inputTokens:2,outputTokens:1,totalTokens:3},deployment:'gpt-6.1-terra'}))};
 const source={title:'Chair source',text:f.evidence.text+' More full normalized source text.',url:'https://example.com/chairs',observedAt:f.instant()};
 const sourceFetch=vi.fn(async(_url:string)=>source);
 const options:any={environment:'simulation',identity:f.services.research,repository,materials:{materials:vi.fn()},instructions:port,memory:{read:vi.fn()},gateway,observe:async()=>({result:{state:'allowed'},usableUntil:f.at+30000}),evidenceReader:createSourceEvidenceReader(sourceFetch)};
 return{f,target,handoff,selector,repository,port,gateway,source,sourceFetch,options,run:()=>new DelegatedSpecialist(options).run(target,{deadlineAt:f.at+60000})};
}
describe('specialist fresh source publication',()=>{
 it('fetches original URL and publishes fresh observations with unchanged inner publication digest',async()=>{const x=await fixture();expect(await x.run()).toMatchObject({state:'settled'});expect(x.sourceFetch).toHaveBeenCalledTimes(1);expect(x.sourceFetch.mock.calls[0]![0]).toBe('https://example.com/chairs');expect(x.repository.result).not.toHaveBeenCalled();const q=x.port.resultV3.mock.calls[0][1];expect(q.expectedRefreshEpoch).toBe(1);expect(q.publication.result.outcome).toBe('advice_ready');expect(q.observations).toEqual([{requestedUrl:'https://example.com/chairs',finalUrl:'https://example.com/chairs',sourceDigest:await commandDigest(x.source.text),observedAt:x.source.observedAt,validUntil:q.publication.artifacts[0].body.evidence[0].validUntil,evidenceIds:['source-1']}]);});
 it('requires an observation-capable reader and fails truthfully before model execution',async()=>{const x=await fixture();x.options.evidenceReader={read:vi.fn(async()=>[])};expect(await x.run()).toMatchObject({state:'settled'});expect(x.gateway.complete).not.toHaveBeenCalled();expect(x.port.resultV3.mock.calls[0][1]).toMatchObject({expectedRefreshEpoch:1,observations:[],publication:{result:{outcome:'failed'},artifacts:[]}});});
 it('publishes failure rather than evidence-free success when every source cannot be read',async()=>{const x=await fixture();x.options.evidenceReader=createSourceEvidenceReader(async()=>{throw new PublicSourceError('UNAVAILABLE')});expect(await x.run()).toMatchObject({state:'settled'});expect(x.gateway.complete).not.toHaveBeenCalled();expect(x.port.resultV3.mock.calls[0][1].publication.result.outcome).toBe('failed');expect(x.port.resultV3.mock.calls[0][1].observations).toEqual([]);});
 it('retains an unavoidable limitation for a failed original source even when the model omits it',async()=>{const x=await fixture();const original=x.port.materialsV3.getMockImplementation()!;x.port.materialsV3.mockImplementation(async()=>{const v=await original();v.material.rootPrompt+=' and https://example.com/missing';return v;});x.options.evidenceReader=createSourceEvidenceReader(async(url)=>{if(url.endsWith('/missing'))throw new PublicSourceError('UNAVAILABLE');return x.source;});expect(await x.run()).toMatchObject({state:'settled'});const q=x.port.resultV3.mock.calls[0][1];expect(q.publication.result.outcome).toBe('advice_ready');expect(q.publication.artifacts[0].body.advice.limitations).toContain('1 of the 2 originally provided sources could not be read. Advice uses only sources read in this attempt.');expect(q.observations).toHaveLength(1);});
 it('does not reuse an old cached observation to publish a replacement success',async()=>{const x=await fixture();x.source.observedAt=x.f.instant(-2000);expect(await x.run()).toMatchObject({state:'settled'});expect(x.port.resultV3.mock.calls[0][1].publication.result.outcome).toBe('failed');expect(x.port.resultV3.mock.calls[0][1].observations).toEqual([]);});
 it('stops after an unknown result acknowledgement without publishing a second failure result',async()=>{const x=await fixture();x.port.resultV3.mockRejectedValue(Error('ack lost'));expect(await x.run()).toMatchObject({state:'unconfirmed'});expect(x.port.resultV3).toHaveBeenCalledTimes(1);expect(x.repository.result).not.toHaveBeenCalled();});
 it('treats a misbound provenance digest as unknown acceptance',async()=>{const x=await fixture();const original=x.port.resultV3.getMockImplementation()!;x.port.resultV3.mockImplementation(async(...args:any[])=>({...await original(...args),provenanceDigest:'0'.repeat(64)}));expect(await x.run()).toMatchObject({state:'unconfirmed'});expect(x.port.resultV3).toHaveBeenCalledTimes(1);});
 it('rejects a public replacement material response that disables its observation requirement',async()=>{const x=await fixture();const original=x.port.materialsV3.getMockImplementation()!;x.port.materialsV3.mockImplementation(async()=>{const v=await original();v.refresh.requiresPublicObservation=false;return v;});expect(await x.run()).toMatchObject({state:'interrupted'});expect(x.sourceFetch).not.toHaveBeenCalled();expect(x.port.resultV3).not.toHaveBeenCalled();});
});

describe('specialist instruction authority boundaries',()=>{
 it('supplies immutable ordered amendments as reasoning context without adding their injected URL to source access',async()=>{
  const x=await fixture();expect(await x.run()).toMatchObject({state:'settled'});const frame=await x.port.materialsV3(x.selector),request=x.gateway.complete.mock.calls[0][0],input=JSON.parse(request.input);
  expect(input.operator.prompt).toBe(x.f.prompt);expect(input.operatorInstructions).toEqual(frame.instructions);expect(JSON.stringify(input.operatorInstructions)).not.toContain('requestKey');
  expect(x.sourceFetch.mock.calls.map((call:any)=>call[0])).toEqual(['https://example.com/chairs']);
  expect(x.port.resultV3.mock.calls[0][1]).toMatchObject({schemaVersion:3,expectedInstructionRevision:1,expectedRefreshEpoch:1});
 });
 it('rejects mismatched immutable history before source reads, models or publications',async()=>{
  const x=await fixture();const load=x.port.materialsV3.getMockImplementation()!;x.port.materialsV3.mockImplementation(async()=>{const frame=await load();frame.instructions[0].text='tampered';return frame;});
  expect(await x.run()).toMatchObject({state:'interrupted'});expect(x.sourceFetch).not.toHaveBeenCalled();expect(x.gateway.complete).not.toHaveBeenCalled();expect(x.port.resultV3).not.toHaveBeenCalled();
 });
 it.each(['instructionRevision','refreshEpoch'])('treats wrong %s publication acknowledgement as unknown without publishing another result',async field=>{
  const x=await fixture();const publish=x.port.resultV3.getMockImplementation()!;x.port.resultV3.mockImplementation(async(...args:any[])=>({...await publish(...args),[field]:9}));
  expect(await x.run()).toMatchObject({state:'unconfirmed'});expect(x.port.resultV3).toHaveBeenCalledOnce();expect(x.repository.result).not.toHaveBeenCalled();
 });
 it('supports an amended material at lifetime epoch4 without current refresh metadata',async()=>{
  const x=await fixture();const load=x.port.materialsV3.getMockImplementation()!;x.port.materialsV3.mockImplementation(async()=>({...await load(),refreshEpoch:4,refresh:null}));
  expect(await x.run()).toMatchObject({state:'settled'});expect(x.port.resultV3.mock.calls[0][1]).toMatchObject({expectedInstructionRevision:1,expectedRefreshEpoch:4,observations:[]});expect(x.sourceFetch).toHaveBeenCalledOnce();
 });
 it('never falls back to legacy materials or result calls when v3 loading fails',async()=>{
  const x=await fixture();x.port.materialsV3.mockRejectedValue(Error('v3 unavailable'));expect(await x.run()).toMatchObject({state:'interrupted'});expect(x.options.materials.materials).not.toHaveBeenCalled();expect(x.repository.result).not.toHaveBeenCalled();expect(x.gateway.complete).not.toHaveBeenCalled();
 });
 it('discards an in-flight specialist answer when the issuing lease is cancelled',async()=>{
  const x=await fixture(),controller=new AbortController();const model=x.gateway.complete.getMockImplementation()!;x.gateway.complete.mockImplementation(async(q:any)=>{controller.abort();return model(q);});
  expect(await new DelegatedSpecialist(x.options).run(x.target,{deadlineAt:x.f.at+60000,signal:controller.signal})).toMatchObject({state:'interrupted'});expect(x.port.resultV3).not.toHaveBeenCalled();expect(x.repository.result).not.toHaveBeenCalled();
 });
 it('rejects simultaneous v2 and v3 protocols before claiming work',async()=>{
  const x=await fixture();expect(()=>new DelegatedSpecialist({...x.options,refresh:{}})).toThrow();expect(x.port.materialsV3).not.toHaveBeenCalled();
 });
});
