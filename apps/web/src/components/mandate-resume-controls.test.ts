import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { locatorFromAuthorityCapsule, listAuthorityRecovery } from '../lib/mandate-authority-recovery';
import { createAuthorityCapsule, qualifyAuthorityReceipt } from '../lib/mandate-authority';
import { settleMandateAuthorityReceipt } from '../lib/mandate-authority-transport';
import { decisionTestCase, mandateFixtureNow as now } from '../lib/mandates.test-fixtures';
import { MandateAuthoringMemoryProvider } from './mandate-authoring-memory';
import { MandateAuthorityMemoryProvider } from './mandate-authority-memory';
import { MandateResumeControls } from './mandate-resume-controls';

// Integrated real providers, coordinator, capsule/transport/storage and reveal.
// Simulated React hooks/host commits and synthetic identity/fetch only; not DOM,
// live browser scheduling/geometry, native MFA or backend security acceptance.
const h = vi.hoisted(() => ({ active: null as any, memory: null as any, authoring: null as any, c1: null as any, current: { current: null as any }, getToken: vi.fn(), client: { cancelQueries: vi.fn(), removeQueries: vi.fn(), invalidateQueries: vi.fn() }, mode: 'normal' as 'normal' | 'reduced' | 'off', keyboard: false, reduced: false, hidden: false, events: [] as { kind: string; target: string; options: any }[], listeners: new Set<() => void>() }));
vi.mock('react', async original => ({ ...(await original<any>()), useId: () => 'authority_test', useState: (initial: any) => { const f = h.active, i = f.cursor++; if (!(i in f.cells)) f.cells[i] = typeof initial === 'function' ? initial() : initial; return [f.cells[i], (next: any) => { const value = typeof next === 'function' ? next(f.cells[i]) : next; if (!Object.is(value, f.cells[i])) { f.cells[i] = value; f.dirty = true; } }]; }, useRef: (initial: any) => { const f = h.active, i = f.cursor++; return f.cells[i] ?? (f.cells[i] = { current: initial }); }, useLayoutEffect: (effect: any, deps: any[]) => h.active.effect(effect, deps), useEffect: (effect: any, deps: any[]) => h.active.effect(effect, deps), useEffectEvent: (callback: any) => callback }));
vi.mock('@clerk/nextjs', () => ({ useAuth: () => ({ getToken: h.getToken }) }));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => h.client }));
vi.mock('./mandate-recovery-memory', () => ({ useMandateRecoveryMemory: () => h.c1 }));
vi.mock('./mandate-authoring-memory', async original => ({ ...(await original<any>()), useMandateAuthoringMemory: () => h.authoring }));
vi.mock('./mandate-authority-memory', async original => ({ ...(await original<any>()), useMandateAuthorityMemory: () => h.memory }));
vi.mock('./mandate-read-shared', () => ({ useMandateScopeLifetime: () => h.current, MandateTime: 'MandateTime' }));
vi.mock('./motion', () => ({ useArrival: () => ({ current: null }), useMotion: () => ({ mode: h.mode, keyboard: { current: h.keyboard } }) }));
vi.mock('./mfa-verification', () => ({ MfaVerification: 'MfaVerification' }));
vi.mock('./ui', () => ({ ActionLabel: 'ActionLabel', Panel: 'Panel', Alert: 'Alert', Disclosure: 'Disclosure' }));
function nodes(node: any): any[] { if (node == null || typeof node !== 'object') return []; if (Array.isArray(node)) return node.flatMap(nodes); return [node, ...nodes(node.props?.children)]; }
function text(node: any): string { if (node == null || typeof node === 'boolean') return ''; if (typeof node === 'string' || typeof node === 'number') return String(node); if (Array.isArray(node)) return node.map(text).join(' '); if (node.props?.receipt) return `${node.props.receipt.recordedState} recorded`; return `${node.props?.title ?? ''} ${node.props?.label ?? ''} ${text(node.props?.children)}`.replace(/\s+/g, ' ').trim(); }
class Hooks {
  cells: any[] = []; effects: any[] = []; queued: (() => void)[] = []; cursor = 0; dirty = false; tree: any; refs = new Map<any, any>(); counts = new Set<number>();
  constructor(public component: () => any) {}
  effect(callback: any, deps: any[]) { const i = this.cursor++, old = this.effects[i]; if (!old || deps.some((v, j) => !Object.is(v, old.deps[j]))) this.queued.push(() => { old?.cleanup?.(); this.effects[i] = { deps, cleanup: callback() }; }); }
  render() { for (let i = 0; i < 30; i++) { this.cursor = 0; this.dirty = false; h.active = this; this.tree = this.component(); this.counts.add(this.cursor); const attached = new Set(); for (const node of nodes(this.tree)) { const ref = node.props?.ref; if (!ref || typeof ref !== 'object') continue; attached.add(ref); const target = this.refs.get(ref) ?? { label: '', focus(options: any) { h.events.push({ kind: 'focus', target: this.label, options }); }, scrollIntoView(options: any) { h.events.push({ kind: 'scroll', target: this.label, options }); } }; target.label = text(node); ref.current = target; this.refs.set(ref, target); } for (const [ref] of this.refs) if (!attached.has(ref)) { ref.current = null; this.refs.delete(ref); } for (const effect of this.queued.splice(0)) effect(); if (!this.dirty) return this.tree; } throw new Error('Unstable host'); }
  unmount() { for (const effect of this.effects) effect?.cleanup?.(); for (const [ref] of this.refs) ref.current = null; this.refs.clear(); }
}
function storage() { const values = new Map<string, string>(); return { get length() { return values.size; }, key: (i: number) => [...values.keys()][i] ?? null, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } }; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
let parent: Hooks, provider: Hooks, view: Hooks, store: ReturnType<typeof storage>, props: Parameters<typeof MandateResumeControls>[0], network: ReturnType<typeof vi.fn>;
function render() { h.authoring = parent.render().props.value; h.memory = provider.render().props.value; return view.render(); }
async function fixture() {
  const f = await decisionTestCase('AUTHORIZE'), at = now + 2000, review = structuredClone(f.outcomeReview);
  vi.mocked(Date.now).mockReturnValue(at); review.envelope.observedAt = new Date(at).toISOString(); review.envelope.head!.state = 'PAUSED'; review.envelope.head!.mandateEpoch = 2;
  review.effectiveAuthority = { state: 'PAUSED', blockers: ['AUTHORITY_PAUSED'] }; review.envelope.eligibility = [{ action: 'RESUME', eligible: true, requiresStepUp: true, blockers: [] }];
  store = storage(); vi.stubGlobal('window', { sessionStorage: store, matchMedia: () => ({ matches: h.reduced }) }); h.current = { current: f.scope }; const { responsibilityId: _, ...scope } = f.scope;
  h.c1 = { hidden: false, deny: vi.fn(() => { h.c1.hidden = true; }) }; parent = new Hooks(() => MandateAuthoringMemoryProvider({ scope, children: null })); h.authoring = parent.render().props.value; provider = new Hooks(() => MandateAuthorityMemoryProvider({ scope, children: null })); h.memory = provider.render().props.value;
  props = { observation: { data: review, receivedAt: at, receivedMonotonic: 0 }, scope: f.scope, now: at, onOutcome: vi.fn() }; view = new Hooks(() => MandateResumeControls(props));
  network = vi.fn(async (_url: string, init: RequestInit) => { const key = (init.headers as Record<string, string>)['Idempotency-Key'], locator = listAuthorityRecovery(store, props.scope).locators.find(value => value.key === key)!; expect(locator).toBeDefined(); return response(locator); }); vi.stubGlobal('fetch', network); render();
  nodes(view.tree).find(node => node.type === 'textarea').props.onChange({ target: { value: '  Resume the exact accepted terms.  ' } }); render(); return { ...f, at, review };
}
function response(locator: ReturnType<typeof locatorFromAuthorityCapsule>) { return Response.json({ schemaVersion: 1, organizationId: props.scope.organizationId, kind: locator.kind, responsibilityId: props.scope.responsibilityId, target: locator.expectedTarget, commandHash: locator.commandHash, intentHash: locator.intentHash, observedAt: new Date(Date.now()).toISOString(), operation: { id: 'resume_operation', environment: props.scope.environment, status: 'succeeded', aggregateId: locator.mandate.id, aggregateVersion: locator.expectedTarget.version, financialState: null, evidenceRefs: [], nextCheckAt: null, error: null } }); }
function factor() { const node = nodes(view.tree).find(node => node.type === 'MfaVerification'); expect(node).toBeDefined(); return node.props; }
function capsule() { const node = nodes(view.tree).find(node => node.props?.capsule?.intent.action === 'RESUME'); expect(node).toBeDefined(); return node.props.capsule; }
function stop() { const ticket = h.memory.work.acquire({ scope: { userId: props.scope.userId, externalOrganizationId: props.scope.externalOrganizationId, apiBase: props.scope.apiBase, organizationId: props.scope.organizationId, environment: props.scope.environment, actorId: props.scope.actorId }, responsibilityId: props.scope.responsibilityId, targetId: 'mandate_a', kind: 'REVOKE', key: 'separate_stop_key', action: 'send', hasHead: true, eligible: true }); h.memory.work.release(ticket); }
function hideAndReturn() { h.hidden = true; for (const listener of h.listeners) listener(); h.hidden = false; for (const listener of h.listeners) listener(); render(); }
function button(label: string) { return nodes(view.tree).find(node => node.type === 'button' && text(node) === label); }
function click(label: string) { const node = button(label); expect(node, label).toBeDefined(); expect(node.props.disabled).not.toBe(true); node.props.onClick(); }
async function eventually(check: () => void) { await vi.waitFor(() => { render(); check(); }, { interval: 5, timeout: 2500 }); }
async function review() { click('Review accepted resume'); expect(h.events).toEqual([]); await eventually(() => expect(text(view.tree)).toContain('Review this exact accepted resume')); }
function focus(label: string, instant = false) { expect(h.events.map(event => event.kind)).toEqual(['focus', 'scroll']); expect(h.events[0]!.target).toContain(label); expect(h.events[0]!.options).toEqual({ preventScroll: true }); expect(h.events[1]!.options.behavior).toBe(instant ? 'instant' : 'smooth'); expect(requestAnimationFrame).not.toHaveBeenCalled(); }
beforeEach(() => { vi.clearAllMocks(); h.mode = 'normal'; h.keyboard = false; h.reduced = false; h.hidden = false; h.events = []; h.listeners.clear(); h.getToken.mockResolvedValue('test_token'); vi.spyOn(Date, 'now').mockReturnValue(now); vi.spyOn(performance, 'now').mockReturnValue(0); vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', 'https://api.example.test'); vi.stubGlobal('document', { get hidden() { return h.hidden; }, addEventListener: (_name: string, cb: () => void) => h.listeners.add(cb), removeEventListener: (_name: string, cb: () => void) => h.listeners.delete(cb) }); vi.stubGlobal('requestAnimationFrame', vi.fn(() => { throw new Error('Focus cannot wait for motion'); })); });
afterEach(() => { view?.unmount(); provider?.unmount(); parent?.unmount(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('native current accepted resume', () => {
  it.each(['normal', 'reduced', 'off', 'keyboard', 'os-reduced'] as const)('reveals exact review and explicit Back in %s without sending on factor completion', async mode => {
    await fixture(); if (mode === 'keyboard') h.keyboard = true; else if (mode === 'os-reduced') h.reduced = true; else h.mode = mode;
    await review(); focus('Review this exact accepted resume', mode !== 'normal'); h.events = [];
    expect(factor().purpose).toBe('mandate-resume'); expect(button('Resume accepted authority').props.disabled).toBe(true); factor().onComplete(); render();
    expect(button('Resume accepted authority').props.disabled).toBe(false); expect(network).not.toHaveBeenCalled(); expect(h.events).toEqual([]);
    click('Back to resume input'); render(); focus('Reason for resuming', mode !== 'normal'); expect(store.length).toBe(0);
  });
  it('sends exactly once from a separate verified click and keeps the current paused observation separate', async () => {
    const f = await fixture(); await review(); const value = capsule(); h.events = []; factor().onComplete(); render();
    expect(network).not.toHaveBeenCalled(); click('Resume accepted authority'); click('Resume accepted authority');
    await eventually(() => expect(props.onOutcome).toHaveBeenCalledOnce()); focus('ACTIVE recorded'); expect(network).toHaveBeenCalledOnce(); expect(h.getToken).toHaveBeenCalledOnce();
    const [url, init] = network.mock.calls[0]!; expect(url).toContain('/mandates/mandate_a/authority'); expect(init.body).toBe(JSON.stringify(value.intent)); expect(value.intent.action).toBe('RESUME'); expect(value.intent.mandate.version).toBe(1); expect(value.expectedTarget.version).toBe(3);
    expect(f.review.envelope.head!.state).toBe('PAUSED'); expect(f.review.envelope.head!.mandateEpoch).toBe(2); expect(store.length).toBe(0); expect(view.counts.size).toBe(1);
  });
  it('a refreshed observation requires a new explicit review even if the old observation later returns', async () => {
    await fixture(); await review(); const old = factor(), original = props.observation; h.events = [];
    props = { ...props, observation: { ...original, receivedAt: original.receivedAt + 1 } }; render(); old.onComplete(); render(); expect(button('Resume accepted authority')).toBeUndefined();
    props = { ...props, observation: original }; render(); old.onComplete(); render(); expect(button('Resume accepted authority')).toBeUndefined(); expect(h.events).toEqual([]);
    await review(); h.events = []; const fresh = factor(); old.onComplete(); render(); expect(button('Resume accepted authority').props.disabled).toBe(true);
    fresh.onComplete(); render(); expect(button('Resume accepted authority').props.disabled).toBe(false); old.onInvalidated(); render(); expect(button('Resume accepted authority').props.disabled).toBe(false); expect(h.events).toEqual([]); expect(network).not.toHaveBeenCalled();
  });
  it('duplicate factor completion cannot extend the original verification lifetime', async () => {
    const f = await fixture(); await review(); const old = factor(); old.onComplete(); render(); h.events = [];
    vi.mocked(Date.now).mockReturnValue(f.at + 230_000); old.onComplete(); render();
    vi.mocked(Date.now).mockReturnValue(f.at + 240_000); render(); expect(button('Resume accepted authority').props.disabled).toBe(true); expect(h.events).toEqual([]); expect(network).not.toHaveBeenCalled();
  });
  it.each([false, true])('a qualified stop invalidates unsent review with completed factors=%s and cannot be undone by late callbacks', async completed => {
    await fixture(); await review(); const old = factor(); if (completed) { old.onComplete(); render(); } h.events = []; stop(); render();
    expect(text(view.tree)).toContain('invalidated this unsent resume'); expect(button('Resume accepted authority')).toBeUndefined(); old.onComplete(); old.onInvalidated(); render();
    expect(text(view.tree)).toContain('invalidated this unsent resume'); expect(h.events).toEqual([]); expect(network).not.toHaveBeenCalled();
    await review(); h.events = []; factor().onComplete(); render(); old.onInvalidated(); render(); expect(button('Resume accepted authority').props.disabled).toBe(false); expect(h.events).toEqual([]);
  });
  it('a stop during preparation hashing prevents stale review and factor UI from appearing', async () => {
    await fixture(); const digest = crypto.subtle.digest.bind(crypto.subtle), gate = deferred<void>(), started = deferred<void>();
    vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (...args) => { started.resolve(); await gate.promise; return digest(...args); });
    click('Review accepted resume'); await started.promise; stop(); gate.resolve();
    await eventually(() => expect(text(view.tree)).toContain('invalidated this unsent resume')); expect(nodes(view.tree).some(node => node.type === 'MfaVerification')).toBe(false); expect(h.events).toEqual([]); expect(network).not.toHaveBeenCalled(); expect(store.length).toBe(0);
  });
  it('a stop during token retrieval preserves its invalidation notice with no resume dispatch or late focus', async () => {
    await fixture(); await review(); factor().onComplete(); render(); h.events = []; const token = deferred<string>(); h.getToken.mockReturnValue(token.promise);
    click('Resume accepted authority'); await eventually(() => expect(h.getToken).toHaveBeenCalledOnce()); stop(); render(); token.resolve('test_token');
    await eventually(() => expect(button('Review accepted resume')?.props.disabled).toBe(false)); expect(text(view.tree)).toContain('invalidated this unsent resume'); expect(h.events).toEqual([]); expect(network).not.toHaveBeenCalled(); expect(store.length).toBe(0); expect(props.onOutcome).not.toHaveBeenCalled();
  });
  it.each(['normal', 'reduced', 'off'] as const)('canceled token completion after returning visible cannot reclaim focus in %s', async mode => {
    await fixture(); h.mode = mode; await review(); factor().onComplete(); render(); h.events = []; const token = deferred<string>(); h.getToken.mockReturnValue(token.promise);
    click('Resume accepted authority'); await eventually(() => expect(h.getToken).toHaveBeenCalledOnce()); hideAndReturn(); token.resolve('test_token');
    await eventually(() => expect(text(view.tree)).toContain('Resume needs attention')); expect(h.events).toEqual([]); expect(network).not.toHaveBeenCalled(); expect(store.length).toBe(0); expect(props.onOutcome).not.toHaveBeenCalled();
    await review(); focus('Review this exact accepted resume', mode !== 'normal');
  });
  it('hiding a factor review permanently revokes old callbacks while a new explicit verification remains usable', async () => {
    await fixture(); await review(); const old = factor(); h.events = []; hideAndReturn(); old.onComplete(); render(); expect(button('Resume accepted authority').props.disabled).toBe(true);
    factor().onComplete(); render(); old.onInvalidated(); render(); expect(button('Resume accepted authority').props.disabled).toBe(false); expect(h.events).toEqual([]); expect(network).not.toHaveBeenCalled();
  });
  it('scope denial during token observation hides private input and never dispatches', async () => {
    await fixture(); await review(); const old = factor(); old.onComplete(); render(); h.events = []; const token = deferred<string>(); h.getToken.mockReturnValue(token.promise);
    click('Resume accepted authority'); await eventually(() => expect(h.getToken).toHaveBeenCalledOnce()); h.current.current = { ...props.scope, actorId: 'other_actor' }; token.resolve('test_token');
    await eventually(() => expect(h.memory.hidden).toBe(true)); old.onComplete(); render(); expect(view.tree).toBeNull(); expect(h.events).toEqual([]); expect(network).not.toHaveBeenCalled(); expect(store.length).toBe(0);
  });
  it('preserves an unknown original, its exact private input and its key without preparing a replacement', async () => {
    const f = await fixture(); await review(); const value = capsule(); factor().onComplete(); render(); h.events = []; network.mockRejectedValueOnce(new Error('Lost response'));
    click('Resume accepted authority'); await eventually(() => expect(text(view.tree)).toContain('Resume needs attention')); focus('Resume needs attention');
    expect(listAuthorityRecovery(store, f.scope).locators).toEqual([locatorFromAuthorityCapsule(value)]); expect(h.memory.original(locatorFromAuthorityCapsule(value))).toEqual(value); expect(button('Review accepted resume').props.disabled).toBe(true); expect(network).toHaveBeenCalledOnce(); expect(props.onOutcome).not.toHaveBeenCalled();
  });
  it('preserves a dispatched original and its historical receipt beside a later eligible stop', async () => {
    await fixture(); await review(); const value = capsule(); factor().onComplete(); render(); h.events = []; const pending = deferred<Response>(); network.mockImplementationOnce(() => pending.promise);
    click('Resume accepted authority'); await eventually(() => expect(network).toHaveBeenCalledOnce()); stop(); pending.resolve(response(locatorFromAuthorityCapsule(value)));
    await eventually(() => expect(props.onOutcome).toHaveBeenCalledOnce()); focus('ACTIVE recorded'); expect(network).toHaveBeenCalledOnce(); expect(store.length).toBe(0);
  });
  it('never treats the accepted requester as an independent resume reviewer', async () => {
    const f = await fixture(); props = { ...props, scope: { ...f.scope, actorId: f.review.envelope.acceptedProposal!.requesterId } }; h.current.current = props.scope; render();
    expect(button('Review accepted resume').props.disabled).toBe(true); expect(network).not.toHaveBeenCalled(); expect(store.length).toBe(0);
  });
  it('expiry disables the separate action immediately without timer or preference changes sending or focusing', async () => {
    const f = await fixture(); await review(); factor().onComplete(); render(); h.events = []; vi.mocked(Date.now).mockReturnValue(f.at + 240_000); props = { ...props, now: f.at + 240_000 }; h.mode = 'off'; render();
    expect(button('Resume accepted authority').props.disabled).toBe(true); expect(network).not.toHaveBeenCalled(); expect(h.events).toEqual([]);
  });
});

describe('RESUME review and factor lifetime repair', () => {
  it.each(['normal', 'reduced', 'off'] as const)('current factor invalidation during token wait wins over late completion in %s', async mode => {
    await fixture(); h.mode = mode; await review(); const previous = factor(); previous.onComplete(); render(); const token = deferred<string>(); h.getToken.mockReturnValue(token.promise); h.events = [];
    click('Resume accepted authority'); await eventually(() => expect(h.getToken).toHaveBeenCalledOnce()); previous.onInvalidated(); previous.onComplete(); render(); token.resolve('test_token');
    await eventually(() => expect(text(view.tree)).toContain('Resume needs attention')); expect(network).not.toHaveBeenCalled(); expect(store.length).toBe(0); expect(props.onOutcome).not.toHaveBeenCalled(); expect(h.memory.hidden).toBe(false);
    h.getToken.mockResolvedValue('test_token'); h.events = []; await review(); expect(button('Resume accepted authority').props.disabled).toBe(true); factor().onComplete(); render(); previous.onComplete(); previous.onInvalidated(); render(); expect(button('Resume accepted authority').props.disabled).toBe(false);
    click('Resume accepted authority'); await eventually(() => expect(props.onOutcome).toHaveBeenCalledOnce()); expect(network).toHaveBeenCalledOnce();
  });
  it.each(['normal', 'reduced', 'off'] as const)('refresh and restoration revoke preparation before selection exists in %s and allow a fresh explicit review', async mode => {
    await fixture(); h.mode = mode; const original = props.observation, digest = crypto.subtle.digest.bind(crypto.subtle), gate = deferred<void>(), started = deferred<void>(), registered = vi.spyOn(h.memory.work, 'registerPreparation');
    vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (...args) => { started.resolve(); await gate.promise; return digest(...args); });
    click('Review accepted resume'); await started.promise; props = { ...props, observation: { ...original, receivedAt: original.receivedAt + 1 } }; render(); props = { ...props, observation: original }; render(); gate.resolve();
    await eventually(() => expect(text(view.tree)).toContain('Resume needs attention')); expect(registered).not.toHaveBeenCalled(); expect(h.events).toEqual([]); expect(network).not.toHaveBeenCalled(); expect(store.length).toBe(0); expect(nodes(view.tree).some(node => node.type === 'MfaVerification')).toBe(false);
    const freshRegistration = vi.spyOn(h.memory.work, 'registerPreparation'); await review(); focus('Review this exact accepted resume', mode !== 'normal'); expect(freshRegistration).toHaveBeenCalledOnce(); expect(button('Resume accepted authority').props.disabled).toBe(true); expect(network).not.toHaveBeenCalled();
  });
  it('late factor invalidation cannot cancel an already dispatched original receipt', async () => {
    await fixture(); await review(); const value = capsule(), currentFactor = factor(); currentFactor.onComplete(); render(); h.events = []; const pending = deferred<Response>(); network.mockImplementationOnce(() => pending.promise);
    click('Resume accepted authority'); await eventually(() => expect(network).toHaveBeenCalledOnce()); currentFactor.onInvalidated(); currentFactor.onComplete(); render(); pending.resolve(response(locatorFromAuthorityCapsule(value)));
    await eventually(() => expect(props.onOutcome).toHaveBeenCalledOnce()); expect(network).toHaveBeenCalledOnce(); expect(store.length).toBe(0); focus('ACTIVE recorded');
  });
});

describe('exact original recovery reconciles the first-send warning', () => {
  const newDraft = 'A newer unsent reason entered after the uncertain response.';
  function enterDraft(value = newDraft) { nodes(view.tree).find(node => node.type === 'textarea').props.onChange({ target: { value } }); render(); }
  function draftValue() { return nodes(view.tree).find(node => node.type === 'textarea').props.value; }
  async function unknown() { await review(); const value = capsule(); factor().onComplete(); render(); network.mockRejectedValueOnce(new Error('Lost response')); click('Resume accepted authority'); await eventually(() => { expect(text(view.tree)).toContain('Resume needs attention'); expect(button('Review accepted resume')?.props.disabled).toBe(true); }); h.events = []; return { value, locator: locatorFromAuthorityCapsule(value) }; }
  async function receipt(locator: ReturnType<typeof locatorFromAuthorityCapsule>) { return qualifyAuthorityReceipt(await response(locator).json(), locator); }
  async function settle(locator: ReturnType<typeof locatorFromAuthorityCapsule>) { const qualified = await receipt(locator); await settleMandateAuthorityReceipt(locator, qualified.result, props.scope, { ...h.memory, current: () => h.current.current, signal: new AbortController().signal, getToken: h.getToken }); h.memory.reload(); render(); return qualified; }
  it.each(['normal', 'reduced', 'off'] as const)('matching qualified settlement updates only the historical notice and preserves a newer draft in %s', async mode => {
    const f = await fixture(); h.mode = mode; const { locator } = await unknown(); enterDraft(); const currentHead = structuredClone(f.review.envelope.head);
    await settle(locator); expect(text(view.tree)).toContain('ACTIVE recorded'); expect(text(view.tree)).not.toContain('Resume needs attention'); expect(text(view.tree)).not.toContain('response could not be confirmed'); expect(draftValue()).toBe(newDraft); expect(h.events).toEqual([]); expect(network).toHaveBeenCalledOnce(); expect(h.getToken).toHaveBeenCalledOnce(); expect(props.onOutcome).not.toHaveBeenCalled(); expect(f.review.envelope.head).toEqual(currentHead); expect(store.length).toBe(0); expect(view.counts.size).toBe(1);
    h.mode = mode === 'off' ? 'normal' : 'off'; render(); expect(h.events).toEqual([]); expect(draftValue()).toBe(newDraft);
  });
  it.each(['other-key', 'same-key-other-kind', 'same-key-other-command'] as const)('a qualified %s receipt cannot clear this original failure', async kind => {
    await fixture(); const { locator } = await unknown(); enterDraft(); let other = structuredClone(locator);
    if (kind === 'other-key') { other = locatorFromAuthorityCapsule(await createAuthorityCapsule(props.scope, props.observation, 'RESUME', 'Other original reason.', 'different_resume_key', props.now)); }
    else if (kind === 'same-key-other-kind') { const observation = structuredClone(props.observation); observation.data.envelope.eligibility.push({ action: 'REVOKE', eligible: true, requiresStepUp: false, blockers: [] }); other = locatorFromAuthorityCapsule(await createAuthorityCapsule(props.scope, observation, 'REVOKE', 'Separately recorded revoke.', locator.key, props.now)); }
    else other.commandHash = 'a'.repeat(64);
    h.memory.onQualified(await receipt(other)); render(); expect(text(view.tree)).toContain('Resume needs attention'); expect(text(view.tree)).not.toContain('ACTIVE recorded'); expect(draftValue()).toBe(newDraft); expect(listAuthorityRecovery(store, props.scope).locators).toEqual([locator]); expect(h.events).toEqual([]); expect(network).toHaveBeenCalledOnce();
    await settle(locator); expect(text(view.tree)).toContain('ACTIVE recorded'); expect(text(view.tree)).not.toContain('Resume needs attention'); expect(draftValue()).toBe(newDraft); expect(h.events).toEqual([]);
  });
  it('qualified receipt observation does not remove its still-unsettled durable original', async () => {
    await fixture(); const { locator } = await unknown(); enterDraft(); const before = listAuthorityRecovery(store, props.scope);
    h.memory.onQualified(await receipt(locator)); render(); expect(text(view.tree)).toContain('ACTIVE recorded'); expect(listAuthorityRecovery(store, props.scope)).toEqual(before); expect(draftValue()).toBe(newDraft); expect(h.events).toEqual([]); expect(network).toHaveBeenCalledOnce(); expect(props.onOutcome).not.toHaveBeenCalled();
  });
  it('unqualified pending or substituted results cannot replace the failure presentation', async () => {
    await fixture(); const { locator } = await unknown(); enterDraft(); const qualified = await receipt(locator);
    for (const result of [{ ...qualified.result, commandHash: 'b'.repeat(64) }, { ...qualified.result, operation: { ...qualified.result.operation, status: 'pending' } }]) expect(() => h.memory.onQualified({ ...qualified, result })).toThrow();
    render(); expect(text(view.tree)).toContain('Resume needs attention'); expect(draftValue()).toBe(newDraft); expect(listAuthorityRecovery(store, props.scope).locators).toEqual([locator]); expect(h.events).toEqual([]); expect(network).toHaveBeenCalledOnce();
  });
  it('background settlement while the page is hidden preserves draft and cannot regain focus on return', async () => {
    await fixture(); const { locator } = await unknown(); enterDraft(); h.hidden = true; for (const listener of h.listeners) listener(); render(); await settle(locator);
    expect(h.events).toEqual([]); expect(network).toHaveBeenCalledOnce(); h.hidden = false; for (const listener of h.listeners) listener(); render(); expect(text(view.tree)).toContain('ACTIVE recorded'); expect(draftValue()).toBe(newDraft); expect(h.events).toEqual([]); expect(props.onOutcome).not.toHaveBeenCalled();
  });
  it('current-scope departure blocks reconciliation before the component scope updates', async () => {
    await fixture(); const { locator } = await unknown(); enterDraft(); const before = listAuthorityRecovery(store, props.scope); h.current.current = { ...props.scope, sessionId: 'different_session' }; h.memory.onQualified(await receipt(locator)); render();
    expect(text(view.tree)).toContain('Resume needs attention'); expect(text(view.tree)).not.toContain('ACTIVE recorded'); expect(listAuthorityRecovery(store, props.scope)).toEqual(before); expect(h.events).toEqual([]); expect(network).toHaveBeenCalledOnce();
  });
  it('a component scope transition purges prior failure/draft and cannot restore it or its receipt on return', async () => {
    await fixture(); const { locator } = await unknown(); enterDraft(); const oldScope = props.scope; props = { ...props, scope: { ...oldScope, sessionId: 'different_session' } }; h.current.current = props.scope; h.memory.onQualified(await receipt(locator)); render();
    expect(text(view.tree)).not.toContain('Resume needs attention'); expect(text(view.tree)).not.toContain('ACTIVE recorded'); expect(draftValue()).toBe(''); props = { ...props, scope: oldScope }; h.current.current = oldScope; render(); expect(text(view.tree)).not.toContain('ACTIVE recorded'); expect(draftValue()).toBe(''); expect(h.events).toEqual([]); expect(network).toHaveBeenCalledOnce(); expect(listAuthorityRecovery(store, oldScope).locators).toEqual([locator]);
  });
  it('denial purges private status and rejects a late matching receipt while retaining its durable locator', async () => {
    await fixture(); const { locator } = await unknown(); enterDraft(); const qualified = await receipt(locator); h.memory.deny(); render(); expect(() => h.memory.onQualified(qualified)).toThrow(); render(); expect(view.tree).toBeNull(); expect(listAuthorityRecovery(store, props.scope).locators).toEqual([locator]); expect(h.events).toEqual([]); expect(network).toHaveBeenCalledOnce(); expect(props.onOutcome).not.toHaveBeenCalled();
  });
  it('an older recovered receipt cannot suppress a later first-send failure', async () => {
    await fixture(); const first = await unknown(); enterDraft(); await settle(first.locator); expect(text(view.tree)).toContain('ACTIVE recorded');
    const next = await unknown(); expect(next.locator.key).not.toBe(first.locator.key); h.memory.onQualified(await receipt(first.locator)); render(); expect(text(view.tree)).toContain('Resume needs attention'); expect(text(view.tree)).not.toContain('ACTIVE recorded'); expect(listAuthorityRecovery(store, props.scope).locators).toEqual([next.locator]); expect(draftValue()).toBe(newDraft); expect(h.events).toEqual([]); expect(network).toHaveBeenCalledTimes(2);
  });
});
