import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FinancialPolicyPreparationResponseSchema } from '@pactwoven/contracts';
import { FinancialPolicyPreparationReview } from './financial-policy-preparation-review';
const hash = 'a'.repeat(64);
function response() {
  return { schemaVersion: 1, responsibilityId: 'responsibility_a', scope: { environment: 'development', organizationId: 'org_a', actor: { actorId: 'actor_a', membershipVersion: 9 }, organizationEpoch: 2, roles: ['owner'], siteIds: ['site_a'], actionSiteIds: ['site_a'] },
    observation: { observedAt: '2026-11-15T00:00:00.000Z', expiresAt: '2026-11-15T00:00:20.000Z' }, effectiveAuthority: false, financialState: null,
    selection: { schemaVersion: 1, action: 'save_document', targetId: 'mandate_doc', previous: null, purpose: 'financial_mandate' },
    decision: { action: 'save_document', state: 'reviewable', reasons: [], requiredAuthentication: null },
    target: { state: 'absent', latestReference: null, record: null, historicalDocuments: [] },
    material: { action: 'save_document', purpose: 'financial_mandate', organizationEpoch: 2, draftScope: { authority: { schemaVersion: 1, responsibility: { id: 'responsibility_a', version: 1, hash, siteId: 'site_a' }, generation: 0, family: 'none', legacyHead: null }, authorityHash: hash, site: { id: 'site_a', generation: 0, recordHash: hash } }, siteActive: true },
    configurationWarnings: ['FINANCIAL_AUTHORITY_UNAVAILABLE', 'TRUST_UNAVAILABLE'] };
}
describe('preparation-specific review meaning', () => {
  it('renders exact target and basis without offering save permission or a synthetic read response', () => {
    const html = renderToStaticMarkup(createElement(FinancialPolicyPreparationReview, { response: FinancialPolicyPreparationResponseSchema.parse(response()) }));
    expect(html).toContain('mandate_doc'); expect(html).toContain(hash); expect(html).toContain('Reviewable');
    expect(html).toContain('creates no policy record'); expect(html).not.toContain('<button'); expect(html).toContain('No spending authority');
  });
  it('keeps changed and opaque target outcomes distinct and never substitutes a latest version', () => {
    const changed = { ...response(), target: { state: 'changed', latestReference: { id: 'mandate_doc', version: 3, recordHash: hash }, record: null, historicalDocuments: [] },
      decision: { action: 'save_document', state: 'blocked', reasons: ['PREDECESSOR_CHANGED'], requiredAuthentication: null } };
    const html = renderToStaticMarkup(createElement(FinancialPolicyPreparationReview, { response: FinancialPolicyPreparationResponseSchema.parse(changed) }));
    expect(html).toContain('version 3'); expect(html).toContain('No latest version has been substituted');
    const opaque = { ...response(), target: { state: 'unavailable', latestReference: null, record: null, historicalDocuments: [] }, decision: { action: 'save_document', state: 'blocked', reasons: ['TARGET_UNAVAILABLE'], requiredAuthentication: null } };
    const hidden = renderToStaticMarkup(createElement(FinancialPolicyPreparationReview, { response: FinancialPolicyPreparationResponseSchema.parse(opaque) }));
    expect(hidden).toContain('No target information'); expect(hidden).not.toContain('version 3');
  });
});
