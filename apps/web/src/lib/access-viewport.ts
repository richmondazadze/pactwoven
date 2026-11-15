import type { MotionMode } from '../components/motion';
type FocusTarget = Pick<HTMLElement, 'focus' | 'scrollIntoView'>;
type ViewportMotion = { mode: MotionMode; keyboard: boolean; prefersReducedMotion: boolean; hidden: boolean };
export function revealAccessTarget(target: FocusTarget | null, motion: ViewportMotion) {
  if (!target) return;
  // Focus is immediate. Explicit instant behavior must override the document's smooth-scroll CSS.
  target.focus({ preventScroll: true });
  const behavior: ScrollBehavior = motion.mode === 'normal' && !motion.keyboard && !motion.prefersReducedMotion && !motion.hidden ? 'smooth' : 'instant';
  target.scrollIntoView({ behavior, block: 'start', inline: 'nearest' });
}
