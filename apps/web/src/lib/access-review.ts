import {
  GrantAccessCommandSchema, ReviseAccessCommandSchema, RevokeAccessCommandSchema,
  type AccessScope, type GrantAccessCommand, type ReviseAccessCommand, type RevokeAccessCommand,
  type MemberAccess, type MemberCandidate, type Session,
} from '@pactwoven/contracts';
import { RequestError } from './api';
export type AccessSelection = { kind: 'grant'; candidate: MemberCandidate } | { kind: 'revise' | 'revoke'; member: MemberAccess };
export type AccessIntent = { kind: 'grant'; path: '/v1/members/grant'; command: GrantAccessCommand } | { kind: 'revise'; path: string; command: ReviseAccessCommand } | { kind: 'revoke'; path: string; command: RevokeAccessCommand };
export function isAccessOwner(session: Session) { return session.actor.principalKind === 'human' && session.actor.roles.includes('owner'); }
export function organizationWideReading(scope: Pick<AccessScope, 'roles'>) { return scope.roles.some(role=>role==='owner'||role==='finance'||role==='auditor'); }
export function effectiveReadingDescription(scope: Pick<AccessScope, 'roles'>) {
  if(organizationWideReading(scope))return 'All organization sites, within the selected roles’ record permissions';
  if(scope.roles.includes('operations'))return 'Assigned read sites, within the selected roles’ record permissions';
  if(scope.roles.includes('receiver'))return 'Assigned read sites and assigned responsibilities';
  return 'No role selected';
}
export function actionableSites(session: Session) { return session.sites.filter(site => session.actor.actionSiteIds.includes(site.id)); }
export function canCreateResponsibility(session: Session) { return session.actor.principalKind === 'human' && session.actor.roles.some(role => role === 'owner' || role === 'operations') && actionableSites(session).length > 0; }
export function accessScopeOf(member: MemberAccess): AccessScope { return { roles: [...member.roles], siteIds: [...member.siteIds], actionSiteIds: [...member.actionSiteIds], expiresAt: member.expiresAt }; }
export function buildAccessIntent(selection: AccessSelection, scope: AccessScope, reason: string, authorityEpoch: number): AccessIntent {
  if(selection.kind!=='grant' && selection.member.status==='revoked')throw new RequestError('REVOKED_MEMBER_READ_ONLY','This revoked grant cannot be revised or restored in this flow.');
  const base = { expectedVersion: selection.kind === 'grant' ? 0 : selection.member.version, mandateVersion: null, authorityEpoch };
  if (selection.kind === 'grant') return { kind: 'grant', path: '/v1/members/grant', command: GrantAccessCommandSchema.parse({ ...base, payload: { ...scope, externalMembershipId: selection.candidate.externalMembershipId, externalSubject: selection.candidate.externalSubject } }) };
  const path = `/v1/members/${encodeURIComponent(selection.member.actorId)}`;
  if (selection.kind === 'revoke') return { kind: 'revoke', path: `${path}/revoke`, command: RevokeAccessCommandSchema.parse({ ...base, payload: { reason } }) };
  return { kind: 'revise', path: `${path}/revise-access`, command: ReviseAccessCommandSchema.parse({ ...base, payload: scope }) };
}
export function accessFailureKind(error: unknown): 'step-up' | 'rejected' | 'unknown' {
  if (!(error instanceof RequestError)) return 'unknown';
  if (error.code === 'STEP_UP_REQUIRED' && error.status === 403) return 'step-up';
  if (['FORBIDDEN','VERSION_CONFLICT','IDEMPOTENCY_CONFLICT','VALIDATION_FAILED','AUTH_REQUIRED','SESSION_REQUIRED'].includes(error.code) && [400,401,403,409,422].includes(error.status)) return 'rejected';
  return 'unknown';
}
