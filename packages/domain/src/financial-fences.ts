import { FinancialAuthorityFenceSchema, FinancialAuthorityHistorySchema, FinancialFenceGenerationSchema,
  type FinancialAuthorityFence, type FinancialAuthorityHistory } from '@pactwoven/contracts';
import { canonicalJson, commandDigest } from './canonical.js';
import { DomainError } from './errors.js';

export function nextFinancialFenceGeneration(value: number): number {
  FinancialFenceGenerationSchema.parse(value);
  if (value === 2_147_483_647) throw new DomainError('FENCE_EXHAUSTED', 409, 'The control generation is exhausted.');
  return value + 1;
}
export async function financialAuthorityFenceHash(value: FinancialAuthorityFence): Promise<string> {
  return commandDigest({ namespace: 'pactwoven:financial-authority-fence:v1', record: FinancialAuthorityFenceSchema.parse(value) });
}
/** Validates retained references; this does not construct an execution capability. */
export function verifyFinancialAuthorityHistory(input: readonly FinancialAuthorityHistory[], expected: FinancialAuthorityFence): void {
  const current = FinancialAuthorityFenceSchema.parse(expected);
  if (input.length === 0) throw new DomainError('FENCE_HISTORY', 503, 'Authority history is unavailable.');
  let previous: FinancialAuthorityFence | null = null;
  for (const raw of input) {
    const step = FinancialAuthorityHistorySchema.parse(raw);
    if (canonicalJson(step.previous) !== canonicalJson(previous)) throw new DomainError('FENCE_HISTORY', 503, 'Authority history has a missing or different predecessor.');
    if (previous && step.basis === 'responsibility_change' && (step.current.responsibility.version !== previous.responsibility.version + 1 ||
      canonicalJson(step.current.legacyHead) !== canonicalJson(previous.legacyHead) || step.current.family !== previous.family))
      throw new DomainError('FENCE_HISTORY', 503, 'A responsibility change must retain the selected authority.');
    if (previous && step.basis === 'legacy_head' && (canonicalJson(step.current.responsibility) !== canonicalJson(previous.responsibility) ||
      step.current.legacyHead!.mandateEpoch !== (previous.legacyHead?.mandateEpoch ?? 0) + 1))
      throw new DomainError('FENCE_HISTORY', 503, 'A legacy transition must preserve scope and advance its exact head.');
    previous = step.current;
  }
  if (canonicalJson(previous) !== canonicalJson(current)) throw new DomainError('FENCE_HISTORY', 503, 'The selected authority differs from its final history.');
}
