'use client';

import { useLayoutEffect, type RefObject } from 'react';
import { useMotion } from '../motion';

const revealSelector = [
  '.mk-section-heading', '.mk-feature', '.mk-case-card',
  '.mk-status-card', '.mk-dark-features > article', '.mk-editorial-points > article',
  '.mk-rule', '.mk-step:not(.mk-journey-step)', '.mk-reading', '.mk-quote',
  '.mk-closing > *', '.mk-principle-strip > *', '.mk-explorer', '.mk-evidence',
  '.mk-detail-summary', '.mk-footer-top > *',
  '.mk-footer-bottom', '.mk-process-input', '.mk-tool-integrations-note',
  '.mk-tool-integrations-copy > .mk-text-link', '.mk-journey-intro',
].join(',');

const clamp = (value: number) => Math.min(1, Math.max(0, value));

// Production CSS may shorten 1100ms to 1.1s. WAAPI always expects milliseconds.
function milliseconds(value: string, fallback: number) {
  const number = parseFloat(value);
  if (!Number.isFinite(number)) return fallback;
  const unit = value.trim();
  if (unit.endsWith('ms')) return number;
  if (unit.endsWith('s')) return number * 1000;
  return fallback;
}

/** Enhances server-rendered reading; no content depends on animation finishing. */
export function useMarketingMotion(root: RefObject<HTMLDivElement | null>, path: string) {
  const { mode, keyboard } = useMotion();

  useLayoutEffect(() => {
    const node = root.current;
    if (!node) return;
    if (node.dataset.motionPath !== path) {
      node.dataset.motionPath = path;
      delete node.dataset.heroSettled;
    }
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const printMedia = matchMedia('print');
    if (mode !== 'normal' || media.matches) { node.dataset.heroSettled = 'true'; return; }

    const tokens = getComputedStyle(node);
    const duration = milliseconds(tokens.getPropertyValue('--mk-reveal'), 1100);
    const stagger = milliseconds(tokens.getPropertyValue('--mk-stagger'), 80);
    const travel = parseFloat(tokens.getPropertyValue('--mk-travel')) || 40;
    const easing = tokens.getPropertyValue('--mk-scene-ease').trim() || 'cubic-bezier(.37,0,.63,1)';
    const response = milliseconds(tokens.getPropertyValue('--mk-scroll-response'), 180);
    const animations = new Map<HTMLElement, Animation>();
    const seen = new Set<HTMLElement>();
    const pending = new Set<HTMLElement>();
    let disposed = false;
    let frame = 0;

    function cancelArrivals() {
      for (const animation of animations.values()) animation.cancel();
      animations.clear();
    }
    function reveal(target: HTMLElement, immediate = false) {
      observer.unobserve(target);
      pending.delete(target);
      delete target.dataset.reveal;
      target.dataset.revealed = 'true';
      if (immediate || keyboard.current || media.matches || target.contains(document.activeElement)) return;
      const siblings = target.parentElement
        ? [...target.parentElement.children].filter(sibling => seen.has(sibling as HTMLElement)) : [];
      const delay = Math.min(3, Math.max(0, siblings.indexOf(target))) * stagger;
      const animation = target.animate([
        { opacity: 0, transform: `translate3d(0,${travel}px,0)` },
        { opacity: 1, transform: 'none' },
      ], { duration, delay, easing, fill: 'backwards' });
      animations.set(target, animation);
      const release = () => { if (animations.get(target) === animation) animations.delete(target); };
      animation.finished.then(release, release);
    }
    const onIntersection: IntersectionObserverCallback = entries => {
      if (disposed || document.hidden) return;
      for (const entry of entries) {
        if (entry.isIntersecting && pending.has(entry.target as HTMLElement)) reveal(entry.target as HTMLElement);
      }
    };
    function createObserver() {
      return new IntersectionObserver(onIntersection, {
        rootMargin: `0px 0px -${Math.round(innerHeight * .14)}px 0px`, threshold: 0,
      });
    }
    let observer = createObserver();
    function register() {
      if (disposed) return;
      // Read geometry first; arm only content below the reading area, never the hero.
      const candidates = [...node!.querySelectorAll<HTMLElement>(revealSelector)]
        .filter(target => !seen.has(target) && !target.parentElement?.closest(revealSelector)
          && !target.closest('.mk-page-hero, .mk-home-hero'))
        .map(target => ({ target, top: target.getBoundingClientRect().top }));
      for (const { target, top } of candidates) {
        seen.add(target);
        if (target.dataset.revealed === 'true') continue;
        if (top < innerHeight * .82 || keyboard.current || target.contains(document.activeElement)) {
          target.dataset.revealed = 'true';
          continue;
        }
        target.dataset.reveal = 'pending';
        pending.add(target);
        observer.observe(target);
      }
    }
    register();

    const progress = node.querySelector<HTMLElement>('.mk-reading-progress');
    const shadow = node.querySelector<HTMLElement>('.mk-header-depth');
    const toolGrid = node.querySelector<HTMLElement>('.mk-tool-integrations-grid');
    const tiles = [...node.querySelectorAll<HTMLElement>('.mk-tool-tile')].map(tile => ({
      tile, x: (Number(tile.style.gridColumn) - 3) * 24,
      y: (Number(tile.style.gridRow) - 3) * 24,
      brand: tile.classList.contains('mk-tool-tile-brand'),
    }));
    const process = node.querySelector<HTMLElement>('.mk-process-diagram');
    const lines = [...node.querySelectorAll<HTMLElement>('.mk-process-thread > span')];
    const fold = node.querySelector<HTMLElement>('.mk-process-thread > img');
    const receipt = node.querySelector<HTMLElement>('.mk-process-output');
    const changed = [progress, shadow, fold, receipt, ...lines, ...tiles.map(item => item.tile)].filter((item): item is HTMLElement => !!item);

    const phases: { tool: number | null; process: number | null } = { tool: null, process: null };
    let lastFrame = 0;
    function clearScroll() {
      phases.tool = null; phases.process = null;
      for (const target of changed) { target.style.removeProperty('transform'); target.style.removeProperty('opacity'); }
    }
    function paint(time: number) {
      frame = 0;
      const dt = Math.min(64, lastFrame ? time - lastFrame : 16);
      lastFrame = time;
      let moving = false;
      function smooth(key: keyof typeof phases, value: number) {
        const target = (1 - Math.cos(Math.PI * value)) / 2;
        const current = phases[key] ?? target;
        const next = current + (target - current) * (1 - Math.exp(-dt / response));
        moving ||= Math.abs(target - next) > .001;
        phases[key] = Math.abs(target - next) > .001 ? next : target;
        return phases[key]!;
      }
      if (disposed || document.hidden || media.matches) return;
      // All geometry reads precede writes. Scroll never drives a React render here.
      const height = innerHeight;
      const scroll = scrollY;
      const total = document.documentElement.scrollHeight - height;
      const toolRect = toolGrid?.getBoundingClientRect();
      const processRect = process?.getBoundingClientRect();
      const vertical = innerWidth <= 760;
      // The footer cannot cross an inset trigger once the document stops scrolling.
      const finalTargets = scroll >= total - 2 ? [...pending].filter(target => {
        const rect = target.getBoundingClientRect();
        return rect.top < height && rect.bottom > 0;
      }) : [];
      for (const target of finalTargets) reveal(target);
      if (progress) progress.style.transform = `scaleX(${total > 0 ? clamp(scroll / total) : 0})`;
      if (shadow) shadow.style.opacity = String(clamp(scroll / 120));
      if (keyboard.current) return;
      if (toolRect && toolRect.bottom > 0 && toolRect.top < height) {
        const p = smooth('tool', clamp((height * .92 - toolRect.top) / (height * .7)));
        for (const { tile, x, y, brand } of tiles) {
          tile.style.transform = `translate3d(${x * (1 - p)}px,${y * (1 - p)}px,0) scale(${brand ? .94 + .06 * p : 1})`;
          tile.style.opacity = String(.55 + .45 * p);
        }
      }
      if (processRect && processRect.bottom > 0 && processRect.top < height) {
        const p = smooth('process', clamp((height * .9 - processRect.top) / (height * .65)));
        lines.forEach((line, index) => { line.style.transform = `scale${vertical ? 'Y' : 'X'}(${clamp(p * 1.6 - index * .35)})`; });
        if (fold) fold.style.transform = `rotate(${(1 - p) * -12}deg) scale(${.92 + p * .08})`;
        if (receipt) { receipt.style.transform = `translate3d(0,${18 * (1 - p)}px,0)`; receipt.style.opacity = String(.65 + .35 * p); }
      }
      if (moving) schedule();
    }
    function schedule() { if (!frame && !disposed && !document.hidden) frame = requestAnimationFrame(paint); }
    function settle() {
      cancelArrivals(); cancelAnimationFrame(frame); frame = 0;
      clearScroll();
      if (document.hidden) node!.dataset.heroSettled = 'true';
      // IO can consume an intersection while the tab is hidden. Re-arm on return.
      if (!document.hidden) viewport();
    }
    function focus(event: FocusEvent) {
      if (!(event.target instanceof Node)) return;
      if (event.target instanceof Element && event.target.closest('.mk-home-hero, .mk-page-hero')) node!.dataset.heroSettled = 'true';
      for (const target of pending) if (target.contains(event.target)) reveal(target, true);
      for (const [target, animation] of animations) {
        if (target.contains(event.target)) { animation.cancel(); animations.delete(target); }
      }
    }
    function key() {
      node!.dataset.heroSettled = 'true';
      cancelArrivals(); clearScroll();
      // Includes find-in-page and keyboard scrolling: reading/focus always wins.
      for (const target of pending) reveal(target, true);
    }
    function viewport() {
      observer.disconnect(); observer = createObserver();
      for (const target of pending) observer.observe(target);
      schedule();
    }
    function pointerScroll() { keyboard.current = false; document.documentElement.dataset.input = 'pointer'; schedule(); }
    function preference() { if (media.matches) settle(); else schedule(); }
    function print() { if (printMedia.matches) key(); }
    const resize = new ResizeObserver(schedule);
    resize.observe(node);
    const mutations = new MutationObserver(() => { register(); schedule(); });
    mutations.observe(node, { childList: true, subtree: true });
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('wheel', pointerScroll, { passive: true });
    window.addEventListener('touchstart', pointerScroll, { passive: true });
    window.addEventListener('resize', viewport);
    document.addEventListener('visibilitychange', settle);
    document.addEventListener('keydown', key, true);
    window.addEventListener('beforeprint', key);
    node.addEventListener('focusin', focus);
    media.addEventListener('change', preference);
    printMedia.addEventListener('change', print);
    document.fonts.ready.then(schedule);
    schedule();

    return () => {
      disposed = true;
      cancelAnimationFrame(frame); cancelArrivals(); clearScroll();
      observer.disconnect(); resize.disconnect(); mutations.disconnect();
      for (const target of pending) delete target.dataset.reveal;
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('wheel', pointerScroll);
      window.removeEventListener('touchstart', pointerScroll);
      window.removeEventListener('resize', viewport);
      document.removeEventListener('visibilitychange', settle);
      document.removeEventListener('keydown', key, true);
      window.removeEventListener('beforeprint', key);
      node.removeEventListener('focusin', focus);
      media.removeEventListener('change', preference);
      printMedia.removeEventListener('change', print);
    };
  }, [root, path, mode, keyboard]);
}
