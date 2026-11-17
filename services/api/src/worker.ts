import { createRuntimePool, PostgresFoundationRepository, type FoundationRepository } from '@pactwoven/db';
import { createApp } from './app.js';
import { readWorkerConfig, requestResource, workerUnavailable, type WorkerBindings, type WorkerContext, type WorkerRuntimeConfig } from './worker-config.js';
import { serviceProvisioner } from './worker-provisioner.js';
import { serviceIdentityVerifier } from './worker-identity.js';
import { serviceAccessGateway } from './worker-access.js';
import { serviceAccessRecoveryGateway } from './worker-access-recovery.js';
import { serviceMandateGateway } from './worker-mandate.js';
import { serviceFinancialGateways } from './worker-financial.js';
import { serviceSupplierRelationshipGateway } from './worker-supplier.js';
import { createWorkerPool } from './worker-database.js';

export default {
  async fetch(request: Request, bindings: WorkerBindings, context: WorkerContext): Promise<Response> {
    let config: WorkerRuntimeConfig;
    try { config = readWorkerConfig(bindings, 'api'); } catch { return workerUnavailable(); }
    const pool = requestResource(() => createWorkerPool(() => createRuntimePool(config.connectionString), config.expectedDatabaseUser));
    const repository = async () => new PostgresFoundationRepository(await pool.get(), config.environment);
    const lazyRepository: FoundationRepository = {
      getSession: async (...args) => (await repository()).getSession(...args),
      listResponsibilities: async (...args) => (await repository()).listResponsibilities(...args),
      getResponsibility: async (...args) => (await repository()).getResponsibility(...args),
      createResponsibility: async (...args) => (await repository()).createResponsibility(...args),
    };
    const financial = bindings.FINANCIAL_AUTHORITY
      ? serviceFinancialGateways(bindings.FINANCIAL_AUTHORITY, request, config.issuer) : undefined;
    const app = createApp({ allowedOrigins: config.allowedOrigins, repository: lazyRepository,
      verifyIdentity: serviceIdentityVerifier(bindings.IDENTITY_PROVISIONER!, request.headers.get('Authorization') ?? '', config.issuer),
      provisioner: serviceProvisioner(bindings.IDENTITY_PROVISIONER!, request.headers.get('Authorization') ?? ''),
      accessGateway: serviceAccessGateway(bindings.IDENTITY_PROVISIONER!, request, config.issuer),
      accessRecoveryGateway: serviceAccessRecoveryGateway(bindings.IDENTITY_PROVISIONER!, request, config.issuer),
      ...(bindings.MANDATE_AUTHORITY ? { mandateGateway: serviceMandateGateway(bindings.MANDATE_AUTHORITY, request, config.issuer) } : {}),
      ...(financial ? {
        financialPolicyGateway: financial.financialPolicy,
        financialPolicyWriteGateway: financial.financialPolicyWrite,
        financialPolicyPreparationGateway: financial.financialPolicyPreparation,
        financialPolicyClosureGateway: financial.financialPolicyClosure,
        custodySetupGateway: financial.custodySetup,
      } : {}),
      ...(bindings.SUPPLIER_AUTHORITY ? {
        supplierRelationshipGateway: serviceSupplierRelationshipGateway(bindings.SUPPLIER_AUTHORITY, request, config.issuer),
      } : {}),
    });
    try { return await app.fetch(request); }
    finally { context.waitUntil(pool.close()); }
  },
};
