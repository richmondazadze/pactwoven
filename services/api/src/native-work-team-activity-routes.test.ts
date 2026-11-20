import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { DomainError } from '@pactwoven/domain';
import type { Session } from '@pactwoven/contracts';
import type { ApiEnv } from './app';
import { registerNativeWorkTeamActivityRoutes } from './native-work-team-activity-routes';

const at = '2026-11-19T12:00:00Z';
function setup(connected = true) {
  const session: Session = { actor: { actorId: 'operator', principalKind: 'human', organizationId: 'org', environment: 'development',
    roles: ['owner'], siteIds: ['office'], actionSiteIds: [], sessionId: 'session', authenticatedAt: at, correlationId: 'test' },
    organization: { id: 'org', name: 'Company', authorityEpoch: 1 }, sites: [{ id: 'office', name: 'Office', timeZone: 'America/Chicago' }] };
  const frame = { root: { scope: { environment: 'development', organizationId: 'org', siteId: 'office' }, id: 'root',
    title: 'Workshop', prompt: 'Draft a plan', controlVersion: 1, state: 'ready', reason: 'none', checkpointVersion: 0,
    checkpoint: null, checkpointHistorical: false, attempt: 1, attemptLimit: 4, generation: 1, coverage: [], result: null,
    updatedAt: at, expiresAt: '2026-11-19T13:00:00Z', evidenceUnavailable: false, domainCompletion: false },
    instructionRevision: 0, observedAt: at, currentExecution: { kind: 'unavailable', validUntil: null, children: [] } };
  const repository = { read: vi.fn(async () => frame) }, app = new Hono<ApiEnv>();
  // Synthetic authenticated session fixture; production mount owns real verification.
  app.use('*', async (c, next) => { c.set('session', session); await next(); });
  app.onError((error, c) => {
    if (error instanceof DomainError) return c.json({ error: error.code }, error.status as 403 | 422 | 503);
    if (error instanceof ZodError) return c.json({ error: 'VALIDATION_FAILED' }, 422);
    return c.json({ error: 'UNEXPECTED' }, 500);
  });
  registerNativeWorkTeamActivityRoutes(app, connected ? repository : undefined, () => at);
  const get = (query = '?siteId=office') => app.request('/v1/agent-work/root/team-activity' + query);
  return { session, frame, repository, app, get };
}
describe('read-only authenticated activity route', () => {
  it('uses one actor/site-bound read and does not require write authority', async () => {
    const f = setup(), response = await f.get();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(f.repository.read).toHaveBeenCalledExactlyOnceWith(f.session.actor, 'root', 'office');
    expect((await response.json()).teamActivity).toMatchObject({ status: 'unavailable', agents: [], authority: 'none' });
  });
  it.each(['', '?siteId=office&siteId=office', '?siteId=office&role=research', '?siteId='])('rejects invalid or ambiguous query %s without reading', async query => {
    const f = setup();expect((await f.get(query)).status).toBe(422);expect(f.repository.read).not.toHaveBeenCalled();
  });
  it('rejects missing site membership without a database read', async () => {
    const f = setup();f.session.actor.siteIds = [];
    expect((await f.get()).status).toBe(403);expect(f.repository.read).not.toHaveBeenCalled();
  });
  it('refuses mismatched database scope without disclosing its contents', async () => {
    const f = setup();f.frame.root.scope.organizationId = 'other';
    const response = await f.get();expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('Workshop');
  });
  it('reports unavailable service rather than synthesizing activity', async () => {
    const f = setup(false);expect((await f.get()).status).toBe(503);expect(f.repository.read).not.toHaveBeenCalled();
  });
  it('has no mutation route', async () => {
    const f = setup();expect((await f.app.request('/v1/agent-work/root/team-activity?siteId=office', { method: 'POST' })).status).toBe(404);
    expect(f.repository.read).not.toHaveBeenCalled();
  });
});
