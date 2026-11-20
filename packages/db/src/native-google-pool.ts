import { Pool } from 'pg';
import type { Environment } from '../../contracts/src/core';

export const googleProfiles = Object.freeze({
  observer: ['native_google_access_observe(text,jsonb)'],
  api: ['native_google_access_prepare(text,jsonb,text,jsonb)', 'native_google_access_confirm(text,jsonb,text,jsonb)', 'native_google_access_receipt(text,jsonb,text)', 'native_google_access_revoke_consent(text,jsonb,text,bigint)', 'native_communication_issue(text,jsonb,uuid)', 'native_communication_revoke(text,jsonb,text,bigint)', 'native_google_discovery_overview(text,jsonb)', 'native_google_discovery_begin(text,jsonb,jsonb)', 'native_google_discovery_prepare(text,jsonb,text,jsonb)'],
  review: ['native_google_access_review(text,text)', 'native_communication_retain_review(text,text,jsonb,jsonb)'],
  content: ['native_google_access_content(text,jsonb,jsonb,text)'],
  auth: ['native_google_create_attempt(text,jsonb)', 'native_google_reserve_attempt(text,text,jsonb,text)', 'native_google_complete_attempt(text,text,jsonb,text,jsonb)', 'native_google_fail_attempt(text,text,text)', 'native_google_recover_attempt(text,text,jsonb)', 'native_google_revoke(text,text,jsonb,bigint)'],
  worker: ['native_google_resolve_read(text,text,text)', 'native_google_reserve_refresh(text,jsonb,bigint,text)', 'native_google_complete_refresh(text,jsonb,text,jsonb)', 'native_google_fail_refresh(text,text,text)', 'native_google_retain_observation(text,jsonb,jsonb)'],
  reader: ['native_google_discovery_claim(text,text,text)', 'native_google_discovery_reserve_refresh(text,text,text)', 'native_google_discovery_complete_refresh(text,text,text,jsonb)', 'native_google_discovery_complete(text,text,text,jsonb,jsonb,timestamp with time zone)', 'native_google_discovery_fail(text,text,text)'],
} as const);
export type NativeGooglePoolLane = keyof typeof googleProfiles;
export const expectedSignatures = (lane: NativeGooglePoolLane) => {
  if (!Object.hasOwn(googleProfiles, lane)) throw Error('Unknown Google service profile');
  return ['pactwoven.native_google_production_binding(text,text)', ...googleProfiles[lane].map(s => 'pactwoven.' + s)];
};
export async function assertGoogleProfile(pool: Pool, environment: Environment, lane: NativeGooglePoolLane) {
  if (!['simulation','development','staging','production'].includes(environment)) throw Error('Invalid environment');
  const expected = expectedSignatures(lane), client = await pool.connect(); let failed = false;
  try {
    // The binding check uses READ COMMITTED and locks enrollment rows while
    // verifying their current status. It performs no persistent writes.
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await client.query("SET LOCAL search_path=pg_catalog; SET LOCAL statement_timeout='5s'");
    const { rows } = await client.query(`
      WITH RECURSIVE reachable(oid) AS (
        SELECT oid FROM pg_roles WHERE rolname IN(CURRENT_USER,SESSION_USER)
        UNION SELECT m.roleid FROM pg_auth_members m JOIN reachable r ON r.oid=m.member
      ), relations AS (SELECT c.oid,c.relowner FROM pg_class c WHERE c.relnamespace='pactwoven'::regnamespace AND c.relkind IN('r','p','v','m','f')),
      routines AS (SELECT p.oid,p.proowner,p.prosecdef,p.proconfig FROM pg_proc p WHERE p.pronamespace='pactwoven'::regnamespace),
      expected AS (SELECT to_regprocedure(s) oid FROM unnest($3::text[]) s)
      SELECT CURRENT_USER=SESSION_USER AND pactwoven.native_google_production_binding($1,$2)
        AND NOT EXISTS(SELECT 1 FROM reachable x JOIN pg_roles r ON r.oid=x.oid WHERE r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolbypassrls OR r.rolreplication)
        AND NOT EXISTS(SELECT 1 FROM reachable x JOIN pg_namespace n ON n.nspowner=x.oid WHERE n.nspname='pactwoven')
        AND NOT EXISTS(SELECT 1 FROM reachable x WHERE has_schema_privilege(x.oid,'pactwoven','CREATE'))
        AND NOT EXISTS(SELECT 1 FROM reachable x CROSS JOIN relations t WHERE x.oid=t.relowner OR has_table_privilege(x.oid,t.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') OR has_any_column_privilege(x.oid,t.oid,'SELECT,INSERT,UPDATE,REFERENCES'))
        AND NOT EXISTS(SELECT 1 FROM reachable x CROSS JOIN routines f WHERE x.oid=f.proowner OR (has_function_privilege(x.oid,f.oid,'EXECUTE') AND NOT EXISTS(SELECT 1 FROM expected e WHERE e.oid=f.oid)))
        AND NOT EXISTS(SELECT 1 FROM expected e LEFT JOIN routines f ON f.oid=e.oid WHERE f.oid IS NULL OR NOT f.prosecdef OR NOT ('search_path=pg_catalog'=ANY(coalesce(f.proconfig,'{}'))) OR NOT has_function_privilege(CURRENT_USER,f.oid,'EXECUTE')) safe`, [environment, lane, expected]);
    if (rows.length !== 1 || rows[0].safe !== true) throw Error('Unsafe Google service profile');
    if ((await client.query('COMMIT')).command !== 'COMMIT') throw Error('Unknown profile verification outcome');
  } catch { failed = true; await client.query('ROLLBACK').catch(() => {}); throw new Error('Google service database admission failed.'); }
  finally { client.release(failed); }
}


export async function createNativeGooglePool(connectionString: string, environment: Environment, lane: NativeGooglePoolLane): Promise<Pool> {
  const pool = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000, statement_timeout: 8000 });
  pool.on('error', () => { console.error('A Google service database connection became unavailable.'); });
  try { await assertGoogleProfile(pool, environment, lane); return pool; }
  catch { await pool.end(); throw new Error('Google service database admission failed.'); }
}
