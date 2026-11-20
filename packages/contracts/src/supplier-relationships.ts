import { z } from 'zod';
import { IdSchema, IdempotencyKeySchema, InstantSchema } from './core';
import { HashSchema, VersionReferenceSchema } from './financial';
import { SupplierScopeSchema, supplierScopesMatch } from './supplier-protocol';

const version = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const epoch = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const uniqueIds = z.array(IdSchema).min(1).max(100).refine(ids => new Set(ids).size === ids.length, 'Duplicate scope identifiers.');
export const SupplierRelationshipPartySchema = z.enum(['buyer', 'supplier']);
export const SupplierRelationshipStatusSchema = z.enum(['PROPOSED', 'ACTIVE', 'SUSPENDED', 'REVOKED']);

/** Administrative scope only. These fields grant no booking, contractual or payment authority. */
export const SupplierRelationshipTermsSchema = z.strictObject({
  buyerSiteIds: uniqueIds, serviceCategoryIds: uniqueIds, expiresAt: InstantSchema,
});
export const SupplierRelationshipAdministratorSchema = z.strictObject({
  actorId: IdSchema, organizationId: IdSchema, membershipId: IdSchema,
  membershipVersion: version, organizationVersion: version, organizationEpoch: epoch,
});
export const SupplierRelationshipProposalSchema = z.strictObject({
  schemaVersion: z.literal(1), scope: SupplierScopeSchema, version,
  previousVersionHash: HashSchema.nullable(), terms: SupplierRelationshipTermsSchema,
  createdBy: SupplierRelationshipAdministratorSchema, createdAt: InstantSchema,
}).superRefine((value, context) => {
  if ((value.version === 1) !== (value.previousVersionHash === null)) context.addIssue({ code: 'custom', message: 'A later proposal must retain its predecessor hash.' });
  if (![value.scope.buyerOrganizationId, value.scope.supplierOrganizationId].includes(value.createdBy.organizationId)) context.addIssue({ code: 'custom', message: 'The proposer must belong to a party.' });
  if (Date.parse(value.terms.expiresAt) <= Date.parse(value.createdAt)) context.addIssue({ code: 'custom', message: 'Proposal expiry must follow creation.' });
});
export type SupplierRelationshipProposal = z.infer<typeof SupplierRelationshipProposalSchema>;

/** Parsing an approval record does not authenticate its signer or validate current staff authority. */
export const SupplierRelationshipApprovalSchema = SupplierRelationshipAdministratorSchema.extend({
  party: SupplierRelationshipPartySchema, proposal: VersionReferenceSchema,
  approvedAt: InstantSchema, expiresAt: InstantSchema,
}).refine(value => Date.parse(value.expiresAt) > Date.parse(value.approvedAt), 'Approval must have a positive validity interval.');
export type SupplierRelationshipApproval = z.infer<typeof SupplierRelationshipApprovalSchema>;
export const SupplierRelationshipSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1), revision: version, proposal: SupplierRelationshipProposalSchema,
  proposalHash: HashSchema, status: SupplierRelationshipStatusSchema,
  approvals: z.strictObject({ buyer: SupplierRelationshipApprovalSchema.nullable(), supplier: SupplierRelationshipApprovalSchema.nullable() }),
  changedBy: SupplierRelationshipAdministratorSchema, updatedAt: InstantSchema,
}).superRefine((value, context) => {
  const add = (message: string) => context.addIssue({ code: 'custom', message });
  if (value.revision < value.proposal.version) add('Aggregate revision cannot precede proposal version.');
  if (Date.parse(value.updatedAt) < Date.parse(value.proposal.createdAt)) add('An update cannot precede its proposal.');
  if (![value.proposal.scope.buyerOrganizationId, value.proposal.scope.supplierOrganizationId].includes(value.changedBy.organizationId)) add('The changer must belong to a party.');
  const both = value.approvals.buyer !== null && value.approvals.supplier !== null;
  if (value.status === 'ACTIVE' ? !both : value.status === 'PROPOSED' ? both : value.approvals.buyer !== null || value.approvals.supplier !== null) add('Status and approvals disagree.');
  for (const party of SupplierRelationshipPartySchema.options) {
    const approval = value.approvals[party];
    if (approval === null) continue;
    const organizationId = party === 'buyer' ? value.proposal.scope.buyerOrganizationId : value.proposal.scope.supplierOrganizationId;
    if (approval.party !== party || approval.organizationId !== organizationId || approval.proposal.id !== value.proposal.scope.supplierRelationshipId ||
        approval.proposal.version !== value.proposal.version || approval.proposal.hash !== value.proposalHash) add('Approval must bind its own party and exact proposal.');
    if (Date.parse(approval.approvedAt) < Date.parse(value.proposal.createdAt) || Date.parse(approval.approvedAt) > Date.parse(value.updatedAt) ||
        Date.parse(approval.expiresAt) > Date.parse(value.proposal.terms.expiresAt)) add('Approval is outside the proposal interval.');
  }
});
export type SupplierRelationshipSnapshot = z.infer<typeof SupplierRelationshipSnapshotSchema>;

/** Both aggregate revision and immutable proposal reference are explicit concurrency fences. */
export const SupplierRelationshipCommandSchema = z.strictObject({
  scope: SupplierScopeSchema, expectedVersion: epoch, mandateVersion: z.null(), authorityEpoch: epoch,
  targetProposal: VersionReferenceSchema.nullable(),
  payload: z.discriminatedUnion('action', [
    z.strictObject({ action: z.literal('create'), terms: SupplierRelationshipTermsSchema }),
    z.strictObject({ action: z.literal('revise'), terms: SupplierRelationshipTermsSchema }),
    z.strictObject({ action: z.literal('approve'), expiresAt: InstantSchema }),
    z.strictObject({ action: z.literal('suspend') }),
    z.strictObject({ action: z.literal('revoke') }),
  ]),
}).superRefine((value, context) => {
  if (value.payload.action === 'create' ? value.expectedVersion !== 0 || value.targetProposal !== null : value.expectedVersion === 0 || value.targetProposal === null) context.addIssue({ code: 'custom', message: 'Creation starts at zero; later commands fence the aggregate and proposal.' });
  if (value.targetProposal !== null && value.targetProposal.id !== value.scope.supplierRelationshipId) context.addIssue({ code: 'custom', message: 'Proposal must identify this relationship.' });
});
export type SupplierRelationshipCommand = z.infer<typeof SupplierRelationshipCommandSchema>;
export const SupplierRelationshipMutationSchema = z.strictObject({ idempotencyKey: IdempotencyKeySchema, command: SupplierRelationshipCommandSchema });
export const SupplierRelationshipHeadSchema = z.strictObject({
  scope: SupplierScopeSchema, revision: version, proposal: VersionReferenceSchema, status: SupplierRelationshipStatusSchema,
}).refine(value => value.proposal.id === value.scope.supplierRelationshipId && value.revision >= value.proposal.version, 'Head must retain relationship identity and distinct version fences.');
export type SupplierRelationshipHead = z.infer<typeof SupplierRelationshipHeadSchema>;
export const SupplierRelationshipReceiptSchema = z.strictObject({
  identity: z.strictObject({ scope: SupplierScopeSchema, actorId: IdSchema, organizationId: IdSchema, idempotencyKey: IdempotencyKeySchema }),
  commandDigest: HashSchema, result: SupplierRelationshipHeadSchema, recordedAt: InstantSchema,
}).refine(value => supplierScopesMatch(value.identity.scope, value.result.scope) &&
  [value.identity.scope.buyerOrganizationId, value.identity.scope.supplierOrganizationId].includes(value.identity.organizationId), 'Receipt scope must retain the original participant identity.');
export type SupplierRelationshipReceipt = z.infer<typeof SupplierRelationshipReceiptSchema>;

/** Deliberate allowlist: no contacts, sites, staff identities, other jobs, offers, budgets or payees. */
export const SupplierRelationshipProjectionSchema = z.strictObject({
  kind: z.literal('RELATIONSHIP_STATUS_ONLY'), scope: SupplierScopeSchema, revision: version,
  proposal: VersionReferenceSchema, status: SupplierRelationshipStatusSchema, expiresAt: InstantSchema,
  viewerParty: SupplierRelationshipPartySchema, current: z.boolean(),
  approvalsRecorded: z.strictObject({ buyer: z.boolean(), supplier: z.boolean() }),
  relationshipGate: z.enum(['SATISFIED', 'BLOCKED']),
  gateReason: z.enum(['NOT_CURRENT_REVISION', 'NOT_ACTIVE', 'PROPOSAL_EXPIRED', 'SCOPE_NOT_CURRENT', 'APPROVAL_NOT_CURRENT']).nullable(),
  authentication: z.literal('NOT_ESTABLISHED'),
  businessVerification: z.literal('NOT_ESTABLISHED'), payeeVerification: z.literal('NOT_ESTABLISHED'),
  bookingAuthority: z.literal(false), contractualAcceptance: z.literal(false), paymentAuthority: z.literal(false),
}).superRefine((value, context) => {
  const add = (message: string) => context.addIssue({ code: 'custom', message });
  if (value.proposal.id !== value.scope.supplierRelationshipId || value.revision < value.proposal.version) add('Projection must retain exact relationship and version fences.');
  if ((value.relationshipGate === 'SATISFIED') !== (value.gateReason === null)) add('Gate state and reason must agree.');
  if (!value.current && value.gateReason !== 'NOT_CURRENT_REVISION') add('Historical status cannot satisfy a current relationship gate.');
  if (value.current && value.gateReason === 'NOT_CURRENT_REVISION') add('A current projection cannot be labeled historical.');
  const both = value.approvalsRecorded.buyer && value.approvalsRecorded.supplier;
  if (value.status === 'ACTIVE' ? !both : value.status === 'PROPOSED' ? both : value.approvalsRecorded.buyer || value.approvalsRecorded.supplier) add('Recorded approval flags must match historical status.');
  if (value.relationshipGate === 'SATISFIED' && (value.status !== 'ACTIVE' || !value.approvalsRecorded.buyer || !value.approvalsRecorded.supplier)) add('Both approvals and ACTIVE status are required.');
});
export type SupplierRelationshipProjection = z.infer<typeof SupplierRelationshipProjectionSchema>;
