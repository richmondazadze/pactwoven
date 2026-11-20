import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DomainError } from '@pactwoven/domain';
import { financialUrl, serviceFinancialGateways } from './worker-financial.js';
import financialWorker from './financial-worker.js';
import type { FinancialWorkerBindings } from './financial-worker-config.js';

// Composition/lifecycle doubles only. Existing service suites separately verify identity and domain behavior.
const mocks = vi.hoisted(() => ({
  financialPool: vi.fn(), custodyPool: vi.fn(), financialObserve: vi.fn(), custodyObserve: vi.fn(),
  financialReaders: vi.fn(), financialRepository: vi.fn(), financialAuthentication: vi.fn(),
  closureRepository: vi.fn(),
  custodyReaders: vi.fn(), custodyRepository: vi.fn(), custodyAuthentication: vi.fn(),
}));
vi.mock('@pactwoven/db', () => ({
  createFinancialAuthorityPool: mocks.financialPool, createCustodySetupPool: mocks.custodyPool,
  PostgresFinancialPolicyReaders: class { constructor(...args: unknown[]) { mocks.financialReaders(...args); } resolveObserver = vi.fn(); context = vi.fn(); governance = vi.fn(); original = vi.fn(); },
  PostgresFinancialPolicyRepository: class { constructor(...args: unknown[]) { mocks.financialRepository(...args); } readFinancialPolicy = vi.fn(); listFinancialPolicyDrafts = vi.fn(); mutate = vi.fn(); },
  PostgresFinancialAuthenticationRepository: class { constructor(...args: unknown[]) { mocks.financialAuthentication(...args); } append = vi.fn(); },
  PostgresFinancialPolicyPreparationReader: class { prepare = vi.fn(); },
  PostgresFinancialPolicyClosureRepository: class { constructor(...args: unknown[]) { mocks.closureRepository(...args); } status = vi.fn(); close = vi.fn(); },
  PostgresCustodySetupReaders: class { constructor(...args: unknown[]) { mocks.custodyReaders(...args); } resolveOwner = vi.fn(); specification = vi.fn(); record = vi.fn(); original = vi.fn(); },
  PostgresCustodySetupRepository: class { constructor(...args: unknown[]) { mocks.custodyRepository(...args); } get = vi.fn(); recover = vi.fn(); mutate = vi.fn(); },
  PostgresCustodySetupAuthenticationRepository: class { constructor(...args: unknown[]) { mocks.custodyAuthentication(...args); } append = vi.fn(); },
}));
vi.mock('./financial-policy-verifier.js', () => ({ createClerkFinancialPolicyVerifier: () => ({ observe: mocks.financialObserve }) }));
vi.mock('./custody-setup-verifier.js', () => ({ createClerkCustodySetupVerifier: () => ({ observe: mocks.custodyObserve }) }));
vi.mock('./financial-policy-service.js', () => ({ createFinancialPolicyGateway: (d: any) => ({
  index: async (token: string) => {
    await d.verifier.observe(token); await d.readers.resolveObserver('development', {});
    await d.authentication.append({}); await d.repository.listFinancialPolicyDrafts('evidence', {}); await d.readers.governance('evidence', {}, {});
    return { schemaVersion: 1, scope: { environment: 'development', organizationId: 'org_a', actor: { actorId: 'owner_a', membershipVersion: 1 },
      roles: ['owner'], organizationEpoch: 1, siteIds: [], actionSiteIds: [] }, observation: { observedAt: new Date(Date.now() - 100).toISOString(), expiresAt: new Date(Date.now() + 19_000).toISOString() },
      kind: 'organization', responsibilityId: null, items: [], nextId: null, effectiveAuthority: false, financialState: null };
  },
}) }));
vi.mock('./financial-policy-write-service.js', () => ({ createFinancialPolicyWriteGateway: () => ({}) }));
vi.mock('./financial-policy-preparation-service.js', () => ({ createFinancialPolicyPreparationGateway: () => ({}) }));
vi.mock('./financial-policy-closure-service.js', () => ({ createFinancialPolicyClosureGateway: (d: any) => ({ status: async (token: string, locator: object) => {
  await d.verifier.observe(token); await d.readers.resolveObserver('development', {}); await d.authentication.append({});
  await d.closures.status('evidence', {}, locator);
  return { schemaVersion: 1, scope: { environment: 'development', organizationId: 'org_a', actor: { actorId: 'owner_a', membershipVersion: 1 },
    roles: ['owner'], organizationEpoch: 1, siteIds: [], actionSiteIds: [] }, observation: { observedAt: new Date(Date.now() - 100).toISOString(), expiresAt: new Date(Date.now() + 19_000).toISOString() },
    ...locator, status: 'not_recorded', receipt: null, closure: null, effectiveAuthority: false, financialState: null };
} }) }));
vi.mock('./custody-setup-service.js', () => ({ createCustodySetupService: (d: any) => ({ recoveryContext: async (token: string, responsibilityId: string) => {
  await d.verifier.observe(token); await d.readers.resolveOwner({}); await d.authentication.append({}); await d.repository.recover({});
  return { schemaVersion: 1, environment: 'development', organizationId: 'org_a', externalOrganizationId: 'clerk_org_a', responsibilityId,
    owner: { actorId: 'owner_a', membershipVersion: 1, subject: 'subject_a', externalMembershipId: 'member_a', sessionId: 'session_a' },
    observedAt: new Date(Date.now() - 100).toISOString(), expiresAt: new Date(Date.now() + 19_000).toISOString() };
} }) }));
const issuer = 'https://financial-fixture.clerk.accounts.dev', token = 'synthetic.financial.token';
const db = (name: string) => {
  const url = new URL(`postgresql://${name}.internal:5432/pactwoven_dev`);
  url.username = name; url.password = 'synthetic';
  return { connectionString: url.href, host: `${name}.internal`, user: name, port: 5432, database: 'pactwoven_dev' };
};
function bindings(): FinancialWorkerBindings { return {
  APP_ENVIRONMENT: 'development', WORKER_ROLE: 'financial', ALLOWED_ORIGINS: 'http://localhost:3000', CLERK_SECRET_KEY: 'sk_test_synthetic',
  CLERK_ISSUER: issuer, CLERK_PUBLISHABLE_KEY: `pk_test_${btoa('financial-fixture.clerk.accounts.dev$').replace(/=+$/, '')}`,
  FINANCIAL_POLICY_AUTHORIZER_DATABASE: db('financial_authorizer'), FINANCIAL_POLICY_VERIFIER_DATABASE: db('financial_verifier'),
  CUSTODY_SETUP_WRITER_DATABASE: db('custody_writer'), CUSTODY_SETUP_VERIFIER_DATABASE: db('custody_verifier'),
  EXPECTED_FINANCIAL_POLICY_AUTHORIZER_DATABASE_USER: 'financial_authorizer', EXPECTED_FINANCIAL_POLICY_VERIFIER_DATABASE_USER: 'financial_verifier',
  EXPECTED_CUSTODY_SETUP_WRITER_DATABASE_USER: 'custody_writer', EXPECTED_CUSTODY_SETUP_VERIFIER_DATABASE_USER: 'custody_verifier',
}; }
const pool = () => ({ query: vi.fn(async () => ({ rows: [{ database_matches: true, current_matches: true, session_matches: true }] })), end: vi.fn(async () => {}) });
function context() { const work: Promise<unknown>[] = []; return { waitUntil(p: Promise<unknown>) { work.push(p); }, done: () => Promise.all(work) }; }
async function joined(kind: 'financial' | 'custody' | 'closure' = 'financial', config = bindings()) {
  const locator = { responsibilityId: null, kind: 'save_document' as const, key: 'original_request_key', targetId: 'document_a', publicRequestHash: 'a'.repeat(64) };
  const path = kind === 'financial' ? '/v1/financial-governance' : kind === 'closure'
    ? `/v1/financial-governance/operations/${locator.key}?kind=${locator.kind}&targetId=${locator.targetId}&requestHash=${locator.publicRequestHash}`
    : '/v1/responsibilities/responsibility_a/custody-setups/recovery-context';
  const c = context(), fetch = vi.fn((request: Request) => financialWorker.fetch(request, config, c));
  const g = serviceFinancialGateways({ fetch }, new Request(`https://api.example${path}`, { headers: { Authorization: `Bearer ${token}` } }), issuer);
  try { return kind === 'financial' ? await g.financialPolicy.index(token, null, { afterId: null, limit: 20 }) : kind === 'closure'
    ? await g.financialPolicyClosure.status(token, locator) : await g.custodySetup.recoveryContext(token, 'responsibility_a', 'trace'); }
  finally { await c.done(); }
}
beforeEach(() => { vi.resetAllMocks(); mocks.financialPool.mockImplementation(async () => pool()); mocks.custodyPool.mockImplementation(async () => pool()); });
describe('financial private worker request lifecycle', () => {
  it('opens one verified financial pair, never a custody/runtime pool, and closes both after use', async () => {
    expect(await joined()).toMatchObject({ kind: 'organization' });
    expect(mocks.financialObserve).toHaveBeenCalledExactlyOnceWith(token);
    expect(mocks.financialPool).toHaveBeenCalledTimes(2); expect(mocks.custodyPool).not.toHaveBeenCalled();
    const authorizer = await mocks.financialPool.mock.results[0]!.value, verifier = await mocks.financialPool.mock.results[1]!.value;
    expect(mocks.financialPool.mock.calls.map(c => c[1])).toEqual(['authorizer', 'verifier']);
    expect(authorizer.query).toHaveBeenCalledWith(expect.stringContaining('current_user'), ['pactwoven_dev', 'financial_authorizer']);
    expect(verifier.query).toHaveBeenCalledWith(expect.stringContaining('session_user'), ['pactwoven_dev', 'financial_verifier']);
    expect(mocks.financialReaders).toHaveBeenCalledWith(authorizer, verifier); expect(mocks.financialRepository).toHaveBeenCalledWith(authorizer);
    expect(mocks.financialAuthentication).toHaveBeenCalledWith(verifier); expect(authorizer.end).toHaveBeenCalledOnce(); expect(verifier.end).toHaveBeenCalledOnce();
  });
  it('opens only custody writer/verifier for a custody call and closes them', async () => {
    expect(await joined('custody')).toMatchObject({ responsibilityId: 'responsibility_a' });
    expect(mocks.financialPool).not.toHaveBeenCalled(); expect(mocks.custodyObserve).toHaveBeenCalledExactlyOnceWith(token);
    const writer = await mocks.custodyPool.mock.results[0]!.value, verifier = await mocks.custodyPool.mock.results[1]!.value;
    expect(mocks.custodyPool.mock.calls.map(c => c[1])).toEqual(['writer', 'verifier']);
    expect(writer.query).toHaveBeenCalledWith(expect.any(String), ['pactwoven_dev', 'custody_writer']);
    expect(verifier.query).toHaveBeenCalledWith(expect.any(String), ['pactwoven_dev', 'custody_verifier']);
    expect(mocks.custodyRepository).toHaveBeenCalledWith(writer); expect(mocks.custodyAuthentication).toHaveBeenCalledWith(verifier);
    expect(writer.end).toHaveBeenCalledOnce(); expect(verifier.end).toHaveBeenCalledOnce();
  });
  it('opens only the verified financial pair for closure status after identity and closes it after use', async () => {
    expect(await joined('closure')).toMatchObject({ status: 'not_recorded', closure: null, receipt: null });
    expect(mocks.financialObserve).toHaveBeenCalledOnce(); expect(mocks.financialPool).toHaveBeenCalledTimes(2);
    expect(mocks.custodyPool).not.toHaveBeenCalled(); expect(mocks.financialRepository).not.toHaveBeenCalled();
    const authorizer = await mocks.financialPool.mock.results[0]!.value, verifier = await mocks.financialPool.mock.results[1]!.value;
    expect(mocks.closureRepository).toHaveBeenCalledExactlyOnceWith(authorizer);
    expect(authorizer.end).toHaveBeenCalledOnce(); expect(verifier.end).toHaveBeenCalledOnce();
  });
  it.each(['financial', 'custody', 'closure'] as const)('does not open any pool after rejected %s identity', async kind => {
    (kind === 'custody' ? mocks.custodyObserve : mocks.financialObserve).mockRejectedValue(new DomainError('AUTH_REQUIRED', 401, 'PRIVATE_SENTINEL'));
    await expect(joined(kind)).rejects.toMatchObject({ code: 'AUTH_REQUIRED', status: 401, message: 'Sign in again.' });
    expect(mocks.financialPool).not.toHaveBeenCalled(); expect(mocks.custodyPool).not.toHaveBeenCalled();
  });
  it('closes the first pool if the second factory fails without dispatching repository work', async () => {
    mocks.financialPool.mockImplementationOnce(async () => pool()).mockRejectedValueOnce(new Error('PRIVATE_DRIVER_SENTINEL'));
    await expect(joined()).rejects.toMatchObject({ code: 'FINANCIAL_POLICY_OUTCOME_UNKNOWN' });
    expect((await mocks.financialPool.mock.results[0]!.value).end).toHaveBeenCalledOnce();
    expect(mocks.financialRepository).not.toHaveBeenCalled(); expect(mocks.financialReaders).not.toHaveBeenCalled();
  });
  it('rejects actual origin identity mismatch and closes the unsafe pool before repository construction', async () => {
    const unsafe = pool(); unsafe.query.mockResolvedValue({ rows: [{ database_matches: true, current_matches: false, session_matches: true }] });
    mocks.financialPool.mockResolvedValueOnce(unsafe);
    await expect(joined()).rejects.toMatchObject({ code: 'UNSAFE_DATABASE_ROLE' });
    expect(mocks.financialPool).toHaveBeenCalledOnce(); expect(unsafe.end).toHaveBeenCalledOnce(); expect(mocks.financialReaders).not.toHaveBeenCalled();
  });
  it('uses new request-owned pools for subsequent invocations', async () => {
    await joined(); await joined(); expect(mocks.financialPool).toHaveBeenCalledTimes(4);
    const pools = await Promise.all(mocks.financialPool.mock.results.map(r => r.value)); expect(new Set(pools).size).toBe(4);
    for (const p of pools) expect(p.end).toHaveBeenCalledOnce();
  });
  it('rejects public URL, incomplete config and malformed private input before identity or pool work', async () => {
    const c = context();
    expect((await financialWorker.fetch(new Request('https://public.example/v1/financial-governance'), bindings(), c)).status).toBe(404);
    expect((await financialWorker.fetch(new Request(financialUrl, { method: 'POST' }), {}, c)).status).toBe(503);
    expect((await financialWorker.fetch(new Request(financialUrl, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' }), bindings(), c)).status).toBe(422);
    await c.done(); expect(mocks.financialObserve).not.toHaveBeenCalled(); expect(mocks.custodyObserve).not.toHaveBeenCalled();
    expect(mocks.financialPool).not.toHaveBeenCalled(); expect(mocks.custodyPool).not.toHaveBeenCalled();
  });
});
