import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NativeTaskComposer } from './native-task-composer';
import { NativeTaskWorkspace } from './native-task-workspace';

vi.mock('./workspace-provider', () => ({ useWorkspace: () => { throw Error('The connected workspace must not mount without a configured native service.'); } }));
vi.mock('./native-task-hooks', () => ({ useNativeTask: () => { throw Error('Observation must not start.'); }, useTaskLifetime: () => { throw Error('Request effects must not start.'); } }));
vi.mock('./ui', () => ({
  Alert: ({ title, children }: { title: string; children: ReactNode }) => createElement('section', null, createElement('h2', null, title), children),
  LoadingState: () => null, StatusBadge: () => null,
}));
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('native service availability presentation', () => {
  it('renders an actionable service-unavailable state for invalid explicit configuration while retaining saved recovery', () => {
    vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', 'https://foundation.example.test');
    vi.stubEnv('NEXT_PUBLIC_NATIVE_API_BASE_URL', 'http://unsafe-native.example.test');
    const storage = { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn(), clear: vi.fn() };
    vi.stubGlobal('sessionStorage', storage);
    for (const view of [createElement(NativeTaskComposer), createElement(NativeTaskWorkspace, { id: 'task_001' })]) {
      const html = renderToStaticMarkup(view);
      expect(html).toContain('The work service is not connected');
      expect(html).toContain('Your saved requests remain in this tab.');
      expect(html).toContain('service connection is restored');
      expect(html).not.toMatch(/unsafe-native|foundation\.example|Start work|Send message/);
    }
    expect(storage.removeItem).not.toHaveBeenCalled();
    expect(storage.clear).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('does not crash a work view when both native and legacy hosts are unconfigured', () => {
    vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', undefined);
    vi.stubEnv('NEXT_PUBLIC_NATIVE_API_BASE_URL', undefined);
    expect(renderToStaticMarkup(createElement(NativeTaskComposer))).toContain('Your existing work records are still available.');
    expect(renderToStaticMarkup(createElement(NativeTaskWorkspace, { id: 'task_001' }))).toContain('The work service is not connected');
  });
});
