import type { NativeAgentWork } from '../../../../packages/contracts/src/native-agent-work';
import type { NativeWorkActivity } from '../../../../packages/contracts/src/native-work-activity';
import type { NativeWorkTeamActivity } from '../../../../packages/contracts/src/native-work-team-activity';
import { activityMatchesWork } from './native-work-activity';
import { currentTeamActivity } from './native-work-team-activity';

export type ChainState = 'queued' | 'working' | 'waiting' | 'completed' | 'paused' | 'cancelled' | 'needs_review' | 'unknown' | 'not_started';
export type ChainStage = 'plan' | 'team' | 'result';
export type ChainEquipmentStage = 'quote_ready' | 'quote_expired' | 'equipment_unavailable' | 'approval_unconfirmed' | 'purchase_recorded';
export const chainStateLabels: Record<ChainState, string> = {
  queued: 'Ready to start', working: 'Working', waiting: 'Waiting', completed: 'Complete', paused: 'Paused', cancelled: 'Cancelled',
  needs_review: 'Needs attention', unknown: 'Checking status', not_started: 'No current record',
};
export interface ChainNode {
  key: string; label: string; role: NativeWorkActivity['agents'][number]['role']; stage: ChainStage;
  state: ChainState; caption: string; live: boolean; actions: NativeWorkActivity['actions'];
}
export interface ChainStageView { id: ChainStage; title: string; state: ChainState; caption: string; recorded: boolean; actions: NativeWorkActivity['actions'] }
export interface AgentChainInput { work: NativeAgentWork; activity?: NativeWorkActivity | undefined; teamActivity?: NativeWorkTeamActivity | undefined; observing: boolean; now: number; equipmentStage?: ChainEquipmentStage | null | undefined }

/** Do not replay or reverse a newer same-root revision when a late read arrives. */
export function selectChainObservation(previous: NativeWorkActivity | undefined, candidate: NativeWorkActivity | undefined, work: NativeAgentWork) {
  if (!candidate || !activityMatchesWork(candidate, work) || candidate.freshness === 'unavailable' || work.evidenceUnavailable) return undefined;
  if (!previous || !activityMatchesWork(previous, work)) return candidate;
  if (Date.parse(candidate.asOf) < Date.parse(previous.asOf) || candidate.revision.generation < previous.revision.generation ||
      candidate.revision.checkpointVersion < previous.revision.checkpointVersion ||
      (candidate.revision.instructionRevision ?? -1) < (previous.revision.instructionRevision ?? -1)) return previous;
  return candidate;
}

function passiveState(state: ChainState, work: NativeAgentWork, live: boolean): ChainState {
  if (state === 'completed' || state === 'needs_review' || state === 'cancelled' || state === 'paused') return state;
  if (work.state === 'paused' || work.state === 'cancelled') return work.state;
  if (work.state === 'needs_review') return 'needs_review';
  if (state === 'working' && (!live || work.state === 'completed')) return 'unknown';
  return state;
}
const priority: ChainState[] = ['needs_review', 'working', 'paused', 'cancelled', 'unknown', 'waiting', 'queued'];
function groupState(states: ChainState[]): ChainState {
  if (!states.length) return 'not_started';
  if (states.every(state => state === 'completed')) return 'completed';
  return priority.find(state => states.includes(state)) ?? 'not_started';
}

/** This graph describes recorded stages. Its lines do not claim browser actions or unrecorded agent-to-agent messages. */
export function buildAgentWorkflowChain({ work, activity: input, teamActivity, observing, now, equipmentStage }: AgentChainInput) {
  const activity = input && activityMatchesWork(input, work) && input.freshness !== 'unavailable' && !work.evidenceUnavailable && Date.parse(input.asOf) <= now ? input : undefined;
  const live = Boolean(activity && observing && activity.freshness === 'current' && now < Date.parse(activity.freshUntil) && now < Date.parse(activity.expiresAt) && now < Date.parse(work.expiresAt));
  // Metadata and content snapshots may only be combined for the same instruction revision.
  const team = currentTeamActivity(teamActivity, work, observing, now);
  const currentTeam = team && (!activity || activity.revision.instructionRevision === team.instructionRevision) ? team : undefined;
  const actions = activity?.actions ?? [];
  const nodes: ChainNode[] = (activity?.agents ?? []).flatMap(agent => {
    const assigned = actions.filter(action => action.actorId === agent.id);
    if (!assigned.length) return [];
    // Lease identities deliberately differ from content actor identities. Never join them by role/name.
    if (currentTeam?.agents.length && agent.role !== 'coordinator' && !assigned.every(action => action.state === 'completed')) return [];
    const last = assigned.at(-1)!;
    const state = passiveState(last.state === 'active' ? 'working' : last.state, work, live && agent.role === 'coordinator');
    return [{ key: `recorded:${agent.id}`, label: currentTeam?.agents.length && agent.role !== 'coordinator' ? `${agent.label} contribution` : agent.label, role: agent.role, stage: last.target, state,
      caption: state === 'unknown' ? 'Last recorded assignment; current execution unconfirmed' : last.label,
      live: state === 'working' && live, actions: assigned }];
  });
  if (currentTeam) for (const agent of currentTeam.agents) nodes.push({ key: `current:${agent.id}`, label: agent.label, role: agent.role,
    stage: agent.role === 'escalation' ? 'result' : 'team', state: agent.state === 'working' ? 'working' : 'queued',
    caption: agent.state === 'working' ? 'Working on an assigned contribution' : 'Waiting for the worker to begin', live: agent.state === 'working', actions: [] });
  const stageInfo = [{ id: 'plan', title: 'Make a plan', caption: 'The coordinator prepares the approach.' },
    { id: 'team', title: 'Work together', caption: 'Specialists contribute in parallel.' },
    { id: 'result', title: 'Bring it together', caption: 'Review and save the result.' }] as const;
  const stages: ChainStageView[] = stageInfo.map(stage => {
    const stageActions = actions.filter(action => action.target === stage.id);
    const stageNodes = nodes.filter(node => node.stage === stage.id);
    let state = groupState(stageNodes.map(node => node.state));
    if (!stageNodes.length && stageActions.length) state = groupState(stageActions.map(action => passiveState(action.state === 'active' ? 'working' : action.state, work, false)));
    const recorded = stageActions.length > 0 || stageNodes.length > 0;
    // A current projection contains the coordinator's latest phase, not its whole history.
    const caption = !recorded ? 'No stage record in this view' : state === 'working' ? `${stageNodes.filter(node => node.live).length} ${stageNodes.filter(node => node.live).length === 1 ? 'agent' : 'agents'} working` : stage.caption;
    return { ...stage, state, caption, recorded, actions: stageActions };
  });
  const completedContributions = actions.filter(action => action.state === 'completed' && activity?.agents.some(agent => agent.id === action.actorId && agent.role !== 'coordinator')).length;
  const payment = equipmentStage ? {
    state: equipmentStage === 'quote_ready' ? 'needs_review' as const : equipmentStage === 'purchase_recorded' ? 'waiting' as const : 'unknown' as const,
    title: equipmentStage === 'quote_ready' ? 'Your payment decision' : equipmentStage === 'quote_expired' ? 'Payment review expired' : equipmentStage === 'approval_unconfirmed' ? 'Checking the original approval' : equipmentStage === 'purchase_recorded' ? 'Payment and computation' : 'Payment details need checking',
    caption: equipmentStage === 'quote_ready' ? 'Review the exact amount and limits in the payment panel.' : equipmentStage === 'purchase_recorded' ? 'Read the receipt for confirmation and delivery.' : 'Use the payment panel to review the original record.',
  } : null;
  const workingCount = nodes.filter(node => node.live).length;
  const status = work.state === 'paused' ? 'Work is paused' : work.state === 'cancelled' ? 'Work is cancelled' : work.state === 'completed' ? 'Work is complete' : work.state === 'needs_review' ? 'Your input is needed' : !observing ? 'Connection paused' : now >= Date.parse(work.expiresAt) ? 'Permission ended' : workingCount ? `${workingCount} ${workingCount === 1 ? 'agent is' : 'agents are'} working` : work.state === 'queued' ? 'Ready to begin' : 'Waiting for the next update';
  const coordinatorAction = actions.find(action => activity?.agents.some(agent => agent.role === 'coordinator' && agent.id === action.actorId));
  return { stages, nodes, actions, completedContributions, payment, workingCount, status, coordinatorStage: coordinatorAction?.target ?? null, live: workingCount > 0, hasRecords: Boolean(activity), observationCurrent: live,
    canShowResult: !work.evidenceUnavailable && Boolean(work.result) && (!work.result?.evidenceValidUntil || now < Date.parse(work.result.evidenceValidUntil)),
    observedAt: activity?.asOf ?? null };
}
