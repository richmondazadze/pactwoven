import { createElement, StrictMode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commandDigest } from '@pactwoven/contracts/canonical';
import { financialPolicyHttpRoute, type FinancialPolicyHttpReceipt } from '@pactwoven/contracts';
import { FinancialPolicyBootstrapSchema, financialPolicyLocalScope, type FinancialPolicyBootstrap } from '../lib/financial-policy-context';
import { createFinancialPolicyAttempt, type FinancialPolicyReference } from '../lib/financial-policy-contract';
import { storeFinancialPolicyReference, type FinancialPolicyStorage } from '../lib/financial-policy-recovery';
import { parseFinancialPolicyWriteRequest } from '../lib/financial-policy-write-transport';
import { createFinancialPolicyAuthoringController, FinancialPolicyAuthoringEditorGate, FinancialPolicyAuthoringWorkspaceView, focusFinancialPolicySavedRequests, type FinancialPolicyAuthoringController } from './financial-policy-authoring-workspace';
import { FinancialPolicyDocumentEditor } from './financial-policy-document-editor';
import { MotionProvider } from './motion';
vi.mock('@clerk/nextjs', () => ({ useAuth: () => { throw Error('Provider is not mounted in source-only tests'); } }));
vi.mock('@tanstack/react-query', () => ({ useQuery: () => { throw Error('Provider is not mounted in source-only tests'); } }));
vi.mock('./workspace-provider', () => ({ useWorkspace: () => { throw Error('Provider is not mounted in source-only tests'); } }));
vi.mock('next/navigation', () => ({ usePathname: () => '/app/responsibilities/responsibility_a/financial-policies/prepare' }));
const at = Date.parse('2026-11-15T00:00:00.000Z'), iso = (n: number) => new Date(n).toISOString(), base = 'https://api.example.test', hash = 'a'.repeat(64);
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'private, no-store' } });
const controllers: FinancialPolicyAuthoringController[] = [];
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function preparationExpiryBeforeDisplay() {
  vi.useFakeTimers();
  const scheduled = vi.spyOn(globalThis, 'setTimeout'), cancelled = vi.spyOn(globalThis, 'clearTimeout');
  return () => {
    const live = scheduled.mock.calls.flatMap(([callback, delay], index) => {
      const result = scheduled.mock.results[index];
      return result?.type === 'return' && typeof callback === 'function' &&
        !cancelled.mock.calls.some(([id]) => id === result.value) ? [{ callback: callback as () => void, delay }] : [];
    });
    // After successful preparation, only the display and preparation expiry timers remain.
    expect(live).toHaveLength(2);
    return live[1]!.callback;
  };
}
async function fixture(revision: { id: string; version: number; kind?: 'document' | 'draft' } | null = null) {
  const bootstrap = FinancialPolicyBootstrapSchema.parse({ environment: 'development', organizationId: 'org_a', actorId: 'actor_a', apiBase: base,
    responsibilityId: 'responsibility_a', userId: 'user_a', externalOrganizationId: 'provider_org', sessionId: 'session_a', organizationEpoch: 2,
    roles: ['owner'], siteIds: ['site_a'], actionSiteIds: ['site_a'], responsibility: { id: 'responsibility_a', version: 1, siteId: 'site_a' } });
  const scope = { environment: 'development', organizationId: 'org_a', actor: { actorId: 'actor_a', membershipVersion: 9 }, organizationEpoch: 2,
    roles: ['owner'], siteIds: ['site_a'], actionSiteIds: ['site_a'] };
  const authority = { schemaVersion: 1, responsibility: { id: 'responsibility_a', version: 1, hash, siteId: 'site_a' }, generation: 0, family: 'none', legacyHead: null };
  const basis = { authority, authorityHash: await commandDigest({ namespace: 'pactwoven:financial-authority-fence:v1', record: { ...authority, environment: 'development', organizationId: 'org_a' } }), site: { id: 'site_a', generation: 0, recordHash: hash } };
  const envelope = { schemaVersion: 1, scope, observation: { observedAt: iso(at - 1000), expiresAt: iso(at + 19000) }, effectiveAuthority: false, financialState: null };
  const context = { ...envelope, kind: 'responsibility', responsibilityId: 'responsibility_a', configurationVisibility: 'full', draftScope: basis,
    asset: null, control: null, acceptedConfiguration: null, periods: [], documents: [], actions: [], blockers: ['ASSET_MISSING', 'FINANCIAL_AUTHORITY_UNAVAILABLE', 'GOVERNANCE_MISSING', 'TRUST_UNAVAILABLE'] };
  const time = { wall: at, mono: 100 }, current = { value: bootstrap as FinancialPolicyBootstrap | null }, values = new Map<string, string>();
  const storage: FinancialPolicyStorage = { get length() { return values.size; }, key: i => [...values.keys()][i] ?? null, getItem: k => values.get(k) ?? null,
    setItem: vi.fn((k, v) => { values.set(k, v); }), removeItem: vi.fn(k => { values.delete(k); }) };
  const receipts: FinancialPolicyHttpReceipt[] = [], selections: unknown[] = [], writeInputs: unknown[] = [];
  const state = { writeUnknown: false, lookupMissing: false, prepChange: (response: any) => response, readResponse: null as unknown, indexResponse: null as unknown };
  const token = vi.fn(async () => 'test_token'), createKey = vi.fn(() => `explicit_original_${receipts.length + 1}`);
  const createTargetId = vi.fn((kind: 'document' | 'draft') => kind === 'document' ? 'mandate_doc' : 'draft_a');
  const fetcher = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async (url, init) => {
    if (url.endsWith('/context')) return json(context);
    if (url.includes('/versions/')) return json(state.readResponse);
    if (url.includes('/financial-policies?')) return json(state.indexResponse);
    if (url.includes('/financial-policy-operations/')) {
      const reference = JSON.parse([...values.values()][0]!) as FinancialPolicyReference, l = reference.locator;
      return json({ ...envelope, responsibilityId: bootstrap.responsibilityId, kind: l.kind, key: l.key, targetId: l.targetId, publicRequestHash: l.publicRequestHash,
        status: state.lookupMissing ? 'not_recorded' : 'recorded', receipt: state.lookupMissing ? null : receipts.find(r => r.key === l.key) });
    }
    if (url.endsWith('/financial-policy-preparation')) {
      const selection = JSON.parse(String(init.body)); selections.push(selection);
      const documentReceipt = receipts.find(r => r.kind === 'save_document' && r.target.id === selection.document?.id);
      const document = documentReceipt ? { reference: documentReceipt.target, record: documentReceipt.record, projection: { currentRecord: true, state: 'DOCUMENT', blockers: [] }, budgetConfiguration: null } : null;
      const exact = state.readResponse as { policy?: unknown; documents?: unknown[] } | null;
      const response = { ...envelope, responsibilityId: bootstrap.responsibilityId, selection,
        decision: { action: selection.action, state: 'reviewable', reasons: [], requiredAuthentication: null },
        target: selection.previous ? { state: 'exact', latestReference: selection.previous, record: exact?.policy, historicalDocuments: exact?.documents ?? [] }
          : { state: 'absent', latestReference: null, record: null, historicalDocuments: [] },
        material: selection.action === 'save_document' ? { action: selection.action, purpose: 'financial_mandate', organizationEpoch: 2, draftScope: basis, siteActive: true }
          : { action: selection.action, profile: 'incomplete', draftScope: basis, siteActive: true, document, asset: null, account: null, governance: null, trust: null },
        configurationWarnings: ['FINANCIAL_AUTHORITY_UNAVAILABLE', 'TRUST_UNAVAILABLE'] };
      return json(state.prepChange(response));
    }
    const input = JSON.parse(String(init.body)), id = url.split('/').at(-1)!, kind = url.includes('/financial-policy-documents/') ? 'save_document' : 'save_draft';
    const request = parseFinancialPolicyWriteRequest({ kind, responsibilityId: bootstrap.responsibilityId, id, key: new Headers(init.headers).get('Idempotency-Key'), route: url.slice(base.length), input });
    writeInputs.push(request);
    const attempt = await createFinancialPolicyAttempt(financialPolicyLocalScope(bootstrap), request), actor = { actorId: 'actor_a', membershipVersion: 9 }, operationId = `00000000-0000-0000-0000-${String(receipts.length + 1).padStart(12, '0')}`;
    const common = { schemaVersion: 1 as const, environment: 'development' as const, organizationId: 'org_a', responsibilityId: 'responsibility_a', actor, operationId,
      id, version: (request.input.previous?.version ?? 0) + 1, predecessor: request.input.previous, organizationEpoch: 2, createdAt: iso(at) };
    const record = request.kind === 'save_document' ? { ...common, kind: 'document' as const, purpose: request.input.purpose, text: request.input.text,
      contentHash: await commandDigest({ namespace: 'pactwoven:financial-policy-text:v1', text: request.input.text }) }
      : { ...common, kind: 'draft' as const, requester: actor, state: 'DRAFT' as const, draft: request.input.draft };
    const receipt: FinancialPolicyHttpReceipt = { ...common, kind, key: request.key, publicRequestHash: attempt.reference.locator.publicRequestHash,
      target: { id, version: common.version, recordHash: hash }, record, effectiveAuthority: false, financialState: null };
    // The test receipt is rebuilt with exactly the public receipt keys.
    const { schemaVersion, environment, organizationId, responsibilityId, actor: receiptActor } = receipt;
    const exactReceipt: FinancialPolicyHttpReceipt = { schemaVersion, environment, organizationId, responsibilityId, actor: receiptActor, operationId, kind, key: request.key,
      publicRequestHash: receipt.publicRequestHash, target: receipt.target, record, effectiveAuthority: false, financialState: null };
    receipts.push(exactReceipt); if (state.writeUnknown) throw Error('Injected acknowledgement loss');
    return json({ ...envelope, status: 'recorded', receipt: exactReceipt });
  });
  const adapters = { bootstrap, revision, currentBootstrap: () => current.value, getToken: token, fetch: fetcher, storage: () => storage, wall: () => time.wall, monotonic: () => time.mono, createKey, createTargetId };
  const controller = createFinancialPolicyAuthoringController(adapters); controllers.push(controller); controller.activate();
  function editDocument(text = 'Exact full financial mandate. Café 🧵') { if (!revision) controller.startNew('document'); controller.edit({ kind: 'document', text }); }
  async function prepareDocument() { if (!controller.getSnapshot().context) await controller.refresh(); editDocument(); controller.reviewDocument(); await controller.prepare(); }
  return { bootstrap, envelope, context, basis, time, current, values, storage, receipts, selections, writeInputs, state, token, createKey, createTargetId, fetcher, adapters, controller, editDocument, prepareDocument };
}
async function setDocumentRevisionResponse(f: Awaited<ReturnType<typeof fixture>>) {
  const id = f.adapters.revision?.id ?? 'mandate_doc', version = f.adapters.revision?.version ?? 1, text = 'Exact historical mandate text';
  const record = { schemaVersion: 1, environment: 'development', organizationId: 'org_a', responsibilityId: 'responsibility_a', actor: { actorId: 'actor_a', membershipVersion: 9 },
    id, version, predecessor: version === 1 ? null : { id, version: version - 1, recordHash: hash }, organizationEpoch: 2,
    operationId: '00000000-0000-0000-0000-000000000001', createdAt: iso(at - 1000), kind: 'document', purpose: 'financial_mandate', text,
    contentHash: await commandDigest({ namespace: 'pactwoven:financial-policy-text:v1', text }) };
  f.state.readResponse = { ...f.envelope, responsibilityId: 'responsibility_a', policy: { reference: { id, version, recordHash: hash }, record,
    projection: { currentRecord: true, state: 'DOCUMENT', blockers: [] }, budgetConfiguration: null }, documents: [], actions: [] };
}
const noNetwork = vi.fn(() => { throw Error('Unexpected actual network'); });
beforeEach(() => { vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', base); noNetwork.mockClear(); vi.stubGlobal('fetch', noNetwork); });
afterEach(() => { for (const controller of controllers.splice(0)) controller.close(); expect(noNetwork).not.toHaveBeenCalled(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe('native authoring controller with injected offline transport', () => {
  it('performs no constructor/activation/configuration or typing I/O', async () => {
    const f = await fixture(); f.controller.configure(f.adapters); f.controller.suspend(); f.controller.activate(); f.editDocument();
    expect(f.token).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled(); expect(f.createKey).not.toHaveBeenCalled(); expect(f.values.size).toBe(0);
  });
  it('chooses each new target once on an explicit start and holds it through conflict and continuation', async () => {
    const f = await fixture(); expect(f.createTargetId).not.toHaveBeenCalled(); f.controller.startNew('document'); expect(f.createTargetId).not.toHaveBeenCalled();
    await f.controller.refresh(); f.controller.startNew('document'); f.controller.startNew('document'); expect(f.createTargetId).toHaveBeenCalledOnce();
    const id = f.controller.getSnapshot().buffer.documentId;
    f.state.prepChange = response => ({ ...response, target: { state: 'changed', latestReference: { id, version: 2, recordHash: hash }, record: null, historicalDocuments: [] },
      decision: { action: 'save_document', state: 'blocked', reasons: ['PREDECESSOR_CHANGED'], requiredAuthentication: null } });
    f.editDocument(); f.controller.reviewDocument(); await f.controller.prepare(); f.controller.startNew('document');
    expect(f.controller.getSnapshot().buffer.documentId).toBe(id); expect(f.createTargetId).toHaveBeenCalledOnce(); expect(f.createKey).not.toHaveBeenCalled();
    f.controller.startNew('draft'); f.controller.startNew('draft'); expect(f.createTargetId).toHaveBeenCalledTimes(2); expect(f.controller.getSnapshot().buffer.draftId).toBe('draft_a');
  });
  it('keeps context, local review, metadata check and final text save separate', async () => {
    const f = await fixture(); await f.controller.refresh(); f.editDocument('Cafe\u0301\r\nExact terms'); f.controller.reviewDocument();
    expect(f.fetcher).toHaveBeenCalledOnce(); expect(f.controller.getSnapshot().buffer.text).toBe('Café\nExact terms'); expect(f.createKey).not.toHaveBeenCalled();
    await f.controller.prepare(); expect(f.fetcher).toHaveBeenCalledTimes(2); expect(f.selections).toEqual([{ schemaVersion: 1, action: 'save_document', targetId: 'mandate_doc', previous: null, purpose: 'financial_mandate' }]);
    expect(new Headers(f.fetcher.mock.calls[1]![1].headers).has('Idempotency-Key')).toBe(false); expect(f.writeInputs).toHaveLength(0);
    expect(f.controller.getSnapshot().preparation.state).toBe('reviewable'); await f.controller.save();
    expect(f.writeInputs).toHaveLength(1); expect(f.controller.getSnapshot().receipt?.kind).toBe('save_document'); expect(f.values.size).toBe(1);
    expect(f.controller.getSnapshot().review).toBeNull(); await f.controller.save(); expect(f.createKey).toHaveBeenCalledOnce();
  });
  it('requires a fresh draft check after a text receipt, with a separate original and no automatic second save', async () => {
    const f = await fixture(); await f.prepareDocument(); await f.controller.save(); const receipt = f.controller.getSnapshot().receipt!;
    f.controller.startNew('draft'); f.controller.useDocumentReceipt(receipt); f.controller.edit({ dates: { startsLocal: '2026-11-14T00:00', expiresLocal: '2026-11-16T00:00', timeZone: 'UTC' } });
    f.controller.reviewDraft(); expect(f.writeInputs).toHaveLength(1); await f.controller.save(); expect(f.writeInputs).toHaveLength(1);
    await f.controller.prepare(); expect(f.controller.getSnapshot().preparation.state).toBe('reviewable'); await f.controller.save();
    expect(f.writeInputs).toHaveLength(2); expect(f.selections).toHaveLength(2); expect(f.receipts.map(r => r.kind)).toEqual(['save_document', 'save_draft']);
    expect(f.receipts[1]?.key).not.toBe(f.receipts[0]?.key); expect(f.receipts[1]?.record.kind).toBe('draft'); expect(f.values.size).toBe(2);
  });
  it('discovers exact document references from an accepted draft page and reads before selecting them', async () => {
    const f = await fixture(); await f.prepareDocument(); await f.controller.save(); const textReceipt = f.controller.getSnapshot().receipt!;
    f.controller.startNew('draft'); f.controller.useDocumentReceipt(textReceipt); f.controller.edit({ dates: { startsLocal: '2026-11-14T00:00', expiresLocal: '2026-11-16T00:00', timeZone: 'UTC' } });
    f.controller.reviewDraft(); await f.controller.prepare(); await f.controller.save(); const draftReceipt = f.controller.getSnapshot().receipt!;
    f.state.indexResponse = { ...f.envelope, kind: 'responsibility', responsibilityId: 'responsibility_a', items: [{ policy: { record: draftReceipt.record, reference: draftReceipt.target,
      projection: { currentRecord: true, state: 'DRAFT', blockers: ['FINANCIAL_AUTHORITY_UNAVAILABLE', 'TRUST_UNAVAILABLE'] }, budgetConfiguration: null }, actions: [] }], nextId: null };
    f.state.readResponse = { ...f.envelope, responsibilityId: 'responsibility_a', policy: { record: textReceipt.record, reference: textReceipt.target,
      projection: { currentRecord: true, state: 'DOCUMENT', blockers: [] }, budgetConfiguration: null }, documents: [], actions: [] };
    const before = f.fetcher.mock.calls.length; await f.controller.indexDocuments(); expect(f.fetcher.mock.calls.length).toBe(before + 1);
    expect(f.controller.getSnapshot().index?.items).toHaveLength(1); expect(f.controller.getSnapshot().documentRead).toBeNull();
    await f.controller.readDocument(textReceipt.target); expect(f.fetcher.mock.calls.length).toBe(before + 2); expect(f.controller.getSnapshot().documentRead?.policy.reference).toEqual(textReceipt.target);
    f.controller.selectReadDocument(); expect(f.controller.getSnapshot().buffer.document).toEqual({ id: textReceipt.target.id, version: '1', recordHash: hash });
    expect(f.selections).toHaveLength(2); expect(f.writeInputs).toHaveLength(2); expect(f.controller.getSnapshot().review).toBeNull();
  });
  it('rejects caller-invented document references before token or read work', async () => {
    const f = await fixture(); await f.controller.refresh(); const before = f.token.mock.calls.length;
    await f.controller.readDocument({ id: 'invented', version: 1, recordHash: hash }); expect(f.token.mock.calls.length).toBe(before);
    expect(f.controller.getSnapshot().documentRead).toBeNull(); expect(f.controller.getSnapshot().buffer.document.id).toBe('');
    f.controller.selectReadDocument(); expect(f.token.mock.calls.length).toBe(before); expect(f.controller.getSnapshot().buffer.document.id).toBe('');
  });
  it('invalid local text and dates do not call the provider or create an original', async () => {
    const f = await fixture(); await f.controller.refresh(); f.editDocument(' \n'); f.controller.reviewDocument(); await f.controller.prepare();
    expect(f.controller.getSnapshot().error?.field).toBe('policy-text'); expect(f.token).toHaveBeenCalledOnce(); expect(f.createKey).not.toHaveBeenCalled();
    await f.prepareDocument(); await f.controller.save(); const receipt = f.controller.getSnapshot().receipt!, before = f.token.mock.calls.length;
    f.controller.startNew('draft'); f.controller.useDocumentReceipt(receipt); f.controller.edit({ dates: { startsLocal: '2026-11-01T01:30', expiresLocal: '2026-11-16T01:30', timeZone: 'America/Chicago' } });
    f.controller.reviewDraft(); expect(f.controller.getSnapshot().error?.field).toBe('draft-start'); expect(f.token.mock.calls.length).toBe(before);
  });
  it('invalidates preparation synchronously before text or selector edits', async () => {
    const f = await fixture(); await f.prepareDocument(); f.controller.edit({ text: 'Changed text' });
    expect(f.controller.getSnapshot().review).toBeNull(); expect(f.controller.getSnapshot().preparation.preparation).toBeNull();
    await f.controller.save(); expect(f.writeInputs).toHaveLength(0); expect(f.createKey).not.toHaveBeenCalled();
  });
  it('preserves same-scope user buffers across freshness checks while clearing protected snapshots', async () => {
    const f = await fixture(); await f.prepareDocument(); const text = f.controller.getSnapshot().buffer.text;
    const token = deferred<string>(); f.token.mockReturnValueOnce(token.promise); const pending = f.controller.refresh();
    expect(f.controller.getSnapshot()).toMatchObject({ context: null, exact: null, review: null, buffer: { text } });
    token.resolve('fresh_token'); await pending; expect(f.controller.getSnapshot().buffer.text).toBe(text); expect(f.controller.getSnapshot().preparation.preparation).toBeNull();
  });
  it('expires protected display and save readiness without discarding same-scope unsent user text', async () => {
    const f = await fixture(); vi.useFakeTimers(); await f.prepareDocument(); const text = f.controller.getSnapshot().buffer.text;
    f.time.wall += 19000; f.time.mono += 19000; await vi.advanceTimersByTimeAsync(19000);
    expect(f.controller.getSnapshot()).toMatchObject({ context: null, review: null, buffer: { text } }); await f.controller.save(); expect(f.createKey).not.toHaveBeenCalled();
  });
  it.each(['hash', 'token'] as const)('preserves the same-scope draft when context expires during predispatch %s before timers run', async gap => {
    const f = await fixture(); await f.prepareDocument(); await f.controller.save();
    const receipt = f.controller.getSnapshot().receipt!;
    f.controller.startNew('draft'); f.controller.useDocumentReceipt(receipt);
    f.controller.edit({ dates: { startsLocal: '2026-11-15T12:00', expiresLocal: '2026-11-16T12:00', timeZone: 'UTC' } });
    f.controller.reviewDraft(); await f.controller.prepare();
    const buffer = f.controller.getSnapshot().buffer, writes = f.writeInputs.length, calls = f.fetcher.mock.calls.length;
    const reminders = [...f.values.entries()], entered = deferred<void>(), release = deferred<void>();
    if (gap === 'hash') {
      const digest = crypto.subtle.digest.bind(crypto.subtle);
      vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (algorithm, bytes) => { entered.resolve(); await release.promise; return digest(algorithm, bytes); });
    } else f.token.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return 'fresh_token'; });
    const pending = f.controller.save(); await entered.promise;
    // Advance only the injected clocks: the display/preparation timers have not run.
    f.time.wall += 19000; f.time.mono += 19000; release.resolve(); await pending;
    expect(f.writeInputs).toHaveLength(writes); expect(f.fetcher).toHaveBeenCalledTimes(calls);
    expect(f.controller.getSnapshot()).toMatchObject({ phase: 'expired', busy: false, context: null, exact: null,
      documentRead: null, review: null, receipt: null, preparation: { preparation: null }, buffer });
    expect(f.controller.getSnapshot().message).toContain('observation expired');
    expect([...f.values.entries()].filter(([key]) => reminders.some(([original]) => key === original))).toEqual(reminders);
    expect(f.values.size).toBe(gap === 'token' ? 2 : 1);
    await f.controller.save(); expect(f.writeInputs).toHaveLength(writes); expect(f.fetcher).toHaveBeenCalledTimes(calls);
  });
  it.each(['hide', 'scope', 'adapter', 'close'] as const)('does not restore an expiring predispatch buffer after %s', async loss => {
    const f = await fixture(); await f.prepareDocument();
    const calls = f.fetcher.mock.calls.length, entered = deferred<void>(), release = deferred<void>();
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (algorithm, bytes) => { entered.resolve(); await release.promise; return digest(algorithm, bytes); });
    const pending = f.controller.save(); await entered.promise;
    if (loss === 'hide') f.controller.suspend();
    if (loss === 'scope') f.current.value = null;
    if (loss === 'adapter') { f.controller.configure({ ...f.adapters, getToken: vi.fn(async () => 'replacement') }); f.controller.activate(); }
    if (loss === 'close') f.controller.close();
    f.time.wall += 19000; f.time.mono += 19000; release.resolve(); await pending;
    expect(f.controller.getSnapshot()).toMatchObject({ context: null, review: null, receipt: null,
      buffer: { text: '', documentId: '', draftId: '' }, preparation: { preparation: null } });
    expect(f.fetcher).toHaveBeenCalledTimes(calls); expect(f.writeInputs).toHaveLength(0); expect(f.values.size).toBe(0);
  });
  it('retains the exact draft when the preparation subscription encounters GET expiry before the display timer', async () => {
    const f = await fixture(), expiry = preparationExpiryBeforeDisplay();
    await f.prepareDocument(); await f.controller.save(); const receipt = f.controller.getSnapshot().receipt!;
    f.controller.startNew('draft'); f.controller.useDocumentReceipt(receipt);
    f.controller.edit({ dates: { startsLocal: '2026-11-18T15:00', expiresLocal: '2026-11-19T15:00', timeZone: 'UTC' } });
    f.controller.reviewDraft(); await f.controller.prepare();
    const buffer = f.controller.getSnapshot().buffer, reminders = [...f.values.entries()], calls = f.fetcher.mock.calls.length;
    const expirePreparation = expiry();
    f.time.wall += 19000; f.time.mono += 19000;
    // Service preparation expiry first, without running the display timer or dispatching Save.
    expirePreparation();
    expect(f.controller.getSnapshot()).toMatchObject({ phase: 'expired', context: null, exact: null, index: null,
      documentRead: null, review: null, receipt: null, rows: [], preparation: { state: 'expired', preparation: null }, buffer });
    expect(f.controller.getSnapshot().message).toContain('observation expired');
    expect(f.controller.getSnapshot().message).toContain('local edits');
    expect(f.controller.getSnapshot().message).not.toContain('unsent');
    expect(f.controller.preparationFresh()).toBe(false);
    await f.controller.save(); expect(f.fetcher).toHaveBeenCalledTimes(calls); expect(f.writeInputs).toHaveLength(1);
    expect(f.createKey).toHaveBeenCalledOnce(); expect([...f.values.entries()]).toEqual(reminders);
  });
  it('clears preparation and local review while retaining valid GET context and edits on earlier preparation-only expiry', async () => {
    const f = await fixture(), expiry = preparationExpiryBeforeDisplay();
    f.state.prepChange = response => ({ ...response, observation: { observedAt: iso(at - 1000), expiresAt: iso(at + 2000) } });
    await f.prepareDocument(); const buffer = f.controller.getSnapshot().buffer, context = f.controller.getSnapshot().context;
    const expirePreparation = expiry(); f.time.wall += 2000; f.time.mono += 2000; expirePreparation();
    expect(f.controller.getSnapshot()).toMatchObject({ phase: 'ready', context, buffer, review: null,
      preparation: { state: 'expired', preparation: null } });
    expect(f.controller.getSnapshot().message).toContain('preparation expired');
    expect(f.controller.getSnapshot().message).toContain('local edits');
    expect(f.controller.fresh()).toBe(true); expect(f.controller.preparationFresh()).toBe(false);
    await f.controller.save(); expect(f.createKey).not.toHaveBeenCalled(); expect(f.writeInputs).toHaveLength(0);
  });
  it.each(['hide', 'scope', 'adapter', 'denial'] as const)('does not preserve or restore buffers after %s when a preparation-expiry callback runs', async loss => {
    const f = await fixture(), expiry = preparationExpiryBeforeDisplay(); await f.prepareDocument();
    const expirePreparation = expiry();
    if (loss === 'hide') f.controller.suspend();
    if (loss === 'scope') f.current.value = null;
    if (loss === 'adapter') { f.controller.configure({ ...f.adapters, getToken: vi.fn(async () => 'replacement') }); f.controller.activate(); }
    if (loss === 'denial') { f.fetcher.mockResolvedValueOnce(json({ error: { code: 'FORBIDDEN' } }, 403)); await f.controller.prepare(); }
    const calls = f.fetcher.mock.calls.length;
    f.time.wall += 19000; f.time.mono += 19000; expirePreparation();
    expect(f.controller.getSnapshot()).toMatchObject({ context: null, review: null, receipt: null,
      buffer: { text: '', documentId: '', draftId: '' }, preparation: { preparation: null } });
    expect(f.fetcher).toHaveBeenCalledTimes(calls); expect(f.writeInputs).toHaveLength(0); expect(f.values.size).toBe(0);
    if (loss === 'denial') expect(f.controller.getSnapshot().phase).toBe('denied');
  });
  it('rejects an expired preparation synchronously before its timer runs', async () => {
    const f = await fixture(); f.state.prepChange = response => ({ ...response, observation: { observedAt: iso(at - 1000), expiresAt: iso(at + 2000) } });
    await f.prepareDocument(); expect(f.controller.preparationFresh()).toBe(true); f.time.wall += 2000;
    expect(f.controller.preparationFresh()).toBe(false); expect(f.controller.fresh()).toBe(true);
    await f.controller.save(); expect(f.createKey).not.toHaveBeenCalled(); expect(f.writeInputs).toHaveLength(0);
  });
  it('does not splice newer preparation material into the older GET basis', async () => {
    const f = await fixture(); const authority = { ...f.basis.authority, generation: 1 }, authorityHash = await commandDigest({ namespace: 'pactwoven:financial-authority-fence:v1', record: { ...authority, environment: 'development', organizationId: 'org_a' } });
    f.state.prepChange = response => ({ ...response, material: { ...response.material, draftScope: { ...f.basis, authority, authorityHash } } });
    await f.prepareDocument(); expect(f.controller.getSnapshot().preparation.preparation).toBeNull(); await f.controller.save();
    expect(f.writeInputs).toHaveLength(0); expect(f.createKey).not.toHaveBeenCalled();
  });
  it.each(['hide', 'scope', 'adapter', 'close'])('clears private buffers and rejects a late check after %s', async mode => {
    const f = await fixture(); await f.controller.refresh(); f.editDocument(); f.controller.reviewDocument(); const token = deferred<string>(); f.token.mockReturnValueOnce(token.promise);
    const pending = f.controller.prepare(), focus = f.controller.getSnapshot().focus;
    if (mode === 'hide') f.controller.suspend(); if (mode === 'scope') f.current.value = null; if (mode === 'close') f.controller.close();
    if (mode === 'adapter') { f.controller.configure({ ...f.adapters, getToken: vi.fn(async () => 'replacement') }); f.controller.activate(); }
    token.resolve('late_token'); await pending;
    expect(f.controller.getSnapshot().buffer.text).toBe(''); expect(f.controller.getSnapshot().preparation.preparation).toBeNull();
    expect(f.writeInputs).toHaveLength(0); expect(f.selections).toHaveLength(0); if (mode !== 'adapter') expect(f.controller.getSnapshot().focus).toBe(focus);
  });
  it('denial clears text synchronously and remains latched through visibility and same-bootstrap adapter changes', async () => {
    const f = await fixture(); await f.prepareDocument(); f.fetcher.mockResolvedValueOnce(json({ error: { code: 'FORBIDDEN' } }, 403));
    await f.controller.prepare(); expect(f.controller.getSnapshot()).toMatchObject({ phase: 'denied', buffer: { text: '' }, context: null });
    const tokenCalls = f.token.mock.calls.length; f.controller.suspend(); f.controller.activate(); f.controller.configure({ ...f.adapters, fetch: vi.fn(async () => json(f.context)) });
    await f.controller.refresh(); expect(f.token.mock.calls.length).toBe(tokenCalls); expect(f.controller.getSnapshot().phase).toBe('denied');
  });
  it.each(['blocked', 'not_evaluated', 'changed', 'unavailable'])('never converts a %s preparation into a save', async mode => {
    const f = await fixture(); f.state.prepChange = response => {
      if (mode === 'changed') response.target = { state: 'changed', latestReference: { id: response.selection.targetId, version: 2, recordHash: hash }, record: null, historicalDocuments: [] };
      if (mode === 'unavailable') response.target = { state: 'unavailable', latestReference: null, record: null, historicalDocuments: [] };
      response.decision = { action: 'save_document', state: mode === 'not_evaluated' ? mode : 'blocked', reasons: [mode === 'changed' ? 'PREDECESSOR_CHANGED' : mode === 'unavailable' ? 'TARGET_UNAVAILABLE' : mode === 'not_evaluated' ? 'ELIGIBILITY_NOT_EVALUATED' : 'SERVICE_UNAVAILABLE'], requiredAuthentication: null };
      return response;
    };
    await f.prepareDocument(); await f.controller.save(); expect(f.writeInputs).toHaveLength(0); expect(f.createKey).not.toHaveBeenCalled(); expect(f.controller.getSnapshot().buffer.documentId).toBe('mandate_doc');
  });
  it('serializes rapid actions and preserves the in-flight review against an edit', async () => {
    const f = await fixture(); await f.controller.refresh(); f.editDocument(); f.controller.reviewDocument(); const token = deferred<string>(); f.token.mockReturnValueOnce(token.promise);
    const pending = f.controller.prepare(); await f.controller.prepare(); f.controller.edit({ text: 'Not applied during active action' });
    token.resolve('prepared_token'); await pending; expect(f.selections).toHaveLength(1); expect(f.controller.getSnapshot().buffer.text).toContain('Exact full');
  });
  it('retains unknown originals, offers explicit lookup and never rekeys or retries on refresh', async () => {
    const f = await fixture(); await f.prepareDocument(); f.state.writeUnknown = true; await f.controller.save();
    expect(f.controller.getSnapshot().message).toContain('unknown'); expect(f.values.size).toBe(1); expect(f.controller.getSnapshot().review).toBeNull();
    await f.controller.save(); expect(f.createKey).toHaveBeenCalledOnce(); expect(f.writeInputs).toHaveLength(1);
    const reference = f.controller.getSnapshot().rows[0]!.reference; await f.controller.lookup(reference);
    expect(f.controller.getSnapshot().rows[0]?.state).toBe('recorded'); expect(f.values.size).toBe(1);
    await f.controller.clear(reference); expect(f.values.size).toBe(0); expect(f.writeInputs).toHaveLength(1);
  });
  it('reports the original save as unknown when a dispatched response crosses expiry without replay or rekeying', async () => {
    const f = await fixture(); await f.prepareDocument();
    const entered = deferred<void>(), release = deferred<void>(), implement = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementationOnce(async (url, init) => { const response = await implement(url, init); entered.resolve(); await release.promise; return response; });
    const pending = f.controller.save(); await entered.promise;
    const originals = [...f.values.entries()], reference = JSON.parse(originals[0]![1]) as FinancialPolicyReference;
    expect(f.writeInputs).toHaveLength(1); expect(originals).toHaveLength(1);
    expect(reference.locator).toMatchObject({ key: 'explicit_original_1', targetId: 'mandate_doc', kind: 'save_document' });
    // The request has dispatched; expire only the injected clocks while its response is held.
    f.time.wall += 19000; f.time.mono += 19000; release.resolve(); await pending;
    expect(f.controller.getSnapshot()).toMatchObject({ phase: 'expired', busy: false, context: null, exact: null,
      documentRead: null, review: null, receipt: null, preparation: { preparation: null } });
    expect(f.controller.getSnapshot().message).toContain('original save result is unknown');
    expect(f.controller.getSnapshot().message).toContain('exact original result');
    expect(f.controller.getSnapshot().message).not.toMatch(/unsent|retry/i);
    expect([...f.values.entries()]).toEqual(originals);
    await f.controller.save();
    expect(f.createKey).toHaveBeenCalledOnce(); expect(f.writeInputs).toHaveLength(1);
    expect(f.fetcher.mock.calls.filter(([url, init]) => init.method === 'POST' && url.includes('/financial-policy-documents/'))).toHaveLength(1);
    expect(f.fetcher.mock.calls.some(([url]) => url.includes('/financial-policy-operations/'))).toBe(false);
    expect([...f.values.entries()]).toEqual(originals);
  });
  it('hides a dispatched save without deleting its stored original or publishing the late receipt', async () => {
    const f = await fixture(); await f.prepareDocument(); const entered = deferred<void>(), release = deferred<void>(), implement = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementationOnce(async (url, init) => { entered.resolve(); await release.promise; return implement(url, init); });
    const pending = f.controller.save(); await entered.promise; expect(f.values.size).toBe(1); f.controller.suspend(); release.resolve(); await pending;
    expect(f.values.size).toBe(1); expect(f.controller.getSnapshot()).toMatchObject({ visible: false, buffer: { text: '' }, receipt: null, rows: [] });
    expect(f.createKey).toHaveBeenCalledOnce();
  });
  it('never clears a reminder when current scope is lost during receipt hashing', async () => {
    const f = await fixture(); await f.prepareDocument(); await f.controller.save(); const reference = f.controller.getSnapshot().rows[0]!.reference;
    const entered = deferred<void>(), release = deferred<void>(), digest = crypto.subtle.digest.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (algorithm, data) => { entered.resolve(); await release.promise; return digest(algorithm, data); });
    const pending = f.controller.clear(reference); await entered.promise; f.current.value = null; release.resolve(); await pending;
    expect(f.storage.removeItem).not.toHaveBeenCalled(); expect(f.values.size).toBe(1); expect(f.controller.getSnapshot().buffer.text).toBe('');
  });
  it('does not erase an already known receipt after a later no-result lookup', async () => {
    const f = await fixture(); await f.prepareDocument(); await f.controller.save(); const ref = f.controller.getSnapshot().rows[0]!.reference;
    f.state.lookupMissing = true; await f.controller.lookup(ref); expect(f.controller.getSnapshot().rows[0]?.state).toBe('recorded'); expect(f.controller.getSnapshot().rows[0]?.receipt).not.toBeNull();
  });
  it('fails closed on storage failure before write-side token or dispatch', async () => {
    const f = await fixture(); await f.prepareDocument(); vi.mocked(f.storage.setItem).mockImplementation(() => { throw Error('Quota'); });
    const before = f.token.mock.calls.length; await f.controller.save(); expect(f.token.mock.calls.length).toBe(before); expect(f.writeInputs).toHaveLength(0); expect(f.controller.getSnapshot().review).toBeNull();
  });
  it.each(['target', 'key'])('honors the same-tab %s collision barrier across responsibility scopes', async collision => {
    const f = await fixture(); await f.prepareDocument();
    const id = collision === 'target' ? 'mandate_doc' : 'other_doc', key = collision === 'key' ? 'explicit_original_1' : 'different_original_key';
    const scope = { ...financialPolicyLocalScope(f.bootstrap), responsibilityId: 'responsibility_b' };
    const attempt = await createFinancialPolicyAttempt(scope, { kind: 'save_document', responsibilityId: 'responsibility_b', id, key,
      route: financialPolicyHttpRoute({ kind: 'save_document', responsibilityId: 'responsibility_b', id }), input: { schemaVersion: 1, previous: null, organizationEpoch: 2, purpose: 'financial_mandate', text: 'Separate scope original' } });
    storeFinancialPolicyReference(f.storage, attempt.reference); await f.controller.save(); expect(f.writeInputs).toHaveLength(0); expect(f.values.size).toBe(1);
  });
  it('requires exact revision hydration and never merges the old text or replaces the predecessor', async () => {
    const f = await fixture({ id: 'mandate_doc', version: 1 }); await f.controller.refresh(); f.editDocument('New revision terms'); f.controller.reviewDocument();
    expect(f.controller.getSnapshot().error?.field).toBe('revision-kind'); expect(f.selections).toHaveLength(0);
    const text = 'Historical exact text', record = { schemaVersion: 1, environment: 'development', organizationId: 'org_a', responsibilityId: 'responsibility_a', actor: { actorId: 'actor_a', membershipVersion: 9 },
      id: 'mandate_doc', version: 1, predecessor: null, organizationEpoch: 2, operationId: '00000000-0000-0000-0000-000000000001', createdAt: iso(at - 1000), kind: 'document', purpose: 'financial_mandate', text,
      contentHash: await commandDigest({ namespace: 'pactwoven:financial-policy-text:v1', text }) };
    f.state.readResponse = { ...f.envelope, responsibilityId: 'responsibility_a', policy: { reference: { id: 'mandate_doc', version: 1, recordHash: hash }, record, projection: { currentRecord: true, state: 'DOCUMENT', blockers: [] }, budgetConfiguration: null }, documents: [], actions: [] };
    await f.controller.readRevision(); expect(f.controller.getSnapshot().buffer.text).toBe('New revision terms'); f.controller.reviewDocument(); await f.controller.prepare();
    expect(f.controller.getSnapshot().preparation.state).toBe('reviewable'); expect(f.selections[0]).toMatchObject({ previous: { id: 'mandate_doc', version: 1, recordHash: hash } });
  });
  it.each([
    { revision: { id: 'mandate_doc', version: 1 }, expected: 'draft' },
    { revision: { id: 'mandate_doc', version: 1, kind: 'draft' as const }, expected: 'draft' },
    { revision: { id: 'mandate_doc', version: 1, kind: 'document' as const }, expected: 'document' },
  ])('initializes a blank $expected revision without treating its hint as a read or action', async ({ revision, expected }) => {
    const f = await fixture(revision);
    expect(f.controller.getSnapshot()).toMatchObject({ exact: null, context: null, review: null, receipt: null,
      buffer: { kind: expected, documentId: 'mandate_doc', draftId: 'mandate_doc', text: '', document: { id: '', version: '', recordHash: '' },
        dates: { startsLocal: '', expiresLocal: '', timeZone: 'UTC' } } });
    expect(f.token).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled(); expect(f.createKey).not.toHaveBeenCalled();
    expect(f.createTargetId).not.toHaveBeenCalled(); expect(f.values.size).toBe(0);
  });
  it('treats missing and explicit draft hints as the same owner without replacing manual edits', async () => {
    const f = await fixture({ id: 'mandate_doc', version: 1 }); await f.controller.refresh();
    f.controller.edit({ kind: 'document', text: 'Manual editor choice' }); const before = f.controller.getSnapshot(), calls = f.fetcher.mock.calls.length;
    const explicit = { ...f.adapters, revision: { id: 'mandate_doc', version: 1, kind: 'draft' as const } };
    expect(f.controller.matches(explicit)).toBe(true); f.controller.configure(explicit);
    expect(f.controller.getSnapshot()).toBe(before); expect(f.controller.matches(f.adapters)).toBe(true);
    f.controller.configure(f.adapters); expect(f.controller.getSnapshot()).toBe(before); expect(f.fetcher.mock.calls.length).toBe(calls);
  });
  it('keeps a document hint separate from the exact predecessor, preparation and final save', async () => {
    const f = await fixture({ id: 'mandate_doc', version: 3, kind: 'document' }); await f.controller.refresh();
    f.controller.edit({ text: 'Explicit new revision terms' }); f.controller.reviewDocument();
    expect(f.controller.getSnapshot().error?.field).toBe('revision-kind'); expect(f.fetcher).toHaveBeenCalledOnce();
    expect(f.selections).toHaveLength(0); expect(f.createKey).not.toHaveBeenCalled();
    await setDocumentRevisionResponse(f); await f.controller.readRevision();
    expect(f.fetcher.mock.calls[1]?.[0]).toBe(`${base}/v1/responsibilities/responsibility_a/financial-policy-documents/mandate_doc/versions/3`);
    expect(f.controller.getSnapshot().buffer.text).toBe('Explicit new revision terms');
    f.controller.reviewDocument(); await f.controller.prepare();
    expect(f.selections).toEqual([{ schemaVersion: 1, action: 'save_document', targetId: 'mandate_doc',
      previous: { id: 'mandate_doc', version: 3, recordHash: hash }, purpose: 'financial_mandate' }]);
    expect(f.controller.getSnapshot().preparation.state).toBe('reviewable'); expect(f.writeInputs).toHaveLength(0); expect(f.createKey).not.toHaveBeenCalled();
    await f.controller.save(); expect(f.writeInputs).toHaveLength(1); expect(f.receipts[0]?.target.version).toBe(4); expect(f.createKey).toHaveBeenCalledOnce();
  });
  it('does not auto-detect another record family when the hinted exact read returns a document', async () => {
    const f = await fixture({ id: 'mandate_doc', version: 1, kind: 'draft' }); await f.controller.refresh(); await setDocumentRevisionResponse(f);
    await f.controller.readRevision();
    expect(f.fetcher.mock.calls.map(([url]) => url)).toEqual([`${base}/v1/responsibilities/responsibility_a/financial-policies/context`,
      `${base}/v1/responsibilities/responsibility_a/financial-policies/mandate_doc/versions/1`]);
    expect(f.controller.getSnapshot().exact).toBeNull(); expect(f.controller.getSnapshot().buffer.kind).toBe('draft');
    expect(f.selections).toHaveLength(0); expect(f.createKey).not.toHaveBeenCalled(); expect(f.writeInputs).toHaveLength(0);
  });
  it.each(['read', 'preparation'] as const)('discards a late %s response when only the route kind changes', async lane => {
    const f = await fixture({ id: 'mandate_doc', version: 1, kind: 'document' }); await f.controller.refresh(); await setDocumentRevisionResponse(f);
    f.controller.edit({ text: 'Private pending revision' });
    if (lane === 'preparation') { await f.controller.readRevision(); f.controller.reviewDocument(); }
    const entered = deferred<void>(), release = deferred<void>(), settled = deferred<void>(), implement = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementationOnce(async (url, init) => { entered.resolve(); await release.promise; try { return await implement(url, init); } finally { settled.resolve(); } });
    const pending = lane === 'read' ? f.controller.readRevision() : f.controller.prepare(); await entered.promise;
    const next = { ...f.adapters, revision: { id: 'mandate_doc', version: 1, kind: 'draft' as const } };
    expect(f.controller.matches(next)).toBe(false); f.controller.configure(next); f.controller.activate(); const replacement = f.controller.getSnapshot();
    expect(replacement).toMatchObject({ context: null, exact: null, review: null, receipt: null, buffer: { kind: 'draft', text: '' }, preparation: { preparation: null } });
    release.resolve(); await settled.promise; await pending; expect(f.controller.getSnapshot()).toBe(replacement);
    expect(f.controller.matches(next)).toBe(true); expect(f.createKey).not.toHaveBeenCalled(); expect(f.writeInputs).toHaveLength(0);
  });
  it('keeps denial latched across a same-bootstrap route-kind change', async () => {
    const f = await fixture({ id: 'mandate_doc', version: 1, kind: 'document' }); await f.controller.refresh(); f.controller.edit({ text: 'Private revision' });
    f.fetcher.mockResolvedValueOnce(json({ error: { code: 'FORBIDDEN' } }, 403)); await f.controller.readRevision();
    expect(f.controller.getSnapshot().phase).toBe('denied'); const calls = f.token.mock.calls.length;
    f.controller.configure({ ...f.adapters, revision: { id: 'mandate_doc', version: 1, kind: 'draft' } }); f.controller.activate(); await f.controller.refresh();
    expect(f.controller.getSnapshot()).toMatchObject({ phase: 'denied', context: null, exact: null, review: null, buffer: { text: '', kind: 'draft' } });
    expect(f.token.mock.calls.length).toBe(calls); expect(f.createKey).not.toHaveBeenCalled();
  });
  it('preserves a dispatched original through a route-kind change without lookup, clearing or replay', async () => {
    const f = await fixture({ id: 'mandate_doc', version: 1, kind: 'document' }); await f.controller.refresh(); await setDocumentRevisionResponse(f);
    await f.controller.readRevision(); f.controller.edit({ text: 'Reviewed revision' }); f.controller.reviewDocument(); await f.controller.prepare();
    const entered = deferred<void>(), release = deferred<void>(), settled = deferred<void>(), implement = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementationOnce(async (url, init) => { entered.resolve(); await release.promise; try { return await implement(url, init); } finally { settled.resolve(); } });
    const pending = f.controller.save(); await entered.promise; const stored = [...f.values.entries()]; expect(stored).toHaveLength(1);
    f.controller.configure({ ...f.adapters, revision: { id: 'mandate_doc', version: 1, kind: 'draft' } }); f.controller.activate();
    const replacement = f.controller.getSnapshot(); release.resolve(); await settled.promise; await pending;
    expect(f.controller.getSnapshot()).toBe(replacement); expect([...f.values.entries()]).toEqual(stored); expect(f.storage.removeItem).not.toHaveBeenCalled();
    expect(f.createKey).toHaveBeenCalledOnce(); expect(f.writeInputs).toHaveLength(1); expect(f.receipts).toHaveLength(1);
    await f.controller.refresh(); expect(f.controller.getSnapshot().rows).toMatchObject([{ state: 'unchecked', receipt: null }]);
    expect(f.fetcher.mock.calls.filter(([url]) => url.includes('/financial-policy-operations/'))).toHaveLength(0);
    expect(f.createKey).toHaveBeenCalledOnce(); expect(f.writeInputs).toHaveLength(1);
  });
  it('preserves manual kind choice on ordinary expiry but resets to the route hint after hiding', async () => {
    const f = await fixture({ id: 'mandate_doc', version: 1, kind: 'document' }); await f.controller.refresh();
    f.controller.edit({ kind: 'draft', text: 'Unsent text', dates: { timeZone: 'UTC', startsLocal: '2026-11-14T00:00', expiresLocal: '2026-11-16T00:00' } });
    const before = f.controller.getSnapshot(); f.controller.configure(f.adapters); expect(f.controller.getSnapshot()).toBe(before);
    f.controller.expireDisplay(); expect(f.controller.getSnapshot().buffer).toEqual(before.buffer);
    f.controller.suspend(); f.controller.activate(); expect(f.controller.getSnapshot()).toMatchObject({ context: null, exact: null, review: null,
      buffer: { kind: 'document', text: '', dates: { startsLocal: '', expiresLocal: '', timeZone: 'UTC' } } });
    expect(f.fetcher).toHaveBeenCalledOnce(); expect(f.createKey).not.toHaveBeenCalled();
  });
  it('rejects an unsupported revision kind before constructing a usable owner', async () => {
    const f = await fixture();
    expect(() => createFinancialPolicyAuthoringController({ ...f.adapters,
      revision: { id: 'mandate_doc', version: 1, kind: 'governance' as 'document' } })).toThrow('Exact financial-policy material is required.');
    expect(f.token).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled(); expect(f.createKey).not.toHaveBeenCalled(); expect(f.values.size).toBe(0);
  });
  it('has a side-effect-free StrictMode server render; actual DOM lifecycle remains a browser qualification', async () => {
    const f = await fixture(), html = renderToStaticMarkup(createElement(StrictMode, null, createElement(MotionProvider, null, createElement(FinancialPolicyAuthoringWorkspaceView, f.adapters))));
    expect(html).toContain('Prepare financial configuration'); expect(html).toContain('No request has been sent'); expect(f.fetcher).not.toHaveBeenCalled(); expect(f.token).not.toHaveBeenCalled();
  });
});

describe('visible original recovery guidance', () => {
  async function original(f: Awaited<ReturnType<typeof fixture>>) {
    return (await createFinancialPolicyAttempt(financialPolicyLocalScope(f.bootstrap), {
      kind: 'save_document', responsibilityId: 'responsibility_a', id: 'mandate_doc', key: 'retained_original_1',
      route: financialPolicyHttpRoute({ kind: 'save_document', responsibilityId: 'responsibility_a', id: 'mandate_doc' }),
      input: { schemaVersion: 1, previous: null, organizationEpoch: 2, purpose: 'financial_mandate', text: 'Earlier exact text' },
    })).reference;
  }
  const motion = { mode: 'normal' as const, keyboard: false, prefersReducedMotion: false };
  const target = () => ({ focus: vi.fn(), scrollIntoView: vi.fn() });
  it('keeps the same-target reminder visible through explicit lookup until a separate exact clear', async () => {
    const f = await fixture(); await f.prepareDocument(); await f.controller.save();
    const ref = f.controller.getSnapshot().rows[0]!.reference;
    expect(f.controller.hasVisibleOriginal()).toBe(true);
    await f.controller.refresh(); expect(f.controller.getSnapshot().rows[0]).toMatchObject({ state: 'unchecked', receipt: null });
    expect(f.controller.hasVisibleOriginal()).toBe(true);
    const stored = [...f.values], writes = f.writeInputs.length;
    await f.controller.lookup(ref); expect(f.controller.getSnapshot().rows[0]?.state).toBe('recorded');
    expect(f.controller.hasVisibleOriginal()).toBe(true); expect([...f.values]).toEqual(stored);
    await f.controller.clear(ref); const cleared = f.controller.getSnapshot();
    expect(cleared.rows[0]?.state).toBe('cleared'); expect(f.controller.hasVisibleOriginal()).toBe(false);
    const node = target(); focusFinancialPolicySavedRequests(f.controller, f.adapters, node, motion);
    expect(node.focus).not.toHaveBeenCalled(); expect(node.scrollIntoView).not.toHaveBeenCalled();
    expect(cleared.review).toBeNull(); expect(cleared.preparation.preparation).toBeNull(); expect(cleared.buffer.text).toContain('Exact full');
    expect(f.writeInputs).toHaveLength(writes); expect(f.createKey).toHaveBeenCalledOnce(); expect(f.storage.removeItem).toHaveBeenCalledOnce();
  });
  it('uses the selected target regardless of command kind, and ignores other targets and an unstarted record', async () => {
    const f = await fixture(), ref = await original(f);
    storeFinancialPolicyReference(f.storage, { ...ref, locator: { ...ref.locator, kind: 'save_draft' } });
    await f.controller.refresh(); expect(f.controller.getSnapshot().rows).toHaveLength(1); expect(f.controller.hasVisibleOriginal()).toBe(false);
    f.controller.startNew('document'); expect(f.controller.hasVisibleOriginal()).toBe(true);
    f.controller.startNew('draft'); expect(f.controller.hasVisibleOriginal()).toBe(false);
    expect(f.controller.getSnapshot().rows).toHaveLength(1); expect(f.writeInputs).toHaveLength(0); expect(f.storage.removeItem).not.toHaveBeenCalled();
  });
  it.each(['environment', 'organizationId', 'actorId', 'responsibilityId', 'apiBase'] as const)(
    'does not expose an original from a different %s', async field => {
      const f = await fixture(), ref = structuredClone(await original(f));
      if (field === 'environment') ref.scope.environment = 'staging';
      else if (field === 'apiBase') ref.scope.apiBase = 'https://alias.example.test';
      else ref.scope[field] = 'private_other';
      if (field === 'responsibilityId') ref.locator.responsibilityId = ref.scope.responsibilityId;
      storeFinancialPolicyReference(f.storage, ref); await f.prepareDocument(); const before = f.controller.getSnapshot(), stored = [...f.values];
      expect(before.storageBlocked).toBe(false); expect(before.rows).toEqual([]); expect(f.controller.hasVisibleOriginal()).toBe(false);
      const node = target(); focusFinancialPolicySavedRequests(f.controller, f.adapters, node, motion);
      expect(node.focus).not.toHaveBeenCalled(); expect(node.scrollIntoView).not.toHaveBeenCalled();
      expect(f.controller.getSnapshot()).toBe(before); expect([...f.values]).toEqual(stored); expect(f.createKey).not.toHaveBeenCalled();
    });
  it.each(['corrupt', 'incompatible'] as const)('leaves %s saved inventory generic with no recovery jump', async mode => {
    const f = await fixture(), ref = await original(f); storeFinancialPolicyReference(f.storage, ref); await f.prepareDocument();
    expect(f.controller.hasVisibleOriginal()).toBe(true);
    const [key, raw] = [...f.values][0]!;
    f.values.set(key, mode === 'corrupt' ? raw + ' ' : JSON.stringify({ ...ref, locator: { ...ref.locator, responsibilityId: 'private_other' } }));
    f.controller.refreshReferences(); const before = f.controller.getSnapshot(), stored = [...f.values];
    expect(before.storageBlocked).toBe(true); expect(before.rows).toEqual([]); expect(f.controller.hasVisibleOriginal()).toBe(false);
    const node = target(); focusFinancialPolicySavedRequests(f.controller, f.adapters, node, motion);
    expect(node.focus).not.toHaveBeenCalled(); expect(node.scrollIntoView).not.toHaveBeenCalled();
    expect([...f.values]).toEqual(stored); expect(f.controller.getSnapshot()).toBe(before); expect(f.storage.removeItem).not.toHaveBeenCalled();
  });
  it('derives guidance only from already displayed rows without scanning storage or changing preparation', async () => {
    const f = await fixture(); await f.prepareDocument(); const ref = await original(f); storeFinancialPolicyReference(f.storage, ref);
    const before = f.controller.getSnapshot(), calls = f.fetcher.mock.calls.length;
    const get = vi.spyOn(f.storage, 'getItem'); get.mockImplementation(() => { throw Error('Presentation must not scan storage'); });
    expect(f.controller.hasVisibleOriginal()).toBe(false); expect(get).not.toHaveBeenCalled(); expect(f.controller.getSnapshot()).toBe(before);
    get.mockRestore(); f.controller.refreshReferences(); expect(f.controller.hasVisibleOriginal()).toBe(true);
    expect(f.fetcher.mock.calls.length).toBe(calls); expect(f.createKey).not.toHaveBeenCalled(); expect(f.storage.removeItem).not.toHaveBeenCalled();
  });
  it.each([
    { mode: 'normal', keyboard: false, prefersReducedMotion: false, behavior: 'smooth' },
    { mode: 'normal', keyboard: true, prefersReducedMotion: false, behavior: 'instant' },
    { mode: 'normal', keyboard: false, prefersReducedMotion: true, behavior: 'instant' },
    { mode: 'reduced', keyboard: false, prefersReducedMotion: false, behavior: 'instant' },
    { mode: 'off', keyboard: false, prefersReducedMotion: false, behavior: 'instant' },
  ] as const)('only focuses and scrolls for $mode / keyboard=$keyboard / OS reduced=$prefersReducedMotion', async options => {
    const f = await fixture(); storeFinancialPolicyReference(f.storage, await original(f)); await f.prepareDocument();
    const before = f.controller.getSnapshot(), stored = [...f.values], calls = f.fetcher.mock.calls.length, tokens = f.token.mock.calls.length, node = target();
    focusFinancialPolicySavedRequests(f.controller, f.adapters, node, options);
    expect(node.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    expect(node.scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: 'start', behavior: options.behavior });
    expect(f.controller.getSnapshot()).toBe(before); expect(before.preparation.state).toBe('reviewable'); expect(before.review).not.toBeNull();
    expect([...f.values]).toEqual(stored); expect(f.fetcher.mock.calls.length).toBe(calls); expect(f.token.mock.calls.length).toBe(tokens);
    expect(f.createKey).not.toHaveBeenCalled(); expect(f.writeInputs).toHaveLength(0); expect(f.storage.removeItem).not.toHaveBeenCalled();
  });
  it.each(['expired', 'hidden', 'scope', 'adapter'] as const)('rejects a previously rendered jump after %s changes', async mode => {
    const f = await fixture(); storeFinancialPolicyReference(f.storage, await original(f)); await f.prepareDocument();
    expect(f.controller.hasVisibleOriginal()).toBe(true);
    if (mode === 'expired') { f.time.wall += 19000; f.time.mono += 19000; }
    if (mode === 'hidden') f.controller.suspend();
    if (mode === 'scope') f.current.value = null;
    if (mode === 'adapter') {
      f.controller.configure({ ...f.adapters, getToken: vi.fn(async () => 'replacement') });
      await f.controller.refresh(); f.controller.startNew('document');
    }
    const before = f.controller.getSnapshot(), stored = [...f.values], calls = f.fetcher.mock.calls.length, node = target();
    focusFinancialPolicySavedRequests(f.controller, f.adapters, node, motion);
    expect(f.controller.hasVisibleOriginal()).toBe(mode === 'adapter'); expect(node.focus).not.toHaveBeenCalled(); expect(node.scrollIntoView).not.toHaveBeenCalled();
    expect(f.controller.getSnapshot()).toBe(before); expect([...f.values]).toEqual(stored); expect(f.fetcher.mock.calls.length).toBe(calls);
    expect(f.createKey).not.toHaveBeenCalled(); expect(f.storage.removeItem).not.toHaveBeenCalled();
  });
  it('does not move focus while an explicit operation owns the action lane', async () => {
    const f = await fixture(); storeFinancialPolicyReference(f.storage, await original(f)); await f.prepareDocument();
    f.controller.reviewDocument(); const token = deferred<string>(); f.token.mockReturnValueOnce(token.promise);
    const pending = f.controller.prepare(), node = target(); expect(f.controller.getSnapshot().busy).toBe(true);
    focusFinancialPolicySavedRequests(f.controller, f.adapters, node, motion);
    expect(node.focus).not.toHaveBeenCalled(); expect(node.scrollIntoView).not.toHaveBeenCalled();
    token.resolve('prepared_token'); await pending; expect(f.writeInputs).toHaveLength(0); expect(f.storage.removeItem).not.toHaveBeenCalled();
  });
});

describe('first verified financial context opens local editing', () => {
  function renderEditor(f: Awaited<ReturnType<typeof fixture>>, view = f.controller.getSnapshot(), owner = f.adapters) {
    return renderToStaticMarkup(createElement(FinancialPolicyAuthoringEditorGate, { controller: f.controller, owner, view,
      children: createElement(FinancialPolicyDocumentEditor, { text: view.buffer.text, disabled: view.busy, reviewed: null, error: null,
        onChange: text => f.controller.edit({ text }), onReview: () => f.controller.reviewDocument() }) }));
  }
  it.each([null, { id: 'mandate_doc', version: 1, kind: 'document' as const }, { id: 'draft_a', version: 1, kind: 'draft' as const }])(
    'keeps cold new/revision entry closed and ignores local edits before financial context: %j', async revision => {
      const f = await fixture(revision), before = f.controller.getSnapshot();
      expect(renderEditor(f)).toBe(''); expect(before.editorOpened).toBe(false);
      f.controller.edit({ text: 'Cold private input', dates: { timeZone: 'UTC', startsLocal: '2026-11-18T15:00', expiresLocal: '2026-11-19T15:00' } });
      expect(f.controller.getSnapshot()).toBe(before); expect(f.token).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled();
      expect(f.createKey).not.toHaveBeenCalled(); expect(f.createTargetId).not.toHaveBeenCalled(); expect(f.values.size).toBe(0);
    });
  it.each(['full', 'references_only'])('opens after an explicit qualified %s financial context without preparing or saving', async visibility => {
    const f = await fixture(); f.context.configurationVisibility = visibility;
    if (visibility === 'references_only') {
      const operations = FinancialPolicyBootstrapSchema.parse({ ...f.bootstrap, roles: ['operations'] });
      f.context.scope.roles = ['operations']; f.adapters.bootstrap = operations; f.current.value = operations;
      f.controller.configure(f.adapters);
    }
    await f.controller.refresh(); const view = f.controller.getSnapshot();
    expect(view.editorOpened).toBe(true); expect(view.context?.configurationVisibility).toBe(visibility);
    expect(renderEditor(f)).toContain('<textarea'); expect(renderEditor(f)).toContain('Review exact text');
    f.controller.edit({ text: 'Entered after verified financial context' }); expect(renderEditor(f)).toContain('Entered after verified financial context');
    expect(f.fetcher).toHaveBeenCalledOnce(); expect(f.fetcher.mock.calls[0]?.[0]).toMatch(/\/financial-policies\/context$/);
    expect(f.selections).toHaveLength(0); expect(f.writeInputs).toHaveLength(0); expect(f.createKey).not.toHaveBeenCalled(); expect(f.values.size).toBe(0);
    expect(f.controller.getSnapshot()).toMatchObject({ review: null, preparation: { preparation: null } });
  });
  it('keeps the editor and review control absent throughout a delayed first context check', async () => {
    const f = await fixture(), entered = deferred<void>(), response = deferred<Response>();
    f.fetcher.mockImplementationOnce(async () => { entered.resolve(); return response.promise; });
    const pending = f.controller.refresh(); await entered.promise;
    expect(f.controller.getSnapshot()).toMatchObject({ busy: true, context: null }); expect(renderEditor(f)).toBe('');
    expect(f.controller.getSnapshot().editorOpened).toBe(false);
    f.controller.edit({ text: 'No cold editing during request' }); expect(f.controller.getSnapshot().buffer.text).toBe('');
    response.resolve(json(f.context)); await pending;
    expect(f.controller.getSnapshot().editorOpened).toBe(true); expect(renderEditor(f)).toContain('<textarea');
    expect(f.fetcher).toHaveBeenCalledOnce(); expect(f.writeInputs).toHaveLength(0);
  });
  it.each(['denied', 'wrong-scope', 'expired'] as const)('never opens on a first %s context response', async mode => {
    const f = await fixture();
    const response = mode === 'denied' ? json({ error: { code: 'FORBIDDEN' } }, 403)
      : mode === 'wrong-scope' ? json({ ...f.context, scope: { ...f.context.scope, organizationEpoch: 3 } })
      : json({ ...f.context, observation: { observedAt: iso(at - 1000), expiresAt: iso(at) } });
    f.fetcher.mockResolvedValueOnce(response); await f.controller.refresh(); const before = f.controller.getSnapshot();
    expect(before.editorOpened).toBe(false); expect(before.context).toBeNull(); expect(renderEditor(f)).toBe('');
    f.controller.edit({ text: 'Rejected cold input' }); expect(f.controller.getSnapshot()).toBe(before);
    expect(f.fetcher).toHaveBeenCalledOnce(); expect(f.selections).toHaveLength(0); expect(f.writeInputs).toHaveLength(0); expect(f.createKey).not.toHaveBeenCalled();
  });
  it('keeps opened local editing visible through a same-owner explicit context refresh', async () => {
    const f = await fixture(); await f.prepareDocument(); f.controller.edit({ text: 'Retained through explicit refresh' });
    const states: string[] = [], unsubscribe = f.controller.subscribe(() => states.push(renderEditor(f)));
    await f.controller.refresh(); unsubscribe();
    expect(states.length).toBeGreaterThan(0); expect(states.every(html => html.includes('Retained through explicit refresh'))).toBe(true);
    expect(f.controller.getSnapshot()).toMatchObject({ editorOpened: true, review: null, preparation: { preparation: null } });
    expect(f.writeInputs).toHaveLength(0);
  });
  it.each(['display', 'preparation-subscription'] as const)('retains opened local edits after later GET expiry via %s', async mode => {
    const f = await fixture(), expiry = preparationExpiryBeforeDisplay(); await f.prepareDocument();
    f.controller.edit({ text: 'Locally retained mandate', dates: { timeZone: 'UTC', startsLocal: '2026-11-18T15:00', expiresLocal: '2026-11-19T15:00' } });
    f.controller.reviewDocument(); await f.controller.prepare(); const before = f.controller.getSnapshot(), expirePreparation = expiry(), calls = f.fetcher.mock.calls.length;
    f.time.wall += 19000; f.time.mono += 19000;
    if (mode === 'display') f.controller.expireDisplay(); else expirePreparation();
    expect(f.controller.getSnapshot()).toMatchObject({ editorOpened: true, phase: 'expired', context: null, exact: null, review: null,
      receipt: null, preparation: { preparation: null }, buffer: before.buffer });
    expect(renderEditor(f)).toContain('Locally retained mandate');
    f.controller.edit({ text: 'Edited locally after expiry' }); expect(renderEditor(f)).toContain('Edited locally after expiry');
    await f.controller.save(); expect(f.fetcher.mock.calls.length).toBe(calls); expect(f.createKey).not.toHaveBeenCalled(); expect(f.values.size).toBe(0);
  });
  it('restores the opened editor with local edits when an awaited preparation discovers expiry', async () => {
    const f = await fixture(); await f.prepareDocument(); f.controller.reviewDocument();
    const token = deferred<string>(); f.token.mockReturnValueOnce(token.promise); const before = f.controller.getSnapshot();
    const pending = f.controller.prepare(); f.time.wall += 19000; f.time.mono += 19000; token.resolve('late_token'); await pending;
    expect(f.controller.getSnapshot()).toMatchObject({ editorOpened: true, phase: 'expired', context: null, review: null,
      preparation: { preparation: null }, buffer: before.buffer });
    expect(renderEditor(f)).toContain('Exact full financial mandate'); expect(f.writeInputs).toHaveLength(0); expect(f.createKey).not.toHaveBeenCalled();
  });
  it('retains the opened editor and valid context after earlier preparation-only expiry', async () => {
    const f = await fixture(), expiry = preparationExpiryBeforeDisplay();
    f.state.prepChange = response => ({ ...response, observation: { observedAt: iso(at - 1000), expiresAt: iso(at + 2000) } });
    await f.prepareDocument(); const before = f.controller.getSnapshot(), expirePreparation = expiry();
    f.time.wall += 2000; f.time.mono += 2000; expirePreparation();
    expect(f.controller.getSnapshot()).toMatchObject({ editorOpened: true, context: before.context, buffer: before.buffer, review: null,
      preparation: { state: 'expired', preparation: null } });
    expect(renderEditor(f)).toContain('<textarea'); f.controller.edit({ text: 'Locally edited after preparation expired' });
    expect(renderEditor(f)).toContain('Locally edited after preparation expired'); expect(f.writeInputs).toHaveLength(0);
  });
  it.each(['hide', 'denial', 'owner', 'adapter', 'close'] as const)('closes editing after %s and preserves the stored original', async mode => {
    const f = await fixture(); await f.prepareDocument(); await f.controller.save();
    const opened = f.controller.getSnapshot(), originals = [...f.values]; expect(renderEditor(f)).toContain('<textarea');
    if (mode === 'hide') { f.controller.suspend(); f.controller.activate(); }
    if (mode === 'denial') { f.fetcher.mockResolvedValueOnce(json({ error: { code: 'FORBIDDEN' } }, 403)); await f.controller.refresh(); }
    if (mode === 'owner') {
      const replacement = { ...f.bootstrap, actorId: 'actor_b' }; f.current.value = replacement;
      f.controller.configure({ ...f.adapters, bootstrap: replacement });
    }
    if (mode === 'adapter') f.controller.configure({ ...f.adapters, getToken: vi.fn(async () => 'replacement') });
    if (mode === 'close') f.controller.close();
    const closed = f.controller.getSnapshot(); expect(closed).toMatchObject({ editorOpened: false, context: null, buffer: { text: '' } });
    expect(renderEditor(f)).toBe(''); expect(renderEditor(f, opened)).toBe('');
    f.controller.edit({ text: 'Old callback input' }); expect(f.controller.getSnapshot()).toBe(closed);
    expect([...f.values]).toEqual(originals); expect(f.storage.removeItem).not.toHaveBeenCalled(); expect(f.writeInputs).toHaveLength(1);
  });
  it('does not open a replacement editor from the departed owner’s delayed first context response', async () => {
    const f = await fixture(), entered = deferred<void>(), response = deferred<Response>();
    f.fetcher.mockImplementationOnce(async () => { entered.resolve(); return response.promise; });
    const pending = f.controller.refresh(); await entered.promise;
    f.controller.configure({ ...f.adapters, getToken: vi.fn(async () => 'replacement') }); const replacement = f.controller.getSnapshot();
    response.resolve(json(f.context)); await pending;
    expect(f.controller.getSnapshot()).toBe(replacement); expect(replacement.editorOpened).toBe(false); expect(renderEditor(f)).toBe('');
    expect(f.fetcher).toHaveBeenCalledOnce(); expect(f.writeInputs).toHaveLength(0); expect(f.values.size).toBe(0);
  });
});
