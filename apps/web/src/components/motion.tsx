'use client';
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
export type MotionMode = 'normal' | 'reduced' | 'off';
type MotionContextValue = { mode: MotionMode; preference: MotionMode; setPreference: (mode: MotionMode) => void; keyboard: React.MutableRefObject<boolean> };
const MotionContext = createContext<MotionContextValue | null>(null);
const activeAnimations = new Set<Animation>();
export function MotionProvider({ children }: { children: ReactNode }) {
  const [preference, setPreference] = useState<MotionMode>('normal');
  const [reduced, setReduced] = useState(false);
  const keyboard = useRef(false);
  const mode = preference === 'off' ? 'off' : preference === 'reduced' || reduced ? 'reduced' : 'normal';
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(media.matches); update(); media.addEventListener('change', update);
    const key = (event: KeyboardEvent) => { if (!event.metaKey && !event.ctrlKey && !event.altKey) { keyboard.current = true; document.documentElement.dataset.input = 'keyboard'; } };
    const pointer = () => { keyboard.current = false; document.documentElement.dataset.input = 'pointer'; };
    const settle = () => { document.documentElement.dataset.visibility = document.hidden ? 'hidden' : 'visible'; for (const animation of activeAnimations) animation.cancel(); activeAnimations.clear(); };
    document.addEventListener('keydown', key, true); document.addEventListener('pointerdown', pointer, true);
    document.addEventListener('visibilitychange', settle); window.addEventListener('resize', settle);
    return () => { media.removeEventListener('change', update); document.removeEventListener('keydown', key, true); document.removeEventListener('pointerdown', pointer, true); document.removeEventListener('visibilitychange', settle); window.removeEventListener('resize', settle); settle(); };
  }, []);
  useEffect(() => { document.documentElement.dataset.motion = mode; for (const animation of activeAnimations) animation.cancel(); activeAnimations.clear(); }, [mode]);
  return <MotionContext value={{ mode, preference, setPreference, keyboard }}>{children}</MotionContext>;
}
export function useMotion() { const value = useContext(MotionContext); if (!value) throw new Error('MotionProvider is required'); return value; }
export function useArrival(trigger: unknown, duration = 120) {
  const ref = useRef<HTMLDivElement>(null); const { mode, keyboard } = useMotion();
  const current = useRef<Animation | null>(null);
  const previousMode = useRef<MotionMode | null>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    const effectiveMode = mode === 'normal' && window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'reduced' : mode;
    const modeChanged = previousMode.current !== null && previousMode.current !== effectiveMode;
    previousMode.current = effectiveMode;
    const previous = current.current;
    // Sample before cancellation removes the in-flight effect. Dependency cleanup would snap to the underlying final style first.
    const interrupted = node && previous && previous.playState !== 'finished' && previous.playState !== 'idle';
    const visible = interrupted ? getComputedStyle(node) : null;
    const from = effectiveMode === 'reduced'
      ? { opacity: visible?.opacity ?? .8 }
      : { opacity: visible?.opacity ?? .6, transform: visible?.transform ?? 'translateY(4px)' };
    previous?.cancel(); if (previous) activeAnimations.delete(previous); current.current = null;
    if (!node || modeChanged || effectiveMode === 'off' || keyboard.current || document.hidden || !node.animate) return;
    const animation = node.animate([from, effectiveMode === 'reduced' ? { opacity: 1 } : { opacity: 1, transform: 'none' }], { duration: effectiveMode === 'reduced' ? 120 : duration, easing: 'cubic-bezier(.23,1,.32,1)' });
    current.current = animation; activeAnimations.add(animation);
    const release = () => { activeAnimations.delete(animation); if (current.current === animation) current.current = null; };
    animation.finished.then(release).catch(release);
  }, [trigger, duration, mode, keyboard]);
  useLayoutEffect(() => () => { const animation = current.current; animation?.cancel(); if (animation) activeAnimations.delete(animation); current.current = null; }, []);
  return ref;
}
export function RouteArrival({ children }: { children: ReactNode }) { const path = usePathname(); const ref = useArrival(path); return <div ref={ref} className="route-content">{children}</div>; }
export function MotionPreference() {
  const { preference, setPreference } = useMotion();
  return <label className="motion-preference"><span>Motion</span><select value={preference} onChange={e => setPreference(e.target.value as MotionMode)} aria-label="Motion preference"><option value="normal">Full</option><option value="reduced">Reduced</option><option value="off">Off</option></select></label>;
}
export function useReversibleHeight(open: boolean) {
  const ref = useRef<HTMLDivElement>(null); const animation = useRef<Animation | null>(null); const { mode, keyboard } = useMotion();
  const animate = useCallback(() => {
    const node = ref.current; if (!node) return;
    const height = node.getBoundingClientRect().height;
    animation.current?.cancel();
    node.style.height = open ? 'auto' : '0px';
    const target = open ? node.scrollHeight : 0;
    if (mode !== 'normal' || window.matchMedia('(prefers-reduced-motion: reduce)').matches || keyboard.current || !node.animate) return;
    const next = node.animate([{ height: `${height}px` }, { height: `${target}px` }], { duration: 200, easing: 'cubic-bezier(.23,1,.32,1)' });
    animation.current = next; activeAnimations.add(next);
    next.finished.then(() => activeAnimations.delete(next)).catch(() => activeAnimations.delete(next));
  }, [open, mode, keyboard]);
  useEffect(() => { animate(); }, [animate]);
  useEffect(() => () => { animation.current?.cancel(); if (animation.current) activeAnimations.delete(animation.current); }, []);
  return ref;
}

export function useDrawerPresence(open: boolean) {
  const [present, setPresent] = useState(open);
  const ref = useRef<HTMLDivElement>(null);
  const animation = useRef<Animation | null>(null);
  const generation = useRef(0);
  const wasMounted = useRef(false);
  const { mode, keyboard } = useMotion();
  useLayoutEffect(() => {
    if (open && !present) { setPresent(true); return; }
    const node = ref.current;
    if (!node) return;
    const ticket = ++generation.current;
    const active = animation.current;
    const from = active ? getComputedStyle(node).transform : open && !wasMounted.current ? 'translateX(-100%)' : getComputedStyle(node).transform;
    active?.cancel(); if (active) activeAnimations.delete(active);
    wasMounted.current = true;
    const instant = mode !== 'normal' || keyboard.current || window.matchMedia('(prefers-reduced-motion: reduce)').matches || document.hidden || !node.animate;
    node.style.transform = open ? 'none' : 'translateX(-100%)';
    if (instant) { if (!open) { setPresent(false); wasMounted.current = false; } return; }
    const next = node.animate([{ transform: from }, { transform: open ? 'none' : 'translateX(-100%)' }], { duration: open ? 240 : 160, easing: 'cubic-bezier(.32,.72,0,1)' });
    animation.current = next; activeAnimations.add(next);
    next.finished.then(() => {
      activeAnimations.delete(next);
      if (ticket !== generation.current) return;
      animation.current = null;
      if (!open) { setPresent(false); wasMounted.current = false; }
    }).catch(() => {
      activeAnimations.delete(next);
      if (ticket === generation.current && !open) { setPresent(false); wasMounted.current = false; }
    });
  }, [open, present, mode, keyboard]);
  useEffect(() => () => { generation.current++; animation.current?.cancel(); if (animation.current) activeAnimations.delete(animation.current); }, []);
  return { present: open || present, ref };
}
