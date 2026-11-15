import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { financialPolicyRecordHash } from '@pactwoven/domain';
import { financialPolicyReadFixture, financialPolicyReadFixtureEnabled, financialPolicyReadFixtureConfig, financialPolicyReadFixtureEnvironment, type FinancialPolicyReadFixture } from './financial-policy-read.test-support.js';
import { PostgresFinancialPolicyReaders } from './financial-policy-read-repository.js';
import { FinancialPolicyContextQuerySchema, FinancialPolicyOriginalQuerySchema, FinancialPolicyReadObservationSchema } from './financial-policy-read-schema.js';

const emptyContext={responsibilityId:null,assetKey:null,documents:[]};
const counts=async(f:FinancialPolicyReadFixture)=>(await f.admin.query('SELECT (SELECT count(*) FROM pactwoven.financial_policy_operations) AS operations,(SELECT count(*) FROM pactwoven.financial_policy_records) AS records,(SELECT count(*) FROM pactwoven.financial_policy_audit) AS audit,(SELECT count(*) FROM pactwoven.financial_policy_outbox) AS outbox,(SELECT count(*) FROM pactwoven.financial_governance_controls) AS controls,(SELECT count(*) FROM pactwoven.financial_authority_fences WHERE family<>\'none\') AS heads')).rows[0];
function responseReaders(response:unknown){
  const query=vi.fn(async(sql:string)=>{if(sql.includes(' AS response')&&response instanceof Error)throw response;
    return sql.includes(' AS safe')?{rows:[{safe:true}]}:sql.includes(' AS response')?{rows:[{response}]}:{rows:[]};});
  const pool={connect:async()=>({query,release:vi.fn()})} as unknown as Pool;
  return new PostgresFinancialPolicyReaders(pool,pool);
}
function replace(value:unknown,path:string[],replacement:unknown){
  const result=structuredClone(value) as Record<string,unknown>;let parent=result;
  for(const key of path.slice(0,-1))parent=parent[key] as Record<string,unknown>;
  parent[path.at(-1)!]=replacement;return result;
}

describe('private financial reader schemas',()=>{
  it('rejects ambiguous scope and unsorted duplicate document selectors',()=>{
    expect(FinancialPolicyOriginalQuerySchema.safeParse({responsibilityId:'responsibility_a',kind:'accept_governance',key:'original_key_12345',targetId:'a'}).success).toBe(false);
    const ref={id:'doc',version:1,recordHash:'a'.repeat(64),purpose:'budget_policy'};
    expect(FinancialPolicyContextQuerySchema.safeParse({...emptyContext,documents:[ref,ref]}).success).toBe(false);
    expect(FinancialPolicyContextQuerySchema.safeParse({...emptyContext,qualified:true}).success).toBe(false);
    expect(FinancialPolicyReadObservationSchema.safeParse({verified:true}).success).toBe(false);
  });
  it('accepts only the exclusive loopback fixture and explicit CI port without inherited database variables',()=>{
    const fixtureUrl=new URL('postgres://127.0.0.1:55439/pactwoven_financial_policy_reads_test');
    fixtureUrl.username='synthetic_admin';fixtureUrl.password='synthetic_password';
    const exact=fixtureUrl.href;
    expect(financialPolicyReadFixtureConfig(exact)).toMatchObject({host:'127.0.0.1',port:55439,database:'pactwoven_financial_policy_reads_test',ssl:false});
    for(const url of [exact.replace('127.0.0.1','localhost'),exact.replace('55439','5432'),exact.replace('55439','55440'),exact.replace('reads_test','test'),exact+'?sslmode=disable',exact+'#fragment'])
      expect(()=>financialPolicyReadFixtureConfig(url,{})).toThrow('Exclusive financial policy loopback fixture required.');
    expect(financialPolicyReadFixtureConfig(exact.replace('55439','55440'),{CI:'true',GITHUB_ACTIONS:'true'}).port).toBe(55440);
    expect(()=>financialPolicyReadFixtureConfig(exact.replace('55439','55440'),{CI:'true'})).toThrow();
    expect(financialPolicyReadFixtureEnvironment({PATH:'/synthetic',PGHOST:'other',PGPASSWORD:'excluded',PACTWOVEN_DATABASE_URL:'excluded'})).toEqual({PATH:'/synthetic'});
  });
  it('rejects malformed private responses and captures input before connection waits',async()=>{
    let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);
    const query=vi.fn(async(sql:string,_parameters?:unknown[])=>sql.includes(' AS safe')?{rows:[{safe:true}]}:sql.includes(' AS response')?{rows:[{response:{verified:true}}]}:{rows:[]});
    const connect=vi.fn(async()=>{await gate;return{query,release:vi.fn()};});
    const pool={connect} as unknown as Pool,readers=new PostgresFinancialPolicyReaders(pool,pool);
    const input={identity:{subject:'owner_a',externalOrganizationId:'clerk_org_a',externalOrganizationName:'Synthetic',externalMembershipId:'membership_owner_a',externalRole:'org:member',sessionId:'session_owner_a',membershipObservedAt:'2026-11-15T12:00:00.000Z',authenticatedAt:'2026-11-15T11:59:59.000Z'},observation:{issuer:'https://synthetic.invalid',tokenHash:'a'.repeat(64),tokenIssuedAt:'2026-11-15T11:59:59.000Z',observedAt:'2026-11-15T12:00:00.000Z',expiresAt:'2026-11-15T12:04:00.000Z'}};
    const pending=readers.resolveObserver('development',input);input.identity.subject='other';release();
    await expect(pending).rejects.toMatchObject({code:'FINANCIAL_POLICY_OUTCOME_UNKNOWN'});
    const call=query.mock.calls.find(([sql])=>sql.includes('financial_policy_resolve_observer'));
    expect(call).toBeDefined();expect(JSON.parse(call![1]![1] as string).identity.subject).toBe('owner_a');expect(connect).toHaveBeenCalledOnce();
    await expect(responseReaders(Object.assign(new Error('Original stored policy is corrupt.'),{code:'FP008'})).resolveObserver('development',input)).rejects.toMatchObject({code:'FINANCIAL_POLICY_OUTCOME_UNKNOWN'});
  });
});

describe.skipIf(!financialPolicyReadFixtureEnabled)('FP-API0 actual private policy readers',()=>{
  let f:FinancialPolicyReadFixture;
  beforeEach(async()=>{f=await financialPolicyReadFixture();},60000);
  afterEach(async()=>{await f?.close();});
  it('resolves exact current local identities without creating an operation or authority',async()=>{
    const before=await counts(f);
    for(const actor of ['owner_a','finance_a','operations_a']){
      const {evidence,scope}=await f.readerIdentity(actor);
      expect(scope).toEqual({environment:'development',organizationId:'org_a',externalOrganizationId:'clerk_org_a',actor:evidence.actor,organizationEpoch:2,
        roles:[actor==='owner_a'?'owner':actor==='finance_a'?'finance':'operations'],siteIds:['site_a'],actionSiteIds:['site_a']});
    }
    expect(await counts(f)).toEqual(before);
  });
  it('returns exact inert draft basis and explicit absent configuration blockers',async()=>{
    const {evidence,scope}=await f.readerIdentity('operations_a');
    const value=await f.readers.context(evidence.id,scope,{...emptyContext,responsibilityId:'responsibility_a'});
    expect(value).toMatchObject({scope,responsibilityId:'responsibility_a',draftScope:{authority:{family:'none',generation:0},site:{id:'site_a'}},asset:null,control:null,acceptedConfiguration:null,periods:[],effectiveAuthority:false,financialState:null});
    expect(value.blockers).toEqual(expect.arrayContaining(['ASSET_MISSING','GOVERNANCE_MISSING','TRUST_UNAVAILABLE','FINANCIAL_AUTHORITY_UNAVAILABLE']));
    expect(Date.parse(value.expiresAt)-Date.parse(evidence.observedAt)).toBe(20000);
  });
  it('returns registered asset metadata and stable generation-zero configuration without seeding it',async()=>{
    const {evidence,scope}=await f.readerIdentity(),before=await counts(f);
    const value=await f.readers.context(evidence.id,scope,{...emptyContext,assetKey:f.assetPin.key});
    expect(value.asset).toMatchObject({pin:f.assetPin,decimals:6,policy:'solana-original-devnet-usdc-v1'});
    expect(value.control).toMatchObject({generation:0,accepted:null});expect(value.acceptedConfiguration).toBeNull();
    expect(await counts(f)).toEqual(before);
  });
  it('returns current accepted terms, fixed period and exact full documents',async()=>{
    const proposal=await f.governance(),accepted=await f.consent(proposal.result),{evidence,scope}=await f.readerIdentity('finance_a');
    if(proposal.result.body.kind!=='governance')throw new Error('Expected governance fixture.');
    const before=await counts(f),value=await f.readers.context(evidence.id,scope,{...emptyContext,assetKey:f.assetPin.key,documents:proposal.result.body.bundle.documents});
    expect(value.control).toMatchObject({generation:1,accepted:accepted.result.target});
    expect(value.acceptedConfiguration?.record).toEqual(accepted.result.body);expect(value.periods).toEqual([proposal.result.body.bundle.period]);
    expect(value.documents.map(d=>d.record)).toEqual(proposal.result.body.bundle.documents.map(ref=>ref.id===proposal.budget.result.body.id?proposal.budget.result.body:proposal.approval.result.body));
    expect(await counts(f)).toEqual(before);
  });
  it('preserves a requested historical document and reports its changed status',async()=>{
    const document=await f.saveDocument('budget_policy'),{evidence,scope}=await f.readerIdentity();
    if(document.command.kind!=='save_document')throw new Error('Expected document.');
    await f.repository.mutate(evidence.id,{...document.command,key:`revised_${crypto.randomUUID()}`,previous:document.result.target,text:'Revised full policy.'});
    const value=await f.readers.context(evidence.id,scope,{...emptyContext,documents:[{...document.result.target,purpose:'budget_policy'}]});
    expect(value.documents[0]).toMatchObject({record:document.result.body,reference:document.result.target,state:'SUPERSEDED',current:false});
    expect(value.blockers).toContain('DOCUMENT_CHANGED');
  });
  it('separates superseded open records and historical accepted records from current budget configuration',async()=>{
    const stale=await f.governance('a_stale'),first=await f.consent((await f.governance('b_first')).result),second=await f.consent((await f.governance('c_current')).result);
    const {evidence,scope}=await f.readerIdentity('finance_a');
    const page=await f.readers.governance(evidence.id,scope,{afterId:null,limit:2});
    expect(page.nextId).toBe(first.result.body.id);
    expect(page.items[0]).toMatchObject({policy:{record:stale.result.body,state:'SUPERSEDED',current:false},currentBudgetConfiguration:false});
    expect(page.items[1]).toMatchObject({policy:{record:first.result.body,state:'ACCEPTED',current:true},currentBudgetConfiguration:false});
    const next=await f.readers.governance(evidence.id,scope,{afterId:page.nextId,limit:2});
    expect(next.nextId).toBeNull();expect(next.items).toHaveLength(1);expect(next.items[0]).toMatchObject({policy:{reference:second.result.target},currentBudgetConfiguration:true});
  });
  it('returns every exact original command/result privately without changing durable state',async()=>{
    const document=await f.saveDocument('budget_policy'),draft=await f.draft(),operator=await f.readerIdentity('operations_a');
    const withdrawnCommand={...f.base('withdraw_draft',draft.result.body.id,'responsibility_a'),kind:'withdraw_draft' as const,responsibilityId:'responsibility_a',previous:draft.result.target};
    const withdrawn=await f.repository.mutate(operator.evidence.id,withdrawnCommand),proposal=await f.governance(),accepted=await f.consent(proposal.result);
    const rejectedProposal=await f.governance(),proposer=await f.identity(),finance=await f.readerIdentity('finance_a');
    if(rejectedProposal.result.body.kind!=='governance')throw new Error('Expected governance.');
    const rejectedCommand={...f.base('reject_governance',rejectedProposal.result.body.id),kind:'reject_governance' as const,responsibilityId:null,previous:rejectedProposal.result.target,expectedControl:rejectedProposal.result.body.expectedControl,proposerEvidenceId:proposer.id};
    const rejected=await f.repository.mutate(finance.evidence.id,rejectedCommand),before=await counts(f);
    for(const {command,result}of [document,draft,{command:withdrawnCommand,result:withdrawn},proposal,accepted,{command:rejectedCommand,result:rejected}]){
      const current=await f.readerIdentity(result.actorId);
      const query={responsibilityId:result.responsibilityId,kind:command.kind,key:command.key,targetId:result.body.id};
      const original=await f.readers.original(current.evidence.id,current.scope,query);
      expect(original).toEqual({command,result});
      expect(await responseReaders(original).original(current.evidence.id,current.scope,query)).toEqual(original);
      for(const response of [replace(original,['command','key'],'changed_original_key'),replace(original,['result','commandHash'],'f'.repeat(64)),
        replace(original,['result','target','recordHash'],'f'.repeat(64)),replace(original,['result','body','actor','subject'],'other_subject'),
        replace(original,['result','body','actor','sessionId'],'other_session'),replace(original,['result','effectiveAuthority'],true)])
        await expect(responseReaders(response).original(current.evidence.id,current.scope,query)).rejects.toMatchObject({code:'FINANCIAL_POLICY_OUTCOME_UNKNOWN'});
    }
    expect(await counts(f)).toEqual(before);
  });
  it('rejects mismatched context asset, accepted configuration, period, disclosure and blocker responses',async()=>{
    const proposal=await f.governance();await f.consent(proposal.result);const {evidence,scope}=await f.readerIdentity('finance_a');
    const query={...emptyContext,assetKey:f.assetPin.key},value=await f.readers.context(evidence.id,scope,query);
    expect(await responseReaders(value).context(evidence.id,scope,query)).toEqual(value);
    for(const response of [replace(value,['asset','pin','key'],'f'.repeat(64)),replace(value,['asset','mintHex'],'f'.repeat(64)),
      replace(value,['acceptedConfiguration','reference','recordHash'],'f'.repeat(64)),replace(value,['periods','0','id'],'f'.repeat(64)),
      replace(value,['configurationVisibility'],'references_only'),replace(value,['blockers'],['TRUST_UNAVAILABLE','FINANCIAL_AUTHORITY_UNAVAILABLE','GOVERNANCE_MISSING']),
      replace(value,['expiresAt'],new Date(Date.parse(value.observedAt)+20_001).toISOString())])
      await expect(responseReaders(response).context(evidence.id,scope,query)).rejects.toMatchObject({code:'FINANCIAL_POLICY_OUTCOME_UNKNOWN'});
    const operator=await f.readerIdentity('operations_a'),restrictedQuery={...query,responsibilityId:'responsibility_a'};
    const restricted=await f.readers.context(operator.evidence.id,operator.scope,restrictedQuery);
    await expect(responseReaders({...restricted,acceptedConfiguration:value.acceptedConfiguration}).context(operator.evidence.id,operator.scope,restrictedQuery)).rejects.toMatchObject({code:'FINANCIAL_POLICY_OUTCOME_UNKNOWN'});
    const documentQuery={...restrictedQuery,documents:[{...proposal.budget.result.target,purpose:'budget_policy' as const}]};
    const documentContext=await f.readers.context(evidence.id,scope,documentQuery);
    await expect(responseReaders({...restricted,documents:documentContext.documents}).context(operator.evidence.id,operator.scope,documentQuery)).rejects.toMatchObject({code:'FINANCIAL_POLICY_OUTCOME_UNKNOWN'});
    const forgedOrganizationContext={...value,scope:operator.scope,configurationVisibility:'references_only',acceptedConfiguration:null,periods:[]};
    await expect(responseReaders(forgedOrganizationContext).context(operator.evidence.id,operator.scope,query)).rejects.toMatchObject({code:'FINANCIAL_POLICY_OUTCOME_UNKNOWN'});
  });
  it('recovers after original MFA expiry and a new authenticated session without renewing original proof',async()=>{
    const p=await f.governance(),prepared=await f.prepareConsent(p.result),proof={...prepared.evidence,id:crypto.randomUUID(),expiresAt:new Date(Date.now()+1200).toISOString()};
    await f.authentication.append(proof);const command={...prepared.command,mfaEvidenceId:proof.id},result=await f.repository.mutate(prepared.approver.id,command);
    await new Promise(resolve=>setTimeout(resolve,Math.max(0,Date.parse(proof.expiresAt)-Date.now()+30)));
    const identity={...await f.identity('finance_a'),id:crypto.randomUUID(),actor:{...prepared.approver.actor,sessionId:'new_finance_session'}};
    await f.authentication.append(identity);const scope=await f.readers.resolveObserver('development',f.observation(identity)),before=await counts(f);
    expect(await f.readers.original(identity.id,scope,{responsibilityId:null,kind:'accept_governance',key:command.key,targetId:result.body.id})).toEqual({command,result});
    expect(await counts(f)).toEqual(before);expect((await f.admin.query('SELECT count(*)::int AS uses FROM pactwoven.financial_policy_evidence_uses WHERE evidence_id=$1',[proof.id])).rows[0].uses).toBe(1);
  });
  it('distinguishes missing original operation from any inferred failure or mutation',async()=>{
    const {evidence,scope}=await f.readerIdentity(),before=await counts(f);
    expect(await f.readers.original(evidence.id,scope,{responsibilityId:null,kind:'save_document',key:'missing_original_key',targetId:'missing'})).toBeNull();
    expect(await counts(f)).toEqual(before);
  });
  it('finds only fresh exact original proposer sessions and retains original observation hashes',async()=>{
    const seed=await f.governance(),base=await f.identity();
    const owner={...base,id:crypto.randomUUID(),actor:{...base.actor,sessionId:'exact_original_session'},expiresAt:new Date(Date.now()+1200).toISOString()};
    await f.authentication.append(owner);
    if(seed.command.kind!=='propose_governance')throw new Error('Expected proposal.');
    const proposal=await f.repository.mutate(owner.id,{...seed.command,id:'session_pinned_proposal',key:`session_${crypto.randomUUID()}`});
    const finance=await f.readerIdentity('finance_a');
    expect(await f.readers.proposerObservation(finance.evidence.id,finance.scope,proposal.target)).toMatchObject({proposal:proposal.target,observation:{id:owner.id,version:1}});
    await new Promise(resolve=>setTimeout(resolve,Math.max(0,Date.parse(owner.expiresAt)-Date.now()+30)));
    await f.identity();expect(await f.readers.proposerObservation(finance.evidence.id,finance.scope,proposal.target)).toBeNull();
    const refresh={...await f.identity(),id:crypto.randomUUID(),actor:owner.actor};await f.authentication.append(refresh);
    const result=await f.readers.proposerObservation(finance.evidence.id,finance.scope,proposal.target);
    expect(result?.observation.id).toBe(refresh.id);expect(result?.observation.recordHash).toMatch(/^[a-f0-9]{64}$/);
    expect(await financialPolicyRecordHash(proposal.body)).toBe(proposal.target.recordHash);
  });
  it('does not turn a superseded or wrong-version proposal into fresh proposer availability',async()=>{
    const stale=await f.governance();await f.consent((await f.governance()).result);const {evidence,scope}=await f.readerIdentity('finance_a');
    await expect(f.readers.proposerObservation(evidence.id,scope,stale.result.target)).rejects.toMatchObject({code:'FINANCIAL_POLICY_SCOPE_CHANGED'});
    await expect(f.readers.proposerObservation(evidence.id,scope,{...stale.result.target,version:2})).rejects.toMatchObject({code:'FINANCIAL_POLICY_SCOPE_CHANGED'});
  });
});
