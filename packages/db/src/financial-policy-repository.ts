import type { Pool, PoolClient } from 'pg';
import { FinancialPolicyCommandSchema, FinancialPolicyResultSchema, FinancialPolicyLookupSchema, FinancialPolicyReadQuerySchema,
  FinancialPolicyListQuerySchema, FinancialPolicyReadSchema, FinancialPolicyPageSchema, FinancialPolicyUuidSchema,
  type FinancialPolicyCommand, type FinancialPolicyResult, type FinancialPolicyLookup, type FinancialPolicyReadQuery,
  type FinancialPolicyListQuery, type FinancialPolicyRead } from '@pactwoven/contracts';
import { DomainError, canonicalJson, financialPolicyCommandHash, financialPolicyRecordRef, financialPolicyTextHash } from '@pactwoven/domain';
import { assertFinancialAuthorityConnection } from './financial-authority-pool.js';
import type { FinancialAuthorityCapability, FinancialPolicyRepository } from './financial-policy-schema.js';

export const financialPolicyOutcomeUnknown = () => new DomainError('FINANCIAL_POLICY_OUTCOME_UNKNOWN', 503, 'The policy result is unconfirmed. Preserve and recover the exact original request.');
export function financialPolicyDatabaseError(error: unknown): never {
  if (error instanceof DomainError) throw error;
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
  const errors: Record<string, [string, 403 | 409 | 422, string]> = {
    FP001: ['FINANCIAL_POLICY_ACCESS_DENIED', 403, 'Current scoped policy access is required.'],
    FP002: ['FINANCIAL_POLICY_SCOPE_CHANGED', 409, 'The exact policy, configuration or authority scope changed.'],
    FP003: ['FINANCIAL_POLICY_EXPIRED', 409, 'The policy or its proof expired.'],
    FP004: ['FINANCIAL_POLICY_INVALID', 422, 'Exact supported policy records are required.'],
    FP005: ['FINANCIAL_POLICY_KEY_CONFLICT', 409, 'Preserve the original policy request identity.'],
    FP006: ['FINANCIAL_POLICY_UNAVAILABLE', 409, 'The required financial qualification is unavailable.'],
    FP007: ['FINANCIAL_POLICY_SCOPE_CHANGED', 409, 'The exact policy transition could not be recorded.'],
  };
  const known = typeof code === 'string' ? errors[code] : undefined;
  if (known) throw new DomainError(...known);
  throw financialPolicyOutcomeUnknown();
}
export async function financialPolicyTransaction<T>(pool: Pool, capability: FinancialAuthorityCapability, work: (client: PoolClient) => Promise<T>): Promise<T> {
  let client: PoolClient | undefined, committing = false, discard = false;
  try {
    client = await pool.connect();
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await client.query("SET LOCAL search_path=pg_catalog; SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='5s'; SET LOCAL idle_in_transaction_session_timeout='8s'");
    await assertFinancialAuthorityConnection(client, capability);
    const result = await work(client); committing = true;
    await client.query('COMMIT'); return result;
  } catch (error) {
    discard = true;
    if (client) try { await client.query('ROLLBACK'); } catch { /* Never retry an uncertain transition. */ }
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
    if (committing && (typeof code !== 'string' || !['FP001', 'FP002', 'FP003', 'FP004', 'FP005', 'FP006', 'FP007', '23503', '23505', '23514'].includes(code))) throw financialPolicyOutcomeUnknown();
    return financialPolicyDatabaseError(error);
  } finally { client?.release(discard); }
}
export function financialPolicyOne(rows: unknown[]): unknown {
  if (rows.length !== 1 || typeof rows[0] !== 'object' || rows[0] === null || !('response' in rows[0])) throw financialPolicyOutcomeUnknown();
  return rows[0].response;
}
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
export class PostgresFinancialPolicyRepository implements FinancialPolicyRepository {
  private readonly pool: Pool;
  constructor(pool: Pool) { this.pool = capturedPool(pool); }
  async mutate(identityEvidenceId: string, input: FinancialPolicyCommand) {
    const id = FinancialPolicyUuidSchema.parse(identityEvidenceId), command = FinancialPolicyCommandSchema.parse(input);
    return financialPolicyTransaction(this.pool, 'authorizer', async c => checkedResult(financialPolicyOne((await c.query('SELECT pactwoven.financial_policy_command($1,$2::jsonb) AS response', [id, JSON.stringify(command)])).rows), command));
  }
  async readFinancialPolicy(identityEvidenceId: string, input: FinancialPolicyReadQuery) {
    const id = FinancialPolicyUuidSchema.parse(identityEvidenceId), query = FinancialPolicyReadQuerySchema.parse(input);
    return financialPolicyTransaction(this.pool, 'authorizer', async c => { const raw = financialPolicyOne((await c.query('SELECT pactwoven.financial_policy_read($1,$2::jsonb) AS response', [id, JSON.stringify(query)])).rows); return raw === null ? null : checkedRead(raw, query); });
  }
  async listFinancialPolicyDrafts(identityEvidenceId: string, input: FinancialPolicyListQuery) {
    const id = FinancialPolicyUuidSchema.parse(identityEvidenceId), query = FinancialPolicyListQuerySchema.parse(input);
    return financialPolicyTransaction(this.pool, 'authorizer', async c => {
      const parsed = FinancialPolicyPageSchema.safeParse(financialPolicyOne((await c.query('SELECT pactwoven.financial_policy_list($1,$2::jsonb) AS response', [id, JSON.stringify(query)])).rows));
      if (!parsed.success) throw financialPolicyOutcomeUnknown(); const page = parsed.data;
      if (page.items.length > query.limit || page.items.some((v, i) => v.record.kind !== 'draft' || !v.current || (i ? page.items[i - 1]!.record.id >= v.record.id : query.afterId !== null && query.afterId >= v.record.id)) ||
        page.nextId !== null && (page.items.length !== query.limit || page.nextId !== page.items.at(-1)?.record.id)) throw financialPolicyOutcomeUnknown();
      for (const item of page.items) await checkedRead(item, { ...query, id: item.record.id, version: null }); return page;
    });
  }
  async readFinancialPolicyOperation(identityEvidenceId: string, input: FinancialPolicyLookup) {
    const id = FinancialPolicyUuidSchema.parse(identityEvidenceId), query = FinancialPolicyLookupSchema.parse(input);
    return financialPolicyTransaction(this.pool, 'authorizer', async c => {
      const raw = financialPolicyOne((await c.query('SELECT pactwoven.financial_policy_recover($1,$2::jsonb) AS response', [id, JSON.stringify(query)])).rows);
      if (raw === null) return null; const result = await checkedResult(raw);
      if (result.environment !== query.environment || result.organizationId !== query.organizationId || result.responsibilityId !== query.responsibilityId ||
        result.kind !== query.kind || result.key !== query.key || result.commandHash !== query.commandHash) throw financialPolicyOutcomeUnknown(); return result;
    });
  }
}
