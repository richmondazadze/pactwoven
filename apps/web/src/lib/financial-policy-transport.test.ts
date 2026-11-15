import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFinancialPolicyAttempt } from './financial-policy-contract';
import { FinancialPolicyBootstrapSchema, createFinancialPolicyLifetime, financialPolicyLocalScope, type FinancialPolicyBootstrap } from './financial-policy-context';
import { createFinancialPolicyMemory, storeFinancialPolicyReference, type FinancialPolicyStorage } from './financial-policy-recovery';
import { createFinancialPolicyTransport, parseFinancialPolicyJson } from './financial-policy-transport';

const at = Date.parse('2026-11-15T00:00:00.000Z'), iso = (n: number) => new Date(n).toISOString(), base = 'https://api.example.test';
const contextQuery = { assetKey: null }, indexQuery = { responsibilityId: null, afterId: null, limit: 50 };
const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function fixture() {
  const bootstrap = FinancialPolicyBootstrapSchema.parse({ environment: 'development', organizationId: 'org_a', actorId: 'owner_a', apiBase: base,
    responsibilityId: null, userId: 'user_a', externalOrganizationId: 'provider_org', sessionId: 'session_a', organizationEpoch: 2,
    roles: ['owner'], siteIds: ['site_a'], actionSiteIds: ['site_a'], responsibility: null });
  const context = { schemaVersion: 1, scope: { environment: 'development', organizationId: 'org_a', actor: { actorId: 'owner_a', membershipVersion: 5 },
    organizationEpoch: 2, roles: ['owner'], siteIds: ['site_a'], actionSiteIds: ['site_a'] },
    observation: { observedAt: iso(at - 1000), expiresAt: iso(at + 19000) }, effectiveAuthority: false, financialState: null,
    kind: 'organization', responsibilityId: null, configurationVisibility: 'full', draftScope: null,
    asset: null, control: null, acceptedConfiguration: null, periods: [], documents: [], actions: [],
    blockers: ['ASSET_MISSING', 'FINANCIAL_AUTHORITY_UNAVAILABLE', 'GOVERNANCE_MISSING', 'TRUST_UNAVAILABLE'] };
  const current = { value: bootstrap as FinancialPolicyBootstrap | null }, time = { wall: at, mono: 100 };
  const clocks = { wall: () => time.wall, monotonic: () => time.mono };
  const lifetime = createFinancialPolicyLifetime(bootstrap, clocks), memory = createFinancialPolicyMemory(financialPolicyLocalScope(bootstrap));
  const values = new Map<string, string>(), storage: FinancialPolicyStorage = { get length() { return values.size; }, key: i => [...values.keys()][i] ?? null,
    getItem: k => values.get(k) ?? null, setItem: (k, v) => { values.set(k, v); }, removeItem: k => { values.delete(k); } };
  const fetcher = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => json(context)), getToken = vi.fn(async () => 'test_token');
  const adapters = { lifetime, memory, storage: () => storage, currentBootstrap: () => current.value, getToken, fetch: fetcher, ...clocks };
  const transport = createFinancialPolicyTransport(adapters);
  const open = () => transport.context(contextQuery, lifetime.authorize('context', contextQuery));
  const index = () => transport.index(indexQuery, lifetime.authorize('index', indexQuery));
  const envelope = () => ({ schemaVersion: context.schemaVersion, scope: context.scope, observation: context.observation,
    effectiveAuthority: false, financialState: null });
  async function original() {
    const text = 'Exact full policy text.';
    const attempt = await createFinancialPolicyAttempt(financialPolicyLocalScope(bootstrap), { kind: 'save_document', responsibilityId: null,
      id: 'policy_a', key: 'original_policy_001', route: '/v1/financial-governance/documents/policy_a',
      input: { schemaVersion: 1, previous: null, organizationEpoch: 2, purpose: 'budget_policy', text } });
    const actor = { actorId: 'owner_a', membershipVersion: 1 }, operationId = '00000000-0000-0000-0000-000000000001';
    const receipt = { schemaVersion: 1 as const, environment: 'development' as const, organizationId: 'org_a', actor, responsibilityId: null,
      operationId, kind: 'save_document' as const, key: attempt.reference.locator.key, publicRequestHash: attempt.reference.locator.publicRequestHash,
      target: { id: 'policy_a', version: 1, recordHash: 'a'.repeat(64) }, effectiveAuthority: false as const, financialState: null,
      record: { schemaVersion: 1 as const, environment: 'development' as const, organizationId: 'org_a', actor, responsibilityId: null, id: 'policy_a', version: 1,
        predecessor: null, organizationEpoch: 2, operationId, createdAt: iso(at), kind: 'document' as const, purpose: 'budget_policy' as const, text,
        contentHash: createHash('sha256').update(JSON.stringify({ namespace: 'pactwoven:financial-policy-text:v1', text })).digest('hex') } };
    storeFinancialPolicyReference(storage, attempt.reference); await memory.retain(attempt);
    return { attempt, receipt, lookup: () => transport.lookup(attempt.reference, lifetime.authorize('lookup', attempt.reference)),
      response: (recorded = true) => ({ ...envelope(), ...attempt.reference.locator, status: recorded ? 'recorded' : 'not_recorded', receipt: recorded ? receipt : null }) };
  }
  return { bootstrap, context, envelope, current, time, lifetime, memory, values, storage, fetcher, getToken, adapters, transport, open, index, original };
}
const noNetwork = vi.fn(() => { throw Error('Unexpected real network'); });
beforeEach(() => { vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', base); noNetwork.mockClear(); vi.stubGlobal('fetch', noNetwork); });
afterEach(() => { expect(noNetwork).not.toHaveBeenCalled(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('strict bounded financial JSON', () => {
  it.each(['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"nested":{"a":1,"a":2}}', '{"__proto__":{}}',
    '{"a":NaN}', '{"a":1e9999}', '{"a":01}', '{"a":1} {}', '{"a":true,}', '[]'])(
    'rejects malformed or ambiguous JSON %s', text => expect(() => parseFinancialPolicyJson(text)).toThrow());
  it('fits complete 50-record pages and the maximum eight escaped Unicode texts', () => {
    const siteIds = Array.from({ length: 100 }, (_, i) => `site_${i}`);
    const page = { items: Array.from({ length: 50 }, () => ({ policy: { scope: { siteIds, actionSiteIds: siteIds }, approval: { actionSiteIds: siteIds } } })) };
    expect(parseFinancialPolicyJson(JSON.stringify(page))).toEqual(page);
    const escaped = '\\ud83e\\uddf5'.repeat(20_000);
    const text = '{"documents":[' + Array.from({ length: 8 }, () => '{"text":"' + escaped + '"}').join(',') + ']}';
    expect((parseFinancialPolicyJson(text) as { documents: { text: string }[] }).documents[0]?.text).toBe('🧵'.repeat(20_000));
  });
  it('bounds bytes, depth, object keys and arrays', () => {
    for (const text of [' '.repeat(2 * 1024 * 1024) + '{}', '{"a":'.repeat(26) + '0' + '}'.repeat(26),
      JSON.stringify({ values: Array(101).fill(null) }), JSON.stringify(Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`key${i}`, 1])))])
      expect(() => parseFinancialPolicyJson(text)).toThrow();
  });
});
describe('explicit bounded financial policy transport', () => {
  it('does no construction I/O and makes one exact fresh-token GET per explicit action', async () => {
    const f = fixture(); expect(f.fetcher).not.toHaveBeenCalled(); expect(f.getToken).not.toHaveBeenCalled();
    await f.open(); expect(f.getToken).toHaveBeenCalledWith({ organizationId: 'provider_org', skipCache: true });
    expect(f.fetcher.mock.calls[0]?.[0]).toBe(base + '/v1/financial-governance/context');
    expect(f.fetcher.mock.calls[0]?.[1]).toMatchObject({ method: 'GET', cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
    expect(f.fetcher.mock.calls[0]?.[1].body).toBeUndefined();
    f.fetcher.mockResolvedValueOnce(json({ ...f.envelope(), kind: 'organization', responsibilityId: null, items: [], nextId: null }));
    await f.index(); expect(f.fetcher.mock.calls[1]?.[0]).toBe(base + '/v1/financial-governance?limit=50');
    expect(f.getToken).toHaveBeenCalledTimes(2); expect(Object.keys(f.transport).sort()).toEqual(['context', 'dispose', 'index', 'lookup', 'read']);
  });
  it('requires each lookup separately and retains negative originals, independent immutable receipt and stored reminder', async () => {
    const f = fixture(); await f.open(); const o = await f.original(), before = [...f.values];
    f.fetcher.mockResolvedValueOnce(json(o.response(false))); expect((await o.lookup()).status).toBe('not_recorded');
    expect(f.memory.original(o.attempt.reference)).toEqual(o.attempt); expect([...f.values]).toEqual(before);
    f.fetcher.mockResolvedValueOnce(json(o.response())); const result = await o.lookup();
    expect(result.receipt?.actor.membershipVersion).toBe(1); expect(f.memory.recorded(o.attempt.reference)).toEqual(o.receipt); expect([...f.values]).toEqual(before);
    const url = new URL(f.fetcher.mock.calls.at(-1)![0]);
    expect(url.pathname).toBe('/v1/financial-governance/operations/original_policy_001');
    expect([...url.searchParams.keys()]).toEqual(['kind', 'targetId', 'requestHash']);
  });
  it('uses exact version and immutable reference reads without silently selecting latest', async () => {
    const f = fixture(); await f.open(); const o = await f.original();
    const target = { kind: 'document' as const, responsibilityId: null, id: 'policy_a', version: 1, recordHash: o.receipt.target.recordHash };
    f.fetcher.mockResolvedValueOnce(json({ ...f.envelope(), responsibilityId: null, policy: { record: o.receipt.record, reference: o.receipt.target,
      projection: { currentRecord: true, state: 'DOCUMENT', blockers: [] }, budgetConfiguration: null }, documents: [], actions: [] }));
    const value = await f.transport.read(target, f.lifetime.authorize('read', target)); expect(value.policy.record.id).toBe('policy_a');
    expect(f.fetcher.mock.calls.at(-1)?.[0]).toBe(base + '/v1/financial-governance/documents/policy_a/versions/1');
  });
  it.each(['hide', 'close', 'session', 'org', 'actor', 'api-base', 'token-source'])(
    '%s during a pending token causes zero subsequent dispatch', async mode => {
      const f = fixture(), token = deferred<string>(); f.getToken.mockReturnValueOnce(token.promise); const pending = f.open().catch(e => e);
      if (mode === 'hide') f.lifetime.hide(); if (mode === 'close') f.lifetime.close();
      if (mode === 'session') f.current.value = { ...f.bootstrap, sessionId: 'new_session' };
      if (mode === 'org') f.current.value = { ...f.bootstrap, organizationId: 'other' };
      if (mode === 'actor') f.current.value = { ...f.bootstrap, actorId: 'other' };
      if (mode === 'api-base') vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', 'https://other.test');
      if (mode === 'token-source') f.adapters.getToken = vi.fn(async () => 'other_token');
      token.resolve('test_token'); expect(await pending).toMatchObject({ code: 'scope' }); expect(f.fetcher).not.toHaveBeenCalled();
    });
  it.each(['token', 'response', 'body'])(
    'bounds the entire %s wait to ten seconds and ignores late results', async phase => {
      const f = fixture(); vi.useFakeTimers(); const token = deferred<string>(), response = deferred<Response>(), cancel = vi.fn();
      if (phase === 'token') f.getToken.mockReturnValueOnce(token.promise);
      if (phase === 'response') f.fetcher.mockReturnValueOnce(response.promise);
      if (phase === 'body') f.fetcher.mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { headers }));
      const pending = f.open().catch(e => e); await vi.advanceTimersByTimeAsync(10000); expect(await pending).toMatchObject({ code: 'unconfirmed' });
      if (phase === 'token') { token.resolve('late_token'); await Promise.resolve(); expect(f.fetcher).not.toHaveBeenCalled(); }
      if (phase === 'response') { response.resolve(new Response(new ReadableStream({ cancel }), { headers })); await Promise.resolve(); await Promise.resolve(); }
      if (phase !== 'token') expect(cancel).toHaveBeenCalledOnce();
      expect(() => f.lifetime.observation()).toThrow();
    });
  it('checks monotonic request elapsed time even before a stalled timer callback', async () => {
    const f = fixture(), token = deferred<string>(); f.getToken.mockReturnValueOnce(token.promise); const pending = f.open().catch(e => e);
    f.time.mono += 10000; f.time.wall -= 60000; token.resolve('test_token');
    expect(await pending).toMatchObject({ code: 'unconfirmed' }); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('honors the original context deadline across later responses and clears before settlement', async () => {
    const f = fixture(); f.context.observation.expiresAt = iso(at + 1000); await f.open(); const o = await f.original();
    const token = deferred<string>(); f.getToken.mockReturnValueOnce(token.promise); const pending = o.lookup().catch(e => e);
    f.time.mono += 1000; token.resolve('test_token'); expect(await pending).toMatchObject({ code: 'expired' });
    expect(f.memory.original(o.attempt.reference)).toBeNull(); expect(f.values.size).toBe(1); expect(f.fetcher).toHaveBeenCalledOnce();
  });
  it('honors a stricter response deadline even if material verification finishes later', async () => {
    const f = fixture(); await f.open(); const o = await f.original();
    const value = o.response(); value.observation = { observedAt: iso(at - 1000), expiresAt: iso(at + 500) };
    f.fetcher.mockResolvedValueOnce(json(value));
    const digest = deferred<ArrayBuffer>(), spy = vi.spyOn(crypto.subtle, 'digest').mockReturnValueOnce(digest.promise);
    try {
      const pending = o.lookup().catch(e => e); await vi.waitFor(() => expect(spy).toHaveBeenCalled());
      f.time.mono += 1000; digest.resolve(Uint8Array.from(Buffer.from(o.receipt.record.contentHash, 'hex')).buffer);
      expect(await pending).toMatchObject({ code: 'expired' }); expect(f.memory.recorded(o.attempt.reference)).toBeNull(); expect(f.values.size).toBe(1);
    } finally { spy.mockRestore(); }
  });
  it.each([401, 403])('latches %s denial before reading body and persists denial across adapter replacement', async status => {
    const f = fixture(); await f.open(); const o = await f.original(), cancel = vi.fn();
    f.fetcher.mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { status, headers }));
    await expect(o.lookup()).rejects.toMatchObject({ code: 'scope' }); expect(cancel).toHaveBeenCalledOnce();
    expect(f.memory.original(o.attempt.reference)).toBeNull(); expect(f.values.size).toBe(1);
    createFinancialPolicyTransport({ ...f.adapters, getToken: vi.fn(async () => 'other_token') });
    expect(() => f.lifetime.authorize('context', contextQuery)).toThrow(); expect(() => f.lifetime.activate(f.bootstrap)).toThrow();
  });
  it('latches returned actor scope mismatch but lets a genuinely new session bootstrap refresh explicitly', async () => {
    const f = fixture(); f.context.scope.actor.actorId = 'other'; await expect(f.open()).rejects.toMatchObject({ code: 'scope' });
    expect(() => f.lifetime.authorize('context', contextQuery)).toThrow();
    f.context.scope.actor.actorId = 'owner_a'; f.current.value = { ...f.bootstrap, sessionId: 'new_session' }; f.lifetime.activate(f.current.value);
    expect((await f.open()).bootstrap.sessionId).toBe('new_session');
  });
  it('rejects obsolete adapters without invalidating a replacement context or accepting late callbacks', async () => {
    const f = fixture(), token = deferred<string>(); f.getToken.mockReturnValueOnce(token.promise); const old = f.open().catch(e => e);
    const replacement = createFinancialPolicyTransport({ ...f.adapters, getToken: vi.fn(async () => 'new_token') });
    await replacement.context(contextQuery, f.lifetime.authorize('context', contextQuery)); token.resolve('late_token');
    expect(await old).toMatchObject({ code: 'scope' }); expect(f.lifetime.observation().bootstrap).toEqual(f.bootstrap);
    f.transport.dispose(); expect(f.lifetime.observation().bootstrap).toEqual(f.bootstrap);
    expect(f.fetcher).toHaveBeenCalledOnce();
  });
  it.each(['duplicate', 'private', 'wrong-hash', 'not-found', 'malformed', 'content-type', 'cache', 'cache-alias', 'overflow', 'utf8'])(
    'preserves unresolved originals after %s output', async mode => {
      const f = fixture(); await f.open(); const o = await f.original(), before = [...f.values]; let response: Response;
      if (mode === 'duplicate') response = new Response('{"status":"recorded","status":"not_recorded"}', { headers });
      else if (mode === 'private') response = json({ ...o.response(), commandHash: 'private' });
      else if (mode === 'wrong-hash') response = json({ ...o.response(), publicRequestHash: 'f'.repeat(64) });
      else if (mode === 'not-found') response = json({ error: { code: 'NOT_FOUND', message: 'private server diagnostic' } }, 404);
      else if (mode === 'malformed') response = new Response('{', { headers });
      else if (mode === 'overflow') response = new Response(' '.repeat(2 * 1024 * 1024 + 1), { headers });
      else if (mode === 'utf8') response = new Response(new Uint8Array([0xc3, 0x28]), { headers });
      else response = new Response(JSON.stringify(o.response()), { headers: { ...headers,
        ...(mode === 'content-type' ? { 'Content-Type': 'text/plain' } : { 'Cache-Control': mode === 'cache-alias' ? 'x-no-store, public' : 'no-store="true"' }) } });
      f.fetcher.mockResolvedValueOnce(response); await expect(o.lookup()).rejects.toBeDefined();
      expect(f.memory.original(o.attempt.reference)).toEqual(o.attempt); expect(f.memory.recorded(o.attempt.reference)).toBeNull(); expect([...f.values]).toEqual(before);
    });
  it('invalidates private state on hide while the in-flight original reference survives', async () => {
    const f = fixture(); await f.open(); const o = await f.original(), response = deferred<Response>(); f.fetcher.mockReturnValueOnce(response.promise);
    const pending = o.lookup().catch(e => e); await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(2)); f.lifetime.hide();
    expect(f.memory.original(o.attempt.reference)).toBeNull(); response.resolve(json(o.response()));
    expect(await pending).toMatchObject({ code: 'scope' }); expect(f.memory.recorded(o.attempt.reference)).toBeNull(); expect(f.values.size).toBe(1);
  });
  it.each(['redirect', 'foreign-url', 'oversize-length', 'padding-length'])(
    'rejects %s response metadata and cancels the unread body', async mode => {
      const f = fixture(), cancel = vi.fn(), response = new Response(new ReadableStream({ cancel }), { headers: { ...headers,
        ...(mode === 'oversize-length' ? { 'Content-Length': String(2 * 1024 * 1024 + 1) } : mode === 'padding-length' ? { 'Content-Length': '+12' } : {}) } });
      if (mode === 'redirect') Object.defineProperty(response, 'redirected', { value: true });
      if (mode === 'foreign-url') Object.defineProperty(response, 'url', { value: 'https://other.test/v1/financial-governance/context' });
      f.fetcher.mockResolvedValueOnce(response); await expect(f.open()).rejects.toMatchObject({ code: 'unconfirmed' }); expect(cancel).toHaveBeenCalledOnce();
    });
});
