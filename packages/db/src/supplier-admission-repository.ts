import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { SupplierAdmissionReferenceSchema } from '@pactwoven/contracts';
import { canonicalJson, immutable, DomainError } from '@pactwoven/domain';
import { supplierRuntimeMembershipPredicate } from './supplier-runtime-membership.js';
import {
  SupplierAdmissionConfigurationSchema, snapshotSupplierAdmissionEvidence, snapshotSupplierAdmissionResult,
  type SupplierAdmissionConfiguration, type SupplierAdmissionEvidence, type SupplierAdmissionPrivateRequest, type SupplierAdmissionActor,
} from './supplier-admission-persistence-schema.js';

type Client = Pick<PoolClient, 'query' | 'release'>;
type Snapshot = Awaited<ReturnType<typeof snapshotSupplierAdmissionEvidence>>;
declare const recordedAdmission: unique symbol;
export type SupplierAdmissionRecordedCall = Readonly<{ reference: z.infer<typeof SupplierAdmissionReferenceSchema>; [recordedAdmission]: never }>;
const recorded = new WeakMap<SupplierAdmissionRecordedCall, Snapshot>();
const attempted = new WeakSet<SupplierAdmissionRecordedCall>();
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const unknown = () => new DomainError('SUPPLIER_OUTCOME_UNKNOWN', 503, 'Preserve the exact supplier original and use explicit recovery.');
const denied = () => new DomainError('SUPPLIER_ADMISSION_DENIED', 403, 'Current exact supplier owner and private admission are required.');
const unavailable = () => new DomainError('SUPPLIER_ADMISSION_UNAVAILABLE', 503, 'Supplier admission is temporarily unavailable.');
function one(rows: unknown[]) {
  if (rows.length !== 1 || rows[0] === null || typeof rows[0] !== 'object' || !Object.hasOwn(rows[0], 'response')) throw unavailable();
  return (rows[0] as { response: unknown }).response;
}
function failure(error: unknown, dispatched: boolean): never {
  if (error instanceof DomainError) throw error;
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
  if (code === 'SA001' || code === 'SP001') throw denied();
  if (code === 'SA002') throw new DomainError('SUPPLIER_ADMISSION_STALE', 409, 'Supplier review or current authority changed.');
  if (code === 'SA003') throw new DomainError('SUPPLIER_ORIGINAL_KEY_CONFLICT', 409, 'This original supplier key belongs to different material.');
  if (code === 'SA004') throw new DomainError('SUPPLIER_ADMISSION_INVALID', 422, 'Use the exact permitted supplier enrollment material.');
  throw dispatched ? unknown() : unavailable();
}

/** Fixed private transport. It does not verify a provider or make SQL-shaped JSON a capability. */
class AdmissionConnection {
  readonly config: SupplierAdmissionConfiguration;
  readonly clock: () => string;
  private readonly connect: () => Promise<Client>;
  constructor(pool: Pool, config: SupplierAdmissionConfiguration, clock: () => string) {
    this.config = immutable(SupplierAdmissionConfigurationSchema.parse(config)); this.clock = clock;
    const connect = pool.connect.bind(pool);
    this.connect = async () => { const client = await connect(); return { query: client.query.bind(client), release: client.release.bind(client) }; };
  }
  async transaction<T>(capability: 'verifier' | 'authorizer', mutation: boolean, work: (client: Client, dispatched: () => void) => Promise<T>): Promise<T> {
    let client: Client | undefined, discard = false, committing = false, dispatched = false;
    try {
      client = await this.connect();
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await client.query("SET LOCAL search_path=pg_catalog; SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='5s'; SET LOCAL idle_in_transaction_session_timeout='8s'; SET LOCAL transaction_timeout='10s'");
      const expected = this.config.binding[capability];
      const principal = await client.query<{ safe: boolean }>(`SELECT (current_user=session_user AND r.rolname=$1::name AND r.oid=$2::oid
        AND pg_catalog.current_setting('role')='none' AND pg_catalog.current_setting('transaction_isolation')='read committed'
        AND r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreatedb AND NOT r.rolcreaterole
        AND NOT r.rolreplication AND NOT r.rolinherit AND r.rolconfig IS NULL AND (${supplierRuntimeMembershipPredicate})) AS safe
        FROM pg_catalog.pg_roles r WHERE r.rolname=session_user`, [expected.name, expected.oid]);
      if (principal.rows.length !== 1 || principal.rows[0]?.safe !== true) throw denied();
      const value = await work(client, () => { dispatched = true; });
      committing = true;
      const committed = await client.query('COMMIT');
      if (committed.command !== 'COMMIT') throw unavailable();
      committing = false;
      return value;
    } catch (error) {
      discard = true;
      if (client) try { await client.query('ROLLBACK'); } catch { /* Discard the socket; never retry or switch principal. */ }
      if (committing && mutation) throw unknown();
      if (committing) throw unavailable();
      return failure(error, mutation && dispatched);
    } finally {
      try { client?.release(discard); } catch { throw mutation && dispatched ? unknown() : unavailable(); }
    }
  }
}

export class PostgresSupplierAdmissionEvidenceRepository {
  private readonly connection: AdmissionConnection;
  constructor(pool: Pool, config: SupplierAdmissionConfiguration, clock: () => string = () => new Date().toISOString()) {
    this.connection = new AdmissionConnection(pool, config, clock);
  }
  async append(input: SupplierAdmissionEvidence, expectedRequest: SupplierAdmissionPrivateRequest, expectedActor: SupplierAdmissionActor): Promise<SupplierAdmissionRecordedCall> {
    const snapshot = await snapshotSupplierAdmissionEvidence(input, expectedRequest, expectedActor, this.connection.config, this.connection.clock());
    const reference = await this.connection.transaction('verifier', false, async (client, dispatched) => {
      await snapshotSupplierAdmissionEvidence(snapshot.evidence, expectedRequest, expectedActor, this.connection.config, this.connection.clock());
      dispatched();
      const raw = await client.query('SELECT pactwoven.supplier_admission_record_evidence($1::jsonb) AS response', [JSON.stringify(snapshot.evidence)]);
      const reference = SupplierAdmissionReferenceSchema.parse(one(raw.rows));
      if (reference.id !== snapshot.evidence.id || reference.version !== 1 || reference.hash !== snapshot.digest) throw unavailable();
      return immutable(reference);
    });
    const handle = immutable({ reference }) as SupplierAdmissionRecordedCall;
    recorded.set(handle, snapshot);
    return handle;
  }
}

export class PostgresSupplierAdmissionRepository {
  private readonly connection: AdmissionConnection;
  constructor(pool: Pool, config: SupplierAdmissionConfiguration, clock: () => string = () => new Date().toISOString()) {
    this.connection = new AdmissionConnection(pool, config, clock);
  }
  async execute(handle: SupplierAdmissionRecordedCall) {
    const snapshot = recorded.get(handle);
    if (snapshot === undefined || attempted.has(handle) || !same(snapshot.evidence.binding, this.connection.config.binding) ||
      !same(snapshot.evidence.lane, this.connection.config.lane)) throw denied();
    attempted.add(handle);
    const { evidence } = snapshot, isMutation = evidence.request.kind === 'enrollment-command';
    return this.connection.transaction('authorizer', isMutation, async (client, dispatched) => {
      await snapshotSupplierAdmissionEvidence(evidence, evidence.request, evidence.actor, this.connection.config, this.connection.clock());
      dispatched();
      const result = await client.query('SELECT pactwoven.supplier_admission_execute($1::uuid,$2::jsonb) AS response',
        [evidence.id, JSON.stringify(evidence.request)]);
      // A malformed response after dispatch is unresolved; do not accept a narrow
      // sanitized SQLSTATE from parser errors as proof that no mutation happened.
      try { return await snapshotSupplierAdmissionResult(one(result.rows), evidence.request, evidence.actor); }
      catch { throw isMutation ? unknown() : unavailable(); }
    });
  }
}
