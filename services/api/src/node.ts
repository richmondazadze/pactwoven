import { serve } from '@hono/node-server';
import { createRuntimePool, createProvisionerPool, PostgresFoundationRepository, PostgresOrganizationProvisioner } from '@pactwoven/db';
import { createClerkIdentityVerifier } from './auth.js';
import { createApp, type AppDependencies } from './app.js';
import { readDevelopmentConfig } from './config.js';

const { allowedOrigins, environment, port, credentials } = readDevelopmentConfig(process.env);
const dependencies: AppDependencies = { allowedOrigins };
let pool: Awaited<ReturnType<typeof createRuntimePool>> | undefined;
let provisionerPool: Awaited<ReturnType<typeof createProvisionerPool>> | undefined;
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
  } catch {
    await Promise.allSettled([pool?.end(), provisionerPool?.end()]);
    throw new Error('Pactwoven API setup failed. Check the protected identity and runtime database configuration.');
  }
}
const app = createApp(dependencies);
const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () => {
  console.info(`Pactwoven development API listening on http://127.0.0.1:${port}`);
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  server.close(() => { void Promise.allSettled([pool?.end(), provisionerPool?.end()]).then(() => process.exit(0)); });
});
