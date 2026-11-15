import { z } from 'zod';
import { EnvironmentSchema, FinancialStateSchema, IdSchema, InstantSchema, OperationSchema, ResponsibilitySchema, SiteSchema } from './core';
import { HashSchema, MandateHeadSchema, MandatePolicySchema, MandateVersionSchema, VersionReferenceSchema } from './financial';

const version = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const epoch = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const reason = z.string().trim().min(1).max(1000);
export const PolicyDocumentPurposeSchema = z.enum(['ACCEPTANCE_POLICY', 'MANDATE_POLICY']);
export const PolicyDocumentTextSchema = z.string().min(1).max(20_000)
  .refine(text => text.trim().length > 0 && !/[\uD800-\uDFFF\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(text), 'Use nonempty, well-formed policy text');
export const PolicyDocumentVersionSchema = z.strictObject({
  schemaVersion: z.literal(1), id: IdSchema, version,
  organizationId: IdSchema, environment: EnvironmentSchema, purpose: PolicyDocumentPurposeSchema,
  normalization: z.literal('NFC_LF_V1'), text: PolicyDocumentTextSchema,
  contentHash: HashSchema, previousVersion: VersionReferenceSchema.nullable(),
  createdAt: InstantSchema, createdBy: IdSchema, hash: HashSchema,
});
export type PolicyDocumentVersion = z.infer<typeof PolicyDocumentVersionSchema>;
export const CreatePolicyDocumentCommandSchema = z.strictObject({
  documentId: IdSchema, expectedVersion: epoch, previousVersion: VersionReferenceSchema.nullable(),
  purpose: PolicyDocumentPurposeSchema, text: PolicyDocumentTextSchema,
});
export type CreatePolicyDocumentCommand = z.infer<typeof CreatePolicyDocumentCommandSchema>;

export const MandateResponsibilityReferenceSchema = VersionReferenceSchema.extend({ siteId: IdSchema });
export type MandateResponsibilityReference = z.infer<typeof MandateResponsibilityReferenceSchema>;
export const MandateHeadReferenceSchema = z.strictObject({ mandateId: IdSchema, mandateVersion: version, mandateEpoch: epoch, hash: HashSchema });
export type MandateHeadReference = z.infer<typeof MandateHeadReferenceSchema>;
export const MandateProposalVersionSchema = z.strictObject({
  schemaVersion: z.literal(1), id: IdSchema, version, previousProposal: VersionReferenceSchema.nullable(),
  organizationId: IdSchema, environment: EnvironmentSchema, organizationEpoch: epoch,
  mandateId: IdSchema, responsibility: MandateResponsibilityReferenceSchema, requesterId: IdSchema,
  previousAcceptedVersion: VersionReferenceSchema.nullable(), expectedHead: MandateHeadReferenceSchema.nullable(),
  policy: MandatePolicySchema, policyHash: HashSchema, policyDocument: VersionReferenceSchema,
  createdAt: InstantSchema, expiresAt: InstantSchema, hash: HashSchema,
});
export type MandateProposalVersion = z.infer<typeof MandateProposalVersionSchema>;
export const ProposeMandateCommandSchema = z.strictObject({
  proposalId: IdSchema, expectedProposalVersion: epoch, previousProposal: VersionReferenceSchema.nullable(),
  mandateId: IdSchema, responsibility: MandateResponsibilityReferenceSchema, expectedOrganizationEpoch: epoch,
  previousAcceptedVersion: VersionReferenceSchema.nullable(), expectedHead: MandateHeadReferenceSchema.nullable(),
  policy: MandatePolicySchema, policyDocument: VersionReferenceSchema, expiresAt: InstantSchema,
});
export type ProposeMandateCommand = z.infer<typeof ProposeMandateCommandSchema>;

// Exact public intent. Identity and verified MFA are supplied only by the private boundary.
export const MandateDecisionIntentSchema = z.strictObject({
  schemaVersion: z.literal(1), action: z.enum(['AUTHORIZE', 'REJECT']),
  proposal: VersionReferenceSchema, expectedDecisionVersion: version, expectedOrganizationEpoch: epoch,
  expectedHead: MandateHeadReferenceSchema.nullable(), reason: reason.nullable(),
}).refine(intent => intent.action === 'AUTHORIZE' ? intent.reason === null : intent.reason !== null, 'Rejection requires a reason; authorization has no rejection reason');
export type MandateDecisionIntent = z.infer<typeof MandateDecisionIntentSchema>;
export const MandateAuthorityIntentSchema = z.strictObject({
  schemaVersion: z.literal(1), action: z.enum(['PAUSE', 'REVOKE', 'RESUME']),
  mandate: VersionReferenceSchema, head: MandateHeadReferenceSchema,
  responsibility: MandateResponsibilityReferenceSchema, expectedOrganizationEpoch: epoch, reason,
});
export type MandateAuthorityIntent = z.infer<typeof MandateAuthorityIntentSchema>;
export const MandateAuthorizationReceiptSchema = z.strictObject({
  id: IdSchema, purpose: z.literal('mandate_authorization'), intentHash: HashSchema,
  requesterId: IdSchema, approverId: IdSchema, approvedAt: InstantSchema,
  stepUpEvidenceId: IdSchema, stepUpVerifiedAt: InstantSchema, stepUpExpiresAt: InstantSchema,
  acceptedVersion: VersionReferenceSchema, acceptedHead: MandateHeadReferenceSchema,
}).refine(receipt => receipt.approverId !== receipt.requesterId &&
  receipt.acceptedVersion.id === receipt.acceptedHead.mandateId && receipt.acceptedVersion.version === receipt.acceptedHead.mandateVersion &&
  Date.parse(receipt.stepUpVerifiedAt) <= Date.parse(receipt.approvedAt) && Date.parse(receipt.stepUpExpiresAt) > Date.parse(receipt.approvedAt),
  'An authorization receipt requires independent approval, current evidence and matching accepted authority');
export type MandateAuthorizationReceipt = z.infer<typeof MandateAuthorizationReceiptSchema>;
export const MandateDecisionSchema = z.strictObject({
  proposal: VersionReferenceSchema, version, state: z.enum(['OPEN', 'APPROVED', 'REJECTED', 'EXPIRED', 'SUPERSEDED']),
  createdAt: InstantSchema, decidedAt: InstantSchema.nullable(), actorId: IdSchema.nullable(),
  intentHash: HashSchema.nullable(), reason: reason.nullable(), replacement: VersionReferenceSchema.nullable(),
  authorization: MandateAuthorizationReceiptSchema.nullable(), operationId: IdSchema,
}).superRefine((decision, context) => {
  const open = decision.state === 'OPEN';
  const valid = decision.version === (open ? 1 : 2) &&
    (open ? decision.decidedAt === null : decision.decidedAt !== null && Date.parse(decision.decidedAt) >= Date.parse(decision.createdAt)) &&
    ((open || decision.state === 'EXPIRED') ? decision.actorId === null : decision.actorId !== null) &&
    (['APPROVED', 'REJECTED'].includes(decision.state) ? decision.intentHash !== null : decision.intentHash === null) &&
    (decision.state === 'REJECTED' ? decision.reason !== null : decision.reason === null) &&
    (decision.state === 'SUPERSEDED' ? decision.replacement !== null : decision.replacement === null) &&
    (decision.state === 'APPROVED' ? decision.authorization !== null && decision.authorization.approverId === decision.actorId &&
      decision.authorization.intentHash === decision.intentHash && decision.authorization.approvedAt === decision.decidedAt : decision.authorization === null);
  if (!valid) context.addIssue({ code: 'custom', message: 'Decision state and immutable outcome fields disagree' });
});
export type MandateDecision = z.infer<typeof MandateDecisionSchema>;
export const MandateEligibilitySchema = z.strictObject({
  action: z.enum(['PROPOSE', 'AUTHORIZE', 'REJECT', 'PAUSE', 'REVOKE', 'RESUME']), eligible: z.boolean(),
  requiresStepUp: z.boolean(), blockers: z.array(z.string().min(1).max(100)).max(20),
}).refine(value => value.eligible === (value.blockers.length === 0), 'Eligibility must agree with its blockers');
export type MandateEligibility = z.infer<typeof MandateEligibilitySchema>;
export const MandateReadEnvelopeSchema = z.strictObject({
  schemaVersion: z.literal(1), observedAt: InstantSchema, organizationEpoch: epoch,
  responsibility: ResponsibilitySchema, responsibilityReference: MandateResponsibilityReferenceSchema, site: SiteSchema,
  proposal: MandateProposalVersionSchema.nullable(), decision: MandateDecisionSchema.nullable(),
  acceptedVersion: MandateVersionSchema.nullable(), head: MandateHeadSchema.nullable(),
  acceptedProposal: MandateProposalVersionSchema.nullable(), acceptedDecision: MandateDecisionSchema.nullable(),
  financialState: FinancialStateSchema.nullable(),
  policyDocuments: z.array(PolicyDocumentVersionSchema).max(100), eligibility: z.array(MandateEligibilitySchema).max(6),
  supportedPolicy: z.strictObject({ mode: z.literal('ADVISE'), financialActions: z.array(z.never()).length(0),
    monetaryBudgets: z.literal(false), supplierReferences: z.literal(false), outboundCommunication: z.literal(false) }),
  operation: OperationSchema.nullable(),
}).superRefine((envelope, context) => {
  const referenceMatches = (reference: { id: string; version: number; hash: string }, record: { id: string; version: number; hash: string }) =>
    reference.id === record.id && reference.version === record.version && reference.hash === record.hash;
  const selected = (envelope.proposal === null) === (envelope.decision === null) &&
    (!envelope.proposal || referenceMatches(envelope.decision!.proposal, envelope.proposal));
  const accepted = (envelope.acceptedVersion === null) === (envelope.head === null) &&
    (envelope.acceptedVersion === null) === (envelope.acceptedProposal === null) &&
    (envelope.acceptedVersion === null) === (envelope.acceptedDecision === null) && (!envelope.acceptedVersion ||
      (envelope.acceptedDecision!.state === 'APPROVED' && referenceMatches(envelope.acceptedDecision!.proposal, envelope.acceptedProposal!) &&
        envelope.acceptedVersion.id === envelope.head!.mandateId && envelope.acceptedVersion.version === envelope.head!.mandateVersion &&
        envelope.acceptedDecision!.authorization!.acceptedVersion.id === envelope.acceptedVersion.id &&
        envelope.acceptedDecision!.authorization!.acceptedVersion.version === envelope.acceptedVersion.version));
  const references = [envelope.proposal, envelope.acceptedProposal].flatMap(proposal => proposal ? [proposal.policy.acceptancePolicy, proposal.policyDocument] : []);
  const completeText = references.every(reference => envelope.policyDocuments.filter(document => referenceMatches(reference, document)).length === 1);
  const uniqueDocuments = new Set(envelope.policyDocuments.map(document => `${document.id}:${document.version}`)).size === envelope.policyDocuments.length;
  const uniqueEligibility = new Set(envelope.eligibility.map(item => item.action)).size === envelope.eligibility.length;
  if (!selected || !accepted || !completeText || !uniqueDocuments || !uniqueEligibility) {
    context.addIssue({ code: 'custom', message: 'Read envelopes require matching decisions, accepted authority and every complete referenced policy document' });
  }
});
export type MandateReadEnvelope = z.infer<typeof MandateReadEnvelopeSchema>;
