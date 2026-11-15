import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MandateOperationResult } from '@pactwoven/contracts';
import { RequestError } from '../lib/api';
import { MANDATE_VERIFICATION_LIFETIME_MS, qualifyMandateOperation } from '../lib/mandate-actions';
import type { MandateCapsule } from '../lib/mandate-capsule';
import { locatorFromCapsule, readMandateRecovery, removeMandateRecovery, storeMandateRecovery, type MandateRecovery } from '../lib/mandate-recovery';
import { createMandateWorkCoordinator, decisionWork } from '../lib/mandate-work-coordination';
import { decisionTestCase, mandateFixtureNow as now } from '../lib/mandates.test-fixtures';
import { MandateDecisionActions } from './mandate-decision-actions';

// Real component callbacks, preparation/capsule qualification, transport, recovery
// storage, coordinator and viewport reveal run here. Provider/identity/view children
// are doubles; host refs attach before simulated effects. This is not React DOM,
// browser geometry, MFA-provider or assistive-technology qualification.
const h = vi.hoisted(() => ({ active: null as any, memory: null as any, work: null as any, current: { current: null as any }, getToken: vi.fn(), client: { cancelQueries: vi.fn(), removeQueries: vi.fn(), invalidateQueries: vi.fn() }, mode: 'normal' as 'normal' | 'reduced' | 'off', keyboard: false, reduced: false, hidden: false, events: [] as { kind: string; target: string; options: any }[], listeners: new Set<() => void>() }));
vi.mock('react', async original => ({ ...(await original<any>()),
  useId: () => 'decision_focus_test',
  useState: (initial: any) => { const f = h.active, i = f.cursor++; if (!(i in f.cells)) f.cells[i] = typeof initial === 'function' ? initial() : initial; return [f.cells[i], (next: any) => { const value = typeof next === 'function' ? next(f.cells[i]) : next; if (!Object.is(value, f.cells[i])) { f.cells[i] = value; f.dirty = true; } }]; },
  useRef: (initial: any) => { const f = h.active, i = f.cursor++; return f.cells[i] ?? (f.cells[i] = { current: initial }); },
  useEffect: (callback: any, deps: any[]) => h.active.effect(callback, deps), useLayoutEffect: (callback: any, deps: any[]) => h.active.effect(callback, deps), useEffectEvent: (callback: any) => callback,
}));
vi.mock('@clerk/nextjs', () => ({ useAuth: () => ({ getToken: h.getToken }) }));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => h.client }));
vi.mock('./mandate-authoring-memory', () => ({ useMandateAuthoringMemory: () => ({ work: h.work }) }));
vi.mock('./mandate-recovery-memory', () => ({ useMandateRecoveryMemory: () => ({ ...h.memory }) }));
vi.mock('./mandate-read-shared', () => ({ useMandateScopeLifetime: () => h.current }));
vi.mock('./motion', () => ({ useArrival: () => ({ current: null }), useMotion: () => ({ mode: h.mode, keyboard: { current: h.keyboard } }) }));
vi.mock('./original-mandate-review', () => ({ OriginalMandateReview: 'OriginalMandateReview' }));
vi.mock('./mfa-verification', () => ({ MfaVerification: 'MfaVerification' }));
vi.mock('./ui', () => ({ ActionLabel: 'ActionLabel', Alert: 'Alert', Panel: 'Panel' }));

function nodes(node: any): any[] { if (node == null || typeof node !== 'object') return []; if (Array.isArray(node)) return node.flatMap(nodes); return [node, ...nodes(node.props?.children)]; }
function text(node: any): string { if (node == null || typeof node === 'boolean') return ''; if (typeof node === 'string' || typeof node === 'number') return String(node); if (Array.isArray(node)) return node.map(text).join(' '); return `${node.props?.label ?? ''} ${node.props?.title ?? ''} ${text(node.props?.children)}`.replace(/\s+/g, ' ').trim(); }
class Hooks {
  cells: any[] = []; effects: any[] = []; queued: (() => void)[] = []; cursor = 0; dirty = false; tree: any; committed = new Map<any, any>(); hookCounts = new Set<number>(); alive = true;
  effect(callback: any, deps: any[]) { const i = this.cursor++, old = this.effects[i]; if (!old || deps.some((value, j) => !Object.is(value, old.deps[j]))) this.queued.push(() => { old?.cleanup?.(); this.effects[i] = { deps, cleanup: callback() }; }); }
  render() {
    if (!this.alive) throw new Error('Cannot commit an unmounted component');
    for (let pass = 0; pass < 20; pass++) {
      this.cursor = 0; this.dirty = false; h.active = this; this.tree = MandateDecisionActions(props); this.hookCounts.add(this.cursor);
      const attached = new Set<any>();
      for (const node of nodes(this.tree)) {
        const ref = node.props?.ref; if (!ref || typeof ref !== 'object') continue; attached.add(ref);
        const target = this.committed.get(ref) ?? { label: '', focus(options: any) { h.events.push({ kind: 'focus', target: this.label, options }); }, scrollIntoView(options: any) { h.events.push({ kind: 'scroll', target: this.label, options }); } };
        target.label = text(node); ref.current = target; this.committed.set(ref, target);
      }
      for (const [ref] of this.committed) if (!attached.has(ref)) { ref.current = null; this.committed.delete(ref); }
      for (const effect of this.queued.splice(0)) effect();
      if (!this.dirty) return this.tree;
    }
    throw new Error('Unstable decision callback harness');
  }
  unmount() { this.alive = false; for (const effect of this.effects) effect?.cleanup?.(); for (const [ref] of this.committed) ref.current = null; this.committed.clear(); }
}
function memoryStorage() { const values = new Map<string, string>(); return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); }, key: (index: number) => [...values.keys()][index] ?? null, get length() { return values.size; } }; }
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
let view: Hooks, props: Parameters<typeof MandateDecisionActions>[0], storage: ReturnType<typeof memoryStorage>, fixtureData: Awaited<ReturnType<typeof decisionTestCase>>, network: ReturnType<typeof vi.fn>;
let holdReceipt = false, resolvedReceipt: any = null;
async function fixture(action: 'AUTHORIZE' | 'REJECT' = 'AUTHORIZE') {
  fixtureData = await decisionTestCase(action); h.current = { current: fixtureData.scope }; vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', fixtureData.scope.apiBase);
  props = { observation: { data: fixtureData.review, receivedAt: now, receivedMonotonic: 0 }, scope: fixtureData.scope, now, onOutcome: vi.fn() }; storage = memoryStorage();
  h.memory = {
    ready: true, hidden: false, slot: { state: 'empty' }, receipt: null, confirmed: null, capsule: null,
    begin: vi.fn((capsule: MandateCapsule) => { const locator = locatorFromCapsule(capsule); storeMandateRecovery(storage, locator); h.memory.slot = readMandateRecovery(storage, props.scope); h.memory.capsule = capsule; h.memory.receipt = null; }),
    confirm: vi.fn((locator: MandateRecovery, result: MandateOperationResult) => { h.memory.confirmed = { locator, result: qualifyMandateOperation(result, locator) }; }),
    resolve: vi.fn((locator: MandateRecovery) => { if (!h.memory.confirmed || !removeMandateRecovery(storage, locator)) return false; resolvedReceipt = h.memory.confirmed; if (!holdReceipt) commitReceipt(); return true; }),
    finish: vi.fn(), deny: vi.fn(() => { h.memory.hidden = true; h.memory.receipt = null; h.memory.confirmed = null; h.memory.capsule = null; }), reload: vi.fn(() => { h.memory.slot = readMandateRecovery(storage, props.scope); }),
  };
  h.work = createMandateWorkCoordinator(() => ({ records: h.memory.slot.state === 'pending' ? [decisionWork(h.memory.slot.locator)] : [], blocked: h.memory.slot.state === 'blocked' }));
  network = vi.fn(async (_url: string, init: RequestInit) => Response.json(init.method === 'POST' ? fixtureData.result : fixtureData.outcomeReview)); vi.stubGlobal('fetch', network);
  view = new Hooks(); view.render();
  if (action === 'REJECT') { nodes(view.tree).filter(node => node.type === 'input' && node.props.type === 'radio')[1]!.props.onChange(); view.render(); nodes(view.tree).find(node => node.type === 'textarea').props.onChange({ target: { value: fixtureData.intent.reason } }); view.render(); }
}
function commitReceipt() { h.memory.receipt = resolvedReceipt; h.memory.confirmed = null; h.memory.capsule = null; h.memory.slot = { state: 'empty' }; }
function button(label: string) { return nodes(view.tree).find(node => node.type === 'button' && text(node) === label); }
function click(label: string) { const control = button(label); expect(control, label).toBeDefined(); expect(control.props.disabled, label).not.toBe(true); control.props.onClick(); }
async function eventually(check: () => void) { await vi.waitFor(() => { view.render(); check(); }, { interval: 5, timeout: 2500 }); }
async function review() { click('Review decision'); expect(h.events).toEqual([]); await eventually(() => expect(nodes(view.tree).some(node => node.type === 'OriginalMandateReview')).toBe(true)); }
function verify() { const mfa = nodes(view.tree).find(node => node.type === 'MfaVerification'); expect(mfa).toBeDefined(); mfa.props.onComplete(); view.render(); }
function focused(label: string, instant = false) { expect(h.events.map(event => event.kind)).toEqual(['focus', 'scroll']); expect(h.events[0]!.target).toContain(label); expect(h.events[0]!.options).toEqual({ preventScroll: true }); expect(h.events[1]!.target).toBe(h.events[0]!.target); expect(h.events[1]!.options).toEqual({ behavior: instant ? 'instant' : 'smooth', block: 'start', inline: 'nearest' }); expect(requestAnimationFrame).not.toHaveBeenCalled(); }
function hidden(value: boolean) { h.hidden = value; for (const listener of h.listeners) listener(); }
const postCount = () => network.mock.calls.filter(([, init]) => (init as RequestInit).method === 'POST').length;
beforeEach(() => {
  vi.clearAllMocks(); h.mode = 'normal'; h.keyboard = false; h.reduced = false; h.hidden = false; h.events = []; h.listeners.clear(); holdReceipt = false; resolvedReceipt = null;
  h.getToken.mockResolvedValue('local-test-token'); vi.spyOn(Date, 'now').mockReturnValue(now); vi.spyOn(performance, 'now').mockReturnValue(0);
  vi.stubGlobal('document', { get hidden() { return h.hidden; }, addEventListener: (_name: string, callback: () => void) => h.listeners.add(callback), removeEventListener: (_name: string, callback: () => void) => h.listeners.delete(callback) });
  vi.stubGlobal('window', { matchMedia: () => ({ matches: h.reduced }) }); vi.stubGlobal('requestAnimationFrame', vi.fn(() => { throw new Error('Decision focus must not wait for animation frames.'); }));
});
afterEach(() => { view?.unmount(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('decision review and Back intent', () => {
  it.each(['normal', 'reduced', 'off', 'keyboard', 'os-reduced'] as const)('focuses committed review and editing targets in %s mode', async mode => {
    await fixture(); if (mode === 'keyboard') h.keyboard = true; else if (mode === 'os-reduced') h.reduced = true; else h.mode = mode;
    await review(); focused('Review your exact decision', mode !== 'normal'); h.events = []; click('Back to editing'); expect(h.events).toEqual([]); view.render(); focused('Choose a decision', mode !== 'normal'); expect(network).not.toHaveBeenCalled(); expect(h.memory.begin).not.toHaveBeenCalled();
  });
  it('does not treat factor completion/invalidation, clock or preference updates as focus or send intent', async () => {
    await fixture(); await review(); h.events = []; expect(button('Authorize advice-only mandate').props.disabled).toBe(true); verify(); expect(button('Authorize advice-only mandate').props.disabled).toBe(false);
    nodes(view.tree).find(node => node.type === 'MfaVerification').props.onInvalidated(); view.render(); expect(button('Authorize advice-only mandate').props.disabled).toBe(true);
    props = { ...props, now: now + 1000 }; h.mode = 'off'; view.render(); h.mode = 'normal'; view.render(); expect(h.events).toEqual([]); expect(network).not.toHaveBeenCalled(); expect(h.memory.begin).not.toHaveBeenCalled();
  });
  it('expires verification without replaying focus or dispatching a decision', async () => {
    await fixture(); await review(); h.events = []; vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); verify(); vi.advanceTimersByTime(MANDATE_VERIFICATION_LIFETIME_MS); view.render(); expect(button('Authorize advice-only mandate').props.disabled).toBe(true); expect(h.events).toEqual([]); expect(network).not.toHaveBeenCalled();
  });
  it('rechecks observation expiry at dispatch even if a stale enabled control is invoked', async () => {
    await fixture(); await review(); h.events = []; verify(); vi.mocked(Date.now).mockReturnValue(now + MANDATE_VERIFICATION_LIFETIME_MS); click('Authorize advice-only mandate'); await eventually(() => expect(text(view.tree)).toContain('The original review is no longer current')); focused('Decision needs attention'); expect(network).not.toHaveBeenCalled(); expect(h.memory.begin).not.toHaveBeenCalled();
  });
  it('focuses a qualified-review failure after commit without creating a request', async () => {
    await fixture(); props.observation.data.envelope.policyDocuments[0]!.text += ' changed'; click('Review decision'); expect(h.events).toEqual([]); await eventually(() => expect(text(view.tree)).toContain('Decision needs attention')); focused('Decision needs attention'); expect(network).not.toHaveBeenCalled();
  });
});

describe('exact decision receipt transitions', () => {
  it.each(['AUTHORIZE', 'REJECT'] as const)('keeps %s separate from review, removes pending controls, then reveals only its qualified result', async action => {
    await fixture(action); await review(); h.events = []; if (action === 'AUTHORIZE') verify(); expect(network).not.toHaveBeenCalled(); expect(h.events).toEqual([]);
    const response = deferred<Response>(); network.mockImplementationOnce(() => response.promise); click(action === 'AUTHORIZE' ? 'Authorize advice-only mandate' : 'Reject proposal');
    await eventually(() => { expect(postCount()).toBe(1); expect(h.memory.slot.state).toBe('pending'); }); expect(view.tree).toBeNull(); expect(view.committed.size).toBe(0); expect(h.events).toEqual([]); expect(readMandateRecovery(storage, props.scope).state).toBe('pending');
    response.resolve(Response.json(fixtureData.result)); await eventually(() => expect(text(view.tree)).toContain(action === 'AUTHORIZE' ? 'Authorization recorded' : 'Rejection recorded'));
    focused(action === 'AUTHORIZE' ? 'Authorization recorded' : 'Rejection recorded'); expect(postCount()).toBe(1); expect(network.mock.calls.map(([, init]) => (init as RequestInit).method)).toEqual(['POST', 'GET']); expect(h.memory.begin).toHaveBeenCalledOnce(); expect(h.memory.confirm).toHaveBeenCalledOnce(); expect(h.memory.resolve).toHaveBeenCalledOnce(); expect(props.onOutcome).toHaveBeenCalledOnce(); expect(readMandateRecovery(storage, props.scope).state).toBe('empty'); expect(view.hookCounts.size).toBe(1);
    h.events = []; props = { ...props, observation: { ...props.observation, data: fixtureData.outcomeReview }, now: now + 1000 }; h.mode = 'reduced'; view.render(); expect(h.events).toEqual([]);
  });
  it('retains explicit result focus through a pending host commit until the exact receipt is visible', async () => {
    await fixture(); await review(); h.events = []; verify(); holdReceipt = true; click('Authorize advice-only mandate'); await eventually(() => expect(props.onOutcome).toHaveBeenCalledOnce()); expect(view.tree).toBeNull(); expect(h.events).toEqual([]);
    commitReceipt(); view.render(); focused('Authorization recorded'); expect(postCount()).toBe(1); expect(view.hookCounts.size).toBe(1);
  });
  it.each(['key', 'kind', 'proposal-id', 'proposal-version', 'proposal-hash', 'responsibility', 'actor', 'environment', 'command-hash', 'intent-hash', 'decision-version'] as const)('revokes retained result focus when the pending %s changes before the old receipt returns', async mismatch => {
    await fixture(); await review(); h.events = []; verify(); holdReceipt = true; click('Authorize advice-only mandate'); await eventually(() => expect(props.onOutcome).toHaveBeenCalledOnce());
    const changed: MandateRecovery = structuredClone(h.memory.slot.locator);
    if (mismatch === 'key') changed.key = 'another_pending_request';
    else if (mismatch === 'kind') changed.kind = 'mandate.reject';
    else if (mismatch === 'proposal-id') changed.proposal.id = 'another_proposal';
    else if (mismatch === 'proposal-version') changed.proposal.version++;
    else if (mismatch === 'proposal-hash') changed.proposal.hash = 'a'.repeat(64);
    else if (mismatch === 'responsibility') changed.responsibilityId = 'another_responsibility';
    else if (mismatch === 'actor') changed.actorId = 'another_reviewer';
    else if (mismatch === 'environment') changed.environment = 'production';
    else if (mismatch === 'command-hash') changed.commandHash = 'b'.repeat(64);
    else if (mismatch === 'intent-hash') changed.intentHash = 'c'.repeat(64);
    else changed.expectedDecisionVersion++;
    h.memory.slot = { state: 'pending', locator: changed }; view.render(); expect(view.tree).toBeNull(); expect(h.events).toEqual([]);
    commitReceipt(); view.render(); expect(text(view.tree)).toContain('Authorization recorded'); expect(h.events).toEqual([]); expect(postCount()).toBe(1); expect(view.hookCounts.size).toBe(1);
  });
  it('revokes a changed pending locator even while recovery readiness defers revealing targets', async () => {
    await fixture(); await review(); h.events = []; verify(); holdReceipt = true; click('Authorize advice-only mandate'); await eventually(() => expect(props.onOutcome).toHaveBeenCalledOnce());
    const original = h.memory.slot.locator; h.memory.ready = false; h.memory.slot = { state: 'pending', locator: { ...original, key: 'another_pending_request' } }; view.render(); expect(h.events).toEqual([]);
    h.memory.ready = true; h.memory.slot = { state: 'pending', locator: original }; view.render(); commitReceipt(); view.render(); expect(text(view.tree)).toContain('Authorization recorded'); expect(h.events).toEqual([]); expect(postCount()).toBe(1);
  });
  it('retains intent across an equivalent pending-locator copy and reveals using the current mode', async () => {
    await fixture(); await review(); h.events = []; verify(); holdReceipt = true; click('Authorize advice-only mandate'); await eventually(() => expect(props.onOutcome).toHaveBeenCalledOnce());
    h.memory.slot = { state: 'pending', locator: structuredClone(h.memory.slot.locator) }; h.mode = 'off'; view.render(); expect(h.events).toEqual([]);
    commitReceipt(); view.render(); focused('Authorization recorded', true); h.events = []; h.mode = 'normal'; view.render(); expect(h.events).toEqual([]); expect(postCount()).toBe(1);
  });
  it.each(['reduced', 'off', 'keyboard', 'os-reduced'] as const)('reveals the result immediately in %s mode', async mode => {
    await fixture('REJECT'); await review(); h.events = []; if (mode === 'keyboard') h.keyboard = true; else if (mode === 'os-reduced') h.reduced = true; else h.mode = mode;
    click('Reject proposal'); await eventually(() => expect(text(view.tree)).toContain('Rejection recorded')); focused('Rejection recorded', true); expect(postCount()).toBe(1);
  });
  it.each(['wrong-request', 'wrong-proposal', 'missing', 'blocked'] as const)('revokes result intent on a nonpending %s transition before later background receipt arrival', async mismatch => {
    await fixture(); await review(); h.events = []; verify(); holdReceipt = true; click('Authorize advice-only mandate'); await eventually(() => expect(props.onOutcome).toHaveBeenCalledOnce());
    h.memory.slot = { state: mismatch === 'blocked' ? 'blocked' : 'empty' }; h.memory.receipt = mismatch === 'missing' || mismatch === 'blocked' ? null : { ...resolvedReceipt, locator: { ...resolvedReceipt.locator, ...(mismatch === 'wrong-request' ? { key: 'another_original_request' } : { proposal: { ...resolvedReceipt.locator.proposal, version: 4 } }) } }; view.render(); expect(h.events).toEqual([]);
    commitReceipt(); view.render(); expect(text(view.tree)).toContain('Authorization recorded'); expect(h.events).toEqual([]); expect(view.hookCounts.size).toBe(1);
  });
  it('does not focus an initial or background receipt without explicit decision completion', async () => {
    await fixture(); view.unmount(); h.memory.receipt = { locator: fixtureData.locator, result: fixtureData.result }; view = new Hooks(); view.render(); expect(text(view.tree)).toContain('Authorization recorded'); expect(h.events).toEqual([]);
    h.memory.receipt = null; view.render(); h.memory.receipt = { locator: fixtureData.locator, result: fixtureData.result }; h.mode = 'off'; view.render(); expect(h.events).toEqual([]); expect(network).not.toHaveBeenCalled();
  });
  it('does not assume a result focus when exact recovery removal fails', async () => {
    await fixture(); await review(); h.events = []; verify(); h.memory.resolve.mockReturnValue(false); click('Authorize advice-only mandate'); await eventually(() => expect(props.onOutcome).toHaveBeenCalledOnce()); expect(h.events).toEqual([]); expect(view.tree).toBeNull(); expect(readMandateRecovery(storage, props.scope).state).toBe('pending'); expect(postCount()).toBe(1);
  });
});

describe('error focus preserves original decision recovery', () => {
  it.each(['post-loss', 'receipt-loss', 'unqualified-receipt'] as const)('reveals %s failure beside the pending original, without a second send', async failure => {
    await fixture(); await review(); h.events = []; verify();
    network.mockImplementation(async (_url: string, init: RequestInit) => { if (failure === 'post-loss' || (failure === 'receipt-loss' && init.method === 'GET')) throw new TypeError('Simulated lost response'); return Response.json(init.method === 'POST' ? fixtureData.result : fixtureData.review); });
    click('Authorize advice-only mandate'); await eventually(() => expect(text(view.tree)).toContain('Decision needs attention')); focused('Decision needs attention'); expect(h.memory.slot.state).toBe('pending'); expect(readMandateRecovery(storage, props.scope).state).toBe('pending'); expect(nodes(view.tree).filter(node => node.type === 'button')).toEqual([]); expect(nodes(view.tree).find(node => node.type === 'a').props.href).toBe('#mandate-recovery'); expect(h.memory.resolve).not.toHaveBeenCalled(); expect(props.onOutcome).not.toHaveBeenCalled(); expect(postCount()).toBe(1);
    h.events = []; h.mode = 'off'; props = { ...props, now: now + 1000 }; view.render(); expect(h.events).toEqual([]); expect(postCount()).toBe(1); expect(view.hookCounts.size).toBe(1);
  });
  it('focuses repeated identical coordinator errors with no transport or persistence', async () => {
    await fixture(); await review(); h.events = []; h.work.acquire = vi.fn(() => { throw new RequestError('MANDATE_WORK_CONFLICT', 'Another related original request needs checking.'); });
    for (let attempt = 0; attempt < 2; attempt++) { verify(); click('Authorize advice-only mandate'); expect(h.events).toEqual([]); view.render(); focused('Decision needs attention'); h.events = []; }
    expect(h.work.acquire).toHaveBeenCalledTimes(2); expect(network).not.toHaveBeenCalled(); expect(h.memory.begin).not.toHaveBeenCalled(); expect(h.memory.finish).toHaveBeenCalledTimes(2);
  });
  it('reveals blocked-storage error after the pre-dispatch persistence guard fails', async () => {
    await fixture(); await review(); h.events = []; verify(); h.memory.begin.mockImplementation(() => { h.memory.slot = { state: 'blocked' }; throw new RequestError('MANDATE_RECOVERY_STORAGE', 'Reference could not be saved.'); });
    click('Authorize advice-only mandate'); await eventually(() => expect(text(view.tree)).toContain('Decision recovery storage needs attention')); focused('Decision recovery storage needs attention'); expect(network).not.toHaveBeenCalled(); expect(h.memory.confirm).not.toHaveBeenCalled(); expect(view.hookCounts.size).toBe(1);
  });
  it('keeps scope denial private and does not focus or erase the durable original', async () => {
    await fixture(); await review(); h.events = []; verify(); network.mockResolvedValue(Response.json({}, { status: 403 })); click('Authorize advice-only mandate'); await eventually(() => expect(h.memory.deny).toHaveBeenCalledOnce()); expect(text(view.tree)).toContain('Mandate access needs checking'); expect(h.events).toEqual([]); expect(h.client.cancelQueries).toHaveBeenCalledWith({ queryKey: ['mandates'] }); expect(h.client.removeQueries).toHaveBeenCalledWith({ queryKey: ['mandates'] }); expect(h.client.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['session'] }); expect(readMandateRecovery(storage, props.scope).state).toBe('pending'); expect(view.hookCounts.size).toBe(1);
  });
});

describe('focus lifetime and hidden transitions', () => {
  it.each(['hidden', 'scope-change', 'scope-ended', 'proposal-change', 'denied'] as const)('cancels an explicit Back intent on %s before commit and never replays it', async change => {
    await fixture(); await review(); h.events = []; click('Back to editing'); const originalProps = props;
    if (change === 'hidden') hidden(true); else if (change === 'scope-change') h.current.current = { ...props.scope, actorId: 'other_reviewer' }; else if (change === 'scope-ended') h.current.current = null; else if (change === 'denied') h.memory.hidden = true; else props = { ...props, observation: { ...props.observation, data: { ...fixtureData.review, envelope: { ...fixtureData.review.envelope, proposal: { ...fixtureData.review.envelope.proposal!, version: 4 } } } } };
    view.render(); expect(h.events).toEqual([]); hidden(false); h.memory.hidden = false; props = originalProps; h.current.current = props.scope; h.mode = 'reduced'; view.render(); expect(h.events).toEqual([]); expect(network).not.toHaveBeenCalled(); expect(view.hookCounts.size).toBe(1);
  });
  it('revokes a pending result on hide even when visibility returns before the receipt commits', async () => {
    await fixture(); await review(); h.events = []; verify(); holdReceipt = true; click('Authorize advice-only mandate'); await eventually(() => expect(props.onOutcome).toHaveBeenCalledOnce()); hidden(true); hidden(false); commitReceipt(); view.render(); expect(text(view.tree)).toContain('Authorization recorded'); expect(h.events).toEqual([]);
  });
  it('does not queue a completion that arrives hidden for later reveal', async () => {
    await fixture(); await review(); h.events = []; verify(); const response = deferred<Response>(); network.mockImplementationOnce(() => response.promise); click('Authorize advice-only mandate'); await eventually(() => expect(postCount()).toBe(1)); hidden(true); response.resolve(Response.json(fixtureData.result));
    // Let the async completion finish without a hidden component commit, then
    // restore visibility before the next host commit. The request itself must guard.
    await vi.waitFor(() => expect(props.onOutcome).toHaveBeenCalledOnce(), { interval: 5 }); hidden(false); view.render(); expect(text(view.tree)).toContain('Authorization recorded'); expect(h.events).toEqual([]); expect(postCount()).toBe(1);
  });
  it('does not queue a hidden async failure for replay after visibility returns', async () => {
    await fixture(); await review(); h.events = []; verify(); const response = deferred<Response>(); network.mockImplementationOnce(() => response.promise); click('Authorize advice-only mandate'); await eventually(() => expect(postCount()).toBe(1)); hidden(true); response.reject(new TypeError('Lost response'));
    await vi.waitFor(() => expect(h.memory.finish).toHaveBeenCalledOnce(), { interval: 5 }); hidden(false); view.render(); expect(text(view.tree)).toContain('Decision needs attention'); expect(h.events).toEqual([]); expect(readMandateRecovery(storage, props.scope).state).toBe('pending');
  });
  it('suppresses result reveal on denied memory and keeps hook order stable through readiness branches', async () => {
    await fixture(); h.memory.ready = false; view.render(); expect(view.tree).toBeNull(); h.memory.ready = true; view.render(); await review(); h.events = []; verify(); holdReceipt = true; click('Authorize advice-only mandate'); await eventually(() => expect(props.onOutcome).toHaveBeenCalledOnce()); h.memory.hidden = true; view.render(); h.memory.hidden = false; commitReceipt(); view.render(); expect(h.events).toEqual([]); expect(view.hookCounts.size).toBe(1);
  });
  it('unmount revokes pending result reveal and listeners without resending', async () => {
    await fixture(); await review(); h.events = []; verify(); holdReceipt = true; click('Authorize advice-only mandate'); await eventually(() => expect(props.onOutcome).toHaveBeenCalledOnce()); view.unmount(); expect(h.listeners.size).toBe(0); commitReceipt(); view = new Hooks(); view.render(); expect(text(view.tree)).toContain('Authorization recorded'); expect(h.events).toEqual([]); expect(postCount()).toBe(1);
  });
  it('unmount during a dispatched request suppresses late completion and preserves the original reference', async () => {
    await fixture(); await review(); h.events = []; verify(); const response = deferred<Response>(); network.mockImplementationOnce(() => response.promise); click('Authorize advice-only mandate'); await eventually(() => expect(postCount()).toBe(1)); view.unmount(); response.resolve(Response.json(fixtureData.result));
    await vi.waitFor(() => expect(h.memory.finish).toHaveBeenCalledOnce(), { interval: 5 }); expect(h.events).toEqual([]); expect(h.memory.confirm).not.toHaveBeenCalled(); expect(h.memory.resolve).not.toHaveBeenCalled(); expect(props.onOutcome).not.toHaveBeenCalled(); expect(readMandateRecovery(storage, props.scope).state).toBe('pending'); expect(postCount()).toBe(1); expect(h.listeners.size).toBe(0);
  });
});
