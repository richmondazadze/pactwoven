import { createHash } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FinancialPolicyBootstrapSchema, type FinancialPolicyBootstrap } from '../lib/financial-policy-context';
import { createFinancialPolicyAttempt } from '../lib/financial-policy-contract';
import { storeFinancialPolicyReference, type FinancialPolicyStorage } from '../lib/financial-policy-recovery';
import { createFinancialPolicyWorkspaceController, FinancialPolicyWorkspaceView, type FinancialPolicyWorkspaceController } from './financial-policy-workspace';
import { MotionProvider } from './motion';

vi.mock('@clerk/nextjs', () => ({ useAuth: () => { throw Error('Native auth wrapper is not mounted in controller tests'); } }));
vi.mock('@tanstack/react-query', () => ({ useQuery: () => { throw Error('Native queries are not mounted in controller tests'); } }));
vi.mock('./workspace-provider', () => ({ useWorkspace: () => { throw Error('Native session wrapper is not mounted in controller tests'); } }));
const at = Date.parse('2026-11-15T00:00:00.000Z'), iso = (value: number) => new Date(value).toISOString(), base = 'https://api.example.test';
const controllers: FinancialPolicyWorkspaceController[] = [];
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'private, no-store' } });
function fixture() {
  const bootstrap = FinancialPolicyBootstrapSchema.parse({ environment: 'development', organizationId: 'org_a', actorId: 'owner_a', apiBase: base,
    responsibilityId: null, userId: 'user_a', externalOrganizationId: 'provider_org', sessionId: 'session_a', organizationEpoch: 2,
    roles: ['owner'], siteIds: ['site_a'], actionSiteIds: ['site_a'], responsibility: null });
  const envelope = { schemaVersion: 1, scope: { environment: 'development', organizationId: 'org_a', actor: { actorId: 'owner_a', membershipVersion: 5 },
    organizationEpoch: 2, roles: ['owner'], siteIds: ['site_a'], actionSiteIds: ['site_a'] }, observation: { observedAt: iso(at - 1000), expiresAt: iso(at + 19000) }, effectiveAuthority: false, financialState: null };
  const context = { ...envelope, kind: 'organization', responsibilityId: null, configurationVisibility: 'full', draftScope: null,
    asset: null, control: null, acceptedConfiguration: null, periods: [], documents: [], actions: [],
    blockers: ['ASSET_MISSING', 'FINANCIAL_AUTHORITY_UNAVAILABLE', 'GOVERNANCE_MISSING', 'TRUST_UNAVAILABLE'] };
  const current = { value: bootstrap as FinancialPolicyBootstrap | null }, time = { wall: at, mono: 100 }, values = new Map<string, string>();
  const storage: FinancialPolicyStorage = { get length() { return values.size; }, key: i => [...values.keys()][i] ?? null, getItem: k => values.get(k) ?? null,
    setItem: (k, v) => { values.set(k, v); }, removeItem: vi.fn(k => { values.delete(k); }) };
  const fetcher = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => json(context)), token = vi.fn(async () => 'test_token');
  const adapters = { bootstrap, currentBootstrap: () => current.value, getToken: token, fetch: fetcher, storage: () => storage, wall: () => time.wall, monotonic: () => time.mono };
  const controller = createFinancialPolicyWorkspaceController(adapters); controllers.push(controller); controller.activate();
  async function original(key = 'original_policy_001') {
    const text = 'Exact financial policy.\nFull terms remain readable.';
    const attempt = await createFinancialPolicyAttempt({ environment: 'development', organizationId: 'org_a', actorId: 'owner_a', apiBase: base, responsibilityId: null },
      { kind: 'save_document', responsibilityId: null, id: 'policy_a', key, route: '/v1/financial-governance/documents/policy_a',
        input: { schemaVersion: 1, previous: null, organizationEpoch: 2, purpose: 'budget_policy', text } });
    const actor = { actorId: 'owner_a', membershipVersion: 1 }, operationId = '00000000-0000-0000-0000-000000000001';
    const receipt = { schemaVersion: 1, environment: 'development', organizationId: 'org_a', actor, responsibilityId: null, operationId, kind: 'save_document', key,
      publicRequestHash: attempt.reference.locator.publicRequestHash, target: { id: 'policy_a', version: 1, recordHash: 'a'.repeat(64) }, effectiveAuthority: false, financialState: null,
      record: { schemaVersion: 1, environment: 'development', organizationId: 'org_a', actor, responsibilityId: null, operationId, kind: 'document', id: 'policy_a',
        version: 1, predecessor: null, organizationEpoch: 2, createdAt: iso(at), purpose: 'budget_policy', text,
        contentHash: createHash('sha256').update(JSON.stringify({ namespace: 'pactwoven:financial-policy-text:v1', text })).digest('hex') } };
    storeFinancialPolicyReference(storage, attempt.reference);
    return { reference: attempt.reference, receipt, response: (recorded = true) => ({ ...envelope, ...attempt.reference.locator, status: recorded ? 'recorded' : 'not_recorded', receipt: recorded ? receipt : null }) };
  }
  return { bootstrap, context, envelope, current, time, values, storage, fetcher, token, adapters, controller, original };
}
const globalFetch = vi.fn(() => { throw Error('Unexpected real fetch'); });
beforeEach(() => { vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', base); vi.stubGlobal('fetch', globalFetch); globalFetch.mockClear(); });
afterEach(() => { for (const controller of controllers.splice(0)) controller.close(); expect(globalFetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe('financial policy route controller (no DOM mount)', () => {
  it('offers responsibility preparation and exact revision navigation without initiating a request', () => {
    const f = fixture();
    const bootstrap = FinancialPolicyBootstrapSchema.parse({ ...f.adapters.bootstrap, responsibilityId: 'responsibility_a', responsibility: { id: 'responsibility_a', version: 1, siteId: 'site_a' } });
    const render = (target: { kind: 'draft'; responsibilityId: string; id: string; version: number; recordHash: null } | null) =>
      renderToStaticMarkup(createElement(MotionProvider, null, createElement(FinancialPolicyWorkspaceView, { ...f.adapters, bootstrap, target })));
    const collection = render(null); expect(collection).toContain('Prepare configuration'); expect(collection).toContain('/app/responsibilities/responsibility_a/financial-policies/prepare');
    const exact = render({ kind: 'draft', responsibilityId: 'responsibility_a', id: 'draft_a', version: 3, recordHash: null });
    expect(exact).toContain('Check revision options'); expect(exact).toContain('/app/responsibilities/responsibility_a/financial-policies/draft_a/versions/3/revise');
    const organization = renderToStaticMarkup(createElement(MotionProvider, null, createElement(FinancialPolicyWorkspaceView, f.adapters)));
    expect(organization).not.toContain('Prepare configuration'); expect(organization).not.toContain('Check revision options');
    expect(f.fetcher).not.toHaveBeenCalled(); expect(f.token).not.toHaveBeenCalled();
  });
  it('requires separate context, page and per-original checks; activation sends nothing', async () => {
    const f = fixture(), first = await f.original(), second = await f.original('original_policy_002');
    expect(f.fetcher).not.toHaveBeenCalled(); expect(f.controller.getSnapshot().context).toBeNull();
    await f.controller.refresh(); expect(f.fetcher).toHaveBeenCalledOnce(); expect(f.controller.getSnapshot().rows).toHaveLength(2);
    f.fetcher.mockResolvedValueOnce(json({ ...f.envelope, kind: 'organization', responsibilityId: null, items: [], nextId: null }));
    await f.controller.index(); expect(f.fetcher.mock.calls[1]?.[0]).toBe(base + '/v1/financial-governance?limit=25');
    f.fetcher.mockResolvedValueOnce(json(first.response())); await f.controller.lookup(first.reference);
    expect(f.controller.getSnapshot().rows.find(row => row.reference.locator.key === first.reference.locator.key)?.receipt).toEqual(first.receipt);
    expect(f.controller.getSnapshot().rows.find(row => row.reference.locator.key === second.reference.locator.key)?.state).toBe('unchecked');
    expect(f.values.size).toBe(2); await f.controller.clear(first.reference); expect(f.values.size).toBe(1);
    expect(f.fetcher).toHaveBeenCalledTimes(3); expect(f.controller.getSnapshot().rows[0]?.state).toBe('cleared');
  });
  it('keeps a known original receipt despite a later absence response', async () => {
    const f = fixture(), o = await f.original(); await f.controller.refresh();
    f.fetcher.mockResolvedValueOnce(json(o.response())); await f.controller.lookup(o.reference);
    f.fetcher.mockResolvedValueOnce(json(o.response(false))); await f.controller.lookup(o.reference);
    expect(f.controller.getSnapshot().rows[0]?.receipt).toEqual(o.receipt); expect(f.values.size).toBe(1);
  });
  it.each(['scope', 'context expiry', 'response expiry', 'hide', 'close', 'adapter'])('preserves a reminder when %s changes during receipt hashing', async mode => {
    const f = fixture(), o = await f.original(); await f.controller.refresh();
    f.fetcher.mockResolvedValueOnce(json(o.response())); await f.controller.lookup(o.reference);
    if (mode === 'response expiry') {
      f.fetcher.mockResolvedValueOnce(json({ ...f.envelope, observation: { observedAt: iso(at - 1000), expiresAt: iso(at + 2000) }, kind: 'organization', responsibilityId: null, items: [], nextId: null }));
      await f.controller.index();
    }
    const before = [...f.values.entries()], entered = deferred<void>(), release = deferred<void>();
    const digest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
    vi.spyOn(globalThis.crypto.subtle, 'digest').mockImplementationOnce(async (algorithm, data) => {
      entered.resolve(); await release.promise; return digest(algorithm, data);
    });
    const pending = f.controller.clear(o.reference); await entered.promise;
    if (mode === 'scope') f.current.value = null;
    if (mode === 'context expiry' || mode === 'response expiry') {
      const elapsed = mode === 'response expiry' ? 2000 : 20000;
      f.time.wall += elapsed; f.time.mono += elapsed;
    }
    if (mode === 'hide') f.controller.suspend(); if (mode === 'close') f.controller.close();
    if (mode === 'adapter') { f.controller.configure({ ...f.adapters, getToken: vi.fn(async () => 'replacement_token') }); f.controller.activate(); }
    release.resolve(); await pending;
    expect(f.storage.removeItem).not.toHaveBeenCalled(); expect([...f.values.entries()]).toEqual(before);
    expect(f.controller.getSnapshot()).toMatchObject({ context: null, rows: [], busy: false });
    if (mode === 'context expiry' || mode === 'response expiry') expect(f.controller.getSnapshot().phase).toBe('expired');
    expect(f.fetcher).toHaveBeenCalledTimes(mode === 'response expiry' ? 3 : 2);
  });
  it('clears an exact reminder after delayed hashing while its observation stays current', async () => {
    const f = fixture(), o = await f.original(); await f.controller.refresh();
    f.fetcher.mockResolvedValueOnce(json(o.response())); await f.controller.lookup(o.reference);
    const entered = deferred<void>(), release = deferred<void>(), digest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
    vi.spyOn(globalThis.crypto.subtle, 'digest').mockImplementationOnce(async (algorithm, data) => {
      entered.resolve(); await release.promise; return digest(algorithm, data);
    });
    const pending = f.controller.clear(o.reference); await entered.promise;
    expect(f.storage.removeItem).not.toHaveBeenCalled(); f.time.wall += 1000; f.time.mono += 1000;
    release.resolve(); await pending;
    expect(f.storage.removeItem).toHaveBeenCalledOnce(); expect(f.values.size).toBe(0);
    expect(f.controller.getSnapshot().rows[0]).toMatchObject({ state: 'cleared', receipt: o.receipt });
    expect(f.controller.getSnapshot().busy).toBe(false); expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
  it('reads only the requested immutable version and rejects another target', async () => {
    const f = fixture(), o = await f.original(); await f.controller.refresh();
    const response = { ...f.envelope, responsibilityId: null, policy: { record: o.receipt.record, reference: o.receipt.target,
      projection: { currentRecord: true, state: 'DOCUMENT', blockers: [] }, budgetConfiguration: null }, documents: [], actions: [] };
    f.fetcher.mockResolvedValueOnce(json(response)); const target = { kind: 'document' as const, responsibilityId: null, id: 'policy_a', version: 1, recordHash: o.receipt.target.recordHash };
    await f.controller.read(target); expect(f.controller.getSnapshot().record?.policy.record.id).toBe('policy_a');
    f.fetcher.mockResolvedValueOnce(json(response)); await f.controller.read({ ...target, id: 'other' }); expect(f.controller.getSnapshot().record).toBeNull();
    expect(f.controller.getSnapshot().message).toContain('could not be confirmed');
  });
  it('expires private content without renewing context, and preserves original references', async () => {
    const f = fixture(); await f.original(); vi.useFakeTimers(); await f.controller.refresh();
    f.time.wall += 19000; f.time.mono += 19000; await vi.advanceTimersByTimeAsync(19000);
    expect(f.controller.getSnapshot()).toMatchObject({ phase: 'expired', context: null, record: null, rows: [] });
    await vi.advanceTimersByTimeAsync(60000); expect(f.fetcher).toHaveBeenCalledOnce(); expect(f.values.size).toBe(1);
  });
  it('retains the strictest visible response deadline across later explicit reads', async () => {
    const f = fixture(), o = await f.original(); vi.useFakeTimers(); await f.controller.refresh();
    f.fetcher.mockResolvedValueOnce(json({ ...f.envelope, observation: { observedAt: iso(at - 1000), expiresAt: iso(at + 2000) }, kind: 'organization', responsibilityId: null, items: [], nextId: null }));
    await f.controller.index(); f.fetcher.mockResolvedValueOnce(json(o.response())); await f.controller.lookup(o.reference);
    f.time.mono += 2000; await vi.advanceTimersByTimeAsync(2000);
    expect(f.controller.getSnapshot()).toMatchObject({ phase: 'expired', context: null, index: null, rows: [] }); expect(f.values.size).toBe(1);
  });
  it('gates stale display immediately after a forward clock jump before any timer runs', async () => {
    const f = fixture(); await f.controller.refresh(); f.time.wall += 20000;
    expect(f.controller.fresh()).toBe(false); await f.controller.index(); expect(f.fetcher).toHaveBeenCalledOnce();
    expect(f.controller.getSnapshot()).toMatchObject({ phase: 'expired', context: null });
  });
  it.each(['scope', 'hide', 'close', 'adapter'])('rejects late token results after %s changes', async mode => {
    const f = fixture(), token = deferred<string>(); f.token.mockReturnValueOnce(token.promise); const pending = f.controller.refresh();
    if (mode === 'scope') f.current.value = null; if (mode === 'hide') f.controller.suspend(); if (mode === 'close') f.controller.close();
    if (mode === 'adapter') { f.controller.configure({ ...f.adapters, getToken: vi.fn(async () => 'new_token') }); f.controller.activate(); }
    token.resolve('late_token'); await pending; expect(f.fetcher).not.toHaveBeenCalled(); expect(f.controller.getSnapshot().context).toBeNull();
  });
  it('keeps denial across same-bootstrap adapter replacement and visibility replay', async () => {
    const f = fixture(); f.fetcher.mockResolvedValueOnce(json({ error: { code: 'FORBIDDEN' } }, 403)); await f.controller.refresh();
    expect(f.controller.getSnapshot().phase).toBe('denied');
    f.controller.configure({ ...f.adapters, fetch: vi.fn(async () => json(f.context)) }); f.controller.suspend(); f.controller.activate(); await f.controller.refresh();
    expect(f.controller.getSnapshot()).toMatchObject({ phase: 'denied', context: null, rows: [] }); expect(f.fetcher).toHaveBeenCalledOnce();
  });
  it('serializes rapid gestures without automatic retry after timeout', async () => {
    const f = fixture(), token = deferred<string>(); vi.useFakeTimers(); f.token.mockReturnValueOnce(token.promise);
    const pending = f.controller.refresh(); await f.controller.refresh(); expect(f.token).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(10000); await pending; token.resolve('late_token'); await Promise.resolve();
    expect(f.fetcher).not.toHaveBeenCalled(); expect(f.controller.getSnapshot().busy).toBe(false);
  });
  it('clears all old rows synchronously on hiding during an original read', async () => {
    const f = fixture(), o = await f.original(); await f.controller.refresh(); const response = deferred<Response>(); f.fetcher.mockReturnValueOnce(response.promise);
    const pending = f.controller.lookup(o.reference); await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(2)); f.controller.suspend();
    expect(f.controller.getSnapshot()).toMatchObject({ context: null, record: null, rows: [] }); response.resolve(json(o.response())); await pending;
    f.controller.activate(); expect(f.controller.getSnapshot().rows).toEqual([]); expect(f.values.size).toBe(1); expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
  it('keeps malformed and unavailable outcomes safe and unresolved', async () => {
    const f = fixture(), o = await f.original(); await f.controller.refresh();
    f.fetcher.mockResolvedValueOnce(json({ ...o.response(), commandHash: 'private' })); await f.controller.lookup(o.reference);
    expect(f.controller.getSnapshot().rows[0]).toMatchObject({ state: 'unconfirmed', receipt: null }); expect(f.values.size).toBe(1);
    f.fetcher.mockResolvedValueOnce(json({ error: { code: 'SETUP_REQUIRED', message: 'private diagnostics' } }, 503)); await f.controller.refresh();
    expect(f.controller.getSnapshot()).toMatchObject({ phase: 'unavailable', context: null }); expect(f.controller.getSnapshot().message).not.toContain('private diagnostics');
  });
});
