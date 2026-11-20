import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { MemberAccess, Session } from '@pactwoven/contracts';
import { accessScopeOf, buildAccessIntent } from '../lib/access-review';
import { AccessScopeFacts, MemberAccessReview, ReadOnlyMemberReview } from './member-access-review';
const member: MemberAccess = { actorId: 'member_private', externalSubject: 'subject_private', externalMembershipId: 'membership_private', displayName: 'Jordan Chen', version: 12, status: 'active', roles: ['receiver'], siteIds: ['site_read'], actionSiteIds: ['site_action'], expiresAt: '2026-12-01T00:00:00Z' };
const sites: Session['sites'] = [{ id: 'site_read', name: 'Receiving office', timeZone: 'UTC' }, { id: 'site_action', name: 'Warehouse', timeZone: 'UTC' }];
const withoutDetails = (html: string) => html.replace(/<details\b[^>]*>[\s\S]*?<\/details>/g, '');
describe('member presentation and exact approval material', () => {
  it('keeps readable scope and expiry outside provenance while preserving references', () => {
    const html = renderToStaticMarkup(createElement(ReadOnlyMemberReview, { member, sites })), main = withoutDetails(html);
    for (const text of ['Jordan Chen', 'Receiving', 'Receiving office', 'Warehouse', member.expiresAt!]) expect(main).toContain(text);
    for (const ref of [member.actorId, member.externalSubject, member.externalMembershipId, 'site_read', 'site_action']) { expect(main).not.toContain(ref); expect(html).toContain(ref); }
    expect(html).toContain('<summary>Member record verification'); expect(html).not.toMatch(/<(details|dl)[^>]*aria-hidden/);
  });
  it('keeps the exact recipient identity visible at the access-change decision', () => {
    const intent = buildAccessIntent({ kind: 'revise', member }, { ...accessScopeOf(member), roles: ['finance'] }, '', 8);
    const html = renderToStaticMarkup(createElement(MemberAccessReview, { selection: { kind: 'revise', member }, intent, sites }));
    const main = withoutDetails(html);
    for (const text of ['Jordan Chen', 'subject_private', 'Before', 'After', 'Finance', 'Warehouse', member.expiresAt!]) expect(main).toContain(text);
    expect(main).not.toContain('Organization authority epoch'); expect(html).toContain('Organization authority epoch'); expect(html).not.toContain('<button');
  });
  it('keeps references visible for unknown and duplicate site names', () => {
    const html = renderToStaticMarkup(createElement(AccessScopeFacts, { scope: { ...member, actionSiteIds: ['unknown_site', 'site_read', 'site_action'] }, sites: sites.map(site => ({ ...site, name: 'Warehouse' })) }));
    const main = withoutDetails(html);
    for (const ref of ['unknown_site', 'site_read', 'site_action']) expect(main).toContain(ref);
    expect(main).toContain('Site name unavailable');
  });
  it('keeps revoked and suspended truth in the primary review', () => {
    for (const status of ['revoked', 'suspended'] as const) {
      const main = withoutDetails(renderToStaticMarkup(createElement(ReadOnlyMemberReview, { member: { ...member, status }, sites })));
      expect(main).toContain(status === 'revoked' ? 'None from this revoked grant' : 'do not prove active access');
    }
  });
});
