import { describe, expect, it } from 'vitest';
import type { FinancialAuthorityFence, FinancialAuthorityHistory } from '@pactwoven/contracts';
import { financialAuthorityFenceHash, nextFinancialFenceGeneration, verifyFinancialAuthorityHistory } from './financial-fences';

const none: FinancialAuthorityFence = { schemaVersion: 1, environment: 'development', organizationId: 'org_a',
  responsibility: { id: 'responsibility_a', version: 1, hash: 'a'.repeat(64), siteId: 'site_a' }, generation: 0, family: 'none', legacyHead: null };
const legacy: FinancialAuthorityFence = { ...none, generation: 1, family: 'legacy', legacyHead: { mandateId: 'mandate_a', mandateVersion: 1, mandateEpoch: 1, hash: 'b'.repeat(64), state: 'ACTIVE' } };
const start: FinancialAuthorityHistory = { previous: null, current: none, basis: 'initial', operationId: null };
const select: FinancialAuthorityHistory = { previous: none, current: legacy, basis: 'legacy_head', operationId: 'operation_a' };
describe('financial reference history integrity', () => {
  it('accepts exact history without granting a capability', () => {
    expect(verifyFinancialAuthorityHistory([start, select], legacy)).toBeUndefined();
    const backfill = { ...legacy, generation: 0, legacyHead: { ...legacy.legacyHead!, mandateEpoch: 31 } };
    expect(verifyFinancialAuthorityHistory([{ previous: null, current: backfill, basis: 'migration_backfill', operationId: 'old_operation' }], backfill)).toBeUndefined();
  });
  it('rejects omitted intermediates, changed final pointers, cross-scope and head replacement during responsibility invalidation', () => {
    expect(() => verifyFinancialAuthorityHistory([select], legacy)).toThrow();
    expect(() => verifyFinancialAuthorityHistory([start], legacy)).toThrow();
    const changed: FinancialAuthorityHistory = { previous: legacy, current: { ...legacy, generation: 2, responsibility: { ...legacy.responsibility, version: 2 }, legacyHead: { ...legacy.legacyHead!, state: 'PAUSED' } }, basis: 'responsibility_change', operationId: null };
    expect(() => verifyFinancialAuthorityHistory([start, select, changed], changed.current)).toThrow();
    const skipped: FinancialAuthorityHistory = { ...select, current: { ...legacy, legacyHead: { ...legacy.legacyHead!, mandateEpoch: 3 } } };
    expect(() => verifyFinancialAuthorityHistory([start, skipped], skipped.current)).toThrow();
  });
  it('bounds monotonic generations without wrapping and binds hash to every selected field', async () => {
    expect(nextFinancialFenceGeneration(0)).toBe(1);
    for (const value of [2_147_483_647, -1, 0.5, NaN]) expect(() => nextFinancialFenceGeneration(value)).toThrow();
    expect(await financialAuthorityFenceHash(none)).not.toBe(await financialAuthorityFenceHash({ ...none, generation: 1 }));
    expect(await financialAuthorityFenceHash(legacy)).not.toBe(await financialAuthorityFenceHash({ ...legacy, legacyHead: { ...legacy.legacyHead!, mandateEpoch: 2 } }));
  });
});
