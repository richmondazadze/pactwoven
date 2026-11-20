import type { RecoveryStorage } from './bootstrap-recovery';
import { canonicalJson } from '@pactwoven/contracts/canonical';
import { CustodyClientError, CustodyLocatorSchema, CustodyScopeSchema, custodyLookupScope, custodyParse, custodySame, freezeCustody, qualifyCustodyOperation, verifyCustodyAttempt, type CustodyAttempt, type CustodyLocator, type CustodyScope } from './custody-setup-contract';
import type { CustodyResult } from '@pactwoven/contracts';

export const CUSTODY_REFERENCE_PREFIX = 'pactwoven:custody-setup:v1:';
export const CUSTODY_REFERENCE_LIMIT = 64, CUSTODY_REFERENCE_MAX_BYTES = 8192;
export const custodyReferenceKey = (value: CustodyLocator) => CUSTODY_REFERENCE_PREFIX + encodeURIComponent(canonicalJson([value.scope, value.kind, value.key]));
const storageError = () => new CustodyClientError('storage', 'Custody setup recovery storage needs attention. Preserve every original reference.');
export function listCustodyReferences(storage: RecoveryStorage | null, scope: CustodyScope): { references: CustodyLocator[]; blocked: boolean } {
  const owner = custodyLookupScope(scope), references: CustodyLocator[] = []; let blocked = false, count = 0;
  if (!storage) return { references, blocked: true };
  try {
    if (storage.length > 4096) return { references, blocked: true };
    for (let index = 0; index < storage.length; index++) { const key = storage.key(index); if (!key?.startsWith(CUSTODY_REFERENCE_PREFIX)) continue;
      if (++count > CUSTODY_REFERENCE_LIMIT) { blocked = true; break; }
      try { const raw = storage.getItem(key); if (!raw || new TextEncoder().encode(raw).length > CUSTODY_REFERENCE_MAX_BYTES) throw storageError(); const parsed = CustodyLocatorSchema.safeParse(JSON.parse(raw)); if (!parsed.success || canonicalJson(parsed.data) !== raw || custodyReferenceKey(parsed.data) !== key) throw storageError(); if (custodySame(parsed.data.scope, owner)) references.push(freezeCustody(parsed.data)); } catch { blocked = true; }
    }
  } catch { blocked = true; }
  return { references, blocked };
}
export function storeCustodyReference(storage: RecoveryStorage | null, input: CustodyLocator) {
  const locator = freezeCustody(custodyParse(CustodyLocatorSchema, structuredClone(input))), key = custodyReferenceKey(locator), serialized = canonicalJson(locator);
  if (!storage || new TextEncoder().encode(serialized).length > CUSTODY_REFERENCE_MAX_BYTES) throw storageError();
  try {
    const existing = storage.getItem(key); if (existing !== null) { if (existing !== serialized) throw storageError(); return locator; }
    if (storage.length > 4096) throw storageError(); let count = 0;
    for (let i = 0; i < storage.length; i++) if (storage.key(i)?.startsWith(CUSTODY_REFERENCE_PREFIX)) count++;
    if (count >= CUSTODY_REFERENCE_LIMIT) throw storageError(); storage.setItem(key, serialized);
    if (storage.getItem(key) !== serialized) throw storageError(); return locator;
  } catch { throw storageError(); }
}
export function assertCustodyReference(storage: RecoveryStorage | null, locator: CustodyLocator) { try { if (!storage || storage.getItem(custodyReferenceKey(locator)) !== canonicalJson(locator)) throw storageError(); } catch { throw storageError(); } }
// Only an exact qualified recorded result permits explicit local settlement. No
// not-found, expiry, cancellation, hidden view or network error removes a reference.
export async function settleCustodyReference(storage: RecoveryStorage | null, locatorInput: CustodyLocator, resultInput: CustodyResult, attempt?: CustodyAttempt) {
  const locator = freezeCustody(custodyParse(CustodyLocatorSchema, structuredClone(locatorInput))), result = await qualifyCustodyOperation(resultInput, locator, attempt);
  assertCustodyReference(storage, locator);
  try { storage!.removeItem(custodyReferenceKey(locator)); if (storage!.getItem(custodyReferenceKey(locator)) !== null) throw storageError(); } catch { throw storageError(); }
  return result;
}
export function createCustodyMemory(scopeInput: CustodyScope) {
  const scope = freezeCustody(custodyParse(CustodyScopeSchema, structuredClone(scopeInput))), originals = new Map<string, CustodyAttempt>(), recorded = new Map<string, { locator: CustodyLocator; result: CustodyResult }>(), updates = new Map<string, Promise<void>>(); let active = true;
  const current = () => { if (!active) throw new CustodyClientError('scope', 'The private custody setup scope has ended.'); };
  const owned = (locator: CustodyLocator) => { current(); if (!custodySame(locator.scope, custodyLookupScope(scope))) throw new CustodyClientError('scope', 'This original belongs to another custody setup scope.'); const key = custodyReferenceKey(locator), original = originals.get(key), receipt = recorded.get(key); if ((original && !custodySame(original.locator, locator)) || (receipt && !custodySame(receipt.locator, locator))) throw storageError(); };
  // Serialize each original's context transitions. No new original/receipt pair
  // becomes visible until it qualifies together; close still revokes queued work.
  function update<T>(locator: CustodyLocator, work: () => Promise<T>): Promise<T> {
    owned(locator); const key = custodyReferenceKey(locator), previous = updates.get(key) ?? Promise.resolve();
    const result = previous.then(() => { owned(locator); return work(); });
    const tail = result.then(() => {}, () => {}); updates.set(key, tail);
    void tail.then(() => { if (updates.get(key) === tail) updates.delete(key); });
    return result;
  }
  return {
    scope,
    async retain(input: CustodyAttempt) {
      current(); const snapshot = freezeCustody(structuredClone(input)), locator = freezeCustody(custodyParse(CustodyLocatorSchema, snapshot.locator));
      if (!custodySame(snapshot.scope, scope)) throw new CustodyClientError('scope', 'The exact original session must be retained for a retry.');
      return update(locator, async () => {
        const attempt = await verifyCustodyAttempt(snapshot); owned(locator);
        const key = custodyReferenceKey(locator), prior = originals.get(key), receipt = recorded.get(key);
        if (prior && !custodySame(prior, attempt)) throw storageError();
        if (receipt) await qualifyCustodyOperation(receipt.result, locator, attempt);
        owned(locator); originals.set(key, attempt); return attempt;
      });
    },
    original(locator: CustodyLocator) { owned(locator); const value = originals.get(custodyReferenceKey(locator)); if (value && !custodySame(value.locator, locator)) throw storageError(); return value ?? null; },
    recorded(locator: CustodyLocator) { owned(locator); return recorded.get(custodyReferenceKey(locator))?.result ?? null; },
    async record(locatorInput: CustodyLocator, resultInput: CustodyResult) {
      const locator = freezeCustody(custodyParse(CustodyLocatorSchema, structuredClone(locatorInput))), snapshot = freezeCustody(structuredClone(resultInput));
      return update(locator, async () => {
        const key = custodyReferenceKey(locator), result = await qualifyCustodyOperation(snapshot, locator, originals.get(key)); owned(locator);
        const prior = recorded.get(key);
        if (prior && !custodySame(prior.result, result)) throw new CustodyClientError('unconfirmed', 'The recorded original changed. Preserve its first receipt.');
        recorded.set(key, freezeCustody({ locator, result })); return result;
      });
    },
    close() { active = false; originals.clear(); recorded.clear(); updates.clear(); },
  };
}
export type CustodyMemory = ReturnType<typeof createCustodyMemory>;
