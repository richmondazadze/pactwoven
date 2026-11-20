import { z } from 'zod';
import { readDatabaseBinding, WorkerConfigurationError, type HyperdriveBinding } from './worker-config.js';

export type FinancialWorkerBindings = {
  APP_ENVIRONMENT?: string;
  WORKER_ROLE?: string;
  ALLOWED_ORIGINS?: string;
  CLERK_SECRET_KEY?: string;
  CLERK_PUBLISHABLE_KEY?: string;
  CLERK_ISSUER?: string;
  FINANCIAL_POLICY_AUTHORIZER_DATABASE?: HyperdriveBinding;
  FINANCIAL_POLICY_VERIFIER_DATABASE?: HyperdriveBinding;
  CUSTODY_SETUP_WRITER_DATABASE?: HyperdriveBinding;
  CUSTODY_SETUP_VERIFIER_DATABASE?: HyperdriveBinding;
  EXPECTED_FINANCIAL_POLICY_AUTHORIZER_DATABASE_USER?: string;
  EXPECTED_FINANCIAL_POLICY_VERIFIER_DATABASE_USER?: string;
  EXPECTED_CUSTODY_SETUP_WRITER_DATABASE_USER?: string;
  EXPECTED_CUSTODY_SETUP_VERIFIER_DATABASE_USER?: string;
};
const databaseNames = ['FINANCIAL_POLICY_AUTHORIZER_DATABASE', 'FINANCIAL_POLICY_VERIFIER_DATABASE',
  'CUSTODY_SETUP_WRITER_DATABASE', 'CUSTODY_SETUP_VERIFIER_DATABASE'] as const;
const fields = new Set<string>(['APP_ENVIRONMENT', 'WORKER_ROLE', 'ALLOWED_ORIGINS', 'CLERK_SECRET_KEY',
  'CLERK_PUBLISHABLE_KEY', 'CLERK_ISSUER', ...databaseNames, ...databaseNames.map(name => `EXPECTED_${name}_USER`)]);

/** Four independent capabilities; transport names never establish origin authority. */
export function readFinancialWorkerConfig(bindings: FinancialWorkerBindings) {
  try {
    if (bindings.APP_ENVIRONMENT !== 'development' || bindings.WORKER_ROLE !== 'financial' ||
        Object.entries(bindings).some(([name, value]) => value !== undefined && !fields.has(name))) throw new WorkerConfigurationError();
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
    const databases = databaseNames.map(name => ({ connectionString: readDatabaseBinding(bindings[name]),
      expectedUser: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/).parse(bindings[`EXPECTED_${name}_USER`]) }));
    // Reject equivalent proxy URLs as well as aliases for one expected origin login.
    if (new Set(databases.map(db => new URL(db.connectionString).href)).size !== 4 ||
        new Set(databases.map(db => db.expectedUser)).size !== 4) throw new WorkerConfigurationError();
    return { environment: 'development' as const, allowedOrigins, issuer, secretKey,
      financialAuthorizer: databases[0]!, financialVerifier: databases[1]!,
      custodyWriter: databases[2]!, custodyVerifier: databases[3]! };
  } catch { throw new WorkerConfigurationError(); }
}
