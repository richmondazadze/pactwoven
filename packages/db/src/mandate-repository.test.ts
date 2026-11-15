import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type CreateMandateDocumentRequest, type MandateAuthorityIntent, type MandateDecisionIntent, type MandatePolicy,
  type MemberCandidate, type ProposeMandateCommand, type MandateHead } from '@pactwoven/contracts';
import { commandDigest, createPolicyDocumentVersion, mandateHeadReference, mandateIntentHash, mandateVersionReference } from '@pactwoven/domain';
import { PostgresMandateRepository, mandateCommandHash } from './mandate-repository.js';
import { assertMandatePool } from './mandate-pool.js';
import type { VerifiedIdentity } from './repository.js';
import type { MandateMutation, VerifiedMandateCommand } from './mandate-schema.js';

const suite = process.env.PACTWOVEN_RUN_MANDATE_DB_TESTS === '1' ? describe : describe.skip;
describe('durable mandate command digest', () => {
  it('binds equal normalized commands to resolved tenant, actor, environment, kind and route identity', async () => {
    const scope = { environment: 'development' as const, organizationId: 'org_a', actorId: 'operations_a', responsibilityId: 'responsibility_a' };
    const mutation: MandateMutation = { kind: 'document', request: { responsibility: { id: 'responsibility_a', version: 1, siteId: 'site_a', hash: 'a'.repeat(64) }, expectedOrganizationEpoch: 2,
      command: { documentId: 'policy_a', expectedVersion: 0, previousVersion: null, purpose: 'MANDATE_POLICY', text: 'Cafe\u0301\r\n' } } };
    const hash = await mandateCommandHash(scope, mutation);
    for (const changed of [{ ...scope, actorId: 'finance_a' }, { ...scope, organizationId: 'org_b' }, { ...scope, responsibilityId: 'responsibility_b' }, { ...scope, environment: 'staging' as const }]) {
      expect(await mandateCommandHash(changed, mutation)).not.toBe(hash);
    }
    expect(await mandateCommandHash(scope, { ...mutation, request: { ...mutation.request, command: { ...mutation.request.command, text: 'Café\n' } } })).toBe(hash);
    expect(hash).not.toBe(await commandDigest(mutation.request));
  });
});
const identity = (subject = 'finance_a'): VerifiedIdentity => ({ subject, externalOrganizationId: 'clerk_org_a', externalOrganizationName: 'Mandate test organization',
  externalMembershipId: `membership_${subject}`, externalRole: 'org:member', sessionId: `session_${subject}`,
  authenticatedAt: new Date(Date.now() - 3_600_000).toISOString(), membershipObservedAt: new Date().toISOString() });
const candidate = (): MemberCandidate => ({ externalOrganizationId: 'clerk_org_a', externalSubject: 'operations_a', externalMembershipId: 'membership_operations_a',
  externalRole: 'org:member', displayName: 'Operations', observedAt: new Date().toISOString() });
async function verified(mutation: MandateMutation, key: string, subject = 'finance_a'): Promise<VerifiedMandateCommand> {
  const actor = identity(subject), requestNonce = crypto.randomUUID();
  if ((mutation.kind !== 'decide' || mutation.intent.action !== 'AUTHORIZE') && (mutation.kind !== 'control' || mutation.intent.action !== 'RESUME')) {
    return { identity: actor, evidence: null, requestNonce, requesterObservation: mutation.kind === 'decide' ? candidate() : null };
  }
  const intent = mutation.intent, issued = Math.floor(Date.now() / 1000) * 1000, purpose = intent.action === 'AUTHORIZE' ? 'mandate_authorization' : 'mandate_control';
  return { identity: actor, requestNonce, requesterObservation: candidate(), evidence: { id: crypto.randomUUID(), purpose,
    subject: actor.subject, externalOrganizationId: actor.externalOrganizationId, externalMembershipId: actor.externalMembershipId, sessionId: actor.sessionId,
    issuer: 'https://fixture.clerk.accounts.dev', tokenHash: 'a'.repeat(64), tokenIssuedAt: new Date(issued).toISOString(), firstFactorAgeMinutes: 0, secondFactorAgeMinutes: 0,
    verifiedAt: new Date(issued - 60_000).toISOString(), observedAt: new Date().toISOString(), expiresAt: new Date(issued + 180_000).toISOString(), requestNonce,
    intentHash: await mandateIntentHash(intent), requestHash: await commandDigest({ schemaVersion: 1, purpose, request: { nonce: requestNonce, key, intent } }) } };
}

suite('isolated real PostgreSQL mandate authority', () => {
  let admin: Pool, writer: Pool, repository: PostgresMandateRepository, testLock: PoolClient;
  beforeAll(async () => {
    const urls = await Promise.all(['PACTWOVEN_MANDATE_TEST_ADMIN_URL_FILE', 'PACTWOVEN_MANDATE_TEST_WRITER_URL_FILE'].map(async name => {
      const file = process.env[name]; if (!file) throw new Error('Explicit protected mandate test credential files required.');
      const url = new URL((await readFile(file, 'utf8')).trim());
      if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/pactwoven_mandate_b1b_test') throw new Error('Only the task-owned isolated mandate database may be tested.');
      return url;
    }));
    if (urls[0]!.host !== urls[1]!.host || urls[0]!.username === urls[1]!.username || urls[1]!.username !== 'pactwoven_mandate_b1b_test_login') throw new Error('Exclusive isolated mandate login required.');
    admin = new Pool({ connectionString: urls[0]!.href, max: 5 }); writer = new Pool({ connectionString: urls[1]!.href, max: 4 });
    expect((await admin.query('SELECT current_database() AS name')).rows[0].name).toBe('pactwoven_mandate_b1b_test');
    testLock = await admin.connect(); await testLock.query("SELECT pg_catalog.pg_advisory_lock(pg_catalog.hashtext('mandate_b1b_author_qualification'))");
    await admin.query('DROP SCHEMA IF EXISTS pactwoven CASCADE');
    for (const file of ['0001_foundation.sql', '0002_organization_bootstrap.sql', '0003_identity_access.sql', '0004_mandate_authority.sql']) {
      await admin.query(await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
    }
    await assertMandatePool(writer);
    repository = new PostgresMandateRepository(writer, 'development');
  });
  beforeEach(async () => {
    await admin.query('TRUNCATE pactwoven.organizations,pactwoven.session_revocations CASCADE');
    await admin.query("INSERT INTO pactwoven.organizations(environment,id,external_organization_id,name,authority_epoch) VALUES('development','org_a','clerk_org_a','Mandate test organization',2),('development','org_b','clerk_org_b','Foreign organization',0)");
    for (const [subject, role] of [['operations_a', 'operations'], ['finance_a', 'finance'], ['finance_b', 'finance'], ['owner_a', 'owner'], ['receiver_a', 'receiver'], ['auditor_a', 'auditor']] as const) {
      await admin.query("INSERT INTO pactwoven.memberships(environment,organization_id,actor_id,external_subject,external_membership_id,roles,grant_basis) VALUES('development','org_a',$1,$1,$2,$3,'internal')", [subject, `membership_${subject}`, [role]]);
    }
    await admin.query("INSERT INTO pactwoven.sites(environment,organization_id,id,name,time_zone) VALUES('development','org_a','site_a','Site A','America/Chicago'),('development','org_a','site_b','Site B','America/Chicago')");
    await admin.query("INSERT INTO pactwoven.site_memberships(environment,organization_id,actor_id,site_id) SELECT environment,organization_id,actor_id,'site_a' FROM pactwoven.memberships WHERE organization_id='org_a'");
    await admin.query("INSERT INTO pactwoven.member_action_sites(environment,organization_id,actor_id,site_id) SELECT environment,organization_id,actor_id,'site_a' FROM pactwoven.memberships WHERE organization_id='org_a'");
    await admin.query("INSERT INTO pactwoven.responsibilities(environment,organization_id,id,owner_id,site_id,title,description,starts_at,ends_at,time_zone,requirements,acceptance_policy,created_at,updated_at) VALUES('development','org_a','responsibility_a','operations_a','site_a','Event preparation','',now(),now()+interval '2 days','America/Chicago','[]','Signed delivery evidence.',now()-interval '1 hour',now()-interval '1 hour')");
  });
  afterAll(async () => {
    await writer?.end();
    if (testLock) { await testLock.query("SELECT pg_catalog.pg_advisory_unlock(pg_catalog.hashtext('mandate_b1b_author_qualification'))"); testLock.release(); }
    await admin?.end();
  });
  async function mutate(mutation: MandateMutation, key: string, subject = 'finance_a') {
    return repository.mutate(await verified(mutation, key, subject), 'responsibility_a', key, mutation, 'mandate_test');
  }
  async function documents() {
    const page = await repository.list(identity(), 'responsibility_a', { limit: 25 }, 'trace');
    const request: CreateMandateDocumentRequest = { responsibility: page.responsibilityReference, expectedOrganizationEpoch: page.organizationEpoch,
      command: { documentId: 'acceptance_a', expectedVersion: 0, previousVersion: null, purpose: 'ACCEPTANCE_POLICY', text: page.responsibility.acceptancePolicy } };
    const acceptance = await mutate({ kind: 'document', request }, 'create_acceptance_0001', 'operations_a');
    const policy = await mutate({ kind: 'document', request: { ...request, command: { ...request.command, documentId: 'policy_a', purpose: 'MANDATE_POLICY', text: 'Advice only. No money or outbound messages.' } } }, 'create_policy_doc_0001', 'operations_a');
    return { page, acceptance, policy, request };
  }
  async function propose(proposalId = 'proposal_a', lifetimeMs = 3_600_000, authorityLifetimeMs = lifetimeMs) {
    const base = await documents(), expiresAt = new Date(Date.now() + lifetimeMs).toISOString();
    const authorityExpiresAt = authorityLifetimeMs === lifetimeMs ? expiresAt : new Date(Date.now() + authorityLifetimeMs).toISOString();
    const ref = ({ id, version, hash }: { id: string; version: number; hash: string }) => ({ id, version, hash });
    const policy: MandatePolicy = { mode: 'ADVISE', siteIds: ['site_a'], actions: [], budgets: [], supplierRelationshipIds: [], acceptancePolicy: ref(base.acceptance.target),
      communication: { recipientIds: [], purposes: [], messageKinds: [], maximumMessages: 0, expiresAt: authorityExpiresAt }, expiresAt: authorityExpiresAt };
    const command: ProposeMandateCommand = { proposalId, expectedProposalVersion: 0, previousProposal: null, mandateId: 'mandate_a', responsibility: base.page.responsibilityReference,
      expectedOrganizationEpoch: 2, previousAcceptedVersion: null, expectedHead: null, policy, policyDocument: ref(base.policy.target), expiresAt };
    const result = await mutate({ kind: 'propose', command }, 'propose_mandate_0001', 'operations_a');
    const intent: MandateDecisionIntent = { schemaVersion: 1, action: 'AUTHORIZE', proposal: ref(result.target), expectedDecisionVersion: 1, expectedOrganizationEpoch: 2, expectedHead: null, reason: null };
    return { ...base, command, intent, result };
  }
  async function authorize() {
    const base = await propose();
    const result = await mutate({ kind: 'decide', proposalId: 'proposal_a', intent: base.intent }, 'authorize_mandate_0001');
    return { ...base, authorization: result, review: await repository.review(identity(), 'responsibility_a', 'proposal_a', { version: 1 }, 'trace') };
  }
  async function control(action: MandateAuthorityIntent['action'], key: string) {
    const review = await repository.review(identity(), 'responsibility_a', 'proposal_a', { version: 1 }, 'trace');
    const intent: MandateAuthorityIntent = { schemaVersion: 1, action, mandate: await mandateVersionReference(review.envelope.acceptedVersion!), head: await mandateHeadReference(review.envelope.head!),
      responsibility: review.envelope.responsibilityReference, expectedOrganizationEpoch: review.envelope.organizationEpoch, reason: 'Review authority' };
    return mutate({ kind: 'control', mandateId: 'mandate_a', intent }, key);
  }
  function transactionRepository(client: PoolClient, suppliedContext?: unknown) {
    // Keep real repository commands pending until the outer transaction's deferred checks run.
    const pool = { async connect() { return { async query(sql: string, params?: unknown[]) {
      if (sql === 'BEGIN') return client.query('SAVEPOINT mandate_test_command');
      if (sql === 'COMMIT') return client.query('RELEASE SAVEPOINT mandate_test_command');
      if (sql === 'ROLLBACK') return client.query('ROLLBACK TO SAVEPOINT mandate_test_command');
      if (suppliedContext !== undefined && sql.startsWith('INSERT INTO pactwoven.mandate_operations(')) {
        return client.query(sql.replace(',identity) VALUES', ',identity,effect_context) VALUES').replace('$12::jsonb)', '$12::jsonb,$13::jsonb)'), [...params!, JSON.stringify(suppliedContext)]);
      }
      return client.query(sql, params);
    }, release() { /* The outer test owns this client. */ } }; } } as unknown as Pool;
    return new PostgresMandateRepository(pool, 'development');
  }
  async function directControl(client: PoolClient, previous: MandateHead, action: 'PAUSE' | 'REVOKE', records = { operation: true, audit: true, outbox: true }, corrupt?: 'audit-scope' | 'audit-epoch' | 'operation-kind' | 'outbox-target') {
    const actor = identity(), requestNonce = crypto.randomUUID(), operationId = crypto.randomUUID(), key = `direct_${crypto.randomUUID()}`;
    const context = (await client.query('SELECT pactwoven.mandate_resolve_context($1,$2::jsonb,$3,true,$4) AS response', ['development', JSON.stringify(actor), 'responsibility_a', 'direct_control'])).rows[0].response;
    const accepted = (await client.query("SELECT body FROM pactwoven.mandate_versions WHERE id='mandate_a' AND version=$1", [previous.mandateVersion])).rows[0].body;
    const head: MandateHead = { ...previous, state: action === 'PAUSE' ? 'PAUSED' : 'REVOKED', mandateEpoch: previous.mandateEpoch + 1 };
    const responsibility = { id: context.currentResponsibility.id, version: context.currentResponsibility.version, siteId: context.currentResponsibility.siteId, hash: await commandDigest(context.currentResponsibility) };
    const intent: MandateAuthorityIntent = { schemaVersion: 1, action, mandate: await mandateVersionReference(accepted), head: await mandateHeadReference(previous), responsibility, expectedOrganizationEpoch: context.organizationEpoch, reason: 'Direct SQL completeness test' };
    const mutation: MandateMutation = { kind: 'control', mandateId: 'mandate_a', intent };
    const commandHash = await mandateCommandHash({ environment: 'development', organizationId: 'org_a', actorId: 'finance_a', responsibilityId: 'responsibility_a' }, mutation), intentHash = await mandateIntentHash(intent), kind = `mandate.${action.toLowerCase()}`;
    const target = { kind: 'authority', id: 'mandate_a', version: head.mandateEpoch, hash: await commandDigest(head) };
    const result = { schemaVersion: 1, organizationId: 'org_a', responsibilityId: 'responsibility_a', kind, target, commandHash, intentHash, observedAt: context.now,
      operation: { id: operationId, environment: 'development', status: 'succeeded', aggregateId: 'mandate_a', aggregateVersion: head.mandateEpoch, financialState: null, evidenceRefs: [], nextCheckAt: null, error: null } };
    const effect = { identity: actor, evidence: null, requesterObservation: null, kind, responsibilityId: 'responsibility_a', responsibilitySnapshot: context.currentResponsibility, organizationEpoch: context.organizationEpoch,
      command: intent, intentHash, nonce: requestNonce, requestHash: null, operationId, key, commandHash, authorityExpiresAt: head.expiresAt };
    await client.query("SELECT pg_catalog.set_config('pactwoven.mandate_effect',$1,true)", [JSON.stringify(effect)]);
    if (records.operation) await client.query("INSERT INTO pactwoven.mandate_operations(environment,organization_id,responsibility_id,site_id,id,actor_id,kind,idempotency_key,command_hash,command,result,identity) VALUES('development','org_a','responsibility_a','site_a',$1,'finance_a',$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb)", [operationId, corrupt === 'operation-kind' ? 'mandate.revoke' : kind, key, commandHash, JSON.stringify(intent), JSON.stringify(result), JSON.stringify(actor)]);
    await client.query("UPDATE pactwoven.mandate_heads SET body=$1::jsonb WHERE environment='development' AND organization_id='org_a' AND id='mandate_a'", [JSON.stringify(head)]);
    const audit = { schemaVersion: 1, operationId, kind, actorId: 'finance_a', identity: actor, evidence: null, requestNonce, requestHash: null, requesterObservation: null, commandHash, intentHash, occurredAt: context.now,
      history: { head, previousHead: intent.head, action, actorId: 'finance_a', occurredAt: context.now, operationId, intent, evidence: null } };
    if (corrupt === 'audit-epoch') audit.history.head = { ...head, mandateEpoch: head.mandateEpoch + 1 };
    if (records.audit) await client.query("INSERT INTO pactwoven.mandate_audit(environment,organization_id,id,responsibility_id,site_id,operation_id,body) VALUES('development','org_a',$1,'responsibility_a',$4,$2,$3::jsonb)", [crypto.randomUUID(), operationId, JSON.stringify(audit), corrupt === 'audit-scope' ? 'site_b' : 'site_a']);
    if (records.outbox) await client.query("INSERT INTO pactwoven.mandate_outbox(environment,organization_id,id,responsibility_id,site_id,operation_id,event_type,payload) VALUES('development','org_a',$1,'responsibility_a','site_a',$2,$3,$4::jsonb)", [crypto.randomUUID(), operationId, kind, JSON.stringify({ schemaVersion: 1, operationId, kind, responsibilityId: 'responsibility_a', target: corrupt === 'outbox-target' ? { ...target, version: 99 } : target })]);
    return { head, audit, operationId, result, effect };
  }
  it('applies the migration with isolated writer privileges and preserves current responsibility snapshots', async () => {
    expect((await admin.query("SELECT count(*)::int AS n FROM pactwoven.mandate_responsibility_versions WHERE capture_basis='recorded_change'")).rows[0].n).toBe(1);
    const page = await repository.list(identity(), 'responsibility_a', { limit: 25 }, 'trace');
    expect(page.items).toEqual([]); expect(page.effectiveAuthority.state).toBe('NONE');
    await expect(writer.query('SELECT * FROM pactwoven.memberships')).rejects.toMatchObject({ code: '42501' });
    await expect(writer.query("INSERT INTO pactwoven.operations VALUES ('development')")).rejects.toBeDefined();
  });
  it('persists full documents, immutable proposal and independent acceptance atomically without financial effects', async () => {
    const base = await authorize();
    expect(base.review.effectiveAuthority.state).toBe('ACTIVE'); expect(base.review.envelope.financialState).toBeNull();
    expect(base.review.envelope.policyDocuments.map(document => document.text)).toEqual(['Signed delivery evidence.', 'Advice only. No money or outbound messages.']);
    expect(base.review.envelope.acceptedVersion?.version).toBe(1); expect(base.review.envelope.head?.mandateEpoch).toBe(1);
    expect((await admin.query('SELECT count(*)::int AS n FROM pactwoven.mandate_operations')).rows[0].n).toBe(4);
    expect((await admin.query('SELECT count(*)::int AS n FROM pactwoven.mandate_audit')).rows[0].n).toBe(4);
    expect((await admin.query('SELECT count(*)::int AS n FROM pactwoven.mandate_outbox')).rows[0].n).toBe(4);
    expect(JSON.stringify(base.review)).not.toMatch(/tokenHash|requestNonce|session_finance/);
  });
  it('preserves head epochs, resumes independently, and never resumes revoked accepted authority', async () => {
    await authorize();
    expect((await control('PAUSE', 'pause_mandate_0001')).target.version).toBe(2);
    expect((await control('RESUME', 'resume_mandate_0001')).target.version).toBe(3);
    expect((await control('REVOKE', 'revoke_mandate_0001')).target.version).toBe(4);
    await expect(control('RESUME', 'resume_mandate_0002')).rejects.toMatchObject({ code: 'AUTHORITY_CHANGED' });
    expect((await repository.review(identity(), 'responsibility_a', 'proposal_a', { version: 1 }, 'trace')).effectiveAuthority.state).toBe('REVOKED');
  });
  it('returns the exact original operation after restart, with no fresh MFA or duplicated audit/outbox', async () => {
    const base = await authorize();
    const restarted = new PostgresMandateRepository(writer, 'development');
    const recovery = await restarted.operation(identity(), { kind: 'mandate.authorize', key: 'authorize_mandate_0001' }, 'trace');
    expect(recovery).toEqual(base.authorization);
    const exact = await verified({ kind: 'decide', proposalId: 'proposal_a', intent: base.intent }, 'authorize_mandate_0001'); exact.evidence = null;
    expect(await restarted.mutate(exact, 'responsibility_a', 'authorize_mandate_0001', { kind: 'decide', proposalId: 'proposal_a', intent: base.intent }, 'trace')).toEqual(recovery);
    await expect(restarted.operation(identity('finance_b'), { kind: 'mandate.authorize', key: 'authorize_mandate_0001' }, 'trace')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await admin.query('SELECT count(*)::int AS n FROM pactwoven.mandate_operations')).rows[0].n).toBe(4);
  });
  it('retains normalized meaningful policy text and refuses changed reuse of the original key', async () => {
    const { request } = await documents();
    const update: CreateMandateDocumentRequest = { ...request, command: { ...request.command, documentId: 'unicode_policy', purpose: 'MANDATE_POLICY', text: 'Cafe\u0301\r\n  preserve  \r\n' } };
    const first = await mutate({ kind: 'document', request: update }, 'unicode_policy_key_0001', 'operations_a');
    const same = { ...update, command: { ...update.command, text: 'Café\n  preserve  \n' } };
    expect(await mutate({ kind: 'document', request: same }, 'unicode_policy_key_0001', 'operations_a')).toEqual(first);
    await expect(mutate({ kind: 'document', request: { ...same, command: { ...same.command, text: 'Café\n  preserve\n' } } }, 'unicode_policy_key_0001', 'operations_a')).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
  it('blocks self-approval, unsupported policy, missing action grant and revoked session without writing', async () => {
    const base = await propose();
    await expect(mutate({ kind: 'decide', proposalId: 'proposal_a', intent: base.intent }, 'self_authorize_key_0001', 'operations_a')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await admin.query("UPDATE pactwoven.memberships SET roles=ARRAY['owner'] WHERE actor_id='operations_a'");
    await expect(mutate({ kind: 'decide', proposalId: 'proposal_a', intent: base.intent }, 'self_authorize_key_0002', 'operations_a')).rejects.toMatchObject({ code: 'INDEPENDENT_APPROVER_REQUIRED' });
    await admin.query("DELETE FROM pactwoven.member_action_sites WHERE actor_id='finance_a'");
    await expect(mutate({ kind: 'decide', proposalId: 'proposal_a', intent: base.intent }, 'no_action_authorize_0001')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await admin.query("INSERT INTO pactwoven.session_revocations(environment,session_id) VALUES('development','session_finance_b')");
    await expect(repository.list(identity('finance_b'), 'responsibility_a', { limit: 25 }, 'trace')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(mutate({ kind: 'propose', command: { ...base.command, proposalId: 'unsafe_policy', policy: { ...base.command.policy, mode: 'ACT_WITHIN_MANDATE' } } }, 'unsafe_policy_key_0001', 'operations_a')).rejects.toBeDefined();
    expect((await admin.query('SELECT count(*)::int AS n FROM pactwoven.mandate_versions')).rows[0].n).toBe(0);
  });
  it('retains historical responsibility text while calculating current authority as stale', async () => {
    await authorize();
    await admin.query("UPDATE pactwoven.responsibilities SET row_version=2,acceptance_policy='New evidence requirement.',updated_at=clock_timestamp() WHERE id='responsibility_a'");
    const review = await repository.review(identity(), 'responsibility_a', 'proposal_a', { version: 1 }, 'trace');
    expect(review.effectiveAuthority.state).toBe('STALE'); expect(review.envelope.head?.state).toBe('ACTIVE');
    expect(review.responsibilityVersions.find(record => record.version === 1)?.acceptancePolicy).toBe('Signed delivery evidence.');
    expect(review.envelope.responsibility.acceptancePolicy).toBe('New evidence requirement.');
    await expect(admin.query("UPDATE pactwoven.responsibilities SET title='Wrong same version' WHERE id='responsibility_a'")).rejects.toMatchObject({ code: 'PM002' });
  });
  it('serializes distinct authorization and rejection keys to one terminal decision', async () => {
    const { intent } = await propose();
    const results = await Promise.allSettled([
      mutate({ kind: 'decide', proposalId: 'proposal_a', intent }, 'racing_authorize_0001'),
      mutate({ kind: 'decide', proposalId: 'proposal_a', intent: { ...intent, action: 'REJECT', reason: 'Another review' } }, 'racing_rejection_0001', 'finance_b'),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect((await admin.query('SELECT count(*)::int AS n FROM pactwoven.mandate_decisions WHERE version=2')).rows[0].n).toBe(1);
    expect((await admin.query('SELECT count(*)::int AS n FROM pactwoven.mandate_operations')).rows[0].n).toBe(4);
  });
  it('atomically supersedes proposal revisions and keeps the rejected version separate from accepted authority', async () => {
    const base = await propose();
    const { kind: _kind, ...reference } = base.result.target;
    const replacement = await mutate({ kind: 'propose', command: { ...base.command, expectedProposalVersion: 1, previousProposal: reference } }, 'replace_proposal_0001', 'operations_a');
    const old = await repository.review(identity(), 'responsibility_a', 'proposal_a', { version: 1 }, 'trace');
    expect(old.envelope.decision?.state).toBe('SUPERSEDED'); expect(old.envelope.acceptedVersion).toBeNull();
    const { kind: _replacementKind, ...nextReference } = replacement.target;
    await mutate({ kind: 'decide', proposalId: 'proposal_a', intent: { ...base.intent, action: 'REJECT', proposal: nextReference, reason: 'Revise policy' } }, 'reject_replacement_0001');
    expect((await repository.review(identity(), 'responsibility_a', 'proposal_a', { version: 2 }, 'trace')).envelope.decision?.state).toBe('REJECTED');
  });
  it('rejects same-key payload changes and distinct-key second approvals without duplicating accepted versions', async () => {
    const base = await authorize();
    await expect(mutate({ kind: 'decide', proposalId: 'proposal_a', intent: { ...base.intent, expectedOrganizationEpoch: 3 } }, 'authorize_mandate_0001')).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(mutate({ kind: 'decide', proposalId: 'proposal_a', intent: base.intent }, 'authorize_mandate_0002')).rejects.toMatchObject({ code: 'DECISION_TERMINAL' });
    expect((await admin.query('SELECT count(*)::int AS n FROM pactwoven.mandate_versions')).rows[0].n).toBe(1);
  });
  it('uses current read assignment and scopes cursors to their exact collection', async () => {
    await propose();
    await expect(repository.list(identity('receiver_a'), 'responsibility_a', { limit: 25 }, 'trace')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await admin.query("INSERT INTO pactwoven.responsibility_assignments(environment,organization_id,responsibility_id,actor_id) VALUES('development','org_a','responsibility_a','receiver_a')");
    expect((await repository.review(identity('receiver_a'), 'responsibility_a', 'proposal_a', { version: 1 }, 'trace')).effectiveDecisionState).toBe('OPEN');
    const cursor = Buffer.from(JSON.stringify({ organizationId: 'org_b', responsibilityId: 'responsibility_a', proposal: { id: 'proposal_a', version: 1, hash: 'a'.repeat(64) } })).toString('base64url');
    await expect(repository.list(identity(), 'responsibility_a', { limit: 1, cursor }, 'trace')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
  it.each(['identity', 'nonce', 'intent', 'request', 'purpose'] as const)('rejects private MFA with changed %s binding', async field => {
    const { intent } = await propose(), mutation: MandateMutation = { kind: 'decide', proposalId: 'proposal_a', intent }, key = 'wrong_binding_key_0001';
    const input = await verified(mutation, key);
    if (field === 'identity') input.evidence!.subject = 'finance_b';
    if (field === 'nonce') input.evidence!.requestNonce = crypto.randomUUID();
    if (field === 'intent') input.evidence!.intentHash = 'b'.repeat(64);
    if (field === 'request') input.evidence!.requestHash = 'b'.repeat(64);
    if (field === 'purpose') input.evidence!.purpose = 'mandate_control';
    await expect(repository.mutate(input, 'responsibility_a', key, mutation, 'trace')).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
    expect((await admin.query('SELECT count(*)::int AS n FROM pactwoven.mandate_versions')).rows[0].n).toBe(0);
  });
  it.each(['actor', 'requester', 'site', 'session', 'epoch', 'responsibility'] as const)('rechecks %s changes made while authorization waits for the organization lock', async target => {
    const { intent } = await propose(), mutation: MandateMutation = { kind: 'decide', proposalId: 'proposal_a', intent }, key = 'queued_authorize_0001';
    const input = await verified(mutation, key), blocker = await admin.connect();
    await blocker.query('BEGIN');
    await blocker.query("SELECT id FROM pactwoven.organizations WHERE id='org_a' FOR UPDATE");
    const pending = repository.mutate(input, 'responsibility_a', key, mutation, 'trace').then(value => ({ value, error: null }), error => ({ value: null, error }));
    try {
      if (target === 'actor') await blocker.query("UPDATE pactwoven.memberships SET status='revoked' WHERE actor_id='finance_a'");
      if (target === 'requester') await blocker.query("UPDATE pactwoven.memberships SET status='revoked' WHERE actor_id='operations_a'");
      if (target === 'site') await blocker.query("DELETE FROM pactwoven.member_action_sites WHERE actor_id='finance_a'");
      if (target === 'session') await blocker.query("INSERT INTO pactwoven.session_revocations(environment,session_id) VALUES('development','session_finance_a')");
      if (target === 'epoch') await blocker.query("UPDATE pactwoven.organizations SET authority_epoch=3 WHERE id='org_a'");
      if (target === 'responsibility') await blocker.query("UPDATE pactwoven.responsibilities SET row_version=2,title='Revised responsibility',updated_at=clock_timestamp() WHERE id='responsibility_a'");
      await blocker.query('COMMIT');
    } finally { blocker.release(); }
    expect((await pending).error).toBeInstanceOf(Error);
    expect((await admin.query('SELECT count(*)::int AS n FROM pactwoven.mandate_versions')).rows[0].n).toBe(0);
  });
  it.each(['proof', 'actor-observation', 'requester-observation'] as const)('rejects %s expiry during lock wait using actual database time', async target => {
    const { intent } = await propose(), mutation: MandateMutation = { kind: 'decide', proposalId: 'proposal_a', intent }, key = 'expiry_authorize_0001';
    const input = await verified(mutation, key), blocker = await admin.connect();
    if (target === 'proof') input.evidence!.expiresAt = new Date(Date.now() + 200).toISOString();
    if (target === 'actor-observation') input.identity.membershipObservedAt = new Date(Date.now() - 19_800).toISOString();
    if (target === 'requester-observation') input.requesterObservation!.observedAt = new Date(Date.now() - 19_800).toISOString();
    await blocker.query('BEGIN'); await blocker.query("SELECT id FROM pactwoven.organizations WHERE id='org_a' FOR UPDATE");
    const pending = repository.mutate(input, 'responsibility_a', key, mutation, 'trace').then(value => ({ value, error: null }), error => ({ value: null, error }));
    await new Promise(resolve => setTimeout(resolve, 350));
    await blocker.query('COMMIT'); blocker.release();
    expect((await pending).error).toBeInstanceOf(Error);
    expect((await admin.query('SELECT count(*)::int AS n FROM pactwoven.mandate_versions')).rows[0].n).toBe(0);
  });
  it('rolls the complete plan back if evidence expires after inserts but before deferred commit checks', async () => {
    const { intent } = await propose(), mutation: MandateMutation = { kind: 'decide', proposalId: 'proposal_a', intent }, key = 'delayed_commit_key_0001';
    await admin.query("CREATE FUNCTION pactwoven.mandate_test_delay() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.35); RETURN NEW; END $$");
    await admin.query('CREATE TRIGGER z_mandate_test_delay BEFORE INSERT ON pactwoven.mandate_outbox FOR EACH ROW EXECUTE FUNCTION pactwoven.mandate_test_delay()');
    try {
      const input = await verified(mutation, key); input.evidence!.expiresAt = new Date(Date.now() + 200).toISOString();
      await expect(repository.mutate(input, 'responsibility_a', key, mutation, 'trace')).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
      expect((await admin.query('SELECT count(*)::int AS n FROM pactwoven.mandate_versions')).rows[0].n).toBe(0);
      expect((await admin.query('SELECT count(*)::int AS n FROM pactwoven.mandate_operations')).rows[0].n).toBe(3);
      expect((await admin.query('SELECT count(*)::int AS n FROM pactwoven.mandate_audit')).rows[0].n).toBe(3);
      expect((await admin.query('SELECT count(*)::int AS n FROM pactwoven.mandate_outbox')).rows[0].n).toBe(3);
      await expect(repository.operation(identity(), { kind: 'mandate.authorize', key }, 'trace')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    } finally { await admin.query('DROP TRIGGER z_mandate_test_delay ON pactwoven.mandate_outbox'); await admin.query('DROP FUNCTION pactwoven.mandate_test_delay()'); }
    expect((await mutate(mutation, key)).operation.status).toBe('succeeded');
  });
  it('rolls back a failed outbox insert and permits the unchanged original command after the failure is removed', async () => {
    const { intent } = await propose(), mutation: MandateMutation = { kind: 'decide', proposalId: 'proposal_a', intent }, key = 'failed_outbox_key_0001';
    await admin.query("CREATE FUNCTION pactwoven.mandate_test_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE='PM004',MESSAGE='Injected test failure'; END $$");
    await admin.query('CREATE TRIGGER z_mandate_test_reject BEFORE INSERT ON pactwoven.mandate_outbox FOR EACH ROW EXECUTE FUNCTION pactwoven.mandate_test_reject()');
    try { await expect(mutate(mutation, key)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' }); }
    finally { await admin.query('DROP TRIGGER z_mandate_test_reject ON pactwoven.mandate_outbox'); await admin.query('DROP FUNCTION pactwoven.mandate_test_reject()'); }
    expect((await admin.query('SELECT count(*)::int AS n FROM pactwoven.mandate_heads')).rows[0].n).toBe(0);
    expect((await mutate(mutation, key)).operation.status).toBe('succeeded');
  });
  it.each(['evidence', 'actor-observation', 'requester-observation', 'actor-membership', 'requester-membership', 'proposal-deadline'] as const)(
    'rechecks the original %s after a later valid pause replaces the connection context', async expiry => {
      const base = expiry === 'proposal-deadline' ? await propose('proposal_a', 900, 3_600_000) : await propose();
      const mutation: MandateMutation = { kind: 'decide', proposalId: 'proposal_a', intent: base.intent }, key = 'original_effect_expiry_0001';
      const input = await verified(mutation, key, 'finance_b'), deadline = expiry === 'proposal-deadline' ? Date.parse(base.command.expiresAt) : Date.now() + 700;
      if (expiry === 'evidence') input.evidence!.expiresAt = new Date(deadline).toISOString();
      if (expiry === 'actor-observation') input.identity.membershipObservedAt = new Date(deadline - 20_000).toISOString();
      if (expiry === 'requester-observation') input.requesterObservation!.observedAt = new Date(deadline - 20_000).toISOString();
      if (expiry === 'actor-membership' || expiry === 'requester-membership') {
        await admin.query('UPDATE pactwoven.memberships SET expires_at=$1 WHERE actor_id=$2', [new Date(deadline).toISOString(), expiry === 'actor-membership' ? 'finance_b' : 'operations_a']);
      }
      const client = await writer.connect(); await client.query('BEGIN');
      try {
        await transactionRepository(client).mutate(input, 'responsibility_a', key, mutation, 'original_effect');
        const head = (await client.query('SELECT body FROM pactwoven.mandate_heads')).rows[0].body;
        const pause = await directControl(client, head, 'PAUSE');
        expect(pause.effect).toMatchObject({ identity: { subject: 'finance_a' }, kind: 'mandate.pause', evidence: null, requesterObservation: null });
        expect((await client.query("SELECT current_setting('pactwoven.mandate_effect')::jsonb AS effect")).rows[0].effect).toEqual(pause.effect);
        expect(Date.now()).toBeLessThan(deadline);
        await new Promise(resolve => setTimeout(resolve, Math.max(0, deadline - Date.now()) + 60));
        await expect(client.query('COMMIT')).rejects.toMatchObject({ code: expiry === 'evidence' ? 'PM005' : expiry === 'proposal-deadline' ? 'PM002' : 'PM001' });
      } finally { await client.query('ROLLBACK'); client.release(); }
      expect((await admin.query('SELECT count(*)::int AS n FROM pactwoven.mandate_operations')).rows[0].n).toBe(3);
      expect((await admin.query('SELECT count(*)::int AS n FROM pactwoven.mandate_versions')).rows[0].n).toBe(0);
      expect((await admin.query('SELECT count(*)::int AS n FROM pactwoven.mandate_heads')).rows[0].n).toBe(0);
    });
  it('restores every scope setting after checking multiple original contexts immediately', async () => {
    const { intent } = await propose(), mutation: MandateMutation = { kind: 'decide', proposalId: 'proposal_a', intent }, key = 'restored_effect_scope_0001';
    const client = await writer.connect(); await client.query('BEGIN');
    try {
      await transactionRepository(client).mutate(await verified(mutation, key, 'finance_b'), 'responsibility_a', key, mutation, 'restore_scope');
      const pause = await directControl(client, (await client.query('SELECT body FROM pactwoven.mandate_heads')).rows[0].body, 'PAUSE');
      const settings = ['environment', 'organization_id', 'actor_id', 'session_id', 'mandate_responsibility_id', 'mandate_site_id', 'mandate_effect'];
      const readSettings = async () => (await client.query('SELECT key,current_setting(key,true) AS value FROM unnest($1::text[]) key ORDER BY key', [settings.map(key => `pactwoven.${key}`)])).rows;
      const before = await readSettings();
      await client.query('SET CONSTRAINTS ALL IMMEDIATE');
      expect(await readSettings()).toEqual(before);
      expect((await client.query("SELECT current_setting('pactwoven.actor_id') AS actor")).rows[0].actor).toBe('finance_a');
      expect((await client.query('SELECT count(*)::int AS n FROM pactwoven.mandate_operations')).rows[0].n).toBe(5);
      expect(pause.head.state).toBe('PAUSED');
      await client.query('COMMIT');
    } finally { await client.query('ROLLBACK'); client.release(); }
    expect((await repository.review(identity(), 'responsibility_a', 'proposal_a', { version: 1 }, 'trace')).envelope.head?.state).toBe('PAUSED');
  });
  it('captures declared operation context instead of a supplied INSERT value and keeps it immutable', async () => {
    const { intent } = await propose(), mutation: MandateMutation = { kind: 'decide', proposalId: 'proposal_a', intent }, key = 'captured_effect_value_0001';
    const input = await verified(mutation, key), client = await writer.connect(); await client.query('BEGIN');
    let operationId: string;
    try {
      const result = await transactionRepository(client, { kind: 'mandate.pause', evidence: null, unexpected: 'caller supplied context' }).mutate(input, 'responsibility_a', key, mutation, 'capture_effect');
      operationId = result.operation.id;
      const captured = (await client.query('SELECT effect_context FROM pactwoven.mandate_operations WHERE id=$1', [operationId])).rows[0].effect_context;
      expect(captured).toMatchObject({ operationId, kind: 'mandate.authorize', evidence: input.evidence, requesterObservation: input.requesterObservation, identity: input.identity });
      expect(captured).not.toHaveProperty('unexpected');
      await client.query("SELECT set_config('pactwoven.mandate_effect','{}',true)");
      await client.query('COMMIT');
    } finally { await client.query('ROLLBACK'); client.release(); }
    await expect(writer.query("UPDATE pactwoven.mandate_operations SET effect_context='{}' WHERE id=$1", [operationId!])).rejects.toMatchObject({ code: '42501' });
    await expect(admin.query("UPDATE pactwoven.mandate_operations SET effect_context='{}' WHERE id=$1", [operationId!])).rejects.toMatchObject({ code: 'PM006' });
    expect((await repository.operation(identity(), { kind: 'mandate.authorize', key }, 'trace')).operation.id).toBe(operationId!);
  });
  it.each(['copied', 'missing-evidence', 'requester', 'nonce', 'command', 'identity', 'snapshot', 'epoch', 'proposal-deadline', 'authority-deadline', 'extra-field'] as const)(
    'fails closed on privileged persisted effect-context corruption: %s', async corruption => {
      const { authorization } = await authorize();
      const rows = (await admin.query('SELECT id,kind,effect_context FROM pactwoven.mandate_operations')).rows;
      const original = rows.find(row => row.id === authorization.operation.id)!.effect_context;
      let changed = structuredClone(original);
      if (corruption === 'copied') changed = rows.find(row => row.kind === 'mandate.propose')!.effect_context;
      if (corruption === 'missing-evidence') delete changed.evidence;
      if (corruption === 'requester') changed.requesterObservation.externalSubject = 'finance_b';
      if (corruption === 'nonce') changed.nonce = crypto.randomUUID();
      if (corruption === 'command') changed.command.reason = 'Different original command';
      if (corruption === 'identity') changed.identity.subject = 'finance_b';
      if (corruption === 'snapshot') changed.responsibilitySnapshot.title = 'Changed original responsibility';
      if (corruption === 'epoch') changed.organizationEpoch = 1;
      if (corruption === 'proposal-deadline') changed.proposalExpiresAt = null;
      if (corruption === 'authority-deadline') changed.authorityExpiresAt = new Date(Date.parse(original.authorityExpiresAt) + 1).toISOString();
      if (corruption === 'extra-field') changed.unrecognized = true;
      await admin.query('ALTER TABLE pactwoven.mandate_operations DISABLE TRIGGER USER');
      try { await admin.query('UPDATE pactwoven.mandate_operations SET effect_context=$1::jsonb WHERE id=$2', [JSON.stringify(changed), authorization.operation.id]); }
      finally { await admin.query('ALTER TABLE pactwoven.mandate_operations ENABLE TRIGGER USER'); }
      await expect(repository.review(identity(), 'responsibility_a', 'proposal_a', { version: 1 }, 'trace')).rejects.toMatchObject({ code: 'MANDATE_READ_INVALID' });
      await expect(repository.operation(identity(), { kind: 'mandate.authorize', key: 'authorize_mandate_0001' }, 'trace')).rejects.toMatchObject({ code: 'MANDATE_READ_INVALID' });
    });
  it.each(['document', 'audit', 'operation', 'head'] as const)('fails closed on privileged %s provenance tampering', async target => {
    await authorize();
    const table = target === 'document' ? 'mandate_policy_documents' : target === 'audit' ? 'mandate_audit' : target === 'operation' ? 'mandate_operations' : 'mandate_heads';
    await admin.query(`ALTER TABLE pactwoven.${table} DISABLE TRIGGER USER`);
    try {
      if (target === 'document') await admin.query("UPDATE pactwoven.mandate_policy_documents SET body=jsonb_set(body,'{text}','\"Changed authoritative text\"') WHERE id='policy_a'");
      if (target === 'audit') await admin.query("UPDATE pactwoven.mandate_audit SET body=jsonb_set(body,'{evidence,requestHash}',to_jsonb(repeat('b',64))) WHERE body->>'kind'='mandate.authorize'");
      if (target === 'operation') await admin.query("UPDATE pactwoven.mandate_operations SET command=jsonb_set(command,'{expectedOrganizationEpoch}','1') WHERE kind='mandate.authorize'");
      if (target === 'head') await admin.query("UPDATE pactwoven.mandate_heads SET body=jsonb_set(body,'{state}','\"REVOKED\"')");
    } finally { await admin.query(`ALTER TABLE pactwoven.${table} ENABLE TRIGGER USER`); }
    await expect(repository.review(identity(), 'responsibility_a', 'proposal_a', { version: 1 }, 'trace')).rejects.toBeDefined();
    await expect(repository.operation(identity(), { kind: 'mandate.authorize', key: 'authorize_mandate_0001' }, 'trace')).rejects.toBeDefined();
  });
  it('denies mutable history and SQL financial/outbound policy ceilings even with crafted service context', async () => {
    const { command } = await propose();
    for (const table of ['mandate_policy_documents', 'mandate_proposals', 'mandate_decisions', 'mandate_versions', 'mandate_operations', 'mandate_audit', 'mandate_outbox']) {
      await expect(writer.query(`DELETE FROM pactwoven.${table}`)).rejects.toMatchObject({ code: '42501' });
      await expect(writer.query(`UPDATE pactwoven.${table} SET body='{}'::jsonb`)).rejects.toBeDefined();
    }
    for (const change of [ { ...command.policy, mode: 'ACT_WITHIN_MANDATE' }, { ...command.policy, actions: ['PAY'] }, { ...command.policy, budgets: [0] },
      { ...command.policy, supplierRelationshipIds: ['supplier_a'] }, { ...command.policy, siteIds: ['site_b'] },
      { ...command.policy, communication: { ...command.policy.communication, maximumMessages: false } },
      { ...command.policy, communication: { ...command.policy.communication, maximumMessages: null } },
      { ...command.policy, communication: { ...command.policy.communication, recipientIds: ['recipient_a'] } },
      { ...command.policy, hiddenBudget: 100 }, null ]) {
      expect((await writer.query('SELECT pactwoven.mandate_advise_only($1::jsonb,$2) AS valid', [JSON.stringify(change), 'site_a'])).rows[0].valid).toBe(false);
    }
    expect((await writer.query('SELECT pactwoven.mandate_advise_only($1::jsonb,$2) AS valid', [JSON.stringify(command.policy), 'site_a'])).rows[0].valid).toBe(true);
    await expect(admin.query("UPDATE pactwoven.mandate_proposals SET body='{}'::jsonb")).rejects.toMatchObject({ code: 'PM006' });
  });
  it('recovers the original result after the server commits but its connection loses the response', async () => {
    const { intent } = await propose(), mutation: MandateMutation = { kind: 'decide', proposalId: 'proposal_a', intent }, key = 'lost_response_key_0001';
    const faultingPool = { async connect() {
      const client = await writer.connect();
      return { async query(sql: string, params?: unknown[]) {
        const result = await client.query(sql, params);
        if (sql === 'COMMIT') throw new Error('Injected connection loss with private driver detail');
        return result;
      }, release(error?: boolean) { client.release(error); } };
    } } as unknown as Pool;
    const uncertain = new PostgresMandateRepository(faultingPool, 'development');
    await expect(uncertain.mutate(await verified(mutation, key), 'responsibility_a', key, mutation, 'trace')).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN', message: 'The mandate outcome is unknown. Recover the original request before trying another change.' });
    const recovered = await repository.operation(identity(), { kind: 'mandate.authorize', key }, 'trace');
    expect(recovered.operation.status).toBe('succeeded'); expect(await mutate(mutation, key)).toEqual(recovered);
    expect((await admin.query('SELECT count(*)::int AS n FROM pactwoven.mandate_operations')).rows[0].n).toBe(4);
  });
  it('serializes equal concurrent request keys to the same operation', async () => {
    const { intent } = await propose(), mutation: MandateMutation = { kind: 'decide', proposalId: 'proposal_a', intent };
    const [first, second] = await Promise.all([mutate(mutation, 'same_key_race_0001'), mutate(mutation, 'same_key_race_0001')]);
    expect(first).toEqual(second); expect((await admin.query('SELECT count(*)::int AS n FROM pactwoven.mandate_decisions WHERE version=2')).rows[0].n).toBe(1);
  });
  it('rejects changed actor or responsibility route reuse of the original key', async () => {
    const { request } = await documents();
    await expect(mutate({ kind: 'document', request }, 'create_acceptance_0001', 'finance_a')).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await admin.query("INSERT INTO pactwoven.responsibilities(environment,organization_id,id,owner_id,site_id,title,description,starts_at,ends_at,time_zone,requirements,acceptance_policy) VALUES('development','org_a','responsibility_b','operations_a','site_a','Other responsibility','',now(),now()+interval '1 day','America/Chicago','[]','Other policy')");
    const page = await repository.list(identity(), 'responsibility_b', { limit: 25 }, 'trace');
    const mutation: MandateMutation = { kind: 'document', request: { ...request, responsibility: page.responsibilityReference } };
    await expect(repository.mutate(await verified(mutation, 'create_acceptance_0001', 'operations_a'), 'responsibility_b', 'create_acceptance_0001', mutation, 'trace')).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
  it('rejects direct SQL proposal insertion with financial policy despite valid service identity/context', async () => {
    const base = await propose(), row = (await admin.query("SELECT body FROM pactwoven.mandate_proposals WHERE id='proposal_a'")).rows[0].body;
    const client = await writer.connect(), actor = identity('operations_a'), operationId = crypto.randomUUID();
    await client.query('BEGIN');
    try {
      const context = (await client.query('SELECT pactwoven.mandate_resolve_context($1,$2::jsonb,$3,true,$4) AS response', ['development', JSON.stringify(actor), 'responsibility_a', 'sql_attack'])).rows[0].response;
      const command = { ...base.command, proposalId: 'sql_financial_proposal', policy: { ...base.command.policy, mode: 'ACT_WITHIN_MANDATE' } };
      const proposed = { ...row, id: command.proposalId, policy: command.policy };
      const effect = { identity: actor, evidence: null, requesterObservation: null, kind: 'mandate.propose', responsibilityId: 'responsibility_a', responsibilitySnapshot: context.currentResponsibility,
        organizationEpoch: context.organizationEpoch, command, operationId, key: 'sql_policy_attack_0001', commandHash: 'a'.repeat(64), nonce: crypto.randomUUID(), requestHash: null, intentHash: null };
      await client.query("SELECT pg_catalog.set_config('pactwoven.mandate_effect',$1,true)", [JSON.stringify(effect)]);
      const result = { schemaVersion: 1, organizationId: 'org_a', responsibilityId: 'responsibility_a', kind: effect.kind, commandHash: effect.commandHash, intentHash: null, observedAt: context.now,
        target: { kind: 'proposal', id: proposed.id, version: 1, hash: proposed.hash }, operation: { id: operationId, environment: 'development', status: 'succeeded', aggregateId: proposed.id, aggregateVersion: 1, financialState: null, evidenceRefs: [], nextCheckAt: null, error: null } };
      await client.query("INSERT INTO pactwoven.mandate_operations(environment,organization_id,responsibility_id,site_id,id,actor_id,kind,idempotency_key,command_hash,command,result,identity) VALUES('development','org_a','responsibility_a','site_a',$1,'operations_a',$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb)", [operationId, effect.kind, effect.key, effect.commandHash, JSON.stringify(command), JSON.stringify(result), JSON.stringify(actor)]);
      await expect(client.query('INSERT INTO pactwoven.mandate_proposals(environment,organization_id,responsibility_id,site_id,id,version,hash,mandate_id,requester_id,requester_identity,body,operation_id,responsibility_version) VALUES($1,$2,$3,$4,$5,1,$6,$7,$8,$9::jsonb,$10::jsonb,$11,1)',
        ['development', 'org_a', 'responsibility_a', 'site_a', proposed.id, proposed.hash, proposed.mandateId, 'operations_a', JSON.stringify(actor), JSON.stringify(proposed), operationId])).rejects.toMatchObject({ code: '23514' });
    } finally { await client.query('ROLLBACK'); client.release(); }
    expect((await admin.query('SELECT count(*)::int AS n FROM pactwoven.mandate_proposals')).rows[0].n).toBe(1);
  });
  it('rejects direct SQL self-authorization even after the requester becomes an owner', async () => {
    const { intent } = await propose(); await admin.query("UPDATE pactwoven.memberships SET roles=ARRAY['owner'] WHERE actor_id='operations_a'");
    const mutation: MandateMutation = { kind: 'decide', proposalId: 'proposal_a', intent }, key = 'sql_self_authorize_0001', input = await verified(mutation, key, 'operations_a');
    const client = await writer.connect(); await client.query('BEGIN');
    try {
      const context = (await client.query('SELECT pactwoven.mandate_resolve_context($1,$2::jsonb,$3,true,$4) AS response', ['development', JSON.stringify(input.identity), 'responsibility_a', 'sql_attack'])).rows[0].response;
      const effect = { ...input, kind: 'mandate.authorize', responsibilityId: 'responsibility_a', responsibilitySnapshot: context.currentResponsibility, organizationEpoch: context.organizationEpoch,
        command: intent, operationId: crypto.randomUUID(), key, commandHash: 'a'.repeat(64), intentHash: await mandateIntentHash(intent), nonce: input.requestNonce, requestHash: input.evidence!.requestHash };
      await client.query("SELECT pg_catalog.set_config('pactwoven.mandate_effect',$1,true)", [JSON.stringify(effect)]);
      await expect(client.query("INSERT INTO pactwoven.mandate_audit(environment,organization_id,id,responsibility_id,site_id,operation_id,body) VALUES('development','org_a','attack_audit','responsibility_a','site_a',$1,'{}')", [effect.operationId])).rejects.toMatchObject({ code: 'PM001' });
    } finally { await client.query('ROLLBACK'); client.release(); }
  });
  it('treats stored authority expiry as unusable while recovery stays available after historical MFA expires', async () => {
    const base = await propose('proposal_a', 500), mutation: MandateMutation = { kind: 'decide', proposalId: 'proposal_a', intent: base.intent }, key = 'short_lived_proof_0001';
    const input = await verified(mutation, key); input.evidence!.expiresAt = new Date(Date.now() + 250).toISOString();
    const original = await repository.mutate(input, 'responsibility_a', key, mutation, 'trace');
    await new Promise(resolve => setTimeout(resolve, 550));
    const review = await repository.review(identity(), 'responsibility_a', 'proposal_a', { version: 1 }, 'trace');
    expect(review.effectiveAuthority.state).toBe('EXPIRED'); expect(review.envelope.head?.state).toBe('ACTIVE');
    expect(await repository.operation(identity(), { kind: 'mandate.authorize', key }, 'trace')).toEqual(original);
  });
  it.each(['finance_a', 'operations_a'] as const)('rolls back if %s membership expires after inserts before commit', async actor => {
    const { intent } = await propose();
    await admin.query("CREATE FUNCTION pactwoven.mandate_test_delay() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.35); RETURN NEW; END $$");
    await admin.query('CREATE TRIGGER z_mandate_test_delay BEFORE INSERT ON pactwoven.mandate_outbox FOR EACH ROW EXECUTE FUNCTION pactwoven.mandate_test_delay()');
    await admin.query("UPDATE pactwoven.memberships SET expires_at=clock_timestamp()+interval '200 milliseconds' WHERE actor_id=$1", [actor]);
    try {
      await expect(mutate({ kind: 'decide', proposalId: 'proposal_a', intent }, 'member_expiry_key_0001')).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect((await admin.query('SELECT count(*)::int AS n FROM pactwoven.mandate_operations')).rows[0].n).toBe(3);
      expect((await admin.query('SELECT count(*)::int AS n FROM pactwoven.mandate_heads')).rows[0].n).toBe(0);
    } finally { await admin.query('DROP TRIGGER z_mandate_test_delay ON pactwoven.mandate_outbox'); await admin.query('DROP FUNCTION pactwoven.mandate_test_delay()'); }
  });
  it('rolls back when the proposal and policy expire after effect evaluation but before commit', async () => {
    const { intent } = await propose('proposal_a', 250);
    await admin.query("CREATE FUNCTION pactwoven.mandate_test_delay() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.35); RETURN NEW; END $$");
    await admin.query('CREATE TRIGGER z_mandate_test_delay BEFORE INSERT ON pactwoven.mandate_outbox FOR EACH ROW EXECUTE FUNCTION pactwoven.mandate_test_delay()');
    try {
      await expect(mutate({ kind: 'decide', proposalId: 'proposal_a', intent }, 'policy_expiry_key_0001')).rejects.toMatchObject({ code: 'AUTHORITY_CHANGED' });
      expect((await admin.query('SELECT count(*)::int AS n FROM pactwoven.mandate_operations')).rows[0].n).toBe(3);
    } finally { await admin.query('DROP TRIGGER z_mandate_test_delay ON pactwoven.mandate_outbox'); await admin.query('DROP FUNCTION pactwoven.mandate_test_delay()'); }
  });
  it('serializes resume against revoke using the exact previously observed paused head', async () => {
    await authorize(); await control('PAUSE', 'race_pause_key_0001');
    const review = await repository.review(identity(), 'responsibility_a', 'proposal_a', { version: 1 }, 'trace');
    const resume: MandateAuthorityIntent = { schemaVersion: 1, action: 'RESUME', mandate: await mandateVersionReference(review.envelope.acceptedVersion!), head: await mandateHeadReference(review.envelope.head!),
      responsibility: review.envelope.responsibilityReference, expectedOrganizationEpoch: 2, reason: 'Concurrent control review' };
    const results = await Promise.allSettled([mutate({ kind: 'control', mandateId: 'mandate_a', intent: resume }, 'race_resume_key_0001'),
      mutate({ kind: 'control', mandateId: 'mandate_a', intent: { ...resume, action: 'REVOKE' } }, 'race_revoke_key_0001', 'finance_b')]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect((await admin.query('SELECT epoch FROM pactwoven.mandate_heads')).rows[0].epoch).toBe(3);
  });
  it('refuses a direct head transition with no operation, audit or outbox at commit', async () => {
    const { review } = await authorize(), client = await writer.connect();
    await client.query('BEGIN');
    try {
      await directControl(client, review.envelope.head!, 'PAUSE', { operation: false, audit: false, outbox: false });
      await expect(client.query('COMMIT').then(() => 'committed')).rejects.toMatchObject({ code: 'PM004' });
    } finally { await client.query('ROLLBACK'); client.release(); }
    expect((await admin.query('SELECT body FROM pactwoven.mandate_heads')).rows[0].body).toEqual(review.envelope.head);
    expect((await admin.query('SELECT count(*)::int AS n FROM pactwoven.mandate_operations')).rows[0].n).toBe(4);
  });
  it.each(['different-current-id', 'reused-current-id'] as const)('refuses a policy document attached to an old committed operation: %s', async reuse => {
    const { page, acceptance } = await documents();
    const original = (await admin.query('SELECT * FROM pactwoven.mandate_operations WHERE id=$1', [acceptance.operation.id])).rows[0];
    const actor = reuse === 'reused-current-id' ? original.identity : identity('operations_a'), client = await writer.connect();
    await client.query('BEGIN');
    try {
      const context = (await client.query('SELECT pactwoven.mandate_resolve_context($1,$2::jsonb,$3,true,$4) AS response', ['development', JSON.stringify(actor), 'responsibility_a', 'child_binding'])).rows[0].response;
      const request: CreateMandateDocumentRequest = { responsibility: page.responsibilityReference, expectedOrganizationEpoch: 2,
        command: { documentId: 'unrecorded_document', purpose: 'MANDATE_POLICY', expectedVersion: 0, previousVersion: null, text: 'Unrecorded standalone policy.' } };
      const document = await createPolicyDocumentVersion({ actor: context.reader.actor, now: context.now }, request.command, null);
      const effect = { identity: actor, evidence: null, requesterObservation: null, kind: 'mandate.document.create', responsibilityId: 'responsibility_a', responsibilitySnapshot: context.currentResponsibility,
        organizationEpoch: 2, command: request, operationId: reuse === 'reused-current-id' ? original.id : crypto.randomUUID(), key: reuse === 'reused-current-id' ? original.idempotency_key : 'old_operation_child_0001',
        commandHash: reuse === 'reused-current-id' ? original.command_hash : 'a'.repeat(64), nonce: crypto.randomUUID(), requestHash: null, intentHash: null };
      await client.query("SELECT pg_catalog.set_config('pactwoven.mandate_effect',$1,true)", [JSON.stringify(effect)]);
      await expect((async () => {
        await client.query("INSERT INTO pactwoven.mandate_policy_documents(environment,organization_id,responsibility_id,site_id,id,version,hash,body,operation_id,responsibility_version) VALUES('development','org_a','responsibility_a','site_a',$1,1,$2,$3::jsonb,$4,1)",
          [document.id, document.hash, JSON.stringify(document), acceptance.operation.id]);
        await client.query('COMMIT'); return 'committed';
      })()).rejects.toMatchObject({ code: 'PM004' });
    } finally { await client.query('ROLLBACK'); client.release(); }
  });
  it.each(['audit', 'outbox'] as const)('refuses a direct head change missing its %s record', async missing => {
    const { review } = await authorize(), client = await writer.connect(); await client.query('BEGIN');
    try {
      await directControl(client, review.envelope.head!, 'PAUSE', { operation: true, audit: missing !== 'audit', outbox: missing !== 'outbox' });
      await expect(client.query('COMMIT').then(() => 'committed')).rejects.toMatchObject({ code: 'PM004' });
    } finally { await client.query('ROLLBACK'); client.release(); }
    expect((await admin.query('SELECT body FROM pactwoven.mandate_heads')).rows[0].body).toEqual(review.envelope.head);
    expect((await admin.query('SELECT count(*)::int AS n FROM pactwoven.mandate_operations')).rows[0].n).toBe(4);
  });
  it('does not let a fully recorded final head conceal an unrecorded intermediate snapshot', async () => {
    const { review } = await authorize(), client = await writer.connect(); await client.query('BEGIN');
    try {
      const first = await directControl(client, review.envelope.head!, 'PAUSE', { operation: false, audit: false, outbox: false });
      await directControl(client, first.head, 'REVOKE');
      await expect(client.query('COMMIT').then(() => 'committed')).rejects.toMatchObject({ code: 'PM004' });
    } finally { await client.query('ROLLBACK'); client.release(); }
    expect((await admin.query('SELECT body FROM pactwoven.mandate_heads')).rows[0].body).toEqual(review.envelope.head);
    expect((await admin.query('SELECT count(*)::int AS n FROM pactwoven.mandate_audit')).rows[0].n).toBe(4);
  });
  it('validates each saved head snapshot when two complete changes commit in one transaction', async () => {
    const { review } = await authorize(), client = await writer.connect(); await client.query('BEGIN');
    try {
      const first = await directControl(client, review.envelope.head!, 'PAUSE');
      await directControl(client, first.head, 'REVOKE'); await client.query('COMMIT');
    } finally { await client.query('ROLLBACK'); client.release(); }
    const current = await repository.review(identity(), 'responsibility_a', 'proposal_a', { version: 1 }, 'trace');
    expect(current.envelope.head).toMatchObject({ state: 'REVOKED', mandateEpoch: 3 });
    expect((await admin.query('SELECT count(*)::int AS n FROM pactwoven.mandate_audit')).rows[0].n).toBe(6);
  });
  it.each(['audit-scope', 'audit-epoch', 'operation-kind', 'outbox-target'] as const)('refuses mismatched %s in a direct authority change', async corruption => {
    const { review } = await authorize(), client = await writer.connect(); await client.query('BEGIN');
    try {
      await expect(directControl(client, review.envelope.head!, 'PAUSE', { operation: true, audit: true, outbox: true }, corruption)).rejects.toMatchObject({ code: 'PM004' });
    } finally { await client.query('ROLLBACK'); client.release(); }
    expect((await admin.query('SELECT body FROM pactwoven.mandate_heads')).rows[0].body).toEqual(review.envelope.head);
  });
  it('requires matching history for the initial head INSERT as well as subsequent UPDATEs', async () => {
    const { review, intent, authorization } = await authorize();
    // Deliberately incomplete administrator fixture; the tested INSERT is performed with the ordinary writer.
    await admin.query('ALTER TABLE pactwoven.mandate_heads DISABLE TRIGGER USER');
    await admin.query('ALTER TABLE pactwoven.mandate_audit DISABLE TRIGGER USER');
    try {
      await admin.query('DELETE FROM pactwoven.mandate_heads');
      await admin.query('DELETE FROM pactwoven.mandate_audit WHERE operation_id=$1', [authorization.operation.id]);
    } finally { await admin.query('ALTER TABLE pactwoven.mandate_heads ENABLE TRIGGER USER'); await admin.query('ALTER TABLE pactwoven.mandate_audit ENABLE TRIGGER USER'); }
    const client = await writer.connect(), key = 'initial_history_key_0001', input = await verified({ kind: 'decide', proposalId: 'proposal_a', intent }, key);
    await client.query('BEGIN');
    try {
      const context = (await client.query('SELECT pactwoven.mandate_resolve_context($1,$2::jsonb,$3,true,$4) AS response', ['development', JSON.stringify(input.identity), 'responsibility_a', 'initial_head'])).rows[0].response;
      const effect = { ...input, kind: 'mandate.authorize', responsibilityId: 'responsibility_a', responsibilitySnapshot: context.currentResponsibility, organizationEpoch: 2, command: intent,
        operationId: crypto.randomUUID(), key, commandHash: 'a'.repeat(64), nonce: input.requestNonce, requestHash: input.evidence!.requestHash, intentHash: input.evidence!.intentHash };
      await client.query("SELECT pg_catalog.set_config('pactwoven.mandate_effect',$1,true)", [JSON.stringify(effect)]);
      await client.query("INSERT INTO pactwoven.mandate_heads(environment,organization_id,responsibility_id,id,body) VALUES('development','org_a','responsibility_a','mandate_a',$1::jsonb)", [JSON.stringify(review.envelope.head)]);
      await expect(client.query('COMMIT').then(() => 'committed')).rejects.toMatchObject({ code: 'PM004' });
    } finally { await client.query('ROLLBACK'); client.release(); }
    expect((await admin.query('SELECT count(*)::int AS n FROM pactwoven.mandate_heads')).rows[0].n).toBe(0);
  });
  it('refuses a proposal attached to an old operation without its own complete command', async () => {
    const base = await propose(), actor = identity('operations_a'), client = await writer.connect(); await client.query('BEGIN');
    try {
      const context = (await client.query('SELECT pactwoven.mandate_resolve_context($1,$2::jsonb,$3,true,$4) AS response', ['development', JSON.stringify(actor), 'responsibility_a', 'proposal_binding'])).rows[0].response;
      const stored = (await client.query("SELECT body FROM pactwoven.mandate_proposals WHERE id='proposal_a'")).rows[0].body;
      const command = { ...base.command, proposalId: 'unrecorded_proposal' }, { hash: _hash, ...body } = { ...stored, id: command.proposalId, createdAt: context.now };
      const proposal = { ...body, hash: await commandDigest(body) };
      const effect = { identity: actor, evidence: null, requesterObservation: null, kind: 'mandate.propose', responsibilityId: 'responsibility_a', responsibilitySnapshot: context.currentResponsibility,
        organizationEpoch: 2, command, operationId: crypto.randomUUID(), key: 'old_proposal_operation_0001', commandHash: 'a'.repeat(64), nonce: crypto.randomUUID(), requestHash: null, intentHash: null };
      await client.query("SELECT pg_catalog.set_config('pactwoven.mandate_effect',$1,true)", [JSON.stringify(effect)]);
      await expect(client.query("INSERT INTO pactwoven.mandate_proposals(environment,organization_id,responsibility_id,site_id,id,version,hash,mandate_id,requester_id,requester_identity,body,operation_id,responsibility_version) VALUES('development','org_a','responsibility_a','site_a',$1,1,$2,'mandate_a','operations_a',$3::jsonb,$4::jsonb,$5,1)",
        [proposal.id, proposal.hash, JSON.stringify(actor), JSON.stringify(proposal), base.result.operation.id])).rejects.toMatchObject({ code: 'PM004' });
    } finally { await client.query('ROLLBACK'); client.release(); }
  });
  it('refuses a terminal decision attached to an older decision operation', async () => {
    const base = await propose(), firstIntent: MandateDecisionIntent = { ...base.intent, action: 'REJECT', reason: 'First review' };
    const first = await mutate({ kind: 'decide', proposalId: 'proposal_a', intent: firstIntent }, 'first_decision_key_0001');
    const next = await mutate({ kind: 'propose', command: { ...base.command, proposalId: 'proposal_b' } }, 'next_proposal_key_0001', 'operations_a');
    const { kind: _kind, ...reference } = next.target;
    const intent: MandateDecisionIntent = { ...firstIntent, proposal: reference, reason: 'New review' }, key = 'new_decision_key_0001', mutation: MandateMutation = { kind: 'decide', proposalId: 'proposal_b', intent };
    const input = await verified(mutation, key), client = await writer.connect(); await client.query('BEGIN');
    try {
      const context = (await client.query('SELECT pactwoven.mandate_resolve_context($1,$2::jsonb,$3,true,$4) AS response', ['development', JSON.stringify(input.identity), 'responsibility_a', 'decision_binding'])).rows[0].response;
      const open = (await client.query("SELECT body FROM pactwoven.mandate_decisions WHERE proposal_id='proposal_b' AND version=1")).rows[0].body;
      const decision = { ...open, version: 2, state: 'REJECTED', decidedAt: context.now, actorId: 'finance_a', reason: intent.reason, intentHash: await mandateIntentHash(intent), operationId: first.operation.id };
      const effect = { ...input, kind: 'mandate.reject', responsibilityId: 'responsibility_a', responsibilitySnapshot: context.currentResponsibility, organizationEpoch: 2, command: intent,
        operationId: crypto.randomUUID(), key, commandHash: 'a'.repeat(64), nonce: input.requestNonce, requestHash: null, intentHash: decision.intentHash };
      await client.query("SELECT pg_catalog.set_config('pactwoven.mandate_effect',$1,true)", [JSON.stringify(effect)]);
      await expect(client.query("INSERT INTO pactwoven.mandate_decisions(environment,organization_id,responsibility_id,site_id,proposal_id,proposal_version,version,body,operation_id) VALUES('development','org_a','responsibility_a','site_a','proposal_b',1,2,$1::jsonb,$2)", [JSON.stringify(decision), first.operation.id])).rejects.toMatchObject({ code: 'PM004' });
    } finally { await client.query('ROLLBACK'); client.release(); }
    expect((await repository.review(identity(), 'responsibility_a', 'proposal_b', { version: 1 }, 'trace')).envelope.decision?.state).toBe('OPEN');
  });
  it('binds accepted versions through the current approved decision instead of an older authorization', async () => {
    const base = await authorize();
    const nextCommand = { ...base.command, proposalId: 'proposal_b', previousAcceptedVersion: await mandateVersionReference(base.review.envelope.acceptedVersion!), expectedHead: await mandateHeadReference(base.review.envelope.head!) };
    const next = await mutate({ kind: 'propose', command: nextCommand }, 'next_authority_proposal_0001', 'operations_a');
    const { kind: _kind, ...reference } = next.target, intent: MandateDecisionIntent = { ...base.intent, proposal: reference, expectedHead: nextCommand.expectedHead };
    const key = 'new_version_binding_0001', input = await verified({ kind: 'decide', proposalId: 'proposal_b', intent }, key), client = await writer.connect(); await client.query('BEGIN');
    try {
      const context = (await client.query('SELECT pactwoven.mandate_resolve_context($1,$2::jsonb,$3,true,$4) AS response', ['development', JSON.stringify(input.identity), 'responsibility_a', 'accepted_binding'])).rows[0].response;
      const effect = { ...input, kind: 'mandate.authorize', responsibilityId: 'responsibility_a', responsibilitySnapshot: context.currentResponsibility, organizationEpoch: 2, command: intent,
        operationId: crypto.randomUUID(), key, commandHash: 'a'.repeat(64), nonce: input.requestNonce, requestHash: input.evidence!.requestHash, intentHash: input.evidence!.intentHash };
      await client.query("SELECT pg_catalog.set_config('pactwoven.mandate_effect',$1,true)", [JSON.stringify(effect)]);
      await expect(client.query("INSERT INTO pactwoven.mandate_versions(environment,organization_id,responsibility_id,site_id,id,version,proposal_id,proposal_version,body) VALUES('development','org_a','responsibility_a','site_a','mandate_a',1,'proposal_a',1,$1::jsonb)", [JSON.stringify(base.review.envelope.acceptedVersion)])).rejects.toMatchObject({ code: 'PM004' });
    } finally { await client.query('ROLLBACK'); client.release(); }
  });
  it('keeps immediate controls available at the current responsibility site after a site revision', async () => {
    await authorize();
    await admin.query("UPDATE pactwoven.responsibilities SET site_id='site_b',row_version=2,updated_at=clock_timestamp() WHERE id='responsibility_a'");
    await admin.query("INSERT INTO pactwoven.member_action_sites(environment,organization_id,actor_id,site_id) VALUES('development','org_a','finance_a','site_b')");
    expect((await control('PAUSE', 'revised_site_pause_0001')).operation.status).toBe('succeeded');
    expect((await control('REVOKE', 'revised_site_revoke_0001')).operation.status).toBe('succeeded');
  });
});
