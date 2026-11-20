import { describe, expect, it, vi } from 'vitest';
import { createNativeHttpHandler } from './http';

describe('Google native host routing', () => {
  it.each(['connect', 'callback', 'recover', 'revoke', 'consent/prepare', 'consent/confirm', 'consent/recover', 'consent/revoke', 'overview', 'event-baseline', 'consent/prepare-event'])('forwards %s unchanged without waking advisory agents', async path => {
    const app = vi.fn(), nudge = vi.fn(), defer = vi.fn();
    const response = Response.json({ retained: true }), fetch = vi.fn(async () => response);
    const googleApp = vi.fn(async () => ({ fetch }));
    const handler = createNativeHttpHandler({ app, googleApp, nudge, defer });
    const request = new Request('https://native.example/v1/google/' + path, { method: 'POST', body: '{}' });
    expect(await handler(request)).toBe(response); expect(fetch).toHaveBeenCalledExactlyOnceWith(request);
    expect(app).not.toHaveBeenCalled(); expect(nudge).not.toHaveBeenCalled(); expect(defer).not.toHaveBeenCalled();
  });
  it('fails closed when configuration is missing and suppresses private bootstrap failures', async () => {
    const base = { app: vi.fn(), nudge: vi.fn(), defer: vi.fn() };
    const request = () => new Request('https://native.example/v1/google/overview', { method: 'POST' });
    expect((await createNativeHttpHandler(base)(request())).status).toBe(503);
    const failed = await createNativeHttpHandler({ ...base, googleApp: async () => { throw Error('private-credential-value'); } })(request());
    expect(failed.status).toBe(503); expect(await failed.text()).not.toContain('private-credential-value');
    expect(base.nudge).not.toHaveBeenCalled();
  });
  it('never initializes Google for unknown paths, GET callbacks or unrelated routes', async () => {
    const googleApp = vi.fn(), app = vi.fn();
    const handler = createNativeHttpHandler({ app, googleApp, nudge: vi.fn(), defer: vi.fn() });
    for (const path of ['/v1/google/send', '/v1/google/consent/unknown', '/v1/google/callback/x', '/v1/google/overview/']) {
      expect((await handler(new Request('https://native.example' + path, { method: 'POST' }))).status).toBe(404);
    }
    expect((await handler(new Request('https://native.example/v1/google/callback?code=x'))).status).toBe(404);
    expect(googleApp).not.toHaveBeenCalled(); expect(app).not.toHaveBeenCalled();
  });
  it('forwards preflight to the configured app without starting work', async () => {
    const response = new Response(null, { status: 204 }), fetch = vi.fn(async () => response), nudge = vi.fn();
    const handler = createNativeHttpHandler({ app: vi.fn(), googleApp: async () => ({ fetch }), nudge, defer: vi.fn() });
    expect(await handler(new Request('https://native.example/v1/google/callback', { method: 'OPTIONS' }))).toBe(response);
    expect(nudge).not.toHaveBeenCalled();
  });
});
