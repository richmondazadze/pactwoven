import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { FinancialPolicyDocumentEditor, reviewFinancialPolicyDocument } from './financial-policy-document-editor';

describe('full user-entered financial policy text', () => {
  it('normalizes only at explicit review and preserves the exact resulting text', () => {
    expect(reviewFinancialPolicyDocument('Cafe\u0301\r\nFull terms\rEnd')).toEqual({ text: 'Café\nFull terms\nEnd', changed: true });
    expect(reviewFinancialPolicyDocument('Café\nFull terms')).toEqual({ text: 'Café\nFull terms', changed: false });
  });
  it('supports the full 20,000-codepoint and 40,000-UTF-16-unit boundary', () => {
    const value = '🧵'.repeat(20000); expect(value.length).toBe(40000); expect(reviewFinancialPolicyDocument(value).text).toBe(value);
    expect(() => reviewFinancialPolicyDocument(value + 'a')).toThrow();
  });
  it.each(['', ' \n\t', 'x\u0000', 'x\u000b', 'x\u007f', 'x\ud800', 'x\udfff', 'a'.repeat(20001)])('rejects unsupported local input %#', text => {
    expect(() => reviewFinancialPolicyDocument(text)).toThrow();
  });
  it('renders all escaped reviewed terms with explicit review and no automatic action', () => {
    const onChange = vi.fn(), onReview = vi.fn(), text = '<script>private terms</script>\n' + '🧵'.repeat(19950);
    const html = renderToStaticMarkup(createElement(FinancialPolicyDocumentEditor, { text, reviewed: text, disabled: false, error: null, onChange, onReview }));
    expect(html).toContain('&lt;script&gt;private terms&lt;/script&gt;'); expect(html).not.toContain('<script>private');
    expect(html.split('🧵').length - 1).toBe(39900); expect(html).toContain('maxLength="40000"');
    expect(html).toContain('Review exact text'); expect(onChange).not.toHaveBeenCalled(); expect(onReview).not.toHaveBeenCalled();
  });
});
