import { FinancialPolicyOriginalClosureReceiptSchema, financialPolicyOriginalClosureReceiptHash,
  type FinancialPolicyOriginalClosureExpected } from '@pactwoven/contracts';
import type { FinancialPolicyReference } from './financial-policy-contract';

export async function financialClosureFixture(reference: FinancialPolicyReference, expected: FinancialPolicyOriginalClosureExpected,
  changes: Record<string, unknown> = {}) {
  const content = { schemaVersion: 1, id: '00000000-0000-0000-0000-000000000019', environment: reference.scope.environment,
    organizationId: reference.scope.organizationId, actor: expected.actor, locator: reference.locator,
    reason: 'original_input_unavailable', expected, closedAt: '2026-11-15T00:00:00.000Z', effectiveAuthority: false, financialState: null, ...changes };
  return FinancialPolicyOriginalClosureReceiptSchema.parse({ ...content, recordHash: await financialPolicyOriginalClosureReceiptHash(content) });
}
