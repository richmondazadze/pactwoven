import type { ActorContext, Role } from '@pactwoven/contracts';
import { DomainError } from './errors.js';

const buyerReadRoles: readonly Role[] = ['owner', 'operations', 'finance', 'auditor', 'receiver'];

export function assertResponsibilityReader(actor: ActorContext): void {
  if (!actor.roles.some(role => buyerReadRoles.includes(role))) {
    throw new DomainError('FORBIDDEN', 403, 'Your current role cannot access buyer responsibilities.');
  }
}

export function assertResponsibilityCreator(actor: ActorContext, siteId: string): void {
  if (!actor.roles.some(role => role === 'owner' || role === 'operations') || !actor.siteIds.includes(siteId)) {
    throw new DomainError('FORBIDDEN', 403, 'Your current role cannot create a responsibility at this site.');
  }
}

export function assertCreationVersion(expectedVersion: number, mandateVersion: number | null, authorityEpoch: number | null): void {
  if (expectedVersion !== 0 || mandateVersion !== null || authorityEpoch !== null) {
    throw new DomainError('VERSION_CONFLICT', 409, 'A new draft requires version zero and no existing mandate or authority epoch.');
  }
}
