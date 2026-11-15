import { AccessScopeSchema, type AccessScope, type ActorContext } from '@pactwoven/contracts';
import { DomainError } from './errors.js';

export function assertAccessOwner(actor: ActorContext): void {
  if (actor.principalKind !== 'human' || !actor.roles.includes('owner')) throw new DomainError('FORBIDDEN', 403, 'Current owner access is required.');
}
export function validateAccessScope(input: AccessScope, now: string): AccessScope {
  const scope = AccessScopeSchema.parse(input);
  if (scope.expiresAt && Date.parse(scope.expiresAt) <= Date.parse(now)) throw new DomainError('VALIDATION_FAILED', 422, 'Access expiry must be in the future.');
  if (!scope.roles.some(role => ['owner', 'operations', 'finance', 'receiver'].includes(role)) && scope.actionSiteIds.length) {
    throw new DomainError('FORBIDDEN', 403, 'Read-only roles cannot receive action-site authority.');
  }
  if (!scope.roles.some(role => ['owner', 'finance'].includes(role)) && scope.actionSiteIds.some(id => !scope.siteIds.includes(id))) {
    throw new DomainError('VALIDATION_FAILED', 422, 'Action sites must also be readable by the scoped member.');
  }
  return scope;
}
