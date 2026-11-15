/** FA-0 stores invalidation and legacy selection only; it grants no financial capability. */
export const financialFenceTables = Object.freeze([
  'financial_authority_fences', 'financial_authority_history', 'financial_site_fences', 'financial_site_history',
  'financial_asset_fences', 'financial_account_fences', 'financial_source_fences', 'financial_source_binding_fences', 'financial_registry_history',
] as const);
export const financialFenceControlRoutines = Object.freeze([
  'pactwoven.financial_update_site_control(text,text,text,integer,text,text,text,boolean)',
  'pactwoven.financial_update_asset_control(text,integer,text,integer,boolean,timestamp with time zone)',
  'pactwoven.financial_update_account_control(text,integer,text,integer,boolean,timestamp with time zone)',
  'pactwoven.financial_update_source_control(text,integer,text,integer,boolean,timestamp with time zone)',
  'pactwoven.financial_update_source_binding_control(text,text,integer,text,boolean,timestamp with time zone)',
] as const);
