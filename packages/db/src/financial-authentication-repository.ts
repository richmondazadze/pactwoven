import type { Pool } from 'pg';
import { FinancialPolicyRefSchema } from '@pactwoven/contracts';
import { canonicalJson, commandDigest } from '@pactwoven/domain';
import { FinancialAuthEvidenceSchema, type FinancialAuthEvidence } from './financial-auth-evidence.js';
import { financialPolicyTransaction, financialPolicyOne, financialPolicyOutcomeUnknown } from './financial-policy-repository.js';

export async function validateFinancialAuthEvidence(input: FinancialAuthEvidence): Promise<FinancialAuthEvidence> {
  const e = FinancialAuthEvidenceSchema.parse(input);
  if (e.tokenIssuedAt > e.observedAt || e.expiresAt <= e.observedAt || e.expiresAt > e.sessionExpiresAt ||
    Date.parse(e.expiresAt) > Date.parse(e.observedAt) + 300_000) throw new TypeError('Bounded exact policy identity observation required.');
  if (e.kind === 'mfa' && (e.intent.environment !== e.environment || e.intent.organizationId !== e.organizationId || canonicalJson(e.intent.approver) !== canonicalJson(e.actor) ||
    e.verifiedAt !== new Date(Date.parse(e.tokenIssuedAt) - (Math.max(e.firstFactorAgeMinutes, e.secondFactorAgeMinutes) + 1) * 60_000).toISOString() ||
    Date.parse(e.expiresAt) > Date.parse(e.verifiedAt) + 300_000 || e.intentHash !== await commandDigest(e.intent) ||
    e.requestHash !== await commandDigest({ schemaVersion: 1, purpose: e.purpose, request: { nonce: e.intent.nonce, key: e.intent.key, intent: e.intent } }))) throw new TypeError('Exact fresh policy-purpose MFA evidence required.');
  return e;
}
/** Caller is a private provider verifier, never the policy authorizer or a browser. */
export class PostgresFinancialAuthenticationRepository {
  constructor(private readonly pool: Pool) {}
  async append(input: FinancialAuthEvidence) {
    const evidence = await validateFinancialAuthEvidence(input);
    const hash = await commandDigest({ namespace: 'pactwoven:financial-policy-evidence:v1', record: evidence });
    return financialPolicyTransaction(this.pool, 'verifier', async c => {
      const parsed = FinancialPolicyRefSchema.safeParse(financialPolicyOne((await c.query('SELECT pactwoven.financial_policy_attest($1::jsonb) AS response', [JSON.stringify(evidence)])).rows));
      if (!parsed.success || parsed.data.id !== evidence.id || parsed.data.version !== 1 || parsed.data.recordHash !== hash) throw financialPolicyOutcomeUnknown(); return parsed.data;
    });
  }
}
