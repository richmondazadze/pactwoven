import { describe, expect, it } from 'vitest';
import { commandDigest } from '@pactwoven/contracts/canonical';
import { MandateDocumentReadSchema, MandateReviewSchema, type MandateDocumentRead } from '@pactwoven/contracts';
import { mandateReadFixture, mandateFixtureNow as now, mandateFixtureTime as at } from './mandates.test-fixtures';
import { authoringAvailable, authoringRevisionAvailable, parseAuthoringUtc, authoringCommandDigest, createAuthoringManifest, createDocumentAuthoringCapsule, createProposalAuthoringCapsule, normalizeAuthoringText, qualifyAuthoringProposal, selectionFromDocument, verifyAuthoringCapsule, type MandateAuthoringCapsule } from './mandate-authoring';
import { locatorFromAuthoringCapsule } from './mandate-authoring-recovery';
async function fixture() {
  const f = await mandateReadFixture(false); f.page.eligibility = [{ action: 'PROPOSE', eligible: true, requiresStepUp: false, blockers: [] }];
  const observation = { data: f.page, receivedAt: now, receivedMonotonic: 10 };
  const ids = { acceptanceDocumentId: 'acceptance_a', policyDocumentId: 'policy_a', proposalId: 'proposal_a', mandateId: 'mandate_a' };
  const manifest = await createAuthoringManifest(f.scope, observation, 'preparation_a', ids, now);
  return { ...f, observation, ids, manifest };
}
async function saved(capsule: MandateAuthoringCapsule & { kind: 'document' }): Promise<MandateDocumentRead> {
  const { command: request, scope } = capsule, c = request.command;
  const body = { schemaVersion: 1 as const, id: c.documentId, version: c.expectedVersion + 1, organizationId: scope.organizationId, environment: scope.environment, purpose: c.purpose, normalization: 'NFC_LF_V1' as const, text: c.text, contentHash: await commandDigest(c.text), previousVersion: c.previousVersion, createdAt: at(1000), createdBy: scope.actorId };
  const document = { ...body, hash: await commandDigest(body) };
  return MandateDocumentReadSchema.parse({ schemaVersion: 1, environment: scope.environment, organizationId: scope.organizationId, responsibilityId: scope.responsibilityId, observedAt: at(2000), document, savedAgainst: { responsibility: request.responsibility, organizationEpoch: request.expectedOrganizationEpoch }, savedResponsibility: capsule.observation.data.responsibility,
    saveOperation: { schemaVersion: 1, organizationId: scope.organizationId, kind: 'mandate.document.create', responsibilityId: scope.responsibilityId, target: { kind: 'document', id: document.id, version: document.version, hash: document.hash }, commandHash: capsule.commandHash, intentHash: null, observedAt: document.createdAt, operation: { id: `${document.id}_operation`, environment: scope.environment, status: 'succeeded', aggregateId: document.id, aggregateVersion: document.version, financialState: null, evidenceRefs: [], nextCheckAt: null, error: null } } });
}
async function proposalCase() {
  const f = await fixture();
  const a = await saved(await createDocumentAuthoringCapsule(f.scope, f.manifest, f.observation, 'ACCEPTANCE_POLICY', f.current.acceptancePolicy, 'acceptance_request_123456', now));
  const b = await saved(await createDocumentAuthoringCapsule(f.scope, f.manifest, f.observation, 'MANDATE_POLICY', '  advice\nonly\n', 'policy_request_123456789', now));
  const manifest = { ...f.manifest, documents: { acceptance: selectionFromDocument(a), policy: selectionFromDocument(b) } };
  const dates = { policyExpiresAt: at(3600000), proposalExpiresAt: at(600000) };
  const capsule = await createProposalAuthoringCapsule(f.scope, manifest, f.observation, [a, b], dates, 'proposal_request_1234567', now);
  return { ...f, manifest, documents: [a, b] as [MandateDocumentRead, MandateDocumentRead], dates, capsule };
}
describe('immutable advice-only authoring', () => {
  it('normalizes NFC and line endings, preserving all other whitespace', () => expect(normalizeAuthoringText('  Cafe\u0301\r\n\tline\r\n')).toBe('  Café\n\tline\n'));
  it.each(['owner', 'finance', 'operations'])('accepts current human %s without MFA', async role => { const f = await fixture(); expect(authoringAvailable(f.page, { ...f.scope, roles: [role] }, now)).toBe(true); });
  it.each(['role', 'service', 'read-site', 'action-site', 'epoch', 'expired', 'future', 'eligibility', 'step-up'] as const)('rejects %s context', async change => { const f = await fixture(), scope = structuredClone(f.scope), page = structuredClone(f.page); let time = now; if (change === 'role') scope.roles = ['auditor']; if (change === 'service') scope.principalKind = 'service'; if (change === 'read-site') scope.siteIds = []; if (change === 'action-site') scope.actionSiteIds = []; if (change === 'epoch') scope.organizationEpoch++; if (change === 'expired') time += 60000; if (change === 'future') time--; if (change === 'eligibility') page.eligibility = []; if (change === 'step-up') page.eligibility[0]!.requiresStepUp = true; expect(authoringAvailable(page, scope, time)).toBe(false); });
  it('clones scope and IDs before the first digest await', async () => { const f = await fixture(), ids = { ...f.ids }, scope = structuredClone(f.scope); const task = createAuthoringManifest(scope, f.observation, 'second_preparation', ids, now); ids.policyDocumentId = 'changed'; scope.actorId = 'changed'; const result = await task; expect(result.ids.policyDocumentId).toBe('policy_a'); expect(result.scope.actorId).toBe(f.scope.actorId); expect(Object.isFrozen(result.ids)).toBe(true); });
  it('requires exact current acceptance text and produces a whole-request digest', async () => { const f = await fixture(); await expect(createDocumentAuthoringCapsule(f.scope, f.manifest, f.observation, 'ACCEPTANCE_POLICY', 'other terms', 'acceptance_request_123456', now)).rejects.toThrow(); const capsule = await createDocumentAuthoringCapsule(f.scope, f.manifest, f.observation, 'MANDATE_POLICY', '  Café\r\n', 'document_request_123456', now); expect(capsule.command.command.text).toBe('  Café\n'); expect(await authoringCommandDigest(f.scope, 'document', capsule.command)).toBe(capsule.commandHash); expect(await verifyAuthoringCapsule(capsule)).toEqual(capsule); expect(Object.isFrozen(capsule.command.command)).toBe(true); });
  it('versions only a qualified exact predecessor', async () => { const f = await fixture(), first = await createDocumentAuthoringCapsule(f.scope, f.manifest, f.observation, 'MANDATE_POLICY', 'one', 'document_request_123456', now), previous = await saved(first); const next = await createDocumentAuthoringCapsule(f.scope, f.manifest, f.observation, 'MANDATE_POLICY', 'two', 'document_request_234567', now, previous); expect(next.command.command.expectedVersion).toBe(1); expect(next.command.command.previousVersion).toEqual({ id: previous.document.id, version: 1, hash: previous.document.hash }); const wrong = structuredClone(previous); wrong.document.text = 'tampered'; await expect(createDocumentAuthoringCapsule(f.scope, f.manifest, f.observation, 'MANDATE_POLICY', 'two', 'document_request_234567', now, wrong)).rejects.toThrow(); });
  it('requires two selected documents and fixes every unsupported effect to empty', async () => { const f = await proposalCase(), p = f.capsule.command.policy; expect(p).toMatchObject({ mode: 'ADVISE', siteIds: ['site_a'], actions: [], budgets: [], supplierRelationshipIds: [], communication: { recipientIds: [], purposes: [], messageKinds: [], maximumMessages: 0, expiresAt: p.expiresAt } }); expect(await verifyAuthoringCapsule(f.capsule)).toEqual(f.capsule); await expect(createProposalAuthoringCapsule(f.scope, f.manifest, f.observation, [f.documents[1], f.documents[0]], f.dates, 'proposal_request_2345678', now)).rejects.toThrow(); });
  it('clones full saved text and dates before asynchronous validation', async () => { const f = await proposalCase(), docs = structuredClone(f.documents), dates = { ...f.dates }; const task = createProposalAuthoringCapsule(f.scope, f.manifest, f.observation, docs, dates, 'proposal_request_2345678', now); docs[0].document.text = 'changed'; dates.policyExpiresAt = at(-1); const capsule = await task; expect(capsule.command.policy.expiresAt).toBe(f.dates.policyExpiresAt); expect(capsule.documents[0].document.text).toBe(f.current.acceptancePolicy); });
  it.each([{ policyExpiresAt: at(-1), proposalExpiresAt: at(1) }, { policyExpiresAt: at(1000), proposalExpiresAt: at(1001) }, { policyExpiresAt: at(1000), proposalExpiresAt: at(0) }])('rejects invalid expiry ordering %#', async dates => { const f = await proposalCase(); await expect(createProposalAuthoringCapsule(f.scope, f.manifest, f.observation, f.documents, dates, 'proposal_request_2345678', now)).rejects.toThrow(); });
  it('deliberately revisions only the original requester’s exact open unexpired proposal, with current responsibility pins', async () => {
    const f = await fixture(), revision = f.review, proposal = revision.envelope.proposal!, scope = { ...f.scope, actorId: proposal.requesterId }, ids = { ...f.ids, proposalId: proposal.id, mandateId: proposal.mandateId };
    const manifest = await createAuthoringManifest(scope, f.observation, 'revision_preparation', ids, now, revision);
    expect(manifest.mode).toEqual({ kind: 'revise', proposal: { id: proposal.id, version: proposal.version, hash: proposal.hash } });
    expect(manifest.basis.responsibility.version).toBe(f.current.version);
    const capsule = await createDocumentAuthoringCapsule(scope, manifest, f.observation, 'ACCEPTANCE_POLICY', f.current.acceptancePolicy, 'revision_document_123456', now, null, revision);
    expect(await verifyAuthoringCapsule(capsule)).toEqual(capsule);
    await expect(createAuthoringManifest(f.scope, f.observation, 'wrong_requester', ids, now, revision)).rejects.toThrow();
    await expect(createAuthoringManifest(scope, f.observation, 'wrong_proposal', { ...ids, proposalId: 'another_proposal' }, now, revision)).rejects.toThrow();
    await expect(createDocumentAuthoringCapsule(scope, manifest, f.observation, 'MANDATE_POLICY', 'terms', 'revision_document_234567', now)).rejects.toThrow();
  });
  it('does not turn an expired historical proposal into a fresh revision', async () => {
    const f = await fixture(), revision = structuredClone(f.review), p = revision.envelope.proposal!; p.expiresAt = at(-1); const { hash: _, ...body } = p; p.hash = await commandDigest(body); revision.envelope.decision!.proposal.hash = p.hash; revision.effectiveDecisionState = 'EXPIRED';
    await expect(createAuthoringManifest({ ...f.scope, actorId: p.requesterId }, f.observation, 'expired_revision', { ...f.ids, proposalId: p.id }, now, revision)).rejects.toThrow();
  });
  it('requires selected saved material as the exact predecessor instead of repeating version one', async () => {
    const f = await fixture(), first = await createDocumentAuthoringCapsule(f.scope, f.manifest, f.observation, 'MANDATE_POLICY', 'first', 'document_request_123456', now), previous = await saved(first), manifest = { ...f.manifest, documents: { ...f.manifest.documents, policy: selectionFromDocument(previous) } };
    await expect(createDocumentAuthoringCapsule(f.scope, manifest, f.observation, 'MANDATE_POLICY', 'new', 'document_request_234567', now)).rejects.toThrow();
    expect((await createDocumentAuthoringCapsule(f.scope, manifest, f.observation, 'MANDATE_POLICY', 'new', 'document_request_234567', now, previous)).command.command.expectedVersion).toBe(1);
  });
  it('rejects body tampering even when the outer integrity hash is recomputed', async () => { const f = await proposalCase(), capsule = structuredClone(f.capsule); capsule.command.policy.communication.maximumMessages = 1; const { integrityHash: _, ...body } = capsule; capsule.integrityHash = await commandDigest(body); await expect(verifyAuthoringCapsule(capsule)).rejects.toThrow(); });
  it('qualifies a saved proposal after its later rejection without requiring the initial operation ID', async () => {
    const f = await proposalCase(), c = f.capsule.command, locator = locatorFromAuthoringCapsule(f.capsule);
    const body = { schemaVersion: 1 as const, id: c.proposalId, version: 1, previousProposal: c.previousProposal, organizationId: f.scope.organizationId, environment: f.scope.environment, organizationEpoch: c.expectedOrganizationEpoch, mandateId: c.mandateId, responsibility: c.responsibility, requesterId: f.scope.actorId, previousAcceptedVersion: c.previousAcceptedVersion, expectedHead: c.expectedHead, policy: c.policy, policyHash: await commandDigest(c.policy), policyDocument: c.policyDocument, createdAt: at(2000), expiresAt: c.expiresAt };
    const p = { ...body, hash: await commandDigest(body) }, reference = { id: p.id, version: p.version, hash: p.hash };
    const review = MandateReviewSchema.parse({ ...f.review, responsibilityVersions: [f.current], effectiveDecisionState: 'REJECTED', envelope: { ...f.review.envelope, responsibility: f.current, responsibilityReference: f.page.responsibilityReference, observedAt: at(4000), proposal: p, policyDocuments: f.documents.map(d => d.document), decision: { proposal: reference, version: 2, state: 'REJECTED', createdAt: p.createdAt, decidedAt: at(3000), actorId: 'independent_reviewer', intentHash: 'a'.repeat(64), reason: 'Revise', replacement: null, authorization: null, operationId: 'later_rejection_operation' } } });
    const result = { ...f.documents[0].saveOperation, kind: 'mandate.propose' as const, commandHash: f.capsule.commandHash, target: { kind: 'proposal' as const, ...reference }, observedAt: p.createdAt, operation: { ...f.documents[0].saveOperation.operation, id: 'original_proposal_operation', aggregateId: p.id, aggregateVersion: 1 } };
    expect((await qualifyAuthoringProposal(review, f.scope, locator, result, f.capsule)).envelope.decision!.state).toBe('REJECTED');
    await expect(qualifyAuthoringProposal(review, { ...f.scope, actorId: 'different_reader' }, locator, result)).rejects.toThrow();
  });
});

describe('native UTC terms and revision entry', () => {
  it('interprets labeled UTC fields without the browser local offset', () => { expect(parseAuthoringUtc('2026-11-15T12:34')).toBe('2026-11-15T12:34:00.000Z'); expect(parseAuthoringUtc('2026-11-15T12:34:56')).toBe('2026-11-15T12:34:56.000Z'); });
  it.each(['2026-02-30T12:00', '2026-11-15T24:00', '2026-11-15', '', '2026-11-15T12:00Z', '2026-11-15T12:00-06:00'])('rejects invalid or ambiguously zoned UTC entry %s', input => expect(() => parseAuthoringUtc(input)).toThrow());
  it('offers revision only to the currently eligible original requester of an open unexpired proposal', async () => {
    const f = await fixture(), review = structuredClone(f.review), p = review.envelope.proposal!; review.envelope.eligibility = [{ action: 'PROPOSE', eligible: true, requiresStepUp: false, blockers: [] }]; const scope = { ...f.scope, actorId: p.requesterId };
    expect(authoringRevisionAvailable(review, scope, now)).toBe(true); expect(authoringRevisionAvailable(review, f.scope, now)).toBe(false); expect(authoringRevisionAvailable(review, scope, now + 60000)).toBe(false); expect(authoringRevisionAvailable(review, { ...scope, actionSiteIds: [] }, now)).toBe(false);
    review.envelope.decision!.state = 'REJECTED'; expect(authoringRevisionAvailable(review, scope, now)).toBe(false);
  });
});
