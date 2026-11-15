import { z } from 'zod';
import { EnvironmentSchema, IdSchema, IdempotencyKeySchema } from './core';
import { HashSchema } from './financial';
import { B2bFinancialTrustRefsV1Schema, FinancialAuthorityFenceSchema, FinancialFenceGenerationSchema, FinancialFenceVersionSchema, RegistryPinSchema } from './financial-fences';

export const FinancialPolicyVersionSchema = FinancialFenceVersionSchema;
export const FinancialPolicyGenerationSchema = FinancialFenceGenerationSchema;
export const FinancialPolicyUuidSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/).refine(v => v !== '00000000-0000-0000-0000-000000000000');
export const FinancialPolicyInstantSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/).refine(v => !v.startsWith('0000-') && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v);
export const FinancialPolicyAmountSchema = z.string().regex(/^[1-9][0-9]{0,19}$/).refine(v => /^[1-9][0-9]{0,19}$/.test(v) && BigInt(v) <= 18446744073709551615n);
const validAmounts = (...values: unknown[]) => values.every(value => FinancialPolicyAmountSchema.safeParse(value).success);
export const FinancialPolicyNonceSchema = z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
export const FinancialPolicyRefSchema = z.strictObject({ id: IdSchema, version: FinancialPolicyVersionSchema, recordHash: HashSchema });
export const FinancialPolicyActorSchema = z.strictObject({ actorId: IdSchema, membershipVersion: FinancialPolicyVersionSchema,
  subject: IdSchema, externalMembershipId: IdSchema, sessionId: z.string().min(1).max(256) });
export const FinancialPolicyTextSchema = z.string().min(1).max(40_000).refine(v => [...v].length <= 20_000 && v.trim().length > 0 && v.normalize('NFC') === v &&
  !/[\r\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v) && [...v].every(c => !(c.codePointAt(0)! >= 0xd800 && c.codePointAt(0)! <= 0xdfff)), 'Normalized NFC/LF policy text of at most 20,000 characters is required.');
export const FinancialPolicyDocumentPurposeSchema = z.enum(['financial_mandate', 'budget_policy', 'approval_policy']);
export const FinancialPolicyDocumentRefSchema = FinancialPolicyRefSchema.extend({ purpose: FinancialPolicyDocumentPurposeSchema });
const sortedRefs = z.array(FinancialPolicyDocumentRefSchema).min(1).max(8).refine(v => v.every((x, i) => i === 0 || v[i - 1]!.id < x.id), 'Document references must be sorted and unique.');
const sortedIds = z.array(IdSchema).min(1).max(100).refine(v => v.every((x, i) => i === 0 || v[i - 1]! < x), 'IDs must be sorted and unique.');
const roles = <T extends z.ZodType>(schema: T) => z.array(schema).min(1).max(3).refine(v => v.every((x, i) => i === 0 || String(v[i - 1]) < String(x)), 'Roles must be sorted and unique.');

export const FinancialBudgetLimitsSchema = z.strictObject({ perOperation: FinancialPolicyAmountSchema,
  perResponsibility: FinancialPolicyAmountSchema, perPeriod: FinancialPolicyAmountSchema,
}).refine(v => !validAmounts(v.perOperation, v.perResponsibility, v.perPeriod) ||
  BigInt(v.perOperation) <= BigInt(v.perResponsibility) && BigInt(v.perResponsibility) <= BigInt(v.perPeriod), 'Operation <= responsibility <= period limits are required.');
export const FinancialBudgetPeriodSchema = z.strictObject({ id: HashSchema, startsAt: FinancialPolicyInstantSchema, endsAt: FinancialPolicyInstantSchema,
}).refine(v => v.startsAt < v.endsAt, 'A nonempty fixed half-open UTC period is required.');
export const FinancialApprovalPolicySchema = z.strictObject({ requesterRoles: roles(z.enum(['owner', 'finance', 'operations'])),
  approverRoles: roles(z.enum(['owner', 'finance'])), independent: z.literal(true), actionSiteIds: sortedIds,
  action: z.literal('allocate_funds'), category: z.literal('supplier_principal'), thresholdBaseUnits: FinancialPolicyAmountSchema,
  maximumAuthenticationAgeSeconds: z.number().int().min(1).max(300), maximumApprovalAgeSeconds: z.number().int().min(1).max(300) });
export const FinancialGovernanceBundleSchema = z.strictObject({ budgetAccountId: HashSchema, asset: RegistryPinSchema,
  category: z.literal('supplier_principal'), limits: FinancialBudgetLimitsSchema, period: FinancialBudgetPeriodSchema,
  approval: FinancialApprovalPolicySchema, documents: sortedRefs,
}).refine(v => (!validAmounts(v.approval.thresholdBaseUnits, v.limits.perOperation) || BigInt(v.approval.thresholdBaseUnits) <= BigInt(v.limits.perOperation)) && v.documents.length === 2 &&
  new Set(v.documents.map(d => d.purpose)).size === 2 && v.documents.every(d => d.purpose === 'budget_policy' || d.purpose === 'approval_policy'), 'Exact budget and approval documents and bounded threshold are required.');
export const FinancialGovernanceControlRefSchema = z.strictObject({ budgetAccountId: HashSchema, generation: FinancialPolicyGenerationSchema,
  accepted: FinancialPolicyRefSchema.nullable() }).refine(v => (v.generation === 0) === (v.accepted === null), 'A positive generation requires its exact accepted configuration.');

export const FinancialDraftTermsSchema = z.strictObject({ mode: z.literal('PREPARE_FOR_APPROVAL'), actions: z.tuple([z.literal('allocate_funds')]),
  category: z.literal('supplier_principal'), allocation: z.literal('responsibility_earmark'),
  supplier: z.null(), acceptedTerms: z.null(), payee: z.null(), tool: z.null(), withdrawal: z.null(), branch: z.null(),
  communication: z.strictObject({ recipients: z.tuple([]), purposes: z.tuple([]), kinds: z.tuple([]), allowanceBaseUnits: z.literal('0') }) });
export const FinancialDraftScopeSchema = z.strictObject({ authority: FinancialAuthorityFenceSchema, authorityHash: HashSchema,
  site: z.strictObject({ id: IdSchema, generation: FinancialPolicyGenerationSchema, recordHash: HashSchema }) });
export const FinancialDraftInputSchema = z.strictObject({ scope: FinancialDraftScopeSchema, terms: FinancialDraftTermsSchema,
  documents: sortedRefs, governance: FinancialGovernanceControlRefSchema.nullable(), asset: RegistryPinSchema.nullable(), account: RegistryPinSchema.nullable(),
  trust: B2bFinancialTrustRefsV1Schema.nullable(), startsAt: FinancialPolicyInstantSchema, expiresAt: FinancialPolicyInstantSchema,
}).refine(v => v.startsAt < v.expiresAt && v.scope.site.id === v.scope.authority.responsibility.siteId && v.documents.length === 1 && v.documents[0]!.purpose === 'financial_mandate' &&
  (v.account === null || v.asset !== null) && (v.governance === null || v.asset !== null) &&
  (v.trust === null || v.asset !== null && v.account !== null && v.trust.asset.key === v.asset.key && v.trust.account.key === v.account.key), 'Exact supported draft scope and material references are required.');

const record = { schemaVersion: z.literal(1), environment: EnvironmentSchema, organizationId: IdSchema,
  id: IdSchema, version: FinancialPolicyVersionSchema, predecessor: FinancialPolicyRefSchema.nullable(),
  actor: FinancialPolicyActorSchema, identityEvidence: FinancialPolicyRefSchema, organizationEpoch: FinancialPolicyGenerationSchema,
  operationId: FinancialPolicyUuidSchema, createdAt: FinancialPolicyInstantSchema };
export const FinancialPolicyDocumentSchema = z.strictObject({ ...record, kind: z.literal('document'), responsibilityId: IdSchema.nullable(),
  purpose: FinancialPolicyDocumentPurposeSchema, text: FinancialPolicyTextSchema, contentHash: HashSchema });
export const FinancialMandateDraftSchema = z.strictObject({ ...record, kind: z.literal('draft'), responsibilityId: IdSchema,
  state: z.enum(['DRAFT', 'WITHDRAWN']), requester: FinancialPolicyActorSchema, draft: FinancialDraftInputSchema });
export const FinancialGovernanceProposalSchema = z.strictObject({ ...record, kind: z.literal('governance'), responsibilityId: z.null(),
  state: z.enum(['OPEN', 'ACCEPTED', 'REJECTED']), proposer: FinancialPolicyActorSchema, bundle: FinancialGovernanceBundleSchema,
  expectedControl: FinancialGovernanceControlRefSchema, decisionNonce: FinancialPolicyNonceSchema, expiresAt: FinancialPolicyInstantSchema,
  decision: z.strictObject({ proposerObservation: FinancialPolicyRefSchema, approverObservation: FinancialPolicyRefSchema,
    mfaEvidence: FinancialPolicyRefSchema.nullable(), intentHash: HashSchema.nullable(), requestHash: HashSchema.nullable() }).nullable(),
});
export const FinancialPolicyRecordSchema = z.discriminatedUnion('kind', [FinancialPolicyDocumentSchema, FinancialMandateDraftSchema, FinancialGovernanceProposalSchema]).superRefine((v, ctx) => {
  if ((v.version === 1) !== (v.predecessor === null) || v.predecessor !== null && (v.predecessor.id !== v.id || v.predecessor.version + 1 !== v.version))
    ctx.addIssue({ code: 'custom', message: 'The exact contiguous predecessor is required.' });
  if (v.kind === 'governance' && (v.bundle.budgetAccountId !== v.expectedControl.budgetAccountId || (v.state === 'OPEN') !== (v.decision === null) ||
    v.state === 'ACCEPTED' && (v.decision?.mfaEvidence == null || v.decision?.intentHash == null || v.decision?.requestHash == null) ||
    v.state === 'REJECTED' && (v.decision?.mfaEvidence !== null || v.decision?.intentHash !== null || v.decision?.requestHash !== null)))
    ctx.addIssue({ code: 'custom', message: 'Governance consent records must retain their exact decision evidence.' });
  if (v.kind === 'draft' && (v.draft.scope.authority.environment !== v.environment || v.draft.scope.authority.organizationId !== v.organizationId ||
    v.draft.scope.authority.responsibility.id !== v.responsibilityId || v.draft.trust !== null && (v.draft.trust.environment !== v.environment || v.draft.trust.organizationId !== v.organizationId)))
    ctx.addIssue({ code: 'custom', message: 'Draft material scope must match its enclosing organization and responsibility.' });
});

const command = { schemaVersion: z.literal(1), environment: EnvironmentSchema, organizationId: IdSchema,
  responsibilityId: IdSchema.nullable(), key: IdempotencyKeySchema, id: IdSchema, previous: FinancialPolicyRefSchema.nullable(), organizationEpoch: FinancialPolicyGenerationSchema };
export const FinancialPolicyCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...command, kind: z.literal('save_document'), purpose: FinancialPolicyDocumentPurposeSchema, text: FinancialPolicyTextSchema }),
  z.strictObject({ ...command, responsibilityId: IdSchema, kind: z.literal('save_draft'), draft: FinancialDraftInputSchema }),
  z.strictObject({ ...command, responsibilityId: IdSchema, previous: FinancialPolicyRefSchema, kind: z.literal('withdraw_draft') }),
  z.strictObject({ ...command, responsibilityId: z.null(), kind: z.literal('propose_governance'), bundle: FinancialGovernanceBundleSchema,
    expectedControl: FinancialGovernanceControlRefSchema, expiresAt: FinancialPolicyInstantSchema }),
  z.strictObject({ ...command, responsibilityId: z.null(), previous: FinancialPolicyRefSchema, kind: z.literal('accept_governance'),
    expectedControl: FinancialGovernanceControlRefSchema, nonce: FinancialPolicyNonceSchema, proposerEvidenceId: FinancialPolicyUuidSchema, mfaEvidenceId: FinancialPolicyUuidSchema }),
  z.strictObject({ ...command, responsibilityId: z.null(), previous: FinancialPolicyRefSchema, kind: z.literal('reject_governance'),
    expectedControl: FinancialGovernanceControlRefSchema, proposerEvidenceId: FinancialPolicyUuidSchema }),
]);
export const FinancialPolicyDecisionIntentSchema = z.strictObject({ schemaVersion: z.literal(1), purpose: z.literal('financial_policy_authorization'),
  environment: EnvironmentSchema, organizationId: IdSchema, proposal: FinancialPolicyRefSchema,
  control: FinancialGovernanceControlRefSchema, proposer: FinancialPolicyActorSchema, approver: FinancialPolicyActorSchema,
  organizationEpoch: FinancialPolicyGenerationSchema, key: IdempotencyKeySchema, nonce: FinancialPolicyNonceSchema });
export const FinancialPolicyResultSchema = z.strictObject({ schemaVersion: z.literal(1), id: FinancialPolicyUuidSchema,
  environment: EnvironmentSchema, organizationId: IdSchema, actorId: IdSchema, responsibilityId: IdSchema.nullable(),
  kind: z.enum(['save_document', 'save_draft', 'withdraw_draft', 'propose_governance', 'accept_governance', 'reject_governance']),
  key: IdempotencyKeySchema, commandHash: HashSchema, target: FinancialPolicyRefSchema, body: FinancialPolicyRecordSchema,
  financialState: z.null(), effectiveAuthority: z.literal(false) });
export const FinancialPolicyLookupSchema = z.strictObject({ environment: EnvironmentSchema, organizationId: IdSchema,
  responsibilityId: IdSchema.nullable(), kind: FinancialPolicyResultSchema.shape.kind, key: IdempotencyKeySchema, commandHash: HashSchema });
export const FinancialPolicyReadQuerySchema = z.strictObject({ environment: EnvironmentSchema, organizationId: IdSchema,
  responsibilityId: IdSchema.nullable(), id: IdSchema, version: FinancialPolicyVersionSchema.nullable() });
export const FinancialPolicyListQuerySchema = z.strictObject({ environment: EnvironmentSchema, organizationId: IdSchema,
  responsibilityId: IdSchema, afterId: IdSchema.nullable(), limit: z.number().int().min(1).max(50) });
export const FinancialPolicyBlockerSchema = z.enum(['DRAFT_WITHDRAWN', 'DRAFT_EXPIRED', 'DOCUMENT_CHANGED', 'SCOPE_CHANGED', 'GOVERNANCE_MISSING', 'GOVERNANCE_CHANGED',
  'ASSET_MISSING', 'ASSET_CHANGED', 'ACCOUNT_MISSING', 'ACCOUNT_CHANGED', 'TRUST_UNAVAILABLE', 'FINANCIAL_AUTHORITY_UNAVAILABLE']);
export const FinancialPolicyReadSchema = z.strictObject({ record: FinancialPolicyRecordSchema, reference: FinancialPolicyRefSchema,
  current: z.boolean(), state: z.enum(['DOCUMENT', 'DRAFT', 'WITHDRAWN', 'OPEN', 'ACCEPTED', 'REJECTED', 'SUPERSEDED', 'EXPIRED']),
  blockers: z.array(FinancialPolicyBlockerSchema).max(16), effectiveAuthority: z.literal(false) });
export const FinancialPolicyPageSchema = z.strictObject({ items: z.array(FinancialPolicyReadSchema).max(50), nextId: IdSchema.nullable() });

export type FinancialPolicyRef = z.infer<typeof FinancialPolicyRefSchema>;
export type FinancialPolicyActor = z.infer<typeof FinancialPolicyActorSchema>;
export type FinancialPolicyRecord = z.infer<typeof FinancialPolicyRecordSchema>;
export type FinancialPolicyDocument = z.infer<typeof FinancialPolicyDocumentSchema>;
export type FinancialMandateDraft = z.infer<typeof FinancialMandateDraftSchema>;
export type FinancialGovernanceProposal = z.infer<typeof FinancialGovernanceProposalSchema>;
export type FinancialGovernanceBundle = z.infer<typeof FinancialGovernanceBundleSchema>;
export type FinancialDraftInput = z.infer<typeof FinancialDraftInputSchema>;
export type FinancialPolicyCommand = z.infer<typeof FinancialPolicyCommandSchema>;
export type FinancialPolicyResult = z.infer<typeof FinancialPolicyResultSchema>;
export type FinancialPolicyLookup = z.infer<typeof FinancialPolicyLookupSchema>;
export type FinancialPolicyReadQuery = z.infer<typeof FinancialPolicyReadQuerySchema>;
export type FinancialPolicyListQuery = z.infer<typeof FinancialPolicyListQuerySchema>;
export type FinancialPolicyRead = z.infer<typeof FinancialPolicyReadSchema>;
export type FinancialPolicyPage = z.infer<typeof FinancialPolicyPageSchema>;
export type FinancialPolicyDecisionIntent = z.infer<typeof FinancialPolicyDecisionIntentSchema>;
