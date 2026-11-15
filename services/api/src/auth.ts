import { createClerkClient, verifyToken } from '@clerk/backend';
import { TokenVerificationError } from '@clerk/backend/errors';
import { z } from 'zod';
import { DomainError } from '@pactwoven/domain';
import type { VerifiedIdentity } from '@pactwoven/db';

export type IdentityVerifier = (token: string) => Promise<VerifiedIdentity>;
export type ClerkIdentityConfig = { secretKey: string; issuer: string; authorizedParties: string[]; jwtKey?: string };
type SessionObservation = {
  id: string; userId: string; status: string; expireAt: number; createdAt: number;
  lastActiveOrganizationId?: string | undefined; actor: Record<string, unknown> | null;
};
type MembershipObservation = {
  id: string; role: string; organization: { id: string; name: string };
  publicUserData?: { userId: string } | null | undefined;
};
type MembershipLookup = (organizationId: string, userId: string) => Promise<{ data: MembershipObservation[]; totalCount: number }>;

const ClaimsSchema = z.object({
  sub: z.string().min(1).max(128), sid: z.string().min(1).max(256),
  azp: z.string().url(), iss: z.string().url(),
  exp: z.number().int(), nbf: z.number().int().optional(),
  org_id: z.string().min(1).max(128).optional(), o: z.object({ id: z.string().min(1).max(128) }).optional(),
  act: z.unknown().optional(),
});

export function createClerkIdentityVerifier(
  config: ClerkIdentityConfig,
  sessionLookup?: (sessionId: string) => Promise<SessionObservation>,
  membershipLookup?: MembershipLookup,
): IdentityVerifier {
  if (!config.secretKey || !config.issuer || config.authorizedParties.length === 0) {
    throw new DomainError('SETUP_REQUIRED', 503, 'Development identity is not configured.');
  }
  const client = createClerkClient({ secretKey: config.secretKey, telemetry: { disabled: true } });
  const lookup = sessionLookup ?? (sessionId => client.sessions.getSession(sessionId));
  const lookupMembership = membershipLookup ?? ((organizationId, userId) =>
    client.organizations.getOrganizationMembershipList({ organizationId, userId: [userId], limit: 2 }));
  return async token => {
    let verified: unknown;
    try {
      verified = await verifyToken(token, {
        secretKey: config.secretKey, issuer: config.issuer, authorizedParties: config.authorizedParties,
        ...(config.jwtKey ? { jwtKey: config.jwtKey } : {}), clockSkewInMs: 0,
      });
    } catch (error) {
      if (error instanceof TokenVerificationError) throw new DomainError('AUTH_REQUIRED', 401, 'Sign in again to continue.');
      throw new DomainError('IDENTITY_UNAVAILABLE', 503, 'Identity verification is temporarily unavailable.');
    }
    const parsed = ClaimsSchema.safeParse(verified);
    if (!parsed.success) throw new DomainError('AUTH_REQUIRED', 401, 'A valid organization session is required.');
    const claims = parsed.data;
    const externalOrganizationId = claims.o?.id ?? claims.org_id;
    if (claims.iss !== config.issuer || !config.authorizedParties.includes(claims.azp) || claims.act != null ||
        !externalOrganizationId || (claims.o?.id && claims.org_id && claims.o.id !== claims.org_id)) {
      throw new DomainError('AUTH_REQUIRED', 401, 'A valid organization session is required.');
    }
    let membership: MembershipObservation;
    try {
      const result = await lookupMembership(externalOrganizationId, claims.sub);
      const member = result.data[0];
      if (result.totalCount !== 1 || result.data.length !== 1 || !member ||
          member.organization.id !== externalOrganizationId || member.publicUserData?.userId !== claims.sub ||
          !/^[A-Za-z0-9_-]{1,128}$/.test(member.id) || !member.role ||
          !member.organization.name.trim() || member.organization.name.length > 180) {
        throw new DomainError('FORBIDDEN', 403, 'Your selected organization membership is not active.');
      }
      membership = member;
    } catch (error) {
      if (error instanceof DomainError) throw error;
      const status = typeof error === 'object' && error !== null && 'status' in error ? error.status : null;
      if (status === 401 || status === 403 || status === 404) throw new DomainError('FORBIDDEN', 403, 'Your selected organization membership is not active.');
      throw new DomainError('IDENTITY_UNAVAILABLE', 503, 'Organization verification is temporarily unavailable.');
    }
    const membershipObservedAt = new Date().toISOString();
    let session: SessionObservation;
    try { session = await lookup(claims.sid); }
    catch (error) {
      const status = typeof error === 'object' && error !== null && 'status' in error ? error.status : null;
      if (status === 401 || status === 403 || status === 404) throw new DomainError('AUTH_REQUIRED', 401, 'Sign in again to continue.');
      throw new DomainError('IDENTITY_UNAVAILABLE', 503, 'Session verification is temporarily unavailable.');
    }
    const now = Date.now();
    if (claims.exp * 1000 <= now || (claims.nbf !== undefined && claims.nbf * 1000 > now) ||
        session.id !== claims.sid || session.userId !== claims.sub || session.status !== 'active' ||
        !Number.isFinite(session.expireAt) || session.expireAt <= now || !Number.isFinite(session.createdAt) ||
        session.createdAt > now || session.actor !== null ||
        (session.lastActiveOrganizationId && session.lastActiveOrganizationId !== externalOrganizationId)) {
      throw new DomainError('AUTH_REQUIRED', 401, 'Sign in again to continue.');
    }
    return {
      subject: claims.sub, externalOrganizationId, sessionId: claims.sid,
      externalOrganizationName: membership.organization.name.trim(), externalMembershipId: membership.id,
      externalRole: membership.role, membershipObservedAt,
      // Token issue time is not authentication time. Session creation is a
      // conservative bound until the separate step-up evidence contract exists.
      authenticatedAt: new Date(session.createdAt).toISOString(),
    };
  };
}
