import {z} from 'zod';
import {BaseUnitsSchema} from './core';
import {HashSchema} from './financial';
import {NativeWorkIntentPrepareSchema,NativeWorkIntentConfirmSchema,NativeWorkIntentPrepareResponseSchema,NativeWorkIntentOperationSchema,NativeWorkIntentRecoveryResponseSchema} from './native-work-intent';
export const PaidToolIntentPolicySchema=z.strictObject({serviceId:z.literal('equipment_optimizer_v1'),maximumComputationBaseUnits:BaseUnitsSchema.refine(x=>BigInt(x)>0n),maximumFeeLamports:BaseUnitsSchema.refine(x=>BigInt(x)>0n),authorization:z.literal('separate_quote_required')});
export const PaidToolIntentPrepareSchema=z.strictObject({work:NativeWorkIntentPrepareSchema,paidPolicy:PaidToolIntentPolicySchema});
export const PaidToolIntentReviewSchema=PaidToolIntentPolicySchema.extend({policyReviewHash:HashSchema});
export const PaidToolIntentPrepareResponseSchema=z.strictObject({work:NativeWorkIntentPrepareResponseSchema,paidPolicy:PaidToolIntentReviewSchema});
export const PaidToolIntentConfirmSchema=z.strictObject({work:NativeWorkIntentConfirmSchema,policyReviewHash:HashSchema});
export const PaidToolIntentConfirmResponseSchema=z.strictObject({work:NativeWorkIntentOperationSchema,paidPolicy:PaidToolIntentReviewSchema});
export const PaidToolIntentRecoveryResponseSchema=z.strictObject({work:NativeWorkIntentRecoveryResponseSchema,paidPolicy:PaidToolIntentReviewSchema.nullable()});

export const PaidToolIntentOptionsSchema=z.discriminatedUnion('enabled',[z.strictObject({enabled:z.literal(false)}),z.strictObject({enabled:z.literal(true),paidPolicy:PaidToolIntentPolicySchema})]);
