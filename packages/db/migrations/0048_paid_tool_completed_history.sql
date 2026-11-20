BEGIN;
-- Historical human disclosure only. Execution/source freshness and all existing
-- current-result readers are unchanged. No backfill or callable capture API.
CREATE TABLE pactwoven.paid_tool_completed_history_records(
 organization_id text NOT NULL,root_task_id text NOT NULL,site_id text NOT NULL,actor_id text NOT NULL,
 operation_id text NOT NULL REFERENCES pactwoven.paid_tool_operations,quote_id text NOT NULL REFERENCES pactwoven.paid_tool_quotes,
 instruction_revision integer NOT NULL,generation bigint NOT NULL,completion_digest text NOT NULL,
 dependency_digest text NOT NULL,paid_digest text NOT NULL,body jsonb NOT NULL,body_hash text NOT NULL,recorded_at timestamptz NOT NULL,
 PRIMARY KEY(organization_id,root_task_id),UNIQUE(operation_id),CHECK(body_hash=pactwoven.native_delegation_hash(body)));

-- Empty/known dependencies are required positively. The full lineage includes
-- replaced/abandoned children so an earlier private input cannot be laundered.
CREATE FUNCTION pactwoven.paid_tool_history_dependencies(o text,root text,completed_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE t pactwoven.native_delegation_tasks;a pactwoven.native_delegation_artifacts;assignment pactwoven.native_delegation_root_assignments;
 envelope pactwoven.native_delegation_envelopes;pub pactwoven.native_delegation_results;ev jsonb;manifest jsonb:='[]';sources jsonb:='[]';notes pactwoven.native_delegation_root_note_selections;BEGIN
 SELECT * INTO notes FROM pactwoven.native_delegation_root_note_selections WHERE(environment,organization_id,root_task_id)=('development',o,root);
 IF notes.root_task_id IS NULL OR notes.memory_references IS DISTINCT FROM '[]'::jsonb OR notes.intent->'selections' IS DISTINCT FROM '[]'::jsonb THEN RETURN NULL;END IF;
 IF EXISTS(SELECT 1 FROM pactwoven.native_communication_waits WHERE(environment,organization_id,root_id)=('development',o,root)) THEN RETURN NULL;END IF;
 IF EXISTS(SELECT 1 FROM pactwoven.native_memory_usages u JOIN pactwoven.native_delegation_tasks task ON(task.environment,task.organization_id,task.id)=(u.environment,u.organization_id,u.context#>>'{usage,taskId}') WHERE(task.environment,task.organization_id,task.root_task_id)=('development',o,root)) THEN RETURN NULL;END IF;
 manifest:=manifest||jsonb_build_array(jsonb_build_object('notes',to_jsonb(notes)));
 FOR t IN SELECT * FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,root_task_id)=('development',o,root) ORDER BY id LOOP
  IF t.capability NOT IN('draft_advice','research_public_sources') OR t.depth NOT IN(0,1) THEN RETURN NULL;END IF;
  manifest:=manifest||jsonb_build_array(jsonb_build_object('task',jsonb_build_object('id',t.id,'site',t.site_id,'parent',t.parent_task_id,'handoff',t.handoff_id,'generation',t.generation,'assignmentVersion',t.assignment_version,'capability',t.capability,'deadline',t.deadline_at,'authority',t.authority)));
  IF t.depth=0 THEN IF EXISTS(SELECT 1 FROM pactwoven.native_delegation_artifacts WHERE(environment,organization_id,task_id)=('development',o,t.id)) THEN RETURN NULL;END IF;CONTINUE;END IF;
  SELECT * INTO assignment FROM pactwoven.native_delegation_root_assignments WHERE(environment,organization_id,task_id)=('development',o,t.id);
  IF assignment.task_id IS NULL OR assignment.assignment IS DISTINCT FROM assignment.intent->'assignment' OR assignment.assignment->'memoryReferences' IS DISTINCT FROM '[]'::jsonb OR assignment.assignment->>'schemaVersion' IS DISTINCT FROM '1' OR coalesce(assignment.assignment->>'role','') NOT IN('research','planning','escalation') THEN RETURN NULL;END IF;
  PERFORM pactwoven.paid_tool_keys(assignment.assignment,ARRAY['schemaVersion','stepId','title','brief','role','memoryReferences']);
  SELECT * INTO envelope FROM pactwoven.native_delegation_envelopes WHERE(environment,organization_id,handoff_id,assignment_version,generation)=('development',o,t.handoff_id,t.assignment_version,t.generation) AND kind='handoff';
  IF envelope.handoff_id IS NULL OR envelope.body IS DISTINCT FROM assignment.intent->'handoff' OR envelope.body->'inputArtifacts' IS DISTINCT FROM '[]'::jsonb OR envelope.body->>'outputContract' IS DISTINCT FROM 'advisory_artifacts_v1' OR envelope.body->>'childTaskId' IS DISTINCT FROM t.id OR envelope.body->>'rootTaskId' IS DISTINCT FROM root OR envelope.body->>'capability' IS DISTINCT FROM t.capability OR envelope.digest<>pactwoven.native_delegation_hash(envelope.body) THEN RETURN NULL;END IF;
  manifest:=manifest||jsonb_build_array(jsonb_build_object('assignment',to_jsonb(assignment),'envelope',to_jsonb(envelope)));
  SELECT * INTO pub FROM pactwoven.native_delegation_results WHERE(environment,organization_id,handoff_id)=('development',o,t.handoff_id);
  IF pub.handoff_id IS NOT NULL THEN
   PERFORM pactwoven.paid_tool_keys(pub.publication,ARRAY['result','artifacts','inputArtifacts','memoryUsage']);
   IF jsonb_typeof(pub.publication->'artifacts') IS DISTINCT FROM 'array' OR jsonb_array_length(pub.publication->'artifacts')<>(SELECT count(*) FROM pactwoven.native_delegation_artifacts WHERE(environment,organization_id,task_id)=('development',o,t.id)) THEN RETURN NULL;END IF;
   IF pub.publication->'memoryUsage' IS DISTINCT FROM '[]'::jsonb OR pub.publication->'inputArtifacts' IS DISTINCT FROM '[]'::jsonb OR pub.digest<>pactwoven.native_delegation_hash(pub.publication) THEN RETURN NULL;END IF;
   manifest:=manifest||jsonb_build_array(jsonb_build_object('publication',to_jsonb(pub)));
  END IF;
  FOR a IN SELECT * FROM pactwoven.native_delegation_artifacts WHERE(environment,organization_id,task_id)=('development',o,t.id) ORDER BY id,revision LOOP
   IF pub.handoff_id IS NULL OR a.memory_derived OR a.publication_digest<>pub.digest OR a.reference->>'digest' IS DISTINCT FROM pactwoven.native_delegation_hash(a.body)
    OR NOT pub.publication->'artifacts' @> jsonb_build_array(jsonb_build_object('reference',a.reference,'body',a.body))
    OR a.body->>'schemaVersion' IS DISTINCT FROM '1' OR a.body->>'kind' IS DISTINCT FROM 'delegated_advice_v1' OR a.body->'advisoryOnly' IS DISTINCT FROM 'true'::jsonb OR a.body->'domainCompletion' IS DISTINCT FROM 'false'::jsonb
    OR a.body->>'role' IS DISTINCT FROM assignment.assignment->>'role' OR jsonb_typeof(a.body->'stepId') IS DISTINCT FROM 'string' OR a.body->>'stepId' IS DISTINCT FROM assignment.assignment->>'stepId'
    OR coalesce(a.body->>'deployment','') NOT IN('gpt-6.1-sol','gpt-6.1-terra','gpt-6-astra') OR jsonb_typeof(a.body->'evidence') IS DISTINCT FROM 'array' THEN RETURN NULL;END IF;
   PERFORM pactwoven.paid_tool_keys(a.body,ARRAY['schemaVersion','kind','advisoryOnly','domainCompletion','stepId','role','advice','evidence','deployment','usage']);
   FOR ev IN SELECT value FROM jsonb_array_elements(a.body->'evidence') LOOP
    PERFORM pactwoven.paid_tool_keys(ev,ARRAY['id','title','text','kind','url','observedAt','validUntil']);
    IF ev->>'kind' IS DISTINCT FROM 'public_source' OR coalesce(ev->>'url','') !~ '^https?://[^/@[:space:]]+([/?#]|$)' OR ev->>'url' ~ '[[:cntrl:]]' OR jsonb_typeof(ev->'observedAt') IS DISTINCT FROM 'string' OR jsonb_typeof(ev->'validUntil') IS DISTINCT FROM 'string' OR pactwoven.supplier_time(ev->'observedAt') IS NULL OR pactwoven.supplier_time(ev->'validUntil') IS NULL OR pactwoven.supplier_time(ev->'observedAt')>completed_at OR pactwoven.supplier_time(ev->'validUntil')<=pactwoven.supplier_time(ev->'observedAt') THEN RETURN NULL;END IF;
    sources:=sources||jsonb_build_array(jsonb_build_object('url',ev->'url','observedAt',ev->'observedAt','validUntil',ev->'validUntil'));
   END LOOP;
   manifest:=manifest||jsonb_build_array(jsonb_build_object('artifact',to_jsonb(a)));
  END LOOP;
 END LOOP;
 SELECT coalesce(jsonb_agg(v ORDER BY v::text),'[]') INTO sources FROM(SELECT DISTINCT value v FROM jsonb_array_elements(sources))s;
 IF jsonb_array_length(sources)>128 OR octet_length(manifest::text)>2097152 THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('digest',pactwoven.native_delegation_hash(manifest),'sources',sources);
EXCEPTION WHEN SQLSTATE 'PT004' OR SQLSTATE 'SP001' OR invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow THEN RETURN NULL;
END $$;

CREATE FUNCTION pactwoven.paid_tool_history_body(done pactwoven.native_delegation_root_completions,r pactwoven.native_delegation_root_runs,op pactwoven.paid_tool_operations,q pactwoven.paid_tool_quotes,deps jsonb,revision integer) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE result jsonb;items jsonb;body jsonb;BEGIN
 result:=op.delivery->'resultBody';
 SELECT coalesce(jsonb_agg(offer.value ORDER BY selected.position),'[]') INTO items FROM jsonb_array_elements_text(result->'selectedOfferIds') WITH ORDINALITY selected(id,position) JOIN jsonb_array_elements(q.resource_body->'offers') offer ON offer.value->>'id'=selected.id;
 PERFORM pactwoven.paid_tool_require(jsonb_array_length(items)=jsonb_array_length(result->'selectedOfferIds'));
 body:=jsonb_build_object('kind','recorded','scope',jsonb_build_object('environment','development','organizationId',r.organization_id,'siteId',r.site_id),'rootTaskId',r.root_task_id,'operationId',op.id,'instructionRevision',revision,
  'completedAt',pactwoven.mandate_instant(done.recorded_at),'evidenceValidUntil',done.publication#>'{result,evidenceValidUntil}','freshness','historical','authority','none','sourcePolicy','public_or_operator_only_v1',
  'advice',(done.publication->'result')-'outcome'-'evidenceValidUntil',
  'equipment',jsonb_build_object('status',result->'status','currency','USD','provenance','controlled_demo_catalogue','catalogueHash',result->'catalogueHash','requestHash',result->'requestHash','budgetMinor',q.request_body->'budgetMinor','totalMinor',result->'totalMinor','items',items),
  'payment',jsonb_build_object('signature',op.payment->'signature','amountBaseUnits',op.payment->'amountBaseUnits','feeLamports',op.payment->'feeLamports','finalizedAt',op.payment->'observedAt','slot',op.payment->'slot'),
  'provenance',jsonb_build_object('completionDigest',done.digest,'requestHash',op.delivery->'requestHash','resourceHash',op.delivery->'resourceHash','resultHash',op.delivery->'resultHash','catalogue','controlled_demo_catalogue','sources',deps->'sources'));
 PERFORM pactwoven.paid_tool_require(octet_length(body::text)<=300000);
 RETURN body;END $$;

CREATE FUNCTION pactwoven.paid_tool_history_capture() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r pactwoven.native_delegation_root_runs;a pactwoven.paid_tool_root_attachments;p pactwoven.paid_tool_root_purchases;
 op pactwoven.paid_tool_operations;q pactwoven.paid_tool_quotes;deps jsonb;body jsonb;items jsonb;result jsonb;revision integer;BEGIN
 IF NEW.environment<>'development' OR NEW.publication#>>'{result,outcome}' IS DISTINCT FROM 'advice_ready' THEN RETURN NEW;END IF;
 SELECT * INTO r FROM pactwoven.native_delegation_root_runs WHERE(environment,organization_id,root_task_id)=(NEW.environment,NEW.organization_id,NEW.root_task_id);
 revision:=pactwoven.native_instruction_revision(NEW.environment,NEW.organization_id,NEW.root_task_id);
 SELECT * INTO a FROM pactwoven.paid_tool_root_attachments WHERE(organization_id,root_task_id,instruction_revision)=(NEW.organization_id,NEW.root_task_id,revision);
 IF a.quote_id IS NULL THEN RETURN NEW;END IF;
 deps:=pactwoven.paid_tool_history_dependencies(NEW.organization_id,NEW.root_task_id,NEW.recorded_at);IF deps IS NULL THEN RETURN NEW;END IF;
 SELECT * INTO p FROM pactwoven.paid_tool_root_purchases WHERE(organization_id,root_task_id,generation,quote_id)=(NEW.organization_id,NEW.root_task_id,NEW.generation,a.quote_id);
 SELECT * INTO op FROM pactwoven.paid_tool_operations WHERE quote_id=a.quote_id FOR SHARE;SELECT * INTO q FROM pactwoven.paid_tool_quotes WHERE id=a.quote_id;
 PERFORM pactwoven.paid_tool_require(p.root_task_id IS NOT NULL AND op.status='completed' AND op.revoked_at IS NULL AND op.payment IS NOT NULL AND op.delivery IS NOT NULL
  AND (q.organization_id,q.root_task_id,q.site_id,q.instruction_revision)=(NEW.organization_id,NEW.root_task_id,r.site_id,revision)
  AND op.delivery->>'paymentSignature'=op.payment->>'signature' AND op.delivery->>'requestHash'=q.body#>>'{request,hash}' AND op.delivery->>'resourceHash'=q.body#>>'{resource,hash}'
  AND op.delivery->>'resultHash'=pactwoven.native_delegation_hash(jsonb_build_object('namespace','pactwoven.paid-tools.delivery.v1','result',op.delivery->'resultBody'))
  AND p.response->>'operationId'=op.id AND p.response->>'paymentSignature'=op.payment->>'signature' AND p.response->>'resultHash'=op.delivery->>'resultHash'
  AND EXISTS(SELECT 1 FROM pactwoven.paid_tool_redemptions d WHERE(d.operation_id,d.signature,d.result_hash,d.artifact_ref,d.result_body)=(op.id,op.payment->>'signature',op.delivery->>'resultHash',op.delivery->>'artifactRef',op.delivery->'resultBody'))
  AND q.resource_body->>'provenance'='controlled_demo_catalogue' AND q.resource_body->>'currency'='USD' AND q.provider_id='equipment_optimizer_v1'
  AND NEW.digest=pactwoven.native_delegation_hash(NEW.publication) AND pactwoven.supplier_time(NEW.publication#>'{result,evidenceValidUntil}')>NEW.recorded_at);
 body:=pactwoven.paid_tool_history_body(NEW,r,op,q,deps,revision);
 INSERT INTO pactwoven.paid_tool_completed_history_records VALUES(r.organization_id,r.root_task_id,r.site_id,r.actor_id,op.id,q.id,revision,NEW.generation,NEW.digest,deps->>'digest',pactwoven.native_delegation_hash(jsonb_build_object('attachment',to_jsonb(a),'purchase',to_jsonb(p),'operation',to_jsonb(op),'quote',to_jsonb(q),'redemption',(SELECT to_jsonb(d) FROM pactwoven.paid_tool_redemptions d WHERE d.operation_id=op.id))),body,pactwoven.native_delegation_hash(body),NEW.recorded_at);
 RETURN NEW;END $$;
CREATE TRIGGER paid_tool_completed_history_capture AFTER INSERT ON pactwoven.native_delegation_root_completions FOR EACH ROW EXECUTE FUNCTION pactwoven.paid_tool_history_capture();

CREATE FUNCTION pactwoven.paid_tool_completed_history(actor jsonb,root text,site text,operation text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE ctx jsonb;r pactwoven.native_delegation_root_runs;h pactwoven.paid_tool_completed_history_records;done pactwoven.native_delegation_root_completions;op pactwoven.paid_tool_operations;q pactwoven.paid_tool_quotes;a pactwoven.paid_tool_root_attachments;p pactwoven.paid_tool_root_purchases;deps jsonb;answer jsonb;BEGIN
 PERFORM pactwoven.paid_tool_principal(ARRAY['api']);PERFORM pactwoven.paid_tool_require(actor->>'environment'='development');ctx:=pactwoven.native_instruction_actor(actor,root,site,false);
 SELECT * INTO r FROM pactwoven.native_delegation_root_runs WHERE(environment,organization_id,root_task_id)=('development',actor->>'organizationId',root);
 answer:=jsonb_build_object('kind','unavailable','scope',pactwoven.native_memory_scope(ctx),'rootTaskId',root,'operationId',operation,'reason','not_retained');
 SELECT * INTO h FROM pactwoven.paid_tool_completed_history_records WHERE(organization_id,root_task_id,site_id,actor_id,operation_id)=(r.organization_id,root,site,actor->>'actorId',operation);
 IF h.root_task_id IS NULL THEN PERFORM pactwoven.native_memory_notes_deadline(ctx);RETURN answer;END IF;
 SELECT * INTO done FROM pactwoven.native_delegation_root_completions WHERE(environment,organization_id,root_task_id)=('development',r.organization_id,root);
 SELECT * INTO op FROM pactwoven.paid_tool_operations WHERE(id,quote_id)=(operation,h.quote_id);
 SELECT * INTO p FROM pactwoven.paid_tool_root_purchases WHERE(organization_id,root_task_id,generation,quote_id)=(r.organization_id,root,h.generation,h.quote_id);
 SELECT * INTO q FROM pactwoven.paid_tool_quotes WHERE id=h.quote_id;
 SELECT * INTO a FROM pactwoven.paid_tool_root_attachments WHERE(organization_id,root_task_id,instruction_revision,quote_id)=(r.organization_id,root,h.instruction_revision,h.quote_id);
 deps:=pactwoven.paid_tool_history_dependencies(r.organization_id,root,h.recorded_at);
 IF deps IS NULL OR deps->>'digest'<>h.dependency_digest THEN PERFORM pactwoven.native_memory_notes_deadline(ctx);RETURN answer;END IF;
 PERFORM pactwoven.paid_tool_require(r.phase='completed' AND done.digest=h.completion_digest AND done.digest=pactwoven.native_delegation_hash(done.publication) AND done.generation=h.generation AND done.recorded_at=h.recorded_at
  AND h.instruction_revision=pactwoven.native_instruction_revision('development',r.organization_id,root) AND h.body_hash=pactwoven.native_delegation_hash(h.body)
  AND(h.body->>'rootTaskId',h.body->>'operationId',h.body#>>'{scope,organizationId}',h.body#>>'{scope,siteId}',h.body#>>'{provenance,completionDigest}')=(root,operation,r.organization_id,site,done.digest)
  AND h.paid_digest=pactwoven.native_delegation_hash(jsonb_build_object('attachment',to_jsonb(a),'purchase',to_jsonb(p),'operation',to_jsonb(op),'quote',to_jsonb(q),'redemption',(SELECT to_jsonb(d) FROM pactwoven.paid_tool_redemptions d WHERE d.operation_id=op.id)))
  AND h.body=pactwoven.paid_tool_history_body(done,r,op,q,deps,h.instruction_revision)
  AND h.body->'advice'=(done.publication->'result')-'outcome'-'evidenceValidUntil'
  AND op.status='completed' AND op.revoked_at IS NULL AND h.body#>>'{provenance,resultHash}'=op.delivery->>'resultHash' AND h.body#>>'{payment,signature}'=op.payment->>'signature'
  AND p.response->>'operationId'=op.id AND p.response->>'resultHash'=op.delivery->>'resultHash'
  AND EXISTS(SELECT 1 FROM pactwoven.paid_tool_redemptions d WHERE(d.operation_id,d.signature,d.result_hash,d.result_body)=(op.id,op.payment->>'signature',op.delivery->>'resultHash',op.delivery->'resultBody')));
 PERFORM pactwoven.native_memory_notes_deadline(ctx);RETURN h.body;END $$;
ALTER TABLE pactwoven.paid_tool_completed_history_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE pactwoven.paid_tool_completed_history_records FORCE ROW LEVEL SECURITY;
DO $$ DECLARE owner name:=current_user;f record;BEGIN
 EXECUTE format('CREATE POLICY paid_tool_history_owner ON pactwoven.paid_tool_completed_history_records TO %I USING(true) WITH CHECK(true)',owner);
 REVOKE ALL ON pactwoven.paid_tool_completed_history_records FROM PUBLIC,pactwoven_runtime,pactwoven_native_delegation_coordinator,pactwoven_paid_tool_api,pactwoven_paid_tool_policy,pactwoven_paid_tool_signer,pactwoven_paid_tool_broadcaster,pactwoven_paid_tool_observer,pactwoven_paid_tool_delivery,pactwoven_paid_tool_scheduler;
 FOR f IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace='pactwoven'::regnamespace AND proname IN('paid_tool_history_dependencies','paid_tool_history_body','paid_tool_history_capture','paid_tool_completed_history') LOOP
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,pactwoven_runtime,pactwoven_native_delegation_coordinator,pactwoven_paid_tool_api,pactwoven_paid_tool_policy,pactwoven_paid_tool_signer,pactwoven_paid_tool_broadcaster,pactwoven_paid_tool_observer,pactwoven_paid_tool_delivery,pactwoven_paid_tool_scheduler',f.signature);END LOOP;
END $$;
CREATE TRIGGER paid_tool_history_immutable BEFORE UPDATE OR DELETE ON pactwoven.paid_tool_completed_history_records FOR EACH ROW EXECUTE FUNCTION pactwoven.paid_tool_immutable();
GRANT EXECUTE ON FUNCTION pactwoven.paid_tool_completed_history(jsonb,text,text,text) TO pactwoven_paid_tool_api;
COMMIT;
