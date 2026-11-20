import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { OperationSchema } from '@pactwoven/contracts';
import { describe, expect, it, vi } from 'vitest';
import { RequestError } from '../lib/api';
import { ResponsibilitySaveFeedback, ResponsibilitySaveFooter } from './responsibility-save-feedback';
import { SupportDetails } from './support-details';

vi.mock('./ui', () => ({
  Alert: ({ title, children }: { title: string; children: ReactNode }) => createElement('section', null, createElement('h2', null, title), children),
  ActionLabel: ({ label }: { label: string }) => createElement('span', null, label),
}));

const operation = (status: 'accepted' | 'pending' | 'unknown' | 'failed' | 'succeeded') => OperationSchema.parse({
  id: 'operation_original_001', environment: 'development', status, aggregateId: 'record_original_001',
  aggregateVersion: 1, financialState: null, evidenceRefs: [], nextCheckAt: null, error: null,
});
const requestKey = 'request_original_001';
const primary = (html: string) => html.replace(/<details\b[\s\S]*?<\/details>/g, '');

describe('save confirmation and explicit support details', () => {
  it('keeps exact references in a closed disclosure and excludes untrusted errors from the entire view', () => {
    const html = renderToStaticMarkup(createElement(SupportDetails, {
      context: 'record-create', error: new RequestError('NETWORK_UNAVAILABLE', 'private backend message', 503, 'correlation_original_001', { secretField: ['private payload'] }),
      references: { requestId: requestKey, operationId: 'operation_original_001' },
    }));
    expect(html).toContain('Copy support details');
    expect(html).toContain('<details class="support-disclosure">');
    expect(html).toContain('<summary>Support details');
    for (const reference of [requestKey, 'operation_original_001', 'correlation_original_001']) {
      expect(html).toContain(reference);
      expect(primary(html)).not.toContain(reference);
    }
    expect(html).not.toMatch(/private backend message|secretField|private payload/);
  });

  it('keeps an uncertain request checkable after access denial without saying it was never saved', () => {
    const html = renderToStaticMarkup(createElement(ResponsibilitySaveFeedback, {
      error: new RequestError('FORBIDDEN', 'private rejection', 403), requestKey, operation: null, busy: false, onCheck: () => {},
    }));
    expect(primary(html)).toContain('Saving needs confirmation');
    expect(primary(html)).toContain('current workspace access');
    expect(primary(html)).toContain('Check saved draft');
    expect(primary(html)).not.toContain('The draft was not saved');
    expect(html).not.toContain('private rejection');
    expect(primary(html)).not.toContain(requestKey);
    expect(html).toContain(requestKey);
  });

  it('permits a rejected initial draft to return to editing without offering a nonexistent original request', () => {
    const html = renderToStaticMarkup(createElement(ResponsibilitySaveFeedback, {
      error: new RequestError('VALIDATION_FAILED', 'private field', 422), requestKey: null, operation: null, busy: false, onCheck: () => {},
    }));
    expect(primary(html)).toContain('The draft was not saved');
    expect(primary(html)).not.toContain('Check saved draft');
    const footer = renderToStaticMarkup(createElement(ResponsibilitySaveFooter, { operation: null, requestKey: null, busy: false, locked: false, dirty: true }));
    expect(footer).toContain('Save draft');
    expect(footer).not.toContain('disabled');
  });

  it('shows observed pending, unknown and failed outcomes without implying navigation or a successful save', () => {
    for (const status of ['accepted', 'pending', 'unknown', 'failed'] as const) {
      const observed = operation(status);
      const feedback = renderToStaticMarkup(createElement(ResponsibilitySaveFeedback, { error: null, requestKey, operation: observed, busy: false, onCheck: () => {} }));
      const footer = renderToStaticMarkup(createElement(ResponsibilitySaveFooter, { operation: observed, requestKey, busy: false, locked: true, dirty: true }));
      expect(primary(feedback)).toContain('Check saved draft');
      expect(feedback).toContain(observed.id);
      expect(primary(feedback)).not.toContain(observed.id);
      expect(footer).toContain('disabled=""');
      expect(footer).not.toMatch(/Opening record|Draft saved|Unsaved changes/);
      expect(footer).not.toContain(requestKey);
    }
  });

  it('only announces opening the record after an observed successful save', () => {
    const html = renderToStaticMarkup(createElement(ResponsibilitySaveFooter, { operation: operation('succeeded'), requestKey, busy: false, locked: true, dirty: true }));
    expect(html).toContain('Draft saved');
    expect(html).toContain('Opening record…');
    expect(html).not.toContain('Unsaved changes');
  });

  it('keeps duplicate checks disabled while the original request is in flight', () => {
    const html = renderToStaticMarkup(createElement(ResponsibilitySaveFeedback, { error: null, requestKey, operation: operation('pending'), busy: true, onCheck: () => {} }));
    expect(html).toContain('disabled="">Check saved draft</button>');
    const footer = renderToStaticMarkup(createElement(ResponsibilitySaveFooter, { operation: operation('pending'), requestKey, busy: true, locked: true, dirty: true }));
    expect(footer).toContain('aria-busy="true"');
    expect(footer).toContain('Saving draft…');
    expect(footer).not.toContain('Opening record');
  });
});
