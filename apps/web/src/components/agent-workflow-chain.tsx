'use client';

import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import type { NativeAgentWork } from '../../../../packages/contracts/src/native-agent-work';
import type { NativeWorkActivity } from '../../../../packages/contracts/src/native-work-activity';
import type { NativeWorkTeamActivity } from '../../../../packages/contracts/src/native-work-team-activity';
import { buildAgentWorkflowChain, chainStateLabels, selectChainObservation, type ChainEquipmentStage, type ChainNode, type ChainStage, type ChainState } from '../lib/agent-workflow-chain';
import { demoActionLabels } from '../lib/demo-workspace';
import { canObserveAgentWork } from './native-agent-work-hooks';
import { Icon, type IconName } from './icon';
import { PendingMark } from './async-feedback';
import { ReadingRegion } from './readable-content';
import './ux-agent-chain.css';

const roleIcons: Record<ChainNode['role'], IconName> = { coordinator: 'connected-nodes', research: 'search', planning: 'split-route', escalation: 'scales' };
const stateIcons: Record<ChainState, IconName> = { queued: 'clock', working: 'connected-nodes', waiting: 'clock-arrow', completed: 'circle-check', paused: 'pause-circle', cancelled: 'ban-circle', needs_review: 'triangle-alert', unknown: 'circle-question', not_started: 'circle-half' };
const stageIcons: Record<ChainStage, IconName> = { plan: 'split-route', team: 'users', result: 'document-signature' };
const timestamp = (value: string) => new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(value));

/** Expiry updates presentation only. Observation never starts or resumes a task. */
function useChainObservation(observing: boolean, deadlines: number[]) {
  const [clock, setClock] = useState(Date.now), [available, setAvailable] = useState(canObserveAgentWork);
  const [inView, setInView] = useState(false), container = useRef<HTMLElement>(null);
  const nextDeadline = Math.min(...deadlines.filter(deadline => Number.isFinite(deadline) && deadline > Math.max(clock, Date.now())));
  useEffect(() => {
    const update = () => { setClock(Date.now()); setAvailable(canObserveAgentWork()); };
    update();
    const timer = Number.isFinite(nextDeadline) ? window.setTimeout(update, Math.max(0, Math.min(nextDeadline - Date.now() + 1, 2_147_483_647))) : undefined;
    document.addEventListener('visibilitychange', update); window.addEventListener('offline', update); window.addEventListener('online', update);
    return () => { window.clearTimeout(timer); document.removeEventListener('visibilitychange', update); window.removeEventListener('offline', update); window.removeEventListener('online', update); };
  }, [observing, nextDeadline]);
  useEffect(() => {
    const target = container.current;
    const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(([entry]) => setInView(Boolean(entry?.isIntersecting)));
    if (target) observer?.observe(target);
    if (!observer) setInView(true);
    return () => observer?.disconnect();
  }, []);
  return { container, now: Math.max(clock, Date.now()), observing: observing && available, animate: observing && available && inView };
}

/** Stable identity makes a changed recorded focus travel once; polling alone never starts a replay. */
function CoordinatorFlowMarker({ board, root, target, shown }: { board: RefObject<HTMLOListElement | null>; root: string; target: ChainStage | null; shown: boolean }) {
  const [position, setPosition] = useState<{ root: string; x: number; y: number } | null>(null);
  useEffect(() => {
    const element = board.current;
    if (!element || !target || !shown) return;
    const stage = element.querySelector<HTMLElement>(`[data-chain-stage="${target}"]`);
    const anchor = stage?.querySelector<HTMLElement>('.agent-chain-stage-order');
    if (!anchor) return;
    const update = () => {
      const origin = element.getBoundingClientRect(), box = anchor.getBoundingClientRect();
      setPosition({ root, x: box.left - origin.left + box.width / 2, y: box.top - origin.top + box.height / 2 });
    };
    update();
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    resize?.observe(element); resize?.observe(anchor);
    return () => resize?.disconnect();
  }, [board, root, target, shown]);
  return position?.root === root ? <span className="agent-chain-flow-marker" aria-hidden="true" data-visible={shown} style={{ transform: `translate(${position.x}px, ${position.y}px)` }}><i/><span>Coordinator</span></span> : null;
}

export function AgentWorkflowChain({ work, activity: candidate, teamActivity, observing, equipmentStage }: {
  work: NativeAgentWork; activity?: NativeWorkActivity | undefined; teamActivity?: NativeWorkTeamActivity | undefined; observing: boolean; equipmentStage?: ChainEquipmentStage | null | undefined;
}) {
  const heading = useId(), inspector = useId(), board = useRef<HTMLOListElement>(null), previous = useRef<NativeWorkActivity | undefined>(undefined);
  const activity = selectChainObservation(previous.current, candidate, work);
  const observation = useChainObservation(observing, [Date.parse(activity?.freshUntil ?? ''), Date.parse(activity?.expiresAt ?? ''), Date.parse(teamActivity?.validUntil ?? ''), Date.parse(work.expiresAt), Date.parse(work.result?.evidenceValidUntil ?? '')]);
  previous.current = activity;
  const chain = buildAgentWorkflowChain({ work, activity, teamActivity, observing: observation.observing, now: observation.now, equipmentStage });
  const [selection, setSelection] = useState<{ scope: string; key: string } | null>(null);
  const scope = `${work.id}:${work.controlVersion}:${work.updatedAt}`;
  const keys = [...chain.stages.map(stage => stage.id), ...chain.nodes.map(node => node.key)];
  const selectedKey = selection?.scope === scope && keys.includes(selection.key) ? selection.key : chain.stages.find(stage => stage.state === 'working')?.id ?? chain.stages.find(stage => stage.state === 'needs_review')?.id ?? 'team';
  const selectedNode = chain.nodes.find(node => node.key === selectedKey);
  const selectedStage = chain.stages.find(stage => stage.id === (selectedNode?.stage ?? selectedKey))!;
  const selectedActions = selectedNode?.actions ?? selectedStage.actions;
  const selectedTitle = selectedNode?.label ?? selectedStage.title;
  const selectedState = selectedNode?.state ?? selectedStage.state;
  const select = (key: string) => setSelection({ scope, key });
  return <section ref={observation.container} className="agent-chain" aria-labelledby={heading} data-animate={observation.animate} data-live={chain.live}>
    <header className="agent-chain-heading"><div><p className="demo-workspace-eyebrow">Your agent team</p><h2 id={heading}>Working together</h2></div><span className="agent-chain-status"><Icon name={work.state === 'paused' ? 'pause-circle' : work.state === 'completed' ? 'circle-check' : !observation.observing ? 'plug' : 'connected-nodes'} size={16}/>{chain.status}</span></header>
    <p className="agent-chain-caption">{chain.hasRecords ? 'Select a stage or an agent to see its recorded work.' : 'Your request is saved. The workflow fills in as the team records its work.'}</p>
    <div className="agent-chain-board"><ol ref={board} className="agent-chain-stages" aria-label="Agent workflow stages">{chain.stages.map((stage, index) => <li key={stage.id} className="agent-chain-stage" data-state={stage.state} data-recorded={stage.recorded} data-chain-stage={stage.id}>
      <div className="agent-chain-stage-order" aria-hidden="true"><span>{String(index + 1).padStart(2, '0')}</span><span className="agent-chain-connector"><i/></span><Icon name="arrow-right" size={15}/></div>
      <button className="agent-chain-stage-button" type="button" aria-pressed={selectedKey === stage.id} aria-controls={inspector} onClick={() => select(stage.id)}>
        <span className="agent-chain-stage-icon"><Icon name={stageIcons[stage.id]} size={22}/></span><span className="agent-chain-stage-title">{stage.title}</span>
        <span className="agent-chain-state" data-state={stage.state}><Icon name={stateIcons[stage.state]} size={14}/>{chainStateLabels[stage.state]}</span>
      </button>
      <ul className="agent-chain-agents" aria-label={`${stage.title} agents`}>{chain.nodes.filter(node => node.stage === stage.id).map(node => <li key={node.key} data-state={node.state} data-role={node.role}>
        <button type="button" className="agent-chain-agent" aria-pressed={selectedKey === node.key} aria-controls={inspector} onClick={() => select(node.key)}>
          <span className="agent-chain-agent-icon"><Icon name={roleIcons[node.role]} size={18}/></span><span className="agent-chain-agent-copy"><strong>{node.label}</strong><span>{node.live ? <><PendingMark pending={observation.animate}/>Working</> : chainStateLabels[node.state]}</span></span>
          {node.live && <span className="agent-chain-pointer" aria-hidden="true"><svg viewBox="0 0 24 28" width="14" height="17" fill="currentColor"><path d="M2 1 21 15 12 17 8 25Z" stroke="white" strokeWidth="2" strokeLinejoin="round"/></svg></span>}
        </button>
      </li>)}</ul>
      {!chain.nodes.some(node => node.stage === stage.id) && <p className="agent-chain-stage-empty">{stage.caption}</p>}
    </li>)}</ol><CoordinatorFlowMarker board={board} root={work.id} target={chain.coordinatorStage} shown={chain.observationCurrent && observation.observing && ['working', 'waiting', 'queued'].includes(work.state)}/></div>
    <div className="agent-chain-record-summary"><span><Icon name="link" size={15}/>Follow the team’s recorded progress.</span>{chain.completedContributions > 0 && <span><Icon name="circle-check" size={15}/>{chain.completedContributions} {chain.completedContributions === 1 ? 'contribution' : 'contributions'} recorded</span>}</div>
    {chain.payment && <div className="agent-chain-payment" data-state={chain.payment.state}><Icon name="coins" size={22}/><div><strong>{chain.payment.title}</strong><p>{chain.payment.caption}</p></div><span className="agent-chain-payment-boundary">Your approval</span></div>}
    <section className="agent-chain-inspector" id={inspector} aria-label="Selected workflow details">
      <header><div><p className="demo-workspace-eyebrow">Workflow details</p><h3>{selectedTitle}</h3></div><span className="agent-chain-state" data-state={selectedState}><Icon name={stateIcons[selectedState]} size={15}/>{chainStateLabels[selectedState]}</span></header>
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{selection?.scope === scope ? `${selectedTitle} selected. ${chainStateLabels[selectedState]}.` : ''}</p>
      {selectedNode?.live ? <p className="agent-chain-detail-summary">{selectedNode.caption}. Its marker identifies a currently observed worker.</p> : selectedNode && !selectedActions.length ? <p className="agent-chain-detail-summary">{selectedNode.caption}.</p> : !selectedActions.length ? <p className="agent-chain-detail-summary">No action for this stage is available in the current record. A missing record does not mean the stage failed.</p> : null}
      {selectedActions.length > 0 && <div className="agent-chain-detail-activity"><h4>Recorded activity</h4><ReadingRegion label="Selected agent activity"><ol>{selectedActions.map(action => <li key={action.id}><Icon name={stateIcons[action.state === 'active' ? 'unknown' : action.state]} size={16}/><div><p>{action.label}</p><span>{action.state === 'active' ? 'Recorded as working' : demoActionLabels[action.state]}{action.recordedAt && <> · <time dateTime={action.recordedAt}>{timestamp(action.recordedAt)}</time></>}</span></div></li>)}</ol></ReadingRegion></div>}
      {selectedStage.id === 'plan' && work.progress && !work.progress.historical && !work.evidenceUnavailable && <details className="agent-chain-detail-disclosure"><summary>Recorded plan<Icon name="chevron-down" size={16}/></summary><ReadingRegion label="Workflow plan"><p className="readable-text">{work.progress.summary}</p><ol>{work.progress.steps.map(step => <li key={step.id}>{step.title}</li>)}</ol></ReadingRegion></details>}
      {selectedStage.id === 'result' && chain.canShowResult && work.result && <details className="agent-chain-detail-disclosure"><summary>Saved result<Icon name="chevron-down" size={16}/></summary><ReadingRegion label="Workflow result"><h4>{work.result.title}</h4><p className="readable-text">{work.result.summary}</p></ReadingRegion></details>}
      <p className="agent-chain-detail-footnote">{observation.observing ? chain.observedAt ? <>Snapshot checked at <time dateTime={chain.observedAt}>{timestamp(chain.observedAt)}</time>. Only recorded details are shown.</> : 'Waiting for an activity snapshot.' : 'Live updates are paused. Any visible details are from the last available record.'}</p>
    </section>
  </section>;
}
