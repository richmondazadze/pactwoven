import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nativeSessionFixture } from './native-tasks.test-fixtures';
import { RequestError } from './api';
import { agentWorkScope, type AgentWorkStorage } from './native-agent-work';
import { clearWorkInstructionAttempt, createWorkInstructionAttempt, previousWorkInstructionConnection, readWorkInstructionAttempt,
  recoverWorkInstruction, sendWorkInstruction, storeWorkInstructionAttempt, workConversationSchema, workInstructionReceiptSchema, workInstructionRecoverySchema, workInstructionRejected } from './native-work-conversation';

const storage=():AgentWorkStorage=>{const data=new Map<string,string>();return {get length(){return data.size;},key:index=>[...data.keys()][index]??null,getItem:key=>data.get(key)??null,setItem:(key,value)=>{data.set(key,value);},removeItem:key=>{data.delete(key);}};};
const scope=()=>agentWorkScope(nativeSessionFixture(),'site_one');
const publicScope={environment:'development',organizationId:'company_one',siteId:'site_one'};
const attempt=()=>createWorkInstructionAttempt(scope(),'root_internal',{text:'Keep the workshop seated and include two breaks.',expectedInstructionVersion:0,expectedControlVersion:4});
const receipt=(original=attempt())=>{const at=new Date().toISOString();return {scope:publicScope,rootTaskId:original.id,requestKey:original.key,instructionVersion:1,controlVersion:5,entry:{sequence:1,text:original.input.text,recordedAt:at,state:'recorded'},committedAt:at,state:'paused'};};
beforeEach(()=>vi.stubEnv('NEXT_PUBLIC_NATIVE_API_BASE_URL','http://localhost:3108'));
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});

describe('same-root instruction recovery',()=>{
  it('only clears a confirmed rejection and retains authority, idempotency and unknown outcomes',()=>{
    for(const [code,status] of [['ROOT_CONFLICT',409],['INSTRUCTION_LIMIT',409],['VALIDATION_FAILED',422]] as const)expect(workInstructionRejected(new RequestError(code,'internal',status))).toBe(true);
    for(const [code,status] of [['IDEMPOTENCY_CONFLICT',409],['FORBIDDEN',403],['DURABLE_SERVICE_UNAVAILABLE',503],['ROOT_CONFLICT',503],['REQUEST_FAILED',422]] as const)expect(workInstructionRejected(new RequestError(code,'internal',status))).toBe(false);
  });
  it('retains exact text, both versions and key across reload and refuses replacement',()=>{
    const data=storage(),original=attempt();storeWorkInstructionAttempt(data,original);
    expect(readWorkInstructionAttempt(data,original.scope,original.id)).toEqual(original);
    expect(()=>storeWorkInstructionAttempt(data,{...original,input:{...original.input,text:'Other'}})).toThrow();
    expect(()=>clearWorkInstructionAttempt(data,{...original,key:crypto.randomUUID()})).toThrow();
    clearWorkInstructionAttempt(data,original);expect(readWorkInstructionAttempt(data,original.scope,original.id)).toBeNull();
  });
  it('quarantines prior origins and partitions actor/session/site recovery',()=>{
    const data=storage(),original=attempt();storeWorkInstructionAttempt(data,original);const next={...original.scope,apiBase:'https://other.example'};
    expect(previousWorkInstructionConnection(data,next,original.id)).toBe(true);expect(readWorkInstructionAttempt(data,next,original.id)).toBeNull();
    expect(()=>storeWorkInstructionAttempt(data,{...original,scope:next})).toThrow();
    expect(readWorkInstructionAttempt(data,{...original.scope,sessionId:'other'},original.id)).toBeNull();
    expect(previousWorkInstructionConnection(data,{...next,actorId:'other'},original.id)).toBe(false);
  });
  it('fails before a write if storage cannot retain the update',()=>{const data=storage();data.setItem=()=>{};expect(()=>storeWorkInstructionAttempt(data,attempt())).toThrow();});
  it('round-trips the full supported escape-heavy instruction through the same bounded recovery format',()=>{
    const data=storage(),original=attempt();original.input.text='\u0001'.repeat(3999)+'x';
    expect(JSON.stringify(original).length).toBeGreaterThan(20000);
    storeWorkInstructionAttempt(data,original);expect(readWorkInstructionAttempt(data,original.scope,original.id)).toEqual(original);
    clearWorkInstructionAttempt(data,original);expect(readWorkInstructionAttempt(data,original.scope,original.id)).toBeNull();
  });
  it('uses the same key and exact body on explicit resend, with read-only recovery between',async()=>{
    const original=attempt(),fetch=vi.fn().mockRejectedValueOnce(new TypeError('Lost response')).mockResolvedValueOnce(Response.json({scope:publicScope,rootTaskId:original.id,requestKey:original.key,operation:null})).mockResolvedValueOnce(Response.json(receipt(original)));vi.stubGlobal('fetch',fetch);
    await expect(sendWorkInstruction(original,async()=>'token',()=>original.scope)).rejects.toThrow();
    expect((await recoverWorkInstruction(original,async()=>'token',()=>original.scope,new AbortController().signal)).operation).toBeNull();
    await sendWorkInstruction(original,async()=>'token',()=>original.scope);
    expect(fetch.mock.calls[0]![1].headers['Idempotency-Key']).toBe(original.key);expect(fetch.mock.calls[2]![1].headers['Idempotency-Key']).toBe(original.key);
    expect(fetch.mock.calls[1]![1].method).toBe('GET');expect(JSON.parse(fetch.mock.calls[2]![1].body)).toEqual(original.input);
  });
  it('rejects identity change during token resolution without dispatch',async()=>{const original=attempt();let current=original.scope;const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
    await expect(sendWorkInstruction(original,async()=>{current={...current,sessionId:'new'};return 'token';},()=>current)).rejects.toMatchObject({code:'SCOPE_CHANGED'});expect(fetch).not.toHaveBeenCalled();});
  it('rejects receipt substitution, stale versions and a mismatched recovery key',()=>{
    const original=attempt(),value=receipt(original),schema=workInstructionReceiptSchema(original);expect(schema.safeParse(value).success).toBe(true);
    for(const bad of [{...value,rootTaskId:'other'},{...value,requestKey:crypto.randomUUID()},{...value,entry:{...value.entry,text:'Changed'}},{...value,controlVersion:4},{...value,controlVersion:6},{...value,instructionVersion:2,entry:{...value.entry,sequence:2}},{...value,scope:{...publicScope,siteId:'other'}}])expect(schema.safeParse(bad).success).toBe(false);
    expect(workInstructionRecoverySchema(original).safeParse({scope:publicScope,rootTaskId:original.id,requestKey:crypto.randomUUID(),operation:null}).success).toBe(false);
  });
  it('rejects incomplete, unordered or substituted conversation snapshots',()=>{
    const original=attempt(),entry=receipt(original).entry,value={scope:publicScope,rootTaskId:original.id,originalPrompt:'Plan a workshop',instructionVersion:1,controlVersion:5,entries:[entry],canUpdate:true,updateUnavailableReason:null},schema=workConversationSchema(original.scope,original.id);
    expect(schema.safeParse(value).success).toBe(true);
    for(const bad of [{...value,entries:[]},{...value,rootTaskId:'other'},{...value,entries:[{...entry,sequence:2}]},{...value,scope:{...publicScope,siteId:'other'}}])expect(schema.safeParse(bad).success).toBe(false);
  });
});
