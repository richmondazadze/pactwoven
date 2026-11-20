import type { Hono } from 'hono';
import { z } from 'zod';
import { IdSchema } from '@pactwoven/contracts';
import { DomainError } from '@pactwoven/domain';
import { HashSchema } from '../../../packages/contracts/src/financial';
import type { NativePaidQuoteService } from './native-paid-quote-service';
import type { ApiEnv } from './app';
import { query } from './native-work-intent-routes';
import type { PostgresPaidToolContributorsRepository } from '../../../packages/db/src/paid-tool-contributors-repository';
import { NativePaidContributorsSchema } from '../../../packages/contracts/src/native-paid-contributors';
export type NativePaidQuoteGateway=Pick<NativePaidQuoteService,'discover'|'review'|'approve'|'recover'>;
export type NativePaidContributorsReader=Pick<PostgresPaidToolContributorsRepository,'read'>;
const Review=z.strictObject({siteId:IdSchema,quoteId:IdSchema,reviewId:IdSchema});
const Approval=Review.extend({reviewHash:HashSchema,commandKey:IdSchema,authorizeExactPayment:z.literal(true)});
const Recovery=Approval.omit({quoteId:true,authorizeExactPayment:true});
export function isNativePaidQuoteRoute(path:string,method:string){
  return /^\/v1\/agent-work\/[A-Za-z0-9_-]+\/equipment(?:\/contributors)?$/.test(path)&&['GET','OPTIONS'].includes(method)||
    /^\/v1\/agent-work\/[A-Za-z0-9_-]+\/equipment\/(?:review|approve|recover)$/.test(path)&&['POST','OPTIONS'].includes(method);
}
export function registerNativePaidQuoteRoutes(app:Hono<ApiEnv>,gateway?:NativePaidQuoteGateway,contributors?:NativePaidContributorsReader){
  const ready=()=>{if(!gateway)throw new DomainError('SETUP_REQUIRED',503,'Equipment payment reviews are not connected yet.');return gateway;};
  const base='/v1/agent-work/:root/equipment';
  app.get(base+'/contributors',async c=>{
    c.header('Cache-Control','private, no-store');
    const {siteId}=z.strictObject({siteId:IdSchema}).parse(query(c.req.url)),root=IdSchema.parse(c.req.param('root')),session=c.get('session');
    if(session.actor.environment!=='development'||session.actor.principalKind!=='human'||!session.actor.siteIds.includes(siteId)||!session.sites.some(site=>site.id===siteId))
      throw new DomainError('FORBIDDEN',403,'Current workspace access is required for recorded contributions.');
    if(!contributors)throw new DomainError('SETUP_REQUIRED',503,'Recorded contributions are not connected yet.');
    const frame=NativePaidContributorsSchema.parse(await contributors.read(session.actor,root,siteId));
    if(frame.scope.environment!=='development'||frame.scope.organizationId!==session.actor.organizationId||frame.scope.siteId!==siteId||frame.rootTaskId!==root)
      throw new DomainError('EVIDENCE_STALE',409,'Recorded contributions did not match this work.');
    return c.json(frame);
  });
  app.get(base,async c=>{
    const {siteId}=z.strictObject({siteId:IdSchema}).parse(query(c.req.url));
    return c.json(await ready().discover(c.get('session'),IdSchema.parse(c.req.param('root')),siteId));
  });
  app.post(base+'/review',async c=>{
    z.strictObject({}).parse(query(c.req.url));const {siteId,quoteId,reviewId}=Review.parse(c.get('requestBody'));
    return c.json(await ready().review(c.get('session'),IdSchema.parse(c.req.param('root')),siteId,quoteId,reviewId));
  });
  app.post(base+'/approve',async c=>{
    z.strictObject({}).parse(query(c.req.url));const {siteId,authorizeExactPayment:_,...input}=Approval.parse(c.get('requestBody'));
    return c.json(await ready().approve(c.get('session'),IdSchema.parse(c.req.param('root')),siteId,input));
  });
  app.post(base+'/recover',async c=>{
    z.strictObject({}).parse(query(c.req.url));const {siteId,...input}=Recovery.parse(c.get('requestBody'));
    return c.json(await ready().recover(c.get('session'),IdSchema.parse(c.req.param('root')),siteId,input));
  });
}
