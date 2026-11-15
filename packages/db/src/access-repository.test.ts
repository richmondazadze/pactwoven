import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import type { GrantAccessCommand, MemberCandidate, Operation } from '@pactwoven/contracts';
import { PostgresAccessRepository, assertAccessPool, type VerifiedStepUpIdentity } from './access-repository.js';
import { PostgresOrganizationProvisioner, assertProvisionerPool } from './provisioner.js';
import { PostgresFoundationRepository, assertRuntimePool, type VerifiedIdentity } from './repository.js';

const suite = process.env.PACTWOVEN_RUN_ACCESS_DB_TESTS === '1' ? describe : describe.skip;
function identity(subject='owner_a', organization='clerk_org_a'): VerifiedIdentity {
  return { subject, externalOrganizationId: organization, externalOrganizationName: organization, externalMembershipId: `membership_${subject}`,
    externalRole: subject.startsWith('owner') ? 'org:admin' : 'org:member', sessionId: `session_${subject}`,
    authenticatedAt: new Date(Date.now()-3_600_000).toISOString(), membershipObservedAt: new Date().toISOString() };
}
function verified(actor=identity()): VerifiedStepUpIdentity {
  const issued = Math.floor(Date.now()/1000)*1000;
  return { identity: actor, evidence: { id: crypto.randomUUID(), purpose:'member_access', subject:actor.subject, externalOrganizationId:actor.externalOrganizationId,
    externalMembershipId:actor.externalMembershipId, sessionId:actor.sessionId, issuer:'https://fixture.clerk.accounts.dev', tokenHash:'a'.repeat(64),
    tokenIssuedAt:new Date(issued).toISOString(), firstFactorAgeMinutes:0, secondFactorAgeMinutes:0, verifiedAt:new Date(issued-60_000).toISOString(),
    observedAt:new Date().toISOString(), expiresAt:new Date(issued+60_000).toISOString() } };
}
function candidate(subject='finance_a', organization='clerk_org_a'): MemberCandidate {
  return { externalOrganizationId:organization, externalMembershipId:`membership_${subject}`, externalSubject:subject, displayName:subject, externalRole:'org:member', observedAt:new Date().toISOString() };
}

suite('real PostgreSQL member access commands', () => {
  let admin: Pool, runtime: Pool, bootstrap: Pool, access: Pool;
  let repo: PostgresAccessRepository, foundation: PostgresFoundationRepository, provisioner: PostgresOrganizationProvisioner;
  let organizationId: string, ownerId: string, siteA: string, siteB: string;
  const grant = (subject='finance_a', epoch=0): GrantAccessCommand => ({ expectedVersion:0, mandateVersion:null, authorityEpoch:epoch,
    payload:{ externalMembershipId:`membership_${subject}`, externalSubject:subject, roles:['finance'], siteIds:[], actionSiteIds:[siteA], expiresAt:null } });
  async function add(subject='finance_a', epoch=0, key=`grant_${subject}_request_0001`): Promise<Operation> {
    return repo.changeAccess(verified(),key,{kind:'grant',command:grant(subject,epoch),target:candidate(subject)},'test_trace');
  }
  beforeAll(async () => {
    const names=['PACTWOVEN_TEST_ADMIN_DATABASE_URL_FILE','PACTWOVEN_TEST_DATABASE_URL_FILE','PACTWOVEN_TEST_PROVISIONER_DATABASE_URL_FILE','PACTWOVEN_TEST_ACCESS_DATABASE_URL_FILE'];
    const urls=await Promise.all(names.map(async name => {
      const file=process.env[name]; if(!file) throw new Error('Explicit protected test DSN files required');
      const value=(await readFile(file,'utf8')).trim(), parsed=new URL(value);
      if(parsed.pathname!='/pactwoven_backend_test'||!['127.0.0.1','localhost'].includes(parsed.hostname)) throw new Error('Access tests require the disposable loopback backend test database');
      return parsed;
    }));
    if(urls.some(url=>url.host!==urls[0]!.host)||new Set(urls.map(url=>url.username)).size!==4) throw new Error('Four isolated logins on one disposable test database required');
    admin=new Pool({connectionString:urls[0]!.href,max:3});
    expect((await admin.query('SELECT current_database() AS name')).rows[0].name).toBe('pactwoven_backend_test');
    await admin.query('DROP SCHEMA IF EXISTS pactwoven CASCADE');
    for(const file of ['0001_foundation.sql','0002_organization_bootstrap.sql','0003_identity_access.sql']) await admin.query(await readFile(new URL(`../migrations/${file}`,import.meta.url),'utf8'));
    for(const [index,role] of [[1,'pactwoven_runtime'],[2,'pactwoven_provisioner'],[3,'pactwoven_access_provisioner']] as const) {
      const result=await admin.query("SELECT format('GRANT %I TO %I',$1::text,$2::text) AS sql",[role,decodeURIComponent(urls[index]!.username)]);
      await admin.query(result.rows[0].sql);
    }
    runtime=new Pool({connectionString:urls[1]!.href,max:4}); bootstrap=new Pool({connectionString:urls[2]!.href,max:2}); access=new Pool({connectionString:urls[3]!.href,max:4,statement_timeout:5000});
    await assertRuntimePool(runtime); await assertProvisionerPool(bootstrap); await assertAccessPool(access);
    repo=new PostgresAccessRepository(access,'development'); foundation=new PostgresFoundationRepository(runtime,'development'); provisioner=new PostgresOrganizationProvisioner(bootstrap,'development');
  },20000);
  beforeEach(async () => {
    await admin.query('TRUNCATE pactwoven.organizations,pactwoven.session_revocations CASCADE');
    await provisioner.bootstrapOrganization(identity(),'bootstrap_owner_request_0001',{expectedVersion:0,mandateVersion:null,authorityEpoch:null,payload:{initialSite:{name:'Site A',timeZone:'America/Chicago'}}},'test_trace');
    const session=await foundation.getSession(identity(),'test_trace'); organizationId=session.organization.id; ownerId=session.actor.actorId; siteA=session.sites[0]!.id; siteB=crypto.randomUUID();
    await admin.query("INSERT INTO pactwoven.sites(environment,organization_id,id,name,time_zone) VALUES('development',$1,$2,'Site B','America/Chicago')",[organizationId,siteB]);
  });
  afterAll(async () => { await Promise.all([runtime?.end(),bootstrap?.end(),access?.end(),admin?.end()]); });
  it('grants a verified distinct member through the command path and keeps financial action sites separate from broad reads',async () => {
    const owner=await foundation.getSession(identity(),'test_trace');
    expect(owner.actor.siteIds).toHaveLength(2); expect(owner.actor.actionSiteIds).toEqual([siteA]);
    const operation=await add(); expect(operation.status).toBe('succeeded'); expect(operation.financialState).toBeNull();
    const member=await foundation.getSession(identity('finance_a'),'test_trace');
    expect(member.actor.siteIds).toHaveLength(2); expect(member.actor.actionSiteIds).toEqual([siteA]);
    const page=await repo.listMembers(identity(),{limit:25}); expect(page.authorityEpoch).toBe(1);
    expect(page.items.find(item=>item.actorId===operation.aggregateId)).toMatchObject({version:1,roles:['finance'],actionSiteIds:[siteA]});
    const history=await admin.query('SELECT * FROM pactwoven.member_access_history'); expect(history.rows).toHaveLength(1); expect(history.rows[0].mfa_evidence).not.toHaveProperty('token');
  });
  it('replays one exact operation, recovers a lost response, and rejects key reuse with a changed command',async () => {
    const first=await add(); expect((await add()).id).toBe(first.id);
    expect((await repo.getOperation(identity(),{kind:'grant',key:'grant_finance_a_request_0001'})).id).toBe(first.id);
    await expect(repo.getOperation(identity(),{kind:'grant',key:'unknown_request_key_0001'})).rejects.toMatchObject({code:'NOT_FOUND'});
    await expect(repo.changeAccess(verified(),'grant_finance_a_request_0001',{kind:'grant',command:{...grant(),payload:{...grant().payload,roles:['operations'],siteIds:[siteA]}},target:candidate()},'trace')).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
    expect((await repo.listMembers(identity(),{limit:25})).authorityEpoch).toBe(1);
  });
  it('rejects self-escalation, foreign membership/site, no-MFA and expired observations without writes',async () => {
    await expect(repo.changeAccess(verified(),'self_grant_request_0001',{kind:'grant',command:grant('owner_a'),target:candidate('owner_a')},'trace')).rejects.toBeDefined();
    await expect(repo.changeAccess(verified(),'foreign_member_request_0001',{kind:'grant',command:grant(),target:candidate('finance_a','foreign_org')},'trace')).rejects.toMatchObject({code:'FORBIDDEN'});
    await expect(repo.changeAccess(verified(),'foreign_site_request_0001',{kind:'grant',command:{...grant(),payload:{...grant().payload,actionSiteIds:['foreign_site']}},target:candidate()},'trace')).rejects.toMatchObject({code:'VALIDATION_FAILED'});
    const stale=verified(); stale.evidence.expiresAt=new Date(Date.now()-1).toISOString();
    await expect(repo.changeAccess(stale,'expired_proof_request_0001',{kind:'grant',command:grant(),target:candidate()},'trace')).rejects.toMatchObject({code:'STEP_UP_REQUIRED'});
    const wrong=verified(); wrong.evidence.subject='different_owner';
    await expect(repo.changeAccess(wrong,'wrong_proof_request_0001',{kind:'grant',command:grant(),target:candidate()},'trace')).rejects.toMatchObject({code:'STEP_UP_REQUIRED'});
    expect((await repo.listMembers(identity(),{limit:25})).authorityEpoch).toBe(0);
    expect((await admin.query('SELECT count(*)::int AS n FROM pactwoven.member_access_history')).rows[0].n).toBe(0);
  });
  it('changes scope and revokes atomically while preserving immutable identity and history',async () => {
    const first=await add(); const payload={roles:['finance'] as const,siteIds:[],actionSiteIds:[siteB],expiresAt:null};
    await repo.changeAccess(verified(),'revise_access_request_0001',{kind:'revise',actorId:first.aggregateId,command:{expectedVersion:1,authorityEpoch:1,mandateVersion:null,payload:{...payload,roles:[...payload.roles]}},target:candidate()},'trace');
    expect((await foundation.getSession(identity('finance_a'),'trace')).actor.actionSiteIds).toEqual([siteB]);
    await repo.changeAccess(verified(),'revoke_access_request_0001',{kind:'revoke',actorId:first.aggregateId,command:{expectedVersion:2,authorityEpoch:2,mandateVersion:null,payload:{reason:'Access no longer required'}},target:null},'trace');
    await expect(foundation.getSession(identity('finance_a'),'trace')).rejects.toMatchObject({code:'FORBIDDEN'});
    expect((await admin.query('SELECT count(*)::int AS n FROM pactwoven.member_access_history')).rows[0].n).toBe(3);
    await expect(admin.query("UPDATE pactwoven.member_access_history SET kind='grant'")).rejects.toMatchObject({code:'PA001'});
    await expect(admin.query("UPDATE pactwoven.memberships SET external_subject='replacement' WHERE actor_id=$1",[first.aggregateId])).rejects.toMatchObject({code:'PA001'});
  });
  it('serializes competing grants against the organization epoch',async () => {
    const result=await Promise.allSettled([add('finance_a'),add('finance_b')]);
    expect(result.filter(item=>item.status==='fulfilled')).toHaveLength(1);
    expect(result.filter(item=>item.status==='rejected')).toHaveLength(1);
    expect((await repo.listMembers(identity(),{limit:25})).authorityEpoch).toBe(1);
    expect((await admin.query('SELECT count(*)::int AS n FROM pactwoven.member_access_history')).rows[0].n).toBe(1);
  });
  it('rejects a queued command when owner authority is revoked before it acquires the shared lock',async () => {
    const lock=await admin.connect(); await lock.query('BEGIN');
    try {
      await lock.query("SELECT id FROM pactwoven.organizations WHERE environment='development' AND id=$1 FOR UPDATE",[organizationId]);
      const pending=add();
      await lock.query("UPDATE pactwoven.memberships SET status='revoked' WHERE environment='development' AND actor_id=$1",[ownerId]);
      await lock.query('COMMIT');
      await expect(pending).rejects.toMatchObject({code:'FORBIDDEN'});
      expect((await admin.query('SELECT count(*)::int AS n FROM pactwoven.member_access_history')).rows[0].n).toBe(0);
    } finally { await lock.query('ROLLBACK'); lock.release(); }
  });
  it('rolls back member, scope, epoch, operation and event together on a posting failure',async () => {
    await admin.query("CREATE FUNCTION pactwoven.fail_access_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected test failure'; END $$; CREATE TRIGGER fail_access_test BEFORE INSERT ON pactwoven.member_access_history FOR EACH ROW EXECUTE FUNCTION pactwoven.fail_access_test()");
    try { await expect(add()).rejects.toBeDefined(); }
    finally { await admin.query('DROP TRIGGER fail_access_test ON pactwoven.member_access_history; DROP FUNCTION pactwoven.fail_access_test()'); }
    expect((await repo.listMembers(identity(),{limit:25})).authorityEpoch).toBe(0);
    expect((await admin.query("SELECT count(*)::int AS n FROM pactwoven.operations WHERE kind LIKE 'member.%'")).rows[0].n).toBe(0);
    expect((await admin.query("SELECT count(*)::int AS n FROM pactwoven.memberships WHERE external_subject='finance_a'")).rows[0].n).toBe(0);
  });
  it('denies direct runtime or bootstrap access capabilities and spoofed bootstrap events',async () => {
    await expect(runtime.query("SELECT pactwoven.read_member_access('development',$1::jsonb,0,25,NULL)",[JSON.stringify(identity())])).rejects.toMatchObject({code:'42501'});
    await expect(bootstrap.query("SELECT pactwoven.read_member_access('development',$1::jsonb,0,25,NULL)",[JSON.stringify(identity())])).rejects.toMatchObject({code:'42501'});
    await expect(access.query('SELECT * FROM pactwoven.memberships')).rejects.toMatchObject({code:'42501'});
    const client=await runtime.connect(); await client.query('BEGIN');
    try {
      await client.query("SELECT set_config('pactwoven.environment','development',true),set_config('pactwoven.organization_id',$1,true),set_config('pactwoven.actor_id',$2,true),set_config('pactwoven.session_id',$3,true)",[organizationId,ownerId,identity().sessionId]);
      await expect(client.query("INSERT INTO pactwoven.outbox_events(environment,organization_id,id,aggregate_id,aggregate_version,event_type,payload) VALUES('development',$1,'spoof','spoof',1,'organization.bootstrapped','{}')",[organizationId])).rejects.toMatchObject({code:'42501'});
    } finally { await client.query('ROLLBACK'); client.release(); }
    expect((await foundation.getSession(identity(),'trace')).actor.actionSiteIds).toEqual([siteA]);
  });
});
