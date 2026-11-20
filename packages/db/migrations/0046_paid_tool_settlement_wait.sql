BEGIN;
-- The quote window limits new payment effects. A persisted original broadcast
-- fence keeps that same payment in settlement after the window closes.
-- Source/grant/revision checks and all new-effect expiry gates remain unchanged.
-- An outcome_unknown from signing alone is not a broadcast fence.
CREATE OR REPLACE FUNCTION pactwoven.paid_tool_root_ready(r pactwoven.native_delegation_root_runs) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT NOT EXISTS(SELECT 1 FROM pactwoven.paid_tool_root_attachments a
  JOIN pactwoven.paid_tool_quotes q ON q.id=a.quote_id LEFT JOIN pactwoven.paid_tool_operations op ON op.quote_id=a.quote_id
  WHERE(r.environment,a.organization_id,a.root_task_id,a.instruction_revision)=('development',r.organization_id,r.root_task_id,pactwoven.native_instruction_revision(r.environment,r.organization_id,r.root_task_id))
  AND a.data_valid_until>clock_timestamp() AND (q.expires_at>clock_timestamp() OR (op.attempt IS NOT NULL AND op.status IN('submitting','payment_pending','payment_confirmed','outcome_unknown')
   AND EXISTS(SELECT 1 FROM pactwoven.paid_tool_commands sent
    WHERE sent.operation_id=op.id AND sent.body->>'operationId'=op.id AND sent.body->>'kind'='prepare_broadcast'
     AND sent.command_hash=pactwoven.native_delegation_hash(jsonb_build_object('namespace','pactwoven.paid-tool-command.v1','command',sent.body))
     AND sent.body->>'commandKey'=sent.command_key AND sent.receipt->>'commandKey'=sent.command_key
     AND sent.receipt->>'commandHash'=sent.command_hash AND sent.receipt->>'status'='submitting'
     AND CASE WHEN jsonb_typeof(sent.body->'expectedVersion')='number' AND jsonb_typeof(sent.receipt->'previousVersion')='number' AND jsonb_typeof(sent.receipt->'version')='number'
      AND sent.body->>'expectedVersion' ~ '^[1-9][0-9]{0,14}$' AND sent.receipt->>'previousVersion' ~ '^[1-9][0-9]{0,14}$' AND sent.receipt->>'version' ~ '^[1-9][0-9]{0,14}$'
      THEN (sent.body->>'expectedVersion')::bigint=(sent.receipt->>'previousVersion')::bigint AND (sent.receipt->>'version')::bigint=(sent.receipt->>'previousVersion')::bigint+1 AND (sent.receipt->>'version')::bigint<=op.version ELSE false END)))
  AND(op.id IS NULL OR(op.status NOT IN('completed','cancelled') AND op.revoked_at IS NULL))) $$;
CREATE OR REPLACE FUNCTION pactwoven.paid_tool_root_read(selector jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE ctx jsonb;a pactwoven.paid_tool_root_attachments;op pactwoven.paid_tool_operations;quote pactwoven.paid_tool_quotes;revision integer;state text;BEGIN
 ctx:=pactwoven.native_delegation_root_context('development',selector,true);revision:=pactwoven.native_instruction_revision('development',selector->>'organizationId',selector->>'taskId');
 SELECT * INTO a FROM pactwoven.paid_tool_root_attachments WHERE(organization_id,root_task_id,instruction_revision)=(selector->>'organizationId',selector->>'taskId',revision);
 IF a.quote_id IS NULL THEN RETURN jsonb_build_object('kind','none','rootTaskId',selector->>'taskId','instructionRevision',revision);END IF;
 SELECT * INTO op FROM pactwoven.paid_tool_operations WHERE quote_id=a.quote_id;SELECT * INTO quote FROM pactwoven.paid_tool_quotes WHERE id=a.quote_id;
 state:=CASE WHEN op.status='completed' AND op.delivery IS NOT NULL THEN 'ready' WHEN op.status='cancelled' OR op.revoked_at IS NOT NULL THEN 'unavailable' WHEN quote.expires_at<=clock_timestamp() AND NOT coalesce((op.attempt IS NOT NULL AND op.status IN('submitting','payment_pending','payment_confirmed','outcome_unknown')
   AND EXISTS(SELECT 1 FROM pactwoven.paid_tool_commands sent
    WHERE sent.operation_id=op.id AND sent.body->>'operationId'=op.id AND sent.body->>'kind'='prepare_broadcast'
     AND sent.command_hash=pactwoven.native_delegation_hash(jsonb_build_object('namespace','pactwoven.paid-tool-command.v1','command',sent.body))
     AND sent.body->>'commandKey'=sent.command_key AND sent.receipt->>'commandKey'=sent.command_key
     AND sent.receipt->>'commandHash'=sent.command_hash AND sent.receipt->>'status'='submitting'
     AND CASE WHEN jsonb_typeof(sent.body->'expectedVersion')='number' AND jsonb_typeof(sent.receipt->'previousVersion')='number' AND jsonb_typeof(sent.receipt->'version')='number'
      AND sent.body->>'expectedVersion' ~ '^[1-9][0-9]{0,14}$' AND sent.receipt->>'previousVersion' ~ '^[1-9][0-9]{0,14}$' AND sent.receipt->>'version' ~ '^[1-9][0-9]{0,14}$'
      THEN (sent.body->>'expectedVersion')::bigint=(sent.receipt->>'previousVersion')::bigint AND (sent.receipt->>'version')::bigint=(sent.receipt->>'previousVersion')::bigint+1 AND (sent.receipt->>'version')::bigint<=op.version ELSE false END)),false) THEN 'unavailable' ELSE 'waiting' END;
 BEGIN PERFORM pactwoven.paid_tool_root_sources(a,pactwoven.supplier_time(ctx->'validUntil'));EXCEPTION WHEN SQLSTATE 'NM001' OR SQLSTATE 'NM005' OR SQLSTATE 'NM006' OR SQLSTATE 'NM007' OR SQLSTATE 'NM008' OR SQLSTATE 'NM009' OR SQLSTATE 'ND001' OR SQLSTATE 'PT004' THEN state:='unavailable';END;
 RETURN jsonb_build_object('kind',state,'rootTaskId',a.root_task_id,'instructionRevision',revision,'quoteId',a.quote_id,'operationId',op.id,'dataValidUntil',pactwoven.mandate_instant(a.data_valid_until));END $$;
CREATE OR REPLACE FUNCTION pactwoven.paid_tool_root_discover(actor jsonb,root text,site text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE ctx jsonb;a pactwoven.paid_tool_root_attachments;op pactwoven.paid_tool_operations;q pactwoven.paid_tool_quotes;r pactwoven.native_delegation_root_runs;g pactwoven.native_delegation_grants;t pactwoven.native_delegation_tasks;revision integer;available boolean:=true;state text;BEGIN
 PERFORM pactwoven.paid_tool_principal(ARRAY['api']);PERFORM pactwoven.paid_tool_require(actor->>'environment'='development');ctx:=pactwoven.native_instruction_actor(actor,root,site,false);
 SELECT * INTO r FROM pactwoven.native_delegation_root_runs WHERE(environment,organization_id,root_task_id)=('development',actor->>'organizationId',root);
 -- Acquire original parent scope before its grant, using the native lock
 -- order. Failed execution authority still permits actor-scoped metadata.
 SELECT * INTO g FROM pactwoven.native_delegation_grants WHERE(environment,organization_id,id)=('development',r.organization_id,r.grant_id);
 BEGIN PERFORM pactwoven.native_delegation_scope_locked(g.body->'scope');EXCEPTION WHEN SQLSTATE 'ND001' THEN available:=false;END;
 PERFORM 1 FROM pactwoven.native_delegation_grants WHERE(environment,organization_id,id)=('development',r.organization_id,r.grant_id) FOR UPDATE;
 SELECT * INTO g FROM pactwoven.native_delegation_grants WHERE(environment,organization_id,id)=('development',r.organization_id,r.grant_id);
 SELECT * INTO t FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=('development',r.organization_id,root);revision:=pactwoven.native_instruction_revision('development',r.organization_id,root);
 SELECT * INTO a FROM pactwoven.paid_tool_root_attachments WHERE(organization_id,root_task_id,instruction_revision)=(r.organization_id,root,revision);
 IF a.quote_id IS NOT NULL THEN
  SELECT * INTO op FROM pactwoven.paid_tool_operations WHERE quote_id=a.quote_id;SELECT * INTO q FROM pactwoven.paid_tool_quotes WHERE id=a.quote_id;
  state:=CASE WHEN op.status='completed' AND op.delivery IS NOT NULL THEN 'ready' WHEN op.status='cancelled' OR op.revoked_at IS NOT NULL THEN 'unavailable' WHEN q.expires_at<=clock_timestamp() AND NOT coalesce((op.attempt IS NOT NULL AND op.status IN('submitting','payment_pending','payment_confirmed','outcome_unknown')
   AND EXISTS(SELECT 1 FROM pactwoven.paid_tool_commands sent
    WHERE sent.operation_id=op.id AND sent.body->>'operationId'=op.id AND sent.body->>'kind'='prepare_broadcast'
     AND sent.command_hash=pactwoven.native_delegation_hash(jsonb_build_object('namespace','pactwoven.paid-tool-command.v1','command',sent.body))
     AND sent.body->>'commandKey'=sent.command_key AND sent.receipt->>'commandKey'=sent.command_key
     AND sent.receipt->>'commandHash'=sent.command_hash AND sent.receipt->>'status'='submitting'
     AND CASE WHEN jsonb_typeof(sent.body->'expectedVersion')='number' AND jsonb_typeof(sent.receipt->'previousVersion')='number' AND jsonb_typeof(sent.receipt->'version')='number'
      AND sent.body->>'expectedVersion' ~ '^[1-9][0-9]{0,14}$' AND sent.receipt->>'previousVersion' ~ '^[1-9][0-9]{0,14}$' AND sent.receipt->>'version' ~ '^[1-9][0-9]{0,14}$'
      THEN (sent.body->>'expectedVersion')::bigint=(sent.receipt->>'previousVersion')::bigint AND (sent.receipt->>'version')::bigint=(sent.receipt->>'previousVersion')::bigint+1 AND (sent.receipt->>'version')::bigint<=op.version ELSE false END)),false) THEN 'unavailable' ELSE 'waiting' END;
  BEGIN
   PERFORM pactwoven.paid_tool_require(available AND g.body->'revocation'='null'::jsonb);
   PERFORM pactwoven.paid_tool_root_sources(a,least(t.deadline_at,pactwoven.supplier_time(g.body->'expiresAt'),pactwoven.native_memory_time(ctx->'validUntil')));
  EXCEPTION WHEN SQLSTATE 'NM001' OR SQLSTATE 'NM005' OR SQLSTATE 'NM006' OR SQLSTATE 'NM007' OR SQLSTATE 'NM008' OR SQLSTATE 'NM009' OR SQLSTATE 'ND001' OR SQLSTATE 'PT004' THEN available:=false;state:='unavailable';END;
 END IF;
 PERFORM pactwoven.native_memory_notes_deadline(ctx);RETURN jsonb_build_object('rootTaskId',root,'instructionRevision',revision,'evidenceAvailable',available,'policy',pactwoven.paid_tool_root_policy_body(r.organization_id,root,revision),'attachment',CASE WHEN a.quote_id IS NULL THEN NULL ELSE jsonb_build_object('quoteId',a.quote_id,'operationId',op.id,'paymentStatus',op.status,'status',state,'dataValidUntil',pactwoven.mandate_instant(a.data_valid_until)) END);END $$;
COMMIT;
