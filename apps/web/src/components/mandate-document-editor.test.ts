import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuthoringManifest, createDocumentAuthoringCapsule } from '../lib/mandate-authoring';
import { mandateReadFixture, mandateFixtureNow as now } from '../lib/mandates.test-fixtures';
import { MandateDocumentEditor } from './mandate-document-editor';
import { MandateProposalEditor } from './mandate-proposal-editor';

// Simulated host commits attach focus targets before layout effects; real viewport
// reveal logic runs. This checks event/commit ordering, not browser geometry or AT.
const h = vi.hoisted(() => ({ active: null as any, mode: 'normal' as 'normal' | 'reduced' | 'off', keyboard: false, reduced: false, hidden: false, events: [] as { kind: string; target: string; options: any }[] }));
vi.mock('react', async original => ({ ...(await original<any>()), useId: () => 'editor_focus_test', useRef: (initial: any) => { const f = h.active, i = f.cursor++; return f.cells[i] ?? (f.cells[i] = { current: initial }); }, useLayoutEffect: (callback: any, deps: any[]) => h.active.effect(callback, deps), useEffectEvent: (callback: any) => callback }));
vi.mock('./motion', () => ({ useArrival: () => ({ current: null }), useMotion: () => ({ mode: h.mode, keyboard: { current: h.keyboard } }) }));
vi.mock('./mandate-authoring-review', () => ({ MandateAuthoringReview: 'MandateAuthoringReview', MandateSavedDocument: 'MandateSavedDocument' }));
vi.mock('./ui', () => ({ ActionLabel: 'ActionLabel', Panel: 'Panel', StatusBadge: 'StatusBadge' }));
function nodes(node: any): any[] { if (node == null || typeof node !== 'object') return []; if (Array.isArray(node)) return node.flatMap(nodes); return [node, ...nodes(node.props?.children)]; }
function text(node: any): string { if (node == null || typeof node === 'boolean') return ''; if (typeof node === 'string') return node; if (Array.isArray(node)) return node.map(text).join(' '); return `${node.props?.label ?? ''} ${text(node.props?.children)}`; }
class Hooks {
  cells: any[] = []; effects: any[] = []; queued: (() => void)[] = []; cursor = 0; tree: any; committed = new Map<any, any>();
  constructor(public component: () => any = () => MandateDocumentEditor(props)) {}
  effect(callback: any, deps: any[]) { const i = this.cursor++, old = this.effects[i]; if (!old || deps.some((value, j) => !Object.is(value, old.deps[j]))) this.queued.push(() => { old?.cleanup?.(); this.effects[i] = { deps, cleanup: callback() }; }); }
  render() {
    this.cursor = 0; h.active = this; this.tree = this.component(); const attached = new Set<any>();
    for (const node of nodes(this.tree)) {
      const ref = node.props?.ref; if (!ref || typeof ref !== 'object') continue; attached.add(ref);
      const target = this.committed.get(ref) ?? { label: '', focus(options: any) { h.events.push({ kind: 'focus', target: this.label, options }); }, scrollIntoView(options: any) { h.events.push({ kind: 'scroll', target: this.label, options }); } };
      target.label = node.type === 'textarea' ? 'Full mandate policy textarea' : node.type === 'input' ? 'Policy expires at (UTC)' : text(node).trim(); this.committed.set(ref, target); ref.current = target;
    }
    for (const [ref] of this.committed) if (!attached.has(ref)) { ref.current = null; this.committed.delete(ref); }
    for (const effect of this.queued.splice(0)) effect(); return this.tree;
  }
  unmount() { for (const effect of this.effects) effect?.cleanup?.(); for (const [ref] of this.committed) ref.current = null; this.committed.clear(); }
}
let view: Hooks, props: Parameters<typeof MandateDocumentEditor>[0];
async function fixture(purpose: 'ACCEPTANCE_POLICY' | 'MANDATE_POLICY' = 'ACCEPTANCE_POLICY', long = false) {
  const f = await mandateReadFixture(false); f.page.eligibility = [{ action: 'PROPOSE', eligible: true, requiresStepUp: false, blockers: [] }];
  const observation = { data: f.page, receivedAt: now, receivedMonotonic: 0 }, manifest = await createAuthoringManifest(f.scope, observation, 'editor_preparation', { acceptanceDocumentId: 'acceptance_a', policyDocumentId: 'policy_a', proposalId: 'proposal_a', mandateId: 'mandate_a' }, now);
  const value = purpose === 'ACCEPTANCE_POLICY' ? f.page.responsibility.acceptancePolicy : long ? 'Policy\n' + 'x'.repeat(19993) : 'Advice-only policy';
  const capsule = await createDocumentAuthoringCapsule(f.scope, manifest, observation, purpose, value, 'editor_review_request', now);
  props = { purpose, text: value, onText: vi.fn(), capsule: null, saved: null, current: f.page, busy: false, disabled: false, fresh: true, hasSavedReference: false, onReadSaved: vi.fn(), onReview: vi.fn(), onSave: vi.fn(), onEdit: vi.fn(() => { props = { ...props, capsule: null }; }), onContinue: vi.fn() };
  view = new Hooks(); view.render(); return capsule;
}
function back() { const button = nodes(view.tree).find(node => node.type === 'button' && text(node).includes('Back to editing')); expect(button).toBeDefined(); button.props.onClick(); }
beforeEach(() => { h.mode = 'normal'; h.keyboard = false; h.reduced = false; h.hidden = false; h.events = []; vi.stubGlobal('document', { get hidden() { return h.hidden; } }); vi.stubGlobal('window', { matchMedia: () => ({ matches: h.reduced }) }); vi.stubGlobal('requestAnimationFrame', vi.fn(() => { throw new Error('Focus must not wait for an animation frame.'); })); });
afterEach(() => { view?.unmount(); vi.unstubAllGlobals(); });
describe('explicit document review and editing focus', () => {
  it.each(['normal', 'reduced', 'off'] as const)('returns acceptance Back to a committed real heading in %s mode', async mode => {
    const capsule = await fixture(); h.mode = mode; expect(h.events).toEqual([]); props = { ...props, capsule }; view.render(); h.events = []; back(); expect(h.events).toEqual([]); view.render();
    expect(h.events.map(event => [event.kind, event.target])).toEqual([['focus', 'Acceptance policy text'], ['scroll', 'Acceptance policy text']]); expect(h.events[1]!.options.behavior).toBe(mode === 'normal' ? 'smooth' : 'instant'); expect(props.onEdit).toHaveBeenCalledOnce(); expect(requestAnimationFrame).not.toHaveBeenCalled();
  });
  it('retains the textarea destination for policy Back and reveals it immediately for keyboard use', async () => {
    const capsule = await fixture('MANDATE_POLICY'); h.keyboard = true; props = { ...props, capsule }; view.render(); h.events = []; back(); expect(h.events).toEqual([]); view.render(); expect(h.events[0]!.target).toBe('Full mandate policy textarea'); expect(h.events[1]!.options.behavior).toBe('instant'); expect(props.onText).not.toHaveBeenCalled();
  });
  it.each(['normal', 'reduced', 'off', 'keyboard', 'os-reduced'] as const)('focuses then reveals the exact heading after a long-text review commit in %s mode', async mode => {
    const capsule = await fixture('MANDATE_POLICY', true); if (mode === 'keyboard') h.keyboard = true; else if (mode === 'os-reduced') h.reduced = true; else h.mode = mode;
    expect(props.text).toHaveLength(20000); props = { ...props, capsule }; expect(h.events).toEqual([]); view.render(); expect(h.events.map(event => event.kind)).toEqual(['focus', 'scroll']); expect(h.events[0]!.target).toBe('Review the complete document before saving'); expect(h.events[1]!.options).toEqual({ behavior: mode === 'normal' ? 'smooth' : 'instant', block: 'start', inline: 'nearest' }); expect(props.onSave).not.toHaveBeenCalled(); expect(requestAnimationFrame).not.toHaveBeenCalled();
  });
  it('does not refocus for preference, freshness or busy-state updates', async () => {
    const capsule = await fixture(); props = { ...props, capsule }; view.render(); h.events = []; h.mode = 'reduced'; props = { ...props, fresh: false }; view.render(); h.mode = 'off'; props = { ...props, busy: true }; view.render(); expect(h.events).toEqual([]);
  });
  it('does not move to editing on an automatic capsule clear without a Back action', async () => { const capsule = await fixture(); props = { ...props, capsule }; view.render(); h.events = []; props = { ...props, capsule: null }; view.render(); expect(h.events).toEqual([]); });
  it('does not steal focus when Back completes while the page is hidden', async () => { const capsule = await fixture(); props = { ...props, capsule }; view.render(); h.events = []; h.hidden = true; back(); view.render(); expect(h.events).toEqual([]); h.hidden = false; view.render(); expect(h.events).toEqual([]); });
});


describe('explicit proposal review and terms focus', () => {
  // Review content is a stub in this focus harness; only its immutable identity
  // selects the transition. Domain proposal construction is tested separately.
  const capsule = { integrityHash: 'proposal_exact_review_identity' } as NonNullable<Parameters<typeof MandateProposalEditor>[0]['capsule']>;
  let proposalProps: Parameters<typeof MandateProposalEditor>[0];
  function proposalFixture() {
    proposalProps = { policyExpiry: '2026-11-16T10:00:00', reviewDeadline: '2026-11-16T09:00:00', onDates: vi.fn(), capsule: null, busy: false, disabled: false, fresh: true, site: 'Current site', onReview: vi.fn(), onSubmit: vi.fn(), onEdit: vi.fn(() => { proposalProps = { ...proposalProps, capsule: null }; }) };
    view = new Hooks(() => MandateProposalEditor(proposalProps)); view.render();
  }
  it.each(['normal', 'reduced', 'off', 'keyboard'] as const)('reveals committed proposal review and Back-to-terms targets in %s mode', mode => {
    proposalFixture(); if (mode === 'keyboard') h.keyboard = true; else h.mode = mode; expect(h.events).toEqual([]); proposalProps = { ...proposalProps, capsule }; view.render();
    expect(h.events[0]!.target).toBe('Review the complete proposal'); expect(h.events[1]!.options.behavior).toBe(mode === 'normal' ? 'smooth' : 'instant'); h.events = [];
    nodes(view.tree).find(node => node.type === 'button' && text(node).includes('Back to terms')).props.onClick(); expect(h.events).toEqual([]); view.render(); expect(h.events[0]!.target).toBe('Policy expires at (UTC)'); expect(h.events[1]!.options.behavior).toBe(mode === 'normal' ? 'smooth' : 'instant'); expect(proposalProps.onSubmit).not.toHaveBeenCalled(); expect(proposalProps.onDates).not.toHaveBeenCalled(); expect(requestAnimationFrame).not.toHaveBeenCalled();
  });
  it('does not replay proposal focus for automatic state/preference updates or automatic review removal', () => {
    proposalFixture(); proposalProps = { ...proposalProps, capsule }; view.render(); h.events = []; h.mode = 'reduced'; proposalProps = { ...proposalProps, fresh: false }; view.render(); proposalProps = { ...proposalProps, capsule: null }; view.render(); expect(h.events).toEqual([]);
  });
});
