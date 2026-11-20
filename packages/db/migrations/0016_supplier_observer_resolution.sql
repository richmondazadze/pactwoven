BEGIN;

-- Re-enter only the administrative installation capability retained by 0015.
-- Runtime logins never receive role membership or schema CREATE rights.
DO $$ DECLARE legacy_owner oid; BEGIN
  SELECT r.oid INTO legacy_owner FROM pg_roles r WHERE r.rolname=current_user AND current_user=session_user;
  IF legacy_owner IS NULL OR (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='pactwoven' AND c.relname IN ('organizations','memberships','session_revocations')
      AND c.relowner=legacy_owner AND c.relkind='r' AND c.relrowsecurity
      AND (NOT c.relforcerowsecurity OR EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=legacy_owner AND (r.rolsuper OR r.rolbypassrls))))<>3
    OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('pactwoven.supplier_base_identity(jsonb,jsonb,jsonb)')
      AND proowner=legacy_owner AND prosecdef) THEN
    RAISE EXCEPTION 'Supplier observer requires the exact installed identity owner and effective RLS access';
  END IF;
  IF NOT (SELECT rolsuper FROM pg_roles WHERE oid=legacy_owner) THEN
    IF NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE roleid='pactwoven_supplier_executor'::regrole
      AND member=legacy_owner AND admin_option AND NOT inherit_option AND NOT set_option)
      OR EXISTS(SELECT 1 FROM pg_auth_members WHERE roleid='pactwoven_supplier_executor'::regrole
        AND member=legacy_owner AND (inherit_option OR set_option)) THEN
      RAISE EXCEPTION 'Supplier observer requires the retained administrative installation capability';
    END IF;
    EXECUTE format('GRANT pactwoven_supplier_executor TO %I WITH INHERIT TRUE',current_user);
    EXECUTE format('GRANT pactwoven_supplier_executor TO %I WITH SET TRUE',current_user);
    GRANT CREATE ON SCHEMA pactwoven TO pactwoven_supplier_executor;
  END IF;
END $$;

-- The only change to the 0015 role-safe body is the second verifier entry.
-- No runtime grant, login or binding enrollment is implied.
CREATE OR REPLACE FUNCTION pactwoven.supplier_role_safe(who oid,capability text) RETURNS boolean
LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$
  SELECT coalesce((SELECT r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreatedb
    AND NOT r.rolcreaterole AND NOT r.rolreplication AND NOT r.rolinherit AND r.rolconfig IS NULL
    AND NOT EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid OR m.roleid=r.oid)
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

-- AUTH-SQL-04 remains explicit: the legacy identity owner is administrative
-- and may have broad superuser/BYPASSRLS authority. NOLOGIN/FORCE RLS do not
-- confine that authority. This additional fixed reader has
-- three identity relations, bounded arguments and no dynamic SQL, DML, provider
-- calls, site lookup, business/support reads or row-to-JSON expansion. Only the
-- supplier executor can call it; a runtime verifier calls the wrapper below.
CREATE FUNCTION pactwoven.supplier_observer_identity(e text,target_organization text,v jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='3s' AS $$
DECLARE o record;m record;at_time timestamptz;BEGIN
  PERFORM pactwoven.supplier_read_committed();
  PERFORM pactwoven.supplier_require(e IN ('simulation','development','staging','production')
    AND pactwoven.supplier_id(to_jsonb(target_organization)) AND pactwoven.supplier_observation_current(v,clock_timestamp()));
  -- Lock order follows 0015: caller already holds registry and binding lineage,
  -- then exact organization, revocation table, exact membership. No provisioning.
  PERFORM org.id FROM pactwoven.organizations org WHERE org.environment=e AND org.id=target_organization
    AND org.external_organization_id=v->>'externalOrganizationId' FOR SHARE;
  PERFORM pactwoven.supplier_require(FOUND);
  LOCK TABLE pactwoven.session_revocations IN SHARE MODE;
  PERFORM member.actor_id FROM pactwoven.memberships member WHERE member.environment=e AND member.organization_id=target_organization
    AND member.external_subject=v->>'subject' AND member.external_membership_id=v->>'externalMembershipId' FOR SHARE;
  PERFORM pactwoven.supplier_require(FOUND);
  -- Separate READ COMMITTED statements after every lock wait observe the latest
  -- local versions. Held locks prevent a later local change until transaction end.
  SELECT org.id,org.environment,org.external_organization_id,org.status,org.created_at,org.row_version,org.authority_epoch
    INTO o FROM pactwoven.organizations org WHERE org.environment=e AND org.id=target_organization
      AND org.external_organization_id=v->>'externalOrganizationId';
  SELECT member.actor_id,member.external_subject,member.external_membership_id,member.status,member.roles,
    member.grant_basis,member.created_at,member.expires_at,member.row_version
    INTO m FROM pactwoven.memberships member WHERE member.environment=e AND member.organization_id=target_organization
      AND member.external_subject=v->>'subject' AND member.external_membership_id=v->>'externalMembershipId';
  at_time:=clock_timestamp();
  PERFORM pactwoven.supplier_require(pactwoven.supplier_observation_current(v,at_time)
    AND o.id IS NOT NULL AND o.status='active' AND o.created_at<=at_time
    AND m.actor_id IS NOT NULL AND m.status='active' AND m.created_at<=at_time
    AND (m.expires_at IS NULL OR m.expires_at>at_time)
    AND NOT('service'=ANY(m.roles)) AND m.roles && ARRAY['owner','supplier_admin']::text[]
    AND (m.grant_basis<>'clerk_admin_bootstrap' OR v->>'externalRole'='org:admin')
    AND NOT EXISTS(SELECT 1 FROM pactwoven.session_revocations r WHERE r.environment=e AND r.session_id=v->>'sessionId'));
  -- This stamp is identity resolution, never request/party/business authority.
  -- The existing recorder and authorizer independently recheck it under locks.
  RETURN jsonb_build_object('environment',e,'organizationId',o.id,'actorId',m.actor_id,'principalKind','human',
    'membershipId',m.actor_id,'membershipVersion',m.row_version,'organizationVersion',o.row_version,'organizationEpoch',o.authority_epoch,
    'subject',m.external_subject,'externalOrganizationId',o.external_organization_id,
    'externalMembershipId',m.external_membership_id,'sessionId',v->>'sessionId');
END $$;

CREATE FUNCTION pactwoven.supplier_resolve_observer(expected_binding jsonb,v jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='3s' AS $$
DECLARE b pactwoven.supplier_private_bindings;a jsonb;BEGIN
  PERFORM pactwoven.supplier_read_committed();
  PERFORM pactwoven.supplier_require(current_setting('role')='none'
    AND octet_length(convert_to(expected_binding::text,'UTF8'))<=16384
    AND octet_length(convert_to(v::text,'UTF8'))<=16384
    AND pactwoven.supplier_observation_current(v,clock_timestamp()));
  b:=pactwoven.supplier_current_binding('verifier');
  PERFORM pactwoven.supplier_require(b.body IS NOT DISTINCT FROM expected_binding
    AND pactwoven.supplier_time(v->'observedAt')>=b.valid_from AND pactwoven.supplier_time(v->'expiresAt')<=b.expires_at);
  a:=pactwoven.supplier_observer_identity(b.environment,b.effective_organization_id,v);
  -- Recheck actual login, both role allowlists, terminal binding and original
  -- observation after identity locks. Nothing renews an observation timestamp.
  b:=pactwoven.supplier_current_binding('verifier');
  PERFORM pactwoven.supplier_require(b.body IS NOT DISTINCT FROM expected_binding
    AND pactwoven.supplier_observation_current(v,clock_timestamp())
    AND pactwoven.supplier_time(v->'observedAt')>=b.valid_from AND pactwoven.supplier_time(v->'expiresAt')<=b.expires_at);
  RETURN a;
END $$;

-- Strip inherited default ACLs from exactly the two new routines. Preserve all
-- 0015 ownership/ACLs. Offline enrollment must separately grant only the wrapper
-- to an exact safe verifier LOGIN; it is deliberately absent from this migration.
DO $$ DECLARE legacy_owner oid;legacy_name text;fn record;grant_row record;BEGIN
  SELECT c.relowner,r.rolname INTO legacy_owner,legacy_name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_roles r ON r.oid=c.relowner WHERE n.nspname='pactwoven' AND c.relname='organizations' AND r.rolname=current_user;
  IF legacy_owner IS NULL OR (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='pactwoven' AND c.relname IN ('organizations','memberships','session_revocations') AND c.relowner=legacy_owner
      AND c.relkind='r' AND c.relrowsecurity AND (NOT c.relforcerowsecurity OR
        EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=legacy_owner AND (r.rolsuper OR r.rolbypassrls))))<>3
    OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='pactwoven.supplier_base_identity(jsonb,jsonb,jsonb)'::regprocedure
      AND proowner=legacy_owner AND prosecdef)
    OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='pactwoven.supplier_role_safe(oid,text)'::regprocedure
      AND proowner='pactwoven_supplier_executor'::regrole AND NOT prosecdef) THEN
    RAISE EXCEPTION 'Supplier observer requires the disclosed 0015 identity owner and executor split';
  END IF;
  FOR fn IN SELECT p.oid,p.proowner,p.proname,p.oid::regprocedure AS identity FROM pg_proc p
    WHERE p.oid IN ('pactwoven.supplier_observer_identity(text,text,jsonb)'::regprocedure,'pactwoven.supplier_resolve_observer(jsonb,jsonb)'::regprocedure) LOOP
    FOR grant_row IN SELECT DISTINCT a.grantee,r.rolname FROM pg_proc p
      CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a LEFT JOIN pg_roles r ON r.oid=a.grantee
      WHERE p.oid=fn.oid AND a.grantee<>p.proowner LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %s',fn.identity,CASE WHEN grant_row.grantee=0 THEN 'PUBLIC' ELSE quote_ident(grant_row.rolname) END);
    END LOOP;
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',fn.identity);
    IF fn.proname='supplier_observer_identity' THEN
      EXECUTE format('ALTER FUNCTION %s OWNER TO %I',fn.identity,legacy_name);
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pactwoven_supplier_executor',fn.identity);
    ELSE EXECUTE format('ALTER FUNCTION %s OWNER TO pactwoven_supplier_executor',fn.identity);END IF;
  END LOOP;
  -- Four dependencies are already granted by 0015; these are the only two
  -- additional pure/current-session validators used by the new fixed reader.
  EXECUTE format('GRANT EXECUTE ON FUNCTION pactwoven.supplier_observation_current(jsonb,timestamptz),
    pactwoven.supplier_read_committed() TO %I',legacy_name);
  IF NOT (SELECT rolsuper FROM pg_roles WHERE oid=legacy_owner) THEN
    REVOKE CREATE ON SCHEMA pactwoven FROM pactwoven_supplier_executor;
    EXECUTE format('REVOKE pactwoven_supplier_executor FROM %I GRANTED BY %I',legacy_name,legacy_name);
  END IF;
END $$;

COMMIT;
