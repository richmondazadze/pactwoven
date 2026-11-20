import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActorContext, NativeTaskClaim, NativeTaskProgress, NativeTaskSearchQuery } from '@pactwoven/contracts';
import { PostgresNativeTaskRepository, PostgresNativeTaskWorkerRepository } from './native-task-repository.js';
import { assertNativeTaskPool, createNativeTaskPool } from './native-task-pool.js';

const adminUrl = process.env.PACTWOVEN_NATIVE_TEST_DATABASE_URL;
const key = () => randomUUID();
const update = (status: 'running' | 'completed' = 'running'): NativeTaskProgress => ({
  phase: status === 'completed' ? 'Finished' : 'Comparing sources', status,
  event: { kind: status === 'completed' ? 'completed' : 'progress', title: 'Sources compared', detail: 'Two references checked.', agent: 'research' },
  checkpoint: { schemaVersion: 1, phase: 'research', inputGeneration: 1 },
});
const failure = (): NativeTaskProgress => ({ ...update(), status: 'failed', phase: 'Source connection unavailable',
  event: { kind: 'failed', title: 'Source connection unavailable', detail: 'Three connection attempts did not succeed.', agent: 'research' } });
const retrieved = (until = Date.now() + 60_000, observed = Date.now() - 1_000) => ({
  id: 'source1', title: 'Chair reference', text: 'A current chair specification.', origin: 'retrieved',
  source: { title: 'Chair reference', url: 'https://example.com/chair' },
  observedAt: new Date(observed).toISOString(), validUntil: new Date(until).toISOString(),
});
const completion = (until = Date.now() + 60_000): NativeTaskProgress => ({
  ...update('completed'), evidenceValidUntil: new Date(until).toISOString(),
  checkpoint: { schemaVersion: 2, documents: [retrieved(until)], attempts: { research: 1 }, usage: { inputTokens: 20, outputTokens: 10 } },
  message: { id: 'final-message', role: 'assistant', text: 'The current comparison is ready.' },
  artifact: { id: 'final-report', kind: 'report', title: 'Chair recommendation', text: 'A current recommendation.',
    sources: [{ title: 'Chair reference', url: 'https://example.com/chair' }] },
});

// Tests use a dedicated disposable database only. The admin address is never
// used by production services and this suite does not touch historical fixtures.
describe.skipIf(!adminUrl)('native task PostgreSQL authority and durability', () => {
  let admin: Pool, apiPool: Pool, workerPool: Pool;
  let api: PostgresNativeTaskRepository, worker: PostgresNativeTaskWorkerRepository;
  let actor: ActorContext;
  let other: ActorContext;
  const ownOrganizations: string[] = [];
  beforeAll(async () => {
    const url = new URL(adminUrl!);
    if (!url.pathname.startsWith('/pactwoven_native_') || !['127.0.0.1', 'localhost'].includes(url.hostname)) {
      throw new Error('Native-task integration tests require a dedicated local pactwoven_native_* database.');
    }
    admin = new Pool({ connectionString: adminUrl, max: 3 });
    await admin.query(`DO $$ BEGIN
      IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='pactwoven_native_test_api') THEN CREATE ROLE pactwoven_native_test_api LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE; END IF;
      IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='pactwoven_native_test_worker') THEN CREATE ROLE pactwoven_native_test_worker LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE; END IF;
    END $$;
    GRANT pactwoven_native_task_api TO pactwoven_native_test_api;
    GRANT pactwoven_native_task_worker TO pactwoven_native_test_worker;
    INSERT INTO pactwoven.native_task_service_bindings(role_name,role_oid,environment,purpose)
      SELECT rolname,oid,'simulation',CASE rolname WHEN 'pactwoven_native_test_api' THEN 'api' ELSE 'worker' END FROM pg_roles
      WHERE rolname IN ('pactwoven_native_test_api','pactwoven_native_test_worker')
      ON CONFLICT(role_name,environment,purpose) DO UPDATE SET role_oid=excluded.role_oid,enabled=true;`);
    // CI injects disposable credentials; local tests can generate their own.
    // PostgreSQL quotes values rather than interpolating caller-supplied text.
    const suppliedApiPassword = process.env.PACTWOVEN_NATIVE_TEST_API_PASSWORD;
    const suppliedWorkerPassword = process.env.PACTWOVEN_NATIVE_TEST_WORKER_PASSWORD;
    if ((process.env.CI === 'true' && (!suppliedApiPassword || !suppliedWorkerPassword)) ||
      Boolean(suppliedApiPassword) !== Boolean(suppliedWorkerPassword)) throw new Error('Both isolated native test passwords are required for CI.');
    const apiPassword = suppliedApiPassword ?? randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
    const workerPassword = suppliedWorkerPassword ?? randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
    for (const [role, password] of [['pactwoven_native_test_api', apiPassword], ['pactwoven_native_test_worker', workerPassword]]) {
      const quoted = await admin.query<{ statement: string }>("SELECT format('ALTER ROLE %I PASSWORD %L',$1::text,$2::text) AS statement", [role, password]);
      await admin.query(quoted.rows[0]!.statement);
    }
    const apiUrl = new URL(url); apiUrl.username = 'pactwoven_native_test_api'; apiUrl.password = apiPassword;
    const workerUrl = new URL(url); workerUrl.username = 'pactwoven_native_test_worker'; workerUrl.password = workerPassword;
    apiPool = await createNativeTaskPool(apiUrl.toString(), 'simulation', 'api');
    workerPool = await createNativeTaskPool(workerUrl.toString(), 'simulation', 'worker');
    api = new PostgresNativeTaskRepository(apiPool, 'simulation'); worker = new PostgresNativeTaskWorkerRepository(workerPool, 'simulation');
  });
  async function fixture(): Promise<ActorContext> {
    const org = `native_${randomUUID()}`; const aid = randomUUID(); const site = randomUUID();
    ownOrganizations.push(org);
    await admin.query("INSERT INTO pactwoven.organizations(environment,id,external_organization_id,name) VALUES('simulation',$1,$1,'Native test company')", [org]);
    await admin.query("INSERT INTO pactwoven.memberships(environment,organization_id,actor_id,external_subject,roles) VALUES('simulation',$1,$2,$2,ARRAY['owner'])", [org, aid]);
    await admin.query("INSERT INTO pactwoven.sites(environment,organization_id,id,name,time_zone) VALUES('simulation',$1,$2,'Test office','America/Chicago')", [org, site]);
    await admin.query("INSERT INTO pactwoven.member_action_sites(environment,organization_id,actor_id,site_id) VALUES('simulation',$1,$2,$3)", [org, aid, site]);
    return { actorId: aid, principalKind: 'human', organizationId: org, environment: 'simulation', roles: ['owner'],
      siteIds: [site], actionSiteIds: [site], sessionId: randomUUID(), authenticatedAt: new Date().toISOString(), correlationId: randomUUID() };
  }
  beforeEach(async () => { actor = await fixture(); other = await fixture(); });
  afterEach(async () => {
    if (admin && ownOrganizations.length) await admin.query("UPDATE pactwoven.native_tasks SET status='cancelled',lease_token=NULL,lease_until=NULL,worker_id=NULL WHERE environment='simulation' AND organization_id=ANY($1::text[])", [ownOrganizations]);
  });
  afterAll(async () => { await Promise.allSettled([apiPool?.end(), workerPool?.end(), admin?.end()]); });
  const create = (a = actor, requestKey = key(), prompt = 'Compare three chairs for Friday.') => api.create(a, requestKey, { prompt, siteId: a.actionSiteIds[0]!, mode: 'advise' });
  async function claim(): Promise<NativeTaskClaim> { const c = await worker.claim('test_worker', 30_000); expect(c).not.toBeNull(); return c!; }
  const search = (a = actor, query: Partial<NativeTaskSearchQuery> = {}) => api.search(a, { limit: 50, q: '', filter: 'all', ...query });
  async function history(count: number, a = actor) {
    await admin.query(`INSERT INTO pactwoven.native_tasks(environment,organization_id,actor_id,session_id,site_id,id,title,prompt,status,phase,created_at)
      SELECT 'simulation',$1,$2,$3,$4,'history_'||lpad(n::text,3,'0'),
        CASE WHEN n=1 THEN 'Archived Needle 100%_available' ELSE 'Task '||n END,'A saved task','queued','Ready to start',
        '2026-01-01T00:00:00.123456Z'::timestamptz FROM generate_series(1,$5::int)n`,
    [a.organizationId, a.actorId, a.sessionId, a.siteIds[0], count]);
  }
  const directProgress = (c: NativeTaskClaim, value: unknown) => workerPool.query(
    "SELECT pactwoven.native_task_lease($1,$2,$3,$4::uuid,'progress',NULL,$5::jsonb) AS response",
    [c.environment, c.organizationId, c.task.id, c.leaseToken, JSON.stringify(value)]);
  async function durableState(id: string) {
    const response = await admin.query(`SELECT jsonb_build_object(
      'task',(SELECT to_jsonb(t) FROM pactwoven.native_tasks t WHERE organization_id=$1 AND id=$2),
      'messages',(SELECT jsonb_agg(to_jsonb(m) ORDER BY ordinal) FROM pactwoven.native_task_messages m WHERE organization_id=$1 AND task_id=$2),
      'artifacts',(SELECT jsonb_agg(to_jsonb(a) ORDER BY ordinal) FROM pactwoven.native_task_artifacts a WHERE organization_id=$1 AND task_id=$2),
      'events',(SELECT jsonb_agg(to_jsonb(e) ORDER BY sequence) FROM pactwoven.native_task_events e WHERE organization_id=$1 AND task_id=$2),
      'outbox',(SELECT jsonb_agg(to_jsonb(d) ORDER BY generation) FROM pactwoven.native_dispatch_outbox d WHERE organization_id=$1 AND task_id=$2)) AS state`,
    [actor.organizationId, id]);
    return response.rows[0]!.state;
  }

  it('publishes a current v2 final checkpoint and its exact result together', async () => {
    const task = await create(); const c = await claim(); const final = completion();
    expect(await worker.progress(c, final)).toBe(true);
    const result = await api.get(actor, task.id); expect(result.status).toBe('completed');
    expect(result.messages.at(-1)!.id).toBe('final-message'); expect(result.artifacts[0]!.id).toBe('final-report');
    const state = await durableState(task.id); expect(state.task.checkpoint).toEqual(final.checkpoint);
    expect(state.task.lease_token).toBeNull(); expect(state.events.at(-1).kind).toBe('completed');
  });
  it('rejects an expired final without changing any durable record and lets the same claim refresh', async () => {
    const task = await create(); const c = await claim(); await worker.progress(c, update());
    const before = await durableState(task.id);
    const final = completion(Date.now() - 200);
    await expect(worker.progress(c, final)).rejects.toMatchObject({ code: 'EVIDENCE_STALE', status: 409 });
    expect(await durableState(task.id)).toEqual(before);
    expect(await worker.progress(c, { ...update(), checkpoint: { schemaVersion: 2, documents: [], refreshes: 1 } })).toBe(true);
    expect((await durableState(task.id)).task.checkpoint).toEqual({ schemaVersion: 2, documents: [], refreshes: 1 });
  });
  it('rechecks evidence after waiting for the task lock instead of publishing stale work', async () => {
    const task = await create(); const c = await claim(); const before = await durableState(task.id);
    const blocker = await admin.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM pactwoven.native_tasks WHERE organization_id=$1 AND id=$2 FOR UPDATE', [actor.organizationId, task.id]);
      const final = completion(Date.now() + 400);
      const assertion = expect(worker.progress(c, final)).rejects.toMatchObject({ code: 'EVIDENCE_STALE' });
      await admin.query('SELECT pg_sleep(0.05)');
      const waiting = await admin.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND usename='pactwoven_native_test_worker' AND wait_event_type='Lock'");
      expect(waiting.rows[0].count).toBe(1);
      await admin.query('SELECT pg_sleep(0.45)'); await blocker.query('COMMIT'); await assertion;
      expect(await durableState(task.id)).toEqual(before); expect(await worker.progress(c, update())).toBe(true);
    } finally { await blocker.query('ROLLBACK'); blocker.release(); }
  });
  it('rolls back task, checkpoint, message, artifact, event and outbox when evidence expires after writes', async () => {
    const task = await create(); const c = await claim(); const before = await durableState(task.id);
    // This guarded disposable database owns the delay trigger. It fires after
    // the candidate completion event, so only the final lease-writer check can reject.
    await admin.query(`CREATE SEQUENCE pactwoven.native_test_completion_hits;
      REVOKE ALL ON SEQUENCE pactwoven.native_test_completion_hits FROM PUBLIC;
      CREATE FUNCTION pactwoven.native_test_completion_delay() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
      BEGIN PERFORM nextval('pactwoven.native_test_completion_hits'); PERFORM pg_sleep(0.7); RETURN NEW; END $$;
      REVOKE ALL ON FUNCTION pactwoven.native_test_completion_delay() FROM PUBLIC;
      CREATE TRIGGER native_test_completion_delay AFTER INSERT ON pactwoven.native_task_events FOR EACH ROW
        WHEN (NEW.kind='completed') EXECUTE FUNCTION pactwoven.native_test_completion_delay();`);
    try {
      await expect(worker.progress(c, completion(Date.now() + 400))).rejects.toMatchObject({ code: 'EVIDENCE_STALE' });
      // Sequence advancement is deliberately not transactional: it proves the
      // completion event reached the post-write trigger before rollback.
      expect((await admin.query('SELECT last_value,is_called FROM pactwoven.native_test_completion_hits')).rows[0])
        .toEqual({ last_value: '1', is_called: true });
      expect(await durableState(task.id)).toEqual(before); expect(await worker.progress(c, update())).toBe(true);
    } finally {
      await admin.query('DROP TRIGGER native_test_completion_delay ON pactwoven.native_task_events; DROP FUNCTION pactwoven.native_test_completion_delay(); DROP SEQUENCE pactwoven.native_test_completion_hits');
    }
    await expect(assertNativeTaskPool(workerPool, 'simulation', 'worker')).resolves.toBeUndefined();
  });
  it('binds the deadline to all documents in the submitted checkpoint, including a changed unused source', async () => {
    const task = await create(); const c = await claim(); const longer = Date.now() + 60_000, shorter = Date.now() + 30_000;
    const old = completion(longer); await worker.progress(c, { ...update(), checkpoint: old.checkpoint });
    const final = { ...old, checkpoint: { ...old.checkpoint, documents: [retrieved(longer), { ...retrieved(shorter), id: 'changed-source', text: 'Changed observation.' }] } };
    const before = await durableState(task.id);
    await expect(worker.progress(c, final)).rejects.toMatchObject({ code: 'EVIDENCE_STALE' });
    expect(await durableState(task.id)).toEqual(before);
    expect(await worker.progress(c, { ...final, evidenceValidUntil: new Date(shorter).toISOString() })).toBe(true);
    expect((await durableState(task.id)).task.checkpoint.documents[1].text).toBe('Changed observation.');
  });
  it('caps validity at observation plus fifteen minutes even when the reader and caller claim longer', async () => {
    await create(); const c = await claim(); const observed = Date.now() - 14 * 60_000;
    const final = completion(Date.now() + 2 * 60_000);
    final.checkpoint.documents = [retrieved(Date.now() + 10 * 60_000, observed)];
    await expect(worker.progress(c, final)).rejects.toMatchObject({ code: 'EVIDENCE_STALE' });
    expect(await worker.progress(c, { ...final, evidenceValidUntil: new Date(observed + 15 * 60_000).toISOString() })).toBe(true);
  });
  it('caps at the next UTC midnight regardless of the database session time zone', async () => {
    const client = await admin.connect();
    try {
      await client.query("SET TIME ZONE 'Pacific/Honolulu'");
      const day = new Date(); day.setUTCHours(0, 0, 0, 0); const midnight = day.getTime() - 86_400_000;
      const final = completion(midnight);
      final.checkpoint.documents = [retrieved(midnight + 60_000, midnight - 60_000)];
      const value = await client.query('SELECT pactwoven.native_task_completion_deadline($1::jsonb) AS deadline', [JSON.stringify(final)]);
      expect(value.rows[0].deadline.toISOString()).toBe(new Date(midnight).toISOString());
      await expect(client.query('SELECT pactwoven.native_task_completion_deadline($1::jsonb)',
        [JSON.stringify({ ...final, evidenceValidUntil: new Date(midnight + 1).toISOString() })])).rejects.toMatchObject({ code: 'NT008' });
    } finally { await client.query('RESET TIME ZONE'); client.release(); }
  });
  it('rejects missing, null, malformed and incorrectly placed bounds at the SQL boundary', async () => {
    const task = await create(); const c = await claim(); const final = completion(); const before = await durableState(task.id);
    const { evidenceValidUntil: _bound, ...missing } = final;
    await expect(directProgress(c, missing)).rejects.toMatchObject({ code: 'NT008' });
    for (const evidenceValidUntil of [null, 123, {}, '', 'infinity', '2026-99-99T00:00:00Z', '2026-11-18', '1'.repeat(41)]) {
      await expect(directProgress(c, { ...final, evidenceValidUntil })).rejects.toMatchObject({ code: 'NT004' });
    }
    await expect(directProgress(c, { ...update(), evidenceValidUntil: final.evidenceValidUntil })).rejects.toMatchObject({ code: 'NT004' });
    expect(await durableState(task.id)).toEqual(before);
  });
  it('fails closed on malformed submitted document collections and validity fields', async () => {
    const task = await create(); const c = await claim(); const final = completion(); const valid = retrieved();
    const before = await durableState(task.id);
    const { observedAt: _observed, ...noObservation } = valid; const { validUntil: _valid, ...noValidity } = valid;
    for (const documents of [undefined, null, {}, 'documents', 2, [null], [1], [{ ...valid, origin: 'unknown' }],
      Array.from({ length: 4 }, (_, index) => ({ ...valid, id: `source${index}` })), [noObservation], [noValidity],
      [{ ...valid, observedAt: null }], [{ ...valid, validUntil: null }], [{ ...valid, observedAt: 'infinity' }],
      [{ ...valid, validUntil: '2026-13-99T00:00:00Z' }], [{ ...valid, validUntil: valid.observedAt }],
      [{ ...valid, observedAt: new Date(Date.now() + 30_000).toISOString() }], [{ ...valid, source: null }]]) {
      await expect(directProgress(c, { ...final, checkpoint: { schemaVersion: 2, documents } })).rejects.toMatchObject({ code: 'NT008' });
    }
    expect(await durableState(task.id)).toEqual(before);
  });
  it('permits context-only v2 completion without an evidence claim and rejects an invented bound', async () => {
    await create(); const c = await claim(); const final = completion();
    final.checkpoint.documents = [{ ...retrieved(), origin: 'user_supplied', source: null }];
    await expect(worker.progress(c, final)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    delete final.evidenceValidUntil; expect(await worker.progress(c, final)).toBe(true);
  });
  it('accepts empty context-only v2 and explicit legacy v1 but rejects absent or unknown completion versions', async () => {
    await create(); const c = await claim();
    for (const schemaVersion of [undefined, null, '1', '2', 0, 3]) {
      await expect(directProgress(c, { ...update('completed'), checkpoint: { schemaVersion, documents: [] } })).rejects.toMatchObject({ code: 'NT004' });
    }
    expect(await worker.progress(c, { ...update('completed'), checkpoint: { schemaVersion: 2, documents: [] } })).toBe(true);
    await create(); expect(await worker.progress(await claim(), update('completed'))).toBe(true);
  });
  it('keeps the helper private and the existing yield path working under unchanged role grants', async () => {
    for (const pool of [workerPool, apiPool]) {
      await expect(pool.query('SELECT pactwoven.native_task_completion_deadline($1::jsonb)', [JSON.stringify(completion())])).rejects.toMatchObject({ code: '42501' });
    }
    const privileges = await admin.query(`SELECT role_name,has_function_privilege(role_name,'pactwoven.native_task_completion_deadline(jsonb)','EXECUTE') AS allowed
      FROM unnest(ARRAY['pactwoven_runtime','pactwoven_native_task_api','pactwoven_native_task_worker','pactwoven_native_task_dispatcher']) role_name`);
    expect(privileges.rows.every(row => !row.allowed)).toBe(true);
    const task = await create(); const c = await claim();
    const message = { schemaVersion: 1, environment: 'simulation', organizationId: actor.organizationId, taskId: task.id,
      generation: 1, engineRevision: 'native-advice-v1' };
    const yielded = await workerPool.query('SELECT pactwoven.native_dispatch_yield($1,$2::jsonb,$3::uuid,$4::jsonb,0) AS applied',
      ['simulation', JSON.stringify(message), c.leaseToken, JSON.stringify(update())]);
    expect(yielded.rows[0].applied).toBe(true); expect((await api.get(actor, task.id)).status).toBe('queued');
    expect((await claim()).checkpoint).toEqual(update().checkpoint);
    await expect(assertNativeTaskPool(workerPool, 'simulation', 'worker')).resolves.toBeUndefined();
    await expect(assertNativeTaskPool(apiPool, 'simulation', 'api')).resolves.toBeUndefined();
  });

  it('searches older than the first 100 tasks and pages equal microsecond timestamps without gaps', async () => {
    await history(137);
    const collected: string[] = []; let cursor: string | undefined;
    do {
      const page = await search(actor, { limit: 31, ...(cursor ? { cursor } : {}) });
      expect(page.items.length).toBeLessThanOrEqual(31);
      collected.push(...page.items.map(t => t.id)); cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(collected).toHaveLength(137); expect(new Set(collected).size).toBe(137);
    expect(collected[0]).toBe('history_137'); expect(collected.at(-1)).toBe('history_001');
    expect((await search(actor, { q: '  nEEdLe  ' })).items.map(t => t.id)).toEqual(['history_001']);
    expect((await search(actor, { q: '100%_' })).items.map(t => t.id)).toEqual(['history_001']);
    expect((await search(actor, { q: '100%X' })).items).toEqual([]);
    expect((await search(actor, { q: 'missing' })).nextCursor).toBeNull();
    expect((await search(actor, { limit: 100 })).items).toHaveLength(100);
  });
  it('keeps creation order during progress and new tasks; refresh discovers additions and changed filters', async () => {
    await history(6);
    const first = await search(actor, { limit: 2 }); expect(first.items.map(t => t.id)).toEqual(['history_006', 'history_005']);
    await admin.query(`UPDATE pactwoven.native_tasks SET updated_at=clock_timestamp(),status='completed',row_version=row_version+1
      WHERE organization_id=$1 AND id IN ('history_006','history_004')`, [actor.organizationId]);
    const newest = await create();
    const second = await search(actor, { limit: 2, cursor: first.nextCursor! });
    expect(second.items.map(t => t.id)).toEqual(['history_004', 'history_003']);
    expect(second.items[0]!.status).toBe('completed');
    const refreshed = await search(actor, { limit: 2 }); expect(refreshed.items.map(t => t.id)).toEqual([newest.id, 'history_006']);
    expect((await search(actor, { filter: 'completed' })).items.map(t => t.id)).toEqual(['history_006', 'history_004']);
    await admin.query(`UPDATE pactwoven.native_tasks SET status=CASE id WHEN 'history_003' THEN 'failed' ELSE 'cancelled' END
      WHERE organization_id=$1 AND id IN ('history_003','history_002')`, [actor.organizationId]);
    expect((await search(actor, { filter: 'active' })).items.map(t => t.id)).toEqual([newest.id, 'history_005', 'history_001']);
    const activeFirst = await search(actor, { filter: 'active', limit: 2 });
    await admin.query("UPDATE pactwoven.native_tasks SET status='queued' WHERE organization_id=$1 AND id='history_006'", [actor.organizationId]);
    expect((await search(actor, { filter: 'active', limit: 10, cursor: activeFirst.nextCursor! })).items.map(t => t.id))
      .toEqual(['history_001']);
    // A newly matching task before the current position requires a refresh.
    // This is live keyset paging, not a snapshot or a change feed.
    expect((await search(actor, { filter: 'active' })).items.map(t => t.id))
      .toEqual([newest.id, 'history_006', 'history_005', 'history_001']);
  });
  it('rejects mutation of pagination identity while permitting task progress', async () => {
    await history(1);
    for (const change of ["created_at=created_at+interval '1 microsecond'", "id='changed'"]) {
      await expect(admin.query(`UPDATE pactwoven.native_tasks SET ${change} WHERE organization_id=$1`, [actor.organizationId]))
        .rejects.toMatchObject({ code: 'NT004' });
    }
    await admin.query("UPDATE pactwoven.native_tasks SET phase='Still working',updated_at=clock_timestamp() WHERE organization_id=$1", [actor.organizationId]);
    expect((await search()).items[0]!.id).toBe('history_001');
  });
  it('scopes every page to the current actor, tenant, sites, membership and session', async () => {
    await history(4); await history(1, other);
    const first = await search(actor, { limit: 1 });
    expect((await search(other)).items).toHaveLength(1);
    await expect(search(other, { limit: 1, cursor: first.nextCursor! })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const secondId = randomUUID();
    await admin.query("INSERT INTO pactwoven.memberships(environment,organization_id,actor_id,external_subject,roles) VALUES('simulation',$1,$2,$2,ARRAY['owner'])", [actor.organizationId, secondId]);
    expect((await search({ ...actor, actorId: secondId })).items).toEqual([]);
    await admin.query("UPDATE pactwoven.memberships SET roles=ARRAY['operations'] WHERE organization_id=$1 AND actor_id=$2", [actor.organizationId, actor.actorId]);
    await admin.query("INSERT INTO pactwoven.site_memberships(environment,organization_id,actor_id,site_id) VALUES('simulation',$1,$2,$3)", [actor.organizationId, actor.actorId, actor.siteIds[0]]);
    expect((await search(actor, { limit: 1, cursor: first.nextCursor! })).items).toHaveLength(1);
    await admin.query('DELETE FROM pactwoven.site_memberships WHERE organization_id=$1 AND actor_id=$2', [actor.organizationId, actor.actorId]);
    expect(await search(actor, { limit: 1, cursor: first.nextCursor! })).toEqual({ items: [], nextCursor: null });
    await admin.query("UPDATE pactwoven.memberships SET status='revoked' WHERE organization_id=$1 AND actor_id=$2", [actor.organizationId, actor.actorId]);
    await expect(search(actor, { limit: 1, cursor: first.nextCursor! })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await admin.query("UPDATE pactwoven.memberships SET status='active',roles=ARRAY['owner'] WHERE organization_id=$1 AND actor_id=$2", [actor.organizationId, actor.actorId]);
    await admin.query("INSERT INTO pactwoven.session_revocations(environment,session_id) VALUES('simulation',$1)", [actor.sessionId]);
    await expect(search(actor, { limit: 1, cursor: first.nextCursor! })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('validates cursor query binding and the authoritative SQL search boundary', async () => {
    await history(3); const first = await search(actor, { limit: 1 });
    for (const query of [{ q: 'Task' }, { filter: 'active' as const }]) {
      await expect(search(actor, { ...query, cursor: first.nextCursor! })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    }
    const valid = { limit: 1, q: '', filter: 'all', after: null };
    const after = JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString('utf8')) as Record<string, unknown>;
    for (const invalid of [null, [], false, 'search', { ...valid, after: [] }, { ...valid, after: 1 }]) {
      await expect(apiPool.query('SELECT pactwoven.native_task_search($1::jsonb,$2::jsonb)', [JSON.stringify(actor), JSON.stringify(invalid)]))
        .rejects.toMatchObject({ code: 'NT004' });
    }
    for (const changed of [{ limit: 0 }, { limit: 101 }, { limit: '1' }, { q: 'x'.repeat(181) }, { filter: 'failed' }, { actorId: 'other' },
      { after: { ...after, createdAt: 'infinity' } }, { after: { ...after, createdAt: '2026-13-99T00:00:00Z' } },
      { after: { ...after, organizationId: other.organizationId } }, { after: { ...after, id: 'bad id' } }]) {
      await expect(apiPool.query('SELECT pactwoven.native_task_search($1::jsonb,$2::jsonb)', [JSON.stringify(actor), JSON.stringify({ ...valid, ...changed })]))
        .rejects.toMatchObject({ code: 'NT004' });
    }
    await expect(workerPool.query('SELECT pactwoven.native_task_search($1::jsonb,$2::jsonb)', [JSON.stringify(actor), JSON.stringify(valid)]))
      .rejects.toMatchObject({ code: '42501' });
    await expect(apiPool.query('SELECT pactwoven.native_task_identity_guard()')).rejects.toMatchObject({ code: '42501' });
    await expect(assertNativeTaskPool(apiPool, 'simulation', 'api')).resolves.toBeUndefined();
  });

  it('creates once under concurrent exact retries, rejects a changed request and replays current state', async () => {
    const requestKey = key();
    const [a, b] = await Promise.all([create(actor, requestKey), create(actor, requestKey)]);
    expect(a.id).toBe(b.id); expect(a.messages).toHaveLength(1);
    await expect(create(actor, requestKey, 'A different task')).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    const c = await claim(); await worker.progress(c, { ...update(), title: 'Office chairs for Friday' });
    const replay = await create(actor, requestKey); expect(replay.status).toBe('running'); expect(replay.title).toBe('Office chairs for Friday');
    const counts = await admin.query('SELECT count(*)::int AS count FROM pactwoven.native_tasks WHERE organization_id=$1', [actor.organizationId]);
    expect(counts.rows[0].count).toBe(1);
  });
  it('rejects membership expiry while an identical-key lock is held', async () => {
    const requestKey = key(); const blocker = await admin.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query(`SELECT pg_advisory_xact_lock(hashtextextended(jsonb_build_array('native-create','simulation'::text,$1::text,$2::text,$3::text)::text,0))`,
        [actor.organizationId, actor.actorId, requestKey]);
      await admin.query("UPDATE pactwoven.memberships SET expires_at=clock_timestamp()+interval '400 milliseconds' WHERE organization_id=$1", [actor.organizationId]);
      const pending = create(actor, requestKey);
      const assertion = expect(pending).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await admin.query('SELECT pg_sleep(0.02)');
      const waiting = await admin.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND usename='pactwoven_native_test_api' AND wait_event='advisory'");
      expect(waiting.rows[0].count).toBe(1);
      await admin.query('SELECT pg_sleep(0.5)');
      await blocker.query('COMMIT');
      await assertion;
      expect((await admin.query('SELECT count(*)::int AS count FROM pactwoven.native_tasks WHERE organization_id=$1', [actor.organizationId])).rows[0].count).toBe(0);
    } finally { await blocker.query('ROLLBACK'); blocker.release(); }
  });
  it('isolates organization, actor, site and environment even with forged role/site hints', async () => {
    const task = await create();
    await expect(api.get(other, task.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await api.list(other, 20)).toEqual([]);
    await expect(api.get({ ...actor, environment: 'development' }, task.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(api.create(actor, key(), { prompt: 'Wrong site', siteId: other.siteIds[0]!, mode: 'advise' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await admin.query("UPDATE pactwoven.memberships SET roles=ARRAY['auditor'] WHERE organization_id=$1", [actor.organizationId]);
    await expect(create({ ...actor, roles: ['owner'] })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await api.get(actor, task.id)).availableActions).toEqual([]);
    expect((await api.list(actor, 10))[0]!.availableActions).toEqual([]);
  });
  it('returns a bounded public projection without worker, session or checkpoint material', async () => {
    const task = await create(); const c = await claim(); await worker.progress(c, update());
    const read = await api.get(actor, task.id), page = await api.list(actor, 1);
    expect(read.events.map(e => e.sequence)).toEqual([1, 2, 3]); expect(page).toHaveLength(1);
    for (const field of ['leaseToken', 'lease_until', 'worker_id', 'checkpoint', 'session_id', 'actor_id']) {
      expect(Object.hasOwn(read, field)).toBe(false); expect(Object.hasOwn(page[0]!, field)).toBe(false);
    }
  });
  it('returns the latest 500 events while retaining complete durable history', async () => {
    const task = await create();
    await admin.query(`INSERT INTO pactwoven.native_task_events(environment,organization_id,task_id,sequence,kind,title,detail,agent)
      SELECT 'simulation',$1,$2,n,'progress','Observed progress','','research' FROM generate_series(2,505)n`, [actor.organizationId, task.id]);
    await admin.query('UPDATE pactwoven.native_tasks SET last_sequence=505 WHERE organization_id=$1 AND id=$2', [actor.organizationId, task.id]);
    const read = await api.get(actor, task.id); expect(read.events).toHaveLength(500);
    expect(read.events[0]!.sequence).toBe(6); expect(read.events.at(-1)!.sequence).toBe(505);
    const all = await admin.query('SELECT count(*)::int AS count FROM pactwoven.native_task_events WHERE organization_id=$1 AND task_id=$2', [actor.organizationId, task.id]);
    expect(all.rows[0].count).toBe(505);
  });
  it('allows one claim, fences expired workers, and keeps checkpoints across restart', async () => {
    await create(); const claims = await Promise.all([worker.claim('a', 30_000), worker.claim('b', 30_000)]);
    expect(claims.filter(Boolean)).toHaveLength(1); const original = claims.find(Boolean)!;
    await worker.progress(original, update());
    await admin.query("UPDATE pactwoven.native_tasks SET lease_until=clock_timestamp()-interval '1 second' WHERE organization_id=$1", [actor.organizationId]);
    expect(await worker.renew(original, 30_000)).toBe(false);
    const resumed = await claim(); expect(resumed.leaseToken).not.toBe(original.leaseToken); expect(resumed.checkpoint).toEqual(update().checkpoint);
    expect(await worker.progress(original, update('completed'))).toBe(false);
    expect(await worker.progress(resumed, update('completed'))).toBe(true);
    expect((await api.get(actor, resumed.task.id)).status).toBe('completed');
  });
  it('pause and cancel invalidate claims immediately; resume is explicit', async () => {
    await create(); const c = await claim();
    const paused = await api.control(actor, c.task.id, { action: 'pause', expectedVersion: c.task.version });
    expect(await worker.renew(c, 30_000)).toBe(false); expect(await worker.progress(c, update())).toBe(false); expect(await worker.claim('test_worker', 30_000)).toBeNull();
    const resumed = await api.control(actor, c.task.id, { action: 'resume', expectedVersion: paused.version });
    expect(resumed.status).toBe('queued'); const next = await claim();
    const cancelled = await api.control(actor, c.task.id, { action: 'cancel', expectedVersion: next.task.version });
    expect(cancelled.status).toBe('cancelled'); expect(await worker.progress(next, update('completed'))).toBe(false);
    await expect(api.control(actor, c.task.id, { action: 'resume', expectedVersion: cancelled.version })).rejects.toMatchObject({ code: 'INVALID_TASK_STATE' });
  });
  it('retries failed advice only after explicit resume, preserving exact saved work and fencing the failed claim', async () => {
    const requestKey = key(); const original = await create(actor, requestKey); const c = await claim();
    const progress: NativeTaskProgress = { ...failure(),
      checkpoint: { schemaVersion: 1, phase: 'research', inputGeneration: 1, attempts: { research: 3 }, completed: ['planning'], evidence: { text: 'A saved observation', source: 'https://example.com/chair' } },
      steps: [{ id: 'research', agent: 'research', title: 'Compare sources', status: 'failed', summary: 'Saved the first observation.' }],
      artifact: { id: 'saved-research', kind: 'research', title: 'First observation', text: 'A saved observation.', sources: [{ title: 'Chair reference', url: 'https://example.com/chair' }] },
      message: { id: 'saved-summary', role: 'assistant', text: 'The connection failed; your existing research is saved.' } };
    expect(await worker.progress(c, progress)).toBe(true);
    const failed = await api.get(actor, original.id);
    expect(failed.status).toBe('failed'); expect(failed.availableActions).toEqual(['resume']);
    expect((await api.list(actor, 10))[0]!.availableActions).toEqual(['resume']);
    expect(await worker.claim('automatic_retry', 30_000)).toBeNull(); expect(await worker.renew(c, 30_000)).toBe(false);
    expect((await create(actor, requestKey)).status).toBe('failed');
    const resumed = await api.control(actor, failed.id, { action: 'resume', expectedVersion: failed.version });
    expect(resumed.id).toBe(original.id); expect(resumed.status).toBe('queued'); expect(resumed.version).toBe(failed.version + 1);
    expect(resumed.prompt).toBe(failed.prompt); expect(resumed.artifacts).toEqual(failed.artifacts); expect(resumed.messages).toEqual(failed.messages); expect(resumed.steps).toEqual(failed.steps);
    expect(resumed.events.at(-1)).toMatchObject({ kind: 'resumed', sequence: failed.events.at(-1)!.sequence + 1 });
    const next = await claim(); expect(next.task.id).toBe(original.id); expect(next.checkpoint).toEqual(progress.checkpoint); expect(next.leaseToken).not.toBe(c.leaseToken);
    expect(await worker.progress(c, update('completed'))).toBe(false); expect(await worker.renew(c, 30_000)).toBe(false);
    expect((await create(actor, requestKey)).id).toBe(original.id);
    const counts = await admin.query('SELECT count(*)::int AS count FROM pactwoven.native_tasks WHERE organization_id=$1', [actor.organizationId]);
    expect(counts.rows[0].count).toBe(1);
  });
  it.each(['role', 'action_site'])('failed-task resume rechecks current %s authority instead of actor hints', async reason => {
    await create(); const c = await claim(); expect(await worker.progress(c, failure())).toBe(true);
    const failed = await api.get(actor, c.task.id);
    if (reason === 'role') await admin.query("UPDATE pactwoven.memberships SET roles=ARRAY['auditor'] WHERE organization_id=$1", [actor.organizationId]);
    else await admin.query('DELETE FROM pactwoven.member_action_sites WHERE organization_id=$1', [actor.organizationId]);
    expect((await api.get(actor, failed.id)).availableActions).toEqual([]);
    expect((await api.list(actor, 10))[0]!.availableActions).toEqual([]);
    await expect(api.control(actor, failed.id, { action: 'resume', expectedVersion: failed.version })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await api.get(actor, failed.id)).status).toBe('failed');
    if (reason === 'role') await admin.query("UPDATE pactwoven.memberships SET roles=ARRAY['owner'] WHERE organization_id=$1", [actor.organizationId]);
    else await admin.query("INSERT INTO pactwoven.member_action_sites(environment,organization_id,actor_id,site_id) VALUES('simulation',$1,$2,$3)", [actor.organizationId, actor.actorId, actor.actionSiteIds[0]]);
    expect((await api.control(actor, failed.id, { action: 'resume', expectedVersion: failed.version })).status).toBe('queued');
  });
  it('failed-task resume remains requester-owned even for another owner at the same site', async () => {
    await create(); const c = await claim(); expect(await worker.progress(c, failure())).toBe(true);
    const failed = await api.get(actor, c.task.id); const secondId = randomUUID();
    await admin.query("INSERT INTO pactwoven.memberships(environment,organization_id,actor_id,external_subject,roles) VALUES('simulation',$1,$2,$2,ARRAY['owner'])", [actor.organizationId, secondId]);
    await admin.query("INSERT INTO pactwoven.member_action_sites(environment,organization_id,actor_id,site_id) VALUES('simulation',$1,$2,$3)", [actor.organizationId, secondId, actor.actionSiteIds[0]]);
    const secondOwner = { ...actor, actorId: secondId, sessionId: randomUUID() };
    await expect(api.control(secondOwner, failed.id, { action: 'resume', expectedVersion: failed.version })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await api.get(actor, failed.id)).status).toBe('failed');
  });
  it('failed-task retry requires the current version and records only one explicit resume', async () => {
    await create(); const c = await claim(); expect(await worker.progress(c, failure())).toBe(true);
    const failed = await api.get(actor, c.task.id);
    await expect(api.control(actor, failed.id, { action: 'resume', expectedVersion: failed.version - 1 })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    const results = await Promise.allSettled([
      api.control(actor, failed.id, { action: 'resume', expectedVersion: failed.version }),
      api.control(actor, failed.id, { action: 'resume', expectedVersion: failed.version }),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect((results.find(result => result.status === 'rejected') as PromiseRejectedResult).reason.code).toBe('VERSION_CONFLICT');
    const current = await api.get(actor, failed.id);
    expect(current.version).toBe(failed.version + 1); expect(current.events.filter(event => event.kind === 'resumed')).toHaveLength(1);
    expect((await claim()).checkpoint).toEqual(failure().checkpoint);
  });
  it('failed tasks reject steering, pause and cancel instead of silently restarting or replacing saved work', async () => {
    await create(); const c = await claim(); expect(await worker.progress(c, failure())).toBe(true);
    const failed = await api.get(actor, c.task.id);
    for (const action of ['pause', 'cancel'] as const) await expect(api.control(actor, failed.id, { action, expectedVersion: failed.version })).rejects.toMatchObject({ code: 'INVALID_TASK_STATE' });
    await expect(api.reply(actor, failed.id, key(), { text: 'Replace the failed task', expectedVersion: failed.version })).rejects.toMatchObject({ code: 'INVALID_TASK_STATE' });
    expect(await api.get(actor, failed.id)).toEqual(failed);
  });
  it.each(['completed', 'cancelled'] as const)('%s tasks remain terminal for resume and every other operator command', async status => {
    await create(); const c = await claim();
    if (status === 'completed') expect(await worker.progress(c, update('completed'))).toBe(true);
    else await api.control(actor, c.task.id, { action: 'cancel', expectedVersion: c.task.version });
    const terminal = await api.get(actor, c.task.id); expect(terminal.availableActions).toEqual([]);
    for (const action of ['resume', 'pause', 'cancel'] as const) await expect(api.control(actor, terminal.id, { action, expectedVersion: terminal.version })).rejects.toMatchObject({ code: 'INVALID_TASK_STATE' });
    await expect(api.reply(actor, terminal.id, key(), { text: 'Try again', expectedVersion: terminal.version })).rejects.toMatchObject({ code: 'INVALID_TASK_STATE' });
    expect(await api.get(actor, terminal.id)).toEqual(terminal); expect(await worker.claim('test_worker', 30_000)).toBeNull();
  });
  it('steering resets the checkpoint, fences old results, replays exactly, and preserves pause', async () => {
    await create(); const c = await claim(); await worker.progress(c, update());
    const current = await api.get(actor, c.task.id); const requestKey = key(); const input = { text: 'Only chairs under $200.', expectedVersion: current.version };
    const replied = await api.reply(actor, current.id, requestKey, input);
    expect(replied.status).toBe('queued'); expect(replied.messages).toHaveLength(2);
    expect(await worker.progress(c, update('completed'))).toBe(false);
    expect((await api.reply(actor, current.id, requestKey, input)).version).toBe(replied.version);
    await expect(api.reply(actor, current.id, requestKey, { ...input, text: 'Changed' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    const next = await claim(); expect(next.checkpoint).toEqual({});
    const paused = await api.control(actor, next.task.id, { action: 'pause', expectedVersion: next.task.version });
    const pausedReply = await api.reply(actor, next.task.id, key(), { text: 'Keep it paused.', expectedVersion: paused.version });
    expect(pausedReply.status).toBe('paused'); expect(await worker.claim('test_worker', 30_000)).toBeNull();
  });
  it('serializes one reply key across different tasks without a generic database failure', async () => {
    const a = await create(), b = await create(); const replyKey = key();
    const results = await Promise.allSettled([
      api.reply(actor, a.id, replyKey, { text: 'Update A', expectedVersion: a.version }),
      api.reply(actor, b.id, replyKey, { text: 'Update B', expectedVersion: b.version }),
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect((results.find(r => r.status === 'rejected') as PromiseRejectedResult).reason.code).toBe('IDEMPOTENCY_CONFLICT');
  });
  it('version conflicts cannot overwrite a concurrent update', async () => {
    const task = await create();
    const results = await Promise.allSettled([
      api.reply(actor, task.id, key(), { text: 'First update', expectedVersion: task.version }),
      api.control(actor, task.id, { action: 'pause', expectedVersion: task.version }),
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason.code).toBe('VERSION_CONFLICT');
  });
  it.each(['membership', 'action_site', 'session', 'expiry', 'organization'])('revoked %s prevents renewal and progress without falsely completing work', async reason => {
    await create(); const c = await claim();
    if (reason === 'membership') await admin.query("UPDATE pactwoven.memberships SET status='revoked' WHERE organization_id=$1", [actor.organizationId]);
    if (reason === 'action_site') await admin.query('DELETE FROM pactwoven.member_action_sites WHERE organization_id=$1', [actor.organizationId]);
    if (reason === 'session') await admin.query("INSERT INTO pactwoven.session_revocations(environment,session_id) VALUES('simulation',$1)", [actor.sessionId]);
    if (reason === 'expiry') await admin.query("UPDATE pactwoven.memberships SET expires_at=clock_timestamp()-interval '1 second' WHERE organization_id=$1", [actor.organizationId]);
    if (reason === 'organization') await admin.query("UPDATE pactwoven.organizations SET status='suspended' WHERE id=$1", [actor.organizationId]);
    expect(await worker.renew(c, 30_000)).toBe(false); expect(await worker.progress(c, update('completed'))).toBe(false);
    const row = await admin.query('SELECT status,lease_token FROM pactwoven.native_tasks WHERE organization_id=$1', [actor.organizationId]);
    expect(row.rows[0]).toEqual({ status: 'paused', lease_token: null });
  });
  it('pauses queued work on revoked access and permits an explicit new-session resume', async () => {
    const task = await create();
    await admin.query("INSERT INTO pactwoven.session_revocations(environment,session_id) VALUES('simulation',$1)", [actor.sessionId]);
    expect(await worker.claim('test_worker', 30_000)).toBeNull();
    await expect(api.get(actor, task.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const freshActor = { ...actor, sessionId: randomUUID() }; const paused = await api.get(freshActor, task.id);
    expect(paused.status).toBe('paused');
    const resumed = await api.control(freshActor, task.id, { action: 'resume', expectedVersion: paused.version });
    expect(resumed.status).toBe('queued'); expect((await claim()).task.id).toBe(task.id);
  });
  it('waiting tasks persist without being re-claimed and resume after a user reply', async () => {
    await create(); const c = await claim();
    expect(await worker.progress(c, { ...update(), status: 'waiting_for_input', phase: 'Which office?', message: { id: 'question1', role: 'assistant', text: 'Which office should delivery go to?' } })).toBe(true);
    expect(await worker.claim('other_worker', 30_000)).toBeNull(); const task = await api.get(actor, c.task.id);
    const reply = await api.reply(actor, task.id, key(), { text: 'The Chicago office.', expectedVersion: task.version });
    expect(reply.status).toBe('queued'); expect((await claim()).task.messages).toHaveLength(3);
  });
  it('deduplicates stable artifact/message identities and rejects changed bytes', async () => {
    await create(); const c = await claim();
    const progress: NativeTaskProgress = { ...update(), artifact: { id: 'report1', kind: 'research', title: 'Chair comparison', text: 'Three chairs compared.', sources: [] },
      message: { id: 'summary1', role: 'assistant', text: 'The comparison is ready.' } };
    expect(await worker.progress(c, progress)).toBe(true); expect(await worker.progress(c, progress)).toBe(true);
    const task = await api.get(actor, c.task.id); expect(task.artifacts).toHaveLength(1); expect(task.messages).toHaveLength(2);
    await expect(worker.progress(c, { ...progress, message: { ...progress.message!, text: 'Different content' } })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
  it('prevents direct table reads and cross-purpose calls; rejects unenrolled environments', async () => {
    await expect(apiPool.query('SELECT * FROM pactwoven.native_tasks')).rejects.toMatchObject({ code: '42501' });
    await expect(workerPool.query('SELECT * FROM pactwoven.memberships')).rejects.toMatchObject({ code: '42501' });
    await expect(apiPool.query("SELECT pactwoven.native_task_claim('simulation','bad',30000)")).rejects.toMatchObject({ code: '42501' });
    await expect(workerPool.query('SELECT pactwoven.native_task_read($1::jsonb,NULL,10)', [JSON.stringify(actor)])).rejects.toMatchObject({ code: '42501' });
    await expect(assertNativeTaskPool(apiPool, 'development', 'api')).rejects.toMatchObject({ code: 'UNSAFE_DATABASE_ROLE' });
    await expect(assertNativeTaskPool(admin, 'simulation', 'worker')).rejects.toMatchObject({ code: 'UNSAFE_DATABASE_ROLE' });
    await admin.query('GRANT SELECT ON pactwoven.native_tasks TO pactwoven_native_test_api');
    try { await expect(assertNativeTaskPool(apiPool, 'simulation', 'api')).rejects.toMatchObject({ code: 'UNSAFE_DATABASE_ROLE' }); }
    finally { await admin.query('REVOKE SELECT ON pactwoven.native_tasks FROM pactwoven_native_test_api'); }
    await expect(assertNativeTaskPool(apiPool, 'simulation', 'api')).resolves.toBeUndefined();
  });
});

describe('native task repository request and failure boundary', () => {
  const actor: ActorContext = { actorId: 'member', principalKind: 'human', organizationId: 'org', environment: 'development', roles: ['owner'],
    siteIds: ['site'], actionSiteIds: ['site'], sessionId: 'session', authenticatedAt: '2026-11-18T00:00:00Z', correlationId: 'request' };
  const workerClaim: NativeTaskClaim = {
    environment: 'development', organizationId: 'org', actorId: 'member', leaseToken: randomUUID(), checkpoint: {},
    task: { id: 'task', title: 'Chair comparison', status: 'running', phase: 'Comparing', siteId: 'site',
      createdAt: actor.authenticatedAt, updatedAt: actor.authenticatedAt, version: 1, availableActions: ['pause'],
      prompt: 'Compare chairs.', mode: 'advise', steps: [], messages: [], artifacts: [], events: [] },
  };
  it('serializes the exact completion bound while preserving the boolean lease contract', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ response: true }] }).mockResolvedValueOnce({ rows: [{ response: false }] });
    const repo = new PostgresNativeTaskWorkerRepository({ query } as unknown as Pool, 'development'); const final = completion();
    expect(await repo.progress(workerClaim, final)).toBe(true); expect(await repo.progress(workerClaim, final)).toBe(false);
    expect(JSON.parse(query.mock.calls[0]![1][6])).toEqual(final);
  });
  it('maps only definite NT008 rejection to a safe freshness error and does not retry', async () => {
    const query = vi.fn().mockRejectedValueOnce({ code: 'NT008', message: 'private source checkpoint' })
      .mockRejectedValueOnce({ code: '08006', message: 'private connection password' });
    const repo = new PostgresNativeTaskWorkerRepository({ query } as unknown as Pool, 'development');
    const stale = await repo.progress(workerClaim, completion()).catch(e => e);
    expect(stale).toMatchObject({ code: 'EVIDENCE_STALE', status: 409 }); expect(stale.message).not.toContain('private');
    const unknown = await repo.progress(workerClaim, completion()).catch(e => e);
    expect(unknown).toMatchObject({ code: 'DURABLE_SERVICE_UNAVAILABLE', status: 503 }); expect(unknown.message).not.toContain('password');
    expect(query).toHaveBeenCalledTimes(2);
  });
  it('rejects malformed completion bounds and bounds on intermediate progress before database IO', async () => {
    const query = vi.fn(); const repo = new PostgresNativeTaskWorkerRepository({ query } as unknown as Pool, 'development');
    for (const evidenceValidUntil of [null, 123, '', 'infinity', '2026-99-99T00:00:00Z']) {
      await expect(repo.progress(workerClaim, { ...completion(), evidenceValidUntil } as unknown as NativeTaskProgress)).rejects.toThrow();
    }
    await expect(repo.progress(workerClaim, { ...update(), evidenceValidUntil: completion().evidenceValidUntil! })).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });
  it('rejects foreign environments and malformed requests before database IO', async () => {
    const query = vi.fn(); const repo = new PostgresNativeTaskRepository({ query } as unknown as Pool, 'development');
    await expect(repo.create({ ...actor, environment: 'production' }, key(), { prompt: 'Test', siteId: 'site', mode: 'advise' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(repo.create(actor, key(), { prompt: '', siteId: 'site', mode: 'advise' })).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });
  it('sanitizes unknown failures without claiming a write failed or retrying it', async () => {
    const query = vi.fn().mockRejectedValue({ code: '08006', message: 'private database password' });
    const repo = new PostgresNativeTaskRepository({ query } as unknown as Pool, 'development');
    const error = await repo.create(actor, key(), { prompt: 'Test', siteId: 'site', mode: 'advise' }).catch(e => e);
    expect(error.code).toBe('DURABLE_SERVICE_UNAVAILABLE'); expect(error.message).not.toContain('password'); expect(query).toHaveBeenCalledOnce();
  });
  it('rejects invalid or rebound cursor payloads before database IO', async () => {
    const query = vi.fn(); const repo = new PostgresNativeTaskRepository({ query } as unknown as Pool, 'development');
    const payload = { v: 1, environment: 'development', organizationId: actor.organizationId, actorId: actor.actorId,
      q: '', filter: 'all', createdAt: '2026-11-18T00:00:00.123456Z', id: 'work_a' };
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    for (const cursor of ['a', 'bad_cursor', encode({ ...payload, v: 2 }), encode({ ...payload, organizationId: 'other' }),
      encode({ ...payload, actorId: 'other' }), encode({ ...payload, q: 'changed' }), encode({ ...payload, createdAt: 'invalid' }),
      encode({ ...payload, extra: true })]) {
      await expect(repo.search(actor, { limit: 20, q: '', filter: 'all', cursor })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    }
    expect(query).not.toHaveBeenCalled();
  });
});
