BEGIN;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pactwoven_runtime') THEN
    CREATE ROLE pactwoven_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS pactwoven;
REVOKE ALL ON SCHEMA pactwoven FROM PUBLIC;
GRANT USAGE ON SCHEMA pactwoven TO pactwoven_runtime;

CREATE TABLE pactwoven.organizations (
  environment text NOT NULL CHECK (environment IN ('simulation', 'development', 'staging', 'production')),
  id text NOT NULL,
  external_organization_id text NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 180),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'closed')),
  authority_epoch integer NOT NULL DEFAULT 0 CHECK (authority_epoch >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (environment, id),
  UNIQUE (environment, external_organization_id)
);

CREATE TABLE pactwoven.memberships (
  environment text NOT NULL,
  organization_id text NOT NULL,
  actor_id text NOT NULL,
  external_subject text NOT NULL,
  roles text[] NOT NULL CHECK (cardinality(roles) > 0 AND roles <@ ARRAY['owner','operations','finance','receiver','supplier_admin','supplier_dispatcher','auditor','support','service']::text[]),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'revoked')),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (environment, organization_id, actor_id),
  UNIQUE (environment, organization_id, external_subject),
  FOREIGN KEY (environment, organization_id) REFERENCES pactwoven.organizations(environment, id)
);

CREATE TABLE pactwoven.sites (
  environment text NOT NULL,
  organization_id text NOT NULL,
  id text NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 180),
  time_zone text NOT NULL,
  PRIMARY KEY (environment, organization_id, id),
  FOREIGN KEY (environment, organization_id) REFERENCES pactwoven.organizations(environment, id)
);

CREATE TABLE pactwoven.site_memberships (
  environment text NOT NULL,
  organization_id text NOT NULL,
  actor_id text NOT NULL,
  site_id text NOT NULL,
  PRIMARY KEY (environment, organization_id, actor_id, site_id),
  FOREIGN KEY (environment, organization_id, actor_id) REFERENCES pactwoven.memberships(environment, organization_id, actor_id),
  FOREIGN KEY (environment, organization_id, site_id) REFERENCES pactwoven.sites(environment, organization_id, id)
);

CREATE TABLE pactwoven.session_revocations (
  environment text NOT NULL,
  session_id text NOT NULL,
  revoked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (environment, session_id)
);

CREATE TABLE pactwoven.responsibilities (
  environment text NOT NULL,
  organization_id text NOT NULL,
  id text NOT NULL,
  owner_id text NOT NULL,
  site_id text NOT NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 180),
  description text NOT NULL CHECK (char_length(description) <= 5000),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL CHECK (ends_at > starts_at),
  time_zone text NOT NULL,
  requirements jsonb NOT NULL CHECK (jsonb_typeof(requirements) = 'array' AND jsonb_array_length(requirements) <= 100),
  acceptance_policy text NOT NULL CHECK (char_length(acceptance_policy) <= 5000),
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  execution_state text NOT NULL DEFAULT 'DRAFT' CHECK (execution_state IN ('DRAFT','READY_FOR_AUTHORIZATION','ACTIVE','CLOSING','CLOSED')),
  authority_state text CHECK (authority_state IN ('ACTIVE','PAUSED','REVOKED','EXPIRED')),
  coverage_state text NOT NULL DEFAULT 'UNKNOWN' CHECK (coverage_state IN ('UNKNOWN','ASSESSING','PARTIAL','READY','DEGRADED','UNAVAILABLE','STALE')),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  PRIMARY KEY (environment, organization_id, id),
  FOREIGN KEY (environment, organization_id, owner_id) REFERENCES pactwoven.memberships(environment, organization_id, actor_id),
  FOREIGN KEY (environment, organization_id, site_id) REFERENCES pactwoven.sites(environment, organization_id, id)
);
CREATE INDEX responsibility_page_idx ON pactwoven.responsibilities(environment, organization_id, created_at DESC, id DESC);

CREATE TABLE pactwoven.responsibility_assignments (
  environment text NOT NULL,
  organization_id text NOT NULL,
  responsibility_id text NOT NULL,
  actor_id text NOT NULL,
  PRIMARY KEY (environment, organization_id, responsibility_id, actor_id),
  FOREIGN KEY (environment, organization_id, responsibility_id) REFERENCES pactwoven.responsibilities(environment, organization_id, id),
  FOREIGN KEY (environment, organization_id, actor_id) REFERENCES pactwoven.memberships(environment, organization_id, actor_id)
);

CREATE TABLE pactwoven.operations (
  environment text NOT NULL,
  organization_id text NOT NULL,
  id text NOT NULL,
  actor_id text NOT NULL,
  kind text NOT NULL,
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 16 AND 128),
  command_hash text NOT NULL CHECK (command_hash ~ '^[a-f0-9]{64}$'),
  aggregate_id text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (environment, organization_id, id),
  UNIQUE (environment, organization_id, kind, idempotency_key),
  FOREIGN KEY (environment, organization_id, actor_id) REFERENCES pactwoven.memberships(environment, organization_id, actor_id)
);

CREATE TABLE pactwoven.outbox_events (
  environment text NOT NULL,
  organization_id text NOT NULL,
  id text NOT NULL,
  aggregate_id text NOT NULL,
  aggregate_version integer NOT NULL CHECK (aggregate_version > 0),
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  PRIMARY KEY (environment, organization_id, id),
  FOREIGN KEY (environment, organization_id) REFERENCES pactwoven.organizations(environment, id)
);
CREATE INDEX outbox_pending_idx ON pactwoven.outbox_events(created_at) WHERE delivered_at IS NULL;

-- These helpers run as the migration/schema owner to avoid recursive membership
-- policies. The runtime role cannot replace them or read their backing rows directly.
CREATE FUNCTION pactwoven.has_membership(target_environment text, target_organization text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT target_environment = current_setting('pactwoven.environment', true)
    AND target_organization = current_setting('pactwoven.organization_id', true)
    AND coalesce(current_setting('pactwoven.session_id', true), '') <> ''
    AND EXISTS (
      SELECT 1 FROM pactwoven.memberships m
      JOIN pactwoven.organizations o ON (o.environment, o.id) = (m.environment, m.organization_id)
      WHERE m.environment = target_environment AND m.organization_id = target_organization
        AND m.actor_id = current_setting('pactwoven.actor_id', true)
        AND m.status = 'active' AND (m.expires_at IS NULL OR m.expires_at > statement_timestamp())
        AND o.status = 'active'
    )
    AND NOT EXISTS (
      SELECT 1 FROM pactwoven.session_revocations r
      WHERE r.environment = target_environment AND r.session_id = current_setting('pactwoven.session_id', true)
    )
$$;

CREATE FUNCTION pactwoven.has_role(allowed_roles text[]) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT EXISTS (
    SELECT 1 FROM pactwoven.memberships m
    WHERE m.environment = current_setting('pactwoven.environment', true)
      AND m.organization_id = current_setting('pactwoven.organization_id', true)
      AND m.actor_id = current_setting('pactwoven.actor_id', true)
      AND m.roles && allowed_roles
      AND pactwoven.has_membership(m.environment, m.organization_id)
  )
$$;

CREATE FUNCTION pactwoven.can_read_site(target_environment text, target_organization text, target_site text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT pactwoven.has_membership(target_environment, target_organization)
    AND (
      pactwoven.has_role(ARRAY['owner','finance','auditor','supplier_admin']::text[])
      OR EXISTS (
        SELECT 1 FROM pactwoven.site_memberships sm
        WHERE sm.environment = target_environment AND sm.organization_id = target_organization
          AND sm.site_id = target_site AND sm.actor_id = current_setting('pactwoven.actor_id', true)
      )
    )
$$;

CREATE FUNCTION pactwoven.can_read_responsibility(target_environment text, target_organization text, target_site text, target_responsibility text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT pactwoven.can_read_site(target_environment, target_organization, target_site)
    AND (
      pactwoven.has_role(ARRAY['owner','operations','finance','auditor']::text[])
      OR (pactwoven.has_role(ARRAY['receiver']::text[]) AND EXISTS (
        SELECT 1 FROM pactwoven.responsibility_assignments a
        WHERE a.environment = target_environment AND a.organization_id = target_organization
          AND a.responsibility_id = target_responsibility AND a.actor_id = current_setting('pactwoven.actor_id', true)
      ))
    )
$$;

CREATE FUNCTION pactwoven.resolve_identity()
RETURNS TABLE(organization_id text, organization_name text, authority_epoch integer, actor_id text, roles text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT o.id, o.name, o.authority_epoch, m.actor_id, m.roles
  FROM pactwoven.organizations o JOIN pactwoven.memberships m ON (o.environment, o.id) = (m.environment, m.organization_id)
  WHERE o.environment = current_setting('pactwoven.environment', true)
    AND o.external_organization_id = current_setting('pactwoven.external_organization_id', true)
    AND m.external_subject = current_setting('pactwoven.external_subject', true)
    AND m.status = 'active' AND o.status = 'active'
    AND (m.expires_at IS NULL OR m.expires_at > statement_timestamp())
    AND coalesce(current_setting('pactwoven.session_id', true), '') <> ''
    AND NOT EXISTS (SELECT 1 FROM pactwoven.session_revocations r
      WHERE r.environment = o.environment AND r.session_id = current_setting('pactwoven.session_id', true))
$$;

CREATE FUNCTION pactwoven.lock_actor()
RETURNS TABLE(roles text[]) LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT m.roles FROM pactwoven.memberships m
  JOIN pactwoven.organizations o ON (o.environment, o.id) = (m.environment, m.organization_id)
  WHERE m.environment = current_setting('pactwoven.environment', true)
    AND m.organization_id = current_setting('pactwoven.organization_id', true)
    AND m.actor_id = current_setting('pactwoven.actor_id', true)
    AND m.status = 'active' AND o.status = 'active'
    AND (m.expires_at IS NULL OR m.expires_at > statement_timestamp())
    AND pactwoven.has_membership(m.environment, m.organization_id)
  FOR SHARE OF m, o
$$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA pactwoven FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pactwoven.has_membership(text,text), pactwoven.has_role(text[]),
  pactwoven.can_read_site(text,text,text), pactwoven.can_read_responsibility(text,text,text,text),
  pactwoven.resolve_identity(), pactwoven.lock_actor() TO pactwoven_runtime;

ALTER TABLE pactwoven.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE pactwoven.memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE pactwoven.sites ENABLE ROW LEVEL SECURITY;
ALTER TABLE pactwoven.site_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE pactwoven.session_revocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE pactwoven.responsibilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE pactwoven.responsibility_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE pactwoven.operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE pactwoven.outbox_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY organization_read ON pactwoven.organizations FOR SELECT TO pactwoven_runtime
  USING (pactwoven.has_membership(environment, id));
CREATE POLICY membership_self_read ON pactwoven.memberships FOR SELECT TO pactwoven_runtime
  USING (actor_id = current_setting('pactwoven.actor_id', true) AND pactwoven.has_membership(environment, organization_id));
CREATE POLICY site_read ON pactwoven.sites FOR SELECT TO pactwoven_runtime
  USING (pactwoven.can_read_site(environment, organization_id, id));
CREATE POLICY site_membership_self_read ON pactwoven.site_memberships FOR SELECT TO pactwoven_runtime
  USING (actor_id = current_setting('pactwoven.actor_id', true) AND pactwoven.has_membership(environment, organization_id));
CREATE POLICY assignment_self_read ON pactwoven.responsibility_assignments FOR SELECT TO pactwoven_runtime
  USING (actor_id = current_setting('pactwoven.actor_id', true) AND pactwoven.has_membership(environment, organization_id));
CREATE POLICY responsibility_read ON pactwoven.responsibilities FOR SELECT TO pactwoven_runtime
  USING (pactwoven.can_read_responsibility(environment, organization_id, site_id, id));
CREATE POLICY responsibility_create ON pactwoven.responsibilities FOR INSERT TO pactwoven_runtime
  WITH CHECK (pactwoven.can_read_site(environment, organization_id, site_id)
    AND pactwoven.has_role(ARRAY['owner','operations']::text[])
    AND owner_id = current_setting('pactwoven.actor_id', true)
    AND execution_state = 'DRAFT' AND authority_state IS NULL AND coverage_state = 'UNKNOWN' AND row_version = 1);
CREATE POLICY operation_read ON pactwoven.operations FOR SELECT TO pactwoven_runtime
  USING (actor_id = current_setting('pactwoven.actor_id', true) AND pactwoven.has_membership(environment, organization_id));
CREATE POLICY operation_create ON pactwoven.operations FOR INSERT TO pactwoven_runtime
  WITH CHECK (actor_id = current_setting('pactwoven.actor_id', true) AND pactwoven.has_membership(environment, organization_id)
    AND pactwoven.has_role(ARRAY['owner','operations']::text[]) AND kind = 'responsibility.create');
CREATE POLICY outbox_create ON pactwoven.outbox_events FOR INSERT TO pactwoven_runtime
  WITH CHECK (pactwoven.has_membership(environment, organization_id) AND pactwoven.has_role(ARRAY['owner','operations']::text[])
    AND event_type = 'responsibility.created');

GRANT SELECT ON pactwoven.organizations, pactwoven.memberships, pactwoven.sites, pactwoven.site_memberships,
  pactwoven.responsibility_assignments TO pactwoven_runtime;
GRANT SELECT, INSERT ON pactwoven.responsibilities, pactwoven.operations TO pactwoven_runtime;
GRANT INSERT ON pactwoven.outbox_events TO pactwoven_runtime;

COMMIT;
