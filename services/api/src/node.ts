import { serve } from '@hono/node-server';
import { createRuntimePool, createProvisionerPool, createAccessPool, PostgresAccessRepository, PostgresFoundationRepository, PostgresOrganizationProvisioner } from '@pactwoven/db';
import { createClerkIdentityVerifier, createClerkStepUpVerifier } from './auth.js';
import { createAccessGateway, createClerkMembershipDirectory } from './access-service.js';
import { createApp, type AppDependencies } from './app.js';
import { readDevelopmentConfig } from './config.js';

const { allowedOrigins, environment, port, credentials } = readDevelopmentConfig(process.env);
const dependencies: AppDependencies = { allowedOrigins };
let pool: Awaited<ReturnType<typeof createRuntimePool>> | undefined;
let provisionerPool: Awaited<ReturnType<typeof createProvisionerPool>> | undefined;
let accessPool: Awaited<ReturnType<typeof createAccessPool>> | undefined;
if (credentials) {
  try {
    pool = await createRuntimePool(credentials.databaseUrl);
    dependencies.repository = new PostgresFoundationRepository(pool, environment);
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
    }
  } catch {
    await Promise.allSettled([pool?.end(), provisionerPool?.end(), accessPool?.end()]);
    throw new Error('Pactwoven API setup failed. Check the protected identity and runtime database configuration.');
  }
}
const app = createApp(dependencies);
const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () => {
  console.info(`Pactwoven development API listening on http://127.0.0.1:${port}`);
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  server.close(() => { void Promise.allSettled([pool?.end(), provisionerPool?.end(), accessPool?.end()]).then(() => process.exit(0)); });
});
