import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commandDigest } from '@pactwoven/contracts/canonical';
import { FinancialPolicyHttpScopeSchema, financialPolicyHttpRoute, type FinancialPolicyHttpReceipt } from '@pactwoven/contracts';
import { createFinancialPolicyAttempt, financialSame, type FinancialPolicyAttempt, type FinancialPolicyReference } from './financial-policy-contract';
import { createFinancialPolicyLifetime, FinancialPolicyBootstrapSchema, financialPolicyLocalScope, type FinancialPolicyBootstrap } from './financial-policy-context';
import { createFinancialPolicyMemory, clearFinancialPolicyReminder, financialPolicyReferenceKey, storeFinancialPolicyReference,
  type FinancialPolicyStorage } from './financial-policy-recovery';
import { createFinancialPolicyTransport } from './financial-policy-transport';
import { createFinancialPolicyAttemptCoordinator, type FinancialPolicyAttemptCoordinatorAdapters, type FinancialPolicyPreparationVerifier } from './financial-policy-attempt-coordinator';
import { parseFinancialPolicyWriteRequest, type FinancialPolicyWriteRequest } from './financial-policy-write-transport';

const at = Date.parse('2026-11-15T00:00:00.000Z'), iso = (n: number) => new Date(n).toISOString(), base = 'https://api.example.test';
const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' }, hash = 'a'.repeat(64);
const json = (value: unknown, status = 200) => Response.json(value, { headers, status });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
async function fixture(responsibility = false, withPreparation = true) {
  const responsibilityId = responsibility ? 'responsibility_a' : null;
  const bootstrap = FinancialPolicyBootstrapSchema.parse({ environment: 'development', organizationId: 'org_a', actorId: 'owner_a', apiBase: base,
    responsibilityId, userId: 'user_a', externalOrganizationId: 'provider_org', sessionId: 'session_a', organizationEpoch: 2,
    roles: ['owner'], siteIds: ['site_a'], actionSiteIds: ['site_a'], responsibility: responsibility ? { id: responsibilityId, version: 1, siteId: 'site_a' } : null });
  const scope = FinancialPolicyHttpScopeSchema.parse({ environment: 'development', organizationId: 'org_a', actor: { actorId: 'owner_a', membershipVersion: 5 },
    organizationEpoch: 2, roles: ['owner'], siteIds: ['site_a'], actionSiteIds: ['site_a'] });
  const authority = { schemaVersion: 1, responsibility: { id: 'responsibility_a', version: 1, hash, siteId: 'site_a' }, generation: 0, family: 'none', legacyHead: null };
  const draftScope = { authority, authorityHash: await commandDigest({ namespace: 'pactwoven:financial-authority-fence:v1', record: {
    ...authority, environment: 'development', organizationId: 'org_a' } }), site: { id: 'site_a', generation: 0, recordHash: hash } };
  const envelope = { schemaVersion: 1, scope, observation: { observedAt: iso(at - 1000), expiresAt: iso(at + 19000) }, effectiveAuthority: false, financialState: null };
  const context = { ...envelope, kind: responsibility ? 'responsibility' : 'organization', responsibilityId, configurationVisibility: 'full', draftScope: responsibility ? draftScope : null,
    asset: null, control: null, acceptedConfiguration: null, periods: [], documents: [], actions: [],
    blockers: ['ASSET_MISSING', 'FINANCIAL_AUTHORITY_UNAVAILABLE', 'GOVERNANCE_MISSING', 'TRUST_UNAVAILABLE'] };
  const time = { wall: at, mono: 100 }, clocks = { wall: () => time.wall, monotonic: () => time.mono };
  const current = { value: bootstrap as FinancialPolicyBootstrap | null }, lifetime = createFinancialPolicyLifetime(bootstrap, clocks);
  const memory = createFinancialPolicyMemory(financialPolicyLocalScope(bootstrap)), values = new Map<string, string>();
  const storage: FinancialPolicyStorage = { get length() { return values.size; }, key: i => [...values.keys()][i] ?? null,
    getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); } };
  const storageHolder = { value: storage as FinancialPolicyStorage | null };
  const readFetch = vi.fn(async () => json(context)), readToken = vi.fn(async () => 'read_token');
  const read = createFinancialPolicyTransport({ lifetime, memory, storage: () => storageHolder.value, currentBootstrap: () => current.value,
    getToken: readToken, fetch: readFetch, ...clocks });
  const query = { assetKey: null };
  const open = () => read.context(query, lifetime.authorize('context', query)); await open();
  const policy = { allowed: true, expiresAt: at + 19000, originalOptionalMaterial: false };
  const capture = vi.fn<FinancialPolicyPreparationVerifier['capture']>(review => {
    if (!policy.allowed || policy.originalOptionalMaterial) throw Error('Synthetic blocked preparation');
    const exactRequest = review.request, exactObservation = review.observation;
    return { expiresAt: policy.expiresAt, now: () => Math.max(time.wall, at + time.mono - 100), assertCurrent() {
      if (!policy.allowed || policy.originalOptionalMaterial || review.request !== exactRequest || lifetime.observation() !== exactObservation)
        throw Error('Synthetic preparation no longer current');
    } };
  });
  const make = (id = 'policy_a', key = 'original_policy_001') => parseFinancialPolicyWriteRequest({ kind: 'save_document', responsibilityId,
    id, key, route: financialPolicyHttpRoute({ kind: 'save_document', responsibilityId, id }),
    input: { schemaVersion: 1, previous: null, organizationEpoch: 2, purpose: responsibility ? 'financial_mandate' : 'budget_policy', text: 'Exact full policy. Café 🧵' } });
  const draft = (id = 'draft_a', key = 'original_draft_001') => parseFinancialPolicyWriteRequest({ kind: 'save_draft', responsibilityId: 'responsibility_a', id, key,
    route: `/v1/responsibilities/responsibility_a/financial-policies/${id}`, input: { schemaVersion: 1, previous: null, organizationEpoch: 2,
      draft: { scope: draftScope, terms: { mode: 'PREPARE_FOR_APPROVAL', actions: ['allocate_funds'], category: 'supplier_principal', allocation: 'responsibility_earmark',
        supplier: null, acceptedTerms: null, payee: null, tool: null, withdrawal: null, branch: null,
        communication: { recipients: [], purposes: [], kinds: [], allowanceBaseUnits: '0' } }, documents: [{ id: 'mandate_doc', version: 1, recordHash: hash, purpose: 'financial_mandate' }],
        asset: null, account: null, governance: null, trust: null, startsAt: iso(at), expiresAt: iso(at + 86400000) } } });
  async function receipt(attempt: FinancialPolicyAttempt): Promise<FinancialPolicyHttpReceipt> {
    const request = attempt.request, actor = { actorId: 'owner_a', membershipVersion: 1 }, operationId = '00000000-0000-0000-0000-000000000001';
    if (request.kind !== 'save_document' && request.kind !== 'save_draft') throw Error('unsupported synthetic writer');
    const common = { schemaVersion: 1 as const, environment: 'development' as const, organizationId: 'org_a', actor, responsibilityId: request.responsibilityId,
      id: request.id, version: (request.input.previous?.version ?? 0) + 1, predecessor: request.input.previous, organizationEpoch: 2, operationId, createdAt: iso(at) };
    const record = request.kind === 'save_document' ? { ...common, kind: 'document' as const, purpose: request.input.purpose, text: request.input.text,
      contentHash: await commandDigest({ namespace: 'pactwoven:financial-policy-text:v1', text: request.input.text }) }
      : { ...common, kind: 'draft' as const, responsibilityId: 'responsibility_a', state: 'DRAFT' as const, requester: actor, draft: request.input.draft };
    return { schemaVersion: 1, environment: 'development', organizationId: 'org_a', actor, responsibilityId: request.responsibilityId,
      operationId, kind: request.kind, key: request.key, publicRequestHash: attempt.reference.locator.publicRequestHash,
      target: { id: request.id, version: record.version, recordHash: hash }, record, effectiveAuthority: false, financialState: null };
  }
  const received: FinancialPolicyAttempt[] = [], receipts: FinancialPolicyHttpReceipt[] = [];
  const fetcher = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async (url, init) => {
    const input = JSON.parse(String(init.body)), id = url.split('/').at(-1)!, kind = url.includes('/financial-policies/') ? 'save_draft' : 'save_document';
    const request = parseFinancialPolicyWriteRequest({ kind, responsibilityId, id, key: new Headers(init.headers).get('Idempotency-Key'), route: url.slice(base.length), input });
    const original = await createFinancialPolicyAttempt(financialPolicyLocalScope(bootstrap), request), result = await receipt(original);
    received.push(original); receipts.push(result); return json({ ...envelope, status: 'recorded', receipt: result });
  });
  const getToken = vi.fn(async () => 'write_token');
  const adapters: FinancialPolicyAttemptCoordinatorAdapters = { lifetime, memory, storage: () => storageHolder.value, currentBootstrap: () => current.value,
    getToken, fetch: fetcher, preparation: withPreparation ? { capture } : null, ...clocks };
  const coordinator = createFinancialPolicyAttemptCoordinator(adapters), send = (request: FinancialPolicyWriteRequest = make()) => coordinator.send(coordinator.review(request));
  return { bootstrap, scope, envelope, context, draftScope, time, current, lifetime, memory, values, storage, storageHolder, read, readFetch, readToken, open,
    policy, capture, make, draft, receipt, received, receipts, fetcher, getToken, adapters, coordinator, send };
}
const noNetwork = vi.fn(() => { throw Error('Unexpected real network'); });
beforeEach(() => { vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', base); noNetwork.mockClear(); vi.stubGlobal('fetch', noNetwork); });
afterEach(() => { expect(noNetwork).not.toHaveBeenCalled(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('financial policy attempt coordination', () => {
  it('defaults unavailable despite an owner role and empty read actions; fake/read gestures never send', async () => {
    const f = await fixture(false, false);
    expect(f.context.actions).toEqual([]); expect(() => f.coordinator.review(f.make())).toThrow();
    await expect(f.coordinator.send({} as never)).rejects.toMatchObject({ outcome: 'not-dispatched' });
    await expect(f.coordinator.send(f.lifetime.authorize('read', {}) as never)).rejects.toMatchObject({ outcome: 'not-dispatched' });
    expect(f.getToken).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled(); expect(f.values.size).toBe(0);
  });
  it.each(['boolean', 'missing-assertion', 'missing-clock', 'invalid-clock', 'negative-clock', 'expired', 'unbounded', 'throws'])(
    'rejects a %s preparation port result before any write-side I/O', async mode => {
      const f = await fixture();
      if (mode === 'boolean') f.capture.mockReturnValueOnce(true as never);
      if (mode === 'missing-assertion') f.capture.mockReturnValueOnce({ expiresAt: at + 1000 } as never);
      if (mode === 'missing-clock') f.capture.mockReturnValueOnce({ expiresAt: at + 19000, assertCurrent() {} } as never);
      if (mode === 'invalid-clock' || mode === 'negative-clock') f.capture.mockReturnValueOnce({ expiresAt: at + 19000, assertCurrent() {}, now: () => mode === 'invalid-clock' ? NaN : -1 });
      if (mode === 'expired') f.policy.expiresAt = at;
      if (mode === 'unbounded') f.policy.expiresAt = at + 20001;
      if (mode === 'throws') f.capture.mockImplementationOnce(() => { throw Error('private preparation source'); });
      let error: Error | null = null; try { f.coordinator.review(f.make()); } catch (value) { error = value as Error; }
      expect(error).toMatchObject({ code: 'unavailable' }); expect(error?.message).not.toContain('private preparation');
      expect(f.getToken).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled(); expect(f.values.size).toBe(0);
    });
  it.each(['route', 'epoch', 'purpose', 'text', 'scope'])(
    'rejects invalid %s review without provider work or normalization', async mode => {
      const f = await fixture(), request = structuredClone(f.make());
      if (mode === 'route') request.route += '/';
      if (mode === 'epoch') request.input.organizationEpoch += 1;
      if (mode === 'scope') request.responsibilityId = 'other_responsibility';
      if (request.kind === 'save_document') {
        if (mode === 'purpose') request.input.purpose = 'financial_mandate';
        if (mode === 'text') request.input.text = 'Unpaired \ud800';
      }
      const before = structuredClone(request); expect(() => f.coordinator.review(request)).toThrow(); expect(request).toEqual(before);
      expect(f.getToken).not.toHaveBeenCalled(); expect(f.values.size).toBe(0);
    });
  it('uses one reviewed identity, stores only its locator and never automatically clears or chains a write', async () => {
    const f = await fixture(), request = f.make(), gesture = f.coordinator.review(request), pending = f.coordinator.send(gesture);
    expect(() => f.coordinator.review(f.make('other', 'other_policy_001'))).toThrow();
    const result = await pending; expect(f.fetcher).toHaveBeenCalledOnce(); expect(f.values.size).toBe(1);
    const stored = [...f.values.values()][0]!;
    expect(stored).not.toContain('Exact full policy'); expect(stored).not.toContain('write_token'); expect(JSON.parse(stored)).toEqual(result.reference);
    expect(f.memory.original(result.reference)?.request).toEqual(request); expect(f.memory.recorded(result.reference)).toEqual(result.receipt);
    expect(f.coordinator.status()).toEqual({ state: 'recorded', reference: result.reference });
    await expect(f.coordinator.send(gesture)).rejects.toMatchObject({ outcome: 'not-dispatched' }); expect(f.fetcher).toHaveBeenCalledOnce();
    expect(() => f.coordinator.review(request)).toThrow(); expect(f.values.size).toBe(1);
  });
  it.each(['context', 'preparation', 'draft'] as const)('requires more than eleven seconds before storing against the earliest %s deadline', async earliest => {
    const f = await fixture(true), request = structuredClone(earliest === 'draft' ? f.draft() : f.make());
    if (earliest === 'context') { f.time.wall -= 1000; f.time.mono += 8000; }
    if (earliest === 'preparation') f.policy.expiresAt = at + 11000;
    if (request.kind === 'save_draft') request.input.draft.expiresAt = iso(at + 11000);
    const store = vi.spyOn(f.storage, 'setItem');
    await expect(f.send(request)).rejects.toMatchObject({ code: 'unavailable', outcome: 'not-dispatched', reason: 'refresh-checks' });
    expect(store).not.toHaveBeenCalled(); expect(f.values.size).toBe(0); expect(f.getToken).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.coordinator.status().reference).toBeNull();
  });
  it('stores and sends with eleven seconds plus one millisecond remaining', async () => {
    const f = await fixture(); f.time.mono += 7999;
    const result = await f.send(); expect(f.values.size).toBe(1); expect(f.fetcher).toHaveBeenCalledOnce(); expect(result.receipt.kind).toBe('save_document');
  });
  it.each(['attempt', 'retention'] as const)('rechecks the admission margin after slow %s hashing and creates no stored original', async phase => {
    const f = await fixture(), request = f.make(), expected = await createFinancialPolicyAttempt(financialPolicyLocalScope(f.bootstrap), request);
    const entered = deferred<void>(), release = deferred<void>(), digest = crypto.subtle.digest.bind(crypto.subtle); let requestHashes = 0;
    vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (algorithm, data) => {
      if (new TextDecoder().decode(data as ArrayBuffer).includes('financial-policy-http-request:v1') && ++requestHashes === (phase === 'attempt' ? 1 : 2)) {
        entered.resolve(); await release.promise;
      }
      return digest(algorithm, data);
    });
    const store = vi.spyOn(f.storage, 'setItem'), pending = f.send(request).catch(error => error); await entered.promise;
    f.time.mono += 8000; f.time.wall -= 1000; release.resolve();
    expect(await pending).toMatchObject({ code: 'unavailable', outcome: 'not-dispatched', reason: 'refresh-checks' });
    expect(store).not.toHaveBeenCalled(); expect(f.values.size).toBe(0); expect(f.getToken).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.memory.original(expected.reference)).toBeNull(); expect(f.coordinator.status().reference).toBeNull();
    expect(() => f.coordinator.continueUnsent(expected.reference)).toThrow();
  });
  it.each(['identity', 'non-finite', 'negative'] as const)('rejects a %s preparation clock change during hashing before storing', async failure => {
    const f = await fixture(), capture = f.capture.getMockImplementation()!, reading = { now: at };
    const asserted = { ...capture({ request: f.make(), bootstrap: f.bootstrap, observation: f.lifetime.observation() }), now: () => reading.now };
    f.capture.mockReturnValueOnce(asserted);
    const entered = deferred<void>(), release = deferred<void>(), digest = crypto.subtle.digest.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (algorithm, bytes) => { entered.resolve(); await release.promise; return digest(algorithm, bytes); });
    const pending = f.send().catch(error => error); await entered.promise;
    if (failure === 'identity') asserted.now = () => at;
    else reading.now = failure === 'negative' ? -1 : NaN;
    release.resolve(); expect(await pending).toMatchObject({ outcome: 'not-dispatched', code: 'expired' });
    expect(f.values.size).toBe(0); expect(f.getToken).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('requires a separate gesture for an incomplete draft after saving text and permits configuration warnings', async () => {
    const f = await fixture(true); await f.send(); expect(f.fetcher).toHaveBeenCalledOnce();
    const result = await f.send(f.draft()); expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(result.receipt).toMatchObject({ kind: 'save_draft', effectiveAuthority: false, financialState: null });
    expect(f.values.size).toBe(2); expect(f.received[1]?.request).toEqual(f.draft());
  });
  it.each(['asset', 'account', 'governance', 'trust'])('rejects non-null draft %s without rewriting it', async field => {
    const f = await fixture(true), request = structuredClone(f.draft()); if (request.kind !== 'save_draft') throw Error('fixture');
    Object.assign(request.input.draft, { [field]: { key: hash, version: 1, recordHash: hash, financialUseEpoch: 0 } });
    const copy = structuredClone(request); expect(() => f.coordinator.review(request)).toThrow(); expect(request).toEqual(copy);
    expect(f.getToken).not.toHaveBeenCalled(); expect(f.values.size).toBe(0);
  });
  it('leaves revision with unsupported inherited optional material unavailable even with a null new body', async () => {
    const f = await fixture(true); f.policy.originalOptionalMaterial = true; const request = f.draft();
    expect(() => f.coordinator.review(request)).toThrow(); expect(f.fetcher).not.toHaveBeenCalled(); expect(f.values.size).toBe(0);
  });
  it('accepts a synthetic explicit revision decision without inferring permission from old projected expiry', async () => {
    const f = await fixture(true), request = structuredClone(f.draft()); request.input.previous = { id: 'draft_a', version: 4, recordHash: hash };
    const result = await f.send(request); expect(result.receipt.target.version).toBe(5); expect(result.receipt.record.predecessor).toEqual(request.input.previous);
    expect(f.capture).toHaveBeenCalled(); // The port supplies the decision; no projection field is a client permission.
  });
  it('snapshots before hashing and blocks duplicate gestures during digest work', async () => {
    const f = await fixture(), request = structuredClone(f.make()), token = deferred<string>(); f.getToken.mockReturnValueOnce(token.promise);
    const gesture = f.coordinator.review(request), pending = f.coordinator.send(gesture);
    if (request.kind === 'save_document') request.input.text = 'After review'; request.key = 'changed_key';
    expect(() => f.coordinator.review(f.make())).toThrow();
    await vi.waitFor(() => expect(f.getToken).toHaveBeenCalledOnce()); token.resolve('write_token'); const result = await pending;
    expect(f.received[0]?.request).toEqual(f.make()); expect(result.reference.locator.key).toBe('original_policy_001');
  });
  it('retains an exact unsent original after token failure and permits one explicit same-identity continuation', async () => {
    const f = await fixture(); f.getToken.mockRejectedValueOnce(Error('private token provider failure'));
    const error = await f.send().catch(e => e); expect(error).toMatchObject({ outcome: 'not-dispatched' }); expect(error.message).not.toContain('private token');
    const status = f.coordinator.status(); expect(status.state).toBe('unsent'); const reference = status.reference!;
    expect(f.fetcher).not.toHaveBeenCalled(); const bytes = [...f.values];
    const continuation = f.coordinator.continueUnsent(reference); const result = await f.coordinator.send(continuation);
    expect(result.reference).toEqual(reference); expect([...f.values]).toEqual(bytes); expect(f.fetcher).toHaveBeenCalledOnce();
    expect(() => f.coordinator.continueUnsent(reference)).toThrow(); expect(() => f.coordinator.review(f.make('other', 'original_policy_001'))).toThrow();
  });
  it('continues a stored original below the new-save margin without rewriting its locator', async () => {
    const f = await fixture(); f.getToken.mockRejectedValueOnce(Error('token unavailable')); await f.send().catch(() => {});
    const reference = f.coordinator.status().reference!, originals = [...f.values], store = vi.spyOn(f.storage, 'setItem');
    f.time.mono += 10000;
    const result = await f.coordinator.send(f.coordinator.continueUnsent(reference));
    expect(result.reference).toEqual(reference); expect([...f.values]).toEqual(originals); expect(store).not.toHaveBeenCalled(); expect(f.fetcher).toHaveBeenCalledOnce();
  });
  it('cannot infer unsent history from a reference-only reload or delete a not-recorded reminder', async () => {
    const f = await fixture(); f.getToken.mockRejectedValueOnce(Error('unavailable')); await f.send().catch(() => {});
    const reference = f.coordinator.status().reference!, before = [...f.values]; f.coordinator.close();
    const next = createFinancialPolicyAttemptCoordinator({ ...f.adapters });
    expect(() => next.continueUnsent(reference)).toThrow(); expect(() => next.review(f.make())).toThrow();
    f.readFetch.mockResolvedValueOnce(json({ ...f.envelope, ...reference.locator, status: 'not_recorded', receipt: null, closure: null }));
    const recovered = await f.read.lookup(next.recoveryReference(reference), f.lifetime.authorize('lookup', reference));
    expect(recovered.status).toBe('not_recorded'); expect([...f.values]).toEqual(before); expect(f.fetcher).not.toHaveBeenCalled();
    expect(() => next.review(f.make())).toThrow();
  });
  it('preserves a locator whose set succeeded but readback failed; continuation still needs exact bytes', async () => {
    const f = await fixture(), original = f.storage.getItem; let deny = false;
    f.storage.setItem = (key, value) => { f.values.set(key, value); deny = true; };
    f.storage.getItem = key => { if (deny) throw Error('readback denied'); return original(key); };
    await expect(f.send()).rejects.toMatchObject({ outcome: 'not-dispatched', code: 'storage' }); expect(f.values.size).toBe(1); expect(f.fetcher).not.toHaveBeenCalled();
    deny = false; const reference = f.coordinator.status().reference!;
    expect(f.coordinator.continueUnsent(reference)).toBeDefined(); expect(f.values.size).toBe(1);
  });
  it.each(['denied', 'malformed', 'oversized', 'capacity', 'duplicate-enumeration', 'unstable', 'too-many-keys'])(
    '%s storage blocks before token or write and preserves existing entries', async mode => {
      const f = await fixture(), saved = await createFinancialPolicyAttempt(financialPolicyLocalScope(f.bootstrap), f.make('other', 'other_policy_001'));
      if (mode === 'denied') f.storageHolder.value = null;
      if (mode === 'malformed') f.values.set('pactwoven:financial-policy-original:v1:bad', '{');
      if (mode === 'oversized') f.values.set('pactwoven:financial-policy-original:v1:bad', ' '.repeat(8193));
      if (mode === 'capacity') for (let i = 0; i < 24; i++) {
        const copy: FinancialPolicyReference = structuredClone(saved.reference); copy.locator.key = `other_policy_${String(i).padStart(3, '0')}`; copy.locator.targetId = `other_${i}`;
        storeFinancialPolicyReference(f.storage, copy);
      }
      if (mode === 'duplicate-enumeration') { f.values.set('unrelated1', ''); f.values.set('unrelated2', ''); f.storage.key = () => 'unrelated1'; }
      if (mode === 'unstable') { storeFinancialPolicyReference(f.storage, saved.reference); let count = 0; const key = financialPolicyReferenceKey(saved.reference);
        f.storage.getItem = name => { if (++count === 2) f.values.set(key, '{}'); return f.values.get(name) ?? null; }; }
      if (mode === 'too-many-keys') for (let i = 0; i < 4097; i++) f.values.set(`unrelated${i}`, '');
      const before = [...f.values];
      try { await f.send(); throw Error('unexpected success'); } catch (error) { expect(error).toBeInstanceOf(Error); }
      expect(f.fetcher).not.toHaveBeenCalled(); expect(f.getToken).not.toHaveBeenCalled();
      if (mode !== 'unstable') expect([...f.values]).toEqual(before);
    });
  it.each(['kind', 'actor', 'responsibility', 'api-base', 'operation-key'])(
    'blocks %s collision across the broader SQL namespace without disclosing the foreign reference', async mode => {
      const f = await fixture(), saved = await createFinancialPolicyAttempt(financialPolicyLocalScope(f.bootstrap), f.make());
      const reference = structuredClone(saved.reference);
      if (mode === 'kind') { reference.locator.kind = 'save_draft'; reference.locator.responsibilityId = 'other_responsibility'; reference.scope.responsibilityId = 'other_responsibility'; }
      if (mode === 'actor') reference.scope.actorId = 'private_foreign_actor';
      if (mode === 'responsibility' || mode === 'operation-key') { reference.scope.responsibilityId = 'private_responsibility'; reference.locator.responsibilityId = 'private_responsibility'; }
      if (mode === 'api-base') reference.scope.apiBase = 'https://alias.example.test';
      if (mode === 'operation-key') reference.locator.targetId = 'private_other_target';
      storeFinancialPolicyReference(f.storage, reference); const before = [...f.values];
      let caught: Error | null = null; try { f.coordinator.review(f.make()); } catch (error) { caught = error as Error; }
      expect(caught).toMatchObject({ code: 'storage' }); expect(caught?.message).not.toContain('private'); expect([...f.values]).toEqual(before);
      expect(f.getToken).not.toHaveBeenCalled(); expect(f.coordinator.status().reference).toBeNull();
    });
  it('permits unrelated targets and does not treat another organization as the same record namespace', async () => {
    const f = await fixture(), saved = await createFinancialPolicyAttempt(financialPolicyLocalScope(f.bootstrap), f.make());
    const reference = structuredClone(saved.reference); reference.scope.organizationId = 'other_org'; storeFinancialPolicyReference(f.storage, reference);
    await f.send(); await f.send(f.make('another_policy', 'another_policy_001')); expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
  it('rechecks same-target conflicts and exact stored bytes after the token wait', async () => {
    const f = await fixture(), token = deferred<string>(); f.getToken.mockReturnValueOnce(token.promise);
    const pending = f.send().catch(e => e); await vi.waitFor(() => expect(f.getToken).toHaveBeenCalledOnce());
    const original = f.coordinator.status().reference!, other = structuredClone(original); other.scope.actorId = 'other_actor';
    storeFinancialPolicyReference(f.storage, other); token.resolve('write_token');
    expect(await pending).toMatchObject({ outcome: 'not-dispatched', code: 'storage' }); expect(f.fetcher).not.toHaveBeenCalled(); expect(f.values.size).toBe(2);
  });
  it('rejects changed original bytes after token acquisition without overwriting them', async () => {
    const f = await fixture(), token = deferred<string>(); f.getToken.mockReturnValueOnce(token.promise);
    const pending = f.send().catch(e => e); await vi.waitFor(() => expect(f.getToken).toHaveBeenCalledOnce());
    const reference = f.coordinator.status().reference!, key = financialPolicyReferenceKey(reference);
    const changed = f.values.get(key)! + ' '; f.values.set(key, changed); token.resolve('write_token');
    expect(await pending).toMatchObject({ outcome: 'not-dispatched', code: 'storage' }); expect(f.values.get(key)).toBe(changed); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('rechecks lifetime after the final synchronous storage scan before dispatch', async () => {
    const f = await fixture(), token = deferred<string>(); f.getToken.mockReturnValueOnce(token.promise);
    const pending = f.send().catch(e => e); await vi.waitFor(() => expect(f.getToken).toHaveBeenCalledOnce());
    const get = f.storage.getItem; let invalidated = false;
    f.storage.getItem = key => { if (!invalidated) { invalidated = true; f.coordinator.invalidateReview(); } return get(key); };
    token.resolve('write_token'); expect(await pending).toMatchObject({ outcome: 'not-dispatched' });
    expect(f.fetcher).not.toHaveBeenCalled(); expect(f.values.size).toBe(1);
  });
  it.each(['hide', 'scope', 'session', 'epoch', 'adapter', 'storage', 'edit', 'context', 'expired', 'rollback'])(
    '%s invalidates a token-waiting attempt without deleting its original', async mode => {
      const f = await fixture(), token = deferred<string>(); f.getToken.mockReturnValueOnce(token.promise);
      const pending = f.send().catch(e => e); await vi.waitFor(() => expect(f.getToken).toHaveBeenCalledOnce()); const before = [...f.values];
      if (mode === 'hide') f.lifetime.hide(); if (mode === 'scope') f.current.value = null;
      if (mode === 'session') f.current.value = { ...f.bootstrap, sessionId: 'other_session' };
      if (mode === 'epoch') f.current.value = { ...f.bootstrap, organizationEpoch: 3 };
      if (mode === 'adapter') f.adapters.getToken = vi.fn(async () => 'other_token');
      if (mode === 'storage') f.storageHolder.value = { ...f.storage };
      if (mode === 'edit') f.coordinator.invalidateReview(); if (mode === 'context') await f.open();
      if (mode === 'expired') f.time.mono += 19000; if (mode === 'rollback') f.time.mono -= 1;
      token.resolve('write_token'); expect(await pending).toMatchObject({ outcome: 'not-dispatched' });
      expect(f.fetcher).not.toHaveBeenCalled(); expect([...f.values]).toEqual(before);
      expect(f.coordinator.status().reference).toBeNull();
    });
  it('settles hiding during an abort-ignoring digest and prevents late memory/storage work', async () => {
    const f = await fixture(), digest = deferred<ArrayBuffer>(), spy = vi.spyOn(crypto.subtle, 'digest').mockReturnValueOnce(digest.promise);
    const pending = f.send().catch(e => e); expect(spy).toHaveBeenCalledOnce(); f.lifetime.hide();
    expect(await pending).toMatchObject({ outcome: 'not-dispatched' }); digest.resolve(new ArrayBuffer(32)); await Promise.resolve();
    expect(f.values.size).toBe(0); expect(f.getToken).not.toHaveBeenCalled(); expect(f.coordinator.status().reference).toBeNull();
  });
  it('bounds memory retention hashing and invalidates its late commit before any locator exists', async () => {
    const f = await fixture(), expected = await createFinancialPolicyAttempt(financialPolicyLocalScope(f.bootstrap), f.make());
    const digest = deferred<ArrayBuffer>(), realDigest = crypto.subtle.digest.bind(crypto.subtle); let requestHashes = 0, stalled = false;
    vi.spyOn(crypto.subtle, 'digest').mockImplementation((algorithm, data) => {
      if (new TextDecoder().decode(data as ArrayBuffer).includes('financial-policy-http-request:v1') && ++requestHashes === 2) {
        stalled = true; return digest.promise;
      }
      return realDigest(algorithm, data);
    });
    vi.useFakeTimers(); const pending = f.send().catch(e => e); await vi.waitFor(() => expect(stalled).toBe(true));
    await vi.advanceTimersByTimeAsync(10000); expect(await pending).toMatchObject({ outcome: 'not-dispatched' });
    digest.resolve(Uint8Array.from(Buffer.from(expected.reference.locator.publicRequestHash, 'hex')).buffer);
    await Promise.resolve(); await Promise.resolve();
    expect(f.memory.original(expected.reference)).toBeNull(); expect(f.values.size).toBe(0); expect(f.getToken).not.toHaveBeenCalled();
  });
  it('safely clears local preparation when clocks fail between gesture issue and send', async () => {
    const f = await fixture(), gesture = f.coordinator.review(f.make()); f.time.wall = NaN;
    await expect(f.coordinator.send(gesture)).rejects.toMatchObject({ outcome: 'not-dispatched', code: 'expired' });
    expect(f.getToken).not.toHaveBeenCalled(); expect(f.values.size).toBe(0); expect(f.coordinator.status().reference).toBeNull();
  });
  it('bounds a token wait and permits explicit same-original continuation only while observation is current', async () => {
    const f = await fixture(), token = deferred<string>(); vi.useFakeTimers(); f.getToken.mockReturnValueOnce(token.promise);
    const pending = f.send().catch(e => e); await vi.waitFor(() => expect(f.getToken).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(10000); expect(await pending).toMatchObject({ outcome: 'not-dispatched' });
    const reference = f.coordinator.status().reference!; token.resolve('late_token'); await Promise.resolve(); expect(f.fetcher).not.toHaveBeenCalled();
    const result = await f.coordinator.send(f.coordinator.continueUnsent(reference)); expect(result.reference).toEqual(reference); expect(f.fetcher).toHaveBeenCalledOnce();
  });
  it.each(['sync-throw', 'unknown', 'typed-preflight', 'malformed', 'denied', 'scope-loss'])(
    '%s after dispatch retains the original and forbids another send', async mode => {
      const f = await fixture(), response = deferred<Response>();
      if (mode === 'sync-throw') f.fetcher.mockImplementationOnce(() => { throw Error('private'); });
      if (mode === 'unknown') f.fetcher.mockResolvedValueOnce(json({ error: { code: 'FINANCIAL_POLICY_OUTCOME_UNKNOWN' } }, 503));
      if (mode === 'typed-preflight') f.fetcher.mockResolvedValueOnce(json({ error: { code: 'FINANCIAL_POLICY_INPUT_INVALID' } }, 422));
      if (mode === 'malformed') f.fetcher.mockResolvedValueOnce(new Response('{', { headers }));
      if (mode === 'denied') f.fetcher.mockResolvedValueOnce(json({ error: { code: 'FORBIDDEN' } }, 403));
      if (mode === 'scope-loss') f.fetcher.mockReturnValueOnce(response.promise);
      const pending = f.send().catch(e => e); await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledOnce());
      const stored = JSON.parse([...f.values.values()][0]!) as FinancialPolicyReference, before = [...f.values];
      if (mode === 'scope-loss') { f.lifetime.hide(); response.resolve(json({})); }
      expect(await pending).toMatchObject({ outcome: 'unknown' }); expect([...f.values]).toEqual(before);
      expect(() => f.coordinator.continueUnsent(stored)).toThrow(); expect(() => f.coordinator.review(f.make())).toThrow();
      expect(f.fetcher).toHaveBeenCalledOnce();
    });
  it('recovers a synthetic recorded effect after acknowledgement loss with zero additional writes', async () => {
    const f = await fixture(), originalFetch = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementationOnce(async (...args) => { await originalFetch(...args); throw Error('synthetic lost acknowledgement'); });
    await expect(f.send()).rejects.toMatchObject({ outcome: 'unknown' }); expect(f.received).toHaveLength(1);
    const reference = f.coordinator.status().reference!, before = [...f.values];
    f.readFetch.mockResolvedValueOnce(json({ ...f.envelope, ...reference.locator, status: 'recorded', receipt: f.receipts[0], closure: null }));
    const result = await f.read.lookup(f.coordinator.recoveryReference(reference), f.lifetime.authorize('lookup', reference));
    expect(result.receipt).toEqual(f.receipts[0]); expect(f.fetcher).toHaveBeenCalledOnce(); expect([...f.values]).toEqual(before);
    expect(f.memory.recorded(reference)).toEqual(result.receipt); expect(f.coordinator.status().state).toBe('unknown');
    await clearFinancialPolicyReminder(f.storage, reference, result.receipt!, () => financialSame(f.lifetime.observation().bootstrap, f.bootstrap));
    expect(f.values.size).toBe(0); expect(f.fetcher).toHaveBeenCalledOnce();
    // Clearing and refreshing are distinct explicit actions; only a new review can make another original.
    await f.open(); expect(f.coordinator.review(f.make('new_policy', 'new_policy_key_001'))).toBeDefined();
  });
  it('retains unknown after a fetch timeout and cannot accept its late successful receipt', async () => {
    const f = await fixture(), response = deferred<Response>(); f.fetcher.mockReturnValueOnce(response.promise);
    vi.useFakeTimers(); const pending = f.send().catch(e => e); await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledOnce());
    const reference = f.coordinator.status().reference!, original = f.memory.original(reference)!, receipt = await f.receipt(original);
    await vi.advanceTimersByTimeAsync(10000); expect(await pending).toMatchObject({ outcome: 'unknown' });
    response.resolve(json({ ...f.envelope, status: 'recorded', receipt })); await Promise.resolve(); await Promise.resolve();
    expect(f.memory.recorded(reference)).toBeNull(); expect(f.values.size).toBe(1); expect(f.coordinator.status().state).toBe('unknown');
    expect(() => f.coordinator.continueUnsent(reference)).toThrow(); expect(f.fetcher).toHaveBeenCalledOnce();
  });
  it('blocks a stale receipt commit while serialized hash qualification is pending', async () => {
    const f = await fixture(), digest = deferred<ArrayBuffer>(); let textHashes = 0, stalled = false;
    const realDigest = crypto.subtle.digest.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, 'digest').mockImplementation((algorithm, data) => {
      const text = new TextDecoder().decode(data as ArrayBuffer);
      // Synthetic server creates one text hash, transport qualifies another, memory settlement repeats it.
      if (text.includes('financial-policy-text:v1') && ++textHashes === 3) { stalled = true; return digest.promise; }
      return realDigest(algorithm, data);
    });
    const pending = f.send().catch(e => e); await vi.waitFor(() => expect(stalled).toBe(true));
    const reference = JSON.parse([...f.values.values()][0]!) as FinancialPolicyReference; f.coordinator.invalidateReview();
    expect(await pending).toMatchObject({ outcome: 'unknown' }); digest.resolve(new ArrayBuffer(32)); await Promise.resolve();
    expect(f.memory.recorded(reference)).toBeNull(); expect(f.values.size).toBe(1);
  });
  it('enforces the response deadline at the final asynchronous memory settlement boundary', async () => {
    const f = await fixture(), digest = deferred<ArrayBuffer>(), originalFetch = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementationOnce(async (...args) => {
      const result = await originalFetch(...args), value = await result.json(); value.observation = { observedAt: iso(at - 1000), expiresAt: iso(at + 500) }; return json(value);
    });
    const realDigest = crypto.subtle.digest.bind(crypto.subtle); let textHashes = 0, stalled = false;
    vi.spyOn(crypto.subtle, 'digest').mockImplementation((algorithm, data) => {
      if (new TextDecoder().decode(data as ArrayBuffer).includes('financial-policy-text:v1') && ++textHashes === 3) { stalled = true; return digest.promise; }
      return realDigest(algorithm, data);
    });
    const pending = f.send().catch(e => e); await vi.waitFor(() => expect(stalled).toBe(true));
    const reference = JSON.parse([...f.values.values()][0]!) as FinancialPolicyReference, receipt = f.receipts[0]!;
    if (receipt.record.kind !== 'document') throw Error('fixture'); f.time.mono += 500;
    digest.resolve(Uint8Array.from(Buffer.from(receipt.record.contentHash, 'hex')).buffer);
    expect(await pending).toMatchObject({ outcome: 'unknown' }); expect(f.memory.recorded(reference)).toBeNull(); expect(f.values.size).toBe(1);
  });
});
