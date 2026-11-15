import { z } from 'zod';
import {
  ActorContextSchema, HashSchema, IdSchema, InstantSchema, MandateAuthorityIntentSchema, MandateDecisionIntentSchema,
  MandateDecisionSchema, MandateHeadSchema, type ActorContext, type MandateAuthorityIntent, type MandateDecision,
  type MandateDecisionIntent, type MandateEligibility, type MandateHead, type MandateProposalVersion,
} from '@pactwoven/contracts';
import { createMandateVersion } from './authority.js';
import { commandDigest } from './canonical.js';
import { DomainError } from './errors.js';
import { immutable, instant, nextVersion } from './financial-primitives.js';
import {
  assertMandateActor, assertMandateDecisionOpen, assertMandateProposalCurrent, equalMandateValue, mandateHeadReference,
  mandateReference, mandateResponsibilityReference, mandateVersionReference, resolveMandatePolicyDocuments,
  validateConnectedMandatePolicy, validateMandateCurrentContext, validateMandateStopContext, validateMandateDecision, validateMandateProposalVersion,
  type MandateCurrentContext,
} from './mandate-proposals.js';

// Shape checking is not identity-provider verification. Only the private verified boundary may construct this context.
const VerifiedMandateEvidenceSchema = z.strictObject({
  id: IdSchema, purpose: z.enum(['mandate_authorization', 'mandate_control']), intentHash: HashSchema,
  actorId: IdSchema, sessionId: z.string().min(1).max(256), verifiedAt: InstantSchema, expiresAt: InstantSchema,
});
export type VerifiedMandateEvidence = z.infer<typeof VerifiedMandateEvidenceSchema>;
const maximumStepUpAgeMs = 300_000;
export async function mandateIntentHash(input: MandateDecisionIntent | MandateAuthorityIntent): Promise<string> {
  const decision = MandateDecisionIntentSchema.safeParse(input);
  const intent = decision.success ? decision.data : MandateAuthorityIntentSchema.parse(input);
  return commandDigest({ purpose: decision.success ? 'mandate_authorization' : 'mandate_control', intent });
}
function assertVerifiedEvidence(input: VerifiedMandateEvidence | null, purpose: VerifiedMandateEvidence['purpose'],
  intentHash: string, actor: ActorContext, now: string): VerifiedMandateEvidence {
  const parsed = VerifiedMandateEvidenceSchema.safeParse(input);
  if (!parsed.success) throw new DomainError('STEP_UP_REQUIRED', 403, 'Purpose-specific verified MFA is required.');
  const proof = parsed.data;
  if (proof.purpose !== purpose || proof.intentHash !== intentHash || proof.actorId !== actor.actorId || proof.sessionId !== actor.sessionId ||
      instant(proof.verifiedAt) > instant(now) || instant(proof.expiresAt) <= instant(now) ||
      instant(now) - instant(proof.verifiedAt) >= maximumStepUpAgeMs) {
    throw new DomainError('STEP_UP_REQUIRED', 403, 'Fresh verified MFA must bind this exact intent, actor, session and purpose.');
  }
  return immutable({ ...proof, expiresAt: new Date(Math.min(instant(proof.expiresAt), instant(proof.verifiedAt) + maximumStepUpAgeMs)).toISOString() });
}
function assertIndependentReviewer(proposal: MandateProposalVersion, context: MandateCurrentContext, actorInput: ActorContext, requesterInput: ActorContext): ActorContext {
  const actor = assertMandateActor(actorInput, context, ['owner', 'finance']);
  const requester = assertMandateActor(requesterInput, context, ['owner', 'finance', 'operations']);
  if (requester.actorId !== proposal.requesterId) throw new DomainError('REQUESTER_CHANGED', 409, 'The current original requester must resolve independently.');
  if (actor.actorId === proposal.requesterId) throw new DomainError('INDEPENDENT_APPROVER_REQUIRED', 403, 'The requester cannot decide their own mandate authority.');
  return actor;
}
async function assertDecisionCandidate(proposalInput: MandateProposalVersion, decisionInput: MandateDecision,
  context: MandateCurrentContext & { actor: ActorContext; requester: ActorContext }): Promise<{ proposal: MandateProposalVersion; decision: MandateDecision; actor: ActorContext }> {
  const proposal = await validateMandateProposalVersion(proposalInput);
  const decision = validateMandateDecision(decisionInput, proposal);
  assertMandateDecisionOpen(decision);
  await assertMandateProposalCurrent(proposal, context);
  return { proposal, decision, actor: assertIndependentReviewer(proposal, context, context.actor, context.requester) };
}
/** Role-scoped eligibility is for presentation; it is not a verified approval or permission to skip revalidation at the effect. */
export async function mandateDecisionEligibility(proposal: MandateProposalVersion, decision: MandateDecision,
  context: MandateCurrentContext & { actor: ActorContext; requester: ActorContext }): Promise<MandateEligibility[]> {
  let blockers: string[] = [];
  try { await assertDecisionCandidate(proposal, decision, context); }
  catch (error) { if (error instanceof DomainError) blockers = [error.code]; else throw error; }
  return immutable((['AUTHORIZE', 'REJECT'] as const).map(action => ({ action, eligible: blockers.length === 0, requiresStepUp: action === 'AUTHORIZE', blockers: [...blockers] })));
}

/** A pure atomic write plan, not a durable authorization by itself. The caller must re-resolve all current context under stable locks. */
export async function decideMandateProposal(context: MandateCurrentContext & {
  actor: ActorContext; requester: ActorContext; stepUp: VerifiedMandateEvidence | null; receiptId: string; operationId: string;
}, proposalInput: MandateProposalVersion, decisionInput: MandateDecision, intentInput: MandateDecisionIntent) {
  const intent = MandateDecisionIntentSchema.parse(intentInput);
  const { proposal, decision, actor } = await assertDecisionCandidate(proposalInput, decisionInput, context);
  if (!equalMandateValue(intent.proposal, mandateReference(proposal)) || intent.expectedDecisionVersion !== decision.version ||
      intent.expectedOrganizationEpoch !== context.organizationEpoch || !equalMandateValue(intent.expectedHead, proposal.expectedHead)) {
    throw new DomainError('DECISION_CHANGED', 409, 'The exact current proposal, decision version and authority are required.');
  }
  const intentHash = await mandateIntentHash(intent);
  if (intent.action === 'REJECT') {
    return immutable({ decision: MandateDecisionSchema.parse({ ...decision, version: 2, state: 'REJECTED', decidedAt: context.now,
      actorId: actor.actorId, intentHash, reason: intent.reason, operationId: context.operationId }), authorityChange: null });
  }
  const proof = assertVerifiedEvidence(context.stepUp, 'mandate_authorization', intentHash, actor, context.now);
  const acceptedVersion = await createMandateVersion({ id: proposal.mandateId, organizationId: context.organizationId,
    environment: context.environment, responsibilityId: proposal.responsibility.id, authorId: proposal.requesterId,
    organizationEpoch: context.organizationEpoch, currentMandateEpoch: context.head?.mandateEpoch ?? 0,
    expectedVersion: context.acceptedVersion?.version ?? 0, now: context.now }, proposal.policy, context.acceptedVersion);
  const head = immutable(MandateHeadSchema.parse({ organizationId: context.organizationId, environment: context.environment,
    organizationEpoch: context.organizationEpoch, mandateId: acceptedVersion.id, mandateVersion: acceptedVersion.version,
    mandateEpoch: acceptedVersion.mandateEpoch, responsibilityId: acceptedVersion.responsibilityId,
    state: 'ACTIVE', policyHash: acceptedVersion.policyHash, expiresAt: acceptedVersion.policy.expiresAt }));
  const authorization = { id: context.receiptId, purpose: 'mandate_authorization' as const, intentHash,
    requesterId: proposal.requesterId, approverId: actor.actorId, approvedAt: context.now,
    stepUpEvidenceId: proof.id, stepUpVerifiedAt: proof.verifiedAt, stepUpExpiresAt: proof.expiresAt,
    acceptedVersion: await mandateVersionReference(acceptedVersion), acceptedHead: await mandateHeadReference(head) };
  return immutable({ decision: MandateDecisionSchema.parse({ ...decision, version: 2, state: 'APPROVED', decidedAt: context.now,
    actorId: actor.actorId, intentHash, authorization, operationId: context.operationId }), authorityChange: { acceptedVersion, head } });
}

/** Return only the already-recorded operation identity. This never reapplies a decision, even after policy/proof expiry. */
export async function recoverMandateDecisionOperation(proposalInput: MandateProposalVersion, decisionInput: MandateDecision,
  intentInput: MandateDecisionIntent, actorInput: ActorContext): Promise<string> {
  const proposal = await validateMandateProposalVersion(proposalInput);
  const decision = validateMandateDecision(decisionInput, proposal);
  const intent = MandateDecisionIntentSchema.parse(intentInput);
  const actor = ActorContextSchema.parse(actorInput);
  if (actor.organizationId !== proposal.organizationId || actor.environment !== proposal.environment || actor.principalKind !== 'human' ||
      !actor.siteIds.includes(proposal.responsibility.siteId) || actor.actorId !== decision.actorId) {
    throw new DomainError('FORBIDDEN', 403, 'Only the authenticated original decision actor with current read scope may recover this result.');
  }
  if (!equalMandateValue(intent.proposal, decision.proposal) || intent.expectedDecisionVersion + 1 !== decision.version ||
      decision.intentHash !== await mandateIntentHash(intent) || (intent.action === 'AUTHORIZE' ? decision.state !== 'APPROVED' : decision.state !== 'REJECTED')) {
    throw new DomainError('IDEMPOTENCY_CONFLICT', 409, 'Only the exact original completed decision can recover this operation.');
  }
  return decision.operationId;
}

async function assertAcceptedDecision(proposalInput: MandateProposalVersion, decisionInput: MandateDecision, context: MandateCurrentContext): Promise<MandateProposalVersion> {
  const proposal = await validateMandateProposalVersion(proposalInput);
  const decision = validateMandateDecision(decisionInput, proposal);
  const accepted = context.acceptedVersion!;
  const receipt = decision.authorization;
  const originalIntent: MandateDecisionIntent = { schemaVersion: 1, action: 'AUTHORIZE', proposal: mandateReference(proposal),
    expectedDecisionVersion: 1, expectedOrganizationEpoch: proposal.organizationEpoch, expectedHead: proposal.expectedHead, reason: null };
  const initialHead: MandateHead = { ...context.head!, state: 'ACTIVE', mandateEpoch: accepted.mandateEpoch, expiresAt: accepted.policy.expiresAt };
  if (decision.state !== 'APPROVED' || !receipt || receipt.intentHash !== await mandateIntentHash(originalIntent) || decision.intentHash !== receipt.intentHash ||
      receipt.requesterId !== proposal.requesterId || receipt.approverId === proposal.requesterId || decision.actorId !== receipt.approverId ||
      receipt.approvedAt !== accepted.createdAt || decision.decidedAt !== accepted.createdAt || instant(receipt.stepUpVerifiedAt) > instant(receipt.approvedAt) ||
      instant(receipt.approvedAt) < instant(proposal.createdAt) || instant(receipt.approvedAt) >= instant(proposal.expiresAt) ||
      instant(receipt.stepUpExpiresAt) <= instant(receipt.approvedAt) || instant(receipt.approvedAt) - instant(receipt.stepUpVerifiedAt) >= maximumStepUpAgeMs ||
      !equalMandateValue(receipt.acceptedVersion, await mandateVersionReference(accepted)) ||
      !equalMandateValue(receipt.acceptedHead, await mandateHeadReference(initialHead)) || accepted.id !== proposal.mandateId ||
      accepted.organizationId !== proposal.organizationId || accepted.environment !== proposal.environment || accepted.organizationEpoch !== proposal.organizationEpoch ||
      accepted.responsibilityId !== proposal.responsibility.id || accepted.createdBy !== proposal.requesterId ||
      accepted.version !== (proposal.previousAcceptedVersion?.version ?? 0) + 1 || accepted.previousVersionHash !== (proposal.previousAcceptedVersion?.hash ?? null) ||
      accepted.mandateEpoch !== (proposal.expectedHead?.mandateEpoch ?? 0) + 1 || accepted.policyHash !== proposal.policyHash || !equalMandateValue(accepted.policy, proposal.policy)) {
    throw new DomainError('APPROVAL_INVALID', 409, 'The accepted version must resolve to its exact independent authorization and full policy proposal.');
  }
  return proposal;
}

/** Stop commands need current owner/finance capability, but no MFA delay. Resume requires fresh, exact, independent MFA. */
export async function changeMandateAuthority(context: MandateCurrentContext & {
  actor: ActorContext; requester: ActorContext | null; stepUp: VerifiedMandateEvidence | null;
  acceptedProposal: MandateProposalVersion | null; acceptedDecision: MandateDecision | null; operationId: string;
}, input: MandateAuthorityIntent) {
  const intent = MandateAuthorityIntentSchema.parse(input);
  if (intent.action === 'PAUSE' || intent.action === 'REVOKE') await validateMandateStopContext(context);
  else await validateMandateCurrentContext(context);
  const actor = assertMandateActor(context.actor, context, ['owner', 'finance']);
  if (!context.head || !context.acceptedVersion || intent.expectedOrganizationEpoch !== context.organizationEpoch ||
      !equalMandateValue(intent.head, await mandateHeadReference(context.head)) ||
      !equalMandateValue(intent.mandate, await mandateVersionReference(context.acceptedVersion)) ||
      !equalMandateValue(intent.responsibility, await mandateResponsibilityReference(context.responsibility))) {
    throw new DomainError('AUTHORITY_CHANGED', 409, 'The exact current responsibility, mandate and head are required.');
  }
  const head = context.head;
  if (head.state === 'REVOKED' || head.state === 'EXPIRED' || instant(head.expiresAt) <= instant(context.now) ||
      (intent.action === 'PAUSE' && head.state !== 'ACTIVE') || (intent.action === 'RESUME' && head.state !== 'PAUSED')) {
    throw new DomainError('AUTHORITY_CHANGED', 409, 'The current state cannot make this transition; revoked or expired authority requires a new proposal.');
  }
  const intentHash = await mandateIntentHash(intent);
  let proof: VerifiedMandateEvidence | null = null;
  if (intent.action === 'RESUME') {
    if (!context.acceptedProposal || !context.acceptedDecision || !context.requester) {
      throw new DomainError('APPROVAL_INVALID', 409, 'Resume requires the accepted proposal, authorization and current original requester.');
    }
    const proposal = await assertAcceptedDecision(context.acceptedProposal, context.acceptedDecision, context);
    assertIndependentReviewer(proposal, context, actor, context.requester);
    if (proposal.organizationEpoch !== context.organizationEpoch || !equalMandateValue(proposal.responsibility, intent.responsibility)) {
      throw new DomainError('AUTHORITY_CHANGED', 409, 'Changed organization or responsibility authority requires a newly authorized version.');
    }
    validateConnectedMandatePolicy(context.acceptedVersion.policy, context.responsibility.siteId, context.now);
    await resolveMandatePolicyDocuments(proposal, context);
    proof = assertVerifiedEvidence(context.stepUp, 'mandate_control', intentHash, actor, context.now);
  }
  return immutable({ head: MandateHeadSchema.parse({ ...head, state: intent.action === 'PAUSE' ? 'PAUSED' : intent.action === 'REVOKE' ? 'REVOKED' : 'ACTIVE',
    mandateEpoch: nextVersion(head.mandateEpoch) }), intentHash, actorId: actor.actorId, occurredAt: context.now,
    stepUp: proof, operationId: IdSchema.parse(context.operationId) });
}

export function expireMandateAuthority(input: MandateHead, expectedEpoch: number, now: string): MandateHead {
  const head = MandateHeadSchema.parse(input);
  if (head.mandateEpoch !== expectedEpoch || head.state === 'REVOKED' || head.state === 'EXPIRED' || instant(head.expiresAt) > instant(now)) {
    throw new DomainError('AUTHORITY_CHANGED', 409, 'Only current, due authority may be expired once.');
  }
  return immutable({ ...head, state: 'EXPIRED', mandateEpoch: nextVersion(head.mandateEpoch) });
}
