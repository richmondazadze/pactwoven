import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { InstantSchema, VersionReferenceSchema } from '@pactwoven/contracts';
import { DomainError, canonicalJson, immutable } from '@pactwoven/domain';
import {
  snapshotSupplierAuthenticationEvidence, type SupplierAuthenticationEvidence,
} from './supplier-relationship-auth-evidence.js';
import {
  SupplierPrivatePrincipalBindingSchema, SupplierPrivateRequestSchema,
  snapshotSupplierPersistenceResult, type SupplierPrivateRequest,
} from './supplier-relationship-persistence-schema.js';

// Private, in-process SQL transport only. The trusted verifier/orchestrator still
// must authenticate the provider and independently load the expected actor and
// principal binding. Structural validation and the handle below do not do that.
// Cross-service transport needs a separately reviewed context contract; handles
// cannot be reconstructed from JSON, a UUID, a digest or an actor locator.
type Binding = z.infer<typeof SupplierPrivatePrincipalBindingSchema>;
type Capability = 'verifier' | 'authorizer';
type Client = Pick<PoolClient, 'query' | 'release'>;
type Result = Awaited<ReturnType<typeof snapshotSupplierPersistenceResult>>['value'];
type ResultFor<K extends SupplierPrivateRequest['kind']> = Extract<Result, { kind: K }>;
type EvidenceSnapshot = Awaited<ReturnType<typeof snapshotSupplierAuthenticationEvidence>>;
declare const recordedCallBrand: unique symbol;
export type SupplierRecordedCall = Readonly<{
  reference: Readonly<z.infer<typeof VersionReferenceSchema>>;
  [recordedCallBrand]: never;
}>;
const recordedCalls = new WeakMap<SupplierRecordedCall, EvidenceSnapshot>();
const attemptedCalls = new WeakSet<SupplierRecordedCall>();
const now = () => new Date().toISOString();
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const unavailable = () => new DomainError('SUPPLIER_OUTCOME_UNKNOWN', 503,
  'The supplier result is unconfirmed. Preserve the exact original request and use explicit recovery.');
const unsafe = () => new DomainError('UNSAFE_DATABASE_ROLE', 503,
  'A dedicated supplier verifier or authorizer connection is required.');
const refused = () => new DomainError('SUPPLIER_PRIVATE_CALL_REQUIRED', 403,
  'The exact recorded private supplier call is required.');

const statements = {
  'policy-command': 'SELECT pactwoven.supplier_scope_policy_command($1::uuid,$2::jsonb) AS response',
  'policy-read': 'SELECT pactwoven.supplier_scope_policy_read($1::uuid,$2::jsonb) AS response',
  'relationship-command': 'SELECT pactwoven.supplier_relationship_command($1::uuid,$2::jsonb) AS response',
  'relationship-status': 'SELECT pactwoven.supplier_relationship_status($1::uuid,$2::jsonb) AS response',
  'relationship-observation-plan': 'SELECT pactwoven.supplier_relationship_status($1::uuid,$2::jsonb) AS response',
  'relationship-recover': 'SELECT pactwoven.supplier_relationship_recover($1::uuid,$2::jsonb) AS response',
} satisfies Record<SupplierPrivateRequest['kind'], string>;

function one(rows: unknown[]): unknown {
  if (rows.length !== 1 || typeof rows[0] !== 'object' || rows[0] === null ||
    !Object.hasOwn(rows[0], 'response')) throw unavailable();
  return (rows[0] as { response: unknown }).response;
}

/** This check binds the actual checkout to its private principal. The migration's
 * entry point separately checks the full privilege allowlist and latest binding
 * under its registry/lineage locks; this query is not a substitute for that. */
async function assertPrincipal(client: Client, binding: Binding, capability: Capability): Promise<void> {
  const principal = binding[capability];
  try {
    const result = await client.query<{ safe: boolean }>(`
      SELECT (CURRENT_USER=SESSION_USER AND r.rolname=$1::name AND r.oid=$2::oid
        AND pg_catalog.current_setting('role')='none'
        AND pg_catalog.current_setting('transaction_isolation')='read committed'
        AND r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolbypassrls
        AND NOT r.rolcreatedb AND NOT r.rolcreaterole AND NOT r.rolreplication
        AND NOT r.rolinherit AND r.rolconfig IS NULL
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member=r.oid OR m.roleid=r.oid)
      ) AS safe FROM pg_catalog.pg_roles r WHERE r.rolname=SESSION_USER`, [principal.name, principal.oid]);
    if (result.rows.length !== 1 || result.rows[0]?.safe !== true) throw unsafe();
  } catch { throw unsafe(); }
}

function databaseError(error: unknown): never {
  if (error instanceof DomainError) throw error;
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
  if (code === 'SP001') throw new DomainError('SUPPLIER_ACCESS_DENIED', 403,
    'Current exact supplier authority and evidence are required.');
  if (code === 'SP003') throw new DomainError('SUPPLIER_AUTHORITY_IMMUTABLE', 409,
    'Supplier authority records cannot be replaced or removed.');
  throw unavailable();
}

class PrivateConnection {
  readonly binding: Binding;
  readonly clock: () => string;
  private readonly connect: () => Promise<Client>;

  constructor(pool: Pool, binding: Binding, clock: () => string) {
    this.binding = immutable(SupplierPrivatePrincipalBindingSchema.parse(binding));
    this.clock = clock;
    const connect = pool.connect.bind(pool);
    this.connect = async () => {
      const client = await connect();
      return { query: client.query.bind(client), release: client.release.bind(client) };
    };
  }

  async transaction<T>(capability: Capability, work: (client: Client) => Promise<T>): Promise<T> {
    let client: Client | undefined, discard = false, committing = false;
    try {
      client = await this.connect();
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await client.query("SET LOCAL search_path=pg_catalog; SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='5s'; SET LOCAL idle_in_transaction_session_timeout='8s'; SET LOCAL transaction_timeout='10s'");
      await assertPrincipal(client, this.binding, capability);
      const value = await work(client);
      committing = true;
      const committed = await client.query('COMMIT');
      if (committed.command !== 'COMMIT') throw unavailable();
      return value;
    } catch (error) {
      discard = true;
      if (client) try { await client.query('ROLLBACK'); } catch { /* Discard; never replay a call. */ }
      // A failed/missing commit acknowledgement cannot establish the outcome,
      // even if a server-shaped error happens to contain a familiar SQLSTATE.
      if (committing) throw unavailable();
      return databaseError(error);
    } finally {
      try { client?.release(discard); } catch { throw unavailable(); }
    }
  }
}

/** The private verifier supplies independently authenticated expected inputs.
 * The returned handle proves only this module's exact successful SQL recording;
 * it does not claim that parsing verified a provider or established authority. */
export class PostgresSupplierAuthenticationRepository {
  private readonly connection: PrivateConnection;

  constructor(pool: Pool, binding: Binding, clock: () => string = now) {
    this.connection = new PrivateConnection(pool, binding, clock);
  }

  async append(
    input: SupplierAuthenticationEvidence,
    expectedRequest: SupplierPrivateRequest,
    expectedActor: SupplierAuthenticationEvidence['actor'],
  ): Promise<SupplierRecordedCall> {
    const snapshot = await snapshotSupplierAuthenticationEvidence(
      input, expectedRequest, expectedActor, this.connection.binding, this.connection.clock(),
    );
    const reference = await this.connection.transaction('verifier', async client => {
      const raw = one((await client.query('SELECT pactwoven.supplier_record_evidence($1::jsonb) AS response',
        [JSON.stringify(snapshot.evidence)])).rows);
      const parsed = VersionReferenceSchema.safeParse(raw);
      if (!parsed.success || parsed.data.id !== snapshot.evidence.id || parsed.data.version !== 1 ||
        parsed.data.hash !== snapshot.digest) throw unavailable();
      return immutable(parsed.data);
    });
    const handle = Object.freeze({ reference }) as SupplierRecordedCall;
    recordedCalls.set(handle, snapshot);
    return handle;
  }
}

/** Authorizer transport uses the same module's committed verifier handle, never
 * a caller-supplied actor/UUID tuple. Observation plans contain private external
 * identifiers and must remain inside the trusted verifier/orchestrator. Public
 * reads retain the existing redacted projection and its NOT_ESTABLISHED fields. */
export class PostgresSupplierRelationshipRepository {
  private readonly connection: PrivateConnection;

  constructor(pool: Pool, binding: Binding, clock: () => string = now) {
    this.connection = new PrivateConnection(pool, binding, clock);
  }

  async execute<R extends SupplierPrivateRequest>(handle: SupplierRecordedCall, input: R): Promise<ResultFor<R['kind']>> {
    const recorded = recordedCalls.get(handle);
    if (!recorded || !same(recorded.evidence.binding, this.connection.binding)) throw refused();
    const request = immutable(SupplierPrivateRequestSchema.parse(input));
    if (!same(request, recorded.evidence.request)) throw refused();
    if (attemptedCalls.has(handle)) throw new DomainError('SUPPLIER_CALL_ALREADY_ATTEMPTED', 409,
      'Obtain fresh evidence for the exact original request or its explicit recovery.');
    // Reserve synchronously, before any hash or pool wait. Concurrent calls and
    // uncertain outcomes cannot turn one handle into an implicit retry channel.
    attemptedCalls.add(handle);
    await snapshotSupplierAuthenticationEvidence(recorded.evidence, request, recorded.evidence.actor,
      this.connection.binding, InstantSchema.parse(this.connection.clock()));
    const actor = recorded.evidence.actor;
    const result = await this.connection.transaction('authorizer', async client => {
      const raw = one((await client.query(statements[request.kind],
        [handle.reference.id, JSON.stringify(request)])).rows);
      try {
        return (await snapshotSupplierPersistenceResult(raw, request, {
          environment: actor.environment, organizationId: actor.organizationId, actorId: actor.actorId,
        })).value;
      } catch { throw unavailable(); }
    });
    // The shared result inspector checked the exact request family and all
    // correlations supplied by SQL before commit. No extra authority is added.
    return result as ResultFor<R['kind']>;
  }
}
