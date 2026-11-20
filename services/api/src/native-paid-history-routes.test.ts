import {Hono} from 'hono';
import {ZodError} from 'zod';
import {describe,it,expect,vi} from 'vitest';
import {DomainError} from '@pactwoven/domain';
import type {ApiEnv} from './app';
import {registerNativePaidToolRoutes,isNativePaidToolHttpRoute} from './native-paid-tool-routes';
import {NativePaidHistoryResponseSchema} from '../../../packages/contracts/src/native-paid-history';
import {equipmentReceiptFixture} from './native-paid-equipment.test-fixture';
const path='/v1/agent-work/root/purchases/operation/history';
async function fixture(){
 const f=await equipmentReceiptFixture(),equipment=await f.service.read(f.session,'root','site','operation');
 const record=NativePaidHistoryResponseSchema.parse({kind:'recorded',scope:equipment.scope,rootTaskId:'root',operationId:'operation',instructionRevision:0,completedAt:'2026-11-19T16:02:00Z',evidenceValidUntil:'2026-11-19T16:05:00Z',freshness:'historical',authority:'none',sourcePolicy:'public_or_operator_only_v1',advice:{title:'Equipment plan',summary:'Use the selected sample package.',artifacts:[{id:'advice',title:'Preparation',text:'Confirm the room layout.'}]},equipment:equipment.selection,payment:{signature:f.snapshot.payment.signature,amountBaseUnits:'10000',feeLamports:'5000',finalizedAt:f.now,slot:'123'},provenance:{completionDigest:'a'.repeat(64),requestHash:f.snapshot.delivery.requestHash,resourceHash:f.snapshot.delivery.resourceHash,resultHash:f.snapshot.delivery.resultHash,catalogue:'controlled_demo_catalogue',sources:[]}});
 f.human.read.mockClear();
 const read=vi.fn(async()=>record),app=new Hono<ApiEnv>();
 app.use('*',async(c,next)=>{if(c.req.header('authorization')!=='Bearer fixture')return c.json({error:'UNAUTHENTICATED'},401);c.set('session',f.session);await next();});
 app.onError((error,c)=>error instanceof DomainError?c.json({error:error.code},error.status as 403|409|503):error instanceof ZodError?c.json({error:'VALIDATION_FAILED'},422):c.json({error:'UNEXPECTED'},500));
 registerNativePaidToolRoutes(app,f.human as never,undefined,undefined,{read});
 return {...f,record,read,app,get:(suffix='?siteId=site')=>app.request(path+suffix,{headers:{authorization:'Bearer fixture'}})};
}
describe('saved public completion HTTP boundary',()=>{
 it('returns immutable historical advice after freshness expiry without current receipt/source or write calls',async()=>{const f=await fixture();for(let i=0;i<2;i++){const r=await f.get();expect(r.status).toBe(200);expect(r.headers.get('cache-control')).toBe('private, no-store');expect(await r.json()).toEqual(f.record);}expect(f.read).toHaveBeenCalledWith(f.session.actor,'root','site','operation');expect(f.human.read).not.toHaveBeenCalled();});
 it('requires authentication before reading',async()=>{const f=await fixture();expect((await f.app.request(path+'?siteId=site')).status).toBe(401);expect(f.read).not.toHaveBeenCalled();});
 it.each(['','?siteId=site&siteId=site','?siteId=site&organizationId=foreign'])('rejects invalid filters %s',async query=>{const f=await fixture();expect((await f.get(query)).status).toBe(422);expect(f.read).not.toHaveBeenCalled();});
 it.each(['agent','production','site','visibleSite'])('rejects changed reader %s before lookup',async kind=>{const f=await fixture();if(kind==='agent')f.session.actor.principalKind='agent' as never;else if(kind==='production')f.session.actor.environment='production';else if(kind==='site')f.session.actor.siteIds=[];else f.session.sites=[];expect((await f.get()).status).toBe(403);expect(f.read).not.toHaveBeenCalled();});
 it.each(['organizationId','siteId','rootTaskId','operationId'])('rejects a mismatched response %s',async field=>{const f=await fixture();const v=structuredClone(f.record);if(field==='organizationId'||field==='siteId')v.scope[field]='foreign';else v[field as 'rootTaskId'|'operationId']='foreign';f.read.mockResolvedValue(v);expect((await f.get()).status).toBe(409);});
 it('returns unavailable without fabricating retained content',async()=>{const f=await fixture();f.read.mockResolvedValue({kind:'unavailable',scope:f.record.scope,rootTaskId:'root',operationId:'operation',reason:'not_retained'});const r=await f.get();expect(r.status).toBe(200);expect((await r.json()).kind).toBe('unavailable');});
 it.each(['POST','PATCH','PUT','DELETE'])('exposes no history mutation %s',async method=>{const f=await fixture();expect(isNativePaidToolHttpRoute(path,method)).toBe(false);expect((await f.app.request(path+'?siteId=site',{method,headers:{authorization:'Bearer fixture'}})).status).toBe(404);expect(f.read).not.toHaveBeenCalled();});
});
