import { Hono } from 'hono';
import { ZodError } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import { DomainError } from '@pactwoven/domain';
import type { ApiEnv } from './app';
import { registerNativePaidToolRoutes, isNativePaidToolHttpRoute } from './native-paid-tool-routes';
import { equipmentReceiptFixture } from './native-paid-equipment.test-fixture';

async function fixture(){
  const f=await equipmentReceiptFixture(),app=new Hono<ApiEnv>();
  app.use('*',async(c,next)=>{if(c.req.header('Authorization')!=='Bearer fixture')return c.json({error:'UNAUTHENTICATED'},401);c.set('session',f.session);await next();});
  app.onError((error,c)=>error instanceof DomainError?c.json({error:error.code},error.status as 403|409|503):error instanceof ZodError?c.json({error:'VALIDATION_FAILED'},422):c.json({error:'UNEXPECTED'},500));
  const reader={read:vi.fn((...args:Parameters<typeof f.service.read>)=>f.service.read(...args))};
  registerNativePaidToolRoutes(app,f.human as never,()=>f.now,reader);
  const request=(path='/v1/agent-work/root/purchases/operation/equipment?siteId=site',method='GET')=>app.request(path,{method,headers:{Authorization:'Bearer fixture'}});
  return{...f,app,reader,request};
}
describe('read-only itemized equipment HTTP route',()=>{
  it('returns private noncached exact items on a separate backwards-compatible route',async()=>{
    const f=await fixture(),r=await f.request();expect(r.status).toBe(200);expect(r.headers.get('Cache-Control')).toBe('private, no-store');
    const b=await r.json();expect(b.selection.items).toHaveLength(4);expect(b.operationId).toBe('operation');
  });
  it('authenticates before any receipt read',async()=>{
    const f=await fixture();expect((await f.app.request('/v1/agent-work/root/purchases/operation/equipment?siteId=site')).status).toBe(401);expect(f.human.read).not.toHaveBeenCalled();
  });
  it.each(['?siteId=site&siteId=site','?siteId=site&owner=true',''])('rejects ambiguous or missing filters%s before reads',async(query)=>{
    const f=await fixture();expect((await f.request('/v1/agent-work/root/purchases/operation/equipment'+query)).status).toBe(422);expect(f.reader.read).not.toHaveBeenCalled();
  });
  it.each(['root','operation','site'])('rejects cross%s URL affinity',async(part)=>{
    const f=await fixture();const path=`/v1/agent-work/${part==='root'?'foreign':'root'}/purchases/${part==='operation'?'foreign':'operation'}/equipment?siteId=${part==='site'?'foreign':'site'}`;
    expect([403,409]).toContain((await f.request(path)).status);expect(f.roots.quote).not.toHaveBeenCalled();
  });
  it('rejects an unrelated projected DTO response',async()=>{
    const f=await fixture(),value=await f.service.read(f.session,'root','site','operation');value.operationId='foreign';f.reader.read.mockResolvedValue(value);
    expect((await f.request()).status).toBe(409);
  });
  it('never opens a payment mutation route or accepts POST',async()=>{
    const f=await fixture(),path='/v1/agent-work/root/purchases/operation/equipment';expect(isNativePaidToolHttpRoute(path,'GET')).toBe(true);expect(isNativePaidToolHttpRoute(path,'OPTIONS')).toBe(true);expect(isNativePaidToolHttpRoute(path,'POST')).toBe(false);
    expect((await f.request(path+'?siteId=site','POST')).status).toBe(404);expect(f.reader.read).not.toHaveBeenCalled();
  });
});
