import type {Pool} from 'pg';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {IdSchema} from '../../contracts/src/core';
import {DomainError} from '../../domain/src/errors';
import {PaidToolDispatchTargetSchema,PaidToolDispatchSelectorSchema,PaidToolDispatchClaimSchema,PaidToolDispatchItemSchema,PaidToolDispatchLeaseSchema,PaidToolDispatchFinishSchema,PaidToolDispatchRecoverSchema,PaidToolRpcCaptureSchema,type PaidToolDispatchTarget,type PaidToolDispatchSelector,type PaidToolRpcCapture} from '../../contracts/src/paid-tool-dispatch';
import {PaidToolObservationInputSchema,type PaidToolObservationInput} from './paid-tool-schema';
class BoundPaidRepository {
 constructor(protected readonly pool:Pick<Pool,'query'>){}
 protected async query<T>(sql:string,args:unknown[],schema:z.ZodType<T>,affinity:(value:T)=>boolean=()=>true):Promise<T>{try{if(JSON.stringify(args).length>290000)throw Error('Bound exceeded');const result=await this.pool.query<{response:unknown}>(sql,args);if(result.rows.length!==1)throw Error('Missing response');const value=schema.parse(result.rows[0]?.response);if(!affinity(value))throw Error('Response affinity');return value;}catch(error){const code=typeof error==='object'&&error!==null&&'code'in error?String(error.code):'';if(code==='PT001')throw new DomainError('FORBIDDEN',403,'Current paid-tool service authority is required.');if(['PT004','23505'].includes(code))throw new DomainError('ROOT_CONFLICT',409,'The original paid operation changed.');throw new DomainError('DURABLE_SERVICE_UNAVAILABLE',503,'The paid operation handoff could not be confirmed.');}}
}
/** Scheduling metadata only. This principal cannot approve, read signed wire,
 * sign, broadcast, or establish payment finality. Queue payloads carry no secrets. */
export class PostgresPaidToolDispatchRepository extends BoundPaidRepository {
 dispatchClaim(input:z.infer<typeof PaidToolDispatchClaimSchema>){return this.query('SELECT pactwoven.paid_tool_dispatch_claim($1::jsonb) response',[PaidToolDispatchClaimSchema.parse(input)],z.array(PaidToolDispatchItemSchema).max(20),items=>items.length<=input.limit&&new Set(items.map(x=>x.target.operationId)).size===items.length);}
 ack(target:PaidToolDispatchTarget,dispatchToken:string){return this.query('SELECT pactwoven.paid_tool_dispatch_ack($1::jsonb,$2) response',[PaidToolDispatchTargetSchema.parse(target),z.uuid().parse(dispatchToken)],z.boolean());}
 claim(target:PaidToolDispatchTarget,input:z.infer<typeof PaidToolDispatchLeaseSchema>){return this.query('SELECT pactwoven.paid_tool_dispatch_consume($1::jsonb,$2::jsonb) response',[PaidToolDispatchTargetSchema.parse(target),PaidToolDispatchLeaseSchema.parse(input)],PaidToolDispatchSelectorSchema.nullable(),v=>v===null||v.operationId===target.operationId&&v.generation===target.generation);}
 finish(selector:PaidToolDispatchSelector,input:z.infer<typeof PaidToolDispatchFinishSchema>){return this.query('SELECT pactwoven.paid_tool_dispatch_finish($1::jsonb,$2::jsonb) response',[PaidToolDispatchSelectorSchema.parse(selector),PaidToolDispatchFinishSchema.parse(input)],z.boolean());}
 recover(input:z.infer<typeof PaidToolDispatchRecoverSchema>){return this.query('SELECT pactwoven.paid_tool_dispatch_recover($1::jsonb) response',[PaidToolDispatchRecoverSchema.parse(input)],z.number().int().min(0).max(input.limit));}
}
/** Restricted signer account observations plus private append-only raw RPC
 * evidence. SQL independently checks hashes and operation/account affinity. */
export class PostgresPaidToolEvidenceRepository extends BoundPaidRepository {
 observeForOperation(operationId:string,input:PaidToolObservationInput){return this.query('SELECT pactwoven.paid_tool_observe_for_operation($1,$2::jsonb) response',[IdSchema.parse(operationId),PaidToolObservationInputSchema.parse(input)],PaidToolObservationInputSchema,value=>Object.entries(input).every(([k,v])=>value[k as keyof typeof value]===v));}
 captureForOperation(operationId:string,input:PaidToolRpcCapture){const capture=PaidToolRpcCaptureSchema.parse(input);if(createHash('sha256').update(capture.requestPayload).digest('hex')!==capture.requestHash||createHash('sha256').update(Buffer.from(capture.payloadHex,'hex')).digest('hex')!==capture.sha256||JSON.parse(capture.requestPayload).method!==capture.method)throw new DomainError('VALIDATION_FAILED',422,'The operation evidence digest does not match.');return this.query('SELECT pactwoven.paid_tool_capture_for_operation($1,$2::jsonb) response',[IdSchema.parse(operationId),capture],z.strictObject({operationId:IdSchema,reference:IdSchema,sha256:z.string().regex(/^[a-f0-9]{64}$/)}),v=>v.operationId===operationId&&v.reference===capture.reference&&v.sha256===capture.sha256);}
}
