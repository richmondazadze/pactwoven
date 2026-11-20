import type { Hono } from 'hono';
import { z } from 'zod';
import { IdSchema, IdempotencyKeySchema } from '@pactwoven/contracts';
import { DomainError } from '@pactwoven/domain';
import { commandDigest } from '../../../packages/contracts/src/canonical';
import { NativeWorkIntentSessionObservationSchema } from '../../../packages/contracts/src/native-work-intent';
import { PaidToolIntentPolicySchema, PaidToolIntentPrepareSchema, PaidToolIntentPrepareResponseSchema,
  PaidToolIntentConfirmSchema, PaidToolIntentConfirmResponseSchema, PaidToolIntentRecoveryResponseSchema } from '../../../packages/contracts/src/native-paid-work-intent';
import type { PostgresPaidToolIntentRepository } from '../../../packages/db/src/paid-tool-intent-repository';
import { query, eligible, sameScope, checkReview, checkOperation } from './native-work-intent-routes';
import type { ApiEnv } from './app';

export type NativePaidWorkIntentRepository = Pick<PostgresPaidToolIntentRepository, 'prepare'|'confirm'|'recover'>;
export type NativePaidWorkPolicy = z.infer<typeof PaidToolIntentPolicySchema>;
const base='/v1/agent-work/paid';
const unavailable=()=>new DomainError('DURABLE_SERVICE_UNAVAILABLE',503,'Recover the original equipment work request before trying again.');
async function checkPolicy(reviewId:string,reviewToken:string,paidPolicy:NativePaidWorkPolicy & {policyReviewHash:string}){
  const {policyReviewHash,...policy}=paidPolicy;
  if(policyReviewHash!==await commandDigest({namespace:'pactwoven.paid-intent-review.v1',workReviewId:reviewId,workReviewToken:reviewToken,policy}))throw unavailable();
}
export function isNativePaidWorkIntentRoute(path:string,method:string){
  return (/^\/v1\/agent-work\/paid\/options$/.test(path)&&['GET','OPTIONS'].includes(method)) ||
    (/^\/v1\/agent-work\/paid\/(?:prepare|confirm)$/.test(path)&&['POST','OPTIONS'].includes(method)) ||
    (/^\/v1\/agent-work\/paid\/operations\/[A-Za-z0-9_-]+$/.test(path)&&['GET','OPTIONS'].includes(method));
}
/** Fixed planning ceilings are opt-in only. Original work and its ceiling are
 * committed together; no payment permission is issued by these endpoints. */
export function registerNativePaidWorkIntentRoutes(app:Hono<ApiEnv>,repository?:NativePaidWorkIntentRepository,policy?:NativePaidWorkPolicy,organizationId?:string){
  const configured=policy ? PaidToolIntentPolicySchema.parse(policy) : undefined;
  const ready=(write=false)=>{
    if(!repository || write&&(!configured||!organizationId))throw new DomainError('SETUP_REQUIRED',503,'Equipment comparison is not available yet.');
    return repository;
  };
  app.get(base+'/options',c=>{
    z.strictObject({}).parse(query(c.req.url));
    const actor=c.get('session').actor;
    return c.json(repository&&configured&&actor.organizationId===organizationId&&actor.environment==='development'&&actor.principalKind==='human'&&
      actor.actionSiteIds.length>0&&actor.roles.some(r=>r==='owner'||r==='operations')
      ?{enabled:true as const,paidPolicy:configured}:{enabled:false as const});
  });
  app.post(base+'/prepare',async c=>{
    z.strictObject({}).parse(query(c.req.url));
    const input=PaidToolIntentPrepareSchema.parse(c.get('requestBody')), actor=c.get('session').actor;
    const key=IdempotencyKeySchema.parse(c.req.header('Idempotency-Key'));
    eligible(actor,input.work.siteId,true);const repo=ready(true);
    if(actor.environment!=='development'||actor.organizationId!==organizationId||Object.entries(configured!).some(([k,v])=>input.paidPolicy[k as keyof NativePaidWorkPolicy]!==v))
      throw new DomainError('VALIDATION_FAILED',422,'Refresh the equipment comparison limits.');
    const parsed=PaidToolIntentPrepareResponseSchema.safeParse(await repo.prepare(actor,key,input));
    if(!parsed.success)throw unavailable();
    const value=parsed.data; sameScope(actor,value.work.scope,input.work.siteId);checkReview(value.work.review);
    await checkPolicy(value.work.review.id,value.work.review.token,value.paidPolicy);
    if(Object.entries(input.paidPolicy).some(([k,v])=>value.paidPolicy[k as keyof NativePaidWorkPolicy]!==v)||
      value.work.review.body.title!==input.work.title||value.work.review.body.prompt!==input.work.prompt||
      value.work.review.body.selectedNotes.length!==input.work.selections.length||
      value.work.review.body.selectedNotes.some(note=>!input.work.selections.some(x=>x.noteId===note.noteId)))throw unavailable();
    if(value.work.operation)checkOperation(actor,value.work.operation,value.work.scope,value.work.review);
    return c.json(value);
  });
  app.post(base+'/confirm',async c=>{
    z.strictObject({}).parse(query(c.req.url));
    const input=PaidToolIntentConfirmSchema.parse(c.get('requestBody')),actor=c.get('session').actor;
    const key=IdempotencyKeySchema.parse(c.req.header('Idempotency-Key'));eligible(actor,undefined,true);const repo=ready(true);
    if(actor.organizationId!==organizationId)throw new DomainError('FORBIDDEN',403,'Equipment comparison is not enabled for this workspace.');
    const verified=c.get('identityObservation');
    if(!verified||verified.identity.sessionId!==actor.sessionId||verified.identity.authenticatedAt!==actor.authenticatedAt)
      throw new DomainError('IDENTITY_UNAVAILABLE',503,'Current sign-in verification is required before starting background work.');
    const observation=NativeWorkIntentSessionObservationSchema.safeParse({providerIssuer:verified.observation.issuer,
      sessionVerifiedAt:verified.observation.observedAt,sessionExpiresAt:verified.observation.expiresAt});
    const now=Date.now();
    if(!observation.success||Date.parse(observation.data.sessionVerifiedAt)>now||Date.parse(observation.data.sessionVerifiedAt)<now-20000||
      Date.parse(observation.data.sessionExpiresAt)<=now)throw new DomainError('AUTH_REQUIRED',401,'Refresh your sign-in before confirming this review.');
    const parsed=PaidToolIntentConfirmResponseSchema.safeParse(await repo.confirm(actor,key,input,observation.data));
    if(!parsed.success||parsed.data.work.reviewId!==input.work.reviewId||parsed.data.paidPolicy.policyReviewHash!==input.policyReviewHash)throw unavailable();
    await checkPolicy(input.work.reviewId,input.work.reviewToken,parsed.data.paidPolicy);
    sameScope(actor,parsed.data.work.scope);if(!actor.actionSiteIds.includes(parsed.data.work.scope.siteId))throw unavailable();
    checkOperation(actor,parsed.data.work,parsed.data.work.scope);return c.json(parsed.data);
  });
  app.get(base+'/operations/:key',async c=>{
    const {siteId}=z.strictObject({siteId:IdSchema}).parse(query(c.req.url)),key=IdempotencyKeySchema.parse(c.req.param('key'));
    const actor=c.get('session').actor;eligible(actor,siteId);
    const parsed=PaidToolIntentRecoveryResponseSchema.safeParse(await ready().recover(actor,siteId,key));
    if(!parsed.success)throw unavailable();const value=parsed.data;sameScope(actor,value.work.scope,siteId);
    if(value.work.review)checkReview(value.work.review);
    if(value.work.operation)checkOperation(actor,value.work.operation,value.work.scope,value.work.review);
    if((value.work.review||value.work.operation)&& !value.paidPolicy)throw unavailable();
    if(value.work.review&&value.paidPolicy)await checkPolicy(value.work.review.id,value.work.review.token,value.paidPolicy);
    return c.json(value);
  });
}
