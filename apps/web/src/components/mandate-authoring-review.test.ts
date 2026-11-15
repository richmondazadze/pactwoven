import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { commandDigest } from '@pactwoven/contracts/canonical';
import { MandateDocumentReadSchema, type MandateDocumentRead } from '@pactwoven/contracts';
import { mandateReadFixture, mandateFixtureNow as now, mandateFixtureTime as at } from '../lib/mandates.test-fixtures';
import { createAuthoringManifest, createDocumentAuthoringCapsule, createProposalAuthoringCapsule, selectionFromDocument, type MandateAuthoringCapsule } from '../lib/mandate-authoring';
import { MandateAuthoringReview, MandateSavedDocument } from './mandate-authoring-review';
import { MandateDocumentEditor } from './mandate-document-editor';
import { MandateProposalEditor } from './mandate-proposal-editor';
import { MotionProvider } from './motion';
vi.mock('./workspace-provider', () => ({ useWorkspace: () => { throw new Error('Connected hooks must not run in pure record presentation.'); } }));
const render = (element: ReactElement) => renderToStaticMarkup(createElement(MotionProvider, { children: element }));
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

describe('native complete authoring review', () => {
  it('renders complete normalized text safely without private session or execution controls', async () => {
    const f = await fixture(), text = '  Café\n\tIndented\n<script>plain text</script>\n', capsule = await createDocumentAuthoringCapsule(f.scope, f.manifest, f.observation, 'MANDATE_POLICY', text, 'document_request_123456789', now), html = render(createElement(MandateAuthoringReview, { capsule }));
    expect(html).toContain('  Café\n\tIndented\n&lt;script&gt;plain text&lt;/script&gt;\n'); expect(html).not.toContain('<script>'); expect(html).not.toContain(f.scope.sessionId); expect(html).not.toContain('Bearer'); expect(html).not.toContain('<textarea'); expect(html).not.toContain('<input'); expect(html).not.toContain('Save mandate policy document'); expect(html).toContain('aria-expanded="false"'); expect(html).toContain('inert=""');
  });
  it('renders all 20,000 characters, indentation and final newline outside reference disclosures', async () => {
    const f = await fixture(), text = '  start\n' + 'x'.repeat(19987) + '\nend\n', capsule = await createDocumentAuthoringCapsule(f.scope, f.manifest, f.observation, 'MANDATE_POLICY', text, 'document_request_123456789', now), html = render(createElement(MandateAuthoringReview, { capsule }));
    expect(text).toHaveLength(20000); expect(html).toContain(text); expect(html.indexOf(text)).toBeLessThan(html.indexOf('Exact request references')); expect(html).not.toContain('line-clamp');
  });
  it('labels immutable saved basis and current responsibility separately, with original save and current read times', async () => {
    const f = await proposalCase(), historical = f.documents[1], current = { ...f.page, organizationEpoch: 9, responsibility: { ...f.page.responsibility, version: 8, title: 'Later current title' } }, html = render(createElement(MandateSavedDocument, { value: historical, current }));
    expect(html).toContain('Responsibility at save'); expect(html).toContain('Version 2; organization epoch 3'); expect(html).toContain('Current responsibility'); expect(html).toContain('Later current title'); expect(html).toContain('Version 8; organization epoch 9'); expect(html).toContain('Saved at'); expect(html).toContain('Checked at'); expect(html).toContain(at(1000)); expect(html).toContain(at(2000)); expect(html).toContain(historical.saveOperation.operation.id);
  });
  it('shows both complete saved documents, locked effects and exact UTC review deadlines', async () => {
    const f = await proposalCase(), html = render(createElement(MandateAuthoringReview, { capsule: f.capsule }));
    expect(html).toContain(f.documents[0].document.text); expect(html).toContain(f.documents[1].document.text); expect(html).toContain('Maximum messages: 0'); expect(html).toContain('No financial actions or spending budgets'); expect(html).toContain(f.capsule.command.expiresAt); expect(html).toContain(f.capsule.command.policy.expiresAt); expect(html).toContain('ADVISE'); expect(html).not.toContain('<select'); expect(html).not.toContain('Submit proposal for independent review');
  });
  it('renders a distinct historical revision link and proposal-version consequence', async () => {
    const f = await proposalCase(), capsule = structuredClone(f.capsule); capsule.manifest.mode = { kind: 'revise', proposal: { id: 'original_proposal', version: 3, hash: 'a'.repeat(64) } }; capsule.command.expectedProposalVersion = 3;
    const html = render(createElement(MandateAuthoringReview, { capsule })); expect(html).toContain('submits proposal version 4'); expect(html).toContain('/mandates/original_proposal/versions/3'); expect(html).toContain('separate independent decision');
  });
  it('keeps acceptance read-only, with review and save as separate controls', async () => {
    const f = await fixture(), onReview = vi.fn(), onSave = vi.fn(), props = { purpose: 'ACCEPTANCE_POLICY' as const, text: f.current.acceptancePolicy, onText: vi.fn(), capsule: null, saved: null, current: f.page, busy: false, disabled: false, fresh: true, hasSavedReference: false, onReadSaved: vi.fn(), onReview, onSave, onEdit: vi.fn(), onContinue: vi.fn() };
    const editing = render(createElement(MandateDocumentEditor, props)); expect(editing).toContain('Review document'); expect(editing).not.toContain('Save acceptance document'); expect(editing).not.toContain('<textarea');
    const capsule = await createDocumentAuthoringCapsule(f.scope, f.manifest, f.observation, 'ACCEPTANCE_POLICY', f.current.acceptancePolicy, 'document_request_123456789', now), review = render(createElement(MandateDocumentEditor, { ...props, capsule })); expect(review).toContain('Save acceptance document'); expect(review).toContain('Back to editing'); expect(onReview).not.toHaveBeenCalled(); expect(onSave).not.toHaveBeenCalled();
  });
  it('does not offer proposal submit before a complete review, or enable expired review submit', async () => {
    const f = await proposalCase(), onSubmit = vi.fn(), props = { policyExpiry: f.dates.policyExpiresAt.slice(0,19), reviewDeadline: f.dates.proposalExpiresAt.slice(0,19), onDates: vi.fn(), capsule: null, busy: false, disabled: false, fresh: true, site: f.page.site.name, onReview: vi.fn(), onSubmit, onEdit: vi.fn() };
    const editing = render(createElement(MandateProposalEditor, props)); expect(editing).toContain('type="datetime-local"'); expect(editing).toContain('Policy expires at (UTC)'); expect(editing).not.toContain('Submit proposal for independent review');
    const reviewed = render(createElement(MandateProposalEditor, { ...props, capsule: f.capsule, fresh: false })); expect(reviewed).toMatch(/<button[^>]*disabled=""[^>]*><span class="action-label">[\s\S]*Submit proposal for independent review/); expect(reviewed).toContain('review or a deadline has expired'); expect(onSubmit).not.toHaveBeenCalled();
  });
  it('blocks progression for unsaved edits and requires reading an existing predecessor before review', async () => {
    const f = await proposalCase(), props = { purpose: 'MANDATE_POLICY' as const, text: 'Unsaved replacement', onText: vi.fn(), capsule: null, saved: f.documents[1], current: f.page, busy: false, disabled: false, fresh: true, hasSavedReference: true, onReadSaved: vi.fn(), onReview: vi.fn(), onSave: vi.fn(), onEdit: vi.fn(), onContinue: vi.fn() };
    const html = render(createElement(MandateDocumentEditor, props)); expect(html).toContain('differs from this saved version'); expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Continue to proposal terms<\/button>/);
    const unread = render(createElement(MandateDocumentEditor, { ...props, saved: null })); expect(unread).toContain('Read the exact saved document before reusing'); expect(unread).toMatch(/<button[^>]*disabled=""[^>]*><span class="action-label">[\s\S]*Review document/);
  });
});
