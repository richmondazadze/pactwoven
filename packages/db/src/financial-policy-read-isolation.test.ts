import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { financialPolicyReadFixture, financialPolicyReadFixtureEnabled, type FinancialPolicyReadFixture } from './financial-policy-read.test-support.js';

const context={responsibilityId:null,assetKey:null,documents:[]};
const wait=async(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
describe.skipIf(!financialPolicyReadFixtureEnabled)('FP-API0 current scope and private reader isolation',()=>{
  let f:FinancialPolicyReadFixture;
  beforeEach(async()=>{f=await financialPolicyReadFixture();},60000);
  afterEach(async()=>{await f?.close();});
  it('keeps observer resolution on verifier and all four reader routines on authorizer',async()=>{
    const {evidence,scope}=await f.readerIdentity();
    await expect(f.authorizer.pool.query('SELECT pactwoven.financial_policy_resolve_observer($1,$2::jsonb)',['development',JSON.stringify(f.observation(evidence))])).rejects.toMatchObject({code:'42501'});
    for(const name of ['financial_policy_read_context','financial_policy_governance_index','financial_policy_original_read','financial_policy_proposer_observation']){
      await expect(f.verifier.pool.query(`SELECT pactwoven.${name}($1,$2::jsonb,$3::jsonb)`,[evidence.id,JSON.stringify(scope),'{}'])).rejects.toMatchObject({code:'42501'});
      await expect(f.stranger.pool.query(`SELECT pactwoven.${name}($1,$2::jsonb,$3::jsonb)`,[evidence.id,JSON.stringify(scope),'{}'])).rejects.toMatchObject({code:'42501'});
    }
    for(const name of ['financial_policy_reader_scope(jsonb)','financial_policy_original_checked(uuid)','financial_policy_reader_context(uuid,jsonb,text)']){
      const row=(await f.admin.query('SELECT has_function_privilege($1,$3,\'EXECUTE\') AS authorizer,has_function_privilege($2,$3,\'EXECUTE\') AS verifier',[f.authorizer.role,f.verifier.role,name.startsWith('pactwoven.')?name:'pactwoven.'+name])).rows[0];
      expect(row).toEqual({authorizer:false,verifier:false});
    }
  });
  it.each(['actor','session','membership','roles','sites','epoch','organization','environment'] as const)('rechecks private scope %s instead of trusting supplied permissions',async(change)=>{
    const {evidence,scope}=await f.readerIdentity('finance_a'),bad=structuredClone(scope);
    if(change==='actor')bad.actor.actorId='owner_a';if(change==='session')bad.actor.sessionId='other_session';if(change==='membership')bad.actor.membershipVersion++;
    if(change==='roles')bad.roles=['owner'];if(change==='sites')bad.actionSiteIds=['site_a','site_b'];if(change==='epoch')bad.organizationEpoch++;
    if(change==='organization')bad.organizationId='org_b';if(change==='environment')bad.environment='staging';
    await expect(f.readers.context(evidence.id,bad,context)).rejects.toMatchObject({code:'FINANCIAL_POLICY_ACCESS_DENIED'});
  });
  it('does not map foreign external membership, organization or revoked session into local scope',async()=>{
    const evidence=await f.identity(),observation=f.observation(evidence);
    for(const identity of [{...observation.identity,externalMembershipId:'other_member'},{...observation.identity,externalOrganizationId:'clerk_org_b'},{...observation.identity,subject:'owner_b'}])
      await expect(f.readers.resolveObserver('development',{...observation,identity})).rejects.toMatchObject({code:'FINANCIAL_POLICY_ACCESS_DENIED'});
    await f.admin.query("INSERT INTO pactwoven.session_revocations(environment,session_id) VALUES('development',$1)",[evidence.actor.sessionId]);
    await expect(f.readers.resolveObserver('development',observation)).rejects.toMatchObject({code:'FINANCIAL_POLICY_ACCESS_DENIED'});
  });
  it('separates governance reviewer scope from operations draft access',async()=>{
    const {evidence,scope}=await f.readerIdentity('operations_a');
    await expect(f.readers.governance(evidence.id,scope,{afterId:null,limit:10})).rejects.toMatchObject({code:'FINANCIAL_POLICY_ACCESS_DENIED'});
    await expect(f.readers.context(evidence.id,scope,context)).rejects.toMatchObject({code:'FINANCIAL_POLICY_ACCESS_DENIED'});
    expect((await f.readers.context(evidence.id,scope,{...context,responsibilityId:'responsibility_a'})).draftScope).not.toBeNull();
  });
  it('keeps organization documents and accepted configuration details out of Operations responsibility context',async()=>{
    const proposal=await f.governance(),accepted=await f.consent(proposal.result),{evidence,scope}=await f.readerIdentity('operations_a');
    const value=await f.readers.context(evidence.id,scope,{...context,responsibilityId:'responsibility_a',assetKey:f.assetPin.key});
    expect(value).toMatchObject({configurationVisibility:'references_only',control:{accepted:accepted.result.target},acceptedConfiguration:null,periods:[],documents:[]});
    expect(value.blockers).not.toContain('GOVERNANCE_MISSING');
    await expect(f.readers.context(evidence.id,scope,{...context,responsibilityId:'responsibility_a',documents:[{...proposal.budget.result.target,purpose:'budget_policy'}]})).rejects.toMatchObject({code:'FINANCIAL_POLICY_ACCESS_DENIED'});
    await expect(f.readers.original(evidence.id,scope,{responsibilityId:null,kind:'save_document',key:proposal.budget.command.key,targetId:proposal.budget.command.id})).rejects.toMatchObject({code:'FINANCIAL_POLICY_ACCESS_DENIED'});
  });
  it('denies responsibility reads after explicit site/action grants are removed',async()=>{
    const draft=await f.draft(),{evidence,scope}=await f.readerIdentity('operations_a');
    await f.admin.query("DELETE FROM pactwoven.member_action_sites WHERE environment='development' AND organization_id='org_a' AND actor_id='operations_a' AND site_id='site_a'");
    await expect(f.readers.original(evidence.id,scope,{responsibilityId:'responsibility_a',kind:'save_draft',key:draft.command.key,targetId:draft.command.id})).rejects.toMatchObject({code:'FINANCIAL_POLICY_ACCESS_DENIED'});
  });
  it('does not disclose a different actor original or a wrong target/scope for a real key',async()=>{
    const original=await f.saveDocument('budget_policy'),owner=await f.readerIdentity(),finance=await f.readerIdentity('finance_a');
    const query={responsibilityId:null,kind:'save_document' as const,key:original.command.key,targetId:original.command.id};
    expect(await f.readers.original(finance.evidence.id,finance.scope,query)).toBeNull();
    expect(await f.readers.original(owner.evidence.id,owner.scope,{...query,targetId:'different'})).toBeNull();
    expect(await f.readers.original(owner.evidence.id,owner.scope,{...query,responsibilityId:'responsibility_a'})).toBeNull();
    await expect(f.readers.context(owner.evidence.id,owner.scope,{...context,documents:[{...original.result.target,recordHash:'f'.repeat(64),purpose:'budget_policy'}]})).rejects.toMatchObject({code:'FINANCIAL_POLICY_SCOPE_CHANGED'});
  });
  it('returns no governance record where the reviewer lacks the proposal action site',async()=>{
    await f.governance();await f.admin.query("DELETE FROM pactwoven.member_action_sites WHERE environment='development' AND organization_id='org_a' AND actor_id='finance_a'");
    const {evidence,scope}=await f.readerIdentity('finance_a');
    expect(await f.readers.governance(evidence.id,scope,{afterId:null,limit:10})).toEqual({items:[],nextId:null});
  });
  it('treats a changed asset as unavailable context, never as qualified or funded',async()=>{
    const {evidence,scope}=await f.readerIdentity();await f.admin.query('UPDATE pactwoven.finance_asset_controls SET accepts_observations=false WHERE asset_key=$1',[f.assetPin.key]);
    const value=await f.readers.context(evidence.id,scope,{...context,assetKey:f.assetPin.key});
    expect(value).toMatchObject({asset:null,control:null,acceptedConfiguration:null,effectiveAuthority:false,financialState:null});expect(value.blockers).toContain('ASSET_CHANGED');
  });
  it('rejects oversized or extra private input in SQL before reading records',async()=>{
    const {evidence,scope}=await f.readerIdentity();
    await expect(f.authorizer.pool.query('SELECT pactwoven.financial_policy_governance_index($1,$2::jsonb,$3::jsonb)',[evidence.id,JSON.stringify(scope),JSON.stringify({afterId:null,limit:51})])).rejects.toMatchObject({code:'FP004'});
    await expect(f.authorizer.pool.query('SELECT pactwoven.financial_policy_read_context($1,$2::jsonb,$3::jsonb)',[evidence.id,JSON.stringify({...scope,verified:true}),JSON.stringify(context)])).rejects.toMatchObject({code:'FP004'});
  });
  it('rejects an expired observation after an actual asset-control lock wait',async()=>{
    const base=await f.identity(),evidence={...base,id:crypto.randomUUID(),expiresAt:new Date(Date.now()+1500).toISOString()};await f.authentication.append(evidence);
    const scope=await f.readers.resolveObserver('development',f.observation(evidence)),holder=await f.admin.connect();
    try{
      await holder.query('BEGIN');await holder.query('SELECT asset_key FROM pactwoven.finance_asset_controls WHERE asset_key=$1 FOR UPDATE',[f.assetPin.key]);
      const pid=(await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const pending=f.readers.context(evidence.id,scope,{...context,assetKey:f.assetPin.key}).then(value=>({value}),error=>({error}));
      let blocked=false;const deadline=Date.now()+700;
      while(Date.now()<deadline){blocked=(await f.admin.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))) AS blocked',[pid])).rows[0].blocked;if(blocked)break;await wait(10);}
      expect(blocked).toBe(true);await wait(Math.max(0,Date.parse(evidence.expiresAt)-Date.now()+30));await holder.query('COMMIT');
      expect(await pending).toMatchObject({error:{code:'FINANCIAL_POLICY_ACCESS_DENIED'}});
    }finally{await holder.query('ROLLBACK');holder.release();}
  });
  it('rechecks the twenty-second observation age after an actual asset-control lock wait',async()=>{
    const base=await f.identity(),observedAt=Date.now()-18_000;
    const evidence={...base,id:crypto.randomUUID(),observedAt:new Date(observedAt).toISOString(),tokenIssuedAt:new Date(observedAt-1000).toISOString()};
    await f.authentication.append(evidence);
    const scope=await f.readers.resolveObserver('development',f.observation(evidence)),holder=await f.admin.connect();
    try{
      await holder.query('BEGIN');await holder.query('SELECT asset_key FROM pactwoven.finance_asset_controls WHERE asset_key=$1 FOR UPDATE',[f.assetPin.key]);
      const pid=(await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const pending=f.readers.context(evidence.id,scope,{...context,assetKey:f.assetPin.key}).then(value=>({value}),error=>({error}));
      let blocked=false;const deadline=Date.now()+700;
      while(Date.now()<deadline){blocked=(await f.admin.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))) AS blocked',[pid])).rows[0].blocked;if(blocked)break;await wait(10);}
      expect(blocked).toBe(true);await wait(Math.max(0,observedAt+20_030-Date.now()));await holder.query('COMMIT');
      expect(await pending).toMatchObject({error:{code:'FINANCIAL_POLICY_ACCESS_DENIED'}});
    }finally{await holder.query('ROLLBACK');holder.release();}
  });
  it('observes a committed session revocation after waiting for the organization lock',async()=>{
    const evidence=await f.identity(),holder=await f.admin.connect();
    try{
      await holder.query('BEGIN');await holder.query("SELECT id FROM pactwoven.organizations WHERE environment='development' AND id='org_a' FOR UPDATE");
      const pid=(await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const pending=f.readers.resolveObserver('development',f.observation(evidence)).then(value=>({value}),error=>({error}));
      let blocked=false;const deadline=Date.now()+700;
      while(Date.now()<deadline){blocked=(await f.admin.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))) AS blocked',[pid])).rows[0].blocked;if(blocked)break;await wait(10);}
      expect(blocked).toBe(true);
      await holder.query("INSERT INTO pactwoven.session_revocations(environment,session_id) VALUES('development',$1)",[evidence.actor.sessionId]);
      await holder.query('COMMIT');expect(await pending).toMatchObject({error:{code:'FINANCIAL_POLICY_ACCESS_DENIED'}});
    }finally{await holder.query('ROLLBACK');holder.release();}
  });
  it('rejects evidence when its verifier principal binding is superseded',async()=>{
    const {evidence,scope}=await f.readerIdentity();
    await f.admin.query("INSERT INTO pactwoven.financial_policy_principals SELECT principal_oid,principal_name,environment,organization_id,capability,version+1,false,expires_at FROM pactwoven.financial_policy_principals WHERE principal_name=$1",[f.verifier.role]);
    await expect(f.readers.context(evidence.id,scope,context)).rejects.toMatchObject({code:'FINANCIAL_POLICY_ACCESS_DENIED'});
  });
});
