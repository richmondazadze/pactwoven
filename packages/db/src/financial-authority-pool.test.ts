import { Socket } from 'node:net';
import type { Pool, PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { financialPolicyFixtureConfig, financialPolicyFixtureEnvironment, assertFinancialPolicyFixture } from './financial-authority.test-support.js';
import { assertFinancialAuthorityConnection } from './financial-authority-pool.js';
import { financialPolicyRoutines, financialPolicyClosureRoutines, financialPolicyClosureTable } from './financial-policy-schema.js';
import { financialPolicyTransaction } from './financial-policy-repository.js';

const url=(port=55439)=>{const u=new URL(`postgres://127.0.0.1:${port}/pactwoven_financial_policy_fa1_test`);u.username='fixture';u.password='synthetic';return u.href;};
describe('financial policy fixture and capability boundaries',()=>{
  it('uses only its assigned database, loopback transport and paired CI exception',()=>{
    expect(financialPolicyFixtureConfig(url(),{})).toMatchObject({host:'127.0.0.1',port:55439,database:'pactwoven_financial_policy_fa1_test',ssl:false});
    expect(financialPolicyFixtureConfig(url(55440),{CI:'true',GITHUB_ACTIONS:'true'}).port).toBe(55440);
    for(const v of [url().replace('127.0.0.1','localhost'),url().replace('pactwoven_financial_policy_fa1_test','pactwoven_dev'),url()+'?host=elsewhere',url(5432),url(55440)]) expect(()=>financialPolicyFixtureConfig(v,{})).toThrow();
  });
  it('scrubs unrelated product and PostgreSQL credentials',()=>expect(financialPolicyFixtureEnvironment({PATH:'/bin',PGHOST:'elsewhere',PGPASSWORD:'synthetic',PACTWOVEN_DATABASE_URL:'synthetic'})).toEqual({PATH:'/bin'}));
  it('verifies the socket and authenticated principal before fixture queries',async()=>{
    const socket=new Socket();for(const [key,value] of Object.entries({remotePort:55439,remoteAddress:'127.0.0.1',readyState:'open',destroyed:false}))Object.defineProperty(socket,key,{value});
    const query=vi.fn().mockResolvedValue({rows:[{database:'pactwoven_financial_policy_fa1_test',current:'fixture',session:'fixture'}]}),c={connection:{stream:socket},query} as unknown as PoolClient;
    await expect(assertFinancialPolicyFixture(c,financialPolicyFixtureConfig(url(),{}))).resolves.toBeUndefined();
    query.mockClear();await expect(assertFinancialPolicyFixture({...c,connection:{stream:{}}} as unknown as PoolClient,financialPolicyFixtureConfig(url(),{}))).rejects.toThrow();expect(query).not.toHaveBeenCalled();
  });
  it('rejects unknown, missing or false capability results',async()=>{
    for(const rows of [[],[{safe:false}],[{safe:'true'}],[{safe:true},{safe:true}]]){
      const query=vi.fn().mockResolvedValue({rows});await expect(assertFinancialAuthorityConnection({query} as unknown as PoolClient,'authorizer')).rejects.toMatchObject({code:'UNSAFE_DATABASE_ROLE'});
    }
  });
  it('pins separated routine allowlists and checks every checkout',async()=>{
    const query=vi.fn().mockResolvedValue({rows:[{safe:true}]});await assertFinancialAuthorityConnection({query} as unknown as PoolClient,'verifier');
    expect(query.mock.calls[0]?.[1]).toEqual([financialPolicyRoutines.verifier,expect.any(Array),'pactwoven_financial_verifier','pactwoven_financial_authorizer',
      financialPolicyClosureRoutines,financialPolicyClosureTable,false,false]);
    expect(financialPolicyRoutines.authorizer).toHaveLength(9);expect(financialPolicyRoutines.verifier).toEqual(['pactwoven.financial_policy_attest(jsonb)', 'pactwoven.financial_policy_resolve_observer(text,jsonb)']);
    expect(financialPolicyRoutines.authorizer).toEqual(expect.arrayContaining([
      'pactwoven.financial_policy_read_context(uuid,jsonb,jsonb)', 'pactwoven.financial_policy_governance_index(uuid,jsonb,jsonb)',
      'pactwoven.financial_policy_original_read(uuid,jsonb,jsonb)', 'pactwoven.financial_policy_proposer_observation(uuid,jsonb,jsonb)',
      'pactwoven.financial_policy_prepare(uuid,jsonb,jsonb)',
    ]));
  });
  it('preserves an unknown COMMIT and discards its connection without an automatic retry',async()=>{
    const release=vi.fn(),query=vi.fn(async(sql:string)=>{if(sql==='COMMIT')throw new Error('synthetic dropped commit reply');return{rows:[{safe:true}]};});
    const connect=vi.fn().mockResolvedValue({query,release}),pool={connect} as unknown as Pool;
    await expect(financialPolicyTransaction(pool,'authorizer',async()=>({recorded:true}))).rejects.toMatchObject({code:'FINANCIAL_POLICY_OUTCOME_UNKNOWN'});
    expect(connect).toHaveBeenCalledOnce();expect(release).toHaveBeenCalledExactlyOnceWith(true);expect(query.mock.calls.filter(([s])=>s==='COMMIT')).toHaveLength(1);
    expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  });
});
