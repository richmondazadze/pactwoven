import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { MemberAccess, MemberCandidate } from '@pactwoven/contracts';
import { OriginalAccessReview } from '../components/original-access-review';
import { MotionProvider } from '../components/motion';
import { createAccessCapsule, type AccessCapsuleScope } from './access-capsule';
import { buildAccessIntent, type AccessSelection } from './access-review';
const scope:AccessCapsuleScope={userId:'subject_owner',organizationId:'provider_org',sessionId:'session_memory_only',apiBase:'https://api.example.test',environment:'development',internalOrganizationId:'org_one',actorId:'actor_owner',requesterMembershipId:'membership_owner'};
const owner:MemberAccess={actorId:scope.actorId,externalSubject:scope.userId,externalMembershipId:scope.requesterMembershipId,displayName:'Current owner name',status:'active',roles:['owner'],siteIds:[],actionSiteIds:[],expiresAt:null,version:2};
const target:MemberAccess={...owner,actorId:'actor_target',externalSubject:'subject_target',externalMembershipId:'membership_target',displayName:'Recognizable current member',roles:['receiver'],version:7};
const candidate:MemberCandidate={externalOrganizationId:scope.organizationId,externalSubject:target.externalSubject,externalMembershipId:target.externalMembershipId,displayName:target.displayName,externalRole:'org:member',observedAt:'2026-11-15T00:00:00Z'};
const sites=[{id:'site_b',name:'East warehouse',timeZone:'UTC'},{id:'site_a',name:'Main workshop',timeZone:'UTC'}];
async function render(kind:'grant'|'revise'|'revoke',options:{sites?:typeof sites;expiresAt?:string|null;reason?:string;target?:MemberAccess}={}) {
  const selection:AccessSelection=kind==='grant'?{kind,candidate}:{kind,member:target};
  const intent=buildAccessIntent(selection,{roles:['finance','operations'],siteIds:['site_b','site_a'],actionSiteIds:['site_a','site_b'],expiresAt:options.expiresAt===undefined?'2026-12-01T02:03:04.123Z':options.expiresAt},options.reason??'End access\nKeep this exact line.',8);
  const capsule=await createAccessCapsule(scope,selection,intent,'request_key_123456789');
  const html=renderToStaticMarkup(createElement(MotionProvider,{children:createElement(OriginalAccessReview,{capsule,observation:{requester:owner,target:kind==='grant'?candidate:options.target??target,observedAt:'2026-11-15T12:00:00Z'},sites:options.sites??sites})}));
  const [primary='',details='']=html.split('<div class="original-access-details">');return {html,primary,details,capsule};
}
describe('original request presentation',()=>{
  it.each(['grant','revise'] as const)('leads %s with current names, original grants/ordered site labels, exact expiry and current observation',async kind=>{
    const {primary,details,capsule}=await render(kind);
    for(const text of [kind==='grant'?'Grant app access':'Revise app access',target.displayName,'Current member name, observed for this review','Finance','Operations','Assigned reading sites','Action sites','East warehouse','Main workshop','2026-12-01T02:03:04.123Z','Current record observation','All organization sites'])expect(primary).toContain(text);
    expect(primary.indexOf('East warehouse')).toBeLessThan(primary.indexOf('Main workshop'));
    const actions=primary.slice(primary.indexOf('<dt>Action sites</dt>'));expect(actions.indexOf('Main workshop')).toBeLessThan(actions.indexOf('East warehouse'));
    for(const technical of [scope.actorId,scope.requesterMembershipId,capsule.targetIdentity.externalMembershipId,capsule.targetIdentity.externalSubject,capsule.original.path,capsule.key,capsule.commandHash,'Schema / digest version','Expected member version','Authority epoch']){expect(primary).not.toContain(technical);expect(details).toContain(technical);}
    expect(details).toContain('Original roles, in order');expect(details).toContain('Original assigned read sites, in order');expect(details).toContain('Original action sites, in order');expect(details).toContain('Capsule integrity digest');expect(details).toContain(capsule.integrityHash);
    if(kind==='revise'){expect(primary).toContain('Recorded status');expect(primary).toContain('Member version');expect(primary).toContain('>7<');}else expect(primary).toContain('App grant status and version are not included in this observation');
  });
  it('shows the exact revoke reason in the primary view without implying the current grant is already revoked',async()=>{
    const reason='Leaving this project.\nPreserve exact reason & punctuation.';const {primary,details}=await render('revoke',{reason});expect(primary).toContain('Revoke app access');expect(primary).toContain('Original reason');expect(primary).toContain('Leaving this project.\nPreserve exact reason &amp; punctuation.');expect(primary).toContain('>active<');expect(primary).not.toContain('Roles in the original request');expect(details).toContain('Original reason');
  });
  it('discloses missing or ambiguous current labels without substituting an identity',async()=>{
    const {primary}=await render('revise',{sites:[{...sites[0]!,name:'Shared name'},{...sites[1]!,name:'Shared name'}],expiresAt:null});expect(primary).toContain('Shared name');expect(primary).toContain('site_a');expect(primary).toContain('site_b');expect(primary).toContain('No scheduled expiry');
    const missing=await render('revise',{sites:[]});expect(missing.primary).toContain('Site name unavailable');expect(missing.primary).toContain('site_a');expect(missing.primary).toContain('site_b');
  });
  it('starts with a single keyboard-accessible collapsed disclosure and retains the original detail data without effect controls',async()=>{
    const {html,details}=await render('revise');expect(html.match(/<button/g)).toHaveLength(1);expect(details).toMatch(/<button type="button" aria-expanded="false" aria-controls="[^"]+">Request details/);expect(details).toContain('inert="" aria-hidden="true"');expect(details).toContain('No original before-state was retained');
    for(const forbidden of ['<form','<input','Retry original request','Verify identity','Submit access change',scope.sessionId])expect(html).not.toContain(forbidden);
  });
});
