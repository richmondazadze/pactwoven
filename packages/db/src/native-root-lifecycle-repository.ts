import { Pool } from 'pg';
import { z } from 'zod';
import { ActorContextSchema,EnvironmentSchema,IdSchema,IdempotencyKeySchema,type ActorContext,type Environment } from '@pactwoven/contracts';
import { DomainError } from '@pactwoven/domain';
import { NativeDelegationClaimSelectorSchema,NativeDelegationTargetSchema,type NativeDelegationClaimSelector,type NativeDelegationTarget } from './native-delegation-repository';
import { NativeServiceIdentitySchema,NativeDelegationReferenceSchema } from '../../contracts/src/native-delegation';
import { InstantSchema } from '../../contracts/src/core';
import { NativeRootCheckpointCommandSchema,NativeRootCheckpointReceiptSchema,NativeRootControlSchema,NativeRootControlReceiptSchema,
 NativeRootInputsCommandSchema,NativeRootInputReceiptSchema,NativeRootCompleteCommandSchema,NativeRootCompleteReceiptSchema,
 NativeRootYieldCommandSchema,NativeRootViewSchema,NativeRootRecoverySchema,
 NativeRootBindNotesCommandSchema,NativeRootHandoffCommandSchema,NativeRootWorkSchema,NativeRootMaterialsSchema,
 type NativeRootCheckpointCommand,type NativeRootYieldCommand,type NativeRootControl,type NativeRootInputsCommand,type NativeRootCompleteCommand } from './native-root-lifecycle-schema';
const Claim=z.strictObject({selector:NativeDelegationClaimSelectorSchema,validUntil:InstantSchema,identity:NativeServiceIdentitySchema,
 authority:NativeDelegationReferenceSchema,attempt:z.number().int().min(1).max(4),handoff:z.null()});
class RootRepository {
 constructor(protected readonly pool:Pool,protected readonly environment:Environment){EnvironmentSchema.parse(environment);}
 protected actor(input:ActorContext){const actor=ActorContextSchema.parse(input);if(actor.environment!==this.environment)throw new DomainError('FORBIDDEN',403,'This work belongs to another environment.');return actor;}
 protected async query<T>(sql:string,values:unknown[],schema:z.ZodType<T>):Promise<T>{try{
  const result=await this.pool.query<{response:unknown}>(sql,values);if(result.rows.length!==1)throw new Error('Missing root response');return schema.parse(result.rows[0]?.response);
 }catch(error){if(error instanceof DomainError)throw error;const code=typeof error==='object'&&error!==null&&'code'in error?error.code:null;
  if(code==='ND001'||code==='NM001')throw new DomainError('FORBIDDEN',403,'Current work access is required.');
  if(code==='ND004'||code==='NM004')throw new DomainError('VALIDATION_FAILED',422,'The work update is invalid.');
  if(code==='ND009'||code==='23505')throw new DomainError('ROOT_CONFLICT',409,'The retained work changed.');
  if(['NM005','NM006','NM008','NM009'].includes(String(code)))throw new DomainError('EVIDENCE_STALE',409,'Original evidence needs review.');
  throw new DomainError('DURABLE_SERVICE_UNAVAILABLE',503,'The work update has not been confirmed.');
 }}
}
export class PostgresNativeRootRepository extends RootRepository {
 bindNotes(actor:ActorContext,key:string,input:z.infer<typeof NativeRootBindNotesCommandSchema>){return this.query('SELECT pactwoven.native_delegation_root_bind_notes($1::jsonb,$2,$3::jsonb) AS response',[this.actor(actor),IdempotencyKeySchema.parse(key),NativeRootBindNotesCommandSchema.parse(input)],z.strictObject({rootTaskId:IdSchema,selectedCount:z.number().int().min(0).max(32)}));}
 read(actor:ActorContext,id:string){return this.query('SELECT pactwoven.native_delegation_root_read($1::jsonb,$2) AS response',[this.actor(actor),IdSchema.parse(id)],NativeRootViewSchema.refine(value=>value.id===id&&value.scope.environment===actor.environment&&value.scope.organizationId===actor.organizationId&&(!value.evidenceUnavailable||(value.checkpoint===null&&value.result===null))));}
 control(actor:ActorContext,key:string,input:NativeRootControl){return this.query('SELECT pactwoven.native_delegation_root_control($1::jsonb,$2,$3::jsonb) AS response',[this.actor(actor),IdempotencyKeySchema.parse(key),NativeRootControlSchema.parse(input)],NativeRootControlReceiptSchema.refine(value=>value.rootTaskId===input.rootTaskId&&value.action===input.action&&value.scope.environment===actor.environment&&value.scope.organizationId===actor.organizationId));}
 recover(actor:ActorContext,id:string,key:string){return this.query('SELECT pactwoven.native_delegation_root_control_recover($1::jsonb,$2,$3) AS response',[this.actor(actor),IdSchema.parse(id),IdempotencyKeySchema.parse(key)],NativeRootControlReceiptSchema.nullable().refine(value=>!value||(value.rootTaskId===id&&value.scope.environment===actor.environment&&value.scope.organizationId===actor.organizationId)));}
}
export class PostgresNativeRootCoordinatorRepository extends RootRepository {
 work(selector:NativeDelegationClaimSelector){return this.query('SELECT pactwoven.native_delegation_root_work($1,$2::jsonb) AS response',[this.environment,NativeDelegationClaimSelectorSchema.parse(selector)],NativeRootWorkSchema);}
 handoff(selector:NativeDelegationClaimSelector,input:z.infer<typeof NativeRootHandoffCommandSchema>){return this.query('SELECT pactwoven.native_delegation_root_handoff($1,$2::jsonb,$3::jsonb) AS response',[this.environment,NativeDelegationClaimSelectorSchema.parse(selector),NativeRootHandoffCommandSchema.parse(input)],z.strictObject({kind:z.enum(['accepted','duplicate']),execution:z.enum(['advisory_only','none']),digest:z.string().regex(/^[a-f0-9]{64}$/)}));}
 claim(target:NativeDelegationTarget,milliseconds=15000){return this.query('SELECT pactwoven.native_delegation_root_claim($1,$2::jsonb,$3) AS response',[this.environment,NativeDelegationTargetSchema.parse(target),z.number().int().min(1000).max(30000).parse(milliseconds)],Claim);}
 checkpoint(selector:NativeDelegationClaimSelector,input:NativeRootCheckpointCommand){return this.query('SELECT pactwoven.native_delegation_root_checkpoint($1,$2::jsonb,$3::jsonb) AS response',[this.environment,NativeDelegationClaimSelectorSchema.parse(selector),NativeRootCheckpointCommandSchema.parse(input)],NativeRootCheckpointReceiptSchema);}
 yield(selector:NativeDelegationClaimSelector,input:NativeRootYieldCommand){return this.query('SELECT pactwoven.native_delegation_root_yield($1,$2::jsonb,$3::jsonb) AS response',[this.environment,NativeDelegationClaimSelectorSchema.parse(selector),NativeRootYieldCommandSchema.parse(input)],NativeRootCheckpointReceiptSchema);}
 inputs(selector:NativeDelegationClaimSelector,input:NativeRootInputsCommand){return this.query('SELECT pactwoven.native_delegation_root_inputs($1,$2::jsonb,$3::jsonb) AS response',[this.environment,NativeDelegationClaimSelectorSchema.parse(selector),NativeRootInputsCommandSchema.parse(input)],NativeRootInputReceiptSchema);}
 complete(selector:NativeDelegationClaimSelector,input:NativeRootCompleteCommand){return this.query('SELECT pactwoven.native_delegation_root_complete($1,$2::jsonb,$3::jsonb) AS response',[this.environment,NativeDelegationClaimSelectorSchema.parse(selector),NativeRootCompleteCommandSchema.parse(input)],NativeRootCompleteReceiptSchema);}
}
export class PostgresNativeRootWorkerRepository extends RootRepository {
 materials(selector:NativeDelegationClaimSelector){return this.query('SELECT pactwoven.native_delegation_root_materials($1,$2::jsonb) AS response',[this.environment,NativeDelegationClaimSelectorSchema.parse(selector)],NativeRootMaterialsSchema);}
}
export class PostgresNativeRootDispatchRepository extends RootRepository {
 route(target:NativeDelegationTarget){return this.query('SELECT pactwoven.native_delegation_root_route($1,$2::jsonb) AS response',[this.environment,NativeDelegationTargetSchema.parse(target)],z.strictObject({kind:z.enum(['root','specialist']),identity:NativeServiceIdentitySchema}).nullable());}
 recover(limit=20){return this.query('SELECT pactwoven.native_delegation_root_recover($1,$2) AS response',[this.environment,z.number().int().min(1).max(20).parse(limit)],NativeRootRecoverySchema);}
}
