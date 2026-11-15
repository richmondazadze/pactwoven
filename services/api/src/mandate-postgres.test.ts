import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CreateMandateDocumentRequestSchema, MandateOperationResultSchema, MandatePageSchema, MandateReviewSchema,
  type MandateAuthorityIntent, type MandateDecisionIntent, type ProposeMandateCommand } from '@pactwoven/contracts';
import { PostgresMandateRepository, type MandateVerificationRequest, type VerifiedIdentity, type VerifiedMandateStepUpIdentity } from '@pactwoven/db';
import { commandDigest, DomainError, mandateHeadReference, mandateIntentHash, mandateVersionReference } from '@pactwoven/domain';
import { createApp } from './app.js';
import { createMandateGateway } from './mandate-service.js';

const suite = process.env.PACTWOVEN_RUN_MANDATE_DB_TESTS === '1' ? describe : describe.skip;
suite('mandate API with isolated real PostgreSQL and synthetic private provider evidence', () => {
  let admin: Pool, writer: Pool, lock: PoolClient, repository: PostgresMandateRepository;
  const identity = (token: string): VerifiedIdentity => {
    if (!['finance_a', 'operations_a'].includes(token)) throw new DomainError('AUTH_REQUIRED', 401, 'Invalid fixture token');
    return { subject: token, externalOrganizationId: 'clerk_org_a', externalOrganizationName: 'API test', externalMembershipId: `member_${token}`, externalRole: 'org:member',
      sessionId: `session_${token}`, authenticatedAt: new Date(Date.now() - 3_600_000).toISOString(), membershipObservedAt: new Date().toISOString() };
  };
  beforeAll(async () => {
    const urls = await Promise.all(['PACTWOVEN_MANDATE_TEST_ADMIN_URL_FILE', 'PACTWOVEN_MANDATE_TEST_WRITER_URL_FILE'].map(async name => {
      const file = process.env[name]; if (!file) throw new Error('Protected isolated mandate test credentials required.');
      const url = new URL((await readFile(file, 'utf8')).trim());
      if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.pathname !== '/pactwoven_mandate_b1b_test') throw new Error('Only task-owned mandate database allowed.');
      return url;
    }));
    if (urls[0]!.host !== urls[1]!.host || urls[1]!.username !== 'pactwoven_mandate_b1b_test_login') throw new Error('Dedicated mandate test login required.');
    admin = new Pool({ connectionString: urls[0]!.href }); writer = new Pool({ connectionString: urls[1]!.href });
    lock = await admin.connect(); await lock.query("SELECT pg_catalog.pg_advisory_lock(pg_catalog.hashtext('mandate_b1b_author_qualification'))");
    await admin.query('DROP SCHEMA IF EXISTS pactwoven CASCADE');
    for (const file of ['0001_foundation.sql', '0002_organization_bootstrap.sql', '0003_identity_access.sql', '0004_mandate_authority.sql']) {
      await admin.query(await readFile(new URL(`../../../packages/db/migrations/${file}`, import.meta.url), 'utf8'));
    }
    repository = new PostgresMandateRepository(writer, 'development');
  });
  beforeEach(async () => {
    await admin.query('TRUNCATE pactwoven.organizations,pactwoven.session_revocations CASCADE');
    await admin.query("INSERT INTO pactwoven.organizations(environment,id,external_organization_id,name,authority_epoch) VALUES('development','org_a','clerk_org_a','API test',0)");
    for (const [subject, role] of [['operations_a', 'operations'], ['finance_a', 'finance']]) {
      await admin.query("INSERT INTO pactwoven.memberships(environment,organization_id,actor_id,external_subject,external_membership_id,roles,grant_basis) VALUES('development','org_a',$1,$1,$2,$3,'internal')", [subject, `member_${subject}`, [role]]);
    }
    await admin.query("INSERT INTO pactwoven.sites(environment,organization_id,id,name,time_zone) VALUES('development','org_a','site_a','Site A','America/Chicago')");
    await admin.query("INSERT INTO pactwoven.site_memberships SELECT environment,organization_id,actor_id,'site_a' FROM pactwoven.memberships");
    await admin.query("INSERT INTO pactwoven.member_action_sites SELECT environment,organization_id,actor_id,'site_a' FROM pactwoven.memberships");
    await admin.query("INSERT INTO pactwoven.responsibilities(environment,organization_id,id,owner_id,site_id,title,description,starts_at,ends_at,time_zone,requirements,acceptance_policy,created_at,updated_at) VALUES('development','org_a','responsibility_a','operations_a','site_a','API event','',now(),now()+interval '1 day','America/Chicago','[]','Full acceptance text.',now()-interval '1 hour',now()-interval '1 hour')");
  });
  afterAll(async () => {
    await writer?.end();
    if (lock) { await lock.query("SELECT pg_catalog.pg_advisory_unlock(pg_catalog.hashtext('mandate_b1b_author_qualification'))"); lock.release(); }
    await admin?.end();
  });
  function appFixture() {
    const nonces: string[] = [], verifyIdentity = async (token: string) => identity(token);
    const verifyMandateStepUp = async (token: string, request: MandateVerificationRequest): Promise<VerifiedMandateStepUpIdentity> => {
      nonces.push(request.nonce);
      const actor = identity(token), issued = Math.floor(Date.now() / 1000) * 1000, purpose = request.intent.action === 'AUTHORIZE' ? 'mandate_authorization' : 'mandate_control';
      return { identity: actor, evidence: { id: crypto.randomUUID(), purpose, subject: actor.subject, externalOrganizationId: actor.externalOrganizationId, externalMembershipId: actor.externalMembershipId,
        sessionId: actor.sessionId, issuer: 'https://fixture.clerk.accounts.dev', tokenHash: 'a'.repeat(64), tokenIssuedAt: new Date(issued).toISOString(), firstFactorAgeMinutes: 0, secondFactorAgeMinutes: 0,
        verifiedAt: new Date(issued - 60_000).toISOString(), observedAt: new Date().toISOString(), expiresAt: new Date(issued + 180_000).toISOString(), intentHash: await mandateIntentHash(request.intent), requestNonce: request.nonce,
        requestHash: await commandDigest({ schemaVersion: 1, purpose, request }) } };
    };
    const directory = { resolve: async (_identity: VerifiedIdentity, membership: string, subject: string) => ({ externalOrganizationId: 'clerk_org_a', externalMembershipId: membership,
      externalSubject: subject, externalRole: 'org:member', displayName: 'Operations', observedAt: new Date().toISOString() }) };
    const app = createApp({ allowedOrigins: ['http://localhost:3001'], verifyIdentity, mandateGateway: createMandateGateway({ repository, verifyIdentity, verifyMandateStepUp, directory }) });
    async function request(path: string, actor = 'finance_a', body?: unknown, key = 'api_mandate_request_0001') {
      const response = await app.request(path, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${actor}`, Origin: 'http://localhost:3001', 'Content-Type': 'application/json', 'Idempotency-Key': key }, ...(body ? { body: JSON.stringify(body) } : {}) });
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      return { response, body: await response.json() };
    }
    return { request, nonces };
  }
  it('runs document/proposal/independent authorization/control/recovery through native HTTP routes', async () => {
    const f = appFixture(), base = '/v1/responsibilities/responsibility_a';
    const pageResult = await f.request(`${base}/mandates`); expect(pageResult.response.status).toBe(200);
    const page = MandatePageSchema.parse(pageResult.body), expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    const document = (id: string, purpose: 'ACCEPTANCE_POLICY' | 'MANDATE_POLICY', text: string) => CreateMandateDocumentRequestSchema.parse({ responsibility: page.responsibilityReference,
      expectedOrganizationEpoch: page.organizationEpoch, command: { documentId: id, expectedVersion: 0, previousVersion: null, purpose, text } });
    const first = await f.request(`${base}/mandate-policy-documents`, 'operations_a', document('acceptance_a', 'ACCEPTANCE_POLICY', 'Full acceptance text.'), 'api_acceptance_key_0001');
    expect(first.response.status).toBe(201); const { kind: _a, ...acceptancePolicy } = MandateOperationResultSchema.parse(first.body).target;
    const second = await f.request(`${base}/mandate-policy-documents`, 'operations_a', document('policy_a', 'MANDATE_POLICY', 'Full advice-only policy text.'), 'api_policy_key_0001');
    expect(second.response.status).toBe(201); const { kind: _b, ...policyDocument } = MandateOperationResultSchema.parse(second.body).target;
    const command: ProposeMandateCommand = { proposalId: 'proposal_a', mandateId: 'mandate_a', expectedProposalVersion: 0, previousProposal: null, responsibility: page.responsibilityReference, expectedOrganizationEpoch: 0,
      previousAcceptedVersion: null, expectedHead: null, policyDocument, expiresAt, policy: { mode: 'ADVISE', siteIds: ['site_a'], actions: [], budgets: [], supplierRelationshipIds: [], acceptancePolicy,
        communication: { recipientIds: [], purposes: [], messageKinds: [], maximumMessages: 0, expiresAt }, expiresAt } };
    const proposed = await f.request(`${base}/mandate-proposals`, 'operations_a', command, 'api_proposal_key_0001');
    expect(proposed.response.status).toBe(201); const { kind: _c, ...proposal } = MandateOperationResultSchema.parse(proposed.body).target;
    const intent: MandateDecisionIntent = { schemaVersion: 1, action: 'AUTHORIZE', proposal, expectedDecisionVersion: 1, expectedOrganizationEpoch: 0, expectedHead: null, reason: null };
    const approved = await f.request(`${base}/mandate-proposals/proposal_a/decision`, 'finance_a', intent, 'api_authorize_key_0001');
    expect(approved.response.status).toBe(200);
    for (const action of ['PAUSE', 'RESUME', 'REVOKE'] as const) {
      const review = MandateReviewSchema.parse((await f.request(`${base}/mandates/proposal_a?version=1`)).body);
      const control: MandateAuthorityIntent = { schemaVersion: 1, action, mandate: await mandateVersionReference(review.envelope.acceptedVersion!), head: await mandateHeadReference(review.envelope.head!),
        responsibility: review.envelope.responsibilityReference, expectedOrganizationEpoch: 0, reason: 'API authority review' };
      expect((await f.request(`${base}/mandates/mandate_a/authority`, 'finance_a', control, `api_${action.toLowerCase()}_key_0001`)).response.status).toBe(200);
    }
    expect(f.nonces).toHaveLength(2); expect(new Set(f.nonces).size).toBe(2);
    const recovered = await f.request('/v1/mandate-operations?kind=mandate.authorize&key=api_authorize_key_0001'); expect(recovered.response.status).toBe(200); expect(recovered.body).toEqual(approved.body);
    expect((await admin.query('SELECT count(*)::int AS n FROM pactwoven.mandate_operations')).rows[0].n).toBe(7);
    expect((await admin.query('SELECT count(*)::int AS n FROM pactwoven.mandate_outbox')).rows[0].n).toBe(7);
    expect((await admin.query('SELECT count(*)::int AS n FROM pactwoven.outbox_events')).rows[0].n).toBe(0);
  });
  it('rejects invalid identity and public evidence before persistent mutation', async () => {
    const f = appFixture();
    expect((await f.request('/v1/responsibilities/responsibility_a/mandates', 'forged_token')).response.status).toBe(401);
    expect((await f.request('/v1/responsibilities/responsibility_a/mandate-proposals/proposal_a/decision', 'finance_a', { evidence: { purpose: 'mandate_authorization' }, actorId: 'owner' })).response.status).toBe(422);
    expect((await admin.query('SELECT count(*)::int AS n FROM pactwoven.mandate_operations')).rows[0].n).toBe(0);
  });
});
