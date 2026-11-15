import { describe, expect, it } from 'vitest';
import { CreatePolicyDocumentCommandSchema, MandateAuthorityIntentSchema, MandateDecisionIntentSchema,
  MandateDecisionSchema, MandateEligibilitySchema, PolicyDocumentTextSchema, ProposeMandateCommandSchema } from './mandates';

const reference = { id: 'proposal_a', version: 1, hash: 'a'.repeat(64) };
const responsibility = { ...reference, id: 'responsibility_a', siteId: 'site_a' };
const expiry = '2026-11-14T13:00:00.000Z';
const propose = { proposalId: 'proposal_a', expectedProposalVersion: 0, previousProposal: null, mandateId: 'mandate_a',
  responsibility, expectedOrganizationEpoch: 3, previousAcceptedVersion: null, expectedHead: null,
  policy: { mode: 'ADVISE', siteIds: ['site_a'], actions: [], budgets: [], supplierRelationshipIds: [], acceptancePolicy: reference,
    communication: { maximumMessages: 0, recipientIds: [], purposes: [], messageKinds: [], expiresAt: expiry }, expiresAt: expiry },
  policyDocument: reference, expiresAt: expiry };
const intent = { schemaVersion: 1, action: 'AUTHORIZE', proposal: reference, expectedDecisionVersion: 1,
  expectedOrganizationEpoch: 3, expectedHead: null, reason: null };

describe('mandate public boundary', () => {
  it('supports initial authorization without inventing an active predecessor', () => {
    expect(ProposeMandateCommandSchema.parse(propose).expectedHead).toBeNull();
    expect(MandateDecisionIntentSchema.parse(intent).proposal).toEqual(reference);
  });
  it('rejects browser identity, role, MFA and unknown authority assertions', () => {
    for (const value of [
      { actor: { roles: ['owner'] } }, { approverId: 'owner_a' }, { stepUp: { verified: true } },
      { verifiedEvidence: { purpose: 'mandate_authorization' } }, { approved: true }, { policy: { eligibleRoles: ['operations'] } },
    ]) expect(MandateDecisionIntentSchema.safeParse({ ...intent, ...value }).success).toBe(false);
    expect(ProposeMandateCommandSchema.safeParse({ ...propose, requesterId: 'owner_a' }).success).toBe(false);
    expect(CreatePolicyDocumentCommandSchema.safeParse({ documentId: 'document_a', expectedVersion: 0, previousVersion: null,
      purpose: 'ACCEPTANCE_POLICY', text: 'Terms', createdBy: 'owner_a' }).success).toBe(false);
  });
  it('requires exact reference hashes, safe versions and complete reasons', () => {
    for (const proposal of [{ id: 'p', version: 1 }, { ...reference, hash: 'A'.repeat(64) }, { ...reference, version: 1.5 }]) {
      expect(MandateDecisionIntentSchema.safeParse({ ...intent, proposal }).success).toBe(false);
    }
    expect(MandateDecisionIntentSchema.safeParse({ ...intent, expectedOrganizationEpoch: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false);
    expect(MandateDecisionIntentSchema.safeParse({ ...intent, action: 'REJECT' }).success).toBe(false);
    expect(MandateDecisionIntentSchema.safeParse({ ...intent, action: 'AUTHORIZE', reason: 'Unrelated' }).success).toBe(false);
    expect(MandateDecisionIntentSchema.parse({ ...intent, action: 'REJECT', reason: ' Scope is incomplete ' }).reason).toBe('Scope is incomplete');
    const control = { schemaVersion: 1, action: 'RESUME', mandate: reference,
      head: { mandateId: 'mandate_a', mandateVersion: 1, mandateEpoch: 4, hash: 'b'.repeat(64) }, responsibility, expectedOrganizationEpoch: 3, reason: 'Resume advice' };
    expect(MandateAuthorityIntentSchema.safeParse(control).success).toBe(true);
    expect(MandateAuthorityIntentSchema.safeParse({ ...control, stepUp: {} }).success).toBe(false);
  });
  it('rejects incomplete document text while preserving Unicode, tabs and meaningful whitespace', () => {
    for (const text of ['', ' \n\t', 'a\u0000b', 'a\u000Bb', '\uD800', '\uDC00', 'a'.repeat(20_001)]) {
      expect(PolicyDocumentTextSchema.safeParse(text).success).toBe(false);
    }
    for (const text of ['  Signed evidence\n', 'café\t\r\nAccept 🚚 evidence']) expect(PolicyDocumentTextSchema.parse(text)).toBe(text);
  });
  it('keeps terminal outcome fields and presentation eligibility consistent', () => {
    const open = { proposal: reference, version: 1, state: 'OPEN', createdAt: expiry, decidedAt: null, actorId: null,
      intentHash: null, reason: null, replacement: null, authorization: null, operationId: 'operation_a' };
    expect(MandateDecisionSchema.safeParse(open).success).toBe(true);
    for (const invalid of [
      { ...open, state: 'APPROVED' }, { ...open, authorization: {} }, { ...open, actorId: 'owner_a' },
      { ...open, state: 'REJECTED', version: 2, decidedAt: expiry, actorId: 'owner_a', intentHash: reference.hash },
      { ...open, state: 'SUPERSEDED', version: 2, decidedAt: expiry, actorId: 'owner_a' },
    ]) expect(MandateDecisionSchema.safeParse(invalid).success).toBe(false);
    expect(MandateEligibilitySchema.safeParse({ action: 'AUTHORIZE', eligible: true, requiresStepUp: true, blockers: ['FORBIDDEN'] }).success).toBe(false);
    expect(MandateEligibilitySchema.parse({ action: 'AUTHORIZE', eligible: true, requiresStepUp: true, blockers: [] }).requiresStepUp).toBe(true);
  });
});
