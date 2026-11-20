import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import type { ActorContext } from '../../contracts/src/core';
import { PostgresNativeWorkIntentRepository } from './native-work-intent-repository';
import { PostgresNativeAgentWorkListRepository } from './native-agent-work-list-repository';
import { PostgresNativeDelegationRepository } from './native-delegation-repository';
const url = process.env.PACTWOVEN_AGENT_WORK_LIST_TEST_DATABASE_URL;
const at = (offset = 0) => new Date(Date.now() + offset).toISOString();
const identity = (serviceId: string) => ({ serviceId, serviceVersion: 1, workloadIdentityId: serviceId });
const issuer = 'https://list-fixture.clerk.accounts.dev';
describe.skipIf(!url)('agent work metadata list PostgreSQL', () => {
  let admin: Pool, api: Pool, list: PostgresNativeAgentWorkListRepository, work: PostgresNativeWorkIntentRepository, actor: ActorContext;
  const suffix = randomUUID().slice(0, 8), role = 'list_api_' + suffix;
  beforeAll(async () => {
    const u = new URL(url!);
    if (!['127.0.0.1', 'localhost'].includes(u.hostname) || !u.pathname.startsWith('/pactwoven_native_agent_work_list_')) throw Error('Dedicated local list fixture required.');
    admin = new Pool({ connectionString: u.href, max: 2 });
    await admin.query("UPDATE pactwoven.native_delegation_services SET enabled=false WHERE environment='development'");
    const password = randomBytes(32).toString('base64url');
    const sql = (await admin.query("SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD %L', $1::text, $2::text) AS sql", [role, password])).rows[0].sql;
    await admin.query(sql);await admin.query(`GRANT pactwoven_native_delegation_api TO ${role}`);
    for (const purpose of ['api', 'coordinator', 'worker']) {
      const id = purpose === 'api' ? role : 'list_' + purpose + '_' + suffix;
      await admin.query("INSERT INTO pactwoven.native_delegation_services VALUES('development',$1,$2::jsonb,$3,true)", [id, identity(id), purpose]);
    }
    await admin.query("INSERT INTO pactwoven.native_delegation_service_bindings SELECT rolname,oid,'development','api',$1,true FROM pg_roles WHERE rolname::text=$1", [role]);
    await admin.query("INSERT INTO pactwoven.native_provider_instances VALUES('development',$1,true) ON CONFLICT(environment) DO UPDATE SET issuer=EXCLUDED.issuer,enabled=true", [issuer]);
    u.username = role;u.password = password; api = new Pool({ connectionString: u.href, max: 2 });
    list = new PostgresNativeAgentWorkListRepository(api, 'development');work = new PostgresNativeWorkIntentRepository(api, 'development');
  });
  beforeEach(async () => {
    const org = randomUUID(), aid = randomUUID(), site = randomUUID();
    await admin.query("INSERT INTO pactwoven.organizations(environment,id,external_organization_id,name) VALUES('development',$1,$1,'List fixture')", [org]);
    await admin.query("INSERT INTO pactwoven.memberships(environment,organization_id,actor_id,external_subject,external_membership_id,grant_basis,roles,display_name) VALUES('development',$1,$2,$2,$3,'internal',ARRAY['owner'],'Operator')", [org, aid, randomUUID()]);
    await admin.query("INSERT INTO pactwoven.sites(environment,organization_id,id,name,time_zone) VALUES('development',$1,$2,'Office','UTC')", [org, site]);
    await admin.query("INSERT INTO pactwoven.member_action_sites VALUES('development',$1,$2,$3)", [org, aid, site]);
    await admin.query("INSERT INTO pactwoven.native_delegation_policies VALUES('development',$1,1,true)", [org]);
    actor = { environment: 'development', organizationId: org, actorId: aid, principalKind: 'human', roles: ['owner'], siteIds: [site], actionSiteIds: [site], sessionId: randomUUID(), authenticatedAt: at(-1000), correlationId: randomUUID() };
  });
  afterAll(async () => { await Promise.allSettled([api, admin].filter(Boolean).map(p => p.end())); });
  const query = (changes = {}) => ({ siteId: actor.siteIds[0]!, limit: 2, q: '', filter: 'all' as const, ...changes });
  const create = async (title: string) => {
    const key = randomUUID(), input = { siteId: actor.siteIds[0]!, title, prompt: 'Advice only.', selections: [], continuesAfterSignOut: true as const };
    const p = await work.prepare(actor, key, input);
    return work.confirm(actor, key, { reviewId: p.review.id, reviewToken: p.review.token, continuesAfterSignOut: true }, { providerIssuer: issuer, sessionVerifiedAt: at(), sessionExpiresAt: at(60000) });
  };
  it('returns an empty scoped page before any work has been issued', async () => {
    expect(await list.list(actor, query())).toEqual({ scope: { environment: actor.environment, organizationId: actor.organizationId, siteId: actor.siteIds[0] }, items: [], nextCursor: null });
  });
  it('pages through original roots exactly once without exposing their inert legacy rows or private bodies', async () => {
    const issued = [];for (const title of ['First', 'Second', 'Third', 'Fourth', 'Fifth']) issued.push(await create(title));
    const ids: string[] = [];let cursor: string | undefined;
    for (let i = 0; i < 4; i++) {
      const page = await list.list(actor, query(cursor ? { cursor } : {}));
      for (const item of page.items) { ids.push(item.id);expect(Object.keys(item).sort()).toEqual(['createdAt', 'expiresAt', 'id', 'state', 'title', 'updatedAt']); }
      if (!page.nextCursor) break;cursor = page.nextCursor;
    }
    expect(new Set(ids).size).toBe(5);expect(ids).toEqual(issued.map(o => o.rootTaskId).reverse());
    const provenance = (await admin.query('SELECT provenance_id FROM pactwoven.native_work_intent_operations WHERE organization_id=$1', [actor.organizationId])).rows;
    expect(ids.some(id => provenance.some(row => row.provenance_id === id))).toBe(false);
  });
  it('treats wildcard characters as literal title text', async () => {
    await create('Workshop 100%_ready');await create('Workshop ordinary');
    expect((await list.list(actor, query({ q: '%_' }))).items.map(i => i.title)).toEqual(['Workshop 100%_ready']);
    expect((await list.list(actor, query({ q: 'WORKSHOP' }))).items).toHaveLength(2);
  });
  it('pages roots sharing one committed millisecond exactly once using the ID tie-breaker', async () => {
    const issued = [];for (const title of ['A', 'B', 'C', 'D', 'E']) issued.push(await create(title));
    // Local-only superuser fixture setup bypasses the immutable-record trigger
    // solely to arrange identical timestamp metadata. This is not an API write.
    const setup = await admin.connect();
    try { await setup.query('BEGIN');await setup.query('SET LOCAL session_replication_role=replica');
      await setup.query("UPDATE pactwoven.native_work_intent_operations SET committed_at=date_trunc('milliseconds',statement_timestamp()) WHERE organization_id=$1", [actor.organizationId]);
      await setup.query('COMMIT');
    } catch (error) { await setup.query('ROLLBACK');throw error; } finally { setup.release(); }
    const seen: string[] = [];let cursor: string | undefined;
    for (let pageNumber = 0; pageNumber < 4; pageNumber++) {
      const page = await list.list(actor, query(cursor ? { cursor } : {}));seen.push(...page.items.map(item => item.id));
      if (!page.nextCursor) break;cursor = page.nextCursor;
    }
    expect(seen).toEqual(issued.map(item => item.rootTaskId).sort().reverse());
    expect(new Set(seen).size).toBe(issued.length);
  });
  it('shows the actual cancellation caused by revocation without disclosing protected content', async () => {
    const created = await create('Revoked work');
    const { grant_id } = (await admin.query('SELECT grant_id FROM pactwoven.native_work_intent_operations WHERE root_task_id=$1', [created.rootTaskId])).rows[0];
    await new PostgresNativeDelegationRepository(api, 'development').revoke(actor, { grantId: grant_id, requestKey: randomUUID(), expectedVersion: 1, expectedRevocationEpoch: 0 });
    expect((await list.list(actor, query())).items[0]).toMatchObject({ id: created.rootTaskId, state: 'cancelled' });
    expect((await list.list(actor, query({ filter: 'active' }))).items).toEqual([]);
  });
  it.each(['expired', 'mismatched'] as const)('marks an admin-arranged %s grant state as needing review', async state => {
    const created = await create('Review work');
    // These are deliberately malformed stored-state probes of list projection,
    // not evidence that the public grant API permits rewriting authority.
    if (state === 'expired') await admin.query("UPDATE pactwoven.native_delegation_grants SET body=jsonb_set(body,'{expiresAt}',to_jsonb($2::text)) WHERE id=(SELECT grant_id FROM pactwoven.native_work_intent_operations WHERE root_task_id=$1)", [created.rootTaskId, at(-60000)]);
    else await admin.query("UPDATE pactwoven.native_delegation_tasks SET authority=jsonb_set(authority,'{grantVersion}','2') WHERE id=$1", [created.rootTaskId]);
    expect((await list.list(actor, query())).items[0]).toMatchObject({ id: created.rootTaskId, state: 'needs_review' });
  });
  it.each(['organization', 'site'] as const)('rechecks current %s availability before showing retained metadata', async withdrawn => {
    await create('Restricted work');
    if (withdrawn === 'organization') await admin.query("UPDATE pactwoven.organizations SET status='suspended' WHERE id=$1", [actor.organizationId]);
    else await admin.query('UPDATE pactwoven.financial_site_fences SET active=false,generation=generation+1 WHERE organization_id=$1 AND site_id=$2', [actor.organizationId, actor.siteIds[0]]);
    await expect(list.list(actor, query())).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('keeps an older-page cursor stable when new work arrives', async () => {
    await create('Oldest');await create('Middle');await create('Newest');
    const first = await list.list(actor, query());const later = await create('Just arrived');
    const second = await list.list(actor, query({ cursor: first.nextCursor! }));
    expect(second.items.map(i => i.title)).toEqual(['Oldest']);
    expect((await list.list(actor, query())).items[0]?.id).toBe(later.rootTaskId);
  });
  it('rejects cross-site, cross-filter and malformed cursor reuse', async () => {
    await create('One');await create('Two');const page = await list.list(actor, query({ limit: 1 }));
    for (const change of [{ filter: 'active' }, { q: 'One' }]) {
      await expect(list.list(actor, query({ cursor: page.nextCursor!, ...change }))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    }
    await expect(list.list(actor, query({ cursor: page.nextCursor + '=' }))).rejects.toMatchObject({ name: 'ZodError' });
    await expect(list.list({ ...actor, siteIds: [...actor.siteIds, 'another'] }, query({ siteId: 'another', cursor: page.nextCursor! }))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
  it('applies lifecycle filters using stored states and reflects cancellation', async () => {
    const one = await create('Cancelled'), two = await create('Completed'), three = await create('Active');
    await api.query('SELECT pactwoven.native_delegation_root_control($1::jsonb,$2,$3::jsonb)', [actor, randomUUID(), { rootTaskId: one.rootTaskId, expectedVersion: 1, action: 'cancel' }]);
    // Explicit admin-seeded terminal metadata tests listing only, not execution.
    await admin.query("UPDATE pactwoven.native_delegation_root_runs SET phase='completed' WHERE root_task_id=$1", [two.rootTaskId]);
    expect((await list.list(actor, query({ filter: 'completed' }))).items.map(i => i.id)).toEqual([two.rootTaskId]);
    expect((await list.list(actor, query({ filter: 'active' }))).items.map(i => i.id)).toEqual([three.rootTaskId]);
  });
  it('rechecks current human membership on every page', async () => {
    await create('Private work');await admin.query("UPDATE pactwoven.memberships SET status='revoked' WHERE organization_id=$1 AND actor_id=$2", [actor.organizationId, actor.actorId]);
    await expect(list.list(actor, query())).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('does not disclose another operator work in the same site', async () => {
    await create('Original operator');const peer = randomUUID();
    await admin.query("INSERT INTO pactwoven.memberships(environment,organization_id,actor_id,external_subject,external_membership_id,grant_basis,roles,display_name) VALUES('development',$1,$2,$2,$3,'internal',ARRAY['owner'],'Peer')", [actor.organizationId, peer, randomUUID()]);
    const other = { ...actor, actorId: peer, sessionId: randomUUID() };
    expect((await list.list(other, query())).items).toEqual([]);
  });
  it('rejects direct SQL selector tampering and direct table reads', async () => {
    await expect(api.query('SELECT pactwoven.native_agent_work_list($1::jsonb,$2::jsonb)', [actor, { ...query(), after: null, organizationId: 'foreign' }])).rejects.toMatchObject({ code: 'NW004' });
    await expect(api.query('SELECT * FROM pactwoven.native_work_intent_operations')).rejects.toMatchObject({ code: '42501' });
  });
});
