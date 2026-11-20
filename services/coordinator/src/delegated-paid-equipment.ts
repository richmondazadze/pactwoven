import type {NativeModelGateway} from './azure-gateway';
import {DelegatedPersistenceUnknown,type DelegatedLease} from './delegated-lease';
import {DelegatedOutputRejected} from './delegated-output';
import {PaidToolRootSelectionSchema,PaidToolRootStateSchema,PaidToolRootWaitReceiptSchema,PaidToolRootPurchaseSchema,PaidToolRootPolicySchema} from '../../../packages/db/src/paid-tool-root-schema';
import type {PostgresPaidToolRootRepository} from '../../../packages/db/src/paid-tool-root-repository';
import type {PostgresPaidToolRevalidationRepository} from '../../../packages/db/src/paid-tool-revalidation-repository';
import {PaidToolRootRevalidationStateSchema,PaidToolRootRevalidationReceiptSchema,PaidToolRootRevalidationParkSchema} from '../../../packages/contracts/src/native-paid-revalidation';
import type {NativeRootCheckpointCommand} from '../../../packages/db/src/native-root-lifecycle-schema';
import {selectEquipmentService,purchasedEquipmentInput,type PaidEquipmentScope} from '../../paid-tools/src/equipment-selection';
import {parseEquipmentCatalogue,type EquipmentCatalogue} from '../../paid-tools/src/equipment-optimizer';
import type {PrivateEquipmentQuoteProducer} from '../../paid-tools/src/equipment-quote';
export type DelegatedPaidEquipmentContext={lease:DelegatedLease;scope:PaidEquipmentScope;refreshEpoch:number;rootDeadlineAt:string;operatorPrompt:string;
 inputReceipt:{receiptId:string;digest:string}|null;accepted:unknown[];checkpoint:()=>NativeRootCheckpointCommand;persistSelectionUsage:()=>Promise<void>;gateway:NativeModelGateway;now:()=>number};
/** Narrow leased coordinator bridge. Policy opt-in selects the demo, while only
 * a later exact human quote approval can authorize payment. */
export class DelegatedPaidEquipmentCoordinator{
 private readonly catalogue:EquipmentCatalogue;
 constructor(private readonly options:{repository:Pick<PostgresPaidToolRootRepository,'policy'|'read'|'wait'|'consume'>;
  revalidation?:Pick<PostgresPaidToolRevalidationRepository,'revalidation'|'revalidate'|'park'>;
  quote:Pick<PrivateEquipmentQuoteProducer,'propose'>;catalogue:EquipmentCatalogue}){this.catalogue=parseEquipmentCatalogue(options.catalogue);}
 async beforeSynthesis(context:DelegatedPaidEquipmentContext){
  const {lease,scope}=context,selector=lease.claim.selector;
  if(selector.organizationId!==scope.organizationId||selector.taskId!==scope.rootTaskId)throw new DelegatedOutputRejected();
  const policy=PaidToolRootPolicySchema.parse(await lease.read(()=>this.options.repository.policy(selector)));
  if(policy.rootTaskId!==scope.rootTaskId||policy.instructionRevision!==scope.instructionRevision)throw new DelegatedOutputRejected();
  if(!policy.enabled)return {kind:'ordinary' as const};
  let state=PaidToolRootStateSchema.parse(await lease.read(()=>this.options.repository.read(selector)));
  if(state.rootTaskId!==scope.rootTaskId||state.instructionRevision!==scope.instructionRevision)throw new DelegatedOutputRejected();
  let revalidatedResultHash:string|null=null;
  if(state.kind==='unavailable'&&this.options.revalidation){
   const port=this.options.revalidation;
   const preparation=PaidToolRootRevalidationStateSchema.parse(await lease.read(()=>port.revalidation(selector)));
   if(preparation.rootTaskId!==scope.rootTaskId||preparation.instructionRevision!==scope.instructionRevision)throw new DelegatedOutputRejected();
   if(preparation.kind==='pending'){
    if(preparation.quoteId!==state.quoteId||preparation.operationId!==state.operationId)throw new DelegatedOutputRejected();
    const requestKey=crypto.randomUUID();
    const receipt=await lease.write(async()=>PaidToolRootRevalidationParkSchema.parse(await port.park(selector,{
     schemaVersion:1,expectedInstructionRevision:scope.instructionRevision,expectedRefreshEpoch:context.refreshEpoch,
     quoteId:preparation.quoteId,operationId:preparation.operationId,requestKey,
    })));
    if(receipt.rootTaskId!==scope.rootTaskId||receipt.instructionRevision!==scope.instructionRevision||receipt.refreshEpoch!==context.refreshEpoch||
      receipt.generation!==selector.generation+1||receipt.quoteId!==preparation.quoteId||receipt.operationId!==preparation.operationId||receipt.requestKey!==requestKey)throw new DelegatedPersistenceUnknown();
    return {kind:'waiting' as const};
   }
   if(preparation.kind==='required'){
    if(preparation.quoteId!==state.quoteId||preparation.operationId!==state.operationId||!context.inputReceipt||!context.accepted.length)throw new DelegatedOutputRejected();
    const inputReceipt=context.inputReceipt;
    // Reconsider only current accepted evidence. This branch cannot prepare a
    // quote or broaden the immutable demand/catalogue purchased earlier.
    const selected=await selectEquipmentService({scope,inputReceipt,operatorPrompt:context.operatorPrompt,accepted:context.accepted,catalogue:this.catalogue,gateway:context.gateway,signal:lease.signal});
    if(selected.candidate.decision!=='use_service'||selected.candidate.requestHash!==preparation.requestHash||selected.candidate.resourceHash!==preparation.resourceHash)throw new DelegatedOutputRejected();
    const selection=PaidToolRootSelectionSchema.parse({candidate:selected.candidate,selectionHash:selected.selectionHash});
    // Unlike the original paid wait, revalidation does not store a planner
    // checkpoint. Preserve this model usage before a witness can be committed
    // or its acknowledgement lost; the existing save updates checkpoint CAS.
    await context.persistSelectionUsage();
    const requestKey=crypto.randomUUID();
    const receipt=await lease.write(async()=>PaidToolRootRevalidationReceiptSchema.parse(await port.revalidate(selector,{
     schemaVersion:1,expectedInstructionRevision:scope.instructionRevision,expectedRefreshEpoch:context.refreshEpoch,
     quoteId:preparation.quoteId,operationId:preparation.operationId,requestKey,inputReceipts:[inputReceipt],selection,
    })));
    if(receipt.rootTaskId!==scope.rootTaskId||receipt.instructionRevision!==scope.instructionRevision||receipt.refreshEpoch!==context.refreshEpoch||
      receipt.generation!==selector.generation||receipt.quoteId!==preparation.quoteId||receipt.operationId!==preparation.operationId||
      receipt.requestKey!==requestKey||receipt.resultHash!==preparation.resultHash||Date.parse(receipt.dataValidUntil)<=context.now())throw new DelegatedPersistenceUnknown();
    // Once a witness may have been stored, any inconsistent read stops this
    // slice. Never fall through into selection/quote creation or a second write.
    try{state=PaidToolRootStateSchema.parse(await lease.read(()=>this.options.repository.read(selector)));}
    catch{throw new DelegatedPersistenceUnknown();}
    if(state.kind!=='ready'||state.rootTaskId!==scope.rootTaskId||state.instructionRevision!==scope.instructionRevision||
      state.quoteId!==preparation.quoteId||state.operationId!==preparation.operationId)throw new DelegatedPersistenceUnknown();
    revalidatedResultHash=preparation.resultHash;
   }
  }
  if(state.kind==='unavailable')return {kind:'unavailable' as const};
  if(state.kind==='ready'){
   const requestKey=crypto.randomUUID(),receipt=await lease.write(async()=>PaidToolRootPurchaseSchema.parse(await this.options.repository.consume(selector,{schemaVersion:1,
    expectedInstructionRevision:scope.instructionRevision,expectedRefreshEpoch:context.refreshEpoch,quoteId:state.quoteId,requestKey})));
   if(receipt.rootTaskId!==scope.rootTaskId||receipt.instructionRevision!==scope.instructionRevision||receipt.generation!==selector.generation||receipt.quoteId!==state.quoteId||receipt.operationId!==state.operationId||receipt.requestKey!==requestKey||Date.parse(receipt.dataValidUntil)<=context.now())throw new DelegatedPersistenceUnknown();
   let input:Awaited<ReturnType<typeof purchasedEquipmentInput>>;
   try{input=await purchasedEquipmentInput(receipt.paidRecord,scope);}catch{throw new DelegatedPersistenceUnknown();}
   if(input.operationId!==receipt.operationId||input.resultHash!==receipt.resultHash||input.payment.signature!==receipt.paymentSignature||
     revalidatedResultHash!==null&&input.resultHash!==revalidatedResultHash)throw new DelegatedPersistenceUnknown();
   return {kind:'ready' as const,input,dataValidUntil:receipt.dataValidUntil};
  }
  let quoteId:string,selection:ReturnType<typeof PaidToolRootSelectionSchema.parse>|null=null;
  if(state.kind==='waiting')quoteId=state.quoteId;
  else{
   if(!context.inputReceipt||!context.accepted.length)throw new DelegatedOutputRejected();
   const selected=await selectEquipmentService({scope,inputReceipt:context.inputReceipt,operatorPrompt:context.operatorPrompt,accepted:context.accepted,catalogue:this.catalogue,gateway:context.gateway,signal:lease.signal});
   if(selected.candidate.decision==='not_needed')return {kind:'ordinary' as const};
   selection=PaidToolRootSelectionSchema.parse({candidate:selected.candidate,selectionHash:selected.selectionHash});
   const prepared=await lease.write(()=>this.options.quote.propose({selection,rootDeadlineAt:context.rootDeadlineAt,quoteIssuedAt:new Date(context.now()).toISOString(),maximumSpendBaseUnits:policy.maximumComputationBaseUnits},lease.signal));
   quoteId=prepared.quoteId;
  }
  const checkpoint=context.checkpoint();
  const receipt=PaidToolRootWaitReceiptSchema.parse(await lease.write(()=>this.options.repository.wait(selector,{schemaVersion:1,expectedInstructionRevision:scope.instructionRevision,
   expectedRefreshEpoch:context.refreshEpoch,quoteId,selection,checkpoint})));
  if(receipt.rootTaskId!==scope.rootTaskId||receipt.quoteId!==quoteId||receipt.instructionRevision!==scope.instructionRevision||receipt.checkpoint.generation!==selector.generation+1||receipt.checkpoint.requestKey!==checkpoint.requestKey||receipt.checkpoint.checkpointVersion!==checkpoint.expectedCheckpointVersion+1||receipt.checkpoint.continuation!=='waiting_children')throw new DelegatedPersistenceUnknown();
  return {kind:'waiting' as const};
 }
}

export const paidEquipmentRecordInstructions = '\nThe runtime supplied purchasedEquipment only after current same-root SQL consumption, exact finalized devnet payment verification and recomputation of the stored equipment result. The preceding prohibition on claiming external actions has one factual exception: you may describe this already completed separately authorized purchase of a computation, exactly as recorded. You still cannot initiate or authorize any transaction. Use the actual selected package and USD catalogue amounts in recommendations; never claim equipment was ordered, suppliers were paid or catalogue prices are live market prices. The devnet USDC computation fee is distinct from equipment cost. Do not turn this structured result into a fabricated public-source citation. Keep opaque operation IDs, hashes and transaction signatures out of prose; the separate receipt UI shows proof. All other advisory authority, sources, deadlines, instructions and quality checks remain unchanged.';
