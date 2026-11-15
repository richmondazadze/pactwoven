BEGIN;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='pactwoven_access_provisioner') THEN
    CREATE ROLE pactwoven_access_provisioner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;
GRANT USAGE ON SCHEMA pactwoven TO pactwoven_access_provisioner;
ALTER TABLE pactwoven.memberships ADD COLUMN row_version integer NOT NULL DEFAULT 1 CHECK (row_version>0);
ALTER TABLE pactwoven.memberships ADD COLUMN display_name text NOT NULL DEFAULT '' CHECK (char_length(display_name)<=180);
ALTER TABLE pactwoven.memberships DROP CONSTRAINT memberships_grant_basis_check;
ALTER TABLE pactwoven.memberships ADD CONSTRAINT memberships_grant_basis_check CHECK (grant_basis IN ('internal','clerk_admin_bootstrap','owner_grant'));
CREATE TABLE pactwoven.member_action_sites (
  environment text NOT NULL, organization_id text NOT NULL, actor_id text NOT NULL, site_id text NOT NULL,
  PRIMARY KEY(environment,organization_id,actor_id,site_id),
  FOREIGN KEY(environment,organization_id,actor_id) REFERENCES pactwoven.memberships(environment,organization_id,actor_id),
  FOREIGN KEY(environment,organization_id,site_id) REFERENCES pactwoven.sites(environment,organization_id,id)
);
CREATE TABLE pactwoven.member_access_history (
  environment text NOT NULL, organization_id text NOT NULL, id text NOT NULL, actor_id text NOT NULL, member_version integer NOT NULL,
  changed_by text NOT NULL, operation_id text NOT NULL, kind text NOT NULL CHECK(kind IN ('grant','revise','revoke')),
  previous_access jsonb, next_access jsonb NOT NULL, mfa_evidence jsonb NOT NULL, reason text, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(environment,organization_id,id), UNIQUE(environment,organization_id,actor_id,member_version),
  FOREIGN KEY(environment,organization_id,actor_id) REFERENCES pactwoven.memberships(environment,organization_id,actor_id),
  FOREIGN KEY(environment,organization_id,changed_by) REFERENCES pactwoven.memberships(environment,organization_id,actor_id),
  FOREIGN KEY(environment,organization_id,operation_id) REFERENCES pactwoven.operations(environment,organization_id,id)
);
CREATE FUNCTION pactwoven.prevent_access_history_change() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION USING ERRCODE='PA001', MESSAGE='Access history is immutable'; END $$;
CREATE TRIGGER access_history_immutable BEFORE UPDATE OR DELETE ON pactwoven.member_access_history FOR EACH ROW EXECUTE FUNCTION pactwoven.prevent_access_history_change();
CREATE FUNCTION pactwoven.prevent_member_rebinding() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.environment IS DISTINCT FROM OLD.environment OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.actor_id IS DISTINCT FROM OLD.actor_id OR NEW.external_subject IS DISTINCT FROM OLD.external_subject
    OR (OLD.external_membership_id IS NOT NULL AND NEW.external_membership_id IS DISTINCT FROM OLD.external_membership_id)
    OR NEW.grant_basis IS DISTINCT FROM OLD.grant_basis THEN
    RAISE EXCEPTION USING ERRCODE='PA001', MESSAGE='Membership identity is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER membership_identity_immutable BEFORE UPDATE ON pactwoven.memberships FOR EACH ROW EXECUTE FUNCTION pactwoven.prevent_member_rebinding();

-- Bootstrap's durable event explicitly identifies its initial site. Preserve
-- that exact authority without converting broad owner read access into grants.
CREATE FUNCTION pactwoven.grant_bootstrap_action_site() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  INSERT INTO pactwoven.member_action_sites(environment,organization_id,actor_id,site_id)
    SELECT NEW.environment,NEW.organization_id,m.actor_id,s.id
    FROM pactwoven.memberships m JOIN pactwoven.sites s ON (s.environment,s.organization_id)=(m.environment,m.organization_id)
    JOIN pactwoven.operations op ON (op.environment,op.organization_id,op.id)=(m.environment,m.organization_id,NEW.payload->>'causationId')
    WHERE NEW.event_type='organization.bootstrapped' AND NEW.payload->>'source'='identity-provisioner'
      AND m.environment=NEW.environment AND m.organization_id=NEW.organization_id
      AND m.actor_id=NEW.payload#>>'{payload,actorId}' AND m.external_membership_id=NEW.payload#>>'{payload,externalMembershipId}'
      AND m.grant_basis='clerk_admin_bootstrap' AND m.roles=ARRAY['owner']::text[] AND m.row_version=1
      AND op.kind='organization.bootstrap' AND op.actor_id=m.actor_id AND s.id=NEW.payload#>>'{payload,initialSiteId}'
    ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER bootstrap_action_site AFTER INSERT ON pactwoven.outbox_events FOR EACH ROW WHEN(NEW.event_type='organization.bootstrapped') EXECUTE FUNCTION pactwoven.grant_bootstrap_action_site();
INSERT INTO pactwoven.member_action_sites(environment,organization_id,actor_id,site_id)
  SELECT e.environment,e.organization_id,m.actor_id,s.id FROM pactwoven.outbox_events e
  JOIN pactwoven.memberships m ON (m.environment,m.organization_id,m.actor_id)=(e.environment,e.organization_id,e.payload#>>'{payload,actorId}')
  JOIN pactwoven.sites s ON (s.environment,s.organization_id,s.id)=(e.environment,e.organization_id,e.payload#>>'{payload,initialSiteId}')
  JOIN pactwoven.operations op ON (op.environment,op.organization_id,op.id)=(e.environment,e.organization_id,e.payload->>'causationId')
  WHERE e.event_type='organization.bootstrapped' AND e.payload->>'source'='identity-provisioner' AND op.kind='organization.bootstrap'
    AND op.actor_id=m.actor_id AND m.grant_basis='clerk_admin_bootstrap' AND m.roles=ARRAY['owner']::text[]
    AND m.row_version=1 AND m.external_membership_id=e.payload#>>'{payload,externalMembershipId}' ON CONFLICT DO NOTHING;
ALTER TABLE pactwoven.member_action_sites ENABLE ROW LEVEL SECURITY;
ALTER TABLE pactwoven.member_access_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY member_action_site_self_read ON pactwoven.member_action_sites FOR SELECT TO pactwoven_runtime
  USING(actor_id=current_setting('pactwoven.actor_id',true) AND pactwoven.has_membership(environment,organization_id));
GRANT SELECT ON pactwoven.member_action_sites TO pactwoven_runtime;

-- All commands lock organization first, then member rows. Later financial
-- transactions use this same order so revocation serializes with authority use.
CREATE OR REPLACE FUNCTION pactwoven.lock_actor() RETURNS TABLE(roles text[])
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM 1 FROM pactwoven.organizations o WHERE o.environment=current_setting('pactwoven.environment',true)
    AND o.id=current_setting('pactwoven.organization_id',true) AND o.status='active' FOR SHARE;
  RETURN QUERY SELECT m.roles FROM pactwoven.memberships m
    WHERE m.environment=current_setting('pactwoven.environment',true) AND m.organization_id=current_setting('pactwoven.organization_id',true)
      AND m.actor_id=current_setting('pactwoven.actor_id',true) AND pactwoven.has_membership(m.environment,m.organization_id) FOR SHARE;
END $$;
CREATE FUNCTION pactwoven.access_owner(p_environment text,p_identity jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE o pactwoven.organizations%ROWTYPE; m pactwoven.memberships%ROWTYPE; at_time timestamptz:=clock_timestamp();
BEGIN
  IF p_environment NOT IN ('development','simulation','staging','production') OR p_identity IS NULL
    OR coalesce(p_identity->>'sessionId','')='' OR coalesce(p_identity->>'membershipObservedAt','')='' OR (p_identity->>'membershipObservedAt')::timestamptz>at_time
    OR (p_identity->>'membershipObservedAt')::timestamptz<at_time-interval '20 seconds' THEN
    RAISE EXCEPTION USING ERRCODE='PA001',MESSAGE='Current verified owner required';
  END IF;
  SELECT * INTO o FROM pactwoven.organizations WHERE environment=p_environment AND external_organization_id=p_identity->>'externalOrganizationId' FOR UPDATE;
  IF NOT FOUND OR o.status<>'active' THEN RAISE EXCEPTION USING ERRCODE='PA001',MESSAGE='Current verified owner required'; END IF;
  SELECT * INTO m FROM pactwoven.memberships WHERE environment=p_environment AND organization_id=o.id
    AND external_subject=p_identity->>'subject' AND external_membership_id=p_identity->>'externalMembershipId' FOR UPDATE;
  IF NOT FOUND OR m.status<>'active' OR NOT('owner'=ANY(m.roles)) OR (m.expires_at IS NOT NULL AND m.expires_at<=clock_timestamp())
    OR (m.grant_basis='clerk_admin_bootstrap' AND p_identity->>'externalRole' IS DISTINCT FROM 'org:admin')
    OR EXISTS(SELECT 1 FROM pactwoven.session_revocations WHERE environment=p_environment AND session_id=p_identity->>'sessionId') THEN
    RAISE EXCEPTION USING ERRCODE='PA001',MESSAGE='Current verified owner required';
  END IF;
  IF (p_identity->>'membershipObservedAt')::timestamptz<clock_timestamp()-interval '20 seconds' THEN RAISE EXCEPTION USING ERRCODE='PA001',MESSAGE='Stale owner observation'; END IF;
  RETURN jsonb_build_object('organizationId',o.id,'actorId',m.actor_id,'authorityEpoch',o.authority_epoch);
END $$;
CREATE FUNCTION pactwoven.member_access_view(p_environment text,p_organization text,p_actor text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT jsonb_build_object('actorId',m.actor_id,'externalSubject',m.external_subject,'externalMembershipId',m.external_membership_id,
    'displayName',coalesce(nullif(m.display_name,''),m.external_subject),'roles',m.roles,'status',m.status,'version',m.row_version,
    'expiresAt',m.expires_at,'siteIds',coalesce((SELECT jsonb_agg(site_id ORDER BY site_id) FROM pactwoven.site_memberships s
      WHERE(s.environment,s.organization_id,s.actor_id)=(m.environment,m.organization_id,m.actor_id)),'[]'::jsonb),
    'actionSiteIds',coalesce((SELECT jsonb_agg(site_id ORDER BY site_id) FROM pactwoven.member_action_sites s
      WHERE(s.environment,s.organization_id,s.actor_id)=(m.environment,m.organization_id,m.actor_id)),'[]'::jsonb))
  FROM pactwoven.memberships m WHERE(m.environment,m.organization_id,m.actor_id)=(p_environment,p_organization,p_actor)
$$;
CREATE FUNCTION pactwoven.read_member_access(p_environment text,p_identity jsonb,p_offset integer,p_limit integer,p_actor text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE owner_context jsonb; items jsonb; has_more boolean;
BEGIN
  owner_context:=pactwoven.access_owner(p_environment,p_identity);
  IF p_offset<0 OR p_offset>999999 OR p_limit<1 OR p_limit>100 THEN RAISE EXCEPTION USING ERRCODE='PA004',MESSAGE='Invalid page'; END IF;
  SELECT coalesce(jsonb_agg(row_data),'[]'::jsonb) INTO items FROM (SELECT pactwoven.member_access_view(p_environment,owner_context->>'organizationId',m.actor_id) row_data
    FROM pactwoven.memberships m WHERE m.environment=p_environment AND m.organization_id=owner_context->>'organizationId'
      AND m.external_membership_id IS NOT NULL AND (p_actor IS NULL OR m.actor_id=p_actor) ORDER BY m.actor_id OFFSET p_offset LIMIT p_limit) rows;
  SELECT EXISTS(SELECT 1 FROM pactwoven.memberships m WHERE m.environment=p_environment AND m.organization_id=owner_context->>'organizationId'
    AND m.external_membership_id IS NOT NULL AND (p_actor IS NULL OR m.actor_id=p_actor) ORDER BY m.actor_id OFFSET p_offset+p_limit LIMIT 1) INTO has_more;
  RETURN jsonb_build_object('items',items,'nextCursor',CASE WHEN has_more THEN(p_offset+p_limit)::text ELSE NULL END,
    'authorityEpoch',owner_context->'authorityEpoch','observedAt',clock_timestamp());
END $$;
CREATE FUNCTION pactwoven.change_member_access(p_environment text,p_identity jsonb,p_evidence jsonb,p_target jsonb,p_kind text,p_actor text,
  p_command jsonb,p_key text,p_hash text,p_correlation text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE owner_context jsonb; target_member pactwoven.memberships%ROWTYPE; prior_operation pactwoven.operations%ROWTYPE;
  payload jsonb:=p_command->'payload'; requested_roles text[]; read_sites text[]; action_sites text[]; target_id text; next_version integer;
  operation_id text:=gen_random_uuid()::text; history_id text:=gen_random_uuid()::text; previous_access jsonb; next_access jsonb; response jsonb;
  at_time timestamptz; verification_bound timestamptz; new_expiry timestamptz;
BEGIN
  owner_context:=pactwoven.access_owner(p_environment,p_identity); at_time:=clock_timestamp();
  IF p_evidence IS NULL OR coalesce(p_evidence->>'tokenIssuedAt','')='' OR coalesce(p_evidence->>'observedAt','')=''
    OR coalesce(p_evidence->>'verifiedAt','')='' OR coalesce(p_evidence->>'expiresAt','')='' OR p_evidence->>'purpose' IS DISTINCT FROM 'member_access'
    OR p_evidence->>'subject' IS DISTINCT FROM p_identity->>'subject' OR p_evidence->>'sessionId' IS DISTINCT FROM p_identity->>'sessionId'
    OR p_evidence->>'externalOrganizationId' IS DISTINCT FROM p_identity->>'externalOrganizationId'
    OR p_evidence->>'externalMembershipId' IS DISTINCT FROM p_identity->>'externalMembershipId'
    OR coalesce(p_evidence->>'tokenHash','') !~ '^[a-f0-9]{64}$' OR coalesce(p_evidence->>'id','')=''
    OR coalesce(p_evidence->>'firstFactorAgeMinutes','') !~ '^[0-9]{1,7}$' OR coalesce(p_evidence->>'secondFactorAgeMinutes','') !~ '^[0-9]{1,7}$'
    OR (p_evidence->>'tokenIssuedAt')::timestamptz>at_time OR (p_evidence->>'observedAt')::timestamptz>at_time
    OR (p_evidence->>'observedAt')::timestamptz<at_time-interval '20 seconds' OR (p_evidence->>'expiresAt')::timestamptz<=at_time THEN
    RAISE EXCEPTION USING ERRCODE='PA005',MESSAGE='Fresh genuine MFA required';
  END IF;
  verification_bound:=(p_evidence->>'tokenIssuedAt')::timestamptz-(greatest((p_evidence->>'firstFactorAgeMinutes')::integer,(p_evidence->>'secondFactorAgeMinutes')::integer)+1)*interval '1 minute';
  IF (p_evidence->>'verifiedAt')::timestamptz IS DISTINCT FROM verification_bound OR verification_bound+interval '5 minutes'<=at_time
    OR (p_evidence->>'expiresAt')::timestamptz>verification_bound+interval '5 minutes' THEN
    RAISE EXCEPTION USING ERRCODE='PA005',MESSAGE='Fresh genuine MFA required';
  END IF;
  IF p_kind NOT IN ('grant','revise','revoke') OR p_key IS NULL OR p_key !~ '^[A-Za-z0-9_-]{16,128}$' OR p_hash IS NULL OR p_hash !~ '^[a-f0-9]{64}$'
    OR p_command->'mandateVersion' IS DISTINCT FROM 'null'::jsonb OR coalesce(p_command->>'expectedVersion','') !~ '^[0-9]{1,10}$'
    OR coalesce(p_command->>'authorityEpoch','') !~ '^[0-9]{1,10}$' THEN RAISE EXCEPTION USING ERRCODE='PA004',MESSAGE='Invalid access command'; END IF;
  SELECT * INTO prior_operation FROM pactwoven.operations WHERE environment=p_environment AND organization_id=owner_context->>'organizationId'
    AND kind='member.'||p_kind AND idempotency_key=p_key;
  IF FOUND THEN
    IF prior_operation.command_hash<>p_hash OR prior_operation.actor_id<>owner_context->>'actorId' THEN RAISE EXCEPTION USING ERRCODE='PA003',MESSAGE='Changed idempotency payload'; END IF;
    RETURN prior_operation.response;
  END IF;
  IF (p_command->>'authorityEpoch')::integer<>(owner_context->>'authorityEpoch')::integer THEN RAISE EXCEPTION USING ERRCODE='PA002',MESSAGE='Authority changed'; END IF;
  IF p_kind='grant' AND payload->>'externalSubject'=p_identity->>'subject' THEN RAISE EXCEPTION USING ERRCODE='PA001',MESSAGE='Another owner must change your access'; END IF;
  IF p_kind='grant' THEN
    SELECT * INTO target_member FROM pactwoven.memberships WHERE environment=p_environment AND organization_id=owner_context->>'organizationId'
      AND (external_subject=payload->>'externalSubject' OR external_membership_id=payload->>'externalMembershipId') FOR UPDATE;
    IF FOUND OR (p_command->>'expectedVersion')::integer<>0 THEN RAISE EXCEPTION USING ERRCODE='PA002',MESSAGE='Member already bound'; END IF;
    target_id:=gen_random_uuid()::text; next_version:=1;
  ELSE
    SELECT * INTO target_member FROM pactwoven.memberships WHERE environment=p_environment AND organization_id=owner_context->>'organizationId' AND actor_id=p_actor FOR UPDATE;
    IF NOT FOUND OR target_member.row_version<>(p_command->>'expectedVersion')::integer OR target_member.status<>'active' THEN
      RAISE EXCEPTION USING ERRCODE='PA002',MESSAGE='Member access changed'; END IF;
    target_id:=target_member.actor_id; next_version:=target_member.row_version+1;
    previous_access:=pactwoven.member_access_view(p_environment,owner_context->>'organizationId',target_id);
  END IF;
  IF target_id=owner_context->>'actorId' OR (p_kind='grant' AND payload->>'externalSubject'=p_identity->>'subject') THEN
    RAISE EXCEPTION USING ERRCODE='PA001',MESSAGE='Another owner must change your access'; END IF;
  IF p_kind<>'revoke' THEN
    IF p_target IS NULL OR coalesce(p_target->>'observedAt','')='' OR p_target->>'externalOrganizationId' IS DISTINCT FROM p_identity->>'externalOrganizationId'
      OR (p_target->>'observedAt')::timestamptz>at_time OR (p_target->>'observedAt')::timestamptz<at_time-interval '20 seconds'
      OR (p_kind='grant' AND (p_target->>'externalSubject' IS DISTINCT FROM payload->>'externalSubject' OR p_target->>'externalMembershipId' IS DISTINCT FROM payload->>'externalMembershipId'))
      OR (p_kind='revise' AND (p_target->>'externalSubject' IS DISTINCT FROM target_member.external_subject OR p_target->>'externalMembershipId' IS DISTINCT FROM target_member.external_membership_id)) THEN
      RAISE EXCEPTION USING ERRCODE='PA001',MESSAGE='Exact accepted target membership required'; END IF;
    SELECT array_agg(value) INTO requested_roles FROM jsonb_array_elements_text(payload->'roles');
    SELECT coalesce(array_agg(value),'{}'::text[]) INTO read_sites FROM jsonb_array_elements_text(payload->'siteIds');
    SELECT coalesce(array_agg(value),'{}'::text[]) INTO action_sites FROM jsonb_array_elements_text(payload->'actionSiteIds');
    new_expiry:=(payload->>'expiresAt')::timestamptz;
    IF coalesce(cardinality(requested_roles),0)<1 OR cardinality(requested_roles)>5 OR NOT(requested_roles<@ARRAY['owner','operations','finance','receiver','auditor']::text[])
      OR cardinality(read_sites)>100 OR cardinality(action_sites)>100 OR (new_expiry IS NOT NULL AND new_expiry<=at_time)
      OR cardinality(requested_roles)<>(SELECT count(DISTINCT x) FROM unnest(requested_roles)x)
      OR cardinality(read_sites)<>(SELECT count(DISTINCT x) FROM unnest(read_sites)x) OR cardinality(action_sites)<>(SELECT count(DISTINCT x) FROM unnest(action_sites)x)
      OR (NOT(requested_roles&&ARRAY['owner','operations','finance','receiver']::text[]) AND cardinality(action_sites)>0)
      OR (NOT(requested_roles&&ARRAY['owner','finance']::text[]) AND NOT(action_sites<@read_sites))
      OR EXISTS(SELECT 1 FROM unnest(read_sites||action_sites) wanted(id) WHERE NOT EXISTS(SELECT 1 FROM pactwoven.sites s
        WHERE s.environment=p_environment AND s.organization_id=owner_context->>'organizationId' AND s.id=wanted.id)) THEN
      RAISE EXCEPTION USING ERRCODE='PA004',MESSAGE='Invalid exact role and site scope'; END IF;
    IF p_kind='grant' THEN
      INSERT INTO pactwoven.memberships(environment,organization_id,actor_id,external_subject,external_membership_id,grant_basis,roles,status,row_version,display_name,expires_at)
      VALUES(p_environment,owner_context->>'organizationId',target_id,p_target->>'externalSubject',p_target->>'externalMembershipId','owner_grant',requested_roles,'active',next_version,p_target->>'displayName',new_expiry);
    ELSE
      UPDATE pactwoven.memberships SET roles=requested_roles,expires_at=new_expiry,row_version=next_version,display_name=p_target->>'displayName'
        WHERE environment=p_environment AND organization_id=owner_context->>'organizationId' AND actor_id=target_id;
    END IF;
  ELSE
    IF coalesce(char_length(btrim(payload->>'reason')),0) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION USING ERRCODE='PA004',MESSAGE='A revocation reason is required'; END IF;
    UPDATE pactwoven.memberships SET status='revoked',row_version=next_version WHERE environment=p_environment AND organization_id=owner_context->>'organizationId' AND actor_id=target_id;
    read_sites:='{}'; action_sites:='{}';
  END IF;
  DELETE FROM pactwoven.site_memberships WHERE environment=p_environment AND organization_id=owner_context->>'organizationId' AND actor_id=target_id;
  DELETE FROM pactwoven.member_action_sites WHERE environment=p_environment AND organization_id=owner_context->>'organizationId' AND actor_id=target_id;
  INSERT INTO pactwoven.site_memberships SELECT p_environment,owner_context->>'organizationId',target_id,id FROM unnest(read_sites) ids(id);
  INSERT INTO pactwoven.member_action_sites SELECT p_environment,owner_context->>'organizationId',target_id,id FROM unnest(action_sites) ids(id);
  UPDATE pactwoven.organizations SET authority_epoch=authority_epoch+1 WHERE environment=p_environment AND id=owner_context->>'organizationId';
  IF (p_evidence->>'expiresAt')::timestamptz<=clock_timestamp() OR verification_bound+interval '5 minutes'<=clock_timestamp() THEN
    RAISE EXCEPTION USING ERRCODE='PA005',MESSAGE='MFA expired before command acceptance'; END IF;
  next_access:=pactwoven.member_access_view(p_environment,owner_context->>'organizationId',target_id);
  response:=jsonb_build_object('id',operation_id,'environment',p_environment,'status','succeeded','aggregateId',target_id,'aggregateVersion',next_version,
    'financialState',NULL,'evidenceRefs',jsonb_build_array(history_id),'nextCheckAt',NULL,'error',NULL);
  INSERT INTO pactwoven.operations(environment,organization_id,id,actor_id,kind,idempotency_key,command_hash,aggregate_id,response)
    VALUES(p_environment,owner_context->>'organizationId',operation_id,owner_context->>'actorId','member.'||p_kind,p_key,p_hash,target_id,response);
  INSERT INTO pactwoven.member_access_history(environment,organization_id,id,actor_id,member_version,changed_by,operation_id,kind,previous_access,next_access,mfa_evidence,reason)
    VALUES(p_environment,owner_context->>'organizationId',history_id,target_id,next_version,owner_context->>'actorId',operation_id,p_kind,previous_access,next_access,p_evidence,payload->>'reason');
  INSERT INTO pactwoven.outbox_events(environment,organization_id,id,aggregate_id,aggregate_version,event_type,payload)
    VALUES(p_environment,owner_context->>'organizationId',gen_random_uuid()::text,target_id,next_version,'member.access_changed',
      jsonb_build_object('schemaVersion',1,'memberId',target_id,'version',next_version,'authorityEpoch',(owner_context->>'authorityEpoch')::integer+1,
        'operationId',operation_id,'historyId',history_id,'correlationId',p_correlation));
  RETURN response;
END $$;
REVOKE ALL ON FUNCTION pactwoven.access_owner(text,jsonb),pactwoven.member_access_view(text,text,text),pactwoven.read_member_access(text,jsonb,integer,integer,text),
  pactwoven.change_member_access(text,jsonb,jsonb,jsonb,text,text,jsonb,text,text,text),pactwoven.prevent_access_history_change(),pactwoven.prevent_member_rebinding(),pactwoven.grant_bootstrap_action_site() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pactwoven.read_member_access(text,jsonb,integer,integer,text),pactwoven.change_member_access(text,jsonb,jsonb,jsonb,text,text,jsonb,text,text,text) TO pactwoven_access_provisioner;
CREATE FUNCTION pactwoven.read_access_operation(p_environment text,p_identity jsonb,p_kind text,p_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE owner_context jsonb; result jsonb;
BEGIN
  owner_context:=pactwoven.access_owner(p_environment,p_identity);
  IF p_kind NOT IN ('grant','revise','revoke') OR p_key !~ '^[A-Za-z0-9_-]{16,128}$' THEN RAISE EXCEPTION USING ERRCODE='PA004',MESSAGE='Invalid operation query'; END IF;
  SELECT response INTO result FROM pactwoven.operations WHERE environment=p_environment AND organization_id=owner_context->>'organizationId'
    AND kind='member.'||p_kind AND idempotency_key=p_key;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION pactwoven.read_access_operation(text,jsonb,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pactwoven.read_access_operation(text,jsonb,text,text) TO pactwoven_access_provisioner;
COMMIT;
