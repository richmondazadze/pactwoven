import type { Pool } from 'pg';
import { z } from 'zod';
import { ActorContextSchema,IdSchema,type ActorContext } from '../../contracts/src/core';
import { commandDigest } from '../../contracts/src/canonical';
import { HashSchema } from '../../contracts/src/financial';
import { DomainError } from '../../domain/src/errors';
import {PaidToolHeightInputSchema,PaidToolHumanSnapshotSchema,PaidToolHumanCommandResponseSchema,PaidToolHumanRecoverySchema,PaidToolHumanListSchema,PaidToolBudgetSchema,PaidToolRecoverInputSchema,PaidToolRecoverySchema,PaidToolListSchema,PaidToolReviewInputSchema,PaidToolReviewSchema,PaidToolQuoteInputSchema,PaidToolObservationInputSchema,PaidToolSnapshotSchema,PaidToolPrivateCommandSchema,PaidToolCommandResponseSchema,PaidToolHumanControlSchema,PaidToolPrivateReadSchema,type PaidToolPrivateCommand,type PaidToolQuoteInput,type PaidToolObservationInput} from './paid-tool-schema';
class PaidToolRepository {
 constructor(protected readonly pool:Pick<Pool,'query'>){}
 protected async query<T>(sql:string,parameters:unknown[],schema:z.ZodType<T>,affinity?:(value:T)=>boolean):Promise<T>{
  // Bounded private records only; no environment URLs, keys or provider responses enter errors.
  if(JSON.stringify(parameters).length>100_000)throw new DomainError('VALIDATION_FAILED',422,'The paid-tool record is too large.');
  try{const result=await this.pool.query<{response:unknown}>(sql,parameters);if(result.rows.length!==1)throw new Error('Missing paid-tool response');const value=schema.parse(result.rows[0]?.response);if(affinity&&!affinity(value))throw new Error('Paid-tool response affinity mismatch');return value;}
  catch(error){const code=typeof error==='object'&&error!==null&&'code'in error?error.code:null;
   if(['PT001','ND001','NM001'].includes(String(code)))throw new DomainError('FORBIDDEN',403,'Current paid-tool authority is required.');
   if(['PT004','23505','ND009'].includes(String(code)))throw new DomainError('ROOT_CONFLICT',409,'The original paid-tool operation needs checking.');
   if(['NM005','NM006','NM008','NM009'].includes(String(code)))throw new DomainError('EVIDENCE_STALE',409,'The paid-tool evidence needs refreshing.');
   throw new DomainError('DURABLE_SERVICE_UNAVAILABLE',503,'The paid-tool operation could not be confirmed.');
  }
 }
 protected actor(value:ActorContext){const actor=ActorContextSchema.parse(value);if(actor.environment!=='development'||actor.principalKind!=='human')throw new DomainError('FORBIDDEN',403,'A development human session is required.');return actor;}
}
/** Bind only to the paid-tool API principal plus its existing native API identity.
 * Actor comes from verified session middleware, never the request body. */
export class PostgresPaidToolHumanRepository extends PaidToolRepository {
 list(actor:ActorContext,rootTaskId:string,siteId:string){return this.query('SELECT pactwoven.paid_tool_list($1::jsonb,$2,$3) response',[this.actor(actor),IdSchema.parse(rootTaskId),IdSchema.parse(siteId)],PaidToolHumanListSchema,value=>value.rootTaskId===rootTaskId&&value.items.every(item=>item.review.organizationId===actor.organizationId&&item.review.rootTaskId===rootTaskId&&item.review.siteId===siteId));}
 recover(actor:ActorContext,rootTaskId:string,siteId:string,input:z.infer<typeof PaidToolRecoverInputSchema>){return this.query('SELECT pactwoven.paid_tool_recover($1::jsonb,$2,$3,$4::jsonb) response',[this.actor(actor),IdSchema.parse(rootTaskId),IdSchema.parse(siteId),PaidToolRecoverInputSchema.parse(input)],PaidToolHumanRecoverySchema,value=>value===null||(value.snapshot.review.organizationId===actor.organizationId&&value.snapshot.review.rootTaskId===rootTaskId&&value.snapshot.review.siteId===siteId&&(input.kind==='approval'?value.snapshot.review.id===input.reviewId&&value.snapshot.review.reviewHash===input.reviewHash:value.snapshot.operationId===input.operationId&&value.receipt?.commandKey===input.commandKey&&value.receipt.commandHash===input.commandHash)));}
 budget(actor:ActorContext,operationId:string){return this.query('SELECT pactwoven.paid_tool_budget_read($1::jsonb,$2) response',[this.actor(actor),IdSchema.parse(operationId)],PaidToolBudgetSchema,value=>value.operationId===operationId);}

 review(actor:ActorContext,input:z.infer<typeof PaidToolReviewInputSchema>){return this.query('SELECT pactwoven.paid_tool_review($1::jsonb,$2::jsonb) response',[this.actor(actor),PaidToolReviewInputSchema.parse(input)],PaidToolReviewSchema,value=>value.id===input.id&&value.quoteId===input.quoteId&&value.organizationId===actor.organizationId&&value.maximumFeeLamports===input.maximumFeeLamports);}
 approve(actor:ActorContext,reviewId:string,key:string,hash:string){return this.query('SELECT pactwoven.paid_tool_approve($1::jsonb,$2,$3,$4) response',[this.actor(actor),IdSchema.parse(reviewId),IdSchema.parse(key),HashSchema.parse(hash)],PaidToolHumanSnapshotSchema,value=>value.review.organizationId===actor.organizationId&&value.review.id===reviewId&&value.review.reviewHash===hash);}
 read(actor:ActorContext,id:string){return this.query('SELECT pactwoven.paid_tool_read($1::jsonb,$2) response',[this.actor(actor),IdSchema.parse(id)],PaidToolHumanSnapshotSchema,value=>value.operationId===id&&value.review.organizationId===actor.organizationId);}
 async control(actor:ActorContext,input:z.infer<typeof PaidToolHumanControlSchema>){const commandHash=await commandDigest({namespace:'pactwoven.paid-tool-command.v1',command:PaidToolHumanControlSchema.parse(input)});return this.query('SELECT pactwoven.paid_tool_control($1::jsonb,$2::jsonb) response',[this.actor(actor),PaidToolHumanControlSchema.parse(input)],PaidToolHumanCommandResponseSchema,value=>value.snapshot.operationId===input.operationId&&value.snapshot.review.organizationId===actor.organizationId&&value.receipt.commandKey===input.commandKey&&value.receipt.commandHash===commandHash&&value.receipt.previousVersion===input.expectedVersion&&value.receipt.version===input.expectedVersion+1&&value.snapshot.version>=value.receipt.version);}
}
/** PRIVATE adapter. SQL derives the actual service purpose from session_user,
 * current role OID and owner enrollment. No context/trust flags are accepted.
 * Observer/signer/delivery methods must be called only after the separate
 * producers verify original bytes and bind them to the stored operation. */
export class PostgresPaidToolPrivateRepository extends PaidToolRepository {
 recordHeight(input:z.infer<typeof PaidToolHeightInputSchema>){return this.query('SELECT pactwoven.paid_tool_record_height($1::jsonb) response',[PaidToolHeightInputSchema.parse(input)],PaidToolHeightInputSchema,value=>Object.entries(input).every(([key,expected])=>value[key as keyof typeof value]===expected));}
 quote(input:PaidToolQuoteInput){return this.query('SELECT pactwoven.paid_tool_quote($1::jsonb) response',[PaidToolQuoteInputSchema.parse(input)],z.strictObject({id:IdSchema,quoteHash:HashSchema}),value=>value.id===input.id&&value.quoteHash===input.quote.challenge.hash);}
 observe(input:PaidToolObservationInput){return this.query('SELECT pactwoven.paid_tool_observe($1::jsonb) response',[PaidToolObservationInputSchema.parse(input)],PaidToolObservationInputSchema,value=>Object.entries(input).every(([key,expected])=>value[key as keyof typeof value]===expected));}
 async apply(input:PaidToolPrivateCommand){const commandHash=await commandDigest({namespace:'pactwoven.paid-tool-command.v1',command:PaidToolPrivateCommandSchema.parse(input)});return this.query('SELECT pactwoven.paid_tool_apply($1::jsonb) response',[PaidToolPrivateCommandSchema.parse(input)],PaidToolCommandResponseSchema,value=>value.snapshot.operationId===input.operationId&&value.receipt.commandKey===input.commandKey&&value.receipt.commandHash===commandHash&&value.receipt.previousVersion===input.expectedVersion&&value.receipt.version===input.expectedVersion+1&&value.snapshot.version>=value.receipt.version);}
 quarantine(id:string,wireBase64:string){return this.query('SELECT pactwoven.paid_tool_quarantine_wire($1,$2) response',[IdSchema.parse(id),z.string().min(1).max(1700).parse(wireBase64)],z.strictObject({wireHash:HashSchema}));}
 read(id:string){return this.query('SELECT pactwoven.paid_tool_private_read($1,NULL,NULL) response',[IdSchema.parse(id)],PaidToolPrivateReadSchema,value=>value.snapshot.operationId===id);}
 recover(id:string,key:string,hash:string){return this.query('SELECT pactwoven.paid_tool_private_read($1,$2,$3) response',[IdSchema.parse(id),IdSchema.parse(key),HashSchema.parse(hash)],PaidToolPrivateReadSchema.nullable(),value=>value===null||(value.snapshot.operationId===id&&value.receipt?.commandKey===key&&value.receipt.commandHash===hash));}
}
