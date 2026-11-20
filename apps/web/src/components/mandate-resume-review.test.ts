import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { commandDigest } from '@pactwoven/contracts/canonical';
import { createAuthorityCapsule } from '../lib/mandate-authority';
import { decisionTestCase, mandateFixtureNow as now } from '../lib/mandates.test-fixtures';
import { MandateResumeReview } from './mandate-resume-review';
import { MotionProvider } from './motion';
vi.mock('./workspace-provider', () => ({ useWorkspace: () => { throw new Error('Pure accepted review must not read connected identity.'); } }));
const render = (element: ReactElement) => renderToStaticMarkup(createElement(MotionProvider, { children: element }));
async function fixture() {
  const f = await decisionTestCase('AUTHORIZE'), review = structuredClone(f.outcomeReview), at = now + 2000, e = review.envelope;
  e.observedAt = new Date(at).toISOString(); e.head!.state = 'PAUSED'; e.head!.mandateEpoch = 2; review.effectiveAuthority = { state: 'PAUSED', blockers: ['AUTHORITY_PAUSED'] }; e.eligibility = [{ action: 'RESUME', eligible: true, requiresStepUp: true, blockers: [] }];
  const selected = structuredClone(e.proposal!); selected.id = 'historical_selected'; selected.version = 1; selected.previousProposal = null; selected.expiresAt = new Date(now).toISOString(); const { hash: _, ...body } = selected; selected.hash = await commandDigest(body); e.proposal = selected;
  e.decision = { proposal: { id: selected.id, version: 1, hash: selected.hash }, version: 1, state: 'OPEN', createdAt: selected.createdAt, decidedAt: null, actorId: null, intentHash: null, reason: null, replacement: null, authorization: null, operationId: 'historical_selected_operation' }; review.effectiveDecisionState = 'EXPIRED';
  const capsule = await createAuthorityCapsule(f.scope, { data: review, receivedAt: at, receivedMonotonic: 0 }, 'RESUME', '  Resume exact terms.\n<script>literal reason</script>  ', 'resume_review_original', at);
  return { ...f, review, capsule };
}
describe('full accepted RESUME presentation', () => {
  it('renders the complete accepted documents and responsibility independently of selected history', async () => {
    const f = await fixture(), html = render(createElement(MandateResumeReview, { capsule: f.capsule }));
    expect(html).toContain('Original mandate policy.\n  Preserve this indentation and full text.\n&lt;script&gt;not executable&lt;/script&gt;'); expect(html).toContain('Original acceptance text.\nKeep the signed receipt.'); expect(html).toContain('Complete accepted document');
    expect(html).toContain('Original responsibility title'); expect(html).toContain('Original delivery requirements.'); expect(html).toContain('4 crates'); expect(html).toContain('Original requirement'); expect(html).toContain('Photograph the seal.'); expect(html).toContain('Recorded time zone: UTC'); expect(html).toContain('Original service window');
    expect(html).toContain(f.review.envelope.acceptedProposal!.id); expect(html).toContain('proposal_original · version 3'); expect(html).not.toContain('historical_selected'); expect(html).not.toContain('<script>');
  });
  it('shows exact normalized reason, original requester, paused epoch and unchanged terms expiry', async () => {
    const f = await fixture(), html = render(createElement(MandateResumeReview, { capsule: f.capsule })); expect(html).toContain('Resume exact terms.\n&lt;script&gt;literal reason&lt;/script&gt;'); expect(html).toContain('requester_a'); expect(html).toContain('Version 1 · advice only'); expect(html).toContain('PAUSED · epoch 2'); expect(html).toContain('ACTIVE · epoch 3'); expect(html).toContain(f.capsule.nextHead.expiresAt); expect(html).toContain('Existing obligations and recorded activity remain'); expect(html).toContain('does not authorize purchases, funds, supplier orders or outbound messages');
  });
  it('distinguishes historical approval and proposed ACTIVE from current authority and fresh factors', async () => {
    const f = await fixture(), html = render(createElement(MandateResumeReview, { capsule: f.capsule })); expect(html).toContain('Historical independent approval'); expect(html).toContain('reviewer_a'); expect(html).toContain('This approval is historical'); expect(html).toContain('current independent owner or finance reviewer'); expect(html).toContain('Completing verification does not submit a resume'); expect(html).toContain('check Current effective authority for the latest status'); expect(html).not.toContain('Authority is active'); expect(html).not.toContain('factor_evidence');
  });
  it('keeps exact references in a disclosure without exposing private identity or adding factor/send inputs', async () => {
    const f = await fixture(), html = render(createElement(MandateResumeReview, { capsule: f.capsule })); for (const value of [f.capsule.key, f.capsule.intent.mandate.hash, f.capsule.intent.head.hash, f.capsule.intent.responsibility.hash, f.capsule.expectedTarget.hash, f.review.envelope.acceptedVersion!.policyHash, 'authorization_receipt', 'decision_operation']) expect(html).toContain(value);
    expect(html).toContain('aria-expanded="false"'); expect(html).toContain('inert=""'); expect(html).not.toContain('<input'); expect(html).not.toContain('<textarea'); expect(html).not.toContain('type="submit"'); expect(html).not.toContain(f.scope.sessionId); expect(html).not.toContain('test_token'); expect(html).not.toContain('Verified today');
  });
  it('does not truncate long document and requirement text or interpret HTML', async () => {
    // Presentation-only input: qualification belongs to the accepted capsule helper.
    const f = await fixture(), capsule = structuredClone(f.capsule); if (!('envelope' in capsule.observation.data)) throw new Error('Full review required');
    const long = 'Complete exact policy line.\n'.repeat(700) + '<img src=x onerror=alert(1)>END_OF_POLICY'; capsule.observation.data.envelope.policyDocuments.find(d => d.purpose === 'MANDATE_POLICY')!.text = long; capsule.observation.data.responsibilityVersions[0]!.requirements[0]!.evidenceRule = 'Evidence detail '.repeat(150) + 'END_OF_RULE';
    const html = render(createElement(MandateResumeReview, { capsule })); expect(html).toContain('Complete exact policy line.\n'.repeat(700)); expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;END_OF_POLICY'); expect(html).toContain('END_OF_RULE'); expect(html).not.toContain('<img src=x');
  });
  it.each(['other-action', 'missing-accepted-proposal', 'missing-approval', 'missing-accepted-version'] as const)('shows unavailable text for %s rather than an actionable review', async kind => {
    const f = await fixture(), capsule: any = structuredClone(f.capsule); if (kind === 'other-action') capsule.intent.action = 'PAUSE'; else if (kind === 'missing-accepted-proposal') capsule.observation.data.envelope.acceptedProposal = null; else if (kind === 'missing-approval') capsule.observation.data.envelope.acceptedDecision.authorization = null; else capsule.observation.data.envelope.acceptedVersion = null;
    const html = render(createElement(MandateResumeReview, { capsule })); expect(html).toContain('Accepted resume review unavailable'); expect(html).not.toContain('Resume the accepted mandate'); expect(html).not.toContain('type="submit"');
  });
});
