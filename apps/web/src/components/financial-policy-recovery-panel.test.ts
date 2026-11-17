import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { FinancialPolicyHttpReceiptSchema } from '@pactwoven/contracts';
import { FinancialPolicyReferenceSchema } from '../lib/financial-policy-contract';
import { financialClosureFixture } from '../lib/financial-policy-closure-test-support';
import { MotionProvider } from './motion';
import { FinancialPolicyRecoveryPanel, type FinancialPolicyRecoveryPanelProps, type FinancialPolicyRecoveryRow } from './financial-policy-recovery-panel';

const hash = 'a'.repeat(64);
const reference = FinancialPolicyReferenceSchema.parse({ schemaVersion: 1, scope: { environment: 'development', organizationId: 'org_a', actorId: 'owner_a',
  apiBase: 'https://api.example.test', responsibilityId: null }, locator: { responsibilityId: null, kind: 'save_document', key: 'original_policy_001', targetId: 'policy_a', publicRequestHash: hash } });
const receipt = FinancialPolicyHttpReceiptSchema.parse({ schemaVersion: 1, environment: 'development', organizationId: 'org_a', actor: { actorId: 'owner_a', membershipVersion: 1 },
  responsibilityId: null, operationId: '00000000-0000-0000-0000-000000000001', kind: 'save_document', key: reference.locator.key, publicRequestHash: hash,
  target: { id: 'policy_a', version: 1, recordHash: hash }, effectiveAuthority: false, financialState: null,
  record: { schemaVersion: 1, environment: 'development', organizationId: 'org_a', actor: { actorId: 'owner_a', membershipVersion: 1 }, responsibilityId: null,
    id: 'policy_a', version: 1, predecessor: null, organizationEpoch: 2, operationId: '00000000-0000-0000-0000-000000000001', createdAt: '2026-11-15T00:00:00.000Z',
    kind: 'document', purpose: 'budget_policy', text: 'Complete original text.', contentHash: hash } });
function props(state: FinancialPolicyRecoveryRow['state'] = 'unchecked', recorded = false): FinancialPolicyRecoveryPanelProps {
  return { rows: [{ reference, state, receipt: recorded ? receipt : null, message: 'Exact original status.' }], blocked: false, busy: false,
    onLookup: vi.fn(), onClear: vi.fn(), onRefresh: vi.fn() };
}
describe('financial-policy recovery panel server rendering', () => {
  it('renders unchecked references without calling lookup, clearing or refresh handlers', () => {
    const p = props(), html = renderToStaticMarkup(createElement(FinancialPolicyRecoveryPanel, p));
    expect(html).toContain('Check original result'); expect(html).toContain('Original unresolved'); expect(html).not.toContain('Clear this tab');
    expect(p.onLookup).not.toHaveBeenCalled(); expect(p.onClear).not.toHaveBeenCalled(); expect(p.onRefresh).not.toHaveBeenCalled();
  });
  it('shows immutable receipt and separate exact-reminder clear without claiming currentness', () => {
    const html = renderToStaticMarkup(createElement(FinancialPolicyRecoveryPanel, props('recorded', true)));
    expect(html).toContain('Complete original text.'); expect(html).toContain('Clear this tab'); expect(html).toContain('Original recorded');
    expect(html).toContain('does not describe today'); expect(html).toContain('membership version 1');
  });
  it('retains the receipt and position after settlement while removing further reminder actions', () => {
    const html = renderToStaticMarkup(createElement(FinancialPolicyRecoveryPanel, props('cleared', true)));
    expect(html).toContain('Reminder cleared'); expect(html).toContain('Complete original text.'); expect(html).not.toContain('Check original result');
  });
  it.each(['checking', 'clearing'])('disables controls with stable labels while %s', state => {
    const p = { ...props(state as 'checking' | 'clearing', state === 'clearing'), busy: true };
    const html = renderToStaticMarkup(createElement(FinancialPolicyRecoveryPanel, p));
    expect(html).toContain('disabled=""'); expect(html).toContain('action-label-reserve'); expect(html).toContain('aria-hidden="true"');
  });
  it('keeps corrupt-storage and empty states explicit without false original failure', () => {
    const p = { ...props(), rows: [], blocked: true };
    expect(renderToStaticMarkup(createElement(FinancialPolicyRecoveryPanel, p))).toContain('Originals are preserved');
    expect(renderToStaticMarkup(createElement(FinancialPolicyRecoveryPanel, { ...p, blocked: false }))).toContain('No saved financial-policy references');
  });
  it('shows the distinct immutable closure before its separate clear control, with focusable result and expandable historical pins', async () => {
    const closure = await financialClosureFixture(reference, { environment: 'development', organizationId: 'org_a', actor: { actorId: 'owner_a', membershipVersion: 1 }, organizationEpoch: 0, draftScope: null });
    const p = props('closed'); p.rows = [{ ...p.rows[0]!, closure }];
    const html = renderToStaticMarkup(createElement(MotionProvider, null, createElement(FinancialPolicyRecoveryPanel, p)));
    expect(html).toContain('Original closed'); expect(html).toContain('not a policy receipt');
    expect(html).toContain(`id="financial-policy-closure-${reference.locator.publicRequestHash}" tabindex="-1"`);
    expect(html.indexOf('Original request permanently closed')).toBeLessThan(html.indexOf('Clear this tab'));
    expect(html).toContain('Historical access and basis details'); expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('class="disclosure-clip" inert="" aria-hidden="true"'); expect(html).toContain('membership version 1');
    expect(p.onClear).not.toHaveBeenCalled(); expect(p.onLookup).not.toHaveBeenCalled();
  });
  it('requires the separate live review before showing an enabled close action and exposes no receipt clear', () => {
    const p = props('not-recorded'); p.onReviewClosure = vi.fn(); p.canReviewClosure = () => true;
    const before = renderToStaticMarkup(createElement(FinancialPolicyRecoveryPanel, p));
    expect(before).toContain('Review original request closure'); expect(before).not.toContain('Close original request</span>');
    p.rows = [{ ...p.rows[0]!, closureReview: { reference, expiresAt: Date.parse('2026-11-15T00:00:19Z'), request: {
      schemaVersion: 1, purpose: 'financial_policy_original_close', reason: 'original_input_unavailable', locator: { ...reference.locator, kind: 'save_document' },
      expected: { environment: 'development', organizationId: 'org_a', actor: { actorId: 'owner_a', membershipVersion: 5 }, organizationEpoch: 2, draftScope: null } } } }];
    p.closureReviewCurrent = () => false; p.onCloseOriginal = vi.fn();
    const html = renderToStaticMarkup(createElement(MotionProvider, null, createElement(FinancialPolicyRecoveryPanel, p)));
    expect(html).toContain('permanently prevents this original key'); expect(html).toContain('Reviewed access and basis details');
    expect(html).toContain('Close original request'); expect(html).toContain('disabled=""'); expect(html).not.toContain('Clear this tab');
    expect(p.onReviewClosure).not.toHaveBeenCalled(); expect(p.onCloseOriginal).not.toHaveBeenCalled();
  });
});
