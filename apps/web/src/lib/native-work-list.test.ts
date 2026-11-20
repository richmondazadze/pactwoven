import { expect, it } from 'vitest';
import { workListPath, workListSchema } from './native-work-list';
const scope = { apiBase: 'https://work.example', environment: 'development' as const, organizationId: 'org', actorId: 'operator', sessionId: 'session', siteId: 'site' };
const row = { id: 'work', title: 'Workshop', state: 'queued', createdAt: '2026-11-18T00:00:00.000Z', updatedAt: '2026-11-18T00:00:00.000Z', expiresAt: '2026-11-19T00:00:00.000Z' };
const page = { scope: { environment: 'development', organizationId: 'org', siteId: 'site' }, items: [row], nextCursor: null };
it('encodes search as data and keeps the site, limit and continuation explicit', () => {
  const url = new URL(workListPath('site', '  100% & paid  ', 'active', 'next_cursor'), 'https://work.example');
  expect(url.pathname).toBe('/v1/agent-work');
  expect(Object.fromEntries(url.searchParams)).toEqual({ siteId: 'site', limit: '20', q: '100% & paid', filter: 'active', cursor: 'next_cursor' });
});
it('rejects wrong scope, hidden fields, duplicate roots, filter mismatches and repeating cursors', () => {
  const schema = workListSchema(scope, 'active', 'current');
  expect(schema.safeParse(page).success).toBe(true);
  for (const invalid of [{ ...page, scope: { ...page.scope, siteId: 'other' } }, { ...page, scope: { ...page.scope, organizationId: 'other' } },
    { ...page, items: [row, row] }, { ...page, items: [{ ...row, state: 'completed' }] }, { ...page, items: [{ ...row, internal: 'private' }] }, { ...page, nextCursor: 'current' }]) expect(schema.safeParse(invalid).success).toBe(false);
});
