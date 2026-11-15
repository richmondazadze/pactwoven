import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GrantAccessCommand, Operation } from '@pactwoven/contracts';
import { DomainError } from '@pactwoven/domain';
import type { AccessGateway } from './access-service.js';
import { accessResponseBytes, accessUrl, handlePrivateAccessRequest, serviceAccessGateway } from './worker-access.js';

const issuer = 'https://worker-fixture.clerk.accounts.dev';
const token = 'synthetic-access-token', authorization = `Bearer ${token}`, key = 'access_change_request_0001';
const trace = 'access_trace', actorId = 'target_actor';
const command: GrantAccessCommand = { expectedVersion: 0, mandateVersion: null, authorityEpoch: 2,
  payload: { externalMembershipId: 'member_target', externalSubject: 'subject_target', roles: ['receiver'],
    siteIds: ['site_one'], actionSiteIds: ['site_one'], expiresAt: null } };
const operation: Operation = { id: 'access_operation', environment: 'development', status: 'succeeded', aggregateId: actorId,
  aggregateVersion: 1, financialState: null, evidenceRefs: ['history_one'], nextCheckAt: null, error: null };
const members = () => ({ items: [], nextCursor: null, authorityEpoch: 2, observedAt: new Date().toISOString() });
const candidates = () => ({ items: [], nextCursor: null, observedAt: new Date().toISOString() });
const gateway = { listMembers: vi.fn(), listCandidates: vi.fn(), getOperation: vi.fn(), grant: vi.fn(), revise: vi.fn(), revoke: vi.fn() } satisfies AccessGateway;
const responseHeaders = { 'Cache-Control': 'private, no-store', 'Content-Type': 'application/json' };
const publicRequest = (path = '/v1/members/grant', method = 'POST', requestToken = token) => new Request(`https://api.example${path}`, {
  method, headers: { Authorization: `Bearer ${requestToken}`, 'Idempotency-Key': key },
});
const privateInput = () => ({ nonce: crypto.randomUUID(), request: { url: 'https://api.example/v1/members/grant', method: 'POST', correlationId: trace },
  action: { kind: 'grant', key, command: structuredClone(command) } });
const privateRequest = (input: unknown, headers: Record<string, string> = {}) => new Request(accessUrl, {
  method: 'POST', headers: { Authorization: authorization, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(input),
});
const fetchPrivate = (request: Request) => handlePrivateAccessRequest(request, issuer, gateway);
beforeEach(() => {
  vi.resetAllMocks();
  gateway.listMembers.mockImplementation(async () => members());
  gateway.listCandidates.mockImplementation(async () => candidates());
  for (const method of [gateway.grant, gateway.revise, gateway.revoke, gateway.getOperation]) method.mockResolvedValue(operation);
});

describe('bound private access exchange', () => {
  it('forwards only original credentials and strict command inputs to the selected private method', async () => {
    let forwarded: Request | undefined, body: Record<string, unknown> | undefined;
    const fetch = vi.fn(async (request: Request) => { forwarded = request.clone(); body = await request.clone().json(); return fetchPrivate(request); });
    const adapter = serviceAccessGateway({ fetch }, publicRequest(), issuer);
    expect(await adapter.grant(token, key, command, trace)).toEqual(operation);
    expect(forwarded!.url).toBe(accessUrl);
    expect([...forwarded!.headers.keys()].sort()).toEqual(['authorization', 'content-type']);
    expect(forwarded!.headers.get('Authorization')).toBe(authorization);
    expect(Object.keys(body!).sort()).toEqual(['action', 'nonce', 'request']);
    expect(gateway.grant).toHaveBeenCalledExactlyOnceWith(token, key, command, trace);
    expect(gateway.revoke).not.toHaveBeenCalled();
  });

  it('supports list, candidates, grant, revise, revoke and recovery through their exact public routes', async () => {
    const adapter = (path: string, method = 'GET') => serviceAccessGateway({ fetch: fetchPrivate }, publicRequest(path, method), issuer);
    expect(await adapter('/v1/members?limit=25').listMembers(token, { limit: 25 }, trace)).toMatchObject({ items: [], authorityEpoch: 2 });
    expect(await adapter('/v1/members/candidates?limit=10&cursor=0').listCandidates(token, { limit: 10, cursor: '0' }, trace)).toMatchObject({ items: [] });
    expect(await adapter(`/v1/member-access/operations?kind=grant&key=${key}`).getOperation(token, { kind: 'grant', key }, trace)).toEqual(operation);
    const { externalMembershipId: _member, externalSubject: _subject, ...scope } = command.payload;
    const revision = { ...command, expectedVersion: 1, payload: scope }, revocation = { ...command, expectedVersion: 1, payload: { reason: 'Access ended' } };
    expect(await adapter(`/v1/members/${actorId}/revise-access`, 'POST').revise(token, actorId, key, revision, trace)).toEqual(operation);
    expect(await adapter(`/v1/members/${actorId}/revoke`, 'POST').revoke(token, actorId, key, revocation, trace)).toEqual(operation);
    expect(gateway.getOperation).toHaveBeenCalledExactlyOnceWith(token, { kind: 'grant', key }, trace);
  });

  it('rejects altered tokens, keys, methods, paths and query values before a private call', async () => {
    const fetch = vi.fn(fetchPrivate);
    await expect(serviceAccessGateway({ fetch }, publicRequest(), issuer).grant('other-token', key, command, trace)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    for (const request of [publicRequest('/v1/members/grant', 'GET'), publicRequest('/v1/members/other/revoke'), publicRequest('/v1/members/grant?extra=1')]) {
      await expect(serviceAccessGateway({ fetch }, request, issuer).grant(token, key, command, trace)).rejects.toMatchObject({ code: 'DURABLE_SERVICE_UNAVAILABLE' });
    }
    await expect(serviceAccessGateway({ fetch }, publicRequest(), issuer).grant(token, 'other_command_key_0001', command, trace)).rejects.toThrow();
    for (const path of ['/v1/members?limit=10', '/v1/members?limit=25&limit=25', '/v1/members?unknown=1']) {
      await expect(serviceAccessGateway({ fetch }, publicRequest(path, 'GET'), issuer).listMembers(token, { limit: 25 }, trace)).rejects.toThrow();
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects each tampered binding field, schema extension and malformed operation', async () => {
    const changes: ((data: Record<string, any>) => void)[] = [
      d => { d.nonce = crypto.randomUUID(); }, d => { d.tokenHash = 'f'.repeat(64); }, d => { d.requestHash = 'f'.repeat(64); },
      d => { d.commandHash = 'f'.repeat(64); }, d => { d.request.method = 'GET'; }, d => { d.request.url += '?replayed=1'; },
      d => { d.request.correlationId = 'other_trace'; }, d => { d.kind = 'revoke'; }, d => { d.actorId = 'other_actor'; },
      d => { d.key = 'other_command_key_0001'; }, d => { d.issuer = 'https://other.clerk.accounts.dev'; }, d => { d.environment = 'production'; },
      d => { d.respondedAt = new Date(Date.now() - 60_000).toISOString(); }, d => { d.respondedAt = new Date(Date.now() + 60_000).toISOString(); },
      d => { d.identity = { roles: ['owner'] }; }, d => { d.outcome.message = 'private-detail'; },
      d => { d.outcome.data.environment = 'production'; }, d => { d.outcome.data.financialState = 'CONFIRMED'; },
      d => { d.outcome.data.extra = 'private-detail'; }, d => { d.outcome.data.error = { code: 'private-detail', retryable: true, detailRef: null }; },
    ];
    for (const change of changes) {
      const fetch = vi.fn(async (request: Request) => {
        const data = await (await fetchPrivate(request)).json() as Record<string, any>; change(data);
        return Response.json(data, { headers: responseHeaders });
      });
      await expect(serviceAccessGateway({ fetch }, publicRequest(), issuer).grant(token, key, command, trace)).rejects.toMatchObject({ code: 'DURABLE_SERVICE_UNAVAILABLE' });
      expect(fetch).toHaveBeenCalledOnce();
    }
  });

  it('binds target actor on revocation results and rejects a different aggregate', async () => {
    gateway.revoke.mockResolvedValue({ ...operation, aggregateId: 'different_actor' });
    const adapter = serviceAccessGateway({ fetch: fetchPrivate }, publicRequest(`/v1/members/${actorId}/revoke`), issuer);
    const revokeCommand = { ...command, expectedVersion: 1, payload: { reason: 'Access ended' } };
    await expect(adapter.revoke(token, actorId, key, revokeCommand, trace)).rejects.toMatchObject({ code: 'DURABLE_SERVICE_UNAVAILABLE' });
    expect(gateway.revoke).toHaveBeenCalledExactlyOnceWith(token, actorId, key, revokeCommand, trace);
  });

  it('rejects concurrent response swaps even when token, command and key are identical', async () => {
    const pending: { response: Response; resolve: (response: Response) => void }[] = [];
    const fetch = vi.fn(async (request: Request) => {
      const response = await fetchPrivate(request);
      return new Promise<Response>(resolve => {
        pending.push({ response, resolve });
        if (pending.length === 2) { pending[0]!.resolve(pending[1]!.response); pending[1]!.resolve(pending[0]!.response); }
      });
    });
    const a = serviceAccessGateway({ fetch }, publicRequest(), issuer), b = serviceAccessGateway({ fetch }, publicRequest(), issuer);
    const results = await Promise.allSettled([a.grant(token, key, command, trace), b.grant(token, key, command, trace)]);
    expect(results.map(result => result.status)).toEqual(['rejected', 'rejected']);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('rejects replayed success and replayed error responses', async () => {
    for (const denied of [false, true]) {
      gateway.grant.mockReset();
      if (denied) gateway.grant.mockRejectedValue(new DomainError('FORBIDDEN', 403, 'private-reason'));
      else gateway.grant.mockResolvedValue(operation);
      let saved: Response | undefined;
      const fetch = vi.fn(async (request: Request) => { saved ??= await fetchPrivate(request); return saved.clone(); });
      const adapter = serviceAccessGateway({ fetch }, publicRequest(), issuer);
      if (denied) await expect(adapter.grant(token, key, command, trace)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      else expect(await adapter.grant(token, key, command, trace)).toEqual(operation);
      await expect(adapter.grant(token, key, command, trace)).rejects.toMatchObject({ code: 'DURABLE_SERVICE_UNAVAILABLE' });
      expect(gateway.grant).toHaveBeenCalledOnce();
    }
  });

  it('preserves accepted, pending, failed and unknown operation truth without retry', async () => {
    for (const status of ['accepted', 'pending', 'failed', 'unknown'] as const) {
      const value = { ...operation, status, nextCheckAt: new Date(Date.now() + 5000).toISOString(),
        error: status === 'unknown' ? { code: 'OUTCOME_UNKNOWN', retryable: false, detailRef: null } : null };
      gateway.getOperation.mockResolvedValue(value);
      const fetch = vi.fn(fetchPrivate);
      const adapter = serviceAccessGateway({ fetch }, publicRequest(`/v1/member-access/operations?kind=grant&key=${key}`, 'GET'), issuer);
      expect(await adapter.getOperation(token, { kind: 'grant', key }, trace)).toEqual(value);
      expect(fetch).toHaveBeenCalledOnce();
    }
    expect(gateway.grant).not.toHaveBeenCalled();
  });

  it('requires exact status and no-store JSON responses', async () => {
    for (const alter of [(r: Response) => new Response(r.body, { status: 201, headers: r.headers }),
      (r: Response) => { r.headers.set('Cache-Control', 'public, max-age=60'); return r; },
      (r: Response) => { r.headers.set('Content-Type', 'text/plain'); return r; }]) {
      const fetch = async (request: Request) => alter(await fetchPrivate(request));
      await expect(serviceAccessGateway({ fetch }, publicRequest(), issuer).grant(token, key, command, trace)).rejects.toMatchObject({ code: 'DURABLE_SERVICE_UNAVAILABLE' });
    }
  });

  it('returns only fixed safe messages for bound errors and rejects unbound or status-mismatched errors', async () => {
    for (const [code, status] of [['AUTH_REQUIRED', 401], ['FORBIDDEN', 403], ['STEP_UP_REQUIRED', 403], ['NOT_FOUND', 404],
      ['VERSION_CONFLICT', 409], ['IDEMPOTENCY_CONFLICT', 409], ['VALIDATION_FAILED', 422], ['IDENTITY_UNAVAILABLE', 503]] as const) {
      gateway.grant.mockRejectedValue(new DomainError(code, status, 'private-provider-details'));
      await expect(serviceAccessGateway({ fetch: fetchPrivate }, publicRequest(), issuer).grant(token, key, command, trace))
        .rejects.toMatchObject({ code, status, message: expect.not.stringContaining('private-provider-details') });
    }
    for (const failure of [new Error('private-driver-details'), new DomainError('FORBIDDEN', 503, 'private-status-detail')]) {
      gateway.grant.mockRejectedValue(failure);
      await expect(serviceAccessGateway({ fetch: fetchPrivate }, publicRequest(), issuer).grant(token, key, command, trace))
        .rejects.toMatchObject({ code: 'DURABLE_SERVICE_UNAVAILABLE', message: expect.not.stringContaining('private-') });
    }
    const fetch = async () => Response.json({ error: { code: 'FORBIDDEN', message: 'private-detail' } }, { status: 403 });
    await expect(serviceAccessGateway({ fetch }, publicRequest(), issuer).grant(token, key, command, trace)).rejects.toMatchObject({ code: 'DURABLE_SERVICE_UNAVAILABLE' });
  });

  it('bounds oversized and stalled service responses without retry or replacement command', async () => {
    const cancel = vi.fn();
    const fetch = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(accessResponseBytes + 1)); }, cancel })));
    await expect(serviceAccessGateway({ fetch }, publicRequest(), issuer).grant(token, key, command, trace)).rejects.toMatchObject({ code: 'DURABLE_SERVICE_UNAVAILABLE' });
    expect(fetch).toHaveBeenCalledOnce(); expect(cancel).toHaveBeenCalledOnce();
    vi.useFakeTimers();
    try {
      const stalled = vi.fn(async () => new Response(new ReadableStream({ cancel })));
      const pending = serviceAccessGateway({ fetch: stalled }, publicRequest(), issuer).grant(token, key, command, trace);
      const rejection = expect(pending).rejects.toMatchObject({ code: 'DURABLE_SERVICE_UNAVAILABLE' });
      await vi.waitFor(() => expect(stalled).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(20_001);
      await rejection;
      expect(stalled).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
});

describe('private access intake', () => {
  it('rejects identity/proof assertions, extra command fields and invalid protocol inputs before any gateway call', async () => {
    const valid = privateInput();
    for (const input of [{ ...valid, identity: { roles: ['owner'] } }, { ...valid, proof: { verified: true } },
      { ...valid, nonce: 'caller-nonce' }, { ...valid, action: { ...valid.action, actorId: 'caller_actor' } },
      { ...valid, action: { ...valid.action, command: { ...command, stepUp: true } } },
      { ...valid, action: { ...valid.action, kind: 'bootstrap' } },
      { ...valid, request: { ...valid.request, method: 'GET' } },
      { ...valid, request: { ...valid.request, url: 'https://api.example/v1/members/other/revoke' } }]) {
      expect((await fetchPrivate(privateRequest(input))).status).toBe(422);
    }
    for (const method of Object.values(gateway)) expect(method).not.toHaveBeenCalled();
  });

  it('allows only the exact internal POST route and does not substitute identity headers for a token', async () => {
    for (const request of [new Request(accessUrl), new Request(`${accessUrl}?extra=1`, { method: 'POST' }),
      new Request('https://public.example/internal/access/dispatch', { method: 'POST' })]) expect((await fetchPrivate(request)).status).toBe(404);
    expect((await fetchPrivate(privateRequest(privateInput(), { Authorization: '', 'X-Actor-Id': 'owner' }))).status).toBe(401);
    expect(gateway.grant).not.toHaveBeenCalled();
  });

  it('rejects non-JSON, invalid encoding, oversized and stalled intake before the gateway', async () => {
    for (const request of [privateRequest(privateInput(), { 'Content-Type': 'text/plain' }),
      privateRequest(privateInput(), { 'Content-Length': '65537' }), privateRequest(privateInput(), { 'Content-Length': 'wrong' }),
      privateRequest({ padding: 'x'.repeat(65_537) }), new Request(accessUrl, { method: 'POST', headers: { Authorization: authorization,
        'Content-Type': 'application/json' }, body: new Uint8Array([0xff]) })]) expect((await fetchPrivate(request)).status).toBe(422);
    vi.useFakeTimers();
    try {
      const cancel = vi.fn();
      const request = new Request(accessUrl, { method: 'POST', headers: { Authorization: authorization, 'Content-Type': 'application/json' },
        body: new ReadableStream({ cancel }), duplex: 'half' } as RequestInit);
      const pending = fetchPrivate(request);
      await vi.advanceTimersByTimeAsync(5_001);
      expect((await pending).status).toBe(422); expect(cancel).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
    expect(gateway.grant).not.toHaveBeenCalled();
  });
});
