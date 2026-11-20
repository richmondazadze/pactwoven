import { z } from 'zod';
import { BaseUnitsSchema, IdSchema, InstantSchema } from '../../contracts/src/core';
import { HashSchema, ToolPurchaseBindingSchema } from '../../contracts/src/financial';
import { FINANCE_DEVNET_ASSET, SolanaPublicKeySchema, SolanaSignatureSchema } from '../../contracts/src/finance-provenance';
const Version=z.number().int().min(1).max(33),Revision=z.number().int().min(0).max(16);
const JsonObject=z.record(z.string(),z.unknown());
export const PaidToolStatusSchema=z.enum(['authorized','reserved','signing','signed','submitting','payment_pending','outcome_unknown','payment_confirmed','completed','cancelled']);
export const PaidToolReviewInputSchema=z.strictObject({id:IdSchema,quoteId:IdSchema,sourceKey:IdSchema,feeKey:IdSchema,maximumFeeLamports:BaseUnitsSchema});
export const PaidToolQuoteInputSchema=z.strictObject({id:IdSchema,organizationId:IdSchema,siteId:IdSchema,rootTaskId:IdSchema,instructionRevision:Revision,quote:ToolPurchaseBindingSchema,requestBody:JsonObject,resourceBody:JsonObject});
export const PaidToolObservationInputSchema=z.strictObject({id:IdSchema,accountKey:IdSchema,slot:BaseUnitsSchema,amountBaseUnits:BaseUnitsSchema,observedAt:InstantSchema,evidenceRef:IdSchema,evidenceHash:HashSchema});
export const PaidToolReviewSchema=z.strictObject({id:IdSchema,organizationId:IdSchema,siteId:IdSchema,rootTaskId:IdSchema,instructionRevision:Revision,quoteId:IdSchema,quoteHash:HashSchema,providerId:z.literal('equipment_optimizer_v1'),amountBaseUnits:BaseUnitsSchema,maximumFeeLamports:BaseUnitsSchema,sourceAccount:SolanaPublicKeySchema,sourceOwner:SolanaPublicKeySchema,feePayer:SolanaPublicKeySchema,destinationAccount:SolanaPublicKeySchema,destinationOwner:SolanaPublicKeySchema,mint:z.literal(FINANCE_DEVNET_ASSET.mint),tokenProgram:z.literal(FINANCE_DEVNET_ASSET.tokenProgram),genesis:z.literal(FINANCE_DEVNET_ASSET.genesis),expiresAt:InstantSchema,reviewHash:HashSchema});
export const PaidToolStoredMessageSchema=z.strictObject({messageHash:HashSchema,messageBase64:z.string().min(1).max(1700),blockhash:SolanaPublicKeySchema,lastValidBlockHeight:BaseUnitsSchema,currentBlockHeight:BaseUnitsSchema,heightObservedAt:InstantSchema,heightEvidenceRef:IdSchema,heightEvidenceHash:HashSchema,feeLamports:BaseUnitsSchema,sourceObservationId:IdSchema,feeObservationId:IdSchema});
export const PaidToolStoredAttemptSchema=z.strictObject({id:IdSchema,messageHash:HashSchema,wireHash:HashSchema,signature:SolanaSignatureSchema,blockhash:SolanaPublicKeySchema,lastValidBlockHeight:BaseUnitsSchema});
export const PaidToolFinalityInputSchema=z.strictObject({status:z.literal('finalized_transfer'),signature:SolanaSignatureSchema,slot:BaseUnitsSchema,observedAt:InstantSchema,genesis:z.literal(FINANCE_DEVNET_ASSET.genesis),mint:z.literal(FINANCE_DEVNET_ASSET.mint),tokenProgram:z.literal(FINANCE_DEVNET_ASSET.tokenProgram),sourceAccount:SolanaPublicKeySchema,sourceOwner:SolanaPublicKeySchema,destinationAccount:SolanaPublicKeySchema,destinationOwner:SolanaPublicKeySchema,amountBaseUnits:BaseUnitsSchema,feeLamports:BaseUnitsSchema,messageHash:HashSchema,transactionEvidenceRef:IdSchema,transactionEvidenceHash:HashSchema,statusEvidenceRef:IdSchema,statusEvidenceHash:HashSchema});
export const PaidToolStoredDeliverySchema=z.strictObject({artifactRef:IdSchema,resultHash:HashSchema,requestHash:HashSchema,resourceHash:HashSchema,paymentSignature:SolanaSignatureSchema,verifiedAt:InstantSchema,resultBody:JsonObject});
export const PaidToolSnapshotSchema=z.strictObject({operationId:IdSchema,review:PaidToolReviewSchema,version:Version,status:PaidToolStatusSchema,approvedAt:InstantSchema,revokedAt:InstantSchema.nullable(),message:PaidToolStoredMessageSchema.nullable(),attempt:PaidToolStoredAttemptSchema.nullable(),payment:PaidToolFinalityInputSchema.nullable(),delivery:PaidToolStoredDeliverySchema.nullable()});
export const PaidToolStoredReceiptSchema=z.strictObject({commandKey:IdSchema,commandHash:HashSchema,previousVersion:Version,version:Version,recordedAt:InstantSchema,status:PaidToolStatusSchema});
export const PaidToolCommandResponseSchema=z.strictObject({snapshot:PaidToolSnapshotSchema,receipt:PaidToolStoredReceiptSchema});
const command={operationId:IdSchema,commandKey:IdSchema,expectedVersion:Version};
export const PaidToolPrivateCommandSchema=z.discriminatedUnion('kind',[
 z.strictObject({...command,kind:z.literal('reserve')}),z.strictObject({...command,kind:z.literal('prepare_sign'),message:PaidToolStoredMessageSchema}),
 z.strictObject({...command,kind:z.literal('retain_signed'),attempt:PaidToolStoredAttemptSchema}),z.strictObject({...command,kind:z.literal('prepare_broadcast')}),
 z.strictObject({...command,kind:z.literal('mark_submitted')}),z.strictObject({...command,kind:z.literal('mark_unknown')}),
 z.strictObject({...command,kind:z.literal('confirm_payment'),payment:PaidToolFinalityInputSchema}),z.strictObject({...command,kind:z.literal('accept_delivery'),delivery:PaidToolStoredDeliverySchema}),
]);
export const PaidToolHumanControlSchema=z.strictObject({...command,kind:z.enum(['cancel_before_signing','revoke'])});
export const PaidToolPrivateReadSchema=z.strictObject({snapshot:PaidToolSnapshotSchema,quote:ToolPurchaseBindingSchema,requestBody:JsonObject,resourceBody:JsonObject,wireBase64:z.string().max(1700).nullable(),receipt:PaidToolStoredReceiptSchema.nullable()});
export type PaidToolSnapshot=z.infer<typeof PaidToolSnapshotSchema>;
export type PaidToolPrivateCommand=z.infer<typeof PaidToolPrivateCommandSchema>;
export type PaidToolQuoteInput=z.infer<typeof PaidToolQuoteInputSchema>;
export type PaidToolObservationInput=z.infer<typeof PaidToolObservationInputSchema>;
export const PaidToolRecoverInputSchema=z.discriminatedUnion('kind',[
 z.strictObject({kind:z.literal('approval'),reviewId:IdSchema,commandKey:IdSchema,reviewHash:HashSchema}),
 z.strictObject({kind:z.literal('control'),operationId:IdSchema,commandKey:IdSchema,commandHash:HashSchema}),
]);
export const PaidToolRecoverySchema=z.strictObject({snapshot:PaidToolSnapshotSchema,receipt:PaidToolStoredReceiptSchema.nullable()}).nullable();
export const PaidToolListSchema=z.strictObject({rootTaskId:IdSchema,items:z.array(PaidToolSnapshotSchema).max(32)});
export const PaidToolBudgetPartSchema=z.strictObject({state:z.enum(['current','stale','unobserved']),observedBaseUnits:BaseUnitsSchema.nullable(),observedAt:InstantSchema.nullable(),slot:BaseUnitsSchema.nullable(),heldBaseUnits:BaseUnitsSchema,unreflectedSpentBaseUnits:BaseUnitsSchema,settledSpendBaseUnits:BaseUnitsSchema,availableBaseUnits:BaseUnitsSchema.nullable(),shortfallBaseUnits:BaseUnitsSchema.nullable()});
export const PaidToolBudgetSchema=z.strictObject({operationId:IdSchema,version:Version,reviewHash:HashSchema,instructionRevision:Revision,observedAt:InstantSchema,token:PaidToolBudgetPartSchema,fee:PaidToolBudgetPartSchema});
export const PaidToolHumanSnapshotSchema=PaidToolSnapshotSchema.extend({currentInstructionRevision:Revision,evidenceAvailable:z.boolean()});
export const PaidToolHumanCommandResponseSchema=z.strictObject({snapshot:PaidToolHumanSnapshotSchema,receipt:PaidToolStoredReceiptSchema});
export const PaidToolHumanRecoverySchema=z.strictObject({snapshot:PaidToolHumanSnapshotSchema,receipt:PaidToolStoredReceiptSchema.nullable()}).nullable();
export const PaidToolHumanListSchema=z.strictObject({rootTaskId:IdSchema,items:z.array(PaidToolHumanSnapshotSchema).max(32)});
export type PaidToolHumanSnapshot=z.infer<typeof PaidToolHumanSnapshotSchema>;
export const PaidToolHeightInputSchema=z.strictObject({id:IdSchema,operationId:IdSchema,messageHash:HashSchema,blockhash:SolanaPublicKeySchema,lastValidBlockHeight:BaseUnitsSchema,currentBlockHeight:BaseUnitsSchema,observedAt:InstantSchema,evidenceRef:IdSchema,evidenceHash:HashSchema});
