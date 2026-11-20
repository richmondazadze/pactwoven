import { z } from 'zod';
import {
  EnvironmentSchema, IdSchema, InstantSchema, HashSchema, SupplierAdmissionReferenceSchema,
  SupplierAdmissionMemberPinSchema, SupplierAdmissionContextRequestSchema, SupplierEnrollmentReviewRequestSchema,
  SupplierEnrollmentMutationSchema, SupplierEnrollmentRecoveryRequestSchema, supplierEnrollmentPublicRequestDigest,
  parseSupplierAdmissionContext, parseSupplierEnrollmentReview, parseSupplierEnrollmentRecovery, parseSupplierEnrollmentCommandResponse,
} from '@pactwoven/contracts';
import { canonicalJson, commandDigest, immutable } from '@pactwoven/domain';
import { SupplierPrivatePrincipalBindingSchema, SupplierExternalObservationSchema, SupplierMembershipObservationSchema } from './supplier-relationship-persistence-schema.js';

const version = z.number().int().min(1).max(2_147_483_647);
const epoch = z.number().int().min(0).max(2_147_483_647);
const externalId = z.string().min(1).max(256);
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const ms = (value: string) => Date.parse(value);
const issue = (c: z.RefinementCtx, message: string) => c.addIssue({ code: 'custom', message });

/** Offline configured finite pair. Runtime evidence cannot self-admit a buyer as supplier. */
export const SupplierAdmissionLaneSchema = z.strictObject({
  schemaVersion: z.literal(1), reference: SupplierAdmissionReferenceSchema, environment: EnvironmentSchema,
  buyerOrganizationId: IdSchema, supplierOrganizationId: IdSchema,
  buyerBinding: SupplierAdmissionReferenceSchema, supplierBinding: SupplierAdmissionReferenceSchema,
  status: z.enum(['ACTIVE', 'REVOKED']), validFrom: InstantSchema, expiresAt: InstantSchema,
}).refine(value => value.buyerOrganizationId !== value.supplierOrganizationId && value.buyerBinding.id !== value.supplierBinding.id &&
  ms(value.validFrom) < ms(value.expiresAt), 'Distinct configured parties/bindings and finite lane validity are required.');
export const SupplierAdmissionConfigurationSchema = z.strictObject({
  issuer: z.url().max(2048), binding: SupplierPrivatePrincipalBindingSchema, lane: SupplierAdmissionLaneSchema,
}).refine(value => value.binding.environment === value.lane.environment &&
  value.binding.effectiveOrganizationId === value.lane.supplierOrganizationId && same(value.binding.reference, value.lane.supplierBinding),
  'Enrollment configuration must bind the selected supplier side of an admitted pair.');
export const SupplierAdmissionActorSchema = SupplierAdmissionMemberPinSchema.extend({
  environment: EnvironmentSchema, organizationId: IdSchema, organizationVersion: version, organizationEpoch: epoch,
  principalKind: z.literal('human'), subject: externalId, externalOrganizationId: externalId, externalMembershipId: externalId, sessionId: externalId,
});
export const SupplierAdmissionPrivateRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('context'), purpose: z.literal('supplier_admission_context'), query: SupplierAdmissionContextRequestSchema }),
  z.strictObject({ kind: z.literal('enrollment-review'), purpose: z.literal('supplier_administrator_review'), query: SupplierEnrollmentReviewRequestSchema }),
  z.strictObject({ kind: z.literal('enrollment-command'), purpose: z.enum(['supplier_administrator_grant', 'supplier_administrator_renew', 'supplier_administrator_revoke']), mutation: SupplierEnrollmentMutationSchema }),
  z.strictObject({ kind: z.literal('enrollment-recover'), purpose: z.literal('supplier_administrator_recover'), query: SupplierEnrollmentRecoveryRequestSchema }),
]).superRefine((value, c) => {
  if (value.kind === 'enrollment-command' && value.purpose !== 'supplier_administrator_' + value.mutation.command.selection.action)
    issue(c, 'Exact private enrollment purpose must match the public action.');
});
/** Genuine provider re-fetch output is supplied only by the fixed verifier.
 * The opaque reference binds stable candidate identity, not an observation clock. */
export const SupplierAdmissionCandidateObservationSchema = z.strictObject({
  reference: SupplierAdmissionReferenceSchema, principalKind: z.literal('human'), displayName: z.string().min(1).max(180),
  observation: SupplierMembershipObservationSchema,
});
const source = z.strictObject({
  kind: z.literal('CLERK_FVA'), tokenHash: HashSchema, tokenIssuedAt: InstantSchema,
  firstFactorAgeMinutes: z.number().int().min(0).max(1_000_000), secondFactorAgeMinutes: z.number().int().min(0).max(1_000_000),
  firstFactorAt: InstantSchema, secondFactorAt: InstantSchema, verifiedAt: InstantSchema,
}).refine(value => ms(value.firstFactorAt) === ms(value.tokenIssuedAt) - (value.firstFactorAgeMinutes + 1) * 60_000 &&
  ms(value.secondFactorAt) === ms(value.tokenIssuedAt) - (value.secondFactorAgeMinutes + 1) * 60_000 &&
  ms(value.verifiedAt) === Math.min(ms(value.firstFactorAt), ms(value.secondFactorAt)), 'Conservative original Clerk FVA bounds required.');
const evidenceBase = {
  schemaVersion: z.literal(1), id: z.uuid(), actor: SupplierAdmissionActorSchema, binding: SupplierPrivatePrincipalBindingSchema,
  lane: SupplierAdmissionLaneSchema, request: SupplierAdmissionPrivateRequestSchema, requestDigest: HashSchema, mutationDigest: HashSchema.nullable(),
  observation: SupplierExternalObservationSchema, target: SupplierAdmissionCandidateObservationSchema.nullable(),
  observedAt: InstantSchema, expiresAt: InstantSchema,
};
export const SupplierAdmissionEvidenceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...evidenceBase, kind: z.literal('identity') }),
  z.strictObject({ ...evidenceBase, kind: z.literal('factors'), source }),
]).superRefine((value, c) => {
  const a = value.actor, o = value.observation, b = value.binding, lane = value.lane;
  const command = value.request.kind === 'enrollment-command';
  if ((value.kind === 'factors') !== command || (value.mutationDigest !== null) !== command) issue(c, 'Only commands use purpose-bound factor evidence.');
  if (a.environment !== b.environment || a.environment !== lane.environment || a.organizationId !== b.effectiveOrganizationId ||
    a.organizationId !== lane.supplierOrganizationId || !same(b.reference, lane.supplierBinding)) issue(c, 'Evidence must bind the exact configured supplier lane.');
  if (a.subject !== o.subject || a.externalOrganizationId !== o.externalOrganizationId || a.externalMembershipId !== o.externalMembershipId || a.sessionId !== o.sessionId)
    issue(c, 'Pinned local actor and genuine original observation must agree.');
  if (value.observedAt !== o.observedAt || value.expiresAt !== o.expiresAt || ms(value.expiresAt) - ms(value.observedAt) > 20_000 ||
    ms(value.observedAt) < Math.max(ms(b.validFrom), ms(lane.validFrom)) || ms(value.expiresAt) > Math.min(ms(b.expiresAt), ms(lane.expiresAt)))
    issue(c, 'Original finite observation must stay within both configured lifetimes.');
  const needsTarget = value.request.kind === 'enrollment-review' || command;
  if (needsTarget !== (value.target !== null)) issue(c, 'Only exact enrollment review/command observes a target.');
  if (value.target !== null) {
    const target = value.target.observation;
    if (target.status !== 'ACTIVE' || target.issuer !== o.issuer || target.externalOrganizationId !== o.externalOrganizationId ||
      ms(target.observedAt) > ms(value.observedAt) || ms(target.expiresAt) < ms(value.expiresAt) ||
      target.externalMembershipId === o.externalMembershipId && target.subject !== o.subject ||
      target.subject === o.subject && target.externalMembershipId !== o.externalMembershipId)
      issue(c, 'Target must retain a fresh, consistent own-organization provider identity.');
    const selected = value.request.kind === 'enrollment-review' ? value.request.query.selection :
      value.request.kind === 'enrollment-command' ? value.request.mutation.command.selection : null;
    if (selected?.action === 'grant' && !same(selected.candidate, value.target.reference)) issue(c, 'Exact candidate reference required.');
    if (value.request.kind === 'enrollment-command' && !same(value.request.mutation.command.basis.target.candidate, value.target.reference))
      issue(c, 'Command must retain its reviewed candidate.');
  }
  if (value.kind === 'factors' && (value.source.tokenHash !== o.tokenHash || value.source.tokenIssuedAt !== o.tokenIssuedAt))
    issue(c, 'Factors must come from the same original observed token.');
  if (value.request.kind === 'enrollment-command') {
    const basis = value.request.mutation.command.basis;
    if (basis.environment !== a.environment || basis.organization.id !== a.organizationId || basis.issuer.actorId !== a.actorId)
      issue(c, 'Public reviewed scope must retain its original issuer.');
  }
  if (value.request.kind === 'enrollment-recover') {
    const identity = value.request.query.identity;
    if (identity.environment !== a.environment || identity.organizationId !== a.organizationId || identity.actorId !== a.actorId)
      issue(c, 'Recovery belongs only to its current original issuer.');
  }
});
export type SupplierAdmissionConfiguration = z.infer<typeof SupplierAdmissionConfigurationSchema>;
export type SupplierAdmissionPrivateRequest = z.infer<typeof SupplierAdmissionPrivateRequestSchema>;
export type SupplierAdmissionEvidence = z.infer<typeof SupplierAdmissionEvidenceSchema>;
export type SupplierAdmissionActor = z.infer<typeof SupplierAdmissionActorSchema>;

export async function supplierAdmissionLaneDigest(input: unknown) {
  const lane = SupplierAdmissionLaneSchema.parse(input);
  return commandDigest({ namespace: 'pactwoven/supplier-admission-lane/v1', lane: { ...lane, reference: { id: lane.reference.id, version: lane.reference.version } } });
}
export async function supplierAdmissionCandidateDigest(input: unknown, environmentInput: unknown, organizationInput: unknown) {
  const candidate = SupplierAdmissionCandidateObservationSchema.parse(input), environment = EnvironmentSchema.parse(environmentInput), organizationId = IdSchema.parse(organizationInput);
  const o = candidate.observation;
  return commandDigest({ namespace: 'pactwoven/supplier-admission-candidate/v1', candidate: {
    reference: { id: candidate.reference.id, version: candidate.reference.version }, environment, organizationId,
    issuer: o.issuer, subject: o.subject, externalOrganizationId: o.externalOrganizationId, externalMembershipId: o.externalMembershipId,
  } });
}
export async function supplierAdmissionRequestDigest(requestInput: unknown, actorInput: unknown) {
  const request = SupplierAdmissionPrivateRequestSchema.parse(requestInput), actor = SupplierAdmissionActorSchema.parse(actorInput);
  return commandDigest({ namespace: 'pactwoven/supplier-admission-private-request/v1', request,
    identity: { environment: actor.environment, organizationId: actor.organizationId, actorId: actor.actorId } });
}
/** Structural/private comparison only, not a provider verifier or a committed result. */
export async function snapshotSupplierAdmissionEvidence(input: unknown, requestInput: unknown, actorInput: unknown, configInput: unknown, now: string) {
  const evidence = immutable(SupplierAdmissionEvidenceSchema.parse(input));
  const request = immutable(SupplierAdmissionPrivateRequestSchema.parse(requestInput)), actor = immutable(SupplierAdmissionActorSchema.parse(actorInput));
  const config = immutable(SupplierAdmissionConfigurationSchema.parse(configInput)), at = ms(InstantSchema.parse(now));
  if (!same(evidence.request, request) || !same(evidence.actor, actor) || !same(evidence.binding, config.binding) || !same(evidence.lane, config.lane) ||
    evidence.observation.issuer !== config.issuer || evidence.binding.status !== 'ACTIVE' || evidence.lane.status !== 'ACTIVE')
    throw new TypeError('Supplier admission evidence does not match its private expected input.');
  if (ms(evidence.observedAt) > at || at - ms(evidence.observedAt) >= 20_000 || at >= ms(evidence.expiresAt) ||
    at - ms(evidence.observation.membershipObservedAt) >= 20_000 ||
    evidence.target !== null && at - ms(evidence.target.observation.observedAt) >= 20_000 ||
    evidence.kind === 'factors' && [evidence.source.firstFactorAt, evidence.source.secondFactorAt].some(value => ms(value) > at || at - ms(value) >= 300_000))
    throw new TypeError('Original supplier admission observations expired.');
  if (config.lane.reference.hash !== await supplierAdmissionLaneDigest(config.lane) ||
    evidence.target !== null && evidence.target.reference.hash !== await supplierAdmissionCandidateDigest(evidence.target, actor.environment, actor.organizationId) ||
    evidence.requestDigest !== await supplierAdmissionRequestDigest(request, actor) ||
    evidence.mutationDigest !== (request.kind === 'enrollment-command' ? await supplierEnrollmentPublicRequestDigest(request.mutation) : null))
    throw new TypeError('Supplier admission evidence bytes do not match their exact hashes.');
  return immutable({ evidence, digest: await commandDigest({ namespace: 'pactwoven/supplier-admission-evidence/v1', evidence }),
    authentication: 'NOT_ESTABLISHED' as const, providerVerification: 'NOT_ESTABLISHED' as const, persistence: 'NOT_ESTABLISHED' as const });
}
export async function snapshotSupplierAdmissionResult(input: unknown, requestInput: unknown, actorInput: unknown) {
  const request = immutable(SupplierAdmissionPrivateRequestSchema.parse(requestInput)), actor = immutable(SupplierAdmissionActorSchema.parse(actorInput));
  const value = request.kind === 'context' ? await parseSupplierAdmissionContext(input) : request.kind === 'enrollment-review' ?
    await parseSupplierEnrollmentReview(input, request.query) : request.kind === 'enrollment-recover' ?
      await parseSupplierEnrollmentRecovery(input, request.query) : await parseSupplierEnrollmentCommandResponse(input, request.mutation);
  if (value.kind === 'SUPPLIER_ADMISSION_CONTEXT' && (value.environment !== actor.environment || value.organization.id !== actor.organizationId ||
    value.viewer.actorId !== actor.actorId || value.viewer.membershipId !== actor.membershipId)) throw new TypeError('Supplier admission context scope mismatch.');
  if (value.kind === 'SUPPLIER_ENROLLMENT_REVIEW' && (value.material.basis.environment !== actor.environment ||
    value.material.basis.organization.id !== actor.organizationId || value.material.basis.issuer.actorId !== actor.actorId ||
    value.material.basis.issuer.membershipId !== actor.membershipId)) throw new TypeError('Supplier enrollment review scope mismatch.');
  return immutable(value);
}
