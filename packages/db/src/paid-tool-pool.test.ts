import {describe,it,expect,vi} from 'vitest';
import type {Pool} from 'pg';
import {nativeDelegationExpectedSignatures} from './native-delegation-pool';
import {assertPaidToolProfile,paidToolExpectedSignatures,paidToolOptionalReadSignatures,type PaidToolPoolLane} from './paid-tool-pool';
function fixture(safe=true,commit='COMMIT'){
  const query=vi.fn(async(sql:string)=>({rows:sql.includes('WITH RECURSIVE')?[{safe}]:[],command:sql==='COMMIT'?commit:sql})),release=vi.fn();
  const pool={connect:vi.fn(async()=>({query,release}))} as unknown as Pool;return {pool,query,release};
}
describe('fixed paid service admission',()=>{
  it.each(['api','policy','signer','broadcaster','observer','delivery','scheduler'] as PaidToolPoolLane[])('requires exact enrolled%s privileges',async lane=>{
    const f=fixture();await assertPaidToolProfile(f.pool,'development',lane);
    const call=f.query.mock.calls.find(([sql])=>sql.includes('WITH RECURSIVE')) as unknown as [string,unknown[]];
    expect(call[1]).toEqual(['development',lane,paidToolExpectedSignatures(lane),paidToolOptionalReadSignatures(lane)]);expect(new Set(paidToolExpectedSignatures(lane)).size).toBe(paidToolExpectedSignatures(lane).length);
    expect(f.release).toHaveBeenCalledExactlyOnceWith(false);
  });
  it('keeps approval, signing and finality audiences separate',()=>{
    expect(paidToolOptionalReadSignatures('api')).toEqual(['pactwoven.paid_tool_retained_contributors(jsonb,text,text)',
      'pactwoven.paid_tool_completed_history(jsonb,text,text,text)', 'pactwoven.native_work_execution_read(jsonb,text,text)']);
    expect(paidToolExpectedSignatures('api').some(x=>/capture|quarantine|private_read|record_height/.test(x))).toBe(false);
    expect(paidToolExpectedSignatures('signer')).toContain('pactwoven.paid_tool_observe_for_operation(text,jsonb)');
    expect(paidToolExpectedSignatures('signer')).not.toContain('pactwoven.paid_tool_observe(jsonb)');
    expect(paidToolExpectedSignatures('scheduler').every(x=>x.includes('dispatch')||x.includes('pool_binding'))).toBe(true);
    for (const lane of ['policy','signer','broadcaster','observer','delivery','scheduler'] as PaidToolPoolLane[]) expect(paidToolOptionalReadSignatures(lane)).toEqual([]);
  });
  it('composes the native human API profile only for paid API and verifies both enrollments',async()=>{
    const native=nativeDelegationExpectedSignatures('api','delegation-workspace-activity');
    expect(paidToolExpectedSignatures('api').filter(x=>!x.startsWith('pactwoven.paid_tool_'))).toEqual(native);
    for(const lane of ['policy','signer','broadcaster','observer','delivery','scheduler'] as PaidToolPoolLane[])
      expect(paidToolExpectedSignatures(lane).some(x=>native.includes(x))).toBe(false);
    const f=fixture();await assertPaidToolProfile(f.pool,'development','api');
    const sql=f.query.mock.calls.find(([sql])=>sql.includes('WITH RECURSIVE'))![0];
    expect(sql).toContain("pactwoven.paid_tool_pool_binding($2)");
    expect(sql).toContain("CASE WHEN $2::text='api' THEN pactwoven.native_delegation_binding($1,'api') ELSE true END");
  });
  it('discards failed privilege and uncertain commit checks',async()=>{
    for(const f of [fixture(false),fixture(true,'UNKNOWN')]){await expect(assertPaidToolProfile(f.pool,'development','signer')).rejects.toThrow('admission failed');expect(f.query).toHaveBeenCalledWith('ROLLBACK');expect(f.release).toHaveBeenCalledExactlyOnceWith(true);}
  });
  it('rejects mainnet environments and unknown roles before connecting',async()=>{
    const f=fixture();await expect(assertPaidToolProfile(f.pool,'production','api')).rejects.toThrow();await expect(assertPaidToolProfile(f.pool,'development','invented' as never)).rejects.toThrow();expect(f.pool.connect).not.toHaveBeenCalled();
  });
});
