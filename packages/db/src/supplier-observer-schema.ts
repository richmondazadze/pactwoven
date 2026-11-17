import { z } from 'zod';
import { EnvironmentSchema, HashSchema, IdSchema, InstantSchema } from '@pactwoven/contracts';
import { DomainError, immutable } from '@pactwoven/domain';
import type { VerifiedIdentity } from './repository.js';
import type { SupplierAuthenticationEvidence } from './supplier-relationship-auth-evidence.js';
import { SupplierExternalObservationSchema, SupplierPrivatePrincipalBindingSchema } from './supplier-relationship-persistence-schema.js';

// Private structural seam, deliberately absent from the public package barrel.
// These shapes match auth.ts outputs without importing the API into the DB.
// Parsing never verifies Clerk or a bearer token. Only a trusted, same-process
// orchestrator may supply genuine authenticated provider results and config.
const issuer = z.url().max(2048).refine(value => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
});
const identity = z.strictObject({
  subject: IdSchema, externalOrganizationId: IdSchema, externalOrganizationName: z.string().min(1).max(180),
  externalMembershipId: IdSchema, externalRole: z.string().min(1).max(128),
  sessionId: z.string().min(1).max(256), authenticatedAt: InstantSchema, membershipObservedAt: InstantSchema,
}) satisfies z.ZodType<VerifiedIdentity>;
const times = {
  issuer, tokenHash: HashSchema, tokenIssuedAt: InstantSchema, observedAt: InstantSchema, expiresAt: InstantSchema,
};
export const SupplierObserverIdentityObservationSchema = z.strictObject({
  identity, observation: z.strictObject(times),
});
export const SupplierObserverFactorObservationSchema = z.strictObject({
  identity, evidence: z.strictObject({
    ...times, id: z.uuid(), subject: IdSchema, externalOrganizationId: IdSchema, externalMembershipId: IdSchema,
    sessionId: z.string().min(1).max(256),
    firstFactorAgeMinutes: z.number().int().min(0).max(1_000_000),
    secondFactorAgeMinutes: z.number().int().min(0).max(1_000_000), verifiedAt: InstantSchema,
  }),
});
export const SupplierObserverConfigurationSchema = z.strictObject({
  environment: EnvironmentSchema, issuer, binding: SupplierPrivatePrincipalBindingSchema,
}).refine(value => value.environment === value.binding.environment, 'Configured environment and private binding must agree.');
const version = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const externalId = z.string().min(1).max(256);
export const SupplierObserverActorSchema = z.strictObject({
  environment: EnvironmentSchema, organizationId: IdSchema, actorId: IdSchema, principalKind: z.literal('human'),
  membershipId: IdSchema, membershipVersion: version, organizationVersion: version,
  organizationEpoch: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  subject: externalId, externalOrganizationId: externalId, externalMembershipId: externalId, sessionId: externalId,
}).refine(value => value.actorId === value.membershipId, 'The current membership primary key is the actor ID.') satisfies z.ZodType<SupplierAuthenticationEvidence['actor']>;

export type SupplierObserverConfiguration = z.infer<typeof SupplierObserverConfigurationSchema>;
export type SupplierObserverIdentityObservation = z.infer<typeof SupplierObserverIdentityObservationSchema>;
export type SupplierObserverFactorObservation = z.infer<typeof SupplierObserverFactorObservationSchema>;
export type SupplierObserverActor = z.infer<typeof SupplierObserverActorSchema>;
type Observation = z.infer<typeof SupplierExternalObservationSchema>;
type FactorSource = Extract<SupplierAuthenticationEvidence, { kind: 'factors' }>['source'];
export type SupplierObserverSnapshot =
  | { kind: 'identity'; observation: Observation }
  | { kind: 'factors'; observation: Observation; source: FactorSource };
const refused = () => new DomainError('SUPPLIER_OBSERVER_REFUSED', 403, 'A current exact authenticated supplier observation is required.');
const ms = (value: string) => Date.parse(value);

/** Repeated after awaits; original observation/member/factor times never move. */
export function assertSupplierObserverCurrent(snapshot: SupplierObserverSnapshot, config: SupplierObserverConfiguration, now: string): void {
  const at = ms(InstantSchema.parse(now)), observation = snapshot.observation, binding = config.binding;
  if (binding.status !== 'ACTIVE' || binding.environment !== config.environment || ms(binding.validFrom) > at || at >= ms(binding.expiresAt) ||
    observation.issuer !== config.issuer || ms(observation.observedAt) < ms(binding.validFrom) ||
    ms(observation.expiresAt) > ms(binding.expiresAt) ||
    ms(observation.observedAt) > at || at - ms(observation.observedAt) > 20_000 || at >= ms(observation.expiresAt) ||
    ms(observation.membershipObservedAt) > at || at - ms(observation.membershipObservedAt) > 20_000) throw refused();
  if (snapshot.kind === 'factors' && [snapshot.source.firstFactorAt, snapshot.source.secondFactorAt].some(value =>
    ms(value) > at || at - ms(value) >= 300_000)) throw refused();
}

function normalizeObservation(i: z.infer<typeof identity>, original: z.infer<typeof SupplierObserverIdentityObservationSchema>['observation'],
  config: SupplierObserverConfiguration): Observation {
  if (original.issuer !== config.issuer) throw refused();
  // Original expiry may already be a conservative factor/session bound. Keep it
  // as sessionExpiresAt and only narrow the private evidence interval. No later
  // lookup, pool wait or SQL result is a new authentication observation.
  return SupplierExternalObservationSchema.parse({
    subject: i.subject, externalOrganizationId: i.externalOrganizationId, externalMembershipId: i.externalMembershipId,
    externalRole: i.externalRole, sessionId: i.sessionId, authenticatedAt: i.authenticatedAt,
    membershipObservedAt: i.membershipObservedAt, issuer: original.issuer, tokenHash: original.tokenHash,
    tokenIssuedAt: original.tokenIssuedAt, observedAt: original.observedAt, sessionExpiresAt: original.expiresAt,
    expiresAt: new Date(Math.min(ms(original.expiresAt), ms(original.observedAt) + 30_000, ms(config.binding.expiresAt))).toISOString(),
  });
}

/** Synchronous parse/copy before any await; not authentication or SQL authority. */
export function snapshotSupplierIdentityObserver(input: SupplierObserverIdentityObservation, config: SupplierObserverConfiguration, now: string) {
  const parsed = SupplierObserverIdentityObservationSchema.parse(input);
  const snapshot = immutable({ kind: 'identity' as const, observation: normalizeObservation(parsed.identity, parsed.observation, config) });
  assertSupplierObserverCurrent(snapshot, config, now);
  return snapshot;
}

/** Preserves both original conservative signed-FVA bounds from auth.ts. */
export function snapshotSupplierFactorObserver(input: SupplierObserverFactorObservation, config: SupplierObserverConfiguration, now: string) {
  const { identity: i, evidence } = SupplierObserverFactorObservationSchema.parse(input);
  if (evidence.subject !== i.subject || evidence.externalOrganizationId !== i.externalOrganizationId ||
    evidence.externalMembershipId !== i.externalMembershipId || evidence.sessionId !== i.sessionId) throw refused();
  const issued = ms(evidence.tokenIssuedAt), first = issued - (evidence.firstFactorAgeMinutes + 1) * 60_000,
    second = issued - (evidence.secondFactorAgeMinutes + 1) * 60_000;
  if (ms(evidence.verifiedAt) !== Math.min(first, second) || ms(evidence.expiresAt) > Math.min(first, second) + 300_000) throw refused();
  const source: FactorSource = {
    kind: 'CLERK_FVA', tokenHash: evidence.tokenHash, tokenIssuedAt: evidence.tokenIssuedAt,
    firstFactorAgeMinutes: evidence.firstFactorAgeMinutes, secondFactorAgeMinutes: evidence.secondFactorAgeMinutes,
    firstFactorAt: new Date(first).toISOString(), secondFactorAt: new Date(second).toISOString(), verifiedAt: evidence.verifiedAt,
  };
  const snapshot = immutable({ kind: 'factors' as const, observation: normalizeObservation(i, evidence, config), source });
  assertSupplierObserverCurrent(snapshot, config, now);
  return snapshot;
}
