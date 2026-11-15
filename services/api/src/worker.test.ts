import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Operation, Session } from '@pactwoven/contracts';
import type { VerifiedIdentity } from '@pactwoven/db';
import { DomainError } from '@pactwoven/domain';
import apiWorker from './worker.js';
import provisionerWorker from './provisioner-worker.js';
import { readWorkerConfig, requestResource, type WorkerBindings, type WorkerContext } from './worker-config.js';
import { provisionerUrl, serviceProvisioner } from './worker-provisioner.js';
import { identityUrl, serviceIdentityVerifier, verifyPrivateIdentityRequest } from './worker-identity.js';
import { accessUrl } from './worker-access.js';

const mocks = vi.hoisted(() => ({
  runtimePool: vi.fn(), provisionerPool: vi.fn(), verifyIdentity: vi.fn(), bootstrap: vi.fn(), session: vi.fn(),
  accessPool: vi.fn(), verifyStepUp: vi.fn(), members: vi.fn(), candidateList: vi.fn(), candidateResolve: vi.fn(),
  member: vi.fn(), accessChange: vi.fn(), accessOperation: vi.fn(),
}));
vi.mock('@pactwoven/db', async importOriginal => ({ ...await importOriginal<typeof import('@pactwoven/db')>(),
  createRuntimePool: mocks.runtimePool, createProvisionerPool: mocks.provisionerPool, createAccessPool: mocks.accessPool,
  PostgresFoundationRepository: class { getSession(...args: unknown[]) { return mocks.session(...args); } },
  PostgresOrganizationProvisioner: class { bootstrapOrganization(...args: unknown[]) { return mocks.bootstrap(...args); } },
  PostgresAccessRepository: class {
    listMembers(...args: unknown[]) { return mocks.members(...args); }
    getMember(...args: unknown[]) { return mocks.member(...args); }
    getOperation(...args: unknown[]) { return mocks.accessOperation(...args); }
    changeAccess(...args: unknown[]) { return mocks.accessChange(...args); }
  },
}));
vi.mock('./auth.js', () => ({ createClerkIdentityVerifier: () => mocks.verifyIdentity, createClerkStepUpVerifier: () => mocks.verifyStepUp }));
vi.mock('./access-service.js', async importOriginal => ({ ...await importOriginal<typeof import('./access-service.js')>(),
  createClerkMembershipDirectory: () => ({ list: mocks.candidateList, resolve: mocks.candidateResolve }),
}));

const identity: VerifiedIdentity = { subject: 'test_user', externalOrganizationId: 'external_org', externalOrganizationName: 'Worker test',
  externalMembershipId: 'test_member', externalRole: 'org:admin', membershipObservedAt: '2026-11-14T12:00:00Z',
  sessionId: 'test_session', authenticatedAt: '2026-11-14T12:00:00Z' };
const operation: Operation = { id: 'bootstrap_operation', environment: 'development', status: 'succeeded', aggregateId: 'test_org',
  aggregateVersion: 1, financialState: null, evidenceRefs: [], nextCheckAt: null, error: null };
const session: Session = { actor: { actorId: 'test_actor', organizationId: 'test_org', environment: 'development', principalKind: 'human',
  roles: ['owner'], siteIds: ['test_site'], actionSiteIds: ['test_site'], sessionId: 'test_session', authenticatedAt: '2026-11-14T12:00:00Z', correlationId: 'test_trace' },
  organization: { id: 'test_org', name: 'Worker test', authorityEpoch: 0 }, sites: [{ id: 'test_site', name: 'Test site', timeZone: 'UTC' }] };
const command = { expectedVersion: 0, mandateVersion: null, authorityEpoch: null,
  payload: { initialSite: { name: 'Test site', timeZone: 'America/Chicago' } } };
const authorization = 'Bearer synthetic-worker-token';
const headers = { Authorization: authorization, 'Content-Type': 'application/json',
  'Idempotency-Key': 'worker_bootstrap_request_0001', 'X-Correlation-Id': 'worker_trace' };
function bindings(role: 'api' | 'provisioner'): WorkerBindings {
  const user = role === 'api' ? 'pactwoven_app' : 'pactwoven_identity';
  const connection = new URL('postgresql://hyperdrive.local:5432/pactwoven_dev');
  connection.username = user;
  connection.password = 'fixture';
  const access = new URL(connection);
  access.username = 'pactwoven_access';
  return { APP_ENVIRONMENT: 'development', WORKER_ROLE: role, ALLOWED_ORIGINS: 'http://127.0.0.1:3001',
    ...(role === 'provisioner' ? { CLERK_SECRET_KEY: ['sk', 'test', 'fixture'].join('_'), EXPECTED_ACCESS_DATABASE_USER: 'pactwoven_access',
      ACCESS_DATABASE: { connectionString: access.href, host: 'hyperdrive.local', port: 5432, user: 'pactwoven_access', database: 'pactwoven_dev' } } : {}),
    CLERK_ISSUER: 'https://worker-fixture.clerk.accounts.dev',
    CLERK_PUBLISHABLE_KEY: `pk_test_${btoa('worker-fixture.clerk.accounts.dev$').replace(/=+$/, '')}`,
    EXPECTED_DATABASE_USER: user, DATABASE: { connectionString: connection.href,
      host: 'hyperdrive.local', port: 5432, user, database: 'pactwoven_dev' },
    ...(role === 'api' ? { IDENTITY_PROVISIONER: { fetch: async request => {
      const ctx = context();
      const response = await provisionerWorker.fetch(request, bindings('provisioner'), ctx);
      await ctx.done();
      return response;
    } } } : {}),
  };
}
function context() {
  const promises: Promise<unknown>[] = [];
  return { waitUntil(promise) { promises.push(promise); }, done: () => Promise.all(promises) } satisfies WorkerContext & { done(): Promise<unknown[]> };
}
function bootstrapRequest(url = 'https://pactwoven-api.example/v1/organizations/bootstrap', body = command): Request {
  return new Request(url, { method: 'POST', headers, body: JSON.stringify(body) });
}
beforeEach(() => {
  vi.clearAllMocks();
  identity.membershipObservedAt = new Date().toISOString();
  mocks.verifyIdentity.mockResolvedValue(identity);
  mocks.bootstrap.mockResolvedValue(operation);
  mocks.session.mockResolvedValue(session);
  mocks.runtimePool.mockImplementation(async () => ({ end: vi.fn(async () => {}), query: vi.fn(async () => ({ rows: [{ database_matches: true, current_matches: true, session_matches: true }] })) }));
  mocks.provisionerPool.mockImplementation(async () => ({ end: vi.fn(async () => {}), query: vi.fn(async () => ({ rows: [{ database_matches: true, current_matches: true, session_matches: true }] })) }));
  mocks.accessPool.mockImplementation(async () => ({ end: vi.fn(async () => {}), query: vi.fn(async () => ({ rows: [{ database_matches: true, current_matches: true, session_matches: true }] })) }));
});

describe('Cloudflare request and private service boundaries', () => {
  it('answers health/anonymous rejection without opening database pools', async () => {
    const ctx = context();
    expect((await apiWorker.fetch(new Request('https://api.example/health'), bindings('api'), ctx)).status).toBe(200);
    expect((await apiWorker.fetch(new Request('https://api.example/v1/session'), bindings('api'), ctx)).status).toBe(401);
    await ctx.done();
    expect(mocks.runtimePool).not.toHaveBeenCalled();
    expect(mocks.provisionerPool).not.toHaveBeenCalled();
  });

  it('owns one lazy pool per request and closes it through waitUntil', async () => {
    const ctx = context();
    const request = () => new Request('https://api.example/v1/session', { headers });
    expect((await apiWorker.fetch(request(), bindings('api'), ctx)).status).toBe(200);
    expect((await apiWorker.fetch(request(), bindings('api'), ctx)).status).toBe(200);
    await ctx.done();
    expect(mocks.runtimePool).toHaveBeenCalledTimes(2);
    for (const result of mocks.runtimePool.mock.results) {
      expect((await result.value).end).toHaveBeenCalledOnce();
      expect((await result.value).query).toHaveBeenCalledWith(expect.stringContaining('current_user'), ['pactwoven_dev', 'pactwoven_app']);
    }
    expect(mocks.provisionerPool).not.toHaveBeenCalled();
  });

  it('closes initialized resources on database failure without exposing driver detail', async () => {
    const ctx = context();
    mocks.session.mockRejectedValue(new Error('private-driver-details'));
    const response = await apiWorker.fetch(new Request('https://api.example/v1/session', { headers }), bindings('api'), ctx);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('private-driver-details');
    await ctx.done();
    expect((await mocks.runtimePool.mock.results[0]?.value).end).toHaveBeenCalledOnce();
  });

  it('verifies privately for the public request and again at bootstrap with the same original token', async () => {
    const publicCtx = context(), privateCtx = context();
    const env = bindings('api');
    let forwarded: Request | undefined;
    env.IDENTITY_PROVISIONER = { fetch: async request => {
      forwarded = request.clone();
      return provisionerWorker.fetch(request, bindings('provisioner'), privateCtx);
    } };
    const response = await apiWorker.fetch(bootstrapRequest(), env, publicCtx);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(operation);
    expect(mocks.verifyIdentity).toHaveBeenCalledTimes(2);
    expect(mocks.verifyIdentity).toHaveBeenNthCalledWith(1, 'synthetic-worker-token');
    expect(mocks.verifyIdentity).toHaveBeenNthCalledWith(2, 'synthetic-worker-token');
    expect(forwarded?.url).toBe(provisionerUrl);
    expect(await forwarded!.json()).toEqual(command);
    expect([...forwarded!.headers.keys()].sort()).toEqual(['authorization', 'content-type', 'idempotency-key', 'x-correlation-id']);
    expect(mocks.bootstrap).toHaveBeenCalledWith(identity, headers['Idempotency-Key'], command, 'worker_trace');
    expect(mocks.runtimePool).not.toHaveBeenCalled();
    await Promise.all([publicCtx.done(), privateCtx.done()]);
    expect((await mocks.provisionerPool.mock.results[0]?.value).end).toHaveBeenCalledOnce();
  });

  it('rejects a session revoked between public and private checks without provisioning', async () => {
    const publicCtx = context(), privateCtx = context();
    mocks.verifyIdentity.mockResolvedValueOnce(identity).mockRejectedValueOnce(new DomainError('AUTH_REQUIRED', 401, 'Revoked'));
    const env = bindings('api');
    env.IDENTITY_PROVISIONER = { fetch: request => provisionerWorker.fetch(request, bindings('provisioner'), privateCtx) };
    expect((await apiWorker.fetch(bootstrapRequest(), env, publicCtx)).status).toBe(401);
    await Promise.all([publicCtx.done(), privateCtx.done()]);
    expect(mocks.bootstrap).not.toHaveBeenCalled();
    expect(mocks.provisionerPool).not.toHaveBeenCalled();
  });

  it('rejects extra authority fields and oversized bodies before either identity effect', async () => {
    const env = bindings('api'), ctx = context();
    const fetch = vi.fn(env.IDENTITY_PROVISIONER!.fetch);
    env.IDENTITY_PROVISIONER = { fetch };
    expect((await apiWorker.fetch(bootstrapRequest(undefined, { ...command, actorId: 'other' } as typeof command), env, ctx)).status).toBe(422);
    expect((await apiWorker.fetch(new Request('https://api.example/v1/organizations/bootstrap',
      { method: 'POST', headers, body: JSON.stringify({ payload: 'x'.repeat(70_000) }) }), env, ctx)).status).toBe(413);
    await ctx.done();
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[0].url).toBe(identityUrl);
    expect(mocks.runtimePool).not.toHaveBeenCalled();
    expect(mocks.provisionerPool).not.toHaveBeenCalled();
  });

  it('private entrypoint exposes only the exact internal POST route', async () => {
    const ctx = context();
    for (const request of [new Request(provisionerUrl), bootstrapRequest('https://public.example/v1/organizations/bootstrap'),
      bootstrapRequest(`${provisionerUrl}?extra=1`), new Request('https://pactwoven-provisioner.internal/health'),
      new Request(identityUrl), bootstrapRequest(`${identityUrl}?extra=1`), bootstrapRequest('https://public.example/internal/identity/verify'),
      new Request(accessUrl), bootstrapRequest(`${accessUrl}?extra=1`), bootstrapRequest('https://public.example/internal/access/dispatch')]) {
      expect((await provisionerWorker.fetch(request, bindings('provisioner'), ctx)).status).toBe(404);
    }
    expect(mocks.verifyIdentity).not.toHaveBeenCalled();
    expect(mocks.provisionerPool).not.toHaveBeenCalled();
    expect(mocks.accessPool).not.toHaveBeenCalled();
  });

  it('never trusts claimed identity headers at the private entrypoint', async () => {
    const ctx = context();
    const request = new Request(provisionerUrl, { method: 'POST', body: JSON.stringify(command),
      headers: { 'Content-Type': 'application/json', 'X-Actor-Id': 'owner', 'X-Organization-Id': 'another' } });
    expect((await provisionerWorker.fetch(request, bindings('provisioner'), ctx)).status).toBe(401);
    expect(mocks.bootstrap).not.toHaveBeenCalled();
  });

  it('does not retry a failed private call and scrubs unsafe private errors', async () => {
    const ctx = context(), env = bindings('api');
    const fetch = vi.fn(async () => Response.json({ error: { code: 'FORBIDDEN', message: 'private-details' } }, { status: 503 }));
    env.IDENTITY_PROVISIONER = { fetch };
    const response = await apiWorker.fetch(bootstrapRequest(), env, ctx);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('private-details');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('rejects private success with wrong environment or malformed operation', async () => {
    for (const data of [{ ...operation, environment: 'production' }, { ok: true }]) {
      const adapter = serviceProvisioner({ fetch: async () => Response.json(data, { status: 201 }) }, authorization);
      await expect(adapter.bootstrapOrganization(identity, headers['Idempotency-Key'], command, 'trace')).rejects.toThrow();
    }
  });

  it('cancels an oversized private response before consuming the rest', async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array(65_537));
    }, cancel }));
    const adapter = serviceProvisioner({ fetch: async () => response }, authorization);
    await expect(adapter.bootstrapOrganization(identity, headers['Idempotency-Key'], command, 'trace')).rejects.toThrow();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('bounds stalled private responses and preserves the original command identity', async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn(), fetch = vi.fn(async () => new Response(new ReadableStream({ cancel })));
      const adapter = serviceProvisioner({ fetch }, authorization);
      const result = adapter.bootstrapOrganization(identity, headers['Idempotency-Key'], command, 'trace');
      const rejected = expect(result).rejects.toThrow('not confirmed');
      await vi.advanceTimersByTimeAsync(20_001);
      await rejected;
      expect(fetch).toHaveBeenCalledOnce();
      expect(cancel).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
});

describe('Worker environment and lifecycle validation', () => {
  it('retains the expected origin role separately from synthetic proxy metadata', () => {
    const env = bindings('api');
    const url = new URL(env.DATABASE!.connectionString); url.username = 'proxy'; url.pathname = '/proxy';
    env.DATABASE = { ...env.DATABASE!, connectionString: url.href, user: 'proxy', database: 'proxy' };
    expect(readWorkerConfig(env, 'api')).toMatchObject({ connectionString: url.href, expectedDatabaseUser: 'pactwoven_app' });
    expect(readWorkerConfig(bindings('provisioner'), 'provisioner')).toMatchObject({
      expectedDatabaseUser: 'pactwoven_identity', expectedAccessDatabaseUser: 'pactwoven_access' });
  });

  it('refuses a mismatched actual origin identity before reading application data', async () => {
    const end = vi.fn(async () => {});
    mocks.runtimePool.mockResolvedValue({ end, query: vi.fn(async () => ({ rows: [{ database_matches: true, current_matches: false, session_matches: false }] })) });
    const ctx = context();
    const response = await apiWorker.fetch(new Request('https://api.example/v1/session', { headers }), bindings('api'), ctx);
    await ctx.done();
    expect(response.status).toBe(503); expect(mocks.session).not.toHaveBeenCalled(); expect(end).toHaveBeenCalledOnce();
    expect(await response.text()).not.toMatch(/fixture|postgresql|pactwoven_app/);
  });

  it('accepts matching development-only binding configuration', () => {
    expect(readWorkerConfig(bindings('api'), 'api').environment).toBe('development');
    expect(readWorkerConfig(bindings('api'), 'api')).not.toHaveProperty('secretKey');
    expect(readWorkerConfig(bindings('provisioner'), 'provisioner').environment).toBe('development');
    const actualHyperdrive = bindings('api');
    actualHyperdrive.DATABASE = { ...actualHyperdrive.DATABASE!, connectionString: `${actualHyperdrive.DATABASE!.connectionString}?sslmode=disable` };
    expect(readWorkerConfig(actualHyperdrive, 'api').environment).toBe('development');
  });

  it('rejects environment promotion, direct credentials, role swapping and mismatched binding metadata', () => {
    const valid = bindings('api');
    for (const patch of [{ APP_ENVIRONMENT: 'production' }, { WORKER_ROLE: 'provisioner' }, { DATABASE_URL: 'not-permitted' },
      { PROVISIONER_DATABASE_URL: 'not-permitted' }, { EXPECTED_DATABASE_USER: 'invalid role' }, { IDENTITY_PROVISIONER: undefined },
      { DATABASE: { ...valid.DATABASE!, database: 'production' } }, { DATABASE: { ...valid.DATABASE!, connectionString: `${valid.DATABASE!.connectionString}?options=role` } }]) {
      expect(() => readWorkerConfig({ ...valid, ...patch } as WorkerBindings, 'api')).toThrow('bindings');
    }
    for (const query of ['sslmode=disable&sslmode=disable', 'sslmode=disable&user=owner', 'sslmode=require', 'sslmode=disable&options=-c%20role=owner']) {
      expect(() => readWorkerConfig({ ...valid, DATABASE: { ...valid.DATABASE!, connectionString: `${valid.DATABASE!.connectionString}?${query}` } }, 'api')).toThrow();
    }
    expect(() => readWorkerConfig({ ...bindings('provisioner'), IDENTITY_PROVISIONER: valid.IDENTITY_PROVISIONER! }, 'provisioner')).toThrow();
  });

  it('rejects live or mismatched Clerk keys and non-exact origins without exposing bindings', () => {
    for (const patch of [{ CLERK_SECRET_KEY: ['sk', 'live', 'fixture'].join('_') }, { CLERK_ISSUER: 'https://other.clerk.accounts.dev' },
      { ALLOWED_ORIGINS: '*' }, { ALLOWED_ORIGINS: 'http://untrusted.example' }, { ALLOWED_ORIGINS: 'https://example.com/path' },
      { ALLOWED_ORIGINS: 'https://example.com,https://example.com' }]) {
      expect(() => readWorkerConfig({ ...bindings('api'), ...patch }, 'api')).toThrow('bindings');
    }
  });

  it('rejects every Clerk secret binding on the public Worker and requires one only on the private Worker', () => {
    expect(() => readWorkerConfig({ ...bindings('api'), CLERK_SECRET_KEY: ['sk', 'test', 'fixture'].join('_') }, 'api')).toThrow();
    const privateBindings = bindings('provisioner');
    delete privateBindings.CLERK_SECRET_KEY;
    expect(() => readWorkerConfig(privateBindings, 'provisioner')).toThrow();
    expect(readWorkerConfig(bindings('provisioner'), 'provisioner').secretKey).toBeDefined();
  });

  it('returns safe configuration errors before opening pools', async () => {
    const response = await apiWorker.fetch(bootstrapRequest(), { ...bindings('api'), APP_ENVIRONMENT: 'production' }, context());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('fixture');
    expect(mocks.runtimePool).not.toHaveBeenCalled();
  });

  it('rejects all public access bindings and direct access DSNs, and requires a distinct valid private access binding', () => {
    const privateBindings = bindings('provisioner');
    for (const patch of [{ ACCESS_DATABASE: privateBindings.ACCESS_DATABASE! },
      { EXPECTED_ACCESS_DATABASE_USER: 'pactwoven_access' }, { ACCESS_DATABASE_URL: 'not-permitted' }]) {
      expect(() => readWorkerConfig({ ...bindings('api'), ...patch }, 'api')).toThrow();
    }
    for (const patch of [{ ACCESS_DATABASE: undefined }, { EXPECTED_ACCESS_DATABASE_USER: undefined },
      { ACCESS_DATABASE_URL: 'not-permitted' }, { EXPECTED_ACCESS_DATABASE_USER: privateBindings.EXPECTED_DATABASE_USER },
      { ACCESS_DATABASE: privateBindings.DATABASE },
      { ACCESS_DATABASE: { ...privateBindings.ACCESS_DATABASE!, connectionString: `${privateBindings.ACCESS_DATABASE!.connectionString}?options=role` } },
      { ACCESS_DATABASE: { ...privateBindings.ACCESS_DATABASE!, database: 'production' } }]) {
      expect(() => readWorkerConfig({ ...privateBindings, ...patch } as WorkerBindings, 'provisioner')).toThrow();
    }
  });

  it('shares only within one request resource and safely handles failed initialization', async () => {
    const end = vi.fn(async () => {}), factory = vi.fn(async () => ({ end }));
    const resource = requestResource(factory);
    const [a, b] = await Promise.all([resource.get(), resource.get()]);
    expect(a).toBe(b);
    expect(factory).toHaveBeenCalledOnce();
    await resource.close();
    expect(end).toHaveBeenCalledOnce();
    const failed = requestResource(async () => { throw new Error('private driver detail'); });
    await expect(failed.get()).rejects.toThrow();
    await expect(failed.close()).resolves.toBeUndefined();
  });
});

describe('private access Worker integration', () => {
  const accessCommand = { expectedVersion: 0, mandateVersion: null, authorityEpoch: 0, payload: {
    externalMembershipId: 'target_member', externalSubject: 'target_subject', roles: ['receiver'], siteIds: ['test_site'], actionSiteIds: ['test_site'], expiresAt: null,
  } };
  const accessPage = () => ({ items: [], nextCursor: null, observedAt: new Date().toISOString(), authorityEpoch: 0 });
  const request = (path: string, body?: unknown) => new Request(`https://api.example${path}`, {
    method: body === undefined ? 'GET' : 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  it('independently re-verifies list and candidate tokens with one access pool and no other database role', async () => {
    mocks.members.mockImplementation(async () => accessPage());
    mocks.candidateList.mockImplementation(async () => ({ items: [], nextCursor: null, observedAt: new Date().toISOString() }));
    const ctx = context();
    expect((await apiWorker.fetch(request('/v1/members'), bindings('api'), ctx)).status).toBe(200);
    expect((await apiWorker.fetch(request('/v1/members/candidates'), bindings('api'), ctx)).status).toBe(200);
    await ctx.done();
    expect(mocks.verifyIdentity).toHaveBeenCalledTimes(5);
    for (const [token] of mocks.verifyIdentity.mock.calls) expect(token).toBe('synthetic-worker-token');
    expect(mocks.accessPool).toHaveBeenCalledTimes(2);
    for (const result of mocks.accessPool.mock.results) expect((await result.value).end).toHaveBeenCalledOnce();
    expect(mocks.runtimePool).not.toHaveBeenCalled(); expect(mocks.provisionerPool).not.toHaveBeenCalled();
    expect(mocks.verifyStepUp).not.toHaveBeenCalled();
  });

  it('resolves accepted target and verifies MFA privately using the original token before the isolated mutation', async () => {
    mocks.members.mockImplementation(async () => accessPage());
    const target = { externalOrganizationId: identity.externalOrganizationId, externalMembershipId: 'target_member', externalSubject: 'target_subject',
      displayName: 'Target member', externalRole: 'org:member', observedAt: new Date().toISOString() };
    const verified = { identity, evidence: { id: 'private_mfa_fixture' } };
    mocks.candidateResolve.mockResolvedValue(target); mocks.verifyStepUp.mockResolvedValue(verified); mocks.accessChange.mockResolvedValue(operation);
    const ctx = context();
    const response = await apiWorker.fetch(request('/v1/members/grant', accessCommand), bindings('api'), ctx);
    expect(response.status).toBe(201); expect(await response.json()).toEqual(operation);
    expect(mocks.verifyIdentity).toHaveBeenCalledTimes(2);
    expect(mocks.verifyStepUp).toHaveBeenCalledExactlyOnceWith('synthetic-worker-token');
    expect(mocks.accessChange).toHaveBeenCalledExactlyOnceWith(verified, headers['Idempotency-Key'], { kind: 'grant', command: accessCommand, target }, 'worker_trace');
    await ctx.done();
    expect(mocks.accessPool).toHaveBeenCalledOnce(); expect((await mocks.accessPool.mock.results[0]?.value).end).toHaveBeenCalledOnce();
    expect(mocks.runtimePool).not.toHaveBeenCalled(); expect(mocks.provisionerPool).not.toHaveBeenCalled();
  });

  it('rejects revoked identity or insufficient MFA independently without the access effect', async () => {
    mocks.verifyIdentity.mockResolvedValueOnce(identity).mockRejectedValueOnce(new DomainError('AUTH_REQUIRED', 401, 'Revoked'));
    const ctx = context();
    expect((await apiWorker.fetch(request('/v1/members/grant', accessCommand), bindings('api'), ctx)).status).toBe(401);
    expect(mocks.accessPool).not.toHaveBeenCalled();
    mocks.verifyIdentity.mockResolvedValue(identity);
    mocks.verifyStepUp.mockRejectedValue(new DomainError('STEP_UP_REQUIRED', 403, 'Private MFA detail'));
    const response = await apiWorker.fetch(request('/v1/members/target_actor/revoke', { expectedVersion: 1, mandateVersion: null, authorityEpoch: 0,
      payload: { reason: 'Access ended' } }), bindings('api'), ctx);
    expect(response.status).toBe(403); expect(await response.text()).not.toContain('Private MFA detail');
    expect(mocks.accessPool).not.toHaveBeenCalled(); expect(mocks.accessChange).not.toHaveBeenCalled();
    await ctx.done();
  });

  it('reads unknown operation state through access recovery without a new mutation and closes failed pools safely', async () => {
    const ctx = context(), unknown = { ...operation, status: 'unknown', error: { code: 'OUTCOME_UNKNOWN', retryable: false, detailRef: null } };
    mocks.accessOperation.mockResolvedValue(unknown);
    const response = await apiWorker.fetch(request(`/v1/member-access/operations?kind=grant&key=${headers['Idempotency-Key']}`), bindings('api'), ctx);
    expect(response.status).toBe(200); expect(await response.json()).toEqual(unknown);
    mocks.members.mockRejectedValue(new Error('private-access-driver-details'));
    const failed = await apiWorker.fetch(request('/v1/members'), bindings('api'), ctx);
    expect(failed.status).toBe(503); expect(await failed.text()).not.toContain('private-access-driver-details');
    await ctx.done();
    for (const result of mocks.accessPool.mock.results) expect((await result.value).end).toHaveBeenCalledOnce();
    expect(mocks.accessChange).not.toHaveBeenCalled(); expect(mocks.provisionerPool).not.toHaveBeenCalled(); expect(mocks.runtimePool).not.toHaveBeenCalled();
  });
});

describe('private identity verification boundary', () => {
  const issuer = 'https://worker-fixture.clerk.accounts.dev';
  const verifyRequest = (body: unknown, extraHeaders: Record<string, string> = {}) => new Request(identityUrl, {
    method: 'POST', headers: { Authorization: authorization, 'Content-Type': 'application/json', ...extraHeaders }, body: JSON.stringify(body),
  });

  it('requires the original token exactly and never forwards asserted identity fields', async () => {
    const fetch = vi.fn(async (request: Request) => verifyPrivateIdentityRequest(request, issuer, mocks.verifyIdentity));
    const verify = serviceIdentityVerifier({ fetch }, authorization, issuer);
    await expect(verify('different-token')).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(fetch).not.toHaveBeenCalled();
    expect(await verify('synthetic-worker-token')).toEqual(identity);
    const request = fetch.mock.calls[0]![0];
    expect(request.url).toBe(identityUrl);
    expect(request.headers.get('Authorization')).toBe(authorization);
    expect(mocks.verifyIdentity).toHaveBeenCalledExactlyOnceWith('synthetic-worker-token');
    expect(mocks.runtimePool).not.toHaveBeenCalled();
    expect(mocks.provisionerPool).not.toHaveBeenCalled();
  });

  it('rejects caller-provided identity, malformed nonce, non-JSON or oversized request before verifying', async () => {
    for (const request of [verifyRequest({ nonce: crypto.randomUUID(), identity }), verifyRequest({ nonce: 'not-a-nonce' }),
      verifyRequest({ nonce: crypto.randomUUID() }, { 'Content-Type': 'text/plain' }), verifyRequest({ nonce: 'x'.repeat(1025) })]) {
      expect((await verifyPrivateIdentityRequest(request, issuer, mocks.verifyIdentity)).status).toBe(422);
    }
    expect(mocks.verifyIdentity).not.toHaveBeenCalled();
  });

  it('requires signed bearer credentials even if privileged identity headers are present', async () => {
    const request = verifyRequest({ nonce: crypto.randomUUID() }, { Authorization: '', 'X-Actor-Id': 'owner', 'X-Organization-Id': 'other' });
    expect((await verifyPrivateIdentityRequest(request, issuer, mocks.verifyIdentity)).status).toBe(401);
    expect(mocks.verifyIdentity).not.toHaveBeenCalled();
  });

  it('rejects tampered nonce/token, issuer/environment, stale observation and extra identity fields', async () => {
    const changes = [
      (data: Record<string, any>) => { data.nonce = crypto.randomUUID(); },
      (data: Record<string, any>) => { data.tokenHash = 'f'.repeat(64); },
      (data: Record<string, any>) => { data.issuer = 'https://other.clerk.accounts.dev'; },
      (data: Record<string, any>) => { data.environment = 'production'; },
      (data: Record<string, any>) => { data.verifiedAt = new Date(Date.now() - 60_000).toISOString(); },
      (data: Record<string, any>) => { data.verifiedAt = new Date(Date.now() + 60_000).toISOString(); },
      (data: Record<string, any>) => { data.identity.membershipObservedAt = new Date(Date.now() - 60_000).toISOString(); },
      (data: Record<string, any>) => { data.identity.roles = ['owner']; },
      (data: Record<string, any>) => { data.identity.externalMembershipId = ''; },
      (data: Record<string, any>) => { data.identity.authenticatedAt = new Date(Date.now() + 60_000).toISOString(); },
    ];
    for (const change of changes) {
      const fetch = vi.fn(async (request: Request) => {
        const response = await verifyPrivateIdentityRequest(request, issuer, mocks.verifyIdentity);
        const data = await response.json() as Record<string, any>;
        change(data);
        return Response.json(data);
      });
      const verify = serviceIdentityVerifier({ fetch }, authorization, issuer);
      await expect(verify('synthetic-worker-token')).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' });
      expect(fetch).toHaveBeenCalledOnce();
    }
  });

  it('rejects replaying an otherwise valid private response for another request nonce', async () => {
    let prior: unknown;
    const fetch = vi.fn(async (request: Request) => {
      prior ??= await (await verifyPrivateIdentityRequest(request, issuer, mocks.verifyIdentity)).json();
      return Response.json(prior);
    });
    const verify = serviceIdentityVerifier({ fetch }, authorization, issuer);
    expect(await verify('synthetic-worker-token')).toEqual(identity);
    await expect(verify('synthetic-worker-token')).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' });
  });

  it('does not expose private identity provider details or accept mismatched error status/code', async () => {
    mocks.verifyIdentity.mockRejectedValue(new Error('private-provider-details'));
    const response = await verifyPrivateIdentityRequest(verifyRequest({ nonce: crypto.randomUUID() }), issuer, mocks.verifyIdentity);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('private-provider-details');
    const verify = serviceIdentityVerifier({ fetch: async () => Response.json({ error: { code: 'AUTH_REQUIRED' } }, { status: 200 }) }, authorization, issuer);
    await expect(verify('synthetic-worker-token')).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' });
  });

  it('caps identity response intake at 8 KiB and cancels the remaining stream', async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(8193)); }, cancel }));
    const verify = serviceIdentityVerifier({ fetch: async () => response }, authorization, issuer);
    await expect(verify('synthetic-worker-token')).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('times out private body intake before live authorization', async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn();
      const request = new Request(identityUrl, { method: 'POST', headers, body: new ReadableStream({ cancel }), duplex: 'half' } as RequestInit);
      const pending = verifyPrivateIdentityRequest(request, issuer, mocks.verifyIdentity);
      await vi.advanceTimersByTimeAsync(5_001);
      expect((await pending).status).toBe(422);
      expect(mocks.verifyIdentity).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it('bounds an unresponsive identity service without retrying or opening the database', async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn(async () => new Response(new ReadableStream()));
      const verify = serviceIdentityVerifier({ fetch }, authorization, issuer);
      const pending = verify('synthetic-worker-token');
      const rejection = expect(pending).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' });
      // crypto.subtle is asynchronous outside fake timers; let the request start.
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(20_001);
      await rejection;
      expect(fetch).toHaveBeenCalledOnce();
      expect(mocks.runtimePool).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});
