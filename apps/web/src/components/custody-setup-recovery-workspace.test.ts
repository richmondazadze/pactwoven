import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CustodyApiRecoveryContext, CustodyRecord, CustodyResult, Responsibility, Session } from '@pactwoven/contracts';
import { createCustodyRecoveryBootstrap } from '../lib/custody-setup-context';
import { CustodyLocatorSchema, custodyLookupScope, custodyRecordRef } from '../lib/custody-setup-contract';
import { custodyReferenceKey, storeCustodyReference } from '../lib/custody-setup-recovery';
import { createCustodyRecoveryPanelController, CustodySetupRecoveryPanel } from './custody-setup-recovery-panel';
import { createCustodyRecoveryWorkspaceController, CustodyRecoveryWorkspaceView, CustodySetupRecoveryWorkspace,
  type CustodyRecoveryWorkspaceAdapters } from './custody-setup-recovery-workspace';

const h = vi.hoisted(() => ({ active: null as any, hidden: false, mode: 'normal', keyboard: false, reduced: false,
  listeners: new Set<() => void>(), events: [] as { kind: string; options: any }[], workspace: null as any, auth: null as any, query: null as any, client: null as any }));
vi.mock('react', async original => ({ ...(await original<any>()),
  useRef: (value: any) => { const f = h.active, i = f.cursor++; return f.cells[i] ?? (f.cells[i] = { current: value }); },
  useMemo: (factory: any, deps: any[]) => { const f = h.active, i = f.cursor++, old = f.cells[i]; if (!old || deps.some((v, j) => !Object.is(v, old.deps[j]))) f.cells[i] = { deps, value: factory() }; return f.cells[i].value; },
  useCallback: (callback: any, deps: any[]) => { const f = h.active, i = f.cursor++, old = f.cells[i]; if (!old || deps.some((v, j) => !Object.is(v, old.deps[j]))) f.cells[i] = { deps, value: callback }; return f.cells[i].value; },
  useLayoutEffect: (callback: any, deps: any[]) => h.active.effect(callback, deps),
  useSyncExternalStore: (subscribe: any, snapshot: any) => { h.active.effect(() => subscribe(() => {}), [subscribe]); return snapshot(); },
}));
vi.mock('@clerk/nextjs', () => ({ useAuth: () => h.auth }));
vi.mock('@tanstack/react-query', () => ({ useQuery: () => h.query, useQueryClient: () => h.client }));
vi.mock('./workspace-provider', () => ({ useWorkspace: () => h.workspace }));
vi.mock('./ui', () => ({ ActionLabel: 'ActionLabel', Alert: 'Alert', ButtonLink: 'ButtonLink', LoadingState: 'LoadingState', PageHeading: 'PageHeading', Panel: 'Panel', StatusBadge: 'StatusBadge' }));
vi.mock('./motion', () => ({ useArrival: () => ({ current: null }), useMotion: () => ({ mode: h.mode, keyboard: { current: h.keyboard } }) }));

const at = Date.parse('2026-11-15T16:00:00.000Z'), iso = (n: number) => new Date(n).toISOString(), base = 'https://api.example.test';
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'private, no-store' } });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function storage() { const data = new Map<string, string>(); return { get length() { return data.size; }, key: (i: number) => [...data.keys()][i] ?? null,
  getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } }; }
const controllers: ReturnType<typeof createCustodyRecoveryWorkspaceController>[] = [];
function fixture() {
  const session: Session = { actor: { actorId: 'owner_a', principalKind: 'human', organizationId: 'org_a', environment: 'development', roles: ['owner'],
    siteIds: ['site_a'], actionSiteIds: ['site_a'], sessionId: 'session_a', authenticatedAt: iso(at - 60000), correlationId: 'fixture_trace' },
    organization: { id: 'org_a', name: 'Synthetic', authorityEpoch: 2 }, sites: [{ id: 'site_a', name: 'Site', timeZone: 'UTC' }] };
  const auth = { isLoaded: true, isSignedIn: true, userId: 'user_a', orgId: 'provider_org', sessionId: 'session_a', getToken: vi.fn(async (_options?: unknown) => 'fixture_token') };
  const record: Responsibility = { id: 'responsibility_a', organizationId: 'org_a', ownerId: 'owner_a', environment: 'development', version: 1,
    executionState: 'DRAFT', authorityState: null, coverageState: 'UNKNOWN', title: 'Synthetic responsibility', description: '', siteId: 'site_a',
    window: { startsAt: iso(at), endsAt: iso(at + 3600000), timeZone: 'UTC' }, requirements: [], acceptancePolicy: '', createdAt: iso(at - 1000), updatedAt: iso(at - 1000) };
  const bootstrap = createCustodyRecoveryBootstrap(session, auth, base, record, record.id);
  const context: CustodyApiRecoveryContext = { schemaVersion: 1, environment: 'development', organizationId: 'org_a', externalOrganizationId: 'provider_org',
    responsibilityId: record.id, owner: { actorId: 'owner_a', membershipVersion: 3, externalMembershipId: 'member_a', subject: 'user_a', sessionId: 'session_a' },
    observedAt: iso(at - 1000), expiresAt: iso(at + 19000) };
  const store = storage(), selected = { value: bootstrap as typeof bootstrap | null }, clock = { wall: at, mono: 100 }, onDenied = vi.fn();
  const fetcher = vi.fn(async (_url: string, _init: RequestInit) => json(context));
  const adapters: CustodyRecoveryWorkspaceAdapters = { bootstrap, currentBootstrap: () => selected.value, storage: () => store,
    getToken: auth.getToken, fetch: fetcher, wallTime: () => clock.wall, monotonic: () => clock.mono, onDenied };
  const controller = createCustodyRecoveryWorkspaceController(adapters); controllers.push(controller); controller.activate();
  return { session, auth, record, bootstrap, context, store, selected, clock, fetcher, adapters, controller, onDenied };
}
async function savedOriginal(f: ReturnType<typeof fixture>) {
  const uuid = (n: number) => `123e4567-e89b-12d3-a456-${String(n).padStart(12, '0')}`, hash = 'a'.repeat(64);
  const scope = { environment: 'development' as const, apiBase: base, userId: 'user_a', externalOrganizationId: 'provider_org', organizationId: 'org_a', responsibilityId: f.record.id, owner: f.context.owner };
  const specification = { id: 'spec_a', version: 1, recordHash: hash };
  const locator = CustodyLocatorSchema.parse({ schemaVersion: 1, scope: custodyLookupScope(scope), kind: 'prepare', key: 'prepare_original_001', setupId: null,
    draftIdentity: 'draft_a', requestHash: hash, pins: { specification, ownerHash: hash, previousDraft: null, draft: null, prepareOperation: null,
      challenge: null, confirmation: null, walletEvidence: null, signatureHash: null, confirmationKey: null, confirmationIntentHash: null,
      specificationControlGeneration: 0, controlGeneration: 0, expectedCommandHash: hash, expiresAt: iso(at + 60000) } });
  const body: CustodyRecord = { schemaVersion: 1, id: uuid(4), setupId: uuid(3), version: 1, environment: 'development', organizationId: 'org_a', responsibilityId: f.record.id,
    actorId: 'owner_a', issuedAt: iso(at), expiresAt: iso(at + 60000), kind: 'draft', specification, specificationControlGeneration: 0, predecessor: null, prepareOperationId: uuid(5) };
  const operation: CustodyResult = { schemaVersion: 1, id: uuid(5), organizationId: 'org_a', actorId: 'owner_a', responsibilityId: f.record.id, kind: 'prepare',
    key: locator.key, setupId: uuid(3), commandHash: hash, target: await custodyRecordRef(body), body, financialState: null };
  storeCustodyReference(f.store, locator);
  return { locator, operation, key: custodyReferenceKey(locator), response: { schemaVersion: 1, organizationId: 'org_a', actorId: 'owner_a', responsibilityId: f.record.id,
    kind: 'prepare', key: locator.key, status: 'recorded', operation } };
}
const globalFetch = vi.fn(() => { throw new Error('Unexpected real fetch'); });
beforeEach(() => { vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', base); globalFetch.mockClear(); vi.stubGlobal('fetch', globalFetch);
  h.hidden = false; h.mode = 'normal'; h.keyboard = false; h.reduced = false; h.events = []; h.listeners.clear();
  h.client = { invalidateQueries: vi.fn(async () => {}) };
  vi.stubGlobal('document', { get hidden() { return h.hidden; }, addEventListener: (_: string, fn: () => void) => h.listeners.add(fn), removeEventListener: (_: string, fn: () => void) => h.listeners.delete(fn) });
  vi.stubGlobal('window', { matchMedia: () => ({ matches: h.reduced }) });
});
afterEach(() => { for (const controller of controllers.splice(0)) controller.close(); expect(globalFetch).not.toHaveBeenCalled(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('route-local custody recovery controller', () => {
  it('requires separate current-context, original lookup and local settlement actions', async () => {
    const f = fixture(), original = await savedOriginal(f); expect(f.fetcher).not.toHaveBeenCalled(); expect(f.controller.getSnapshot().panel).toBeNull();
    await f.controller.refresh(); expect(f.fetcher).toHaveBeenCalledOnce(); const panel = createCustodyRecoveryPanelController(f.controller.getSnapshot().panel!); panel.activate();
    expect(f.fetcher).toHaveBeenCalledOnce(); expect(panel.getSnapshot().rows).toHaveLength(1);
    f.fetcher.mockResolvedValueOnce(json(original.response)); await panel.check(original.key); expect(f.fetcher).toHaveBeenCalledTimes(2); expect(f.store.length).toBe(1);
    await panel.settle(original.key); expect(f.store.length).toBe(0); expect(f.fetcher).toHaveBeenCalledTimes(2); panel.close();
  });
  it('expiry closes private memory and preserves the original without background renewal', async () => {
    const f = fixture(), original = await savedOriginal(f); vi.useFakeTimers(); await f.controller.refresh(); const memory = f.controller.getSnapshot().panel!.memory;
    f.clock.wall += 19000; f.clock.mono += 19000; await vi.advanceTimersByTimeAsync(19000);
    expect(f.controller.getSnapshot()).toMatchObject({ phase: 'expired', panel: null }); expect(f.controller.currentScope()).toBeNull();
    expect(() => memory.original(original.locator)).toThrow(); expect(f.store.length).toBe(1); expect(f.fetcher).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60000); expect(f.fetcher).toHaveBeenCalledOnce();
  });
  it.each(['hide', 'close', 'session', 'epoch', 'record', 'origin'])('a %s departure cancels context work and preserves references', async change => {
    const f = fixture(), original = await savedOriginal(f), token = deferred<string>(); f.auth.getToken.mockReturnValueOnce(token.promise);
    const pending = f.controller.refresh();
    if (change === 'hide') f.controller.suspend(); if (change === 'close') f.controller.close();
    if (change === 'session') f.selected.value = { ...f.bootstrap, sessionId: 'other' };
    if (change === 'epoch') f.selected.value = { ...f.bootstrap, organizationEpoch: 3 };
    if (change === 'record') f.selected.value = { ...f.bootstrap, responsibilityVersion: 2 };
    if (change === 'origin') vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', 'https://other.example.test');
    token.resolve('fixture_token'); await pending; expect(f.fetcher).not.toHaveBeenCalled(); expect(f.controller.getSnapshot().panel).toBeNull(); expect(f.store.getItem(original.key)).not.toBeNull(); expect(f.onDenied).not.toHaveBeenCalled();
  });
  it('hide and return never revive an old response or issue a context check', async () => {
    const f = fixture(), response = deferred<Response>(); f.fetcher.mockReturnValueOnce(response.promise); const pending = f.controller.refresh();
    await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledOnce()); f.controller.suspend(); f.controller.activate(); response.resolve(json(f.context)); await pending;
    expect(f.controller.getSnapshot()).toMatchObject({ phase: 'idle', panel: null }); expect(f.fetcher).toHaveBeenCalledOnce();
    await f.controller.refresh(); expect(f.fetcher).toHaveBeenCalledTimes(2); expect(f.controller.getSnapshot().phase).toBe('ready');
  });
  it('serializes repeated access clicks', async () => {
    const f = fixture(), token = deferred<string>(); f.auth.getToken.mockReturnValueOnce(token.promise); const pending = f.controller.refresh(); await f.controller.refresh();
    expect(f.auth.getToken).toHaveBeenCalledOnce(); token.resolve('fixture_token'); await pending; expect(f.fetcher).toHaveBeenCalledOnce();
  });
  it('unconfigured and timed-out contexts remain explicit checks rather than access denials', async () => {
    const f = fixture(); f.fetcher.mockResolvedValueOnce(json({ error: { code: 'SETUP_REQUIRED', message: 'private diagnostics' } }, 503));
    await f.controller.refresh(); expect(f.controller.getSnapshot()).toMatchObject({ phase: 'unavailable', panel: null }); expect(f.controller.getSnapshot().message).not.toContain('private diagnostics');
    vi.useFakeTimers(); f.auth.getToken.mockReturnValueOnce(new Promise(() => {})); const pending = f.controller.refresh(); await vi.advanceTimersByTimeAsync(10001); await pending;
    expect(f.controller.getSnapshot()).toMatchObject({ phase: 'unavailable', panel: null }); expect(f.fetcher).toHaveBeenCalledOnce();
    await f.controller.refresh(); expect(f.controller.getSnapshot().phase).toBe('ready'); expect(f.onDenied).not.toHaveBeenCalled();
  });
  it('genuine denied context remains denied after hide/return', async () => {
    const f = fixture(); f.fetcher.mockResolvedValueOnce(json({ error: { code: 'FORBIDDEN' } }, 403)); await f.controller.refresh();
    f.controller.suspend(); f.controller.activate(); await f.controller.refresh(); expect(f.controller.getSnapshot()).toMatchObject({ phase: 'denied', panel: null }); expect(f.fetcher).toHaveBeenCalledOnce(); expect(f.onDenied).toHaveBeenCalledOnce();
  });
  it('a scope change during accepted panel lookup prevents old receipt display and settlement', async () => {
    const f = fixture(), original = await savedOriginal(f); await f.controller.refresh(); const panel = createCustodyRecoveryPanelController(f.controller.getSnapshot().panel!); panel.activate();
    const token = deferred<string>(); f.auth.getToken.mockReturnValueOnce(token.promise); const pending = panel.check(original.key); f.selected.value = null; token.resolve('fixture_token'); await pending;
    expect(panel.getSnapshot()).toMatchObject({ visible: false, rows: [] }); expect(f.fetcher).toHaveBeenCalledOnce(); expect(f.store.length).toBe(1); panel.close();
  });
});

function nodes(node: any): any[] { if (node == null || typeof node !== 'object') return []; if (Array.isArray(node)) return node.flatMap(nodes); return [node, ...nodes(node.props?.action), ...nodes(node.props?.children)]; }
function text(node: any): string { if (node == null || typeof node === 'boolean') return ''; if (typeof node === 'string' || typeof node === 'number') return String(node); if (Array.isArray(node)) return node.map(text).join(' '); return `${node.props?.title ?? ''} ${node.props?.label ?? ''} ${text(node.props?.children)}`.replace(/\s+/g, ' ').trim(); }
class Hooks {
  cells: any[] = []; effects: any[] = []; queued: (() => void)[] = []; cursor = 0; tree: any; refs: any[] = [];
  constructor(public component: () => any) {}
  effect(callback: any, deps: any[]) { const i = this.cursor++, old = this.effects[i]; if (!old || deps.some((v, j) => !Object.is(v, old.deps[j]))) this.queued.push(() => { old?.cleanup?.(); this.effects[i] = { deps, callback, cleanup: callback() }; }); }
  render() { for (const ref of this.refs) if (typeof ref === 'function') ref(null); else ref.current = null; this.refs = []; this.cursor = 0; h.active = this; this.tree = this.component();
    for (const node of nodes(this.tree)) { const ref = node.props?.ref; if (!ref) continue; const value = { focus: (options: any) => h.events.push({ kind: 'focus', options }), scrollIntoView: (options: any) => h.events.push({ kind: 'scroll', options }) };
      if (typeof ref === 'function') ref(value); else ref.current = value; this.refs.push(ref); }
    for (const effect of this.queued.splice(0)) effect(); return this.tree;
  }
  replay() { for (const effect of this.effects) if (effect) { effect.cleanup?.(); effect.cleanup = effect.callback(); } }
  unmount() { for (const effect of this.effects) effect?.cleanup?.(); }
}
let view: Hooks | undefined;
afterEach(() => { view?.unmount(); view = undefined; });
const button = () => nodes(view!.tree).find(node => node.type === 'button' && text(node).includes('owner access'));
async function eventually(check: () => void) { await vi.waitFor(() => { view!.render(); check(); }, { interval: 5, timeout: 2000 }); }
describe('native recovery workspace mount with simulated hooks', () => {
  it.each(['normal', 'reduced', 'off', 'keyboard', 'os-reduced'])('focuses only an explicit context result in %s mode', async mode => {
    const f = fixture(); h.mode = ['normal', 'reduced', 'off'].includes(mode) ? mode : 'normal'; h.keyboard = mode === 'keyboard'; h.reduced = mode === 'os-reduced';
    view = new Hooks(() => CustodyRecoveryWorkspaceView(f.adapters)); view.render(); view.render(); expect(f.fetcher).not.toHaveBeenCalled(); expect(h.events).toEqual([]);
    button().props.onClick(); await eventually(() => expect(nodes(view!.tree).some(node => node.type === CustodySetupRecoveryPanel)).toBe(true));
    expect(h.events.map(x => x.kind)).toEqual(['focus', 'scroll']); expect(h.events[1]!.options.behavior).toBe(mode === 'normal' ? 'smooth' : 'instant');
    const panel = nodes(view.tree).find(node => node.type === CustodySetupRecoveryPanel); h.events = []; h.mode = 'off'; view.render();
    expect(nodes(view.tree).find(node => node.type === CustodySetupRecoveryPanel).props.memory).toBe(panel.props.memory); expect(h.events).toEqual([]); expect(f.fetcher).toHaveBeenCalledOnce();
  });
  it('effect replay is usable and does not fetch, renew or retain duplicate listeners', async () => {
    const f = fixture(); view = new Hooks(() => CustodyRecoveryWorkspaceView(f.adapters)); view.render(); view.render(); view.replay(); view.render();
    expect(h.listeners.size).toBe(1); expect(f.fetcher).not.toHaveBeenCalled(); button().props.onClick(); await eventually(() => expect(text(view!.tree)).toContain('Owner access checked.'));
    expect(f.fetcher).toHaveBeenCalledOnce();
  });
  it('expiry preserves focus and hides the panel without another read', async () => {
    const f = fixture(); view = new Hooks(() => CustodyRecoveryWorkspaceView(f.adapters)); view.render(); view.render(); button().props.onClick();
    await eventually(() => expect(nodes(view!.tree).some(node => node.type === CustodySetupRecoveryPanel)).toBe(true)); h.events = [];
    f.clock.wall += 19000; f.clock.mono += 19000; view.render(); expect(nodes(view.tree).some(node => node.type === CustodySetupRecoveryPanel)).toBe(false);
    expect(text(view.tree)).toContain('observation ended'); expect(h.events).toEqual([]); expect(f.fetcher).toHaveBeenCalledOnce();
  });
  it('page return requires an explicit new context check and old work cannot complete', async () => {
    const f = fixture(), token = deferred<string>(); f.auth.getToken.mockReturnValueOnce(token.promise); view = new Hooks(() => CustodyRecoveryWorkspaceView(f.adapters)); view.render(); view.render(); button().props.onClick();
    h.hidden = true; for (const fn of h.listeners) fn(); view.render(); expect(view.tree).toBeNull();
    h.hidden = false; for (const fn of h.listeners) fn(); view.render(); token.resolve('fixture_token'); await eventually(() => expect(button().props.disabled).toBe(false));
    expect(f.fetcher).not.toHaveBeenCalled(); expect(h.events).toEqual([]);
  });
  it('keeps a genuine denial visible through adapter replacement and effect replay', async () => {
    const f = fixture(); let props = f.adapters; f.fetcher.mockResolvedValueOnce(json({ error: { code: 'FORBIDDEN' } }, 403));
    view = new Hooks(() => CustodyRecoveryWorkspaceView(props)); view.render(); view.render(); button().props.onClick();
    await eventually(() => expect(text(view!.tree)).toContain('Current owner access could not be verified.'));
    props = { ...props, fetch: async (url, init) => f.fetcher(url, init) }; view.render(); view.render(); view.replay(); view.render();
    expect(text(view.tree)).toContain('Current owner access could not be verified.'); expect(button()).toBeUndefined();
    expect(nodes(view.tree).some(node => node.type === CustodySetupRecoveryPanel)).toBe(false); expect(f.fetcher).toHaveBeenCalledOnce();
  });
  it.each(['fetch', 'getToken', 'storage', 'currentBootstrap', 'wallTime', 'monotonic', 'onDenied'])(
    'latches denial before render when the %s adapter is replaced', async adapter => {
      const f = fixture(); let props = f.adapters; f.fetcher.mockResolvedValueOnce(json({ error: { code: 'FORBIDDEN' } }, 403));
      view = new Hooks(() => CustodyRecoveryWorkspaceView(props)); view.render(); view.render(); button().props.onClick();
      // The denial and authorization-refresh callback have completed. Do not
      // render that controller's denied snapshot before replacing its adapter.
      await vi.waitFor(() => expect(f.onDenied).toHaveBeenCalledOnce());
      const replacements = { fetch: async (url: string, init: RequestInit) => f.fetcher(url, init),
        getToken: async (options: { organizationId: string; skipCache: true }) => f.auth.getToken(options),
        storage: () => f.store, currentBootstrap: () => f.selected.value, wallTime: () => f.clock.wall,
        monotonic: () => f.clock.mono, onDenied: () => f.onDenied() };
      props = { ...props, [adapter]: replacements[adapter as keyof typeof replacements] }; view.render(); view.render(); view.replay(); view.render();
      expect(text(view.tree)).toContain('Current owner access could not be verified.'); expect(button()).toBeUndefined();
      expect(nodes(view.tree).some(node => node.type === CustodySetupRecoveryPanel)).toBe(false);
      h.hidden = true; for (const fn of h.listeners) fn(); view.render(); expect(view.tree).toBeNull();
      h.hidden = false; for (const fn of h.listeners) fn(); view.render();
      expect(text(view.tree)).toContain('Current owner access could not be verified.'); expect(button()).toBeUndefined();
      expect(f.fetcher).toHaveBeenCalledOnce(); expect(f.onDenied).toHaveBeenCalledOnce();
    });
  it('latches denial before the forwarded authorization callback can synchronously replace an adapter', async () => {
    const f = fixture(); let props = f.adapters, duringCallback = ''; let actionDuringCallback = true;
    f.fetcher.mockResolvedValueOnce(json({ error: { code: 'FORBIDDEN' } }, 403));
    f.onDenied.mockImplementation(() => {
      props = { ...props, fetch: async (url, init) => f.fetcher(url, init) }; view!.render(); view!.render();
      duringCallback = text(view!.tree); actionDuringCallback = Boolean(button());
    });
    view = new Hooks(() => CustodyRecoveryWorkspaceView(props)); view.render(); view.render(); button().props.onClick();
    await vi.waitFor(() => expect(f.onDenied).toHaveBeenCalledOnce());
    expect(duringCallback).toContain('Current owner access could not be verified.'); expect(actionDuringCallback).toBe(false);
    expect(f.fetcher).toHaveBeenCalledOnce();
  });
  it('retains denial when the forwarded authorization refresh throws before rendering', async () => {
    const f = fixture(); let props = f.adapters; f.fetcher.mockResolvedValueOnce(json({ error: { code: 'FORBIDDEN' } }, 403));
    f.onDenied.mockImplementation(() => { throw new Error('Synthetic authorization refresh failure'); });
    view = new Hooks(() => CustodyRecoveryWorkspaceView(props)); view.render(); view.render(); button().props.onClick();
    await vi.waitFor(() => expect(f.onDenied).toHaveBeenCalledOnce()); props = { ...props, fetch: async (url, init) => f.fetcher(url, init) };
    view.render(); view.render(); expect(text(view.tree)).toContain('Current owner access could not be verified.'); expect(button()).toBeUndefined();
    expect(f.fetcher).toHaveBeenCalledOnce();
  });
  it('a distinct authenticated bootstrap resets denial but still needs an explicit context check', async () => {
    const f = fixture(); let props = f.adapters; f.fetcher.mockResolvedValueOnce(json({ error: { code: 'FORBIDDEN' } }, 403));
    view = new Hooks(() => CustodyRecoveryWorkspaceView(props)); view.render(); view.render(); button().props.onClick();
    await vi.waitFor(() => expect(f.onDenied).toHaveBeenCalledOnce());
    const next = { ...f.bootstrap, sessionId: 'session_b' }; f.selected.value = next; f.context.owner.sessionId = next.sessionId;
    props = { ...props, bootstrap: next }; view.render(); view.render(); view.replay(); view.render();
    expect(text(view.tree)).not.toContain('Current owner access could not be verified.'); expect(button().props.disabled).toBe(false);
    expect(f.fetcher).toHaveBeenCalledOnce(); button().props.onClick();
    await eventually(() => expect(nodes(view!.tree).some(node => node.type === CustodySetupRecoveryPanel)).toBe(true));
    expect(f.fetcher).toHaveBeenCalledTimes(2); expect(f.onDenied).toHaveBeenCalledOnce();
  });
  it('a late denial from a departed bootstrap cannot poison its replacement', async () => {
    const f = fixture(), response = deferred<Response>(); let props = f.adapters; f.fetcher.mockReturnValueOnce(response.promise);
    view = new Hooks(() => CustodyRecoveryWorkspaceView(props)); view.render(); view.render(); button().props.onClick();
    await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledOnce());
    const next = { ...f.bootstrap, sessionId: 'session_b' }; f.selected.value = next; f.context.owner.sessionId = next.sessionId;
    props = { ...props, bootstrap: next }; view.render(); view.render(); response.resolve(json({ error: { code: 'FORBIDDEN' } }, 403));
    await eventually(() => expect(button().props.disabled).toBe(false)); expect(f.onDenied).not.toHaveBeenCalled();
    expect(f.fetcher).toHaveBeenCalledOnce(); button().props.onClick();
    await eventually(() => expect(nodes(view!.tree).some(node => node.type === CustodySetupRecoveryPanel)).toBe(true));
    expect(f.fetcher).toHaveBeenCalledTimes(2); expect(f.onDenied).not.toHaveBeenCalled();
  });
  it('production adapters preserve skipCache and reject current session or responsibility replacement', async () => {
    const f = fixture(); h.workspace = { session: f.session, getToken: vi.fn(async () => 'ordinary_token') }; h.auth = f.auth; h.query = { data: f.record, isError: false, isPending: false };
    view = new Hooks(() => CustodySetupRecoveryWorkspace({ id: f.record.id })); view.render(); const props = view.tree.props as CustodyRecoveryWorkspaceAdapters;
    expect(view.tree.type).toBe(CustodyRecoveryWorkspaceView); await props.getToken({ organizationId: 'provider_org', skipCache: true });
    expect(f.auth.getToken).toHaveBeenCalledWith({ organizationId: 'provider_org', skipCache: true }); expect(h.workspace.getToken).not.toHaveBeenCalled();
    props.onDenied?.(); expect(h.client.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['session'], exact: true });
    h.auth = { ...f.auth, sessionId: 'new_session' }; view.render(); expect(props.currentBootstrap()).toBeNull();
    h.auth = f.auth; h.query = { data: { ...f.record, id: 'other_record' }, isError: false, isPending: false }; view.render(); expect(props.currentBootstrap()).toBeNull();
  });
  it('nonowner rendering never mounts custody memory or exposes local inventory', () => {
    const f = fixture(); f.session.actor.roles = ['finance']; h.workspace = { session: f.session, getToken: f.auth.getToken }; h.auth = f.auth; h.query = { data: undefined, isError: false, isPending: true };
    view = new Hooks(() => CustodySetupRecoveryWorkspace({ id: f.record.id })); view.render(); expect(text(view.tree)).toContain('Development owner access is required'); expect(nodes(view.tree).some(node => node.type === CustodyRecoveryWorkspaceView)).toBe(false);
  });
});
