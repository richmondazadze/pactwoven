import { createClerkClient, verifyToken } from '@clerk/backend';
import { TokenVerificationError } from '@clerk/backend/errors';
import { z } from 'zod';
import { commandDigest, DomainError, mandateIntentHash } from '@pactwoven/domain';
import { AccessMfaEvidenceSchema, MandateMfaEvidenceSchema, MandateVerificationRequestSchema,
  AccessRecoveryMfaEvidenceSchema, AccessRecoveryVerificationRequestSchema,
  type AccessRecoveryVerificationRequest, type VerifiedAccessRecoveryStepUpIdentity,
  type MandateVerificationRequest, type VerifiedIdentity, type VerifiedStepUpIdentity, type VerifiedMandateStepUpIdentity } from '@pactwoven/db';

export type IdentityVerifier = (token: string) => Promise<VerifiedIdentity>;
export type StepUpIdentityVerifier = (token: string) => Promise<VerifiedStepUpIdentity>;
export type MandateStepUpIdentityVerifier = (token: string, request: MandateVerificationRequest) => Promise<VerifiedMandateStepUpIdentity>;
export type AccessRecoveryStepUpIdentityVerifier = (token: string, request: AccessRecoveryVerificationRequest) => Promise<VerifiedAccessRecoveryStepUpIdentity>;
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
  iat: z.number().int().optional(), fva: z.unknown().optional(),
  exp: z.number().int(), nbf: z.number().int().optional(),
  org_id: z.string().min(1).max(128).optional(), o: z.object({ id: z.string().min(1).max(128) }).optional(),
  act: z.unknown().optional(),
});

function createClerkVerification(
  config: ClerkIdentityConfig,
  sessionLookup?: (sessionId: string) => Promise<SessionObservation>,
  membershipLookup?: MembershipLookup,
) {
  if (!config.secretKey || !config.issuer || config.authorizedParties.length === 0) {
    throw new DomainError('SETUP_REQUIRED', 503, 'Development identity is not configured.');
  }
  const client = createClerkClient({ secretKey: config.secretKey, telemetry: { disabled: true } });
  const lookup = sessionLookup ?? (sessionId => client.sessions.getSession(sessionId));
  const lookupMembership = membershipLookup ?? ((organizationId, userId) =>
    client.organizations.getOrganizationMembershipList({ organizationId, userId: [userId], limit: 2 }));
  return async (token: string) => {
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
    const identity: VerifiedIdentity = {
      subject: claims.sub, externalOrganizationId, sessionId: claims.sid,
      externalOrganizationName: membership.organization.name.trim(), externalMembershipId: membership.id,
      externalRole: membership.role, membershipObservedAt,
      // This is general session metadata, never step-up evidence.
      authenticatedAt: new Date(session.createdAt).toISOString(),
    };
    return { identity, claims, session, observedAt: now };
  };
}

export function createClerkIdentityVerifier(config: ClerkIdentityConfig, sessionLookup?: (sessionId: string) => Promise<SessionObservation>, membershipLookup?: MembershipLookup): IdentityVerifier {
  const verify = createClerkVerification(config, sessionLookup, membershipLookup);
  return async token => (await verify(token)).identity;
}

function createClerkFactorVerification(config: ClerkIdentityConfig, sessionLookup?: (sessionId: string) => Promise<SessionObservation>, membershipLookup?: MembershipLookup) {
  const verify = createClerkVerification(config, sessionLookup, membershipLookup);
  return async (token: string) => {
    const { identity, claims, session, observedAt } = await verify(token);
    const factors = z.tuple([z.number().int().nonnegative().max(1_000_000), z.number().int().nonnegative().max(1_000_000)]).safeParse(claims.fva);
    if (!factors.success || claims.iat === undefined || claims.iat * 1000 > observedAt) {
      throw new DomainError('STEP_UP_REQUIRED', 403, 'Verify both authentication factors before continuing.');
    }
    const maximumAgeMs = 300_000;
    const verifiedAt = claims.iat * 1000 - (Math.max(...factors.data) + 1) * 60_000;
    const expiresAt = Math.min(claims.exp * 1000, session.expireAt, verifiedAt + maximumAgeMs);
    if (observedAt >= expiresAt) throw new DomainError('STEP_UP_REQUIRED', 403, 'Fresh verification of both factors is required.');
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
    const tokenHash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    return { identity, evidence: { id: crypto.randomUUID(),
      subject: identity.subject, externalOrganizationId: identity.externalOrganizationId, externalMembershipId: identity.externalMembershipId,
      sessionId: identity.sessionId, issuer: config.issuer, tokenHash, tokenIssuedAt: new Date(claims.iat * 1000).toISOString(),
      firstFactorAgeMinutes: factors.data[0], secondFactorAgeMinutes: factors.data[1], verifiedAt: new Date(verifiedAt).toISOString(),
      observedAt: new Date(observedAt).toISOString(), expiresAt: new Date(expiresAt).toISOString(),
    } };
  };
}

export function createClerkStepUpVerifier(config: ClerkIdentityConfig, sessionLookup?: (sessionId: string) => Promise<SessionObservation>, membershipLookup?: MembershipLookup): StepUpIdentityVerifier {
  const verify = createClerkFactorVerification(config, sessionLookup, membershipLookup);
  return async token => {
    const { identity, evidence } = await verify(token);
    return { identity, evidence: AccessMfaEvidenceSchema.parse({ ...evidence, purpose: 'member_access' }) };
  };
}

export function createClerkMandateStepUpVerifier(config: ClerkIdentityConfig, sessionLookup?: (sessionId: string) => Promise<SessionObservation>, membershipLookup?: MembershipLookup): MandateStepUpIdentityVerifier {
  const verify = createClerkFactorVerification(config, sessionLookup, membershipLookup);
  return async (token, input) => {
    const parsed = MandateVerificationRequestSchema.safeParse(input);
    if (!parsed.success) throw new DomainError('VALIDATION_FAILED', 422, 'An exact mandate authorization or resume request is required.');
    // Parsing snapshots the intent before provider awaits; caller mutation cannot rebind verified evidence.
    const request = parsed.data;
    const { identity, evidence } = await verify(token);
    const purpose = request.intent.action === 'AUTHORIZE' ? 'mandate_authorization' : 'mandate_control';
    return { identity, evidence: MandateMfaEvidenceSchema.parse({ ...evidence, purpose,
      intentHash: await mandateIntentHash(request.intent), requestNonce: request.nonce,
      requestHash: await commandDigest({ schemaVersion: 1, purpose, request }),
    }) };
  };
}

/** A separate purpose built from genuine signed factors, never relabeled access evidence. */
export function createClerkAccessRecoveryStepUpVerifier(config: ClerkIdentityConfig, sessionLookup?: (sessionId: string) => Promise<SessionObservation>, membershipLookup?: MembershipLookup): AccessRecoveryStepUpIdentityVerifier {
  const verify = createClerkFactorVerification(config, sessionLookup, membershipLookup);
  return async (token, input) => {
    const parsed = AccessRecoveryVerificationRequestSchema.safeParse(input);
    if (!parsed.success) throw new DomainError('VALIDATION_FAILED', 422, 'An exact access recovery close review is required.');
    const request = parsed.data, { scope, intent } = request;
    if (scope.environment !== intent.expectedEnvironment || scope.organizationId !== intent.expectedOrganizationId ||
        scope.actorId !== intent.expectedActorId || scope.externalMembershipId !== intent.expectedExternalMembershipId) {
      throw new DomainError('FORBIDDEN', 403, 'The current recovery reviewer must match the reviewed scope.');
    }
    const { identity, evidence } = await verify(token);
    if (scope.externalOrganizationId !== identity.externalOrganizationId || scope.externalMembershipId !== identity.externalMembershipId) {
      throw new DomainError('FORBIDDEN', 403, 'The verified organization membership changed during recovery review.');
    }
    const purpose = 'member_access_recovery_close' as const;
    return { identity, evidence: AccessRecoveryMfaEvidenceSchema.parse({ ...evidence, purpose,
      scope, kind: intent.kind, key: request.key, requestNonce: request.nonce,
      intentHash: await commandDigest(intent), requestHash: await commandDigest({ schemaVersion: 1, purpose, request }),
    }) };
  };
}
