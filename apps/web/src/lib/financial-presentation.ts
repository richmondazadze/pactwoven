import { FinancialPolicyHttpAssetContextSchema, type FinancialPolicyHttpAssetContext, type FinancialPolicyHttpRecord } from '@pactwoven/contracts';

export function financialRecordName(record: FinancialPolicyHttpRecord): string {
  if (record.kind === 'draft') return 'Financial configuration draft';
  if (record.kind === 'governance') return 'Budget configuration';
  return record.purpose === 'financial_mandate' ? 'Financial mandate text' : record.purpose === 'budget_policy' ? 'Budget policy text' : 'Approval policy text';
}

/** String arithmetic preserves all integer precision, including amounts above Number.MAX_SAFE_INTEGER. */
export function financialAmount(value: string, pin: FinancialPolicyHttpAssetContext['pin'], asset?: FinancialPolicyHttpAssetContext | null): string {
  const parsed = FinancialPolicyHttpAssetContextSchema.safeParse(asset);
  if (!parsed.success || !/^(0|[1-9]\d*)$/.test(value) || parsed.data.pin.key !== pin.key ||
    parsed.data.pin.version !== pin.version || parsed.data.pin.recordHash !== pin.recordHash || parsed.data.pin.financialUseEpoch !== pin.financialUseEpoch) return `${value} base units`;
  const digits = value.padStart(parsed.data.decimals + 1, '0');
  const whole = digits.slice(0, -parsed.data.decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = digits.slice(-parsed.data.decimals).replace(/0+$/, '');
  return `${whole}${fraction ? `.${fraction}` : ''} USDC (devnet)`;
}
