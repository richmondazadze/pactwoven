import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import { supplierScopePolicyPairsMatch } from '@pactwoven/contracts';
import { DomainError, immutable } from '@pactwoven/domain';
import { SupplierRelationshipHttpRequestSchema, type SupplierRelationshipHttpGateway } from '../../../packages/contracts/src/supplier-relationship-http.js';
import { SupplierObserverIdentityObservationSchema, snapshotSupplierIdentityObserver } from '../../../packages/db/src/supplier-observer-schema.js';
import { createClerkIdentityObservationVerifier, type ClerkIdentityConfig } from './auth.js';
import { captureSupplierBearer, captureSupplierClerkConfiguration } from './supplier-relationship-verifier.js';
import { readSupplierRelationshipDevelopmentConfig } from './supplier-relationship-config.js';
import { createSupplierRelationshipService } from './supplier-relationship-service.js';

const setup = () => new DomainError('SETUP_REQUIRED', 503, 'Supplier operations are not configured.');
const denied = () => new DomainError('SUPPLIER_ACCESS_DENIED', 403, 'Current exact supplier access is required.');
const unavailable = () => new DomainError('SUPPLIER_VERIFICATION_UNAVAILABLE', 503, 'Supplier authentication is temporarily unavailable.');

/** Lazy, one-process development composition. No login enrollment, migration,
 * provider lookup or DB query occurs during construction. Every operation still
 * reaches the existing exact-principal checks and locked SQL authorization. */
export async function createDevelopmentSupplierRelationship(values: Record<string, string | undefined>, identityInput: ClerkIdentityConfig) {
  const configuration = readSupplierRelationshipDevelopmentConfig(values);
  if (configuration === undefined) return undefined;
  const identity = captureSupplierClerkConfiguration(identityInput, configuration.issuer);
  if (!/^sk_test_[A-Za-z0-9_-]+$/.test(identity.secretKey)) throw setup();
  const pools: Pool[] = [];
  let closing: Promise<void> | undefined, closed = false;
  const close = () => {
    closed = true;
    return closing ??= Promise.allSettled(pools.map(pool => Promise.resolve().then(() => pool.end()))).then(() => {});
  };
  const pool = (connectionString: string) => {
    const value = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30_000, statement_timeout: 5000 });
    pools.push(value); value.on('error', () => {}); return value;
  };
  try {
    const lanes = (['buyer', 'supplier'] as const).map(party => {
      const lane = configuration.lanes[party];
      const observer = { environment: configuration.environment, issuer: configuration.issuer, binding: lane.binding };
      const service = createSupplierRelationshipService({ clerk: identity, observer,
        verifierPool: pool(lane.verifierDatabaseUrl), authorizerPool: pool(lane.authorizerDatabaseUrl) });
      return { externalOrganizationId: lane.externalOrganizationId, observer, submit: service.submit.bind(service) };
    });
    // Select only from a genuinely verified signed identity. This preliminary
    // lookup grants nothing: the chosen service repeats its complete final
    // identity/factor verification and resolves the local actor independently.
    const select = createClerkIdentityObservationVerifier(identity);
    const gateway: SupplierRelationshipHttpGateway = Object.freeze({
      async submit(bearer, input) {
        if (closed) throw setup();
        const token = captureSupplierBearer(bearer), parsed = SupplierRelationshipHttpRequestSchema.safeParse(input);
        if (!parsed.success) throw new DomainError('SUPPLIER_INPUT_INVALID', 422, 'Use the exact supported supplier operation parameters.');
        const request = immutable(parsed.data);
        const pair = request.kind === 'policy-command' ? request.mutation.command.pair : request.kind === 'policy-read' ? request.query.policy.pair :
          request.kind === 'relationship-command' ? request.mutation.command.scope : request.kind === 'relationship-status' ? request.query.scope : request.query.identity.scope;
        if (!supplierScopePolicyPairsMatch(pair, configuration.pair)) throw denied();
        const expectedHash = createHash('sha256').update(token, 'utf8').digest('hex');
        let observed: unknown;
        try { observed = await select(token); }
        catch (error) {
          if (error instanceof DomainError && error.code === 'AUTH_REQUIRED') throw new DomainError('AUTH_REQUIRED', 401, 'Sign in again to continue.');
          if (error instanceof DomainError && error.code === 'FORBIDDEN') throw denied();
          throw unavailable();
        }
        if (closed) throw setup();
        const verified = SupplierObserverIdentityObservationSchema.safeParse(observed);
        if (!verified.success || verified.data.observation.issuer !== configuration.issuer || verified.data.observation.tokenHash !== expectedHash) throw denied();
        const observation = immutable(verified.data), lane = lanes.find(candidate => candidate.externalOrganizationId === observation.identity.externalOrganizationId);
        if (!lane) throw denied();
        try { snapshotSupplierIdentityObserver(observation, lane.observer, new Date().toISOString()); } catch { throw denied(); }
        return lane.submit(token, request);
      },
    });
    return { gateway, close };
  } catch {
    await close();
    throw new Error('Supplier development setup failed. Check the protected paired database and identity configuration.');
  }
}
