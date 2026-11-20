import { z } from 'zod';
import { IdSchema, IdempotencyKeySchema } from './core';
import { HashSchema } from './financial';
import { FinancialAuthorityFenceSchema } from './financial-fences';
import { FinancialPolicyRefSchema, FinancialPolicyGenerationSchema, FinancialPolicyTextSchema,
  FinancialGovernanceBundleSchema, FinancialGovernanceControlRefSchema, FinancialPolicyInstantSchema,
  FinancialDraftInputSchema, FinancialDraftScopeSchema } from './financial-policies';

// Reviewed material only. Environment and organization are supplied by the server
// envelope; this basis cannot claim an authenticated identity or current authority.
export const FinancialPolicyHttpAuthorityBasisSchema = z.strictObject({
  schemaVersion: z.literal(1), responsibility: FinancialAuthorityFenceSchema.shape.responsibility,
  generation: FinancialAuthorityFenceSchema.shape.generation, family: FinancialAuthorityFenceSchema.shape.family,
  legacyHead: FinancialAuthorityFenceSchema.shape.legacyHead,
}).refine(v => (v.family === 'none') === (v.legacyHead === null), 'The selected family requires its exact head.');
export const FinancialPolicyHttpDraftSchema = z.strictObject({
  scope: z.strictObject({ authority: FinancialPolicyHttpAuthorityBasisSchema, authorityHash: HashSchema,
    site: FinancialDraftScopeSchema.shape.site }),
  terms: FinancialDraftInputSchema.shape.terms, documents: FinancialDraftInputSchema.shape.documents,
  governance: FinancialDraftInputSchema.shape.governance, asset: FinancialDraftInputSchema.shape.asset,
  account: FinancialDraftInputSchema.shape.account, trust: z.null(),
  startsAt: FinancialPolicyInstantSchema, expiresAt: FinancialPolicyInstantSchema,
}).superRefine((v, c) => {
  if (v.startsAt >= v.expiresAt) c.addIssue({ code: 'custom', path: ['expiresAt'], message: 'The draft needs a nonempty exact interval.' });
  if (v.scope.site.id !== v.scope.authority.responsibility.siteId) c.addIssue({ code: 'custom', path: ['scope', 'site', 'id'], message: 'The site must match the pinned responsibility.' });
  if (v.documents.length !== 1 || v.documents[0]?.purpose !== 'financial_mandate') c.addIssue({ code: 'custom', path: ['documents'], message: 'Exactly one financial-mandate document is required.' });
  if (v.asset === null && (v.account !== null || v.governance !== null)) c.addIssue({ code: 'custom', path: ['asset'], message: 'Account and governance references require an exact asset pin.' });
});

const reviewed = { schemaVersion: z.literal(1), previous: FinancialPolicyRefSchema.nullable(),
  organizationEpoch: FinancialPolicyGenerationSchema };
export const FinancialPolicyResponsibilityDocumentHttpSchema = z.strictObject({ ...reviewed,
  purpose: z.literal('financial_mandate'), text: FinancialPolicyTextSchema });
export const FinancialPolicyGovernanceDocumentHttpSchema = z.strictObject({ ...reviewed,
  purpose: z.enum(['budget_policy', 'approval_policy']), text: FinancialPolicyTextSchema });
export const FinancialPolicyDraftHttpSchema = z.strictObject({ ...reviewed, draft: FinancialPolicyHttpDraftSchema });
export const FinancialPolicyWithdrawHttpSchema = z.strictObject({ ...reviewed, previous: FinancialPolicyRefSchema });
export const FinancialPolicyGovernanceHttpSchema = z.strictObject({ ...reviewed, bundle: FinancialGovernanceBundleSchema,
  expectedControl: FinancialGovernanceControlRefSchema, expiresAt: FinancialPolicyInstantSchema,
}).refine(v => v.bundle.budgetAccountId === v.expectedControl.budgetAccountId, 'The bundle and control must name the same stable budget account.');
// The route supplies accept versus reject. Private nonce and evidence IDs are
// never public inputs, including when an original result is being recovered.
export const FinancialPolicyConsentHttpSchema = z.strictObject({ ...reviewed, previous: FinancialPolicyRefSchema,
  expectedControl: FinancialGovernanceControlRefSchema });

export const FinancialPolicyHttpKindSchema = z.enum(['save_document', 'save_draft', 'withdraw_draft',
  'propose_governance', 'accept_governance', 'reject_governance']);
export const FinancialPolicyHttpRouteIdentitySchema = z.strictObject({ kind: FinancialPolicyHttpKindSchema,
  responsibilityId: IdSchema.nullable(), id: IdSchema,
}).superRefine((v, c) => {
  const responsibility = v.kind === 'save_draft' || v.kind === 'withdraw_draft';
  const governance = v.kind === 'propose_governance' || v.kind === 'accept_governance' || v.kind === 'reject_governance';
  if (responsibility && v.responsibilityId === null || governance && v.responsibilityId !== null)
    c.addIssue({ code: 'custom', path: ['responsibilityId'], message: 'The command kind requires its exact route scope.' });
  // Literal route precedence is part of the public API. Existing private IDs and
  // records are not changed; unsupported historical IDs have no public projection.
  if (governance && ['context', 'documents', 'operations'].includes(v.id) || responsibility && v.id === 'context')
    c.addIssue({ code: 'custom', path: ['id'], message: 'This target ID is reserved by a literal route.' });
});
export type FinancialPolicyHttpRouteIdentity = z.infer<typeof FinancialPolicyHttpRouteIdentitySchema>;
function routeFor(v: FinancialPolicyHttpRouteIdentity): string {
  switch (v.kind) {
    case 'save_document': return v.responsibilityId === null ? `/v1/financial-governance/documents/${v.id}`
      : `/v1/responsibilities/${v.responsibilityId}/financial-policy-documents/${v.id}`;
    case 'save_draft': return `/v1/responsibilities/${v.responsibilityId}/financial-policies/${v.id}`;
    case 'withdraw_draft': return `/v1/responsibilities/${v.responsibilityId}/financial-policies/${v.id}/withdraw`;
    case 'propose_governance': return `/v1/financial-governance/${v.id}`;
    case 'accept_governance': return `/v1/financial-governance/${v.id}/accept`;
    case 'reject_governance': return `/v1/financial-governance/${v.id}/reject`;
  }
}
export function financialPolicyHttpRoute(input: unknown): string { return routeFor(FinancialPolicyHttpRouteIdentitySchema.parse(input)); }

const request = { responsibilityId: IdSchema.nullable(), id: IdSchema, key: IdempotencyKeySchema, route: z.string().max(512) };
// This is a local canonical snapshot, not a body accepted wholesale by a route.
// The gateway rebuilds route/kind/id/scope from its exact route and key header.
export const FinancialPolicyHttpRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...request, kind: z.literal('save_document'), input: z.union([
    FinancialPolicyResponsibilityDocumentHttpSchema, FinancialPolicyGovernanceDocumentHttpSchema]) }),
  z.strictObject({ ...request, kind: z.literal('save_draft'), input: FinancialPolicyDraftHttpSchema }),
  z.strictObject({ ...request, kind: z.literal('withdraw_draft'), input: FinancialPolicyWithdrawHttpSchema }),
  z.strictObject({ ...request, kind: z.literal('propose_governance'), input: FinancialPolicyGovernanceHttpSchema }),
  z.strictObject({ ...request, kind: z.literal('accept_governance'), input: FinancialPolicyConsentHttpSchema }),
  z.strictObject({ ...request, kind: z.literal('reject_governance'), input: FinancialPolicyConsentHttpSchema }),
]).superRefine((v, c) => {
  const identity = FinancialPolicyHttpRouteIdentitySchema.safeParse({ kind: v.kind, responsibilityId: v.responsibilityId, id: v.id });
  if (!identity.success) for (const issue of identity.error.issues) c.addIssue({ code: 'custom', path: issue.path, message: issue.message });
  else if (v.route !== routeFor(identity.data)) c.addIssue({ code: 'custom', path: ['route'], message: 'The declared route must be the exact canonical command route.' });
  if (v.input.previous !== null && v.input.previous.id !== v.id) c.addIssue({ code: 'custom', path: ['input', 'previous', 'id'], message: 'The predecessor must belong to this exact target.' });
  if (v.kind === 'save_document' && ((v.responsibilityId === null) === (v.input.purpose === 'financial_mandate')))
    c.addIssue({ code: 'custom', path: ['input', 'purpose'], message: 'The document purpose must match its organization or responsibility route.' });
  if (v.kind === 'save_draft' && v.input.draft.scope.authority.responsibility.id !== v.responsibilityId)
    c.addIssue({ code: 'custom', path: ['input', 'draft', 'scope', 'authority', 'responsibility', 'id'], message: 'The authority basis must name the route responsibility.' });
});
export type FinancialPolicyHttpRequest = z.infer<typeof FinancialPolicyHttpRequestSchema>;
export type FinancialPolicyHttpAuthorityBasis = z.infer<typeof FinancialPolicyHttpAuthorityBasisSchema>;
export type FinancialPolicyHttpDraft = z.infer<typeof FinancialPolicyHttpDraftSchema>;
