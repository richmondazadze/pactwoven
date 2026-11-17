import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DomainError, commandDigest, supplierScopeCategoryDigest, supplierScopePolicyCommandDigest } from '@pactwoven/domain';
import {
  SupplierRelationshipHttpRequestSchema, supplierRelationshipHttpRoutes, supplierRelationshipHttpBodyLimits,
  type SupplierRelationshipHttpGateway, type SupplierRelationshipHttpRequest,
} from '../../../packages/contracts/src/supplier-relationship-http.js';
import { readSupplierRelationshipJson, registerSupplierRelationshipRoutes, validateSupplierRelationshipHttpResponse } from './supplier-relationship-routes.js';
import type { ApiEnv } from './app.js';

// Synthetic gateway tests cover HTTP framing/correlation, not Clerk, SQL or deployment acceptance.
const NOW = Date.parse('2026-11-16T12:00:00.000Z'), H = 'a'.repeat(64), key = 'supplier_original_key_123', token = 'synthetic.supplier.token';
const iso = (at: number) => new Date(at).toISOString();
const pair = { environment: 'simulation' as const, buyerOrganizationId: 'buyer', supplierOrganizationId: 'supplier' };
const scope = { ...pair, supplierRelationshipId: 'relationship' };
const reference = { pair, version: 1, hash: H };
const command = () => ({ scope, expectedVersion: 0, mandateVersion: null, authorityEpoch: 0, targetProposal: null,
  payload: { action: 'create', terms: { buyerSiteIds: ['site'], serviceCategoryIds: ['delivery'], expiresAt: iso(NOW + 60_000) } } });
const policyCommand = () => ({ pair, expectedVersion: 0, predecessor: null, buyerOrganizationVersion: 1, authorityEpoch: 0,
  payload: { action: 'issue', terms: { buyerSiteIds: ['site'], categories: [{ id: 'delivery', label: 'Delivery', definition: 'Transport sealed goods.' }], requestedValidityMs: 60_000 } } });
const head = () => ({ scope, revision: 1, proposal: { id: 'relationship', version: 1, hash: H }, status: 'PROPOSED' });
const baseHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const commandHeaders = { ...baseHeaders, 'Idempotency-Key': key };
const encoded = (text: string) => new TextEncoder().encode(text);
function request(body: string | Uint8Array | ReadableStream<Uint8Array>, options: {
  path?: string; headers?: Record<string, string>; signal?: AbortSignal;
} = {}) {
  return new Request(`http://localhost${options.path ?? supplierRelationshipHttpRoutes['relationship-command']}`, {
    method: 'POST', body, duplex: 'half', headers: options.headers ?? commandHeaders, ...(options.signal ? { signal: options.signal } : {}),
  } as RequestInit);
}
function stream(chunks: Uint8Array[]) {
  return new ReadableStream<Uint8Array>({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } });
}
async function receipt(input: Extract<SupplierRelationshipHttpRequest, { kind: 'relationship-command' }>) {
  const identity = { scope: input.mutation.command.scope, organizationId: 'buyer', actorId: 'actor', idempotencyKey: input.mutation.idempotencyKey };
  return { identity, commandDigest: await commandDigest({ namespace: 'pactwoven/supplier-relationship-command/v1', identity, command: input.mutation.command }),
    result: head(), recordedAt: iso(NOW - 1_000) };
}
async function response(input: SupplierRelationshipHttpRequest): Promise<unknown> {
  switch (input.kind) {
    case 'relationship-status': return { kind: input.kind, projection: { ...head(), revision: input.query.revision ?? 1,
      kind: 'RELATIONSHIP_STATUS_ONLY', expiresAt: iso(NOW + 60_000), viewerParty: 'buyer', current: true,
      approvalsRecorded: { buyer: false, supplier: false }, relationshipGate: 'BLOCKED', gateReason: 'NOT_ACTIVE',
      authentication: 'NOT_ESTABLISHED', businessVerification: 'NOT_ESTABLISHED', payeeVerification: 'NOT_ESTABLISHED',
      bookingAuthority: false, contractualAcceptance: false, paymentAuthority: false } };
    case 'relationship-command': return { kind: input.kind, outcome: 'APPENDED', receipt: await receipt(input), currentHead: head() };
    case 'relationship-recover': return { kind: input.kind, original: null };
    case 'policy-read': {
      const category = { id: 'delivery', label: 'Delivery', definition: 'Transport sealed goods.' };
      return { kind: input.kind, policy: { reference: input.query.policy, predecessor: null, status: 'ACTIVE', buyerSiteIds: ['site'],
        categories: [{ ...category, definitionHash: await supplierScopeCategoryDigest(pair, category) }],
        issuedAt: iso(NOW - 1_000), validFrom: iso(NOW - 1_000), expiresAt: iso(NOW + 59_000) } };
    }
    case 'policy-command': return { kind: input.kind, outcome: 'APPENDED', receipt: {
      identity: { pair, organizationId: 'buyer', actorId: 'actor', idempotencyKey: input.mutation.idempotencyKey },
      commandDigest: await supplierScopePolicyCommandDigest(input.mutation, 'actor'), result: reference, recordedAt: iso(NOW - 1_000),
    }, current: reference };
  }
}
function fixture(configured = true) {
  const gateway = { submit: vi.fn(async (_bearer: string, input: SupplierRelationshipHttpRequest): Promise<unknown> => response(input)) };
  const app = new Hono<ApiEnv>(); app.use('*', async (c, next) => { c.set('correlationId', 'supplier_correlation'); await next(); });
  registerSupplierRelationshipRoutes(app, configured ? gateway as unknown as SupplierRelationshipHttpGateway : undefined);
  const generic = vi.fn(); app.use('*', async (_c, next) => { generic(); await next(); });
  return { app, gateway, generic };
}
function secure(result: Response) {
  expect(result.headers.get('cache-control')).toBe('private, no-store');
  expect(result.headers.get('referrer-policy')).toBe('no-referrer');
  expect(result.headers.get('x-content-type-options')).toBe('nosniff');
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => vi.useRealTimers());

describe('supplier exact HTTP operation routes', () => {
  it('dispatches all five routes with captured kind, key and bounded business input', async () => {
    const f = fixture(), identity = { scope, organizationId: 'buyer', actorId: 'actor', idempotencyKey: key };
    const samples = [
      { kind: 'relationship-status', body: { scope, revision: null }, headers: baseHeaders },
      { kind: 'relationship-command', body: command(), headers: commandHeaders },
      { kind: 'relationship-recover', body: { identity, commandDigest: H, action: 'create' }, headers: baseHeaders },
      { kind: 'policy-read', body: { policy: reference }, headers: baseHeaders },
      { kind: 'policy-command', body: policyCommand(), headers: commandHeaders },
    ] as const;
    for (const sample of samples) {
      const result = await f.app.fetch(request(JSON.stringify(sample.body), { path: supplierRelationshipHttpRoutes[sample.kind], headers: sample.headers }));
      expect(result.status).toBe(200); secure(result);
      const call = f.gateway.submit.mock.calls.at(-1)!;
      expect(call[0]).toBe(token); expect(call[1].kind).toBe(sample.kind); expect(Object.isFrozen(call[1])).toBe(true);
      expect(call[1]).not.toHaveProperty('purpose'); expect(call[1]).not.toHaveProperty('actor');
      if ('mutation' in call[1]) expect(call[1].mutation).toEqual({ idempotencyKey: key, command: sample.body });
      else expect(call[1].query).toEqual(sample.body);
      expect((await result.json()).kind).toBe(sample.kind);
    }
    expect(f.gateway.submit).toHaveBeenCalledTimes(5); expect(f.generic).not.toHaveBeenCalled();
    expect(f.app.routes.filter(route => !route.path.includes('*'))).toHaveLength(5);
  });

  it.each(['GET', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])('refuses %s before reading a body or invoking the service', async method => {
    const f = fixture(), result = await f.app.request(supplierRelationshipHttpRoutes['relationship-command'], { method, headers: commandHeaders });
    expect(result.status).toBe(404); secure(result); expect(f.gateway.submit).not.toHaveBeenCalled(); expect(f.generic).not.toHaveBeenCalled();
  });

  it.each([
    '/v1/supplier-relationships/commands?actor=foreign', '/v1/supplier-relationships/commands?', '/v1/supplier-relationships/commands#private',
    '/v1/supplier-relationships/commands/', '/v1/supplier-relationships/%63ommands', '/v1/%73upplier-relationships/commands',
    '/v1/supplier-relationships/observation-plan', '/v1/supplier-scope-policies/unknown',
  ])('refuses a noncanonical supplier target %s', async path => {
    const f = fixture(), result = await f.app.fetch(request(JSON.stringify(command()), { path }));
    expect(result.status).toBe(422); secure(result); expect(f.gateway.submit).not.toHaveBeenCalled(); expect(f.generic).not.toHaveBeenCalled();
  });

  it('leaves unrelated routes to the existing middleware', async () => {
    const f = fixture(), result = await f.app.request('/health');
    expect(result.status).toBe(404); expect(f.generic).toHaveBeenCalledOnce(); expect(f.gateway.submit).not.toHaveBeenCalled();
  });

  it.each(['identity', 'actor', 'binding', 'purpose', 'evidence', 'approvers', 'handle', 'idempotencyKey'])('rejects private or duplicate-key %s input before service work', async field => {
    const f = fixture(), result = await f.app.fetch(request(JSON.stringify({ ...command(), [field]: field === 'idempotencyKey' ? key : {} })));
    expect(result.status).toBe(422); secure(result); expect(f.gateway.submit).not.toHaveBeenCalled();
  });

  it('uses only one exact header key and rejects a key header on read/recovery calls', async () => {
    const f = fixture();
    for (const value of ['', 'short', `${key},${key}`, ` ${key} x`]) {
      expect((await f.app.fetch(request(JSON.stringify(command()), { headers: { ...commandHeaders, 'Idempotency-Key': value } }))).status).toBe(422);
    }
    expect((await f.app.fetch(request(JSON.stringify(command()), { headers: baseHeaders }))).status).toBe(422);
    expect((await f.app.fetch(request(JSON.stringify({ scope, revision: null }), { path: supplierRelationshipHttpRoutes['relationship-status'] }))).status).toBe(422);
    expect(f.gateway.submit).not.toHaveBeenCalled();
  });

  it.each(['', 'Bearer ', 'Basic private', `Bearer ${token},${token}`, `Bearer ${'a'.repeat(8193)}`])('requires one bounded bearer header', async authorization => {
    const f = fixture(), result = await f.app.fetch(request(JSON.stringify(command()), { headers: { ...commandHeaders, Authorization: authorization } }));
    expect(result.status).toBe(401); secure(result); expect(f.gateway.submit).not.toHaveBeenCalled();
  });

  it('stays unavailable when the private service has not been configured', async () => {
    const f = fixture(false), result = await f.app.fetch(request(JSON.stringify(command())));
    expect(result.status).toBe(503); secure(result);
    expect((await result.json()).error.code).toBe('SETUP_REQUIRED'); expect(f.generic).not.toHaveBeenCalled();
  });

  it.each([
    new Error('PRIVATE_PROVIDER_DIAGNOSTIC'),
    new DomainError('UNRECOGNIZED_PRIVATE_CODE', 503, 'PRIVATE_PROVIDER_DIAGNOSTIC'),
    new DomainError('SUPPLIER_ACCESS_DENIED', 403, 'PRIVATE_PROVIDER_DIAGNOSTIC', { secret: ['PRIVATE_FIELD'] }),
  ])('redacts every private service error and never retries', async error => {
    const f = fixture(); f.gateway.submit.mockRejectedValue(error);
    const result = await f.app.fetch(request(JSON.stringify(command()))), text = await result.text();
    secure(result); expect([403, 503]).toContain(result.status);
    expect(text).not.toContain('PRIVATE_'); expect(text).not.toContain('fields'); expect(text).toContain('supplier_correlation');
    expect(f.gateway.submit).toHaveBeenCalledOnce();
  });

  it('rejects unknown/private fields in a response rather than stripping them into success', async () => {
    const f = fixture(); f.gateway.submit.mockImplementation(async (_token, input) => ({ ...await response(input) as object, binding: { secret: 'PRIVATE' } }));
    const result = await f.app.fetch(request(JSON.stringify(command())));
    expect(result.status).toBe(503); expect((await result.json()).error.code).toBe('SUPPLIER_OUTCOME_UNKNOWN');
  });

  it('rejects a substituted command digest/key/scope/result after a potentially durable call', async () => {
    const input = SupplierRelationshipHttpRequestSchema.parse({ kind: 'relationship-command', mutation: { idempotencyKey: key, command: command() } });
    if (input.kind !== 'relationship-command') throw new Error('Fixture kind');
    const original = { kind: input.kind, outcome: 'APPENDED', receipt: await receipt(input), currentHead: head() };
    for (const changed of [
      { ...original, receipt: { ...original.receipt, commandDigest: 'f'.repeat(64) } },
      { ...original, receipt: { ...original.receipt, identity: { ...original.receipt.identity, idempotencyKey: 'substituted_original_key' } } },
      { ...original, receipt: { ...original.receipt, identity: { ...original.receipt.identity, scope: { ...scope, supplierRelationshipId: 'foreign' } } } },
      { ...original, receipt: { ...original.receipt, recordedAt: iso(NOW + 1) } },
    ]) await expect(validateSupplierRelationshipHttpResponse(input, changed)).rejects.toMatchObject({ code: 'SUPPLIER_OUTCOME_UNKNOWN' });
  });

  it('preserves a checked original receipt across a newer head and during explicit recovery', async () => {
    const input = SupplierRelationshipHttpRequestSchema.parse({ kind: 'relationship-command', mutation: { idempotencyKey: key, command: command() } });
    if (input.kind !== 'relationship-command') throw new Error('Fixture kind');
    const original = await receipt(input), currentHead = { ...head(), revision: 2, status: 'SUSPENDED' };
    const replay = { kind: input.kind, outcome: 'EXACT_REPLAY', receipt: original, currentHead };
    expect(await validateSupplierRelationshipHttpResponse(input, replay)).toEqual(replay);
    const query = { identity: original.identity, commandDigest: original.commandDigest, action: 'create' };
    const recovery = SupplierRelationshipHttpRequestSchema.parse({ kind: 'relationship-recover', query });
    const recovered = { kind: 'relationship-recover', original: { mutation: input.mutation, receipt: original, currentHead } };
    expect(await validateSupplierRelationshipHttpResponse(recovery, recovered)).toEqual(recovered);
    await expect(validateSupplierRelationshipHttpResponse({ ...recovery, query: { ...query, commandDigest: H } } as SupplierRelationshipHttpRequest, recovered))
      .rejects.toMatchObject({ code: 'SUPPLIER_OUTCOME_UNKNOWN' });
  });

  it('snapshots request and response before asynchronous digest checks', async () => {
    const input = SupplierRelationshipHttpRequestSchema.parse({ kind: 'relationship-command', mutation: { idempotencyKey: key, command: command() } });
    if (input.kind !== 'relationship-command') throw new Error('Fixture kind');
    const raw = { kind: input.kind, outcome: 'APPENDED', receipt: await receipt(input), currentHead: head() };
    const pending = validateSupplierRelationshipHttpResponse(input, raw);
    input.mutation.idempotencyKey = 'changed_while_hashing'; raw.receipt.identity.idempotencyKey = 'changed_while_hashing';
    expect(await pending).toMatchObject({ receipt: { identity: { idempotencyKey: key } } });
  });

  it('checks exact policy references and category definition hashes on public reads', async () => {
    const input = SupplierRelationshipHttpRequestSchema.parse({ kind: 'policy-read', query: { policy: reference } });
    const raw = await response(input) as { kind: 'policy-read'; policy: { reference: typeof reference; categories: Array<{ definitionHash: string }> } };
    await expect(validateSupplierRelationshipHttpResponse(input, raw)).resolves.toHaveProperty('policy.categories');
    raw.policy.categories[0]!.definitionHash = H;
    await expect(validateSupplierRelationshipHttpResponse(input, raw)).rejects.toMatchObject({ code: 'SUPPLIER_OUTCOME_UNKNOWN' });
  });
});

describe('supplier bounded duplicate-aware body reader', () => {
  it.each([
    JSON.stringify(command()).replace('"expectedVersion":0', '"expectedVersion":0,"expectedVersion":0'),
    JSON.stringify(command()).replace('"expectedVersion":0', '"expectedVersion":0,"\\u0065xpectedVersion":1'),
    JSON.stringify(command()).replace('"supplierRelationshipId":"relationship"', '"supplierRelationshipId":"relationship","supplierRelationshipId":"foreign"'),
    '[]', 'null', '{"x":1e400}', '{"x":1} trailing', '{"x":1,}',
  ])('refuses ambiguous or malformed JSON before service work', async text => {
    const f = fixture(), result = await f.app.fetch(request(text));
    expect(result.status).toBe(422); secure(result); expect(f.gateway.submit).not.toHaveBeenCalled();
  });

  it.each([
    { 'Content-Type': 'text/plain' }, { 'Content-Type': 'application/json; charset=latin1' }, { 'Content-Encoding': 'gzip' },
  ])('requires uncompressed UTF-8 JSON', async extra => {
    const f = fixture(), result = await f.app.fetch(request(JSON.stringify(command()), { headers: { ...commandHeaders, ...extra } }));
    expect(result.status).toBe(415); expect(f.gateway.submit).not.toHaveBeenCalled();
  });

  it('accepts exactly the route byte limit and refuses one-byte or declared overflow', async () => {
    const f = fixture(), json = JSON.stringify(command()), size = encoded(json).length, limit = supplierRelationshipHttpBodyLimits['relationship-command'];
    expect((await f.app.fetch(request(json + ' '.repeat(limit - size)))).status).toBe(200);
    const calls = f.gateway.submit.mock.calls.length;
    const overflow = await f.app.fetch(request(stream([encoded(json), encoded(' '.repeat(limit - size)), encoded(' ')]), { headers: { ...commandHeaders, 'Transfer-Encoding': 'chunked' } }));
    expect(overflow.status).toBe(413); secure(overflow);
    expect((await f.app.fetch(request(json, { headers: { ...commandHeaders, 'Content-Length': String(limit + 1) } }))).status).toBe(413);
    expect(f.gateway.submit).toHaveBeenCalledTimes(calls);
  });

  it('allows the complete 100-category Unicode policy payload within its dedicated limit', async () => {
    const f = fixture(), body = policyCommand();
    body.payload.terms.categories = Array.from({ length: 100 }, (_, i) => ({ id: `category_${i}`, label: 'Delivery', definition: '🧵'.repeat(1_000) }));
    const text = JSON.stringify(body);
    expect(encoded(text).length).toBeGreaterThan(256 * 1024);
    expect(encoded(text).length).toBeLessThan(supplierRelationshipHttpBodyLimits['policy-command']);
    expect((await f.app.fetch(request(text, { path: supplierRelationshipHttpRoutes['policy-command'] }))).status).toBe(200);
  });

  it.each([
    { 'Content-Length': '01' }, { 'Content-Length': '1, 1' }, { 'Content-Length': '1' },
    { 'Transfer-Encoding': 'gzip' }, { 'Transfer-Encoding': 'chunked', 'Content-Length': '1' },
  ])('refuses ambiguous body framing or a mismatched declared length', async extra => {
    const f = fixture(), result = await f.app.fetch(request(JSON.stringify(command()), { headers: { ...commandHeaders, ...extra } }));
    expect(result.status).toBe(422); expect(f.gateway.submit).not.toHaveBeenCalled();
  });

  it('rejects invalid UTF-8 and cancels a timed-out stream without service work', async () => {
    const f = fixture();
    expect((await f.app.fetch(request(new Uint8Array([0xc3, 0x28])))).status).toBe(422);
    const cancel = vi.fn(), body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoded('{')); }, cancel });
    const pending = f.app.fetch(request(body));
    await vi.advanceTimersByTimeAsync(5_001);
    const result = await pending; expect(result.status).toBe(408); secure(result);
    expect(cancel).toHaveBeenCalledOnce(); expect(f.gateway.submit).not.toHaveBeenCalled();
  });

  it('refuses an aborted upload and a previously consumed body', async () => {
    const f = fixture(), controller = new AbortController(); controller.abort();
    expect((await f.app.fetch(request(JSON.stringify(command()), { signal: controller.signal }))).status).toBe(408);
    const consumed = request(JSON.stringify(command())); await consumed.text();
    await expect(readSupplierRelationshipJson(consumed, supplierRelationshipHttpBodyLimits['relationship-command'])).rejects.toMatchObject({ code: 'SETUP_REQUIRED' });
    expect(f.gateway.submit).not.toHaveBeenCalled();
  });
});
