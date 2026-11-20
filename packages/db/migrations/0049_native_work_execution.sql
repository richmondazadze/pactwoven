BEGIN;
-- Separate metadata-only observation: a normal coordinator yield must not
-- convert an actually leased current specialist into historical activity.
-- Existing checkpoint, result and activity disclosure gates are unchanged.
CREATE FUNCTION pactwoven.native_work_execution_read(p_actor jsonb,p_root text,p_site text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE ctx jsonb;frame jsonb;execution jsonb:=jsonb_build_object('kind','unavailable','validUntil',NULL,'children','[]'::jsonb);
 r pactwoven.native_delegation_root_runs;root_task pactwoven.native_delegation_tasks;g pactwoven.native_delegation_grants;
 t pactwoven.native_delegation_tasks;a pactwoven.native_delegation_root_assignments;proof pactwoven.native_delegation_proofs;
 h jsonb;binding jsonb;ref jsonb;selected jsonb;checked jsonb;children jsonb:='[]';
 revision integer;until_at timestamptz;observed timestamptz;authorized boolean:=true;
BEGIN
 ctx:=pactwoven.native_instruction_actor(p_actor,p_root,p_site,false);
 SELECT * INTO r FROM pactwoven.native_delegation_root_runs WHERE(environment,organization_id,root_task_id)=(p_actor->>'environment',p_actor->>'organizationId',p_root);
 -- Preserve the normal scope -> grant -> task -> memory lock order. The
 -- lock validates authority and serializes writers, but changes no rows.
 BEGIN
  g:=pactwoven.native_delegation_grant_locked(r.environment,r.organization_id,r.grant_id);
 EXCEPTION WHEN SQLSTATE 'ND001' THEN authorized:=false;
 END;
 frame:=pactwoven.native_delegation_root_read(p_actor,p_root);
 revision:=pactwoven.native_instruction_revision(r.environment,r.organization_id,p_root);
 IF authorized AND frame->>'state'='waiting_children' AND frame->>'reason'='none'
  AND NOT (frame->>'evidenceUnavailable')::boolean THEN
  BEGIN
   SELECT * INTO r FROM pactwoven.native_delegation_root_runs WHERE(environment,organization_id,root_task_id)=(r.environment,r.organization_id,p_root);
   SELECT * INTO root_task FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(r.environment,r.organization_id,p_root);
   PERFORM pactwoven.native_memory_require(r.managed AND NOT r.manual_paused AND NOT r.restart_required AND r.phase='waiting_children'
    AND cardinality(r.wait_for)>0 AND root_task.state='running' AND root_task.lease_token IS NULL
    AND root_task.authority=pactwoven.native_delegation_reference(g) AND root_task.generation::text=frame->>'generation','ND001');
   until_at:=least(clock_timestamp()+interval '10 seconds',pactwoven.native_memory_time(ctx->'validUntil'),
    pactwoven.supplier_time(g.body->'expiresAt'),root_task.deadline_at);
   SELECT memory_references INTO selected FROM pactwoven.native_delegation_root_note_selections WHERE(environment,organization_id,root_task_id)=(r.environment,r.organization_id,p_root);
   PERFORM pactwoven.native_memory_require(selected IS NOT NULL,'ND001');
   IF jsonb_array_length(selected)>0 THEN PERFORM pactwoven.native_memory_lock_scope(ctx,false);END IF;
   -- Recheck even unconsumed selected private material. No source expiry or
   -- human-reader access exception is granted by metadata observation.
   FOR ref IN SELECT value FROM jsonb_array_elements(selected) LOOP
    checked:=pactwoven.native_memory_evaluate_locked(ctx||jsonb_build_object('purpose','human_review'),ref,clock_timestamp());
    until_at:=least(until_at,pactwoven.native_memory_time(checked#>'{selection,validUntil}'));
   END LOOP;
   FOR t IN SELECT * FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,root_task_id,site_id)=(r.environment,r.organization_id,p_root,p_site)
    AND id=ANY(r.wait_for) AND state IN('ready','running') ORDER BY id COLLATE "C" LOOP
    SELECT * INTO a FROM pactwoven.native_delegation_root_assignments WHERE(environment,organization_id,root_task_id,task_id,handoff_id,generation,assignment_version)=
     (t.environment,t.organization_id,p_root,t.id,t.handoff_id,t.generation,t.assignment_version);
    PERFORM pactwoven.native_memory_require(jsonb_typeof(a.assignment->'memoryReferences')='array','ND001');
    PERFORM pactwoven.native_memory_require(t.depth=1 AND t.parent_task_id=p_root AND t.grant_id=g.id
     AND t.authority=pactwoven.native_delegation_reference(g) AND a.task_id IS NOT NULL
     AND pactwoven.native_instruction_current(t.environment,t.organization_id,p_root,'task',t.id)
     AND a.assignment=a.intent->'assignment' AND a.assignment->>'role' IN('research','planning','escalation')
     AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(a.assignment->'memoryReferences') refs(value) WHERE NOT selected @> jsonb_build_array(value)),'ND001');
    SELECT body INTO h FROM pactwoven.native_delegation_envelopes WHERE(environment,organization_id,handoff_id,assignment_version,generation,kind)=
     (t.environment,t.organization_id,t.handoff_id,t.assignment_version,t.generation,'handoff');
    PERFORM pactwoven.native_memory_require(h IS NOT NULL AND h=a.intent->'handoff' AND h->'recipient'=t.identity
     AND h->>'childTaskId'=t.id AND h->>'parentTaskId'=p_root AND h->>'rootTaskId'=p_root AND h->'authority'=t.authority
     AND h->'inputArtifacts'='[]'::jsonb
     AND EXISTS(SELECT 1 FROM pactwoven.native_delegation_services service WHERE(service.environment,service.service_id)=(t.environment,t.identity->>'serviceId') AND service.enabled AND service.identity=t.identity AND service.purpose='worker')
     AND EXISTS(SELECT 1 FROM pactwoven.native_delegation_service_bindings service JOIN pg_roles role ON(role.rolname,role.oid)=(service.role_name,service.role_oid) WHERE(service.environment,service.service_id)=(t.environment,t.identity->>'serviceId') AND service.enabled AND service.purpose='worker'),'ND001');
    binding:=pactwoven.native_delegation_provider_binding(g,t);
    until_at:=least(until_at,t.deadline_at,(binding->>'memberExpiry')::timestamptz);
    IF t.state='running' THEN
     SELECT * INTO proof FROM pactwoven.native_delegation_proofs WHERE(environment,organization_id,task_id)=(t.environment,t.organization_id,t.id);
     PERFORM pactwoven.native_memory_require(t.lease_token IS NOT NULL AND t.lease_until>clock_timestamp()
      AND proof.task_id IS NOT NULL AND proof.verdict='allowed' AND proof.binding=binding AND proof.valid_until>clock_timestamp(),'ND001');
     until_at:=least(until_at,t.lease_until,proof.valid_until);
    ELSE
     PERFORM pactwoven.native_memory_require(t.lease_token IS NULL AND t.lease_until IS NULL,'ND001');
    END IF;
    children:=children||jsonb_build_array(jsonb_build_object('taskId',t.id,'handoffId',t.handoff_id,'assignmentVersion',t.assignment_version,'generation',t.generation,
     'role',a.assignment->>'role','state',t.state,'leaseUntil',CASE WHEN t.state='running' THEN pactwoven.mandate_instant(t.lease_until) END,'current',true));
   END LOOP;
   PERFORM pactwoven.native_memory_require(jsonb_array_length(children) BETWEEN 1 AND 32 AND until_at>clock_timestamp(),'ND001');
   execution:=jsonb_build_object('kind','verified','validUntil',pactwoven.mandate_instant(until_at),'children',children);
  EXCEPTION WHEN SQLSTATE 'NM001' OR SQLSTATE 'NM002' OR SQLSTATE 'NM004' OR SQLSTATE 'NM005' OR SQLSTATE 'NM006' OR SQLSTATE 'NM007' OR SQLSTATE 'NM008' OR SQLSTATE 'NM009' OR SQLSTATE 'ND001' THEN
   execution:=jsonb_build_object('kind','unavailable','validUntil',NULL,'children','[]'::jsonb);
  END;
 END IF;
 PERFORM pactwoven.native_memory_notes_deadline(ctx);
 observed:=clock_timestamp();
 IF execution->>'kind'='verified' AND pactwoven.supplier_time(execution->'validUntil')<=observed THEN
  execution:=jsonb_build_object('kind','unavailable','validUntil',NULL,'children','[]'::jsonb);
 END IF;
 RETURN jsonb_build_object('root',frame,'instructionRevision',revision,'observedAt',pactwoven.mandate_instant(observed),'currentExecution',execution);
END $$;
REVOKE ALL ON FUNCTION pactwoven.native_work_execution_read(jsonb,text,text) FROM PUBLIC,
 pactwoven_runtime,pactwoven_native_task_api,pactwoven_native_task_worker,pactwoven_native_task_dispatcher,
 pactwoven_native_delegation_api,pactwoven_native_delegation_coordinator,pactwoven_native_delegation_worker,pactwoven_native_delegation_dispatcher;
GRANT EXECUTE ON FUNCTION pactwoven.native_work_execution_read(jsonb,text,text) TO pactwoven_native_delegation_api;
COMMIT;
