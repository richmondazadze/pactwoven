import { createHash } from 'node:crypto';
import { createClerkClient } from '@clerk/backend';
import { z } from 'zod';
import { DomainError, immutable } from '@pactwoven/domain';
import {
  SupplierObserverConfigurationSchema, SupplierObserverIdentityObservationSchema, SupplierObserverFactorObservationSchema,
  snapshotSupplierIdentityObserver, snapshotSupplierFactorObserver, type SupplierObserverConfiguration,
} from '../../../packages/db/src/supplier-observer-schema.js';
import { createClerkIdentityObservationVerifier, createClerkFactorVerification, type ClerkIdentityConfig } from './auth.js';

const clerkConfiguration = z.strictObject({
  secretKey: z.string().min(1), issuer: z.url().max(2048),
  authorizedParties: z.array(z.url()).min(1), jwtKey: z.string().min(1).optional(),
});
const refused = () => new DomainError('SUPPLIER_VERIFICATION_REFUSED', 403, 'Current exact supplier authentication is required.');
const unavailable = () => new DomainError('SUPPLIER_VERIFICATION_UNAVAILABLE', 503, 'Supplier authentication is temporarily unavailable.');
const messages = {
  AUTH_REQUIRED: [401, 'Sign in again to continue.'],
  FORBIDDEN: [403, 'Your selected organization membership is not active.'],
  STEP_UP_REQUIRED: [403, 'Fresh verification of both factors is required.'],
  IDENTITY_UNAVAILABLE: [503, 'Identity verification is temporarily unavailable.'],
  SETUP_REQUIRED: [503, 'Supplier authentication is not configured.'],
} as const;

/** Private server configuration only; never populated from operation input. */
export function captureSupplierClerkConfiguration(input: ClerkIdentityConfig, issuer: string): ClerkIdentityConfig {
  const parsed = clerkConfiguration.safeParse(input);
  if (!parsed.success || parsed.data.issuer !== issuer) throw new DomainError('SETUP_REQUIRED', 503, 'Supplier authentication is not configured.');
  return immutable({ secretKey: parsed.data.secretKey, issuer: parsed.data.issuer,
    authorizedParties: parsed.data.authorizedParties, ...(parsed.data.jwtKey === undefined ? {} : { jwtKey: parsed.data.jwtKey }) });
}

/** No normalization: the exact bearer bytes are the authenticated request identity. */
export function captureSupplierBearer(input: string): string {
  if (typeof input !== 'string' || input.length === 0 || input.length > 32_768) throw refused();
  return input;
}

async function provider<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) {
    if (error instanceof DomainError && Object.hasOwn(messages, error.code)) {
      const [status, message] = messages[error.code as keyof typeof messages];
      throw new DomainError(error.code, status, message);
    }
    throw unavailable();
  }
}

/** Genuine Clerk factories are fixed here. No caller-supplied verifier or evidence seam. */
export function createSupplierRelationshipVerifier(clerkInput: ClerkIdentityConfig, observerInput: SupplierObserverConfiguration,
  clock: () => string = () => new Date().toISOString()) {
  const configuration = immutable(SupplierObserverConfigurationSchema.parse(observerInput));
  const clerk = captureSupplierClerkConfiguration(clerkInput, configuration.issuer);
  const client = createClerkClient({ secretKey: clerk.secretKey, telemetry: { disabled: true } });
  const getSession = client.sessions.getSession.bind(client.sessions);
  const getMemberships = client.organizations.getOrganizationMembershipList.bind(client.organizations);
  // The existing genuine factories remain the sole signed-token verifiers.
  // Copy SDK-owned fields before their next await so a retained provider object
  // cannot change already-observed membership during the later session lookup.
  const sessionLookup: NonNullable<Parameters<typeof createClerkIdentityObservationVerifier>[1]> = async id => {
    const session = await getSession(id);
    return immutable({ id: session.id, userId: session.userId, status: session.status, expireAt: session.expireAt, createdAt: session.createdAt,
      ...(session.lastActiveOrganizationId === undefined ? {} : { lastActiveOrganizationId: session.lastActiveOrganizationId }),
      actor: session.actor === null ? null : { impersonation: true },
    });
  };
  const membershipLookup: NonNullable<Parameters<typeof createClerkIdentityObservationVerifier>[2]> = async (organizationId, subject) => {
    const result = await getMemberships({ organizationId, userId: [subject], limit: 2 });
    return immutable({ totalCount: result.totalCount, data: result.data.map(member => ({
      id: member.id, role: member.role, organization: { id: member.organization.id, name: member.organization.name },
      publicUserData: member.publicUserData == null ? null : { userId: member.publicUserData.userId },
    })) });
  };
  const identity = createClerkIdentityObservationVerifier(clerk, sessionLookup, membershipLookup);
  const factors = createClerkFactorVerification(clerk, sessionLookup, membershipLookup);
  return Object.freeze({
    async identity(input: string) {
      const token = captureSupplierBearer(input), expectedHash = createHash('sha256').update(token, 'utf8').digest('hex');
      const parsed = SupplierObserverIdentityObservationSchema.safeParse(await provider(() => identity(token)));
      if (!parsed.success || parsed.data.observation.tokenHash !== expectedHash || parsed.data.observation.issuer !== configuration.issuer) throw refused();
      const value = immutable(parsed.data);
      // Parsing preserves source fields; it is not a replacement for the genuine factory above.
      try { snapshotSupplierIdentityObserver(value, configuration, clock()); } catch { throw refused(); }
      return value;
    },
    async factors(input: string) {
      const token = captureSupplierBearer(input), expectedHash = createHash('sha256').update(token, 'utf8').digest('hex');
      const parsed = SupplierObserverFactorObservationSchema.safeParse(await provider(() => factors(token)));
      if (!parsed.success || parsed.data.evidence.tokenHash !== expectedHash || parsed.data.evidence.issuer !== configuration.issuer) throw refused();
      const value = immutable(parsed.data);
      try { snapshotSupplierFactorObserver(value, configuration, clock()); } catch { throw refused(); }
      return value;
    },
  });
}
