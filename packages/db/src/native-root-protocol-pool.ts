import { Pool } from 'pg';
import { EnvironmentSchema, type Environment } from '../../contracts/src/core';
import { DomainError } from '../../domain/src/errors';
import { assertNativeDelegationPool } from './native-delegation-pool';

export type NativeRootProtocol = 'legacy' | 'refresh' | 'instructions';

/** Select one complete, fixed privilege profile from the committed catalog.
 * Discovery is not admission: both profiles still require the full isolation
 * audit. A partial migration or unexpected grant fails without fallback.
 * This permits the compatible executor to be released before the SQL upgrade.
 */
export async function createNativeRootProtocolPool(connectionString: string, environment: Environment,
  purpose: 'coordinator' | 'worker'): Promise<{ pool: Pool; protocol: NativeRootProtocol }> {
  EnvironmentSchema.parse(environment);
  if (purpose !== 'coordinator' && purpose !== 'worker') {
    throw new DomainError('UNSAFE_DATABASE_ROLE', 503, 'The root protocol audience is invalid.');
  }
  const pool = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000, statement_timeout: 5_000 });
  pool.on('error', () => { console.error('A delegated task database connection became unavailable.'); });
  try {
    const result = await pool.query<{ refresh: boolean; instructions: boolean; paid: boolean }>(
      "SELECT pg_catalog.to_regprocedure('pactwoven.native_delegation_root_work_v2(text,jsonb)') IS NOT NULL AS refresh, pg_catalog.to_regprocedure('pactwoven.native_delegation_root_work_v3(text,jsonb)') IS NOT NULL AS instructions, pg_catalog.to_regprocedure('pactwoven.paid_tool_root_policy(jsonb)') IS NOT NULL AS paid");
    if (result.rows.length !== 1 || typeof result.rows[0]?.refresh !== 'boolean' || typeof result.rows[0]?.instructions !== 'boolean' || typeof result.rows[0]?.paid !== 'boolean' || result.rows[0].paid && !result.rows[0].instructions || result.rows[0].instructions && !result.rows[0].refresh) throw Error('Protocol discovery unavailable.');
    const protocol = result.rows[0].instructions ? 'instructions' : result.rows[0].refresh ? 'refresh' : 'legacy';
    await assertNativeDelegationPool(pool, environment, purpose, result.rows[0].paid && purpose === 'coordinator' ? 'delegation-root-paid' : protocol === 'instructions' ? 'delegation-root-instructions' : protocol === 'refresh' ? 'delegation-root-refresh' : 'delegation-root');
    return { pool, protocol };
  } catch (error) {
    await pool.end().catch(() => undefined);
    if (error instanceof DomainError) throw error;
    throw new DomainError('UNSAFE_DATABASE_ROLE', 503, 'The root protocol could not be verified.');
  }
}
