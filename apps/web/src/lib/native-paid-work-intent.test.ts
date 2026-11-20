import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentWorkScope, type AgentWorkStorage } from './native-agent-work';
import { nativeSessionFixture } from './native-tasks.test-fixtures';
import { agentWorkInputFixture, agentWorkReviewFixture } from './native-agent-work.test-fixtures';
import { clearPaidWorkIntent, confirmPaidWorkIntent, createPaidWorkIntent, paidWorkConfirmedSchema, paidWorkIntentRequest, paidWorkOptionsSchema, paidWorkPreparedSchema, paidWorkRecoveredSchema, previousPaidWorkConnection, readPaidWorkIntent, recoverPaidWorkIntent, retainPaidWorkReview, sendPaidWorkIntent, storePaidWorkIntent } from './native-paid-work-intent';
const policy = { serviceId:'equipment_optimizer_v1' as const, maximumComputationBaseUnits:'10000', maximumFeeLamports:'10000', authorization:'separate_quote_required' as const }, reviewedPolicy = { ...policy,policyReviewHash:'b'.repeat(64) };
const scope = () => agentWorkScope(nativeSessionFixture(),'site_one');
const publicScope = { environment:'development',organizationId:'company_one',siteId:'site_one' };
const store = ():AgentWorkStorage=>{const map=new Map<string,string>();return{get length(){return map.size;},key:i=>[...map.keys()][i]??null,getItem:k=>map.get(k)??null,setItem:(k,v)=>{map.set(k,v);},removeItem:k=>{map.delete(k);}};};
const operation = (r=agentWorkReviewFixture())=>({scope:publicScope,id:'operation',reviewId:r.id,rootTaskId:'root',title:r.body.title,committedAt:r.preparedAt,expiresAt:r.expiresAt,continuesAfterSignOut:true,kind:'delegated_advice'});
beforeEach(()=>vi.stubEnv('NEXT_PUBLIC_NATIVE_API_BASE_URL','http://localhost:3108'));
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});
describe('separate equipment planning intent',()=>{
  it('accepts only enabled fixed planning policy or disabled option',()=>{expect(paidWorkOptionsSchema.safeParse({enabled:false}).success).toBe(true);expect(paidWorkOptionsSchema.safeParse({enabled:true,paidPolicy:policy}).success).toBe(true);expect(paidWorkOptionsSchema.safeParse({enabled:true,paidPolicy:{...policy,authorization:'spend_now'}}).success).toBe(false);});
  it('retains exact input/key, work token and policy hash through explicit confirmation',()=>{
    const storage=store(),a=createPaidWorkIntent(scope(),agentWorkInputFixture(),policy),r=agentWorkReviewFixture();storePaidWorkIntent(storage,a);const prepared=retainPaidWorkReview(a,r,reviewedPolicy);storePaidWorkIntent(storage,prepared);const confirmed=confirmPaidWorkIntent(prepared,r);storePaidWorkIntent(storage,confirmed);
    expect(readPaidWorkIntent(storage,a.scope)).toEqual(confirmed);expect(confirmed.key).toBe(a.key);expect(confirmed.prepared?.reviewToken).toBe(r.token);expect(confirmed.prepared?.policyReviewHash).toBe(reviewedPolicy.policyReviewHash);expect(confirmed.confirmation?.continuesAfterSignOut).toBe(true);
    expect(()=>storePaidWorkIntent(storage,{...confirmed,paidPolicy:{...policy,maximumFeeLamports:'15000'}})).toThrow();expect(()=>storePaidWorkIntent(storage,prepared)).toThrow();expect(()=>clearPaidWorkIntent(storage,a)).toThrow();clearPaidWorkIntent(storage,confirmed);expect(storage.length).toBe(0);
  });
  it('blocks changed prepared binding, storage loss and previous-origin replacement',()=>{
    const s=store(),a=createPaidWorkIntent(scope(),agentWorkInputFixture(),policy),r=agentWorkReviewFixture(),prepared=retainPaidWorkReview(a,r,reviewedPolicy);storePaidWorkIntent(s,prepared);
    expect(()=>confirmPaidWorkIntent(prepared,{...r,token:'c'.repeat(64)})).toThrow();expect(()=>storePaidWorkIntent(s,{...prepared,prepared:{...prepared.prepared!,policyReviewHash:'c'.repeat(64)}})).toThrow();
    const other={...scope(),apiBase:'https://other.example'};expect(previousPaidWorkConnection(s,other)).toBe(true);expect(()=>storePaidWorkIntent(s,createPaidWorkIntent(other,a.input,policy))).toThrow();const broken=store();broken.setItem=()=>{};expect(()=>storePaidWorkIntent(broken,a)).toThrow();
  });
  it('rejects substituted work scope, policy ceilings, hash and review identity',()=>{
    const a=createPaidWorkIntent(scope(),agentWorkInputFixture(),policy),r=agentWorkReviewFixture(),response={work:{scope:publicScope,review:r,operation:null},paidPolicy:reviewedPolicy};expect(paidWorkPreparedSchema(a).safeParse(response).success).toBe(true);
    expect(paidWorkPreparedSchema(a).safeParse({...response,paidPolicy:{...reviewedPolicy,maximumComputationBaseUnits:'20000'}}).success).toBe(false);expect(paidWorkPreparedSchema(a).safeParse({...response,work:{...response.work,scope:{...publicScope,siteId:'other'}}}).success).toBe(false);
    const prepared=retainPaidWorkReview(a,r,reviewedPolicy),confirmed=confirmPaidWorkIntent(prepared,r);expect(paidWorkConfirmedSchema(confirmed).safeParse({work:operation(r),paidPolicy:reviewedPolicy}).success).toBe(true);expect(paidWorkConfirmedSchema(confirmed).safeParse({work:operation(r),paidPolicy:{...reviewedPolicy,policyReviewHash:'c'.repeat(64)}}).success).toBe(false);
  });
  it('matches recovered work and policy together while permitting a genuinely empty recovery',()=>{
    const a=createPaidWorkIntent(scope(),agentWorkInputFixture(),policy),r=agentWorkReviewFixture(),prepared=retainPaidWorkReview(a,r,reviewedPolicy),schema=paidWorkRecoveredSchema(prepared),work={scope:publicScope,review:r,operation:null,reviewUnavailable:false};
    expect(schema.safeParse({work,paidPolicy:reviewedPolicy}).success).toBe(true);expect(schema.safeParse({work,paidPolicy:null}).success).toBe(false);expect(schema.safeParse({work:{...work,review:null},paidPolicy:null}).success).toBe(true);expect(schema.safeParse({work:{...work,review:{...r,token:'c'.repeat(64)}},paidPolicy:reviewedPolicy}).success).toBe(false);
  });
  it('sends nested wrappers under the original key without introducing payment authorization',async()=>{
    const a=createPaidWorkIntent(scope(),agentWorkInputFixture(),policy),r=agentWorkReviewFixture(),prepared=retainPaidWorkReview(a,r,reviewedPolicy),confirmed=confirmPaidWorkIntent(prepared,r),fetch=vi.fn().mockResolvedValueOnce(Response.json({work:{scope:publicScope,review:r,operation:null},paidPolicy:reviewedPolicy})).mockResolvedValueOnce(Response.json({work:operation(r),paidPolicy:reviewedPolicy}));vi.stubGlobal('fetch',fetch);
    await sendPaidWorkIntent(a,async()=>'token',()=>a.scope);await sendPaidWorkIntent(confirmed,async()=>'token',()=>a.scope);
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({work:a.input,paidPolicy:policy});expect(JSON.parse(fetch.mock.calls[1]![1].body)).toEqual({work:confirmed.confirmation,policyReviewHash:reviewedPolicy.policyReviewHash});expect(fetch.mock.calls.map(c=>c[1].headers['Idempotency-Key'])).toEqual([a.key,a.key]);expect(fetch.mock.calls.every(c=>!c[0].includes('purchases'))).toBe(true);
  });
  it('null recovery retains storage and uses only the original idempotency reference',async()=>{
    const storage=store(),a=createPaidWorkIntent(scope(),agentWorkInputFixture(),policy);storePaidWorkIntent(storage,a);const fetch=vi.fn(async(_url:string)=>Response.json({work:{scope:publicScope,review:null,operation:null,reviewUnavailable:false},paidPolicy:null}));vi.stubGlobal('fetch',fetch);await recoverPaidWorkIntent(a,async()=>'token',()=>a.scope,new AbortController().signal);expect(readPaidWorkIntent(storage,a.scope)).toEqual(a);expect(fetch.mock.calls[0]?.[0]).toContain(`/paid/operations/${a.key}?siteId=site_one`);
  });
  it('fences current scope after token await and refuses unrelated or approval routes',async()=>{
    const a=createPaidWorkIntent(scope(),agentWorkInputFixture(),policy);let current=a.scope;const fetch=vi.fn();vi.stubGlobal('fetch',fetch);await expect(sendPaidWorkIntent(a,async()=>{current={...current,sessionId:'other'};return'token';},()=>current)).rejects.toMatchObject({code:'SCOPE_CHANGED'});expect(fetch).not.toHaveBeenCalled();
    await expect(paidWorkIntentRequest('/v1/agent-work/paid/approve',paidWorkOptionsSchema,a.scope,async()=>'token',()=>a.scope,{body:{}})).rejects.toMatchObject({code:'INVALID_PATH'});
  });
});
