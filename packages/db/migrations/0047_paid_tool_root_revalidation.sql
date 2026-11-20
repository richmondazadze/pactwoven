BEGIN;
-- A new immutable witness can validate an unchanged completed purchase against
-- fresh accepted evidence on its original active root. It grants no new effect.
CREATE TABLE pactwoven.paid_tool_root_revalidations(
 organization_id text NOT NULL,root_task_id text NOT NULL,instruction_revision integer NOT NULL,generation bigint NOT NULL,refresh_epoch bigint NOT NULL,
 quote_id text NOT NULL REFERENCES pactwoven.paid_tool_quotes,operation_id text NOT NULL REFERENCES pactwoven.paid_tool_operations,
 request_key text NOT NULL,identity jsonb NOT NULL,context_binding jsonb NOT NULL,input_receipts jsonb NOT NULL,
 selection jsonb NOT NULL,selection_hash text NOT NULL,result_hash text NOT NULL,data_valid_until timestamptz NOT NULL,
 body jsonb NOT NULL,body_hash text NOT NULL,response jsonb NOT NULL,response_hash text NOT NULL,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organization_id,root_task_id,generation),UNIQUE(organization_id,root_task_id,request_key));
CREATE TABLE pactwoven.paid_tool_root_revalidation_parks(
 organization_id text NOT NULL,root_task_id text NOT NULL,generation bigint NOT NULL,request_key text NOT NULL,identity jsonb NOT NULL,
 body jsonb NOT NULL,body_hash text NOT NULL,response jsonb NOT NULL,response_hash text NOT NULL,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organization_id,root_task_id,generation),UNIQUE(organization_id,root_task_id,request_key));
CREATE FUNCTION pactwoven.paid_tool_root_settlement_pending(op pactwoven.paid_tool_operations) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$ SELECT coalesce(op.revoked_at IS NULL AND op.attempt IS NOT NULL AND op.status IN('submitting','payment_pending','payment_confirmed','outcome_unknown') AND EXISTS(SELECT 1 FROM pactwoven.paid_tool_commands sent
    WHERE sent.operation_id=op.id AND sent.body->>'operationId'=op.id AND sent.body->>'kind'='prepare_broadcast'
     AND sent.command_hash=pactwoven.native_delegation_hash(jsonb_build_object('namespace','pactwoven.paid-tool-command.v1','command',sent.body))
     AND sent.body->>'commandKey'=sent.command_key AND sent.receipt->>'commandKey'=sent.command_key
     AND sent.receipt->>'commandHash'=sent.command_hash AND sent.receipt->>'status'='submitting'
     AND CASE WHEN jsonb_typeof(sent.body->'expectedVersion')='number' AND jsonb_typeof(sent.receipt->'previousVersion')='number' AND jsonb_typeof(sent.receipt->'version')='number'
      AND sent.body->>'expectedVersion' ~ '^[1-9][0-9]{0,14}$' AND sent.receipt->>'previousVersion' ~ '^[1-9][0-9]{0,14}$' AND sent.receipt->>'version' ~ '^[1-9][0-9]{0,14}$'
      THEN (sent.body->>'expectedVersion')::bigint=(sent.receipt->>'previousVersion')::bigint AND (sent.receipt->>'version')::bigint=(sent.receipt->>'previousVersion')::bigint+1 AND (sent.receipt->>'version')::bigint<=op.version ELSE false END),false) $$;
CREATE FUNCTION pactwoven.paid_tool_root_revalidation_context(selector jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE ctx jsonb;BEGIN
 ctx:=pactwoven.native_delegation_root_context('development',selector,true);
 PERFORM pactwoven.paid_tool_require(NOT EXISTS(SELECT 1 FROM pactwoven.native_delegation_root_completions WHERE(environment,organization_id,root_task_id)=('development',selector->>'organizationId',selector->>'taskId')));
 RETURN ctx;END $$;
CREATE FUNCTION pactwoven.paid_tool_root_revalidation(selector jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE ctx jsonb;a pactwoven.paid_tool_root_attachments;op pactwoven.paid_tool_operations;q pactwoven.paid_tool_quotes;rev integer;answer jsonb;BEGIN
 ctx:=pactwoven.paid_tool_root_revalidation_context(selector);rev:=pactwoven.native_instruction_revision('development',selector->>'organizationId',selector->>'taskId');
 answer:=jsonb_build_object('kind','not_applicable','rootTaskId',selector->>'taskId','instructionRevision',rev);
 SELECT * INTO a FROM pactwoven.paid_tool_root_attachments WHERE(organization_id,root_task_id,instruction_revision)=(selector->>'organizationId',selector->>'taskId',rev);
 IF a.quote_id IS NULL THEN RETURN answer;END IF;
 SELECT * INTO op FROM pactwoven.paid_tool_operations WHERE quote_id=a.quote_id;
 SELECT * INTO q FROM pactwoven.paid_tool_quotes WHERE id=a.quote_id;
 IF pactwoven.paid_tool_root_settlement_pending(op) THEN RETURN answer||jsonb_build_object('kind','pending','quoteId',a.quote_id,'operationId',op.id);END IF;
 IF op.status='completed' AND op.revoked_at IS NULL AND op.payment IS NOT NULL AND op.delivery IS NOT NULL AND op.delivery->>'paymentSignature'=op.payment->>'signature' THEN
  RETURN answer||jsonb_build_object('kind','required','quoteId',a.quote_id,'operationId',op.id,'requestHash',q.body#>>'{request,hash}','resourceHash',q.body#>>'{resource,hash}','resultHash',op.delivery->>'resultHash');
 END IF;RETURN answer;END $$;
CREATE FUNCTION pactwoven.paid_tool_root_revalidation_record(v pactwoven.paid_tool_root_revalidations) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT coalesce(v.body_hash=pactwoven.native_delegation_hash(v.body) AND v.response_hash=pactwoven.native_delegation_hash(v.response)
  AND v.body->>'schemaVersion'='1' AND v.body->>'expectedInstructionRevision'=v.instruction_revision::text AND v.body->>'expectedRefreshEpoch'=v.refresh_epoch::text
  AND v.body->>'quoteId'=v.quote_id AND v.body->>'operationId'=v.operation_id AND v.body->>'requestKey'=v.request_key
  AND v.body->'inputReceipts'=v.input_receipts AND v.body#>'{selection,candidate}'=v.selection AND v.body#>>'{selection,selectionHash}'=v.selection_hash
  AND v.selection_hash=pactwoven.native_delegation_hash(jsonb_build_object('namespace','pactwoven.equipment-selection.v1','candidate',v.selection))
  AND v.context_binding->>'environment'='development' AND v.context_binding->>'organizationId'=v.organization_id AND v.context_binding#>>'{usage,taskId}'=v.root_task_id AND v.context_binding#>>'{usage,generation}'=v.generation::text
  AND v.response=jsonb_build_object('rootTaskId',v.root_task_id,'instructionRevision',v.instruction_revision,'generation',v.generation,'refreshEpoch',v.refresh_epoch,'quoteId',v.quote_id,'operationId',v.operation_id,'requestKey',v.request_key,'resultHash',v.result_hash,'dataValidUntil',pactwoven.mandate_instant(v.data_valid_until)),false) $$;
CREATE FUNCTION pactwoven.paid_tool_root_revalidate(selector jsonb,q jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE ctx jsonb;identity jsonb;a pactwoven.paid_tool_root_attachments;op pactwoven.paid_tool_operations;quote pactwoven.paid_tool_quotes;
 t pactwoven.native_delegation_tasks;r pactwoven.native_delegation_root_runs;prior pactwoven.paid_tool_root_revalidations;revision integer;epoch bigint;deadline timestamptz;selection jsonb;support jsonb;answer jsonb;BEGIN
 PERFORM pactwoven.paid_tool_keys(q,ARRAY['schemaVersion','expectedInstructionRevision','expectedRefreshEpoch','quoteId','operationId','requestKey','inputReceipts','selection']);
 PERFORM pactwoven.paid_tool_require(q->>'schemaVersion'='1' AND q->>'requestKey' ~ '^[A-Za-z0-9_-]{16,128}$' AND octet_length(q::text)<=100000);
 revision:=pactwoven.native_instruction_fence('development',selector,jsonb_build_object('schemaVersion',3,'expectedInstructionRevision',q->'expectedInstructionRevision','expectedRefreshEpoch',q->'expectedRefreshEpoch','command','{}'::jsonb));
 ctx:=pactwoven.paid_tool_root_revalidation_context(selector);identity:=pactwoven.native_delegation_service('development',ARRAY['coordinator']);epoch:=pactwoven.native_delegation_refresh_epoch('development',selector->>'organizationId',selector->>'taskId');
 SELECT * INTO t FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=('development',selector->>'organizationId',selector->>'taskId');
 SELECT * INTO r FROM pactwoven.native_delegation_root_runs WHERE(environment,organization_id,root_task_id)=('development',t.organization_id,t.id);
 SELECT * INTO a FROM pactwoven.paid_tool_root_attachments WHERE(organization_id,root_task_id,instruction_revision,quote_id)=(t.organization_id,t.id,revision,q->>'quoteId');
 PERFORM pactwoven.paid_tool_require(a.quote_id IS NOT NULL AND a.identity=identity AND a.actor_id=r.actor_id AND a.site_id=r.site_id);
 SELECT * INTO op FROM pactwoven.paid_tool_operations WHERE(id,quote_id)=(q->>'operationId',a.quote_id) FOR SHARE;
 SELECT * INTO quote FROM pactwoven.paid_tool_quotes WHERE id=a.quote_id;
 PERFORM pactwoven.paid_tool_require(op.status='completed' AND op.revoked_at IS NULL AND op.payment IS NOT NULL AND op.delivery IS NOT NULL
  AND op.delivery->>'paymentSignature'=op.payment->>'signature' AND op.delivery->>'requestHash'=quote.body#>>'{request,hash}' AND op.delivery->>'resourceHash'=quote.body#>>'{resource,hash}'
  AND op.delivery->>'resultHash'=pactwoven.native_delegation_hash(jsonb_build_object('namespace','pactwoven.paid-tools.delivery.v1','result',op.delivery->'resultBody'))
  AND EXISTS(SELECT 1 FROM pactwoven.paid_tool_redemptions d WHERE(d.operation_id,d.signature,d.result_hash,d.artifact_ref,d.result_body)=(op.id,op.payment->>'signature',op.delivery->>'resultHash',op.delivery->>'artifactRef',op.delivery->'resultBody')));
 PERFORM pactwoven.paid_tool_require(jsonb_typeof(q->'inputReceipts')='array' AND jsonb_array_length(q->'inputReceipts') BETWEEN 1 AND 32);
 deadline:=pactwoven.native_delegation_root_receipts(ctx,q->'inputReceipts');selection:=q#>'{selection,candidate}';
 PERFORM pactwoven.paid_tool_require(q#>>'{selection,selectionHash}'=pactwoven.native_delegation_hash(jsonb_build_object('namespace','pactwoven.equipment-selection.v1','candidate',selection)) AND selection->>'schemaVersion'='1' AND selection->>'kind'='equipment_service_selection' AND selection->>'authority'='none' AND selection->>'serviceId'='equipment_optimizer_v1' AND selection->>'decision'='use_service'
  AND(selection#>>'{scope,organizationId}',selection#>>'{scope,rootTaskId}',selection#>>'{scope,siteId}',selection#>>'{scope,instructionRevision}')=(t.organization_id,t.id,r.site_id,revision::text)
  AND selection->'request'=quote.request_body AND selection->>'requestHash'=quote.body#>>'{request,hash}' AND selection->>'resourceHash'=quote.body#>>'{resource,hash}'
  AND q->'inputReceipts' @> jsonb_build_array(selection->'inputReceipt') AND jsonb_typeof(selection->'supportingArtifacts')='array' AND jsonb_array_length(selection->'supportingArtifacts') BETWEEN 1 AND 16);
 FOR support IN SELECT value FROM jsonb_array_elements(selection->'supportingArtifacts') LOOP
  PERFORM pactwoven.paid_tool_require(EXISTS(SELECT 1 FROM pactwoven.native_delegation_root_inputs i,jsonb_array_elements(i.body->'results') result,jsonb_array_elements(result->'artifacts') artifact
   WHERE(i.environment,i.organization_id,i.root_task_id,i.generation)=('development',t.organization_id,t.id,t.generation) AND i.id::text=selection#>>'{inputReceipt,receiptId}' AND i.digest=selection#>>'{inputReceipt,digest}' AND result->>'outcome'='advice_ready'
    AND(artifact#>>'{reference,artifactId}',artifact#>>'{reference,digest}',artifact#>>'{body,role}')=(support->>'artifactId',support->>'digest',support->>'role')));
 END LOOP;
 deadline:=least(deadline,t.deadline_at,pactwoven.supplier_time(ctx->'validUntil'));
 SELECT * INTO prior FROM pactwoven.paid_tool_root_revalidations WHERE(organization_id,root_task_id,generation)=(t.organization_id,t.id,t.generation);
 IF FOUND THEN PERFORM pactwoven.paid_tool_require(prior.identity=identity AND prior.body=q AND pactwoven.paid_tool_root_revalidation_record(prior) AND prior.data_valid_until>clock_timestamp());RETURN prior.response;END IF;
 answer:=jsonb_build_object('rootTaskId',t.id,'instructionRevision',revision,'generation',t.generation,'refreshEpoch',epoch,'quoteId',a.quote_id,'operationId',op.id,'requestKey',q->>'requestKey','resultHash',op.delivery->>'resultHash','dataValidUntil',pactwoven.mandate_instant(deadline));
 INSERT INTO pactwoven.paid_tool_root_revalidations VALUES(t.organization_id,t.id,revision,t.generation,epoch,a.quote_id,op.id,q->>'requestKey',identity,ctx-'validUntil',q->'inputReceipts',selection,q#>>'{selection,selectionHash}',op.delivery->>'resultHash',deadline,q,pactwoven.native_delegation_hash(q),answer,pactwoven.native_delegation_hash(answer),clock_timestamp());
 PERFORM pactwoven.native_memory_require(deadline>clock_timestamp(),'NM008');RETURN answer;END $$;
CREATE FUNCTION pactwoven.paid_tool_root_revalidation_park(selector jsonb,q jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE ctx jsonb;identity jsonb;t pactwoven.native_delegation_tasks;r pactwoven.native_delegation_root_runs;a pactwoven.paid_tool_root_attachments;op pactwoven.paid_tool_operations;prior pactwoven.paid_tool_root_revalidation_parks;revision integer;answer jsonb;BEGIN
 PERFORM pactwoven.paid_tool_keys(q,ARRAY['schemaVersion','expectedInstructionRevision','expectedRefreshEpoch','quoteId','operationId','requestKey']);PERFORM pactwoven.paid_tool_require(q->>'schemaVersion'='1' AND q->>'requestKey' ~ '^[A-Za-z0-9_-]{16,128}$');
 identity:=pactwoven.native_delegation_service('development',ARRAY['coordinator']);PERFORM pactwoven.native_delegation_target(selector,true);
 SELECT * INTO t FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=('development',selector->>'organizationId',selector->>'taskId');
 PERFORM pactwoven.paid_tool_require(t.depth=0 AND t.identity=identity);PERFORM pactwoven.native_delegation_grant_locked('development',t.organization_id,t.grant_id);
 SELECT * INTO prior FROM pactwoven.paid_tool_root_revalidation_parks WHERE(organization_id,root_task_id,request_key)=(t.organization_id,t.id,q->>'requestKey');
 IF FOUND THEN
  SELECT * INTO r FROM pactwoven.native_delegation_root_runs WHERE(environment,organization_id,root_task_id)=('development',t.organization_id,t.id) FOR UPDATE;
  PERFORM pactwoven.paid_tool_require(prior.identity=identity AND prior.generation=(selector->>'generation')::bigint AND prior.body=q AND prior.body_hash=pactwoven.native_delegation_hash(q) AND prior.response_hash=pactwoven.native_delegation_hash(prior.response)
   AND t.generation=prior.generation+1 AND t.state='running' AND r.phase='waiting_children' AND NOT r.manual_paused
   AND q->>'expectedInstructionRevision'=pactwoven.native_instruction_revision('development',t.organization_id,t.id)::text
   AND q->>'expectedRefreshEpoch'=pactwoven.native_delegation_refresh_epoch('development',t.organization_id,t.id)::text
   AND NOT EXISTS(SELECT 1 FROM pactwoven.native_delegation_root_completions WHERE(environment,organization_id,root_task_id)=('development',t.organization_id,t.id)));RETURN prior.response;
 END IF;
 revision:=pactwoven.native_instruction_fence('development',selector,jsonb_build_object('schemaVersion',3,'expectedInstructionRevision',q->'expectedInstructionRevision','expectedRefreshEpoch',q->'expectedRefreshEpoch','command','{}'::jsonb));ctx:=pactwoven.paid_tool_root_revalidation_context(selector);
 SELECT * INTO a FROM pactwoven.paid_tool_root_attachments WHERE(organization_id,root_task_id,instruction_revision,quote_id)=(t.organization_id,t.id,revision,q->>'quoteId');
 SELECT * INTO op FROM pactwoven.paid_tool_operations WHERE(id,quote_id)=(q->>'operationId',a.quote_id) FOR SHARE;
 PERFORM pactwoven.paid_tool_require(a.quote_id IS NOT NULL AND a.identity=identity AND pactwoven.paid_tool_root_settlement_pending(op));
 UPDATE pactwoven.native_delegation_root_runs SET phase='waiting_children',wait_for='{}',updated_at=clock_timestamp() WHERE(environment,organization_id,root_task_id)=('development',t.organization_id,t.id) RETURNING * INTO r;
 UPDATE pactwoven.native_delegation_tasks SET generation=generation+1,lease_token=NULL,lease_until=NULL WHERE(environment,organization_id,id)=('development',t.organization_id,t.id) RETURNING * INTO t;
 UPDATE pactwoven.native_delegation_proofs SET verdict='unknown',valid_until=NULL,nonce=NULL,nonce_barrier=NULL,prepared_at=NULL,deadline_at=NULL,barrier=barrier+1 WHERE(environment,organization_id,task_id)=('development',t.organization_id,t.id);
 UPDATE pactwoven.native_delegation_outbox SET state='suppressed',token=NULL,lease_until=NULL WHERE(environment,organization_id,task_id)=('development',t.organization_id,t.id);
 IF pactwoven.native_delegation_root_wait_ready(r) THEN PERFORM pactwoven.native_delegation_root_wake('development',t.organization_id,t.id,t.generation);END IF;
 answer:=jsonb_build_object('state','waiting','rootTaskId',t.id,'instructionRevision',revision,'generation',t.generation,'refreshEpoch',q->'expectedRefreshEpoch','quoteId',a.quote_id,'operationId',op.id,'requestKey',q->>'requestKey');
 INSERT INTO pactwoven.paid_tool_root_revalidation_parks VALUES(t.organization_id,t.id,(selector->>'generation')::bigint,q->>'requestKey',identity,q,pactwoven.native_delegation_hash(q),answer,pactwoven.native_delegation_hash(answer),clock_timestamp());
 PERFORM pactwoven.native_memory_require(pactwoven.supplier_time(ctx->'validUntil')>clock_timestamp(),'NM008');RETURN answer;END $$;
CREATE FUNCTION pactwoven.paid_tool_root_data_until(a pactwoven.paid_tool_root_attachments) RETURNS timestamptz LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT coalesce((SELECT v.data_valid_until FROM pactwoven.paid_tool_root_revalidations v WHERE(v.organization_id,v.root_task_id,v.instruction_revision,v.refresh_epoch)=(a.organization_id,a.root_task_id,a.instruction_revision,pactwoven.native_delegation_refresh_epoch('development',a.organization_id,a.root_task_id)) ORDER BY v.generation DESC LIMIT 1),a.data_valid_until) $$;
ALTER FUNCTION pactwoven.paid_tool_root_sources(pactwoven.paid_tool_root_attachments,timestamptz) RENAME TO paid_tool_root_sources_before_revalidation;
CREATE FUNCTION pactwoven.paid_tool_root_sources(a pactwoven.paid_tool_root_attachments,until_at timestamptz) RETURNS timestamptz LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE v pactwoven.paid_tool_root_revalidations;op pactwoven.paid_tool_operations;deadline timestamptz;BEGIN
 PERFORM pactwoven.paid_tool_require(a.quote_id IS NOT NULL AND a.instruction_revision=pactwoven.native_instruction_revision('development',a.organization_id,a.root_task_id));
 SELECT * INTO v FROM pactwoven.paid_tool_root_revalidations WHERE(organization_id,root_task_id,instruction_revision,refresh_epoch)=(a.organization_id,a.root_task_id,a.instruction_revision,pactwoven.native_delegation_refresh_epoch('development',a.organization_id,a.root_task_id)) ORDER BY generation DESC LIMIT 1;
 IF NOT FOUND THEN RETURN pactwoven.paid_tool_root_sources_before_revalidation(a,until_at);END IF;
 SELECT * INTO op FROM pactwoven.paid_tool_operations WHERE(id,quote_id)=(v.operation_id,v.quote_id);
 PERFORM pactwoven.paid_tool_require(v.quote_id=a.quote_id AND v.identity=a.identity AND pactwoven.paid_tool_root_revalidation_record(v)
  AND op.status='completed' AND op.revoked_at IS NULL AND op.delivery->>'resultHash'=v.result_hash AND op.delivery->>'paymentSignature'=op.payment->>'signature');
 deadline:=pactwoven.native_delegation_root_receipts(v.context_binding||jsonb_build_object('validUntil',pactwoven.mandate_instant(until_at)),v.input_receipts);
 PERFORM pactwoven.native_memory_require(v.data_valid_until>clock_timestamp() AND until_at>clock_timestamp(),'NM008');RETURN least(deadline,v.data_valid_until,until_at);END $$;
CREATE OR REPLACE FUNCTION pactwoven.paid_tool_root_ready(r pactwoven.native_delegation_root_runs) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT NOT EXISTS(SELECT 1 FROM pactwoven.paid_tool_root_attachments a JOIN pactwoven.paid_tool_quotes q ON q.id=a.quote_id LEFT JOIN pactwoven.paid_tool_operations op ON op.quote_id=a.quote_id
  WHERE(r.environment,a.organization_id,a.root_task_id,a.instruction_revision)=('development',r.organization_id,r.root_task_id,pactwoven.native_instruction_revision(r.environment,r.organization_id,r.root_task_id))
  AND ((a.data_valid_until>clock_timestamp() AND q.expires_at>clock_timestamp()) OR pactwoven.paid_tool_root_settlement_pending(op))
  AND(op.id IS NULL OR(op.status NOT IN('completed','cancelled') AND op.revoked_at IS NULL))) $$;
CREATE OR REPLACE FUNCTION pactwoven.paid_tool_root_read(selector jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE ctx jsonb;a pactwoven.paid_tool_root_attachments;op pactwoven.paid_tool_operations;quote pactwoven.paid_tool_quotes;revision integer;state text;BEGIN
 ctx:=pactwoven.native_delegation_root_context('development',selector,true);revision:=pactwoven.native_instruction_revision('development',selector->>'organizationId',selector->>'taskId');
 SELECT * INTO a FROM pactwoven.paid_tool_root_attachments WHERE(organization_id,root_task_id,instruction_revision)=(selector->>'organizationId',selector->>'taskId',revision);
 IF a.quote_id IS NULL THEN RETURN jsonb_build_object('kind','none','rootTaskId',selector->>'taskId','instructionRevision',revision);END IF;
 SELECT * INTO op FROM pactwoven.paid_tool_operations WHERE quote_id=a.quote_id;SELECT * INTO quote FROM pactwoven.paid_tool_quotes WHERE id=a.quote_id;
 state:=CASE WHEN op.status='cancelled' OR op.revoked_at IS NOT NULL THEN 'unavailable' WHEN op.status='completed' AND op.delivery IS NOT NULL THEN 'ready' WHEN quote.expires_at<=clock_timestamp() AND NOT coalesce((op.attempt IS NOT NULL AND op.status IN('submitting','payment_pending','payment_confirmed','outcome_unknown')
   AND EXISTS(SELECT 1 FROM pactwoven.paid_tool_commands sent
    WHERE sent.operation_id=op.id AND sent.body->>'operationId'=op.id AND sent.body->>'kind'='prepare_broadcast'
     AND sent.command_hash=pactwoven.native_delegation_hash(jsonb_build_object('namespace','pactwoven.paid-tool-command.v1','command',sent.body))
     AND sent.body->>'commandKey'=sent.command_key AND sent.receipt->>'commandKey'=sent.command_key
     AND sent.receipt->>'commandHash'=sent.command_hash AND sent.receipt->>'status'='submitting'
     AND CASE WHEN jsonb_typeof(sent.body->'expectedVersion')='number' AND jsonb_typeof(sent.receipt->'previousVersion')='number' AND jsonb_typeof(sent.receipt->'version')='number'
      AND sent.body->>'expectedVersion' ~ '^[1-9][0-9]{0,14}$' AND sent.receipt->>'previousVersion' ~ '^[1-9][0-9]{0,14}$' AND sent.receipt->>'version' ~ '^[1-9][0-9]{0,14}$'
      THEN (sent.body->>'expectedVersion')::bigint=(sent.receipt->>'previousVersion')::bigint AND (sent.receipt->>'version')::bigint=(sent.receipt->>'previousVersion')::bigint+1 AND (sent.receipt->>'version')::bigint<=op.version ELSE false END)),false) THEN 'unavailable' ELSE 'waiting' END;
 BEGIN PERFORM pactwoven.paid_tool_root_sources(a,pactwoven.supplier_time(ctx->'validUntil'));EXCEPTION WHEN SQLSTATE 'NM001' OR SQLSTATE 'NM005' OR SQLSTATE 'NM006' OR SQLSTATE 'NM007' OR SQLSTATE 'NM008' OR SQLSTATE 'NM009' OR SQLSTATE 'ND001' OR SQLSTATE 'PT004' THEN state:='unavailable';END;
 RETURN jsonb_build_object('kind',state,'rootTaskId',a.root_task_id,'instructionRevision',revision,'quoteId',a.quote_id,'operationId',op.id,'dataValidUntil',pactwoven.mandate_instant(pactwoven.paid_tool_root_data_until(a)));END $$;
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
  state:=CASE WHEN op.status='cancelled' OR op.revoked_at IS NOT NULL THEN 'unavailable' WHEN op.status='completed' AND op.delivery IS NOT NULL THEN 'ready' WHEN q.expires_at<=clock_timestamp() AND NOT coalesce((op.attempt IS NOT NULL AND op.status IN('submitting','payment_pending','payment_confirmed','outcome_unknown')
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
 PERFORM pactwoven.native_memory_notes_deadline(ctx);RETURN jsonb_build_object('rootTaskId',root,'instructionRevision',revision,'evidenceAvailable',available,'policy',pactwoven.paid_tool_root_policy_body(r.organization_id,root,revision),'attachment',CASE WHEN a.quote_id IS NULL THEN NULL ELSE jsonb_build_object('quoteId',a.quote_id,'operationId',op.id,'paymentStatus',op.status,'status',state,'dataValidUntil',pactwoven.mandate_instant(pactwoven.paid_tool_root_data_until(a))) END);END $$;
CREATE OR REPLACE FUNCTION pactwoven.paid_tool_root_consume(selector jsonb,q jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE ctx jsonb;a pactwoven.paid_tool_root_attachments;op pactwoven.paid_tool_operations;p pactwoven.paid_tool_root_purchases;deadline timestamptz;answer jsonb;envelope jsonb;BEGIN
 PERFORM pactwoven.paid_tool_keys(q,ARRAY['schemaVersion','expectedInstructionRevision','expectedRefreshEpoch','quoteId','requestKey']);PERFORM pactwoven.paid_tool_require(q->>'schemaVersion'='1' AND q->>'requestKey' ~ '^[A-Za-z0-9_-]{16,128}$');
 envelope:=jsonb_build_object('schemaVersion',3,'expectedInstructionRevision',q->'expectedInstructionRevision','expectedRefreshEpoch',q->'expectedRefreshEpoch','command','{}'::jsonb);
 PERFORM pactwoven.native_instruction_fence('development',selector,envelope);ctx:=pactwoven.native_delegation_root_context('development',selector,true);
 SELECT * INTO a FROM pactwoven.paid_tool_root_attachments WHERE(organization_id,root_task_id,instruction_revision,quote_id)=(selector->>'organizationId',selector->>'taskId',(q->>'expectedInstructionRevision')::integer,q->>'quoteId');
 deadline:=pactwoven.paid_tool_root_sources(a,pactwoven.supplier_time(ctx->'validUntil'));
 SELECT * INTO op FROM pactwoven.paid_tool_operations WHERE quote_id=a.quote_id FOR SHARE;
 PERFORM pactwoven.paid_tool_require(op.status='completed' AND op.revoked_at IS NULL AND op.payment IS NOT NULL AND op.delivery IS NOT NULL AND op.delivery->>'paymentSignature'=op.payment->>'signature');
 SELECT * INTO p FROM pactwoven.paid_tool_root_purchases WHERE(organization_id,root_task_id,generation)=(a.organization_id,a.root_task_id,(selector->>'generation')::bigint);
 IF FOUND THEN PERFORM pactwoven.paid_tool_require(p.body=q);RETURN p.response;END IF;
 answer:=jsonb_build_object('rootTaskId',a.root_task_id,'instructionRevision',a.instruction_revision,'generation',selector->'generation','quoteId',a.quote_id,'operationId',op.id,'requestKey',q->>'requestKey','resultHash',op.delivery->>'resultHash','paymentSignature',op.payment->>'signature','artifactRef',op.delivery->>'artifactRef','resultBody',op.delivery->'resultBody','paidRecord',(SELECT jsonb_build_object('snapshot',pactwoven.paid_tool_snapshot(op),'quote',quote.body,'requestBody',quote.request_body,'resourceBody',quote.resource_body,'wireBase64',NULL,'receipt',NULL) FROM pactwoven.paid_tool_quotes quote WHERE quote.id=a.quote_id),'dataValidUntil',pactwoven.mandate_instant(pactwoven.paid_tool_root_data_until(a)));
 INSERT INTO pactwoven.paid_tool_root_purchases VALUES(a.organization_id,a.root_task_id,(selector->>'generation')::bigint,a.quote_id,a.instruction_revision,q->>'requestKey',q,answer,clock_timestamp());
 PERFORM pactwoven.native_memory_require(deadline>clock_timestamp(),'NM008');RETURN answer;END $$;
CREATE OR REPLACE FUNCTION pactwoven.paid_tool_root_completion_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a pactwoven.paid_tool_root_attachments;p pactwoven.paid_tool_root_purchases;op pactwoven.paid_tool_operations;deadline timestamptz;BEGIN
 IF NEW.publication#>>'{result,outcome}'='blocked' THEN RETURN NEW;END IF;
 SELECT * INTO a FROM pactwoven.paid_tool_root_attachments WHERE(organization_id,root_task_id,instruction_revision)=(NEW.organization_id,NEW.root_task_id,pactwoven.native_instruction_revision(NEW.environment,NEW.organization_id,NEW.root_task_id));
 IF a.quote_id IS NULL THEN RETURN NEW;END IF;
 SELECT * INTO p FROM pactwoven.paid_tool_root_purchases WHERE(organization_id,root_task_id,generation,quote_id)=(NEW.organization_id,NEW.root_task_id,NEW.generation,a.quote_id);
 SELECT * INTO op FROM pactwoven.paid_tool_operations WHERE quote_id=a.quote_id;
 PERFORM pactwoven.paid_tool_require(p.root_task_id IS NOT NULL AND op.status='completed' AND p.response->>'operationId'=op.id AND p.response->>'resultHash'=op.delivery->>'resultHash' AND p.response->>'paymentSignature'=op.payment->>'signature');
 deadline:=pactwoven.paid_tool_root_sources(a,least(pactwoven.paid_tool_root_data_until(a),pactwoven.supplier_time(NEW.publication#>'{result,evidenceValidUntil}')));
 PERFORM pactwoven.native_memory_require(pactwoven.supplier_time(NEW.publication#>'{result,evidenceValidUntil}')<=deadline,'NM008');RETURN NEW;END $$;
CREATE OR REPLACE FUNCTION pactwoven.paid_tool_root_quote(actor jsonb,root text,site text,qid text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE ctx jsonb;a pactwoven.paid_tool_root_attachments;q pactwoven.paid_tool_quotes;r pactwoven.native_delegation_root_runs;g pactwoven.native_delegation_grants;t pactwoven.native_delegation_tasks;selection jsonb;BEGIN
 PERFORM pactwoven.paid_tool_principal(ARRAY['api']);PERFORM pactwoven.paid_tool_require(actor->>'environment'='development');ctx:=pactwoven.native_instruction_actor(actor,root,site,false);
 SELECT * INTO r FROM pactwoven.native_delegation_root_runs WHERE(environment,organization_id,root_task_id)=('development',actor->>'organizationId',root);g:=pactwoven.native_delegation_grant_locked('development',r.organization_id,r.grant_id);
 SELECT * INTO a FROM pactwoven.paid_tool_root_attachments WHERE(organization_id,root_task_id,instruction_revision,quote_id,site_id,actor_id)=(r.organization_id,root,pactwoven.native_instruction_revision('development',r.organization_id,root),qid,site,actor->>'actorId');
 SELECT * INTO t FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=('development',r.organization_id,root);PERFORM pactwoven.paid_tool_root_sources(a,least(t.deadline_at,pactwoven.supplier_time(g.body->'expiresAt'),pactwoven.native_memory_time(ctx->'validUntil')));
 SELECT * INTO q FROM pactwoven.paid_tool_quotes WHERE id=a.quote_id;PERFORM pactwoven.paid_tool_require(octet_length(q.request_body::text)<1000 AND octet_length(q.resource_body::text)<16000);
 SELECT v.selection INTO selection FROM pactwoven.paid_tool_root_revalidations v WHERE(v.organization_id,v.root_task_id,v.instruction_revision,v.refresh_epoch)=(a.organization_id,a.root_task_id,a.instruction_revision,pactwoven.native_delegation_refresh_epoch('development',a.organization_id,a.root_task_id)) ORDER BY v.generation DESC LIMIT 1;selection:=coalesce(selection,a.selection);
 PERFORM pactwoven.native_memory_notes_deadline(ctx);RETURN jsonb_build_object('rootTaskId',root,'quoteId',a.quote_id,'instructionRevision',a.instruction_revision,'quote',q.body,'requestBody',q.request_body,'resourceBody',q.resource_body,'reason',selection->>'reason','assumptions',selection->'assumptions');END $$;
DO $$ DECLARE t text;owner name:=current_user;f record;BEGIN
 FOREACH t IN ARRAY ARRAY['paid_tool_root_revalidations','paid_tool_root_revalidation_parks'] LOOP
  EXECUTE format('ALTER TABLE pactwoven.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE pactwoven.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY paid_tool_revalidation_owner ON pactwoven.%I TO %I USING(true) WITH CHECK(true)',t,owner);
  EXECUTE format('REVOKE ALL ON pactwoven.%I FROM PUBLIC,pactwoven_runtime,pactwoven_native_delegation_coordinator,pactwoven_paid_tool_api,pactwoven_paid_tool_policy,pactwoven_paid_tool_signer,pactwoven_paid_tool_broadcaster,pactwoven_paid_tool_observer,pactwoven_paid_tool_delivery',t);
  EXECUTE format('CREATE TRIGGER paid_tool_revalidation_immutable BEFORE UPDATE OR DELETE ON pactwoven.%I FOR EACH ROW EXECUTE FUNCTION pactwoven.paid_tool_immutable()',t);
 END LOOP;
 FOR f IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace='pactwoven'::regnamespace AND (proname LIKE 'paid_tool_root_revalidat%' OR proname IN('paid_tool_root_sources','paid_tool_root_sources_before_revalidation','paid_tool_root_data_until','paid_tool_root_settlement_pending')) LOOP
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,pactwoven_runtime,pactwoven_native_delegation_coordinator,pactwoven_paid_tool_api,pactwoven_paid_tool_policy,pactwoven_paid_tool_signer,pactwoven_paid_tool_broadcaster,pactwoven_paid_tool_observer,pactwoven_paid_tool_delivery',f.signature);END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION pactwoven.paid_tool_root_revalidation(jsonb),pactwoven.paid_tool_root_revalidate(jsonb,jsonb),pactwoven.paid_tool_root_revalidation_park(jsonb,jsonb) TO pactwoven_native_delegation_coordinator;
COMMIT;
