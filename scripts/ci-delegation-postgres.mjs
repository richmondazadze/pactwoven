import { randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

const { Pool } = createRequire(new URL('../packages/db/package.json', import.meta.url))('pg');
if (process.env.CI !== 'true' || process.env.GITHUB_ACTIONS !== 'true' || !process.env.CI_POSTGRES_PASSWORD) {
  throw Error('Delegation qualification requires its dedicated GitHub Actions PostgreSQL service.');
}
const url = new URL('postgresql://pactwoven_native_admin@127.0.0.1:55448/pactwoven_native_test');
url.password = process.env.CI_POSTGRES_PASSWORD;
const admin = new Pool({ connectionString: url.href, max: 1, connectionTimeoutMillis: 5000 });
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  ['PATH', 'HOME', 'TMPDIR', 'LANG', 'CI', 'GITHUB_ACTIONS', 'NODE_OPTIONS'].includes(key)));
const passwords = {
  PACTWOVEN_NATIVE_TEST_API_PASSWORD: randomBytes(32).toString('base64url'),
  PACTWOVEN_NATIVE_TEST_WORKER_PASSWORD: randomBytes(32).toString('base64url'),
  PACTWOVEN_MEMORY_NOTES_TEST_API_PASSWORD: randomBytes(32).toString('base64url'),
};
let fixture, stage = 'initialization';
async function renameFixture(name) {
  await fixture.end();fixture = undefined;
  const previous = url.pathname.slice(1);
  if ((await admin.query('SELECT 1 FROM pg_stat_activity WHERE datname=$1', [previous])).rowCount) throw Error('Fixture still has clients.');
  const sql = (await admin.query("SELECT format('ALTER DATABASE %I RENAME TO %I',$1::text,$2::text) AS sql", [previous, name])).rows[0].sql;
  await admin.query(sql);url.pathname = '/' + name;
  fixture = new Pool({ connectionString: url.href, max: 1, connectionTimeoutMillis: 5000 });
}
async function run(files, variables) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', ...files, '--no-file-parallelism'], {
      cwd: new URL('../', import.meta.url), shell: false, stdio: 'inherit', env: { ...environment, ...passwords, ...variables },
    });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(Error('Qualification tests failed.')));
  });
}
try {
  const directory = new URL('../packages/db/migrations/', import.meta.url);
  const files = (await readdir(directory)).filter(name => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort();
  if (files.length !== 44 || files.at(-1) !== '0044_paid_tool_dispatch.sql') throw Error('Review the delegation upgrade sequence.');
  const existing = await admin.query("SELECT 1 FROM pg_database WHERE datname IN ('pactwoven_native_delegation_ci','pactwoven_native_memory_ci','pactwoven_native_work_intent_ci','pactwoven_native_agent_work_list_ci','pactwoven_native_memory_instructions_ci')");
  if (existing.rowCount) throw Error('Refusing a reused delegation fixture.');
  await admin.query('CREATE DATABASE pactwoven_native_delegation_ci');
  url.pathname = '/pactwoven_native_delegation_ci';
  fixture = new Pool({ connectionString: url.href, max: 1, connectionTimeoutMillis: 5000 });
  for (const file of files.slice(0, 25)) {
    stage = file;
    await fixture.query(await readFile(new URL(file, directory), 'utf8'));
  }
  // The delegation suite preserves a populated v1 baseline and applies0026/27.
  stage = 'delegation storage';
  await run(['packages/db/src/native-delegation-repository.test.ts', 'packages/db/src/native-delegation-pool.test.ts'],
    { PACTWOVEN_NATIVE_DELEGATION_TEST_DATABASE_URL: url.href });
  if (!(await fixture.query("SELECT to_regprocedure('pactwoven.native_memory_task_read(text,jsonb,jsonb)') IS NOT NULL ready")).rows[0]?.ready) {
    throw Error('Delegation tests did not apply scoped memory.');
  }
  // Reserved service roles are cluster-wide. Rename this same disposable DB
  // after all clients close, preserving data and roles for the forward upgrade.
  stage = 'memory fixture handoff';
  await fixture.end(); fixture = undefined;
  if ((await admin.query("SELECT 1 FROM pg_stat_activity WHERE datname='pactwoven_native_delegation_ci'")).rowCount) {
    throw Error('Delegation fixture still has clients.');
  }
  await admin.query('ALTER DATABASE pactwoven_native_delegation_ci RENAME TO pactwoven_native_memory_ci');
  url.pathname = '/pactwoven_native_memory_ci';
  fixture = new Pool({ connectionString: url.href, max: 1, connectionTimeoutMillis: 5000 });
  stage = 'memory before notes';
  await run(['packages/db/src/native-memory.postgres.test.ts', 'packages/db/src/native-memory-repository.test.ts',
    'packages/contracts/src/native-memory.test.ts', 'packages/domain/src/native-memory.test.ts'],
  { PACTWOVEN_MEMORY_TEST_DATABASE_URL: url.href });
  stage = '0028_native_memory_notes.sql';
  await fixture.query(await readFile(new URL(stage, directory), 'utf8'));
  stage = 'notes and retained v1';
  await run(['packages/db/src/native-memory-notes-repository.test.ts', 'packages/contracts/src/native-memory-http.test.ts',
    'packages/db/src/native-task-repository.test.ts'],
  { PACTWOVEN_MEMORY_TEST_DATABASE_URL: url.href, PACTWOVEN_NATIVE_TEST_DATABASE_URL: url.href });
  // Earlier exact-role suites run before additive grants change their profile.
  stage = '0029_native_delegation_root_lifecycle.sql';
  await fixture.query(await readFile(new URL(stage, directory), 'utf8'));
  stage = 'root lifecycle';
  await run(['packages/db/src/native-root-lifecycle.postgres.test.ts', 'packages/db/src/native-root-lifecycle-repository.test.ts'],
    { PACTWOVEN_ROOT_TEST_DATABASE_URL: url.href });
  // The runtime's environment-wide bounded recovery scan must not inherit the
  // preceding synthetic suite's unfinished roots. Keep their records/evidence;
  // stop only that known fixture cohort before the next suite starts.
  await fixture.query("UPDATE pactwoven.native_delegation_root_runs r SET manual_paused=true WHERE EXISTS(SELECT 1 FROM pactwoven.organizations o WHERE(o.environment,o.id)=(r.environment,r.organization_id) AND o.name='Root fixture')");
  stage = 'delegated runtime';
  await run(['services/native-host/src/delegated-runtime.postgres.test.ts'], { PACTWOVEN_DELEGATED_RUNTIME_TEST_DATABASE_URL: url.href });
  stage = '0030_native_work_intent.sql';
  await fixture.query(await readFile(new URL(stage, directory), 'utf8'));
  // Retire the preceding synthetic development cohort before enrolling the
  // next suite's single coordinator and specialist. Historical rows remain.
  await fixture.query("UPDATE pactwoven.native_delegation_services SET enabled=false WHERE environment='development'");
  stage = 'work intent fixture handoff';
  await renameFixture('pactwoven_native_work_intent_ci');
  stage = 'human review and consent';
  await run(['packages/db/src/native-work-intent.postgres.test.ts', 'packages/db/src/native-work-intent-repository.test.ts', 'packages/contracts/src/native-work-intent.test.ts'],
    { PACTWOVEN_WORK_INTENT_TEST_DATABASE_URL: url.href });
  stage = '0031_native_agent_work_list.sql';
  await fixture.query(await readFile(new URL(stage, directory), 'utf8'));
  stage = 'work list fixture handoff';
  await renameFixture('pactwoven_native_agent_work_list_ci','pactwoven_native_memory_instructions_ci');
  stage = 'scoped work history';
  await run(['packages/db/src/native-agent-work-list.postgres.test.ts', 'packages/db/src/native-agent-work-list-repository.test.ts'],
    { PACTWOVEN_AGENT_WORK_LIST_TEST_DATABASE_URL: url.href });
  // Preserve the populated native-work fixture through the additive Calendar
  // upgrade. These checks exercise installed SQL; unit suites alone cannot
  // establish that old data and role boundaries survive the migration.
  stage = 'Google forward upgrade baseline';
  const relationQuery = `SELECT c.oid::text,c.relname,c.relowner::text,c.relacl,c.relrowsecurity,c.relforcerowsecurity
    FROM pg_class c WHERE c.relnamespace='pactwoven'::regnamespace AND c.relkind='r' ORDER BY c.relname`;
  const routineQuery = `SELECT p.oid::text,p.proname,p.proowner::text,p.proacl,p.prosecdef,p.proconfig,
    md5(pg_get_functiondef(p.oid)) definition FROM pg_proc p
    WHERE p.pronamespace='pactwoven'::regnamespace AND p.prokind='f' ORDER BY p.oid`;
  const beforeRelations = (await fixture.query(relationQuery)).rows;
  const beforeRoutines = (await fixture.query(routineQuery)).rows;
  async function rowFingerprints(relations) {
    const rows = [];
    for (const { relname } of relations) {
      if (!/^[a-z][a-z0-9_]*$/.test(relname)) throw Error('Unexpected fixture relation.');
      const result = await fixture.query(`SELECT count(*)::text count,
        md5(coalesce(string_agg(to_jsonb(t)::text,E'\\n' ORDER BY to_jsonb(t)::text),'')) hash
        FROM pactwoven."${relname}" t`);
      rows.push({ name: relname, ...result.rows[0] });
    }
    return rows;
  }
  const beforeRows = await rowFingerprints(beforeRelations);
  for (const file of files.slice(31, 36)) {
    stage = file;
    if (!/^003[2-6]_/.test(file)) throw Error('Unreviewed Google migration.');
    await fixture.query(await readFile(new URL(file, directory), 'utf8'));
  }
  stage = 'Google forward upgrade preservation and denied public access';
  const afterRelations = (await fixture.query(relationQuery)).rows;
  const afterRoutines = (await fixture.query(routineQuery)).rows;
  assert.deepEqual(await rowFingerprints(beforeRelations), beforeRows);
  for (const row of beforeRelations) assert.deepEqual(afterRelations.find(r => r.oid === row.oid), row);
  for (const row of beforeRoutines) assert.deepEqual(afterRoutines.find(r => r.oid === row.oid), row);
  const added = afterRelations.filter(row => !beforeRelations.some(old => old.oid === row.oid));
  assert.equal(added.length, 25);
  assert(added.every(row => row.relrowsecurity && row.relforcerowsecurity));
  const denied = (await fixture.query(`SELECT NOT EXISTS(
    SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
    WHERE p.pronamespace='pactwoven'::regnamespace
      AND (p.proname LIKE 'native_google_%' OR p.proname LIKE 'native_communication_%') AND acl.grantee=0
  ) AND NOT EXISTS(
    SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) acl
    WHERE c.relnamespace='pactwoven'::regnamespace
      AND (c.relname LIKE 'native_google_%' OR c.relname LIKE 'native_communication_%') AND acl.grantee<>c.relowner
  ) safe`)).rows[0]?.safe;
  assert.equal(denied, true);
  console.log(`Google forward upgrade preserved ${beforeRelations.length} tables and ${beforeRoutines.length} routines; ${added.length} protected tables installed.`);
  for (const file of files.slice(36, 39)) {
    stage = file;
    await fixture.query(await readFile(new URL(file, directory), 'utf8'));
  }
  stage = 'paused instructions and revision fencing';
  await renameFixture('pactwoven_native_memory_instructions_ci');
  await run(['packages/db/src/native-work-conversation.postgres.test.ts'],
    { PACTWOVEN_ROOT_TEST_DATABASE_URL: url.href });
  // Admit the additive activity read only after exact P3 profile tests finish.
  stage = '0040_native_work_activity.sql';
  await fixture.query(await readFile(new URL(stage, directory), 'utf8'));
  assert.equal((await fixture.query("SELECT has_function_privilege('pactwoven_native_delegation_api','pactwoven.native_work_activity_read(jsonb,text,text)','EXECUTE') api, has_function_privilege('pactwoven_native_delegation_worker','pactwoven.native_work_activity_read(jsonb,text,text)','EXECUTE') worker")).rows[0].api, true);
  assert.equal((await fixture.query("SELECT has_function_privilege('pactwoven_native_delegation_worker','pactwoven.native_work_activity_read(jsonb,text,text)','EXECUTE') worker")).rows[0].worker, false);
  await run(['packages/db/src/native-work-activity-repository.test.ts', 'packages/db/src/native-work-protocol-pool.test.ts'], {});
  // Apply paid SQL only after the older exact-role suites have completed.
  // All previous rows and table ACLs must survive; the reviewed wait helper
  // is renamed and wrapped so paid results gate the same original root.
  stage = 'paid forward upgrade baseline';
  const paidBeforeRelations = (await fixture.query(relationQuery)).rows;
  const paidBeforeRows = await rowFingerprints(paidBeforeRelations);
  const paidBeforeRoutines = (await fixture.query(routineQuery)).rows;
  const waitBefore = (await fixture.query("SELECT pg_get_functiondef('pactwoven.native_delegation_root_wait_ready(pactwoven.native_delegation_root_runs)'::regprocedure) definition")).rows[0].definition;
  for (const file of files.slice(40)) {
    stage = file;
    await fixture.query(await readFile(new URL(file, directory), 'utf8'));
  }
  stage = 'paid forward upgrade preservation and privilege isolation';
  assert.deepEqual(await rowFingerprints(paidBeforeRelations), paidBeforeRows);
  const paidAfterRelations = (await fixture.query(relationQuery)).rows;
  for (const row of paidBeforeRelations) assert.deepEqual(paidAfterRelations.find(r => r.oid === row.oid), row);
  const paidAfterRoutines = (await fixture.query(routineQuery)).rows;
  for (const row of paidBeforeRoutines.filter(r => r.proname !== 'native_delegation_root_wait_ready'))
    assert.deepEqual(paidAfterRoutines.find(r => r.oid === row.oid), row);
  const waitPreserved = (await fixture.query("SELECT pg_get_functiondef('pactwoven.native_delegation_root_wait_ready_before_paid(pactwoven.native_delegation_root_runs)'::regprocedure) definition")).rows[0].definition;
  assert.equal(waitPreserved, waitBefore.replace('FUNCTION pactwoven.native_delegation_root_wait_ready(', 'FUNCTION pactwoven.native_delegation_root_wait_ready_before_paid('));
  const paidAdded = paidAfterRelations.filter(row => !paidBeforeRelations.some(old => old.oid === row.oid));
  assert(paidAdded.length > 0 && paidAdded.every(row => row.relname.startsWith('paid_tool_') && row.relrowsecurity && row.relforcerowsecurity));
  const paidPublicDenied = (await fixture.query(`SELECT NOT EXISTS(
    SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
    WHERE p.pronamespace='pactwoven'::regnamespace AND p.proname LIKE 'paid_tool_%' AND acl.grantee=0
  ) AND NOT EXISTS(
    SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) acl
    WHERE c.relnamespace='pactwoven'::regnamespace AND c.relname LIKE 'paid_tool_%' AND acl.grantee<>c.relowner
  ) safe`)).rows[0]?.safe;
  assert.equal(paidPublicDenied, true);
  await run(['packages/db/src/paid-tool-pool.test.ts', 'packages/db/src/paid-tool-repository.test.ts',
    'packages/db/src/paid-tool-root-repository.test.ts', 'packages/db/src/paid-tool-dispatch-repository.test.ts'], {});
  console.log(`Paid forward upgrade preserved ${paidBeforeRelations.length} tables; ${paidAdded.length} protected tables installed.`);

} catch {
  console.error(`Delegation PostgreSQL qualification failed during ${stage}.`);
  process.exitCode = 1;
} finally { await Promise.allSettled([fixture?.end(), admin.end()]); }
