BEGIN;
-- Additive durable scheduler. No authority to initiate or establish payment.
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='pactwoven_paid_tool_scheduler') THEN CREATE ROLE pactwoven_paid_tool_scheduler NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;END IF;END $$;
GRANT USAGE ON SCHEMA pactwoven TO pactwoven_paid_tool_scheduler;
ALTER TABLE pactwoven.paid_tool_services DROP CONSTRAINT paid_tool_services_purpose_check;
ALTER TABLE pactwoven.paid_tool_services ADD CONSTRAINT paid_tool_services_purpose_check CHECK(purpose IN('api','policy','signer','broadcaster','observer','delivery','scheduler'));
CREATE FUNCTION pactwoven.paid_tool_pool_binding(purpose text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 PERFORM pactwoven.paid_tool_require(purpose IN('api','policy','signer','broadcaster','observer','delivery','scheduler'));
 PERFORM 1 FROM pactwoven.paid_tool_services s WHERE s.role_name=session_user AND s.purpose=paid_tool_pool_binding.purpose FOR SHARE;
 RETURN pactwoven.paid_tool_principal(ARRAY[purpose])=purpose;END $$;
CREATE TABLE pactwoven.paid_tool_dispatch(operation_id text PRIMARY KEY REFERENCES pactwoven.paid_tool_operations,generation bigint NOT NULL DEFAULT 1 CHECK(generation BETWEEN 1 AND 9007199254740991),operation_version bigint NOT NULL,due_at timestamptz,dispatch_token uuid,dispatch_until timestamptz,dispatch_ready_at timestamptz,published_at timestamptz,lease_token uuid,lease_generation bigint,lease_until timestamptz,lease_operation_version bigint,CHECK((dispatch_token IS NULL)=(dispatch_until IS NULL)),CHECK((dispatch_token IS NULL)=(dispatch_ready_at IS NULL)),CHECK((lease_token IS NULL)=(lease_until IS NULL)),CHECK((lease_token IS NULL)=(lease_generation IS NULL)),CHECK((lease_token IS NULL)=(lease_operation_version IS NULL)));
CREATE INDEX paid_tool_dispatch_due ON pactwoven.paid_tool_dispatch(due_at,operation_id) WHERE due_at IS NOT NULL;
CREATE FUNCTION pactwoven.paid_tool_dispatch_target(q jsonb) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 PERFORM pactwoven.paid_tool_keys(q,ARRAY['operationId','generation']);PERFORM pactwoven.paid_tool_require(q->>'operationId' ~ '^[A-Za-z0-9_-]{1,128}$' AND jsonb_typeof(q->'generation')='number' AND q->>'generation' ~ '^[1-9][0-9]{0,15}$' AND (q->>'generation')::numeric<=9007199254740991);END $$;
CREATE FUNCTION pactwoven.paid_tool_dispatch_operation_wake() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF TG_OP='INSERT' OR (NEW.version,NEW.status,NEW.revoked_at) IS DISTINCT FROM (OLD.version,OLD.status,OLD.revoked_at) THEN
  INSERT INTO pactwoven.paid_tool_dispatch(operation_id,operation_version,due_at) VALUES(NEW.id,NEW.version,CASE WHEN NEW.status IN('completed','cancelled') THEN NULL ELSE clock_timestamp() END)
  ON CONFLICT(operation_id) DO UPDATE SET generation=paid_tool_dispatch.generation+1,operation_version=EXCLUDED.operation_version,due_at=EXCLUDED.due_at,dispatch_token=NULL,dispatch_until=NULL,dispatch_ready_at=NULL,published_at=NULL;
 END IF;RETURN NEW;END $$;
CREATE TRIGGER paid_tool_dispatch_operation_wake AFTER INSERT OR UPDATE ON pactwoven.paid_tool_operations FOR EACH ROW EXECUTE FUNCTION pactwoven.paid_tool_dispatch_operation_wake();
-- Preserve existing operations when upgrading; approval and wake always commit together.
INSERT INTO pactwoven.paid_tool_dispatch(operation_id,operation_version,due_at) SELECT id,version,CASE WHEN status IN('completed','cancelled') THEN NULL ELSE clock_timestamp() END FROM pactwoven.paid_tool_operations;
CREATE FUNCTION pactwoven.paid_tool_dispatch_claim(q jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE item pactwoven.paid_tool_dispatch;result jsonb:='[]';token uuid;BEGIN
 PERFORM pactwoven.paid_tool_principal(ARRAY['scheduler']);PERFORM pactwoven.paid_tool_keys(q,ARRAY['limit','leaseMs']);PERFORM pactwoven.paid_tool_require((q->>'limit') ~ '^[0-9]+$' AND (q->>'limit')::integer BETWEEN 1 AND 20 AND (q->>'leaseMs') ~ '^[0-9]+$' AND (q->>'leaseMs')::integer BETWEEN 1000 AND 60000);
 FOR item IN SELECT * FROM pactwoven.paid_tool_dispatch WHERE due_at<=clock_timestamp()+interval '60 seconds' AND published_at IS NULL AND lease_token IS NULL AND (dispatch_until IS NULL OR dispatch_until<=clock_timestamp()) ORDER BY due_at,operation_id COLLATE "C" LIMIT (q->>'limit')::integer FOR UPDATE SKIP LOCKED LOOP
  token:=gen_random_uuid();UPDATE pactwoven.paid_tool_dispatch SET dispatch_token=token,dispatch_ready_at=item.due_at,dispatch_until=clock_timestamp()+((q->>'leaseMs')::integer*interval '1 millisecond') WHERE operation_id=item.operation_id;
  result:=result||jsonb_build_array(jsonb_build_object('target',jsonb_build_object('operationId',item.operation_id,'generation',item.generation),'dispatchToken',token,'delaySeconds',greatest(0,least(60,ceil(extract(epoch FROM item.due_at-clock_timestamp()))::integer))));
 END LOOP;RETURN result;END $$;
CREATE FUNCTION pactwoven.paid_tool_dispatch_ack(target jsonb,token text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE item pactwoven.paid_tool_dispatch;BEGIN
 PERFORM pactwoven.paid_tool_principal(ARRAY['scheduler']);PERFORM pactwoven.paid_tool_dispatch_target(target);
 SELECT * INTO item FROM pactwoven.paid_tool_dispatch WHERE operation_id=target->>'operationId' FOR UPDATE;
 IF item.operation_id IS NULL OR item.generation<>(target->>'generation')::bigint OR item.dispatch_token IS DISTINCT FROM token::uuid OR item.dispatch_until<=clock_timestamp() OR item.lease_token IS NOT NULL THEN RETURN false;END IF;
 IF item.published_at IS NOT NULL THEN RETURN true;END IF;
 UPDATE pactwoven.paid_tool_dispatch SET published_at=clock_timestamp(),due_at=greatest(item.dispatch_ready_at,clock_timestamp())+interval '30 seconds' WHERE operation_id=item.operation_id;RETURN true;END $$;
CREATE FUNCTION pactwoven.paid_tool_dispatch_consume(target jsonb,q jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE item pactwoven.paid_tool_dispatch;token uuid;BEGIN
 PERFORM pactwoven.paid_tool_principal(ARRAY['scheduler']);PERFORM pactwoven.paid_tool_dispatch_target(target);PERFORM pactwoven.paid_tool_keys(q,ARRAY['leaseMs']);PERFORM pactwoven.paid_tool_require(q->>'leaseMs' ~ '^[0-9]+$' AND (q->>'leaseMs')::integer BETWEEN 1000 AND 120000);
 SELECT * INTO item FROM pactwoven.paid_tool_dispatch WHERE operation_id=target->>'operationId' FOR UPDATE;
 IF item.operation_id IS NULL OR item.generation<>(target->>'generation')::bigint OR item.due_at IS NULL OR item.lease_token IS NOT NULL OR item.dispatch_token IS NULL OR item.dispatch_ready_at>clock_timestamp() THEN RETURN NULL;END IF;
 token:=gen_random_uuid();UPDATE pactwoven.paid_tool_dispatch SET lease_token=token,lease_generation=item.generation,lease_until=clock_timestamp()+((q->>'leaseMs')::integer*interval '1 millisecond'),lease_operation_version=item.operation_version,dispatch_token=NULL,dispatch_until=NULL,dispatch_ready_at=NULL,published_at=NULL WHERE operation_id=item.operation_id;
 RETURN jsonb_build_object('operationId',item.operation_id,'generation',item.generation,'leaseToken',token);END $$;
CREATE FUNCTION pactwoven.paid_tool_dispatch_finish(selector jsonb,q jsonb) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE item pactwoven.paid_tool_dispatch;op pactwoven.paid_tool_operations;next_at timestamptz;BEGIN
 PERFORM pactwoven.paid_tool_principal(ARRAY['scheduler']);PERFORM pactwoven.paid_tool_keys(selector,ARRAY['operationId','generation','leaseToken']);PERFORM pactwoven.paid_tool_dispatch_target(selector-'leaseToken');
 PERFORM pactwoven.paid_tool_keys(q,ARRAY['nextWakeAfterMs','disposition']);PERFORM pactwoven.paid_tool_require(q->>'disposition' IN('advanced','waiting','parked','complete') AND(q->'nextWakeAfterMs'='null'::jsonb OR(q->>'nextWakeAfterMs' ~ '^[0-9]+$' AND(q->>'nextWakeAfterMs')::integer BETWEEN 1000 AND 60000)));
 SELECT * INTO item FROM pactwoven.paid_tool_dispatch WHERE operation_id=selector->>'operationId' FOR UPDATE;
 IF item.operation_id IS NULL OR item.lease_token IS DISTINCT FROM (selector->>'leaseToken')::uuid OR item.lease_generation<>(selector->>'generation')::bigint OR item.lease_until<=clock_timestamp() THEN RETURN false;END IF;
 -- No operation lock while holding scheduler row: transitions lock operation then row.
 SELECT * INTO op FROM pactwoven.paid_tool_operations WHERE id=item.operation_id;
 next_at:=item.due_at;
 IF op.status IN('completed','cancelled') THEN next_at:=NULL;
 ELSIF item.generation=item.lease_generation AND item.operation_version=item.lease_operation_version THEN
  -- Status and newer generation win over caller completion hints. Submitted
  -- attempts keep reconciliation alive even if a stale caller asks to park.
  IF op.status IN('submitting','payment_pending') OR(op.status='outcome_unknown' AND op.attempt IS NOT NULL) THEN next_at:=clock_timestamp()+interval '4 seconds';
  ELSIF op.status='payment_confirmed' THEN next_at:=clock_timestamp()+interval '4 seconds';
  ELSIF op.status IN('authorized','reserved','signed') THEN
   IF op.revoked_at IS NOT NULL OR NOT EXISTS(SELECT 1 FROM pactwoven.paid_tool_reviews r WHERE r.id=op.review_id AND r.expires_at>clock_timestamp()) THEN next_at:=NULL;ELSE next_at:=clock_timestamp()+coalesce((q->>'nextWakeAfterMs')::integer,4000)*interval '1 millisecond';END IF;
  ELSIF q->'nextWakeAfterMs'='null'::jsonb THEN next_at:=NULL;
  ELSE next_at:=clock_timestamp()+((q->>'nextWakeAfterMs')::integer*interval '1 millisecond');END IF;
 END IF;
 UPDATE pactwoven.paid_tool_dispatch SET generation=CASE WHEN next_at IS NOT NULL AND generation=lease_generation THEN generation+1 ELSE generation END,due_at=next_at,lease_token=NULL,lease_generation=NULL,lease_until=NULL,lease_operation_version=NULL,dispatch_token=NULL,dispatch_until=NULL,dispatch_ready_at=NULL,published_at=NULL WHERE operation_id=item.operation_id;
 RETURN true;END $$;
CREATE FUNCTION pactwoven.paid_tool_dispatch_recover(q jsonb) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE item pactwoven.paid_tool_dispatch;count integer:=0;BEGIN
 PERFORM pactwoven.paid_tool_principal(ARRAY['scheduler']);PERFORM pactwoven.paid_tool_keys(q,ARRAY['limit']);PERFORM pactwoven.paid_tool_require(q->>'limit' ~ '^[0-9]+$' AND(q->>'limit')::integer BETWEEN 1 AND 100);
 FOR item IN SELECT * FROM pactwoven.paid_tool_dispatch WHERE (lease_until<=clock_timestamp()) OR(lease_token IS NULL AND due_at<=clock_timestamp() AND (published_at IS NOT NULL OR dispatch_until<=clock_timestamp())) ORDER BY coalesce(lease_until,due_at),operation_id COLLATE "C" LIMIT (q->>'limit')::integer FOR UPDATE SKIP LOCKED LOOP
  UPDATE pactwoven.paid_tool_dispatch SET generation=generation+1,due_at=CASE WHEN due_at IS NULL THEN NULL ELSE greatest(due_at,clock_timestamp()) END,lease_token=NULL,lease_generation=NULL,lease_until=NULL,lease_operation_version=NULL,dispatch_token=NULL,dispatch_until=NULL,dispatch_ready_at=NULL,published_at=NULL WHERE operation_id=item.operation_id;count:=count+1;
 END LOOP;RETURN count;END $$;
-- A retained wire can arrive after the signing worker's lease failed. Its
-- own atomic wake must survive a prior reconciliation worker parking the row.
CREATE FUNCTION pactwoven.paid_tool_dispatch_wire_wake() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 UPDATE pactwoven.paid_tool_dispatch SET generation=generation+1,due_at=clock_timestamp(),dispatch_token=NULL,dispatch_until=NULL,dispatch_ready_at=NULL,published_at=NULL WHERE operation_id=NEW.operation_id AND EXISTS(SELECT 1 FROM pactwoven.paid_tool_operations op WHERE op.id=NEW.operation_id AND op.status IN('signing','outcome_unknown') AND op.attempt IS NULL);RETURN NEW;END $$;
CREATE TRIGGER paid_tool_dispatch_wire_wake AFTER INSERT ON pactwoven.paid_tool_quarantine FOR EACH ROW EXECUTE FUNCTION pactwoven.paid_tool_dispatch_wire_wake();
-- One insertion implementation; only the wrappers below establish service admission.
CREATE FUNCTION pactwoven.paid_tool_observe_internal(q jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
 DECLARE a pactwoven.paid_tool_accounts;prior pactwoven.paid_tool_observations;BEGIN
 PERFORM pactwoven.paid_tool_keys(q,ARRAY['id','accountKey','slot','amountBaseUnits','observedAt','evidenceRef','evidenceHash']);
 SELECT * INTO a FROM pactwoven.paid_tool_accounts WHERE account_key=q->>'accountKey' FOR UPDATE;PERFORM pactwoven.paid_tool_require(a.enabled AND q->>'evidenceHash' ~ '^[a-f0-9]{64}$' AND length(q->>'evidenceRef') BETWEEN 1 AND 128);
 SELECT * INTO prior FROM pactwoven.paid_tool_observations WHERE id=q->>'id';IF FOUND THEN PERFORM pactwoven.paid_tool_require(prior.body=q);RETURN prior.body;END IF;
 PERFORM pactwoven.paid_tool_require(pactwoven.supplier_time(q->'observedAt')<=clock_timestamp() AND pactwoven.supplier_time(q->'observedAt')>clock_timestamp()-interval '30 seconds');
 PERFORM pactwoven.paid_tool_require(NOT EXISTS(SELECT 1 FROM pactwoven.paid_tool_observations WHERE account_key=a.account_key AND slot=pactwoven.paid_tool_units(q->>'slot') AND amount<>pactwoven.paid_tool_units(q->>'amountBaseUnits')));
 INSERT INTO pactwoven.paid_tool_observations VALUES(q->>'id',a.account_key,pactwoven.paid_tool_units(q->>'slot'),pactwoven.paid_tool_units(q->>'amountBaseUnits'),pactwoven.supplier_time(q->'observedAt'),q->>'evidenceRef',q->>'evidenceHash',q);RETURN q;END $$;
CREATE OR REPLACE FUNCTION pactwoven.paid_tool_observe(q jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN PERFORM pactwoven.paid_tool_principal(ARRAY['observer']);RETURN pactwoven.paid_tool_observe_internal(q);END $$;
CREATE FUNCTION pactwoven.paid_tool_observe_for_operation(p_id text,q jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE op pactwoven.paid_tool_operations;r pactwoven.paid_tool_reviews;BEGIN
 PERFORM pactwoven.paid_tool_principal(ARRAY['signer']);SELECT * INTO op FROM pactwoven.paid_tool_operations WHERE id=p_id;SELECT * INTO r FROM pactwoven.paid_tool_reviews WHERE id=op.review_id;
 PERFORM pactwoven.paid_tool_require(op.id IS NOT NULL AND q->>'accountKey' IN(r.source_key,r.fee_key));PERFORM pactwoven.paid_tool_locked(r,true);
 SELECT * INTO op FROM pactwoven.paid_tool_operations WHERE id=p_id FOR UPDATE;PERFORM pactwoven.paid_tool_require(op.status='reserved' AND op.revoked_at IS NULL);
 RETURN pactwoven.paid_tool_observe_internal(q);END $$;
CREATE TABLE pactwoven.paid_tool_rpc_captures(reference text PRIMARY KEY,operation_id text NOT NULL REFERENCES pactwoven.paid_tool_operations,service_role name NOT NULL,service_purpose text NOT NULL,body jsonb NOT NULL,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE INDEX paid_tool_rpc_captures_operation ON pactwoven.paid_tool_rpc_captures(operation_id,recorded_at);
CREATE FUNCTION pactwoven.paid_tool_capture_for_operation(p_id text,q jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE purpose text;prior pactwoven.paid_tool_rpc_captures;request jsonb;BEGIN
 purpose:=pactwoven.paid_tool_principal(ARRAY['policy','signer','broadcaster','observer']);PERFORM pactwoven.paid_tool_keys(q,ARRAY['reference','method','requestPayload','requestHash','observedAt','payloadHex','sha256']);
 PERFORM pactwoven.paid_tool_require(p_id ~ '^[A-Za-z0-9_-]{1,128}$' AND q->>'reference' ~ '^[A-Za-z0-9_-]{1,128}$' AND length(q->>'requestPayload') BETWEEN 1 AND 8192 AND length(q->>'payloadHex')<=262144 AND q->>'payloadHex' ~ '^([a-f0-9]{2})*$' AND q->>'requestHash'=encode(sha256(convert_to(q->>'requestPayload','UTF8')),'hex') AND q->>'sha256'=encode(sha256(decode(q->>'payloadHex','hex')),'hex'));
 request:=(q->>'requestPayload')::jsonb;
 PERFORM pactwoven.paid_tool_require(q->>'method' IN('getGenesisHash','getMultipleAccounts','getBlockHeight','getLatestBlockhash','getFeeForMessage','simulateTransaction','sendTransaction','getSignatureStatuses','getTransaction') AND request->>'method'=q->>'method' AND EXISTS(SELECT 1 FROM pactwoven.paid_tool_operations WHERE id=p_id));
 SELECT * INTO prior FROM pactwoven.paid_tool_rpc_captures WHERE reference=q->>'reference';IF FOUND THEN PERFORM pactwoven.paid_tool_require(prior.operation_id=p_id AND prior.service_role=session_user AND prior.service_purpose=purpose AND prior.body=q);ELSE
  PERFORM pactwoven.paid_tool_require(pactwoven.supplier_time(q->'observedAt')<=clock_timestamp() AND pactwoven.supplier_time(q->'observedAt')>clock_timestamp()-interval '2 minutes');
  INSERT INTO pactwoven.paid_tool_rpc_captures VALUES(q->>'reference',p_id,session_user,purpose,q,clock_timestamp());
 END IF;RETURN jsonb_build_object('operationId',p_id,'reference',q->>'reference','sha256',q->>'sha256');END $$;
CREATE TRIGGER paid_tool_rpc_captures_immutable BEFORE UPDATE OR DELETE ON pactwoven.paid_tool_rpc_captures FOR EACH ROW EXECUTE FUNCTION pactwoven.paid_tool_immutable();
DO $$ DECLARE t text;f record;BEGIN
 FOREACH t IN ARRAY ARRAY['paid_tool_dispatch','paid_tool_rpc_captures'] LOOP
  EXECUTE format('ALTER TABLE pactwoven.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE pactwoven.%I FORCE ROW LEVEL SECURITY',t);EXECUTE format('CREATE POLICY owner_only ON pactwoven.%I TO %I USING(true) WITH CHECK(true)',t,current_user);
  EXECUTE format('REVOKE ALL ON pactwoven.%I FROM PUBLIC,pactwoven_runtime,pactwoven_paid_tool_api,pactwoven_paid_tool_policy,pactwoven_paid_tool_signer,pactwoven_paid_tool_broadcaster,pactwoven_paid_tool_observer,pactwoven_paid_tool_delivery,pactwoven_paid_tool_scheduler',t);
 END LOOP;
 FOR f IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace='pactwoven'::regnamespace AND(proname LIKE 'paid_tool_dispatch%' OR proname IN('paid_tool_pool_binding','paid_tool_observe_internal','paid_tool_observe_for_operation','paid_tool_capture_for_operation')) LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,pactwoven_runtime,pactwoven_paid_tool_api,pactwoven_paid_tool_policy,pactwoven_paid_tool_signer,pactwoven_paid_tool_broadcaster,pactwoven_paid_tool_observer,pactwoven_paid_tool_delivery,pactwoven_paid_tool_scheduler',f.signature);
 END LOOP;END $$;
GRANT EXECUTE ON FUNCTION pactwoven.paid_tool_pool_binding(text) TO pactwoven_paid_tool_api,pactwoven_paid_tool_policy,pactwoven_paid_tool_signer,pactwoven_paid_tool_broadcaster,pactwoven_paid_tool_observer,pactwoven_paid_tool_delivery,pactwoven_paid_tool_scheduler;
GRANT EXECUTE ON FUNCTION pactwoven.paid_tool_dispatch_claim(jsonb),pactwoven.paid_tool_dispatch_ack(jsonb,text),pactwoven.paid_tool_dispatch_consume(jsonb,jsonb),pactwoven.paid_tool_dispatch_finish(jsonb,jsonb),pactwoven.paid_tool_dispatch_recover(jsonb) TO pactwoven_paid_tool_scheduler;
GRANT EXECUTE ON FUNCTION pactwoven.paid_tool_observe_for_operation(text,jsonb) TO pactwoven_paid_tool_signer;
GRANT EXECUTE ON FUNCTION pactwoven.paid_tool_capture_for_operation(text,jsonb) TO pactwoven_paid_tool_policy,pactwoven_paid_tool_signer,pactwoven_paid_tool_broadcaster,pactwoven_paid_tool_observer;
COMMIT;
