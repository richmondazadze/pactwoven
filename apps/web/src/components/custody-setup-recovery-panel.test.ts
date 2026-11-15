import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CustodyRecord, CustodyResult } from '@pactwoven/contracts';
import { canonicalJson } from '@pactwoven/contracts/canonical';
import { CustodyLocatorSchema, custodyLookupScope, custodyRecordRef, type CustodyScope } from '../lib/custody-setup-contract';
import { createCustodyMemory, custodyReferenceKey, listCustodyReferences, storeCustodyReference, CUSTODY_REFERENCE_PREFIX } from '../lib/custody-setup-recovery';
import { createCustodyRecoveryPanelController, CustodySetupRecoveryPanel, type CustodyRecoveryPanelAdapters } from './custody-setup-recovery-panel';

// Real custody helpers and transport; synthetic responses/storage and simulated
// React hooks/host commits. These are offline interaction tests, not browser,
// provider, wallet, database or accessibility/device acceptance.
const h = vi.hoisted(() => ({ active: null as any, hidden: false, mode: 'normal' as 'normal' | 'reduced' | 'off', keyboard: false,
  reduced: false, listeners: new Set<() => void>(), events: [] as { kind: string; target: string; options: any }[] }));
vi.mock('react', async original => ({ ...(await original<any>()),
  useRef: (initial: any) => { const f = h.active, i = f.cursor++; return f.cells[i] ?? (f.cells[i] = { current: initial }); },
  useMemo: (factory: any, deps: any[]) => { const f = h.active, i = f.cursor++, old = f.cells[i]; if (!old || deps.some((v, j) => !Object.is(v, old.deps[j]))) f.cells[i] = { deps, value: factory() }; return f.cells[i].value; },
  useLayoutEffect: (callback: any, deps: any[]) => h.active.effect(callback, deps),
  useSyncExternalStore: (subscribe: any, snapshot: any) => { h.active.effect(() => subscribe(() => {}), [subscribe]); return snapshot(); },
}));
vi.mock('./ui', () => ({ Panel: 'Panel', Alert: 'Alert', StatusBadge: 'StatusBadge', ActionLabel: 'ActionLabel' }));
vi.mock('./motion', () => ({ useArrival: () => ({ current: null }), useMotion: () => ({ mode: h.mode, keyboard: { current: h.keyboard } }) }));
const hash = 'a'.repeat(64), uuid = (n: number) => `123e4567-e89b-12d3-a456-${String(n).padStart(12, '0')}`;
const issuedAt = '2026-11-15T12:00:00.000Z', expiresAt = '2026-11-15T12:01:00.000Z';
function storage() { const data = new Map<string, string>(); return { get length() { return data.size; }, key: (index: number) => [...data.keys()][index] ?? null,
  getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } }; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'private, no-store' } });
async function fixture(cancel = false) {
  const scope: CustodyScope = { environment: 'development', apiBase: 'https://api.example.test', userId: 'user_a', externalOrganizationId: 'provider_org', organizationId: 'org_a', responsibilityId: 'responsibility_a',
    owner: { actorId: 'owner_a', subject: 'user_a', externalMembershipId: 'member_a', membershipVersion: 1, sessionId: 'session_a' } };
  const specification = { id: 'spec_a', version: 1, recordHash: hash }, draft = { id: uuid(4), version: 1, recordHash: hash };
  const locator = CustodyLocatorSchema.parse({ schemaVersion: 1, scope: custodyLookupScope(scope), kind: cancel ? 'cancel' : 'prepare',
    key: cancel ? 'cancel_original_001' : 'prepare_original_001', setupId: cancel ? uuid(3) : null, draftIdentity: 'draft_ui_a', requestHash: hash,
    pins: { specification, ownerHash: hash, previousDraft: null, draft: cancel ? draft : null,
      prepareOperation: cancel ? { id: uuid(5), key: 'prepare_original_001', commandHash: hash } : null,
      challenge: null, confirmation: null, walletEvidence: null, signatureHash: null, confirmationKey: null, confirmationIntentHash: null,
      specificationControlGeneration: 0, controlGeneration: cancel ? 1 : 0, expectedCommandHash: hash, expiresAt } });
  const common = { schemaVersion: 1 as const, id: uuid(cancel ? 15 : 4), setupId: uuid(3), version: 1, environment: 'development' as const,
    organizationId: scope.organizationId, responsibilityId: scope.responsibilityId, actorId: scope.owner.actorId, issuedAt, expiresAt };
  const body: CustodyRecord = cancel ? { ...common, kind: 'cancellation', draft, previousControlGeneration: 1, controlGeneration: 2 }
    : { ...common, kind: 'draft', specification, specificationControlGeneration: 0, predecessor: null, prepareOperationId: uuid(5) };
  const result: CustodyResult = { schemaVersion: 1, id: uuid(cancel ? 16 : 5), organizationId: scope.organizationId, actorId: scope.owner.actorId,
    responsibilityId: scope.responsibilityId, kind: locator.kind, key: locator.key, setupId: uuid(3), commandHash: hash,
    target: await custodyRecordRef(body), body, financialState: null };
  const response = (operation: CustodyResult | null = result) => ({ schemaVersion: 1, organizationId: scope.organizationId, actorId: scope.owner.actorId,
    responsibilityId: scope.responsibilityId, kind: locator.kind, key: locator.key, status: operation ? 'recorded' : 'not_recorded', operation });
  const store = storage(), memory = createCustodyMemory(scope), current = { value: scope as CustodyScope | null }, selectedStorage = { value: store as ReturnType<typeof storage> | null };
  storeCustodyReference(store, locator);
  const fetcher = vi.fn(async () => json(response())), getToken = vi.fn(async () => 'test_token');
  const adapters: CustodyRecoveryPanelAdapters = { scope, memory, currentScope: () => current.value, storage: () => selectedStorage.value, getToken, fetch: fetcher };
  const controller = createCustodyRecoveryPanelController(adapters); controller.activate();
  return { scope, locator, result, response, store, memory, current, selectedStorage, fetcher, getToken, adapters, controller, key: custodyReferenceKey(locator) };
}
beforeEach(() => { vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', 'https://api.example.test'); h.hidden = false; h.mode = 'normal'; h.keyboard = false; h.reduced = false; h.events = []; h.listeners.clear();
  vi.stubGlobal('document', { get hidden() { return h.hidden; }, addEventListener: (_: string, cb: () => void) => h.listeners.add(cb), removeEventListener: (_: string, cb: () => void) => h.listeners.delete(cb) });
  vi.stubGlobal('window', { matchMedia: () => ({ matches: h.reduced }) });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('custody recovery panel controller', () => {
  it('lists local references without identity or network calls and exposes no send/signing action', async () => {
    const f = await fixture(); f.controller.refresh();
    expect(f.controller.getSnapshot().rows[0]!.locator).toEqual(f.locator); expect(f.fetcher).not.toHaveBeenCalled(); expect(f.getToken).not.toHaveBeenCalled();
    for (const method of ['send', 'retry', 'sign', 'cancel', 'confirm']) expect(f.controller).not.toHaveProperty(method);
    f.controller.close(); expect(listCustodyReferences(f.store, f.scope).references).toEqual([f.locator]);
  });
  it.each([false, true])('checks a %s cancellation receipt, then separately clears only the reviewed reminder', async cancel => {
    const f = await fixture(cancel), originalStorage = canonicalJson([...Array(f.store.length)].map((_, i) => f.store.getItem(f.store.key(i)!)));
    await f.controller.check(f.key);
    expect(f.controller.getSnapshot().rows[0]).toMatchObject({ state: 'recorded', result: f.result });
    expect(canonicalJson([...Array(f.store.length)].map((_, i) => f.store.getItem(f.store.key(i)!)))).toBe(originalStorage);
    expect(f.fetcher).toHaveBeenCalledTimes(1); const [url, init] = f.fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain(`/custody-setups/operations/${f.locator.key}?kind=${f.locator.kind}`); expect(init).toMatchObject({ method: 'GET', cache: 'no-store', redirect: 'error', credentials: 'omit' }); expect(init.body).toBeUndefined();
    await f.controller.settle(f.key); expect(f.store.length).toBe(0); expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(f.controller.getSnapshot().rows[0]).toMatchObject({ state: 'settled', result: f.result }); f.controller.refresh(); expect(f.controller.getSnapshot().rows).toHaveLength(1);
  });
  it('does not settle an unchecked or missing original', async () => {
    const f = await fixture(); await f.controller.settle(f.key); expect(f.store.length).toBe(1); expect(f.fetcher).not.toHaveBeenCalled();
    f.fetcher.mockResolvedValue(json(f.response(null))); await f.controller.check(f.key); await f.controller.settle(f.key);
    expect(f.controller.getSnapshot().rows[0]).toMatchObject({ state: 'not-recorded', result: null }); expect(f.store.length).toBe(1);
  });
  it('serializes rapid checks and refuses settlement during lookup', async () => {
    const f = await fixture(), token = deferred<string>(); f.getToken.mockReturnValue(token.promise);
    const first = f.controller.check(f.key); await f.controller.check(f.key); await f.controller.settle(f.key);
    expect(f.getToken).toHaveBeenCalledTimes(1); token.resolve('test_token'); await first;
    expect(f.fetcher).toHaveBeenCalledTimes(1); expect(f.store.length).toBe(1); expect(f.controller.getSnapshot().busy).toBe(false);
  });
  it.each(['hidden', 'closed', 'session', 'storage'] as const)('a %s change during token wait prevents dispatch and preserves references', async change => {
    const f = await fixture(), token = deferred<string>(); f.getToken.mockReturnValue(token.promise); const work = f.controller.check(f.key);
    if (change === 'hidden') f.controller.hide(); else if (change === 'closed') f.controller.close();
    else if (change === 'session') f.current.value = { ...f.scope, owner: { ...f.scope.owner, sessionId: 'other_session' } };
    else f.selectedStorage.value = storage();
    token.resolve('test_token'); await work; expect(f.fetcher).not.toHaveBeenCalled(); expect(f.store.length).toBe(1);
    expect(f.controller.getSnapshot().visible).toBe(false);
  });
  it('hide and return invalidate late responses and require a new separate click', async () => {
    const f = await fixture(), response = deferred<Response>(); f.fetcher.mockReturnValue(response.promise);
    const work = f.controller.check(f.key); await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(1));
    f.controller.hide(); f.controller.activate(); response.resolve(json(f.response())); await work;
    expect(f.controller.getSnapshot().rows[0]!.state).toBe('unchecked'); expect(f.controller.getSnapshot().focus).toBeNull(); expect(f.store.length).toBe(1);
    f.fetcher.mockResolvedValue(json(f.response())); await f.controller.check(f.key); expect(f.fetcher).toHaveBeenCalledTimes(2); expect(f.controller.getSnapshot().rows[0]!.state).toBe('recorded');
  });
  it.each(['hidden', 'closed', 'session', 'storage'] as const)('a %s change during settlement hashing prevents local removal', async change => {
    const f = await fixture(); await f.controller.check(f.key);
    const digest = crypto.subtle.digest.bind(crypto.subtle), started = deferred<void>(), gate = deferred<void>();
    vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (...args) => { started.resolve(); await gate.promise; return digest(...args); });
    const work = f.controller.settle(f.key); await started.promise;
    if (change === 'hidden') f.controller.hide(); else if (change === 'closed') f.controller.close();
    else if (change === 'session') f.current.value = { ...f.scope, owner: { ...f.scope.owner, sessionId: 'new_session' } }; else f.selectedStorage.value = storage();
    gate.resolve(); await work; expect(f.store.length).toBe(1); expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it('preserves changed original content rather than clearing a replacement reference', async () => {
    const f = await fixture(); await f.controller.check(f.key);
    const changed = { ...f.locator, requestHash: 'b'.repeat(64) }; f.store.setItem(f.key, canonicalJson(changed));
    await f.controller.settle(f.key); expect(f.store.getItem(f.key)).toBe(canonicalJson(changed)); expect(f.controller.getSnapshot().rows[0]!.state).toBe('recorded');
  });
  it('preserves another original while settling one reviewed receipt', async () => {
    const f = await fixture(), other = { ...f.locator, key: 'another_original_001' }; storeCustodyReference(f.store, other); f.controller.refresh();
    await f.controller.check(f.key); await f.controller.settle(f.key); expect(listCustodyReferences(f.store, f.scope).references).toEqual([other]);
  });
  it('retains a receipt when local removal fails and can finish it without another GET', async () => {
    const f = await fixture(); await f.controller.check(f.key); const remove = f.store.removeItem; f.store.removeItem = () => {};
    await f.controller.settle(f.key); expect(f.controller.getSnapshot().rows[0]).toMatchObject({ state: 'recorded', result: f.result }); expect(f.store.length).toBe(1);
    f.store.removeItem = remove; await f.controller.settle(f.key); expect(f.store.length).toBe(0); expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(['missing', 'malformed', 'foreign', 'no-store', 'error'] as const)('preserves an earlier qualified receipt after a later %s response', async fault => {
    const f = await fixture(); await f.controller.check(f.key);
    const next = fault === 'missing' ? json(f.response(null)) : fault === 'malformed' ? json({}) : fault === 'foreign' ? json({ ...f.response(), organizationId: 'other_org' })
      : fault === 'no-store' ? Response.json(f.response()) : json({ error: { code: 'UNEXPECTED', message: 'private diagnostic must not appear' } }, 503);
    f.fetcher.mockResolvedValue(next); await f.controller.check(f.key);
    expect(f.controller.getSnapshot().rows[0]).toMatchObject({ state: 'recorded', result: f.result }); expect(JSON.stringify(f.controller.getSnapshot())).not.toContain('private diagnostic'); expect(f.store.length).toBe(1);
  });
  it('keeps readable references alongside corruption and reports storage access failures', async () => {
    const f = await fixture(); f.store.setItem(CUSTODY_REFERENCE_PREFIX + 'broken', '{'); f.controller.refresh();
    expect(f.controller.getSnapshot()).toMatchObject({ blocked: true }); expect(f.controller.getSnapshot().rows).toHaveLength(1);
    f.selectedStorage.value = null; await f.controller.check(f.key); expect(f.controller.getSnapshot().rows[0]!.message).toContain('storage'); expect(f.store.length).toBe(2);
  });
  it.each(['AUTH_REQUIRED', 'FORBIDDEN', 'CUSTODY_ACCESS_DENIED'] as const)('%s clears displayed receipts and locks observation until a fresh scope mount', async code => {
    const f = await fixture(); await f.controller.check(f.key);
    f.fetcher.mockResolvedValue(json({ error: { code, message: 'untrusted details' } }, 403));
    await f.controller.check(f.key); expect(f.controller.getSnapshot()).toMatchObject({ visible: false, denied: true, rows: [] });
    f.controller.hide(); f.controller.activate(); await f.controller.check(f.key); expect(f.fetcher).toHaveBeenCalledTimes(2); expect(f.store.length).toBe(1);
    expect(JSON.stringify(f.controller.getSnapshot())).not.toContain('untrusted details');
  });
  it.each([
    ['token', false], ['fetch', false], ['body', false],
    ['token', true], ['fetch', true], ['body', true],
  ] as const)('%s deadline preserves the active owner view, prior receipt=%s, and an explicit later check', async (phase, prior) => {
    const f = await fixture(); if (prior) await f.controller.check(f.key);
    const token = deferred<string>(), fetched = deferred<Response>(), canceled = vi.fn();
    if (phase === 'token') f.getToken.mockReturnValueOnce(token.promise);
    if (phase === 'fetch') f.fetcher.mockReturnValueOnce(fetched.promise);
    if (phase === 'body') f.fetcher.mockResolvedValueOnce(new Response(new ReadableStream({ cancel: canceled }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }));
    vi.useFakeTimers();
    const pending = f.controller.check(f.key); await vi.advanceTimersByTimeAsync(10000); await pending;
    const row = f.controller.getSnapshot().rows[0]!;
    expect(f.controller.getSnapshot()).toMatchObject({ visible: true, denied: false, busy: false });
    expect(row).toMatchObject({ state: prior ? 'recorded' : 'unconfirmed', result: prior ? f.result : null });
    expect(f.store.length).toBe(1); const calls = (prior ? 1 : 0) + (phase === 'token' ? 0 : 1); expect(f.fetcher).toHaveBeenCalledTimes(calls);
    if (phase === 'body') expect(canceled).toHaveBeenCalledOnce();
    token.resolve('test_token'); fetched.resolve(json(f.response())); await vi.advanceTimersByTimeAsync(0);
    expect(f.fetcher).toHaveBeenCalledTimes(calls); expect(f.controller.getSnapshot().rows[0]).toEqual(row);
    f.fetcher.mockResolvedValue(json(f.response())); await f.controller.check(f.key);
    expect(f.fetcher).toHaveBeenCalledTimes(calls + 1); expect(f.controller.getSnapshot().rows[0]!.state).toBe('recorded'); expect(f.store.length).toBe(1);
  });
  it('a local refresh after losing current scope clears the prior private view', async () => {
    const f = await fixture(); await f.controller.check(f.key); f.current.value = null;
    f.controller.refresh(); expect(f.controller.getSnapshot()).toMatchObject({ visible: false, rows: [] }); expect(f.store.length).toBe(1);
  });
});

function nodes(node: any): any[] { if (node == null || typeof node !== 'object') return []; if (Array.isArray(node)) return node.flatMap(nodes); return [node, ...nodes(node.props?.action), ...nodes(node.props?.children)]; }
function text(node: any): string { if (node == null || typeof node === 'boolean') return ''; if (typeof node === 'string' || typeof node === 'number') return String(node); if (Array.isArray(node)) return node.map(text).join(' '); return `${node.props?.title ?? ''} ${node.props?.label ?? ''} ${text(node.props?.children)}`.replace(/\s+/g, ' ').trim(); }
class Hooks {
  cells: any[] = []; effects: any[] = []; queued: (() => void)[] = []; cursor = 0; tree: any; refs: any[] = [];
  constructor(public component: () => any) {}
  effect(callback: any, deps: any[]) { const i = this.cursor++, old = this.effects[i]; if (!old || deps.some((v, j) => !Object.is(v, old.deps[j]))) this.queued.push(() => { old?.cleanup?.(); this.effects[i] = { deps, callback, cleanup: callback() }; }); }
  render() { for (const ref of this.refs) if (typeof ref === 'function') ref(null); else ref.current = null; this.refs = []; this.cursor = 0; h.active = this; this.tree = this.component();
    for (const node of nodes(this.tree)) { const ref = node.props?.ref; if (!ref) continue; const target = { focus: (options: any) => h.events.push({ kind: 'focus', target: text(node), options }), scrollIntoView: (options: any) => h.events.push({ kind: 'scroll', target: text(node), options }) };
      if (typeof ref === 'function') ref(target); else ref.current = target; this.refs.push(ref); }
    for (const effect of this.queued.splice(0)) effect(); return this.tree;
  }
  replayEffects() { for (const effect of this.effects) if (effect) { effect.cleanup?.(); effect.cleanup = effect.callback(); } }
  unmount() { for (const effect of this.effects) effect?.cleanup?.(); for (const ref of this.refs) if (typeof ref === 'function') ref(null); else ref.current = null; }
}
let view: Hooks | undefined, props: CustodyRecoveryPanelAdapters;
function render() { return view!.render(); }
function button(label: string) { return nodes(view!.tree).find(node => node.type === 'button' && text(node) === label); }
function click(label: string) { const node = button(label); expect(node, label).toBeDefined(); expect(node.props.disabled).not.toBe(true); node.props.onClick(); }
async function eventually(check: () => void) { await vi.waitFor(() => { render(); check(); }, { interval: 5, timeout: 2500 }); }
async function nativeFixture(cancel = false) { const f = await fixture(cancel); props = f.adapters; view = new Hooks(() => CustodySetupRecoveryPanel(props)); render(); render(); return f; }
afterEach(() => { view?.unmount(); view = undefined; });

describe('native custody recovery panel interactions', () => {
  it.each(['normal', 'reduced', 'off', 'keyboard', 'os-reduced'] as const)('requires separate lookup and settlement with immediate receipt focus in %s', async mode => {
    if (mode === 'keyboard') h.keyboard = true; else if (mode === 'os-reduced') h.reduced = true; else h.mode = mode;
    const f = await nativeFixture(); expect(h.events).toEqual([]); expect(f.fetcher).not.toHaveBeenCalled();
    click('Check original result'); await eventually(() => expect(button('Reviewed — clear local reminder')).toBeDefined());
    expect(f.store.length).toBe(1); expect(h.events.map(event => event.kind)).toEqual(['focus', 'scroll']);
    expect(h.events[0]!.options).toEqual({ preventScroll: true }); expect(h.events[1]!.options.behavior).toBe(mode === 'normal' ? 'smooth' : 'instant');
    expect(h.events[0]!.target).toContain('Draft preparation recorded'); h.events = [];
    click('Reviewed — clear local reminder'); await eventually(() => expect(text(view!.tree)).toContain('Local reminder cleared'));
    expect(f.store.length).toBe(0); expect(f.fetcher).toHaveBeenCalledTimes(1); expect(h.events.map(event => event.kind)).toEqual(['focus', 'scroll']);
    expect(nodes(view!.tree).filter(node => node.type === 'button').map(text)).toEqual(['Refresh saved references']);
  });
  it('shows cancellation as historical without claiming a binding or transaction was undone', async () => {
    const f = await nativeFixture(true); click('Check original result'); await eventually(() => expect(button('Reviewed — clear local reminder')).toBeDefined());
    expect(text(view!.tree)).toContain('Any earlier owner binding remains recorded.'); expect(text(view!.tree)).toContain('does not withdraw a signed or unknown transaction'); expect(f.store.length).toBe(1);
  });
  it('does not replay focus or lookup on motion preference changes and local refresh', async () => {
    const f = await nativeFixture(); click('Check original result'); await eventually(() => expect(button('Reviewed — clear local reminder')).toBeDefined()); h.events = [];
    h.mode = 'off'; render(); h.mode = 'normal'; render(); click('Refresh saved references'); render(); expect(h.events).toEqual([]); expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it('hides private records during page hiding and never revives canceled lookup after return', async () => {
    const f = await nativeFixture(), token = deferred<string>(); f.getToken.mockReturnValue(token.promise); click('Check original result');
    h.hidden = true; for (const listener of h.listeners) listener(); render(); expect(view!.tree).toBeNull();
    h.hidden = false; for (const listener of h.listeners) listener(); render(); token.resolve('test_token');
    await eventually(() => expect(button('Check original result')?.props.disabled).toBe(false)); expect(f.fetcher).not.toHaveBeenCalled(); expect(h.events).toEqual([]); expect(f.store.length).toBe(1);
  });
  it('scope replacement and return revoke old async work and show only the permitted references', async () => {
    const f = await nativeFixture(), token = deferred<string>(); f.getToken.mockReturnValue(token.promise); click('Check original result');
    const nextScope = { ...f.scope, owner: { ...f.scope.owner, sessionId: 'session_b' } }; f.current.value = nextScope; props = { ...props, scope: nextScope, memory: createCustodyMemory(nextScope) }; render(); render();
    f.current.value = f.scope; props = f.adapters; render(); render(); token.resolve('test_token');
    await eventually(() => expect(button('Check original result')?.props.disabled).toBe(false)); expect(f.fetcher).not.toHaveBeenCalled(); expect(h.events).toEqual([]); expect(f.store.length).toBe(1);
  });
  it('in-place caller scope mutation cannot finish or display the former receipt', async () => {
    const f = await nativeFixture(), response = deferred<Response>(); f.fetcher.mockReturnValue(response.promise); click('Check original result');
    await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(1)); props.scope.owner.sessionId = 'changed_session'; response.resolve(json(f.response()));
    await eventually(() => expect(view!.tree).toBeNull()); expect(f.store.length).toBe(1); expect(h.events).toEqual([]);
  });
  it('adapter callback replacement does not clear a denial for the same authenticated scope', async () => {
    const f = await nativeFixture(); f.fetcher.mockResolvedValue(json({ error: { code: 'FORBIDDEN' } }, 403));
    click('Check original result'); await eventually(() => expect(text(view!.tree)).toContain('Current owner access is required'));
    props = { ...props, getToken: async () => f.getToken(), currentScope: () => f.scope };
    render(); render(); expect(text(view!.tree)).toContain('Current owner access is required'); expect(button('Check original result')).toBeUndefined(); expect(f.fetcher).toHaveBeenCalledTimes(1); expect(f.store.length).toBe(1);
  });
  it('effect replay remains usable without duplicated lookup, listeners or receipt focus', async () => {
    const f = await nativeFixture(); view!.replayEffects(); render(); expect(h.listeners.size).toBe(1); expect(f.fetcher).not.toHaveBeenCalled();
    click('Check original result'); await eventually(() => expect(button('Reviewed — clear local reminder')).toBeDefined()); expect(f.fetcher).toHaveBeenCalledTimes(1); expect(h.events.map(event => event.kind)).toEqual(['focus', 'scroll']);
  });
  it('unmount cancels observation without removing references or retaining listeners', async () => {
    const f = await nativeFixture(), token = deferred<string>(); f.getToken.mockReturnValue(token.promise); click('Check original result'); view!.unmount(); view = undefined; token.resolve('test_token');
    await new Promise(resolve => setTimeout(resolve, 0)); expect(f.fetcher).not.toHaveBeenCalled(); expect(h.listeners.size).toBe(0); expect(f.store.length).toBe(1); expect(h.events).toEqual([]);
  });
});
