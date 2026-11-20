import type { Pool, PoolClient } from 'pg';
import { FinancialPolicyUuidSchema, FinancialPolicyOriginalClosureLocatorSchema, financialPolicyOriginalClosureReceiptHash,
  type FinancialPolicyOriginalClosureLocator } from '@pactwoven/contracts';
import { canonicalJson, financialPolicyHttpRequestFromStoredCommand, projectFinancialPolicyHttpReceipt } from '@pactwoven/domain';
import { assertFinancialPolicyClosureConnection } from './financial-authority-pool.js';
import { financialPolicyTransaction, financialPolicyOne, financialPolicyOutcomeUnknown } from './financial-policy-repository.js';
import { FinancialPolicyReaderScopeSchema, type FinancialPolicyReaderScope } from './financial-policy-read-schema.js';
import { FinancialPolicyOriginalClosureIntentSchema, FinancialPolicyOriginalStatusSchema, FinancialPolicyOriginalClosedSchema,
  type FinancialPolicyOriginalClosureIntent, type FinancialPolicyOriginalStatus, type FinancialPolicyClosures } from './financial-policy-closure-schema.js';

const same = (a:unknown,b:unknown) => canonicalJson(a)===canonicalJson(b);
async function qualify(raw:unknown,s:FinancialPolicyReaderScope,q:FinancialPolicyOriginalClosureLocator):Promise<FinancialPolicyOriginalStatus> {
  const parsed=FinancialPolicyOriginalStatusSchema.safeParse(raw);if(!parsed.success)throw financialPolicyOutcomeUnknown();const value=parsed.data;
  if(value.status==='closed') {
    const c=value.closure;
    if(c.environment!==s.environment||c.organizationId!==s.organizationId||c.actor.actorId!==s.actor.actorId||!same(c.locator,q)||
      c.recordHash!==await financialPolicyOriginalClosureReceiptHash(c))throw financialPolicyOutcomeUnknown();
  } else if(value.status==='recorded') {
    const {command,result}=value.original,a=result.body.actor,scope={environment:s.environment,organizationId:s.organizationId,actorId:s.actor.actorId};
    if(result.responsibilityId!==q.responsibilityId||result.kind!==q.kind||result.key!==q.key||result.body.id!==q.targetId||
      a.actorId!==s.actor.actorId||a.subject!==s.actor.subject||a.externalMembershipId!==s.actor.externalMembershipId)throw financialPolicyOutcomeUnknown();
    const request=await financialPolicyHttpRequestFromStoredCommand(scope,command);
    await projectFinancialPolicyHttpReceipt({scope,request,publicRequestHash:q.publicRequestHash},command,result);
  }
  return value;
}
/** Full 0019 admission is mandatory. No credential acquisition, retry or policy mutation occurs here. */
export class PostgresFinancialPolicyClosureRepository implements FinancialPolicyClosures {
  private readonly pool:Pool;
  constructor(pool:Pool) {const connect=pool.connect.bind(pool);this.pool={connect:async()=>{const c=await connect();
    return {query:c.query.bind(c),release:c.release.bind(c)} as PoolClient;}} as Pool;}
  async close(identityEvidenceId:string,scope:FinancialPolicyReaderScope,input:FinancialPolicyOriginalClosureIntent) {
    const id=FinancialPolicyUuidSchema.parse(identityEvidenceId),s=FinancialPolicyReaderScopeSchema.parse(scope),intent=FinancialPolicyOriginalClosureIntentSchema.parse(input);
    return financialPolicyTransaction(this.pool,'authorizer',async c=>{
      await assertFinancialPolicyClosureConnection(c);
      const raw=financialPolicyOne((await c.query('SELECT pactwoven.financial_policy_close_original($1,$2::jsonb,$3::jsonb) AS response',[id,JSON.stringify(s),JSON.stringify(intent)])).rows);
      const value=await qualify(raw,s,intent.locator),parsed=FinancialPolicyOriginalClosedSchema.safeParse(value);
      if(!parsed.success)throw financialPolicyOutcomeUnknown();return parsed.data;
    });
  }
  async status(identityEvidenceId:string,scope:FinancialPolicyReaderScope,input:FinancialPolicyOriginalClosureLocator) {
    const id=FinancialPolicyUuidSchema.parse(identityEvidenceId),s=FinancialPolicyReaderScopeSchema.parse(scope),q=FinancialPolicyOriginalClosureLocatorSchema.parse(input);
    return financialPolicyTransaction(this.pool,'authorizer',async c=>{
      await assertFinancialPolicyClosureConnection(c);
      return qualify(financialPolicyOne((await c.query('SELECT pactwoven.financial_policy_original_status($1,$2::jsonb,$3::jsonb) AS response',[id,JSON.stringify(s),JSON.stringify(q)])).rows),s,q);
    });
  }
}
