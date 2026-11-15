import { createProvisionerPool, PostgresOrganizationProvisioner, type OrganizationProvisioner } from '@pactwoven/db';
import { createApp } from './app.js';
import { createClerkIdentityVerifier } from './auth.js';
import { readWorkerConfig, requestResource, workerUnavailable, type WorkerBindings, type WorkerContext, type PrivateWorkerConfig } from './worker-config.js';
import { provisionerUrl } from './worker-provisioner.js';
import { identityUrl, verifyPrivateIdentityRequest } from './worker-identity.js';

export default {
  async fetch(request: Request, bindings: WorkerBindings, context: WorkerContext): Promise<Response> {
    // Service-binding-only deployment is also enforced by deployment validation.
    // This narrow route does not trust an identity header from the public Worker.
    if (request.method !== 'POST' || ![provisionerUrl, identityUrl].includes(request.url)) {
      return new Response(null, { status: 404, headers: { 'Cache-Control': 'private, no-store' } });
    }
    let config: PrivateWorkerConfig;
    try { config = readWorkerConfig(bindings, 'provisioner'); } catch { return workerUnavailable(); }
    const verifyIdentity = createClerkIdentityVerifier({ secretKey: config.secretKey, issuer: config.issuer, authorizedParties: config.allowedOrigins });
    if (request.url === identityUrl) return verifyPrivateIdentityRequest(request, config.issuer, verifyIdentity);
    const pool = requestResource(() => createProvisionerPool(config.connectionString));
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
