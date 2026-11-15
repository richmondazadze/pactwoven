import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccessRecoveryResult, CloseAccessRecoveryIntent } from '@pactwoven/contracts';
import type { AccessRecoveryVerificationRequest, VerifiedIdentity } from '@pactwoven/db';
import { commandDigest, DomainError } from '@pactwoven/domain';
import apiWorker from './worker.js';
import provisionerWorker from './provisioner-worker.js';
import { accessRecoveryUrl } from './worker-access-recovery.js';
import { identityUrl } from './worker-identity.js';
import type { WorkerBindings, WorkerContext } from './worker-config.js';

const mocks = vi.hoisted(() => ({ accessPool: vi.fn(), runtimePool: vi.fn(), provisionerPool: vi.fn(),
  identity: vi.fn(), mfa: vi.fn(), get: vi.fn(), close: vi.fn() }));
vi.mock('@pactwoven/db', async importOriginal => ({ ...await importOriginal<typeof import('@pactwoven/db')>(),
  createAccessPool: mocks.accessPool, createRuntimePool: mocks.runtimePool, createProvisionerPool: mocks.provisionerPool,
  PostgresAccessRecoveryRepository: class {
    get(...args: unknown[]) { return mocks.get(...args); }
    close(...args: unknown[]) { return mocks.close(...args); }
  },
}));
vi.mock('./auth.js', () => ({ createClerkIdentityVerifier: () => mocks.identity,
  createClerkAccessRecoveryStepUpVerifier: () => mocks.mfa }));

const issuer = 'https://recovery-fixture.clerk.accounts.dev', token = 'synthetic-recovery-token', key = 'recovery_worker_key_001';
const identity: VerifiedIdentity = { subject: 'owner_user', externalOrganizationId: 'provider_org', externalOrganizationName: 'Recovery fixture',
  externalMembershipId: 'owner_membership', externalRole: 'org:admin', membershipObservedAt: '2026-11-15T06:00:00Z',
  sessionId: 'owner_session', authenticatedAt: '2026-11-15T05:00:00Z' };
const intent: CloseAccessRecoveryIntent = { schemaVersion: 1, kind: 'revise', reason: 'original_input_unavailable',
  expectedEnvironment: 'development', expectedOrganizationId: 'internal_org', expectedActorId: 'owner_actor',
  expectedExternalMembershipId: 'owner_membership', expectedAuthorityEpoch: 7 };
function result(disposition: AccessRecoveryResult['disposition'] = 'not_recorded'): AccessRecoveryResult {
  const now = new Date().toISOString();
  const envelope = { schemaVersion: 1 as const, environment: 'development' as const, organizationId: 'internal_org', externalOrganizationId: 'provider_org',
    kind: 'revise' as const, key, observedAt: now, reviewer: { actorId: 'owner_actor', externalMembershipId: 'owner_membership', authorityEpoch: 7 } };
  if (disposition === 'fenced') return { ...envelope, disposition, fence: { id: 'fence_id', closedAt: now } };
  if (disposition === 'recorded') return { ...envelope, disposition, operation: { id: 'operation_id', environment: 'development', status: 'succeeded',
    aggregateId: 'member_id', aggregateVersion: 2, financialState: null, evidenceRefs: [], nextCheckAt: null, error: null } };
  return { ...envelope, disposition };
}
function context() {
  const pending: Promise<unknown>[] = [];
  return { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); }, done: () => Promise.all(pending) } satisfies WorkerContext & { done(): Promise<unknown[]> };
}
function bindings(role: 'api' | 'provisioner'): WorkerBindings {
  const user = role === 'api' ? 'pactwoven_app' : 'pactwoven_identity';
  const url = new URL('postgresql://hyperdrive.local:5432/pactwoven_dev'); url.username = user; url.password = 'fixture';
  const access = new URL(url); access.username = 'pactwoven_access';
  return { APP_ENVIRONMENT: 'development', WORKER_ROLE: role, ALLOWED_ORIGINS: 'http://127.0.0.1:3001',
    CLERK_ISSUER: issuer, CLERK_PUBLISHABLE_KEY: `pk_test_${btoa('recovery-fixture.clerk.accounts.dev$').replace(/=+$/, '')}`,
    EXPECTED_DATABASE_USER: user, DATABASE: { connectionString: url.href, host: 'hyperdrive.local', port: 5432, user, database: 'pactwoven_dev' },
    ...(role === 'provisioner' ? { CLERK_SECRET_KEY: ['sk', 'test', 'fixture'].join('_'), EXPECTED_ACCESS_DATABASE_USER: 'pactwoven_access',
      ACCESS_DATABASE: { connectionString: access.href, host: 'hyperdrive.local', port: 5432, user: 'pactwoven_access', database: 'pactwoven_dev' } } : {}),
  };
}
function request(action: 'get' | 'close' = 'close', body: unknown = intent) {
  const url = action === 'get' ? `/v1/member-access/recovery?kind=revise&key=${key}` : '/v1/member-access/recovery/close';
  return new Request(`https://api.example${url}`, { method: action === 'get' ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': key,
      'X-Correlation-Id': 'recovery_trace', 'X-Actor-Id': 'untrusted_actor', 'X-Mfa-Verified': 'true' },
    ...(action === 'close' ? { body: JSON.stringify(body) } : {}) });
}
async function joined(source: Request = request()) {
  const publicContext = context(), privateContext = context(), env = bindings('api');
  const dispatched: { nonce: string; action: unknown }[] = [];
  env.IDENTITY_PROVISIONER = { fetch: async incoming => {
    if (incoming.url === accessRecoveryUrl) {
      expect([...incoming.headers.keys()].sort()).toEqual(['authorization', 'content-type']);
      dispatched.push(await incoming.clone().json());
    } else expect(incoming.url).toBe(identityUrl);
    return provisionerWorker.fetch(incoming, bindings('provisioner'), privateContext);
  } };
  const response = await apiWorker.fetch(source, env, publicContext);
  await Promise.all([publicContext.done(), privateContext.done()]);
  return { response, dispatched };
}
beforeEach(() => {
  vi.resetAllMocks(); identity.membershipObservedAt = new Date().toISOString(); mocks.identity.mockResolvedValue(identity);
  mocks.accessPool.mockImplementation(async () => ({ end: vi.fn(async () => {}), query: vi.fn(async () => ({ rows: [{ database_matches: true, current_matches: true, session_matches: true }] })) }));
  mocks.get.mockImplementation(async () => result()); mocks.close.mockImplementation(async () => result('fenced'));
  mocks.mfa.mockImplementation(async (_token: string, input: AccessRecoveryVerificationRequest) => {
    const now = Date.now(), issued = Math.floor(now / 1000) * 1000;
    return { identity, evidence: { id: crypto.randomUUID(), purpose: 'member_access_recovery_close', requestNonce: input.nonce,
      kind: input.intent.kind, key: input.key, scope: input.scope, intentHash: await commandDigest(input.intent),
      requestHash: await commandDigest({ schemaVersion: 1, purpose: 'member_access_recovery_close', request: input }),
      subject: identity.subject, externalOrganizationId: identity.externalOrganizationId, externalMembershipId: identity.externalMembershipId,
      sessionId: identity.sessionId, issuer, tokenHash: 'b'.repeat(64), tokenIssuedAt: new Date(issued).toISOString(),
      firstFactorAgeMinutes: 0, secondFactorAgeMinutes: 0, verifiedAt: new Date(issued - 60_000).toISOString(),
      observedAt: new Date(now).toISOString(), expiresAt: new Date(issued + 60_000).toISOString() } };
  });
});

describe('access recovery Worker composition', () => {
  it('binds the original token, validated outer nonce and resolved scope to the dedicated verifier', async () => {
    const { response, dispatched } = await joined(); expect(response.status).toBe(200); expect((await response.json()).disposition).toBe('fenced');
    expect(dispatched).toHaveLength(1); expect(mocks.identity).toHaveBeenCalledTimes(2);
    for (const call of mocks.identity.mock.calls) expect(call).toEqual([token]);
    expect(mocks.mfa).toHaveBeenCalledExactlyOnceWith(token, { nonce: dispatched[0]!.nonce, key, intent,
      scope: { environment: 'development', organizationId: 'internal_org', actorId: 'owner_actor', externalOrganizationId: 'provider_org', externalMembershipId: 'owner_membership' } });
    expect(mocks.close).toHaveBeenCalledOnce(); expect(mocks.close.mock.calls[0]?.[0]).toMatchObject({ identity,
      evidence: { purpose: 'member_access_recovery_close', requestNonce: dispatched[0]!.nonce } });
    expect(mocks.close.mock.calls[0]?.slice(1)).toEqual([key, intent, 'recovery_trace']);
    expect(mocks.accessPool).toHaveBeenCalledOnce(); expect((await mocks.accessPool.mock.results[0]!.value).end).toHaveBeenCalledOnce();
    expect((await mocks.accessPool.mock.results[0]!.value).query).toHaveBeenCalledWith(expect.stringContaining('session_user'), ['pactwoven_dev', 'pactwoven_access']);
    expect(mocks.runtimePool).not.toHaveBeenCalled(); expect(mocks.provisionerPool).not.toHaveBeenCalled();
  });
  it('uses typed GET without factors or writes and closes its access pool', async () => {
    const { response } = await joined(request('get')); expect(response.status).toBe(200); expect((await response.json()).disposition).toBe('not_recorded');
    expect(mocks.get).toHaveBeenCalledExactlyOnceWith(identity, { kind: 'revise', key }, 'recovery_trace');
    expect(mocks.mfa).not.toHaveBeenCalled(); expect(mocks.close).not.toHaveBeenCalled();
    expect((await mocks.accessPool.mock.results[0]!.value).end).toHaveBeenCalledOnce();
  });
  it.each(['recorded', 'fenced'] as const)('keeps existing %s truth after epoch drift while still verifying fresh closure factors', async disposition => {
    mocks.get.mockImplementation(async () => ({ ...result(disposition), reviewer: { ...result().reviewer, authorityEpoch: 9 } }));
    mocks.close.mockImplementation(async () => ({ ...result(disposition), reviewer: { ...result().reviewer, authorityEpoch: 9 } }));
    const { response } = await joined(); expect(response.status).toBe(200); expect((await response.json()).reviewer.authorityEpoch).toBe(9);
    expect(mocks.mfa).toHaveBeenCalledOnce(); expect(mocks.close).toHaveBeenCalledOnce();
  });
  it('fails closed on membership revocation between public and private verification before opening a pool', async () => {
    mocks.identity.mockResolvedValueOnce(identity).mockRejectedValueOnce(new DomainError('AUTH_REQUIRED', 401, 'PRIVATE_SENTINEL'));
    const { response } = await joined(); expect(response.status).toBe(401); expect(await response.text()).not.toContain('PRIVATE_SENTINEL');
    expect(mocks.accessPool).not.toHaveBeenCalled(); expect(mocks.mfa).not.toHaveBeenCalled(); expect(mocks.close).not.toHaveBeenCalled();
  });
  it('refuses public evidence fields before recovery dispatch', async () => {
    const { response, dispatched } = await joined(request('close', { ...intent, evidence: { purpose: 'member_access_recovery_close' } }));
    expect(response.status).toBe(422); expect(dispatched).toEqual([]); expect(mocks.accessPool).not.toHaveBeenCalled();
  });
  it('keeps missing migration readiness explicit without attempting closure', async () => {
    mocks.get.mockRejectedValueOnce(new DomainError('SETUP_REQUIRED', 503, 'PRIVATE_SENTINEL'));
    const { response } = await joined(); expect(response.status).toBe(503); const body = await response.json();
    expect(body.error.code).toBe('SETUP_REQUIRED'); expect(JSON.stringify(body)).not.toContain('PRIVATE_SENTINEL');
    expect(mocks.close).not.toHaveBeenCalled(); expect(mocks.mfa).not.toHaveBeenCalled();
    expect((await mocks.accessPool.mock.results[0]!.value).end).toHaveBeenCalledOnce();
  });
  it.each(['STEP_UP_REQUIRED', 'VERSION_CONFLICT', 'DURABLE_SERVICE_UNAVAILABLE'] as const)('keeps %s safe, does not retry and closes the pool', async code => {
    mocks.close.mockRejectedValueOnce(new DomainError(code, code === 'STEP_UP_REQUIRED' ? 403 : code === 'VERSION_CONFLICT' ? 409 : 503, 'PRIVATE_SENTINEL'));
    const { response } = await joined(); const body = await response.json(); expect(body.error.code).toBe(code);
    expect(JSON.stringify(body)).not.toContain('PRIVATE_SENTINEL'); expect(mocks.close).toHaveBeenCalledOnce();
    expect((await mocks.accessPool.mock.results[0]!.value).end).toHaveBeenCalledOnce();
  });
  it('does not accept absence as a completed close', async () => {
    mocks.close.mockImplementationOnce(async () => result()); const { response } = await joined(); expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe('DURABLE_SERVICE_UNAVAILABLE'); expect(mocks.close).toHaveBeenCalledOnce();
  });
  it('owns independent pools and verifier nonces for concurrent requests', async () => {
    const responses = await Promise.all([joined(), joined()]); expect(responses.map(value => value.response.status)).toEqual([200, 200]);
    expect(new Set(responses.map(value => value.dispatched[0]?.nonce)).size).toBe(2); expect(mocks.accessPool).toHaveBeenCalledTimes(2);
    expect(new Set(mocks.mfa.mock.calls.map(call => call[1].nonce)).size).toBe(2);
    for (const pool of mocks.accessPool.mock.results) expect((await pool.value).end).toHaveBeenCalledOnce();
  });
  it('rejects non-exact private routes and malformed intake before provider or database work', async () => {
    const ctx = context();
    for (const source of [new Request(accessRecoveryUrl), new Request(`${accessRecoveryUrl}?extra=1`, { method: 'POST' }),
      new Request('https://public.example/internal/access-recovery/dispatch', { method: 'POST' })]) {
      expect((await provisionerWorker.fetch(source, bindings('provisioner'), ctx)).status).toBe(404);
    }
    expect((await provisionerWorker.fetch(new Request(accessRecoveryUrl, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' }), bindings('provisioner'), ctx)).status).toBe(422);
    await ctx.done(); expect(mocks.identity).not.toHaveBeenCalled(); expect(mocks.accessPool).not.toHaveBeenCalled();
  });
  it('sanitizes a failed access pool without falling back to another database capability', async () => {
    mocks.accessPool.mockRejectedValueOnce(new Error('PRIVATE_CONNECTION_SENTINEL'));
    const { response } = await joined(); expect(response.status).toBe(503); expect(await response.text()).not.toContain('PRIVATE_CONNECTION_SENTINEL');
    expect(mocks.close).not.toHaveBeenCalled(); expect(mocks.runtimePool).not.toHaveBeenCalled(); expect(mocks.provisionerPool).not.toHaveBeenCalled();
  });
});
