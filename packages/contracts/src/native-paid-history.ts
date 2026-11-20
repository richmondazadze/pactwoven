import { z } from 'zod';
import { IdSchema, InstantSchema, BaseUnitsSchema } from './core';
import { HashSchema } from './financial';
import { SolanaSignatureSchema } from './finance-provenance';
import { NativePaidEquipmentResponseSchema } from './native-paid-equipment';
const scope = z.strictObject({ environment:z.literal('development'), organizationId:IdSchema, siteId:IdSchema });
const identity = { scope, rootTaskId:IdSchema, operationId:IdSchema };
const text = (max:number)=>z.string().min(1).max(max).regex(/\S/);
export const NativePaidHistoryRecordSchema=z.strictObject({
 kind:z.literal('recorded'),...identity,instructionRevision:z.number().int().min(0).max(16),
 completedAt:InstantSchema,evidenceValidUntil:InstantSchema,freshness:z.literal('historical'),authority:z.literal('none'),sourcePolicy:z.literal('public_or_operator_only_v1'),
 advice:z.strictObject({title:text(180),summary:text(8000),artifacts:z.array(z.strictObject({id:IdSchema,title:text(180),text:text(16000)})).min(1).max(16)}),
 equipment:NativePaidEquipmentResponseSchema.shape.selection,
 payment:z.strictObject({signature:SolanaSignatureSchema,amountBaseUnits:BaseUnitsSchema,feeLamports:BaseUnitsSchema,finalizedAt:InstantSchema,slot:BaseUnitsSchema}),
 provenance:z.strictObject({completionDigest:HashSchema,requestHash:HashSchema,resourceHash:HashSchema,resultHash:HashSchema,catalogue:z.literal('controlled_demo_catalogue'),
  sources:z.array(z.strictObject({url:z.url().refine(value=>{const u=new URL(value);return ['https:','http:'].includes(u.protocol)&&!u.username&&!u.password;}),observedAt:InstantSchema,validUntil:InstantSchema})).max(128)}),
}).superRefine((v,ctx)=>{if(Date.parse(v.completedAt)>=Date.parse(v.evidenceValidUntil)||Date.parse(v.payment.finalizedAt)>Date.parse(v.completedAt)||v.equipment.requestHash!==v.provenance.requestHash||v.provenance.sources.some(s=>Date.parse(s.observedAt)>Date.parse(v.completedAt)||Date.parse(s.validUntil)<=Date.parse(s.observedAt)))ctx.addIssue({code:'custom',message:'Recorded completion provenance is inconsistent.'});});
export const NativePaidHistoryResponseSchema=z.discriminatedUnion('kind',[
 NativePaidHistoryRecordSchema,z.strictObject({kind:z.literal('unavailable'),...identity,reason:z.literal('not_retained')})
]);
export type NativePaidHistoryResponse=z.infer<typeof NativePaidHistoryResponseSchema>;
