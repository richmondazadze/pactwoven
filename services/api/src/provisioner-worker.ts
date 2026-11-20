import { createProvisionerPool, PostgresOrganizationProvisioner, createAccessPool, PostgresAccessRepository, PostgresAccessRecoveryRepository, type AccessRecoveryRepository, type AccessRepository, type OrganizationProvisioner } from '@pactwoven/db';
import { createApp } from './app.js';
import { createClerkIdentityVerifier, createClerkStepUpVerifier, createClerkAccessRecoveryStepUpVerifier } from './auth.js';
import { createAccessGateway, createClerkMembershipDirectory } from './access-service.js';
import { createAccessRecoveryGateway } from './access-recovery-service.js';
import { accessRecoveryUrl, handlePrivateAccessRecoveryRequest } from './worker-access-recovery.js';
import { accessUrl, handlePrivateAccessRequest } from './worker-access.js';
import { readWorkerConfig, requestResource, workerUnavailable, type WorkerBindings, type WorkerContext, type PrivateWorkerConfig } from './worker-config.js';
import { provisionerUrl } from './worker-provisioner.js';
import { identityUrl, verifyPrivateIdentityRequest } from './worker-identity.js';
import { createWorkerPool } from './worker-database.js';

export default {
  async fetch(request: Request, bindings: WorkerBindings, context: WorkerContext): Promise<Response> {
    // Service-binding-only deployment is also enforced by deployment validation.
    // This narrow route does not trust an identity header from the public Worker.
    if (request.method !== 'POST' || ![provisionerUrl, identityUrl, accessUrl, accessRecoveryUrl].includes(request.url)) {
      return new Response(null, { status: 404, headers: { 'Cache-Control': 'private, no-store' } });
    }
    let config: PrivateWorkerConfig;
    try { config = readWorkerConfig(bindings, 'provisioner'); } catch { return workerUnavailable(); }
    const identityConfig = { secretKey: config.secretKey, issuer: config.issuer, authorizedParties: config.allowedOrigins };
    const verifyIdentity = createClerkIdentityVerifier(identityConfig);
    if (request.url === identityUrl) return verifyPrivateIdentityRequest(request, config.issuer, verifyIdentity);
    if (request.url === accessRecoveryUrl) {
      const pool = requestResource(() => createWorkerPool(() => createAccessPool(config.accessConnectionString), config.expectedAccessDatabaseUser));
      const repository = async () => new PostgresAccessRecoveryRepository(await pool.get(), config.environment);
      const lazyRepository: AccessRecoveryRepository = {
        get: async (...args) => (await repository()).get(...args),
        close: async (...args) => (await repository()).close(...args),
      };
      try {
        return await handlePrivateAccessRecoveryRequest(request, config.issuer, requestNonce => createAccessRecoveryGateway({
          environment: config.environment, repository: lazyRepository, verifyIdentity, requestNonce,
          verifyRecoveryStepUp: createClerkAccessRecoveryStepUpVerifier(identityConfig),
        }));
      } finally { context.waitUntil(pool.close()); }
    }
    if (request.url === accessUrl) {
      const pool = requestResource(() => createWorkerPool(() => createAccessPool(config.accessConnectionString), config.expectedAccessDatabaseUser));
      const repository = async () => new PostgresAccessRepository(await pool.get(), config.environment);
      const lazyRepository: AccessRepository = {
        listMembers: async (...args) => (await repository()).listMembers(...args),
        getMember: async (...args) => (await repository()).getMember(...args),
        getOperation: async (...args) => (await repository()).getOperation(...args),
        changeAccess: async (...args) => (await repository()).changeAccess(...args),
      };
      const gateway = createAccessGateway({ repository: lazyRepository, verifyIdentity,
        verifyStepUp: createClerkStepUpVerifier(identityConfig), directory: createClerkMembershipDirectory(identityConfig) });
      try { return await handlePrivateAccessRequest(request, config.issuer, gateway); }
      finally { context.waitUntil(pool.close()); }
    }
    const pool = requestResource(() => createWorkerPool(() => createProvisionerPool(config.connectionString), config.expectedDatabaseUser));
    const provisioner: OrganizationProvisioner = {
      bootstrapOrganization: async (...args) => new PostgresOrganizationProvisioner(await pool.get(), config.environment).bootstrapOrganization(...args),
    };
    const app = createApp({ allowedOrigins: config.allowedOrigins, provisioner,
      verifyIdentity,
    });
    try { return await app.fetch(request); }
    finally { context.waitUntil(pool.close()); }
  },
};
