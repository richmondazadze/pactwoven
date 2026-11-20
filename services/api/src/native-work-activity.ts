import { createHash } from 'node:crypto';
import { InstantSchema, type Session } from '@pactwoven/contracts';
import { DomainError } from '@pactwoven/domain';
import { NativeWorkActivityFrameSchema } from '../../../packages/db/src/native-work-activity-repository';
import { NativeWorkActivityResponseSchema, type NativeWorkActivity } from '../../../packages/contracts/src/native-work-activity';

type ActivityAction = NativeWorkActivity['actions'][number];
const unavailable = () => new DomainError('DURABLE_SERVICE_UNAVAILABLE', 503, 'Agent activity could not be confirmed. Refresh the work status.');
const publicId = (...parts: unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);
const labels = { research: 'Research', planning: 'Planning', escalation: 'Review' } as const;

/** Projects recorded lifecycle facts, not model prose or inferred browser/payment actions.
 * The frame must come from the single authorized database activity read. */
export function projectNativeWorkActivity(session: Session, id: string, siteId: string, value: unknown,
  now = new Date().toISOString()) {
  const actor = session.actor;
  if (actor.principalKind !== 'human' || !actor.siteIds.includes(siteId) || !session.sites.some(site => site.id === siteId)) {
    throw new DomainError('FORBIDDEN', 403, 'Your current access does not permit this work request.');
  }
  const parsed = NativeWorkActivityFrameSchema.safeParse(value), clock = InstantSchema.safeParse(now);
  if (!parsed.success || !clock.success) throw unavailable();
  const frame = parsed.data, raw = frame.root;
  if (raw.id !== id || raw.scope.environment !== actor.environment || raw.scope.organizationId !== actor.organizationId || raw.scope.siteId !== siteId ||
      Date.parse(raw.updatedAt) > Date.parse(now) || raw.evidenceUnavailable && (raw.checkpoint !== null || raw.result !== null) ||
      raw.result !== null && !['completed', 'blocked'].includes(raw.state) || ['awaiting_calendar'].includes(raw.state) && raw.checkpoint !== null) throw unavailable();
  if (Date.parse(frame.observedAt) > Date.parse(now) || Date.parse(frame.observedAt) < Date.parse(raw.updatedAt) ||
      Date.parse(now) - Date.parse(frame.observedAt) > 10_000 || new Set(frame.children.map(child => child.taskId)).size !== frame.children.length ||
      new Set(frame.children.map(child => child.handoffId)).size !== frame.children.length || frame.children.some(child =>
        child.state !== 'settled' && child.outcome !== null)) throw unavailable();
  const freshness: NativeWorkActivity['freshness'] = raw.evidenceUnavailable ? 'unavailable' :
    raw.checkpointHistorical || Date.parse(raw.expiresAt) <= Date.parse(now) ? 'historical' : 'current';
  const actorId = publicId(raw.scope, id, 'coordinator');
  const agents: NativeWorkActivity['agents'] = [], actions: NativeWorkActivity['actions'] = [];
  const passive = (state: ActivityAction['state']): ActivityAction['state'] => freshness !== 'current' && state === 'active' ? 'waiting' : state;
  if (freshness !== 'unavailable') {
    agents.push({ id: actorId, role: 'coordinator', label: 'Coordinator' });
    const state: ActivityAction['state'] = raw.state === 'ready' ? 'queued' : raw.state === 'running' ? 'active' :
      raw.state === 'paused' ? 'paused' : raw.state === 'cancelled' ? 'cancelled' : raw.state === 'completed' ? 'completed' :
      raw.state === 'blocked' ? 'needs_review' : 'waiting';
    const reviewing = raw.checkpoint?.stage === 'reviewing';
    const kind: ActivityAction['kind'] = raw.state === 'completed' ? 'result' :
      ['waiting_children', 'awaiting_calendar', 'waiting_external', 'yielded'].includes(raw.state) ? 'wait' :
      reviewing ? 'review' : raw.checkpoint?.stage === 'planning' || raw.checkpoint === null ? 'plan' : 'coordinate';
    const label = raw.state === 'completed' ? 'Result saved' : raw.state === 'paused' ? 'Work paused by you' :
      raw.state === 'cancelled' ? 'Work cancelled' : raw.state === 'blocked' ? 'Work needs review' :
      raw.state === 'waiting_children' ? 'Waiting for specialist results' : ['waiting_external'].includes(raw.state) ? 'Waiting for a service update' :
      ['awaiting_calendar'].includes(raw.state) ? 'Waiting for calendar permission' : raw.state === 'yielded' ? 'Waiting to continue saved work' :
      state === 'queued' ? 'Work queued' : reviewing ? 'Reviewing the recorded work' : kind === 'plan' ? 'Planning the work' : 'Coordinating the work';
    actions.push({ id: publicId(raw.scope, id, raw.controlVersion, raw.checkpointVersion, raw.generation, raw.state), actorId,
      kind, target: kind === 'result' || kind === 'review' ? 'result' : kind === 'plan' ? 'plan' : 'team',
      state: passive(state), label, recordedAt: raw.updatedAt });
    const children = frame.children.filter(child => child.current).sort((a, b) => a.taskId.localeCompare(b.taskId));
    for (const child of children) {
      const childActor = publicId(raw.scope, id, child.taskId), base = labels[child.role];
      agents.push({ id: childActor, role: child.role, label: base });
      let childState: ActivityAction['state'] = child.state === 'ready' ? 'queued' : child.state === 'running' ? 'active' :
        child.state === 'paused' ? 'paused' : child.state === 'cancelled' ? 'cancelled' : child.outcome === 'advice_ready' ? 'completed' : 'needs_review';
      // A retained active child record is not proof of ongoing execution after root controls.
      if (['paused', 'cancelled'].includes(raw.state) && ['active', 'queued'].includes(childState)) childState = raw.state as 'paused' | 'cancelled';
      else if (['completed', 'blocked', 'waiting_external', 'awaiting_calendar'].includes(raw.state) && childState === 'active') childState = 'waiting';
      actions.push({ id: publicId(raw.scope, id, child.taskId, child.assignmentVersion, child.generation, child.state, child.outcome, raw.controlVersion, raw.state),
        actorId: childActor, kind: child.role === 'escalation' ? 'review' : 'coordinate', target: child.role === 'escalation' ? 'result' : 'team',
        state: passive(childState), label: childState === 'completed' ? 'Contribution recorded' : childState === 'needs_review' ? 'Contribution needs review' :
          childState === 'paused' ? 'Assignment paused' : childState === 'cancelled' ? 'Assignment cancelled' : childState === 'queued' ? 'Assignment queued' :
          childState === 'active' ? 'Working on an assigned contribution' : 'Recorded assignment', recordedAt: null });
    }
  }
  return NativeWorkActivityResponseSchema.parse({ scope: raw.scope, activity: { rootTaskId: id, asOf: frame.observedAt,
    recordedAt: raw.updatedAt, freshUntil: new Date(Date.parse(frame.observedAt) + 10_000).toISOString(), expiresAt: raw.expiresAt,
    revision: { controlVersion: raw.controlVersion, checkpointVersion: raw.checkpointVersion, generation: raw.generation,
      instructionRevision: frame.instructionRevision }, freshness, observation: 'snapshot', agents, actions, externalEffects: 'forbidden' } });
}
