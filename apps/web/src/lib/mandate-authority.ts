import { z } from 'zod';
import { HashSchema, IdempotencyKeySchema, MandateAuthorityIntentSchema, MandateHeadSchema, MandateOperationResultSchema, MandatePageSchema, MandateReviewSchema, type MandateHead, type MandateOperationResult, type MandatePage, type MandateReview } from '@pactwoven/contracts';
import { canonicalJson, commandDigest } from '@pactwoven/contracts/canonical';
import { RequestError } from './api';
import { immutableMandate, MandateCapsuleScopeSchema } from './mandate-capsule';
import { MandateAuthorityLocatorSchema, locatorFromAuthorityCapsule, type MandateAuthorityLocator } from './mandate-authority-recovery';
import { mandateOperationSucceeded } from './mandate-actions';
import { MANDATE_OBSERVATION_LIFETIME_MS, qualifyMandatePage, qualifyMandateReview, type MandateObservation, type MandateReadScope } from './mandates';

export type MandateStopAction = 'PAUSE' | 'REVOKE';
export type MandateAuthorityObservation = MandateObservation<MandatePage | MandateReview>;
const version = z.number().int().positive().max(2_147_483_647), epoch = z.number().int().nonnegative().max(2_147_483_647);
const stopIntent = MandateAuthorityIntentSchema.extend({ action: z.enum(['PAUSE', 'REVOKE']) });
const observationSchema = z.strictObject({ data: z.union([MandatePageSchema, MandateReviewSchema]), receivedAt: z.number().finite(), receivedMonotonic: z.number().finite().nonnegative() });
export const MandateAuthorityCapsuleSchema = z.strictObject({ version: z.literal(1), key: IdempotencyKeySchema, scope: MandateCapsuleScopeSchema, intent: stopIntent, observation: observationSchema,
  nextHead: MandateHeadSchema.safeExtend({ mandateVersion: version, mandateEpoch: epoch, organizationEpoch: epoch }), expectedTarget: MandateAuthorityLocatorSchema.shape.expectedTarget,
  commandHash: HashSchema, intentHash: HashSchema, integrityHash: HashSchema });
export type MandateAuthorityCapsule = z.infer<typeof MandateAuthorityCapsuleSchema>;
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const view = (data: MandatePage | MandateReview) => 'envelope' in data ? data.envelope : data;
export const authorityKind = (action: MandateStopAction) => action === 'PAUSE' ? 'mandate.pause' as const : 'mandate.revoke' as const;
function invalid(message = 'The exact original authority control could not be verified. No outcome has been assumed.'): never { throw new RequestError('MANDATE_AUTHORITY_UNVERIFIED', message); }
export function authorityAvailable(data: MandatePage | MandateReview, scope: MandateReadScope, action: MandateStopAction, now: number): boolean {
  const e = view(data), head = e.head, accepted = e.acceptedVersion, eligibility = e.eligibility.find(item => item.action === action);
  return Boolean((action === 'PAUSE' || action === 'REVOKE') && head && accepted && accepted.id === head.mandateId && accepted.version === head.mandateVersion && head.mandateVersion <= 2_147_483_647 && head.mandateEpoch < 2_147_483_647 && head.organizationEpoch <= e.organizationEpoch &&
    head.organizationId === scope.organizationId && head.environment === scope.environment && head.responsibilityId === scope.responsibilityId && e.organizationEpoch === scope.organizationEpoch &&
    e.responsibility.id === scope.responsibilityId && e.responsibility.organizationId === scope.organizationId && e.responsibility.environment === scope.environment && e.responsibility.version <= 2_147_483_647 &&
    scope.principalKind === 'human' && scope.roles.some(role => role === 'owner' || role === 'finance') && scope.siteIds.includes(e.responsibility.siteId) && scope.actionSiteIds.includes(e.responsibility.siteId) &&
    (head.state === 'ACTIVE' || (action === 'REVOKE' && head.state === 'PAUSED')) && eligibility?.eligible && !eligibility.requiresStepUp &&
    Number.isFinite(now) && now >= Date.parse(e.observedAt) && now < Date.parse(e.observedAt) + MANDATE_OBSERVATION_LIFETIME_MS && now < Date.parse(head.expiresAt));
}
export async function authorityDigests(scope: MandateReadScope, intentInput: MandateAuthorityCapsule['intent']) {
  const intent = stopIntent.parse(intentInput);
  return { commandHash: await commandDigest({ schemaVersion: 1, environment: scope.environment, organizationId: scope.organizationId, actorId: scope.actorId, kind: authorityKind(intent.action), route: { responsibilityId: scope.responsibilityId, targetId: intent.mandate.id }, command: intent }), intentHash: await commandDigest({ purpose: 'mandate_control', intent }) };
}
export async function createAuthorityCapsule(scopeInput: MandateReadScope, observationInput: MandateAuthorityObservation, action: MandateStopAction, reason: string, key: string, now: number): Promise<MandateAuthorityCapsule> {
  const scope = MandateCapsuleScopeSchema.parse(scopeInput), observation = observationSchema.parse(observationInput), data = observation.data;
  if ('envelope' in data) { const p = data.envelope.proposal; if (!p) invalid(); await qualifyMandateReview(data, scope, p.id, p.version); } else await qualifyMandatePage(data, scope);
  if (!authorityAvailable(data, scope, action, now)) throw new RequestError('AUTHORITY_REVIEW_REQUIRED', 'Refresh current accepted authority and check this stop’s eligibility before reviewing it.');
  const e = view(data), head = e.head!, accepted = e.acceptedVersion!;
  const mandate = { id: accepted.id, version: accepted.version, hash: 'hash' in accepted ? accepted.hash : await commandDigest(accepted) };
  const intent = stopIntent.parse({ schemaVersion: 1, action, mandate, head: { mandateId: head.mandateId, mandateVersion: head.mandateVersion, mandateEpoch: head.mandateEpoch, hash: await commandDigest(head) }, responsibility: e.responsibilityReference, expectedOrganizationEpoch: scope.organizationEpoch, reason });
  const nextHead: MandateHead = { ...head, state: action === 'PAUSE' ? 'PAUSED' : 'REVOKED', mandateEpoch: head.mandateEpoch + 1 };
  const expectedTarget = { kind: 'authority' as const, id: head.mandateId, version: nextHead.mandateEpoch, hash: await commandDigest(nextHead) };
  const body = { version: 1 as const, key: IdempotencyKeySchema.parse(key), scope, intent, observation, nextHead, expectedTarget, ...await authorityDigests(scope, intent) };
  const capsule = MandateAuthorityCapsuleSchema.parse({ ...body, integrityHash: await commandDigest(body) }); locatorFromAuthorityCapsule(capsule); return immutableMandate(capsule);
}
export async function verifyAuthorityCapsule(input: MandateAuthorityCapsule) {
  const value = MandateAuthorityCapsuleSchema.parse(input), { integrityHash, ...body } = value;
  if (!same(input, value) || await commandDigest(body) !== integrityHash) invalid();
  const rebuilt = await createAuthorityCapsule(value.scope, value.observation, value.intent.action, value.intent.reason, value.key, Date.parse(view(value.observation.data).observedAt));
  if (!same(value, rebuilt)) invalid(); return immutableMandate(value);
}
export function qualifyAuthorityOperation(input: unknown, locatorInput: MandateAuthorityLocator): MandateOperationResult {
  const locator = MandateAuthorityLocatorSchema.parse(locatorInput), result = MandateOperationResultSchema.parse(input);
  if (result.organizationId !== locator.scope.organizationId || result.operation.environment !== locator.scope.environment || result.responsibilityId !== locator.responsibilityId || result.kind !== locator.kind || !same(result.target, locator.expectedTarget) || result.commandHash !== locator.commandHash || result.intentHash !== locator.intentHash) invalid();
  return immutableMandate(result);
}
export function qualifyAuthorityReceipt(input: unknown, locator: MandateAuthorityLocator) {
  const result = qualifyAuthorityOperation(input, locator); if (!mandateOperationSucceeded(result)) invalid('The original authority transition has no qualified successful receipt yet. Keep its request reference.');
  return immutableMandate({ locator: MandateAuthorityLocatorSchema.parse(locator), result, recordedState: locator.kind === 'mandate.pause' ? 'PAUSED' as const : locator.kind === 'mandate.revoke' ? 'REVOKED' as const : 'ACTIVE' as const });
}
export type MandateAuthorityReceipt = ReturnType<typeof qualifyAuthorityReceipt>;
