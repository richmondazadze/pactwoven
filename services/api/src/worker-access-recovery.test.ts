import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccessRecoveryGateway, AccessRecoveryResult, CloseAccessRecoveryIntent, Operation } from '@pactwoven/contracts';
import { DomainError } from '@pactwoven/domain';
import { accessRecoveryUrl, accessRecoveryRequestBytes, accessRecoveryResponseBytes, handlePrivateAccessRecoveryRequest,
  serviceAccessRecoveryGateway } from './worker-access-recovery.js';

const issuer='https://fixture.clerk.accounts.dev',token='synthetic-recovery-token',key='original_recovery_key_0001',trace='recovery_trace';
const intent:CloseAccessRecoveryIntent={schemaVersion:1,kind:'grant',reason:'original_input_unavailable',expectedEnvironment:'development',
  expectedOrganizationId:'org_a',expectedActorId:'owner_a',expectedExternalMembershipId:'membership_owner_a',expectedAuthorityEpoch:2};
const operation:Operation={id:'original_operation',environment:'development',status:'succeeded',aggregateId:'member_b',aggregateVersion:1,
  financialState:null,evidenceRefs:['history_a'],nextCheckAt:null,error:null};
function result(disposition:'recorded'|'fenced'|'not_recorded'='fenced',kind:CloseAccessRecoveryIntent['kind']='grant',requestKey=key):AccessRecoveryResult {
  const now=new Date().toISOString(),base={schemaVersion:1 as const,environment:'development' as const,organizationId:'org_a',externalOrganizationId:'clerk_org_a',kind,key:requestKey,
    observedAt:now,reviewer:{actorId:'owner_a',externalMembershipId:'membership_owner_a',authorityEpoch:2}};
  return disposition==='recorded'?{...base,disposition,operation:structuredClone(operation)}:disposition==='fenced'?{...base,disposition,fence:{id:'closure_a',closedAt:now}}:{...base,disposition};
}
const gateway={get:vi.fn(),close:vi.fn()} satisfies AccessRecoveryGateway;
const factory=vi.fn<Parameters<typeof handlePrivateAccessRecoveryRequest>[2]>();
const headers={'Cache-Control':'private, no-store','Content-Type':'application/json'};
const publicRequest=(path='/v1/member-access/recovery/close',method='POST',requestKey=key)=>new Request(`https://api.example${path}`,{
  method,headers:{Authorization:`Bearer ${token}`,'Idempotency-Key':requestKey},
});
const input=()=>({nonce:crypto.randomUUID(),request:{url:'https://api.example/v1/member-access/recovery/close',method:'POST',correlationId:trace},
  action:{kind:'close',key,intent:structuredClone(intent)}});
const privateRequest=(value:unknown,extra:Record<string,string>={})=>new Request(accessRecoveryUrl,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',...extra},body:JSON.stringify(value)});
const fetchPrivate=(request:Request)=>handlePrivateAccessRecoveryRequest(request,issuer,factory);
const adapter=(request=publicRequest(),fetch:(request:Request)=>Promise<Response>=fetchPrivate)=>serviceAccessRecoveryGateway({fetch},request,issuer);
beforeEach(()=>{
  vi.resetAllMocks();factory.mockReturnValue(gateway);
  gateway.get.mockImplementation(async(_token,query)=>result('fenced',query.kind,query.key));
  gateway.close.mockImplementation(async(_token,requestKey,review)=>result('fenced',review.kind,requestKey));
});

describe('private access recovery transport',()=>{
  it('binds the factory to the exact outer nonce and forwards only original bearer and public inputs',async()=>{
    let body:ReturnType<typeof input>|undefined,forwarded:Request|undefined;
    const fetch=vi.fn(async(request:Request)=>{forwarded=request.clone();body=await request.clone().json() as ReturnType<typeof input>;return fetchPrivate(request);});
    expect(await adapter(publicRequest(),fetch).close(token,key,intent,trace)).toMatchObject({disposition:'fenced'});
    expect(forwarded!.url).toBe(accessRecoveryUrl);expect([...forwarded!.headers.keys()].sort()).toEqual(['authorization','content-type']);
    expect(forwarded!.headers.get('Authorization')).toBe(`Bearer ${token}`);expect(Object.keys(body!).sort()).toEqual(['action','nonce','request']);
    expect(body!.action).toEqual({kind:'close',key,intent});expect(factory).toHaveBeenCalledExactlyOnceWith(body!.nonce);
    expect(gateway.close).toHaveBeenCalledExactlyOnceWith(token,key,intent,trace);expect(gateway.get).not.toHaveBeenCalled();
  });
  it.each(['grant','revise','revoke'] as const)('preserves the short %s namespace for GET and close',async kind=>{
    expect(await adapter(publicRequest(`/v1/member-access/recovery?kind=${kind}&key=${key}`,'GET')).get(token,{kind,key},trace)).toMatchObject({kind,key,disposition:'fenced'});
    expect(await adapter().close(token,key,{...intent,kind},trace)).toMatchObject({kind,key,disposition:'fenced'});
  });
  it.each(['not_recorded','fenced','recorded'] as const)('preserves GET disposition %s without issuing close',async disposition=>{
    const value=result(disposition);gateway.get.mockResolvedValue(value);const fetch=vi.fn(fetchPrivate);
    expect(await adapter(publicRequest(`/v1/member-access/recovery?kind=grant&key=${key}`,'GET'),fetch).get(token,{kind:'grant',key},trace)).toEqual(value);
    expect(fetch).toHaveBeenCalledOnce();expect(gateway.close).not.toHaveBeenCalled();
  });
  it('rejects a successful close that reports only absence',async()=>{
    gateway.close.mockResolvedValue(result('not_recorded'));
    await expect(adapter().close(token,key,intent,trace)).rejects.toMatchObject({code:'DURABLE_SERVICE_UNAVAILABLE'});
    expect(gateway.close).toHaveBeenCalledOnce();expect(gateway.get).not.toHaveBeenCalled();
  });
  it.each(['accepted','pending','failed','unknown'] as const)('preserves recorded %s operation truth without retry or replacement',async status=>{
    const value=result('recorded');if(value.disposition==='recorded'){value.operation.status=status;if(status==='unknown')value.operation.error={code:'OUTCOME_UNKNOWN',retryable:false,detailRef:null};}
    gateway.close.mockResolvedValue(value);const fetch=vi.fn(fetchPrivate);
    expect(await adapter(publicRequest(),fetch).close(token,key,intent,trace)).toEqual(value);expect(fetch).toHaveBeenCalledOnce();
  });
  it('allows current reviewer epoch changes while preserving the exact old closure review',async()=>{
    const value=result();value.reviewer.authorityEpoch=9;gateway.close.mockResolvedValue(value);
    expect(await adapter().close(token,key,intent,trace)).toEqual(value);
    expect(gateway.close).toHaveBeenCalledExactlyOnceWith(token,key,intent,trace);
  });
  it('snapshots the parsed intent before any asynchronous exchange',async()=>{
    const mutable=structuredClone(intent),fetch=async(request:Request)=>{mutable.kind='revoke';mutable.expectedOrganizationId='different_org';return fetchPrivate(request);};
    expect(await adapter(publicRequest(),fetch).close(token,key,mutable,trace)).toMatchObject({kind:'grant',organizationId:'org_a'});
    expect(gateway.close).toHaveBeenCalledExactlyOnceWith(token,key,intent,trace);
  });
  it('rejects token, header, method, route and query mismatches before any private call',async()=>{
    const fetch=vi.fn(fetchPrivate);
    await expect(adapter(publicRequest(),fetch).close('other_token',key,intent,trace)).rejects.toMatchObject({code:'AUTH_REQUIRED'});
    for(const request of [publicRequest(undefined,'GET'),publicRequest('/v1/member-access/recovery'),publicRequest('/v1/member-access/recovery/close?extra=1'),publicRequest(undefined,'POST','other_recovery_key_0001')])
      await expect(adapter(request,fetch).close(token,key,intent,trace)).rejects.toMatchObject({code:'DURABLE_SERVICE_UNAVAILABLE'});
    for(const path of [`/v1/member-access/recovery?kind=revoke&key=${key}`,`/v1/member-access/recovery?kind=grant&kind=grant&key=${key}`,`/v1/member-access/recovery?kind=grant&key=${key}&extra=1`])
      await expect(adapter(publicRequest(path,'GET'),fetch).get(token,{kind:'grant',key},trace)).rejects.toMatchObject({code:'DURABLE_SERVICE_UNAVAILABLE'});
    await expect(adapter(publicRequest(),fetch).close(token,key,{...intent,expectedEnvironment:'production'},trace)).rejects.toMatchObject({code:'DURABLE_SERVICE_UNAVAILABLE'});
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    ['nonce',(d:Record<string,any>)=>{d.nonce=crypto.randomUUID();}],['tokenHash',(d:Record<string,any>)=>{d.tokenHash='f'.repeat(64);}],
    ['requestHash',(d:Record<string,any>)=>{d.requestHash='f'.repeat(64);}],['intentHash',(d:Record<string,any>)=>{d.intentHash='f'.repeat(64);}],
    ['method',(d:Record<string,any>)=>{d.request.method='GET';}],['url',(d:Record<string,any>)=>{d.request.url+='?other=1';}],
    ['trace',(d:Record<string,any>)=>{d.request.correlationId='other_trace';}],['action',(d:Record<string,any>)=>{d.action='get';}],
    ['kind',(d:Record<string,any>)=>{d.kind='revoke';}],['key',(d:Record<string,any>)=>{d.key='other_recovery_key_0001';}],
    ['issuer',(d:Record<string,any>)=>{d.issuer='https://other.clerk.accounts.dev';}],['environment',(d:Record<string,any>)=>{d.environment='production';}],
    ['stale',(d:Record<string,any>)=>{d.respondedAt=new Date(Date.now()-60000).toISOString();}],['future',(d:Record<string,any>)=>{d.respondedAt=new Date(Date.now()+60000).toISOString();}],
    ['extension',(d:Record<string,any>)=>{d.identity={actorId:'owner_a'};}],['private error field',(d:Record<string,any>)=>{d.outcome.message='private detail';}],
  ] as const)('rejects response affinity alteration: %s',async(_label,change)=>{
    const fetch=vi.fn(async(request:Request)=>{const data=await(await fetchPrivate(request)).json() as Record<string,any>;change(data);return Response.json(data,{headers});});
    await expect(adapter(publicRequest(),fetch).close(token,key,intent,trace)).rejects.toMatchObject({code:'DURABLE_SERVICE_UNAVAILABLE'});expect(fetch).toHaveBeenCalledOnce();
  });
  it.each([
    ['organization',(d:Record<string,any>)=>{d.organizationId='other_org';}],['actor',(d:Record<string,any>)=>{d.reviewer.actorId='other_actor';}],
    ['membership',(d:Record<string,any>)=>{d.reviewer.externalMembershipId='other_membership';}],['kind',(d:Record<string,any>)=>{d.kind='revoke';}],
    ['key',(d:Record<string,any>)=>{d.key='other_recovery_key_0001';}],['environment',(d:Record<string,any>)=>{d.environment='production';}],
    ['future fence',(d:Record<string,any>)=>{d.fence.closedAt=new Date(Date.now()+60000).toISOString();}],
    ['old observation',(d:Record<string,any>)=>{d.observedAt=new Date(Date.now()-60000).toISOString();d.fence.closedAt=d.observedAt;}],
    ['future observation',(d:Record<string,any>)=>{d.observedAt=new Date(Date.now()+60000).toISOString();}],
    ['private field',(d:Record<string,any>)=>{d.fence.sessionId='private_session';}],
  ] as const)('rejects a malformed or mismatched closure result: %s',async(_label,change)=>{
    const value=result();change(value as Record<string,any>);gateway.close.mockResolvedValue(value);
    await expect(adapter().close(token,key,intent,trace)).rejects.toMatchObject({code:'DURABLE_SERVICE_UNAVAILABLE'});
  });
  it('rejects private error details and financial contamination in recorded operation data',async()=>{
    for(const change of [(value:Operation)=>{value.financialState='CONFIRMED';},(value:Operation)=>{value.environment='production';},
      (value:Operation)=>{value.error={code:'private-driver-detail',retryable:false,detailRef:null};}]){
      const value=result('recorded');if(value.disposition==='recorded')change(value.operation);gateway.get.mockResolvedValue(value);
      await expect(adapter(publicRequest(`/v1/member-access/recovery?kind=grant&key=${key}`,'GET')).get(token,{kind:'grant',key},trace)).rejects.toMatchObject({code:'DURABLE_SERVICE_UNAVAILABLE'});
    }
  });
  it('rejects concurrent response swaps with the same token, key and intent',async()=>{
    const waiting:{response:Response;resolve:(response:Response)=>void}[]=[];
    const fetch=vi.fn(async(request:Request)=>{const response=await fetchPrivate(request);return new Promise<Response>(resolve=>{
      waiting.push({response,resolve});if(waiting.length===2){waiting[0]!.resolve(waiting[1]!.response);waiting[1]!.resolve(waiting[0]!.response);}
    });});
    const results=await Promise.allSettled([1,2].map(()=>adapter(publicRequest(),fetch).close(token,key,intent,trace)));
    expect(results.map(value=>value.status)).toEqual(['rejected','rejected']);expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each([false,true])('rejects a replayed %s error/success receipt',async denied=>{
    if(denied)gateway.close.mockRejectedValue(new DomainError('FORBIDDEN',403,'private details'));
    let saved:Response|undefined;const fetch=vi.fn(async(request:Request)=>{saved??=await fetchPrivate(request);return saved.clone();});
    const service=adapter(publicRequest(),fetch);
    if(denied)await expect(service.close(token,key,intent,trace)).rejects.toMatchObject({code:'FORBIDDEN'});else await expect(service.close(token,key,intent,trace)).resolves.toMatchObject({disposition:'fenced'});
    await expect(service.close(token,key,intent,trace)).rejects.toMatchObject({code:'DURABLE_SERVICE_UNAVAILABLE'});expect(gateway.close).toHaveBeenCalledOnce();
  });
  it.each([['AUTH_REQUIRED',401],['FORBIDDEN',403],['STEP_UP_REQUIRED',403],['NOT_FOUND',404],['VERSION_CONFLICT',409],['IDEMPOTENCY_CONFLICT',409],
    ['ACCESS_KEY_FENCED',409],['VALIDATION_FAILED',422],['SETUP_REQUIRED',503],['IDENTITY_UNAVAILABLE',503],['DURABLE_SERVICE_UNAVAILABLE',503]] as const)(
    'preserves only the fixed bound %s error',async(code,status)=>{
      gateway.close.mockRejectedValue(new DomainError(code,status,'private-provider-detail'));
      await expect(adapter().close(token,key,intent,trace)).rejects.toMatchObject({code,status,message:expect.not.stringContaining('private-provider-detail')});
    });
  it('sanitizes unknown/misclassified errors, raw binding throws and unbound error JSON',async()=>{
    for(const failure of [new Error('private driver'),new DomainError('FORBIDDEN',503,'private wrong status'),new DomainError('PRIVATE_CODE',403,'private message')]){
      gateway.close.mockRejectedValue(failure);await expect(adapter().close(token,key,intent,trace)).rejects.toMatchObject({code:'DURABLE_SERVICE_UNAVAILABLE'});
    }
    for(const fetch of [async()=>{throw new DomainError('FORBIDDEN',403,'private binding throw');},async()=>Response.json({error:{code:'FORBIDDEN'}},{status:403})])
      await expect(adapter(publicRequest(),fetch).close(token,key,intent,trace)).rejects.toMatchObject({code:'DURABLE_SERVICE_UNAVAILABLE'});
  });
  it('requires matching HTTP status and no-store JSON',async()=>{
    for(const alter of [(response:Response)=>new Response(response.body,{status:201,headers:response.headers}),
      (response:Response)=>{response.headers.set('Cache-Control','public, max-age=60');return response;},
      (response:Response)=>{response.headers.set('Content-Type','text/plain');return response;}])
      await expect(adapter(publicRequest(),async request=>alter(await fetchPrivate(request))).close(token,key,intent,trace)).rejects.toMatchObject({code:'DURABLE_SERVICE_UNAVAILABLE'});
    gateway.close.mockRejectedValue(new DomainError('FORBIDDEN',403,'private detail'));
    await expect(adapter(publicRequest(),async request=>{const response=await fetchPrivate(request);return new Response(response.body,{status:409,headers:response.headers});}).close(token,key,intent,trace)).rejects.toMatchObject({code:'DURABLE_SERVICE_UNAVAILABLE'});
  });
  it('bounds oversized and stalled service responses without replaying the action',async()=>{
    const cancel=vi.fn(),fetch=vi.fn(async()=>new Response(new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array(accessRecoveryResponseBytes+1));},cancel})));
    await expect(adapter(publicRequest(),fetch).close(token,key,intent,trace)).rejects.toMatchObject({code:'DURABLE_SERVICE_UNAVAILABLE'});
    expect(fetch).toHaveBeenCalledOnce();expect(cancel).toHaveBeenCalledOnce();
    vi.useFakeTimers();
    try{const stalled=vi.fn(async()=>new Response(new ReadableStream({cancel}))),rejection=expect(adapter(publicRequest(),stalled).close(token,key,intent,trace)).rejects.toMatchObject({code:'DURABLE_SERVICE_UNAVAILABLE'});
      await vi.waitFor(()=>expect(stalled).toHaveBeenCalledOnce());await vi.advanceTimersByTimeAsync(20001);await rejection;expect(stalled).toHaveBeenCalledOnce();
    }finally{vi.useRealTimers();}
  });
  it('rejects an observation that becomes stale while its valid envelope is in transit',async()=>{
    vi.useFakeTimers();
    try {
      gateway.close.mockImplementation(async()=>{const value=result();value.observedAt=new Date(Date.now()-4000).toISOString();if(value.disposition==='fenced')value.fence.closedAt=value.observedAt;return value;});
      const prepared=vi.fn(),fetch=vi.fn(async(request:Request)=>{const response=await fetchPrivate(request);prepared();await new Promise(resolve=>setTimeout(resolve,17000));return response;});
      const rejection=expect(adapter(publicRequest(),fetch).close(token,key,intent,trace)).rejects.toMatchObject({code:'DURABLE_SERVICE_UNAVAILABLE'});
      await vi.waitFor(()=>expect(prepared).toHaveBeenCalledOnce());await vi.advanceTimersByTimeAsync(17001);await rejection;
      expect(fetch).toHaveBeenCalledOnce();expect(gateway.close).toHaveBeenCalledOnce();
    }finally{vi.useRealTimers();}
  });
  it('turns an oversized privileged result into a small bound unavailable response',async()=>{
    const value=result('recorded');if(value.disposition==='recorded')value.operation.evidenceRefs=Array(10000).fill('history_reference');gateway.close.mockResolvedValue(value);
    await expect(adapter().close(token,key,intent,trace)).rejects.toMatchObject({code:'DURABLE_SERVICE_UNAVAILABLE'});expect(gateway.close).toHaveBeenCalledOnce();
  });
});

describe('private recovery intake',()=>{
  it('rejects caller proof, scope, duplicates and extra fields before constructing the private gateway',async()=>{
    const valid=input();
    for(const value of [{...valid,identity:{roles:['owner']}},{...valid,evidence:{verified:true}},{...valid,nonce:'not-a-nonce'},
      {...valid,action:{...valid.action,scope:{actorId:'owner_a'}}},{...valid,action:{...valid.action,intent:{...intent,key}}},
      {...valid,action:{...valid.action,intent:{...intent,expectedAuthorityEpoch:null}}},{...valid,action:{...valid.action,kind:'grant'}},
      {...valid,request:{...valid.request,method:'GET'}},{...valid,request:{...valid.request,url:'https://api.example/v1/member-access/recovery/close?x=1'}},
      {...valid,action:{kind:'get',query:{kind:'grant',key}},request:{...valid.request,method:'GET',url:`https://api.example/v1/member-access/recovery?kind=grant&kind=grant&key=${key}`}}])
      expect((await fetchPrivate(privateRequest(value))).status).toBe(422);
    expect(factory).not.toHaveBeenCalled();
  });
  it('requires the exact internal POST route and original bearer',async()=>{
    for(const request of [new Request(accessRecoveryUrl),new Request(`${accessRecoveryUrl}?x=1`,{method:'POST'}),new Request('https://public.example/internal/access-recovery/dispatch',{method:'POST'})])expect((await fetchPrivate(request)).status).toBe(404);
    expect((await fetchPrivate(privateRequest(input(),{Authorization:'','X-Actor-Id':'owner_a'}))).status).toBe(401);expect(factory).not.toHaveBeenCalled();
  });
  it('rejects invalid encoding, media type, size and slow bodies before a gateway exists',async()=>{
    for(const request of [privateRequest(input(),{'Content-Type':'text/plain'}),privateRequest(input(),{'Content-Length':'invalid'}),
      privateRequest(input(),{'Content-Length':String(accessRecoveryRequestBytes+1)}),privateRequest({padding:'x'.repeat(accessRecoveryRequestBytes+1)}),
      new Request(accessRecoveryUrl,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:new Uint8Array([0xff])})])expect((await fetchPrivate(request)).status).toBe(422);
    vi.useFakeTimers();
    try{const cancel=vi.fn(),request=new Request(accessRecoveryUrl,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:new ReadableStream({cancel}),duplex:'half'} as RequestInit),pending=fetchPrivate(request);
      await vi.advanceTimersByTimeAsync(5001);expect((await pending).status).toBe(422);expect(cancel).toHaveBeenCalledOnce();
    }finally{vi.useRealTimers();}
    expect(factory).not.toHaveBeenCalled();
  });
});
