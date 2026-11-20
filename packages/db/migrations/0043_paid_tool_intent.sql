BEGIN;
CREATE TABLE pactwoven.paid_tool_intent_reviews(organization_id text NOT NULL,actor_id text NOT NULL,request_key text NOT NULL,review_id text NOT NULL,policy jsonb NOT NULL,policy_review_hash text NOT NULL,PRIMARY KEY(organization_id,actor_id,request_key),UNIQUE(organization_id,actor_id,review_id));
CREATE TABLE pactwoven.paid_tool_intent_confirmations(organization_id text NOT NULL,actor_id text NOT NULL,request_key text NOT NULL,body jsonb NOT NULL,PRIMARY KEY(organization_id,actor_id,request_key),FOREIGN KEY(organization_id,actor_id,request_key) REFERENCES pactwoven.paid_tool_intent_reviews);
CREATE FUNCTION pactwoven.paid_tool_intent_policy(r pactwoven.paid_tool_intent_reviews) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT r.policy||jsonb_build_object('policyReviewHash',r.policy_review_hash) $$;
CREATE FUNCTION pactwoven.paid_tool_intent_prepare(actor jsonb,key text,q jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE work jsonb;r pactwoven.paid_tool_intent_reviews;p jsonb;h text;BEGIN
 PERFORM pactwoven.paid_tool_principal(ARRAY['api']);PERFORM pactwoven.paid_tool_keys(q,ARRAY['work','paidPolicy']);p:=q->'paidPolicy';PERFORM pactwoven.paid_tool_keys(p,ARRAY['serviceId','maximumComputationBaseUnits','maximumFeeLamports','authorization']);
 PERFORM pactwoven.paid_tool_require(actor->>'environment'='development' AND p->>'serviceId'='equipment_optimizer_v1' AND p->>'authorization'='separate_quote_required' AND pactwoven.paid_tool_units(p->>'maximumComputationBaseUnits')>0 AND pactwoven.paid_tool_units(p->>'maximumFeeLamports')>0);
 work:=pactwoven.native_work_intent_prepare(actor,key,q->'work');
 h:=pactwoven.native_delegation_hash(jsonb_build_object('namespace','pactwoven.paid-intent-review.v1','workReviewId',work#>>'{review,id}','workReviewToken',work#>>'{review,token}','policy',p));
 SELECT * INTO r FROM pactwoven.paid_tool_intent_reviews WHERE(organization_id,actor_id,request_key)=(actor->>'organizationId',actor->>'actorId',key);
 IF FOUND THEN PERFORM pactwoven.paid_tool_require(r.review_id=work#>>'{review,id}' AND r.policy=p AND r.policy_review_hash=h);
 ELSE PERFORM pactwoven.paid_tool_require(work->'operation'='null'::jsonb);INSERT INTO pactwoven.paid_tool_intent_reviews VALUES(actor->>'organizationId',actor->>'actorId',key,work#>>'{review,id}',p,h) RETURNING * INTO r;END IF;
 RETURN jsonb_build_object('work',work,'paidPolicy',pactwoven.paid_tool_intent_policy(r));END $$;
CREATE FUNCTION pactwoven.paid_tool_intent_confirm(actor jsonb,key text,q jsonb,observation jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r pactwoven.paid_tool_intent_reviews;c pactwoven.paid_tool_intent_confirmations;work jsonb;BEGIN
 PERFORM pactwoven.paid_tool_principal(ARRAY['api']);PERFORM pactwoven.paid_tool_keys(q,ARRAY['work','policyReviewHash']);PERFORM pactwoven.paid_tool_require(actor->>'environment'='development');
 PERFORM pactwoven.native_delegation_actor_locked(actor,NULL,false);
 SELECT * INTO r FROM pactwoven.paid_tool_intent_reviews WHERE(organization_id,actor_id,request_key)=(actor->>'organizationId',actor->>'actorId',key) FOR UPDATE;
 PERFORM pactwoven.paid_tool_require(r.review_id=q#>>'{work,reviewId}' AND r.policy_review_hash=q->>'policyReviewHash');
 SELECT * INTO c FROM pactwoven.paid_tool_intent_confirmations WHERE(organization_id,actor_id,request_key)=(r.organization_id,r.actor_id,key);
 IF FOUND THEN PERFORM pactwoven.paid_tool_require(c.body=q);ELSE INSERT INTO pactwoven.paid_tool_intent_confirmations VALUES(r.organization_id,r.actor_id,key,q);END IF;
 work:=pactwoven.native_work_intent_confirm(actor,key,q->'work',observation);
 IF NOT EXISTS(SELECT 1 FROM pactwoven.paid_tool_root_policies p WHERE(p.organization_id,p.root_task_id,p.instruction_revision)=(r.organization_id,work->>'rootTaskId',0)) THEN PERFORM pactwoven.paid_tool_root_bind_policy(actor,jsonb_build_object('rootTaskId',work->>'rootTaskId','siteId',work#>>'{scope,siteId}','instructionRevision',0,'requestKey',key,'maximumComputationBaseUnits',r.policy->>'maximumComputationBaseUnits','maximumFeeLamports',r.policy->>'maximumFeeLamports','authorization','separate_quote_required'));END IF;
 RETURN jsonb_build_object('work',work,'paidPolicy',pactwoven.paid_tool_intent_policy(r));END $$;
CREATE FUNCTION pactwoven.paid_tool_intent_recover(actor jsonb,site text,key text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE work jsonb;r pactwoven.paid_tool_intent_reviews;BEGIN
 PERFORM pactwoven.paid_tool_principal(ARRAY['api']);PERFORM pactwoven.paid_tool_require(actor->>'environment'='development');work:=pactwoven.native_work_intent_recover(actor,site,key);
 SELECT * INTO r FROM pactwoven.paid_tool_intent_reviews WHERE(organization_id,actor_id,request_key)=(actor->>'organizationId',actor->>'actorId',key);
 RETURN jsonb_build_object('work',work,'paidPolicy',CASE WHEN r.review_id IS NULL THEN NULL ELSE pactwoven.paid_tool_intent_policy(r) END);END $$;
-- Deferred until statement transaction commit: the atomic wrapper may call the
-- unmodified original confirm, then bind policy before releasing its new root.
-- Calling ordinary confirm for a paid review without this wrapper rolls back.
CREATE FUNCTION pactwoven.paid_tool_intent_bootstrap_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r pactwoven.paid_tool_intent_reviews;p pactwoven.paid_tool_root_policies;c pactwoven.paid_tool_intent_confirmations;BEGIN
 IF NEW.environment<>'development' THEN RETURN NEW;END IF;
 SELECT * INTO r FROM pactwoven.paid_tool_intent_reviews WHERE(organization_id,actor_id,request_key,review_id)=(NEW.organization_id,NEW.actor_id,NEW.request_key,NEW.review_id);IF NOT FOUND THEN RETURN NEW;END IF;
 SELECT * INTO c FROM pactwoven.paid_tool_intent_confirmations WHERE(organization_id,actor_id,request_key)=(r.organization_id,r.actor_id,r.request_key);
 SELECT * INTO p FROM pactwoven.paid_tool_root_policies WHERE(organization_id,root_task_id,instruction_revision)=(NEW.organization_id,NEW.root_task_id,0);
 PERFORM pactwoven.paid_tool_require(c.body#>'{work}'=NEW.confirmation AND c.body->>'policyReviewHash'=r.policy_review_hash AND p.actor_id=NEW.actor_id AND p.request_key=NEW.request_key AND p.body->>'maximumComputationBaseUnits'=r.policy->>'maximumComputationBaseUnits' AND p.body->>'maximumFeeLamports'=r.policy->>'maximumFeeLamports' AND p.body->>'authorization'='separate_quote_required');RETURN NEW;END $$;
CREATE CONSTRAINT TRIGGER paid_tool_initial_policy_required AFTER INSERT ON pactwoven.native_work_intent_operations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pactwoven.paid_tool_intent_bootstrap_guard();
DO $$ DECLARE t text;owner name:=current_user;f record;BEGIN
 FOREACH t IN ARRAY ARRAY['paid_tool_intent_reviews','paid_tool_intent_confirmations'] LOOP
  EXECUTE format('ALTER TABLE pactwoven.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE pactwoven.%I FORCE ROW LEVEL SECURITY',t);EXECUTE format('CREATE POLICY paid_tool_intent_owner ON pactwoven.%I TO %I USING(true) WITH CHECK(true)',t,owner);
  EXECUTE format('REVOKE ALL ON pactwoven.%I FROM PUBLIC,pactwoven_runtime,pactwoven_native_delegation_api,pactwoven_paid_tool_api',t);EXECUTE format('CREATE TRIGGER paid_tool_intent_immutable BEFORE UPDATE OR DELETE ON pactwoven.%I FOR EACH ROW EXECUTE FUNCTION pactwoven.paid_tool_immutable()',t);
 END LOOP;
 FOR f IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace='pactwoven'::regnamespace AND proname LIKE 'paid_tool_intent_%' LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,pactwoven_runtime,pactwoven_native_delegation_api,pactwoven_paid_tool_api',f.signature);END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION pactwoven.paid_tool_intent_prepare(jsonb,text,jsonb),pactwoven.paid_tool_intent_confirm(jsonb,text,jsonb,jsonb),pactwoven.paid_tool_intent_recover(jsonb,text,text) TO pactwoven_paid_tool_api;
COMMIT;
