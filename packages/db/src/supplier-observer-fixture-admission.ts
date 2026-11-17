import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { Socket } from 'node:net';
import { TLSSocket } from 'node:tls';
import type { PoolClient, PoolConfig } from 'pg';
import { loadMigrations } from './migrate.js';

// A different opt-in, database and proposed port from the accepted 0015 fixture.
// This module never starts PostgreSQL, creates a database, or resets a cluster.
export const observerFixtureVariable = 'PACTWOVEN_SUPPLIER_OBSERVER_TEST_ADMIN_URL_FILE';
export const observerConsentVariable = 'PACTWOVEN_SUPPLIER_OBSERVER_DISPOSABLE';
export const observerDatabase = 'pactwoven_supplier_observer_sql_test';
export const observerPort = 55442;
export const observerMigrationPins = [
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
  ['0015_supplier_relationship_authority.sql', '4fe259454de7f05f9e2a1de55b4ab1ec0ea79e6c28f02f7a35c275ca5d38271c'],
  ['0016_supplier_observer_resolution.sql', '5321181da323b6b56709b36d5ca607a2a9511535773a9f8abac5cb3e67c15fc1'],
] as const;

export function observerFixtureConfig(value: string): PoolConfig {
  const url = new URL(value), user = decodeURIComponent(url.username), password = decodeURIComponent(url.password);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1' ||
    url.port !== String(observerPort) || url.pathname !== `/${observerDatabase}` || url.search || url.hash ||
    user !== 'supplier_observer_fixture_admin' || !password || password.includes('\0')) {
    throw new Error('Exact new observer fixture URL required.');
  }
  return { host: '127.0.0.1', port: observerPort, database: observerDatabase, user, password,
    ssl: false, max: 2, connectionTimeoutMillis: 3_000, statement_timeout: 5_000,
    idle_in_transaction_session_timeout: 5_000, options: '-c transaction_timeout=10s',
    application_name: 'supplier-observer-disposable-test' };
}

export async function readObserverFixtureConfig(environment: NodeJS.ProcessEnv = process.env) {
  const path = environment[observerFixtureVariable];
  if (!path || !isAbsolute(path) || environment[observerConsentVariable] !== 'YES_NEW_LOCAL_ONLY' ||
    Object.keys(environment).some(key => key.startsWith('PG') || key.startsWith('PACTWOVEN_') &&
      ![observerFixtureVariable, observerConsentVariable].includes(key))) {
    throw new Error('Explicit observer-only admission and scrubbed environment required.');
  }
  const before = await lstat(path);
  const uid = process.getuid?.();
  if (uid === undefined || uid === 0 || !before.isFile() || before.isSymbolicLink() || before.uid !== uid ||
    (before.mode & 0o777) !== 0o600 || before.size < 1 || before.size > 8192) {
    throw new Error('Owned private regular observer credential file required.');
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await file.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.uid !== uid ||
      !opened.isFile() || (opened.mode & 0o777) !== 0o600 || opened.size !== before.size) throw new Error('Credential file changed.');
    const bytes = Buffer.alloc(8193);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    const after = await file.stat(), named = await lstat(path);
    if (bytesRead !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs || named.dev !== after.dev || named.ino !== after.ino || named.isSymbolicLink()) {
      throw new Error('Observer credential file changed during read.');
    }
    return observerFixtureConfig(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead)).trim());
  } finally { await file.close(); }
}

export async function assertObserverSocket(client: PoolClient, config: PoolConfig) {
  const stream = (client as PoolClient & { connection?: { stream?: unknown } }).connection?.stream;
  if (!(stream instanceof Socket) || stream instanceof TLSSocket || stream.readyState !== 'open' || stream.destroyed ||
    stream.remotePort !== observerPort || !['127.0.0.1', '::ffff:127.0.0.1'].includes(stream.remoteAddress ?? '')) {
    throw new Error('Exact observer loopback socket required.');
  }
  const row = (await client.query(`SELECT current_database() AS database,current_user AS principal,session_user AS session,
    current_setting('server_version_num')::int AS version,current_setting('transaction_timeout')::interval=interval '10 seconds' AS bounded`)).rows[0];
  if (row?.database !== observerDatabase || row.principal !== config.user || row.session !== config.user ||
    row.version < 170000 || row.bounded !== true) throw new Error('Exact observer fixture server/login required.');
}

export async function loadObserverFixtureMigrations() {
  const migrations = await loadMigrations();
  if (migrations.length !== observerMigrationPins.length || migrations.some((migration, index) =>
    migration.number !== index + 1 || migration.filename !== observerMigrationPins[index]?.[0] ||
    migration.checksum !== observerMigrationPins[index]?.[1])) throw new Error('Exact pinned sixteen migrations required.');
  return migrations;
}
