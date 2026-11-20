import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { apiRequest, RequestError } from './api';
import { getApiBase, getNativeApiBase } from './config';
import { nativeApiRequest } from './native-api';

const record = z.strictObject({ id: z.string() });
beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', 'https://foundation.example.test');
  vi.stubEnv('NEXT_PUBLIC_NATIVE_API_BASE_URL', 'https://native.example.test');
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('separate native service transport', () => {
  it('keeps existing foundation calls on their configured host while native reads and controls use the native host', async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => Response.json({ id: 'verified_record' })); vi.stubGlobal('fetch', fetcher);
    await apiRequest('/v1/session', record, async () => 'token');
    await apiRequest('/v1/financial-policies', record, async () => 'token');
    await nativeApiRequest('/v1/tasks?limit=50', record, async () => 'token');
    await nativeApiRequest('/v1/tasks/task_001', record, async () => 'token');
    await nativeApiRequest('/v1/tasks/task_001/control', record, async () => 'token', { body: { action: 'pause', expectedVersion: 3 } });
    expect(fetcher.mock.calls.map(call => call[0])).toEqual([
      'https://foundation.example.test/v1/session', 'https://foundation.example.test/v1/financial-policies',
      'https://native.example.test/v1/tasks?limit=50', 'https://native.example.test/v1/tasks/task_001', 'https://native.example.test/v1/tasks/task_001/control',
    ]);
    expect(fetcher.mock.calls[4]?.[1]).toMatchObject({ method: 'POST', credentials: 'omit', cache: 'no-store', headers: { Authorization: 'Bearer token' }, body: JSON.stringify({ action: 'pause', expectedVersion: 3 }) });
  });

  it('uses the legacy configured host only when the native variable is absent', async () => {
    vi.stubEnv('NEXT_PUBLIC_NATIVE_API_BASE_URL', undefined);
    vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', 'https://foundation.example.test/api/');
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => Response.json({ id: 'record' })); vi.stubGlobal('fetch', fetcher);
    expect(getNativeApiBase()).toBe('https://foundation.example.test/api');
    expect(getNativeApiBase()).toBe(getApiBase());
    await nativeApiRequest('/v1/tasks', record, async () => 'token');
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://foundation.example.test/api/v1/tasks');
  });

  it('rejects missing configuration and explicit empty, malformed or unsafe native addresses before acquiring a token', async () => {
    const token = vi.fn(async () => 'token'), fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    for (const base of ['', 'not-a-url', 'http://external.example.test', 'https://user:secret@native.example.test', 'https://native.example.test?key=value', 'https://native.example.test#fragment']) {
      vi.stubEnv('NEXT_PUBLIC_NATIVE_API_BASE_URL', base);
      expect(getNativeApiBase()).toBeNull();
      await expect(nativeApiRequest('/v1/tasks', record, token)).rejects.toMatchObject({ code: 'API_NOT_CONFIGURED' });
    }
    vi.stubEnv('NEXT_PUBLIC_NATIVE_API_BASE_URL', undefined); vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', undefined);
    await expect(nativeApiRequest('/v1/tasks', record, token)).rejects.toMatchObject({ code: 'API_NOT_CONFIGURED' });
    expect(token).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });

  it('normalizes the native base independently and permits explicit loopback development hosts', () => {
    vi.stubEnv('NEXT_PUBLIC_NATIVE_API_BASE_URL', 'http://127.0.0.1:3108/native/');
    expect(getNativeApiBase()).toBe('http://127.0.0.1:3108/native');
    expect(getApiBase()).toBe('https://foundation.example.test');
  });

  it('cannot route foundation endpoints or traversal paths through the native wrapper', async () => {
    const token = vi.fn(async () => 'token'), fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    for (const path of ['/v1/session', '/v1/responsibilities', '/v1/tasks/../financial-policies', '/v1/tasks/%2e%2e/session', '/v1/tasks#fragment', 'https://other.example.test/v1/tasks']) {
      await expect(nativeApiRequest(path, record, token)).rejects.toMatchObject({ code: 'INVALID_PATH' });
    }
    expect(token).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not dispatch when the effective service changes during token acquisition', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await expect(nativeApiRequest('/v1/tasks', record, async () => {
      vi.stubEnv('NEXT_PUBLIC_NATIVE_API_BASE_URL', 'https://other-native.example.test'); return 'token';
    })).rejects.toMatchObject({ code: 'SCOPE_CHANGED' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('preserves the final synchronous scope check and rejects unverified responses', async () => {
    const order: string[] = [], fetcher = vi.fn(async () => { order.push('fetch'); return Response.json({ unexpected: true }); }); vi.stubGlobal('fetch', fetcher);
    const failure = new RequestError('SCOPE_CHANGED', 'Changed scope');
    await expect(nativeApiRequest('/v1/tasks', record, async () => 'token', { beforeDispatch: () => { throw failure; } })).rejects.toBe(failure);
    expect(fetcher).not.toHaveBeenCalled();
    await expect(nativeApiRequest('/v1/tasks', record, async () => { order.push('token'); return 'token'; }, { beforeDispatch: () => { order.push('guard'); } })).rejects.toMatchObject({ code: 'RESPONSE_UNVERIFIED' });
    expect(order).toEqual(['token', 'guard', 'fetch']);
  });
});
