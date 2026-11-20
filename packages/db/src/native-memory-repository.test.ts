import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { describe,expect,it,vi } from 'vitest';
import type { ActorContext } from '@pactwoven/contracts';
import { PostgresNativeMemoryRepository,PostgresNativeMemoryTaskRepository } from './native-memory-repository';
import { NativeMemorySourceWriteSchema } from './native-memory-persistence-schema';
const scope={environment:'simulation' as const,organizationId:'org',siteId:'site'};
const actor:ActorContext={environment:scope.environment,organizationId:scope.organizationId,actorId:'person',principalKind:'human',roles:['owner'],siteIds:['site'],actionSiteIds:['site'],sessionId:'session',authenticatedAt:'2026-11-18T10:00:00Z',correlationId:'request'};
const reference={...scope,memoryId:'memory',revision:1,digest:'a'.repeat(64)};
const setup=()=>{const query=vi.fn();const pool={query} as unknown as Pool;return {query,api:new PostgresNativeMemoryRepository(pool,'simulation'),worker:new PostgresNativeMemoryTaskRepository(pool,'simulation')};};
describe('native memory repository boundary',()=>{
 it('uses parameterized fixed recovery and validates the returned reference shape',async()=>{
  const {query,api}=setup(),key=randomUUID(),response={kind:'memory',originalReference:reference,currentReference:reference,availability:'current'};
  query.mockResolvedValue({rows:[{response}]});expect(await api.recover(actor,'site',key)).toEqual(response);
  expect(query).toHaveBeenCalledWith('SELECT pactwoven.native_memory_human_recover($1::jsonb,$2,$3) AS response',[expect.any(String),'site',key]);
  expect(JSON.parse(query.mock.calls[0]![1][0])).toEqual(actor);
 });
 it('keeps an unknown committed result unknown and does not retry',async()=>{
  const {query,api}=setup();query.mockRejectedValue(new Error('private database address and supplied input'));
  await expect(api.recover(actor,'site',randomUUID())).rejects.toMatchObject({code:'DURABLE_SERVICE_UNAVAILABLE',status:503});expect(query).toHaveBeenCalledTimes(1);
 });
 it.each([['NM001','FORBIDDEN'],['NM003','IDEMPOTENCY_CONFLICT'],['NM005','VERSION_CONFLICT'],['NM008','EVIDENCE_STALE'],['ND001','FORBIDDEN']])('maps %s without exposing database diagnostics',async(code,expected)=>{
  const {query,api}=setup();query.mockRejectedValue({code,message:'secret fixture diagnostic',detail:'private context'});
  await expect(api.recover(actor,'site',randomUUID())).rejects.toMatchObject({code:expected});
  try{await api.recover(actor,'site',randomUUID());}catch(error){expect(String(error)).not.toContain('secret');}
 });
 it('rejects mismatched environment and nonhuman actor before database access',()=>{
  const {query,api}=setup();
  for(const changed of [{...actor,environment:'production' as const},{...actor,principalKind:'service' as const}])
   expect(()=>api.recover(changed,'site',randomUUID())).toThrow('Current memory access');
  expect(query).not.toHaveBeenCalled();
 });
 it('never accepts a caller-provided authority boolean in a task selector',()=>{
  const {query,worker}=setup();
  expect(()=>worker.read({organizationId:'org',taskId:'task',generation:1,handoffId:'handoff',leaseToken:randomUUID(),authorized:true} as never,reference)).toThrow();
  expect(query).not.toHaveBeenCalled();
 });
 it('treats a malformed success payload as an unconfirmed service result',async()=>{
  const {query,api}=setup();query.mockResolvedValue({rows:[{response:{kind:'memory',originalReference:reference,currentReference:reference,availability:'current',body:'unexpected'}}]});
  await expect(api.recover(actor,'site',randomUUID())).rejects.toMatchObject({code:'DURABLE_SERVICE_UNAVAILABLE'});
 });
 it('rejects submillisecond storage instants without rounding input digests',()=>{
  const record={schemaVersion:1,...scope,sourceId:'source',revision:1,kind:'user_statement',status:'active',contentDigest:'b'.repeat(64),provenance:{kind:'user',actorId:'person'},observedAt:'2026-11-18T10:00:00.1234Z',validFrom:'2026-11-18T10:00:00Z',validUntil:'2026-11-19T10:00:00Z',access:{readers:[{kind:'user',id:'person'}],purposes:['human_review']},conflict:'clear',verification:'unverified'};
  expect(NativeMemorySourceWriteSchema.safeParse({kind:'create',expected:null,record}).success).toBe(false);
  expect(NativeMemorySourceWriteSchema.safeParse({kind:'create',expected:null,record:{...record,observedAt:'2026-11-18T05:00:00.123-05:00'}}).success).toBe(true);
 });
});
