import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DomainError } from '@pactwoven/domain';
import { supplierRelationshipHttpRoutes, type SupplierRelationshipHttpRequest } from '../../../packages/contracts/src/supplier-relationship-http.js';
import { handlePrivateSupplierRequest, serviceSupplierRelationshipGateway, supplierPrivateUrl } from './worker-supplier.js';
import { workerSupplierIssuer as issuer, workerSupplierNow as now, workerSupplierToken as token,
  workerSupplierPublicRequest, workerSupplierSample, workerSupplierResult } from './supplier-worker.test-fixtures.js';

const nonce = '72dd0a72-4d1e-4324-95a9-27585f2c736d';
function wire(input = workerSupplierSample()) {
  const original = workerSupplierPublicRequest(input);
  return { nonce, source: { url: original.url, method: original.method, key: original.headers.get('Idempotency-Key') }, request: input };
}
function privateRequest(body: unknown = wire(), url = supplierPrivateUrl, authorization = `Bearer ${token}`) {
  return new Request(url, { method: 'POST', headers: { Authorization: authorization, 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body) });
}
function fixture(input = workerSupplierSample()) {
  const submit = vi.fn(async (_token: string, value: SupplierRelationshipHttpRequest) => workerSupplierResult(value));
  const fetch = vi.fn((request: Request) => handlePrivateSupplierRequest(request, issuer, () => ({ submit })));
  return { submit, fetch, gateway: serviceSupplierRelationshipGateway({ fetch }, workerSupplierPublicRequest(input), issuer) };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
afterEach(() => vi.useRealTimers());

describe('supplier private service binding exchange', () => {
  it.each(Object.keys(supplierRelationshipHttpRoutes) as Array<keyof typeof supplierRelationshipHttpRoutes>)(
    'exchanges one exact %s operation and exposes only its public result', async kind => {
      const input = workerSupplierSample(kind), f = fixture(input);
      expect(await f.gateway.submit(token, input)).toEqual(await workerSupplierResult(input));
      expect(f.submit).toHaveBeenCalledExactlyOnceWith(token, input); expect(f.fetch).toHaveBeenCalledOnce();
      const request = f.fetch.mock.calls[0]![0];
      expect(request.url).toBe(supplierPrivateUrl); expect(request.redirect).toBe('manual');
      expect([...request.headers.keys()].sort()).toEqual(['authorization', 'content-type']);
      expect(Object.isFrozen(f.submit.mock.calls[0]![1])).toBe(true);
    });
  it('captures token, route, key and command before asynchronous exchange', async () => {
    const input = workerSupplierSample('relationship-command');
    if (input.kind !== 'relationship-command') throw new Error('fixture');
    const original = workerSupplierPublicRequest(input), submit = vi.fn(async (_t: string, value: SupplierRelationshipHttpRequest) => workerSupplierResult(value));
    let captured: unknown;
    const fetch = vi.fn(async (request: Request) => {
      captured = await request.clone().json(); return handlePrivateSupplierRequest(request, issuer, () => ({ submit }));
    });
    const gateway = serviceSupplierRelationshipGateway({ fetch }, original, issuer), expected = structuredClone(input);
    original.headers.set('Authorization', 'Bearer replaced.token'); original.headers.set('Idempotency-Key', 'replaced_key_123456');
    const pending = gateway.submit(token, input); input.mutation.idempotencyKey = 'changed_key_123456';
    await pending;
    expect(captured).toMatchObject({ request: expected, source: { key: expected.mutation.idempotencyKey } });
    expect(submit).toHaveBeenCalledExactlyOnceWith(token, expected);
  });
  it.each(['token', 'key', 'route', 'query', 'method', 'environment', 'privateField'])('refuses substituted outgoing %s before the private exchange', async mode => {
    const input = workerSupplierSample('relationship-command'), original = workerSupplierPublicRequest(input), fetch = vi.fn();
    let source = original, sentToken = token;
    if (mode === 'token') sentToken = 'foreign.token';
    if (mode === 'key') source.headers.set('Idempotency-Key', 'foreign_original_key_123');
    if (mode === 'route') source = new Request(original.url + '/', original);
    if (mode === 'query') source = new Request(original.url + '?actor=foreign', original);
    if (mode === 'method') source = new Request(original.url, { method: 'PUT', headers: original.headers });
    if (mode === 'environment' && input.kind === 'relationship-command') input.mutation.command.scope.environment = 'production';
    if (mode === 'privateField') Object.assign(input, { evidence: {} });
    await expect(serviceSupplierRelationshipGateway({ fetch }, source, issuer).submit(sentToken, input)).rejects.toMatchObject({
      code: mode === 'token' ? 'AUTH_REQUIRED' : 'SUPPLIER_OUTCOME_UNKNOWN',
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['nonce', 'tokenHash', 'requestHash', 'issuer', 'environment', 'timePast', 'timeFuture', 'privateField', 'dataKind', 'code', 'status', 'cache', 'contentType'])(
    'refuses an unbound or malformed private response %s', async mode => {
      const f = fixture(), input = workerSupplierSample();
      const fetch = vi.fn(async (request: Request) => {
        const response = await f.fetch(request), data = await response.json() as Record<string, any>;
        if (mode === 'nonce') data.nonce = crypto.randomUUID();
        if (mode === 'tokenHash' || mode === 'requestHash') data[mode] = 'f'.repeat(64);
        if (mode === 'issuer') data.issuer = 'https://other.clerk.accounts.dev';
        if (mode === 'environment') data.environment = 'production';
        if (mode === 'timePast') data.respondedAt = new Date(now - 20_001).toISOString();
        if (mode === 'timeFuture') data.respondedAt = new Date(now + 5001).toISOString();
        if (mode === 'privateField') data.outcome.evidence = { secret: 'PRIVATE_SENTINEL' };
        if (mode === 'dataKind') data.outcome.data.kind = 'policy-read';
        if (mode === 'code') data.outcome = { status: 'error', code: 'PRIVATE_CODE' };
        const headers = new Headers(response.headers);
        if (mode === 'cache') headers.set('Cache-Control', 'public');
        if (mode === 'contentType') headers.set('Content-Type', 'text/plain');
        return new Response(JSON.stringify(data), { status: mode === 'status' ? 201 : response.status, headers });
      });
      await expect(serviceSupplierRelationshipGateway({ fetch }, workerSupplierPublicRequest(input), issuer).submit(token, input))
        .rejects.toMatchObject({ code: 'SUPPLIER_OUTCOME_UNKNOWN' });
      expect(fetch).toHaveBeenCalledOnce(); expect(f.submit).toHaveBeenCalledOnce();
    });
  it('rejects a valid response belonging to another scope and a replayed response nonce', async () => {
    const input = workerSupplierSample('relationship-status'), f = fixture(input);
    const changed = await workerSupplierResult(input);
    if (changed.kind !== 'relationship-status') throw new Error('fixture');
    changed.projection.scope.supplierRelationshipId = 'different';
    f.submit.mockResolvedValue(changed);
    await expect(f.gateway.submit(token, input)).rejects.toMatchObject({ code: 'SUPPLIER_OUTCOME_UNKNOWN' });
    const healthy = fixture(), recovery = workerSupplierSample(); let saved: Response | undefined;
    const fetch = vi.fn(async (request: Request) => {
      if (!saved) saved = (await healthy.fetch(request)).clone(); return saved.clone();
    });
    const gateway = serviceSupplierRelationshipGateway({ fetch }, workerSupplierPublicRequest(recovery), issuer);
    await gateway.submit(token, recovery);
    await expect(gateway.submit(token, recovery)).rejects.toMatchObject({ code: 'SUPPLIER_OUTCOME_UNKNOWN' });
    expect(healthy.submit).toHaveBeenCalledOnce();
  });
  it('preserves only correlated safe domain errors and never trusts thrown service errors', async () => {
    const input = workerSupplierSample(), f = fixture();
    f.submit.mockRejectedValue(new DomainError('STEP_UP_REQUIRED', 403, 'PRIVATE_SENTINEL'));
    await expect(f.gateway.submit(token, input)).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED', status: 403,
      message: 'Fresh verification of both factors is required.' });
    f.submit.mockRejectedValue(new DomainError('STEP_UP_REQUIRED', 503, 'PRIVATE_SENTINEL'));
    await expect(f.gateway.submit(token, input)).rejects.toMatchObject({ code: 'SUPPLIER_OUTCOME_UNKNOWN' });
    const fetch = vi.fn(async () => { throw new DomainError('STEP_UP_REQUIRED', 403, 'PRIVATE_SENTINEL'); });
    await expect(serviceSupplierRelationshipGateway({ fetch }, workerSupplierPublicRequest(input), issuer).submit(token, input))
      .rejects.toMatchObject({ code: 'SUPPLIER_OUTCOME_UNKNOWN' });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each([301, 302, 307, 308])('never follows a %s redirect carrying the bearer or command', async status => {
    const cancel = vi.fn(), response = new Response(new ReadableStream({ cancel }), { status, headers: { Location: 'https://foreign.example' } });
    const fetch = vi.fn(async (request: Request) => { expect(request.redirect).toBe('manual'); return response; });
    await expect(serviceSupplierRelationshipGateway({ fetch }, workerSupplierPublicRequest(), issuer).submit(token, workerSupplierSample()))
      .rejects.toMatchObject({ code: 'SUPPLIER_OUTCOME_UNKNOWN' });
    expect(fetch).toHaveBeenCalledOnce(); expect(cancel).toHaveBeenCalledOnce();
  });
  it('bounds response streams and rejects stream exceptions without diagnostics', async () => {
    for (const response of [new Response(new Uint8Array(1024 * 1024 + 1)), new Response(new ReadableStream({ start(controller) {
      controller.error(new DomainError('STEP_UP_REQUIRED', 403, 'PRIVATE_SENTINEL'));
    } }))]) {
      const fetch = vi.fn(async () => response);
      await expect(serviceSupplierRelationshipGateway({ fetch }, workerSupplierPublicRequest(), issuer).submit(token, workerSupplierSample()))
        .rejects.toMatchObject({ code: 'SUPPLIER_OUTCOME_UNKNOWN' });
      expect(fetch).toHaveBeenCalledOnce();
    }
  });
  it('times out once, cancels a stalled response and leaves the original operation unconfirmed', async () => {
    let begin!: () => void; const begun = new Promise<void>(resolve => { begin = resolve; }), cancel = vi.fn();
    const fetch = vi.fn(async () => { begin(); return new Response(new ReadableStream({ cancel })); });
    const pending = serviceSupplierRelationshipGateway({ fetch }, workerSupplierPublicRequest(), issuer).submit(token, workerSupplierSample());
    const assertion = expect(pending).rejects.toMatchObject({ code: 'SUPPLIER_OUTCOME_UNKNOWN' });
    await begun; await vi.advanceTimersByTimeAsync(20_001); await assertion;
    expect(fetch).toHaveBeenCalledOnce(); expect(cancel).toHaveBeenCalledOnce();
  });
});

describe('supplier private intake', () => {
  it.each(['actor', 'evidence', 'approvers', 'handle', 'binding'])('refuses supplied private %s before constructing a gateway', async field => {
    const body = wire(); Object.assign(body.request, { [field]: {} });
    const factory = vi.fn();
    expect((await handlePrivateSupplierRequest(privateRequest(body), issuer, factory)).status).toBe(422);
    expect(factory).not.toHaveBeenCalled();
  });
  it('refuses duplicate decoded keys, route/key substitutions, query aliases and missing bearer', async () => {
    const body = wire(), factory = vi.fn();
    const malformed = [JSON.stringify(body).replace('"nonce":', `"nonce":"${nonce}","nonce":`),
      { ...body, source: { ...body.source, url: body.source.url + '?' } },
      { ...body, source: { ...body.source, key: 'foreign_original_key_123' } },
      { ...body, source: { ...body.source, method: 'GET' } }];
    for (const value of malformed) expect((await handlePrivateSupplierRequest(privateRequest(value), issuer, factory)).status).toBe(422);
    expect((await handlePrivateSupplierRequest(privateRequest(body, supplierPrivateUrl, 'Bearer '), issuer, factory)).status).toBe(401);
    expect((await handlePrivateSupplierRequest(privateRequest(body, supplierPrivateUrl + '/'), issuer, factory)).status).toBe(404);
    expect(factory).not.toHaveBeenCalled();
  });
});
