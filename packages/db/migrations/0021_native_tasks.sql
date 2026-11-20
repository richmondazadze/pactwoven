BEGIN;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='pactwoven_native_task_api') THEN
    CREATE ROLE pactwoven_native_task_api NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='pactwoven_native_task_worker') THEN
    CREATE ROLE pactwoven_native_task_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;
GRANT USAGE ON SCHEMA pactwoven TO pactwoven_native_task_api,pactwoven_native_task_worker;

-- Enrollment is performed by migration administration, never either service.
-- OID plus name prevents a dropped/recreated login inheriting a stale enrollment.
CREATE TABLE pactwoven.native_task_service_bindings (
  role_name name NOT NULL, role_oid oid NOT NULL,
  environment text NOT NULL CHECK(environment IN ('simulation','development','staging','production')),
  purpose text NOT NULL CHECK(purpose IN ('api','worker')),
  enabled boolean NOT NULL DEFAULT true,
  PRIMARY KEY(role_name,environment,purpose)
);
CREATE TABLE pactwoven.native_tasks (
  environment text NOT NULL, organization_id text NOT NULL, id text NOT NULL,
  actor_id text NOT NULL, session_id text NOT NULL, site_id text NOT NULL,
  title text NOT NULL CHECK(char_length(title) BETWEEN 1 AND 180),
  prompt text NOT NULL CHECK(char_length(prompt) BETWEEN 1 AND 12000),
  mode text NOT NULL DEFAULT 'advise' CHECK(mode='advise'),
  status text NOT NULL CHECK(status IN ('queued','running','waiting_for_input','waiting_for_reply','paused','completed','failed','cancelled')),
  phase text NOT NULL CHECK(char_length(phase) BETWEEN 1 AND 180),
  steps jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(steps)='array' AND jsonb_array_length(steps)<=32),
  checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(checkpoint)='object' AND octet_length(checkpoint::text)<=262144),
  row_version integer NOT NULL DEFAULT 1 CHECK(row_version>0),
  last_sequence bigint NOT NULL DEFAULT 0 CHECK(last_sequence BETWEEN 0 AND 9007199254740991),
  worker_id text, lease_token uuid, lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(environment,organization_id,id),
  FOREIGN KEY(environment,organization_id,actor_id) REFERENCES pactwoven.memberships(environment,organization_id,actor_id),
  FOREIGN KEY(environment,organization_id,site_id) REFERENCES pactwoven.sites(environment,organization_id,id),
  CHECK((worker_id IS NULL AND lease_token IS NULL AND lease_until IS NULL)
     OR (worker_id IS NOT NULL AND lease_token IS NOT NULL AND lease_until IS NOT NULL AND status='running'))
);
CREATE INDEX native_task_due_idx ON pactwoven.native_tasks(environment,status,lease_until,updated_at,id) WHERE status IN ('queued','running');
CREATE INDEX native_task_page_idx ON pactwoven.native_tasks(environment,organization_id,actor_id,updated_at DESC,id DESC);
CREATE TABLE pactwoven.native_task_messages (
  environment text NOT NULL, organization_id text NOT NULL, task_id text NOT NULL, id text NOT NULL,
  role text NOT NULL CHECK(role IN ('user','assistant')),
  body text NOT NULL CHECK(char_length(body) BETWEEN 1 AND 30000),
  ordinal integer NOT NULL CHECK(ordinal BETWEEN 1 AND 100), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(environment,organization_id,task_id,id), UNIQUE(environment,organization_id,task_id,ordinal),
  FOREIGN KEY(environment,organization_id,task_id) REFERENCES pactwoven.native_tasks(environment,organization_id,id)
);
CREATE TABLE pactwoven.native_task_artifacts (
  environment text NOT NULL, organization_id text NOT NULL, task_id text NOT NULL, id text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('research','comparison','plan','report')), title text NOT NULL CHECK(char_length(title) BETWEEN 1 AND 180),
  body text NOT NULL CHECK(char_length(body) BETWEEN 1 AND 50000), sources jsonb NOT NULL CHECK(jsonb_typeof(sources)='array' AND jsonb_array_length(sources)<=60),
  ordinal integer NOT NULL CHECK(ordinal BETWEEN 1 AND 32), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(environment,organization_id,task_id,id), UNIQUE(environment,organization_id,task_id,ordinal),
  FOREIGN KEY(environment,organization_id,task_id) REFERENCES pactwoven.native_tasks(environment,organization_id,id)
);
CREATE TABLE pactwoven.native_task_events (
  environment text NOT NULL, organization_id text NOT NULL, task_id text NOT NULL, sequence bigint NOT NULL CHECK(sequence>0),
  kind text NOT NULL CHECK(kind IN ('created','progress','message','artifact','paused','resumed','cancelled','completed','failed')),
  title text NOT NULL CHECK(char_length(title) BETWEEN 1 AND 180), detail text NOT NULL CHECK(char_length(detail)<=2000),
  agent text CHECK(agent IN ('coordinator','research','planning','supplier','evidence')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(environment,organization_id,task_id,sequence),
  FOREIGN KEY(environment,organization_id,task_id) REFERENCES pactwoven.native_tasks(environment,organization_id,id)
);
CREATE TABLE pactwoven.native_task_operations (
  environment text NOT NULL, organization_id text NOT NULL, actor_id text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('create','reply')), request_key text NOT NULL CHECK(request_key ~ '^[A-Za-z0-9_-]{16,128}$'),
  task_id text NOT NULL, request jsonb NOT NULL CHECK(octet_length(request::text)<=65536),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(environment,organization_id,actor_id,kind,request_key),
  FOREIGN KEY(environment,organization_id,task_id) REFERENCES pactwoven.native_tasks(environment,organization_id,id)
);
-- No service receives table privileges. These owner-bypass SECURITY DEFINER
-- functions are the reviewed boundary; arbitrary model SQL is never accepted.
ALTER TABLE pactwoven.native_task_service_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE pactwoven.native_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE pactwoven.native_task_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE pactwoven.native_task_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE pactwoven.native_task_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE pactwoven.native_task_operations ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION pactwoven.native_task_binding(p_environment text,p_purpose text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT EXISTS(SELECT 1 FROM pactwoven.native_task_service_bindings b JOIN pg_catalog.pg_roles r ON r.oid=b.role_oid AND r.rolname=b.role_name
    WHERE b.role_name=session_user AND b.environment=p_environment AND b.purpose=p_purpose AND b.enabled
      AND pg_catalog.pg_has_role(session_user,CASE p_purpose WHEN 'api' THEN 'pactwoven_native_task_api' ELSE 'pactwoven_native_task_worker' END,'MEMBER'))
$$;

CREATE FUNCTION pactwoven.native_task_actor(p_actor jsonb,p_site text,p_write boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE live_roles text[];
BEGIN
  IF p_actor IS NULL OR p_actor->>'principalKind' IS DISTINCT FROM 'human'
    OR NOT pactwoven.native_task_binding(p_actor->>'environment','api')
    OR coalesce(p_actor->>'sessionId','')='' THEN
    RAISE EXCEPTION USING ERRCODE='NT001',MESSAGE='Current task access required';
  END IF;
  PERFORM set_config('pactwoven.environment',p_actor->>'environment',true),set_config('pactwoven.organization_id',p_actor->>'organizationId',true),
    set_config('pactwoven.actor_id',p_actor->>'actorId',true),set_config('pactwoven.session_id',p_actor->>'sessionId',true);
  SELECT roles INTO live_roles FROM pactwoven.lock_actor();
  IF live_roles IS NULL OR NOT EXISTS(SELECT 1 FROM pactwoven.memberships m
      WHERE (m.environment,m.organization_id,m.actor_id)=(p_actor->>'environment',p_actor->>'organizationId',p_actor->>'actorId')
        AND m.status='active' AND (m.expires_at IS NULL OR m.expires_at>clock_timestamp()))
    OR (p_site IS NOT NULL AND NOT pactwoven.can_read_site(p_actor->>'environment',p_actor->>'organizationId',p_site))
    OR (p_write AND (NOT(live_roles && ARRAY['owner','operations']::text[]) OR NOT EXISTS(
      SELECT 1 FROM pactwoven.member_action_sites s WHERE (s.environment,s.organization_id,s.actor_id,s.site_id)=
        (p_actor->>'environment',p_actor->>'organizationId',p_actor->>'actorId',p_site)))) THEN
    RAISE EXCEPTION USING ERRCODE='NT001',MESSAGE='Current task access required';
  END IF;
END $$;

CREATE FUNCTION pactwoven.native_task_owner_valid(p_environment text,p_org text,p_actor text,p_session text,p_site text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE m pactwoven.memberships%ROWTYPE;
BEGIN
  PERFORM 1 FROM pactwoven.organizations WHERE environment=p_environment AND id=p_org AND status='active' FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO m FROM pactwoven.memberships WHERE environment=p_environment AND organization_id=p_org AND actor_id=p_actor FOR SHARE;
  RETURN FOUND AND m.status='active' AND (m.expires_at IS NULL OR m.expires_at>clock_timestamp())
    AND m.roles && ARRAY['owner','operations']::text[]
    AND NOT EXISTS(SELECT 1 FROM pactwoven.session_revocations WHERE environment=p_environment AND session_id=p_session)
    AND EXISTS(SELECT 1 FROM pactwoven.member_action_sites WHERE (environment,organization_id,actor_id,site_id)=(p_environment,p_org,p_actor,p_site))
    AND ('owner'=ANY(m.roles) OR EXISTS(SELECT 1 FROM pactwoven.site_memberships WHERE (environment,organization_id,actor_id,site_id)=(p_environment,p_org,p_actor,p_site)));
END $$;

CREATE FUNCTION pactwoven.native_task_event(p_environment text,p_org text,p_id text,p_event jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE seq bigint;
BEGIN
  UPDATE pactwoven.native_tasks SET last_sequence=last_sequence+1 WHERE (environment,organization_id,id)=(p_environment,p_org,p_id) RETURNING last_sequence INTO seq;
  INSERT INTO pactwoven.native_task_events(environment,organization_id,task_id,sequence,kind,title,detail,agent)
    VALUES(p_environment,p_org,p_id,seq,p_event->>'kind',p_event->>'title',p_event->>'detail',p_event->>'agent');
END $$;

CREATE FUNCTION pactwoven.native_task_view(p_environment text,p_org text,p_id text,p_full boolean) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE t pactwoven.native_tasks%ROWTYPE; result jsonb; actions jsonb;
BEGIN
  SELECT * INTO t FROM pactwoven.native_tasks WHERE (environment,organization_id,id)=(p_environment,p_org,p_id);
  IF NOT FOUND THEN RETURN NULL; END IF;
  actions:=CASE WHEN t.status IN ('completed','cancelled') THEN '[]'::jsonb
    WHEN t.status='failed' THEN CASE WHEN t.mode='advise' THEN '["resume"]'::jsonb ELSE '[]'::jsonb END
    WHEN t.status='paused' THEN '["resume","cancel","message"]'::jsonb ELSE '["pause","cancel","message"]'::jsonb END;
  result:=jsonb_build_object('id',t.id,'title',t.title,'status',t.status,'phase',t.phase,'siteId',t.site_id,
    'createdAt',t.created_at,'updatedAt',t.updated_at,'version',t.row_version,'availableActions',actions);
  IF NOT p_full THEN RETURN result; END IF;
  RETURN result || jsonb_build_object('prompt',t.prompt,'mode',t.mode,'steps',t.steps,
    'messages',coalesce((SELECT jsonb_agg(jsonb_build_object('id',m.id,'role',m.role,'text',m.body,'createdAt',m.created_at) ORDER BY m.ordinal)
      FROM pactwoven.native_task_messages m WHERE (m.environment,m.organization_id,m.task_id)=(p_environment,p_org,p_id)),'[]'::jsonb),
    'artifacts',coalesce((SELECT jsonb_agg(jsonb_build_object('id',a.id,'kind',a.kind,'title',a.title,'text',a.body,'sources',a.sources,'createdAt',a.created_at) ORDER BY a.ordinal)
      FROM pactwoven.native_task_artifacts a WHERE (a.environment,a.organization_id,a.task_id)=(p_environment,p_org,p_id)),'[]'::jsonb),
    'events',coalesce((SELECT jsonb_agg(jsonb_build_object('sequence',e.sequence,'kind',e.kind,'title',e.title,'detail',e.detail,'agent',e.agent,'createdAt',e.created_at) ORDER BY e.sequence)
      FROM (SELECT * FROM pactwoven.native_task_events WHERE (environment,organization_id,task_id)=(p_environment,p_org,p_id) ORDER BY sequence DESC LIMIT 500)e),'[]'::jsonb));
END $$;

CREATE FUNCTION pactwoven.native_task_read(p_actor jsonb,p_id text,p_limit integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE t pactwoven.native_tasks%ROWTYPE;
BEGIN
  PERFORM pactwoven.native_task_actor(p_actor,NULL,false);
  IF p_id IS NOT NULL THEN
    SELECT * INTO t FROM pactwoven.native_tasks WHERE (environment,organization_id,actor_id,id)=
      (p_actor->>'environment',p_actor->>'organizationId',p_actor->>'actorId',p_id);
    IF NOT FOUND OR NOT pactwoven.can_read_site(t.environment,t.organization_id,t.site_id) THEN
      RAISE EXCEPTION USING ERRCODE='NT002',MESSAGE='Task not found'; END IF;
    RETURN pactwoven.native_task_view(t.environment,t.organization_id,t.id,true) || CASE
      WHEN pactwoven.native_task_owner_valid(t.environment,t.organization_id,t.actor_id,p_actor->>'sessionId',t.site_id) THEN '{}'::jsonb
      ELSE '{"availableActions":[]}'::jsonb END;
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION USING ERRCODE='NT004',MESSAGE='Invalid task page'; END IF;
  RETURN coalesce((SELECT jsonb_agg(pactwoven.native_task_view(q.environment,q.organization_id,q.id,false) || CASE
      WHEN pactwoven.native_task_owner_valid(q.environment,q.organization_id,q.actor_id,p_actor->>'sessionId',q.site_id) THEN '{}'::jsonb
      ELSE '{"availableActions":[]}'::jsonb END ORDER BY q.updated_at DESC,q.id DESC)
    FROM (SELECT * FROM pactwoven.native_tasks WHERE (environment,organization_id,actor_id)=
      (p_actor->>'environment',p_actor->>'organizationId',p_actor->>'actorId') AND pactwoven.can_read_site(environment,organization_id,site_id)
      ORDER BY updated_at DESC,id DESC LIMIT p_limit)q),'[]'::jsonb);
END $$;

CREATE FUNCTION pactwoven.native_task_create(p_actor jsonb,p_key text,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE original pactwoven.native_task_operations%ROWTYPE; task_id text:=gen_random_uuid()::text; env text:=p_actor->>'environment'; org text:=p_actor->>'organizationId'; aid text:=p_actor->>'actorId';
BEGIN
  PERFORM pactwoven.native_task_actor(p_actor,p_input->>'siteId',true);
  IF p_key IS NULL OR p_key !~ '^[A-Za-z0-9_-]{16,128}$' OR coalesce(char_length(btrim(p_input->>'prompt')),0) NOT BETWEEN 1 AND 12000
    OR p_input->>'mode' IS DISTINCT FROM 'advise' THEN RAISE EXCEPTION USING ERRCODE='NT004',MESSAGE='Invalid task request'; END IF;
  -- Serialize this actor's identical key without blocking unrelated task work.
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('native-create',env,org,aid,p_key)::text,0));
  PERFORM pactwoven.native_task_actor(p_actor,p_input->>'siteId',true);
  SELECT * INTO original FROM pactwoven.native_task_operations WHERE (environment,organization_id,actor_id,kind,request_key)=(env,org,aid,'create',p_key);
  IF FOUND THEN
    IF original.request IS DISTINCT FROM p_input THEN RAISE EXCEPTION USING ERRCODE='NT003',MESSAGE='Request key already used'; END IF;
    RETURN pactwoven.native_task_view(env,org,original.task_id,true);
  END IF;
  INSERT INTO pactwoven.native_tasks(environment,organization_id,id,actor_id,session_id,site_id,title,prompt,status,phase)
    VALUES(env,org,task_id,aid,p_actor->>'sessionId',p_input->>'siteId','New task',btrim(p_input->>'prompt'),'queued','Ready to start');
  INSERT INTO pactwoven.native_task_messages(environment,organization_id,task_id,id,role,body,ordinal)
    VALUES(env,org,task_id,gen_random_uuid()::text,'user',btrim(p_input->>'prompt'),1);
  INSERT INTO pactwoven.native_task_operations(environment,organization_id,actor_id,kind,request_key,task_id,request)
    VALUES(env,org,aid,'create',p_key,task_id,p_input);
  PERFORM pactwoven.native_task_event(env,org,task_id,jsonb_build_object('kind','created','title','Task saved','detail','Your request is ready for the team.','agent',NULL));
  RETURN pactwoven.native_task_view(env,org,task_id,true);
END $$;

CREATE FUNCTION pactwoven.native_task_command(p_actor jsonb,p_id text,p_kind text,p_key text,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE t pactwoven.native_tasks%ROWTYPE; original pactwoven.native_task_operations%ROWTYPE; env text:=p_actor->>'environment'; org text:=p_actor->>'organizationId'; aid text:=p_actor->>'actorId'; next_status text; next_phase text; event_kind text; event_title text; message_count integer;
BEGIN
  PERFORM pactwoven.native_task_actor(p_actor,NULL,false);
  SELECT * INTO t FROM pactwoven.native_tasks WHERE (environment,organization_id,actor_id,id)=(env,org,aid,p_id);
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='NT002',MESSAGE='Task not found'; END IF;
  PERFORM pactwoven.native_task_actor(p_actor,t.site_id,true);
  IF p_kind='reply' THEN PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('native-reply',env,org,aid,p_key)::text,0)); END IF;
  SELECT * INTO t FROM pactwoven.native_tasks WHERE (environment,organization_id,actor_id,id)=(env,org,aid,p_id) FOR UPDATE;
  PERFORM pactwoven.native_task_actor(p_actor,t.site_id,true);
  IF p_kind='reply' THEN
    IF p_key IS NULL OR p_key !~ '^[A-Za-z0-9_-]{16,128}$' OR coalesce(char_length(btrim(p_input->>'text')),0) NOT BETWEEN 1 AND 12000 THEN
      RAISE EXCEPTION USING ERRCODE='NT004',MESSAGE='Invalid task reply'; END IF;
    SELECT * INTO original FROM pactwoven.native_task_operations WHERE (environment,organization_id,actor_id,kind,request_key)=(env,org,aid,'reply',p_key);
    IF FOUND THEN
      IF original.task_id<>p_id OR original.request IS DISTINCT FROM p_input THEN RAISE EXCEPTION USING ERRCODE='NT003',MESSAGE='Request key already used'; END IF;
      RETURN pactwoven.native_task_view(env,org,p_id,true);
    END IF;
  ELSIF p_kind<>'control' THEN RAISE EXCEPTION USING ERRCODE='NT004',MESSAGE='Invalid task command'; END IF;
  IF p_input->>'expectedVersion' IS NULL OR (p_input->>'expectedVersion')::integer<>t.row_version THEN
    RAISE EXCEPTION USING ERRCODE='NT005',MESSAGE='Task changed'; END IF;
  IF t.status IN ('completed','cancelled') OR (t.status='failed' AND NOT coalesce(
    p_kind='control' AND p_input->>'action'='resume' AND t.mode='advise',false)) THEN
    RAISE EXCEPTION USING ERRCODE='NT006',MESSAGE='Task is already finished'; END IF;
  IF p_kind='reply' THEN
    SELECT count(*) INTO message_count FROM pactwoven.native_task_messages WHERE (environment,organization_id,task_id)=(env,org,p_id);
    IF message_count>=100 THEN RAISE EXCEPTION USING ERRCODE='NT007',MESSAGE='Task conversation is full'; END IF;
    INSERT INTO pactwoven.native_task_messages(environment,organization_id,task_id,id,role,body,ordinal)
      VALUES(env,org,p_id,gen_random_uuid()::text,'user',btrim(p_input->>'text'),message_count+1);
    INSERT INTO pactwoven.native_task_operations(environment,organization_id,actor_id,kind,request_key,task_id,request) VALUES(env,org,aid,'reply',p_key,p_id,p_input);
    next_status:=CASE WHEN t.status='paused' THEN 'paused' ELSE 'queued' END;
    next_phase:=CASE WHEN t.status='paused' THEN 'Paused' ELSE 'Considering your update' END;
    event_kind:='message';event_title:='Your update was saved';
  ELSE
    CASE p_input->>'action'
      WHEN 'pause' THEN
        IF t.status='paused' THEN RAISE EXCEPTION USING ERRCODE='NT006',MESSAGE='Task is already paused'; END IF;
        next_status:='paused';next_phase:='Paused';event_kind:='paused';event_title:='Task paused';
      WHEN 'resume' THEN
        IF t.status NOT IN ('paused','failed') THEN RAISE EXCEPTION USING ERRCODE='NT006',MESSAGE='Only paused or failed tasks can resume'; END IF;
        next_status:='queued';next_phase:='Ready to continue';event_kind:='resumed';event_title:='Task resumed';
      WHEN 'cancel' THEN next_status:='cancelled';next_phase:='Cancelled';event_kind:='cancelled';event_title:='Task cancelled';
      ELSE RAISE EXCEPTION USING ERRCODE='NT004',MESSAGE='Invalid task action';
    END CASE;
  END IF;
  UPDATE pactwoven.native_tasks SET status=next_status,phase=next_phase,row_version=row_version+1,updated_at=clock_timestamp(),
    session_id=p_actor->>'sessionId',lease_token=NULL,lease_until=NULL,worker_id=NULL,
    checkpoint=CASE WHEN p_kind='reply' THEN '{}'::jsonb ELSE checkpoint END,
    steps=CASE WHEN p_kind='reply' THEN '[]'::jsonb ELSE steps END
    WHERE (environment,organization_id,id)=(env,org,p_id);
  PERFORM pactwoven.native_task_event(env,org,p_id,jsonb_build_object('kind',event_kind,'title',event_title,'detail','', 'agent',NULL));
  RETURN pactwoven.native_task_view(env,org,p_id,true);
END $$;

CREATE FUNCTION pactwoven.native_task_claim(p_environment text,p_worker text,p_lease_ms integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE candidate pactwoven.native_tasks%ROWTYPE; t pactwoven.native_tasks%ROWTYPE; permitted boolean;
BEGIN
  IF NOT pactwoven.native_task_binding(p_environment,'worker') THEN RAISE EXCEPTION USING ERRCODE='NT001',MESSAGE='Worker access required'; END IF;
  IF p_worker IS NULL OR p_worker !~ '^[A-Za-z0-9_-]{1,128}$' OR p_lease_ms IS NULL OR p_lease_ms NOT BETWEEN 1000 AND 300000 THEN
    RAISE EXCEPTION USING ERRCODE='NT004',MESSAGE='Invalid worker lease'; END IF;
  FOR candidate IN SELECT * FROM pactwoven.native_tasks WHERE environment=p_environment
    AND (status='queued' OR (status='running' AND lease_until<=clock_timestamp())) ORDER BY updated_at,id LIMIT 32 LOOP
    -- Organization/member locks precede task locks, matching API/revocation order.
    permitted:=pactwoven.native_task_owner_valid(candidate.environment,candidate.organization_id,candidate.actor_id,candidate.session_id,candidate.site_id);
    SELECT * INTO t FROM pactwoven.native_tasks WHERE (environment,organization_id,id)=(candidate.environment,candidate.organization_id,candidate.id)
      AND (status='queued' OR (status='running' AND lease_until<=clock_timestamp())) FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN CONTINUE; END IF;
    IF t.session_id<>candidate.session_id THEN CONTINUE; END IF;
    permitted:=pactwoven.native_task_owner_valid(t.environment,t.organization_id,t.actor_id,t.session_id,t.site_id);
    IF NOT permitted THEN
      UPDATE pactwoven.native_tasks SET status='paused',phase='Access needs review',worker_id=NULL,lease_token=NULL,lease_until=NULL,
        row_version=row_version+1,updated_at=clock_timestamp() WHERE (environment,organization_id,id)=(t.environment,t.organization_id,t.id);
      PERFORM pactwoven.native_task_event(t.environment,t.organization_id,t.id,jsonb_build_object('kind','paused','title','Access needs review','detail','Review the current company access before resuming.','agent',NULL));
      CONTINUE;
    END IF;
    UPDATE pactwoven.native_tasks SET status='running',phase='Working on your request',worker_id=p_worker,lease_token=gen_random_uuid(),
      lease_until=clock_timestamp()+p_lease_ms*interval '1 millisecond',row_version=row_version+1,updated_at=clock_timestamp()
      WHERE (environment,organization_id,id)=(t.environment,t.organization_id,t.id) RETURNING * INTO t;
    PERFORM pactwoven.native_task_event(t.environment,t.organization_id,t.id,jsonb_build_object('kind','progress','title','The team started work','detail','', 'agent','coordinator'));
    RETURN jsonb_build_object('task',pactwoven.native_task_view(t.environment,t.organization_id,t.id,true),'environment',t.environment,'organizationId',t.organization_id,
      'actorId',t.actor_id,'leaseToken',t.lease_token,'checkpoint',t.checkpoint);
  END LOOP;
  RETURN NULL;
END $$;

CREATE FUNCTION pactwoven.native_task_lease(p_environment text,p_org text,p_id text,p_token uuid,p_kind text,p_lease_ms integer,p_update jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE t pactwoven.native_tasks%ROWTYPE; candidate pactwoven.native_tasks%ROWTYPE; permitted boolean; next_status text; n integer; m jsonb; a jsonb; existing jsonb;
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
  IF p_kind='renew' THEN
    IF p_lease_ms IS NULL OR p_lease_ms NOT BETWEEN 1000 AND 300000 THEN RAISE EXCEPTION USING ERRCODE='NT004',MESSAGE='Invalid worker lease'; END IF;
    UPDATE pactwoven.native_tasks SET lease_until=clock_timestamp()+p_lease_ms*interval '1 millisecond' WHERE (environment,organization_id,id)=(p_environment,p_org,p_id);
    RETURN true;
  ELSIF p_kind='release' THEN
    UPDATE pactwoven.native_tasks SET status='queued',phase='Ready to continue',lease_token=NULL,lease_until=NULL,worker_id=NULL,
      row_version=row_version+1,updated_at=clock_timestamp() WHERE (environment,organization_id,id)=(p_environment,p_org,p_id);
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
  RETURN true;
END $$;

-- Never leave a helper or new function reachable through PUBLIC.
DO $$ DECLARE f record; BEGIN
  FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='pactwoven' AND p.proname LIKE 'native_task_%' LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,pactwoven_runtime,pactwoven_native_task_api,pactwoven_native_task_worker',f.signature);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION pactwoven.native_task_binding(text,text) TO pactwoven_native_task_api,pactwoven_native_task_worker;
GRANT EXECUTE ON FUNCTION pactwoven.native_task_read(jsonb,text,integer),pactwoven.native_task_create(jsonb,text,jsonb),
  pactwoven.native_task_command(jsonb,text,text,text,jsonb) TO pactwoven_native_task_api;
GRANT EXECUTE ON FUNCTION pactwoven.native_task_claim(text,text,integer),pactwoven.native_task_lease(text,text,text,uuid,text,integer,jsonb) TO pactwoven_native_task_worker;

COMMIT;
