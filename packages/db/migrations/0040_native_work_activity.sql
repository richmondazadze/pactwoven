BEGIN;
-- Additive, human-authorized metadata projection. No existing function changes.
CREATE FUNCTION pactwoven.native_work_activity_read(p_actor jsonb,p_root text,p_site text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE frame jsonb;ctx jsonb;children jsonb := '[]'::jsonb;revision integer;
BEGIN
 -- Use the current human/site check, never an executor claim or a caller's
 -- selected organization. The original reader also validates source disclosure.
 ctx := pactwoven.native_instruction_actor(p_actor,p_root,p_site,false);
 frame := pactwoven.native_delegation_root_read(p_actor,p_root);
 PERFORM pactwoven.native_memory_require(frame#>>'{scope,siteId}'=p_site,'ND001');
 revision := pactwoven.native_instruction_revision(p_actor->>'environment',p_actor->>'organizationId',p_root);
 -- root_read retains the grant share lock through this statement. Mutations
 -- serialize on that grant; root version and current children are joined here.
 IF NOT (frame->>'evidenceUnavailable')::boolean AND NOT (frame->>'checkpointHistorical')::boolean THEN
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'taskId',t.id,'handoffId',t.handoff_id,'assignmentVersion',t.assignment_version,'generation',t.generation,
    'role',a.assignment->>'role','state',t.state,
    'outcome',CASE WHEN t.state='settled' THEN result.publication#>'{result,outcome}' ELSE 'null'::jsonb END,
    'current',true) ORDER BY t.id COLLATE "C"),'[]'::jsonb)
  INTO children
  FROM pactwoven.native_delegation_tasks t
  JOIN pactwoven.native_delegation_root_assignments a
    ON(a.environment,a.organization_id,a.root_task_id,a.task_id,a.handoff_id)=
      (t.environment,t.organization_id,t.root_task_id,t.id,t.handoff_id)
  LEFT JOIN pactwoven.native_delegation_results result
    ON(result.environment,result.organization_id,result.handoff_id,result.assignment_version,result.generation)=
      (t.environment,t.organization_id,t.handoff_id,t.assignment_version,t.generation)
  WHERE(t.environment,t.organization_id,t.root_task_id,t.site_id)=
    (p_actor->>'environment',p_actor->>'organizationId',p_root,p_site)
    AND t.depth>0 AND pactwoven.native_instruction_current(t.environment,t.organization_id,p_root,'task',t.id);
 END IF;
 PERFORM pactwoven.native_memory_notes_deadline(ctx);
 RETURN jsonb_build_object('root',frame,'instructionRevision',revision,
   'observedAt',pactwoven.mandate_instant(clock_timestamp()),'children',children);
END $$;
REVOKE ALL ON FUNCTION pactwoven.native_work_activity_read(jsonb,text,text) FROM PUBLIC,
 pactwoven_runtime,pactwoven_native_task_api,pactwoven_native_task_worker,pactwoven_native_task_dispatcher,
 pactwoven_native_delegation_api,pactwoven_native_delegation_coordinator,pactwoven_native_delegation_worker,pactwoven_native_delegation_dispatcher;
-- Enable only after a compatible API pool profile is deployed.
GRANT EXECUTE ON FUNCTION pactwoven.native_work_activity_read(jsonb,text,text) TO pactwoven_native_delegation_api;
COMMIT;
