BEGIN;
-- Separate metadata-only projection. Historical activity/checkpoint semantics
-- remain unchanged; these contributors are recorded facts, never active agents.
CREATE FUNCTION pactwoven.paid_tool_retained_contributors(actor jsonb,root text,site text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE ctx jsonb;frame jsonb;a pactwoven.paid_tool_root_attachments;
 r pactwoven.native_delegation_root_runs;t pactwoven.native_delegation_tasks;g pactwoven.native_delegation_grants;
 q pactwoven.paid_tool_quotes;op pactwoven.paid_tool_operations;i pactwoven.native_delegation_root_inputs;
 child pactwoven.native_delegation_tasks;assignment pactwoven.native_delegation_root_assignments;
 publication pactwoven.native_delegation_results;ref jsonb;item jsonb;metadata jsonb:='{}'::jsonb;
 contributors jsonb:='[]'::jsonb;deadline timestamptz;observed timestamptz;finished timestamptz;
 revision integer;state text:='not_applicable';quote_id text;public_id text;answer jsonb;
BEGIN
 PERFORM pactwoven.paid_tool_principal(ARRAY['api']);
 PERFORM pactwoven.native_memory_require(actor->>'environment'='development','ND001');
 ctx:=pactwoven.native_instruction_actor(actor,root,site,false);
 -- The existing reader retains the original grant share lock and validates
 -- disclosure with the current human reader. No worker claim is constructed.
 frame:=pactwoven.native_delegation_root_read(actor,root);
 PERFORM pactwoven.native_memory_require(frame#>>'{scope,siteId}'=site,'ND001');
 revision:=pactwoven.native_instruction_revision('development',actor->>'organizationId',root);
 SELECT * INTO r FROM pactwoven.native_delegation_root_runs WHERE(environment,organization_id,root_task_id)=('development',actor->>'organizationId',root);
 SELECT * INTO t FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=('development',r.organization_id,root);
 SELECT * INTO g FROM pactwoven.native_delegation_grants WHERE(environment,organization_id,id)=('development',r.organization_id,r.grant_id);
 IF (frame->>'evidenceUnavailable')::boolean THEN state:='unavailable';
 ELSIF frame->>'state'='waiting_children' AND (frame->>'checkpointHistorical')::boolean AND NOT r.manual_paused THEN
  SELECT * INTO a FROM pactwoven.paid_tool_root_attachments WHERE(organization_id,root_task_id,instruction_revision,site_id,actor_id)=(r.organization_id,root,revision,site,actor->>'actorId');
  IF a.quote_id IS NOT NULL THEN
   BEGIN
    PERFORM pactwoven.paid_tool_require(a.generation<t.generation AND a.selection_hash=pactwoven.native_delegation_hash(jsonb_build_object('namespace','pactwoven.equipment-selection.v1','candidate',a.selection)));
    -- A generation advance alone is not proof of a paid wait. Bind the exact
    -- persisted wait response to the current generation and checkpoint.
    PERFORM pactwoven.paid_tool_require(EXISTS(SELECT 1 FROM pactwoven.paid_tool_root_waits w
     WHERE(w.organization_id,w.root_task_id,w.generation,w.identity)=(r.organization_id,root,t.generation-1,a.identity)
      AND w.body->>'quoteId'=a.quote_id AND (w.body->>'expectedInstructionRevision')::integer=revision
      AND (w.response#>>'{checkpoint,generation}')::bigint=t.generation
      AND (w.response#>>'{checkpoint,checkpointVersion}')::bigint=r.checkpoint_version
      AND w.response#>>'{checkpoint,continuation}'='waiting_children'));
    SELECT * INTO q FROM pactwoven.paid_tool_quotes WHERE(id,organization_id,root_task_id,site_id,instruction_revision)=(a.quote_id,r.organization_id,root,site,revision);
    SELECT po.* INTO op FROM pactwoven.paid_tool_operations po WHERE po.quote_id=a.quote_id;
    PERFORM pactwoven.paid_tool_require(q.id IS NOT NULL AND q.expires_at>clock_timestamp() AND(op.id IS NULL OR(op.revoked_at IS NULL AND op.status<>'cancelled'))
     AND g.body->'revocation'='null'::jsonb AND t.authority=pactwoven.native_delegation_reference(g));
    deadline:=least(q.expires_at,t.deadline_at,pactwoven.supplier_time(g.body->'expiresAt'),pactwoven.native_memory_time(ctx->'validUntil'));
    deadline:=least(deadline,pactwoven.paid_tool_root_sources(a,deadline));
    PERFORM pactwoven.paid_tool_require(pactwoven.native_memory_scope(a.context_binding)=frame->'scope');
    FOR ref IN SELECT value FROM jsonb_array_elements(a.input_receipts) LOOP
     SELECT * INTO i FROM pactwoven.native_delegation_root_inputs WHERE(environment,organization_id,root_task_id,generation,id::text,digest)=('development',r.organization_id,root,a.generation,ref->>'receiptId',ref->>'digest');
     PERFORM pactwoven.paid_tool_require(i.id IS NOT NULL AND i.digest=pactwoven.native_delegation_hash(i.body)
      AND pactwoven.native_instruction_current('development',r.organization_id,root,'input',i.id::text));
     FOR item IN SELECT value FROM jsonb_array_elements(i.body->'results') WHERE value->>'outcome'='advice_ready' LOOP
      SELECT * INTO child FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,root_task_id,site_id,handoff_id)=('development',r.organization_id,root,site,item->>'handoffId');
      SELECT * INTO assignment FROM pactwoven.native_delegation_root_assignments WHERE(environment,organization_id,root_task_id,task_id,handoff_id,assignment_version)=('development',r.organization_id,root,child.id,child.handoff_id,child.assignment_version);
      SELECT * INTO publication FROM pactwoven.native_delegation_results WHERE(environment,organization_id,handoff_id,assignment_version,generation,digest)=('development',r.organization_id,child.handoff_id,child.assignment_version,child.generation,item->>'publicationDigest');
      PERFORM pactwoven.paid_tool_require(child.id IS NOT NULL AND child.depth>0 AND child.state='settled'
       AND assignment.task_id IS NOT NULL AND assignment.assignment->>'role' IN('research','planning','escalation')
       AND publication.result_id IS NOT NULL AND publication.publication#>>'{result,outcome}'='advice_ready'
       AND publication.publication#>>'{result,childTaskId}'=child.id
       AND assignment.assignment=assignment.intent->'assignment'
       AND assignment.request_key=assignment.intent->>'requestKey'
       AND (assignment.intent#>>'{handoff,childTaskId}',assignment.intent#>>'{handoff,handoffId}',assignment.intent#>>'{handoff,rootTaskId}',assignment.intent#>>'{handoff,siteId}',assignment.intent#>>'{handoff,assignmentVersion}')=(child.id,child.handoff_id,root,site,child.assignment_version::text)
       AND pactwoven.native_delegation_hash(assignment.intent->'handoff')=publication.publication#>>'{result,handoffDigest}'
       -- The displayed role comes from an original assignment corroborated by
       -- a hash-validated accepted artifact, never from a free-standing enum.
       AND EXISTS(SELECT 1 FROM jsonb_array_elements(item->'artifacts') artifact
        WHERE artifact#>>'{body,kind}'='delegated_advice_v1'
         AND (artifact#>>'{body,role}',artifact#>>'{body,stepId}')=(assignment.assignment->>'role',assignment.assignment->>'stepId')
         AND publication.publication#>'{result,artifacts}' @> jsonb_build_array(artifact->'reference'))
       AND pactwoven.native_instruction_current('development',r.organization_id,root,'task',child.id));
      finished:=pactwoven.supplier_time(publication.publication#>'{result,finishedAt}');
      PERFORM pactwoven.paid_tool_require(finished<=clock_timestamp());
      public_id:=substr(pactwoven.native_delegation_hash(jsonb_build_object('namespace','pactwoven.paid-contributor.v1','organizationId',r.organization_id,'rootTaskId',root,'taskId',child.id)),1,32);
      metadata:=metadata||jsonb_build_object(public_id,jsonb_build_object('id',public_id,'role',assignment.assignment->>'role','status','recorded','completedAt',pactwoven.mandate_instant(finished)));
     END LOOP;
    END LOOP;
    SELECT coalesce(jsonb_agg(value ORDER BY key COLLATE "C"),'[]'::jsonb) INTO contributors FROM jsonb_each(metadata);
    PERFORM pactwoven.paid_tool_require(jsonb_array_length(contributors) BETWEEN 1 AND 32 AND deadline>clock_timestamp());
    state:='recorded';quote_id:=a.quote_id;
   EXCEPTION WHEN SQLSTATE 'ND001' OR SQLSTATE 'NM001' OR SQLSTATE 'NM002' OR SQLSTATE 'NM004' OR SQLSTATE 'NM005' OR SQLSTATE 'NM006' OR SQLSTATE 'NM007' OR SQLSTATE 'NM008' OR SQLSTATE 'NM009' OR SQLSTATE 'PT001' OR SQLSTATE 'PT004' THEN
    state:='unavailable';contributors:='[]'::jsonb;quote_id:=NULL;deadline:=NULL;
   END;
  END IF;
 END IF;
 PERFORM pactwoven.native_memory_notes_deadline(ctx);
 observed:=clock_timestamp();
 IF state='recorded' AND deadline<=observed THEN state:='unavailable';contributors:='[]'::jsonb;quote_id:=NULL;deadline:=NULL;END IF;
 answer:=jsonb_build_object('scope',frame->'scope','rootTaskId',root,'instructionRevision',revision,
  'rootGeneration',frame->'generation','controlVersion',frame->'controlVersion','checkpointVersion',frame->'checkpointVersion',
  'observedAt',pactwoven.mandate_instant(observed),'availableUntil',CASE WHEN state='recorded' THEN pactwoven.mandate_instant(least(deadline,observed+interval '10 seconds')) ELSE NULL END,
  'state',state,'quoteId',quote_id,'contributors',contributors,'active',false);
 RETURN answer;
END $$;
REVOKE ALL ON FUNCTION pactwoven.paid_tool_retained_contributors(jsonb,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pactwoven.paid_tool_retained_contributors(jsonb,text,text) TO pactwoven_paid_tool_api;
COMMIT;
