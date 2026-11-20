import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LoadingState, WorkStateBadge } from './async-feedback';
import { ActionLabel } from './ui';

describe('truthful loading and pending feedback', () => {
  it('announces a request without simulated progress, focus targets or payment actions', () => {
    const html = renderToStaticMarkup(createElement(LoadingState, { label: 'Loading saved work', variant: 'detail' }));
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-hidden="true"');
    for (const text of ['aria-valuenow', 'role="progressbar"', 'aria-busy="true"', '<button', 'tabindex', 'Payment confirmed']) expect(html).not.toContain(text);
  });
  it('a connection wait does not impersonate an active request', () => {
    const html = renderToStaticMarkup(createElement(LoadingState, { label: 'Waiting for a connection', active: false, variant: 'list' }));
    expect(html).toContain('Waiting for a connection');
    expect(html).toContain('data-running="false"');
    expect(html).not.toContain('brand-loader');
  });
  it('keeps exact consent/amount wording as the label while reserves stay inaccessible', () => {
    const label = 'Approve 0.01 devnet USDC computation';
    const html = renderToStaticMarkup(createElement(ActionLabel, { label, reserve: [label, 'Confirming original approval…'], pending: false }));
    expect(html).toContain(`<span>${label}</span>`);
    expect(html).toContain('class="action-label-reserve" aria-hidden="true"');
    expect(html).toContain('data-pending="false"');
  });
  it.each(['queued', 'working', 'waiting', 'paused', 'cancelled', 'completed', 'needs_review'] as const)('labels %s without inventing execution', state => {
    const html = renderToStaticMarkup(createElement(WorkStateBadge, { state, label: state }));
    expect(html).toContain(`</span>${state}</span>`);
    expect(html).not.toContain('pending-mark');
  });
  it('stale observation never labels saved work as currently working or finished', () => {
    for (const state of ['working', 'completed'] as const) {
      const html = renderToStaticMarkup(createElement(WorkStateBadge, { state, label: state, stale: true }));
      expect(html).toContain('Last saved status');
      expect(html).not.toContain(`>${state}<`);
    }
  });
});
