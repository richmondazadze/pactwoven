import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { ZodError } from 'zod';
import { DomainError } from '@pactwoven/domain';
import type { Session } from '@pactwoven/contracts';
import type { ApiEnv } from './app';
import type { NativePaidContributors } from '../../../packages/contracts/src/native-paid-contributors';
import { registerNativePaidQuoteRoutes, isNativePaidQuoteRoute } from './native-paid-quote-routes';

function fixture() {
  const session: Session = { actor: { environment: 'development', organizationId: 'org', actorId: 'human', principalKind: 'human', roles: ['owner'], siteIds: ['site'], actionSiteIds: ['site'], sessionId: 'session', authenticatedAt: '2026-11-19T00:00:00Z', correlationId: 'test' }, organization: { id: 'org', name: 'Company', authorityEpoch: 1 }, sites: [{ id: 'site', name: 'Office', timeZone: 'UTC' }] };
  const frame: NativePaidContributors = { scope: { environment: 'development', organizationId: 'org', siteId: 'site' }, rootTaskId: 'root', instructionRevision: 0, rootGeneration: 2, controlVersion: 1, checkpointVersion: 1, observedAt: '2026-11-19T00:00:02Z', availableUntil: '2026-11-19T00:00:12Z', state: 'recorded', quoteId: 'quote', active: false, contributors: [{ id: 'a'.repeat(32), role: 'research', status: 'recorded', completedAt: '2026-11-19T00:00:01Z' }] };
  const read = vi.fn(async () => frame), gateway = { discover: vi.fn(), review: vi.fn(), approve: vi.fn(), recover: vi.fn() };
  const app = new Hono<ApiEnv>();
  app.use('*', async (c, next) => { if (c.req.header('authorization') !== 'Bearer fixture') return c.json({ error: 'UNAUTHENTICATED' }, 401); c.set('session', session); await next(); });
  app.onError((e, c) => e instanceof DomainError ? c.json({ error: e.code }, e.status as 403 | 409 | 503) : e instanceof ZodError ? c.json({ error: 'VALIDATION_FAILED' }, 422) : c.json({ error: 'UNEXPECTED' }, 500));
  registerNativePaidQuoteRoutes(app, gateway, { read });
  const request = (query = '?siteId=site', method = 'GET', authenticated = true) => app.request('/v1/agent-work/root/equipment/contributors' + query, { method, headers: authenticated ? { authorization: 'Bearer fixture' } : {} });
  return { session, frame, read, gateway, request };
}

describe('independent passive contributor HTTP boundary', () => {
  it('returns bounded passive metadata with private no-store and never nudges or pays', async () => {
    const f = fixture(), response = await f.request();
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('private, no-store'); expect(await response.json()).toEqual(f.frame);
    expect(f.read).toHaveBeenCalledExactlyOnceWith(f.session.actor, 'root', 'site');
    for (const operation of Object.values(f.gateway)) expect(operation).not.toHaveBeenCalled();
  });
  it('rejects unauthenticated requests before reading', async () => { const f = fixture(); expect((await f.request(undefined, 'GET', false)).status).toBe(401); expect(f.read).not.toHaveBeenCalled(); });
  it.each(['simulation', 'service', 'actor_site', 'session_site'])('rejects %s scope before reading', async kind => {
    const f = fixture();
    if (kind === 'simulation') f.session.actor.environment = 'simulation';
    if (kind === 'service') f.session.actor.principalKind = 'service';
    if (kind === 'actor_site') f.session.actor.siteIds = [];
    if (kind === 'session_site') f.session.sites = [];
    expect((await f.request()).status).toBe(403); expect(f.read).not.toHaveBeenCalled();
  });
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('has no contributor mutation for %s', async method => {
    const f = fixture(); expect(isNativePaidQuoteRoute('/v1/agent-work/root/equipment/contributors', method)).toBe(false);
    expect((await f.request(undefined, method)).status).toBe(404); expect(f.read).not.toHaveBeenCalled(); for (const operation of Object.values(f.gateway)) expect(operation).not.toHaveBeenCalled();
  });
  it.each(['', '?siteId=site&siteId=site', '?siteId=site&organizationId=org', '?siteId=site&nudge=true'])('rejects ambiguous or excess query %s', async query => { const f = fixture(); expect((await f.request(query)).status).toBe(422); expect(f.read).not.toHaveBeenCalled(); });
  it.each(['root', 'organization', 'site'])('withholds substituted %s response', async kind => {
    const f = fixture(); if (kind === 'root') f.frame.rootTaskId = 'foreign'; if (kind === 'organization') f.frame.scope.organizationId = 'foreign'; if (kind === 'site') f.frame.scope.siteId = 'foreign';
    const response = await f.request(); expect(response.status).toBe(409); expect(await response.text()).not.toContain('research'); expect(response.headers.get('cache-control')).toBe('private, no-store');
  });
  it.each(['active', 'pointer', 'prose', 'future', 'unbounded'])('withholds misleading %s metadata', async kind => {
    const f = fixture(); if (kind === 'active') Object.assign(f.frame, { active: true }); if (kind === 'pointer') Object.assign(f.frame, { pointer: { x: 1, y: 2 } }); if (kind === 'prose') Object.assign(f.frame.contributors[0]!, { body: 'private model output' }); if (kind === 'future') f.frame.contributors[0]!.completedAt = f.frame.availableUntil!; if (kind === 'unbounded') f.frame.availableUntil = '2026-11-19T00:01:00Z';
    const response = await f.request(); expect(response.status).toBe(422); expect(await response.text()).not.toMatch(/research|private model output/);
  });
});
