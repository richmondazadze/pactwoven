import { readFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgresAccessRecoveryRepository } from './access-recovery-repository.js';
import { PostgresAccessRepository } from './access-repository.js';
import { fixture, identity, intentFor, closeProof, accessProof, grant, rawClose, rawChange, snapshot, blockedBy, iso, type RecoveryFixture } from './access-recovery.test-support.js';

const suite = process.env.PACTWOVEN_RUN_ACCESS_RECOVERY_DB_TESTS === '1' ? describe : describe.skip;
const key = 'recovery_original_key_0001';
const observe = <T>(promise: Promise<T>) => promise.then(value => ({value,error:undefined}),error => ({value:undefined,error}));
suite('RECOVERY-01B isolated durable key closure', () => {
  let f:RecoveryFixture, repository:PostgresAccessRecoveryRepository;
  beforeAll(async () => { f=await fixture(); repository=new PostgresAccessRecoveryRepository(f.access,'development'); });
  beforeEach(async () => f.reset());
  afterAll(async () => f?.close());
  const close = async (kind:'grant'|'revise'|'revoke'='grant', originalKey=key, actor=identity(), epoch=0) => {
    const intent=intentFor(kind,actor,epoch); return repository.close(await closeProof(originalKey,intent,actor),originalKey,intent,'recovery_test');
  };
  const get = (kind:'grant'|'revise'|'revoke'='grant', originalKey=key, actor=identity()) => repository.get(actor,{kind,key:originalKey},'recovery_test');
  const count = async () => (await f.admin.query('SELECT count(*)::int AS n FROM pactwoven.member_access_key_fences')).rows[0].n;

  it('preserves the complete 0005 mutation except pre-effect isolation and fence checks', async () => {
    const old=await readFile(new URL('../migrations/0005_access_acceptance.sql',import.meta.url),'utf8');
    const next=await readFile(new URL('../migrations/0006_access_recovery_fences.sql',import.meta.url),'utf8');
    const extract=(text:string) => text.slice(text.indexOf('CREATE OR REPLACE FUNCTION pactwoven.change_member_access'),text.indexOf('\nREVOKE ALL ON FUNCTION',text.indexOf('CREATE OR REPLACE FUNCTION pactwoven.change_member_access'))).trim();
    const actual=extract(next).replace('  PERFORM pactwoven.access_recovery_require_read_committed();\n','')
      .replace(/  IF EXISTS\(SELECT 1 FROM pactwoven\.member_access_key_fences[\s\S]*?  IF prior_operation\.id IS NOT NULL THEN\n    IF prior_operation\.command_hash/,'  IF FOUND THEN\n    IF prior_operation.command_hash');
    expect(actual).toBe(extract(old)); expect(next).not.toContain('CREATE OR REPLACE FUNCTION pactwoven.access_owner');
  });
  it.each(['grant','revise','revoke'] as const)('fences absent %s with no unrelated effects and exposes only the receipt', async kind => {
    const before=await snapshot(f.admin); expect((await get(kind)).disposition).toBe('not_recorded');
    const result=await close(kind); expect(result.disposition).toBe('fenced'); expect(await snapshot(f.admin)).toEqual(before); expect(await count()).toBe(1);
    expect(Object.keys(result).sort()).toEqual(['disposition','environment','externalOrganizationId','fence','key','kind','observedAt','organizationId','reviewer','schemaVersion']);
    expect(JSON.stringify(result)).not.toMatch(/tokenHash|requestNonce|session_owner|intentHash|closed_by/);
    expect((await get(kind)).disposition).toBe('fenced');
  });
  it('returns the exact original operation despite an old review epoch and a now-departed target', async () => {
    const operation=await rawChange(f.access,accessProof(),key,grant());
    await f.admin.query("UPDATE pactwoven.memberships SET status='revoked' WHERE actor_id=$1",[operation.aggregateId]);
    const before=await snapshot(f.admin), result=await close();
    expect(result.disposition).toBe('recorded'); if(result.disposition==='recorded') expect(result.operation).toEqual(operation);
    expect(result.reviewer.authorityEpoch).toBe(1); expect(await count()).toBe(0); expect(await snapshot(f.admin)).toEqual(before);
  });
  it('retains first closure attribution while another current owner repeats with a stale review epoch', async () => {
    const first=await close(), stored=(await f.admin.query('SELECT * FROM pactwoven.member_access_key_fences')).rows[0];
    await f.admin.query("UPDATE pactwoven.organizations SET authority_epoch=1 WHERE id='org_a'");
    const repeat=await close('grant',key,identity('owner_b'),0);
    expect(repeat.disposition).toBe('fenced'); if(first.disposition==='fenced'&&repeat.disposition==='fenced') expect(repeat.fence).toEqual(first.fence);
    expect(repeat.reviewer).toEqual({actorId:'owner_b',externalMembershipId:'membership_owner_b',authorityEpoch:1});
    expect((await f.admin.query('SELECT * FROM pactwoven.member_access_key_fences')).rows[0]).toEqual(stored);
  });
  it('requires the epoch for a new fence and non-epoch scope pins even for existing records', async () => {
    await expect(close('grant',key,identity(),1)).rejects.toMatchObject({code:'VERSION_CONFLICT'}); expect(await count()).toBe(0);
    await close(); const intent={...intentFor(),expectedActorId:'owner_b'};
    await expect(rawClose(f.access,await closeProof(key,intent),key,intent)).rejects.toMatchObject({code:'PA001'});
  });
  it.each(['grant','revise','revoke'] as const)('refuses the old %s RPC for every actor/payload after the exact namespace is fenced', async kind => {
    await close(kind); const before=await snapshot(f.admin), legacy=new PostgresAccessRepository(f.access,'development');
    const mutation=kind==='grant'?grant():kind==='revise'?{kind,actorId:'missing_target',target:grant().target!,command:{expectedVersion:1,mandateVersion:null,authorityEpoch:0,payload:{roles:['finance' as const],siteIds:[],actionSiteIds:[],expiresAt:null}}}
      :{kind,actorId:'missing_target',target:null,command:{expectedVersion:1,mandateVersion:null,authorityEpoch:0,payload:{reason:'Different request'}}};
    for(const actor of [identity(),identity('owner_b')]) await expect(legacy.changeAccess(accessProof(actor),key,mutation,'recovery_test')).rejects.toMatchObject({code:'ACCESS_KEY_FENCED'});
    expect(await snapshot(f.admin)).toEqual(before);
  });
  it('keeps same textual keys separate across kind, organization and environment', async () => {
    await close(); expect((await get('revoke')).disposition).toBe('not_recorded');
    expect((await get('grant',key,identity('owner_c','clerk_org_b'))).disposition).toBe('not_recorded');
    await f.admin.query("INSERT INTO pactwoven.organizations(environment,id,external_organization_id,name) VALUES('staging','org_a','clerk_org_a','Staging')");
    await f.admin.query("INSERT INTO pactwoven.memberships(environment,organization_id,actor_id,external_subject,external_membership_id,roles,grant_basis) VALUES('staging','org_a','owner_a','owner_a','membership_owner_a',ARRAY['owner'],'internal')");
    expect((await new PostgresAccessRecoveryRepository(f.access,'staging').get(identity(),{kind:'grant',key},'trace')).disposition).toBe('not_recorded');
  });
  it.each(['purpose','nonce','request-hash','intent-hash','key','kind','scope','session','extra-field','factor','expired','future'] as const)('rejects mismatched private %s without a fence',async change=>{
    const intent=intentFor(), proof=await closeProof(key,intent), evidence=proof.evidence as unknown as Record<string,unknown>;
    if(change==='purpose') evidence.purpose='member_access'; if(change==='nonce') evidence.requestNonce=crypto.randomUUID();
    if(change==='request-hash') evidence.requestHash='b'.repeat(64); if(change==='intent-hash') evidence.intentHash='b'.repeat(64);
    if(change==='key') evidence.key='different_request_0001'; if(change==='kind') evidence.kind='revoke';
    if(change==='scope') evidence.scope={...proof.evidence.scope,actorId:'owner_b'}; if(change==='session') evidence.sessionId='other_session';
    if(change==='extra-field') evidence.untrustedToken='synthetic unwanted field'; if(change==='factor') evidence.secondFactorAgeMinutes=8;
    if(change==='expired') evidence.expiresAt=iso(Date.now()-1); if(change==='future') evidence.observedAt=iso(Date.now()+60000);
    await expect(rawClose(f.access,proof,key,intent)).rejects.toMatchObject({code:'PA005'}); expect(await count()).toBe(0);
  });
  it.each(['revoked','suspended','expired','session','observation','not-owner'] as const)('requires current owner capability: %s',async change=>{
    const actor=identity(), proof=await closeProof(key,intentFor(),actor);
    if(change==='revoked'||change==='suspended') await f.admin.query('UPDATE pactwoven.memberships SET status=$1 WHERE actor_id=$2',[change,'owner_a']);
    if(change==='expired') await f.admin.query("UPDATE pactwoven.memberships SET expires_at=clock_timestamp()-interval '1 second' WHERE actor_id='owner_a'");
    if(change==='session') await f.admin.query("INSERT INTO pactwoven.session_revocations(environment,session_id) VALUES('development','session_owner_a')");
    if(change==='observation') actor.membershipObservedAt=iso(Date.now()-21000);
    if(change==='not-owner') await f.admin.query("UPDATE pactwoven.memberships SET roles=ARRAY['auditor'] WHERE actor_id='owner_a'");
    await expect(rawClose(f.access,proof,key,intentFor())).rejects.toMatchObject({code:'PA001'}); await expect(get('grant',key,actor)).rejects.toMatchObject({code:'FORBIDDEN'}); expect(await count()).toBe(0);
  });
  it('requires new factors for repeat POST but permits authorized GET after historical factors expire', async()=>{
    const intent=intentFor(), proof=await closeProof(key,intent); proof.evidence.expiresAt=iso(Date.now()+500);
    const first=await repository.close(proof,key,intent,'trace'); await new Promise(resolve=>setTimeout(resolve,550));
    await expect(repository.close(proof,key,intent,'trace')).rejects.toMatchObject({code:'STEP_UP_REQUIRED'});
    const read=await get(); expect(read.disposition).toBe('fenced'); if(first.disposition==='fenced'&&read.disposition==='fenced') expect(read.fence).toEqual(first.fence);
  });
  it('recovers a committed closure after its response is lost and a new repository starts',async()=>{
    const faulting={connect:()=>f.access.connect(),query:async(sql:string,params:unknown[])=>{const response=await f.access.query(sql,params);if(sql.includes('SELECT pactwoven.close_access_recovery('))throw new Error('Private driver failure');return response;}} as unknown as Pool;
    const intent=intentFor(); await expect(new PostgresAccessRecoveryRepository(faulting,'development').close(await closeProof(key,intent),key,intent,'trace')).rejects.toMatchObject({code:'DURABLE_SERVICE_UNAVAILABLE'});
    expect((await get()).disposition).toBe('fenced'); expect(await count()).toBe(1);
  });
  it.each(['close','original'] as const)('serializes both orderings with the %s transaction owning the organization lock first',async first=>{
    const holder=await f.access.connect(),waiter=await f.access.connect(), barrier=await blockedBy(f.admin,waiter,holder), intent=intentFor();
    let pending:ReturnType<typeof observe>|undefined;
    try {
      await holder.query('BEGIN');
      const original=first==='close'?await rawClose(holder,await closeProof(key,intent),key,intent):await rawChange(holder,accessProof(),key,grant());
      pending=observe(first==='close'?rawChange(waiter,accessProof(),key,grant()):rawClose(waiter,await closeProof(key,intent),key,intent));
      await barrier.wait(); await holder.query('COMMIT'); const result=await pending;
      if(first==='close'){expect(result.error).toMatchObject({code:'PA006'});expect(await count()).toBe(1);expect((await f.admin.query("SELECT count(*)::int AS n FROM pactwoven.operations WHERE kind LIKE 'member.%'")).rows[0].n).toBe(0);}
      else {expect(result.error).toBeUndefined();expect(result.value).toMatchObject({disposition:'recorded',operation:original});expect(await count()).toBe(0);}
    } finally {await holder.query('ROLLBACK');if(pending)await pending;holder.release();waiter.release();}
  });
  it.each(['close','original'] as const)('allows the other outcome when the first %s transaction rolls back',async first=>{
    const holder=await f.access.connect(),waiter=await f.access.connect(), barrier=await blockedBy(f.admin,waiter,holder),intent=intentFor();let pending:ReturnType<typeof observe>|undefined;
    try {
      await holder.query('BEGIN'); if(first==='close')await rawClose(holder,await closeProof(key,intent),key,intent);else await rawChange(holder,accessProof(),key,grant());
      pending=observe(first==='close'?rawChange(waiter,accessProof(),key,grant()):rawClose(waiter,await closeProof(key,intent),key,intent));
      await barrier.wait();await holder.query('ROLLBACK');const result=await pending;expect(result.error).toBeUndefined();
      expect(first==='close'?(result.value as {status:string}).status:(result.value as {disposition:string}).disposition).toBe(first==='close'?'succeeded':'fenced');
    } finally {await holder.query('ROLLBACK');if(pending)await pending;holder.release();waiter.release();}
  });
  it('resolves concurrent closes by different owners to one immutable receipt',async()=>{
    const results=await Promise.all([close(),close('grant',key,identity('owner_b'))]);
    expect(results[0].disposition).toBe('fenced'); if(results[0].disposition==='fenced'&&results[1].disposition==='fenced')expect(results[0].fence).toEqual(results[1].fence);
    expect(await count()).toBe(1);
  });
  it.each(['owner','observation','evidence'] as const)('rolls back a fence if %s expires during a write before final acceptance',async expiry=>{
    await f.admin.query("CREATE FUNCTION pactwoven.recovery_test_delay() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.6); RETURN NEW; END $$");
    await f.admin.query('CREATE TRIGGER z_recovery_test_delay AFTER INSERT ON pactwoven.member_access_key_fences FOR EACH ROW EXECUTE FUNCTION pactwoven.recovery_test_delay()');
    const intent=intentFor(),proof=await closeProof(key,intent),deadline=Date.now()+400;
    if(expiry==='owner')await f.admin.query("UPDATE pactwoven.memberships SET expires_at=$1 WHERE actor_id='owner_a'",[iso(deadline)]);
    if(expiry==='observation')proof.identity.membershipObservedAt=iso(deadline-20000);if(expiry==='evidence')proof.evidence.expiresAt=iso(deadline);
    try {await expect(rawClose(f.access,proof,key,intent)).rejects.toMatchObject({code:expiry==='evidence'?'PA005':'PA001'});expect(await count()).toBe(0);}
    finally {await f.admin.query('DROP TRIGGER z_recovery_test_delay ON pactwoven.member_access_key_fences');await f.admin.query('DROP FUNCTION pactwoven.recovery_test_delay()');}
  });
  it('orders closure after a preceding local session revocation INSERT',async()=>{
    const holder=await f.admin.connect(),waiter=await f.access.connect(),barrier=await blockedBy(f.admin,waiter,holder),intent=intentFor();let pending:ReturnType<typeof observe>|undefined;
    try {await holder.query('BEGIN');await holder.query("INSERT INTO pactwoven.session_revocations(environment,session_id) VALUES('development','session_owner_a')");
      pending=observe(rawClose(waiter,await closeProof(key,intent),key,intent));await barrier.wait();await holder.query('COMMIT');expect((await pending).error).toMatchObject({code:'PA001'});expect(await count()).toBe(0);
    } finally {await holder.query('ROLLBACK');if(pending)await pending;holder.release();waiter.release();}
  });
  it('orders a later local revocation after a closure already holding the session lock',async()=>{
    const holder=await f.access.connect(),waiter=await f.admin.connect(),barrier=await blockedBy(f.admin,waiter,holder),intent=intentFor();let pending:ReturnType<typeof observe>|undefined;
    try {await holder.query('BEGIN');await rawClose(holder,await closeProof(key,intent),key,intent);
      pending=observe(waiter.query("INSERT INTO pactwoven.session_revocations(environment,session_id) VALUES('development','session_owner_a')"));
      await barrier.wait();await holder.query('COMMIT');expect((await pending).error).toBeUndefined();expect(await count()).toBe(1);
      await expect(get()).rejects.toMatchObject({code:'FORBIDDEN'});
      expect((await get('grant',key,identity('owner_b'))).disposition).toBe('fenced');
    } finally {await holder.query('ROLLBACK');if(pending)await pending;holder.release();waiter.release();}
  });
  it('preserves the legacy common acceptance check after its final outbox write',async()=>{
    await f.admin.query("CREATE FUNCTION pactwoven.recovery_test_delay() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.6); RETURN NEW; END $$");
    await f.admin.query('CREATE TRIGGER z_recovery_test_delay AFTER INSERT ON pactwoven.outbox_events FOR EACH ROW EXECUTE FUNCTION pactwoven.recovery_test_delay()');
    const proof=accessProof(),before=await snapshot(f.admin);proof.evidence.expiresAt=iso(Date.now()+400);
    try {await expect(rawChange(f.access,proof,key,grant())).rejects.toMatchObject({code:'PA005'});expect(await snapshot(f.admin)).toEqual(before);expect(await count()).toBe(0);}
    finally {await f.admin.query('DROP TRIGGER z_recovery_test_delay ON pactwoven.outbox_events');await f.admin.query('DROP FUNCTION pactwoven.recovery_test_delay()');}
  });
  it('does not claim closure after an insert trigger aborts',async()=>{
    await f.admin.query("CREATE FUNCTION pactwoven.recovery_test_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE='PA007',MESSAGE='Injected fixture failure'; END $$");
    await f.admin.query('CREATE TRIGGER z_recovery_test_reject AFTER INSERT ON pactwoven.member_access_key_fences FOR EACH ROW EXECUTE FUNCTION pactwoven.recovery_test_reject()');
    try {await expect(close()).rejects.toMatchObject({code:'DURABLE_SERVICE_UNAVAILABLE'});expect(await count()).toBe(0);}
    finally {await f.admin.query('DROP TRIGGER z_recovery_test_reject ON pactwoven.member_access_key_fences');await f.admin.query('DROP FUNCTION pactwoven.recovery_test_reject()');}
    expect((await rawChange(f.access,accessProof(),key,grant())).status).toBe('succeeded');
  });
  it('treats a prior not-recorded observation as nonfinal when an original arrives before closure',async()=>{
    expect((await get()).disposition).toBe('not_recorded');
    const original=await rawChange(f.access,accessProof(),key,grant()),result=await close();
    expect(result).toMatchObject({disposition:'recorded',operation:original});expect(await count()).toBe(0);
  });
  it('retains a recorded pending operation without substituting a fence or terminal status',async()=>{
    const original=await rawChange(f.access,accessProof(),key,grant());
    await f.admin.query("UPDATE pactwoven.operations SET response=jsonb_set(response,'{status}','\"pending\"') WHERE id=$1",[original.id]);
    const result=await close();expect(result).toMatchObject({disposition:'recorded',operation:{id:original.id,status:'pending'}});expect(await count()).toBe(0);
  });
  it.each([null,'member.grant','',42] as const)('rejects an invalid direct SQL recovery kind %s',async kind=>{
    await expect(f.access.query("SELECT pactwoven.read_access_recovery('development',$1::jsonb,$2,$3)",[JSON.stringify(identity()),kind,key])).rejects.toMatchObject({code:'PA004'});expect(await count()).toBe(0);
  });
  it.each([null,'short','not a permitted key value'] as const)('rejects an invalid direct SQL recovery key %s',async invalidKey=>{
    await expect(f.access.query("SELECT pactwoven.read_access_recovery('development',$1::jsonb,'grant',$2)",[JSON.stringify(identity()),invalidKey])).rejects.toMatchObject({code:'PA004'});expect(await count()).toBe(0);
  });
  it.each(['audit','both-records'] as const)('fails closed on privileged %s corruption',async corruption=>{
    await close(); await f.admin.query('ALTER TABLE pactwoven.member_access_key_fences DISABLE TRIGGER USER');
    try {
      if(corruption==='audit') await f.admin.query("UPDATE pactwoven.member_access_key_fences SET evidence=jsonb_set(evidence,'{requestHash}',to_jsonb(repeat('b',64)))");
      else {await rawChange(f.access,accessProof(),'different_operation_0001',grant());await f.admin.query("UPDATE pactwoven.member_access_key_fences SET idempotency_key='different_operation_0001'");}
    } finally {await f.admin.query('ALTER TABLE pactwoven.member_access_key_fences ENABLE TRIGGER USER');}
    await expect(get('grant',corruption==='audit'?key:'different_operation_0001')).rejects.toMatchObject({code:'DURABLE_SERVICE_UNAVAILABLE'});
  });
});
