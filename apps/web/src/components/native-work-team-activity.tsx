'use client';
import { useEffect, useId, useState } from 'react';
import type { NativeAgentWork } from '../../../../packages/contracts/src/native-agent-work';
import type { NativeWorkTeamActivity } from '../../../../packages/contracts/src/native-work-team-activity';
import { currentTeamActivity } from '../lib/native-work-team-activity';
import { canObserveAgentWork } from './native-agent-work-hooks';
import './native-work-team-activity.css';
import { PendingMark } from './async-feedback';

/** Pointers identify leased workers, never simulated clicks or browser actions. */
export function NativeWorkTeamActivityPanel({ activity, work, observing }: {
  activity: NativeWorkTeamActivity | undefined; work: NativeAgentWork; observing: boolean;
}) {
  const heading = useId(), [now, setNow] = useState(() => Date.now()), [visible, setVisible] = useState(canObserveAgentWork);
  const until = Math.min(Date.parse(activity?.validUntil ?? ''), Date.parse(work.expiresAt));
  useEffect(() => {
    const update = () => { setNow(Date.now()); setVisible(canObserveAgentWork()); };
    update();
    const timer = Number.isFinite(until) ? window.setTimeout(update, Math.max(0, Math.min(until - Date.now() + 1, 2_147_483_647))) : undefined;
    document.addEventListener('visibilitychange', update); window.addEventListener('offline', update); window.addEventListener('online', update);
    return () => { window.clearTimeout(timer); document.removeEventListener('visibilitychange', update); window.removeEventListener('offline', update); window.removeEventListener('online', update); };
  }, [until, observing]);
  const current = currentTeamActivity(activity, work, observing && visible, Math.max(now, Date.now()));
  if (!current || !current.agents.length) return null;
  return <section className="native-team-activity" aria-labelledby={heading}>
    <header><div><p className="demo-workspace-eyebrow">Your team now</p><h2 id={heading}>Specialists at work</h2></div><span>Coordinator waiting for the team</span></header>
    <ul aria-label="Current specialist activity">{current.agents.map(agent => <li key={agent.id} data-state={agent.state}>
      <span className="native-team-pointer" aria-hidden="true">{agent.state === 'working' ? <svg viewBox="0 0 24 28" width="18" height="21" fill="currentColor"><path d="M2 1 21 15 12 17 8 25Z" stroke="white" strokeWidth="2" strokeLinejoin="round"/></svg> : <span className="native-team-wait-dot"/>}</span>
      <div><strong>{agent.label}</strong><span className="native-team-state">{agent.state === 'working' && <PendingMark pending/>}{agent.state === 'working' ? 'Working' : 'Waiting to start'}</span></div>
    </li>)}</ul>
    <p className="agent-work-caption">Pointers identify specialists currently working on their assignments.</p>
  </section>;
}
