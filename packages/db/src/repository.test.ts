import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Command, CreateResponsibilityPayload, OrganizationBootstrapPayload } from '@pactwoven/contracts';
import { assertRuntimePool, PostgresFoundationRepository, type VerifiedIdentity } from './repository.js';
import { assertProvisionerPool, PostgresOrganizationProvisioner } from './provisioner.js';

const enabled = process.env.PACTWOVEN_RUN_DB_TESTS === '1';
const adminFile = process.env.PACTWOVEN_TEST_ADMIN_DATABASE_URL_FILE;
const runtimeFile = process.env.PACTWOVEN_TEST_DATABASE_URL_FILE;
const provisionerFile = process.env.PACTWOVEN_TEST_PROVISIONER_DATABASE_URL_FILE;
const dbSuite = enabled ? describe : describe.skip;
const identity = (subject = 'user_a', externalOrganizationId = 'external_org_a'): VerifiedIdentity => ({
  subject, externalOrganizationId, sessionId: `session_${subject}`, authenticatedAt: '2026-11-14T00:00:00.000Z',
  externalMembershipId: `membership_${subject}`, externalOrganizationName: 'Harbor Events', externalRole: 'org:admin',
  membershipObservedAt: new Date().toISOString(),
});
const bootstrapCommand = (name = 'First site'): Command<OrganizationBootstrapPayload> => ({
  expectedVersion: 0, mandateVersion: null, authorityEpoch: null,
  payload: { initialSite: { name, timeZone: 'America/Chicago' } },
});
const newIdentity = () => ({ ...identity('user_new', 'external_org_new'), externalOrganizationName: 'New Organization' });
const draft = (title = 'Harbor Hall', siteId = 'site_a1'): Command<CreateResponsibilityPayload> => ({
  expectedVersion: 0, mandateVersion: null, authorityEpoch: null,
  payload: { title, description: 'Equipment and delivery', siteId,
    window: { startsAt: '2026-11-20T13:00:00.000Z', endsAt: '2026-11-20T14:00:00.000Z', timeZone: 'America/Chicago' },
    requirements: [{ id: 'chairs', description: 'Banquet chairs', quantity: 120, unit: 'chairs', evidenceRule: 'Receiver count and condition' }],
    acceptancePolicy: 'Assigned receiver reviews quantity and condition.',
  },
});

dbSuite('Postgres foundation — real runtime role and transactions', () => {
  let admin: Pool;
  let runtime: Pool;
  let provisionerPool: Pool;
  let repo: PostgresFoundationRepository;
  let provisioner: PostgresOrganizationProvisioner;

  beforeAll(async () => {
    if (!adminFile || !runtimeFile || !provisionerFile) throw new Error('Explicit protected admin/runtime/provisioner test DSN file paths are required.');
    const adminUrl = (await readFile(adminFile, 'utf8')).trim();
    const runtimeUrl = (await readFile(runtimeFile, 'utf8')).trim();
    const provisionerUrl = (await readFile(provisionerFile, 'utf8')).trim();
    const adminTarget = new URL(adminUrl);
    const runtimeTarget = new URL(runtimeUrl);
    const provisionerTarget = new URL(provisionerUrl);
    if (adminTarget.pathname !== '/pactwoven_backend_test' || runtimeTarget.pathname !== adminTarget.pathname ||
      adminTarget.host !== runtimeTarget.host || provisionerTarget.host !== adminTarget.host ||
      provisionerTarget.pathname !== adminTarget.pathname || !['127.0.0.1', 'localhost'].includes(adminTarget.hostname)) {
      throw new Error('Tests require the dedicated local pactwoven_backend_test database.');
    }
    admin = new Pool({ connectionString: adminUrl, max: 3 });
    const database = await admin.query<{ current_database: string }>('SELECT current_database()');
    expect(database.rows[0]?.current_database).toBe('pactwoven_backend_test');
    await admin.query('DROP SCHEMA IF EXISTS pactwoven CASCADE');
    await admin.query(await readFile(new URL('../migrations/0001_foundation.sql', import.meta.url), 'utf8'));
    await admin.query(await readFile(new URL('../migrations/0002_organization_bootstrap.sql', import.meta.url), 'utf8'));
    const grant = await admin.query<{ statement: string }>("SELECT format('GRANT pactwoven_runtime TO %I', $1::text) AS statement", [decodeURIComponent(runtimeTarget.username)]);
    await admin.query(grant.rows[0]!.statement);
    const provisionerGrant = await admin.query<{ statement: string }>("SELECT format('GRANT pactwoven_provisioner TO %I', $1::text) AS statement", [decodeURIComponent(provisionerTarget.username)]);
    await admin.query(provisionerGrant.rows[0]!.statement);
    runtime = new Pool({ connectionString: runtimeUrl, max: 3 });
    provisionerPool = new Pool({ connectionString: provisionerUrl, max: 3, statement_timeout: 5_000 });
    await assertRuntimePool(runtime);
    await assertProvisionerPool(provisionerPool);
    repo = new PostgresFoundationRepository(runtime, 'development');
    provisioner = new PostgresOrganizationProvisioner(provisionerPool, 'development');
  }, 20_000);

  beforeEach(async () => {
    await admin.query('TRUNCATE pactwoven.organizations, pactwoven.session_revocations CASCADE');
    await admin.query(`INSERT INTO pactwoven.organizations(environment,id,external_organization_id,name) VALUES
      ('development','org_a','external_org_a','Harbor Events'), ('development','org_b','external_org_b','Other Organization'),
      ('simulation','org_a','external_org_a','Simulation Organization')`);
    await admin.query(`INSERT INTO pactwoven.memberships(environment,organization_id,actor_id,external_subject,roles,status) VALUES
      ('development','org_a','actor_a','user_a',ARRAY['owner'],'active'),
      ('development','org_a','actor_ops','user_ops',ARRAY['operations'],'active'),
      ('development','org_a','actor_receiver','user_receiver',ARRAY['receiver'],'active'),
      ('development','org_a','actor_finance','user_finance',ARRAY['finance'],'active'),
      ('development','org_a','actor_auditor','user_auditor',ARRAY['auditor'],'active'),
      ('development','org_a','actor_supplier','user_supplier',ARRAY['supplier_admin'],'active'),
      ('development','org_a','actor_support','user_support',ARRAY['support'],'active'),
      ('development','org_a','actor_inactive','user_inactive',ARRAY['owner'],'revoked'),
      ('development','org_b','actor_b','user_b',ARRAY['owner'],'active'),
      ('simulation','org_a','actor_a','user_a',ARRAY['owner'],'active')`);
    await admin.query("UPDATE pactwoven.memberships SET external_membership_id = 'membership_' || external_subject");
    await admin.query(`INSERT INTO pactwoven.sites(environment,organization_id,id,name,time_zone) VALUES
      ('development','org_a','site_a1','Harbor Hall','America/Chicago'),
      ('development','org_a','site_a2','Second Site','America/Chicago'),
      ('development','org_b','site_b','Other Site','America/Chicago'),
      ('simulation','org_a','site_a1','Simulated Site','America/Chicago')`);
    await admin.query(`INSERT INTO pactwoven.site_memberships(environment,organization_id,actor_id,site_id) VALUES
      ('development','org_a','actor_ops','site_a1'), ('development','org_a','actor_receiver','site_a1')`);
  });

  afterAll(async () => { await runtime?.end(); await provisionerPool?.end(); await admin?.end(); });

  it('resolves verified identity through current membership and exposes only allowed sites', async () => {
    const session = await repo.getSession(identity('user_ops'), 'trace_ops');
    expect(session.actor.roles).toEqual(['operations']);
    expect(session.actor.siteIds).toEqual(['site_a1']);
    expect(session.sites.map(site => site.id)).toEqual(['site_a1']);
    expect(session.organization.name).toBe('Harbor Events');
    await expect(repo.getSession(identity('user_a', 'external_org_b'), 'trace_wrong_org')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(repo.getSession(identity('user_inactive'), 'trace_inactive')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const supplier = await repo.getSession(identity('user_supplier'), 'trace_supplier_sites');
    expect(supplier.sites).toEqual([]);
    expect(supplier.actor.siteIds).toEqual([]);
  });

  it('writes draft, durable operation and one outbox event atomically under concurrent duplicate commands', async () => {
    const { actor } = await repo.getSession(identity(), 'trace_create');
    const results = await Promise.all(Array.from({ length: 8 }, () => repo.createResponsibility(actor, 'duplicate_create_key_0001', draft())));
    expect(new Set(results.map(result => result.id)).size).toBe(1);
    const record = await repo.getResponsibility(actor, results[0]!.aggregateId);
    expect(record).toMatchObject({ title: 'Harbor Hall', version: 1, executionState: 'DRAFT', authorityState: null, coverageState: 'UNKNOWN' });
    const counts = await admin.query<{ responsibilities: string; operations: string; outbox: string }>(`SELECT
      (SELECT count(*) FROM pactwoven.responsibilities) AS responsibilities,
      (SELECT count(*) FROM pactwoven.operations) AS operations,
      (SELECT count(*) FROM pactwoven.outbox_events) AS outbox`);
    expect(counts.rows[0]).toEqual({ responsibilities: '1', operations: '1', outbox: '1' });
    await expect(repo.createResponsibility(actor, 'duplicate_create_key_0001', draft('Changed title'))).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('rolls back the whole create if durable outbox persistence fails', async () => {
    const { actor } = await repo.getSession(identity(), 'trace_atomic');
    await admin.query('REVOKE INSERT ON pactwoven.outbox_events FROM pactwoven_runtime');
    try { await expect(repo.createResponsibility(actor, 'outbox_failure_key_0001', draft())).rejects.toThrow(); }
    finally { await admin.query('GRANT INSERT ON pactwoven.outbox_events TO pactwoven_runtime'); }
    const rows = await admin.query<{ count: string }>('SELECT count(*) FROM pactwoven.responsibilities UNION ALL SELECT count(*) FROM pactwoven.operations');
    expect(rows.rows.map(row => row.count)).toEqual(['0', '0']);
  });

  it('denies cross-tenant reads, stale roles, restricted sites and non-buyer projections', async () => {
    const owner = (await repo.getSession(identity(), 'trace_owner')).actor;
    const created = await repo.createResponsibility(owner, 'scope_create_key_0001', draft());
    const other = (await repo.getSession(identity('user_b', 'external_org_b'), 'trace_other')).actor;
    await expect(repo.getResponsibility(other, created.aggregateId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await repo.listResponsibilities(other, {})).items).toHaveLength(0);
    const ops = (await repo.getSession(identity('user_ops'), 'trace_ops')).actor;
    await expect(repo.createResponsibility({ ...ops, roles: ['owner'], siteIds: ['site_a2'] }, 'forged_scope_key_0001', draft('Unauthorized site', 'site_a2')))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    for (const subject of ['user_supplier', 'user_support']) {
      const actor = (await repo.getSession(identity(subject), `trace_${subject}`)).actor;
      await expect(repo.listResponsibilities(actor, {})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    for (const subject of ['user_finance', 'user_auditor']) {
      const actor = (await repo.getSession(identity(subject), `trace_${subject}`)).actor;
      expect((await repo.listResponsibilities(actor, {})).items).toHaveLength(1);
      await expect(repo.createResponsibility(actor, `read_only_${subject}_0001`, draft())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    await admin.query("UPDATE pactwoven.memberships SET roles = ARRAY['auditor'] WHERE environment='development' AND actor_id='actor_a'");
    await expect(repo.createResponsibility(owner, 'stale_role_key_0001', draft())).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('requires both receiver assignment and site membership', async () => {
    const owner = (await repo.getSession(identity(), 'trace_owner')).actor;
    const assigned = await repo.createResponsibility(owner, 'receiver_assigned_key_0001', draft('Assigned'));
    const unassigned = await repo.createResponsibility(owner, 'receiver_unassigned_key_0001', draft('Unassigned'));
    const otherSite = await repo.createResponsibility(owner, 'receiver_other_site_key_0001', draft('Wrong site', 'site_a2'));
    await admin.query(`INSERT INTO pactwoven.responsibility_assignments(environment,organization_id,responsibility_id,actor_id)
      VALUES ('development','org_a',$1,'actor_receiver'),('development','org_a',$2,'actor_receiver')`, [assigned.aggregateId, otherSite.aggregateId]);
    const receiver = (await repo.getSession(identity('user_receiver'), 'trace_receiver')).actor;
    expect((await repo.listResponsibilities(receiver, {})).items.map(item => item.id)).toEqual([assigned.aggregateId]);
    await expect(repo.getResponsibility(receiver, unassigned.aggregateId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(repo.getResponsibility(receiver, otherSite.aggregateId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(repo.createResponsibility({ ...receiver, roles: ['owner'] }, 'receiver_forged_role_key_0001', draft())).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('rejects expiry, suspension, revocation and environment mismatch on later commands', async () => {
    const owner = (await repo.getSession(identity(), 'trace_owner')).actor;
    await expect(repo.listResponsibilities({ ...owner, environment: 'production' }, {})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await admin.query("UPDATE pactwoven.memberships SET expires_at = now() - interval '1 second' WHERE environment='development' AND actor_id='actor_a'");
    await expect(repo.createResponsibility(owner, 'expired_member_key_0001', draft())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await admin.query("UPDATE pactwoven.memberships SET expires_at = NULL WHERE environment='development' AND actor_id='actor_a'");
    await admin.query("INSERT INTO pactwoven.session_revocations(environment,session_id) VALUES ('development','session_user_a')");
    await expect(repo.getSession(identity(), 'trace_revoked')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(repo.listResponsibilities(owner, {})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await admin.query('TRUNCATE pactwoven.session_revocations');
    await admin.query("UPDATE pactwoven.organizations SET status='suspended' WHERE environment='development' AND id='org_a'");
    await expect(repo.listResponsibilities(owner, {})).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('uses stable bounded pagination and rejects another organization’s cursor', async () => {
    const owner = (await repo.getSession(identity(), 'trace_owner')).actor;
    for (let i = 0; i < 5; i++) await repo.createResponsibility(owner, `pagination_key_000${i}`, draft(`Record ${i}`));
    const first = await repo.listResponsibilities(owner, { limit: 2 });
    const second = await repo.listResponsibilities(owner, { limit: 2, cursor: first.nextCursor! });
    const third = await repo.listResponsibilities(owner, { limit: 2, cursor: second.nextCursor! });
    expect(new Set([...first.items, ...second.items, ...third.items].map(item => item.id)).size).toBe(5);
    expect(third.nextCursor).toBeNull();
    const other = (await repo.getSession(identity('user_b', 'external_org_b'), 'trace_other')).actor;
    await expect(repo.listResponsibilities(other, { cursor: first.nextCursor! })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect((await repo.listResponsibilities(owner, { q: '%' })).items).toHaveLength(0);
  });

  it('clears transaction context on pool reuse and enforces RLS without repository filters', async () => {
    const owner = (await repo.getSession(identity(), 'trace_owner')).actor;
    await repo.createResponsibility(owner, 'pool_clear_key_0001', draft());
    for (let i = 0; i < 5; i++) {
      const client = await runtime.connect();
      try {
        const scope = await client.query<{ actor: string | null; organization: string | null }>(`SELECT
          current_setting('pactwoven.actor_id',true) AS actor, current_setting('pactwoven.organization_id',true) AS organization`);
        expect(scope.rows[0]?.actor || '').toBe('');
        expect(scope.rows[0]?.organization || '').toBe('');
        expect((await client.query('SELECT id FROM pactwoven.responsibilities')).rows).toHaveLength(0);
        await client.query('BEGIN');
        await client.query(`SELECT set_config('pactwoven.environment','development',true),set_config('pactwoven.organization_id','org_b',true),
          set_config('pactwoven.actor_id','actor_b',true),set_config('pactwoven.session_id','session_user_b',true)`);
        expect((await client.query('SELECT id FROM pactwoven.responsibilities')).rows).toHaveLength(0);
        await client.query('COMMIT');
      } finally { client.release(); }
    }
    await expect(runtime.query("UPDATE pactwoven.memberships SET roles=ARRAY['owner']")).rejects.toMatchObject({ code: '42501' });
    await expect(runtime.query('SELECT * FROM pactwoven.session_revocations')).rejects.toMatchObject({ code: '42501' });
    await expect(assertRuntimePool(admin)).rejects.toMatchObject({ code: 'UNSAFE_DATABASE_ROLE' });
  });

  it('onboards a fresh verified organization and creates its first draft without manual membership edits', async () => {
    const verified = newIdentity();
    await expect(repo.getSession(verified, 'trace_not_setup')).rejects.toMatchObject({ code: 'ORGANIZATION_SETUP_REQUIRED', status: 409 });
    const operation = await provisioner.bootstrapOrganization(verified, 'organization_create_0001', bootstrapCommand(), 'trace_bootstrap');
    expect(operation).toMatchObject({ status: 'succeeded', environment: 'development', aggregateVersion: 1, financialState: null });
    const session = await repo.getSession(verified, 'trace_onboarded');
    expect(session.organization).toMatchObject({ id: operation.aggregateId, name: 'New Organization', authorityEpoch: 0 });
    expect(session.actor.roles).toEqual(['owner']);
    expect(session.sites).toHaveLength(1);
    expect(session.sites[0]).toMatchObject({ name: 'First site', timeZone: 'America/Chicago' });
    const draftOperation = await repo.createResponsibility(session.actor, 'first_draft_after_setup_0001', draft('First responsibility', session.sites[0]!.id));
    expect((await repo.getResponsibility(session.actor, draftOperation.aggregateId)).title).toBe('First responsibility');
    const binding = await admin.query('SELECT external_membership_id, grant_basis FROM pactwoven.memberships WHERE environment=$1 AND organization_id=$2', ['development', operation.aggregateId]);
    expect(binding.rows[0]).toEqual({ external_membership_id: verified.externalMembershipId, grant_basis: 'clerk_admin_bootstrap' });
  });

  it('serializes duplicate onboarding and recovers the same operation after a lost response', async () => {
    const verified = newIdentity();
    const key = 'concurrent_bootstrap_0001';
    const operations = await Promise.all(Array.from({ length: 8 }, () => provisioner.bootstrapOrganization(verified, key, bootstrapCommand(), 'trace_duplicate')));
    expect(new Set(operations.map(operation => operation.id)).size).toBe(1);
    expect(await provisioner.bootstrapOrganization(verified, key, bootstrapCommand(), 'trace_lost_response')).toEqual(operations[0]);
    await expect(provisioner.bootstrapOrganization(verified, key, bootstrapCommand('Changed site'), 'trace_conflict'))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', status: 409 });
    await expect(provisioner.bootstrapOrganization(verified, 'different_bootstrap_key_0001', bootstrapCommand(), 'trace_new_key'))
      .rejects.toMatchObject({ code: 'ORGANIZATION_ALREADY_CONFIGURED', status: 409 });
    const counts = await admin.query(`SELECT
      (SELECT count(*)::int FROM pactwoven.organizations WHERE external_organization_id='external_org_new') AS organizations,
      (SELECT count(*)::int FROM pactwoven.memberships WHERE external_subject='user_new') AS memberships,
      (SELECT count(*)::int FROM pactwoven.operations WHERE kind='organization.bootstrap') AS operations,
      (SELECT count(*)::int FROM pactwoven.outbox_events WHERE event_type='organization.bootstrapped') AS outbox`);
    expect(counts.rows[0]).toEqual({ organizations: 1, memberships: 1, operations: 1, outbox: 1 });
  });

  it('rejects non-admins, revoked sessions, existing-organization takeover and changed membership identity', async () => {
    const verified = newIdentity();
    await expect(provisioner.bootstrapOrganization({ ...verified, externalRole: 'org:member' }, 'member_bootstrap_0001', bootstrapCommand(), 'trace_member'))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    await admin.query("INSERT INTO pactwoven.session_revocations(environment,session_id) VALUES ('development',$1)", [verified.sessionId]);
    await expect(provisioner.bootstrapOrganization(verified, 'revoked_session_bootstrap_0001', bootstrapCommand(), 'trace_revoked'))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(repo.getSession(verified, 'trace_no_setup_for_revoked')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await admin.query('TRUNCATE pactwoven.session_revocations');
    await expect(provisioner.bootstrapOrganization(identity('attacker'), 'existing_org_takeover_0001', bootstrapCommand(), 'trace_takeover'))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    const key = 'pin_membership_bootstrap_0001';
    await provisioner.bootstrapOrganization(verified, key, bootstrapCommand(), 'trace_pin');
    for (const changed of [{ ...verified, externalRole: 'org:member' }, { ...verified, externalMembershipId: 'membership_recreated' }]) {
      await expect(repo.getSession(changed, 'trace_changed')).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(provisioner.bootstrapOrganization(changed, key, bootstrapCommand(), 'trace_changed')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    await admin.query("UPDATE pactwoven.memberships SET status='revoked' WHERE external_subject='user_new'");
    await expect(provisioner.bootstrapOrganization(verified, key, bootstrapCommand(), 'trace_no_restore')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(repo.getSession(verified, 'trace_no_restore')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('rolls back organization, owner, site and operation together when onboarding outbox persistence fails', async () => {
    await admin.query(`CREATE FUNCTION pactwoven.reject_bootstrap_event() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.event_type = 'organization.bootstrapped' THEN RAISE EXCEPTION 'Injected outbox failure'; END IF; RETURN NEW; END $$`);
    await admin.query('CREATE TRIGGER reject_bootstrap_event BEFORE INSERT ON pactwoven.outbox_events FOR EACH ROW EXECUTE FUNCTION pactwoven.reject_bootstrap_event()');
    try {
      await expect(provisioner.bootstrapOrganization(newIdentity(), 'rollback_bootstrap_0001', bootstrapCommand(), 'trace_rollback')).rejects.toThrow();
    } finally {
      await admin.query('DROP TRIGGER reject_bootstrap_event ON pactwoven.outbox_events');
      await admin.query('DROP FUNCTION pactwoven.reject_bootstrap_event()');
    }
    const counts = await admin.query(`SELECT
      (SELECT count(*)::int FROM pactwoven.organizations) AS organizations,
      (SELECT count(*)::int FROM pactwoven.memberships) AS memberships,
      (SELECT count(*)::int FROM pactwoven.sites) AS sites,
      (SELECT count(*)::int FROM pactwoven.operations) AS operations,
      (SELECT count(*)::int FROM pactwoven.outbox_events) AS outbox`);
    expect(counts.rows[0]).toEqual({ organizations: 3, memberships: 10, sites: 4, operations: 0, outbox: 0 });
    expect((await provisioner.bootstrapOrganization(newIdentity(), 'rollback_bootstrap_0001', bootstrapCommand(), 'trace_retry')).status).toBe('succeeded');
  });

  it('isolates function-only provisioning from the runtime and direct table access', async () => {
    await expect(assertProvisionerPool(runtime)).rejects.toMatchObject({ code: 'UNSAFE_DATABASE_ROLE' });
    await expect(assertProvisionerPool(admin)).rejects.toMatchObject({ code: 'UNSAFE_DATABASE_ROLE' });
    await expect(assertRuntimePool(provisionerPool)).rejects.toMatchObject({ code: 'UNSAFE_DATABASE_ROLE' });
    await expect(runtime.query('SELECT pactwoven.bootstrap_organization($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
      ['development','test_org','Name','test_user','test_membership','org:admin','test_session','Site','UTC','runtime_bootstrap_0001','0'.repeat(64),'trace_denied']))
      .rejects.toMatchObject({ code: '42501' });
    await expect(runtime.query('SET ROLE pactwoven_provisioner')).rejects.toMatchObject({ code: '42501' });
    await expect(provisionerPool.query('SELECT * FROM pactwoven.memberships')).rejects.toMatchObject({ code: '42501' });
    await expect(provisionerPool.query("INSERT INTO pactwoven.organizations(environment,id,external_organization_id,name) VALUES ('development','forged','forged','Forged')"))
      .rejects.toMatchObject({ code: '42501' });
  });
});
