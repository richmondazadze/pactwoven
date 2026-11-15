import { z } from 'zod';
import { EnvironmentSchema, IdSchema, IdempotencyKeySchema, RoleSchema } from './core';
import { HashSchema } from './financial';
import { FINANCE_DEVNET_ASSET, SolanaPublicKeySchema } from './finance-provenance';
import { RegistryPinSchema } from './financial-fences';
import { FinancialPolicyVersionSchema, FinancialPolicyGenerationSchema, FinancialPolicyUuidSchema,
  FinancialPolicyInstantSchema, FinancialPolicyRefSchema, FinancialPolicyTextSchema, FinancialPolicyDocumentPurposeSchema,
  FinancialGovernanceBundleSchema, FinancialGovernanceControlRefSchema, FinancialBudgetPeriodSchema,
  FinancialPolicyBlockerSchema, FinancialDraftScopeSchema } from './financial-policies';
import { FinancialPolicyHttpAuthorityBasisSchema, FinancialPolicyHttpDraftSchema, FinancialPolicyHttpKindSchema,
  FinancialPolicyHttpRouteIdentitySchema } from './financial-policy-http';

// Wire data only: parsing never authenticates a caller or authorizes a future submit.
export const FINANCIAL_POLICY_HTTP_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
const sorted = <T extends z.ZodType>(schema: T, maximum: number) => z.array(schema).max(maximum)
  .refine(v => v.every((x, i) => i === 0 || String(v[i - 1]) < String(x)), 'Sorted unique values required.');
const sameRef = (a: z.infer<typeof FinancialPolicyRefSchema> | null, b: z.infer<typeof FinancialPolicyRefSchema> | null) =>
  a === null || b === null ? a === b : a.id === b.id && a.version === b.version && a.recordHash === b.recordHash;
const issue = (c: z.RefinementCtx, message: string) => c.addIssue({ code: 'custom', message });
const withinBytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).byteLength <= FINANCIAL_POLICY_HTTP_RESPONSE_MAX_BYTES;
const configurationOnly = { effectiveAuthority: z.literal(false), financialState: z.null() };

export const FinancialPolicyHttpActorSchema = z.strictObject({ actorId: IdSchema, membershipVersion: FinancialPolicyVersionSchema });
export const FinancialPolicyHttpScopeSchema = z.strictObject({ environment: EnvironmentSchema, organizationId: IdSchema,
  actor: FinancialPolicyHttpActorSchema, organizationEpoch: FinancialPolicyGenerationSchema,
  roles: sorted(RoleSchema, 9).refine(v => v.length > 0 && v.some(r => ['owner', 'finance', 'operations'].includes(r))),
  siteIds: sorted(IdSchema, 100), actionSiteIds: sorted(IdSchema, 100) });
export const FinancialPolicyHttpObservationSchema = z.strictObject({ observedAt: FinancialPolicyInstantSchema, expiresAt: FinancialPolicyInstantSchema })
  .refine(v => v.observedAt < v.expiresAt && Date.parse(v.expiresAt) <= Date.parse(v.observedAt) + 20_000, 'A bounded observation is required.');
const envelope = { schemaVersion: z.literal(1), scope: FinancialPolicyHttpScopeSchema,
  observation: FinancialPolicyHttpObservationSchema, ...configurationOnly };
const record = { schemaVersion: z.literal(1), environment: EnvironmentSchema, organizationId: IdSchema,
  id: IdSchema, version: FinancialPolicyVersionSchema, predecessor: FinancialPolicyRefSchema.nullable(),
  actor: FinancialPolicyHttpActorSchema, organizationEpoch: FinancialPolicyGenerationSchema,
  operationId: FinancialPolicyUuidSchema, createdAt: FinancialPolicyInstantSchema };
function predecessor(v: { id: string; version: number; predecessor: z.infer<typeof FinancialPolicyRefSchema> | null }, c: z.RefinementCtx) {
  if ((v.version === 1) !== (v.predecessor === null) || v.predecessor !== null &&
    (v.predecessor.id !== v.id || v.predecessor.version + 1 !== v.version)) issue(c, 'The exact contiguous predecessor is required.');
}
export const FinancialPolicyHttpDocumentSchema = z.strictObject({ ...record, kind: z.literal('document'), responsibilityId: IdSchema.nullable(),
  purpose: FinancialPolicyDocumentPurposeSchema, text: FinancialPolicyTextSchema, contentHash: HashSchema }).superRefine((v, c) => {
  predecessor(v, c);
  if ((v.purpose === 'financial_mandate') !== (v.responsibilityId !== null)) issue(c, 'Document purpose and scope must agree.');
});
export const FinancialPolicyHttpDraftRecordSchema = z.strictObject({ ...record, kind: z.literal('draft'), responsibilityId: IdSchema,
  state: z.enum(['DRAFT', 'WITHDRAWN']), requester: FinancialPolicyHttpActorSchema, draft: FinancialPolicyHttpDraftSchema }).superRefine((v, c) => {
  predecessor(v, c);
  if (v.version === 1 && v.state !== 'DRAFT') issue(c, 'An initial draft must be DRAFT.');
  if (v.draft.scope.authority.responsibility.id !== v.responsibilityId || v.requester.actorId !== v.actor.actorId ||
    v.state === 'DRAFT' && v.requester.membershipVersion !== v.actor.membershipVersion) issue(c, 'Exact draft actor and responsibility required.');
});
export const FinancialPolicyHttpGovernanceRecordSchema = z.strictObject({ ...record, kind: z.literal('governance'), responsibilityId: z.null(),
  state: z.enum(['OPEN', 'ACCEPTED', 'REJECTED']), proposer: FinancialPolicyHttpActorSchema,
  bundle: FinancialGovernanceBundleSchema, expectedControl: FinancialGovernanceControlRefSchema,
  expiresAt: FinancialPolicyInstantSchema }).superRefine((v, c) => {
  predecessor(v, c);
  if (v.version === 1 && v.state !== 'OPEN') issue(c, 'An initial governance record must be OPEN.');
  if (v.bundle.budgetAccountId !== v.expectedControl.budgetAccountId || v.state !== 'REJECTED' && v.createdAt >= v.expiresAt ||
    v.state === 'OPEN' && (v.proposer.actorId !== v.actor.actorId || v.proposer.membershipVersion !== v.actor.membershipVersion) ||
    v.state === 'ACCEPTED' && v.proposer.actorId === v.actor.actorId) issue(c, 'Exact configuration state and actors required.');
});
export const FinancialPolicyHttpRecordSchema = z.discriminatedUnion('kind', [FinancialPolicyHttpDocumentSchema,
  FinancialPolicyHttpDraftRecordSchema, FinancialPolicyHttpGovernanceRecordSchema]);
export const FinancialPolicyHttpProjectionSchema = z.strictObject({ currentRecord: z.boolean(),
  state: z.enum(['DOCUMENT', 'DRAFT', 'WITHDRAWN', 'OPEN', 'ACCEPTED', 'REJECTED', 'SUPERSEDED', 'EXPIRED']),
  blockers: sorted(FinancialPolicyBlockerSchema, 16) });
export const FinancialPolicyHttpBudgetObservationSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('observed'), control: FinancialGovernanceControlRefSchema, currentBudgetConfiguration: z.boolean() }),
  z.strictObject({ status: z.literal('unavailable'), control: z.null(), currentBudgetConfiguration: z.null() }),
]);
const view = { reference: FinancialPolicyRefSchema, projection: FinancialPolicyHttpProjectionSchema };
function checkView(v: { reference: z.infer<typeof FinancialPolicyRefSchema>; record: z.infer<typeof FinancialPolicyHttpRecordSchema>;
  projection: z.infer<typeof FinancialPolicyHttpProjectionSchema> }, c: z.RefinementCtx) {
  const { record: r, projection: p } = v;
  if (v.reference.id !== r.id || v.reference.version !== r.version) issue(c, 'Original reference and record identity must match.');
  const states = r.kind === 'document' ? ['DOCUMENT'] : r.state === 'DRAFT' || r.state === 'OPEN' ? [r.state, 'EXPIRED'] : [r.state];
  if (p.currentRecord ? !states.includes(p.state) : p.state !== 'SUPERSEDED') issue(c, 'Observed currentness and state must agree.');
  if (r.kind === 'draft' && (!p.blockers.includes('TRUST_UNAVAILABLE') || !p.blockers.includes('FINANCIAL_AUTHORITY_UNAVAILABLE') ||
    r.state === 'WITHDRAWN' && !p.blockers.includes('DRAFT_WITHDRAWN') || p.state === 'EXPIRED' && !p.blockers.includes('DRAFT_EXPIRED')))
    issue(c, 'Draft blockers must preserve configuration-only and terminal state.');
}
export const FinancialPolicyHttpDocumentViewSchema = z.strictObject({ ...view, record: FinancialPolicyHttpDocumentSchema, budgetConfiguration: z.null() }).superRefine(checkView);
export const FinancialPolicyHttpDraftViewSchema = z.strictObject({ ...view, record: FinancialPolicyHttpDraftRecordSchema, budgetConfiguration: z.null() }).superRefine(checkView);
export const FinancialPolicyHttpGovernanceViewSchema = z.strictObject({ ...view, record: FinancialPolicyHttpGovernanceRecordSchema,
  budgetConfiguration: FinancialPolicyHttpBudgetObservationSchema }).superRefine((v, c) => {
  checkView(v, c); const b = v.budgetConfiguration;
  if (b.status === 'observed' && (b.control.budgetAccountId !== v.record.bundle.budgetAccountId ||
    b.currentBudgetConfiguration !== sameRef(b.control.accepted, v.reference) ||
    b.currentBudgetConfiguration && (v.record.state !== 'ACCEPTED' || !v.projection.currentRecord) ||
    v.record.state === 'OPEN' && (b.control.generation !== v.record.expectedControl.generation ||
      !sameRef(b.control.accepted, v.record.expectedControl.accepted)) && (v.projection.currentRecord || v.projection.state !== 'SUPERSEDED')))
    issue(c, 'Observed budget control and record currentness must remain distinct and consistent.');
});
export const FinancialPolicyHttpPolicyViewSchema = z.union([FinancialPolicyHttpDocumentViewSchema,
  FinancialPolicyHttpDraftViewSchema, FinancialPolicyHttpGovernanceViewSchema]);

export const FinancialPolicyHttpActionReasonSchema = z.enum([...FinancialPolicyBlockerSchema.options,
  'ROLE_REQUIRED', 'SITE_ACCESS_REQUIRED', 'ORIGINAL_ACTOR_REQUIRED', 'CURRENT_RECORD_REQUIRED', 'OBSERVATION_EXPIRED',
  'PROPOSER_OBSERVATION_UNAVAILABLE', 'INDEPENDENCE_UNQUALIFIED', 'PUBLIC_ROUTE_UNSUPPORTED', 'SERVICE_UNAVAILABLE', 'ELIGIBILITY_NOT_EVALUATED']);
export const FinancialPolicyHttpActionDecisionSchema = z.strictObject({
  action: z.enum([...FinancialPolicyHttpKindSchema.options, 'refresh_proposer_observation']),
  state: z.enum(['reviewable', 'blocked', 'not_evaluated']), reasons: sorted(FinancialPolicyHttpActionReasonSchema, 24),
  requiredAuthentication: z.literal('financial_policy_authorization').nullable(),
}).superRefine((v, c) => {
  if ((v.action === 'accept_governance') !== (v.requiredAuthentication === 'financial_policy_authorization') ||
    v.state === 'reviewable' && v.reasons.length !== 0 || v.state === 'blocked' && v.reasons.length === 0 ||
    v.state === 'not_evaluated' && (v.reasons.length !== 1 || v.reasons[0] !== 'ELIGIBILITY_NOT_EVALUATED')) issue(c, 'Action state and required authentication must agree.');
});
const actions = z.array(FinancialPolicyHttpActionDecisionSchema).max(7).refine(v => v.every((x, i) => i === 0 || v[i - 1]!.action < x.action));
export const FinancialPolicyHttpAssetContextSchema = z.strictObject({ pin: RegistryPinSchema,
  genesis: SolanaPublicKeySchema, tokenProgram: SolanaPublicKeySchema, mint: SolanaPublicKeySchema,
  decimals: z.literal(6), policy: z.literal('solana-original-devnet-usdc-v1') }).refine(v =>
  v.genesis === FINANCE_DEVNET_ASSET.genesis && v.tokenProgram === FINANCE_DEVNET_ASSET.tokenProgram && v.mint === FINANCE_DEVNET_ASSET.mint,
  'Exact supported physical asset required.');
const contextMaterial = { asset: FinancialPolicyHttpAssetContextSchema.nullable(), control: FinancialGovernanceControlRefSchema.nullable(),
  acceptedConfiguration: FinancialPolicyHttpGovernanceViewSchema.nullable(), periods: z.array(FinancialBudgetPeriodSchema).max(50),
  documents: z.array(FinancialPolicyHttpDocumentViewSchema).max(8), blockers: sorted(FinancialPolicyBlockerSchema, 16), actions };
const draftScope = z.strictObject({ authority: FinancialPolicyHttpAuthorityBasisSchema, authorityHash: HashSchema, site: FinancialDraftScopeSchema.shape.site });
const organizationContext = z.strictObject({ ...envelope, ...contextMaterial, kind: z.literal('organization'), responsibilityId: z.null(),
  configurationVisibility: z.literal('full'), draftScope: z.null() });
const responsibilityContext = z.strictObject({ ...envelope, ...contextMaterial, kind: z.literal('responsibility'), responsibilityId: IdSchema,
  configurationVisibility: z.enum(['full', 'references_only']), draftScope });
type Scope = z.infer<typeof FinancialPolicyHttpScopeSchema>;
const reviewer = (s: Scope) => s.roles.some(r => r === 'owner' || r === 'finance');
const inScope = (r: z.infer<typeof FinancialPolicyHttpRecordSchema>, s: Scope, rid: string | null) =>
  r.environment === s.environment && r.organizationId === s.organizationId && r.responsibilityId === rid;
function checkContext(v: z.infer<typeof organizationContext> | z.infer<typeof responsibilityContext>, c: z.RefinementCtx) {
  const full = reviewer(v.scope);
  if ((v.configurationVisibility === 'full') !== full || v.kind === 'organization' && !full ||
    !full && (v.acceptedConfiguration !== null || v.periods.length !== 0 || v.documents.some(d => d.record.purpose !== 'financial_mandate')))
    issue(c, 'Current scope must match disclosure visibility.');
  if (v.draftScope && (v.draftScope.authority.responsibility.id !== v.responsibilityId ||
    v.draftScope.site.id !== v.draftScope.authority.responsibility.siteId || !v.scope.siteIds.includes(v.draftScope.site.id) ||
    !v.scope.actionSiteIds.includes(v.draftScope.site.id))) issue(c, 'Exact responsibility and explicit sites required.');
  if (!v.blockers.includes('TRUST_UNAVAILABLE') || !v.blockers.includes('FINANCIAL_AUTHORITY_UNAVAILABLE') ||
    (v.control?.accepted == null) !== v.blockers.includes('GOVERNANCE_MISSING')) issue(c, 'Configuration blockers must preserve actual absence and unavailable authority.');
  if (v.asset === null ? v.control !== null || v.acceptedConfiguration !== null || v.periods.length !== 0 ||
    v.blockers.filter(b => b === 'ASSET_MISSING' || b === 'ASSET_CHANGED').length !== 1 :
    v.control === null || v.blockers.some(b => b === 'ASSET_MISSING' || b === 'ASSET_CHANGED')) issue(c, 'Asset and budget context must agree.');
  if (full && (v.control?.accepted == null) !== (v.acceptedConfiguration === null)) issue(c, 'Full accepted configuration must match its reference.');
  if (v.acceptedConfiguration) { const a = v.acceptedConfiguration;
    if (!inScope(a.record, v.scope, null) || a.record.state !== 'ACCEPTED' || !sameRef(a.reference, v.control?.accepted ?? null) ||
      a.record.bundle.asset.key !== v.asset?.pin.key || a.budgetConfiguration.status !== 'observed' ||
      !a.budgetConfiguration.currentBudgetConfiguration || a.budgetConfiguration.control.generation !== v.control?.generation ||
      a.budgetConfiguration.control.budgetAccountId !== v.control?.budgetAccountId || !v.periods.some(p =>
        p.id === a.record.bundle.period.id && p.startsAt === a.record.bundle.period.startsAt && p.endsAt === a.record.bundle.period.endsAt))
      issue(c, 'Accepted configuration must identify the observed current budget and fixed period.');
  }
  if (new Set(v.periods.map(p => p.id)).size !== v.periods.length || v.periods.some((p, i) => i > 0 && v.periods[i - 1]!.endsAt > p.startsAt))
    issue(c, 'Fixed periods must be ordered without overlap or duplicate identities.');
  if (v.documents.some((d, i) => !inScope(d.record, v.scope, d.record.purpose === 'financial_mandate' ? v.responsibilityId : null) ||
    d.record.purpose === 'financial_mandate' && v.responsibilityId === null || i > 0 && v.documents[i - 1]!.record.id >= d.record.id))
    issue(c, 'Exact sorted scoped documents required.');
  if (!withinBytes(v)) issue(c, 'Bounded response required.');
}
export const FinancialPolicyHttpOrganizationContextSchema = organizationContext.superRefine(checkContext);
export const FinancialPolicyHttpResponsibilityContextSchema = responsibilityContext.superRefine(checkContext);
export const FinancialPolicyHttpContextSchema = z.discriminatedUnion('kind', [FinancialPolicyHttpOrganizationContextSchema, FinancialPolicyHttpResponsibilityContextSchema]);

export const FinancialPolicyHttpRecordResponseSchema = z.strictObject({ ...envelope, responsibilityId: IdSchema.nullable(),
  policy: FinancialPolicyHttpPolicyViewSchema, documents: z.array(FinancialPolicyHttpDocumentViewSchema).max(2), actions }).superRefine((v, c) => {
  const r = v.policy.record;
  if (!inScope(r, v.scope, v.responsibilityId) || v.responsibilityId === null && !reviewer(v.scope)) issue(c, 'Current exact read scope required.');
  const refs = r.kind === 'document' ? [] : r.kind === 'draft' ? r.draft.documents : r.bundle.documents;
  if (refs.length !== v.documents.length || refs.some((ref, i) => { const d = v.documents[i];
    return !d || !sameRef(ref, d.reference) || d.record.purpose !== ref.purpose || !inScope(d.record, v.scope, ref.purpose === 'financial_mandate' ? v.responsibilityId : null);
  })) issue(c, 'Every exact referenced full document must be present.');
  if (!withinBytes(v)) issue(c, 'Bounded response required.');
});
const collectionItem = z.strictObject({ policy: FinancialPolicyHttpPolicyViewSchema, actions });
const indexFields = { ...envelope, items: z.array(collectionItem).max(50), nextId: IdSchema.nullable() };
const draftIndex = z.strictObject({ ...indexFields, kind: z.literal('responsibility'), responsibilityId: IdSchema });
const governanceIndex = z.strictObject({ ...indexFields, kind: z.literal('organization'), responsibilityId: z.null() });
function checkIndex(v: z.infer<typeof draftIndex> | z.infer<typeof governanceIndex>, c: z.RefinementCtx) {
  if (v.kind === 'organization' && !reviewer(v.scope)) issue(c, 'Current governance reviewer required.');
  if (v.items.some(({ policy: p }, i) => !inScope(p.record, v.scope, v.responsibilityId) || i > 0 && v.items[i - 1]!.policy.record.id >= p.record.id ||
    (v.kind === 'responsibility' ? p.record.kind !== 'draft' || !p.projection.currentRecord : p.record.kind !== 'governance' || p.budgetConfiguration?.status !== 'observed')))
    issue(c, 'Sorted scoped collection records required.');
  if (v.nextId !== null && (v.items.length === 0 || v.nextId !== v.items.at(-1)!.policy.record.id)) issue(c, 'Cursor must name the last returned record.');
  if (!withinBytes(v)) issue(c, 'Bounded response required.');
}
export const FinancialPolicyHttpDraftIndexResponseSchema = draftIndex.superRefine(checkIndex);
export const FinancialPolicyHttpGovernanceIndexResponseSchema = governanceIndex.superRefine(checkIndex);

export const FinancialPolicyHttpReceiptSchema = z.strictObject({ schemaVersion: z.literal(1), environment: EnvironmentSchema, organizationId: IdSchema,
  actor: FinancialPolicyHttpActorSchema, responsibilityId: IdSchema.nullable(), operationId: FinancialPolicyUuidSchema,
  kind: FinancialPolicyHttpKindSchema, key: IdempotencyKeySchema, publicRequestHash: HashSchema,
  target: FinancialPolicyRefSchema, record: FinancialPolicyHttpRecordSchema, ...configurationOnly }).superRefine((v, c) => {
  const r = v.record;
  const valid = v.kind === 'save_document' ? r.kind === 'document' : v.kind === 'save_draft' || v.kind === 'withdraw_draft' ?
    r.kind === 'draft' && r.state === (v.kind === 'save_draft' ? 'DRAFT' : 'WITHDRAWN') :
    r.kind === 'governance' && r.state === (v.kind === 'propose_governance' ? 'OPEN' : v.kind === 'accept_governance' ? 'ACCEPTED' : 'REJECTED');
  if (!valid || r.environment !== v.environment || r.organizationId !== v.organizationId || r.responsibilityId !== v.responsibilityId ||
    r.actor.actorId !== v.actor.actorId || r.actor.membershipVersion !== v.actor.membershipVersion || r.operationId !== v.operationId ||
    r.id !== v.target.id || r.version !== v.target.version) issue(c, 'Exact immutable receipt identity and outcome required.');
  if (!FinancialPolicyHttpRouteIdentitySchema.safeParse({ kind: v.kind, responsibilityId: v.responsibilityId, id: v.target.id }).success)
    issue(c, 'Receipt requires a supported exact public request route.');
  if (!withinBytes(v)) issue(c, 'Bounded response required.');
});
const receiptScope = (r: z.infer<typeof FinancialPolicyHttpReceiptSchema>, s: Scope) =>
  r.environment === s.environment && r.organizationId === s.organizationId && r.actor.actorId === s.actor.actorId;
export const FinancialPolicyHttpMutationResponseSchema = z.strictObject({ ...envelope, status: z.literal('recorded'), receipt: FinancialPolicyHttpReceiptSchema })
  .refine(v => receiptScope(v.receipt, v.scope) && (v.receipt.responsibilityId !== null || reviewer(v.scope)) && withinBytes(v),
    'Receipt must belong to the current original actor and permitted disclosure scope.');
const locator = { responsibilityId: IdSchema.nullable(), kind: FinancialPolicyHttpKindSchema, key: IdempotencyKeySchema, targetId: IdSchema, publicRequestHash: HashSchema };
export const FinancialPolicyHttpRecoveryLocatorSchema = z.strictObject(locator).refine(v =>
  FinancialPolicyHttpRouteIdentitySchema.safeParse({ kind: v.kind, responsibilityId: v.responsibilityId, id: v.targetId }).success, 'Exact supported original scope required.');
export const FinancialPolicyHttpRecoveryResponseSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...envelope, ...locator, status: z.literal('recorded'), receipt: FinancialPolicyHttpReceiptSchema }),
  z.strictObject({ ...envelope, ...locator, status: z.literal('not_recorded'), receipt: z.null() }),
]).superRefine((v, c) => {
  if (!FinancialPolicyHttpRecoveryLocatorSchema.safeParse({ responsibilityId: v.responsibilityId, kind: v.kind, key: v.key, targetId: v.targetId, publicRequestHash: v.publicRequestHash }).success ||
    v.responsibilityId === null && !reviewer(v.scope)) issue(c, 'Exact original lookup scope required.');
  if (v.status === 'recorded' && (!receiptScope(v.receipt, v.scope) || v.receipt.responsibilityId !== v.responsibilityId ||
    v.receipt.kind !== v.kind || v.receipt.key !== v.key || v.receipt.target.id !== v.targetId || v.receipt.publicRequestHash !== v.publicRequestHash))
    issue(c, 'Recovered receipt must match the exact original locator.');
  if (!withinBytes(v)) issue(c, 'Bounded response required.');
});
export const FinancialPolicyHttpProposerObservationResponseSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...envelope, proposal: FinancialPolicyRefSchema, control: FinancialGovernanceControlRefSchema, status: z.literal('available'), expiresAt: FinancialPolicyInstantSchema }),
  z.strictObject({ ...envelope, proposal: FinancialPolicyRefSchema, control: FinancialGovernanceControlRefSchema, status: z.literal('unavailable'), expiresAt: z.null() }),
]).refine(v => reviewer(v.scope) && (v.status === 'unavailable' || v.expiresAt > v.observation.observedAt && v.expiresAt <= v.observation.expiresAt) && withinBytes(v),
  'Current reviewer and bounded genuine observation required.');

export type FinancialPolicyHttpActor = z.infer<typeof FinancialPolicyHttpActorSchema>;
export type FinancialPolicyHttpScope = z.infer<typeof FinancialPolicyHttpScopeSchema>;
export type FinancialPolicyHttpObservation = z.infer<typeof FinancialPolicyHttpObservationSchema>;
export type FinancialPolicyHttpDocument = z.infer<typeof FinancialPolicyHttpDocumentSchema>;
export type FinancialPolicyHttpDraftRecord = z.infer<typeof FinancialPolicyHttpDraftRecordSchema>;
export type FinancialPolicyHttpGovernanceRecord = z.infer<typeof FinancialPolicyHttpGovernanceRecordSchema>;
export type FinancialPolicyHttpRecord = z.infer<typeof FinancialPolicyHttpRecordSchema>;
export type FinancialPolicyHttpProjection = z.infer<typeof FinancialPolicyHttpProjectionSchema>;
export type FinancialPolicyHttpBudgetObservation = z.infer<typeof FinancialPolicyHttpBudgetObservationSchema>;
export type FinancialPolicyHttpDocumentView = z.infer<typeof FinancialPolicyHttpDocumentViewSchema>;
export type FinancialPolicyHttpDraftView = z.infer<typeof FinancialPolicyHttpDraftViewSchema>;
export type FinancialPolicyHttpGovernanceView = z.infer<typeof FinancialPolicyHttpGovernanceViewSchema>;
export type FinancialPolicyHttpPolicyView = z.infer<typeof FinancialPolicyHttpPolicyViewSchema>;
export type FinancialPolicyHttpActionDecision = z.infer<typeof FinancialPolicyHttpActionDecisionSchema>;
export type FinancialPolicyHttpAssetContext = z.infer<typeof FinancialPolicyHttpAssetContextSchema>;
export type FinancialPolicyHttpContext = z.infer<typeof FinancialPolicyHttpContextSchema>;
export type FinancialPolicyHttpOrganizationContext = z.infer<typeof FinancialPolicyHttpOrganizationContextSchema>;
export type FinancialPolicyHttpResponsibilityContext = z.infer<typeof FinancialPolicyHttpResponsibilityContextSchema>;
export type FinancialPolicyHttpRecordResponse = z.infer<typeof FinancialPolicyHttpRecordResponseSchema>;
export type FinancialPolicyHttpDraftIndexResponse = z.infer<typeof FinancialPolicyHttpDraftIndexResponseSchema>;
export type FinancialPolicyHttpGovernanceIndexResponse = z.infer<typeof FinancialPolicyHttpGovernanceIndexResponseSchema>;
export type FinancialPolicyHttpReceipt = z.infer<typeof FinancialPolicyHttpReceiptSchema>;
export type FinancialPolicyHttpMutationResponse = z.infer<typeof FinancialPolicyHttpMutationResponseSchema>;
export type FinancialPolicyHttpRecoveryLocator = z.infer<typeof FinancialPolicyHttpRecoveryLocatorSchema>;
export type FinancialPolicyHttpRecoveryResponse = z.infer<typeof FinancialPolicyHttpRecoveryResponseSchema>;
export type FinancialPolicyHttpProposerObservationResponse = z.infer<typeof FinancialPolicyHttpProposerObservationResponseSchema>;
