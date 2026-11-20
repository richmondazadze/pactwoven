BEGIN;

-- Only the lease writer calls this private helper. A deadline is a precondition
-- on final publication, never authority to change task ownership or the lease.
CREATE FUNCTION pactwoven.native_task_completion_deadline(p_update jsonb) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE deadline timestamptz; observed timestamptz; reader_until timestamptz; effective_until timestamptz;
  minimum_until timestamptz; documents jsonb; document jsonb; retrieved boolean:=false;
  instant_pattern text:='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$';
BEGIN
  IF p_update ? 'evidenceValidUntil' THEN
    IF p_update->>'status' IS DISTINCT FROM 'completed' OR
      jsonb_typeof(p_update->'evidenceValidUntil') IS DISTINCT FROM 'string' OR
      char_length(p_update->>'evidenceValidUntil')>40 OR (p_update->>'evidenceValidUntil') !~ instant_pattern THEN
      RAISE EXCEPTION USING ERRCODE='NT004',MESSAGE='Invalid completion evidence deadline'; END IF;
    deadline:=(p_update->>'evidenceValidUntil')::timestamptz;
    IF NOT isfinite(deadline) THEN RAISE EXCEPTION USING ERRCODE='NT004',MESSAGE='Invalid completion evidence deadline'; END IF;
  END IF;
  IF p_update->>'status' IS DISTINCT FROM 'completed' THEN RETURN NULL; END IF;

  -- Explicit version 1 is retained solely for legacy writer compatibility.
  -- It is not evidence-freshness-qualified. Current production checkpoints use 2.
  IF p_update#>'{checkpoint,schemaVersion}'='1'::jsonb THEN RETURN deadline; END IF;
  IF p_update#>'{checkpoint,schemaVersion}' IS DISTINCT FROM '2'::jsonb THEN
    RAISE EXCEPTION USING ERRCODE='NT004',MESSAGE='Unknown completion checkpoint version'; END IF;
  documents:=p_update#>'{checkpoint,documents}';
  IF jsonb_typeof(documents) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION USING ERRCODE='NT008',MESSAGE='Completion evidence needs refresh'; END IF;
  IF jsonb_array_length(documents)>3 THEN
    RAISE EXCEPTION USING ERRCODE='NT008',MESSAGE='Completion evidence needs refresh'; END IF;
  FOR document IN SELECT value FROM jsonb_array_elements(documents) LOOP
    IF jsonb_typeof(document) IS DISTINCT FROM 'object' OR
      jsonb_typeof(document->'origin') IS DISTINCT FROM 'string' OR document->>'origin' NOT IN ('retrieved','user_supplied') THEN
      RAISE EXCEPTION USING ERRCODE='NT008',MESSAGE='Completion evidence needs refresh'; END IF;
    IF document->>'origin'='retrieved' THEN
      retrieved:=true;
      IF jsonb_typeof(document->'observedAt') IS DISTINCT FROM 'string' OR
        jsonb_typeof(document->'validUntil') IS DISTINCT FROM 'string' OR
        char_length(document->>'observedAt')>40 OR char_length(document->>'validUntil')>40 OR
        (document->>'observedAt') !~ instant_pattern OR (document->>'validUntil') !~ instant_pattern OR
        jsonb_typeof(document->'source') IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION USING ERRCODE='NT008',MESSAGE='Completion evidence needs refresh'; END IF;
      BEGIN
        observed:=(document->>'observedAt')::timestamptz;
        reader_until:=(document->>'validUntil')::timestamptz;
      EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow OR invalid_text_representation THEN
        RAISE EXCEPTION USING ERRCODE='NT008',MESSAGE='Completion evidence needs refresh';
      END;
      IF NOT isfinite(observed) OR NOT isfinite(reader_until) OR observed>clock_timestamp() OR reader_until<=observed THEN
        RAISE EXCEPTION USING ERRCODE='NT008',MESSAGE='Completion evidence needs refresh'; END IF;
      effective_until:=least(reader_until,observed+interval '15 minutes',
        (date_trunc('day',observed AT TIME ZONE 'UTC')+interval '1 day') AT TIME ZONE 'UTC');
      minimum_until:=CASE WHEN minimum_until IS NULL THEN effective_until ELSE least(minimum_until,effective_until) END;
    END IF;
  END LOOP;
  IF retrieved AND (deadline IS NULL OR deadline>minimum_until) THEN
    RAISE EXCEPTION USING ERRCODE='NT008',MESSAGE='Completion evidence needs refresh'; END IF;
  IF NOT retrieved AND deadline IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE='NT004',MESSAGE='Context-only completion cannot claim an evidence deadline'; END IF;
  RETURN deadline;
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow OR invalid_text_representation THEN
  RAISE EXCEPTION USING ERRCODE='NT004',MESSAGE='Invalid completion evidence deadline';
END $$;

REVOKE ALL ON FUNCTION pactwoven.native_task_completion_deadline(jsonb) FROM PUBLIC,pactwoven_runtime,pactwoven_native_task_api,pactwoven_native_task_worker,pactwoven_native_task_dispatcher;

CREATE OR REPLACE FUNCTION pactwoven.native_task_lease(p_environment text,p_org text,p_id text,p_token uuid,p_kind text,p_lease_ms integer,p_update jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE t pactwoven.native_tasks%ROWTYPE; candidate pactwoven.native_tasks%ROWTYPE; permitted boolean; next_status text; n integer; m jsonb; a jsonb; existing jsonb; publication_deadline timestamptz;
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
  RETURN true;
END $$;

-- CREATE OR REPLACE preserves the original exact EXECUTE grants. The existing
-- native_dispatch_yield delegates to this lease function without exposing the
-- helper or changing its boolean result contract. No new service grant is added.
COMMIT;
