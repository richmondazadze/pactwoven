import { z } from 'zod';

type EnvironmentValues = Record<string, string | undefined>;
const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);

export class ConfigurationError extends Error {
  constructor() { super('Invalid development API configuration. Check the protected environment bindings.'); }
}

function exactOrigin(value: string): string {
  const url = new URL(value);
  if (url.origin !== value || url.username || url.password ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopbackHosts.has(url.hostname)))) {
    throw new ConfigurationError();
  }
  return value;
}

function developmentDatabase(value: string): URL {
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.pathname !== '/pactwoven_dev' ||
      !url.username || !url.password || url.hash) throw new ConfigurationError();
  const seen = new Set<string>();
  for (const [key, value] of url.searchParams) {
    if (seen.has(key) || !['sslmode', 'channel_binding'].includes(key) ||
        (key === 'sslmode' && value !== 'verify-full') ||
        (key === 'channel_binding' && value !== 'require')) throw new ConfigurationError();
    seen.add(key);
  }
  if (!loopbackHosts.has(url.hostname) &&
      (!url.hostname.endsWith('.neon.tech') || url.searchParams.get('sslmode') !== 'verify-full')) {
    throw new ConfigurationError();
  }
  return url;
}

/** This development entrypoint cannot be promoted by changing an environment flag. */
export function readDevelopmentConfig(values: EnvironmentValues) {
  try {
    const environment = z.literal('development').parse(values.APP_ENVIRONMENT ?? 'development');
    const port = z.coerce.number().int().min(1024).max(65535).parse(values.PORT ?? '8787');
    const allowedOrigins = (values.ALLOWED_ORIGINS ?? 'http://localhost:3001,http://127.0.0.1:3001')
      .split(',').map(value => exactOrigin(value.trim()));
    if (!allowedOrigins.length || new Set(allowedOrigins).size !== allowedOrigins.length) throw new ConfigurationError();
    const bindings = [values.DATABASE_URL, values.CLERK_SECRET_KEY, values.CLERK_ISSUER, values.CLERK_PUBLISHABLE_KEY];
    if (bindings.every(value => !value) && !values.PROVISIONER_DATABASE_URL && !values.ACCESS_DATABASE_URL && !values.MANDATE_DATABASE_URL) {
      return { environment, port, allowedOrigins, credentials: null };
    }
    const databaseUrl = z.string().min(1).parse(values.DATABASE_URL);
    const secretKey = z.string().regex(/^sk_test_[A-Za-z0-9_-]+$/).parse(values.CLERK_SECRET_KEY);
    const publishableKey = z.string().regex(/^pk_test_[A-Za-z0-9_-]+$/).parse(values.CLERK_PUBLISHABLE_KEY);
    const issuer = z.string().url().parse(values.CLERK_ISSUER);
    const issuerUrl = new URL(issuer);
    const publishedHost = atob(publishableKey.slice(8));
    if (issuerUrl.origin !== issuer || issuerUrl.protocol !== 'https:' ||
        !issuerUrl.hostname.endsWith('.clerk.accounts.dev') || publishedHost !== `${issuerUrl.hostname}$`) {
      throw new ConfigurationError();
    }
    const database = developmentDatabase(databaseUrl);
    let provisionerDatabaseUrl: string | undefined;
    if (values.PROVISIONER_DATABASE_URL) {
      const provisioner = developmentDatabase(values.PROVISIONER_DATABASE_URL);
      if (provisioner.host !== database.host || provisioner.pathname !== database.pathname ||
          decodeURIComponent(provisioner.username) === decodeURIComponent(database.username)) throw new ConfigurationError();
      provisionerDatabaseUrl = provisioner.href;
    }
    let accessDatabaseUrl: string | undefined;
    if (values.ACCESS_DATABASE_URL) {
      const access = developmentDatabase(values.ACCESS_DATABASE_URL);
      if (access.host !== database.host || access.pathname !== database.pathname ||
          decodeURIComponent(access.username) === decodeURIComponent(database.username) ||
          (provisionerDatabaseUrl && decodeURIComponent(access.username) === decodeURIComponent(new URL(provisionerDatabaseUrl).username))) throw new ConfigurationError();
      accessDatabaseUrl = access.href;
    }
    let mandateDatabaseUrl: string | undefined;
    if (values.MANDATE_DATABASE_URL) {
      const mandate = developmentDatabase(values.MANDATE_DATABASE_URL);
      const existingUsers = [database.href, provisionerDatabaseUrl, accessDatabaseUrl].filter((value): value is string => Boolean(value))
        .map(value => decodeURIComponent(new URL(value).username));
      if (mandate.host !== database.host || mandate.pathname !== database.pathname || existingUsers.includes(decodeURIComponent(mandate.username))) throw new ConfigurationError();
      mandateDatabaseUrl = mandate.href;
    }
    return { environment, port, allowedOrigins, credentials: { databaseUrl: database.href, secretKey, issuer, publishableKey,
      ...(provisionerDatabaseUrl ? { provisionerDatabaseUrl } : {}), ...(accessDatabaseUrl ? { accessDatabaseUrl } : {}),
      ...(mandateDatabaseUrl ? { mandateDatabaseUrl } : {}) } };
  } catch { throw new ConfigurationError(); }
}
