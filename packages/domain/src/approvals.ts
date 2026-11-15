import { ActorContextSchema, ApprovalPolicySchema, ApprovalReceiptSchema, StepUpEvidenceSchema,
  type ActionBinding, type ActorContext, type ApprovalPolicy, type ApprovalReceipt, type MandateHead, type MandateVersion, type StepUpEvidence } from '@pactwoven/contracts';
import { canonicalJson, commandDigest } from './canonical.js';
import { assertCurrentMandate, immutable, instant } from './financial-primitives.js';
import { assertActionActorScope, validateActionBinding } from './action-binding.js';
import { DomainError } from './errors.js';
export { validateActionBinding } from './action-binding.js';
export type CurrentApprovalEvidence = {
  receipt: ApprovalReceipt; policy: ApprovalPolicy; approver: ActorContext; stepUp: StepUpEvidence; requesterId: string;
};

function hasEligibleBuyerApprovalRole(actor: ActorContext, policy: ApprovalPolicy): boolean {
  // A configurable policy can narrow buyer approval authority, never grant it
  // to a read-only, receiver, supplier, support or service role.
  return actor.roles.some(role => (role === 'owner' || role === 'finance' || role === 'operations') && policy.eligibleRoles.includes(role));
}

export async function approveExactAction(context: {
  receiptId: string; requesterId: string; actor: ActorContext; stepUp: StepUpEvidence; policy: ApprovalPolicy; head: MandateHead; mandate: MandateVersion; now: string;
}, input: ActionBinding): Promise<ApprovalReceipt> {
  const action = validateActionBinding(input);
  const actor = ActorContextSchema.parse(context.actor);
  const policy = ApprovalPolicySchema.parse(context.policy);
  const proof = StepUpEvidenceSchema.parse(context.stepUp);
  const now = instant(context.now);
  assertActionActorScope(action, actor);
  const mandate = await assertCurrentMandate(action, context.head, context.mandate, context.now);
  if (actor.principalKind !== 'human' || actor.actorId === context.requesterId || !hasEligibleBuyerApprovalRole(actor, policy) ||
      actor.organizationId !== action.authority.organizationId || actor.environment !== action.authority.environment ||
      policy.organizationId !== actor.organizationId || policy.environment !== actor.environment) {
    throw new DomainError('FORBIDDEN', 403, 'A separate currently eligible approver is required.');
  }
  if (proof.actorId !== actor.actorId || proof.sessionId !== actor.sessionId || instant(proof.verifiedAt) > now ||
      now - instant(proof.verifiedAt) >= policy.maximumStepUpAgeMs || instant(proof.expiresAt) <= now) {
    throw new DomainError('STEP_UP_REQUIRED', 403, 'Fresh verified step-up for this actor and session is required.');
  }
  const expires = Math.min(instant(action.expiresAt), instant(policy.expiresAt), instant(context.head.expiresAt), instant(mandate.policy.expiresAt),
    instant(proof.expiresAt), instant(proof.verifiedAt) + policy.maximumStepUpAgeMs, now + policy.maximumApprovalAgeMs);
  if (expires <= now) throw new DomainError('TERMS_EXPIRED', 409, 'The action or approval policy expired.');
  return immutable(ApprovalReceiptSchema.parse({ id: context.receiptId, actionHash: await commandDigest(action), authority: action.authority,
    policy: policy.reference, requesterId: context.requesterId, approverId: actor.actorId, approverSessionId: actor.sessionId,
    stepUpEvidenceId: proof.id, stepUpVerifiedAt: proof.verifiedAt, stepUpExpiresAt: proof.expiresAt,
    approvedAt: context.now, expiresAt: new Date(expires).toISOString() }));
}

/** Called with freshly resolved actors/policy; receipt presence alone is not permission. */
export async function assertApprovalCurrent(receiptInput: ApprovalReceipt, actionInput: ActionBinding, context: {
  head: MandateHead; mandate: MandateVersion; policy: ApprovalPolicy; approver: ActorContext; stepUp: StepUpEvidence; requesterId: string; now: string;
}): Promise<void> {
  const receipt = ApprovalReceiptSchema.parse(receiptInput);
  const action = validateActionBinding(actionInput);
  const policy = ApprovalPolicySchema.parse(context.policy);
  const actor = ActorContextSchema.parse(context.approver);
  const proof = StepUpEvidenceSchema.parse(context.stepUp);
  const now = instant(context.now);
  const approvalTime = instant(receipt.approvedAt);
  const mandate = await assertCurrentMandate(action, context.head, context.mandate, context.now);
  const boundedExpiry = Math.min(instant(action.expiresAt), instant(policy.expiresAt), instant(context.head.expiresAt), instant(mandate.policy.expiresAt),
    instant(proof.expiresAt), instant(proof.verifiedAt) + policy.maximumStepUpAgeMs, approvalTime + policy.maximumApprovalAgeMs);
  if (receipt.actionHash !== await commandDigest(action) || canonicalJson(receipt.authority) !== canonicalJson(action.authority) ||
      canonicalJson(receipt.policy) !== canonicalJson(policy.reference) || receipt.requesterId !== context.requesterId ||
      receipt.approverId === context.requesterId || receipt.approverId !== actor.actorId || receipt.approverSessionId !== actor.sessionId ||
      actor.principalKind !== 'human' || actor.organizationId !== action.authority.organizationId || actor.environment !== action.authority.environment ||
      !actor.actionSiteIds.includes(action.siteId) ||
      policy.organizationId !== actor.organizationId || policy.environment !== actor.environment || !hasEligibleBuyerApprovalRole(actor, policy) ||
      proof.id !== receipt.stepUpEvidenceId || proof.actorId !== actor.actorId || proof.sessionId !== actor.sessionId ||
      receipt.stepUpVerifiedAt !== proof.verifiedAt || receipt.stepUpExpiresAt !== proof.expiresAt || instant(proof.verifiedAt) > approvalTime ||
      approvalTime > now || boundedExpiry <= now || instant(receipt.expiresAt) > boundedExpiry || instant(receipt.expiresAt) <= now) {
    throw new DomainError('APPROVAL_INVALID', 409, 'The exact approval is stale, changed or no longer authorized.');
  }
}
