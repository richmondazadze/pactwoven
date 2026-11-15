import { z } from 'zod';
import { HashSchema, IdSchema, IdempotencyKeySchema, MandateHeadReferenceSchema, MandateResponsibilityReferenceSchema, VersionReferenceSchema } from '@pactwoven/contracts';
import { canonicalJson } from '@pactwoven/contracts/canonical';
import { RequestError } from './api';
import type { RecoveryStorage } from './bootstrap-recovery';
import type { MandateAuthorityCapsule } from './mandate-authority';
import { MandateRecoveryScopeSchema, mandateRecoveryScope, type MandateRecoveryScope } from './mandate-recovery';
import type { MandateWork } from './mandate-work-coordination';

const version = z.number().int().positive().max(2_147_483_647), epoch = z.number().int().nonnegative().max(2_147_483_647);
export const MandateAuthorityKindSchema = z.enum(['mandate.pause', 'mandate.revoke', 'mandate.resume']);
export const MandateAuthorityLocatorSchema = z.strictObject({
  version: z.literal(1), scope: MandateRecoveryScopeSchema, responsibilityId: IdSchema, kind: MandateAuthorityKindSchema, key: IdempotencyKeySchema,
  mandate: VersionReferenceSchema.safeExtend({ version }), head: MandateHeadReferenceSchema.safeExtend({ mandateVersion: version, mandateEpoch: epoch.max(2_147_483_646) }),
  responsibility: MandateResponsibilityReferenceSchema.safeExtend({ version }), expectedOrganizationEpoch: epoch,
  commandHash: HashSchema, intentHash: HashSchema,
  expectedTarget: z.strictObject({ kind: z.literal('authority'), id: IdSchema, version, hash: HashSchema }),
}).refine(value => value.responsibilityId === value.responsibility.id && value.mandate.id === value.head.mandateId && value.mandate.version === value.head.mandateVersion && value.expectedTarget.id === value.mandate.id && value.expectedTarget.version === value.head.mandateEpoch + 1, 'Authority scope, accepted version and resulting head epoch must agree');
export type MandateAuthorityLocator = z.infer<typeof MandateAuthorityLocatorSchema>;
export type MandateAuthoritySlot = { state: 'empty' } | { state: 'pending'; locator: MandateAuthorityLocator } | { state: 'blocked' };
const prefix = 'pactwoven:mandate-authority:v1:';
const addressSchema = z.strictObject({ scope: MandateRecoveryScopeSchema, kind: MandateAuthorityKindSchema, key: IdempotencyKeySchema });
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
export function authorityRecoveryKey(value: Pick<MandateAuthorityLocator, 'scope' | 'kind' | 'key'>) { return prefix + encodeURIComponent(canonicalJson(addressSchema.parse({ scope: mandateRecoveryScope(value.scope), kind: value.kind, key: value.key }))); }
export function locatorFromAuthorityCapsule(value: MandateAuthorityCapsule): MandateAuthorityLocator {
  return MandateAuthorityLocatorSchema.parse({ version: 1, scope: mandateRecoveryScope(value.scope), responsibilityId: value.scope.responsibilityId, kind: value.intent.action === 'PAUSE' ? 'mandate.pause' : 'mandate.revoke', key: value.key,
    mandate: value.intent.mandate, head: value.intent.head, responsibility: value.intent.responsibility, expectedOrganizationEpoch: value.intent.expectedOrganizationEpoch, commandHash: value.commandHash, intentHash: value.intentHash, expectedTarget: value.expectedTarget });
}
export function authorityWork(input: MandateAuthorityLocator): MandateWork {
  const value = MandateAuthorityLocatorSchema.parse(input);
  return { scope: value.scope, responsibilityId: value.responsibilityId, targetId: value.mandate.id, kind: value.kind === 'mandate.pause' ? 'PAUSE' : value.kind === 'mandate.revoke' ? 'REVOKE' : 'RESUME', key: value.key, phase: 'pending' };
}
export function readAuthorityRecovery(storage: RecoveryStorage | null, address: Pick<MandateAuthorityLocator, 'scope' | 'kind' | 'key'>): MandateAuthoritySlot {
  try {
    if (!storage) return { state: 'blocked' }; const key = authorityRecoveryKey(address), raw = storage.getItem(key);
    if (raw === null) return { state: 'empty' }; const locator = MandateAuthorityLocatorSchema.parse(JSON.parse(raw));
    return authorityRecoveryKey(locator) === key ? { state: 'pending', locator } : { state: 'blocked' };
  } catch { return { state: 'blocked' }; }
}
export function listAuthorityRecovery(storage: RecoveryStorage | null, scope: MandateRecoveryScope): { blocked: boolean; locators: MandateAuthorityLocator[] } {
  const locators: MandateAuthorityLocator[] = [];
  try {
    if (!storage) return { blocked: true, locators }; let blocked = false;
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i); if (!key?.startsWith(prefix)) continue;
      let parsed; try { parsed = addressSchema.safeParse(JSON.parse(decodeURIComponent(key.slice(prefix.length)))); } catch { blocked = true; continue; }
      if (!parsed.success) { blocked = true; continue; }
      if (!same(parsed.data.scope, mandateRecoveryScope(scope))) continue;
      const slot = readAuthorityRecovery(storage, parsed.data);
      if (slot.state === 'pending' && key === authorityRecoveryKey(slot.locator)) locators.push(slot.locator); else blocked = true;
    }
    return { blocked, locators };
  } catch { return { blocked: true, locators }; }
}
function conflict(): never { throw new RequestError('AUTHORITY_RECOVERY_CHANGED', 'The original authority reference changed or cannot be checked. Keep every unresolved original.'); }
export function assertAuthorityRecovery(storage: RecoveryStorage | null, input: MandateAuthorityLocator) {
  const value = MandateAuthorityLocatorSchema.parse(input), slot = readAuthorityRecovery(storage, value);
  if (slot.state !== 'pending' || !same(slot.locator, value)) conflict(); return slot.locator;
}
export function storeAuthorityRecovery(storage: RecoveryStorage | null, input: MandateAuthorityLocator) {
  const value = MandateAuthorityLocatorSchema.parse(input);
  if (!storage || listAuthorityRecovery(storage, value.scope).blocked || readAuthorityRecovery(storage, value).state !== 'empty') conflict();
  try { storage.setItem(authorityRecoveryKey(value), canonicalJson(value)); return assertAuthorityRecovery(storage, value); }
  catch (error) { if (error instanceof RequestError) throw error; throw new RequestError('AUTHORITY_STORAGE_UNAVAILABLE', 'The original authority reference could not be saved and checked. No outcome has been assumed.'); }
}
// Caller must qualify the exact successful receipt first. This removes only that kind/key.
export function removeAuthorityRecovery(storage: RecoveryStorage | null, input: MandateAuthorityLocator): boolean {
  try { const value = assertAuthorityRecovery(storage, input); if (!storage) return false; storage.removeItem(authorityRecoveryKey(value)); return readAuthorityRecovery(storage, value).state === 'empty'; }
  catch { return false; }
}
