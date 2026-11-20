import { z } from 'zod';
import {
  EnvironmentSchema, IdSchema, InstantSchema, RoleSchema, HashSchema,
  SupplierAdmissionReferenceSchema, SupplierAdmissionObservationSchema, SupplierAdmissionMemberPinSchema,
  SupplierEnrollmentMutationSchema, SupplierAdministratorGrantSnapshotSchema,
  SUPPLIER_ADMINISTRATOR_MAX_VALIDITY_MS, SUPPLIER_ADMISSION_MAX_OBSERVATION_MS,
  supplierEnrollmentReviewDigest, supplierEnrollmentPublicRequestDigest, supplierAdministratorGrantDigest, supplierAdmissionLimitations,
  type SupplierAdmissionMemberPin,
} from '@pactwoven/contracts';
import { canonicalJson } from './canonical.js';
import { immutable, nextVersion } from './financial-primitives.js';
import { DomainError } from './errors.js';

const version = z.number().int().min(1).max(2_147_483_647);
const epoch = z.number().int().min(0).max(2_147_483_647);
const externalId = z.string().min(1).max(256);
const principal = z.strictObject({ issuer: z.url().max(2048), subject: externalId });
const organization = z.strictObject({
  id: IdSchema, environment: EnvironmentSchema, externalOrganizationId: externalId, version, authorityEpoch: epoch,
  status: z.enum(['ACTIVE', 'SUSPENDED', 'REVOKED']), validFrom: InstantSchema, expiresAt: InstantSchema.nullable(),
});
const member = SupplierAdmissionMemberPinSchema.extend({
  environment: EnvironmentSchema, organizationId: IdSchema, principalKind: z.enum(['human', 'service']),
  principal, externalMembershipId: externalId, organizationEpoch: epoch,
  roles: z.array(RoleSchema).max(9).refine(values => new Set(values).size === values.length),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'REVOKED']), validFrom: InstantSchema, expiresAt: InstantSchema.nullable(),
  grantBasis: z.enum(['internal', 'clerk_admin_bootstrap', 'owner_grant']),
});
const session = z.strictObject({
  id: externalId, principal, externalOrganizationId: externalId, externalMembershipId: externalId,
  externalRole: externalId, member: SupplierAdmissionMemberPinSchema,
  organizationVersion: version, organizationEpoch: epoch, status: z.enum(['ACTIVE', 'REVOKED']),
  authenticatedAt: InstantSchema, tokenIssuedAt: InstantSchema, expiresAt: InstantSchema,
  membershipObservation: SupplierAdmissionObservationSchema, tokenHash: HashSchema,
});
const candidate = z.strictObject({
  reference: SupplierAdmissionReferenceSchema, principal, externalOrganizationId: externalId, externalMembershipId: externalId,
  principalKind: z.enum(['human', 'service']), displayName: z.string().min(1).max(180),
  observation: SupplierAdmissionObservationSchema, member: member.nullable(),
});
const factors = z.strictObject({
  purpose: z.literal('supplier_administrator_enrollment'), publicRequestHash: HashSchema,
  reference: SupplierAdmissionReferenceSchema, principal, sessionId: externalId, tokenHash: HashSchema,
  externalOrganizationId: externalId, externalMembershipId: externalId,
  observedAt: InstantSchema, expiresAt: InstantSchema, firstFactorAt: InstantSchema, secondFactorAt: InstantSchema,
});

/** PRIVATE trusted-loader snapshots only. Parsing is not runtime identity/factor proof.
 * A fixed service must independently verify the real session and provider membership,
 * bind candidate identity, and recheck these exact facts after all lock waits. */
export const SupplierAdministratorEnrollmentFactsSchema = z.strictObject({
  schemaVersion: z.literal(1), environment: EnvironmentSchema, selectedParty: z.enum(['buyer', 'supplier']),
  organization, issuer: z.strictObject({ member, session }), target: candidate,
  originalObservation: SupplierAdmissionObservationSchema, factors, publicRequestHash: HashSchema,
  currentGrant: SupplierAdministratorGrantSnapshotSchema.nullable(),
});
export type SupplierAdministratorEnrollmentFacts = z.infer<typeof SupplierAdministratorEnrollmentFactsSchema>;

const ms = (value: string) => Date.parse(value);
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const current = (value: { validFrom: string; expiresAt: string | null }, at: number) =>
  ms(value.validFrom) <= at && (value.expiresAt === null || at < ms(value.expiresAt));
const observed = (value: { observedAt: string; expiresAt: string }, at: number) =>
  ms(value.observedAt) <= at && at < ms(value.expiresAt) && at - ms(value.observedAt) < SUPPLIER_ADMISSION_MAX_OBSERVATION_MS;
const pin = (value: SupplierAdmissionMemberPin) => ({ actorId: value.actorId, membershipId: value.membershipId, membershipVersion: value.membershipVersion });
const limitations = Object.freeze({ ...supplierAdmissionLimitations,
  identityProof: 'NOT_ESTABLISHED' as const, persistence: 'NOT_ESTABLISHED' as const,
  supplierRoleGranted: false as const, independentHumans: 'NOT_ESTABLISHED' as const,
});
function fail(code: string, status: 403 | 409 | 422, message: string): never { throw new DomainError(code, status, message); }
function activeMember(value: z.infer<typeof member>, org: z.infer<typeof organization>, at: number) {
  return value.environment === org.environment && value.organizationId === org.id && value.status === 'ACTIVE' &&
    value.principalKind === 'human' && value.organizationEpoch === org.authorityEpoch && current(value, at);
}
function assertIssuer(facts: SupplierAdministratorEnrollmentFacts, at: number) {
  const org = facts.organization, issuer = facts.issuer.member, s = facts.issuer.session;
  if (facts.selectedParty !== 'supplier' || facts.environment !== org.environment || org.status !== 'ACTIVE' || !current(org, at) ||
    !activeMember(issuer, org, at) || !issuer.roles.includes('owner') ||
    s.status !== 'ACTIVE' || !same(s.principal, issuer.principal) || !same(s.member, pin(issuer)) ||
    s.externalOrganizationId !== org.externalOrganizationId || s.externalMembershipId !== issuer.externalMembershipId ||
    s.organizationVersion !== org.version || s.organizationEpoch !== org.authorityEpoch ||
    ms(s.authenticatedAt) > ms(s.tokenIssuedAt) || ms(s.tokenIssuedAt) > at || ms(s.expiresAt) <= at ||
    !observed(s.membershipObservation, at) || issuer.grantBasis === 'clerk_admin_bootstrap' && s.externalRole !== 'org:admin')
    fail('SUPPLIER_ADMISSION_DENIED', 403, 'Current selected supplier human owner and pinned external session are required.');
  const f = facts.factors;
  if (!same(f.principal, s.principal) || f.sessionId !== s.id || f.tokenHash !== s.tokenHash ||
    f.externalOrganizationId !== s.externalOrganizationId || f.externalMembershipId !== s.externalMembershipId ||
    f.publicRequestHash !== facts.publicRequestHash || ms(f.observedAt) > at || ms(f.expiresAt) <= at ||
    ms(f.expiresAt) - ms(f.observedAt) > 30_000 || ms(f.expiresAt) <= ms(f.observedAt) ||
    at - ms(f.observedAt) >= SUPPLIER_ADMISSION_MAX_OBSERVATION_MS || ms(s.tokenIssuedAt) > ms(f.observedAt) ||
    [f.firstFactorAt, f.secondFactorAt].some(value => ms(value) > ms(s.tokenIssuedAt) || at - ms(value) >= 300_000))
    fail('SUPPLIER_ADMISSION_DENIED', 403, 'Original purpose-bound current factors are required.');
}
function assertTarget(facts: SupplierAdministratorEnrollmentFacts, at: number) {
  const target = facts.target, org = facts.organization;
  if (target.principalKind !== 'human' || target.externalOrganizationId !== org.externalOrganizationId ||
    !observed(target.observation, at) || target.principal.issuer !== facts.issuer.member.principal.issuer ||
    target.member !== null && (!activeMember(target.member, org, at) || !same(target.principal, target.member.principal) ||
      target.externalMembershipId !== target.member.externalMembershipId))
    fail('SUPPLIER_ADMISSION_DENIED', 403, 'A fresh exact human candidate in the selected supplier organization is required.');
  // The same private principal cannot acquire a second local actor/membership by
  // being presented as an absent candidate or an alternate local identity.
  if (same(target.principal, facts.issuer.member.principal) &&
    (target.member === null || !same(target.member, facts.issuer.member) || target.externalMembershipId !== facts.issuer.member.externalMembershipId))
    fail('SUPPLIER_ADMISSION_DENIED', 403, 'Self-enrollment must retain the exact current owner membership.');
  if (target.externalMembershipId === facts.issuer.member.externalMembershipId && !same(target.principal, facts.issuer.member.principal))
    fail('SUPPLIER_ADMISSION_DENIED', 403, 'The owner provider membership cannot be rebound to another principal.');
  if (target.member !== null && (target.member.actorId === facts.issuer.member.actorId || target.member.membershipId === facts.issuer.member.membershipId) &&
    !same(target.principal, facts.issuer.member.principal))
    fail('SUPPLIER_ADMISSION_DENIED', 403, 'Local membership cannot be rebound to another provider principal.');
}

/** Pure eligibility and proposed fence changes only. This never creates a role,
 * mints evidence, invokes a provider, or returns a committed receipt. */
export async function planSupplierAdministratorEnrollment(mutationInput: unknown, factsInput: unknown, now: string) {
  const mutation = immutable(SupplierEnrollmentMutationSchema.parse(mutationInput)), command = mutation.command;
  const facts = immutable(SupplierAdministratorEnrollmentFactsSchema.parse(factsInput));
  const at = ms(InstantSchema.parse(now)), { basis, selection } = command, org = facts.organization;
  assertIssuer(facts, at);
  assertTarget(facts, at);
  if (facts.publicRequestHash !== await supplierEnrollmentPublicRequestDigest(mutation))
    fail('SUPPLIER_ADMISSION_DENIED', 403, 'Factor evidence must bind this exact public mutation and original key.');
  if (!observed(facts.originalObservation, at) || !same(basis.observation, facts.originalObservation) ||
    basis.environment !== facts.environment || !same(basis.organization, { id: org.id, version: org.version, authorityEpoch: org.authorityEpoch }) ||
    !same(basis.issuer, pin(facts.issuer.member)) || !same(basis.target.candidate, facts.target.reference) ||
    !same(basis.target.member, facts.target.member === null ? null : pin(facts.target.member)) ||
    !same(basis.previousGrant, facts.currentGrant?.reference ?? null))
    fail('SUPPLIER_ADMISSION_STALE', 409, 'Original review, current identities and exact grant fences must agree.');
  if (ms(basis.observation.expiresAt) > Math.min(ms(facts.issuer.session.expiresAt), ms(facts.issuer.session.membershipObservation.expiresAt),
    ms(facts.target.observation.expiresAt)))
    fail('SUPPLIER_ADMISSION_STALE', 409, 'Review cannot outlive its original identity observations.');
  const previous = facts.currentGrant;
  if (previous !== null && (previous.reference.hash !== await supplierAdministratorGrantDigest(previous.record) ||
    previous.record.environment !== facts.environment || previous.record.organizationId !== org.id ||
    facts.target.member === null || previous.record.target.actorId !== facts.target.member.actorId ||
    previous.record.target.membershipId !== facts.target.member.membershipId ||
    previous.record.target.membershipVersion > facts.target.member.membershipVersion ||
    previous.record.organizationVersion > org.version || previous.record.authorityEpoch > org.authorityEpoch || ms(previous.record.issuedAt) > at))
    fail('SUPPLIER_ADMISSION_STALE', 409, 'The previous grant must retain its exact immutable target and history.');
  if (selection.action === 'revoke' && previous?.record.status === 'REVOKED')
    fail('SUPPLIER_ADMISSION_STALE', 409, 'An already revoked grant has no new revocation effect.');
  if (selection.action === 'grant' && facts.target.member?.roles.includes('supplier_admin'))
    fail('SUPPLIER_ADMISSION_DENIED', 403, 'A legacy role flag without an exact grant is not an enrollment basis.');
  const expiresAt = selection.action === 'revoke' ? new Date(at).toISOString() : selection.expiresAt;
  const ends = [org.expiresAt, facts.target.member?.expiresAt ?? null].filter((value): value is string => value !== null).map(ms);
  if (selection.action !== 'revoke' && (ms(expiresAt) <= at || ms(expiresAt) - at > SUPPLIER_ADMINISTRATOR_MAX_VALIDITY_MS ||
    ends.some(end => ms(expiresAt) > end)))
    fail('SUPPLIER_ADMISSION_INVALID', 422, 'Explicit grant expiry must fit the target membership and organization lifetime.');
  const expectedReviewHash = await supplierEnrollmentReviewDigest({
    schemaVersion: 1, role: 'supplier_admin', selection, basis, targetDisplayName: facts.target.displayName, previousGrant: previous,
  });
  if (expectedReviewHash !== command.reviewHash) fail('SUPPLIER_ADMISSION_STALE', 409, 'Exact displayed enrollment material has changed.');
  const previousVersion = previous?.record.version ?? 0, membershipVersion = facts.target.member?.membershipVersion ?? 0;
  if (previousVersion >= Number.MAX_SAFE_INTEGER || [membershipVersion, org.authorityEpoch, org.version].some(value => value >= 2_147_483_647))
    fail('SUPPLIER_ADMISSION_STALE', 409, 'An exhausted version cannot be advanced.');
  return immutable({ kind: 'SUPPLIER_ADMINISTRATOR_POLICY_DECISION' as const, decision: 'PERMITTED' as const, ...limitations,
    proposed: { action: selection.action, role: 'supplier_admin' as const, environment: facts.environment, organizationId: org.id,
      candidate: facts.target.reference, target: basis.target.member, previousGrant: basis.previousGrant,
      grantVersion: nextVersion(previousVersion), membershipVersion: nextVersion(membershipVersion),
      organizationVersion: nextVersion(org.version), authorityEpoch: nextVersion(org.authorityEpoch),
      validFrom: new Date(at).toISOString(), expiresAt, status: selection.action === 'revoke' ? 'REVOKED' as const : 'ACTIVE' as const },
    unrelatedMembershipRights: 'PRESERVE' as const, originalApprovals: 'DO_NOT_RESTAMP_OR_REVIVE' as const,
  });
}

const currentFacts = z.strictObject({ organization, member, grant: SupplierAdministratorGrantSnapshotSchema.nullable() });
/** Local grant prerequisite only. Runtime identity/session, current external membership,
 * relationship policy and each historical approval still require separate validation. */
export async function assessCurrentSupplierAdministratorGrant(input: unknown, now: string) {
  const facts = immutable(currentFacts.parse(input)), at = ms(InstantSchema.parse(now));
  const org = facts.organization, m = facts.member, grant = facts.grant;
  let reason: 'GRANT_MISSING' | 'MEMBERSHIP_NOT_CURRENT' | 'GRANT_NOT_CURRENT' | 'ROLE_GRANT_EXPIRED' | null = null;
  if (grant === null) reason = 'GRANT_MISSING';
  else {
    if (grant.reference.hash !== await supplierAdministratorGrantDigest(grant.record)) fail('SUPPLIER_ADMISSION_STALE', 409, 'Grant bytes do not match their exact hash.');
    if (org.status !== 'ACTIVE' || !current(org, at) || !activeMember(m, org, at) || !m.roles.includes('supplier_admin')) reason = 'MEMBERSHIP_NOT_CURRENT';
    else if (grant.record.status !== 'ACTIVE' || grant.record.environment !== org.environment || grant.record.organizationId !== org.id ||
      !same(grant.record.target, pin(m)) || grant.record.organizationVersion > org.version || grant.record.authorityEpoch > org.authorityEpoch ||
      ms(grant.record.validFrom) > at) reason = 'GRANT_NOT_CURRENT';
    else if (ms(grant.record.expiresAt) <= at) reason = 'ROLE_GRANT_EXPIRED';
  }
  return immutable({ kind: 'SUPPLIER_ADMINISTRATOR_GRANT_PREREQUISITE_ONLY' as const, current: reason === null, reason, ...limitations });
}

/** Compare PRIVATE principals supplied by the fixed verified-identity resolver.
 * Different local actor IDs or different accounts never prove distinct humans. */
export function assessSupplierApprovalPrincipalIndependence(input: unknown) {
  const value = z.strictObject({ buyer: principal, supplier: principal }).parse(input);
  return immutable({ kind: 'SUPPLIER_PRINCIPAL_COMPARISON_ONLY' as const,
    distinctPrincipals: !same(value.buyer, value.supplier), ...limitations });
}
