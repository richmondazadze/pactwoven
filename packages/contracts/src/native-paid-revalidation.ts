import { z } from 'zod';
import { IdSchema, IdempotencyKeySchema, InstantSchema } from './core';
import { HashSchema } from './financial';
const revision=z.number().int().min(0).max(16),counter=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const scope={rootTaskId:IdSchema,instructionRevision:revision};
export const PaidToolRootRevalidationStateSchema=z.discriminatedUnion('kind',[
 z.strictObject({kind:z.literal('not_applicable'),...scope}),
 z.strictObject({kind:z.literal('pending'),...scope,quoteId:IdSchema,operationId:IdSchema}),
 z.strictObject({kind:z.literal('required'),...scope,quoteId:IdSchema,operationId:IdSchema,requestHash:HashSchema,resourceHash:HashSchema,resultHash:HashSchema}),
]);
export const PaidToolRootRevalidationReceiptSchema=z.strictObject({...scope,generation:counter.min(1),refreshEpoch:counter,quoteId:IdSchema,operationId:IdSchema,requestKey:IdempotencyKeySchema,resultHash:HashSchema,dataValidUntil:InstantSchema});
export const PaidToolRootRevalidationParkSchema=z.strictObject({...scope,generation:counter.min(1),refreshEpoch:counter,quoteId:IdSchema,operationId:IdSchema,requestKey:IdempotencyKeySchema,state:z.literal('waiting')});
export type PaidToolRootRevalidationState=z.infer<typeof PaidToolRootRevalidationStateSchema>;
export type PaidToolRootRevalidationReceipt=z.infer<typeof PaidToolRootRevalidationReceiptSchema>;
