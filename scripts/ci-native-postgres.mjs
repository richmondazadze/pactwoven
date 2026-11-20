import { randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

const requireDatabase = createRequire(new URL('../packages/db/package.json', import.meta.url));
const { Pool } = requireDatabase('pg');
if (process.env.CI !== 'true' || process.env.GITHUB_ACTIONS !== 'true' || !process.env.CI_POSTGRES_PASSWORD) {
  throw new Error('Native task qualification requires its dedicated GitHub Actions PostgreSQL service.');
}
const url = new URL('postgresql://pactwoven_native_admin@127.0.0.1:55447/pactwoven_native_test');
url.password = process.env.CI_POSTGRES_PASSWORD;
const admin = new Pool({ connectionString: url.href, max: 1, connectionTimeoutMillis: 5_000 });
let fixture;
const childEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  ['PATH', 'HOME', 'TMPDIR', 'LANG', 'CI', 'GITHUB_ACTIONS', 'NODE_OPTIONS'].includes(key)));
let migration = 'initialization';
try {
  const existing = await admin.query("SELECT 1 FROM pg_namespace WHERE nspname='pactwoven'");
  if (existing.rowCount) throw new Error('Refusing a reused native-task fixture.');
  await admin.query('CREATE DATABASE pactwoven_native_dispatch_ci');
  url.pathname = '/pactwoven_native_dispatch_ci';
  fixture = new Pool({ connectionString: url.href, max: 1, connectionTimeoutMillis: 5_000 });
  const directory = new URL('../packages/db/migrations/', import.meta.url);
  const files = (await readdir(directory)).filter(file => /^\d{4}_[a-z0-9_]+\.sql$/.test(file)).sort();
  if (files.length !== 49 || files.at(-1) !== '0049_native_work_execution.sql') throw new Error('Review the native upgrade CI sequence for new migrations.');
  for (const file of files.filter(file => file < '0022_')) {
    migration = file;
    await fixture.query(await readFile(new URL(file, directory), 'utf8'));
  }
  const testEnvironment = {
    ...childEnvironment, PACTWOVEN_NATIVE_TEST_DATABASE_URL: url.href,
    PACTWOVEN_NATIVE_DISPATCH_TEST_DATABASE_URL: url.href,
    PACTWOVEN_NATIVE_AUTHORITY_TEST_DATABASE_URL: url.href,
    PACTWOVEN_NATIVE_TEST_API_PASSWORD: randomBytes(32).toString('base64url'),
    PACTWOVEN_NATIVE_TEST_WORKER_PASSWORD: randomBytes(32).toString('base64url'),
    PACTWOVEN_NATIVE_TEST_DISPATCHER_PASSWORD: randomBytes(32).toString('base64url'),
  };
  // Preserve the populated historical upgrade, then qualify authority against
  // the same database. A second database in this cluster cannot safely recreate
  // the migration-owned reserved roles. Never reapply an older writer after 0025.
  const passes = [
    { test: 'native-dispatch-repository', migrations: [] },
    { test: 'native-task-repository', migrations: ['0023_native_task_search.sql', '0024_native_completion_freshness.sql'] },
    { test: 'native-authority-repository', migrations: ['0025_native_provider_authority.sql'] },
    { test: 'native-task-repository', migrations: [] },
  ];
  for (const { test, migrations } of passes) {
    for (const file of migrations) {
      migration = file;
      await fixture.query(await readFile(new URL(file, directory), 'utf8'));
    }
    migration = test;
    await new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', `packages/db/src/${test}.test.ts`, '--no-file-parallelism'], {
      cwd: new URL('../', import.meta.url), shell: false, stdio: 'inherit', env: {
        ...testEnvironment,
      },
    });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolveRun() : reject(new Error('Native-task tests failed.')));
  });
  }
} catch {
  // PostgreSQL errors can contain private connection/payload values.
  console.error(`Native-task PostgreSQL qualification failed during ${migration}.`);
  process.exitCode = 1;
} finally { await Promise.allSettled([fixture?.end(), admin.end()]); }
