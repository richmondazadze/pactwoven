import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { assertDevelopmentWorkerDeployment } from './worker-deployment.js';

const apiSource = JSON.parse(await readFile(new URL('../wrangler.api.json', import.meta.url), 'utf8'));
const provisionerSource = JSON.parse(await readFile(new URL('../wrangler.provisioner.json', import.meta.url), 'utf8'));
function fixture() {
  const apiId = 'a'.repeat(32), provisionerId = 'b'.repeat(32);
  return {
    workerSecrets: { api: ['CLERK_ISSUER', 'CLERK_PUBLISHABLE_KEY'], provisioner: ['CLERK_ISSUER', 'CLERK_PUBLISHABLE_KEY', 'CLERK_SECRET_KEY'] },
    api: { ...structuredClone(apiSource), hyperdrive: [{ binding: 'DATABASE', id: apiId }] },
    provisioner: { ...structuredClone(provisionerSource), hyperdrive: [{ binding: 'DATABASE', id: provisionerId }] },
    hyperdrives: [
      { id: apiId, caching: { disabled: true }, mtls: { sslmode: 'verify-full' }, origin_connection_limit: 5,
        origin: { database: 'pactwoven_dev', user: 'pactwoven_app', scheme: 'postgresql', host: 'ep-fixture.us-east-2.aws.neon.tech', port: 5432 } },
      { id: provisionerId, caching: { disabled: true }, mtls: { sslmode: 'verify-full' }, origin_connection_limit: 3,
        origin: { database: 'pactwoven_dev', user: 'pactwoven_identity', scheme: 'postgresql', host: 'ep-fixture.us-east-2.aws.neon.tech', port: 5432 } },
    ],
  };
}

describe('development Worker deployment guard', () => {
  it('accepts isolated development configs matched to verified cache-disabled Hyperdrive resources', () => {
    expect(() => assertDevelopmentWorkerDeployment(fixture())).not.toThrow();
  });

  it('rejects unprovisioned configuration rather than accepting missing resource bindings', () => {
    expect(() => assertDevelopmentWorkerDeployment({ ...fixture(), api: apiSource, provisioner: provisionerSource })).toThrow();
  });

  it('rejects public provisioner endpoints and preview routes', () => {
    for (const patch of [{ workers_dev: true }, { preview_urls: true }, { routes: ['example.com/*'] }]) {
      const data = fixture(); Object.assign(data.provisioner, patch);
      expect(() => assertDevelopmentWorkerDeployment(data)).toThrow();
    }
  });

  it('rejects different workers, extra service bindings, shared Hyperdrive resources and role swaps', () => {
    const changes = [
      (data: ReturnType<typeof fixture>) => { data.api.services[0].service = 'unapproved-service'; },
      (data: ReturnType<typeof fixture>) => { data.api.services.push({ binding: 'OTHER', service: 'other' }); },
      (data: ReturnType<typeof fixture>) => { data.api.hyperdrive[0]!.id = data.provisioner.hyperdrive[0]!.id; },
      (data: ReturnType<typeof fixture>) => { data.api.vars.EXPECTED_DATABASE_USER = 'pactwoven_identity'; },
      (data: ReturnType<typeof fixture>) => { data.api.vars.WORKER_ROLE = 'provisioner'; },
    ];
    for (const change of changes) { const data = fixture(); change(data); expect(() => assertDevelopmentWorkerDeployment(data)).toThrow(); }
  });

  it('rejects missing, duplicated or mismatched control-plane observations', () => {
    for (const change of [
      (data: ReturnType<typeof fixture>) => { data.hyperdrives.pop(); },
      (data: ReturnType<typeof fixture>) => { data.hyperdrives.push(data.hyperdrives[0]!); },
      (data: ReturnType<typeof fixture>) => { data.hyperdrives[0]!.origin.user = 'database_owner'; },
      (data: ReturnType<typeof fixture>) => { data.hyperdrives[1]!.origin.host = 'ep-other.us-east-2.aws.neon.tech'; },
    ]) { const data = fixture(); change(data); expect(() => assertDevelopmentWorkerDeployment(data)).toThrow(); }
  });

  it('rejects caching, weaker TLS, nondevelopment databases and unbounded origin connection budgets', () => {
    for (const change of [
      (data: ReturnType<typeof fixture>) => { data.hyperdrives[0]!.caching.disabled = false; },
      (data: ReturnType<typeof fixture>) => { data.hyperdrives[0]!.mtls.sslmode = 'require'; },
      (data: ReturnType<typeof fixture>) => { data.hyperdrives[0]!.origin.database = 'production'; },
      (data: ReturnType<typeof fixture>) => { data.hyperdrives[0]!.origin.host = 'not-neon.example'; },
      (data: ReturnType<typeof fixture>) => { data.hyperdrives[0]!.origin_connection_limit = 100; },
    ]) { const data = fixture(); change(data); expect(() => assertDevelopmentWorkerDeployment(data)).toThrow(); }
  });

  it('rejects secrets in tracked variables, production flags and differing or unsafe origins', () => {
    for (const change of [
      (data: ReturnType<typeof fixture>) => { data.api.vars.CLERK_SECRET_KEY = 'fixture-not-a-key'; },
      (data: ReturnType<typeof fixture>) => { data.api.vars.APP_ENVIRONMENT = 'production'; },
      (data: ReturnType<typeof fixture>) => { data.provisioner.vars.ALLOWED_ORIGINS = 'https://other.example'; },
      (data: ReturnType<typeof fixture>) => { data.api.vars.ALLOWED_ORIGINS = data.provisioner.vars.ALLOWED_ORIGINS = '*'; },
      (data: ReturnType<typeof fixture>) => { data.api.vars.ALLOWED_ORIGINS = data.provisioner.vars.ALLOWED_ORIGINS = 'https://example.com,https://example.com'; },
    ]) { const data = fixture(); change(data); expect(() => assertDevelopmentWorkerDeployment(data)).toThrow(); }
  });

  it('requires the Clerk administrative key only on the private Worker and rejects unexpected secrets', () => {
    for (const change of [
      (data: ReturnType<typeof fixture>) => { data.workerSecrets.api.push('CLERK_SECRET_KEY'); },
      (data: ReturnType<typeof fixture>) => { data.workerSecrets.provisioner = ['CLERK_ISSUER', 'CLERK_PUBLISHABLE_KEY']; },
      (data: ReturnType<typeof fixture>) => { data.workerSecrets.api.push('OTHER_ADMIN_KEY'); },
      (data: ReturnType<typeof fixture>) => { data.workerSecrets.provisioner.push('CLERK_SECRET_KEY'); },
    ]) { const data = fixture(); change(data); expect(() => assertDevelopmentWorkerDeployment(data)).toThrow(); }
  });
});
