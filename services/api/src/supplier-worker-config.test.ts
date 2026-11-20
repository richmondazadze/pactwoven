import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkerConfigurationError, type HyperdriveBinding } from './worker-config.js';
import { readSupplierWorkerConfig, supplierWorkerDatabaseBindings } from './supplier-worker-config.js';
import { rehashWorkerSupplierBinding, workerSupplierBindings, workerSupplierLanes, workerSupplierNow } from './supplier-worker.test-fixtures.js';

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(workerSupplierNow); });
afterEach(() => vi.useRealTimers());
describe('private supplier Worker configuration', () => {
  it('accepts four opaque proxy connections separately from the exact origin names and OIDs', () => {
    const config = readSupplierWorkerConfig(workerSupplierBindings());
    expect(config.environment).toBe('development'); expect(config.lanes).toEqual(workerSupplierLanes());
    expect(config.connectionStrings.buyer.verifier).toContain('opaque_proxy_user');
    expect(config.lanes.buyer.binding.verifier.name).toBe('pactwoven_dev_supplier_buyer_verifier');
    expect(Object.isFrozen(config.lanes.buyer.binding)).toBe(true);
  });
  it.each([
    { APP_ENVIRONMENT: 'production' }, { WORKER_ROLE: 'api' }, { CLERK_SECRET_KEY: 'sk_live_forbidden' },
    { CLERK_ISSUER: 'https://other.clerk.accounts.dev' }, { CLERK_ISSUER: 'https://issuer.example' },
    { ALLOWED_ORIGINS: '*' }, { ALLOWED_ORIGINS: 'https://ui.example/path' },
    { ALLOWED_ORIGINS: 'https://ui.example,https://ui.example' }, { ALLOWED_ORIGINS: 'http://public.example' },
    { SUPPLIER_RELATIONSHIP_LANES: '{}' },
  ])('rejects invalid environment, identity or lane configuration %#', changed => {
    expect(() => readSupplierWorkerConfig({ ...workerSupplierBindings(), ...changed })).toThrow(WorkerConfigurationError);
  });
  it.each(['DATABASE', 'DATABASE_URL', 'PROVISIONER_DATABASE_URL', 'ACCESS_DATABASE', 'MANDATE_DATABASE',
    'CUSTODY_SETUP_WRITER_DATABASE_URL', 'FINANCIAL_POLICY_AUTHORIZER_DATABASE_URL', 'IDENTITY_PROVISIONER',
    'SUPPLIER_AUTHORITY', 'UNRECOGNIZED_CAPABILITY'])('rejects unrelated capability %s, including empty values', field => {
    expect(() => readSupplierWorkerConfig({ ...workerSupplierBindings(), [field]: '' })).toThrow(WorkerConfigurationError);
  });
  it.each(Object.values(supplierWorkerDatabaseBindings).flatMap(lane => Object.values(lane)))('requires %s', field => {
    const values = workerSupplierBindings(); delete values[field];
    expect(() => readSupplierWorkerConfig(values)).toThrow(WorkerConfigurationError);
  });
  it('rejects shared connections and mismatched transport metadata', () => {
    const values = workerSupplierBindings(), original = values.SUPPLIER_BUYER_VERIFIER_DATABASE as HyperdriveBinding;
    expect(() => readSupplierWorkerConfig({ ...values, SUPPLIER_BUYER_AUTHORIZER_DATABASE: original })).toThrow(WorkerConfigurationError);
    for (const changed of [{ host: 'other' }, { database: 'other' }, { user: 'other' }, { port: 1234 },
      { connectionString: original.connectionString + '?user=administrator' }]) {
      expect(() => readSupplierWorkerConfig({ ...values, SUPPLIER_BUYER_VERIFIER_DATABASE: { ...original, ...changed } })).toThrow(WorkerConfigurationError);
    }
  });
  it.each(['externalOrganization', 'effectiveOrganization', 'bindingId', 'name', 'oid', 'hash', 'expired', 'future', 'inactive', 'production'])(
    'refuses incorrect or shared lane %s', mode => {
      const lanes = workerSupplierLanes();
      if (mode === 'externalOrganization') lanes.supplier.externalOrganizationId = lanes.buyer.externalOrganizationId;
      if (mode === 'effectiveOrganization') lanes.supplier.binding.effectiveOrganizationId = lanes.buyer.binding.effectiveOrganizationId;
      if (mode === 'bindingId') lanes.supplier.binding.reference.id = lanes.buyer.binding.reference.id;
      if (mode === 'name') lanes.supplier.binding.verifier.name = lanes.buyer.binding.verifier.name;
      if (mode === 'oid') lanes.supplier.binding.verifier.oid = lanes.buyer.binding.verifier.oid;
      if (mode === 'expired') lanes.supplier.binding.expiresAt = new Date(workerSupplierNow).toISOString();
      if (mode === 'future') lanes.supplier.binding.validFrom = new Date(workerSupplierNow + 1000).toISOString();
      if (mode === 'inactive') lanes.supplier.binding.status = 'REVOKED';
      if (mode === 'production') lanes.supplier.binding.environment = 'production';
      lanes.supplier.binding = rehashWorkerSupplierBinding(lanes.supplier.binding);
      if (mode === 'hash') lanes.supplier.binding.reference.hash = 'f'.repeat(64);
      expect(() => readSupplierWorkerConfig({ ...workerSupplierBindings(), SUPPLIER_RELATIONSHIP_LANES: JSON.stringify(lanes) })).toThrow(WorkerConfigurationError);
    });
  it('rejects local raw-DSN lane shape and never includes configuration in errors', () => {
    const lanes = workerSupplierLanes(), secret = 'PRIVATE_SENTINEL';
    Object.assign(lanes.buyer, { verifierDatabaseUrl: secret });
    let failure: unknown;
    try { readSupplierWorkerConfig({ ...workerSupplierBindings(), SUPPLIER_RELATIONSHIP_LANES: JSON.stringify(lanes) }); }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(WorkerConfigurationError); expect(String(failure)).not.toContain(secret);
  });
});
