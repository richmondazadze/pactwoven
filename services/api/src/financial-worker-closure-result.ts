import { FinancialPolicyOriginalClosureRequestSchema, FinancialPolicyOriginalClosureResponseSchema,
  FinancialPolicyOriginalStatusResponseSchema, FinancialPolicyHttpRecoveryLocatorSchema,
  financialPolicyOriginalClosureReceiptHash, type FinancialPolicyOriginalClosureRequest,
  type FinancialPolicyOriginalClosureResponse, type FinancialPolicyHttpRecoveryLocator } from '@pactwoven/contracts';
import { canonicalJson } from '@pactwoven/contracts/canonical';
import { DomainError } from '@pactwoven/domain';

export const financialPolicyClosureUnverified = () => new DomainError('FINANCIAL_POLICY_OUTCOME_UNKNOWN', 503,
  'The result is unconfirmed. Preserve the original key and request hash; use original-result lookup.');
export function snapshotFinancialPolicyClosureRequest(input: unknown): FinancialPolicyOriginalClosureRequest {
  const v = FinancialPolicyOriginalClosureRequestSchema.safeParse(input);
  if (!v.success) throw new DomainError('FINANCIAL_POLICY_INPUT_INVALID', 422, 'Use the exact reviewed original request closure.');
  return v.data;
}
/** Pure public-result qualification; this module contains no database or verifier runtime. */
export async function validateFinancialPolicyOriginalStatusResponse(locator: FinancialPolicyHttpRecoveryLocator, raw: unknown, now: () => number = Date.now) {
  try {
    const q = FinancialPolicyHttpRecoveryLocatorSchema.parse(locator), v = FinancialPolicyOriginalStatusResponseSchema.parse(raw);
    const fresh = () => { const at = now(); if (!Number.isFinite(at) || Date.parse(v.observation.observedAt) > at ||
      Date.parse(v.observation.expiresAt) <= at || v.status === 'closed' && Date.parse(v.closure.closedAt) > at) throw financialPolicyClosureUnverified(); };
    fresh();
    if (canonicalJson(q) !== canonicalJson({ responsibilityId: v.responsibilityId, kind: v.kind, key: v.key,
      targetId: v.targetId, publicRequestHash: v.publicRequestHash })) throw financialPolicyClosureUnverified();
    if (v.status === 'closed' && v.closure.recordHash !== await financialPolicyOriginalClosureReceiptHash(v.closure)) throw financialPolicyClosureUnverified();
    fresh(); return v;
  } catch { throw financialPolicyClosureUnverified(); }
}
export async function validateFinancialPolicyClosureResponse(request: FinancialPolicyOriginalClosureRequest, raw: unknown,
  now: () => number = Date.now): Promise<FinancialPolicyOriginalClosureResponse> {
  const input = snapshotFinancialPolicyClosureRequest(request);
  const v = await validateFinancialPolicyOriginalStatusResponse(input.locator, raw, now);
  if (v.scope.environment !== input.expected.environment || v.scope.organizationId !== input.expected.organizationId ||
    v.scope.actor.actorId !== input.expected.actor.actorId) throw financialPolicyClosureUnverified();
  // Existing closure reviewed pins are historical and are never rewritten on replay.
  const parsed = FinancialPolicyOriginalClosureResponseSchema.safeParse(v); if (!parsed.success) throw financialPolicyClosureUnverified(); return parsed.data;
}
