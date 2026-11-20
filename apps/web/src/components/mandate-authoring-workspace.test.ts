import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { commandDigest } from '@pactwoven/contracts/canonical';
import { RequestError } from '../lib/api';
import { createAuthoringManifest } from '../lib/mandate-authoring';
import { AuthoringManifestSchema, authoringStorageKey, beginAuthoringAttempt, listAuthoringManifests, readAuthoringManifest, type AuthoringManifest } from '../lib/mandate-authoring-recovery';
import { authoringWork, createMandateWorkCoordinator, decisionWork } from '../lib/mandate-work-coordination';
import { mandateReadFixture, mandateFixtureNow as now } from '../lib/mandates.test-fixtures';
import { MandateAuthoringWorkspace } from './mandate-authoring-workspace';

// Bounded real-component callback/state harness. Reads and view children are mocked;
// real manifest qualification, storage CAS and work coordination run. This does not
// qualify React DOM scheduling, browser navigation/focus, providers or accessibility.
const h = vi.hoisted(() => ({ active: null as any, scope: null as any, memory: null as any, c1: null as any, page: null as any, review: null as any, clock: 0, matches: true, error: null as any, readPage: vi.fn(), readReview: vi.fn(), replace: vi.fn(), mode: 'normal' as 'normal' | 'reduced' | 'off', keyboard: false, osReduced: false, hidden: false, focusEvents: [] as { kind: string; text: string; options: any }[] }));
vi.mock('react', async original => ({ ...(await original<any>()),
  useState: (initial: any) => { const f = h.active, i = f.cursor++; if (!(i in f.cells)) f.cells[i] = typeof initial === 'function' ? initial() : initial; return [f.cells[i], (next: any) => { const v = typeof next === 'function' ? next(f.cells[i]) : next; if (!Object.is(v, f.cells[i])) { f.cells[i] = v; f.dirty = true; } }]; },
  useRef: (initial: any) => { const f = h.active, i = f.cursor++; return f.cells[i] ?? (f.cells[i] = { current: initial }); },
  useEffectEvent: (callback: any) => callback,
  useEffect: (effect: any, deps: any[]) => h.active.effect(effect, deps), useLayoutEffect: (effect: any, deps: any[]) => h.active.effect(effect, deps),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: h.replace }) }));
vi.mock('next/link', () => ({ default: 'Link' }));
vi.mock('@clerk/nextjs', () => ({ useAuth: () => ({ getToken: () => { throw new Error('Identity calls are forbidden in this harness.'); } }) }));
vi.mock('@tanstack/react-query', () => ({ useQuery: ({ queryKey }: any) => ({ data: h.error ? undefined : { page: h.page, revision: queryKey[4] ? h.review : null, matches: h.matches }, isPending: false, isError: Boolean(h.error), error: h.error, isFetching: false, refetch: vi.fn() }), useQueryClient: () => ({ setQueryData: vi.fn() }) }));
vi.mock('../lib/mandates', async original => ({ ...(await original<any>()), readMandatePage: (...args: any[]) => h.readPage(...args), readMandateReview: (...args: any[]) => h.readReview(...args) }));
vi.mock('./mandate-authoring-memory', () => ({ useMandateAuthoringMemory: () => h.memory }));
vi.mock('./mandate-recovery-memory', () => ({ useMandateRecoveryMemory: () => h.c1 }));
vi.mock('./mandate-read-shared', () => ({ useMandateRouteScope: () => ({ scope: h.scope }), useMandateScopeLifetime: () => ({ current: h.scope }), useMandateClock: () => h.clock, useMandateReadPrivacy: () => null, MandateCurrentAuthority: 'MandateCurrentAuthority', MandateReadFailure: 'MandateReadFailure' }));
vi.mock('./motion', () => ({ useArrival: () => ({ current: null }), useMotion: () => ({ mode: h.mode, keyboard: { current: h.keyboard } }) }));
vi.mock('./mandate-document-editor', () => ({ MandateDocumentEditor: 'MandateDocumentEditor' }));
vi.mock('./mandate-proposal-editor', () => ({ MandateProposalEditor: 'MandateProposalEditor' }));
vi.mock('./mandate-authoring-recovery-panel', () => ({ MandateAuthoringRecoveryPanel: 'MandateAuthoringRecoveryPanel' }));
vi.mock('./ui', () => ({ ActionLabel: 'ActionLabel', Alert: 'Alert', ButtonLink: 'ButtonLink', LoadingState: 'LoadingState', PageHeading: 'PageHeading', Panel: 'Panel', StatusBadge: 'StatusBadge' }));

class Hooks {
  cells: any[] = []; cursor = 0; dirty = true; effects: any[] = []; queued: (() => void)[] = []; tree: any; committed = new Map<any, any>();
  constructor(public component: () => any) {}
  effect(callback: any, deps: any[] | undefined) { const i = this.cursor++, old = this.effects[i]; if (!old || !deps || deps.some((v, j) => !Object.is(v, old.deps?.[j]))) this.queued.push(() => { old?.cleanup?.(); this.effects[i] = { deps, cleanup: callback() }; }); }
  render() { for (let n = 0; n < 20; n++) { this.dirty = false; this.cursor = 0; h.active = this; this.tree = this.component(); this.commit(); for (const work of this.queued.splice(0)) work(); if (!this.dirty) return this.tree; } throw new Error('Unstable callback harness'); }
  commit() {
    const attached = new Set<any>();
    for (const node of nodes(this.tree)) {
      const ref = node.props?.ref; if (!ref || typeof ref !== 'object') continue; attached.add(ref);
      const target = this.committed.get(ref) ?? { content: '', focus(options: any) { if (this.content.trim()) h.focusEvents.push({ kind: 'focus', text: this.content, options }); }, scrollIntoView(options: any) { h.focusEvents.push({ kind: 'scroll', text: this.content, options }); } };
      target.content = text(node); this.committed.set(ref, target); ref.current = target;
    }
    for (const [ref] of this.committed) if (!attached.has(ref)) { ref.current = null; this.committed.delete(ref); }
  }
  unmount() { for (const effect of this.effects) effect?.cleanup?.(); for (const [ref] of this.committed) ref.current = null; this.committed.clear(); }
}
function nodes(node: any): any[] { if (!node || typeof node !== 'object') return []; if (Array.isArray(node)) return node.flatMap(nodes); return [node, ...nodes(node.props?.children), ...nodes(node.props?.action)]; }
function text(node: any): string { if (node == null || typeof node === 'boolean') return ''; if (typeof node === 'string' || typeof node === 'number') return String(node); if (Array.isArray(node)) return node.map(text).join(' '); return `${node.props?.label ?? ''} ${node.props?.title ?? ''} ${text(node.props?.children)}`; }
function button(label: string) { return nodes(view.render()).find(node => node.type === 'button' && text(node).includes(label)); }
function click(label: string) { const control = button(label); expect(control, label).toBeDefined(); expect(control.props.disabled, label).not.toBe(true); control.props.onClick(); }
const turn = () => new Promise(resolve => setImmediate(resolve));
async function settle() { await vi.waitFor(() => { view.render(); expect(view.tree.props['aria-busy']).not.toBe(true); }, { interval: 5, timeout: 2000 }); }
function memoryStorage() { const values = new Map<string, string>(); return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); }, key: (i: number) => [...values.keys()][i] ?? null, get length() { return values.size; } }; }
let view: Hooks, storage: ReturnType<typeof memoryStorage>;
function save(manifest: AuthoringManifest) { storage.setItem(authoringStorageKey(manifest.scope, manifest.responsibilityId), JSON.stringify(AuthoringManifestSchema.parse(manifest))); h.memory.reload(); }
function stored() { const slot = readAuthoringManifest(storage, h.scope, h.scope.responsibilityId); expect(slot.state).toBe('ready'); if (slot.state !== 'ready') throw new Error('Missing manifest'); return slot.manifest; }
function complete(manifest: AuthoringManifest, step: 'proposal' | 'acceptance' = 'proposal'): AuthoringManifest {
  const id = step === 'proposal' ? manifest.ids.proposalId : manifest.ids.acceptanceDocumentId;
  return AuthoringManifestSchema.parse({ ...manifest, completed: [...manifest.completed, { locator: { version: 1, scope: manifest.scope, preparationId: manifest.preparationId, responsibilityId: manifest.responsibilityId, key: `original_${step}_request_key`, kind: step === 'proposal' ? 'mandate.propose' : 'mandate.document.create', step, target: { id, version: 1 }, basis: { responsibility: manifest.basis.responsibility, organizationEpoch: manifest.basis.organizationEpoch }, commandHash: 'a'.repeat(64) }, reference: { id, version: 1, hash: 'b'.repeat(64) }, operationId: `original_${step}_operation`, savedAt: new Date(now).toISOString() }] });
}
async function fixture() {
  const f = await mandateReadFixture(false), p = f.review.envelope.proposal!;
  h.scope = { ...f.scope, actorId: p.requesterId }; h.clock = now; h.matches = true; h.error = null;
  f.page.eligibility = [{ action: 'PROPOSE', eligible: true, requiresStepUp: false, blockers: [] }]; f.review.envelope.eligibility = f.page.eligibility;
  h.page = { data: f.page, receivedAt: now, receivedMonotonic: 0 }; h.review = f.review;
  const ids = { acceptanceDocumentId: p.policy.acceptancePolicy.id, policyDocumentId: p.policyDocument.id, proposalId: p.id, mandateId: p.mandateId };
  const manifest = await createAuthoringManifest(h.scope, h.page, 'preparation_original', ids, now);
  h.c1 = { slot: { state: 'empty' } }; storage = memoryStorage();
  const snapshot = () => { const inventory = listAuthoringManifests(storage, h.scope); return { blocked: inventory.blocked || h.c1.slot.state === 'blocked', records: [...inventory.manifests.flatMap(item => item.pending ? [authoringWork(item.pending)] : []), ...(h.c1.slot.state === 'pending' ? [decisionWork(h.c1.slot.locator)] : [])] }; };
  h.memory = { ready: true, hidden: false, inventory: { blocked: false, manifests: [] }, storage: () => storage, select: vi.fn(), reload: () => { h.memory.inventory = listAuthoringManifests(storage, h.scope); }, work: createMandateWorkCoordinator(snapshot) };
  h.readPage.mockImplementation(async () => h.page); h.readReview.mockImplementation(async () => ({ data: h.review, receivedAt: h.clock, receivedMonotonic: 0 }));
  return { ...f, scope: h.scope, manifest, ids, proposal: p };
}
function mount(revision?: { proposalId: string; version: string }) {
  view = new Hooks(() => { const outer = MandateAuthoringWorkspace({ responsibilityId: h.scope.responsibilityId, revision }) as ReactElement<any>; return (outer.type as (props: any) => any)(outer.props); }); return view.render();
}
async function retainedRevision() { const f = await fixture(), revision = await createAuthoringManifest(f.scope, h.page, 'preparation_revision', f.ids, now, f.review); const manifest = complete(revision, 'acceptance'); save(manifest); return { ...f, manifest }; }
function expire() { h.clock = Date.parse(h.review.envelope.proposal.expiresAt) + 1; h.page = { ...h.page, receivedAt: h.clock, data: { ...h.page.data, observedAt: new Date(h.clock).toISOString() } }; }
beforeEach(() => { vi.clearAllMocks(); h.mode = 'normal'; h.keyboard = false; h.osReduced = false; h.hidden = false; h.focusEvents = []; vi.stubGlobal('document', { get hidden() { return h.hidden; } }); vi.stubGlobal('window', { matchMedia: () => ({ matches: h.osReduced }) }); vi.spyOn(Date, 'now').mockImplementation(() => h.clock); vi.spyOn(performance, 'now').mockReturnValue(0); vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network is forbidden in component/state regression checks.'); })); });
afterEach(() => { view?.unmount(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('native authoring preparation transitions with bounded callback/state harness', () => {
  it.each(['same', 'different'])('deliberately starts an exact %s-proposal revision after a completed preparation, retaining visible history', async selected => {
    const f = await fixture(), old = complete(f.manifest); save(old);
    if (selected === 'different') h.review = { ...f.review, envelope: { ...f.review.envelope, proposal: f.acceptedSource.proposal, decision: { ...f.review.envelope.decision!, proposal: { id: f.acceptedSource.proposal.id, version: 1, hash: f.acceptedSource.proposal.hash } }, policyDocuments: f.acceptedSource.documents }, responsibilityVersions: [f.current] };
    const p = h.review.envelope.proposal; mount({ proposalId: p.id, version: String(p.version) });
    expect(text(view.tree)).toContain('Proposal reference saved'); expect(button('Start fresh preparation')).toBeDefined(); expect(storage.length).toBe(1); expect(stored()).toEqual(old);
    click('Start fresh preparation'); await settle(); const next = stored();
    expect(next.mode).toEqual({ kind: 'revise', proposal: { id: p.id, version: p.version, hash: p.hash } }); expect(next.ids.proposalId).toBe(p.id); expect(next.preparationId).not.toBe(old.preparationId); expect(next.completed).toEqual(old.completed);
    expect(next.documents).toEqual({ acceptance: null, policy: null }); expect(next.ids.acceptanceDocumentId).toBe(p.policy.acceptancePolicy.id); expect(next.ids.policyDocumentId).toBe(p.policyDocument.id);
    expect(h.readReview).toHaveBeenCalledWith(f.scope, expect.anything(), expect.any(AbortSignal), expect.anything(), p.id, p.version);
    expect(h.readReview.mock.calls[0]?.[1]).toBeTypeOf('function'); expect(h.readReview.mock.calls[0]?.[3]).toBeTypeOf('function');
    expect(text(view.tree)).toContain('Earlier recorded proposals'); expect(nodes(view.tree).some(n => n.props?.href?.includes(`/mandates/${old.ids.proposalId}/versions/1`))).toBe(true); expect(fetch).not.toHaveBeenCalled(); expect(h.replace).not.toHaveBeenCalled();
  });
  it('starts the next exact revision after a previously completed revision version', async () => {
    const f = await retainedRevision(), p = structuredClone(f.proposal); p.version = 2; p.previousProposal = { id: f.proposal.id, version: 1, hash: f.proposal.hash }; const { hash: _, ...body } = p; p.hash = await commandDigest(body);
    const old = complete(f.manifest); old.completed[1]!.reference.version = 2; old.completed[1]!.locator.target.version = 2; save(old);
    h.review = { ...f.review, envelope: { ...f.review.envelope, proposal: p, decision: { ...f.review.envelope.decision!, proposal: { id: p.id, version: 2, hash: p.hash } } } };
    mount({ proposalId: p.id, version: '2' }); click('Start fresh preparation'); await settle(); expect(stored().mode).toEqual({ kind: 'revise', proposal: { id: p.id, version: 2, hash: p.hash } }); expect(stored().completed).toEqual(old.completed); expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['expired', 'REJECTED', 'SUPERSEDED'])('offers a deliberate distinct-new escape for an incomplete %s revision on the general preparation route', async state => {
    const f = await retainedRevision(); if (state === 'expired') expire(); else h.review.envelope.decision.state = state;
    mount(); expect(button('Start fresh preparation').props.disabled).toBe(true); expect(stored()).toEqual(f.manifest); expect(h.readPage).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    click('Start a distinct new proposal'); await settle(); const next = stored(); expect(next.mode).toEqual({ kind: 'new' }); expect(next.ids.proposalId).not.toBe(f.proposal.id); expect(next.completed).toEqual(f.manifest.completed); expect(next.pending).toBeNull(); expect(next.ids.acceptanceDocumentId).toBe(f.ids.acceptanceDocumentId); expect(next.documents).toEqual({ acceptance: null, policy: null }); expect(h.readPage).toHaveBeenCalledOnce(); expect(h.readReview).not.toHaveBeenCalled(); expect(h.replace).not.toHaveBeenCalled(); expect(text(view.tree)).toContain('Prepare mandate proposal'); expect(fetch).not.toHaveBeenCalled();
  });
  it('leaves an explicit expired revision route for general preparation only after deliberate new preparation succeeds', async () => {
    const f = await retainedRevision(); expire(); mount({ proposalId: f.proposal.id, version: '1' }); expect(h.replace).not.toHaveBeenCalled(); click('Start a distinct new proposal'); await settle(); expect(stored().mode.kind).toBe('new'); expect(h.replace).toHaveBeenCalledWith(`/app/responsibilities/${f.scope.responsibilityId}/mandates/prepare`); expect(stored().completed).toEqual(f.manifest.completed); expect(fetch).not.toHaveBeenCalled();
  });
  it('allocates fresh document IDs when a distinct-new preparation has only old revision source references', async () => {
    const f = await fixture(), revision = await createAuthoringManifest(f.scope, h.page, 'source_only_revision', f.ids, now, f.review); save(revision); expire(); mount(); click('Start a distinct new proposal'); await settle(); const next = stored();
    expect(next.ids.acceptanceDocumentId).not.toBe(f.ids.acceptanceDocumentId); expect(next.ids.policyDocumentId).not.toBe(f.ids.policyDocumentId); expect(next.mode.kind).toBe('new'); expect(next.completed).toEqual([]); expect(nodes(view.tree).find(n => n.type === 'MandateDocumentEditor').props.hasSavedReference).toBe(false); expect(fetch).not.toHaveBeenCalled();
  });
  it('starts new document identities for a changed site while retaining all old confirmed references', async () => {
    const f = await retainedRevision(); expire(); h.scope = { ...h.scope, siteIds: [...h.scope.siteIds, 'site_b'], actionSiteIds: [...h.scope.actionSiteIds, 'site_b'] };
    const responsibility = { ...h.page.data.responsibility, siteId: 'site_b', version: 3 }, reference = { ...h.page.data.responsibilityReference, siteId: 'site_b', version: 3, hash: await commandDigest(responsibility) };
    h.page = { ...h.page, data: { ...h.page.data, responsibility, responsibilityReference: reference, site: { id: 'site_b', name: 'New site', timeZone: 'UTC' } } }; h.matches = false;
    mount(); click('Start a distinct new proposal'); await settle(); const next = stored(); expect(next.basis.responsibility).toEqual(reference); expect(next.ids.acceptanceDocumentId).not.toBe(f.ids.acceptanceDocumentId); expect(next.ids.policyDocumentId).not.toBe(f.ids.policyDocumentId); expect(next.completed).toEqual(f.manifest.completed); expect(fetch).not.toHaveBeenCalled();
  });
  it.each([false, true])('prioritizes an unresolved original over completion/replacement, with read failure %s', async unavailable => {
    const f = await fixture(), completed = complete(f.manifest), original = completed.completed[0]!.locator; save({ ...completed, pending: original }); if (unavailable) h.error = new RequestError('UNAVAILABLE', 'Read unavailable', 503);
    mount({ proposalId: f.proposal.id, version: '1' }); expect(nodes(view.tree).some(n => n.type === 'MandateAuthoringRecoveryPanel' && n.props.locator.key === original.key)).toBe(true); expect(button('Start fresh preparation')).toBeUndefined(); expect(button('Start a distinct new proposal')).toBeUndefined(); expect(stored().pending).toEqual(original); expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects a pending original appearing while distinct-new current context is being read', async () => {
    const f = await retainedRevision(); expire(); let resolve!: (value: any) => void; h.readPage.mockImplementation(() => new Promise(r => { resolve = r; })); mount(); click('Start a distinct new proposal');
    const original = complete(f.manifest).completed.at(-1)!.locator; beginAuthoringAttempt(storage, f.manifest, original); h.memory.reload(); resolve(h.page); await settle(); expect(stored()).toEqual({ ...f.manifest, pending: original }); expect(nodes(view.tree).some(n => n.type === 'MandateAuthoringRecoveryPanel')).toBe(true); expect(h.replace).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects a changed local preparation after fresh-context read without overwriting its history', async () => {
    const f = await fixture(), old = complete(f.manifest); save(old); let resolve!: (value: any) => void; h.readPage.mockImplementation(() => new Promise(r => { resolve = r; })); mount({ proposalId: f.proposal.id, version: '1' }); click('Start fresh preparation');
    const replacement = { ...old, preparationId: 'another_preparation' }; save(replacement); resolve(h.page); await settle(); expect(stored()).toEqual(replacement); expect(text(view.tree)).toContain('saved preparation changed'); expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects a revision that becomes terminal after the eligible start control was rendered', async () => {
    const f = await fixture(), old = complete(f.manifest); save(old); mount({ proposalId: f.proposal.id, version: '1' }); const control = button('Start fresh preparation');
    const changed = structuredClone(f.review); changed.envelope.decision!.state = 'REJECTED'; h.readReview.mockResolvedValue({ data: changed, receivedAt: now, receivedMonotonic: 0 }); control.props.onClick(); await settle(); expect(stored()).toEqual(old); expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects current coordination denial after the new-preparation click', async () => {
    const f = await retainedRevision(); expire(); mount(); const control = button('Start a distinct new proposal'); h.c1 = { slot: { state: 'blocked' } }; control.props.onClick(); await settle(); expect(stored()).toEqual(f.manifest); expect(fetch).not.toHaveBeenCalled();
  });
  it('disables a distinct-new start when local inventory is unreadable or current authority is unavailable', async () => {
    await retainedRevision(); expire(); h.memory.inventory.blocked = true; mount(); expect(button('Start a distinct new proposal').props.disabled).toBe(true); h.memory.inventory.blocked = false; h.page.data.eligibility = []; view.render(); expect(button('Start a distinct new proposal').props.disabled).toBe(true); expect(fetch).not.toHaveBeenCalled();
  });
  it('does not replace local preparation after navigation during the current read', async () => {
    const f = await retainedRevision(); expire(); let resolve!: (value: any) => void; h.readPage.mockImplementation(() => new Promise(r => { resolve = r; })); mount({ proposalId: f.proposal.id, version: '1' }); click('Start a distinct new proposal'); view.unmount(); resolve(h.page); await turn(); await turn(); expect(stored()).toEqual(f.manifest); expect(h.replace).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it('ignores a duplicate deliberate start while the first current-context read is pending', async () => {
    await retainedRevision(); expire(); let resolve!: (value: any) => void; h.readPage.mockImplementation(() => new Promise(r => { resolve = r; })); mount(); const control = button('Start a distinct new proposal'); control.props.onClick(); control.props.onClick(); expect(h.readPage).toHaveBeenCalledOnce(); resolve(h.page); await settle(); expect(stored().mode.kind).toBe('new'); expect(fetch).not.toHaveBeenCalled();
  });
});


describe('explicit authoring focus after the simulated host commit', () => {
  it.each(['normal', 'reduced', 'off'] as const)('focuses and reveals a visible start result after commit in %s mode', async mode => {
    await fixture(); h.mode = mode; mount(); expect(h.focusEvents).toEqual([]); click('Start preparation'); expect(h.focusEvents).toEqual([]); await settle();
    const events = h.focusEvents; expect(events.map(event => event.kind)).toEqual(['focus', 'scroll']); expect(events[0]!.text).toContain('Current context is pinned'); expect(events[1]!.options.behavior).toBe(mode === 'normal' ? 'smooth' : 'instant');
  });
  it('focuses repeated delayed errors only after visible status commits and offers a current-step return', async () => {
    const f = await fixture(); save(f.manifest); mount(); h.readPage.mockRejectedValue(new RequestError('INVALID_INPUT', 'Check the required document input.'));
    const editor = () => nodes(view.render()).find(node => node.type === 'MandateDocumentEditor'); editor().props.onReview(); expect(h.focusEvents).toEqual([]); await settle(); expect(h.focusEvents[0]!.text).toContain('Check the required document input.'); expect(button('Review current step')).toBeDefined();
    const previous = h.focusEvents.length; editor().props.onReview(); expect(h.focusEvents).toHaveLength(previous); await settle(); expect(h.focusEvents).toHaveLength(previous + 2);
    click('Review current step'); expect(h.focusEvents).toHaveLength(previous + 2); view.render(); expect(h.focusEvents.at(-2)!.text).toContain('Review acceptance terms');
  });
  it('focuses a visible result from the already-qualified recovery callback after commit', async () => {
    const f = await fixture(), original = complete(f.manifest).completed[0]!.locator; save({ ...f.manifest, pending: original }); mount();
    const recovery = nodes(view.tree).find(node => node.type === 'MandateAuthoringRecoveryPanel');
    recovery.props.onComplete({ record: { envelope: { proposal: { version: 2 }, decision: { state: 'OPEN' } } } }); expect(h.focusEvents).toEqual([]); view.render(); expect(h.focusEvents[0]!.text).toContain('Proposal version 2 is recorded'); expect(h.focusEvents[1]!.kind).toBe('scroll');
  });
  it('does not replay focus for clock, query or motion preference updates', async () => {
    await fixture(); mount(); click('Start preparation'); await settle(); h.focusEvents = []; h.clock++; h.mode = 'reduced'; view.render(); h.mode = 'off'; h.matches = false; view.render(); expect(h.focusEvents).toEqual([]);
  });
  it('consumes an explicit result focus request while hidden without stealing focus on return', async () => {
    await fixture(); mount(); let resolve!: (value: any) => void; h.readPage.mockImplementation(() => new Promise(r => { resolve = r; })); click('Start preparation'); h.hidden = true; resolve(h.page); await settle(); expect(h.focusEvents).toEqual([]); h.hidden = false; view.render(); expect(h.focusEvents).toEqual([]);
  });
  it('reveals explicit step changes immediately for keyboard input', async () => {
    const f = await fixture(); save(f.manifest); h.keyboard = true; mount(); expect(h.focusEvents).toEqual([]); click('Acceptance document'); expect(h.focusEvents).toEqual([]); view.render(); expect(h.focusEvents[0]!.text).toContain('Review acceptance terms'); expect(h.focusEvents[1]!.options.behavior).toBe('instant');
  });
});
