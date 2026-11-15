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
const environment = { ...process.env };
delete environment.CI_POSTGRES_PASSWORD;

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
    const child = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', ...files], {
      cwd: resolve(import.meta.dirname, '..'), env: { ...environment, ...extra }, stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolveRun() : reject(new Error('Database integration suite failed.')));
  });
}
try {
  for (const database of ['pactwoven_backend_test', 'pactwoven_migration_test']) {
    // Refuse reuse: each CI run must have a fresh disposable database container.
    const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [database]);
    if (existing.rowCount) throw new Error('CI fixture database already exists.');
    const sql = await admin.query("SELECT format('CREATE DATABASE %I', $1::text) AS statement", [database]);
    await admin.query(sql.rows[0].statement);
  }
  const runtimePassword = randomBytes(32).toString('base64url');
  const provisionerPassword = randomBytes(32).toString('base64url');
  for (const [name, password] of [['pactwoven_ci_app', runtimePassword], ['pactwoven_ci_identity', provisionerPassword]]) {
    const sql = await admin.query("SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', $1::text, $2::text) AS statement", [name, password]);
    await admin.query(sql.rows[0].statement);
  }
  const backend = {
    PACTWOVEN_RUN_DB_TESTS: '1',
    PACTWOVEN_TEST_ADMIN_DATABASE_URL_FILE: await protectedUrl('backend-admin', 'pactwoven_backend_test'),
    PACTWOVEN_TEST_DATABASE_URL_FILE: await protectedUrl('backend-runtime', 'pactwoven_backend_test', 'pactwoven_ci_app', runtimePassword),
    PACTWOVEN_TEST_PROVISIONER_DATABASE_URL_FILE: await protectedUrl('backend-provisioner', 'pactwoven_backend_test', 'pactwoven_ci_identity', provisionerPassword),
  };
  // The guard suite needs the schema installed by repository.test.ts; do not race its reset.
  await run(['packages/db/src/repository.test.ts'], backend);
  await run(['packages/db/src/pool-guards.test.ts'], backend);
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
