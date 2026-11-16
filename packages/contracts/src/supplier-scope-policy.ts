import { z } from 'zod';
import { EnvironmentSchema, IdSchema, IdempotencyKeySchema, InstantSchema } from './core';
import { HashSchema, VersionReferenceSchema } from './financial';
import { SupplierScopeSchema, supplierScopesMatch } from './supplier-protocol';
import { SupplierRelationshipReceiptSchema } from './supplier-relationships';

export const SUPPLIER_SCOPE_POLICY_MAX_VALIDITY_MS = 30 * 24 * 60 * 60 * 1000;
const version = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const epoch = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const ids = z.array(IdSchema).min(1).max(100).refine(values => new Set(values).size === values.length, 'Scope IDs must be unique.');
const normalizedText = (maximum: number) => z.string().max(maximum * 2)
  .transform(value => value.normalize('NFC').trim()).pipe(z.string().min(1).max(maximum));
const storedText = (maximum: number) => z.string().min(1).max(maximum)
  .refine(value => value === value.normalize('NFC').trim(), 'Stored category text must already be normalized.');

/** Shape only. This ordered pair does not authenticate either organization. */
export const SupplierScopePolicyPairSchema = z.strictObject({
  environment: EnvironmentSchema, buyerOrganizationId: IdSchema, supplierOrganizationId: IdSchema,
}).refine(value => value.buyerOrganizationId !== value.supplierOrganizationId, 'Policy parties must be distinct.');
export type SupplierScopePolicyPair = z.infer<typeof SupplierScopePolicyPairSchema>;
export function supplierScopePolicyPairsMatch(a: SupplierScopePolicyPair, b: SupplierScopePolicyPair): boolean {
  return a.environment === b.environment && a.buyerOrganizationId === b.buyerOrganizationId && a.supplierOrganizationId === b.supplierOrganizationId;
}
export const SupplierScopePolicyReferenceSchema = z.strictObject({ pair: SupplierScopePolicyPairSchema, version, hash: HashSchema });
export type SupplierScopePolicyReference = z.infer<typeof SupplierScopePolicyReferenceSchema>;
export const SupplierScopeCategoryInputSchema = z.strictObject({
  id: IdSchema, label: normalizedText(120), definition: normalizedText(2000),
});
export const SupplierScopeCategorySchema = z.strictObject({
  id: IdSchema, label: storedText(120), definition: storedText(2000), definitionHash: HashSchema,
});
export type SupplierScopeCategory = z.infer<typeof SupplierScopeCategorySchema>;
const categories = z.array(SupplierScopeCategorySchema).min(1).max(100)
  .refine(values => new Set(values.map(value => value.id)).size === values.length, 'Category IDs must be unique.');
export const SupplierScopePolicyTermsSchema = z.strictObject({
  buyerSiteIds: ids,
  categories: z.array(SupplierScopeCategoryInputSchema).min(1).max(100)
    .refine(values => new Set(values.map(value => value.id)).size === values.length, 'Category IDs must be unique.'),
  requestedValidityMs: z.number().int().min(1).max(SUPPLIER_SCOPE_POLICY_MAX_VALIDITY_MS),
});
export const SupplierScopePolicyCommandSchema = z.strictObject({
  pair: SupplierScopePolicyPairSchema, expectedVersion: epoch, predecessor: SupplierScopePolicyReferenceSchema.nullable(),
  buyerOrganizationVersion: version, authorityEpoch: epoch,
  payload: z.discriminatedUnion('action', [
    z.strictObject({ action: z.literal('issue'), terms: SupplierScopePolicyTermsSchema }),
    z.strictObject({ action: z.literal('replace'), terms: SupplierScopePolicyTermsSchema }),
    z.strictObject({ action: z.literal('revoke') }),
  ]),
}).superRefine((value, context) => {
  if (value.payload.action === 'issue' ? value.expectedVersion !== 0 || value.predecessor !== null :
    value.expectedVersion === 0 || value.predecessor === null || value.predecessor.version !== value.expectedVersion) {
    context.addIssue({ code: 'custom', message: 'Issue starts at zero; later commands require the exact preceding version.' });
  }
  if (value.predecessor && !supplierScopePolicyPairsMatch(value.pair, value.predecessor.pair)) {
    context.addIssue({ code: 'custom', message: 'The predecessor must belong to this exact ordered pair.' });
  }
});
export type SupplierScopePolicyCommand = z.infer<typeof SupplierScopePolicyCommandSchema>;
export const SupplierScopePolicyMutationSchema = z.strictObject({ idempotencyKey: IdempotencyKeySchema, command: SupplierScopePolicyCommandSchema });
export const SupplierScopePolicyCommandIdentitySchema = z.strictObject({
  pair: SupplierScopePolicyPairSchema, organizationId: IdSchema, actorId: IdSchema, idempotencyKey: IdempotencyKeySchema,
}).refine(value => value.organizationId === value.pair.buyerOrganizationId, 'Only the buyer issues scope policy.');
export type SupplierScopePolicyCommandIdentity = z.infer<typeof SupplierScopePolicyCommandIdentitySchema>;

/** Private immutable audit records, never an authorization constructor or public projection. */
export const SupplierScopePolicyIssuerSchema = z.strictObject({
  actorId: IdSchema, organizationId: IdSchema, membershipId: IdSchema, membershipVersion: version,
  organizationVersion: version, organizationEpoch: epoch, subject: z.string().min(1).max(256),
  externalOrganizationId: z.string().min(1).max(256), externalMembershipId: z.string().min(1).max(256),
  sessionId: z.string().min(1).max(256), factorEvidence: VersionReferenceSchema,
});
const organizationStamp = z.strictObject({
  externalOrganizationId: z.string().min(1).max(256), version, authorityEpoch: epoch,
});
export const SupplierScopePolicyVersionSchema = z.strictObject({
  schemaVersion: z.literal(1), pair: SupplierScopePolicyPairSchema, version,
  predecessor: SupplierScopePolicyReferenceSchema.nullable(), status: z.enum(['ACTIVE', 'REVOKED']),
  buyerSiteIds: ids, categories, issuedAt: InstantSchema, validFrom: InstantSchema, expiresAt: InstantSchema,
  organizations: z.strictObject({ buyer: organizationStamp, supplier: organizationStamp }),
  issuer: SupplierScopePolicyIssuerSchema, commandIdentity: SupplierScopePolicyCommandIdentitySchema, commandDigest: HashSchema,
}).superRefine((value, context) => {
  const invalid = (message: string) => context.addIssue({ code: 'custom', message });
  if (value.version === 1 ? value.predecessor !== null || value.status !== 'ACTIVE' : value.predecessor === null ||
    value.predecessor.version !== value.version - 1 || !supplierScopePolicyPairsMatch(value.pair, value.predecessor.pair)) invalid('An immutable policy must retain its exact predecessor.');
  if (value.issuedAt !== value.validFrom) invalid('Policy activation is exactly its acceptance time.');
  const duration = Date.parse(value.expiresAt) - Date.parse(value.validFrom);
  if (value.status === 'ACTIVE' ? duration <= 0 || duration > SUPPLIER_SCOPE_POLICY_MAX_VALIDITY_MS : duration !== 0) invalid('Active validity is finite and at most thirty days; revocation is immediate.');
  if (!supplierScopePolicyPairsMatch(value.pair, value.commandIdentity.pair) || value.issuer.organizationId !== value.pair.buyerOrganizationId ||
    value.issuer.actorId !== value.commandIdentity.actorId || value.issuer.organizationId !== value.commandIdentity.organizationId ||
    value.issuer.externalOrganizationId !== value.organizations.buyer.externalOrganizationId ||
    value.issuer.organizationVersion !== value.organizations.buyer.version || value.issuer.organizationEpoch !== value.organizations.buyer.authorityEpoch) invalid('Issuer, original command and organization stamps must agree.');
});
export type SupplierScopePolicyVersion = z.infer<typeof SupplierScopePolicyVersionSchema>;
export const SupplierScopePolicySnapshotSchema = z.strictObject({ policy: SupplierScopePolicyVersionSchema, policyHash: HashSchema });
export type SupplierScopePolicySnapshot = z.infer<typeof SupplierScopePolicySnapshotSchema>;
export const SupplierScopePolicyReceiptSchema = z.strictObject({
  identity: SupplierScopePolicyCommandIdentitySchema, commandDigest: HashSchema,
  result: SupplierScopePolicySnapshotSchema, recordedAt: InstantSchema,
}).refine(value => supplierScopePolicyPairsMatch(value.identity.pair, value.result.policy.pair) &&
  value.identity.actorId === value.result.policy.commandIdentity.actorId && value.identity.organizationId === value.result.policy.commandIdentity.organizationId &&
  value.identity.idempotencyKey === value.result.policy.commandIdentity.idempotencyKey && value.commandDigest === value.result.policy.commandDigest &&
  value.recordedAt === value.result.policy.issuedAt, 'Receipt must retain its original identity, digest, exact result and acceptance time.');
export type SupplierScopePolicyReceipt = z.infer<typeof SupplierScopePolicyReceiptSchema>;

/** PRIVATE sidecar: never insert this field into the frozen public proposal or its hash. */
export const SupplierRelationshipPolicyBindingSchema = z.strictObject({
  schemaVersion: z.literal(1), scope: SupplierScopeSchema, proposal: VersionReferenceSchema,
  policy: SupplierScopePolicyReferenceSchema, producingReceipt: SupplierRelationshipReceiptSchema,
}).refine(value => supplierScopePolicyPairsMatch(value.scope, value.policy.pair) &&
  value.proposal.id === value.scope.supplierRelationshipId && supplierScopesMatch(value.scope, value.producingReceipt.identity.scope) &&
  value.producingReceipt.result.status === 'PROPOSED' && value.producingReceipt.result.proposal.id === value.proposal.id &&
  value.producingReceipt.result.proposal.version === value.proposal.version && value.producingReceipt.result.proposal.hash === value.proposal.hash,
  'The private policy pin must bind one exact proposal and its original producing receipt.');
export type SupplierRelationshipPolicyBinding = z.infer<typeof SupplierRelationshipPolicyBindingSchema>;
