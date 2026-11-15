BEGIN;

-- Additive repair: preserve the applied identity migration and existing RPCs.
-- Lock order is organization, session-revocation table, then member rows.
CREATE OR REPLACE FUNCTION pactwoven.access_owner(p_environment text,p_identity jsonb) RETURNS jsonb
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
  LOCK TABLE pactwoven.session_revocations IN SHARE MODE;
  SELECT * INTO m FROM pactwoven.memberships WHERE environment=p_environment AND organization_id=o.id
    AND external_subject=p_identity->>'subject' AND external_membership_id=p_identity->>'externalMembershipId' FOR UPDATE;
  IF NOT FOUND OR m.status<>'active' OR NOT('owner'=ANY(m.roles)) OR (m.expires_at IS NOT NULL AND m.expires_at<=clock_timestamp())
    OR (m.grant_basis='clerk_admin_bootstrap' AND p_identity->>'externalRole' IS DISTINCT FROM 'org:admin')
    OR EXISTS(SELECT 1 FROM pactwoven.session_revocations WHERE environment=p_environment AND session_id=p_identity->>'sessionId') THEN
    RAISE EXCEPTION USING ERRCODE='PA001',MESSAGE='Current verified owner required';
  END IF;
  IF (p_identity->>'membershipObservedAt')::timestamptz<clock_timestamp()-interval '20 seconds' THEN RAISE EXCEPTION USING ERRCODE='PA001',MESSAGE='Stale owner observation'; END IF;
  RETURN jsonb_build_object('organizationId',o.id,'actorId',m.actor_id,'authorityEpoch',o.authority_epoch,'ownerExpiresAt',m.expires_at);
END $$;

CREATE OR REPLACE FUNCTION pactwoven.change_member_access(p_environment text,p_identity jsonb,p_evidence jsonb,p_target jsonb,p_kind text,p_actor text,
  p_command jsonb,p_key text,p_hash text,p_correlation text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE owner_context jsonb; target_member pactwoven.memberships%ROWTYPE; prior_operation pactwoven.operations%ROWTYPE;
  payload jsonb:=p_command->'payload'; requested_roles text[]; read_sites text[]; action_sites text[]; target_id text; next_version integer;
  operation_id text:=gen_random_uuid()::text; history_id text:=gen_random_uuid()::text; previous_access jsonb; next_access jsonb; response jsonb;
  at_time timestamptz; acceptance_time timestamptz; verification_bound timestamptz; new_expiry timestamptz;
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
  -- All effect, history and outbox waits precede this common acceptance instant.
  -- Held locks serialize local revocation; deadlines are valid here, before COMMIT.
  acceptance_time:=clock_timestamp();
  IF ((owner_context->>'ownerExpiresAt')::timestamptz IS NOT NULL AND (owner_context->>'ownerExpiresAt')::timestamptz<=acceptance_time)
    OR (p_identity->>'membershipObservedAt')::timestamptz>acceptance_time
    OR (p_identity->>'membershipObservedAt')::timestamptz<acceptance_time-interval '20 seconds' THEN
    RAISE EXCEPTION USING ERRCODE='PA001',MESSAGE='Current verified owner required at command acceptance';
  END IF;
  IF p_kind<>'revoke' THEN
    IF (p_target->>'observedAt')::timestamptz>acceptance_time
      OR (p_target->>'observedAt')::timestamptz<acceptance_time-interval '20 seconds' THEN
      RAISE EXCEPTION USING ERRCODE='PA001',MESSAGE='Current target observation required at command acceptance'; END IF;
    IF new_expiry IS NOT NULL AND new_expiry<=acceptance_time THEN
      RAISE EXCEPTION USING ERRCODE='PA004',MESSAGE='Access expiry passed before command acceptance'; END IF;
  END IF;
  IF (p_evidence->>'observedAt')::timestamptz>acceptance_time
    OR (p_evidence->>'observedAt')::timestamptz<acceptance_time-interval '20 seconds'
    OR (p_evidence->>'tokenIssuedAt')::timestamptz>acceptance_time
    OR (p_evidence->>'expiresAt')::timestamptz<=acceptance_time
    OR verification_bound+interval '5 minutes'<=acceptance_time THEN
    RAISE EXCEPTION USING ERRCODE='PA005',MESSAGE='Fresh genuine MFA required at command acceptance';
  END IF;
  RETURN response;
END $$;

REVOKE ALL ON FUNCTION pactwoven.access_owner(text,jsonb),
  pactwoven.change_member_access(text,jsonb,jsonb,jsonb,text,text,jsonb,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pactwoven.change_member_access(text,jsonb,jsonb,jsonb,text,text,jsonb,text,text,text) TO pactwoven_access_provisioner;
COMMIT;
