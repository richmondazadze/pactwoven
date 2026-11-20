import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '@pactwoven/domain';
import { readSupplierRelationshipDevelopmentConfig } from './supplier-relationship-config.js';

function fixtureUrl(source: string, password: string): string {
  const url = new URL(source); url.password = password; return url.href;
}

const now = '2026-11-16T12:00:00.000Z';
function lane(party: string, offset: number) {
  const binding = { reference: { id: `supplier_binding_${party}`, version: 1, hash: '' }, environment: 'development', effectiveOrganizationId: party,
    verifier: { oid: offset + 1, name: `supplier_${party}_verifier` }, authorizer: { oid: offset + 2, name: `supplier_${party}_authorizer` },
    status: 'ACTIVE', validFrom: '2026-11-16T11:00:00.000Z', expiresAt: '2026-11-16T13:00:00.000Z' };
  pin(binding);
  return { externalOrganizationId: `org_${party}`, binding,
    verifierDatabaseUrl: fixtureUrl(`postgres://supplier_${party}_verifier@localhost:5432/pactwoven_dev`, 'synthetic_password'),
    authorizerDatabaseUrl: fixtureUrl(`postgres://supplier_${party}_authorizer@localhost:5432/pactwoven_dev`, 'synthetic_password') };
}
function pin(binding: { reference: { id: string; version: number; hash: string } } & Record<string, unknown>) {
  const { reference: { hash: _hash, ...reference }, ...body } = binding;
  binding.reference.hash = createHash('sha256').update(canonicalJson({ namespace: 'pactwoven/supplier-private-binding/v1', binding: { ...body, reference } })).digest('hex');
}
function fixture() {
  const lanes = { buyer: lane('buyer', 100), supplier: lane('supplier', 200) };
  const values: Record<string, string | undefined> = { APP_ENVIRONMENT: 'development', DATABASE_URL: fixtureUrl('postgres://runtime@localhost:5432/pactwoven_dev', 'synthetic_password'),
    CLERK_ISSUER: 'https://pactwoven-test.clerk.accounts.dev', SUPPLIER_RELATIONSHIP_LANES: JSON.stringify(lanes) };
  return { lanes, values, read: () => readSupplierRelationshipDevelopmentConfig({ ...values, SUPPLIER_RELATIONSHIP_LANES: JSON.stringify(lanes) }, now) };
}

describe('supplier protected development configuration', () => {
  it('stays disabled with no supplier configuration and no side effects', () => {
    expect(readSupplierRelationshipDevelopmentConfig({}, now)).toBeUndefined();
    expect(readSupplierRelationshipDevelopmentConfig({ DATABASE_URL: 'irrelevant while disabled' }, now)).toBeUndefined();
  });
  it('captures exactly two organization lanes, four direct principals and their original pins', () => {
    const f = fixture(), result = f.read()!;
    expect(result.pair).toEqual({ environment: 'development', buyerOrganizationId: 'buyer', supplierOrganizationId: 'supplier' });
    expect(result.lanes).toEqual(f.lanes); expect(Object.isFrozen(result.lanes.buyer.binding.reference)).toBe(true);
    f.lanes.buyer.binding.expiresAt = '2027-01-01T00:00:00.000Z';
    expect(result.lanes.buyer.binding.expiresAt).toBe('2026-11-16T13:00:00.000Z');
  });
  it.each(['', '{}', '[]', '{"buyer":null}', 'not json'])('rejects partial or malformed configured input without logging its contents', raw => {
    const { values } = fixture(); values.SUPPLIER_RELATIONSHIP_LANES = raw;
    expect(() => readSupplierRelationshipDevelopmentConfig(values, now)).toThrow('Invalid supplier development configuration. Check the protected paired bindings.');
  });
  it.each(['actor', 'issuer', 'evidence', 'currentBinding'])('refuses unrecognized private configuration fields', field => {
    const { values, lanes } = fixture(); values.SUPPLIER_RELATIONSHIP_LANES = JSON.stringify({ ...lanes, [field]: 'PRIVATE' });
    expect(() => readSupplierRelationshipDevelopmentConfig(values, now)).toThrow();
  });
  it.each(['DATABASE_URL', 'PROVISIONER_DATABASE_URL', 'ACCESS_DATABASE_URL', 'MANDATE_DATABASE_URL',
    'CUSTODY_SETUP_WRITER_DATABASE_URL', 'CUSTODY_SETUP_VERIFIER_DATABASE_URL', 'FINANCIAL_POLICY_AUTHORIZER_DATABASE_URL', 'FINANCIAL_POLICY_VERIFIER_DATABASE_URL'])('refuses credential reuse with %s', reserved => {
    const f = fixture(); f.values[reserved] = f.lanes.buyer.verifierDatabaseUrl;
    expect(f.read).toThrow();
  });
  it('refuses shared names, OIDs, binding lineages, organizations and external organizations across lanes', () => {
    for (const change of [
      (f: ReturnType<typeof fixture>) => { f.lanes.supplier.binding.verifier.oid = f.lanes.buyer.binding.verifier.oid; },
      (f: ReturnType<typeof fixture>) => { f.lanes.supplier.binding.reference.id = f.lanes.buyer.binding.reference.id; },
      (f: ReturnType<typeof fixture>) => { f.lanes.supplier.binding.effectiveOrganizationId = 'buyer'; },
      (f: ReturnType<typeof fixture>) => { f.lanes.supplier.externalOrganizationId = 'org_buyer'; },
      (f: ReturnType<typeof fixture>) => { f.lanes.supplier.binding.verifier.name = f.lanes.buyer.binding.verifier.name; f.lanes.supplier.verifierDatabaseUrl = f.lanes.buyer.verifierDatabaseUrl; },
    ]) {
      const f = fixture(); change(f); pin(f.lanes.supplier.binding); expect(f.read).toThrow();
    }
  });
  it('refuses a wrong pin, stale binding, future binding and exact expiry', () => {
    const f = fixture(); f.lanes.buyer.binding.reference.hash = 'f'.repeat(64); expect(f.read).toThrow();
    for (const change of [
      { status: 'REVOKED' }, { validFrom: '2026-11-16T12:00:00.001Z' }, { expiresAt: now }, { environment: 'production' },
    ]) {
      const g = fixture(); Object.assign(g.lanes.buyer.binding, change); pin(g.lanes.buyer.binding); expect(g.read).toThrow();
    }
  });
  it.each([
    fixtureUrl('postgres://supplier_buyer_verifier@evil.example/pactwoven_dev', 'private'),
    fixtureUrl('postgres://supplier_buyer_verifier@localhost:5432/production', 'private'),
    fixtureUrl('postgres://supplier_buyer_verifier@localhost:5433/pactwoven_dev', 'private'),
    fixtureUrl('postgres://foreign@localhost:5432/pactwoven_dev', 'private'),
    'postgres://supplier_buyer_verifier@localhost:5432/pactwoven_dev',
    fixtureUrl('postgres://supplier_buyer_verifier@localhost:5432/pactwoven_dev?options=-c_role=admin', 'private'),
    fixtureUrl('postgres://supplier_buyer_verifier@localhost:5432/pactwoven_dev?sslmode=require', 'private'),
  ])('rejects an unsafe or mismatched database connection', url => {
    const f = fixture(); f.lanes.buyer.verifierDatabaseUrl = url; expect(f.read).toThrow();
  });
  it('accepts one exact Neon host with verified TLS while refusing relaxed TLS and duplicate selectors', () => {
    const f = fixture(), remote = (url: string) => url.replace('localhost:5432', 'ep-synthetic.us-east-2.aws.neon.tech') + '?sslmode=verify-full&channel_binding=require';
    f.values.DATABASE_URL = remote(f.values.DATABASE_URL!);
    for (const lane of Object.values(f.lanes)) { lane.verifierDatabaseUrl = remote(lane.verifierDatabaseUrl); lane.authorizerDatabaseUrl = remote(lane.authorizerDatabaseUrl); }
    expect(f.read()).toBeDefined();
    f.lanes.buyer.verifierDatabaseUrl += '&sslmode=verify-full'; expect(f.read).toThrow();
  });
  it('does not promote development configuration or accept another Clerk issuer', () => {
    const f = fixture(); f.values.APP_ENVIRONMENT = 'production'; expect(f.read).toThrow();
    f.values.APP_ENVIRONMENT = 'development';
    for (const issuer of ['https://identity.example.com', 'http://pactwoven-test.clerk.accounts.dev', 'https://pactwoven-test.clerk.accounts.dev/private']) {
      f.values.CLERK_ISSUER = issuer; expect(f.read).toThrow();
    }
  });
});
