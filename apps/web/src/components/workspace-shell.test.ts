import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nativeSessionFixture } from '../lib/native-tasks.test-fixtures';
import { WorkspaceShell } from './workspace-shell';
import { MotionProvider } from './motion';

const state = vi.hoisted(() => ({ session: null as any, path: '/app/work' }));
vi.mock('next/navigation', () => ({ usePathname: () => state.path }));
vi.mock('@clerk/nextjs', () => ({ UserButton: () => null }));
vi.mock('./workspace-provider', () => ({ useWorkspace: () => ({ session: state.session }),
  canReadResponsibilities: (session: any) => session.actor.roles.some((role: string) => ['owner', 'operations', 'finance', 'receiver', 'auditor'].includes(role)) }));
const render = () => renderToStaticMarkup(createElement(MotionProvider, null, createElement(WorkspaceShell, null, 'Protected page content')));
beforeEach(() => { state.session = nativeSessionFixture(); state.path = '/app/work'; });
describe('workspace layout access and navigation', () => {
  it('starts with labelled navigation, a current destination and optional details', () => {
    const html = render();
    expect(html).toContain('data-sidebar="expanded"');
    expect(html).toContain('aria-label="Collapse sidebar"');
    expect(html.match(/<a[^>]*aria-current="page"[^>]*>/)?.[0]).toContain('href="/app/work"');
    expect(html).toContain('Protected page content');
    expect(html).toContain('aria-controls="workspace-context"');
    expect(html).not.toContain('id="workspace-context"');
  });
  it('keeps support accounts out of work and management destinations', () => {
    state.session.actor.roles = ['support']; state.session.actor.siteIds = []; state.session.sites = [];
    const html = render();
    expect(html).not.toContain('Protected page content');
    for (const path of ['/app/work', '/app/memory', '/app/settings/connections/google']) expect(html).not.toContain(`href="${path}"`);
    expect(html).not.toContain('href="/app/organization"');
    expect(html).toContain('href="/app/organization/security"');
    expect(html).toContain('This page is outside your role.');
  });
  it('preserves separate memory and calendar access rules', () => {
    state.session.actor.roles = ['receiver']; state.path = '/app/settings/connections/google';
    expect(render()).not.toContain('Protected page content');
    state.path = '/app/memory';
    expect(render()).toContain('Protected page content');
    state.session.actor.principalKind = 'service';
    expect(render()).not.toContain('Protected page content');
  });
  it('uses readable section labels instead of route identifiers', () => {
    state.path = '/app/work/team/abc-123-private-id';
    const html = render(); expect(html).not.toContain('abc-123-private-id');
    expect(html).toContain('<span>Work</span>');
  });
});
