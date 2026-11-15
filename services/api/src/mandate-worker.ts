import { createMandatePool, PostgresMandateRepository, type MandateRepository } from '@pactwoven/db';
import { createClerkIdentityVerifier, createClerkMandateStepUpVerifier } from './auth.js';
import { createClerkMembershipDirectory } from './access-service.js';
import { createMandateGateway } from './mandate-service.js';
import { readMandateWorkerConfig } from './mandate-worker-config.js';
import { handlePrivateMandateRequest, mandateUrl } from './worker-mandate.js';
import { requestResource, workerUnavailable, type WorkerBindings, type WorkerContext } from './worker-config.js';

export default {
  async fetch(request: Request, bindings: WorkerBindings, context: WorkerContext): Promise<Response> {
    // Deployment validation also excludes public routes, previews and workers.dev.
    if (request.method !== 'POST' || request.url !== mandateUrl) {
      return new Response(null, { status: 404, headers: { 'Cache-Control': 'private, no-store' } });
    }
    let config: ReturnType<typeof readMandateWorkerConfig>;
    try { config = readMandateWorkerConfig(bindings); } catch { return workerUnavailable(); }
    const identityConfig = { secretKey: config.secretKey, issuer: config.issuer, authorizedParties: config.allowedOrigins };
    const pool = requestResource(() => createMandatePool(config.connectionString));
    const repository = async () => new PostgresMandateRepository(await pool.get(), config.environment);
    const lazyRepository: MandateRepository = {
      readDocument: async (...args) => (await repository()).readDocument(...args),
      list: async (...args) => (await repository()).list(...args),
      review: async (...args) => (await repository()).review(...args),
      operation: async (...args) => (await repository()).operation(...args),
      requester: async (...args) => (await repository()).requester(...args),
      mutate: async (...args) => (await repository()).mutate(...args),
    };
    try {
      return await handlePrivateMandateRequest(request, config.issuer, requestNonce => createMandateGateway({
        repository: lazyRepository, verifyIdentity: createClerkIdentityVerifier(identityConfig),
        verifyMandateStepUp: createClerkMandateStepUpVerifier(identityConfig),
        directory: createClerkMembershipDirectory(identityConfig), requestNonce,
      }));
    } finally { context.waitUntil(pool.close()); }
  },
};
