import {createHash} from 'node:crypto';
import {IdSchema} from '../../../packages/contracts/src/core';
import type {PaidRpcCapture} from './solana-transport';
import {PaidToolRpcCaptureSchema as PaidRpcCaptureSchema,type PaidToolRpcCapture} from '../../../packages/contracts/src/paid-tool-dispatch';
export {PaidRpcCaptureSchema};
export type PaidRpcEvidenceRepository={captureForOperation(operationId:string,capture:PaidToolRpcCapture):Promise<unknown>};
/** Preserve even malformed/error responses before decoding. Secrets and URLs
 * never enter this interface; records are private and operation-bound. */
export function createPaidRpcEvidenceSink(operationId:string,repository:PaidRpcEvidenceRepository){
 const id=IdSchema.parse(operationId);
 return async(raw:PaidRpcCapture):Promise<void>=>{
  const value=PaidRpcCaptureSchema.parse(raw);
  if(createHash('sha256').update(value.requestPayload).digest('hex')!==value.requestHash||createHash('sha256').update(Buffer.from(value.payloadHex,'hex')).digest('hex')!==value.sha256)throw Error('Evidence digest mismatch');
  const request=JSON.parse(value.requestPayload) as {method?:unknown};if(request.method!==value.method)throw Error('Evidence method mismatch');
  await repository.captureForOperation(id,value);
 };
}
