import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { apiRequest, RequestError } from './api';
const record = z.strictObject({ id: z.string() });
describe('authenticated API boundary', () => {
  beforeEach(()=>vi.stubEnv('NEXT_PUBLIC_API_BASE_URL','https://api.example.test'));
  afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});
  it('does not send a request without an authenticated token', async()=>{
    const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
    await expect(apiRequest('/v1/session',record,async()=>null)).rejects.toMatchObject({code:'SESSION_REQUIRED'});
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('does not leak a token to an unsafe configured URL',async()=>{
    vi.stubEnv('NEXT_PUBLIC_API_BASE_URL','http://outside.example.test');const token=vi.fn(async()=>'token');
    await expect(apiRequest('/v1/session',record,token)).rejects.toMatchObject({code:'API_NOT_CONFIGURED'});
    expect(token).not.toHaveBeenCalled();
  });
  it('does not send a stale request after its context is aborted while obtaining a token',async()=>{
    const controller=new AbortController(),fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
    const token=async()=>{controller.abort();return 'old-scope-token';};
    await expect(apiRequest('/v1/organizations/bootstrap',record,token,{signal:controller.signal,body:{payload:{}}})).rejects.toMatchObject({name:'AbortError'});
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('preserves mutation identity and does not retry after a lost response',async()=>{
    const fetcher=vi.fn().mockRejectedValue(new TypeError('connection lost'));vi.stubGlobal('fetch',fetcher);
    await expect(apiRequest('/v1/responsibilities',record,async()=>'verified-token',{body:{payload:{title:'A responsibility'}},idempotencyKey:'request_123456789'})).rejects.toMatchObject({code:'NETWORK_UNAVAILABLE'});
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({method:'POST',credentials:'omit',cache:'no-store',headers:{Authorization:'Bearer verified-token','Idempotency-Key':'request_123456789'}});
  });
  it('checks current action conditions after the final token handoff and does not turn rejection into network uncertainty',async()=>{
    let allowed=true;const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
    const failure=new RequestError('REVIEW_CHANGED','Review the current state again.');
    const token=async()=>{await Promise.resolve();queueMicrotask(()=>{allowed=false;});return 'verified-token';};
    await expect(apiRequest('/v1/member-access/recovery/close',record,token,{body:{},beforeDispatch:()=>{if(!allowed)throw failure;}})).rejects.toBe(failure);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('calls the synchronous guard once immediately before the only fetch',async()=>{
    const order:string[]=[];vi.stubGlobal('fetch',vi.fn(async()=>{order.push('fetch');return Response.json({id:'receipt'});}));
    const result=await apiRequest('/v1/member-access/recovery/close',record,async()=>{order.push('token');return 'verified-token';},{body:{},beforeDispatch:()=>{order.push('guard');}});
    expect(result).toEqual({id:'receipt'});expect(order).toEqual(['token','guard','fetch']);
  });
  it('does not turn an unrecognized successful response into an application record',async()=>{
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({success:true}),{status:200})));
    await expect(apiRequest('/v1/responsibilities/test',record,async()=>'token')).rejects.toMatchObject({code:'RESPONSE_UNVERIFIED'});
  });
  it('preserves structured denial and correlation without retrying',async()=>{
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({error:{code:'FORBIDDEN',message:'Assigned site required',correlationId:'correlation-1'}}),{status:403})));
    await expect(apiRequest('/v1/responsibilities/test',record,async()=>'token')).rejects.toMatchObject({status:403,code:'FORBIDDEN',correlationId:'correlation-1'});
  });
});
