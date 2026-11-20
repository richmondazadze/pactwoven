import { describe, expect, it, vi } from 'vitest';
import type { FoundationRepository, VerifiedIdentity } from '@pactwoven/db';
import { DomainError } from '@pactwoven/domain';
import { createNativeTaskApp } from './native-host';
import type { NativeGoogleGateway } from './native-google-service';
import type { NativeGoogleDiscoveryGateway } from './native-google-discovery-service';

const origin = 'https://pactwoven.vercel.app';
const headers = { Origin: origin, Authorization: 'Bearer synthetic', 'Content-Type': 'application/json' };
function fixture() {
  const verifyIdentity = vi.fn(async () => ({ subject: 'synthetic' } as VerifiedIdentity));
  const getSession = vi.fn(async () => ({ actor: { actorId: 'synthetic' } }));
  const foundation = { getSession } as unknown as FoundationRepository;
  const begin = vi.fn(async () => ({ authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth' }));
  const callback = vi.fn(async () => ({ connectionId: 'synthetic-connection' }));
  const overview = vi.fn(async () => ({ tasks: [], consents: [] }));
  const gateway = { publicWebOrigin: origin, begin, callback } as unknown as NativeGoogleGateway;
  const discovery = { publicWebOrigin: origin, overview } as unknown as NativeGoogleDiscoveryGateway;
  const app = createNativeTaskApp({ allowedOrigins: [origin], verifyIdentity, repository: foundation, nativeGoogleGateway: gateway, nativeGoogleDiscoveryGateway: discovery });
  const post = (path: string, body: unknown = {}, override: Record<string, string> = {}) => app.request(path, { method: 'POST', headers: { ...headers, ...override }, body: JSON.stringify(body) });
  return { app, post, begin, callback, overview, verifyIdentity, getSession };
}

describe('Google routes mounted behind the native API policy', () => {
  it('routes connection, callback and discovery through identity and session middleware', async () => {
    const f = fixture();
    for (const [path, body] of [['connect', {}], ['callback', { state: 's'.repeat(43), code: 'synthetic' }], ['overview', {}]] as const) {
      const response = await f.post('/v1/google/' + path, body);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    }
    expect(f.verifyIdentity).toHaveBeenCalledTimes(3); expect(f.getSession).toHaveBeenCalledTimes(3);
    expect(f.begin).toHaveBeenCalledExactlyOnceWith('synthetic', expect.any(AbortSignal));
    expect(f.callback).toHaveBeenCalledExactlyOnceWith('synthetic', { state: 's'.repeat(43), code: 'synthetic' }, expect.any(AbortSignal));
    expect(f.overview).toHaveBeenCalledOnce();
  });
  it('rejects foreign origins, query codes, invalid JSON and oversized uploads before provider invocation', async () => {
    const f = fixture();
    expect((await f.post('/v1/google/connect', {}, { Origin: 'https://foreign.example' })).status).toBe(403);
    expect((await f.post('/v1/google/connect?code=synthetic')).status).toBe(422);
    expect((await f.app.request('/v1/google/connect', { method: 'POST', headers, body: '{' })).status).toBe(422);
    expect((await f.post('/v1/google/connect', { value: 'x'.repeat(65536) })).status).toBe(413);
    expect(f.begin).not.toHaveBeenCalled();
  });
  it('rejects missing or revoked identity before the Google gateway', async () => {
    const f = fixture();
    expect((await f.post('/v1/google/connect', {}, { Authorization: '' })).status).toBe(401);
    f.verifyIdentity.mockRejectedValueOnce(new DomainError('AUTH_REQUIRED', 401, 'Sign in again.'));
    expect((await f.post('/v1/google/connect')).status).toBe(401);
    f.getSession.mockRejectedValueOnce(new DomainError('FORBIDDEN', 403, 'Membership is no longer active.'));
    expect((await f.post('/v1/google/connect')).status).toBe(403);
    expect(f.begin).not.toHaveBeenCalled();
  });
  it('keeps unrelated provider paths and GET callbacks outside the native surface', async () => {
    const f = fixture();
    for (const path of ['/v1/google/send', '/v1/google/callback/synthetic', '/v1/google/consent/unknown', '/v1/google/overview/']) {
      expect((await f.post(path)).status).toBe(404);
    }
    expect((await f.app.request('/v1/google/callback?code=synthetic', { headers })).status).toBe(404);
    expect(f.verifyIdentity).not.toHaveBeenCalled(); expect(f.callback).not.toHaveBeenCalled();
  });
  it('handles allowed preflight without reading credentials or invoking Google', async () => {
    const f = fixture();
    const response = await f.app.request('/v1/google/callback', { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type,idempotency-key' } });
    expect(response.status).toBe(204); expect(response.headers.get('access-control-allow-origin')).toBe(origin);
    expect(f.verifyIdentity).not.toHaveBeenCalled(); expect(f.callback).not.toHaveBeenCalled();
  });
});
