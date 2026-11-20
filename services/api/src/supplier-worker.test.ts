import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DomainError } from '@pactwoven/domain';
import type { SupplierRelationshipHttpRequest } from '../../../packages/contracts/src/supplier-relationship-http.js';
import type { SupplierRelationshipServiceConfiguration } from './supplier-relationship-service.js';
import supplierWorker, { createSupplierWorkerRelationship } from './supplier-worker.js';
import { readSupplierWorkerConfig } from './supplier-worker-config.js';
import { serviceSupplierRelationshipGateway, supplierPrivateUrl } from './worker-supplier.js';
import { workerSupplierIssuer as issuer, workerSupplierNow as now, workerSupplierToken as token,
  workerSupplierBindings, workerSupplierObservation, workerSupplierPublicRequest, workerSupplierSample, workerSupplierResult } from './supplier-worker.test-fixtures.js';

const seams = vi.hoisted(() => ({ select: vi.fn(), service: vi.fn(), submissions: vi.fn(), originFailures: new Set<string>(),
  pools: [] as Array<{ configuration: { connectionString: string }; query: ReturnType<typeof vi.fn>; connect: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }>,
  failPool: 0, failEnd: false }));
vi.mock('pg', () => ({ Pool: class {
  query = vi.fn(async (_sql: string, parameters: string[]) => ({ rows: [{ database_matches: true,
    current_matches: !seams.originFailures.has(parameters[1]!), session_matches: true }] }));
  connect = vi.fn(async () => ({ query: vi.fn(), release: vi.fn() }));
  end = vi.fn(async () => { if (seams.failEnd) throw new Error('PRIVATE_END_DETAIL'); });
  constructor(public configuration: { connectionString: string }) {
    if (seams.failPool === seams.pools.length + 1) throw new Error('PRIVATE_POOL_DETAIL');
    seams.pools.push(this);
  }
  on() { return this; }
} }));
vi.mock('./auth.js', async importOriginal => ({ ...await importOriginal<typeof import('./auth.js')>(),
  createClerkIdentityObservationVerifier: vi.fn(() => seams.select),
}));
vi.mock('./supplier-relationship-service.js', () => ({ createSupplierRelationshipService: seams.service }));
function context() {
  const pending: Promise<unknown>[] = [];
  return { waitUntil: vi.fn((promise: Promise<unknown>) => { pending.push(promise); }), done: () => Promise.all(pending) };
}
async function roundtrip(input = workerSupplierSample()) {
  const ctx = context(), bindings = workerSupplierBindings();
  const fetch = vi.fn((request: Request) => supplierWorker.fetch(request, bindings, ctx));
  const gateway = serviceSupplierRelationshipGateway({ fetch }, workerSupplierPublicRequest(input), issuer);
  return { ctx, fetch, gateway, input };
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(now); seams.pools.length = 0; seams.failPool = 0; seams.failEnd = false; seams.originFailures.clear();
  seams.select.mockReset().mockResolvedValue(workerSupplierObservation()); seams.submissions.mockReset();
  seams.service.mockReset().mockImplementation((config: SupplierRelationshipServiceConfiguration) => ({
    submit: async (bearer: string, input: SupplierRelationshipHttpRequest) => {
      seams.submissions(bearer, input, config);
      for (const pool of [config.verifierPool, config.authorizerPool]) {
        const client = await pool.connect(); client.release();
      }
      return workerSupplierResult(input);
    },
  }));
});
afterEach(() => vi.useRealTimers());

// Mocked provider/private-service seams test Worker composition and actual
// pool admission, not real Clerk signatures, SQL semantics or provider hosting.
describe('supplier private Worker composition', () => {
  it.each(['buyer', 'supplier'] as const)('selects the signed %s lane, checks its two origin principals and closes both pools', async party => {
    seams.select.mockResolvedValue(workerSupplierObservation(party));
    const f = await roundtrip();
    expect(await f.gateway.submit(token, f.input)).toEqual(await workerSupplierResult(f.input)); await f.ctx.done();
    expect(seams.select).toHaveBeenCalledExactlyOnceWith(token); expect(seams.service).toHaveBeenCalledOnce();
    expect(seams.submissions).toHaveBeenCalledExactlyOnceWith(token, f.input, expect.objectContaining({
      observer: expect.objectContaining({ binding: expect.objectContaining({ effectiveOrganizationId: party }) }),
    }));
    expect(seams.pools).toHaveLength(2); expect(f.ctx.waitUntil).toHaveBeenCalledOnce();
    for (const [index, capability] of ['verifier', 'authorizer'].entries()) {
      const pool = seams.pools[index]!;
      expect(pool.configuration).toMatchObject({ max: 1, connectionTimeoutMillis: 5000 });
      expect(pool.configuration.connectionString).toContain(`proxy-${party}-${capability}.local`);
      expect(pool.query).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('current_user'), ['pactwoven_dev', `pactwoven_dev_supplier_${party}_${capability}`]);
      expect(pool.connect).toHaveBeenCalledOnce(); expect(pool.end).toHaveBeenCalledOnce();
    }
    const config = seams.service.mock.calls[0]![0] as SupplierRelationshipServiceConfiguration;
    expect(config.verifierPool).not.toBe(config.authorizerPool);
  });
  it('does not construct pools or private services until the selected identity is confirmed', async () => {
    let release!: (value: ReturnType<typeof workerSupplierObservation>) => void;
    seams.select.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const running = createSupplierWorkerRelationship(readSupplierWorkerConfig(workerSupplierBindings()));
    expect(seams.pools).toHaveLength(0); expect(seams.service).not.toHaveBeenCalled();
    const pending = running.gateway.submit(token, workerSupplierSample());
    expect(seams.pools).toHaveLength(0); expect(seams.service).not.toHaveBeenCalled();
    release(workerSupplierObservation()); await pending; await running.close();
    expect(seams.pools).toHaveLength(2);
  });
  it.each(['token', 'issuer', 'organization', 'expired'])('refuses a misbound selector %s without opening database connections', async mode => {
    const observation = workerSupplierObservation();
    if (mode === 'token') observation.observation.tokenHash = 'f'.repeat(64);
    if (mode === 'issuer') observation.observation.issuer = 'https://foreign.clerk.accounts.dev';
    if (mode === 'organization') observation.identity.externalOrganizationId = 'org_foreign';
    if (mode === 'expired') observation.observation.expiresAt = new Date(now - 1).toISOString();
    seams.select.mockResolvedValue(observation);
    const f = await roundtrip();
    await expect(f.gateway.submit(token, f.input)).rejects.toMatchObject({ code: 'SUPPLIER_ACCESS_DENIED' }); await f.ctx.done();
    expect(seams.service).not.toHaveBeenCalled(); expect(seams.pools).toHaveLength(0);
  });
  it('rejects another pair before signed identity selection', async () => {
    const input = workerSupplierSample(); if (input.kind !== 'relationship-recover') throw new Error('fixture');
    input.query.identity.scope.supplierOrganizationId = 'foreign';
    const f = await roundtrip(input);
    await expect(f.gateway.submit(token, input)).rejects.toMatchObject({ code: 'SUPPLIER_ACCESS_DENIED' }); await f.ctx.done();
    expect(seams.select).not.toHaveBeenCalled(); expect(seams.pools).toHaveLength(0);
  });
  it('refuses a misbound origin principal before its client is used and closes successful and rejected pools', async () => {
    seams.originFailures.add('pactwoven_dev_supplier_buyer_authorizer'); const f = await roundtrip();
    await expect(f.gateway.submit(token, f.input)).rejects.toMatchObject({ code: 'SUPPLIER_OUTCOME_UNKNOWN' }); await f.ctx.done();
    expect(seams.pools).toHaveLength(2); expect(seams.pools[1]!.connect).not.toHaveBeenCalled();
    for (const pool of seams.pools) expect(pool.end).toHaveBeenCalledOnce();
    expect(seams.submissions).toHaveBeenCalledOnce();
  });
  it('cleans a partially opened lane and redacts connection construction failure', async () => {
    seams.failPool = 2; const f = await roundtrip();
    await expect(f.gateway.submit(token, f.input)).rejects.toMatchObject({ code: 'SUPPLIER_OUTCOME_UNKNOWN' }); await f.ctx.done();
    expect(seams.pools).toHaveLength(1); expect(seams.pools[0]!.end).toHaveBeenCalledOnce();
  });
  it('keeps an acknowledged result when cleanup fails and never shares pools between invocations', async () => {
    seams.failEnd = true;
    for (let index = 0; index < 2; index++) {
      const f = await roundtrip(); expect(await f.gateway.submit(token, f.input)).toEqual(await workerSupplierResult(f.input)); await f.ctx.done();
    }
    expect(seams.pools).toHaveLength(4); for (const pool of seams.pools) expect(pool.end).toHaveBeenCalledOnce();
  });
  it('closes idempotently and blocks selected-but-not-dispatched work after shutdown', async () => {
    let release!: (value: ReturnType<typeof workerSupplierObservation>) => void;
    seams.select.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const running = createSupplierWorkerRelationship(readSupplierWorkerConfig(workerSupplierBindings()));
    const pending = running.gateway.submit(token, workerSupplierSample()), first = running.close();
    expect(running.close()).toBe(first); release(workerSupplierObservation());
    await expect(pending).rejects.toMatchObject({ code: 'SETUP_REQUIRED' }); await first;
    await expect(running.gateway.submit(token, workerSupplierSample())).rejects.toMatchObject({ code: 'SETUP_REQUIRED' });
    expect(seams.service).not.toHaveBeenCalled(); expect(seams.pools).toHaveLength(0);
  });
  it('keeps lost acknowledgement unknown without resubmitting the private operation', async () => {
    const ctx = context(), fetch = vi.fn(async (request: Request) => {
      await supplierWorker.fetch(request, workerSupplierBindings(), ctx); throw new Error('PRIVATE_ACK_LOSS');
    });
    await expect(serviceSupplierRelationshipGateway({ fetch }, workerSupplierPublicRequest(), issuer).submit(token, workerSupplierSample()))
      .rejects.toMatchObject({ code: 'SUPPLIER_OUTCOME_UNKNOWN' }); await ctx.done();
    expect(fetch).toHaveBeenCalledOnce(); expect(seams.submissions).toHaveBeenCalledOnce();
    for (const pool of seams.pools) expect(pool.end).toHaveBeenCalledOnce();
  });
  it('refuses invalid route, configuration, bearer and private body before composition', async () => {
    const ctx = context(), valid = workerSupplierBindings();
    expect((await supplierWorker.fetch(new Request(supplierPrivateUrl + '/'), valid, ctx)).status).toBe(404);
    const request = () => new Request(supplierPrivateUrl, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' });
    const configResponse = await supplierWorker.fetch(request(), { ...valid, DATABASE_URL: 'PRIVATE_SENTINEL' }, ctx);
    expect(configResponse.status).toBe(503); expect(await configResponse.text()).not.toContain('PRIVATE_SENTINEL');
    expect((await supplierWorker.fetch(new Request(supplierPrivateUrl, { method: 'POST' }), valid, ctx)).status).toBe(401);
    expect((await supplierWorker.fetch(request(), valid, ctx)).status).toBe(422);
    expect(seams.select).not.toHaveBeenCalled(); expect(seams.service).not.toHaveBeenCalled(); expect(seams.pools).toHaveLength(0);
    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });
  it('redacts provider failures before any pool opens', async () => {
    seams.select.mockRejectedValue(new DomainError('IDENTITY_UNAVAILABLE', 503, 'PRIVATE_PROVIDER_DETAIL')); const f = await roundtrip();
    await expect(f.gateway.submit(token, f.input)).rejects.toMatchObject({ code: 'SUPPLIER_VERIFICATION_UNAVAILABLE',
      message: 'Supplier authentication is temporarily unavailable.' }); await f.ctx.done();
    expect(seams.pools).toHaveLength(0);
  });
});
