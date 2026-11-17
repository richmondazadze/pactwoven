import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { observerConsentVariable, observerFixtureVariable } from './supplier-observer-fixture-admission.js';
import { createObserverFixture, evidenceFor, identifier, resolveRaw, transaction, withBlockedObserver,
  type ObserverFixture, type ObserverScenario } from './supplier-observer-fixture.js';
import { PostgresSupplierAuthenticationRepository, PostgresSupplierRelationshipRepository } from './supplier-relationship-repository.js';
import type { SupplierPrivateRequest } from './supplier-relationship-persistence-schema.js';

// Run this file alone on a fresh instance of the existing observer fixture.
// The unchanged admission rejects an occupied/shared cluster; no reset path or
// provider access is introduced. Ordinary test collection opens no connection.
const enabled = Boolean(process.env[observerFixtureVariable] || process.env[observerConsentVariable]);
const pureHelpers = ['supplier_category', 'supplier_id', 'supplier_ids', 'supplier_instant', 'supplier_integer',
  'supplier_object', 'supplier_pair', 'supplier_reference', 'supplier_request_scope', 'supplier_request_valid',
  'supplier_require', 'supplier_scope', 'supplier_time', 'supplier_observation_current', 'supplier_read_committed'];

describe.skipIf(!enabled)('supplier migrations under an exact non-superuser identity owner', () => {
  let f: ObserverFixture;
  beforeAll(async () => { f = await createObserverFixture({ managedOwner: true }); }, 60_000);
  afterAll(async () => { if (f) await f.finish(); });
  const run = async (work: (scenario: ObserverScenario) => Promise<void>) => {
    const scenario = await f.scenario();
    try { await work(scenario); } finally { await scenario.close(); }
  };

  it('installs both migrations through a real owner LOGIN without superuser or RLS bypass', async () => {
    expect(f.installer.managed).toBe(true);
    expect(f.installer.forcedOwnerRejected).toBe(true);
    const row = (await f.installer.pool.query(`SELECT current_user=session_user AS direct,
      rolsuper,rolbypassrls,rolcreaterole FROM pg_roles WHERE rolname=session_user`)).rows[0];
    expect(row).toEqual({ direct: true, rolsuper: false, rolbypassrls: false, rolcreaterole: true });
    expect(f.installed[1]).toMatchObject({ owner: f.installer.name, rolsuper: false, prosecdef: true });
    expect(f.installed[2]).toMatchObject({ owner: 'pactwoven_supplier_executor', rolsuper: false, prosecdef: true });
  });

  it('leaves only administrative role membership and removes temporary schema/SET/inherited access', async () => {
    const rows = (await f.admin.query(`SELECT r.rolname,a.admin_option,a.inherit_option,a.set_option,
      has_schema_privilege(r.oid,'pactwoven','CREATE') AS schema_create,r.rolcanlogin,r.rolsuper,r.rolbypassrls
      FROM pg_auth_members a JOIN pg_roles r ON r.oid=a.roleid JOIN pg_roles m ON m.oid=a.member
      WHERE m.rolname=$1 AND r.rolname IN ('pactwoven_supplier_owner','pactwoven_supplier_executor') ORDER BY r.rolname`, [f.installer.name])).rows;
    expect(rows).toEqual(['pactwoven_supplier_executor', 'pactwoven_supplier_owner'].map(rolname => ({
      rolname, admin_option: true, inherit_option: false, set_option: false, schema_create: false,
      rolcanlogin: false, rolsuper: false, rolbypassrls: false,
    })));
    for (const role of ['pactwoven_supplier_owner', 'pactwoven_supplier_executor']) {
      await expect(f.installer.pool.query(`SET ROLE ${role}`)).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('gives the identity owner exactly the pure helper closure and its own two readers', async () => {
    const rows = (await f.admin.query(`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='pactwoven' AND p.proname LIKE 'supplier_%' AND has_function_privilege($1,p.oid,'EXECUTE') ORDER BY p.proname`, [f.installer.name])).rows;
    expect(rows.map(row => row.proname)).toEqual([...pureHelpers, 'supplier_base_identity', 'supplier_observer_identity'].sort());
    const unexpected = (await f.admin.query(`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      WHERE n.nspname='pactwoven' AND p.proname LIKE 'supplier_%' AND a.grantee=0 AND a.privilege_type='EXECUTE'`)).rows;
    expect(unexpected).toEqual([]);
  });

  it('preserves the forced supplier tables and non-owner executor split', async () => {
    const rows = (await f.admin.query(`SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,r.rolname AS owner,r.rolsuper,r.rolbypassrls
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner
      WHERE n.nspname='pactwoven' AND c.relkind='r' AND c.relname LIKE 'supplier_%' ORDER BY c.relname`)).rows;
    expect(rows).toHaveLength(7);
    for (const row of rows) expect(row).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true,
      owner: 'pactwoven_supplier_owner', rolsuper: false, rolbypassrls: false });
  });

  it('resolves an exact actor without writes and refuses a substituted tenant', async () => run(async s => {
    const before = await f.inventory();
    expect((await s.repository().resolveIdentity(s.identityInput())).actor).toMatchObject({ organizationId: s.organization, actorId: s.actor });
    await expect(resolveRaw(s, { ...s.observation(), externalOrganizationId: 'other_tenant' })).rejects.toMatchObject({ code: 'SP001' });
    expect(await f.inventory()).toEqual(before);
  }));

  it('composes both fixed readers through committed recording and the same-process authorizer', async () => run(async s => {
    const resolved = await s.repository().resolveIdentity(s.identityInput());
    const request: SupplierPrivateRequest = { kind: 'relationship-observation-plan', purpose: 'supplier_relationship_observation_plan',
      query: { scope: s.request.query.scope } };
    const evidence = await evidenceFor(s, resolved.actor, resolved.observation, request);
    const handle = await new PostgresSupplierAuthenticationRepository(s.verifier.pool, s.binding).append(evidence, request, resolved.actor);
    const result = await new PostgresSupplierRelationshipRepository(s.authorizer.pool, s.binding).execute(handle, request);
    expect(result).toEqual({ kind: request.kind, plan: { scope: request.query.scope, head: null, approvers: [] } });
  }));

  it('fails the actual 0016 owner qualification when FORCE RLS would hide identity rows', async () => {
    await expect(transaction(f.installer.pool, async client => {
      await client.query('ALTER TABLE pactwoven.organizations FORCE ROW LEVEL SECURITY');
      const query = { text: f.observerInstallPreflight, queryMode: 'extended' };
      await client.query(query);
      throw new Error('Unqualified FORCE RLS owner was accepted.');
    })).rejects.toMatchObject({ code: 'P0001' });
  });

  it('refuses a different identity-table owner without changing the saved supplier installation', async () => {
    await f.admin.query('ALTER TABLE pactwoven.organizations OWNER TO CURRENT_USER');
    try {
      const query = { text: f.observerInstallPreflight, queryMode: 'extended' };
      await expect(transaction(f.installer.pool, client => client.query(query)))
        .rejects.toMatchObject({ code: 'P0001' });
    } finally { await f.admin.query(`ALTER TABLE pactwoven.organizations OWNER TO ${identifier(f.installer.name)}`); }
  });

  it('supports a managed owner with actual BYPASSRLS while identity FORCE RLS remains enabled', async () => run(async s => {
    await f.admin.query(`ALTER ROLE ${identifier(f.installer.name)} BYPASSRLS`);
    await f.admin.query('ALTER TABLE pactwoven.organizations FORCE ROW LEVEL SECURITY');
    try { expect((await resolveRaw(s)).actorId).toBe(s.actor); }
    finally {
      await f.admin.query('ALTER TABLE pactwoven.organizations NO FORCE ROW LEVEL SECURITY');
      await f.admin.query(`ALTER ROLE ${identifier(f.installer.name)} NOBYPASSRLS`);
    }
  }));

  it('does not use RLS/ownership as an implicit replacement for required helper EXECUTE', async () => run(async s => {
    await f.admin.query(`REVOKE EXECUTE ON FUNCTION pactwoven.supplier_id(jsonb) FROM ${identifier(f.installer.name)}`);
    try { await expect(resolveRaw(s)).rejects.toMatchObject({ code: '42501' }); }
    finally {
      await transaction(f.admin, async client => {
        await client.query('SET LOCAL ROLE pactwoven_supplier_executor');
        await client.query(`GRANT EXECUTE ON FUNCTION pactwoven.supplier_id(jsonb) TO ${identifier(f.installer.name)}`);
      });
    }
    expect((await resolveRaw(s)).actorId).toBe(s.actor);
  }));

  it.each(['organization', 'revocation'] as const)('retains the actual %s lock before resolving identity', async site => run(async s => {
    await withBlockedObserver(f, s, site, async ({ result, release }) => {
      await release();
      expect((await result).value?.actorId).toBe(s.actor);
    });
  }));
});
