import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { financialPolicyFixture, financialPolicyFixtureEnabled, type FinancialPolicyFixture } from './financial-authority.test-support.js';
import { financialBudgetPeriodId } from '@pactwoven/domain';

describe.skipIf(!financialPolicyFixtureEnabled)('FA-1A bounded policy feature isolation',()=>{
  let f:FinancialPolicyFixture;beforeAll(async()=>{f=await financialPolicyFixture();},60000);afterAll(async()=>{await f?.close();});
  it('separates private verifier, authorizer and unrelated application access',async()=>{
    const e=await f.identity(),doc=await f.saveDocument('budget_policy');
    await expect(f.verifier.pool.query('SELECT pactwoven.financial_policy_command($1,$2::jsonb)',[e.id,JSON.stringify(doc.command)])).rejects.toMatchObject({code:'42501'});
    await expect(f.stranger.pool.query('SELECT pactwoven.financial_policy_command($1,$2::jsonb)',[e.id,JSON.stringify(doc.command)])).rejects.toMatchObject({code:'42501'});
    for(const pool of [f.verifier.pool,f.authorizer.pool,f.stranger.pool]) await expect(pool.query('SELECT body FROM pactwoven.financial_policy_evidence')).rejects.toMatchObject({code:'42501'});
  });
  it('requires scope-matched current identity and explicit action-site grants',async()=>{
    const d=await f.draft(),i=await f.identity('operations_a');
    await expect(f.repository.readFinancialPolicy(i.id,{environment:'development',organizationId:'org_b',responsibilityId:'responsibility_a',id:d.command.id,version:null})).rejects.toMatchObject({code:'FINANCIAL_POLICY_ACCESS_DENIED'});
    await f.admin.query("DELETE FROM pactwoven.member_action_sites WHERE actor_id='operations_a'");
    await expect(f.repository.readFinancialPolicy(i.id,{environment:'development',organizationId:'org_a',responsibilityId:'responsibility_a',id:d.command.id,version:null})).rejects.toMatchObject({code:'FINANCIAL_POLICY_ACCESS_DENIED'});
    await f.admin.query("INSERT INTO pactwoven.member_action_sites VALUES('development','org_a','operations_a','site_a')");
  });
  it('rejects direct mutation and retains full earlier document bytes',async()=>{
    const d=await f.saveDocument('approval_policy');
    await expect(f.admin.query("UPDATE pactwoven.financial_policy_records SET body=jsonb_set(body,'{text}','\"replacement\"') WHERE id=$1",[d.result.body.id])).rejects.toMatchObject({code:'FP007'});
    await expect(f.admin.query('DELETE FROM pactwoven.financial_policy_records WHERE id=$1',[d.result.body.id])).rejects.toMatchObject({code:'FP007'});
    expect((await f.admin.query('SELECT body FROM pactwoven.financial_policy_records WHERE id=$1',[d.result.body.id])).rows[0].body).toEqual(d.result.body);
  });
  it('does not let operations propose or expand governance',async()=>{
    const p=await f.governance();await expect(f.repository.mutate((await f.identity('operations_a')).id,{...p.command,id:`new_${crypto.randomUUID()}`,key:`other_${crypto.randomUUID()}`})).rejects.toMatchObject({code:'FINANCIAL_POLICY_ACCESS_DENIED'});
  });
  it('rejects a later conflicting exact decision and preserves the original outcome',async()=>{
    const p=await f.governance(),accepted=await f.consent(p.result),i=await f.identity('owner_b'),proposer=await f.identity();
    if(p.result.body.kind!=='governance')throw new Error('Fixture');
    await expect(f.repository.mutate(i.id,{...f.base('reject_governance',p.result.body.id),kind:'reject_governance',responsibilityId:null,previous:p.result.target,expectedControl:p.result.body.expectedControl,proposerEvidenceId:proposer.id})).rejects.toMatchObject({code:'FINANCIAL_POLICY_SCOPE_CHANGED'});
    expect((await f.repository.readFinancialPolicy(i.id,{environment:'development',organizationId:'org_a',responsibilityId:null,id:p.result.body.id,version:null}))?.record).toEqual(accepted.result.body);
  });
  it('permits exactly one winner when independent acceptance and rejection race',async()=>{
    const p=await f.governance(),prepared=await f.prepareConsent(p.result),reviewer=await f.identity('owner_b'),proposer=await f.identity();
    if(p.result.body.kind!=='governance')throw new Error('Fixture');
    const reject={...f.base('reject_governance',p.result.body.id),kind:'reject_governance' as const,responsibilityId:null,previous:p.result.target,expectedControl:p.result.body.expectedControl,proposerEvidenceId:proposer.id};
    const outcomes=await Promise.allSettled([f.repository.mutate(prepared.approver.id,prepared.command),f.repository.mutate(reviewer.id,reject)]);
    expect(outcomes.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(outcomes.filter(r=>r.status==='rejected')).toHaveLength(1);
    const failed=outcomes.find(r=>r.status==='rejected');expect(failed).toMatchObject({reason:{code:'FINANCIAL_POLICY_SCOPE_CHANGED'}});
    expect((await f.admin.query('SELECT count(*) AS count FROM pactwoven.financial_policy_records WHERE id=$1 AND version=2',[p.result.body.id])).rows[0].count).toBe('1');
  });
  it('rejects overlapping period aliases for the same stable budget account',async()=>{
    const p=await f.governance();if(p.command.kind!=='propose_governance')throw new Error('Fixture');
    const startsAt=new Date(Date.parse(p.command.bundle.period.startsAt)+1).toISOString(),endsAt=p.command.bundle.period.endsAt;
    const period={id:await financialBudgetPeriodId(p.command.bundle.budgetAccountId,startsAt,endsAt),startsAt,endsAt};
    await expect(f.repository.mutate((await f.identity()).id,{...p.command,id:`overlap_${crypto.randomUUID()}`,key:`overlap_${crypto.randomUUID()}`,bundle:{...p.command.bundle,period}})).rejects.toMatchObject({code:'FINANCIAL_POLICY_SCOPE_CHANGED'});
    expect((await f.admin.query('SELECT count(*) AS count FROM pactwoven.financial_budget_periods WHERE id=$1',[period.id])).rows[0].count).toBe('0');
  });
  it('requires fresh consent when the exact policy documents change',async()=>{
    const p=await f.governance(),prepared=await f.prepareConsent(p.result);
    await f.repository.mutate((await f.identity()).id,{...p.budget.command,key:`revision_${crypto.randomUUID()}`,previous:p.budget.result.target,text:'Materially revised budget conditions.'});
    await expect(f.repository.mutate(prepared.approver.id,prepared.command)).rejects.toMatchObject({code:'FINANCIAL_POLICY_SCOPE_CHANGED'});
    expect((await f.admin.query('SELECT count(*) AS count FROM pactwoven.financial_policy_evidence_uses WHERE evidence_id=$1',[prepared.evidence.id])).rows[0].count).toBe('0');
  });
  it('rechecks current organization scope after a real database lock wait',async()=>{
    const identity=await f.identity(),command={...f.base('save_document',`wait_${crypto.randomUUID()}`),kind:'save_document' as const,purpose:'budget_policy' as const,text:'Synthetic wait review.'};
    const holder=await f.admin.connect(),waiter=await f.authorizer.pool.connect();
    try{
      await holder.query('BEGIN');await holder.query("SELECT id FROM pactwoven.organizations WHERE environment='development' AND id='org_a' FOR UPDATE");
      const holderPid=(await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await waiter.query('BEGIN ISOLATION LEVEL READ COMMITTED');const waiterPid=(await waiter.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const pending=waiter.query('SELECT pactwoven.financial_policy_command($1,$2::jsonb)',[identity.id,JSON.stringify(command)]).then(value=>({value}),error=>({error}));
      let blocked=false;const deadline=Date.now()+2000;
      while(Date.now()<deadline){blocked=(await f.admin.query('SELECT $2::int=ANY(pg_blocking_pids($1)) AS blocked',[waiterPid,holderPid])).rows[0].blocked;if(blocked)break;await new Promise(resolve=>setTimeout(resolve,10));}
      expect(blocked).toBe(true);await holder.query("UPDATE pactwoven.organizations SET authority_epoch=authority_epoch+1 WHERE environment='development' AND id='org_a'");await holder.query('COMMIT');
      expect(await pending).toMatchObject({error:{code:'FP002'}});
      expect((await f.admin.query('SELECT count(*) AS count FROM pactwoven.financial_policy_operations WHERE key=$1',[command.key])).rows[0].count).toBe('0');
    }finally{await holder.query('ROLLBACK');await waiter.query('ROLLBACK');holder.release();waiter.release();}
  });
});
