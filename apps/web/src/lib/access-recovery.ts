import { z } from 'zod';
import { IdempotencyKeySchema } from '@pactwoven/contracts';
import type { RecoveryStorage } from './bootstrap-recovery';
const PREFIX = 'pactwoven:access-recovery:v1:';
// Retain only a scoped operation locator. Credentials, proof, member details and command payloads stay out of storage.
export const AccessRecoverySchema = z.strictObject({ version: z.literal(1), key: IdempotencyKeySchema, kind: z.enum(['grant','revise','revoke']), userId: z.string().min(1), organizationId: z.string().min(1), apiBase: z.string().url() });
export type AccessRecovery = z.infer<typeof AccessRecoverySchema>;
export type AccessRecoveryScope = Pick<AccessRecovery, 'userId' | 'organizationId' | 'apiBase'>;
function storageKey(scope: AccessRecoveryScope) { return PREFIX + encodeURIComponent(JSON.stringify([scope.userId,scope.organizationId,scope.apiBase])); }
export function readAccessRecovery(storage: RecoveryStorage | null, scope: AccessRecoveryScope): AccessRecovery | null {
  try { const parsed = AccessRecoverySchema.safeParse(JSON.parse(storage?.getItem(storageKey(scope)) ?? 'null')); return parsed.success && storageKey(parsed.data) === storageKey(scope) ? parsed.data : null; } catch { return null; }
}
export function saveAccessRecovery(storage: RecoveryStorage | null, value: AccessRecovery) { try { storage?.setItem(storageKey(value),JSON.stringify(AccessRecoverySchema.parse(value))); return Boolean(storage); } catch { return false; } }
export function removeAccessRecovery(storage: RecoveryStorage | null, scope: AccessRecoveryScope) { try { storage?.removeItem(storageKey(scope)); } catch { /* In-memory recovery remains available. */ } }
export function clearAccessRecovery(storage: RecoveryStorage | null, keep?: { userId: string; organizationId: string | null }) {
  if (!storage) return;
  try { const keys = Array.from({length:storage.length},(_,i)=>storage.key(i)).filter((key):key is string=>Boolean(key?.startsWith(PREFIX)));
    for (const key of keys) { if (keep?.organizationId) { try { const parsed=AccessRecoverySchema.safeParse(JSON.parse(storage.getItem(key)??'null')); if(parsed.success && parsed.data.userId===keep.userId && parsed.data.organizationId===keep.organizationId) continue; } catch { /* Clear malformed private locators. */ } } storage.removeItem(key); }
  } catch { /* Storage restrictions do not change authorization. */ }
}
