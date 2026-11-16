BEGIN;

-- Version 1 starts at this migration; it does not reconstruct past authority.
ALTER TABLE pactwoven.organizations ADD COLUMN row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0);

CREATE FUNCTION pactwoven.guard_organization_identity_version() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE authority_changed boolean;
BEGIN
  IF NEW.environment IS DISTINCT FROM OLD.environment OR NEW.id IS DISTINCT FROM OLD.id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION USING ERRCODE='PI001', MESSAGE='Organization identity and creation time are immutable';
  END IF;
  IF NEW.row_version IS NULL OR (NEW.row_version IS DISTINCT FROM OLD.row_version
    AND NEW.row_version::bigint <> OLD.row_version::bigint + 1) THEN
    RAISE EXCEPTION USING ERRCODE='PI001', MESSAGE='Organization version must remain current or advance exactly once';
  END IF;
  authority_changed := NEW.status IS DISTINCT FROM OLD.status
    OR NEW.authority_epoch IS DISTINCT FROM OLD.authority_epoch
    OR NEW.external_organization_id IS DISTINCT FROM OLD.external_organization_id;
  IF authority_changed THEN
    IF OLD.row_version = 2147483647 THEN
      RAISE EXCEPTION USING ERRCODE='PI001', MESSAGE='Organization version is exhausted';
    END IF;
    -- Honor existing explicit +1 writers without advancing a second time.
    NEW.row_version := OLD.row_version + 1;
  END IF;
  -- Explicit +1 without a field change is allowed as deliberate invalidation.
  -- A cosmetic/no-op update with the unchanged version retains that version.
  RETURN NEW;
END $$;
CREATE TRIGGER organization_identity_version_guard BEFORE UPDATE ON pactwoven.organizations
FOR EACH ROW EXECUTE FUNCTION pactwoven.guard_organization_identity_version();

CREATE FUNCTION pactwoven.guard_membership_authority_version() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE authority_changed boolean;
BEGIN
  IF NEW.environment IS DISTINCT FROM OLD.environment OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.actor_id IS DISTINCT FROM OLD.actor_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION USING ERRCODE='PI001', MESSAGE='Membership identity and creation time are immutable';
  END IF;
  IF NEW.row_version IS NULL OR (NEW.row_version IS DISTINCT FROM OLD.row_version
    AND NEW.row_version::bigint <> OLD.row_version::bigint + 1) THEN
    RAISE EXCEPTION USING ERRCODE='PI001', MESSAGE='Membership version must remain current or advance exactly once';
  END IF;
  authority_changed := NEW.roles IS DISTINCT FROM OLD.roles OR NEW.status IS DISTINCT FROM OLD.status
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.external_membership_id IS DISTINCT FROM OLD.external_membership_id;
  IF authority_changed THEN
    IF OLD.row_version = 2147483647 THEN
      RAISE EXCEPTION USING ERRCODE='PI001', MESSAGE='Membership version is exhausted';
    END IF;
    NEW.row_version := OLD.row_version + 1;
  END IF;
  -- Explicit +1 is valid even for an unchanged role/expiry reissue: the access
  -- writer also changes site grants outside this row. Its epoch/locks remain
  -- that writer's responsibility. This trigger introduces no new lock order.
  RETURN NEW;
END $$;
CREATE TRIGGER membership_version_guard BEFORE UPDATE ON pactwoven.memberships
FOR EACH ROW EXECUTE FUNCTION pactwoven.guard_membership_authority_version();

-- Invoker trigger functions use only OLD/NEW and confer no table capability.
REVOKE ALL ON FUNCTION pactwoven.guard_organization_identity_version() FROM PUBLIC;
REVOKE ALL ON FUNCTION pactwoven.guard_membership_authority_version() FROM PUBLIC;

COMMIT;
