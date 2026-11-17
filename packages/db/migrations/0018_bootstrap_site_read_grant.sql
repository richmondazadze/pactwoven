BEGIN;

-- Preserve the existing trigger identity, owner and ACL. Creation grants only
-- the one site named by the exact durable bootstrap operation and event.
CREATE OR REPLACE FUNCTION pactwoven.grant_bootstrap_action_site() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
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
  END IF;
  -- Both grants are part of initial creation; no previously issued scope exists.
  RETURN NEW;
END $$;

-- Serialize with organization-first access/financial commands before inspecting
-- historical grants. A retained action grant is mandatory: never restore it.
LOCK TABLE pactwoven.organizations,pactwoven.memberships,pactwoven.site_memberships,
  pactwoven.member_action_sites,pactwoven.operations,pactwoven.outbox_events IN EXCLUSIVE MODE;
WITH eligible AS MATERIALIZED (
  SELECT DISTINCT m.environment,m.organization_id,m.actor_id,s.id AS site_id
  FROM pactwoven.outbox_events e
  JOIN pactwoven.organizations o ON (o.environment,o.id)=(e.environment,e.organization_id)
  JOIN pactwoven.memberships m ON (m.environment,m.organization_id)=(o.environment,o.id)
  JOIN pactwoven.sites s ON (s.environment,s.organization_id)=(o.environment,o.id)
  JOIN pactwoven.operations op ON (op.environment,op.organization_id,op.id)=(o.environment,o.id,e.payload->>'causationId')
  JOIN pactwoven.member_action_sites a ON (a.environment,a.organization_id,a.actor_id,a.site_id)=(m.environment,m.organization_id,m.actor_id,s.id)
  WHERE e.event_type='organization.bootstrapped' AND e.aggregate_id=o.id AND e.aggregate_version=1 AND o.status='active'
    AND e.payload @> jsonb_build_object('eventId',e.id,'schemaVersion',1,'environment',o.environment,
      'organizationId',o.id,'aggregateType','organization','aggregateId',o.id,'aggregateVersion',1,
      'type','organization.bootstrapped','source','identity-provisioner','sourceEventId',NULL)
    AND e.payload->'payload'=jsonb_build_object('organizationId',o.id,'actorId',m.actor_id,
      'initialSiteId',s.id,'externalMembershipId',m.external_membership_id,'grantBasis','clerk_admin_bootstrap')
    AND m.external_membership_id IS NOT NULL AND m.grant_basis='clerk_admin_bootstrap'
    AND m.roles=ARRAY['owner']::text[] AND m.row_version=1 AND m.status='active'
    AND (m.expires_at IS NULL OR m.expires_at>clock_timestamp())
    AND op.kind='organization.bootstrap' AND op.actor_id=m.actor_id AND op.aggregate_id=o.id
    AND op.response=jsonb_build_object('id',op.id,'environment',o.environment,'status','succeeded',
      'aggregateId',o.id,'aggregateVersion',1,'financialState',NULL,'evidenceRefs','[]'::jsonb,'nextCheckAt',NULL,'error',NULL)
    AND NOT EXISTS(SELECT 1 FROM pactwoven.outbox_events other WHERE other.environment=e.environment
      AND other.organization_id=e.organization_id AND other.event_type='organization.bootstrapped'
      AND other.payload->>'causationId'=op.id AND other.id<>e.id)
), inserted AS (
  INSERT INTO pactwoven.site_memberships(environment,organization_id,actor_id,site_id)
    SELECT environment,organization_id,actor_id,site_id FROM eligible ON CONFLICT DO NOTHING
    RETURNING environment,organization_id,actor_id
), changed_members AS (
  UPDATE pactwoven.memberships m SET row_version=m.row_version+1
  WHERE EXISTS(SELECT 1 FROM inserted i WHERE (i.environment,i.organization_id,i.actor_id)=(m.environment,m.organization_id,m.actor_id))
  RETURNING m.environment,m.organization_id
)
UPDATE pactwoven.organizations o SET authority_epoch=o.authority_epoch+1
WHERE EXISTS(SELECT 1 FROM changed_members m WHERE (m.environment,m.organization_id)=(o.environment,o.id));
-- 0014 advances organization row_version once when its epoch changes. Existing
-- read grants cause no version bump. Old financial identity/member scope fails.

COMMIT;
