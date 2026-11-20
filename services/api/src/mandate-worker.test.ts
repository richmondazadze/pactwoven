import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MandateAuthorityIntent, MandateDecisionIntent, MandateOperationResult } from '@pactwoven/contracts';
import type { MandateVerificationRequest, VerifiedIdentity } from '@pactwoven/db';
import { DomainError, mandateIntentHash } from '@pactwoven/domain';
import apiWorker from './worker.js';
import mandateWorker from './mandate-worker.js';
import { mandateUrl } from './worker-mandate.js';
import { identityUrl, verifyPrivateIdentityRequest } from './worker-identity.js';
import type { WorkerBindings, WorkerContext } from './worker-config.js';
import { documentReadFixture } from './mandate-document.test-fixtures.js';

const mocks = vi.hoisted(() => ({ pool: vi.fn(), runtimePool: vi.fn(), identity: vi.fn(), mfa: vi.fn(), directory: vi.fn(),
  readDocument: vi.fn(), list: vi.fn(), review: vi.fn(), operation: vi.fn(), requester: vi.fn(), mutate: vi.fn() }));
vi.mock('@pactwoven/db', async importOriginal => ({ ...await importOriginal<typeof import('@pactwoven/db')>(),
  createMandatePool: mocks.pool, createRuntimePool: mocks.runtimePool,
  PostgresMandateRepository: class {
    readDocument(...args: unknown[]) { return mocks.readDocument(...args); }
    list(...args: unknown[]) { return mocks.list(...args); }
    review(...args: unknown[]) { return mocks.review(...args); }
    operation(...args: unknown[]) { return mocks.operation(...args); }
    requester(...args: unknown[]) { return mocks.requester(...args); }
    mutate(...args: unknown[]) { return mocks.mutate(...args); }
  },
}));
vi.mock('./auth.js', () => ({ createClerkIdentityVerifier: () => mocks.identity, createClerkMandateStepUpVerifier: () => mocks.mfa }));
vi.mock('./access-service.js', async importOriginal => ({ ...await importOriginal<typeof import('./access-service.js')>(),
  createClerkMembershipDirectory: () => ({ resolve: mocks.directory }),
}));

const issuer = 'https://worker-fixture.clerk.accounts.dev', token = 'synthetic-mandate-token', key = 'mandate_worker_key_001';
const identity: VerifiedIdentity = { subject: 'owner_a', externalOrganizationId: 'external_org', externalOrganizationName: 'Mandate Worker',
  externalMembershipId: 'owner_member', externalRole: 'org:admin', membershipObservedAt: '2026-11-15T06:00:00Z',
  sessionId: 'owner_session', authenticatedAt: '2026-11-15T05:00:00Z' };
const intent: MandateDecisionIntent = { schemaVersion: 1, action: 'AUTHORIZE', proposal: { id: 'proposal_a', version: 1, hash: 'a'.repeat(64) },
  expectedDecisionVersion: 1, expectedOrganizationEpoch: 2, expectedHead: null, reason: null };
const control: MandateAuthorityIntent = { schemaVersion: 1, action: 'RESUME', mandate: { id: 'mandate_a', version: 1, hash: 'b'.repeat(64) },
  head: { mandateId: 'mandate_a', mandateVersion: 1, mandateEpoch: 7, hash: 'c'.repeat(64) },
  responsibility: { id: 'responsibility_a', version: 1, siteId: 'site_a', hash: 'd'.repeat(64) }, expectedOrganizationEpoch: 2, reason: 'Resume advice.' };
function context() {
  const pending: Promise<unknown>[] = [];
  return { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); }, done: () => Promise.all(pending) } satisfies WorkerContext & { done(): Promise<unknown[]> };
}
function binding(role: 'api' | 'mandate'): WorkerBindings {
  const user = role === 'api' ? 'pactwoven_app' : 'pactwoven_mandate';
  const url = new URL('postgresql://hyperdrive.local:5432/pactwoven_dev');
  url.username = user;
  url.password = 'fixture';
  const database = { connectionString: url.href,
    host: 'hyperdrive.local', port: 5432, user, database: 'pactwoven_dev' };
  return { APP_ENVIRONMENT: 'development', WORKER_ROLE: role, ALLOWED_ORIGINS: 'http://127.0.0.1:3001',
    CLERK_ISSUER: issuer, CLERK_PUBLISHABLE_KEY: `pk_test_${btoa('worker-fixture.clerk.accounts.dev$').replace(/=+$/, '')}`,
    ...(role === 'api' ? { DATABASE: database, EXPECTED_DATABASE_USER: user,
      IDENTITY_PROVISIONER: { fetch: (request: Request) => verifyPrivateIdentityRequest(request, issuer, mocks.identity) } }
      : { MANDATE_DATABASE: database, EXPECTED_MANDATE_DATABASE_USER: user, CLERK_SECRET_KEY: ['sk', 'test', 'fixture'].join('_') }) };
}
function request(command: unknown = intent, path = '/v1/responsibilities/responsibility_a/mandate-proposals/proposal_a/decision') {
  return new Request(`https://api.example${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json', 'Idempotency-Key': key, 'X-Correlation-Id': 'mandate_trace',
    'X-Actor-Id': 'untrusted_actor', 'X-Mfa-Verified': 'true' }, body: JSON.stringify(command) });
}
async function result(command: MandateDecisionIntent | MandateAuthorityIntent = intent): Promise<MandateOperationResult> {
  const authority = 'mandate' in command, id = authority ? command.mandate.id : command.proposal.id;
  const version = authority ? command.head.mandateEpoch + 1 : command.expectedDecisionVersion + 1;
  return { schemaVersion: 1, organizationId: 'org_a', responsibilityId: 'responsibility_a',
    kind: `mandate.${command.action.toLowerCase()}` as MandateOperationResult['kind'],
    operation: { id: 'operation_a', environment: 'development', status: 'succeeded', aggregateId: id, aggregateVersion: version,
      financialState: null, evidenceRefs: [], nextCheckAt: null, error: null },
    target: { kind: authority ? 'authority' : 'decision', id, version, hash: 'f'.repeat(64) },
    commandHash: 'e'.repeat(64), intentHash: await mandateIntentHash(command), observedAt: new Date().toISOString() };
}
async function joined(command: unknown = intent, path?: string) {
  const publicContext = context(), privateContext = context(), publicBindings = binding('api');
  let wire: any;
  const privateFetch = vi.fn(async (source: Request) => {
    expect(source.url).toBe(mandateUrl);
    expect([...source.headers.keys()].sort()).toEqual(['authorization', 'content-type']);
    wire = await source.clone().json();
    return mandateWorker.fetch(source, binding('mandate'), privateContext);
  });
  publicBindings.MANDATE_AUTHORITY = { fetch: privateFetch };
  const response = await apiWorker.fetch(request(command, path), publicBindings, publicContext);
  await Promise.all([publicContext.done(), privateContext.done()]);
  return { response, wire, privateFetch };
}
beforeEach(() => {
  vi.resetAllMocks(); identity.membershipObservedAt = new Date().toISOString(); mocks.identity.mockResolvedValue(identity);
  mocks.pool.mockImplementation(async () => ({ end: vi.fn(async () => {}), query: vi.fn(async () => ({ rows: [{ database_matches: true, current_matches: true, session_matches: true }] })) }));
  mocks.requester.mockResolvedValue({ externalSubject: 'requester_a', externalMembershipId: 'requester_member' });
  mocks.directory.mockResolvedValue({ externalOrganizationId: identity.externalOrganizationId, externalSubject: 'requester_a',
    externalMembershipId: 'requester_member', externalRole: 'org:member', displayName: 'Requester', observedAt: new Date().toISOString() });
  mocks.mfa.mockImplementation(async (_token: string, input: MandateVerificationRequest) => ({ identity,
    evidence: { purpose: input.intent.action === 'AUTHORIZE' ? 'mandate_authorization' : 'mandate_control', requestNonce: input.nonce } }));
  mocks.mutate.mockImplementation(async (_proof, _id, _key, mutation) => result(mutation.intent));
  mocks.operation.mockImplementation(async () => result());
});

describe('mandate Worker composition', () => {
  it('reads an exact standalone document through the mandate pool without mutation, requester lookup or MFA', async () => {
    const document = await documentReadFixture(); mocks.readDocument.mockResolvedValue(document);
    const ctx = context(), privateCtx = context(), env = binding('api');
    env.MANDATE_AUTHORITY = { fetch: req => mandateWorker.fetch(req, binding('mandate'), privateCtx) };
    const response = await apiWorker.fetch(new Request('https://api.example/v1/responsibilities/responsibility_a/mandate-policy-documents/policy_a?version=1',
      { headers: { Authorization: `Bearer ${token}` } }), env, ctx);
    await Promise.all([ctx.done(), privateCtx.done()]);
    expect(response.status).toBe(200); expect(await response.json()).toEqual(document);
    expect(mocks.identity).toHaveBeenCalledTimes(2);
    expect(mocks.readDocument).toHaveBeenCalledExactlyOnceWith(identity, 'responsibility_a', 'policy_a', { version: 1 }, expect.any(String));
    expect(mocks.mutate).not.toHaveBeenCalled(); expect(mocks.mfa).not.toHaveBeenCalled(); expect(mocks.directory).not.toHaveBeenCalled();
    expect(mocks.runtimePool).not.toHaveBeenCalled(); expect(mocks.pool).toHaveBeenCalledOnce();
    expect((await mocks.pool.mock.results[0]!.value).query).toHaveBeenCalledWith(expect.stringContaining('current_user'), ['pactwoven_dev', 'pactwoven_mandate']);
    expect((await mocks.pool.mock.results[0]!.value).end).toHaveBeenCalledOnce();
  });
  it('binds original bearer and outer nonce to independently verified identity, original requester, MFA and one private pool', async () => {
    const { response, wire } = await joined();
    expect(response.status).toBe(200); expect((await response.json()).operation.id).toBe('operation_a');
    expect(mocks.identity).toHaveBeenCalledTimes(2);
    for (const call of mocks.identity.mock.calls) expect(call).toEqual([token]);
    expect(mocks.directory).toHaveBeenCalledExactlyOnceWith(identity, 'requester_member', 'requester_a');
    expect(mocks.mfa).toHaveBeenCalledExactlyOnceWith(token, { nonce: wire.nonce, key, intent });
    expect(mocks.mutate.mock.calls[0]?.[0]).toMatchObject({ identity, requestNonce: wire.nonce,
      evidence: { purpose: 'mandate_authorization', requestNonce: wire.nonce } });
    expect(mocks.mutate.mock.calls[0]?.slice(1)).toEqual(['responsibility_a', key, { kind: 'decide', proposalId: 'proposal_a', intent }, 'mandate_trace']);
    expect(mocks.pool).toHaveBeenCalledOnce(); expect(mocks.runtimePool).not.toHaveBeenCalled();
    expect((await mocks.pool.mock.results[0]!.value).end).toHaveBeenCalledOnce();
  });

  it('uses mandate-control verification only for resume, with head epoch target version', async () => {
    const { response, wire } = await joined(control, '/v1/responsibilities/responsibility_a/mandates/mandate_a/authority');
    expect(response.status).toBe(200); expect((await response.json()).target.version).toBe(8);
    expect(mocks.mfa).toHaveBeenCalledExactlyOnceWith(token, { nonce: wire.nonce, key, intent: control });
    expect(mocks.mutate.mock.calls[0]?.[0].evidence.purpose).toBe('mandate_control');
  });

  it.each(['PAUSE', 'REVOKE'] as const)('does not make %s depend on requester refresh or step-up', async action => {
    const { response } = await joined({ ...control, action }, '/v1/responsibilities/responsibility_a/mandates/mandate_a/authority');
    expect(response.status).toBe(200); expect(mocks.directory).not.toHaveBeenCalled(); expect(mocks.mfa).not.toHaveBeenCalled();
    expect(mocks.mutate.mock.calls[0]?.[0].evidence).toBeNull();
  });

  it('rejects revocation between public and private verification before opening a mandate pool', async () => {
    mocks.identity.mockResolvedValueOnce(identity).mockRejectedValueOnce(new DomainError('AUTH_REQUIRED', 401, 'private reason'));
    const { response } = await joined(); expect(response.status).toBe(401);
    expect(mocks.pool).not.toHaveBeenCalled(); expect(mocks.mutate).not.toHaveBeenCalled(); expect(mocks.mfa).not.toHaveBeenCalled();
    expect(await response.text()).not.toContain('private reason');
  });

  it('refuses forged public evidence before private dispatch', async () => {
    const { response, privateFetch } = await joined({ ...intent, evidence: { purpose: 'mandate_authorization' }, nonce: crypto.randomUUID() });
    expect(response.status).toBe(422); expect(privateFetch).not.toHaveBeenCalled(); expect(mocks.pool).not.toHaveBeenCalled();
  });

  it('keeps missing private setup explicit and never substitutes the runtime database', async () => {
    const ctx = context(), response = await apiWorker.fetch(request(), binding('api'), ctx); await ctx.done();
    expect(response.status).toBe(503); expect((await response.json()).error.code).toBe('SETUP_REQUIRED');
    expect(mocks.pool).not.toHaveBeenCalled(); expect(mocks.runtimePool).not.toHaveBeenCalled();
  });

  it.each(['SERVICE_UNAVAILABLE', 'OUTCOME_UNKNOWN', 'MANDATE_READ_INVALID'] as const)('sanitizes %s and closes the request-owned pool', async code => {
    mocks.mutate.mockRejectedValue(new DomainError(code, code === 'MANDATE_READ_INVALID' ? 409 : 503, 'PRIVATE_SENTINEL'));
    const { response } = await joined(); expect(response.status).toBe(code === 'MANDATE_READ_INVALID' ? 409 : 503);
    const body = await response.json(); expect(body.error.code).toBe(code); expect(JSON.stringify(body)).not.toContain('PRIVATE_SENTINEL');
    expect((await mocks.pool.mock.results[0]!.value).end).toHaveBeenCalledOnce();
  });

  it('looks up a prior operation without fresh MFA, requester fetch, or mutation', async () => {
    const ctx = context(), privateCtx = context(), env = binding('api');
    env.MANDATE_AUTHORITY = { fetch: req => mandateWorker.fetch(req, binding('mandate'), privateCtx) };
    const response = await apiWorker.fetch(new Request(`https://api.example/v1/mandate-operations?kind=mandate.authorize&key=${key}`,
      { headers: { Authorization: `Bearer ${token}` } }), env, ctx);
    await Promise.all([ctx.done(), privateCtx.done()]);
    expect(response.status).toBe(200); expect(mocks.operation).toHaveBeenCalledOnce();
    expect(mocks.mutate).not.toHaveBeenCalled(); expect(mocks.mfa).not.toHaveBeenCalled(); expect(mocks.directory).not.toHaveBeenCalled();
  });

  it('accepts only the exact private POST URL and rejects configuration crossover before authentication or DB work', async () => {
    const ctx = context();
    for (const req of [new Request(mandateUrl), request(), new Request(`${mandateUrl}?extra=1`, { method: 'POST' }),
      new Request(identityUrl, { method: 'POST' })]) expect((await mandateWorker.fetch(req, binding('mandate'), ctx)).status).toBe(404);
    const env = binding('mandate'); env.DATABASE = binding('api').DATABASE!;
    expect((await mandateWorker.fetch(new Request(mandateUrl, { method: 'POST' }), env, ctx)).status).toBe(503);
    await ctx.done(); expect(mocks.identity).not.toHaveBeenCalled(); expect(mocks.pool).not.toHaveBeenCalled();
  });

  it('isolates concurrent invocation pools and nonce-bound verification', async () => {
    const results = await Promise.all([joined(), joined()]);
    expect(results.map(value => value.response.status)).toEqual([200, 200]);
    expect(new Set(results.map(value => value.wire.nonce)).size).toBe(2);
    expect(mocks.pool).toHaveBeenCalledTimes(2);
    for (const pool of mocks.pool.mock.results) expect((await pool.value).end).toHaveBeenCalledOnce();
    expect(new Set(mocks.mfa.mock.calls.map(call => call[1].nonce)).size).toBe(2);
  });

  it('normalizes failed pool initialization without exposing driver detail or attempting a mutation', async () => {
    mocks.pool.mockRejectedValue(new Error('PRIVATE_CONNECTION_SENTINEL'));
    const { response } = await joined(); expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('PRIVATE_CONNECTION_SENTINEL'); expect(mocks.mutate).not.toHaveBeenCalled();
  });
});
