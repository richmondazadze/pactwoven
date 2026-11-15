import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TLSSocket } from 'node:tls';
import { Pool, type PoolClient, type PoolConfig } from 'pg';

export type MigrationDatabase = 'pactwoven_dev' | 'pactwoven_migration_test';
export type Migration = { number: number; filename: string; checksum: string; statements: string[] };
export type MigrationReport = { database: MigrationDatabase; applied: string[]; skipped: string[] };
type JournalRow = { number: number; filename: string; checksum: string };
const defaultDirectory = fileURLToPath(new URL('../migrations/', import.meta.url));
const journalSchema = 'pactwoven_migrations';
const journalTable = `${journalSchema}.applied_migrations`;
const migrationLock = '741281920001';

export class MigrationError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'MigrationError'; }
}

function rejectTarget(): never {
  throw new MigrationError('MIGRATION_TARGET_REJECTED', 'Use an explicitly selected development database on loopback or verified Neon TLS.');
}

/** Neon may terminate TLS before PostgreSQL; verify the client transport itself. */
export function hasVerifiedMigrationTls(stream: unknown): boolean {
  return stream instanceof TLSSocket && stream.encrypted === true && stream.authorized === true;
}

/** URL fields are parsed once; driver query parameters cannot override them. */
export function migrationPoolConfig(connectionString: string, database: string): PoolConfig {
  if (database !== 'pactwoven_dev' && database !== 'pactwoven_migration_test') rejectTarget();
  try {
    const target = new URL(connectionString);
    const host = target.hostname.toLowerCase();
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(host);
    const neon = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+neon\.tech$/.test(host);
    if (!['postgres:', 'postgresql:'].includes(target.protocol) || target.hash ||
        target.pathname !== `/${database}` || !target.username || !target.password || (!loopback && !neon)) rejectTarget();
    const entries = [...target.searchParams.entries()];
    if (entries.length && !(neon && entries.length === 1 && entries[0]?.[0] === 'sslmode' && entries[0][1] === 'verify-full')) rejectTarget();
    const port = target.port ? Number(target.port) : 5432;
    if (!Number.isInteger(port) || port < 1 || port > 65535) rejectTarget();
    const user = decodeURIComponent(target.username);
    const password = decodeURIComponent(target.password);
    if (!user || !password || user.includes('\0') || password.includes('\0')) rejectTarget();
    return { host: host === '[::1]' ? '::1' : host, port, database, user, password,
      ssl: neon ? { rejectUnauthorized: true } : false,
      max: 1, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 5_000,
      application_name: 'pactwoven-development-migrator' };
  } catch (error) { if (error instanceof MigrationError) throw error; return rejectTarget(); }
}

type SqlStatement = { sql: string; visible: string };

/** Split only top-level semicolons. Quoted function bodies remain one statement. */
function sqlStatements(source: string): SqlStatement[] {
  const statements: SqlStatement[] = [];
  let start = 0;
  let visible = '';
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    if (source.startsWith('--', index)) {
      const offset = source.slice(index + 2).search(/[\r\n]/);
      const end = offset === -1 ? -1 : index + 2 + offset;
      index = end === -1 ? source.length : end + 1;
      visible += ' ';
      continue;
    }
    if (source.startsWith('/*', index)) {
      let depth = 1;
      index += 2;
      while (index < source.length && depth > 0) {
        if (source.startsWith('/*', index)) { depth++; index += 2; }
        else if (source.startsWith('*/', index)) { depth--; index += 2; }
        else index++;
      }
      if (depth) throw new MigrationError('MIGRATION_SOURCE_INVALID', 'A SQL block comment is unterminated.');
      visible += ' ';
      continue;
    }
    const dollar = char === '$' ? /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(source.slice(index))?.[0] : undefined;
    if (dollar) {
      const end = source.indexOf(dollar, index + dollar.length);
      if (end === -1) throw new MigrationError('MIGRATION_SOURCE_INVALID', 'A SQL dollar-quoted body is unterminated.');
      index = end + dollar.length;
      visible += ' <quoted> ';
      continue;
    }
    if (char === "'" || char === '"') {
      const quote = char;
      const escaped = quote === "'" && index > 0 && /[eE]/.test(source[index - 1]!) &&
        (index < 2 || !/[A-Za-z0-9_$]/.test(source[index - 2]!));
      index++;
      let closed = false;
      while (index < source.length) {
        if (escaped && source[index] === '\\') { index += 2; continue; }
        if (source[index] === quote) {
          if (source[index + 1] === quote) { index += 2; continue; }
          index++;
          closed = true;
          break;
        }
        index++;
      }
      if (!closed) throw new MigrationError('MIGRATION_SOURCE_INVALID', 'A SQL quoted value is unterminated.');
      visible += ' <quoted> ';
      continue;
    }
    if (char === ';') {
      if (visible.trim()) statements.push({ sql: source.slice(start, index).trim(), visible: visible.trim().replace(/\s+/g, ' ').toUpperCase() });
      index++;
      start = index;
      visible = '';
      continue;
    }
    visible += char;
    index++;
  }
  if (visible.trim()) statements.push({ sql: source.slice(start).trim(), visible: visible.trim().replace(/\s+/g, ' ').toUpperCase() });
  return statements;
}

export function migrationStatements(source: string): string[] {
  let statements = sqlStatements(source);
  const wrapped = statements[0]?.visible === 'BEGIN' && statements.at(-1)?.visible === 'COMMIT';
  if (wrapped) statements = statements.slice(1, -1);
  if (!statements.length) throw new MigrationError('MIGRATION_SOURCE_INVALID', 'A migration must contain executable SQL.');
  for (const statement of statements) {
    if (/^(?:BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|ABORT|SAVEPOINT|RELEASE|PREPARE\s+TRANSACTION)\b/.test(statement.visible) ||
        /^SET\s+(?:(?:LOCAL|SESSION)\s+)?(?:TRANSACTION|SESSION\s+CHARACTERISTICS|STANDARD_CONFORMING_STRINGS)\b/.test(statement.visible)) {
      throw new MigrationError('MIGRATION_TRANSACTION_CONTROL', 'Migrations may only use one outer BEGIN/COMMIT pair; the runner owns transaction control.');
    }
  }
  return statements.map(statement => statement.sql);
}

export async function loadMigrations(directory: string = defaultDirectory): Promise<Migration[]> {
  try {
    const entries = (await readdir(directory, { withFileTypes: true })).filter(entry => entry.name.endsWith('.sql')).sort((a, b) => a.name.localeCompare(b.name));
    if (!entries.length) throw new MigrationError('MIGRATION_SOURCE_INVALID', 'No numbered SQL migrations were found.');
    const migrations: Migration[] = [];
    for (const [index, entry] of entries.entries()) {
      const match = /^(\d{4})_[a-z0-9_]+\.sql$/.exec(entry.name);
      if (!entry.isFile() || !match || Number(match[1]) !== index + 1) {
        throw new MigrationError('MIGRATION_ORDER_INVALID', 'Migrations must be regular files numbered consecutively from 0001 with no duplicates.');
      }
      const bytes = await readFile(join(directory, entry.name));
      const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      migrations.push({ number: index + 1, filename: entry.name, checksum: createHash('sha256').update(bytes).digest('hex'), statements: migrationStatements(source) });
    }
    return migrations;
  } catch (error) {
    if (error instanceof MigrationError) throw error;
    throw new MigrationError('MIGRATION_SOURCE_INVALID', 'Migration source files could not be read safely.');
  }
}

function verifyHistory(history: JournalRow[], migrations: Migration[]): void {
  for (const [index, row] of history.entries()) {
    const migration = migrations[index];
    if (row.number !== index + 1 || !migration || migration.filename !== row.filename) {
      throw new MigrationError('MIGRATION_HISTORY_MISMATCH', 'Applied migration history is missing or out of order in the current source.');
    }
    if (row.checksum !== migration.checksum) throw new MigrationError('MIGRATION_CHECKSUM_MISMATCH', 'An applied SQL migration changed. Restore it and author a new migration.');
  }
}

export async function migrateDatabase(connectionString: string, database: MigrationDatabase,
  directory: string = defaultDirectory): Promise<MigrationReport> {
  const config = migrationPoolConfig(connectionString, database);
  const migrations = await loadMigrations(directory);
  const pool = new Pool(config);
  pool.on('error', () => {});
  let client: PoolClient | undefined;
  let transaction = false;
  let broken = false;
  try {
    client = await pool.connect();
    // node-postgres exposes its live transport on connection.stream. Fail closed
    // if a future driver no longer exposes a certificate-verified TLS socket.
    const transport = (client as PoolClient & { connection?: { stream?: unknown } }).connection?.stream;
    if (config.ssl && !hasVerifiedMigrationTls(transport)) rejectTarget();
    const target = await client.query<{ database: string; address: string; same_identity: boolean }>(`SELECT current_database() AS database,
      host(inet_server_addr()) AS address, current_user=session_user AS same_identity`);
    const actual = target.rows[0];
    if (!actual || actual.database !== database || !actual.same_identity ||
        (!config.ssl && !['127.0.0.1', '::1'].includes(actual.address))) rejectTarget();
    await client.query('BEGIN');
    transaction = true;
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SET LOCAL statement_timeout = '60s'");
    await client.query("SET LOCAL standard_conforming_strings = 'on'");
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [migrationLock]);
    const existing = await client.query<{ journal: string | null; schema_exists: boolean; application_exists: boolean }>(`SELECT
      to_regclass('${journalTable}')::text AS journal,
      EXISTS (SELECT 1 FROM pg_namespace WHERE nspname='${journalSchema}') AS schema_exists,
      EXISTS (SELECT 1 FROM pg_namespace WHERE nspname='pactwoven') AS application_exists`);
    let history: JournalRow[] = [];
    if (existing.rows[0]?.journal) {
      try { history = (await client.query<JournalRow>(`SELECT number,filename,checksum FROM ${journalTable} ORDER BY number`)).rows; }
      catch { throw new MigrationError('MIGRATION_JOURNAL_INVALID', 'The migration journal is not readable in the required format.'); }
      if (existing.rows[0].application_exists && history.length === 0) {
        throw new MigrationError('MIGRATION_UNJOURNALED_DATABASE', 'Existing application schema has no applied migration history. Review it before applying migrations.');
      }
    } else if (existing.rows[0]?.schema_exists || existing.rows[0]?.application_exists) {
      throw new MigrationError('MIGRATION_UNJOURNALED_DATABASE', 'Existing application or journal schema has no migration history. Review it before applying migrations.');
    }
    verifyHistory(history, migrations);
    if (!existing.rows[0]?.journal) {
      await client.query(`CREATE SCHEMA ${journalSchema}; REVOKE ALL ON SCHEMA ${journalSchema} FROM PUBLIC;
        CREATE TABLE ${journalTable} (number integer PRIMARY KEY CHECK(number>0), filename text NOT NULL UNIQUE,
          checksum text NOT NULL CHECK(checksum ~ '^[a-f0-9]{64}$'), applied_at timestamptz NOT NULL DEFAULT clock_timestamp());
        REVOKE ALL ON ${journalTable} FROM PUBLIC`);
    }
    const pending = migrations.slice(history.length);
    for (const migration of pending) {
      for (const statement of migration.statements) {
        // pg's extended protocol rejects multiple top-level commands per parse.
        // This additionally fences unexpected SQL lexical/session settings.
        const query = { text: statement, queryMode: 'extended' };
        await client.query(query);
      }
      await client.query(`INSERT INTO ${journalTable}(number,filename,checksum) VALUES ($1,$2,$3)`,
        [migration.number, migration.filename, migration.checksum]);
    }
    await client.query('COMMIT');
    transaction = false;
    return { database, applied: pending.map(item => item.filename), skipped: history.map(item => item.filename) };
  } catch (error) {
    if (transaction && client) { try { await client.query('ROLLBACK'); } catch { broken = true; } }
    if (error instanceof MigrationError) throw error;
    throw new MigrationError('MIGRATION_FAILED', 'Development migrations were not confirmed. Inspect the database with the migration journal before retrying.');
  } finally {
    client?.release(broken ? new Error('Migration connection is unusable') : undefined);
    await pool.end().catch(() => {});
  }
}

export async function runMigrationsFromEnvironment(environment: NodeJS.ProcessEnv = process.env): Promise<MigrationReport> {
  const file = environment.PACTWOVEN_MIGRATION_DATABASE_URL_FILE;
  const database = environment.PACTWOVEN_MIGRATION_DATABASE;
  if (!file || (database !== 'pactwoven_dev' && database !== 'pactwoven_migration_test')) {
    throw new MigrationError('MIGRATION_CONFIG_REQUIRED', 'Set the protected migration DSN file and explicit allowed development database name.');
  }
  let connectionString: string;
  try {
    const metadata = await lstat(file);
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0 || metadata.size > 8192) throw new Error('Invalid protected file');
    connectionString = (await readFile(file, 'utf8')).trim();
  } catch { throw new MigrationError('MIGRATION_CREDENTIAL_FILE_INVALID', 'The migration DSN must be a private regular file readable by this process.'); }
  return migrateDatabase(connectionString, database);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.info(JSON.stringify(await runMigrationsFromEnvironment())); }
  catch (error) {
    console.error(error instanceof MigrationError ? `${error.code}: ${error.message}` : 'MIGRATION_FAILED: Development migrations were not confirmed.');
    process.exitCode = 1;
  }
}
