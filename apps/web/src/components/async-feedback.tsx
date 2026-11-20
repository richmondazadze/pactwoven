'use client';

import { useEffect, useRef, useState } from 'react';
import type { NativeAgentWork } from '../../../../packages/contracts/src/native-agent-work';
import { BrandLoader } from './brand-loader';
import { Icon, type IconName } from './icon';

/** Presentation only: visibility never starts, retries or cancels a request. */
function useFeedbackVisibility(active: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState(true), [running, setRunning] = useState(false);
  useEffect(() => {
    let inView = true;
    const update = () => {
      const online = navigator.onLine !== false;
      setAvailable(online);
      setRunning(active && online && !document.hidden && inView);
    };
    const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(([entry]) => { inView = entry?.isIntersecting ?? false; update(); });
    if (ref.current) observer?.observe(ref.current);
    update();
    document.addEventListener('visibilitychange', update);
    window.addEventListener('online', update); window.addEventListener('offline', update);
    return () => { observer?.disconnect(); document.removeEventListener('visibilitychange', update); window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, [active]);
  return { ref, available, running };
}

export function PendingMark({ pending }: { pending: boolean }) {
  const { ref, running } = useFeedbackVisibility(pending);
  return <span className="pending-mark-slot" aria-hidden="true"><span ref={ref} className="pending-mark" data-pending={pending} data-running={running}><i/><i/><i/></span></span>;
}

export function AsyncFeedback({ label, active = true, announce = false }: { label: string; active?: boolean; announce?: boolean }) {
  return <span className="async-feedback" role={announce ? 'status' : undefined}><PendingMark pending={active}/><span>{label}</span></span>;
}

export function LoadingState({ label = 'Loading your workspace', variant = 'page', active = true, announce = true }: {
  label?: string; variant?: 'page' | 'list' | 'detail' | 'compact'; active?: boolean; announce?: boolean;
}) {
  const { ref, available, running } = useFeedbackVisibility(active);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    if (!active || !available) return;
    const timer = window.setTimeout(() => setSlow(true), 8000);
    return () => window.clearTimeout(timer);
  }, [active, available, label]);
  return <div ref={ref} className="loading-state async-loading" data-variant={variant} data-running={running}>
    <div className="async-loading-caption" role={announce ? 'status' : undefined} aria-atomic="true">
      <span className="async-loading-symbol" aria-hidden="true">{active && available ? <BrandLoader/> : <Icon name="plug" size={22}/>}</span>
      <div><p>{available ? label : 'Waiting for a connection'}</p><small>{!available ? 'Reconnect to load this view.' : !active ? 'Updates resume when this tab is visible and connected.' : slow ? 'This is taking longer than usual. Waiting for a response.' : 'Getting the latest saved information.'}</small></div>
    </div>
    {variant !== 'compact' && <div className="loading-shape" aria-hidden="true">
      {variant === 'list' ? <div className="loading-rows">{[0, 1, 2].map(row => <div className="loading-row" key={row}><span className="loading-block loading-avatar"/><div><span className="loading-block loading-line"/><span className="loading-block loading-line short"/></div><span className="loading-block loading-badge"/></div>)}</div>
        : <><span className="loading-block loading-title"/><span className="loading-block loading-subtitle"/><div className="loading-columns"><div className="loading-card"><span className="loading-block loading-line"/><span className="loading-block loading-line"/><span className="loading-block loading-line short"/><span className="loading-block loading-content"/></div>{variant === 'detail' && <div className="loading-card loading-aside"><span className="loading-block loading-line"/><span className="loading-block loading-line short"/><span className="loading-block loading-content"/></div>}</div></>}
    </div>}
  </div>;
}

const workSignals: Record<NativeAgentWork['state'], { icon: IconName; tone: string }> = {
  queued: { icon: 'clock', tone: 'neutral' }, working: { icon: 'connected-nodes', tone: 'blue' },
  waiting: { icon: 'clock-arrow', tone: 'blue' }, paused: { icon: 'pause-circle', tone: 'amber' },
  cancelled: { icon: 'ban-circle', tone: 'neutral' }, completed: { icon: 'circle-check', tone: 'green' },
  needs_review: { icon: 'triangle-alert', tone: 'amber' },
};

/** A saved state is not proof that a specialist is currently executing. */
export function WorkStateBadge({ state, label, stale = false }: { state: NativeAgentWork['state']; label: string; stale?: boolean }) {
  const signal = stale ? { icon: 'clock' as const, tone: 'neutral' } : workSignals[state];
  return <span className={`badge work-state-badge ${signal.tone}`}><Icon name={signal.icon} size={15}/>{stale ? 'Last saved status' : label}</span>;
}
