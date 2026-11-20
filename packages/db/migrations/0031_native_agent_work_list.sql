BEGIN;
-- Listing exposes only original operator-supplied labels and current lifecycle
-- metadata. Retained review text, planner state and evidence bodies stay behind
-- their independently authorized read boundaries.
CREATE INDEX native_work_intent_owner_page ON pactwoven.native_work_intent_operations
 (environment,organization_id,actor_id,site_id,committed_at DESC,root_task_id COLLATE "C" DESC);
CREATE FUNCTION pactwoven.native_agent_work_list(p_actor jsonb,q jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE ctx jsonb;page_limit integer;after_time timestamptz;after_id text;answer jsonb;BEGIN
 PERFORM pactwoven.native_work_intent_require(pactwoven.native_memory_object(q,ARRAY['siteId','limit','q','filter','after'])
  AND pactwoven.native_memory_id(q->'siteId') AND pactwoven.native_memory_revision(q->'limit')
  AND pactwoven.native_memory_text(q->'q',0,180) AND (q->>'q') !~ '[\u0001-\u001f\u007f]'
  AND q->>'filter' IN('all','active','completed'),'NW004');
 PERFORM pactwoven.native_work_intent_require((q->>'limit')::bigint BETWEEN 1 AND 50,'NW004');page_limit:=(q->>'limit')::integer;
 IF q->'after'<>'null'::jsonb THEN
  PERFORM pactwoven.native_work_intent_require(pactwoven.native_memory_object(q->'after',ARRAY['createdAt','id'])
   AND pactwoven.native_memory_id(q#>'{after,id}') AND pactwoven.native_memory_time(q#>'{after,createdAt}') IS NOT NULL,'NW004');
  after_time:=pactwoven.native_memory_time(q#>'{after,createdAt}');after_id:=q#>>'{after,id}';
 END IF;
 ctx:=pactwoven.native_delegation_actor_locked(p_actor,q->>'siteId',false);
 WITH visible AS (
  SELECT r.root_task_id AS id,r.title,op.committed_at AS created_at,r.updated_at,g.body->>'expiresAt' AS expires_at,
   CASE WHEN r.phase NOT IN('completed','cancelled') AND(g.body->'revocation'<>'null'::jsonb
      OR pactwoven.native_memory_time(g.body->'expiresAt')<=clock_timestamp() OR t.authority<>pactwoven.native_delegation_reference(g)) THEN 'needs_review'
    WHEN r.phase='ready' THEN 'queued' WHEN r.phase IN('running','yielded') THEN 'working'
    WHEN r.phase='waiting_children' THEN 'waiting' WHEN r.phase='blocked' THEN 'needs_review' ELSE r.phase END AS state
  FROM pactwoven.native_work_intent_operations op
  JOIN pactwoven.native_delegation_root_runs r ON(r.environment,r.organization_id,r.root_task_id,r.actor_id,r.site_id)=
   (op.environment,op.organization_id,op.root_task_id,op.actor_id,op.site_id)
  JOIN pactwoven.native_delegation_grants g ON(g.environment,g.organization_id,g.id)=(r.environment,r.organization_id,r.grant_id)
  JOIN pactwoven.native_delegation_tasks t ON(t.environment,t.organization_id,t.id)=(r.environment,r.organization_id,r.root_task_id)
  WHERE(op.environment,op.organization_id,op.actor_id,op.site_id)=(ctx->>'environment',ctx->>'organizationId',ctx->>'actorId',ctx->>'siteId') AND r.managed
   AND(q->>'q'='' OR strpos(lower(r.title),lower(q->>'q'))>0)
   AND(after_time IS NULL OR(op.committed_at,op.root_task_id COLLATE "C")<(after_time,after_id COLLATE "C"))
 ), candidates AS MATERIALIZED (
  SELECT * FROM visible WHERE q->>'filter'='all' OR(q->>'filter'='completed' AND state='completed')
   OR(q->>'filter'='active' AND state NOT IN('completed','cancelled')) ORDER BY created_at DESC,id COLLATE "C" DESC LIMIT page_limit+1
 ), numbered AS MATERIALIZED (
  SELECT *,row_number() OVER(ORDER BY created_at DESC,id COLLATE "C" DESC) ordinal FROM candidates
 ) SELECT jsonb_build_object('scope',pactwoven.native_memory_scope(ctx),'items',coalesce((
  SELECT jsonb_agg(jsonb_build_object('id',id,'title',title,'state',state,'createdAt',pactwoven.native_memory_instant(created_at),
   'updatedAt',pactwoven.native_memory_instant(updated_at),'expiresAt',expires_at) ORDER BY ordinal) FROM numbered WHERE ordinal<=page_limit),'[]'),
  'next',CASE WHEN EXISTS(SELECT 1 FROM numbered WHERE ordinal>page_limit) THEN(
   SELECT jsonb_build_object('createdAt',pactwoven.native_memory_instant(created_at),'id',id) FROM numbered WHERE ordinal=page_limit) ELSE NULL END) INTO answer;
 PERFORM pactwoven.native_memory_notes_deadline(ctx);RETURN answer;
END $$;
REVOKE ALL ON FUNCTION pactwoven.native_agent_work_list(jsonb,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pactwoven.native_agent_work_list(jsonb,jsonb) TO pactwoven_native_delegation_api;
COMMIT;
