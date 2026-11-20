import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { FinancialPolicyDraftEditor, resolveFinancialPolicyLocalTime, reviewFinancialPolicyDraft } from './financial-policy-draft-editor';
const hash = 'a'.repeat(64), scope = { authority: { schemaVersion: 1 as const, responsibility: { id: 'responsibility_a', version: 1, hash, siteId: 'site_a' },
  generation: 0, family: 'none' as const, legacyHead: null }, authorityHash: hash, site: { id: 'site_a', generation: 0, recordHash: hash } };
const document = { id: 'mandate_doc', version: 1, recordHash: hash };
describe('exact incomplete-draft time boundaries', () => {
  it('resolves the stated zone and exact UTC boundary without a browser-local assumption', () => {
    expect(resolveFinancialPolicyLocalTime('2026-11-15T09:30', 'America/Chicago', 'draft-start')).toBe('2026-11-15T15:30:00.000Z');
    expect(resolveFinancialPolicyLocalTime('2026-11-15T09:30:14', 'Asia/Kathmandu', 'draft-start')).toBe('2026-11-15T03:45:14.000Z');
    expect(resolveFinancialPolicyLocalTime('0001-01-01T00:00', 'UTC', 'draft-start')).toBe('0001-01-01T00:00:00.000Z');
  });
  it.each(['2026-03-08T02:30', '2026-11-01T01:30'])('rejects daylight-saving gap/overlap %s', input => {
    expect(() => resolveFinancialPolicyLocalTime(input, 'America/Chicago', 'draft-start')).toThrow();
  });
  it.each(['2026-02-30T12:00', '2026-01-01T24:00', '0000-01-01T00:00', '2026-01-01', '2026-01-01T12:00Z', '2026-01-01T12:00\n'])('rejects impossible or non-exact local input %s', input => {
    expect(() => resolveFinancialPolicyLocalTime(input, 'UTC', 'draft-start')).toThrow();
  });
  it.each(['unknown_zone', 'UTC\n', ''])('rejects unavailable or malformed source zone %s', zone => {
    expect(() => resolveFinancialPolicyLocalTime('2026-01-01T12:00', zone, 'draft-start')).toThrow();
  });
  it('allows a past start with future expiry, and fixes every unsupported field to null', () => {
    const reviewed = reviewFinancialPolicyDraft({ startsLocal: '2026-11-14T00:00', expiresLocal: '2026-11-16T00:00', timeZone: 'UTC' }, scope, document, Date.parse('2026-11-15T00:00Z'));
    expect(reviewed.draft).toMatchObject({ asset: null, account: null, governance: null, trust: null, startsAt: '2026-11-14T00:00:00.000Z', documents: [{ ...document, purpose: 'financial_mandate' }] });
    expect(reviewed.draft.terms.communication).toEqual({ recipients: [], purposes: [], kinds: [], allowanceBaseUnits: '0' });
    expect(() => reviewFinancialPolicyDraft({ startsLocal: '2026-11-14T00:00', expiresLocal: '2026-11-15T00:00', timeZone: 'UTC' }, scope, document, Date.parse('2026-11-15T00:00Z'))).toThrow();
    expect(() => reviewFinancialPolicyDraft({ startsLocal: '2026-11-16T00:00', expiresLocal: '2026-11-16T00:00', timeZone: 'UTC' }, scope, document, 0)).toThrow();
  });
  it('shows exact entered and resolved dates, with explicit review and no automatic save', () => {
    const dates = { startsLocal: '2026-11-15T09:30', expiresLocal: '2026-11-16T09:30', timeZone: 'America/Chicago' }, reviewed = reviewFinancialPolicyDraft(dates, scope, document, Date.parse('2026-11-15T00:00Z'));
    const onChange = vi.fn(), onReview = vi.fn(), html = renderToStaticMarkup(createElement(FinancialPolicyDraftEditor, { dates, reviewed, disabled: false, error: null, onChange, onReview }));
    expect(html).toContain('America/Chicago'); expect(html).toContain('2026-11-15T15:30:00.000Z'); expect(html).toContain('2026-11-16T15:30:00.000Z');
    expect(html).toContain('Asset, account, governance and trust are absent'); expect(onChange).not.toHaveBeenCalled(); expect(onReview).not.toHaveBeenCalled();
  });
});
