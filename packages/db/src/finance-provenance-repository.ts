import type { Pool, PoolClient } from 'pg';
import { FinanceDeliveryReceiptSchema, FinanceProvenanceLookupSchema, FinanceProvenanceResultSchema,
  type FinanceDeliveryReceipt, type FinanceProvenanceAppend, type FinanceProvenanceLookup, type FinanceProvenanceResult } from '@pactwoven/contracts';
import { commandDigest, DomainError, prepareProvenanceAppend } from '@pactwoven/domain';
import { assertFinanceProvenanceConnection } from './finance-provenance-pool.js';
import type { FinanceProvenanceRepository } from './finance-provenance-schema.js';

const unavailable = () => new DomainError('PROVENANCE_OUTCOME_UNKNOWN', 503, 'The provenance receipt was not confirmed. Check the original source/account/delivery key.');
function databaseError(error: unknown): never {
  if (error instanceof DomainError) throw error;
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
  if (code === 'PF001') throw new DomainError('PROVENANCE_SOURCE_DENIED', 403, 'This source login or account binding is not eligible for the requested intake.');
  if (code === 'PF002') throw new DomainError('PROVENANCE_VERSION_CHANGED', 409, 'Registry or source configuration changed. Preserve the original delivery.');
  if (code === 'PF004') throw new DomainError('PROVENANCE_INPUT_INVALID', 422, 'Exact internally consistent provenance evidence is required.');
  throw unavailable();
}
/** No read model, financial state, balance promotion or authority is exposed here. */
export class PostgresFinanceProvenanceRepository implements FinanceProvenanceRepository {
  constructor(private readonly pool: Pool) {}
  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    let client: PoolClient | undefined, discard = false;
    try {
      client = await this.pool.connect();
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await client.query("SET LOCAL search_path=pg_catalog; SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='5s'; SET LOCAL idle_in_transaction_session_timeout='8s'");
      await assertFinanceProvenanceConnection(client);
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      // A failed COMMIT acknowledgment may hide a committed receipt. Never retry automatically.
      discard = true; if (client) { try { await client.query('ROLLBACK'); } catch { /* Outcome remains unknown. */ } }
      return databaseError(error);
    } finally { client?.release(discard); }
  }
  async append(input: FinanceProvenanceAppend): Promise<FinanceProvenanceResult> {
    const value = await prepareProvenanceAppend(input), inputHash = await commandDigest(value);
    return this.transaction(async client => {
      const row = await client.query<{ response: unknown }>('SELECT pactwoven.append_finance_provenance($1::jsonb) AS response', [JSON.stringify(value)]);
      const result = FinanceProvenanceResultSchema.parse(row.rows[0]?.response);
      if (result.sourceId !== value.source.id || result.accountKey !== value.account.key || result.deliveryKey !== value.deliveryKey || result.payloadHash !== value.payloadHash ||
        (result.kind === 'conflict' ? result.attemptHash !== inputHash : result.inputHash !== inputHash || result.sourceVersion !== value.source.version ||
          result.accountVersion !== value.account.version || result.asset.key !== value.asset.key || result.asset.version !== value.asset.version)) throw unavailable();
      return result;
    });
  }
  async get(input: FinanceProvenanceLookup): Promise<FinanceDeliveryReceipt | null> {
    const value = FinanceProvenanceLookupSchema.parse(input);
    return this.transaction(async client => {
      const row = await client.query<{ response: unknown }>('SELECT pactwoven.read_finance_provenance($1,$2,$3) AS response', [value.sourceId, value.accountKey, value.deliveryKey]);
      if (row.rows.length !== 1) throw unavailable();
      if (row.rows[0]?.response === null) return null;
      const result = FinanceDeliveryReceiptSchema.parse(row.rows[0]?.response);
      if (result.sourceId !== value.sourceId || result.accountKey !== value.accountKey || result.deliveryKey !== value.deliveryKey) throw unavailable();
      return result;
    });
  }
}
