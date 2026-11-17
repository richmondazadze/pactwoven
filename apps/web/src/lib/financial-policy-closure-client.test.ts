import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FinancialPolicyOriginalClosureRequestSchema, type FinancialPolicyHttpReceipt } from '@pactwoven/contracts';
import { commandDigest } from '@pactwoven/contracts/canonical';
import { createFinancialPolicyClosureClient } from './financial-policy-closure-client';
import { createFinancialPolicyAttempt, qualifyFinancialClosure, qualifyFinancialReceipt, type FinancialPolicyQualifiedClosure } from './financial-policy-contract';
import { FinancialPolicyBootstrapSchema, createFinancialPolicyLifetime, financialPolicyLocalScope, type FinancialPolicyBootstrap } from './financial-policy-context';
import { assertFinancialPolicyReference, clearClosedFinancialPolicyReminder, clearFinancialPolicyReminder,
  createFinancialPolicyMemory, storeFinancialPolicyReference, type FinancialPolicyStorage } from './financial-policy-recovery';
import { createFinancialPolicyTransport } from './financial-policy-transport';
import { financialClosureFixture } from './financial-policy-closure-test-support';

const at = Date.parse('2026-11-15T00:00:00.000Z'), iso = (n: number) => new Date(n).toISOString(), base = 'https://api.example.test';
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'private, no-store' } });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
async function fixture() {
  const bootstrap = FinancialPolicyBootstrapSchema.parse({ environment: 'development', organizationId: 'org_a', actorId: 'owner_a', apiBase: base,
    responsibilityId: null, userId: 'user_a', externalOrganizationId: 'provider_org', sessionId: 'session_a', organizationEpoch: 2,
    roles: ['owner'], siteIds: ['site_a'], actionSiteIds: ['site_a'], responsibility: null });
  const envelope = { schemaVersion: 1, scope: { environment: 'development', organizationId: 'org_a', actor: { actorId: 'owner_a', membershipVersion: 5 },
    organizationEpoch: 2, roles: ['owner'], siteIds: ['site_a'], actionSiteIds: ['site_a'] },
    observation: { observedAt: iso(at - 1000), expiresAt: iso(at + 19000) }, effectiveAuthority: false, financialState: null };
  const context = { ...envelope, kind: 'organization', responsibilityId: null, configurationVisibility: 'full', draftScope: null,
    asset: null, control: null, acceptedConfiguration: null, periods: [], documents: [], actions: [],
    blockers: ['ASSET_MISSING', 'FINANCIAL_AUTHORITY_UNAVAILABLE', 'GOVERNANCE_MISSING', 'TRUST_UNAVAILABLE'] };
  const time = { wall: at, mono: 100 }, current = { value: bootstrap as FinancialPolicyBootstrap | null };
  const clocks = { wall: () => time.wall, monotonic: () => time.mono }, lifetime = createFinancialPolicyLifetime(bootstrap, clocks);
  const scope = financialPolicyLocalScope(bootstrap), memory = createFinancialPolicyMemory(scope), values = new Map<string, string>();
  const storage: FinancialPolicyStorage = { get length() { return values.size; }, key: i => [...values.keys()][i] ?? null, getItem: key => values.get(key) ?? null,
    setItem: vi.fn((key, value) => { values.set(key, value); }), removeItem: vi.fn(key => { values.delete(key); }) };
  const storageOwner = { value: storage as FinancialPolicyStorage | null };
  const text = 'Original policy text retained only in the synthetic fixture.';
  const attempt = await createFinancialPolicyAttempt(scope, { kind: 'save_document', responsibilityId: null, id: 'policy_a', key: 'original_policy_001',
    route: '/v1/financial-governance/documents/policy_a', input: { schemaVersion: 1, previous: null, organizationEpoch: 2, purpose: 'budget_policy', text } });
  const reference = attempt.reference; storeFinancialPolicyReference(storage, reference);
  const actor = { actorId: 'owner_a', membershipVersion: 1 }, operationId = '00000000-0000-0000-0000-000000000001';
  const receipt: FinancialPolicyHttpReceipt = { schemaVersion: 1, environment: 'development', organizationId: 'org_a', actor, responsibilityId: null, operationId,
    kind: 'save_document', key: reference.locator.key, publicRequestHash: reference.locator.publicRequestHash, target: { id: 'policy_a', version: 1, recordHash: 'a'.repeat(64) },
    effectiveAuthority: false, financialState: null, record: { schemaVersion: 1, environment: 'development', organizationId: 'org_a', actor, responsibilityId: null,
      operationId, id: 'policy_a', version: 1, predecessor: null, organizationEpoch: 2, createdAt: iso(at), kind: 'document', purpose: 'budget_policy', text,
      contentHash: await commandDigest({ namespace: 'pactwoven:financial-policy-text:v1', text }) } };
  const state = { closure: null as FinancialPolicyQualifiedClosure | null, originalWon: false, loseResponse: false };
  const status = () => ({ ...envelope, ...reference.locator, status: state.closure ? 'closed' : state.originalWon ? 'recorded' : 'not_recorded',
    receipt: state.originalWon ? receipt : null, closure: state.closure });
  const fetcher = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async (url, init) => {
    if (url.endsWith('/context')) return json(context);
    if (init.method === 'GET') return json(status());
    const request = FinancialPolicyOriginalClosureRequestSchema.parse(JSON.parse(String(init.body)));
    if (!state.originalWon) state.closure = await financialClosureFixture(reference, request.expected);
    if (state.loseResponse) throw Error('Private acknowledgement loss');
    return json(status());
  });
  const token = vi.fn(async () => 'test_token');
  const adapters = { lifetime, memory, storage: () => storageOwner.value, currentBootstrap: () => current.value, getToken: token, fetch: fetcher, ...clocks };
  const transport = createFinancialPolicyTransport(adapters), client = createFinancialPolicyClosureClient(adapters);
  const open = () => transport.context({ assetKey: null }, lifetime.authorize('context', { assetKey: null }));
  const lookup = async () => { const result = await transport.lookup(reference, lifetime.authorize('lookup', reference)); client.noteLookup(reference, result); return result; };
  const reviewed = async () => { await open(); await lookup(); return client.review(reference); };
  return { bootstrap, envelope, context, time, current, lifetime, memory, values, storage, storageOwner, attempt, reference, receipt, state, status,
    fetcher, token, adapters, transport, client, open, lookup, reviewed };
}
const noNetwork = vi.fn(() => { throw Error('Unexpected actual network'); });
beforeEach(() => { vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', base); vi.stubGlobal('fetch', noNetwork); noNetwork.mockClear(); });
afterEach(() => { expect(noNetwork).not.toHaveBeenCalled(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe('explicit original-key closure client', () => {
  it('requires an explicit current negative lookup and separate review before any closure I/O', async () => {
    const f = await fixture(); expect(f.fetcher).not.toHaveBeenCalled(); expect(f.token).not.toHaveBeenCalled();
    expect(() => f.client.review(f.reference)).toThrow(); await f.open(); expect(() => f.client.review(f.reference)).toThrow();
    await f.lookup(); const calls = f.fetcher.mock.calls.length, review = f.client.review(f.reference);
    expect(f.client.reviewCurrent(review)).toBe(true); expect(f.fetcher).toHaveBeenCalledTimes(calls);
    expect(review.request.expected).toEqual({ environment: 'development', organizationId: 'org_a', actor: f.envelope.scope.actor, organizationEpoch: 2, draftScope: null });
    const originals = [...f.values]; const result = await f.client.submit(review);
    expect(result.status).toBe('closed'); expect(f.memory.closed(f.reference)).toEqual(result.closure); expect(f.memory.recorded(f.reference)).toBeNull();
    expect([...f.values]).toEqual(originals); expect(f.storage.removeItem).not.toHaveBeenCalled();
    const [url, init] = f.fetcher.mock.calls.at(-1)!;
    expect(url).toBe(base + '/v1/financial-governance/operations/original_policy_001/close');
    expect(new Headers(init.headers).get('Idempotency-Key')).toBe(f.reference.locator.key); expect(JSON.parse(String(init.body))).toEqual(review.request);
    expect(init).toMatchObject({ method: 'POST', cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
    await expect(f.client.submit(review)).rejects.toBeDefined(); expect(f.fetcher).toHaveBeenCalledTimes(calls + 1);
    await expect(qualifyFinancialReceipt(result.closure, f.reference)).rejects.toBeDefined();
    await expect(clearFinancialPolicyReminder(f.storage, f.reference, result.closure as never, () => true)).rejects.toBeDefined();
    expect([...f.values]).toEqual(originals);
    await clearClosedFinancialPolicyReminder(f.storage, f.reference, result.closure!, () => true); expect(f.values.size).toBe(0);
  });
  it('rejects cloned or changed review material before token acquisition', async () => {
    const f = await fixture(), review = await f.reviewed(), tokens = f.token.mock.calls.length;
    for (const input of [structuredClone(review), { ...review, request: { ...review.request, expected: { ...review.request.expected, organizationEpoch: 3 } } }])
      await expect(f.client.submit(input)).rejects.toBeDefined();
    expect(f.token).toHaveBeenCalledTimes(tokens); expect(f.values.size).toBe(1);
  });
  it('does not close an original whose exact input is still retained in live memory', async () => {
    const f = await fixture(); await f.open(); await f.lookup(); await f.memory.retain(f.attempt);
    expect(f.client.canReview(f.reference)).toBe(false); expect(() => f.client.review(f.reference)).toThrow();
    expect(f.fetcher.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(0); expect(f.values.size).toBe(1);
  });
  it('refuses closure if the original input becomes available during token acquisition', async () => {
    const f = await fixture(), review = await f.reviewed(), token = deferred<string>(); f.token.mockReturnValueOnce(token.promise);
    const pending = f.client.submit(review).catch(error => error);
    await vi.waitFor(() => expect(f.token).toHaveBeenCalledTimes(3)); await f.memory.retain(f.attempt);
    token.resolve('fresh_token'); expect(await pending).toMatchObject({ outcome: 'not-dispatched' });
    expect(f.fetcher.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(0);
    expect(f.memory.original(f.reference)).toEqual(f.attempt); expect(f.values.size).toBe(1);
  });
  it.each(['recorded', 'closed', 'finance', 'unsupported', 'expired'] as const)('cannot review a %s original for new closure', async reason => {
    const f = await fixture();
    if (reason === 'finance') { f.context.scope.roles = ['finance']; f.current.value = { ...f.bootstrap, roles: ['finance'] }; f.lifetime.activate(f.current.value); }
    await f.open();
    if (reason === 'recorded') f.state.originalWon = true;
    if (reason === 'closed') f.state.closure = await financialClosureFixture(f.reference, { environment: 'development', organizationId: 'org_a', actor: f.envelope.scope.actor, organizationEpoch: 2, draftScope: null });
    await f.lookup(); if (reason === 'expired') f.time.mono += 19000;
    const reference = reason === 'unsupported' ? { ...f.reference, locator: { ...f.reference.locator, kind: 'propose_governance' as const } } : f.reference;
    expect(f.client.canReview(reference)).toBe(false); expect(() => f.client.review(reference)).toThrow();
    expect(f.fetcher.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(0); expect(f.storage.removeItem).not.toHaveBeenCalled();
  });
  it.each(['hide', 'scope', 'storage', 'bytes', 'adapter', 'expiry', 'rollback', 'edit'] as const)('prevents dispatch after %s during the token wait and preserves the locator', async loss => {
    const f = await fixture(), review = await f.reviewed(), token = deferred<string>(); f.token.mockReturnValueOnce(token.promise);
    const pending = f.client.submit(review).catch(error => error); await vi.waitFor(() => expect(f.token).toHaveBeenCalledTimes(3));
    const originals = [...f.values];
    if (loss === 'hide') f.lifetime.hide(); if (loss === 'scope') f.current.value = null;
    if (loss === 'storage') f.storageOwner.value = { ...f.storage };
    if (loss === 'bytes') { const [key, value] = originals[0]!; f.values.set(key, value + ' '); }
    if (loss === 'adapter') f.adapters.getToken = vi.fn(async () => 'replacement');
    if (loss === 'expiry') f.time.mono += 19000; if (loss === 'rollback') f.time.mono -= 1;
    if (loss === 'edit') f.client.invalidateReview();
    token.resolve('late_token'); expect(await pending).toMatchObject({ outcome: 'not-dispatched' });
    expect(f.fetcher.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(0);
    expect(f.storage.removeItem).not.toHaveBeenCalled(); if (loss !== 'bytes') expect([...f.values]).toEqual(originals);
    expect(f.client.reviewCurrent(review)).toBe(false);
  });
  it('records the actual policy receipt when the original wins without fabricating a closure', async () => {
    const f = await fixture(), review = await f.reviewed(); f.state.originalWon = true;
    const result = await f.client.submit(review); expect(result.status).toBe('recorded'); expect(result.closure).toBeNull();
    expect(f.memory.recorded(f.reference)).toEqual(f.receipt); expect(f.memory.closed(f.reference)).toBeNull(); expect(f.values.size).toBe(1);
    await clearFinancialPolicyReminder(f.storage, f.reference, f.receipt, () => true); expect(f.values.size).toBe(0);
  });
  it('recovers a committed closure only through an explicit GET after acknowledgement loss', async () => {
    const f = await fixture(), review = await f.reviewed(), originals = [...f.values]; f.state.loseResponse = true;
    await expect(f.client.submit(review)).rejects.toMatchObject({ outcome: 'unknown' });
    expect(f.memory.closed(f.reference)).toBeNull(); expect([...f.values]).toEqual(originals);
    const calls = f.fetcher.mock.calls.length; await expect(f.client.submit(review)).rejects.toBeDefined(); expect(f.fetcher).toHaveBeenCalledTimes(calls);
    const result = await f.lookup(); expect(result.status).toBe('closed'); expect(f.memory.closed(f.reference)).toEqual(f.state.closure);
    expect([...f.values]).toEqual(originals); expect(f.client.canReview(f.reference)).toBe(false); expect(f.storage.removeItem).not.toHaveBeenCalled();
  });
  it('accepts immutable historical pins under a newer current membership and epoch without rewriting them', async () => {
    const f = await fixture();
    const historical = { environment: 'development' as const, organizationId: 'org_a', actor: { actorId: 'owner_a', membershipVersion: 1 }, organizationEpoch: 0, draftScope: null };
    f.state.closure = await financialClosureFixture(f.reference, historical); await f.open();
    const result = await f.lookup(); expect(result.closure?.expected).toEqual(historical); expect(result.scope.actor.membershipVersion).toBe(5);
    expect(result.scope.organizationEpoch).toBe(2); expect(f.memory.closed(f.reference)?.expected).toEqual(historical);
  });
  it('returns exact immutable replay despite changed response pins so the controller can retire old context', async () => {
    const f = await fixture(), review = await f.reviewed();
    const closure = await financialClosureFixture(f.reference, { ...review.request.expected, actor: { actorId: 'owner_a', membershipVersion: 1 }, organizationEpoch: 0 });
    f.fetcher.mockResolvedValueOnce(json({ ...f.envelope, scope: { ...f.envelope.scope, actor: { actorId: 'owner_a', membershipVersion: 8 }, organizationEpoch: 3 },
      ...f.reference.locator, status: 'closed', receipt: null, closure }));
    const result = await f.client.submit(review); expect(result.closure).toEqual(closure); expect(result.scope.organizationEpoch).toBe(3);
    expect(result.closure?.expected.organizationEpoch).toBe(0); expect(f.values.size).toBe(1);
  });
  it.each(['hash', 'locator', 'actor', 'not-recorded', 'redirect', 'content-type', 'length', 'cache', 'duplicate', 'denied'] as const)(
    'keeps a %s closure response unresolved and never clears or retries', async fault => {
      const f = await fixture(), review = await f.reviewed(), original = await financialClosureFixture(f.reference, review.request.expected);
      const closure = structuredClone(original);
      if (fault === 'hash') closure.recordHash = 'f'.repeat(64); if (fault === 'locator') closure.locator.targetId = 'other_policy';
      if (fault === 'actor') closure.actor.actorId = 'other_actor';
      let response = json({ ...f.envelope, ...f.reference.locator, status: 'closed', receipt: null, closure });
      if (fault === 'not-recorded') response = json({ ...f.envelope, ...f.reference.locator, status: 'not_recorded', receipt: null, closure: null });
      if (fault === 'redirect') response = json({}, 302);
      if (fault === 'content-type') response.headers.set('Content-Type', 'text/html');
      if (fault === 'length') response.headers.set('Content-Length', String(2 * 1024 * 1024 + 1));
      if (fault === 'cache') response.headers.set('Cache-Control', 'public');
      if (fault === 'duplicate') response = new Response('{"status":"closed","status":"not_recorded"}', { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } });
      if (fault === 'denied') response = json({}, 403);
      f.fetcher.mockResolvedValueOnce(response); await expect(f.client.submit(review)).rejects.toMatchObject({ outcome: 'unknown' });
      expect(f.memory.closed(f.reference)).toBeNull(); expect(f.values.size).toBe(1); expect(f.storage.removeItem).not.toHaveBeenCalled();
      const calls = f.fetcher.mock.calls.length; await expect(f.client.submit(review)).rejects.toBeDefined(); expect(f.fetcher).toHaveBeenCalledTimes(calls);
    });
  it('keeps token acquisition failure unsent and requires another explicit lookup before review', async () => {
    const f = await fixture(), review = await f.reviewed(), originals = [...f.values], calls = f.fetcher.mock.calls.length;
    f.token.mockRejectedValueOnce(Error('private provider failure with token contents'));
    const error = await f.client.submit(review).catch(value => value);
    expect(error).toMatchObject({ outcome: 'not-dispatched', code: 'unconfirmed' }); expect(error.message).not.toContain('private provider');
    expect(f.fetcher).toHaveBeenCalledTimes(calls); expect([...f.values]).toEqual(originals); expect(f.client.canReview(f.reference)).toBe(false);
    await f.lookup(); expect(f.client.canReview(f.reference)).toBe(true);
  });
  it.each([10000, 19000])('rechecks time after the final storage barrier advances the clock by %i ms', async elapsed => {
    const f = await fixture(), review = await f.reviewed(), get = f.storage.getItem;
    let afterToken = false, reads = 0;
    f.token.mockImplementationOnce(async () => { afterToken = true; return 'fresh_token'; });
    f.storage.getItem = key => {
      const raw = get(key); if (afterToken && ++reads === 2) f.time.mono += elapsed; return raw;
    };
    await expect(f.client.submit(review)).rejects.toMatchObject({ outcome: 'not-dispatched' });
    expect(f.fetcher.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(0); expect(f.values.size).toBe(1);
  });
  it('bounds an abort-ignoring dispatched response and rejects its late closure receipt', async () => {
    vi.useFakeTimers(); const f = await fixture(), review = await f.reviewed(), held = deferred<Response>(); f.fetcher.mockReturnValueOnce(held.promise);
    const pending = f.client.submit(review).catch(error => error); await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(3));
    f.time.mono += 10000; await vi.advanceTimersByTimeAsync(10000); expect(await pending).toMatchObject({ outcome: 'unknown' });
    const closure = await financialClosureFixture(f.reference, review.request.expected);
    held.resolve(json({ ...f.envelope, ...f.reference.locator, status: 'closed', receipt: null, closure })); await Promise.resolve(); await Promise.resolve();
    expect(f.memory.closed(f.reference)).toBeNull(); expect(f.values.size).toBe(1); expect(f.storage.removeItem).not.toHaveBeenCalled();
  });
  it.each(['hide', 'scope', 'expiry', 'storage'] as const)('rejects a late dispatched closure after %s and preserves its original', async loss => {
    const f = await fixture(), review = await f.reviewed(), held = deferred<Response>(); f.fetcher.mockReturnValueOnce(held.promise);
    const pending = f.client.submit(review).catch(error => error); await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(3));
    if (loss === 'hide') f.lifetime.hide(); if (loss === 'scope') f.current.value = null;
    if (loss === 'expiry') f.time.mono += 19000; if (loss === 'storage') f.storageOwner.value = { ...f.storage };
    const closure = await financialClosureFixture(f.reference, review.request.expected);
    held.resolve(json({ ...f.envelope, ...f.reference.locator, status: 'closed', receipt: null, closure }));
    expect(await pending).toMatchObject({ outcome: 'unknown' }); expect(f.memory.closed(f.reference)).toBeNull();
    expect(f.values.size).toBe(1); expect(f.storage.removeItem).not.toHaveBeenCalled();
  });
  it('keeps receipt kinds separate in memory and rejects contradictory outcomes', async () => {
    const f = await fixture(), review = await f.reviewed(), closure = await financialClosureFixture(f.reference, review.request.expected);
    await f.memory.recordClosure(f.reference, closure);
    await expect(f.memory.record(f.reference, f.receipt)).rejects.toMatchObject({ code: 'unconfirmed' });
    await expect(f.memory.clearReminder(f.storage, f.reference)).rejects.toBeDefined();
    f.memory.clear(); await f.memory.record(f.reference, f.receipt);
    await expect(f.memory.recordClosure(f.reference, closure)).rejects.toMatchObject({ code: 'unconfirmed' });
    expect(f.values.size).toBe(1);
  });
  it('never replaces an accepted immutable closure with different historical pins', async () => {
    const f = await fixture(), review = await f.reviewed(), closure = await financialClosureFixture(f.reference, review.request.expected);
    await f.memory.recordClosure(f.reference, closure); await f.memory.recordClosure(f.reference, closure);
    const changed = await financialClosureFixture(f.reference, { ...review.request.expected, organizationEpoch: 3 });
    await expect(f.memory.recordClosure(f.reference, changed)).rejects.toMatchObject({ code: 'unconfirmed' });
    expect(f.memory.closed(f.reference)).toEqual(closure); expect(f.values.size).toBe(1);
  });
  it.each(['scope', 'bytes', 'forged'] as const)('cannot clear a closed reminder after %s changes during qualification', async fault => {
    const f = await fixture(), review = await f.reviewed(), closure = await financialClosureFixture(f.reference, review.request.expected);
    if (fault === 'forged') closure.recordHash = 'f'.repeat(64);
    let current = true;
    const pending = clearClosedFinancialPolicyReminder(f.storage, f.reference, closure, () => current);
    if (fault === 'scope') current = false;
    if (fault === 'bytes') { const [key, raw] = [...f.values][0]!; f.values.set(key, raw + ' '); }
    await expect(pending).rejects.toBeDefined(); expect(f.storage.removeItem).not.toHaveBeenCalled(); expect(f.values.size).toBe(1);
  });
  it('does not retain a late closure after memory lifetime replacement', async () => {
    const f = await fixture(), review = await f.reviewed(), closure = await financialClosureFixture(f.reference, review.request.expected);
    const pending = f.memory.recordClosure(f.reference, closure); f.memory.clear();
    await expect(pending).rejects.toBeDefined(); expect(f.memory.closed(f.reference)).toBeNull();
    expect(assertFinancialPolicyReference(f.storage, f.reference)).toBeDefined();
    await expect(qualifyFinancialClosure(f.receipt, f.reference)).rejects.toBeDefined();
  });
});
