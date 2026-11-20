BEGIN;
-- P3 candidate: immutable paused instructions, current-revision execution and lifetime limits.

CREATE TABLE pactwoven.native_instruction_updates (
 environment text NOT NULL, organization_id text NOT NULL, root_task_id text NOT NULL,
 revision integer NOT NULL CHECK(revision BETWEEN 1 AND 16), actor_id text NOT NULL, request_key text NOT NULL,
 intent jsonb NOT NULL, response jsonb NOT NULL, instruction_digest text NOT NULL CHECK(instruction_digest ~ '^[a-f0-9]{64}$'),
 checkpoint_floor bigint NOT NULL, generation_floor bigint NOT NULL, usage_floor jsonb NOT NULL,
 recorded_at timestamptz NOT NULL,
 PRIMARY KEY(environment,organization_id,root_task_id,revision), UNIQUE(environment,organization_id,actor_id,request_key),
 FOREIGN KEY(environment,organization_id,root_task_id) REFERENCES pactwoven.native_delegation_root_runs(environment,organization_id,root_task_id));
CREATE TABLE pactwoven.native_instruction_bindings (
 environment text NOT NULL,organization_id text NOT NULL,root_task_id text NOT NULL,
 kind text NOT NULL CHECK(kind IN('task','checkpoint','input','epoch','refresh_command')), item_id text NOT NULL,
 revision integer NOT NULL CHECK(revision BETWEEN 0 AND 16),
 PRIMARY KEY(environment,organization_id,root_task_id,kind,item_id),
 FOREIGN KEY(environment,organization_id,root_task_id) REFERENCES pactwoven.native_delegation_root_runs(environment,organization_id,root_task_id));
CREATE TABLE pactwoven.native_instruction_applications (
 environment text NOT NULL,organization_id text NOT NULL,root_task_id text NOT NULL,revision integer NOT NULL,
 checkpoint_version bigint NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(environment,organization_id,root_task_id,revision),
 FOREIGN KEY(environment,organization_id,root_task_id,revision) REFERENCES pactwoven.native_instruction_updates(environment,organization_id,root_task_id,revision),
 FOREIGN KEY(environment,organization_id,root_task_id,checkpoint_version) REFERENCES pactwoven.native_delegation_root_checkpoints(environment,organization_id,root_task_id,version));

CREATE FUNCTION pactwoven.native_instruction_revision(e text,o text,r text) RETURNS integer LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT coalesce(max(revision),0) FROM pactwoven.native_instruction_updates WHERE(environment,organization_id,root_task_id)=($1,$2,$3) $$;
CREATE FUNCTION pactwoven.native_instruction_current(e text,o text,r text,k text,id text) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT coalesce((SELECT revision FROM pactwoven.native_instruction_bindings WHERE(environment,organization_id,root_task_id,kind,item_id)=($1,$2,$3,$4,$5)),0)=pactwoven.native_instruction_revision($1,$2,$3) $$;
CREATE FUNCTION pactwoven.native_instruction_active_refresh(e text,o text,r text) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM pactwoven.native_delegation_refresh_current c WHERE(c.environment,c.organization_id,c.root_task_id)=($1,$2,$3)
 AND pactwoven.native_instruction_current($1,$2,$3,'epoch',c.epoch::text)) $$;
CREATE FUNCTION pactwoven.native_instruction_entries(e text,o text,r text) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('sequence',revision,'text',intent->>'text','recordedAt',pactwoven.mandate_instant(recorded_at)) ORDER BY revision),'[]')
 FROM pactwoven.native_instruction_updates WHERE(environment,organization_id,root_task_id)=($1,$2,$3) $$;
CREATE FUNCTION pactwoven.native_instruction_metadata(e text,o text,r text) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 WITH v AS(SELECT jsonb_build_object('instructionRevision',pactwoven.native_instruction_revision($1,$2,$3),'instructions',pactwoven.native_instruction_entries($1,$2,$3)) body)
 SELECT body||jsonb_build_object('instructionDigest',pactwoven.native_delegation_hash(body)) FROM v $$;
CREATE FUNCTION pactwoven.native_instruction_input_digest(e text,o text,r text) RETURNS text LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT pactwoven.native_delegation_hash(jsonb_build_object('title',root.title,'prompt',root.prompt,'memoryReferences',notes.memory_references)||
 CASE WHEN pactwoven.native_instruction_revision($1,$2,$3)=0 THEN '{}'::jsonb ELSE pactwoven.native_instruction_metadata($1,$2,$3)-'instructions' END)
 FROM pactwoven.native_delegation_root_runs root JOIN pactwoven.native_delegation_root_note_selections notes USING(environment,organization_id,root_task_id)
 WHERE(root.environment,root.organization_id,root.root_task_id)=($1,$2,$3) $$;
CREATE FUNCTION pactwoven.native_instruction_usage_floor(e text,o text,r text) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT coalesce((SELECT usage_floor FROM pactwoven.native_instruction_updates WHERE(environment,organization_id,root_task_id)=($1,$2,$3) ORDER BY revision DESC LIMIT 1),
 '{"inputTokens":0,"outputTokens":0,"totalTokens":0}'::jsonb) $$;
CREATE FUNCTION pactwoven.native_instruction_usage(e text,o text,r text) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
 DECLARE cp record;state jsonb;floor jsonb;BEGIN
 floor:=pactwoven.native_instruction_usage_floor(e,o,r);
 FOR cp IN SELECT planner_state FROM pactwoven.native_delegation_root_checkpoints WHERE(environment,organization_id,root_task_id)=(e,o,r) ORDER BY version DESC LOOP
  BEGIN state:=cp.planner_state::jsonb;PERFORM pactwoven.native_delegation_refresh_require(state,'coordinator_state');
   PERFORM pactwoven.native_memory_require((state#>>'{usage,inputTokens}')::bigint+(state#>>'{usage,outputTokens}')::bigint=(state#>>'{usage,totalTokens}')::bigint,'ND004');
   IF(state#>>'{usage,totalTokens}')::bigint>=(floor->>'totalTokens')::bigint THEN RETURN state->'usage';END IF;
  EXCEPTION WHEN invalid_text_representation OR SQLSTATE 'ND004' THEN NULL;END;
 END LOOP;RETURN floor;END $$;
CREATE FUNCTION pactwoven.native_instruction_bind() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
 DECLARE k text;id text;r text;BEGIN
 IF TG_TABLE_NAME='native_delegation_tasks' THEN IF NEW.depth=0 THEN RETURN NEW;END IF;k:='task';id:=NEW.id;r:=NEW.root_task_id;
 ELSIF TG_TABLE_NAME='native_delegation_root_checkpoints' THEN k:='checkpoint';id:=NEW.version::text;r:=NEW.root_task_id;
 ELSIF TG_TABLE_NAME='native_delegation_root_inputs' THEN k:='input';id:=NEW.id::text;r:=NEW.root_task_id;
 ELSIF TG_TABLE_NAME='native_delegation_refresh_epochs' THEN k:='epoch';id:=NEW.epoch::text;r:=NEW.root_task_id;
 ELSE k:='refresh_command';id:=NEW.request_key;r:=NEW.root_task_id;END IF;
 INSERT INTO pactwoven.native_instruction_bindings VALUES(NEW.environment,NEW.organization_id,r,k,id,pactwoven.native_instruction_revision(NEW.environment,NEW.organization_id,r));RETURN NEW;
 END $$;
CREATE TRIGGER native_instruction_bind_task AFTER INSERT ON pactwoven.native_delegation_tasks FOR EACH ROW EXECUTE FUNCTION pactwoven.native_instruction_bind();
CREATE TRIGGER native_instruction_bind_checkpoint AFTER INSERT ON pactwoven.native_delegation_root_checkpoints FOR EACH ROW EXECUTE FUNCTION pactwoven.native_instruction_bind();
CREATE TRIGGER native_instruction_bind_input AFTER INSERT ON pactwoven.native_delegation_root_inputs FOR EACH ROW EXECUTE FUNCTION pactwoven.native_instruction_bind();
CREATE TRIGGER native_instruction_bind_epoch AFTER INSERT ON pactwoven.native_delegation_refresh_epochs FOR EACH ROW EXECUTE FUNCTION pactwoven.native_instruction_bind();
CREATE TRIGGER native_instruction_bind_refresh_command AFTER INSERT ON pactwoven.native_delegation_refresh_commands FOR EACH ROW EXECUTE FUNCTION pactwoven.native_instruction_bind();

CREATE FUNCTION pactwoven.native_instruction_legacy(e text,selector jsonb) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
 DECLARE t pactwoven.native_delegation_tasks;BEGIN
 SELECT * INTO t FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(e,selector->>'organizationId',selector->>'taskId');
 PERFORM pactwoven.native_memory_require(t.id IS NOT NULL AND pactwoven.native_instruction_revision(e,t.organization_id,t.root_task_id)=0,'ND001');END $$;
CREATE FUNCTION pactwoven.native_instruction_fence(e text,selector jsonb,q jsonb,worker boolean DEFAULT false) RETURNS integer LANGUAGE plpgsql SET search_path=pg_catalog AS $$
 DECLARE t pactwoven.native_delegation_tasks;rev integer;BEGIN
 PERFORM pactwoven.native_delegation_target(selector,true);PERFORM pactwoven.native_delegation_service(e,CASE WHEN worker THEN ARRAY['coordinator','worker'] ELSE ARRAY['coordinator'] END);
 SELECT * INTO t FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(e,selector->>'organizationId',selector->>'taskId');
 PERFORM pactwoven.native_memory_require(t.id IS NOT NULL,'ND001');
 -- Serialize instruction and epoch reads with every authoritative root mutation.
 PERFORM pactwoven.native_delegation_grant_locked(e,t.organization_id,t.grant_id);
 PERFORM 1 FROM pactwoven.native_delegation_root_runs WHERE(environment,organization_id,root_task_id)=(e,t.organization_id,t.root_task_id) FOR UPDATE;
 rev:=pactwoven.native_instruction_revision(e,t.organization_id,t.root_task_id);
 PERFORM pactwoven.native_memory_require(q->>'schemaVersion'='3' AND jsonb_typeof(q->'expectedInstructionRevision')='number'
 AND q->>'expectedInstructionRevision'=rev::text AND q->>'expectedRefreshEpoch'=pactwoven.native_delegation_refresh_epoch(e,t.organization_id,t.root_task_id)::text,'ND009');
 PERFORM pactwoven.native_memory_require(t.depth=0 OR pactwoven.native_instruction_current(e,t.organization_id,t.root_task_id,'task',t.id),'ND001');RETURN rev;
 END $$;
CREATE FUNCTION pactwoven.native_instruction_refresh_require(q jsonb,k text) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
 BEGIN IF q->>'schemaVersion'='3' THEN
 PERFORM pactwoven.native_memory_require(jsonb_typeof(q->'expectedInstructionRevision')='number' AND q->>'expectedInstructionRevision' ~ '^(0|[1-9]|1[0-6])$','ND004');
 PERFORM pactwoven.native_delegation_refresh_require((q-'expectedInstructionRevision')||'{"schemaVersion":2}'::jsonb,k);
 ELSE PERFORM pactwoven.native_delegation_refresh_require(q,k);END IF;END $$;

-- Match JavaScript string-length and whitespace semantics at the SQL boundary.
CREATE FUNCTION pactwoven.native_instruction_valid_text(t text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT t IS NOT NULL AND char_length(t) BETWEEN 1 AND 4000
 AND (SELECT coalesce(sum(CASE WHEN ascii(character)>65535 THEN 2 ELSE 1 END),0) FROM regexp_split_to_table(t,'') character)<=4000
 AND translate(t,E' \t\n\r\f'||chr(11)||U&'\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF','')<>'' $$;

CREATE OR REPLACE FUNCTION pactwoven.native_delegation_root_work_epoch0(e text, selector jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$ DECLARE ctx jsonb;r pactwoven.native_delegation_root_runs;c pactwoven.native_delegation_root_checkpoints;historical boolean:=false;answer jsonb;BEGIN
 ctx:=pactwoven.native_delegation_root_context(e,selector,true);SELECT * INTO r FROM pactwoven.native_delegation_root_runs
  WHERE(environment,organization_id,root_task_id)=(e,selector->>'organizationId',selector->>'taskId');
 SELECT * INTO c FROM pactwoven.native_delegation_root_checkpoints WHERE(environment,organization_id,root_task_id,version)=(e,r.organization_id,r.root_task_id,r.checkpoint_version);
 IF c.version IS NOT NULL AND NOT pactwoven.native_instruction_current(e,r.organization_id,r.root_task_id,'checkpoint',c.version::text) THEN c.body:=NULL;c.planner_state:=NULL;c.version:=NULL;END IF;
 IF c.version IS NOT NULL THEN
  historical:=c.generation<>(selector->>'generation')::bigint;
  BEGIN
   -- Saved planner data can contain derived text. Historical status alone is
   -- not authorization to return it after original source/reader access loss.
   PERFORM pactwoven.native_delegation_root_receipts(jsonb_set(ctx,'{usage,generation}',to_jsonb(c.generation)),c.input_receipts);
  EXCEPTION WHEN SQLSTATE 'NM001' OR SQLSTATE 'NM005' OR SQLSTATE 'NM006' OR SQLSTATE 'NM007' OR SQLSTATE 'NM008' OR SQLSTATE 'NM009' OR SQLSTATE 'ND001' THEN
   c.body:=NULL;c.planner_state:=NULL;historical:=true;
  END;
 END IF;
 answer:=jsonb_build_object('title',r.title,'prompt',r.prompt,'siteId',r.site_id,
  'grant',(SELECT body FROM pactwoven.native_delegation_grants WHERE(environment,organization_id,id)=(e,r.organization_id,r.grant_id)),
  'checkpointVersion',r.checkpoint_version,'checkpoint',c.body,'plannerState',c.planner_state,'historical',historical,
  'children',(SELECT coalesce(jsonb_agg(jsonb_build_object('taskId',t.id,'handoffId',t.handoff_id,'generation',t.generation,'assignmentVersion',t.assignment_version,'state',t.state,
    'publicationDigest',result.digest,'outcome',result.publication#>'{result,outcome}','assignment',a.assignment) ORDER BY t.id COLLATE "C"),'[]') FROM pactwoven.native_delegation_tasks t
    LEFT JOIN pactwoven.native_delegation_root_assignments a ON(a.environment,a.organization_id,a.task_id)=(t.environment,t.organization_id,t.id)
    LEFT JOIN pactwoven.native_delegation_results result ON(result.environment,result.organization_id,result.handoff_id)=(t.environment,t.organization_id,t.handoff_id)
    WHERE(t.environment,t.organization_id,t.root_task_id)=(e,r.organization_id,r.root_task_id) AND t.depth>0 AND pactwoven.native_instruction_current(e,r.organization_id,r.root_task_id,'task',t.id)),
  'inputReceipts',(SELECT coalesce(jsonb_agg(jsonb_build_object('receiptId',id,'digest',digest) ORDER BY id),'[]') FROM pactwoven.native_delegation_root_inputs
    WHERE(environment,organization_id,root_task_id,generation)=(e,r.organization_id,r.root_task_id,(selector->>'generation')::bigint)),
  'memoryReferences',(SELECT memory_references FROM pactwoven.native_delegation_root_note_selections WHERE(environment,organization_id,root_task_id)=(e,r.organization_id,r.root_task_id)));
 PERFORM pactwoven.native_memory_require(pactwoven.native_memory_time(ctx->'validUntil')>clock_timestamp(),'NM008');RETURN answer;
END $function$;

CREATE OR REPLACE FUNCTION pactwoven.native_delegation_root_handoff_epoch0(e text, selector jsonb, q jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$ DECLARE ctx jsonb;r pactwoven.native_delegation_root_runs;a pactwoven.native_delegation_root_assignments;selected jsonb;answer jsonb;BEGIN
 PERFORM pactwoven.native_delegation_root_require(q,'handoff');ctx:=pactwoven.native_delegation_root_context(e,selector,true);
 SELECT * INTO r FROM pactwoven.native_delegation_root_runs WHERE(environment,organization_id,root_task_id)=(e,selector->>'organizationId',selector->>'taskId');
 SELECT * INTO a FROM pactwoven.native_delegation_root_assignments WHERE(environment,organization_id,root_task_id,request_key)=(e,r.organization_id,r.root_task_id,q->>'requestKey');
 IF FOUND THEN PERFORM pactwoven.native_memory_require(a.intent=q,'ND009');RETURN a.response;END IF;
 -- A new free-text brief could copy consumed child material without its
 -- original reader closure. Plan all assignments before consuming results.
 -- This barrier lasts for the root's lifetime, including yield/recovery;
 -- exact retained assignment replay above returns metadata only.
 PERFORM pactwoven.native_memory_require(NOT EXISTS(SELECT 1 FROM pactwoven.native_delegation_root_inputs
  WHERE(environment,organization_id,root_task_id)=(e,r.organization_id,r.root_task_id) AND pactwoven.native_instruction_current(e,r.organization_id,r.root_task_id,'input',id::text)),'ND001');
 SELECT memory_references INTO selected FROM pactwoven.native_delegation_root_note_selections WHERE(environment,organization_id,root_task_id)=(e,r.organization_id,r.root_task_id);
 PERFORM pactwoven.native_memory_require(selected IS NOT NULL AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(q#>'{assignment,memoryReferences}') ref WHERE NOT selected @> jsonb_build_array(ref))
  AND(SELECT count(*)=count(DISTINCT x->>'memoryId') FROM jsonb_array_elements(q#>'{assignment,memoryReferences}') x)
  AND(jsonb_array_length(q#>'{assignment,memoryReferences}')=0 OR q#>>'{handoff,capability}'='read_scoped_memory'),'ND001');
 answer:=pactwoven.native_delegation_handoff_epoch0(e,selector,q->'handoff');
 INSERT INTO pactwoven.native_delegation_root_assignments VALUES(e,r.organization_id,r.root_task_id,q#>>'{handoff,childTaskId}',q#>>'{handoff,handoffId}',q->>'requestKey',
  (q#>>'{handoff,assignmentVersion}')::bigint,(q#>>'{handoff,generation}')::bigint,q,q->'assignment',answer);
 PERFORM pactwoven.native_delegation_root_context(e,selector,true);RETURN answer;
END $function$;

CREATE OR REPLACE FUNCTION pactwoven.native_delegation_root_coverage(e text,o text,id text) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$ SELECT coalesce(jsonb_agg(jsonb_build_object('taskId',t.id,'disposition',
 CASE WHEN t.state='settled' THEN coalesce(result.publication#>>'{result,outcome}','abandoned') ELSE 'abandoned' END) ORDER BY t.id COLLATE "C"),'[]')
 FROM pactwoven.native_delegation_tasks t LEFT JOIN pactwoven.native_delegation_results result ON(result.environment,result.organization_id,result.handoff_id)=(t.environment,t.organization_id,t.handoff_id)
 WHERE(t.environment,t.organization_id,t.root_task_id)=($1,$2,$3) AND t.depth>0 AND pactwoven.native_instruction_current($1,$2,$3,'task',t.id) AND t.state IN('settled','cancelled') $$;

CREATE OR REPLACE FUNCTION pactwoven.native_delegation_root_complete_c3(e text, selector jsonb, q jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$ DECLARE ctx jsonb;r pactwoven.native_delegation_root_runs;t pactwoven.native_delegation_tasks;prior pactwoven.native_delegation_root_completions;
 identity jsonb;coverage jsonb;deadline timestamptz;declared timestamptz;answer jsonb;BEGIN
 PERFORM pactwoven.native_delegation_root_require(q,'complete');identity:=pactwoven.native_delegation_service(e,ARRAY['coordinator']);PERFORM pactwoven.native_delegation_target(selector,true);
 SELECT * INTO t FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(e,selector->>'organizationId',selector->>'taskId');
 PERFORM pactwoven.native_memory_require(t.id IS NOT NULL AND t.depth=0 AND t.identity=identity,'ND001');PERFORM pactwoven.native_delegation_grant_locked(e,t.organization_id,t.grant_id);
 SELECT * INTO prior FROM pactwoven.native_delegation_root_completions WHERE(environment,organization_id,root_task_id)=(e,t.organization_id,t.id);
 IF FOUND THEN PERFORM pactwoven.native_memory_require(prior.publication=q AND prior.generation=(selector->>'generation')::bigint,'ND009');
  RETURN jsonb_build_object('kind','duplicate','publicationDigest',prior.digest,'rootTaskId',t.id,'execution','none','domainCompletion',false);END IF;
 ctx:=pactwoven.native_delegation_root_context(e,selector,true);SELECT * INTO r FROM pactwoven.native_delegation_root_runs WHERE(environment,organization_id,root_task_id)=(e,t.organization_id,t.id);
 PERFORM pactwoven.native_memory_require(r.checkpoint_version=(q->>'expectedCheckpointVersion')::bigint AND NOT EXISTS(SELECT 1 FROM pactwoven.native_delegation_tasks
  WHERE(environment,organization_id,root_task_id)=(e,t.organization_id,t.id) AND depth>0 AND pactwoven.native_instruction_current(e,t.organization_id,t.id,'task',native_delegation_tasks.id) AND(state NOT IN('settled','cancelled') OR(state='cancelled' AND NOT EXISTS
   (SELECT 1 FROM pactwoven.native_delegation_root_dispositions d WHERE(d.environment,d.organization_id,d.task_id)=(e,t.organization_id,native_delegation_tasks.id))))),'ND009');
 PERFORM pactwoven.native_delegation_refresh_current_complete(ctx,q#>>'{result,outcome}'='blocked');
 coverage:=pactwoven.native_delegation_root_coverage(e,t.organization_id,t.id);PERFORM pactwoven.native_memory_require(q->'coverage'=coverage,'ND009');
 IF q#>>'{result,outcome}'='blocked' THEN PERFORM pactwoven.native_delegation_root_receipt_manifest(ctx,q->'inputReceipts');
 ELSE deadline:=pactwoven.native_delegation_root_receipts(ctx,q->'inputReceipts');END IF;
 declared:=pactwoven.native_memory_time(q#>'{result,evidenceValidUntil}');
 PERFORM pactwoven.native_memory_require((q#>>'{result,outcome}'='blocked' AND q#>'{result,artifacts}'='[]'::jsonb AND q#>'{result,evidenceValidUntil}'='null'::jsonb
   AND q#>>'{result,title}'='Work needs review' AND q#>>'{result,summary}'='The work could not be completed with current, permitted evidence.')
  OR(q#>>'{result,outcome}'='advice_ready' AND jsonb_array_length(q#>'{result,artifacts}')>0 AND declared>clock_timestamp() AND(deadline IS NULL OR declared<=deadline)),'NM008');
 PERFORM pactwoven.native_memory_require((SELECT count(*)=count(DISTINCT x->>'id') FROM jsonb_array_elements(q#>'{result,artifacts}') x),'ND004');
 -- Every successful child must actually have been consumed in this generation.
 PERFORM pactwoven.native_memory_require(q#>>'{result,outcome}'='blocked' OR NOT EXISTS(SELECT 1 FROM pactwoven.native_delegation_results child JOIN pactwoven.native_delegation_tasks task
  ON(task.environment,task.organization_id,task.handoff_id)=(child.environment,child.organization_id,child.handoff_id)
  WHERE(task.environment,task.organization_id,task.root_task_id)=(e,t.organization_id,t.id) AND pactwoven.native_instruction_current(e,t.organization_id,t.id,'task',task.id) AND child.publication#>>'{result,outcome}'='advice_ready' AND NOT pactwoven.native_delegation_refresh_covered(ctx,task.id)
  AND NOT EXISTS(SELECT 1 FROM pactwoven.native_delegation_root_inputs i,jsonb_array_elements(i.body->'choices') c
   WHERE(i.environment,i.organization_id,i.root_task_id,i.generation)=(e,t.organization_id,t.id,t.generation) AND c->>'handoffId'=child.handoff_id AND c->>'publicationDigest'=child.digest)),'NM005');
 INSERT INTO pactwoven.native_delegation_root_completions VALUES(e,t.organization_id,t.id,t.generation,q,pactwoven.native_delegation_hash(q),clock_timestamp()) RETURNING * INTO prior;
 PERFORM pactwoven.native_delegation_root_context(e,selector,true);PERFORM pactwoven.native_memory_require((deadline IS NULL OR deadline>clock_timestamp()) AND(declared IS NULL OR declared>clock_timestamp()),'NM008');
 UPDATE pactwoven.native_delegation_root_runs SET phase=CASE WHEN q#>>'{result,outcome}'='blocked' THEN 'blocked' ELSE 'completed' END,
  reason=CASE WHEN q#>>'{result,outcome}'='blocked' THEN 'reconciliation' ELSE 'none' END,control_version=control_version+1,updated_at=clock_timestamp() WHERE(environment,organization_id,root_task_id)=(e,t.organization_id,t.id);
 UPDATE pactwoven.native_delegation_tasks SET state='settled',lease_token=NULL,lease_until=NULL WHERE(environment,organization_id,id)=(e,t.organization_id,t.id);
 UPDATE pactwoven.native_delegation_outbox SET state='suppressed',token=NULL,lease_until=NULL WHERE(environment,organization_id,task_id)=(e,t.organization_id,t.id);
 answer:=jsonb_build_object('kind','accepted','publicationDigest',prior.digest,'rootTaskId',t.id,'execution',CASE WHEN q#>>'{result,outcome}'='blocked' THEN 'none' ELSE 'advisory_only' END,'domainCompletion',false);
 INSERT INTO pactwoven.native_delegation_root_commands VALUES(e,t.organization_id,t.id,q->>'requestKey','complete',t.generation,t.identity,q,answer);RETURN answer;
END $function$;

CREATE OR REPLACE FUNCTION pactwoven.native_delegation_root_validate_inputs(ctx jsonb, choices jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$ DECLARE choice jsonb;result pactwoven.native_delegation_results;t pactwoven.native_delegation_tasks;
 a pactwoven.native_delegation_artifacts;u pactwoven.native_memory_usages;bound_ctx jsonb;checked jsonb;root_checked jsonb;artifacts jsonb;items jsonb:='[]';until_time timestamptz;usage_count integer:=0;BEGIN
 PERFORM pactwoven.native_delegation_refresh_choices(ctx,choices);
 PERFORM pactwoven.native_memory_require(jsonb_typeof(choices)='array' AND jsonb_array_length(choices) BETWEEN 1 AND 32 AND
  (SELECT count(*)=count(DISTINCT x->>'handoffId') FROM jsonb_array_elements(choices) x),'ND004');
 FOR choice IN SELECT x FROM jsonb_array_elements(choices) x LOOP
  SELECT * INTO result FROM pactwoven.native_delegation_results WHERE(environment,organization_id,handoff_id)=(ctx->>'environment',ctx->>'organizationId',choice->>'handoffId');
  SELECT * INTO t FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,handoff_id)=(ctx->>'environment',ctx->>'organizationId',choice->>'handoffId');
  PERFORM pactwoven.native_memory_require(result.handoff_id IS NOT NULL AND result.digest=choice->>'publicationDigest' AND t.root_task_id=ctx#>>'{usage,taskId}'
   AND t.depth>0 AND (ctx->>'purpose'='human_review' OR pactwoven.native_instruction_current(t.environment,t.organization_id,t.root_task_id,'task',t.id)) AND t.state='settled' AND t.site_id=ctx->>'siteId' AND t.authority=ctx->'authority'
   AND(t.generation,t.assignment_version)=(result.generation,result.assignment_version),'ND001');
  artifacts:='[]';
  FOR a IN SELECT stored.* FROM jsonb_array_elements(result.publication->'artifacts') WITH ORDINALITY item(value,position)
   JOIN pactwoven.native_delegation_artifacts stored ON(stored.environment,stored.organization_id,stored.id,stored.revision)=
    (t.environment,t.organization_id,item.value#>>'{reference,artifactId}',(item.value#>>'{reference,revision}')::bigint) ORDER BY item.position LOOP
   PERFORM pactwoven.native_memory_require(a.task_id=t.id AND a.site_id=t.site_id AND a.publication_digest=result.digest AND a.valid_until>clock_timestamp()
    AND a.reference->>'digest'=pactwoven.native_delegation_hash(a.body),'NM008');
   artifacts:=artifacts||jsonb_build_array(jsonb_build_object('reference',a.reference,'body',a.body));until_time:=least(until_time,a.valid_until);
  END LOOP;
  PERFORM pactwoven.native_memory_require(artifacts=result.publication->'artifacts','NM009');
  IF jsonb_array_length(result.publication->'memoryUsage')>0 THEN
   PERFORM pactwoven.native_memory_require(ctx->'authority'=t.authority AND EXISTS(SELECT 1 FROM pactwoven.native_delegation_grants g
    WHERE(g.environment,g.organization_id,g.id)=(t.environment,t.organization_id,t.grant_id) AND g.body#>'{scope,capabilities}' ? 'read_scoped_memory'),'ND001');
   SELECT * INTO u FROM pactwoven.native_memory_usages WHERE id=(result.publication#>>'{memoryUsage,0,usageId}')::uuid;
   PERFORM pactwoven.native_memory_require(u.id IS NOT NULL AND(u.environment,u.organization_id,u.site_id)=(t.environment,t.organization_id,t.site_id)
    AND u.context#>>'{usage,taskId}'=t.id AND u.context#>>'{usage,handoffId}'=t.handoff_id AND u.context#>>'{usage,generation}'=t.generation::text
    AND u.publication_digest=result.digest,'NM009');
   bound_ctx:=u.context_binding||jsonb_build_object('validUntil',ctx->'validUntil');
   checked:=pactwoven.native_memory_assert_usage_locked(t.environment,bound_ctx,result.publication->'memoryUsage',result.digest);
   until_time:=least(until_time,pactwoven.native_memory_time(checked->'dataValidUntil'));usage_count:=usage_count+(checked->>'usageCount')::integer;
   PERFORM pactwoven.native_memory_require(usage_count<=128,'NM007');
   FOR u IN SELECT * FROM pactwoven.native_memory_usages WHERE(environment,organization_id,site_id)=(t.environment,t.organization_id,t.site_id)
    AND context->'usage'=bound_ctx->'usage' ORDER BY id LOOP
    -- Re-evaluate the same immutable closure using the root's own reader ACL.
    -- This creates no ordinary memory usage or invented root handoff.
    root_checked:=pactwoven.native_memory_evaluate_locked(pactwoven.native_memory_data_context(ctx),u.selection->'root',date_trunc('milliseconds',clock_timestamp()));
    PERFORM pactwoven.native_memory_require(root_checked#>'{selection,memories}'=u.selection->'memories'
     AND root_checked#>'{selection,sources}'=u.selection->'sources','NM005');
    until_time:=least(until_time,pactwoven.native_memory_time(root_checked#>'{selection,validUntil}'));
   END LOOP;
  ELSE
   PERFORM pactwoven.native_memory_require(NOT EXISTS(SELECT 1 FROM pactwoven.native_memory_usages WHERE(environment,organization_id,site_id)=(t.environment,t.organization_id,t.site_id)
    AND context#>>'{usage,taskId}'=t.id AND context#>>'{usage,handoffId}'=t.handoff_id AND context#>>'{usage,generation}'=t.generation::text),'NM009');
  END IF;
  items:=items||jsonb_build_array(jsonb_build_object('handoffId',t.handoff_id,'publicationDigest',result.digest,'outcome',result.publication#>'{result,outcome}','artifacts',artifacts));
 END LOOP;
 PERFORM pactwoven.native_memory_require(octet_length(items::text)<=524288 AND pactwoven.native_memory_time(ctx->'validUntil')>clock_timestamp()
  AND(until_time IS NULL OR until_time>clock_timestamp()),'NM008');
 RETURN jsonb_build_object('results',items,'dataValidUntil',CASE WHEN until_time IS NOT NULL THEN pactwoven.mandate_instant(until_time) END);
END $function$;

CREATE OR REPLACE FUNCTION pactwoven.native_delegation_root_work_v2_instruction_base(e text,selector jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE work jsonb;c pactwoven.native_delegation_refresh_current;ep pactwoven.native_delegation_refresh_epochs;slots jsonb;s jsonb;out_slots jsonb:='[]';usage jsonb;state jsonb;operations jsonb;BEGIN
 work:=pactwoven.native_delegation_root_work_epoch0(e,selector);
 SELECT * INTO c FROM pactwoven.native_delegation_refresh_current WHERE(environment,organization_id,root_task_id)=(e,selector->>'organizationId',selector->>'taskId') AND pactwoven.native_instruction_active_refresh(e,organization_id,root_task_id);
 IF NOT FOUND THEN RETURN jsonb_build_object('schemaVersion',2,'refreshEpoch',pactwoven.native_delegation_refresh_epoch(e,selector->>'organizationId',selector->>'taskId'),'work',work,'refresh',NULL);END IF;
 SELECT * INTO ep FROM pactwoven.native_delegation_refresh_epochs WHERE(environment,organization_id,root_task_id,epoch)=(c.environment,c.organization_id,c.root_task_id,c.epoch);
 slots:=pactwoven.native_delegation_refresh_slots(c.environment,c.organization_id,c.root_task_id,c.epoch);
 PERFORM pactwoven.native_memory_require(c.lineage_digest=pactwoven.native_delegation_hash(slots),'NM009');
 FOR s IN SELECT value FROM jsonb_array_elements(slots) LOOP
 out_slots:=out_slots||jsonb_build_array(s||jsonb_build_object('admission',CASE WHEN EXISTS(SELECT 1 FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(e,c.organization_id,s->>'taskId')) THEN 'admitted'
 WHEN EXISTS(SELECT 1 FROM pactwoven.native_delegation_refresh_dispositions WHERE(environment,organization_id,root_task_id,task_id)=(e,c.organization_id,c.root_task_id,s->>'taskId')) THEN 'abandoned' ELSE 'pending' END));END LOOP;
 usage:=ep.usage;
 BEGIN state:=(SELECT planner_state::jsonb FROM pactwoven.native_delegation_root_checkpoints WHERE(environment,organization_id,root_task_id,version)=(e,c.organization_id,c.root_task_id,(work->>'checkpointVersion')::bigint));
 PERFORM pactwoven.native_delegation_refresh_require(state,'coordinator_state');usage:=state->'usage';EXCEPTION WHEN invalid_text_representation OR SQLSTATE 'ND004' THEN NULL;END;
 SELECT coalesce(jsonb_agg(response ORDER BY recorded_at,request_key COLLATE "C"),'[]') INTO operations FROM pactwoven.native_delegation_refresh_commands WHERE(environment,organization_id,root_task_id)=(e,c.organization_id,c.root_task_id) AND pactwoven.native_instruction_current(e,c.organization_id,c.root_task_id,'refresh_command',request_key);
 RETURN jsonb_build_object('schemaVersion',2,'refreshEpoch',c.epoch,'work',work,'refresh',jsonb_build_object('lineageDigest',c.lineage_digest,'planBasis',ep.original_plan,'slots',out_slots,'usage',usage,'operations',operations));END $$;

CREATE OR REPLACE FUNCTION pactwoven.native_delegation_root_materials_v2_instruction_base(e text,selector jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE material jsonb;t pactwoven.native_delegation_tasks;c pactwoven.native_delegation_refresh_current;s jsonb;original_digest text;BEGIN
 material:=pactwoven.native_delegation_root_materials_epoch0(e,selector);SELECT * INTO t FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(e,selector->>'organizationId',selector->>'taskId');
 SELECT * INTO c FROM pactwoven.native_delegation_refresh_current WHERE(environment,organization_id,root_task_id)=(e,t.organization_id,t.root_task_id) AND pactwoven.native_instruction_active_refresh(e,organization_id,root_task_id);
 IF NOT FOUND THEN RETURN jsonb_build_object('schemaVersion',2,'refreshEpoch',pactwoven.native_delegation_refresh_epoch(e,t.organization_id,t.root_task_id),'material',material,'refresh',NULL);END IF;
 SELECT value INTO s FROM jsonb_array_elements(pactwoven.native_delegation_refresh_slots(e,t.organization_id,t.root_task_id,c.epoch)) WHERE value->>'taskId'=t.id;
 PERFORM pactwoven.native_memory_require(s IS NOT NULL AND s->>'handoffId'=t.handoff_id,'ND001');
 SELECT result.digest INTO original_digest FROM pactwoven.native_delegation_tasks original JOIN pactwoven.native_delegation_results result ON(result.environment,result.organization_id,result.handoff_id)=(original.environment,original.organization_id,original.handoff_id)
 WHERE(original.environment,original.organization_id,original.id)=(e,t.organization_id,coalesce(s->>'predecessorTaskId',s->>'originalTaskId'));
 RETURN jsonb_build_object('schemaVersion',2,'refreshEpoch',c.epoch,'material',material,'refresh',jsonb_build_object('lineageDigest',c.lineage_digest,'logicalTaskId',s->>'logicalTaskId','originalTaskId',s->>'originalTaskId',
 'originalPublicationDigest',original_digest,'requiresPublicObservation',s->>'kind'='replacement' AND t.capability='research_public_sources'));END $$;

CREATE OR REPLACE FUNCTION pactwoven.native_delegation_refresh_generation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE c pactwoven.native_delegation_refresh_current;BEGIN
 IF NEW.depth=0 THEN SELECT * INTO c FROM pactwoven.native_delegation_refresh_current WHERE(environment,organization_id,root_task_id)=(NEW.environment,NEW.organization_id,NEW.id);
 IF FOUND AND pactwoven.native_instruction_active_refresh(NEW.environment,NEW.organization_id,NEW.id) THEN INSERT INTO pactwoven.native_delegation_refresh_generations VALUES(NEW.environment,NEW.organization_id,NEW.id,NEW.generation,c.epoch,c.lineage_digest) ON CONFLICT DO NOTHING;
 PERFORM pactwoven.native_memory_require(EXISTS(SELECT 1 FROM pactwoven.native_delegation_refresh_generations g WHERE(g.environment,g.organization_id,g.root_task_id,g.generation,g.epoch,g.lineage_digest)=(NEW.environment,NEW.organization_id,NEW.id,NEW.generation,c.epoch,c.lineage_digest)),'ND009');END IF;END IF;RETURN NEW;END $$;

CREATE OR REPLACE FUNCTION pactwoven.native_delegation_result_commit_v2_instruction_base(e text,selector jsonb,q jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE service jsonb;t pactwoven.native_delegation_tasks;c pactwoven.native_delegation_refresh_current;p pactwoven.native_delegation_refresh_observations;prior pactwoven.native_delegation_results;
 ctx jsonb;publication jsonb;observations jsonb;ob jsonb;item jsonb;ev jsonb;h jsonb;s jsonb;ep bigint;pd text;vd text;receipt jsonb;ids jsonb;actual_ids jsonb;observed timestamptz;until_time timestamptz;BEGIN
 PERFORM pactwoven.native_instruction_refresh_require(q,'publication');PERFORM pactwoven.native_delegation_target(selector,true);service:=pactwoven.native_delegation_service(e,ARRAY['coordinator','worker']);
 publication:=q->'publication';observations:=q->'observations';ep:=(q->>'expectedRefreshEpoch')::bigint;pd:=pactwoven.native_delegation_hash(publication);vd:=CASE WHEN observations='[]'::jsonb THEN NULL ELSE pactwoven.native_delegation_hash(observations) END;
 SELECT * INTO t FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(e,selector->>'organizationId',selector->>'taskId');
 PERFORM pactwoven.native_memory_require(t.id IS NOT NULL AND t.identity=service AND t.depth>0,'ND001');
 PERFORM 1 FROM pactwoven.native_delegation_grants WHERE(environment,organization_id,id)=(e,t.organization_id,t.grant_id) FOR UPDATE;
 SELECT * INTO prior FROM pactwoven.native_delegation_results WHERE(environment,organization_id,handoff_id)=(e,t.organization_id,t.handoff_id);
 SELECT * INTO p FROM pactwoven.native_delegation_refresh_observations WHERE(environment,organization_id,handoff_id)=(e,t.organization_id,t.handoff_id);
 IF prior.handoff_id IS NOT NULL AND p.handoff_id IS NOT NULL THEN
 PERFORM pactwoven.native_memory_require(prior.publication=publication AND p.publication_digest=pd AND p.observations=observations AND p.epoch=ep
  AND publication#>>'{result,generation}'=selector->>'generation' AND publication#>>'{result,handoffId}'=selector->>'handoffId' AND publication#>>'{result,childTaskId}'=selector->>'taskId' AND publication#>>'{result,organizationId}'=selector->>'organizationId' AND publication#>>'{result,environment}'=e AND publication#>'{result,sender}'=service,'ND009');
 RETURN jsonb_build_object('schemaVersion',coalesce((q->>'schemaVersion')::int,2),'refreshEpoch',ep,'publicationDigest',pd,'provenanceDigest',vd);END IF;
 SELECT * INTO c FROM pactwoven.native_delegation_refresh_current WHERE(environment,organization_id,root_task_id)=(e,t.organization_id,t.root_task_id) AND pactwoven.native_instruction_active_refresh(e,organization_id,root_task_id);
 IF c.epoch IS NULL THEN PERFORM pactwoven.native_memory_require(ep=pactwoven.native_delegation_refresh_epoch(e,t.organization_id,t.root_task_id) AND observations='[]'::jsonb,'ND004');receipt:=pactwoven.native_delegation_result_commit_epoch0(e,selector,publication);
 RETURN jsonb_build_object('schemaVersion',coalesce((q->>'schemaVersion')::int,2),'refreshEpoch',ep,'publicationDigest',receipt->>'publicationDigest','provenanceDigest',NULL);END IF;
 PERFORM pactwoven.native_memory_require(c.epoch=ep AND prior.handoff_id IS NULL,'ND009');
 ctx:=pactwoven.native_delegation_task_context_locked(e,selector,'result_publish');
 SELECT value INTO s FROM jsonb_array_elements(pactwoven.native_delegation_refresh_slots(e,t.organization_id,t.root_task_id,ep)) WHERE value->>'taskId'=t.id;
 PERFORM pactwoven.native_memory_require(s IS NOT NULL AND s->>'kind'='replacement' AND s->>'handoffId'=t.handoff_id,'ND001');
 SELECT body INTO h FROM pactwoven.native_delegation_envelopes WHERE(environment,organization_id,handoff_id,assignment_version,generation,kind)=(e,t.organization_id,t.handoff_id,t.assignment_version,t.generation,'handoff');
 IF t.capability='research_public_sources' AND publication#>>'{result,outcome}'='advice_ready' THEN
 PERFORM pactwoven.native_memory_require(jsonb_array_length(observations) BETWEEN 1 AND 3 AND(SELECT count(*)=count(DISTINCT value->>'requestedUrl') FROM jsonb_array_elements(observations)),'ND004');
 ids:='[]';actual_ids:='[]';
 FOR item IN SELECT value FROM jsonb_array_elements(publication->'artifacts') LOOP
 FOR ev IN SELECT value FROM jsonb_array_elements(item#>'{body,evidence}') WHERE value->>'kind'='public_source' LOOP
 actual_ids:=actual_ids||jsonb_build_array(ev->>'id');
 PERFORM pactwoven.native_memory_require(EXISTS(SELECT 1 FROM jsonb_array_elements(observations) x WHERE x->'evidenceIds' @> jsonb_build_array(ev->>'id') AND x->>'finalUrl'=ev->>'url'
  AND x->>'observedAt'=ev->>'observedAt' AND x->>'validUntil'=ev->>'validUntil'),'NM009');END LOOP;END LOOP;
 FOR ob IN SELECT value FROM jsonb_array_elements(observations) LOOP
 observed:=pactwoven.native_memory_time(ob->'observedAt');until_time:=pactwoven.native_memory_time(ob->'validUntil');
 PERFORM pactwoven.native_memory_require(ob->>'requestedUrl' LIKE 'https://%' AND ob->>'finalUrl' LIKE 'https://%' AND ob->>'requestedUrl' !~ '[#[:space:]]' AND ob->>'finalUrl' !~ '[#[:space:]]' AND ob->>'requestedUrl' !~ '^https://[^/?#]*@' AND ob->>'finalUrl' !~ '^https://[^/?#]*@'
  AND observed>=pactwoven.native_memory_time(h->'issuedAt') AND observed<=clock_timestamp() AND until_time>clock_timestamp() AND until_time<=observed+interval '15 minutes'
  AND until_time<=date_trunc('day',observed AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'+interval '1 day'
  AND t.deadline_at>clock_timestamp() AND pactwoven.native_memory_time(publication#>'{result,evidenceValidUntil}')<=least(until_time,t.deadline_at),'NM008');
 ids:=ids||(ob->'evidenceIds');END LOOP;
 PERFORM pactwoven.native_memory_require((SELECT count(*)=count(DISTINCT value) FROM jsonb_array_elements(ids)) AND
 (SELECT coalesce(jsonb_agg(value ORDER BY value::text COLLATE "C"),'[]') FROM jsonb_array_elements(ids))=(SELECT coalesce(jsonb_agg(value ORDER BY value::text COLLATE "C"),'[]') FROM jsonb_array_elements(actual_ids)),'NM009');
 ELSE PERFORM pactwoven.native_memory_require(observations='[]'::jsonb,'ND004');END IF;
 receipt:=pactwoven.native_delegation_result_commit_epoch0(e,selector,publication);
 INSERT INTO pactwoven.native_delegation_refresh_observations VALUES(e,t.organization_id,t.root_task_id,ep,t.id,t.handoff_id,pd,observations,pactwoven.native_delegation_hash(observations),clock_timestamp());
 PERFORM pactwoven.native_memory_require(pactwoven.native_memory_time(ctx->'validUntil')>clock_timestamp() AND t.deadline_at>clock_timestamp() AND(publication#>>'{result,outcome}'='failed' OR pactwoven.native_memory_time(publication#>'{result,evidenceValidUntil}')>clock_timestamp()),'ND001');
 RETURN jsonb_build_object('schemaVersion',coalesce((q->>'schemaVersion')::int,2),'refreshEpoch',ep,'publicationDigest',receipt->>'publicationDigest','provenanceDigest',vd);END $$;

CREATE OR REPLACE FUNCTION pactwoven.native_delegation_refresh_current_complete(ctx jsonb,blocked boolean) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE slots jsonb;s jsonb;t pactwoven.native_delegation_tasks;ep bigint;BEGIN
 ep:=pactwoven.native_delegation_refresh_epoch(ctx->>'environment',ctx->>'organizationId',ctx#>>'{usage,taskId}');IF NOT pactwoven.native_instruction_active_refresh(ctx->>'environment',ctx->>'organizationId',ctx#>>'{usage,taskId}') THEN RETURN;END IF;
 slots:=pactwoven.native_delegation_refresh_slots(ctx->>'environment',ctx->>'organizationId',ctx#>>'{usage,taskId}',ep);
 FOR s IN SELECT value FROM jsonb_array_elements(slots) LOOP
 SELECT * INTO t FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(ctx->>'environment',ctx->>'organizationId',s->>'taskId');
 PERFORM pactwoven.native_memory_require(t.id IS NOT NULL AND t.state IN('settled','cancelled'),'ND009');
 IF NOT blocked THEN PERFORM pactwoven.native_memory_require(t.state='settled' AND EXISTS(SELECT 1 FROM pactwoven.native_delegation_results result
 WHERE(result.environment,result.organization_id,result.handoff_id)=(t.environment,t.organization_id,t.handoff_id) AND result.publication#>>'{result,outcome}'='advice_ready'),'NM005');END IF;
 END LOOP;END $$;

CREATE OR REPLACE FUNCTION pactwoven.native_delegation_root_fence(r pactwoven.native_delegation_root_runs,why text,root_state text) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE ep bigint;l pactwoven.native_delegation_refresh_lineages;t pactwoven.native_delegation_tasks;root pactwoven.native_delegation_tasks;b jsonb;slots jsonb;s jsonb;changed boolean:=false;BEGIN
 ep:=pactwoven.native_delegation_refresh_epoch(r.environment,r.organization_id,r.root_task_id);
 IF pactwoven.native_instruction_active_refresh(r.environment,r.organization_id,r.root_task_id) THEN
  SELECT * INTO root FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(r.environment,r.organization_id,r.root_task_id);
  slots:=pactwoven.native_delegation_refresh_slots(r.environment,r.organization_id,r.root_task_id,ep);
  IF why<>'cancel' AND root.attempt<root.attempt_limit AND pactwoven.native_delegation_refresh_recovery_fits(r.environment,r.organization_id,r.root_task_id)
   AND(root_state='ready' OR why='pause') THEN
   FOR s IN SELECT value FROM jsonb_array_elements(slots) LOOP
    SELECT * INTO t FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(r.environment,r.organization_id,s->>'taskId');
    IF t.id IS NULL OR t.state IN('settled','cancelled') THEN CONTINUE;END IF;
    SELECT * INTO l FROM pactwoven.native_delegation_refresh_lineages WHERE(environment,organization_id,root_task_id,epoch,logical_task_id)=(r.environment,r.organization_id,r.root_task_id,ep,s->>'logicalTaskId') ORDER BY revision DESC LIMIT 1;
    b:=s||jsonb_build_object('taskId',gen_random_uuid()::text,'handoffId',gen_random_uuid()::text,'requestKey',gen_random_uuid()::text,'predecessorTaskId',t.id,'kind','replacement');
    INSERT INTO pactwoven.native_delegation_refresh_lineages VALUES(r.environment,r.organization_id,r.root_task_id,ep,l.logical_task_id,l.revision+1,b->>'taskId',b->>'handoffId','replacement',b,l.original_handoff,clock_timestamp());changed:=true;
   END LOOP;
   IF changed THEN PERFORM pactwoven.native_delegation_refresh_manifest(r.environment,r.organization_id,r.root_task_id,ep);END IF;
  ELSIF why='cancel' OR(why='crash' AND root_state='paused') THEN
   INSERT INTO pactwoven.native_delegation_refresh_dispositions(environment,organization_id,root_task_id,task_id,reason)
    SELECT r.environment,r.organization_id,r.root_task_id,pending_slot.value->>'taskId',CASE WHEN why='cancel' THEN 'cancelled' ELSE 'blocked' END
    FROM jsonb_array_elements(slots) AS pending_slot(value) WHERE NOT EXISTS(SELECT 1 FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(r.environment,r.organization_id,pending_slot.value->>'taskId')) ON CONFLICT DO NOTHING;
  END IF;
 END IF;
 PERFORM pactwoven.native_delegation_root_fence_epoch0(r,why,root_state);
END $$;

CREATE OR REPLACE FUNCTION pactwoven.native_delegation_root_inputs_c3(e text, selector jsonb, q jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$ DECLARE ctx jsonb;t pactwoven.native_delegation_tasks;prior pactwoven.native_delegation_root_commands;r pactwoven.native_delegation_root_inputs;checked jsonb;body jsonb;answer jsonb;BEGIN
 PERFORM pactwoven.native_delegation_root_require(q,'inputs');ctx:=pactwoven.native_delegation_root_context(e,selector,true);
 SELECT * INTO t FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(e,selector->>'organizationId',selector->>'taskId');
 SELECT * INTO prior FROM pactwoven.native_delegation_root_commands WHERE(environment,organization_id,root_task_id,request_key)=(e,t.organization_id,t.id,q->>'requestKey');
 IF FOUND THEN
  PERFORM pactwoven.native_memory_require(prior.kind='inputs' AND prior.intent=q AND prior.generation=t.generation AND prior.identity=t.identity,'ND009');
  checked:=pactwoven.native_delegation_root_validate_inputs(ctx,q->'results');
  PERFORM pactwoven.native_memory_require(checked->'results'=prior.response->'results' AND checked->'dataValidUntil'=prior.response->'dataValidUntil','NM005');RETURN prior.response;
 END IF;
 PERFORM pactwoven.native_memory_require((SELECT count(*) FROM pactwoven.native_delegation_root_inputs WHERE(environment,organization_id,root_task_id,generation)=(e,t.organization_id,t.id,t.generation))<128,'NM007');
 checked:=pactwoven.native_delegation_root_validate_inputs(ctx,q->'results');
 body:=checked||jsonb_build_object('rootTaskId',t.id,'generation',t.generation,'choices',q->'results');
 IF pactwoven.native_instruction_active_refresh(e,t.organization_id,t.id) THEN body:=body||(SELECT jsonb_build_object('refreshEpoch',epoch,'lineageDigest',lineage_digest) FROM pactwoven.native_delegation_refresh_generations WHERE(environment,organization_id,root_task_id,generation)=(e,t.organization_id,t.id,t.generation));END IF;
 INSERT INTO pactwoven.native_delegation_root_inputs(environment,organization_id,root_task_id,generation,context_binding,body,digest,data_valid_until)
  VALUES(e,t.organization_id,t.id,t.generation,ctx-'validUntil',body,pactwoven.native_delegation_hash(body),pactwoven.native_memory_time(checked->'dataValidUntil')) RETURNING * INTO r;
 answer:=checked||jsonb_build_object('receipt',jsonb_build_object('receiptId',r.id,'digest',r.digest),'generation',t.generation);
 INSERT INTO pactwoven.native_delegation_root_commands VALUES(e,t.organization_id,t.id,q->>'requestKey','inputs',t.generation,t.identity,q,answer);
 PERFORM pactwoven.native_delegation_root_context(e,selector,true);RETURN answer;
END $function$;

CREATE OR REPLACE FUNCTION pactwoven.native_delegation_refresh_recovery_cost(e text,o text,r text) RETURNS integer LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT count(*)::integer FROM jsonb_array_elements(pactwoven.native_delegation_refresh_slots(e,o,r,pactwoven.native_delegation_refresh_epoch(e,o,r))) s
 JOIN pactwoven.native_delegation_tasks t ON(t.environment,t.organization_id,t.id)=(e,o,s->>'taskId') WHERE pactwoven.native_instruction_active_refresh(e,o,r) AND t.state NOT IN('settled','cancelled') $$;

CREATE OR REPLACE FUNCTION pactwoven.native_delegation_refresh_pending(e text,o text,r text) RETURNS integer LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT count(DISTINCT l.task_id)::integer FROM pactwoven.native_delegation_refresh_lineages l
 WHERE(l.environment,l.organization_id,l.root_task_id)=($1,$2,$3) AND l.kind='replacement' AND pactwoven.native_instruction_current(e,o,r,'epoch',l.epoch::text) AND (pactwoven.native_instruction_revision(e,o,r)=0 OR NOT EXISTS(SELECT 1 FROM pactwoven.native_delegation_refresh_dispositions d WHERE(d.environment,d.organization_id,d.root_task_id,d.task_id)=(e,o,r,l.task_id))) AND NOT EXISTS(
 SELECT 1 FROM pactwoven.native_delegation_tasks t WHERE(t.environment,t.organization_id,t.id)=(l.environment,l.organization_id,l.task_id)) $$;

CREATE OR REPLACE FUNCTION pactwoven.native_delegation_root_refresh_instruction_base(e text,selector jsonb,q jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE ctx jsonb;t pactwoven.native_delegation_tasks;r pactwoven.native_delegation_root_runs;g pactwoven.native_delegation_grants;
 cp pactwoven.native_delegation_root_checkpoints;first_cp pactwoven.native_delegation_root_checkpoints;child pactwoven.native_delegation_tasks;
 result pactwoven.native_delegation_results;art pactwoven.native_delegation_artifacts;ep bigint;new_ep bigint;first_state jsonb;latest_state jsonb;basis jsonb;
 original jsonb;slot jsonb;slots jsonb;new_slots jsonb:='[]';choices jsonb:='[]';choice jsonb;h jsonb;original_h jsonb;item jsonb;ref_value jsonb;checked jsonb;data_ctx jsonb;
 stale boolean;expired_n integer:=0;new_task text;new_handoff text;new_key text;body jsonb;digest text;prior jsonb;answer jsonb;usage jsonb;initial_digest text;data_until timestamptz;memory_checked jsonb;
BEGIN
 PERFORM pactwoven.native_instruction_refresh_require(q,'refresh');prior:=pactwoven.native_delegation_refresh_command_lookup(e,selector,q,'refresh');IF prior IS NOT NULL THEN RETURN prior;END IF;
 ctx:=pactwoven.native_delegation_root_context(e,selector,true);
 SELECT * INTO t FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(e,selector->>'organizationId',selector->>'taskId');
 SELECT * INTO r FROM pactwoven.native_delegation_root_runs WHERE(environment,organization_id,root_task_id)=(e,t.organization_id,t.id);
 SELECT * INTO g FROM pactwoven.native_delegation_grants WHERE(environment,organization_id,id)=(e,t.organization_id,t.grant_id);
 ep:=pactwoven.native_delegation_refresh_epoch(e,t.organization_id,t.id);new_ep:=ep+1;
 PERFORM pactwoven.native_memory_require(t.attempt<t.attempt_limit AND r.slice_count<256,'NM007');
 PERFORM pactwoven.native_memory_require(ep=(q->>'expectedRefreshEpoch')::bigint AND r.checkpoint_version=(q->>'expectedCheckpointVersion')::bigint
  AND NOT EXISTS(SELECT 1 FROM pactwoven.native_delegation_root_completions WHERE(environment,organization_id,root_task_id)=(e,t.organization_id,t.id)),'ND009');
 PERFORM pactwoven.native_memory_require(g.active_children=0 AND g.body->>'mode'='advise' AND g.body->>'externalEffects'='forbidden','ND001');
 SELECT * INTO cp FROM pactwoven.native_delegation_root_checkpoints WHERE(environment,organization_id,root_task_id,version)=(e,t.organization_id,t.id,r.checkpoint_version);
 BEGIN latest_state:=cp.planner_state::jsonb;EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION USING ERRCODE='NM009',MESSAGE='Original plan metadata unavailable';END;
 PERFORM pactwoven.native_delegation_refresh_require(latest_state,'coordinator_state');usage:=latest_state->'usage';
 IF NOT pactwoven.native_instruction_active_refresh(e,t.organization_id,t.id) THEN
  SELECT * INTO first_cp FROM pactwoven.native_delegation_root_checkpoints WHERE(environment,organization_id,root_task_id)=(e,t.organization_id,t.id) AND pactwoven.native_instruction_current(e,t.organization_id,t.id,'checkpoint',version::text) AND planner_state<>'' ORDER BY version LIMIT 1;
  PERFORM pactwoven.native_memory_require(first_cp.version IS NOT NULL AND first_cp.input_receipts='[]'::jsonb AND NOT EXISTS(SELECT 1 FROM pactwoven.native_delegation_root_inputs i
   WHERE(i.environment,i.organization_id,i.root_task_id)=(e,t.organization_id,t.id) AND pactwoven.native_instruction_current(e,t.organization_id,t.id,'input',i.id::text) AND i.recorded_at<=first_cp.recorded_at),'NM009');
  BEGIN first_state:=first_cp.planner_state::jsonb;EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION USING ERRCODE='NM009',MESSAGE='Initial plan unavailable';END;
  PERFORM pactwoven.native_delegation_refresh_require(first_state,'coordinator_state');
  basis:=jsonb_build_object('checkpointVersion',first_cp.version,'plannerState',first_cp.planner_state,'plannerDigest',pactwoven.native_delegation_hash(first_state));
 ELSE SELECT original_plan INTO basis FROM pactwoven.native_delegation_refresh_epochs WHERE(environment,organization_id,root_task_id,epoch)=(e,t.organization_id,t.id,ep);first_state:=(basis->>'plannerState')::jsonb;END IF;
 initial_digest:=pactwoven.native_instruction_input_digest(e,t.organization_id,t.id);
 PERFORM pactwoven.native_memory_require(first_state->>'inputDigest'=initial_digest AND latest_state->>'inputDigest'=initial_digest
  AND jsonb_array_length(first_state->'slots') BETWEEN 1 AND 6 AND jsonb_array_length(first_state->'slots')=jsonb_array_length(latest_state->'slots')
  AND NOT(first_state->>'bounded')::boolean AND NOT(latest_state->>'bounded')::boolean,'NM009');
 slots:='[]';
 FOR original IN SELECT value FROM jsonb_array_elements(first_state->'slots') LOOP
  IF NOT pactwoven.native_instruction_active_refresh(e,t.organization_id,t.id) THEN
   SELECT value INTO slot FROM jsonb_array_elements(latest_state->'slots') WHERE value#>>'{assignment,stepId}'=original#>>'{assignment,stepId}';
   PERFORM pactwoven.native_memory_require(slot IS NOT NULL AND slot->'assignment'=original->'assignment','NM009');
   slot:=slot||jsonb_build_object('logicalTaskId',original->>'taskId','originalTaskId',original->>'taskId','predecessorTaskId',NULL,'kind','retained');
  ELSE SELECT value INTO slot FROM jsonb_array_elements(pactwoven.native_delegation_refresh_slots(e,t.organization_id,t.id,ep)) WHERE value->>'logicalTaskId'=original->>'taskId';END IF;
  PERFORM pactwoven.native_memory_require(slot IS NOT NULL AND slot->'assignment'=original->'assignment','NM009');
  SELECT * INTO child FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(e,t.organization_id,slot->>'taskId');
  PERFORM pactwoven.native_memory_require(child.id IS NOT NULL AND child.root_task_id=t.id AND child.depth=1 AND child.state='settled' AND child.authority=t.authority
   AND child.handoff_id=slot->>'handoffId' AND EXISTS(SELECT 1 FROM pactwoven.native_delegation_root_assignments a WHERE(a.environment,a.organization_id,a.task_id)=(e,t.organization_id,child.id)
    AND a.assignment=original->'assignment' AND(a.handoff_id,a.generation,a.assignment_version)=(child.handoff_id,child.generation,child.assignment_version)),'NM009');
  SELECT * INTO result FROM pactwoven.native_delegation_results WHERE(environment,organization_id,handoff_id)=(e,t.organization_id,child.handoff_id);
  PERFORM pactwoven.native_memory_require(result.handoff_id IS NOT NULL AND result.publication#>>'{result,outcome}' IN('advice_ready','failed') AND result.digest=pactwoven.native_delegation_hash(result.publication)
   AND(result.generation,result.assignment_version)=(child.generation,child.assignment_version),'NM009');
  SELECT envelope.body INTO h FROM pactwoven.native_delegation_envelopes envelope WHERE(environment,organization_id,handoff_id,assignment_version,generation,kind)=(e,t.organization_id,child.handoff_id,child.assignment_version,child.generation,'handoff');
  PERFORM pactwoven.native_memory_require(h IS NOT NULL AND h->'inputArtifacts'='[]'::jsonb AND h->'recipient'=child.identity AND h->'authority'=child.authority,'NM009');
  SELECT envelope.body INTO original_h FROM pactwoven.native_delegation_root_assignments assigned JOIN pactwoven.native_delegation_envelopes envelope ON(envelope.environment,envelope.organization_id,envelope.handoff_id,envelope.assignment_version,envelope.generation,envelope.kind)=(assigned.environment,assigned.organization_id,assigned.handoff_id,assigned.assignment_version,assigned.generation,'handoff') WHERE(assigned.environment,assigned.organization_id,assigned.root_task_id,assigned.task_id)=(e,t.organization_id,t.id,original->>'taskId') AND assigned.assignment=original->'assignment' AND assigned.handoff_id=original->>'handoffId' AND assigned.request_key=original->>'requestKey';
  PERFORM pactwoven.native_memory_require(original_h IS NOT NULL AND h-ARRAY['handoffId','childTaskId','issuedAt','deadlineAt','correlationId','generation','assignmentVersion']=original_h-ARRAY['handoffId','childTaskId','issuedAt','deadlineAt','correlationId','generation','assignmentVersion'],'NM009');
  choice:=jsonb_build_object('handoffId',child.handoff_id,'publicationDigest',result.digest);IF result.publication#>>'{result,outcome}'='advice_ready' THEN choices:=choices||jsonb_build_array(choice);END IF;
  stale:=result.publication#>>'{result,outcome}'='advice_ready' AND pactwoven.native_memory_time(result.publication#>'{result,evidenceValidUntil}')<=clock_timestamp();
  PERFORM pactwoven.native_memory_require(result.publication#>>'{result,outcome}'='failed' OR jsonb_array_length(result.publication->'artifacts')>0,'NM009');
  FOR item IN SELECT value FROM jsonb_array_elements(result.publication->'artifacts') LOOP
   ref_value:=item->'reference';SELECT * INTO art FROM pactwoven.native_delegation_artifacts WHERE(environment,organization_id,id,revision)=(e,t.organization_id,ref_value->>'artifactId',(ref_value->>'revision')::bigint);
   PERFORM pactwoven.native_memory_require(art.id IS NOT NULL AND art.task_id=child.id AND art.site_id=child.site_id AND art.publication_digest=result.digest
    AND art.reference=ref_value AND art.body=item->'body' AND ref_value->>'digest'=pactwoven.native_delegation_hash(art.body),'NM009');stale:=stale OR art.valid_until<=clock_timestamp();
  END LOOP;
  -- Exact original selected revisions, semantic freshness and both service ACLs
  -- are re-evaluated without reviving an old task's expired authority clock.
  IF jsonb_array_length(original#>'{assignment,memoryReferences}')>0 THEN PERFORM pactwoven.native_memory_lock_scope(ctx,false);END IF;
  FOR ref_value IN SELECT value FROM jsonb_array_elements(original#>'{assignment,memoryReferences}') LOOP
   memory_checked:=pactwoven.native_memory_evaluate_locked(pactwoven.native_memory_data_context(ctx),ref_value,date_trunc('milliseconds',clock_timestamp()));
   data_until:=least(data_until,pactwoven.native_memory_time(memory_checked#>'{selection,validUntil}'));
   data_ctx:=jsonb_set(pactwoven.native_memory_data_context(ctx),'{reader}',jsonb_build_object('kind','agent','id',child.identity->>'serviceId'));
   memory_checked:=pactwoven.native_memory_evaluate_locked(data_ctx,ref_value,date_trunc('milliseconds',clock_timestamp()));
   data_until:=least(data_until,pactwoven.native_memory_time(memory_checked#>'{selection,validUntil}'));
  END LOOP;
  IF stale THEN
   PERFORM pactwoven.native_memory_require(child.capability IN('research_public_sources','draft_advice','read_scoped_memory'),'NM008');
   expired_n:=expired_n+1;new_task:=gen_random_uuid()::text;new_handoff:=gen_random_uuid()::text;new_key:=gen_random_uuid()::text;
   body:=jsonb_build_object('logicalTaskId',original->>'taskId','originalTaskId',original->>'taskId','predecessorTaskId',child.id,'taskId',new_task,'handoffId',new_handoff,'requestKey',new_key,'assignment',original->'assignment','kind','replacement');
  ELSE
   checked:=pactwoven.native_delegation_root_validate_inputs(ctx,jsonb_build_array(choice));
   data_until:=least(data_until,pactwoven.native_memory_time(checked->'dataValidUntil'),pactwoven.native_memory_time(result.publication#>'{result,evidenceValidUntil}'));
   body:=slot||jsonb_build_object('kind','retained','predecessorTaskId',child.id);
  END IF;
  slots:=slots||jsonb_build_array(jsonb_build_object('body',body,'handoff',h));
 END LOOP;
 SELECT jsonb_agg(value ORDER BY value->>'handoffId' COLLATE "C",value->>'publicationDigest' COLLATE "C") INTO choices FROM jsonb_array_elements(choices);
 PERFORM pactwoven.native_memory_require(choices=q->'results','ND009');
 PERFORM pactwoven.native_memory_require(expired_n>0,'NM008');
 PERFORM pactwoven.native_memory_require(g.children_created+pactwoven.native_delegation_refresh_pending(e,t.organization_id,t.id)+expired_n<=(g.body#>>'{scope,limits,maxChildren}')::integer,'NM007');
 -- Every live/successful task must belong to proven current slots; previous
 -- refresh predecessors are covered only through the immutable prior manifest.
 IF NOT pactwoven.native_instruction_active_refresh(e,t.organization_id,t.id) THEN PERFORM pactwoven.native_memory_require(NOT EXISTS(SELECT 1 FROM pactwoven.native_delegation_tasks x WHERE(x.environment,x.organization_id,x.root_task_id)=(e,t.organization_id,t.id) AND x.depth>0 AND pactwoven.native_instruction_current(e,t.organization_id,t.id,'task',x.id) AND x.state<>'cancelled'
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(latest_state->'slots') s WHERE s->>'taskId'=x.id)),'NM009');END IF;
 INSERT INTO pactwoven.native_delegation_refresh_epochs VALUES(e,t.organization_id,t.id,new_ep,ep,basis,usage,q->>'requestKey',clock_timestamp());
 FOR item IN SELECT value FROM jsonb_array_elements(slots) LOOP body:=item->'body';
  INSERT INTO pactwoven.native_delegation_refresh_lineages VALUES(e,t.organization_id,t.id,new_ep,body->>'logicalTaskId',1,body->>'taskId',body->>'handoffId',body->>'kind',body,item->'handoff',clock_timestamp());END LOOP;
 digest:=pactwoven.native_delegation_refresh_manifest(e,t.organization_id,t.id,new_ep);
 INSERT INTO pactwoven.native_delegation_root_checkpoints(environment,organization_id,root_task_id,version,generation,body,planner_state,input_receipts)
 VALUES(e,t.organization_id,t.id,r.checkpoint_version+1,t.generation+1,jsonb_build_object('stage','working','summary','Refreshing the original sources.','steps','[]'::jsonb),'','[]');
 UPDATE pactwoven.native_delegation_root_runs SET checkpoint_version=checkpoint_version+1,slice_count=slice_count+1,phase='yielded',reason='none',wait_for='{}',control_version=control_version+1,updated_at=clock_timestamp() WHERE(environment,organization_id,root_task_id)=(e,t.organization_id,t.id) RETURNING * INTO r;
 -- Recheck the old claim at the last pre-fence point, then atomically fence it.
 PERFORM pactwoven.native_delegation_task_locked(e,selector,true);
 UPDATE pactwoven.native_delegation_tasks SET generation=generation+1,attempt=attempt+1,lease_token=NULL,lease_until=NULL WHERE(environment,organization_id,id)=(e,t.organization_id,t.id) RETURNING * INTO t;
 UPDATE pactwoven.native_delegation_proofs SET verdict='unknown',valid_until=NULL,nonce=NULL,nonce_barrier=NULL,prepared_at=NULL,deadline_at=NULL,barrier=barrier+1 WHERE(environment,organization_id,task_id)=(e,t.organization_id,t.id);
 UPDATE pactwoven.native_delegation_outbox SET state='suppressed',token=NULL,lease_until=NULL WHERE(environment,organization_id,task_id)=(e,t.organization_id,t.id);
 PERFORM pactwoven.native_delegation_root_wake(e,t.organization_id,t.id,t.generation);

 answer:=jsonb_build_object('kind','refresh','requestKey',q->>'requestKey','intentDigest',pactwoven.native_delegation_hash(q),'rootTaskId',t.id,'previousGeneration',(selector->>'generation')::bigint,'generation',t.generation,
 'previousEpoch',ep,'refreshEpoch',new_ep,'attempt',t.attempt,'checkpointVersion',r.checkpoint_version,'lineageDigest',digest,'admittedTaskIds','[]'::jsonb,'pendingCount',expired_n,'continuation','yielded','domainCompletion',false);
 INSERT INTO pactwoven.native_delegation_refresh_commands VALUES(e,t.organization_id,t.id,q->>'requestKey','refresh',(selector->>'generation')::bigint,t.identity,q,pactwoven.native_delegation_hash(q),answer,clock_timestamp());
 -- Semantic freshness must survive every write, including durable command storage.
 PERFORM pactwoven.native_memory_require(data_until IS NULL OR data_until>clock_timestamp(),'NM008');
 PERFORM pactwoven.native_memory_require(pactwoven.native_memory_time(ctx->'validUntil')>clock_timestamp() AND t.deadline_at>clock_timestamp(),'ND001');
 RETURN answer;
END $$;

CREATE OR REPLACE FUNCTION pactwoven.native_delegation_root_refresh_dispatch_instruction_base(e text,selector jsonb,q jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE ctx jsonb;t pactwoven.native_delegation_tasks;r pactwoven.native_delegation_root_runs;g pactwoven.native_delegation_grants;c pactwoven.native_delegation_refresh_current;
 l pactwoven.native_delegation_refresh_lineages;prior jsonb;h jsonb;answer jsonb;issued timestamptz;deadline timestamptz;handed jsonb;pending integer;BEGIN
 PERFORM pactwoven.native_instruction_refresh_require(q,'dispatch');prior:=pactwoven.native_delegation_refresh_command_lookup(e,selector,q,'dispatch');IF prior IS NOT NULL THEN RETURN prior;END IF;
 ctx:=pactwoven.native_delegation_root_context(e,selector,true);
 SELECT * INTO t FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(e,selector->>'organizationId',selector->>'taskId');
 SELECT * INTO r FROM pactwoven.native_delegation_root_runs WHERE(environment,organization_id,root_task_id)=(e,t.organization_id,t.id);
 SELECT * INTO g FROM pactwoven.native_delegation_grants WHERE(environment,organization_id,id)=(e,t.organization_id,t.grant_id);
 SELECT * INTO c FROM pactwoven.native_delegation_refresh_current WHERE(environment,organization_id,root_task_id)=(e,t.organization_id,t.id);
 PERFORM pactwoven.native_memory_require(pactwoven.native_instruction_active_refresh(e,t.organization_id,t.id) AND c.epoch=(q->>'expectedRefreshEpoch')::bigint AND c.lineage_digest=q->>'lineageDigest' AND r.checkpoint_version=(q->>'expectedCheckpointVersion')::bigint,'ND009');
 SELECT * INTO l FROM pactwoven.native_delegation_refresh_lineages WHERE(environment,organization_id,root_task_id,epoch,logical_task_id)=(e,t.organization_id,t.id,c.epoch,q->>'logicalTaskId') ORDER BY revision DESC LIMIT 1;
 PERFORM pactwoven.native_memory_require(l.task_id IS NOT NULL AND l.kind='replacement' AND NOT EXISTS(SELECT 1 FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(e,t.organization_id,l.task_id))
  AND NOT EXISTS(SELECT 1 FROM pactwoven.native_delegation_refresh_dispositions WHERE(environment,organization_id,root_task_id,task_id)=(e,t.organization_id,t.id,l.task_id))
  AND g.active_children<(g.body#>>'{scope,limits,maxConcurrentChildren}')::integer AND g.children_created+pactwoven.native_delegation_refresh_pending(e,t.organization_id,t.id)<=(g.body#>>'{scope,limits,maxChildren}')::integer,'ND009');
 issued:=date_trunc('milliseconds',clock_timestamp());deadline:=least(issued+(l.original_handoff->>'taskTimeoutMs')::integer*interval '1 millisecond',t.deadline_at,pactwoven.supplier_time(g.body->'expiresAt'));
 PERFORM pactwoven.native_memory_require(deadline>issued,'ND001');
 h:=l.original_handoff||jsonb_build_object('handoffId',l.handoff_id,'childTaskId',l.task_id,'assignmentVersion',1,'generation',1,'issuedAt',pactwoven.mandate_instant(issued),'deadlineAt',pactwoven.mandate_instant(deadline),'correlationId',gen_random_uuid()::text);
 handed:=pactwoven.native_delegation_handoff_epoch0(e,selector,h);
 INSERT INTO pactwoven.native_delegation_root_assignments VALUES(e,t.organization_id,t.id,l.task_id,l.handoff_id,l.body->>'requestKey',1,1,jsonb_build_object('requestKey',l.body->>'requestKey','handoff',h,'assignment',l.body->'assignment'),l.body->'assignment',handed);
 PERFORM pactwoven.native_delegation_root_context(e,selector,true);
 SELECT count(*) INTO pending FROM jsonb_array_elements(pactwoven.native_delegation_refresh_slots(e,t.organization_id,t.id,c.epoch)) s WHERE NOT EXISTS(SELECT 1 FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(e,t.organization_id,s->>'taskId'));
 answer:=jsonb_build_object('kind','dispatch','requestKey',q->>'requestKey','intentDigest',pactwoven.native_delegation_hash(q),'rootTaskId',t.id,'previousGeneration',t.generation,'generation',t.generation,'previousEpoch',c.epoch,'refreshEpoch',c.epoch,'attempt',t.attempt,
 'checkpointVersion',r.checkpoint_version,'lineageDigest',c.lineage_digest,'admittedTaskIds',jsonb_build_array(l.task_id),'pendingCount',pending,'continuation','running','domainCompletion',false);
 INSERT INTO pactwoven.native_delegation_refresh_commands VALUES(e,t.organization_id,t.id,q->>'requestKey','dispatch',t.generation,t.identity,q,pactwoven.native_delegation_hash(q),answer,clock_timestamp());RETURN answer;
END $$;

CREATE OR REPLACE FUNCTION pactwoven.native_delegation_refresh_key(e text,selector jsonb,q jsonb,kind text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT 'c3_'||pactwoven.native_delegation_hash(jsonb_build_object('domain',CASE WHEN $4='refresh' THEN CASE WHEN $3->>'schemaVersion'='3' THEN 'pactwoven.native.refresh.v3' ELSE 'pactwoven.native.refresh.v2' END ELSE CASE WHEN $3->>'schemaVersion'='3' THEN 'pactwoven.native.refresh-dispatch.v3' ELSE 'pactwoven.native.refresh-dispatch.v2' END END,
 'environment',$1,'organizationId',$2->>'organizationId','rootTaskId',$2->>'taskId','generation',($2->>'generation')::bigint,'command',$3-'requestKey')) $$;

CREATE OR REPLACE FUNCTION pactwoven.native_delegation_refresh_legacy(e text,selector jsonb) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE t pactwoven.native_delegation_tasks;BEGIN
 SELECT * INTO t FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(e,selector->>'organizationId',selector->>'taskId');
 PERFORM pactwoven.native_memory_require(t.id IS NOT NULL AND pactwoven.native_instruction_revision(e,t.organization_id,t.root_task_id)=0 AND pactwoven.native_delegation_refresh_epoch(e,t.organization_id,t.root_task_id)=0,'ND001');END $$;

CREATE OR REPLACE FUNCTION pactwoven.native_delegation_root_work_v2(e text,selector jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN PERFORM pactwoven.native_instruction_legacy(e,selector);RETURN pactwoven.native_delegation_root_work_v2_instruction_base(e,selector);END $$;

CREATE OR REPLACE FUNCTION pactwoven.native_delegation_root_materials_v2(e text,selector jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN PERFORM pactwoven.native_instruction_legacy(e,selector);RETURN pactwoven.native_delegation_root_materials_v2_instruction_base(e,selector);END $$;

CREATE OR REPLACE FUNCTION pactwoven.native_delegation_result_commit_v2(e text,selector jsonb,q jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN PERFORM pactwoven.native_instruction_legacy(e,selector);RETURN pactwoven.native_delegation_result_commit_v2_instruction_base(e,selector,q);END $$;

CREATE OR REPLACE FUNCTION pactwoven.native_delegation_root_refresh(e text,selector jsonb,q jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN PERFORM pactwoven.native_instruction_legacy(e,selector);RETURN pactwoven.native_delegation_root_refresh_instruction_base(e,selector,q);END $$;

CREATE OR REPLACE FUNCTION pactwoven.native_delegation_root_refresh_dispatch(e text,selector jsonb,q jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN PERFORM pactwoven.native_instruction_legacy(e,selector);RETURN pactwoven.native_delegation_root_refresh_dispatch_instruction_base(e,selector,q);END $$;

CREATE OR REPLACE FUNCTION pactwoven.native_delegation_root_inputs_v2(e text,selector jsonb,q jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE ep bigint;receipt jsonb;BEGIN PERFORM pactwoven.native_instruction_legacy(e,selector);PERFORM pactwoven.native_delegation_refresh_require(q,'inputs');ep:=pactwoven.native_delegation_refresh_epoch(e,selector->>'organizationId',selector->>'taskId');PERFORM pactwoven.native_memory_require(ep=(q->>'expectedRefreshEpoch')::bigint,'ND009');receipt:=pactwoven.native_delegation_root_inputs_c3(e,selector,q->'command');RETURN jsonb_build_object('schemaVersion',2,'refreshEpoch',ep,'receipt',receipt);END $$;

CREATE OR REPLACE FUNCTION pactwoven.native_delegation_root_checkpoint_v2(e text,selector jsonb,q jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE ep bigint;receipt jsonb;BEGIN PERFORM pactwoven.native_instruction_legacy(e,selector);PERFORM pactwoven.native_delegation_refresh_require(q,'checkpoint');ep:=pactwoven.native_delegation_refresh_epoch(e,selector->>'organizationId',selector->>'taskId');PERFORM pactwoven.native_memory_require(ep=(q->>'expectedRefreshEpoch')::bigint,'ND009');receipt:=pactwoven.native_delegation_root_checkpoint_write_epoch0(e,selector,q->'command',false);RETURN jsonb_build_object('schemaVersion',2,'refreshEpoch',ep,'receipt',receipt);END $$;

CREATE OR REPLACE FUNCTION pactwoven.native_delegation_root_yield_v2(e text,selector jsonb,q jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE ep bigint;receipt jsonb;BEGIN PERFORM pactwoven.native_instruction_legacy(e,selector);PERFORM pactwoven.native_delegation_refresh_require(q,'yield');ep:=pactwoven.native_delegation_refresh_epoch(e,selector->>'organizationId',selector->>'taskId');PERFORM pactwoven.native_memory_require(ep=(q->>'expectedRefreshEpoch')::bigint,'ND009');receipt:=pactwoven.native_delegation_root_checkpoint_write_epoch0(e,selector,q->'command',true);RETURN jsonb_build_object('schemaVersion',2,'refreshEpoch',ep,'receipt',receipt);END $$;

CREATE OR REPLACE FUNCTION pactwoven.native_delegation_root_complete_v2(e text,selector jsonb,q jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE ep bigint;receipt jsonb;BEGIN PERFORM pactwoven.native_instruction_legacy(e,selector);PERFORM pactwoven.native_delegation_refresh_require(q,'complete');ep:=pactwoven.native_delegation_refresh_epoch(e,selector->>'organizationId',selector->>'taskId');PERFORM pactwoven.native_memory_require(ep=(q->>'expectedRefreshEpoch')::bigint,'ND009');receipt:=pactwoven.native_delegation_root_complete_c3(e,selector,q->'command'); IF ep>0 THEN INSERT INTO pactwoven.native_delegation_refresh_completions SELECT e,selector->>'organizationId',selector->>'taskId',ep,c.lineage_digest,(selector->>'generation')::bigint,receipt->>'publicationDigest' FROM pactwoven.native_delegation_refresh_current c WHERE(c.environment,c.organization_id,c.root_task_id)=(e,selector->>'organizationId',selector->>'taskId') ON CONFLICT DO NOTHING;END IF;RETURN jsonb_build_object('schemaVersion',2,'refreshEpoch',ep,'receipt',receipt);END $$;

CREATE OR REPLACE FUNCTION pactwoven.native_delegation_root_refresh_operation_instruction_base(e text,target jsonb,q jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE t pactwoven.native_delegation_tasks;p pactwoven.native_delegation_refresh_commands;s jsonb;BEGIN
 PERFORM pactwoven.native_delegation_refresh_require(q,'operation');PERFORM pactwoven.native_delegation_target(target,false);s:=pactwoven.native_delegation_service(e,ARRAY['coordinator']);
 SELECT * INTO t FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(e,target->>'organizationId',target->>'taskId');
 PERFORM pactwoven.native_memory_require(t.id IS NOT NULL AND t.depth=0 AND t.identity=s,'ND001');
 PERFORM 1 FROM pactwoven.native_delegation_grants WHERE(environment,organization_id,id)=(e,t.organization_id,t.grant_id) FOR UPDATE;
 SELECT * INTO p FROM pactwoven.native_delegation_refresh_commands WHERE(environment,organization_id,root_task_id,request_key)=(e,t.organization_id,t.id,q->>'requestKey');
 IF NOT FOUND THEN RETURN NULL;END IF;
 PERFORM pactwoven.native_memory_require(p.kind=q->>'kind' AND p.identity=s AND p.generation=(target->>'generation')::bigint AND p.intent_digest=q->>'intentDigest' AND p.intent_digest=pactwoven.native_delegation_hash(p.intent),'ND009');RETURN p.response;END $$;

CREATE OR REPLACE FUNCTION pactwoven.native_delegation_root_refresh_operation(e text,target jsonb,q jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN PERFORM pactwoven.native_instruction_legacy(e,target);RETURN pactwoven.native_delegation_root_refresh_operation_instruction_base(e,target,q);END $$;

CREATE OR REPLACE FUNCTION pactwoven.native_delegation_root_read(p_actor jsonb, p_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$ DECLARE r pactwoven.native_delegation_root_runs;t pactwoven.native_delegation_tasks;g pactwoven.native_delegation_grants;c pactwoven.native_delegation_root_checkpoints;
 input pactwoven.native_delegation_root_inputs;ctx jsonb;projection_ctx jsonb;checked jsonb;result_body jsonb;state text;reason text;unavailable boolean:=false;deadline timestamptz;projection_until timestamptz;BEGIN
 PERFORM pactwoven.native_delegation_actor_locked(p_actor,NULL,false);
 SELECT * INTO r FROM pactwoven.native_delegation_root_runs WHERE(environment,organization_id,root_task_id,actor_id)=(p_actor->>'environment',p_actor->>'organizationId',p_id,p_actor->>'actorId');
 PERFORM pactwoven.native_memory_require(FOUND,'ND001');ctx:=pactwoven.native_delegation_actor_locked(p_actor,r.site_id,false);
 SELECT * INTO g FROM pactwoven.native_delegation_grants WHERE(environment,organization_id,id)=(r.environment,r.organization_id,r.grant_id) FOR SHARE;
 SELECT * INTO t FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(r.environment,r.organization_id,p_id);
 SELECT * INTO r FROM pactwoven.native_delegation_root_runs WHERE(environment,organization_id,root_task_id)=(r.environment,r.organization_id,p_id);
 SELECT * INTO c FROM pactwoven.native_delegation_root_checkpoints WHERE(environment,organization_id,root_task_id,version)=(r.environment,r.organization_id,p_id,r.checkpoint_version);
 IF c.version IS NOT NULL AND NOT pactwoven.native_instruction_current(r.environment,r.organization_id,p_id,'checkpoint',c.version::text) THEN c.body:=NULL;c.version:=NULL;END IF;
 SELECT publication->'result' INTO result_body FROM pactwoven.native_delegation_root_completions WHERE(environment,organization_id,root_task_id)=(r.environment,r.organization_id,p_id);
 state:=r.phase;reason:=r.reason;
 IF state NOT IN('completed','cancelled') AND(g.body->'revocation'<>'null'::jsonb OR pactwoven.supplier_time(g.body->'expiresAt')<=clock_timestamp() OR t.authority<>pactwoven.native_delegation_reference(g)) THEN state:='blocked';reason:='authority';END IF;
 IF c.version IS NOT NULL OR result_body IS NOT NULL THEN
  BEGIN
   -- Stored plaintext may carry evidence from an earlier generation. Validate
   -- every consumed original publication, not only the latest receipt list.
   -- The original child context remains intact inside validate_inputs; only
   -- its separate root disclosure check uses the current human reader.
   IF result_body IS NOT NULL AND pactwoven.native_instruction_active_refresh(r.environment,r.organization_id,p_id) THEN PERFORM pactwoven.native_memory_require(EXISTS(SELECT 1 FROM pactwoven.native_delegation_refresh_completions binding JOIN pactwoven.native_delegation_root_completions done ON(done.environment,done.organization_id,done.root_task_id,done.generation,done.digest)=(binding.environment,binding.organization_id,binding.root_task_id,binding.generation,binding.publication_digest) WHERE(binding.environment,binding.organization_id,binding.root_task_id)=(r.environment,r.organization_id,p_id)),'NM009');END IF;
   projection_until:=least(pactwoven.native_memory_time(ctx->'validUntil'),clock_timestamp()+interval '1 minute');
   FOR input IN SELECT * FROM pactwoven.native_delegation_root_inputs WHERE(environment,organization_id,root_task_id)=(r.environment,r.organization_id,p_id) AND pactwoven.native_instruction_current(r.environment,r.organization_id,p_id,'input',id::text) AND(NOT pactwoven.native_instruction_active_refresh(r.environment,r.organization_id,p_id) OR generation=coalesce((SELECT done.generation FROM pactwoven.native_delegation_root_completions done WHERE(done.environment,done.organization_id,done.root_task_id)=(r.environment,r.organization_id,p_id)),c.generation)) ORDER BY generation,id LOOP
    PERFORM pactwoven.native_memory_require(pactwoven.native_memory_scope(input.context_binding)=pactwoven.native_memory_scope(ctx)
     AND input.context_binding#>>'{usage,taskId}'=p_id AND input.context_binding#>>'{usage,generation}'=input.generation::text
     AND input.digest=pactwoven.native_delegation_hash(input.body),'NM009');
    projection_ctx:=input.context_binding||jsonb_build_object('reader',ctx->'reader','purpose','human_review','validUntil',pactwoven.mandate_instant(projection_until));
    PERFORM pactwoven.native_delegation_refresh_input_binding(projection_ctx,input.body);
    checked:=pactwoven.native_delegation_root_validate_inputs(projection_ctx,input.body->'choices');
    PERFORM pactwoven.native_memory_require(checked->'results'=input.body->'results' AND checked->'dataValidUntil'=input.body->'dataValidUntil','NM005');
    deadline:=least(deadline,input.data_valid_until);
   END LOOP;
   deadline:=least(deadline,pactwoven.native_memory_time(result_body->'evidenceValidUntil'));
   PERFORM pactwoven.native_memory_require(projection_until>clock_timestamp() AND(deadline IS NULL OR deadline>clock_timestamp()),'NM008');
  EXCEPTION WHEN SQLSTATE 'NM001' OR SQLSTATE 'NM002' OR SQLSTATE 'NM004' OR SQLSTATE 'NM005' OR SQLSTATE 'NM006' OR SQLSTATE 'NM007' OR SQLSTATE 'NM008' OR SQLSTATE 'NM009' OR SQLSTATE 'ND001' THEN
   unavailable:=true;c.body:=NULL;result_body:=NULL;
  END;
 END IF;
 PERFORM pactwoven.native_memory_notes_deadline(ctx);
 RETURN jsonb_build_object('scope',pactwoven.native_memory_scope(ctx),'id',p_id,'title',r.title,'prompt',r.prompt,'controlVersion',r.control_version,'state',state,'reason',reason,
  'updatedAt',pactwoven.mandate_instant(r.updated_at),'expiresAt',g.body->'expiresAt','evidenceUnavailable',unavailable,
  'checkpointVersion',r.checkpoint_version,'checkpoint',c.body,'checkpointHistorical',coalesce(c.generation<>t.generation,false),'attempt',t.attempt,'attemptLimit',t.attempt_limit,'generation',t.generation,
  'coverage',pactwoven.native_delegation_root_coverage(r.environment,r.organization_id,p_id),
  'result',result_body,'domainCompletion',false);
END $function$;

CREATE FUNCTION pactwoven.native_instruction_actor(p_actor jsonb,p_root text,p_site text,writing boolean) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
 DECLARE r pactwoven.native_delegation_root_runs;ctx jsonb;BEGIN
 PERFORM pactwoven.native_delegation_actor_locked(p_actor,NULL,writing);
 SELECT * INTO r FROM pactwoven.native_delegation_root_runs WHERE(environment,organization_id,root_task_id,actor_id,site_id)=(p_actor->>'environment',p_actor->>'organizationId',p_root,p_actor->>'actorId',p_site);
 PERFORM pactwoven.native_memory_require(r.root_task_id IS NOT NULL AND r.managed,'ND001');
 ctx:=pactwoven.native_delegation_actor_locked(p_actor,p_site,writing);RETURN ctx;END $$;
CREATE FUNCTION pactwoven.native_instruction_unavailable(e text,o text,id text) RETURNS text LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
 DECLARE r pactwoven.native_delegation_root_runs;t pactwoven.native_delegation_tasks;g pactwoven.native_delegation_grants;BEGIN
 SELECT * INTO r FROM pactwoven.native_delegation_root_runs WHERE(environment,organization_id,root_task_id)=(e,o,$3);
 SELECT * INTO t FROM pactwoven.native_delegation_tasks subject WHERE(subject.environment,subject.organization_id,subject.id)=(e,o,$3);
 SELECT * INTO g FROM pactwoven.native_delegation_grants subject WHERE(subject.environment,subject.organization_id,subject.id)=(e,o,r.grant_id);
 IF r.phase='cancelled' OR t.state='cancelled' THEN RETURN 'cancelled';END IF;
 IF r.phase='completed' OR EXISTS(SELECT 1 FROM pactwoven.native_delegation_root_completions WHERE(environment,organization_id,root_task_id)=(e,o,$3)) THEN RETURN 'finished';END IF;
 IF g.id IS NULL OR g.body->'revocation' IS DISTINCT FROM 'null'::jsonb OR pactwoven.supplier_time(g.body->'expiresAt')<=clock_timestamp()
  OR t.deadline_at<=clock_timestamp() OR t.authority<>pactwoven.native_delegation_reference(g) THEN RETURN 'authority_unavailable';END IF;
 IF pactwoven.native_instruction_revision(e,o,$3)>=16 THEN RETURN 'instruction_limit';END IF;
 IF r.slice_count>=256 OR(r.restart_required AND t.attempt>=t.attempt_limit) OR g.children_created>=(g.body#>>'{scope,limits,maxChildren}')::integer THEN RETURN 'execution_limit';END IF;
 IF NOT r.manual_paused OR r.phase<>'paused' OR t.state<>'paused' THEN RETURN 'pause_required';END IF;
 RETURN NULL;END $$;
CREATE FUNCTION pactwoven.native_work_conversation_read(p_actor jsonb,p_root text,p_site text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE ctx jsonb;r pactwoven.native_delegation_root_runs;reason text;entries jsonb;BEGIN
 ctx:=pactwoven.native_instruction_actor(p_actor,p_root,p_site,false);
 SELECT * INTO r FROM pactwoven.native_delegation_root_runs WHERE(environment,organization_id,root_task_id)=(p_actor->>'environment',p_actor->>'organizationId',p_root);
 PERFORM 1 FROM pactwoven.native_delegation_grants WHERE(environment,organization_id,id)=(r.environment,r.organization_id,r.grant_id) FOR SHARE;
 SELECT * INTO r FROM pactwoven.native_delegation_root_runs WHERE(environment,organization_id,root_task_id)=(r.environment,r.organization_id,p_root) FOR SHARE;
 reason:=pactwoven.native_instruction_unavailable(r.environment,r.organization_id,p_root);
 SELECT coalesce(jsonb_agg(entry||jsonb_build_object('state',CASE WHEN EXISTS(SELECT 1 FROM pactwoven.native_instruction_applications a
 WHERE(a.environment,a.organization_id,a.root_task_id)=(r.environment,r.organization_id,p_root) AND a.revision>=(entry->>'sequence')::integer) THEN 'applied' ELSE 'recorded' END) ORDER BY (entry->>'sequence')::integer),'[]')
 INTO entries FROM jsonb_array_elements(pactwoven.native_instruction_entries(r.environment,r.organization_id,p_root)) entry;
 PERFORM pactwoven.native_memory_notes_deadline(ctx);
 RETURN jsonb_build_object('scope',pactwoven.native_memory_scope(ctx),'rootTaskId',p_root,'instructionVersion',pactwoven.native_instruction_revision(r.environment,r.organization_id,p_root),
 'controlVersion',r.control_version,'originalPrompt',r.prompt,'entries',entries,'canUpdate',reason IS NULL,'updateUnavailableReason',reason);END $$;
CREATE FUNCTION pactwoven.native_work_instruction_update(p_actor jsonb,p_root text,p_site text,p_key text,q jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE ctx jsonb;r pactwoven.native_delegation_root_runs;t pactwoven.native_delegation_tasks;prior pactwoven.native_instruction_updates;
 rev integer;at_time timestamptz;entry jsonb;response jsonb;metadata jsonb;reason text;usage jsonb;BEGIN
 PERFORM pactwoven.native_memory_require(jsonb_typeof(q)='object' AND q ?& ARRAY['expectedInstructionVersion','expectedControlVersion','text'] AND q-ARRAY['expectedInstructionVersion','expectedControlVersion','text']='{}'::jsonb
 AND jsonb_typeof(q->'expectedInstructionVersion')='number' AND q->>'expectedInstructionVersion' ~ '^(0|[1-9]|1[0-5])$'
 AND jsonb_typeof(q->'expectedControlVersion')='number' AND q->>'expectedControlVersion' ~ '^[1-9][0-9]{0,15}$' AND (q->>'expectedControlVersion')::numeric<=9007199254740991
 AND jsonb_typeof(q->'text')='string' AND pactwoven.native_instruction_valid_text(q->>'text')
 AND p_key ~ '^[A-Za-z0-9_-]{16,128}$','ND004');
 ctx:=pactwoven.native_instruction_actor(p_actor,p_root,p_site,true);
 SELECT * INTO r FROM pactwoven.native_delegation_root_runs WHERE(environment,organization_id,root_task_id)=(p_actor->>'environment',p_actor->>'organizationId',p_root);
 PERFORM pg_advisory_xact_lock(hashtextextended(pactwoven.native_delegation_canonical(jsonb_build_array('native-instructions',r.environment,r.organization_id,r.actor_id,p_key)),0));
 PERFORM 1 FROM pactwoven.native_delegation_grants WHERE(environment,organization_id,id)=(r.environment,r.organization_id,r.grant_id) FOR UPDATE;
 SELECT * INTO prior FROM pactwoven.native_instruction_updates WHERE(environment,organization_id,actor_id,request_key)=(r.environment,r.organization_id,r.actor_id,p_key);
 IF FOUND THEN PERFORM pactwoven.native_memory_require(prior.root_task_id=p_root AND prior.intent=q,'NI003');PERFORM pactwoven.native_memory_notes_deadline(ctx);RETURN prior.response;END IF;
 PERFORM pactwoven.native_delegation_grant_locked(r.environment,r.organization_id,r.grant_id);
 SELECT * INTO r FROM pactwoven.native_delegation_root_runs WHERE(environment,organization_id,root_task_id)=(r.environment,r.organization_id,p_root) FOR UPDATE;
 SELECT * INTO t FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(r.environment,r.organization_id,p_root) FOR UPDATE;
 rev:=pactwoven.native_instruction_revision(r.environment,r.organization_id,p_root);
 PERFORM pactwoven.native_memory_require(rev=(q->>'expectedInstructionVersion')::integer AND r.control_version=(q->>'expectedControlVersion')::bigint,'ND009');
 reason:=pactwoven.native_instruction_unavailable(r.environment,r.organization_id,p_root);
 PERFORM pactwoven.native_memory_require(reason IS NULL,CASE WHEN reason='authority_unavailable' THEN 'ND001' WHEN reason IN('execution_limit','instruction_limit') THEN 'NM007' ELSE 'ND009' END);
 usage:=pactwoven.native_instruction_usage(r.environment,r.organization_id,p_root);at_time:=date_trunc('milliseconds',clock_timestamp());
 entry:=jsonb_build_object('sequence',rev+1,'text',q->>'text','recordedAt',pactwoven.mandate_instant(at_time));
 metadata:=jsonb_build_object('instructionRevision',rev+1,'instructions',pactwoven.native_instruction_entries(r.environment,r.organization_id,p_root)||jsonb_build_array(entry));
 response:=jsonb_build_object('scope',pactwoven.native_memory_scope(ctx),'rootTaskId',p_root,'requestKey',p_key,'instructionVersion',rev+1,'controlVersion',r.control_version+1,
 'entry',entry||'{"state":"recorded"}'::jsonb,'committedAt',pactwoven.mandate_instant(at_time),'state','paused');
 INSERT INTO pactwoven.native_instruction_updates VALUES(r.environment,r.organization_id,p_root,rev+1,r.actor_id,p_key,q,response,pactwoven.native_delegation_hash(metadata),r.checkpoint_version,t.generation+1,usage,at_time);
 -- Cancel reserved old refresh work without deleting lineage or consuming new capacity.
 INSERT INTO pactwoven.native_delegation_refresh_dispositions(environment,organization_id,root_task_id,task_id,reason)
 SELECT r.environment,r.organization_id,p_root,l.task_id,'cancelled' FROM pactwoven.native_delegation_refresh_lineages l
 WHERE(l.environment,l.organization_id,l.root_task_id)=(r.environment,r.organization_id,p_root)
 AND NOT EXISTS(SELECT 1 FROM pactwoven.native_delegation_tasks child WHERE(child.environment,child.organization_id,child.id)=(l.environment,l.organization_id,l.task_id)) ON CONFLICT DO NOTHING;
 PERFORM pactwoven.native_delegation_root_fence_epoch0(r,'pause','paused');
 UPDATE pactwoven.native_delegation_root_runs SET control_version=control_version+1,wait_for='{}',updated_at=at_time WHERE(environment,organization_id,root_task_id)=(r.environment,r.organization_id,p_root);
 PERFORM pactwoven.native_instruction_actor(p_actor,p_root,p_site,true);PERFORM pactwoven.native_delegation_grant_locked(r.environment,r.organization_id,r.grant_id);
 PERFORM pactwoven.native_memory_require(t.deadline_at>clock_timestamp(),'ND001');PERFORM pactwoven.native_memory_notes_deadline(ctx);RETURN response;END $$;
CREATE FUNCTION pactwoven.native_work_instruction_recover(p_actor jsonb,p_root text,p_site text,p_key text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE ctx jsonb;response jsonb;BEGIN
 PERFORM pactwoven.native_memory_require(p_key ~ '^[A-Za-z0-9_-]{16,128}$','ND004');ctx:=pactwoven.native_instruction_actor(p_actor,p_root,p_site,false);
 SELECT u.response INTO response FROM pactwoven.native_instruction_updates u WHERE(u.environment,u.organization_id,u.root_task_id,u.actor_id,u.request_key)=(p_actor->>'environment',p_actor->>'organizationId',p_root,p_actor->>'actorId',p_key);
 PERFORM pactwoven.native_memory_notes_deadline(ctx);RETURN jsonb_build_object('scope',pactwoven.native_memory_scope(ctx),'rootTaskId',p_root,'requestKey',p_key,'operation',response);END $$;

CREATE FUNCTION pactwoven.native_delegation_root_work_v3(e text,selector jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE frame jsonb;metadata jsonb;children integer;deadline timestamptz;BEGIN
 frame:=pactwoven.native_delegation_root_work_v2_instruction_base(e,selector);metadata:=pactwoven.native_instruction_metadata(e,selector->>'organizationId',selector->>'taskId');
 SELECT g.children_created,t.deadline_at INTO children,deadline FROM pactwoven.native_delegation_tasks t JOIN pactwoven.native_delegation_grants g ON(g.environment,g.organization_id,g.id)=(t.environment,t.organization_id,t.grant_id)
 WHERE(t.environment,t.organization_id,t.id)=(e,selector->>'organizationId',selector->>'taskId');
 RETURN frame||metadata||jsonb_build_object('schemaVersion',3,'rootDeadlineAt',pactwoven.mandate_instant(deadline),'lifetimeChildCount',children,'usageFloor',pactwoven.native_instruction_usage_floor(e,selector->>'organizationId',selector->>'taskId'));END $$;
CREATE FUNCTION pactwoven.native_delegation_root_materials_v3(e text,selector jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE frame jsonb;t pactwoven.native_delegation_tasks;BEGIN
 frame:=pactwoven.native_delegation_root_materials_v2_instruction_base(e,selector);
 SELECT * INTO t FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(e,selector->>'organizationId',selector->>'taskId');
 PERFORM pactwoven.native_memory_require(pactwoven.native_instruction_current(e,t.organization_id,t.root_task_id,'task',t.id),'ND001');
 RETURN frame||pactwoven.native_instruction_metadata(e,t.organization_id,t.root_task_id)||'{"schemaVersion":3}'::jsonb;END $$;
CREATE FUNCTION pactwoven.native_instruction_command(e text,selector jsonb,q jsonb,kind text) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
 DECLARE rev integer;receipt jsonb;state jsonb;usage jsonb;task jsonb;root text:=selector->>'taskId';o text:=selector->>'organizationId';BEGIN
 PERFORM pactwoven.native_memory_require(q ?& ARRAY['schemaVersion','expectedInstructionRevision','expectedRefreshEpoch','command'] AND q-ARRAY['schemaVersion','expectedInstructionRevision','expectedRefreshEpoch','command']='{}'::jsonb,'ND004');
 rev:=pactwoven.native_instruction_fence(e,selector,q);
 IF kind IN('checkpoint','yield') THEN
  PERFORM pactwoven.native_delegation_root_require(q->'command',kind);
  -- Every new revision must have a real accepted plan before any instruction is
  -- marked applied. New generations cannot replay an obsolete plan digest.
  IF rev>0 THEN
   BEGIN state:=(q#>>'{command,plannerState}')::jsonb;EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION USING ERRCODE='ND004',MESSAGE='A current plan is required';END;
   PERFORM pactwoven.native_delegation_refresh_require(state,'coordinator_state');usage:=pactwoven.native_instruction_usage(e,o,root);
   PERFORM pactwoven.native_memory_require(state->>'inputDigest'=pactwoven.native_instruction_input_digest(e,o,root)
    AND(state#>>'{usage,inputTokens}')::bigint>=(usage->>'inputTokens')::bigint AND(state#>>'{usage,outputTokens}')::bigint>=(usage->>'outputTokens')::bigint
    AND(state#>>'{usage,inputTokens}')::bigint+(state#>>'{usage,outputTokens}')::bigint=(state#>>'{usage,totalTokens}')::bigint,'ND009');
   FOR task IN SELECT value FROM jsonb_array_elements(state->'slots') LOOP
    PERFORM pactwoven.native_memory_require(NOT EXISTS(SELECT 1 FROM pactwoven.native_delegation_tasks t WHERE(t.environment,t.organization_id,t.id)=(e,o,task->>'taskId')
     AND(t.root_task_id<>root OR NOT pactwoven.native_instruction_current(e,o,root,'task',t.id))),'ND009');END LOOP;
  END IF;
  receipt:=pactwoven.native_delegation_root_checkpoint_write_epoch0(e,selector,q->'command',kind='yield');
  IF rev>0 THEN INSERT INTO pactwoven.native_instruction_applications(environment,organization_id,root_task_id,revision,checkpoint_version)
   VALUES(e,o,root,rev,(receipt->>'checkpointVersion')::bigint) ON CONFLICT DO NOTHING;END IF;
 ELSIF kind='inputs' THEN receipt:=pactwoven.native_delegation_root_inputs_c3(e,selector,q->'command');
 ELSIF kind='handoff' THEN
  PERFORM pactwoven.native_memory_require(NOT EXISTS(SELECT 1 FROM pactwoven.native_delegation_root_assignments a WHERE(a.environment,a.organization_id,a.root_task_id,a.request_key)=(e,o,root,q#>>'{command,requestKey}') AND NOT pactwoven.native_instruction_current(e,o,root,'task',a.task_id)),'ND009');
  PERFORM pactwoven.native_memory_require(rev=0 OR EXISTS(SELECT 1 FROM pactwoven.native_instruction_applications WHERE(environment,organization_id,root_task_id,revision)=(e,o,root,rev)),'ND009');
  receipt:=pactwoven.native_delegation_root_handoff_epoch0(e,selector,q->'command');
 ELSIF kind='complete' THEN
  PERFORM pactwoven.native_memory_require(rev=0 OR EXISTS(SELECT 1 FROM pactwoven.native_instruction_applications WHERE(environment,organization_id,root_task_id,revision)=(e,o,root,rev)),'ND009');
  receipt:=pactwoven.native_delegation_root_complete_c3(e,selector,q->'command');
  IF pactwoven.native_instruction_active_refresh(e,o,root) THEN INSERT INTO pactwoven.native_delegation_refresh_completions
   SELECT e,o,root,c.epoch,c.lineage_digest,(selector->>'generation')::bigint,receipt->>'publicationDigest' FROM pactwoven.native_delegation_refresh_current c
   WHERE(c.environment,c.organization_id,c.root_task_id)=(e,o,root) ON CONFLICT DO NOTHING;END IF;
 ELSE RAISE EXCEPTION USING ERRCODE='ND004',MESSAGE='Unknown instruction operation';END IF;
 RETURN jsonb_build_object('schemaVersion',3,'instructionRevision',rev,'refreshEpoch',(q->>'expectedRefreshEpoch')::bigint,'receipt',receipt);END $$;

CREATE FUNCTION pactwoven.native_delegation_root_inputs_v3(e text,selector jsonb,q jsonb) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT pactwoven.native_instruction_command(e,selector,q,'inputs') $$;

CREATE FUNCTION pactwoven.native_delegation_root_checkpoint_v3(e text,selector jsonb,q jsonb) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT pactwoven.native_instruction_command(e,selector,q,'checkpoint') $$;

CREATE FUNCTION pactwoven.native_delegation_root_yield_v3(e text,selector jsonb,q jsonb) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT pactwoven.native_instruction_command(e,selector,q,'yield') $$;

CREATE FUNCTION pactwoven.native_delegation_root_complete_v3(e text,selector jsonb,q jsonb) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT pactwoven.native_instruction_command(e,selector,q,'complete') $$;

CREATE FUNCTION pactwoven.native_delegation_root_handoff_v3(e text,selector jsonb,q jsonb) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT pactwoven.native_instruction_command(e,selector,q,'handoff') $$;

CREATE FUNCTION pactwoven.native_delegation_root_refresh_v3(e text,selector jsonb,q jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE rev integer;receipt jsonb;BEGIN rev:=pactwoven.native_instruction_fence(e,selector,q);
 receipt:=pactwoven.native_delegation_root_refresh_instruction_base(e,selector,q);
 RETURN receipt||jsonb_build_object('schemaVersion',3,'instructionRevision',rev);END $$;
CREATE FUNCTION pactwoven.native_delegation_root_refresh_dispatch_v3(e text,selector jsonb,q jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE rev integer;receipt jsonb;BEGIN rev:=pactwoven.native_instruction_fence(e,selector,q);
 receipt:=pactwoven.native_delegation_root_refresh_dispatch_instruction_base(e,selector,q);
 RETURN receipt||jsonb_build_object('schemaVersion',3,'instructionRevision',rev);END $$;
CREATE FUNCTION pactwoven.native_delegation_root_refresh_operation_v3(e text,target jsonb,q jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE rev integer;receipt jsonb;t pactwoven.native_delegation_tasks;BEGIN
 PERFORM pactwoven.native_memory_require(jsonb_typeof(q->'instructionRevision')='number' AND q->>'instructionRevision' ~ '^(0|[1-9]|1[0-6])$','ND004');
 PERFORM pactwoven.native_delegation_refresh_require(q-'instructionRevision','operation');
 SELECT * INTO t FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(e,target->>'organizationId',target->>'taskId');
 PERFORM 1 FROM pactwoven.native_delegation_grants WHERE(environment,organization_id,id)=(e,t.organization_id,t.grant_id) FOR UPDATE;
 rev:=pactwoven.native_instruction_revision(e,t.organization_id,t.root_task_id);
 PERFORM pactwoven.native_memory_require(rev=(q->>'instructionRevision')::integer,'ND009');
 receipt:=pactwoven.native_delegation_root_refresh_operation_instruction_base(e,target,q-'instructionRevision');
 IF receipt IS NULL THEN RETURN NULL;END IF;
 PERFORM pactwoven.native_memory_require(pactwoven.native_instruction_current(e,t.organization_id,t.root_task_id,'refresh_command',q->>'requestKey'),'ND009');
 RETURN receipt||jsonb_build_object('schemaVersion',3,'instructionRevision',rev);END $$;
CREATE FUNCTION pactwoven.native_delegation_result_commit_v3(e text,selector jsonb,q jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE rev integer;receipt jsonb;BEGIN rev:=pactwoven.native_instruction_fence(e,selector,q,true);
 receipt:=pactwoven.native_delegation_result_commit_v2_instruction_base(e,selector,q);
 RETURN receipt||jsonb_build_object('schemaVersion',3,'instructionRevision',rev);END $$;

DO $$ DECLARE relation record;routine record;BEGIN
 FOR relation IN SELECT c.oid::regclass name FROM pg_class c WHERE c.relnamespace='pactwoven'::regnamespace AND c.relkind='r' AND c.relname LIKE 'native_instruction_%' LOOP
 EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY',relation.name);EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY',relation.name);
 EXECUTE format('REVOKE ALL ON TABLE %s FROM PUBLIC,pactwoven_runtime,pactwoven_native_task_api,pactwoven_native_task_worker,pactwoven_native_task_dispatcher,pactwoven_native_delegation_api,pactwoven_native_delegation_coordinator,pactwoven_native_delegation_worker,pactwoven_native_delegation_dispatcher',relation.name);
 EXECUTE format('CREATE POLICY native_instruction_owner ON %s TO %I USING(true) WITH CHECK(true)',relation.name,current_user);
 EXECUTE format('CREATE TRIGGER native_instruction_immutable BEFORE UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION pactwoven.financial_immutable()',relation.name);
 EXECUTE format('CREATE TRIGGER native_instruction_retain_table BEFORE TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION pactwoven.financial_immutable()',relation.name);
 END LOOP;
 FOR routine IN SELECT p.oid::regprocedure signature FROM pg_proc p WHERE p.pronamespace='pactwoven'::regnamespace AND
 (p.proname LIKE 'native_instruction_%' OR p.proname LIKE 'native_work_instruction_%' OR p.proname='native_work_conversation_read' OR p.proname LIKE '%_instruction_base' OR p.proname LIKE 'native_delegation_%_v3') LOOP
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,pactwoven_runtime,pactwoven_native_task_api,pactwoven_native_task_worker,pactwoven_native_task_dispatcher,pactwoven_native_delegation_api,pactwoven_native_delegation_coordinator,pactwoven_native_delegation_worker,pactwoven_native_delegation_dispatcher',routine.signature);END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION pactwoven.native_work_conversation_read(jsonb,text,text),pactwoven.native_work_instruction_update(jsonb,text,text,text,jsonb),pactwoven.native_work_instruction_recover(jsonb,text,text,text) TO pactwoven_native_delegation_api;
GRANT EXECUTE ON FUNCTION pactwoven.native_delegation_root_work_v3(text,jsonb),pactwoven.native_delegation_root_inputs_v3(text,jsonb,jsonb),pactwoven.native_delegation_root_checkpoint_v3(text,jsonb,jsonb),pactwoven.native_delegation_root_yield_v3(text,jsonb,jsonb),pactwoven.native_delegation_root_complete_v3(text,jsonb,jsonb),pactwoven.native_delegation_root_handoff_v3(text,jsonb,jsonb),pactwoven.native_delegation_root_refresh_v3(text,jsonb,jsonb),pactwoven.native_delegation_root_refresh_dispatch_v3(text,jsonb,jsonb),pactwoven.native_delegation_root_refresh_operation_v3(text,jsonb,jsonb) TO pactwoven_native_delegation_coordinator;
GRANT EXECUTE ON FUNCTION pactwoven.native_delegation_root_materials_v3(text,jsonb),pactwoven.native_delegation_result_commit_v3(text,jsonb,jsonb) TO pactwoven_native_delegation_coordinator,pactwoven_native_delegation_worker;

COMMIT;
