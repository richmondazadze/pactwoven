import { describe, expect, it, vi } from 'vitest';
import { createNativeHttpHandler } from './http.js';

describe('native HTTP hosting boundary', () => {
  it('rejects unrelated endpoints before touching credentials or storage', async () => {
    const app = vi.fn(); const nudge = vi.fn(); const defer = vi.fn();
    const handler = createNativeHttpHandler({ app, nudge, defer });
    for (const path of ['/v1/session', '/v1/responsibilities', '/v1/organizations/bootstrap', '/v1/financial-policy', '/api/consume', '/api/recover', '/internal/nudge', '/v1/tasks/x/unknown']) {
      const result = await handler(new Request(`https://native.example${path}`));
      expect(result.status).toBe(404);
    }
    expect(app).not.toHaveBeenCalled(); expect(nudge).not.toHaveBeenCalled();
    const health = await handler(new Request('https://native.example/health'));
    expect(await health.json()).toMatchObject({ status: 'alive' });
    expect(app).not.toHaveBeenCalled();
  });
  it('defers wake-up only after a confirmed mutation without changing its response', async () => {
    const response = Response.json({ saved: true }, { status: 201 });
    const fetch = vi.fn(async () => response); const nudge = vi.fn(async () => undefined);
    const pending: Promise<unknown>[] = [];
    const handler = createNativeHttpHandler({ app: async () => ({ fetch }), nudge, defer: task => { pending.push(task); } });
    const request = new Request('https://native.example/v1/tasks', { method: 'POST', body: '{}' });
    expect(await handler(request)).toBe(response);
    await Promise.all(pending); expect(nudge).toHaveBeenCalledOnce(); expect(fetch).toHaveBeenCalledWith(request);
  });
  it('does not trigger work on reads, denied requests or unknown outcomes', async () => {
    const nudge = vi.fn();
    for (const [method, status] of [['GET', 200], ['POST', 401], ['POST', 403], ['POST', 409], ['POST', 503]] as const) {
      const handler = createNativeHttpHandler({ app: async () => ({ fetch: async () => new Response('', { status }) }), nudge, defer: vi.fn() });
      expect((await handler(new Request('https://native.example/v1/tasks', { method }))).status).toBe(status);
    }
    expect(nudge).not.toHaveBeenCalled();
  });
  it('keeps a committed receipt when dispatch or defer fails', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const pending: Promise<unknown>[] = [];
    try {
      const handler = createNativeHttpHandler({ app: async () => ({ fetch: async () => new Response('', { status: 201 }) }),
        nudge: async () => { throw Error('private transport details'); }, defer: work => { pending.push(work); throw Error('runtime stopped'); } });
      expect((await handler(new Request('https://native.example/v1/tasks', { method: 'POST' }))).status).toBe(201);
      await Promise.all(pending); expect(log).toHaveBeenCalledOnce(); expect(JSON.stringify(log.mock.calls)).not.toContain('private transport');
    } finally { log.mockRestore(); }
  });
  it('does not expose configuration or database exceptions', async () => {
    const handler = createNativeHttpHandler({ app: async () => { throw Error('postgresql://secret/private'); }, nudge: vi.fn(), defer: vi.fn() });
    const result = await handler(new Request('https://native.example/v1/tasks'));
    expect(result.status).toBe(503); expect(await result.text()).not.toContain('postgresql');
  });
  it('routes memory through its independent app without waking task execution', async () => {
    const app = vi.fn(), nudge = vi.fn(), defer = vi.fn();
    const fetch = vi.fn(async () => Response.json({ saved: true }));
    const memoryApp = vi.fn(async () => ({ fetch }));
    const handler = createNativeHttpHandler({ app, memoryApp, nudge, defer });
    expect((await handler(new Request('https://native.example/v1/memory', { method: 'POST', body: '{}' }))).status).toBe(200);
    expect(app).not.toHaveBeenCalled(); expect(nudge).not.toHaveBeenCalled(); expect(defer).not.toHaveBeenCalled();
    expect(memoryApp).toHaveBeenCalledOnce();
    expect((await createNativeHttpHandler({ app, nudge, defer })(new Request('https://native.example/v1/memory'))).status).toBe(503);
    memoryApp.mockRejectedValueOnce(Error('private-connection-value'));
    const failed = await handler(new Request('https://native.example/v1/memory'));
    expect(failed.status).toBe(503);expect(await failed.text()).not.toContain('private-connection-value');
  });
  it.each([
    ['/v1/agent-work/prepare', 'POST', 200, false],
    ['/v1/agent-work/confirm', 'POST', 200, true],
    ['/v1/agent-work/paid/prepare', 'POST', 200, false],
    ['/v1/agent-work/paid/confirm', 'POST', 200, true],
    ['/v1/agent-work/root/equipment/review', 'POST', 200, false],
    ['/v1/agent-work/root/equipment/approve', 'POST', 200, true],
    ['/v1/agent-work/root/equipment/recover', 'POST', 200, true],
    ['/v1/agent-work/root/equipment/approve', 'POST', 409, false],
    ['/v1/agent-work/root/equipment/approve', 'POST', 503, false],
    ['/v1/agent-work/root/equipment/recover', 'POST', 503, false],

    ['/v1/agent-work/root/control', 'POST', 200, true],
    ['/v1/agent-work/confirm', 'POST', 409, false],
    ['/v1/agent-work/confirm', 'POST', 503, false],
    ['/v1/agent-work/root?siteId=office', 'GET', 200, false],
    ['/v1/agent-work/root/activity?siteId=office', 'GET', 200, false],
    ['/v1/agent-work/root/team-activity?siteId=office', 'GET', 200, false],
    ['/v1/voice/transcribe', 'POST', 200, false],
    ['/v1/voice/speak', 'POST', 200, false],
    ['/v1/agent-work/operations/original_request_key?siteId=office', 'GET', 200, false],
    ['/v1/agent-work/root/conversation?siteId=office', 'GET', 200, false],
    ['/v1/agent-work/root/instructions?siteId=office', 'POST', 200, false],
    ['/v1/agent-work/root/instructions/original_request_key?siteId=office', 'GET', 200, false],
    ['/v1/agent-work/root/instructions?siteId=office', 'POST', 409, false],
  ] as const)('routes delegated work %s without premature dispatch', async (path, method, status, wakes) => {
    const app = vi.fn(), nudge = vi.fn(), pending: Promise<unknown>[] = [];
    const response = Response.json({ retained: true }, { status });
    const workApp = vi.fn(async () => ({ fetch: async () => response }));
    const handler = createNativeHttpHandler({ app, workApp, nudge, defer: work => { pending.push(work); } });
    expect(await handler(new Request('https://native.example' + path, { method }))).toBe(response);
    await Promise.all(pending);expect(nudge).toHaveBeenCalledTimes(wakes ? 1 : 0);expect(app).not.toHaveBeenCalled();
  });
  it('does not expose delegated startup failures or initialize unknown work subroutes', async () => {
    const app = vi.fn(), nudge = vi.fn(), defer = vi.fn(), workApp = vi.fn(async () => { throw Error('private-database-url'); });
    const handler = createNativeHttpHandler({ app, workApp, nudge, defer });
    const response = await handler(new Request('https://native.example/v1/agent-work/root?siteId=office'));
    expect(response.status).toBe(503);expect(await response.text()).not.toContain('private-database-url');
    expect((await handler(new Request('https://native.example/v1/agent-work/root/unknown'))).status).toBe(404);
    expect((await handler(new Request('https://native.example/v1/agent-work/root/conversation', { method: 'POST' }))).status).toBe(404);
    expect((await handler(new Request('https://native.example/v1/agent-work/root/instructions/key', { method: 'POST' }))).status).toBe(404);
    expect(workApp).toHaveBeenCalledOnce();expect(nudge).not.toHaveBeenCalled();
  });
});
