import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commandDigest } from '@pactwoven/contracts/canonical';
import { FinancialPolicyHttpScopeSchema, type FinancialPolicyHttpReceipt } from '@pactwoven/contracts';
import { createFinancialPolicyAttempt, financialSame } from './financial-policy-contract';
import { createFinancialPolicyLifetime, FinancialPolicyBootstrapSchema, financialPolicyLocalScope, qualifyFinancialContext,
  type FinancialPolicyBootstrap } from './financial-policy-context';
import { createFinancialPolicyWriteTransport, parseFinancialPolicyWriteRequest, type FinancialPolicyWriteTransportAdapters } from './financial-policy-write-transport';

const at = Date.parse('2026-11-15T00:00:00.000Z'), iso = (n: number) => new Date(n).toISOString(), base = 'https://api.example.test';
const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' };
const json = (value: unknown, status = 200) => Response.json(value, { headers, status });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
async function fixture(text = 'Exact reviewed policy. Café 🧵') {
  const bootstrap = FinancialPolicyBootstrapSchema.parse({ environment: 'development', organizationId: 'org_a', actorId: 'owner_a', apiBase: base,
    responsibilityId: null, userId: 'user_a', externalOrganizationId: 'provider_org', sessionId: 'session_a', organizationEpoch: 2,
    roles: ['owner'], siteIds: ['site_a'], actionSiteIds: ['site_a'], responsibility: null });
  const scope = FinancialPolicyHttpScopeSchema.parse({ environment: 'development', organizationId: 'org_a', actor: { actorId: 'owner_a', membershipVersion: 5 },
    organizationEpoch: 2, roles: ['owner'], siteIds: ['site_a'], actionSiteIds: ['site_a'] });
  const envelope = { schemaVersion: 1, scope, observation: { observedAt: iso(at - 1000), expiresAt: iso(at + 19000) }, effectiveAuthority: false, financialState: null };
  const context = { ...envelope, kind: 'organization', responsibilityId: null, configurationVisibility: 'full', draftScope: null,
    asset: null, control: null, acceptedConfiguration: null, periods: [], documents: [], actions: [],
    blockers: ['ASSET_MISSING', 'FINANCIAL_AUTHORITY_UNAVAILABLE', 'GOVERNANCE_MISSING', 'TRUST_UNAVAILABLE'] };
  const time = { wall: at, mono: 100 }, clocks = { wall: () => time.wall, monotonic: () => time.mono };
  const lifetime = createFinancialPolicyLifetime(bootstrap, clocks);
  const readTicket = lifetime.start(lifetime.authorize('context', {}), 'context', {});
  lifetime.accept(readTicket, await qualifyFinancialContext(context, bootstrap, at, 100)); lifetime.finish(readTicket);
  const observation = lifetime.observation(), current = { value: bootstrap as FinancialPolicyBootstrap | null }, state = { dispatched: false, used: false, valid: true };
  const attempt = await createFinancialPolicyAttempt(financialPolicyLocalScope(bootstrap), { kind: 'save_document', responsibilityId: null,
    id: 'policy_a', key: 'original_policy_001', route: '/v1/financial-governance/documents/policy_a',
    input: { schemaVersion: 1, previous: null, organizationEpoch: 2, purpose: 'budget_policy', text } });
  const actor = { actorId: 'owner_a', membershipVersion: 1 }, operationId = '00000000-0000-0000-0000-000000000001';
  const receipt: FinancialPolicyHttpReceipt = { schemaVersion: 1, environment: 'development', organizationId: 'org_a', actor, responsibilityId: null,
    operationId, kind: 'save_document', key: attempt.request.key, publicRequestHash: attempt.reference.locator.publicRequestHash,
    target: { id: 'policy_a', version: 1, recordHash: 'a'.repeat(64) }, effectiveAuthority: false, financialState: null,
    record: { schemaVersion: 1, environment: 'development', organizationId: 'org_a', actor, responsibilityId: null, id: 'policy_a', version: 1,
      predecessor: null, organizationEpoch: 2, operationId, createdAt: iso(at), kind: 'document', purpose: 'budget_policy', text,
      contentHash: await commandDigest({ namespace: 'pactwoven:financial-policy-text:v1', text }) } };
  const response = () => ({ ...envelope, status: 'recorded', receipt });
  const order: string[] = [], lease = Object.freeze({});
  const assertCurrent = vi.fn(() => { if (!state.valid) throw Error('synthetic preparation expired'); });
  const markDispatched = vi.fn(() => { assertCurrent(); if (state.dispatched) throw Error('second dispatch'); state.dispatched = true; order.push('mark'); });
  const settle = vi.fn(async (_receipt: FinancialPolicyHttpReceipt, guard: () => void) => { guard(); });
  const fetcher = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => { order.push('fetch'); return json(response()); });
  const getToken = vi.fn(async () => { order.push('token'); return 'test_token'; });
  const adapters: FinancialPolicyWriteTransportAdapters = { lifetime, currentBootstrap: () => current.value, getToken, fetch: fetcher, ...clocks,
    claim: (candidate, original) => {
      if (candidate !== lease || state.used || !financialSame(original, attempt)) throw Error('invalid local lease');
      state.used = true; return { bootstrap, observation, signal: new AbortController().signal, assertCurrent, markDispatched, settle };
    } };
  const transport = createFinancialPolicyWriteTransport(adapters), send = () => transport.submit(attempt, lease);
  return { bootstrap, scope, envelope, observation, current, lifetime, time, attempt, receipt, response, state, order, lease,
    fetcher, getToken, adapters, transport, send, settle, assertCurrent, markDispatched };
}
const noNetwork = vi.fn(() => { throw Error('Unexpected real network'); });
beforeEach(() => { vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', base); noNetwork.mockClear(); vi.stubGlobal('fetch', noNetwork); });
afterEach(() => { expect(noNetwork).not.toHaveBeenCalled(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('financial policy write transport boundary', () => {
  it('has no construction I/O or default submit capability and preserves the read observation owner', async () => {
    const f = await fixture(); expect(f.getToken).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.lifetime.observation()).toBe(f.observation);
    const unavailable = createFinancialPolicyWriteTransport({ ...f.adapters, claim: null });
    await expect(unavailable.submit(f.attempt, f.lease)).rejects.toMatchObject({ code: 'unavailable' });
    expect(f.getToken).not.toHaveBeenCalled(); expect(Object.keys(f.transport).sort()).toEqual(['dispose', 'submit']);
  });
  it('sends exact input/key only, marks before fetch and separately qualifies historical membership', async () => {
    const f = await fixture(), result = await f.send();
    expect(f.order).toEqual(['token', 'mark', 'fetch']); expect(f.getToken).toHaveBeenCalledWith({ organizationId: 'provider_org', skipCache: true });
    expect(f.fetcher).toHaveBeenCalledOnce();
    const [url, init] = f.fetcher.mock.calls[0]!;
    expect(url).toBe(base + f.attempt.request.route);
    expect(init).toMatchObject({ method: 'POST', cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
      body: JSON.stringify(f.attempt.request.input), headers: { Accept: 'application/json', 'Content-Type': 'application/json',
        Authorization: 'Bearer test_token', 'Idempotency-Key': 'original_policy_001' } });
    expect(result.actor.membershipVersion).toBe(1); expect(f.settle).toHaveBeenCalledOnce();
    await expect(f.send()).rejects.toBeDefined(); expect(f.fetcher).toHaveBeenCalledOnce();
  });
  it.each(['withdraw_draft', 'propose_governance', 'accept_governance', 'reject_governance'])(
    'has no supported %s write path', async kind => {
      const f = await fixture(); expect(() => parseFinancialPolicyWriteRequest({ ...f.attempt.request, kind })).toThrow();
      expect(f.fetcher).not.toHaveBeenCalled();
    });
  it('detaches the original before a delayed hash and ignores caller edits', async () => {
    const f = await fixture(), copy = structuredClone(f.attempt), token = deferred<string>(); f.getToken.mockReturnValueOnce(token.promise);
    const pending = f.transport.submit(copy, f.lease);
    if (copy.request.kind === 'save_document') copy.request.input.text = 'Changed after review'; copy.request.key = 'changed_key';
    await vi.waitFor(() => expect(f.getToken).toHaveBeenCalledOnce()); token.resolve('test_token');
    expect(await pending).toEqual(f.receipt); expect(f.fetcher.mock.calls[0]?.[1].body).toBe(JSON.stringify(f.attempt.request.input));
  });
  it.each(['scope', 'session', 'adapter', 'api-base', 'preparation', 'hide', 'close', 'clock'])(
    '%s loss during token acquisition prevents dispatch', async mode => {
      const f = await fixture(), token = deferred<string>(); f.getToken.mockReturnValueOnce(token.promise);
      const pending = f.send().catch(e => e); await vi.waitFor(() => expect(f.getToken).toHaveBeenCalledOnce());
      if (mode === 'scope') f.current.value = null;
      if (mode === 'session') f.current.value = { ...f.bootstrap, sessionId: 'other_session' };
      if (mode === 'adapter') f.adapters.getToken = vi.fn(async () => 'new_token');
      if (mode === 'api-base') vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', 'https://other.test');
      if (mode === 'preparation') f.state.valid = false;
      if (mode === 'hide') f.lifetime.hide();
      if (mode === 'close') f.transport.dispose();
      if (mode === 'clock') f.time.mono -= 1;
      token.resolve('test_token'); expect(await pending).toBeInstanceOf(Error);
      expect(f.markDispatched).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled();
    });
  it.each(['token', 'fetch', 'body', 'settle'])('bounds an abort-ignoring %s wait', async phase => {
    const f = await fixture(), token = deferred<string>(), response = deferred<Response>(), settlement = deferred<void>(), cancel = vi.fn();
    vi.useFakeTimers();
    if (phase === 'token') f.getToken.mockReturnValueOnce(token.promise);
    if (phase === 'fetch') f.fetcher.mockReturnValueOnce(response.promise);
    if (phase === 'body') f.fetcher.mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { headers }));
    if (phase === 'settle') f.settle.mockReturnValueOnce(settlement.promise);
    const pending = f.send().catch(e => e);
    await vi.waitFor(() => expect(phase === 'token' ? f.getToken : phase === 'settle' ? f.settle : f.fetcher).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(10000); expect(await pending).toMatchObject({ code: 'unconfirmed' });
    token.resolve('late_token'); response.resolve(new Response(new ReadableStream({ cancel }), { headers })); settlement.resolve();
    await Promise.resolve(); await Promise.resolve();
    if (phase === 'token') expect(f.fetcher).not.toHaveBeenCalled();
    if (phase === 'fetch' || phase === 'body') expect(cancel).toHaveBeenCalledOnce();
  });
  it('checks elapsed monotonic time without a timer and cannot extend deadline by wall rollback', async () => {
    const f = await fixture(), token = deferred<string>(); f.getToken.mockReturnValueOnce(token.promise);
    const pending = f.send().catch(e => e); await vi.waitFor(() => expect(f.getToken).toHaveBeenCalledOnce());
    f.time.wall -= 60000; f.time.mono += 10000; token.resolve('test_token');
    expect(await pending).toMatchObject({ code: 'unconfirmed' }); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it.each([401, 403])('latches %s before body read and retains the dispatch fact', async status => {
    const f = await fixture(), cancel = vi.fn(); f.fetcher.mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { headers, status }));
    await expect(f.send()).rejects.toMatchObject({ code: 'scope' }); expect(f.state.dispatched).toBe(true); expect(cancel).toHaveBeenCalledOnce();
    expect(f.settle).not.toHaveBeenCalled(); expect(() => f.lifetime.activate(f.bootstrap)).toThrow();
    createFinancialPolicyWriteTransport({ ...f.adapters }); expect(() => f.lifetime.authorize('context', {})).toThrow();
  });
  it('marks synchronous fetch failure and never retries or exposes provider diagnostics', async () => {
    const f = await fixture(); f.fetcher.mockImplementationOnce(() => { throw Error('private provider diagnostic'); });
    const error = await f.send().catch(e => e); expect(f.state.dispatched).toBe(true); expect(f.fetcher).toHaveBeenCalledOnce();
    expect(error.message).not.toContain('private provider'); expect(f.settle).not.toHaveBeenCalled();
  });
  it.each(['duplicate', 'utf8', 'truncated-utf8', 'content-type', 'cache', 'cache-alias', 'overflow', 'length', 'short-length', 'redirect', 'foreign-url',
    'status', 'unknown', 'typed-preflight', 'body', 'hash', 'predecessor', 'text', 'membership', 'authority'])(
    'rejects %s response without settlement', async mode => {
      const f = await fixture(); let response: Response;
      if (mode === 'duplicate') response = new Response('{"status":"recorded","\\u0073tatus":"recorded"}', { headers });
      else if (mode === 'utf8' || mode === 'truncated-utf8') response = new Response(new Uint8Array(mode === 'utf8' ? [0xc3, 0x28] : [0xf0, 0x9f]), { headers });
      else if (mode === 'overflow') response = new Response(' '.repeat(2 * 1024 * 1024 + 1), { headers });
      else if (['content-type', 'cache', 'cache-alias', 'length', 'short-length'].includes(mode)) response = new Response(JSON.stringify(f.response()), {
        headers: { ...headers, ...(mode === 'content-type' ? { 'Content-Type': 'text/plain' } : mode === 'length' ? { 'Content-Length': '+123' }
          : mode === 'short-length' ? { 'Content-Length': '1' } : { 'Cache-Control': mode === 'cache' ? 'no-store=true' : 'x-no-store, public' }) } });
      else if (mode === 'status') response = json(f.response(), 302);
      else if (mode === 'unknown' || mode === 'typed-preflight') response = json({ error: { code: mode === 'unknown' ? 'FINANCIAL_POLICY_OUTCOME_UNKNOWN' : 'FINANCIAL_POLICY_INPUT_INVALID', message: 'private' } }, mode === 'unknown' ? 503 : 422);
      else {
        const value = structuredClone(f.response());
        if (mode === 'body') Object.assign(value, { commandHash: 'private' });
        if (mode === 'hash') value.receipt.publicRequestHash = 'b'.repeat(64);
        if (mode === 'predecessor') { value.receipt.record.predecessor = { id: 'policy_a', version: 1, recordHash: 'b'.repeat(64) }; value.receipt.record.version = 2; value.receipt.target.version = 2; }
        if (mode === 'text' && value.receipt.record.kind === 'document') {
          value.receipt.record.text = 'Changed material'; value.receipt.record.contentHash = await commandDigest({ namespace: 'pactwoven:financial-policy-text:v1', text: value.receipt.record.text });
        }
        if (mode === 'membership') value.scope.actor.membershipVersion += 1;
        if (mode === 'authority') Object.assign(value, { effectiveAuthority: true });
        response = json(value);
        if (mode === 'redirect') Object.defineProperty(response, 'redirected', { value: true });
        if (mode === 'foreign-url') Object.defineProperty(response, 'url', { value: 'https://other.test/private' });
      }
      f.fetcher.mockResolvedValueOnce(response); await expect(f.send()).rejects.toBeDefined();
      expect(f.state.dispatched).toBe(true); expect(f.settle).not.toHaveBeenCalled(); expect(f.fetcher).toHaveBeenCalledOnce();
    });
  it('streams the maximum supported astral text over split UTF-8 boundaries without changing input', async () => {
    const f = await fixture('🧵'.repeat(20000)), bytes = new TextEncoder().encode(JSON.stringify(f.response()));
    f.fetcher.mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) {
      for (let i = 0; i < bytes.length; i += 197) controller.enqueue(bytes.slice(i, i + 197)); controller.close();
    } }), { headers }));
    expect(await f.send()).toEqual(f.receipt); expect(f.fetcher.mock.calls[0]?.[1].body).toBe(JSON.stringify(f.attempt.request.input));
  });
  it('checks the stricter response expiry after an asynchronous receipt hash', async () => {
    const f = await fixture(), digest = deferred<ArrayBuffer>(), value = f.response(); value.observation = { observedAt: iso(at - 1000), expiresAt: iso(at + 500) };
    const realDigest = crypto.subtle.digest.bind(crypto.subtle); let stalled = false;
    const spy = vi.spyOn(crypto.subtle, 'digest').mockImplementation((algorithm, data) => {
      const text = new TextDecoder().decode(data as ArrayBuffer);
      if (!stalled && text.includes('financial-policy-text:v1')) { stalled = true; return digest.promise; }
      return realDigest(algorithm, data);
    });
    f.fetcher.mockResolvedValueOnce(json(value)); const pending = f.send().catch(e => e);
    await vi.waitFor(() => expect(stalled).toBe(true)); f.time.mono += 500;
    if (f.receipt.record.kind !== 'document') throw Error('fixture');
    digest.resolve(Uint8Array.from(Buffer.from(f.receipt.record.contentHash, 'hex')).buffer);
    expect(await pending).toMatchObject({ code: 'expired' }); expect(f.settle).not.toHaveBeenCalled(); spy.mockRestore();
  });
});
