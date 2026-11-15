import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Socket, createServer } from 'node:net';
import { once } from 'node:events';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { commandDigest } from '@pactwoven/domain';
import type { GrantAccessCommand, MemberCandidate, Operation } from '@pactwoven/contracts';
import { PostgresAccessRepository, assertAccessPool, type AccessMutation, type VerifiedStepUpIdentity } from './access-repository.js';
import { PostgresOrganizationProvisioner, assertProvisionerPool } from './provisioner.js';
import { PostgresFoundationRepository, assertRuntimePool, type VerifiedIdentity } from './repository.js';
import { hasLoopbackMigrationTransport } from './migrate.js';

const suite = process.env.PACTWOVEN_RUN_ACCESS_ACCEPTANCE_TESTS === '1' ? describe : describe.skip;
const baseline = process.env.PACTWOVEN_ACCESS_ACCEPTANCE_BASELINE === '1';
const migration = new URL('../migrations/0005_access_acceptance.sql', import.meta.url);
const mutationSignature = 'pactwoven.change_member_access(text,jsonb,jsonb,jsonb,text,text,jsonb,text,text,text)';
const ownerSignature = 'pactwoven.access_owner(text,jsonb)';
type Outcome<T> = { value: T; error?: never } | { error: unknown; value?: never };
const observe = <T>(promise: Promise<T>): Promise<Outcome<T>> => promise.then(value => ({ value }), error => ({ error }));
const errorCode = (result: Outcome<unknown>) => (result.error as { code?: string } | undefined)?.code;
const iso = (time: number) => new Date(time).toISOString();
type FixtureServer = { address: string; port: number };
type FixtureIdentity = { database: string; server: string | null; port: number | null; role: string; session_role: string };

function validateAcceptanceTargets(urls: readonly URL[]): void {
  if (urls.length !== 4 || urls.some(url => !['postgres:', 'postgresql:'].includes(url.protocol) ||
    url.pathname !== '/pactwoven_backend_test' || !['127.0.0.1', 'localhost'].includes(url.hostname) ||
    !url.port || !url.username || url.search || url.hash)) throw new Error('Acceptance tests require explicit disposable loopback targets without overrides');
  if (urls.some(url => url.host !== urls[0]!.host) || new Set(urls.map(url => decodeURIComponent(url.username))).size !== 4) {
    throw new Error('Four isolated logins on one disposable database required');
  }
}

function verifyAcceptanceConnection(transport: unknown, target: URL, row: FixtureIdentity, adminServer?: FixtureServer): FixtureServer {
  // A loopback Docker port forward can legitimately report a bridge address inside PostgreSQL.
  expect(hasLoopbackMigrationTransport(transport)).toBe(true);
  expect((transport as Socket).remotePort).toBe(Number(target.port));
  expect(row.database).toBe('pactwoven_backend_test');
  expect(row.role).toBe(decodeURIComponent(target.username));
  expect(row.session_role).toBe(row.role);
  expect(row.server).toEqual(expect.any(String));
  expect(Number.isInteger(row.port) && row.port! > 0 && row.port! <= 65535).toBe(true);
  const server = { address: row.server!, port: row.port! };
  if (adminServer) expect(server).toEqual(adminServer);
  return server;
}

describe('access-acceptance fixture boundary without PostgreSQL', () => {
  const targets = () => ['admin', 'runtime', 'bootstrap', 'access'].map(role => new URL(`postgresql://${role}@127.0.0.1:55440/pactwoven_backend_test`));
  it('requires four distinct logins on an explicit loopback target without driver overrides', () => {
    expect(() => validateAcceptanceTargets(targets())).not.toThrow();
    for (const change of ['scheme', 'database', 'host', 'port', 'query', 'fragment', 'login', 'duplicate', 'mixed', 'missing']) {
      const urls = targets();
      if (change === 'scheme') urls[0] = new URL('https://admin@127.0.0.1:55440/pactwoven_backend_test');
      if (change === 'database') urls[0]!.pathname = '/pactwoven_dev';
      if (change === 'host') urls[0]!.hostname = '172.18.0.2';
      if (change === 'port') urls[0]!.port = '';
      if (change === 'query') urls[0]!.search = '?host=172.18.0.2';
      if (change === 'fragment') urls[0]!.hash = '#override';
      if (change === 'login') urls[0]!.username = '';
      if (change === 'duplicate') urls[0]!.username = '%72untime';
      if (change === 'mixed') urls[0]!.port = '55439';
      if (change === 'missing') urls.pop();
      expect(() => validateAcceptanceTargets(urls), change).toThrow();
    }
  });
  it('accepts a container server only through a real matching loopback transport and exact database/login/server identity', async () => {
    const connections = new Set<Socket>();
    const server = createServer(socket => { connections.add(socket); socket.on('close', () => connections.delete(socket)); });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const socket = new Socket();
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('A loopback TCP listener is required.');
      socket.connect(address.port, '127.0.0.1'); await once(socket, 'connect');
      const target = targets()[0]!; target.port = String(address.port);
      const row: FixtureIdentity = { database: 'pactwoven_backend_test', server: '172.18.0.2', port: 5432, role: 'admin', session_role: 'admin' };
      const verified = verifyAcceptanceConnection(socket, target, row);
      expect(verified).toEqual({ address: '172.18.0.2', port: 5432 });
      expect(() => verifyAcceptanceConnection(socket, target, row, verified)).not.toThrow();
      for (const changed of [{ database: 'pactwoven_dev' }, { role: 'other' }, { session_role: 'other' }, { server: null }, { port: null }, { port: 0 }]) {
        expect(() => verifyAcceptanceConnection(socket, target, { ...row, ...changed })).toThrow();
      }
      expect(() => verifyAcceptanceConnection(socket, target, row, { ...verified, address: '172.18.0.3' })).toThrow();
      expect(() => verifyAcceptanceConnection(socket, target, row, { ...verified, port: 5433 })).toThrow();
      const wrongPort = new URL(target); wrongPort.port = String(address.port === 65535 ? address.port - 1 : address.port + 1);
      expect(() => verifyAcceptanceConnection(socket, wrongPort, row)).toThrow();
      expect(() => verifyAcceptanceConnection({ remoteAddress: '127.0.0.1', remotePort: address.port }, target, row)).toThrow();
      Object.defineProperty(socket, 'remoteAddress', { configurable: true, value: '172.18.0.2' });
      expect(() => verifyAcceptanceConnection(socket, target, row)).toThrow();
      Object.defineProperty(socket, 'remoteAddress', { configurable: true, value: '127.0.0.1' });
      socket.destroy(); expect(() => verifyAcceptanceConnection(socket, target, row)).toThrow();
    } finally {
      socket.destroy(); for (const connection of connections) connection.destroy();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});

function identity(subject = 'owner_a', organization = 'clerk_org_a'): VerifiedIdentity {
  return { subject, externalOrganizationId: organization, externalOrganizationName: organization,
    externalMembershipId: `membership_${subject}`, externalRole: subject.startsWith('owner') ? 'org:admin' : 'org:member',
    sessionId: `session_${subject}`, authenticatedAt: iso(Date.now() - 3_600_000), membershipObservedAt: iso(Date.now()) };
}
function proof(actor = identity()): VerifiedStepUpIdentity {
  const issued = Math.floor(Date.now() / 1000) * 1000;
  return { identity: actor, evidence: { id: crypto.randomUUID(), purpose: 'member_access', subject: actor.subject,
    externalOrganizationId: actor.externalOrganizationId, externalMembershipId: actor.externalMembershipId, sessionId: actor.sessionId,
    issuer: 'https://fixture.clerk.accounts.dev', tokenHash: 'a'.repeat(64), tokenIssuedAt: iso(issued),
    firstFactorAgeMinutes: 0, secondFactorAgeMinutes: 0, verifiedAt: iso(issued - 60_000), observedAt: iso(Date.now()), expiresAt: iso(issued + 60_000) } };
}
function candidate(subject = 'finance_a'): MemberCandidate {
  return { externalOrganizationId: 'clerk_org_a', externalMembershipId: `membership_${subject}`, externalSubject: subject,
    displayName: subject, externalRole: 'org:member', observedAt: iso(Date.now()) };
}

suite('AUTH-02B member-access acceptance on isolated PostgreSQL', () => {
  let admin: Pool, runtime: Pool, bootstrap: Pool, access: Pool;
  let repo: PostgresAccessRepository, foundation: PostgresFoundationRepository, provisioner: PostgresOrganizationProvisioner;
  let organizationId: string, ownerId: string, siteId: string;
  let originalCatalog: unknown, originalTables: unknown, originalMigrationHashes: string[];
  const originalFiles = ['0001_foundation.sql', '0002_organization_bootstrap.sql', '0003_identity_access.sql'];

  function grant(subject = 'finance_a', epoch = 0): AccessMutation & { kind: 'grant'; command: GrantAccessCommand; target: MemberCandidate } {
    return { kind: 'grant', target: candidate(subject), command: { expectedVersion: 0, mandateVersion: null, authorityEpoch: epoch,
      payload: { externalMembershipId: `membership_${subject}`, externalSubject: subject, roles: ['finance'], siteIds: [], actionSiteIds: [siteId], expiresAt: null } } };
  }
  const add = (subject = 'finance_a', epoch = 0) => repo.changeAccess(proof(), `grant_${subject}_request_0001`, grant(subject, epoch), 'acceptance_test');
  const repository = (client: PoolClient) => new PostgresAccessRepository(client as unknown as Pool, 'development');
  async function now(): Promise<number> {
    return Date.parse((await admin.query<{ at: string }>('SELECT clock_timestamp()::text AS at')).rows[0]!.at);
  }
  async function until(check: () => Promise<boolean>, message: string): Promise<void> {
    const limit = Date.now() + 3500;
    while (!(await check())) {
      if (Date.now() > limit) throw new Error(message);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  const past = (deadline: number) => until(async () => (await now()) > deadline + 10, 'Database deadline did not pass');
  const pid = async (client: PoolClient) => (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  async function blockedBy(waiter: number, blocker: number): Promise<void> {
    await until(async () => (await admin.query<{ waiting: boolean }>('SELECT $2::int=ANY(pg_blocking_pids($1)) AS waiting', [waiter, blocker])).rows[0]!.waiting,
      'Expected database lock ordering was not observed');
  }
  async function snapshot(): Promise<unknown> {
    return (await admin.query(`SELECT jsonb_build_object(
      'organization',(SELECT to_jsonb(o) FROM pactwoven.organizations o WHERE id=$1),
      'members',(SELECT jsonb_agg(to_jsonb(m) ORDER BY actor_id) FROM pactwoven.memberships m WHERE organization_id=$1),
      'sites',(SELECT jsonb_agg(to_jsonb(s) ORDER BY actor_id,site_id) FROM pactwoven.site_memberships s WHERE organization_id=$1),
      'actions',(SELECT jsonb_agg(to_jsonb(s) ORDER BY actor_id,site_id) FROM pactwoven.member_action_sites s WHERE organization_id=$1),
      'operations',(SELECT jsonb_agg(to_jsonb(o) ORDER BY id) FROM pactwoven.operations o WHERE organization_id=$1),
      'history',(SELECT jsonb_agg(to_jsonb(h) ORDER BY id) FROM pactwoven.member_access_history h WHERE organization_id=$1),
      'outbox',(SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM pactwoven.outbox_events e WHERE organization_id=$1)) AS state`, [organizationId])).rows[0].state;
  }
  async function functionCatalog(): Promise<unknown> {
    return (await admin.query(`SELECT oid::regprocedure::text AS signature,proacl::text,prosecdef,proconfig
      FROM pg_catalog.pg_proc WHERE oid IN ($1::regprocedure,$2::regprocedure) ORDER BY oid::regprocedure::text`, [ownerSignature, mutationSignature])).rows;
  }
  async function tableCatalog(): Promise<unknown> {
    return (await admin.query(`SELECT c.relname,a.attname,pg_catalog.format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
      WHERE n.nspname='pactwoven' AND c.relkind='r' ORDER BY c.relname,a.attnum`)).rows;
  }
  async function rawChange(client: PoolClient, verified: VerifiedStepUpIdentity, key: string, mutation: AccessMutation): Promise<Operation> {
    const actorId = mutation.kind === 'grant' ? null : mutation.actorId;
    const hash = await commandDigest({ schemaVersion: 1, kind: `member.${mutation.kind}`, environment: 'development',
      externalOrganizationId: verified.identity.externalOrganizationId, subject: verified.identity.subject, actorId, command: mutation.command });
    const result = await client.query<{ response: Operation }>('SELECT pactwoven.change_member_access($1,$2::jsonb,$3::jsonb,$4::jsonb,$5,$6,$7::jsonb,$8,$9,$10) AS response',
      ['development', JSON.stringify(verified.identity), JSON.stringify(verified.evidence), JSON.stringify(mutation.target), mutation.kind, actorId,
        JSON.stringify(mutation.command), key, hash, 'acceptance_test']);
    return result.rows[0]!.response;
  }
  async function afterBarrier(table: 'member_access_history' | 'outbox_events' | 'member_action_sites', verified: VerifiedStepUpIdentity,
    mutation: AccessMutation, key: string, whileBlocked: (consumerPid: number) => Promise<void>): Promise<Outcome<Operation>> {
    const holder = await admin.connect(), consumer = await access.connect();
    let pending: Promise<Outcome<Operation>> | undefined;
    try {
      const holderPid = await pid(holder), consumerPid = await pid(consumer);
      await holder.query('BEGIN'); await holder.query(`LOCK TABLE pactwoven.${table} IN ACCESS EXCLUSIVE MODE`);
      pending = observe(repository(consumer).changeAccess(verified, key, mutation, 'acceptance_test'));
      await blockedBy(consumerPid, holderPid); await whileBlocked(consumerPid);
      await holder.query('COMMIT'); return await pending;
    } finally {
      await holder.query('ROLLBACK'); if (pending) await pending;
      holder.release(); consumer.release();
    }
  }

  beforeAll(async () => {
    const names = ['PACTWOVEN_TEST_ADMIN_DATABASE_URL_FILE', 'PACTWOVEN_TEST_DATABASE_URL_FILE', 'PACTWOVEN_TEST_PROVISIONER_DATABASE_URL_FILE', 'PACTWOVEN_TEST_ACCESS_DATABASE_URL_FILE'];
    const urls = await Promise.all(names.map(async name => {
      const file = process.env[name]; if (!file) throw new Error('Explicit protected acceptance-test DSN files are required');
      const url = new URL((await readFile(file, 'utf8')).trim());
      return url;
    }));
    validateAcceptanceTargets(urls);
    [admin, runtime, bootstrap, access] = urls.map(url => new Pool({ connectionString: url.href, max: 6, statement_timeout: 5000 })) as [Pool, Pool, Pool, Pool];
    let adminServer: FixtureServer | undefined;
    for (const [index, pool] of [admin, runtime, bootstrap, access].entries()) {
      const client = await pool.connect();
      try {
        const transport = (client as PoolClient & { connection?: { stream?: unknown } }).connection?.stream;
        const row = (await client.query<FixtureIdentity>(`SELECT pg_catalog.current_database() AS database,pg_catalog.host(pg_catalog.inet_server_addr()) AS server,
          pg_catalog.inet_server_port() AS port,current_user AS role,session_user AS session_role`)).rows[0]!;
        const server = verifyAcceptanceConnection(transport, urls[index]!, row, adminServer);
        if (index === 0) adminServer = server;
      } finally { client.release(); }
    }
    originalMigrationHashes = await Promise.all(originalFiles.map(async file => createHash('sha256').update(await readFile(new URL(`../migrations/${file}`, import.meta.url))).digest('hex')));
    await admin.query('DROP SCHEMA IF EXISTS pactwoven CASCADE');
    for (const file of originalFiles) await admin.query(await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
    for (const [index, role] of [[1, 'pactwoven_runtime'], [2, 'pactwoven_provisioner'], [3, 'pactwoven_access_provisioner']] as const) {
      const result = await admin.query("SELECT format('GRANT %I TO %I',$1::text,$2::text) AS sql", [role, decodeURIComponent(urls[index]!.username)]);
      await admin.query(result.rows[0].sql);
    }
    originalCatalog = await functionCatalog(); originalTables = await tableCatalog();
    if (!baseline) await admin.query(await readFile(migration, 'utf8'));
    await assertRuntimePool(runtime); await assertProvisionerPool(bootstrap); await assertAccessPool(access);
    repo = new PostgresAccessRepository(access, 'development'); foundation = new PostgresFoundationRepository(runtime, 'development');
    provisioner = new PostgresOrganizationProvisioner(bootstrap, 'development');
  });
  beforeEach(async () => {
    await admin.query('TRUNCATE pactwoven.organizations,pactwoven.session_revocations CASCADE');
    await provisioner.bootstrapOrganization(identity(), 'bootstrap_acceptance_0001', { expectedVersion: 0, mandateVersion: null, authorityEpoch: null,
      payload: { initialSite: { name: 'Acceptance test site', timeZone: 'UTC' } } }, 'acceptance_test');
    const session = await foundation.getSession(identity(), 'acceptance_test');
    organizationId = session.organization.id; ownerId = session.actor.actorId; siteId = session.sites[0]!.id;
  });
  afterAll(async () => { await Promise.all([admin?.end(), runtime?.end(), bootstrap?.end(), access?.end()]); });

  it('preserves function signatures, definer settings, ACLs, table schema and immutable migration bytes', async () => {
    expect(await functionCatalog()).toEqual(originalCatalog); expect(await tableCatalog()).toEqual(originalTables);
    expect(await Promise.all(originalFiles.map(async file => createHash('sha256').update(await readFile(new URL(`../migrations/${file}`, import.meta.url))).digest('hex')))).toEqual(originalMigrationHashes);
    for (const pool of [access, runtime, bootstrap]) {
      await expect(pool.query("SELECT pactwoven.access_owner('development',$1)", [JSON.stringify(identity())])).rejects.toMatchObject({ code: '42501' });
      await expect(pool.query("INSERT INTO pactwoven.session_revocations(environment,session_id) VALUES('development','blocked')")).rejects.toMatchObject({ code: '42501' });
    }
    for (const pool of [runtime, bootstrap]) await expect(pool.query(`SELECT ${mutationSignature.split('(')[0]}('development','{}','{}',NULL,'grant',NULL,'{}','key','hash','trace')`)).rejects.toMatchObject({ code: '42501' });
    const publicRights = await admin.query(`SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p, LATERAL pg_catalog.aclexplode(p.proacl) a
      WHERE p.oid IN ($1::regprocedure,$2::regprocedure) AND a.grantee=0 AND a.privilege_type='EXECUTE') AS allowed`, [ownerSignature, mutationSignature]);
    expect(publicRights.rows[0].allowed).toBe(false);
  });

  it('keeps the locked owner expiry private and public reads unchanged', async () => {
    const context = (await admin.query("SELECT pactwoven.access_owner('development',$1) AS context", [JSON.stringify(identity())])).rows[0].context;
    expect(context).toHaveProperty('ownerExpiresAt', null);
    const page = await repo.listMembers(identity(), { limit: 25 });
    expect(Object.keys(page).sort()).toEqual(['authorityEpoch', 'items', 'nextCursor', 'observedAt']);
    expect(JSON.stringify(page)).not.toContain('ownerExpiresAt');
    expect(JSON.stringify(await add())).not.toContain('ownerExpiresAt');
  });

  it('keeps successful grant, revise and revoke atomic with current public schemas', async () => {
    const first = await add();
    const revised = await repo.changeAccess(proof(), 'revise_acceptance_0001', { kind: 'revise', actorId: first.aggregateId,
      command: { expectedVersion: 1, mandateVersion: null, authorityEpoch: 1, payload: { roles: ['operations'], siteIds: [siteId], actionSiteIds: [siteId], expiresAt: null } }, target: candidate() }, 'acceptance_test');
    expect(revised.aggregateVersion).toBe(2);
    const revoked = await repo.changeAccess(proof(), 'revoke_acceptance_0001', { kind: 'revoke', actorId: first.aggregateId,
      command: { expectedVersion: 2, mandateVersion: null, authorityEpoch: 2, payload: { reason: 'End test access' } }, target: null }, 'acceptance_test');
    expect(revoked.aggregateVersion).toBe(3); expect(revoked.financialState).toBeNull();
    expect((await repo.listMembers(identity(), { limit: 25 })).authorityEpoch).toBe(3);
    const counts = (await admin.query("SELECT (SELECT count(*) FROM pactwoven.member_access_history)::int AS history,(SELECT count(*) FROM pactwoven.operations WHERE kind LIKE 'member.%')::int AS operations,(SELECT count(*) FROM pactwoven.outbox_events WHERE event_type='member.access_changed')::int AS events")).rows[0];
    expect(counts).toEqual({ history: 3, operations: 3, events: 3 });
  });

  for (const fact of ['owner expiry', 'owner receipt', 'target receipt', 'MFA receipt', 'requested expiry', 'MFA expiry', 'factor expiry'] as const) {
    it(`rejects ${fact} crossing during the final outbox wait and rolls back every effect`, async () => {
      const verified = proof(), mutation = grant(), deadline = (await now()) + 650;
      if (fact === 'owner expiry') await admin.query('UPDATE pactwoven.memberships SET expires_at=$1 WHERE actor_id=$2', [iso(deadline), ownerId]);
      if (fact === 'owner receipt') verified.identity.membershipObservedAt = iso(deadline - 20_000);
      if (fact === 'target receipt') mutation.target.observedAt = iso(deadline - 20_000);
      if (fact === 'MFA receipt') verified.evidence.observedAt = iso(deadline - 20_000);
      if (fact === 'requested expiry') mutation.command.payload.expiresAt = iso(deadline);
      if (fact === 'MFA expiry') verified.evidence.expiresAt = iso(deadline);
      if (fact === 'factor expiry') {
        verified.evidence.tokenIssuedAt = iso(deadline - 240_000);
        verified.evidence.verifiedAt = iso(deadline - 300_000); verified.evidence.expiresAt = iso(deadline);
      }
      const before = await snapshot();
      const result = await afterBarrier('outbox_events', verified, mutation, `deadline_${fact.replaceAll(' ', '_')}_0001`, async () => past(deadline));
      expect(errorCode(result)).toBe(fact.startsWith('MFA') || fact === 'factor expiry' ? 'STEP_UP_REQUIRED' : fact === 'requested expiry' ? 'VALIDATION_FAILED' : 'FORBIDDEN');
      expect(await snapshot()).toEqual(before);
    });
  }

  for (const kind of ['revise', 'revoke'] as const) {
    it(`rejects expired owner authority after the ${kind} target-row wait`, async () => {
      const first = await add(), deadline = (await now()) + 650;
      await admin.query('UPDATE pactwoven.memberships SET expires_at=$1 WHERE actor_id=$2', [iso(deadline), ownerId]);
      const before = await snapshot(), holder = await admin.connect(), consumer = await access.connect();
      let pending: Promise<Outcome<Operation>> | undefined;
      try {
        await holder.query('BEGIN'); await holder.query('SELECT actor_id FROM pactwoven.memberships WHERE actor_id=$1 FOR UPDATE', [first.aggregateId]);
        const mutation: AccessMutation = kind === 'revoke' ? { kind, actorId: first.aggregateId, target: null,
          command: { expectedVersion: 1, mandateVersion: null, authorityEpoch: 1, payload: { reason: 'End access' } } }
          : { kind, actorId: first.aggregateId, target: candidate(), command: { expectedVersion: 1, mandateVersion: null, authorityEpoch: 1,
            payload: { roles: ['operations'], siteIds: [siteId], actionSiteIds: [], expiresAt: null } } };
        const consumerPid = await pid(consumer), holderPid = await pid(holder);
        pending = observe(repository(consumer).changeAccess(proof(), `target_wait_${kind}_0001`, mutation, 'acceptance_test'));
        await blockedBy(consumerPid, holderPid); await past(deadline); await holder.query('COMMIT');
        expect(errorCode(await pending)).toBe('FORBIDDEN'); expect(await snapshot()).toEqual(before);
      } finally { await holder.query('ROLLBACK'); if (pending) await pending; holder.release(); consumer.release(); }
    });
  }

  it('rechecks MFA after history INSERT waits, beyond the former final MFA guard', async () => {
    const verified = proof(), deadline = (await now()) + 650; verified.evidence.expiresAt = iso(deadline);
    const before = await snapshot();
    const result = await afterBarrier('member_access_history', verified, grant(), 'history_deadline_0001', async () => past(deadline));
    expect(errorCode(result)).toBe('STEP_UP_REQUIRED'); expect(await snapshot()).toEqual(before);
  });

  for (const expired of [false, true]) {
    it(`holds session-revocation INSERT until the earlier command ${expired ? 'rolls back' : 'commits'}`, async () => {
      const revoker = await admin.connect(), verified = proof();
      const deadline = (await now()) + 800; if (expired) verified.evidence.expiresAt = iso(deadline);
      const before = await snapshot(); let insertion: Promise<Outcome<unknown>> | undefined;
      try {
        const revokerPid = await pid(revoker);
        const result = await afterBarrier('member_access_history', verified, grant(), 'session_consumer_0001', async consumerPid => {
          insertion = observe(revoker.query("INSERT INTO pactwoven.session_revocations(environment,session_id) VALUES('development',$1)", [verified.identity.sessionId]));
          await blockedBy(revokerPid, consumerPid);
          if (expired) await past(deadline);
        });
        if (expired) { expect(errorCode(result)).toBe('STEP_UP_REQUIRED'); expect(await snapshot()).toEqual(before); }
        else expect(result.value?.status).toBe('succeeded');
        expect((await insertion!)?.error).toBeUndefined();
        await expect(repo.changeAccess(proof(), 'after_session_revoke_0001', grant('finance_b', expired ? 0 : 1), 'acceptance_test')).rejects.toMatchObject({ code: 'FORBIDDEN' });
      } finally { if (insertion) await insertion; revoker.release(); }
    });
  }

  it('waits for a prior session INSERT, then rejects without any access effects', async () => {
    const revoker = await admin.connect(), consumer = await access.connect(), before = await snapshot();
    let pending: Promise<Outcome<Operation>> | undefined;
    try {
      const revokerPid = await pid(revoker), consumerPid = await pid(consumer);
      await revoker.query('BEGIN'); await revoker.query("INSERT INTO pactwoven.session_revocations(environment,session_id) VALUES('development',$1)", [identity().sessionId]);
      pending = observe(repository(consumer).changeAccess(proof(), 'prior_session_revoke_0001', grant(), 'acceptance_test'));
      await blockedBy(consumerPid, revokerPid); await revoker.query('COMMIT');
      expect(errorCode(await pending)).toBe('FORBIDDEN'); expect(await snapshot()).toEqual(before);
    } finally { await revoker.query('ROLLBACK'); if (pending) await pending; revoker.release(); consumer.release(); }
  });

  it('revalidates owner expiry after waiting for an unrelated revocation-table writer', async () => {
    const revoker = await admin.connect(), consumer = await access.connect(), deadline = (await now()) + 650;
    await admin.query('UPDATE pactwoven.memberships SET expires_at=$1 WHERE actor_id=$2', [iso(deadline), ownerId]);
    const before = await snapshot(); let pending: Promise<Outcome<Operation>> | undefined;
    try {
      const revokerPid = await pid(revoker), consumerPid = await pid(consumer);
      await revoker.query('BEGIN'); await revoker.query("INSERT INTO pactwoven.session_revocations(environment,session_id) VALUES('development','unrelated_session')");
      pending = observe(repository(consumer).changeAccess(proof(), 'unrelated_revoke_wait_0001', grant(), 'acceptance_test'));
      await blockedBy(consumerPid, revokerPid); await past(deadline); await revoker.query('COMMIT');
      expect(errorCode(await pending)).toBe('FORBIDDEN'); expect(await snapshot()).toEqual(before);
    } finally { await revoker.query('ROLLBACK'); if (pending) await pending; revoker.release(); consumer.release(); }
  });

  it('rejects a completed session revocation and isolates environment and session keys', async () => {
    await admin.query("INSERT INTO pactwoven.session_revocations(environment,session_id) VALUES('simulation',$1),('development','other_session')", [identity().sessionId]);
    expect((await add()).status).toBe('succeeded');
    const before = await snapshot();
    await admin.query("INSERT INTO pactwoven.session_revocations(environment,session_id) VALUES('development',$1)", [identity().sessionId]);
    await expect(add('finance_b', 1)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(repo.getOperation(identity(), { kind: 'grant', key: 'grant_finance_a_request_0001' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await snapshot()).toEqual(before);
  });

  it('returns an exact historical SQL replay before new-effect deadlines and keeps GET recovery available', async () => {
    const client = await access.connect(), mutation = grant(), deadline = (await now()) + 650;
    mutation.command.payload.expiresAt = iso(deadline);
    try {
      const first = await rawChange(client, proof(), 'historical_expiry_0001', mutation); await past(deadline);
      mutation.target.observedAt = iso((await now()) - 21_000);
      const before = await snapshot();
      expect((await rawChange(client, proof(), 'historical_expiry_0001', mutation)).id).toBe(first.id);
      expect((await repo.getOperation(identity(), { kind: 'grant', key: 'historical_expiry_0001' })).id).toBe(first.id);
      await expect(repo.getOperation(identity(), { kind: 'grant', key: 'missing_original_key_0001' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      const expiredProof = proof(); expiredProof.evidence.expiresAt = iso((await now()) - 1);
      await expect(rawChange(client, expiredProof, 'historical_expiry_0001', mutation)).rejects.toMatchObject({ code: 'PA005' });
      expect(await snapshot()).toEqual(before);
    } finally { client.release(); }
  });

  it('preserves changed hash/actor rejection and authorized-owner historical GET', async () => {
    const first = await add();
    const ownerMutation = grant('owner_b', 1); ownerMutation.command.payload.roles = ['owner'];
    await repo.changeAccess(proof(), 'grant_owner_b_request_0001', ownerMutation, 'acceptance_test');
    const before = await snapshot(), changed = grant(); changed.command.payload.roles = ['operations']; changed.command.payload.siteIds = [siteId];
    await expect(repo.changeAccess(proof(), 'grant_finance_a_request_0001', changed, 'acceptance_test')).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(repo.changeAccess(proof(identity('owner_b')), 'grant_finance_a_request_0001', grant(), 'acceptance_test')).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect((await repo.getOperation(identity('owner_b'), { kind: 'grant', key: 'grant_finance_a_request_0001' })).id).toBe(first.id);
    expect((await repo.changeAccess(proof(), 'grant_finance_a_request_0001', grant(), 'acceptance_test')).id).toBe(first.id);
    await expect(repo.getOperation(identity('finance_a'), { kind: 'grant', key: 'grant_finance_a_request_0001' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(repo.getOperation(identity('owner_a', 'foreign_org'), { kind: 'grant', key: 'grant_finance_a_request_0001' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await snapshot()).toEqual(before);
  });

  it('keeps competing commands and genuine owner revocation ordered by the organization lock', async () => {
    const ownerMutation = grant('owner_b'); ownerMutation.command.payload.roles = ['owner'];
    const owner = await repo.changeAccess(proof(), 'grant_owner_b_request_0001', ownerMutation, 'acceptance_test');
    const holder = await admin.connect(), revoker = await access.connect(), consumer = await access.connect();
    let revoke: Promise<Outcome<Operation>> | undefined, command: Promise<Outcome<Operation>> | undefined;
    try {
      const holderPid = await pid(holder), revokerPid = await pid(revoker), consumerPid = await pid(consumer);
      await holder.query('BEGIN'); await holder.query('SELECT id FROM pactwoven.organizations WHERE id=$1 FOR UPDATE', [organizationId]);
      revoke = observe(repository(revoker).changeAccess(proof(), 'revoke_owner_b_request_0001', { kind: 'revoke', actorId: owner.aggregateId, target: null,
        command: { expectedVersion: 1, mandateVersion: null, authorityEpoch: 1, payload: { reason: 'End owner access' } } }, 'acceptance_test'));
      await blockedBy(revokerPid, holderPid);
      command = observe(repository(consumer).changeAccess(proof(identity('owner_b')), 'revoked_owner_grant_0001', grant('finance_b', 1), 'acceptance_test'));
      await until(async () => {
        const blockers = (await admin.query<{ blockers: number[] }>('SELECT pg_blocking_pids($1) AS blockers', [consumerPid])).rows[0]!.blockers;
        return blockers.includes(holderPid) || blockers.includes(revokerPid);
      }, 'Owner command did not queue behind the pending revoke');
      await holder.query('COMMIT');
      expect((await revoke).value?.status).toBe('succeeded'); expect(errorCode(await command)).toBe('FORBIDDEN');
      const competing = await Promise.allSettled([add('finance_a', 2), add('finance_b', 2)]);
      expect(competing.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      expect(competing.filter(result => result.status === 'rejected')).toHaveLength(1);
    } finally { await holder.query('ROLLBACK'); if (revoke) await revoke; if (command) await command; holder.release(); revoker.release(); consumer.release(); }
  });

  it('retains atomic rollback after an injected outbox failure', async () => {
    const before = await snapshot();
    await admin.query("CREATE FUNCTION pactwoven.fail_acceptance_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected acceptance test failure'; END $$; CREATE TRIGGER fail_acceptance_test BEFORE INSERT ON pactwoven.outbox_events FOR EACH ROW EXECUTE FUNCTION pactwoven.fail_acceptance_test()");
    try { await expect(add()).rejects.toBeDefined(); }
    finally { await admin.query('DROP TRIGGER fail_acceptance_test ON pactwoven.outbox_events; DROP FUNCTION pactwoven.fail_acceptance_test()'); }
    expect(await snapshot()).toEqual(before);
  });

  for (const fact of ['owner receipt', 'target receipt', 'MFA receipt', 'token issue'] as const) {
    it(`rejects future ${fact} without effects`, async () => {
      const verified = proof(), mutation = grant(), future = iso((await now()) + 60_000), before = await snapshot();
      if (fact === 'owner receipt') verified.identity.membershipObservedAt = future;
      if (fact === 'target receipt') mutation.target.observedAt = future;
      if (fact === 'MFA receipt') verified.evidence.observedAt = future;
      if (fact === 'token issue') verified.evidence.tokenIssuedAt = future;
      await expect(repo.changeAccess(verified, `future_${fact.replaceAll(' ', '_')}_0001`, mutation, 'acceptance_test')).rejects.toMatchObject({ code: fact === 'owner receipt' || fact === 'target receipt' ? 'FORBIDDEN' : 'STEP_UP_REQUIRED' });
      expect(await snapshot()).toEqual(before);
    });
  }
});
