import type { Pool } from 'pg';
import { z } from 'zod';
import { EnvironmentSchema, IdSchema, type Environment } from '../../contracts/src/core';
import { NativeGoogleAttemptSchema, NativeGoogleConnectionSchema, NativeGoogleError, NativeGoogleProvenanceSchema, NativeGoogleReadSchema, NativeGoogleRecoverySchema,
  NativeGoogleSessionSchema, NativeGoogleSnapshotSchema, type NativeGoogleAttempt, type NativeGoogleConnection, type NativeGoogleProvenance,
  type NativeGoogleRead, type NativeGoogleSession, type NativeGoogleStore } from '../../contracts/src/native-google';
const Digest=z.string().regex(/^[a-f0-9]{64}$/),Version=z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
/** Private server store. Dedicated auth and worker logins have disjoint function
 * grants; neither has table access. Missing signed-session/read/artifact bridges
 * return integration-required. No HTTP route, key discovery or public export. */
export class PostgresNativeGoogleStore implements NativeGoogleStore {
  constructor(private readonly authPool:Pool,private readonly workerPool:Pool|undefined,private readonly environment:Environment){EnvironmentSchema.parse(environment);}
  private async call<T>(pool:Pool|undefined,name:string,args:unknown[],schema:z.ZodType<T>):Promise<T>{
    if(!pool)throw new NativeGoogleError('GOOGLE_INTEGRATION_REQUIRED');
    try{
      const result=await pool.query<{response:unknown}>(`SELECT pactwoven.${name}(${['$1',...args.map((_,i)=>`$${i+2}`)].join(',')}) AS response`,[this.environment,...args]);
      if(result.rows.length!==1)throw Error();return schema.parse(result.rows[0]?.response);
    }catch(error){
      const code=typeof error==='object'&&error!==null&&'code'in error?String(error.code):'';
      throw new NativeGoogleError(({NG001:'GOOGLE_DENIED',NG004:'GOOGLE_DENIED',NG008:'GOOGLE_DENIED',NG003:'GOOGLE_CONFLICT',NG010:'GOOGLE_INTEGRATION_REQUIRED'}as const)[code as 'NG001']??'GOOGLE_OUTCOME_UNKNOWN');
    }
  }
  private session(value:NativeGoogleSession){const session=NativeGoogleSessionSchema.parse(value);if(session.actor.environment!==this.environment)throw new NativeGoogleError('GOOGLE_DENIED');return session;}
  private read(value:NativeGoogleRead){const read=NativeGoogleReadSchema.parse(value);if(read.request.scope.environment!==this.environment)throw new NativeGoogleError('GOOGLE_DENIED');return read;}
  async createAttempt(value:NativeGoogleAttempt){const input=NativeGoogleAttemptSchema.parse(value);this.session(input.session);await this.call(this.authPool,'native_google_create_attempt',[input],z.literal(true));}
  async reserveAttempt(stateHash:string,session:NativeGoogleSession,operationId:string){return this.call(this.authPool,'native_google_reserve_attempt',[Digest.parse(stateHash),this.session(session),IdSchema.parse(operationId)],NativeGoogleAttemptSchema);}
  async completeAttempt(id:string,session:NativeGoogleSession,operationId:string,connection:NativeGoogleConnection){await this.call(this.authPool,'native_google_complete_attempt',[IdSchema.parse(id),this.session(session),IdSchema.parse(operationId),NativeGoogleConnectionSchema.parse(connection)],z.literal(true));}
  async recoverAttempt(stateHash:string,session:NativeGoogleSession){return this.call(this.authPool,'native_google_recover_attempt',[Digest.parse(stateHash),this.session(session)],NativeGoogleRecoverySchema);}
  async failAttempt(id:string,operationId:string){await this.call(this.authPool,'native_google_fail_attempt',[IdSchema.parse(id),IdSchema.parse(operationId)],z.literal(true));}
  async revoke(id:string,session:NativeGoogleSession,expectedVersion:number){await this.call(this.authPool,'native_google_revoke',[IdSchema.parse(id),this.session(session),Version.parse(expectedVersion)],z.literal(true));}
  async resolveRead(connectionId:string,providerReference:string){
    const result=await this.call(this.workerPool,'native_google_resolve_read',[IdSchema.parse(connectionId),IdSchema.parse(providerReference)],NativeGoogleSnapshotSchema);
    if(result.read.providerReference!==providerReference||result.connection.binding.connectionId!==connectionId||result.connection.binding.environment!==this.environment)throw new NativeGoogleError('GOOGLE_DENIED');return result;
  }
  async reserveRefresh(read:NativeGoogleRead,version:number,operationId:string){return this.call(this.workerPool,'native_google_reserve_refresh',[this.read(read),Version.parse(version),IdSchema.parse(operationId)],NativeGoogleConnectionSchema);}
  async completeRefresh(read:NativeGoogleRead,operationId:string,connection:NativeGoogleConnection){await this.call(this.workerPool,'native_google_complete_refresh',[this.read(read),IdSchema.parse(operationId),NativeGoogleConnectionSchema.parse(connection)],z.literal(true));}
  async failRefresh(connectionId:string,operationId:string){await this.call(this.workerPool,'native_google_fail_refresh',[IdSchema.parse(connectionId),IdSchema.parse(operationId)],z.literal(true));}
  async retainObservation(read:NativeGoogleRead,provenance:NativeGoogleProvenance){return this.call(this.workerPool,'native_google_retain_observation',[this.read(read),NativeGoogleProvenanceSchema.parse(provenance)],NativeGoogleProvenanceSchema);}
}
