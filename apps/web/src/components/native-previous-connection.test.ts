import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { NativePreviousConnection } from './native-previous-connection';

vi.mock('./ui', () => ({
  Alert: ({ title, children }: { title: string; children: ReactNode }) => createElement('section', null, createElement('h2', null, title), children),
  ActionLabel: ({ label }: { label: string }) => createElement('span', null, label),
}));

describe('previous work connection recovery notice', () => {
  it('explains the blocked new task and keeps the exact recovery reference in deliberate support details', () => {
    const html = renderToStaticMarkup(createElement(NativePreviousConnection, { requests: [{ kind: 'create', key: 'original_request_00001' }] }));
    const primary = html.replace(/<details\b[\s\S]*?<\/details>/g, '');
    expect(primary).toContain('An earlier task needs recovery');
    expect(primary).toContain('nothing has been resent');
    expect(primary).toContain('before starting another task');
    expect(primary).toContain('Copy support details');
    expect(primary).not.toContain('original_request_00001');
    expect(html).toContain('original_request_00001');
    expect(html).toContain('<details class="support-disclosure">');
    expect(html).not.toMatch(/Resend|Discard|Delete|Continue anyway/);
  });
  it('identifies reply recovery and exposes no automatic retry or connection-changing control', () => {
    const html = renderToStaticMarkup(createElement(NativePreviousConnection, { requests: [{ kind: 'reply', key: 'original_reply_00001', taskId: 'original_task_00001' }] }));
    expect(html).toContain('An earlier message needs recovery');
    expect(html).toContain('before sending another message to this task');
    expect(html).toContain('original_task_00001');
    expect(html).not.toContain('href=');
    expect(html.match(/<button/g)).toHaveLength(1); // Only the explicit support-copy control.
  });
});
