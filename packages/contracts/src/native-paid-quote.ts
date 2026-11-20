import { z } from 'zod';
import { BaseUnitsSchema, IdSchema, InstantSchema } from './core';
import { HashSchema } from './financial';
import { FINANCE_DEVNET_ASSET, SolanaPublicKeySchema } from './finance-provenance';
import { NativePaidToolViewSchema } from './native-paid-tool';
export const NativePaidQuoteScopeSchema=z.strictObject({environment:z.literal('development'),organizationId:IdSchema,siteId:IdSchema});
const amount=z.strictObject({baseUnits:BaseUnitsSchema,decimals:z.literal(6),symbol:z.literal('devnet USDC')});
const fee=z.strictObject({baseUnits:BaseUnitsSchema,decimals:z.literal(9),symbol:z.literal('test SOL')});
export const NativePaidQuoteViewSchema=z.strictObject({
  scope:NativePaidQuoteScopeSchema,rootTaskId:IdSchema,quoteId:IdSchema,instructionRevision:z.number().int().min(0).max(16),
  quoteHash:HashSchema,expiresAt:InstantSchema,reviewBy:InstantSchema,title:z.literal('Equipment package optimizer'),
  reason:z.string().min(1).max(600),assumptions:z.array(z.string().min(1).max(300)).max(4),
  request:z.strictObject({seats:z.number().int().min(1).max(500),microphones:z.number().int().min(0).max(16),projectors:z.number().int().min(0).max(8),budgetMinor:z.number().int().min(0).max(1000000000)}),
  catalogue:z.strictObject({provenance:z.literal('controlled_demo_catalogue'),currency:z.literal('USD'),offers:z.array(z.strictObject({id:z.string().max(64),label:z.string().min(1).max(120),seats:z.number().int(),microphones:z.number().int(),projectors:z.number().int(),priceMinor:z.number().int()})).min(1).max(12)}),
  amount,allowanceLimit:amount,feeCeiling:fee,network:z.literal('Solana devnet'),
  asset:z.strictObject({mint:z.literal(FINANCE_DEVNET_ASSET.mint),tokenProgram:z.literal(FINANCE_DEVNET_ASSET.tokenProgram),genesis:z.literal(FINANCE_DEVNET_ASSET.genesis)}),
  recipient:z.strictObject({label:z.literal('Pactwoven demo computation service'),owner:SolanaPublicKeySchema}),
  notice:z.literal('This pays for a computation using test tokens. Catalogue prices are sample USD estimates. No equipment is ordered.'),
});
export const NativePaidQuoteReviewSchema=z.strictObject({quote:NativePaidQuoteViewSchema,reviewId:IdSchema,reviewHash:HashSchema,confirmBy:InstantSchema,
  source:z.strictObject({tokenAccount:SolanaPublicKeySchema,owner:SolanaPublicKeySchema,feePayer:SolanaPublicKeySchema}),
  recipientTokenAccount:SolanaPublicKeySchema});
export const NativePaidQuoteDiscoverySchema=z.strictObject({scope:NativePaidQuoteScopeSchema,rootTaskId:IdSchema,instructionRevision:z.number().int().min(0).max(16),
  state:z.enum(['not_selected','planning','awaiting_review','payment_in_progress','delivered','unavailable']),operationId:IdSchema.nullable(),quote:NativePaidQuoteViewSchema.nullable()});
const ApprovalBinding=z.strictObject({quoteId:IdSchema,quoteHash:HashSchema,reviewId:IdSchema,reviewHash:HashSchema});
export const NativePaidQuoteApprovalResponseSchema=z.strictObject({scope:NativePaidQuoteScopeSchema,rootTaskId:IdSchema,approval:ApprovalBinding,purchase:NativePaidToolViewSchema});
export const NativePaidQuoteRecoveryResponseSchema=z.strictObject({scope:NativePaidQuoteScopeSchema,rootTaskId:IdSchema,approval:ApprovalBinding.nullable(),purchase:NativePaidToolViewSchema.nullable()})
  .refine(value=>(value.approval===null)===(value.purchase===null));
export type NativePaidQuoteView=z.infer<typeof NativePaidQuoteViewSchema>;
export type NativePaidQuoteReview=z.infer<typeof NativePaidQuoteReviewSchema>;
