import { createHash } from 'node:crypto';
import { z } from 'zod';
import { EnvironmentSchema, type Environment } from '@pactwoven/contracts';
import { FinancialIdentityEvidenceSchema, FinancialPolicyReadObservationSchema, FinancialPolicyReaderScopeSchema,
  type FinancialPolicyReadObservation, type FinancialPolicyReaderScope } from '@pactwoven/db';
import { DomainError } from '@pactwoven/domain';
import { createClerkIdentityObservationVerifier, type ClerkIdentityConfig } from './auth.js';

export type FinancialPolicyApiIdentityEvidence = z.infer<typeof FinancialIdentityEvidenceSchema>;
export type FinancialPolicyApiVerifier = {
  observe(token: string): Promise<unknown>;
  identityEvidence(observation: FinancialPolicyReadObservation, scope: FinancialPolicyReaderScope): unknown;
};
export type FinancialPolicyApiVerifierDependencies = {
  environment: Environment; issuer: string; observe(token: string): Promise<unknown>;
  now?: () => number; newId?: () => string;
};
const denied = () => new DomainError('FINANCIAL_POLICY_ACCESS_DENIED', 403, 'Current scoped policy access is required.');
const expired = () => new DomainError('FINANCIAL_POLICY_EXPIRED', 409, 'The policy observation expired.');
const instant = (value: number) => new Date(value).toISOString();

/** Validation of a private authenticator response; parsing alone never authenticates identity. */
export function validateFinancialPolicyObservation(input: unknown, token: string, issuer: string, at: number): FinancialPolicyReadObservation {
  const parsed = FinancialPolicyReadObservationSchema.safeParse(input);
  if (!parsed.success) throw denied();
  const v = parsed.data, o = v.observation, i = v.identity;
  if (o.issuer !== issuer || o.tokenHash !== createHash('sha256').update(token).digest('hex')) throw denied();
  const oldest = Math.min(Date.parse(o.observedAt), Date.parse(i.membershipObservedAt));
  if (!Number.isFinite(at) || Date.parse(o.observedAt) > at || Date.parse(i.membershipObservedAt) > at ||
    Date.parse(o.tokenIssuedAt) > oldest || Date.parse(i.authenticatedAt) > Date.parse(o.tokenIssuedAt) ||
    oldest + 20_000 <= at || Date.parse(o.expiresAt) <= at) throw expired();
  return { identity: i, observation: { ...o, observedAt: instant(oldest) } };
}

/** Recheck the original bounded observation, including after every asynchronous read. */
export function assertFinancialPolicyObservationFresh(observation: FinancialPolicyReadObservation,
  scope: FinancialPolicyReaderScope | null, environment: Environment, at: number): void {
  const v = FinancialPolicyReadObservationSchema.parse(observation), o = v.observation, i = v.identity;
  const oldest = Math.min(Date.parse(o.observedAt), Date.parse(i.membershipObservedAt));
  if (!Number.isFinite(at) || Date.parse(o.observedAt) > at || Date.parse(i.membershipObservedAt) > at ||
    oldest + 20_000 <= at || Date.parse(o.expiresAt) <= at || Date.parse(o.tokenIssuedAt) > oldest ||
    Date.parse(i.authenticatedAt) > Date.parse(o.tokenIssuedAt)) throw expired();
  if (scope !== null) {
    const s = FinancialPolicyReaderScopeSchema.parse(scope);
    if (s.environment !== environment || s.externalOrganizationId !== i.externalOrganizationId ||
      s.actor.subject !== i.subject || s.actor.externalMembershipId !== i.externalMembershipId || s.actor.sessionId !== i.sessionId ||
      !s.roles.some(role => ['owner', 'finance', 'operations'].includes(role)) || new Set(s.roles).size !== s.roles.length) throw denied();
  }
}

/** Inject only root-approved authenticators. Synthetic source fixtures are not provider qualification. */
export function createFinancialPolicyApiVerifier(dependencies: FinancialPolicyApiVerifierDependencies): FinancialPolicyApiVerifier {
  const environment = EnvironmentSchema.parse(dependencies.environment), issuer = z.string().url().max(512).parse(dependencies.issuer);
  const observe = dependencies.observe.bind(dependencies), now = dependencies.now?.bind(dependencies) ?? Date.now;
  const newId = dependencies.newId?.bind(dependencies) ?? (() => crypto.randomUUID());
  return {
    async observe(token) {
      return validateFinancialPolicyObservation(await observe(token), token, issuer, now());
    },
    identityEvidence(observation, scope) {
      const v = FinancialPolicyReadObservationSchema.parse(observation), s = FinancialPolicyReaderScopeSchema.parse(scope);
      assertFinancialPolicyObservationFresh(v, s, environment, now());
      if (v.observation.issuer !== issuer) throw denied();
      const oldest = Math.min(Date.parse(v.observation.observedAt), Date.parse(v.identity.membershipObservedAt));
      return FinancialIdentityEvidenceSchema.parse({ schemaVersion: 1, id: newId(), environment, organizationId: s.organizationId,
        actor: s.actor, observedAt: instant(oldest), expiresAt: instant(Math.min(Date.parse(v.observation.expiresAt), oldest + 300_000)),
        externalOrganizationId: v.identity.externalOrganizationId, externalRole: v.identity.externalRole,
        issuer, tokenHash: v.observation.tokenHash, tokenIssuedAt: v.observation.tokenIssuedAt,
        sessionExpiresAt: v.observation.expiresAt, kind: 'identity', purpose: 'financial_policy_observation' });
    },
  };
}

/** Uses the existing Clerk extraction without adding JWT, factor or wallet verification paths. */
export function createClerkFinancialPolicyVerifier(config: ClerkIdentityConfig, environment: Environment): FinancialPolicyApiVerifier {
  const snapshot = { ...config, authorizedParties: [...config.authorizedParties] };
  return createFinancialPolicyApiVerifier({ environment, issuer: snapshot.issuer, observe: createClerkIdentityObservationVerifier(snapshot) });
}
