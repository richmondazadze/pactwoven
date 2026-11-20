import type { FinanceDeliveryReceipt, FinanceProvenanceAppend, FinanceProvenanceLookup, FinanceProvenanceResult } from '@pactwoven/contracts';

/** Private authenticated observer seam; it neither qualifies evidence nor authorizes funds. */
export interface FinanceProvenanceRepository {
  append(input: FinanceProvenanceAppend): Promise<FinanceProvenanceResult>;
  get(input: FinanceProvenanceLookup): Promise<FinanceDeliveryReceipt | null>;
}
export const financeProvenanceTables = Object.freeze([
  'finance_physical_assets', 'finance_asset_versions', 'finance_asset_controls', 'finance_physical_accounts',
  'finance_account_versions', 'finance_account_controls', 'finance_sources', 'finance_source_versions',
  'finance_source_controls', 'finance_source_bindings', 'finance_transfer_facts', 'finance_account_effects',
  'finance_deliveries', 'finance_observation_links', 'finance_provenance_conflicts',
] as const);
export const financeProvenanceRoutines = Object.freeze([
  'pactwoven.append_finance_provenance(jsonb)', 'pactwoven.read_finance_provenance(text,text,text)',
] as const);
