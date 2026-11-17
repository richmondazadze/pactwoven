import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient, type PoolConfig } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadMigrations, type Migration } from './migrate.js';
import { assertObserverSocket, loadObserverFixtureMigrations, observerConsentVariable, observerFixtureVariable,
  readObserverFixtureConfig } from './supplier-observer-fixture-admission.js';
import { custodyPostgresVersions, custodySystemPrivilegePredicate } from './custody-setup-system-privileges.js';
import { assertCustodySetupConnection } from './custody-setup-pool.js';
import { assertFinancialAuthorityConnection } from './financial-authority-pool.js';
import { supplierRuntimeMembershipPredicate } from './supplier-runtime-membership.js';
import { PostgresSupplierObserverRepository } from './supplier-observer-repository.js';
import { PostgresSupplierAuthenticationRepository, PostgresSupplierRelationshipRepository } from './supplier-relationship-repository.js';
import { hashBinding, appendBinding } from './supplier-observer-fixture.js';
import { snapshotSupplierPersistenceRequest, type SupplierPrivateRequest } from './supplier-relationship-persistence-schema.js';

const migrationUrl = new URL('../migrations/0017_managed_postgres_qualification.sql', import.meta.url);
const body = (source: string, name: string) => {
  const start = source.indexOf(`FUNCTION pactwoven.${name}(`), begin = source.indexOf('AS $$', start) + 5;
  return source.slice(begin, source.indexOf('$$;', begin));
};
const membershipBefore = 'AND NOT EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid OR m.roleid=r.oid)';
const enabled = Boolean(process.env[observerFixtureVariable] || process.env[observerConsentVariable]);
const identifier = (value: string) => '"' + value.replaceAll('"', '""') + '"';
const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'";

describe('managed PostgreSQL migration scope', () => {
  it('preserves all supplier conditions outside the exact incoming creator membership exception', async () => {
    const [previous, next] = await Promise.all([
      readFile(new URL('../migrations/0016_supplier_observer_resolution.sql', import.meta.url), 'utf8'), readFile(migrationUrl, 'utf8'),
    ]);
    const before = body(previous, 'supplier_role_safe'), after = body(next, 'supplier_role_safe');
    const start = after.indexOf('AND NOT EXISTS(SELECT 1 FROM pg_auth_members m'), end = after.indexOf('\n    AND NOT has_database_privilege', start);
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
    expect(after.slice(0, start) + membershipBefore + after.slice(end)).toBe(before);
    expect(after.slice(start, end)).toContain('m.member=r.oid OR (m.roleid=r.oid AND NOT(');
    expect(after.slice(start, end)).toContain('m.grantor=10');
    expect('AND ' + supplierRuntimeMembershipPredicate.replaceAll('pg_catalog.', '')).toBe(after.slice(start, end));
  });

  it('keeps the historical sixteen-migration fixture pinned independently of new discovery', async () => {
    expect(await loadObserverFixtureMigrations()).toHaveLength(16);
    const migrations = await loadMigrations();
    expect(migrations[16]?.filename).toBe('0017_managed_postgres_qualification.sql');
    expect(custodyPostgresVersions).toEqual([170011, 170012]);
  });
});

// Root's separate matrix job supplies the same strict fresh-cluster admission,
// using only this file and one worker. All 17 migrations run through the managed
// owner: transferring only the schema would not model Neon function ownership.
describe.skipIf(!enabled)('managed PostgreSQL qualification on one fresh native fixture', () => {
  let admin: Pool, owner: Pool, config: PoolConfig, next: Migration;
  const ownerName = 'pactwoven_qualification_owner', foreignName = 'pactwoven_qualification_foreign';
  const principals: { name: string; oid: number; config: PoolConfig; kind: 'supplier' | 'custody' | 'financial'; cap: string }[] = [];
  let initialFunctions: unknown[], initialRelations: unknown[], initialMemberships: unknown[], supplierBefore: string;
  const functions = (client: Pool | PoolClient) => client.query(`SELECT p.oid,p.proname,p.proowner,p.prosrc,p.prosecdef,p.provolatile,p.proconfig,p.proacl::text
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='pactwoven' ORDER BY p.oid`).then(r => r.rows);
  const relations = (client: Pool | PoolClient) => client.query(`SELECT c.oid,c.relowner,c.relacl::text,c.relrowsecurity,c.relforcerowsecurity
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='pactwoven' ORDER BY c.oid`).then(r => r.rows);
  const memberships = (client: Pool | PoolClient) => client.query('SELECT roleid,member,grantor,admin_option,inherit_option,set_option FROM pg_auth_members ORDER BY roleid,member,grantor').then(r => r.rows);
  const apply = async (pool: Pool, migration: Migration) => {
    const client = await pool.connect();
    try { await client.query('BEGIN'); for (const text of migration.statements) { const query = { text, queryMode: 'extended' }; await client.query(query); } await client.query('COMMIT'); }
    catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  };
  const rollback = async (run: (client: PoolClient) => Promise<void>, pool = admin) => {
    const client = await pool.connect();
    try { await client.query('BEGIN'); await run(client); } finally { await client.query('ROLLBACK'); client.release(); }
  };
  const safe = async (client: Pool | PoolClient, principal: typeof principals[number], capability = principal.cap) =>
    (await client.query('SELECT pactwoven.supplier_role_safe($1::oid,$2::text) AS safe', [principal.oid, capability])).rows[0].safe;
  const systemSafe = async (client: Pool | PoolClient, principal: typeof principals[number]) =>
    (await client.query('SELECT pactwoven.custody_system_privileges_safe($1::oid) AS safe', [principal.oid])).rows[0].safe;
  const membershipSafe = async (client: Pool | PoolClient, principal: typeof principals[number]) =>
    (await client.query(`SELECT (${supplierRuntimeMembershipPredicate}) AS safe FROM pg_roles r WHERE r.oid=$1::oid`, [principal.oid])).rows[0].safe;
  const supplier = () => principals.filter(p => p.kind === 'supplier');

  beforeAll(async () => {
    config = { ...await readObserverFixtureConfig(), max: 1 };
    admin = new Pool(config);
    const client = await admin.connect();
    try {
      await assertObserverSocket(client, config);
      expect((await client.query(`SELECT r.oid,r.rolsuper,(SELECT count(*)::int FROM pg_namespace WHERE nspname='pactwoven') AS schemas,
        (SELECT count(*)::int FROM pg_roles WHERE rolname LIKE 'pactwoven_%') AS roles FROM pg_roles r WHERE rolname=SESSION_USER`)).rows[0])
        .toEqual({ oid: 10, rolsuper: true, schemas: 0, roles: 0 });
    } finally { client.release(); }
    const password = randomBytes(32).toString('base64url');
    await admin.query(`CREATE ROLE ${identifier(ownerName)} LOGIN INHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB CREATEROLE NOREPLICATION PASSWORD ${literal(password)}`);
    await admin.query(`GRANT CREATE ON DATABASE ${identifier(String(config.database))} TO ${identifier(ownerName)}`);
    owner = new Pool({ ...config, user: ownerName, password });
    const migrations = await loadMigrations();
    expect(migrations).toHaveLength(17); next = migrations[16]!;
    for (const migration of await loadObserverFixtureMigrations()) await apply(owner, migration);
    await admin.query(`REVOKE CREATE ON DATABASE ${identifier(String(config.database))} FROM ${identifier(ownerName)}`);
    initialFunctions = await functions(admin); initialRelations = await relations(admin); initialMemberships = await memberships(admin);
    supplierBefore = (initialFunctions as { proname: string; prosrc: string }[]).find(row => row.proname === 'supplier_role_safe')!.prosrc;
    await apply(owner, next);
    expect(await relations(admin)).toEqual(initialRelations);
    expect(await memberships(admin)).toEqual(initialMemberships);
    for (const [kind, cap, group] of [
      ['supplier', 'verifier', null], ['supplier', 'authorizer', null],
      ['custody', 'writer', 'pactwoven_custody_setup_writer'], ['custody', 'verifier', 'pactwoven_custody_setup_verifier'],
      ['financial', 'authorizer', 'pactwoven_financial_authorizer'], ['financial', 'verifier', 'pactwoven_financial_verifier'],
    ] as const) {
      const name = `pactwoven_qualification_${kind}_${cap}`, secret = randomBytes(32).toString('base64url');
      await owner.query(`CREATE ROLE ${identifier(name)} LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD ${literal(secret)}`);
      if (group) await owner.query(`GRANT ${group} TO ${identifier(name)} WITH ADMIN FALSE, INHERIT TRUE, SET TRUE`);
      else {
        await admin.query(`GRANT USAGE ON SCHEMA pactwoven TO ${identifier(name)}`);
        for (const fn of cap === 'verifier' ? ['supplier_record_evidence(jsonb)', 'supplier_resolve_observer(jsonb,jsonb)'] :
          ['supplier_scope_policy_command(uuid,jsonb)', 'supplier_scope_policy_read(uuid,jsonb)', 'supplier_relationship_command(uuid,jsonb)',
            'supplier_relationship_status(uuid,jsonb)', 'supplier_relationship_recover(uuid,jsonb)']) {
          await admin.query(`GRANT EXECUTE ON FUNCTION pactwoven.${fn} TO ${identifier(name)}`);
        }
      }
      const oid = Number((await admin.query('SELECT oid FROM pg_roles WHERE rolname=$1', [name])).rows[0].oid);
      principals.push({ name, oid, config: { ...config, user: name, password: secret }, kind, cap });
    }
    await owner.query(`CREATE ROLE ${identifier(foreignName)} NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`);
  }, 60_000);
  afterAll(async () => {
    try { if (admin) for (const principal of principals) await admin.query(`ALTER ROLE ${identifier(principal.name)} NOLOGIN`); }
    finally { await owner?.end(); await admin?.end(); }
  });

  it('changes only the two helper bodies, retaining owners/configs/ACLs and every relation', async () => {
    const current = await functions(admin), original = initialFunctions as typeof current;
    expect(current).toHaveLength(original.length);
    for (const [index, row] of current.entries()) {
      const before = original[index]!;
      if (['custody_system_privileges_safe', 'supplier_role_safe'].includes(row.proname)) expect({ ...row, prosrc: before.prosrc }).toEqual(before);
      // Supplier enrollment adds only its fixed entrypoint EXECUTE grants.
      else if (row.proname.startsWith('supplier_')) expect({ ...row, proacl: before.proacl }).toEqual(before);
      else expect(row).toEqual(before);
    }
    expect(await relations(admin)).toEqual(initialRelations);
    const source = await readFile(migrationUrl, 'utf8');
    for (const name of ['custody_system_privileges_safe', 'supplier_role_safe'])
      expect(current.find(row => row.proname === name)!.prosrc).toBe(body(source, name));
    expect((await owner.query('SELECT current_user=session_user AS direct,rolsuper,rolbypassrls,rolcreaterole FROM pg_roles WHERE rolname=SESSION_USER')).rows[0])
      .toEqual({ direct: true, rolsuper: false, rolbypassrls: false, rolcreaterole: true });
    expect((await admin.query(`SELECT has_schema_privilege('pactwoven_supplier_executor','pactwoven','CREATE') AS create,
      pg_has_role($1,'pactwoven_supplier_executor','USAGE') AS inherit,pg_has_role($1,'pactwoven_supplier_executor','SET') AS set`, [ownerName])).rows[0])
      .toEqual({ create: false, inherit: false, set: false });
  });

  it('accepts all four real financial/custody logins and their SQL helpers', async () => {
    for (const principal of principals.filter(p => p.kind !== 'supplier')) {
      const pool = new Pool(principal.config), client = await pool.connect();
      try {
        await assertObserverSocket(client, principal.config);
        await client.query('BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY');
        if (principal.kind === 'custody') await assertCustodySetupConnection(client, principal.cap as 'writer' | 'verifier');
        else await assertFinancialAuthorityConnection(client, principal.cap as 'authorizer' | 'verifier');
        await client.query('ROLLBACK');
      } finally { client.release(); await pool.end(); }
      const name = principal.kind === 'custody' ? 'custody_private_read_role_safe' : 'financial_policy_role_safe';
      expect((await owner.query(`SELECT pactwoven.${name}($1::oid,$2::text) AS safe`, [principal.oid, principal.cap])).rows[0].safe).toBe(true);
    }
  });

  it('accepts only explicit server versions with the same 62-signature catalog and ACL closure', async () => {
    const principal = principals.find(p => p.kind === 'custody')!;
    const prefix = `WITH RECURSIVE reachable(oid) AS(SELECT ${principal.oid}::oid UNION SELECT m.roleid FROM pg_auth_members m JOIN reachable x ON x.oid=m.member) SELECT (`;
    for (const version of [170010, 170011, 170012, 170013, 180000]) {
      const synthetic = custodySystemPrivilegePredicate.replace("pg_catalog.current_setting('server_version_num')::integer", '$1::integer');
      expect((await admin.query(prefix + synthetic + ') AS safe', [version])).rows[0].safe).toBe(custodyPostgresVersions.includes(version as 170011));
    }
    const baseline = custodySystemPrivilegePredicate.slice(0, custodySystemPrivilegePredicate.indexOf(']::text[])'));
    const signatures = [...baseline.matchAll(/'pg_catalog\.([^']+)'/g)].map(match => 'pg_catalog.' + match[1]);
    expect(signatures).toHaveLength(62);
    for (const signature of signatures) await rollback(async client => {
      await client.query(`GRANT EXECUTE ON FUNCTION ${signature} TO ${identifier(principal.name)}`);
      expect(await systemSafe(client, principal)).toBe(false);
    });
    expect(await systemSafe(admin, principal)).toBe(true);
  });

  it('accepts only the original ADMIN-only incoming creator grant, and still permits no membership', async () => {
    for (const principal of supplier()) {
      const rows = (await admin.query(`SELECT m.grantor,g.rolsuper,u.rolname,m.admin_option,m.inherit_option,m.set_option
        FROM pg_auth_members m JOIN pg_roles g ON g.oid=m.grantor JOIN pg_roles u ON u.oid=m.member WHERE m.roleid=$1`, [principal.oid])).rows;
      expect(rows).toEqual([{ grantor: 10, rolsuper: true, rolname: ownerName, admin_option: true, inherit_option: false, set_option: false }]);
      const original = supplierBefore.replace(/\bwho\b/g, `${principal.oid}::oid`).replace(/\bcapability\b/g, literal(principal.cap));
      expect(Object.values((await admin.query(original)).rows[0])[0]).toBe(false);
      expect(await safe(admin, principal)).toBe(true);
      expect(await membershipSafe(admin, principal)).toBe(true);
      await rollback(async client => {
        await client.query(`REVOKE ${identifier(principal.name)} FROM ${identifier(ownerName)} GRANTED BY ${identifier(String(config.user))}`);
        expect(await safe(client, principal)).toBe(true);
      });
      const pool = new Pool(principal.config);
      try { expect((await pool.query('SELECT current_user=session_user AS direct')).rows[0].direct).toBe(true); }
      finally { await pool.end(); }
    }
  });

  it('composes actual observer, committed evidence recording and same-process authorizer with retained creator rows', async () => {
    const verifier = supplier().find(p => p.cap === 'verifier')!, authorizer = supplier().find(p => p.cap === 'authorizer')!;
    const now = Date.now(), at = (value: number) => new Date(value).toISOString();
    for (const party of ['buyer', 'supplier']) {
      await owner.query(`INSERT INTO pactwoven.organizations(environment,id,external_organization_id,name,created_at)
        VALUES('development',$1,$2,$3,$4)`, [party + '_qualification', 'external_' + party, 'Synthetic ' + party, at(now - 60_000)]);
    }
    await owner.query(`INSERT INTO pactwoven.memberships(environment,organization_id,actor_id,external_subject,external_membership_id,roles,grant_basis,created_at)
      VALUES('development','buyer_qualification','qualification_actor','qualification_subject','qualification_member',ARRAY['owner'],'internal',$1)`, [at(now - 60_000)]);
    const binding = await hashBinding({ reference: { id: 'qualification_binding', version: 1 }, environment: 'development',
      effectiveOrganizationId: 'buyer_qualification', verifier: { name: verifier.name, oid: verifier.oid },
      authorizer: { name: authorizer.name, oid: authorizer.oid }, status: 'ACTIVE', validFrom: at(now - 60_000), expiresAt: at(now + 3_600_000) });
    await appendBinding(admin, binding);
    const verifierPool = new Pool(verifier.config), authorizerPool = new Pool(authorizer.config);
    const request: SupplierPrivateRequest = { kind: 'relationship-observation-plan', purpose: 'supplier_relationship_observation_plan', query: {
      scope: { environment: 'development', buyerOrganizationId: 'buyer_qualification', supplierOrganizationId: 'supplier_qualification', supplierRelationshipId: 'qualification_relationship' } } };
    try {
      const resolved = await new PostgresSupplierObserverRepository(verifierPool, { environment: 'development', issuer: 'https://synthetic.invalid', binding }).resolveIdentity({
        identity: { subject: 'qualification_subject', externalOrganizationId: 'external_buyer', externalOrganizationName: 'Synthetic buyer',
          externalMembershipId: 'qualification_member', externalRole: 'org:admin', sessionId: 'qualification_session',
          authenticatedAt: at(now - 120_000), membershipObservedAt: at(now) },
        observation: { issuer: 'https://synthetic.invalid', tokenHash: 'a'.repeat(64), tokenIssuedAt: at(now), observedAt: at(now), expiresAt: at(now + 300_000) },
      });
      const snap = await snapshotSupplierPersistenceRequest(request, { environment: resolved.actor.environment,
        organizationId: resolved.actor.organizationId, actorId: resolved.actor.actorId });
      const evidence = { schemaVersion: 1 as const, id: randomUUID(), kind: 'identity' as const, actor: resolved.actor, binding, observedBy: binding.verifier,
        request, requestDigest: snap.requestDigest, mutationDigest: snap.mutationDigest, observation: resolved.observation,
        observedAt: resolved.observation.observedAt, expiresAt: resolved.observation.expiresAt };
      const handle = await new PostgresSupplierAuthenticationRepository(verifierPool, binding).append(evidence, request, resolved.actor);
      expect(await new PostgresSupplierRelationshipRepository(authorizerPool, binding).execute(handle, request))
        .toEqual({ kind: request.kind, plan: { scope: request.query.scope, head: null, approvers: [] } });
      expect((await admin.query('SELECT count(*)::int AS count FROM pactwoven.supplier_authentication_evidence')).rows[0].count).toBe(1);
    } finally { await verifierPool.end(); await authorizerPool.end(); }
  });

  it.each(['foreign-member', 'foreign-grantor', 'inherit', 'set', 'no-admin', 'outbound'] as const)('rejects %s membership for both supplier capabilities', async mode => {
    for (const principal of supplier()) await rollback(async client => {
      const role = identifier(principal.name), member = identifier(ownerName), bootstrap = identifier(String(config.user));
      if (mode === 'foreign-member') await client.query(`GRANT ${role} TO ${identifier(foreignName)} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`);
      if (mode === 'foreign-grantor') {
        // The bootstrap grants the bridge its own ADMIN authority; the bridge
        // then grants to the owner, without self-ADMIN or a grantor cycle.
        await client.query(`GRANT ${role} TO ${identifier(foreignName)} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`);
        await client.query(`SET LOCAL ROLE ${identifier(foreignName)}`);
        await client.query(`GRANT ${role} TO ${member} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`);
        await client.query('SET LOCAL ROLE NONE');
        expect((await client.query(`SELECT count(*)::int AS count FROM pg_auth_members WHERE roleid=$1 AND member=$2::regrole
          AND grantor=$3::regrole AND admin_option AND NOT inherit_option AND NOT set_option`, [principal.oid, ownerName, foreignName])).rows[0].count).toBe(1);
        // Isolate the real foreign-grantor row in a SELECT-only projection.
        // Removing the bridge's own incoming row avoids conflating two rejects.
        const projected = supplierRuntimeMembershipPredicate.replaceAll('pg_catalog.pg_auth_members', 'projected_memberships');
        expect((await client.query(`WITH projected_memberships AS(SELECT * FROM pg_auth_members WHERE member<>$2::regrole)
          SELECT (${projected}) AS safe FROM pg_roles r WHERE r.oid=$1`, [principal.oid, foreignName])).rows[0].safe).toBe(false);
      }
      if (mode === 'inherit') await client.query(`GRANT ${role} TO ${member} WITH INHERIT TRUE GRANTED BY ${bootstrap}`);
      if (mode === 'set') await client.query(`GRANT ${role} TO ${member} WITH SET TRUE GRANTED BY ${bootstrap}`);
      if (mode === 'no-admin') await client.query(`GRANT ${role} TO ${member} WITH ADMIN FALSE GRANTED BY ${bootstrap}`);
      if (mode === 'outbound') await client.query(`GRANT ${identifier(foreignName)} TO ${role} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`);
      expect(await safe(client, principal)).toBe(false);
      expect(await membershipSafe(client, principal)).toBe(false);
    });
  });

  it('requires actual bootstrap superuser metadata in both SQL and connection predicates', async () => {
    // PostgreSQL refuses demoting the bootstrap role. Exercise the negative
    // metadata branch with SELECT-only projections of the real catalog row.
    expect((await admin.query('SELECT rolsuper FROM pg_roles WHERE oid=10')).rows[0].rolsuper).toBe(true);
    const source = body(await readFile(migrationUrl, 'utf8'), 'supplier_role_safe');
    for (const principal of supplier()) {
      const connection = supplierRuntimeMembershipPredicate.replace('pg_catalog.pg_roles g', '(SELECT oid,false AS rolsuper FROM pg_catalog.pg_roles) g');
      expect((await admin.query(`SELECT (${connection}) AS safe FROM pg_roles r WHERE r.oid=$1`, [principal.oid])).rows[0].safe).toBe(false);
      const sql = source.replace('pg_roles g', '(SELECT oid,false AS rolsuper FROM pg_roles) g')
        .replace(/\bwho\b/g, `${principal.oid}::oid`).replace(/\bcapability\b/g, literal(principal.cap));
      expect(Object.values((await admin.query(sql)).rows[0])[0]).toBe(false);
    }
  });

  it.each(['schema', 'organizations', 'memberships', 'session_revocations', 'sites', 'base-reader', 'observer-reader'] as const)(
    'rejects a changed %s owner trust anchor', async anchor => {
      for (const principal of supplier()) await rollback(async client => {
        if (anchor === 'schema') await client.query('ALTER SCHEMA pactwoven OWNER TO CURRENT_USER');
        else if (anchor === 'base-reader' || anchor === 'observer-reader') {
          const name = anchor === 'base-reader' ? 'supplier_base_identity(jsonb,jsonb,jsonb)' : 'supplier_observer_identity(text,text,jsonb)';
          await client.query(`ALTER FUNCTION pactwoven.${name} OWNER TO CURRENT_USER`);
        } else await client.query(`ALTER TABLE pactwoven.${anchor} OWNER TO CURRENT_USER`);
        expect(await safe(client, principal)).toBe(false);
        expect(await membershipSafe(client, principal)).toBe(false);
      });
    });

  it.each(['function', 'public-function', 'table', 'column', 'schema-create', 'database-create'] as const)(
    'retains the %s privilege prohibition', async privilege => {
      for (const principal of supplier()) await rollback(async client => {
        const role = identifier(principal.name);
        if (privilege === 'function' || privilege === 'public-function') await client.query(`GRANT EXECUTE ON FUNCTION pactwoven.supplier_id(jsonb) TO ${privilege === 'public-function' ? 'PUBLIC' : role}`);
        if (privilege === 'table') await client.query(`GRANT SELECT ON TABLE pactwoven.organizations TO ${role}`);
        if (privilege === 'column') await client.query(`GRANT SELECT(id) ON TABLE pactwoven.organizations TO ${role}`);
        if (privilege === 'schema-create') await client.query(`GRANT CREATE ON SCHEMA public TO ${role}`);
        if (privilege === 'database-create') await client.query(`GRANT CREATE ON DATABASE ${identifier(String(config.database))} TO ${role}`);
        expect(await safe(client, principal)).toBe(false);
      });
    });

  it('refuses an unrelated installer and rolls back all temporary privileges on a later failure', async () => {
    await rollback(async client => {
      await client.query(`SET LOCAL ROLE ${identifier(foreignName)}`);
      await expect(client.query(next.statements[0]!)).rejects.toMatchObject({ code: 'P0001' });
    });
    const before = await memberships(admin);
    await expect(rollback(async client => {
      for (const statement of next.statements) await client.query(statement);
      throw new Error('synthetic rollback');
    }, owner)).rejects.toThrow('synthetic rollback');
    expect(await memberships(admin)).toEqual(before);
  });
});
