import type { Pool, PoolClient } from 'pg';
import { FINANCE_DEVNET_ASSET, FinancialPolicyUuidSchema, encodeSolanaBase58, type FinancialPolicyRead } from '@pactwoven/contracts';
import { canonicalJson, commandDigest, financialPolicyRecordRef, financialPolicyTextHash, financialBudgetAccountId,
  financialBudgetPeriodId, physicalAssetKey, provenanceBytes } from '@pactwoven/domain';
import { financialPolicyTransaction, financialPolicyOne, financialPolicyOutcomeUnknown } from './financial-policy-repository.js';
import { FinancialPolicyReaderScopeSchema, type FinancialPolicyReaderScope } from './financial-policy-read-schema.js';
import { FinancialPolicyPreparationQuerySchema, FinancialPolicyPreparationSchema,
  type FinancialPolicyPreparationQuery, type FinancialPolicyPreparationReader } from './financial-policy-preparation-schema.js';

const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
async function checkedRecord(value: FinancialPolicyRead) {
  const r = value.record;
  if (r.kind === 'document' && r.contentHash !== await financialPolicyTextHash(r.text) ||
    !equal(value.reference, await financialPolicyRecordRef(r))) throw financialPolicyOutcomeUnknown();
}

/** One function-only authorizer capability. No observer, credential or mutation surface. */
export class PostgresFinancialPolicyPreparationReader implements FinancialPolicyPreparationReader {
  private readonly authorizer: Pool;
  constructor(pool: Pool) {
    const connect = pool.connect.bind(pool);
    this.authorizer = { connect: async () => {
      const client = await connect();
      return { query: client.query.bind(client), release: client.release.bind(client) } as PoolClient;
    } } as Pool;
  }
  async prepare(identityEvidenceId: string, scopeInput: FinancialPolicyReaderScope, input: FinancialPolicyPreparationQuery) {
    const id = FinancialPolicyUuidSchema.parse(identityEvidenceId), scope = FinancialPolicyReaderScopeSchema.parse(scopeInput),
      query = FinancialPolicyPreparationQuerySchema.parse(input);
    const result = await financialPolicyTransaction(this.authorizer, 'authorizer', async client => {
      const raw = financialPolicyOne((await client.query('SELECT pactwoven.financial_policy_prepare($1,$2::jsonb,$3::jsonb) AS response',
        [id, JSON.stringify(scope), JSON.stringify(query)])).rows);
      const parsed = FinancialPolicyPreparationSchema.safeParse(raw);
      if (!parsed.success) throw financialPolicyOutcomeUnknown();
      const v = parsed.data, m = v.material, target = v.target;
      if (!equal(v.scope, scope) || v.responsibilityId !== query.responsibilityId || !equal(v.selection, query.selection) ||
        Date.parse(v.observedAt) > Date.now() || Date.parse(v.expiresAt) <= Date.now()) throw financialPolicyOutcomeUnknown();
      if (target.state === 'exact') {
        await checkedRecord(target.record);
        for (const d of target.historicalDocuments) await checkedRecord(d);
        const r = target.record.record;
        if (r.kind === 'governance' && r.state === 'OPEN' && target.record.current !== equal(r.expectedControl, target.control))
          throw financialPolicyOutcomeUnknown();
      }
      if ((m.action === 'save_document' || m.action === 'save_draft') && m.draftScope &&
        m.draftScope.authorityHash !== await commandDigest({ namespace: 'pactwoven:financial-authority-fence:v1', record: m.draftScope.authority }))
        throw financialPolicyOutcomeUnknown();
      if (m.action === 'save_draft' && m.document) await checkedRecord(m.document);
      if (m.action === 'propose_governance') {
        for (const d of [m.budgetDocument, m.approvalDocument, m.acceptedConfiguration]) if (d) await checkedRecord(d);
        if (m.asset) {
          const a = m.asset, descriptor = { genesis: encodeSolanaBase58(provenanceBytes(a.genesisHex)),
            tokenProgram: encodeSolanaBase58(provenanceBytes(a.tokenProgramHex)), mint: encodeSolanaBase58(provenanceBytes(a.mintHex)) };
          if (descriptor.genesis !== FINANCE_DEVNET_ASSET.genesis || descriptor.tokenProgram !== FINANCE_DEVNET_ASSET.tokenProgram ||
            descriptor.mint !== FINANCE_DEVNET_ASSET.mint || a.decimals !== 6 ||
            a.policy !== 'solana-original-devnet-usdc-v1' || a.pin.key !== await physicalAssetKey(descriptor) ||
            m.budgetAccountId !== await financialBudgetAccountId(scope.environment, scope.organizationId, a.pin.key)) throw financialPolicyOutcomeUnknown();
          for (const period of m.periods) if (period.id !== await financialBudgetPeriodId(m.budgetAccountId!, period.startsAt, period.endsAt))
            throw financialPolicyOutcomeUnknown();
        }
        if (target.state === 'exact' && target.record.record.kind === 'governance' &&
          target.record.record.bundle.budgetAccountId === m.budgetAccountId && !equal(target.control, m.control)) throw financialPolicyOutcomeUnknown();
      }
      return v;
    });
    // A delayed checkout/query/COMMIT may consume the original observation.
    if (Date.parse(result.expiresAt) <= Date.now()) throw financialPolicyOutcomeUnknown();
    return result;
  }
}
