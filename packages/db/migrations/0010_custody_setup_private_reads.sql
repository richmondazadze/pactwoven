BEGIN;

-- PostgreSQL 17.11's explicit restricted core baseline; no login grants.
-- Equivalent predicate in custody-setup-system-privileges.ts is checked by tests.
CREATE FUNCTION pactwoven.custody_system_privileges_safe(who oid) RETURNS boolean LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$
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
      WHERE pg_catalog.has_function_privilege(x.oid,f.oid,'EXECUTE'))
 )
$$;

-- Preserve the published 0009 conditions; extend both existing capability paths.
CREATE OR REPLACE FUNCTION pactwoven.custody_principal(o text,cap text) RETURNS oid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r record;p record;unsafe boolean;BEGIN
 SELECT * INTO r FROM pg_roles WHERE rolname=SESSION_USER;
 WITH RECURSIVE reachable(oid) AS(SELECT r.oid UNION SELECT m.roleid FROM pg_auth_members m JOIN reachable x ON x.oid=m.member)
 SELECT EXISTS(SELECT 1 FROM reachable x JOIN pg_roles q ON q.oid=x.oid WHERE q.rolsuper OR q.rolbypassrls OR q.rolcreatedb OR q.rolcreaterole OR q.rolreplication
 OR q.rolname IN('pactwoven_runtime','pactwoven_provisioner','pactwoven_access_provisioner','pactwoven_mandate_writer','pactwoven_finance_observer',CASE cap WHEN 'writer' THEN 'pactwoven_custody_setup_verifier' ELSE 'pactwoven_custody_setup_writer' END)) INTO unsafe;
 IF coalesce(unsafe,true) OR current_setting('role')<>'none' OR r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR NOT r.rolcanlogin
 OR NOT pg_has_role(r.oid,'pactwoven_custody_setup_'||cap,'USAGE') THEN RAISE EXCEPTION USING ERRCODE='CS001',MESSAGE='Dedicated authenticated setup principal required';END IF;
 IF NOT coalesce(pactwoven.custody_system_privileges_safe(r.oid),false) THEN RAISE EXCEPTION USING ERRCODE='CS001',MESSAGE='Restricted system authority is forbidden for custody';END IF;
 SELECT * INTO p FROM pactwoven.custody_setup_principals WHERE principal_oid=r.oid AND organization_id=o ORDER BY version DESC LIMIT 1;
 IF p.principal_name IS DISTINCT FROM r.rolname OR p.capability IS DISTINCT FROM cap OR NOT coalesce(p.active,false) OR p.expires_at<=clock_timestamp() THEN RAISE EXCEPTION USING ERRCODE='CS001',MESSAGE='Current setup principal binding required';END IF;RETURN r.oid;
END $$;
CREATE OR REPLACE FUNCTION pactwoven.custody_evidence_current(eid uuid,o text) RETURNS boolean LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM pactwoven.custody_setup_evidence e JOIN pg_roles r ON r.oid=e.principal_oid AND r.rolname=e.principal_name
 JOIN LATERAL(SELECT * FROM pactwoven.custody_setup_principals p WHERE p.principal_oid=e.principal_oid AND p.organization_id=o ORDER BY version DESC LIMIT 1)p ON true
 WHERE e.id=eid AND e.organization_id=o AND p.environment='development' AND p.principal_name=r.rolname AND p.capability='verifier' AND p.version=e.principal_version AND p.active AND p.expires_at>clock_timestamp()
 AND coalesce(pactwoven.custody_system_privileges_safe(r.oid),false)
 AND pg_has_role(r.oid,'pactwoven_custody_setup_verifier','USAGE') AND r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolbypassrls)
$$;

-- Private validators have no login grants. Only the four fixed entry points below are callable.
CREATE FUNCTION pactwoven.custody_private_read_schema(k text) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT CASE k
WHEN 'observation' THEN $schema${"type":"object","properties":{"identity":{"type":"object","properties":{"subject":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"externalOrganizationId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"externalOrganizationName":{"type":"string","minLength":1,"maxLength":180},"externalMembershipId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"externalRole":{"type":"string","minLength":1,"maxLength":128},"membershipObservedAt":{"type":"string","pattern":"^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$"},"sessionId":{"type":"string","minLength":1,"maxLength":256},"authenticatedAt":{"type":"string","pattern":"^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$"}},"required":["subject","externalOrganizationId","externalOrganizationName","externalMembershipId","externalRole","membershipObservedAt","sessionId","authenticatedAt"],"additionalProperties":false},"observation":{"type":"object","properties":{"issuer":{"type":"string","maxLength":512,"pattern":"^[A-Za-z][A-Za-z0-9+.-]*://[^[:space:]]+$"},"tokenHash":{"type":"string","pattern":"^[a-f0-9]{64}$"},"tokenIssuedAt":{"type":"string","pattern":"^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$"},"observedAt":{"type":"string","pattern":"^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$"},"expiresAt":{"type":"string","pattern":"^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$"}},"required":["issuer","tokenHash","tokenIssuedAt","observedAt","expiresAt"],"additionalProperties":false}},"required":["identity","observation"],"additionalProperties":false}$schema$::jsonb
WHEN 'reference' THEN $schema${"type":"object","properties":{"id":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"version":{"type":"integer","minimum":1,"maximum":2147483647},"recordHash":{"type":"string","pattern":"^[a-f0-9]{64}$"}},"required":["id","version","recordHash"],"additionalProperties":false}$schema$::jsonb
WHEN 'id' THEN $schema${"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"}$schema$::jsonb
END $$;

CREATE FUNCTION pactwoven.custody_private_read_role_safe(who oid,cap text) RETURNS boolean LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$
 WITH RECURSIVE reachable(oid) AS(SELECT who UNION SELECT m.roleid FROM pg_auth_members m JOIN reachable x ON x.oid=m.member),
 relations AS(SELECT c.* FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='pactwoven' AND c.relkind IN('r','p','v','m','f','S')),
 routines AS(SELECT p.* FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='pactwoven' OR(p.prosecdef AND n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema')),
 expected AS(SELECT to_regprocedure(name) AS oid FROM unnest(CASE cap WHEN 'writer' THEN ARRAY['pactwoven.custody_setup_command(uuid,jsonb)','pactwoven.custody_setup_read(uuid,text,uuid)','pactwoven.custody_setup_recover(uuid,jsonb)',
  'pactwoven.custody_setup_specification_read(uuid,text,jsonb)','pactwoven.custody_setup_record_read(uuid,text,uuid,uuid,text)','pactwoven.custody_setup_original_read(uuid,text,text,text)']
  WHEN 'verifier' THEN ARRAY['pactwoven.custody_setup_attest(jsonb)','pactwoven.custody_setup_resolve_owner(jsonb,text)'] ELSE ARRAY[]::text[] END)names(name))
 SELECT coalesce(pactwoven.custody_system_privileges_safe(who),false) AND cap IN('writer','verifier') AND EXISTS(SELECT 1 FROM pg_roles WHERE oid=who AND rolcanlogin)
 AND pg_has_role(who,'pactwoven_custody_setup_'||cap,'USAGE')
 AND NOT EXISTS(SELECT 1 FROM reachable x JOIN pg_roles r ON r.oid=x.oid WHERE r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR
  r.rolname IN('pactwoven_runtime','pactwoven_provisioner','pactwoven_access_provisioner','pactwoven_mandate_writer','pactwoven_finance_observer',CASE cap WHEN 'writer' THEN 'pactwoven_custody_setup_verifier' ELSE 'pactwoven_custody_setup_writer' END))
 AND NOT EXISTS(SELECT 1 FROM reachable x JOIN pg_database d ON d.datdba=x.oid WHERE d.datname=current_database())
 AND NOT EXISTS(SELECT 1 FROM reachable x WHERE pg_has_role(x.oid,'pg_database_owner','USAGE') OR has_database_privilege(x.oid,current_database(),'CREATE') OR has_schema_privilege(x.oid,'pactwoven','CREATE') OR has_schema_privilege(x.oid,'public','CREATE'))
 AND NOT EXISTS(SELECT 1 FROM reachable x CROSS JOIN pg_namespace n WHERE n.nspname IN('pactwoven','public') AND(n.nspowner=x.oid OR pg_has_role(x.oid,n.nspowner,'USAGE')))
 AND NOT EXISTS(SELECT 1 FROM reachable x CROSS JOIN relations t WHERE t.relowner=x.oid OR(t.relkind='S' AND has_sequence_privilege(x.oid,t.oid,'USAGE,SELECT,UPDATE')) OR
  (t.relkind<>'S' AND(has_table_privilege(x.oid,t.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') OR has_any_column_privilege(x.oid,t.oid,'SELECT,INSERT,UPDATE,REFERENCES'))))
 AND NOT EXISTS(SELECT 1 FROM reachable x CROSS JOIN routines f WHERE f.proowner=x.oid OR(has_function_privilege(x.oid,f.oid,'EXECUTE') AND f.oid NOT IN(SELECT oid FROM expected WHERE oid IS NOT NULL)))
 AND NOT EXISTS(SELECT 1 FROM expected e LEFT JOIN routines f ON f.oid=e.oid WHERE f.oid IS NULL OR NOT f.prosecdef OR f.proowner<>(SELECT nspowner FROM pg_namespace WHERE nspname='pactwoven') OR
  NOT(coalesce(f.proconfig,ARRAY[]::text[]) @> ARRAY['search_path=pg_catalog']) OR NOT has_function_privilege(who,f.oid,'EXECUTE'))
$$;
CREATE FUNCTION pactwoven.custody_private_read_principal(o text,cap text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE who oid;BEGIN who:=pactwoven.custody_principal(o,cap);
 IF NOT coalesce(pactwoven.custody_private_read_role_safe(who,cap),false) THEN RAISE EXCEPTION USING ERRCODE='CS001',MESSAGE='Exact function-only private read principal required';END IF;
END $$;
CREATE FUNCTION pactwoven.custody_private_read_observation(v jsonb,at_time timestamptz) RETURNS void LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE observed timestamptz;member_observed timestamptz;issued timestamptz;expires timestamptz;BEGIN
 IF NOT coalesce(pactwoven.custody_matches(v,pactwoven.custody_private_read_schema('observation')),false) THEN RAISE EXCEPTION USING ERRCODE='CS004',MESSAGE='Strict private observation required';END IF;
 observed:=(v#>>'{observation,observedAt}')::timestamptz;member_observed:=(v#>>'{identity,membershipObservedAt}')::timestamptz;issued:=(v#>>'{observation,tokenIssuedAt}')::timestamptz;expires:=(v#>>'{observation,expiresAt}')::timestamptz;
 IF observed>at_time OR member_observed>at_time OR (v#>>'{identity,authenticatedAt}')::timestamptz>at_time OR least(observed,member_observed)<at_time-interval '20 seconds'
  OR issued>least(observed,member_observed) OR expires<=at_time THEN RAISE EXCEPTION USING ERRCODE='CS001',MESSAGE='Current nonfuture private observation required';END IF;
END $$;
CREATE FUNCTION pactwoven.custody_setup_resolve_owner(v jsonb,rid text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='3s' AS $$
DECLARE o pactwoven.organizations%ROWTYPE;m pactwoven.memberships%ROWTYPE;r pactwoven.responsibilities%ROWTYPE;BEGIN
 PERFORM pactwoven.financial_require_read_committed();PERFORM pactwoven.custody_private_read_observation(v,clock_timestamp());
 IF NOT coalesce(pactwoven.custody_matches(to_jsonb(rid),pactwoven.custody_private_read_schema('id')),false) THEN RAISE EXCEPTION USING ERRCODE='CS004',MESSAGE='Exact responsibility required';END IF;
 SELECT * INTO o FROM pactwoven.organizations WHERE environment='development' AND external_organization_id=v#>>'{identity,externalOrganizationId}' FOR UPDATE;
 IF o.id IS NULL THEN RAISE EXCEPTION USING ERRCODE='CS001',MESSAGE='Current owner scope required';END IF;
 LOCK TABLE pactwoven.session_revocations IN SHARE MODE;
 PERFORM actor_id FROM pactwoven.memberships WHERE environment='development' AND organization_id=o.id ORDER BY actor_id FOR SHARE;
 SELECT * INTO m FROM pactwoven.memberships WHERE environment='development' AND organization_id=o.id AND external_subject=v#>>'{identity,subject}' AND external_membership_id=v#>>'{identity,externalMembershipId}';
 IF o.status IS DISTINCT FROM 'active' OR m.status IS DISTINCT FROM 'active' OR NOT('owner'=ANY(m.roles)) OR(m.expires_at IS NOT NULL AND m.expires_at<=clock_timestamp())
  OR(m.grant_basis='clerk_admin_bootstrap' AND v#>>'{identity,externalRole}' IS DISTINCT FROM 'org:admin')
  OR EXISTS(SELECT 1 FROM pactwoven.session_revocations WHERE environment='development' AND session_id=v#>>'{identity,sessionId}') THEN RAISE EXCEPTION USING ERRCODE='CS001',MESSAGE='Current owner scope required';END IF;
 SELECT * INTO r FROM pactwoven.responsibilities WHERE environment='development' AND organization_id=o.id AND id=rid FOR SHARE;
 PERFORM id FROM pactwoven.sites WHERE environment='development' AND organization_id=o.id ORDER BY id FOR SHARE;
 IF r.id IS NULL OR NOT EXISTS(SELECT 1 FROM pactwoven.site_memberships WHERE environment='development' AND organization_id=o.id AND actor_id=m.actor_id AND site_id=r.site_id)
  OR NOT EXISTS(SELECT 1 FROM pactwoven.member_action_sites WHERE environment='development' AND organization_id=o.id AND actor_id=m.actor_id AND site_id=r.site_id) THEN RAISE EXCEPTION USING ERRCODE='CS001',MESSAGE='Exact owner read and action sites required';END IF;
 PERFORM responsibility_id FROM pactwoven.financial_authority_fences WHERE environment='development' AND organization_id=o.id AND responsibility_id=rid FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='CS002',MESSAGE='Canonical scope unavailable';END IF;
 PERFORM pactwoven.custody_private_read_observation(v,clock_timestamp());
 IF m.expires_at IS NOT NULL AND m.expires_at<=clock_timestamp() THEN RAISE EXCEPTION USING ERRCODE='CS001',MESSAGE='Owner expired while waiting';END IF;
 PERFORM pactwoven.custody_private_read_principal(o.id,'verifier');
 RETURN jsonb_build_object('environment','development','organizationId',o.id,'externalOrganizationId',o.external_organization_id,'responsibilityId',rid,
  'owner',jsonb_build_object('actorId',m.actor_id,'membershipVersion',m.row_version,'subject',m.external_subject,'externalMembershipId',m.external_membership_id,'sessionId',v#>>'{identity,sessionId}'));
END $$;
CREATE FUNCTION pactwoven.custody_private_read_finish(c jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE evidence pactwoven.custody_setup_evidence%ROWTYPE;p record;at_time timestamptz:=clock_timestamp();BEGIN
 IF(c#>>'{identity,observedAt}')::timestamptz>at_time OR(c#>>'{identity,observedAt}')::timestamptz<at_time-interval '20 seconds' OR(c#>>'{identity,expiresAt}')::timestamptz<=at_time
  OR EXISTS(SELECT 1 FROM pactwoven.memberships WHERE environment='development' AND organization_id=c->>'organizationId' AND actor_id=c->>'actorId' AND expires_at<=at_time) THEN RAISE EXCEPTION USING ERRCODE='CS001',MESSAGE='Read identity expired while waiting';END IF;
 PERFORM pactwoven.custody_private_read_principal(c->>'organizationId','writer');
 SELECT * INTO evidence FROM pactwoven.custody_setup_evidence WHERE id=(c#>>'{identity,id}')::uuid AND kind='identity';
 IF evidence.id IS NULL OR NOT pactwoven.custody_evidence_current(evidence.id,c->>'organizationId') OR NOT coalesce(pactwoven.custody_private_read_role_safe(evidence.principal_oid,'verifier'),false) THEN RAISE EXCEPTION USING ERRCODE='CS001',MESSAGE='Current identity verifier binding required';END IF;
END $$;

-- Validate stored reciprocal rows and references without requalifying or renewing historical proofs.
CREATE FUNCTION pactwoven.custody_private_read_operation(opid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE op pactwoven.custody_setup_operations%ROWTYPE;r pactwoven.custody_setup_records%ROWTYPE;anchor pactwoven.custody_setup_anchors%ROWTYPE;
 d pactwoven.custody_setup_records%ROWTYPE;ch pactwoven.custody_setup_records%ROWTYPE;cf pactwoven.custody_setup_records%ROWTYPE;prep pactwoven.custody_setup_operations%ROWTYPE;
 w pactwoven.custody_setup_evidence%ROWTYPE;mf pactwoven.custody_setup_evidence%ROWTYPE;identity_row pactwoven.custody_setup_evidence%ROWTYPE;
 ctrl pactwoven.custody_setup_controls%ROWTYPE;prev pactwoven.custody_setup_controls%ROWTYPE;s jsonb;expected_kind text;BEGIN
 SELECT * INTO op FROM pactwoven.custody_setup_operations WHERE id=opid;
 SELECT * INTO r FROM pactwoven.custody_setup_records WHERE operation_id=opid;
 SELECT * INTO anchor FROM pactwoven.custody_setup_anchors WHERE id=r.setup_id;
 expected_kind:=CASE op.kind WHEN 'prepare' THEN 'draft' WHEN 'challenge' THEN 'wallet_challenge' WHEN 'confirmation' THEN 'confirmation' WHEN 'confirm' THEN 'owner_binding' WHEN 'cancel' THEN 'cancellation' END;
 IF op.id IS NULL OR r.id IS NULL OR anchor.id IS NULL OR expected_kind IS NULL OR r.kind IS DISTINCT FROM expected_kind OR anchor.organization_id IS DISTINCT FROM op.organization_id OR anchor.responsibility_id IS DISTINCT FROM op.responsibility_id
  OR r.body->>'organizationId' IS DISTINCT FROM op.organization_id OR r.body->>'actorId' IS DISTINCT FROM op.actor_id OR r.body->>'responsibilityId' IS DISTINCT FROM op.responsibility_id
  OR NOT coalesce(pactwoven.custody_matches(op.command,pactwoven.custody_schema('command')),false) OR NOT coalesce(pactwoven.custody_matches(r.body,pactwoven.custody_schema('record')),false)
  OR op.command->>'key' IS DISTINCT FROM op.key OR op.command->>'kind' IS DISTINCT FROM op.kind OR op.command->>'responsibilityId' IS DISTINCT FROM op.responsibility_id
  OR op.command_hash IS DISTINCT FROM pactwoven.custody_command_hash(op.organization_id,op.actor_id,op.command)
  OR op.result IS DISTINCT FROM jsonb_build_object('schemaVersion',1,'id',op.id,'organizationId',op.organization_id,'actorId',op.actor_id,'responsibilityId',op.responsibility_id,'kind',op.kind,'key',op.key,'commandHash',op.command_hash,
   'setupId',r.setup_id,'target',pactwoven.custody_ref(r.body,r.hash),'body',r.body,'financialState',NULL)
  OR NOT EXISTS(SELECT 1 FROM pactwoven.custody_setup_audit WHERE operation_id=opid AND body=op.result-'body') OR NOT EXISTS(SELECT 1 FROM pactwoven.custody_setup_outbox WHERE operation_id=opid AND body=op.result-'body') THEN RAISE EXCEPTION USING ERRCODE='CS007',MESSAGE='Exact immutable original operation required';END IF;
 IF op.kind='prepare' THEN
  d:=r;
  IF r.body->>'prepareOperationId' IS DISTINCT FROM opid::text OR r.body->'predecessor' IS DISTINCT FROM op.command->'previousDraft' OR r.body->'specification' IS DISTINCT FROM op.command->'reviewedSpecificationRef'
   OR r.version IS DISTINCT FROM coalesce((op.command#>>'{previousDraft,version}')::int+1,1) THEN RAISE EXCEPTION USING ERRCODE='CS007',MESSAGE='Exact original draft required';END IF;
 ELSE
  SELECT * INTO d FROM pactwoven.custody_setup_records WHERE id=(r.body#>>'{draft,id}')::uuid AND kind='draft';
  IF d.id IS NULL OR d.setup_id IS DISTINCT FROM r.setup_id OR r.version IS DISTINCT FROM d.version OR d.body->>'actorId' IS DISTINCT FROM op.actor_id OR op.command->>'setupId' IS DISTINCT FROM r.setup_id::text
   OR r.body->'draft' IS DISTINCT FROM pactwoven.custody_ref(d.body,d.hash) OR d.version IS DISTINCT FROM(op.command->>'expectedSetupVersion')::int OR d.hash IS DISTINCT FROM op.command->>'expectedSetupHash' THEN RAISE EXCEPTION USING ERRCODE='CS007',MESSAGE='Exact original draft reference required';END IF;
 END IF;
 SELECT body INTO s FROM pactwoven.custody_setup_specifications WHERE id=d.body#>>'{specification,id}' AND version=(d.body#>>'{specification,version}')::int;
 IF s IS NULL OR NOT pactwoven.custody_spec_valid(s) OR d.body->'specification' IS DISTINCT FROM pactwoven.custody_ref(s,pactwoven.custody_hash('specification',s))
  OR s#>>'{organization,id}' IS DISTINCT FROM op.organization_id OR s#>>'{responsibility,id}' IS DISTINCT FROM op.responsibility_id OR s#>>'{owner,actorId}' IS DISTINCT FROM op.actor_id
  OR anchor.asset_key IS DISTINCT FROM s#>>'{asset,key}' OR anchor.setup_operation_key IS DISTINCT FROM s->>'setupOperationKey'
  OR NOT EXISTS(SELECT 1 FROM pactwoven.custody_setup_specification_controls WHERE specification_id=s->>'id' AND generation=(d.body->>'specificationControlGeneration')::int AND version=(s->>'version')::int AND active) THEN RAISE EXCEPTION USING ERRCODE='CS007',MESSAGE='Exact historical specification required';END IF;
 IF op.kind='prepare' AND(s->>'ownerWalletPublicKey' IS DISTINCT FROM op.command->>'ownerWalletPublicKey' OR op.command->'expectedScope' IS DISTINCT FROM jsonb_build_object(
  'responsibilityVersion',s#>'{responsibility,version}','responsibilityHash',s#>'{responsibility,hash}','siteGeneration',s#>'{site,generation}','siteRecordHash',s#>'{site,recordHash}','canonicalGeneration',s#>'{authority,snapshot,generation}','canonicalHash',s#>'{authority,recordHash}')) THEN RAISE EXCEPTION USING ERRCODE='CS007',MESSAGE='Exact original reviewed terms required';END IF;
 IF op.kind<>'prepare' THEN PERFORM pactwoven.custody_private_read_operation(d.operation_id);END IF;
 IF op.kind='challenge' THEN
  IF r.body->'specification' IS DISTINCT FROM d.body->'specification' OR r.body->'owner' IS DISTINCT FROM s->'owner' OR r.body->>'wallet' IS DISTINCT FROM s->>'ownerWalletPublicKey'
   OR r.body->'organizationRegistrationUuid' IS DISTINCT FROM s#>'{organization,registrationUuid}' OR r.body->'responsibilityRegistrationUuid' IS DISTINCT FROM s#>'{responsibility,registrationUuid}' OR r.body->'setupOperationKey' IS DISTINCT FROM s->'setupOperationKey' THEN RAISE EXCEPTION USING ERRCODE='CS007',MESSAGE='Exact original wallet challenge required';END IF;
 ELSIF op.kind IN('confirmation','confirm') THEN
  IF op.kind='confirmation' THEN cf:=r;ELSE SELECT * INTO cf FROM pactwoven.custody_setup_records WHERE id=(op.command->>'confirmationId')::uuid AND kind='confirmation';END IF;
  SELECT * INTO ch FROM pactwoven.custody_setup_records WHERE id=(cf.body#>>'{intent,challenge,id}')::uuid AND kind='wallet_challenge';
  SELECT * INTO w FROM pactwoven.custody_setup_evidence WHERE id=(cf.body#>>'{walletEvidence,id}')::uuid AND kind='wallet';
  IF cf.id IS NULL OR ch.id IS NULL OR w.id IS NULL OR cf.setup_id IS DISTINCT FROM r.setup_id OR ch.setup_id IS DISTINCT FROM r.setup_id
   OR cf.body->'draft' IS DISTINCT FROM pactwoven.custody_ref(d.body,d.hash) OR ch.body->'draft' IS DISTINCT FROM cf.body->'draft'
   OR cf.body#>'{intent,challenge}' IS DISTINCT FROM pactwoven.custody_ref(ch.body,ch.hash) OR cf.body#>'{intent,specification}' IS DISTINCT FROM d.body->'specification'
   OR cf.body#>'{intent,owner}' IS DISTINCT FROM s->'owner' OR cf.body#>>'{intent,organizationId}' IS DISTINCT FROM op.organization_id OR cf.body#>>'{intent,responsibilityId}' IS DISTINCT FROM op.responsibility_id OR cf.body#>>'{intent,setupId}' IS DISTINCT FROM r.setup_id::text
   OR cf.body->>'intentHash' IS DISTINCT FROM pactwoven.finance_hash(cf.body->'intent') OR cf.body->>'requestHash' IS DISTINCT FROM pactwoven.finance_hash(jsonb_build_object('schemaVersion',1,'purpose','custody_setup_owner_binding','request',jsonb_build_object('nonce',cf.body#>'{intent,nonce}','key',cf.body#>'{intent,key}','intent',cf.body->'intent')))
   OR cf.body->'walletEvidence' IS DISTINCT FROM jsonb_build_object('id',w.id,'version',1,'recordHash',w.hash) OR w.organization_id IS DISTINCT FROM op.organization_id OR w.body->'owner' IS DISTINCT FROM s->'owner'
   OR w.body->>'setupId' IS DISTINCT FROM r.setup_id::text OR w.body->'challenge' IS DISTINCT FROM pactwoven.custody_ref(ch.body,ch.hash) OR w.body->>'signatureHash' IS DISTINCT FROM cf.body#>>'{intent,signatureHash}' THEN RAISE EXCEPTION USING ERRCODE='CS007',MESSAGE='Exact historical wallet and confirmation proof required';END IF;
  PERFORM pactwoven.custody_private_read_operation(ch.operation_id);
  IF op.kind='confirmation' THEN
   IF w.id::text IS DISTINCT FROM op.command->>'walletEvidenceId' OR ch.id::text IS DISTINCT FROM op.command->>'challengeId' OR ch.hash IS DISTINCT FROM op.command->>'challengeHash' OR cf.body#>>'{intent,key}' IS DISTINCT FROM op.command->>'confirmationKey' THEN RAISE EXCEPTION USING ERRCODE='CS007',MESSAGE='Exact original confirmation command required';END IF;
  ELSE
   SELECT * INTO mf FROM pactwoven.custody_setup_evidence WHERE id=(op.command->>'mfaEvidenceId')::uuid AND kind='mfa';
   SELECT * INTO identity_row FROM pactwoven.custody_setup_evidence WHERE id=(r.body#>>'{identityEvidence,id}')::uuid AND kind='identity';
   SELECT * INTO prep FROM pactwoven.custody_setup_operations WHERE id=(d.body->>'prepareOperationId')::uuid AND kind='prepare';
   IF mf.id IS NULL OR identity_row.id IS NULL OR prep.id IS NULL OR r.body->'confirmation' IS DISTINCT FROM pactwoven.custody_ref(cf.body,cf.hash)
    OR r.body->'challenge' IS DISTINCT FROM pactwoven.custody_ref(ch.body,ch.hash) OR r.body->'walletEvidence' IS DISTINCT FROM cf.body->'walletEvidence'
    OR r.body->'mfaEvidence' IS DISTINCT FROM jsonb_build_object('id',mf.id,'version',1,'recordHash',mf.hash) OR r.body->'identityEvidence' IS DISTINCT FROM jsonb_build_object('id',identity_row.id,'version',1,'recordHash',identity_row.hash)
    OR mf.organization_id IS DISTINCT FROM op.organization_id OR identity_row.organization_id IS DISTINCT FROM op.organization_id OR mf.body->'owner' IS DISTINCT FROM s->'owner' OR identity_row.body->'owner' IS DISTINCT FROM s->'owner'
    OR mf.body->>'confirmationId' IS DISTINCT FROM cf.id::text OR mf.body->>'intentHash' IS DISTINCT FROM cf.body->>'intentHash' OR mf.body->>'requestHash' IS DISTINCT FROM cf.body->>'requestHash'
    OR mf.body->>'key' IS DISTINCT FROM op.key OR mf.body->>'nonce' IS DISTINCT FROM op.command->>'confirmationNonce' OR cf.body#>>'{intent,key}' IS DISTINCT FROM op.key OR cf.body#>>'{intent,nonce}' IS DISTINCT FROM op.command->>'confirmationNonce'
    OR r.body->>'signatureHash' IS DISTINCT FROM w.body->>'signatureHash' OR r.body->'specification' IS DISTINCT FROM s OR r.body->'specificationRef' IS DISTINCT FROM d.body->'specification' OR r.body->'specificationControlGeneration' IS DISTINCT FROM d.body->'specificationControlGeneration'
    OR r.body->'prepareOperation' IS DISTINCT FROM jsonb_build_object('id',prep.id,'key',prep.key,'commandHash',prep.command_hash)
    OR r.body->'confirmOperation' IS DISTINCT FROM jsonb_build_object('id',op.id,'key',op.key,'commandHash',op.command_hash)
    OR (SELECT count(*) FROM pactwoven.custody_setup_evidence_uses WHERE operation_id=opid)<>2
    OR NOT EXISTS(SELECT 1 FROM pactwoven.custody_setup_evidence_uses WHERE operation_id=opid AND evidence_id=w.id) OR NOT EXISTS(SELECT 1 FROM pactwoven.custody_setup_evidence_uses WHERE operation_id=opid AND evidence_id=mf.id) THEN RAISE EXCEPTION USING ERRCODE='CS007',MESSAGE='Exact historical owner binding required';END IF;
   PERFORM pactwoven.custody_private_read_operation(cf.operation_id);PERFORM pactwoven.custody_private_read_operation(prep.id);
  END IF;
 END IF;
 SELECT * INTO ctrl FROM pactwoven.custody_setup_controls WHERE operation_id=opid;
 IF op.kind IN('prepare','confirm','cancel') THEN
  SELECT * INTO prev FROM pactwoven.custody_setup_controls WHERE setup_id=r.setup_id AND generation=ctrl.generation-1;
  IF ctrl.operation_id IS NULL OR ctrl.setup_id IS DISTINCT FROM r.setup_id OR ctrl.draft_id IS DISTINCT FROM d.id OR ctrl.state IS DISTINCT FROM (CASE op.kind WHEN 'prepare' THEN 'pending' WHEN 'confirm' THEN 'confirmed' ELSE 'cancelled' END)
   OR(ctrl.generation=0 AND(op.kind<>'prepare' OR r.version<>1)) OR(ctrl.generation>0 AND prev.operation_id IS NULL)
   OR(op.kind='prepare' AND((ctrl.generation=0 AND r.body->'predecessor'<>'null'::jsonb) OR(ctrl.generation>0 AND r.body->'predecessor' IS DISTINCT FROM(SELECT pactwoven.custody_ref(body,hash) FROM pactwoven.custody_setup_records WHERE id=prev.draft_id AND kind='draft'))))
   OR(op.kind<>'prepare' AND(ctrl.draft_id IS DISTINCT FROM prev.draft_id OR(r.body->>'controlGeneration')::int IS DISTINCT FROM ctrl.generation))
   OR(op.kind='confirm' AND prev.state IS DISTINCT FROM 'pending')
   OR(op.kind='cancel' AND(prev.state='cancelled' OR(op.command->>'expectedSetupControlGeneration')::int IS DISTINCT FROM prev.generation OR(r.body->>'previousControlGeneration')::int IS DISTINCT FROM prev.generation OR ctrl.generation<>prev.generation+1)) THEN RAISE EXCEPTION USING ERRCODE='CS007',MESSAGE='Exact historical control transition required';END IF;
 ELSIF ctrl.operation_id IS NOT NULL THEN RAISE EXCEPTION USING ERRCODE='CS007',MESSAGE='Proof preparation cannot change control';END IF;
 RETURN jsonb_build_object('command',op.command,'result',op.result);
END $$;

CREATE FUNCTION pactwoven.custody_setup_specification_read(eid uuid,rid text,ref jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='3s' AS $$
DECLARE c jsonb;s jsonb;BEGIN
 IF NOT coalesce(pactwoven.custody_matches(to_jsonb(rid),pactwoven.custody_private_read_schema('id')),false) OR NOT coalesce(pactwoven.custody_matches(ref,pactwoven.custody_private_read_schema('reference')),false) THEN RAISE EXCEPTION USING ERRCODE='CS004',MESSAGE='Exact private specification reference required';END IF;
 c:=pactwoven.custody_context(eid,rid,'writer');PERFORM pactwoven.custody_private_read_finish(c);
 SELECT body INTO s FROM pactwoven.custody_setup_specifications WHERE id=ref->>'id' AND version=(ref->>'version')::int;
 IF s IS NOT NULL AND(s#>>'{organization,id}' IS DISTINCT FROM c->>'organizationId' OR s#>>'{responsibility,id}' IS DISTINCT FROM rid OR s#>>'{owner,actorId}' IS DISTINCT FROM c->>'actorId') THEN RAISE EXCEPTION USING ERRCODE='CS001',MESSAGE='Original scoped specification required';END IF;
 IF s IS NOT NULL AND(NOT pactwoven.custody_spec_valid(s) OR pactwoven.custody_ref(s,pactwoven.custody_hash('specification',s)) IS DISTINCT FROM ref) THEN RAISE EXCEPTION USING ERRCODE='CS002',MESSAGE='Exact historical specification reference required';END IF;
 PERFORM pactwoven.custody_private_read_finish(c);RETURN s;
END $$;
CREATE FUNCTION pactwoven.custody_setup_record_read(eid uuid,rid text,sid uuid,record_id uuid,record_kind text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='3s' AS $$
DECLARE c jsonb;r pactwoven.custody_setup_records%ROWTYPE;BEGIN
 IF NOT coalesce(pactwoven.custody_matches(to_jsonb(rid),pactwoven.custody_private_read_schema('id')),false) OR record_kind IS NULL OR record_kind NOT IN('wallet_challenge','confirmation') OR sid IS NULL OR record_id IS NULL OR sid='00000000-0000-0000-0000-000000000000'::uuid OR record_id='00000000-0000-0000-0000-000000000000'::uuid THEN RAISE EXCEPTION USING ERRCODE='CS004',MESSAGE='Exact private record identity required';END IF;
 c:=pactwoven.custody_context(eid,rid,'writer');PERFORM pactwoven.custody_private_read_finish(c);
 SELECT * INTO r FROM pactwoven.custody_setup_records WHERE id=record_id;
 IF r.id IS NOT NULL AND(r.setup_id IS DISTINCT FROM sid OR r.kind IS DISTINCT FROM record_kind OR r.body->>'organizationId' IS DISTINCT FROM c->>'organizationId' OR r.body->>'responsibilityId' IS DISTINCT FROM rid OR r.body->>'actorId' IS DISTINCT FROM c->>'actorId') THEN RAISE EXCEPTION USING ERRCODE='CS001',MESSAGE='Original scoped record required';END IF;
 IF r.id IS NOT NULL THEN PERFORM pactwoven.custody_private_read_operation(r.operation_id);END IF;
 PERFORM pactwoven.custody_private_read_finish(c);IF r.id IS NULL THEN RETURN NULL;END IF;RETURN jsonb_build_object('record',r.body,'reference',pactwoven.custody_ref(r.body,r.hash));
END $$;
CREATE FUNCTION pactwoven.custody_setup_original_read(eid uuid,rid text,operation_kind text,operation_key text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='3s' AS $$
DECLARE c jsonb;op pactwoven.custody_setup_operations%ROWTYPE;value jsonb;BEGIN
 IF NOT coalesce(pactwoven.custody_matches(to_jsonb(rid),pactwoven.custody_private_read_schema('id')),false) OR operation_kind IS NULL OR operation_kind NOT IN('prepare','challenge','confirmation','confirm','cancel')
  OR operation_key IS NULL OR length(operation_key) NOT BETWEEN 16 AND 128 OR operation_key!~'^[A-Za-z0-9_-]+$' THEN RAISE EXCEPTION USING ERRCODE='CS004',MESSAGE='Exact original operation key required';END IF;
 c:=pactwoven.custody_context(eid,rid,'writer');PERFORM pactwoven.custody_private_read_finish(c);
 SELECT * INTO op FROM pactwoven.custody_setup_operations WHERE organization_id=c->>'organizationId' AND actor_id=c->>'actorId' AND kind=operation_kind AND key=operation_key;
 IF op.id IS NOT NULL THEN
  IF op.responsibility_id IS DISTINCT FROM rid THEN RAISE EXCEPTION USING ERRCODE='CS001',MESSAGE='Original scoped operation required';END IF;
  value:=pactwoven.custody_private_read_operation(op.id);
 END IF;
 PERFORM pactwoven.custody_private_read_finish(c);RETURN value;
END $$;

REVOKE ALL ON FUNCTION pactwoven.custody_system_privileges_safe(oid),pactwoven.custody_private_read_schema(text),pactwoven.custody_private_read_role_safe(oid,text),pactwoven.custody_private_read_principal(text,text),pactwoven.custody_private_read_observation(jsonb,timestamptz),pactwoven.custody_private_read_finish(jsonb),pactwoven.custody_private_read_operation(uuid),
 pactwoven.custody_setup_resolve_owner(jsonb,text),pactwoven.custody_setup_specification_read(uuid,text,jsonb),pactwoven.custody_setup_record_read(uuid,text,uuid,uuid,text),pactwoven.custody_setup_original_read(uuid,text,text,text)
 FROM PUBLIC,pactwoven_runtime,pactwoven_provisioner,pactwoven_access_provisioner,pactwoven_mandate_writer,pactwoven_finance_observer,pactwoven_custody_setup_writer,pactwoven_custody_setup_verifier;
GRANT EXECUTE ON FUNCTION pactwoven.custody_setup_resolve_owner(jsonb,text) TO pactwoven_custody_setup_verifier;
GRANT EXECUTE ON FUNCTION pactwoven.custody_setup_specification_read(uuid,text,jsonb),pactwoven.custody_setup_record_read(uuid,text,uuid,uuid,text),pactwoven.custody_setup_original_read(uuid,text,text,text) TO pactwoven_custody_setup_writer;
COMMIT;
