import { z } from 'zod';
import { AssetSchema, BaseUnitsSchema, EnvironmentSchema, IdSchema, InstantSchema, ServiceWindowSchema } from './core';

const version = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const epoch = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const boundedCount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const VersionReferenceSchema = z.strictObject({ id: IdSchema, version, hash: HashSchema });
export const FinancialCategorySchema = z.enum(['supplier_principal', 'supplier_fee', 'platform_fee', 'network_fee', 'operating_allowance']);
export type FinancialCategory = z.infer<typeof FinancialCategorySchema>;
export const FinancialActionKindSchema = z.enum(['accept_offer', 'reserve_capacity', 'activate_commitment', 'allocate_funds', 'pay_supplier', 'withdraw_unused', 'purchase_tool']);
export const AuthorityModeSchema = z.enum(['ADVISE', 'PREPARE_FOR_APPROVAL', 'ACT_WITHIN_MANDATE', 'SHADOW']);
export const AuthorityBindingSchema = z.strictObject({
  organizationId: IdSchema, environment: EnvironmentSchema,
  organizationEpoch: epoch, mandateId: IdSchema, mandateVersion: version, mandateEpoch: epoch,
});
export type AuthorityBinding = z.infer<typeof AuthorityBindingSchema>;
export const BudgetLimitSchema = z.strictObject({
  assetId: IdSchema, category: FinancialCategorySchema, perOperation: BaseUnitsSchema,
  perResponsibility: BaseUnitsSchema, periodMaximum: BaseUnitsSchema,
  periodStartsAt: InstantSchema, periodEndsAt: InstantSchema,
});
export type BudgetLimit = z.infer<typeof BudgetLimitSchema>;
export const MandatePolicySchema = z.strictObject({
  mode: AuthorityModeSchema, siteIds: z.array(IdSchema).min(1).max(100),
  supplierRelationshipIds: z.array(IdSchema).max(1000), actions: z.array(FinancialActionKindSchema).max(20),
  budgets: z.array(BudgetLimitSchema).max(100), acceptancePolicy: VersionReferenceSchema,
  communication: z.strictObject({ recipientIds: z.array(IdSchema).max(1000),
    purposes: z.array(z.string().min(1).max(100)).max(30), messageKinds: z.array(z.string().min(1).max(100)).max(30),
    maximumMessages: boundedCount, expiresAt: InstantSchema }),
  expiresAt: InstantSchema,
});
export type MandatePolicy = z.infer<typeof MandatePolicySchema>;
export const MandateVersionSchema = z.strictObject({
  id: IdSchema, organizationId: IdSchema, environment: EnvironmentSchema, responsibilityId: IdSchema,
  version, mandateEpoch: epoch, organizationEpoch: epoch,
  policy: MandatePolicySchema, policyHash: HashSchema, previousVersionHash: HashSchema.nullable(),
  createdAt: InstantSchema, createdBy: IdSchema,
});
export type MandateVersion = z.infer<typeof MandateVersionSchema>;
export const MandateHeadSchema = AuthorityBindingSchema.extend({
  responsibilityId: IdSchema, state: z.enum(['ACTIVE', 'PAUSED', 'REVOKED', 'EXPIRED']),
  policyHash: HashSchema, expiresAt: InstantSchema,
});
export type MandateHead = z.infer<typeof MandateHeadSchema>;

export const CommercialCostKindSchema = z.enum(['base', 'tax', 'delivery', 'installation', 'service', 'hold', 'overtime', 'cancellation', 'damage', 'return']);
export const CommercialCostSchema = z.strictObject({
  id: IdSchema, kind: CommercialCostKindSchema, state: z.enum(['QUOTED', 'NOT_APPLICABLE', 'UNKNOWN']),
  assetId: IdSchema, amountBaseUnits: BaseUnitsSchema.nullable(),
  dueTrigger: z.string().min(1).max(500), earnedTrigger: z.string().min(1).max(500),
  refundable: z.enum(['NONREFUNDABLE', 'CONDITIONAL', 'REFUNDABLE', 'UNKNOWN']), refundTerms: z.string().max(2000),
});
export const PayeeBindingSchema = z.strictObject({
  id: IdSchema, version, environment: EnvironmentSchema, network: z.string().min(1),
  recipient: z.string().min(1).max(256), assetId: IdSchema, mint: z.string().min(1), tokenProgram: z.string().min(1),
  verificationRef: IdSchema,
});
export const OfferTermsVersionSchema = z.strictObject({
  id: IdSchema, version, previousVersionHash: HashSchema.nullable(), organizationId: IdSchema, environment: EnvironmentSchema,
  supplierRelationshipId: IdSchema, source: VersionReferenceSchema, payee: PayeeBindingSchema,
  assets: z.array(AssetSchema).min(1).max(10), window: ServiceWindowSchema,
  items: z.array(z.strictObject({ id: IdSchema, specification: z.string().min(1).max(2000),
    quantityBaseUnits: BaseUnitsSchema, quantityScale: z.number().int().min(0).max(18), unit: z.string().min(1).max(48) })).min(1).max(100),
  costs: z.array(CommercialCostSchema).min(10).max(100),
  paymentSchedule: z.array(z.strictObject({ id: IdSchema, costIds: z.array(IdSchema).min(1),
    kind: z.enum(['ADVANCE', 'EARNED_HOLD', 'MILESTONE', 'FINAL']), dueTrigger: z.string().min(1).max(500) })).min(1).max(100),
  acceptancePolicy: VersionReferenceSchema, substitutionTerms: z.string().min(1).max(3000),
  disputeTerms: z.string().min(1).max(3000), expiresAt: InstantSchema,
});
export type OfferTermsVersion = z.infer<typeof OfferTermsVersionSchema>;
export const FinancialComponentSchema = z.strictObject({
  id: IdSchema, economicPortionId: IdSchema, assetId: IdSchema, category: FinancialCategorySchema, amountBaseUnits: BaseUnitsSchema,
});
export type FinancialComponent = z.infer<typeof FinancialComponentSchema>;
export const CustomerReturnDestinationSchema = PayeeBindingSchema.extend({
  organizationId: IdSchema, purpose: z.literal('CUSTOMER_RETURN'),
});
export const WithdrawalBindingSchema = z.strictObject({
  destination: CustomerReturnDestinationSchema, amountBaseUnits: BaseUnitsSchema, policy: VersionReferenceSchema,
});
export type WithdrawalBinding = z.infer<typeof WithdrawalBindingSchema>;
export const ToolPurchaseBindingSchema = z.strictObject({
  providerId: IdSchema, resource: VersionReferenceSchema, request: VersionReferenceSchema,
  challenge: z.strictObject({
    id: IdSchema, hash: HashSchema, providerId: IdSchema, resourceHash: HashSchema, requestHash: HashSchema,
    payee: PayeeBindingSchema, amountBaseUnits: BaseUnitsSchema, expiresAt: InstantSchema,
  }),
  allowlistPolicy: VersionReferenceSchema, deliveryPolicy: VersionReferenceSchema,
});
export type ToolPurchaseBinding = z.infer<typeof ToolPurchaseBindingSchema>;
export const ActionBindingSchema = z.strictObject({
  schemaVersion: z.literal(1), kind: FinancialActionKindSchema, responsibilityId: IdSchema, authority: AuthorityBindingSchema,
  siteId: IdSchema, supplierRelationshipId: IdSchema.nullable(),
  terms: VersionReferenceSchema.nullable(), payee: PayeeBindingSchema.nullable(),
  withdrawal: WithdrawalBindingSchema.nullable(), toolPurchase: ToolPurchaseBindingSchema.nullable(),
  assets: z.array(AssetSchema).min(1).max(10), components: z.array(FinancialComponentSchema).min(1).max(100),
  expiresAt: InstantSchema, nonce: IdSchema,
});
export type ActionBinding = z.infer<typeof ActionBindingSchema>;
export const FinancialApprovalRoleSchema = z.enum(['owner', 'finance', 'operations']);
export const ApprovalPolicySchema = z.strictObject({
  reference: VersionReferenceSchema, organizationId: IdSchema, environment: EnvironmentSchema,
  eligibleRoles: z.array(FinancialApprovalRoleSchema).min(1), independentApprover: z.literal(true),
  maximumStepUpAgeMs: z.number().int().positive().max(900_000), maximumApprovalAgeMs: z.number().int().positive().max(900_000),
  expiresAt: InstantSchema,
});
export type ApprovalPolicy = z.infer<typeof ApprovalPolicySchema>;
// Trusted server-side identity evidence, never an accepted browser command payload.
// This schema validates shape; it does not verify identity-provider cryptography.
export const StepUpEvidenceSchema = z.strictObject({
  id: IdSchema, actorId: IdSchema, sessionId: z.string().min(1).max(256),
  method: z.enum(['MFA', 'PASSKEY']), verifiedAt: InstantSchema, expiresAt: InstantSchema, providerProofRef: IdSchema,
});
export type StepUpEvidence = z.infer<typeof StepUpEvidenceSchema>;
export const ApprovalReceiptSchema = z.strictObject({
  id: IdSchema, actionHash: HashSchema, authority: AuthorityBindingSchema, policy: VersionReferenceSchema,
  requesterId: IdSchema, approverId: IdSchema, approverSessionId: z.string().min(1).max(256),
  stepUpEvidenceId: IdSchema, stepUpVerifiedAt: InstantSchema, stepUpExpiresAt: InstantSchema,
  approvedAt: InstantSchema, expiresAt: InstantSchema,
});
export type ApprovalReceipt = z.infer<typeof ApprovalReceiptSchema>;
export const EconomicIntentSchema = z.strictObject({
  id: IdSchema, economicKey: HashSchema, paymentAuthorizationId: IdSchema, action: ActionBindingSchema, actionHash: HashSchema,
  approvalId: IdSchema, state: z.enum(['PREPARED', 'AUTHORIZED', 'SUBMITTED', 'CONFIRMED', 'FINALIZED', 'RECONCILED', 'OUTCOME_UNKNOWN', 'REJECTED', 'FAILED', 'EXPIRED']),
  createdAt: InstantSchema,
});
export type EconomicIntent = z.infer<typeof EconomicIntentSchema>;
export const ExposureSchema = FinancialComponentSchema.extend({
  responsibilityId: IdSchema, kind: z.enum(['ALLOCATION', 'UNALLOCATED_OBLIGATION', 'OUTGOING']),
  state: z.enum(['HELD', 'OUTCOME_UNKNOWN', 'PAID', 'RELEASED']), paidAt: InstantSchema.nullable(),
});
export type Exposure = z.infer<typeof ExposureSchema>;
export const BudgetSnapshotSchema = z.strictObject({
  organizationId: IdSchema, environment: EnvironmentSchema, version,
  asset: AssetSchema, verifiedSpendableBaseUnits: BaseUnitsSchema, verifiedAt: InstantSchema,
  expectedRefundBaseUnits: BaseUnitsSchema, exposures: z.array(ExposureSchema).max(10_000),
  spend: z.array(z.strictObject({ responsibilityId: IdSchema, category: FinancialCategorySchema,
    lifetimeBaseUnits: BaseUnitsSchema, periodBaseUnits: BaseUnitsSchema, periodStartsAt: InstantSchema, periodEndsAt: InstantSchema })).max(10_000),
});
export type BudgetSnapshot = z.infer<typeof BudgetSnapshotSchema>;
export const LedgerAccountSchema = z.strictObject({
  id: IdSchema, organizationId: IdSchema, environment: EnvironmentSchema, assetId: IdSchema,
  kind: z.enum(['VAULT_ASSET', 'CUSTOMER_AVAILABLE', 'CUSTOMER_ALLOCATED', 'SUPPLIER_LIABILITY', 'PLATFORM_PAYABLE', 'NETWORK_EXPENSE', 'OPERATING_ALLOWANCE', 'EXPECTED_REFUND']),
});
export type LedgerAccount = z.infer<typeof LedgerAccountSchema>;
export const JournalEntrySchema = z.strictObject({
  id: IdSchema, organizationId: IdSchema, environment: EnvironmentSchema, economicEventKey: IdSchema,
  operationId: IdSchema, postedAt: InstantSchema, sourceEvidenceRefs: z.array(IdSchema).min(1), correctionOf: IdSchema.nullable(),
  lines: z.array(z.strictObject({ id: IdSchema, accountId: IdSchema, assetId: IdSchema,
    direction: z.enum(['DEBIT', 'CREDIT']), amountBaseUnits: BaseUnitsSchema })).min(2).max(1000),
});
export type JournalEntry = z.infer<typeof JournalEntrySchema>;
