import {ToolPurchaseBindingSchema} from '../../../packages/contracts/src/financial.js';
import {InstantSchema,BaseUnitsSchema} from '../../../packages/contracts/src/core.js';
import {commandDigest} from '../../../packages/contracts/src/canonical.js';
import type {PostgresPaidToolPrivateRepository} from '../../../packages/db/src/paid-tool-repository.js';
import {PaidToolRootSelectionSchema} from '../../../packages/db/src/paid-tool-root-schema.js';
import {parseEquipmentCatalogue,equipmentResourceHash,equipmentRequestHash,type EquipmentCatalogue} from './equipment-optimizer.js';
import {paidToolChallengeHash} from './quote-binding.js';
import {PaidToolExecutionError} from './solana-execution.js';
type ToolPurchase=ReturnType<typeof ToolPurchaseBindingSchema.parse>;
/** Private fixed-provider quote producer. It creates an inert quote only;
 * separate current human review/approval remains mandatory before spending. */
export class PrivateEquipmentQuoteProducer{
 private readonly catalogue:EquipmentCatalogue;
 constructor(private readonly repository:Pick<PostgresPaidToolPrivateRepository,'quote'>,private readonly config:{catalogue:EquipmentCatalogue;payee:ToolPurchase['challenge']['payee'];allowlistPolicy:ToolPurchase['allowlistPolicy'];deliveryPolicy:ToolPurchase['deliveryPolicy'];priceBaseUnits:string}){
  this.catalogue=parseEquipmentCatalogue(config.catalogue);this.config=structuredClone(config);BaseUnitsSchema.parse(config.priceBaseUnits);
 }
 async propose(input:{selection:unknown;rootDeadlineAt:string;maximumSpendBaseUnits:string},signal:AbortSignal){
  signal.throwIfAborted();const selection=PaidToolRootSelectionSchema.parse(input.selection),candidate=selection.candidate,expiresAt=InstantSchema.parse(input.rootDeadlineAt),maximum=BaseUnitsSchema.parse(input.maximumSpendBaseUnits);
  if(selection.selectionHash!==await commandDigest({namespace:'pactwoven.equipment-selection.v1',candidate})||candidate.resourceHash!==await equipmentResourceHash(this.catalogue)||candidate.requestHash!==await equipmentRequestHash(candidate.request)||BigInt(this.config.priceBaseUnits)<=0n||BigInt(this.config.priceBaseUnits)>BigInt(maximum))throw new PaidToolExecutionError('ORIGINAL_MESSAGE_MISMATCH');
  const suffix=await commandDigest({namespace:'pactwoven.equipment-quote.v1',scope:candidate.scope,requestHash:candidate.requestHash,resourceHash:candidate.resourceHash,expiresAt}),id=`equipment_quote_${suffix}`;
  const challenge={id,providerId:candidate.serviceId,resourceHash:candidate.resourceHash,requestHash:candidate.requestHash,payee:this.config.payee,amountBaseUnits:this.config.priceBaseUnits,expiresAt};
  const quote=ToolPurchaseBindingSchema.parse({providerId:candidate.serviceId,resource:{id:`resource_${candidate.resourceHash}`,version:this.catalogue.version,hash:candidate.resourceHash},request:{id:`request_${candidate.requestHash}`,version:1,hash:candidate.requestHash},challenge:{...challenge,hash:await paidToolChallengeHash(challenge)},allowlistPolicy:this.config.allowlistPolicy,deliveryPolicy:this.config.deliveryPolicy});
  signal.throwIfAborted();const stored=await this.repository.quote({id,...candidate.scope,quote,requestBody:candidate.request,resourceBody:this.catalogue});
  if(stored.id!==id||stored.quoteHash!==quote.challenge.hash)throw new PaidToolExecutionError('STATE_REQUIRES_RECONCILIATION');
  return {quoteId:id,quoteHash:stored.quoteHash};
 }
}
