import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import { supplierScopePolicyPairsMatch } from '@pactwoven/contracts';
import { DomainError, immutable } from '@pactwoven/domain';
import { SupplierRelationshipHttpRequestSchema, type SupplierRelationshipHttpGateway } from '../../../packages/contracts/src/supplier-relationship-http.js';
import { SupplierObserverIdentityObservationSchema, snapshotSupplierIdentityObserver } from '../../../packages/db/src/supplier-observer-schema.js';
import { createClerkIdentityObservationVerifier } from './auth.js';
import { captureSupplierBearer, captureSupplierClerkConfiguration } from './supplier-relationship-verifier.js';
import { createSupplierRelationshipService } from './supplier-relationship-service.js';
import { readSupplierWorkerConfig, type SupplierWorkerBindings } from './supplier-worker-config.js';
import { handlePrivateSupplierRequest, supplierPrivateUrl } from './worker-supplier.js';
import { createWorkerPool } from './worker-database.js';
import { requestResource, workerUnavailable, type WorkerContext } from './worker-config.js';

const setup = () => new DomainError('SETUP_REQUIRED', 503, 'Supplier operations are not configured.');
const denied = () => new DomainError('SUPPLIER_ACCESS_DENIED', 403, 'Current exact supplier access is required.');
const unavailable = () => new DomainError('SUPPLIER_VERIFICATION_UNAVAILABLE', 503, 'Supplier authentication is temporarily unavailable.');

/** One invocation owns the full private pipeline. Only its selected lane opens
 * pools; no connection or recorded authentication handle crosses invocations. */
export function createSupplierWorkerRelationship(configuration: ReturnType<typeof readSupplierWorkerConfig>) {
  const identity = captureSupplierClerkConfiguration({ secretKey: configuration.secretKey, issuer: configuration.issuer,
    authorizedParties: [...configuration.allowedOrigins] }, configuration.issuer);
  const resources: Array<{ close(): Promise<void> }> = [];
  let closed = false, closing: Promise<void> | undefined;
  const close = () => {
    closed = true;
    return closing ??= Promise.allSettled(resources.map(resource => resource.close())).then(() => {});
  };
  const pool = (connectionString: string, expectedUser: string): Pool => {
    const resource = requestResource(async () => {
      const value = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 30_000, statement_timeout: 5000 });
      value.on('error', () => {});
      return createWorkerPool(async () => value, expectedUser);
    });
    resources.push(resource);
    // Supplier repositories capture only connect. The actual pool is origin-
    // checked before it is exposed, then every transaction checks name + OID.
    return { connect: async () => {
      if (closed) throw setup();
      const value = await resource.get();
      if (closed) throw setup();
      return value.connect();
    } } as Pool;
  };
  const lanes = (['buyer', 'supplier'] as const).map(party => {
    const lane = configuration.lanes[party], connection = configuration.connectionStrings[party];
    const observer = { environment: configuration.environment, issuer: configuration.issuer, binding: lane.binding };
    let service: ReturnType<typeof createSupplierRelationshipService> | undefined;
    return { externalOrganizationId: lane.externalOrganizationId, observer,
      submit: (token: string, request: Parameters<SupplierRelationshipHttpGateway['submit']>[1]) => {
        service ??= createSupplierRelationshipService({ clerk: identity, observer,
          verifierPool: pool(connection.verifier, lane.binding.verifier.name),
          authorizerPool: pool(connection.authorizer, lane.binding.authorizer.name) });
        return service.submit(token, request);
      } };
  });
  const select = createClerkIdentityObservationVerifier(identity);
  const gateway: SupplierRelationshipHttpGateway = Object.freeze({
    async submit(bearer, raw) {
      if (closed) throw setup();
      const token = captureSupplierBearer(bearer), parsed = SupplierRelationshipHttpRequestSchema.safeParse(raw);
      if (!parsed.success) throw new DomainError('SUPPLIER_INPUT_INVALID', 422, 'Use the exact supported supplier operation parameters.');
      const request = immutable(parsed.data);
      const pair = request.kind === 'policy-command' ? request.mutation.command.pair : request.kind === 'policy-read' ? request.query.policy.pair :
        request.kind === 'relationship-command' ? request.mutation.command.scope : request.kind === 'relationship-status' ? request.query.scope : request.query.identity.scope;
      if (!supplierScopePolicyPairsMatch(pair, configuration.pair)) throw denied();
      let observed: unknown;
      try { observed = await select(token); }
      catch (error) {
        if (error instanceof DomainError && error.code === 'AUTH_REQUIRED') throw new DomainError('AUTH_REQUIRED', 401, 'Sign in again to continue.');
        if (error instanceof DomainError && error.code === 'FORBIDDEN') throw denied();
        throw unavailable();
      }
      if (closed) throw setup();
      const verified = SupplierObserverIdentityObservationSchema.safeParse(observed);
      if (!verified.success || verified.data.observation.issuer !== configuration.issuer ||
          verified.data.observation.tokenHash !== createHash('sha256').update(token, 'utf8').digest('hex')) throw denied();
      const observation = immutable(verified.data), lane = lanes.find(candidate => candidate.externalOrganizationId === observation.identity.externalOrganizationId);
      if (!lane) throw denied();
      try { snapshotSupplierIdentityObserver(observation, lane.observer, new Date().toISOString()); } catch { throw denied(); }
      // Preliminary signed identity selects a lane only. The chosen service
      // independently repeats identity/factor verification before SQL effects.
      return lane.submit(token, request);
    },
  });
  return { gateway, close };
}

export default {
  async fetch(request: Request, bindings: SupplierWorkerBindings, context: WorkerContext): Promise<Response> {
    // Deployment qualification must also forbid public routes/previews.
    if (request.url !== supplierPrivateUrl || request.method !== 'POST') {
      return new Response(null, { status: 404, headers: { 'Cache-Control': 'private, no-store' } });
    }
    let config: ReturnType<typeof readSupplierWorkerConfig>;
    try { config = readSupplierWorkerConfig(bindings); } catch { return workerUnavailable(); }
    let running: ReturnType<typeof createSupplierWorkerRelationship> | undefined;
    try {
      return await handlePrivateSupplierRequest(request, config.issuer, () => {
        running ??= createSupplierWorkerRelationship(config); return running.gateway;
      });
    } catch { return workerUnavailable(); }
    finally { if (running) context.waitUntil(running.close()); }
  },
};
