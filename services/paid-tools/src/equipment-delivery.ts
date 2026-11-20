import {randomUUID} from 'node:crypto';
import {commandDigest} from '../../../packages/contracts/src/canonical.js';
import {PaidToolPrivateReadSchema} from '../../../packages/db/src/paid-tool-schema.js';
import type {PostgresPaidToolPrivateRepository} from '../../../packages/db/src/paid-tool-repository.js';
import {equipmentRequestHash,equipmentResourceHash,optimizeEquipment,EQUIPMENT_OPTIMIZER} from './equipment-optimizer.js';
import {paidToolChallengeHash} from './quote-binding.js';
import {PaidToolExecutionError} from './solana-execution.js';
/** Paid-provider redemption: no computation is released to the caller until its
 * exact result is atomically stored against one verified original payment. */
export class PrivateEquipmentDelivery{
 constructor(private readonly repository:Pick<PostgresPaidToolPrivateRepository,'read'|'apply'>,private readonly now:()=>string=()=>new Date().toISOString()){}
 async deliver(operationId:string,signal:AbortSignal){
  signal.throwIfAborted();const record=PaidToolPrivateReadSchema.parse(await this.repository.read(operationId)),s=record.snapshot,q=record.quote;
  if(s.operationId!==operationId||!['payment_confirmed','completed'].includes(s.status)||!s.payment||!s.attempt||s.payment.signature!==s.attempt.signature||s.payment.messageHash!==s.attempt.messageHash)throw new PaidToolExecutionError('STATE_REQUIRES_RECONCILIATION');
  const {hash,...challenge}=q.challenge;
  if(q.providerId!==EQUIPMENT_OPTIMIZER||q.challenge.providerId!==EQUIPMENT_OPTIMIZER||hash!==s.review.quoteHash||hash!==await paidToolChallengeHash(challenge)||
    q.request.hash!==await equipmentRequestHash(record.requestBody)||q.resource.hash!==await equipmentResourceHash(record.resourceBody)||
    q.challenge.requestHash!==q.request.hash||q.challenge.resourceHash!==q.resource.hash||q.challenge.amountBaseUnits!==s.payment.amountBaseUnits||q.challenge.payee.recipient!==s.payment.destinationOwner||
    q.challenge.payee.mint!==s.payment.mint||q.challenge.payee.tokenProgram!==s.payment.tokenProgram)throw new PaidToolExecutionError('ORIGINAL_MESSAGE_MISMATCH');
  const result=await optimizeEquipment(record.requestBody,record.resourceBody),resultHash=await commandDigest({namespace:'pactwoven.paid-tools.delivery.v1',result});
  if(s.status==='completed'){
   if(!s.delivery||s.delivery.resultHash!==resultHash||s.delivery.paymentSignature!==s.payment.signature||await commandDigest({namespace:'pactwoven.paid-tools.delivery.v1',result:s.delivery.resultBody})!==resultHash)throw new PaidToolExecutionError('ORIGINAL_MESSAGE_MISMATCH');
   return {disposition:'recovered' as const,snapshot:s};
  }
  signal.throwIfAborted();const response=await this.repository.apply({operationId,commandKey:randomUUID(),expectedVersion:s.version,kind:'accept_delivery',delivery:{
   artifactRef:randomUUID(),resultHash,requestHash:q.request.hash,resourceHash:q.resource.hash,paymentSignature:s.payment.signature,verifiedAt:this.now(),resultBody:result}});
  if(response.snapshot.operationId!==operationId||response.snapshot.status!=='completed'||response.snapshot.delivery?.resultHash!==resultHash)throw new PaidToolExecutionError('STATE_REQUIRES_RECONCILIATION');
  return {disposition:'delivered' as const,snapshot:response.snapshot};
 }
}
