import { z } from 'zod';
import { normalizeAzureResponsesEndpoint } from '@pactwoven/coordinator';

export class NativeHostConfigurationError extends Error {
  constructor() { super('The native work service is not configured. Check its protected development bindings.'); }
}
type Values = Record<string, string | undefined>;
function required(value: string | undefined): string { return z.string().trim().min(1).max(8192).parse(value); }
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
function sameDatabase(a: URL, b: URL) {
  if (a.hostname.replace('-pooler.', '.') !== b.hostname.replace('-pooler.', '.') || a.pathname !== b.pathname ||
      a.port !== b.port || a.username === b.username) throw new Error();
}
function development(values: Values) {
  if (['FOUNDATION_DATABASE_URL', 'NATIVE_TASK_API_DATABASE_URL', 'CLERK_SECRET_KEY', 'SIGNER_PRIVATE_KEY','PAID_TOOL_SOURCE_PRIVATE_KEY','PAID_TOOL_SIGNER_DATABASE_URL','PAID_TOOL_API_DATABASE_URL'].some(key => values[key])) throw new Error();
  return z.literal('development').parse(values.APP_ENVIRONMENT);
}
function parsed<T>(read: () => T): T { try { return read(); } catch { throw new NativeHostConfigurationError(); } }
function nativeApiOrigin(value: string | undefined): string {
  const url = new URL(required(value));
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash ||
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.vercel\.app$/.test(url.hostname)) throw new Error();
  return url.origin;
}

export function readNativeDispatchConfig(values: Values) {
  return parsed(() => ({ environment: development(values), databaseUrl: database(values.NATIVE_TASK_DISPATCH_DATABASE_URL).href }));
}

export function readNativeWorkerConfig(values: Values) {
  return parsed(() => {
    const environment = development(values);
    const worker = database(values.NATIVE_TASK_WORKER_DATABASE_URL);
    const dispatch = database(values.NATIVE_TASK_DISPATCH_DATABASE_URL);
    sameDatabase(worker, dispatch);
    const endpoint = normalizeAzureResponsesEndpoint(required(values.AZURE_OPENAI_ENDPOINT));
    const apiKey = z.string().min(1).max(4096).refine(value => !/[\r\n]/.test(value)).parse(values.AZURE_OPENAI_API_KEY);
    return { environment, databaseUrl: worker.href, endpoint, apiKey, apiOrigin: nativeApiOrigin(values.NATIVE_API_ORIGIN) };
  });
}
