import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gzipSync } from 'node:zlib';
import { FINANCIAL_POLICY_PREPARATION_RESPONSE_MAX_BYTES } from '@pactwoven/contracts';
import { commandDigest } from '@pactwoven/contracts/canonical';
import { FinancialPolicyBootstrapSchema, createFinancialPolicyLifetime, financialPolicyLocalScope, type FinancialPolicyBootstrap } from './financial-policy-context';
import { createFinancialPolicyMemory, type FinancialPolicyStorage } from './financial-policy-recovery';
import { createFinancialPolicyAttempt } from './financial-policy-contract';
import { createFinancialPolicyAttemptCoordinator } from './financial-policy-attempt-coordinator';
import { createFinancialPolicyTransport } from './financial-policy-transport';
import { parseFinancialPolicyWriteRequest } from './financial-policy-write-transport';
import { createFinancialPolicyPreparationClient, type FinancialPolicyPreparationClientAdapters } from './financial-policy-preparation-client';

const at = Date.parse('2026-11-15T00:00:00.000Z'), iso = (n: number) => new Date(n).toISOString(), base = 'https://api.example.test', hash = 'a'.repeat(64);
const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' }, json = (value: unknown, status = 200) => Response.json(value, { headers, status });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const cleanup: (() => void)[] = [];
async function fixture(kind: 'document' | 'draft' = 'document', organization = false) {
  const rid = organization ? null : 'responsibility_a';
  const bootstrap = FinancialPolicyBootstrapSchema.parse({ environment: 'development', organizationId: 'org_a', actorId: 'actor_a', apiBase: base,
    responsibilityId: rid, userId: 'user_a', externalOrganizationId: 'provider_org', sessionId: 'session_a', organizationEpoch: 2,
    roles: ['owner'], siteIds: ['site_a'], actionSiteIds: ['site_a'], responsibility: rid ? { id: rid, version: 1, siteId: 'site_a' } : null });
  const scope = { environment: 'development', organizationId: 'org_a', actor: { actorId: 'actor_a', membershipVersion: 9 }, organizationEpoch: 2,
    roles: ['owner'], siteIds: ['site_a'], actionSiteIds: ['site_a'] };
  const authority = { schemaVersion: 1, responsibility: { id: 'responsibility_a', version: 1, hash, siteId: 'site_a' }, generation: 0, family: 'none', legacyHead: null };
  const basis = { authority, authorityHash: await commandDigest({ namespace: 'pactwoven:financial-authority-fence:v1', record: { ...authority, environment: 'development', organizationId: 'org_a' } }),
    site: { id: 'site_a', generation: 0, recordHash: hash } };
  const envelope = { schemaVersion: 1, scope, observation: { observedAt: iso(at - 1000), expiresAt: iso(at + 19000) }, effectiveAuthority: false, financialState: null };
  const context = { ...envelope, kind: organization ? 'organization' : 'responsibility', responsibilityId: rid, configurationVisibility: 'full', draftScope: rid ? basis : null,
    asset: null, control: null, acceptedConfiguration: null, periods: [], documents: [], actions: [],
    blockers: ['ASSET_MISSING', 'FINANCIAL_AUTHORITY_UNAVAILABLE', 'GOVERNANCE_MISSING', 'TRUST_UNAVAILABLE'] };
  const current = { value: bootstrap as FinancialPolicyBootstrap | null }, time = { wall: at, mono: 100 }, clocks = { wall: () => time.wall, monotonic: () => time.mono };
  const lifetime = createFinancialPolicyLifetime(bootstrap, clocks), memory = createFinancialPolicyMemory(financialPolicyLocalScope(bootstrap));
  const readFetch = vi.fn(async () => json(context)), read = createFinancialPolicyTransport({ lifetime, memory, storage: () => null, currentBootstrap: () => current.value,
    getToken: async () => 'read_token', fetch: readFetch, ...clocks });
  const query = { assetKey: null }, refresh = () => read.context(query, lifetime.authorize('context', query)); await refresh();
  const purpose = organization ? 'budget_policy' : 'financial_mandate', text = 'Exact full mandate. Café 🧵', docRef = { id: 'mandate_doc', version: 1, recordHash: hash };
  const document = { reference: docRef, record: { schemaVersion: 1, environment: 'development', organizationId: 'org_a', responsibilityId: 'responsibility_a', id: docRef.id,
    version: 1, predecessor: null, actor: { actorId: 'actor_a', membershipVersion: 1 }, organizationEpoch: 1,
    operationId: '00000000-0000-0000-0000-000000000001', createdAt: iso(at - 1000), kind: 'document', purpose: 'financial_mandate', text,
    contentHash: await commandDigest({ namespace: 'pactwoven:financial-policy-text:v1', text }) }, projection: { currentRecord: true, state: 'DOCUMENT', blockers: [] }, budgetConfiguration: null };
  const selection: any = kind === 'document' ? { schemaVersion: 1, action: 'save_document', targetId: 'policy_a', previous: null, purpose }
    : { schemaVersion: 1, action: 'save_draft', targetId: 'policy_a', previous: null, document: docRef };
  const material = kind === 'document' ? { action: 'save_document', purpose, organizationEpoch: 2, draftScope: rid ? basis : null, siteActive: rid ? true : null }
    : { action: 'save_draft', profile: 'incomplete', draftScope: basis, siteActive: true, document, asset: null, account: null, governance: null, trust: null };
  const response: any = { ...envelope, responsibilityId: rid, selection, decision: { action: selection.action, state: 'reviewable', reasons: [], requiredAuthentication: null },
    target: { state: 'absent', latestReference: null, record: null, historicalDocuments: [] }, material, configurationWarnings: ['FINANCIAL_AUTHORITY_UNAVAILABLE', 'TRUST_UNAVAILABLE'] };
  const write = () => parseFinancialPolicyWriteRequest({ kind: selection.action, responsibilityId: rid, id: 'policy_a', key: 'original_policy_001',
    route: kind === 'document' ? organization ? '/v1/financial-governance/documents/policy_a' : '/v1/responsibilities/responsibility_a/financial-policy-documents/policy_a'
      : '/v1/responsibilities/responsibility_a/financial-policies/policy_a', input: kind === 'document' ? { schemaVersion: 1, previous: null, organizationEpoch: 2, purpose, text: 'Newly reviewed local text.' }
      : { schemaVersion: 1, previous: null, organizationEpoch: 2, draft: { scope: basis, terms: { mode: 'PREPARE_FOR_APPROVAL', actions: ['allocate_funds'], category: 'supplier_principal',
        allocation: 'responsibility_earmark', supplier: null, acceptedTerms: null, payee: null, tool: null, withdrawal: null, branch: null,
        communication: { recipients: [], purposes: [], kinds: [], allowanceBaseUnits: '0' } }, documents: [{ ...docRef, purpose: 'financial_mandate' }],
        asset: null, account: null, governance: null, trust: null, startsAt: iso(at - 1000), expiresAt: iso(at + 86400000) } } });
  const fetcher = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => json(response)), getToken = vi.fn(async () => 'preparation_token');
  const adapters: FinancialPolicyPreparationClientAdapters = { lifetime, currentBootstrap: () => current.value, getToken, fetch: fetcher, ...clocks };
  const client = createFinancialPolicyPreparationClient(adapters); cleanup.push(() => client.close());
  const prepare = () => client.prepare(client.issue(selection));
  const capture = () => client.verifier.capture({ request: write(), bootstrap, observation: lifetime.observation() });
  return { bootstrap, context, current, lifetime, memory, time, basis, response, selection, adapters, fetcher, getToken, client, readFetch, refresh, prepare, capture, write };
}
const noNetwork = vi.fn(() => { throw Error('Unexpected actual network'); });
beforeEach(() => { vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', base); noNetwork.mockClear(); vi.stubGlobal('fetch', noNetwork); });
afterEach(() => { for (const close of cleanup.splice(0)) close(); expect(noNetwork).not.toHaveBeenCalled(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('explicit preparation client and stable verifier', () => {
  it('starts unavailable with no construction I/O and no public installation shortcut', async () => {
    const f = await fixture(); expect(f.getToken).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled(); expect(() => f.capture()).toThrow();
    expect(f.client.getSnapshot()).toEqual({ state: 'idle', preparation: null }); expect(f.context.actions).toEqual([]);
    await expect(f.client.prepare({} as never)).rejects.toMatchObject({ code: 'scope' });
    await expect(f.client.prepare(f.lifetime.authorize('read', {}) as never)).rejects.toMatchObject({ code: 'scope' });
    expect(f.fetcher).not.toHaveBeenCalled(); expect(Object.keys(f.client).sort()).toEqual(['close', 'getServerSnapshot', 'getSnapshot', 'invalidate', 'issue', 'prepare', 'subscribe', 'verifier']);
  });
  it.each([false, true])('sends only the exact metadata selector on the organization=%s route', async organization => {
    const f = await fixture('document', organization), verifier = f.client.verifier, observation = f.lifetime.observation(); await f.prepare();
    expect(f.client.verifier).toBe(verifier); expect(f.lifetime.observation()).toBe(observation);
    expect(f.getToken).toHaveBeenCalledWith({ organizationId: 'provider_org', skipCache: true });
    expect(f.fetcher).toHaveBeenCalledOnce(); const [url, init] = f.fetcher.mock.calls[0]!;
    expect(url).toBe(base + (organization ? '/v1/financial-governance-preparation' : '/v1/responsibilities/responsibility_a/financial-policy-preparation'));
    expect(init).toMatchObject({ method: 'POST', cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
    expect(JSON.parse(String(init.body))).toEqual(f.selection);
    expect(new Headers(init.headers).has('Idempotency-Key')).toBe(false); expect(String(init.body)).not.toContain('Newly reviewed');
    const assertion = f.capture(); expect(() => assertion.assertCurrent()).not.toThrow(); expect(f.getToken).toHaveBeenCalledOnce();
  });
  it('qualifies a separate incomplete draft without granting effective financial authority', async () => {
    const f = await fixture('draft'); await f.prepare(); const assertion = f.capture(); expect(() => assertion.assertCurrent()).not.toThrow();
    expect(f.client.getSnapshot().preparation?.response).toMatchObject({ effectiveAuthority: false, financialState: null,
      material: { profile: 'incomplete', asset: null, account: null, governance: null, trust: null } });
  });
  it.each([true, false])('accepts Fetch-decoded preparation with gzip wire length and exposed encoding: %s', async encodingExposed => {
    const f = await fixture('draft'), bytes = new TextEncoder().encode(JSON.stringify(f.response)), wire = gzipSync(bytes);
    expect(wire.byteLength).toBeLessThan(bytes.byteLength);
    const responseHeaders = { ...headers, 'Content-Length': String(wire.byteLength), ...(encodingExposed ? { 'Content-Encoding': 'gzip' } : {}) };
    // Browsers expose decoded chunks; CORS may hide Content-Encoding while exposing Content-Length.
    f.fetcher.mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) {
      for (let i = 0; i < bytes.length; i += 197) controller.enqueue(bytes.slice(i, i + 197)); controller.close();
    } }), { headers: responseHeaders }));
    const result = await f.prepare(); expect(result.response).toEqual(f.response); expect(f.capture().expiresAt).toBe(at + 19000);
    expect(f.fetcher).toHaveBeenCalledOnce(); expect(f.readFetch).toHaveBeenCalledOnce();
  });
  it('rejects oversized decoded preparation even when its gzip wire length is within the bound', async () => {
    const f = await fixture(), text = JSON.stringify(f.response);
    const bytes = new TextEncoder().encode(' '.repeat(FINANCIAL_POLICY_PREPARATION_RESPONSE_MAX_BYTES + 1 - new TextEncoder().encode(text).byteLength) + text);
    const wire = gzipSync(bytes), cancel = vi.fn(); expect(wire.byteLength).toBeLessThan(FINANCIAL_POLICY_PREPARATION_RESPONSE_MAX_BYTES);
    f.fetcher.mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes); }, cancel }), {
      headers: { ...headers, 'Content-Length': String(wire.byteLength), 'Content-Encoding': 'gzip' },
    }));
    await expect(f.prepare()).rejects.toMatchObject({ code: 'unavailable' }); expect(cancel).toHaveBeenCalledOnce();
    expect(f.client.getSnapshot().preparation).toBeNull(); expect(() => f.capture()).toThrow(); expect(f.fetcher).toHaveBeenCalledOnce();
  });
  it.each(['utf8', 'duplicate', 'truncated'])('rejects Fetch-decoded gzip %s data without installing preparation', async mode => {
    const f = await fixture(), bytes = mode === 'utf8' ? new Uint8Array([0xf0, 0x9f])
      : new TextEncoder().encode(mode === 'duplicate' ? '{"a":1,"\\u0061":2}' : JSON.stringify(f.response).slice(0, -1));
    f.fetcher.mockResolvedValueOnce(new Response(bytes, { headers: { ...headers, 'Content-Length': String(gzipSync(bytes).byteLength), 'Content-Encoding': 'gzip' } }));
    await expect(f.prepare()).rejects.toMatchObject({ code: 'unavailable' });
    expect(f.client.getSnapshot().preparation).toBeNull(); expect(() => f.capture()).toThrow(); expect(f.fetcher).toHaveBeenCalledOnce();
  });
  it('supplies the unchanged UI2B0 port for a separate explicit synthetic document write', async () => {
    const f = await fixture('document', true); await f.prepare();
    const request = f.write(); if (request.kind !== 'save_document') throw Error('fixture');
    const attempt = await createFinancialPolicyAttempt(financialPolicyLocalScope(f.bootstrap), request);
    const actor = { actorId: 'actor_a', membershipVersion: 1 }, operationId = '00000000-0000-0000-0000-000000000001';
    const receipt = { schemaVersion: 1, environment: 'development', organizationId: 'org_a', actor, responsibilityId: null, operationId,
      kind: 'save_document', key: request.key, publicRequestHash: attempt.reference.locator.publicRequestHash, target: { id: request.id, version: 1, recordHash: hash },
      record: { schemaVersion: 1, environment: 'development', organizationId: 'org_a', responsibilityId: null, id: request.id, version: 1, predecessor: null,
        actor, organizationEpoch: 2, operationId, createdAt: iso(at), kind: 'document', purpose: request.input.purpose, text: request.input.text,
        contentHash: await commandDigest({ namespace: 'pactwoven:financial-policy-text:v1', text: request.input.text }) }, effectiveAuthority: false, financialState: null };
    const values = new Map<string, string>(), storage: FinancialPolicyStorage = { get length() { return values.size; }, key: i => [...values.keys()][i] ?? null,
      getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); } };
    const writerFetch = vi.fn(async () => json({ schemaVersion: 1, scope: f.response.scope, observation: f.response.observation, status: 'recorded', receipt,
      effectiveAuthority: false, financialState: null }));
    const coordinator = createFinancialPolicyAttemptCoordinator({ ...f.adapters, fetch: writerFetch, memory: f.memory, storage: () => storage, preparation: f.client.verifier });
    cleanup.push(() => coordinator.close()); expect(writerFetch).not.toHaveBeenCalled();
    const result = await coordinator.send(coordinator.review(request)); expect(result.reference).toEqual(attempt.reference);
    expect(writerFetch).toHaveBeenCalledOnce(); expect(f.fetcher).toHaveBeenCalledOnce(); expect(values.size).toBe(1);
  });
  it('requires one-use current tickets and ignores caller selector mutations', async () => {
    const f = await fixture(), old = f.client.issue(f.selection), selection = structuredClone(f.selection), ticket = f.client.issue(selection);
    selection.targetId = 'after_issue'; await expect(f.client.prepare(old)).rejects.toMatchObject({ code: 'scope' });
    await f.client.prepare(ticket); expect(JSON.parse(String(f.fetcher.mock.calls[0]?.[1].body))).toEqual(f.selection);
    await expect(f.client.prepare(ticket)).rejects.toMatchObject({ code: 'scope' }); expect(f.fetcher).toHaveBeenCalledOnce();
  });
  it.each(['target', 'previous', 'purpose', 'epoch', 'observation', 'bootstrap', 'document', 'basis', 'expiry', 'optional'])(
    'cannot capture a mismatched full write %s', async mode => {
      const f = await fixture(['document', 'basis', 'expiry', 'optional'].includes(mode) ? 'draft' : 'document'); await f.prepare();
      const request = structuredClone(f.write()), observation = f.lifetime.observation(); let bootstrap = f.bootstrap;
      if (mode === 'target') { request.id = 'other'; request.route = request.route.replace('/policy_a', '/other'); }
      if (mode === 'previous') request.input.previous = { id: 'policy_a', version: 1, recordHash: hash };
      if (mode === 'purpose' && request.kind === 'save_document') request.input.purpose = 'approval_policy';
      if (mode === 'epoch') request.input.organizationEpoch++;
      if (mode === 'bootstrap') bootstrap = { ...bootstrap, sessionId: 'other' };
      if (request.kind === 'save_draft') {
        if (mode === 'document') request.input.draft.documents[0]!.recordHash = 'b'.repeat(64);
        if (mode === 'basis') request.input.draft.scope.site.generation++;
        if (mode === 'expiry') request.input.draft.expiresAt = iso(at);
        if (mode === 'optional') request.input.draft.asset = { key: hash, version: 1, recordHash: hash, financialUseEpoch: 0 };
      }
      expect(() => f.client.verifier.capture({ request, bootstrap, observation: mode === 'observation' ? { ...observation } : observation })).toThrow();
      expect(f.fetcher).toHaveBeenCalledOnce();
    });
  it.each(['blocked', 'not_evaluated', 'changed', 'unavailable'])('keeps %s preparation visible but cannot capture it', async mode => {
    const f = await fixture(); f.response.decision.state = mode === 'not_evaluated' ? mode : 'blocked';
    f.response.decision.reasons = [mode === 'not_evaluated' ? 'ELIGIBILITY_NOT_EVALUATED' : mode === 'changed' ? 'PREDECESSOR_CHANGED' : mode === 'unavailable' ? 'TARGET_UNAVAILABLE' : 'SERVICE_UNAVAILABLE'];
    if (mode === 'changed') f.response.target = { state: 'changed', latestReference: { id: 'policy_a', version: 1, recordHash: hash }, record: null, historicalDocuments: [] };
    if (mode === 'unavailable') f.response.target.state = 'unavailable';
    await f.prepare(); expect(f.client.getSnapshot().state).toBe(mode === 'not_evaluated' ? mode : 'blocked'); expect(() => f.capture()).toThrow();
  });
  it('retires captured closures when an explicit new preparation starts, even if the next material is identical', async () => {
    const f = await fixture(); await f.prepare(); const old = f.capture(), verifier = f.client.verifier, ticket = f.client.issue(f.selection);
    expect(() => old.assertCurrent()).toThrow(); expect(() => f.capture()).toThrow(); await f.client.prepare(ticket);
    expect(f.client.verifier).toBe(verifier); expect(() => old.assertCurrent()).toThrow(); expect(() => f.capture().assertCurrent()).not.toThrow();
  });
  it('retires old readiness even when an explicitly selected replacement is invalid', async () => {
    const f = await fixture(); await f.prepare(); const old = f.capture();
    expect(() => f.client.issue({ ...f.selection, targetId: 'invalid/id' })).toThrow();
    expect(() => old.assertCurrent()).toThrow(); expect(() => f.capture()).toThrow(); expect(f.client.getSnapshot().preparation).toBeNull();
    expect(f.fetcher).toHaveBeenCalledOnce();
  });
  it.each(['hide', 'close', 'scope', 'session', 'epoch', 'adapter', 'api-base', 'context', 'invalidate', 'rollback'])(
    '%s during an abort-ignoring token wait prevents fetch and late installation', async mode => {
      const f = await fixture(), token = deferred<string>(); f.getToken.mockReturnValueOnce(token.promise); const pending = f.prepare().catch(e => e);
      expect(f.getToken).toHaveBeenCalledOnce();
      if (mode === 'hide') f.lifetime.hide(); if (mode === 'close') f.client.close(); if (mode === 'scope') f.current.value = null;
      if (mode === 'session') f.current.value = { ...f.bootstrap, sessionId: 'other' }; if (mode === 'epoch') f.current.value = { ...f.bootstrap, organizationEpoch: 3 };
      if (mode === 'adapter') f.adapters.getToken = vi.fn(async () => 'other_token');
      if (mode === 'api-base') vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', 'https://other.test'); if (mode === 'context') await f.refresh();
      if (mode === 'invalidate') f.client.invalidate(); if (mode === 'rollback') f.time.mono -= 1;
      token.resolve('late_token'); expect(await pending).toBeInstanceOf(Error); expect(f.fetcher).not.toHaveBeenCalled();
      expect(f.client.getSnapshot().preparation).toBeNull(); expect(() => f.capture()).toThrow();
    });
  it.each(['token', 'response', 'body'])('bounds a stalled %s to the whole ten-second budget', async phase => {
    const f = await fixture(), token = deferred<string>(), response = deferred<Response>(), cancel = vi.fn(); vi.useFakeTimers();
    if (phase === 'token') f.getToken.mockReturnValueOnce(token.promise);
    if (phase === 'response') f.fetcher.mockReturnValueOnce(response.promise);
    if (phase === 'body') f.fetcher.mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { headers }));
    const pending = f.prepare().catch(e => e); await vi.advanceTimersByTimeAsync(10000); expect(await pending).toBeInstanceOf(Error);
    token.resolve('late_token'); response.resolve(new Response(new ReadableStream({ cancel }), { headers })); await Promise.resolve(); await Promise.resolve();
    expect(f.client.getSnapshot().preparation).toBeNull(); if (phase === 'token') expect(f.fetcher).not.toHaveBeenCalled(); else expect(cancel).toHaveBeenCalledOnce();
  });
  it.each([401, 403])('latches %s before reading the body and across recreation', async status => {
    const f = await fixture(), cancel = vi.fn(); f.fetcher.mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { status, headers }));
    await expect(f.prepare()).rejects.toMatchObject({ code: 'scope' }); expect(cancel).toHaveBeenCalledOnce(); expect(() => f.lifetime.activate(f.bootstrap)).toThrow();
    const next = createFinancialPolicyPreparationClient({ ...f.adapters }); cleanup.push(() => next.close()); expect(() => next.issue(f.selection)).toThrow();
  });
  it.each(['duplicate', 'utf8', 'overflow', 'length', 'oversized-length', 'media', 'cache', 'cache-alias', 'redirect', 'url', 'private', 'membership', 'selection', 'status', 'server-error'])(
    'rejects %s output without a usable preparation or provider diagnostic', async mode => {
      const f = await fixture(); let response: Response;
      if (mode === 'duplicate') response = new Response('{"a":1,"\\u0061":2}', { headers });
      else if (mode === 'utf8') response = new Response(new Uint8Array([0xf0, 0x9f]), { headers });
      else if (mode === 'overflow') response = new Response(' '.repeat(2 * 1024 * 1024 + 1), { headers });
      else if (['length', 'oversized-length', 'media', 'cache', 'cache-alias'].includes(mode)) response = new Response(JSON.stringify(f.response), { headers: {
        ...headers, ...(mode === 'length' ? { 'Content-Length': '+12' } : mode === 'oversized-length' ? { 'Content-Length': String(FINANCIAL_POLICY_PREPARATION_RESPONSE_MAX_BYTES + 1) } : mode === 'media' ? { 'Content-Type': 'text/html' }
          : { 'Cache-Control': mode === 'cache' ? 'no-store=true' : 'x-no-store' }) } });
      else if (mode === 'server-error') response = json({ error: { code: 'SETUP_REQUIRED', message: 'private provider diagnostics' } }, 503);
      else {
        const raw = structuredClone(f.response); if (mode === 'private') raw.subject = 'private'; if (mode === 'membership') raw.scope.actor.membershipVersion++;
        if (mode === 'selection') raw.selection.targetId = 'other'; response = json(raw, mode === 'status' ? 201 : 200);
        if (mode === 'redirect') Object.defineProperty(response, 'redirected', { value: true }); if (mode === 'url') Object.defineProperty(response, 'url', { value: 'https://other.test/private' });
      }
      f.fetcher.mockResolvedValueOnce(response); const result = await f.prepare().catch(e => e); expect(result).toBeInstanceOf(Error); expect(result.message).not.toContain('private');
      expect(f.client.getSnapshot().preparation).toBeNull(); expect(() => f.capture()).toThrow(); expect(f.fetcher).toHaveBeenCalledOnce();
    });
  it('rejects oversized selectors before token calls and never writes command bodies', async () => {
    const f = await fixture(); expect(() => f.client.issue({ ...f.selection, text: 'x'.repeat(8193) })).toThrow();
    expect(f.getToken).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('requires an explicit current GET refresh for a newer correctly hashed preparation basis', async () => {
    const f = await fixture('draft'), raw = structuredClone(f.response); raw.material.draftScope.authority.generation++;
    raw.material.draftScope.authorityHash = await commandDigest({ namespace: 'pactwoven:financial-authority-fence:v1', record: { ...raw.material.draftScope.authority,
      environment: 'development', organizationId: 'org_a' } }); f.fetcher.mockResolvedValueOnce(json(raw));
    await expect(f.prepare()).rejects.toMatchObject({ code: 'expired' }); expect(f.client.getSnapshot().preparation).toBeNull(); expect(f.readFetch).toHaveBeenCalledOnce();
  });
  it('applies the stricter response deadline to asynchronous text hashing before publication', async () => {
    const f = await fixture('draft'), delayed = deferred<ArrayBuffer>(), realDigest = crypto.subtle.digest.bind(crypto.subtle); let stalled = false;
    f.response.observation = { observedAt: iso(at - 1000), expiresAt: iso(at + 500) };
    vi.spyOn(crypto.subtle, 'digest').mockImplementation((algorithm, data) => {
      if (new TextDecoder().decode(data as ArrayBuffer).includes('financial-policy-text:v1')) { stalled = true; return delayed.promise; } return realDigest(algorithm, data);
    });
    const pending = f.prepare().catch(e => e); await vi.waitFor(() => expect(stalled).toBe(true)); f.time.mono += 500;
    delayed.resolve(Uint8Array.from(Buffer.from(f.response.material.document.record.contentHash, 'hex')).buffer);
    expect(await pending).toMatchObject({ code: 'expired' }); expect(f.client.getSnapshot().preparation).toBeNull();
  });
  it('aborts a non-cooperative hash at the shorter parsed response deadline', async () => {
    const f = await fixture('draft'), delayed = deferred<ArrayBuffer>(), realDigest = crypto.subtle.digest.bind(crypto.subtle); let stalled = false;
    f.response.observation = { observedAt: iso(at - 1000), expiresAt: iso(at + 500) };
    vi.spyOn(crypto.subtle, 'digest').mockImplementation((algorithm, data) => {
      if (new TextDecoder().decode(data as ArrayBuffer).includes('financial-policy-text:v1')) { stalled = true; return delayed.promise; } return realDigest(algorithm, data);
    });
    vi.useFakeTimers(); const pending = f.prepare().catch(e => e); await vi.waitFor(() => expect(stalled).toBe(true));
    await vi.advanceTimersByTimeAsync(500); expect(await pending).toMatchObject({ code: 'expired' });
    delayed.resolve(Uint8Array.from(Buffer.from(f.response.material.document.record.contentHash, 'hex')).buffer); await Promise.resolve();
    expect(f.client.getSnapshot().preparation).toBeNull(); expect(() => f.capture()).toThrow();
  });
  it('bounds token waiting by an earlier current GET observation expiry', async () => {
    const f = await fixture(), token = deferred<string>(); f.context.observation = { observedAt: iso(at - 1000), expiresAt: iso(at + 250) }; await f.refresh();
    f.getToken.mockReturnValueOnce(token.promise); vi.useFakeTimers(); const pending = f.prepare().catch(e => e);
    await vi.advanceTimersByTimeAsync(250); expect(await pending).toMatchObject({ code: 'expired' });
    token.resolve('late_token'); await Promise.resolve(); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('streams full maximum Unicode document text over split UTF-8 boundaries', async () => {
    const f = await fixture('draft'), text = '🧵'.repeat(20000); f.response.material.document.record.text = text;
    f.response.material.document.record.contentHash = await commandDigest({ namespace: 'pactwoven:financial-policy-text:v1', text });
    const bytes = new TextEncoder().encode(JSON.stringify(f.response));
    f.fetcher.mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) {
      for (let i = 0; i < bytes.length; i += 197) controller.enqueue(bytes.slice(i, i + 197)); controller.close();
    } }), { headers }));
    const result = await f.prepare(); if (result.response.material.action !== 'save_draft') throw Error('fixture');
    expect(result.response.material.document?.record.text).toBe(text); expect(f.capture().expiresAt).toBe(at + 19000);
  });
  it('expires installed closures by clock checks before timers and never renews them on capture', async () => {
    const f = await fixture(); f.response.observation = { observedAt: iso(at - 1000), expiresAt: iso(at + 1000) }; await f.prepare();
    const assertion = f.capture(); expect(assertion.expiresAt).toBe(at + 1000); f.time.wall -= 10000; f.time.mono += 1000;
    expect(() => assertion.assertCurrent()).toThrow(); expect(f.client.getSnapshot()).toEqual({ state: 'expired', preparation: null });
    expect(f.fetcher).toHaveBeenCalledOnce();
  });
  it('does not return a stale value when a subscriber invalidates at publication', async () => {
    const f = await fixture(); f.client.subscribe(() => { if (f.client.getSnapshot().state === 'reviewable') f.client.invalidate(); });
    await expect(f.prepare()).rejects.toBeDefined(); expect(f.client.getSnapshot().preparation).toBeNull(); expect(() => f.capture()).toThrow();
  });
  it('clears its installed value if publication consumes the remaining whole-request budget', async () => {
    const f = await fixture(); f.client.subscribe(() => { if (f.client.getSnapshot().state === 'reviewable') f.time.mono += 11000; });
    await expect(f.prepare()).rejects.toMatchObject({ code: 'unavailable' });
    expect(f.client.getSnapshot()).toEqual({ state: 'unavailable', preparation: null }); expect(() => f.capture()).toThrow();
  });
  it('bounds hash work that ignores abort and discards its late completion', async () => {
    const f = await fixture('draft'), delayed = deferred<ArrayBuffer>(); vi.spyOn(crypto.subtle, 'digest').mockReturnValueOnce(delayed.promise);
    const pending = f.prepare().catch(e => e); await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledOnce()); f.lifetime.hide();
    expect(await pending).toBeInstanceOf(Error); delayed.resolve(new ArrayBuffer(32)); await Promise.resolve(); expect(f.client.getSnapshot().preparation).toBeNull();
  });
});
