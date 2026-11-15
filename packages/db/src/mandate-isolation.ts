import type { Pool } from 'pg';
import { DomainError } from '@pactwoven/domain';

/** Legacy credentials must not reach the private mandate writer, even through SET ROLE. */
export async function assertLegacyMandateIsolation(pool: Pool): Promise<void> {
  const result = await pool.query<{ principals_found: boolean; mandate_capable: boolean }>(`
    WITH RECURSIVE reachable_roles(oid) AS (
      SELECT oid FROM pg_catalog.pg_roles WHERE rolname OPERATOR(pg_catalog.=) ANY (ARRAY[current_user, session_user])
      UNION
      SELECT membership.roleid FROM pg_catalog.pg_auth_members membership
        JOIN reachable_roles reachable ON membership.member OPERATOR(pg_catalog.=) reachable.oid
    ), mandate_tables AS (
      SELECT c.oid FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid OPERATOR(pg_catalog.=) c.relnamespace
      WHERE n.nspname OPERATOR(pg_catalog.=) 'pactwoven' AND c.relname OPERATOR(pg_catalog.~) '^mandate_'
        AND c.relkind OPERATOR(pg_catalog.=) ANY (ARRAY['r','p','v','m','f']::pg_catalog."char"[])
    ), mandate_functions AS (
      SELECT p.oid FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid OPERATOR(pg_catalog.=) p.pronamespace
      WHERE n.nspname OPERATOR(pg_catalog.=) 'pactwoven' AND p.proname OPERATOR(pg_catalog.~) '(^mandate_|_mandate_)'
    )
    SELECT (EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname OPERATOR(pg_catalog.=) current_user)
      AND EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname OPERATOR(pg_catalog.=) session_user)) AS principals_found,
      (EXISTS (SELECT 1 FROM reachable_roles reachable JOIN pg_catalog.pg_roles principal ON principal.oid OPERATOR(pg_catalog.=) reachable.oid
        WHERE principal.rolname OPERATOR(pg_catalog.=) 'pactwoven_mandate_writer')
      OR EXISTS (SELECT 1 FROM reachable_roles reachable CROSS JOIN mandate_tables relation
        WHERE pg_catalog.has_table_privilege(reachable.oid, relation.oid,
          'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
          OR pg_catalog.has_any_column_privilege(reachable.oid, relation.oid, 'SELECT,INSERT,UPDATE,REFERENCES'))
      OR EXISTS (SELECT 1 FROM reachable_roles reachable CROSS JOIN mandate_functions routine
        WHERE pg_catalog.has_function_privilege(reachable.oid, routine.oid, 'EXECUTE'))) AS mandate_capable
  `);
  const rows = result?.rows;
  if (!Array.isArray(rows) || rows.length !== 1 || rows[0]?.principals_found !== true || rows[0]?.mandate_capable !== false) {
    throw new DomainError('UNSAFE_DATABASE_ROLE', 503, 'Legacy database credentials must be isolated from private mandate authority.');
  }
}
