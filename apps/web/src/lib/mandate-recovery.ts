import { z } from 'zod';
import { EnvironmentSchema, HashSchema, IdSchema, IdempotencyKeySchema } from '@pactwoven/contracts';
import { canonicalJson } from '@pactwoven/contracts/canonical';
import type { RecoveryStorage } from './bootstrap-recovery';
import { RequestError } from './api';
import type { MandateCapsule } from './mandate-capsule';
const positiveVersion = z.number().int().positive().max(2_147_483_646);
export const MandateRecoveryScopeSchema = z.strictObject({ userId: IdSchema, externalOrganizationId: IdSchema, apiBase: z.string().url().max(2048), organizationId: IdSchema, environment: EnvironmentSchema, actorId: IdSchema });
export const MandateRecoverySchema = MandateRecoveryScopeSchema.extend({ version: z.literal(1), key: IdempotencyKeySchema, kind: z.enum(['mandate.authorize', 'mandate.reject']), responsibilityId: IdSchema, proposal: z.strictObject({ id: IdSchema, version: z.number().int().positive().max(2_147_483_647), hash: HashSchema }), expectedDecisionVersion: positiveVersion, commandHash: HashSchema, intentHash: HashSchema });
export type MandateRecovery = z.infer<typeof MandateRecoverySchema>;
export type MandateRecoveryScope = z.infer<typeof MandateRecoveryScopeSchema>;
export type MandateRecoverySlot = { state: 'empty' } | { state: 'pending'; locator: MandateRecovery } | { state: 'blocked' };
export function mandateRecoveryScope(value: MandateRecoveryScope): MandateRecoveryScope { return MandateRecoveryScopeSchema.parse({ userId: value.userId, externalOrganizationId: value.externalOrganizationId, apiBase: value.apiBase, organizationId: value.organizationId, environment: value.environment, actorId: value.actorId }); }
export function mandateRecoveryKey(scope: MandateRecoveryScope) { return 'pactwoven:mandate-recovery:v1:' + encodeURIComponent(canonicalJson(mandateRecoveryScope(scope))); }
export const matchesMandateRecoveryScope = (a: MandateRecoveryScope, b: MandateRecoveryScope) => mandateRecoveryKey(a) === mandateRecoveryKey(b);
export function locatorFromCapsule(capsule: MandateCapsule): MandateRecovery { return MandateRecoverySchema.parse({ ...mandateRecoveryScope(capsule.scope), version: 1, key: capsule.key, kind: capsule.intent.action === 'AUTHORIZE' ? 'mandate.authorize' : 'mandate.reject', responsibilityId: capsule.scope.responsibilityId, proposal: capsule.intent.proposal, expectedDecisionVersion: capsule.intent.expectedDecisionVersion, commandHash: capsule.commandHash, intentHash: capsule.intentHash }); }
export function readMandateRecovery(storage: RecoveryStorage | null, scope: MandateRecoveryScope): MandateRecoverySlot {
  try {
    if (!storage) return { state: 'blocked' };
    const raw = storage.getItem(mandateRecoveryKey(scope));
    if (raw === null) return { state: 'empty' };
    const locator = MandateRecoverySchema.parse(JSON.parse(raw));
    return matchesMandateRecoveryScope(locator, scope) ? { state: 'pending', locator } : { state: 'blocked' };
  } catch { return { state: 'blocked' }; }
}
export function storeMandateRecovery(storage: RecoveryStorage | null, input: MandateRecovery) {
  const value = MandateRecoverySchema.parse(input);
  if (!storage || readMandateRecovery(storage, value).state !== 'empty') throw new RequestError('MANDATE_RECOVERY_OCCUPIED', 'An original mandate reference or unreadable storage needs attention. No new decision was sent.');
  try {
    storage.setItem(mandateRecoveryKey(value), canonicalJson(value));
    const saved = readMandateRecovery(storage, value);
    if (saved.state !== 'pending' || canonicalJson(saved.locator) !== canonicalJson(value)) throw new Error('Read-back failed');
  } catch { throw new RequestError('MANDATE_RECOVERY_STORAGE', 'The request reference could not be saved and checked. No decision was sent. Keep this review open and check browser storage.'); }
}
export function removeMandateRecovery(storage: RecoveryStorage | null, locator: MandateRecovery) {
  try { const stored = readMandateRecovery(storage, locator); if (!storage || stored.state !== 'pending' || canonicalJson(stored.locator) !== canonicalJson(locator)) return false; storage.removeItem(mandateRecoveryKey(locator)); return storage.getItem(mandateRecoveryKey(locator)) === null; } catch { return false; }
}
