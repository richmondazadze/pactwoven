/** PostgreSQL REL_17_11 system_functions.sql and system_views.sql restrict these 62 signatures at initdb.
 * The cohort is explicit and fails closed on another server version. Checking every
 * overload of each family and initially restricted catalog routine also prevents a
 * later PUBLIC/role ACL from turning the observed ACL into the approval baseline.
 * Reserved predefined roles, including SET-only ancestors, are outside custody.
 * Ordinary public built-ins remain available. No restricted routine is invoked.
 * Keep this predicate byte-equivalent to 0010's private system helper; tests enforce it.
 */
export const custodyPostgresVersion=170011;
export const custodySystemPrivilegePredicate=`WITH required(signature) AS (SELECT pg_catalog.unnest(ARRAY[
    'pg_catalog.pg_backup_start(text,boolean)',
    'pg_catalog.pg_backup_stop(boolean)',
    'pg_catalog.pg_create_restore_point(text)',
    'pg_catalog.pg_switch_wal()',
    'pg_catalog.pg_log_standby_snapshot()',
    'pg_catalog.pg_wal_replay_pause()',
    'pg_catalog.pg_wal_replay_resume()',
    'pg_catalog.pg_rotate_logfile()',
    'pg_catalog.pg_reload_conf()',
    'pg_catalog.pg_current_logfile()',
    'pg_catalog.pg_current_logfile(text)',
    'pg_catalog.pg_promote(boolean,integer)',
    'pg_catalog.pg_stat_reset()',
    'pg_catalog.pg_stat_reset_shared(text)',
    'pg_catalog.pg_stat_reset_slru(text)',
    'pg_catalog.pg_stat_reset_single_table_counters(oid)',
    'pg_catalog.pg_stat_reset_single_function_counters(oid)',
    'pg_catalog.pg_stat_reset_replication_slot(text)',
    'pg_catalog.pg_stat_have_stats(text,oid,oid)',
    'pg_catalog.pg_stat_reset_subscription_stats(oid)',
    'pg_catalog.lo_import(text)',
    'pg_catalog.lo_import(text,oid)',
    'pg_catalog.lo_export(oid,text)',
    'pg_catalog.pg_ls_logdir()',
    'pg_catalog.pg_ls_waldir()',
    'pg_catalog.pg_ls_archive_statusdir()',
    'pg_catalog.pg_ls_tmpdir()',
    'pg_catalog.pg_ls_tmpdir(oid)',
    'pg_catalog.pg_read_file(text)',
    'pg_catalog.pg_read_file(text,boolean)',
    'pg_catalog.pg_read_file(text,bigint,bigint)',
    'pg_catalog.pg_read_file(text,bigint,bigint,boolean)',
    'pg_catalog.pg_read_binary_file(text)',
    'pg_catalog.pg_read_binary_file(text,boolean)',
    'pg_catalog.pg_read_binary_file(text,bigint,bigint)',
    'pg_catalog.pg_read_binary_file(text,bigint,bigint,boolean)',
    'pg_catalog.pg_replication_origin_advance(text,pg_lsn)',
    'pg_catalog.pg_replication_origin_create(text)',
    'pg_catalog.pg_replication_origin_drop(text)',
    'pg_catalog.pg_replication_origin_oid(text)',
    'pg_catalog.pg_replication_origin_progress(text,boolean)',
    'pg_catalog.pg_replication_origin_session_is_setup()',
    'pg_catalog.pg_replication_origin_session_progress(boolean)',
    'pg_catalog.pg_replication_origin_session_reset()',
    'pg_catalog.pg_replication_origin_session_setup(text)',
    'pg_catalog.pg_replication_origin_xact_reset()',
    'pg_catalog.pg_replication_origin_xact_setup(pg_lsn,timestamp with time zone)',
    'pg_catalog.pg_show_replication_origin_status()',
    'pg_catalog.pg_stat_file(text)',
    'pg_catalog.pg_stat_file(text,boolean)',
    'pg_catalog.pg_ls_dir(text)',
    'pg_catalog.pg_ls_dir(text,boolean,boolean)',
    'pg_catalog.pg_log_backend_memory_contexts(integer)',
    'pg_catalog.pg_ls_logicalsnapdir()',
    'pg_catalog.pg_ls_logicalmapdir()',
    'pg_catalog.pg_ls_replslotdir(text)',
    'pg_catalog.pg_show_all_file_settings()',
    'pg_catalog.pg_hba_file_rules()',
    'pg_catalog.pg_ident_file_mappings()',
    'pg_catalog.pg_config()',
    'pg_catalog.pg_get_shmem_allocations()',
    'pg_catalog.pg_get_backend_memory_contexts()'
  ]::text[])), baseline AS (
    SELECT signature,pg_catalog.to_regprocedure(signature) AS oid FROM required
  ), system_routines AS (
    SELECT p.oid FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='pg_catalog' AND (
      p.proname IN (SELECT f.proname FROM baseline b JOIN pg_catalog.pg_proc f ON f.oid=b.oid)
      OR p.prosecdef
      OR EXISTS(SELECT 1 FROM pg_catalog.pg_init_privs i WHERE i.classoid='pg_catalog.pg_proc'::pg_catalog.regclass
        AND i.objoid=p.oid AND i.objsubid=0 AND i.privtype='i'
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(i.initprivs) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE'))
    )
  )
  SELECT pg_catalog.current_setting('server_version_num')::integer=170011
    AND EXISTS(SELECT 1 FROM reachable)
    AND NOT EXISTS(SELECT 1 FROM baseline b LEFT JOIN pg_catalog.pg_proc p ON p.oid=b.oid
      LEFT JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE p.oid IS NULL OR n.nspname<>'pg_catalog')
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.unnest(ARRAY['pg_database_owner','pg_read_all_data','pg_write_all_data','pg_monitor','pg_read_all_settings','pg_read_all_stats','pg_stat_scan_tables','pg_read_server_files','pg_write_server_files','pg_execute_server_program','pg_signal_backend','pg_checkpoint','pg_maintain','pg_use_reserved_connections','pg_create_subscription']::text[]) required_role(name)
      LEFT JOIN pg_catalog.pg_roles r ON r.rolname=required_role.name WHERE r.oid IS NULL)
    AND NOT EXISTS(SELECT 1 FROM reachable x JOIN pg_catalog.pg_roles r ON r.oid=x.oid WHERE
      pg_catalog.left(r.rolname,3)='pg_' OR r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication)
    AND NOT EXISTS(SELECT 1 FROM reachable x JOIN pg_catalog.pg_proc p ON p.proowner=x.oid
      JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='pg_catalog')
    AND NOT EXISTS(SELECT 1 FROM reachable x CROSS JOIN system_routines f
      WHERE pg_catalog.has_function_privilege(x.oid,f.oid,'EXECUTE'))`;
