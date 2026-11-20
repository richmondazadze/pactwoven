import { PaidSignerRequestSchema,PaidSignerResponseSchema,paidSignerPath,paidSignerMaximumMilliseconds,boundedSignerJson,abortable,signerUnavailable,type PaidSignerRequest } from './private-signer-protocol';
export function createPrivateSignerClient(origin:string,ports:{token:()=>Promise<string>;fetch?:typeof fetch;now?:()=>number}){
 if(!/^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.vercel\.app$/.test(origin))throw signerUnavailable();
 const target=new URL(paidSignerPath,origin),now=ports.now??Date.now,send=ports.fetch??fetch;
 async function call(action:PaidSignerRequest['action'],operationId:string,signal:AbortSignal){
  const input=PaidSignerRequestSchema.parse({schemaVersion:1,environment:'development',operationId,action}),controller=new AbortController(),cancel=()=>controller.abort(),start=now();
  signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel();const timer=setTimeout(cancel,paidSignerMaximumMilliseconds);
  try{
   controller.signal.throwIfAborted();const token=await abortable(ports.token(),controller.signal);
   if(token.length>8192||!/^[-\w]+\.[-\w]+\.[-\w]+$/.test(token))throw signerUnavailable();
   controller.signal.throwIfAborted();const response=await abortable(send(target,{method:'POST',headers:{Authorization:`Bearer ${token}`,'x-vercel-trusted-oidc-idp-token':token,'content-type':'application/json',accept:'application/json'},body:JSON.stringify(input),redirect:'error',cache:'no-store',credentials:'omit',signal:controller.signal}),controller.signal);
   if(response.status!==200||response.redirected||response.url&&response.url!==target.href){void response.body?.cancel().catch(()=>{});throw signerUnavailable();}
   const result=PaidSignerResponseSchema.parse(await boundedSignerJson(response.body,response.headers,controller.signal)),end=now();
   if(controller.signal.aborted||!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||end<start||end-start>=paidSignerMaximumMilliseconds||result.operationId!==input.operationId||result.action!==action)throw signerUnavailable();
   return result;
  }catch{throw signerUnavailable();}finally{clearTimeout(timer);signal.removeEventListener('abort',cancel);controller.abort();}
 }
 return {prepareAndSign:(id:string,signal:AbortSignal)=>call('prepare',id,signal),recoverRetained:(id:string,signal:AbortSignal)=>call('recover',id,signal)};
}
