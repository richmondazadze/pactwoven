import type { Pool } from 'pg';
import { z } from 'zod';
import { ActorContextSchema, EnvironmentSchema, IdempotencyKeySchema, IdSchema, type ActorContext, type Environment } from '@pactwoven/contracts';
import { NativeMemoryReferenceSchema, type NativeMemoryReference } from '../../contracts/src/native-memory';
import { DomainError } from '@pactwoven/domain';
import { NativeMemoryWriteSchema, NativeMemorySourceWriteSchema, NativeMemoryHumanReadSchema, NativeMemoryTaskSelectorSchema,
  NativeMemoryReadResultSchema, NativeMemoryRecoverySchema, type NativeMemoryWrite, type NativeMemorySourceWrite,
  type NativeMemoryHumanRead, type NativeMemoryTaskSelector, type NativeMemoryReadResult, type NativeMemoryRecovery } from './native-memory-persistence-schema';

function databaseError(error: unknown): never {
  if(error instanceof DomainError)throw error;
  const code = typeof error==='object' && error!==null && 'code' in error ? error.code : null;
  const errors = {
    NM001:['FORBIDDEN',403,'Current access to this memory is required.'],
    NM002:['NOT_FOUND',404,'Memory was not found.'],
    NM003:['IDEMPOTENCY_CONFLICT',409,'This request reference was used for another update.'],
    NM004:['VALIDATION_FAILED',422,'Check the memory details.'],
    NM005:['VERSION_CONFLICT',409,'Memory or its sources changed. Refresh before continuing.'],
    NM006:['MEMORY_UNAVAILABLE',409,'This memory is no longer available for use.'],
    NM007:['MEMORY_LIMIT',409,'The memory dependency limit was reached.'],
    NM008:['EVIDENCE_STALE',409,'Refresh the evidence before continuing.'],
    NM009:['MEMORY_INTEGRITY',409,'The memory record could not be verified.'],
    ND001:['FORBIDDEN',403,'Current access to this memory is required.'],
    ND002:['NOT_FOUND',404,'The delegated work was not found.'],
    ND004:['VALIDATION_FAILED',422,'Check the delegated work details.'],
    ND005:['VERSION_CONFLICT',409,'The delegated work changed. Refresh before continuing.'],
    ND008:['EVIDENCE_STALE',409,'Refresh the delegated authority before continuing.'],
  } as const;
  if(typeof code==='string' && Object.hasOwn(errors,code)) {
    const [name,status,message]=errors[code as keyof typeof errors];throw new DomainError(name,status,message);
  }
  // A lost connection may follow commit. Preserve the original key and recover;
  // neither an automatic retry with a new identity nor success is inferred.
  throw new DomainError('DURABLE_SERVICE_UNAVAILABLE',503,'The memory update has not been confirmed. Recover the original request before trying again.');
}
async function call<T>(pool: Pool,sql:string,parameters:unknown[],schema:z.ZodType<T>):Promise<T> {
  try {
    const result=await pool.query<{response:unknown}>(sql,parameters);
    if(result.rows.length!==1)throw new Error('Missing response');
    return schema.parse(result.rows[0]?.response);
  } catch(error) { return databaseError(error); }
}
export class PostgresNativeMemoryRepository {
  constructor(private readonly pool:Pool,private readonly environment:Environment) { EnvironmentSchema.parse(environment); }
  private actor(input:ActorContext) {
    const actor=ActorContextSchema.parse(input);
    if(actor.environment!==this.environment || actor.principalKind!=='human')throw new DomainError('FORBIDDEN',403,'Current memory access is required.');
    return JSON.stringify(actor);
  }
  read(actor:ActorContext,input:NativeMemoryHumanRead):Promise<NativeMemoryReadResult> {
    return call(this.pool,'SELECT pactwoven.native_memory_human_read($1::jsonb,$2::jsonb) AS response',
      [this.actor(actor),JSON.stringify(NativeMemoryHumanReadSchema.parse(input))],NativeMemoryReadResultSchema);
  }
  source(actor:ActorContext,key:string,input:NativeMemorySourceWrite):Promise<NativeMemoryRecovery> {
    return call(this.pool,'SELECT pactwoven.native_memory_human_source($1::jsonb,$2,$3::jsonb) AS response',
      [this.actor(actor),IdempotencyKeySchema.parse(key),JSON.stringify(NativeMemorySourceWriteSchema.parse(input))],NativeMemoryRecoverySchema);
  }
  mutate(actor:ActorContext,key:string,input:NativeMemoryWrite):Promise<NativeMemoryRecovery> {
    return call(this.pool,'SELECT pactwoven.native_memory_human_mutate($1::jsonb,$2,$3::jsonb) AS response',
      [this.actor(actor),IdempotencyKeySchema.parse(key),JSON.stringify(NativeMemoryWriteSchema.parse(input))],NativeMemoryRecoverySchema);
  }
  recover(actor:ActorContext,siteId:string,key:string):Promise<NativeMemoryRecovery|null> {
    return call(this.pool,'SELECT pactwoven.native_memory_human_recover($1::jsonb,$2,$3) AS response',
      [this.actor(actor),IdSchema.parse(siteId),IdempotencyKeySchema.parse(key)],NativeMemoryRecoverySchema.nullable());
  }
}
export class PostgresNativeMemoryTaskRepository {
  constructor(private readonly pool:Pool,private readonly environment:Environment) { EnvironmentSchema.parse(environment); }
  read(selector:NativeMemoryTaskSelector,reference:NativeMemoryReference):Promise<NativeMemoryReadResult> {
    const ref=NativeMemoryReferenceSchema.parse(reference),task=NativeMemoryTaskSelectorSchema.parse(selector);
    if(ref.environment!==this.environment || ref.organizationId!==task.organizationId)throw new DomainError('FORBIDDEN',403,'Current scoped memory access is required.');
    return call(this.pool,'SELECT pactwoven.native_memory_task_read($1,$2::jsonb,$3::jsonb) AS response',
      [this.environment,JSON.stringify(task),JSON.stringify(ref)],NativeMemoryReadResultSchema);
  }
}
