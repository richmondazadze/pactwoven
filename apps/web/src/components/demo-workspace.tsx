'use client';

import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { NativeWorkActivity } from '../../../../packages/contracts/src/native-work-activity';
import type { NativeAgentWork } from '../../../../packages/contracts/src/native-agent-work';
import { demoActionLabels, demoAgentFocus, demoExactAmount, demoPaymentActionLabels, demoPaymentActions, demoPaymentLabels,
  DemoPaymentCardSchema, demoTextPreview, demoWorkspaceAnnouncement, demoWorkspaceStages, type DemoPaymentAction, type DemoPaymentCard as Payment,
  type DemoWorkspaceTarget } from '../lib/demo-workspace';
import { Icon, type IconName } from './icon';
import { ReadingRegion } from './readable-content';
import './demo-workspace.css';

const stageIcons: Record<DemoWorkspaceTarget, IconName> = { plan: 'split-route', team: 'connected-nodes', result: 'document-signature' };
const displayTime = (time: string) => new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(time));

function useObservation(observing: boolean, validUntil: string) {
  const [visible, setVisible] = useState(true), [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const update = () => { setVisible(document.visibilityState !== 'hidden'); setNow(Date.now()); };
    update(); document.addEventListener('visibilitychange', update);
    const remaining = Math.max(0, Date.parse(validUntil) - Date.now());
    const timer = window.setTimeout(update, Math.min(remaining + 1, 2_147_483_647));
    return () => { window.clearTimeout(timer); document.removeEventListener('visibilitychange', update); };
  }, [validUntil, observing]);
  return { observing: observing && visible, now };
}

/** Visual focus reflects recorded API activity; it is not a browser-control replay. */
function AgentFocus({ activity, observing, now, board }: {
  activity: NativeWorkActivity; observing: boolean; now: number; board: RefObject<HTMLDivElement | null>;
}) {
  const allFocus = demoAgentFocus(activity, observing, now);
  // At most two focus pointers per lane; the full real team remains in the agent list.
  const focus = allFocus.filter((item, index) => allFocus.slice(0, index).filter(other => other.target === item.target).length < 2);
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});
  const focusKey = focus.map(item => `${item.actorId}:${item.actionId}:${item.target}`).join('|');
  useEffect(() => {
    const element = board.current;
    if (!element || !focus.length) { setPositions({}); return; }
    const update = () => {
      const origin = element.getBoundingClientRect(), result: typeof positions = {};
      focus.forEach((item, index) => {
        // Targets are a fixed enum; no provider text enters a selector.
        const target = element.querySelector<HTMLElement>(`[data-workspace-target="${item.target}"]`);
        if (!target) return;
        const rectangle = target.getBoundingClientRect();
        const sameTargetBefore = focus.slice(0, index).filter(other => other.target === item.target).length;
        result[item.actorId] = { x: rectangle.left - origin.left + 18, y: rectangle.top - origin.top + 18 + sameTargetBefore * 28 };
      });
      setPositions(result);
    };
    update();
    const resize = new ResizeObserver(update); resize.observe(element);
    for (const target of element.querySelectorAll('[data-workspace-target]')) resize.observe(target);
    return () => resize.disconnect();
  }, [focusKey, board]);
  return <div className="demo-agent-focus-layer" aria-hidden="true">{focus.map(item => {
    const position = positions[item.actorId];
    return position && <span key={item.actorId} className="demo-agent-focus" style={{ transform: `translate(${position.x}px, ${position.y}px)` }}>
      <svg viewBox="0 0 24 28" width="18" height="21" fill="currentColor"><path d="M2 1 21 15 12 17 8 25Z" stroke="white" strokeWidth="2" strokeLinejoin="round"/></svg>
      <span>{item.label}</span>
    </span>;
  })}</div>;
}

export function AgentActivityWorkspace({ activity, observing = true, result, resultUnavailable = false, resultActions }: {
  activity: NativeWorkActivity; observing?: boolean; result?: NativeAgentWork['result']; resultUnavailable?: boolean;resultActions?:ReactNode;
}) {
  const heading = useId(), board = useRef<HTMLDivElement>(null), previous = useRef<NativeWorkActivity | undefined>(undefined);
  const until = new Date(Math.min(Date.parse(activity.freshUntil), Date.parse(activity.expiresAt), result?.evidenceValidUntil ? Date.parse(result.evidenceValidUntil) : Infinity)).toISOString();
  const observation = useObservation(observing, until), [announcement, setAnnouncement] = useState('');
  const current = observation.observing && observation.now < Date.parse(activity.expiresAt) && observation.now < Date.parse(activity.freshUntil) && activity.freshness === 'current';
  const unavailable = activity.freshness === 'unavailable';
  useEffect(() => {
    const message = demoWorkspaceAnnouncement(previous.current, activity, current);
    if (message) setAnnouncement(message);
    previous.current = activity;
  }, [activity, current]);
  const actions = unavailable ? [] : activity.actions;
  const needsAttention = actions.find(action => action.state === 'needs_review');
  return <section className="demo-workspace" aria-labelledby={heading} data-observing={current}>
    <div className="demo-workspace-heading"><div><p className="demo-workspace-eyebrow">Your agent team</p><h2 id={heading}>Work, as it happens</h2></div>
      <span className="demo-workspace-observation"><span aria-hidden="true"/>{current ? 'Latest recorded activity' : 'Saved activity'}</span></div>
    <p className="demo-workspace-caption">{unavailable ? 'Earlier activity needs review before it can be shown.' : current ? 'Agent pointers show the team’s recorded focus.' : !observation.observing ? 'Live observation is paused. Showing the last available activity.' : 'Showing the last available recorded activity.'}</p>
    <p className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</p>
    {needsAttention && <div className="demo-workspace-attention"><Icon name="triangle-alert"/><div><strong>Needs your attention</strong><p>{needsAttention.label}</p></div></div>}
    {!unavailable && activity.agents.length > 0 && <ul className="demo-workspace-agents" aria-label="Agents assigned to this work">{activity.agents.map(agent => {
      const assigned = actions.filter(action => action.actorId === agent.id);
      const active = assigned.find(action => action.state === 'active') ?? assigned.at(-1);
      return <li key={agent.id}><span className="demo-workspace-avatar" aria-hidden="true"><Icon name={agent.role === 'coordinator' ? 'connected-nodes' : 'layers'} size={18}/></span><div><strong>{agent.label}</strong><span>{active ? demoActionLabels[active.state] : 'Assigned'}</span></div></li>;
    })}</ul>}
    <div className="demo-workspace-board" ref={board}>
      <AgentFocus activity={activity} observing={current} now={observation.now} board={board}/>
      {demoWorkspaceStages.map(stage => {
        const stageActions = actions.filter(action => action.target === stage.id);
        return <section key={stage.id} className="demo-workspace-stage" data-workspace-target={stage.id} aria-label={stage.title}>
          <div className="demo-workspace-stage-heading"><Icon name={stageIcons[stage.id]} size={22}/><h3>{stage.title}</h3></div>
          {stageActions.length ? <ol>{stageActions.map(action => <li key={action.id} data-state={action.state}>
            <span className="demo-workspace-action-marker" aria-hidden="true"><Icon name={action.state === 'completed' ? 'circle-check' : action.state === 'needs_review' ? 'triangle-alert' : 'circle-half'} size={16}/></span>
            <div><p>{action.label}</p><span>{demoActionLabels[action.state]}</span></div>
          </li>)}</ol> : <p className="demo-workspace-stage-empty">{unavailable ? 'Activity unavailable' : stage.empty}</p>}
        </section>;
      })}
    </div>
    {result && !resultUnavailable && !unavailable && (!result.evidenceValidUntil || observation.now < Date.parse(result.evidenceValidUntil)) && <DemoWorkspaceResult result={result} actions={resultActions}/>}
    {actions.length > 0 && <details className="demo-workspace-history"><summary>Activity details <span>{actions.length} recorded {actions.length === 1 ? 'action' : 'actions'}</span></summary>
      <ReadingRegion label="Recorded activity"><ol>{[...actions].sort((a,b) => (b.recordedAt ? Date.parse(b.recordedAt) : 0) - (a.recordedAt ? Date.parse(a.recordedAt) : 0)).map(action => <li key={action.id}>
        {action.recordedAt ? <time dateTime={action.recordedAt}>{displayTime(action.recordedAt)}</time> : <span>Recorded</span>}<div><strong>{activity.agents.find(agent => agent.id === action.actorId)?.label ?? 'Team'}</strong><p>{action.label}</p></div><span>{demoActionLabels[action.state]}</span>
      </li>)}</ol></ReadingRegion></details>}
    <p className="demo-workspace-footnote">Planning and advice permission does not authorize payments. A computation payment requires a separate exact approval. Messages and orders are not permitted.</p>
  </section>;
}

export function DemoWorkspaceResult({ result,actions }: { result: NonNullable<NativeAgentWork['result']>;actions?:ReactNode }) {
  const preview = demoTextPreview(result.summary);
  return <section className="demo-workspace-result" aria-label="Your result"><div className="demo-workspace-result-heading"><Icon name="circle-check" size={24}/><div><p className="demo-workspace-eyebrow">Your result</p><h3>{result.title}</h3></div></div>
    <p className="demo-workspace-result-summary">{preview.text}</p>
    {actions}
    {preview.shortened && <details className="demo-workspace-result-detail"><summary>Read full summary<Icon name="chevron-down" size={16}/></summary><ReadingRegion label="Full summary"><div className="readable-text">{result.summary}</div></ReadingRegion></details>}
    {result.artifacts.map(artifact => <details key={artifact.id} className="demo-workspace-result-detail"><summary>{artifact.title}<Icon name="chevron-down" size={16}/></summary><ReadingRegion label={artifact.title}><div className="readable-text">{artifact.text}</div></ReadingRegion></details>)}
  </section>;
}

/** Separate from the advisory workspace; mount only with a validated payment-capable server record. */
export function DemoPaymentCard({ payment: input, observing = true, pending = false, onAction }: {
  payment: Payment; observing?: boolean; pending?: boolean; onAction?: (action: DemoPaymentAction, payment: Payment) => void;
}) {
  const payment = DemoPaymentCardSchema.parse(input), observation = useObservation(observing, payment.validUntil);
  const actions = demoPaymentActions(payment, observation.observing, pending, observation.now), heading = useId();
  const confirmed = payment.state === 'confirmed' || payment.state === 'delivered';
  return <section className="demo-payment-card" aria-labelledby={heading} data-state={payment.state}>
    <header><span className="demo-payment-symbol"><Icon name={confirmed ? 'receipt' : 'coins'} size={24}/></span><div><p className="demo-workspace-eyebrow">{payment.network} · test funds</p><h3 id={heading}>{payment.serviceName}</h3></div></header>
    <p className="demo-payment-purpose">{payment.purpose}</p>
    <div className="demo-payment-amount"><strong>{demoExactAmount(payment.amount)}</strong><span>{payment.amount.assetLabel}</span></div>
    <p className="demo-payment-state" role="status">{demoPaymentLabels[payment.state]}</p>
    <dl><div><dt>Recipient</dt><dd>{payment.recipientLabel}</dd></div>
      <div><dt>Network fee</dt><dd>{payment.networkFee ? demoExactAmount(payment.networkFee) : 'Not yet available'}</dd></div>
      {payment.remaining && <div><dt>Remaining allowance</dt><dd>{demoExactAmount(payment.remaining)}</dd></div>}
    </dl>
    {payment.notice && <p className="demo-payment-notice">{payment.notice}</p>}
    {payment.state === 'unknown' && <p className="demo-payment-notice">The original payment is being checked. Do not start another payment.</p>}
    {payment.transactionSignature && <a className="demo-payment-receipt" href={`https://explorer.solana.com/tx/${payment.transactionSignature}?cluster=devnet`} target="_blank" rel="noopener noreferrer">View transaction on Solana Explorer<Icon name="arrow-right" size={16}/></a>}
    {onAction && payment.availableActions.length > 0 && <div className="demo-payment-actions" aria-label="Payment actions">{payment.availableActions.map(action => <button type="button" key={action} className={`button ${action === 'reject' || action === 'check' ? 'secondary' : ''}`} disabled={!actions.includes(action)}
      onClick={() => { if (actions.includes(action) && (action === 'check' || Date.now() < Date.parse(payment.validUntil)) && document.visibilityState !== 'hidden') onAction(action, payment); }}>{pending ? 'Checking…' : demoPaymentActionLabels[action]}</button>)}</div>}
    {!actions.length && payment.availableActions.length > 0 && !pending && <p className="demo-workspace-caption">Refresh the payment details before taking an action.</p>}
    <p className="demo-workspace-footnote">Updated <time dateTime={payment.recordedAt}>{displayTime(payment.recordedAt)}</time>. Confirmation and service delivery are checked separately.</p>
  </section>;
}
