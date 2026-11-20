BEGIN;

-- Separate unnumbered bootstrap-policy successor. No backfill.
CREATE OR REPLACE FUNCTION pactwoven.grant_bootstrap_action_site()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE grant_row record;
BEGIN
  SELECT m.environment,m.organization_id,m.actor_id,s.id AS site_id INTO grant_row
  FROM pactwoven.organizations o
  JOIN pactwoven.memberships m ON (m.environment,m.organization_id)=(o.environment,o.id)
  JOIN pactwoven.sites s ON (s.environment,s.organization_id)=(o.environment,o.id)
  JOIN pactwoven.operations op ON (op.environment,op.organization_id,op.id)=(o.environment,o.id,NEW.payload->>'causationId')
  WHERE NEW.event_type='organization.bootstrapped' AND NEW.aggregate_id=o.id AND NEW.aggregate_version=1
    AND (NEW.environment,NEW.organization_id)=(o.environment,o.id) AND o.status='active'
    AND NEW.payload @> jsonb_build_object('eventId',NEW.id,'schemaVersion',1,'environment',o.environment,
      'organizationId',o.id,'aggregateType','organization','aggregateId',o.id,'aggregateVersion',1,
      'type','organization.bootstrapped','source','identity-provisioner','sourceEventId',NULL)
    AND NEW.payload->'payload'=jsonb_build_object('organizationId',o.id,'actorId',m.actor_id,
      'initialSiteId',s.id,'externalMembershipId',m.external_membership_id,'grantBasis','clerk_admin_bootstrap')
    AND m.external_membership_id IS NOT NULL AND m.grant_basis='clerk_admin_bootstrap'
    AND m.roles=ARRAY['owner']::text[] AND m.row_version=1 AND m.status='active'
    AND (m.expires_at IS NULL OR m.expires_at>clock_timestamp())
    AND op.kind='organization.bootstrap' AND op.actor_id=m.actor_id AND op.aggregate_id=o.id
    AND op.response=jsonb_build_object('id',op.id,'environment',o.environment,'status','succeeded',
      'aggregateId',o.id,'aggregateVersion',1,'financialState',NULL,'evidenceRefs','[]'::jsonb,'nextCheckAt',NULL,'error',NULL)
    AND NOT EXISTS(SELECT 1 FROM pactwoven.outbox_events other WHERE other.environment=NEW.environment
      AND other.organization_id=NEW.organization_id AND other.event_type='organization.bootstrapped'
      AND other.payload->>'causationId'=op.id AND other.id<>NEW.id);
  IF FOUND THEN
    INSERT INTO pactwoven.site_memberships(environment,organization_id,actor_id,site_id)
      VALUES(grant_row.environment,grant_row.organization_id,grant_row.actor_id,grant_row.site_id) ON CONFLICT DO NOTHING;
    INSERT INTO pactwoven.member_action_sites(environment,organization_id,actor_id,site_id)
      VALUES(grant_row.environment,grant_row.organization_id,grant_row.actor_id,grant_row.site_id) ON CONFLICT DO NOTHING;
    -- Default advisory enrollment for newly bootstrapped non-production work.
    -- This creates no grant, task, confirmation or external-effects authority.
    IF grant_row.environment IN ('development','simulation') THEN
      INSERT INTO pactwoven.native_delegation_policies(environment,organization_id,version,enabled)
        VALUES(grant_row.environment,grant_row.organization_id,1,true) ON CONFLICT DO NOTHING;
    END IF;
  END IF;
  -- Both grants are part of initial creation; no previously issued scope exists.
  RETURN NEW;
END $function$;

COMMIT;
