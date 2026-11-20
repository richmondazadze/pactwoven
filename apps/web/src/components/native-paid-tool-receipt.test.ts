import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { paidToolFixture } from '../lib/native-paid-tool.test-fixtures';
import { NativePaidToolReceipt } from './native-paid-tool-receipt';

describe('dedicated paid-tool receipt', () => {
  it('renders a structured result and exact receipt without internal identifiers or automatic effects', () => {
    const view = paidToolFixture(), onAction = vi.fn(), html = renderToStaticMarkup(createElement(NativePaidToolReceipt, { view, onAction }));
    expect(html).toContain('$500.00'); expect(html).toContain('0.01 devnet USDC'); expect(html).toContain('Seats'); expect(html).toContain('7 packages compared');
    expect(html).toContain(view.asset.mint); expect(html).toContain(view.recipient.tokenAccount);
    expect(html).toContain('?cluster=devnet'); expect(html).toContain('noopener noreferrer');
    expect(html).not.toContain('hidden-'); expect(html).not.toContain(view.delivery!.result.requestHash); expect(onAction).not.toHaveBeenCalled();
    expect(html).toContain('Not yet verified'); expect(html).not.toContain('0 test SOL');
  });
  it('shows no controls without a handler and never offers approve/pay', () => {
    const html = renderToStaticMarkup(createElement(NativePaidToolReceipt, { view: paidToolFixture() }));
    expect(html).not.toContain('<button'); expect(html).not.toContain('Approve payment'); expect(html).not.toContain('Pay now');
  });
  it('keeps unknown outcomes and finalized payment separate from delivery', () => {
    for (const state of ['outcome_unknown', 'payment_confirmed'] as const) {
      const view = { ...paidToolFixture(), state, delivery: null, statusText: state === 'outcome_unknown' ? 'Outcome unknown' : 'Payment finalized; waiting for the service' };
      const html = renderToStaticMarkup(createElement(NativePaidToolReceipt, { view }));
      expect(html).not.toContain('Sample equipment estimate');
      expect(html).toContain(state === 'outcome_unknown' ? 'do not start another payment' : 'has not been delivered yet');
    }
  });
  it('labels historical output and withholds unavailable output even if supplied by a faulty caller', () => {
    const view = paidToolFixture();
    expect(renderToStaticMarkup(createElement(NativePaidToolReceipt, { view: { ...view, resultApplicability: 'historical' } }))).toContain('has not been adopted into the current work');
    const unavailable = renderToStaticMarkup(createElement(NativePaidToolReceipt, { view: { ...view, resultApplicability: 'unavailable' } }));
    expect(unavailable).not.toContain('$500.00'); expect(unavailable).toContain('payment receipt is retained');
  });
  it('preserves check after permission expiry and revocation', () => {
    const view = { ...paidToolFixture(), permissionExpiresAt: '2020-01-01T00:00:00Z', revokedAt: '2020-01-01T00:00:00Z' };
    const html = renderToStaticMarkup(createElement(NativePaidToolReceipt, { view, onAction: () => {} }));
    expect(html).toContain('Check payment and delivery'); expect(html).not.toContain('disabled');
  });
  it('states that no feasible package is a delivered computation, not a payment failure', () => {
    const view = paidToolFixture(); Object.assign(view.delivery!.result, { status: 'no_feasible_package', selectedOfferIds: [], totalMinor: null, supplied: null });
    const html = renderToStaticMarkup(createElement(NativePaidToolReceipt, { view }));
    expect(html).toContain('completed computation, not a failed payment'); expect(html).not.toContain('Sample equipment estimate');
  });
});
