import { AuthorityBindingSchema, MandateHeadSchema, MandateVersionSchema, type ActionBinding, type AuthorityBinding, type MandateHead, type MandateVersion } from '@pactwoven/contracts';
import { commandDigest } from './canonical.js';
import { DomainError } from './errors.js';

export function immutable<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) immutable(child); Object.freeze(value); }
  return value;
}
export function instant(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new DomainError('VALIDATION_FAILED', 422, 'A valid instant is required.');
  return parsed;
}
export function nextVersion(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) throw new DomainError('VERSION_CONFLICT', 409, 'The version cannot advance.');
  return value + 1;
}
export function assertCurrentAuthority(binding: AuthorityBinding, head: MandateHead, now: string): void {
  const requested = AuthorityBindingSchema.parse(binding);
  const current = MandateHeadSchema.parse(head);
  if (Object.entries(requested).some(([key, value]) => current[key as keyof MandateHead] !== value) ||
      current.state !== 'ACTIVE' || instant(current.expiresAt) <= instant(now)) {
    throw new DomainError('AUTHORITY_CHANGED', 409, 'Current active mandate and organization authority are required.');
  }
}

export async function assertCurrentMandate(action: ActionBinding, head: MandateHead, mandate: MandateVersion, now: string): Promise<MandateVersion> {
  assertCurrentAuthority(action.authority, head, now);
  const current = MandateVersionSchema.parse(mandate);
  if (current.id !== head.mandateId || current.version !== head.mandateVersion || current.mandateEpoch > head.mandateEpoch ||
      current.organizationId !== head.organizationId || current.environment !== head.environment || current.organizationEpoch !== head.organizationEpoch ||
      current.policyHash !== head.policyHash || current.policyHash !== await commandDigest(current.policy) || current.responsibilityId !== action.responsibilityId ||
      current.responsibilityId !== head.responsibilityId || instant(head.expiresAt) > instant(current.policy.expiresAt) ||
      instant(action.expiresAt) <= instant(now) || instant(action.expiresAt) > instant(head.expiresAt) ||
      instant(action.expiresAt) > instant(current.policy.expiresAt)) {
    throw new DomainError('AUTHORITY_CHANGED', 409, 'The action must match the current mandate and expiry.');
  }
  return current;
}
