import { describe, expect, it } from 'vitest';
import { FinancialPolicyPreparationQuerySchema, FinancialPolicyPreparationSchema } from './financial-policy-preparation-schema.js';

const hash = 'a'.repeat(64), ref = { id: 'document_a', version: 1, recordHash: hash };
const actor = { actorId: 'owner_a', membershipVersion: 2, subject: 'person_a', externalMembershipId: 'member_a', sessionId: 'session_new' };
const scope = { environment: 'development', organizationId: 'org_a', externalOrganizationId: 'clerk_org_a', actor,
  organizationEpoch: 2, roles: ['owner'], siteIds: ['site_a'], actionSiteIds: ['site_a'] };
const selection = { schemaVersion: 1, action: 'save_document', targetId: 'document_a', previous: null, purpose: 'budget_policy' };
const base = () => ({ schemaVersion: 1, scope: structuredClone(scope), responsibilityId: null, selection: structuredClone(selection),
  target: { state: 'absent', latestReference: null, record: null, historicalDocuments: [], control: null }, originalActorMatches: null,
  material: { action: 'save_document', purpose: 'budget_policy', organizationEpoch: 2, draftScope: null, siteActive: null },
  decision: { action: 'save_document', state: 'reviewable', reasons: [], requiredAuthentication: null },
  configurationWarnings: ['FINANCIAL_AUTHORITY_UNAVAILABLE', 'TRUST_UNAVAILABLE'], observedAt: '2026-11-15T12:00:00.000Z', expiresAt: '2026-11-15T12:00:20.000Z',
  effectiveAuthority: false, financialState: null });
function revision() {
  const record = { schemaVersion: 1, environment: 'development', organizationId: 'org_a', responsibilityId: null,
    id: ref.id, version: 1, predecessor: null, actor: { ...actor, membershipVersion: 1, subject: 'historical_person', sessionId: 'session_old' },
    identityEvidence: { id: 'evidence_original', version: 1, recordHash: hash }, organizationEpoch: 1,
    operationId: '00000000-0000-0000-0000-000000000001', createdAt: '2025-01-01T00:00:00.000Z',
    kind: 'document', purpose: 'budget_policy', text: 'Historical full text.', contentHash: hash };
  return { ...base(), selection: { ...selection, previous: ref }, originalActorMatches: true,
    target: { state: 'exact', latestReference: ref, record: { record, reference: ref, current: true, state: 'DOCUMENT', blockers: [], effectiveAuthority: false }, historicalDocuments: [], control: null } };
}
describe('private financial preparation capsule', () => {
  it('requires a canonical action/route and forbids caller authority, mutations and private identity selectors', () => {
    expect(FinancialPolicyPreparationQuerySchema.parse({ responsibilityId: null, selection })).toEqual({ responsibilityId: null, selection });
    for (const q of [{ responsibilityId: 'responsibility_a', selection }, { responsibilityId: null, selection, scope },
      { responsibilityId: null, selection: { ...selection, key: 'operation_key_12345' } },
      { responsibilityId: null, selection: { ...selection, previous: { ...ref, id: 'other' } } },
      { responsibilityId: null, selection: { ...selection, action: 'accept_governance' } }])
      expect(FinancialPolicyPreparationQuerySchema.safeParse(q).success).toBe(false);
  });
  it('keeps opaque unavailable targets distinct from absence and an explicitly changed predecessor', () => {
    expect(FinancialPolicyPreparationSchema.parse(base())).toEqual(base());
    for (const [state, latestReference, reason] of [['unavailable', null, 'TARGET_UNAVAILABLE'], ['changed', ref, 'PREDECESSOR_CHANGED']] as const) {
      const v = { ...base(), target: { ...base().target, state, latestReference }, decision: { ...base().decision, state: 'blocked', reasons: [reason] } };
      expect(FinancialPolicyPreparationSchema.safeParse(v).success).toBe(true);
      expect(FinancialPolicyPreparationSchema.safeParse({ ...v, originalActorMatches: false }).success).toBe(false);
      expect(FinancialPolicyPreparationSchema.safeParse({ ...v, decision: base().decision }).success).toBe(false);
    }
    expect(FinancialPolicyPreparationSchema.safeParse({ ...base(), selection: { ...selection, previous: ref } }).success).toBe(false);
  });
  it('uses document actor equality without inventing subject, membership-version or session equality', () => {
    expect(FinancialPolicyPreparationSchema.safeParse(revision()).success).toBe(true);
    const v = revision(); v.target.record.record.actor.actorId = 'other_actor';
    expect(FinancialPolicyPreparationSchema.safeParse(v).success).toBe(false);
    expect(FinancialPolicyPreparationSchema.safeParse({ ...v, originalActorMatches: false,
      decision: { ...v.decision, state: 'blocked', reasons: ['ORIGINAL_ACTOR_REQUIRED'] } }).success).toBe(true);
    expect(FinancialPolicyPreparationSchema.safeParse({ ...revision(), originalActorMatches: false }).success).toBe(false);
  });
  it('does not grant organization authoring from finance disclosure or expose it to Operations', () => {
    const v = { ...base(), scope: { ...scope, roles: ['finance'] } };
    expect(FinancialPolicyPreparationSchema.safeParse(v).success).toBe(false);
    expect(FinancialPolicyPreparationSchema.safeParse({ ...v, decision: { ...v.decision, state: 'blocked', reasons: ['ROLE_REQUIRED'] } }).success).toBe(true);
    expect(FinancialPolicyPreparationSchema.safeParse({ ...v, scope: { ...scope, roles: ['operations'] },
      decision: { ...v.decision, state: 'blocked', reasons: ['ROLE_REQUIRED'] } }).success).toBe(false);
  });
  it.each([{ effectiveAuthority: true }, { financialState: {} }, { lease: 'not_a_lease' }, { originalActorMatches: true },
    { expiresAt: '2026-11-15T12:00:20.001Z' }, { expiresAt: '2026-11-15T12:00:00.000Z' },
    { configurationWarnings: ['TRUST_UNAVAILABLE'] }, { configurationWarnings: ['TRUST_UNAVAILABLE', 'FINANCIAL_AUTHORITY_UNAVAILABLE'] }])
  ('rejects contradictory or unbounded private output %j', change => expect(FinancialPolicyPreparationSchema.safeParse({ ...base(), ...change }).success).toBe(false));
  it('binds exact predecessor, raw scope, purpose and historical material without partial substitution', () => {
    const v = revision();
    for (const record of [{ ...v.target.record.record, purpose: 'approval_policy' }, { ...v.target.record.record, organizationId: 'org_b' },
      { ...v.target.record.record, id: 'different' }]) expect(FinancialPolicyPreparationSchema.safeParse({ ...v, target: { ...v.target, record: { ...v.target.record, record } } }).success).toBe(false);
    expect(FinancialPolicyPreparationSchema.safeParse({ ...v, target: { ...v.target, historicalDocuments: [v.target.record] } }).success).toBe(false);
    expect(FinancialPolicyPreparationSchema.safeParse({ ...v, target: { ...v.target, record: { ...v.target.record, current: false, state: 'SUPERSEDED' } } }).success).toBe(false);
  });
});
