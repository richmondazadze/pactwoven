BEGIN;

DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='pactwoven_native_task_dispatcher') THEN
    CREATE ROLE pactwoven_native_task_dispatcher NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;
GRANT USAGE ON SCHEMA pactwoven TO pactwoven_native_task_dispatcher;
ALTER TABLE pactwoven.native_task_service_bindings DROP CONSTRAINT native_task_service_bindings_purpose_check;
ALTER TABLE pactwoven.native_task_service_bindings ADD CONSTRAINT native_task_service_bindings_purpose_check CHECK(purpose IN ('api','worker','dispatcher'));
CREATE OR REPLACE FUNCTION pactwoven.native_task_binding(p_environment text,p_purpose text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT coalesce(p_purpose IN ('api','worker','dispatcher') AND EXISTS(
    SELECT 1 FROM pactwoven.native_task_service_bindings b JOIN pg_catalog.pg_roles r ON r.oid=b.role_oid AND r.rolname=b.role_name
    WHERE b.role_name=session_user AND b.environment=p_environment AND b.purpose=p_purpose AND b.enabled
      AND pg_catalog.pg_has_role(session_user,CASE p_purpose WHEN 'api' THEN 'pactwoven_native_task_api'
        WHEN 'worker' THEN 'pactwoven_native_task_worker' WHEN 'dispatcher' THEN 'pactwoven_native_task_dispatcher' END,'MEMBER')),false)
$$;

ALTER TABLE pactwoven.native_tasks
  ADD COLUMN dispatch_generation bigint NOT NULL DEFAULT 0 CHECK(dispatch_generation BETWEEN 0 AND 9007199254740991),
  ADD COLUMN dispatch_engine_revision text NOT NULL DEFAULT 'native-advice-v1',
  ADD COLUMN runnable_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ADD COLUMN dispatch_recoveries integer NOT NULL DEFAULT 0 CHECK(dispatch_recoveries BETWEEN 0 AND 3);
CREATE TABLE pactwoven.native_dispatch_outbox (
  environment text NOT NULL, organization_id text NOT NULL, task_id text NOT NULL,
  generation bigint NOT NULL CHECK(generation BETWEEN 1 AND 9007199254740991),
  engine_revision text NOT NULL CHECK(engine_revision='native-advice-v1'),
  idempotency_key text NOT NULL CHECK(idempotency_key ~ '^native-[a-f0-9]{64}$'),
  not_before timestamptz NOT NULL, next_publish_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','publishing','published','superseded','quarantined')),
  publication_attempts integer NOT NULL DEFAULT 0 CHECK(publication_attempts BETWEEN 0 AND 8),
  publisher_id text, publication_token uuid, publication_lease_until timestamptz,
  published_at timestamptz, delivery_deadline timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(environment,organization_id,task_id,generation),
  FOREIGN KEY(environment,organization_id,task_id) REFERENCES pactwoven.native_tasks(environment,organization_id,id),
  CHECK((publisher_id IS NULL AND publication_token IS NULL AND publication_lease_until IS NULL)
    OR (publisher_id IS NOT NULL AND publication_token IS NOT NULL AND publication_lease_until IS NOT NULL AND state='publishing'))
);
ALTER TABLE pactwoven.native_dispatch_outbox ENABLE ROW LEVEL SECURITY;
CREATE INDEX native_dispatch_publication_due_idx ON pactwoven.native_dispatch_outbox(environment,next_publish_at,publication_lease_until)
  WHERE state IN ('pending','publishing');
CREATE INDEX native_dispatch_delivery_due_idx ON pactwoven.native_dispatch_outbox(environment,delivery_deadline) WHERE state='published';
CREATE INDEX native_dispatch_task_due_idx ON pactwoven.native_tasks(environment,status,runnable_at,lease_until) WHERE status IN ('queued','running');

CREATE FUNCTION pactwoven.native_dispatch_message(p_environment text,p_org text,p_task text,p_generation bigint,p_engine text) RETURNS jsonb
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT jsonb_build_object('schemaVersion',1,'engineRevision',p_engine,'environment',p_environment,
    'organizationId',p_org,'taskId',p_task,'generation',p_generation)
$$;
CREATE FUNCTION pactwoven.native_dispatch_insert(p_environment text,p_org text,p_task text,p_generation bigint,p_engine text,p_due timestamptz) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
  INSERT INTO pactwoven.native_dispatch_outbox(environment,organization_id,task_id,generation,engine_revision,idempotency_key,not_before)
    VALUES(p_environment,p_org,p_task,p_generation,p_engine,
      'native-'||encode(sha256(convert_to(jsonb_build_array(p_environment,p_org,p_task,p_generation)::text,'UTF8')),'hex'),p_due)
    ON CONFLICT(environment,organization_id,task_id,generation) DO NOTHING;
END $$;
CREATE FUNCTION pactwoven.native_dispatch_prepare() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
  IF NEW.status='queued' AND (TG_OP='INSERT' OR OLD.status IS DISTINCT FROM 'queued' OR NEW.row_version IS DISTINCT FROM OLD.row_version) THEN
    NEW.dispatch_generation:=CASE WHEN TG_OP='INSERT' THEN 1 ELSE OLD.dispatch_generation+1 END;
    -- Only a worker yield changes runnable_at explicitly. Inherited prior delays
    -- must never delay a human reply/resume or an ordinary expired-lease recovery.
    IF TG_OP='INSERT' OR NEW.runnable_at IS NOT DISTINCT FROM OLD.runnable_at THEN NEW.runnable_at:=clock_timestamp(); END IF;
    IF TG_OP='UPDATE' AND OLD.status IN ('paused','failed') THEN NEW.dispatch_recoveries:=0; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION pactwoven.native_dispatch_schedule() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
  IF NEW.status='queued' AND (TG_OP='INSERT' OR NEW.dispatch_generation IS DISTINCT FROM OLD.dispatch_generation) THEN
    UPDATE pactwoven.native_dispatch_outbox SET state='superseded',publisher_id=NULL,publication_token=NULL,publication_lease_until=NULL
      WHERE (environment,organization_id,task_id)=(NEW.environment,NEW.organization_id,NEW.id) AND state NOT IN ('superseded','quarantined');
    PERFORM pactwoven.native_dispatch_insert(NEW.environment,NEW.organization_id,NEW.id,NEW.dispatch_generation,NEW.dispatch_engine_revision,NEW.runnable_at);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER native_dispatch_prepare BEFORE INSERT OR UPDATE ON pactwoven.native_tasks FOR EACH ROW EXECUTE FUNCTION pactwoven.native_dispatch_prepare();
CREATE TRIGGER native_dispatch_schedule AFTER INSERT OR UPDATE ON pactwoven.native_tasks FOR EACH ROW EXECUTE FUNCTION pactwoven.native_dispatch_schedule();

-- Backfill does not manufacture a user mutation or rewrite existing evidence.
UPDATE pactwoven.native_tasks SET dispatch_generation=1 WHERE status IN ('queued','running');
INSERT INTO pactwoven.native_dispatch_outbox(environment,organization_id,task_id,generation,engine_revision,idempotency_key,not_before)
  SELECT environment,organization_id,id,dispatch_generation,dispatch_engine_revision,
    'native-'||encode(sha256(convert_to(jsonb_build_array(environment,organization_id,id,dispatch_generation)::text,'UTF8')),'hex'),runnable_at
  FROM pactwoven.native_tasks WHERE status='queued' ON CONFLICT DO NOTHING;

CREATE FUNCTION pactwoven.native_dispatch_claim_publications(p_environment text,p_publisher text,p_limit integer,p_lease_ms integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE candidate pactwoven.native_dispatch_outbox%ROWTYPE; o pactwoven.native_dispatch_outbox%ROWTYPE; result jsonb:='[]'::jsonb;
BEGIN
  IF NOT pactwoven.native_task_binding(p_environment,'dispatcher') THEN RAISE EXCEPTION USING ERRCODE='NT001',MESSAGE='Dispatcher access required'; END IF;
  IF p_publisher IS NULL OR p_publisher !~ '^[A-Za-z0-9_-]{1,128}$' OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100
    OR p_lease_ms IS NULL OR p_lease_ms NOT BETWEEN 1000 AND 300000 THEN RAISE EXCEPTION USING ERRCODE='NT004',MESSAGE='Invalid publication lease'; END IF;
  FOR candidate IN SELECT d.* FROM pactwoven.native_dispatch_outbox d JOIN pactwoven.native_tasks t
    ON (t.environment,t.organization_id,t.id,t.dispatch_generation)=(d.environment,d.organization_id,d.task_id,d.generation)
    WHERE d.environment=p_environment AND t.status='queued' AND d.publication_attempts<8 AND d.next_publish_at<=clock_timestamp()
      AND (d.state='pending' OR (d.state='publishing' AND d.publication_lease_until<=clock_timestamp()))
    ORDER BY d.next_publish_at,d.created_at,d.task_id LIMIT p_limit FOR UPDATE OF d SKIP LOCKED LOOP
    UPDATE pactwoven.native_dispatch_outbox SET state='publishing',publisher_id=p_publisher,publication_token=gen_random_uuid(),
      publication_lease_until=clock_timestamp()+p_lease_ms*interval '1 millisecond',publication_attempts=publication_attempts+1
      WHERE (environment,organization_id,task_id,generation)=(candidate.environment,candidate.organization_id,candidate.task_id,candidate.generation)
      RETURNING * INTO o;
    result:=result||jsonb_build_array(jsonb_build_object('message',pactwoven.native_dispatch_message(o.environment,o.organization_id,o.task_id,o.generation,o.engine_revision),
      'publicationToken',o.publication_token,'idempotencyKey',o.idempotency_key,'notBefore',o.not_before));
  END LOOP;
  RETURN result;
END $$;

CREATE FUNCTION pactwoven.native_dispatch_publication(p_environment text,p_org text,p_task text,p_generation bigint,p_token uuid,p_ack boolean,p_delay_ms integer) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE o pactwoven.native_dispatch_outbox%ROWTYPE; BEGIN
  IF NOT pactwoven.native_task_binding(p_environment,'dispatcher') THEN RAISE EXCEPTION USING ERRCODE='NT001',MESSAGE='Dispatcher access required'; END IF;
  IF p_ack IS NULL OR (NOT p_ack AND (p_delay_ms IS NULL OR p_delay_ms NOT BETWEEN 0 AND 86400000)) THEN RAISE EXCEPTION USING ERRCODE='NT004',MESSAGE='Invalid publication result'; END IF;
  SELECT * INTO o FROM pactwoven.native_dispatch_outbox WHERE (environment,organization_id,task_id,generation)=(p_environment,p_org,p_task,p_generation) FOR UPDATE;
  IF NOT FOUND OR o.state<>'publishing' OR o.publication_token IS DISTINCT FROM p_token OR o.publication_lease_until<=clock_timestamp() THEN RETURN false; END IF;
  UPDATE pactwoven.native_dispatch_outbox SET state=CASE WHEN p_ack THEN 'published' ELSE 'pending' END,
    publisher_id=NULL,publication_token=NULL,publication_lease_until=NULL,
    published_at=CASE WHEN p_ack THEN clock_timestamp() ELSE published_at END,
    delivery_deadline=CASE WHEN p_ack THEN greatest(not_before,clock_timestamp())+interval '10 minutes' ELSE delivery_deadline END,
    next_publish_at=CASE WHEN p_ack THEN next_publish_at ELSE clock_timestamp()+p_delay_ms*interval '1 millisecond' END
    WHERE (environment,organization_id,task_id,generation)=(p_environment,p_org,p_task,p_generation);
  RETURN true;
END $$;

CREATE FUNCTION pactwoven.native_dispatch_pause(p_environment text,p_org text,p_task text,p_access boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
  UPDATE pactwoven.native_tasks SET status='paused',phase=CASE WHEN p_access THEN 'Access needs review' ELSE 'Connection needs attention' END,
    worker_id=NULL,lease_token=NULL,lease_until=NULL,row_version=row_version+1,updated_at=clock_timestamp()
    WHERE (environment,organization_id,id)=(p_environment,p_org,p_task);
  IF NOT p_access THEN
    UPDATE pactwoven.native_dispatch_outbox SET state='quarantined',publisher_id=NULL,publication_token=NULL,publication_lease_until=NULL
      WHERE (environment,organization_id,task_id)=(p_environment,p_org,p_task) AND state NOT IN ('superseded','quarantined');
  END IF;
  PERFORM pactwoven.native_task_event(p_environment,p_org,p_task,jsonb_build_object('kind','paused',
    'title',CASE WHEN p_access THEN 'Access needs review' ELSE 'Connection needs attention' END,
    'detail',CASE WHEN p_access THEN 'Review the current company access before resuming.' ELSE 'Delivery could not be confirmed. Resume when the connection is ready.' END,'agent',NULL));
END $$;

CREATE FUNCTION pactwoven.native_dispatch_admit(p_environment text,p_message jsonb,p_worker text,p_lease_ms integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE candidate pactwoven.native_tasks%ROWTYPE; t pactwoven.native_tasks%ROWTYPE; permitted boolean; delay_ms bigint;
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
  RETURN jsonb_build_object('kind','claimed','dispatch',pactwoven.native_dispatch_message(t.environment,t.organization_id,t.id,t.dispatch_generation,t.dispatch_engine_revision),
    'claim',jsonb_build_object('task',pactwoven.native_task_view(t.environment,t.organization_id,t.id,true),'environment',t.environment,'organizationId',t.organization_id,
      'actorId',t.actor_id,'leaseToken',t.lease_token,'checkpoint',t.checkpoint));
END $$;
CREATE FUNCTION pactwoven.native_dispatch_claim_target(p_environment text,p_message jsonb,p_worker text,p_lease_ms integer) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT pactwoven.native_dispatch_admit(p_environment,p_message,p_worker,p_lease_ms) $$;

-- Compatibility with the local runner, including the new not-before boundary.
CREATE OR REPLACE FUNCTION pactwoven.native_task_claim(p_environment text,p_worker text,p_lease_ms integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE candidate pactwoven.native_tasks%ROWTYPE; current_task pactwoven.native_tasks%ROWTYPE; result jsonb; permitted boolean; BEGIN
  IF NOT pactwoven.native_task_binding(p_environment,'worker') THEN RAISE EXCEPTION USING ERRCODE='NT001',MESSAGE='Worker access required'; END IF;
  IF p_worker IS NULL OR p_worker !~ '^[A-Za-z0-9_-]{1,128}$' OR p_lease_ms IS NULL OR p_lease_ms NOT BETWEEN 1000 AND 300000 THEN RAISE EXCEPTION USING ERRCODE='NT004',MESSAGE='Invalid worker lease'; END IF;
  FOR candidate IN SELECT * FROM pactwoven.native_tasks WHERE environment=p_environment AND
    ((status='queued' AND runnable_at<=clock_timestamp()) OR (status='running' AND lease_until<=clock_timestamp())) ORDER BY updated_at,id LIMIT 32 LOOP
    IF candidate.status='running' THEN
      permitted:=pactwoven.native_task_owner_valid(candidate.environment,candidate.organization_id,candidate.actor_id,candidate.session_id,candidate.site_id);
      SELECT * INTO current_task FROM pactwoven.native_tasks WHERE (environment,organization_id,id)=(candidate.environment,candidate.organization_id,candidate.id) FOR UPDATE SKIP LOCKED;
      IF NOT FOUND OR current_task.status<>'running' OR current_task.lease_until>clock_timestamp() THEN CONTINUE; END IF;
      permitted:=pactwoven.native_task_owner_valid(current_task.environment,current_task.organization_id,current_task.actor_id,current_task.session_id,current_task.site_id);
      IF NOT permitted THEN PERFORM pactwoven.native_dispatch_pause(current_task.environment,current_task.organization_id,current_task.id,true); CONTINUE; END IF;
      IF current_task.dispatch_recoveries>=3 THEN PERFORM pactwoven.native_dispatch_pause(current_task.environment,current_task.organization_id,current_task.id,false); CONTINUE; END IF;
      UPDATE pactwoven.native_tasks SET status='queued',phase='Ready to continue',worker_id=NULL,lease_token=NULL,lease_until=NULL,
        dispatch_recoveries=dispatch_recoveries+1,row_version=row_version+1,updated_at=clock_timestamp()
        WHERE (environment,organization_id,id)=(current_task.environment,current_task.organization_id,current_task.id) RETURNING * INTO candidate;
      PERFORM pactwoven.native_task_event(candidate.environment,candidate.organization_id,candidate.id,jsonb_build_object('kind','progress','title','Work queued for recovery','detail','Saved work is ready for another delivery.','agent',NULL));
    END IF;
    result:=pactwoven.native_dispatch_admit(p_environment,pactwoven.native_dispatch_message(candidate.environment,candidate.organization_id,candidate.id,candidate.dispatch_generation,candidate.dispatch_engine_revision),p_worker,p_lease_ms);
    IF result->>'kind'='claimed' THEN RETURN result->'claim'; END IF;
  END LOOP;
  RETURN NULL;
END $$;

CREATE FUNCTION pactwoven.native_dispatch_yield(p_environment text,p_message jsonb,p_token uuid,p_progress jsonb,p_delay_ms integer) RETURNS boolean
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
  RETURN true;
END $$;

CREATE FUNCTION pactwoven.native_dispatch_recover(p_environment text,p_limit integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE candidate pactwoven.native_tasks%ROWTYPE; t pactwoven.native_tasks%ROWTYPE; o pactwoven.native_dispatch_outbox%ROWTYPE;
  permitted boolean; expired_worker boolean; expired_delivery boolean; exhausted boolean; leases integer:=0; deliveries integer:=0; repaired integer:=0; quarantined integer:=0; more_due boolean;
BEGIN
  IF NOT pactwoven.native_task_binding(p_environment,'dispatcher') THEN RAISE EXCEPTION USING ERRCODE='NT001',MESSAGE='Dispatcher access required'; END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION USING ERRCODE='NT004',MESSAGE='Invalid recovery limit'; END IF;
  FOR candidate IN SELECT n.* FROM pactwoven.native_tasks n LEFT JOIN pactwoven.native_dispatch_outbox d
    ON (d.environment,d.organization_id,d.task_id,d.generation)=(n.environment,n.organization_id,n.id,n.dispatch_generation)
    WHERE n.environment=p_environment AND ((n.status='running' AND n.lease_until<=clock_timestamp()) OR
      (n.status='queued' AND (d.task_id IS NULL OR (d.state='published' AND d.delivery_deadline<=clock_timestamp()) OR
        (d.publication_attempts>=8 AND (d.state='pending' OR (d.state='publishing' AND d.publication_lease_until<=clock_timestamp()))))))
    ORDER BY n.updated_at,n.id LIMIT p_limit LOOP
    permitted:=pactwoven.native_task_owner_valid(candidate.environment,candidate.organization_id,candidate.actor_id,candidate.session_id,candidate.site_id);
    SELECT * INTO t FROM pactwoven.native_tasks WHERE (environment,organization_id,id)=(candidate.environment,candidate.organization_id,candidate.id) FOR UPDATE SKIP LOCKED;
    IF NOT FOUND OR t.status NOT IN ('queued','running') THEN CONTINUE; END IF;
    permitted:=pactwoven.native_task_owner_valid(t.environment,t.organization_id,t.actor_id,t.session_id,t.site_id);
    IF NOT permitted THEN PERFORM pactwoven.native_dispatch_pause(t.environment,t.organization_id,t.id,true); CONTINUE; END IF;
    SELECT * INTO o FROM pactwoven.native_dispatch_outbox WHERE (environment,organization_id,task_id,generation)=(t.environment,t.organization_id,t.id,t.dispatch_generation) FOR UPDATE;
    expired_worker:=t.status='running' AND t.lease_until<=clock_timestamp();
    expired_delivery:=t.status='queued' AND o.state='published' AND o.delivery_deadline<=clock_timestamp();
    exhausted:=t.status='queued' AND o.publication_attempts>=8 AND (o.state='pending' OR (o.state='publishing' AND o.publication_lease_until<=clock_timestamp()));
    IF exhausted OR ((expired_worker OR expired_delivery) AND t.dispatch_recoveries>=3) THEN
      PERFORM pactwoven.native_dispatch_pause(t.environment,t.organization_id,t.id,false); quarantined:=quarantined+1;
    ELSIF expired_worker OR expired_delivery THEN
      UPDATE pactwoven.native_tasks SET status='queued',phase='Ready to continue',worker_id=NULL,lease_token=NULL,lease_until=NULL,
        dispatch_recoveries=dispatch_recoveries+1,row_version=row_version+1,updated_at=clock_timestamp()
        WHERE (environment,organization_id,id)=(t.environment,t.organization_id,t.id);
      PERFORM pactwoven.native_task_event(t.environment,t.organization_id,t.id,jsonb_build_object('kind','progress','title','Work queued for recovery','detail','Saved work is ready for another delivery.','agent',NULL));
      IF expired_worker THEN leases:=leases+1; ELSE deliveries:=deliveries+1; END IF;
    ELSIF t.status='queued' AND o.task_id IS NULL THEN
      PERFORM pactwoven.native_dispatch_insert(t.environment,t.organization_id,t.id,t.dispatch_generation,t.dispatch_engine_revision,t.runnable_at); repaired:=repaired+1;
    END IF;
  END LOOP;
  SELECT EXISTS(SELECT 1 FROM pactwoven.native_tasks n LEFT JOIN pactwoven.native_dispatch_outbox d
    ON (d.environment,d.organization_id,d.task_id,d.generation)=(n.environment,n.organization_id,n.id,n.dispatch_generation)
    WHERE n.environment=p_environment AND ((n.status='running' AND n.lease_until<=clock_timestamp()) OR
      (n.status='queued' AND (d.task_id IS NULL OR (d.state='published' AND d.delivery_deadline<=clock_timestamp()) OR
        (d.publication_attempts>=8 AND (d.state='pending' OR (d.state='publishing' AND d.publication_lease_until<=clock_timestamp()))))))) INTO more_due;
  RETURN jsonb_build_object('recoveredWorkerLeases',leases,'recoveredDeliveries',deliveries,'repairedPublications',repaired,'quarantined',quarantined,'moreDue',more_due);
END $$;

DO $$ DECLARE f record; BEGIN
  FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='pactwoven' AND p.proname LIKE 'native_dispatch_%' LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,pactwoven_runtime,pactwoven_native_task_api,pactwoven_native_task_worker,pactwoven_native_task_dispatcher',f.signature);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION pactwoven.native_task_binding(text,text),pactwoven.native_dispatch_claim_publications(text,text,integer,integer),
  pactwoven.native_dispatch_publication(text,text,text,bigint,uuid,boolean,integer),pactwoven.native_dispatch_recover(text,integer) TO pactwoven_native_task_dispatcher;
GRANT EXECUTE ON FUNCTION pactwoven.native_dispatch_claim_target(text,jsonb,text,integer),pactwoven.native_dispatch_yield(text,jsonb,uuid,jsonb,integer) TO pactwoven_native_task_worker;

COMMIT;
