import { expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import type { ActorContext } from '../../contracts/src/core';
import { PostgresNativeAgentWorkListRepository } from './native-agent-work-list-repository';
const actor: ActorContext = { environment: 'development', organizationId: 'org', actorId: 'person', principalKind: 'human', roles: ['owner'], siteIds: ['site'], actionSiteIds: ['site'], sessionId: 'session', authenticatedAt: '2026-11-18T00:00:00.000Z', correlationId: 'check' };
const scope = { environment: 'development', organizationId: 'org', siteId: 'site' };
const row = { id: 'work', title: 'Workshop', state: 'queued', createdAt: '2026-11-18T00:00:00.000Z', updatedAt: '2026-11-18T00:00:00.000Z', expiresAt: '2026-11-19T00:00:00.000Z' };
const query = { siteId: 'site', limit: 1, q: '', filter: 'all' as const };
const response = { scope, items: [row], next: null };
function fixture(value: unknown = response) {
  const sql = vi.fn(async (_statement: string, _parameters: unknown[]) => ({ rows: [{ response: value }] }));
  return { sql, repo: new PostgresNativeAgentWorkListRepository({ query: sql } as unknown as Pool, 'development') };
}
it('binds list pages and follow-up positions to the original actor and filters', async () => {
  const { sql, repo } = fixture({ ...response, next: { id: row.id, createdAt: row.createdAt } });
  const first = await repo.list(actor, query);
  sql.mockResolvedValueOnce({ rows: [{ response: { scope, items: [], next: null } }] });
  expect(await repo.list(actor, { ...query, cursor: first.nextCursor! })).toEqual({ scope, items: [], nextCursor: null });
  expect(sql.mock.calls[1]?.[1]).toEqual([actor, { ...query, after: { id: row.id, createdAt: row.createdAt } }]);
  for (const altered of [{ ...actor, actorId: 'peer' }, { ...actor, organizationId: 'elsewhere' }]) {
    await expect(repo.list(altered, { ...query, cursor: first.nextCursor! })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  }
  expect(sql).toHaveBeenCalledTimes(2);
});
it.each([
  { ...response, scope: { ...scope, organizationId: 'elsewhere' } },
  { ...response, scope: { ...scope, environment: 'production' } },
  { ...response, scope: { ...scope, siteId: 'elsewhere' } },
  { ...response, items: [row, row] },
  { ...response, items: [{ ...row, checkpoint: 'private' }] },
  { ...response, next: { id: 'other', createdAt: row.createdAt } },
  { ...response, items: [], next: { id: row.id, createdAt: row.createdAt } },
  { ...response, next: { id: row.id, createdAt: row.expiresAt } },
])('rejects an unbound, overfull or private database projection %#', async value => {
  await expect(fixture(value).repo.list(actor, query)).rejects.toMatchObject({ code: 'DURABLE_SERVICE_UNAVAILABLE' });
});
it('rejects a row outside the requested lifecycle filter', async () => {
  await expect(fixture().repo.list(actor, { ...query, filter: 'completed' })).rejects.toMatchObject({ code: 'DURABLE_SERVICE_UNAVAILABLE' });
  await expect(fixture({ ...response, items: [{ ...row, state: 'completed' }] }).repo.list(actor, { ...query, filter: 'active' })).rejects.toMatchObject({ code: 'DURABLE_SERVICE_UNAVAILABLE' });
});
it('never queries with a cross-environment or nonhuman actor', async () => {
  const { sql, repo } = fixture();
  for (const changed of [{ ...actor, environment: 'production' as const }, { ...actor, principalKind: 'service' as const }, { ...actor, siteIds: [] }]) await expect(repo.list(changed, query)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(sql).not.toHaveBeenCalled();
});
