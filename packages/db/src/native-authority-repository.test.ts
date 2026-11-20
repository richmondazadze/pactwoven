import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeAuthorityRequestSchema, NativeAuthorityResponseSchema, NativeAuthorityVerdictSchema,
  type ActorContext, type NativeAuthorityPrepareResult, type NativeAuthorityVerdict, type NativeDispatchMessage,
  type NativeTaskProgress } from '@pactwoven/contracts';
import { PostgresNativeAuthorityRepository } from './native-authority-repository.js';
import { PostgresNativeTaskRepository, PostgresNativeTaskWorkerRepository } from './native-task-repository.js';
import { PostgresNativeDispatchWorkerRepository } from './native-dispatch-repository.js';
import { assertNativeTaskPool, createNativeTaskPool } from './native-task-pool.js';

const databaseUrl = process.env.PACTWOVEN_NATIVE_AUTHORITY_TEST_DATABASE_URL;
const issuer = 'https://pactwoven-fixture.clerk.accounts.dev';
type Prepared = Extract<NativeAuthorityPrepareResult, { kind: 'prepared' }>;
const observation = (state: NativeAuthorityVerdict['state'] = 'allowed', expires = Date.now() + 60_000): NativeAuthorityVerdict => ({
  state, reason: state === 'allowed' ? 'current' : state === 'denied' ? 'session_inactive' : 'provider_unavailable',
  observationStartedAt: new Date(Date.now() - 10).toISOString(), observationCompletedAt: new Date().toISOString(),
  providerExpiresAt: state === 'allowed' ? new Date(expires).toISOString() : null,
});
const progress = (completed = false): NativeTaskProgress => ({ phase: completed ? 'Finished' : 'Research saved', status: completed ? 'completed' : 'running',
  checkpoint: { schemaVersion: 2, documents: [], attempts: { research: 1 }, saved: 'preserve me' },
  event: { kind: completed ? 'completed' : 'progress', title: 'Research saved', detail: '', agent: 'research' },
  ...(completed ? { message: { id: 'report-message', role: 'assistant' as const, text: 'The report is ready.' },
    artifact: { id: 'report', kind: 'report' as const, title: 'Report', text: 'Saved report.', sources: [] } } : {}),
});

describe.skipIf(!databaseUrl)('native provider authority PostgreSQL boundaries', () => {
  let admin: Pool, apiPool: Pool, workerPool: Pool;
  let authority: PostgresNativeAuthorityRepository, api: PostgresNativeTaskRepository;
  let worker: PostgresNativeTaskWorkerRepository, dispatch: PostgresNativeDispatchWorkerRepository;
  let actor: ActorContext; const organizations: string[] = [];
  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (!/^\/pactwoven_native_(authority(?:_|$)|dispatch_)/.test(url.pathname) || !['localhost', '127.0.0.1'].includes(url.hostname)) {
      throw new Error('Authority integration requires a dedicated loopback native authority or dispatch test database.');
    }
    admin = new Pool({ connectionString: url.href, max: 4 });
    await admin.query(`INSERT INTO pactwoven.native_provider_instances(environment,issuer) VALUES('development',$1)
      ON CONFLICT(environment) DO UPDATE SET issuer=excluded.issuer,enabled=true`, [issuer]);
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12); const pools: Pool[] = [];
    for (const purpose of ['api', 'worker'] as const) {
      const role = `pactwoven_authority_${suffix}_${purpose}`, password = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
      const quoted = await admin.query("SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD %L',$1::text,$2::text) AS statement", [role, password]);
      await admin.query(quoted.rows[0].statement); await admin.query(`GRANT pactwoven_native_task_${purpose} TO ${role}`);
      await admin.query("INSERT INTO pactwoven.native_task_service_bindings(role_name,role_oid,environment,purpose) SELECT rolname,oid,'development',$2 FROM pg_roles WHERE rolname=$1", [role, purpose]);
      const connection = new URL(url); connection.username = role; connection.password = password;
      pools.push(await createNativeTaskPool(connection.href, 'development', purpose));
    }
    [apiPool, workerPool] = pools as [Pool, Pool]; authority = new PostgresNativeAuthorityRepository(apiPool, 'development');
    api = new PostgresNativeTaskRepository(apiPool, 'development'); worker = new PostgresNativeTaskWorkerRepository(workerPool, 'development');
    dispatch = new PostgresNativeDispatchWorkerRepository(workerPool, 'development');
  });
  async function fixture(bootstrap = false): Promise<ActorContext> {
    const org = `authority_${randomUUID()}`, member = randomUUID(), site = randomUUID(); organizations.push(org);
    await admin.query("INSERT INTO pactwoven.organizations(environment,id,external_organization_id,name) VALUES('development',$1,$1,'Authority fixture')", [org]);
    await admin.query(`INSERT INTO pactwoven.memberships(environment,organization_id,actor_id,external_subject,external_membership_id,grant_basis,roles)
      VALUES('development',$1,$2,$2,$3,$4,ARRAY['owner'])`, [org, member, `orgmem_${randomUUID()}`, bootstrap ? 'clerk_admin_bootstrap' : 'internal']);
    await admin.query("INSERT INTO pactwoven.sites(environment,organization_id,id,name,time_zone) VALUES('development',$1,$2,'Office','UTC')", [org, site]);
    await admin.query("INSERT INTO pactwoven.member_action_sites(environment,organization_id,actor_id,site_id) VALUES('development',$1,$2,$3)", [org, member, site]);
    return { environment: 'development', organizationId: org, actorId: member, principalKind: 'human', roles: ['owner'], siteIds: [site],
      actionSiteIds: [site], sessionId: `sess_${randomUUID()}`, authenticatedAt: new Date().toISOString(), correlationId: randomUUID() };
  }
  beforeEach(async () => { actor = await fixture(); });
  afterEach(async () => { if (admin) await admin.query("UPDATE pactwoven.native_tasks SET status='cancelled',worker_id=NULL,lease_token=NULL,lease_until=NULL WHERE organization_id=ANY($1::text[])", [organizations]); });
  afterAll(async () => { await Promise.allSettled([apiPool?.end(), workerPool?.end(), admin?.end()]); });
  async function create(a = actor) {
    return api.create(a, randomUUID(), { prompt: 'Compare chairs.', mode: 'advise', siteId: a.siteIds[0]! });
  }
  async function message(id: string): Promise<NativeDispatchMessage> {
    const t = (await admin.query('SELECT organization_id,dispatch_generation FROM pactwoven.native_tasks WHERE id=$1', [id])).rows[0];
    return { schemaVersion: 1, engineRevision: 'native-advice-v1', environment: 'development', organizationId: t.organization_id,
      taskId: id, generation: Number(t.dispatch_generation) };
  }
  async function prepare(id: string): Promise<Prepared> {
    const result = await authority.prepare(await message(id), issuer); expect(result.kind).toBe('prepared');
    if (result.kind !== 'prepared') throw new Error('Expected an authority preparation'); return result;
  }
  async function allow(id: string) { const prepared = await prepare(id); const result = await authority.finish(prepared.nonce, observation()); expect(result.state).toBe('allowed'); return { prepared, result }; }
  async function claim(id: string) {
    const result = await dispatch.claimTarget(await message(id), 'authority_worker', 30_000);
    expect(result.kind).toBe('claimed'); if (result.kind !== 'claimed') throw new Error('Expected a current claim');
    return { claim: result.claim, dispatch: result.dispatch };
  }
  async function snapshot(id: string) {
    return (await admin.query(`SELECT jsonb_build_object('task',(SELECT to_jsonb(t) FROM pactwoven.native_tasks t WHERE id=$1),
      'messages',(SELECT jsonb_agg(to_jsonb(m) ORDER BY ordinal) FROM pactwoven.native_task_messages m WHERE task_id=$1),
      'artifacts',(SELECT jsonb_agg(to_jsonb(a) ORDER BY ordinal) FROM pactwoven.native_task_artifacts a WHERE task_id=$1),
      'events',(SELECT jsonb_agg(to_jsonb(e) ORDER BY sequence) FROM pactwoven.native_task_events e WHERE task_id=$1),
      'outbox',(SELECT jsonb_agg(to_jsonb(o) ORDER BY generation) FROM pactwoven.native_dispatch_outbox o WHERE task_id=$1)) AS state`, [id])).rows[0].state;
  }
  async function shortProof(id: string, milliseconds = 300) {
    await admin.query("UPDATE pactwoven.native_provider_authority SET valid_until=clock_timestamp()+$2*interval '1 millisecond' WHERE task_id=$1", [id, milliseconds]);
  }

  it('treats legacy real-environment tasks as unknown without pausing or claiming', async () => {
    const task = await create(); const before = await snapshot(task.id);
    expect(await dispatch.claimTarget(await message(task.id), 'worker', 30_000)).toEqual({ kind: 'not_ready', retryAfterMilliseconds: 1000 });
    expect(await worker.claim('worker', 30_000)).toBeNull(); expect(await snapshot(task.id)).toEqual(before);
  });
  it('derives exact stored provider context and caps permission at DB preparation plus twenty seconds', async () => {
    const task = await create(); const prepared = await prepare(task.id);
    expect(prepared.context).toMatchObject({ sessionId: actor.sessionId, subject: actor.actorId, externalOrganizationId: actor.organizationId, requiredRole: null });
    expect(prepared.context.externalMembershipId).toMatch(/^orgmem_/); expect(prepared.providerIssuer).toBe(issuer);
    expect(Date.parse(prepared.deadlineAt) - Date.parse(prepared.preparedAt)).toBe(8_000);
    const result = await authority.finish(prepared.nonce, observation()); expect(result.state).toBe('allowed');
    expect(result.observedAt).toBe(prepared.preparedAt); expect(Date.parse(result.validUntil!) - Date.parse(prepared.preparedAt)).toBe(20_000);
    const work = await claim(task.id); expect(await worker.progress(work.claim, progress())).toBe(true);
  });
  it('requires org:admin only for the persisted Clerk bootstrap grant basis', async () => {
    const owner = await fixture(true); const task = await create(owner); expect((await prepare(task.id)).context.requiredRole).toBe('org:admin');
  });
  it('caps proof by provider session expiry without trusting cross-host observation timestamps for TTL', async () => {
    const task = await create(); const prepared = await prepare(task.id), expiry = Date.now() + 5_000;
    const verdict = observation('allowed', expiry);
    verdict.observationStartedAt = new Date(Date.now() - 60_000).toISOString(); verdict.observationCompletedAt = new Date(Date.now() - 50_000).toISOString();
    const result = await authority.finish(prepared.nonce, verdict); expect(Date.parse(result.validUntil!)).toBe(expiry);
    expect(result.observedAt).toBe(prepared.preparedAt);
  });
  it('coalesces concurrent checks and rejects a consumed or unknown nonce', async () => {
    const task = await create(); const [a, b] = await Promise.all([authority.prepare(await message(task.id), issuer), authority.prepare(await message(task.id), issuer)]);
    expect([a.kind, b.kind].sort()).toEqual(['pending', 'prepared']); const p = (a.kind === 'prepared' ? a : b) as Prepared;
    expect((await authority.finish(p.nonce, observation())).state).toBe('allowed');
    expect((await authority.finish(p.nonce, observation())).state).toBe('stale'); expect((await authority.finish(randomUUID(), observation())).state).toBe('stale');
  });
  it('prevents a late older allow from overwriting a newer denial barrier', async () => {
    const task = await create(); const old = await prepare(task.id);
    await admin.query("UPDATE pactwoven.native_provider_authority SET deadline_at=clock_timestamp()-interval '1 millisecond' WHERE task_id=$1", [task.id]);
    const current = await prepare(task.id); expect(current.nonce).not.toBe(old.nonce);
    expect((await authority.finish(current.nonce, observation('denied'))).state).toBe('denied');
    const before = await snapshot(task.id); expect(before.task.status).toBe('paused');
    expect((await authority.finish(old.nonce, observation())).state).toBe('stale'); expect(await snapshot(task.id)).toEqual(before);
  });
  it('fences a running denial while retaining its committed checkpoint and evidence', async () => {
    const task = await create(); await allow(task.id); const work = await claim(task.id); await worker.progress(work.claim, progress());
    const before = await snapshot(task.id); const refresh = await prepare(task.id);
    expect((await authority.finish(refresh.nonce, observation('denied'))).state).toBe('denied');
    const after = await snapshot(task.id); expect(after.task.status).toBe('paused'); expect(after.task.lease_token).toBeNull();
    expect(after.task.checkpoint).toEqual(before.task.checkpoint); expect(after.messages).toEqual(before.messages); expect(after.artifacts).toEqual(before.artifacts);
    expect(after.outbox.every((row: { state: string }) => row.state === 'superseded')).toBe(true);
    expect(await worker.renew(work.claim, 30_000)).toBe(false); expect(await worker.progress(work.claim, progress(true))).toBe(false);
  });
  it('makes unavailable observations unknown without fabricated revocation or checkpoint changes', async () => {
    const task = await create(); await allow(task.id); const work = await claim(task.id); await worker.progress(work.claim, progress());
    const before = await snapshot(task.id); const prepared = await prepare(task.id);
    expect((await authority.finish(prepared.nonce, observation('unavailable'))).state).toBe('unavailable');
    expect(await worker.progress(work.claim, progress(true))).toBe(false); expect(await worker.renew(work.claim, 30_000)).toBe(false);
    expect(await snapshot(task.id)).toEqual(before);
  });
  it('cannot resume manual pause through a late allow and requires a new generation after explicit resume', async () => {
    const task = await create(); const old = await prepare(task.id);
    const paused = await api.control(actor, task.id, { action: 'pause', expectedVersion: task.version });
    expect((await authority.finish(old.nonce, observation())).state).toBe('stale'); expect((await api.get(actor, task.id)).status).toBe('paused');
    expect(await authority.prepare(await message(task.id), issuer)).toMatchObject({ kind: 'settled', result: { state: 'stale' } });
    await api.control(actor, task.id, { action: 'resume', expectedVersion: paused.version });
    expect((await dispatch.claimTarget(await message(task.id), 'worker', 30_000)).kind).toBe('not_ready');
    await allow(task.id); await claim(task.id);
  });
  it('does not let an old-generation deny repause an explicitly resumed task', async () => {
    const task = await create(); const prepared = await prepare(task.id); await authority.finish(prepared.nonce, observation('denied'));
    const paused = await api.get(actor, task.id); await api.control(actor, task.id, { action: 'resume', expectedVersion: paused.version });
    expect((await dispatch.claimTarget(await message(task.id), 'worker', 30_000)).kind).toBe('not_ready');
    expect((await api.get(actor, task.id)).status).toBe('queued'); await allow(task.id); await claim(task.id);
  });
  it.each(['session', 'member_version', 'issuer'])('rejects an allow after the stored %s binding changes', async change => {
    const task = await create(); const prepared = await prepare(task.id);
    if (change === 'session') await admin.query("UPDATE pactwoven.native_tasks SET session_id='sess_rebound' WHERE id=$1", [task.id]);
    if (change === 'member_version') await admin.query('UPDATE pactwoven.memberships SET row_version=row_version+1 WHERE organization_id=$1', [actor.organizationId]);
    if (change === 'issuer') await admin.query("UPDATE pactwoven.native_provider_instances SET enabled=false WHERE environment='development'");
    try {
      expect((await authority.finish(prepared.nonce, observation())).state).toBe('stale');
      expect((await dispatch.claimTarget(await message(task.id), 'worker', 30_000)).kind).toBe('not_ready');
    } finally { if (change === 'issuer') await admin.query("UPDATE pactwoven.native_provider_instances SET enabled=true WHERE environment='development'"); }
  });
  it('keeps local membership and session revocation independently authoritative', async () => {
    const task = await create(); await allow(task.id); const work = await claim(task.id);
    await admin.query("INSERT INTO pactwoven.session_revocations(environment,session_id) VALUES('development',$1)", [actor.sessionId]);
    expect(await worker.renew(work.claim, 30_000)).toBe(false); expect((await snapshot(task.id)).task.status).toBe('paused');
  });
  it('expires proof after a task-lock wait and preserves the entire last committed record', async () => {
    const task = await create(); await allow(task.id); const work = await claim(task.id); await shortProof(task.id); const before = await snapshot(task.id);
    const blocker = await admin.connect();
    try {
      await blocker.query('BEGIN'); await blocker.query('SELECT id FROM pactwoven.native_tasks WHERE id=$1 FOR UPDATE', [task.id]);
      const pending = worker.progress(work.claim, progress(true)); await admin.query('SELECT pg_sleep(0.4)');
      await blocker.query('COMMIT'); expect(await pending).toBe(false); expect(await snapshot(task.id)).toEqual(before);
    } finally { await blocker.query('ROLLBACK'); blocker.release(); }
  });
  it('rolls back candidate final writes if proof expires after the completion event', async () => {
    const task = await create(); await allow(task.id); const work = await claim(task.id); const before = await snapshot(task.id);
    await admin.query(`CREATE SEQUENCE pactwoven.native_authority_test_hits;
      CREATE FUNCTION pactwoven.native_authority_test_delay() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
      BEGIN PERFORM nextval('pactwoven.native_authority_test_hits'); PERFORM pg_sleep(0.5); RETURN NEW; END $$;
      REVOKE ALL ON FUNCTION pactwoven.native_authority_test_delay() FROM PUBLIC;
      REVOKE ALL ON SEQUENCE pactwoven.native_authority_test_hits FROM PUBLIC;
      CREATE TRIGGER native_authority_test_delay AFTER INSERT ON pactwoven.native_task_events FOR EACH ROW
        WHEN (NEW.kind='completed') EXECUTE FUNCTION pactwoven.native_authority_test_delay();`);
    try {
      await shortProof(task.id); expect(await worker.progress(work.claim, progress(true))).toBe(false);
      expect((await admin.query('SELECT is_called FROM pactwoven.native_authority_test_hits')).rows[0].is_called).toBe(true);
      expect(await snapshot(task.id)).toEqual(before);
    } finally { await admin.query('DROP TRIGGER native_authority_test_delay ON pactwoven.native_task_events; DROP FUNCTION pactwoven.native_authority_test_delay(); DROP SEQUENCE pactwoven.native_authority_test_hits'); }
  });
  it('requires fresh authority for the generation produced by a successful yield', async () => {
    const task = await create(); await allow(task.id); const work = await claim(task.id);
    expect(await dispatch.yieldClaim(work, progress(), 0)).toBe(true);
    expect((await dispatch.claimTarget(await message(task.id), 'worker', 30_000)).kind).toBe('not_ready');
    await allow(task.id); expect((await claim(task.id)).claim.checkpoint).toEqual(progress().checkpoint);
  });
  it.each(['claim', 'renew', 'yield'])('rolls back a candidate %s when proof expires after its write', async action => {
    const task = await create(); await allow(task.id); const work = action === 'claim' ? null : await claim(task.id);
    const before = await snapshot(task.id);
    const table = action === 'claim' ? 'native_task_events' : 'native_tasks';
    const operation = action === 'claim' ? 'INSERT' : 'UPDATE';
    const condition = action === 'claim' ? "NEW.title='The team started work'" : action === 'renew'
      ? "NEW.status='running' AND OLD.lease_until IS DISTINCT FROM NEW.lease_until" : "NEW.status='queued' AND OLD.status='running'";
    await admin.query(`CREATE SEQUENCE pactwoven.native_authority_test_hits;
      CREATE FUNCTION pactwoven.native_authority_test_delay() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
      BEGIN PERFORM nextval('pactwoven.native_authority_test_hits'); PERFORM pg_sleep(0.5); RETURN NEW; END $$;
      REVOKE ALL ON FUNCTION pactwoven.native_authority_test_delay() FROM PUBLIC;
      REVOKE ALL ON SEQUENCE pactwoven.native_authority_test_hits FROM PUBLIC;
      CREATE TRIGGER native_authority_test_delay AFTER ${operation} ON pactwoven.${table} FOR EACH ROW
        WHEN (${condition}) EXECUTE FUNCTION pactwoven.native_authority_test_delay();`);
    try {
      await shortProof(task.id);
      if (action === 'claim') expect((await dispatch.claimTarget(await message(task.id), 'worker', 30_000)).kind).toBe('not_ready');
      if (action === 'renew') expect(await worker.renew(work!.claim, 60_000)).toBe(false);
      if (action === 'yield') expect(await dispatch.yieldClaim(work!, progress(), 0)).toBe(false);
      expect((await admin.query('SELECT is_called FROM pactwoven.native_authority_test_hits')).rows[0].is_called).toBe(true);
      expect(await snapshot(task.id)).toEqual(before);
    } finally { await admin.query(`DROP TRIGGER native_authority_test_delay ON pactwoven.${table}; DROP FUNCTION pactwoven.native_authority_test_delay(); DROP SEQUENCE pactwoven.native_authority_test_hits`); }
  });
  it('returns unavailable if the nonce expires while finish waits for its task lock', async () => {
    const task = await create(); const prepared = await prepare(task.id); const before = await snapshot(task.id);
    await admin.query("UPDATE pactwoven.native_provider_authority SET deadline_at=clock_timestamp()+interval '300 milliseconds' WHERE task_id=$1", [task.id]);
    const blocker = await admin.connect();
    try {
      await blocker.query('BEGIN'); await blocker.query('SELECT id FROM pactwoven.native_tasks WHERE id=$1 FOR UPDATE', [task.id]);
      const pending = authority.finish(prepared.nonce, observation()); await admin.query('SELECT pg_sleep(0.4)');
      await blocker.query('COMMIT'); expect((await pending).state).toBe('unavailable'); expect(await snapshot(task.id)).toEqual(before);
    } finally { await blocker.query('ROLLBACK'); blocker.release(); }
  });
  it('never returns or leaves an allowed proof when its provider expiry crosses during finish writes', async () => {
    const task = await create(); const prepared = await prepare(task.id);
    await admin.query(`CREATE SEQUENCE pactwoven.native_authority_test_hits;
      CREATE FUNCTION pactwoven.native_authority_test_delay() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
      BEGIN PERFORM nextval('pactwoven.native_authority_test_hits'); PERFORM pg_sleep(0.5); RETURN NEW; END $$;
      REVOKE ALL ON FUNCTION pactwoven.native_authority_test_delay() FROM PUBLIC;
      REVOKE ALL ON SEQUENCE pactwoven.native_authority_test_hits FROM PUBLIC;
      CREATE TRIGGER native_authority_test_delay AFTER UPDATE ON pactwoven.native_provider_authority FOR EACH ROW
        WHEN (NEW.verdict='allowed') EXECUTE FUNCTION pactwoven.native_authority_test_delay();`);
    try {
      expect((await authority.finish(prepared.nonce, observation('allowed', Date.now() + 300))).state).toBe('unavailable');
      expect((await admin.query('SELECT is_called FROM pactwoven.native_authority_test_hits')).rows[0].is_called).toBe(true);
      expect((await admin.query('SELECT verdict,valid_until FROM pactwoven.native_provider_authority WHERE task_id=$1', [task.id])).rows[0])
        .toEqual({ verdict: 'unknown', valid_until: null });
      expect((await dispatch.claimTarget(await message(task.id), 'worker', 30_000)).kind).toBe('not_ready');
    } finally { await admin.query('DROP TRIGGER native_authority_test_delay ON pactwoven.native_provider_authority; DROP FUNCTION pactwoven.native_authority_test_delay(); DROP SEQUENCE pactwoven.native_authority_test_hits'); }
  });
  it('does not accept a finish after its DB nonce deadline', async () => {
    const task = await create(); const prepared = await prepare(task.id);
    await admin.query("UPDATE pactwoven.native_provider_authority SET deadline_at=clock_timestamp()-interval '1 second' WHERE task_id=$1", [task.id]);
    expect((await authority.finish(prepared.nonce, observation())).state).toBe('unavailable');
    expect((await dispatch.claimTarget(await message(task.id), 'worker', 30_000)).kind).toBe('not_ready');
  });
  it('rejects forged instance, malformed SQL observations, extra identity fields and cross-purpose access', async () => {
    const task = await create(); const msg = await message(task.id);
    await expect(authority.prepare(msg, 'https://other.clerk.accounts.dev')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const prepared = await prepare(task.id); const valid = observation();
    for (const input of [{ ...valid, providerExpiresAt: null }, { ...valid, reason: 'session_missing' }, { ...valid, state: 'denied', reason: 'network' },
      { ...valid, observationStartedAt: 'infinity' }, { ...valid, observationCompletedAt: '2000-01-01T00:00:00Z' }, { ...valid, extra: 'identity' }]) {
      await expect(apiPool.query('SELECT pactwoven.native_provider_authority_finish($1,$2::uuid,$3::jsonb)', ['development', prepared.nonce, JSON.stringify(input)]))
        .rejects.toMatchObject({ code: 'NT004' });
    }
    await expect(apiPool.query('SELECT pactwoven.native_provider_authority_prepare($1,$2::jsonb,$3)', ['development', JSON.stringify({ ...msg, sessionId: 'forged' }), issuer])).rejects.toMatchObject({ code: 'NT004' });
    for (const sql of ['SELECT * FROM pactwoven.native_provider_authority', "SELECT pactwoven.native_provider_status('development','org','task',1)"]) {
      await expect(apiPool.query(sql)).rejects.toMatchObject({ code: '42501' }); await expect(workerPool.query(sql)).rejects.toMatchObject({ code: '42501' });
    }
    await expect(workerPool.query('SELECT pactwoven.native_provider_authority_prepare($1,$2::jsonb,$3)', ['development', JSON.stringify(msg), issuer])).rejects.toMatchObject({ code: '42501' });
    await expect(assertNativeTaskPool(apiPool, 'development', 'api')).resolves.toBeUndefined();
    await expect(assertNativeTaskPool(workerPool, 'development', 'worker')).resolves.toBeUndefined();
  });
});

describe('native provider authority repository wire boundary', () => {
  const msg: NativeDispatchMessage = { schemaVersion: 1, environment: 'development', organizationId: 'org', taskId: 'task', generation: 1, engineRevision: 'native-advice-v1' };
  it('rejects caller identity fields, malformed verdicts and foreign environments before IO', async () => {
    const query = vi.fn(); const repo = new PostgresNativeAuthorityRepository({ query } as unknown as Pool, 'development');
    await expect(repo.prepare({ ...msg, environment: 'production' }, issuer)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(repo.prepare({ ...msg, sessionId: 'forged' } as NativeDispatchMessage, issuer)).rejects.toThrow();
    await expect(repo.finish(randomUUID(), { ...observation(), providerExpiresAt: null })).rejects.toThrow(); expect(query).not.toHaveBeenCalled();
    expect(NativeAuthorityRequestSchema.safeParse({ schemaVersion: 1, dispatch: msg, context: {} }).success).toBe(false);
    expect(NativeAuthorityResponseSchema.safeParse({ schemaVersion: 1, dispatch: msg, result: { state: 'allowed', observedAt: null, validUntil: null } }).success).toBe(false);
  });
  it('sanitizes uncertain storage failures without retrying or granting', async () => {
    const query = vi.fn().mockRejectedValue({ code: '08006', message: 'private secret' });
    const repo = new PostgresNativeAuthorityRepository({ query } as unknown as Pool, 'development');
    const result = await repo.finish(randomUUID(), observation()).catch(e => e);
    expect(result).toMatchObject({ code: 'DURABLE_SERVICE_UNAVAILABLE', status: 503 }); expect(result.message).not.toContain('secret'); expect(query).toHaveBeenCalledOnce();
  });
  it('requires internally ordered observation metadata and consistent state reasons', () => {
    expect(NativeAuthorityVerdictSchema.safeParse({ ...observation(), observationStartedAt: '9999-01-01T00:00:00Z' }).success).toBe(false);
    expect(NativeAuthorityVerdictSchema.safeParse(observation('unavailable')).success).toBe(true);
    expect(NativeAuthorityVerdictSchema.safeParse({ ...observation('unavailable'), reason: 'session_inactive' }).success).toBe(false);
  });
});
