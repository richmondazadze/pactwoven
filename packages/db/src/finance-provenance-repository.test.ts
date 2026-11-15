import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { decodeSolanaBase58, FINANCE_DEVNET_ASSET, type FinanceProvenanceAppend } from '@pactwoven/contracts';
import { provenanceHex } from '@pactwoven/domain';
import { PostgresFinanceProvenanceRepository } from './finance-provenance-repository';
import { financeCounts, financeFixture, financeFixtureEnabled, financeLookup, rawFinanceAppend, type FinanceFixture } from './finance-provenance.test-support';

describe.skipIf(!financeFixtureEnabled)('PostgreSQL inert provenance persistence',()=>{
  let f:FinanceFixture;beforeAll(async()=>{f=await financeFixture();},60000);afterAll(async()=>{await f?.close();});
  it('accepts a source-bound direct SQL observation without trusting caller tenant context',async()=>{
    const decoded=(await f.admin.query("SELECT encode(pactwoven.finance_base58($1,32),'hex') AS value",[FINANCE_DEVNET_ASSET.mint])).rows[0].value;
    expect(decoded).toBe(Buffer.from(decodeSolanaBase58(FINANCE_DEVNET_ASSET.mint,32)).toString('hex'));
    expect(await rawFinanceAppend(f.a.pool,await f.input('direct_sql_observation'))).toMatchObject({kind:'delivery',disposition:'recorded'});
  });
  it('applies all seven fresh migrations and concurrent duplicates have one committed receipt',async()=>{
    expect(f.migrations).toHaveLength(7);const input=await f.input('parallel_delivery');
    const results=await Promise.all(Array.from({length:8},()=>f.repository.append(input)));
    expect(new Set(results.map(x=>x.kind==='delivery'?x.receiptId:x.conflictId)).size).toBe(1);expect(results[0]).toMatchObject({kind:'delivery',disposition:'recorded',transferKey:null,effectKey:null});
    expect(await f.repository.get(financeLookup(input))).toEqual(results[0]);
  });
  it('deduplicates changed-input conflicts without replacing the original delivery or exact lookup',async()=>{
    const input=await f.input('changed_delivery'),original=await f.repository.append(input),changed=structuredClone(input);
    changed.payloadHex='010203';changed.payloadHash=provenanceHex(new Uint8Array(await crypto.subtle.digest('SHA-256',Uint8Array.of(1,2,3))));
    const before=await financeCounts(f.admin),first=await f.repository.append(changed),again=await f.repository.append(changed);
    expect(first).toEqual(again);expect(first).toMatchObject({kind:'conflict',reason:'DELIVERY_REUSE'});expect(await f.repository.get(financeLookup(input))).toEqual(original);
    const after=await financeCounts(f.admin);expect(after.deliveries).toBe(before.deliveries);expect(after.conflicts).toBe(before.conflicts!+1);
  });
  it('shares one transfer fact across sources and preserves lower and later finality evidence',async()=>{
    const a=await f.input('transfer_provider_a','transfer');if(a.observation.kind!=='transfer')throw new Error('fixture');
    a.observation.context.commitment='confirmed';const original=await f.repository.append(a);
    const b=structuredClone(a);if(b.observation.kind!=='transfer')throw new Error('fixture');b.source.id='source_b';b.deliveryKey='transfer_provider_b';b.observation.context.commitment='finalized';
    const providerB=await new PostgresFinanceProvenanceRepository(f.b.pool).append(b);
    const late=structuredClone(a);late.deliveryKey='transfer_late_finality';late.observation={kind:'finality',context:{...a.observation.context,commitment:'processed'},locator:a.observation.fact.locator,transactionStatus:'unknown'};
    const finality=await f.repository.append(late);
    expect(original.kind==='delivery'&&providerB.kind==='delivery'&&finality.kind==='delivery').toBe(true);
    expect((await financeCounts(f.admin)).facts).toBe(1);expect((await financeCounts(f.admin)).effects).toBe(1);
    expect(await f.repository.get(financeLookup(a))).toEqual(original);
  });
  it('quarantines changed amount/account facts at an existing locator without changing shared history',async()=>{
    const input=await f.input('conflicting_fact','transfer');if(input.observation.kind!=='transfer')throw new Error('fixture');input.observation.fact.amountBaseUnits='999';
    const before=await financeCounts(f.admin),result=await f.repository.append(input);
    expect(result).toMatchObject({kind:'delivery',disposition:'quarantined',effectKey:null});expect(await f.repository.append(input)).toEqual(result);expect(await f.repository.get(financeLookup(input))).toEqual(result);
    const after=await financeCounts(f.admin);expect(after.facts).toBe(before.facts);expect(after.effects).toBe(before.effects);expect(after.links).toBe(before.links);expect(after.conflicts).toBe(before.conflicts!+1);
    expect((await f.admin.query("SELECT fact->>'amountBaseUnits' AS amount FROM pactwoven.finance_transfer_facts")).rows.map(r=>r.amount)).toEqual(['10']);
  });
  it('records one effect per controlled account for a shared transfer, with no funding operation',async()=>{
    const input=await f.input('outgoing_effect','transfer');input.account.key=f.accountB;const result=await f.repository.append(input);expect(result).toMatchObject({kind:'delivery',disposition:'recorded'});
    const count=await financeCounts(f.admin);expect(count.facts).toBe(1);expect(count.effects).toBe(2);expect(count.operations).toBe(0);expect(count.mandateOperations).toBe(0);expect(count.outbox).toBe(0);
  });
  it('retains zero and u64 maximum snapshots and failed transaction evidence without creating a transfer',async()=>{
    const before=await financeCounts(f.admin);
    for(const amount of [0n,18446744073709551615n]){const input=await f.input(`balance_${amount}`);if(input.observation.kind!=='balance')throw new Error('fixture');const bytes=Buffer.from(input.observation.accountDataHex,'hex');bytes.writeBigUInt64LE(amount,64);input.observation.accountDataHex=bytes.toString('hex');input.observation.amountBaseUnits=amount.toString();expect(await f.repository.append(input)).toMatchObject({kind:'delivery',transferKey:null});}
    const input=await f.input('failed_transaction','transfer');if(input.observation.kind!=='transfer')throw new Error('fixture');const observation=input.observation;
    input.observation={kind:'transaction',context:observation.context,genesis:observation.fact.locator.genesis,signature:observation.fact.locator.signature,transactionStatus:'failed',transactionVersion:'legacy',executionEvidence:observation.execution.evidence};
    expect(await f.repository.append(input)).toMatchObject({kind:'delivery',transferKey:null,effectKey:null});const after=await financeCounts(f.admin);expect(after.facts).toBe(before.facts);expect(after.effects).toBe(before.effects);expect(after.operations).toBe(0);
  });
  it('rolls back facts and effects when the receipt insert fails',async()=>{
    const input=await f.input('rollback_transfer','transfer');if(input.observation.kind!=='transfer')throw new Error('fixture');input.observation.fact.locator.outerInstructionIndex=1;input.observation.execution.outerInstructionCount=2;
    const before=await financeCounts(f.admin);
    await f.admin.query("CREATE FUNCTION pactwoven.fixture_provenance_abort() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture aborted'; END $$; REVOKE ALL ON FUNCTION pactwoven.fixture_provenance_abort() FROM PUBLIC; CREATE TRIGGER fixture_abort BEFORE INSERT ON pactwoven.finance_deliveries FOR EACH ROW EXECUTE FUNCTION pactwoven.fixture_provenance_abort()");
    try{await expect(f.repository.append(input)).rejects.toMatchObject({code:'PROVENANCE_OUTCOME_UNKNOWN'});}finally{await f.admin.query('DROP TRIGGER fixture_abort ON pactwoven.finance_deliveries; DROP FUNCTION pactwoven.fixture_provenance_abort()');}
    expect(await financeCounts(f.admin)).toEqual(before);expect(await f.repository.get(financeLookup(input))).toBeNull();
  });
  it('recovers an actually committed receipt after losing its COMMIT acknowledgment using a new connection',async()=>{
    const input=await f.input('commit_ack_lost');const client=await f.a.pool.connect(),query=client.query.bind(client);let lost=false;
    const proxy=new Proxy(client,{get(target,key){if(key==='query')return async(...args:unknown[])=>{const result=await (query as(...args:unknown[])=>Promise<unknown>)(...args);if(args[0]==='COMMIT'&&!lost){lost=true;throw new Error('synthetic acknowledgment loss after actual COMMIT');}return result;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}}) as PoolClient;
    const intercepted={connect:async()=>proxy} as Pool;
    await expect(new PostgresFinanceProvenanceRepository(intercepted).append(input)).rejects.toMatchObject({code:'PROVENANCE_OUTCOME_UNKNOWN'});expect(lost).toBe(true);
    const fresh=new Pool({...f.config,user:f.a.role,password:f.a.password,max:1});
    try{const recovered=await new PostgresFinanceProvenanceRepository(fresh).get(financeLookup(input));expect(recovered).toMatchObject({kind:'delivery',disposition:'recorded'});expect(await f.repository.append(input)).toEqual(recovered);}finally{await fresh.end();}
  });
  it('keeps original receipt lookup available after intake is revoked',async()=>{
    const input=await f.input('revoked_recovery');input.source.id='source_b';const repo=new PostgresFinanceProvenanceRepository(f.b.pool),receipt=await repo.append(input);
    await f.admin.query("UPDATE pactwoven.finance_source_controls SET revoked_at=clock_timestamp() WHERE source_id='source_b'");
    expect(await repo.get(financeLookup(input))).toEqual(receipt);await expect(repo.append({...input,deliveryKey:'revoked_new'})).rejects.toMatchObject({code:'PROVENANCE_SOURCE_DENIED'});
  });
  it('retains exact unsupported/unparsed payloads without parsing duplicate keys or unsafe numeric literals into financial facts',async()=>{
    const before=await financeCounts(f.admin),input=await f.input('unparsed_evidence');
    const bytes=Buffer.from('{"slot":18446744073709551615,"slot":1,"version":99}');input.payloadHex=bytes.toString('hex');input.payloadHash=provenanceHex(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)));
    input.observation={kind:'raw',reason:'unsupported',detail:'Unsupported version; exact payload retained without normalization'};
    expect(await f.repository.append(input)).toMatchObject({kind:'delivery',disposition:'recorded',observationKind:'raw',transferKey:null,effectKey:null});
    expect((await f.admin.query("SELECT encode(payload,'hex') AS bytes FROM pactwoven.finance_deliveries WHERE delivery_key=$1",[input.deliveryKey])).rows[0].bytes).toBe(input.payloadHex);
    const after=await financeCounts(f.admin);expect(after.facts).toBe(before.facts);expect(after.effects).toBe(before.effects);expect(after.operations).toBe(before.operations);
  });
  it('keeps stable physical facts across owner-provisioned registry/source versions and rejects their stale predecessors',async()=>{
    const prior=await f.input('versioned_prior','transfer'),before=await f.repository.append(prior);
    await f.admin.query('INSERT INTO pactwoven.finance_asset_versions SELECT asset_key,2,policy,decimals,policy_hash,verifier_version,evidence FROM pactwoven.finance_asset_versions WHERE asset_key=$1 AND version=1',[f.assetKey]);
    await f.admin.query('INSERT INTO pactwoven.finance_account_versions SELECT account_key,2,asset_key,expected_authority,policy_hash,verifier_version,evidence,incarnation_evidence FROM pactwoven.finance_account_versions WHERE account_key=$1 AND version=1',[f.accountA]);
    await f.admin.query("INSERT INTO pactwoven.finance_source_versions SELECT source_id,2,endpoint_configuration_hash,adapter_version,normalizer_version,policy_hash,verifier_version,evidence FROM pactwoven.finance_source_versions WHERE source_id='source_a' AND version=1");
    await f.admin.query('UPDATE pactwoven.finance_asset_controls SET current_version=2 WHERE asset_key=$1',[f.assetKey]);await f.admin.query('UPDATE pactwoven.finance_account_controls SET current_version=2 WHERE account_key=$1',[f.accountA]);await f.admin.query("UPDATE pactwoven.finance_source_controls SET current_version=2 WHERE source_id='source_a'");
    await expect(f.repository.append({...prior,deliveryKey:'stale_version'})).rejects.toMatchObject({code:'PROVENANCE_VERSION_CHANGED'});
    const current=structuredClone(prior);current.deliveryKey='current_version';current.source.version=2;current.account.version=2;current.asset.version=2;
    const after=await f.repository.append(current);expect(after).toMatchObject({kind:'delivery',disposition:'recorded',sourceVersion:2,accountVersion:2});
    expect(before.kind==='delivery'&&after.kind==='delivery'&&before.transferKey===after.transferKey).toBe(true);expect(await f.repository.get(financeLookup(prior))).toEqual(before);expect((await financeCounts(f.admin)).facts).toBe(1);
  });
});
