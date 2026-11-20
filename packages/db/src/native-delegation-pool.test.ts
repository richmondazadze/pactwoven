import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { assertNativeDelegationPool } from './native-delegation-pool.js';
import { PostgresNativeDelegationRepository, PostgresNativeDelegationWorkerRepository } from './native-delegation-repository.js';

function fakePool(safe: boolean, commit = 'COMMIT') {
  const release = vi.fn();
  const query = vi.fn(async (sql: string) => ({ rows: sql.includes('WITH RECURSIVE') ? [{safe}] : [], command: sql === 'COMMIT' ? commit : sql }));
  const pool = { connect: vi.fn(async()=>({query,release})) } as unknown as Pool;
  return {pool,query,release};
}
describe('delegation pool qualification failure handling',()=>{
  it('adds only four paid root routines to the coordinator profile',async()=>{
    const before=fakePool(true),after=fakePool(true);
    await assertNativeDelegationPool(before.pool,'development','coordinator','delegation-root-instructions');
    await assertNativeDelegationPool(after.pool,'development','coordinator','delegation-root-paid');
    const allowed=(f:ReturnType<typeof fakePool>)=>(f.query.mock.calls.find(([sql])=>sql.includes('WITH RECURSIVE')) as unknown as [string,unknown[]])[1][2] as string[];
    expect(allowed(after).filter(x=>!allowed(before).includes(x))).toEqual(['pactwoven.paid_tool_root_wait(jsonb,jsonb)','pactwoven.paid_tool_root_read(jsonb)','pactwoven.paid_tool_root_consume(jsonb,jsonb)','pactwoven.paid_tool_root_policy(jsonb)']);
    expect(allowed(before).every(x=>allowed(after).includes(x))).toBe(true);
  });
  it.each(['api','worker','dispatcher'] as const)('rejects paid root privileges for %s',async purpose=>{
    const f=fakePool(true);await expect(assertNativeDelegationPool(f.pool,'development',purpose,'delegation-root-paid')).rejects.toMatchObject({code:'UNSAFE_DATABASE_ROLE'});expect(f.pool.connect).not.toHaveBeenCalled();
  });
  it('extends the instruction API profile by exactly one read-only activity routine',async()=>{
    const before=fakePool(true),after=fakePool(true);
    await assertNativeDelegationPool(before.pool,'development','api','delegation-workspace-instructions');
    await assertNativeDelegationPool(after.pool,'development','api','delegation-workspace-activity');
    const allowed=(f:ReturnType<typeof fakePool>)=>(f.query.mock.calls.find(([sql])=>sql.includes('WITH RECURSIVE')) as unknown as [string,unknown[]])[1][2] as string[];
    expect(allowed(after).filter(x=>!allowed(before).includes(x))).toEqual(['pactwoven.native_work_activity_read(jsonb,text,text)']);
    expect(allowed(before).every(x=>allowed(after).includes(x))).toBe(true);
  });
  it.each(['coordinator','worker','dispatcher'] as const)('denies activity read profile to %s',async purpose=>{
    const f=fakePool(true);await expect(assertNativeDelegationPool(f.pool,'development',purpose,'delegation-workspace-activity')).rejects.toMatchObject({code:'UNSAFE_DATABASE_ROLE'});
    expect(f.pool.connect).not.toHaveBeenCalled();
  });
  it.each(['coordinator','worker'] as const)('adds only fixed instruction routines to the refresh profile for %s',async purpose=>{
    const before=fakePool(true),after=fakePool(true);
    await assertNativeDelegationPool(before.pool,'development',purpose,'delegation-root-refresh');
    await assertNativeDelegationPool(after.pool,'development',purpose,'delegation-root-instructions');
    const allowed=(f:ReturnType<typeof fakePool>)=>(f.query.mock.calls.find(([sql])=>sql.includes('WITH RECURSIVE')) as unknown as [string,unknown[]])[1][2] as string[];
    const extra=allowed(after).filter(x=>!allowed(before).includes(x));
    expect(extra).toHaveLength(purpose==='coordinator'?11:2);
    expect(extra).toContain('pactwoven.native_delegation_result_commit_v3(text,jsonb,jsonb)');
    expect(extra.every(x=>x.includes('_v3('))).toBe(true);
    expect(allowed(before).every(x=>allowed(after).includes(x))).toBe(true);
    expect(new Set(allowed(after)).size).toBe(allowed(after).length);
  });
  it('adds only conversation read/update/recovery to the workspace API profile',async()=>{
    const before=fakePool(true),after=fakePool(true);
    await assertNativeDelegationPool(before.pool,'development','api','delegation-workspace');
    await assertNativeDelegationPool(after.pool,'development','api','delegation-workspace-instructions');
    const allowed=(f:ReturnType<typeof fakePool>)=>(f.query.mock.calls.find(([sql])=>sql.includes('WITH RECURSIVE')) as unknown as [string,unknown[]])[1][2] as string[];
    expect(allowed(after).filter(x=>!allowed(before).includes(x))).toEqual([
      'pactwoven.native_work_conversation_read(jsonb,text,text)', 'pactwoven.native_work_instruction_update(jsonb,text,text,text,jsonb)',
      'pactwoven.native_work_instruction_recover(jsonb,text,text,text)']);
    expect(allowed(before).every(x=>allowed(after).includes(x))).toBe(true);
    expect(new Set(allowed(after)).size).toBe(allowed(after).length);
  });
  it.each(['api','dispatcher'] as const)('denies the instruction worker profile for %s',async purpose=>{
    const f=fakePool(true);await expect(assertNativeDelegationPool(f.pool,'development',purpose,'delegation-root-instructions')).rejects.toMatchObject({code:'UNSAFE_DATABASE_ROLE'});
    expect(f.pool.connect).not.toHaveBeenCalled();
  });
  it.each(['coordinator','worker','dispatcher'] as const)('denies the conversation API profile for %s',async purpose=>{
    const f=fakePool(true);await expect(assertNativeDelegationPool(f.pool,'development',purpose,'delegation-workspace-instructions')).rejects.toMatchObject({code:'UNSAFE_DATABASE_ROLE'});
    expect(f.pool.connect).not.toHaveBeenCalled();
  });
  it.each(['coordinator','worker'] as const)('admits only the fixed refresh additions for %s',async purpose=>{
    const ordinary=fakePool(true),refresh=fakePool(true);
    await assertNativeDelegationPool(ordinary.pool,'development',purpose,'delegation-root');
    await assertNativeDelegationPool(refresh.pool,'development',purpose,'delegation-root-refresh');
    const allowed=(f:ReturnType<typeof fakePool>)=>(f.query.mock.calls.find(([sql])=>sql.includes('WITH RECURSIVE')) as unknown as [string,unknown[]])[1][2] as string[];
    const extra=allowed(refresh).filter(x=>!allowed(ordinary).includes(x));
    expect(extra).toHaveLength(purpose==='coordinator'?10:2);
    expect(extra).toContain('pactwoven.native_delegation_result_commit_v2(text,jsonb,jsonb)');
    expect(extra.every(x=>!x.includes('_epoch0')&&!x.includes('_c3')&&!x.includes('native_external_'))).toBe(true);
    expect(new Set(allowed(refresh)).size).toBe(allowed(refresh).length);
  });
  it.each(['api','dispatcher'] as const)('rejects refresh profile for %s before connection',async purpose=>{
    const f=fakePool(true);await expect(assertNativeDelegationPool(f.pool,'development',purpose,'delegation-root-refresh')).rejects.toMatchObject({code:'UNSAFE_DATABASE_ROLE'});expect(f.pool.connect).not.toHaveBeenCalled();
  });
  it('adds only external completion to the coordinator root profile when opted in',async()=>{
    const ordinary=fakePool(true),external=fakePool(true);
    await assertNativeDelegationPool(ordinary.pool,'development','coordinator','delegation-root');
    await assertNativeDelegationPool(external.pool,'development','coordinator','delegation-root-external');
    const signatures=(f:ReturnType<typeof fakePool>)=>(f.query.mock.calls.find(([sql])=>sql.includes('WITH RECURSIVE')) as unknown as [string,unknown[]])[1][2] as string[];
    expect(signatures(external)).toEqual([...signatures(ordinary),'pactwoven.native_external_wait_complete(text,jsonb,jsonb)']);
    expect(external.release).toHaveBeenCalledWith(false);
  });
  it.each(['api','worker','dispatcher'] as const)('denies the external coordinator profile for %s before connection',async purpose=>{
    const f=fakePool(true);await expect(assertNativeDelegationPool(f.pool,'development',purpose,'delegation-root-external')).rejects.toMatchObject({code:'UNSAFE_DATABASE_ROLE'});
    expect(f.pool.connect).not.toHaveBeenCalled();
  });
  it('fails closed when the enabled coordinator profile cannot be verified',async()=>{
    const f=fakePool(false);await expect(assertNativeDelegationPool(f.pool,'development','coordinator','delegation-root-external')).rejects.toMatchObject({code:'UNSAFE_DATABASE_ROLE'});
    expect(f.query).toHaveBeenCalledWith('ROLLBACK');expect(f.release).toHaveBeenCalledWith(true);
  });
  it('requires the exact fixed profile and discards a failed role connection',async()=>{
    const f=fakePool(false);await expect(assertNativeDelegationPool(f.pool,'development','worker')).rejects.toMatchObject({code:'UNSAFE_DATABASE_ROLE'});
    expect(f.release).toHaveBeenCalledWith(true);expect(f.query).toHaveBeenCalledWith('ROLLBACK');
  });
  it('does not treat a rollback command tag as committed qualification',async()=>{
    const f=fakePool(true,'ROLLBACK');await expect(assertNativeDelegationPool(f.pool,'development','api')).rejects.toMatchObject({code:'UNSAFE_DATABASE_ROLE'});expect(f.release).toHaveBeenCalledWith(true);
  });
  it('keeps fixed memory signatures in the combined profile',async()=>{
    const f=fakePool(true);await assertNativeDelegationPool(f.pool,'development','worker','delegation-memory');
    const call=f.query.mock.calls.find(([sql])=>sql.includes('WITH RECURSIVE')) as unknown as [string,unknown[]];
    expect(call[1][2]).toEqual(expect.arrayContaining(['pactwoven.native_memory_task_read(text,jsonb,jsonb)','pactwoven.native_delegation_result_commit(text,jsonb,jsonb)']));
    expect(f.release).toHaveBeenCalledWith(false);
  });
  it('rejects invented profiles before connecting',async()=>{
    const f=fakePool(true);await expect(assertNativeDelegationPool(f.pool,'development','worker','anything' as never)).rejects.toMatchObject({code:'UNSAFE_DATABASE_ROLE'});expect(f.pool.connect).not.toHaveBeenCalled();
  });
  it('adds only the four fixed note signatures to the API memory profile',async()=>{
    const f=fakePool(true);await assertNativeDelegationPool(f.pool,'development','api','delegation-memory-notes');
    const call=f.query.mock.calls.find(([sql])=>sql.includes('WITH RECURSIVE')) as unknown as [string,unknown[]];
    const allowed=call[1][2] as string[];
    expect(allowed.filter(s=>s.includes('native_memory_notes_'))).toEqual([
      'pactwoven.native_memory_notes_list(jsonb,jsonb)','pactwoven.native_memory_notes_get(jsonb,text,text)',
      'pactwoven.native_memory_notes_command(jsonb,text,jsonb)','pactwoven.native_memory_notes_recover(jsonb,text,text)']);
    expect(allowed).not.toContain('pactwoven.native_memory_task_read(text,jsonb,jsonb)');
    expect(allowed).not.toContain('pactwoven.native_delegation_result_commit(text,jsonb,jsonb)');
  });
  it.each(['coordinator','worker','dispatcher'] as const)('does not grant human note access to %s profiles',async purpose=>{
    const f=fakePool(true);await expect(assertNativeDelegationPool(f.pool,'development',purpose,'delegation-memory-notes')).rejects.toMatchObject({code:'UNSAFE_DATABASE_ROLE'});
    expect(f.pool.connect).not.toHaveBeenCalled();
  });
  it.each(['delegation-root-notes','delegation-work-intent','delegation-workspace'] as const)('reserves %s for the API audience',async profile=>{
    for(const purpose of ['coordinator','worker','dispatcher'] as const){
      const f=fakePool(true);await expect(assertNativeDelegationPool(f.pool,'development',purpose,profile)).rejects.toMatchObject({code:'UNSAFE_DATABASE_ROLE'});
      expect(f.pool.connect).not.toHaveBeenCalled();
    }
  });
  it('requires the complete API note profile for root authority',async()=>{
    const f=fakePool(true);await expect(assertNativeDelegationPool(f.pool,'development','api','delegation-root')).rejects.toMatchObject({code:'UNSAFE_DATABASE_ROLE'});
    expect(f.pool.connect).not.toHaveBeenCalled();
  });
  it.each(['api','coordinator','worker','dispatcher'] as const)('keeps the cumulative root privileges audience-specific for %s',async purpose=>{
    const f=fakePool(true);await assertNativeDelegationPool(f.pool,'development',purpose,purpose==='api'?'delegation-work-intent':'delegation-root');
    const call=f.query.mock.calls.find(([sql])=>sql.includes('WITH RECURSIVE')) as unknown as [string,unknown[]];
    const allowed=call[1][2] as string[];
    expect(new Set(allowed).size).toBe(allowed.length);
    if(purpose==='api'){
      expect(allowed).toContain('pactwoven.native_work_intent_confirm(jsonb,text,jsonb,jsonb)');
      expect(allowed).toContain('pactwoven.native_memory_notes_get(jsonb,text,text)');
      expect(allowed).not.toContain('pactwoven.native_delegation_claim(text,jsonb,integer)');
    }else{
      expect(allowed.every(s=>!s.includes('native_work_intent_')&&!s.includes('native_memory_notes_')&&!s.includes('root_control'))).toBe(true);
      if(purpose==='worker')expect(allowed.filter(s=>s.includes('native_delegation_root_'))).toEqual(['pactwoven.native_delegation_root_materials(text,jsonb)']);
      if(purpose==='dispatcher')expect(allowed).not.toContain('pactwoven.native_memory_task_read(text,jsonb,jsonb)');
    }
  });
});
describe('delegation repository transport boundary',()=>{
  const target={organizationId:'org',taskId:'task',generation:1};
  it('rejects a valid-looking proof preparation bound to a different task',async()=>{
    const query=vi.fn(async()=>({rows:[{response:{kind:'prepared',target:{...target,taskId:'other'},nonce:'fbb60c02-5644-4d70-b631-e15ec0b74bf1',
      preparedAt:'2026-11-18T12:00:00Z',deadlineAt:'2026-11-18T12:00:08Z',providerIssuer:'https://fixture.clerk.accounts.dev',
      context:{subject:'user',externalOrganizationId:'org',externalMembershipId:'member',requiredRole:null}}}]}));
    const repo=new PostgresNativeDelegationRepository({query} as unknown as Pool,'development');
    await expect(repo.prepare(target,'https://fixture.clerk.accounts.dev')).rejects.toMatchObject({code:'DURABLE_SERVICE_UNAVAILABLE'});
  });
  it('preserves unknown outcome after a lost connection and never retries a write automatically',async()=>{
    const query=vi.fn(async()=>{throw Object.assign(new Error('connection lost'),{code:'08006'});});
    const repo=new PostgresNativeDelegationWorkerRepository({query} as unknown as Pool,'development');
    await expect(repo.claim(target)).rejects.toMatchObject({code:'DURABLE_SERVICE_UNAVAILABLE'});expect(query).toHaveBeenCalledTimes(1);
  });
  it('rejects caller-provided extra target authority fields before SQL',async()=>{
    const query=vi.fn();const repo=new PostgresNativeDelegationRepository({query} as unknown as Pool,'development');
    await expect(repo.prepare({...target,authority:'invented'} as never,'https://fixture.clerk.accounts.dev')).rejects.toThrow();expect(query).not.toHaveBeenCalled();
  });
});
