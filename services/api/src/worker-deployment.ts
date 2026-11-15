import { z } from 'zod';

const id = z.string().regex(/^[a-f0-9]{32}$/).refine(value => value !== '0'.repeat(32));
const configSchema = z.strictObject({
  $schema: z.string(), name: z.string(), main: z.string(), compatibility_date: z.literal('2026-11-14'),
  compatibility_flags: z.tuple([z.literal('nodejs_compat')]), workers_dev: z.boolean(), preview_urls: z.literal(false),
  routes: z.tuple([]), send_metrics: z.literal(false), observability: z.strictObject({ enabled: z.literal(false) }),
  vars: z.strictObject({ APP_ENVIRONMENT: z.literal('development'), WORKER_ROLE: z.enum(['api', 'provisioner']),
    ALLOWED_ORIGINS: z.string().min(1), EXPECTED_DATABASE_USER: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/) }),
  services: z.array(z.strictObject({ binding: z.string(), service: z.string() })).optional(),
  hyperdrive: z.tuple([z.strictObject({ binding: z.literal('DATABASE'), id })]),
});
const hyperdriveSchema = z.object({
  id, caching: z.object({ disabled: z.literal(true) }),
  origin: z.object({ database: z.literal('pactwoven_dev'), user: z.string(),
    scheme: z.enum(['postgres', 'postgresql']), host: z.string().regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+neon\.tech$/),
    port: z.literal(5432) }),
  origin_connection_limit: z.number().int().min(1).max(10),
  mtls: z.object({ sslmode: z.literal('verify-full') }),
});

/** Consume fresh control-plane observations before deploy; runtime bindings do
 * not reveal caching or origin TLS configuration. Never print input values. */
export function assertDevelopmentWorkerDeployment(input: unknown): void {
  const parsed = z.object({ api: configSchema, provisioner: configSchema, hyperdrives: z.array(hyperdriveSchema),
    workerSecrets: z.strictObject({ api: z.array(z.string()), provisioner: z.array(z.string()) }),
  }).safeParse(input);
  if (!parsed.success) throw new Error('Development Worker deployment configuration is incomplete or unsafe.');
  const { api, provisioner, hyperdrives, workerSecrets } = parsed.data;
  const publicNames = ['CLERK_ISSUER', 'CLERK_PUBLISHABLE_KEY'];
  const privateNames = [...publicNames, 'CLERK_SECRET_KEY'];
  for (const [actual, expected] of [[workerSecrets.api, publicNames], [workerSecrets.provisioner, privateNames]]) {
    if (actual!.length !== expected!.length || new Set(actual).size !== actual!.length || expected!.some(name => !actual!.includes(name))) {
      throw new Error('Development Worker secret placement is invalid.');
    }
  }
  if (api.name !== 'pactwoven-api-development' || api.main !== 'src/worker.ts' || api.vars.WORKER_ROLE !== 'api' || !api.workers_dev ||
      provisioner.name !== 'pactwoven-provisioner-development' || provisioner.main !== 'src/provisioner-worker.ts' ||
      provisioner.vars.WORKER_ROLE !== 'provisioner' || provisioner.workers_dev || provisioner.services?.length ||
      api.services?.length !== 1 || api.services[0]?.binding !== 'IDENTITY_PROVISIONER' || api.services[0].service !== provisioner.name ||
      api.vars.EXPECTED_DATABASE_USER === provisioner.vars.EXPECTED_DATABASE_USER ||
      api.vars.ALLOWED_ORIGINS !== provisioner.vars.ALLOWED_ORIGINS || api.hyperdrive[0].id === provisioner.hyperdrive[0].id) {
    throw new Error('Development Worker service isolation is invalid.');
  }
  for (const config of [api, provisioner]) {
    const matches = hyperdrives.filter(resource => resource.id === config.hyperdrive[0].id);
    if (matches.length !== 1 || matches[0]?.origin.user !== config.vars.EXPECTED_DATABASE_USER) {
      throw new Error('Development Hyperdrive role binding does not match the observed resource.');
    }
    const origins = config.vars.ALLOWED_ORIGINS.split(',');
    if (origins.length !== new Set(origins).size) throw new Error('Development Worker origins are invalid.');
    for (const origin of origins) {
      try {
        const url = new URL(origin);
        if (url.origin !== origin || (url.protocol !== 'https:' &&
            !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) throw new Error();
      } catch { throw new Error('Development Worker origins are invalid.'); }
    }
  }
  const a = hyperdrives.find(resource => resource.id === api.hyperdrive[0].id)!;
  const b = hyperdrives.find(resource => resource.id === provisioner.hyperdrive[0].id)!;
  if (a.origin.host !== b.origin.host) throw new Error('Development Worker databases must be the same dedicated development database.');
}
