import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

const requireDatabase = createRequire(new URL('../packages/db/package.json', import.meta.url));
const { Pool } = requireDatabase('pg');

// This fixture uses a dedicated loopback CI container, never application DSNs.
if (process.env.CI !== 'true' || process.env.GITHUB_ACTIONS !== 'true' || !process.env.CI_POSTGRES_PASSWORD) {
  throw new Error('The PostgreSQL fixture requires an explicitly configured GitHub Actions job.');
}
const directory = await mkdtemp(join(tmpdir(), 'pactwoven-ci-postgres-'));
const base = new URL('postgresql://127.0.0.1:55440/postgres');
base.username = 'postgres';
base.password = process.env.CI_POSTGRES_PASSWORD;
const admin = new Pool({ connectionString: base.href, max: 1, connectionTimeoutMillis: 5000 });
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  key !== 'CI_POSTGRES_PASSWORD' && !key.startsWith('PACTWOVEN_') && !key.startsWith('PG')));

async function protectedUrl(name, database, username = 'postgres', password = base.password) {
  const url = new URL(base.href);
  url.pathname = `/${database}`;
  url.username = username;
  url.password = password;
  const file = join(directory, name);
  await writeFile(file, url.href, { mode: 0o600, flag: 'wx' });
  return file;
}
async function run(files, extra) {
  await new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', ...files, '--no-file-parallelism'], {
      cwd: resolve(import.meta.dirname, '..'), env: { ...environment, ...extra }, stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolveRun() : reject(new Error('Database integration suite failed.')));
  });
}
try {
  for (const database of ['pactwoven_backend_test', 'pactwoven_migration_test', 'pactwoven_mandate_b1b_test', 'pactwoven_recovery_b1_test', 'pactwoven_finance_provenance_b2a_test', 'pactwoven_financial_fences_fa0_test', 'pactwoven_custody_setup_test', 'pactwoven_custody_reads_test', 'pactwoven_financial_policy_fa1_test', 'pactwoven_financial_policy_reads_test']) {
    // Refuse reuse: each CI run must have a fresh disposable database container.
    const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [database]);
    if (existing.rowCount) throw new Error('CI fixture database already exists.');
    const sql = await admin.query("SELECT format('CREATE DATABASE %I', $1::text) AS statement", [database]);
    await admin.query(sql.rows[0].statement);
  }
  const runtimePassword = randomBytes(32).toString('base64url');
  const provisionerPassword = randomBytes(32).toString('base64url');
  const accessPassword = randomBytes(32).toString('base64url');
  const mandatePassword = randomBytes(32).toString('base64url');
  for (const [name, password] of [['pactwoven_ci_app', runtimePassword], ['pactwoven_ci_identity', provisionerPassword], ['pactwoven_ci_access', accessPassword], ['pactwoven_mandate_b1b_test_login', mandatePassword]]) {
    const sql = await admin.query("SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', $1::text, $2::text) AS statement", [name, password]);
    await admin.query(sql.rows[0].statement);
  }
  const backend = {
    PACTWOVEN_RUN_DB_TESTS: '1',
    PACTWOVEN_RUN_ACCESS_DB_TESTS: '1',
    PACTWOVEN_RUN_ACCESS_ACCEPTANCE_TESTS: '1',
    PACTWOVEN_TEST_ADMIN_DATABASE_URL_FILE: await protectedUrl('backend-admin', 'pactwoven_backend_test'),
    PACTWOVEN_TEST_DATABASE_URL_FILE: await protectedUrl('backend-runtime', 'pactwoven_backend_test', 'pactwoven_ci_app', runtimePassword),
    PACTWOVEN_TEST_PROVISIONER_DATABASE_URL_FILE: await protectedUrl('backend-provisioner', 'pactwoven_backend_test', 'pactwoven_ci_identity', provisionerPassword),
    PACTWOVEN_TEST_ACCESS_DATABASE_URL_FILE: await protectedUrl('backend-access', 'pactwoven_backend_test', 'pactwoven_ci_access', accessPassword),
  };
  // Resetting repository suites run sequentially; guards and API integration use the final schema.
  await run(['packages/db/src/repository.test.ts'], backend);
  await run(['packages/db/src/access-repository.test.ts'], backend);
  await run(['packages/db/src/access-acceptance.test.ts'], backend);
  await run(['packages/db/src/pool-guards.test.ts'], backend);
  await run(['services/api/src/access-postgres.test.ts'], backend);
  await admin.query('CREATE ROLE pactwoven_mandate_writer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS');
  await admin.query('GRANT pactwoven_mandate_writer TO pactwoven_mandate_b1b_test_login');
  const mandate = {
    PACTWOVEN_RUN_MANDATE_DB_TESTS: '1', PACTWOVEN_RUN_MANDATE_POOL_TESTS: '1',
    PACTWOVEN_MANDATE_TEST_ADMIN_URL_FILE: await protectedUrl('mandate-admin', 'pactwoven_mandate_b1b_test'),
    PACTWOVEN_MANDATE_TEST_WRITER_URL_FILE: await protectedUrl('mandate-writer', 'pactwoven_mandate_b1b_test', 'pactwoven_mandate_b1b_test_login', mandatePassword),
  };
  await run(['packages/db/src/mandate-repository.test.ts'], mandate);
  await run(['packages/db/src/mandate-document-reads.test.ts'], mandate);
  await run(['packages/db/src/mandate-pool.test.ts'], mandate);
  await run(['services/api/src/mandate-postgres.test.ts'], mandate);
  await admin.query("COMMENT ON DATABASE pactwoven_recovery_b1_test IS 'Pactwoven RECOVERY-01B B1 exclusive fixture'");
  const recovery = {
    PACTWOVEN_RUN_ACCESS_RECOVERY_DB_TESTS: '1',
    PACTWOVEN_RECOVERY_TEST_ADMIN_URL_FILE: await protectedUrl('recovery-admin', 'pactwoven_recovery_b1_test'),
  };
  for (const [label, role] of [['runtime', 'pactwoven_runtime'], ['bootstrap', 'pactwoven_provisioner'],
    ['access', 'pactwoven_access_provisioner'], ['mandate', 'pactwoven_mandate_writer']]) {
    const name = `pactwoven_recovery_b1_test_${label}`, password = randomBytes(32).toString('base64url');
    const create = await admin.query("SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', $1::text, $2::text) AS statement", [name, password]);
    await admin.query(create.rows[0].statement);
    const grant = await admin.query("SELECT format('GRANT %I TO %I', $1::text, $2::text) AS statement", [role, name]);
    await admin.query(grant.rows[0].statement);
    recovery[`PACTWOVEN_RECOVERY_TEST_${label.toUpperCase()}_URL_FILE`] = await protectedUrl(`recovery-${label}`, 'pactwoven_recovery_b1_test', name, password);
  }
  await run(['packages/db/src/access-recovery-repository.test.ts'], recovery);
  await run(['packages/db/src/access-recovery-isolation.test.ts'], recovery);
  const finance = {
    PACTWOVEN_FINANCE_PROVENANCE_TEST_ADMIN_URL_FILE: await protectedUrl('finance-admin', 'pactwoven_finance_provenance_b2a_test'),
  };
  // Each suite resets only the exclusive inert-provenance database and its fixture roles.
  await run(['packages/db/src/finance-provenance-repository.test.ts'], finance);
  await run(['packages/db/src/finance-provenance-isolation.test.ts'], finance);
  await run(['packages/db/src/finance-provenance-pool.test.ts'], finance);
  const financialFences = {
    PACTWOVEN_FINANCIAL_FENCES_TEST_ADMIN_URL_FILE: await protectedUrl('financial-fences-admin', 'pactwoven_financial_fences_fa0_test'),
  };
  // Prior suites provision all five shared capability roles; FA-0 verifies they stay unchanged.
  await run(['packages/db/src/financial-fences.test.ts'], financialFences);
  await run(['packages/db/src/financial-fences-isolation.test.ts'], financialFences);
  const custody = {
    PACTWOVEN_CUSTODY_SETUP_TEST_ADMIN_URL_FILE: await protectedUrl('custody-setup-admin', 'pactwoven_custody_setup_test'),
  };
  // Each custody suite resets only its exclusive database and generated fixture logins.
  await run(['packages/db/src/custody-setup-repository.test.ts'], custody);
  await run(['packages/db/src/custody-setup-authentication-repository.test.ts'], custody);
  await run(['packages/db/src/custody-setup-isolation.test.ts'], custody);
  await run(['packages/db/src/custody-setup-recovery.test.ts'], custody);
  await run(['packages/db/src/custody-setup-pool.test.ts'], custody);
  await admin.query("COMMENT ON DATABASE pactwoven_custody_reads_test IS 'Pactwoven SETUP-0B private readers exclusive fixture'");
  const custodyReads = {
    PACTWOVEN_CUSTODY_READ_TEST_ADMIN_URL_FILE: await protectedUrl('custody-reads-admin', 'pactwoven_custody_reads_test'),
    PACTWOVEN_CUSTODY_READ_TEST_ACK: 'exclusive-pactwoven-custody-reads-test',
  };
  // Private readers retain separate scope and capability checks in a fresh database.
  await run(['packages/db/src/custody-setup-read-repository.test.ts'], custodyReads);
  await run(['packages/db/src/custody-setup-read-isolation.test.ts'], custodyReads);
  await run(['packages/db/src/custody-setup-read-recovery.test.ts'], custodyReads);
  await run(['packages/db/src/custody-setup-system-privileges.test.ts'], custodyReads);
  const financialPolicy = {
    PACTWOVEN_FINANCIAL_POLICY_TEST_ADMIN_URL_FILE: await protectedUrl('financial-policy-admin', 'pactwoven_financial_policy_fa1_test'),
  };
  // Each policy suite resets only its exclusive database and preserves shared capability roles.
  await run(['packages/db/src/financial-policy-repository.test.ts'], financialPolicy);
  await run(['packages/db/src/financial-authentication-repository.test.ts'], financialPolicy);
  await run(['packages/db/src/financial-policy-isolation.test.ts'], financialPolicy);
  await run(['packages/db/src/financial-authority-pool.test.ts'], financialPolicy);
  const financialPolicyReads = {
    PACTWOVEN_FINANCIAL_POLICY_READ_TEST_ADMIN_URL_FILE: await protectedUrl('financial-policy-reads-admin', 'pactwoven_financial_policy_reads_test'),
  };
  // Private financial context and original-result reads use their own fresh fixture.
  await run(['packages/db/src/financial-policy-read-repository.test.ts'], financialPolicyReads);
  await run(['packages/db/src/financial-policy-read-isolation.test.ts'], financialPolicyReads);
  await run(['services/api/src/financial-policy-postgres.test.ts'], financialPolicyReads);
  await run(['services/api/src/financial-policy-write-postgres.test.ts'], financialPolicyReads);
  await run(['packages/db/src/financial-policy-preparation.postgres.test.ts'], financialPolicyReads);
  await run(['services/api/src/financial-policy-preparation-postgres.test.ts'], financialPolicyReads);
  await run(['packages/db/src/migrate.test.ts'], {
    PACTWOVEN_RUN_MIGRATION_TESTS: '1',
    PACTWOVEN_MIGRATION_TEST_DATABASE_URL_FILE: await protectedUrl('migration-admin', 'pactwoven_migration_test'),
  });
} catch {
  console.error('CI PostgreSQL setup or integration failed; no application database was targeted.');
  process.exitCode = 1;
} finally {
  await admin.end().catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
