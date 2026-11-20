import type { Pool, PoolClient } from 'pg';
import { EnvironmentSchema, FinancialPolicyUuidSchema, FinancialPolicyRefSchema, FinancialPolicyResultSchema,
  FinancialPolicyReadSchema, encodeSolanaBase58, type FinancialPolicyCommand, type FinancialPolicyResult,
  type FinancialPolicyRead, type FinancialPolicyReadQuery } from '@pactwoven/contracts';
import { canonicalJson, commandDigest, financialPolicyCommandHash, financialPolicyRecordRef, financialPolicyTextHash,
  financialBudgetAccountId, financialBudgetPeriodId, physicalAssetKey, provenanceBytes } from '@pactwoven/domain';
import { financialPolicyTransaction, financialPolicyOne, financialPolicyOutcomeUnknown } from './financial-policy-repository.js';
import { FinancialPolicyReadObservationSchema, FinancialPolicyReaderScopeSchema, FinancialPolicyContextQuerySchema,
  FinancialPolicyContextSchema, FinancialGovernanceIndexQuerySchema, FinancialGovernanceIndexSchema,
  FinancialPolicyOriginalQuerySchema, FinancialPolicyOriginalSchema, FinancialPolicyProposerObservationSchema,
  type FinancialPolicyReaders, type FinancialPolicyReaderScope, type FinancialPolicyReadObservation,
  type FinancialPolicyContextQuery, type FinancialGovernanceIndexQuery, type FinancialPolicyOriginalQuery } from './financial-policy-read-schema.js';

function capturedPool(pool: Pool): Pool {
  const connect = pool.connect.bind(pool);
  return { connect: async () => { const client = await connect(); return { query: client.query.bind(client), release: client.release.bind(client) } as PoolClient; } } as Pool;
}
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
async function checkedRecord(value: FinancialPolicyRead['record']) {
  if (value.kind === 'document' && value.contentHash !== await financialPolicyTextHash(value.text)) throw financialPolicyOutcomeUnknown();
  return financialPolicyRecordRef(value);
}
async function checkedResult(raw: unknown, command?: FinancialPolicyCommand): Promise<FinancialPolicyResult> {
  const parsed = FinancialPolicyResultSchema.safeParse(raw); if (!parsed.success) throw financialPolicyOutcomeUnknown();
  const r = parsed.data, b = r.body;
  const kinds = { save_document: 'document', save_draft: 'draft', withdraw_draft: 'draft', propose_governance: 'governance', accept_governance: 'governance', reject_governance: 'governance' };
  if (!equal(r.target, await checkedRecord(b)) || b.environment !== r.environment || b.organizationId !== r.organizationId || b.responsibilityId !== r.responsibilityId ||
    b.actor.actorId !== r.actorId || b.operationId !== r.id || kinds[r.kind] !== b.kind ||
    b.kind === 'draft' && b.state !== (r.kind === 'withdraw_draft' ? 'WITHDRAWN' : 'DRAFT') ||
    b.kind === 'governance' && b.state !== (r.kind === 'accept_governance' ? 'ACCEPTED' : r.kind === 'reject_governance' ? 'REJECTED' : 'OPEN')) throw financialPolicyOutcomeUnknown();
  if (command && (command.environment !== r.environment || command.organizationId !== r.organizationId || command.responsibilityId !== r.responsibilityId ||
    command.id !== b.id || command.kind !== r.kind || command.key !== r.key || command.organizationEpoch !== b.organizationEpoch ||
    !equal(command.previous, b.predecessor) || r.commandHash !== await financialPolicyCommandHash(r.actorId, command) ||
    command.kind === 'save_document' && (b.kind !== 'document' || b.text !== command.text || b.purpose !== command.purpose) ||
    command.kind === 'save_draft' && (b.kind !== 'draft' || !equal(b.draft, command.draft)) ||
    command.kind === 'propose_governance' && (b.kind !== 'governance' || !equal(b.bundle, command.bundle) || !equal(b.expectedControl, command.expectedControl) || b.expiresAt !== command.expiresAt) ||
    command.kind === 'accept_governance' && (b.kind !== 'governance' || b.decisionNonce !== command.nonce || b.decision?.mfaEvidence?.id !== command.mfaEvidenceId ||
      b.decision.proposerObservation.id !== command.proposerEvidenceId || !equal(b.expectedControl, command.expectedControl)) ||
    command.kind === 'reject_governance' && (b.kind !== 'governance' || b.decision?.proposerObservation.id !== command.proposerEvidenceId || !equal(b.expectedControl, command.expectedControl)))) throw financialPolicyOutcomeUnknown();
  return r;
}
async function checkedRead(raw: unknown, query: FinancialPolicyReadQuery): Promise<FinancialPolicyRead> {
  const parsed = FinancialPolicyReadSchema.safeParse(raw); if (!parsed.success) throw financialPolicyOutcomeUnknown();
  const value = parsed.data, r = value.record;
  if (r.environment !== query.environment || r.organizationId !== query.organizationId || r.responsibilityId !== query.responsibilityId || r.id !== query.id ||
    query.version !== null && r.version !== query.version || !equal(value.reference, await checkedRecord(r)) ||
    r.kind === 'draft' && (!value.blockers.includes('TRUST_UNAVAILABLE') || !value.blockers.includes('FINANCIAL_AUTHORITY_UNAVAILABLE'))) throw financialPolicyOutcomeUnknown();
  return value;
}
/** Paired private capabilities only. This class never obtains credentials or authenticates a public caller. */
export class PostgresFinancialPolicyReaders implements FinancialPolicyReaders {
  private readonly authorizer: Pool;
  private readonly verifier: Pool;
  constructor(authorizer: Pool, verifier: Pool) { this.authorizer = capturedPool(authorizer); this.verifier = capturedPool(verifier); }
  async resolveObserver(environment: Parameters<FinancialPolicyReaders['resolveObserver']>[0], input: FinancialPolicyReadObservation) {
    const e = EnvironmentSchema.parse(environment), observation = FinancialPolicyReadObservationSchema.parse(input);
    return financialPolicyTransaction(this.verifier, 'verifier', async c => {
      const parsed = FinancialPolicyReaderScopeSchema.safeParse(financialPolicyOne((await c.query('SELECT pactwoven.financial_policy_resolve_observer($1,$2::jsonb) AS response', [e, JSON.stringify(observation)])).rows));
      if (!parsed.success) throw financialPolicyOutcomeUnknown(); const s = parsed.data, i = observation.identity;
      if (s.environment !== e || s.externalOrganizationId !== i.externalOrganizationId || s.actor.subject !== i.subject ||
        s.actor.externalMembershipId !== i.externalMembershipId || s.actor.sessionId !== i.sessionId || !s.roles.some(r => ['owner','finance','operations'].includes(r))) throw financialPolicyOutcomeUnknown();
      return s;
    });
  }
  async context(identityEvidenceId: string, scopeInput: FinancialPolicyReaderScope, input: FinancialPolicyContextQuery) {
    const id = FinancialPolicyUuidSchema.parse(identityEvidenceId), s = FinancialPolicyReaderScopeSchema.parse(scopeInput), q = FinancialPolicyContextQuerySchema.parse(input);
    return financialPolicyTransaction(this.authorizer, 'authorizer', async c => {
      const parsed = FinancialPolicyContextSchema.safeParse(financialPolicyOne((await c.query('SELECT pactwoven.financial_policy_read_context($1,$2::jsonb,$3::jsonb) AS response', [id, JSON.stringify(s), JSON.stringify(q)])).rows));
      if (!parsed.success) throw financialPolicyOutcomeUnknown(); const r = parsed.data;
      if (!equal(r.scope,s) || r.responsibilityId !== q.responsibilityId || (r.draftScope === null) !== (q.responsibilityId === null) ||
        r.observedAt >= r.expiresAt || Date.parse(r.expiresAt) > Date.parse(r.observedAt) + 20_000 ||
        !r.blockers.includes('TRUST_UNAVAILABLE') || !r.blockers.includes('FINANCIAL_AUTHORITY_UNAVAILABLE')) throw financialPolicyOutcomeUnknown();
      if (r.draftScope && (r.draftScope.authority.environment !== s.environment || r.draftScope.authority.organizationId !== s.organizationId ||
        r.draftScope.authority.responsibility.id !== q.responsibilityId || r.draftScope.site.id !== r.draftScope.authority.responsibility.siteId ||
        r.draftScope.authorityHash !== await commandDigest({namespace:'pactwoven:financial-authority-fence:v1',record:r.draftScope.authority}))) throw financialPolicyOutcomeUnknown();
      if (r.asset) {
        const a=r.asset;
        if(a.pin.key!==q.assetKey || a.pin.key!==await physicalAssetKey({genesis:encodeSolanaBase58(provenanceBytes(a.genesisHex)),tokenProgram:encodeSolanaBase58(provenanceBytes(a.tokenProgramHex)),mint:encodeSolanaBase58(provenanceBytes(a.mintHex))}) ||
          !r.control || r.control.budgetAccountId!==await financialBudgetAccountId(s.environment,s.organizationId,a.pin.key)) throw financialPolicyOutcomeUnknown();
      } else if(r.control!==null || r.acceptedConfiguration!==null || r.periods.length!==0 || !r.blockers.includes(q.assetKey===null?'ASSET_MISSING':'ASSET_CHANGED')) throw financialPolicyOutcomeUnknown();
      const full=s.roles.some(role=>role==='owner'||role==='finance');
      if(r.configurationVisibility!==(full?'full':'references_only')||!full&&(q.responsibilityId===null||r.acceptedConfiguration!==null||r.periods.length!==0||
          r.documents.some(d=>d.record.kind!=='document'||d.record.purpose!=='financial_mandate'))||
        full&&r.control&&(r.control.accepted===null)!==(r.acceptedConfiguration===null))throw financialPolicyOutcomeUnknown();
      if(r.acceptedConfiguration){const a=r.acceptedConfiguration,b=a.record;
        await checkedRead(a,{environment:s.environment,organizationId:s.organizationId,responsibilityId:null,id:r.control!.accepted!.id,version:r.control!.accepted!.version});
        if(b.kind!=='governance'||b.state!=='ACCEPTED'||!equal(a.reference,r.control!.accepted)||b.bundle.budgetAccountId!==r.control!.budgetAccountId||b.bundle.asset.key!==q.assetKey)throw financialPolicyOutcomeUnknown();
      }
      if((r.control?.accepted==null)!==r.blockers.includes('GOVERNANCE_MISSING'))throw financialPolicyOutcomeUnknown();
      for(const [i,p] of r.periods.entries())if(p.id!==await financialBudgetPeriodId(r.control!.budgetAccountId,p.startsAt,p.endsAt)||i>0&&r.periods[i-1]!.endsAt>p.startsAt)throw financialPolicyOutcomeUnknown();
      if(r.documents.length!==q.documents.length)throw financialPolicyOutcomeUnknown();
      for(const [i,d] of r.documents.entries()){const ref=q.documents[i]!;
        await checkedRead(d,{environment:s.environment,organizationId:s.organizationId,responsibilityId:ref.purpose==='financial_mandate'?q.responsibilityId:null,id:ref.id,version:ref.version});
        if(d.record.kind!=='document'||d.record.purpose!==ref.purpose||!equal(d.reference,{id:ref.id,version:ref.version,recordHash:ref.recordHash}))throw financialPolicyOutcomeUnknown();
      }
      return r;
    });
  }
  async governance(identityEvidenceId:string,scopeInput:FinancialPolicyReaderScope,input:FinancialGovernanceIndexQuery){
    const id=FinancialPolicyUuidSchema.parse(identityEvidenceId),s=FinancialPolicyReaderScopeSchema.parse(scopeInput),q=FinancialGovernanceIndexQuerySchema.parse(input);
    return financialPolicyTransaction(this.authorizer,'authorizer',async c=>{
      const parsed=FinancialGovernanceIndexSchema.safeParse(financialPolicyOne((await c.query('SELECT pactwoven.financial_policy_governance_index($1,$2::jsonb,$3::jsonb) AS response',[id,JSON.stringify(s),JSON.stringify(q)])).rows));
      if(!parsed.success)throw financialPolicyOutcomeUnknown();const r=parsed.data;
      if(r.items.length>q.limit||r.nextId!==null&&(r.items.length!==q.limit||r.nextId!==r.items.at(-1)!.policy.record.id))throw financialPolicyOutcomeUnknown();
      for(const [i,item]of r.items.entries()){const p=item.policy,b=p.record;
        if(b.kind!=='governance'||i>0&&r.items[i-1]!.policy.record.id>=b.id||i===0&&q.afterId!==null&&q.afterId>=b.id||
          item.control.budgetAccountId!==b.bundle.budgetAccountId||item.currentBudgetConfiguration!==equal(item.control.accepted,p.reference)||item.currentBudgetConfiguration&&b.state!=='ACCEPTED')throw financialPolicyOutcomeUnknown();
        if(b.state==='OPEN'&&!equal(b.expectedControl,item.control)&&(p.state!=='SUPERSEDED'||p.current))throw financialPolicyOutcomeUnknown();
        await checkedRead(p,{environment:s.environment,organizationId:s.organizationId,responsibilityId:null,id:b.id,version:null});
      }return r;
    });
  }
  async original(identityEvidenceId:string,scopeInput:FinancialPolicyReaderScope,input:FinancialPolicyOriginalQuery){
    const id=FinancialPolicyUuidSchema.parse(identityEvidenceId),s=FinancialPolicyReaderScopeSchema.parse(scopeInput),q=FinancialPolicyOriginalQuerySchema.parse(input);
    return financialPolicyTransaction(this.authorizer,'authorizer',async c=>{
      const raw=financialPolicyOne((await c.query('SELECT pactwoven.financial_policy_original_read($1,$2::jsonb,$3::jsonb) AS response',[id,JSON.stringify(s),JSON.stringify(q)])).rows);if(raw===null)return null;
      const parsed=FinancialPolicyOriginalSchema.safeParse(raw);if(!parsed.success)throw financialPolicyOutcomeUnknown();const value=parsed.data,r=await checkedResult(value.result,value.command),a=r.body.actor;
      if(r.environment!==s.environment||r.organizationId!==s.organizationId||r.responsibilityId!==q.responsibilityId||r.kind!==q.kind||r.key!==q.key||r.body.id!==q.targetId||
        a.actorId!==s.actor.actorId||a.subject!==s.actor.subject||a.externalMembershipId!==s.actor.externalMembershipId)throw financialPolicyOutcomeUnknown();
      return value;
    });
  }
  async proposerObservation(identityEvidenceId:string,scopeInput:FinancialPolicyReaderScope,proposal:Parameters<FinancialPolicyReaders['proposerObservation']>[2]){
    const id=FinancialPolicyUuidSchema.parse(identityEvidenceId),s=FinancialPolicyReaderScopeSchema.parse(scopeInput),q=FinancialPolicyRefSchema.parse(proposal);
    return financialPolicyTransaction(this.authorizer,'authorizer',async c=>{
      const raw=financialPolicyOne((await c.query('SELECT pactwoven.financial_policy_proposer_observation($1,$2::jsonb,$3::jsonb) AS response',[id,JSON.stringify(s),JSON.stringify(q)])).rows);if(raw===null)return null;
      const parsed=FinancialPolicyProposerObservationSchema.safeParse(raw);if(!parsed.success)throw financialPolicyOutcomeUnknown();const r=parsed.data;
      if(!equal(r.proposal,q)||r.observation.version!==1||r.observedAt>=r.expiresAt||Date.parse(r.expiresAt)>Date.parse(r.observedAt)+20_000)throw financialPolicyOutcomeUnknown();return r;
    });
  }
}
