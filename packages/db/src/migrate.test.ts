import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TLSSocket } from 'node:tls';
import { Socket } from 'node:net';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hasVerifiedMigrationTls, loadMigrations, migrateDatabase, migrationPoolConfig, migrationStatements, runMigrationsFromEnvironment } from './migrate.js';
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
    admin = new Pool(config);
    expect((await admin.query('SELECT current_database()')).rows[0].current_database).toBe('pactwoven_migration_test');
  });
  beforeEach(async () => {
    await admin.query('DROP SCHEMA IF EXISTS pactwoven CASCADE');
    await admin.query('DROP SCHEMA IF EXISTS pactwoven_migrations CASCADE');
  });
  afterAll(async () => { await admin?.end(); });

  it('applies authored migrations once and leaves exact checksum history on retry', async () => {
    const first = await migrateDatabase(connectionString, 'pactwoven_migration_test');
    expect(first.applied).toEqual(['0001_foundation.sql', '0002_organization_bootstrap.sql']);
    const replay = await migrateDatabase(connectionString, 'pactwoven_migration_test');
    expect(replay).toEqual({ database: 'pactwoven_migration_test', applied: [], skipped: first.applied });
    const rows = await admin.query('SELECT number,filename,checksum FROM pactwoven_migrations.applied_migrations ORDER BY number');
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0].checksum).toMatch(/^[a-f0-9]{64}$/);
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
});
