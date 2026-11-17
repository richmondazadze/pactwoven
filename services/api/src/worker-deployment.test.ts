import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertDevelopmentWorkerDeployment } from './worker-deployment.js';
import { readSupplierWorkerConfig, supplierWorkerDatabaseBindings } from './supplier-worker-config.js';
import { rehashWorkerSupplierBinding, workerSupplierBindings, workerSupplierLanes, workerSupplierNow } from './supplier-worker.test-fixtures.js';

const apiSource = JSON.parse(await readFile(new URL('../wrangler.api.json', import.meta.url), 'utf8'));
const provisionerSource = JSON.parse(await readFile(new URL('../wrangler.provisioner.json', import.meta.url), 'utf8'));
const mandateSource = JSON.parse(await readFile(new URL('../wrangler.mandate.json', import.meta.url), 'utf8'));
function fixture() {
  const apiId = 'a'.repeat(32), provisionerId = 'b'.repeat(32), accessId = 'c'.repeat(32), mandateId = 'd'.repeat(32);
  return {
    workerSecrets: { api: ['CLERK_ISSUER', 'CLERK_PUBLISHABLE_KEY'], provisioner: ['CLERK_ISSUER', 'CLERK_PUBLISHABLE_KEY', 'CLERK_SECRET_KEY'], mandate: ['CLERK_ISSUER', 'CLERK_PUBLISHABLE_KEY', 'CLERK_SECRET_KEY'] },
    api: { ...structuredClone(apiSource), services: [
      { binding: 'IDENTITY_PROVISIONER', service: 'pactwoven-provisioner-development' },
      { binding: 'MANDATE_AUTHORITY', service: 'pactwoven-mandate-development' },
    ], hyperdrive: [{ binding: 'DATABASE', id: apiId }] },
    provisioner: { ...structuredClone(provisionerSource), hyperdrive: [{ binding: 'DATABASE', id: provisionerId }, { binding: 'ACCESS_DATABASE', id: accessId }] },
    mandate: { ...structuredClone(mandateSource), hyperdrive: [{ binding: 'MANDATE_DATABASE', id: mandateId }] },
    hyperdrives: [
      { id: apiId, caching: { disabled: true }, mtls: { sslmode: 'verify-full' }, origin_connection_limit: 5,
        origin: { database: 'pactwoven_dev', user: 'pactwoven_dev_app', scheme: 'postgresql', host: 'ep-fixture.us-east-2.aws.neon.tech', port: 5432 } },
      { id: provisionerId, caching: { disabled: true }, mtls: { sslmode: 'verify-full' }, origin_connection_limit: 5,
        origin: { database: 'pactwoven_dev', user: 'pactwoven_dev_identity', scheme: 'postgresql', host: 'ep-fixture.us-east-2.aws.neon.tech', port: 5432 } },
      { id: accessId, caching: { disabled: true }, mtls: { sslmode: 'verify-full' }, origin_connection_limit: 5,
        origin: { database: 'pactwoven_dev', user: 'pactwoven_dev_access', scheme: 'postgresql', host: 'ep-fixture.us-east-2.aws.neon.tech', port: 5432 } },
      { id: mandateId, caching: { disabled: true }, mtls: { sslmode: 'verify-full' }, origin_connection_limit: 5,
        origin: { database: 'pactwoven_dev', user: 'pactwoven_dev_mandate', scheme: 'postgresql', host: 'ep-fixture.us-east-2.aws.neon.tech', port: 5432 } },
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

  it('rejects caching, weaker TLS, nondevelopment databases and invalid origin connection budgets', () => {
    for (const change of [
      (data: ReturnType<typeof fixture>) => { data.hyperdrives[0]!.caching.disabled = false; },
      (data: ReturnType<typeof fixture>) => { data.hyperdrives[0]!.mtls.sslmode = 'require'; },
      (data: ReturnType<typeof fixture>) => { data.hyperdrives[0]!.origin.database = 'production'; },
      (data: ReturnType<typeof fixture>) => { data.hyperdrives[0]!.origin.host = 'not-neon.example'; },
      (data: ReturnType<typeof fixture>) => { data.hyperdrives[0]!.origin_connection_limit = 4; },
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

  it('requires a third distinct private access binding, user, uncached verified origin and secret-free configuration', () => {
    for (const change of [
      (data: ReturnType<typeof fixture>) => { data.api.hyperdrive.push(data.provisioner.hyperdrive[1]!); },
      (data: ReturnType<typeof fixture>) => { data.api.vars.EXPECTED_ACCESS_DATABASE_USER = 'pactwoven_dev_access'; },
      (data: ReturnType<typeof fixture>) => { delete data.provisioner.vars.EXPECTED_ACCESS_DATABASE_USER; },
      (data: ReturnType<typeof fixture>) => { data.provisioner.vars.EXPECTED_ACCESS_DATABASE_USER = data.api.vars.EXPECTED_DATABASE_USER; },
      (data: ReturnType<typeof fixture>) => { data.provisioner.vars.EXPECTED_ACCESS_DATABASE_USER = data.provisioner.vars.EXPECTED_DATABASE_USER; },
      (data: ReturnType<typeof fixture>) => { data.provisioner.hyperdrive[1]!.id = data.api.hyperdrive[0]!.id; },
      (data: ReturnType<typeof fixture>) => { data.provisioner.hyperdrive[1]!.binding = 'DATABASE'; },
      (data: ReturnType<typeof fixture>) => { data.hyperdrives[2]!.origin.user = 'pactwoven_dev_identity'; },
      (data: ReturnType<typeof fixture>) => { data.hyperdrives[2]!.origin.host = 'ep-other.us-east-2.aws.neon.tech'; },
      (data: ReturnType<typeof fixture>) => { data.hyperdrives[2]!.caching.disabled = false; },
      (data: ReturnType<typeof fixture>) => { data.hyperdrives[2]!.mtls.sslmode = 'require'; },
      (data: ReturnType<typeof fixture>) => { data.workerSecrets.provisioner.push('ACCESS_DATABASE_URL'); },
    ]) { const data = fixture(); change(data); expect(() => assertDevelopmentWorkerDeployment(data)).toThrow(); }
  });

  it.each([
    ['public mandate endpoint', (data: ReturnType<typeof fixture>) => { data.mandate.workers_dev = true; }],
    ['mandate preview', (data: ReturnType<typeof fixture>) => { data.mandate.preview_urls = true; }],
    ['mandate route', (data: ReturnType<typeof fixture>) => { data.mandate.routes = ['example.com/*']; }],
    ['wrong mandate entry', (data: ReturnType<typeof fixture>) => { data.mandate.main = 'src/worker.ts'; }],
    ['wrong mandate role', (data: ReturnType<typeof fixture>) => { data.mandate.vars.WORKER_ROLE = 'api'; }],
    ['missing mandate binding', (data: ReturnType<typeof fixture>) => { data.api.services.pop(); }],
    ['wrong mandate service', (data: ReturnType<typeof fixture>) => { data.api.services[1].service = data.provisioner.name; }],
    ['duplicate mandate service', (data: ReturnType<typeof fixture>) => { data.api.services[0] = data.api.services[1]; }],
    ['outbound private service', (data: ReturnType<typeof fixture>) => { data.mandate.services = [data.api.services[0]]; }],
    ['public mandate credential', (data: ReturnType<typeof fixture>) => { data.api.hyperdrive.push(data.mandate.hyperdrive[0]); }],
    ['identity mandate credential', (data: ReturnType<typeof fixture>) => { data.provisioner.hyperdrive[1] = data.mandate.hyperdrive[0]; }],
    ['mandate bootstrap credential', (data: ReturnType<typeof fixture>) => { data.mandate.hyperdrive[0] = data.provisioner.hyperdrive[0]; }],
    ['shared resource', (data: ReturnType<typeof fixture>) => { data.mandate.hyperdrive[0].id = data.api.hyperdrive[0].id; }],
    ['shared runtime principal', (data: ReturnType<typeof fixture>) => { data.mandate.vars.EXPECTED_MANDATE_DATABASE_USER = data.api.vars.EXPECTED_DATABASE_USER; }],
    ['shared access principal', (data: ReturnType<typeof fixture>) => { data.mandate.vars.EXPECTED_MANDATE_DATABASE_USER = data.provisioner.vars.EXPECTED_ACCESS_DATABASE_USER; }],
    ['shared bootstrap principal', (data: ReturnType<typeof fixture>) => { data.mandate.vars.EXPECTED_MANDATE_DATABASE_USER = data.provisioner.vars.EXPECTED_DATABASE_USER; }],
    ['public expected mandate principal', (data: ReturnType<typeof fixture>) => { data.api.vars.EXPECTED_MANDATE_DATABASE_USER = 'pactwoven_dev_mandate'; }],
    ['identity expected mandate principal', (data: ReturnType<typeof fixture>) => { data.provisioner.vars.EXPECTED_MANDATE_DATABASE_USER = 'pactwoven_dev_mandate'; }],
    ['missing expected principal', (data: ReturnType<typeof fixture>) => { delete data.mandate.vars.EXPECTED_MANDATE_DATABASE_USER; }],
    ['unobserved mandate', (data: ReturnType<typeof fixture>) => { data.hyperdrives.pop(); }],
    ['different origin', (data: ReturnType<typeof fixture>) => { data.hyperdrives[3]!.origin.host = 'ep-other.us-east-2.aws.neon.tech'; }],
    ['wrong observed principal', (data: ReturnType<typeof fixture>) => { data.hyperdrives[3]!.origin.user = 'database_owner'; }],
    ['cached mandate reads', (data: ReturnType<typeof fixture>) => { data.hyperdrives[3]!.caching.disabled = false; }],
    ['unverified origin TLS', (data: ReturnType<typeof fixture>) => { data.hyperdrives[3]!.mtls.sslmode = 'require'; }],
    ['private origin mismatch', (data: ReturnType<typeof fixture>) => { data.mandate.vars.ALLOWED_ORIGINS = 'https://other.example'; }],
    ['missing Clerk key', (data: ReturnType<typeof fixture>) => { data.workerSecrets.mandate.pop(); }],
    ['direct database secret', (data: ReturnType<typeof fixture>) => { data.workerSecrets.mandate.push('MANDATE_DATABASE_URL'); }],
  ] as const)('rejects %s', (_name, change) => {
    const data = fixture(); change(data);
    expect(() => assertDevelopmentWorkerDeployment(data)).toThrow();
  });

  it('keeps credentials and malformed source values out of complete thrown errors', () => {
    const data = fixture(), marker = 'PRIVATE_SENTINEL_NOT_A_REAL_SECRET';
    const privateUrl = new URL('postgresql://example.com/private');
    privateUrl.username = 'private';
    privateUrl.password = marker;
    data.mandate.vars.MANDATE_DATABASE_URL = privateUrl.href;
    try { assertDevelopmentWorkerDeployment(data); expect.fail('Unsafe deployment accepted'); }
    catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain(marker);
      expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(marker);
    }
  });
});

function financialFixture() {
  const base = fixture();
  const names = ['FINANCIAL_POLICY_AUTHORIZER_DATABASE', 'FINANCIAL_POLICY_VERIFIER_DATABASE',
    'CUSTODY_SETUP_WRITER_DATABASE', 'CUSTODY_SETUP_VERIFIER_DATABASE'];
  const users = ['pactwoven_dev_financial_authorizer', 'pactwoven_dev_financial_verifier',
    'pactwoven_dev_custody_setup_writer', 'pactwoven_dev_custody_setup_verifier'];
  const ids = ['e', 'f', '1', '2'].map(value => value.repeat(32));
  const financial = { ...structuredClone(mandateSource), name: 'pactwoven-financial-development', main: 'src/financial-worker.ts',
    vars: { APP_ENVIRONMENT: 'development', WORKER_ROLE: 'financial', ALLOWED_ORIGINS: base.api.vars.ALLOWED_ORIGINS,
      ...Object.fromEntries(names.map((name, index) => [`EXPECTED_${name}_USER`, users[index]])) },
    hyperdrive: names.map((binding, index) => ({ binding, id: ids[index]! })) };
  base.api.services.push({ binding: 'FINANCIAL_AUTHORITY', service: financial.name });
  return { ...base, financial, workerSecrets: { ...base.workerSecrets, financial: [...base.workerSecrets.mandate] },
    hyperdrives: [...base.hyperdrives, ...users.map((user, index) => ({ ...structuredClone(base.hyperdrives[0]!), id: ids[index]!,
      origin: { ...base.hyperdrives[0]!.origin, user } }))] };
}

describe('optional financial Worker deployment', () => {
  it('accepts four private capabilities with independently observed TLS origins', () => {
    expect(() => assertDevelopmentWorkerDeployment(financialFixture())).not.toThrow();
  });
  it('accepts the tracked financial topology with synthetic verified origin observations', async () => {
    const financial = JSON.parse(await readFile(new URL('../wrangler.financial.json', import.meta.url), 'utf8'));
    const configs = { api: structuredClone(apiSource), provisioner: structuredClone(provisionerSource),
      mandate: structuredClone(mandateSource), financial };
    const secrets = fixture().workerSecrets;
    const hyperdrives = Object.values(configs).flatMap(config => config.hyperdrive.map(({ binding, id }: { binding: string; id: string }) => ({
      id, caching: { disabled: true }, mtls: { sslmode: 'verify-full' }, origin_connection_limit: 5,
      origin: { database: 'pactwoven_dev', user: config.vars[`EXPECTED_${binding}_USER`], scheme: 'postgresql',
        host: 'ep-fixture.us-east-2.aws.neon.tech', port: 5432 },
    })));
    expect(() => assertDevelopmentWorkerDeployment({ ...configs, hyperdrives,
      workerSecrets: { ...secrets, financial: [...secrets.mandate] } })).not.toThrow();
  });
  it('rejects public exposure, unrelated services, credential placement, role aliases and weaker database transport', () => {
    const changes = [
      (v: ReturnType<typeof financialFixture>) => { v.financial.workers_dev = true; },
      (v: ReturnType<typeof financialFixture>) => { v.financial.preview_urls = true; },
      (v: ReturnType<typeof financialFixture>) => { v.financial.services = [{ binding: 'OTHER', service: 'other' }]; },
      (v: ReturnType<typeof financialFixture>) => { v.api.services.at(-1).service = 'other'; },
      (v: ReturnType<typeof financialFixture>) => { v.financial.vars.EXPECTED_FINANCIAL_POLICY_VERIFIER_DATABASE_USER = 'pactwoven_dev_app'; },
      (v: ReturnType<typeof financialFixture>) => { v.financial.hyperdrive[1]!.id = v.financial.hyperdrive[0]!.id; },
      (v: ReturnType<typeof financialFixture>) => { v.financial.hyperdrive[1]!.binding = v.financial.hyperdrive[0]!.binding; },
      (v: ReturnType<typeof financialFixture>) => { v.financial.hyperdrive[1]!.id = v.api.hyperdrive[0].id; },
      (v: ReturnType<typeof financialFixture>) => { v.financial.vars.CLERK_SECRET_KEY = 'private-binding'; },
      (v: ReturnType<typeof financialFixture>) => { v.workerSecrets.financial.pop(); },
      (v: ReturnType<typeof financialFixture>) => { v.workerSecrets.financial.push('DATABASE_URL'); },
      (v: ReturnType<typeof financialFixture>) => { v.financial.vars.ALLOWED_ORIGINS = 'https://other.example'; },
      (v: ReturnType<typeof financialFixture>) => { v.hyperdrives[4]!.origin.user = 'owner'; },
      (v: ReturnType<typeof financialFixture>) => { v.hyperdrives[4]!.caching.disabled = false; },
      (v: ReturnType<typeof financialFixture>) => { v.hyperdrives[4]!.mtls.sslmode = 'require'; },
      (v: ReturnType<typeof financialFixture>) => { v.hyperdrives[4]!.origin.host = 'ep-other.neon.tech'; },
      (v: ReturnType<typeof financialFixture>) => { v.hyperdrives.push(v.hyperdrives[4]!); },
    ];
    for (const change of changes) { const data = financialFixture(); change(data); expect(() => assertDevelopmentWorkerDeployment(data)).toThrow(); }
  });
  it('requires configuration and secret inventory whenever the API binds the financial service', () => {
    const data = financialFixture();
    expect(() => assertDevelopmentWorkerDeployment({ ...data, financial: undefined })).toThrow();
    expect(() => assertDevelopmentWorkerDeployment({ ...data, workerSecrets: { ...data.workerSecrets, financial: undefined } })).toThrow();
    expect(() => assertDevelopmentWorkerDeployment({ ...data, api: { ...data.api, services: data.api.services.slice(0, 2) } })).toThrow();
  });
});

function supplierFixture() {
  const base = financialFixture(), lanes = workerSupplierLanes();
  const names = Object.values(supplierWorkerDatabaseBindings).flatMap(lane => Object.values(lane));
  const users = [lanes.buyer.binding.verifier.name, lanes.buyer.binding.authorizer.name,
    lanes.supplier.binding.verifier.name, lanes.supplier.binding.authorizer.name];
  const ids = ['3', '4', '5', '6'].map(value => value.repeat(32));
  const supplier = { ...structuredClone(mandateSource), name: 'pactwoven-supplier-development', main: 'src/supplier-worker.ts',
    vars: { APP_ENVIRONMENT: 'development', WORKER_ROLE: 'supplier', ALLOWED_ORIGINS: base.api.vars.ALLOWED_ORIGINS,
      SUPPLIER_RELATIONSHIP_LANES: JSON.stringify(lanes) }, hyperdrive: names.map((binding, index) => ({ binding, id: ids[index]! })) };
  base.api.services.push({ binding: 'SUPPLIER_AUTHORITY', service: supplier.name });
  return { ...base, supplier, workerSecrets: { ...base.workerSecrets,
    supplier: base.workerSecrets.mandate.map(name => ({ name, type: 'secret_text' })) },
    hyperdrives: [...base.hyperdrives, ...users.map((user, index) => ({ ...structuredClone(base.hyperdrives[0]!), id: ids[index]!,
      origin: { ...base.hyperdrives[0]!.origin, user } }))] };
}
type SupplierFixture = ReturnType<typeof supplierFixture>;
function changeSupplierLanes(data: SupplierFixture, change: (lanes: ReturnType<typeof workerSupplierLanes>) => void) {
  const lanes = workerSupplierLanes(); change(lanes);
  lanes.buyer.binding = rehashWorkerSupplierBinding(lanes.buyer.binding);
  lanes.supplier.binding = rehashWorkerSupplierBinding(lanes.supplier.binding);
  data.supplier.vars.SUPPLIER_RELATIONSHIP_LANES = JSON.stringify(lanes);
}

describe('optional supplier Worker deployment', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(workerSupplierNow); });
  afterEach(() => vi.useRealTimers());

  it('accepts supplier alone or alongside financial with the exact runtime lane JSON and encrypted Clerk inventory', () => {
    const combined = supplierFixture();
    expect(() => assertDevelopmentWorkerDeployment(combined)).not.toThrow();
    const runtime = readSupplierWorkerConfig({ ...workerSupplierBindings(), ...combined.supplier.vars });
    expect(runtime.lanes).toEqual(JSON.parse(combined.supplier.vars.SUPPLIER_RELATIONSHIP_LANES));
    const { financial, ...supplierOnly } = combined;
    const { financial: _financialSecrets, ...secrets } = supplierOnly.workerSecrets;
    const financialIds = new Set(financial.hyperdrive.map((binding: { id: string }) => binding.id));
    expect(() => assertDevelopmentWorkerDeployment({ ...supplierOnly, workerSecrets: secrets,
      api: { ...supplierOnly.api, services: supplierOnly.api.services.filter((service: { binding: string }) => service.binding !== 'FINANCIAL_AUTHORITY') },
      hyperdrives: supplierOnly.hyperdrives.filter(resource => !financialIds.has(resource.id)) })).not.toThrow();
  });

  it.each([
    ['public endpoint', (v: SupplierFixture) => { v.supplier.workers_dev = true; }],
    ['preview endpoint', (v: SupplierFixture) => { v.supplier.preview_urls = true; }],
    ['custom route', (v: SupplierFixture) => { v.supplier.routes = ['supplier.example/*']; }],
    ['wrong name', (v: SupplierFixture) => { v.supplier.name = 'other-supplier'; }],
    ['wrong entrypoint', (v: SupplierFixture) => { v.supplier.main = 'src/worker.ts'; }],
    ['wrong role', (v: SupplierFixture) => { v.supplier.vars.WORKER_ROLE = 'financial'; }],
    ['production scope', (v: SupplierFixture) => { v.supplier.vars.APP_ENVIRONMENT = 'production'; }],
    ['outbound service', (v: SupplierFixture) => { v.supplier.services = [{ binding: 'IDENTITY_PROVISIONER', service: v.provisioner.name }]; }],
    ['wrong API service', (v: SupplierFixture) => { v.api.services.at(-1).service = v.financial.name; }],
    ['wrong API binding', (v: SupplierFixture) => { v.api.services.at(-1).binding = 'OTHER_AUTHORITY'; }],
    ['duplicate API binding', (v: SupplierFixture) => { v.api.services[2] = v.api.services[3]; }],
    ['extra API binding', (v: SupplierFixture) => { v.api.services.push(v.api.services[3]); }],
    ['different origins', (v: SupplierFixture) => { v.supplier.vars.ALLOWED_ORIGINS = 'https://other.example'; }],
    ['private lane on API', (v: SupplierFixture) => { v.api.vars.SUPPLIER_RELATIONSHIP_LANES = v.supplier.vars.SUPPLIER_RELATIONSHIP_LANES; }],
    ['private resource on API', (v: SupplierFixture) => { v.api.hyperdrive.push(v.supplier.hyperdrive[0]); }],
    ['private resource on identity', (v: SupplierFixture) => { v.provisioner.hyperdrive[0] = v.supplier.hyperdrive[0]; }],
    ['private resource on mandate', (v: SupplierFixture) => { v.mandate.hyperdrive[0] = v.supplier.hyperdrive[0]; }],
    ['private resource on financial', (v: SupplierFixture) => { v.financial.hyperdrive[0] = v.supplier.hyperdrive[0]!; }],
    ['duplicate resource', (v: SupplierFixture) => { v.supplier.hyperdrive[1]!.id = v.supplier.hyperdrive[0]!.id; }],
    ['duplicate binding', (v: SupplierFixture) => { v.supplier.hyperdrive[1]!.binding = v.supplier.hyperdrive[0]!.binding; }],
    ['shared base resource', (v: SupplierFixture) => { v.supplier.hyperdrive[0]!.id = v.api.hyperdrive[0].id; }],
    ['shared financial resource', (v: SupplierFixture) => { v.supplier.hyperdrive[0]!.id = v.financial.hyperdrive[0]!.id; }],
    ['missing observation', (v: SupplierFixture) => { v.hyperdrives.pop(); }],
    ['duplicate observation', (v: SupplierFixture) => { v.hyperdrives.push(v.hyperdrives[8]!); }],
    ['wrong observed role', (v: SupplierFixture) => { v.hyperdrives[8]!.origin.user = 'database_owner'; }],
    ['swapped verifier role', (v: SupplierFixture) => { v.hyperdrives[8]!.origin.user = v.hyperdrives[9]!.origin.user; }],
    ['different database', (v: SupplierFixture) => { v.hyperdrives[8]!.origin.database = 'other'; }],
    ['different host', (v: SupplierFixture) => { v.hyperdrives[8]!.origin.host = 'ep-other.neon.tech'; }],
    ['non-Neon host', (v: SupplierFixture) => { v.hyperdrives[8]!.origin.host = 'neon.tech.attacker.example'; }],
    ['wrong port', (v: SupplierFixture) => { v.hyperdrives[8]!.origin.port = 6432; }],
    ['cached reads', (v: SupplierFixture) => { v.hyperdrives[8]!.caching.disabled = false; }],
    ['unverified TLS', (v: SupplierFixture) => { v.hyperdrives[8]!.mtls.sslmode = 'require'; }],
    ['excessive connections', (v: SupplierFixture) => { v.hyperdrives[8]!.origin_connection_limit = 11; }],
    ['missing Clerk inventory', (v: SupplierFixture) => { v.workerSecrets.supplier.pop(); }],
    ['duplicate Clerk inventory', (v: SupplierFixture) => { v.workerSecrets.supplier[1] = v.workerSecrets.supplier[0]!; }],
    ['unencrypted Clerk value', (v: SupplierFixture) => { v.workerSecrets.supplier[0]!.type = 'plain_text'; }],
    ['direct database secret', (v: SupplierFixture) => { v.workerSecrets.supplier.push({ name: 'DATABASE_URL', type: 'secret_text' }); }],
    ['malformed lanes', (v: SupplierFixture) => { v.supplier.vars.SUPPLIER_RELATIONSHIP_LANES = '{'; }],
    ['missing lanes', (v: SupplierFixture) => { v.supplier.vars.SUPPLIER_RELATIONSHIP_LANES = '{}'; }],
    ['wrong binding hash', (v: SupplierFixture) => { const lanes = workerSupplierLanes(); lanes.buyer.binding.reference.hash = 'f'.repeat(64); v.supplier.vars.SUPPLIER_RELATIONSHIP_LANES = JSON.stringify(lanes); }],
    ['shared external organization', (v: SupplierFixture) => changeSupplierLanes(v, lanes => { lanes.supplier.externalOrganizationId = lanes.buyer.externalOrganizationId; })],
    ['shared effective organization', (v: SupplierFixture) => changeSupplierLanes(v, lanes => { lanes.supplier.binding.effectiveOrganizationId = lanes.buyer.binding.effectiveOrganizationId; })],
    ['shared binding identity', (v: SupplierFixture) => changeSupplierLanes(v, lanes => { lanes.supplier.binding.reference.id = lanes.buyer.binding.reference.id; })],
    ['shared role name', (v: SupplierFixture) => changeSupplierLanes(v, lanes => { lanes.supplier.binding.verifier.name = lanes.buyer.binding.verifier.name; })],
    ['shared role OID', (v: SupplierFixture) => changeSupplierLanes(v, lanes => { lanes.supplier.binding.verifier.oid = lanes.buyer.binding.verifier.oid; })],
    ['future binding', (v: SupplierFixture) => changeSupplierLanes(v, lanes => { lanes.buyer.binding.validFrom = new Date(workerSupplierNow + 1).toISOString(); })],
    ['expired binding', (v: SupplierFixture) => changeSupplierLanes(v, lanes => { lanes.buyer.binding.expiresAt = new Date(workerSupplierNow).toISOString(); })],
    ['revoked binding', (v: SupplierFixture) => changeSupplierLanes(v, lanes => { lanes.buyer.binding.status = 'REVOKED'; })],
    ['nondevelopment binding', (v: SupplierFixture) => changeSupplierLanes(v, lanes => { lanes.buyer.binding.environment = 'production'; })],
  ] as const)('rejects supplier %s', (_name, change) => {
    const data = supplierFixture(); change(data);
    expect(() => assertDevelopmentWorkerDeployment(data)).toThrow();
  });

  it('refuses aliases to each existing profile even when lane hashes and origin observations agree', () => {
    const original = supplierFixture();
    for (const resource of original.hyperdrives.slice(0, 8)) {
      const data = supplierFixture();
      changeSupplierLanes(data, lanes => { lanes.buyer.binding.verifier.name = resource.origin.user; });
      data.hyperdrives[8]!.origin.user = resource.origin.user;
      expect(() => assertDevelopmentWorkerDeployment(data)).toThrow();
    }
  });

  it('requires all four bindings and couples service, profile and encrypted inventory presence', () => {
    for (let index = 0; index < 4; index++) {
      const data = supplierFixture(); data.supplier.hyperdrive.splice(index, 1);
      expect(() => assertDevelopmentWorkerDeployment(data)).toThrow();
    }
    const data = supplierFixture();
    expect(() => assertDevelopmentWorkerDeployment({ ...data, supplier: undefined })).toThrow();
    expect(() => assertDevelopmentWorkerDeployment({ ...data, workerSecrets: { ...data.workerSecrets, supplier: undefined } })).toThrow();
    expect(() => assertDevelopmentWorkerDeployment({ ...data, workerSecrets: { ...data.workerSecrets, supplier: data.workerSecrets.supplier.map(secret => secret.name) } })).toThrow();
    expect(() => assertDevelopmentWorkerDeployment({ ...data, api: { ...data.api, services: data.api.services.slice(0, -1) } })).toThrow();
    expect(() => assertDevelopmentWorkerDeployment({ ...fixture(), workerSecrets: { ...fixture().workerSecrets, supplier: data.workerSecrets.supplier } })).toThrow();
  });

  it('rejects extra identity or raw-secret fields without disclosing private values', () => {
    const marker = 'PRIVATE_SUPPLIER_DEPLOYMENT_SENTINEL';
    const data = supplierFixture(), lanes = workerSupplierLanes();
    Object.assign(lanes.buyer, { verifierDatabaseUrl: marker });
    data.supplier.vars.SUPPLIER_RELATIONSHIP_LANES = JSON.stringify(lanes);
    const candidates = [data, { ...supplierFixture(), supplier: { ...data.supplier, vars: { ...data.supplier.vars, CLERK_SECRET_KEY: marker } } },
      { ...supplierFixture(), workerSecrets: { ...data.workerSecrets, supplier: [{ name: 'CLERK_SECRET_KEY', type: 'secret_text', value: marker }] } }];
    for (const candidate of candidates) {
      try { assertDevelopmentWorkerDeployment(candidate); expect.fail('Unsafe deployment accepted'); }
      catch (error) { expect(error).toBeInstanceOf(Error); expect(String(error)).not.toContain(marker); expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(marker); }
    }
  });

  it('keeps CLI success and rejection output generic, including malformed private lane values', () => {
    vi.useRealTimers();
    const data = supplierFixture(), now = Date.now(), lanes = workerSupplierLanes();
    for (const lane of Object.values(lanes)) {
      lane.binding.validFrom = new Date(now - 60_000).toISOString(); lane.binding.expiresAt = new Date(now + 60_000).toISOString();
      lane.binding = rehashWorkerSupplierBinding(lane.binding);
    }
    data.supplier.vars.SUPPLIER_RELATIONSHIP_LANES = JSON.stringify(lanes);
    const invoke = (input: string) => spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./check-worker-deployment.ts', import.meta.url))],
      { input, encoding: 'utf8', timeout: 10_000, maxBuffer: 65_536, env: { PATH: process.env.PATH } });
    const accepted = invoke(JSON.stringify(data));
    expect(accepted.status).toBe(0); expect(accepted.stdout.trim()).toBe('Development Worker deployment configuration passed.'); expect(accepted.stderr).toBe('');
    data.supplier.vars.SUPPLIER_RELATIONSHIP_LANES = 'PRIVATE_SUPPLIER_DEPLOYMENT_SENTINEL';
    const rejected = invoke(JSON.stringify(data));
    expect(rejected.status).toBe(1); expect(rejected.stdout).toBe(''); expect(rejected.stderr).not.toContain(data.supplier.vars.SUPPLIER_RELATIONSHIP_LANES);
    expect(rejected.stderr.trim()).toBe('Development Worker deployment configuration rejected; verify bindings, isolation, caching, TLS and development scope.');
  });
});
