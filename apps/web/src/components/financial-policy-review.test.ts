import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FinancialPolicyHttpRecordResponseSchema, FinancialPolicyHttpDocumentViewSchema, FinancialPolicyHttpReceiptSchema } from '@pactwoven/contracts';
import { FinancialPolicyReview, FinancialPolicyDocumentText, FinancialPolicyReceiptReview, financialPolicyVersionPath } from './financial-policy-review';

const hash = 'a'.repeat(64), at = '2026-11-15T00:00:00.000Z';
function documentResponse(text = 'First line.\n<script>literal policy text</script>', responsibilityId: string | null = null, version = 1) {
  return FinancialPolicyHttpRecordResponseSchema.parse({ schemaVersion: 1, scope: { environment: 'development', organizationId: 'org_a',
    actor: { actorId: 'owner_a', membershipVersion: 5 }, organizationEpoch: 2, roles: ['owner'], siteIds: [], actionSiteIds: [] },
    observation: { observedAt: at, expiresAt: '2026-11-15T00:00:20.000Z' }, effectiveAuthority: false, financialState: null, responsibilityId,
    policy: { reference: { id: 'document_a', version, recordHash: hash }, record: { schemaVersion: 1, environment: 'development', organizationId: 'org_a',
      id: 'document_a', version, predecessor: version === 1 ? null : { id: 'document_a', version: version - 1, recordHash: hash }, actor: { actorId: 'owner_a', membershipVersion: 1 }, organizationEpoch: 2,
      operationId: '00000000-0000-0000-0000-000000000001', createdAt: at, kind: 'document', responsibilityId, purpose: responsibilityId === null ? 'budget_policy' : 'financial_mandate', text, contentHash: hash },
      projection: { currentRecord: true, state: 'DOCUMENT', blockers: [] }, budgetConfiguration: null }, documents: [], actions: [] });
}
function documentSurface(surface: 'record' | 'reference' | 'receipt', responsibilityId: string | null) {
  const response = documentResponse('Historical <policy> text stays complete.', responsibilityId, 3);
  response.policy.projection = { currentRecord: false, state: 'SUPERSEDED', blockers: [] };
  const document = FinancialPolicyHttpDocumentViewSchema.parse(response.policy), record = document.record;
  const receipt = FinancialPolicyHttpReceiptSchema.parse({ schemaVersion: 1, environment: record.environment, organizationId: record.organizationId,
    actor: record.actor, responsibilityId, operationId: record.operationId, kind: 'save_document', key: 'document_original_1', publicRequestHash: hash,
    target: document.reference, record, effectiveAuthority: false, financialState: null });
  return surface === 'record' ? createElement(FinancialPolicyReview, { response }) : surface === 'reference'
    ? createElement(FinancialPolicyDocumentText, { document }) : createElement(FinancialPolicyReceiptReview, { receipt });
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
  it.each(['record', 'reference', 'receipt'] as const)('links the exact historical responsibility document from the %s surface', surface => {
    const html = renderToStaticMarkup(documentSurface(surface, 'responsibility_a'));
    expect(html).toContain('href="/app/responsibilities/responsibility_a/financial-policies/document_a/versions/3/revise?kind=document"');
    expect(html).toContain('Check policy text revision'); expect(html).toContain('button secondary');
    expect(html).toContain('Historical &lt;policy&gt; text stays complete.');
    expect(html).not.toContain('/versions/2/revise'); expect(html).not.toContain('kind=draft'); expect(html).not.toContain('<button');
  });
  it.each(['record', 'reference', 'receipt'] as const)('keeps organization document %s review outside responsibility revision navigation', surface => {
    const html = renderToStaticMarkup(documentSurface(surface, null));
    expect(html).toContain('Historical &lt;policy&gt; text stays complete.');
    expect(html).not.toContain('/revise'); expect(html).not.toContain('Check policy text revision');
  });
  it('preserves the existing exact-version link for an incomplete draft receipt', () => {
    const document = FinancialPolicyHttpDocumentViewSchema.parse(documentResponse('Mandate terms', 'responsibility_a').policy);
    const { kind: _kind, purpose: _purpose, text: _text, contentHash: _contentHash, ...common } = document.record;
    const record = { ...common, id: 'draft_a', kind: 'draft', state: 'DRAFT', requester: common.actor,
      draft: { scope: { authority: { schemaVersion: 1, responsibility: { id: 'responsibility_a', version: 1, hash, siteId: 'site_a' }, generation: 0, family: 'none', legacyHead: null },
        authorityHash: hash, site: { id: 'site_a', generation: 0, recordHash: hash } },
        terms: { mode: 'PREPARE_FOR_APPROVAL', actions: ['allocate_funds'], category: 'supplier_principal', allocation: 'responsibility_earmark',
          supplier: null, acceptedTerms: null, payee: null, tool: null, withdrawal: null, branch: null, communication: { recipients: [], purposes: [], kinds: [], allowanceBaseUnits: '0' } },
        documents: [{ ...document.reference, purpose: 'financial_mandate' }], asset: null, account: null, governance: null, trust: null,
        startsAt: at, expiresAt: '2026-11-16T00:00:00.000Z' } };
    const receipt = FinancialPolicyHttpReceiptSchema.parse({ schemaVersion: 1, environment: record.environment, organizationId: record.organizationId,
      actor: record.actor, responsibilityId: record.responsibilityId, operationId: record.operationId, kind: 'save_draft', key: 'draft_original_01', publicRequestHash: hash,
      target: { id: 'draft_a', version: 1, recordHash: hash }, record, effectiveAuthority: false, financialState: null });
    const html = renderToStaticMarkup(createElement(FinancialPolicyReceiptReview, { receipt }));
    expect(html).toContain('href="/app/responsibilities/responsibility_a/financial-policies/draft_a/versions/1"');
    expect(html).toContain('Read exact recorded version'); expect(html).not.toContain('/revise'); expect(html).not.toContain('kind=document');
  });
});
