import { MandateHeadSchema, MandatePolicySchema, MandateVersionSchema,
  type ActionBinding, type ActorContext, type MandateHead, type MandatePolicy, type MandateVersion } from '@pactwoven/contracts';
import { assertActionActorScope, validateActionBinding } from './action-binding.js';
import { assertApprovalCurrent, type CurrentApprovalEvidence } from './approvals.js';
import { assertCurrentMandate, immutable, instant, nextVersion } from './financial-primitives.js';
import { commandDigest } from './canonical.js';
import { DomainError } from './errors.js';
export { assertCurrentAuthority, immutable, instant, nextVersion } from './financial-primitives.js';
export function validateMandatePolicy(policy: MandatePolicy, now: string): MandatePolicy {
  const parsed = MandatePolicySchema.parse(policy);
  if (instant(parsed.expiresAt) <= instant(now) || instant(parsed.communication.expiresAt) > instant(parsed.expiresAt)) {
    throw new DomainError('TERMS_EXPIRED', 409, 'Mandate and communication expiry must be bounded and current.');
  }
  const keys = parsed.budgets.map(limit => `${limit.assetId}:${limit.category}`);
  if (new Set(keys).size !== keys.length || new Set(parsed.siteIds).size !== parsed.siteIds.length ||
      new Set(parsed.supplierRelationshipIds).size !== parsed.supplierRelationshipIds.length || new Set(parsed.actions).size !== parsed.actions.length) {
    throw new DomainError('VALIDATION_FAILED', 422, 'Policy scopes and budget dimensions must be unique.');
  }
  for (const limit of parsed.budgets) {
    if (instant(limit.periodStartsAt) >= instant(limit.periodEndsAt)) throw new DomainError('VALIDATION_FAILED', 422, 'A budget period must have positive duration.');
  }
  if (parsed.communication.maximumMessages > 0 && (!parsed.communication.recipientIds.length || !parsed.communication.purposes.length || !parsed.communication.messageKinds.length)) {
    throw new DomainError('VALIDATION_FAILED', 422, 'Communication requires recipients, purpose and message scope.');
  }
  return parsed;
}

/** Builds an immutable proposal. Activation still requires the authorized command path. */
export async function createMandateVersion(context: {
  id: string; organizationId: string; environment: MandateVersion['environment']; responsibilityId: string;
  authorId: string; organizationEpoch: number; currentMandateEpoch: number; expectedVersion: number; now: string;
}, policy: MandatePolicy, previous: MandateVersion | null): Promise<MandateVersion> {
  const prior = previous ? MandateVersionSchema.parse(previous) : null;
  if (context.expectedVersion !== (prior?.version ?? 0) || (prior && (prior.id !== context.id || prior.organizationId !== context.organizationId ||
      prior.environment !== context.environment || prior.responsibilityId !== context.responsibilityId || context.organizationEpoch < prior.organizationEpoch ||
      context.currentMandateEpoch < prior.mandateEpoch)) || (!prior && context.currentMandateEpoch !== 0)) {
    throw new DomainError('VERSION_CONFLICT', 409, 'The current mandate and organization version are required.');
  }
  const parsed = validateMandatePolicy(policy, context.now);
  return immutable(MandateVersionSchema.parse({ id: context.id, organizationId: context.organizationId, environment: context.environment,
    responsibilityId: context.responsibilityId, version: nextVersion(prior?.version ?? 0), mandateEpoch: nextVersion(context.currentMandateEpoch),
    organizationEpoch: context.organizationEpoch, policy: parsed, policyHash: await commandDigest(parsed),
    previousVersionHash: prior ? await commandDigest(prior) : null, createdAt: context.now, createdBy: context.authorId }));
}

/** All context is freshly resolved under the command transaction; caller flags cannot stand in for approval. */
export async function assertMandateAction(action: ActionBinding, head: MandateHead, mandate: MandateVersion, now: string,
  approval: CurrentApprovalEvidence | null, actor: ActorContext): Promise<void> {
  action = validateActionBinding(action);
  assertActionActorScope(action, actor);
  const current = await assertCurrentMandate(action, head, mandate, now);
  if ((actor.principalKind === 'service' && !actor.roles.includes('service')) ||
      (actor.principalKind === 'human' && !actor.roles.some(role => ['owner', 'operations', 'finance'].includes(role)))) {
    throw new DomainError('FORBIDDEN', 403, 'A currently eligible buyer or explicitly scoped service principal is required.');
  }
  if (['ADVISE', 'SHADOW'].includes(current.policy.mode) || !current.policy.actions.includes(action.kind)) {
    throw new DomainError('FORBIDDEN', 403, 'This mandate does not permit the requested effect.');
  }
  if (!current.policy.siteIds.includes(action.siteId) ||
      (action.supplierRelationshipId && !current.policy.supplierRelationshipIds.includes(action.supplierRelationshipId)) ||
      (['accept_offer', 'reserve_capacity', 'activate_commitment', 'pay_supplier'].includes(action.kind) && !action.supplierRelationshipId)) {
    throw new DomainError('FORBIDDEN', 403, 'The site or supplier relationship is outside this mandate.');
  }
  const amounts = new Map<string, bigint>();
  for (const component of action.components) {
    const key = `${component.assetId}:${component.category}`;
    amounts.set(key, (amounts.get(key) ?? 0n) + BigInt(component.amountBaseUnits));
  }
  for (const [key, value] of amounts) {
    const limit = current.policy.budgets.find(item => `${item.assetId}:${item.category}` === key);
    if (!limit || instant(limit.periodStartsAt) > instant(now) || instant(limit.periodEndsAt) <= instant(now) || value > BigInt(limit.perOperation)) {
      throw new DomainError('APPROVAL_REQUIRED', 403, 'The action exceeds an explicit current mandate budget dimension.');
    }
  }
  if (current.policy.mode === 'PREPARE_FOR_APPROVAL' && !approval) throw new DomainError('APPROVAL_REQUIRED', 403, 'Exact-action approval is required.');
  if (approval) {
    await assertApprovalCurrent(approval.receipt, action, { ...approval, head, mandate, now });
  }
}

export function changeAuthorityState(head: MandateHead, state: 'ACTIVE' | 'PAUSED' | 'REVOKED', expectedEpoch: number): MandateHead {
  const current = MandateHeadSchema.parse(head);
  if (expectedEpoch !== current.mandateEpoch || current.state === 'REVOKED' || current.state === 'EXPIRED') {
    throw new DomainError('AUTHORITY_CHANGED', 409, 'This authority cannot be reused or changed from a stale epoch.');
  }
  return immutable({ ...current, state, mandateEpoch: nextVersion(current.mandateEpoch) });
}
