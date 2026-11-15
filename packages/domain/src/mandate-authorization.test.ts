import { describe, expect, it } from 'vitest';
import { MandateReadEnvelopeSchema, type ActorContext, type MandateAuthorityIntent, type MandateDecisionIntent,
  type MandatePolicy, type ProposeMandateCommand, type Responsibility } from '@pactwoven/contracts';
import { changeMandateAuthority, decideMandateProposal, expireMandateAuthority, mandateDecisionEligibility,
  mandateIntentHash, recoverMandateDecisionOperation, type VerifiedMandateEvidence } from './mandate-authorization.js';
import { assertMandateAction } from './authority.js';
import { createMandateProposal, createPolicyDocumentVersion, expireMandateProposal, mandateHeadReference,
  mandateReference, mandateResponsibilityReference, mandateVersionReference, type MandateCurrentContext } from './mandate-proposals.js';

const now = '2026-11-14T12:00:00.000Z';
const expiry = '2026-11-14T13:00:00.000Z';
const requester: ActorContext = { actorId: 'requester_a', principalKind: 'human', organizationId: 'org_a', environment: 'development',
  roles: ['operations'], siteIds: ['site_a'], actionSiteIds: ['site_a'], sessionId: 'requester_session', authenticatedAt: now, correlationId: 'trace_a' };
const approver: ActorContext = { ...requester, actorId: 'finance_a', roles: ['finance'], sessionId: 'finance_session' };
const responsibility: Responsibility = { id: 'responsibility_a', organizationId: 'org_a', environment: 'development', ownerId: requester.actorId,
  title: 'Prepare an event', description: '', siteId: 'site_a', version: 1,
  window: { startsAt: now, endsAt: expiry, timeZone: 'America/Chicago' }, requirements: [], acceptancePolicy: 'Require signed delivery evidence.',
  executionState: 'DRAFT', authorityState: null, coverageState: 'UNKNOWN', createdAt: now, updatedAt: now };
async function fixture() {
  const acceptance = await createPolicyDocumentVersion({ actor: requester, now }, { documentId: 'acceptance_a', expectedVersion: 0, previousVersion: null,
    purpose: 'ACCEPTANCE_POLICY', text: responsibility.acceptancePolicy }, null);
  const document = await createPolicyDocumentVersion({ actor: requester, now }, { documentId: 'policy_a', expectedVersion: 0, previousVersion: null,
    purpose: 'MANDATE_POLICY', text: 'Advise only; no money or outbound messages.' }, null);
  const policy: MandatePolicy = { mode: 'ADVISE', siteIds: ['site_a'], actions: [], budgets: [], supplierRelationshipIds: [],
    acceptancePolicy: mandateReference(acceptance), communication: { maximumMessages: 0, recipientIds: [], purposes: [], messageKinds: [], expiresAt: expiry }, expiresAt: expiry };
  const current: MandateCurrentContext = { organizationId: 'org_a', environment: 'development', organizationEpoch: 2, now, responsibility,
    site: { id: 'site_a', organizationId: 'org_a', environment: 'development', active: true }, acceptedVersion: null, head: null, documents: [acceptance, document] };
  const command: ProposeMandateCommand = { proposalId: 'proposal_a', expectedProposalVersion: 0, previousProposal: null, mandateId: 'mandate_a',
    responsibility: await mandateResponsibilityReference(responsibility), expectedOrganizationEpoch: 2, previousAcceptedVersion: null,
    expectedHead: null, policy, policyDocument: mandateReference(document), expiresAt: '2026-11-14T12:30:00.000Z' };
  const proposed = await createMandateProposal({ ...current, actor: requester, operationId: 'propose_a', previousProposal: null, previousDecision: null }, command);
  const intent: MandateDecisionIntent = { schemaVersion: 1, action: 'AUTHORIZE', proposal: mandateReference(proposed.proposal), expectedDecisionVersion: 1,
    expectedOrganizationEpoch: 2, expectedHead: null, reason: null };
  const stepUp: VerifiedMandateEvidence = { id: 'verified_a', purpose: 'mandate_authorization', intentHash: await mandateIntentHash(intent), actorId: approver.actorId,
    sessionId: approver.sessionId, verifiedAt: now, expiresAt: '2026-11-14T12:05:00.000Z' };
  const context = { ...current, actor: approver, requester, stepUp: stepUp as VerifiedMandateEvidence | null, receiptId: 'receipt_a', operationId: 'decision_a' };
  return { ...proposed, current, context, intent, stepUp, command };
}
async function acceptedFixture() {
  const base = await fixture();
  const accepted = await decideMandateProposal(base.context, base.proposal, base.decision, base.intent);
  const control = { ...base.context, ...accepted.authorityChange!, acceptedProposal: base.proposal, acceptedDecision: accepted.decision, operationId: 'control_a' };
  const intent: MandateAuthorityIntent = { schemaVersion: 1, action: 'PAUSE', mandate: await mandateVersionReference(control.acceptedVersion),
    head: await mandateHeadReference(control.head), responsibility: await mandateResponsibilityReference(responsibility), expectedOrganizationEpoch: 2, reason: 'Pause new authority' };
  return { ...base, accepted, control, controlIntent: intent };
}
async function pausedFixture() {
  const base = await acceptedFixture();
  const paused = await changeMandateAuthority({ ...base.control, stepUp: null }, base.controlIntent);
  const resume: MandateAuthorityIntent = { ...base.controlIntent, action: 'RESUME', head: await mandateHeadReference(paused.head), reason: 'Resume current advice' };
  const resumeProof: VerifiedMandateEvidence = { ...base.stepUp, id: 'verified_resume', purpose: 'mandate_control', intentHash: await mandateIntentHash(resume) };
  return { ...base, paused, resume, resumeProof, pausedContext: { ...base.control, head: paused.head, stepUp: resumeProof } };
}

describe('independent initial mandate authorization', () => {
  it('bootstraps an accepted version only through an exact independent current owner or finance decision', async () => {
    const base = await fixture();
    for (const role of ['owner', 'finance'] as const) {
      const result = await decideMandateProposal({ ...base.context, actor: { ...approver, roles: [role] } }, base.proposal, base.decision, base.intent);
      expect(result.authorityChange!.acceptedVersion).toMatchObject({ version: 1, mandateEpoch: 1, organizationEpoch: 2, previousVersionHash: null,
        policy: { mode: 'ADVISE', actions: [], budgets: [], supplierRelationshipIds: [] }, createdBy: requester.actorId });
      expect(result.authorityChange!.head).toMatchObject({ state: 'ACTIVE', mandateVersion: 1, mandateEpoch: 1 });
      expect(result.decision).toMatchObject({ state: 'APPROVED', version: 2, operationId: 'decision_a', authorization: { requesterId: requester.actorId, approverId: approver.actorId } });
      expect(result.decision.authorization!.acceptedVersion).toEqual(await mandateVersionReference(result.authorityChange!.acceptedVersion));
      expect(result.decision.authorization!.acceptedHead).toEqual(await mandateHeadReference(result.authorityChange!.head));
      expect(base.current.head).toBeNull();
      expect(base.decision.state).toBe('OPEN');
      expect(() => { result.authorityChange!.head.state = 'REVOKED'; }).toThrow();
    }
  });
  it('never treats approved ADVISE authority as funding, payment, execution or coverage', async () => {
    const { accepted, control } = await acceptedFixture();
    const { acceptedVersion, head } = accepted.authorityChange!;
    expect(control.responsibility).toMatchObject({ executionState: 'DRAFT', authorityState: null, coverageState: 'UNKNOWN' });
    await expect(assertMandateAction({ schemaVersion: 1, kind: 'allocate_funds', responsibilityId: responsibility.id,
      authority: { organizationId: 'org_a', environment: 'development', organizationEpoch: 2, mandateId: 'mandate_a', mandateVersion: 1, mandateEpoch: 1 },
      siteId: 'site_a', supplierRelationshipId: null, terms: null, payee: null, withdrawal: null, toolPurchase: null,
      assets: [{ id: 'asset_a', environment: 'development', network: 'solana-devnet', mint: 'test_mint', tokenProgram: 'test_program', symbol: 'TEST', decimals: 6 }],
      components: [{ id: 'component_a', economicPortionId: 'portion_a', assetId: 'asset_a', category: 'supplier_principal', amountBaseUnits: '1' }],
      expiresAt: expiry, nonce: 'nonce_a' }, head, acceptedVersion, now, null, approver)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it.each(['operations', 'auditor', 'receiver', 'supplier_admin', 'supplier_dispatcher', 'support', 'service'] as const)
    ('denies the %s role regardless of a current site or injected eligibleRoles field', async role => {
      const base = await fixture();
      await expect(decideMandateProposal({ ...base.context, actor: { ...approver, roles: [role] } }, base.proposal, base.decision, base.intent))
        .rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(decideMandateProposal(base.context, base.proposal, base.decision, { ...base.intent, eligibleRoles: [role] } as never)).rejects.toBeDefined();
    });
  it('rejects self-approval, services carrying a buyer role, foreign actors and missing explicit action scope', async () => {
    const base = await fixture();
    for (const actor of [
      { ...approver, principalKind: 'service' as const }, { ...approver, organizationId: 'other_org' }, { ...approver, environment: 'production' as const },
      { ...approver, actionSiteIds: [] }, { ...approver, siteIds: ['site_a', 'site_b'], actionSiteIds: ['site_b'] },
    ]) await expect(decideMandateProposal({ ...base.context, actor }, base.proposal, base.decision, base.intent)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(decideMandateProposal({ ...base.context, actor: { ...requester, roles: ['owner'] } }, base.proposal, base.decision, base.intent))
      .rejects.toMatchObject({ code: 'INDEPENDENT_APPROVER_REQUIRED' });
    for (const original of [{ ...requester, actionSiteIds: [] }, { ...requester, roles: ['auditor'] as ActorContext['roles'] }, { ...requester, organizationId: 'other_org' }]) {
      await expect(decideMandateProposal({ ...base.context, requester: original }, base.proposal, base.decision, base.intent)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    await expect(decideMandateProposal({ ...base.context, requester: { ...requester, actorId: 'other_requester' } }, base.proposal, base.decision, base.intent))
      .rejects.toMatchObject({ code: 'REQUESTER_CHANGED' });
  });
  it('requires purpose-specific exact-intent MFA, not membership proof, generic evidence or a browser assertion', async () => {
    const base = await fixture();
    const invalid = [null, true, { ...base.stepUp, purpose: 'member_access' }, { ...base.stepUp, purpose: 'mandate_control' },
      { ...base.stepUp, intentHash: 'f'.repeat(64) }, { ...base.stepUp, actorId: requester.actorId }, { ...base.stepUp, sessionId: 'another_session' },
      { ...base.stepUp, verifiedAt: '2026-11-14T12:00:00.001Z' }, { ...base.stepUp, verifiedAt: '2026-11-14T11:55:00.000Z' },
      { ...base.stepUp, expiresAt: now }, { ...base.stepUp, providerAssertion: true }];
    for (const proof of invalid) await expect(decideMandateProposal({ ...base.context, stepUp: proof as VerifiedMandateEvidence }, base.proposal, base.decision, base.intent))
      .rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
    const nearlyExpired = { ...base.stepUp, verifiedAt: '2026-11-14T11:55:00.001Z', expiresAt: expiry };
    const accepted = await decideMandateProposal({ ...base.context, stepUp: nearlyExpired }, base.proposal, base.decision, base.intent);
    expect(accepted.decision.authorization!.stepUpExpiresAt).toBe('2026-11-14T12:00:00.001Z');
    await expect(decideMandateProposal({ ...base.context, stepUp: nearlyExpired, now: '2026-11-14T12:00:00.001Z' }, base.proposal, base.decision, base.intent))
      .rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
  });
  it('rejects stale organization, responsibility, site, proposal hash, decision version and exact expiry', async () => {
    const base = await fixture();
    for (const [context, code] of [
      [{ ...base.context, organizationEpoch: 3 }, 'ORGANIZATION_CHANGED'],
      [{ ...base.context, responsibility: { ...responsibility, version: 2 } }, 'RESPONSIBILITY_CHANGED'],
      [{ ...base.context, site: { ...base.context.site, active: false } }, 'SITE_UNAVAILABLE'],
      [{ ...base.context, now: base.proposal.expiresAt }, 'PROPOSAL_EXPIRED'],
    ] as const) await expect(decideMandateProposal(context, base.proposal, base.decision, base.intent)).rejects.toMatchObject({ code });
    for (const intent of [
      { ...base.intent, expectedOrganizationEpoch: 3 }, { ...base.intent, expectedDecisionVersion: 2 },
      { ...base.intent, proposal: { ...base.intent.proposal, hash: 'f'.repeat(64) } },
      { ...base.intent, expectedHead: { mandateId: 'mandate_a', mandateVersion: 1, mandateEpoch: 1, hash: 'f'.repeat(64) } },
    ]) await expect(decideMandateProposal(base.context, base.proposal, base.decision, intent)).rejects.toMatchObject({ code: 'DECISION_CHANGED' });
  });
  it('rejects once without modifying existing authority and only recovers the original actor/intent operation', async () => {
    const base = await fixture();
    const reject: MandateDecisionIntent = { ...base.intent, action: 'REJECT', reason: 'Acceptance evidence must be clarified.' };
    const result = await decideMandateProposal({ ...base.context, stepUp: null }, base.proposal, base.decision, reject);
    expect(result.authorityChange).toBeNull();
    expect(result.decision).toMatchObject({ state: 'REJECTED', version: 2, authorization: null, reason: reject.reason });
    await expect(decideMandateProposal(base.context, base.proposal, result.decision, base.intent)).rejects.toMatchObject({ code: 'DECISION_TERMINAL' });
    expect(await recoverMandateDecisionOperation(base.proposal, result.decision, reject, approver)).toBe('decision_a');
    await expect(recoverMandateDecisionOperation(base.proposal, result.decision, { ...reject, reason: 'Another reason' }, approver)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(recoverMandateDecisionOperation(base.proposal, result.decision, reject, requester)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(recoverMandateDecisionOperation(base.proposal, result.decision, reject, { ...approver, siteIds: [] })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('never reauthorizes approved, rejected, superseded or expired decision versions, regardless of a new operation id', async () => {
    const base = await fixture();
    const approved = await decideMandateProposal(base.context, base.proposal, base.decision, base.intent);
    await expect(decideMandateProposal({ ...base.context, operationId: 'new_operation' }, base.proposal, approved.decision, base.intent)).rejects.toMatchObject({ code: 'DECISION_TERMINAL' });
    expect(await recoverMandateDecisionOperation(base.proposal, approved.decision, base.intent, approver)).toBe('decision_a');
    const expired = await expireMandateProposal(base.proposal, base.decision, { now: base.proposal.expiresAt, operationId: 'expire_a' });
    await expect(decideMandateProposal(base.context, base.proposal, expired, base.intent)).rejects.toMatchObject({ code: 'DECISION_TERMINAL' });
    const revision = await createMandateProposal({ ...base.current, actor: requester, previousProposal: base.proposal, previousDecision: base.decision, operationId: 'revise_a' },
      { ...base.command, expectedProposalVersion: 1, previousProposal: mandateReference(base.proposal) });
    await expect(decideMandateProposal(base.context, base.proposal, revision.supersededDecision!, base.intent)).rejects.toMatchObject({ code: 'DECISION_TERMINAL' });
    await expect(decideMandateProposal(base.context, revision.proposal, revision.decision, base.intent)).rejects.toMatchObject({ code: 'DECISION_CHANGED' });
  });
  it('authorizes a revised proposal as the first accepted version without using an unapproved proposal as its predecessor', async () => {
    const base = await fixture();
    const revision = await createMandateProposal({ ...base.current, actor: requester, previousProposal: base.proposal, previousDecision: base.decision, operationId: 'revise_a' },
      { ...base.command, expectedProposalVersion: 1, previousProposal: mandateReference(base.proposal) });
    const intent = { ...base.intent, proposal: mandateReference(revision.proposal) };
    await expect(decideMandateProposal(base.context, revision.proposal, revision.decision, intent)).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
    const stepUp = { ...base.stepUp, intentHash: await mandateIntentHash(intent) };
    const accepted = await decideMandateProposal({ ...base.context, stepUp }, revision.proposal, revision.decision, intent);
    expect(revision.proposal.version).toBe(2);
    expect(accepted.authorityChange!.acceptedVersion).toMatchObject({ version: 1, mandateEpoch: 1, previousVersionHash: null });
    expect(accepted.decision.proposal.version).toBe(2);
    expect(revision.supersededDecision!.state).toBe('SUPERSEDED');
  });
  it('invalidates competing initial proposals after the winning accepted head and preserves the accepted predecessor on revisions', async () => {
    const base = await acceptedFixture();
    const competing = await createMandateProposal({ ...base.current, actor: requester, previousProposal: null, previousDecision: null, operationId: 'other_propose' },
      { ...base.command, proposalId: 'competing_a' });
    const competingIntent = { ...base.intent, proposal: mandateReference(competing.proposal) };
    await expect(decideMandateProposal(base.control, competing.proposal, competing.decision, competingIntent)).rejects.toMatchObject({ code: 'AUTHORITY_CHANGED' });
    const nextCommand = { ...base.command, proposalId: 'proposal_b', previousAcceptedVersion: await mandateVersionReference(base.control.acceptedVersion), expectedHead: await mandateHeadReference(base.control.head) };
    const proposed = await createMandateProposal({ ...base.control, actor: requester, previousProposal: null, previousDecision: null, operationId: 'next_propose' }, nextCommand);
    const nextIntent = { ...base.intent, proposal: mandateReference(proposed.proposal), expectedHead: nextCommand.expectedHead };
    const nextProof = { ...base.stepUp, intentHash: await mandateIntentHash(nextIntent) };
    const accepted = await decideMandateProposal({ ...base.control, stepUp: nextProof }, proposed.proposal, proposed.decision, nextIntent);
    expect(accepted.authorityChange!.acceptedVersion).toMatchObject({ version: 2, mandateEpoch: 2, previousVersionHash: nextCommand.previousAcceptedVersion.hash });
    const pause = await changeMandateAuthority(base.control, base.controlIntent);
    await expect(decideMandateProposal({ ...base.control, head: pause.head, stepUp: nextProof }, proposed.proposal, proposed.decision, nextIntent)).rejects.toMatchObject({ code: 'AUTHORITY_CHANGED' });
  });
  it('returns role-scoped eligibility and complete independent read fields without claiming that eligibility is MFA', async () => {
    const base = await fixture();
    const eligible = await mandateDecisionEligibility(base.proposal, base.decision, base.context);
    expect(eligible).toContainEqual({ action: 'AUTHORIZE', eligible: true, requiresStepUp: true, blockers: [] });
    expect(await mandateDecisionEligibility(base.proposal, base.decision, { ...base.context, actor: { ...requester, roles: ['owner'] } }))
      .toContainEqual({ action: 'AUTHORIZE', eligible: false, requiresStepUp: true, blockers: ['INDEPENDENT_APPROVER_REQUIRED'] });
    const envelope = MandateReadEnvelopeSchema.parse({ schemaVersion: 1, observedAt: now, organizationEpoch: 2,
      responsibility, responsibilityReference: await mandateResponsibilityReference(responsibility), site: { id: 'site_a', name: 'Main venue', timeZone: 'America/Chicago' },
      proposal: base.proposal, decision: base.decision, acceptedVersion: null, head: null, acceptedProposal: null, acceptedDecision: null,
      financialState: null, policyDocuments: base.current.documents,
      eligibility: eligible, supportedPolicy: { mode: 'ADVISE', financialActions: [], monetaryBudgets: false, supplierReferences: false, outboundCommunication: false }, operation: null });
    expect(envelope.policyDocuments.map(document => document.text)).toEqual([responsibility.acceptancePolicy, 'Advise only; no money or outbound messages.']);
    expect(envelope.financialState).toBeNull();
    expect(envelope.responsibility.coverageState).toBe('UNKNOWN');
    expect(MandateReadEnvelopeSchema.safeParse({ ...envelope, policyDocuments: [] }).success).toBe(false);
    expect(MandateReadEnvelopeSchema.safeParse({ ...envelope, decision: null }).success).toBe(false);
  });
});

describe('immediate stop and independently qualified resume', () => {
  it.each(['PAUSE', 'REVOKE'] as const)('permits %s at an inactive site only with current explicit stop authority', async action => {
    const base = await acceptedFixture();
    const context = { ...base.control, site: { ...base.control.site, active: false }, requester: null, stepUp: null };
    for (const role of ['owner', 'finance'] as const) {
      const result = await changeMandateAuthority({ ...context, actor: { ...context.actor, roles: [role] } }, { ...base.controlIntent, action });
      expect(result.head).toMatchObject({ state: action === 'PAUSE' ? 'PAUSED' : 'REVOKED', mandateEpoch: 2, mandateVersion: 1 });
      expect(result.stepUp).toBeNull();
    }
    for (const actor of [
      { ...context.actor, roles: ['operations'] as const },
      { ...context.actor, siteIds: [] }, { ...context.actor, actionSiteIds: [] },
      { ...context.actor, organizationId: 'other_org' }, { ...context.actor, principalKind: 'service' as const },
    ]) await expect(changeMandateAuthority({ ...context, actor: { ...actor, roles: [...actor.roles] } }, { ...base.controlIntent, action })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    for (const site of [
      { ...context.site, id: 'other_site' }, { ...context.site, organizationId: 'other_org' },
      { ...context.site, environment: 'production' as const }, { ...context.site, active: null as unknown as boolean },
    ]) await expect(changeMandateAuthority({ ...context, site }, { ...base.controlIntent, action })).rejects.toMatchObject({ code: 'SITE_UNAVAILABLE' });
    await expect(changeMandateAuthority(context, { ...base.controlIntent, action, expectedOrganizationEpoch: 3 })).rejects.toMatchObject({ code: 'AUTHORITY_CHANGED' });
    await expect(changeMandateAuthority(context, { ...base.controlIntent, action, head: { ...base.controlIntent.head, hash: 'f'.repeat(64) } })).rejects.toMatchObject({ code: 'AUTHORITY_CHANGED' });
  });
  it('still rejects resume at an inactive site despite otherwise valid independent verification', async () => {
    const base = await pausedFixture();
    await expect(changeMandateAuthority({ ...base.pausedContext, site: { ...base.pausedContext.site, active: false } }, base.resume))
      .rejects.toMatchObject({ code: 'SITE_UNAVAILABLE' });
  });
  it('pauses and revokes without an MFA delay, advances only the head epoch, and preserves the immutable accepted policy', async () => {
    const base = await acceptedFixture();
    const paused = await changeMandateAuthority({ ...base.control, stepUp: null }, base.controlIntent);
    expect(paused.head).toMatchObject({ state: 'PAUSED', mandateVersion: 1, mandateEpoch: 2 });
    expect(paused.stepUp).toBeNull();
    const revoked = await changeMandateAuthority({ ...base.control, head: paused.head, stepUp: null },
      { ...base.controlIntent, action: 'REVOKE', head: await mandateHeadReference(paused.head), reason: 'Withdraw future authority' });
    expect(revoked.head).toMatchObject({ state: 'REVOKED', mandateVersion: 1, mandateEpoch: 3 });
    expect(base.control.acceptedVersion.mandateEpoch).toBe(1);
    expect(base.control.head.state).toBe('ACTIVE');
    expect(base.control.responsibility.coverageState).toBe('UNKNOWN');
    await expect(changeMandateAuthority({ ...base.control, head: paused.head }, base.controlIntent)).rejects.toMatchObject({ code: 'AUTHORITY_CHANGED' });
    const envelope = MandateReadEnvelopeSchema.parse({ schemaVersion: 1, observedAt: now, organizationEpoch: 2,
      responsibility, responsibilityReference: await mandateResponsibilityReference(responsibility), site: { id: 'site_a', name: 'Main venue', timeZone: 'America/Chicago' },
      proposal: null, decision: null, acceptedVersion: base.control.acceptedVersion, head: paused.head, acceptedProposal: base.proposal,
      acceptedDecision: base.accepted.decision, financialState: null, policyDocuments: base.current.documents, eligibility: [],
      supportedPolicy: { mode: 'ADVISE', financialActions: [], monetaryBudgets: false, supplierReferences: false, outboundCommunication: false }, operation: null });
    expect(envelope.acceptedVersion!.mandateEpoch).toBe(1);
    expect(envelope.head!.mandateEpoch).toBe(2);
    expect(MandateReadEnvelopeSchema.safeParse({ ...envelope, acceptedProposal: null }).success).toBe(false);
    expect(MandateReadEnvelopeSchema.safeParse({ ...envelope, policyDocuments: [] }).success).toBe(false);
  });
  it('requires fresh independent purpose/intent MFA to resume without changing immutable mandate version identity', async () => {
    const base = await pausedFixture();
    const result = await changeMandateAuthority(base.pausedContext, base.resume);
    expect(result.head).toMatchObject({ state: 'ACTIVE', mandateVersion: 1, mandateEpoch: 3 });
    expect(base.control.acceptedVersion.mandateEpoch).toBe(1);
    expect(result.stepUp!.purpose).toBe('mandate_control');
    for (const proof of [null, base.stepUp, { ...base.resumeProof, intentHash: 'f'.repeat(64) }, { ...base.resumeProof, expiresAt: now }]) {
      await expect(changeMandateAuthority({ ...base.pausedContext, stepUp: proof }, base.resume)).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
    }
    await expect(changeMandateAuthority({ ...base.pausedContext, actor: { ...requester, roles: ['owner'] } }, base.resume))
      .rejects.toMatchObject({ code: 'INDEPENDENT_APPROVER_REQUIRED' });
    await expect(changeMandateAuthority({ ...base.pausedContext, requester: { ...requester, actionSiteIds: [] } }, base.resume)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('allows resume after the proposal decision window closes while the accepted policy remains live and evidence is newly verified', async () => {
    const base = await pausedFixture();
    const later = '2026-11-14T12:40:00.000Z';
    const proof = { ...base.resumeProof, verifiedAt: later, expiresAt: '2026-11-14T12:45:00.000Z' };
    const result = await changeMandateAuthority({ ...base.pausedContext, now: later, stepUp: proof }, base.resume);
    expect(result.head.state).toBe('ACTIVE');
    expect(result.head.expiresAt).toBe(expiry);
  });
  it('requires a new accepted version after organization or responsibility changes and rejects altered acceptance history', async () => {
    const base = await pausedFixture();
    await expect(changeMandateAuthority({ ...base.pausedContext, organizationEpoch: 3 }, { ...base.resume, expectedOrganizationEpoch: 3 })).rejects.toMatchObject({ code: 'AUTHORITY_CHANGED' });
    const changedResponsibility = { ...responsibility, version: 2 };
    await expect(changeMandateAuthority({ ...base.pausedContext, responsibility: changedResponsibility },
      { ...base.resume, responsibility: await mandateResponsibilityReference(changedResponsibility) })).rejects.toMatchObject({ code: 'AUTHORITY_CHANGED' });
    const altered = { ...base.accepted.decision, authorization: { ...base.accepted.decision.authorization!, acceptedVersion: { ...base.accepted.decision.authorization!.acceptedVersion, hash: 'f'.repeat(64) } } };
    await expect(changeMandateAuthority({ ...base.pausedContext, acceptedDecision: altered }, base.resume)).rejects.toMatchObject({ code: 'APPROVAL_INVALID' });
    await expect(changeMandateAuthority({ ...base.pausedContext, documents: [] }, base.resume)).rejects.toMatchObject({ code: 'POLICY_DOCUMENT_UNAVAILABLE' });
    // Current qualified stop remains possible even after organization authority has advanced.
    const revoked = await changeMandateAuthority({ ...base.pausedContext, organizationEpoch: 3, stepUp: null }, { ...base.resume, action: 'REVOKE', expectedOrganizationEpoch: 3 });
    expect(revoked.head.state).toBe('REVOKED');
  });
  it('never resumes or otherwise reuses revoked or expired authority; expiry itself advances the head once', async () => {
    const base = await pausedFixture();
    const revoked = await changeMandateAuthority({ ...base.pausedContext, stepUp: null }, { ...base.resume, action: 'REVOKE' });
    for (const head of [revoked.head, expireMandateAuthority(base.paused.head, base.paused.head.mandateEpoch, expiry)]) {
      for (const action of ['PAUSE', 'REVOKE', 'RESUME'] as const) {
        await expect(changeMandateAuthority({ ...base.pausedContext, head }, { ...base.resume, action, head: await mandateHeadReference(head) }))
          .rejects.toMatchObject({ code: 'AUTHORITY_CHANGED' });
      }
    }
    await expect(changeMandateAuthority({ ...base.pausedContext, now: expiry }, base.resume)).rejects.toMatchObject({ code: 'AUTHORITY_CHANGED' });
    expect(() => expireMandateAuthority(base.paused.head, base.paused.head.mandateEpoch, now)).toThrowError(expect.objectContaining({ code: 'AUTHORITY_CHANGED' }));
    const expired = expireMandateAuthority(base.paused.head, base.paused.head.mandateEpoch, expiry);
    expect(expired).toMatchObject({ state: 'EXPIRED', mandateEpoch: 3, mandateVersion: 1 });
    expect(() => expireMandateAuthority(expired, 3, expiry)).toThrowError(expect.objectContaining({ code: 'AUTHORITY_CHANGED' }));
    expect(() => expireMandateAuthority(base.paused.head, 1, expiry)).toThrowError(expect.objectContaining({ code: 'AUTHORITY_CHANGED' }));
  });
  it('permits a fresh independently accepted version after revocation while retaining the old accepted predecessor', async () => {
    const base = await pausedFixture();
    const revoked = await changeMandateAuthority({ ...base.pausedContext, stepUp: null }, { ...base.resume, action: 'REVOKE' });
    const context = { ...base.control, organizationEpoch: 3, head: revoked.head };
    const command = { ...base.command, proposalId: 'fresh_proposal', expectedOrganizationEpoch: 3,
      previousAcceptedVersion: await mandateVersionReference(context.acceptedVersion), expectedHead: await mandateHeadReference(revoked.head) };
    const proposed = await createMandateProposal({ ...context, actor: requester, previousProposal: null, previousDecision: null, operationId: 'fresh_propose' }, command);
    const intent = { ...base.intent, proposal: mandateReference(proposed.proposal), expectedOrganizationEpoch: 3, expectedHead: command.expectedHead };
    const proof = { ...base.stepUp, intentHash: await mandateIntentHash(intent) };
    const result = await decideMandateProposal({ ...context, stepUp: proof }, proposed.proposal, proposed.decision, intent);
    expect(result.authorityChange!.acceptedVersion).toMatchObject({ version: 2, mandateEpoch: 4, organizationEpoch: 3, previousVersionHash: command.previousAcceptedVersion.hash });
    expect(result.authorityChange!.head).toMatchObject({ state: 'ACTIVE', mandateEpoch: 4, mandateVersion: 2, organizationEpoch: 3 });
    expect(revoked.head.state).toBe('REVOKED');
  });
});
