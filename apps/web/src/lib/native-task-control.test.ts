import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NativeTask, NativeTaskControl } from '@pactwoven/contracts';
import { RequestError } from './api';
import { canRetryNativeControl, executeNativeControl, nativeControlContext, nativeControlWasRejected } from './native-task-control';
import { nativeSessionFixture, nativeTaskFixture, nativeTaskResponseFixture } from './native-tasks.test-fixtures';

const conflict = () => new RequestError('VERSION_CONFLICT', 'Task changed', 409);
function progress() {
  const task = nativeTaskFixture();
  task.version++;
  task.events.push({ ...task.events[1]!, sequence: 3, title: 'More agent progress' });
  return task;
}
const response = (task: NativeTask) => ({ ...nativeTaskResponseFixture(), task });
afterEach(() => vi.unstubAllEnvs());

describe('bounded task control recovery', () => {
  it.each(['pause', 'cancel'] as const)('retries %s once at the freshly observed version after agent progress', async action => {
    const newer = progress();
    const final = response({ ...newer, version: 5, status: action === 'pause' ? 'paused' : 'cancelled' });
    const send = vi.fn(async (_command: NativeTaskControl, dispatch: () => void) => { dispatch(); if (send.mock.calls.length === 1) throw conflict(); return final; });
    const read = vi.fn(async () => response(newer));
    expect(await executeNativeControl({ action, task: nativeTaskFixture(), send, read, assertCurrent() {} })).toEqual({ kind: 'confirmed', response: final });
    expect(send.mock.calls.map(call => call[0])).toEqual([{ action, expectedVersion: 3 }, { action, expectedVersion: 4 }]);
    expect(read).toHaveBeenCalledTimes(1);
  });
  it('stops after a second conflict and reports definite rejection', async () => {
    const send = vi.fn(async (_command, dispatch) => { dispatch(); throw conflict(); });
    const read = vi.fn(async () => response(progress()));
    const result = await executeNativeControl({ action: 'pause', task: nativeTaskFixture(), send, read, assertCurrent() {} });
    expect(result.kind).toBe('rejected'); expect(send).toHaveBeenCalledTimes(2); expect(read).toHaveBeenCalledTimes(1);
  });
  it('recovers a known local pre-dispatch task change using the same single retry budget', async () => {
    const send = vi.fn(async (_command, dispatch) => {
      if (send.mock.calls.length === 1) throw new RequestError('TASK_CHANGED', 'Newer poll', 409);
      dispatch(); return response({ ...progress(), version: 5, status: 'paused' });
    });
    const read = vi.fn(async () => response(progress()));
    expect((await executeNativeControl({ action: 'pause', task: nativeTaskFixture(), send, read, assertCurrent() {} })).kind).toBe('confirmed');
    expect(send.mock.calls.map(call => call[0].expectedVersion)).toEqual([3, 4]);
    expect(read).toHaveBeenCalledTimes(1);
  });
  it('does not treat a dispatched TASK_CHANGED response as a known local rejection', async () => {
    const send = vi.fn(async (_command, dispatch) => { dispatch(); throw new RequestError('TASK_CHANGED', 'Unknown server response', 409); });
    const read = vi.fn();
    expect((await executeNativeControl({ action: 'pause', task: nativeTaskFixture(), send, read, assertCurrent() {} })).kind).toBe('unknown');
    expect(read).not.toHaveBeenCalled(); expect(send).toHaveBeenCalledTimes(1);
  });
  it('never automatically retries resume', async () => {
    const send = vi.fn(async (_command, dispatch) => { dispatch(); throw conflict(); });
    const read = vi.fn();
    expect((await executeNativeControl({ action: 'resume', task: { ...nativeTaskFixture(), status: 'paused', availableActions: ['resume'] }, send, read, assertCurrent() {} })).kind).toBe('rejected');
    expect(send).toHaveBeenCalledTimes(1); expect(read).not.toHaveBeenCalled();
  });
  it.each([
    new RequestError('NETWORK_UNAVAILABLE', 'Lost response'),
    new RequestError('RESPONSE_UNVERIFIED', 'Invalid response'),
    new RequestError('DURABLE_SERVICE_UNAVAILABLE', 'Service unavailable', 503),
    new RequestError('REQUEST_FAILED', 'Unrecognized error', 409),
    new DOMException('Aborted', 'AbortError'),
  ])('retains uncertainty and never repeats an unconfirmed dispatched request: %s', async error => {
    const send = vi.fn(async (_command, dispatch) => { dispatch(); throw error; });
    const read = vi.fn();
    expect(await executeNativeControl({ action: 'pause', task: nativeTaskFixture(), send, read, assertCurrent() {} })).toMatchObject({ kind: 'unknown', error });
    expect(send).toHaveBeenCalledTimes(1); expect(read).not.toHaveBeenCalled();
  });
  it('does not call a failed refresh an uncertain write', async () => {
    const send = vi.fn(async (_command, dispatch) => { dispatch(); throw conflict(); });
    const read = vi.fn(async () => { throw new RequestError('NETWORK_UNAVAILABLE', 'Read failed'); });
    const result = await executeNativeControl({ action: 'pause', task: nativeTaskFixture(), send, read, assertCurrent() {} });
    expect(result).toMatchObject({ kind: 'rejected', error: { code: 'VERSION_CONFLICT' } }); expect(send).toHaveBeenCalledTimes(1);
  });
  it('tracks uncertainty separately for the retry dispatch', async () => {
    const send = vi.fn(async (_command, dispatch) => { dispatch(); throw send.mock.calls.length === 1 ? conflict() : new RequestError('NETWORK_UNAVAILABLE', 'Lost retry'); });
    expect((await executeNativeControl({ action: 'pause', task: nativeTaskFixture(), send, read: async () => response(progress()), assertCurrent() {} })).kind).toBe('unknown');
    expect(send).toHaveBeenCalledTimes(2);
  });
  it('stops a retry before dispatch when authority changes during token retrieval', async () => {
    let current = true;
    const send = vi.fn(async (_command, dispatch) => { if (send.mock.calls.length === 2) current = false; dispatch(); throw conflict(); });
    const dispatched = vi.fn();
    const result = await executeNativeControl({ action: 'pause', task: nativeTaskFixture(), send, read: async () => response(progress()),
      assertCurrent() { if (!current) throw new RequestError('SCOPE_CHANGED', 'Changed'); dispatched(); } });
    expect(result).toMatchObject({ kind: 'rejected', error: { code: 'SCOPE_CHANGED' } });
  });
  it('does not retry after the connection changes during a fresh read', async () => {
    let current = true;
    const send = vi.fn(async (_command, dispatch) => { dispatch(); throw conflict(); });
    const result = await executeNativeControl({ action: 'pause', task: nativeTaskFixture(), send,
      read: async () => { current = false; return response(progress()); }, assertCurrent() { if (!current) throw new Error('Scope changed'); } });
    expect(result.kind).toBe('rejected'); expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('evidence required to repeat a protective control', () => {
  const unsafe: [string, (task: NativeTask) => void][] = [
    ['another task', task => { task.id = 'other'; }],
    ['another site', task => { task.siteId = 'other'; }],
    ['changed prompt', task => { task.prompt = 'Other instructions'; }],
    ['changed creation time', task => { task.createdAt = '2026-11-18T13:00:00.000Z'; }],
    ['state transition to input', task => { task.status = 'waiting_for_input'; }],
    ['state transition to completion', task => { task.status = 'completed'; }],
    ['action removed', task => { task.availableActions = ['message']; }],
    ['same version', task => { task.version = 3; }],
    ['version without event', task => { task.version = 5; }],
    ['gap', task => { task.events[2]!.sequence = 4; }],
    ['truncated history', task => { task.events.shift(); }],
    ['rewritten history', task => { task.events[0]!.title = 'Changed'; }],
    ['human reply event', task => { task.events[2]!.kind = 'message'; task.events[2]!.agent = null; }],
    ['control event', task => { task.events[2]!.kind = 'resumed'; }],
    ['unattributed progress', task => { task.events[2]!.agent = null; }],
    ['user message', task => { task.messages.push({ ...task.messages[0]!, id: 'new_user' }); }],
    ['rewritten user message', task => { task.messages[0]!.text = 'Changed'; }],
    ['removed message', task => { task.messages.pop(); }],
    ['rewritten artifact', task => { task.artifacts[0]!.text = 'Changed'; }],
  ];
  it.each(unsafe)('does not retry across %s', (_name, mutate) => {
    const task = progress(); mutate(task);
    expect(canRetryNativeControl('pause', nativeTaskFixture(), task)).toBe(false);
    expect(canRetryNativeControl('cancel', nativeTaskFixture(), task)).toBe(false);
  });
  it('requires complete original history too', () => {
    const before = nativeTaskFixture(); before.events.shift();
    expect(canRetryNativeControl('pause', before, progress())).toBe(false);
  });
  it('accepts appended assistant progress while preserving human instructions', () => {
    const task = progress(); task.messages.push({ ...task.messages[1]!, id: 'new_assistant' });
    expect(canRetryNativeControl('pause', nativeTaskFixture(), task)).toBe(true);
  });
  it('accepts the first queued-to-running claim with one attributed progress event', () => {
    expect(canRetryNativeControl('pause', { ...nativeTaskFixture(), status: 'queued' }, progress())).toBe(true);
  });
  it('rejects a worker release and later claim when version delta has unrecorded changes', () => {
    expect(canRetryNativeControl('pause', nativeTaskFixture(), { ...progress(), version: 5 })).toBe(false);
  });
  it.each([
    ['VERSION_CONFLICT', 409], ['INVALID_TASK_STATE', 409], ['VALIDATION_FAILED', 422], ['FORBIDDEN', 403], ['NOT_FOUND', 404], ['AUTH_REQUIRED', 401], ['SESSION_REQUIRED', 401],
  ] as const)('recognizes exact server rejection %s/%s', (code, status) => expect(nativeControlWasRejected(new RequestError(code, '', status))).toBe(true));
  it('does not use status alone as proof of rejection', () => {
    expect(nativeControlWasRejected(new RequestError('REQUEST_FAILED', '', 409))).toBe(false);
    expect(nativeControlWasRejected(new RequestError('VERSION_CONFLICT', '', 503))).toBe(false);
  });
  it('snapshots every relevant identity and authority field', () => {
    vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', 'https://api.example.test');
    const base = nativeSessionFixture(), original = nativeControlContext(base);
    for (const mutate of [
      (s: typeof base) => { s.actor.sessionId = 'other'; }, (s: typeof base) => { s.actor.actorId = 'other'; },
      (s: typeof base) => { s.organization.authorityEpoch++; }, (s: typeof base) => { s.actor.roles = ['auditor']; },
      (s: typeof base) => { s.actor.siteIds = []; }, (s: typeof base) => { s.actor.actionSiteIds = []; },
      (s: typeof base) => { s.sites = []; }, (s: typeof base) => { s.organization.id = 'other'; },
      (s: typeof base) => { s.actor.environment = 'production'; },
    ]) { const changed = structuredClone(base); mutate(changed); expect(nativeControlContext(changed)).not.toBe(original); }
    vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', 'https://other.example.test');
    expect(nativeControlContext(base)).not.toBe(original);
  });
});
