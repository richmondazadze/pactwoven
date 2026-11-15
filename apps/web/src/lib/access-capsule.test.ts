import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SessionSchema, type MemberAccess, type MemberCandidate, type Operation } from '@pactwoven/contracts';
import { canonicalJson, commandDigest } from '@pactwoven/contracts/canonical';
import { AccessCapsuleSchema, capsuleMatchesSession, createAccessCapsule, observeOriginalIdentity, verifyAccessCapsule, type AccessCapsule, type AccessCapsuleScope } from './access-capsule';
import { buildAccessIntent, type AccessSelection } from './access-review';
import { initialRecoveryFlow, recoveryFlow, retryOriginalAccess, retryVerificationCurrent, originalOperation, RETRY_REVIEW_LIFETIME_MS, type RecoveryFlow, type RetryContext } from './access-retry';
import { recoveryFromCapsule, readAccessRecovery, saveAccessRecovery } from './access-recovery';
import { ReadOnlyMemberReview } from '../components/member-access-review';
import { OriginalAccessReview } from '../components/original-access-review';
import { MotionProvider } from '../components/motion';
const scope:AccessCapsuleScope={userId:'subject_owner',organizationId:'provider_org',sessionId:'session_one',apiBase:'https://api.example.test',environment:'development',internalOrganizationId:'org_one',actorId:'actor_owner',requesterMembershipId:'membership_owner'};
const session=SessionSchema.parse({actor:{actorId:scope.actorId,principalKind:'human',organizationId:scope.internalOrganizationId,environment:scope.environment,roles:['owner'],siteIds:['site_b','site_a'],actionSiteIds:['site_a'],sessionId:'api_session',authenticatedAt:'2026-11-15T00:00:00Z',correlationId:'test_correlation'},organization:{id:scope.internalOrganizationId,name:'Test organization',authorityEpoch:8},sites:[{id:'site_b',name:'Second site',timeZone:'UTC'},{id:'site_a',name:'First site',timeZone:'UTC'}]});
const context:RetryContext={session,auth:{userId:scope.userId,orgId:scope.organizationId,sessionId:scope.sessionId},apiBase:scope.apiBase};
const owner:MemberAccess={actorId:scope.actorId,externalSubject:scope.userId,externalMembershipId:scope.requesterMembershipId,displayName:'Current owner',status:'active',roles:['owner'],siteIds:[],actionSiteIds:[],expiresAt:null,version:2};
const target:MemberAccess={actorId:'actor_target',externalSubject:'subject_target',externalMembershipId:'membership_target',displayName:'Current target',status:'active',roles:['receiver'],siteIds:['site_a'],actionSiteIds:[],expiresAt:null,version:3};
const candidate:MemberCandidate={externalOrganizationId:scope.organizationId,externalSubject:target.externalSubject,externalMembershipId:target.externalMembershipId,displayName:target.displayName,externalRole:'org:member',observedAt:'2026-11-15T00:00:00Z'};
const grant={roles:['finance','operations'] as ('finance'|'operations')[],siteIds:['site_b','site_a'],actionSiteIds:['site_a','site_b'],expiresAt:'2026-12-01T02:03:04.123Z'};
function prepare(kind:'grant'|'revise'|'revoke'='revise') {const selection:AccessSelection=kind==='grant'?{kind,candidate}:{kind,member:target};const intent=buildAccessIntent(selection,grant,'Leaving the project\nKeep exact reason.',8);return {selection,intent};}
async function capsule(kind:'grant'|'revise'|'revoke'='revise') {const {selection,intent}=prepare(kind);return createAccessCapsule(scope,selection,intent,'request_key_123456789');}
function authorized(value:AccessCapsule):RecoveryFlow {let state=recoveryFlow(initialRecoveryFlow,{type:'check-result'});state=recoveryFlow(state,{type:'review',hash:value.integrityHash});state=recoveryFlow(state,{type:'verified',at:Date.now()});return recoveryFlow(state,{type:'retry-click',now:Date.now()});}
const operation:Operation={id:'operation_one',environment:'development',status:'succeeded',aggregateId:target.actorId,aggregateVersion:4,financialState:null,evidenceRefs:[],nextCheckAt:null,error:null};
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status});
function mockService(options:{owner?:MemberAccess;target?:MemberAccess;candidate?:MemberCandidate;post?:()=>Response|Promise<Response>}={}) {
  const fetcher=vi.fn(async(input:string|URL|Request,init?:RequestInit)=>{
    if(init?.method==='POST')return options.post?options.post():json(operation);
    if(String(input).includes('/candidates?'))return json({items:[options.candidate??candidate],nextCursor:null,observedAt:'2026-11-15T00:00:00Z'});
    return json({items:[options.owner??owner,options.target??target],nextCursor:null,authorityEpoch:9,observedAt:'2026-11-15T00:00:00Z'});
  });vi.stubGlobal('fetch',fetcher);return fetcher;
}
const posts=(fetcher:ReturnType<typeof mockService>)=>fetcher.mock.calls.filter(call=>call[1]?.method==='POST');
beforeEach(()=>vi.stubEnv('NEXT_PUBLIC_API_BASE_URL',scope.apiBase));
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();vi.useRealTimers();});
describe('immutable original access capsule',()=>{
  it('clones and freezes the exact original input, preserving arrays, expiry, epoch and version',async()=>{
    const {selection,intent}=prepare();const copiedScope={...scope};const pending=createAccessCapsule(copiedScope,selection,intent,'request_key_123456789');copiedScope.userId='changed_after_start';if(intent.kind!=='revoke')intent.command.payload.siteIds.reverse();
    const value=await pending;expect(value.scope).toEqual(scope);expect(value.original.command.expectedVersion).toBe(3);expect(value.original.command.authorityEpoch).toBe(8);expect(value.original.command.mandateVersion).toBeNull();
    expect(value.original.command.payload).toMatchObject(grant);expect(Object.isFrozen(value)).toBe(true);expect(Object.isFrozen(value.original.command.payload)).toBe(true);if(value.original.kind!=='revoke'){const payload=value.original.command.payload;expect(Object.isFrozen(payload.siteIds)).toBe(true);expect(()=>payload.siteIds.push('changed')).toThrow();}
    expect(JSON.stringify(value)).not.toContain('displayName');expect(JSON.stringify(value)).not.toContain('Current target');
  });
  it.each(['grant','revise','revoke'] as const)('matches the authoritative canonical envelope for %s',async(kind)=>{
    const value=await capsule(kind);const expected=await commandDigest({schemaVersion:1,kind:`member.${kind}`,environment:scope.environment,externalOrganizationId:scope.organizationId,subject:scope.userId,actorId:kind==='grant'?null:target.actorId,command:value.original.command});
    expect(value.commandHash).toBe(expected);expect(await verifyAccessCapsule(value,scope)).toEqual(value);
    if(kind==='revoke')expect(value.original.command.payload).toEqual({reason:'Leaving the project\nKeep exact reason.'});
  });
  it('rejects altered input, hashes, path/target bindings, normalized reason changes and unknown fields',async()=>{
    const value=await capsule();const changed=[{...value,key:'different_key_123456789'},{...value,commandHash:'0'.repeat(64)},{...value,integrityHash:'0'.repeat(64)},{...value,original:{...value.original,path:'/v1/members/other/revise-access'}},{...value,original:{...value.original,targetActorId:'other'}},{...value,original:{...value.original,command:{...value.original.command,authorityEpoch:9}}},{...value,targetIdentity:{...value.targetIdentity,externalMembershipId:'rebound_membership'}},{...value,token:'forbidden'}];
    for(const input of changed)await expect(verifyAccessCapsule(input as AccessCapsule,scope)).rejects.toThrow();
    const revoke=await capsule('revoke');if(revoke.original.kind!=='revoke')throw new Error('fixture');await expect(verifyAccessCapsule({...revoke,original:{...revoke.original,command:{...revoke.original.command,payload:{reason:' '+revoke.original.command.payload.reason}}}},scope)).rejects.toThrow('changed during validation');
    expect(AccessCapsuleSchema.safeParse({...value,verifiedAt:Date.now()}).success).toBe(false);
  });
  it('binds every authenticated dimension and prevents owner/service/tenant substitution',async()=>{
    const value=await capsule();for(const name of Object.keys(scope) as (keyof AccessCapsuleScope)[]){const changed={...scope,[name]:name==='environment'?'production':name==='apiBase'?'https://other.example.test':'changed'};await expect(verifyAccessCapsule(value,changed)).rejects.toThrow();}
    expect(capsuleMatchesSession(value,session,context.auth,scope.apiBase)).toBe(true);
    for(const auth of [{...context.auth,userId:'other'},{...context.auth,orgId:'other'},{...context.auth,sessionId:'new_session'}])expect(capsuleMatchesSession(value,session,auth,scope.apiBase)).toBe(false);
    for(const actor of [{...session.actor,actorId:'other'},{...session.actor,roles:['finance' as const]},{...session.actor,principalKind:'service' as const},{...session.actor,environment:'production' as const},{...session.actor,organizationId:'other'}])expect(capsuleMatchesSession(value,{...session,actor},context.auth,scope.apiBase)).toBe(false);
    expect(capsuleMatchesSession(value,session,context.auth,'https://other.example.test')).toBe(false);
    expect(capsuleMatchesSession(value,{...session,organization:{...session.organization,id:'other'}},context.auth,scope.apiBase)).toBe(false);
    expect(capsuleMatchesSession(value,{...session,organization:{...session.organization,authorityEpoch:9}},context.auth,scope.apiBase)).toBe(true);
  });
  it('blocks requester or target membership replacement and foreign grant organizations',async()=>{
    const value=await capsule();for(const field of ['externalMembershipId','externalSubject'] as const){mockService({owner:{...owner,[field]:'replaced'}});await expect(observeOriginalIdentity(value,async()=>'token')).rejects.toMatchObject({code:'RECOVERY_IDENTITY_CHANGED'});mockService({target:{...target,[field]:'replaced'}});await expect(observeOriginalIdentity(value,async()=>'token')).rejects.toMatchObject({code:'RECOVERY_TARGET_CHANGED'});}
    mockService({owner:{...owner,status:'revoked'}});await expect(observeOriginalIdentity(value,async()=>'token')).rejects.toMatchObject({status:403});mockService({candidate:{...candidate,externalOrganizationId:'other_org'}});await expect(observeOriginalIdentity(await capsule('grant'),async()=>'token')).rejects.toMatchObject({code:'RECOVERY_TARGET_CHANGED'});
  });
  it('rejects looping pagination without guessing a current membership',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>json({items:[],nextCursor:'0',authorityEpoch:8,observedAt:'2026-11-15T00:00:00Z'})));await expect(observeOriginalIdentity(await capsule(),async()=>'token')).rejects.toMatchObject({code:'RESPONSE_UNVERIFIED'});
  });
  it('renders complete original input and separately labeled current observations without mutation controls',async()=>{
    for(const kind of ['grant','revise','revoke'] as const){const value=await capsule(kind);const html=renderToStaticMarkup(createElement(MotionProvider,{children:createElement(OriginalAccessReview,{capsule:value,observation:{requester:owner,target,observedAt:'2026-11-15T00:00:00Z'}})}));
      for(const text of ['Immutable original request','No original before-state was retained','Current record observation',value.key,value.commandHash,value.targetIdentity.externalSubject,value.targetIdentity.externalMembershipId,scope.actorId,scope.requesterMembershipId,'Expected member version','Authority epoch','Mandate version','Schema / digest version'])expect(html).toContain(text);
      if(kind==='revoke')expect(html).toContain('Keep exact reason.');else{for(const text of ['Original roles, in order','site_b','site_a',grant.expiresAt])expect(html).toContain(text);expect(html.indexOf('site_b')).toBeLessThan(html.indexOf('site_a'));}
      for(const forbidden of ['<form','<input','Verify identity','Submit access change',scope.sessionId])expect(html).not.toContain(forbidden);
      expect(html.match(/<button/g)).toHaveLength(1);expect(html).toContain('Request details');expect(html).toContain('aria-expanded="false"');
    }
    for(const status of ['active','suspended','revoked'] as const){const html=renderToStaticMarkup(createElement(ReadOnlyMemberReview,{member:{...target,status},sites:session.sites}));expect(html).toContain(target.externalSubject);for(const forbidden of ['<form','<button','<input','Verify identity','Submit access change'])expect(html).not.toContain(forbidden);}
  });
});
describe('deliberate exact-request retry',()=>{
  it('requires check, review and fresh verification, with no retry transition on verification completion',async()=>{
    const value=await capsule();let state=initialRecoveryFlow;expect(recoveryFlow(state,{type:'verified',at:Date.now()})).toEqual(state);expect(recoveryFlow(state,{type:'retry-click',now:Date.now()})).toEqual(state);
    state=recoveryFlow(state,{type:'check-result'});expect(state.phase).toBe('checked');expect(recoveryFlow(state,{type:'retry-click',now:Date.now()})).toEqual(state);state=recoveryFlow(state,{type:'review',hash:value.integrityHash});state=recoveryFlow(state,{type:'verified',at:Date.now()});expect(state.phase).toBe('verified');
    const fetcher=mockService();await expect(retryOriginalAccess(value,state,()=>context,async()=>'token',new AbortController().signal)).rejects.toMatchObject({code:'RECOVERY_REVIEW_REQUIRED'});expect(fetcher).not.toHaveBeenCalled();
    expect(recoveryFlow(state,{type:'retry-click',now:Date.now()}).phase).toBe('retrying');expect(recoveryFlow(state,{type:'verification-invalidated'})).toMatchObject({phase:'reviewed',verifiedAt:null});
  });
  it.each(['grant','revise','revoke'] as const)('posts %s only once with its exact original body, path and key',async(kind)=>{
    const value=await capsule(kind);const fetcher=mockService();const token=vi.fn(async()=>'current_token');expect(await retryOriginalAccess(value,authorized(value),()=>context,token,new AbortController().signal)).toEqual(operation);expect(posts(fetcher)).toHaveLength(1);const [url,init]=posts(fetcher)[0]!;expect(url).toBe(scope.apiBase+value.original.path);expect(init).toMatchObject({headers:{'Idempotency-Key':value.key,Authorization:'Bearer current_token'},body:JSON.stringify(value.original.command)});expect(canonicalJson(JSON.parse(String(init?.body)))).toBe(canonicalJson(value.original.command));expect(token).toHaveBeenCalledTimes(3);
  });
  it.each([401,403,409,422,503])('retains the unresolved original after retry HTTP %i',async(status)=>{
    const value=await capsule();const locator=recoveryFromCapsule(value);const values=new Map<string,string>();const storage={get length(){return values.size;},key:(i:number)=>[...values.keys()][i]??null,getItem:(key:string)=>values.get(key)??null,setItem:(key:string,v:string)=>{values.set(key,v);},removeItem:(key:string)=>{values.delete(key);}};saveAccessRecovery(storage,locator);
    const fetcher=mockService({post:()=>json({error:{code:'ATTEMPT_REJECTED',message:'Retry rejected',correlationId:'retry_test'}},status)});await expect(retryOriginalAccess(value,authorized(value),()=>context,async()=>'token',new AbortController().signal)).rejects.toMatchObject({status});expect(posts(fetcher)).toHaveLength(1);expect(readAccessRecovery(storage,locator)).toEqual(locator);expect(value.key).toBe(locator.key);
  });
  it('does not retry automatically after transport loss and preserves the original command',async()=>{
    const value=await capsule();const before=canonicalJson(value);const fetcher=mockService({post:()=>Promise.reject(new TypeError('response lost'))});await expect(retryOriginalAccess(value,authorized(value),()=>context,async()=>'token',new AbortController().signal)).rejects.toMatchObject({code:'NETWORK_UNAVAILABLE'});expect(posts(fetcher)).toHaveLength(1);expect(canonicalJson(value)).toBe(before);
  });
  it('blocks stale scope or aborts discovered while obtaining the dispatch token',async()=>{
    const value=await capsule();let current=context;let calls=0;const fetcher=mockService();await expect(retryOriginalAccess(value,authorized(value),()=>current,async()=>{if(++calls===3)current={...context,auth:{...context.auth,sessionId:'new_session'}};return 'token';},new AbortController().signal)).rejects.toMatchObject({code:'RECOVERY_SCOPE_CHANGED'});expect(posts(fetcher)).toHaveLength(0);
    current=context;calls=0;const controller=new AbortController();await expect(retryOriginalAccess(value,authorized(value),()=>current,async()=>{if(++calls===3)controller.abort();return 'token';},controller.signal)).rejects.toMatchObject({name:'AbortError'});expect(posts(fetcher)).toHaveLength(0);
  });
  it('expires local confirmation without renewing the original input or sending a request',async()=>{
    const value=await capsule();const fetcher=mockService();expect(retryVerificationCurrent(null)).toBe(false);expect(retryVerificationCurrent(100,99)).toBe(false);expect(retryVerificationCurrent(100,100+RETRY_REVIEW_LIFETIME_MS)).toBe(false);
    await expect(retryOriginalAccess(value,{...authorized(value),verifiedAt:Date.now()-RETRY_REVIEW_LIFETIME_MS},()=>context,async()=>'token',new AbortController().signal)).rejects.toMatchObject({code:'RECOVERY_REVIEW_REQUIRED'});expect(fetcher).not.toHaveBeenCalled();
  });
  it('will not resolve from an unrelated target, environment or financial response',async()=>{
    const value=await capsule();for(const result of [{...operation,environment:'production' as const},{...operation,aggregateId:'unrelated_target'},{...operation,financialState:'FINALIZED' as const}])expect(()=>originalOperation(result,'development',value)).toThrow('does not match');
    expect(originalOperation({...operation,status:'unknown'},'development',value).status).toBe('unknown');
  });
});
