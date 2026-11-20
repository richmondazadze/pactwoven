import { describe, expect, it } from 'vitest';
import { B2bFinancialBasisRefsV1Schema, B2bFinancialTrustRefsV1Schema, FinancialAuthorityFenceSchema,
  FinancialAuthorityHistorySchema, FinancialRegistryFenceSchema, FinancialFenceGenerationSchema, type B2bFinancialTrustRefsV1 } from './financial-fences';

const hash = 'a'.repeat(64), other = 'b'.repeat(64);
const none = { schemaVersion: 1 as const, environment: 'development' as const, organizationId: 'org_a',
  responsibility: { id: 'responsibility_a', version: 1, hash, siteId: 'site_a' }, generation: 0, family: 'none' as const, legacyHead: null };
const pin = { key: hash, version: 1, recordHash: other, financialUseEpoch: 0 };
const qualification = { id: 'qualification_a', version: 1, recordHash: hash, control: { key: other, epoch: 0 } };
const trust: B2bFinancialTrustRefsV1 = { schemaVersion: 1, environment: 'development', organizationId: 'org_a', asset: pin, account: pin,
  assetQualification: { kind: 'asset', ...qualification }, custodyQualification: { kind: 'custody', ...qualification },
  sources: [{ id: 'source_a', version: 1, recordHash: hash, financialUseEpoch: 0,
    binding: { accountKey: hash, recordHash: other, financialUseEpoch: 0 }, qualification: { kind: 'source', ...qualification } }] };
describe('inert financial fence contracts', () => {
  it('has no financial family or qualification flag and requires one selected head', () => {
    expect(FinancialAuthorityFenceSchema.parse(none)).toEqual(none);
    for (const patch of [{ family: 'financial' }, { family: 'legacy' }, { qualified: true }, { legacyHead: {} }, { generation: -1 }, { generation: 2 ** 31 }])
      expect(FinancialAuthorityFenceSchema.safeParse({ ...none, ...patch }).success).toBe(false);
    expect(FinancialFenceGenerationSchema.safeParse(2_147_483_647).success).toBe(true);
  });
  it('requires exact scoped, contiguous histories and original legacy operations', () => {
    expect(FinancialAuthorityHistorySchema.safeParse({ previous: null, current: none, basis: 'initial', operationId: null }).success).toBe(true);
    for (const history of [
      { previous: null, current: { ...none, generation: 1 }, basis: 'migration_backfill', operationId: null },
      { previous: none, current: { ...none, generation: 1, organizationId: 'org_b' }, basis: 'responsibility_change', operationId: null },
      { previous: none, current: { ...none, generation: 2 }, basis: 'responsibility_change', operationId: null },
      { previous: null, current: none, basis: 'initial', operationId: 'forged' },
    ]) expect(FinancialAuthorityHistorySchema.safeParse(history).success).toBe(false);
  });
  it('separates stable trust from moving basis and binds sorted unique sources to the exact account', () => {
    expect(B2bFinancialTrustRefsV1Schema.parse(trust)).toEqual(trust);
    expect(B2bFinancialBasisRefsV1Schema.safeParse({ trust }).success).toBe(false);
    for (const sources of [[], [trust.sources[0]!, trust.sources[0]!], [{ ...trust.sources[0]!, binding: { ...trust.sources[0]!.binding, accountKey: other } }],
      [{ ...trust.sources[0]!, id: 'source_b' }, trust.sources[0]!]]) expect(B2bFinancialTrustRefsV1Schema.safeParse({ ...trust, sources }).success).toBe(false);
    expect(B2bFinancialTrustRefsV1Schema.safeParse({ ...trust, qualified: true }).success).toBe(false);
    expect(B2bFinancialTrustRefsV1Schema.safeParse({ ...trust, assetQualification: { ...qualification, kind: 'source' } }).success).toBe(false);
  });
  it('distinguishes physical registry keys from source IDs and requires binding identity', () => {
    const record = { schemaVersion: 1, kind: 'asset', key: hash, accountKey: null, generation: 0, controlHash: hash };
    expect(FinancialRegistryFenceSchema.safeParse(record).success).toBe(true);
    for (const patch of [{ kind: 'binding' }, { key: 'source_a' }, { accountKey: hash }, { controlHash: hash.toUpperCase() }])
      expect(FinancialRegistryFenceSchema.safeParse({ ...record, ...patch }).success).toBe(false);
  });
});
