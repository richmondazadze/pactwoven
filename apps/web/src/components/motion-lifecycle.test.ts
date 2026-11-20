import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MotionProvider, RouteArrival, useArrival, useReversibleHeight } from './motion';

const h = vi.hoisted(() => ({ frame: null as any, context: null as any, path: '/app/work' }));
vi.mock('next/navigation', () => ({ usePathname: () => h.path }));
vi.mock('react', async original => ({ ...await original<any>(),
  useContext: () => h.context,
  useCallback: (fn: any) => fn,
  useState: (initial: any) => { const f = h.frame, i = f.cursor++; if (!(i in f.cells)) f.cells[i] = typeof initial === 'function' ? initial() : initial; return [f.cells[i], (v: any) => { f.cells[i] = typeof v === 'function' ? v(f.cells[i]) : v; }]; },
  useRef: (initial: any) => { const f = h.frame, i = f.cursor++; return f.cells[i] ?? (f.cells[i] = { current: initial }); },
  useEffect: effect,
  useLayoutEffect: effect,
}));
function effect(fn: any, deps: any[]) {
  const f = h.frame, i = f.cursor++, old = f.cells[i];
  if (!old || deps.some((v, n) => !Object.is(v, old.deps[n]))) {
    f.cells[i] = { deps, cleanup: old?.cleanup };
    f.effects.push(() => { old?.cleanup?.(); f.cells[i].cleanup = fn(); });
  }
}
const mounted: any[] = [];
function frame(render: () => any) {
  const f = { cursor: 0, cells: [] as any[], effects: [] as any[] };
  const v = { render() { f.cursor = 0; f.effects = []; h.frame = f; return render(); }, flush() { f.effects.splice(0).forEach(run => run()); }, unmount() { f.cells.forEach(c => c?.cleanup?.()); } };
  mounted.push(v); return v;
}
let doc: EventTarget & { hidden: boolean; documentElement: { dataset: Record<string, string> } };
let win: EventTarget & { matchMedia: () => any };
let media: EventTarget & { matches: boolean };
let animations: any[];
function node() { return { animate: vi.fn((frames, options) => { const animation = { frames, options, playState: 'running', finished: new Promise(() => {}), cancel: vi.fn() }; animations.push(animation); return animation; }) }; }
function provider() { const view = frame(() => MotionProvider({ children: null })); const tree = view.render(); h.context = tree.props.value; return view; }
function arrival(route = false) { const view = frame(() => route ? RouteArrival({ children: null }).props.ref : useArrival('result')); const ref = view.render(); ref.current = node(); view.flush(); return view; }
beforeEach(() => {
  doc = Object.assign(new EventTarget(), { hidden: false, documentElement: { dataset: {} } });
  media = Object.assign(new EventTarget(), { matches: false });
  win = Object.assign(new EventTarget(), { matchMedia: () => media });
  vi.stubGlobal('document', doc); vi.stubGlobal('window', win); vi.stubGlobal('getComputedStyle', () => ({ opacity: '.8', transform: 'translateY(2px)' }));
  h.context = null; h.path = '/app/work'; animations = [];
});
afterEach(() => { mounted.splice(0).reverse().forEach(v => v.unmount()); vi.unstubAllGlobals(); });

describe('shared motion lifecycle', () => {
  it('keeps the initial visible route arrival instead of cancelling it during provider mount', () => {
    const p = provider(); arrival(true); p.flush();
    expect(animations).toHaveLength(1); expect(animations[0].options.duration).toBe(200);
    expect(animations[0].cancel).not.toHaveBeenCalled(); expect(doc.documentElement.dataset.visibility).toBe('visible');
  });
  it('settles an in-flight arrival immediately when keyboard navigation starts', () => {
    const p = provider(); p.flush(); arrival();
    doc.dispatchEvent(new Event('keydown'));
    expect(animations[0].cancel).toHaveBeenCalledOnce(); expect(doc.documentElement.dataset.input).toBe('keyboard');
    arrival(); expect(animations).toHaveLength(1);
  });
  it('does not replay an arrival on identical render or when a hidden tab is shown', () => {
    const p = provider(); p.flush(); const a = arrival(); a.render(); a.flush();
    expect(animations).toHaveLength(1);
    doc.hidden = true; doc.dispatchEvent(new Event('visibilitychange'));
    expect(animations[0].cancel).toHaveBeenCalledOnce();
    doc.hidden = false; doc.dispatchEvent(new Event('visibilitychange'));
    expect(animations).toHaveLength(1); expect(doc.documentElement.dataset.visibility).toBe('visible');
  });
  it('mounting in a hidden tab sets visibility and never starts a route animation', () => {
    doc.hidden = true; const p = provider(); arrival(true); p.flush();
    expect(animations).toHaveLength(0); expect(doc.documentElement.dataset.visibility).toBe('hidden');
  });
  it('OS reduced motion uses only opacity before provider state catches up', () => {
    const p = provider(); p.flush(); media.matches = true; arrival();
    expect(animations[0].frames.every((f: any) => !('transform' in f))).toBe(true);
    expect(animations[0].options.duration).toBe(120);
  });
  it('settles disclosure height without animation when opened while hidden', () => {
    const p = provider(); p.flush(); doc.hidden = true;
    const view = frame(() => useReversibleHeight(true)); const ref = view.render();
    const element = { ...node(), style: { height: '' }, scrollHeight: 180, getBoundingClientRect: () => ({ height: 0 }) };
    ref.current = element; view.flush();
    expect(element.style.height).toBe('auto'); expect(animations).toHaveLength(0);
  });
  it('switching motion off cancels active animation and does not start another', () => {
    const p = provider(); p.flush(); arrival(); h.context.setPreference('off');
    h.context = p.render().props.value; p.flush(); arrival();
    expect(animations[0].cancel).toHaveBeenCalledOnce(); expect(animations).toHaveLength(1);
    expect(doc.documentElement.dataset.motion).toBe('off');
  });
});
