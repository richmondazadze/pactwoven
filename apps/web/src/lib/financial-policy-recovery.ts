import { canonicalJson } from '@pactwoven/contracts/canonical';
import { FinancialPolicyClientError, FinancialPolicyReferenceSchema, FinancialPolicyLocalScopeSchema,
  financialParse, financialSame, freezeFinancial, qualifyFinancialReceipt, qualifyFinancialClosure, verifyFinancialPolicyAttempt,
  type FinancialPolicyAttempt, type FinancialPolicyReference, type FinancialPolicyLocalScope,
  type FinancialPolicyQualifiedReceipt, type FinancialPolicyQualifiedClosure } from './financial-policy-contract';

export type FinancialPolicyStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;
export const FINANCIAL_POLICY_REFERENCE_PREFIX = 'pactwoven:financial-policy-original:v1:';
export const FINANCIAL_POLICY_REFERENCE_LIMIT = 24;
export const FINANCIAL_POLICY_REFERENCE_MAX_BYTES = 8192;
const failed = () => new FinancialPolicyClientError('storage');
const snapshot = (input: unknown) => freezeFinancial(financialParse(FinancialPolicyReferenceSchema, input));
export function financialPolicyReferenceKey(input: FinancialPolicyReference) {
  const { scope, locator } = snapshot(input);
  // A reused key under the same kind/scope must collide even if material changes.
  return FINANCIAL_POLICY_REFERENCE_PREFIX + canonicalJson({ scope, kind: locator.kind, key: locator.key });
}
function bytes(reference: FinancialPolicyReference) {
  const value = canonicalJson(reference);
  if (new TextEncoder().encode(value).byteLength > FINANCIAL_POLICY_REFERENCE_MAX_BYTES) throw failed();
  return value;
}
function inventory(storage: FinancialPolicyStorage | null): FinancialPolicyReference[] {
  if (!storage) throw failed();
  const count = storage.length;
  if (!Number.isSafeInteger(count) || count < 0 || count > 4096) throw failed();
  const references: FinancialPolicyReference[] = [], keys = new Set<string>();
  for (let i = 0; i < count; i++) {
    const key = storage.key(i); if (key === null || keys.has(key)) throw failed(); keys.add(key);
    if (!key.startsWith(FINANCIAL_POLICY_REFERENCE_PREFIX)) continue;
    if (references.length >= FINANCIAL_POLICY_REFERENCE_LIMIT || key.length > FINANCIAL_POLICY_REFERENCE_MAX_BYTES) throw failed();
    const raw = storage.getItem(key);
    if (raw === null || new TextEncoder().encode(raw).byteLength > FINANCIAL_POLICY_REFERENCE_MAX_BYTES) throw failed();
    // Canonical byte equality also rejects duplicate-key aliases and whitespace.
    const reference = snapshot(JSON.parse(raw));
    if (bytes(reference) !== raw || financialPolicyReferenceKey(reference) !== key) throw failed();
    references.push(reference);
  }
  if (storage.length !== count) throw failed();
  return references;
}
export function listFinancialPolicyReferences(storage: FinancialPolicyStorage | null, scopeInput: FinancialPolicyLocalScope) {
  try {
    const scope = financialParse(FinancialPolicyLocalScopeSchema, scopeInput);
    return freezeFinancial({ blocked: false, references: inventory(storage).filter(r => financialSame(r.scope, scope)) });
  } catch { return freezeFinancial({ blocked: true, references: [] as FinancialPolicyReference[] }); }
}
export function assertFinancialPolicyReference(storage: FinancialPolicyStorage | null, input: FinancialPolicyReference): string {
  try {
    const reference = snapshot(input), raw = storage?.getItem(financialPolicyReferenceKey(reference));
    if (raw !== bytes(reference)) throw failed(); return raw;
  } catch { throw failed(); }
}
export function storeFinancialPolicyReference(storage: FinancialPolicyStorage | null, input: FinancialPolicyReference): void {
  try {
    if (!storage) throw failed();
    const reference = snapshot(input), key = financialPolicyReferenceKey(reference), raw = bytes(reference);
    const references = inventory(storage), current = storage.getItem(key);
    if (current !== null) { if (current !== raw) throw failed(); return; }
    if (references.length >= FINANCIAL_POLICY_REFERENCE_LIMIT) throw failed();
    // Do not overwrite a reference that appeared during inventory inspection.
    if (storage.getItem(key) !== null) throw failed();
    storage.setItem(key, raw); assertFinancialPolicyReference(storage, reference);
  } catch { throw failed(); }
}
/** Explicit settlement only. A negative lookup or failed read never calls this. */
export async function clearFinancialPolicyReminder(storage: FinancialPolicyStorage | null, input: FinancialPolicyReference,
  receiptInput: FinancialPolicyQualifiedReceipt, isCurrent: () => boolean): Promise<void> {
  const reference = snapshot(input), raw = assertFinancialPolicyReference(storage, reference);
  // The exact immutable receipt is qualified anew; it never supplies current state.
  await qualifyFinancialReceipt(receiptInput, reference);
  try {
    if (!storage || !isCurrent() || storage.getItem(financialPolicyReferenceKey(reference)) !== raw) throw failed();
    storage.removeItem(financialPolicyReferenceKey(reference));
    if (storage.getItem(financialPolicyReferenceKey(reference)) !== null) throw failed();
  } catch { throw failed(); }
}
/** A closure is its own proof; it must never pass through policy-receipt clearing or document selection. */
export async function clearClosedFinancialPolicyReminder(storage: FinancialPolicyStorage | null, input: FinancialPolicyReference,
  closureInput: FinancialPolicyQualifiedClosure, isCurrent: () => boolean): Promise<void> {
  const reference = snapshot(input), raw = assertFinancialPolicyReference(storage, reference);
  await qualifyFinancialClosure(closureInput, reference);
  try {
    if (!storage || !isCurrent() || storage.getItem(financialPolicyReferenceKey(reference)) !== raw) throw failed();
    storage.removeItem(financialPolicyReferenceKey(reference));
    if (storage.getItem(financialPolicyReferenceKey(reference)) !== null) throw failed();
  } catch { throw failed(); }
}
/** Full public intents and receipts are ephemeral, never serialized to Storage. */
export function createFinancialPolicyMemory(scopeInput: FinancialPolicyLocalScope) {
  const scope = freezeFinancial(financialParse(FinancialPolicyLocalScopeSchema, scopeInput));
  const originals = new Map<string, FinancialPolicyAttempt>(), receipts = new Map<string, FinancialPolicyQualifiedReceipt>();
  const closures = new Map<string, FinancialPolicyQualifiedClosure>();
  const queued = new Map<string, Promise<unknown>>();
  let generation = 0, alive = true;
  function reference(input: FinancialPolicyReference) {
    const result = snapshot(input);
    if (!alive || !financialSame(result.scope, scope)) throw new FinancialPolicyClientError('scope');
    return result;
  }
  function exact(input: FinancialPolicyReference) {
    const r = reference(input), key = financialPolicyReferenceKey(r), original = originals.get(key), receipt = receipts.get(key), closure = closures.get(key);
    if (original && !financialSame(original.reference, r) || receipt && (receipt.publicRequestHash !== r.locator.publicRequestHash ||
      receipt.target.id !== r.locator.targetId || receipt.kind !== r.locator.kind || receipt.key !== r.locator.key || receipt.responsibilityId !== r.locator.responsibilityId) ||
      closure && !financialSame(closure.locator, r.locator))
      throw new FinancialPolicyClientError('input');
    return { r, key };
  }
  function serial<T>(key: string, work: () => Promise<T>): Promise<T> {
    const version = generation;
    const next = (queued.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
      if (!alive || generation !== version) throw new FinancialPolicyClientError('scope'); return work();
    });
    queued.set(key, next); void next.finally(() => { if (queued.get(key) === next) queued.delete(key); }).catch(() => {}); return next;
  }
  const size = () => new Set([...originals.keys(), ...receipts.keys(), ...closures.keys()]).size;
  function clear() { generation++; originals.clear(); receipts.clear(); closures.clear(); queued.clear(); }
  return {
    original(input: FinancialPolicyReference) { const { key } = exact(input); return originals.get(key) ?? null; },
    recorded(input: FinancialPolicyReference) { const { key } = exact(input); return receipts.get(key) ?? null; },
    closed(input: FinancialPolicyReference) { const { key } = exact(input); return closures.get(key) ?? null; },
    retain(input: FinancialPolicyAttempt) {
      // Clone before scheduling asynchronous digest work.
      const pending = structuredClone(input), { r, key } = exact(pending.reference), version = generation;
      return serial(key, async () => {
        const attempt = await verifyFinancialPolicyAttempt(pending);
        if (!alive || generation !== version) throw new FinancialPolicyClientError('scope');
        const existing = originals.get(key);
        if (!financialSame(attempt.reference, r) || existing && !financialSame(existing, attempt) || closures.has(key)) throw new FinancialPolicyClientError('input');
        if (!existing && size() >= FINANCIAL_POLICY_REFERENCE_LIMIT) throw failed();
        // A receipt may have committed while this retain waited in the queue.
        // Recheck both maps now; the pre-queue check is only an early rejection.
        exact(r);
        originals.set(key, attempt); return attempt;
      });
    },
    record(input: FinancialPolicyReference, receiptInput: FinancialPolicyQualifiedReceipt, guard: () => void = () => {}) {
      const { r, key } = exact(input), pending = structuredClone(receiptInput), version = generation;
      return serial(key, async () => {
        const receipt = await qualifyFinancialReceipt(pending, r, originals.get(key));
        guard();
        if (!alive || generation !== version) throw new FinancialPolicyClientError('scope');
        const existing = receipts.get(key);
        if (existing && !financialSame(existing, receipt) || closures.has(key)) throw new FinancialPolicyClientError('unconfirmed');
        if (!existing && !originals.has(key) && size() >= FINANCIAL_POLICY_REFERENCE_LIMIT) throw failed();
        exact(r);
        receipts.set(key, receipt); return receipt;
      });
    },
    recordClosure(input: FinancialPolicyReference, closureInput: FinancialPolicyQualifiedClosure, guard: () => void = () => {}) {
      const { r, key } = exact(input), pending = structuredClone(closureInput), version = generation;
      return serial(key, async () => {
        const closure = await qualifyFinancialClosure(pending, r); guard();
        if (!alive || generation !== version) throw new FinancialPolicyClientError('scope');
        const existing = closures.get(key);
        if (existing && !financialSame(existing, closure) || receipts.has(key)) throw new FinancialPolicyClientError('unconfirmed');
        if (!existing && !originals.has(key) && size() >= FINANCIAL_POLICY_REFERENCE_LIMIT) throw failed();
        exact(r); closures.set(key, closure); originals.delete(key); return closure;
      });
    },
    async clearReminder(storage: FinancialPolicyStorage | null, input: FinancialPolicyReference) {
      const { r, key } = exact(input), receipt = receipts.get(key), version = generation;
      if (!receipt) throw failed();
      await clearFinancialPolicyReminder(storage, r, receipt, () => alive && version === generation);
      // Clearing a tab reminder does not reinterpret or erase the known outcome.
    },
    clear,
    close() { alive = false; clear(); },
  };
}
export type FinancialPolicyMemory = ReturnType<typeof createFinancialPolicyMemory>;
