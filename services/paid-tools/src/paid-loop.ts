import { IdSchema } from '../../../packages/contracts/src/core.js';
import { PaidToolPrivateReadSchema } from '../../../packages/db/src/paid-tool-schema.js';
export type PaidToolLoopPorts={
 read(operationId:string):Promise<unknown>;
 fundAndReserve(operationId:string,signal:AbortSignal):Promise<unknown>;
 sign(operationId:string,signal:AbortSignal):Promise<unknown>;
 recoverSigned(operationId:string,signal:AbortSignal):Promise<unknown>;
 broadcast(operationId:string,signal:AbortSignal):Promise<unknown>;
 reconcile(operationId:string,signal:AbortSignal):Promise<unknown>;
 deliver(operationId:string,signal:AbortSignal):Promise<unknown>;
};
export type PaidToolLoopResult={operationId:string;version:number|null;status:string;disposition:'progressed'|'waiting'|'completed'|'cancelled'|'reconciliation_required'|'interrupted';nextWakeAfterMs:number|null};
/** One durable stored stage per wake. This module is not a queue/outbox: callers
 * must persist scheduling via their runtime. No raw wire or authority comes from
 * a queue payload, and uncertain effects are never retried by this driver. */
export class PaidToolOperationDriver{
 constructor(private readonly ports:PaidToolLoopPorts,private readonly now:()=>number=Date.now){}
 async advance(operationId:string,signal:AbortSignal):Promise<PaidToolLoopResult>{
  IdSchema.parse(operationId);
  const answer=(status:string,version:number|null,disposition:PaidToolLoopResult['disposition'],nextWakeAfterMs:number|null):PaidToolLoopResult=>({operationId,status,version,disposition,nextWakeAfterMs});
  if(signal.aborted)return answer('unknown',null,'interrupted',null);
  let before:ReturnType<typeof PaidToolPrivateReadSchema.parse>;
  try{before=PaidToolPrivateReadSchema.parse(await this.ports.read(operationId));if(before.snapshot.operationId!==operationId)throw Error('affinity');}
  catch{return answer('unknown',null,'reconciliation_required',4000);}
  const old=before.snapshot;
  if(old.status==='completed')return answer(old.status,old.version,'completed',null);
  if(old.status==='cancelled')return answer(old.status,old.version,'cancelled',null);
  if(signal.aborted)return answer(old.status,old.version,'interrupted',null);
  if(['authorized','reserved','signed'].includes(old.status)&&this.now()>=Date.parse(old.review.expiresAt))return answer(old.status,old.version,'reconciliation_required',null);
  let failed=false;
  try{
   switch(old.status){
    case 'authorized':await this.ports.fundAndReserve(operationId,signal);break;
    case 'reserved':await this.ports.sign(operationId,signal);break;
    case 'signing':await this.ports.recoverSigned(operationId,signal);break;
    case 'signed':await this.ports.broadcast(operationId,signal);break;
    case 'submitting':case 'payment_pending':await this.ports.reconcile(operationId,signal);break;
    case 'outcome_unknown':if(old.attempt)await this.ports.reconcile(operationId,signal);else await this.ports.recoverSigned(operationId,signal);break;
    case 'payment_confirmed':await this.ports.deliver(operationId,signal);break;
   }
  }catch{failed=true;}
  let after:ReturnType<typeof PaidToolPrivateReadSchema.parse>;
  try{after=PaidToolPrivateReadSchema.parse(await this.ports.read(operationId));if(after.snapshot.operationId!==operationId||after.snapshot.version<old.version||
    after.snapshot.review.reviewHash!==old.review.reviewHash||after.snapshot.review.rootTaskId!==old.review.rootTaskId||after.snapshot.review.instructionRevision!==old.review.instructionRevision)throw Error('affinity');}
  catch{return answer(old.status,old.version,'reconciliation_required',4000);}
  const current=after.snapshot;
  if(current.status==='completed')return answer(current.status,current.version,'completed',null);
  if(current.status==='cancelled')return answer(current.status,current.version,'cancelled',null);
  if(current.version>old.version)return answer(current.status,current.version,'progressed',current.status==='signing'?null:1000);
  if(['submitting','payment_pending'].includes(current.status)||current.status==='outcome_unknown'&&current.attempt)return answer(current.status,current.version,failed?'reconciliation_required':'waiting',4000);
  if(current.status==='signing'||current.status==='outcome_unknown')return answer(current.status,current.version,'reconciliation_required',null);
  // Failed reserve/sign/broadcast calls require a fresh scheduled read; retrying
  // the same side effect inside this invocation would bypass durable recovery.
  return answer(current.status,current.version,'reconciliation_required',failed?4000:null);
 }
}
