import type {Pool} from 'pg';
import {ActorContextSchema,IdSchema,type ActorContext} from '../../contracts/src/core';
import {NativePaidHistoryResponseSchema} from '../../contracts/src/native-paid-history';
import {DomainError} from '../../domain/src/errors';
/** Human-only immutable history. This repository has no task or payment writes. */
export class PostgresPaidToolHistoryRepository {
 constructor(private readonly pool:Pick<Pool,'query'>){}
 async read(actor:ActorContext,rootTaskId:string,siteId:string,operationId:string){
  const args=[ActorContextSchema.parse(actor),IdSchema.parse(rootTaskId),IdSchema.parse(siteId),IdSchema.parse(operationId)];
  try{const result=await this.pool.query('SELECT pactwoven.paid_tool_completed_history($1::jsonb,$2,$3,$4) response',args);
   if(result.rows.length!==1||JSON.stringify(result.rows[0]?.response).length>400000)throw Error('Invalid retained result');
   const value=NativePaidHistoryResponseSchema.parse(result.rows[0]?.response);
   if(value.scope.organizationId!==actor.organizationId||value.scope.environment!==actor.environment||value.scope.siteId!==siteId||value.rootTaskId!==rootTaskId||value.operationId!==operationId)throw Error('Historical result affinity');
   return value;
  }catch(error){const code=typeof error==='object'&&error!==null&&'code'in error?String(error.code):'';
   if(['ND001','NM001','PT001'].includes(code))throw new DomainError('FORBIDDEN',403,'Current workspace access is required for this saved result.');
   if(['PT004','NM005','NM006','NM008','NM009'].includes(code))throw new DomainError('EVIDENCE_STALE',409,'This saved result could not be verified.');
   throw new DomainError('DURABLE_SERVICE_UNAVAILABLE',503,'The saved result is unavailable.');}
 }
}
