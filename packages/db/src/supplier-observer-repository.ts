import type { Pool, PoolClient } from 'pg';
import { DomainError, immutable } from '@pactwoven/domain';
import {
  SupplierObserverActorSchema, SupplierObserverConfigurationSchema, assertSupplierObserverCurrent,
  snapshotSupplierIdentityObserver, snapshotSupplierFactorObserver,
  type SupplierObserverConfiguration, type SupplierObserverIdentityObservation, type SupplierObserverFactorObservation,
  type SupplierObserverSnapshot,
} from './supplier-observer-schema.js';

type Client = Pick<PoolClient, 'query' | 'release'>;
const unavailable = () => new DomainError('SUPPLIER_OBSERVER_UNAVAILABLE', 503, 'Supplier identity resolution is temporarily unavailable.');
const unsafe = () => new DomainError('UNSAFE_DATABASE_ROLE', 503, 'A dedicated supplier verifier connection is required.');
const denied = () => new DomainError('SUPPLIER_ACCESS_DENIED', 403, 'Current exact supplier identity and private binding are required.');

/** Private fixed-query reader, not a provider verifier or a business authorizer.
 * The orchestrator supplies genuine Clerk results and private configured binding;
 * neither belongs to an HTTP body. No public export, token lookup or auto retry.
 * Current DB binding is compared, never silently used to refresh stale config. */
export class PostgresSupplierObserverRepository {
  private readonly config: SupplierObserverConfiguration;
  private readonly connect: () => Promise<Client>;
  private readonly clock: () => string;

  constructor(pool: Pool, config: SupplierObserverConfiguration, clock: () => string = () => new Date().toISOString()) {
    this.config = immutable(SupplierObserverConfigurationSchema.parse(config));
    this.clock = clock;
    const connect = pool.connect.bind(pool);
    this.connect = async () => {
      const client = await connect();
      return { query: client.query.bind(client), release: client.release.bind(client) };
    };
  }

  async resolveIdentity(input: SupplierObserverIdentityObservation) {
    const snapshot = snapshotSupplierIdentityObserver(input, this.config, this.clock());
    return this.resolve(snapshot);
  }

  async resolveFactors(input: SupplierObserverFactorObservation) {
    const snapshot = snapshotSupplierFactorObserver(input, this.config, this.clock());
    return this.resolve(snapshot);
  }

  private async resolve<S extends SupplierObserverSnapshot>(snapshot: S) {
    let client: Client | undefined, discard = false, committing = false;
    const current = () => assertSupplierObserverCurrent(snapshot, this.config, this.clock());
    try {
      client = await this.connect();
      current();
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await client.query("SET LOCAL search_path=pg_catalog; SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='5s'; SET LOCAL idle_in_transaction_session_timeout='8s'; SET LOCAL transaction_timeout='10s'");
      const verifier = this.config.binding.verifier;
      const principal = await client.query<{ safe: boolean }>(`
        SELECT (CURRENT_USER=SESSION_USER AND r.rolname=$1::name AND r.oid=$2::oid
          AND pg_catalog.current_setting('role')='none'
          AND pg_catalog.current_setting('transaction_isolation')='read committed'
          AND r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolbypassrls
          AND NOT r.rolcreatedb AND NOT r.rolcreaterole AND NOT r.rolreplication
          AND NOT r.rolinherit AND r.rolconfig IS NULL
          AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member=r.oid OR m.roleid=r.oid)
        ) AS safe FROM pg_catalog.pg_roles r WHERE r.rolname=SESSION_USER`, [verifier.name, verifier.oid]);
      if (principal.rows.length !== 1 || principal.rows[0]?.safe !== true) throw unsafe();
      current();
      const result = await client.query('SELECT pactwoven.supplier_resolve_observer($1::jsonb,$2::jsonb) AS response',
        [JSON.stringify(this.config.binding), JSON.stringify(snapshot.observation)]);
      if (result.rows.length !== 1 || !result.rows[0] || !Object.hasOwn(result.rows[0], 'response')) throw unavailable();
      const parsed = SupplierObserverActorSchema.safeParse(result.rows[0].response);
      if (!parsed.success) throw unavailable();
      const actor = parsed.data, observed = snapshot.observation;
      if (actor.environment !== this.config.environment || actor.organizationId !== this.config.binding.effectiveOrganizationId ||
        actor.subject !== observed.subject || actor.externalOrganizationId !== observed.externalOrganizationId ||
        actor.externalMembershipId !== observed.externalMembershipId || actor.sessionId !== observed.sessionId) throw unavailable();
      current();
      committing = true;
      const committed = await client.query('COMMIT');
      if (committed.command !== 'COMMIT') throw unavailable();
      committing = false;
      current();
      return immutable({ ...snapshot, actor, binding: this.config.binding });
    } catch (error) {
      discard = true;
      if (client) try { await client.query('ROLLBACK'); } catch { /* Discard; no retry or changed principal. */ }
      if (committing) throw unavailable();
      if (error instanceof DomainError) throw error;
      const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
      if (code === 'SP001') throw denied();
      throw unavailable();
    } finally {
      try { client?.release(discard); } catch { throw unavailable(); }
    }
  }
}
