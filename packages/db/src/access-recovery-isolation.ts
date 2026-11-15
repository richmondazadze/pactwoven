import type { Pool } from 'pg';
import { DomainError } from '@pactwoven/domain';

type RecoveryRole = 'runtime' | 'bootstrap' | 'access';
type RecoveryCapabilities = { isolated: boolean; ready: boolean; isolationSupported: boolean };
async function inspect(pool: Pool, role: RecoveryRole): Promise<RecoveryCapabilities> {
  try {
    const result = await pool.query<RecoveryCapabilities>(`
      WITH RECURSIVE reachable(oid) AS (
        SELECT oid FROM pg_catalog.pg_roles WHERE rolname OPERATOR(pg_catalog.=) ANY(ARRAY[CURRENT_USER,SESSION_USER])
        UNION SELECT m.roleid FROM pg_catalog.pg_auth_members m JOIN reachable r ON r.oid OPERATOR(pg_catalog.=) m.member
      ), tables AS (
        SELECT c.oid,c.relowner,c.relkind,c.relrowsecurity FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid OPERATOR(pg_catalog.=) c.relnamespace
        WHERE n.nspname OPERATOR(pg_catalog.=) 'pactwoven' AND c.relname OPERATOR(pg_catalog.=) 'member_access_key_fences'
      ), functions AS (
        SELECT p.oid,p.proowner FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid OPERATOR(pg_catalog.=) p.pronamespace
        WHERE n.nspname OPERATOR(pg_catalog.=) 'pactwoven' AND p.proname OPERATOR(pg_catalog.~) '(^access_recovery_|^(read|close)_access_recovery$)'
      ), exported(oid) AS (VALUES
        (pg_catalog.to_regprocedure('pactwoven.read_access_recovery(pg_catalog.text,pg_catalog.jsonb,pg_catalog.text,pg_catalog.text)')),
        (pg_catalog.to_regprocedure('pactwoven.close_access_recovery(pg_catalog.text,pg_catalog.jsonb,pg_catalog.jsonb,pg_catalog.text,pg_catalog.jsonb,pg_catalog.text)'))
      ) SELECT (
        EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname OPERATOR(pg_catalog.=) CURRENT_USER)
        AND EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname OPERATOR(pg_catalog.=) SESSION_USER)
        AND NOT EXISTS(SELECT 1 FROM reachable r CROSS JOIN tables t WHERE r.oid OPERATOR(pg_catalog.=) t.relowner
          OR pg_catalog.has_table_privilege(r.oid,t.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
          OR pg_catalog.has_any_column_privilege(r.oid,t.oid,'SELECT,INSERT,UPDATE,REFERENCES'))
        AND NOT EXISTS(SELECT 1 FROM reachable r CROSS JOIN functions f WHERE r.oid OPERATOR(pg_catalog.=) f.proowner OR
          (pg_catalog.has_function_privilege(r.oid,f.oid,'EXECUTE') AND NOT($1::pg_catalog.text OPERATOR(pg_catalog.=) 'access' AND f.oid OPERATOR(pg_catalog.=) ANY(SELECT oid FROM exported WHERE oid IS NOT NULL))))
      ) AS isolated, (
        CURRENT_USER OPERATOR(pg_catalog.=) SESSION_USER
        AND EXISTS(SELECT 1 FROM reachable r JOIN pg_catalog.pg_roles p ON p.oid OPERATOR(pg_catalog.=) r.oid WHERE p.rolname OPERATOR(pg_catalog.=) 'pactwoven_access_provisioner')
        AND NOT EXISTS(SELECT 1 FROM reachable r JOIN pg_catalog.pg_roles p ON p.oid OPERATOR(pg_catalog.=) r.oid WHERE p.rolsuper OR p.rolbypassrls OR p.rolcreatedb OR p.rolcreaterole OR p.rolreplication
          OR p.rolname OPERATOR(pg_catalog.=) ANY(ARRAY['pactwoven_runtime','pactwoven_provisioner','pactwoven_mandate_writer']::pg_catalog.name[]))
        AND NOT EXISTS(SELECT 1 FROM reachable r WHERE pg_catalog.has_schema_privilege(r.oid,'pactwoven','CREATE'))
        AND EXISTS(SELECT 1 FROM tables WHERE relkind OPERATOR(pg_catalog.=) 'r' AND relrowsecurity)
        AND NOT EXISTS(SELECT 1 FROM exported e LEFT JOIN pg_catalog.pg_proc p ON p.oid OPERATOR(pg_catalog.=) e.oid WHERE e.oid IS NULL OR NOT p.prosecdef
          OR NOT(coalesce(p.proconfig,ARRAY[]::pg_catalog.text[]) OPERATOR(pg_catalog.@>) ARRAY['search_path=pg_catalog']) OR NOT pg_catalog.has_function_privilege(CURRENT_USER,e.oid,'EXECUTE'))
        AND EXISTS(SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid OPERATOR(pg_catalog.=) pg_catalog.to_regclass('pactwoven.member_access_key_fences') AND tgname OPERATOR(pg_catalog.=) 'access_recovery_immutable_row'
          AND NOT tgisinternal AND tgenabled OPERATOR(pg_catalog.=) ANY(ARRAY['O','A']::pg_catalog."char"[]) AND tgtype OPERATOR(pg_catalog.=) 27 AND tgfoid OPERATOR(pg_catalog.=) pg_catalog.to_regprocedure('pactwoven.access_recovery_immutable()'))
        AND EXISTS(SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid OPERATOR(pg_catalog.=) pg_catalog.to_regclass('pactwoven.member_access_key_fences') AND tgname OPERATOR(pg_catalog.=) 'access_recovery_immutable_table'
          AND NOT tgisinternal AND tgenabled OPERATOR(pg_catalog.=) ANY(ARRAY['O','A']::pg_catalog."char"[]) AND tgtype OPERATOR(pg_catalog.=) 34 AND tgfoid OPERATOR(pg_catalog.=) pg_catalog.to_regprocedure('pactwoven.access_recovery_immutable()'))
        AND EXISTS(SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid OPERATOR(pg_catalog.=) pg_catalog.to_regclass('pactwoven.member_access_key_fences') AND tgname OPERATOR(pg_catalog.=) 'access_recovery_fence_insert'
          AND NOT tgisinternal AND tgenabled OPERATOR(pg_catalog.=) ANY(ARRAY['O','A']::pg_catalog."char"[]) AND tgtype OPERATOR(pg_catalog.=) 7 AND tgfoid OPERATOR(pg_catalog.=) pg_catalog.to_regprocedure('pactwoven.access_recovery_opposite_insert()'))
        AND EXISTS(SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid OPERATOR(pg_catalog.=) pg_catalog.to_regclass('pactwoven.operations') AND tgname OPERATOR(pg_catalog.=) 'access_recovery_operation_insert'
          AND NOT tgisinternal AND tgenabled OPERATOR(pg_catalog.=) ANY(ARRAY['O','A']::pg_catalog."char"[]) AND tgtype OPERATOR(pg_catalog.=) 7 AND tgqual IS NOT NULL AND tgfoid OPERATOR(pg_catalog.=) pg_catalog.to_regprocedure('pactwoven.access_recovery_opposite_insert()'))
      ) AS ready, (
        $1::pg_catalog.text OPERATOR(pg_catalog.<>) 'access'
        OR (NOT EXISTS(SELECT 1 FROM tables) AND NOT EXISTS(SELECT 1 FROM functions))
        OR (pg_catalog.current_setting('transaction_isolation') OPERATOR(pg_catalog.=) 'read committed'
          AND pg_catalog.current_setting('default_transaction_isolation') OPERATOR(pg_catalog.=) 'read committed')
      ) AS "isolationSupported"`, [role]);
    if (result.rows.length !== 1 || typeof result.rows[0]?.isolated !== 'boolean' || typeof result.rows[0]?.ready !== 'boolean'
      || typeof result.rows[0]?.isolationSupported !== 'boolean') throw new Error('Invalid recovery capability response');
    return result.rows[0];
  } catch {
    throw new DomainError('UNSAFE_DATABASE_ROLE', 503, 'Recovery database capabilities could not be verified.');
  }
}

/** Schema-optional: old access remains usable before the recovery migration exists. */
export async function assertAccessRecoveryIsolation(pool: Pool, role: RecoveryRole): Promise<void> {
  const state = await inspect(pool, role);
  if (!state.isolated) throw new DomainError('UNSAFE_DATABASE_ROLE', 503, 'Database credentials must remain isolated from private recovery records.');
  requireSupportedIsolation(state);
}

function requireSupportedIsolation(state: RecoveryCapabilities): void {
  if (!state.isolationSupported) throw new DomainError('SETUP_REQUIRED', 503, 'Member access requires READ COMMITTED transactions and connection defaults.');
}

/** Compatibility/readiness check only; this does not replace independent migration review. */
export async function assertAccessRecoveryReady(pool: Pool): Promise<void> {
  const state = await inspect(pool, 'access');
  if (!state.isolated) throw new DomainError('UNSAFE_DATABASE_ROLE', 503, 'Private recovery storage privileges must remain bounded.');
  requireSupportedIsolation(state);
  if (!state.ready) throw new DomainError('SETUP_REQUIRED', 503, 'Durable request closure is not configured.');
}
