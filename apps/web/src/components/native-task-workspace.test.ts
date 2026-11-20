import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { nativeSessionFixture, nativeTaskFixture } from '../lib/native-tasks.test-fixtures';
import { NativeTaskContent, NativeTaskText } from './native-task-workspace';

vi.mock('./workspace-provider', () => ({ useWorkspace: () => { throw Error('Authenticated wrapper is not mounted in view tests.'); } }));
vi.mock('./native-task-hooks', () => ({ useNativeTask: () => { throw Error('Polling is not mounted in view tests.'); }, useTaskLifetime: () => { throw Error('Mutations are not mounted in view tests.'); } }));
vi.mock('./ui', () => ({ Alert: ({ children }: { children: unknown }) => createElement('div', null, children as never), LoadingState: () => null, StatusBadge: ({ children }: { children: unknown }) => createElement('span', null, children as never) }));

function render() { return renderToStaticMarkup(createElement(NativeTaskContent, { task: nativeTaskFixture(), session: nativeSessionFixture() })); }
describe('real task presentation', () => {
  it('shows actual work, uncertainty and sources without internal record names', () => {
    const html = render();
    expect(html).toContain('Delivery dates still need confirmation.');
    expect(html).toContain('Comparison started');
    expect(html).toContain('Chicago office');
    expect(html).toContain('https://example.com/chair');
    expect(html).toContain('Research');
    expect(html).toContain('Planning');
    expect(html).not.toMatch(/task_long_internal|message_internal|step_internal|artifact_internal|site_one|company_one/);
    expect(html).not.toMatch(/gpt-|worker|leaseToken|Watch live|Place order/);
  });
  it('does not invent a team, plan, artifacts or browser view for a newly queued task', () => {
    const task = { ...nativeTaskFixture(), status: 'queued' as const, steps: [], events: [], artifacts: [], messages: [] };
    const html = renderToStaticMarkup(createElement(NativeTaskContent, { task, session: nativeSessionFixture() }));
    expect(html).toContain('The plan will appear when work begins.');
    expect(html).toContain('Compare these office chairs.');
    expect(html).not.toContain('Working together');
    expect(html).not.toContain('native-artifact-heading');
    expect(html).not.toContain('<iframe');
  });
  it('leads completed work with the full result and keeps the conversation and supporting work available in disclosures', () => {
    const task = { ...nativeTaskFixture(), status: 'completed' as const };
    const html = renderToStaticMarkup(createElement(NativeTaskContent, { task, session: nativeSessionFixture() }));
    expect(html.indexOf('native-final-result')).toBeLessThan(html.indexOf('native-conversation-section'));
    expect(html).toContain('Your result');
    expect(html).toContain('Delivery dates still need confirmation.');
    expect(html).toContain('<details class="native-task-disclosure native-section-disclosure">');
    expect(html).toContain('Compare these office chairs.');
    expect(html).toContain('https://example.com/chair');
  });
  it('escapes untrusted model and user text instead of interpreting HTML', () => {
    const html = renderToStaticMarkup(createElement(NativeTaskText, { text: '<script>secret()</script>\n\n<img src=x onerror=secret()>\n\n## Findings\n\n- First fact\n- Second fact' }));
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).toContain('<h3>Findings</h3>');
    expect(html).toContain('<li>First fact</li>');
  });
  it('shows completed and current specialist states directly from saved steps', () => {
    const html = render();
    expect(html).toContain('data-state="completed"');
    expect(html).toContain('data-state="working"');
    expect(html).toContain('Research · Done');
    expect(html).toContain('Planning · Working');
  });
});
