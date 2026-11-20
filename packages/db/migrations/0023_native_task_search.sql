BEGIN;

-- Task discovery uses immutable creation order. Keep legacy updated-at listing
-- available for existing callers; no prior migration or task record is rewritten.
CREATE INDEX native_task_history_idx ON pactwoven.native_tasks
  (environment,organization_id,actor_id,created_at DESC,id COLLATE "C" DESC);

CREATE FUNCTION pactwoven.native_task_identity_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF (NEW.environment,NEW.organization_id,NEW.actor_id,NEW.id,NEW.created_at) IS DISTINCT FROM
     (OLD.environment,OLD.organization_id,OLD.actor_id,OLD.id,OLD.created_at) THEN
    RAISE EXCEPTION USING ERRCODE='NT004',MESSAGE='Task identity and creation order are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER native_task_identity_guard BEFORE UPDATE ON pactwoven.native_tasks
  FOR EACH ROW EXECUTE FUNCTION pactwoven.native_task_identity_guard();

CREATE FUNCTION pactwoven.native_task_search(p_actor jsonb,p_query jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE page_limit integer; query_text text; query_filter text; after_value jsonb;
  after_created timestamptz; after_id text; result jsonb;
BEGIN
  -- Repeat live organization, member, session and service enrollment checks on
  -- every page. A cursor is a position, never an access capability.
  PERFORM pactwoven.native_task_actor(p_actor,NULL,false);
  IF jsonb_typeof(p_query) IS DISTINCT FROM 'object' OR
    (p_query-ARRAY['limit','q','filter','after']::text[])<>'{}'::jsonb OR
    jsonb_typeof(p_query->'limit') IS DISTINCT FROM 'number' OR
    (p_query->>'limit') !~ '^[0-9]{1,3}$' OR
    jsonb_typeof(p_query->'q') IS DISTINCT FROM 'string' OR char_length(p_query->>'q')>180 OR
    (p_query->>'q') ~ '[\u0001-\u001f\u007f]' OR
    jsonb_typeof(p_query->'filter') IS DISTINCT FROM 'string' OR
    (p_query->>'filter') NOT IN ('all','active','completed') OR NOT(p_query ? 'after') THEN
    RAISE EXCEPTION USING ERRCODE='NT004',MESSAGE='Invalid task search';
  END IF;
  page_limit:=(p_query->>'limit')::integer;
  query_text:=p_query->>'q'; query_filter:=p_query->>'filter'; after_value:=p_query->'after';
  IF page_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION USING ERRCODE='NT004',MESSAGE='Invalid task page size'; END IF;
  IF after_value<>'null'::jsonb THEN
    IF jsonb_typeof(after_value) IS DISTINCT FROM 'object' OR
      (after_value-ARRAY['v','environment','organizationId','actorId','q','filter','createdAt','id']::text[])<>'{}'::jsonb OR
      after_value->'v' IS DISTINCT FROM '1'::jsonb OR
      after_value->>'environment' IS DISTINCT FROM p_actor->>'environment' OR
      after_value->>'organizationId' IS DISTINCT FROM p_actor->>'organizationId' OR
      after_value->>'actorId' IS DISTINCT FROM p_actor->>'actorId' OR
      after_value->>'q' IS DISTINCT FROM query_text OR after_value->>'filter' IS DISTINCT FROM query_filter OR
      jsonb_typeof(after_value->'id') IS DISTINCT FROM 'string' OR
      (after_value->>'id') !~ '^[A-Za-z0-9_-]{1,128}$' OR
      jsonb_typeof(after_value->'createdAt') IS DISTINCT FROM 'string' OR
      char_length(after_value->>'createdAt')>40 OR
      (after_value->>'createdAt') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$' THEN
      RAISE EXCEPTION USING ERRCODE='NT004',MESSAGE='Invalid task cursor';
    END IF;
    after_created:=(after_value->>'createdAt')::timestamptz; after_id:=after_value->>'id';
    IF NOT isfinite(after_created) THEN RAISE EXCEPTION USING ERRCODE='NT004',MESSAGE='Invalid task cursor'; END IF;
  END IF;

  -- Literal case-insensitive title substring: %, _ and backslash are ordinary
  -- characters. Limit + 1 proves continuation within this statement's view.
  -- Status/title changes on later requests are live, not a frozen snapshot;
  -- clients restart at page one to discover new tasks or newly matching rows.
  WITH candidates AS MATERIALIZED (
    SELECT t.* FROM pactwoven.native_tasks t
    WHERE (t.environment,t.organization_id,t.actor_id)=
      (p_actor->>'environment',p_actor->>'organizationId',p_actor->>'actorId')
      AND pactwoven.can_read_site(t.environment,t.organization_id,t.site_id)
      AND (query_text='' OR strpos(lower(t.title),lower(query_text))>0)
      AND (query_filter='all' OR (query_filter='completed' AND t.status='completed') OR
        (query_filter='active' AND t.status NOT IN ('completed','cancelled','failed')))
      AND (after_created IS NULL OR (t.created_at,t.id COLLATE "C")<(after_created,after_id COLLATE "C"))
    ORDER BY t.created_at DESC,t.id COLLATE "C" DESC LIMIT page_limit+1
  ), numbered AS MATERIALIZED (
    SELECT c.*,row_number() OVER(ORDER BY c.created_at DESC,c.id COLLATE "C" DESC) AS ordinal FROM candidates c
  )
  SELECT jsonb_build_object('items',coalesce((
    SELECT jsonb_agg(pactwoven.native_task_view(n.environment,n.organization_id,n.id,false) || CASE
      WHEN pactwoven.native_task_owner_valid(n.environment,n.organization_id,n.actor_id,p_actor->>'sessionId',n.site_id)
        THEN '{}'::jsonb ELSE '{"availableActions":[]}'::jsonb END ORDER BY n.ordinal)
    FROM numbered n WHERE n.ordinal<=page_limit),'[]'::jsonb),
    'next',CASE WHEN EXISTS(SELECT 1 FROM numbered WHERE ordinal>page_limit) THEN (
      SELECT jsonb_build_object('v',1,'environment',n.environment,'organizationId',n.organization_id,'actorId',n.actor_id,
        'q',query_text,'filter',query_filter,'createdAt',n.created_at,'id',n.id)
      FROM numbered n WHERE n.ordinal=page_limit) ELSE NULL END) INTO result;
  RETURN result;
EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow THEN
  RAISE EXCEPTION USING ERRCODE='NT004',MESSAGE='Invalid task search';
END $$;

REVOKE ALL ON FUNCTION pactwoven.native_task_identity_guard(),pactwoven.native_task_search(jsonb,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pactwoven.native_task_search(jsonb,jsonb) TO pactwoven_native_task_api;
COMMIT;
