import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { financialPolicyFixture, financialPolicyFixtureEnabled, type FinancialPolicyFixture } from './financial-authority.test-support.js';
import { financialPolicyRecordHash, financialPolicyCommandHash } from '@pactwoven/domain';

describe.skipIf(!financialPolicyFixtureEnabled)('FA-1A actual PostgreSQL policy records', () => {
  let f: FinancialPolicyFixture;
  beforeAll(async () => { f = await financialPolicyFixture(); }, 60000);
  afterAll(async () => { await f?.close(); });
  it('starts without configuration consent, financial consumers or seeded funds', async () => {
    const row=(await f.admin.query("SELECT (SELECT count(*) FROM pactwoven.financial_governance_controls) AS controls,(SELECT count(*) FROM pactwoven.financial_policy_records) AS records,(SELECT count(*) FROM pactwoven.financial_authority_fences WHERE family<>'none') AS heads")).rows[0];
    expect(row).toEqual({controls:'0',records:'0',heads:'0'});
  });
  it('persists full policy documents with SQL/TypeScript hashes and exact original-key recovery', async () => {
    const {command,result}=await f.saveDocument('budget_policy'),i=await f.identity();
    expect(result.target.recordHash).toBe(await financialPolicyRecordHash(result.body));expect(result.commandHash).toBe(await financialPolicyCommandHash(result.actorId,command));
    expect(await f.repository.mutate(i.id,command)).toEqual(result);
    expect(await f.repository.readFinancialPolicyOperation(i.id,{environment:'development',organizationId:'org_a',responsibilityId:null,kind:command.kind,key:command.key,commandHash:result.commandHash})).toEqual(result);
    await expect(f.repository.mutate(i.id,{...command,text:'Changed original request.'})).rejects.toMatchObject({code:'FINANCIAL_POLICY_KEY_CONFLICT'});
    const second=await f.repository.mutate(i.id,{...command,key:`next_${crypto.randomUUID()}`,previous:result.target,text:'Revised full terms.'});
    expect(second.body.version).toBe(2);expect((await f.repository.readFinancialPolicy(i.id,{environment:'development',organizationId:'org_a',responsibilityId:null,id:command.id,version:1}))?.state).toBe('SUPERSEDED');
  });
  it('saves incomplete drafts, reports missing gates, and withdraws without changing current authority', async () => {
    const {command,result}=await f.draft(),i=await f.identity('operations_a');
    const view=await f.repository.readFinancialPolicy(i.id,{environment:'development',organizationId:'org_a',responsibilityId:'responsibility_a',id:command.id,version:null});
    expect(view?.blockers).toEqual(expect.arrayContaining(['GOVERNANCE_MISSING','ASSET_MISSING','ACCOUNT_MISSING','TRUST_UNAVAILABLE','FINANCIAL_AUTHORITY_UNAVAILABLE']));
    expect(view?.effectiveAuthority).toBe(false);
    const withdrawn=await f.repository.mutate(i.id,{...f.base('withdraw_draft',command.id,'responsibility_a'),kind:'withdraw_draft',responsibilityId:'responsibility_a',previous:result.target});
    expect(withdrawn.body).toMatchObject({kind:'draft',state:'WITHDRAWN'});
    expect((await f.admin.query("SELECT family,generation FROM pactwoven.financial_authority_fences WHERE organization_id='org_a' AND responsibility_id='responsibility_a'")).rows[0]).toEqual({family:'none',generation:0});
    await expect(f.repository.mutate(i.id,{...command,key:`again_${crypto.randomUUID()}`,previous:withdrawn.target})).rejects.toMatchObject({code:'FINANCIAL_POLICY_SCOPE_CHANGED'});
  });
  it('accepts exact independent configuration consent without activating a financial family', async () => {
    const proposal=await f.governance(),flow=await f.consent(proposal.result);
    expect(flow.result.body).toMatchObject({kind:'governance',state:'ACCEPTED'});expect(flow.result.financialState).toBeNull();expect(flow.result.effectiveAuthority).toBe(false);
    expect(await f.repository.mutate((await f.identity('finance_a')).id,flow.command)).toEqual(flow.result);
    const row=(await f.admin.query("SELECT (SELECT count(*) FROM pactwoven.financial_budget_accounts) AS accounts,(SELECT count(*) FROM pactwoven.financial_budget_periods) AS periods,(SELECT count(*) FROM pactwoven.financial_governance_controls) AS controls,(SELECT count(*) FROM pactwoven.financial_policy_evidence_uses) AS uses,(SELECT count(*) FROM pactwoven.financial_authority_fences WHERE family<>'none') AS financial_heads")).rows[0];
    expect(row).toEqual({accounts:'1',periods:'1',controls:'1',uses:'1',financial_heads:'0'});
  });
  it('reuses stable budget and period identity for a new governance version', async () => {
    const proposal=await f.governance(),flow=await f.consent(proposal.result);
    expect(flow.result.body.kind).toBe('governance');
    expect((await f.admin.query('SELECT count(*) AS count FROM pactwoven.financial_budget_accounts')).rows[0].count).toBe('1');
    expect((await f.admin.query('SELECT count(*) AS count FROM pactwoven.financial_budget_periods')).rows[0].count).toBe('1');
    expect((await f.admin.query('SELECT max(generation) AS generation FROM pactwoven.financial_governance_controls')).rows[0].generation).toBe(2);
  });
  it('paginates actual responsibility drafts with stable sorted identities', async () => {
    await f.draft('pagination_a');await f.draft('pagination_b');const i=await f.identity();
    const page=await f.repository.listFinancialPolicyDrafts(i.id,{environment:'development',organizationId:'org_a',responsibilityId:'responsibility_a',afterId:'pagination_0',limit:1});
    expect(page.items[0]?.record.id).toBe('pagination_a');expect(page.nextId).toBe('pagination_a');
    const next=await f.repository.listFinancialPolicyDrafts(i.id,{environment:'development',organizationId:'org_a',responsibilityId:'responsibility_a',afterId:page.nextId,limit:1});
    expect(next.items[0]?.record.id).toBe('pagination_b');expect(next.nextId).toBeNull();
  });
  it('keeps operations, complete transition history, audit and outbox reciprocal', async () => {
    const counts=(await f.admin.query('SELECT (SELECT count(*) FROM pactwoven.financial_policy_records) AS records,(SELECT count(*) FROM pactwoven.financial_policy_operations) AS operations,(SELECT count(*) FROM pactwoven.financial_policy_audit) AS audit,(SELECT count(*) FROM pactwoven.financial_policy_outbox) AS outbox')).rows[0];
    expect(counts.records).toBe(counts.operations);expect(counts.records).toBe(counts.audit);expect(counts.records).toBe(counts.outbox);
  });
  it('records one operation for concurrent submissions of the same exact new document',async()=>{
    const i=await f.identity(),command={...f.base('save_document',`duplicate_${crypto.randomUUID()}`),kind:'save_document' as const,purpose:'budget_policy' as const,text:'Concurrent exact synthetic policy.'};
    const [a,b]=await Promise.all([f.repository.mutate(i.id,command),f.repository.mutate(i.id,command)]);expect(a).toEqual(b);
    expect((await f.admin.query('SELECT count(*) AS count FROM pactwoven.financial_policy_operations WHERE key=$1',[command.key])).rows[0].count).toBe('1');
  });
  it('supersedes an open proposal when another proposal advances its pinned budget control', async () => {
    const stale = await f.governance('stale_control_proposal'), chosen = await f.governance('chosen_control_proposal');
    if (stale.result.body.kind !== 'governance' || chosen.result.body.kind !== 'governance') throw new Error('Expected governance fixtures.');
    expect(stale.result.body.expectedControl).toEqual(chosen.result.body.expectedControl);
    const identity = await f.identity('finance_a');
    const query = { environment: 'development' as const, organizationId: 'org_a', responsibilityId: null, id: stale.result.body.id, version: null };
    expect(await f.repository.readFinancialPolicy(identity.id, query)).toMatchObject({ state: 'OPEN', current: true, effectiveAuthority: false });
    const accepted = await f.consent(chosen.result);
    for (const version of [null, stale.result.body.version]) {
      const view = await f.repository.readFinancialPolicy(identity.id, { ...query, version });
      expect(view).toEqual({ record: stale.result.body, reference: stale.result.target, state: 'SUPERSEDED', current: false, blockers: [], effectiveAuthority: false });
    }
    expect(await f.repository.readFinancialPolicy(identity.id, { ...query, id: accepted.result.body.id })).toMatchObject({
      record: accepted.result.body, reference: accepted.result.target, state: 'ACCEPTED', current: true, effectiveAuthority: false,
    });
    expect(await f.repository.readFinancialPolicy(identity.id, { ...query, id: chosen.result.body.id, version: chosen.result.body.version })).toMatchObject({
      record: chosen.result.body, reference: chosen.result.target, state: 'SUPERSEDED', current: false,
    });
    const fresh = await f.governance('fresh_control_proposal');
    expect(await f.repository.readFinancialPolicy(identity.id, { ...query, id: fresh.result.body.id })).toMatchObject({ state: 'OPEN', current: true, effectiveAuthority: false });
  });
  it('preserves accepted and rejected historical decisions when later control generations advance', async () => {
    const accepted = await f.consent((await f.governance('historical_accepted_proposal')).result);
    const proposal = await f.governance('historical_rejected_proposal');
    if (proposal.result.body.kind !== 'governance') throw new Error('Expected governance fixture.');
    const proposer = await f.identity(), approver = await f.identity('finance_a');
    const rejected = await f.repository.mutate(approver.id, { ...f.base('reject_governance', proposal.result.body.id), kind: 'reject_governance', responsibilityId: null,
      previous: proposal.result.target, expectedControl: proposal.result.body.expectedControl, proposerEvidenceId: proposer.id });
    await f.consent((await f.governance('later_accepted_proposal')).result);
    for (const result of [accepted.result, rejected]) {
      if (result.body.kind !== 'governance') throw new Error('Expected governance decision.');
      for (const version of [null, result.body.version]) {
        const view = await f.repository.readFinancialPolicy(approver.id, { environment: 'development', organizationId: 'org_a', responsibilityId: null, id: result.body.id, version });
        expect(view).toEqual({ record: result.body, reference: result.target, state: result.body.state, current: true, blockers: [], effectiveAuthority: false });
      }
    }
  });
});
