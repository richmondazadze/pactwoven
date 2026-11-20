import { describe, expect, it, vi } from 'vitest';
import { FixedGoogleDiscoveryEventTransport, NativeGoogleDiscoveryReader } from './discovery';
const event = { kind: 'calendar#event', id: 'event_123', etag: '"v2"', status: 'confirmed', updated: '2026-11-18T18:00:00Z', summary: 'Delivery meeting', start: { dateTime: '2026-11-19T12:00:00Z' }, end: { dateTime: '2026-11-19T13:00:00Z' } };
describe('minimal Google discovery transport', () => {
  it('exposes only its three nonsecret binding fields even when the composition config contains a secret', () => {
    const config = { clientId: 'test.apps.googleusercontent.com', redirectUri: 'https://pactwoven.test/app/settings/connections/google/callback', expectedEmail: 'richverseecotech@gmail.com', clientSecret: 'synthetic_config_secret' };
    const reader = new NativeGoogleDiscoveryReader(config, {} as any, {} as any, { binding: Object.freeze({ clientId: config.clientId, redirectUri: config.redirectUri }), account: vi.fn(), refresh: vi.fn() }, { read: vi.fn() });
    expect(Object.keys(reader.binding).sort()).toEqual(['clientId', 'expectedEmail', 'redirectUri']); expect(JSON.stringify(reader.binding)).not.toContain('synthetic_config_secret');
  });
  it('uses exactly one fixed primary Calendar GET with a minimal projection', async () => {
    const fetcher = vi.fn(async () => Response.json(event)), transport = new FixedGoogleDiscoveryEventTransport(fetcher);
    expect(await transport.read('synthetic_access', event.id, new AbortController().signal)).toEqual(event);
    expect(fetcher).toHaveBeenCalledOnce(); const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://www.googleapis.com/calendar/v3/calendars/primary/events/event_123?fields=kind%2Cid%2Cetag%2Cstatus%2Cupdated%2Csummary%2Cstart(dateTime)%2Cend(dateTime)');
    expect(init).toMatchObject({ method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store', headers: { authorization: 'Bearer synthetic_access' } });
    expect(url).not.toMatch(/description|location|attendees|synthetic_access/);
  });
  it.each(['../other', 'event/other', 'event?key=private', 'event\n'])('rejects target path injection before transport', async id => { const fetcher = vi.fn(); await expect(new FixedGoogleDiscoveryEventTransport(fetcher).read('synthetic_access', id, new AbortController().signal)).rejects.toMatchObject({ code: 'GOOGLE_DENIED' }); expect(fetcher).not.toHaveBeenCalled(); });
  it('bounds declared and streamed bodies, rejects redirects and wrong resource without retry', async () => {
    for (const response of [new Response('x', { status: 302, headers: { location: 'https://other.test' } }), new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '17000' } }), new Response('x'.repeat(17000), { headers: { 'content-type': 'application/json' } }), Response.json({ ...event, id: 'foreign' }), Response.json({ ...event, description: 'unrequested data' }), new Response('{}', { headers: { 'content-type': 'text/html' } })]) { const fetcher = vi.fn(async () => response); await expect(new FixedGoogleDiscoveryEventTransport(fetcher).read('synthetic_access', event.id, new AbortController().signal)).rejects.toMatchObject({ code: 'GOOGLE_UNAVAILABLE' }); expect(fetcher).toHaveBeenCalledOnce(); }
  });
  it('does not start a request after cancellation', async () => { const controller = new AbortController(); controller.abort(); const fetcher = vi.fn(); await expect(new FixedGoogleDiscoveryEventTransport(fetcher).read('synthetic_access', event.id, controller.signal)).rejects.toMatchObject({ code: 'GOOGLE_UNAVAILABLE' }); expect(fetcher).not.toHaveBeenCalled(); });
});
