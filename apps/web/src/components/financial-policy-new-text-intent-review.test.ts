import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { FinancialPolicyNewTextIntentReview } from './financial-policy-new-text-intent-review';

describe('new-text acknowledgement presentation', () => {
  const props = () => ({ text: '<script>Exact local text</script>\nCafé', targetId: 'new_text', context: null, preparation: null,
    acknowledged: false, canAcknowledge: false, disabled: false, saving: false, onAcknowledge: vi.fn(), onSave: vi.fn() });
  it('keeps acknowledgement and refreshed save distinct and performs no action when rendered', () => {
    const p = props(), html = renderToStaticMarkup(createElement(FinancialPolicyNewTextIntentReview, p));
    expect(html).toContain('Acknowledge reviewed text &amp; checks'); expect(html).toContain('Refresh checks &amp; save reviewed text');
    expect(html.match(/disabled=""/g)).toHaveLength(2); expect(p.onAcknowledge).not.toHaveBeenCalled(); expect(p.onSave).not.toHaveBeenCalled();
  });
  it('permits an expired acknowledged action only as a request for fresh checks and shows only authored text', () => {
    const html = renderToStaticMarkup(createElement(FinancialPolicyNewTextIntentReview, { ...props(), acknowledged: true }));
    expect(html).toContain('The earlier checks expired'); expect(html).toContain('must check current access again');
    expect(html).toContain('&lt;script&gt;Exact local text&lt;/script&gt;'); expect(html).not.toContain('<script>');
    expect(html).not.toContain('Current checked access'); expect(html).not.toContain('digest');
    expect(html.match(/disabled=""/g)).toHaveLength(1); expect(html).toContain('No spending authority');
  });
  it('has stable reserved labels and immediate pending truth without a countdown or new movement', () => {
    const html = renderToStaticMarkup(createElement(FinancialPolicyNewTextIntentReview, { ...props(), disabled: true, saving: true }));
    expect(html).toContain('Refreshing checks &amp; saving'); expect(html).toContain('at most one save');
    expect(html).toContain('Refresh checks &amp; save reviewed text'); expect(html).not.toContain('seconds');
    expect(html.match(/disabled=""/g)).toHaveLength(2);
  });
});
