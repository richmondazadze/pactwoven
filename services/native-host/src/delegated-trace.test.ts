import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { commandDigest } from '../../../packages/contracts/src/canonical';
import { delegatedTraceFields, traceDelegatedAuthority, traceDelegatedGateway, withDelegatedTrace } from './delegated-trace';
import type { DelegatedQueueMessage } from './delegated-dispatch';
import type { NativeModelGateway, ModelResult } from '../../coordinator/src/azure-gateway';
const message: DelegatedQueueMessage = { schemaVersion: 1, environment: 'simulation', kind: 'root', target: { organizationId: 'private-org', taskId: 'private-task', generation: 1 } };
function capture() { const log = vi.spyOn(console, 'info').mockImplementation(() => {}); return { log, events: () => log.mock.calls.map(([entry]) => JSON.parse(String(entry))) }; }
afterEach(() => vi.restoreAllMocks());
describe('private execution trace boundaries', () => {
 it('correlates metadata without exposing task IDs, input or provider credentials', async () => {
  const f = capture(), until = Date.now()+15000;
  const observe = traceDelegatedAuthority(async () => ({ result: { state: 'allowed', secret: 'private-secret' }, usableUntil: until }));
  const returned = await withDelegatedTrace(message, async () => { await observe(message.target, { deadlineAt: until }); return 'settled'; });
  expect(returned).toBe('settled'); expect(f.events().map(e=>e.event)).toEqual(['execution_started','authority_allowed','execution_settled']);
  const digest = await commandDigest({ namespace: 'pactwoven/delegated-trace/v1', environment: message.environment, kind: message.kind, target: message.target });
  expect(f.events().every(e=>e.workDigest===digest)).toBe(true); expect(new Set(f.events().map(e=>e.invocationId)).size).toBe(1);
  expect(JSON.stringify(f.events())).not.toMatch(/private-org|private-task|private-secret/); expect(delegatedTraceFields()).toEqual({});
 });
 it('keeps concurrent deliveries and their delayed authority observations separate', async () => {
  const f=capture(); let release!:()=>void; const barrier=new Promise<void>(r=>release=r);
  const one=withDelegatedTrace(message, async()=>{await barrier;await traceDelegatedAuthority(async()=>({result:{state:'denied'},usableUntil:null}))(message.target,{deadlineAt:Date.now()+1000});return 'discarded';});
  const other={...message,target:{...message.target,taskId:'second-private-task'}};
  await withDelegatedTrace(other,async()=>{release();return 'settled';});await one;
  const start=f.events().filter(e=>e.event==='execution_started');expect(start[0].workDigest).not.toBe(start[1].workDigest);
  const denied=f.events().find(e=>e.event==='authority_denied');expect(denied.invocationId).toBe(start[0].invocationId);expect(denied.workDigest).toBe(start[0].workDigest);
 });
 it('records cancellation once and cannot report late model resolution as success', async () => {
  const f=capture(),controller=new AbortController();let resolve!:(v:ModelResult<string>)=>void;
  const result={value:'private model result',usage:{inputTokens:1,outputTokens:1,totalTokens:2},deployment:'synthetic'};
  const gateway=traceDelegatedGateway({complete:vi.fn(()=>new Promise<ModelResult<string>>(r=>resolve=r))} as unknown as NativeModelGateway);
  await withDelegatedTrace(message,async()=>{
   const pending=gateway.complete({role:'coordinator',input:'private prompt',instructions:'private instructions',schema:z.string(),schemaName:'fixture',signal:controller.signal});
   controller.abort();resolve(result);expect(await pending).toEqual(result);return 'settled';
  });
  expect(f.events().filter(e=>e.event==='model_aborted')).toHaveLength(1);expect(f.events().some(e=>e.event==='model_resolved')).toBe(false);
  expect(JSON.stringify(f.events())).not.toMatch(/private prompt|private instructions|private model result/);
 });
 it('retains the original model invocation when another delivery triggers cancellation',async()=>{
  const f=capture(),controller=new AbortController();let started!:()=>void,resolve!:(value:ModelResult<string>)=>void;
  const ready=new Promise<void>(r=>started=r),result={value:'private',usage:{inputTokens:0,outputTokens:0,totalTokens:0},deployment:'synthetic'};
  const gateway=traceDelegatedGateway({complete:vi.fn(()=>{started();return new Promise<ModelResult<string>>(r=>resolve=r);})}as unknown as NativeModelGateway);
  const first=withDelegatedTrace(message,async()=>{await gateway.complete({role:'coordinator',input:'private',instructions:'private',schema:z.string(),schemaName:'fixture',signal:controller.signal});return 'settled';});
  await ready;const other={...message,target:{...message.target,taskId:'other-private-task'}};
  await withDelegatedTrace(other,async()=>{controller.abort();resolve(result);return 'settled';});await first;
  const starts=f.events().filter(e=>e.event==='execution_started'),abort=f.events().find(e=>e.event==='model_aborted');
  expect(abort.invocationId).toBe(starts[0].invocationId);expect(abort.workDigest).toBe(starts[0].workDigest);expect(abort.invocationId).not.toBe(starts[1].invocationId);
 });
 it('removes the signal listener when the model completes normally', async () => {
  const f=capture(),controller=new AbortController();const result={value:'done',usage:{inputTokens:0,outputTokens:0,totalTokens:0},deployment:'synthetic'};
  const gateway=traceDelegatedGateway({complete:vi.fn(async()=>result)} as unknown as NativeModelGateway);
  await withDelegatedTrace(message,async()=>{await gateway.complete({role:'coordinator',input:'private',instructions:'private',schema:z.string(),schemaName:'fixture',signal:controller.signal});controller.abort();return 'settled';});
  expect(f.events().map(e=>e.event)).toEqual(['execution_started','model_started','model_resolved','execution_settled']);
 });
 it('preserves the original retry error even when diagnostic output fails', async () => {
  const f=capture();f.log.mockImplementation(()=>{throw Error('logging unavailable');});const original=Error('private cause');
  await expect(withDelegatedTrace(message,async()=>{throw original;})).rejects.toBe(original);
 });
 it('does not manufacture a model success or allowed authority on dependency errors', async()=>{
  const f=capture(),failure=Error('private provider message');
  await expect(withDelegatedTrace(message,async()=>{await traceDelegatedAuthority(async()=>{throw failure;})(message.target,{deadlineAt:Date.now()+1000});return 'settled';})).rejects.toBe(failure);
  expect(f.events().map(e=>e.event)).toEqual(['execution_started','authority_unavailable','execution_retry']);expect(JSON.stringify(f.events())).not.toContain('private provider message');
 });
});
