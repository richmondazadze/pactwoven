import type { Pool } from 'pg';
import { DomainError } from '@pactwoven/domain';

/** Retain each factory's privilege checks, then verify the actual origin identity.
 * Hyperdrive's transport username/database cannot establish either fact. */
export async function createWorkerPool(create: () => Promise<Pool>, expectedUser: string): Promise<Pool> {
  const pool = await create();
  try {
    const result = await pool.query(`SELECT
      pg_catalog.current_database() OPERATOR(pg_catalog.=) $1::pg_catalog.name AS database_matches,
      current_user OPERATOR(pg_catalog.=) $2::pg_catalog.name AS current_matches,
      session_user OPERATOR(pg_catalog.=) $2::pg_catalog.name AS session_matches`, ['pactwoven_dev', expectedUser]);
    const row = Array.isArray(result?.rows) && result.rows.length === 1 ? result.rows[0] : undefined;
    if (row?.database_matches !== true || row.current_matches !== true || row.session_matches !== true) throw new Error();
    return pool;
  } catch {
    try { await pool.end(); } catch { /* The failed pool is never exposed to repositories. */ }
    throw new DomainError('UNSAFE_DATABASE_ROLE', 503, 'The development database identity could not be verified.');
  }
}
