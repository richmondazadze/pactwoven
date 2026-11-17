import { z } from 'zod';
import { FinancialDraftScopeSchema, FinancialPolicyGenerationSchema, FinancialPolicyOriginalClosureLocatorSchema,
  FinancialPolicyOriginalClosureReceiptSchema, FINANCIAL_POLICY_ORIGINAL_CLOSURE_MAX_BYTES } from '@pactwoven/contracts';
import { FinancialPolicyOriginalSchema, type FinancialPolicyReaderScope } from './financial-policy-read-schema.js';

/** Private service projection; a parse never authenticates the caller or the supplied pins. */
export const FinancialPolicyOriginalClosureIntentSchema = z.strictObject({ schemaVersion: z.literal(1),
  purpose: z.literal('financial_policy_original_close'), reason: z.literal('original_input_unavailable'),
  locator: FinancialPolicyOriginalClosureLocatorSchema,
  expected: z.strictObject({ organizationEpoch: FinancialPolicyGenerationSchema, draftScope: FinancialDraftScopeSchema.nullable() }),
}).superRefine((v,c) => {
  if (v.locator.responsibilityId === null ? v.expected.draftScope !== null :
    !v.expected.draftScope || v.expected.draftScope.authority.responsibility.id !== v.locator.responsibilityId)
    c.addIssue({code:'custom',message:'Exact current responsibility basis required.'});
  if (new TextEncoder().encode(JSON.stringify(v)).byteLength > FINANCIAL_POLICY_ORIGINAL_CLOSURE_MAX_BYTES)
    c.addIssue({code:'custom',message:'Bounded closure intent required.'});
});
const recorded = z.strictObject({status:z.literal('recorded'),original:FinancialPolicyOriginalSchema,closure:z.null()});
const closed = z.strictObject({status:z.literal('closed'),original:z.null(),closure:FinancialPolicyOriginalClosureReceiptSchema});
export const FinancialPolicyOriginalStatusSchema = z.discriminatedUnion('status',[
  recorded,closed,z.strictObject({status:z.literal('not_recorded'),original:z.null(),closure:z.null()}),
]);
export const FinancialPolicyOriginalClosedSchema = z.discriminatedUnion('status',[recorded,closed]);
export type FinancialPolicyOriginalClosureIntent = z.infer<typeof FinancialPolicyOriginalClosureIntentSchema>;
export type FinancialPolicyOriginalStatus = z.infer<typeof FinancialPolicyOriginalStatusSchema>;
export type FinancialPolicyOriginalClosed = z.infer<typeof FinancialPolicyOriginalClosedSchema>;
export interface FinancialPolicyClosures {
  close(identityEvidenceId:string,scope:FinancialPolicyReaderScope,intent:FinancialPolicyOriginalClosureIntent):Promise<FinancialPolicyOriginalClosed>;
  status(identityEvidenceId:string,scope:FinancialPolicyReaderScope,locator:z.infer<typeof FinancialPolicyOriginalClosureLocatorSchema>):Promise<FinancialPolicyOriginalStatus>;
}
