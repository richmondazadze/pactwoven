import type { Pool } from 'pg';
import { z } from 'zod';
import { IdSchema, IdempotencyKeySchema } from '../../contracts/src/core';
import { NativeDelegationClaimSelectorSchema, type NativeDelegationClaimSelector } from './native-delegation-repository';
import { PaidToolRootRevalidationStateSchema, PaidToolRootRevalidationReceiptSchema, PaidToolRootRevalidationParkSchema } from '../../contracts/src/native-paid-revalidation';
import { DomainError } from '../../domain/src/errors';
import { PaidToolRootSelectionSchema } from './paid-tool-root-schema';
const base={schemaVersion:z.literal(1),expectedInstructionRevision:z.number().int().min(0).max(16),expectedRefreshEpoch:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),quoteId:IdSchema,operationId:IdSchema,requestKey:IdempotencyKeySchema};
export const PaidToolRootRevalidationInputSchema=z.strictObject({...base,inputReceipts:z.array(z.strictObject({receiptId:z.uuid(),digest:z.string().regex(/^[a-f0-9]{64}$/)})).min(1).max(32),selection:PaidToolRootSelectionSchema});
export const PaidToolRootRevalidationParkInputSchema=z.strictObject(base);
/** Current coordinator lease only. Reuses one already completed purchase; no payment ports. */
export class PostgresPaidToolRevalidationRepository {
 constructor(private readonly pool:Pick<Pool,'query'>){}
 private async query<T>(sql:string,args:unknown[],schema:z.ZodType<T>,affinity:(value:T)=>boolean){
  try {if(JSON.stringify(args).length>100000)throw Error('Bounded revalidation required');const result=await this.pool.query<{response:unknown}>(sql,args);if(result.rows.length!==1)throw Error('Missing revalidation');const value=schema.parse(result.rows[0]?.response);if(!affinity(value))throw Error('Revalidation affinity');return value;}
  catch(error){const code=typeof error==='object'&&error!==null&&'code'in error?String(error.code):'';if(['ND001','NM001','PT001'].includes(code))throw new DomainError('FORBIDDEN',403,'Current work authority is required.');if(['NM005','NM006','NM007','NM008','NM009'].includes(code))throw new DomainError('EVIDENCE_STALE',409,'Fresh permitted evidence is required.');if(['ND009','PT004','23505'].includes(code))throw new DomainError('ROOT_CONFLICT',409,'The original work changed.');throw new DomainError('DURABLE_SERVICE_UNAVAILABLE',503,'The purchased result could not be revalidated.');}
 }
 revalidation(selector:NativeDelegationClaimSelector){return this.query('SELECT pactwoven.paid_tool_root_revalidation($1::jsonb) response',[NativeDelegationClaimSelectorSchema.parse(selector)],PaidToolRootRevalidationStateSchema,value=>value.rootTaskId===selector.taskId);}
 revalidate(selector:NativeDelegationClaimSelector,input:z.infer<typeof PaidToolRootRevalidationInputSchema>){const q=PaidToolRootRevalidationInputSchema.parse(input);return this.query('SELECT pactwoven.paid_tool_root_revalidate($1::jsonb,$2::jsonb) response',[NativeDelegationClaimSelectorSchema.parse(selector),q],PaidToolRootRevalidationReceiptSchema,value=>value.rootTaskId===selector.taskId&&value.generation===selector.generation&&value.instructionRevision===q.expectedInstructionRevision&&value.refreshEpoch===q.expectedRefreshEpoch&&value.quoteId===q.quoteId&&value.operationId===q.operationId&&value.requestKey===q.requestKey);}
 park(selector:NativeDelegationClaimSelector,input:z.infer<typeof PaidToolRootRevalidationParkInputSchema>){const q=PaidToolRootRevalidationParkInputSchema.parse(input);return this.query('SELECT pactwoven.paid_tool_root_revalidation_park($1::jsonb,$2::jsonb) response',[NativeDelegationClaimSelectorSchema.parse(selector),q],PaidToolRootRevalidationParkSchema,value=>value.rootTaskId===selector.taskId&&value.generation===selector.generation+1&&value.instructionRevision===q.expectedInstructionRevision&&value.refreshEpoch===q.expectedRefreshEpoch&&value.quoteId===q.quoteId&&value.operationId===q.operationId&&value.requestKey===q.requestKey);}
}
