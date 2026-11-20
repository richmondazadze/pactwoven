import { z } from 'zod';
import { normalizeAzureResponsesEndpoint } from './azure-gateway.js';

export class CoordinatorConfigurationError extends Error {
  constructor() { super('Invalid coordinator configuration. Check the protected development bindings.'); }
}

export function readCoordinatorConfig(values: Record<string, string | undefined>) {
  try {
    const environment = z.literal('development').parse(values.APP_ENVIRONMENT ?? 'development');
    const database = new URL(z.string().min(1).parse(values.NATIVE_TASK_WORKER_DATABASE_URL));
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(database.hostname);
    if (!['postgres:', 'postgresql:'].includes(database.protocol) || database.pathname !== '/pactwoven_dev' ||
        !database.username || !database.password || database.hash ||
        (!loopback && (!database.hostname.endsWith('.neon.tech') || database.searchParams.get('sslmode') !== 'verify-full'))) throw new Error();
    const keys = new Set<string>();
    for (const [key, value] of database.searchParams) {
      if (keys.has(key) || !['sslmode', 'channel_binding'].includes(key) ||
          (key === 'sslmode' && value !== 'verify-full') || (key === 'channel_binding' && value !== 'require')) throw new Error();
      keys.add(key);
    }
    const endpoint = normalizeAzureResponsesEndpoint(z.string().min(1).parse(values.AZURE_OPENAI_ENDPOINT));
    const apiKey = z.string().min(1).max(4096).refine(value => !/[\r\n]/.test(value)).parse(values.AZURE_OPENAI_API_KEY);
    const workerId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).parse(values.NATIVE_WORKER_ID ?? `native-${crypto.randomUUID()}`);
    return { environment, databaseUrl: database.href, endpoint, apiKey, workerId };
  } catch { throw new CoordinatorConfigurationError(); }
}
