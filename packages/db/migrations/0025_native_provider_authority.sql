BEGIN;

-- Administration pins the canonical Clerk instance for each real environment.
-- No API, worker or dispatcher may enroll or read these private tables directly.
CREATE TABLE pactwoven.native_provider_instances (
  environment text PRIMARY KEY CHECK(environment IN ('development','staging','production')),
  issuer text NOT NULL CHECK(char_length(issuer)<=261 AND issuer ~ '^https://([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$'),
  enabled boolean NOT NULL DEFAULT true
);
CREATE TABLE pactwoven.native_provider_authority (
  environment text NOT NULL, organization_id text NOT NULL, task_id text NOT NULL,
  generation bigint NOT NULL CHECK(generation BETWEEN 1 AND 9007199254740991), binding jsonb NOT NULL,
  barrier bigint NOT NULL DEFAULT 0 CHECK(barrier BETWEEN 0 AND 9007199254740991),
  verdict text NOT NULL DEFAULT 'unknown' CHECK(verdict IN ('unknown','allowed','denied')),
  reason text, observed_at timestamptz, valid_until timestamptz,
  nonce uuid UNIQUE, nonce_barrier bigint, prepared_at timestamptz, deadline_at timestamptz,
  PRIMARY KEY(environment,organization_id,task_id),
  FOREIGN KEY(environment,organization_id,task_id) REFERENCES pactwoven.native_tasks(environment,organization_id,id),
  CHECK((verdict='allowed' AND observed_at IS NOT NULL AND valid_until IS NOT NULL AND valid_until>observed_at AND valid_until<=observed_at+interval '20 seconds')
    OR (verdict<>'allowed' AND valid_until IS NULL))
);
ALTER TABLE pactwoven.native_provider_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE pactwoven.native_provider_authority ENABLE ROW LEVEL SECURITY;

-- Caller holds organization/member/task locks. Include policy revisions and
-- exact stored identity, never the browser's current active organization.
CREATE FUNCTION pactwoven.native_provider_binding(p_environment text,p_org text,p_task text) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT jsonb_build_object('providerIssuer',i.issuer,'sessionId',t.session_id,'subject',m.external_subject,
    'externalOrganizationId',o.external_organization_id,'externalMembershipId',m.external_membership_id,
    'requiredRole',CASE WHEN m.grant_basis='clerk_admin_bootstrap' THEN 'org:admin' ELSE NULL END,
    'actorId',t.actor_id,'siteId',t.site_id,'memberVersion',m.row_version,'memberRoles',m.roles,
    'memberStatus',m.status,'memberExpiry',m.expires_at,'organizationEpoch',o.authority_epoch)
  FROM pactwoven.native_tasks t JOIN pactwoven.memberships m ON (m.environment,m.organization_id,m.actor_id)=(t.environment,t.organization_id,t.actor_id)
    JOIN pactwoven.organizations o ON (o.environment,o.id)=(t.environment,t.organization_id)
    JOIN pactwoven.native_provider_instances i ON i.environment=t.environment AND i.enabled
  WHERE (t.environment,t.organization_id,t.id)=(p_environment,p_org,p_task)
    AND t.session_id ~ '^[A-Za-z0-9_-]+$' AND char_length(t.session_id)<=256 AND m.external_subject ~ '^[A-Za-z0-9_-]+$' AND char_length(m.external_subject)<=256
    AND o.external_organization_id ~ '^[A-Za-z0-9_-]+$' AND char_length(o.external_organization_id)<=256 AND m.external_membership_id ~ '^[A-Za-z0-9_-]+$' AND char_length(m.external_membership_id)<=256
$$;

CREATE FUNCTION pactwoven.native_provider_status(p_environment text,p_org text,p_task text,p_generation bigint) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a pactwoven.native_provider_authority%ROWTYPE; current_binding jsonb;
BEGIN
  -- Explicit simulation remains synthetic local authority. Service enrollment
  -- still binds the caller to simulation; hosted services accept development only.
  IF p_environment='simulation' THEN RETURN 'allowed'; END IF;
  current_binding:=pactwoven.native_provider_binding(p_environment,p_org,p_task);
  SELECT * INTO a FROM pactwoven.native_provider_authority WHERE (environment,organization_id,task_id)=(p_environment,p_org,p_task);
  IF NOT FOUND OR current_binding IS NULL OR a.generation<>p_generation OR a.binding IS DISTINCT FROM current_binding THEN RETURN 'unknown'; END IF;
  IF a.verdict='denied' THEN RETURN 'denied'; END IF;
  IF a.verdict='allowed' AND a.valid_until>clock_timestamp() THEN RETURN 'allowed'; END IF;
  RETURN 'unknown';
END $$;

CREATE FUNCTION pactwoven.native_provider_result(p_state text,p_observed timestamptz,p_until timestamptz) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT jsonb_build_object('state',p_state,'observedAt',p_observed,'validUntil',p_until)
    || CASE WHEN p_state='unavailable' THEN '{"retryAfterMilliseconds":1000}'::jsonb ELSE '{}'::jsonb END
$$;

CREATE FUNCTION pactwoven.native_provider_authority_prepare(p_environment text,p_message jsonb,p_expected_issuer text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE candidate pactwoven.native_tasks%ROWTYPE; t pactwoven.native_tasks%ROWTYPE; a pactwoven.native_provider_authority%ROWTYPE;
  current_binding jsonb; now_at timestamptz; permitted boolean; result jsonb;
BEGIN
  IF NOT pactwoven.native_task_binding(p_environment,'api') OR p_message->>'environment' IS DISTINCT FROM p_environment THEN
    RAISE EXCEPTION USING ERRCODE='NT001',MESSAGE='API authority access required'; END IF;
  IF jsonb_typeof(p_message) IS DISTINCT FROM 'object' OR p_message->'schemaVersion' IS DISTINCT FROM '1'::jsonb
    OR p_message->>'engineRevision' IS DISTINCT FROM 'native-advice-v1'
    OR jsonb_typeof(p_message->'generation') IS DISTINCT FROM 'number' OR p_message->>'generation' !~ '^[1-9][0-9]{0,15}$'
    OR (p_message->>'generation')::numeric>9007199254740991
    OR coalesce(p_message->>'organizationId','') !~ '^[A-Za-z0-9_-]{1,128}$' OR coalesce(p_message->>'taskId','') !~ '^[A-Za-z0-9_-]{1,128}$'
    OR p_message-ARRAY['schemaVersion','engineRevision','environment','organizationId','taskId','generation']<>'{}'::jsonb
    OR p_expected_issuer IS NULL OR char_length(p_expected_issuer)>261
    OR p_expected_issuer !~ '^https://([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$' THEN
    RAISE EXCEPTION USING ERRCODE='NT004',MESSAGE='Invalid authority preparation'; END IF;
  IF p_environment<>'simulation' AND EXISTS(SELECT 1 FROM pactwoven.native_provider_instances WHERE environment=p_environment AND issuer<>p_expected_issuer) THEN
    RAISE EXCEPTION USING ERRCODE='NT001',MESSAGE='Provider instance does not match enrollment'; END IF;
  SELECT * INTO candidate FROM pactwoven.native_tasks WHERE (environment,organization_id,id)=(p_environment,p_message->>'organizationId',p_message->>'taskId');
  IF NOT FOUND THEN RETURN jsonb_build_object('kind','settled','result',pactwoven.native_provider_result('stale',NULL,NULL)); END IF;
  permitted:=pactwoven.native_task_owner_valid(candidate.environment,candidate.organization_id,candidate.actor_id,candidate.session_id,candidate.site_id);
  SELECT * INTO t FROM pactwoven.native_tasks WHERE (environment,organization_id,id)=(candidate.environment,candidate.organization_id,candidate.id) FOR UPDATE;
  IF t.dispatch_generation<>(p_message->>'generation')::bigint OR t.dispatch_engine_revision IS DISTINCT FROM p_message->>'engineRevision'
    OR t.status NOT IN ('queued','running') THEN RETURN jsonb_build_object('kind','settled','result',pactwoven.native_provider_result('stale',NULL,NULL)); END IF;
  permitted:=pactwoven.native_task_owner_valid(t.environment,t.organization_id,t.actor_id,t.session_id,t.site_id);
  IF NOT permitted THEN
    PERFORM pactwoven.native_dispatch_pause(t.environment,t.organization_id,t.id,true);
    RETURN jsonb_build_object('kind','settled','result',pactwoven.native_provider_result('denied',clock_timestamp(),NULL)); END IF;
  now_at:=clock_timestamp();
  IF p_environment='simulation' THEN RETURN jsonb_build_object('kind','settled','result',pactwoven.native_provider_result('allowed',now_at,now_at+interval '20 seconds')); END IF;
  current_binding:=pactwoven.native_provider_binding(p_environment,t.organization_id,t.id);
  IF current_binding IS NULL THEN RETURN jsonb_build_object('kind','settled','result',pactwoven.native_provider_result('unavailable',NULL,NULL)); END IF;
  IF current_binding->>'providerIssuer' IS DISTINCT FROM p_expected_issuer THEN RAISE EXCEPTION USING ERRCODE='NT001',MESSAGE='Provider instance changed'; END IF;
  INSERT INTO pactwoven.native_provider_authority(environment,organization_id,task_id,generation,binding)
    VALUES(p_environment,t.organization_id,t.id,t.dispatch_generation,current_binding) ON CONFLICT DO NOTHING;
  SELECT * INTO a FROM pactwoven.native_provider_authority WHERE (environment,organization_id,task_id)=(p_environment,t.organization_id,t.id) FOR UPDATE;
  IF a.generation=t.dispatch_generation AND a.binding=current_binding AND a.nonce IS NOT NULL AND a.deadline_at>clock_timestamp() THEN
    RETURN jsonb_build_object('kind','pending','retryAfterMilliseconds',least(8000,greatest(1,ceil(extract(epoch FROM (a.deadline_at-clock_timestamp()))*1000)))); END IF;
  now_at:=clock_timestamp();
  UPDATE pactwoven.native_provider_authority SET
    verdict=CASE WHEN generation=t.dispatch_generation AND binding=current_binding THEN verdict ELSE 'unknown' END,
    valid_until=CASE WHEN generation=t.dispatch_generation AND binding=current_binding THEN valid_until ELSE NULL END,
    observed_at=CASE WHEN generation=t.dispatch_generation AND binding=current_binding THEN observed_at ELSE NULL END,
    barrier=barrier+1,nonce_barrier=barrier+1,generation=t.dispatch_generation,binding=current_binding,
    nonce=gen_random_uuid(),prepared_at=now_at,deadline_at=now_at+interval '8 seconds'
    WHERE (environment,organization_id,task_id)=(p_environment,t.organization_id,t.id) RETURNING * INTO a;
  RETURN jsonb_build_object('kind','prepared','nonce',a.nonce,'dispatch',p_message,'providerIssuer',current_binding->>'providerIssuer',
    'preparedAt',a.prepared_at,'deadlineAt',a.deadline_at,'context',current_binding-ARRAY['providerIssuer','actorId','siteId','memberVersion','memberRoles','memberStatus','memberExpiry','organizationEpoch']);
END $$;

CREATE FUNCTION pactwoven.native_provider_authority_finish(p_environment text,p_nonce uuid,p_verdict jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE candidate pactwoven.native_provider_authority%ROWTYPE; a pactwoven.native_provider_authority%ROWTYPE; t pactwoven.native_tasks%ROWTYPE;
  task_candidate pactwoven.native_tasks%ROWTYPE; permitted boolean; current_binding jsonb; observed_start timestamptz; observed_end timestamptz;
  provider_expiry timestamptz; until_at timestamptz; state text; observed_reason text;
  instant_pattern text:='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$';
BEGIN
  IF NOT pactwoven.native_task_binding(p_environment,'api') THEN RAISE EXCEPTION USING ERRCODE='NT001',MESSAGE='API authority access required'; END IF;
  state:=p_verdict->>'state'; observed_reason:=p_verdict->>'reason';
  IF p_nonce IS NULL OR jsonb_typeof(p_verdict) IS DISTINCT FROM 'object' OR state IS NULL OR state NOT IN ('allowed','denied','unavailable')
    OR p_verdict-ARRAY['state','reason','observationStartedAt','observationCompletedAt','providerExpiresAt']<>'{}'::jsonb
    OR jsonb_typeof(p_verdict->'observationStartedAt') IS DISTINCT FROM 'string' OR jsonb_typeof(p_verdict->'observationCompletedAt') IS DISTINCT FROM 'string'
    OR char_length(p_verdict->>'observationStartedAt')>40 OR char_length(p_verdict->>'observationCompletedAt')>40
    OR p_verdict->>'observationStartedAt' !~ instant_pattern OR p_verdict->>'observationCompletedAt' !~ instant_pattern
    OR NOT (p_verdict ? 'providerExpiresAt') OR (p_verdict->'providerExpiresAt'<>'null'::jsonb AND
      (jsonb_typeof(p_verdict->'providerExpiresAt') IS DISTINCT FROM 'string' OR char_length(p_verdict->>'providerExpiresAt')>40 OR p_verdict->>'providerExpiresAt' !~ instant_pattern)) THEN
    RAISE EXCEPTION USING ERRCODE='NT004',MESSAGE='Invalid authority observation'; END IF;
  observed_start:=(p_verdict->>'observationStartedAt')::timestamptz; observed_end:=(p_verdict->>'observationCompletedAt')::timestamptz;
  provider_expiry:=(p_verdict->>'providerExpiresAt')::timestamptz;
  IF NOT isfinite(observed_start) OR NOT isfinite(observed_end) OR observed_start>observed_end OR (provider_expiry IS NOT NULL AND NOT isfinite(provider_expiry))
    OR observed_reason IS NULL OR (state='allowed' AND (observed_reason<>'current' OR provider_expiry IS NULL OR provider_expiry<=observed_end))
    OR (state='denied' AND observed_reason NOT IN ('session_missing','session_inactive','session_expired','user_missing','user_banned','user_locked','user_deprovisioned','organization_missing','membership_removed','membership_replaced','required_role_removed'))
    OR (state='unavailable' AND (provider_expiry IS NOT NULL OR observed_reason NOT IN ('invalid_context','invalid_deadline','cancelled','deadline_exceeded','clock_invalid','provider_auth','rate_limited','provider_unavailable','network','malformed_response'))) THEN
    RAISE EXCEPTION USING ERRCODE='NT004',MESSAGE='Authority observation state does not match'; END IF;
  SELECT * INTO candidate FROM pactwoven.native_provider_authority WHERE environment=p_environment AND nonce=p_nonce;
  IF NOT FOUND THEN RETURN pactwoven.native_provider_result('stale',NULL,NULL); END IF;
  SELECT * INTO task_candidate FROM pactwoven.native_tasks WHERE (environment,organization_id,id)=(candidate.environment,candidate.organization_id,candidate.task_id);
  permitted:=pactwoven.native_task_owner_valid(task_candidate.environment,task_candidate.organization_id,task_candidate.actor_id,task_candidate.session_id,task_candidate.site_id);
  SELECT * INTO t FROM pactwoven.native_tasks WHERE (environment,organization_id,id)=(candidate.environment,candidate.organization_id,candidate.task_id) FOR UPDATE;
  SELECT * INTO a FROM pactwoven.native_provider_authority WHERE (environment,organization_id,task_id)=(candidate.environment,candidate.organization_id,candidate.task_id) FOR UPDATE;
  current_binding:=pactwoven.native_provider_binding(t.environment,t.organization_id,t.id);
  IF a.nonce IS DISTINCT FROM p_nonce OR a.nonce_barrier IS DISTINCT FROM a.barrier OR a.generation<>t.dispatch_generation
    OR current_binding IS NULL OR a.binding IS DISTINCT FROM current_binding OR t.status NOT IN ('queued','running') THEN RETURN pactwoven.native_provider_result('stale',NULL,NULL); END IF;
  permitted:=pactwoven.native_task_owner_valid(t.environment,t.organization_id,t.actor_id,t.session_id,t.site_id);
  IF NOT permitted THEN state:='denied'; observed_reason:='local_access_removed'; END IF;
  IF a.deadline_at<=clock_timestamp() THEN state:='unavailable'; observed_reason:='deadline_exceeded'; END IF;
  until_at:=least(a.prepared_at+interval '20 seconds',provider_expiry);
  IF state='allowed' AND (until_at IS NULL OR until_at<=clock_timestamp()) THEN state:='unavailable'; observed_reason:='deadline_exceeded'; END IF;
  UPDATE pactwoven.native_provider_authority SET verdict=CASE state WHEN 'allowed' THEN 'allowed' WHEN 'denied' THEN 'denied' ELSE 'unknown' END,
    reason=observed_reason,observed_at=a.prepared_at,valid_until=CASE WHEN state='allowed' THEN until_at ELSE NULL END,
    nonce=NULL,nonce_barrier=NULL,barrier=barrier+CASE WHEN state='denied' THEN 1 ELSE 0 END
    WHERE (environment,organization_id,task_id)=(a.environment,a.organization_id,a.task_id);
  IF state='denied' THEN
    PERFORM pactwoven.native_dispatch_pause(t.environment,t.organization_id,t.id,true);
    UPDATE pactwoven.native_dispatch_outbox d SET state='superseded',publisher_id=NULL,publication_token=NULL,publication_lease_until=NULL
      WHERE (d.environment,d.organization_id,d.task_id)=(t.environment,t.organization_id,t.id) AND d.state NOT IN ('superseded','quarantined');
  END IF;
  -- A late finish cannot publish a proof whose bound expired while writing it.
  IF state='allowed' AND (a.deadline_at<=clock_timestamp() OR until_at<=clock_timestamp()) THEN
    UPDATE pactwoven.native_provider_authority SET verdict='unknown',valid_until=NULL,reason='deadline_exceeded'
      WHERE (environment,organization_id,task_id)=(a.environment,a.organization_id,a.task_id);
    state:='unavailable'; END IF;
  RETURN pactwoven.native_provider_result(state,a.prepared_at,CASE WHEN state='allowed' THEN until_at ELSE NULL END);
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow OR invalid_text_representation THEN
  RAISE EXCEPTION USING ERRCODE='NT004',MESSAGE='Invalid authority observation time';
END $$;

CREATE OR REPLACE FUNCTION pactwoven.native_task_lease(p_environment text,p_org text,p_id text,p_token uuid,p_kind text,p_lease_ms integer,p_update jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE t pactwoven.native_tasks%ROWTYPE; candidate pactwoven.native_tasks%ROWTYPE; permitted boolean; next_status text; n integer; m jsonb; a jsonb; existing jsonb; publication_deadline timestamptz; provider_state text;
BEGIN
  IF NOT pactwoven.native_task_binding(p_environment,'worker') THEN RAISE EXCEPTION USING ERRCODE='NT001',MESSAGE='Worker access required'; END IF;
  SELECT * INTO candidate FROM pactwoven.native_tasks WHERE (environment,organization_id,id)=(p_environment,p_org,p_id);
  IF NOT FOUND THEN RETURN false; END IF;
  permitted:=pactwoven.native_task_owner_valid(candidate.environment,candidate.organization_id,candidate.actor_id,candidate.session_id,candidate.site_id);
  SELECT * INTO t FROM pactwoven.native_tasks WHERE (environment,organization_id,id)=(p_environment,p_org,p_id) FOR UPDATE;
  IF NOT FOUND OR t.status<>'running' OR t.lease_token IS DISTINCT FROM p_token OR t.lease_until<=clock_timestamp() OR t.session_id<>candidate.session_id THEN RETURN false; END IF;
  permitted:=pactwoven.native_task_owner_valid(t.environment,t.organization_id,t.actor_id,t.session_id,t.site_id);
  IF NOT permitted THEN
    UPDATE pactwoven.native_tasks SET status='paused',phase='Access needs review',lease_token=NULL,lease_until=NULL,worker_id=NULL,
      row_version=row_version+1,updated_at=clock_timestamp() WHERE (environment,organization_id,id)=(p_environment,p_org,p_id);
    PERFORM pactwoven.native_task_event(p_environment,p_org,p_id,jsonb_build_object('kind','paused','title','Access needs review','detail','Review the current company access before resuming.','agent',NULL));
    RETURN false;
  END IF;
  provider_state:=pactwoven.native_provider_status(t.environment,t.organization_id,t.id,t.dispatch_generation);
  IF provider_state='denied' THEN
    PERFORM pactwoven.native_dispatch_pause(t.environment,t.organization_id,t.id,true); RETURN false;
  ELSIF provider_state<>'allowed' THEN RETURN false; END IF;
  IF p_kind='renew' THEN
    IF p_lease_ms IS NULL OR p_lease_ms NOT BETWEEN 1000 AND 300000 THEN RAISE EXCEPTION USING ERRCODE='NT004',MESSAGE='Invalid worker lease'; END IF;
    UPDATE pactwoven.native_tasks SET lease_until=clock_timestamp()+p_lease_ms*interval '1 millisecond' WHERE (environment,organization_id,id)=(p_environment,p_org,p_id);
    IF pactwoven.native_provider_status(t.environment,t.organization_id,t.id,t.dispatch_generation)<>'allowed' THEN
      RAISE EXCEPTION USING ERRCODE='NT009',MESSAGE='Provider authority is not current'; END IF;
    RETURN true;
  ELSIF p_kind='release' THEN
    UPDATE pactwoven.native_tasks SET status='queued',phase='Ready to continue',lease_token=NULL,lease_until=NULL,worker_id=NULL,
      row_version=row_version+1,updated_at=clock_timestamp() WHERE (environment,organization_id,id)=(p_environment,p_org,p_id);
    IF pactwoven.native_provider_status(t.environment,t.organization_id,t.id,t.dispatch_generation)<>'allowed' THEN
      RAISE EXCEPTION USING ERRCODE='NT009',MESSAGE='Provider authority is not current'; END IF;
    RETURN true;
  ELSIF p_kind<>'progress' THEN RAISE EXCEPTION USING ERRCODE='NT004',MESSAGE='Invalid worker action'; END IF;
  next_status:=coalesce(p_update->>'status','running');
  IF p_update IS NULL OR next_status NOT IN ('running','waiting_for_input','waiting_for_reply','completed','failed')
    OR coalesce(char_length(p_update->>'phase'),0) NOT BETWEEN 1 AND 180
    OR jsonb_typeof(p_update->'checkpoint') IS DISTINCT FROM 'object' OR octet_length((p_update->'checkpoint')::text)>262144
    OR (p_update ? 'steps' AND (jsonb_typeof(p_update->'steps')<>'array' OR jsonb_array_length(p_update->'steps')>32)) THEN
    RAISE EXCEPTION USING ERRCODE='NT004',MESSAGE='Invalid progress'; END IF;
  IF (next_status IN ('completed','failed') AND p_update#>>'{event,kind}' IS DISTINCT FROM next_status)
    OR (next_status NOT IN ('completed','failed') AND p_update#>>'{event,kind}' NOT IN ('progress','message','artifact')) THEN
    RAISE EXCEPTION USING ERRCODE='NT004',MESSAGE='Progress event does not match state'; END IF;
  publication_deadline:=pactwoven.native_task_completion_deadline(p_update);
  IF publication_deadline IS NOT NULL AND publication_deadline<=clock_timestamp() THEN
    RAISE EXCEPTION USING ERRCODE='NT008',MESSAGE='Completion evidence expired'; END IF;
  m:=p_update->'message';a:=p_update->'artifact';
  IF m IS NOT NULL THEN
    IF m->>'role' IS DISTINCT FROM 'assistant' THEN RAISE EXCEPTION USING ERRCODE='NT004',MESSAGE='Worker cannot write user messages'; END IF;
    SELECT jsonb_build_object('id',id,'role',role,'text',body) INTO existing FROM pactwoven.native_task_messages
      WHERE (environment,organization_id,task_id,id)=(p_environment,p_org,p_id,m->>'id');
    IF FOUND THEN
      IF existing IS DISTINCT FROM m THEN RAISE EXCEPTION USING ERRCODE='NT003',MESSAGE='Message identity reused'; END IF;
    ELSE
      SELECT count(*) INTO n FROM pactwoven.native_task_messages WHERE (environment,organization_id,task_id)=(p_environment,p_org,p_id);
      IF n>=100 THEN RAISE EXCEPTION USING ERRCODE='NT007',MESSAGE='Task conversation is full'; END IF;
      INSERT INTO pactwoven.native_task_messages(environment,organization_id,task_id,id,role,body,ordinal) VALUES(p_environment,p_org,p_id,m->>'id','assistant',m->>'text',n+1);
    END IF;
  END IF;
  IF a IS NOT NULL THEN
    SELECT jsonb_build_object('id',id,'kind',kind,'title',title,'text',body,'sources',sources) INTO existing FROM pactwoven.native_task_artifacts
      WHERE (environment,organization_id,task_id,id)=(p_environment,p_org,p_id,a->>'id');
    IF FOUND THEN
      IF existing IS DISTINCT FROM a THEN RAISE EXCEPTION USING ERRCODE='NT003',MESSAGE='Artifact identity reused'; END IF;
    ELSE
      SELECT count(*) INTO n FROM pactwoven.native_task_artifacts WHERE (environment,organization_id,task_id)=(p_environment,p_org,p_id);
      IF n>=32 THEN RAISE EXCEPTION USING ERRCODE='NT007',MESSAGE='Task results are full'; END IF;
      INSERT INTO pactwoven.native_task_artifacts(environment,organization_id,task_id,id,kind,title,body,sources,ordinal)
        VALUES(p_environment,p_org,p_id,a->>'id',a->>'kind',a->>'title',a->>'text',a->'sources',n+1);
    END IF;
  END IF;
  UPDATE pactwoven.native_tasks SET title=coalesce(p_update->>'title',title),phase=p_update->>'phase',status=next_status,
    steps=coalesce(p_update->'steps',steps),checkpoint=p_update->'checkpoint',row_version=row_version+1,updated_at=clock_timestamp(),
    lease_token=CASE WHEN next_status='running' THEN lease_token ELSE NULL END,
    lease_until=CASE WHEN next_status='running' THEN lease_until ELSE NULL END,
    worker_id=CASE WHEN next_status='running' THEN worker_id ELSE NULL END WHERE (environment,organization_id,id)=(p_environment,p_org,p_id);
  PERFORM pactwoven.native_task_event(p_environment,p_org,p_id,p_update->'event');
  -- This check follows every candidate write while the task row is locked. An
  -- expired bound rolls the whole statement back, including message/artifact,
  -- checkpoint, event and dispatch-trigger effects. It is not a COMMIT clock guarantee.
  IF publication_deadline IS NOT NULL AND publication_deadline<=clock_timestamp() THEN
    RAISE EXCEPTION USING ERRCODE='NT008',MESSAGE='Completion evidence expired'; END IF;
  IF pactwoven.native_provider_status(t.environment,t.organization_id,t.id,t.dispatch_generation)<>'allowed' THEN
    RAISE EXCEPTION USING ERRCODE='NT009',MESSAGE='Provider authority is not current'; END IF;
  RETURN true;
EXCEPTION WHEN SQLSTATE 'NT009' THEN
  -- PL/pgSQL rolls this block's candidate writes back before returning false.
  -- Unknown provider availability is not an assertion of account revocation.
  RETURN false;
END $$;

CREATE OR REPLACE FUNCTION pactwoven.native_dispatch_admit(p_environment text,p_message jsonb,p_worker text,p_lease_ms integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE candidate pactwoven.native_tasks%ROWTYPE; t pactwoven.native_tasks%ROWTYPE; permitted boolean; delay_ms bigint; provider_state text;
BEGIN
  IF NOT pactwoven.native_task_binding(p_environment,'worker') OR p_message->>'environment' IS DISTINCT FROM p_environment THEN
    RAISE EXCEPTION USING ERRCODE='NT001',MESSAGE='Worker access required'; END IF;
  IF p_message->>'schemaVersion' IS DISTINCT FROM '1' OR p_message->>'engineRevision' IS DISTINCT FROM 'native-advice-v1' THEN RETURN '{"kind":"revision_mismatch"}'::jsonb; END IF;
  IF p_worker IS NULL OR p_worker !~ '^[A-Za-z0-9_-]{1,128}$' OR p_lease_ms IS NULL OR p_lease_ms NOT BETWEEN 1000 AND 300000
    OR jsonb_typeof(p_message->'generation') IS DISTINCT FROM 'number' OR p_message->>'generation' !~ '^[1-9][0-9]{0,15}$'
    OR (p_message->>'generation')::bigint>9007199254740991 THEN RAISE EXCEPTION USING ERRCODE='NT004',MESSAGE='Invalid targeted claim'; END IF;
  SELECT * INTO candidate FROM pactwoven.native_tasks WHERE (environment,organization_id,id)=(p_environment,p_message->>'organizationId',p_message->>'taskId');
  IF NOT FOUND THEN RETURN '{"kind":"not_found"}'::jsonb; END IF;
  permitted:=pactwoven.native_task_owner_valid(candidate.environment,candidate.organization_id,candidate.actor_id,candidate.session_id,candidate.site_id);
  SELECT * INTO t FROM pactwoven.native_tasks WHERE (environment,organization_id,id)=(candidate.environment,candidate.organization_id,candidate.id) FOR UPDATE;
  IF t.dispatch_generation<>(p_message->>'generation')::bigint THEN RETURN '{"kind":"stale"}'::jsonb; END IF;
  IF t.dispatch_engine_revision IS DISTINCT FROM p_message->>'engineRevision' THEN RETURN '{"kind":"revision_mismatch"}'::jsonb; END IF;
  IF EXISTS(SELECT 1 FROM pactwoven.native_dispatch_outbox WHERE (environment,organization_id,task_id,generation)=(t.environment,t.organization_id,t.id,t.dispatch_generation) AND state='quarantined') THEN RETURN '{"kind":"quarantined"}'::jsonb; END IF;
  IF t.status NOT IN ('queued','running') THEN RETURN '{"kind":"inactive"}'::jsonb; END IF;
  permitted:=pactwoven.native_task_owner_valid(t.environment,t.organization_id,t.actor_id,t.session_id,t.site_id);
  IF NOT permitted THEN
    PERFORM pactwoven.native_dispatch_pause(t.environment,t.organization_id,t.id,true); RETURN '{"kind":"revoked"}'::jsonb;
  END IF;
  provider_state:=pactwoven.native_provider_status(t.environment,t.organization_id,t.id,t.dispatch_generation);
  IF provider_state='denied' THEN
    PERFORM pactwoven.native_dispatch_pause(t.environment,t.organization_id,t.id,true); RETURN '{"kind":"revoked"}'::jsonb;
  ELSIF provider_state<>'allowed' THEN RETURN '{"kind":"not_ready","retryAfterMilliseconds":1000}'::jsonb; END IF;
  IF t.status='running' THEN
    delay_ms:=least(86400000,greatest(1000,ceil(extract(epoch FROM (t.lease_until-clock_timestamp()))*1000)));
    RETURN jsonb_build_object('kind','busy','retryAfterMilliseconds',delay_ms);
  END IF;
  IF t.runnable_at>clock_timestamp() THEN
    delay_ms:=least(86400000,greatest(1,ceil(extract(epoch FROM (t.runnable_at-clock_timestamp()))*1000)));
    RETURN jsonb_build_object('kind','not_ready','retryAfterMilliseconds',delay_ms);
  END IF;
  -- Queue acceptance may still be in flight. A committed outbox is sufficient;
  -- the publisher's acknowledgement is not execution authority.
  UPDATE pactwoven.native_tasks SET status='running',phase='Working on your request',worker_id=p_worker,lease_token=gen_random_uuid(),
    lease_until=clock_timestamp()+p_lease_ms*interval '1 millisecond',row_version=row_version+1,updated_at=clock_timestamp()
    WHERE (environment,organization_id,id)=(t.environment,t.organization_id,t.id) RETURNING * INTO t;
  PERFORM pactwoven.native_task_event(t.environment,t.organization_id,t.id,jsonb_build_object('kind','progress','title','The team started work','detail','','agent','coordinator'));
  IF pactwoven.native_provider_status(t.environment,t.organization_id,t.id,t.dispatch_generation)<>'allowed' THEN
    RAISE EXCEPTION USING ERRCODE='NT009',MESSAGE='Provider authority is not current'; END IF;
  RETURN jsonb_build_object('kind','claimed','dispatch',pactwoven.native_dispatch_message(t.environment,t.organization_id,t.id,t.dispatch_generation,t.dispatch_engine_revision),
    'claim',jsonb_build_object('task',pactwoven.native_task_view(t.environment,t.organization_id,t.id,true),'environment',t.environment,'organizationId',t.organization_id,
      'actorId',t.actor_id,'leaseToken',t.lease_token,'checkpoint',t.checkpoint));
EXCEPTION WHEN SQLSTATE 'NT009' THEN RETURN '{"kind":"not_ready","retryAfterMilliseconds":1000}'::jsonb;
END $$;

CREATE OR REPLACE FUNCTION pactwoven.native_dispatch_yield(p_environment text,p_message jsonb,p_token uuid,p_progress jsonb,p_delay_ms integer) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE candidate pactwoven.native_tasks%ROWTYPE; t pactwoven.native_tasks%ROWTYPE; BEGIN
  IF NOT pactwoven.native_task_binding(p_environment,'worker') OR p_message->>'environment' IS DISTINCT FROM p_environment THEN RAISE EXCEPTION USING ERRCODE='NT001',MESSAGE='Worker access required'; END IF;
  IF p_message->>'schemaVersion' IS DISTINCT FROM '1' OR p_message->>'engineRevision' IS DISTINCT FROM 'native-advice-v1'
    OR p_delay_ms IS NULL OR p_delay_ms NOT BETWEEN 0 AND 86400000 OR p_progress IS NULL
    OR coalesce(p_progress->>'status','running')<>'running' OR p_progress#>>'{event,kind}' NOT IN ('progress','message','artifact') THEN
    RAISE EXCEPTION USING ERRCODE='NT004',MESSAGE='Invalid continuation'; END IF;
  SELECT * INTO candidate FROM pactwoven.native_tasks WHERE (environment,organization_id,id)=(p_environment,p_message->>'organizationId',p_message->>'taskId');
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM pactwoven.native_task_owner_valid(candidate.environment,candidate.organization_id,candidate.actor_id,candidate.session_id,candidate.site_id);
  SELECT * INTO t FROM pactwoven.native_tasks WHERE (environment,organization_id,id)=(candidate.environment,candidate.organization_id,candidate.id) FOR UPDATE;
  IF t.dispatch_generation::text IS DISTINCT FROM p_message->>'generation' OR t.dispatch_engine_revision IS DISTINCT FROM p_message->>'engineRevision'
    OR t.status<>'running' OR t.lease_token IS DISTINCT FROM p_token OR t.lease_until<=clock_timestamp() THEN RETURN false; END IF;
  IF NOT pactwoven.native_task_lease(p_environment,t.organization_id,t.id,p_token,'progress',NULL,p_progress) THEN RETURN false; END IF;
  UPDATE pactwoven.native_tasks SET status='queued',phase='Ready to continue',worker_id=NULL,lease_token=NULL,lease_until=NULL,
    runnable_at=clock_timestamp()+p_delay_ms*interval '1 millisecond',row_version=row_version+1,updated_at=clock_timestamp()
    WHERE (environment,organization_id,id)=(p_environment,t.organization_id,t.id);
  -- Yield advanced the task generation. Check the captured generation for this
  -- write; the next targeted claim must obtain a proof for the new generation.
  IF pactwoven.native_provider_status(t.environment,t.organization_id,t.id,t.dispatch_generation)<>'allowed' THEN
    RAISE EXCEPTION USING ERRCODE='NT009',MESSAGE='Provider authority is not current'; END IF;
  RETURN true;
EXCEPTION WHEN SQLSTATE 'NT009' THEN RETURN false;
END $$;

REVOKE ALL ON FUNCTION pactwoven.native_provider_binding(text,text,text),pactwoven.native_provider_status(text,text,text,bigint),
  pactwoven.native_provider_result(text,timestamptz,timestamptz),pactwoven.native_provider_authority_prepare(text,jsonb,text),
  pactwoven.native_provider_authority_finish(text,uuid,jsonb)
  FROM PUBLIC,pactwoven_runtime,pactwoven_native_task_api,pactwoven_native_task_worker,pactwoven_native_task_dispatcher;
GRANT EXECUTE ON FUNCTION pactwoven.native_provider_authority_prepare(text,jsonb,text),pactwoven.native_provider_authority_finish(text,uuid,jsonb)
  TO pactwoven_native_task_api;
-- Existing claim/lease/yield signatures and grants are preserved. Completion
-- evidence guards from immutable 0024 remain inside the replaced lease writer.
COMMIT;
