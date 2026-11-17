import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TLSSocket } from 'node:tls';
import { Socket, createServer } from 'node:net';
import { once } from 'node:events';
import { Pool, type PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hasLoopbackMigrationTransport, hasVerifiedMigrationTls, loadMigrations, migrateDatabase, migrationPoolConfig, migrationStatements, runMigrationsFromEnvironment } from './migrate.js';
const authoredMigrationFiles = ['0001_foundation.sql', '0002_organization_bootstrap.sql', '0003_identity_access.sql',
  '0004_mandate_authority.sql', '0005_access_acceptance.sql', '0006_access_recovery_fences.sql', '0007_finance_provenance.sql',
  '0008_financial_authority_fences.sql', '0009_custody_setup_owner_bindings.sql', '0010_custody_setup_private_reads.sql',
  '0011_financial_policy_authority.sql', '0012_financial_policy_private_reads.sql', '0013_financial_policy_preparation.sql',
  '0014_supplier_identity_versions.sql', '0015_supplier_relationship_authority.sql', '0016_supplier_observer_resolution.sql',
  '0017_managed_postgres_qualification.sql'];
function fixtureDatabaseUrl(source: string): string {
  const url = new URL(source);
  url.password = 'fixture';
  return url.href;
}


const fixtureDirectories: string[] = [];
async function fixture(files: Record<string, string>) {
  const directory = await mkdtemp(join(tmpdir(), 'pactwoven-migration-'));
  fixtureDirectories.push(directory);
  for (const [name, source] of Object.entries(files)) await writeFile(join(directory, name), source);
  return directory;
}
afterEach(async () => { await Promise.all(fixtureDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

describe('development migration validation', () => {
  it('requires a live loopback client socket and rejects remote or socket-shaped transports', async () => {
    expect(hasLoopbackMigrationTransport({ remoteAddress: '127.0.0.1', readyState: 'open', destroyed: false })).toBe(false);
    expect(hasLoopbackMigrationTransport(undefined)).toBe(false);
    const connections = new Set<Socket>();
    const server = createServer(socket => { connections.add(socket); socket.on('close', () => connections.delete(socket)); });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const socket = new Socket();
    try {
      expect(hasLoopbackMigrationTransport(socket)).toBe(false);
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('A loopback TCP listener is required.');
      socket.connect(address.port, '127.0.0.1');
      await once(socket, 'connect');
      expect(hasLoopbackMigrationTransport(socket)).toBe(true);
      for (const remoteAddress of ['192.0.2.1', '::ffff:192.0.2.1', undefined]) {
        Object.defineProperty(socket, 'remoteAddress', { configurable: true, value: remoteAddress });
        expect(hasLoopbackMigrationTransport(socket)).toBe(false);
      }
      Object.defineProperty(socket, 'remoteAddress', { configurable: true, value: '::ffff:127.0.0.1' });
      expect(hasLoopbackMigrationTransport(socket)).toBe(true);
      socket.destroy();
      expect(hasLoopbackMigrationTransport(socket)).toBe(false);
    } finally {
      socket.destroy();
      for (const connection of connections) connection.destroy();
      await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
    }
  });

  it('requires a certificate-authorized TLS transport, not a server-side SSL flag or socket-shaped object', () => {
    expect(hasVerifiedMigrationTls(undefined)).toBe(false);
    expect(hasVerifiedMigrationTls({ encrypted: true, authorized: true })).toBe(false);
    const stream = new TLSSocket(new Socket());
    try {
      expect(hasVerifiedMigrationTls(stream)).toBe(false);
      stream.authorized = true;
      expect(hasVerifiedMigrationTls(stream)).toBe(true);
      stream.authorized = false;
      expect(hasVerifiedMigrationTls(stream)).toBe(false);
    } finally { stream.destroy(); }
  });

  it('constructs explicit loopback or verify-full Neon options without query overrides', () => {
    expect(migrationPoolConfig(fixtureDatabaseUrl('postgres://migration@127.0.0.1:55439/pactwoven_dev'), 'pactwoven_dev'))
      .toMatchObject({ host: '127.0.0.1', port: 55439, database: 'pactwoven_dev', ssl: false });
    const config = migrationPoolConfig(fixtureDatabaseUrl('postgresql://migration@ep-test.us-east-2.aws.neon.tech/pactwoven_dev?sslmode=verify-full'), 'pactwoven_dev');
    expect(config).toMatchObject({ host: 'ep-test.us-east-2.aws.neon.tech', ssl: { rejectUnauthorized: true } });
    expect(config).not.toHaveProperty('connectionString');
    expect(migrationPoolConfig(fixtureDatabaseUrl('postgres://migration@[::1]/pactwoven_migration_test'), 'pactwoven_migration_test')).toMatchObject({ host: '::1' });
  });

  it.each([
    fixtureDatabaseUrl('postgres://migration@127.0.0.1/production'),
    fixtureDatabaseUrl('postgres://migration@127.0.0.1/%70actwoven_dev'),
    fixtureDatabaseUrl('postgres://migration@10.0.0.1/pactwoven_dev'),
    fixtureDatabaseUrl('postgres://migration@neon.tech.attacker.test/pactwoven_dev'),
    fixtureDatabaseUrl('postgres://migration@ep.neon.tech/pactwoven_dev?sslmode=require'),
    fixtureDatabaseUrl('postgres://migration@ep.neon.tech/pactwoven_dev?sslmode=no-verify'),
    fixtureDatabaseUrl('postgres://migration@ep.neon.tech/pactwoven_dev?sslmode=verify-full&sslmode=verify-full'),
    fixtureDatabaseUrl('postgres://migration@ep.neon.tech/pactwoven_dev?sslmode=verify-full&host=attacker.test'),
    fixtureDatabaseUrl('postgres://migration@127.0.0.1/pactwoven_dev?options=-c%20role%3Dpactwoven_runtime'),
    fixtureDatabaseUrl('postgres://migration@127.0.0.1/pactwoven_dev?database=production'),
    fixtureDatabaseUrl('postgres://migration@127.0.0.1/pactwoven_dev#ignored'),
    'postgres://migration@localhost/pactwoven_dev',
  ])('rejects an unsafe target %s', target => {
    expect(() => migrationPoolConfig(target, 'pactwoven_dev')).toThrowError(expect.objectContaining({ code: 'MIGRATION_TARGET_REJECTED' }));
  });

  it('refuses implicit or production database selection and protects DSN file permissions', async () => {
    await expect(runMigrationsFromEnvironment({})).rejects.toMatchObject({ code: 'MIGRATION_CONFIG_REQUIRED' });
    await expect(runMigrationsFromEnvironment({ PACTWOVEN_MIGRATION_DATABASE: 'production', PACTWOVEN_MIGRATION_DATABASE_URL_FILE: 'unused' }))
      .rejects.toMatchObject({ code: 'MIGRATION_CONFIG_REQUIRED' });
    const directory = await fixture({ 'dsn': 'postgres://secret-private-fixture@not-a-target' });
    const file = join(directory, 'dsn');
    await chmod(file, 0o644);
    await expect(runMigrationsFromEnvironment({ PACTWOVEN_MIGRATION_DATABASE: 'pactwoven_dev', PACTWOVEN_MIGRATION_DATABASE_URL_FILE: file }))
      .rejects.toMatchObject({ code: 'MIGRATION_CREDENTIAL_FILE_INVALID' });
  });

  it('removes only the outer transaction pair and preserves comments, strings and nested PL/pgSQL', () => {
    const sql = `-- outer transaction\nBEGIN; /* nested /* comment ; */ still comment */
      CREATE FUNCTION sample() RETURNS text LANGUAGE plpgsql AS $body$
      BEGIN RETURN 'COMMIT; BEGIN;'; END $body$;
      INSERT INTO example(value) VALUES (E'escaped\\\'quote; COMMIT;');
      COMMIT; -- completed`;
    const statements = migrationStatements(sql);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain("BEGIN RETURN 'COMMIT; BEGIN;'; END $body$");
    expect(statements[1]).toContain("E'escaped\\\'quote; COMMIT;'");
  });

  it.each(['\r', '\n', '\r\n'])('terminates line comments at PostgreSQL newline %j', newline => {
    expect(migrationStatements(`SELECT 1;${newline}-- seed${newline}INSERT INTO example VALUES (2);`)).toHaveLength(2);
  });

  it.each(['BEGIN; SELECT 1;', 'SELECT 1; COMMIT;', 'BEGIN; SELECT 1; COMMIT; SELECT 2;',
    'BEGIN; SELECT 1; COMMIT; BEGIN; SELECT 2; COMMIT;', 'ROLLBACK;', 'START TRANSACTION; SELECT 1;',
    "SET standard_conforming_strings='off'; SELECT 1;", '/* unterminated', "SELECT 'unterminated", 'DO $body$ missing'])
  ('rejects unbalanced source or transaction escape: %s', sql => {
    expect(() => migrationStatements(sql)).toThrow();
  });

  it('rejects missing/duplicate numbering before creating a database connection', async () => {
    const gap = await fixture({ '0001_one.sql': 'SELECT 1;', '0003_three.sql': 'SELECT 3;' });
    const duplicate = await fixture({ '0001_one.sql': 'SELECT 1;', '0001_duplicate.sql': 'SELECT 2;' });
    await expect(loadMigrations(gap)).rejects.toMatchObject({ code: 'MIGRATION_ORDER_INVALID' });
    await expect(loadMigrations(duplicate)).rejects.toMatchObject({ code: 'MIGRATION_ORDER_INVALID' });
  });
  it('loads the exact seventeen authored migrations including managed PostgreSQL qualification without a database connection', async () => {
    const migrations = await loadMigrations();
    expect(migrations.map(migration => migration.filename)).toEqual(authoredMigrationFiles);
    expect(migrations.map(migration => migration.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
    for (const migration of migrations) {
      expect(migration.checksum).toMatch(/^[a-f0-9]{64}$/);
      expect(migration.statements.length).toBeGreaterThan(0);
    }
  });
});

const dbSuite = process.env.PACTWOVEN_RUN_MIGRATION_TESTS === '1' ? describe : describe.skip;
dbSuite('development migrations — dedicated real PostgreSQL database', () => {
  let connectionString: string;
  let admin: Pool;
  beforeAll(async () => {
    const file = process.env.PACTWOVEN_MIGRATION_TEST_DATABASE_URL_FILE;
    if (!file) throw new Error('A protected migration test admin DSN file is required.');
    connectionString = (await readFile(file, 'utf8')).trim();
    const config = migrationPoolConfig(connectionString, 'pactwoven_migration_test');
    if (!['127.0.0.1', 'localhost', '::1'].includes(String(config.host))) throw new Error('Tests require the dedicated loopback database.');
    // Two competing writers plus an independent lock observer are required.
    admin = new Pool({ ...config, max: 3 });
    expect((await admin.query('SELECT current_database()')).rows[0].current_database).toBe('pactwoven_migration_test');
    // These cluster roles must be created only by this exclusive migration suite.
    expect((await admin.query("SELECT rolname FROM pg_roles WHERE rolname IN ('pactwoven_supplier_owner','pactwoven_supplier_executor')")).rows).toEqual([]);
  });
  beforeEach(async () => {
    await admin.query('DROP SCHEMA IF EXISTS pactwoven CASCADE');
    await admin.query('DROP SCHEMA IF EXISTS pactwoven_migrations CASCADE');
    // A schema reset does not remove roles created by migration 0015.
    // DROP ROLE has no CASCADE, so unexpected dependencies stop the fixture.
    await admin.query('DROP ROLE IF EXISTS pactwoven_supplier_executor, pactwoven_supplier_owner');
  });
  afterAll(async () => { await admin?.end(); });

  async function seedVersionRows() {
    await admin.query(`INSERT INTO pactwoven.organizations(environment,id,external_organization_id,name,created_at)
      VALUES('simulation','version_a','external_version_a','Version A','2026-01-01T00:00:00Z'),
            ('simulation','version_b','external_version_b','Version B','2026-01-02T00:00:00Z');
      INSERT INTO pactwoven.memberships(environment,organization_id,actor_id,external_subject,roles,created_at)
      VALUES('simulation','version_a','shared_actor','external_subject_a',ARRAY['owner'],'2026-01-03T00:00:00Z'),
            ('simulation','version_b','shared_actor','external_subject_b',ARRAY['owner'],'2026-01-04T00:00:00Z')`);
  }

  it('applies authored migrations once and leaves exact checksum history on retry', async () => {
    const migrations = await loadMigrations();
    const first = await migrateDatabase(connectionString, 'pactwoven_migration_test');
    expect(first.applied).toEqual(authoredMigrationFiles);
    const replay = await migrateDatabase(connectionString, 'pactwoven_migration_test');
    expect(replay).toEqual({ database: 'pactwoven_migration_test', applied: [], skipped: first.applied });
    const rows = await admin.query('SELECT number,filename,checksum FROM pactwoven_migrations.applied_migrations ORDER BY number');
    expect(rows.rows).toEqual(migrations.map(({ number, filename, checksum }) => ({ number, filename, checksum })));
    expect((await admin.query("SELECT to_regprocedure('pactwoven.bootstrap_organization(text,text,text,text,text,text,text,text,text,text,text,text)') AS function")).rows[0].function).not.toBeNull();
  });

  it('rolls back all pending SQL and its journal if a later statement fails', async () => {
    const directory = await fixture({
      '0001_initial.sql': 'BEGIN; CREATE SCHEMA pactwoven; CREATE TABLE pactwoven.example(id integer); COMMIT;',
      '0002_failure.sql': 'BEGIN; INSERT INTO pactwoven.example VALUES (1); SELECT no_such_function(); COMMIT;',
    });
    await expect(migrateDatabase(connectionString, 'pactwoven_migration_test', directory)).rejects.toMatchObject({ code: 'MIGRATION_FAILED' });
    expect((await admin.query("SELECT to_regnamespace('pactwoven') AS application, to_regnamespace('pactwoven_migrations') AS journal")).rows[0])
      .toEqual({ application: null, journal: null });
    await writeFile(join(directory, '0002_failure.sql'), 'BEGIN; INSERT INTO pactwoven.example VALUES (1); COMMIT;');
    expect((await migrateDatabase(connectionString, 'pactwoven_migration_test', directory)).applied).toHaveLength(2);
    expect((await admin.query('SELECT count(*)::int AS count FROM pactwoven.example')).rows[0].count).toBe(1);
  });

  it('rolls back DDL when inserting the checksum journal fails', async () => {
    const directory = await fixture({ '0001_journal_failure.sql': `BEGIN;
      CREATE SCHEMA pactwoven;
      CREATE TABLE pactwoven.example(id integer);
      CREATE FUNCTION pactwoven.reject_journal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Injected journal failure'; END $$;
      CREATE TRIGGER reject_journal BEFORE INSERT ON pactwoven_migrations.applied_migrations FOR EACH ROW EXECUTE FUNCTION pactwoven.reject_journal();
      COMMIT;` });
    await expect(migrateDatabase(connectionString, 'pactwoven_migration_test', directory)).rejects.toMatchObject({ code: 'MIGRATION_FAILED' });
    expect((await admin.query("SELECT to_regnamespace('pactwoven') AS application, to_regnamespace('pactwoven_migrations') AS journal")).rows[0])
      .toEqual({ application: null, journal: null });
  });

  it('rejects checksum drift and missing applied source before executing pending writes', async () => {
    const original = 'CREATE SCHEMA pactwoven; CREATE TABLE pactwoven.example(id integer);';
    const directory = await fixture({ '0001_initial.sql': original });
    await migrateDatabase(connectionString, 'pactwoven_migration_test', directory);
    await writeFile(join(directory, '0001_initial.sql'), `${original}\n-- changed`);
    await writeFile(join(directory, '0002_pending.sql'), 'CREATE TABLE pactwoven.must_not_exist(id integer);');
    await expect(migrateDatabase(connectionString, 'pactwoven_migration_test', directory)).rejects.toMatchObject({ code: 'MIGRATION_CHECKSUM_MISMATCH' });
    expect((await admin.query("SELECT to_regclass('pactwoven.must_not_exist') AS pending")).rows[0].pending).toBeNull();
    await writeFile(join(directory, '0001_initial.sql'), original);
    await migrateDatabase(connectionString, 'pactwoven_migration_test', directory);
    await rm(join(directory, '0002_pending.sql'));
    await expect(migrateDatabase(connectionString, 'pactwoven_migration_test', directory)).rejects.toMatchObject({ code: 'MIGRATION_HISTORY_MISMATCH' });
    expect((await admin.query('SELECT count(*)::int AS count FROM pactwoven_migrations.applied_migrations')).rows[0].count).toBe(2);
  });

  it('rejects a gapped journal and unjournaled application schema', async () => {
    await admin.query('CREATE SCHEMA pactwoven');
    await expect(migrateDatabase(connectionString, 'pactwoven_migration_test')).rejects.toMatchObject({ code: 'MIGRATION_UNJOURNALED_DATABASE' });
    expect((await admin.query("SELECT to_regnamespace('pactwoven_migrations') AS journal")).rows[0].journal).toBeNull();
    await admin.query('DROP SCHEMA pactwoven');
    await migrateDatabase(connectionString, 'pactwoven_migration_test');
    await admin.query('DELETE FROM pactwoven_migrations.applied_migrations WHERE number=1');
    await expect(migrateDatabase(connectionString, 'pactwoven_migration_test')).rejects.toMatchObject({ code: 'MIGRATION_HISTORY_MISMATCH' });
  });

  it('serializes concurrent runners and executes each migration only once', async () => {
    const directory = await fixture({ '0001_concurrent.sql': `BEGIN; CREATE SCHEMA pactwoven;
      CREATE TABLE pactwoven.runs(id integer); INSERT INTO pactwoven.runs VALUES (1);
      DO $$ BEGIN PERFORM pg_sleep(0.15); END $$; COMMIT;` });
    const results = await Promise.all(Array.from({ length: 3 }, () => migrateDatabase(connectionString, 'pactwoven_migration_test', directory)));
    expect(results.map(result => result.applied.length).sort()).toEqual([0, 0, 1]);
    expect((await admin.query('SELECT count(*)::int AS count FROM pactwoven.runs')).rows[0].count).toBe(1);
    expect((await admin.query('SELECT count(*)::int AS count FROM pactwoven_migrations.applied_migrations')).rows[0].count).toBe(1);
  });

  it('executes CR-separated statements after line comments before journaling success', async () => {
    const directory = await fixture({ '0001_carriage_return.sql':
      'CREATE SCHEMA pactwoven; CREATE TABLE pactwoven.example(id integer);\r-- seed\rINSERT INTO pactwoven.example VALUES (1);' });
    expect((await migrateDatabase(connectionString, 'pactwoven_migration_test', directory)).applied).toHaveLength(1);
    expect((await admin.query('SELECT count(*)::int AS count FROM pactwoven.example')).rows[0].count).toBe(1);
  });

  it('refuses to adopt an existing application schema through an empty journal', async () => {
    await admin.query(`CREATE SCHEMA pactwoven; CREATE SCHEMA pactwoven_migrations;
      CREATE TABLE pactwoven_migrations.applied_migrations(number integer PRIMARY KEY, filename text, checksum text)`);
    await expect(migrateDatabase(connectionString, 'pactwoven_migration_test')).rejects.toMatchObject({ code: 'MIGRATION_UNJOURNALED_DATABASE' });
    expect((await admin.query("SELECT to_regclass('pactwoven.organizations') AS organizations")).rows[0].organizations).toBeNull();
  });

  it('adds organization version one without reconstructing history or changing identities, legacy grants or triggers', async () => {
    const priorNames = authoredMigrationFiles.slice(0, 13);
    const targetNames = authoredMigrationFiles.slice(0, 14);
    const priorDirectory = await fixture(Object.fromEntries(await Promise.all(priorNames.map(async name =>
      [name, await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8')] as const))));
    await migrateDatabase(connectionString, 'pactwoven_migration_test', priorDirectory);
    await seedVersionRows();
    await admin.query("UPDATE pactwoven.organizations SET authority_epoch=7 WHERE id='version_a'; UPDATE pactwoven.memberships SET row_version=9 WHERE organization_id='version_a'");
    const organizationsBefore = (await admin.query('SELECT to_jsonb(o) AS body FROM pactwoven.organizations o ORDER BY environment,id')).rows;
    const membershipsBefore = (await admin.query('SELECT to_jsonb(m) AS body FROM pactwoven.memberships m ORDER BY environment,organization_id,actor_id')).rows;
    const legacyBefore = (await admin.query(`SELECT c.relname,c.relacl,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='pactwoven' AND c.relname IN ('organizations','memberships') ORDER BY c.relname`)).rows;
    const rebindingBefore = (await admin.query("SELECT pg_get_functiondef('pactwoven.prevent_member_rebinding()'::regprocedure) AS definition")).rows[0];
    const targetDirectory = await fixture(Object.fromEntries(await Promise.all(targetNames.map(async name =>
      [name, await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8')] as const))));
    const upgraded = await migrateDatabase(connectionString, 'pactwoven_migration_test', targetDirectory);
    expect(upgraded).toEqual({ database: 'pactwoven_migration_test', applied: ['0014_supplier_identity_versions.sql'], skipped: priorNames });
    expect((await admin.query("SELECT to_jsonb(o)-'row_version' AS body FROM pactwoven.organizations o ORDER BY environment,id")).rows).toEqual(organizationsBefore);
    expect((await admin.query('SELECT to_jsonb(m) AS body FROM pactwoven.memberships m ORDER BY environment,organization_id,actor_id')).rows).toEqual(membershipsBefore);
    expect((await admin.query('SELECT row_version FROM pactwoven.organizations ORDER BY id')).rows).toEqual([{ row_version: 1 }, { row_version: 1 }]);
    expect((await admin.query(`SELECT c.relname,c.relacl,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='pactwoven' AND c.relname IN ('organizations','memberships') ORDER BY c.relname`)).rows).toEqual(legacyBefore);
    expect((await admin.query("SELECT pg_get_functiondef('pactwoven.prevent_member_rebinding()'::regprocedure) AS definition")).rows[0]).toEqual(rebindingBefore);
    expect((await admin.query(`INSERT INTO pactwoven.organizations(environment,id,external_organization_id,name)
      VALUES('simulation','version_new','external_version_new','New') RETURNING row_version`)).rows[0].row_version).toBe(1);
  });

  it('advances organization authority changes once and preserves cosmetic/no-op and explicit invalidation semantics', async () => {
    await migrateDatabase(connectionString, 'pactwoven_migration_test');
    await seedVersionRows();
    const where = "WHERE environment='simulation' AND id='version_a'";
    const update = async (set: string) => (await admin.query(`UPDATE pactwoven.organizations SET ${set} ${where} RETURNING row_version`)).rows[0].row_version;
    expect(await update("status='suspended'")).toBe(2);
    expect(await update("status='active',row_version=row_version+1")).toBe(3);
    // The existing epoch policy is unchanged; any epoch change invalidates the row version once.
    expect(await update('authority_epoch=7')).toBe(4);
    expect(await update("external_organization_id='external_version_a_changed'")).toBe(5);
    expect(await update("name='Renamed'")).toBe(5);
    expect(await update('status=status,row_version=row_version,created_at=created_at')).toBe(5);
    expect(await update('row_version=row_version+1')).toBe(6);
    for (const set of ["environment='development'", "id='rebound'", "created_at=created_at+interval '1 second'"]) {
      await expect(update(set)).rejects.toMatchObject({ code: 'PI001' });
    }
    expect((await admin.query(`SELECT row_version,authority_epoch,created_at::text AS created_at FROM pactwoven.organizations ${where}`)).rows[0])
      .toMatchObject({ row_version: 6, authority_epoch: 7 });
    expect((await admin.query("SELECT row_version FROM pactwoven.organizations WHERE id='version_b'")).rows[0].row_version).toBe(1);
  });

  it('versions membership authority changes and null-to-pinned binding once without changing rebinding or site-reissue behavior', async () => {
    await migrateDatabase(connectionString, 'pactwoven_migration_test');
    await seedVersionRows();
    const where = "WHERE environment='simulation' AND organization_id='version_a' AND actor_id='shared_actor'";
    const update = async (set: string) => (await admin.query(`UPDATE pactwoven.memberships SET ${set} ${where} RETURNING row_version`)).rows[0].row_version;
    expect(await update("external_membership_id='pinned_version_a'")).toBe(2);
    expect(await update("roles=ARRAY['owner','finance']")).toBe(3);
    expect(await update("status='suspended',row_version=row_version+1")).toBe(4);
    expect(await update("expires_at='2026-12-01T00:00:00Z'")).toBe(5);
    expect(await update('expires_at=NULL')).toBe(6);
    expect(await update("display_name='Display only'")).toBe(6);
    expect(await update('roles=roles,expires_at=expires_at,row_version=row_version+1')).toBe(7);
    expect(await update("status='revoked',row_version=row_version+1")).toBe(8);
    expect(await update('row_version=row_version,roles=roles,created_at=created_at')).toBe(8);
    for (const set of ["external_membership_id='rebound'", 'external_membership_id=NULL', "external_subject='rebound'", "grant_basis='owner_grant'",
      "environment='development'", "organization_id='version_b'", "actor_id='rebound'"]) {
      await expect(update(set)).rejects.toMatchObject({ code: 'PA001' });
    }
    await expect(update("created_at=created_at+interval '1 second'")).rejects.toMatchObject({ code: 'PI001' });
    expect((await admin.query(`SELECT row_version,status,external_membership_id FROM pactwoven.memberships ${where}`)).rows[0])
      .toEqual({ row_version: 8, status: 'revoked', external_membership_id: 'pinned_version_a' });
    expect((await admin.query("SELECT row_version,external_membership_id FROM pactwoven.memberships WHERE organization_id='version_b' AND actor_id='shared_actor'")).rows[0])
      .toEqual({ row_version: 1, external_membership_id: null });
  });

  it.each(['organizations', 'memberships'] as const)('rejects %s version regression, jumps, null and exhausted increments without partial authority changes', async table => {
    await migrateDatabase(connectionString, 'pactwoven_migration_test');
    await seedVersionRows();
    const where = table === 'organizations' ? "WHERE environment='simulation' AND id='version_a'" :
      "WHERE environment='simulation' AND organization_id='version_a' AND actor_id='shared_actor'";
    await admin.query(`UPDATE pactwoven.${table} SET row_version=row_version+1 ${where}`);
    for (const next of [null, -1, 0, 1, 4, 2147483647]) {
      await expect(admin.query(`UPDATE pactwoven.${table} SET row_version=$1,status='suspended' ${where}`, [next])).rejects.toMatchObject({ code: 'PI001' });
    }
    expect((await admin.query(`SELECT row_version,status FROM pactwoven.${table} ${where}`)).rows[0]).toEqual({ row_version: 2, status: 'active' });
    // Insert isolated boundary rows directly; do not bypass the guard by updating 2 -> MAX.
    await admin.query(`INSERT INTO pactwoven.organizations(environment,id,external_organization_id,name,row_version)
      VALUES('simulation','version_max','external_version_max','Boundary',2147483647);
      INSERT INTO pactwoven.memberships(environment,organization_id,actor_id,external_subject,roles,row_version)
      VALUES('simulation','version_max','max_actor','max_subject',ARRAY['owner'],2147483647)`);
    const maxWhere = table === 'organizations' ? "WHERE environment='simulation' AND id='version_max'" :
      "WHERE environment='simulation' AND organization_id='version_max' AND actor_id='max_actor'";
    expect((await admin.query(`UPDATE pactwoven.${table} SET row_version=row_version ${maxWhere} RETURNING row_version`)).rows[0].row_version).toBe(2147483647);
    await expect(admin.query(`UPDATE pactwoven.${table} SET status='suspended' ${maxWhere}`)).rejects.toMatchObject({ code: 'PI001' });
    await expect(admin.query(`UPDATE pactwoven.${table} SET row_version=row_version+1 ${maxWhere}`)).rejects.toMatchObject({ code: '22003' });
    expect((await admin.query(`SELECT row_version,status FROM pactwoven.${table} ${maxWhere}`)).rows[0]).toEqual({ row_version: 2147483647, status: 'active' });
  });

  it('serializes existing organization-first writers and rejects stale organization/member compare-and-swap after waiting', async () => {
    await migrateDatabase(connectionString, 'pactwoven_migration_test');
    await seedVersionRows();
    let first: PoolClient | undefined, second: PoolClient | undefined;
    let secondSettled = Promise.resolve();
    try {
      first = await admin.connect();
      second = await admin.connect();
      await first.query('BEGIN');
      await first.query("SELECT 1 FROM pactwoven.organizations WHERE id='version_a' FOR UPDATE");
      await first.query("UPDATE pactwoven.memberships SET roles=ARRAY['owner','finance'],row_version=row_version+1 WHERE organization_id='version_a' AND actor_id='shared_actor'");
      await first.query("UPDATE pactwoven.organizations SET authority_epoch=authority_epoch+1 WHERE id='version_a'");
      await second.query("BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='8s'");
      const secondPid = (await second.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
      const waiting = second.query("SELECT row_version FROM pactwoven.organizations WHERE id='version_a' FOR UPDATE")
        .then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
      secondSettled = waiting.then(() => undefined);
      let blocked = false;
      const deadline = Date.now() + 3_000;
      while (!blocked && Date.now() < deadline) {
        blocked = (await admin.query('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked', [secondPid])).rows[0].blocked === true;
      }
      expect(blocked).toBe(true);
      await first.query('COMMIT');
      const observed = await waiting;
      if (!observed.ok) throw observed.error;
      expect(observed.value.rows).toEqual([{ row_version: 2 }]);
      expect((await second.query("UPDATE pactwoven.organizations SET status='suspended',row_version=2 WHERE id='version_a' AND row_version=1 RETURNING row_version")).rows).toEqual([]);
      expect((await second.query("UPDATE pactwoven.memberships SET status='revoked',row_version=2 WHERE organization_id='version_a' AND actor_id='shared_actor' AND row_version=1 RETURNING row_version")).rows).toEqual([]);
      expect((await second.query("UPDATE pactwoven.memberships SET status='suspended',row_version=row_version+1 WHERE organization_id='version_a' AND actor_id='shared_actor' AND row_version=2 RETURNING row_version")).rows)
        .toEqual([{ row_version: 3 }]);
      expect((await second.query("UPDATE pactwoven.organizations SET authority_epoch=authority_epoch+1 WHERE id='version_a' AND row_version=2 RETURNING row_version")).rows)
        .toEqual([{ row_version: 3 }]);
      await second.query('COMMIT');
    } finally {
      await first?.query('ROLLBACK').catch(() => undefined);
      await secondSettled;
      await second?.query('ROLLBACK').catch(() => undefined);
      first?.release(); second?.release();
    }
  });
});
