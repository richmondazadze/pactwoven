import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertMandatePool } from './mandate-pool.js';

const suite = process.env.PACTWOVEN_RUN_MANDATE_POOL_TESTS === '1' ? describe : describe.skip;
suite('isolated mandate writer effective privilege guard', () => {
  let admin: Pool, writer: Pool, lock: PoolClient, writerUrl: string;
  const login = 'pactwoven_mandate_b1b_test_login', indirect = 'pactwoven_mandate_b1b_indirect_test';
  beforeAll(async () => {
    const urls = await Promise.all(['PACTWOVEN_MANDATE_TEST_ADMIN_URL_FILE', 'PACTWOVEN_MANDATE_TEST_WRITER_URL_FILE'].map(async name => {
      const file = process.env[name]; if (!file) throw new Error('Protected isolated mandate credentials required.');
      const url = new URL((await readFile(file, 'utf8')).trim());
      if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.pathname !== '/pactwoven_mandate_b1b_test') throw new Error('Only isolated mandate test database allowed.');
      return url;
    }));
    if (urls[0]!.host !== urls[1]!.host || urls[1]!.username !== login || urls[0]!.username === login) throw new Error('Dedicated mandate login required.');
    admin = new Pool({ connectionString: urls[0]!.href }); writerUrl = urls[1]!.href; writer = new Pool({ connectionString: writerUrl, max: 1 });
    lock = await admin.connect(); await lock.query("SELECT pg_catalog.pg_advisory_lock(pg_catalog.hashtext('mandate_b1b_author_qualification'))");
    await assertMandatePool(writer);
  });
  afterAll(async () => {
    await writer?.end();
    if (lock) { await lock.query("SELECT pg_catalog.pg_advisory_unlock(pg_catalog.hashtext('mandate_b1b_author_qualification'))"); lock.release(); }
    await admin?.end();
  });
  it('accepts exactly the expected mandate-only role and denies an administrator', async () => {
    await expect(assertMandatePool(writer)).resolves.toBeUndefined();
    await expect(assertMandatePool(admin)).rejects.toMatchObject({ code: 'UNSAFE_DATABASE_ROLE' });
  });
  it('rejects replication capability on the isolated writer login', async () => {
    await admin.query(`ALTER ROLE ${login} REPLICATION`);
    try { await expect(assertMandatePool(writer)).rejects.toMatchObject({ code: 'UNSAFE_DATABASE_ROLE' }); }
    finally { await admin.query(`ALTER ROLE ${login} NOREPLICATION`); }
    await expect(assertMandatePool(writer)).resolves.toBeUndefined();
  });
  it('rejects reachable replication capability through no-inherit membership', async () => {
    await admin.query(`CREATE ROLE ${indirect} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS REPLICATION`);
    try {
      await admin.query(`GRANT ${indirect} TO ${login} WITH INHERIT FALSE`);
      await expect(assertMandatePool(writer)).rejects.toMatchObject({ code: 'UNSAFE_DATABASE_ROLE' });
    } finally { await admin.query(`REVOKE ${indirect} FROM ${login}`); await admin.query(`DROP ROLE ${indirect}`); }
    await expect(assertMandatePool(writer)).resolves.toBeUndefined();
  });
  it.each(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] as const)('rejects added %s on legacy storage', async privilege => {
    await admin.query(`GRANT ${privilege} ON pactwoven.operations TO ${login}`);
    try { await expect(assertMandatePool(writer)).rejects.toMatchObject({ code: 'UNSAFE_DATABASE_ROLE' }); }
    finally { await admin.query(`REVOKE ${privilege} ON pactwoven.operations FROM ${login}`); }
    await assertMandatePool(writer);
  });
  it('rejects a legacy column-only write and no-inherit transitive privilege', async () => {
    await admin.query(`CREATE ROLE ${indirect} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
    await admin.query(`GRANT UPDATE(name) ON pactwoven.organizations TO ${indirect}`);
    await admin.query(`GRANT ${indirect} TO ${login} WITH INHERIT FALSE`);
    try { await expect(assertMandatePool(writer)).rejects.toMatchObject({ code: 'UNSAFE_DATABASE_ROLE' }); }
    finally { await admin.query(`REVOKE ${indirect} FROM ${login}`); await admin.query(`REVOKE ALL(name) ON pactwoven.organizations FROM ${indirect}`); await admin.query(`DROP ROLE ${indirect}`); }
  });
  it('rejects transitive membership in another application role', async () => {
    await admin.query(`CREATE ROLE ${indirect} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
    await admin.query(`GRANT pactwoven_runtime TO ${indirect}`); await admin.query(`GRANT ${indirect} TO ${login} WITH INHERIT FALSE`);
    try { await expect(assertMandatePool(writer)).rejects.toMatchObject({ code: 'UNSAFE_DATABASE_ROLE' }); }
    finally { await admin.query(`REVOKE ${indirect} FROM ${login}`); await admin.query(`REVOKE pactwoven_runtime FROM ${indirect}`); await admin.query(`DROP ROLE ${indirect}`); }
  });
  it('rejects head table UPDATE and extra mutable head columns', async () => {
    await admin.query(`GRANT UPDATE ON pactwoven.mandate_heads TO ${login}`);
    try { await expect(assertMandatePool(writer)).rejects.toMatchObject({ code: 'UNSAFE_DATABASE_ROLE' }); }
    finally { await admin.query(`REVOKE UPDATE ON pactwoven.mandate_heads FROM ${login}`); }
    await admin.query(`GRANT UPDATE(id) ON pactwoven.mandate_heads TO ${login}`);
    try { await expect(assertMandatePool(writer)).rejects.toMatchObject({ code: 'UNSAFE_DATABASE_ROLE' }); }
    finally { await admin.query(`REVOKE UPDATE(id) ON pactwoven.mandate_heads FROM ${login}`); }
    await assertMandatePool(writer);
  });
  it('rejects extra functions even with the name of an allowed helper', async () => {
    await admin.query('CREATE FUNCTION pactwoven.mandate_can_read(text) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$');
    try { await expect(assertMandatePool(writer)).rejects.toMatchObject({ code: 'UNSAFE_DATABASE_ROLE' }); }
    finally { await admin.query('DROP FUNCTION pactwoven.mandate_can_read(text)'); }
  });
  it('rejects missing RLS and schema CREATE rights', async () => {
    await admin.query('ALTER TABLE pactwoven.mandate_proposals DISABLE ROW LEVEL SECURITY');
    try { await expect(assertMandatePool(writer)).rejects.toMatchObject({ code: 'UNSAFE_DATABASE_ROLE' }); }
    finally { await admin.query('ALTER TABLE pactwoven.mandate_proposals ENABLE ROW LEVEL SECURITY'); }
    await admin.query(`GRANT CREATE ON SCHEMA pactwoven TO ${login}`);
    try { await expect(assertMandatePool(writer)).rejects.toMatchObject({ code: 'UNSAFE_DATABASE_ROLE' }); }
    finally { await admin.query(`REVOKE CREATE ON SCHEMA pactwoven FROM ${login}`); }
  });
  it('ignores hostile search_path operators and functions while still rejecting added privileges', async () => {
    await admin.query('CREATE SCHEMA pactwoven_mandate_spoof');
    await admin.query(`GRANT USAGE ON SCHEMA pactwoven_mandate_spoof TO ${login}`);
    for (const [suffix, left, right] of [['text', 'text', 'text'], ['oid', 'oid', 'oid'], ['name', 'name', 'text']] as const) {
      await admin.query(`CREATE FUNCTION pactwoven_mandate_spoof.eq_${suffix}(${left},${right}) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT true $$`);
      await admin.query(`CREATE OPERATOR pactwoven_mandate_spoof.= (LEFTARG=${left},RIGHTARG=${right},FUNCTION=pactwoven_mandate_spoof.eq_${suffix})`);
      await admin.query(`CREATE FUNCTION pactwoven_mandate_spoof.ne_${suffix}(${left},${right}) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT false $$`);
      await admin.query(`CREATE OPERATOR pactwoven_mandate_spoof.<> (LEFTARG=${left},RIGHTARG=${right},FUNCTION=pactwoven_mandate_spoof.ne_${suffix})`);
    }
    await admin.query('CREATE FUNCTION pactwoven_mandate_spoof.has_table_privilege(oid,oid,text) RETURNS boolean LANGUAGE sql AS $$ SELECT false $$');
    const hostile = new Pool({ connectionString: writerUrl, max: 1, options: '-c search_path=pactwoven_mandate_spoof,pg_catalog' });
    try {
      expect((await hostile.query("SELECT 'a'::text = 'b'::text AS spoofed")).rows[0].spoofed).toBe(true);
      await assertMandatePool(hostile);
      expect((await hostile.query("SELECT 'a'::text = 'b'::text AS restored")).rows[0].restored).toBe(true);
      await admin.query(`GRANT UPDATE(name) ON pactwoven.organizations TO ${login}`);
      await expect(assertMandatePool(hostile)).rejects.toMatchObject({ code: 'UNSAFE_DATABASE_ROLE' });
    } finally { await hostile.end(); await admin.query(`REVOKE UPDATE(name) ON pactwoven.organizations FROM ${login}`); await admin.query('DROP SCHEMA pactwoven_mandate_spoof CASCADE'); }
    await assertMandatePool(writer);
  });
});
