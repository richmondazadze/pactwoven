import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import type { ActorContext } from '../../contracts/src/core';
import type { NativeWorkIntentPrepare, NativeWorkIntentPrepareResponse } from '../../contracts/src/native-work-intent';
import { PostgresNativeWorkIntentRepository } from './native-work-intent-repository';
import { PostgresNativeMemoryNotesRepository } from './native-memory-notes-repository';
const url = process.env.PACTWOVEN_WORK_INTENT_TEST_DATABASE_URL;
const at = (offset = 0) => new Date(Date.now() + offset).toISOString();
const identity = (serviceId: string) => ({ serviceId, serviceVersion: 1, workloadIdentityId: serviceId });
const issuer = 'https://work-intent-fixture.clerk.accounts.dev';
describe.skipIf(!url)('authenticated human work intent PostgreSQL', () => {
  let admin: Pool, api: Pool, v1: Pool, repo: PostgresNativeWorkIntentRepository, notes: PostgresNativeMemoryNotesRepository, actor: ActorContext;
  const suffix = randomUUID().slice(0, 8), apiId = identity('intent_api_' + suffix), coordinator = identity('intent_coordinator_' + suffix), worker = identity('intent_worker_' + suffix);
  beforeAll(async () => {
    const u = new URL(url!); if (!['127.0.0.1', 'localhost'].includes(u.hostname) || !u.pathname.startsWith('/pactwoven_native_work_intent_')) throw new Error('Separate disposable local work-intent database required.');
    admin = new Pool({ connectionString: url, max: 4 });
    await admin.query("UPDATE pactwoven.native_delegation_services SET enabled=false WHERE environment='development' AND service_id LIKE 'intent_%'");
    const role = 'intent_api_' + suffix, v1Role = 'intent_v1_' + suffix;
    const password = randomBytes(32).toString('base64url');
    for (const [login, group] of [[role, 'pactwoven_native_delegation_api'], [v1Role, 'pactwoven_native_task_api']]) {
      const sql = (await admin.query("SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD %L', $1::text, $2::text) AS sql", [login, password])).rows[0].sql;
      await admin.query(sql);await admin.query(`GRANT ${group} TO ${login}`);
    }
    for (const [purpose, service] of [['api', apiId], ['coordinator', coordinator], ['worker', worker]] as const) await admin.query("INSERT INTO pactwoven.native_delegation_services VALUES('development',$1,$2::jsonb,$3,true)", [service.serviceId, service, purpose]);
    await admin.query("INSERT INTO pactwoven.native_delegation_service_bindings SELECT rolname,oid,'development','api',$2,true FROM pg_roles WHERE rolname=$1", [role, apiId.serviceId]);
    await admin.query("INSERT INTO pactwoven.native_task_service_bindings SELECT rolname,oid,'development','api',true FROM pg_roles WHERE rolname=$1", [v1Role]);
    await admin.query("INSERT INTO pactwoven.native_provider_instances VALUES('development',$1,true) ON CONFLICT(environment) DO UPDATE SET issuer=EXCLUDED.issuer,enabled=true", [issuer]);
    u.password = password;u.username = role; api = new Pool({ connectionString: u.href, max: 3 }); u.username = v1Role; v1 = new Pool({ connectionString: u.href, max: 1 });
    repo = new PostgresNativeWorkIntentRepository(api, 'development'); notes = new PostgresNativeMemoryNotesRepository(api, 'development');
  });
  beforeEach(async () => {
    await admin.query("UPDATE pactwoven.native_delegation_services SET enabled=true,identity=$2::jsonb WHERE service_id=$1", [coordinator.serviceId, coordinator]);
    await admin.query("UPDATE pactwoven.native_provider_instances SET enabled=true,issuer=$1 WHERE environment='development'", [issuer]);
    const org = randomUUID(), aid = randomUUID(), site = randomUUID();
    await admin.query("INSERT INTO pactwoven.organizations(environment,id,external_organization_id,name) VALUES('development',$1,$1,'Work intent fixture')", [org]);
    await admin.query("INSERT INTO pactwoven.memberships(environment,organization_id,actor_id,external_subject,external_membership_id,grant_basis,roles,display_name) VALUES('development',$1,$2,$2,$3,'internal',ARRAY['owner'],'Operator')", [org, aid, randomUUID()]);
    await admin.query("INSERT INTO pactwoven.sites(environment,organization_id,id,name,time_zone) VALUES('development',$1,$2,'Main office','UTC')", [org, site]);
    await admin.query("INSERT INTO pactwoven.member_action_sites VALUES('development',$1,$2,$3)", [org, aid, site]);
    await admin.query("INSERT INTO pactwoven.native_delegation_policies VALUES('development',$1,1,true)", [org]);
    actor = { environment: 'development', organizationId: org, actorId: aid, principalKind: 'human', roles: ['owner'], siteIds: [site], actionSiteIds: [site], sessionId: randomUUID(), authenticatedAt: at(-1000), correlationId: randomUUID() };
  });
  afterAll(async () => { await Promise.allSettled([admin, api, v1].filter(Boolean).map(pool => pool.end())); });
  const input = (overrides: Partial<NativeWorkIntentPrepare> = {}): NativeWorkIntentPrepare => ({ siteId: actor.siteIds[0]!, title: 'Choose office chairs', prompt: 'Compare the chair options in the supplied information.', selections: [], continuesAfterSignOut: true, ...overrides });
  const observation = () => ({ providerIssuer: issuer, sessionVerifiedAt: at(), sessionExpiresAt: at(60000) });
  const confirmation = (prepared: NativeWorkIntentPrepareResponse) => ({ reviewId: prepared.review.id, reviewToken: prepared.review.token, continuesAfterSignOut: true as const });
  const prepare = async (q = input()) => { const key = randomUUID(); return { key, q, prepared: await repo.prepare(actor, key, q) }; };
  const confirm = async (p: Awaited<ReturnType<typeof prepare>>) => repo.confirm(actor, p.key, confirmation(p.prepared), observation());
  const counts = async () => (await admin.query(`SELECT jsonb_build_object('reviews',(SELECT count(*) FROM pactwoven.native_work_intent_reviews WHERE organization_id=$1),
    'operations',(SELECT count(*) FROM pactwoven.native_work_intent_operations WHERE organization_id=$1),'v1',(SELECT count(*) FROM pactwoven.native_tasks WHERE organization_id=$1),
    'grants',(SELECT count(*) FROM pactwoven.native_delegation_grants WHERE organization_id=$1),'roots',(SELECT count(*) FROM pactwoven.native_delegation_tasks WHERE organization_id=$1),
    'bindings',(SELECT count(*) FROM pactwoven.native_delegation_root_note_selections WHERE organization_id=$1),'v1outbox',(SELECT count(*) FROM pactwoven.native_dispatch_outbox WHERE organization_id=$1),
    'outbox',(SELECT count(*) FROM pactwoven.native_delegation_outbox WHERE organization_id=$1)) AS n`, [actor.organizationId])).rows[0].n;
  const note = async () => (await notes.command(actor, randomUUID(), { kind: 'remember', siteId: actor.siteIds[0]!, title: 'Preferred chairs', text: 'Prefer blue chairs.', purpose: 'Office seating choices', reviewBy: at(120000) })).current!;
  const noteRecords = async (id: string) => (await admin.query(`SELECT m.record AS m,s.record AS s FROM pactwoven.native_memory_notes n
    JOIN pactwoven.native_memory_heads mh USING(environment,organization_id,site_id,memory_id) JOIN pactwoven.native_memory_revisions m USING(environment,organization_id,site_id,memory_id,revision,digest)
    JOIN pactwoven.native_memory_source_heads sh ON(sh.environment,sh.organization_id,sh.site_id,sh.source_id)=(n.environment,n.organization_id,n.site_id,n.source_id)
    JOIN pactwoven.native_memory_source_revisions s ON(s.environment,s.organization_id,s.site_id,s.source_id,s.revision,s.digest)=(sh.environment,sh.organization_id,sh.site_id,sh.source_id,sh.revision,sh.digest)
    WHERE n.id=$1`, [id])).rows[0] as { m: Record<string, any>; s: Record<string, any> };
  const reviseRecords = async (who: ActorContext, id: string, changes: { readers?: Array<{ kind: string; id: string }>; memoryUntil?: string; sourceUntil?: string; sourceOnly?: boolean } = {}) => {
    const { m, s } = await noteRecords(id), refs = (await admin.query('SELECT pactwoven.native_memory_ref($1::jsonb) m,pactwoven.native_memory_ref($2::jsonb,true) s', [m, s])).rows[0];
    const changed = (await api.query('SELECT pactwoven.native_memory_human_source($1::jsonb,$2,$3::jsonb) r', [who, randomUUID(), { kind: 'correct', expected: refs.s,
      record: { ...s, revision: s.revision + 1, provenance: { kind: 'user', actorId: who.actorId }, ...(changes.sourceUntil ? { validUntil: changes.sourceUntil } : {}),
        access: { ...s.access, ...(changes.readers ? { readers: changes.readers } : {}) } } }])).rows[0].r;
    if (!changes.sourceOnly) await api.query('SELECT pactwoven.native_memory_human_mutate($1::jsonb,$2,$3::jsonb)', [who, randomUUID(), { kind: 'correct', expected: refs.m,
      record: { ...m, revision: m.revision + 1, previous: refs.m, provenance: { kind: 'user', actorId: who.actorId }, ...(changes.memoryUntil ? { validUntil: changes.memoryUntil } : {}),
        access: { ...m.access, ...(changes.readers ? { readers: changes.readers } : {}) }, inputs: { sources: [changed.originalReference], memories: [] } } }]);
  };
  it('prepares real readable review without creating a runnable task', async () => {
    const p = await prepare(); expect(p.prepared.review.body).toEqual({ title: p.q.title, prompt: p.q.prompt, siteName: 'Main office', selectedNotes: [], allowedWork: ['Research public sources', 'Draft advice'], continuesAfterSignOut: true, externalEffects: 'forbidden' });
    expect(await counts()).toEqual({ reviews: 1, operations: 0, v1: 0, grants: 0, roots: 0, bindings: 0, v1outbox: 0, outbox: 0 });
    expect(Date.parse(p.prepared.review.expiresAt) - Date.parse(p.prepared.review.preparedAt)).toBe(86400000);
    expect(Date.parse(p.prepared.review.confirmBy) - Date.parse(p.prepared.review.preparedAt)).toBe(300000);
  });
  it('starts from a fresh prompt atomically with inert provenance and an explicit empty selection', async () => {
    const p = await prepare(), operation = await confirm(p); expect(operation).toMatchObject({ title: p.q.title, reviewId: p.prepared.review.id, expiresAt: p.prepared.review.expiresAt });
    expect(await counts()).toEqual({ reviews: 1, operations: 1, v1: 1, grants: 1, roots: 1, bindings: 1, v1outbox: 0, outbox: 1 });
    const row = (await admin.query('SELECT state,attempt,attempt_limit FROM pactwoven.native_delegation_tasks WHERE id=$1', [operation.rootTaskId])).rows[0]; expect(row).toEqual({ state: 'ready', attempt: 1, attempt_limit: 4 });
    const legacy = (await admin.query('SELECT status,worker_id,lease_token FROM pactwoven.native_tasks WHERE organization_id=$1', [actor.organizationId])).rows[0]; expect(legacy).toEqual({ status: 'paused', worker_id: null, lease_token: null });
  });
  it('snapshots explicitly selected readable note text and exact source attribution', async () => {
    const n = await note(), p = await prepare(input({ selections: [{ noteId: n.id, expected: n.editToken! }] }));
    expect(p.prepared.review.body.selectedNotes).toEqual([{ noteId: n.id, title: n.title, text: n.text, purpose: n.purpose, reviewBy: n.reviewBy, suppliedBy: n.suppliedBy, sourceLabel: n.sourceLabel }]);
    expect(p.prepared.review.body.allowedWork).toContain('Read selected notes'); await confirm(p);
    expect((await admin.query('SELECT jsonb_array_length(memory_references) AS n FROM pactwoven.native_delegation_root_note_selections WHERE organization_id=$1', [actor.organizationId])).rows[0].n).toBe(1);
  });
  it('returns the original immutable review and operation without extending grant lifetime', async () => {
    const p = await prepare(); expect(await repo.prepare(actor, p.key, p.q)).toEqual(p.prepared); const op = await confirm(p);
    expect(await repo.confirm(actor, p.key, confirmation(p.prepared), observation())).toEqual(op);
    expect((await repo.recover(actor, p.q.siteId, p.key)).operation).toEqual(op); expect((await counts()).grants).toBe(1);
    expect(op.expiresAt).toBe(p.prepared.review.expiresAt);
  });
  it('recovers an original operation in a new authorized session without issuing again', async () => {
    const p = await prepare(), op = await confirm(p), later = { ...actor, sessionId: randomUUID(), authenticatedAt: at() };
    expect((await repo.recover(later, p.q.siteId, p.key)).operation).toEqual(op); expect(await repo.confirm(later, p.key, confirmation(p.prepared), observation())).toEqual(op); expect((await counts()).grants).toBe(1);
  });
  it('rejects replacement intent and wrong review token under the original key', async () => {
    const p = await prepare(); await expect(repo.prepare(actor, p.key, { ...p.q, prompt: 'Changed' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(repo.confirm(actor, p.key, { ...confirmation(p.prepared), reviewToken: 'a'.repeat(64) }, observation())).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' }); expect((await counts()).v1).toBe(0);
  });
  it('rejects an unconfirmed review from another session', async () => {
    const p = await prepare(); await expect(repo.confirm({ ...actor, sessionId: randomUUID() }, p.key, confirmation(p.prepared), observation())).rejects.toMatchObject({ code: 'FORBIDDEN' }); expect((await counts()).v1).toBe(0);
  });
  it.each(['future', 'stale', 'expired', 'issuer'])('rejects %s trusted session observation', async kind => {
    const p = await prepare(), o = observation(); if (kind === 'future') o.sessionVerifiedAt = at(5000); if (kind === 'stale') o.sessionVerifiedAt = at(-30000); if (kind === 'expired') o.sessionExpiresAt = at(-10); if (kind === 'issuer') o.providerIssuer = 'https://other.clerk.accounts.dev';
    await expect(repo.confirm(actor, p.key, confirmation(p.prepared), o)).rejects.toMatchObject({ code: 'FORBIDDEN' }); expect((await counts()).v1).toBe(0);
  });
  it.each(['epoch', 'policy', 'service', 'provider', 'site_name', 'action'])('rejects changed %s without leaving partial issuance', async kind => {
    const p = await prepare();
    if (kind === 'epoch') await admin.query('UPDATE pactwoven.organizations SET authority_epoch=authority_epoch+1 WHERE id=$1', [actor.organizationId]);
    if (kind === 'policy') await admin.query('UPDATE pactwoven.native_delegation_policies SET version=version+1 WHERE organization_id=$1', [actor.organizationId]);
    if (kind === 'service') await admin.query('UPDATE pactwoven.native_delegation_services SET identity=$2::jsonb WHERE service_id=$1', [coordinator.serviceId, { ...coordinator, serviceVersion: 2 }]);
    if (kind === 'provider') await admin.query("UPDATE pactwoven.native_provider_instances SET issuer='https://new.clerk.accounts.dev' WHERE environment='development'");
    if (kind === 'site_name') await admin.query("UPDATE pactwoven.sites SET name='Changed office' WHERE organization_id=$1", [actor.organizationId]);
    if (kind === 'action') await admin.query('DELETE FROM pactwoven.member_action_sites WHERE organization_id=$1', [actor.organizationId]);
    await expect(confirm(p)).rejects.toBeDefined(); expect(await counts()).toEqual({ reviews: 1, operations: 0, v1: 0, grants: 0, roots: 0, bindings: 0, v1outbox: 0, outbox: 0 });
  });
  it('does not enroll a missing policy during preparation', async () => {
    await admin.query('DELETE FROM pactwoven.native_delegation_policies WHERE organization_id=$1', [actor.organizationId]); await expect(prepare()).rejects.toMatchObject({ code: 'SETUP_REQUIRED' }); expect((await counts()).reviews).toBe(0);
  });
  it('rejects changed selected-note heads without partial provenance/grant/outbox', async () => {
    const n = await note(), p = await prepare(input({ selections: [{ noteId: n.id, expected: n.editToken! }] }));
    await notes.command(actor, randomUUID(), { kind: 'correct', siteId: p.q.siteId, noteId: n.id, expected: n.editToken!, title: n.title, text: 'New choice', purpose: n.purpose!, reviewBy: at(120000) });
    await expect(confirm(p)).rejects.toMatchObject({ code: 'REVIEW_CHANGED' }); expect((await counts()).v1).toBe(0); expect((await counts()).outbox).toBe(0);
  });
  it('does not read a note selected from another owner/site', async () => {
    const n = await note(); const other = { ...actor, actorId: randomUUID() }; await admin.query("INSERT INTO pactwoven.memberships(environment,organization_id,actor_id,external_subject,external_membership_id,roles) VALUES('development',$1,$2,$2,$3,ARRAY['owner'])", [actor.organizationId, other.actorId, randomUUID()]);
    await admin.query("INSERT INTO pactwoven.member_action_sites VALUES('development',$1,$2,$3)", [actor.organizationId, other.actorId, actor.siteIds[0]]);
    await expect(repo.prepare(other, randomUUID(), input({ selections: [{ noteId: n.id, expected: n.editToken! }] }))).rejects.toMatchObject({ code: 'REVIEW_CHANGED' });
  });
  it('serializes concurrent confirmations into one operation and root', async () => {
    const p = await prepare(); const results = await Promise.all([confirm(p), confirm(p), confirm(p)]); expect(results[1]).toEqual(results[0]); expect(results[2]).toEqual(results[0]); expect((await counts()).grants).toBe(1);
  });
  it('denies table access and worker access to preparation', async () => {
    await expect(api.query('SELECT * FROM pactwoven.native_work_intent_reviews')).rejects.toMatchObject({ code: '42501' });
    expect((await admin.query("SELECT has_function_privilege('pactwoven_native_delegation_worker','pactwoven.native_work_intent_prepare(jsonb,text,jsonb)','EXECUTE') AS allowed")).rows[0].allowed).toBe(false);
  });
  it('guards mapped provenance from v1 resume/update/delete and runnable outbox', async () => {
    const p = await prepare(), op = await confirm(p), row = (await admin.query('SELECT provenance_id FROM pactwoven.native_work_intent_operations WHERE id=$1', [op.id])).rows[0];
    await expect(v1.query("SELECT pactwoven.native_task_command($1::jsonb,$2,'control',$3,$4::jsonb)", [actor, row.provenance_id, randomUUID(), { action: 'resume', expectedVersion: 1 }])).rejects.toMatchObject({ code: 'NW008' });
    await expect(admin.query("UPDATE pactwoven.native_tasks SET status='queued' WHERE id=$1", [row.provenance_id])).rejects.toMatchObject({ code: 'NW008' });
    await expect(admin.query('DELETE FROM pactwoven.native_tasks WHERE id=$1', [row.provenance_id])).rejects.toMatchObject({ code: 'NW008' });
    await expect(admin.query("INSERT INTO pactwoven.native_dispatch_outbox(environment,organization_id,task_id,generation,engine_revision,idempotency_key,not_before) VALUES('development',$1,$2,1,'native-advice-v1',$3,clock_timestamp())", [actor.organizationId, row.provenance_id, randomUUID()])).rejects.toMatchObject({ code: 'NW008' });
    expect((await counts()).v1outbox).toBe(0);
  });
  it('leaves unrelated v1 work operational and maps only eligible caller provenance', async () => {
    const p = await prepare(), op = await confirm(p), row = (await admin.query('SELECT provenance_id FROM pactwoven.native_work_intent_operations WHERE id=$1', [op.id])).rows[0];
    const legacy = (await v1.query('SELECT pactwoven.native_task_create($1::jsonb,$2,$3::jsonb) AS task', [actor, randomUUID(), { siteId: p.q.siteId, prompt: 'Real v1 work', mode: 'advise' }])).rows[0].task;
    expect(legacy.status).toBe('queued'); expect((await repo.provenance(actor, p.q.siteId, [row.provenance_id, legacy.id])).items).toEqual([{ provenanceId: row.provenance_id, rootTaskId: op.rootTaskId }]);
    expect((await counts()).v1outbox).toBe(1);
  });
  it.each(['session', 'membership', 'membership_version'])('rejects revoked or changed %s at confirmation', async kind => {
    const p = await prepare();
    if (kind === 'session') await admin.query("INSERT INTO pactwoven.session_revocations(environment,session_id) VALUES('development',$1)", [actor.sessionId]);
    if (kind === 'membership') await admin.query("UPDATE pactwoven.memberships SET status='revoked' WHERE organization_id=$1 AND actor_id=$2", [actor.organizationId, actor.actorId]);
    if (kind === 'membership_version') await admin.query('UPDATE pactwoven.memberships SET row_version=row_version+1 WHERE organization_id=$1 AND actor_id=$2', [actor.organizationId, actor.actorId]);
    await expect(confirm(p)).rejects.toMatchObject({ code: kind === 'membership_version' ? 'REVIEW_CHANGED' : 'FORBIDDEN' });
    expect((await counts()).v1).toBe(0); expect((await counts()).outbox).toBe(0);
  });
  it.each(['duplicate', 'scope', 'missing_selections', 'false_consent', 'whitespace', 'oversized'])('rejects direct SQL %s input before storing a review', async kind => {
    const q: Record<string, unknown> = input();
    if (kind === 'duplicate') q.selections = [{ noteId: 'note_one', expected: 'a'.repeat(64) }, { noteId: 'note_one', expected: 'a'.repeat(64) }];
    if (kind === 'scope') q.scope = { issuer: { actorId: actor.actorId }, capabilities: ['send_email'] };
    if (kind === 'missing_selections') delete q.selections;
    if (kind === 'false_consent') q.continuesAfterSignOut = false;
    if (kind === 'whitespace') q.prompt = '\u2003\u00a0\t';
    if (kind === 'oversized') q.prompt = 'x'.repeat(12001);
    await expect(api.query('SELECT pactwoven.native_work_intent_prepare($1::jsonb,$2,$3::jsonb)', [actor, randomUUID(), q])).rejects.toMatchObject({ code: 'NW004' });
    expect((await counts()).reviews).toBe(0);
  });
  it('rejects an already expired immutable review without renewing its deadline', async () => {
    const p = await prepare(), expiredKey = randomUUID(), expiredId = randomUUID();
    // Administrator-only fixture insertion models elapsed time; production
    // review rows remain immutable and the application exposes no clock hook.
    await admin.query(`INSERT INTO pactwoven.native_work_intent_reviews
      SELECT environment,organization_id,actor_id,$1,$2,site_id,session_id,authenticated_at,input,snapshot,
        review || jsonb_build_object('id',$2::text,'preparedAt',pactwoven.native_memory_instant(prepared_at-interval '6 minutes'),
          'confirmBy',pactwoven.native_memory_instant(confirm_by-interval '6 minutes'),'expiresAt',pactwoven.native_memory_instant(expires_at-interval '6 minutes')),
        prepared_at-interval '6 minutes',confirm_by-interval '6 minutes',expires_at-interval '6 minutes'
      FROM pactwoven.native_work_intent_reviews WHERE organization_id=$3 AND request_key=$4`, [expiredKey, expiredId, actor.organizationId, p.key]);
    const recovered = await repo.recover(actor, p.q.siteId, expiredKey); expect(Date.parse(recovered.review!.confirmBy)).toBeLessThan(Date.now());
    await expect(repo.confirm(actor, expiredKey, { ...confirmation(p.prepared), reviewId: expiredId }, observation())).rejects.toMatchObject({ code: 'REVIEW_EXPIRED' });
    expect((await repo.recover(actor, p.q.siteId, expiredKey)).review).toEqual(recovered.review); expect((await counts()).v1).toBe(0);
  });
  it('rejects a selected note that expires during review', async () => {
    const n = (await notes.command(actor, randomUUID(), { kind: 'remember', siteId: actor.siteIds[0]!, title: 'Short-lived note', text: 'Current for a moment.', purpose: 'Expiry boundary', reviewBy: at(1000) })).current!;
    const p = await prepare(input({ selections: [{ noteId: n.id, expected: n.editToken! }] }));
    await admin.query('SELECT pg_sleep(1.1)');
    await expect(confirm(p)).rejects.toMatchObject({ code: 'REVIEW_CHANGED' }); expect((await counts()).v1).toBe(0);
  });
  it('rolls back provenance, grant, root, selection and outbox if the session expires after binding', async () => {
    const p = await prepare();
    await admin.query(`CREATE FUNCTION pactwoven.intent_fixture_delay_${suffix}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_sleep(0.3); RETURN NEW; END $$;
      CREATE TRIGGER intent_fixture_delay AFTER INSERT ON pactwoven.native_delegation_root_note_selections
        FOR EACH ROW EXECUTE FUNCTION pactwoven.intent_fixture_delay_${suffix}()`);
    try {
      await expect(repo.confirm(actor, p.key, confirmation(p.prepared), { ...observation(), sessionExpiresAt: at(200) })).rejects.toMatchObject({ code: 'REVIEW_EXPIRED' });
      expect(await counts()).toEqual({ reviews: 1, operations: 0, v1: 0, grants: 0, roots: 0, bindings: 0, v1outbox: 0, outbox: 0 });
    } finally {
      await admin.query(`DROP TRIGGER intent_fixture_delay ON pactwoven.native_delegation_root_note_selections; DROP FUNCTION pactwoven.intent_fixture_delay_${suffix}()`);
    }
    const operation = await confirm(p); expect(operation.expiresAt).toBe(p.prepared.review.expiresAt); expect((await counts()).grants).toBe(1);
  });
  it('keeps recovery and provenance private to the original human and selected site', async () => {
    const p = await prepare(), op = await confirm(p), other = { ...actor, actorId: randomUUID() }, otherSite = randomUUID();
    const row = (await admin.query('SELECT provenance_id FROM pactwoven.native_work_intent_operations WHERE id=$1', [op.id])).rows[0];
    await admin.query("INSERT INTO pactwoven.memberships(environment,organization_id,actor_id,external_subject,external_membership_id,roles) VALUES('development',$1,$2,$2,$3,ARRAY['owner'])", [actor.organizationId, other.actorId, randomUUID()]);
    await admin.query("INSERT INTO pactwoven.sites(environment,organization_id,id,name,time_zone) VALUES('development',$1,$2,'Other site','UTC')", [actor.organizationId, otherSite]);
    expect(await repo.recover(other, p.q.siteId, p.key)).toEqual({ scope: p.prepared.scope, review: null, operation: null, reviewUnavailable: false });
    expect((await repo.provenance(other, p.q.siteId, [row.provenance_id])).items).toEqual([]);
    expect((await repo.recover(actor, otherSite, p.key)).review).toBeNull();
    expect((await repo.provenance(actor, otherSite, [row.provenance_id])).items).toEqual([]);
    await expect(repo.confirm(other, p.key, confirmation(p.prepared), observation())).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it.each(['provider', 'coordinator', 'new_worker', 'policy', 'action', 'session'])('holds %s authority through atomic commit', async kind => {
    const p = await prepare(), confirming = await api.connect(), changing = await admin.connect();
    try {
      await confirming.query('BEGIN');
      await confirming.query('SELECT pactwoven.native_work_intent_confirm($1::jsonb,$2,$3::jsonb,$4::jsonb)', [actor, p.key, confirmation(p.prepared), observation()]);
      expect((await counts()).grants).toBe(0);
      await changing.query('BEGIN'); await changing.query("SET LOCAL lock_timeout='100ms'");
      const change = kind === 'provider' ? changing.query("UPDATE pactwoven.native_provider_instances SET enabled=false WHERE environment='development'")
        : kind === 'coordinator' ? changing.query('UPDATE pactwoven.native_delegation_services SET enabled=false WHERE service_id=$1', [coordinator.serviceId])
        : kind === 'new_worker' ? changing.query("INSERT INTO pactwoven.native_delegation_services VALUES('development',$1,$2::jsonb,'worker',true)", ['intent_new_' + suffix, identity('intent_new_' + suffix)])
        : kind === 'policy' ? changing.query('UPDATE pactwoven.native_delegation_policies SET version=version+1 WHERE organization_id=$1', [actor.organizationId])
        : kind === 'action' ? changing.query('DELETE FROM pactwoven.member_action_sites WHERE organization_id=$1', [actor.organizationId])
        : changing.query("INSERT INTO pactwoven.session_revocations(environment,session_id) VALUES('development',$1)", [actor.sessionId]);
      await expect(change).rejects.toMatchObject({ code: '55P03' });
      await changing.query('ROLLBACK'); await confirming.query('COMMIT'); expect((await counts()).grants).toBe(1);
    } finally {
      await Promise.allSettled([confirming.query('ROLLBACK'), changing.query('ROLLBACK')]); confirming.release(); changing.release();
    }
  });
  it('holds selected memory heads against an API correction through atomic commit', async () => {
    const n = await note(), p = await prepare(input({ selections: [{ noteId: n.id, expected: n.editToken! }] })), confirming = await api.connect(), changing = await api.connect();
    try {
      await confirming.query('BEGIN');
      await confirming.query('SELECT pactwoven.native_work_intent_confirm($1::jsonb,$2,$3::jsonb,$4::jsonb)', [actor, p.key, confirmation(p.prepared), observation()]);
      await changing.query('BEGIN'); await changing.query("SET LOCAL lock_timeout='100ms'");
      await expect(changing.query('SELECT pactwoven.native_memory_notes_command($1::jsonb,$2,$3::jsonb)', [actor, randomUUID(), { kind: 'correct', siteId: p.q.siteId, noteId: n.id, expected: n.editToken!, title: n.title, text: 'Concurrent replacement', purpose: n.purpose!, reviewBy: at(120000) }])).rejects.toMatchObject({ code: '55P03' });
      await changing.query('ROLLBACK'); await confirming.query('COMMIT'); expect((await counts()).grants).toBe(1);
    } finally {
      await Promise.allSettled([confirming.query('ROLLBACK'), changing.query('ROLLBACK')]); confirming.release(); changing.release();
    }
  });
  it('withholds all retained review text after a second authorized human revokes the original reader', async () => {
    const second = { ...actor, actorId: randomUUID(), sessionId: randomUUID() };
    await admin.query("INSERT INTO pactwoven.memberships(environment,organization_id,actor_id,external_subject,external_membership_id,roles) VALUES('development',$1,$2,$2,$3,ARRAY['owner'])", [actor.organizationId, second.actorId, randomUUID()]);
    await admin.query("INSERT INTO pactwoven.member_action_sites VALUES('development',$1,$2,$3)", [actor.organizationId, second.actorId, actor.siteIds[0]]);
    let n = await note(); const initial = await noteRecords(n.id);
    await reviseRecords(actor, n.id, { readers: [...initial.m.access.readers, { kind: 'user', id: second.actorId }] });
    n = (await notes.get(actor, actor.siteIds[0]!, n.id)).note;
    const q = input({ selections: [{ noteId: n.id, expected: n.editToken! }] }), unconfirmed = await prepare(q), committed = await prepare(q), operation = await confirm(committed);
    const shared = await noteRecords(n.id); await reviseRecords(second, n.id, { readers: shared.m.access.readers.filter((reader: { kind: string; id: string }) => !(reader.kind === 'user' && reader.id === actor.actorId)) });
    await expect(notes.get(actor, q.siteId, n.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    for (const request of [unconfirmed, committed]) await expect(repo.prepare(actor, request.key, q)).rejects.toMatchObject({ code: 'REVIEW_CHANGED' });
    await expect(repo.recover(actor, q.siteId, unconfirmed.key)).rejects.toMatchObject({ code: 'REVIEW_CHANGED' });
    const recovery = await repo.recover(actor, q.siteId, committed.key);
    expect(recovery).toEqual({ scope: committed.prepared.scope, review: null, operation, reviewUnavailable: true });
    expect(JSON.stringify(recovery)).not.toContain(n.text);
    expect(await confirm(committed)).toEqual(operation); expect(operation.expiresAt).toBe(committed.prepared.review.expiresAt);
    const stored = (await admin.query('SELECT review FROM pactwoven.native_work_intent_reviews WHERE organization_id=$1 AND request_key=$2', [actor.organizationId, committed.key])).rows[0].review;
    expect(stored).toEqual(committed.prepared.review); expect((await counts()).grants).toBe(1);
  });
  it.each(['corrected', 'removed', 'source_revised', 'source_expired', 'note_expired'])('withholds original review after %s without hiding the committed operation', async kind => {
    let n = await note();
    if (kind.endsWith('_expired')) {
      await reviseRecords(actor, n.id, kind === 'source_expired' ? { sourceUntil: at(900) } : { memoryUntil: at(900) });
      n = (await notes.get(actor, actor.siteIds[0]!, n.id)).note;
    }
    const q = input({ selections: [{ noteId: n.id, expected: n.editToken! }] }), pending = await prepare(q), committed = await prepare(q), operation = await confirm(committed);
    expect((await repo.recover(actor, q.siteId, committed.key)).reviewUnavailable).toBe(false);
    if (kind === 'corrected') await notes.command(actor, randomUUID(), { kind: 'correct', siteId: q.siteId, noteId: n.id, expected: n.editToken!, title: n.title, text: 'Updated private preference', purpose: n.purpose!, reviewBy: at(120000) });
    if (kind === 'removed') await notes.command(actor, randomUUID(), { kind: 'remove', siteId: q.siteId, noteId: n.id, expected: n.editToken! });
    if (kind === 'source_revised') await reviseRecords(actor, n.id, { sourceOnly: true });
    if (kind.endsWith('_expired')) await admin.query('SELECT pg_sleep(1)');
    for (const request of [pending, committed]) await expect(repo.prepare(actor, request.key, q)).rejects.toMatchObject({ code: 'REVIEW_CHANGED' });
    await expect(repo.recover(actor, q.siteId, pending.key)).rejects.toMatchObject({ code: 'REVIEW_CHANGED' });
    expect(await repo.recover(actor, q.siteId, committed.key)).toEqual({ scope: committed.prepared.scope, review: null, operation, reviewUnavailable: true });
    expect(await confirm(committed)).toEqual(operation); expect((await counts()).grants).toBe(1);
  });
  it('preserves unchanged review recovery without requiring current write authority', async () => {
    const n = await note(), q = input({ selections: [{ noteId: n.id, expected: n.editToken! }] }), p = await prepare(q), operation = await confirm(p);
    await admin.query('DELETE FROM pactwoven.member_action_sites WHERE organization_id=$1', [actor.organizationId]);
    expect(await repo.recover(actor, q.siteId, p.key)).toEqual({ scope: p.prepared.scope, review: p.prepared.review, operation, reviewUnavailable: false });
  });
  it('keeps empty-selection review and exact operation recovery independent of unrelated note changes', async () => {
    const n = await note(), p = await prepare(), operation = await confirm(p);
    await notes.command(actor, randomUUID(), { kind: 'remove', siteId: p.q.siteId, noteId: n.id, expected: n.editToken! });
    expect(await repo.prepare(actor, p.key, p.q)).toEqual({ ...p.prepared, operation });
    expect(await repo.recover(actor, p.q.siteId, p.key)).toEqual({ scope: p.prepared.scope, review: p.prepared.review, operation, reviewUnavailable: false });
  });
  it('holds retained review evidence against a concurrent restricted API correction', async () => {
    const n = await note(), p = await prepare(input({ selections: [{ noteId: n.id, expected: n.editToken! }] })), reading = await api.connect(), changing = await api.connect();
    try {
      await reading.query('BEGIN');
      const response = (await reading.query('SELECT pactwoven.native_work_intent_recover($1::jsonb,$2,$3) r', [actor, p.q.siteId, p.key])).rows[0].r;
      expect(response.review).toEqual(p.prepared.review);
      await changing.query('BEGIN'); await changing.query("SET LOCAL lock_timeout='100ms'");
      await expect(changing.query('SELECT pactwoven.native_memory_notes_command($1::jsonb,$2,$3::jsonb)', [actor, randomUUID(), { kind: 'remove', siteId: p.q.siteId, noteId: n.id, expected: n.editToken! }])).rejects.toMatchObject({ code: '55P03' });
      await changing.query('ROLLBACK'); await reading.query('COMMIT');
    } finally {
      await Promise.allSettled([reading.query('ROLLBACK'), changing.query('ROLLBACK')]); reading.release(); changing.release();
    }
  });
  it('does not return a newly prepared review if selected evidence expires before projection', async () => {
    const n = (await notes.command(actor, randomUUID(), { kind: 'remember', siteId: actor.siteIds[0]!, title: 'Brief note', text: 'Private short-lived statement.', purpose: 'Late projection expiry', reviewBy: at(600) })).current!;
    await admin.query(`CREATE FUNCTION pactwoven.intent_fixture_review_delay_${suffix}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_sleep(0.7); RETURN NEW; END $$;
      CREATE TRIGGER intent_fixture_review_delay AFTER INSERT ON pactwoven.native_work_intent_reviews
        FOR EACH ROW EXECUTE FUNCTION pactwoven.intent_fixture_review_delay_${suffix}()`);
    try {
      await expect(prepare(input({ selections: [{ noteId: n.id, expected: n.editToken! }] }))).rejects.toMatchObject({ code: 'REVIEW_CHANGED' });
      expect((await counts()).reviews).toBe(0); expect((await counts()).v1).toBe(0);
    } finally {
      await admin.query(`DROP TRIGGER intent_fixture_review_delay ON pactwoven.native_work_intent_reviews; DROP FUNCTION pactwoven.intent_fixture_review_delay_${suffix}()`);
    }
  });
});
