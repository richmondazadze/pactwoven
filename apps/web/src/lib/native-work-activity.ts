import { NativeWorkActivityResponseSchema, type NativeWorkActivity } from '../../../../packages/contracts/src/native-work-activity';
import type { NativeAgentWork } from '../../../../packages/contracts/src/native-agent-work';
import { agentWorkResponseScope, type AgentWorkScope } from './native-agent-work';

export const nativeWorkActivitySchema = (scope: AgentWorkScope, id: string) => NativeWorkActivityResponseSchema.refine(value =>
  agentWorkResponseScope(scope, value) && value.activity.rootTaskId === id, 'Activity belongs to the current work and workspace.');

/** Join only the same recorded root revision; a newer child snapshot cannot attach to an older result. */
export function activityMatchesWork(activity: NativeWorkActivity, work: NativeAgentWork) {
  return activity.rootTaskId === work.id && activity.revision.controlVersion === work.controlVersion &&
    Date.parse(activity.recordedAt) === Date.parse(work.updatedAt) && Date.parse(activity.asOf) >= Date.parse(work.updatedAt);
}
