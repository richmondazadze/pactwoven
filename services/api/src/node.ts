import { serve } from '@hono/node-server';
import { createRuntimePool, createProvisionerPool, createAccessPool, createMandatePool, PostgresMandateRepository, PostgresAccessRepository, PostgresAccessRecoveryRepository, PostgresFoundationRepository, PostgresOrganizationProvisioner } from '@pactwoven/db';
import { createClerkIdentityVerifier, createClerkStepUpVerifier, createClerkMandateStepUpVerifier, createClerkAccessRecoveryStepUpVerifier } from './auth.js';
import { createAccessGateway, createClerkMembershipDirectory } from './access-service.js';
import { createAccessRecoveryGateway } from './access-recovery-service.js';
import { createMandateGateway } from './mandate-service.js';
import { createDevelopmentCustodySetup } from './custody-setup-development.js';
import { createDevelopmentFinancialPolicy } from './financial-policy-development.js';
import { createDevelopmentSupplierRelationship } from './supplier-relationship-development.js';
import { createApp, type AppDependencies } from './app.js';
import { readDevelopmentConfig } from './config.js';
import { createNativeTaskPool, PostgresNativeTaskRepository } from '@pactwoven/db';

const environmentValues = { ...process.env };
const { allowedOrigins, environment, port, credentials } = readDevelopmentConfig(environmentValues);
const dependencies: AppDependencies = { allowedOrigins };
let pool: Awaited<ReturnType<typeof createRuntimePool>> | undefined;
let provisionerPool: Awaited<ReturnType<typeof createProvisionerPool>> | undefined;
let accessPool: Awaited<ReturnType<typeof createAccessPool>> | undefined;
let mandatePool: Awaited<ReturnType<typeof createMandatePool>> | undefined;
let custodySetup: Awaited<ReturnType<typeof createDevelopmentCustodySetup>> | undefined;
let financialPolicy: Awaited<ReturnType<typeof createDevelopmentFinancialPolicy>> | undefined;
let supplierRelationship: Awaited<ReturnType<typeof createDevelopmentSupplierRelationship>>;
let nativeTaskPool: Awaited<ReturnType<typeof createNativeTaskPool>> | undefined;
if (credentials) {
  try {
    pool = await createRuntimePool(credentials.databaseUrl);
    dependencies.repository = new PostgresFoundationRepository(pool, environment);
    if (credentials.nativeTaskDatabaseUrl) {
      nativeTaskPool = await createNativeTaskPool(credentials.nativeTaskDatabaseUrl, environment, 'api');
      dependencies.nativeTaskRepository = new PostgresNativeTaskRepository(nativeTaskPool, environment);
    }
    if (credentials.provisionerDatabaseUrl) {
      provisionerPool = await createProvisionerPool(credentials.provisionerDatabaseUrl);
      dependencies.provisioner = new PostgresOrganizationProvisioner(provisionerPool, environment);
    }
    dependencies.verifyIdentity = createClerkIdentityVerifier({ secretKey: credentials.secretKey,
      issuer: credentials.issuer, authorizedParties: allowedOrigins,
    });
    if (credentials.accessDatabaseUrl) {
      accessPool = await createAccessPool(credentials.accessDatabaseUrl);
      const identityConfig = { secretKey: credentials.secretKey, issuer: credentials.issuer, authorizedParties: allowedOrigins };
      dependencies.accessGateway = createAccessGateway({ repository: new PostgresAccessRepository(accessPool, environment),
        verifyIdentity: dependencies.verifyIdentity, verifyStepUp: createClerkStepUpVerifier(identityConfig), directory: createClerkMembershipDirectory(identityConfig) });
      dependencies.accessRecoveryGateway = createAccessRecoveryGateway({ environment,
        repository: new PostgresAccessRecoveryRepository(accessPool, environment), verifyIdentity: dependencies.verifyIdentity,
        verifyRecoveryStepUp: createClerkAccessRecoveryStepUpVerifier(identityConfig) });
    }
    if (credentials.mandateDatabaseUrl) {
      mandatePool = await createMandatePool(credentials.mandateDatabaseUrl);
      const identityConfig = { secretKey: credentials.secretKey, issuer: credentials.issuer, authorizedParties: allowedOrigins };
      dependencies.mandateGateway = createMandateGateway({ repository: new PostgresMandateRepository(mandatePool, environment),
        verifyIdentity: dependencies.verifyIdentity, verifyMandateStepUp: createClerkMandateStepUpVerifier(identityConfig),
        directory: createClerkMembershipDirectory(identityConfig) });
    }
    if (credentials.custodySetup) {
      custodySetup = await createDevelopmentCustodySetup({ ...credentials.custodySetup,
        identity: { secretKey: credentials.secretKey, issuer: credentials.issuer, authorizedParties: allowedOrigins } });
      dependencies.custodySetupGateway = custodySetup.gateway;
    }
    if (credentials.financialPolicy) {
      financialPolicy = await createDevelopmentFinancialPolicy({ ...credentials.financialPolicy,
        identity: { secretKey: credentials.secretKey, issuer: credentials.issuer, authorizedParties: allowedOrigins } });
      dependencies.financialPolicyGateway = financialPolicy.gateway;
      dependencies.financialPolicyWriteGateway = financialPolicy.writeGateway;
      dependencies.financialPolicyPreparationGateway = financialPolicy.preparationGateway;
      dependencies.financialPolicyClosureGateway = financialPolicy.closureGateway;
    }
    supplierRelationship = await createDevelopmentSupplierRelationship(environmentValues, {
      secretKey: credentials.secretKey, issuer: credentials.issuer, authorizedParties: allowedOrigins,
    });
    if (supplierRelationship) dependencies.supplierRelationshipGateway = supplierRelationship.gateway;
  } catch {
    await Promise.allSettled([pool?.end(), provisionerPool?.end(), accessPool?.end(), mandatePool?.end(), custodySetup?.close(), financialPolicy?.close(), supplierRelationship?.close(), nativeTaskPool?.end()]);
    throw new Error('Pactwoven API setup failed. Check the protected identity and runtime database configuration.');
  }
}
const app = createApp(dependencies);
const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () => {
  console.info(`Pactwoven development API listening on http://127.0.0.1:${port}`);
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  server.close(() => { void Promise.allSettled([pool?.end(), provisionerPool?.end(), accessPool?.end(), mandatePool?.end(), custodySetup?.close(), financialPolicy?.close(), supplierRelationship?.close(), nativeTaskPool?.end()]).then(() => process.exit(0)); });
});
