import { z } from 'zod';
import { EnvironmentSchema, IdSchema, IdempotencyKeySchema, InstantSchema } from './core';
import { HashSchema } from './financial';
import { canonicalJson, commandDigest } from './canonical';

export const SUPPLIER_ADMINISTRATOR_MAX_VALIDITY_MS = 2_592_000_000;
export const SUPPLIER_ADMISSION_MAX_OBSERVATION_MS = 20_000;
export const SUPPLIER_ADMISSION_READ_MAX_BYTES = 8 * 1024;
export const SUPPLIER_ENROLLMENT_COMMAND_MAX_BYTES = 16 * 1024;
export const SUPPLIER_ADMISSION_RESPONSE_MAX_BYTES = 64 * 1024;

const version = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const identityVersion = z.number().int().min(1).max(2_147_483_647);
const epoch = z.number().int().min(0).max(2_147_483_647);
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const issue = (c: z.RefinementCtx, message: string) => c.addIssue({ code: 'custom', message });
const bounded = <T extends z.ZodType>(schema: T, maximum: number) => z.custom<unknown>(value => {
  try { const encoded = JSON.stringify(value); return encoded !== undefined && new TextEncoder().encode(encoded).byteLength <= maximum; }
  catch { return false; }
}, 'Encoded supplier admission material exceeds its byte limit.').pipe(schema);

/** Public pins and observations are comparison material, never credentials or capabilities. */
export const SupplierAdmissionReferenceSchema = z.strictObject({ id: IdSchema, version, hash: HashSchema });
export const SupplierAdmissionOrganizationPinSchema = z.strictObject({ id: IdSchema, version: identityVersion, authorityEpoch: epoch });
export const SupplierAdmissionMemberPinSchema = z.strictObject({ actorId: IdSchema, membershipId: IdSchema, membershipVersion: identityVersion });
export const SupplierAdmissionObservationSchema = z.strictObject({ observedAt: InstantSchema, expiresAt: InstantSchema })
  .refine(value => Date.parse(value.expiresAt) > Date.parse(value.observedAt) &&
    Date.parse(value.expiresAt) - Date.parse(value.observedAt) <= SUPPLIER_ADMISSION_MAX_OBSERVATION_MS,
  'Observation must retain its original positive interval of at most twenty seconds.');
export const SupplierAdmissionLimitationsSchema = z.strictObject({
  authentication: z.literal('NOT_ESTABLISHED'), businessVerification: z.literal('NOT_ESTABLISHED'),
  payeeVerification: z.literal('NOT_ESTABLISHED'), bookingAuthority: z.literal(false),
  contractualAcceptance: z.literal(false), paymentAuthority: z.literal(false),
});
export const supplierAdmissionLimitations = Object.freeze({
  authentication: 'NOT_ESTABLISHED', businessVerification: 'NOT_ESTABLISHED', payeeVerification: 'NOT_ESTABLISHED',
  bookingAuthority: false, contractualAcceptance: false, paymentAuthority: false,
} as const);
export const SupplierEnrollmentActionSchema = z.enum(['grant', 'renew', 'revoke']);
export const SupplierAdmissionBlockerSchema = z.enum([
  'OWNER_REQUIRED', 'SUPPLIER_PARTY_REQUIRED', 'HUMAN_REQUIRED', 'MEMBERSHIP_CHANGED', 'ORGANIZATION_CHANGED',
  'CANDIDATE_CHANGED', 'GRANT_CHANGED', 'ROLE_GRANT_EXPIRED', 'REVIEW_EXPIRED', 'EXPIRY_INVALID',
  'VERSION_EXHAUSTED', 'SERVICE_UNAVAILABLE', 'ELIGIBILITY_NOT_EVALUATED',
]);
const blockers = z.array(SupplierAdmissionBlockerSchema).max(14)
  .refine(values => values.every((value, index) => index === 0 || values[index - 1]! < value), 'Sorted unique blockers required.');

/** Full local grant history. Issuer/provider/session/factor provenance remains private. */
export const SupplierAdministratorGrantRecordSchema = z.strictObject({
  schemaVersion: z.literal(1), id: IdSchema, environment: EnvironmentSchema, organizationId: IdSchema,
  role: z.literal('supplier_admin'), version, predecessor: SupplierAdmissionReferenceSchema.nullable(),
  action: SupplierEnrollmentActionSchema, status: z.enum(['ACTIVE', 'REVOKED']),
  target: SupplierAdmissionMemberPinSchema, issuer: SupplierAdmissionMemberPinSchema,
  organizationVersion: identityVersion, authorityEpoch: epoch,
  issuedAt: InstantSchema, validFrom: InstantSchema, expiresAt: InstantSchema,
}).superRefine((value, c) => {
  if (value.version === 1 ? value.predecessor !== null || value.action !== 'grant' :
    value.predecessor === null || value.predecessor.id !== value.id || value.predecessor.version !== value.version - 1 || value.action === 'grant')
    issue(c, 'Grant history must name its immediate immutable predecessor.');
  if ((value.action === 'revoke') !== (value.status === 'REVOKED')) issue(c, 'Action and historical grant status disagree.');
  const duration = Date.parse(value.expiresAt) - Date.parse(value.validFrom);
  if (value.validFrom !== value.issuedAt || (value.status === 'ACTIVE' ? duration <= 0 || duration > SUPPLIER_ADMINISTRATOR_MAX_VALIDITY_MS : duration !== 0))
    issue(c, 'Grant must retain its original finite effect interval.');
});
export const SupplierAdministratorGrantSnapshotSchema = z.strictObject({
  record: SupplierAdministratorGrantRecordSchema, reference: SupplierAdmissionReferenceSchema,
}).refine(value => value.record.id === value.reference.id && value.record.version === value.reference.version,
  'Grant reference must identify its exact immutable record.');

const administration = z.strictObject({
  owner: z.boolean(), supplierAdministrator: z.boolean(), grant: SupplierAdministratorGrantSnapshotSchema.nullable(),
});
export const SupplierAdmissionContextRequestSchema = z.strictObject({});
export const SupplierAdmissionContextSchema = bounded(z.strictObject({
  schemaVersion: z.literal(1), kind: z.literal('SUPPLIER_ADMISSION_CONTEXT'), environment: EnvironmentSchema,
  party: z.enum(['buyer', 'supplier']), organization: SupplierAdmissionOrganizationPinSchema.extend({
    name: z.string().min(1).max(180), status: z.enum(['ACTIVE', 'SUSPENDED', 'REVOKED']),
  }), viewer: SupplierAdmissionMemberPinSchema, administration,
  enrollment: z.strictObject({ state: z.enum(['REVIEWABLE', 'BLOCKED', 'NOT_EVALUATED']), blockers }),
  observation: SupplierAdmissionObservationSchema, limitations: SupplierAdmissionLimitationsSchema,
}).superRefine((value, c) => {
  const a = value.administration, grant = a.grant;
  if (grant !== null && (grant.record.environment !== value.environment || grant.record.organizationId !== value.organization.id ||
    grant.record.target.actorId !== value.viewer.actorId || grant.record.target.membershipId !== value.viewer.membershipId ||
    grant.record.organizationVersion > value.organization.version || grant.record.authorityEpoch > value.organization.authorityEpoch))
    issue(c, 'Context can expose only the selected viewer grant.');
  if (a.supplierAdministrator && (value.party !== 'supplier' || value.organization.status !== 'ACTIVE' || grant === null ||
    grant.record.status !== 'ACTIVE' || !same(grant.record.target, value.viewer) ||
    Date.parse(grant.record.validFrom) > Date.parse(value.observation.observedAt) || Date.parse(grant.record.expiresAt) <= Date.parse(value.observation.observedAt) ||
    Date.parse(value.observation.expiresAt) > Date.parse(grant.record.expiresAt)))
    issue(c, 'Current administration requires a matching unexpired grant.');
  if (value.enrollment.state === 'REVIEWABLE' ? value.enrollment.blockers.length !== 0 || !a.owner || value.party !== 'supplier' || value.organization.status !== 'ACTIVE' :
    value.enrollment.state === 'NOT_EVALUATED' ? !same(value.enrollment.blockers, ['ELIGIBILITY_NOT_EVALUATED']) :
    value.enrollment.blockers.length === 0 || value.enrollment.blockers.includes('ELIGIBILITY_NOT_EVALUATED'))
    issue(c, 'Enrollment guidance must agree with its selected owner context.');
}), SUPPLIER_ADMISSION_RESPONSE_MAX_BYTES);

/** Opaque candidate references come from bounded own-organization discovery; no provider IDs are accepted. */
export const SupplierEnrollmentSelectionSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('grant'), candidate: SupplierAdmissionReferenceSchema, expiresAt: InstantSchema }),
  z.strictObject({ action: z.literal('renew'), grant: SupplierAdmissionReferenceSchema, expiresAt: InstantSchema }),
  z.strictObject({ action: z.literal('revoke'), grant: SupplierAdmissionReferenceSchema }),
]);
export const SupplierEnrollmentReviewRequestSchema = bounded(z.strictObject({
  schemaVersion: z.literal(1), selection: SupplierEnrollmentSelectionSchema,
}), SUPPLIER_ADMISSION_READ_MAX_BYTES);
export const SupplierEnrollmentBasisSchema = z.strictObject({
  environment: EnvironmentSchema, organization: SupplierAdmissionOrganizationPinSchema, issuer: SupplierAdmissionMemberPinSchema,
  target: z.strictObject({ candidate: SupplierAdmissionReferenceSchema, member: SupplierAdmissionMemberPinSchema.nullable() }),
  previousGrant: SupplierAdmissionReferenceSchema.nullable(), observation: SupplierAdmissionObservationSchema,
});
function checkSelection(value: { selection: SupplierEnrollmentSelection; basis: SupplierEnrollmentBasis }, c: z.RefinementCtx) {
  const { selection: s, basis: b } = value;
  if (s.action === 'grant' ? b.previousGrant !== null || !same(s.candidate, b.target.candidate) :
    b.previousGrant === null || b.target.member === null || !same(s.grant, b.previousGrant))
    issue(c, 'Enrollment must retain the exact candidate or existing grant selection.');
  if (s.action !== 'revoke' && (Date.parse(s.expiresAt) <= Date.parse(b.observation.observedAt) ||
    Date.parse(s.expiresAt) - Date.parse(b.observation.observedAt) > SUPPLIER_ADMINISTRATOR_MAX_VALIDITY_MS))
    issue(c, 'Explicit expiry must be within thirty days of the original review observation.');
}
const reviewedMaterial = z.strictObject({
  schemaVersion: z.literal(1), role: z.literal('supplier_admin'), selection: SupplierEnrollmentSelectionSchema,
  basis: SupplierEnrollmentBasisSchema, targetDisplayName: z.string().min(1).max(180),
  previousGrant: SupplierAdministratorGrantSnapshotSchema.nullable(),
}).superRefine((value, c) => {
  checkSelection(value, c);
  const previous = value.previousGrant;
  if (previous === null ? value.basis.previousGrant !== null : !same(previous.reference, value.basis.previousGrant) ||
    previous.record.environment !== value.basis.environment || previous.record.organizationId !== value.basis.organization.id ||
    previous.record.target.actorId !== value.basis.target.member?.actorId || previous.record.target.membershipId !== value.basis.target.member.membershipId)
    issue(c, 'Review must disclose the selected target and exact previous grant history.');
});
export const SupplierEnrollmentReviewedMaterialSchema = reviewedMaterial;
export const SupplierEnrollmentReviewResponseSchema = bounded(z.strictObject({
  kind: z.literal('SUPPLIER_ENROLLMENT_REVIEW'), material: reviewedMaterial, reviewHash: HashSchema,
  state: z.enum(['REVIEWABLE', 'BLOCKED']), blockers, limitations: SupplierAdmissionLimitationsSchema,
}).refine(value => value.state === 'REVIEWABLE' ? value.blockers.length === 0 : value.blockers.length > 0,
  'Review state and blockers must agree.'), SUPPLIER_ADMISSION_RESPONSE_MAX_BYTES);

/** The route attaches one original key from its header; the body cannot carry a second key. */
export const SupplierEnrollmentCommandSchema = bounded(z.strictObject({
  schemaVersion: z.literal(1), role: z.literal('supplier_admin'), selection: SupplierEnrollmentSelectionSchema,
  basis: SupplierEnrollmentBasisSchema, reviewHash: HashSchema,
}).superRefine(checkSelection), SUPPLIER_ENROLLMENT_COMMAND_MAX_BYTES);
export const SupplierEnrollmentMutationSchema = z.strictObject({ idempotencyKey: IdempotencyKeySchema, command: SupplierEnrollmentCommandSchema });
export const SupplierEnrollmentOriginalIdentitySchema = z.strictObject({
  environment: EnvironmentSchema, organizationId: IdSchema, actorId: IdSchema, idempotencyKey: IdempotencyKeySchema,
});
/** Target/action/hash are compared AFTER the broad original actor/key lookup. Absence never closes an original key. */
export const SupplierEnrollmentRecoveryRequestSchema = bounded(z.strictObject({
  identity: SupplierEnrollmentOriginalIdentitySchema, action: SupplierEnrollmentActionSchema,
  target: SupplierEnrollmentBasisSchema.shape.target, previousGrant: SupplierAdmissionReferenceSchema.nullable(), publicRequestHash: HashSchema,
}).refine(value => value.action === 'grant' ? value.previousGrant === null : value.previousGrant !== null && value.target.member !== null,
  'Recovery must retain the original target and predecessor.'), SUPPLIER_ADMISSION_READ_MAX_BYTES);
export const SupplierEnrollmentReceiptSchema = z.strictObject({
  identity: SupplierEnrollmentOriginalIdentitySchema, action: SupplierEnrollmentActionSchema,
  publicRequestHash: HashSchema, result: SupplierAdministratorGrantSnapshotSchema, recordedAt: InstantSchema,
}).refine(value => value.result.record.environment === value.identity.environment && value.result.record.organizationId === value.identity.organizationId &&
  value.result.record.issuer.actorId === value.identity.actorId && value.result.record.action === value.action && value.result.record.issuedAt === value.recordedAt,
  'Original receipt must retain exact issuer, action, scope and effect time.');
const currentGrant = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('AVAILABLE'), grant: SupplierAdministratorGrantSnapshotSchema.nullable() }),
  z.strictObject({ status: z.literal('UNAVAILABLE'), grant: z.null() }),
]);
const original = z.strictObject({ exactPublicMutation: SupplierEnrollmentMutationSchema, receipt: SupplierEnrollmentReceiptSchema });
const recoveryBase = {
  request: SupplierEnrollmentRecoveryRequestSchema, observation: SupplierAdmissionObservationSchema,
  current: currentGrant, limitations: SupplierAdmissionLimitationsSchema,
};
const recovery = z.discriminatedUnion('status', [
  z.strictObject({ kind: z.literal('SUPPLIER_ENROLLMENT_RECOVERY'), ...recoveryBase, status: z.literal('RECORDED'), original }),
  z.strictObject({ kind: z.literal('SUPPLIER_ENROLLMENT_RECOVERY'), ...recoveryBase, status: z.literal('NOT_RECORDED'), original: z.null() }),
]);
function checkOriginal(value: z.infer<typeof recovery> | z.infer<typeof commandResponse>, c: z.RefinementCtx) {
  const recovered = value.original, request = value.request, current = value.current.grant;
  if (recovered !== null) {
    const { exactPublicMutation: mutation, receipt } = recovered, { basis, selection } = mutation.command;
    const result = receipt.result.record;
    const versionDelta = current === null ? 0 : current.record.version - result.version;
    if (!same(receipt.identity, request.identity) || receipt.action !== request.action || receipt.publicRequestHash !== request.publicRequestHash ||
      mutation.idempotencyKey !== request.identity.idempotencyKey || basis.environment !== request.identity.environment ||
      basis.organization.id !== request.identity.organizationId || basis.issuer.actorId !== request.identity.actorId ||
      selection.action !== request.action || !same(basis.target, request.target) || !same(basis.previousGrant, request.previousGrant))
      issue(c, 'Recovered material must match the entire original locator.');
    if (result.version !== (basis.previousGrant?.version ?? 0) + 1 || !same(result.predecessor, basis.previousGrant) ||
      !same(result.issuer, basis.issuer) || result.organizationVersion !== basis.organization.version + 1 || result.authorityEpoch !== basis.organization.authorityEpoch + 1 ||
      result.target.membershipVersion !== (basis.target.member?.membershipVersion ?? 0) + 1 ||
      basis.target.member !== null && (result.target.membershipId !== basis.target.member.membershipId || result.target.actorId !== basis.target.member.actorId) ||
      Date.parse(receipt.recordedAt) < Date.parse(basis.observation.observedAt) || Date.parse(receipt.recordedAt) >= Date.parse(basis.observation.expiresAt) ||
      selection.action !== 'revoke' && result.expiresAt !== selection.expiresAt ||
      Date.parse(receipt.recordedAt) > Date.parse(value.observation.observedAt))
      issue(c, 'Receipt must retain the exact reviewed effect, ordered fences and original time.');
    if (current !== null && (current.record.id !== result.id || current.record.version < result.version ||
      current.record.target.actorId !== result.target.actorId || current.record.target.membershipId !== result.target.membershipId ||
      current.record.version === result.version && !same(current, receipt.result) ||
      versionDelta > 0 && (current.record.target.membershipVersion - result.target.membershipVersion < versionDelta ||
        current.record.organizationVersion - result.organizationVersion < versionDelta || current.record.authorityEpoch - result.authorityEpoch < versionDelta ||
        Date.parse(current.record.issuedAt) < Date.parse(result.issuedAt)) ||
      current.record.version === result.version + 1 && !same(current.record.predecessor, receipt.result.reference)))
      issue(c, 'Current grant cannot contradict the recovered immutable history.');
    if (value.kind === 'SUPPLIER_ENROLLMENT_COMMAND' && value.outcome === 'APPENDED' &&
      (current === null || !same(current, receipt.result))) issue(c, 'An appended result must be the co-observed grant.');
  }
  if (recovered === null && request.target.member === null && current !== null)
    issue(c, 'An absent original member cannot identify an unrelated current grant.');
  if (current !== null && (current.record.environment !== request.identity.environment || current.record.organizationId !== request.identity.organizationId ||
    request.target.member !== null && (current.record.target.actorId !== request.target.member.actorId || current.record.target.membershipId !== request.target.member.membershipId) ||
    Date.parse(current.record.issuedAt) > Date.parse(value.observation.observedAt))) issue(c, 'Current state must retain this target and observation scope.');
}
export const SupplierEnrollmentRecoveryResponseSchema = bounded(recovery.superRefine(checkOriginal), SUPPLIER_ADMISSION_RESPONSE_MAX_BYTES);
const commandResponse = z.strictObject({ kind: z.literal('SUPPLIER_ENROLLMENT_COMMAND'), ...recoveryBase,
  outcome: z.enum(['APPENDED', 'EXACT_REPLAY']), original });
export const SupplierEnrollmentCommandResponseSchema = bounded(commandResponse.superRefine(checkOriginal), SUPPLIER_ADMISSION_RESPONSE_MAX_BYTES);

export const SupplierAdmissionErrorSchema = z.strictObject({
  kind: z.literal('SUPPLIER_ADMISSION_ERROR'), code: z.enum([
    'SUPPLIER_ADMISSION_DENIED', 'SUPPLIER_ADMISSION_UNAVAILABLE', 'SUPPLIER_ADMISSION_INVALID',
    'SUPPLIER_ADMISSION_STALE', 'SUPPLIER_ORIGINAL_KEY_CONFLICT', 'SUPPLIER_OUTCOME_UNKNOWN',
  ]),
});
export const supplierAdmissionHttpRoutes = Object.freeze({
  context: '/v1/supplier-admission/context', review: '/v1/supplier-admission/enrollment-review',
  command: '/v1/supplier-admission/enrollment-commands', recover: '/v1/supplier-admission/enrollment-recover',
});

export type SupplierAdmissionReference = z.infer<typeof SupplierAdmissionReferenceSchema>;
export type SupplierAdmissionMemberPin = z.infer<typeof SupplierAdmissionMemberPinSchema>;
export type SupplierEnrollmentSelection = z.infer<typeof SupplierEnrollmentSelectionSchema>;
export type SupplierEnrollmentBasis = z.infer<typeof SupplierEnrollmentBasisSchema>;
export type SupplierEnrollmentCommand = z.infer<typeof SupplierEnrollmentCommandSchema>;
export type SupplierEnrollmentMutation = z.infer<typeof SupplierEnrollmentMutationSchema>;
export type SupplierAdministratorGrantSnapshot = z.infer<typeof SupplierAdministratorGrantSnapshotSchema>;
export type SupplierAdministratorGrantRecord = z.infer<typeof SupplierAdministratorGrantRecordSchema>;
export type SupplierEnrollmentRecoveryRequest = z.infer<typeof SupplierEnrollmentRecoveryRequestSchema>;

/** Domain-separated hashes identify public bytes; a matching hash never authenticates their source. */
export function supplierEnrollmentReviewDigest(input: unknown) {
  return commandDigest({ namespace: 'pactwoven/supplier-enrollment-review/v1', material: reviewedMaterial.parse(input) });
}
export function supplierEnrollmentPublicRequestDigest(input: unknown) {
  return commandDigest({ namespace: 'pactwoven/supplier-enrollment-public-request/v1', mutation: SupplierEnrollmentMutationSchema.parse(input) });
}
export function supplierAdministratorGrantDigest(input: unknown) {
  return commandDigest({ namespace: 'pactwoven/supplier-administrator-grant/v1', record: SupplierAdministratorGrantRecordSchema.parse(input) });
}
async function checkGrantHash(snapshot: SupplierAdministratorGrantSnapshot | null) {
  if (snapshot !== null && snapshot.reference.hash !== await supplierAdministratorGrantDigest(snapshot.record)) throw new TypeError('Supplier grant hash mismatch.');
}
/** Use these readers at trust boundaries; structural schemas alone do not check content hashes. */
export async function parseSupplierAdmissionContext(input: unknown) {
  const value = SupplierAdmissionContextSchema.parse(input);
  await checkGrantHash(value.administration.grant);
  return value;
}
export async function parseSupplierEnrollmentReview(input: unknown, requestInput: unknown) {
  const value = SupplierEnrollmentReviewResponseSchema.parse(input);
  const request = SupplierEnrollmentReviewRequestSchema.parse(requestInput);
  if (!same(value.material.selection, request.selection)) throw new TypeError('Supplier enrollment review selection mismatch.');
  if (value.reviewHash !== await supplierEnrollmentReviewDigest(value.material)) throw new TypeError('Supplier enrollment review hash mismatch.');
  await checkGrantHash(value.material.previousGrant);
  return value;
}
async function checkResultHashes<T extends z.infer<typeof SupplierEnrollmentRecoveryResponseSchema> | z.infer<typeof SupplierEnrollmentCommandResponseSchema>>(value: T): Promise<T> {
  if (value.original !== null) {
    if (value.original.receipt.publicRequestHash !== await supplierEnrollmentPublicRequestDigest(value.original.exactPublicMutation))
      throw new TypeError('Supplier original request hash mismatch.');
    await checkGrantHash(value.original.receipt.result);
  }
  await checkGrantHash(value.current.grant);
  return value;
}
export async function parseSupplierEnrollmentRecovery(input: unknown, requestInput: unknown) {
  const value = SupplierEnrollmentRecoveryResponseSchema.parse(input), request = SupplierEnrollmentRecoveryRequestSchema.parse(requestInput);
  if (!same(value.request, request)) throw new TypeError('Supplier enrollment recovery request mismatch.');
  return checkResultHashes(value);
}
export async function parseSupplierEnrollmentCommandResponse(input: unknown, mutationInput: unknown) {
  const value = SupplierEnrollmentCommandResponseSchema.parse(input), mutation = SupplierEnrollmentMutationSchema.parse(mutationInput);
  if (!same(value.original.exactPublicMutation, mutation)) throw new TypeError('Supplier enrollment command response mismatch.');
  return checkResultHashes(value);
}
