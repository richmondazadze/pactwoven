import { describe, expect, it } from 'vitest';
import { type ActorContext, type MandatePolicy, type ProposeMandateCommand, type Responsibility } from '@pactwoven/contracts';
import { commandDigest } from './canonical.js';
import { createMandateVersion } from './authority.js';
import { assertMandateProposalCurrent, createMandateProposal, createPolicyDocumentVersion, expireMandateProposal,
  mandateHeadReference, mandateReference, mandateResponsibilityReference, mandateVersionReference, normalizePolicyText,
  resolveMandatePolicyDocuments, validateMandateProposalVersion, validatePolicyDocumentVersion, type MandateCurrentContext } from './mandate-proposals.js';

const now = '2026-11-14T12:00:00.000Z';
const expiry = '2026-11-14T13:00:00.000Z';
const actor: ActorContext = { actorId: 'requester_a', principalKind: 'human', organizationId: 'org_a', environment: 'development',
  roles: ['operations'], siteIds: ['site_a'], actionSiteIds: ['site_a'], sessionId: 'session_a', authenticatedAt: now, correlationId: 'trace_a' };
const responsibility: Responsibility = { id: 'responsibility_a', organizationId: 'org_a', environment: 'development', ownerId: actor.actorId,
  title: 'Prepare an event', description: '', siteId: 'site_a', version: 1,
  window: { startsAt: now, endsAt: expiry, timeZone: 'America/Chicago' }, requirements: [], acceptancePolicy: 'Require signed delivery evidence.',
  executionState: 'DRAFT', authorityState: null, coverageState: 'UNKNOWN', createdAt: now, updatedAt: now };
async function fixture() {
  const acceptance = await createPolicyDocumentVersion({ actor, now }, { documentId: 'acceptance_a', expectedVersion: 0, previousVersion: null,
    purpose: 'ACCEPTANCE_POLICY', text: responsibility.acceptancePolicy }, null);
  const document = await createPolicyDocumentVersion({ actor, now }, { documentId: 'policy_a', expectedVersion: 0, previousVersion: null,
    purpose: 'MANDATE_POLICY', text: 'Advise only; no money or outbound messages.' }, null);
  const policy: MandatePolicy = { mode: 'ADVISE', siteIds: ['site_a'], actions: [], budgets: [], supplierRelationshipIds: [],
    acceptancePolicy: mandateReference(acceptance), communication: { maximumMessages: 0, recipientIds: [], purposes: [], messageKinds: [], expiresAt: expiry }, expiresAt: expiry };
  const context: MandateCurrentContext & { actor: ActorContext; operationId: string; previousProposal: null; previousDecision: null } = {
    organizationId: 'org_a', environment: 'development', organizationEpoch: 2, now, responsibility,
    site: { id: 'site_a', organizationId: 'org_a', environment: 'development', active: true }, acceptedVersion: null, head: null,
    documents: [acceptance, document], actor, operationId: 'operation_a', previousProposal: null, previousDecision: null };
  const command: ProposeMandateCommand = { proposalId: 'proposal_a', expectedProposalVersion: 0, previousProposal: null, mandateId: 'mandate_a',
    responsibility: await mandateResponsibilityReference(responsibility), expectedOrganizationEpoch: 2, previousAcceptedVersion: null,
    expectedHead: null, policy, policyDocument: mandateReference(document), expiresAt: expiry };
  return { context, command, acceptance, document, policy };
}

describe('immutable full-text policy documents', () => {
  const input = { documentId: 'document_a', expectedVersion: 0, previousVersion: null, purpose: 'MANDATE_POLICY' as const, text: 'cafe\u0301\r\n  Evidence\r' };
  it('normalizes only NFC and line endings, with deterministic content and full version hashes', async () => {
    const first = await createPolicyDocumentVersion({ actor, now }, input, null);
    const equivalent = await createPolicyDocumentVersion({ actor, now }, { ...input, text: 'café\n  Evidence\n' }, null);
    expect(first).toEqual(equivalent);
    expect(first.text).toBe('café\n  Evidence\n');
    expect(normalizePolicyText('  A \n')).toBe('  A \n');
    expect(first.contentHash).toBe(await commandDigest(first.text));
    for (const text of ['café\nEvidence\n', 'café\n  Evidence', 'café\n  Different\n']) {
      expect((await createPolicyDocumentVersion({ actor, now }, { ...input, text }, null)).contentHash).not.toBe(first.contentHash);
    }
    expect(() => { first.text = 'Edited'; }).toThrow();
  });
  it('binds tenant, purpose, author, time, version and exact predecessor without mutating history', async () => {
    const first = await createPolicyDocumentVersion({ actor, now }, input, null);
    const otherAuthor = await createPolicyDocumentVersion({ actor: { ...actor, actorId: 'another_buyer' }, now }, input, null);
    const otherTenant = await createPolicyDocumentVersion({ actor: { ...actor, organizationId: 'org_b' }, now }, input, null);
    const otherPurpose = await createPolicyDocumentVersion({ actor, now }, { ...input, purpose: 'ACCEPTANCE_POLICY' }, null);
    const later = await createPolicyDocumentVersion({ actor, now: '2026-11-14T12:01:00.000Z' }, input, null);
    for (const document of [otherAuthor, otherTenant, otherPurpose, later]) {
      expect(document.contentHash).toBe(first.contentHash);
      expect(document.hash).not.toBe(first.hash);
    }
    const revised = await createPolicyDocumentVersion({ actor, now }, { ...input, expectedVersion: 1, previousVersion: mandateReference(first), text: 'New complete terms.' }, first);
    expect(revised.version).toBe(2);
    expect(revised.previousVersion).toEqual(mandateReference(first));
    expect(first.text).toBe('café\n  Evidence\n');
    await expect(createPolicyDocumentVersion({ actor, now }, { ...input, expectedVersion: 1, previousVersion: mandateReference(first), purpose: 'ACCEPTANCE_POLICY' }, first))
      .rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await expect(createPolicyDocumentVersion({ actor: { ...actor, organizationId: 'org_b' }, now }, { ...input, expectedVersion: 1, previousVersion: mandateReference(first) }, first))
      .rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await expect(createPolicyDocumentVersion({ actor, now }, { ...input, expectedVersion: 1, previousVersion: { ...mandateReference(first), hash: '0'.repeat(64) } }, first))
      .rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });
  it('rejects altered text, rehashed content without a version hash, malformed chains and ineligible authors', async () => {
    const document = await createPolicyDocumentVersion({ actor, now }, input, null);
    for (const modified of [{ ...document, text: 'Altered' }, { ...document, text: 'Altered', contentHash: await commandDigest('Altered') },
      { ...document, createdBy: 'attacker' }, { ...document, version: 2 }]) {
      await expect(validatePolicyDocumentVersion(modified)).rejects.toMatchObject({ code: 'POLICY_DOCUMENT_INVALID' });
    }
    for (const roles of [['auditor'], ['receiver'], ['supplier_admin'], ['support'], ['service']] as ActorContext['roles'][]) {
      await expect(createPolicyDocumentVersion({ actor: { ...actor, roles }, now }, input, null)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
  });
});

describe('immutable proposals with distinct accepted authority', () => {
  it('creates an immutable proposal and OPEN decision, with full resolved documents and no accepted authority', async () => {
    const { context, command, acceptance, document } = await fixture();
    const result = await createMandateProposal(context, command);
    expect(result.proposal.previousAcceptedVersion).toBeNull();
    expect(result.proposal.expectedHead).toBeNull();
    expect(result.proposal).not.toHaveProperty('mandateEpoch');
    expect(result.decision).toMatchObject({ state: 'OPEN', version: 1, authorization: null, operationId: 'operation_a' });
    expect(result.supersededDecision).toBeNull();
    expect(context.head).toBeNull();
    expect(await resolveMandatePolicyDocuments(result.proposal, context)).toEqual([acceptance, document]);
    expect(() => { result.proposal.policy.siteIds.push('site_b'); }).toThrow();
    command.policy.siteIds.push('site_b');
    expect(result.proposal.policy.siteIds).toEqual(['site_a']);
  });
  it('normalizes equivalent policy deadlines while preserving complete proposal hash sensitivity', async () => {
    const { context, command } = await fixture();
    const { proposal } = await createMandateProposal(context, command);
    const equivalent = await createMandateProposal(context, { ...command, expiresAt: '2026-11-14T07:00:00-06:00',
      policy: { ...command.policy, expiresAt: '2026-11-14T07:00:00-06:00', communication: { ...command.policy.communication, expiresAt: '2026-11-14T07:00:00-06:00' } } });
    expect(equivalent.proposal.hash).toBe(proposal.hash);
    const mutations = [
      { ...proposal, requesterId: 'other_requester' }, { ...proposal, organizationEpoch: 3 }, { ...proposal, mandateId: 'other_mandate' },
      { ...proposal, responsibility: { ...proposal.responsibility, version: 2 } }, { ...proposal, expiresAt: '2026-11-14T12:30:00.000Z' },
      { ...proposal, policyDocument: { ...proposal.policyDocument, version: 2 } }, { ...proposal, policy: { ...proposal.policy, mode: 'ACT_WITHIN_MANDATE' as const } },
      { ...proposal, expectedHead: { mandateId: 'mandate_a', mandateVersion: 1, mandateEpoch: 2, hash: 'b'.repeat(64) } },
    ];
    for (const mutation of mutations) await expect(validateMandateProposalVersion(mutation)).rejects.toMatchObject({ code: 'PROPOSAL_INVALID' });
    expect((await createMandateProposal(context, { ...command, expiresAt: '2026-11-14T12:30:00.000Z' })).proposal.hash).not.toBe(proposal.hash);
  });
  it('enforces the connected no-money, no-supplier, no-communication ceiling before accepting references', async () => {
    const { context, command } = await fixture();
    const policies: MandatePolicy[] = [
      { ...command.policy, mode: 'ACT_WITHIN_MANDATE' }, { ...command.policy, mode: 'PREPARE_FOR_APPROVAL' }, { ...command.policy, mode: 'SHADOW' },
      { ...command.policy, siteIds: ['site_a', 'site_b'] }, { ...command.policy, siteIds: ['site_b'] },
      { ...command.policy, actions: ['allocate_funds'] }, { ...command.policy, supplierRelationshipIds: ['fabricated_supplier'] },
      { ...command.policy, budgets: [{ assetId: 'fabricated_asset', category: 'supplier_principal', perOperation: '1', perResponsibility: '1', periodMaximum: '1', periodStartsAt: now, periodEndsAt: expiry }] },
      ...[{ maximumMessages: 1 }, { recipientIds: ['external_recipient'] }, { purposes: ['sales'] }, { messageKinds: ['email'] }]
        .map(change => ({ ...command.policy, communication: { ...command.policy.communication, ...change } })),
    ];
    for (const policy of policies) await expect(createMandateProposal(context, { ...command, policy })).rejects.toMatchObject({ code: 'MANDATE_POLICY_UNSUPPORTED' });
  });
  it('requires current buyer action scope even for a broad reader, owner or service with buyer roles', async () => {
    const { context, command } = await fixture();
    for (const changed of [
      { ...actor, actionSiteIds: [] }, { ...actor, roles: ['owner'] as ActorContext['roles'], siteIds: ['site_a', 'site_b'], actionSiteIds: ['site_b'] },
      { ...actor, principalKind: 'service' as const, roles: ['owner'] as ActorContext['roles'] }, { ...actor, organizationId: 'other_org' },
      { ...actor, environment: 'production' as const }, { ...actor, roles: ['auditor'] as ActorContext['roles'] },
    ]) await expect(createMandateProposal({ ...context, actor: changed }, command)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('fails closed on missing, foreign, ambiguous, altered or wrong-purpose policy documents and site records', async () => {
    const { context, command, document, acceptance } = await fixture();
    for (const documents of [[], [document], [acceptance, document, document], [acceptance, { ...document, environment: 'production' as const }]]) {
      await expect(createMandateProposal({ ...context, documents }, command)).rejects.toBeDefined();
    }
    await expect(createMandateProposal(context, { ...command, policyDocument: mandateReference(acceptance) })).rejects.toMatchObject({ code: 'POLICY_DOCUMENT_UNAVAILABLE' });
    const responsibilityChanged = { ...responsibility, acceptancePolicy: 'New requirements', version: 2 };
    await expect(createMandateProposal({ ...context, responsibility: responsibilityChanged }, { ...command, responsibility: await mandateResponsibilityReference(responsibilityChanged) }))
      .rejects.toMatchObject({ code: 'POLICY_DOCUMENT_CHANGED' });
    for (const site of [{ ...context.site, organizationId: 'other_org' }, { ...context.site, id: 'other_site' }, { ...context.site, active: false }]) {
      await expect(createMandateProposal({ ...context, site }, command)).rejects.toMatchObject({ code: 'SITE_UNAVAILABLE' });
    }
  });
  it('binds current organization, responsibility, deadlines and head without deriving accepted authority from a proposal', async () => {
    const { context, command } = await fixture();
    const { proposal } = await createMandateProposal(context, command);
    await expect(assertMandateProposalCurrent(proposal, { ...context, organizationEpoch: 3 })).rejects.toMatchObject({ code: 'ORGANIZATION_CHANGED' });
    for (const changed of [{ ...responsibility, version: 2 }, { ...responsibility, title: 'Altered without version increment' }]) {
      await expect(assertMandateProposalCurrent(proposal, { ...context, responsibility: changed })).rejects.toMatchObject({ code: 'RESPONSIBILITY_CHANGED' });
    }
    await expect(assertMandateProposalCurrent(proposal, { ...context, now: expiry })).rejects.toMatchObject({ code: 'PROPOSAL_EXPIRED' });
    await expect(createMandateProposal(context, { ...command, expiresAt: now })).rejects.toMatchObject({ code: 'PROPOSAL_INVALID' });
    await expect(createMandateProposal(context, { ...command, expiresAt: '2026-11-14T14:00:00.000Z' })).rejects.toMatchObject({ code: 'PROPOSAL_INVALID' });
  });
  it('supersedes only the exact OPEN proposal and keeps the prior accepted version/head unchanged across proposal revisions', async () => {
    const { context, command } = await fixture();
    const acceptedVersion = await createMandateVersion({ id: 'mandate_a', organizationId: 'org_a', environment: 'development', responsibilityId: responsibility.id,
      authorId: actor.actorId, organizationEpoch: 2, currentMandateEpoch: 0, expectedVersion: 0, now }, command.policy, null);
    const head = { organizationId: 'org_a', environment: 'development' as const, organizationEpoch: 2, responsibilityId: responsibility.id,
      mandateId: 'mandate_a', mandateVersion: 1, mandateEpoch: 4, policyHash: acceptedVersion.policyHash, expiresAt: expiry, state: 'PAUSED' as const };
    const current = { ...context, acceptedVersion, head };
    const bound = { ...command, previousAcceptedVersion: await mandateVersionReference(acceptedVersion), expectedHead: await mandateHeadReference(head) };
    const first = await createMandateProposal(current, bound);
    const revision = { ...bound, expectedProposalVersion: 1, previousProposal: mandateReference(first.proposal), expiresAt: '2026-11-14T12:30:00.000Z' };
    const second = await createMandateProposal({ ...current, previousProposal: first.proposal, previousDecision: first.decision, operationId: 'operation_b' }, revision);
    expect(second.proposal.version).toBe(2);
    expect(second.decision).toMatchObject({ version: 1, state: 'OPEN' });
    expect(second.supersededDecision).toMatchObject({ version: 2, state: 'SUPERSEDED', replacement: mandateReference(second.proposal), operationId: 'operation_b' });
    expect(second.proposal.previousAcceptedVersion).toEqual(bound.previousAcceptedVersion);
    expect(second.proposal.expectedHead).toEqual(bound.expectedHead);
    expect(current.acceptedVersion.version).toBe(1);
    expect(current.head.mandateEpoch).toBe(4);
    await expect(createMandateProposal({ ...current, previousProposal: first.proposal, previousDecision: second.supersededDecision }, revision))
      .rejects.toMatchObject({ code: 'DECISION_TERMINAL' });
    await expect(assertMandateProposalCurrent(second.proposal, { ...current, head: { ...head, mandateEpoch: 5, state: 'REVOKED' } }))
      .rejects.toMatchObject({ code: 'AUTHORITY_CHANGED' });
  });
  it('expires a proposal once at the exact boundary without changing any authority or financial state', async () => {
    const { context, command } = await fixture();
    const { proposal, decision } = await createMandateProposal(context, command);
    await expect(expireMandateProposal(proposal, decision, { now, operationId: 'expiry_a' })).rejects.toMatchObject({ code: 'PROPOSAL_CURRENT' });
    const expired = await expireMandateProposal(proposal, decision, { now: expiry, operationId: 'expiry_a' });
    expect(expired).toMatchObject({ state: 'EXPIRED', version: 2, actorId: null, authorization: null });
    await expect(expireMandateProposal(proposal, expired, { now: expiry, operationId: 'expiry_b' })).rejects.toMatchObject({ code: 'DECISION_TERMINAL' });
    await expect(createMandateProposal({ ...context, previousProposal: proposal, previousDecision: expired }, { ...command, expectedProposalVersion: 1, previousProposal: mandateReference(proposal) }))
      .rejects.toMatchObject({ code: 'DECISION_TERMINAL' });
    expect(context.responsibility).toMatchObject({ executionState: 'DRAFT', authorityState: null, coverageState: 'UNKNOWN' });
  });
});
