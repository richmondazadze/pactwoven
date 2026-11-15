import type { Operation, Session } from '@pactwoven/contracts';
import { isAccessOwner } from './access-review';
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
