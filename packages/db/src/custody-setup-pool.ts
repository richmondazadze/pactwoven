import { Pool, type PoolClient } from 'pg';
import { DomainError } from '@pactwoven/domain';
import {custodySetupRoutines,custodySetupTables,type CustodySetupCapability} from './custody-setup-schema.js';

const unsafe = () => new DomainError('UNSAFE_DATABASE_ROLE', 503, 'Custody setup requires a dedicated scope-bound verifier or writer with function-only privileges.');
/** Check every checked-out connection; pool construction is not a durable capability grant. */
export async function assertCustodySetupConnection(client: PoolClient, capability: CustodySetupCapability): Promise<void> {
  try {
    const result = await client.query<{ safe: boolean }>(`
      WITH RECURSIVE reachable(oid) AS (
        SELECT oid FROM pg_catalog.pg_roles WHERE rolname IN (CURRENT_USER,SESSION_USER)
        UNION SELECT m.roleid FROM pg_catalog.pg_auth_members m JOIN reachable r ON r.oid=m.member
      ), relations AS (
        SELECT c.* FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='pactwoven' AND c.relkind IN ('r','p','v','m','f','S')
      ), routines AS (
        SELECT p.* FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='pactwoven' OR(p.prosecdef AND n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema')
      ), expected AS (SELECT pg_catalog.to_regprocedure(name) AS oid FROM unnest($1::text[]) AS item(name))
      SELECT (CURRENT_USER=SESSION_USER AND pg_catalog.current_setting('role')='none'
        AND pg_catalog.current_setting('transaction_isolation')='read committed'
        AND pg_catalog.pg_has_role(SESSION_USER,$3,'USAGE')
        AND NOT EXISTS(SELECT 1 FROM reachable r JOIN pg_catalog.pg_roles p ON p.oid=r.oid WHERE p.rolsuper OR p.rolbypassrls OR p.rolcreaterole OR p.rolcreatedb OR p.rolreplication
          OR p.rolname IN ('pactwoven_runtime','pactwoven_provisioner','pactwoven_access_provisioner','pactwoven_mandate_writer','pactwoven_finance_observer', $4))
        -- pg_database_owner membership is implicit, so pg_auth_members alone
        -- misses it. Inspect ownership and effective privileges for every
        -- reachable role, including roles available only through SET ROLE.
        AND NOT EXISTS(SELECT 1 FROM reachable r JOIN pg_catalog.pg_database d ON d.datdba=r.oid WHERE d.datname=pg_catalog.current_database())
        AND NOT EXISTS(SELECT 1 FROM reachable r WHERE pg_catalog.pg_has_role(r.oid,'pg_database_owner','USAGE')
          OR pg_catalog.has_database_privilege(r.oid,pg_catalog.current_database(),'CREATE'))
        AND NOT EXISTS(SELECT 1 FROM reachable r CROSS JOIN pg_catalog.pg_namespace n WHERE n.nspname IN ('pactwoven','public')
          AND(n.nspowner=r.oid OR pg_catalog.pg_has_role(r.oid,n.nspowner,'USAGE')))
        AND NOT EXISTS(SELECT 1 FROM reachable r WHERE pg_catalog.has_schema_privilege(r.oid,'pactwoven','CREATE')
          OR pg_catalog.has_schema_privilege(r.oid,'public','CREATE'))
        AND NOT EXISTS(SELECT 1 FROM reachable r CROSS JOIN relations t WHERE t.relowner=r.oid
          OR(t.relkind='S' AND pg_catalog.has_sequence_privilege(r.oid,t.oid,'USAGE,SELECT,UPDATE'))
          OR(t.relkind<>'S' AND(pg_catalog.has_table_privilege(r.oid,t.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
            OR pg_catalog.has_any_column_privilege(r.oid,t.oid,'SELECT,INSERT,UPDATE,REFERENCES'))))
        AND NOT EXISTS(SELECT 1 FROM reachable r CROSS JOIN routines f WHERE f.proowner=r.oid OR
          (pg_catalog.has_function_privilege(r.oid,f.oid,'EXECUTE') AND f.oid NOT IN(SELECT oid FROM expected WHERE oid IS NOT NULL)))
        AND NOT EXISTS(SELECT 1 FROM expected e LEFT JOIN routines f ON f.oid=e.oid WHERE f.oid IS NULL OR NOT f.prosecdef
          OR f.proowner<>(SELECT nspowner FROM pg_catalog.pg_namespace WHERE nspname='pactwoven')
          OR NOT(coalesce(f.proconfig,ARRAY[]::text[]) @> ARRAY['search_path=pg_catalog']) OR NOT pg_catalog.has_function_privilege(CURRENT_USER,f.oid,'EXECUTE'))
        AND NOT EXISTS(SELECT 1 FROM unnest($2::text[]) AS expected_table(name) LEFT JOIN relations t ON t.relname=expected_table.name WHERE t.oid IS NULL OR t.relkind<>'r' OR NOT t.relrowsecurity)
      ) AS safe`, [custodySetupRoutines[capability],custodySetupTables,`pactwoven_custody_setup_${capability}`,`pactwoven_custody_setup_${capability==='writer'?'verifier':'writer'}`]);
    if (result.rows.length !== 1 || result.rows[0]?.safe !== true) throw unsafe();
  } catch (error) { if (error instanceof DomainError) throw error; throw unsafe(); }
}
export async function assertCustodySetupPool(pool: Pool, capability: CustodySetupCapability): Promise<void> {
  const client = await pool.connect(); let failed = false;
  try { await client.query('BEGIN ISOLATION LEVEL READ COMMITTED'); await client.query('SET LOCAL search_path=pg_catalog'); await assertCustodySetupConnection(client,capability); await client.query('COMMIT'); }
  catch (error) { failed = true; try { await client.query('ROLLBACK'); } catch { /* Discard. */ } throw error; }
  finally { client.release(failed); }
}
export async function createCustodySetupPool(connectionString: string, capability: CustodySetupCapability): Promise<Pool> {
  const pool = new Pool({ connectionString, max: 3, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000, statement_timeout: 5000 });
  pool.on('error', () => {});
  try { await assertCustodySetupPool(pool,capability); return pool; } catch (error) { await pool.end(); throw error; }
}
