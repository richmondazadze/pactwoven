import { z } from 'zod';
import { IdSchema, IdempotencyKeySchema, InstantSchema } from '@pactwoven/contracts';
import { NativeWorkIntentPrepareSchema, NativeWorkIntentConfirmSchema, NativeWorkIntentPrepareResponseSchema,
  NativeWorkIntentRecoveryResponseSchema, NativeWorkIntentOperationSchema, type NativeWorkIntentPrepare, type NativeWorkIntentReview } from '../../../../packages/contracts/src/native-work-intent';
import { NativeAgentWorkResponseSchema, NativeAgentWorkControlSchema, NativeAgentWorkControlReceiptSchema, type NativeAgentWork } from '../../../../packages/contracts/src/native-agent-work';
import { RequestError, requestApiAtBase, type ApiRequestOptions, type TokenSource } from './api';
import { getNativeApiBase } from './config';
import { memoryIdentity, memoryScope, canWriteMemory, readableMemorySites, type MemoryScope, type MemoryStorage } from './native-memory';

export const agentWorkIdentity = memoryIdentity;
export const agentWorkScope = memoryScope;
export const canStartAgentWork = canWriteMemory;
export const readableAgentWorkSites = readableMemorySites;
export type AgentWorkScope = MemoryScope;
export type AgentWorkStorage = MemoryStorage;
export const agentWorkPath = (siteId: string, id?: string) => `/app/work${id ? `/team/${encodeURIComponent(IdSchema.parse(id))}` : ''}?site=${encodeURIComponent(IdSchema.parse(siteId))}`;
const Scope = z.strictObject({ apiBase:z.string().min(1).max(2048),environment:z.enum(['simulation','development','staging','production']),
  organizationId:IdSchema,actorId:IdSchema,sessionId:z.string().min(1).max(256),siteId:IdSchema });
const same = (a:AgentWorkScope,b:AgentWorkScope) => Object.keys(a).every(key => a[key as keyof AgentWorkScope] === b[key as keyof AgentWorkScope]);
export const agentWorkResponseScope = (scope:AgentWorkScope,value:{scope:{environment:string;organizationId:string;siteId:string}}) =>
  value.scope.environment === scope.environment && value.scope.organizationId === scope.organizationId && value.scope.siteId === scope.siteId;
export async function agentWorkRequest<T>(path:string,schema:z.ZodType<T>,scope:AgentWorkScope,getToken:TokenSource,current:()=>AgentWorkScope,options:ApiRequestOptions={}) {
  if (!/^\/v1\/agent-work(?:\?[^#]*|\/(?:prepare|confirm)|\/[A-Za-z0-9_-]{1,128}(?:\?[^#]*|\/(?:control|conversation|instructions|activity|team-activity)\?[^#]*|\/(?:controls|instructions)\/[A-Za-z0-9_-]{16,128}\?[^#]*)|\/operations\/[A-Za-z0-9_-]{16,128}\?[^#]*)?$/.test(path)) throw new RequestError('INVALID_PATH','This work request is not supported.');
  const check=()=>{if(getNativeApiBase()!==scope.apiBase||!same(scope,current()))throw new RequestError('SCOPE_CHANGED','Your workspace changed.');};
  check();const result=await requestApiAtBase(scope.apiBase,path,schema,async()=>{check();return getToken();},{...options,beforeDispatch:()=>{check();options.beforeDispatch?.();}});
  options.signal?.throwIfAborted();check();return result;
}
const Intent=z.strictObject({kind:z.literal('intent'),scope:Scope,key:IdempotencyKeySchema,input:NativeWorkIntentPrepareSchema,confirmation:NativeWorkIntentConfirmSchema.nullable(),reviewExpiresAt:InstantSchema.nullable()})
  .refine(value=>value.scope.siteId===value.input.siteId&&(value.confirmation===null)===(value.reviewExpiresAt===null));
const Control=z.strictObject({kind:z.literal('control'),scope:Scope,key:IdempotencyKeySchema,id:IdSchema,input:NativeAgentWorkControlSchema});
const Attempt=z.union([Intent,Control]);
export type AgentWorkIntentAttempt=z.infer<typeof Intent>;
export type AgentWorkControlAttempt=z.infer<typeof Control>;
export type AgentWorkAttempt=z.infer<typeof Attempt>;
const prefix='pactwoven:agent-work:v1:';
const storageKey=(scope:AgentWorkScope,id?:string)=>prefix+encodeURIComponent(JSON.stringify(Scope.parse(scope)))+':'+(id?`control:${IdSchema.parse(id)}`:'intent');
export function readAgentWorkAttempt(storage:AgentWorkStorage,scope:AgentWorkScope,id?:string):AgentWorkAttempt|null {
  try {const raw=storage.getItem(storageKey(scope,id));if(raw===null)return null;if(raw.length>100000)throw Error();const value=Attempt.parse(JSON.parse(raw));
    if(!same(scope,value.scope)||(id?value.kind!=='control'||value.id!==id:value.kind!=='intent'))throw Error();return value;
  }catch{throw new RequestError('LOCAL_RECOVERY_INVALID','The original work request needs a recovery check.');}
}
export function previousAgentWorkConnection(storage:AgentWorkStorage,scope:AgentWorkScope,id?:string) {
  try {if(!Number.isSafeInteger(storage.length)||storage.length>10000)throw Error();
    for(let i=0;i<storage.length;i++){const key=storage.key(i);if(!key?.startsWith(prefix))continue;const end=key.lastIndexOf(id?':control:':':intent');if(end<0)continue;
      let previous:AgentWorkScope;try{previous=Scope.parse(JSON.parse(decodeURIComponent(key.slice(prefix.length,end))));}catch{continue;}
      if(previous.apiBase!==scope.apiBase&&previous.environment===scope.environment&&previous.organizationId===scope.organizationId&&previous.actorId===scope.actorId&&previous.sessionId===scope.sessionId&&previous.siteId===scope.siteId&&readAgentWorkAttempt(storage,previous,id))return true;
    }return false;
  }catch{throw new RequestError('LOCAL_RECOVERY_INVALID','The original work request needs a recovery check.');}
}
export function storeAgentWorkAttempt(storage:AgentWorkStorage,attempt:AgentWorkAttempt) {
  const value=Attempt.parse(attempt),id=value.kind==='control'?value.id:undefined;
  if(previousAgentWorkConnection(storage,value.scope,id))throw new RequestError('PREVIOUS_CONNECTION_PENDING','Check the original connection first.');
  const prior=readAgentWorkAttempt(storage,value.scope,id);
  const confirmationOnly=prior?.kind==='intent'&&value.kind==='intent'&&prior.confirmation===null&&value.confirmation!==null&&
    JSON.stringify({...prior,confirmation:null,reviewExpiresAt:null})===JSON.stringify({...value,confirmation:null,reviewExpiresAt:null});
  if(prior&&JSON.stringify(prior)!==JSON.stringify(value)&&!confirmationOnly)throw new RequestError('LOCAL_RECOVERY_INVALID','Check the original request first.');
  const raw=JSON.stringify(value);try{storage.setItem(storageKey(value.scope,id),raw);if(storage.getItem(storageKey(value.scope,id))!==raw)throw Error();}
  catch{throw new RequestError('LOCAL_RECOVERY_UNAVAILABLE','This tab cannot retain the original request.');}
}
export function clearAgentWorkAttempt(storage:AgentWorkStorage,attempt:AgentWorkAttempt) {
  const id=attempt.kind==='control'?attempt.id:undefined,prior=readAgentWorkAttempt(storage,attempt.scope,id);
  if(prior&&JSON.stringify(prior)!==JSON.stringify(attempt))throw new RequestError('LOCAL_RECOVERY_INVALID','Another original request needs checking.');
  try{storage.removeItem(storageKey(attempt.scope,id));if(storage.getItem(storageKey(attempt.scope,id))!==null)throw Error();}
  catch{throw new RequestError('LOCAL_RECOVERY_UNAVAILABLE','The original request could not be cleared.');}
}
export const createAgentWorkIntent=(scope:AgentWorkScope,input:NativeWorkIntentPrepare):AgentWorkIntentAttempt=>Intent.parse({kind:'intent',scope,key:crypto.randomUUID(),input,confirmation:null,reviewExpiresAt:null});
export function confirmAgentWorkIntent(attempt:AgentWorkIntentAttempt,review:NativeWorkIntentReview):AgentWorkIntentAttempt {
  return Intent.parse({...attempt,confirmation:{reviewId:review.id,reviewToken:review.token,continuesAfterSignOut:true},reviewExpiresAt:review.expiresAt});
}
export const createAgentWorkControl=(scope:AgentWorkScope,id:string,input:z.infer<typeof NativeAgentWorkControlSchema>):AgentWorkControlAttempt=>Control.parse({kind:'control',scope,key:crypto.randomUUID(),id,input});
export const preparedWorkSchema=(attempt:AgentWorkIntentAttempt)=>NativeWorkIntentPrepareResponseSchema.refine(value=>agentWorkResponseScope(attempt.scope,value)&&
  value.review.body.title===attempt.input.title&&value.review.body.prompt===attempt.input.prompt&&JSON.stringify(value.review.body.selectedNotes.map(note=>note.noteId))===JSON.stringify(attempt.input.selections.map(note=>note.noteId)));
export const workOperationSchema=(attempt:AgentWorkIntentAttempt)=>NativeWorkIntentOperationSchema.refine(value=>agentWorkResponseScope(attempt.scope,{scope:value.scope})&&value.title===attempt.input.title&&
  (!attempt.confirmation||value.reviewId===attempt.confirmation.reviewId&&value.expiresAt===attempt.reviewExpiresAt));
export const recoveredWorkSchema=(attempt:AgentWorkIntentAttempt)=>NativeWorkIntentRecoveryResponseSchema.refine(value=>agentWorkResponseScope(attempt.scope,value)&&
  (!value.operation||workOperationSchema(attempt).safeParse(value.operation).success)&&(!value.review||(value.review.body.title===attempt.input.title&&value.review.body.prompt===attempt.input.prompt&&
    JSON.stringify(value.review.body.selectedNotes.map(note=>note.noteId))===JSON.stringify(attempt.input.selections.map(note=>note.noteId))&&(!attempt.confirmation||value.review.id===attempt.confirmation.reviewId&&value.review.token===attempt.confirmation.reviewToken))));
export const agentWorkDetailSchema=(scope:AgentWorkScope,id:string)=>NativeAgentWorkResponseSchema.refine(value=>agentWorkResponseScope(scope,value)&&value.work.id===id&&
  (!value.work.evidenceUnavailable||value.work.progress===null&&value.work.result===null)&&new Set(value.work.availableActions).size===value.work.availableActions.length);
export const agentWorkControlReceiptSchema=(attempt:AgentWorkControlAttempt)=>NativeAgentWorkControlReceiptSchema.refine(value=>agentWorkResponseScope(attempt.scope,value)&&value.rootTaskId===attempt.id&&value.action===attempt.input.action&&value.controlVersion>attempt.input.expectedVersion);
export function sendAgentWorkIntent(attempt:AgentWorkIntentAttempt,getToken:TokenSource,current:()=>AgentWorkScope,options:ApiRequestOptions={}) {
  if(attempt.confirmation)return agentWorkRequest('/v1/agent-work/confirm',workOperationSchema(attempt),attempt.scope,getToken,current,{...options,body:attempt.confirmation,idempotencyKey:attempt.key});
  return agentWorkRequest('/v1/agent-work/prepare',preparedWorkSchema(attempt),attempt.scope,getToken,current,{...options,body:attempt.input,idempotencyKey:attempt.key});
}
export const recoverAgentWorkIntent=(attempt:AgentWorkIntentAttempt,getToken:TokenSource,current:()=>AgentWorkScope,signal:AbortSignal)=>
  agentWorkRequest(`/v1/agent-work/operations/${attempt.key}?siteId=${encodeURIComponent(attempt.scope.siteId)}`,recoveredWorkSchema(attempt),attempt.scope,getToken,current,{signal});
export const sendAgentWorkControl=(attempt:AgentWorkControlAttempt,getToken:TokenSource,current:()=>AgentWorkScope,options:ApiRequestOptions={})=>
  agentWorkRequest(`/v1/agent-work/${attempt.id}/control?siteId=${encodeURIComponent(attempt.scope.siteId)}`,agentWorkControlReceiptSchema(attempt),attempt.scope,getToken,current,{...options,body:attempt.input,idempotencyKey:attempt.key});
export const recoverAgentWorkControl=(attempt:AgentWorkControlAttempt,getToken:TokenSource,current:()=>AgentWorkScope,signal:AbortSignal)=>
  agentWorkRequest(`/v1/agent-work/${attempt.id}/controls/${attempt.key}?siteId=${encodeURIComponent(attempt.scope.siteId)}`,z.strictObject({operation:agentWorkControlReceiptSchema(attempt).nullable()}),attempt.scope,getToken,current,{signal});
export const agentWorkReadDenied=(error:unknown)=>error instanceof RequestError&&[401,403,404].includes(error.status);
export const agentWorkPollInterval=(state:NativeAgentWork['state']|undefined,visible:boolean,hasError:boolean)=>
  visible&&!hasError&&state!==undefined&&['queued','working','waiting','waiting_external'].includes(state)?3500:false;
export function agentWorkRejected(error:unknown,replaying=false,control=false) {
  if(!(error instanceof RequestError))return false;
  if(control&&error.status===409&&error.code==='ROOT_CONFLICT')return true;
  if(replaying)return error.code==='REVIEW_EXPIRED'&&error.status===409;
  return error.status===409&&['REVIEW_CHANGED','REVIEW_EXPIRED'].includes(error.code)||error.status===422&&error.code==='VALIDATION_FAILED';
}
export function agentWorkError(error:unknown) {
  if(error instanceof RequestError){
    if(agentWorkReadDenied(error))return 'Your access needs checking. Refresh the workspace or sign in again. The original request is kept.';
    if(error.code==='REVIEW_EXPIRED')return 'The review window has ended. Prepare a new review before starting work.';
    if(error.code==='REVIEW_CHANGED')return 'The selected context or your access changed. Review the current details before starting again.';
    if(error.code==='ROOT_CONFLICT')return 'This work changed. Review its latest status before choosing another action.';
    if(['SETUP_REQUIRED','API_NOT_CONFIGURED'].includes(error.code))return 'Background advisory work is not connected yet.';
    if(error.code==='VALIDATION_FAILED')return 'Enter a title and instructions, then review the selected notes.';
    if(error.code==='PREVIOUS_CONNECTION_PENDING')return 'An earlier request belongs to your previous service connection. Restore that connection to check its original result.';
    if(error.code.startsWith('LOCAL_RECOVERY'))return 'This tab cannot safely retain the original request. Restore tab storage before continuing.';
    if(error.code==='SCOPE_CHANGED')return 'Your workspace changed. Open this work again to continue.';
  }return 'The result is not yet confirmed. Check the original request before trying again.';
}
export const agentWorkTime=(value:string)=>new Intl.DateTimeFormat('en',{dateStyle:'medium',timeStyle:'short'}).format(new Date(value));
