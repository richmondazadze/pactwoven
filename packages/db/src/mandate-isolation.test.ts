import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { assertLegacyMandateIsolation } from './mandate-isolation.js';
import { assertRuntimePool, assertUnprivilegedPool } from './repository.js';
import { assertProvisionerPool } from './provisioner.js';
import { assertAccessPool } from './access-repository.js';

const unprivileged = { switched_role: false, privileged: false, owns_schema: false, owns_table: false, can_create: false };
const isolated = { principals_found: true, mandate_capable: false };
const recoveryIsolated = { isolated: true, ready: false, isolationSupported: true };
const malformed = [undefined, null, {}, { rows: undefined }, { rows: {} }, { rows: [] }, { rows: [null] }, { rows: [{}] },
  { rows: [isolated, isolated] }, { rows: [{ principals_found: true }] }, { rows: [{ mandate_capable: false }] },
  { rows: [{ principals_found: true, mandate_capable: 0 }] }, { rows: [{ principals_found: 1, mandate_capable: false }] },
  { rows: [{ principals_found: true, mandate_capable: 'false' }] }];

describe('legacy mandate isolation result validation', () => {
  it('requires one explicit successfully resolved, isolated capability result', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [isolated] });
    await expect(assertLegacyMandateIsolation({ query } as unknown as Pool)).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledOnce();
  });
  it.each(malformed.map((value, index) => ({ value, index })))('rejects malformed query result $index', async ({ value }) => {
    await expect(assertLegacyMandateIsolation({ query: vi.fn().mockResolvedValue(value) } as unknown as Pool))
      .rejects.toMatchObject({ code: 'UNSAFE_DATABASE_ROLE' });
  });
  it.each([{ principals_found: true, mandate_capable: true }, { principals_found: false, mandate_capable: false }])
    ('rejects a reachable mandate capability or unresolved database principal', async row => {
      await expect(assertLegacyMandateIsolation({ query: vi.fn().mockResolvedValue({ rows: [row] }) } as unknown as Pool))
        .rejects.toMatchObject({ code: 'UNSAFE_DATABASE_ROLE' });
    });
  it('never treats a failed catalog query as isolated credentials', async () => {
    const error = new Error('catalog query unavailable');
    await expect(assertLegacyMandateIsolation({ query: vi.fn().mockRejectedValue(error) } as unknown as Pool)).rejects.toBe(error);
  });
});

describe('unprivileged role result validation', () => {
  it.each([undefined, null, {}, { rows: [] }, { rows: [{}] }, { rows: [null] }, { rows: [unprivileged, unprivileged] }])
    ('rejects missing or ambiguous privilege results', async result => {
      await expect(assertUnprivilegedPool({ query: vi.fn().mockResolvedValue(result) } as unknown as Pool))
        .rejects.toMatchObject({ code: 'UNSAFE_DATABASE_ROLE' });
    });
  it.each(Object.keys(unprivileged))('requires an explicit false boolean for %s', async field => {
    for (const value of [undefined, null, 0, 'false', true]) {
      await expect(assertUnprivilegedPool({ query: vi.fn().mockResolvedValue({ rows: [{ ...unprivileged, [field]: value }] }) } as unknown as Pool))
        .rejects.toMatchObject({ code: 'UNSAFE_DATABASE_ROLE' });
    }
  });
});

describe.each([
  { name: 'runtime', guard: assertRuntimePool, legacy: { can_provision: false } },
  { name: 'bootstrap', guard: assertProvisionerPool, legacy: { provisioner: true, runtime: false, table_access: false, access: false } },
  { name: 'access', guard: assertAccessPool, legacy: { access: true, other: false, tables: false } },
])('$name pool composes mandate isolation', ({ guard, legacy }) => {
  it('accepts all explicit safe capability checks', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [unprivileged] }).mockResolvedValueOnce({ rows: [isolated] })
      .mockResolvedValueOnce({ rows: [recoveryIsolated] }).mockResolvedValueOnce({ rows: [legacy] });
    await expect(guard({ query } as unknown as Pool)).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledTimes(4);
  });
  it('rejects mandate capability even when its normal legacy capability is valid', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [unprivileged] })
      .mockResolvedValueOnce({ rows: [{ principals_found: true, mandate_capable: true }] }).mockResolvedValueOnce({ rows: [legacy] });
    await expect(guard({ query } as unknown as Pool)).rejects.toMatchObject({ code: 'UNSAFE_DATABASE_ROLE' });
    expect(query).toHaveBeenCalledTimes(2);
  });
  it.each([{}, { rows: [] }, { rows: [{}] }, { rows: [legacy, legacy] }])('rejects missing or malformed legacy capabilities', async result => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [unprivileged] }).mockResolvedValueOnce({ rows: [isolated] })
      .mockResolvedValueOnce({ rows: [recoveryIsolated] }).mockResolvedValueOnce(result);
    await expect(guard({ query } as unknown as Pool)).rejects.toMatchObject({ code: 'UNSAFE_DATABASE_ROLE' });
    expect(query).toHaveBeenCalledTimes(4);
  });
  it('rejects recovery storage capability before accepting a valid legacy role', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [unprivileged] }).mockResolvedValueOnce({ rows: [isolated] })
      .mockResolvedValueOnce({ rows: [{ ...recoveryIsolated, isolated: false }] }).mockResolvedValueOnce({ rows: [legacy] });
    await expect(guard({ query } as unknown as Pool)).rejects.toMatchObject({ code: 'UNSAFE_DATABASE_ROLE' });
    expect(query).toHaveBeenCalledTimes(3);
  });
});
