import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalJson } from '@pactwoven/contracts/canonical';
import { createAuthorityCapsule, qualifyAuthorityReceipt } from '../lib/mandate-authority';
import { createAuthoringManifest, createDocumentAuthoringCapsule } from '../lib/mandate-authoring';
import { beginAuthoringAttempt, locatorFromAuthoringCapsule, storeAuthoringManifest } from '../lib/mandate-authoring-recovery';
import { authorityWork, listAuthorityRecovery, locatorFromAuthorityCapsule, storeAuthorityRecovery } from '../lib/mandate-authority-recovery';
import { storeMandateRecovery } from '../lib/mandate-recovery';
import { decisionTestCase, mandateReadFixture, mandateFixtureNow as now } from '../lib/mandates.test-fixtures';
import { MandateAuthoringMemoryProvider } from './mandate-authoring-memory';
import { MandateAuthorityMemoryProvider, type MandateAuthorityMemory } from './mandate-authority-memory';

// Real provider hook/state and shared coordinator callbacks; simulated effects and
// context hosts. This does not exercise React DOM or browser storage permissions.
const h = vi.hoisted(() => ({ active: null as any, authoring: null as any, c1: null as any }));
vi.mock('react', async original => ({ ...(await original<any>()), useState: (initial: any) => { const f = h.active, i = f.cursor++; if (!(i in f.cells)) f.cells[i] = typeof initial === 'function' ? initial() : initial; return [f.cells[i], (next: any) => { const value = typeof next === 'function' ? next(f.cells[i]) : next; if (!Object.is(value, f.cells[i])) { f.cells[i] = value; f.dirty = true; } }]; }, useRef: (initial: any) => { const f = h.active, i = f.cursor++; return f.cells[i] ?? (f.cells[i] = { current: initial }); }, useLayoutEffect: (effect: any, deps: any[]) => h.active.effect(effect, deps) }));
vi.mock('./mandate-recovery-memory', () => ({ useMandateRecoveryMemory: () => h.c1 }));
vi.mock('./mandate-authoring-memory', async original => ({ ...(await original<any>()), useMandateAuthoringMemory: () => h.authoring }));
class Hooks {
  cells: any[] = []; effects: any[] = []; queued: (() => void)[] = []; cursor = 0; dirty = false; value: any;
  constructor(public component: () => any) {}
  effect(callback: any, deps: any[]) { const i = this.cursor++, old = this.effects[i]; if (!old || deps.some((v, j) => !Object.is(v, old.deps[j]))) this.queued.push(() => { old?.cleanup?.(); this.effects[i] = { deps, cleanup: callback() }; }); }
  render() { for (let i = 0; i < 20; i++) { this.cursor = 0; this.dirty = false; h.active = this; this.value = this.component().props.value; for (const effect of this.queued.splice(0)) effect(); if (!this.dirty) return this.value; } throw new Error('Unstable provider'); }
  unmount() { for (const effect of this.effects) effect?.cleanup?.(); }
}
function storage() { const values = new Map<string, string>(); return { get length() { return values.size; }, key: (i: number) => [...values.keys()][i] ?? null, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } }; }
let parent: Hooks, view: Hooks, store: ReturnType<typeof storage>, memory: MandateAuthorityMemory;
async function fixture() {
  const f = await mandateReadFixture(); f.page.eligibility = (['PAUSE', 'REVOKE'] as const).map(action => ({ action, eligible: true, requiresStepUp: false, blockers: [] }));
  const { responsibilityId: _, ...scope } = f.scope; store = storage(); vi.stubGlobal('window', { sessionStorage: store }); h.c1 = { hidden: false, deny: vi.fn(() => { h.c1.hidden = true; }) };
  parent = new Hooks(() => MandateAuthoringMemoryProvider({ scope, children: null })); h.authoring = parent.render(); view = new Hooks(() => MandateAuthorityMemoryProvider({ scope, children: null })); memory = view.render();
  const observation = { data: f.page, receivedAt: now, receivedMonotonic: 0 }, capsule = await createAuthorityCapsule(f.scope, observation, 'PAUSE', 'Preserve every original.', 'original_authority_key', now), locator = locatorFromAuthorityCapsule(capsule);
  const result = { schemaVersion: 1 as const, organizationId: f.scope.organizationId, kind: locator.kind, responsibilityId: f.scope.responsibilityId, target: locator.expectedTarget, commandHash: locator.commandHash, intentHash: locator.intentHash, observedAt: new Date(now).toISOString(), operation: { id: 'stop_operation', environment: f.scope.environment, status: 'succeeded' as const, aggregateId: locator.mandate.id, aggregateVersion: locator.expectedTarget.version, financialState: null, evidenceRefs: [], nextCheckAt: null, error: null } };
  return { ...f, observation, capsule, locator, result };
}
beforeEach(() => vi.clearAllMocks());
afterEach(() => { view?.unmount(); parent?.unmount(); vi.unstubAllGlobals(); });
describe('authority memory and shared inventory', () => {
  it('retains private input without storage writes and distinguishes every original kind/key', async () => { const f = await fixture(), revoke = await createAuthorityCapsule(f.scope, f.observation, 'REVOKE', 'A separate stop.', f.capsule.key, now); memory.retain(f.capsule); memory.retain(revoke); expect(store.length).toBe(0); expect(memory.original(f.locator)?.intent.reason).toBe('Preserve every original.'); expect(memory.original(locatorFromAuthorityCapsule(revoke))?.intent.action).toBe('REVOKE'); memory.releaseSelection(f.capsule); expect(memory.selected()).toEqual({ integrityHash: revoke.integrityHash }); });
  it('feeds all authority originals into shared coordination without waiting for an inventory render', async () => { const f = await fixture(), revoke = await createAuthorityCapsule(f.scope, f.observation, 'REVOKE', 'Separate revoke.', 'separate_revoke_key', now); storeAuthorityRecovery(store, f.locator); const request = { ...authorityWork(locatorFromAuthorityCapsule(revoke)), action: 'send' as const, hasHead: true, eligible: true }; const allowed = memory.work.acquire(request); memory.work.release(allowed); storeAuthorityRecovery(store, locatorFromAuthorityCapsule(revoke)); expect(() => memory.work.acquire({ ...request, key: 'another_revoke_key' })).toThrow(); memory.reload(); memory = view.render(); expect(memory.inventory.locators).toHaveLength(2); });
  it('keeps an unknown C1 decision recoverable while permitting an eligible stop', async () => { const f = await fixture(), c1 = await decisionTestCase(); storeMandateRecovery(store, c1.locator); const stop = memory.work.acquire({ ...authorityWork(f.locator), action: 'send', hasHead: true, eligible: true }); memory.work.release(stop); expect(() => memory.work.registerPreparation({ scope: f.locator.scope, responsibilityId: f.scope.responsibilityId, targetId: c1.locator.proposal.id, kind: 'AUTHORIZE', key: 'new_grant_key', integrityHash: 'a'.repeat(64) }, memory.work.generation(f.scope, f.scope.responsibilityId))).toThrow(); expect(store.length).toBe(1); });
  it('coordinates C1, C2 and all C3 originals together while preserving each storage namespace', async () => {
    const f = await fixture(), c1 = await decisionTestCase(), page = structuredClone(f.page); page.eligibility = [{ action: 'PROPOSE', eligible: true, requiresStepUp: false, blockers: [] }]; const observation = { data: page, receivedAt: now, receivedMonotonic: 0 };
    const manifest = await createAuthoringManifest(f.scope, observation, 'combined_preparation', { acceptanceDocumentId: 'combined_acceptance', policyDocumentId: 'combined_policy', proposalId: 'combined_proposal', mandateId: 'mandate_a' }, now), document = await createDocumentAuthoringCapsule(f.scope, manifest, observation, 'MANDATE_POLICY', 'Exact draft.', 'combined_document_key', now); storeAuthoringManifest(store, manifest); beginAuthoringAttempt(store, manifest, locatorFromAuthoringCapsule(document)); storeMandateRecovery(store, c1.locator); storeAuthorityRecovery(store, f.locator);
    const revoke = await createAuthorityCapsule(f.scope, f.observation, 'REVOKE', 'Stop independently.', 'combined_revoke_key', now), ticket = memory.work.acquire({ ...authorityWork(locatorFromAuthorityCapsule(revoke)), action: 'send', hasHead: true, eligible: true }); memory.work.release(ticket); expect(store.length).toBe(3); expect(() => memory.work.acquire({ ...authorityWork(f.locator), key: 'replacement_pause', action: 'send', hasHead: true, eligible: true })).toThrow(); h.authoring.reload(); h.authoring = parent.render(); expect(h.authoring.inventory.manifests[0].pending.key).toBe('combined_document_key'); memory.reload(); memory = view.render(); expect(memory.inventory.locators).toHaveLength(1); expect(store.length).toBe(3);
  });
  it('retains readable originals beside corruption and never treats blocked storage as terminal', async () => { const f = await fixture(); storeAuthorityRecovery(store, f.locator); store.setItem('pactwoven:mandate-authority:v1:broken', 'unreadable'); memory.reload(); memory = view.render(); expect(memory.inventory.blocked).toBe(true); expect(memory.inventory.locators).toHaveLength(1); expect(store.length).toBe(2); });
  it('pins qualified recorded results and rejects substitutions while preserving storage', async () => { const f = await fixture(); storeAuthorityRecovery(store, f.locator); memory.onPending(f.locator); memory.onRecorded(f.locator, f.result); expect(() => memory.onRecorded(f.locator, { ...f.result, commandHash: 'a'.repeat(64) })).toThrow(); memory.onQualified(qualifyAuthorityReceipt(f.result, f.locator)); memory = view.render(); expect(memory.receipts).toHaveLength(1); expect(memory.recorded(f.locator)).toEqual(f.result); expect(listAuthorityRecovery(store, f.scope).locators).toHaveLength(1); });
  it('uses ownership-specific busy cleanup without unlocking a newer original check', async () => { const f = await fixture(), old = memory.start(f.locator); expect(() => memory.start(f.locator)).toThrow(); memory.finish(f.locator, old); const next = memory.start(f.locator); memory.finish(f.locator, old); expect(memory.busy(f.locator)).toBe(true); memory.finish(f.locator, next); expect(memory.busy(f.locator)).toBe(false); });
  it('purges private state on denial, rejects late callbacks, and retains durable references', async () => { const f = await fixture(); memory.retain(f.capsule); storeAuthorityRecovery(store, f.locator); memory.onRecorded(f.locator, f.result); const before = canonicalJson(listAuthorityRecovery(store, f.scope)); memory.deny(); memory = view.render(); expect(memory.hidden).toBe(true); expect(memory.receipts).toEqual([]); expect(memory.inventory.locators).toEqual([]); expect(() => memory.retain(f.capsule)).toThrow(); expect(() => memory.onRecorded(f.locator, f.result)).toThrow(); expect(() => memory.selected()).toThrow(); expect(canonicalJson(listAuthorityRecovery(store, f.scope))).toBe(before); expect(h.c1.deny).toHaveBeenCalledOnce(); });
  it('rejects other sessions and actors without persisting their private review', async () => { const f = await fixture(); expect(() => memory.retain({ ...f.capsule, scope: { ...f.scope, sessionId: 'another_session' } })).toThrow(); expect(() => memory.recorded({ ...f.locator, scope: { ...f.locator.scope, actorId: 'another_actor' } })).toThrow(); expect(store.length).toBe(0); });
  it('unmount prevents late state restoration but leaves originals for matching-scope lookup', async () => { const f = await fixture(); memory.retain(f.capsule); storeAuthorityRecovery(store, f.locator); view.unmount(); expect(() => memory.retain(f.capsule)).toThrow(); expect(() => memory.onRecorded(f.locator, f.result)).toThrow(); expect(listAuthorityRecovery(store, f.scope).locators).toHaveLength(1); });
});


async function resumeCapsule(key: string) {
  const f = await decisionTestCase('AUTHORIZE'), review = structuredClone(f.outcomeReview), at = now + 2000;
  review.envelope.observedAt = new Date(at).toISOString(); review.envelope.head!.state = 'PAUSED'; review.envelope.head!.mandateEpoch = 2; review.effectiveAuthority = { state: 'PAUSED', blockers: ['AUTHORITY_PAUSED'] }; review.envelope.eligibility = [{ action: 'RESUME', eligible: true, requiresStepUp: true, blockers: [] }];
  return createAuthorityCapsule(f.scope, { data: review, receivedAt: at, receivedMonotonic: 0 }, 'RESUME', 'Keep this private resume reason.', key, at);
}
describe('RESUME authority memory without provider changes', () => {
  it('retains full private accepted review while durable storage keeps minimal independent all-kind originals', async () => {
    const f = await fixture(), resume = await resumeCapsule(f.capsule.key), revoke = await createAuthorityCapsule(f.scope, f.observation, 'REVOKE', 'Separate revocation.', f.capsule.key, now);
    for (const value of [f.capsule, resume, revoke]) memory.retain(value); expect(store.length).toBe(0);
    for (const value of [f.capsule, resume, revoke]) storeAuthorityRecovery(store, locatorFromAuthorityCapsule(value)); memory.reload(); memory = view.render();
    expect(new Set(memory.inventory.locators.map(value => value.kind))).toEqual(new Set(['mandate.pause', 'mandate.resume', 'mandate.revoke'])); expect(store.length).toBe(3); expect(memory.original(locatorFromAuthorityCapsule(resume))).toEqual(resume);
    const serialized = [...Array(store.length)].map((_, i) => store.getItem(store.key(i)!)).join(''); for (const privateValue of ['Keep this private resume reason.', 'Original delivery requirements.', 'Original mandate policy.', f.scope.sessionId]) expect(serialized).not.toContain(privateValue);
    memory.releaseSelection(resume); expect(memory.selected()).toEqual({ integrityHash: revoke.integrityHash }); expect(memory.original(locatorFromAuthorityCapsule(resume))?.intent.reason).toBe('Keep this private resume reason.');
  });
  it('denial revokes private RESUME callbacks while preserving every original byte', async () => {
    const f = await fixture(), resume = await resumeCapsule('resume_denied_key'); memory.retain(resume); for (const value of [f.capsule, resume]) storeAuthorityRecovery(store, locatorFromAuthorityCapsule(value)); const before = [...Array(store.length)].map((_, i) => [store.key(i), store.getItem(store.key(i)!)]);
    memory.deny(); memory = view.render(); expect(memory.hidden).toBe(true); expect(() => memory.original(locatorFromAuthorityCapsule(resume))).toThrow(); expect(() => memory.retain(resume)).toThrow(); expect(() => memory.select(resume)).toThrow(); expect([...Array(store.length)].map((_, i) => [store.key(i), store.getItem(store.key(i)!)])).toEqual(before);
  });
  it('unknown RESUME blocks a replacement grant immediately while a separately eligible stop remains available', async () => {
    const f = await fixture(), resume = await resumeCapsule('unknown_resume_key'), locator = locatorFromAuthorityCapsule(resume); memory.retain(resume); storeAuthorityRecovery(store, locator);
    expect(() => memory.work.registerPreparation({ ...authorityWork(locator), kind: 'RESUME', key: 'replacement_resume_key', integrityHash: resume.integrityHash }, memory.work.generation(f.scope, f.scope.responsibilityId))).toThrow();
    const stop = memory.work.acquire({ ...authorityWork(f.locator), action: 'send', hasHead: true, eligible: true }); memory.work.release(stop); expect(listAuthorityRecovery(store, f.scope).locators).toEqual([locator]); expect(memory.original(locator)).toEqual(resume);
  });
});
