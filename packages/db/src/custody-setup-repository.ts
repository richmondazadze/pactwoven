import type {Pool,PoolClient} from 'pg';
import {CustodyCommandSchema,CustodyResultSchema,CustodyReadSchema,CustodyLookupSchema,CustodyUuidSchema,IdSchema,
  type CustodyCommand,type CustodyResult,type CustodyRead,type CustodyLookup} from '@pactwoven/contracts';
import {DomainError,custodyCommandHash,custodyRecordHash} from '@pactwoven/domain';
import {assertCustodySetupConnection} from './custody-setup-pool.js';
import type {CustodySetupCapability,CustodySetupRepository} from './custody-setup-schema.js';
export const custodyOutcomeUnknown=()=>new DomainError('CUSTODY_OUTCOME_UNKNOWN',503,'The setup result is unconfirmed. Recover the original actor, kind and key.');
export function custodyDatabaseError(error:unknown):never {
  if(error instanceof DomainError)throw error;
  const code=typeof error==='object'&&error!==null&&'code' in error?error.code:null;
  const errors:Record<string,[string,403|409|422,string]>={CS001:['CUSTODY_ACCESS_DENIED',403,'Current scoped setup access is required.'],
    CS002:['CUSTODY_SCOPE_CHANGED',409,'The exact setup or authority scope changed.'],CS003:['CUSTODY_EXPIRED',409,'The setup proof expired.'],
    CS004:['CUSTODY_INPUT_INVALID',422,'Exact internally consistent setup records are required.'],CS005:['CUSTODY_KEY_CONFLICT',409,'Preserve the original operation identity.']};
  const mapped=typeof code==='string'?errors[code]:undefined;
  if(mapped)throw new DomainError(...mapped);throw custodyOutcomeUnknown();
}
export async function custodyTransaction<T>(pool:Pool,capability:CustodySetupCapability,work:(client:PoolClient)=>Promise<T>):Promise<T>{
  let client:PoolClient|undefined,discard=false,committing=false;
  try{client=await pool.connect();await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await client.query("SET LOCAL search_path=pg_catalog; SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='5s'; SET LOCAL idle_in_transaction_session_timeout='8s'");
    await assertCustodySetupConnection(client,capability);const value=await work(client);committing=true;await client.query('COMMIT');return value;
  }catch(error){discard=true;if(client)try{await client.query('ROLLBACK');}catch{/* Discard, never automatically retry. */}
    if(committing){const code=typeof error==='object'&&error!==null&&'code'in error?error.code:null;
      if(typeof code!=='string'||!['CS001','CS002','CS003','CS004','CS005','CS007','23503','23505','23514'].includes(code))throw custodyOutcomeUnknown();}
    return custodyDatabaseError(error);
  }finally{client?.release(discard);}
}
async function checkedResult(raw:unknown,command?:CustodyCommand){const r=CustodyResultSchema.parse(raw);
  if(r.target.recordHash!==await custodyRecordHash(r.body)||r.target.id!==r.body.id||r.target.version!==r.body.version||r.setupId!==r.body.setupId||
    r.organizationId!==r.body.organizationId||r.actorId!==r.body.actorId||r.responsibilityId!==r.body.responsibilityId||
    (command&&(r.kind!==command.kind||r.key!==command.key||r.responsibilityId!==command.responsibilityId||r.commandHash!==await custodyCommandHash(r.organizationId,r.actorId,command))))throw custodyOutcomeUnknown();return r;}
export class PostgresCustodySetupRepository implements CustodySetupRepository{
  constructor(private readonly pool:Pool){}
  async mutate(identityEvidenceId:string,input:CustodyCommand):Promise<CustodyResult>{const id=CustodyUuidSchema.parse(identityEvidenceId),command=CustodyCommandSchema.parse(input);
    return custodyTransaction(this.pool,'writer',async c=>checkedResult((await c.query('SELECT pactwoven.custody_setup_command($1,$2::jsonb) AS response',[id,JSON.stringify(command)])).rows[0]?.response,command));}
  async recover(identityEvidenceId:string,input:CustodyLookup):Promise<CustodyResult|null>{const id=CustodyUuidSchema.parse(identityEvidenceId),v=CustodyLookupSchema.parse(input);
    return custodyTransaction(this.pool,'writer',async c=>{const q=await c.query('SELECT pactwoven.custody_setup_recover($1,$2::jsonb) AS response',[id,JSON.stringify(v)]);if(q.rows.length!==1)throw custodyOutcomeUnknown();
      if(q.rows[0].response===null)return null;const r=await checkedResult(q.rows[0].response);if(r.kind!==v.kind||r.key!==v.key||r.responsibilityId!==v.responsibilityId||r.commandHash!==v.commandHash)throw custodyOutcomeUnknown();return r;});}
  async get(identityEvidenceId:string,responsibilityId:string,setupId:string):Promise<CustodyRead|null>{const id=CustodyUuidSchema.parse(identityEvidenceId),r=IdSchema.parse(responsibilityId),s=CustodyUuidSchema.parse(setupId);
    return custodyTransaction(this.pool,'writer',async c=>{const q=await c.query('SELECT pactwoven.custody_setup_read($1,$2,$3) AS response',[id,r,s]);if(q.rows.length!==1)throw custodyOutcomeUnknown();
      if(q.rows[0].response===null)return null;const v=CustodyReadSchema.parse(q.rows[0].response);if(v.setupId!==s||v.draft.responsibilityId!==r||v.draftHash!==await custodyRecordHash(v.draft))throw custodyOutcomeUnknown();return v;});}
}
