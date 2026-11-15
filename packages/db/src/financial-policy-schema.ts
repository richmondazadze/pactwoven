import type { FinancialPolicyCommand, FinancialPolicyResult, FinancialPolicyLookup, FinancialPolicyReadQuery, FinancialPolicyListQuery,
  FinancialPolicyRead, FinancialPolicyPage } from '@pactwoven/contracts';

export interface FinancialPolicyRepository {
  mutate(identityEvidenceId: string, command: FinancialPolicyCommand): Promise<FinancialPolicyResult>;
  readFinancialPolicy(identityEvidenceId: string, query: FinancialPolicyReadQuery): Promise<FinancialPolicyRead | null>;
  listFinancialPolicyDrafts(identityEvidenceId: string, query: FinancialPolicyListQuery): Promise<FinancialPolicyPage>;
  readFinancialPolicyOperation(identityEvidenceId: string, query: FinancialPolicyLookup): Promise<FinancialPolicyResult | null>;
}
export type FinancialAuthorityCapability = 'authorizer' | 'verifier';
export const financialPolicyTables = Object.freeze(['financial_policy_principals', 'financial_policy_evidence', 'financial_policy_records',
  'financial_policy_operations', 'financial_policy_audit', 'financial_policy_outbox', 'financial_policy_evidence_uses',
  'financial_budget_accounts', 'financial_budget_periods', 'financial_governance_controls'] as const);
export const financialPolicyRoutines = Object.freeze({
  authorizer: ['pactwoven.financial_policy_command(uuid,jsonb)', 'pactwoven.financial_policy_read(uuid,jsonb)',
    'pactwoven.financial_policy_list(uuid,jsonb)', 'pactwoven.financial_policy_recover(uuid,jsonb)'],
  verifier: ['pactwoven.financial_policy_attest(jsonb)'],
} as const);
