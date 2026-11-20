import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { z } from 'zod';
import type { Session } from '@pactwoven/contracts';
import { DomainError } from '@pactwoven/domain';
import { NativeAgentAttentionPageSchema } from '../../../packages/contracts/src/native-agent-attention';
import type { NativeAgentWorkPage } from '../../../packages/contracts/src/native-agent-work';
import type { ApiEnv } from './app';
import { registerNativeAgentAttentionRoutes } from './native-agent-attention-routes';

const at = '2026-11-18T12:00:00Z';
const scope = { environment: 'development' as const, organizationId: 'org_one', siteId: 'site_one' };
const item = (id: string, state: NativeAgentWorkPage['items'][number]['state'] = 'working') => ({
  id, title: `Workshop plan ${id}`, state, createdAt: at, updatedAt: at, expiresAt: '2026-11-19T12:00:00Z',
});
function fixture() {
  const session: Session = { actor: { actorId: 'operator', principalKind: 'human', organizationId: scope.organizationId,
    environment: scope.environment, roles: ['owner'], siteIds: [scope.siteId], actionSiteIds: [scope.siteId],
    sessionId: 'session', authenticatedAt: at, correlationId: 'test' },
    organization: { id: scope.organizationId, name: 'Workshop', authorityEpoch: 1 },
    sites: [{ id: scope.siteId, name: 'Main workshop', timeZone: 'America/Chicago' }] };
  const lists = { list: vi.fn(async (): Promise<NativeAgentWorkPage> => ({ scope, items: [], nextCursor: null })) };
  const app = new Hono<ApiEnv>();
  app.use('*', async (c, next) => { c.set('session', session); await next(); });
  app.onError((error, c) => error instanceof DomainError ? c.json({ error: { code: error.code, message: error.message } }, error.status) :
    c.json({ error: { code: error instanceof z.ZodError ? 'VALIDATION_FAILED' : 'UNAVAILABLE' } }, error instanceof z.ZodError ? 422 : 503));
  registerNativeAgentAttentionRoutes(app, lists);
  app.get('/v1/agent-work/:id', c => c.json({ dynamic: c.req.param('id') }));
  return { app, session, lists, get: (query = '?siteId=site_one') => app.request('/v1/agent-work/attention' + query) };
}

describe('scoped work attention inbox', () => {
  it('keeps older attention reachable after more than fifty ordinary records', async () => {
    const f = fixture();
    f.lists.list.mockResolvedValueOnce({ scope, items: Array.from({ length: 50 }, (_, i) => item(`new_${i}`)), nextCursor: 'page_two' });
    f.lists.list.mockResolvedValueOnce({ scope, items: Array.from({ length: 50 }, (_, i) => item(`middle_${i}`)), nextCursor: 'page_three' });
    f.lists.list.mockResolvedValueOnce({ scope, items: [item('old_attention', 'needs_review')], nextCursor: null });
    const first = await f.get('?siteId=site_one&limit=50');
    expect(first.status).toBe(200); expect(first.headers.get('cache-control')).toBe('private, no-store');
    expect(await first.json()).toEqual({ scope, items: [], nextCursor: 'page_two', scannedCount: 50, scanComplete: false });
    const second = await f.get('?siteId=site_one&limit=50&cursor=page_two');
    expect(await second.json()).toEqual({ scope, items: [], nextCursor: 'page_three', scannedCount: 50, scanComplete: false });
    const third = await f.get('?siteId=site_one&limit=50&cursor=page_three');
    expect(await third.json()).toEqual({ scope, items: [item('old_attention', 'needs_review')], nextCursor: null, scannedCount: 1, scanComplete: true });
    expect(f.lists.list.mock.calls).toEqual([
      [f.session.actor, { siteId: 'site_one', limit: 50, q: '', filter: 'active' }],
      [f.session.actor, { siteId: 'site_one', limit: 50, q: '', filter: 'active', cursor: 'page_two' }],
      [f.session.actor, { siteId: 'site_one', limit: 50, q: '', filter: 'active', cursor: 'page_three' }],
    ]);
  });
  it('uses default bounds and returns no invented approvals or runnable actions', async () => {
    const f = fixture(); f.lists.list.mockResolvedValue({ scope, items: [item('problem', 'needs_review'), item('paused', 'paused')], nextCursor: null });
    const response = await f.get(); expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ scope, items: [item('problem', 'needs_review')], nextCursor: null, scannedCount: 2, scanComplete: true });
    expect(f.lists.list).toHaveBeenCalledExactlyOnceWith(f.session.actor, { siteId: 'site_one', limit: 20, q: '', filter: 'active' });
  });
  it('does not turn ordinary queued or working tasks into attention requests', async () => {
    const f = fixture(); f.lists.list.mockResolvedValue({ scope, items: [item('queued', 'queued'), item('working', 'working')], nextCursor: null });
    expect((await (await f.get()).json()).items).toEqual([]);
  });
  it.each(['?siteId=site_one&siteId=other', '?siteId=site_one&filter=all', '?siteId=site_one&q=private',
    '?siteId=site_one&actorId=other', '?siteId=site_one&limit=51', '?siteId=site_one&limit=0', '?siteId=site_one&cursor=!'])('rejects altered query %s before storage', async query => {
    const f = fixture(); expect((await f.get(query)).status).toBe(422); expect(f.lists.list).not.toHaveBeenCalled();
  });
  it('denies a foreign site before storage', async () => {
    const f = fixture(); expect((await f.get('?siteId=other')).status).toBe(403); expect(f.lists.list).not.toHaveBeenCalled();
  });
  it('allows read access without granting write permission', async () => {
    const f = fixture(); f.session.actor.actionSiteIds = []; expect((await f.get()).status).toBe(200);
  });
  it.each([
    { scope: { ...scope, organizationId: 'other' } }, { scope: { ...scope, siteId: 'other' } },
    { scope: { ...scope, environment: 'staging' } }, { items: [item('duplicate'), item('duplicate')] },
    { items: [item('done', 'completed')] }, { items: [item('stopped', 'cancelled')] },
    { items: [item('one')], nextCursor: 'short_page' },
    { items: Array.from({ length: 21 }, (_, i) => item(`too_many_${i}`)) },
  ])('rejects malformed authoritative page %j', async change => {
    const f = fixture(); f.lists.list.mockResolvedValue({ scope, items: [], nextCursor: null, ...change } as NativeAgentWorkPage);
    expect((await f.get()).status).toBe(503);
  });
  it('rejects a repeated scan cursor without looping', async () => {
    const f = fixture(); f.lists.list.mockResolvedValue({ scope, items: [item('one')], nextCursor: 'same_cursor' });
    expect((await f.get('?siteId=site_one&limit=1&cursor=same_cursor')).status).toBe(503); expect(f.lists.list).toHaveBeenCalledOnce();
  });
  it.each([403, 422, 503] as const)('sanitizes storage errors with status %s', async status => {
    const f = fixture(); f.lists.list.mockRejectedValue(new DomainError('PRIVATE_STORAGE_CODE', status, 'private-storage-detail'));
    const response = await f.get(); expect(response.status).toBe(status); const text = await response.text();
    expect(text).not.toContain('private-storage-detail'); expect(text).not.toContain('PRIVATE_STORAGE_CODE');
  });
  it('places static attention before task IDs', async () => {
    const f = fixture(); expect((await (await f.get()).json()).scanComplete).toBe(true);
    expect(await (await f.app.request('/v1/agent-work/saved_task')).json()).toEqual({ dynamic: 'saved_task' });
  });
  it('marks a zero-record terminal page complete without inventing items', async () => {
    const f = fixture(); expect(await (await f.get()).json()).toEqual({ scope, items: [], nextCursor: null, scannedCount: 0, scanComplete: true });
  });
  it('rejects contradictory client projection envelopes', () => {
    const base = { scope, items: [], nextCursor: null, scannedCount: 0, scanComplete: true };
    expect(NativeAgentAttentionPageSchema.safeParse(base).success).toBe(true);
    for (const change of [{ scanComplete: false }, { nextCursor: 'more' }, { items: [item('one', 'needs_review')] }]) {
      expect(NativeAgentAttentionPageSchema.safeParse({ ...base, ...change }).success).toBe(false);
    }
  });
});
