import { Pool } from 'pg';
import type { Environment } from '../../contracts/src/core';
import { nativeDelegationExpectedSignatures, nativeDelegationOptionalSignatures } from './native-delegation-pool';

const apply=['paid_tool_apply(jsonb)','paid_tool_private_read(text,text,text)'];
const capture='paid_tool_capture_for_operation(text,jsonb)';
export const paidToolProfiles:Readonly<Record<string,readonly string[]>>=Object.freeze({
  api:['paid_tool_review(jsonb,jsonb)','paid_tool_approve(jsonb,text,text,text)','paid_tool_read(jsonb,text)','paid_tool_control(jsonb,jsonb)',
    'paid_tool_list(jsonb,text,text)','paid_tool_recover(jsonb,text,text,jsonb)','paid_tool_budget_read(jsonb,text)',
    'paid_tool_root_bind_policy(jsonb,jsonb)','paid_tool_root_quote(jsonb,text,text,text)','paid_tool_root_discover(jsonb,text,text)',
    'paid_tool_intent_prepare(jsonb,text,jsonb)','paid_tool_intent_confirm(jsonb,text,jsonb,jsonb)','paid_tool_intent_recover(jsonb,text,text)'],
  policy:[...apply,'paid_tool_quote(jsonb)',capture],
  signer:[...apply,'paid_tool_quarantine_wire(text,text)','paid_tool_observe_for_operation(text,jsonb)',capture],
  broadcaster:[...apply,'paid_tool_record_height(jsonb)',capture],
  observer:[...apply,'paid_tool_observe(jsonb)','paid_tool_record_height(jsonb)',capture],
  delivery:apply,
  scheduler:['paid_tool_dispatch_claim(jsonb)','paid_tool_dispatch_ack(jsonb,text)','paid_tool_dispatch_consume(jsonb,jsonb)','paid_tool_dispatch_finish(jsonb,jsonb)','paid_tool_dispatch_recover(jsonb)'],
});
export type PaidToolPoolLane = 'api'|'policy'|'signer'|'broadcaster'|'observer'|'delivery'|'scheduler';
// Additive read-only capability: the compatible API can be deployed before
// migrations0045/0048/0049. No other unknown routine or payment authority is admitted.
export const paidToolOptionalReadSignatures = (lane: PaidToolPoolLane): readonly string[] =>
  lane === 'api' ? ['pactwoven.paid_tool_retained_contributors(jsonb,text,text)',
    'pactwoven.paid_tool_completed_history(jsonb,text,text,text)',
    ...nativeDelegationOptionalSignatures('api', 'delegation-workspace-activity')] : [];
export const paidToolExpectedSignatures = (lane: PaidToolPoolLane) => {
  if (!Object.hasOwn(paidToolProfiles, lane)) throw Error('Unknown Paid tool service profile');
  // Paid intent wrappers use the existing native human actor/intent protocol.
  // Only the API lane composes these exact inherited privileges.
  return ['pactwoven.paid_tool_pool_binding(text)', ...paidToolProfiles[lane]!.map(s => 'pactwoven.' + s),
    ...(lane === 'api' ? nativeDelegationExpectedSignatures('api', 'delegation-workspace-activity') : [])];
};
export async function assertPaidToolProfile(pool: Pool, environment: Environment, lane: PaidToolPoolLane) {
  if (environment !== 'development') throw Error('Invalid environment');
  const expected = paidToolExpectedSignatures(lane), client = await pool.connect(); let failed = false;
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
      optional AS (SELECT to_regprocedure(s) oid FROM unnest($4::text[]) s),
      expected AS (SELECT to_regprocedure(s) oid FROM unnest($3::text[]) s
        UNION SELECT oid FROM optional WHERE oid IS NOT NULL AND has_function_privilege(CURRENT_USER,oid,'EXECUTE'))
      SELECT CURRENT_USER=SESSION_USER AND ($1::text='development' AND pactwoven.paid_tool_pool_binding($2))
        AND CASE WHEN $2::text='api' THEN pactwoven.native_delegation_binding($1,'api') ELSE true END
        AND NOT EXISTS(SELECT 1 FROM reachable x JOIN pg_roles r ON r.oid=x.oid WHERE r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolbypassrls OR r.rolreplication)
        AND NOT EXISTS(SELECT 1 FROM reachable x JOIN pg_namespace n ON n.nspowner=x.oid WHERE n.nspname='pactwoven')
        AND NOT EXISTS(SELECT 1 FROM reachable x WHERE has_schema_privilege(x.oid,'pactwoven','CREATE'))
        AND NOT EXISTS(SELECT 1 FROM reachable x CROSS JOIN relations t WHERE x.oid=t.relowner OR has_table_privilege(x.oid,t.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') OR has_any_column_privilege(x.oid,t.oid,'SELECT,INSERT,UPDATE,REFERENCES'))
        AND NOT EXISTS(SELECT 1 FROM reachable x CROSS JOIN routines f WHERE x.oid=f.proowner OR (has_function_privilege(x.oid,f.oid,'EXECUTE') AND NOT EXISTS(SELECT 1 FROM expected e WHERE e.oid=f.oid)))
        AND NOT EXISTS(SELECT 1 FROM expected e LEFT JOIN routines f ON f.oid=e.oid WHERE f.oid IS NULL OR NOT f.prosecdef OR NOT ('search_path=pg_catalog'=ANY(coalesce(f.proconfig,'{}'))) OR NOT has_function_privilege(CURRENT_USER,f.oid,'EXECUTE')) safe`, [environment, lane, expected, paidToolOptionalReadSignatures(lane)]);
    if (rows.length !== 1 || rows[0].safe !== true) throw Error('Unsafe Paid tool service profile');
    if ((await client.query('COMMIT')).command !== 'COMMIT') throw Error('Unknown profile verification outcome');
  } catch { failed = true; await client.query('ROLLBACK').catch(() => {}); throw new Error('Paid tool service database admission failed.'); }
  finally { client.release(failed); }
}


export async function createPaidToolPool(connectionString: string, environment: Environment, lane: PaidToolPoolLane): Promise<Pool> {
  const pool = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000, statement_timeout: 8000 });
  pool.on('error', () => { console.error('A Paid tool service database connection became unavailable.'); });
  try { await assertPaidToolProfile(pool, environment, lane); return pool; }
  catch { await pool.end(); throw new Error('Paid tool service database admission failed.'); }
}
