import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AccessClosureReceipt, AccessClosureReview } from './access-closure-review';
import { MotionProvider } from './motion';
import type { AccessCloseReview } from '../lib/access-closure';
const review: AccessCloseReview = { version: 1, locator: { version: 2, kind: 'revise', key: 'original_key_123456789', userId: 'current_user', organizationId: 'provider_org', apiBase: 'https://api.example.test', environment: 'development', internalOrganizationId: 'internal_org', actorId: 'current_owner' }, scope: { userId: 'current_user', externalOrganizationId: 'provider_org', sessionId: 'private_session', apiBase: 'https://api.example.test', environment: 'development', organizationId: 'internal_org', actorId: 'current_owner', roles: ['owner'], siteIds: [], actionSiteIds: [] }, intent: { schemaVersion: 1, kind: 'revise', reason: 'original_input_unavailable', expectedEnvironment: 'development', expectedOrganizationId: 'internal_org', expectedActorId: 'current_owner', expectedExternalMembershipId: 'current_membership', expectedAuthorityEpoch: 9 }, observedAt: '2026-11-15T12:00:00.000Z', receivedAt: 1, receivedMonotonic: 1, sessionAuthorityEpoch: 8, integrityHash: 'a'.repeat(64) };
const render = (child: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(MotionProvider, { children: child }));
describe('native administrative closure review and distinct fence receipt', () => {
  it.each(['grant', 'revise', 'revoke'] as const)('renders the %s consequence and current authority without invented lost input or effect controls', kind => {
    const html = render(createElement(AccessClosureReview, { review: { ...review, locator: { ...review.locator, kind }, intent: { ...review.intent, kind } }, organizationName: 'Workshop & <script>alert(1)</script>' }));
    for (const text of ['The original input is unavailable.', 'if no operation has already been recorded', 'Closing does not undo that operation.', 'Current organization', 'Current verified owner', 'Current reviewer / provider membership', 'Authority epoch reviewed now', 'current_owner', 'current_membership', 'original_key_123456789', 'development']) expect(html).toContain(text);
    expect(html).toContain('Workshop &amp; &lt;script&gt;alert(1)&lt;/script&gt;'); expect(html).not.toContain('<script>');
    expect(html).toContain('aria-expanded="false"'); expect(html).toContain('inert="" aria-hidden="true"'); expect(html.match(/<button/g)).toHaveLength(1);
    for (const forbidden of ['<input', '<form', 'private_session', review.integrityHash, 'Close original request key', 'historical closer', 'Original target:']) expect(html).not.toContain(forbidden);
  });
  it('explicitly distinguishes v1 missing historical pins from the new current review', () => {
    const locator = { version: 1 as const, kind: review.locator.kind, key: review.locator.key, userId: review.locator.userId, organizationId: review.locator.organizationId, apiBase: review.locator.apiBase };
    const html = render(createElement(AccessClosureReview, { review: { ...review, locator }, organizationName: 'Workshop' }));
    expect(html).toContain('This older reference has no saved original actor or environment binding.'); expect(html).toContain('uses your currently verified organization and environment.'); expect(html).not.toContain('Saved actor:'); expect(html).not.toContain('Saved environment:');
  });
  it('shows the first fence time and audit identity without synthesizing an operation/member/closer', () => {
    const html = render(createElement(AccessClosureReceipt, { receipt: { id: 'fence_audit_one', kind: 'revoke', key: review.locator.key, closedAt: '2026-11-15T12:00:00.000Z' }, onDismiss: () => {} }));
    for (const text of ['Original request key closed', 'permanent block', 'fence_audit_one', 'First recorded closure time', '2026-11-15T12:00:00.000Z', 'Dismiss receipt']) expect(html).toContain(text);
    for (const forbidden of ['Operation', 'member version', 'current_membership', 'current_owner', 'private_session', 'Undo', 'Delete', 'Retry', '<a ']) expect(html).not.toContain(forbidden);
    expect(html.match(/<button/g)).toHaveLength(2);
  });
});
