import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeDispatchClaimResultSchema, type ActorContext, type NativeDispatchClaim, type NativeDispatchMessage, type NativeTaskProgress } from '@pactwoven/contracts';
import { assertNativeTaskPool, createNativeTaskPool } from './native-task-pool.js';
import { PostgresNativeTaskRepository, PostgresNativeTaskWorkerRepository } from './native-task-repository.js';
import { PostgresNativeDispatchPublisherRepository, PostgresNativeDispatchWorkerRepository } from './native-dispatch-repository.js';

const databaseUrl = process.env.PACTWOVEN_NATIVE_DISPATCH_TEST_DATABASE_URL;
const progress = (): NativeTaskProgress => ({ status: 'running', phase: 'Research saved',
  event: { kind: 'artifact', title: 'Research saved', detail: 'One source checked.', agent: 'research' },
  checkpoint: { schemaVersion: 1, attempts: { research: 1 }, resumedThrough: 0, saved: ['first source'] },
  artifact: { id: 'source-one', kind: 'research', title: 'Research', text: 'First source observation.', sources: [{ title: 'Reference', url: 'https://example.com/source' }] } });

describe.skipIf(!databaseUrl)('native dispatch PostgreSQL durability and admission', () => {
  let admin: Pool, apiPool: Pool, workerPool: Pool, publisherPool: Pool;
  let api: PostgresNativeTaskRepository, worker: PostgresNativeTaskWorkerRepository;
  let publisher: PostgresNativeDispatchPublisherRepository, dispatch: PostgresNativeDispatchWorkerRepository;
  let actor: ActorContext; const organizations: string[] = [];
  let upgradeBefore: unknown[], upgradeAfter: unknown[], upgradeRows: number, evidenceBefore: unknown, evidenceAfter: unknown;
  async function fixture(): Promise<ActorContext> {
    const org = `dispatch_${randomUUID()}`, aid = randomUUID(), site = randomUUID(); organizations.push(org);
    await admin.query("INSERT INTO pactwoven.organizations(environment,id,external_organization_id,name) VALUES('simulation',$1,$1,'Dispatch test company')", [org]);
    await admin.query("INSERT INTO pactwoven.memberships(environment,organization_id,actor_id,external_subject,roles) VALUES('simulation',$1,$2,$2,ARRAY['owner'])", [org, aid]);
    await admin.query("INSERT INTO pactwoven.sites(environment,organization_id,id,name,time_zone) VALUES('simulation',$1,$2,'Office','UTC')", [org, site]);
    await admin.query("INSERT INTO pactwoven.member_action_sites(environment,organization_id,actor_id,site_id) VALUES('simulation',$1,$2,$3)", [org, aid, site]);
    return { actorId: aid, organizationId: org, environment: 'simulation', principalKind: 'human', roles: ['owner'],
      siteIds: [site], actionSiteIds: [site], sessionId: randomUUID(), authenticatedAt: new Date().toISOString(), correlationId: randomUUID() };
  }
  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (!url.pathname.startsWith('/pactwoven_native_dispatch_') || !['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('A fresh isolated local dispatch database is required.');
    admin = new Pool({ connectionString: url.href, max: 4 });
    if ((await admin.query("SELECT to_regclass('pactwoven.native_dispatch_outbox') AS table_name")).rows[0].table_name) throw new Error('Dispatch migration tests require a fresh pre-0022 database.');
    const oldActor = await fixture();
    for (const state of ['queued', 'completed']) {
      const id = randomUUID();
      await admin.query(`INSERT INTO pactwoven.native_tasks(environment,organization_id,id,actor_id,session_id,site_id,title,prompt,status,phase,row_version,last_sequence,checkpoint)
        VALUES('simulation',$1,$2,$3,$4,$5,'Preserved task','Preserve this existing work.',$6,'Historical state',7,1,'{"saved":["historical checkpoint"]}')`,
        [oldActor.organizationId, id, oldActor.actorId, oldActor.sessionId, oldActor.siteIds[0], state]);
      await admin.query("INSERT INTO pactwoven.native_task_messages(environment,organization_id,task_id,id,role,body,ordinal) VALUES('simulation',$1,$2,'original-message','user','Preserve this existing work.',1)", [oldActor.organizationId, id]);
      await admin.query("INSERT INTO pactwoven.native_task_artifacts(environment,organization_id,task_id,id,kind,title,body,sources,ordinal) VALUES('simulation',$1,$2,'original-artifact','research','Original research','Historical observation.','[]',1)", [oldActor.organizationId, id]);
      await admin.query("INSERT INTO pactwoven.native_task_events(environment,organization_id,task_id,sequence,kind,title,detail,agent) VALUES('simulation',$1,$2,1,'progress','Historical observation','Evidence already saved.','research')", [oldActor.organizationId, id]);
    }
    const evidenceSql = `SELECT jsonb_build_object('messages',(SELECT jsonb_agg(to_jsonb(m) ORDER BY task_id,id) FROM pactwoven.native_task_messages m),
      'artifacts',(SELECT jsonb_agg(to_jsonb(a) ORDER BY task_id,id) FROM pactwoven.native_task_artifacts a),
      'events',(SELECT jsonb_agg(to_jsonb(e) ORDER BY task_id,sequence) FROM pactwoven.native_task_events e)) AS evidence`;
    evidenceBefore = (await admin.query(evidenceSql)).rows[0].evidence;
    upgradeBefore = (await admin.query('SELECT to_jsonb(t) AS task FROM pactwoven.native_tasks t ORDER BY id')).rows;
    await admin.query(await readFile(new URL('../migrations/0022_native_dispatch.sql', import.meta.url), 'utf8'));
    upgradeAfter = (await admin.query("SELECT to_jsonb(t)-ARRAY['dispatch_generation','dispatch_engine_revision','runnable_at','dispatch_recoveries'] AS task FROM pactwoven.native_tasks t ORDER BY id")).rows;
    evidenceAfter = (await admin.query(evidenceSql)).rows[0].evidence;
    upgradeRows = (await admin.query('SELECT count(*)::int AS count FROM pactwoven.native_dispatch_outbox')).rows[0].count;
    await admin.query("UPDATE pactwoven.native_tasks SET status='cancelled' WHERE organization_id=$1", [oldActor.organizationId]);
    const prefix = `pactwoven_nd_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const suppliedPasswords = { api: process.env.PACTWOVEN_NATIVE_TEST_API_PASSWORD,
      worker: process.env.PACTWOVEN_NATIVE_TEST_WORKER_PASSWORD, dispatcher: process.env.PACTWOVEN_NATIVE_TEST_DISPATCHER_PASSWORD };
    if ((process.env.CI === 'true' || Object.values(suppliedPasswords).some(Boolean)) && !Object.values(suppliedPasswords).every(Boolean)) {
      throw new Error('All three isolated native test passwords are required for CI or supplied credentials.');
    }
    const pools: Pool[] = [];
    for (const purpose of ['api', 'worker', 'dispatcher'] as const) {
      const role = `${prefix}_${purpose}`;
      await admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
      const password = suppliedPasswords[purpose] ?? randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
      const statement = await admin.query<{ statement: string }>("SELECT format('ALTER ROLE %I PASSWORD %L',$1::text,$2::text) AS statement", [role, password]);
      await admin.query(statement.rows[0]!.statement);
      await admin.query(`GRANT pactwoven_native_task_${purpose} TO ${role}`);
      await admin.query("INSERT INTO pactwoven.native_task_service_bindings(role_name,role_oid,environment,purpose) SELECT rolname,oid,'simulation',$2 FROM pg_roles WHERE rolname=$1", [role, purpose]);
      const connection = new URL(url); connection.username = role; connection.password = password;
      pools.push(await createNativeTaskPool(connection.href, 'simulation', purpose));
    }
    [apiPool, workerPool, publisherPool] = pools as [Pool, Pool, Pool];
    api = new PostgresNativeTaskRepository(apiPool, 'simulation'); worker = new PostgresNativeTaskWorkerRepository(workerPool, 'simulation');
    publisher = new PostgresNativeDispatchPublisherRepository(publisherPool, 'simulation'); dispatch = new PostgresNativeDispatchWorkerRepository(workerPool, 'simulation');
  });
  beforeEach(async () => { actor = await fixture(); });
  afterEach(async () => { if (admin) await admin.query("UPDATE pactwoven.native_tasks SET status='cancelled',worker_id=NULL,lease_token=NULL,lease_until=NULL WHERE organization_id=ANY($1::text[])", [organizations]); });
  afterAll(async () => { await Promise.allSettled([apiPool?.end(), workerPool?.end(), publisherPool?.end(), admin?.end()]); });
  const create = (requestKey = randomUUID()) => api.create(actor, requestKey, { prompt: 'Compare office chairs.', siteId: actor.siteIds[0]!, mode: 'advise' });
  async function publications(limit = 100) { return publisher.claimPublications('test-publisher', limit, 30_000); }
  async function claim(message: NativeDispatchMessage): Promise<NativeDispatchClaim> {
    const result = await dispatch.claimTarget(message, 'test-worker', 30_000); expect(result.kind).toBe('claimed');
    if (result.kind !== 'claimed') throw new Error('Expected targeted claim');
    return { claim: result.claim, dispatch: result.dispatch };
  }
  async function generation(taskId: string) {
    return Number((await admin.query('SELECT dispatch_generation FROM pactwoven.native_tasks WHERE organization_id=$1 AND id=$2', [actor.organizationId, taskId])).rows[0].dispatch_generation);
  }
  it('preserves populated pre-0022 task data and schedules only existing queued work', () => {
    expect(upgradeAfter).toEqual(upgradeBefore); expect(evidenceAfter).toEqual(evidenceBefore); expect(upgradeRows).toBe(1);
  });
  it('atomically schedules create, queued steering and resume but not exact replays or pause', async () => {
    const key = randomUUID(); const task = await create(key); const first = (await publications())[0]!;
    expect(first.message).toMatchObject({ schemaVersion: 1, engineRevision: 'native-advice-v1', taskId: task.id, generation: 1 });
    expect(Object.keys(first.message).sort()).toEqual(['engineRevision', 'environment', 'generation', 'organizationId', 'schemaVersion', 'taskId']);
    await create(key); expect(await generation(task.id)).toBe(1);
    const replyKey = randomUUID(); const input = { expectedVersion: task.version, text: 'Only blue chairs.' };
    const reply = await api.reply(actor, task.id, replyKey, input); expect(await generation(task.id)).toBe(2);
    await api.reply(actor, task.id, replyKey, input); expect(await generation(task.id)).toBe(2);
    expect(await dispatch.claimTarget(first.message, 'late', 30_000)).toEqual({ kind: 'stale' });
    expect(await publisher.acknowledgePublication(first)).toBe(false);
    const paused = await api.control(actor, task.id, { action: 'pause', expectedVersion: reply.version }); expect(await generation(task.id)).toBe(2);
    expect(await publications()).toEqual([]);
    await api.control(actor, task.id, { action: 'resume', expectedVersion: paused.version }); expect(await generation(task.id)).toBe(3);
    expect((await publications())[0]!.message.generation).toBe(3);
  });
  it('accepts delivery before publication acknowledgment and returns busy for duplicate execution', async () => {
    const task = await create(); const publication = (await publications())[0]!;
    const work = await claim(publication.message); expect(work.claim.task.id).toBe(task.id);
    expect(await dispatch.claimTarget(publication.message, 'duplicate', 30_000)).toMatchObject({ kind: 'busy' });
    expect(await publisher.acknowledgePublication(publication)).toBe(true);
    await worker.progress(work.claim, { ...progress(), status: 'completed', event: { kind: 'completed', title: 'Done', detail: '', agent: 'coordinator' } });
    expect(await dispatch.claimTarget(publication.message, 'late', 30_000)).toEqual({ kind: 'inactive' });
  });
  it('serializes concurrent publication leases and targeted claims', async () => {
    await create(); const rows = await Promise.all([publications(1), publications(1)]);
    expect(rows.flat()).toHaveLength(1); const message = rows.flat()[0]!.message;
    const results = await Promise.all([dispatch.claimTarget(message, 'one', 30_000), dispatch.claimTarget(message, 'two', 30_000)]);
    expect(results.map(result => result.kind).sort()).toEqual(['busy', 'claimed']);
  });
  it('recovers a lost publish acknowledgment with the same idempotency key and fences the former publisher', async () => {
    await create(); const first = (await publications())[0]!;
    await admin.query("UPDATE pactwoven.native_dispatch_outbox SET publication_lease_until=clock_timestamp()-interval '1 second' WHERE organization_id=$1", [actor.organizationId]);
    const second = (await publications())[0]!;
    expect(second.message).toEqual(first.message); expect(second.idempotencyKey).toBe(first.idempotencyKey); expect(second.publicationToken).not.toBe(first.publicationToken);
    expect(await publisher.acknowledgePublication(first)).toBe(false); expect(await publisher.retryPublication(first, 0)).toBe(false);
    expect(await publisher.acknowledgePublication(second)).toBe(true); expect(await publications()).toEqual([]);
  });
  it('rechecks publication lease expiry after waiting on its row lock', async () => {
    await create(); const publication = (await publications())[0]!; const blocker = await admin.connect();
    try {
      await blocker.query('BEGIN'); await blocker.query("UPDATE pactwoven.native_dispatch_outbox SET publication_lease_until=clock_timestamp()+interval '200 milliseconds' WHERE organization_id=$1", [actor.organizationId]);
      const waiting = publisher.acknowledgePublication(publication);
      await blocker.query('SELECT pg_sleep(0.3)'); await blocker.query('COMMIT');
      expect(await waiting).toBe(false);
    } finally { await blocker.query('ROLLBACK'); blocker.release(); }
  });
  it('atomically yields artifacts and checkpoint with a delayed next generation; legacy claim respects the delay', async () => {
    const task = await create(); const publication = (await publications())[0]!; const work = await claim(publication.message);
    expect(await dispatch.yieldClaim(work, progress(), 30_000)).toBe(true);
    const saved = await api.get(actor, task.id); expect(saved.status).toBe('queued'); expect(saved.artifacts).toHaveLength(1);
    expect(saved.events.filter(event => event.kind === 'resumed')).toEqual([]);
    const continuation = (await publications())[0]!; expect(continuation.message.generation).toBe(2);
    expect(Date.parse(continuation.notBefore)).toBeGreaterThan(Date.now());
    expect(await dispatch.claimTarget(continuation.message, 'too-early', 30_000)).toMatchObject({ kind: 'not_ready' });
    expect(await worker.claim('legacy-too-early', 30_000)).toBeNull();
    expect(await dispatch.claimTarget(publication.message, 'old', 30_000)).toEqual({ kind: 'stale' });
    expect(await dispatch.yieldClaim(work, progress())).toBe(false);
    await admin.query("UPDATE pactwoven.native_tasks SET runnable_at=clock_timestamp()-interval '1 second' WHERE organization_id=$1", [actor.organizationId]);
    const next = await claim(continuation.message); expect(next.claim.checkpoint).toEqual(progress().checkpoint);
    expect(await worker.progress(work.claim, progress())).toBe(false);
  });
  it('rolls back a conflicting yielded artifact and rejects a forged operator resume event', async () => {
    await create(); const work = await claim((await publications())[0]!.message); await worker.progress(work.claim, progress());
    const before = await api.get(actor, work.claim.task.id);
    await expect(dispatch.yieldClaim(work, { ...progress(), artifact: { ...progress().artifact!, text: 'Conflicting bytes' } })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(await api.get(actor, before.id)).toEqual(before); expect(await generation(before.id)).toBe(1);
    await expect(workerPool.query('SELECT pactwoven.native_dispatch_yield($1,$2::jsonb,$3::uuid,$4::jsonb,0)', ['simulation', JSON.stringify(work.dispatch), work.claim.leaseToken,
      JSON.stringify({ ...progress(), event: { kind: 'resumed', title: 'Forged resume', detail: '', agent: null } })])).rejects.toMatchObject({ code: 'NT004' });
    expect(await api.get(actor, before.id)).toEqual(before);
  });
  it('schedules ordinary legacy release without losing its checkpoint', async () => {
    await create(); const work = await claim((await publications())[0]!.message); await worker.progress(work.claim, progress()); await worker.release(work.claim);
    const next = (await publications())[0]!; expect(next.message.generation).toBe(2); expect((await claim(next.message)).claim.checkpoint).toEqual(progress().checkpoint);
  });
  it('a queued operator reply replaces an inherited delayed continuation with an immediate wakeup', async () => {
    const task = await create(); const work = await claim((await publications())[0]!.message);
    await dispatch.yieldClaim(work, progress(), 60_000); const delayed = (await publications())[0]!;
    const queued = await api.get(actor, task.id); await api.reply(actor, task.id, randomUUID(), { text: 'Use the revised location.', expectedVersion: queued.version });
    const fresh = (await publications())[0]!; expect(fresh.message.generation).toBe(3); expect(Date.parse(fresh.notBefore)).toBeLessThanOrEqual(Date.now());
    expect(await dispatch.claimTarget(delayed.message, 'old', 30_000)).toEqual({ kind: 'stale' }); expect((await claim(fresh.message)).claim.checkpoint).toEqual({});
  });
  it('recovers expired worker leases with a new generation and exact checkpoint continuity', async () => {
    await create(); const publication = (await publications())[0]!; const work = await claim(publication.message); await worker.progress(work.claim, progress());
    await admin.query("UPDATE pactwoven.native_tasks SET lease_until=clock_timestamp()-interval '1 second' WHERE organization_id=$1", [actor.organizationId]);
    expect(await publisher.recoverDue(1)).toMatchObject({ recoveredWorkerLeases: 1 });
    const next = (await publications())[0]!; expect(next.message.generation).toBe(2);
    expect(await dispatch.claimTarget(publication.message, 'late', 30_000)).toEqual({ kind: 'stale' });
    expect((await claim(next.message)).claim.checkpoint).toEqual(progress().checkpoint); expect(await worker.renew(work.claim, 30_000)).toBe(false);
  });
  it('recovers accepted-but-never-delivered work and quarantines after three automatic recoveries', async () => {
    const task = await create(); let original: NativeDispatchMessage | undefined;
    for (let attempt = 0; attempt < 4; attempt++) {
      const publication = (await publications())[0]!; original ??= publication.message;
      expect(await publisher.acknowledgePublication(publication)).toBe(true);
      await admin.query("UPDATE pactwoven.native_dispatch_outbox SET delivery_deadline=clock_timestamp()-interval '1 second' WHERE organization_id=$1 AND state='published'", [actor.organizationId]);
      expect(await publisher.recoverDue(1)).toMatchObject(attempt < 3 ? { recoveredDeliveries: 1, quarantined: 0 } : { recoveredDeliveries: 0, quarantined: 1 });
    }
    const paused = await api.get(actor, task.id); expect(paused.status).toBe('paused'); expect(paused.phase).toBe('Connection needs attention');
    expect(await publications()).toEqual([]); expect(await publisher.recoverDue(100)).toMatchObject({ recoveredDeliveries: 0, quarantined: 0 });
    await api.control(actor, task.id, { action: 'resume', expectedVersion: paused.version });
    const resumed = (await publications())[0]!; expect(resumed.message.generation).toBe(5);
    expect(await dispatch.claimTarget(original!, 'old', 30_000)).toEqual({ kind: 'stale' }); expect((await claim(resumed.message)).claim.task.id).toBe(task.id);
  });
  it('quarantines repeated publication failure after eight leased attempts', async () => {
    const task = await create();
    for (let attempt = 0; attempt < 8; attempt++) { const publication = (await publications())[0]!; expect(await publisher.retryPublication(publication, 0)).toBe(true); }
    expect(await publications()).toEqual([]); expect(await publisher.recoverDue(1)).toMatchObject({ quarantined: 1 });
    expect((await api.get(actor, task.id)).status).toBe('paused');
  });
  it('bounds recovery work and repairs missing outbox rows without changing generation', async () => {
    const a = await create(), b = await create();
    await admin.query('DELETE FROM pactwoven.native_dispatch_outbox WHERE organization_id=$1', [actor.organizationId]);
    expect(await publisher.recoverDue(1)).toMatchObject({ repairedPublications: 1, moreDue: true });
    expect(await publisher.recoverDue(1)).toMatchObject({ repairedPublications: 1, moreDue: false });
    expect(await generation(a.id)).toBe(1); expect(await generation(b.id)).toBe(1); expect(await publications(1)).toHaveLength(1);
  });
  it.each(['role', 'action_site', 'session'])('targeted claim enforces current %s authority', async reason => {
    const task = await create(); const publication = (await publications())[0]!;
    if (reason === 'role') await admin.query("UPDATE pactwoven.memberships SET roles=ARRAY['auditor'] WHERE organization_id=$1", [actor.organizationId]);
    if (reason === 'action_site') await admin.query('DELETE FROM pactwoven.member_action_sites WHERE organization_id=$1', [actor.organizationId]);
    if (reason === 'session') await admin.query("INSERT INTO pactwoven.session_revocations(environment,session_id) VALUES('simulation',$1)", [actor.sessionId]);
    expect(await dispatch.claimTarget(publication.message, 'revoked', 30_000)).toEqual({ kind: 'revoked' });
    expect((await admin.query('SELECT status FROM pactwoven.native_tasks WHERE id=$1', [task.id])).rows[0].status).toBe('paused');
  });
  it('rechecks membership expiry after waiting on the task lock', async () => {
    const task = await create(); const publication = (await publications())[0]!; const blocker = await admin.connect();
    try {
      await admin.query("UPDATE pactwoven.memberships SET expires_at=clock_timestamp()+interval '300 milliseconds' WHERE organization_id=$1", [actor.organizationId]);
      await blocker.query('BEGIN'); await blocker.query('SELECT id FROM pactwoven.native_tasks WHERE id=$1 FOR UPDATE', [task.id]);
      const waiting = dispatch.claimTarget(publication.message, 'blocked', 30_000);
      await blocker.query('SELECT pg_sleep(0.4)'); await blocker.query('COMMIT');
      expect(await waiting).toEqual({ kind: 'revoked' });
    } finally { await blocker.query('ROLLBACK'); blocker.release(); }
  });
  it.each(['paused', 'failed', 'cancelled'] as const)('%s work cannot be awakened by queue delivery', async status => {
    const task = await create(); const publication = (await publications())[0]!;
    if (status === 'failed') {
      const work = await claim(publication.message);
      await worker.progress(work.claim, { ...progress(), status: 'failed', event: { kind: 'failed', title: 'Unavailable', detail: '', agent: 'research' } });
    } else await api.control(actor, task.id, { action: status === 'paused' ? 'pause' : 'cancel', expectedVersion: task.version });
    expect(await dispatch.claimTarget(publication.message, 'late', 30_000)).toEqual({ kind: 'inactive' }); expect(await publications()).toEqual([]);
  });
  it('yield rechecks revoked access and creates no new dispatch', async () => {
    const task = await create(); const work = await claim((await publications())[0]!.message);
    await admin.query('DELETE FROM pactwoven.member_action_sites WHERE organization_id=$1', [actor.organizationId]);
    expect(await dispatch.yieldClaim(work, progress())).toBe(false); expect(await generation(task.id)).toBe(1);
    expect((await api.get(actor, task.id)).status).toBe('paused'); expect(await publications()).toEqual([]);
  });
  it('rejects foreign scope, stale protocol and unavailable task identities', async () => {
    await create(); const publication = (await publications())[0]!;
    await expect(dispatch.claimTarget({ ...publication.message, environment: 'development' }, 'bad', 30_000)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await dispatch.claimTarget({ ...publication.message, organizationId: 'different-company' }, 'bad', 30_000)).toEqual({ kind: 'not_found' });
    expect(await dispatch.claimTarget({ ...publication.message, generation: 99 }, 'future', 30_000)).toEqual({ kind: 'stale' });
    const response = await workerPool.query('SELECT pactwoven.native_dispatch_claim_target($1,$2::jsonb,$3,30000) AS result', ['simulation', JSON.stringify({ ...publication.message, engineRevision: 'old-engine' }), 'old']);
    expect(response.rows[0].result).toEqual({ kind: 'revision_mismatch' });
  });
  it('keeps dispatcher, API and worker roles function-only and purpose-separated', async () => {
    for (const pool of [apiPool, workerPool, publisherPool]) await expect(pool.query('SELECT * FROM pactwoven.native_dispatch_outbox')).rejects.toMatchObject({ code: '42501' });
    await expect(publisherPool.query("SELECT pactwoven.native_task_claim('simulation','bad',30000)")).rejects.toMatchObject({ code: '42501' });
    await expect(workerPool.query("SELECT pactwoven.native_dispatch_recover('simulation',10)")).rejects.toMatchObject({ code: '42501' });
    await expect(apiPool.query("SELECT pactwoven.native_dispatch_claim_publications('simulation','bad',10,30000)")).rejects.toMatchObject({ code: '42501' });
    await expect(assertNativeTaskPool(publisherPool, 'development', 'dispatcher')).rejects.toMatchObject({ code: 'UNSAFE_DATABASE_ROLE' });
    await expect(assertNativeTaskPool(admin, 'simulation', 'dispatcher')).rejects.toMatchObject({ code: 'UNSAFE_DATABASE_ROLE' });
    expect((await publisherPool.query("SELECT pactwoven.native_task_binding('simulation','unknown') AS valid")).rows[0].valid).toBe(false);
  });
});

describe('native dispatch repository and contract boundary', () => {
  it('rejects malformed or foreign messages before database access', async () => {
    const query = vi.fn(); const repository = new PostgresNativeDispatchWorkerRepository({ query } as unknown as Pool, 'development');
    const message = { schemaVersion: 1, engineRevision: 'native-advice-v1', environment: 'development', organizationId: 'org', taskId: 'task', generation: 1 } as const;
    await expect(repository.claimTarget({ ...message, generation: Number.MAX_SAFE_INTEGER + 1 }, 'worker', 30_000)).rejects.toBeDefined();
    await expect(repository.claimTarget({ ...message, environment: 'production' }, 'worker', 30_000)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(query).not.toHaveBeenCalled();
  });
  it('rejects a result whose base claim and queue envelope disagree', () => {
    const result = { kind: 'claimed', dispatch: { schemaVersion: 1, engineRevision: 'native-advice-v1', environment: 'development', organizationId: 'one', taskId: 'task', generation: 1 },
      claim: { environment: 'development', organizationId: 'two', actorId: 'actor', leaseToken: randomUUID(), checkpoint: {},
        task: { id: 'task', title: 'Task', prompt: 'Do research', mode: 'advise', status: 'running', phase: 'Working', siteId: 'site', version: 1,
          createdAt: '2026-11-18T00:00:00Z', updatedAt: '2026-11-18T00:00:00Z', availableActions: [], steps: [], messages: [], artifacts: [], events: [] } } };
    expect(NativeDispatchClaimResultSchema.safeParse(result).success).toBe(false);
  });
});
