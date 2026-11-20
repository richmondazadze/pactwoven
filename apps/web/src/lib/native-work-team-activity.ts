import { NativeWorkTeamActivityResponseSchema, type NativeWorkTeamActivity } from '../../../../packages/contracts/src/native-work-team-activity';
import type { NativeAgentWork } from '../../../../packages/contracts/src/native-agent-work';
import { agentWorkResponseScope, type AgentWorkScope } from './native-agent-work';
export const nativeWorkTeamActivitySchema = (scope: AgentWorkScope, id: string) => NativeWorkTeamActivityResponseSchema.refine(value =>
  agentWorkResponseScope(scope, value) && value.teamActivity.rootTaskId === id, 'Team activity belongs to the current work and workspace.');
export function teamActivityMatchesWork(activity: NativeWorkTeamActivity, work: NativeAgentWork) {
  return activity.rootTaskId === work.id && activity.controlVersion === work.controlVersion &&
    Date.parse(activity.recordedAt) === Date.parse(work.updatedAt) && Date.parse(activity.asOf) >= Date.parse(work.updatedAt);
}
export function currentTeamActivity(activity: NativeWorkTeamActivity | undefined, work: NativeAgentWork, observing: boolean, now: number) {
  return observing && work.state === 'waiting' && !work.evidenceUnavailable && Date.parse(work.expiresAt) > now &&
    activity?.status === 'verified' && teamActivityMatchesWork(activity, work) && activity.validUntil !== null &&
    Date.parse(activity.asOf) <= now && now < Date.parse(activity.validUntil) ? activity : undefined;
}
