import { PaidToolCommandResponseSchema } from '../../../packages/db/src/paid-tool-schema';
import { PaidSignerRequestSchema,PaidSignerResponseSchema,paidSignerPath,paidSignerMaximumMilliseconds,boundedSignerJson,abortable } from './private-signer-protocol';
export type PrivateSignerHandlerPorts={
 /** Production mount must supply exact pinned Vercel project JWT verifier. */
 verifyExecutor(request:Request):Promise<boolean>;
 signer:{prepareAndSign(operationId:string,signal:AbortSignal):Promise<unknown>;recoverRetained(operationId:string,signal:AbortSignal):Promise<unknown>};
 now?:()=>number;
};
/** Isolated host only. No browser/session authentication, caller-supplied wire,
 * amount, payee or key is accepted. Failed responses do not promise rollback. */
export function createPrivateSignerHandler(ports:PrivateSignerHandlerPorts){
 const now=ports.now??Date.now;
 const reply=(value:unknown,status:number)=>Response.json(value,{status,headers:{'cache-control':'private, no-store','x-content-type-options':'nosniff'}});
 return async(request:Request):Promise<Response>=>{
  const url=new URL(request.url);
  if(url.pathname!==paidSignerPath||url.search||request.method!=='POST')return reply({error:'NOT_FOUND'},404);
  if(request.headers.has('origin'))return reply({error:'FORBIDDEN'},403);
  const controller=new AbortController(),cancel=()=>controller.abort(),start=now();request.signal.addEventListener('abort',cancel,{once:true});
  if(request.signal.aborted)cancel();const timer=setTimeout(cancel,paidSignerMaximumMilliseconds);
  try{
   if(!await abortable(ports.verifyExecutor(request),controller.signal))return reply({error:'UNAUTHENTICATED'},401);
   const parsed=PaidSignerRequestSchema.safeParse(await boundedSignerJson(request.body,request.headers,controller.signal));
   if(!parsed.success)return reply({error:'INVALID_SELECTOR'},422);
   controller.signal.throwIfAborted();const input=parsed.data;
   const result=PaidToolCommandResponseSchema.parse(await abortable(input.action==='prepare'?ports.signer.prepareAndSign(input.operationId,controller.signal):ports.signer.recoverRetained(input.operationId,controller.signal),controller.signal));
   controller.signal.throwIfAborted();const end=now();
   if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||end<start||end-start>=paidSignerMaximumMilliseconds||result.snapshot.operationId!==input.operationId||result.snapshot.status!=='signed'||result.receipt.version!==result.snapshot.version||result.receipt.status!=='signed'||!result.snapshot.attempt)throw Error('Unconfirmed');
   return reply(PaidSignerResponseSchema.parse({...input,version:result.snapshot.version,status:'signed'}),200);
  }catch{return reply({error:'ORIGINAL_PREPARATION_UNCONFIRMED'},503);}
  finally{clearTimeout(timer);request.signal.removeEventListener('abort',cancel);controller.abort();}
 };
}
