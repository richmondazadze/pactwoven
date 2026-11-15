import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { assertRuntimePool, assertUnprivilegedPool } from './repository.js';
import { assertProvisionerPool } from './provisioner.js';
import { assertAccessPool } from './access-repository.js';
import { assertLegacyMandateIsolation } from './mandate-isolation.js';

const dbSuite = process.env.PACTWOVEN_RUN_DB_TESTS === '1' ? describe : describe.skip;
const asPool = (client: PoolClient) => client as unknown as Pool;

async function rollbackProbe(work: (client: PoolClient, role: string) => Promise<void>): Promise<void> {
  const file = process.env.PACTWOVEN_TEST_ADMIN_DATABASE_URL_FILE;
  if (!file) throw new Error('A protected local test admin DSN file is required.');
  const connectionString = (await readFile(file, 'utf8')).trim(), target = new URL(connectionString);
  if (target.pathname !== '/pactwoven_backend_test' || !['127.0.0.1', 'localhost'].includes(target.hostname)) {
    throw new Error('Rollback probes require the dedicated loopback backend test database.');
  }
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5_000 }), client = await pool.connect();
  const role = `pactwoven_guard_${crypto.randomUUID().replaceAll('-', '')}`;
  try {
    expect((await client.query('SELECT current_database() AS name')).rows[0]?.name).toBe('pactwoven_backend_test');
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
    await work(client, role);
  } finally {
    try { await client.query('RESET SESSION AUTHORIZATION'); await client.query('ROLLBACK'); }
    finally { client.release(); await pool.end(); }
  }
}

dbSuite('database login capability guards — real PostgreSQL, no schema reset', () => {
  it('rejects every cross-role access capability including non-inherited role and direct function grants', async () => {
    const file = process.env.PACTWOVEN_TEST_ADMIN_DATABASE_URL_FILE;
    if (!file) throw new Error('A protected local test admin DSN file is required.');
    const connectionString = (await readFile(file, 'utf8')).trim(), target = new URL(connectionString);
    if (target.pathname !== '/pactwoven_backend_test' || !['127.0.0.1', 'localhost'].includes(target.hostname)) throw new Error('Dedicated loopback test database required.');
    const pool = new Pool({ connectionString, max: 1 }), client = await pool.connect();
    try {
      for (const [base, extra, guard] of [
        ['pactwoven_runtime', 'pactwoven_access_provisioner', assertRuntimePool],
        ['pactwoven_provisioner', 'pactwoven_access_provisioner', assertProvisionerPool],
        ['pactwoven_access_provisioner', 'pactwoven_runtime', assertAccessPool],
        ['pactwoven_access_provisioner', 'pactwoven_provisioner', assertAccessPool],
      ] as const) {
        await client.query('BEGIN');
        const role = `pactwoven_guard_${crypto.randomUUID().replaceAll('-', '')}`;
        await client.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
        await client.query(`GRANT ${base} TO ${role}`);
        await client.query(`GRANT ${extra} TO ${role} WITH INHERIT FALSE, SET TRUE`);
        await client.query(`SET SESSION AUTHORIZATION ${role}`);
        await expect(guard(asPool(client))).rejects.toMatchObject({ code: 'UNSAFE_DATABASE_ROLE' });
        await client.query('RESET SESSION AUTHORIZATION'); await client.query('ROLLBACK');
      }
      await client.query('BEGIN');
      const role = `pactwoven_guard_${crypto.randomUUID().replaceAll('-', '')}`;
      await client.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
      await client.query(`GRANT pactwoven_runtime TO ${role}`);
      await client.query(`GRANT EXECUTE ON FUNCTION pactwoven.change_member_access(text,jsonb,jsonb,jsonb,text,text,jsonb,text,text,text) TO ${role}`);
      await client.query(`SET SESSION AUTHORIZATION ${role}`);
      await expect(assertRuntimePool(asPool(client))).rejects.toMatchObject({ code: 'UNSAFE_DATABASE_ROLE' });
    } finally {
      await client.query('RESET SESSION AUTHORIZATION'); await client.query('ROLLBACK'); client.release(); await pool.end();
    }
  });
  it('rejects privileged logins masked by SET ROLE and non-inherited provisioner membership', async () => {
    const file = process.env.PACTWOVEN_TEST_ADMIN_DATABASE_URL_FILE;
    if (!file) throw new Error('A protected local test admin DSN file is required.');
    const connectionString = (await readFile(file, 'utf8')).trim();
    const target = new URL(connectionString);
    if (target.pathname !== '/pactwoven_backend_test' || !['127.0.0.1', 'localhost'].includes(target.hostname)) {
      throw new Error('Guard probes require the dedicated local backend test database.');
    }
    const pool = new Pool({ connectionString, max: 1 });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE pactwoven_runtime');
      await expect(assertRuntimePool(asPool(client))).rejects.toMatchObject({ code: 'UNSAFE_DATABASE_ROLE' });
      await client.query('SET LOCAL ROLE pactwoven_provisioner');
      await expect(assertProvisionerPool(asPool(client))).rejects.toMatchObject({ code: 'UNSAFE_DATABASE_ROLE' });
      await client.query('RESET ROLE');
      const role = `pactwoven_guard_${crypto.randomUUID().replaceAll('-', '')}`;
      await client.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
      await client.query(`GRANT pactwoven_runtime TO ${role}`);
      await client.query(`GRANT pactwoven_provisioner TO ${role} WITH INHERIT FALSE, SET TRUE`);
      await client.query(`SET SESSION AUTHORIZATION ${role}`);
      const capability = await client.query(`SELECT current_user=session_user AS same_identity,
        pg_has_role(current_user,'pactwoven_provisioner','MEMBER') AS member,
        pg_has_role(current_user,'pactwoven_provisioner','USAGE') AS inherited,
        pg_has_role(current_user,'pactwoven_provisioner','SET') AS can_set`);
      expect(capability.rows[0]).toEqual({ same_identity: true, member: true, inherited: false, can_set: true });
      await expect(assertRuntimePool(asPool(client))).rejects.toMatchObject({ code: 'UNSAFE_DATABASE_ROLE' });
    } finally {
      await client.query('RESET SESSION AUTHORIZATION');
      await client.query('ROLLBACK');
      client.release();
      await pool.end();
    }
  });
});

dbSuite.each([
  { base: 'pactwoven_runtime', guard: assertRuntimePool },
  { base: 'pactwoven_provisioner', guard: assertProvisionerPool },
  { base: 'pactwoven_access_provisioner', guard: assertAccessPool },
])('$base mandate isolation — rollback-only PostgreSQL grants', ({ base, guard }) => {
  it('accepts clean legacy credentials without relying on a mandate role or migration being present', async () => {
    await rollbackProbe(async (client, role) => {
      await client.query(`GRANT ${base} TO ${role}`);
      await client.query(`SET SESSION AUTHORIZATION ${role}`);
      await expect(guard(asPool(client))).resolves.toBeUndefined();
    });
  });
  it.each([
    ['REPLICATION', 'direct'], ['REPLICATION', 'transitive'],
    ['CREATEDB', 'direct'], ['CREATEDB', 'transitive'],
  ] as const)('rejects elevated role flag %s through %s membership', async (flag, path) => {
    await rollbackProbe(async (client, role) => {
      await client.query(`GRANT ${base} TO ${role}`);
      const privileged = path === 'direct' ? role : `${role}_via`;
      if (path === 'transitive') {
        await client.query(`CREATE ROLE ${privileged} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
        await client.query(`GRANT ${privileged} TO ${role} WITH INHERIT FALSE, SET FALSE`);
      }
      await client.query(`ALTER ROLE ${privileged} ${flag}`);
      await client.query(`SET SESSION AUTHORIZATION ${role}`);
      const observed = (await client.query(`SELECT rolreplication,rolcreatedb FROM pg_catalog.pg_roles WHERE rolname=$1`, [privileged])).rows[0];
      expect(observed?.[flag === 'REPLICATION' ? 'rolreplication' : 'rolcreatedb']).toBe(true);
      await expect(guard(asPool(client))).rejects.toMatchObject({ code: 'UNSAFE_DATABASE_ROLE' });
    });
  });
  it.each(['direct', 'transitive', 'noinherit', 'no_set_or_inherit'] as const)('rejects %s writer membership', async path => {
    await rollbackProbe(async (client, role) => {
      await client.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='pactwoven_mandate_writer') THEN
        CREATE ROLE pactwoven_mandate_writer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
      END IF; END $$`);
      await client.query(`GRANT ${base} TO ${role}`);
      let member = role;
      if (path !== 'direct') {
        const intermediate = `${role}_via`;
        await client.query(`CREATE ROLE ${intermediate} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
        await client.query(`GRANT ${intermediate} TO ${role} WITH INHERIT FALSE, SET ${path === 'no_set_or_inherit' ? 'FALSE' : 'TRUE'}`);
        member = intermediate;
      }
      await client.query(`GRANT pactwoven_mandate_writer TO ${member} WITH INHERIT ${path === 'noinherit' || path === 'no_set_or_inherit' ? 'FALSE' : 'TRUE'}, SET ${path === 'no_set_or_inherit' ? 'FALSE' : 'TRUE'}`);
      await client.query(`SET SESSION AUTHORIZATION ${role}`);
      if (path === 'noinherit') {
        const state = (await client.query(`SELECT pg_has_role(current_user,'pactwoven_mandate_writer','USAGE') AS inherited,
          pg_has_role(current_user,'pactwoven_mandate_writer','SET') AS can_set`)).rows[0];
        expect(state).toEqual({ inherited: false, can_set: true });
      }
      await expect(guard(asPool(client))).rejects.toMatchObject({ code: 'UNSAFE_DATABASE_ROLE' });
    });
  });
  it.each(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'])
    ('rejects direct %s table privilege without writer membership', async privilege => {
      await rollbackProbe(async (client, role) => {
        const table = `mandate_${role}`;
        await client.query(`GRANT ${base} TO ${role}`);
        await client.query(`CREATE TABLE pactwoven.${table} (id text, payload text)`);
        await client.query(`GRANT ${privilege} ON pactwoven.${table} TO ${role}`);
        await client.query(`SET SESSION AUTHORIZATION ${role}`);
        expect((await client.query('SELECT has_table_privilege(current_user,$1,$2) AS granted', [`pactwoven.${table}`, privilege])).rows[0]?.granted).toBe(true);
        await expect(guard(asPool(client))).rejects.toMatchObject({ code: 'UNSAFE_DATABASE_ROLE' });
      });
    });
  it.each(['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'])('rejects direct %s column privilege without any table grant', async privilege => {
    await rollbackProbe(async (client, role) => {
      const table = `mandate_${role}`;
      await client.query(`GRANT ${base} TO ${role}`);
      await client.query(`CREATE TABLE pactwoven.${table} (id text, payload text)`);
      await client.query(`GRANT ${privilege} (payload) ON pactwoven.${table} TO ${role}`);
      await client.query(`SET SESSION AUTHORIZATION ${role}`);
      const capability = await client.query('SELECT has_table_privilege(current_user,$1,$2) AS table_grant, has_column_privilege(current_user,$1,\'payload\',$2) AS column_grant', [`pactwoven.${table}`, privilege]);
      expect(capability.rows[0]).toEqual({ table_grant: false, column_grant: true });
      await expect(guard(asPool(client))).rejects.toMatchObject({ code: 'UNSAFE_DATABASE_ROLE' });
    });
  });
  it.each(['mandate_', 'read_mandate_'])('rejects direct EXECUTE on a %s helper without writer membership', async prefix => {
    await rollbackProbe(async (client, role) => {
      const routine = `${prefix}${role}`;
      await client.query(`GRANT ${base} TO ${role}`);
      await client.query(`CREATE FUNCTION pactwoven.${routine}() RETURNS boolean LANGUAGE sql AS 'SELECT true'`);
      await client.query(`REVOKE ALL ON FUNCTION pactwoven.${routine}() FROM PUBLIC`);
      await client.query(`GRANT EXECUTE ON FUNCTION pactwoven.${routine}() TO ${role}`);
      await client.query(`SET SESSION AUTHORIZATION ${role}`);
      expect((await client.query('SELECT has_function_privilege(current_user,$1,\'EXECUTE\') AS granted', [`pactwoven.${routine}()`])).rows[0]?.granted).toBe(true);
      await expect(guard(asPool(client))).rejects.toMatchObject({ code: 'UNSAFE_DATABASE_ROLE' });
    });
  });
  it('rejects PUBLIC helper execution and NOINHERIT intermediate object grants', async () => {
    for (const kind of ['public_function', 'indirect_column', 'indirect_function']) {
      await rollbackProbe(async (client, role) => {
        const intermediate = `${role}_via`, object = `mandate_${role}`;
        await client.query(`GRANT ${base} TO ${role}`);
        await client.query(`CREATE ROLE ${intermediate} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
        await client.query(`GRANT ${intermediate} TO ${role} WITH INHERIT FALSE, SET TRUE`);
        if (kind === 'indirect_column') {
          await client.query(`CREATE TABLE pactwoven.${object} (payload text)`);
          await client.query(`GRANT UPDATE (payload) ON pactwoven.${object} TO ${intermediate}`);
        } else {
          await client.query(`CREATE FUNCTION pactwoven.${object}() RETURNS boolean LANGUAGE sql AS 'SELECT true'`);
          if (kind !== 'public_function') {
            await client.query(`REVOKE ALL ON FUNCTION pactwoven.${object}() FROM PUBLIC`);
            await client.query(`GRANT EXECUTE ON FUNCTION pactwoven.${object}() TO ${intermediate}`);
          }
        }
        await client.query(`SET SESSION AUTHORIZATION ${role}`);
        await expect(guard(asPool(client))).rejects.toMatchObject({ code: 'UNSAFE_DATABASE_ROLE' });
      });
    }
  });
  it.each(['functions', 'relations', 'operators'])('rejects real mandate grants under hostile %s search_path shadowing', async shadowKind => {
    await rollbackProbe(async (client, role) => {
      const shadow = `${role}_shadow`, table = `mandate_${role}`;
      await client.query(`GRANT ${base} TO ${role}`);
      await client.query(`CREATE SCHEMA ${shadow}`);
      await client.query(`GRANT USAGE ON SCHEMA ${shadow} TO ${role}`);
      await client.query(`CREATE TABLE pactwoven.${table} (payload text)`);
      await client.query(`GRANT SELECT ON pactwoven.${table} TO ${role}`);
      if (shadowKind === 'functions') {
        const functions = await client.query<{ name: string; arguments: string }>(`SELECT p.proname AS name, pg_catalog.pg_get_function_identity_arguments(p.oid) AS arguments
          FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='pg_catalog' AND p.proname IN ('has_table_privilege','has_any_column_privilege','has_function_privilege','has_schema_privilege','pg_has_role')`);
        for (const fn of functions.rows) await client.query(`CREATE FUNCTION ${shadow}.${fn.name}(${fn.arguments}) RETURNS boolean LANGUAGE sql AS 'SELECT false'`);
      } else if (shadowKind === 'relations') {
        for (const name of ['pg_class', 'pg_proc']) {
          await client.query(`CREATE VIEW ${shadow}.${name} AS SELECT * FROM pg_catalog.${name} WHERE false`);
          await client.query(`GRANT SELECT ON ${shadow}.${name} TO ${role}`);
        }
      } else {
        await client.query(`CREATE FUNCTION ${shadow}.hidden_name(pg_catalog.name,pg_catalog.text) RETURNS boolean LANGUAGE sql AS 'SELECT false'`);
        await client.query(`CREATE OPERATOR ${shadow}.~ (LEFTARG=pg_catalog.name, RIGHTARG=pg_catalog.text, FUNCTION=${shadow}.hidden_name)`);
      }
      await client.query(`SET SESSION AUTHORIZATION ${role}`);
      await client.query(`SET LOCAL search_path = ${shadow}, pg_catalog`);
      const relation = (await client.query('SELECT $1::pg_catalog.regclass::pg_catalog.oid AS oid', [`pactwoven.${table}`])).rows[0]?.oid;
      expect((await client.query('SELECT pg_catalog.has_table_privilege(current_user,$1::pg_catalog.oid,\'SELECT\') AS real_grant', [relation])).rows[0]?.real_grant).toBe(true);
      if (shadowKind === 'functions') {
        expect((await client.query('SELECT has_table_privilege(current_user,$1::pg_catalog.oid,\'SELECT\') AS forged_grant', [relation])).rows[0]?.forged_grant).toBe(false);
      } else if (shadowKind === 'relations') {
        expect((await client.query('SELECT count(*)::integer AS visible FROM pg_class WHERE oid=$1', [relation])).rows[0]?.visible).toBe(0);
      } else {
        expect((await client.query('SELECT $1::pg_catalog.name ~ \'^mandate_\' AS forged_match', [table])).rows[0]?.forged_match).toBe(false);
      }
      await expect(guard(asPool(client))).rejects.toMatchObject({ code: 'UNSAFE_DATABASE_ROLE' });
    });
  });
});

dbSuite('mandate guard includes login capabilities even after SET ROLE', () => {
  it('rejects a session-only direct grant after switching to the safe runtime role', async () => {
    await rollbackProbe(async (client, role) => {
      const table = `mandate_${role}`;
      await client.query(`CREATE TABLE pactwoven.${table} (payload text)`);
      await client.query(`GRANT pactwoven_runtime TO ${role}`);
      await client.query(`GRANT UPDATE (payload) ON pactwoven.${table} TO ${role}`);
      await client.query(`SET SESSION AUTHORIZATION ${role}`);
      await client.query('SET LOCAL ROLE pactwoven_runtime');
      expect((await client.query('SELECT has_any_column_privilege(current_user,$1,\'UPDATE\') AS current_grant, has_any_column_privilege(session_user,$1,\'UPDATE\') AS login_grant', [`pactwoven.${table}`])).rows[0])
        .toEqual({ current_grant: false, login_grant: true });
      await expect(assertLegacyMandateIsolation(asPool(client))).rejects.toMatchObject({ code: 'UNSAFE_DATABASE_ROLE' });
    });
  });
  it('unprivileged validation rejects a CREATEROLE login despite a shadowed membership function', async () => {
    await rollbackProbe(async (client, role) => {
      const shadow = `${role}_shadow`;
      await client.query(`ALTER ROLE ${role} CREATEROLE`);
      await client.query(`CREATE SCHEMA ${shadow}`);
      await client.query(`GRANT USAGE ON SCHEMA ${shadow} TO ${role}`);
      await client.query(`CREATE FUNCTION ${shadow}.pg_has_role(pg_catalog.name,pg_catalog.oid,pg_catalog.text) RETURNS boolean LANGUAGE sql AS 'SELECT false'`);
      await client.query(`SET SESSION AUTHORIZATION ${role}`);
      await client.query(`SET LOCAL search_path = ${shadow}, pg_catalog`);
      expect((await client.query('SELECT rolcreaterole FROM pg_catalog.pg_roles WHERE rolname=current_user')).rows[0]?.rolcreaterole).toBe(true);
      await expect(assertUnprivilegedPool(asPool(client))).rejects.toMatchObject({ code: 'UNSAFE_DATABASE_ROLE' });
    });
  });
});
