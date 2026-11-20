import { z } from 'zod';
import { IdSchema, IdempotencyKeySchema } from '@pactwoven/contracts';
import { NativeWorkConversationSchema, NativeWorkInstructionUpdateSchema, NativeWorkInstructionReceiptSchema,
  NativeWorkInstructionRecoverySchema } from '../../../../packages/contracts/src/native-work-conversation';
import { RequestError, type ApiRequestOptions, type TokenSource } from './api';
import { agentWorkRequest, agentWorkResponseScope, type AgentWorkScope, type AgentWorkStorage } from './native-agent-work';

const Scope = z.strictObject({ apiBase: z.string().min(1).max(2048), environment: z.enum(['simulation','development','staging','production']),
  organizationId: IdSchema, actorId: IdSchema, sessionId: z.string().min(1).max(256), siteId: IdSchema });
const Attempt = z.strictObject({ scope: Scope, id: IdSchema, key: IdempotencyKeySchema, input: NativeWorkInstructionUpdateSchema });
export type WorkInstructionAttempt = z.infer<typeof Attempt>;
const same = (left: AgentWorkScope, right: AgentWorkScope) => Object.keys(left).every(key => left[key as keyof AgentWorkScope] === right[key as keyof AgentWorkScope]);
const prefix = 'pactwoven:agent-work-instruction:v1:';
const maximumStoredLength = 65536;
const storageKey = (scope: AgentWorkScope, id: string) => `${prefix}${encodeURIComponent(JSON.stringify(Scope.parse(scope)))}:${IdSchema.parse(id)}`;

export function readWorkInstructionAttempt(storage: AgentWorkStorage, scope: AgentWorkScope, id: string): WorkInstructionAttempt | null {
  try {
    const raw = storage.getItem(storageKey(scope,id)); if (raw === null) return null;
    if (raw.length > maximumStoredLength) throw Error();
    const value = Attempt.parse(JSON.parse(raw)); if (!same(scope,value.scope) || value.id !== id) throw Error();
    return value;
  } catch { throw new RequestError('LOCAL_RECOVERY_INVALID','The original instruction update needs checking.'); }
}
export function previousWorkInstructionConnection(storage: AgentWorkStorage, scope: AgentWorkScope, id: string) {
  try {
    if (!Number.isSafeInteger(storage.length) || storage.length > 10000) throw Error();
    for (let index=0;index<storage.length;index++) {
      const key=storage.key(index); if (!key?.startsWith(prefix) || !key.endsWith(`:${id}`)) continue;
      let previous: AgentWorkScope;
      try { previous=Scope.parse(JSON.parse(decodeURIComponent(key.slice(prefix.length,-id.length-1)))); } catch { continue; }
      if (previous.apiBase!==scope.apiBase && same({...previous,apiBase:scope.apiBase},scope) && readWorkInstructionAttempt(storage,previous,id)) return true;
    }
    return false;
  } catch { throw new RequestError('LOCAL_RECOVERY_INVALID','The original instruction update needs checking.'); }
}
export function createWorkInstructionAttempt(scope: AgentWorkScope,id: string,input: z.infer<typeof NativeWorkInstructionUpdateSchema>): WorkInstructionAttempt {
  return Attempt.parse({scope,id,key:crypto.randomUUID(),input});
}
export function storeWorkInstructionAttempt(storage: AgentWorkStorage,attempt: WorkInstructionAttempt) {
  const value=Attempt.parse(attempt);
  if (previousWorkInstructionConnection(storage,value.scope,value.id)) throw new RequestError('PREVIOUS_CONNECTION_PENDING','Check the original connection.');
  const previous=readWorkInstructionAttempt(storage,value.scope,value.id);
  if (previous && JSON.stringify(previous)!==JSON.stringify(value)) throw new RequestError('LOCAL_RECOVERY_INVALID','Check the original update first.');
  const raw=JSON.stringify(value),key=storageKey(value.scope,value.id);
  if(raw.length>maximumStoredLength)throw new RequestError('LOCAL_RECOVERY_INVALID','The original update exceeds this tab’s recovery limit.');
  try { storage.setItem(key,raw); if(storage.getItem(key)!==raw) throw Error(); }
  catch { throw new RequestError('LOCAL_RECOVERY_UNAVAILABLE','The original update could not be retained.'); }
}
export function clearWorkInstructionAttempt(storage: AgentWorkStorage,attempt: WorkInstructionAttempt) {
  const previous=readWorkInstructionAttempt(storage,attempt.scope,attempt.id);
  if(previous && JSON.stringify(previous)!==JSON.stringify(attempt)) throw new RequestError('LOCAL_RECOVERY_INVALID','Another update needs checking.');
  const key=storageKey(attempt.scope,attempt.id);
  try { storage.removeItem(key); if(storage.getItem(key)!==null) throw Error(); }
  catch { throw new RequestError('LOCAL_RECOVERY_UNAVAILABLE','The original update could not be cleared.'); }
}
export const workConversationSchema=(scope: AgentWorkScope,id: string)=>NativeWorkConversationSchema.refine(value=>
  agentWorkResponseScope(scope,value) && value.rootTaskId===id && new Set(value.entries.map(entry=>entry.sequence)).size===value.entries.length &&
  value.entries.every((entry,index)=>index===0||entry.sequence>value.entries[index-1]!.sequence));
export const workInstructionReceiptSchema=(attempt: WorkInstructionAttempt)=>NativeWorkInstructionReceiptSchema.refine(value=>
  agentWorkResponseScope(attempt.scope,value) && value.rootTaskId===attempt.id && value.requestKey===attempt.key && value.entry.text===attempt.input.text &&
  value.instructionVersion===attempt.input.expectedInstructionVersion+1 && value.controlVersion===attempt.input.expectedControlVersion+1);
export const workInstructionRecoverySchema=(attempt: WorkInstructionAttempt)=>NativeWorkInstructionRecoverySchema.refine(value=>
  agentWorkResponseScope(attempt.scope,value) && value.rootTaskId===attempt.id && value.requestKey===attempt.key && (!value.operation||workInstructionReceiptSchema(attempt).safeParse(value.operation).success));
export const sendWorkInstruction=(attempt: WorkInstructionAttempt,getToken: TokenSource,current:()=>AgentWorkScope,options: ApiRequestOptions={})=>
  agentWorkRequest(`/v1/agent-work/${attempt.id}/instructions?siteId=${encodeURIComponent(attempt.scope.siteId)}`,workInstructionReceiptSchema(attempt),attempt.scope,getToken,current,{...options,body:attempt.input,idempotencyKey:attempt.key});
export const recoverWorkInstruction=(attempt: WorkInstructionAttempt,getToken: TokenSource,current:()=>AgentWorkScope,signal: AbortSignal)=>
  agentWorkRequest(`/v1/agent-work/${attempt.id}/instructions/${attempt.key}?siteId=${encodeURIComponent(attempt.scope.siteId)}`,workInstructionRecoverySchema(attempt),attempt.scope,getToken,current,{signal});
export const workInstructionRejected=(error: unknown)=>error instanceof RequestError&&(
  error.status===409&&['ROOT_CONFLICT','INSTRUCTION_CONFLICT','ROOT_NOT_PAUSED','INSTRUCTION_LIMIT'].includes(error.code)||
  error.status===422&&error.code==='VALIDATION_FAILED');
export function workInstructionError(error: unknown) {
  if(error instanceof RequestError) {
    if(error.code==='ROOT_CONFLICT'||error.code==='INSTRUCTION_CONFLICT') return 'This work changed. Refresh its current instructions before reviewing another update.';
    if(error.code==='INSTRUCTION_LIMIT') return 'This work has reached its instruction update limit. Its saved instructions remain available.';
    if(error.code==='ROOT_NOT_PAUSED') return 'Pause this work before updating its instructions.';
    if(error.code==='VALIDATION_FAILED') return 'Enter an instruction update of up to 4,000 characters.';
  }
  return null;
}
