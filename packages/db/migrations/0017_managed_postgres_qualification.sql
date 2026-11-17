BEGIN;

-- Only the exact existing identity/schema owner may qualify this installation.
-- No runtime login, binding, persistent grant, or historical migration changes.
DO $$ DECLARE legacy_owner oid;BEGIN
  SELECT r.oid INTO legacy_owner FROM pg_roles r WHERE r.rolname=current_user AND current_user=session_user;
  IF current_setting('server_version_num')::integer NOT IN(170011,170012)
    OR legacy_owner IS NULL
    OR NOT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='pactwoven' AND nspowner=legacy_owner)
    OR (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='pactwoven' AND c.relname IN ('organizations','memberships','session_revocations','sites')
        AND c.relowner=legacy_owner AND c.relkind='r' AND c.relrowsecurity
        AND (NOT c.relforcerowsecurity OR EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=legacy_owner AND (r.rolsuper OR r.rolbypassrls))))<>4
    OR (SELECT count(*) FROM pg_proc WHERE oid=ANY(ARRAY[
      to_regprocedure('pactwoven.supplier_base_identity(jsonb,jsonb,jsonb)'),
      to_regprocedure('pactwoven.supplier_observer_identity(text,text,jsonb)')]::oid[])
      AND proowner=legacy_owner AND prosecdef)<>2
    OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('pactwoven.custody_system_privileges_safe(oid)')
      AND proowner=legacy_owner AND NOT prosecdef)
    OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('pactwoven.supplier_role_safe(oid,text)')
      AND proowner='pactwoven_supplier_executor'::regrole AND NOT prosecdef) THEN
    RAISE EXCEPTION 'Managed PostgreSQL qualification requires the exact installed identity/schema owner and supported server';
  END IF;
  IF NOT (SELECT rolsuper FROM pg_roles WHERE oid=legacy_owner) THEN
    IF NOT EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles g ON g.oid=m.grantor
      WHERE m.roleid='pactwoven_supplier_executor'::regrole AND m.member=legacy_owner
        AND m.admin_option AND NOT m.inherit_option AND NOT m.set_option AND m.grantor=10 AND g.rolsuper)
      OR EXISTS(SELECT 1 FROM pg_auth_members WHERE roleid='pactwoven_supplier_executor'::regrole
        AND member=legacy_owner AND (inherit_option OR set_option)) THEN
      RAISE EXCEPTION 'Managed PostgreSQL qualification requires the original administrative installation capability';
    END IF;
    EXECUTE format('GRANT pactwoven_supplier_executor TO %I WITH INHERIT TRUE',current_user);
    EXECUTE format('GRANT pactwoven_supplier_executor TO %I WITH SET TRUE',current_user);
    GRANT CREATE ON SCHEMA pactwoven TO pactwoven_supplier_executor;
  END IF;
END $$;

-- Same explicit restricted inventory and expanded ACL closure as 0010.
-- PostgreSQL 17.12 has been catalog-qualified; unlisted versions fail closed.
CREATE OR REPLACE FUNCTION pactwoven.custody_system_privileges_safe(who oid) RETURNS boolean LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$
 WITH RECURSIVE reachable(oid) AS (
  SELECT oid FROM pg_catalog.pg_roles WHERE oid=who
  UNION SELECT m.roleid FROM pg_catalog.pg_auth_members m JOIN reachable x ON x.oid=m.member
 )
 SELECT (WITH required(signature) AS (SELECT pg_catalog.unnest(ARRAY[
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
  SELECT pg_catalog.current_setting('server_version_num')::integer IN(170011,170012)
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
      WHERE pg_catalog.has_function_privilege(x.oid,f.oid,'EXECUTE'))
 )
$$;

-- Retain every runtime privilege condition from 0016. A managed CREATEROLE
-- installer cannot revoke the bootstrap grantor's automatic creator row.
-- It conveys no inherited access or SET ROLE, and only the already trusted
-- shared identity/schema owner may hold it. Outbound membership stays forbidden.
CREATE OR REPLACE FUNCTION pactwoven.supplier_role_safe(who oid,capability text) RETURNS boolean
LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$
  SELECT coalesce((SELECT r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreatedb
    AND NOT r.rolcreaterole AND NOT r.rolreplication AND NOT r.rolinherit AND r.rolconfig IS NULL
    AND NOT EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid OR (m.roleid=r.oid AND NOT(
      m.admin_option AND NOT m.inherit_option AND NOT m.set_option
      -- OID 10 is PostgreSQL's original bootstrap superuser, not a role-name proxy.
      AND m.grantor=10 AND EXISTS(SELECT 1 FROM pg_roles g WHERE g.oid=m.grantor AND g.rolsuper)
      AND EXISTS(SELECT 1 FROM pg_namespace owner_schema WHERE owner_schema.nspname='pactwoven'
        AND owner_schema.nspowner=m.member
        AND (SELECT count(*) FROM pg_class c WHERE c.relnamespace=owner_schema.oid
          AND c.relname IN ('organizations','memberships','session_revocations','sites')
          AND c.relkind='r' AND c.relrowsecurity AND c.relowner=m.member)=4
        AND (SELECT count(*) FROM pg_proc f WHERE f.oid=ANY(ARRAY[
          to_regprocedure('pactwoven.supplier_base_identity(jsonb,jsonb,jsonb)'),
          to_regprocedure('pactwoven.supplier_observer_identity(text,text,jsonb)')]::oid[])
          AND f.proowner=m.member AND f.prosecdef)=2))))
    AND NOT has_database_privilege(r.oid,pactwoven.supplier_database_oid(),'CREATE')
    AND NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname!~'^pg_temp_' AND has_schema_privilege(r.oid,n.oid,'CREATE'))
    AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname!~'^pg_(temp|toast)'
      AND c.relkind IN ('r','p','v','m','f') AND (has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        OR has_any_column_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
    AND NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname!~'^pg_(temp|toast)'
      AND has_function_privilege(r.oid,p.oid,'EXECUTE') AND NOT
      (capability='verifier' AND p.oid=ANY(ARRAY[to_regprocedure('pactwoven.supplier_record_evidence(jsonb)'),to_regprocedure('pactwoven.supplier_resolve_observer(jsonb,jsonb)')]::oid[]) OR capability='authorizer' AND p.oid=ANY(ARRAY[
        to_regprocedure('pactwoven.supplier_scope_policy_command(uuid,jsonb)'),to_regprocedure('pactwoven.supplier_scope_policy_read(uuid,jsonb)'),
        to_regprocedure('pactwoven.supplier_relationship_command(uuid,jsonb)'),to_regprocedure('pactwoven.supplier_relationship_status(uuid,jsonb)'),
        to_regprocedure('pactwoven.supplier_relationship_recover(uuid,jsonb)')]::oid[])))
    FROM pg_roles r WHERE r.oid=who),false)
$$;

-- CREATE OR REPLACE preserves both helper owners and ACLs. Drop only this
-- transaction's temporary executor membership, retaining the original row.
DO $$ BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) THEN
    REVOKE CREATE ON SCHEMA pactwoven FROM pactwoven_supplier_executor;
    EXECUTE format('REVOKE pactwoven_supplier_executor FROM %I GRANTED BY %I',current_user,current_user);
  END IF;
END $$;

COMMIT;
