import { z } from 'zod';
import { IdSchema, FinancialPolicyRefSchema, FinancialPolicyReadSchema, FinancialDraftScopeSchema,
  FinancialGovernanceControlRefSchema, FinancialBudgetPeriodSchema, FinancialPolicyGenerationSchema, HashSchema,
  FinancialPolicyInstantSchema, FinancialPolicyBlockerSchema, FinancialPolicyDocumentPurposeSchema,
  FinancialPolicyPreparationRequestSchema, FinancialPolicyPreparationDecisionSchema,
  type FinancialPolicyPreparationReason } from '@pactwoven/contracts';
import { FinancialPolicyReaderScopeSchema, FinancialPolicyAssetContextSchema } from './financial-policy-read-schema.js';

/** Private authorizer facts. Schema parsing does not authenticate their origin. */
export const FinancialPolicyPreparationQuerySchema = z.strictObject({ responsibilityId: IdSchema.nullable(),
  selection: FinancialPolicyPreparationRequestSchema }).superRefine((v, c) => {
  const s = v.selection;
  if ((v.responsibilityId !== null) !== (s.action === 'save_draft' || s.action === 'withdraw_draft' ||
    s.action === 'save_document' && s.purpose === 'financial_mandate'))
    c.addIssue({ code: 'custom', message: 'Exact preparation route scope required.' });
});
const empty = { record: z.null(), historicalDocuments: z.tuple([]), control: z.null() };
const target = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('absent'), latestReference: z.null(), ...empty }),
  z.strictObject({ state: z.literal('unavailable'), latestReference: z.null(), ...empty }),
  z.strictObject({ state: z.literal('changed'), latestReference: FinancialPolicyRefSchema, ...empty }),
  z.strictObject({ state: z.literal('exact'), latestReference: FinancialPolicyRefSchema, record: FinancialPolicyReadSchema,
    historicalDocuments: z.array(FinancialPolicyReadSchema).max(2), control: FinancialGovernanceControlRefSchema.nullable() }),
]);
const material = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('save_document'), purpose: FinancialPolicyDocumentPurposeSchema,
    organizationEpoch: FinancialPolicyGenerationSchema, draftScope: FinancialDraftScopeSchema.nullable(), siteActive: z.boolean().nullable() }),
  z.strictObject({ action: z.literal('save_draft'), profile: z.literal('incomplete'), draftScope: FinancialDraftScopeSchema.nullable(),
    siteActive: z.boolean().nullable(), document: FinancialPolicyReadSchema.nullable(), asset: z.null(), account: z.null(), governance: z.null(), trust: z.null() }),
  z.strictObject({ action: z.literal('withdraw_draft') }),
  z.strictObject({ action: z.literal('propose_governance'), asset: FinancialPolicyAssetContextSchema.nullable(), budgetAccountId: HashSchema.nullable(),
    control: FinancialGovernanceControlRefSchema.nullable(), acceptedConfiguration: FinancialPolicyReadSchema.nullable(),
    periods: z.array(FinancialBudgetPeriodSchema).max(50), budgetDocument: FinancialPolicyReadSchema.nullable(), approvalDocument: FinancialPolicyReadSchema.nullable(),
    eligibleActionSites: z.array(z.strictObject({ id: IdSchema, generation: FinancialPolicyGenerationSchema, recordHash: HashSchema })).max(100)
      .refine(v => v.every((x, i) => i === 0 || v[i - 1]!.id < x.id)) }),
]);
const response = z.strictObject({ schemaVersion: z.literal(1), scope: FinancialPolicyReaderScopeSchema,
  responsibilityId: IdSchema.nullable(), selection: FinancialPolicyPreparationRequestSchema, target, material,
  originalActorMatches: z.boolean().nullable(), decision: FinancialPolicyPreparationDecisionSchema,
  configurationWarnings: z.array(FinancialPolicyBlockerSchema).max(16).refine(v => v.every((x, i) => i === 0 || v[i - 1]! < x)),
  observedAt: FinancialPolicyInstantSchema, expiresAt: FinancialPolicyInstantSchema, effectiveAuthority: z.literal(false), financialState: z.null() });
type Facts = z.infer<typeof response>;
const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Derive only configuration review eligibility, from this exact private capsule. */
export function financialPolicyPreparationReasons(v: Facts): FinancialPolicyPreparationReason[] {
  const reasons = new Set<FinancialPolicyPreparationReason>(), { selection: s, target: t, material: m } = v;
  if (t.state === 'unavailable') reasons.add('TARGET_UNAVAILABLE');
  if (t.state === 'changed') reasons.add('PREDECESSOR_CHANGED');
  if (t.state === 'exact') {
    const r = t.record.record;
    if (!v.originalActorMatches) reasons.add('ORIGINAL_ACTOR_REQUIRED');
    if (r.version === 2_147_483_647) reasons.add('VERSION_EXHAUSTED');
    if (r.kind === 'draft' && r.state === 'WITHDRAWN') reasons.add('DRAFT_WITHDRAWN');
    if (r.kind === 'draft' && s.action === 'save_draft' &&
      [r.draft.asset, r.draft.account, r.draft.governance, r.draft.trust].some(x => x !== null)) reasons.add('DRAFT_MATERIAL_UNSUPPORTED');
    if (r.kind === 'governance' && r.state !== 'OPEN') reasons.add('CURRENT_RECORD_REQUIRED');
    if (r.kind === 'governance' && m.action === 'propose_governance' && m.budgetAccountId !== null &&
      r.bundle.budgetAccountId !== m.budgetAccountId) reasons.add('GOVERNANCE_CHANGED');
  }
  if (v.responsibilityId === null && !v.scope.roles.includes('owner')) reasons.add('ROLE_REQUIRED');
  if ((m.action === 'save_document' || m.action === 'save_draft') && v.responsibilityId !== null && m.siteActive !== true) reasons.add('SCOPE_CHANGED');
  if (s.action === 'save_draft' && m.action === 'save_draft') {
    if (s.document === null) reasons.add('DOCUMENT_REQUIRED');
    else if (m.document === null) reasons.add('DOCUMENT_CHANGED');
  }
  if (s.action === 'propose_governance' && m.action === 'propose_governance') {
    if (s.assetKey === null) reasons.add('ASSET_MISSING'); else if (m.asset === null) reasons.add('ASSET_CHANGED');
    if (s.budgetDocument === null || s.approvalDocument === null) reasons.add('DOCUMENT_REQUIRED');
    if (s.budgetDocument !== null && m.budgetDocument === null || s.approvalDocument !== null && m.approvalDocument === null) reasons.add('DOCUMENT_CHANGED');
    if (m.eligibleActionSites.length === 0) reasons.add('SITE_ACCESS_REQUIRED');
  }
  return [...reasons].sort();
}
export const FinancialPolicyPreparationSchema = z.custom<unknown>(v => {
  try { return new TextEncoder().encode(JSON.stringify(v)).byteLength <= 2 * 1024 * 1024; } catch { return false; }
}, 'Bounded private preparation required.').pipe(response.superRefine((v, c) => {
  const bad = (condition: boolean, message: string) => { if (condition) c.addIssue({ code: 'custom', message }); };
  const { selection: s, target: t, material: m } = v;
  bad(!FinancialPolicyPreparationQuerySchema.safeParse({ responsibilityId: v.responsibilityId, selection: s }).success ||
    m.action !== s.action || v.decision.action !== s.action, 'Exact selection and action scope required.');
  bad(v.responsibilityId === null && !v.scope.roles.some(r => r === 'owner' || r === 'finance'), 'Organization disclosure requires owner or finance.');
  bad(!v.scope.roles.some(r => ['owner', 'finance', 'operations'].includes(r)), 'Current policy role required.');
  bad(v.observedAt >= v.expiresAt || Date.parse(v.expiresAt) > Date.parse(v.observedAt) + 20_000, 'Original bounded observation required.');
  bad(!v.configurationWarnings.includes('TRUST_UNAVAILABLE') || !v.configurationWarnings.includes('FINANCIAL_AUTHORITY_UNAVAILABLE'), 'Configuration-only warnings required.');
  const refEqual = (a: z.infer<typeof FinancialPolicyRefSchema> | null, b: z.infer<typeof FinancialPolicyRefSchema> | null) =>
    a === null || b === null ? a === b : a.id === b.id && a.version === b.version && a.recordHash === b.recordHash;
  if (t.state === 'absent') bad(s.previous !== null, 'Missing predecessor is not creation absence.');
  if (t.state === 'changed') bad(t.latestReference.id !== s.targetId || refEqual(t.latestReference, s.previous), 'Changed target requires different predecessor.');
  if (t.state !== 'exact') bad(v.originalActorMatches !== null, 'Opaque target cannot carry original-person facts.');
  else {
    const r = t.record.record;
    bad(!refEqual(t.latestReference, s.previous) || !refEqual(t.latestReference, t.record.reference) || r.id !== s.targetId ||
      r.environment !== v.scope.environment || r.organizationId !== v.scope.organizationId || r.responsibilityId !== v.responsibilityId,
    'Exact raw target and route required.');
    bad(s.action === 'save_document' ? r.kind !== 'document' || r.purpose !== s.purpose : s.action === 'propose_governance' ? r.kind !== 'governance' : r.kind !== 'draft', 'Compatible target kind and purpose required.');
    const actor = r.kind === 'document' ? r.actor : r.kind === 'draft' ? r.requester : r.proposer;
    bad(v.originalActorMatches !== (actor.actorId === v.scope.actor.actorId && (r.kind === 'document' || actor.subject === v.scope.actor.subject)), 'Exact private original-person predicate required.');
    bad(r.kind !== 'governance' && (!t.record.current || t.control !== null) || r.kind === 'governance' &&
      (t.control === null || t.control.budgetAccountId !== r.bundle.budgetAccountId), 'Latest raw target/control relationship required.');
    const refs = r.kind === 'document' ? [] : r.kind === 'draft' ? r.draft.documents : r.bundle.documents;
    bad(refs.length !== t.historicalDocuments.length, 'Complete historical document material required.');
    for (const [i, d] of t.historicalDocuments.entries()) {
      const ref = refs[i];
      bad(!ref || d.record.kind !== 'document' || !refEqual(d.reference, ref) || d.record.purpose !== ref.purpose ||
        d.record.environment !== v.scope.environment || d.record.organizationId !== v.scope.organizationId ||
        d.record.responsibilityId !== (ref?.purpose === 'financial_mandate' ? v.responsibilityId : null), 'Exact historical terms required.');
    }
  }
  if (m.action === 'save_document' || m.action === 'save_draft') {
    bad((m.draftScope === null) !== (v.responsibilityId === null) || (m.siteActive === null) !== (m.draftScope === null), 'Co-observed responsibility basis required.');
    if (m.draftScope) bad(m.draftScope.authority.environment !== v.scope.environment || m.draftScope.authority.organizationId !== v.scope.organizationId ||
      m.draftScope.authority.responsibility.id !== v.responsibilityId || m.draftScope.site.id !== m.draftScope.authority.responsibility.siteId ||
      !v.scope.siteIds.includes(m.draftScope.site.id) || !v.scope.actionSiteIds.includes(m.draftScope.site.id), 'Exact granted responsibility/site basis required.');
    if (m.action === 'save_document') bad(s.action !== 'save_document' || m.purpose !== s.purpose || m.organizationEpoch !== v.scope.organizationEpoch, 'Exact document purpose/epoch required.');
  }
  const selected = m.action === 'save_draft' && s.action === 'save_draft' ? [[s.document, m.document, 'financial_mandate']] as const :
    m.action === 'propose_governance' && s.action === 'propose_governance' ? [[s.budgetDocument, m.budgetDocument, 'budget_policy'], [s.approvalDocument, m.approvalDocument, 'approval_policy']] as const : [];
  for (const [ref, d, purpose] of selected) if (d) bad(ref === null || !refEqual(ref, d.reference) || d.record.kind !== 'document' ||
    d.record.purpose !== purpose || !d.current || d.state !== 'DOCUMENT' || d.record.environment !== v.scope.environment ||
    d.record.organizationId !== v.scope.organizationId || d.record.responsibilityId !== (purpose === 'financial_mandate' ? v.responsibilityId : null), 'Exact current selected terms required.');
  if (m.action === 'propose_governance' && s.action === 'propose_governance') {
    bad(m.eligibleActionSites.some(x => !v.scope.siteIds.includes(x.id) || !v.scope.actionSiteIds.includes(x.id)), 'Eligible sites require both grants.');
    if (m.asset === null) bad(m.budgetAccountId !== null || m.control !== null || m.acceptedConfiguration !== null || m.periods.length !== 0, 'No partial unavailable asset context.');
    else bad(s.assetKey !== m.asset.pin.key || m.control === null || m.budgetAccountId !== m.control.budgetAccountId ||
      (m.control.accepted === null) !== (m.acceptedConfiguration === null), 'Exact selected asset/control context required.');
    if (m.acceptedConfiguration) {
      const a = m.acceptedConfiguration, r = a.record;
      bad(r.kind !== 'governance' || r.state !== 'ACCEPTED' || r.environment !== v.scope.environment || r.organizationId !== v.scope.organizationId ||
        r.responsibilityId !== null || !refEqual(a.reference, m.control?.accepted ?? null) || r.bundle.budgetAccountId !== m.budgetAccountId ||
        r.bundle.asset.key !== m.asset?.pin.key || !m.periods.some(p => equal(p, r.bundle.period)), 'Reciprocal accepted configuration and period required.');
    }
    bad(new Set(m.periods.map(x => x.id)).size !== m.periods.length || m.periods.some((x, i) => i > 0 && m.periods[i - 1]!.endsAt > x.startsAt), 'Complete ordered nonoverlapping periods required.');
    const original = t.state === 'exact' ? t.record.record : null;
    if (original?.kind === 'governance' && original.bundle.budgetAccountId === m.budgetAccountId)
      bad(!m.periods.some(p => equal(p, original.bundle.period)), 'Existing proposal period cannot disappear from its complete account context.');
  }
  const reasons = financialPolicyPreparationReasons(v);
  bad(v.decision.state !== (reasons.length ? 'blocked' : 'reviewable') || !equal(v.decision.reasons, reasons), 'Decision must follow this exact private material.');
}));
export type FinancialPolicyPreparationQuery = z.infer<typeof FinancialPolicyPreparationQuerySchema>;
export type FinancialPolicyPreparation = z.infer<typeof FinancialPolicyPreparationSchema>;
export interface FinancialPolicyPreparationReader {
  prepare(identityEvidenceId: string, scope: z.infer<typeof FinancialPolicyReaderScopeSchema>, query: FinancialPolicyPreparationQuery): Promise<FinancialPolicyPreparation>;
}
