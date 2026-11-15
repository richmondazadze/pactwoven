import type { Operation, Session } from '@pactwoven/contracts';
import { isAccessOwner } from './access-review';
import { AccessRecoveryResultSchema } from '@pactwoven/contracts';
import type { AccessFencedResult } from './access-closure';
export type AccessReceipt = { id: string; status: 'succeeded' | 'failed'; aggregateVersion: number };
export type AccessNotice = {
  actorId: string; organizationId: string; environment: Session['actor']['environment'];
  receipt: AccessReceipt;
};
// A terminal display receipt is not an authorization, draft, retry command or MFA proof.
export function accessNoticeFromOperation(session: Session, operation: Operation): AccessNotice | null {
  if (!isAccessOwner(session) || operation.environment !== session.actor.environment || (operation.status !== 'succeeded' && operation.status !== 'failed')) return null;
  return {
    actorId: session.actor.actorId, organizationId: session.actor.organizationId, environment: session.actor.environment,
    receipt: { id: operation.id, status: operation.status, aggregateVersion: operation.aggregateVersion },
  };
}
export function visibleAccessReceipt(notice: AccessNotice | null, session: Session): AccessReceipt | null {
  return notice && isAccessOwner(session) && notice.actorId === session.actor.actorId && notice.organizationId === session.actor.organizationId && notice.environment === session.actor.environment ? notice.receipt : null;
}
export type AccessFenceReceipt = { id: string; closedAt: string; kind: 'grant' | 'revise' | 'revoke'; key: string };
export type AccessFenceNotice = { actorId: string; organizationId: string; environment: Session['actor']['environment']; receipt: AccessFenceReceipt };
export function accessFenceNoticeFromResult(session: Session, input: AccessFencedResult): AccessFenceNotice | null {
  const parsed = AccessRecoveryResultSchema.safeParse(input);
  if (!parsed.success || parsed.data.disposition !== 'fenced') return null;
  const result = parsed.data;
  if (!isAccessOwner(session) || result.environment !== session.actor.environment || result.organizationId !== session.actor.organizationId || result.organizationId !== session.organization.id || result.reviewer.actorId !== session.actor.actorId) return null;
  return { actorId: session.actor.actorId, organizationId: result.organizationId, environment: result.environment, receipt: { id: result.fence.id, closedAt: result.fence.closedAt, kind: result.kind, key: result.key } };
}
export function visibleAccessFenceReceipt(notice: AccessFenceNotice | null, session: Session): AccessFenceReceipt | null {
  return notice && isAccessOwner(session) && notice.actorId === session.actor.actorId && notice.organizationId === session.actor.organizationId && notice.organizationId === session.organization.id && notice.environment === session.actor.environment ? notice.receipt : null;
}
