import { z } from 'zod';
import { IdSchema } from '../../../packages/contracts/src/core';

export class NativeApiConfigurationError extends Error {
  constructor() { super('The native API is not configured. Check its protected development bindings.'); }
}
type Values = Record<string, string | undefined>;
function required(value: string | undefined): string { return z.string().trim().min(1).max(8192).parse(value); }
function parsed<T>(read: () => T): T { try { return read(); } catch { throw new NativeApiConfigurationError(); } }
function database(value: string | undefined): URL {
  const url = new URL(required(value));
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.pathname !== '/pactwoven_dev' ||
      !url.username || !url.password || url.hash || (url.port && url.port !== '5432') ||
      (!local && (!url.hostname.endsWith('.neon.tech') || url.searchParams.get('sslmode') !== 'verify-full'))) throw new Error();
  const seen = new Set<string>();
  for (const [key, value] of url.searchParams) {
    if (seen.has(key) || !['sslmode', 'channel_binding'].includes(key) ||
        (key === 'sslmode' && value !== 'verify-full') || (key === 'channel_binding' && value !== 'require')) throw new Error();
    seen.add(key);
  }
  return url;
}

// This project receives only the API audience's credentials. No execution
// credential is required or imported to initialize user-facing task requests.
export function readNativeApiConfig(values: Values) {
  return parsed(() => {
    // Tripwire for a mis-enrolled project; deployment allowlist verification
    // still supplies the actual secret-audience boundary.
    if (['AZURE_OPENAI_API_KEY', 'NATIVE_TASK_WORKER_DATABASE_URL', 'NATIVE_TASK_DISPATCH_DATABASE_URL', 'SIGNER_PRIVATE_KEY',
      'NATIVE_DELEGATION_WORKER_DATABASE_URL', 'NATIVE_DELEGATION_COORDINATOR_DATABASE_URL', 'NATIVE_DELEGATION_DISPATCH_DATABASE_URL',
      'PAID_TOOL_SOURCE_PRIVATE_KEY','PAID_TOOL_SIGNER_DATABASE_URL','PAID_TOOL_POLICY_DATABASE_URL','PAID_TOOL_BROADCASTER_DATABASE_URL','PAID_TOOL_OBSERVER_DATABASE_URL','PAID_TOOL_DELIVERY_DATABASE_URL','PAID_TOOL_SCHEDULER_DATABASE_URL']
      .some(key => (values[key] ?? '').length > 0)) throw new Error();
    const environment = z.literal('development').parse(values.APP_ENVIRONMENT);
    const foundation = database(values.FOUNDATION_DATABASE_URL), native = database(values.NATIVE_TASK_API_DATABASE_URL);
    if (foundation.hostname.replace('-pooler.', '.') !== native.hostname.replace('-pooler.', '.') ||
        foundation.pathname !== native.pathname || foundation.port !== native.port || foundation.username === native.username) throw new Error();
    const allowedOrigins = required(values.WEB_ORIGINS).split(',').map(value => {
      const url = new URL(value.trim());
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
          (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))) throw new Error();
      return url.origin;
    });
    if (allowedOrigins.length > 6 || new Set(allowedOrigins).size !== allowedOrigins.length) throw new Error();
    const issuer = new URL(required(values.CLERK_ISSUER));
    if (issuer.protocol !== 'https:' || issuer.username || issuer.password || issuer.search || issuer.hash || issuer.pathname !== '/' || issuer.port) throw new Error();
    const secretKey = z.string().regex(/^sk_test_[A-Za-z0-9_-]+$/).parse(values.CLERK_SECRET_KEY);
    return { environment, foundationDatabaseUrl: foundation.href, nativeDatabaseUrl: native.href, allowedOrigins,
      identity: { secretKey, issuer: issuer.origin, authorizedParties: allowedOrigins } };
  });
}

export function readNativePaidApiConfig(values:Values){
  const names=['PAID_TOOL_API_DATABASE_URL','PAID_TOOL_ORGANIZATION_ID','PAID_TOOL_SOURCE_KEY','PAID_TOOL_FEE_KEY','PAID_TOOL_ALLOW_NEW_WORK'];
  if(names.every(name=>!values[name]))return undefined;
  return parsed(()=>{
    const existing=readNativeApiConfig(values),paid=database(values.PAID_TOOL_API_DATABASE_URL),foundation=new URL(existing.foundationDatabaseUrl),native=new URL(existing.nativeDatabaseUrl);
    if(paid.hostname.replace('-pooler.','.')!==foundation.hostname.replace('-pooler.','.')||paid.pathname!==foundation.pathname||paid.port!==foundation.port||
      [foundation.username,native.username].includes(paid.username))throw new Error();
    if(values.NATIVE_DELEGATION_API_DATABASE_URL&&paid.username===database(values.NATIVE_DELEGATION_API_DATABASE_URL).username)throw new Error();
    const sourceKey=IdSchema.parse(values.PAID_TOOL_SOURCE_KEY),feeKey=IdSchema.parse(values.PAID_TOOL_FEE_KEY);
    if(sourceKey===feeKey)throw new Error();
    return {...existing,paidDatabaseUrl:paid.href,organizationId:IdSchema.parse(values.PAID_TOOL_ORGANIZATION_ID),sourceKey,feeKey,
      allowNewWork:z.enum(['0','1']).parse(values.PAID_TOOL_ALLOW_NEW_WORK)==='1'};
  });
}

// Optional, independently initialized v2 resources never widen the v1 pool.
export function readNativeDelegatedApiConfig(values: Values) {
  return parsed(() => {
    const existing = readNativeApiConfig(values);
    const delegation = database(values.NATIVE_DELEGATION_API_DATABASE_URL);
    const native = new URL(existing.nativeDatabaseUrl), foundation = new URL(existing.foundationDatabaseUrl);
    if (delegation.hostname.replace('-pooler.', '.') !== native.hostname.replace('-pooler.', '.') ||
      delegation.pathname !== native.pathname || delegation.port !== native.port ||
      [native.username, foundation.username].includes(delegation.username)) throw new Error();
    return { environment: existing.environment, delegationDatabaseUrl: delegation.href, identity: existing.identity };
  });
}

export function nativeExecutionOrigin(value: unknown): string {
  return parsed(() => {
    const url = new URL(z.string().trim().min(1).max(512).parse(value));
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash ||
        !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.vercel\.app$/.test(url.hostname)) throw new Error();
    return url.origin;
  });
}
