import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile } from 'node:fs/promises';
import { Socket } from 'node:net';
import { TLSSocket } from 'node:tls';
import { Pool, type PoolClient, type PoolConfig } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { commandDigest } from '@pactwoven/domain';
import { InstantSchema } from '@pactwoven/contracts';
import { loadMigrations, migrationStatements } from './migrate.js';
import { snapshotSupplierAuthenticationEvidence, type SupplierAuthenticationEvidence } from './supplier-relationship-auth-evidence.js';
import { snapshotSupplierPersistenceRequest, snapshotSupplierPersistenceResult, type SupplierPrivateRequest,
  type SupplierPrivatePrincipalBindingSchema } from './supplier-relationship-persistence-schema.js';
import type { z } from 'zod';

// Authoring this file does not admit execution. Root must approve a fresh,
// isolated loopback fixture and a one-worker run after independent source review.
// No provider, real membership or genuine Clerk extraction is exercised here.
const fixtureVariable = 'PACTWOVEN_SUPPLIER_SQL_TEST_ADMIN_URL_FILE';
const consentVariable = 'PACTWOVEN_SUPPLIER_SQL_DISPOSABLE';
const fixtureEnabled = Boolean(process.env[fixtureVariable]);
const database = 'pactwoven_supplier_relationship_sql_test';
const port = 55441;
const sourceUrl = new URL('../migrations/0015_supplier_relationship_authority.sql', import.meta.url);
function syntheticUrl(source: string, password = 'b') {
  const url = new URL(source); url.password = password; return url.href;
}
// Preserve the accepted migration-0015 fixture while default discovery keeps
// validating every authored migration, including later additions.
const historicalSupplierMigrationPins = [
  ['0001_foundation.sql', '9497eba5975fb487d3fc80480f559afb2b3a7d9387a30b287ecaec459867ff57'],
  ['0002_organization_bootstrap.sql', 'decfb9c2fbcba32009b7939336201a200511aa240abac5d3cb6ba7853c834347'],
  ['0003_identity_access.sql', '248a396a9e1414e22a90b1a49f8aeef48cc400a1eb1a539a0fae42ca02eb93af'],
  ['0004_mandate_authority.sql', '2c5da97dc24c1a76419f59c6eeea662e0cdfc2281d3c6b9b9fbfed84b82f9281'],
  ['0005_access_acceptance.sql', '573fedfe36df2955cb9339d2fb4f30fdfe9de008cd51941ee2e5577c0ad8490b'],
  ['0006_access_recovery_fences.sql', '1dc1fd0b8d731e3752144786136437e9224cdd5818f01e4e1591aaca46feca0e'],
  ['0007_finance_provenance.sql', '75ff22e258b2b8b8e0f3eeb32ceb6621246038ba2cb71f62178e651c58eb7a6a'],
  ['0008_financial_authority_fences.sql', 'b46d6d74b8f53f56ff93e2e83d29b7174d2c8e659bb212640decfc0e0fec2bce'],
  ['0009_custody_setup_owner_bindings.sql', '303116084a84deab26cb27091d62375e47be49018c8dcb366b4bd06dc6a79317'],
  ['0010_custody_setup_private_reads.sql', '699004eff30b8dacb33ccef4955a092a64ed166ed16d38d9183389af9dbf6e9b'],
  ['0011_financial_policy_authority.sql', '5819917e06190dee62b74f022ff995af1e2efc8321eb66979663e11508687117'],
  ['0012_financial_policy_private_reads.sql', 'b43480fcc62cbd384ea484f7cfc81e79fe178861d39d0e5c9a61d07df29b2588'],
  ['0013_financial_policy_preparation.sql', '9d08d5f3a68608265df2f497c3bb0d78cc35c40cc854c13dfa2f64437b683927'],
  ['0014_supplier_identity_versions.sql', '1cb551bb5e8872cd49f438cd3574bda9dcf5b763a6806567441394c50affc0c7'],
  ['0015_supplier_relationship_authority.sql', '9e2e58c8495038812317e0e654e1490c2a90e76c35c6576c4f4f5fbab33572f3'],
] as const;
const tableNames = ['supplier_private_bindings', 'supplier_authentication_evidence', 'supplier_access_contexts',
  'supplier_relationship_scope_policies', 'supplier_relationship_proposals', 'supplier_relationship_versions', 'supplier_relationship_receipts'];
const authorizerFunctions = ['supplier_scope_policy_command(uuid,jsonb)', 'supplier_scope_policy_read(uuid,jsonb)',
  'supplier_relationship_command(uuid,jsonb)', 'supplier_relationship_status(uuid,jsonb)', 'supplier_relationship_recover(uuid,jsonb)'];
type Binding = z.infer<typeof SupplierPrivatePrincipalBindingSchema>;
type Party = 'buyer' | 'supplier';
const instant = (at: number) => new Date(at).toISOString();
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const identifier = (value: string) => { if (!/^pactwoven_supplier_test_[a-z0-9_]+$/.test(value)) throw new Error('Exact disposable principal required.'); return `"${value}"`; };

function fixtureConfig(value: string): PoolConfig {
  const u = new URL(value), user = decodeURIComponent(u.username), password = decodeURIComponent(u.password);
  if (!['postgres:', 'postgresql:'].includes(u.protocol) || u.hostname !== '127.0.0.1' || u.port !== String(port) ||
    u.pathname !== `/${database}` || u.search || u.hash || !user || !password || user.includes('\0') || password.includes('\0')) {
    throw new Error('New dedicated supplier SQL loopback fixture required.');
  }
  return { host: '127.0.0.1', port, database, user, password, ssl: false, max: 2, connectionTimeoutMillis: 3_000,
    statement_timeout: 10_000, idle_in_transaction_session_timeout: 5_000, options: '-c transaction_timeout=10s', application_name: 'supplier-sql-disposable-test' };
}
async function readConfig(path: string) {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || (before.mode & 0o777) !== 0o600 || before.size < 1 || before.size > 8192) throw new Error('Protected regular credential file required.');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const after = await file.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || !after.isFile() || (after.mode & 0o777) !== 0o600) throw new Error('Fixture credential file changed.');
    return fixtureConfig((await file.readFile('utf8')).trim());
  } finally { await file.close(); }
}
async function assertSocket(c: PoolClient, config: PoolConfig) {
  const stream = (c as PoolClient & { connection?: { stream?: unknown } }).connection?.stream;
  if (!(stream instanceof Socket) || stream instanceof TLSSocket || stream.readyState !== 'open' || stream.destroyed || stream.remotePort !== port ||
    !['127.0.0.1', '::ffff:127.0.0.1'].includes(stream.remoteAddress ?? '')) throw new Error('Exact loopback fixture socket required.');
  const row = (await c.query("SELECT current_database() AS database,current_user AS current,session_user AS session,current_setting('server_version_num') AS version,current_setting('transaction_timeout')::interval=interval '10 seconds' AS bounded")).rows[0];
  if (row.database !== database || row.current !== config.user || row.session !== config.user || Number(row.version)<170000 || !row.bounded) throw new Error('Exact authenticated fixture principal required.');
}
async function transaction<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>, isolation = 'READ COMMITTED') {
  if (!['READ COMMITTED', 'REPEATABLE READ', 'SERIALIZABLE'].includes(isolation)) throw new Error('Fixed test isolation required.');
  const c = await pool.connect();
  try { await c.query(`BEGIN ISOLATION LEVEL ${isolation}`); const result = await fn(c); await c.query('COMMIT'); return result; }
  catch (error) { await c.query('ROLLBACK'); throw error; } finally { c.release(); }
}
const functionFor = (request: SupplierPrivateRequest) => request.kind === 'policy-command' ? 'supplier_scope_policy_command' :
  request.kind === 'policy-read' ? 'supplier_scope_policy_read' : request.kind === 'relationship-command' ? 'supplier_relationship_command' :
    request.kind === 'relationship-recover' ? 'supplier_relationship_recover' : 'supplier_relationship_status';
async function invoke(c: PoolClient, id: string, request: SupplierPrivateRequest) {
  return (await c.query(`SELECT pactwoven.${functionFor(request)}($1::uuid,$2::jsonb) AS value`, [id, request])).rows[0].value;
}

// Fixed differential cases: the existing schema plus finite Date.parse is the
// oracle when this file is separately admitted. Parsing never rewrites JSON.
const instantCases = [
  { value: '2026-11-20T18:00:00Z', accepted: true },
  { value: '2026-11-20T18:00:00.000Z', accepted: true },
  { value: '2026-11-20T18:00:00.000+00:00', accepted: true },
  { value: '2026-11-20T23:30:00+05:30', accepted: true },
  { value: '2026-11-20T13:00:00-05:00', accepted: true },
  { value: '2026-11-20T18:00:00.1Z', accepted: true },
  { value: '2026-11-20T18:00:00.12Z', accepted: true },
  { value: '2026-11-20T18:00:00.123999999Z', accepted: true },
  { value: '1969-12-31T23:59:59.999999Z', accepted: true },
  { value: '0000-02-29T00:00:00Z', accepted: true },
  { value: '0000-01-01T00:00:00+23:59', accepted: true },
  { value: '9999-12-31T23:59:59.999-23:59', accepted: true },
  { value: '2000-02-29T23:59:59-00:00', accepted: true },
  { value: '2026-02-29T00:00:00Z', accepted: false },
  { value: '1900-02-29T00:00:00Z', accepted: false },
  { value: '2026-04-31T00:00:00Z', accepted: false },
  { value: '2026-11-20T24:00:00Z', accepted: false },
  { value: '2026-11-20T18:00:60Z', accepted: false },
  { value: '2026-11-20T18:00Z', accepted: false },
  { value: '2026-11-20T18:00:00+24:00', accepted: false },
  { value: '2026-11-20T18:00:00+0000', accepted: false },
  { value: '2026-11-20T18:00:00', accepted: false },
  { value: '2026-11-20T18:00:00.Z', accepted: false },
  { value: '+010000-01-01T00:00:00Z', accepted: false },
  { value: 'infinity', accepted: false },
] as const;
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
async function attestLegacyHelper(admin: Pool) {
  const source = await readFile(sourceUrl, 'utf8');
  const originalBody = source.match(/CREATE FUNCTION pactwoven\.supplier_base_identity\([\s\S]*? AS \$\$([\s\S]*?)\$\$;/)?.[1];
  expect(originalBody).toBeDefined();
  const helper = (await admin.query(`SELECT p.oid::text,p.proowner::text,p.prosecdef,p.proleakproof,p.provolatile,p.proparallel,p.proisstrict,p.procost,p.prorows,
    p.pronargs,p.pronargdefaults,p.proargnames,p.proconfig,p.prosrc,p.probin,p.prosupport::oid::text,l.lanname,
    (p.proargtypes[0]='jsonb'::regtype AND p.proargtypes[1]='jsonb'::regtype AND p.proargtypes[2]='jsonb'::regtype) AS exact_arguments,
    p.prorettype='jsonb'::regtype AS exact_result,pg_get_functiondef(p.oid) AS definition,
    r.rolname,r.rolsuper,r.rolbypassrls,r.rolcanlogin
    FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner JOIN pg_language l ON l.oid=p.prolang
    WHERE p.oid='pactwoven.supplier_base_identity(jsonb,jsonb,jsonb)'::regprocedure`)).rows[0];
  expect(helper).toMatchObject({ prosecdef: true, proleakproof: false, provolatile: 'v', proparallel: 'u', proisstrict: false,
    procost: 100, prorows: 0, pronargs: 3, pronargdefaults: 0, proargnames: ['v', 'site_ids', 'approver_ids'],
    proconfig: ['search_path=pg_catalog', 'lock_timeout=3s'], prosrc: originalBody, probin: null, prosupport: '0', lanname: 'plpgsql', exact_arguments: true, exact_result: true, rolsuper: true });
  const owners = (await admin.query("SELECT c.relname,c.relowner::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='pactwoven' AND c.relname=ANY($1) ORDER BY c.relname", [['organizations', 'memberships', 'session_revocations', 'sites']])).rows;
  expect(owners).toHaveLength(4); for (const owner of owners) expect(owner.relowner).toBe(helper.proowner);
  const acl = (await admin.query(`SELECT a.grantor::text,a.grantee::text,coalesce(r.rolname,'PUBLIC') AS grantee_name,a.privilege_type,a.is_grantable
    FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a LEFT JOIN pg_roles r ON r.oid=a.grantee
    WHERE p.oid='pactwoven.supplier_base_identity(jsonb,jsonb,jsonb)'::regprocedure ORDER BY grantee_name`)).rows;
  expect(acl).toHaveLength(2);
  expect(acl.map(x => x.grantee_name).sort()).toEqual([helper.rolname, 'pactwoven_supplier_executor'].sort());
  for (const grant of acl) expect(grant).toMatchObject({ grantor: helper.proowner, privilege_type: 'EXECUTE', is_grantable: false });
  const attestation = { definition: helper.definition, definitionSha256: sha256(helper.definition), originalBodySha256: sha256(originalBody!),
    oid: helper.oid, ownerOid: helper.proowner, ownerName: helper.rolname, ownerSuperuser: helper.rolsuper, ownerBypassRls: helper.rolbypassrls,
    ownerCanLogin: helper.rolcanlogin, proconfig: helper.proconfig, legacyOwners: owners, acl };
  // Exact installed DDL and complete ACL are retained in the bounded native log
  // before any public supplier command. They contain source/role IDs, no secret.
  process.stdout.write('SUPPLIER_LEGACY_HELPER_ATTESTATION ' + JSON.stringify(attestation) + '\n');
  return attestation;
}
async function waitForBlock(admin: Pool, waiter: number, holder: number) {
  for (let i=0;i<50;i++) {
    if ((await admin.query('SELECT $2::int=ANY(pg_blocking_pids($1::int)) AS blocked',[waiter,holder])).rows[0].blocked) return;
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  throw new Error('Expected bounded fixture lock wait was not observed.');
}

// Only the separately admitted empty fixture may install these temporary
// invoker triggers. No production migration, function, ACL or callable login
// surface is changed. Controls roll back inside PL/pgSQL subtransactions before
// the real public command continues; the probes must fail for SP001 specifically.
const resolveProbe = `DECLARE candidate pactwoven.supplier_relationship_scope_policies; BEGIN
  IF NEW.phase<>'RESOLVE' THEN RETURN NEW;END IF;
  IF EXISTS(SELECT 1 FROM pactwoven.supplier_access_contexts WHERE phase='WRITE') THEN RAISE EXCEPTION 'Probe unexpectedly has WRITE';END IF;
  SELECT * INTO STRICT candidate FROM pactwoven.supplier_relationship_scope_policies ORDER BY version DESC LIMIT 1;
  BEGIN
    INSERT INTO pactwoven.supplier_relationship_scope_policies SELECT candidate.*;
    RAISE EXCEPTION 'RESOLVE-only insertion unexpectedly passed';
  EXCEPTION WHEN SQLSTATE 'SP001' THEN RAISE NOTICE 'SUPPLIER_PROBE_RESOLVE_ONLY_DENIED';END;
  RETURN NEW;END`;
const appendProbe = `DECLARE c pactwoven.supplier_access_contexts:=pactwoven.supplier_context();auth jsonb;r jsonb;body jsonb;n bigint;candidate pactwoven.supplier_relationship_scope_policies;BEGIN
  SELECT "authorization" INTO STRICT auth FROM pactwoven.supplier_access_contexts WHERE phase='WRITE';
  r:=auth->'record';body:=auth->'receipt';n:=(auth->>'nextRevision')::bigint;
  BEGIN
    INSERT INTO pactwoven.supplier_relationship_versions VALUES(c.environment,c.buyer_organization_id,c.supplier_organization_id,c.relationship_id,n,
      NEW.version,NEW.proposal_hash,NEW.policy_version,NEW.policy_hash,r,c.database_oid,c.session_user_oid,c.backend_pid,c.full_xid,'WRITE');
    RAISE EXCEPTION USING ERRCODE='ZX101',MESSAGE='Rollback valid version control';
  EXCEPTION WHEN SQLSTATE 'ZX101' THEN RAISE NOTICE 'SUPPLIER_PROBE_VALID_VERSION_CONTROL';END;
  BEGIN
    INSERT INTO pactwoven.supplier_relationship_versions VALUES(c.environment,c.buyer_organization_id,c.supplier_organization_id,c.relationship_id,n+1,
      NEW.version,NEW.proposal_hash,NEW.policy_version,NEW.policy_hash,r,c.database_oid,c.session_user_oid,c.backend_pid,c.full_xid,'WRITE');
    RAISE EXCEPTION 'Wrong revision unexpectedly passed';
  EXCEPTION WHEN SQLSTATE 'SP001' THEN RAISE NOTICE 'SUPPLIER_PROBE_WRONG_REVISION_DENIED';END;
  BEGIN
    INSERT INTO pactwoven.supplier_relationship_receipts VALUES(c.environment,c.buyer_organization_id,c.supplier_organization_id,c.relationship_id,c.effective_organization_id,c.actor_id,
      c.request#>>'{mutation,idempotencyKey}',n,c.request->'mutation',body);
    RAISE EXCEPTION USING ERRCODE='ZX102',MESSAGE='Rollback valid receipt control';
  EXCEPTION WHEN SQLSTATE 'ZX102' THEN RAISE NOTICE 'SUPPLIER_PROBE_VALID_RECEIPT_CONTROL';END;
  BEGIN
    INSERT INTO pactwoven.supplier_relationship_receipts VALUES(c.environment,c.buyer_organization_id,c.supplier_organization_id,c.relationship_id,c.effective_organization_id,c.actor_id,
      c.request#>>'{mutation,idempotencyKey}',n,c.request->'mutation',jsonb_set(body,'{receipt,identity,idempotencyKey}','"tampered_receipt_key"'::jsonb));
    RAISE EXCEPTION 'Wrong receipt unexpectedly passed';
  EXCEPTION WHEN SQLSTATE 'SP001' THEN RAISE NOTICE 'SUPPLIER_PROBE_WRONG_RECEIPT_DENIED';END;
  IF pactwoven.supplier_write_allowed('relationship',c.environment,c.buyer_organization_id,c.supplier_organization_id,c.relationship_id,n) IS DISTINCT FROM true
    OR pactwoven.supplier_write_allowed('policy',c.environment,c.buyer_organization_id,c.supplier_organization_id,c.relationship_id,n) IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'Isolated family predicate failed';END IF;
  RAISE NOTICE 'SUPPLIER_PROBE_FAMILY_PREDICATE_ISOLATED';
  SELECT * INTO STRICT candidate FROM pactwoven.supplier_relationship_scope_policies ORDER BY version DESC LIMIT 1;
  BEGIN
    INSERT INTO pactwoven.supplier_relationship_scope_policies SELECT candidate.*;
    RAISE EXCEPTION 'Relationship WRITE admitted policy family';
  EXCEPTION WHEN SQLSTATE 'SP001' THEN RAISE NOTICE 'SUPPLIER_PROBE_WRONG_FAMILY_DENIED';END;
  RETURN NEW;END`;
async function installFixtureProbe(admin: Pool, mode: 'resolve'|'append', loginName: string) {
  const table=mode==='resolve'?'supplier_access_contexts':'supplier_relationship_proposals';
  const functionName=mode==='resolve'?'fixture_supplier_resolve_probe':'fixture_supplier_append_probe';
  const body=mode==='resolve'?resolveProbe:appendProbe;
  await transaction(admin,async c=>{
    await c.query(`CREATE FUNCTION pactwoven.${functionName}() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $probe$${body}$probe$`);
    await c.query(`REVOKE ALL ON FUNCTION pactwoven.${functionName}() FROM PUBLIC`);
    await c.query(`ALTER FUNCTION pactwoven.${functionName}() OWNER TO pactwoven_supplier_executor`);
    await c.query(`CREATE TRIGGER fixture_supplier_probe AFTER INSERT ON pactwoven.${table} FOR EACH ROW EXECUTE FUNCTION pactwoven.${functionName}()`);
  });
  const cleanup=async()=>transaction(admin,async c=>{
    await c.query(`DROP TRIGGER fixture_supplier_probe ON pactwoven.${table}`);
    await c.query(`DROP FUNCTION pactwoven.${functionName}()`);
  });
  try {
  expect((await admin.query("SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed",[loginName,`pactwoven.${functionName}()`])).rows[0].allowed).toBe(false);
  const acl=(await admin.query("SELECT coalesce(r.rolname,'PUBLIC') AS grantee FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a LEFT JOIN pg_roles r ON r.oid=a.grantee WHERE p.oid=$1::regprocedure ORDER BY grantee",[`pactwoven.${functionName}()`])).rows;
  expect(acl).toEqual([{grantee:'pactwoven_supplier_executor'}]);
  } catch(error) { await cleanup();throw error; }
  return cleanup;
}

async function fixture() {
  if (process.env[consentVariable] !== 'YES_NEW_LOCAL_ONLY' || !process.env[fixtureVariable] ||
    Object.keys(process.env).some(k => k.startsWith('PG') || k.startsWith('PACTWOVEN_') && ![fixtureVariable, consentVariable].includes(k))) {
    throw new Error('Explicit fresh-fixture admission and scrubbed environment required.');
  }
  const config = await readConfig(process.env[fixtureVariable]!), admin = new Pool(config), pools: Pool[] = [];
  const suffix = randomBytes(5).toString('hex');
  const close = async () => { await Promise.all(pools.map(p => p.end())); await admin.end(); };
  try {
    const check = await admin.connect();
    try {
      await assertSocket(check, config);
      const row = (await check.query("SELECT rolsuper,(SELECT count(*) FROM pg_namespace WHERE nspname='pactwoven') AS schemas,(SELECT count(*) FROM pg_roles WHERE rolname LIKE 'pactwoven_%') AS roles FROM pg_roles WHERE rolname=current_user")).rows[0];
      // Deliberately no DROP SCHEMA, destructive reset or shared-cluster reuse.
      if (!row.rolsuper || Number(row.schemas) !== 0 || Number(row.roles) !== 0) throw new Error('Empty, dedicated disposable cluster required.');
    } finally { check.release(); }
    const discovered = await loadMigrations();
    const migrations = discovered.slice(0, historicalSupplierMigrationPins.length);
    if (migrations.length !== historicalSupplierMigrationPins.length || migrations.some((migration, index) => {
      const expected = historicalSupplierMigrationPins[index];
      return !expected || migration.number !== index + 1 || migration.filename !== expected[0] || migration.checksum !== expected[1];
    })) throw new Error('Exact historical supplier migration filenames and checksums required.');
    if (migrations.length !== 15 || migrations[14]?.filename !== '0015_supplier_relationship_authority.sql') throw new Error('Exact fifteen-migration source required.');
    for (const migration of migrations) await transaction(admin, async c => {
      for (const [index, statement] of migration.statements.entries()) {
        try { await c.query(statement); } catch (error) { throw new Error(`Supplier fixture migration ${migration.number}, statement ${index + 1}`, { cause: error }); }
      }
    });
    const helperAttestation = await attestLegacyHelper(admin);
    const login = async (label: string, verifier: boolean) => {
      const name = `pactwoven_supplier_test_${suffix}_${label}`, password = randomBytes(32).toString('base64url');
      await admin.query(`CREATE ROLE ${identifier(name)} LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD ${literal(password)}`);
      await admin.query(`GRANT USAGE ON SCHEMA pactwoven TO ${identifier(name)}`);
      for (const fn of verifier ? ['supplier_record_evidence(jsonb)'] : authorizerFunctions) await admin.query(`GRANT EXECUTE ON FUNCTION pactwoven.${fn} TO ${identifier(name)}`);
      const pool = new Pool({ ...config, user: name, password, max: 1 }); pools.push(pool);
      const c = await pool.connect(); try { await assertSocket(c, { ...config, user: name }); } finally { c.release(); }
      const oid = Number((await admin.query('SELECT oid FROM pg_roles WHERE rolname=$1', [name])).rows[0].oid);
      return { name, oid, pool };
    };
    const principals = { buyer: { verifier: await login('buyer_verifier', true), authorizer: await login('buyer_authorizer', false) },
      supplier: { verifier: await login('supplier_verifier', true), authorizer: await login('supplier_authorizer', false) } };
    await admin.query("INSERT INTO pactwoven.organizations(environment,id,external_organization_id,name) VALUES('development','buyer_sql','external_buyer_sql','Synthetic buyer'),('development','supplier_sql','external_supplier_sql','Synthetic supplier'),('development','other_sql','external_other_sql','Other synthetic organization')");
    await admin.query("INSERT INTO pactwoven.memberships(environment,organization_id,actor_id,external_subject,external_membership_id,roles,grant_basis) VALUES('development','buyer_sql','buyer_admin','subject_buyer','member_buyer',ARRAY['owner'],'clerk_admin_bootstrap'),('development','supplier_sql','supplier_admin','subject_supplier','member_supplier',ARRAY['supplier_admin'],'clerk_admin_bootstrap'),('development','buyer_sql','buyer_reader','subject_reader','member_reader',ARRAY['auditor'],'internal')");
    await admin.query("INSERT INTO pactwoven.sites VALUES('development','buyer_sql','site_sql','Synthetic site','America/Chicago'),('development','other_sql','site_other','Other synthetic site','America/Chicago')");
    const bindings = {} as Record<Party, Binding>;
    const appendBinding = async (binding: Binding, connection: Pool | PoolClient = admin) => {
      await connection.query(`INSERT INTO pactwoven.supplier_private_bindings(id,version,environment,effective_organization_id,verifier_oid,verifier_name,
        authorizer_oid,authorizer_name,status,valid_from,expires_at,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [binding.reference.id, binding.reference.version, binding.environment, binding.effectiveOrganizationId, binding.verifier.oid, binding.verifier.name,
        binding.authorizer.oid, binding.authorizer.name, binding.status, binding.validFrom, binding.expiresAt, binding]);
    };
    for (const party of ['buyer', 'supplier'] as const) {
      const { verifier, authorizer } = principals[party];
      const body = { reference: { id: `${party}_binding`, version: 1 }, environment: 'development' as const, effectiveOrganizationId: `${party}_sql`,
        verifier: { oid: verifier.oid, name: verifier.name }, authorizer: { oid: authorizer.oid, name: authorizer.name }, status: 'ACTIVE' as const,
        validFrom: instant(Date.now() - 1000), expiresAt: instant(Date.now() + 3_600_000) };
      bindings[party] = { ...body, reference: { ...body.reference, hash: await commandDigest({ namespace: 'pactwoven/supplier-private-binding/v1', binding: body }) } };
      await appendBinding(bindings[party]);
    }
    const pair = { environment: 'development' as const, buyerOrganizationId: 'buyer_sql', supplierOrganizationId: 'supplier_sql' };
    const scope = (id = `relationship_${randomBytes(6).toString('hex')}`) => ({ ...pair, supplierRelationshipId: id });
    let currentBuyerOrganizationVersion = 1;
    const changeExternalIdentity = async (party: Party, externalId: string) => transaction(admin, async c => {
      await c.query("SELECT id FROM pactwoven.organizations WHERE environment='development' AND id=$1 FOR UPDATE", [`${party}_sql`]);
      const changed = (await c.query("UPDATE pactwoven.organizations SET external_organization_id=$2 WHERE environment='development' AND id=$1 RETURNING row_version", [`${party}_sql`, externalId])).rows[0];
      if (party==='buyer') currentBuyerOrganizationVersion=Number(changed.row_version);
    });
    const actor = (party: Party) => ({ environment: 'development' as const, organizationId: `${party}_sql`, actorId: `${party}_admin` });
    const requestPolicy = (previous: any = null, action: 'issue' | 'replace' | 'revoke' = previous ? 'replace' : 'issue'): SupplierPrivateRequest => ({
      kind: 'policy-command', purpose: `supplier_scope_policy_${action}`, mutation: { idempotencyKey: `policy_${randomBytes(12).toString('hex')}`,
        command: { pair, expectedVersion: previous?.policy.version ?? 0, predecessor: previous ? { pair, version: previous.policy.version, hash: previous.policyHash } : null,
          buyerOrganizationVersion: currentBuyerOrganizationVersion, authorityEpoch: 0, payload: action === 'revoke' ? { action } : { action, terms: {
            buyerSiteIds: ['site_sql'], categories: [{ id: 'logistics', label: 'Logistics', definition: 'Synthetic pair-local logistics scope.' }], requestedValidityMs: 3_600_000 } } } } });
    const requestRelationship = (s: ReturnType<typeof scope>, action: 'create' | 'revise' | 'approve' | 'suspend' | 'revoke', current: any = null): SupplierPrivateRequest => ({
      kind: 'relationship-command', purpose: `supplier_relationship_${action}`, mutation: { idempotencyKey: `relationship_${randomBytes(12).toString('hex')}`,
        command: { scope: s, expectedVersion: current?.revision ?? 0, mandateVersion: null, authorityEpoch: 0, targetProposal: current?.proposal ?? null,
          payload: action === 'create' || action === 'revise' ? { action, terms: { buyerSiteIds: ['site_sql'], serviceCategoryIds: ['logistics'], expiresAt: instant(Date.now() + 1_800_000) } } :
            action === 'approve' ? { action, expiresAt: instant(Date.now() + 600_000) } : { action } } } });
    const evidence = async (party: Party, request: SupplierPrivateRequest, approvers?: SupplierAuthenticationEvidence['approvers'], validityMs = 25_000) => {
      const at = Date.now(), observation = { subject: `subject_${party}`, externalOrganizationId: `external_${party}_sql`, externalMembershipId: `member_${party}`,
        externalRole: 'org:admin', sessionId: `session_${party}`, authenticatedAt: instant(at - 120_000), membershipObservedAt: instant(at), issuer: 'https://synthetic.invalid',
        tokenHash: 'a'.repeat(64), tokenIssuedAt: instant(at), sessionExpiresAt: instant(at + 300_000), observedAt: instant(at), expiresAt: instant(at + validityMs) };
      const local = (await admin.query('SELECT m.row_version AS membership_version,o.row_version AS organization_version,o.authority_epoch,o.external_organization_id FROM pactwoven.memberships m JOIN pactwoven.organizations o ON (o.environment,o.id)=(m.environment,m.organization_id) WHERE m.environment=$1 AND m.organization_id=$2 AND m.actor_id=$3', ['development', `${party}_sql`, `${party}_admin`])).rows[0];
      observation.externalOrganizationId=local.external_organization_id;
      const pinnedActor = { ...actor(party), principalKind: 'human' as const, membershipId: `${party}_admin`, membershipVersion: Number(local.membership_version), organizationVersion: Number(local.organization_version), organizationEpoch: Number(local.authority_epoch),
        subject: observation.subject, externalOrganizationId: observation.externalOrganizationId, externalMembershipId: observation.externalMembershipId, sessionId: observation.sessionId };
      const snap = await snapshotSupplierPersistenceRequest(request, actor(party));
      const common = { schemaVersion: 1 as const, id: crypto.randomUUID(), actor: pinnedActor, binding: bindings[party], observedBy: bindings[party].verifier,
        request, requestDigest: snap.requestDigest, mutationDigest: snap.mutationDigest, observation, observedAt: observation.observedAt, expiresAt: observation.expiresAt,
        ...(approvers === undefined ? {} : { approvers: approvers.map(entry => ({ ...entry, observation: { ...entry.observation,
          observedAt: observation.observedAt, expiresAt: observation.expiresAt } })) }) };
      const result: SupplierAuthenticationEvidence = request.kind === 'policy-command' || request.kind === 'relationship-command' ? { ...common, kind: 'factors', source: {
        kind: 'CLERK_FVA', tokenHash: observation.tokenHash, tokenIssuedAt: observation.tokenIssuedAt, firstFactorAgeMinutes: 0, secondFactorAgeMinutes: 0,
        firstFactorAt: instant(at - 60_000), secondFactorAt: instant(at - 60_000), verifiedAt: instant(at - 60_000) } } : { ...common, kind: 'identity' };
      await snapshotSupplierAuthenticationEvidence(result, request, pinnedActor, bindings[party], instant(at));
      return result;
    };
    const recordEvidence = async (party: Party, ev: SupplierAuthenticationEvidence) => (await principals[party].verifier.pool.query('SELECT pactwoven.supplier_record_evidence($1::jsonb) AS value', [ev])).rows[0].value;
    const call = async (party: Party, request: SupplierPrivateRequest, approvers?: SupplierAuthenticationEvidence['approvers']) => {
      const ev = await evidence(party, request, approvers); await recordEvidence(party, ev);
      const value = await transaction(principals[party].authorizer.pool, c => invoke(c, ev.id, request));
      await snapshotSupplierPersistenceResult(value, request, actor(party)); return value;
    };
    const callWithNotices = async (party: Party, request: SupplierPrivateRequest) => {
      const ev=await evidence(party,request);await recordEvidence(party,ev);
      const notices:string[]=[];
      const value=await transaction(principals[party].authorizer.pool,async c=>{
        const listener=(notice:{message?:string|undefined})=>{notices.push(notice.message??'SUPPLIER_PROBE_NOTICE_MISSING_MESSAGE');};c.on('notice',listener);
        try{return await invoke(c,ev.id,request);}finally{c.removeListener('notice',listener);}
      });
      await snapshotSupplierPersistenceResult(value,request,actor(party));return {value,notices};
    };
    const observations = async (party: Party, s: ReturnType<typeof scope>): Promise<NonNullable<SupplierAuthenticationEvidence['approvers']>> => {
      const value = await call(party, { kind: 'relationship-observation-plan', purpose: 'supplier_relationship_observation_plan', query: { scope: s } });
      return value.plan.approvers.map((entry: any) => ({ head: value.plan.head, approval: entry.approval, observation: {
        issuer: 'https://synthetic.invalid', subject: entry.subject, externalOrganizationId: entry.externalOrganizationId, externalMembershipId: entry.externalMembershipId,
        externalRole: 'org:admin', status: 'ACTIVE', observedAt: instant(Date.now()), expiresAt: instant(Date.now() + 25_000) } }));
    };
    return { admin, principals, bindings, appendBinding, pair, scope, actor, requestPolicy, requestRelationship, evidence, recordEvidence, call, observations, close, login, changeExternalIdentity, helperAttestation, callWithNotices };
  } catch (error) { await close(); throw error; }
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

// These checks are source/guard regression tripwires. They do not prove SQL
// parsing, non-owner execution, locking or any provider-origin observation.
describe('supplier SQL source and disposable admission', () => {
  it('rejects nonexclusive URLs and driver overrides before opening a connection', () => {
    expect(fixtureConfig(syntheticUrl(`postgresql://synthetic@127.0.0.1:${port}/${database}`, 'password')).max).toBe(2);
    for (const value of [syntheticUrl('postgresql://a@localhost:55441/' + database), syntheticUrl('postgresql://a@127.0.0.1:5432/' + database),
      syntheticUrl('postgresql://a@127.0.0.1:55441/pactwoven_dev'), syntheticUrl(`postgresql://a@127.0.0.1:${port}/${database}?sslmode=disable`),
      syntheticUrl(`postgresql://a@neon.tech:${port}/${database}`)]) expect(() => fixtureConfig(value)).toThrow();
  });
  it('pins precision/calendar decisions to the existing instant schema and finite JavaScript time', () => {
    for(const vector of instantCases) expect(InstantSchema.safeParse(vector.value).success && Number.isFinite(Date.parse(vector.value)),vector.value).toBe(vector.accepted);
    expect(Date.parse('2026-11-20T18:00:00.123999999Z')).toBe(Date.parse('2026-11-20T18:00:00.123Z'));
    expect(Date.parse('1969-12-31T23:59:59.999999Z')).toBe(-1);
  });
  it('retains one transaction wrapper, the six intended entry points and no runtime enrollment', async () => {
    const sql = await readFile(sourceUrl, 'utf8'), statements = migrationStatements(sql);
    expect(statements.length).toBeGreaterThan(70);
    const exposed = [...sql.matchAll(/CREATE FUNCTION pactwoven\.(supplier_\w+)\([^;]*?LANGUAGE plpgsql VOLATILE SECURITY DEFINER/gs)].map(m => m[1]);
    for (const name of ['supplier_record_evidence', ...authorizerFunctions.map(f => f.split('(')[0])]) expect(exposed).toContain(name);
    expect(sql).not.toMatch(/CREATE ROLE[^;]*\sLOGIN\s/i);
    expect(sql).not.toMatch(/INSERT INTO pactwoven\.supplier_private_bindings/);
    expect(sql).toContain('ROLE pactwoven_supplier_owner NOLOGIN NOINHERIT NOSUPERUSER');
    expect(sql).toContain('ROLE pactwoven_supplier_executor NOLOGIN NOINHERIT NOSUPERUSER');
  });
  it('keeps registry/lineage fences, literal engine identity and context-only business RLS', async () => {
    const sql = await readFile(sourceUrl, 'utf8');
    expect(sql).toContain("current_setting('transaction_isolation')='read committed'");
    expect(sql).not.toMatch(/current_setting\('pactwoven\./);
    expect(sql).toContain('pg_advisory_xact_lock_shared');
    expect(sql).toContain('supplier_lineage_fence(lineage)');
    expect(sql).toContain('supplier_one_write_per_evidence');
    expect(sql).toContain('supplier_context_append_guard');
    expect(sql).toContain('supplier_version_receipt_reciprocal');
    expect(sql).toContain('supplier_proposal_receipt_reciprocal');
    expect(sql).toContain('FORCE ROW LEVEL SECURITY');
  });
  it('contains no business read or dynamic statement in the disclosed legacy helper', async () => {
    const sql = await readFile(sourceUrl, 'utf8');
    const body = sql.slice(sql.indexOf('CREATE FUNCTION pactwoven.supplier_base_identity('), sql.indexOf('CREATE FUNCTION pactwoven.supplier_business_append_guard('));
    expect(body).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|EXECUTE|to_jsonb\(row)\b/i);
    expect(body).not.toMatch(/FROM pactwoven\.supplier_/);
    for (const table of ['organizations', 'memberships', 'session_revocations', 'sites']) expect(body).toContain(`pactwoven.${table}`);
    expect(sql).toContain('r.rolsuper');
  });
});

// Max eight PostgreSQL clients: admin(2) + four original and two rotation LOGIN pools(1 each).
// PostgreSQL 17+ transaction_timeout=10s bounds every fixture transaction;
// statement/idle limits alone would not establish this lifetime bound.
// All assertions are serial; fresh cluster disposal is an external root action.
describe.skipIf(!fixtureEnabled)('supplier authority on a fresh non-owner PostgreSQL fixture', () => {
  let f: Fixture, policy: any;
  beforeAll(async () => { f = await fixture(); policy = (await f.call('buyer', f.requestPolicy())).current; }, 60_000);
  afterAll(async () => { if (f) await f.close(); });
  const create = async () => { const scope = f.scope(), request = f.requestRelationship(scope, 'create'); return { scope, request, value: await f.call('buyer', request) }; };
  const status = (scope: ReturnType<Fixture['scope']>, revision: number | null = null): SupplierPrivateRequest => ({ kind: 'relationship-status', purpose: 'supplier_relationship_status', query: { scope, revision } });

  it('runs six entry points under a distinct non-owner executor with all seven tables forced', async () => {
    const rows = (await f.admin.query("SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,r.rolname AS owner,r.rolsuper,r.rolbypassrls FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner WHERE n.nspname='pactwoven' AND c.relname=ANY($1) ORDER BY c.relname", [tableNames])).rows;
    expect(rows).toHaveLength(7);
    for (const r of rows) expect(r).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true, owner: 'pactwoven_supplier_owner', rolsuper: false, rolbypassrls: false });
    const functions = (await f.admin.query("SELECT p.proname,p.prosecdef,r.rolname AS owner,r.rolsuper,r.rolbypassrls FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner WHERE n.nspname='pactwoven' AND p.proname=ANY($1)", [['supplier_record_evidence', ...authorizerFunctions.map(x => x.split('(')[0])]])).rows;
    expect(functions).toHaveLength(6);
    for (const r of functions) expect(r).toMatchObject({ prosecdef: true, owner: 'pactwoven_supplier_executor', rolsuper: false, rolbypassrls: false });
    const owner = (await f.admin.query("BEGIN; SET LOCAL ROLE pactwoven_supplier_owner; SELECT count(*) AS count FROM pactwoven.supplier_private_bindings; ROLLBACK")) as unknown as { rows: { count: string }[] }[];
    expect(owner[2]?.rows[0]?.count).toBe('0');
  });
  it('attests the exact installed broad legacy owner, source/definition, fixed config and complete execute ACL', async () => {
    expect(f.helperAttestation.ownerSuperuser).toBe(true);
    expect(f.helperAttestation.ownerName).not.toBe('pactwoven_supplier_owner');
    expect(f.helperAttestation.ownerName).not.toBe('pactwoven_supplier_executor');
    expect(f.helperAttestation.definitionSha256).toHaveLength(64);
    expect(f.helperAttestation.acl).toHaveLength(2);
  });
  it('parses every frozen instant format with finite JS millisecond semantics, including calendar boundaries', async () => {
    for(const vector of instantCases){
      const expected=InstantSchema.safeParse(vector.value).success && Number.isFinite(Date.parse(vector.value));
      if(!expected){await expect(f.admin.query('SELECT pactwoven.supplier_time($1::jsonb)',[JSON.stringify(vector.value)])).rejects.toMatchObject({code:'SP001'});continue;}
      const row=(await f.admin.query('SELECT (extract(epoch FROM pactwoven.supplier_time($1::jsonb))*1000)::numeric(20,0)::text AS milliseconds',[JSON.stringify(vector.value)])).rows[0];
      expect(Number(row.milliseconds),vector.value).toBe(Date.parse(vector.value));
    }
  });
  it('retains original noncanonical request/evidence time strings and their distinct content hashes', async () => {
    for(const text of ['2099-11-20T18:00:00Z','2099-11-20T18:00:00.000+00:00','2099-11-20T18:00:00.123999Z']){
      const scope=f.scope(),request=f.requestRelationship(scope,'create');
      if(request.kind!=='relationship-command'||request.mutation.command.payload.action!=='create')throw new Error('Create fixture required.');
      request.mutation.command.payload.terms.expiresAt=text;
      const ev=await f.evidence('buyer',request);
      ev.observedAt=ev.observation.observedAt=ev.observedAt.replace('Z','+00:00');
      ev.expiresAt=ev.observation.expiresAt=ev.expiresAt.replace('Z','+00:00');
      await snapshotSupplierAuthenticationEvidence(ev,request,ev.actor,f.bindings.buyer,instant(Date.now()));
      const recorded=await f.recordEvidence('buyer',ev);
      expect(recorded.hash).toBe(await commandDigest({namespace:'pactwoven/supplier-private-auth-evidence/v1',evidence:ev}));
      const value=await transaction(f.principals.buyer.authorizer.pool,c=>invoke(c,ev.id,request));
      await snapshotSupplierPersistenceResult(value,request,f.actor('buyer'));
      expect(value.record.snapshot.proposal.terms.expiresAt).toBe(text);
      expect((await f.admin.query('SELECT body FROM pactwoven.supplier_authentication_evidence WHERE id=$1',[ev.id])).rows[0].body).toEqual(ev);
      const normalized=structuredClone(request);
      if(normalized.kind!=='relationship-command'||normalized.mutation.command.payload.action!=='create')throw new Error('Create fixture required.');
      normalized.mutation.command.payload.terms.expiresAt=instant(Date.parse(text));
      const originalDigest=await snapshotSupplierPersistenceRequest(request,f.actor('buyer'));
      const normalizedDigest=await snapshotSupplierPersistenceRequest(normalized,f.actor('buyer'));
      expect(originalDigest.mutationDigest).not.toBe(normalizedDigest.mutationDigest);
    }
  });
  it('refuses external buyer or supplier identity changes before replacement and exact original replay', async () => {
    for(const party of ['buyer','supplier'] as const){
      const original=f.requestPolicy(policy);policy=(await f.call('buyer',original)).current;
      const before=(await f.admin.query('SELECT count(*) AS count FROM pactwoven.supplier_relationship_scope_policies')).rows[0].count;
      await f.changeExternalIdentity(party,`changed_external_${party}_sql`);
      try{
        await expect(f.call('buyer',f.requestPolicy(policy))).rejects.toMatchObject({code:'SP001'});
        await expect(f.call('buyer',original)).rejects.toMatchObject({code:'SP001'});
        expect((await f.admin.query('SELECT count(*) AS count FROM pactwoven.supplier_relationship_scope_policies')).rows[0].count).toBe(before);
      }finally{await f.changeExternalIdentity(party,`external_${party}_sql`);}
    }
  });
  it('denies direct tables, internal helper/context calls, SET ROLE and swapped verifier/authorizer capabilities', async () => {
    const a = f.principals.buyer.authorizer.pool, v = f.principals.buyer.verifier.pool;
    for (const table of tableNames) await expect(a.query(`SELECT * FROM pactwoven.${table}`)).rejects.toMatchObject({ code: '42501' });
    for (const sql of ['SET ROLE pactwoven_supplier_executor', 'SET ROLE pactwoven_supplier_owner', "SELECT pactwoven.supplier_context()", "SELECT pactwoven.supplier_base_identity('{}','[]','[]')"])
      await expect(a.query(sql)).rejects.toMatchObject({ code: '42501' });
    await expect(a.query("SELECT pactwoven.supplier_record_evidence('{}')")).rejects.toMatchObject({ code: '42501' });
    await expect(v.query("SELECT pactwoven.supplier_relationship_status(null,'{}')")).rejects.toMatchObject({ code: '42501' });
  });
  it('cannot bootstrap data visibility by setting tenant, actor, phase or evidence GUCs', async () => {
    await transaction(f.principals.buyer.authorizer.pool, async c => {
      await c.query("SELECT set_config('pactwoven.organization_id','supplier_sql',true),set_config('pactwoven.actor_id','supplier_admin',true),set_config('pactwoven.phase','WRITE',true)");
      await expect(c.query('SELECT * FROM pactwoven.supplier_relationship_versions')).rejects.toMatchObject({ code: '42501' });
    });
  });
  it('rejects non-READ-COMMITTED admission and confines a valid evidence UUID to the designated actual login', async () => {
    const request = { kind: 'relationship-observation-plan', purpose: 'supplier_relationship_observation_plan', query: { scope: f.scope() } } as const;
    const ev = await f.evidence('buyer', request); await f.recordEvidence('buyer', ev);
    for (const isolation of ['REPEATABLE READ', 'SERIALIZABLE']) await expect(transaction(f.principals.buyer.authorizer.pool, c => invoke(c, ev.id, request), isolation)).rejects.toMatchObject({ code: 'SP001' });
    await expect(transaction(f.principals.supplier.authorizer.pool, c => invoke(c, ev.id, request))).rejects.toMatchObject({ code: 'SP001' });
  });
  it('permits one immutable RESOLVE per transaction, then leaves no reusable authority in a pooled connection', async () => {
    const { scope } = await create(), request = status(scope), ev = await f.evidence('buyer', request); await f.recordEvidence('buyer', ev);
    await expect(transaction(f.principals.buyer.authorizer.pool, async c => { await invoke(c, ev.id, request); await invoke(c, ev.id, request); })).rejects.toMatchObject({ code: 'SP001' });
    const value = await transaction(f.principals.buyer.authorizer.pool, c => invoke(c, ev.id, request)); expect(value.projection.current).toBe(true);
    await expect(f.principals.buyer.authorizer.pool.query('SELECT * FROM pactwoven.supplier_access_contexts')).rejects.toMatchObject({ code: '42501' });
  });
  it('records exact bilateral approvals and emits only the frozen redacted current projection', async () => {
    const { scope, value: proposed } = await create();
    const first = await f.call('buyer', f.requestRelationship(scope, 'approve', proposed.currentHead));
    await expect(f.call('supplier', f.requestRelationship(scope, 'approve', first.currentHead))).rejects.toMatchObject({ code: 'SP001' });
    const second = await f.call('supplier', f.requestRelationship(scope, 'approve', first.currentHead), await f.observations('supplier', scope));
    expect(second.currentHead.status).toBe('ACTIVE');
    await expect(f.call('buyer', status(scope))).rejects.toMatchObject({ code: 'SP001' });
    const result = await f.call('buyer', status(scope), await f.observations('buyer', scope));
    expect(result.projection).toMatchObject({ relationshipGate: 'SATISFIED', bookingAuthority: false, contractualAcceptance: false, paymentAuthority: false });
    expect(JSON.stringify(result)).not.toMatch(/subject_buyer|member_buyer|site_sql|factorEvidence|policyBinding/);
  });
  it('refuses changed-head, wrong-stamp and stale observations rather than reporting a known negative gate', async () => {
    const { scope, value } = await create();
    const first = await f.call('buyer', f.requestRelationship(scope, 'approve', value.currentHead));
    const observed = await f.observations('buyer', scope), malformed = structuredClone(observed);
    malformed[0]!.approval.actorId = 'other_actor';
    await expect(f.call('buyer', status(scope), malformed)).rejects.toMatchObject({ code: 'SP001' });
    const ev = await f.evidence('buyer', status(scope), observed); ev.approvers![0]!.observation.observedAt = instant(Date.now() - 21_000);
    await expect(f.recordEvidence('buyer', ev)).rejects.toMatchObject({ code: 'SP001' });
    await f.call('buyer', f.requestRelationship(scope, 'revise', first.currentHead));
    await expect(f.call('buyer', status(scope), observed)).rejects.toMatchObject({ code: 'SP001' });
  });
  it('treats an observed revoked provider membership as a known failed approval and keeps history readable without a bundle', async () => {
    const { scope, value } = await create();
    const first = await f.call('buyer', f.requestRelationship(scope, 'approve', value.currentHead));
    await f.call('supplier', f.requestRelationship(scope, 'approve', first.currentHead), await f.observations('supplier', scope));
    const observed = await f.observations('buyer', scope); observed.find(x => x.approval.party === 'supplier')!.observation.status = 'REVOKED';
    expect((await f.call('buyer', status(scope), observed)).projection.gateReason).toBe('APPROVAL_NOT_CURRENT');
    expect((await f.call('buyer', status(scope, 1))).projection.gateReason).toBe('NOT_CURRENT_REVISION');
  });
  it('rejects stale local approver membership versions even when the provider observation is fresh', async () => {
    const { scope, value } = await create();
    const first = await f.call('buyer', f.requestRelationship(scope, 'approve', value.currentHead));
    await f.admin.query("UPDATE pactwoven.memberships SET row_version=row_version+1 WHERE environment='development' AND organization_id='buyer_sql' AND actor_id='buyer_admin'");
    await expect(f.call('supplier', f.requestRelationship(scope, 'approve', first.currentHead), await f.observations('supplier', scope))).rejects.toMatchObject({ code: 'SP001' });
  });
  it('keeps exact original record/receipt/policy pin on replay and recovery after suspension', async () => {
    const { scope, request, value } = await create();
    const suspended = await f.call('supplier', f.requestRelationship(scope, 'suspend', value.currentHead));
    const replay = await f.call('buyer', request);
    expect(replay).toMatchObject({ outcome: 'EXACT_REPLAY', receipt: value.receipt, record: value.record, currentHead: suspended.currentHead });
    const recover: SupplierPrivateRequest = { kind: 'relationship-recover', purpose: 'supplier_relationship_recover', query: {
      identity: value.receipt.receipt.identity, commandDigest: value.receipt.receipt.commandDigest, action: 'create' } };
    const recovered = await f.call('buyer', recover);
    expect(recovered.original).toEqual({ mutation: request.kind === 'relationship-command' ? request.mutation : null, receipt: value.receipt,
      binding: value.record.policyBinding, currentHead: suspended.currentHead });
    const altered = structuredClone(request);
    if (altered.kind !== 'relationship-command' || altered.mutation.command.payload.action !== 'create') throw new Error('Create fixture required.');
    altered.mutation.command.payload.terms.expiresAt = instant(Date.now() + 900_000);
    await expect(f.call('buyer', altered)).rejects.toMatchObject({ code: 'SP001' });
    const crossed = structuredClone(recover); crossed.query.identity.actorId = 'different_actor';
    await expect(f.call('buyer', crossed)).rejects.toThrow();
  });
  it('requires a fresh proposal and bilateral approvals after policy replacement and never repins an old replay', async () => {
    const { scope, request, value } = await create();
    const first = await f.call('buyer', f.requestRelationship(scope, 'approve', value.currentHead));
    const active = await f.call('supplier', f.requestRelationship(scope, 'approve', first.currentHead), await f.observations('supplier', scope));
    const replacement = f.requestPolicy(policy), replaced = await f.call('buyer', replacement); policy = replaced.current;
    expect((await f.call('buyer', status(scope), await f.observations('buyer', scope))).projection.gateReason).toBe('SCOPE_NOT_CURRENT');
    const replay = await f.call('buyer', request); expect(replay.record.policyBinding).toEqual(value.record.policyBinding);
    expect((await f.call('buyer', replacement)).outcome).toBe('EXACT_REPLAY');
    const revised = await f.call('buyer', f.requestRelationship(scope, 'revise', active.currentHead));
    expect(revised.record.policyBinding.policy.version).toBe(policy.policy.version);
    expect(revised.record.snapshot.approvals).toEqual({ buyer: null, supplier: null });
    const approved = await f.call('supplier', f.requestRelationship(scope, 'approve', revised.currentHead));
    await f.call('buyer', f.requestRelationship(scope, 'approve', approved.currentHead), await f.observations('buyer', scope));
    expect((await f.call('buyer', status(scope), await f.observations('buyer', scope))).projection.relationshipGate).toBe('SATISFIED');
  });
  it('keeps pair-local category meanings immutable and rejects foreign buyer-site scope', async () => {
    const changed = f.requestPolicy(policy);
    if (changed.kind !== 'policy-command' || changed.mutation.command.payload.action === 'revoke') throw new Error('Policy fixture required.');
    changed.mutation.command.payload.terms.categories[0]!.definition = 'Changed meaning under the same ID.';
    await expect(f.call('buyer', changed)).rejects.toMatchObject({ code: 'SP001' });
    const crossed = f.requestPolicy(policy);
    if (crossed.kind !== 'policy-command' || crossed.mutation.command.payload.action === 'revoke') throw new Error('Policy fixture required.');
    crossed.mutation.command.payload.terms.buyerSiteIds = ['site_other'];
    await expect(f.call('buyer', crossed)).rejects.toMatchObject({ code: 'SP001' });
    await expect(f.call('supplier', f.requestPolicy(policy))).rejects.toThrow();
  });
  it('serializes two original commands at one revision and appends exactly one version and one receipt', async () => {
    const { scope, value } = await create();
    const requests = [f.requestRelationship(scope, 'approve', value.currentHead), f.requestRelationship(scope, 'approve', value.currentHead)];
    const outcomes = await Promise.allSettled([f.call('buyer', requests[0]!), f.call('supplier', requests[1]!)]);
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(result => result.status === 'rejected')).toHaveLength(1);
    const counts = (await f.admin.query(`SELECT (SELECT count(*) FROM pactwoven.supplier_relationship_versions WHERE relationship_id=$1) AS versions,
      (SELECT count(*) FROM pactwoven.supplier_relationship_receipts WHERE relationship_id=$1) AS receipts`, [scope.supplierRelationshipId])).rows[0];
    expect(counts).toEqual({ versions: '2', receipts: '2' });
  });
  it('rolls back proposed effects and refuses reusable WRITE admission for already committed evidence', async () => {
    const scope = f.scope(), request = f.requestRelationship(scope, 'create'), ev = await f.evidence('buyer', request); await f.recordEvidence('buyer', ev);
    await expect(transaction(f.principals.buyer.authorizer.pool, async c => { await invoke(c, ev.id, request); throw new Error('Synthetic rollback'); })).rejects.toThrow('Synthetic rollback');
    expect((await f.admin.query('SELECT count(*) AS count FROM pactwoven.supplier_relationship_versions WHERE relationship_id=$1', [scope.supplierRelationshipId])).rows[0].count).toBe('0');
    const created = await transaction(f.principals.buyer.authorizer.pool, c => invoke(c, ev.id, request));
    expect(created.outcome).toBe('APPENDED');
    const replay = await transaction(f.principals.buyer.authorizer.pool, c => invoke(c, ev.id, request)); expect(replay.outcome).toBe('EXACT_REPLAY');
    expect((await f.admin.query("SELECT count(*) AS count FROM pactwoven.supplier_access_contexts WHERE evidence_id=$1 AND phase='WRITE'", [ev.id])).rows[0].count).toBe('1');
  });
  it('rejects altered protected rows even from the offline fixture administrator', async () => {
    for (const table of tableNames) {
      await expect(f.admin.query(`UPDATE pactwoven.${table} SET environment=environment`)).rejects.toMatchObject({ code: 'SP003' });
      await expect(f.admin.query(`DELETE FROM pactwoven.${table}`)).rejects.toMatchObject({ code: 'SP003' });
      await expect(f.admin.query(`TRUNCATE pactwoven.${table} CASCADE`)).rejects.toMatchObject({ code: 'SP003' });
    }
  });
  it('rejects a forged engine context even when the offline administrator copies real evidence', async () => {
    await expect(f.admin.query(`INSERT INTO pactwoven.supplier_access_contexts
      SELECT (SELECT oid FROM pg_database WHERE datname=current_database()),(SELECT oid FROM pg_roles WHERE rolname=session_user),pg_backend_pid(),pg_current_xact_id(),
        'RESOLVE','RESOLVE',evidence_id,evidence_hash,binding_id,binding_version,binding_hash,environment,buyer_organization_id,supplier_organization_id,relationship_id,
        effective_organization_id,actor_id,request,request_digest,observed_at,expires_at,NULL FROM pactwoven.supplier_access_contexts LIMIT 1`)).rejects.toMatchObject({ code: 'SP001' });
  });
  it('rejects old factors, NULL observation fields and changed original request digests at the recorder', async () => {
    const scope = f.scope(), request = f.requestRelationship(scope, 'create');
    const old = await f.evidence('buyer', request);
    if (old.kind !== 'factors') throw new Error('Factor fixture required.');
    old.source.firstFactorAgeMinutes = 5; old.source.firstFactorAt = instant(Date.parse(old.source.tokenIssuedAt) - 360_000); old.source.verifiedAt = old.source.firstFactorAt;
    await expect(f.recordEvidence('buyer', old)).rejects.toMatchObject({ code: 'SP001' });
    const nullValue = await f.evidence('buyer', request); (nullValue.observation as unknown as Record<string, unknown>).issuer = null;
    await expect(f.recordEvidence('buyer', nullValue)).rejects.toMatchObject({ code: 'SP001' });
    const changed = await f.evidence('buyer', request); changed.requestDigest = 'f'.repeat(64);
    await expect(f.recordEvidence('buyer', changed)).rejects.toMatchObject({ code: 'SP001' });
  });
  it('linearizes at fresh WRITE acceptance and permits bounded commit after expiry with early or deferred completeness checks', async () => {
    for(const earlyFlush of [true,false]){
      const scope=f.scope(),request=f.requestRelationship(scope,'create'),ev=await f.evidence('buyer',request,undefined,1_500);
      await f.recordEvidence('buyer',ev);
      const value=await transaction(f.principals.buyer.authorizer.pool,async c=>{
        const accepted=await invoke(c,ev.id,request);expect(accepted.outcome).toBe('APPENDED');
        if(earlyFlush)await c.query('SET CONSTRAINTS ALL IMMEDIATE');
        await c.query('SELECT pg_sleep(greatest(0,extract(epoch FROM ($1::timestamptz-clock_timestamp())))+0.1)',[ev.expiresAt]);
        expect((await c.query('SELECT $1::timestamptz<clock_timestamp() AS expired',[ev.expiresAt])).rows[0].expired).toBe(true);
        return accepted;
      });
      // Physical COMMIT happened after expiry and succeeded within the enforced
      // ten-second fixture transaction deadline. No second authority was granted.
      expect((await f.admin.query('SELECT record FROM pactwoven.supplier_relationship_versions WHERE relationship_id=$1',[scope.supplierRelationshipId])).rows[0].record).toEqual(value.record);
      expect((await f.admin.query("SELECT count(*) AS count FROM pactwoven.supplier_access_contexts WHERE evidence_id=$1 AND phase='WRITE'",[ev.id])).rows[0].count).toBe('1');
    }
  });
  it('isolates RESOLVE-only insertion and wrong revision/receipt/family inside real authenticated contexts', async () => {
    let cleanup=await installFixtureProbe(f.admin,'resolve',f.principals.buyer.authorizer.name);
    try{
      const query:SupplierPrivateRequest={kind:'policy-read',purpose:'supplier_scope_policy_read',query:{policy:{pair:f.pair,version:policy.policy.version,hash:policy.policyHash}}};
      const observed=await f.callWithNotices('buyer',query);expect(observed.notices).toEqual(['SUPPLIER_PROBE_RESOLVE_ONLY_DENIED']);
    }finally{await cleanup();}
    cleanup=await installFixtureProbe(f.admin,'append',f.principals.buyer.authorizer.name);
    try{
      const observed=await f.callWithNotices('buyer',f.requestRelationship(f.scope(),'create'));
      expect(observed.value.outcome).toBe('APPENDED');
      expect(observed.notices).toEqual(['SUPPLIER_PROBE_VALID_VERSION_CONTROL','SUPPLIER_PROBE_WRONG_REVISION_DENIED',
        'SUPPLIER_PROBE_VALID_RECEIPT_CONTROL','SUPPLIER_PROBE_WRONG_RECEIPT_DENIED','SUPPLIER_PROBE_FAMILY_PREDICATE_ISOLATED','SUPPLIER_PROBE_WRONG_FAMILY_DENIED']);
    }finally{await cleanup();}
    const current=await attestLegacyHelper(f.admin);expect(current).toEqual(f.helperAttestation);
    expect((await f.admin.query("SELECT count(*) AS count FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='pactwoven' AND p.proname IN ('fixture_supplier_resolve_probe','fixture_supplier_append_probe')")).rows[0].count).toBe('0');
  });
  it('keeps revocation terminal despite policy renewal', async () => {
    const { scope, value } = await create();
    const revoked = await f.call('supplier', f.requestRelationship(scope, 'revoke', value.currentHead));
    policy = (await f.call('buyer', f.requestPolicy(policy))).current;
    await expect(f.call('buyer', f.requestRelationship(scope, 'revise', revoked.currentHead))).rejects.toMatchObject({ code: 'SP001' });
    expect((await f.call('buyer', status(scope))).projection).toMatchObject({ status: 'REVOKED', gateReason: 'NOT_ACTIVE' });
  });
  it('holds runtime lineage authority through transaction end while revocation and role-pair rotation wait', async () => {
    const oldPair=f.principals.buyer,oldBinding=f.bindings.buyer;
    const replacement={verifier:await f.login('buyer_rotated_verifier',true),authorizer:await f.login('buyer_rotated_authorizer',false)};
    const request:SupplierPrivateRequest={kind:'relationship-observation-plan',purpose:'supplier_relationship_observation_plan',query:{scope:f.scope()}};
    const ev=await f.evidence('buyer',request);await f.recordEvidence('buyer',ev);
    const caller=await oldPair.authorizer.pool.connect(),maintainer=await f.admin.connect();
    let waiting:Promise<{error?:unknown}>|undefined;
    const retiredBody={...oldBinding,reference:{id:oldBinding.reference.id,version:oldBinding.reference.version+1},status:'REVOKED' as const};
    const retired:Binding={...retiredBody,reference:{...retiredBody.reference,hash:await commandDigest({namespace:'pactwoven/supplier-private-binding/v1',binding:retiredBody})}};
    const nextBody={...oldBinding,reference:{id:'buyer_rotated_binding',version:1},
      verifier:{oid:replacement.verifier.oid,name:replacement.verifier.name},authorizer:{oid:replacement.authorizer.oid,name:replacement.authorizer.name},
      validFrom:instant(Date.now()-1000),expiresAt:instant(Date.now()+3_600_000)};
    const next:Binding={...nextBody,reference:{...nextBody.reference,hash:await commandDigest({namespace:'pactwoven/supplier-private-binding/v1',binding:nextBody})}};
    try{
      await caller.query('BEGIN');expect((await invoke(caller,ev.id,request)).plan.head).toBeNull();
      const callerPid=Number((await caller.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      await maintainer.query('BEGIN');const maintainerPid=Number((await maintainer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      waiting=f.appendBinding(retired,maintainer).then(()=>({}),error=>({error}));
      await waitForBlock(f.admin,maintainerPid,callerPid);
      expect((await f.admin.query('SELECT max(version)::text AS version FROM pactwoven.supplier_private_bindings WHERE id=$1',[oldBinding.reference.id])).rows[0].version).toBe('1');
      // No manual lock release: COMMIT releases the runtime's registry/lineage
      // fences. Rotation must not become visible before that transaction ends.
      await caller.query('COMMIT');expect(await waiting).toEqual({});
      await f.appendBinding(next,maintainer);await maintainer.query('COMMIT');
      await caller.query('BEGIN');await expect(invoke(caller,ev.id,request)).rejects.toMatchObject({code:'SP001'});await caller.query('ROLLBACK');
      await expect(oldPair.verifier.pool.query('SELECT pactwoven.supplier_record_evidence($1::jsonb)',[ev])).rejects.toMatchObject({code:'SP001'});
      f.principals.buyer=replacement;f.bindings.buyer=next;
      expect((await f.call('buyer',request)).plan.head).toBeNull();
    }finally{
      await caller.query('ROLLBACK');await maintainer.query('ROLLBACK');caller.release();maintainer.release();if(waiting)await waiting;
    }
  });
  it('holds the binding-maintenance fence and reselects terminal revocation after a real wait', async () => {
    const request: SupplierPrivateRequest = { kind: 'relationship-observation-plan', purpose: 'supplier_relationship_observation_plan', query: { scope: f.scope() } };
    const ev = await f.evidence('buyer', request); await f.recordEvidence('buyer', ev);
    const holder = await f.admin.connect(), caller = await f.principals.buyer.authorizer.pool.connect();
    let waiting: Promise<{ value?: unknown; error?: unknown }> | undefined;
    try {
      await holder.query('BEGIN'); await holder.query('SELECT pactwoven.supplier_registry_fence(true)');
      const holderPid = Number((await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      const callerPid = Number((await caller.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      await caller.query('BEGIN'); waiting = invoke(caller, ev.id, request).then(value => ({ value }), error => ({ error }));
      let blocked = false;
      for (let i = 0; i < 50 && !blocked; i++) {
        blocked = (await f.admin.query('SELECT $2::int=ANY(pg_blocking_pids($1::int)) AS blocked', [callerPid, holderPid])).rows[0].blocked;
        if (!blocked) await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(blocked).toBe(true);
      const prior = f.bindings.buyer, body = { ...prior, reference: { id: prior.reference.id, version: 2 }, status: 'REVOKED' as const };
      const revoked: Binding = { ...body, reference: { ...body.reference, hash: await commandDigest({ namespace: 'pactwoven/supplier-private-binding/v1', binding: body }) } };
      await f.appendBinding(revoked, holder); await holder.query('COMMIT');
      expect(await waiting).toMatchObject({ error: { code: 'SP001' } });
      await caller.query('ROLLBACK');
      // Latest active selection would incorrectly admit this old evidence.
      await expect(f.recordEvidence('buyer', await f.evidence('buyer', request))).rejects.toMatchObject({ code: 'SP001' });
    } finally { await holder.query('ROLLBACK'); await caller.query('ROLLBACK'); holder.release(); caller.release(); if (waiting) await waiting; }
  });

});
