import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ReadableText, ReadingRegion } from './readable-content';

describe('readable supporting content', () => {
  it('keeps short text whole without an unnecessary disclosure', () => {
    const text = 'Keep a ten-minute break after the first workshop session.';
    const html = renderToStaticMarkup(createElement(ReadableText, { text }));
    expect(html).toContain(text);
    expect(html).not.toContain('<details');
  });
  it('retains every character of long untrusted text in a closed, named disclosure', () => {
    const text = 'A clear preparation step. '.repeat(100) + '<script>doNotRun()</script>\nFINAL RECORD';
    const html = renderToStaticMarkup(createElement(ReadableText, { text, label: 'Read original request' }));
    expect(html).toContain('Read original request');
    expect(html).toContain(text.replace('<script>', '&lt;script&gt;').replace('</script>', '&lt;/script&gt;'));
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<details open');
  });
  it('renders full supporting records without inventing actions or loading-time clipping', () => {
    const html = renderToStaticMarkup(createElement(ReadingRegion, { label: 'Saved result', children: 'Exact retained result: 0.01 devnet USDC.' }));
    expect(html).toContain('Exact retained result: 0.01 devnet USDC.');
    expect(html).not.toContain('hidden');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('tabindex');
  });
});
