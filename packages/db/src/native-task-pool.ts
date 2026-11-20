import { Pool } from 'pg';
import { EnvironmentSchema, type Environment } from '@pactwoven/contracts';
import { DomainError } from '@pactwoven/domain';

export type NativeTaskPoolPurpose = 'api' | 'worker' | 'dispatcher';
const signatures = {
  api: ['pactwoven.native_task_binding(text,text)', 'pactwoven.native_task_read(jsonb,text,integer)',
    'pactwoven.native_task_create(jsonb,text,jsonb)', 'pactwoven.native_task_command(jsonb,text,text,text,jsonb)'],
  worker: ['pactwoven.native_task_binding(text,text)', 'pactwoven.native_task_claim(text,text,integer)',
    'pactwoven.native_task_lease(text,text,text,uuid,text,integer,jsonb)'],
  dispatcher: ['pactwoven.native_task_binding(text,text)', 'pactwoven.native_dispatch_claim_publications(text,text,integer,integer)',
    'pactwoven.native_dispatch_publication(text,text,text,bigint,uuid,boolean,integer)', 'pactwoven.native_dispatch_recover(text,integer)'],
} as const;
const dispatchWorkerSignatures = ['pactwoven.native_dispatch_claim_target(text,jsonb,text,integer)',
  'pactwoven.native_dispatch_yield(text,jsonb,uuid,jsonb,integer)'];

/** Dedicated login credentials trust the API/worker service, never model-generated SQL. */
export async function assertNativeTaskPool(pool: Pool, environment: Environment, purpose: NativeTaskPoolPurpose): Promise<void> {
  EnvironmentSchema.parse(environment);
  if (!['api', 'worker', 'dispatcher'].includes(purpose)) throw new DomainError('UNSAFE_DATABASE_ROLE', 503, 'The native task service role is invalid.');
  const client = await pool.connect();
  let failed = false;
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL search_path=pg_catalog');
    // Preserve 0021 local fixtures while requiring the complete reviewed set
    // when 0022 is installed. Unknown extra grants still fail the check below.
    const expectedSignatures: string[] = [...signatures[purpose]];
    const authority = await client.query<{ prepare: boolean; finish: boolean }>(`SELECT
      to_regprocedure('pactwoven.native_provider_authority_prepare(text,jsonb,text)') IS NOT NULL AS prepare,
      to_regprocedure('pactwoven.native_provider_authority_finish(text,uuid,jsonb)') IS NOT NULL AS finish`);
    if (authority.rows[0]?.prepare !== authority.rows[0]?.finish ||
        (environment !== 'simulation' && !authority.rows[0]?.prepare)) {
      throw new DomainError('UNSAFE_DATABASE_ROLE', 503, 'Current provider authority storage is required.');
    }
    if (purpose === 'api') {
      const search = await client.query<{ installed: boolean }>("SELECT to_regprocedure('pactwoven.native_task_search(jsonb,jsonb)') IS NOT NULL AS installed");
      if (search.rows[0]?.installed) expectedSignatures.push('pactwoven.native_task_search(jsonb,jsonb)');
      if (authority.rows[0]?.prepare) expectedSignatures.push('pactwoven.native_provider_authority_prepare(text,jsonb,text)',
        'pactwoven.native_provider_authority_finish(text,uuid,jsonb)');
    }
    if (purpose === 'worker') {
      const dispatch = await client.query<{ installed: boolean }>("SELECT to_regprocedure('pactwoven.native_dispatch_claim_target(text,jsonb,text,integer)') IS NOT NULL AS installed");
      if (dispatch.rows[0]?.installed) expectedSignatures.push(...dispatchWorkerSignatures);
    }
    const result = await client.query<{ safe: boolean }>(`
      WITH RECURSIVE reachable(oid) AS (
        SELECT oid FROM pg_catalog.pg_roles WHERE rolname IN (CURRENT_USER,SESSION_USER)
        UNION SELECT m.roleid FROM pg_catalog.pg_auth_members m JOIN reachable r ON r.oid=m.member
      ), relations AS (
        SELECT c.oid,c.relowner FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='pactwoven' AND c.relkind IN ('r','p','v','m','f')
      ), routines AS (
        SELECT p.oid,p.proowner,p.prosecdef,p.proconfig FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='pactwoven'
      ), expected AS (SELECT pg_catalog.to_regprocedure(s) AS oid FROM pg_catalog.unnest($3::text[]) s)
      SELECT CURRENT_USER=SESSION_USER
        AND pactwoven.native_task_binding($1,$2)
        AND NOT EXISTS(SELECT 1 FROM reachable x JOIN pg_catalog.pg_roles r ON r.oid=x.oid WHERE r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication)
        AND NOT EXISTS(SELECT 1 FROM reachable r JOIN pg_catalog.pg_namespace n ON n.nspowner=r.oid WHERE n.nspname='pactwoven')
        AND NOT EXISTS(SELECT 1 FROM reachable r WHERE pg_catalog.has_schema_privilege(r.oid,'pactwoven','CREATE'))
        AND NOT EXISTS(SELECT 1 FROM reachable r CROSS JOIN relations t WHERE r.oid=t.relowner
          OR pg_catalog.has_table_privilege(r.oid,t.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
          OR pg_catalog.has_any_column_privilege(r.oid,t.oid,'SELECT,INSERT,UPDATE,REFERENCES'))
        AND NOT EXISTS(SELECT 1 FROM reachable r CROSS JOIN routines f WHERE r.oid=f.proowner
          OR (pg_catalog.has_function_privilege(r.oid,f.oid,'EXECUTE') AND NOT EXISTS(SELECT 1 FROM expected e WHERE e.oid=f.oid)))
        AND NOT EXISTS(SELECT 1 FROM expected e LEFT JOIN routines f ON f.oid=e.oid WHERE f.oid IS NULL
          OR NOT f.prosecdef OR NOT ('search_path=pg_catalog'=ANY(coalesce(f.proconfig,'{}'::text[])))
          OR NOT pg_catalog.has_function_privilege(CURRENT_USER,f.oid,'EXECUTE')) AS safe
    `, [environment, purpose, expectedSignatures]);
    if (result.rows.length !== 1 || result.rows[0]?.safe !== true) {
      throw new DomainError('UNSAFE_DATABASE_ROLE', 503, 'Native tasks require an enrolled, isolated service role.');
    }
    const committed = await client.query('COMMIT');
    if (committed.command !== 'COMMIT') throw new DomainError('UNSAFE_DATABASE_ROLE', 503, 'Native task isolation could not be verified.');
  } catch (error) {
    failed = true;
    try { await client.query('ROLLBACK'); } catch { /* Failed connections are discarded. */ }
    if (error instanceof DomainError) throw error;
    throw new DomainError('UNSAFE_DATABASE_ROLE', 503, 'Native task isolation could not be verified.');
  } finally { client.release(failed); }
}

export async function createNativeTaskPool(connectionString: string, environment: Environment, purpose: NativeTaskPoolPurpose): Promise<Pool> {
  const pool = new Pool({ connectionString, max: purpose === 'worker' ? 3 : 5,
    connectionTimeoutMillis: 5_000, idleTimeoutMillis: 30_000, statement_timeout: 5_000 });
  pool.on('error', () => { console.error('A native task database connection became unavailable.'); });
  try { await assertNativeTaskPool(pool, environment, purpose); return pool; }
  catch (error) { await pool.end(); throw error; }
}
