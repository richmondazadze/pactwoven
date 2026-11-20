BEGIN;
CREATE TABLE pactwoven.paid_tool_root_policies(organization_id text NOT NULL,root_task_id text NOT NULL,instruction_revision integer NOT NULL,actor_id text NOT NULL,site_id text NOT NULL,request_key text NOT NULL,body jsonb NOT NULL,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(organization_id,root_task_id,instruction_revision));
CREATE FUNCTION pactwoven.paid_tool_root_policy_body(o text,r text,v integer) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT coalesce((SELECT jsonb_build_object('enabled',true,'rootTaskId',r,'instructionRevision',v,'maximumComputationBaseUnits',body->>'maximumComputationBaseUnits','maximumFeeLamports',body->>'maximumFeeLamports','authorization','separate_quote_required') FROM pactwoven.paid_tool_root_policies WHERE(organization_id,root_task_id,instruction_revision)=(o,r,v)),jsonb_build_object('enabled',false,'rootTaskId',r,'instructionRevision',v)) $$;
CREATE FUNCTION pactwoven.paid_tool_root_bind_policy(actor jsonb,q jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE ctx jsonb;r pactwoven.native_delegation_root_runs;t pactwoven.native_delegation_tasks;p pactwoven.paid_tool_root_policies;BEGIN
 PERFORM pactwoven.paid_tool_principal(ARRAY['api']);PERFORM pactwoven.paid_tool_keys(q,ARRAY['rootTaskId','siteId','instructionRevision','requestKey','maximumComputationBaseUnits','maximumFeeLamports','authorization']);
 PERFORM pactwoven.paid_tool_require(actor->>'environment'='development' AND actor->>'principalKind'='human' AND q->>'authorization'='separate_quote_required' AND q->>'requestKey' ~ '^[A-Za-z0-9_-]{16,128}$' AND pactwoven.paid_tool_units(q->>'maximumComputationBaseUnits')>0 AND pactwoven.paid_tool_units(q->>'maximumFeeLamports')>0);
 ctx:=pactwoven.native_instruction_actor(actor,q->>'rootTaskId',q->>'siteId',true);
 SELECT * INTO r FROM pactwoven.native_delegation_root_runs WHERE(environment,organization_id,root_task_id,actor_id)=('development',actor->>'organizationId',q->>'rootTaskId',actor->>'actorId');
 PERFORM pactwoven.paid_tool_require(r.root_task_id IS NOT NULL);PERFORM pactwoven.native_delegation_grant_locked('development',r.organization_id,r.grant_id);
 SELECT * INTO p FROM pactwoven.paid_tool_root_policies WHERE(organization_id,root_task_id,instruction_revision)=(r.organization_id,r.root_task_id,(q->>'instructionRevision')::integer);
 IF FOUND THEN PERFORM pactwoven.paid_tool_require(p.actor_id=actor->>'actorId' AND p.body=q);RETURN pactwoven.paid_tool_root_policy_body(r.organization_id,r.root_task_id,p.instruction_revision);END IF;
 SELECT * INTO r FROM pactwoven.native_delegation_root_runs WHERE(environment,organization_id,root_task_id)=('development',r.organization_id,r.root_task_id) FOR UPDATE;
 SELECT * INTO t FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=('development',r.organization_id,r.root_task_id);
 PERFORM pactwoven.paid_tool_require(r.phase='ready' AND r.checkpoint_version=0 AND t.state='ready' AND t.lease_token IS NULL AND(q->>'instructionRevision')::integer=pactwoven.native_instruction_revision('development',r.organization_id,r.root_task_id));
 INSERT INTO pactwoven.paid_tool_root_policies VALUES(r.organization_id,r.root_task_id,(q->>'instructionRevision')::integer,r.actor_id,r.site_id,q->>'requestKey',q,clock_timestamp());
 PERFORM pactwoven.native_memory_notes_deadline(ctx);RETURN pactwoven.paid_tool_root_policy_body(r.organization_id,r.root_task_id,(q->>'instructionRevision')::integer);END $$;
CREATE FUNCTION pactwoven.paid_tool_root_policy(selector jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 PERFORM pactwoven.native_delegation_root_context('development',selector,true);RETURN pactwoven.paid_tool_root_policy_body(selector->>'organizationId',selector->>'taskId',pactwoven.native_instruction_revision('development',selector->>'organizationId',selector->>'taskId'));END $$;
CREATE TABLE pactwoven.paid_tool_root_attachments(
 organization_id text NOT NULL,root_task_id text NOT NULL,instruction_revision integer NOT NULL,
 quote_id text NOT NULL UNIQUE REFERENCES pactwoven.paid_tool_quotes,selection jsonb NOT NULL,selection_hash text NOT NULL,site_id text NOT NULL,actor_id text NOT NULL,
 generation bigint NOT NULL,identity jsonb NOT NULL,context_binding jsonb NOT NULL,input_receipts jsonb NOT NULL,
 data_valid_until timestamptz NOT NULL,attached_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organization_id,root_task_id,instruction_revision));
CREATE TABLE pactwoven.paid_tool_root_waits(
 organization_id text NOT NULL,root_task_id text NOT NULL,request_key text NOT NULL,generation bigint NOT NULL,
 identity jsonb NOT NULL,body jsonb NOT NULL,response jsonb NOT NULL,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organization_id,root_task_id,request_key));
CREATE TABLE pactwoven.paid_tool_root_purchases(
 organization_id text NOT NULL,root_task_id text NOT NULL,generation bigint NOT NULL,quote_id text NOT NULL,
 instruction_revision integer NOT NULL,request_key text NOT NULL,body jsonb NOT NULL,response jsonb NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(organization_id,root_task_id,generation),
 UNIQUE(organization_id,root_task_id,request_key),FOREIGN KEY(quote_id) REFERENCES pactwoven.paid_tool_root_attachments(quote_id));
-- Validates the original accepted-result closure without reinterpreting prose.
CREATE FUNCTION pactwoven.paid_tool_root_sources(a pactwoven.paid_tool_root_attachments,until_at timestamptz) RETURNS timestamptz
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE deadline timestamptz;BEGIN
 PERFORM pactwoven.paid_tool_require(a.quote_id IS NOT NULL AND a.instruction_revision=pactwoven.native_instruction_revision('development',a.organization_id,a.root_task_id));
 deadline:=pactwoven.native_delegation_root_receipts(a.context_binding||jsonb_build_object('validUntil',pactwoven.mandate_instant(until_at)),a.input_receipts);
 PERFORM pactwoven.native_memory_require(a.data_valid_until>clock_timestamp() AND until_at>clock_timestamp(),'NM008');RETURN least(deadline,a.data_valid_until,until_at);END $$;
CREATE FUNCTION pactwoven.paid_tool_root_ready(r pactwoven.native_delegation_root_runs) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT NOT EXISTS(SELECT 1 FROM pactwoven.paid_tool_root_attachments a
  JOIN pactwoven.paid_tool_quotes q ON q.id=a.quote_id LEFT JOIN pactwoven.paid_tool_operations op ON op.quote_id=a.quote_id
  WHERE(r.environment,a.organization_id,a.root_task_id,a.instruction_revision)=('development',r.organization_id,r.root_task_id,pactwoven.native_instruction_revision(r.environment,r.organization_id,r.root_task_id))
  AND a.data_valid_until>clock_timestamp() AND q.expires_at>clock_timestamp()
  AND(op.id IS NULL OR(op.status NOT IN('completed','cancelled') AND op.revoked_at IS NULL))) $$;
ALTER FUNCTION pactwoven.native_delegation_root_wait_ready(pactwoven.native_delegation_root_runs) RENAME TO native_delegation_root_wait_ready_before_paid;
CREATE FUNCTION pactwoven.native_delegation_root_wait_ready(r pactwoven.native_delegation_root_runs) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT pactwoven.native_delegation_root_wait_ready_before_paid(r) AND pactwoven.paid_tool_root_ready(r) $$;
CREATE FUNCTION pactwoven.paid_tool_root_wait(selector jsonb,q jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE ctx jsonb;identity jsonb;t pactwoven.native_delegation_tasks;r pactwoven.native_delegation_root_runs;
 a pactwoven.paid_tool_root_attachments;quote pactwoven.paid_tool_quotes;prior pactwoven.paid_tool_root_waits;
 checkpoint jsonb;answer jsonb;envelope jsonb;deadline timestamptz;revision integer;selection jsonb;support jsonb;BEGIN
 PERFORM pactwoven.paid_tool_keys(q,ARRAY['schemaVersion','expectedInstructionRevision','expectedRefreshEpoch','quoteId','selection','checkpoint']);
 PERFORM pactwoven.paid_tool_require(q->>'schemaVersion'='1');identity:=pactwoven.native_delegation_service('development',ARRAY['coordinator']);
 PERFORM pactwoven.native_delegation_target(selector,true);SELECT * INTO t FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=('development',selector->>'organizationId',selector->>'taskId');
 PERFORM pactwoven.paid_tool_require(t.depth=0 AND t.identity=identity);PERFORM pactwoven.native_delegation_grant_locked('development',t.organization_id,t.grant_id);
 SELECT * INTO prior FROM pactwoven.paid_tool_root_waits WHERE(organization_id,root_task_id,request_key)=(t.organization_id,t.id,q#>>'{checkpoint,requestKey}');
 IF FOUND THEN PERFORM pactwoven.paid_tool_require(prior.body=q AND prior.identity=identity AND prior.generation=(selector->>'generation')::bigint);RETURN prior.response;END IF;
 envelope:=jsonb_build_object('schemaVersion',3,'expectedInstructionRevision',q->'expectedInstructionRevision','expectedRefreshEpoch',q->'expectedRefreshEpoch','command',q->'checkpoint');
 revision:=pactwoven.native_instruction_fence('development',selector,envelope);ctx:=pactwoven.native_delegation_root_context('development',selector,true);
 SELECT * INTO r FROM pactwoven.native_delegation_root_runs WHERE(environment,organization_id,root_task_id)=('development',t.organization_id,t.id);
 SELECT * INTO quote FROM pactwoven.paid_tool_quotes WHERE id=q->>'quoteId';
 PERFORM pactwoven.paid_tool_require((quote.organization_id,quote.root_task_id,quote.site_id,quote.instruction_revision)=(t.organization_id,t.id,r.site_id,revision) AND EXISTS(SELECT 1 FROM pactwoven.paid_tool_root_policies p WHERE(p.organization_id,p.root_task_id,p.instruction_revision)=(t.organization_id,t.id,revision) AND pactwoven.paid_tool_units(quote.body#>>'{challenge,amountBaseUnits}')<=pactwoven.paid_tool_units(p.body->>'maximumComputationBaseUnits')));
 SELECT * INTO a FROM pactwoven.paid_tool_root_attachments WHERE(organization_id,root_task_id,instruction_revision)=(t.organization_id,t.id,revision);
 IF a.quote_id IS NULL THEN
  PERFORM pactwoven.paid_tool_require(jsonb_array_length(q#>'{checkpoint,inputReceipts}')>0 AND quote.expires_at>clock_timestamp());
  deadline:=pactwoven.native_delegation_root_receipts(ctx,q#>'{checkpoint,inputReceipts}');
  selection:=q#>'{selection,candidate}';
  PERFORM pactwoven.paid_tool_require(q#>>'{selection,selectionHash}'=pactwoven.native_delegation_hash(jsonb_build_object('namespace','pactwoven.equipment-selection.v1','candidate',selection)) AND selection->>'schemaVersion'='1' AND selection->>'kind'='equipment_service_selection' AND selection->>'authority'='none' AND selection->>'serviceId'='equipment_optimizer_v1' AND selection->>'decision'='use_service'
   AND(selection#>>'{scope,organizationId}',selection#>>'{scope,rootTaskId}',selection#>>'{scope,siteId}',selection#>>'{scope,instructionRevision}')=(t.organization_id,t.id,r.site_id,revision::text)
   AND selection->'request'=quote.request_body AND selection->>'requestHash'=quote.body#>>'{request,hash}' AND selection->>'resourceHash'=quote.body#>>'{resource,hash}'
   AND q#>'{checkpoint,inputReceipts}' @> jsonb_build_array(selection->'inputReceipt') AND jsonb_array_length(selection->'supportingArtifacts') BETWEEN 1 AND 16);
  FOR support IN SELECT value FROM jsonb_array_elements(selection->'supportingArtifacts') LOOP
   PERFORM pactwoven.paid_tool_require(EXISTS(SELECT 1 FROM pactwoven.native_delegation_root_inputs i,jsonb_array_elements(i.body->'results') result,jsonb_array_elements(result->'artifacts') artifact
    WHERE(i.environment,i.organization_id,i.root_task_id,i.generation)=('development',t.organization_id,t.id,t.generation) AND i.id::text=selection#>>'{inputReceipt,receiptId}' AND i.digest=selection#>>'{inputReceipt,digest}'
     AND(artifact#>>'{reference,artifactId}',artifact#>>'{reference,digest}',artifact#>>'{body,role}')=(support->>'artifactId',support->>'digest',support->>'role')));
  END LOOP;

  PERFORM pactwoven.paid_tool_require(EXISTS(SELECT 1 FROM pactwoven.native_delegation_root_inputs i,jsonb_array_elements(i.body->'results') result
   WHERE(i.environment,i.organization_id,i.root_task_id,i.generation)=('development',t.organization_id,t.id,t.generation) AND result->>'outcome'='advice_ready'));
  INSERT INTO pactwoven.paid_tool_root_attachments VALUES(t.organization_id,t.id,revision,quote.id,selection,q#>>'{selection,selectionHash}',r.site_id,r.actor_id,t.generation,identity,ctx-'validUntil',q#>'{checkpoint,inputReceipts}',least(deadline,t.deadline_at,pactwoven.supplier_time((SELECT body->'expiresAt' FROM pactwoven.native_delegation_grants WHERE(environment,organization_id,id)=('development',t.organization_id,t.grant_id)))),clock_timestamp()) RETURNING * INTO a;
 ELSE PERFORM pactwoven.paid_tool_require(a.quote_id=quote.id AND a.identity=identity AND(q->'selection'='null'::jsonb OR(q#>'{selection,candidate}'=a.selection AND q#>>'{selection,selectionHash}'=a.selection_hash)));PERFORM pactwoven.paid_tool_root_sources(a,pactwoven.supplier_time(ctx->'validUntil'));END IF;
 checkpoint:=pactwoven.native_instruction_command('development',selector,envelope,'checkpoint')->'receipt';
 -- Same task and lifetime. No child is invented and no payment is authorized here.
 UPDATE pactwoven.native_delegation_root_runs SET phase='waiting_children',wait_for='{}',updated_at=clock_timestamp() WHERE(environment,organization_id,root_task_id)=('development',t.organization_id,t.id) RETURNING * INTO r;
 UPDATE pactwoven.native_delegation_tasks SET generation=generation+1,lease_token=NULL,lease_until=NULL WHERE(environment,organization_id,id)=('development',t.organization_id,t.id) RETURNING * INTO t;
 UPDATE pactwoven.native_delegation_proofs SET verdict='unknown',valid_until=NULL,nonce=NULL,nonce_barrier=NULL,prepared_at=NULL,deadline_at=NULL,barrier=barrier+1 WHERE(environment,organization_id,task_id)=('development',t.organization_id,t.id);
 UPDATE pactwoven.native_delegation_outbox SET state='suppressed',token=NULL,lease_until=NULL WHERE(environment,organization_id,task_id)=('development',t.organization_id,t.id);
 IF pactwoven.native_delegation_root_wait_ready(r) THEN PERFORM pactwoven.native_delegation_root_wake('development',t.organization_id,t.id,t.generation);END IF;
 checkpoint:=checkpoint||jsonb_build_object('generation',t.generation,'continuation','waiting_children');
 answer:=jsonb_build_object('rootTaskId',t.id,'quoteId',a.quote_id,'instructionRevision',revision,'checkpoint',checkpoint);
 INSERT INTO pactwoven.paid_tool_root_waits VALUES(t.organization_id,t.id,q#>>'{checkpoint,requestKey}',(selector->>'generation')::bigint,identity,q,answer,clock_timestamp());
 PERFORM pactwoven.native_memory_require(pactwoven.supplier_time(ctx->'validUntil')>clock_timestamp(),'NM008');RETURN answer;END $$;
CREATE FUNCTION pactwoven.paid_tool_root_read(selector jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE ctx jsonb;a pactwoven.paid_tool_root_attachments;op pactwoven.paid_tool_operations;quote pactwoven.paid_tool_quotes;revision integer;state text;BEGIN
 ctx:=pactwoven.native_delegation_root_context('development',selector,true);revision:=pactwoven.native_instruction_revision('development',selector->>'organizationId',selector->>'taskId');
 SELECT * INTO a FROM pactwoven.paid_tool_root_attachments WHERE(organization_id,root_task_id,instruction_revision)=(selector->>'organizationId',selector->>'taskId',revision);
 IF a.quote_id IS NULL THEN RETURN jsonb_build_object('kind','none','rootTaskId',selector->>'taskId','instructionRevision',revision);END IF;
 SELECT * INTO op FROM pactwoven.paid_tool_operations WHERE quote_id=a.quote_id;SELECT * INTO quote FROM pactwoven.paid_tool_quotes WHERE id=a.quote_id;
 state:=CASE WHEN op.status='completed' AND op.delivery IS NOT NULL THEN 'ready' WHEN op.status='cancelled' OR op.revoked_at IS NOT NULL OR quote.expires_at<=clock_timestamp() THEN 'unavailable' ELSE 'waiting' END;
 BEGIN PERFORM pactwoven.paid_tool_root_sources(a,pactwoven.supplier_time(ctx->'validUntil'));EXCEPTION WHEN SQLSTATE 'NM001' OR SQLSTATE 'NM005' OR SQLSTATE 'NM006' OR SQLSTATE 'NM007' OR SQLSTATE 'NM008' OR SQLSTATE 'NM009' OR SQLSTATE 'ND001' OR SQLSTATE 'PT004' THEN state:='unavailable';END;
 RETURN jsonb_build_object('kind',state,'rootTaskId',a.root_task_id,'instructionRevision',revision,'quoteId',a.quote_id,'operationId',op.id,'dataValidUntil',pactwoven.mandate_instant(a.data_valid_until));END $$;
CREATE FUNCTION pactwoven.paid_tool_root_consume(selector jsonb,q jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE ctx jsonb;a pactwoven.paid_tool_root_attachments;op pactwoven.paid_tool_operations;p pactwoven.paid_tool_root_purchases;deadline timestamptz;answer jsonb;envelope jsonb;BEGIN
 PERFORM pactwoven.paid_tool_keys(q,ARRAY['schemaVersion','expectedInstructionRevision','expectedRefreshEpoch','quoteId','requestKey']);PERFORM pactwoven.paid_tool_require(q->>'schemaVersion'='1' AND q->>'requestKey' ~ '^[A-Za-z0-9_-]{16,128}$');
 envelope:=jsonb_build_object('schemaVersion',3,'expectedInstructionRevision',q->'expectedInstructionRevision','expectedRefreshEpoch',q->'expectedRefreshEpoch','command','{}'::jsonb);
 PERFORM pactwoven.native_instruction_fence('development',selector,envelope);ctx:=pactwoven.native_delegation_root_context('development',selector,true);
 SELECT * INTO a FROM pactwoven.paid_tool_root_attachments WHERE(organization_id,root_task_id,instruction_revision,quote_id)=(selector->>'organizationId',selector->>'taskId',(q->>'expectedInstructionRevision')::integer,q->>'quoteId');
 deadline:=pactwoven.paid_tool_root_sources(a,pactwoven.supplier_time(ctx->'validUntil'));
 SELECT * INTO op FROM pactwoven.paid_tool_operations WHERE quote_id=a.quote_id FOR SHARE;
 PERFORM pactwoven.paid_tool_require(op.status='completed' AND op.payment IS NOT NULL AND op.delivery IS NOT NULL AND op.delivery->>'paymentSignature'=op.payment->>'signature');
 SELECT * INTO p FROM pactwoven.paid_tool_root_purchases WHERE(organization_id,root_task_id,generation)=(a.organization_id,a.root_task_id,(selector->>'generation')::bigint);
 IF FOUND THEN PERFORM pactwoven.paid_tool_require(p.body=q);RETURN p.response;END IF;
 answer:=jsonb_build_object('rootTaskId',a.root_task_id,'instructionRevision',a.instruction_revision,'generation',selector->'generation','quoteId',a.quote_id,'operationId',op.id,'requestKey',q->>'requestKey','resultHash',op.delivery->>'resultHash','paymentSignature',op.payment->>'signature','artifactRef',op.delivery->>'artifactRef','resultBody',op.delivery->'resultBody','paidRecord',(SELECT jsonb_build_object('snapshot',pactwoven.paid_tool_snapshot(op),'quote',quote.body,'requestBody',quote.request_body,'resourceBody',quote.resource_body,'wireBase64',NULL,'receipt',NULL) FROM pactwoven.paid_tool_quotes quote WHERE quote.id=a.quote_id),'dataValidUntil',pactwoven.mandate_instant(a.data_valid_until));
 INSERT INTO pactwoven.paid_tool_root_purchases VALUES(a.organization_id,a.root_task_id,(selector->>'generation')::bigint,a.quote_id,a.instruction_revision,q->>'requestKey',q,answer,clock_timestamp());
 PERFORM pactwoven.native_memory_require(deadline>clock_timestamp(),'NM008');RETURN answer;END $$;
ALTER FUNCTION pactwoven.paid_tool_locked(pactwoven.paid_tool_reviews,boolean) RENAME TO paid_tool_locked_before_root_purchase;
CREATE FUNCTION pactwoven.paid_tool_locked(r pactwoven.paid_tool_reviews,new_effect boolean) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE a pactwoven.paid_tool_root_attachments;p pactwoven.paid_tool_root_policies;g pactwoven.native_delegation_grants;t pactwoven.native_delegation_tasks;BEGIN
 PERFORM pactwoven.paid_tool_locked_before_root_purchase(r,new_effect);
 IF new_effect THEN
  SELECT * INTO a FROM pactwoven.paid_tool_root_attachments WHERE(organization_id,root_task_id,instruction_revision,quote_id)=(r.organization_id,r.root_task_id,r.instruction_revision,r.quote_id);
  SELECT * INTO p FROM pactwoven.paid_tool_root_policies WHERE(organization_id,root_task_id,instruction_revision)=(r.organization_id,r.root_task_id,r.instruction_revision);
  PERFORM pactwoven.paid_tool_require(a.quote_id IS NOT NULL AND p.root_task_id IS NOT NULL AND pactwoven.paid_tool_units(r.body->>'amountBaseUnits')<=pactwoven.paid_tool_units(p.body->>'maximumComputationBaseUnits') AND r.maximum_fee<=pactwoven.paid_tool_units(p.body->>'maximumFeeLamports'));
  SELECT * INTO t FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=('development',r.organization_id,r.root_task_id);SELECT * INTO g FROM pactwoven.native_delegation_grants WHERE(environment,organization_id,id)=('development',t.organization_id,t.grant_id);
  PERFORM pactwoven.paid_tool_root_sources(a,least(t.deadline_at,pactwoven.supplier_time(g.body->'expiresAt')));
 END IF;END $$;
CREATE FUNCTION pactwoven.paid_tool_root_discover(actor jsonb,root text,site text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
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
  state:=CASE WHEN op.status='completed' AND op.delivery IS NOT NULL THEN 'ready' WHEN op.status='cancelled' OR op.revoked_at IS NOT NULL OR q.expires_at<=clock_timestamp() THEN 'unavailable' ELSE 'waiting' END;
  BEGIN
   PERFORM pactwoven.paid_tool_require(available AND g.body->'revocation'='null'::jsonb);
   PERFORM pactwoven.paid_tool_root_sources(a,least(t.deadline_at,pactwoven.supplier_time(g.body->'expiresAt'),pactwoven.native_memory_time(ctx->'validUntil')));
  EXCEPTION WHEN SQLSTATE 'NM001' OR SQLSTATE 'NM005' OR SQLSTATE 'NM006' OR SQLSTATE 'NM007' OR SQLSTATE 'NM008' OR SQLSTATE 'NM009' OR SQLSTATE 'ND001' OR SQLSTATE 'PT004' THEN available:=false;state:='unavailable';END;
 END IF;
 PERFORM pactwoven.native_memory_notes_deadline(ctx);RETURN jsonb_build_object('rootTaskId',root,'instructionRevision',revision,'evidenceAvailable',available,'policy',pactwoven.paid_tool_root_policy_body(r.organization_id,root,revision),'attachment',CASE WHEN a.quote_id IS NULL THEN NULL ELSE jsonb_build_object('quoteId',a.quote_id,'operationId',op.id,'paymentStatus',op.status,'status',state,'dataValidUntil',pactwoven.mandate_instant(a.data_valid_until)) END);END $$;
CREATE FUNCTION pactwoven.paid_tool_root_quote(actor jsonb,root text,site text,qid text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE ctx jsonb;a pactwoven.paid_tool_root_attachments;q pactwoven.paid_tool_quotes;r pactwoven.native_delegation_root_runs;g pactwoven.native_delegation_grants;t pactwoven.native_delegation_tasks;BEGIN
 PERFORM pactwoven.paid_tool_principal(ARRAY['api']);PERFORM pactwoven.paid_tool_require(actor->>'environment'='development');ctx:=pactwoven.native_instruction_actor(actor,root,site,false);
 SELECT * INTO r FROM pactwoven.native_delegation_root_runs WHERE(environment,organization_id,root_task_id)=('development',actor->>'organizationId',root);g:=pactwoven.native_delegation_grant_locked('development',r.organization_id,r.grant_id);
 SELECT * INTO a FROM pactwoven.paid_tool_root_attachments WHERE(organization_id,root_task_id,instruction_revision,quote_id,site_id,actor_id)=(r.organization_id,root,pactwoven.native_instruction_revision('development',r.organization_id,root),qid,site,actor->>'actorId');
 SELECT * INTO t FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=('development',r.organization_id,root);PERFORM pactwoven.paid_tool_root_sources(a,least(t.deadline_at,pactwoven.supplier_time(g.body->'expiresAt'),pactwoven.native_memory_time(ctx->'validUntil')));
 SELECT * INTO q FROM pactwoven.paid_tool_quotes WHERE id=a.quote_id;PERFORM pactwoven.paid_tool_require(octet_length(q.request_body::text)<1000 AND octet_length(q.resource_body::text)<16000);
 PERFORM pactwoven.native_memory_notes_deadline(ctx);RETURN jsonb_build_object('rootTaskId',root,'quoteId',a.quote_id,'instructionRevision',a.instruction_revision,'quote',q.body,'requestBody',q.request_body,'resourceBody',q.resource_body,'reason',a.selection->>'reason','assumptions',a.selection->'assumptions');END $$;
-- Payment transitions carry their own exact permission. This trigger only wakes
-- the original waiting advisory task after a durable outcome is recorded.
CREATE FUNCTION pactwoven.paid_tool_root_operation_wake() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE a pactwoven.paid_tool_root_attachments;r pactwoven.native_delegation_root_runs;t pactwoven.native_delegation_tasks;BEGIN
 SELECT * INTO a FROM pactwoven.paid_tool_root_attachments WHERE quote_id=NEW.quote_id;
 IF a.quote_id IS NULL THEN RETURN NEW;END IF;
 SELECT * INTO r FROM pactwoven.native_delegation_root_runs WHERE(environment,organization_id,root_task_id)=('development',a.organization_id,a.root_task_id);
 IF r.phase='waiting_children' AND NOT r.manual_paused AND a.instruction_revision=pactwoven.native_instruction_revision('development',a.organization_id,a.root_task_id) AND pactwoven.native_delegation_root_wait_ready(r) THEN
  SELECT * INTO t FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=('development',a.organization_id,a.root_task_id);
  IF t.state='running' AND t.lease_token IS NULL AND t.deadline_at>clock_timestamp() THEN PERFORM pactwoven.native_delegation_root_wake('development',t.organization_id,t.id,t.generation);END IF;
 END IF;RETURN NEW;END $$;
CREATE TRIGGER paid_tool_wake_original_root AFTER UPDATE ON pactwoven.paid_tool_operations FOR EACH ROW WHEN(OLD.status IS DISTINCT FROM NEW.status OR OLD.revoked_at IS DISTINCT FROM NEW.revoked_at) EXECUTE FUNCTION pactwoven.paid_tool_root_operation_wake();
-- All completion entrypoints hit this independent relational guard.
CREATE FUNCTION pactwoven.paid_tool_root_completion_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a pactwoven.paid_tool_root_attachments;p pactwoven.paid_tool_root_purchases;op pactwoven.paid_tool_operations;deadline timestamptz;BEGIN
 IF NEW.publication#>>'{result,outcome}'='blocked' THEN RETURN NEW;END IF;
 SELECT * INTO a FROM pactwoven.paid_tool_root_attachments WHERE(organization_id,root_task_id,instruction_revision)=(NEW.organization_id,NEW.root_task_id,pactwoven.native_instruction_revision(NEW.environment,NEW.organization_id,NEW.root_task_id));
 IF a.quote_id IS NULL THEN RETURN NEW;END IF;
 SELECT * INTO p FROM pactwoven.paid_tool_root_purchases WHERE(organization_id,root_task_id,generation,quote_id)=(NEW.organization_id,NEW.root_task_id,NEW.generation,a.quote_id);
 SELECT * INTO op FROM pactwoven.paid_tool_operations WHERE quote_id=a.quote_id;
 PERFORM pactwoven.paid_tool_require(p.root_task_id IS NOT NULL AND op.status='completed' AND p.response->>'operationId'=op.id AND p.response->>'resultHash'=op.delivery->>'resultHash' AND p.response->>'paymentSignature'=op.payment->>'signature');
 deadline:=pactwoven.paid_tool_root_sources(a,least(a.data_valid_until,pactwoven.supplier_time(NEW.publication#>'{result,evidenceValidUntil}')));
 PERFORM pactwoven.native_memory_require(pactwoven.supplier_time(NEW.publication#>'{result,evidenceValidUntil}')<=deadline,'NM008');RETURN NEW;END $$;
CREATE TRIGGER paid_tool_require_consumed_result BEFORE INSERT ON pactwoven.native_delegation_root_completions FOR EACH ROW EXECUTE FUNCTION pactwoven.paid_tool_root_completion_guard();
DO $$ DECLARE t text;owner name:=current_user;f record;BEGIN
 FOREACH t IN ARRAY ARRAY['paid_tool_root_policies','paid_tool_root_attachments','paid_tool_root_waits','paid_tool_root_purchases'] LOOP
  EXECUTE format('ALTER TABLE pactwoven.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE pactwoven.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY paid_tool_root_owner ON pactwoven.%I TO %I USING(true) WITH CHECK(true)',t,owner);
  EXECUTE format('REVOKE ALL ON pactwoven.%I FROM PUBLIC,pactwoven_runtime,pactwoven_native_delegation_coordinator,pactwoven_paid_tool_api,pactwoven_paid_tool_policy,pactwoven_paid_tool_signer,pactwoven_paid_tool_broadcaster,pactwoven_paid_tool_observer,pactwoven_paid_tool_delivery',t);
  EXECUTE format('CREATE TRIGGER paid_tool_root_immutable BEFORE UPDATE OR DELETE ON pactwoven.%I FOR EACH ROW EXECUTE FUNCTION pactwoven.paid_tool_immutable()',t);
 END LOOP;
 FOR f IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace='pactwoven'::regnamespace AND (proname LIKE 'paid_tool_root_%' OR proname IN('native_delegation_root_wait_ready_before_paid','paid_tool_locked_before_root_purchase')) LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,pactwoven_runtime,pactwoven_native_delegation_coordinator,pactwoven_paid_tool_api,pactwoven_paid_tool_policy,pactwoven_paid_tool_signer,pactwoven_paid_tool_broadcaster,pactwoven_paid_tool_observer,pactwoven_paid_tool_delivery',f.signature);END LOOP;
END $$;
DO $$ DECLARE prior_owner name;BEGIN SELECT pg_get_userbyid(proowner) INTO prior_owner FROM pg_proc WHERE oid='pactwoven.native_delegation_root_wait_ready_before_paid(pactwoven.native_delegation_root_runs)'::regprocedure;EXECUTE format('GRANT EXECUTE ON FUNCTION pactwoven.native_delegation_root_wait_ready(pactwoven.native_delegation_root_runs) TO %I',prior_owner);END $$;
REVOKE ALL ON FUNCTION pactwoven.native_delegation_root_wait_ready(pactwoven.native_delegation_root_runs),pactwoven.paid_tool_locked(pactwoven.paid_tool_reviews,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pactwoven.paid_tool_root_bind_policy(jsonb,jsonb),pactwoven.paid_tool_root_quote(jsonb,text,text,text),pactwoven.paid_tool_root_discover(jsonb,text,text) TO pactwoven_paid_tool_api;
GRANT EXECUTE ON FUNCTION pactwoven.paid_tool_root_wait(jsonb,jsonb),pactwoven.paid_tool_root_read(jsonb),pactwoven.paid_tool_root_consume(jsonb,jsonb),pactwoven.paid_tool_root_policy(jsonb) TO pactwoven_native_delegation_coordinator;
COMMIT;
