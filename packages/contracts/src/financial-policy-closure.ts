import { z } from 'zod';
import { EnvironmentSchema, IdSchema } from './core';
import { HashSchema } from './financial';
import { canonicalJson, commandDigest } from './canonical';
import { FinancialDraftScopeSchema, FinancialPolicyGenerationSchema, FinancialPolicyInstantSchema, FinancialPolicyUuidSchema } from './financial-policies';
import { FinancialPolicyHttpAuthorityBasisSchema } from './financial-policy-http';
import { FinancialPolicyHttpActorSchema, FinancialPolicyHttpScopeSchema, FinancialPolicyHttpObservationSchema,
  FinancialPolicyHttpRecoveryLocatorSchema, FinancialPolicyHttpRecoveryResponseSchema,
  FINANCIAL_POLICY_HTTP_RESPONSE_MAX_BYTES } from './financial-policy-responses';

// Public review material, never evidence of identity or financial authority.
export const FINANCIAL_POLICY_ORIGINAL_CLOSURE_MAX_BYTES = 8 * 1024;
export const FINANCIAL_POLICY_ORIGINAL_CLOSURE_HASH_NAMESPACE = 'pactwoven:financial-policy-request-closure:v1';
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).byteLength;
const issue = (c: z.RefinementCtx, message: string) => c.addIssue({ code: 'custom', message });
export const FinancialPolicyOriginalClosureLocatorSchema = FinancialPolicyHttpRecoveryLocatorSchema.safeExtend({
  kind: z.enum(['save_document', 'save_draft']),
});
const draftScope = z.strictObject({ authority: FinancialPolicyHttpAuthorityBasisSchema, authorityHash: HashSchema,
  site: FinancialDraftScopeSchema.shape.site }).refine(v => v.site.id === v.authority.responsibility.siteId);
export const FinancialPolicyOriginalClosureExpectedSchema = z.strictObject({ environment: EnvironmentSchema,
  organizationId: IdSchema, actor: FinancialPolicyHttpActorSchema, organizationEpoch: FinancialPolicyGenerationSchema,
  draftScope: draftScope.nullable() });
const reason = z.literal('original_input_unavailable');
function pins(v: { locator: z.infer<typeof FinancialPolicyOriginalClosureLocatorSchema>;
  expected: z.infer<typeof FinancialPolicyOriginalClosureExpectedSchema> }, c: z.RefinementCtx) {
  if (v.locator.responsibilityId === null ? v.expected.draftScope !== null :
    v.expected.draftScope === null || v.expected.draftScope.authority.responsibility.id !== v.locator.responsibilityId)
    issue(c, 'Exact reviewed responsibility basis, or null for organization scope, is required.');
}
export const FinancialPolicyOriginalClosureRequestSchema = z.strictObject({ schemaVersion: z.literal(1),
  purpose: z.literal('financial_policy_original_close'), reason, locator: FinancialPolicyOriginalClosureLocatorSchema,
  expected: FinancialPolicyOriginalClosureExpectedSchema }).superRefine((v, c) => {
  pins(v, c); if (bytes(v) > FINANCIAL_POLICY_ORIGINAL_CLOSURE_MAX_BYTES) issue(c, 'Bounded closure intent required.');
});
const receiptContent = z.strictObject({ schemaVersion: z.literal(1), id: FinancialPolicyUuidSchema,
  environment: EnvironmentSchema, organizationId: IdSchema, actor: FinancialPolicyHttpActorSchema,
  locator: FinancialPolicyOriginalClosureLocatorSchema, reason, expected: FinancialPolicyOriginalClosureExpectedSchema,
  closedAt: FinancialPolicyInstantSchema, effectiveAuthority: z.literal(false), financialState: z.null() });
export const FinancialPolicyOriginalClosureReceiptSchema = receiptContent.extend({ recordHash: HashSchema }).superRefine((v, c) => {
  pins(v, c);
  if (v.environment !== v.expected.environment || v.organizationId !== v.expected.organizationId || !same(v.actor, v.expected.actor))
    issue(c, 'The immutable closure and its reviewed identity pins must agree.');
  if (bytes(v) > FINANCIAL_POLICY_ORIGINAL_CLOSURE_MAX_BYTES) issue(c, 'Bounded immutable closure required.');
});
/** Hash a complete receipt or its exact content; parsing and hashing do not authenticate it. */
export async function financialPolicyOriginalClosureReceiptHash(input: unknown): Promise<string> {
  const value = input !== null && typeof input === 'object' && Object.hasOwn(input, 'recordHash')
    ? (() => { const { recordHash: _, ...record } = FinancialPolicyOriginalClosureReceiptSchema.parse(input); return record; })()
    : (() => { const record = receiptContent.parse(input);
      FinancialPolicyOriginalClosureReceiptSchema.parse({ ...record, recordHash: '0'.repeat(64) }); return record; })();
  return commandDigest({ namespace: FINANCIAL_POLICY_ORIGINAL_CLOSURE_HASH_NAMESPACE, record: value });
}
export function financialPolicyOriginalClosureRoute(input: unknown): string {
  const v = FinancialPolicyOriginalClosureLocatorSchema.parse(input);
  return v.responsibilityId === null ? `/v1/financial-governance/operations/${v.key}/close`
    : `/v1/responsibilities/${v.responsibilityId}/financial-policy-operations/${v.key}/close`;
}
const legacy = FinancialPolicyHttpRecoveryResponseSchema.options;
function legacyCheck(v: unknown, c: z.RefinementCtx) {
  const { closure: _, ...r } = v as Record<string, unknown>;
  if (!FinancialPolicyHttpRecoveryResponseSchema.safeParse(r).success) issue(c, 'Exact original policy response required.');
}
const recorded = legacy[0].extend({ closure: z.null() }).superRefine(legacyCheck);
const missing = legacy[1].extend({ closure: z.null() }).superRefine(legacyCheck);
const closed = z.strictObject({ schemaVersion: z.literal(1), scope: FinancialPolicyHttpScopeSchema,
  observation: FinancialPolicyHttpObservationSchema, ...FinancialPolicyOriginalClosureLocatorSchema.shape,
  status: z.literal('closed'), receipt: z.null(), closure: FinancialPolicyOriginalClosureReceiptSchema,
  effectiveAuthority: z.literal(false), financialState: z.null() }).superRefine((v, c) => {
  const r = v.closure;
  if (r.environment !== v.scope.environment || r.organizationId !== v.scope.organizationId || r.actor.actorId !== v.scope.actor.actorId ||
    !same(r.locator, { responsibilityId: v.responsibilityId, kind: v.kind, key: v.key, targetId: v.targetId, publicRequestHash: v.publicRequestHash }) ||
    v.responsibilityId === null && !v.scope.roles.some(role => role === 'owner' || role === 'finance'))
    issue(c, 'The closure must name the exact original actor and locator in the current disclosure scope.');
  if (bytes(v) > FINANCIAL_POLICY_HTTP_RESPONSE_MAX_BYTES) issue(c, 'Bounded status response required.');
});
// Deliberately separate from legacy policy mutation/receipt schemas.
export const FinancialPolicyOriginalStatusResponseSchema = z.discriminatedUnion('status', [recorded, missing, closed]);
export const FinancialPolicyOriginalClosureResponseSchema = z.discriminatedUnion('status', [
  recorded.refine(v => FinancialPolicyOriginalClosureLocatorSchema.safeParse({ responsibilityId: v.responsibilityId,
    kind: v.kind, key: v.key, targetId: v.targetId, publicRequestHash: v.publicRequestHash }).success), closed,
]);
export type FinancialPolicyOriginalClosureLocator = z.infer<typeof FinancialPolicyOriginalClosureLocatorSchema>;
export type FinancialPolicyOriginalClosureExpected = z.infer<typeof FinancialPolicyOriginalClosureExpectedSchema>;
export type FinancialPolicyOriginalClosureRequest = z.infer<typeof FinancialPolicyOriginalClosureRequestSchema>;
export type FinancialPolicyOriginalClosureReceipt = z.infer<typeof FinancialPolicyOriginalClosureReceiptSchema>;
export type FinancialPolicyOriginalStatusResponse = z.infer<typeof FinancialPolicyOriginalStatusResponseSchema>;
export type FinancialPolicyOriginalClosureResponse = z.infer<typeof FinancialPolicyOriginalClosureResponseSchema>;
