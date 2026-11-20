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
  EXPECTED_ACCESS_DATABASE_USER?: string;
  DATABASE?: HyperdriveBinding;
  ACCESS_DATABASE?: HyperdriveBinding;
  IDENTITY_PROVISIONER?: ServiceBinding;
  DATABASE_URL?: unknown;
  PROVISIONER_DATABASE_URL?: unknown;
  ACCESS_DATABASE_URL?: unknown;
  MANDATE_DATABASE_URL?: unknown;
  MANDATE_DATABASE?: HyperdriveBinding;
  EXPECTED_MANDATE_DATABASE_USER?: string;
  MANDATE_AUTHORITY?: ServiceBinding;
  FINANCIAL_AUTHORITY?: ServiceBinding;
  SUPPLIER_AUTHORITY?: ServiceBinding;
};

export class WorkerConfigurationError extends Error {
  constructor() { super('Development Worker bindings are not configured correctly.'); }
}
export type WorkerRuntimeConfig = { environment: 'development'; allowedOrigins: string[]; issuer: string; connectionString: string; expectedDatabaseUser: string };
export type PrivateWorkerConfig = WorkerRuntimeConfig & { secretKey: string; accessConnectionString: string; expectedAccessDatabaseUser: string };

/** Workflow database capabilities belong only to their private service entrypoints. */
export function hasPrivateWorkflowConfiguration(bindings: object): boolean {
  return Object.entries(bindings).some(([name, value]) => value !== undefined &&
    /^(?:EXPECTED_)?(?:FINANCIAL_|CUSTODY_|SUPPLIER_)/.test(name) &&
    name !== 'FINANCIAL_AUTHORITY' && name !== 'SUPPLIER_AUTHORITY');
}

export function readDatabaseBinding(database: HyperdriveBinding | undefined): string {
  if (!database || !database.database || !database.user ||
      typeof database.host !== 'string' || database.host.length === 0 ||
      !Number.isInteger(database.port) || database.port < 1 || database.port > 65535) throw new WorkerConfigurationError();
  const url = new URL(database.connectionString);
  // The native binding supplies opaque proxy host/credentials, not the origin.
  // Its hostname spelling is not a stable provider API or an origin TLS check.
  // Deployment validation checks origin TLS and mapping; createWorkerPool checks
  // the actual PostgreSQL identity before a repository can use the connection.
  const query = [...url.searchParams];
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hash ||
      (query.length > 0 && !(query.length === 1 && query[0]?.[0] === 'sslmode' && query[0][1] === 'disable')) ||
      decodeURIComponent(url.pathname.slice(1)) !== database.database || !url.password || decodeURIComponent(url.username) !== database.user ||
      !url.hostname || url.hostname !== database.host || Number(url.port || 5432) !== database.port) throw new WorkerConfigurationError();
  return database.connectionString;
}

/** This entrypoint is deliberately development-only. Hyperdrive owns TLS to Neon. */
export function readWorkerConfig(bindings: WorkerBindings, role: 'api'): WorkerRuntimeConfig;
export function readWorkerConfig(bindings: WorkerBindings, role: 'provisioner'): PrivateWorkerConfig;
export function readWorkerConfig(bindings: WorkerBindings, role: 'api' | 'provisioner'): WorkerRuntimeConfig | PrivateWorkerConfig {
  try {
    if (bindings.APP_ENVIRONMENT !== 'development' || bindings.WORKER_ROLE !== role ||
        hasPrivateWorkflowConfiguration(bindings) ||
        bindings.DATABASE_URL !== undefined || bindings.PROVISIONER_DATABASE_URL !== undefined || bindings.ACCESS_DATABASE_URL !== undefined ||
        bindings.MANDATE_DATABASE_URL !== undefined || bindings.MANDATE_DATABASE !== undefined || bindings.EXPECTED_MANDATE_DATABASE_USER !== undefined) throw new WorkerConfigurationError();
    const allowedOrigins = z.string().min(1).parse(bindings.ALLOWED_ORIGINS).split(',');
    for (const origin of allowedOrigins) {
      const url = new URL(origin);
      if (url.origin !== origin || url.username || url.password ||
          (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
        throw new WorkerConfigurationError();
      }
    }
    if (new Set(allowedOrigins).size !== allowedOrigins.length) throw new WorkerConfigurationError();
    if (role === 'api' && (bindings.CLERK_SECRET_KEY !== undefined || bindings.ACCESS_DATABASE !== undefined ||
        bindings.EXPECTED_ACCESS_DATABASE_USER !== undefined)) throw new WorkerConfigurationError();
    const secretKey = role === 'provisioner' ? z.string().regex(/^sk_test_[A-Za-z0-9_-]+$/).parse(bindings.CLERK_SECRET_KEY) : undefined;
    const publishableKey = z.string().regex(/^pk_test_[A-Za-z0-9_-]+$/).parse(bindings.CLERK_PUBLISHABLE_KEY);
    const issuer = z.string().url().parse(bindings.CLERK_ISSUER);
    const issuerUrl = new URL(issuer);
    if (issuerUrl.origin !== issuer || issuerUrl.protocol !== 'https:' || !issuerUrl.hostname.endsWith('.clerk.accounts.dev') ||
        atob(publishableKey.slice(8)) !== `${issuerUrl.hostname}$`) throw new WorkerConfigurationError();
    const expectedUser = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/).parse(bindings.EXPECTED_DATABASE_USER);
    const connectionString = readDatabaseBinding(bindings.DATABASE);
    let accessConnectionString: string | undefined;
    let accessUser: string | undefined;
    if (role === 'provisioner') {
      accessUser = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/).parse(bindings.EXPECTED_ACCESS_DATABASE_USER);
      if (accessUser === expectedUser) throw new WorkerConfigurationError();
      accessConnectionString = readDatabaseBinding(bindings.ACCESS_DATABASE);
      if (accessConnectionString === connectionString) throw new WorkerConfigurationError();
    }
    if (role === 'api' && typeof bindings.IDENTITY_PROVISIONER?.fetch !== 'function') throw new WorkerConfigurationError();
    for (const binding of [bindings.MANDATE_AUTHORITY, bindings.FINANCIAL_AUTHORITY, bindings.SUPPLIER_AUTHORITY]) {
      if (role === 'api' && binding !== undefined && typeof binding.fetch !== 'function') throw new WorkerConfigurationError();
      if (role === 'provisioner' && binding !== undefined) throw new WorkerConfigurationError();
    }
    if (role === 'provisioner' && bindings.IDENTITY_PROVISIONER !== undefined) throw new WorkerConfigurationError();
    return { environment: 'development' as const, allowedOrigins, issuer, connectionString, expectedDatabaseUser: expectedUser,
      ...(secretKey && accessConnectionString && accessUser ? { secretKey, accessConnectionString, expectedAccessDatabaseUser: accessUser } : {}) };
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
