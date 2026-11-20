import type { Hono } from 'hono';
import { z } from 'zod';
import { IdempotencyKeySchema } from '@pactwoven/contracts';
import { DomainError } from '@pactwoven/domain';
import { NativeGoogleError } from '../../../packages/contracts/src/native-google';
import type { ApiEnv } from './app';
import type { NativeGoogleDiscoveryGateway } from './native-google-discovery-service';

/** Root mounts under the existing bounded-body, CORS and signed auth middleware. */
export function registerNativeGoogleDiscoveryRoutes(app: Hono<ApiEnv>, gateway?: NativeGoogleDiscoveryGateway) {
  const invoke = async (c: any, work: (g: NativeGoogleDiscoveryGateway, bearer: string, signal: AbortSignal) => Promise<unknown>) => {
    if ([...new URL(c.req.url).searchParams].length) throw new DomainError('VALIDATION_FAILED', 422, 'Use the private request body.');
    if (!gateway) throw new DomainError('SETUP_REQUIRED', 503, 'Google Calendar discovery is not connected yet.');
    if (c.req.header('Origin') !== gateway.publicWebOrigin) throw new DomainError('FORBIDDEN', 403, 'Use the approved workspace origin.');
    const auth = c.req.header('Authorization') ?? ''; if (!/^Bearer [^\s]+$/.test(auth)) throw new DomainError('AUTH_REQUIRED', 401, 'Sign in to continue.');
    c.header('Cache-Control', 'private, no-store'); c.header('Referrer-Policy', 'no-referrer');
    try { return c.json(await work(gateway, auth.slice(7), c.req.raw.signal)); }
    catch (error) { if (error instanceof NativeGoogleError) throw new DomainError(error.code, error.code === 'GOOGLE_DENIED' ? 403 : error.code === 'GOOGLE_CONFLICT' ? 409 : 503, error.code === 'GOOGLE_INTEGRATION_REQUIRED' ? 'Google Calendar discovery is not connected yet.' : 'The selected event or permission could not be verified. No result has been assumed.'); throw error; }
  };
  app.post('/v1/google/overview', c => invoke(c, (g, b, s) => { z.strictObject({}).parse(c.get('requestBody')); return g.overview(b, s); }));
  app.post('/v1/google/event-baseline', c => invoke(c, (g, b, s) => g.baseline(b, c.get('requestBody'), s)));
  app.post('/v1/google/consent/prepare-event', c => invoke(c, (g, b, s) => g.prepare(b, IdempotencyKeySchema.parse(c.req.header('Idempotency-Key')), c.get('requestBody'), s)));
}
