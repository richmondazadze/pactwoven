import { readFile, lstat, mkdtemp, writeFile, rm, symlink, chmod, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CreateMandateDocumentRequest } from '@pactwoven/contracts';
import { mandateResponsibilityReference, validatePolicyDocumentVersion } from '@pactwoven/domain';
import { PostgresMandateRepository } from './mandate-repository.js';
import { assertMandatePool } from './mandate-pool.js';
import type { VerifiedIdentity } from './repository.js';

const suite = process.env.PACTWOVEN_RUN_MANDATE_DB_TESTS === '1' ? describe : describe.skip;
const identity = (subject = 'owner_a', organization = 'clerk_org_a'): VerifiedIdentity => ({ subject, externalOrganizationId: organization,
  externalOrganizationName: 'Document read fixture', externalMembershipId: `membership_${subject}`, externalRole: 'org:member',
  sessionId: `session_${subject}`, authenticatedAt: new Date(Date.now() - 3_600_000).toISOString(), membershipObservedAt: new Date().toISOString() });
const reference = ({ id, version, hash }: { id: string; version: number; hash: string }) => ({ id, version, hash });
async function fixtureUrls(environment: NodeJS.ProcessEnv) {
  const ci = environment.CI === 'true' && environment.GITHUB_ACTIONS === 'true';
  const urls = await Promise.all(['ADMIN', 'WRITER'].map(async role => {
    const path = environment[`PACTWOVEN_MANDATE_TEST_${role}_URL_FILE`];
    if (!path) throw new Error('Protected transferred mandate fixture files required.');
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600) throw new Error('Regular protected fixture files required.');
    const url = new URL((await readFile(path, 'utf8')).trim());
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1' ||
        !(url.port === '55439' || (ci && url.port === '55440')) || url.pathname !== '/pactwoven_mandate_b1b_test' ||
        url.search || url.hash) throw new Error('Exact transferred mandate fixture required.');
    return url;
  }));
  if (!urls[0]!.username || urls[0]!.host !== urls[1]!.host || urls[0]!.username === urls[1]!.username ||
      urls[1]!.username !== 'pactwoven_mandate_b1b_test_login') throw new Error('Same isolated target and dedicated writer required.');
  return urls;
}

describe('document-read fixture intake without database connections', () => {
  async function files(work: (environment: NodeJS.ProcessEnv, paths: string[]) => Promise<void>, port = '55439') {
    const directory = await mkdtemp(join(tmpdir(), 'pactwoven-document-intake-'));
    const paths = [join(directory, 'admin'), join(directory, 'writer')];
    const environment = { PACTWOVEN_MANDATE_TEST_ADMIN_URL_FILE: paths[0], PACTWOVEN_MANDATE_TEST_WRITER_URL_FILE: paths[1] };
    try {
      await writeFile(paths[0]!, `postgresql://fixture_admin@127.0.0.1:${port}/pactwoven_mandate_b1b_test`, { mode: 0o600 });
      await writeFile(paths[1]!, `postgresql://pactwoven_mandate_b1b_test_login@127.0.0.1:${port}/pactwoven_mandate_b1b_test`, { mode: 0o600 });
      await work(environment, paths);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  it('retains local55439 and allows CI55440 only with both exact flags', async () => {
    await files(async environment => { expect((await fixtureUrls(environment))[0]!.port).toBe('55439'); });
    await files(async environment => { expect((await fixtureUrls({ ...environment, CI: 'true', GITHUB_ACTIONS: 'true' }))[0]!.port).toBe('55440'); }, '55440');
  });
  it.each([{}, { CI: 'true' }, { GITHUB_ACTIONS: 'true' }, { CI: '1', GITHUB_ACTIONS: 'true' }, { CI: 'true', GITHUB_ACTIONS: '1' }])('refuses CI port with incomplete flags %j', async flags => {
    await files(async environment => { await expect(fixtureUrls({ ...environment, ...flags })).rejects.toThrow(); }, '55440');
  });
  it.each(['host', 'port', 'database', 'query', 'scheme', 'writer', 'same-login', 'missing-admin', 'mixed-port', 'mode', 'directory', 'symlink'])('rejects %s before creating any pool', async change => {
    await files(async (environment, paths) => {
      const url = new URL((await readFile(paths[0]!, 'utf8')).trim());
      if (change === 'host') url.hostname = 'localhost';
      if (change === 'port') url.port = '5432';
      if (change === 'database') url.pathname = '/pactwoven_dev';
      if (change === 'query') url.search = '?host=foreign.example.test';
      if (change === 'same-login') url.username = 'pactwoven_mandate_b1b_test_login';
      if (change === 'missing-admin') url.username = '';
      if (change === 'mixed-port') url.port = '55440';
      await writeFile(paths[0]!, change === 'scheme' ? 'https://fixture_admin@127.0.0.1:55439/pactwoven_mandate_b1b_test' : url.href);
      if (change === 'writer') await writeFile(paths[1]!, 'postgresql://other_writer@127.0.0.1:55439/pactwoven_mandate_b1b_test');
      if (change === 'mode') await chmod(paths[0]!, 0o644);
      if (change === 'directory') { await rm(paths[0]!); await mkdir(paths[0]!); }
      if (change === 'symlink') { const target = paths[0]! + '-target'; await writeFile(target, url.href, { mode: 0o600 }); await rm(paths[0]!); await symlink(target, paths[0]!); }
      await expect(fixtureUrls({ ...environment, CI: 'true', GITHUB_ACTIONS: 'true' })).rejects.toThrow();
    });
  });
  it('does not fall back to normal environment credentials', async () => {
    await expect(fixtureUrls({ DATABASE_URL: 'postgresql://normal@127.0.0.1:55439/pactwoven_dev' })).rejects.toThrow('Protected transferred');
  });
});

suite('exact standalone mandate document reads — exclusive PostgreSQL fixture', () => {
  let admin: Pool, writer: Pool, lock: PoolClient, repository: PostgresMandateRepository;
  beforeAll(async () => {
    const urls = await fixtureUrls(process.env);
    admin = new Pool({ connectionString: urls[0]!.href, max: 4, connectionTimeoutMillis: 3000 });
    writer = new Pool({ connectionString: urls[1]!.href, max: 3, connectionTimeoutMillis: 3000 });
    const state = (await admin.query("SELECT current_database() AS name,(SELECT count(*)::int FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend') AS other_clients")).rows[0];
    if (state.name !== 'pactwoven_mandate_b1b_test' || state.other_clients !== 0) throw new Error('Transferred fixture must have no other clients. Run resetting suites sequentially.');
    lock = await admin.connect(); await lock.query("SELECT pg_advisory_lock(hashtext('mandate_b1b_author_qualification'))");
    await admin.query('DROP SCHEMA IF EXISTS pactwoven CASCADE');
    for (const file of ['0001_foundation.sql', '0002_organization_bootstrap.sql', '0003_identity_access.sql', '0004_mandate_authority.sql']) {
      await admin.query(await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
    }
    await assertMandatePool(writer); repository = new PostgresMandateRepository(writer, 'development');
  });
  beforeEach(async () => {
    await admin.query('TRUNCATE pactwoven.organizations,pactwoven.session_revocations CASCADE');
    await admin.query("INSERT INTO pactwoven.organizations(environment,id,external_organization_id,name,authority_epoch) VALUES('development','org_a','clerk_org_a','Document fixture',2),('development','org_b','clerk_org_b','Other fixture',0)");
    for (const [subject, role] of [['operations_a', 'operations'], ['finance_a', 'finance'], ['owner_a', 'owner'], ['receiver_a', 'receiver'], ['auditor_a', 'auditor']] as const) {
      await admin.query("INSERT INTO pactwoven.memberships(environment,organization_id,actor_id,external_subject,external_membership_id,roles,grant_basis) VALUES('development','org_a',$1,$1,$2,$3,'internal')", [subject, `membership_${subject}`, [role]]);
    }
    await admin.query("INSERT INTO pactwoven.memberships(environment,organization_id,actor_id,external_subject,external_membership_id,roles,grant_basis) VALUES('development','org_b','owner_b','owner_b','membership_owner_b',ARRAY['owner'],'internal')");
    await admin.query("INSERT INTO pactwoven.sites(environment,organization_id,id,name,time_zone) VALUES('development','org_a','site_a','Site A','UTC'),('development','org_a','site_b','Site B','UTC'),('development','org_b','site_a','Other site','UTC')");
    await admin.query("INSERT INTO pactwoven.site_memberships(environment,organization_id,actor_id,site_id) SELECT environment,organization_id,actor_id,'site_a' FROM pactwoven.memberships WHERE organization_id='org_a'");
    await admin.query("INSERT INTO pactwoven.member_action_sites(environment,organization_id,actor_id,site_id) SELECT environment,organization_id,actor_id,'site_a' FROM pactwoven.memberships WHERE organization_id='org_a'");
    for (const [organization, owner] of [['org_a', 'operations_a'], ['org_b', 'owner_b']]) {
      await admin.query("INSERT INTO pactwoven.responsibilities(environment,organization_id,id,owner_id,site_id,title,description,starts_at,ends_at,time_zone,requirements,acceptance_policy,created_at,updated_at) VALUES('development',$1,'responsibility_a',$2,'site_a','Original responsibility','',now(),now()+interval '2 days','UTC','[]','Signed delivery evidence.',now()-interval '1 hour',now()-interval '1 hour')", [organization, owner]);
    }
  });
  afterAll(async () => {
    await writer?.end();
    if (lock) { await lock.query("SELECT pg_advisory_unlock(hashtext('mandate_b1b_author_qualification'))"); lock.release(); }
    await admin?.end();
  });
  async function save(options: { purpose?: 'ACCEPTANCE_POLICY' | 'MANDATE_POLICY'; text?: string; previous?: { id: string; version: number; hash: string } } = {}) {
    const basis = await repository.list(identity(), 'responsibility_a', { limit: 25 }, 'document_test');
    const key = `document_${crypto.randomUUID()}`;
    const request: CreateMandateDocumentRequest = { responsibility: basis.responsibilityReference, expectedOrganizationEpoch: basis.organizationEpoch,
      command: { documentId: 'document_a', expectedVersion: options.previous?.version ?? 0, previousVersion: options.previous ?? null,
        purpose: options.purpose ?? 'MANDATE_POLICY', text: options.text ?? '  Cafe\u0301\r\n\tKeep spaces.  \r\n' } };
    const receipt = await repository.mutate({ identity: identity('operations_a'), evidence: null, requestNonce: crypto.randomUUID(), requesterObservation: null },
      'responsibility_a', key, { kind: 'document', request }, 'document_test');
    return { basis, key, receipt, request };
  }
  const read = (version = 1, subject = 'owner_a') => repository.readDocument(identity(subject), 'responsibility_a', 'document_a', { version }, 'document_test');
  async function moveResponsibility() {
    await admin.query("UPDATE pactwoven.organizations SET authority_epoch=3 WHERE id='org_a'");
    await admin.query("UPDATE pactwoven.responsibilities SET row_version=row_version+1,title='Current responsibility',acceptance_policy='Current acceptance.',site_id='site_b',updated_at=clock_timestamp() WHERE organization_id='org_a'");
  }
  async function persisted() {
    const state: Record<string, unknown> = {};
    for (const { tablename } of (await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='pactwoven' ORDER BY tablename")).rows) {
      state[tablename] = (await admin.query(`SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) AS rows FROM pactwoven.${tablename} t`)).rows[0].rows;
    }
    return state;
  }
  it.each(['ACCEPTANCE_POLICY', 'MANDATE_POLICY'] as const)('reads full unattached %s and immutable successful save provenance', async purpose => {
    const original = await save({ purpose }), before = await persisted(), result = await read();
    expect(result.document.text).toBe('  Café\n\tKeep spaces.  \n'); expect(result.document.purpose).toBe(purpose);
    expect(result.document.createdBy).toBe('operations_a'); expect(result.saveOperation).toEqual(original.receipt);
    expect(result.savedAgainst).toEqual({ responsibility: original.basis.responsibilityReference, organizationEpoch: 2 });
    expect(result.savedResponsibility).toEqual(original.basis.responsibility); expect(result.document.createdAt).toBe(original.receipt.observedAt);
    expect(Date.parse(result.observedAt)).toBeGreaterThanOrEqual(Date.parse(result.document.createdAt));
    expect((await admin.query('SELECT count(*)::int AS n FROM pactwoven.mandate_proposals')).rows[0].n).toBe(0);
    expect((await repository.list(identity(), 'responsibility_a', { limit: 25 }, 'trace')).items).toEqual([]);
    expect(await validatePolicyDocumentVersion(result.document)).toEqual(result.document);
    expect(await mandateResponsibilityReference(result.savedResponsibility)).toEqual(result.savedAgainst.responsibility);
    expect(await persisted()).toEqual(before);
  });
  it('returns exact v1 and v2 with the preserved predecessor, without latest substitution', async () => {
    const first = await save(), old = await read();
    const second = await save({ previous: reference(first.receipt.target), text: 'Second policy.\n\n' });
    expect((await read(1)).document).toEqual(old.document);
    const next = await read(2); expect(next.document.text).toBe('Second policy.\n\n'); expect(next.document.previousVersion).toEqual(reference(first.receipt.target));
    expect(next.saveOperation).toEqual(second.receipt);
    await expect(read(3)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    for (const query of [{}, { version: 0 }, { version: 'latest' }, { version: 2_147_483_648 }, { version: 1, extra: true }]) {
      await expect(repository.readDocument(identity(), 'responsibility_a', 'document_a', query as never, 'trace')).rejects.toBeDefined();
    }
  });
  it('preserves saved epoch and responsibility version/site after current context changes', async () => {
    const original = await save(); await moveResponsibility(); const result = await read();
    expect(result.savedAgainst).toEqual({ responsibility: original.basis.responsibilityReference, organizationEpoch: 2 });
    expect(result.savedResponsibility).toEqual(original.basis.responsibility); expect(result.saveOperation).toEqual(original.receipt);
    const current = await repository.list(identity(), 'responsibility_a', { limit: 25 }, 'trace');
    expect(current.organizationEpoch).toBe(3); expect(current.responsibility).toMatchObject({ version: 2, siteId: 'site_b', title: 'Current responsibility' });
  });
  it('reads another author’s document without exposing its command or changing original-actor lookup', async () => {
    const original = await save(); const result = await read(1, 'finance_a');
    expect(result.saveOperation).toEqual(original.receipt);
    const forbidden = new Set(['identity', 'command', 'effect_context', 'tokenHash', 'requestNonce', 'idempotency_key', 'requesterObservation', 'evidence']);
    const inspect = (value: unknown) => { if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) { expect(forbidden.has(key)).toBe(false); inspect(child); } };
    inspect(result); expect(JSON.stringify(result)).not.toContain(original.key);
    await expect(repository.operation(identity('finance_a'), { kind: 'mandate.document.create', key: original.key }, 'trace')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await repository.operation(identity('operations_a'), { kind: 'mandate.document.create', key: original.key }, 'trace')).toEqual(original.receipt);
  });
  it.each(['owner_a', 'finance_a', 'auditor_a', 'operations_a', 'receiver_a'])('uses current read policy without action grants or MFA for %s', async subject => {
    await save(); await admin.query('DELETE FROM pactwoven.member_action_sites');
    await admin.query("INSERT INTO pactwoven.responsibility_assignments(environment,organization_id,responsibility_id,actor_id) VALUES('development','org_a','responsibility_a','receiver_a')");
    expect((await read(1, subject)).document.id).toBe('document_a');
  });
  it.each(['unassigned-receiver', 'missing-current-site', 'missing-historical-site', 'expired', 'revoked', 'suspended', 'session-revoked', 'foreign-org', 'foreign-environment', 'wrong-responsibility', 'wrong-document'])('fails closed for %s', async change => {
    await save(); let subject = 'operations_a';
    if (change === 'unassigned-receiver') subject = 'receiver_a';
    if (change === 'missing-current-site') await moveResponsibility();
    if (change === 'missing-historical-site') {
      await moveResponsibility(); await admin.query("UPDATE pactwoven.site_memberships SET site_id='site_b' WHERE actor_id='operations_a'");
    }
    if (change === 'expired') await admin.query("UPDATE pactwoven.memberships SET expires_at=clock_timestamp()-interval '1 second' WHERE actor_id='operations_a'");
    if (change === 'revoked' || change === 'suspended') await admin.query('UPDATE pactwoven.memberships SET status=$1 WHERE actor_id=$2', [change, 'operations_a']);
    if (change === 'session-revoked') await admin.query("INSERT INTO pactwoven.session_revocations(environment,session_id) VALUES('development','session_operations_a')");
    const attempt = change === 'foreign-org' ? repository.readDocument(identity('owner_b', 'clerk_org_b'), 'responsibility_a', 'document_a', { version: 1 }, 'trace')
      : change === 'foreign-environment' ? new PostgresMandateRepository(writer, 'staging').readDocument(identity(), 'responsibility_a', 'document_a', { version: 1 }, 'trace')
      : change === 'wrong-responsibility' ? repository.readDocument(identity(), 'other_responsibility', 'document_a', { version: 1 }, 'trace')
      : change === 'wrong-document' ? repository.readDocument(identity(), 'responsibility_a', 'other_document', { version: 1 }, 'trace') : read(1, subject);
    await expect(attempt).rejects.toMatchObject({ code: ['missing-historical-site', 'foreign-org', 'wrong-document'].includes(change) ? 'NOT_FOUND' : 'FORBIDDEN' });
  });
  it('retains historical content when its author is no longer an eligible member', async () => {
    await save(); await admin.query("UPDATE pactwoven.memberships SET status='revoked' WHERE actor_id='operations_a'");
    expect((await read()).document.createdBy).toBe('operations_a');
  });
  it.each(['text', 'content-hash', 'document-hash', 'purpose', 'previous-reference', 'created-by', 'created-at', 'attachment', 'snapshot', 'operation-target', 'command-hash', 'command', 'audit-missing', 'outbox-missing'])
  ('rejects privileged fixture corruption of %s provenance', async change => {
    await save(); await moveResponsibility();
    const table = change === 'snapshot' ? 'mandate_responsibility_versions' : change === 'audit-missing' ? 'mandate_audit' : change === 'outbox-missing' ? 'mandate_outbox'
      : ['operation-target', 'command-hash', 'command'].includes(change) ? 'mandate_operations' : 'mandate_policy_documents';
    await admin.query(`ALTER TABLE pactwoven.${table} DISABLE TRIGGER USER`);
    try {
      if (change === 'text') await admin.query("UPDATE pactwoven.mandate_policy_documents SET body=jsonb_set(body,'{text}','\"Changed text\"')");
      if (change === 'content-hash') await admin.query("UPDATE pactwoven.mandate_policy_documents SET body=jsonb_set(body,'{contentHash}',to_jsonb(repeat('c',64)))");
      if (change === 'document-hash') await admin.query("UPDATE pactwoven.mandate_policy_documents SET hash=repeat('c',64),body=jsonb_set(body,'{hash}',to_jsonb(repeat('c',64)))");
      if (change === 'purpose') await admin.query("UPDATE pactwoven.mandate_policy_documents SET body=jsonb_set(body,'{purpose}','\"ACCEPTANCE_POLICY\"')");
      if (change === 'previous-reference') await admin.query("UPDATE pactwoven.mandate_policy_documents SET body=jsonb_set(body,'{previousVersion}',jsonb_build_object('id','document_a','version',1,'hash',repeat('a',64)))");
      if (change === 'created-by') await admin.query("UPDATE pactwoven.mandate_policy_documents SET body=jsonb_set(body,'{createdBy}','\"finance_a\"')");
      if (change === 'created-at') await admin.query("UPDATE pactwoven.mandate_policy_documents SET body=jsonb_set(body,'{createdAt}','\"2026-11-14T00:00:00.000Z\"')");
      if (change === 'attachment') await admin.query("UPDATE pactwoven.mandate_policy_documents SET responsibility_version=2,site_id='site_b'");
      if (change === 'snapshot') await admin.query("UPDATE pactwoven.mandate_responsibility_versions SET body=jsonb_set(body,'{title}','\"Changed snapshot\"') WHERE organization_id='org_a' AND version=1");
      if (change === 'operation-target') await admin.query("UPDATE pactwoven.mandate_operations SET result=jsonb_set(result,'{target,hash}',to_jsonb(repeat('e',64)))");
      if (change === 'command-hash') await admin.query("UPDATE pactwoven.mandate_operations SET command_hash=repeat('f',64),result=jsonb_set(result,'{commandHash}',to_jsonb(repeat('f',64)))");
      if (change === 'command') await admin.query("UPDATE pactwoven.mandate_operations SET command=jsonb_set(command,'{expectedOrganizationEpoch}','1')");
      if (change === 'audit-missing') await admin.query('DELETE FROM pactwoven.mandate_audit');
      if (change === 'outbox-missing') await admin.query('DELETE FROM pactwoven.mandate_outbox');
    } finally { await admin.query(`ALTER TABLE pactwoven.${table} ENABLE TRIGGER USER`); }
    await expect(read()).rejects.toMatchObject({ code: expect.stringMatching(/^(MANDATE_READ_INVALID|POLICY_DOCUMENT_INVALID)$/) });
  });
});
