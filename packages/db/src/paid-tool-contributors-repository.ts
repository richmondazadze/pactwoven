import type {Pool} from 'pg';
import {ActorContextSchema,IdSchema,type ActorContext} from '../../contracts/src/core';
import {NativePaidContributorsSchema} from '../../contracts/src/native-paid-contributors';
import {DomainError} from '../../domain/src/errors';
/** Paid API purpose only. The database revalidates current human disclosure and
 * the original accepted inputs. No worker claim or payment action is exposed. */
export class PostgresPaidToolContributorsRepository{
 constructor(private readonly pool:Pick<Pool,'query'>){}
 async read(input:ActorContext,rootTaskId:string,siteId:string){
  const actor=ActorContextSchema.parse(input);IdSchema.parse(rootTaskId);IdSchema.parse(siteId);
  if(actor.environment!=='development'||actor.principalKind!=='human'||!actor.siteIds.includes(siteId))throw new DomainError('FORBIDDEN',403,'Current work access is required.');
  try{
   const result=await this.pool.query<{response:unknown}>('SELECT pactwoven.paid_tool_retained_contributors($1::jsonb,$2,$3) response',[actor,rootTaskId,siteId]);
   if(result.rows.length!==1)throw Error('Missing contributors');
   const frame=NativePaidContributorsSchema.parse(result.rows[0]?.response);
   if(frame.scope.environment!==actor.environment||frame.scope.organizationId!==actor.organizationId||frame.scope.siteId!==siteId||frame.rootTaskId!==rootTaskId)throw Error('Contributor scope mismatch');
   return frame;
  }catch(error){const code=typeof error==='object'&&error!==null&&'code'in error?String(error.code):'';
   if(['ND001','NM001','PT001'].includes(code))throw new DomainError('FORBIDDEN',403,'Current work access is required.');
   throw new DomainError('DURABLE_SERVICE_UNAVAILABLE',503,'Recorded contributions could not be refreshed.');
  }
 }
}
