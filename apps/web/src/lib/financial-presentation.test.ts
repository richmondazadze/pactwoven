import { describe, expect, it } from 'vitest';
import { FINANCE_DEVNET_ASSET, FinancialPolicyHttpAssetContextSchema } from '@pactwoven/contracts';
import { financialAmount } from './financial-presentation';

const pin = { key: 'b'.repeat(64), version: 1, recordHash: 'a'.repeat(64), financialUseEpoch: 0 };
const asset = FinancialPolicyHttpAssetContextSchema.parse({ ...FINANCE_DEVNET_ASSET, pin, decimals: 6, policy: 'solana-original-devnet-usdc-v1' });
describe('exact financial amount presentation', () => {
  it.each([['0', '0'], ['1', '0.000001'], ['999999', '0.999999'], ['1000000', '1'], ['1250000', '1.25'], ['18446744073709551615', '18,446,744,073,709.551615']])('formats %s without floating point or rounding', (value, expected) => {
    expect(financialAmount(value, pin, asset)).toBe(`${expected} USDC (devnet)`);
  });
  it('never infers precision from only a key or a matching version', () => {
    for (const altered of [{ ...pin, key: 'c'.repeat(64) }, { ...pin, version: 2 }, { ...pin, recordHash: 'c'.repeat(64) }, { ...pin, financialUseEpoch: 1 }]) {
      expect(financialAmount('1234567', altered, asset)).toBe('1234567 base units');
    }
    expect(financialAmount('1234567', pin)).toBe('1234567 base units');
    expect(financialAmount('1234567', pin, null)).toBe('1234567 base units');
  });
  it('does not convert malformed amounts or unverified physical-asset metadata', () => {
    expect(financialAmount('-1', pin, asset)).toBe('-1 base units');
    expect(financialAmount('1.5', pin, asset)).toBe('1.5 base units');
    expect(financialAmount('1000000', pin, { ...asset, mint: 'c'.repeat(32) })).toBe('1000000 base units');
  });
});
