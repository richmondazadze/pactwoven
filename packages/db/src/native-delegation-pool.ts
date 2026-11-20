import { Pool } from 'pg';
import { EnvironmentSchema, type Environment } from '@pactwoven/contracts';
import { DomainError } from '@pactwoven/domain';

export type NativeDelegationPoolPurpose = 'api' | 'coordinator' | 'worker' | 'dispatcher';
export type NativeDelegationPoolProfile = 'delegation' | 'delegation-memory' | 'delegation-memory-notes'
  | 'delegation-root-paid' | 'delegation-root' | 'delegation-root-refresh' | 'delegation-root-instructions' | 'delegation-root-external' | 'delegation-root-notes' | 'delegation-work-intent' | 'delegation-workspace' | 'delegation-workspace-instructions' | 'delegation-workspace-activity';
const binding = 'pactwoven.native_delegation_binding(text,text)';
const work = ['pactwoven.native_delegation_claim(text,jsonb,integer)', 'pactwoven.native_delegation_renew(text,jsonb,integer)',
  'pactwoven.native_delegation_handoff(text,jsonb,jsonb)', 'pactwoven.native_delegation_retry(text,jsonb,jsonb)',
  'pactwoven.native_delegation_result_commit(text,jsonb,jsonb)'];
const signatures: Record<NativeDelegationPoolPurpose, readonly string[]> = {
  api: [binding, 'pactwoven.native_delegation_issue(jsonb,text,jsonb,jsonb)', 'pactwoven.native_delegation_read(jsonb,text)',
    'pactwoven.native_delegation_revoke(jsonb,jsonb)', 'pactwoven.native_delegation_authority_prepare(text,jsonb,text)',
    'pactwoven.native_delegation_authority_finish(text,uuid,jsonb)'],
  coordinator: [binding, ...work], worker: [binding, ...work],
  dispatcher: [binding, 'pactwoven.native_delegation_outbox_claim(text,integer)', 'pactwoven.native_delegation_outbox_ack(text,jsonb,uuid)'],
};
const memory: Record<NativeDelegationPoolPurpose, readonly string[]> = {
  api: ['pactwoven.native_memory_human_read(jsonb,jsonb)', 'pactwoven.native_memory_human_source(jsonb,text,jsonb)',
    'pactwoven.native_memory_human_mutate(jsonb,text,jsonb)', 'pactwoven.native_memory_human_recover(jsonb,text,text)'],
  coordinator: ['pactwoven.native_memory_task_read(text,jsonb,jsonb)'],
  worker: ['pactwoven.native_memory_task_read(text,jsonb,jsonb)'], dispatcher: [],
};
const notes = ['pactwoven.native_memory_notes_list(jsonb,jsonb)', 'pactwoven.native_memory_notes_get(jsonb,text,text)',
  'pactwoven.native_memory_notes_command(jsonb,text,jsonb)', 'pactwoven.native_memory_notes_recover(jsonb,text,text)'];
const root: Record<NativeDelegationPoolPurpose, readonly string[]> = {
  api: ['pactwoven.native_delegation_root_bind_notes(jsonb,text,jsonb)', 'pactwoven.native_delegation_root_control(jsonb,text,jsonb)',
    'pactwoven.native_delegation_root_control_recover(jsonb,text,text)', 'pactwoven.native_delegation_root_read(jsonb,text)'],
  coordinator: ['pactwoven.native_delegation_root_checkpoint(text,jsonb,jsonb)', 'pactwoven.native_delegation_root_claim(text,jsonb,integer)',
    'pactwoven.native_delegation_root_complete(text,jsonb,jsonb)', 'pactwoven.native_delegation_root_handoff(text,jsonb,jsonb)',
    'pactwoven.native_delegation_root_inputs(text,jsonb,jsonb)', 'pactwoven.native_delegation_root_materials(text,jsonb)',
    'pactwoven.native_delegation_root_work(text,jsonb)', 'pactwoven.native_delegation_root_yield(text,jsonb,jsonb)'],
  worker: ['pactwoven.native_delegation_root_materials(text,jsonb)'],
  dispatcher: ['pactwoven.native_delegation_root_recover(text,integer)', 'pactwoven.native_delegation_root_route(text,jsonb)'],
};
const intents = ['pactwoven.native_work_intent_prepare(jsonb,text,jsonb)', 'pactwoven.native_work_intent_confirm(jsonb,text,jsonb,jsonb)',
  'pactwoven.native_work_intent_recover(jsonb,text,text)', 'pactwoven.native_work_intent_provenance(jsonb,jsonb)'];
const refreshWorker = ['pactwoven.native_delegation_root_materials_v2(text,jsonb)',
  'pactwoven.native_delegation_result_commit_v2(text,jsonb,jsonb)'];
const refresh: Record<'coordinator' | 'worker', readonly string[]> = {
  coordinator: ['pactwoven.native_delegation_root_work_v2(text,jsonb)', 'pactwoven.native_delegation_root_inputs_v2(text,jsonb,jsonb)',
    'pactwoven.native_delegation_root_checkpoint_v2(text,jsonb,jsonb)', 'pactwoven.native_delegation_root_yield_v2(text,jsonb,jsonb)',
    'pactwoven.native_delegation_root_complete_v2(text,jsonb,jsonb)', 'pactwoven.native_delegation_root_refresh(text,jsonb,jsonb)',
    'pactwoven.native_delegation_root_refresh_dispatch(text,jsonb,jsonb)', 'pactwoven.native_delegation_root_refresh_operation(text,jsonb,jsonb)', ...refreshWorker],
  worker: refreshWorker,
};
const instructionApi = ['pactwoven.native_work_conversation_read(jsonb,text,text)',
  'pactwoven.native_work_instruction_update(jsonb,text,text,text,jsonb)', 'pactwoven.native_work_instruction_recover(jsonb,text,text,text)'];
const instructionWorker = ['pactwoven.native_delegation_root_materials_v3(text,jsonb)',
  'pactwoven.native_delegation_result_commit_v3(text,jsonb,jsonb)'];
const instructions: Record<'coordinator' | 'worker', readonly string[]> = {
  coordinator: ['pactwoven.native_delegation_root_work_v3(text,jsonb)', 'pactwoven.native_delegation_root_inputs_v3(text,jsonb,jsonb)',
    'pactwoven.native_delegation_root_checkpoint_v3(text,jsonb,jsonb)', 'pactwoven.native_delegation_root_yield_v3(text,jsonb,jsonb)',
    'pactwoven.native_delegation_root_complete_v3(text,jsonb,jsonb)', 'pactwoven.native_delegation_root_handoff_v3(text,jsonb,jsonb)',
    'pactwoven.native_delegation_root_refresh_v3(text,jsonb,jsonb)', 'pactwoven.native_delegation_root_refresh_dispatch_v3(text,jsonb,jsonb)',
    'pactwoven.native_delegation_root_refresh_operation_v3(text,jsonb,jsonb)', ...instructionWorker],
  worker: instructionWorker,
};
const profiles: readonly NativeDelegationPoolProfile[] = ['delegation-root-paid', 'delegation', 'delegation-memory', 'delegation-memory-notes',
  'delegation-root', 'delegation-root-refresh', 'delegation-root-instructions', 'delegation-root-external', 'delegation-root-notes', 'delegation-work-intent', 'delegation-workspace', 'delegation-workspace-instructions', 'delegation-workspace-activity'];

/** Fixed additive profiles. The opt-in external coordinator profile must be
 * promoted with the external SQL grant; the old root profile rejects that grant.
 * Extra effective privileges, role inheritance and
 * owner access fail closed. Credentials authenticate a service audience, not
 * individual processes sharing that credential or hosting project. */
/** Canonical exact privileges; composed services must still verify both enrollments. */
export function nativeDelegationExpectedSignatures(purpose: NativeDelegationPoolPurpose,
  profile: NativeDelegationPoolProfile = 'delegation'): string[] {
  if (profile === 'delegation-root-paid' && purpose !== 'coordinator') throw new DomainError('UNSAFE_DATABASE_ROLE',503,'Paid root access is coordinator-only.');
  const baseProfile = profile === 'delegation-root-paid' ? 'delegation-root-instructions' : profile;
  const withNotes = ['delegation-memory-notes', 'delegation-root-notes', 'delegation-work-intent', 'delegation-workspace', 'delegation-workspace-instructions', 'delegation-workspace-activity'].includes(baseProfile);
  const withRoot = ['delegation-root', 'delegation-root-refresh', 'delegation-root-instructions', 'delegation-root-external', 'delegation-root-notes', 'delegation-work-intent', 'delegation-workspace', 'delegation-workspace-instructions', 'delegation-workspace-activity'].includes(baseProfile);
  if (!Object.hasOwn(signatures, purpose) || !profiles.includes(profile) || (withNotes && purpose !== 'api') ||
    (baseProfile === 'delegation-root' && purpose === 'api') || (baseProfile === 'delegation-root-external' && purpose !== 'coordinator') ||
    (['delegation-root-refresh', 'delegation-root-instructions'].includes(baseProfile) && purpose !== 'coordinator' && purpose !== 'worker')) {
    throw new DomainError('UNSAFE_DATABASE_ROLE', 503, 'The delegation pool profile is invalid.');
  }
  return [...signatures[purpose], ...(baseProfile !== 'delegation' ? memory[purpose] : []),
      ...(withNotes ? notes : []), ...(withRoot ? root[purpose] : []), ...(['delegation-work-intent', 'delegation-workspace', 'delegation-workspace-instructions', 'delegation-workspace-activity'].includes(baseProfile) ? intents : []),
      ...(baseProfile === 'delegation-root-external' ? ['pactwoven.native_external_wait_complete(text,jsonb,jsonb)'] : []),
      ...(['delegation-root-refresh', 'delegation-root-instructions'].includes(baseProfile) ? refresh[purpose as 'coordinator' | 'worker'] : []),
      ...(baseProfile === 'delegation-root-instructions' ? instructions[purpose as 'coordinator' | 'worker'] : []),
      ...(['delegation-workspace-instructions', 'delegation-workspace-activity'].includes(baseProfile) ? instructionApi : []),
      ...(baseProfile === 'delegation-workspace-activity' ? ['pactwoven.native_work_activity_read(jsonb,text,text)'] : []),
      ...(['delegation-workspace', 'delegation-workspace-instructions', 'delegation-workspace-activity'].includes(baseProfile) ? ['pactwoven.native_agent_work_list(jsonb,jsonb)'] : []),
      ...(profile === 'delegation-root-paid' ? ['pactwoven.paid_tool_root_wait(jsonb,jsonb)', 'pactwoven.paid_tool_root_read(jsonb)', 'pactwoven.paid_tool_root_consume(jsonb,jsonb)', 'pactwoven.paid_tool_root_policy(jsonb)'] : [])];
}

// Fixed compatibility window for the additive paid-source revalidation protocol.
// Only the paid coordinator may acquire these routines; all other profiles keep
// their existing exact privilege boundary.
export function nativeDelegationOptionalSignatures(purpose: NativeDelegationPoolPurpose,
  profile: NativeDelegationPoolProfile = 'delegation'): readonly string[] {
  if (purpose === 'api' && profile === 'delegation-workspace-activity') return ['pactwoven.native_work_execution_read(jsonb,text,text)'];
  return purpose === 'coordinator' && profile === 'delegation-root-paid' ? [
    'pactwoven.paid_tool_root_revalidation(jsonb)',
    'pactwoven.paid_tool_root_revalidate(jsonb,jsonb)',
    'pactwoven.paid_tool_root_revalidation_park(jsonb,jsonb)',
  ] : [];
}

export async function assertNativeDelegationPool(pool: Pool, environment: Environment, purpose: NativeDelegationPoolPurpose,
  profile: NativeDelegationPoolProfile = 'delegation'): Promise<void> {
  EnvironmentSchema.parse(environment);
  const expectedSignatures = nativeDelegationExpectedSignatures(purpose, profile);
  const client = await pool.connect();
  let failed = false;
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL search_path=pg_catalog');
    const result = await client.query<{ safe: boolean }>(`
      WITH RECURSIVE reachable(oid) AS (
        SELECT oid FROM pg_catalog.pg_roles WHERE rolname IN (CURRENT_USER,SESSION_USER)
        UNION SELECT m.roleid FROM pg_catalog.pg_auth_members m JOIN reachable r ON r.oid=m.member
      ), relations AS (
        SELECT c.oid,c.relowner FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='pactwoven' AND c.relkind IN ('r','p','v','m','f')
      ), routines AS (
        SELECT p.oid,p.proowner,p.prosecdef,p.proconfig FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='pactwoven'
      ), optional AS (SELECT pg_catalog.to_regprocedure(s) AS oid FROM pg_catalog.unnest($4::text[]) s),
      expected AS (SELECT pg_catalog.to_regprocedure(s) AS oid FROM pg_catalog.unnest($3::text[]) s
        UNION SELECT oid FROM optional WHERE oid IS NOT NULL AND pg_catalog.has_function_privilege(CURRENT_USER,oid,'EXECUTE'))
      SELECT CURRENT_USER=SESSION_USER
        AND pactwoven.native_delegation_binding($1,$2)
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
    `, [environment, purpose, expectedSignatures, nativeDelegationOptionalSignatures(purpose, profile)]);
    if (result.rows.length !== 1 || result.rows[0]?.safe !== true) {
      throw new DomainError('UNSAFE_DATABASE_ROLE', 503, 'Delegated tasks require an enrolled, isolated service role.');
    }
    const committed = await client.query('COMMIT');
    if (committed.command !== 'COMMIT') throw new DomainError('UNSAFE_DATABASE_ROLE', 503, 'Delegation isolation could not be verified.');
  } catch (error) {
    failed = true;
    try { await client.query('ROLLBACK'); } catch { /* Failed connections are discarded. */ }
    if (error instanceof DomainError) throw error;
    throw new DomainError('UNSAFE_DATABASE_ROLE', 503, 'Delegation isolation could not be verified.');
  } finally { client.release(failed); }
}

export async function createNativeDelegationPool(connectionString: string, environment: Environment, purpose: NativeDelegationPoolPurpose,
  profile: NativeDelegationPoolProfile = 'delegation'): Promise<Pool> {
  const pool = new Pool({ connectionString, max: purpose === 'api' ? 3 : 2,
    connectionTimeoutMillis: 5_000, idleTimeoutMillis: 30_000, statement_timeout: 5_000 });
  pool.on('error', () => { console.error('A delegated task database connection became unavailable.'); });
  try { await assertNativeDelegationPool(pool, environment, purpose, profile); return pool; }
  catch (error) { await pool.end(); throw error; }
}
