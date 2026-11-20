import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { FinancialPolicyHttpReceipt } from '@pactwoven/contracts';
import { createFinancialPolicyAttempt, type FinancialPolicyReference } from './financial-policy-contract';
import { storeFinancialPolicyReference, listFinancialPolicyReferences, financialPolicyReferenceKey,
  assertFinancialPolicyReference, clearFinancialPolicyReminder, createFinancialPolicyMemory,
  FINANCIAL_POLICY_REFERENCE_LIMIT, type FinancialPolicyStorage } from './financial-policy-recovery';

function storage() {
  const values = new Map<string, string>();
  const adapter: FinancialPolicyStorage = { get length() { return values.size; }, key: i => [...values.keys()][i] ?? null,
    getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); } };
  return { values, adapter };
}
const scope = { environment: 'development' as const, organizationId: 'org_a', actorId: 'owner_a', responsibilityId: null, apiBase: 'https://api.example.test' };
async function fixture(key = 'original_policy_001') {
  const text = 'Exact policy text that must remain in private memory.';
  const attempt = await createFinancialPolicyAttempt(scope, { kind: 'save_document', responsibilityId: null, id: 'policy_a', key,
    route: '/v1/financial-governance/documents/policy_a', input: { schemaVersion: 1, previous: null, organizationEpoch: 2, purpose: 'budget_policy', text } });
  const actor = { actorId: scope.actorId, membershipVersion: 1 }, operationId = '00000000-0000-0000-0000-000000000001';
  const receipt: FinancialPolicyHttpReceipt = { schemaVersion: 1, environment: scope.environment, organizationId: scope.organizationId, actor, responsibilityId: null,
    operationId, kind: 'save_document', key, publicRequestHash: attempt.reference.locator.publicRequestHash,
    target: { id: 'policy_a', version: 1, recordHash: 'a'.repeat(64) }, effectiveAuthority: false, financialState: null,
    record: { schemaVersion: 1, environment: scope.environment, organizationId: scope.organizationId, actor, responsibilityId: null,
      id: 'policy_a', version: 1, predecessor: null, operationId, organizationEpoch: 2, createdAt: '2026-11-15T00:00:00.000Z', kind: 'document', purpose: 'budget_policy', text,
      contentHash: createHash('sha256').update(JSON.stringify({ namespace: 'pactwoven:financial-policy-text:v1', text })).digest('hex') } };
  return { attempt, receipt, ...storage() };
}
describe('reference-only financial policy session storage', () => {
  it('stores only canonical local identity and original locator, with no content or provider identity', async () => {
    const f = await fixture(); storeFinancialPolicyReference(f.adapter, f.attempt.reference);
    const raw = assertFinancialPolicyReference(f.adapter, f.attempt.reference);
    expect(raw).not.toMatch(/private memory|sessionId|userId|externalOrganizationId|text|record|token/);
    expect(listFinancialPolicyReferences(f.adapter, scope)).toEqual({ blocked: false, references: [f.attempt.reference] });
    expect(listFinancialPolicyReferences(f.adapter, { ...scope, actorId: 'other' }).references).toEqual([]);
    expect(listFinancialPolicyReferences(f.adapter, { ...scope, apiBase: 'https://other.test' }).references).toEqual([]);
  });
  it('preserves the first original when its key collides with changed material or target', async () => {
    const f = await fixture(); storeFinancialPolicyReference(f.adapter, f.attempt.reference);
    const before = [...f.values];
    for (const change of [{ targetId: 'other' }, { publicRequestHash: 'f'.repeat(64) }]) {
      const reference = { ...f.attempt.reference, locator: { ...f.attempt.reference.locator, ...change } };
      expect(() => storeFinancialPolicyReference(f.adapter, reference)).toThrow(); expect([...f.values]).toEqual(before);
    }
    storeFinancialPolicyReference(f.adapter, f.attempt.reference); expect(f.values.size).toBe(1);
  });
  it.each(['malformed', 'private-extra', 'duplicate', 'whitespace', 'wrong-key', 'oversized', 'denied'])(
    'blocks %s inventories without deleting evidence', async mode => {
      const f = await fixture(); storeFinancialPolicyReference(f.adapter, f.attempt.reference);
      const key = financialPolicyReferenceKey(f.attempt.reference), raw = f.values.get(key)!;
      if (mode === 'malformed') f.values.set(key, '{');
      if (mode === 'private-extra') f.values.set(key, raw.slice(0, -1) + ',"token":"private"}');
      if (mode === 'duplicate') f.values.set(key, raw.slice(0, -1) + ',"schemaVersion":1}');
      if (mode === 'whitespace') f.values.set(key, ' ' + raw);
      if (mode === 'wrong-key') { f.values.delete(key); f.values.set(key + 'alias', raw); }
      if (mode === 'oversized') f.values.set(key, ' '.repeat(8193));
      if (mode === 'denied') f.adapter.getItem = () => { throw Error('Storage denied'); };
      const before = [...f.values]; expect(listFinancialPolicyReferences(f.adapter, scope).blocked).toBe(true);
      expect(() => storeFinancialPolicyReference(f.adapter, f.attempt.reference)).toThrow(); expect([...f.values]).toEqual(before);
    });
  it('bounds the global reference namespace and checks storage read-back', async () => {
    const f = await fixture();
    for (let i = 0; i < FINANCIAL_POLICY_REFERENCE_LIMIT; i++) {
      const r: FinancialPolicyReference = { ...f.attempt.reference, locator: { ...f.attempt.reference.locator, key: `original_policy_${i}` } };
      storeFinancialPolicyReference(f.adapter, r);
    }
    expect(() => storeFinancialPolicyReference(f.adapter, f.attempt.reference)).toThrow(); expect(f.values.size).toBe(FINANCIAL_POLICY_REFERENCE_LIMIT);
    const bad = storage(); bad.adapter.setItem = () => {};
    expect(() => storeFinancialPolicyReference(bad.adapter, f.attempt.reference)).toThrow();
  });
  it('requires a qualified exact receipt and an unchanged stored byte sequence to clear separately', async () => {
    const f = await fixture(); storeFinancialPolicyReference(f.adapter, f.attempt.reference);
    await expect(clearFinancialPolicyReminder(f.adapter, f.attempt.reference, { ...f.receipt, key: 'wrong_original' }, () => true)).rejects.toBeDefined();
    expect(f.values.size).toBe(1);
    const pending = clearFinancialPolicyReminder(f.adapter, f.attempt.reference, f.receipt, () => true);
    const key = financialPolicyReferenceKey(f.attempt.reference); f.values.set(key, f.values.get(key)! + ' ');
    await expect(pending).rejects.toMatchObject({ code: 'storage' }); expect(f.values.size).toBe(1);
    f.values.clear(); storeFinancialPolicyReference(f.adapter, f.attempt.reference);
    await expect(clearFinancialPolicyReminder(f.adapter, f.attempt.reference, f.receipt, () => false)).rejects.toMatchObject({ code: 'storage' });
    await clearFinancialPolicyReminder(f.adapter, f.attempt.reference, f.receipt, () => true); expect(f.values.size).toBe(0);
  });
});
describe('ephemeral original and immutable receipt model', () => {
  it('keeps full intents and receipts only in memory until an explicit clear action', async () => {
    const f = await fixture(), memory = createFinancialPolicyMemory(scope); storeFinancialPolicyReference(f.adapter, f.attempt.reference);
    await memory.retain(f.attempt); const before = [...f.values];
    await memory.record(f.attempt.reference, f.receipt); expect([...f.values]).toEqual(before);
    expect(memory.original(f.attempt.reference)).toEqual(f.attempt); expect(memory.recorded(f.attempt.reference)).toEqual(f.receipt);
    expect(Object.isFrozen(memory.recorded(f.attempt.reference)?.record)).toBe(true);
    await memory.clearReminder(f.adapter, f.attempt.reference); expect(f.values.size).toBe(0);
    expect(memory.recorded(f.attempt.reference)).toEqual(f.receipt);
  });
  it('does not clear an unresolved original or overwrite an immutable receipt', async () => {
    const f = await fixture(), memory = createFinancialPolicyMemory(scope); storeFinancialPolicyReference(f.adapter, f.attempt.reference);
    await memory.retain(f.attempt);
    await expect(memory.clearReminder(f.adapter, f.attempt.reference)).rejects.toMatchObject({ code: 'storage' });
    await memory.record(f.attempt.reference, f.receipt);
    const changed = { ...f.receipt, target: { ...f.receipt.target, recordHash: 'f'.repeat(64) } };
    await expect(memory.record(f.attempt.reference, changed)).rejects.toMatchObject({ code: 'unconfirmed' });
    expect(memory.recorded(f.attempt.reference)).toEqual(f.receipt); expect(f.values.size).toBe(1);
  });
  it('clears private state synchronously and rejects pending work after hide or close', async () => {
    const f = await fixture(), memory = createFinancialPolicyMemory(scope); storeFinancialPolicyReference(f.adapter, f.attempt.reference);
    const pending = memory.retain(f.attempt); memory.clear();
    await expect(pending).rejects.toMatchObject({ code: 'scope' }); expect(memory.original(f.attempt.reference)).toBeNull();
    await memory.retain(f.attempt); const receipt = memory.record(f.attempt.reference, f.receipt); memory.close();
    await expect(receipt).rejects.toMatchObject({ code: 'scope' }); expect(() => memory.original(f.attempt.reference)).toThrow();
    expect(f.values.size).toBe(1);
  });
  it('checks late transport guards before making a receipt visible', async () => {
    const f = await fixture(), memory = createFinancialPolicyMemory(scope);
    await expect(memory.record(f.attempt.reference, f.receipt, () => { throw Error('Ended'); })).rejects.toThrow('Ended');
    expect(memory.recorded(f.attempt.reference)).toBeNull();
  });
  it.each(['material', 'target', 'exact'])('rechecks a queued %s retain against the receipt that commits first', async mode => {
    const f = await fixture(), memory = createFinancialPolicyMemory(scope);
    if (f.attempt.request.kind !== 'save_document') throw Error('fixture');
    const retainedAttempt = mode === 'exact' ? f.attempt : await createFinancialPolicyAttempt(scope, {
      ...f.attempt.request,
      ...(mode === 'target' ? { id: 'policy_b', route: '/v1/financial-governance/documents/policy_b' } : {}),
      input: { ...f.attempt.request.input, text: mode === 'material' ? 'Conflicting reviewed terms.' : f.attempt.request.input.text },
    });
    storeFinancialPolicyReference(f.adapter, f.attempt.reference); const storedBefore = [...f.values];
    let finishDigest!: (value: ArrayBuffer) => void;
    const delayed = new Promise<ArrayBuffer>(resolve => { finishDigest = resolve; });
    const spy = vi.spyOn(crypto.subtle, 'digest').mockReturnValueOnce(delayed);
    try {
      const recorded = memory.record(f.attempt.reference, f.receipt);
      await vi.waitFor(() => expect(spy).toHaveBeenCalledOnce());
      const retained = memory.retain(retainedAttempt);
      if (f.receipt.record.kind !== 'document') throw Error('fixture');
      finishDigest(Uint8Array.from(Buffer.from(f.receipt.record.contentHash, 'hex')).buffer);
      const results = await Promise.allSettled([recorded, retained]);
      expect(results.map(result => result.status)).toEqual(['fulfilled', mode === 'exact' ? 'fulfilled' : 'rejected']);
      expect(memory.recorded(f.attempt.reference)).toEqual(f.receipt);
      expect(memory.original(f.attempt.reference)).toEqual(mode === 'exact' ? f.attempt : null);
      expect([...f.values]).toEqual(storedBefore);
      if (mode !== 'exact') expect(() => memory.original(retainedAttempt.reference)).toThrow();
    } finally { spy.mockRestore(); }
  });
  it('rejects both digest-pending and queued commits after invalidation while retaining the reminder', async () => {
    const f = await fixture(), memory = createFinancialPolicyMemory(scope);
    storeFinancialPolicyReference(f.adapter, f.attempt.reference);
    let finishDigest!: (value: ArrayBuffer) => void;
    const delayed = new Promise<ArrayBuffer>(resolve => { finishDigest = resolve; });
    const spy = vi.spyOn(crypto.subtle, 'digest').mockReturnValueOnce(delayed);
    try {
      const recorded = memory.record(f.attempt.reference, f.receipt);
      await vi.waitFor(() => expect(spy).toHaveBeenCalledOnce());
      const retained = memory.retain(f.attempt), outcomes = Promise.allSettled([recorded, retained]);
      memory.clear();
      if (f.receipt.record.kind !== 'document') throw Error('fixture');
      finishDigest(Uint8Array.from(Buffer.from(f.receipt.record.contentHash, 'hex')).buffer);
      expect((await outcomes).map(result => result.status)).toEqual(['rejected', 'rejected']);
      expect(memory.original(f.attempt.reference)).toBeNull(); expect(memory.recorded(f.attempt.reference)).toBeNull();
      expect(f.values.size).toBe(1);
    } finally { spy.mockRestore(); }
  });
});
