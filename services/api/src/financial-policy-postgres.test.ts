import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FinancialPolicyHttpContextSchema, FinancialPolicyHttpRecordResponseSchema, FinancialPolicyHttpRecoveryResponseSchema,
  type FinancialPolicyCommand, type FinancialPolicyResult } from '@pactwoven/contracts';
import { financialPolicyHttpRequestFromStoredCommand, financialPolicyHttpRequestHash } from '@pactwoven/domain';
import { financialPolicyReadFixture, financialPolicyReadFixtureEnabled, type FinancialPolicyReadFixture }
  from '../../../packages/db/src/financial-policy-read.test-support.js';
import { createFinancialPolicyApiVerifier } from './financial-policy-verifier.js';
import { createFinancialPolicyGateway } from './financial-policy-service.js';
import { createApp } from './app.js';

// Actual disposable PostgreSQL capabilities with an explicitly synthetic private
// identity adapter. These tests do not qualify Clerk or a live user session.
const issuer = 'https://synthetic.invalid', origin = 'http://localhost:3001';
const responsibility = '/v1/responsibilities/responsibility_a';
const tokens = new Map(['owner_a', 'owner_b', 'finance_a', 'operations_a'].map(actor => [`financial-postgres-${actor}`, actor]));
const counts = async (f: FinancialPolicyReadFixture) => (await f.admin.query(`SELECT
  (SELECT count(*) FROM pactwoven.financial_policy_operations) AS operations,
  (SELECT count(*) FROM pactwoven.financial_policy_records) AS records,
  (SELECT count(*) FROM pactwoven.financial_policy_audit) AS audit,
  (SELECT count(*) FROM pactwoven.financial_policy_outbox) AS outbox,
  (SELECT count(*) FROM pactwoven.financial_governance_controls) AS controls,
  (SELECT count(*) FROM pactwoven.financial_authority_fences WHERE family<>'none') AS heads`)).rows[0];

describe.skipIf(!financialPolicyReadFixtureEnabled)('financial read API with actual private PostgreSQL capabilities', () => {
  let f: FinancialPolicyReadFixture;
  beforeEach(async () => { f = await financialPolicyReadFixture(); }, 30_000);
  afterEach(async () => { await f?.close(); });
  function app() {
    const verifier = createFinancialPolicyApiVerifier({ environment: 'development', issuer,
      async observe(token) {
        const actor = tokens.get(token); if (!actor) throw new Error('Unknown synthetic actor.');
        const now = Date.now(), observedAt = new Date(now).toISOString(), tokenIssuedAt = new Date(now - 1000).toISOString();
        return { identity: { subject: actor, externalOrganizationId: 'clerk_org_a', externalOrganizationName: 'Synthetic policy fixture',
          externalMembershipId: `membership_${actor}`, externalRole: 'org:member', sessionId: `session_${actor}`,
          membershipObservedAt: observedAt, authenticatedAt: tokenIssuedAt },
          observation: { issuer, tokenHash: createHash('sha256').update(token).digest('hex'), tokenIssuedAt, observedAt,
            expiresAt: new Date(now + 240_000).toISOString() } };
      } });
    return createApp({ allowedOrigins: [origin], financialPolicyGateway: createFinancialPolicyGateway({
      environment: 'development', issuer, verifier, readers: f.readers, repository: f.repository, authentication: f.authentication,
    }) });
  }
  async function request(path: string, actor = 'owner_a') {
    const response = await app().request(path, { headers: { Origin: origin, Authorization: `Bearer financial-postgres-${actor}` } });
    return { response, body: await response.json() };
  }
  async function originalPath(command: FinancialPolicyCommand, result: FinancialPolicyResult) {
    const scope = { environment: 'development' as const, organizationId: 'org_a', actorId: result.actorId };
    const publicRequest = await financialPolicyHttpRequestFromStoredCommand(scope, command);
    const hash = await financialPolicyHttpRequestHash(scope, publicRequest);
    const base = result.responsibilityId === null ? '/v1/financial-governance/operations' : `${responsibility}/financial-policy-operations`;
    return `${base}/${command.key}?kind=${command.kind}&targetId=${result.body.id}&requestHash=${hash}`;
  }
  it('returns role-limited current context and indexes while only appending read identity observations', async () => {
    const draft = await f.draft(), proposal = await f.governance();
    const before = await counts(f);
    const organization = await request(`/v1/financial-governance/context?assetKey=${f.assetPin.key}`, 'finance_a');
    expect(organization.response.status).toBe(200);
    expect(FinancialPolicyHttpContextSchema.parse(organization.body)).toMatchObject({ kind: 'organization',
      configurationVisibility: 'full', asset: { pin: f.assetPin }, effectiveAuthority: false, financialState: null, documents: [], actions: [] });
    const operations = await request(`${responsibility}/financial-policies/context?assetKey=${f.assetPin.key}`, 'operations_a');
    expect(operations.response.status).toBe(200);
    expect(FinancialPolicyHttpContextSchema.parse(operations.body)).toMatchObject({ kind: 'responsibility',
      configurationVisibility: 'references_only', acceptedConfiguration: null, periods: [], documents: [], actions: [] });
    const drafts = await request(`${responsibility}/financial-policies?limit=1`, 'operations_a');
    expect(drafts.response.status).toBe(200); expect(drafts.body.items[0].policy.reference).toEqual(draft.result.target);
    const governance = await request('/v1/financial-governance?limit=1', 'finance_a');
    expect(governance.response.status).toBe(200); expect(governance.body.items[0].policy.reference).toEqual(proposal.result.target);
    expect(await counts(f)).toEqual(before);
    expect(organization.response.headers.get('cache-control')).toBe('private, no-store');
    expect(operations.response.headers.get('referrer-policy')).toBe('no-referrer');
  });
  it('hydrates the exact historical document references for draft and governance review', async () => {
    const draft = await f.draft(), proposal = await f.governance();
    const document = draft.document;
    if (document.command.kind !== 'save_document') throw new Error('Document fixture required.');
    await f.repository.mutate((await f.identity('operations_a')).id, { ...document.command, previous: document.result.target,
      key: `revised_${crypto.randomUUID()}`, text: 'A later synthetic document version.' });
    const before = await counts(f);
    const detail = await request(`${responsibility}/financial-policies/${draft.result.body.id}/versions/1`, 'operations_a');
    expect(detail.response.status).toBe(200);
    const parsed = FinancialPolicyHttpRecordResponseSchema.parse(detail.body);
    expect(parsed.policy.reference).toEqual(draft.result.target);
    expect(parsed.documents.map(value => value.reference)).toEqual([document.result.target]);
    expect(parsed.documents[0]?.record.text).toBe(document.command.text);
    const governance = await request(`/v1/financial-governance/${proposal.result.body.id}/versions/1`, 'finance_a');
    expect(governance.response.status).toBe(200);
    const reviewed = FinancialPolicyHttpRecordResponseSchema.parse(governance.body);
    expect(reviewed.policy).toMatchObject({ budgetConfiguration: { status: 'unavailable', control: null, currentBudgetConfiguration: null } });
    expect(reviewed.documents.map(value => value.reference).sort((a, b) => a.id.localeCompare(b.id)))
      .toEqual([proposal.budget.result.target, proposal.approval.result.target].sort((a, b) => a.id.localeCompare(b.id)));
    expect(await counts(f)).toEqual(before);
  });
  it('recovers the original recorded browser intent without creating new policy effects', async () => {
    const document = await f.saveDocument('budget_policy'), draft = await f.draft(), proposal = await f.governance();
    const before = await counts(f);
    for (const original of [document, draft, proposal]) {
      const path = await originalPath(original.command, original.result), received = await request(path, original.result.actorId);
      expect(received.response.status).toBe(200);
      const recovered = FinancialPolicyHttpRecoveryResponseSchema.parse(received.body);
      expect(recovered.status).toBe('recorded');
      expect(recovered.receipt).toMatchObject({ operationId: original.result.id, target: original.result.target,
        actor: { actorId: original.result.actorId }, effectiveAuthority: false, financialState: null });
      const wrongDigest = await request(path.replace(/requestHash=[a-f0-9]+$/, 'requestHash=' + 'f'.repeat(64)), original.result.actorId);
      expect(wrongDigest.response.status).toBe(503); expect(wrongDigest.body.error.code).toBe('FINANCIAL_POLICY_OUTCOME_UNKNOWN');
    }
    const missing = await request('/v1/financial-governance/operations/missing_original_0001?kind=save_document&targetId=missing&requestHash=' + 'a'.repeat(64));
    expect(missing.response.status).toBe(200); expect(missing.body).toMatchObject({ status: 'not_recorded', receipt: null });
    expect(await counts(f)).toEqual(before);
  });
  it('blocks Operations organization disclosure and preserves read-only policy state', async () => {
    const proposal = await f.governance(), before = await counts(f);
    for (const path of ['/v1/financial-governance/context', '/v1/financial-governance',
      `/v1/financial-governance/${proposal.result.body.id}/versions/1`,
      `/v1/financial-governance/documents/${proposal.budget.result.body.id}/versions/1`]) {
      const value = await request(path, 'operations_a');
      expect(value.response.status).toBe(403); expect(value.body.error.code).toBe('FINANCIAL_POLICY_ACCESS_DENIED');
    }
    const absent = await request(`${responsibility}/financial-policies/absent/versions/1`, 'operations_a');
    expect(absent.response.status).toBe(404); expect(await counts(f)).toEqual(before);
  });
});
