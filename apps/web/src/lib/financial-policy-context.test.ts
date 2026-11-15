import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FINANCE_DEVNET_ASSET, type Session, type Responsibility } from '@pactwoven/contracts';
import { commandDigest } from '@pactwoven/contracts/canonical';
import { createFinancialPolicyBootstrap, qualifyFinancialContext, createFinancialPolicyClock,
  createFinancialPolicyLifetime, financialPolicyLocalScope } from './financial-policy-context';

const at = Date.parse('2026-11-15T00:00:00.000Z'), iso = (n: number) => new Date(n).toISOString(), base = 'https://api.example.test';
function fixture() {
  const session: Session = { actor: { actorId: 'owner_a', principalKind: 'human', organizationId: 'org_a', environment: 'development', roles: ['owner'],
    siteIds: ['site_a'], actionSiteIds: ['site_a'], sessionId: 'session_a', authenticatedAt: iso(at - 60000), correlationId: 'test' },
    organization: { id: 'org_a', name: 'Test', authorityEpoch: 2 }, sites: [{ id: 'site_a', name: 'Site', timeZone: 'UTC' }] };
  const auth = { isLoaded: true, isSignedIn: true, userId: 'user_a', orgId: 'provider_org', sessionId: 'session_a' };
  const bootstrap = createFinancialPolicyBootstrap(session, auth, base);
  const context = { schemaVersion: 1, scope: { environment: 'development', organizationId: 'org_a', actor: { actorId: 'owner_a', membershipVersion: 4 },
    organizationEpoch: 2, roles: ['owner'], siteIds: ['site_a'], actionSiteIds: ['site_a'] },
    observation: { observedAt: iso(at - 1000), expiresAt: iso(at + 19000) }, effectiveAuthority: false, financialState: null,
    kind: 'organization', responsibilityId: null, configurationVisibility: 'full', draftScope: null,
    asset: null, control: null, acceptedConfiguration: null, periods: [], documents: [], actions: [],
    blockers: ['ASSET_MISSING', 'FINANCIAL_AUTHORITY_UNAVAILABLE', 'GOVERNANCE_MISSING', 'TRUST_UNAVAILABLE'] };
  return { session, auth, bootstrap, context };
}
beforeEach(() => vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', base));
afterEach(() => vi.unstubAllEnvs());
describe('financial policy bootstrap and observation', () => {
  it('binds current human session, provider selection and exact scope without persisting provider identity', async () => {
    const f = fixture(), observation = await qualifyFinancialContext(f.context, f.bootstrap, at, 100);
    expect(observation.context.scope.actor.membershipVersion).toBe(4);
    expect(observation.expiresAt).toBe(at + 19000); expect(Object.isFrozen(observation.context.scope.actor)).toBe(true);
    expect(financialPolicyLocalScope(f.bootstrap)).toEqual({ environment: 'development', organizationId: 'org_a', actorId: 'owner_a', responsibilityId: null, apiBase: base });
    f.session.actor.roles = ['finance']; f.context.scope.actor.membershipVersion = 5;
    expect(observation.context.scope.actor.membershipVersion).toBe(4);
  });
  it.each(['signed-out', 'not-loaded', 'session', 'role', 'service', 'environment', 'org', 'origin'])(
    'rejects invalid %s bootstrap', mode => {
      const f = fixture();
      if (mode === 'signed-out') f.auth.isSignedIn = false; if (mode === 'not-loaded') f.auth.isLoaded = false;
      if (mode === 'session') f.auth.sessionId = 'other'; if (mode === 'role') f.session.actor.roles = ['operations'];
      if (mode === 'service') f.session.actor.principalKind = 'service'; if (mode === 'environment') f.session.actor.environment = 'production';
      if (mode === 'org') f.session.actor.organizationId = 'other'; if (mode === 'origin') vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', 'https://other.test');
      expect(() => createFinancialPolicyBootstrap(f.session, f.auth, base)).toThrow();
    });
  it('permits Operations responsibility review only with exact read and action-site grants', () => {
    const f = fixture(); f.session.actor.roles = ['operations'];
    const responsibility: Responsibility = { id: 'responsibility_a', organizationId: 'org_a', environment: 'development', ownerId: 'owner_a', version: 3,
      executionState: 'DRAFT', authorityState: null, coverageState: 'UNKNOWN', title: 'Test', description: '', siteId: 'site_a',
      window: { startsAt: iso(at), endsAt: iso(at + 60000), timeZone: 'UTC' }, requirements: [], acceptancePolicy: '', createdAt: iso(at), updatedAt: iso(at) };
    expect(createFinancialPolicyBootstrap(f.session, f.auth, base, responsibility, responsibility.id).responsibility?.version).toBe(3);
    expect(() => createFinancialPolicyBootstrap(f.session, f.auth, base, responsibility, 'other')).toThrow();
    f.session.actor.actionSiteIds = []; expect(() => createFinancialPolicyBootstrap(f.session, f.auth, base, responsibility, responsibility.id)).toThrow();
  });
  it.each(['actor', 'organization', 'epoch', 'role', 'read-site', 'action-site'])(
    'refuses returned %s scope changes', async mode => {
      const f = fixture();
      if (mode === 'actor') f.context.scope.actor.actorId = 'other'; if (mode === 'organization') f.context.scope.organizationId = 'other';
      if (mode === 'epoch') f.context.scope.organizationEpoch++; if (mode === 'role') f.context.scope.roles = ['finance'];
      if (mode === 'read-site') f.context.scope.siteIds = []; if (mode === 'action-site') f.context.scope.actionSiteIds = [];
      await expect(qualifyFinancialContext(f.context, f.bootstrap, at, 100)).rejects.toMatchObject({ code: 'scope' });
    });
  it.each(['future', 'expired', 'too-long', 'nan-wall', 'negative-mono', 'private'])(
    'rejects %s observation without extending it', async mode => {
      const f = fixture();
      if (mode === 'future') f.context.observation.observedAt = iso(at + 1);
      if (mode === 'expired') f.context.observation.expiresAt = iso(at);
      if (mode === 'too-long') f.context.observation.expiresAt = iso(at + 20000);
      if (mode === 'private') Object.assign(f.context.scope.actor, { sessionId: 'private' });
      await expect(qualifyFinancialContext(f.context, f.bootstrap, mode === 'nan-wall' ? NaN : at, mode === 'negative-mono' ? -1 : 100)).rejects.toBeDefined();
    });
  it('uses a monotonic high-water clock and never recovers from monotonic rollback', () => {
    let wall = at, mono = 100; const now = createFinancialPolicyClock(at, 100, () => wall, () => mono);
    wall += 17000; expect(now()).toBe(at + 17000); wall -= 60000; mono += 1000; expect(now()).toBe(at + 17000);
    mono += 19000; expect(now()).toBe(at + 20000); mono--; expect(now).toThrow(); mono += 2; expect(now).toThrow();
  });
  it('checks public stable budget and period material even before a configuration is accepted', async () => {
    const f = fixture(), asset = { ...FINANCE_DEVNET_ASSET, decimals: 6, policy: 'solana-original-devnet-usdc-v1',
      pin: { key: 'b'.repeat(64), version: 1, recordHash: 'a'.repeat(64), financialUseEpoch: 0 } };
    const budgetAccountId = await commandDigest({ namespace: 'pactwoven:financial-budget-account:v1', environment: 'development',
      organizationId: 'org_a', assetKey: asset.pin.key, category: 'supplier_principal' });
    const period = { id: await commandDigest({ namespace: 'pactwoven:financial-budget-period:v1', budgetAccountId, startsAt: iso(at), endsAt: iso(at + 60000) }),
      startsAt: iso(at), endsAt: iso(at + 60000) };
    const context = { ...f.context, asset, control: { budgetAccountId, generation: 0, accepted: null }, periods: [period],
      blockers: ['FINANCIAL_AUTHORITY_UNAVAILABLE', 'GOVERNANCE_MISSING', 'TRUST_UNAVAILABLE'] };
    expect((await qualifyFinancialContext(context, f.bootstrap, at, 100)).context.control?.budgetAccountId).toBe(budgetAccountId);
    await expect(qualifyFinancialContext({ ...context, control: { ...context.control, budgetAccountId: 'f'.repeat(64) } }, f.bootstrap, at, 100)).rejects.toMatchObject({ code: 'input' });
    await expect(qualifyFinancialContext({ ...context, periods: [{ ...period, id: 'f'.repeat(64) }] }, f.bootstrap, at, 100)).rejects.toMatchObject({ code: 'input' });
  });
});
describe('financial policy lifetime', () => {
  it('requires one-use exact explicit permissions and a fresh context for each read', async () => {
    const f = fixture(), lifetime = createFinancialPolicyLifetime(f.bootstrap, { wall: () => at, monotonic: () => 100 });
    expect(() => lifetime.authorize('lookup', {})).toThrow();
    const permission = lifetime.authorize('context', { assetKey: null });
    expect(() => lifetime.start(permission, 'context', { assetKey: 'other' })).toThrow();
    const ticket = lifetime.start(permission, 'context', { assetKey: null });
    lifetime.accept(ticket, await qualifyFinancialContext(f.context, f.bootstrap, at, 100)); lifetime.finish(ticket);
    expect(() => lifetime.start(permission, 'context', { assetKey: null })).toThrow();
    expect(lifetime.authorize('read', { id: 'policy_a' }).action).toBe('read');
  });
  it('invalidates private state and latches denial before callbacks, across adapter replacement', () => {
    const f = fixture(), lifetime = createFinancialPolicyLifetime(f.bootstrap), called = vi.fn(() => {
      expect(() => lifetime.authorize('context', {})).toThrow();
    });
    lifetime.onInvalidate(called); lifetime.deny(); expect(called).toHaveBeenCalledOnce();
    lifetime.replaceAdapters(); expect(() => lifetime.activate(f.bootstrap)).toThrow();
    expect(() => lifetime.authorize('context', {})).toThrow();
    lifetime.activate({ ...f.bootstrap, sessionId: 'new_session' }); expect(lifetime.authorize('context', {}).action).toBe('context');
    expect(() => lifetime.activate(f.bootstrap)).toThrow();
  });
  it('hiding and unmount synchronously abort pending work without cancelling durable originals', async () => {
    const f = fixture(), lifetime = createFinancialPolicyLifetime(f.bootstrap), clear = vi.fn(); lifetime.onInvalidate(clear);
    const ticket = lifetime.start(lifetime.authorize('context', {}), 'context', {}); clear.mockClear(); lifetime.hide();
    expect(ticket.controller.signal.aborted).toBe(true); expect(clear).toHaveBeenCalledOnce();
    expect(() => lifetime.accept(ticket, {} as never)).toThrow();
    lifetime.activate(f.bootstrap); expect(() => lifetime.authorize('lookup', {})).toThrow();
    lifetime.close(); expect(() => lifetime.activate(f.bootstrap)).toThrow();
  });
  it('expires at the stricter server deadline and clears before a listener can read stale data', async () => {
    const f = fixture(); f.context.observation.expiresAt = iso(at + 3000);
    let wall = at, mono = 100;
    const lifetime = createFinancialPolicyLifetime(f.bootstrap, { wall: () => wall, monotonic: () => mono });
    const ticket = lifetime.start(lifetime.authorize('context', {}), 'context', {});
    lifetime.accept(ticket, await qualifyFinancialContext(f.context, f.bootstrap, at, 100)); lifetime.finish(ticket);
    const clear = vi.fn(); lifetime.onInvalidate(clear); wall = at - 100000; mono += 3000;
    expect(() => lifetime.authorize('lookup', {})).toThrow(); expect(clear).toHaveBeenCalledOnce();
  });
});
