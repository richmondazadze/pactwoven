import { z } from 'zod';
import { canonicalJson } from '../../../packages/contracts/src/canonical';
import { DelegatedServiceRosterSchema } from '../../../packages/contracts/src/delegated-execution';
import { normalizeAzureResponsesEndpoint } from '../../coordinator/src/azure-gateway';
import { NativeHostConfigurationError } from './config';

type Values = Record<string, string | undefined>;
const permittedDatabaseKeys = new Set(['NATIVE_DELEGATION_COORDINATOR_DATABASE_URL', 'NATIVE_DELEGATION_WORKER_DATABASE_URL',
  'NATIVE_DELEGATION_DISPATCH_DATABASE_URL', 'NATIVE_TASK_WORKER_DATABASE_URL', 'NATIVE_TASK_DISPATCH_DATABASE_URL',
  'PAID_TOOL_POLICY_DATABASE_URL','PAID_TOOL_BROADCASTER_DATABASE_URL','PAID_TOOL_OBSERVER_DATABASE_URL','PAID_TOOL_DELIVERY_DATABASE_URL','PAID_TOOL_SCHEDULER_DATABASE_URL']);
function required(value: string | undefined, maximum = 8192) { return z.string().trim().min(1).max(maximum).parse(value); }
function sanitized<T>(read: () => T): T { try { return read(); } catch { throw new NativeHostConfigurationError(); } }
function database(value: string | undefined): URL {
  const url = new URL(required(value));
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.neon\.tech$/.test(url.hostname) ||
    url.pathname !== '/pactwoven_dev' || url.hash || (url.port && url.port !== '5432') ||
    !url.username || !url.password || url.searchParams.get('sslmode') !== 'verify-full') throw Error();
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(decodeURIComponent(url.username)) || /[\r\n\0]/.test(decodeURIComponent(url.password))) throw Error();
  const seen = new Set<string>();
  for (const [key, value] of url.searchParams) {
    if (seen.has(key) || !['sslmode', 'channel_binding'].includes(key) ||
      (key === 'sslmode' && value !== 'verify-full') || (key === 'channel_binding' && value !== 'require')) throw Error();
    seen.add(key);
  }
  return url;
}
function databaseBindings(values: Values) {
  // Preserve the separately reviewed v1 executor audiences. Any API/foundation,
  // signer or unknown database credential is a configuration error here.
  if (Object.entries(values).some(([key, value]) => Boolean(value) &&
    ((key.endsWith('DATABASE_URL') && !permittedDatabaseKeys.has(key)) || ['CLERK_SECRET_KEY', 'SIGNER_PRIVATE_KEY','PAID_TOOL_SOURCE_PRIVATE_KEY','PAID_TOOL_SIGNER_DATABASE_URL'].includes(key) ||
      /(?:^|_)(?:GOOGLE|OAUTH|VAULT|CONTENT_WORKER)(?:_|$)/.test(key)))) throw Error();
  const environment = z.literal('development').parse(values.APP_ENVIRONMENT);
  const coordinator = database(values.NATIVE_DELEGATION_COORDINATOR_DATABASE_URL);
  const worker = database(values.NATIVE_DELEGATION_WORKER_DATABASE_URL);
  const dispatcher = database(values.NATIVE_DELEGATION_DISPATCH_DATABASE_URL);
  const valuesList = [coordinator, worker, dispatcher];
  const location = (url: URL) => `${url.hostname.replace(/^([a-z0-9-]+)-pooler\./, '$1.')}:${url.port || '5432'}${url.pathname}`;
  if (new Set(valuesList.map(location)).size !== 1 || new Set(valuesList.map(url => decodeURIComponent(url.username))).size !== 3) throw Error();
  return { environment, databases: { coordinator: coordinator.href, worker: worker.href, dispatcher: dispatcher.href } };
}
function apiOrigin(value: string | undefined) {
  const url = new URL(required(value, 512));
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.vercel\.app$/.test(url.hostname)) throw Error();
  return url.origin;
}
export function readDelegatedHostDispatchConfig(values: Values) {
  return sanitized(() => { const config = databaseBindings(values); return { environment: config.environment, databaseUrl: config.databases.dispatcher }; });
}
export function readDelegatedHostConfig(values: Values) {
  return sanitized(() => {
    const config = databaseBindings(values), services = DelegatedServiceRosterSchema.parse(JSON.parse(required(values.NATIVE_DELEGATION_SERVICES)));
    if (services.coordinator.serviceId === services.research.serviceId || canonicalJson(services.research) !== canonicalJson(services.planning) ||
      canonicalJson(services.research) !== canonicalJson(services.escalation)) throw Error();
    const endpoint = normalizeAzureResponsesEndpoint(required(values.AZURE_OPENAI_ENDPOINT));
    const apiKey = z.string().min(1).max(4096).refine(value => !/[\r\n]/.test(value)).parse(values.AZURE_OPENAI_API_KEY);
    return { ...config, services, endpoint, apiKey, apiOrigin: apiOrigin(values.NATIVE_API_ORIGIN) };
  });
}
