import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SessionSchema, type MemberAccess, type MemberCandidate } from '@pactwoven/contracts';
import { AccessScopeFacts, MemberAccessReview, RevokedMemberReview } from '../components/member-access-review';
import { accessFailureKind, accessScopeOf, buildAccessIntent, canCreateResponsibility, effectiveReadingDescription, isAccessOwner } from './access-review';
import { RequestError } from './api';
const session=SessionSchema.parse({actor:{actorId:'owner_one',principalKind:'human',organizationId:'org_one',environment:'development',roles:['owner'],siteIds:['site_read'],actionSiteIds:[],sessionId:'session_test',authenticatedAt:'2026-11-15T00:00:00Z',correlationId:'test_correlation'},organization:{id:'org_one',name:'Test organization',authorityEpoch:8},sites:[{id:'site_read',name:'Read site',timeZone:'UTC'},{id:'site_action',name:'Action site',timeZone:'UTC'}]});
const member:MemberAccess={actorId:'member_one',externalMembershipId:'membership_one',externalSubject:'subject_one',displayName:'Existing member',status:'active',version:3,roles:['receiver'],siteIds:['site_read'],actionSiteIds:[],expiresAt:null};
const candidate:MemberCandidate={externalOrganizationId:'provider_org',externalMembershipId:'membership_two',externalSubject:'subject_two',displayName:'New app member',externalRole:'org:member',observedAt:'2026-11-15T00:00:00Z'};
describe('member access review boundaries',()=>{
  it('does not infer create permission from owner/operations labels or readable sites',()=>{
    expect(canCreateResponsibility(session)).toBe(false);
    expect(canCreateResponsibility({...session,actor:{...session.actor,actionSiteIds:['site_missing']}})).toBe(false);
    expect(canCreateResponsibility({...session,actor:{...session.actor,actionSiteIds:['site_action']}})).toBe(true);
    expect(canCreateResponsibility({...session,actor:{...session.actor,roles:['auditor'],actionSiteIds:['site_action']}})).toBe(false);
    expect(canCreateResponsibility({...session,actor:{...session.actor,principalKind:'service',actionSiteIds:['site_action']}})).toBe(false);
  });
  it('requires human owner for member management and explicit actionSiteIds in actor fixtures',()=>{
    expect(isAccessOwner(session)).toBe(true);
    expect(isAccessOwner({...session,actor:{...session.actor,roles:['finance']}})).toBe(false);
    const {actionSiteIds:_,...withoutActions}=session.actor;expect(SessionSchema.safeParse({...session,actor:withoutActions}).success).toBe(false);
  });
  it('requires an explicit role and discloses organization-wide auditor reading even with empty assigned sites',()=>{
    expect(()=>buildAccessIntent({kind:'grant',candidate},{roles:[],siteIds:[],actionSiteIds:[],expiresAt:null},'',8)).toThrow();
    for(const role of ['owner','finance','auditor'] as const) {
      const scope={roles:[role],siteIds:[],actionSiteIds:[],expiresAt:null};
      expect(effectiveReadingDescription(scope)).toContain('All organization sites');
      const html=renderToStaticMarkup(createElement(AccessScopeFacts,{scope,sites:session.sites}));
      expect(html).toContain('Effective reading scope');expect(html).toContain('All organization sites');expect(html).toContain('Action sites');
    }
    expect(effectiveReadingDescription({roles:['receiver']})).toContain('assigned responsibilities');
  });
  it('pins a new grant to both existing provider identities and expected version zero',()=>{
    const intent=buildAccessIntent({kind:'grant',candidate},{roles:['operations'],siteIds:['site_read'],actionSiteIds:['site_read'],expiresAt:null},'',8);
    expect(intent.path).toBe('/v1/members/grant');
    expect(intent.command).toEqual({expectedVersion:0,mandateVersion:null,authorityEpoch:8,payload:{roles:['operations'],siteIds:['site_read'],actionSiteIds:['site_read'],expiresAt:null,externalMembershipId:'membership_two',externalSubject:'subject_two'}});
    expect(JSON.stringify(intent.command)).not.toContain('displayName');
  });
  it('binds revisions/revocations to the observed member version and epoch',()=>{
    const scope={roles:['finance'] as const,siteIds:[],actionSiteIds:['site_action'],expiresAt:'2026-12-01T00:00:00Z'};
    const revise=buildAccessIntent({kind:'revise',member},{...scope,roles:[...scope.roles]},'',8);
    expect(revise).toMatchObject({path:'/v1/members/member_one/revise-access',command:{expectedVersion:3,authorityEpoch:8,mandateVersion:null}});
    const revoke=buildAccessIntent({kind:'revoke',member},member,'Leaving the project',8);
    expect(revoke).toMatchObject({path:'/v1/members/member_one/revoke',command:{expectedVersion:3,payload:{reason:'Leaving the project'}}});
  });
  it('renders full before/after sites, identity and exact expiry without an action control',()=>{
    const intent=buildAccessIntent({kind:'revise',member},{...accessScopeOf(member),roles:['finance'],actionSiteIds:['site_action'],expiresAt:'2026-12-01T00:00:00Z'},'',8);
    const html=renderToStaticMarkup(createElement(MemberAccessReview,{selection:{kind:'revise',member},intent,sites:session.sites}));
    for(const value of ['Before','After','subject_one','membership_one','Assigned read sites','Action sites','site_read','site_action','2026-12-01T00:00:00Z','Expected member version','Organization authority epoch'])expect(html).toContain(value);
    expect(html).not.toContain('<button');expect(html).not.toContain('<form');
  });
  it('preserves unknown site identity instead of assigning a different known site name',()=>{
    const html=renderToStaticMarkup(createElement(AccessScopeFacts,{scope:{...member,actionSiteIds:['unavailable_site']},sites:session.sites}));
    expect(html).toContain('unavailable_site');expect(html).toContain('Site name unavailable');
  });
  it('keeps revoked-grant inspection read-only without claiming authority from retained roles or sites',()=>{
    const revoked={...member,status:'revoked' as const,roles:['finance' as const],actionSiteIds:['site_action']};
    const html=renderToStaticMarkup(createElement(RevokedMemberReview,{member:revoked,sites:session.sites}));
    for(const text of ['Revoked access is read-only','cannot be revised or restored in this flow','subject_one','membership_one','Recorded roles','finance','Recorded action sites','site_action','None from this revoked grant'])expect(html).toContain(text);
    for(const forbidden of ['<form','<input','<button','Verify identity','Submit access change','All organization sites'])expect(html).not.toContain(forbidden);
    for(const kind of ['revise','revoke'] as const)expect(()=>buildAccessIntent({kind,member:revoked},accessScopeOf(revoked),'Already revoked',8)).toThrow('cannot be revised or restored');
  });
  it('separates definite step-up/rejection from ambiguous transport/service outcomes',()=>{
    expect(accessFailureKind(new RequestError('STEP_UP_REQUIRED','Verify again',403))).toBe('step-up');
    expect(accessFailureKind(new RequestError('VERSION_CONFLICT','Changed member',409))).toBe('rejected');
    expect(accessFailureKind(new RequestError('FORBIDDEN','Revoked access',403))).toBe('rejected');
    for(const error of [new RequestError('IDENTITY_UNAVAILABLE','Unavailable',503),new RequestError('NETWORK_UNAVAILABLE','Lost response'),new RequestError('REQUEST_FAILED','Timeout',408),new Error('Unexpected')])expect(accessFailureKind(error)).toBe('unknown');
  });
});
