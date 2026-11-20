import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createAuthorityCapsule, qualifyAuthorityReceipt } from '../lib/mandate-authority';
import { locatorFromAuthorityCapsule } from '../lib/mandate-authority-recovery';
import { decisionTestCase, mandateReadFixture, mandateFixtureNow as now } from '../lib/mandates.test-fixtures';
import { MandateAuthorityReceiptView, MandateAuthorityReview } from './mandate-authority-review';
import { MandateCollectionContent } from './mandate-collection';
import { MandateProposalContent } from './mandate-proposal-review';
import { MandateResumeReview } from './mandate-resume-review';
import { MotionProvider } from './motion';
vi.mock('./workspace-provider', () => ({ useWorkspace: () => { throw new Error('Pure authority presentation must not read connected identity.'); } }));
const render = (element: ReactElement) => renderToStaticMarkup(createElement(MotionProvider, { children: element }));
async function fixture(action: 'PAUSE' | 'REVOKE' = 'PAUSE') {
  const f = await mandateReadFixture(); f.page.eligibility = [{ action, eligible: true, requiresStepUp: false, blockers: [] }];
  const capsule = await createAuthorityCapsule(f.scope, { data: f.page, receivedAt: now, receivedMonotonic: 0 }, action, '  Stop new use.\n<script>literal reason</script>  ', 'authority_review_original', now);
  return { ...f, capsule };
}
describe('accepted authority review and historical receipt presentation', () => {
  it.each(['PAUSE', 'REVOKE'] as const)('presents complete %s consequences and exact normalized reason without MFA or submit controls', async action => {
    const f = await fixture(action), html = render(createElement(MandateAuthorityReview, { capsule: f.capsule }));
    expect(html).toContain('Stop new use.\n&lt;script&gt;literal reason&lt;/script&gt;'); expect(html).not.toContain('<script>'); expect(html).toContain('Existing obligations and recorded activity remain'); expect(html).toContain('Accepted terms, mandate version and expiry stay unchanged'); expect(html).toContain('No multi-factor step is required'); expect(html).toContain('aria-expanded="false"'); expect(html).toContain('inert=""'); expect(html).not.toContain('<input'); expect(html).not.toContain('<textarea'); expect(html).not.toContain('Bearer'); expect(html).not.toContain(f.scope.sessionId);
  });
  it('distinguishes accepted mandate version from original and resulting head epochs', async () => {
    const f = await fixture(); const html = render(createElement(MandateAuthorityReview, { capsule: f.capsule })); expect(html).toContain('Version 2'); expect(html).toContain('ACTIVE · epoch 2'); expect(html).toContain('PAUSED · epoch 3'); expect(html).toContain(f.capsule.nextHead.expiresAt);
  });
  it('keeps a recorded stop historical after a later current authority observation', async () => {
    const f = await fixture(), locator = locatorFromAuthorityCapsule(f.capsule), receipt = qualifyAuthorityReceipt({ schemaVersion: 1, organizationId: f.scope.organizationId, kind: locator.kind, responsibilityId: f.scope.responsibilityId, target: locator.expectedTarget, commandHash: locator.commandHash, intentHash: locator.intentHash, observedAt: new Date(now).toISOString(), operation: { id: 'recorded_stop', environment: f.scope.environment, status: 'succeeded', aggregateId: locator.mandate.id, aggregateVersion: locator.expectedTarget.version, financialState: null, evidenceRefs: [], nextCheckAt: null, error: null } }, locator);
    f.page.head!.state = 'REVOKED'; f.page.head!.mandateEpoch = 10;
    const html = render(createElement(MandateAuthorityReceiptView, { receipt })); expect(html).toContain('Pause recorded'); expect(html).toContain('historical receipt'); expect(html).toContain('Check Current effective authority for the latest status.'); expect(html).not.toContain('Authority is active'); expect(f.page.head!.mandateEpoch).toBe(10);
  });
  it('places collection controls directly after current authority and before proposal history', async () => { const f = await fixture(), html = render(createElement(MandateCollectionContent, { page: f.page, now, organizationEpoch: 3, authorityControls: createElement('section', { 'aria-label': 'Bound current stop' }) })); expect(html.indexOf('Current effective authority')).toBeLessThan(html.indexOf('Bound current stop')); expect(html.indexOf('Bound current stop')).toBeLessThan(html.indexOf('Mandate proposals')); });
  it('places exact-review controls with current authority even when the selected proposal is historical', async () => { const f = await fixture(), html = render(createElement(MandateProposalContent, { review: f.review, now, organizationEpoch: 3, sites: f.session.sites, authorityControls: createElement('section', { 'aria-label': 'Bound current stop' }) })); expect(html.indexOf('Current effective authority')).toBeLessThan(html.indexOf('Bound current stop')); expect(html.indexOf('Bound current stop')).toBeLessThan(html.indexOf('Selected proposal')); expect(html).toContain('Current accepted mandate'); expect(html).toContain('Current accepted mandate policy.'); });
});


describe('authority RESUME presentation dispatch', () => {
  it('routes RESUME to the complete accepted review while preserving corrected historical receipt copy', async () => {
    const f = await decisionTestCase('AUTHORIZE'), review = structuredClone(f.outcomeReview), at = now + 2000;
    review.envelope.observedAt = new Date(at).toISOString(); review.envelope.head!.state = 'PAUSED'; review.envelope.head!.mandateEpoch = 2; review.effectiveAuthority = { state: 'PAUSED', blockers: ['AUTHORITY_PAUSED'] }; review.envelope.eligibility = [{ action: 'RESUME', eligible: true, requiresStepUp: true, blockers: [] }];
    const capsule = await createAuthorityCapsule(f.scope, { data: review, receivedAt: at, receivedMonotonic: 0 }, 'RESUME', 'Resume accepted advice.', 'resume_review_dispatch', at);
    const element = MandateAuthorityReview({ capsule }); expect(element.type).toBe(MandateResumeReview); expect(element.props.capsule).toBe(capsule);
    const html = render(element); expect(html).toContain('Accepted mandate policy'); expect(html).toContain('Accepted acceptance policy'); expect(html).not.toContain('No multi-factor step is required');
    const locator = locatorFromAuthorityCapsule(capsule), receipt = qualifyAuthorityReceipt({ schemaVersion: 1, organizationId: f.scope.organizationId, kind: locator.kind, responsibilityId: f.scope.responsibilityId, target: locator.expectedTarget, commandHash: locator.commandHash, intentHash: locator.intentHash, observedAt: new Date(at).toISOString(), operation: { id: 'recorded_resume', environment: f.scope.environment, status: 'succeeded', aggregateId: locator.mandate.id, aggregateVersion: locator.expectedTarget.version, financialState: null, evidenceRefs: [], nextCheckAt: null, error: null } }, locator);
    review.envelope.head!.state = 'REVOKED'; review.envelope.head!.mandateEpoch = 9;
    const receiptHtml = render(createElement(MandateAuthorityReceiptView, { receipt })); expect(receiptHtml).toContain('Resume recorded'); expect(receiptHtml).toContain('historical receipt'); expect(receiptHtml).toContain('Check Current effective authority for the latest status.'); expect(receiptHtml).not.toContain('Authority is active'); expect(review.envelope.head!.mandateEpoch).toBe(9);
  });
});
