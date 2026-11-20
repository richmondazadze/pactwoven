import { z } from 'zod';
import { IdSchema } from './core';
import { HashSchema } from './financial';
import { FinancialPolicyRefSchema, FinancialPolicyDocumentPurposeSchema, FinancialPolicyGenerationSchema,
  FinancialPolicyBlockerSchema, FinancialGovernanceControlRefSchema, FinancialBudgetPeriodSchema } from './financial-policies';
import { FinancialPolicyHttpDraftSchema, FinancialPolicyHttpRouteIdentitySchema } from './financial-policy-http';
import { FinancialPolicyHttpScopeSchema, FinancialPolicyHttpObservationSchema, FinancialPolicyHttpPolicyViewSchema,
  FinancialPolicyHttpDocumentViewSchema, FinancialPolicyHttpGovernanceViewSchema, FinancialPolicyHttpAssetContextSchema,
  FINANCIAL_POLICY_HTTP_RESPONSE_MAX_BYTES, type FinancialPolicyHttpDocumentView, type FinancialPolicyHttpScope } from './financial-policy-responses';

// Public wire consistency only. These parsers do not authenticate observations,
// evaluate private original-person predicates, or authorize a future mutation.
export const FINANCIAL_POLICY_PREPARATION_REQUEST_MAX_BYTES = 8 * 1024;
export const FINANCIAL_POLICY_PREPARATION_RESPONSE_MAX_BYTES = FINANCIAL_POLICY_HTTP_RESPONSE_MAX_BYTES;
const issue = (c: z.RefinementCtx, message: string) => c.addIssue({ code: 'custom', message });
const encodedWithin = (value: unknown, limit: number) => {
  try { const json = JSON.stringify(value); return json !== undefined && new TextEncoder().encode(json).byteLength <= limit; }
  catch { return false; }
};
const sorted = <T extends z.ZodType>(schema: T, limit: number) => z.array(schema).max(limit)
  .refine(v => v.every((x, i) => i === 0 || String(v[i - 1]) < String(x)), 'Sorted unique values required.');
type Ref = z.infer<typeof FinancialPolicyRefSchema>;
const sameRef = (a: Ref | null, b: Ref | null) => a === null || b === null ? a === b :
  a.id === b.id && a.version === b.version && a.recordHash === b.recordHash;
const requestBase = { schemaVersion: z.literal(1), targetId: IdSchema, previous: FinancialPolicyRefSchema.nullable() };
const documentRequest = z.strictObject({ ...requestBase, action: z.literal('save_document'), purpose: FinancialPolicyDocumentPurposeSchema });
const draftRequest = z.strictObject({ ...requestBase, action: z.literal('save_draft'), document: FinancialPolicyRefSchema.nullable() });
const withdrawalRequest = z.strictObject({ ...requestBase, action: z.literal('withdraw_draft'), previous: FinancialPolicyRefSchema });
const governanceRequest = z.strictObject({ ...requestBase, action: z.literal('propose_governance'), assetKey: HashSchema.nullable(),
  budgetDocument: FinancialPolicyRefSchema.nullable(), approvalDocument: FinancialPolicyRefSchema.nullable() });
const request = z.discriminatedUnion('action', [documentRequest, draftRequest, withdrawalRequest, governanceRequest]).superRefine((v, c) => {
  const rid = v.action === 'propose_governance' || v.action === 'save_document' && v.purpose !== 'financial_mandate' ? null : 'scope';
  if (!FinancialPolicyHttpRouteIdentitySchema.safeParse({ kind: v.action, id: v.targetId, responsibilityId: rid }).success ||
    v.previous !== null && v.previous.id !== v.targetId) issue(c, 'Exact supported target and predecessor required.');
  if (v.action === 'propose_governance' && v.budgetDocument !== null && v.approvalDocument !== null && v.budgetDocument.id === v.approvalDocument.id)
    issue(c, 'Budget and approval documents require distinct identities.');
});
export const FinancialPolicyPreparationRequestSchema = z.custom<unknown>(v => encodedWithin(v, FINANCIAL_POLICY_PREPARATION_REQUEST_MAX_BYTES),
  'Preparation request exceeds the encoded byte limit.').pipe(request);
export const FinancialPolicyPreparationActionSchema = z.enum(['save_document', 'save_draft', 'withdraw_draft', 'propose_governance']);
export const FinancialPolicyPreparationReasonSchema = z.enum([
  'TARGET_UNAVAILABLE', 'PREDECESSOR_CHANGED', 'DOCUMENT_REQUIRED', 'DRAFT_MATERIAL_UNSUPPORTED', 'VERSION_EXHAUSTED',
  'ROLE_REQUIRED', 'SITE_ACCESS_REQUIRED', 'ORIGINAL_ACTOR_REQUIRED', 'CURRENT_RECORD_REQUIRED', 'SCOPE_CHANGED',
  'DOCUMENT_CHANGED', 'DRAFT_WITHDRAWN', 'ASSET_MISSING', 'ASSET_CHANGED', 'GOVERNANCE_CHANGED', 'SERVICE_UNAVAILABLE', 'ELIGIBILITY_NOT_EVALUATED',
]);
const commonReasons = ['TARGET_UNAVAILABLE', 'PREDECESSOR_CHANGED', 'VERSION_EXHAUSTED', 'ORIGINAL_ACTOR_REQUIRED', 'SERVICE_UNAVAILABLE', 'ELIGIBILITY_NOT_EVALUATED'];
const reasonsByAction = {
  save_document: [...commonReasons, 'ROLE_REQUIRED', 'SITE_ACCESS_REQUIRED', 'SCOPE_CHANGED'],
  save_draft: [...commonReasons, 'SITE_ACCESS_REQUIRED', 'SCOPE_CHANGED', 'DOCUMENT_REQUIRED', 'DOCUMENT_CHANGED', 'DRAFT_MATERIAL_UNSUPPORTED', 'DRAFT_WITHDRAWN'],
  withdraw_draft: [...commonReasons, 'SITE_ACCESS_REQUIRED', 'DRAFT_WITHDRAWN'],
  propose_governance: [...commonReasons, 'ROLE_REQUIRED', 'SITE_ACCESS_REQUIRED', 'CURRENT_RECORD_REQUIRED', 'DOCUMENT_REQUIRED', 'DOCUMENT_CHANGED', 'ASSET_MISSING', 'ASSET_CHANGED', 'GOVERNANCE_CHANGED'],
} as const;
export const FinancialPolicyPreparationDecisionSchema = z.strictObject({ action: FinancialPolicyPreparationActionSchema,
  state: z.enum(['reviewable', 'blocked', 'not_evaluated']), reasons: sorted(FinancialPolicyPreparationReasonSchema, 16), requiredAuthentication: z.null(),
}).superRefine((v, c) => {
  if (v.reasons.some(reason => !(reasonsByAction[v.action] as readonly string[]).includes(reason)) ||
    v.state === 'reviewable' && v.reasons.length !== 0 || v.state === 'blocked' && (v.reasons.length === 0 || v.reasons.includes('ELIGIBILITY_NOT_EVALUATED')) ||
    v.state === 'not_evaluated' && (v.reasons.length !== 1 || v.reasons[0] !== 'ELIGIBILITY_NOT_EVALUATED')) issue(c, 'Exact action-specific decision required.');
});
const emptyDocuments = z.tuple([]);
export const FinancialPolicyPreparationTargetSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('absent'), latestReference: z.null(), record: z.null(), historicalDocuments: emptyDocuments }),
  z.strictObject({ state: z.literal('exact'), latestReference: FinancialPolicyRefSchema, record: FinancialPolicyHttpPolicyViewSchema,
    historicalDocuments: z.array(FinancialPolicyHttpDocumentViewSchema).max(2) }),
  z.strictObject({ state: z.literal('changed'), latestReference: FinancialPolicyRefSchema, record: z.null(), historicalDocuments: emptyDocuments }),
  z.strictObject({ state: z.literal('unavailable'), latestReference: z.null(), record: z.null(), historicalDocuments: emptyDocuments }),
]);
const draftScope = FinancialPolicyHttpDraftSchema.shape.scope;
const documentMaterial = z.strictObject({ action: z.literal('save_document'), purpose: FinancialPolicyDocumentPurposeSchema,
  organizationEpoch: FinancialPolicyGenerationSchema, draftScope: draftScope.nullable(), siteActive: z.boolean().nullable() });
const draftMaterial = z.strictObject({ action: z.literal('save_draft'), profile: z.literal('incomplete'), draftScope: draftScope.nullable(),
  siteActive: z.boolean().nullable(), document: FinancialPolicyHttpDocumentViewSchema.nullable(), asset: z.null(), account: z.null(), governance: z.null(), trust: z.null() });
const withdrawalMaterial = z.strictObject({ action: z.literal('withdraw_draft') });
const site = z.strictObject({ id: IdSchema, generation: FinancialPolicyGenerationSchema, recordHash: HashSchema });
const governanceMaterial = z.strictObject({ action: z.literal('propose_governance'), asset: FinancialPolicyHttpAssetContextSchema.nullable(),
  budgetAccountId: HashSchema.nullable(), control: FinancialGovernanceControlRefSchema.nullable(),
  acceptedConfiguration: FinancialPolicyHttpGovernanceViewSchema.nullable(), periods: z.array(FinancialBudgetPeriodSchema).max(50),
  budgetDocument: FinancialPolicyHttpDocumentViewSchema.nullable(), approvalDocument: FinancialPolicyHttpDocumentViewSchema.nullable(),
  eligibleActionSites: z.array(site).max(100).refine(v => v.every((s, i) => i === 0 || v[i - 1]!.id < s.id), 'Sorted unique sites required.') });
export const FinancialPolicyPreparationMaterialSchema = z.discriminatedUnion('action', [documentMaterial, draftMaterial, withdrawalMaterial, governanceMaterial]);
const response = z.strictObject({ schemaVersion: z.literal(1), scope: FinancialPolicyHttpScopeSchema, observation: FinancialPolicyHttpObservationSchema,
  responsibilityId: IdSchema.nullable(), selection: request, decision: FinancialPolicyPreparationDecisionSchema, target: FinancialPolicyPreparationTargetSchema,
  material: FinancialPolicyPreparationMaterialSchema, configurationWarnings: sorted(FinancialPolicyBlockerSchema, 16),
  effectiveAuthority: z.literal(false), financialState: z.null() });
type Response = z.infer<typeof response>;
function inScope(record: { environment: string; organizationId: string; responsibilityId: string | null }, scope: FinancialPolicyHttpScope, rid: string | null) {
  return record.environment === scope.environment && record.organizationId === scope.organizationId && record.responsibilityId === rid;
}
function checkedDocument(document: FinancialPolicyHttpDocumentView, ref: Ref, purpose: string, scope: FinancialPolicyHttpScope, rid: string | null, current: boolean) {
  return sameRef(document.reference, ref) && document.record.purpose === purpose && inScope(document.record, scope, rid) &&
    (!current || document.projection.currentRecord && document.projection.state === 'DOCUMENT');
}
function targetChecks(v: Response, c: z.RefinementCtx) {
  const { selection: s, target: t, decision: d } = v;
  const has = (reason: z.infer<typeof FinancialPolicyPreparationReasonSchema>) => d.reasons.includes(reason);
  if (has('TARGET_UNAVAILABLE') !== (t.state === 'unavailable') || has('PREDECESSOR_CHANGED') !== (t.state === 'changed') ||
    (t.state === 'changed' || t.state === 'unavailable') && d.state !== 'blocked') issue(c, 'Opaque or changed target requires its exact blocked decision.');
  if (t.state === 'absent' && s.previous !== null) issue(c, 'A missing requested predecessor cannot become creation absence.');
  if (t.state === 'changed' && (t.latestReference.id !== s.targetId || sameRef(t.latestReference, s.previous))) issue(c, 'Changed target requires a different observed reference for the same target.');
  if (t.state === 'exact') {
    const r = t.record.record;
    if (s.previous === null || !sameRef(t.latestReference, s.previous) || !sameRef(t.latestReference, t.record.reference) ||
      r.id !== s.targetId || !inScope(r, v.scope, v.responsibilityId) ||
      (s.action === 'save_document' ? r.kind !== 'document' || r.purpose !== s.purpose : s.action === 'propose_governance' ? r.kind !== 'governance' : r.kind !== 'draft'))
      issue(c, 'Exact target must match selected predecessor, kind, purpose and scope.');
    // A draft/document latest version cannot be superseded by budget-control
    // currentness. OPEN governance can be, while remaining the latest version.
    if (r.kind !== 'governance' && !t.record.projection.currentRecord) issue(c, 'Exact document/draft must be its latest record.');
    const originalActorId = r.kind === 'document' ? r.actor.actorId : r.kind === 'draft' ? r.requester.actorId : r.proposer.actorId;
    if (d.state === 'reviewable' && originalActorId !== v.scope.actor.actorId)
      issue(c, 'Reviewable revision or withdrawal requires consistent original actor identity.');
    const refs = r.kind === 'document' ? [] : r.kind === 'draft' ? r.draft.documents : r.bundle.documents;
    if (refs.length !== t.historicalDocuments.length || refs.some((ref, i) => !checkedDocument(t.historicalDocuments[i]!, ref, ref.purpose,
      v.scope, ref.purpose === 'financial_mandate' ? v.responsibilityId : null, false))) issue(c, 'Hydrate the exact historical documents, never replacement terms.');
    const exhausted = t.latestReference.version === 2_147_483_647;
    if (d.state === 'reviewable' && exhausted || has('VERSION_EXHAUSTED') && !exhausted) issue(c, 'Version exhaustion contradicts this decision.');
    if (r.kind === 'draft') {
      const withdrawn = r.state === 'WITHDRAWN';
      if (has('DRAFT_WITHDRAWN') && !withdrawn || d.state === 'reviewable' && withdrawn) issue(c, 'Terminal withdrawal cannot be prepared again.');
      const unsupported = r.draft.asset !== null || r.draft.account !== null || r.draft.governance !== null || r.draft.trust !== null;
      if (s.action === 'save_draft' && (has('DRAFT_MATERIAL_UNSUPPORTED') && !unsupported || d.state === 'reviewable' && unsupported))
        issue(c, 'Optional draft references cannot be silently removed by incomplete preparation.');
    }
    if (r.kind === 'governance' && (has('CURRENT_RECORD_REQUIRED') && r.state === 'OPEN' || d.state === 'reviewable' && r.state !== 'OPEN'))
      issue(c, 'Only raw OPEN proposals can be revised.');
  } else if (has('ORIGINAL_ACTOR_REQUIRED') || has('VERSION_EXHAUSTED') || has('DRAFT_WITHDRAWN') || has('DRAFT_MATERIAL_UNSUPPORTED') || has('CURRENT_RECORD_REQUIRED'))
    issue(c, 'Record-specific decisions require an exact observed record.');
  // Matching public actor IDs do not establish the private original-person
  // condition. The trusted server must still supply its evaluated decision.
}
function materialChecks(v: Response, c: z.RefinementCtx) {
  const { selection: s, material: m, decision: d } = v, reviewable = d.state === 'reviewable';
  const has = (reason: z.infer<typeof FinancialPolicyPreparationReasonSchema>) => d.reasons.includes(reason);
  const requireFailure = (condition: boolean, message: string) => { if (condition) issue(c, message); };
  if (m.action === 'save_document' || m.action === 'save_draft') {
    const basis = m.draftScope;
    requireFailure((basis === null) !== (m.siteActive === null), 'Site activity and basis must be observed together.');
    if (basis) requireFailure(v.responsibilityId === null || basis.authority.responsibility.id !== v.responsibilityId ||
      basis.site.id !== basis.authority.responsibility.siteId, 'Responsibility and site basis must match route scope.');
    if (v.responsibilityId !== null && reviewable) requireFailure(basis === null || m.siteActive !== true ||
      !v.scope.siteIds.includes(basis.site.id) || !v.scope.actionSiteIds.includes(basis.site.id), 'Reviewable save requires active scoped site material.');
    if (m.action === 'save_document' && s.action === 'save_document') {
      requireFailure(m.purpose !== s.purpose || m.organizationEpoch !== v.scope.organizationEpoch, 'Document purpose and observed epoch must match.');
      requireFailure(v.responsibilityId === null && (basis !== null || m.siteActive !== null), 'Organization documents have no responsibility basis.');
      requireFailure(v.responsibilityId !== null && has('ROLE_REQUIRED'), 'Responsibility scope already contains an eligible policy role.');
    }
    if (m.action === 'save_draft' && s.action === 'save_draft') {
      if (m.document) requireFailure(s.document === null || !checkedDocument(m.document, s.document, 'financial_mandate', v.scope, v.responsibilityId, true), 'Selected draft document must be exact, scoped and current.');
      requireFailure(reviewable && (s.document === null || m.document === null), 'Reviewable draft requires its full current document.');
      requireFailure(has('DOCUMENT_REQUIRED') && s.document !== null || has('DOCUMENT_CHANGED') && (s.document === null || m.document !== null), 'Document reason must describe selected missing material.');
    }
  }
  if (m.action === 'propose_governance' && s.action === 'propose_governance') {
    for (const [selected, document, purpose] of [[s.budgetDocument, m.budgetDocument, 'budget_policy'], [s.approvalDocument, m.approvalDocument, 'approval_policy']] as const)
      if (document) requireFailure(selected === null || !checkedDocument(document, selected, purpose, v.scope, null, true), 'Selected governance document must be exact, scoped and current.');
    const missingSelection = s.budgetDocument === null || s.approvalDocument === null;
    const missingSelectedMaterial = s.budgetDocument !== null && m.budgetDocument === null || s.approvalDocument !== null && m.approvalDocument === null;
    requireFailure(has('DOCUMENT_REQUIRED') && !missingSelection || has('DOCUMENT_CHANGED') && !missingSelectedMaterial, 'Document reason must match missing selected governance material.');
    if (m.asset === null) requireFailure(m.budgetAccountId !== null || m.control !== null || m.acceptedConfiguration !== null || m.periods.length !== 0, 'Unavailable asset cannot carry a partial budget context.');
    else {
      requireFailure(s.assetKey !== m.asset.pin.key || m.budgetAccountId === null || m.control === null || m.control.budgetAccountId !== m.budgetAccountId,
        'Exact selected asset and stable current budget context required.');
      requireFailure((m.control?.accepted == null) !== (m.acceptedConfiguration === null), 'Accepted configuration must agree with current control.');
      if (m.acceptedConfiguration) {
        const a = m.acceptedConfiguration, r = a.record, b = a.budgetConfiguration;
        requireFailure(!inScope(r, v.scope, null) || r.state !== 'ACCEPTED' || !sameRef(a.reference, m.control?.accepted ?? null) ||
          r.bundle.budgetAccountId !== m.budgetAccountId || r.bundle.asset.key !== m.asset.pin.key || b.status !== 'observed' ||
          !b.currentBudgetConfiguration || b.control.budgetAccountId !== m.budgetAccountId || b.control.generation !== m.control?.generation ||
          !sameRef(b.control.accepted, m.control?.accepted ?? null) || !m.periods.some(p => p.id === r.bundle.period.id && p.startsAt === r.bundle.period.startsAt && p.endsAt === r.bundle.period.endsAt),
        'Current accepted configuration, control and fixed period must agree.');
      }
    }
    requireFailure(new Set(m.periods.map(p => p.id)).size !== m.periods.length || m.periods.some((p, i) => i > 0 && m.periods[i - 1]!.endsAt > p.startsAt), 'Fixed periods must be unique, ordered and nonoverlapping.');
    requireFailure(m.eligibleActionSites.some(site => !v.scope.siteIds.includes(site.id) || !v.scope.actionSiteIds.includes(site.id)), 'Eligible sites must be in both current grant lists.');
    requireFailure(has('ASSET_MISSING') && s.assetKey !== null || has('ASSET_CHANGED') && (s.assetKey === null || m.asset !== null), 'Asset reason must match unavailable selection.');
    const old = v.target.state === 'exact' && v.target.record.record.kind === 'governance' ? v.target.record.record : null;
    const differentAccount = old !== null && m.budgetAccountId !== null && old.bundle.budgetAccountId !== m.budgetAccountId;
    requireFailure(has('GOVERNANCE_CHANGED') && !differentAccount || reviewable && differentAccount, 'Revision cannot replace stable budget identity.');
    if (old && !differentAccount && m.control && v.target.state === 'exact' && v.target.record.record.kind === 'governance') {
      const current = m.control, observed = v.target.record.budgetConfiguration;
      if (observed !== null && observed.status === 'observed') requireFailure(observed.control.budgetAccountId !== current.budgetAccountId ||
        observed.control.generation !== current.generation || !sameRef(observed.control.accepted, current.accepted), 'Co-observed target and preparation control must agree.');
      const matches = old.expectedControl.generation === current.generation && sameRef(old.expectedControl.accepted, current.accepted);
      requireFailure(old.state === 'OPEN' && v.target.record.projection.currentRecord !== matches,
        'Latest OPEN projection must agree with the co-observed budget control.');
    }
    requireFailure(reviewable && (m.asset === null || m.budgetDocument === null || m.approvalDocument === null || m.eligibleActionSites.length === 0), 'Reviewable proposal requires complete selected configuration material.');
  }
  if (v.responsibilityId === null) {
    requireFailure(reviewable && !v.scope.roles.includes('owner'), 'Organization authoring requires a server decision consistent with current owner role.');
    requireFailure(has('ROLE_REQUIRED') && v.scope.roles.includes('owner'), 'Owner role contradicts ROLE_REQUIRED.');
  }
}
export const FinancialPolicyPreparationResponseSchema = z.custom<unknown>(v => encodedWithin(v, FINANCIAL_POLICY_PREPARATION_RESPONSE_MAX_BYTES),
  'Preparation response exceeds the encoded byte limit.').pipe(response.superRefine((v, c) => {
    if (v.selection.action !== v.decision.action || v.selection.action !== v.material.action ||
      !FinancialPolicyHttpRouteIdentitySchema.safeParse({ kind: v.selection.action, id: v.selection.targetId, responsibilityId: v.responsibilityId }).success ||
      v.selection.action === 'save_document' && (v.selection.purpose === 'financial_mandate') !== (v.responsibilityId !== null)) issue(c, 'Exact selection, action and route scope required.');
    if (v.responsibilityId === null && !v.scope.roles.some(role => role === 'owner' || role === 'finance')) issue(c, 'Organization preparation requires authorized disclosure scope.');
    if (!v.configurationWarnings.includes('TRUST_UNAVAILABLE') || !v.configurationWarnings.includes('FINANCIAL_AUTHORITY_UNAVAILABLE'))
      issue(c, 'Configuration-only warnings must remain explicit.');
    targetChecks(v, c); materialChecks(v, c);
  }));

export type FinancialPolicyPreparationRequest = z.infer<typeof FinancialPolicyPreparationRequestSchema>;
export type FinancialPolicyPreparationAction = z.infer<typeof FinancialPolicyPreparationActionSchema>;
export type FinancialPolicyPreparationReason = z.infer<typeof FinancialPolicyPreparationReasonSchema>;
export type FinancialPolicyPreparationDecision = z.infer<typeof FinancialPolicyPreparationDecisionSchema>;
export type FinancialPolicyPreparationTarget = z.infer<typeof FinancialPolicyPreparationTargetSchema>;
export type FinancialPolicyPreparationMaterial = z.infer<typeof FinancialPolicyPreparationMaterialSchema>;
export type FinancialPolicyPreparationResponse = z.infer<typeof FinancialPolicyPreparationResponseSchema>;
