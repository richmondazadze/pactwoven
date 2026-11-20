import { createFinancialAuthorityPool, PostgresFinancialPolicyRepository, PostgresFinancialAuthenticationRepository,
  PostgresFinancialPolicyReaders, PostgresFinancialPolicyPreparationReader, PostgresFinancialPolicyClosureRepository,
  createCustodySetupPool, PostgresCustodySetupRepository, PostgresCustodySetupAuthenticationRepository,
  PostgresCustodySetupReaders } from '@pactwoven/db';
import { createClerkFinancialPolicyVerifier } from './financial-policy-verifier.js';
import { createFinancialPolicyGateway } from './financial-policy-service.js';
import { createFinancialPolicyWriteGateway } from './financial-policy-write-service.js';
import { createFinancialPolicyPreparationGateway } from './financial-policy-preparation-service.js';
import { createFinancialPolicyClosureGateway } from './financial-policy-closure-service.js';
import { createClerkCustodySetupVerifier } from './custody-setup-verifier.js';
import { createCustodySetupService } from './custody-setup-service.js';
import { readFinancialWorkerConfig, type FinancialWorkerBindings } from './financial-worker-config.js';
import { financialUrl, handlePrivateFinancialRequest, type FinancialGateways } from './worker-financial.js';
import { requestResource, workerUnavailable, type WorkerContext } from './worker-config.js';
import { createWorkerPool } from './worker-database.js';

export default {
  async fetch(request: Request, bindings: FinancialWorkerBindings, context: WorkerContext): Promise<Response> {
    if (request.method !== 'POST' || request.url !== financialUrl) {
      return new Response(null, { status: 404, headers: { 'Cache-Control': 'private, no-store' } });
    }
    let config: ReturnType<typeof readFinancialWorkerConfig>;
    try { config = readFinancialWorkerConfig(bindings); } catch { return workerUnavailable(); }
    const identity = { secretKey: config.secretKey, issuer: config.issuer, authorizedParties: [...config.allowedOrigins] };
    // The existing factories cap each pool at three connections and verify every checkout.
    // Each operation creates only its family's pair; neither pair is shared across requests.
    const financialAuthorizer = requestResource(() => createWorkerPool(() => createFinancialAuthorityPool(config.financialAuthorizer.connectionString, 'authorizer'), config.financialAuthorizer.expectedUser));
    const financialVerifier = requestResource(() => createWorkerPool(() => createFinancialAuthorityPool(config.financialVerifier.connectionString, 'verifier'), config.financialVerifier.expectedUser));
    const custodyWriter = requestResource(() => createWorkerPool(() => createCustodySetupPool(config.custodyWriter.connectionString, 'writer'), config.custodyWriter.expectedUser));
    const custodyVerifier = requestResource(() => createWorkerPool(() => createCustodySetupPool(config.custodyVerifier.connectionString, 'verifier'), config.custodyVerifier.expectedUser));
    // Gateway construction is cheap and synchronous. Lazy repository methods let independent
    // token verification happen before database creation, including revoked-session failures.
    const financialReaders = async () => new PostgresFinancialPolicyReaders(await financialAuthorizer.get(), await financialVerifier.get());
    const financialRepository = async () => new PostgresFinancialPolicyRepository(await financialAuthorizer.get());
    const custodyReaders = async () => new PostgresCustodySetupReaders(await custodyWriter.get(), await custodyVerifier.get());
    const custodyRepository = async () => new PostgresCustodySetupRepository(await custodyWriter.get());
    try {
      return await handlePrivateFinancialRequest(request, config.issuer, () => {
        const dependencies = {
          environment: config.environment, issuer: config.issuer, verifier: createClerkFinancialPolicyVerifier(identity, config.environment),
          readers: {
            resolveObserver: async (...args: Parameters<PostgresFinancialPolicyReaders['resolveObserver']>) => (await financialReaders()).resolveObserver(...args),
            context: async (...args: Parameters<PostgresFinancialPolicyReaders['context']>) => (await financialReaders()).context(...args),
            governance: async (...args: Parameters<PostgresFinancialPolicyReaders['governance']>) => (await financialReaders()).governance(...args),
            original: async (...args: Parameters<PostgresFinancialPolicyReaders['original']>) => (await financialReaders()).original(...args),
          },
          repository: {
            readFinancialPolicy: async (...args: Parameters<PostgresFinancialPolicyRepository['readFinancialPolicy']>) => (await financialRepository()).readFinancialPolicy(...args),
            listFinancialPolicyDrafts: async (...args: Parameters<PostgresFinancialPolicyRepository['listFinancialPolicyDrafts']>) => (await financialRepository()).listFinancialPolicyDrafts(...args),
            mutate: async (...args: Parameters<PostgresFinancialPolicyRepository['mutate']>) => (await financialRepository()).mutate(...args),
          },
          authentication: { append: async (...args: Parameters<PostgresFinancialAuthenticationRepository['append']>) =>
            new PostgresFinancialAuthenticationRepository(await financialVerifier.get()).append(...args) },
        };
        return {
          financialPolicy: createFinancialPolicyGateway(dependencies),
          financialPolicyWrite: createFinancialPolicyWriteGateway(dependencies),
          financialPolicyClosure: createFinancialPolicyClosureGateway({ ...dependencies, closures: {
            status: async (...args: Parameters<PostgresFinancialPolicyClosureRepository['status']>) =>
              new PostgresFinancialPolicyClosureRepository(await financialAuthorizer.get()).status(...args),
            close: async (...args: Parameters<PostgresFinancialPolicyClosureRepository['close']>) =>
              new PostgresFinancialPolicyClosureRepository(await financialAuthorizer.get()).close(...args),
          } }),
          financialPolicyPreparation: createFinancialPolicyPreparationGateway({ ...dependencies,
            preparationReader: { prepare: async (...args: Parameters<PostgresFinancialPolicyPreparationReader['prepare']>) =>
              new PostgresFinancialPolicyPreparationReader(await financialAuthorizer.get()).prepare(...args) } }),
          custodySetup: createCustodySetupService({ verifier: createClerkCustodySetupVerifier(identity),
            readers: {
              resolveOwner: async (...args: Parameters<PostgresCustodySetupReaders['resolveOwner']>) => (await custodyReaders()).resolveOwner(...args),
              specification: async (...args: Parameters<PostgresCustodySetupReaders['specification']>) => (await custodyReaders()).specification(...args),
              record: async (...args: Parameters<PostgresCustodySetupReaders['record']>) => (await custodyReaders()).record(...args),
              original: async (...args: Parameters<PostgresCustodySetupReaders['original']>) => (await custodyReaders()).original(...args),
            },
            repository: {
              get: async (...args: Parameters<PostgresCustodySetupRepository['get']>) => (await custodyRepository()).get(...args),
              recover: async (...args: Parameters<PostgresCustodySetupRepository['recover']>) => (await custodyRepository()).recover(...args),
              mutate: async (...args: Parameters<PostgresCustodySetupRepository['mutate']>) => (await custodyRepository()).mutate(...args),
            },
            authentication: { append: async (...args: Parameters<PostgresCustodySetupAuthenticationRepository['append']>) =>
              new PostgresCustodySetupAuthenticationRepository(await custodyVerifier.get()).append(...args) },
          }),
        } satisfies FinancialGateways;
      });
    } finally {
      context.waitUntil(Promise.allSettled([financialAuthorizer.close(), financialVerifier.close(), custodyWriter.close(), custodyVerifier.close()]));
    }
  },
};
