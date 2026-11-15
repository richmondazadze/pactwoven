BEGIN;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pactwoven_provisioner') THEN
    CREATE ROLE pactwoven_provisioner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;
GRANT USAGE ON SCHEMA pactwoven TO pactwoven_provisioner;

-- Existing unpinned bindings deliberately remain unusable until verified by the
-- identity provisioning path; migration must not invent external membership IDs.
ALTER TABLE pactwoven.memberships ADD COLUMN external_membership_id text;
ALTER TABLE pactwoven.memberships ADD COLUMN grant_basis text NOT NULL DEFAULT 'internal'
  CHECK (grant_basis IN ('internal', 'clerk_admin_bootstrap'));
CREATE UNIQUE INDEX membership_external_identity_idx ON pactwoven.memberships(environment, external_membership_id)
  WHERE external_membership_id IS NOT NULL;

CREATE OR REPLACE FUNCTION pactwoven.can_read_site(target_environment text, target_organization text, target_site text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT pactwoven.has_membership(target_environment, target_organization)
    AND (
      pactwoven.has_role(ARRAY['owner','finance','auditor']::text[])
      OR EXISTS (
        SELECT 1 FROM pactwoven.site_memberships sm
        WHERE sm.environment = target_environment AND sm.organization_id = target_organization
          AND sm.site_id = target_site AND sm.actor_id = current_setting('pactwoven.actor_id', true)
      )
    )
$$;

CREATE OR REPLACE FUNCTION pactwoven.resolve_identity()
RETURNS TABLE(organization_id text, organization_name text, authority_epoch integer, actor_id text, roles text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT o.id, o.name, o.authority_epoch, m.actor_id, m.roles
  FROM pactwoven.organizations o JOIN pactwoven.memberships m ON (o.environment, o.id) = (m.environment, m.organization_id)
  WHERE o.environment = current_setting('pactwoven.environment', true)
    AND o.external_organization_id = current_setting('pactwoven.external_organization_id', true)
    AND m.external_subject = current_setting('pactwoven.external_subject', true)
    AND m.external_membership_id = current_setting('pactwoven.external_membership_id', true)
    AND (m.grant_basis <> 'clerk_admin_bootstrap' OR current_setting('pactwoven.external_role', true) = 'org:admin')
    AND m.status = 'active' AND o.status = 'active'
    AND (m.expires_at IS NULL OR m.expires_at > statement_timestamp())
    AND coalesce(current_setting('pactwoven.session_id', true), '') <> ''
    AND NOT EXISTS (SELECT 1 FROM pactwoven.session_revocations r
      WHERE r.environment = o.environment AND r.session_id = current_setting('pactwoven.session_id', true))
$$;

CREATE FUNCTION pactwoven.organization_setup_required() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT coalesce(current_setting('pactwoven.external_organization_id', true), '') <> ''
    AND coalesce(current_setting('pactwoven.external_membership_id', true), '') <> ''
    AND coalesce(current_setting('pactwoven.session_id', true), '') <> ''
    AND NOT EXISTS (SELECT 1 FROM pactwoven.organizations o
      WHERE o.environment = current_setting('pactwoven.environment', true)
        AND o.external_organization_id = current_setting('pactwoven.external_organization_id', true))
    AND NOT EXISTS (SELECT 1 FROM pactwoven.session_revocations r
      WHERE r.environment = current_setting('pactwoven.environment', true)
        AND r.session_id = current_setting('pactwoven.session_id', true))
$$;
REVOKE ALL ON FUNCTION pactwoven.organization_setup_required() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pactwoven.organization_setup_required() TO pactwoven_runtime;

-- This is the provisioner's only entry point. It has no table privileges and
-- cannot change an existing organization, member, grant, or site. The general
-- API runtime cannot execute it or assume the provisioner role.
CREATE FUNCTION pactwoven.bootstrap_organization(
  p_environment text, p_external_organization_id text, p_organization_name text,
  p_external_subject text, p_external_membership_id text, p_external_role text,
  p_session_id text, p_site_name text, p_time_zone text,
  p_idempotency_key text, p_command_hash text, p_correlation_id text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  existing_organization pactwoven.organizations%ROWTYPE;
  existing_member pactwoven.memberships%ROWTYPE;
  existing_operation pactwoven.operations%ROWTYPE;
  organization_id text;
  actor_id text;
  site_id text;
  operation_id text;
  event_id text;
  response jsonb;
  event_time timestamptz := statement_timestamp();
BEGIN
  IF p_environment IS NULL OR p_environment NOT IN ('simulation','development','staging','production')
    OR p_external_organization_id IS NULL OR p_external_organization_id !~ '^[A-Za-z0-9_-]{1,128}$'
    OR p_external_subject IS NULL OR p_external_subject !~ '^[A-Za-z0-9_-]{1,128}$'
    OR p_external_membership_id IS NULL OR p_external_membership_id !~ '^[A-Za-z0-9_-]{1,128}$'
    OR p_session_id IS NULL OR char_length(p_session_id) NOT BETWEEN 1 AND 256
    OR p_organization_name IS NULL OR char_length(btrim(p_organization_name)) NOT BETWEEN 1 AND 180
    OR p_site_name IS NULL OR char_length(btrim(p_site_name)) NOT BETWEEN 1 AND 180
    OR p_time_zone IS NULL OR NOT EXISTS (SELECT 1 FROM pg_timezone_names z WHERE z.name = p_time_zone)
    OR p_idempotency_key IS NULL OR p_idempotency_key !~ '^[A-Za-z0-9_-]{16,128}$'
    OR p_command_hash IS NULL OR p_command_hash !~ '^[a-f0-9]{64}$'
    OR p_correlation_id IS NULL OR char_length(p_correlation_id) NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION USING ERRCODE = 'PW004', MESSAGE = 'Invalid organization bootstrap input';
  END IF;
  IF p_external_role IS DISTINCT FROM 'org:admin' THEN
    RAISE EXCEPTION USING ERRCODE = 'PW001', MESSAGE = 'Organization bootstrap is not permitted';
  END IF;

  -- Serializes creation identity even before an organization row exists. Hash
  -- collisions only serialize unrelated requests; they cannot merge identities.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_environment || ':' || p_external_organization_id, 871106));
  IF EXISTS (SELECT 1 FROM pactwoven.session_revocations r WHERE r.environment = p_environment AND r.session_id = p_session_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'PW001', MESSAGE = 'Organization bootstrap is not permitted';
  END IF;
  SELECT * INTO existing_organization FROM pactwoven.organizations o
    WHERE o.environment = p_environment AND o.external_organization_id = p_external_organization_id FOR UPDATE;
  IF FOUND THEN
    SELECT * INTO existing_member FROM pactwoven.memberships m
      WHERE m.environment = p_environment AND m.organization_id = existing_organization.id
        AND m.external_subject = p_external_subject FOR SHARE;
    IF NOT FOUND OR existing_organization.status <> 'active' OR existing_member.status <> 'active'
      OR (existing_member.expires_at IS NOT NULL AND existing_member.expires_at <= clock_timestamp())
      OR existing_member.external_membership_id IS DISTINCT FROM p_external_membership_id
      OR existing_member.grant_basis <> 'clerk_admin_bootstrap' OR NOT ('owner' = ANY(existing_member.roles)) THEN
      RAISE EXCEPTION USING ERRCODE = 'PW001', MESSAGE = 'Organization bootstrap is not permitted';
    END IF;
    SELECT * INTO existing_operation FROM pactwoven.operations op
      WHERE op.environment = p_environment AND op.organization_id = existing_organization.id
        AND op.kind = 'organization.bootstrap' AND op.idempotency_key = p_idempotency_key;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'PW003', MESSAGE = 'Organization is already configured';
    END IF;
    IF existing_operation.command_hash <> p_command_hash OR existing_operation.actor_id <> existing_member.actor_id THEN
      RAISE EXCEPTION USING ERRCODE = 'PW002', MESSAGE = 'Idempotency key conflicts with the prior command';
    END IF;
    RETURN existing_operation.response;
  END IF;

  organization_id := gen_random_uuid()::text;
  actor_id := gen_random_uuid()::text;
  site_id := gen_random_uuid()::text;
  operation_id := gen_random_uuid()::text;
  event_id := gen_random_uuid()::text;
  response := jsonb_build_object('id', operation_id, 'environment', p_environment, 'status', 'succeeded',
    'aggregateId', organization_id, 'aggregateVersion', 1, 'financialState', NULL,
    'evidenceRefs', '[]'::jsonb, 'nextCheckAt', NULL, 'error', NULL);
  INSERT INTO pactwoven.organizations(environment,id,external_organization_id,name)
    VALUES (p_environment,organization_id,p_external_organization_id,btrim(p_organization_name));
  INSERT INTO pactwoven.memberships(environment,organization_id,actor_id,external_subject,external_membership_id,grant_basis,roles)
    VALUES (p_environment,organization_id,actor_id,p_external_subject,p_external_membership_id,'clerk_admin_bootstrap',ARRAY['owner']);
  INSERT INTO pactwoven.sites(environment,organization_id,id,name,time_zone)
    VALUES (p_environment,organization_id,site_id,btrim(p_site_name),p_time_zone);
  INSERT INTO pactwoven.operations(environment,organization_id,id,actor_id,kind,idempotency_key,command_hash,aggregate_id,response)
    VALUES (p_environment,organization_id,operation_id,actor_id,'organization.bootstrap',p_idempotency_key,p_command_hash,organization_id,response);
  INSERT INTO pactwoven.outbox_events(environment,organization_id,id,aggregate_id,aggregate_version,event_type,payload)
    VALUES (p_environment,organization_id,event_id,organization_id,1,'organization.bootstrapped',
      jsonb_build_object('eventId',event_id,'schemaVersion',1,'environment',p_environment,'organizationId',organization_id,
        'aggregateType','organization','aggregateId',organization_id,'aggregateVersion',1,'type','organization.bootstrapped',
        'source','identity-provisioner','sourceEventId',NULL,'occurredAt',event_time,'observedAt',event_time,
        'causationId',operation_id,'correlationId',p_correlation_id,
        'payload',jsonb_build_object('organizationId',organization_id,'actorId',actor_id,'initialSiteId',site_id,
          'externalMembershipId',p_external_membership_id,'grantBasis','clerk_admin_bootstrap')));
  RETURN response;
END
$$;
REVOKE ALL ON FUNCTION pactwoven.bootstrap_organization(text,text,text,text,text,text,text,text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pactwoven.bootstrap_organization(text,text,text,text,text,text,text,text,text,text,text,text) TO pactwoven_provisioner;

COMMIT;
