import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nativeSessionFixture, nativeTaskResponseFixture } from '../lib/native-tasks.test-fixtures';
import { RequestError } from '../lib/api';
import { createTaskAttempt, createTaskReplyAttempt, storeTaskAttempt, taskAttemptScope } from '../lib/native-tasks';
import { NativeTaskComposer } from './native-task-composer';
import { NativeTaskWorkspace } from './native-task-workspace';
import { NativePreviousConnection } from './native-previous-connection';

// Offline interaction harness: real recovery helpers and components, simulated
// React hooks and query/router boundaries. This is not browser qualification.
const h = vi.hoisted(() => ({ active: null as any, workspace: null as any, query: null as any,
  token: vi.fn(async () => 'token'), fetch: vi.fn(), client: { setQueryData: vi.fn(), invalidateQueries: vi.fn() },
  lifetime: { live: { current: true }, controller: { current: null as AbortController | null } },
}));
vi.mock('react', async original => ({ ...(await original<any>()),
  useState: (initial: any) => { const f = h.active, i = f.cursor++; if (!(i in f.cells)) f.cells[i] = typeof initial === 'function' ? initial() : initial;
    return [f.cells[i], (next: any) => { f.cells[i] = typeof next === 'function' ? next(f.cells[i]) : next; }]; },
  useRef: (initial: any) => { const f = h.active, i = f.cursor++; return f.cells[i] ?? (f.cells[i] = { current: initial }); },
  useId: () => 'test-field',
  useEffect: (callback: any, deps: any[]) => { const f = h.active, i = f.cursor++, prior = f.cells[i];
    if (!prior || deps.some((value, index) => !Object.is(value, prior.deps[index]))) { f.cells[i] = { deps }; f.effects.push(callback); } },
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => h.client }));
vi.mock('./workspace-provider', () => ({ useWorkspace: () => h.workspace }));
vi.mock('./native-task-hooks', () => ({ useNativeTask: () => h.query, useTaskLifetime: () => h.lifetime }));
vi.mock('./ui', () => ({ Alert: 'Alert', LoadingState: 'LoadingState', StatusBadge: 'StatusBadge', ActionLabel: 'ActionLabel' }));

function storage() { const data = new Map<string, string>(); return { data, get length() { return data.size; }, key: (index: number) => [...data.keys()][index] ?? null,
  getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } }; }
function mount(element: ReactElement) {
  const frame = { cursor: 0, cells: [] as any[], effects: [] as (() => unknown)[] };
  const render = () => { frame.cursor = 0; frame.effects = []; h.active = frame; return (element.type as (props: any) => ReactElement)(element.props); };
  let tree = render(); frame.effects.forEach(effect => effect()); tree = render();
  return { get tree() { return tree; }, render: () => { tree = render(); return tree; } };
}
function elements(value: any): any[] { if (Array.isArray(value)) return value.flatMap(elements); if (!value || typeof value !== 'object' || !('type' in value)) return []; return [value, ...elements(value.props.children)]; }
beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', 'https://old-native.example.test'); vi.stubEnv('NEXT_PUBLIC_NATIVE_API_BASE_URL', undefined);
  h.token.mockClear(); h.fetch.mockClear(); h.workspace = { session: nativeSessionFixture(), getToken: h.token, drafts: new Map() };
  h.query = { data: nativeTaskResponseFixture(), error: null, observing: true, isFetching: false, refetch: vi.fn() };
  vi.stubGlobal('fetch', h.fetch);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); h.active = null; });

describe('actual create and reply controls after a work connection change', () => {
  it('disables fresh creation and rejects a programmatic submit while preserving the original request', () => {
    const store = storage(), scope = taskAttemptScope(h.workspace.session);
    const original = createTaskAttempt(scope, { prompt: 'Original task outcome.', siteId: 'site_one', mode: 'advise' }); storeTaskAttempt(store, original);
    vi.stubGlobal('window', { sessionStorage: store }); vi.stubEnv('NEXT_PUBLIC_NATIVE_API_BASE_URL', 'https://new-native.example.test');
    const view = mount(NativeTaskComposer({}));
    let nodes = elements(view.tree);
    expect(nodes.find(node => node.type === NativePreviousConnection)?.props.requests).toEqual([{ kind: 'create', key: original.key }]);
    expect(nodes.find(node => node.type === 'button' && node.props.type === 'submit')?.props.disabled).toBe(true);
    nodes.find(node => node.type === 'textarea').props.onChange({ target: { value: 'Programmatic duplicate.' } }); view.render(); nodes = elements(view.tree);
    nodes.find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
    expect(h.token).not.toHaveBeenCalled(); expect(h.fetch).not.toHaveBeenCalled(); expect(store.data.size).toBe(1);
    expect([...store.data.values()]).toEqual([JSON.stringify(original)]);
  });

  it('blocks a new reply to the affected task while preserving readable work and its original reply', () => {
    const store = storage(), scope = taskAttemptScope(h.workspace.session), taskId = h.query.data.task.id;
    const original = createTaskReplyAttempt(scope, taskId, { text: 'Original reply.', expectedVersion: 3 }); storeTaskAttempt(store, original);
    vi.stubGlobal('window', { sessionStorage: store }); vi.stubEnv('NEXT_PUBLIC_NATIVE_API_BASE_URL', 'https://new-native.example.test');
    const view = mount(NativeTaskWorkspace({ id: taskId })); let nodes = elements(view.tree);
    expect(nodes.find(node => node.type === NativePreviousConnection)?.props.requests).toEqual([{ kind: 'reply', key: original.key, taskId }]);
    expect(nodes.find(node => node.type === 'button' && node.props.type === 'submit')?.props.disabled).toBe(true);
    nodes.find(node => node.type === 'textarea').props.onChange({ target: { value: 'Programmatic duplicate reply.' } }); view.render(); nodes = elements(view.tree);
    nodes.find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
    expect(h.token).not.toHaveBeenCalled(); expect(h.fetch).not.toHaveBeenCalled(); expect(store.data.size).toBe(1);
    expect([...store.data.values()]).toEqual([JSON.stringify(original)]);
    expect(nodes.some(node => node.type === 'h1' && node.props.children === h.query.data.task.title)).toBe(true);
  });

  it('keeps prior-connection recovery visible when the task is absent from the newly configured service', () => {
    const store = storage(), scope = taskAttemptScope(h.workspace.session), taskId = h.query.data.task.id;
    const original = createTaskReplyAttempt(scope, taskId, { text: 'Original reply.', expectedVersion: 3 }); storeTaskAttempt(store, original);
    h.query = { ...h.query, data: undefined, error: new RequestError('NOT_FOUND', 'Not available', 404) };
    vi.stubGlobal('window', { sessionStorage: store }); vi.stubEnv('NEXT_PUBLIC_NATIVE_API_BASE_URL', 'https://new-native.example.test');
    const view = mount(NativeTaskWorkspace({ id: taskId })), nodes = elements(view.tree);
    expect(nodes.find(node => node.type === NativePreviousConnection)?.props.requests).toEqual([{ kind: 'reply', key: original.key, taskId }]);
    expect(nodes.some(node => node.type === 'form')).toBe(false);
    expect(h.token).not.toHaveBeenCalled(); expect(h.fetch).not.toHaveBeenCalled();
    expect([...store.data.values()]).toEqual([JSON.stringify(original)]);
  });
});
