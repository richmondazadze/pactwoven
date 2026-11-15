import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FinancialPolicyHttpRecordResponseSchema } from '@pactwoven/contracts';
import { FinancialPolicyReview, financialPolicyVersionPath } from './financial-policy-review';

const hash = 'a'.repeat(64), at = '2026-11-15T00:00:00.000Z';
function documentResponse(text = 'First line.\n<script>literal policy text</script>') {
  return FinancialPolicyHttpRecordResponseSchema.parse({ schemaVersion: 1, scope: { environment: 'development', organizationId: 'org_a',
    actor: { actorId: 'owner_a', membershipVersion: 5 }, organizationEpoch: 2, roles: ['owner'], siteIds: [], actionSiteIds: [] },
    observation: { observedAt: at, expiresAt: '2026-11-15T00:00:20.000Z' }, effectiveAuthority: false, financialState: null, responsibilityId: null,
    policy: { reference: { id: 'document_a', version: 1, recordHash: hash }, record: { schemaVersion: 1, environment: 'development', organizationId: 'org_a',
      id: 'document_a', version: 1, predecessor: null, actor: { actorId: 'owner_a', membershipVersion: 1 }, organizationEpoch: 2,
      operationId: '00000000-0000-0000-0000-000000000001', createdAt: at, kind: 'document', responsibilityId: null, purpose: 'budget_policy', text, contentHash: hash },
      projection: { currentRecord: true, state: 'DOCUMENT', blockers: [] }, budgetConfiguration: null }, documents: [], actions: [] });
}
describe('financial policy exact review server rendering', () => {
  it('renders complete escaped terms, exact version and historical actor membership', () => {
    const html = renderToStaticMarkup(createElement(FinancialPolicyReview, { response: documentResponse() }));
    expect(html).toContain('First line.\n&lt;script&gt;literal policy text&lt;/script&gt;'); expect(html).not.toContain('<script>');
    expect(html).toContain('document_a'); expect(html).toContain('membership version 1'); expect(html).toContain('Current record version at this observation');
    expect(html).toContain('It does not authorize spending or make funds available.');
  });
  it('does not truncate long supported policy text or put it inside a transient dialog', () => {
    const text = '🧵'.repeat(20_000), html = renderToStaticMarkup(createElement(FinancialPolicyReview, { response: documentResponse(text) }));
    expect(html).toContain(text); expect(html).not.toMatch(/role="dialog"|aria-modal|text-overflow/);
  });
  it('constructs exact-version full routes independently of current state', () => {
    expect(financialPolicyVersionPath(null, { id: 'policy_a', version: 2 })).toBe('/app/organization/financial-policies/policy_a/versions/2');
    expect(financialPolicyVersionPath('responsibility_a', { id: 'draft_a', version: 7 })).toBe('/app/responsibilities/responsibility_a/financial-policies/draft_a/versions/7');
  });
  it('labels historical records separately and exposes no configuration mutation buttons', () => {
    const response = documentResponse(); response.policy.projection = { currentRecord: false, state: 'SUPERSEDED', blockers: [] };
    const html = renderToStaticMarkup(createElement(FinancialPolicyReview, { response }));
    expect(html).toContain('Historical record version'); expect(html).not.toContain('<button');
  });
});
