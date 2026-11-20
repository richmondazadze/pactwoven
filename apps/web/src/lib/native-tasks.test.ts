import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RequestError } from './api';
import { nativeSessionFixture, nativeTaskFixture, nativeTaskResponseFixture } from './native-tasks.test-fixtures';
import {
  clearTaskAttempt, createTaskAttempt, createTaskReplyAttempt, nativeTaskError, nativeTaskProgressAnnouncement, nativeTaskSearchKey, nativeTaskSearchPath,
  newerNativeTask, nativeTaskControlResponseSchema, nativeStepPresentation, nativeTaskListKey, nativeTaskQueryKey, readTaskAttempt, scopedNativeApiRequest, scopedNativeTaskPageSchema, scopedNativeTaskSchema,
  sendTaskAttempt, storeTaskAttempt, taskAttemptScope, taskAttemptStorageKey, taskAttemptWasRejected, previousTaskRequests, requireCurrentTaskConnection,
  type TaskAttemptScanStorage,
} from './native-tasks';

function storageFixture() {
  const values = new Map<string, string>();
  const storage: TaskAttemptScanStorage = { get length() { return values.size; }, key: index => [...values.keys()][index] ?? null, getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); } };
  return { storage, values };
}
function fixture() {
  const session = nativeSessionFixture(), scope = taskAttemptScope(session), response = nativeTaskResponseFixture();
  const attempt = createTaskAttempt(scope, { prompt: response.task.prompt, siteId: response.task.siteId, mode: 'advise' });
  const signal = new AbortController().signal;
  return { session, scope, response, attempt, options: { signal, currentScope: () => scope } };
}
beforeEach(() => { vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', 'https://api.example.test'); vi.stubEnv('NEXT_PUBLIC_NATIVE_API_BASE_URL', undefined); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('native task response and recovery boundary', () => {
  it('accepts only the current organization, environment, site and requested task', () => {
    const f = fixture();
    expect(scopedNativeTaskSchema(f.session, f.response.task.id).safeParse(f.response).success).toBe(true);
    for (const response of [
      { ...f.response, scope: { ...f.response.scope, organizationId: 'different_org' } },
      { ...f.response, scope: { ...f.response.scope, environment: 'production' } },
      { ...f.response, task: { ...f.response.task, siteId: 'hidden_site' } },
      { ...f.response, task: { ...f.response.task, id: 'different_task' } },
    ]) expect(scopedNativeTaskSchema(f.session, f.response.task.id).safeParse(response).success).toBe(false);
    expect(scopedNativeTaskPageSchema(f.session).safeParse({ scope: f.response.scope, nextCursor: null, items: [f.response.task] }).success).toBe(false); // Strict summaries cannot contain conversations.
    const { prompt: _prompt, mode: _mode, steps: _steps, messages: _messages, artifacts: _artifacts, events: _events, ...summary } = f.response.task;
    expect(scopedNativeTaskPageSchema(f.session).safeParse({ scope: f.response.scope, nextCursor: null, items: [summary] }).success).toBe(true);
    expect(scopedNativeTaskPageSchema(f.session).safeParse({ scope: f.response.scope, nextCursor: null, items: [{ ...summary, siteId: 'hidden_site' }] }).success).toBe(false);
  });
  it('restores the exact original payload after a reload and clears only that request', () => {
    const f = fixture(), { storage, values } = storageFixture();
    storeTaskAttempt(storage, f.attempt);
    expect(readTaskAttempt(storage, f.scope)).toEqual(f.attempt);
    expect(values.size).toBe(1);
    const other = createTaskAttempt(f.scope, { prompt: 'A different task', siteId: 'site_one', mode: 'advise' });
    expect(() => storeTaskAttempt(storage, other)).toThrow('An earlier request');
    clearTaskAttempt(storage, other);
    expect(readTaskAttempt(storage, f.scope)).toEqual(f.attempt);
    clearTaskAttempt(storage, f.attempt);
    expect(readTaskAttempt(storage, f.scope)).toBeNull();
  });
  it('keeps recovery separate for actor, session, environment and backend', () => {
    const f = fixture(), { storage } = storageFixture();
    storeTaskAttempt(storage, f.attempt);
    for (const scope of [
      { ...f.scope, actorId: 'another_actor' }, { ...f.scope, sessionId: 'another_session' },
      { ...f.scope, environment: 'production' as const }, { ...f.scope, apiBase: 'https://other.example.test' },
    ]) expect(readTaskAttempt(storage, scope)).toBeNull();
  });
  it('rejects a tampered or oversized saved request without silently removing it', () => {
    const f = fixture(), { storage, values } = storageFixture();
    const key = taskAttemptStorageKey(f.scope);
    for (const raw of ['{broken', JSON.stringify({ ...f.attempt, input: { ...f.attempt.input, mode: 'act' } }), ' '.repeat(100_001)]) {
      values.set(key, raw);
      expect(() => readTaskAttempt(storage, f.scope)).toThrow('Saved request');
      expect(values.get(key)).toBe(raw);
    }
  });
  it('does not treat a storage write that silently drops data as recoverable', () => {
    const f = fixture();
    const storage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
    expect(() => storeTaskAttempt(storage, f.attempt)).toThrow('This tab cannot save');
  });
  it('retains the original request across an unknown response and reuses its key exactly once per explicit retry', async () => {
    const f = fixture(), { storage } = storageFixture();
    storeTaskAttempt(storage, f.attempt);
    const fetcher = vi.fn().mockRejectedValueOnce(new TypeError('internal socket error')).mockResolvedValueOnce(Response.json(f.response));
    vi.stubGlobal('fetch', fetcher);
    await expect(sendTaskAttempt(f.attempt, f.session, async () => 'token', f.options)).rejects.toMatchObject({ code: 'NETWORK_UNAVAILABLE' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const restored = readTaskAttempt(storage, f.scope)!;
    await expect(sendTaskAttempt(restored, f.session, async () => 'token', f.options)).resolves.toEqual(f.response);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const first = fetcher.mock.calls[0]![1] as RequestInit, second = fetcher.mock.calls[1]![1] as RequestInit;
    expect(first.body).toBe(second.body);
    expect(first.headers).toMatchObject({ 'Idempotency-Key': f.attempt.key });
    expect(second.headers).toMatchObject({ 'Idempotency-Key': f.attempt.key });
    expect(readTaskAttempt(storage, f.scope)).toEqual(f.attempt); // Only caller confirmation clears recovery.
  });
  it('rejects a success response for another prompt instead of clearing recovery', async () => {
    const f = fixture();
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...f.response, task: { ...f.response.task, prompt: 'Unrelated task' } })));
    await expect(sendTaskAttempt(f.attempt, f.session, async () => 'token', f.options)).rejects.toMatchObject({ code: 'RESPONSE_UNVERIFIED' });
  });
  it('requires a reply acknowledgement to contain the saved message at a later version', async () => {
    const f = fixture();
    const reply = createTaskReplyAttempt(f.scope, f.response.task.id, { text: 'Use the Friday deadline.', expectedVersion: 3 });
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(f.response)).mockResolvedValueOnce(Response.json({ ...f.response, task: { ...f.response.task, version: 4, messages: [...f.response.task.messages, { id: 'message_new', role: 'user', text: 'Use the Friday deadline.', createdAt: '2026-11-18T12:02:00.000Z' }] } }));
    vi.stubGlobal('fetch', fetcher);
    await expect(sendTaskAttempt(reply, f.session, async () => 'token', f.options)).rejects.toMatchObject({ code: 'RESPONSE_UNVERIFIED' });
    await expect(sendTaskAttempt(reply, f.session, async () => 'token', f.options)).resolves.toMatchObject({ task: { version: 4 } });
  });
  it('does not dispatch after the workspace changes while awaiting authentication', async () => {
    const f = fixture(); let current = f.scope;
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await expect(sendTaskAttempt(f.attempt, f.session, async () => { current = { ...f.scope, actorId: 'different_actor' }; return 'token'; }, { ...f.options, currentScope: () => current })).rejects.toMatchObject({ code: 'SCOPE_CHANGED' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('does not dispatch an aborted request after token acquisition', async () => {
    const f = fixture(), controller = new AbortController(), fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await expect(sendTaskAttempt(f.attempt, f.session, async () => { controller.abort(); return 'token'; }, { ...f.options, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('separates definite rejection from an unresolved earlier attempt', () => {
    expect(taskAttemptWasRejected(new RequestError('VERSION_CONFLICT', 'Changed', 409), true)).toBe(true);
    expect(taskAttemptWasRejected(new RequestError('FORBIDDEN', 'Denied', 403))).toBe(true);
    expect(taskAttemptWasRejected(new RequestError('FORBIDDEN', 'Denied', 403), true)).toBe(false);
    expect(taskAttemptWasRejected(new RequestError('VALIDATION_FAILED', 'Invalid', 422), true)).toBe(false);
    for (const error of [new RequestError('IDEMPOTENCY_CONFLICT', 'Changed', 409), new RequestError('SERVICE_UNAVAILABLE', 'Unavailable', 503), new TypeError('Network')]) expect(taskAttemptWasRejected(error)).toBe(false);
  });
  it('never lets a late polling response undo a newer pause or completion', () => {
    const old = nativeTaskFixture(), latest = { ...old, version: 5, status: 'paused' as const };
    expect(newerNativeTask(latest, old)).toBe(latest);
    expect(newerNativeTask(old, latest)).toBe(latest);
  });
  it('requires control acknowledgements to confirm the requested action at a newer version', () => {
    const f = fixture();
    const schema = nativeTaskControlResponseSchema(f.session, f.response.task.id, { action: 'pause', expectedVersion: 3 });
    expect(schema.safeParse(f.response).success).toBe(false);
    expect(schema.safeParse({ ...f.response, task: { ...f.response.task, status: 'paused', version: 3 } }).success).toBe(false);
    expect(schema.safeParse({ ...f.response, task: { ...f.response.task, status: 'paused', version: 4 } }).success).toBe(true);
  });
  it('never depicts a paused or stopped task as an actively working agent', () => {
    const task = nativeTaskFixture(), step = task.steps[1]!;
    expect(nativeStepPresentation('running', step)).toMatchObject({ active: true, label: 'Working' });
    expect(nativeStepPresentation('paused', step)).toMatchObject({ active: false, label: 'Paused' });
    expect(nativeStepPresentation('cancelled', step)).toMatchObject({ active: false, label: 'Stopped' });
    expect(nativeStepPresentation('failed', step)).toMatchObject({ active: false, label: 'Interrupted' });
    expect(nativeStepPresentation('completed', step)).toMatchObject({ active: false, label: 'Not confirmed' });
  });
  it('uses product language without raw transport strings or diagnostic identifiers', () => {
    const error = new RequestError('PROVIDER_FAILURE', 'postgres://private connection detail', 503, 'long_internal_request_reference');
    expect(nativeTaskError(error, true)).not.toMatch(/postgres|long_internal/);
    expect(nativeTaskError(error, true)).toContain('not been confirmed');
  });

  it('uses the effective native base in create/reply requests, saved scope and query caches', async () => {
    const legacy = fixture(), legacyKey = nativeTaskQueryKey(legacy.session, legacy.response.task.id), legacyList = nativeTaskListKey(legacy.session);
    vi.stubEnv('NEXT_PUBLIC_NATIVE_API_BASE_URL', 'https://native.example.test/');
    const f = fixture(), { storage } = storageFixture();
    expect(f.scope.apiBase).toBe('https://native.example.test');
    expect(nativeTaskQueryKey(f.session, f.response.task.id)).not.toEqual(legacyKey);
    expect(nativeTaskListKey(f.session)).not.toEqual(legacyList);
    const reply = createTaskReplyAttempt(f.scope, f.response.task.id, { text: 'Use Friday.', expectedVersion: 3 });
    const response = { ...f.response, task: { ...f.response.task, version: 4, messages: [...f.response.task.messages, { id: 'reply_002', role: 'user', text: 'Use Friday.', createdAt: '2026-11-18T12:02:00.000Z' }] } };
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(f.response)).mockResolvedValueOnce(Response.json(response)); vi.stubGlobal('fetch', fetcher);
    storeTaskAttempt(storage, f.attempt); storeTaskAttempt(storage, reply);
    await expect(sendTaskAttempt(readTaskAttempt(storage, f.scope)!, f.session, async () => 'token', f.options)).resolves.toEqual(f.response);
    await expect(sendTaskAttempt(readTaskAttempt(storage, f.scope, f.response.task.id)!, f.session, async () => 'token', f.options)).resolves.toEqual(response);
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://native.example.test/v1/tasks');
    expect(fetcher.mock.calls[1]?.[0]).toBe(`https://native.example.test/v1/tasks/${f.response.task.id}/messages`);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ body: JSON.stringify(f.attempt.input), headers: { 'Idempotency-Key': f.attempt.key } });
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ body: JSON.stringify(reply.input), headers: { 'Idempotency-Key': reply.key } });
  });

  it('preserves prior-origin recovery without moving either a create or a reply to a new host', async () => {
    const f = fixture(), { storage, values } = storageFixture(), fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const reply = createTaskReplyAttempt(f.scope, f.response.task.id, { text: 'Original message.', expectedVersion: 3 });
    storeTaskAttempt(storage, f.attempt); storeTaskAttempt(storage, reply);
    const saved = [...values.entries()];
    vi.stubEnv('NEXT_PUBLIC_NATIVE_API_BASE_URL', 'https://new-native.example.test');
    const current = taskAttemptScope(f.session);
    expect(readTaskAttempt(storage, current)).toBeNull();
    expect(readTaskAttempt(storage, current, f.response.task.id)).toBeNull();
    for (const original of [f.attempt, reply]) {
      await expect(sendTaskAttempt(original, f.session, async () => 'token', { ...f.options, currentScope: () => current })).rejects.toMatchObject({ code: 'SCOPE_CHANGED' });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect([...values.entries()]).toEqual(saved);
    vi.stubEnv('NEXT_PUBLIC_NATIVE_API_BASE_URL', undefined);
    expect(readTaskAttempt(storage, taskAttemptScope(f.session))).toEqual(f.attempt);
    expect(readTaskAttempt(storage, taskAttemptScope(f.session), f.response.task.id)).toEqual(reply);
  });

  it('blocks reads and controls when their current workspace changes during token acquisition', async () => {
    vi.stubEnv('NEXT_PUBLIC_NATIVE_API_BASE_URL', 'https://native.example.test');
    const f = fixture(), fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    for (const path of ['/v1/tasks?limit=50', `/v1/tasks/${f.response.task.id}`, `/v1/tasks/${f.response.task.id}/control`]) {
      let current = f.scope; const dispatched = vi.fn();
      await expect(scopedNativeApiRequest(path, scopedNativeTaskSchema(f.session), f.session, async () => {
        current = { ...f.scope, organizationId: 'other_company' }; return 'token';
      }, { currentScope: () => current, beforeDispatch: dispatched, ...(path.endsWith('/control') ? { body: { action: 'pause', expectedVersion: 3 } } : {}) })).rejects.toMatchObject({ code: 'SCOPE_CHANGED' });
      expect(dispatched).not.toHaveBeenCalled();
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('keeps native cache records separate across sign-in sessions', () => {
    const f = fixture(), next = { ...f.session, actor: { ...f.session.actor, sessionId: 'new_session' } };
    expect(nativeTaskQueryKey(f.session, f.response.task.id)).not.toEqual(nativeTaskQueryKey(next, f.response.task.id));
    expect(nativeTaskListKey(f.session)).not.toEqual(nativeTaskListKey(next));
  });

  it('detects an unresolved create from the prior connection and blocks a fresh attempt without copying private contents', () => {
    const f = fixture(), { storage, values } = storageFixture(); storeTaskAttempt(storage, f.attempt);
    const original = [...values.entries()];
    vi.stubEnv('NEXT_PUBLIC_NATIVE_API_BASE_URL', 'https://new-native.example.test');
    const current = taskAttemptScope(f.session);
    expect(previousTaskRequests(storage, current)).toEqual([{ key: f.attempt.key, kind: 'create' }]);
    expect(() => requireCurrentTaskConnection(storage, current)).toThrowError(expect.objectContaining({ code: 'PREVIOUS_CONNECTION_PENDING' }));
    expect(JSON.stringify(previousTaskRequests(storage, current))).not.toMatch(/Compare these office chairs|https:|company_one|session_one/);
    expect([...values.entries()]).toEqual(original);
    vi.stubEnv('NEXT_PUBLIC_NATIVE_API_BASE_URL', undefined);
    expect(previousTaskRequests(storage, taskAttemptScope(f.session))).toEqual([]);
    expect(readTaskAttempt(storage, taskAttemptScope(f.session))).toEqual(f.attempt);
  });

  it('blocks only the corresponding prior-connection reply slot without affecting a different task', () => {
    const f = fixture(), { storage, values } = storageFixture();
    const original = createTaskReplyAttempt(f.scope, f.response.task.id, { text: 'Keep the original reply.', expectedVersion: 3 });
    storeTaskAttempt(storage, original); const saved = [...values.entries()];
    const current = { ...f.scope, apiBase: 'https://new-native.example.test' };
    expect(previousTaskRequests(storage, current, f.response.task.id)).toEqual([{ key: original.key, kind: 'reply', taskId: f.response.task.id }]);
    expect(() => requireCurrentTaskConnection(storage, current, f.response.task.id)).toThrowError(expect.objectContaining({ code: 'PREVIOUS_CONNECTION_PENDING' }));
    expect(() => requireCurrentTaskConnection(storage, current, 'different_task')).not.toThrow();
    expect(() => requireCurrentTaskConnection(storage, current)).not.toThrow();
    expect([...values.entries()]).toEqual(saved);
  });

  it('does not load another company, actor, session or environment while scanning old connections', () => {
    const f = fixture(), { storage } = storageFixture();
    for (const scope of [
      { ...f.scope, organizationId: 'different_company' }, { ...f.scope, actorId: 'different_actor' },
      { ...f.scope, sessionId: 'different_session' }, { ...f.scope, environment: 'production' as const },
    ]) storeTaskAttempt(storage, createTaskAttempt(scope, f.attempt.kind === 'create' ? f.attempt.input : { prompt: 'Other work', siteId: 'site_one', mode: 'advise' }));
    const getItem = vi.spyOn(storage, 'getItem');
    expect(previousTaskRequests(storage, { ...f.scope, apiBase: 'https://new-native.example.test' })).toEqual([]);
    expect(getItem).not.toHaveBeenCalled();
  });

  it('preserves and rejects corrupted matching prior-connection recovery instead of enabling new work', () => {
    const f = fixture(), { storage, values } = storageFixture(), key = taskAttemptStorageKey(f.scope);
    values.set(key, '{broken');
    expect(() => requireCurrentTaskConnection(storage, { ...f.scope, apiBase: 'https://new-native.example.test' })).toThrowError(expect.objectContaining({ code: 'LOCAL_RECOVERY_INVALID' }));
    expect(values.get(key)).toBe('{broken');
  });

  it('fails closed when browser storage cannot enumerate saved requests', () => {
    const f = fixture(), { storage } = storageFixture();
    const unavailable = { ...storage, get length(): number { throw Error('Private storage failure'); } };
    expect(() => previousTaskRequests(unavailable, f.scope)).toThrowError(expect.objectContaining({ code: 'LOCAL_RECOVERY_UNAVAILABLE' }));
  });
});


describe('complete work discovery and material progress', () => {
  it('sends literal search, filter and opaque cursor to the server without dropping symbols', () => {
    const path = nativeTaskSearchPath({ q: '  50% chairs & tables_  ', filter: 'active', limit: 50 }, 'opaque-token_2');
    const url = new URL(path, 'https://example.test');
    expect(url.pathname).toBe('/v1/tasks');
    expect(Object.fromEntries(url.searchParams)).toEqual({ limit: '50', q: '50% chairs & tables_', filter: 'active', cursor: 'opaque-token_2' });
    expect(() => nativeTaskSearchPath({ q: 'x'.repeat(181), filter: 'all', limit: 50 })).toThrow();
  });
  it('isolates discovery for query, filter, page size and authorization scope', () => {
    const session = nativeSessionFixture(), view = { q: 'chairs', filter: 'all' as const, limit: 50 };
    const key = nativeTaskSearchKey(session, view);
    expect(nativeTaskSearchKey(session, { ...view, q: ' chairs ' })).toEqual(key);
    for (const change of [{ q: 'tables' }, { filter: 'completed' as const }, { limit: 5 }]) expect(nativeTaskSearchKey(session, { ...view, ...change })).not.toEqual(key);
    for (const next of [{ ...session, organization: { ...session.organization, authorityEpoch: 2 } }, { ...session, actor: { ...session.actor, siteIds: [] } }]) expect(nativeTaskSearchKey(next, view)).not.toEqual(key);
  });
  it('does not ask for a credential after the workspace changed', async () => {
    const f = fixture(), token = vi.fn(async () => 'not-requested');
    await expect(scopedNativeApiRequest('/v1/tasks', scopedNativeTaskPageSchema(f.session), f.session, token, { ...f.options, currentScope: () => ({ ...f.scope, sessionId: 'replacement_session' }) })).rejects.toMatchObject({ code: 'SCOPE_CHANGED' });
    expect(token).not.toHaveBeenCalled();
  });
  it('announces current material state without poll chatter or invented progress', () => {
    const previous = nativeTaskFixture();
    expect(nativeTaskProgressAnnouncement(undefined, previous)).toBe('');
    expect(nativeTaskProgressAnnouncement(previous, previous)).toBe('');
    expect(nativeTaskProgressAnnouncement(previous, { ...previous, version: previous.version + 1, phase: 'Same step with a new timestamp' })).toBe('');
    expect(nativeTaskProgressAnnouncement(previous, { ...previous, version: previous.version + 1, status: 'completed' })).toContain('Your result is ready');
    expect(nativeTaskProgressAnnouncement(previous, { ...previous, version: previous.version + 1, status: 'waiting_for_input' })).toContain('Needs your input');
    expect(nativeTaskProgressAnnouncement(previous, { ...previous, version: previous.version + 1, status: 'failed' })).toContain('Needs attention');
    expect(nativeTaskProgressAnnouncement(previous, { ...previous, version: previous.version + 1, steps: previous.steps.map(step => ({ ...step, status: 'completed' })) })).toBe('Step complete: Compare the options.');
    expect(nativeTaskProgressAnnouncement(previous, { ...previous, version: previous.version + 1, messages: [...previous.messages, { ...previous.messages[0]!, id: 'new_user', role: 'user' }] })).toBe('');
    expect(nativeTaskProgressAnnouncement(previous, { ...previous, version: previous.version + 1, messages: [...previous.messages, { ...previous.messages[0]!, id: 'new_reply', role: 'assistant' }] })).toContain('added a response');
  });
});
