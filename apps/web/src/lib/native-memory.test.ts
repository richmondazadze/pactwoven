import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryNoteFixture } from './native-memory.test-fixtures';
import { nativeSessionFixture } from './native-tasks.test-fixtures';
import { RequestError } from './api';
import { canWriteMemory, clearMemoryAttempt, createMemoryAttempt, memoryAttemptRejected, memoryDetailSchema, memoryError, memoryIdentity,
  memoryListPath, memoryReviewDateIsFuture, memoryOperationSchema, memoryPageSchema, memoryScope, previousMemoryConnection, readMemoryAttempt,
  recoverMemoryAttempt, sendMemoryAttempt, storeMemoryAttempt, type MemoryScope, type MemoryStorage } from './native-memory';
const input = { kind:'remember' as const, siteId:'site_one', title:'Delivery entrance', text:'Use east entrance', purpose:'Deliveries', reviewBy:'2026-12-18T14:00:00.000Z' };
const operation = (scope: MemoryScope) => ({ scope:{ environment:scope.environment, organizationId:scope.organizationId, siteId:scope.siteId }, operationId:'operation_internal', noteId:'note_internal_001', action:'remember', committedAt:'2026-11-18T14:00:00.000Z', current:memoryNoteFixture() });
function storage(): MemoryStorage {
 const values = new Map<string,string>();
 return { get length(){return values.size;}, key:index=>[...values.keys()][index]??null, getItem:key=>values.get(key)??null, setItem:(key,value)=>{values.set(key,value);}, removeItem:key=>{values.delete(key);} };
}
beforeEach(()=>vi.stubEnv('NEXT_PUBLIC_NATIVE_API_BASE_URL','http://localhost:3108'));
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});
describe('scoped memory reads',()=>{
 it('does not ask users to re-enter saved fields after a failed read',()=>{
  const error=new RequestError('VALIDATION_FAILED','Invalid request',422);
  expect(memoryError(error,'read')).toBe('This note view could not be loaded. Refresh the page or reopen it from Memory.');
  expect(memoryError(error,'write')).toBe('Enter a title, note, purpose and valid review date.');
 });
 it('requires human readable sites and narrower write authority',()=>{
  const s=nativeSessionFixture();expect(canWriteMemory(s,'site_one')).toBe(true);s.actor.actionSiteIds=[];expect(canWriteMemory(s,'site_one')).toBe(false);expect(memoryScope(s,'site_one').siteId).toBe('site_one');s.actor.siteIds=[];expect(()=>memoryScope(s,'site_one')).toThrow();
 });
 it.each(['session','epoch','roles','sites','actions','base'])('changes query and draft identity for %s changes',kind=>{
  const s=nativeSessionFixture(),before=memoryIdentity(s,'site_one');
  if(kind==='session')s.actor.sessionId='other';if(kind==='epoch')s.organization.authorityEpoch++;if(kind==='roles')s.actor.roles=['auditor'];if(kind==='sites')s.actor.siteIds=[];if(kind==='actions')s.actor.actionSiteIds=[];if(kind==='base')vi.stubEnv('NEXT_PUBLIC_NATIVE_API_BASE_URL','http://localhost:3110');
  expect(memoryIdentity(s,'site_one')).not.toBe(before);
 });
 it('accepts an empty filtered page with another cursor',()=>{
  const scope=memoryScope(nativeSessionFixture(),'site_one');
  expect(memoryPageSchema(scope,'needs_review').safeParse({scope:operation(scope).scope,items:[],nextCursor:'opaque_next'}).success).toBe(true);
  expect(memoryListPath('site_one','needs_review','opaque_next')).toContain('cursor=opaque_next');
 });
 it('rejects repeated cursors, foreign scope, wrong filter and wrong detail',()=>{
  const scope=memoryScope(nativeSessionFixture(),'site_one'),note=memoryNoteFixture();const {text,purpose,editToken,sourceLabel,usageLabel,removalLabel,historyRetained,...summary}=note;
  expect(memoryPageSchema(scope,'all','same').safeParse({scope:operation(scope).scope,items:[],nextCursor:'same'}).success).toBe(false);
  expect(memoryPageSchema(scope,'removed').safeParse({scope:operation(scope).scope,items:[summary],nextCursor:null}).success).toBe(false);
  expect(memoryDetailSchema(scope,'other').safeParse({scope:operation(scope).scope,note}).success).toBe(false);
  expect(memoryDetailSchema(scope,note.id).safeParse({scope:{...operation(scope).scope,siteId:'foreign'},note}).success).toBe(false);
 });
});
describe('immutable original memory requests',()=>{
 it('requires a future review date for new edits, without changing original commands',()=>{
  const now=Date.parse('2026-12-18T14:00:00.000Z');
  expect(memoryReviewDateIsFuture(input,now)).toBe(false);
  expect(memoryReviewDateIsFuture({...input,reviewBy:'2026-12-18T14:00:00.001Z'},now)).toBe(true);
  expect(memoryReviewDateIsFuture({...input,reviewBy:'2020-01-01T00:00:00.000Z'},now)).toBe(false);
  expect(memoryReviewDateIsFuture({kind:'remove',siteId:'site_one',noteId:'note_internal_001',expected:'a'.repeat(64)},now)).toBe(true);
 });
 it.each([
  ['VERSION_CONFLICT',409,true,true],['EVIDENCE_STALE',409,true,false],['FORBIDDEN',403,true,false],
  ['VALIDATION_FAILED',422,true,false],['SESSION_REQUIRED',401,true,false],['DURABLE_SERVICE_UNAVAILABLE',503,false,false],
  ['IDEMPOTENCY_CONFLICT',409,false,false],['VERSION_CONFLICT',503,false,false],['EVIDENCE_STALE',503,false,false],
 ])('classifies %s/%s with a narrow original-replay rule',(code,status,fresh,replay)=>{
  const error=new RequestError(code,'Synthetic error',status);
  expect(memoryAttemptRejected(error)).toBe(fresh);expect(memoryAttemptRejected(error,true)).toBe(replay);
 });

 it('retains one original and prevents replacement until confirmed',()=>{
  const scope=memoryScope(nativeSessionFixture(),'site_one'),s=storage(),attempt=createMemoryAttempt(scope,input);
  storeMemoryAttempt(s,attempt);expect(readMemoryAttempt(s,scope)).toEqual(attempt);
  expect(()=>storeMemoryAttempt(s,createMemoryAttempt(scope,{...input,text:'replacement'}))).toThrow();
  expect(()=>clearMemoryAttempt(s,createMemoryAttempt(scope,input))).toThrow();
  clearMemoryAttempt(s,attempt);expect(readMemoryAttempt(s,scope)).toBeNull();
 });
 it('keeps exact CAS token and timestamp in stored correction',()=>{
  const scope=memoryScope(nativeSessionFixture(),'site_one'),s=storage();const attempt=createMemoryAttempt(scope,{...input,kind:'correct',noteId:'note_internal_001',expected:'b'.repeat(64),reviewBy:'2026-12-18T14:03:23.123Z'});
  storeMemoryAttempt(s,attempt);expect(readMemoryAttempt(s,scope)?.input).toEqual(attempt.input);
 });
 it('blocks dispatch if storage did not retain the original',()=>{
  const scope=memoryScope(nativeSessionFixture(),'site_one'),s=storage();s.setItem=()=>{};
  expect(()=>storeMemoryAttempt(s,createMemoryAttempt(scope,input))).toThrow();
 });
 it('quarantines old-origin requests without returning contents or dispatching to that origin',()=>{
  const scope=memoryScope(nativeSessionFixture(),'site_one'),s=storage();storeMemoryAttempt(s,createMemoryAttempt(scope,input));
  const next={...scope,apiBase:'https://new.example'};expect(previousMemoryConnection(s,next)).toBe(true);expect(()=>storeMemoryAttempt(s,createMemoryAttempt(next,input))).toThrow();expect(previousMemoryConnection(s,{...next,sessionId:'other'})).toBe(false);
 });
 it('checks original operation without clearing a null result, and retries the exact original key and body',async()=>{
  const scope=memoryScope(nativeSessionFixture(),'site_one'),s=storage(),attempt=createMemoryAttempt(scope,input);storeMemoryAttempt(s,attempt);
  const fetch=vi.fn().mockResolvedValueOnce(Response.json({operation:null})).mockResolvedValueOnce(Response.json(operation(scope)));vi.stubGlobal('fetch',fetch);
  expect((await recoverMemoryAttempt(attempt,async()=>'token',()=>scope,new AbortController().signal)).operation).toBeNull();expect(readMemoryAttempt(s,scope)).toEqual(attempt);
  await sendMemoryAttempt(attempt,async()=>'token',()=>scope);const [url,init]=fetch.mock.calls[1]!;expect(url).toBe('http://localhost:3108/v1/memory');expect(init.headers['Idempotency-Key']).toBe(attempt.key);expect(JSON.parse(init.body)).toEqual(input);
 });
 it('rejects recovery for another action, note, scope or current projection',()=>{
  const scope=memoryScope(nativeSessionFixture(),'site_one');const command={...input,kind:'correct' as const,noteId:'note_internal_001',expected:'a'.repeat(64)};
  const good={...operation(scope),action:'correct'};expect(memoryOperationSchema(scope,command).safeParse(good).success).toBe(true);
  for(const bad of [{...good,action:'remove'},{...good,noteId:'other'},{...good,scope:{...good.scope,organizationId:'other'}},{...good,current:{...good.current,id:'other'}}])expect(memoryOperationSchema(scope,command).safeParse(bad).success).toBe(false);
 });
 it('rejects a changed session while token resolution is pending before dispatch',async()=>{
  const scope=memoryScope(nativeSessionFixture(),'site_one');let current=scope;const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
  await expect(sendMemoryAttempt(createMemoryAttempt(scope,input),async()=>{current={...scope,sessionId:'other'};return 'token';},()=>current)).rejects.toMatchObject({code:'SCOPE_CHANGED'});expect(fetch).not.toHaveBeenCalled();
 });
 it('rejects stale successful responses after a scope switch',async()=>{
  const scope=memoryScope(nativeSessionFixture(),'site_one');let current=scope;vi.stubGlobal('fetch',vi.fn(async()=>{current={...scope,siteId:'other'};return Response.json(operation(scope));}));
  await expect(sendMemoryAttempt(createMemoryAttempt(scope,input),async()=>'token',()=>current)).rejects.toMatchObject({code:'SCOPE_CHANGED'});
 });
 it('never treats an unknown server result as a definite rejection',()=>{
  expect(memoryAttemptRejected(new RequestError('DURABLE_SERVICE_UNAVAILABLE','unknown',503))).toBe(false);
  expect(memoryAttemptRejected(new RequestError('VERSION_CONFLICT','changed',409))).toBe(true);
  expect(memoryAttemptRejected(new RequestError('IDEMPOTENCY_CONFLICT','collision',409))).toBe(false);
 });
});
