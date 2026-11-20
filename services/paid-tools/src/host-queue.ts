import {z} from 'zod';
import {IdSchema} from '../../../packages/contracts/src/core';
import {commandDigest} from '../../../packages/contracts/src/canonical';
import type {PaidToolLoopResult} from './paid-loop';
import {abortable} from './private-signer-protocol';
import {PaidToolDispatchTargetSchema as Target,PaidToolDispatchSelectorSchema as Selector,PaidToolDispatchItemSchema,PaidToolDispatchFinishSchema} from '../../../packages/contracts/src/paid-tool-dispatch';
export const PaidToolQueueMessageSchema=z.strictObject({schemaVersion:z.literal(1),environment:z.literal('development'),target:Target});
export type PaidToolQueueMessage=z.infer<typeof PaidToolQueueMessageSchema>;
export type PaidToolWakeTarget=z.infer<typeof Target>;
export type PaidToolWakeSelector=z.infer<typeof Selector>;
export type PaidToolDispatchRepository={
 dispatchClaim(input:{limit:number;leaseMs:number}):Promise<unknown>;
 ack(target:PaidToolWakeTarget,dispatchToken:string):Promise<boolean>;
 claim(target:PaidToolWakeTarget,input:{leaseMs:number}):Promise<unknown>;
 finish(selector:PaidToolWakeSelector,input:{nextWakeAfterMs:number|null;disposition:'advanced'|'waiting'|'parked'|'complete'}):Promise<boolean>;
 recover(input:{limit:number}):Promise<number>;
};
export type PaidToolQueueSend=(message:PaidToolQueueMessage,options:{idempotencyKey:string;retentionSeconds:number;delaySeconds:number})=>Promise<unknown>;
/** Queue transport only. Acceptance loss retains original outbox identity. */
export async function publishPaidToolWork(options:{repository:PaidToolDispatchRepository;send:PaidToolQueueSend;deadlineAt:number;now?:()=>number}){
 const now=options.now??Date.now,counts={accepted:0,unconfirmed:0};if(!Number.isSafeInteger(options.deadlineAt))throw Error('Dispatch deadline required');
 for(let i=0;i<5&&options.deadlineAt-now()>=20000;i++){
  const rows=z.array(PaidToolDispatchItemSchema).max(1).parse(await options.repository.dispatchClaim({limit:1,leaseMs:30000}));if(!rows.length)break;
  const item=rows[0]!;if(options.deadlineAt-now()<15000){counts.unconfirmed++;break;}
  const message=PaidToolQueueMessageSchema.parse({schemaVersion:1,environment:'development',target:item.target}),idempotencyKey=await commandDigest({namespace:'pactwoven/paid-tool-queue/v1',environment:'development',target:item.target});
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),Math.min(10000,Math.max(1,options.deadlineAt-now()-5000)));
  try{await abortable(options.send(message,{idempotencyKey,retentionSeconds:86400,delaySeconds:item.delaySeconds}),controller.signal);if(controller.signal.aborted||options.deadlineAt-now()<1000)throw Error('Dispatch unconfirmed');if(!await options.repository.ack(item.target,item.dispatchToken))throw Error('Dispatch unconfirmed');counts.accepted++;}
  catch{counts.unconfirmed++;break;}finally{clearTimeout(timer);controller.abort();}
 }
 return counts;
}
const LoopResult=z.strictObject({operationId:IdSchema,version:z.number().int().min(1).max(33).nullable(),status:z.string().min(1).max(40),disposition:z.enum(['progressed','waiting','completed','cancelled','reconciliation_required','interrupted']),nextWakeAfterMs:z.number().int().min(1).max(60000).nullable()});
/** A bounded leased stage. SQL finish decides the actual next state and must
 * preserve any newer transition wake. No caller hint is execution authority. */
export async function consumePaidToolWork(payload:unknown,options:{repository:PaidToolDispatchRepository;driver:{advance(operationId:string,signal:AbortSignal):Promise<PaidToolLoopResult>};deadlineAt:number;signal?:AbortSignal;now?:()=>number}):Promise<'discarded'|'finished'|'unconfirmed'>{
 const now=options.now??Date.now,parsed=PaidToolQueueMessageSchema.safeParse(payload);
 if(!parsed.success)return 'discarded';if(!Number.isSafeInteger(options.deadlineAt)||options.deadlineAt-now()<55000||options.signal?.aborted)return 'unconfirmed';
 const claimStartedAt=now(),claim=Selector.nullable().parse(await options.repository.claim(parsed.data.target,{leaseMs:90000}));if(!claim)return 'discarded';
 if(now()<claimStartedAt||now()-claimStartedAt>10000||options.deadlineAt-now()<55000)return 'unconfirmed';
 if(claim.operationId!==parsed.data.target.operationId||claim.generation!==parsed.data.target.generation)return 'unconfirmed';
 const controller=new AbortController(),cancel=()=>controller.abort();options.signal?.addEventListener('abort',cancel,{once:true});if(options.signal?.aborted)cancel();
 const timer=setTimeout(cancel,Math.min(70000,Math.max(1,options.deadlineAt-now()-5000)));
 try{
  controller.signal.throwIfAborted();const result=LoopResult.parse(await abortable(options.driver.advance(claim.operationId,controller.signal),controller.signal));
  if(controller.signal.aborted||options.deadlineAt-now()<1000||result.operationId!==claim.operationId)return 'unconfirmed';
  const disposition=result.disposition==='progressed'?'advanced':result.disposition==='completed'||result.disposition==='cancelled'?'complete':result.disposition==='waiting'||result.nextWakeAfterMs!==null||result.disposition==='interrupted'?'waiting':'parked';
  const nextWakeAfterMs=result.disposition==='interrupted'?4000:result.nextWakeAfterMs;
  return await options.repository.finish(claim,PaidToolDispatchFinishSchema.parse({disposition,nextWakeAfterMs}))?'finished':'unconfirmed';
 }catch{return 'unconfirmed';}finally{clearTimeout(timer);options.signal?.removeEventListener('abort',cancel);controller.abort();}
}
