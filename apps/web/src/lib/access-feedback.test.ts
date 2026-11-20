import { describe,expect,it } from 'vitest';
import { SessionSchema,type Operation } from '@pactwoven/contracts';
import { accessNoticeFromOperation,visibleAccessReceipt,accessFenceNoticeFromResult,visibleAccessFenceReceipt } from './access-feedback';
const session=SessionSchema.parse({actor:{actorId:'owner_one',principalKind:'human',organizationId:'org_one',environment:'development',roles:['owner'],siteIds:['site_one'],actionSiteIds:['site_one'],sessionId:'session_one',authenticatedAt:'2026-11-15T00:00:00Z',correlationId:'correlation_one'},organization:{id:'org_one',name:'Test organization',authorityEpoch:3},sites:[{id:'site_one',name:'Test site',timeZone:'UTC'}]});
const operation:Operation={id:'operation_one',environment:'development',status:'succeeded',aggregateId:'private_member',aggregateVersion:2,financialState:null,evidenceRefs:['private_evidence'],nextCheckAt:null,error:null};
describe('session-scoped terminal access feedback',()=>{
  it('keeps only the terminal display receipt and scope, dropping member/evidence/operation internals',()=>{
    const notice=accessNoticeFromOperation(session,operation);
    expect(notice).toEqual({actorId:'owner_one',organizationId:'org_one',environment:'development',receipt:{id:'operation_one',status:'succeeded',aggregateVersion:2}});
    expect(JSON.stringify(notice)).not.toContain('private_member');expect(JSON.stringify(notice)).not.toContain('private_evidence');expect(JSON.stringify(notice)).not.toContain('session_one');
  });
  it('preserves historical feedback across authority/site changes without treating it as current access',()=>{
    const notice=accessNoticeFromOperation(session,operation);
    const changed={...session,organization:{...session.organization,authorityEpoch:4},actor:{...session.actor,siteIds:[],actionSiteIds:[]},sites:[]};
    expect(visibleAccessReceipt(notice,changed)).toEqual({id:'operation_one',status:'succeeded',aggregateVersion:2});
  });
  it('withholds the receipt from a different actor, organization, environment, nonowner or service principal',()=>{
    const notice=accessNoticeFromOperation(session,operation);
    for(const actor of [{...session.actor,actorId:'owner_two'},{...session.actor,organizationId:'org_two'},{...session.actor,environment:'staging' as const},{...session.actor,roles:['finance' as const]},{...session.actor,principalKind:'service' as const}])expect(visibleAccessReceipt(notice,{...session,actor})).toBeNull();
    expect(visibleAccessReceipt(null,session)).toBeNull();
  });
  it('never turns accepted/pending/unknown operations or a cross-environment result into a terminal notice',()=>{
    for(const status of ['accepted','pending','unknown'] as const)expect(accessNoticeFromOperation(session,{...operation,status})).toBeNull();
    expect(accessNoticeFromOperation(session,{...operation,environment:'production'})).toBeNull();
    expect(accessNoticeFromOperation({...session,actor:{...session.actor,roles:['auditor']}},operation)).toBeNull();
    expect(accessNoticeFromOperation(session,{...operation,status:'failed',error:{code:'EXPIRED',retryable:false,detailRef:'private_detail'}})?.receipt).toEqual({id:'operation_one',status:'failed',aggregateVersion:2});
  });
});

const fence={schemaVersion:1 as const,disposition:'fenced' as const,environment:'development' as const,organizationId:'org_one',externalOrganizationId:'provider_org',kind:'revoke' as const,key:'original_key_123456789',observedAt:'2026-11-15T12:00:00Z',reviewer:{actorId:'owner_one',externalMembershipId:'private_membership',authorityEpoch:99},fence:{id:'fence_audit_one',closedAt:'2026-11-15T11:59:00Z'}};
describe('distinct scoped fence feedback',()=>{
  it('retains only first fence identity/time/key/kind, without inventing an operation or historical closer',()=>{
    const notice=accessFenceNoticeFromResult(session,fence);expect(notice).toEqual({actorId:'owner_one',organizationId:'org_one',environment:'development',receipt:{id:'fence_audit_one',closedAt:fence.fence.closedAt,kind:'revoke',key:fence.key}});
    for(const omitted of ['private_membership','authorityEpoch','session_one','aggregateVersion','status','operation','closedBy'])expect(JSON.stringify(notice)).not.toContain(omitted);
    expect(visibleAccessFenceReceipt(notice,{...session,organization:{...session.organization,authorityEpoch:100},actor:{...session.actor,siteIds:[],actionSiteIds:[]}})).toEqual(notice?.receipt);
  });
  it('withholds foreign, nonowner, nonhuman, malformed and inconsistent-organization notices',()=>{
    const notice=accessFenceNoticeFromResult(session,fence);
    for(const actor of [{...session.actor,actorId:'other'},{...session.actor,environment:'staging' as const},{...session.actor,organizationId:'other'},{...session.actor,roles:['finance' as const]},{...session.actor,principalKind:'service' as const}]){expect(accessFenceNoticeFromResult({...session,actor},fence)).toBeNull();expect(visibleAccessFenceReceipt(notice,{...session,actor})).toBeNull();}
    const differentOrg={...session,organization:{...session.organization,id:'other'}};expect(accessFenceNoticeFromResult(differentOrg,fence)).toBeNull();expect(visibleAccessFenceReceipt(notice,differentOrg)).toBeNull();
    expect(accessFenceNoticeFromResult(session,{...fence,fence:{...fence.fence,closedAt:'2027-01-01T00:00:00Z'}})).toBeNull();expect(visibleAccessFenceReceipt(null,session)).toBeNull();
  });
});
