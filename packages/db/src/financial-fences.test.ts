import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { FinancialAuthorityFenceSchema, FinancialAuthorityHistorySchema } from '@pactwoven/contracts';
import { financialAuthorityFenceHash, verifyFinancialAuthorityHistory, commandDigest } from '@pactwoven/domain';
import { loadMigrations } from './migrate';
import { PostgresFinanceProvenanceRepository } from './finance-provenance-repository';
import { PostgresOrganizationProvisioner } from './provisioner';
import { financialFenceFixture, financialFenceFixtureEnabled, authorizeFenceLegacy, directFenceControl, fenceIdentity, fenceVerified, type FinancialFenceFixture } from './financial-fences.test-support';

const suite = financialFenceFixtureEnabled ? describe : describe.skip;
suite('FA-0 canonical authority and control generations — exclusive PostgreSQL', () => {
  let fixture: FinancialFenceFixture | undefined;
  afterEach(async () => { await fixture?.close(); fixture = undefined; });
  it('backfills NONE and records authentic legacy transitions and exact historical recovery', async () => {
    fixture = await financialFenceFixture();
    const { admin, mandate } = fixture;
    expect((await admin.query('SELECT generation,family FROM pactwoven.financial_authority_fences')).rows).toEqual([{ generation: 0, family: 'none' }]);
    const legacy = await authorizeFenceLegacy(mandate.pool);
    await legacy.control('PAUSE', 'pause_authority_0001');
    await legacy.control('RESUME', 'resume_authority_0001');
    await legacy.control('REVOKE', 'revoke_authority_0001');
    const row = (await admin.query('SELECT pactwoven.financial_authority_snapshot(f) AS body FROM pactwoven.financial_authority_fences f')).rows[0];
    const history = (await admin.query('SELECT previous_snapshot AS previous,snapshot AS current,basis,operation_id AS "operationId" FROM pactwoven.financial_authority_history ORDER BY generation')).rows;
    const head = FinancialAuthorityFenceSchema.parse(row.body);
    expect(head).toMatchObject({ generation: 4, family: 'legacy', legacyHead: { mandateEpoch: 4, state: 'REVOKED' } });
    verifyFinancialAuthorityHistory(history.map(item => FinancialAuthorityHistorySchema.parse(item)), head);
    const replay = await legacy.repository.mutate(await fenceVerified(legacy.mutation, legacy.key), 'responsibility_a', legacy.key, legacy.mutation, 'replay');
    expect(replay.operation.id).toBe(legacy.result.operation.id);
    expect((await admin.query('SELECT count(*)::int AS count FROM pactwoven.financial_authority_history')).rows[0].count).toBe(5);
  });
  it('backfills an existing paused legacy head with its actual epoch and original audit', async () => {
    fixture = await financialFenceFixture({ beforeFence: async ({ mandate }) => {
      const legacy = await authorizeFenceLegacy(mandate); await legacy.control('PAUSE', 'backfill_pause_0001');
    } });
    const { admin } = fixture;
    const result = (await admin.query('SELECT f.generation,f.family,f.legacy_head,h.basis,h.operation_id,a.operation_id AS audit_id FROM pactwoven.financial_authority_fences f JOIN pactwoven.financial_authority_history h USING(environment,organization_id,responsibility_id) JOIN pactwoven.mandate_audit a ON a.body#>\'{history,head}\'=f.legacy_head')).rows[0];
    expect(result).toMatchObject({ generation: 0, family: 'legacy', basis: 'migration_backfill', legacy_head: { state: 'PAUSED', mandateEpoch: 2 } });
    expect(result.operation_id).toBe(result.audit_id);
  });
  it('preserves current canonical source references across responsibility and site changes', async () => {
    fixture = await financialFenceFixture();
    const { admin, repository } = fixture;
    await admin.query("UPDATE pactwoven.responsibilities SET title='Revised preparation',row_version=row_version+1,updated_at=clock_timestamp() WHERE id='responsibility_a'");
    expect((await admin.query('SELECT generation,responsibility_version FROM pactwoven.financial_authority_fences')).rows[0]).toEqual({ generation: 1, responsibility_version: 2 });
    const current = (await admin.query("SELECT * FROM pactwoven.financial_site_fences WHERE site_id='site_a'")).rows[0];
    const change = await admin.query("SELECT pactwoven.financial_update_site_control('development','org_a','site_a',$1,$2,'Site A','America/Chicago',false) AS body", [current.generation, current.record_hash]);
    expect(change.rows[0].body).toMatchObject({ generation: 1, active: false });
    const page = await repository.list(fenceIdentity(), 'responsibility_a', { limit: 25 }, 'trace');
    expect(page.items).toEqual([]);
    const context = (await fixture.mandate.pool.query("SELECT pactwoven.mandate_resolve_context('development',$1::jsonb,'responsibility_a',false,'trace') AS body", [JSON.stringify(fenceIdentity())])).rows[0].body;
    expect(context.sites.find((site: { id: string }) => site.id === 'site_a').active).toBe(false);
  });
  it('keeps prior migrations and ADVISE validators unchanged and applies all eight migrations atomically', async()=>{
    fixture=await financialFenceFixture();
    for(const [file,hash] of [
      ['../migrations/0004_mandate_authority.sql','2c5da97dc24c1a76419f59c6eeea662e0cdfc2281d3c6b9b9fbfed84b82f9281'],
      ['../migrations/0007_finance_provenance.sql','75ff22e258b2b8b8e0f3eeb32ceb6621246038ba2cb71f62178e651c58eb7a6a'],
    ]) expect(createHash('sha256').update(await readFile(new URL(file!,import.meta.url))).digest('hex')).toBe(hash);
    const policySource=await readFile(new URL('../../domain/src/mandate-proposals.ts',import.meta.url),'utf8');
    const policyStart=policySource.indexOf('export function validateConnectedMandatePolicy('),policyEnd=policySource.indexOf('\nexport async function resolveMandatePolicyDocuments',policyStart);
    expect(createHash('sha256').update(policySource.slice(policyStart,policyEnd)).digest('hex')).toBe('e433b960638340b109b61e779fafda93d8863b580ffbece52a02794f1fe7fcfc');
    const client=await fixture.admin.connect();
    try{
      await client.query('BEGIN'); await client.query('DROP SCHEMA pactwoven CASCADE');
      for(const migration of await loadMigrations())for(const statement of migration.statements)await client.query(statement);
      await client.query('SET CONSTRAINTS ALL IMMEDIATE');
      expect((await client.query('SELECT count(*)::int AS count FROM pactwoven.financial_authority_fences')).rows[0].count).toBe(0);
    }finally{await client.query('ROLLBACK');client.release();}
  });
  it('shares an explicitly namespaced authority hash between SQL and TypeScript without changing legacy digests',async()=>{
    fixture=await financialFenceFixture();
    for(const stage of ['none','legacy'] as const){
      if(stage==='legacy')await authorizeFenceLegacy(fixture.mandate.pool);
      const row=(await fixture.admin.query('SELECT pactwoven.financial_authority_snapshot(f) AS body,pactwoven.financial_authority_fence_hash(f) AS hash FROM pactwoven.financial_authority_fences f')).rows[0];
      expect(row.hash).toBe(await financialAuthorityFenceHash(row.body));
      expect(row.hash).not.toBe(await commandDigest(row.body));
    }
  });
  it('increments only actual registry control changes and never observations or unused versions',async()=>{
    fixture=await financialFenceFixture(); const {admin,assetKey,accountA,observer}=fixture;
    const first=(await admin.query('SELECT * FROM pactwoven.financial_asset_fences')).rows[0];
    await admin.query("INSERT INTO pactwoven.finance_asset_versions SELECT asset_key,2,policy,decimals,policy_hash,verifier_version,evidence FROM pactwoven.finance_asset_versions WHERE version=1");
    await admin.query('SELECT pactwoven.financial_update_asset_control($1,0,$2,1,true,null)',[assetKey,first.control_hash]);
    const payloadHex=Buffer.from('FA-0 synthetic raw observation').toString('hex'),payloadHash=createHash('sha256').update(Buffer.from(payloadHex,'hex')).digest('hex');
    const input={schemaVersion:1 as const,source:{id:'source_org_a',version:1},account:{key:accountA,version:1},asset:{key:assetKey,version:1},deliveryKey:'generation_no_effect',adapterVersion:'fixture_adapter',normalizerVersion:'fixture_normalizer',payloadHex,payloadHash,
      evidence:{reference:'fixture:raw',sha256:payloadHash},providerMetadata:{},observation:{kind:'raw' as const,reason:'unparsed' as const,detail:'Synthetic fixture; no qualification.'}};
    const receipt=await new PostgresFinanceProvenanceRepository(observer.pool).append(input);expect(receipt.kind).toBe('delivery');
    expect((await admin.query('SELECT generation FROM pactwoven.financial_asset_fences')).rows[0].generation).toBe(0);
    await admin.query('SELECT pactwoven.financial_update_asset_control($1,0,$2,2,false,null)',[assetKey,first.control_hash]);
    const second=(await admin.query('SELECT * FROM pactwoven.financial_asset_fences')).rows[0];expect(second.generation).toBe(1);
    await expect(admin.query('SELECT pactwoven.financial_update_asset_control($1,0,$2,2,true,null)',[assetKey,first.control_hash])).rejects.toMatchObject({code:'FA002'});
    await admin.query('SELECT pactwoven.financial_update_asset_control($1,1,$2,2,true,null)',[assetKey,second.control_hash]);
    const third=(await admin.query('SELECT * FROM pactwoven.financial_asset_fences')).rows[0];expect(third.generation).toBe(2);
    await admin.query('SELECT pactwoven.financial_update_asset_control($1,2,$2,2,false,clock_timestamp())',[assetKey,third.control_hash]);
    const revoked=(await admin.query('SELECT * FROM pactwoven.financial_asset_fences')).rows[0];
    await expect(admin.query('SELECT pactwoven.financial_update_asset_control($1,3,$2,2,true,null)',[assetKey,revoked.control_hash])).rejects.toMatchObject({code:'PF007'});
    expect(await new PostgresFinanceProvenanceRepository(observer.pool).get({sourceId:input.source.id,accountKey:accountA,deliveryKey:input.deliveryKey})).not.toBeNull();
    expect((await admin.query("SELECT array_agg(generation ORDER BY generation) AS generations FROM pactwoven.financial_registry_history WHERE kind='asset'")).rows[0].generations).toEqual([0,1,2,3]);
  });
  it('updates account, source and binding generations using their enduring identities',async()=>{
    fixture=await financialFenceFixture();const {admin,accountA}=fixture;
    for(const [kind,table,key,column] of [['account','financial_account_fences',accountA,'account_key'],['source','financial_source_fences','source_org_a','source_id'],['binding','financial_source_binding_fences','source_org_a','source_id']] as const){
      const first=(await admin.query(`SELECT * FROM pactwoven.${table} WHERE ${column}=$1`,[key])).rows[0];
      const sql=kind==='binding'?'SELECT pactwoven.financial_update_source_binding_control($1,$4,$2,$3,false,null) AS body':`SELECT pactwoven.financial_update_${kind}_control($1,$2,$3,1,false,null) AS body`;
      const args=kind==='binding'?[key,0,first.control_hash,accountA]:[key,0,first.control_hash];
      expect((await admin.query(sql,args)).rows[0].body).toMatchObject({kind,generation:1});
      await expect(admin.query(sql,args)).rejects.toMatchObject({code:'FA002'});
    }
  });
  it('rejects sparse or omitted canonical and registry histories at commit, including intermediate changes',async()=>{
    fixture=await financialFenceFixture();const {admin,assetKey}=fixture;const client=await admin.connect();
    try{
      await client.query('BEGIN');
      await client.query("UPDATE pactwoven.financial_authority_fences SET generation=1 WHERE responsibility_id='responsibility_a'");
      await expect(client.query('COMMIT')).rejects.toMatchObject({code:'FA007'});await client.query('ROLLBACK');
      await client.query('BEGIN');
      await client.query('ALTER TABLE pactwoven.financial_registry_history DISABLE TRIGGER financial_no_delete');
      const before=(await client.query('SELECT * FROM pactwoven.financial_asset_fences')).rows[0];
      await client.query('SELECT pactwoven.financial_update_asset_control($1,0,$2,1,false,null)',[assetKey,before.control_hash]);
      const middle=(await client.query('SELECT * FROM pactwoven.financial_asset_fences')).rows[0];
      await client.query('SELECT pactwoven.financial_update_asset_control($1,1,$2,1,true,null)',[assetKey,middle.control_hash]);
      // The owner removes one history entry only; deferred transition checks must still reject it.
      await client.query("DELETE FROM pactwoven.financial_registry_history WHERE kind='asset' AND generation=1");
      await expect(client.query('COMMIT')).rejects.toMatchObject({code:'FA007'});await client.query('ROLLBACK');
      expect((await admin.query('SELECT generation FROM pactwoven.financial_asset_fences')).rows[0].generation).toBe(0);
    }finally{await client.query('ROLLBACK');client.release();}
  });
  it('prevents reset, deletion, truncation, overflow and stale-snapshot control mutations',async()=>{
    fixture=await financialFenceFixture();const {admin,assetKey}=fixture;
    for(const sql of ["DELETE FROM pactwoven.financial_authority_history","TRUNCATE pactwoven.financial_authority_history","UPDATE pactwoven.financial_authority_fences SET generation=0","UPDATE pactwoven.financial_authority_history SET basis='initial'"])
      await expect(admin.query(sql)).rejects.toMatchObject({code:'FA007'});
    await expect(admin.query('SELECT pactwoven.financial_next_generation(2147483647)')).rejects.toMatchObject({code:'FA008'});
    const client=await admin.connect();try{
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      const f=(await client.query('SELECT * FROM pactwoven.financial_asset_fences')).rows[0];
      await expect(client.query('SELECT pactwoven.financial_update_asset_control($1,0,$2,1,false,null)',[assetKey,f.control_hash])).rejects.toMatchObject({code:'FA001'});
    }finally{await client.query('ROLLBACK');client.release();}
  });
  it('denies new legacy writes under a future family while recovering an exact historic operation',async()=>{
    fixture=await financialFenceFixture(); const {admin,mandate}=fixture; const legacy=await authorizeFenceLegacy(mandate.pool);
    await expect(admin.query("UPDATE pactwoven.financial_authority_fences SET family='financial',generation=generation+1")).rejects.toMatchObject({code:'23514'});
    // Test-only future-migration simulation by the disposable database owner. FA-0 exposes no setter.
    // Deliberately relax only the canonical table's current-family checks and mutation validation;
    // the independent legacy-family guard remains installed and must reject new writes.
    const checks=(await admin.query("SELECT conname FROM pg_constraint WHERE conrelid='pactwoven.financial_authority_fences'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%family%'")).rows;
    const client=await admin.connect();try{
      await client.query('BEGIN');
      for(const row of checks)await client.query(`ALTER TABLE pactwoven.financial_authority_fences DROP CONSTRAINT "${String(row.conname).replaceAll('"','""')}"`);
      await client.query('ALTER TABLE pactwoven.financial_authority_fences DISABLE TRIGGER financial_authority_change');
      await client.query('ALTER TABLE pactwoven.financial_authority_fences DISABLE TRIGGER financial_authority_complete');
      await client.query("UPDATE pactwoven.financial_authority_fences SET family='financial'");await client.query('COMMIT');
    }finally{await client.query('ROLLBACK');client.release();}
    const replay=await legacy.repository.mutate(await fenceVerified(legacy.mutation,legacy.key),'responsibility_a',legacy.key,legacy.mutation,'history');
    expect(replay.operation.id).toBe(legacy.result.operation.id);
    const before=(await admin.query('SELECT count(*)::int AS count FROM pactwoven.mandate_operations')).rows[0].count;
    await expect(legacy.mutate({kind:'document',request:{...legacy.request,command:{...legacy.request.command,documentId:'forbidden_future'}}},'future_document_0001','operations_a')).rejects.toBeDefined();
    expect((await admin.query('SELECT count(*)::int AS count FROM pactwoven.mandate_operations')).rows[0].count).toBe(before);
  });
  it('retains immediate legacy stop controls at an inactive site but rejects new proposal work',async()=>{
    fixture=await financialFenceFixture();const legacy=await authorizeFenceLegacy(fixture.mandate.pool);
    const site=(await fixture.admin.query("SELECT * FROM pactwoven.financial_site_fences WHERE site_id='site_a'")).rows[0];
    await fixture.admin.query("SELECT pactwoven.financial_update_site_control('development','org_a','site_a',0,$1,'Site A','America/Chicago',false)",[site.record_hash]);
    await legacy.control('PAUSE','inactive_site_pause_0001');
    await legacy.control('REVOKE','inactive_site_revoke_0001');
    await expect(legacy.mutate({kind:'document',request:{...legacy.request,command:{...legacy.request.command,documentId:'inactive_site_doc'}}},'inactive_site_doc_0001','operations_a')).rejects.toBeDefined();
    expect((await fixture.admin.query('SELECT legacy_head FROM pactwoven.financial_authority_fences')).rows[0].legacy_head.state).toBe('REVOKED');
  });
  it('requires canonical evidence for every intermediate legacy head, independently of existing legacy completeness checks',async()=>{
    fixture=await financialFenceFixture();await authorizeFenceLegacy(fixture.mandate.pool);const {admin}=fixture;
    const head=(await admin.query('SELECT body FROM pactwoven.mandate_heads')).rows[0].body,client=await admin.connect();
    try{
      await client.query('BEGIN');await client.query('ALTER TABLE pactwoven.financial_authority_history DISABLE TRIGGER financial_no_delete');
      const pause=await directFenceControl(client,head,'PAUSE');await directFenceControl(client,pause.head,'REVOKE');
      await client.query('DELETE FROM pactwoven.financial_authority_history WHERE generation=2');
      await expect(client.query('COMMIT')).rejects.toMatchObject({code:'FA007'});await client.query('ROLLBACK');
      await client.query('BEGIN');await client.query('ALTER TABLE pactwoven.mandate_heads DISABLE TRIGGER financial_legacy_head_capture');
      await directFenceControl(client,head,'PAUSE');
      await expect(client.query('COMMIT')).rejects.toMatchObject({code:'FA007'});
    }finally{await client.query('ROLLBACK');client.release();}
    expect((await admin.query('SELECT generation,legacy_head FROM pactwoven.financial_authority_fences')).rows[0]).toMatchObject({generation:1,legacy_head:{state:'ACTIVE'}});
  });
  it('keeps control hashes stable across session time zones and distinguishes record namespaces',async()=>{
    fixture=await financialFenceFixture();const {admin,assetKey}=fixture;const client=await admin.connect();
    try{
      await client.query('BEGIN');await client.query("SET LOCAL TIME ZONE 'America/Chicago'");
      const f=(await client.query('SELECT * FROM pactwoven.financial_asset_fences')).rows[0];
      await client.query("SELECT pactwoven.financial_update_asset_control($1,0,$2,1,false,'2026-11-14T12:34:56.123456Z')",[assetKey,f.control_hash]);
      await client.query('COMMIT');await client.query('BEGIN');await client.query("SET LOCAL TIME ZONE 'Asia/Tokyo'");
      const row=(await client.query('SELECT f.control,f.control_hash,pactwoven.financial_registry_control_hash(to_jsonb(c)) AS actual FROM pactwoven.financial_asset_fences f JOIN pactwoven.finance_asset_controls c USING(asset_key)')).rows[0];
      expect(row.control.revoked_at).toBe('2026-11-14T12:34:56.123456Z');expect(row.control_hash).toBe(row.actual);
      expect(row.actual).toBe(await commandDigest({namespace:'pactwoven:financial-registry-control:v1',record:row.control}));
      expect(row.actual).not.toBe(await commandDigest(row.control));
      await client.query('COMMIT');
    }finally{await client.query('ROLLBACK');client.release();}
  });
  it('initializes newly inserted registry controls and site fences with exact zero-generation history',async()=>{
    fixture=await financialFenceFixture();const {admin,assetKey,accountA,observer}=fixture;const client=await admin.connect();
    try{
      await client.query('BEGIN');
      const newAsset=(await client.query("INSERT INTO pactwoven.finance_physical_assets(genesis,token_program,mint) SELECT genesis,token_program,decode(repeat('ab',32),'hex') FROM pactwoven.finance_physical_assets WHERE asset_key=$1 RETURNING asset_key",[assetKey])).rows[0].asset_key;
      await client.query("INSERT INTO pactwoven.finance_asset_versions SELECT $1,1,policy,decimals,policy_hash,verifier_version,evidence FROM pactwoven.finance_asset_versions WHERE asset_key=$2 AND version=1",[newAsset,assetKey]);
      await client.query('INSERT INTO pactwoven.finance_asset_controls VALUES($1,1,false,null)',[newAsset]);
      const newAccount=(await client.query("INSERT INTO pactwoven.finance_physical_accounts(genesis,address,environment,organization_id) SELECT genesis,decode(repeat('cd',32),'hex'),environment,organization_id FROM pactwoven.finance_physical_accounts WHERE account_key=$1 RETURNING account_key",[accountA])).rows[0].account_key;
      await client.query('INSERT INTO pactwoven.finance_account_versions SELECT $1,1,asset_key,expected_authority,policy_hash,verifier_version,evidence,incarnation_evidence FROM pactwoven.finance_account_versions WHERE account_key=$2 AND version=1',[newAccount,accountA]);
      await client.query('INSERT INTO pactwoven.finance_account_controls VALUES($1,1,false,null)',[newAccount]);
      await client.query("INSERT INTO pactwoven.finance_sources VALUES('source_new','development','org_a')");
      await client.query("INSERT INTO pactwoven.finance_source_versions SELECT 'source_new',version,endpoint_configuration_hash,adapter_version,normalizer_version,policy_hash,verifier_version,evidence FROM pactwoven.finance_source_versions WHERE source_id='source_org_a'");
      await client.query("INSERT INTO pactwoven.finance_source_controls VALUES('source_new',1,false,null)");
      await client.query("INSERT INTO pactwoven.finance_source_bindings SELECT 'source_new',$1,'development','org_a',oid,rolname,false,null FROM pg_roles WHERE rolname=$2",[newAccount,observer.role]);
      await client.query("INSERT INTO pactwoven.sites VALUES('development','org_a','site_new','New site','America/Chicago')");
      await client.query('COMMIT');
      expect((await admin.query("SELECT kind,generation FROM pactwoven.financial_registry_history WHERE basis='initial' ORDER BY kind")).rows).toEqual([
        {kind:'account',generation:0},{kind:'asset',generation:0},{kind:'binding',generation:0},{kind:'source',generation:0},
      ]);
      const site=(await admin.query("SELECT * FROM pactwoven.financial_site_fences WHERE site_id='site_new'")).rows[0];expect(site.generation).toBe(0);
      await admin.query("SELECT pactwoven.financial_update_site_control('development','org_a','site_new',0,$1,'New site','America/Chicago',false)",[site.record_hash]);
      await admin.query("SELECT pactwoven.financial_update_site_control('development','org_a','site_new',1,$1,'New site','America/Chicago',true)",[site.record_hash]);
      expect((await admin.query("SELECT generation,active FROM pactwoven.financial_site_fences WHERE site_id='site_new'")).rows[0]).toEqual({generation:2,active:true});
    }finally{await client.query('ROLLBACK');client.release();}
  });
  it('preserves real bootstrap action-site grants while initializing only the new site fence',async()=>{
    fixture=await financialFenceFixture();
    const identity={...fenceIdentity('new_owner'),externalOrganizationId:'clerk_new_organization',externalOrganizationName:'Synthetic new organization',externalRole:'org:admin'};
    const result=await new PostgresOrganizationProvisioner(fixture.bootstrap.pool,'development').bootstrapOrganization(identity,'fa0_bootstrap_0001',{
      expectedVersion:0,mandateVersion:null,authorityEpoch:null,payload:{initialSite:{name:'Initial site',timeZone:'America/Chicago'}}},'fa0_bootstrap');
    expect(result.status).toBe('succeeded');expect(result.financialState).toBeNull();
    const rows=(await fixture.admin.query("SELECT f.generation,f.active,h.basis,g.actor_id FROM pactwoven.financial_site_fences f JOIN pactwoven.financial_site_history h USING(environment,organization_id,site_id) JOIN pactwoven.member_action_sites g USING(environment,organization_id,site_id) JOIN pactwoven.organizations o ON(o.environment,o.id)=(f.environment,f.organization_id) WHERE o.external_organization_id='clerk_new_organization'")).rows;
    expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({generation:0,active:true,basis:'initial'});
    expect((await fixture.admin.query('SELECT count(*)::int AS count FROM pactwoven.financial_authority_fences')).rows[0].count).toBe(1);
  });
});
