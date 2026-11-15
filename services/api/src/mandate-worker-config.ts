import { z } from 'zod';
import { readDatabaseBinding, WorkerConfigurationError, type WorkerBindings } from './worker-config.js';

export function readMandateWorkerConfig(bindings: WorkerBindings) {
  try {
    if (bindings.APP_ENVIRONMENT !== 'development' || bindings.WORKER_ROLE !== 'mandate' ||
        bindings.DATABASE !== undefined || bindings.ACCESS_DATABASE !== undefined || bindings.IDENTITY_PROVISIONER !== undefined ||
        bindings.MANDATE_AUTHORITY !== undefined || bindings.EXPECTED_DATABASE_USER !== undefined || bindings.EXPECTED_ACCESS_DATABASE_USER !== undefined ||
        bindings.DATABASE_URL !== undefined || bindings.PROVISIONER_DATABASE_URL !== undefined || bindings.ACCESS_DATABASE_URL !== undefined || bindings.MANDATE_DATABASE_URL !== undefined) throw new WorkerConfigurationError();
    const allowedOrigins = z.string().min(1).parse(bindings.ALLOWED_ORIGINS).split(',');
    for (const origin of allowedOrigins) {
      const url = new URL(origin);
      if (url.origin !== origin || url.username || url.password || (url.protocol !== 'https:' &&
          !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new WorkerConfigurationError();
    }
    if (new Set(allowedOrigins).size !== allowedOrigins.length) throw new WorkerConfigurationError();
    const secretKey = z.string().regex(/^sk_test_[A-Za-z0-9_-]+$/).parse(bindings.CLERK_SECRET_KEY);
    const publishableKey = z.string().regex(/^pk_test_[A-Za-z0-9_-]+$/).parse(bindings.CLERK_PUBLISHABLE_KEY);
    const issuer = z.string().url().parse(bindings.CLERK_ISSUER), issuerUrl = new URL(issuer);
    if (issuerUrl.origin !== issuer || issuerUrl.protocol !== 'https:' || !issuerUrl.hostname.endsWith('.clerk.accounts.dev') ||
        atob(publishableKey.slice(8)) !== `${issuerUrl.hostname}$`) throw new WorkerConfigurationError();
    const expectedUser = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/).parse(bindings.EXPECTED_MANDATE_DATABASE_USER);
    return { environment: 'development' as const, allowedOrigins, issuer, secretKey, expectedDatabaseUser: expectedUser,
      connectionString: readDatabaseBinding(bindings.MANDATE_DATABASE) };
  } catch { throw new WorkerConfigurationError(); }
}
