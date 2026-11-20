import { describe, expect, it } from 'vitest';
import {
  supplierAdministratorGrantDigest, supplierEnrollmentReviewDigest, supplierEnrollmentPublicRequestDigest,
  type SupplierEnrollmentSelection, type SupplierAdministratorGrantRecord,
} from '@pactwoven/contracts';
import {
  planSupplierAdministratorEnrollment, assessCurrentSupplierAdministratorGrant, assessSupplierApprovalPrincipalIndependence,
  type SupplierAdministratorEnrollmentFacts,
} from './supplier-administrator-grants';

const now = '2026-11-17T18:00:00.000Z', hash = 'a'.repeat(64);
const later = (ms: number) => new Date(Date.parse(now) + ms).toISOString();
const principal = { issuer: 'https://identity.example.test', subject: 'owner_subject' };
const pin = { actorId: 'owner', membershipId: 'member', membershipVersion: 1 };
function factsFixture(): SupplierAdministratorEnrollmentFacts {
  const member = { ...pin, environment: 'development' as const, organizationId: 'supplier', principalKind: 'human' as const,
    principal: { ...principal }, externalMembershipId: 'external_owner_member', organizationEpoch: 0,
    roles: ['owner' as const], status: 'ACTIVE' as const, validFrom: later(-86_400_000), expiresAt: null,
    grantBasis: 'clerk_admin_bootstrap' as const };
  const observation = { observedAt: now, expiresAt: later(20_000) };
  return { schemaVersion: 1, environment: 'development', selectedParty: 'supplier',
    organization: { id: 'supplier', environment: 'development', externalOrganizationId: 'external_supplier', version: 1, authorityEpoch: 0,
      status: 'ACTIVE', validFrom: later(-86_400_000), expiresAt: null },
    issuer: { member, session: { id: 'owner_session', principal: { ...principal }, externalOrganizationId: 'external_supplier',
      externalMembershipId: 'external_owner_member', externalRole: 'org:admin', member: { ...pin }, organizationVersion: 1, organizationEpoch: 0,
      status: 'ACTIVE', authenticatedAt: later(-50_000), tokenIssuedAt: later(-1000), expiresAt: later(300_000),
      membershipObservation: { ...observation }, tokenHash: hash } },
    target: { reference: { id: 'candidate', version: 1, hash }, principal: { ...principal }, externalOrganizationId: 'external_supplier',
      externalMembershipId: 'external_owner_member', principalKind: 'human', displayName: 'Current owner', observation: { ...observation },
      member: structuredClone(member) },
    originalObservation: { ...observation }, publicRequestHash: hash,
    factors: { purpose: 'supplier_administrator_enrollment', publicRequestHash: hash, reference: { id: 'factor_ref', version: 1, hash },
      principal: { ...principal }, sessionId: 'owner_session', tokenHash: hash, externalOrganizationId: 'external_supplier',
      externalMembershipId: 'external_owner_member', observedAt: now, expiresAt: later(30_000), firstFactorAt: later(-30_000), secondFactorAt: later(-10_000) },
    currentGrant: null };
}
function otherMember(facts: SupplierAdministratorEnrollmentFacts, absent = false) {
  facts.target.principal.subject = 'target_subject';
  facts.target.externalMembershipId = 'external_target_member';
  facts.target.displayName = 'Current member';
  facts.target.member = absent ? null : { ...facts.issuer.member, actorId: 'target', membershipId: 'target_member',
    roles: ['receiver'], principal: { ...facts.target.principal }, externalMembershipId: facts.target.externalMembershipId, grantBasis: 'owner_grant' };
}
async function prepare(facts = factsFixture(), action: 'grant' | 'renew' | 'revoke' = 'grant', expiresAt = later(86_400_000)) {
  const member = facts.target.member;
  const basis = { environment: facts.environment, organization: { id: facts.organization.id, version: facts.organization.version,
    authorityEpoch: facts.organization.authorityEpoch }, issuer: { actorId: facts.issuer.member.actorId, membershipId: facts.issuer.member.membershipId,
    membershipVersion: facts.issuer.member.membershipVersion }, target: { candidate: facts.target.reference,
    member: member === null ? null : { actorId: member.actorId, membershipId: member.membershipId, membershipVersion: member.membershipVersion } },
    previousGrant: facts.currentGrant?.reference ?? null, observation: facts.originalObservation };
  const selection: SupplierEnrollmentSelection = action === 'grant' ? { action, candidate: facts.target.reference, expiresAt } :
    action === 'renew' ? { action, grant: facts.currentGrant!.reference, expiresAt } : { action, grant: facts.currentGrant!.reference };
  const reviewHash = await supplierEnrollmentReviewDigest({ schemaVersion: 1, role: 'supplier_admin', selection, basis,
    targetDisplayName: facts.target.displayName, previousGrant: facts.currentGrant });
  const mutation = { idempotencyKey: 'supplier_original_enroll_001', command: { schemaVersion: 1, role: 'supplier_admin', selection, basis, reviewHash } };
  facts.publicRequestHash = await supplierEnrollmentPublicRequestDigest(mutation);
  facts.factors.publicRequestHash = facts.publicRequestHash;
  return { facts, mutation: structuredClone(mutation) };
}
async function withGrant(status: 'ACTIVE' | 'REVOKED' = 'ACTIVE', expiresAt = later(10_000)) {
  const facts = factsFixture();
  facts.organization.version = 2; facts.organization.authorityEpoch = 1;
  facts.issuer.member.membershipVersion = 2; facts.issuer.member.organizationEpoch = 1;
  facts.issuer.member.roles = ['owner', 'supplier_admin'];
  facts.issuer.session.member.membershipVersion = 2; facts.issuer.session.organizationVersion = 2; facts.issuer.session.organizationEpoch = 1;
  facts.target.member = structuredClone(facts.issuer.member);
  const record: SupplierAdministratorGrantRecord = { schemaVersion: 1, id: 'grant', environment: 'development', organizationId: 'supplier', role: 'supplier_admin',
    version: status === 'ACTIVE' ? 1 : 2, predecessor: status === 'ACTIVE' ? null : { id: 'grant', version: 1, hash },
    action: status === 'ACTIVE' ? 'grant' : 'revoke', status, target: { ...pin, membershipVersion: 2 }, issuer: { ...pin },
    organizationVersion: 2, authorityEpoch: 1, issuedAt: later(-1000), validFrom: later(-1000), expiresAt: status === 'ACTIVE' ? expiresAt : later(-1000) };
  facts.currentGrant = { record, reference: { id: record.id, version: record.version, hash: await supplierAdministratorGrantDigest(record) } };
  return facts;
}

describe('supplier administrator pure policy', () => {
  it('permits explicit owner self-enrollment while declaring no runtime proof or role effect', async () => {
    const { facts, mutation } = await prepare();
    const before = structuredClone(facts);
    const decision = await planSupplierAdministratorEnrollment(mutation, facts, later(1000));
    expect(decision).toMatchObject({ kind: 'SUPPLIER_ADMINISTRATOR_POLICY_DECISION', decision: 'PERMITTED',
      authentication: 'NOT_ESTABLISHED', identityProof: 'NOT_ESTABLISHED', persistence: 'NOT_ESTABLISHED', supplierRoleGranted: false,
      bookingAuthority: false, contractualAcceptance: false, paymentAuthority: false,
      proposed: { grantVersion: 1, membershipVersion: 2, organizationVersion: 2, authorityEpoch: 1, expiresAt: later(86_400_000) },
      unrelatedMembershipRights: 'PRESERVE', originalApprovals: 'DO_NOT_RESTAMP_OR_REVIVE' });
    expect(facts).toEqual(before);
    expect(Object.isFrozen(decision.proposed)).toBe(true);
  });
  it('permits a current own-organization candidate with an exact existing or absent local member', async () => {
    for (const absent of [false, true]) {
      const facts = factsFixture(); otherMember(facts, absent);
      const { mutation } = await prepare(facts);
      const decision = await planSupplierAdministratorEnrollment(mutation, facts, later(1000));
      expect(decision.proposed.membershipVersion).toBe(absent ? 1 : 2);
      expect(decision.proposed.target).toEqual(absent ? null : { actorId: 'target', membershipId: 'target_member', membershipVersion: 1 });
      expect(facts.target.member?.roles).toEqual(absent ? undefined : ['receiver']);
    }
  });
  it.each([
    ['buyer lane', (f: SupplierAdministratorEnrollmentFacts) => { f.selectedParty = 'buyer'; }],
    ['supplier administrator delegation', (f: SupplierAdministratorEnrollmentFacts) => { f.issuer.member.roles = ['supplier_admin']; }],
    ['service issuer', (f: SupplierAdministratorEnrollmentFacts) => { f.issuer.member.principalKind = 'service'; }],
    ['service target', (f: SupplierAdministratorEnrollmentFacts) => { f.target.principalKind = 'service'; }],
    ['foreign target organization', (f: SupplierAdministratorEnrollmentFacts) => { f.target.externalOrganizationId = 'another_org'; }],
    ['foreign local target', (f: SupplierAdministratorEnrollmentFacts) => { f.target.member!.organizationId = 'another_org'; }],
    ['bootstrap without current org admin', (f: SupplierAdministratorEnrollmentFacts) => { f.issuer.session.externalRole = 'org:member'; }],
    ['revoked owner', (f: SupplierAdministratorEnrollmentFacts) => { f.issuer.member.status = 'REVOKED'; }],
    ['suspended target', (f: SupplierAdministratorEnrollmentFacts) => { f.target.member!.status = 'SUSPENDED'; }],
    ['inactive organization', (f: SupplierAdministratorEnrollmentFacts) => { f.organization.status = 'SUSPENDED'; }],
    ['wrong session principal', (f: SupplierAdministratorEnrollmentFacts) => { f.issuer.session.principal.subject = 'other'; }],
    ['absent self candidate', (f: SupplierAdministratorEnrollmentFacts) => { f.target.member = null; }],
    ['rebound local actor', (f: SupplierAdministratorEnrollmentFacts) => { f.target.principal.subject = 'other'; f.target.member!.principal.subject = 'other'; }],
  ])('rejects %s even though the JSON parses', async (_name, change) => {
    const { facts, mutation } = await prepare(); change(facts);
    await expect(planSupplierAdministratorEnrollment(mutation, facts, later(1000))).rejects.toMatchObject({ code: 'SUPPLIER_ADMISSION_DENIED' });
  });
  it('rejects changed issuer, organization, candidate, target or display material instead of rebasing it', async () => {
    const cases = [
      (f: SupplierAdministratorEnrollmentFacts) => { f.organization.version++; f.issuer.session.organizationVersion++; },
      (f: SupplierAdministratorEnrollmentFacts) => { f.organization.authorityEpoch++; f.issuer.member.organizationEpoch++; f.issuer.session.organizationEpoch++; f.target.member!.organizationEpoch++; },
      (f: SupplierAdministratorEnrollmentFacts) => { f.target.reference = { ...f.target.reference, version: 2 }; },
      (f: SupplierAdministratorEnrollmentFacts) => { f.issuer.member.membershipVersion++; f.issuer.session.member.membershipVersion++; f.target.member!.membershipVersion++; },
      (f: SupplierAdministratorEnrollmentFacts) => { f.target.displayName = 'Changed visible target'; },
    ];
    for (const change of cases) {
      const { facts, mutation } = await prepare(); change(facts);
      await expect(planSupplierAdministratorEnrollment(mutation, facts, later(1000))).rejects.toMatchObject({ code: 'SUPPLIER_ADMISSION_STALE' });
    }
  });
  it('rejects hash-bound owner provider-membership rebinding to a different absent or distinct local candidate', async () => {
    for (const absent of [false, true]) {
      const facts = factsFixture(); otherMember(facts, absent);
      facts.target.externalMembershipId = facts.issuer.member.externalMembershipId;
      if (facts.target.member !== null) facts.target.member.externalMembershipId = facts.target.externalMembershipId;
      const { mutation } = await prepare(facts);
      expect(facts.target.principal.subject).not.toBe(facts.issuer.member.principal.subject);
      expect(facts.target.externalOrganizationId).toBe(facts.issuer.session.externalOrganizationId);
      expect(facts.publicRequestHash).toBe(await supplierEnrollmentPublicRequestDigest(mutation));
      await expect(planSupplierAdministratorEnrollment(mutation, facts, later(1000))).rejects.toMatchObject({ code: 'SUPPLIER_ADMISSION_DENIED' });
    }
  });
  it('retains the original observation and rejects expiry after a wait without refreshing it', async () => {
    const { facts, mutation } = await prepare();
    await expect(planSupplierAdministratorEnrollment(mutation, facts, later(19_999))).resolves.toMatchObject({ decision: 'PERMITTED' });
    for (const at of [later(20_000), later(20_001), later(-1)])
      await expect(planSupplierAdministratorEnrollment(mutation, facts, at)).rejects.toThrow();
    const changed = structuredClone(facts);
    changed.originalObservation = { observedAt: later(5000), expiresAt: later(25_000) };
    await expect(planSupplierAdministratorEnrollment(mutation, changed, later(6000))).rejects.toMatchObject({ code: 'SUPPLIER_ADMISSION_STALE' });
    changed.originalObservation = facts.originalObservation;
    changed.target.observation.expiresAt = later(10_000);
    await expect(planSupplierAdministratorEnrollment(mutation, changed, later(1000))).rejects.toMatchObject({ code: 'SUPPLIER_ADMISSION_STALE' });
  });
  it('requires exact original-key factor binding and conservative factor/session ages', async () => {
    const cases = [
      (f: SupplierAdministratorEnrollmentFacts) => { f.factors.publicRequestHash = 'b'.repeat(64); },
      (f: SupplierAdministratorEnrollmentFacts) => { f.publicRequestHash = 'b'.repeat(64); f.factors.publicRequestHash = f.publicRequestHash; },
      (f: SupplierAdministratorEnrollmentFacts) => { f.factors.sessionId = 'another_session'; },
      (f: SupplierAdministratorEnrollmentFacts) => { f.factors.firstFactorAt = later(-299_000); },
      (f: SupplierAdministratorEnrollmentFacts) => { f.factors.secondFactorAt = now; },
      (f: SupplierAdministratorEnrollmentFacts) => { f.factors.expiresAt = later(30_001); },
      (f: SupplierAdministratorEnrollmentFacts) => { f.issuer.session.expiresAt = later(1000); },
      (f: SupplierAdministratorEnrollmentFacts) => { f.factors.tokenHash = 'b'.repeat(64); },
    ];
    for (const change of cases) {
      const { facts, mutation } = await prepare(); change(facts);
      await expect(planSupplierAdministratorEnrollment(mutation, facts, later(1000))).rejects.toMatchObject({ code: 'SUPPLIER_ADMISSION_DENIED' });
    }
    const { facts, mutation } = await prepare();
    await expect(planSupplierAdministratorEnrollment({ ...mutation, idempotencyKey: 'different_original_key' }, facts, later(1000)))
      .rejects.toMatchObject({ code: 'SUPPLIER_ADMISSION_DENIED' });
  });
  it('uses an explicit expiry within thirty days and durable target bounds without shortening membership', async () => {
    const facts = factsFixture(); otherMember(facts);
    facts.target.member!.expiresAt = later(10_000);
    const { mutation } = await prepare(facts, 'grant', later(10_000));
    const result = await planSupplierAdministratorEnrollment(mutation, facts, later(1000));
    expect(result.proposed.expiresAt).toBe(later(10_000));
    expect(facts.target.member!.expiresAt).toBe(later(10_000));
    for (const bound of ['member', 'organization'] as const) {
      const f = factsFixture(); otherMember(f);
      if (bound === 'member') f.target.member!.expiresAt = later(10_000); else f.organization.expiresAt = later(10_000);
      const request = await prepare(f, 'grant', later(10_001));
      await expect(planSupplierAdministratorEnrollment(request.mutation, f, later(1000))).rejects.toMatchObject({ code: 'SUPPLIER_ADMISSION_INVALID' });
    }
    const max = await prepare(factsFixture(), 'grant', later(2_592_000_000));
    await expect(planSupplierAdministratorEnrollment(max.mutation, max.facts, later(1000))).resolves.toMatchObject({ decision: 'PERMITTED' });
    const elapsed = await prepare(factsFixture(), 'grant', later(1000));
    await expect(planSupplierAdministratorEnrollment(elapsed.mutation, elapsed.facts, later(1000))).rejects.toMatchObject({ code: 'SUPPLIER_ADMISSION_INVALID' });
  });
  it('renews expired or revoked grants as new versions and permits owner self or last-admin revocation', async () => {
    for (const status of ['ACTIVE', 'REVOKED'] as const) {
      const facts = await withGrant(status, later(-1)), { mutation } = await prepare(facts, 'renew');
      const decision = await planSupplierAdministratorEnrollment(mutation, facts, later(1000));
      expect(decision.proposed).toMatchObject({ grantVersion: facts.currentGrant!.record.version + 1, membershipVersion: 3, organizationVersion: 3, authorityEpoch: 2, status: 'ACTIVE' });
      expect(decision.originalApprovals).toBe('DO_NOT_RESTAMP_OR_REVIVE');
      expect(facts.currentGrant!.record.status).toBe(status);
    }
    const facts = await withGrant(), { mutation } = await prepare(facts, 'revoke');
    const decision = await planSupplierAdministratorEnrollment(mutation, facts, later(1000));
    expect(decision.proposed).toMatchObject({ status: 'REVOKED', validFrom: later(1000), expiresAt: later(1000), membershipVersion: 3 });
    const revoked = await withGrant('REVOKED'), request = await prepare(revoked, 'revoke');
    await expect(planSupplierAdministratorEnrollment(request.mutation, revoked, later(1000))).rejects.toMatchObject({ code: 'SUPPLIER_ADMISSION_STALE' });
  });
  it('does not infer an exact grant from an existing role flag or tolerate corrupt grant bytes', async () => {
    const f = factsFixture(); f.issuer.member.roles.push('supplier_admin'); f.target.member!.roles.push('supplier_admin');
    const request = await prepare(f);
    await expect(planSupplierAdministratorEnrollment(request.mutation, f, later(1000))).rejects.toMatchObject({ code: 'SUPPLIER_ADMISSION_DENIED' });
    const facts = await withGrant(), { mutation } = await prepare(facts, 'renew');
    facts.currentGrant!.record.expiresAt = later(11_000);
    await expect(planSupplierAdministratorEnrollment(mutation, facts, later(1000))).rejects.toMatchObject({ code: 'SUPPLIER_ADMISSION_STALE' });
  });
  it('fails closed at installed identity version limits', async () => {
    for (const target of ['member', 'epoch', 'organization'] as const) {
      const f = factsFixture();
      if (target === 'member') { f.issuer.member.membershipVersion = 2_147_483_647; f.target.member!.membershipVersion = 2_147_483_647; f.issuer.session.member.membershipVersion = 2_147_483_647; }
      if (target === 'epoch') { f.organization.authorityEpoch = 2_147_483_647; f.issuer.member.organizationEpoch = 2_147_483_647; f.target.member!.organizationEpoch = 2_147_483_647; f.issuer.session.organizationEpoch = 2_147_483_647; }
      if (target === 'organization') { f.organization.version = 2_147_483_647; f.issuer.session.organizationVersion = 2_147_483_647; }
      const { mutation } = await prepare(f);
      await expect(planSupplierAdministratorEnrollment(mutation, f, later(1000))).rejects.toMatchObject({ code: 'SUPPLIER_ADMISSION_STALE' });
    }
  });
  it('does not extend current grant validity when observed again, and stale membership cannot revive it', async () => {
    const facts = await withGrant(), current = { organization: facts.organization, member: facts.target.member, grant: facts.currentGrant };
    await expect(assessCurrentSupplierAdministratorGrant(current, later(9999))).resolves.toMatchObject({ current: true, identityProof: 'NOT_ESTABLISHED', supplierRoleGranted: false });
    await expect(assessCurrentSupplierAdministratorGrant(current, later(10_000))).resolves.toMatchObject({ current: false, reason: 'ROLE_GRANT_EXPIRED' });
    await expect(assessCurrentSupplierAdministratorGrant(current, later(11_000))).resolves.toMatchObject({ current: false, reason: 'ROLE_GRANT_EXPIRED' });
    expect(facts.currentGrant!.record.expiresAt).toBe(later(10_000));
    await expect(assessCurrentSupplierAdministratorGrant({ ...current, member: { ...facts.target.member, membershipVersion: 3 } }, later(1000)))
      .resolves.toMatchObject({ current: false, reason: 'GRANT_NOT_CURRENT' });
    await expect(assessCurrentSupplierAdministratorGrant({ ...current, grant: null }, later(1000))).resolves.toMatchObject({ current: false, reason: 'GRANT_MISSING' });
  });
  it('blocks current grants on membership or organization loss and rejects corrupt current hashes', async () => {
    const facts = await withGrant(), current = { organization: facts.organization, member: facts.target.member, grant: facts.currentGrant };
    for (const member of [{ ...facts.target.member, status: 'REVOKED' }, { ...facts.target.member, roles: ['owner'] }, { ...facts.target.member, organizationEpoch: 0 }])
      await expect(assessCurrentSupplierAdministratorGrant({ ...current, member }, later(1000))).resolves.toMatchObject({ current: false, reason: 'MEMBERSHIP_NOT_CURRENT' });
    await expect(assessCurrentSupplierAdministratorGrant({ ...current, organization: { ...facts.organization, status: 'SUSPENDED' } }, later(1000)))
      .resolves.toMatchObject({ current: false, reason: 'MEMBERSHIP_NOT_CURRENT' });
    facts.currentGrant!.reference.hash = hash;
    await expect(assessCurrentSupplierAdministratorGrant(current, later(1000))).rejects.toMatchObject({ code: 'SUPPLIER_ADMISSION_STALE' });
  });
  it('compares private issuer plus subject and never declares distinct humans or verifies identities', () => {
    expect(assessSupplierApprovalPrincipalIndependence({ buyer: principal, supplier: principal })).toMatchObject({ distinctPrincipals: false, independentHumans: 'NOT_ESTABLISHED', identityProof: 'NOT_ESTABLISHED' });
    for (const supplier of [{ ...principal, subject: 'other_subject' }, { ...principal, issuer: 'https://another-issuer.example.test' }])
      expect(assessSupplierApprovalPrincipalIndependence({ buyer: principal, supplier })).toMatchObject({ distinctPrincipals: true, independentHumans: 'NOT_ESTABLISHED', supplierRoleGranted: false });
    expect(() => assessSupplierApprovalPrincipalIndependence({ buyer: { actorId: 'a' }, supplier: { actorId: 'b' } })).toThrow();
    expect(() => assessSupplierApprovalPrincipalIndependence({ buyer: { ...principal, verified: true }, supplier: principal })).toThrow();
  });
  it('captures inputs before hash awaits so caller mutation cannot alter the decision', async () => {
    const { facts, mutation } = await prepare();
    const pending = planSupplierAdministratorEnrollment(mutation, facts, later(1000));
    facts.target.displayName = 'Changed after dispatch'; facts.organization.authorityEpoch = 50;
    mutation.idempotencyKey = 'different_original_key';
    const result = await pending;
    expect(result.proposed.authorityEpoch).toBe(1);
    expect(result.decision).toBe('PERMITTED');
  });
});
