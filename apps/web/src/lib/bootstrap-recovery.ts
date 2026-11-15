import { z } from 'zod';
import { IdempotencyKeySchema, OrganizationBootstrapCommandSchema, type OrganizationBootstrapPayload } from '@pactwoven/contracts';
import { RequestError } from './api';
const PREFIX = 'pactwoven:bootstrap:v1:';
export const BootstrapRecoverySchema = z.strictObject({
  version: z.literal(1),
  scope: z.strictObject({ userId: z.string().min(1), organizationId: z.string().min(1), apiBase: z.string().url() }),
  key: IdempotencyKeySchema,
  command: OrganizationBootstrapCommandSchema,
  createdAt: z.iso.datetime(),
  outcome: z.enum(['unresolved', 'confirmed']).default('unresolved'),
});
export type BootstrapRecovery = z.infer<typeof BootstrapRecoverySchema>;
export type BootstrapScope = BootstrapRecovery['scope'];
export type RecoveryStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;
export function recoveryKey(scope: BootstrapScope) { return PREFIX + encodeURIComponent(JSON.stringify([scope.userId, scope.organizationId, scope.apiBase])); }
export function createBootstrapRecovery(scope: BootstrapScope, payload: OrganizationBootstrapPayload, key: string): BootstrapRecovery {
  return BootstrapRecoverySchema.parse({ version: 1, scope, key, command: { expectedVersion: 0, mandateVersion: null, authorityEpoch: null, payload }, createdAt: new Date().toISOString() });
}
export function readBootstrapRecovery(storage: RecoveryStorage | null, scope: BootstrapScope): BootstrapRecovery | null {
  if (!storage) return null;
  try { const raw = storage.getItem(recoveryKey(scope)); if (!raw) return null; const parsed = BootstrapRecoverySchema.safeParse(JSON.parse(raw)); if (!parsed.success || recoveryKey(parsed.data.scope) !== recoveryKey(scope)) return null; return parsed.data; } catch { return null; }
}
export function storeBootstrapRecovery(storage: RecoveryStorage | null, attempt: BootstrapRecovery) {
  try { storage?.setItem(recoveryKey(attempt.scope), JSON.stringify(BootstrapRecoverySchema.parse(attempt))); return Boolean(storage); } catch { return false; }
}
export function removeBootstrapRecovery(storage: RecoveryStorage | null, scope: BootstrapScope) { try { storage?.removeItem(recoveryKey(scope)); } catch { /* Storage restrictions do not authorize a new command. */ } }
export function clearBootstrapRecovery(storage: RecoveryStorage | null, keep?: { userId: string; organizationId: string | null }) {
  if (!storage) return;
  try {
    const keys = Array.from({ length: storage.length }, (_, i) => storage.key(i)).filter((key): key is string => Boolean(key?.startsWith(PREFIX)));
    for (const key of keys) {
      if (keep?.organizationId) {
        try { const parsed = BootstrapRecoverySchema.safeParse(JSON.parse(storage.getItem(key) || 'null')); if (parsed.success && parsed.data.scope.userId === keep.userId && parsed.data.scope.organizationId === keep.organizationId) continue; } catch { /* Malformed records must not stop privacy cleanup. */ }
      }
      storage.removeItem(key);
    }
  } catch { /* Private-storage access can be disabled by the browser. */ }
}
export function browserRecoveryStorage(): RecoveryStorage | null { try { return window.sessionStorage; } catch { return null; } }
export function bootstrapFailureKind(error: unknown): 'reauthenticate' | 'already-configured' | 'rejected' | 'unresolved' {
  if (!(error instanceof RequestError)) return 'unresolved';
  if (error.status === 401 || error.code === 'AUTH_REQUIRED' || error.code === 'SESSION_REQUIRED') return 'reauthenticate';
  if (['ORGANIZATION_ALREADY_CONFIGURED','ORGANIZATION_ALREADY_PROVISIONED'].includes(error.code)) return 'already-configured';
  if (['FORBIDDEN','VALIDATION_FAILED','IDEMPOTENCY_CONFLICT','BOOTSTRAP_REJECTED'].includes(error.code) && error.status >= 400 && error.status < 500) return 'rejected';
  return 'unresolved';
}
