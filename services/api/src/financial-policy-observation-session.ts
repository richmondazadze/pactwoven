import { z } from 'zod';
import { EnvironmentSchema, FinancialPolicyRefSchema, FinancialPolicyHttpScopeSchema, type Environment } from '@pactwoven/contracts';
import { FinancialIdentityEvidenceSchema, FinancialPolicyReaderScopeSchema,
  type FinancialPolicyReadObservation, type FinancialPolicyReaderScope } from '@pactwoven/db';
import { canonicalJson, commandDigest, DomainError } from '@pactwoven/domain';
import { validateFinancialPolicyObservation, assertFinancialPolicyObservationFresh,
  type FinancialPolicyApiVerifier, type FinancialPolicyApiIdentityEvidence } from './financial-policy-verifier.js';

export type FinancialPolicyObservationSessionDependencies = {
  environment: Environment; issuer: string; verifier: FinancialPolicyApiVerifier;
  readers: { resolveObserver(environment: Environment, observation: FinancialPolicyReadObservation): Promise<unknown> };
  authentication: { append(evidence: FinancialPolicyApiIdentityEvidence): Promise<unknown> };
  now?: () => number;
};
export type FinancialPolicyObservationSession = { observation: FinancialPolicyReadObservation; scope: FinancialPolicyReaderScope; evidenceId: string };
const unverified = () => new DomainError('FINANCIAL_POLICY_OUTCOME_UNKNOWN', 503, 'The original request status could not be verified.');
const checked = <T>(schema: z.ZodType<T>, input: unknown): T => { const v = schema.safeParse(input); if (!v.success) throw unverified(); return v.data; };
/** The original token observation is never renewed by later database or projection work. */
export function createFinancialPolicyObservationSession(dependencies: FinancialPolicyObservationSessionDependencies) {
  const environment = EnvironmentSchema.parse(dependencies.environment), issuer = z.string().url().max(512).parse(dependencies.issuer);
  const observe = dependencies.verifier.observe.bind(dependencies.verifier), evidence = dependencies.verifier.identityEvidence.bind(dependencies.verifier);
  const resolve = dependencies.readers.resolveObserver.bind(dependencies.readers), append = dependencies.authentication.append.bind(dependencies.authentication);
  const now = dependencies.now?.bind(dependencies) ?? Date.now;
  const fresh = (s: FinancialPolicyObservationSession) => assertFinancialPolicyObservationFresh(s.observation, s.scope, environment, now());
  async function wait<T>(s: FinancialPolicyObservationSession, work: () => Promise<T>): Promise<T> { fresh(s); const value = await work(); fresh(s); return value; }
  async function open(token: string, responsibilityId: string | null): Promise<FinancialPolicyObservationSession> {
    if (typeof token !== 'string' || !/^[A-Za-z0-9._~-]{1,8192}$/.test(token)) throw new DomainError('AUTH_REQUIRED', 401, 'Sign in again.');
    const observation = validateFinancialPolicyObservation(await observe(token), token, issuer, now());
    assertFinancialPolicyObservationFresh(observation, null, environment, now());
    const scope = checked(FinancialPolicyReaderScopeSchema, await resolve(environment, structuredClone(observation)));
    assertFinancialPolicyObservationFresh(observation, scope, environment, now());
    if (responsibilityId === null && !scope.roles.some(r => r === 'owner' || r === 'finance'))
      throw new DomainError('FINANCIAL_POLICY_ACCESS_DENIED', 403, 'Current scoped policy access is required.');
    const s = { observation, scope, evidenceId: '' }, o = observation.observation;
    const e = checked(FinancialIdentityEvidenceSchema, evidence(structuredClone(observation), structuredClone(scope)));
    if (e.environment !== environment || e.organizationId !== scope.organizationId || canonicalJson(e.actor) !== canonicalJson(scope.actor) ||
      e.externalOrganizationId !== scope.externalOrganizationId || e.externalRole !== observation.identity.externalRole || e.issuer !== issuer ||
      e.tokenHash !== o.tokenHash || e.tokenIssuedAt !== o.tokenIssuedAt || e.observedAt !== o.observedAt || e.sessionExpiresAt !== o.expiresAt ||
      e.expiresAt !== new Date(Math.min(Date.parse(o.expiresAt), Date.parse(o.observedAt) + 300_000)).toISOString()) throw unverified();
    const hash = await wait(s, () => commandDigest({ namespace: 'pactwoven:financial-policy-evidence:v1', record: e }));
    const ref = checked(FinancialPolicyRefSchema, await wait(s, () => append(structuredClone(e))));
    if (ref.id !== e.id || ref.version !== 1 || ref.recordHash !== hash) throw unverified();
    s.evidenceId = e.id; return s;
  }
  function envelope(s: FinancialPolicyObservationSession) {
    fresh(s); const v = s.scope, o = s.observation.observation;
    return { schemaVersion: 1 as const, scope: checked(FinancialPolicyHttpScopeSchema, { environment, organizationId: v.organizationId,
      actor: { actorId: v.actor.actorId, membershipVersion: v.actor.membershipVersion }, organizationEpoch: v.organizationEpoch,
      roles: [...v.roles].sort(), siteIds: [...v.siteIds], actionSiteIds: [...v.actionSiteIds] }),
      observation: { observedAt: o.observedAt, expiresAt: new Date(Math.min(Date.parse(o.expiresAt), Date.parse(o.observedAt) + 20_000)).toISOString() },
      effectiveAuthority: false as const, financialState: null };
  }
  return { open, fresh, wait, envelope, now };
}
