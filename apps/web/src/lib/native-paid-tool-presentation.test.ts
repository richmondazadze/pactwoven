import { describe, expect, it } from 'vitest';
import { paidToolAmount, paidToolReceipt, paidToolReceiptKey } from './native-paid-tool-presentation';
import { paidToolFixture } from './native-paid-tool.test-fixtures';

describe('paid-tool display boundary', () => {
  it('formats token integers exactly without floating point', () => {
    expect(paidToolAmount({ baseUnits: '18446744073709551615', decimals: 9, symbol: 'test SOL' })).toBe('18,446,744,073.709551615 test SOL');
    expect(paidToolAmount({ baseUnits: '10000', decimals: 6, symbol: 'devnet USDC' })).toBe('0.01 devnet USDC');
    expect(paidToolAmount({ baseUnits: '0', decimals: 6, symbol: 'devnet USDC' })).toBe('0 devnet USDC');
  });
  it('rejects malformed provider-shaped values and unsafe signatures', () => {
    expect(paidToolReceipt({ ...paidToolFixture(), privateWire: 'secret' })).toBeNull();
    const view = paidToolFixture(); view.transaction!.signature = 'https://evil.test';
    expect(paidToolReceipt(view)).toBeNull();
  });
  it('resets local confirmations for scope/version/revision/action/evidence changes', () => {
    const base = paidToolFixture(), key = paidToolReceiptKey(base);
    for (const update of [{ version: 2 }, { instructionRevision: 1 }, { operationId: 'other' }, { actions: [] }, { resultApplicability: 'unavailable' as const }, { scope: { ...base.scope, siteId: 'other' } }]) {
      expect(paidToolReceiptKey({ ...base, ...update })).not.toBe(key);
    }
  });
});
