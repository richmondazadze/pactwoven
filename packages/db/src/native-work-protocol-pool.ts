import { Pool } from 'pg';
import { EnvironmentSchema, type Environment } from '../../contracts/src/core';
import { DomainError } from '../../domain/src/errors';
import { assertNativeDelegationPool } from './native-delegation-pool';

/** Admit one complete known API profile during the atomic P3 schema rollout. */
export async function createNativeWorkProtocolPool(connectionString: string, environment: Environment): Promise<{ pool: Pool; instructions: boolean; activity: boolean; execution: boolean }> {
  EnvironmentSchema.parse(environment);
  const pool = new Pool({ connectionString, max: 3, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000, statement_timeout: 5000 });
  pool.on('error', () => { console.error('A work database connection became unavailable.'); });
  try {
    const result = await pool.query<{ conversation: boolean; instructions: boolean; activity: boolean; execution: boolean }>(
      "SELECT pg_catalog.to_regprocedure('pactwoven.native_work_conversation_read(jsonb,text,text)') IS NOT NULL AS conversation, pg_catalog.to_regprocedure('pactwoven.native_delegation_root_work_v3(text,jsonb)') IS NOT NULL AS instructions, pg_catalog.to_regprocedure('pactwoven.native_work_activity_read(jsonb,text,text)') IS NOT NULL AS activity, COALESCE(pg_catalog.has_function_privilege(CURRENT_USER,pg_catalog.to_regprocedure('pactwoven.native_work_execution_read(jsonb,text,text)'),'EXECUTE'),false) AS execution");
    if (result.rows.length !== 1 || typeof result.rows[0]?.conversation !== 'boolean' || typeof result.rows[0]?.instructions !== 'boolean' ||
      typeof result.rows[0]?.activity !== 'boolean' || typeof result.rows[0]?.execution !== 'boolean' || result.rows[0].execution && !result.rows[0].activity || result.rows[0].activity && !result.rows[0].instructions ||
      result.rows[0].conversation !== result.rows[0].instructions) throw Error('Incomplete work protocol.');
    const instructions = result.rows[0].instructions;
    const activity = result.rows[0].activity;
    await assertNativeDelegationPool(pool, environment, 'api', activity ? 'delegation-workspace-activity' : instructions ? 'delegation-workspace-instructions' : 'delegation-workspace');
    return { pool, instructions, activity, execution: result.rows[0].execution };
  } catch (error) {
    await pool.end().catch(() => undefined);
    if (error instanceof DomainError) throw error;
    throw new DomainError('UNSAFE_DATABASE_ROLE', 503, 'The work protocol could not be verified.');
  }
}
