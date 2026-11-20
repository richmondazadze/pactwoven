import { Pool } from 'pg';
import { DomainError } from '@pactwoven/domain';

/** This private credential trusts its service code. RLS does not authenticate arbitrary SQL or stop a stolen writer credential impersonating service context. */
export async function assertMandatePool(pool: Pool): Promise<void> {
  const client = await pool.connect();
  let failed = false;
  try {
  await client.query('BEGIN');
  // Fixed catalog lookup also prevents attacker-controlled operator resolution via a login search_path.
  await client.query('SET LOCAL search_path=pg_catalog');
  const result = await client.query<{ valid: boolean }>(`
    WITH RECURSIVE reachable(oid) AS (
      SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname IN (CURRENT_USER, SESSION_USER)
      UNION SELECT m.roleid FROM pg_catalog.pg_auth_members m JOIN reachable r ON r.oid=m.member
    ), relations AS (
      SELECT c.oid,c.relname,c.relowner,c.relkind,c.relrowsecurity FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='pactwoven' AND c.relkind IN ('r','p','v','m','f')
    ), expected(name,insertable) AS (VALUES
      ('mandate_responsibility_versions',false),('mandate_policy_documents',true),('mandate_proposals',true),('mandate_decisions',true),
      ('mandate_versions',true),('mandate_heads',true),('mandate_operations',true),('mandate_audit',true),('mandate_outbox',true)
    ), routines AS (
      SELECT p.oid,p.proname,p.proowner FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='pactwoven'
    ) SELECT (CURRENT_USER=SESSION_USER
      AND EXISTS(SELECT 1 FROM reachable r JOIN pg_catalog.pg_roles p ON p.oid=r.oid WHERE p.rolname='pactwoven_mandate_writer')
      AND NOT EXISTS(SELECT 1 FROM reachable r JOIN pg_catalog.pg_roles p ON p.oid=r.oid
        WHERE p.rolsuper OR p.rolbypassrls OR p.rolcreaterole OR p.rolcreatedb OR p.rolreplication OR p.rolname IN ('pactwoven_runtime','pactwoven_provisioner','pactwoven_access_provisioner'))
      AND NOT EXISTS(SELECT 1 FROM reachable r JOIN pg_catalog.pg_namespace n ON n.nspowner=r.oid WHERE n.nspname='pactwoven')
      AND NOT EXISTS(SELECT 1 FROM reachable r WHERE pg_catalog.has_schema_privilege(r.oid,'pactwoven','CREATE'))
      AND NOT EXISTS(SELECT 1 FROM relations t JOIN reachable r ON r.oid=t.relowner)
      AND NOT EXISTS(SELECT 1 FROM routines f JOIN reachable r ON r.oid=f.proowner)
      AND NOT EXISTS(SELECT 1 FROM expected e LEFT JOIN relations t ON t.relname=e.name
        WHERE t.oid IS NULL OR t.relkind<>'r' OR NOT t.relrowsecurity OR NOT pg_catalog.has_table_privilege(CURRENT_USER,t.oid,'SELECT')
          OR(e.insertable AND NOT pg_catalog.has_table_privilege(CURRENT_USER,t.oid,'INSERT')))
      AND pg_catalog.has_column_privilege(CURRENT_USER,'pactwoven.mandate_heads','body','UPDATE')
      AND NOT EXISTS(SELECT 1 FROM reachable r CROSS JOIN relations t LEFT JOIN expected e ON e.name=t.relname WHERE
        (e.name IS NULL AND (pg_catalog.has_table_privilege(r.oid,t.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
          OR pg_catalog.has_any_column_privilege(r.oid,t.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
        OR(e.name IS NOT NULL AND (pg_catalog.has_table_privilege(r.oid,t.oid,'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
          OR pg_catalog.has_any_column_privilege(r.oid,t.oid,'REFERENCES')
          OR(e.insertable=false AND (pg_catalog.has_table_privilege(r.oid,t.oid,'INSERT') OR pg_catalog.has_any_column_privilege(r.oid,t.oid,'INSERT')))
          OR EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid=t.oid AND a.attnum>0 AND NOT a.attisdropped
            AND NOT(t.relname='mandate_heads' AND a.attname='body') AND pg_catalog.has_column_privilege(r.oid,t.oid,a.attnum,'UPDATE')))))
      AND NOT EXISTS(SELECT 1 FROM reachable r CROSS JOIN routines f WHERE f.oid NOT IN (
          pg_catalog.to_regprocedure('pactwoven.mandate_can_read(text,text,text,text)'),
          pg_catalog.to_regprocedure('pactwoven.mandate_resolve_context(text,jsonb,text,boolean,text)'),
          pg_catalog.to_regprocedure('pactwoven.mandate_advise_only(jsonb,text)'))
        AND pg_catalog.has_function_privilege(r.oid,f.oid,'EXECUTE'))
      AND pg_catalog.has_function_privilege(CURRENT_USER,'pactwoven.mandate_resolve_context(text,jsonb,text,boolean,text)','EXECUTE')
      AND pg_catalog.has_function_privilege(CURRENT_USER,'pactwoven.mandate_can_read(text,text,text,text)','EXECUTE')
      AND pg_catalog.has_function_privilege(CURRENT_USER,'pactwoven.mandate_advise_only(jsonb,text)','EXECUTE')) AS valid
  `);
  if (result.rows.length !== 1 || result.rows[0]?.valid !== true) {
    throw new DomainError('UNSAFE_DATABASE_ROLE', 503, 'Mandates require a dedicated private writer with exactly bounded storage privileges.');
  }
  await client.query('COMMIT');
  } catch (error) {
    failed = true;
    try { await client.query('ROLLBACK'); } catch { /* Discard this connection. */ }
    if (error instanceof DomainError) throw error;
    throw new DomainError('UNSAFE_DATABASE_ROLE', 503, 'The isolated mandate database privileges could not be verified.');
  } finally { client.release(failed); }
}
export async function createMandatePool(connectionString: string): Promise<Pool> {
  const pool = new Pool({ connectionString, max: 3, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 30_000, statement_timeout: 5_000 });
  pool.on('error', () => { console.error('A private mandate connection became unavailable.'); });
  try { await assertMandatePool(pool); return pool; } catch (error) { await pool.end(); throw error; }
}
