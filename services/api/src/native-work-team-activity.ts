import { createHash } from 'node:crypto';
import { InstantSchema, type Session } from '@pactwoven/contracts';
import { DomainError } from '@pactwoven/domain';
import { NativeWorkExecutionFrameSchema } from '../../../packages/db/src/native-work-execution-repository';
import { NativeWorkTeamActivityResponseSchema } from '../../../packages/contracts/src/native-work-team-activity';

const unavailable = () => new DomainError('DURABLE_SERVICE_UNAVAILABLE', 503, 'Current team activity could not be confirmed.');
const labels = { research: 'Research', planning: 'Planning', escalation: 'Review' } as const;
/** Current execution metadata never upgrades a historical checkpoint or discloses its content. */
export function projectNativeWorkTeamActivity(session: Session, id: string, siteId: string, value: unknown, now = new Date().toISOString()) {
  const actor = session.actor;
  if (actor.principalKind !== 'human' || !actor.siteIds.includes(siteId) || !session.sites.some(site => site.id === siteId))
    throw new DomainError('FORBIDDEN', 403, 'Your current access does not permit this work request.');
  const parsed = NativeWorkExecutionFrameSchema.safeParse(value), clock = InstantSchema.safeParse(now);
  if (!parsed.success || !clock.success) throw unavailable();
  const frame = parsed.data, root = frame.root, execution = frame.currentExecution;
  const observed = Date.parse(frame.observedAt), time = Date.parse(now);
  if (root.id !== id || root.scope.environment !== actor.environment || root.scope.organizationId !== actor.organizationId ||
      root.scope.siteId !== siteId || observed > time || observed < Date.parse(root.updatedAt) || time - observed > 10_000) throw unavailable();
  const verified = execution.kind === 'verified' && root.state === 'waiting_children' && !root.evidenceUnavailable &&
    Date.parse(execution.validUntil) > time && Date.parse(root.expiresAt) > time;
  if (execution.kind === 'verified' && (Date.parse(execution.validUntil) > Math.min(observed + 10_000, Date.parse(root.expiresAt)) ||
      execution.children.some(child => !child.current || child.state === 'running' && (child.leaseUntil === null || Date.parse(child.leaseUntil) < Date.parse(execution.validUntil))))) throw unavailable();
  return NativeWorkTeamActivityResponseSchema.parse({ scope: root.scope, teamActivity: {
    rootTaskId: id, recordedAt: root.updatedAt, asOf: frame.observedAt, controlVersion: root.controlVersion,
    instructionRevision: frame.instructionRevision, status: verified ? 'verified' : 'unavailable',
    validUntil: verified ? execution.validUntil : null,
    agents: verified ? execution.children.map(child => ({
      id: createHash('sha256').update(JSON.stringify([root.scope, id, child.taskId, child.handoffId, child.assignmentVersion])).digest('hex').slice(0, 32),
      role: child.role, label: labels[child.role], state: child.state === 'running' ? 'working' : 'queued',
    })) : [], authority: 'none',
  } });
}
