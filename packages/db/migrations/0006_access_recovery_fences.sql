BEGIN;

CREATE TABLE pactwoven.member_access_key_fences (
 environment text NOT NULL CHECK(environment IN ('development','simulation','staging','production')),
 organization_id text NOT NULL, kind text NOT NULL CHECK(kind IN ('member.grant','member.revise','member.revoke')),
 idempotency_key text NOT NULL CHECK(idempotency_key ~ '^[A-Za-z0-9_-]{16,128}$'),
 id text NOT NULL CHECK(id ~ '^[A-Za-z0-9_-]{1,128}$'), closed_at timestamptz NOT NULL,
 schema_version integer NOT NULL CHECK(schema_version=1), reason text NOT NULL CHECK(reason='original_input_unavailable'),
 closed_by text NOT NULL, external_membership_id text NOT NULL, session_id text NOT NULL,
 authority_epoch integer NOT NULL CHECK(authority_epoch>=0), identity jsonb NOT NULL CHECK(jsonb_typeof(identity)='object'),
 close_intent jsonb NOT NULL CHECK(jsonb_typeof(close_intent)='object'),
 close_intent_hash text NOT NULL CHECK(close_intent_hash ~ '^[a-f0-9]{64}$'),
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'), evidence jsonb NOT NULL CHECK(jsonb_typeof(evidence)='object'),
 PRIMARY KEY(environment,organization_id,kind,idempotency_key), UNIQUE(environment,organization_id,id),
 FOREIGN KEY(environment,organization_id) REFERENCES pactwoven.organizations(environment,id) ON DELETE RESTRICT,
 FOREIGN KEY(environment,organization_id,closed_by) REFERENCES pactwoven.memberships(environment,organization_id,actor_id) ON DELETE RESTRICT
);
ALTER TABLE pactwoven.member_access_key_fences ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pactwoven.member_access_key_fences FROM PUBLIC,pactwoven_runtime,pactwoven_provisioner,pactwoven_access_provisioner,pactwoven_mandate_writer;

CREATE FUNCTION pactwoven.access_recovery_immutable() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION USING ERRCODE='PA007',MESSAGE='Access key fences are permanent'; END $$;
CREATE TRIGGER access_recovery_immutable_row BEFORE UPDATE OR DELETE ON pactwoven.member_access_key_fences FOR EACH ROW EXECUTE FUNCTION pactwoven.access_recovery_immutable();
CREATE TRIGGER access_recovery_immutable_table BEFORE TRUNCATE ON pactwoven.member_access_key_fences FOR EACH STATEMENT EXECUTE FUNCTION pactwoven.access_recovery_immutable();

-- This canonicalizer handles only the bounded scalar/object recovery request, not arbitrary application JSON.
CREATE FUNCTION pactwoven.access_recovery_canonical(value jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE encoded text;
BEGIN
 CASE jsonb_typeof(value)
 WHEN 'object' THEN SELECT '{'||coalesce(string_agg(to_jsonb(key)::text||':'||pactwoven.access_recovery_canonical(val),',' ORDER BY key COLLATE "C"),'')||'}' INTO encoded FROM jsonb_each(value) AS fields(key,val); RETURN encoded;
 WHEN 'number' THEN RETURN trim_scale((value::text)::numeric)::text;
 WHEN 'string','boolean','null' THEN RETURN value::text;
 ELSE RAISE EXCEPTION USING ERRCODE='PA004',MESSAGE='Invalid recovery request value';
 END CASE;
END $$;
CREATE FUNCTION pactwoven.access_recovery_hash(value jsonb) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT encode(sha256(convert_to(pactwoven.access_recovery_canonical(value),'UTF8')),'hex')
$$;

CREATE FUNCTION pactwoven.access_recovery_input(p_environment text,p_identity jsonb,p_kind text,p_key text) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF p_environment IS NULL OR p_environment NOT IN ('development','simulation','staging','production') OR p_kind IS NULL OR p_kind NOT IN ('grant','revise','revoke')
  OR p_key IS NULL OR p_key !~ '^[A-Za-z0-9_-]{16,128}$' THEN RAISE EXCEPTION USING ERRCODE='PA004',MESSAGE='Exact recovery namespace required'; END IF;
 IF p_identity IS NULL OR jsonb_typeof(p_identity)<>'object' OR NOT(p_identity ?& ARRAY['subject','externalOrganizationId','externalOrganizationName','externalMembershipId','externalRole','membershipObservedAt','sessionId','authenticatedAt'])
  OR p_identity-ARRAY['subject','externalOrganizationId','externalOrganizationName','externalMembershipId','externalRole','membershipObservedAt','sessionId','authenticatedAt']<>'{}'::jsonb
  OR EXISTS(SELECT 1 FROM jsonb_each(p_identity) field WHERE jsonb_typeof(field.value)<>'string')
  OR p_identity->>'subject' !~ '^[A-Za-z0-9_-]{1,128}$' OR p_identity->>'externalOrganizationId' !~ '^[A-Za-z0-9_-]{1,128}$'
  OR p_identity->>'externalMembershipId' !~ '^[A-Za-z0-9_-]{1,128}$' OR char_length(p_identity->>'externalOrganizationName') NOT BETWEEN 1 AND 180
  OR char_length(p_identity->>'sessionId') NOT BETWEEN 1 AND 256 OR char_length(p_identity->>'externalRole') NOT BETWEEN 1 AND 128
  OR coalesce(p_identity->>'membershipObservedAt','')='' OR coalesce(p_identity->>'authenticatedAt','')='' THEN
  RAISE EXCEPTION USING ERRCODE='PA001',MESSAGE='Current verified owner identity required'; END IF;
END $$;
CREATE FUNCTION pactwoven.access_recovery_owner_acceptance(p_identity jsonb,p_owner jsonb,p_at timestamptz) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF ((p_owner->>'ownerExpiresAt')::timestamptz IS NOT NULL AND(p_owner->>'ownerExpiresAt')::timestamptz<=p_at)
  OR(p_identity->>'membershipObservedAt')::timestamptz>p_at OR(p_identity->>'membershipObservedAt')::timestamptz<p_at-interval '20 seconds'
  OR(p_identity->>'authenticatedAt')::timestamptz>p_at THEN RAISE EXCEPTION USING ERRCODE='PA001',MESSAGE='Current verified owner required at recovery acceptance'; END IF;
END $$;
CREATE FUNCTION pactwoven.access_recovery_evidence(p_environment text,p_identity jsonb,p_actor text,p_organization text,p_evidence jsonb,p_key text,p_intent jsonb,p_at timestamptz) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE scope jsonb; bound timestamptz; request jsonb;
BEGIN
 IF p_intent IS NULL OR jsonb_typeof(p_intent)<>'object' OR NOT(p_intent ?& ARRAY['schemaVersion','kind','reason','expectedEnvironment','expectedOrganizationId','expectedActorId','expectedExternalMembershipId','expectedAuthorityEpoch'])
  OR p_intent-ARRAY['schemaVersion','kind','reason','expectedEnvironment','expectedOrganizationId','expectedActorId','expectedExternalMembershipId','expectedAuthorityEpoch']<>'{}'::jsonb
  OR p_intent->'schemaVersion' IS DISTINCT FROM '1'::jsonb OR p_intent->>'reason' IS DISTINCT FROM 'original_input_unavailable'
  OR jsonb_typeof(p_intent->'expectedAuthorityEpoch') IS DISTINCT FROM 'number' OR(p_intent->>'expectedAuthorityEpoch') !~ '^[0-9]{1,10}$'
  OR(p_intent->>'expectedAuthorityEpoch')::numeric>2147483647 THEN RAISE EXCEPTION USING ERRCODE='PA004',MESSAGE='Exact administrative closure review required'; END IF;
 IF p_intent->'expectedEnvironment' IS DISTINCT FROM to_jsonb(p_environment) OR p_intent->'expectedOrganizationId' IS DISTINCT FROM to_jsonb(p_organization)
  OR p_intent->'expectedActorId' IS DISTINCT FROM to_jsonb(p_actor) OR p_intent->'expectedExternalMembershipId' IS DISTINCT FROM p_identity->'externalMembershipId' THEN
  RAISE EXCEPTION USING ERRCODE='PA001',MESSAGE='Current recovery review scope required'; END IF;
 scope:=jsonb_build_object('environment',p_environment,'organizationId',p_organization,'actorId',p_actor,'externalOrganizationId',p_identity->>'externalOrganizationId','externalMembershipId',p_identity->>'externalMembershipId');
 IF p_evidence IS NULL OR jsonb_typeof(p_evidence)<>'object' OR NOT(p_evidence ?& ARRAY['id','purpose','requestNonce','kind','key','intentHash','requestHash','scope','subject','externalOrganizationId','externalMembershipId','sessionId','issuer','tokenHash','tokenIssuedAt','firstFactorAgeMinutes','secondFactorAgeMinutes','verifiedAt','observedAt','expiresAt'])
  OR p_evidence-ARRAY['id','purpose','requestNonce','kind','key','intentHash','requestHash','scope','subject','externalOrganizationId','externalMembershipId','sessionId','issuer','tokenHash','tokenIssuedAt','firstFactorAgeMinutes','secondFactorAgeMinutes','verifiedAt','observedAt','expiresAt']<>'{}'::jsonb
  OR EXISTS(SELECT 1 FROM jsonb_each(p_evidence) field WHERE field.key NOT IN ('scope','firstFactorAgeMinutes','secondFactorAgeMinutes') AND jsonb_typeof(field.value)<>'string')
  OR p_evidence->>'purpose' IS DISTINCT FROM 'member_access_recovery_close' OR p_evidence->'scope' IS DISTINCT FROM scope
  OR p_evidence->'kind' IS DISTINCT FROM p_intent->'kind' OR p_evidence->'key' IS DISTINCT FROM to_jsonb(p_key)
  OR p_evidence->'subject' IS DISTINCT FROM p_identity->'subject' OR p_evidence->'externalOrganizationId' IS DISTINCT FROM p_identity->'externalOrganizationId'
  OR p_evidence->'externalMembershipId' IS DISTINCT FROM p_identity->'externalMembershipId' OR p_evidence->'sessionId' IS DISTINCT FROM p_identity->'sessionId'
  OR coalesce(p_evidence->>'id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  OR coalesce(p_evidence->>'requestNonce','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  OR coalesce(p_evidence->>'tokenHash','') !~ '^[a-f0-9]{64}$' OR coalesce(p_evidence->>'issuer','') !~ '^https?://[^[:space:]]+$'
  OR coalesce(p_evidence->>'tokenIssuedAt','')='' OR coalesce(p_evidence->>'observedAt','')='' OR coalesce(p_evidence->>'verifiedAt','')='' OR coalesce(p_evidence->>'expiresAt','')=''
  OR jsonb_typeof(p_evidence->'firstFactorAgeMinutes') IS DISTINCT FROM 'number' OR jsonb_typeof(p_evidence->'secondFactorAgeMinutes') IS DISTINCT FROM 'number'
  OR coalesce(p_evidence->>'firstFactorAgeMinutes','') !~ '^[0-9]{1,7}$' OR coalesce(p_evidence->>'secondFactorAgeMinutes','') !~ '^[0-9]{1,7}$'
  OR(p_evidence->>'firstFactorAgeMinutes')::integer>1000000 OR(p_evidence->>'secondFactorAgeMinutes')::integer>1000000 THEN
  RAISE EXCEPTION USING ERRCODE='PA005',MESSAGE='Exact genuine recovery factors required'; END IF;
 request:=jsonb_build_object('nonce',p_evidence->>'requestNonce','key',p_key,'intent',p_intent,'scope',scope);
 IF p_evidence->>'intentHash' IS DISTINCT FROM pactwoven.access_recovery_hash(p_intent)
  OR p_evidence->>'requestHash' IS DISTINCT FROM pactwoven.access_recovery_hash(jsonb_build_object('schemaVersion',1,'purpose','member_access_recovery_close','request',request)) THEN
  RAISE EXCEPTION USING ERRCODE='PA005',MESSAGE='Exact recovery request binding required'; END IF;
 bound:=(p_evidence->>'tokenIssuedAt')::timestamptz-(greatest((p_evidence->>'firstFactorAgeMinutes')::integer,(p_evidence->>'secondFactorAgeMinutes')::integer)+1)*interval '1 minute';
 IF(p_evidence->>'verifiedAt')::timestamptz IS DISTINCT FROM bound OR(p_evidence->>'observedAt')::timestamptz>p_at
  OR(p_evidence->>'observedAt')::timestamptz<p_at-interval '20 seconds' OR(p_evidence->>'tokenIssuedAt')::timestamptz>p_at
  OR(p_evidence->>'expiresAt')::timestamptz<=p_at OR(p_evidence->>'expiresAt')::timestamptz>bound+interval '5 minutes' OR bound+interval '5 minutes'<=p_at THEN
  RAISE EXCEPTION USING ERRCODE='PA005',MESSAGE='Fresh genuine recovery factors required at acceptance'; END IF;
END $$;

-- Row locks serialize this protocol only with a fresh READ COMMITTED snapshot.
-- Never change isolation or commit a transaction owned by the caller.
CREATE FUNCTION pactwoven.access_recovery_require_read_committed() RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN
  RAISE EXCEPTION USING ERRCODE='PA007',MESSAGE='Access recovery requires READ COMMITTED'; END IF;
END $$;

CREATE FUNCTION pactwoven.access_recovery_opposite_insert() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 PERFORM pactwoven.access_recovery_require_read_committed();
 PERFORM id FROM pactwoven.organizations WHERE(environment,id)=(NEW.environment,NEW.organization_id) FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='PA007',MESSAGE='Recovery namespace integrity required'; END IF;
 IF TG_TABLE_NAME='operations' THEN
  IF EXISTS(SELECT 1 FROM pactwoven.member_access_key_fences WHERE(environment,organization_id,kind,idempotency_key)=(NEW.environment,NEW.organization_id,NEW.kind,NEW.idempotency_key)) THEN
   RAISE EXCEPTION USING ERRCODE='PA006',MESSAGE='This access request reference is closed'; END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM pactwoven.operations WHERE(environment,organization_id,kind,idempotency_key)=(NEW.environment,NEW.organization_id,NEW.kind,NEW.idempotency_key)) THEN
   RAISE EXCEPTION USING ERRCODE='PA007',MESSAGE='A recorded access request cannot be fenced'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER access_recovery_operation_insert BEFORE INSERT ON pactwoven.operations FOR EACH ROW WHEN(NEW.kind IN ('member.grant','member.revise','member.revoke')) EXECUTE FUNCTION pactwoven.access_recovery_opposite_insert();
CREATE TRIGGER access_recovery_fence_insert BEFORE INSERT ON pactwoven.member_access_key_fences FOR EACH ROW EXECUTE FUNCTION pactwoven.access_recovery_opposite_insert();

CREATE FUNCTION pactwoven.access_recovery_payload(p_environment text,p_organization text,p_kind text,p_key text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE operation pactwoven.operations%ROWTYPE; fence pactwoven.member_access_key_fences%ROWTYPE;
BEGIN
 SELECT * INTO operation FROM pactwoven.operations WHERE(environment,organization_id,kind,idempotency_key)=(p_environment,p_organization,'member.'||p_kind,p_key);
 SELECT * INTO fence FROM pactwoven.member_access_key_fences WHERE(environment,organization_id,kind,idempotency_key)=(p_environment,p_organization,'member.'||p_kind,p_key);
 IF operation.id IS NOT NULL AND fence.id IS NOT NULL THEN RAISE EXCEPTION USING ERRCODE='PA007',MESSAGE='Conflicting access recovery records'; END IF;
 IF operation.id IS NOT NULL THEN
  IF operation.response->'id' IS DISTINCT FROM to_jsonb(operation.id) OR operation.response->'environment' IS DISTINCT FROM to_jsonb(operation.environment)
   OR operation.response->'aggregateId' IS DISTINCT FROM to_jsonb(operation.aggregate_id) OR operation.response->'financialState' IS DISTINCT FROM 'null'::jsonb THEN
   RAISE EXCEPTION USING ERRCODE='PA007',MESSAGE='Invalid recorded access result'; END IF;
  RETURN jsonb_build_object('disposition','recorded','operation',operation.response);
 END IF;
 IF fence.id IS NOT NULL THEN
  BEGIN
   PERFORM pactwoven.access_recovery_input(fence.environment,fence.identity,p_kind,fence.idempotency_key);
   IF fence.identity->>'externalMembershipId' IS DISTINCT FROM fence.external_membership_id OR fence.identity->>'sessionId' IS DISTINCT FROM fence.session_id
    OR fence.close_intent->>'kind' IS DISTINCT FROM p_kind OR fence.close_intent->'expectedAuthorityEpoch' IS DISTINCT FROM to_jsonb(fence.authority_epoch)
    OR fence.close_intent_hash IS DISTINCT FROM fence.evidence->>'intentHash' OR fence.request_hash IS DISTINCT FROM fence.evidence->>'requestHash' THEN
    RAISE EXCEPTION USING ERRCODE='PA007',MESSAGE='Invalid original closure audit'; END IF;
   PERFORM pactwoven.access_recovery_evidence(fence.environment,fence.identity,fence.closed_by,fence.organization_id,fence.evidence,fence.idempotency_key,fence.close_intent,fence.closed_at);
   IF(fence.identity->>'membershipObservedAt')::timestamptz>fence.closed_at OR(fence.identity->>'membershipObservedAt')::timestamptz<fence.closed_at-interval '20 seconds' THEN
    RAISE EXCEPTION USING ERRCODE='PA007',MESSAGE='Invalid original owner observation'; END IF;
  EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION USING ERRCODE='PA007',MESSAGE='Closure audit could not be verified'; END;
  RETURN jsonb_build_object('disposition','fenced','fence',jsonb_build_object('id',fence.id,'closedAt',to_char(fence.closed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
 END IF;
 RETURN jsonb_build_object('disposition','not_recorded');
END $$;
CREATE FUNCTION pactwoven.access_recovery_envelope(p_environment text,p_identity jsonb,p_owner jsonb,p_kind text,p_key text,p_at timestamptz,p_payload jsonb) RETURNS jsonb LANGUAGE sql SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('schemaVersion',1,'environment',p_environment,'organizationId',p_owner->>'organizationId','externalOrganizationId',p_identity->>'externalOrganizationId',
 'kind',p_kind,'key',p_key,'observedAt',to_char(p_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'reviewer',jsonb_build_object('actorId',p_owner->>'actorId','externalMembershipId',p_identity->>'externalMembershipId','authorityEpoch',p_owner->'authorityEpoch'))||p_payload
$$;
CREATE FUNCTION pactwoven.read_access_recovery(p_environment text,p_identity jsonb,p_kind text,p_key text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE owner_context jsonb; payload jsonb; at_time timestamptz;
BEGIN
 PERFORM pactwoven.access_recovery_require_read_committed();
 PERFORM pactwoven.access_recovery_input(p_environment,p_identity,p_kind,p_key);
 owner_context:=pactwoven.access_owner(p_environment,p_identity);
 payload:=pactwoven.access_recovery_payload(p_environment,owner_context->>'organizationId',p_kind,p_key);
 at_time:=clock_timestamp(); PERFORM pactwoven.access_recovery_owner_acceptance(p_identity,owner_context,at_time);
 RETURN pactwoven.access_recovery_envelope(p_environment,p_identity,owner_context,p_kind,p_key,at_time,payload);
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow OR invalid_text_representation OR numeric_value_out_of_range THEN
 RAISE EXCEPTION USING ERRCODE='PA004',MESSAGE='Invalid recovery request';
END $$;
CREATE FUNCTION pactwoven.close_access_recovery(p_environment text,p_identity jsonb,p_evidence jsonb,p_key text,p_intent jsonb,p_correlation text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE owner_context jsonb; payload jsonb; at_time timestamptz;
BEGIN
 PERFORM pactwoven.access_recovery_require_read_committed();
 PERFORM pactwoven.access_recovery_input(p_environment,p_identity,p_intent->>'kind',p_key);
 IF p_correlation IS NULL OR p_correlation !~ '^[A-Za-z0-9_-]{1,128}$' THEN RAISE EXCEPTION USING ERRCODE='PA004',MESSAGE='Valid correlation reference required'; END IF;
 owner_context:=pactwoven.access_owner(p_environment,p_identity);
 PERFORM pactwoven.access_recovery_evidence(p_environment,p_identity,owner_context->>'actorId',owner_context->>'organizationId',p_evidence,p_key,p_intent,clock_timestamp());
 payload:=pactwoven.access_recovery_payload(p_environment,owner_context->>'organizationId',p_intent->>'kind',p_key);
 IF payload->>'disposition'='not_recorded' THEN
  IF p_intent->'expectedAuthorityEpoch' IS DISTINCT FROM owner_context->'authorityEpoch' THEN RAISE EXCEPTION USING ERRCODE='PA002',MESSAGE='Current closure review epoch required'; END IF;
  INSERT INTO pactwoven.member_access_key_fences(environment,organization_id,kind,idempotency_key,id,closed_at,schema_version,reason,closed_by,external_membership_id,session_id,authority_epoch,identity,close_intent,close_intent_hash,request_hash,evidence)
   VALUES(p_environment,owner_context->>'organizationId','member.'||(p_intent->>'kind'),p_key,gen_random_uuid()::text,clock_timestamp(),1,'original_input_unavailable',owner_context->>'actorId',p_identity->>'externalMembershipId',p_identity->>'sessionId',
    (owner_context->>'authorityEpoch')::integer,p_identity,p_intent,p_evidence->>'intentHash',p_evidence->>'requestHash',p_evidence);
  payload:=pactwoven.access_recovery_payload(p_environment,owner_context->>'organizationId',p_intent->>'kind',p_key);
 END IF;
 at_time:=clock_timestamp();
 PERFORM pactwoven.access_recovery_owner_acceptance(p_identity,owner_context,at_time);
 PERFORM pactwoven.access_recovery_evidence(p_environment,p_identity,owner_context->>'actorId',owner_context->>'organizationId',p_evidence,p_key,p_intent,at_time);
 RETURN pactwoven.access_recovery_envelope(p_environment,p_identity,owner_context,p_intent->>'kind',p_key,at_time,payload);
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow OR invalid_text_representation OR numeric_value_out_of_range THEN
 RAISE EXCEPTION USING ERRCODE='PA004',MESSAGE='Invalid recovery closure request';
END $$;

-- Same legacy entrypoint: isolation and fence checks precede every new access effect.
CREATE OR REPLACE FUNCTION pactwoven.change_member_access(p_environment text,p_identity jsonb,p_evidence jsonb,p_target jsonb,p_kind text,p_actor text,
  p_command jsonb,p_key text,p_hash text,p_correlation text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE owner_context jsonb; target_member pactwoven.memberships%ROWTYPE; prior_operation pactwoven.operations%ROWTYPE;
  payload jsonb:=p_command->'payload'; requested_roles text[]; read_sites text[]; action_sites text[]; target_id text; next_version integer;
  operation_id text:=gen_random_uuid()::text; history_id text:=gen_random_uuid()::text; previous_access jsonb; next_access jsonb; response jsonb;
  at_time timestamptz; acceptance_time timestamptz; verification_bound timestamptz; new_expiry timestamptz;
BEGIN
  PERFORM pactwoven.access_recovery_require_read_committed();
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
  IF EXISTS(SELECT 1 FROM pactwoven.member_access_key_fences WHERE(environment,organization_id,kind,idempotency_key)=(p_environment,owner_context->>'organizationId','member.'||p_kind,p_key)) THEN
    IF prior_operation.id IS NOT NULL THEN RAISE EXCEPTION USING ERRCODE='PA007',MESSAGE='Conflicting access recovery records'; END IF;
    RAISE EXCEPTION USING ERRCODE='PA006',MESSAGE='This access request reference is closed';
  END IF;
  IF prior_operation.id IS NOT NULL THEN
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

REVOKE ALL ON FUNCTION pactwoven.access_recovery_immutable(),pactwoven.access_recovery_canonical(jsonb),pactwoven.access_recovery_hash(jsonb),
 pactwoven.access_recovery_input(text,jsonb,text,text),pactwoven.access_recovery_owner_acceptance(jsonb,jsonb,timestamptz),
 pactwoven.access_recovery_evidence(text,jsonb,text,text,jsonb,text,jsonb,timestamptz),pactwoven.access_recovery_require_read_committed(),pactwoven.access_recovery_opposite_insert(),
 pactwoven.access_recovery_payload(text,text,text,text),pactwoven.access_recovery_envelope(text,jsonb,jsonb,text,text,timestamptz,jsonb),
 pactwoven.read_access_recovery(text,jsonb,text,text),pactwoven.close_access_recovery(text,jsonb,jsonb,text,jsonb,text),
 pactwoven.change_member_access(text,jsonb,jsonb,jsonb,text,text,jsonb,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pactwoven.read_access_recovery(text,jsonb,text,text),pactwoven.close_access_recovery(text,jsonb,jsonb,text,jsonb,text),
 pactwoven.change_member_access(text,jsonb,jsonb,jsonb,text,text,jsonb,text,text,text) TO pactwoven_access_provisioner;
COMMIT;
