import { z } from 'zod';
import { EnvironmentSchema, HashSchema, IdSchema, IdempotencyKeySchema, MandateDecisionIntentSchema, MandateReviewSchema, type MandateDecisionIntent, type MandateReview, type Session } from '@pactwoven/contracts';
import { commandDigest } from '@pactwoven/contracts/canonical';
import { decisionAvailable, decisionDigests, mandateActionError, sameMandateValue } from './mandate-actions';
import { createMandateReadScope, qualifyMandateReview, type MandateReadScope } from './mandates';
export const MandateCapsuleScopeSchema = z.strictObject({ userId: IdSchema, externalOrganizationId: IdSchema, sessionId: z.string().min(1).max(256), apiBase: z.string().url().max(2048), organizationId: IdSchema, environment: EnvironmentSchema, actorId: IdSchema, organizationEpoch: z.number().int().nonnegative().max(2_147_483_647), principalKind: z.enum(['human', 'service']), roles: z.array(z.string().min(1)).max(20), siteIds: z.array(IdSchema).max(10000), actionSiteIds: z.array(IdSchema).max(10000), responsibilityId: IdSchema });
export const MandateCapsuleSchema = z.strictObject({ version: z.literal(1), key: IdempotencyKeySchema, scope: MandateCapsuleScopeSchema, intent: MandateDecisionIntentSchema, originalReview: MandateReviewSchema, commandHash: HashSchema, intentHash: HashSchema, integrityHash: HashSchema });
export type MandateCapsule = z.infer<typeof MandateCapsuleSchema>;
export type MandateAuth = { userId?: string | null; orgId?: string | null; sessionId?: string | null };
export function immutableMandate<T>(value: T): T { if (value && typeof value === 'object') { for (const item of Object.values(value)) immutableMandate(item); Object.freeze(value); } return value; }
export function mandateCapsuleMatchesSession(value: MandateCapsule, session: Session, auth: MandateAuth, apiBase: string | null) { try { return sameMandateValue(value.scope, createMandateReadScope(session, auth, apiBase, value.scope.responsibilityId)); } catch { return false; } }
export async function createMandateCapsule(scope: MandateReadScope, intent: MandateDecisionIntent, review: MandateReview, key: string): Promise<MandateCapsule> {
  const body = { version: 1 as const, key: IdempotencyKeySchema.parse(key), scope: MandateCapsuleScopeSchema.parse(scope), intent: MandateDecisionIntentSchema.parse(intent), originalReview: await qualifyMandateReview(review, scope, intent.proposal.id, intent.proposal.version), ...await decisionDigests(scope, intent) };
  return verifyMandateCapsule({ ...body, integrityHash: await commandDigest(body) }, scope);
}
export async function verifyMandateCapsule(input: MandateCapsule, scope: MandateReadScope) {
  const value = MandateCapsuleSchema.parse(input), { integrityHash, ...body } = value;
  if (!sameMandateValue(input, value) || !sameMandateValue(value.scope, scope) || await commandDigest(body) !== integrityHash) mandateActionError('The original decision input or its authenticated scope changed. No replacement input will be used.');
  const hashes = await decisionDigests(scope, value.intent), e = value.originalReview.envelope, p = e.proposal;
  await qualifyMandateReview(value.originalReview, scope, value.intent.proposal.id, value.intent.proposal.version);
  if (!p || !decisionAvailable(value.originalReview, scope, value.intent.action, Date.parse(e.observedAt)) || !sameMandateValue({ id: p.id, version: p.version, hash: p.hash }, value.intent.proposal) || e.decision?.state !== 'OPEN' || e.decision.version !== value.intent.expectedDecisionVersion || p.organizationEpoch !== value.intent.expectedOrganizationEpoch ||
      !sameMandateValue(p.expectedHead, value.intent.expectedHead) || hashes.commandHash !== value.commandHash || hashes.intentHash !== value.intentHash) mandateActionError();
  return immutableMandate(value);
}
