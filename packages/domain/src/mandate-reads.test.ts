import { describe, expect, it } from 'vitest';
import { type ActorContext, type MandateAuthorityIntent, type MandateDecisionIntent, type MandatePolicy, type Responsibility } from '@pactwoven/contracts';
import { changeMandateAuthority, decideMandateProposal, mandateIntentHash, type VerifiedMandateEvidence } from './mandate-authorization.js';
import { createMandateProposal, createPolicyDocumentVersion, mandateHeadReference, mandateReference, mandateResponsibilityReference, mandateVersionReference } from './mandate-proposals.js';
import { projectMandatePage, projectMandateRead, type MandateHeadHistory, type MandateReadSource } from './mandate-reads.js';
import { commandDigest } from './canonical.js';

const createdAt = '2026-11-14T12:00:00.000Z', now = '2026-11-14T12:01:00.000Z', expiry = '2026-11-14T14:00:00.000Z';
const requester: ActorContext = { actorId: 'operations_a', principalKind: 'human', organizationId: 'org_a', environment: 'development', roles: ['operations'],
  siteIds: ['site_a'], actionSiteIds: ['site_a'], sessionId: 'requester_session', authenticatedAt: createdAt, correlationId: 'trace_a' };
const approver: ActorContext = { ...requester, actorId: 'finance_a', roles: ['finance'], sessionId: 'finance_session' };
const responsibility: Responsibility = { id: 'responsibility_a', organizationId: 'org_a', environment: 'development', ownerId: requester.actorId, siteId: 'site_a',
  title: 'Event setup', description: '', version: 1, window: { startsAt: createdAt, endsAt: expiry, timeZone: 'America/Chicago' }, requirements: [],
  acceptancePolicy: 'Signed delivery evidence.', executionState: 'DRAFT', authorityState: null, coverageState: 'UNKNOWN', createdAt, updatedAt: createdAt };
const membership = (actor: ActorContext) => ({ actor, status: 'active' as const, expiresAt: null, assignedResponsibilityIds: [] });
async function fixture(approve = false) {
  const acceptance = await createPolicyDocumentVersion({ actor: requester, now: createdAt }, { documentId: 'acceptance_a', expectedVersion: 0, previousVersion: null,
    purpose: 'ACCEPTANCE_POLICY', text: responsibility.acceptancePolicy }, null);
  const document = await createPolicyDocumentVersion({ actor: requester, now: createdAt }, { documentId: 'policy_a', expectedVersion: 0, previousVersion: null,
    purpose: 'MANDATE_POLICY', text: 'Advice only. No money or outbound messages.' }, null);
  const policy: MandatePolicy = { mode: 'ADVISE', siteIds: ['site_a'], supplierRelationshipIds: [], actions: [], budgets: [], acceptancePolicy: mandateReference(acceptance),
    communication: { recipientIds: [], purposes: [], messageKinds: [], maximumMessages: 0, expiresAt: expiry }, expiresAt: expiry };
  const context = { organizationId: 'org_a', environment: 'development' as const, organizationEpoch: 2, now: createdAt, responsibility,
    site: { id: 'site_a', organizationId: 'org_a', environment: 'development' as const, active: true }, acceptedVersion: null, head: null, documents: [acceptance, document] };
  const command = { proposalId: 'proposal_a', expectedProposalVersion: 0, previousProposal: null, mandateId: 'mandate_a',
    responsibility: await mandateResponsibilityReference(responsibility), expectedOrganizationEpoch: 2, previousAcceptedVersion: null, expectedHead: null,
    policy, policyDocument: mandateReference(document), expiresAt: '2026-11-14T13:00:00.000Z' };
  const proposed = await createMandateProposal({ ...context, actor: requester, operationId: 'propose_a', previousProposal: null, previousDecision: null }, command);
  const intent: MandateDecisionIntent = { schemaVersion: 1, action: 'AUTHORIZE', proposal: mandateReference(proposed.proposal), expectedDecisionVersion: 1,
    expectedOrganizationEpoch: 2, expectedHead: null, reason: null };
  const proof: VerifiedMandateEvidence = { id: 'proof_a', purpose: 'mandate_authorization', intentHash: await mandateIntentHash(intent), actorId: approver.actorId,
    sessionId: approver.sessionId, verifiedAt: now, expiresAt: '2026-11-14T12:05:00.000Z' };
  const approved = approve ? await decideMandateProposal({ ...context, now, actor: approver, requester, stepUp: proof, receiptId: 'receipt_a', operationId: 'authorize_a' },
    proposed.proposal, proposed.decision, intent) : null;
  const source: MandateReadSource = { organizationId: 'org_a', environment: 'development', organizationEpoch: 2, organizationStatus: 'active', now,
    reader: membership(approver), requesters: [membership(requester)], currentResponsibility: responsibility, responsibilityVersions: [responsibility],
    sites: [{ ...context.site, name: 'Main venue', timeZone: 'America/Chicago' }],
    documents: [acceptance, document].map(document => ({ organizationId: 'org_a', environment: 'development', responsibilityId: responsibility.id, siteId: 'site_a', document })),
    proposals: [proposed.proposal], decisions: approved ? [proposed.decision, approved.decision] : [proposed.decision],
    acceptedVersions: approved ? [approved.authorityChange!.acceptedVersion] : [], head: approved?.authorityChange?.head ?? null,
    headHistory: approved ? [{ head: approved.authorityChange!.head, previousHead: null, action: 'AUTHORIZE', actorId: approver.actorId,
      occurredAt: now, operationId: 'authorize_a', intent: null, evidence: proof }] : [], selectedProposal: mandateReference(proposed.proposal) };
  return { source, context, command, proposed, approved, proof, intent, acceptance, document };
}
async function pausedFixture() {
  const base = await fixture(true);
  const changedAt = '2026-11-14T12:02:00.000Z';
  const context = { ...base.context, ...base.approved!.authorityChange!, now: changedAt, actor: approver, requester, stepUp: null,
    acceptedProposal: base.proposed.proposal, acceptedDecision: base.approved!.decision, operationId: 'pause_a' };
  const intent: MandateAuthorityIntent = { schemaVersion: 1, action: 'PAUSE', mandate: await mandateVersionReference(context.acceptedVersion),
    head: await mandateHeadReference(context.head), responsibility: await mandateResponsibilityReference(responsibility), expectedOrganizationEpoch: 2, reason: 'Review authority' };
  const paused = await changeMandateAuthority(context, intent);
  const event: MandateHeadHistory = { head: paused.head, previousHead: intent.head, action: 'PAUSE', actorId: approver.actorId,
    occurredAt: changedAt, operationId: 'pause_a', intent, evidence: null };
  return { ...base, context, intent, paused, source: { ...base.source, now: changedAt, head: paused.head, headHistory: [...base.source.headHistory, event] } };
}

describe('authoritative mandate read projection', () => {
  it('returns exact full policy text and current state while initial authority remains absent', async () => {
    const { source } = await fixture();
    const view = await projectMandateRead(source);
    expect(view.effectiveAuthority).toEqual({ state: 'NONE', blockers: ['NO_AUTHORITY'] });
    expect(view.effectiveDecisionState).toBe('OPEN');
    expect(view.envelope.policyDocuments.map(record => record.text)).toEqual(['Signed delivery evidence.', 'Advice only. No money or outbound messages.']);
    expect(view.envelope).toMatchObject({ financialState: null, operation: null, responsibility: { executionState: 'DRAFT', coverageState: 'UNKNOWN' } });
    expect(view.envelope.eligibility).toContainEqual({ action: 'AUTHORIZE', eligible: true, requiresStepUp: true, blockers: [] });
    expect(() => { view.responsibilityVersions[0]!.acceptancePolicy = 'Changed'; }).toThrow();
  });
  it('validates the full accepted receipt and initial head chain without confusing operation truth and money', async () => {
    const { source } = await fixture(true);
    const view = await projectMandateRead(source);
    expect(view.effectiveAuthority).toEqual({ state: 'ACTIVE', blockers: [] });
    expect(view.effectiveDecisionState).toBe('APPROVED');
    expect(view.envelope.acceptedDecision!.authorization!.acceptedVersion).toEqual(await mandateVersionReference(source.acceptedVersions[0]!));
    expect(view.envelope.financialState).toBeNull();
    expect(view.envelope.policyDocuments).toHaveLength(2);
    expect(JSON.stringify(view)).not.toContain('finance_session');
    expect(JSON.stringify(view)).not.toContain('tokenHash');
  });
  it('preserves historical acceptance text and snapshots after current responsibility changes', async () => {
    const { source } = await fixture(true);
    const next = { ...responsibility, version: 2, title: 'Revised event', acceptancePolicy: 'Different evidence required.', updatedAt: '2026-11-14T12:10:00.000Z' };
    const view = await projectMandateRead({ ...source, now: next.updatedAt, currentResponsibility: next, responsibilityVersions: [responsibility, next] });
    expect(view.envelope.responsibility.acceptancePolicy).toBe('Different evidence required.');
    expect(view.responsibilityVersions.find(record => record.version === 1)!.acceptancePolicy).toBe('Signed delivery evidence.');
    expect(view.envelope.policyDocuments[0]!.text).toBe('Signed delivery evidence.');
    expect(view.effectiveAuthority).toEqual({ state: 'STALE', blockers: ['RESPONSIBILITY_CHANGED'] });
    expect(view.envelope.head!.state).toBe('ACTIVE');
    expect(view.effectiveDecisionState).toBe('APPROVED');
  });
  it('rejects a stale current responsibility pointer when a newer known snapshot already exists', async () => {
    const { source } = await fixture(true);
    const newer = { ...responsibility, version: 2, updatedAt: '2026-11-14T12:10:00.000Z' };
    await expect(projectMandateRead({ ...source, now: newer.updatedAt, responsibilityVersions: [responsibility, newer] }))
      .rejects.toMatchObject({ code: 'MANDATE_READ_INVALID' });
    const corrected = await projectMandateRead({ ...source, now: newer.updatedAt, currentResponsibility: newer, responsibilityVersions: [responsibility, newer] });
    expect(corrected.effectiveAuthority.state).toBe('STALE');
  });
  it('computes expiry and organization staleness independently of stored head and proposal state', async () => {
    const base = await fixture(true);
    const stale = await projectMandateRead({ ...base.source, organizationEpoch: 3 });
    expect(stale.effectiveAuthority).toEqual({ state: 'STALE', blockers: ['ORGANIZATION_CHANGED'] });
    expect(stale.envelope.head!.state).toBe('ACTIVE');
    const expired = await projectMandateRead({ ...base.source, now: expiry });
    expect(expired.effectiveAuthority.state).toBe('EXPIRED');
    expect(expired.envelope.head!.state).toBe('ACTIVE');
    expect(expired.envelope.eligibility.find(item => item.action === 'PAUSE')!.eligible).toBe(false);
    const initial = await fixture();
    expect((await projectMandateRead({ ...initial.source, now: initial.proposed.proposal.expiresAt })).effectiveDecisionState).toBe('EXPIRED');
    expect((await projectMandateRead({ ...initial.source, organizationEpoch: 3 })).effectiveDecisionState).toBe('STALE');
  });
  it('does not require old authorization evidence to stay fresh after a durable acceptance', async () => {
    const { source } = await fixture(true);
    const result = await projectMandateRead({ ...source, now: '2026-11-14T12:45:00.000Z' });
    expect(result.effectiveAuthority.state).toBe('ACTIVE');
    expect(result.envelope.acceptedDecision!.authorization!.stepUpExpiresAt).toBe('2026-11-14T12:05:00.000Z');
  });
  it('enforces current reader membership, tenant, role, site and receiver assignment', async () => {
    const { source } = await fixture();
    for (const reader of [
      { ...source.reader, status: 'revoked' as const }, { ...source.reader, expiresAt: now },
      membership({ ...approver, siteIds: [] }), membership({ ...approver, roles: ['supplier_admin'] }),
      membership({ ...approver, principalKind: 'service' }), membership({ ...approver, roles: ['receiver'] }),
    ]) await expect(projectMandateRead({ ...source, reader })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const assigned = { ...membership({ ...approver, roles: ['receiver'] }), assignedResponsibilityIds: [responsibility.id] };
    const view = await projectMandateRead({ ...source, reader: assigned });
    expect(view.envelope.eligibility.find(item => item.action === 'AUTHORIZE')!.eligible).toBe(false);
    await expect(projectMandateRead({ ...source, organizationStatus: 'suspended' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(projectMandateRead({ ...source, reader: membership({ ...approver, organizationId: 'other_org' }) })).rejects.toMatchObject({ code: 'MANDATE_READ_INVALID' });
  });
  it('rechecks independent reviewer, explicit action sites and original requester current access', async () => {
    const { source } = await fixture();
    const self = await projectMandateRead({ ...source, reader: membership({ ...requester, roles: ['owner'] }) });
    expect(self.envelope.eligibility.find(item => item.action === 'AUTHORIZE')!.blockers).toEqual(['INDEPENDENT_APPROVER_REQUIRED']);
    for (const actor of [{ ...approver, roles: ['operations'] as ActorContext['roles'] }, { ...approver, actionSiteIds: [] }]) {
      expect((await projectMandateRead({ ...source, reader: membership(actor) })).envelope.eligibility.find(item => item.action === 'AUTHORIZE')!.eligible).toBe(false);
    }
    for (const requesters of [[], [{ ...membership(requester), status: 'revoked' as const }], [membership({ ...requester, actionSiteIds: [] })]]) {
      expect((await projectMandateRead({ ...source, requesters })).envelope.eligibility.find(item => item.action === 'AUTHORIZE')!.eligible).toBe(false);
    }
  });
  it('requires historical site read access as well as current responsibility access', async () => {
    const { source } = await fixture(true);
    const next = { ...responsibility, version: 2, siteId: 'site_b', updatedAt: '2026-11-14T12:10:00.000Z' };
    const moved = { ...source, now: next.updatedAt, currentResponsibility: next, responsibilityVersions: [responsibility, next],
      sites: [...source.sites, { ...source.sites[0]!, id: 'site_b' }], reader: membership({ ...approver, siteIds: ['site_b'], actionSiteIds: ['site_b'] }) };
    await expect(projectMandateRead(moved)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await projectMandateRead({ ...moved, reader: membership({ ...approver, siteIds: ['site_a', 'site_b'] }) })).effectiveAuthority.state).toBe('STALE');
  });
  it('rejects schema-shaped but false document content, tenant, attachment, purpose and extra/missing records', async () => {
    const { source } = await fixture();
    const first = source.documents[0]!;
    for (const documents of [
      [], [first], [...source.documents, first],
      [{ ...first, responsibilityId: 'other_responsibility' }, source.documents[1]!],
      [{ ...first, siteId: 'other_site' }, source.documents[1]!],
      [{ ...first, organizationId: 'other_org' }, source.documents[1]!],
      [{ ...first, document: { ...first.document, text: 'Forged signed policy' } }, source.documents[1]!],
      [{ ...first, document: { ...first.document, purpose: 'MANDATE_POLICY' as const } }, source.documents[1]!],
    ]) await expect(projectMandateRead({ ...source, documents })).rejects.toMatchObject({ code: 'MANDATE_READ_INVALID' });
    const extra = await createPolicyDocumentVersion({ actor: requester, now: createdAt }, { documentId: 'unrelated_document', expectedVersion: 0, previousVersion: null,
      purpose: 'MANDATE_POLICY', text: 'Unreferenced document' }, null);
    await expect(projectMandateRead({ ...source, documents: [...source.documents, { ...source.documents[1]!, document: extra }] })).rejects.toMatchObject({ code: 'MANDATE_READ_INVALID' });
  });
  it('validates document predecessor hashes without exposing predecessor-only full text', async () => {
    const base = await fixture();
    const next = await createPolicyDocumentVersion({ actor: requester, now: createdAt }, { documentId: base.document.id, expectedVersion: 1,
      previousVersion: mandateReference(base.document), purpose: 'MANDATE_POLICY', text: 'Revised advice text.' }, base.document);
    const proposed = await createMandateProposal({ ...base.context, actor: requester, operationId: 'propose_b', previousProposal: null, previousDecision: null,
      documents: [base.acceptance, base.document, next] }, { ...base.command, policyDocument: mandateReference(next) });
    const source = { ...base.source, documents: [...base.source.documents, { ...base.source.documents[1]!, document: next }], proposals: [proposed.proposal],
      decisions: [proposed.decision], selectedProposal: mandateReference(proposed.proposal) };
    const view = await projectMandateRead(source);
    expect(view.envelope.policyDocuments.map(record => record.text)).toEqual([responsibility.acceptancePolicy, 'Revised advice text.']);
    await expect(projectMandateRead({ ...source, documents: source.documents.filter(row => row.document !== base.document) })).rejects.toMatchObject({ code: 'MANDATE_READ_INVALID' });
  });
  it('rejects altered responsibility hashes, duplicate snapshots, unbound proposals and missing decision history', async () => {
    const { source } = await fixture();
    for (const altered of [
      { ...source, currentResponsibility: { ...responsibility, title: 'Tampered' } },
      { ...source, responsibilityVersions: [{ ...responsibility, acceptancePolicy: 'Tampered' }] },
      { ...source, responsibilityVersions: [responsibility, responsibility] },
      { ...source, proposals: [{ ...source.proposals[0]!, requesterId: 'attacker' }] },
      { ...source, selectedProposal: { ...source.selectedProposal!, hash: 'f'.repeat(64) } },
      { ...source, decisions: [] }, { ...source, decisions: [source.decisions[0]!, source.decisions[0]!] },
    ]) await expect(projectMandateRead(altered)).rejects.toMatchObject({ code: 'MANDATE_READ_INVALID' });
  });
  it('validates revised proposal predecessor and supersession chains and returns exact requested historical versions', async () => {
    const base = await fixture();
    const revised = await createMandateProposal({ ...base.context, now, actor: requester, operationId: 'revise_a', previousProposal: base.proposed.proposal, previousDecision: base.proposed.decision },
      { ...base.command, expectedProposalVersion: 1, previousProposal: mandateReference(base.proposed.proposal) });
    const source = { ...base.source, proposals: [...base.source.proposals, revised.proposal], decisions: [...base.source.decisions, revised.supersededDecision!, revised.decision] };
    const historical = await projectMandateRead(source);
    expect(historical.envelope.proposal!.version).toBe(1);
    expect(historical.effectiveDecisionState).toBe('SUPERSEDED');
    expect((await projectMandateRead({ ...source, selectedProposal: mandateReference(revised.proposal) })).effectiveDecisionState).toBe('OPEN');
    await expect(projectMandateRead({ ...source, decisions: [...base.source.decisions, revised.decision] })).rejects.toMatchObject({ code: 'MANDATE_READ_INVALID' });
    await expect(projectMandatePage(source, { proposals: [mandateReference(base.proposed.proposal)], nextCursor: null })).rejects.toMatchObject({ code: 'MANDATE_READ_INVALID' });
    const page = await projectMandatePage(source, { proposals: [mandateReference(revised.proposal)], nextCursor: null });
    expect(page.items[0]!.proposal.version).toBe(2);
    expect(JSON.stringify(page)).not.toContain('Advice only. No money');
  });
  it('rejects forged accepted predecessor, receipt, intent and initial head evidence', async () => {
    const { source } = await fixture(true);
    for (const altered of [
      { ...source, acceptedVersions: [{ ...source.acceptedVersions[0]!, previousVersionHash: 'f'.repeat(64) }] },
      { ...source, decisions: [source.decisions[0]!, { ...source.decisions[1]!, authorization: { ...source.decisions[1]!.authorization!, intentHash: 'f'.repeat(64) } }] },
      { ...source, headHistory: [{ ...source.headHistory[0]!, actorId: requester.actorId }] },
      { ...source, headHistory: [{ ...source.headHistory[0]!, operationId: 'unrelated_operation' }] },
      { ...source, headHistory: [{ ...source.headHistory[0]!, evidence: { ...source.headHistory[0]!.evidence!, purpose: 'mandate_control' as const } }] },
      { ...source, headHistory: [{ ...source.headHistory[0]!, evidence: { ...source.headHistory[0]!.evidence!, expiresAt: now } }] },
      { ...source, headHistory: [] }, { ...source, head: null },
    ]) await expect(projectMandateRead(altered)).rejects.toMatchObject({ code: 'MANDATE_READ_INVALID' });
  });
  it('rejects history that used a responsibility or head already superseded before its recorded effect', async () => {
    const base = await fixture(true);
    const revised = { ...responsibility, version: 2, updatedAt: '2026-11-14T12:00:30.000Z' };
    await expect(projectMandateRead({ ...base.source, currentResponsibility: revised, responsibilityVersions: [responsibility, revised] }))
      .rejects.toMatchObject({ code: 'MANDATE_READ_INVALID' });
    // Simulate a forged repository context that falsely claimed there was no accepted head.
    const forged = await createMandateProposal({ ...base.context, now: '2026-11-14T12:01:30.000Z', actor: requester,
      operationId: 'forged_propose', previousProposal: null, previousDecision: null }, { ...base.command, proposalId: 'forged_proposal' });
    await expect(projectMandateRead({ ...base.source, now: '2026-11-14T12:02:00.000Z',
      proposals: [...base.source.proposals, forged.proposal], decisions: [...base.source.decisions, forged.decision] }))
      .rejects.toMatchObject({ code: 'MANDATE_READ_INVALID' });
  });
  it('snapshots repository input before asynchronous hashing so later mutation cannot change the read', async () => {
    const { source } = await fixture();
    const mutable = structuredClone(source);
    const pending = projectMandateRead(mutable);
    mutable.currentResponsibility.title = 'Changed after call';
    mutable.documents[0]!.document.text = 'Changed after call';
    expect((await pending).envelope.responsibility.title).toBe('Event setup');
  });
});

describe('authority history and current eligibility', () => {
  it.each(['', 'invalid/actor', 'x'.repeat(129), undefined])('rejects malformed stop-history actor identity %s', async actorId => {
    const { source } = await pausedFixture();
    const altered = { ...source, headHistory: [source.headHistory[0]!, { ...source.headHistory[1]!, actorId }] };
    await expect(projectMandateRead(altered as MandateReadSource)).rejects.toMatchObject({ code: 'MANDATE_READ_INVALID' });
  });
  it('separates the immutable accepted epoch from a paused current head and allows fresh independent resume eligibility', async () => {
    const { source } = await pausedFixture();
    const view = await projectMandateRead(source);
    expect(view.envelope.acceptedVersion!.mandateEpoch).toBe(1);
    expect(view.envelope.head!.mandateEpoch).toBe(2);
    expect(view.effectiveAuthority).toEqual({ state: 'PAUSED', blockers: ['AUTHORITY_PAUSED'] });
    expect(view.envelope.eligibility).toContainEqual({ action: 'RESUME', eligible: true, requiresStepUp: true, blockers: [] });
    expect(view.envelope.eligibility.find(item => item.action === 'PAUSE')!.eligible).toBe(false);
    const self = await projectMandateRead({ ...source, reader: membership({ ...requester, roles: ['owner'] }) });
    expect(self.envelope.eligibility.find(item => item.action === 'RESUME')!.blockers).toContain('INDEPENDENT_APPROVER_REQUIRED');
  });
  it('requires correct resume intent, fresh-at-effect evidence and the original accepted responsibility', async () => {
    const base = await pausedFixture();
    const resumedAt = '2026-11-14T12:03:00.000Z';
    const intent: MandateAuthorityIntent = { ...base.intent, action: 'RESUME', head: await mandateHeadReference(base.paused.head), reason: 'Resume exact advice' };
    const evidence: VerifiedMandateEvidence = { ...base.proof, id: 'resume_proof', purpose: 'mandate_control', intentHash: await mandateIntentHash(intent), verifiedAt: resumedAt, expiresAt: '2026-11-14T12:08:00.000Z' };
    const result = await changeMandateAuthority({ ...base.context, head: base.paused.head, now: resumedAt, stepUp: evidence, operationId: 'resume_a' }, intent);
    const event: MandateHeadHistory = { head: result.head, previousHead: intent.head, action: 'RESUME', actorId: approver.actorId,
      occurredAt: resumedAt, operationId: 'resume_a', intent, evidence };
    const source = { ...base.source, head: result.head, now: resumedAt, headHistory: [...base.source.headHistory, event] };
    expect((await projectMandateRead(source)).effectiveAuthority.state).toBe('ACTIVE');
    for (const changed of [
      { ...event, evidence: null }, { ...event, evidence: { ...evidence, intentHash: 'f'.repeat(64) } },
      { ...event, evidence: { ...evidence, verifiedAt: '2026-11-14T11:58:00.000Z' } },
      { ...event, intent: { ...intent, expectedOrganizationEpoch: 3 } }, { ...event, actorId: requester.actorId },
      { ...event, previousHead: await mandateHeadReference(base.source.headHistory[0]!.head) },
    ]) await expect(projectMandateRead({ ...source, headHistory: [...base.source.headHistory, changed] })).rejects.toMatchObject({ code: 'MANDATE_READ_INVALID' });
  });
  it('rejects skipped, reordered, duplicate, fabricated or future current-head history', async () => {
    const { source } = await pausedFixture();
    const pause = source.headHistory[1]!;
    for (const changed of [
      { ...source, headHistory: [pause] }, { ...source, headHistory: [...source.headHistory, pause] },
      { ...source, head: source.headHistory[0]!.head },
      { ...source, headHistory: [source.headHistory[0]!, { ...pause, occurredAt: expiry }] },
      { ...source, headHistory: [source.headHistory[0]!, { ...pause, intent: { ...pause.intent!, action: 'RESUME' as const } }] },
      { ...source, head: { ...source.head!, policyHash: await commandDigest({ forged: true }) } },
    ]) await expect(projectMandateRead(changed)).rejects.toMatchObject({ code: 'MANDATE_READ_INVALID' });
  });
  it('marks a stopped or inactive-site head unusable without hiding historical decisions', async () => {
    const base = await pausedFixture();
    const stale = await projectMandateRead({ ...base.source, sites: [{ ...base.source.sites[0]!, active: false }] });
    expect(stale.effectiveAuthority).toEqual({ state: 'STALE', blockers: ['SITE_UNAVAILABLE'] });
    expect(stale.envelope.eligibility.find(item => item.action === 'RESUME')!.eligible).toBe(false);
    const expired = await projectMandateRead({ ...base.source, now: expiry });
    expect(expired.effectiveAuthority.state).toBe('EXPIRED');
    expect(expired.envelope.acceptedDecision!.state).toBe('APPROVED');
  });
});
