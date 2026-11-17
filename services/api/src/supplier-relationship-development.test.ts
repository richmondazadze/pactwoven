import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DomainError, canonicalJson } from '@pactwoven/domain';
import { createDevelopmentSupplierRelationship } from './supplier-relationship-development.js';

function fixtureUrl(source: string, password: string): string {
  const url = new URL(source); url.password = password; return url.href;
}

const seams = vi.hoisted(() => ({ pools: [] as Array<{ configuration: unknown; connect: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }>,
  select: vi.fn(), service: vi.fn(), submitBuyer: vi.fn(), submitSupplier: vi.fn(), failPool: 0 }));
vi.mock('pg', () => ({ Pool: class {
  connect = vi.fn(); end = vi.fn(async () => {});
  constructor(public configuration: unknown) {
    if (seams.failPool === seams.pools.length + 1) throw new Error('PRIVATE_POOL_DIAGNOSTIC');
    seams.pools.push(this);
  }
  on() { return this; }
} }));
vi.mock('./auth.js', async importOriginal => ({ ...await importOriginal<typeof import('./auth.js')>(),
  createClerkIdentityObservationVerifier: vi.fn(() => seams.select),
}));
vi.mock('./supplier-relationship-service.js', () => ({ createSupplierRelationshipService: seams.service }));

const NOW = Date.parse('2026-11-16T12:00:00.000Z'), iso = (at: number) => new Date(at).toISOString();
const token = 'synthetic.development.token', issuer = 'https://pactwoven-test.clerk.accounts.dev';
const identity = () => ({ secretKey: 'sk_test_local_fixture', issuer, authorizedParties: ['http://localhost:3001'] });
const request = () => ({ kind: 'relationship-status' as const, query: { scope: { environment: 'development' as const,
  buyerOrganizationId: 'buyer', supplierOrganizationId: 'supplier', supplierRelationshipId: 'relationship' }, revision: null } });
function observation(party = 'buyer') {
  return { identity: { subject: `user_${party}`, externalOrganizationId: `org_${party}`, externalOrganizationName: party,
    externalMembershipId: `ext_${party}`, externalRole: 'org:admin', sessionId: `session_${party}`,
    authenticatedAt: iso(NOW - 3_600_000), membershipObservedAt: iso(NOW) },
  observation: { issuer, tokenHash: createHash('sha256').update(token).digest('hex'), tokenIssuedAt: iso(NOW - 5_000),
    observedAt: iso(NOW), expiresAt: iso(NOW + 60_000) } };
}
function configuration() {
  const lane = (party: string, offset: number) => {
    const original = { reference: { id: `binding_${party}`, version: 1 }, environment: 'development', effectiveOrganizationId: party,
      verifier: { oid: offset + 1, name: `supplier_${party}_verifier` }, authorizer: { oid: offset + 2, name: `supplier_${party}_authorizer` },
      status: 'ACTIVE', validFrom: iso(NOW - 3_600_000), expiresAt: iso(NOW + 3_600_000) };
    const binding = { ...original, reference: { ...original.reference,
      hash: createHash('sha256').update(canonicalJson({ namespace: 'pactwoven/supplier-private-binding/v1', binding: original })).digest('hex') } };
    return { externalOrganizationId: `org_${party}`, binding,
      verifierDatabaseUrl: fixtureUrl(`postgres://supplier_${party}_verifier@localhost/pactwoven_dev`, 'synthetic'),
      authorizerDatabaseUrl: fixtureUrl(`postgres://supplier_${party}_authorizer@localhost/pactwoven_dev`, 'synthetic') };
  };
  return { APP_ENVIRONMENT: 'development', DATABASE_URL: fixtureUrl('postgres://runtime@localhost/pactwoven_dev', 'synthetic'), CLERK_ISSUER: issuer,
    SUPPLIER_RELATIONSHIP_LANES: JSON.stringify({ buyer: lane('buyer', 100), supplier: lane('supplier', 200) }) };
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(NOW); seams.pools.length = 0; seams.failPool = 0;
  seams.select.mockReset().mockResolvedValue(observation());
  seams.submitBuyer.mockReset().mockResolvedValue({ kind: 'buyer_test_response' });
  seams.submitSupplier.mockReset().mockResolvedValue({ kind: 'supplier_test_response' });
  seams.service.mockReset().mockImplementation(({ observer }: { observer: { binding: { effectiveOrganizationId: string } } }) => ({
    submit: observer.binding.effectiveOrganizationId === 'buyer' ? seams.submitBuyer : seams.submitSupplier,
  }));
});
afterEach(() => vi.useRealTimers());

// Synthetic dependency seams test construction/dispatch/lifecycle only. The
// genuine service and signed-token paths have separate focused source coverage.
describe('supplier lazy development composition', () => {
  it('remains disabled with absent configuration without clients, pools or queries', async () => {
    expect(await createDevelopmentSupplierRelationship({}, identity())).toBeUndefined();
    expect(seams.pools).toHaveLength(0); expect(seams.service).not.toHaveBeenCalled(); expect(seams.select).not.toHaveBeenCalled();
  });
  it('creates four distinct lazy pools and two fixed private services without provider or database effects', async () => {
    const running = await createDevelopmentSupplierRelationship(configuration(), identity());
    expect(running).toBeDefined(); expect(seams.pools).toHaveLength(4); expect(seams.service).toHaveBeenCalledTimes(2);
    for (const pool of seams.pools) { expect(pool.connect).not.toHaveBeenCalled(); expect(pool.configuration).toMatchObject({ max: 1, connectionTimeoutMillis: 5000 }); }
    expect(seams.select).not.toHaveBeenCalled(); expect(seams.submitBuyer).not.toHaveBeenCalled();
    await running!.close();
  });
  it('selects the configured lane only from the genuine selector result and repeats final service verification', async () => {
    const running = (await createDevelopmentSupplierRelationship(configuration(), identity()))!;
    expect(await running.gateway.submit(token, request())).toEqual({ kind: 'buyer_test_response' });
    seams.select.mockResolvedValue(observation('supplier'));
    expect(await running.gateway.submit(token, request())).toEqual({ kind: 'supplier_test_response' });
    expect(seams.submitBuyer).toHaveBeenCalledExactlyOnceWith(token, request());
    expect(seams.submitSupplier).toHaveBeenCalledExactlyOnceWith(token, request());
    await running.close();
  });
  it('rejects a different configured pair and extra identity/binding data before selection', async () => {
    const running = (await createDevelopmentSupplierRelationship(configuration(), identity()))!;
    await expect(running.gateway.submit(token, { ...request(), query: { ...request().query, scope: { ...request().query.scope, supplierOrganizationId: 'foreign' } } }))
      .rejects.toMatchObject({ code: 'SUPPLIER_ACCESS_DENIED' });
    await expect(running.gateway.submit(token, { ...request(), actor: 'foreign' } as ReturnType<typeof request>)).rejects.toMatchObject({ code: 'SUPPLIER_INPUT_INVALID' });
    expect(seams.select).not.toHaveBeenCalled(); await running.close();
  });
  it.each(['hash', 'issuer', 'organization', 'expired'])('refuses substituted or stale selector %s without calling either private service', async mode => {
    const returned = observation();
    if (mode === 'hash') returned.observation.tokenHash = 'f'.repeat(64);
    if (mode === 'issuer') returned.observation.issuer = 'https://foreign.invalid';
    if (mode === 'organization') returned.identity.externalOrganizationId = 'foreign';
    if (mode === 'expired') { returned.identity.membershipObservedAt = iso(NOW - 20_001); returned.observation.observedAt = iso(NOW - 20_001); returned.observation.tokenIssuedAt = iso(NOW - 30_000); }
    seams.select.mockResolvedValue(returned);
    const running = (await createDevelopmentSupplierRelationship(configuration(), identity()))!;
    await expect(running.gateway.submit(token, request())).rejects.toMatchObject({ code: 'SUPPLIER_ACCESS_DENIED' });
    expect(seams.submitBuyer).not.toHaveBeenCalled(); expect(seams.submitSupplier).not.toHaveBeenCalled(); await running.close();
  });
  it('captures configuration and request input before selector awaits', async () => {
    const values = configuration(), auth = identity(), running = (await createDevelopmentSupplierRelationship(values, auth))!;
    let release!: (value: ReturnType<typeof observation>) => void;
    seams.select.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const input = request(), pending = running.gateway.submit(token, input);
    input.query.scope.supplierRelationshipId = 'changed'; values.SUPPLIER_RELATIONSHIP_LANES = '{}'; auth.issuer = 'https://changed.invalid';
    release(observation()); await pending;
    expect(seams.submitBuyer.mock.calls[0]?.[1].query.scope.supplierRelationshipId).toBe('relationship');
    expect(Object.isFrozen(seams.submitBuyer.mock.calls[0]?.[1])).toBe(true); await running.close();
  });
  it('closes every created pool on partial construction failure without returning secrets', async () => {
    seams.failPool = 4;
    await expect(createDevelopmentSupplierRelationship(configuration(), identity())).rejects.toThrow('Supplier development setup failed. Check the protected paired database and identity configuration.');
    expect(seams.pools).toHaveLength(3); for (const pool of seams.pools) expect(pool.end).toHaveBeenCalledOnce();
  });
  it('uses one idempotent close and refuses new or still-selecting submissions after shutdown', async () => {
    const running = (await createDevelopmentSupplierRelationship(configuration(), identity()))!;
    let release!: (value: ReturnType<typeof observation>) => void;
    seams.select.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = running.gateway.submit(token, request()), first = running.close(), second = running.close();
    expect(first).toBe(second); release(observation());
    await expect(pending).rejects.toMatchObject({ code: 'SETUP_REQUIRED' }); await first;
    await expect(running.gateway.submit(token, request())).rejects.toMatchObject({ code: 'SETUP_REQUIRED' });
    expect(seams.submitBuyer).not.toHaveBeenCalled(); for (const pool of seams.pools) expect(pool.end).toHaveBeenCalledOnce();
  });
  it('redacts selector failures and rejects production Clerk credentials before pool creation', async () => {
    await expect(createDevelopmentSupplierRelationship(configuration(), { ...identity(), secretKey: 'sk_live_forbidden' })).rejects.toMatchObject({ code: 'SETUP_REQUIRED' });
    expect(seams.pools).toHaveLength(0);
    const running = (await createDevelopmentSupplierRelationship(configuration(), identity()))!;
    seams.select.mockRejectedValue(new DomainError('IDENTITY_UNAVAILABLE', 503, 'PRIVATE_DIAGNOSTIC'));
    await expect(running.gateway.submit(token, request())).rejects.toMatchObject({ code: 'SUPPLIER_VERIFICATION_UNAVAILABLE', message: 'Supplier authentication is temporarily unavailable.' });
    await running.close();
  });
});
