import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { assertRuntimePool } from './repository.js';
import { assertProvisionerPool } from './provisioner.js';
import { assertAccessPool } from './access-repository.js';

const dbSuite = process.env.PACTWOVEN_RUN_DB_TESTS === '1' ? describe : describe.skip;
const asPool = (client: PoolClient) => client as unknown as Pool;

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
