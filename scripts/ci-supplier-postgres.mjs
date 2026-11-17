import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

// Each matrix job has its own fresh PostgreSQL service. No fixture can
// share the main CI cluster: their admission checks require no existing roles.
const fixtures = Object.freeze({
  relationship: {
    port: 55441, user: 'supplier_fixture_admin', database: 'pactwoven_supplier_relationship_sql_test',
    file: 'packages/db/src/supplier-relationship-sql.test.ts',
    urlVariable: 'PACTWOVEN_SUPPLIER_SQL_TEST_ADMIN_URL_FILE',
    consentVariable: 'PACTWOVEN_SUPPLIER_SQL_DISPOSABLE',
  },
  observer: {
    port: 55442, user: 'supplier_observer_fixture_admin', database: 'pactwoven_supplier_observer_sql_test',
    file: 'packages/db/src/supplier-observer-sql.test.ts',
    urlVariable: 'PACTWOVEN_SUPPLIER_OBSERVER_TEST_ADMIN_URL_FILE',
    consentVariable: 'PACTWOVEN_SUPPLIER_OBSERVER_DISPOSABLE',
  },
  'managed-owner': {
    port: 55442, user: 'supplier_observer_fixture_admin', database: 'pactwoven_supplier_observer_sql_test',
    file: 'packages/db/src/supplier-managed-owner-sql.test.ts',
    urlVariable: 'PACTWOVEN_SUPPLIER_OBSERVER_TEST_ADMIN_URL_FILE',
    consentVariable: 'PACTWOVEN_SUPPLIER_OBSERVER_DISPOSABLE',
  },
  'managed-postgres': {
    port: 55442, user: 'supplier_observer_fixture_admin', database: 'pactwoven_supplier_observer_sql_test',
    file: 'packages/db/src/managed-postgres-qualification-sql.test.ts',
    urlVariable: 'PACTWOVEN_SUPPLIER_OBSERVER_TEST_ADMIN_URL_FILE',
    consentVariable: 'PACTWOVEN_SUPPLIER_OBSERVER_DISPOSABLE',
  },
  'financial-closure': {
    port: 55443, user: 'financial_policy_closure_fixture_admin', database: 'pactwoven_financial_policy_closure_test',
    file: 'packages/db/src/financial-policy-closure.postgres.test.ts',
    urlVariable: 'PACTWOVEN_FINANCIAL_POLICY_CLOSURE_TEST_ADMIN_URL_FILE',
    consentVariable: 'PACTWOVEN_FINANCIAL_POLICY_CLOSURE_DISPOSABLE',
  },
});
const selected = process.env.SUPPLIER_CI_FIXTURE;
if (process.env.CI !== 'true' || process.env.GITHUB_ACTIONS !== 'true' ||
    !process.env.CI_POSTGRES_PASSWORD || !Object.hasOwn(fixtures, selected ?? '')) {
  throw new Error('An explicit dedicated GitHub Actions supplier fixture is required.');
}
const fixture = fixtures[selected];
const directory = await mkdtemp(join(tmpdir(), 'pactwoven-ci-supplier-'));
try {
  const url = new URL(`postgresql://127.0.0.1:${fixture.port}/${fixture.database}`);
  url.username = fixture.user;
  url.password = process.env.CI_POSTGRES_PASSWORD;
  const file = join(directory, 'admin-url');
  await writeFile(file, url.href, { flag: 'wx', mode: 0o600 });
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !['CI_POSTGRES_PASSWORD', 'SUPPLIER_CI_FIXTURE', 'NODE_OPTIONS'].includes(key) &&
    !key.startsWith('PACTWOVEN_') && !key.startsWith('PG')));
  environment[fixture.urlVariable] = file;
  environment[fixture.consentVariable] = 'YES_NEW_LOCAL_ONLY';
  await new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [
      '--max-old-space-size=512', 'node_modules/vitest/vitest.mjs', 'run', fixture.file,
      '--maxWorkers=1', '--no-file-parallelism',
    ], {
      cwd: resolve(import.meta.dirname, '..'), env: environment,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.once('error', () => reject(new Error('Supplier PostgreSQL test runner could not start.')));
    child.once('close', (code, signal) => code === 0 && signal === null ? resolveRun() :
      reject(new Error('Supplier PostgreSQL integration suite failed.')));
  });
} finally {
  await rm(directory, { recursive: true, force: true });
}
