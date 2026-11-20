import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { Socket } from 'node:net';
import { TLSSocket } from 'node:tls';
import { Pool, type PoolClient, type PoolConfig } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { commandDigest } from '@pactwoven/domain';
import { supplierEnrollmentPublicRequestDigest, type SupplierEnrollmentSelection } from '@pactwoven/contracts';
import { loadMigrations } from './migrate.js';
import { PostgresSupplierAdmissionEvidenceRepository, PostgresSupplierAdmissionRepository } from './supplier-admission-repository.js';
import { SupplierAdmissionEvidenceSchema, supplierAdmissionCandidateDigest, supplierAdmissionLaneDigest, supplierAdmissionRequestDigest,
  type SupplierAdmissionActor, type SupplierAdmissionPrivateRequest, type SupplierAdmissionConfiguration,
  type SupplierAdmissionCandidateObservationSchema } from './supplier-admission-persistence-schema.js';
import type { z } from 'zod';
import { SupplierAuthenticationEvidenceSchema } from './supplier-relationship-auth-evidence.js';
import { snapshotSupplierPersistenceRequest, type SupplierPrivateRequest } from './supplier-relationship-persistence-schema.js';
import { PostgresSupplierAuthenticationRepository, PostgresSupplierRelationshipRepository } from './supplier-relationship-repository.js';

const originalMigrationPins = [
  [
    "0001_foundation.sql",
    "9497eba5975fb487d3fc80480f559afb2b3a7d9387a30b287ecaec459867ff57"
  ],
  [
    "0002_organization_bootstrap.sql",
    "decfb9c2fbcba32009b7939336201a200511aa240abac5d3cb6ba7853c834347"
  ],
  [
    "0003_identity_access.sql",
    "248a396a9e1414e22a90b1a49f8aeef48cc400a1eb1a539a0fae42ca02eb93af"
  ],
  [
    "0004_mandate_authority.sql",
    "2c5da97dc24c1a76419f59c6eeea662e0cdfc2281d3c6b9b9fbfed84b82f9281"
  ],
  [
    "0005_access_acceptance.sql",
    "573fedfe36df2955cb9339d2fb4f30fdfe9de008cd51941ee2e5577c0ad8490b"
  ],
  [
    "0006_access_recovery_fences.sql",
    "1dc1fd0b8d731e3752144786136437e9224cdd5818f01e4e1591aaca46feca0e"
  ],
  [
    "0007_finance_provenance.sql",
    "75ff22e258b2b8b8e0f3eeb32ceb6621246038ba2cb71f62178e651c58eb7a6a"
  ],
  [
    "0008_financial_authority_fences.sql",
    "b46d6d74b8f53f56ff93e2e83d29b7174d2c8e659bb212640decfc0e0fec2bce"
  ],
  [
    "0009_custody_setup_owner_bindings.sql",
    "303116084a84deab26cb27091d62375e47be49018c8dcb366b4bd06dc6a79317"
  ],
  [
    "0010_custody_setup_private_reads.sql",
    "699004eff30b8dacb33ccef4955a092a64ed166ed16d38d9183389af9dbf6e9b"
  ],
  [
    "0011_financial_policy_authority.sql",
    "5819917e06190dee62b74f022ff995af1e2efc8321eb66979663e11508687117"
  ],
  [
    "0012_financial_policy_private_reads.sql",
    "b43480fcc62cbd384ea484f7cfc81e79fe178861d39d0e5c9a61d07df29b2588"
  ],
  [
    "0013_financial_policy_preparation.sql",
    "9d08d5f3a68608265df2f497c3bb0d78cc35c40cc854c13dfa2f64437b683927"
  ],
  [
    "0014_supplier_identity_versions.sql",
    "1cb551bb5e8872cd49f438cd3574bda9dcf5b763a6806567441394c50affc0c7"
  ],
  [
    "0015_supplier_relationship_authority.sql",
    "9e2e58c8495038812317e0e654e1490c2a90e76c35c6576c4f4f5fbab33572f3"
  ],
  [
    "0016_supplier_observer_resolution.sql",
    "b02d39eb7d0970d182f7b3c9226920a8f61eb63defe2b13179d48647d7cf16bc"
  ],
  [
    "0017_managed_postgres_qualification.sql",
    "5889ae41058e87e5242370ce0a1bfd599a6403ec89a9ece64bf56d01184c6013"
  ],
  [
    "0018_bootstrap_site_read_grant.sql",
    "901dda475616a04408db613efb69b7bd22f1a04ad8cc983afb47afca0f41ed55"
  ],
  [
    "0019_financial_policy_request_fences.sql",
    "b3e191ef6ca46910bcc30a0b0c5eb87caab6a25c256a79ef06a14e219c7e7ddf"
  ]
] as const;

const fixtureRoot = '/Users/richkay/Desktop/code/pactwoven/.local/supplier-admission-db-r4/native-55445';
const fixtureFile = fixtureRoot + '/admin-url';
const fixtureVariable = 'PACTWOVEN_SUPPLIER_ADMISSION_TEST_ADMIN_URL_FILE';
const consentVariable = 'PACTWOVEN_SUPPLIER_ADMISSION_DISPOSABLE';
const fixturePort = 55445, fixtureDatabase = 'pactwoven_supplier_admission_sql_test', fixtureAdmin = 'supplier_admission_fixture_admin';

function fixtureConfig(value: string): PoolConfig {
  const url = new URL(value), password = decodeURIComponent(url.password);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1' || url.port !== String(fixturePort) ||
    url.pathname !== '/' + fixtureDatabase || decodeURIComponent(url.username) !== fixtureAdmin || url.search || url.hash || !/^[a-f0-9]{64}$/.test(password))
    throw new Error('Exact new supplier admission fixture URL required.');
  return { host: '127.0.0.1', port: fixturePort, database: fixtureDatabase, user: fixtureAdmin, password,
    ssl: false, max: 4, connectionTimeoutMillis: 3000, statement_timeout: 5000, idle_in_transaction_session_timeout: 8000,
    options: '-c transaction_timeout=10s', application_name: 'supplier-admission-disposable-test' };
}
async function readFixtureConfig(environment: NodeJS.ProcessEnv = process.env) {
  if (environment[fixtureVariable] !== fixtureFile || environment[consentVariable] !== 'YES_NEW_LOCAL_ONLY' ||
    Object.keys(environment).some(key => key.startsWith('PG') || key.startsWith('PACTWOVEN_') && ![fixtureVariable, consentVariable].includes(key)))
    throw new Error('Exact supplier admission fixture opt-in and scrubbed environment required.');
  const uid = process.getuid?.(), before = await lstat(fixtureFile), root = await lstat(fixtureRoot);
  if (uid === undefined || uid === 0 || await realpath(fixtureRoot) !== fixtureRoot || root.isSymbolicLink() || !root.isDirectory() || root.uid !== uid || (root.mode & 0o777) !== 0o700 ||
    !before.isFile() || before.isSymbolicLink() || before.uid !== uid || (before.mode & 0o777) !== 0o600 || before.size < 1 || before.size > 8192)
    throw new Error('Owned private supplier admission fixture root/file required.');
  const file = await open(fixtureFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await file.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.uid !== uid || !opened.isFile() ||
      (opened.mode & 0o777) !== 0o600 || opened.size !== before.size) throw new Error('Supplier admission fixture file changed.');
    const bytes = Buffer.alloc(8193), { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    const after = await file.stat(), named = await lstat(fixtureFile);
    if (bytesRead !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||
      named.dev !== after.dev || named.ino !== after.ino || named.isSymbolicLink()) throw new Error('Supplier admission fixture file changed during read.');
    return fixtureConfig(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead)).trim());
  } finally { await file.close(); }
}
async function assertFixtureSocket(client: PoolClient, config: PoolConfig) {
  const stream = (client as PoolClient & { connection?: { stream?: unknown } }).connection?.stream;
  if (!(stream instanceof Socket) || stream instanceof TLSSocket || stream.readyState !== 'open' || stream.destroyed ||
    stream.remotePort !== fixturePort || !['127.0.0.1', '::ffff:127.0.0.1'].includes(stream.remoteAddress ?? ''))
    throw new Error('Exact supplier admission loopback socket required.');
  const row = (await client.query(`SELECT current_database() AS database,current_user AS principal,session_user AS session,
    current_setting('server_version_num')::int AS version,current_setting('data_directory') AS data,
    current_setting('transaction_timeout')::interval=interval '10 seconds' AS bounded`)).rows[0];
  if (row?.database !== fixtureDatabase || row.principal !== config.user || row.session !== config.user ||
    ![170011, 170012].includes(row.version) || row.data !== fixtureRoot + '/data' || row.bounded !== true)
    throw new Error('Exact qualified supplier admission fixture server/login/root required.');
}

describe('supplier admission native fixture admission guards', () => {
  const valid = 'postgresql://' + fixtureAdmin + ':' + 'a'.repeat(64) + '@127.0.0.1:55445/' + fixtureDatabase;
  it('accepts only the exact new loopback database, login and explicit port', () => {
    expect(fixtureConfig(valid)).toMatchObject({ host: '127.0.0.1', port: 55445, database: fixtureDatabase, user: fixtureAdmin, ssl: false });
    for (const changed of [valid.replace('55445', '55439'), valid.replace('55445', '55444'), valid.replace('127.0.0.1', 'localhost'),
      valid.replace(fixtureDatabase, 'postgres'), valid.replace(fixtureAdmin, 'postgres'), valid + '?sslmode=disable', valid + '#fragment',
      valid.replace('127.0.0.1', 'database.example.test')]) expect(() => fixtureConfig(changed)).toThrow('Exact new');
  });
  it('refuses missing consent, alternate credential paths and ambient PG or other fixture variables before reading a file', async () => {
    for (const environment of [{}, { [fixtureVariable]: fixtureFile }, { [fixtureVariable]: '/tmp/another-file', [consentVariable]: 'YES_NEW_LOCAL_ONLY' },
      { [fixtureVariable]: fixtureFile, [consentVariable]: 'YES_NEW_LOCAL_ONLY', PGHOST: '127.0.0.1' },
      { [fixtureVariable]: fixtureFile, [consentVariable]: 'YES_NEW_LOCAL_ONLY', PACTWOVEN_OTHER_FIXTURE: 'yes' }])
      await expect(readFixtureConfig(environment)).rejects.toThrow('opt-in');
  });
});

const instant = (milliseconds: number) => new Date(milliseconds).toISOString();
type Binding = SupplierAdmissionConfiguration['binding'];
type Candidate = z.infer<typeof SupplierAdmissionCandidateObservationSchema>;
type Principal = { name: string; oid: number; pool: Pool };
type Scenario = { buyer: string; supplier: string; supplierBinding: Binding; buyerBinding: Binding; config: SupplierAdmissionConfiguration;
  verifier: Principal; authorizer: Principal; buyerVerifier: Principal; buyerAuthorizer: Principal; close: () => Promise<void> };
const identifier = (name: string) => {
  assert(/^pw_adm_[a-z0-9_]{1,45}$/.test(name)); return '"' + name + '"';
};
async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try { await client.query('BEGIN ISOLATION LEVEL READ COMMITTED'); const value = await work(client); await client.query('COMMIT'); return value; }
  catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
}

describe.skipIf(!process.env[fixtureVariable])('isolated supplier admission native database', () => {
  let admin: Pool, config: PoolConfig;
  const worlds: Scenario[] = [];
  beforeAll(async () => {
    config = await readFixtureConfig(); admin = new Pool(config);
    const client = await admin.connect();
    try {
      await assertFixtureSocket(client, config);
      const row = (await client.query(`SELECT r.rolsuper,
        (SELECT count(*)::int FROM pg_namespace WHERE nspname='pactwoven') AS schemas,
        (SELECT count(*)::int FROM pg_roles WHERE rolname LIKE 'pactwoven_%') AS roles
        FROM pg_roles r WHERE r.rolname=session_user`)).rows[0];
      assert.deepEqual(row, { rolsuper: true, schemas: 0, roles: 0 }, 'Fresh empty isolated cluster only; no reset path.');
    } finally { client.release(); }
    const migrations = await loadMigrations();
    assert.equal(migrations.length, 20);
    assert.deepEqual(migrations.slice(0, 19).map(m => [m.filename, m.checksum]), originalMigrationPins);
    for (const migration of migrations) await transaction(admin, async client => {
      if (migration.filename === '0020_supplier_admission.sql') {
        await client.query('CREATE ROLE pw_adm_default_grantee NOLOGIN');
        await client.query('ALTER DEFAULT PRIVILEGES IN SCHEMA pactwoven GRANT SELECT ON TABLES TO pw_adm_default_grantee');
        await client.query('ALTER DEFAULT PRIVILEGES IN SCHEMA pactwoven GRANT EXECUTE ON FUNCTIONS TO pw_adm_default_grantee');
      }
      for (const [index, statement] of migration.statements.entries()) {
        const query = { text: statement, queryMode: 'extended' };
        try { await client.query(query); }
        catch (error) { throw new Error('Migration ' + migration.filename + ' statement ' + index + ': ' + (error instanceof Error ? error.message : 'SQL failure')); }
      }
    });
  }, 60_000);
  afterAll(async () => {
    for (const world of worlds) await world.close();
    await admin?.end();
  });
  async function scenario(): Promise<Scenario> {
    const suffix = randomBytes(4).toString('hex'), buyer = 'buyer_' + suffix, supplier = 'supplier_' + suffix;
    for (const organization of [buyer, supplier]) {
      await admin.query("INSERT INTO pactwoven.organizations(environment,id,external_organization_id,name) VALUES('development',$1,$2,$3)", [organization, 'external_' + organization, 'Synthetic ' + organization]);
      await admin.query(`INSERT INTO pactwoven.memberships(environment,organization_id,actor_id,external_subject,external_membership_id,grant_basis,roles,display_name)
        VALUES('development',$1,$2,$3,$4,'clerk_admin_bootstrap',ARRAY['owner'],'Synthetic owner')`, [organization, organization + '_owner', organization + '_subject', organization + '_external_member']);
    }
    await admin.query(`INSERT INTO pactwoven.memberships(environment,organization_id,actor_id,external_subject,external_membership_id,grant_basis,roles,display_name)
      VALUES('development',$1,$2,$3,$4,'owner_grant',ARRAY['receiver'],'Synthetic receiver')`, [supplier, supplier + '_other', supplier + '_other_subject', supplier + '_other_external_member']);
    await admin.query("INSERT INTO pactwoven.sites(environment,organization_id,id,name,time_zone) VALUES('development',$1,$2,'Synthetic site','America/Chicago')", [buyer, buyer + '_site']);
    const principals: Principal[] = [];
    const login = async (suffix: string, capability: 'verifier' | 'authorizer') => {
      const name = 'pw_adm_' + randomBytes(5).toString('hex') + '_' + suffix, password = randomBytes(32).toString('hex');
      await admin.query(`CREATE ROLE ${identifier(name)} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
      await admin.query(`GRANT USAGE ON SCHEMA pactwoven TO ${identifier(name)}`);
      const signatures = capability === 'verifier' ? ['supplier_record_evidence(jsonb)', 'supplier_resolve_observer(jsonb,jsonb)', 'supplier_admission_record_evidence(jsonb)'] :
        ['supplier_scope_policy_command(uuid,jsonb)', 'supplier_scope_policy_read(uuid,jsonb)', 'supplier_relationship_command(uuid,jsonb)',
          'supplier_relationship_status(uuid,jsonb)', 'supplier_relationship_recover(uuid,jsonb)', 'supplier_admission_execute(uuid,jsonb)'];
      for (const signature of signatures) await admin.query(`GRANT EXECUTE ON FUNCTION pactwoven.${signature} TO ${identifier(name)}`);
      const oid = Number((await admin.query('SELECT oid FROM pg_roles WHERE rolname=$1', [name])).rows[0].oid);
      const principal = { name, oid, pool: new Pool({ ...config, user: name, password, max: 2 }) };
      principals.push(principal);return principal;
    };
    const buyerVerifier = await login('bv', 'verifier'), buyerAuthorizer = await login('ba', 'authorizer');
    const verifier = await login('sv', 'verifier'), authorizer = await login('sa', 'authorizer');
    const stamp = Date.now(), validFrom = instant(stamp - 60_000), expiresAt = instant(stamp + 3_600_000);
    const binding = async (organization: string, v: Principal, a: Principal) => {
      const input = { reference: { id: organization + '_binding', version: 1 }, environment: 'development' as const, effectiveOrganizationId: organization,
        verifier: { name: v.name, oid: v.oid }, authorizer: { name: a.name, oid: a.oid }, status: 'ACTIVE' as const, validFrom, expiresAt };
      const result = { ...input, reference: { ...input.reference, hash: await commandDigest({ namespace: 'pactwoven/supplier-private-binding/v1', binding: input }) } };
      await admin.query(`INSERT INTO pactwoven.supplier_private_bindings(id,version,environment,effective_organization_id,verifier_oid,verifier_name,
        authorizer_oid,authorizer_name,status,valid_from,expires_at,body) VALUES($1,1,'development',$2,$3,$4,$5,$6,'ACTIVE',$7,$8,$9)`,
      [result.reference.id, organization, v.oid, v.name, a.oid, a.name, validFrom, expiresAt, result]);return result;
    };
    const buyerBinding = await binding(buyer, buyerVerifier, buyerAuthorizer), supplierBinding = await binding(supplier, verifier, authorizer);
    const lane: SupplierAdmissionConfiguration['lane'] = { schemaVersion: 1, reference: { id: supplier + '_lane', version: 1, hash: 'a'.repeat(64) }, environment: 'development',
      buyerOrganizationId: buyer, supplierOrganizationId: supplier, buyerBinding: buyerBinding.reference, supplierBinding: supplierBinding.reference, status: 'ACTIVE', validFrom, expiresAt };
    lane.reference.hash = await supplierAdmissionLaneDigest(lane);
    await admin.query(`INSERT INTO pactwoven.supplier_admission_lanes(id,version,hash,environment,buyer_organization_id,supplier_organization_id,
      buyer_binding_id,buyer_binding_version,buyer_binding_hash,supplier_binding_id,supplier_binding_version,supplier_binding_hash,status,valid_from,expires_at,body)
      VALUES($1,1,$2,'development',$3,$4,$5,1,$6,$7,1,$8,'ACTIVE',$9,$10,$11)`,
    [lane.reference.id, lane.reference.hash, buyer, supplier, buyerBinding.reference.id, buyerBinding.reference.hash, supplierBinding.reference.id, supplierBinding.reference.hash, validFrom, expiresAt, lane]);
    let closed = false;
    const world: Scenario = { buyer, supplier, buyerBinding, supplierBinding, buyerVerifier, buyerAuthorizer, verifier, authorizer,
      config: { issuer: 'https://synthetic.invalid', binding: supplierBinding, lane }, close: async () => {
        if (closed) return;closed = true;
        await Promise.all(principals.map(p => p.pool.end()));
        for (const p of principals) await admin.query(`ALTER ROLE ${identifier(p.name)} NOLOGIN`);
      } };
    worlds.push(world);return world;
  }
  async function actor(world: Scenario, organization = world.supplier, member = organization + '_owner'): Promise<SupplierAdmissionActor> {
    const row = (await admin.query(`SELECT m.actor_id,m.external_subject,m.external_membership_id,m.row_version AS member_version,o.row_version AS org_version,o.authority_epoch
      FROM pactwoven.memberships m JOIN pactwoven.organizations o ON (o.environment,o.id)=(m.environment,m.organization_id)
      WHERE m.environment='development' AND m.organization_id=$1 AND m.actor_id=$2`, [organization, member])).rows[0];
    return { actorId: row.actor_id, membershipId: row.actor_id, membershipVersion: row.member_version, environment: 'development', organizationId: organization,
      organizationVersion: row.org_version, organizationEpoch: row.authority_epoch, principalKind: 'human', subject: row.external_subject,
      externalOrganizationId: 'external_' + organization, externalMembershipId: row.external_membership_id, sessionId: organization + '_session' };
  }
  async function candidate(world: Scenario, mode: 'self' | 'other' | 'absent' = 'self', stamp = Date.now()): Promise<Candidate> {
    const label = mode === 'self' ? '' : '_' + mode;
    const value: Candidate = { reference: { id: world.supplier + label + '_candidate', version: 1, hash: 'a'.repeat(64) }, principalKind: 'human', displayName: 'Synthetic ' + mode,
      observation: { issuer: 'https://synthetic.invalid', subject: world.supplier + label + '_subject', externalOrganizationId: 'external_' + world.supplier,
        externalMembershipId: world.supplier + label + '_external_member', externalRole: mode === 'self' ? 'org:admin' : 'org:member', status: 'ACTIVE', observedAt: instant(stamp), expiresAt: instant(stamp + 20_000) } };
    value.reference.hash = await supplierAdmissionCandidateDigest(value, 'development', world.supplier);return value;
  }
  async function evidence(world: Scenario, request: SupplierAdmissionPrivateRequest, mode: 'self' | 'other' | 'absent' = 'self') {
    const a = await actor(world), stamp = Date.now(), observedAt = instant(stamp), expiresAt = instant(stamp + 20_000), issued = instant(stamp - 1000);
    const observation = { subject: a.subject, externalOrganizationId: a.externalOrganizationId, externalMembershipId: a.externalMembershipId,
      externalRole: 'org:admin', sessionId: a.sessionId, authenticatedAt: instant(stamp - 120_000), membershipObservedAt: observedAt,
      issuer: 'https://synthetic.invalid', tokenHash: 'a'.repeat(64), tokenIssuedAt: issued, sessionExpiresAt: instant(stamp + 300_000), observedAt, expiresAt };
    const base = { schemaVersion: 1, id: randomUUID(), actor: a, binding: world.supplierBinding, lane: world.config.lane, request,
      requestDigest: await supplierAdmissionRequestDigest(request, a), mutationDigest: request.kind === 'enrollment-command' ? await supplierEnrollmentPublicRequestDigest(request.mutation) : null,
      observation, target: ['enrollment-review', 'enrollment-command'].includes(request.kind) ? await candidate(world, mode, stamp) : null, observedAt, expiresAt };
    return SupplierAdmissionEvidenceSchema.parse(request.kind === 'enrollment-command' ? { ...base, kind: 'factors', source: {
      kind: 'CLERK_FVA', tokenHash: observation.tokenHash, tokenIssuedAt: issued, firstFactorAgeMinutes: 0, secondFactorAgeMinutes: 0,
      firstFactorAt: instant(stamp - 61_000), secondFactorAt: instant(stamp - 61_000), verifiedAt: instant(stamp - 61_000),
    } } : { ...base, kind: 'identity' });
  }
  async function call(world: Scenario, request: SupplierAdmissionPrivateRequest, mode: 'self' | 'other' | 'absent' = 'self') {
    const input = await evidence(world, request, mode);
    const handle = await new PostgresSupplierAdmissionEvidenceRepository(world.verifier.pool, world.config).append(input, request, input.actor);
    return new PostgresSupplierAdmissionRepository(world.authorizer.pool, world.config).execute(handle);
  }
  async function review(world: Scenario, mode: 'self' | 'other' | 'absent' = 'self', selected?: SupplierEnrollmentSelection) {
    const selection = selected ?? { action: 'grant' as const, candidate: (await candidate(world, mode)).reference, expiresAt: instant(Date.now() + 600_000) };
    const result = await call(world, { kind: 'enrollment-review', purpose: 'supplier_administrator_review', query: { schemaVersion: 1, selection } }, mode);
    assert.equal(result.kind, 'SUPPLIER_ENROLLMENT_REVIEW');if (result.kind !== 'SUPPLIER_ENROLLMENT_REVIEW') throw new Error('Exact review required');return result;
  }
  const command = (r: Awaited<ReturnType<typeof review>>): SupplierAdmissionPrivateRequest => ({ kind: 'enrollment-command',
    purpose: ('supplier_administrator_' + r.material.selection.action) as 'supplier_administrator_grant' | 'supplier_administrator_renew' | 'supplier_administrator_revoke',
    mutation: { idempotencyKey: 'original_' + randomUUID(), command: { schemaVersion: 1, role: 'supplier_admin', selection: r.material.selection, basis: r.material.basis, reviewHash: r.reviewHash } } });

  async function legacy(world: Scenario, request: SupplierPrivateRequest, party: 'buyer' | 'supplier' = 'supplier', member?: string) {
    const organization = party === 'buyer' ? world.buyer : world.supplier, a = await actor(world, organization, member);
    const binding = party === 'buyer' ? world.buyerBinding : world.supplierBinding;
    const verifier = party === 'buyer' ? world.buyerVerifier : world.verifier, authorizer = party === 'buyer' ? world.buyerAuthorizer : world.authorizer;
    const stamp = Date.now(), observation = { subject: a.subject, externalOrganizationId: a.externalOrganizationId, externalMembershipId: a.externalMembershipId,
      externalRole: 'org:admin', sessionId: a.sessionId, authenticatedAt: instant(stamp - 120_000), membershipObservedAt: instant(stamp),
      issuer: 'https://synthetic.invalid', tokenHash: 'a'.repeat(64), tokenIssuedAt: instant(stamp), sessionExpiresAt: instant(stamp + 300_000),
      observedAt: instant(stamp), expiresAt: instant(stamp + 20_000) };
    const snap = await snapshotSupplierPersistenceRequest(request, { environment: a.environment, organizationId: a.organizationId, actorId: a.actorId }), mutation = ['policy-command', 'relationship-command'].includes(request.kind);
    const input = SupplierAuthenticationEvidenceSchema.parse({ schemaVersion: 1, id: randomUUID(), actor: a, binding, observedBy: binding.verifier,
      request, requestDigest: snap.requestDigest, mutationDigest: snap.mutationDigest, observation, observedAt: observation.observedAt, expiresAt: observation.expiresAt,
      ...(mutation ? { kind: 'factors', source: { kind: 'CLERK_FVA', tokenHash: observation.tokenHash, tokenIssuedAt: observation.tokenIssuedAt,
        firstFactorAgeMinutes: 0, secondFactorAgeMinutes: 0, firstFactorAt: instant(stamp - 60_000), secondFactorAt: instant(stamp - 60_000), verifiedAt: instant(stamp - 60_000) } } : { kind: 'identity' }) });
    const handle = await new PostgresSupplierAuthenticationRepository(verifier.pool, binding).append(input, request, a);
    return new PostgresSupplierRelationshipRepository(authorizer.pool, binding).execute(handle, request);
  }
  const pair = (world: Scenario) => ({ environment: 'development' as const, buyerOrganizationId: world.buyer, supplierOrganizationId: world.supplier });
  const plan = (world: Scenario): SupplierPrivateRequest => ({ kind: 'relationship-observation-plan', purpose: 'supplier_relationship_observation_plan',
    query: { scope: { ...pair(world), supplierRelationshipId: world.supplier + '_relationship' } } });
  async function waitForLock(principal: string) {
    const until = Date.now() + 2000;
    while (Date.now() < until) {
      const rows = (await admin.query("SELECT pid FROM pg_stat_activity WHERE usename=$1 AND wait_event_type='Lock'", [principal])).rows;
      if (rows.length) return rows[0].pid as number;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('The expected real database lock wait did not occur.');
  }
  async function counts(world: Scenario) {
    return (await admin.query(`SELECT
      (SELECT count(*)::int FROM pactwoven.supplier_administrator_grants WHERE organization_id=$1) AS grants,
      (SELECT count(*)::int FROM pactwoven.supplier_admission_receipts WHERE organization_id=$1) AS receipts,
      (SELECT count(*)::int FROM pactwoven.supplier_admission_contexts WHERE organization_id=$1) AS contexts,
      (SELECT row_version FROM pactwoven.organizations WHERE id=$1) AS organization_version`, [world.supplier])).rows[0];
  }
  const mutationResult = (value: Awaited<ReturnType<typeof call>>) => {
    if (value.kind !== 'SUPPLIER_ENROLLMENT_COMMAND') throw new Error('Exact command result required');return value;
  };
  it('installs exactly the source-pinned history and keeps new entrypoints private', async () => {
    const rows = (await admin.query(`SELECT p.proname,p.prosecdef,r.rolname AS owner,p.proconfig,
      coalesce((SELECT bool_or(a.grantee=0) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a),false) AS public
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner
      WHERE n.nspname='pactwoven' AND p.proname IN('supplier_admission_execute','supplier_admission_record_evidence','supplier_admission_identity_apply')`)).rows;
    expect(rows).toHaveLength(3);
    expect(rows.every(row => row.prosecdef && row.public === false && row.proconfig.includes('search_path=pg_catalog'))).toBe(true);
    expect(rows.find(row => row.proname === 'supplier_admission_identity_apply')?.owner).toBe(fixtureAdmin);
    expect(rows.filter(row => row.proname !== 'supplier_admission_identity_apply').every(row => row.owner === 'pactwoven_supplier_executor')).toBe(true);
    const tables = (await admin.query(`SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,r.rolname AS owner,
      has_table_privilege('pw_adm_default_grantee',c.oid,'SELECT') AS inherited_default
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner
      WHERE n.nspname='pactwoven' AND (c.relname LIKE 'supplier_admission_%' OR c.relname IN('supplier_administrator_grants','supplier_administrator_current')) AND c.relkind IN('r','v')`)).rows;
    expect(tables).toHaveLength(7);expect(tables.every(row => row.owner === 'pactwoven_supplier_owner' && !row.inherited_default)).toBe(true);
    expect(tables.filter(row => row.relname !== 'supplier_administrator_current').every(row => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);
    expect((await admin.query(`SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='pactwoven' AND (p.proname LIKE 'supplier_admission_%' OR p.proname IN('site_descriptor_hash','guard_site_descriptor_version'))
      AND has_function_privilege('pw_adm_default_grantee',p.oid,'EXECUTE')`)).rows[0].n).toBe(0);
    // Local fixture owner is deliberately superuser. This does not qualify a
    // managed hosted owner or claim that AUTH-SQL-04 is least privilege.
    expect((await admin.query('SELECT rolsuper FROM pg_roles WHERE rolname=$1', [fixtureAdmin])).rows[0].rolsuper).toBe(true);
  });
  it('enrolls an explicit owner and recovers the exact original under current identity without repeating the effect', async () => {
    const world = await scenario(), r = await review(world), q = command(r), result = await call(world, q);
    assert.equal(result.kind, 'SUPPLIER_ENROLLMENT_COMMAND');if (result.kind !== 'SUPPLIER_ENROLLMENT_COMMAND') throw new Error('Command result required');
    expect(result.outcome).toBe('APPENDED');expect(result.original.receipt.result.record.target.membershipVersion).toBe(2);
    const recovered = await call(world, { kind: 'enrollment-recover', purpose: 'supplier_administrator_recover', query: result.request });
    expect(recovered).toMatchObject({ kind: 'SUPPLIER_ENROLLMENT_RECOVERY', status: 'RECORDED', original: result.original });
    const context = await call(world, { kind: 'context', purpose: 'supplier_admission_context', query: {} });
    expect(context).toMatchObject({ administration: { owner: true, supplierAdministrator: true }, limitations: { paymentAuthority: false } });
    expect((await admin.query('SELECT count(*)::int AS n FROM pactwoven.supplier_admission_receipts WHERE organization_id=$1', [world.supplier])).rows[0].n).toBe(1);
    await world.close();
  });
  it('enrolls an exact current other member or absent local candidate without copying unrelated rights', async () => {
    for (const mode of ['other', 'absent'] as const) {
      const world = await scenario(), r = await review(world, mode), result = await call(world, command(r), mode);
      if (result.kind !== 'SUPPLIER_ENROLLMENT_COMMAND') throw new Error('Command result required');
      const member = (await admin.query('SELECT roles,expires_at,status FROM pactwoven.memberships WHERE organization_id=$1 AND actor_id=$2',
        [world.supplier, result.original.receipt.result.record.target.actorId])).rows[0];
      expect(member.roles).toEqual(mode === 'other' ? ['receiver', 'supplier_admin'] : ['supplier_admin']);
      expect(member.expires_at).toBeNull();expect(member.status).toBe('active');
      expect((await admin.query('SELECT count(*)::int AS n FROM pactwoven.site_memberships WHERE organization_id=$1', [world.supplier])).rows[0].n).toBe(0);
      await world.close();
    }
  });
  it('denies invented owners, service issuers, provider rebinding and supplier administrators delegating', async () => {
    for (const roles of [['receiver'], ['owner', 'service'], ['supplier_admin']]) {
      const world = await scenario();
      await admin.query('UPDATE pactwoven.memberships SET roles=$2 WHERE organization_id=$1 AND actor_id=$3', [world.supplier, roles, world.supplier + '_owner']);
      await expect(review(world, 'other')).rejects.toMatchObject({ code: 'SUPPLIER_ADMISSION_DENIED' });
      expect((await counts(world)).grants).toBe(0);await world.close();
    }
    const world = await scenario(), r = await review(world, 'other'), q = command(r), input = await evidence(world, q, 'other');
    if (input.target === null) throw new Error('Target required');
    input.target.observation.externalMembershipId = world.supplier + '_external_member';
    input.target.reference.hash = await supplierAdmissionCandidateDigest(input.target, 'development', world.supplier);
    await expect(world.verifier.pool.query('SELECT pactwoven.supplier_admission_record_evidence($1::jsonb)', [input])).rejects.toMatchObject({ code: 'SA001' });
    const good = await evidence(world, q, 'other');
    await expect(world.buyerVerifier.pool.query('SELECT pactwoven.supplier_admission_record_evidence($1::jsonb)', [good])).rejects.toMatchObject({ code: 'SA001' });
    expect((await counts(world)).grants).toBe(0);await world.close();
  });
  it('renews and revokes self and the last role while preserving unrelated rights and monotonic fences', async () => {
    for (const mode of ['self', 'other', 'absent'] as const) {
      const world = await scenario(), first = mutationResult(await call(world, command(await review(world, mode)), mode));
      const grant = first.original.receipt.result;
      const renewed = mutationResult(await call(world, command(await review(world, mode, { action: 'renew', grant: grant.reference, expiresAt: instant(Date.now() + 700_000) })), mode));
      const next = renewed.original.receipt.result;
      expect(next.record.target.membershipVersion).toBe(grant.record.target.membershipVersion + 1);
      expect(next.record.organizationVersion).toBe(grant.record.organizationVersion + 1);expect(next.record.authorityEpoch).toBe(grant.record.authorityEpoch + 1);
      const stopped = mutationResult(await call(world, command(await review(world, mode, { action: 'revoke', grant: next.reference })), mode));
      expect(stopped.original.receipt.result.record.status).toBe('REVOKED');
      const row = (await admin.query('SELECT roles,status,expires_at FROM pactwoven.memberships WHERE organization_id=$1 AND actor_id=$2', [world.supplier, grant.record.target.actorId])).rows[0];
      expect(row).toEqual({ roles: mode === 'self' ? ['owner'] : mode === 'other' ? ['receiver'] : ['supplier_admin'], status: 'active', expires_at: null });
      await expect(legacy(world, plan(world), 'supplier', grant.record.target.actorId)).rejects.toMatchObject({ code: 'SUPPLIER_ACCESS_DENIED' });
      if (mode === 'self') expect(await call(world, { kind: 'context', purpose: 'supplier_admission_context', query: {} })).toMatchObject({ administration: { owner: true, supplierAdministrator: false } });
      const recovered = await call(world, { kind: 'enrollment-recover', purpose: 'supplier_administrator_recover', query: first.request });
      expect(recovered).toMatchObject({ original: first.original, current: { grant: stopped.original.receipt.result } });
      expect(await counts(world)).toMatchObject({ grants: 3, receipts: 3, contexts: 3 });await world.close();
    }
  });
  it('bounds explicit grant lifetime by membership expiry without shortening the member', async () => {
    const world = await scenario(), expiry = instant(Date.now() + 120_000);
    await admin.query('UPDATE pactwoven.memberships SET expires_at=$2 WHERE organization_id=$1 AND actor_id=$3', [world.supplier, expiry, world.supplier + '_other']);
    await expect(review(world, 'other')).rejects.toMatchObject({ code: 'SUPPLIER_ADMISSION_INVALID' });
    const r = await review(world, 'other', { action: 'grant', candidate: (await candidate(world, 'other')).reference, expiresAt: expiry });
    const result = mutationResult(await call(world, command(r), 'other'));
    expect(result.original.receipt.result.record.expiresAt).toBe(expiry);
    expect((await admin.query('SELECT expires_at FROM pactwoven.memberships WHERE organization_id=$1 AND actor_id=$2', [world.supplier, world.supplier + '_other'])).rows[0].expires_at.toISOString()).toBe(expiry);
    await world.close();
  });
  it('requires a current dedicated grant on the existing supplier entrypoints and expires bare flags without cleanup', async () => {
    const world = await scenario();
    await admin.query("UPDATE pactwoven.memberships SET roles=ARRAY['supplier_admin'] WHERE organization_id=$1 AND actor_id=$2", [world.supplier, world.supplier + '_other']);
    await expect(legacy(world, plan(world), 'supplier', world.supplier + '_other')).rejects.toMatchObject({ code: 'SUPPLIER_ACCESS_DENIED' });
    await expect(legacy(world, plan(world))).rejects.toMatchObject({ code: 'SUPPLIER_ACCESS_DENIED' });
    const r = await review(world, 'absent', { action: 'grant', candidate: (await candidate(world, 'absent')).reference, expiresAt: instant(Date.now() + 1200) });
    const result = mutationResult(await call(world, command(r), 'absent')), member = result.original.receipt.result.record.target.actorId;
    await expect(legacy(world, plan(world), 'supplier', member)).resolves.toMatchObject({ kind: 'relationship-observation-plan' });
    await new Promise(resolve => setTimeout(resolve, 1250));
    await expect(legacy(world, plan(world), 'supplier', member)).rejects.toMatchObject({ code: 'SUPPLIER_ACCESS_DENIED' });
    const row = (await admin.query('SELECT roles,status,expires_at FROM pactwoven.memberships WHERE organization_id=$1 AND actor_id=$2', [world.supplier, member])).rows[0];
    expect(row).toEqual({ roles: ['supplier_admin'], status: 'active', expires_at: null });await world.close();
  });
  it('keeps existing policy, status, approval and stop entrypoints compatible with explicit current grants', async () => {
    const world = await scenario(), enrollment = mutationResult(await call(world, command(await review(world))));
    const selectedPair = pair(world), scope = { ...selectedPair, supplierRelationshipId: world.supplier + '_full' };
    const policy: SupplierPrivateRequest = { kind: 'policy-command', purpose: 'supplier_scope_policy_issue', mutation: {
      idempotencyKey: 'policy_' + randomUUID(), command: { pair: selectedPair, expectedVersion: 0, predecessor: null,
        buyerOrganizationVersion: 1, authorityEpoch: 0, payload: { action: 'issue', terms: { buyerSiteIds: [world.buyer + '_site'],
          categories: [{ id: 'logistics', label: 'Logistics', definition: 'Synthetic pair-local scope.' }], requestedValidityMs: 600_000 } } },
    } };
    const policyResult = await legacy(world, policy, 'buyer');if (policyResult.kind !== 'policy-command') throw new Error('Policy required');
    const read: SupplierPrivateRequest = { kind: 'policy-read', purpose: 'supplier_scope_policy_read', query: { policy: {
      pair: selectedPair, version: policyResult.current.policy.version, hash: policyResult.current.policyHash,
    } } };
    await expect(legacy(world, read, 'buyer')).resolves.toMatchObject({ kind: 'policy-read' });
    const create: SupplierPrivateRequest = { kind: 'relationship-command', purpose: 'supplier_relationship_create', mutation: {
      idempotencyKey: 'relationship_' + randomUUID(), command: { scope, expectedVersion: 0, mandateVersion: null, authorityEpoch: 0,
        targetProposal: null, payload: { action: 'create', terms: { buyerSiteIds: [world.buyer + '_site'], serviceCategoryIds: ['logistics'], expiresAt: instant(Date.now() + 500_000) } } },
    } };
    const created = await legacy(world, create, 'buyer');if (created.kind !== 'relationship-command') throw new Error('Relationship required');
    const head = created.currentHead;
    const approved = await legacy(world, { kind: 'relationship-command', purpose: 'supplier_relationship_approve', mutation: {
      idempotencyKey: 'approve_' + randomUUID(), command: { scope, expectedVersion: head.revision, mandateVersion: null,
        authorityEpoch: (await actor(world)).organizationEpoch, targetProposal: head.proposal, payload: { action: 'approve', expiresAt: instant(Date.now() + 300_000) } },
    } });
    if (approved.kind !== 'relationship-command') throw new Error('Approval required');
    expect(approved.record.snapshot.approvals.supplier).not.toBeNull();
    // Read the fixed old approval predicate against its actual committed grant.
    const approval = approved.record.snapshot.approvals.supplier!, a = await actor(world), now = Date.now();
    const facts = { organizations: { supplier: { environment: 'development', id: world.supplier, status: 'ACTIVE', validFrom: instant(now - 60_000),
      version: a.organizationVersion, authorityEpoch: a.organizationEpoch } }, approverMemberships: [{ id: a.membershipId, organizationId: world.supplier,
      actorId: a.actorId, principalKind: 'human', status: 'ACTIVE', version: a.membershipVersion, organizationEpoch: a.organizationEpoch,
      validFrom: instant(now - 60_000), expiresAt: null, roles: ['owner', 'supplier_admin'], grantBasis: 'clerk_admin_bootstrap' }],
      approverObservations: [{ approval, observation: (await candidate(world)).observation }] };
    // Fixture-only trigger instrumentation evaluates the real old-approval gate
    // inside an ordinary authorizer transaction, preserving its actual session
    // identity/RLS visibility. No extra runtime EXECUTE or table grant is added.
    const assertOldApproval = async (expected: boolean) => {
      const literal = (value: unknown) => "'" + JSON.stringify(value).replaceAll("'", "''") + "'";
      await admin.query(`CREATE FUNCTION pactwoven.synthetic_old_approval_assert() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$BEGIN
        IF pactwoven.supplier_approval_current(TG_ARGV[0]::jsonb,TG_ARGV[1]::jsonb,clock_timestamp()) IS DISTINCT FROM TG_ARGV[2]::boolean
          THEN RAISE EXCEPTION 'Synthetic old approval assertion failed';END IF;RETURN NEW;END$$`);
      await admin.query('REVOKE ALL ON FUNCTION pactwoven.synthetic_old_approval_assert() FROM PUBLIC');
      await admin.query(`CREATE TRIGGER synthetic_old_approval_assert AFTER INSERT ON pactwoven.supplier_access_contexts FOR EACH ROW
        EXECUTE FUNCTION pactwoven.synthetic_old_approval_assert(${literal(approval)},${literal(facts)},'${expected}')`);
      try { await legacy(world, plan(world)); }
      finally { await admin.query('DROP TRIGGER synthetic_old_approval_assert ON pactwoven.supplier_access_contexts');await admin.query('DROP FUNCTION pactwoven.synthetic_old_approval_assert()'); }
    };
    await assertOldApproval(true);
    const renewed = mutationResult(await call(world, command(await review(world, 'self', { action: 'renew', grant: enrollment.original.receipt.result.reference, expiresAt: instant(Date.now() + 700_000) }))));
    expect(renewed.original.receipt.result.record.version).toBe(2);
    await assertOldApproval(false);
    // Stop stays available after the counterpart is suspended and its scope no longer current.
    await admin.query("UPDATE pactwoven.organizations SET status='suspended' WHERE id=$1", [world.buyer]);
    const stopped = await legacy(world, { kind: 'relationship-command', purpose: 'supplier_relationship_suspend', mutation: {
      idempotencyKey: 'stop_' + randomUUID(), command: { scope, expectedVersion: approved.currentHead.revision, mandateVersion: null,
        authorityEpoch: (await actor(world)).organizationEpoch, targetProposal: head.proposal, payload: { action: 'suspend' } },
    } });
    expect(stopped).toMatchObject({ kind: 'relationship-command', currentHead: { status: 'SUSPENDED' } });
    const status: SupplierPrivateRequest = { kind: 'relationship-status', purpose: 'supplier_relationship_status', query: { scope, revision: null } };
    await expect(legacy(world, status)).resolves.toMatchObject({ kind: 'relationship-status', projection: { status: 'SUSPENDED' } });
    const recovery: SupplierPrivateRequest = { kind: 'relationship-recover', purpose: 'supplier_relationship_recover', query: {
      identity: approved.receipt.receipt.identity, commandDigest: approved.receipt.receipt.commandDigest, action: 'approve',
    } };
    await expect(legacy(world, recovery)).resolves.toMatchObject({ kind: 'relationship-recover', original: { receipt: approved.receipt } });
    await call(world, command(await review(world, 'self', { action: 'revoke', grant: renewed.original.receipt.result.reference })));
    await expect(legacy(world, status)).rejects.toMatchObject({ code: 'SUPPLIER_ACCESS_DENIED' });
    await expect(legacy(world, recovery)).rejects.toMatchObject({ code: 'SUPPLIER_ACCESS_DENIED' });
    await world.close();
  });
  it('keeps broad original key conflicts separate from absence and never closes a missing original', async () => {
    const world = await scenario(), q = command(await review(world)), result = mutationResult(await call(world, q));
    for (const query of [{ ...result.request, publicRequestHash: 'b'.repeat(64) },
      { ...result.request, target: { ...result.request.target, candidate: { ...result.request.target.candidate, id: 'other_target' } } },
      { ...result.request, action: 'revoke' as const, previousGrant: result.original.receipt.result.reference }])
      await expect(call(world, { kind: 'enrollment-recover', purpose: 'supplier_administrator_recover', query })).rejects.toMatchObject({ code: 'SUPPLIER_ORIGINAL_KEY_CONFLICT' });
    const next = command(await review(world, 'other'));if (next.kind !== 'enrollment-command' || q.kind !== 'enrollment-command') throw new Error('Commands required');
    next.mutation.idempotencyKey = q.mutation.idempotencyKey;
    await expect(call(world, next, 'other')).rejects.toMatchObject({ code: 'SUPPLIER_ORIGINAL_KEY_CONFLICT' });
    const missing = { ...result.request, identity: { ...result.request.identity, idempotencyKey: 'not_recorded_original_key' } };
    expect(await call(world, { kind: 'enrollment-recover', purpose: 'supplier_administrator_recover', query: missing })).toMatchObject({ status: 'NOT_RECORDED', original: null, current: { status: 'UNAVAILABLE' } });
    expect(await counts(world)).toMatchObject({ grants: 1, receipts: 1 });await world.close();
  });
  it('reports a lost actual COMMIT acknowledgement as unknown and recovers the original exactly once', async () => {
    const world = await scenario(), q = command(await review(world)), input = await evidence(world, q);
    const handle = await new PostgresSupplierAdmissionEvidenceRepository(world.verifier.pool, world.config).append(input, q, input.actor);
    const proxy = { connect: async () => {
      const client = await world.authorizer.pool.connect();
      return { release: client.release.bind(client), query: async (sql: string, values?: unknown[]) => {
        const result = await client.query(sql, values);if (sql === 'COMMIT') throw new Error('Synthetic lost acknowledgement after real COMMIT');return result;
      } };
    } } as unknown as Pool;
    await expect(new PostgresSupplierAdmissionRepository(proxy, world.config).execute(handle)).rejects.toMatchObject({ code: 'SUPPLIER_OUTCOME_UNKNOWN' });
    if (q.kind !== 'enrollment-command') throw new Error('Command required');
    const c = q.mutation.command, query = { identity: { environment: 'development' as const, organizationId: world.supplier, actorId: input.actor.actorId,
      idempotencyKey: q.mutation.idempotencyKey }, action: c.selection.action, target: c.basis.target, previousGrant: c.basis.previousGrant,
      publicRequestHash: await supplierEnrollmentPublicRequestDigest(q.mutation) };
    expect(await call(world, { kind: 'enrollment-recover', purpose: 'supplier_administrator_recover', query })).toMatchObject({ status: 'RECORDED', original: { exactPublicMutation: q.mutation } });
    expect(await counts(world)).toMatchObject({ grants: 1, receipts: 1, contexts: 1 });await world.close();
  });
  it('waits on the real organization lock then rechecks changed authority and original expiry', async () => {
    for (const change of ['authority', 'expiry', 'factors'] as const) {
      const world = await scenario(), q = command(await review(world, 'other')), input = await evidence(world, q, 'other');
      if (change === 'expiry') {
        const end = instant(Date.now() + 700);input.expiresAt = end;input.observation.expiresAt = end;if (input.target) input.target.observation.expiresAt = end;
      }
      if (change === 'factors' && input.kind === 'factors') {
        const issued = Date.now() - 59_400;input.observation.tokenIssuedAt = instant(issued);input.source.tokenIssuedAt = instant(issued);
        input.source.firstFactorAgeMinutes = 3;input.source.firstFactorAt = instant(issued - 240_000);
        input.source.secondFactorAt = instant(issued - 60_000);input.source.verifiedAt = input.source.firstFactorAt;
      }
      const handle = await new PostgresSupplierAdmissionEvidenceRepository(world.verifier.pool, world.config).append(input, q, input.actor);
      const lock = await admin.connect();await lock.query('BEGIN');await lock.query('SELECT id FROM pactwoven.organizations WHERE id=$1 FOR UPDATE', [world.supplier]);
      const pending = new PostgresSupplierAdmissionRepository(world.authorizer.pool, world.config).execute(handle).then(value => ({ value }), error => ({ error }));
      try {
        expect(await waitForLock(world.authorizer.name)).toBeGreaterThan(0);
        if (change === 'authority') await lock.query('UPDATE pactwoven.organizations SET authority_epoch=authority_epoch+1 WHERE id=$1', [world.supplier]);
        else await new Promise(resolve => setTimeout(resolve, 750));
        await lock.query('COMMIT');
        expect(await pending).toMatchObject({ error: { code: 'SUPPLIER_ADMISSION_DENIED' } });
        expect(await counts(world)).toMatchObject({ grants: 0, receipts: 0, contexts: 0 });
      } finally { await lock.query('ROLLBACK').catch(() => {});lock.release();await pending;await world.close(); }
    }
  });
  it('serializes two commands from the same review and commits one exact effect', async () => {
    const world = await scenario(), r = await review(world, 'other'), requests = [command(r), command(r)], handles = [];
    for (const q of requests) { const input = await evidence(world, q, 'other');handles.push(await new PostgresSupplierAdmissionEvidenceRepository(world.verifier.pool, world.config).append(input, q, input.actor)); }
    const lock = await admin.connect();await lock.query('BEGIN');await lock.query('SELECT id FROM pactwoven.organizations WHERE id=$1 FOR UPDATE', [world.supplier]);
    const pending = handles.map(handle => new PostgresSupplierAdmissionRepository(world.authorizer.pool, world.config).execute(handle).then(value => ({ value }), error => ({ error })));
    try {
      await waitForLock(world.authorizer.name);await lock.query('COMMIT');
      const results = await Promise.all(pending);expect(results.filter(result => 'value' in result)).toHaveLength(1);
      expect(results.filter(result => 'error' in result)).toHaveLength(1);expect(await counts(world)).toMatchObject({ grants: 1, receipts: 1, contexts: 1 });
    } finally { await lock.query('ROLLBACK').catch(() => {});lock.release();await Promise.all(pending);await world.close(); }
  });
  it('rolls the identity write back if grant persistence fails and refuses direct context/helper/table access', async () => {
    const world = await scenario(), q = command(await review(world, 'other'));
    for (const principal of [world.verifier, world.authorizer]) {
      for (const sql of ['SELECT pactwoven.supplier_admission_identity_apply()', 'SELECT pactwoven.supplier_admission_write_context()',
        'SELECT * FROM pactwoven.supplier_admission_contexts', 'SELECT * FROM pactwoven.supplier_administrator_current',
        "INSERT INTO pactwoven.supplier_admission_contexts DEFAULT VALUES"])
        await expect(principal.pool.query(sql)).rejects.toMatchObject({ code: '42501' });
    }
    await admin.query(`CREATE FUNCTION pactwoven.synthetic_admission_fail() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'Synthetic forced rollback';END$$`);
    await admin.query('REVOKE ALL ON FUNCTION pactwoven.synthetic_admission_fail() FROM PUBLIC');
    await admin.query('CREATE TRIGGER synthetic_admission_fail BEFORE INSERT ON pactwoven.supplier_administrator_grants FOR EACH ROW EXECUTE FUNCTION pactwoven.synthetic_admission_fail()');
    try {
      await expect(call(world, q, 'other')).rejects.toMatchObject({ code: 'SUPPLIER_OUTCOME_UNKNOWN' });
      expect(await counts(world)).toMatchObject({ grants: 0, receipts: 0, contexts: 0, organization_version: 1 });
      expect((await admin.query('SELECT roles,row_version FROM pactwoven.memberships WHERE organization_id=$1 AND actor_id=$2', [world.supplier, world.supplier + '_other'])).rows[0]).toEqual({ roles: ['receiver'], row_version: 1 });
    } finally { await admin.query('DROP TRIGGER synthetic_admission_fail ON pactwoven.supplier_administrator_grants');await admin.query('DROP FUNCTION pactwoven.synthetic_admission_fail()');await world.close(); }
  });
  it('never turns supplier flags or grants into generic all-site reads and preserves explicit site access', async () => {
    const world = await scenario();
    await admin.query("INSERT INTO pactwoven.sites(environment,organization_id,id,name,time_zone) VALUES('development',$1,'selected','Selected','UTC'),('development',$1,'unrelated','Unrelated','UTC')", [world.supplier]);
    const access = async (member: string) => transaction(admin, async client => {
      await client.query('SET LOCAL ROLE pactwoven_runtime');
      await client.query("SELECT set_config('pactwoven.environment','development',true),set_config('pactwoven.organization_id',$1,true),set_config('pactwoven.actor_id',$2,true),set_config('pactwoven.session_id','synthetic-site-read',true)", [world.supplier, member]);
      return (await client.query("SELECT pactwoven.can_read_site('development',$1,'selected') AS selected,pactwoven.can_read_site('development',$1,'unrelated') AS unrelated,pactwoven.can_read_site('development',$2,$3) AS cross_org", [world.supplier, world.buyer, world.buyer + '_site'])).rows[0];
    });
    const result = mutationResult(await call(world, command(await review(world, 'absent')), 'absent')), member = result.original.receipt.result.record.target.actorId;
    expect(await access(member)).toEqual({ selected: false, unrelated: false, cross_org: false });
    await admin.query("INSERT INTO pactwoven.site_memberships(environment,organization_id,actor_id,site_id) VALUES('development',$1,$2,'selected')", [world.supplier, member]);
    expect(await access(member)).toEqual({ selected: true, unrelated: false, cross_org: false });
    const revoked = mutationResult(await call(world, command(await review(world, 'absent', { action: 'revoke', grant: result.original.receipt.result.reference })), 'absent'));
    expect(revoked.original.receipt.result.record.status).toBe('REVOKED');
    expect(await access(member)).toEqual({ selected: true, unrelated: false, cross_org: false });
    const short = mutationResult(await call(world, command(await review(world, 'absent', { action: 'renew', grant: revoked.original.receipt.result.reference, expiresAt: instant(Date.now() + 700) })), 'absent'));
    expect(short.original.receipt.result.record.status).toBe('ACTIVE');await new Promise(resolve => setTimeout(resolve, 750));
    expect(await access(member)).toEqual({ selected: true, unrelated: false, cross_org: false });
    await admin.query("UPDATE pactwoven.memberships SET roles=ARRAY['supplier_admin'] WHERE organization_id=$1 AND actor_id=$2", [world.supplier, world.supplier + '_other']);
    expect(await access(world.supplier + '_other')).toEqual({ selected: false, unrelated: false, cross_org: false });
    for (const role of ['owner', 'finance', 'auditor']) {
      await admin.query('UPDATE pactwoven.memberships SET roles=$2 WHERE organization_id=$1 AND actor_id=$3', [world.supplier, [role, 'supplier_admin'], world.supplier + '_other']);
      expect(await access(world.supplier + '_other')).toEqual({ selected: true, unrelated: true, cross_org: false });
    }
    await admin.query('UPDATE pactwoven.memberships SET expires_at=clock_timestamp() WHERE organization_id=$1 AND actor_id=$2', [world.supplier, member]);
    expect(await access(member)).toEqual({ selected: false, unrelated: false, cross_org: false });await world.close();
  });
  it('preserves site identity and hashes while fencing every reviewed field change', async () => {
    const world = await scenario();
    const initial = (await admin.query('SELECT * FROM pactwoven.sites WHERE organization_id=$1', [world.buyer])).rows[0];
    expect(initial.row_version).toBe(1);
    await admin.query("UPDATE pactwoven.sites SET name='Changed site' WHERE organization_id=$1", [world.buyer]);
    const changed = (await admin.query('SELECT * FROM pactwoven.sites WHERE organization_id=$1', [world.buyer])).rows[0];
    expect(changed.row_version).toBe(2);expect(changed.record_hash).not.toBe(initial.record_hash);
    expect(changed.record_hash).toBe(await commandDigest({ namespace: 'pactwoven/site-descriptor/v1', descriptor: {
      environment: 'development', organizationId: world.buyer, id: world.buyer + '_site', name: 'Changed site', timeZone: 'America/Chicago', version: 2,
    } }));
    await expect(admin.query('DELETE FROM pactwoven.sites WHERE organization_id=$1', [world.buyer])).rejects.toMatchObject({ code: 'FA007' });
    await expect(admin.query("UPDATE pactwoven.sites SET id='rebound' WHERE organization_id=$1", [world.buyer])).rejects.toMatchObject({ code: 'FA007' });
    await world.close();
  });
});
