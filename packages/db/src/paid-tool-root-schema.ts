import {z} from 'zod';
import {PaidToolPrivateReadSchema,PaidToolStatusSchema} from './paid-tool-schema';
import {IdSchema,IdempotencyKeySchema,InstantSchema,BaseUnitsSchema} from '../../contracts/src/core';
import {HashSchema,ToolPurchaseBindingSchema} from '../../contracts/src/financial';
import {SolanaSignatureSchema} from '../../contracts/src/finance-provenance';
import {NativeRootCheckpointCommandSchema,NativeRootCheckpointReceiptSchema} from './native-root-lifecycle-schema';
const revision=z.number().int().min(0).max(16),epoch=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const Demand=z.strictObject({seats:z.number().int().min(1).max(500),microphones:z.number().int().min(0).max(16),projectors:z.number().int().min(0).max(8),budgetMinor:z.number().int().min(0).max(1000000000)});
export const PaidToolRootSelectionSchema=z.strictObject({selectionHash:HashSchema,candidate:z.strictObject({schemaVersion:z.literal(1),kind:z.literal('equipment_service_selection'),authority:z.literal('none'),scope:z.strictObject({organizationId:IdSchema,siteId:IdSchema,rootTaskId:IdSchema,instructionRevision:revision}),inputReceipt:z.strictObject({receiptId:z.uuid(),digest:HashSchema}),serviceId:z.literal('equipment_optimizer_v1'),decision:z.literal('use_service'),reason:z.string().min(1).max(600),assumptions:z.array(z.string().min(1).max(300)).max(4),request:Demand,requestHash:HashSchema,resourceHash:HashSchema,supportingArtifacts:z.array(z.strictObject({artifactId:IdSchema,digest:HashSchema,role:z.enum(['research','planning','escalation'])})).min(1).max(16)})});
export const PaidToolRootWaitSchema=z.strictObject({schemaVersion:z.literal(1),expectedInstructionRevision:revision,expectedRefreshEpoch:epoch,quoteId:IdSchema,selection:PaidToolRootSelectionSchema.nullable(),checkpoint:NativeRootCheckpointCommandSchema});
export const PaidToolRootWaitReceiptSchema=z.strictObject({rootTaskId:IdSchema,quoteId:IdSchema,instructionRevision:revision,checkpoint:NativeRootCheckpointReceiptSchema});
export const PaidToolRootStateSchema=z.discriminatedUnion('kind',[
 z.strictObject({kind:z.literal('none'),rootTaskId:IdSchema,instructionRevision:revision}),
 z.strictObject({kind:z.enum(['waiting','ready','unavailable']),rootTaskId:IdSchema,instructionRevision:revision,quoteId:IdSchema,operationId:IdSchema.nullable(),dataValidUntil:InstantSchema}),
]);
export const PaidToolRootConsumeSchema=z.strictObject({schemaVersion:z.literal(1),expectedInstructionRevision:revision,expectedRefreshEpoch:epoch,quoteId:IdSchema,requestKey:IdempotencyKeySchema});
export const PaidToolRootPurchaseSchema=z.strictObject({rootTaskId:IdSchema,instructionRevision:revision,generation:z.number().int().positive(),quoteId:IdSchema,operationId:IdSchema,requestKey:IdempotencyKeySchema,resultHash:HashSchema,paymentSignature:SolanaSignatureSchema,artifactRef:IdSchema,resultBody:z.record(z.string(),z.unknown()),paidRecord:PaidToolPrivateReadSchema.refine(value=>value.wireBase64===null&&value.receipt===null),dataValidUntil:InstantSchema});
export const PaidToolRootPolicyInputSchema=z.strictObject({rootTaskId:IdSchema,siteId:IdSchema,instructionRevision:revision,requestKey:IdempotencyKeySchema,maximumComputationBaseUnits:BaseUnitsSchema.refine(x=>BigInt(x)>0n),maximumFeeLamports:BaseUnitsSchema.refine(x=>BigInt(x)>0n),authorization:z.literal('separate_quote_required')});
export const PaidToolRootPolicySchema=z.discriminatedUnion('enabled',[
 z.strictObject({enabled:z.literal(false),rootTaskId:IdSchema,instructionRevision:revision}),
 z.strictObject({enabled:z.literal(true),rootTaskId:IdSchema,instructionRevision:revision,maximumComputationBaseUnits:BaseUnitsSchema,maximumFeeLamports:BaseUnitsSchema,authorization:z.literal('separate_quote_required')}),
]);

const Offer=z.strictObject({id:z.string().regex(/^[a-z0-9_-]{1,64}$/),label:z.string().min(1).max(120).refine(x=>x.trim().length>0&&!/[\u0000-\u001f]/.test(x)),seats:z.number().int().min(0).max(500),microphones:z.number().int().min(0).max(16),projectors:z.number().int().min(0).max(8),priceMinor:z.number().int().min(0).max(1000000000)}).refine(x=>x.seats+x.microphones+x.projectors>0);
export const PaidToolRootQuoteSchema=z.strictObject({rootTaskId:IdSchema,quoteId:IdSchema,instructionRevision:revision,quote:ToolPurchaseBindingSchema,requestBody:Demand,resourceBody:z.strictObject({version:z.number().int().positive(),currency:z.literal('USD'),provenance:z.literal('controlled_demo_catalogue'),offers:z.array(Offer).min(1).max(12).refine(x=>new Set(x.map(y=>y.id)).size===x.length)}),reason:z.string().min(1).max(600),assumptions:z.array(z.string().min(1).max(300)).max(4)});

export const PaidToolRootDiscoverySchema=z.strictObject({rootTaskId:IdSchema,instructionRevision:revision,evidenceAvailable:z.boolean(),policy:PaidToolRootPolicySchema,attachment:z.strictObject({quoteId:IdSchema,operationId:IdSchema.nullable(),paymentStatus:PaidToolStatusSchema.nullable(),status:z.enum(['waiting','ready','unavailable']),dataValidUntil:InstantSchema}).nullable()});
