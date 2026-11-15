import { z } from 'zod';

export type HyperdriveBinding = {
  readonly connectionString: string;
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly database: string;
};
export type ServiceBinding = { fetch(request: Request): Promise<Response> };
export type WorkerContext = { waitUntil(promise: Promise<unknown>): void };
export type WorkerBindings = {
  APP_ENVIRONMENT?: string;
  WORKER_ROLE?: string;
  ALLOWED_ORIGINS?: string;
  CLERK_SECRET_KEY?: string;
  CLERK_PUBLISHABLE_KEY?: string;
  CLERK_ISSUER?: string;
  EXPECTED_DATABASE_USER?: string;
  DATABASE?: HyperdriveBinding;
  IDENTITY_PROVISIONER?: ServiceBinding;
  DATABASE_URL?: unknown;
  PROVISIONER_DATABASE_URL?: unknown;
};

export class WorkerConfigurationError extends Error {
  constructor() { super('Development Worker bindings are not configured correctly.'); }
}
export type WorkerRuntimeConfig = { environment: 'development'; allowedOrigins: string[]; issuer: string; connectionString: string };
export type PrivateWorkerConfig = WorkerRuntimeConfig & { secretKey: string };

/** This entrypoint is deliberately development-only. Hyperdrive owns TLS to Neon. */
export function readWorkerConfig(bindings: WorkerBindings, role: 'api'): WorkerRuntimeConfig;
export function readWorkerConfig(bindings: WorkerBindings, role: 'provisioner'): PrivateWorkerConfig;
export function readWorkerConfig(bindings: WorkerBindings, role: 'api' | 'provisioner'): WorkerRuntimeConfig | PrivateWorkerConfig {
  try {
    if (bindings.APP_ENVIRONMENT !== 'development' || bindings.WORKER_ROLE !== role ||
        bindings.DATABASE_URL !== undefined || bindings.PROVISIONER_DATABASE_URL !== undefined) throw new WorkerConfigurationError();
    const allowedOrigins = z.string().min(1).parse(bindings.ALLOWED_ORIGINS).split(',');
    for (const origin of allowedOrigins) {
      const url = new URL(origin);
      if (url.origin !== origin || url.username || url.password ||
          (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
        throw new WorkerConfigurationError();
      }
    }
    if (new Set(allowedOrigins).size !== allowedOrigins.length) throw new WorkerConfigurationError();
    if (role === 'api' && bindings.CLERK_SECRET_KEY !== undefined) throw new WorkerConfigurationError();
    const secretKey = role === 'provisioner' ? z.string().regex(/^sk_test_[A-Za-z0-9_-]+$/).parse(bindings.CLERK_SECRET_KEY) : undefined;
    const publishableKey = z.string().regex(/^pk_test_[A-Za-z0-9_-]+$/).parse(bindings.CLERK_PUBLISHABLE_KEY);
    const issuer = z.string().url().parse(bindings.CLERK_ISSUER);
    const issuerUrl = new URL(issuer);
    if (issuerUrl.origin !== issuer || issuerUrl.protocol !== 'https:' || !issuerUrl.hostname.endsWith('.clerk.accounts.dev') ||
        atob(publishableKey.slice(8)) !== `${issuerUrl.hostname}$`) throw new WorkerConfigurationError();
    const expectedUser = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/).parse(bindings.EXPECTED_DATABASE_USER);
    const database = bindings.DATABASE;
    if (!database || database.database !== 'pactwoven_dev' || database.user !== expectedUser) throw new WorkerConfigurationError();
    const url = new URL(database.connectionString);
    // Hyperdrive uses sslmode=disable for its Worker-local synthetic proxy.
    // Origin certificate verification is required by the deployment validator.
    // Never accept a separately supplied DSN or additional driver overrides.
    const query = [...url.searchParams];
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hash ||
        (query.length > 0 && !(query.length === 1 && query[0]?.[0] === 'sslmode' && query[0][1] === 'disable')) ||
        url.pathname !== '/pactwoven_dev' || !url.password || decodeURIComponent(url.username) !== expectedUser ||
        url.hostname !== database.host || Number(url.port || 5432) !== database.port) throw new WorkerConfigurationError();
    if (role === 'api' && typeof bindings.IDENTITY_PROVISIONER?.fetch !== 'function') throw new WorkerConfigurationError();
    if (role === 'provisioner' && bindings.IDENTITY_PROVISIONER !== undefined) throw new WorkerConfigurationError();
    return { environment: 'development' as const, allowedOrigins, issuer, connectionString: database.connectionString,
      ...(secretKey ? { secretKey } : {}) };
  } catch { throw new WorkerConfigurationError(); }
}

export function workerUnavailable(): Response {
  const correlationId = crypto.randomUUID();
  return Response.json({ error: { code: 'SETUP_REQUIRED', message: 'Development service configuration is unavailable.', correlationId } },
    { status: 503, headers: { 'Cache-Control': 'private, no-store', 'X-Correlation-Id': correlationId,
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' } });
}

/** A request owns its resources; no pg connection crosses Worker invocations. */
export function requestResource<T extends { end(): Promise<void> }>(create: () => Promise<T>) {
  let pending: Promise<T> | undefined;
  return {
    get(): Promise<T> { return pending ??= create(); },
    async close(): Promise<void> {
      if (!pending) return;
      // Pool factories close failed initialization. No raw driver error escapes.
      try { await (await pending).end(); } catch { /* Request already has its authoritative outcome. */ }
    },
  };
}
