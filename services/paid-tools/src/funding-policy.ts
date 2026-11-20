import {randomUUID} from 'node:crypto';
import type {PostgresPaidToolPrivateRepository} from '../../../packages/db/src/paid-tool-repository.js';
import {PaidToolPrivateReadSchema} from '../../../packages/db/src/paid-tool-schema.js';
import {validatePaidTransferIntent} from './solana-transfer.js';
import {QuickNodePaidToolTransport} from './solana-transport.js';
import {PaidToolExecutionError,type PaidToolCustodyRoute} from './solana-execution.js';
/** Read-only RPC observations precede SQL policy reservation. This producer has
 * no key, signing or broadcast capability. SQL owns available physical funds. */
export class PrivatePaidToolFundingPolicy{
 readonly #routes:readonly PaidToolCustodyRoute[];
 constructor(private readonly policy:Pick<PostgresPaidToolPrivateRepository,'read'|'apply'>,private readonly observer:Pick<PostgresPaidToolPrivateRepository,'observe'>,
  private readonly transport:QuickNodePaidToolTransport,routes:readonly PaidToolCustodyRoute[]){this.#routes=structuredClone(routes);}
 async fundAndReserve(operationId:string,signal:AbortSignal){
  signal.throwIfAborted();const record=PaidToolPrivateReadSchema.parse(await this.policy.read(operationId)),s=record.snapshot,r=s.review;
  if(s.operationId!==operationId||s.status!=='authorized')throw new PaidToolExecutionError('STATE_REQUIRES_RECONCILIATION');
  const routes=this.#routes.filter(a=>a.sourceAccount===r.sourceAccount&&a.sourceOwner===r.sourceOwner&&a.feePayer===r.feePayer&&a.destinationAccount===r.destinationAccount&&a.destinationOwner===r.destinationOwner);
  if(routes.length!==1)throw new PaidToolExecutionError('CONFIGURATION_INVALID');const route=routes[0]!,prefix=randomUUID();
  const block=await this.transport.latestBlockhash(route.minimumSlot,`${prefix}_blockhash`,signal);
  const preliminary=validatePaidTransferIntent({genesis:r.genesis,mint:r.mint,tokenProgram:r.tokenProgram,decimals:6,sourceAccount:r.sourceAccount,sourceOwner:r.sourceOwner,destinationAccount:r.destinationAccount,destinationOwner:r.destinationOwner,feePayer:r.feePayer,amountBaseUnits:r.amountBaseUnits,maximumFeeLamports:r.maximumFeeLamports,feeLamports:r.maximumFeeLamports,blockhash:block.blockhash,lastValidBlockHeight:block.lastValidBlockHeight,minimumAccountSlot:route.minimumSlot,validUntil:r.expiresAt});
  const fee=await this.transport.quoteFee(preliminary,`${prefix}_fee`,signal),ready=await this.transport.inspectReady({...preliminary,feeLamports:fee.feeLamports},`${prefix}_ready`,signal);
  const common={slot:ready.balances.slot,observedAt:ready.observedAt,evidenceRef:ready.balances.evidenceRef,evidenceHash:ready.balances.evidenceHash};
  await this.observer.observe({...common,id:randomUUID(),accountKey:route.sourceKey,amountBaseUnits:ready.balances.sourceBalanceBaseUnits});
  await this.observer.observe({...common,id:randomUUID(),accountKey:route.feeKey,amountBaseUnits:ready.balances.feePayerLamports});
  signal.throwIfAborted();this.transport.assertFreshReadiness(ready);
  return this.policy.apply({operationId,commandKey:randomUUID(),expectedVersion:s.version,kind:'reserve'});
 }
}
