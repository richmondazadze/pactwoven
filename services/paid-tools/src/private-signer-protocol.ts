import { z } from 'zod';
import { IdSchema } from '../../../packages/contracts/src/core';
export const paidSignerPath='/internal/paid-tool-signer';
export const paidSignerMaximumMilliseconds=45_000;
export const paidSignerMaximumBytes=2048;
export const PaidSignerRequestSchema=z.strictObject({schemaVersion:z.literal(1),environment:z.literal('development'),operationId:IdSchema,action:z.enum(['prepare','recover'])});
export const PaidSignerResponseSchema=z.strictObject({schemaVersion:z.literal(1),environment:z.literal('development'),operationId:IdSchema,action:z.enum(['prepare','recover']),version:z.number().int().min(1).max(33),status:z.literal('signed')});
export type PaidSignerRequest=z.infer<typeof PaidSignerRequestSchema>;
export type PaidSignerResponse=z.infer<typeof PaidSignerResponseSchema>;
export const signerUnavailable=()=>Error('Original payment preparation requires reconciliation.');
export function abortable<T>(promise:Promise<T>,signal:AbortSignal):Promise<T>{
 return new Promise((resolve,reject)=>{const abort=()=>reject(signerUnavailable()),done=()=>signal.removeEventListener('abort',abort);
  promise.then(x=>{done();resolve(x);},e=>{done();reject(e);});if(signal.aborted){abort();return;}signal.addEventListener('abort',abort,{once:true});});
}
export async function boundedSignerJson(body:ReadableStream<Uint8Array>|null,headers:Headers,signal:AbortSignal){
 const length=headers.get('content-length');
 if(!body||headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()!=='application/json'||length!==null&&(!/^\d+$/.test(length)||Number(length)>paidSignerMaximumBytes))throw signerUnavailable();
 const reader=body.getReader(),chunks:Uint8Array[]=[];let size=0,reads=0;
 const cancel=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',cancel,{once:true});
 try{for(;;){signal.throwIfAborted();if(++reads>paidSignerMaximumBytes+1)throw signerUnavailable();const next=await abortable(reader.read(),signal);if(next.done)break;size+=next.value.byteLength;if(size>paidSignerMaximumBytes)throw signerUnavailable();chunks.push(next.value);}
  const all=new Uint8Array(size);let offset=0;for(const chunk of chunks){all.set(chunk,offset);offset+=chunk.length;}return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(all)) as unknown;
 }finally{signal.removeEventListener('abort',cancel);void reader.cancel().catch(()=>{});reader.releaseLock();}
}
