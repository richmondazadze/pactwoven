import { IdSchema, MandateDecisionIntentSchema, MandateOperationResultSchema, type MandateDecisionIntent, type MandateHead, type MandateOperationResult, type MandateReview, type MandateVersion } from '@pactwoven/contracts';
import { canonicalJson, commandDigest } from '@pactwoven/contracts/canonical';
import { RequestError } from './api';
import { MANDATE_OBSERVATION_LIFETIME_MS, qualifyMandateReview, type MandateReadScope } from './mandates';
import { MandateRecoverySchema, matchesMandateRecoveryScope, type MandateRecovery } from './mandate-recovery';

export const MANDATE_VERIFICATION_LIFETIME_MS = 240_000;
export const sameMandateValue = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
export const decisionKind = (action: MandateDecisionIntent['action']) => action === 'AUTHORIZE' ? 'mandate.authorize' as const : 'mandate.reject' as const;
export const decisionPath = (responsibilityId: string, proposalId: string) => `/v1/responsibilities/${IdSchema.parse(responsibilityId)}/mandate-proposals/${IdSchema.parse(proposalId)}/decision`;
export function mandateActionError(message = 'The exact mandate decision could not be verified. Its outcome has not been assumed.'): never { throw new RequestError('MANDATE_DECISION_UNVERIFIED', message); }
export async function decisionDigests(scope: Pick<MandateReadScope, 'environment' | 'organizationId' | 'actorId' | 'responsibilityId'>, input: MandateDecisionIntent) {
  const intent = MandateDecisionIntentSchema.parse(input);
  return { commandHash: await commandDigest({ schemaVersion: 1, environment: scope.environment, organizationId: scope.organizationId, actorId: scope.actorId, kind: decisionKind(intent.action), route: { responsibilityId: scope.responsibilityId, targetId: intent.proposal.id }, command: intent }), intentHash: await commandDigest({ purpose: 'mandate_authorization', intent }) };
}
export function decisionAvailable(review: MandateReview, scope: MandateReadScope, action: MandateDecisionIntent['action'], now: number) {
  const e = review.envelope, p = e.proposal, eligibility = e.eligibility.find(item => item.action === action);
  return Boolean(p && e.decision?.state === 'OPEN' && review.effectiveDecisionState === 'OPEN' && e.organizationEpoch === scope.organizationEpoch && p.organizationEpoch === scope.organizationEpoch &&
    e.responsibility.id === scope.responsibilityId && sameMandateValue(p.responsibility, e.responsibilityReference) && scope.principalKind === 'human' && scope.roles.some(role => role === 'owner' || role === 'finance') &&
    scope.siteIds.includes(p.responsibility.siteId) && scope.actionSiteIds.includes(p.responsibility.siteId) && scope.actorId !== p.requesterId && eligibility?.eligible && eligibility.requiresStepUp === (action === 'AUTHORIZE') &&
    Number.isFinite(now) && now >= Date.parse(e.observedAt) && now < Date.parse(e.observedAt) + MANDATE_OBSERVATION_LIFETIME_MS && now < Date.parse(p.expiresAt) && now < Date.parse(p.policy.expiresAt));
}
export async function prepareMandateDecision(review: MandateReview, scope: MandateReadScope, action: MandateDecisionIntent['action'], reason: string, now: number): Promise<MandateDecisionIntent> {
  const p = review.envelope.proposal;
  if (!p) mandateActionError();
  await qualifyMandateReview(review, scope, p.id, p.version);
  if (!decisionAvailable(review, scope, action, now)) throw new RequestError('MANDATE_REVIEW_REQUIRED', 'Refresh the exact proposal and check current decision eligibility before reviewing this action.');
  return MandateDecisionIntentSchema.parse({ schemaVersion: 1, action, proposal: { id: p.id, version: p.version, hash: p.hash }, expectedDecisionVersion: review.envelope.decision!.version, expectedOrganizationEpoch: scope.organizationEpoch, expectedHead: p.expectedHead, reason: action === 'AUTHORIZE' ? null : reason });
}
export function verificationCurrent(at: number | null, now: number) { return at !== null && now >= at && now - at < MANDATE_VERIFICATION_LIFETIME_MS; }
export function qualifyMandateOperation(input: unknown, locator: MandateRecovery): MandateOperationResult {
  MandateRecoverySchema.parse(locator);
  const result = MandateOperationResultSchema.parse(input);
  if (result.organizationId !== locator.organizationId || result.operation.environment !== locator.environment || result.kind !== locator.kind || result.responsibilityId !== locator.responsibilityId ||
      result.target.kind !== 'decision' || result.target.id !== locator.proposal.id || result.target.version !== locator.expectedDecisionVersion + 1 || result.commandHash !== locator.commandHash || result.intentHash !== locator.intentHash || result.operation.financialState !== null) mandateActionError();
  return result;
}
export function mandateOperationSucceeded(result: MandateOperationResult) { return result.operation.status === 'succeeded' && result.operation.error === null && result.operation.nextCheckAt === null && result.operation.evidenceRefs.length === 0; }

// This verifies a recorded decision, including after memory loss. It never supplies a command for retry.
export async function qualifyMandateDecisionReceipt(input: unknown, scope: MandateReadScope, locator: MandateRecovery, resultInput: MandateOperationResult, original?: MandateDecisionIntent): Promise<MandateReview> {
  if (!matchesMandateRecoveryScope(locator, scope) || locator.responsibilityId !== scope.responsibilityId) mandateActionError();
  const result = qualifyMandateOperation(resultInput, locator);
  if (!mandateOperationSucceeded(result)) mandateActionError();
  const review = await qualifyMandateReview(input, scope, locator.proposal.id, locator.proposal.version), e = review.envelope, p = e.proposal!, d = e.decision!;
  if (!sameMandateValue({ id: p.id, version: p.version, hash: p.hash }, locator.proposal) || d.version !== locator.expectedDecisionVersion + 1 || d.operationId !== result.operation.id || d.actorId !== locator.actorId || d.intentHash !== locator.intentHash || d.decidedAt !== result.observedAt ||
      d.state !== (locator.kind === 'mandate.authorize' ? 'APPROVED' : 'REJECTED') || await commandDigest(d) !== result.target.hash) mandateActionError();
  const recordedIntent = MandateDecisionIntentSchema.parse({ schemaVersion: 1, action: locator.kind === 'mandate.authorize' ? 'AUTHORIZE' : 'REJECT', proposal: locator.proposal, expectedDecisionVersion: locator.expectedDecisionVersion, expectedOrganizationEpoch: p.organizationEpoch, expectedHead: p.expectedHead, reason: d.reason });
  const hashes = await decisionDigests(scope, recordedIntent);
  if (hashes.commandHash !== locator.commandHash || hashes.intentHash !== locator.intentHash || (original && !sameMandateValue(original, recordedIntent))) mandateActionError();
  if (d.authorization) {
    const a = d.authorization, approvedAt = Date.parse(a.approvedAt);
    const accepted: MandateVersion = { id: p.mandateId, organizationId: p.organizationId, environment: p.environment, responsibilityId: p.responsibility.id, version: (p.previousAcceptedVersion?.version ?? 0) + 1, mandateEpoch: (p.expectedHead?.mandateEpoch ?? 0) + 1, organizationEpoch: p.organizationEpoch, policy: p.policy, policyHash: p.policyHash, previousVersionHash: p.previousAcceptedVersion?.hash ?? null, createdAt: a.approvedAt, createdBy: p.requesterId };
    const head: MandateHead = { organizationId: p.organizationId, environment: p.environment, organizationEpoch: p.organizationEpoch, mandateId: accepted.id, mandateVersion: accepted.version, mandateEpoch: accepted.mandateEpoch, responsibilityId: p.responsibility.id, state: 'ACTIVE', policyHash: accepted.policyHash, expiresAt: p.policy.expiresAt };
    if (a.requesterId !== p.requesterId || a.approverId !== locator.actorId || a.approverId === a.requesterId || a.intentHash !== locator.intentHash || a.approvedAt !== d.decidedAt || approvedAt < Date.parse(p.createdAt) || approvedAt >= Date.parse(p.expiresAt) || approvedAt - Date.parse(a.stepUpVerifiedAt) >= 300_000 ||
        !sameMandateValue(a.acceptedVersion, { id: accepted.id, version: accepted.version, hash: await commandDigest(accepted) }) || !sameMandateValue(a.acceptedHead, { mandateId: head.mandateId, mandateVersion: head.mandateVersion, mandateEpoch: head.mandateEpoch, hash: await commandDigest(head) })) mandateActionError();
  }
  return review;
}
