import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';
import { commandDigest } from '@pactwoven/domain';
import { PostgresSupplierObserverRepository } from './supplier-observer-repository.js';
import type { SupplierObserverConfiguration, SupplierObserverIdentityObservation, SupplierObserverActor } from './supplier-observer-schema.js';
import { snapshotSupplierPersistenceRequest, type SupplierPrivateRequest } from './supplier-relationship-persistence-schema.js';
import type { SupplierAuthenticationEvidence } from './supplier-relationship-auth-evidence.js';
import { assertObserverSocket, loadObserverFixtureMigrations, readObserverFixtureConfig, observerMigrationPins } from './supplier-observer-fixture-admission.js';

export type Binding = SupplierObserverConfiguration['binding'];
export type Principal = { name: string; oid: number; pool: Pool };
export type Party = 'buyer' | 'supplier';
export const observerIssuer = 'https://synthetic.invalid';
export const observerWrapper = 'supplier_resolve_observer(jsonb,jsonb)';
export const observerAuthorizerFunctions = ['supplier_scope_policy_command(uuid,jsonb)', 'supplier_scope_policy_read(uuid,jsonb)',
  'supplier_relationship_command(uuid,jsonb)', 'supplier_relationship_status(uuid,jsonb)', 'supplier_relationship_recover(uuid,jsonb)'] as const;
const verifierFunctions = ['supplier_record_evidence(jsonb)', observerWrapper];
const watchedTables = ['organizations', 'memberships', 'session_revocations', 'operations', 'outbox_events',
  'supplier_private_bindings', 'supplier_authentication_evidence', 'supplier_access_contexts',
  'supplier_relationship_scope_policies', 'supplier_relationship_proposals', 'supplier_relationship_versions', 'supplier_relationship_receipts'];
export const at = (milliseconds: number) => new Date(milliseconds).toISOString();
export const sha = (value: string) => createHash('sha256').update(value).digest('hex');
export const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
export function identifier(value: string) {
  if (!/^pactwoven_observer_test_[a-z0-9_]{1,39}$/.test(value)) throw new Error('Only this disposable fixture principal may be named.');
  return `"${value}"`;
}
export async function transaction<T>(pool: Pool, run: (client: PoolClient) => Promise<T>, isolation = 'READ COMMITTED') {
  assert(['READ COMMITTED', 'REPEATABLE READ', 'SERIALIZABLE'].includes(isolation));
  const client = await pool.connect();
  try { await client.query(`BEGIN ISOLATION LEVEL ${isolation}`); const result = await run(client); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
}
function sourceBody(source: string, name: string) {
  const body = source.match(new RegExp(`CREATE(?: OR REPLACE)? FUNCTION pactwoven\\.${name}\\([\\s\\S]*? AS \\$\\$([\\s\\S]*?)\\$\\$;`))?.[1];
  assert(body !== undefined, `Missing source function ${name}`); return body;
}
export async function hashBinding(binding: Omit<Binding, 'reference'> & { reference: { id: string; version: number } }): Promise<Binding> {
  return { ...binding, reference: { ...binding.reference,
    hash: await commandDigest({ namespace: 'pactwoven/supplier-private-binding/v1', binding }) } };
}
export async function reviseBinding(binding: Binding, changes: Partial<Omit<Binding, 'reference'>> = {}): Promise<Binding> {
  return hashBinding({ ...binding, ...changes, reference: { id: binding.reference.id, version: binding.reference.version + 1 } });
}
export async function appendBinding(client: Pool | PoolClient, binding: Binding) {
  await client.query(`INSERT INTO pactwoven.supplier_private_bindings(id,version,environment,effective_organization_id,verifier_oid,verifier_name,
    authorizer_oid,authorizer_name,status,valid_from,expires_at,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
  [binding.reference.id, binding.reference.version, binding.environment, binding.effectiveOrganizationId,
    binding.verifier.oid, binding.verifier.name, binding.authorizer.oid, binding.authorizer.name,
    binding.status, binding.validFrom, binding.expiresAt, binding]);
}
export type ScenarioOptions = {
  party?: Party; organizationStatus?: 'active' | 'suspended' | 'closed'; memberStatus?: 'active' | 'suspended' | 'revoked';
  roles?: readonly string[]; grantBasis?: 'internal' | 'clerk_admin_bootstrap'; organizationCreatedAt?: string; memberCreatedAt?: string;
  memberExpiresAt?: string; omitMember?: boolean; bindingValidFrom?: string; bindingExpiresAt?: string;
};
type FunctionAcl = { grantor: string; grantee_oid: string; grantee: string; privilege_type: string; is_grantable: boolean };
type FunctionMetadata = {
  oid: string; prosrc: string; proowner: string; prosecdef: boolean; proconfig: string[] | null; proacl: string | null;
  owner: string; rolsuper: boolean; definition: string; prokind: string; provolatile: string; proleakproof: boolean;
  proisstrict: boolean; proparallel: string; pronargs: number; argument_types: string; return_type: string; lanname: string;
};
type FunctionFingerprint = FunctionMetadata & { signature: string; acl: FunctionAcl[]; definitionSha256: string };

export async function createObserverFixture(options: { managedOwner?: boolean } = {}) {
  const migrations = await loadObserverFixtureMigrations();
  const config = await readObserverFixtureConfig(), admin = new Pool(config), suffix = randomBytes(5).toString('hex');
  const pools = new Set<Pool>();
  const principals: Principal[] = [];
  let scenarioNumber = 0, loginNumber = 0;
  const close = async () => {
    const results = await Promise.allSettled([...pools].map(pool => pool.end())); pools.clear();
    const ended = await Promise.allSettled([admin.end()]);
    const errors = [...results, ...ended].filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (errors.length) throw new AggregateError(errors.map(result => result.reason), 'Observer fixture connections did not close cleanly.');
  };
  try {
    const client = await admin.connect();
    try {
      await assertObserverSocket(client, config);
      const row = (await client.query(`SELECT r.rolsuper,
        (SELECT count(*)::int FROM pg_namespace WHERE nspname='pactwoven') AS schemas,
        (SELECT count(*)::int FROM pg_roles WHERE rolname LIKE 'pactwoven_%') AS roles
        FROM pg_roles r WHERE r.rolname=SESSION_USER`)).rows[0];
      assert.deepEqual(row, { rolsuper: true, schemas: 0, roles: 0 }, 'New empty disposable cluster only; no reset path.');
    } finally { client.release(); }
    for (const migration of migrations.slice(0, 14)) await transaction(admin, async c => {
      for (const statement of migration.statements) {
        const query = { text: statement, queryMode: 'extended' };
        await c.query(query);
      }
    });
    let installer = { pool: admin, name: config.user!, managed: false, forcedOwnerRejected: false };
    if (options.managedOwner) {
      // The existing loopback admission still requires a fresh superuser-owned
      // fixture. Only setup uses it: both supplier migrations then run through a
      // real separate LOGIN with neither superuser nor BYPASSRLS capability.
      const name = `pactwoven_observer_test_${suffix}_managed`, password = randomBytes(32).toString('base64url');
      await admin.query(`CREATE ROLE ${identifier(name)} LOGIN INHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB CREATEROLE NOREPLICATION PASSWORD ${literal(password)}`);
      await admin.query(`GRANT CREATE ON DATABASE "${config.database}" TO ${identifier(name)}`);
      await admin.query(`ALTER SCHEMA pactwoven OWNER TO ${identifier(name)}`);
      await admin.query(`REVOKE CREATE ON DATABASE "${config.database}" FROM ${identifier(name)}`);
      for (const table of ['organizations', 'memberships', 'session_revocations', 'sites']) {
        await admin.query(`ALTER TABLE pactwoven.${table} OWNER TO ${identifier(name)}`);
      }
      const pool = new Pool({ ...config, user: name, password }); pools.add(pool);
      const client = await pool.connect();
      try {
        await assertObserverSocket(client, { ...config, user: name });
        const role = (await client.query('SELECT rolsuper,rolbypassrls,rolcreaterole FROM pg_roles WHERE rolname=session_user')).rows[0];
        assert.deepEqual(role, { rolsuper: false, rolbypassrls: false, rolcreaterole: true });
      } finally { client.release(); }
      // Exercise the actual 0015 guard before any supplier role exists. The
      // forced-RLS alteration is always rolled back, including unexpected pass.
      await assert.rejects(transaction(pool, async c => {
        await c.query('ALTER TABLE pactwoven.organizations FORCE ROW LEVEL SECURITY');
        const query = { text: migrations[14]!.statements[0]!, queryMode: 'extended' };
        await c.query(query);
        throw new Error('Forced owner without bypass was unexpectedly accepted.');
      }), { code: 'P0001' });
      installer = { pool, name, managed: true, forcedOwnerRejected: true };
    }
    await transaction(installer.pool, async c => {
      for (const statement of migrations[14]!.statements) {
        const query = { text: statement, queryMode: 'extended' };
        await c.query(query);
      }
    });
    const beforeRoleSafe = (await admin.query(`SELECT prosrc,proowner::text,prosecdef,proconfig,proacl::text
      FROM pg_proc WHERE oid='pactwoven.supplier_role_safe(oid,text)'::regprocedure`)).rows[0];
    // Deliberately seed a default grant only before 0016; its installer must strip
    // it from both new routines. Restore the default immediately afterward.
    const defaultRole = `pactwoven_observer_test_${suffix}_default`;
    await admin.query(`CREATE ROLE ${identifier(defaultRole)} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    await installer.pool.query(`ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO ${identifier(defaultRole)}`);
    try {
      await transaction(installer.pool, async c => {
        for (const statement of migrations[15]!.statements) {
          const query = { text: statement, queryMode: 'extended' };
          await c.query(query);
        }
      });
    } finally { await installer.pool.query(`ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM ${identifier(defaultRole)}`); }
    const sources = await Promise.all([15, 16].map(number => readFile(new URL(`../migrations/${observerMigrationPins[number - 1]![0]}`, import.meta.url), 'utf8')));
    assert.equal(beforeRoleSafe.prosrc, sourceBody(sources[0]!, 'supplier_role_safe'));
    const functionIdentities = ['supplier_role_safe(oid,text)', 'supplier_observer_identity(text,text,jsonb)', observerWrapper];
    const functionFingerprints = async () => {
      const output: FunctionFingerprint[] = [];
      for (const signature of functionIdentities) {
        const row = (await admin.query<FunctionMetadata>(`SELECT p.oid::text,p.prosrc,p.proowner::text,p.prosecdef,p.proconfig,p.proacl::text,
          p.prokind,p.provolatile,p.proleakproof,p.proisstrict,p.proparallel,p.pronargs,p.proargtypes::text AS argument_types,
          p.prorettype::regtype::text AS return_type,l.lanname,
          r.rolname AS owner,r.rolsuper,pg_get_functiondef(p.oid) AS definition
          FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner JOIN pg_language l ON l.oid=p.prolang
          WHERE p.oid=$1::regprocedure`, [`pactwoven.${signature}`])).rows[0];
        assert(row, `Installed routine missing: ${signature}`);
        const acl = (await admin.query<FunctionAcl>(`SELECT a.grantor::text,a.grantee::text AS grantee_oid,coalesce(r.rolname,'PUBLIC') AS grantee,
          a.privilege_type,a.is_grantable FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
          LEFT JOIN pg_roles r ON r.oid=a.grantee WHERE p.oid=$1::regprocedure ORDER BY grantee`, [`pactwoven.${signature}`])).rows;
        output.push({ signature, ...row, acl, definitionSha256: sha(row.definition) });
      }
      return output;
    };
    const installed = await functionFingerprints();
    const roleSafe = installed[0]!;
    const oldTerm = "p.oid=to_regprocedure('pactwoven.supplier_record_evidence(jsonb)')";
    const newTerm = "p.oid=ANY(ARRAY[to_regprocedure('pactwoven.supplier_record_evidence(jsonb)'),to_regprocedure('pactwoven.supplier_resolve_observer(jsonb,jsonb)')]::oid[])";
    assert.equal(roleSafe.prosrc, sourceBody(sources[1]!, 'supplier_role_safe'));
    assert.equal(roleSafe.prosrc.replace(newTerm, oldTerm), beforeRoleSafe.prosrc);
    for (const key of ['proowner', 'prosecdef', 'proconfig', 'proacl'] as const) assert.deepEqual(roleSafe[key], beforeRoleSafe[key]);
    for (const row of installed) {
      assert.equal(row.prosrc, sourceBody(sources[1]!, row.signature.split('(')[0]!));
      assert.equal(row.owner, row.signature.startsWith('supplier_observer_identity(') ? installer.name : 'pactwoven_supplier_executor');
      assert.equal(row.rolsuper, row.signature.startsWith('supplier_observer_identity(') && !installer.managed);
      assert.equal(row.prosecdef, !row.signature.startsWith('supplier_role_safe('));
      assert.equal(row.prokind, 'f'); assert.equal(row.provolatile, 'v'); assert.equal(row.proparallel, 'u');
      assert.equal(row.proleakproof, false); assert.equal(row.proisstrict, false);
      assert.equal(row.lanname, row.prosecdef ? 'plpgsql' : 'sql');
      assert.equal(row.return_type, row.prosecdef ? 'jsonb' : 'boolean');
      assert.equal(row.pronargs, row.signature.startsWith('supplier_observer_identity(') ? 3 : 2);
      assert.deepEqual(row.proconfig, row.prosecdef ? ['search_path=pg_catalog', 'lock_timeout=3s'] : ['search_path=pg_catalog']);
      assert.deepEqual(row.acl.map(grant => grant.grantee).sort(),
        row.signature.startsWith('supplier_observer_identity(') ? ['pactwoven_supplier_executor', installer.name].sort() : ['pactwoven_supplier_executor']);
      for (const grant of row.acl) { assert.equal(grant.privilege_type, 'EXECUTE'); assert.equal(grant.is_grantable, false); assert.equal(grant.grantor, row.proowner); }
    }
    const helperRelations = [...new Set([...installed[1]!.prosrc.matchAll(/(?:FROM|JOIN|LOCK TABLE) pactwoven\.([a-z_]+)/g)].map(match => match[1]!))].sort();
    assert.deepEqual(helperRelations, ['memberships', 'organizations', 'session_revocations']);
    const owners = (await admin.query(`SELECT c.relname,c.relowner::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='pactwoven' AND c.relname=ANY($1) ORDER BY c.relname`, [helperRelations])).rows;
    assert.equal(owners.length, 3); for (const row of owners) assert.equal(row.relowner, installed[1]!.proowner);
    const inventory = async () => {
      const rows: Record<string, { count: number; sha256: string }> = {};
      for (const table of watchedTables) {
        const row = (await admin.query(`SELECT count(*) AS count,coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS contents FROM pactwoven.${table} t`)).rows[0];
        rows[table] = { count: Number(row.count), sha256: sha(JSON.stringify(row.contents)) };
      }
      return rows;
    };
    const emit = async (phase: 'before' | 'after', fingerprints: typeof installed) => process.stdout.write('SUPPLIER_OBSERVER_FIXTURE_ATTESTATION ' +
      JSON.stringify({ phase, migrationPins: observerMigrationPins, functions: fingerprints, identityOwners: owners, helperRelations,
        rowInventory: await inventory(), scenarioCount: scenarioNumber, runtimePrincipalCount: principals.length }) + '\n');
    await emit('before', installed);
    const login = async (capability: 'verifier' | 'authorizer' | 'none', fixedName?: string): Promise<Principal> => {
      const name = fixedName ?? `pactwoven_observer_test_${suffix}_p${++loginNumber}`, password = randomBytes(32).toString('base64url');
      await admin.query(`CREATE ROLE ${identifier(name)} LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD ${literal(password)}`);
      await admin.query(`GRANT USAGE ON SCHEMA pactwoven TO ${identifier(name)}`);
      for (const fn of capability === 'verifier' ? verifierFunctions : capability === 'authorizer' ? observerAuthorizerFunctions : []) {
        await admin.query(`GRANT EXECUTE ON FUNCTION pactwoven.${fn} TO ${identifier(name)}`);
      }
      const pool = new Pool({ ...config, user: name, password, max: 1 }); pools.add(pool);
      const c = await pool.connect(); try { await assertObserverSocket(c, { ...config, user: name }); } finally { c.release(); }
      const oid = Number((await admin.query('SELECT oid FROM pg_roles WHERE rolname=$1', [name])).rows[0].oid);
      const principal = { name, oid, pool }; principals.push(principal); return principal;
    };
    const retire = async (principal: Principal) => {
      if (pools.delete(principal.pool)) await principal.pool.end();
      await admin.query(`ALTER ROLE ${identifier(principal.name)} NOLOGIN`);
      for (const fn of [...verifierFunctions, ...observerAuthorizerFunctions]) await admin.query(`REVOKE ALL ON FUNCTION pactwoven.${fn} FROM ${identifier(principal.name)}`);
      await admin.query(`REVOKE USAGE ON SCHEMA pactwoven FROM ${identifier(principal.name)}`);
    };
    const scenario = async (options: ScenarioOptions = {}) => {
      const number = ++scenarioNumber, party = options.party ?? 'buyer', prefix = `observer_${number}`;
      const organization = `${prefix}_${party}`, actor = `${prefix}_${party}_actor`, externalOrganization = `ext_${organization}`;
      const subject = `subject_${actor}`, externalMember = `member_${actor}`, session = `session_${actor}`;
      const now = Date.now();
      for (const side of ['buyer', 'supplier'] as const) {
        const selected = side === party, org = `${prefix}_${side}`;
        await admin.query(`INSERT INTO pactwoven.organizations(environment,id,external_organization_id,name,status,created_at)
          VALUES('development',$1,$2,$3,$4,$5)`, [org, `ext_${org}`, `Synthetic ${side}`,
          selected ? options.organizationStatus ?? 'active' : 'active', selected ? options.organizationCreatedAt ?? at(now - 60_000) : at(now - 60_000)]);
        if (!selected || !options.omitMember) await admin.query(`INSERT INTO pactwoven.memberships(environment,organization_id,actor_id,external_subject,external_membership_id,
          roles,grant_basis,status,created_at,expires_at) VALUES('development',$1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [org, `${org}_actor`, `subject_${org}_actor`, `member_${org}_actor`, selected ? options.roles ?? [side === 'buyer' ? 'owner' : 'supplier_admin'] : ['supplier_admin'],
          selected ? options.grantBasis ?? 'clerk_admin_bootstrap' : 'internal', selected ? options.memberStatus ?? 'active' : 'active',
          selected ? options.memberCreatedAt ?? at(now - 60_000) : at(now - 60_000), selected ? options.memberExpiresAt ?? null : null]);
      }
      const verifier = await login('verifier'), authorizer = await login('authorizer');
      const binding = await hashBinding({ reference: { id: `${prefix}_binding`, version: 1 }, environment: 'development', effectiveOrganizationId: organization,
        verifier: { oid: verifier.oid, name: verifier.name }, authorizer: { oid: authorizer.oid, name: authorizer.name }, status: 'ACTIVE',
        validFrom: options.bindingValidFrom ?? at(now - 60_000), expiresAt: options.bindingExpiresAt ?? at(now + 3_600_000) });
      await appendBinding(admin, binding);
      const observation = (observed = Date.now()) => ({ subject, externalOrganizationId: externalOrganization, externalMembershipId: externalMember,
        externalRole: 'org:admin', sessionId: session, authenticatedAt: at(observed - 120_000), membershipObservedAt: at(observed), issuer: observerIssuer,
        tokenHash: 'a'.repeat(64), tokenIssuedAt: at(observed), sessionExpiresAt: at(observed + 300_000), observedAt: at(observed),
        expiresAt: at(Math.min(observed + 25_000, Date.parse(binding.expiresAt))) });
      const identityInput = (): SupplierObserverIdentityObservation => {
        const o = observation(); return { identity: { subject, externalOrganizationId: externalOrganization, externalOrganizationName: 'Synthetic organization',
          externalMembershipId: externalMember, externalRole: o.externalRole, sessionId: session, authenticatedAt: o.authenticatedAt, membershipObservedAt: o.membershipObservedAt },
        observation: { issuer: o.issuer, tokenHash: o.tokenHash, tokenIssuedAt: o.tokenIssuedAt, observedAt: o.observedAt, expiresAt: o.sessionExpiresAt } };
      };
      const configuration: SupplierObserverConfiguration = { environment: 'development', issuer: observerIssuer, binding };
      const request = { kind: 'relationship-status', purpose: 'supplier_relationship_status', query: {
        scope: { environment: 'development', buyerOrganizationId: `${prefix}_buyer`, supplierOrganizationId: `${prefix}_supplier`, supplierRelationshipId: `${prefix}_relationship` }, revision: null } } satisfies SupplierPrivateRequest;
      return { organization, actor, subject, externalOrganization, externalMember, session, verifier, authorizer, binding, configuration, request,
        observation, identityInput, repository: () => new PostgresSupplierObserverRepository(verifier.pool, configuration),
        close: async () => { await retire(verifier); await retire(authorizer); } };
    };
    const finish = async () => {
      try {
        for (const principal of principals) if (pools.has(principal.pool)) await retire(principal);
        const live = (await admin.query('SELECT oid FROM pg_roles WHERE oid=ANY($1::oid[]) AND rolcanlogin', [principals.map(principal => principal.oid)])).rows;
        assert.equal(live.length, 0, 'Every fixture runtime login must be retired.');
        if (installer.managed) await admin.query(`ALTER ROLE ${identifier(installer.name)} NOLOGIN`);
        const after = await functionFingerprints(); assert.deepEqual(after, installed, 'Installed routines/ACLs must be restored exactly.');
        await emit('after', after);
      } finally { await close(); }
    };
    return { admin, installer, observerInstallPreflight: migrations[15]!.statements[0]!, scenario, login, retire,
      installed, beforeRoleSafe, helperRelations, inventory, functionFingerprints, finish, close };
  } catch (error) { await close(); throw error; }
}
export type ObserverFixture = Awaited<ReturnType<typeof createObserverFixture>>;
export type ObserverScenario = Awaited<ReturnType<ObserverFixture['scenario']>>;
export type ObserverObservation = ReturnType<ObserverScenario['observation']>;

export async function resolveOn(client: Pool | PoolClient, scenario: ObserverScenario, observation = scenario.observation(), binding = scenario.binding) {
  return (await client.query('SELECT pactwoven.supplier_resolve_observer($1::jsonb,$2::jsonb) AS actor', [binding, observation])).rows[0].actor as SupplierObserverActor;
}
export async function resolveRaw(scenario: ObserverScenario, observation = scenario.observation(), binding = scenario.binding, principal = scenario.verifier) {
  return transaction(principal.pool, client => resolveOn(client, scenario, observation, binding));
}
export async function evidenceFor(scenario: ObserverScenario, actor: SupplierObserverActor, observation: ObserverObservation, request: SupplierPrivateRequest = scenario.request): Promise<SupplierAuthenticationEvidence> {
  const snapshot = await snapshotSupplierPersistenceRequest(request, {
    environment: actor.environment, organizationId: actor.organizationId, actorId: actor.actorId,
  });
  return { schemaVersion: 1, id: randomUUID(), kind: 'identity', actor, binding: scenario.binding, observedBy: scenario.binding.verifier,
    request, requestDigest: snapshot.requestDigest, mutationDigest: snapshot.mutationDigest, observation,
    observedAt: observation.observedAt, expiresAt: observation.expiresAt };
}
export type LockSite = 'registry' | 'lineage' | 'organization' | 'revocation' | 'membership';
const lockStatements: Record<LockSite, string> = {
  registry: 'SELECT pactwoven.supplier_registry_fence(true)',
  lineage: 'SELECT pactwoven.supplier_lineage_fence($1)',
  organization: "SELECT id FROM pactwoven.organizations WHERE environment='development' AND id=$1 FOR UPDATE",
  revocation: 'LOCK TABLE pactwoven.session_revocations IN ROW EXCLUSIVE MODE',
  membership: "SELECT actor_id FROM pactwoven.memberships WHERE environment='development' AND organization_id=$1 AND actor_id=$2 FOR UPDATE",
};
export async function waitUntilDatabase(admin: Pool, instant: string) {
  const deadline = Date.now() + 2_200;
  while (Date.now() < deadline) {
    if ((await admin.query('SELECT clock_timestamp()>$1::timestamptz AS reached', [instant])).rows[0].reached) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Bounded database-time transition was not reached.');
}
export async function withBlockedObserver<T>(fixture: ObserverFixture, scenario: ObserverScenario, site: LockSite,
  work: (context: { blocker: PoolClient; result: Promise<{ value?: SupplierObserverActor; error?: unknown }>; release: () => Promise<void>;
    waiter: number; holder: number }) => Promise<T>, observation = scenario.observation(), statementTimeoutMs = 5_000) {
  const blocker = await fixture.admin.connect();
  let reader: PoolClient;
  try { reader = await scenario.verifier.pool.connect(); } catch (error) { blocker.release(); throw error; }
  let released = false, settled = false;
  let pending: Promise<{ value?: SupplierObserverActor; error?: unknown }> | undefined;
  try {
    await blocker.query('BEGIN');
    if (site === 'membership') await blocker.query("SELECT id FROM pactwoven.organizations WHERE environment='development' AND id=$1 FOR SHARE", [scenario.organization]);
    const values = site === 'lineage' ? [scenario.binding.reference.id] : site === 'organization' ? [scenario.organization] : site === 'membership' ? [scenario.organization, scenario.actor] : [];
    await blocker.query(lockStatements[site], values);
    await reader.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    assert([5_000, 300].includes(statementTimeoutMs));
    await reader.query(`SET LOCAL statement_timeout='${statementTimeoutMs}ms'`);
    const holder = Number((await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    const waiter = Number((await reader.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    pending = resolveOn(reader, scenario, observation).then(value => ({ value }), error => ({ error }));
    void pending.then(() => { settled = true; });
    const deadline = Date.now() + 1_000;
    let witnessed = false;
    while (Date.now() < deadline && !settled) {
      const row = (await fixture.admin.query(`SELECT $2::int=ANY(pg_blocking_pids($1::int)) AS blocked,
        (SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1::int) AS wait_type`, [waiter, holder])).rows[0];
      if (row.blocked && row.wait_type === 'Lock') { witnessed = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert(witnessed && !settled, `Observer must actually wait at ${site} behind the exact holder.`);
    const release = async () => { assert(!released); await blocker.query('COMMIT'); released = true; };
    return await work({ blocker, result: pending, release, waiter, holder });
  } finally {
    if (!released) await blocker.query('ROLLBACK').catch(() => {});
    if (pending) await pending;
    await reader.query('ROLLBACK').catch(() => {});
    blocker.release(); reader.release();
  }
}
