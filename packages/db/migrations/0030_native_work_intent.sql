BEGIN;
-- Human-owned preparation/consent is separate from the worker execution APIs.
-- Scope, service identities and readable review bodies are derived here.
CREATE TABLE pactwoven.native_work_intent_reviews (
 environment text NOT NULL,organization_id text NOT NULL,actor_id text NOT NULL,request_key text NOT NULL,
 id text NOT NULL,site_id text NOT NULL,session_id text NOT NULL,authenticated_at timestamptz NOT NULL,
 input jsonb NOT NULL,snapshot jsonb NOT NULL,review jsonb NOT NULL,
 prepared_at timestamptz NOT NULL,confirm_by timestamptz NOT NULL,expires_at timestamptz NOT NULL,
 PRIMARY KEY(environment,organization_id,actor_id,request_key),UNIQUE(environment,organization_id,id),
 FOREIGN KEY(environment,organization_id,actor_id) REFERENCES pactwoven.memberships(environment,organization_id,actor_id),
 FOREIGN KEY(environment,organization_id,site_id) REFERENCES pactwoven.sites(environment,organization_id,id),
 CHECK(request_key ~ '^[A-Za-z0-9_-]{16,128}$'),CHECK(octet_length(input::text)<=65536 AND octet_length(snapshot::text)<=2097152 AND octet_length(review::text)<=2097152),
 CHECK(confirm_by>prepared_at AND confirm_by<=prepared_at+interval '5 minutes' AND expires_at=prepared_at+interval '24 hours')
);
CREATE TABLE pactwoven.native_work_intent_operations (
 environment text NOT NULL,organization_id text NOT NULL,actor_id text NOT NULL,request_key text NOT NULL,
 id text NOT NULL,review_id text NOT NULL,site_id text NOT NULL,root_task_id text NOT NULL,grant_id text NOT NULL,provenance_id text NOT NULL,
 confirmation jsonb NOT NULL,operation jsonb NOT NULL,committed_at timestamptz NOT NULL,
 PRIMARY KEY(environment,organization_id,actor_id,request_key),UNIQUE(environment,organization_id,provenance_id),UNIQUE(environment,organization_id,root_task_id),
 FOREIGN KEY(environment,organization_id,actor_id,request_key) REFERENCES pactwoven.native_work_intent_reviews(environment,organization_id,actor_id,request_key),
 FOREIGN KEY(environment,organization_id,review_id) REFERENCES pactwoven.native_work_intent_reviews(environment,organization_id,id),
 FOREIGN KEY(environment,organization_id,root_task_id) REFERENCES pactwoven.native_delegation_tasks(environment,organization_id,id),
 FOREIGN KEY(environment,organization_id,grant_id) REFERENCES pactwoven.native_delegation_grants(environment,organization_id,id),
 FOREIGN KEY(environment,organization_id,provenance_id) REFERENCES pactwoven.native_tasks(environment,organization_id,id)
);
CREATE FUNCTION pactwoven.native_work_intent_require(ok boolean,code text) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION USING ERRCODE=code,MESSAGE='Human work intent rejected';END IF;END $$;
CREATE FUNCTION pactwoven.native_work_intent_valid(q jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ DECLARE note jsonb;BEGIN
 IF NOT pactwoven.native_memory_object(q,ARRAY['siteId','title','prompt','selections','continuesAfterSignOut']) OR NOT pactwoven.native_memory_id(q->'siteId')
  OR NOT pactwoven.native_memory_text(q->'title',1,180) OR NOT pactwoven.native_memory_text(q->'prompt',1,12000)
  OR q->'continuesAfterSignOut' IS DISTINCT FROM 'true'::jsonb OR jsonb_typeof(q->'selections') IS DISTINCT FROM 'array' OR octet_length(q::text)>65536 THEN RETURN false;END IF;
 IF q->>'title' ~ U&'^[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]*$'
  OR q->>'prompt' ~ U&'^[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]*$'
  OR jsonb_array_length(q->'selections')>32 THEN RETURN false;END IF;
 FOR note IN SELECT x FROM jsonb_array_elements(q->'selections') x LOOP
  IF NOT pactwoven.native_memory_object(note,ARRAY['noteId','expected']) OR NOT pactwoven.native_memory_id(note->'noteId')
   OR jsonb_typeof(note->'expected') IS DISTINCT FROM 'string' OR note->>'expected' !~ '^[a-f0-9]{64}$' THEN RETURN false;END IF;
 END LOOP;
 RETURN (SELECT count(*)=count(DISTINCT n->>'noteId') FROM jsonb_array_elements(q->'selections') n);
END $$;
-- Retention is not disclosure authority. Every saved review projection must
-- admit the exact original note/source heads under the human's current ACL,
-- closure, provenance and time bounds. A stale review is never rewritten.
CREATE FUNCTION pactwoven.native_work_intent_review_readable(ctx jsonb,q jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE choice jsonb;n pactwoven.native_memory_notes;m jsonb;s jsonb;note jsonb;valid_until timestamptz;BEGIN
 IF jsonb_array_length(q->'selections')>0 THEN PERFORM pactwoven.native_memory_lock_scope(ctx,false);END IF;
 FOR choice IN SELECT x FROM jsonb_array_elements(q->'selections') x LOOP
  SELECT * INTO n FROM pactwoven.native_memory_notes WHERE(environment,organization_id,site_id,id,actor_id)=
   (ctx->>'environment',ctx->>'organizationId',ctx->>'siteId',choice->>'noteId',ctx->>'actorId');
  IF NOT FOUND THEN RETURN false;END IF;
  SELECT v.record INTO m FROM pactwoven.native_memory_heads h JOIN pactwoven.native_memory_revisions v USING(environment,organization_id,site_id,memory_id,revision,digest)
   WHERE(h.environment,h.organization_id,h.site_id,h.memory_id)=(n.environment,n.organization_id,n.site_id,n.memory_id);
  SELECT v.record INTO s FROM pactwoven.native_memory_source_heads h JOIN pactwoven.native_memory_source_revisions v USING(environment,organization_id,site_id,source_id,revision,digest)
   WHERE(h.environment,h.organization_id,h.site_id,h.source_id)=(n.environment,n.organization_id,n.site_id,n.source_id);
  note:=pactwoven.native_memory_notes_project_locked(ctx,n.id);
  IF m IS NULL OR s IS NULL OR note->>'status' IS DISTINCT FROM 'available'
   OR pactwoven.native_memory_notes_version(m,s) IS DISTINCT FROM choice->>'expected' THEN RETURN false;END IF;
  PERFORM pactwoven.native_memory_readable(m,ctx||jsonb_build_object('purpose','human_review'),'recordedAt',clock_timestamp());
  PERFORM pactwoven.native_memory_readable(s,ctx||jsonb_build_object('purpose','human_review'),'observedAt',clock_timestamp());
  valid_until:=least(valid_until,pactwoven.native_memory_time(m->'validUntil'),pactwoven.native_memory_time(s->'validUntil'));
 END LOOP;
 PERFORM pactwoven.native_memory_notes_deadline(ctx);RETURN valid_until IS NULL OR valid_until>clock_timestamp();
 EXCEPTION WHEN SQLSTATE 'NM001' OR SQLSTATE 'NM005' OR SQLSTATE 'NM006' OR SQLSTATE 'NM008' OR SQLSTATE 'NM009' THEN RETURN false;
END $$;
CREATE FUNCTION pactwoven.native_work_intent_snapshot(p_actor jsonb,q jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE ctx jsonb;o pactwoven.organizations;m pactwoven.memberships;site pactwoven.sites;f pactwoven.financial_site_fences;
 policy pactwoven.native_delegation_policies;provider pactwoven.native_provider_instances;coordinator jsonb;services jsonb;scope jsonb;body jsonb;
 choice jsonb;note jsonb;n pactwoven.native_memory_notes;memory_record jsonb;source_record jsonb;selected jsonb:='[]';api_service jsonb;BEGIN
 ctx:=pactwoven.native_delegation_actor_locked(p_actor,q->>'siteId',true);api_service:=pactwoven.native_delegation_service(ctx->>'environment',ARRAY['api']);
 SELECT * INTO o FROM pactwoven.organizations WHERE(environment,id)=(ctx->>'environment',ctx->>'organizationId') FOR SHARE;
 SELECT * INTO m FROM pactwoven.memberships WHERE(environment,organization_id,actor_id)=(o.environment,o.id,ctx->>'actorId') FOR SHARE;
 SELECT * INTO site FROM pactwoven.sites WHERE(environment,organization_id,id)=(o.environment,o.id,q->>'siteId') FOR SHARE;
 PERFORM 1 FROM pactwoven.member_action_sites WHERE(environment,organization_id,actor_id,site_id)=(o.environment,o.id,m.actor_id,site.id) FOR SHARE;
 PERFORM 1 FROM pactwoven.site_memberships WHERE(environment,organization_id,actor_id,site_id)=(o.environment,o.id,m.actor_id,site.id) FOR SHARE;
 SELECT * INTO f FROM pactwoven.financial_site_fences WHERE(environment,organization_id,site_id)=(o.environment,o.id,site.id) FOR SHARE;
 SELECT * INTO policy FROM pactwoven.native_delegation_policies WHERE(environment,organization_id)=(o.environment,o.id) FOR SHARE;
 SELECT * INTO provider FROM pactwoven.native_provider_instances WHERE environment=o.environment FOR SHARE;
 PERFORM pactwoven.native_work_intent_require(policy.organization_id IS NOT NULL AND policy.enabled AND provider.environment IS NOT NULL AND provider.enabled
  AND m.external_membership_id IS NOT NULL AND m.external_subject IS NOT NULL AND o.external_organization_id IS NOT NULL,'NW007');
 -- Service enrollment rows are held through publication; a changed cohort
 -- invalidates the review instead of silently changing its recipient audience.
 -- The table lock also excludes a newly inserted coordinator/worker row.
 LOCK TABLE pactwoven.native_delegation_services IN SHARE MODE;
 PERFORM 1 FROM pactwoven.native_delegation_services WHERE environment=o.environment AND purpose IN('coordinator','worker') ORDER BY service_id COLLATE "C" FOR SHARE;
 SELECT coalesce(jsonb_agg(jsonb_build_object('purpose',purpose,'identity',identity) ORDER BY purpose,service_id COLLATE "C"),'[]') INTO services
  FROM pactwoven.native_delegation_services WHERE environment=o.environment AND purpose IN('coordinator','worker') AND enabled;
 PERFORM pactwoven.native_work_intent_require((SELECT count(*)=1 FROM jsonb_array_elements(services) s WHERE s->>'purpose'='coordinator')
  AND (SELECT count(*) BETWEEN 1 AND 32 FROM jsonb_array_elements(services) s WHERE s->>'purpose'='worker'),'NW007');
 SELECT s->'identity' INTO coordinator FROM jsonb_array_elements(services) s WHERE s->>'purpose'='coordinator';
 FOR choice IN SELECT s->'identity' FROM jsonb_array_elements(services) s LOOP PERFORM pactwoven.native_delegation_require(choice,'service');END LOOP;
 scope:=jsonb_build_object('environment',o.environment,'organizationId',o.id,'issuer',jsonb_build_object('actorId',m.actor_id,'providerIssuer',provider.issuer,
  'subject',m.external_subject,'externalOrganizationId',o.external_organization_id,'externalMembershipId',m.external_membership_id,'membershipVersion',m.row_version),
  'organizationEpoch',o.authority_epoch,'policyVersion',policy.version,'purpose','Prepare advice: '||btrim(q->>'title'),
  'sites',jsonb_build_array(jsonb_build_object('siteId',site.id,'siteVersion',f.generation+1)),'capabilityVersion',1,
  'capabilities',CASE WHEN jsonb_array_length(q->'selections')>0 THEN '["research_public_sources","read_scoped_memory","draft_advice"]'::jsonb ELSE '["research_public_sources","draft_advice"]'::jsonb END,
  'limits',jsonb_build_object('maxDepth',3,'maxConcurrentChildren',3,'maxChildren',32,'maxAttempts',4,'taskTimeoutMs',300000));
 PERFORM pactwoven.native_work_intent_require(pactwoven.native_delegation_matches(scope,pactwoven.native_delegation_schema('grant')#>'{properties,scope}'),'NW004');PERFORM pactwoven.native_delegation_scope_locked(scope);
 IF jsonb_array_length(q->'selections')>0 THEN PERFORM pactwoven.native_memory_lock_scope(ctx,false);END IF;
 FOR choice IN SELECT x FROM jsonb_array_elements(q->'selections') x LOOP
  SELECT * INTO n FROM pactwoven.native_memory_notes WHERE(environment,organization_id,site_id,id,actor_id)=(o.environment,o.id,site.id,choice->>'noteId',m.actor_id);
  PERFORM pactwoven.native_work_intent_require(FOUND,'NW005');
  SELECT v.record INTO memory_record FROM pactwoven.native_memory_heads h JOIN pactwoven.native_memory_revisions v USING(environment,organization_id,site_id,memory_id,revision,digest)
   WHERE(h.environment,h.organization_id,h.site_id,h.memory_id)=(o.environment,o.id,site.id,n.memory_id);
  SELECT v.record INTO source_record FROM pactwoven.native_memory_source_heads h JOIN pactwoven.native_memory_source_revisions v USING(environment,organization_id,site_id,source_id,revision,digest)
   WHERE(h.environment,h.organization_id,h.site_id,h.source_id)=(o.environment,o.id,site.id,n.source_id);
  note:=pactwoven.native_memory_notes_project_locked(ctx,n.id);
  PERFORM pactwoven.native_work_intent_require(note->>'status'='available' AND note->>'editToken'=choice->>'expected','NW005');
  PERFORM pactwoven.native_memory_readable(memory_record,ctx||jsonb_build_object('purpose','task_context'),'recordedAt',clock_timestamp());
  PERFORM pactwoven.native_memory_readable(source_record,ctx||jsonb_build_object('purpose','task_context'),'observedAt',clock_timestamp());
  PERFORM pactwoven.native_memory_readable(memory_record,ctx||jsonb_build_object('purpose','task_context','reader',jsonb_build_object('kind','agent','id',coordinator->>'serviceId')),'recordedAt',clock_timestamp());
  PERFORM pactwoven.native_memory_readable(source_record,ctx||jsonb_build_object('purpose','task_context','reader',jsonb_build_object('kind','agent','id',coordinator->>'serviceId')),'observedAt',clock_timestamp());
  selected:=selected||jsonb_build_array(jsonb_build_object('noteId',n.id,'title',note->'title','text',note->'text','purpose',note->'purpose',
   'reviewBy',note->'reviewBy','suppliedBy',note->'suppliedBy','sourceLabel',note->'sourceLabel'));
 END LOOP;
 body:=jsonb_build_object('title',q->'title','prompt',q->'prompt','siteName',site.name,'selectedNotes',selected,
  'allowedWork',CASE WHEN jsonb_array_length(selected)>0 THEN '["Research public sources","Read selected notes","Draft advice"]'::jsonb ELSE '["Research public sources","Draft advice"]'::jsonb END,
  'continuesAfterSignOut',true,'externalEffects','forbidden');
 PERFORM pactwoven.native_memory_notes_deadline(ctx);
 RETURN jsonb_build_object('scope',scope,'coordinator',coordinator,'services',services,'apiService',api_service,'body',body);
END $$;
CREATE FUNCTION pactwoven.native_work_intent_prepare(p_actor jsonb,p_key text,q jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE ctx jsonb;prior pactwoven.native_work_intent_reviews;op pactwoven.native_work_intent_operations;snapshot jsonb;review jsonb;stamp timestamptz;confirm_by timestamptz;expires_at timestamptz;id text;token text;BEGIN
 PERFORM pactwoven.native_work_intent_require(p_key ~ '^[A-Za-z0-9_-]{16,128}$' AND pactwoven.native_work_intent_valid(q),'NW004');
 LOCK TABLE pactwoven.native_delegation_services IN SHARE MODE;
 ctx:=pactwoven.native_delegation_actor_locked(p_actor,q->>'siteId',true);
 PERFORM pg_advisory_xact_lock(hashtextextended(pactwoven.native_memory_canonical(jsonb_build_array('native-work-intent',ctx->'environment',ctx->'organizationId',ctx->'actorId',p_key)),0));
 SELECT * INTO prior FROM pactwoven.native_work_intent_reviews WHERE(environment,organization_id,actor_id,request_key)=(ctx->>'environment',ctx->>'organizationId',ctx->>'actorId',p_key);
 IF FOUND THEN
  PERFORM pactwoven.native_work_intent_require(prior.input=q AND prior.session_id=ctx->>'sessionId' AND prior.authenticated_at=pactwoven.native_memory_time(p_actor->'authenticatedAt'),'NW003');
  PERFORM pactwoven.native_work_intent_require(pactwoven.native_work_intent_review_readable(ctx,prior.input),'NW005');
  SELECT * INTO op FROM pactwoven.native_work_intent_operations WHERE(environment,organization_id,actor_id,request_key)=(prior.environment,prior.organization_id,prior.actor_id,p_key);
  PERFORM pactwoven.native_memory_notes_deadline(ctx);RETURN jsonb_build_object('scope',pactwoven.native_memory_scope(ctx),'review',prior.review,'operation',op.operation);
 END IF;
 snapshot:=pactwoven.native_work_intent_snapshot(p_actor,q);stamp:=date_trunc('milliseconds',clock_timestamp());confirm_by:=stamp+interval '5 minutes';expires_at:=stamp+interval '24 hours';id:=gen_random_uuid()::text;
 token:=pactwoven.native_delegation_hash(jsonb_build_object('namespace','pactwoven/work-review/v1','id',id,'actor',ctx->'actorId','session',ctx->'sessionId','input',q,'snapshot',snapshot,
  'preparedAt',pactwoven.native_memory_instant(stamp),'confirmBy',pactwoven.native_memory_instant(confirm_by),'expiresAt',pactwoven.native_memory_instant(expires_at)));
 review:=jsonb_build_object('id',id,'token',token,'preparedAt',pactwoven.native_memory_instant(stamp),'confirmBy',pactwoven.native_memory_instant(confirm_by),
  'expiresAt',pactwoven.native_memory_instant(expires_at),'body',snapshot->'body');
 INSERT INTO pactwoven.native_work_intent_reviews VALUES(ctx->>'environment',ctx->>'organizationId',ctx->>'actorId',p_key,id,q->>'siteId',ctx->>'sessionId',pactwoven.native_memory_time(p_actor->'authenticatedAt'),q,snapshot,review,stamp,confirm_by,expires_at);
 PERFORM pactwoven.native_work_intent_require(pactwoven.native_work_intent_review_readable(ctx,q),'NW005');
 PERFORM pactwoven.native_memory_notes_deadline(ctx);RETURN jsonb_build_object('scope',pactwoven.native_memory_scope(ctx),'review',review,'operation',NULL);
END $$;
CREATE FUNCTION pactwoven.native_work_intent_confirm(p_actor jsonb,p_key text,q jsonb,observation jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE ctx jsonb;r pactwoven.native_work_intent_reviews;op pactwoven.native_work_intent_operations;snapshot jsonb;scope jsonb;grant_body jsonb;consent_body jsonb;issued jsonb;
 now_at timestamptz;grant_id text;root_id text;provenance_id text;operation_id text;answer jsonb;BEGIN
 PERFORM pactwoven.native_work_intent_require(p_key ~ '^[A-Za-z0-9_-]{16,128}$' AND pactwoven.native_memory_object(q,ARRAY['reviewId','reviewToken','continuesAfterSignOut'])
  AND pactwoven.native_memory_id(q->'reviewId') AND q->>'reviewToken' ~ '^[a-f0-9]{64}$' AND q->'continuesAfterSignOut'='true'::jsonb,'NW004');
 LOCK TABLE pactwoven.native_delegation_services IN SHARE MODE;
 ctx:=pactwoven.native_delegation_actor_locked(p_actor,NULL,false);
 PERFORM pg_advisory_xact_lock(hashtextextended(pactwoven.native_memory_canonical(jsonb_build_array('native-work-intent',ctx->'environment',ctx->'organizationId',ctx->'actorId',p_key)),0));
 SELECT * INTO r FROM pactwoven.native_work_intent_reviews WHERE(environment,organization_id,actor_id,request_key)=(ctx->>'environment',ctx->>'organizationId',ctx->>'actorId',p_key) FOR UPDATE;
 PERFORM pactwoven.native_work_intent_require(FOUND,'NW002');
 ctx:=pactwoven.native_delegation_actor_locked(p_actor,r.site_id,false);
 PERFORM pactwoven.native_work_intent_require(r.id=q->>'reviewId' AND r.review->>'token'=q->>'reviewToken','NW003');
 SELECT * INTO op FROM pactwoven.native_work_intent_operations WHERE(environment,organization_id,actor_id,request_key)=(r.environment,r.organization_id,r.actor_id,p_key);
 IF FOUND THEN PERFORM pactwoven.native_work_intent_require(op.confirmation=q,'NW003');PERFORM pactwoven.native_memory_notes_deadline(ctx);RETURN op.operation;END IF;
 ctx:=pactwoven.native_delegation_actor_locked(p_actor,r.site_id,true);
 PERFORM pactwoven.native_work_intent_require(r.session_id=ctx->>'sessionId' AND r.authenticated_at=pactwoven.native_memory_time(p_actor->'authenticatedAt'),'NW001');
 PERFORM pactwoven.native_work_intent_require(r.confirm_by>clock_timestamp() AND r.expires_at>clock_timestamp(),'NW006');
 PERFORM pactwoven.native_work_intent_require(pactwoven.native_memory_object(observation,ARRAY['providerIssuer','sessionVerifiedAt','sessionExpiresAt'])
  AND observation->'providerIssuer'=r.snapshot#>'{scope,issuer,providerIssuer}' AND pactwoven.native_memory_time(observation->'sessionVerifiedAt')>=r.prepared_at
  AND pactwoven.native_memory_time(observation->'sessionVerifiedAt')<=clock_timestamp() AND pactwoven.native_memory_time(observation->'sessionVerifiedAt')>clock_timestamp()-interval '20 seconds'
  AND pactwoven.native_memory_time(observation->'sessionExpiresAt')>clock_timestamp(),'NW001');
 snapshot:=pactwoven.native_work_intent_snapshot(p_actor,r.input);PERFORM pactwoven.native_work_intent_require(snapshot=r.snapshot,'NW005');scope:=snapshot->'scope';
 now_at:=date_trunc('milliseconds',clock_timestamp());grant_id:=gen_random_uuid()::text;root_id:=gen_random_uuid()::text;provenance_id:=gen_random_uuid()::text;operation_id:=gen_random_uuid()::text;
 consent_body:=jsonb_build_object('grantId',grant_id,'requestKey',p_key,'mode','advise','externalEffects','forbidden','scope',scope,'expiresAt',pactwoven.native_memory_instant(r.expires_at),'continuesAfterSignOut',true);
 grant_body:=jsonb_build_object('schemaVersion',1,'id',grant_id,'version',1,'revocationEpoch',0,'mode','advise','externalEffects','forbidden','scope',scope,
  'issuedAt',pactwoven.native_memory_instant(now_at),'expiresAt',pactwoven.native_memory_instant(r.expires_at),'revocation',NULL,
  'issuance',jsonb_build_object('requestKey',p_key,'sessionId',ctx->'sessionId','authenticatedAt',p_actor->'authenticatedAt','confirmedAt',pactwoven.native_memory_instant(now_at),
   'scopeDigest',pactwoven.native_delegation_hash(consent_body),'continuesAfterSignOut',true));
 -- Do not invoke v1 create: it publishes a runnable outbox. This fresh paused
 -- record supplies26's provenance only and is guarded against future v1 use.
 INSERT INTO pactwoven.native_tasks(environment,organization_id,id,actor_id,session_id,site_id,title,prompt,status,phase)
  VALUES(r.environment,r.organization_id,provenance_id,r.actor_id,r.session_id,r.site_id,r.input->>'title',r.input->>'prompt','paused','Background advisory work');
 issued:=pactwoven.native_delegation_issue(p_actor,provenance_id,grant_body,jsonb_build_object('rootTaskId',root_id,'service',snapshot->'coordinator',
  'sessionVerifiedAt',observation->'sessionVerifiedAt','sessionExpiresAt',observation->'sessionExpiresAt'));
 PERFORM pactwoven.native_work_intent_require(issued->>'kind'='issued' AND issued->>'rootTaskId'=root_id,'NW005');
 PERFORM pactwoven.native_delegation_root_bind_notes(p_actor,p_key,jsonb_build_object('rootTaskId',root_id,'selections',r.input->'selections'));
 answer:=jsonb_build_object('scope',pactwoven.native_memory_scope(ctx),'id',operation_id,'reviewId',r.id,'rootTaskId',root_id,'title',r.input->'title',
  'committedAt',pactwoven.native_memory_instant(now_at),'expiresAt',pactwoven.native_memory_instant(r.expires_at),'continuesAfterSignOut',true,'kind','delegated_advice');
 INSERT INTO pactwoven.native_work_intent_operations VALUES(r.environment,r.organization_id,r.actor_id,p_key,operation_id,r.id,r.site_id,root_id,grant_id,provenance_id,q,answer,now_at);
 PERFORM pactwoven.native_work_intent_require(NOT EXISTS(SELECT 1 FROM pactwoven.native_dispatch_outbox WHERE(environment,organization_id,task_id)=(r.environment,r.organization_id,provenance_id)),'NW005');
 PERFORM pactwoven.native_work_intent_require(r.confirm_by>clock_timestamp() AND pactwoven.native_memory_time(observation->'sessionExpiresAt')>clock_timestamp()
  AND pactwoven.native_memory_time(observation->'sessionVerifiedAt')>clock_timestamp()-interval '20 seconds','NW006');
 PERFORM pactwoven.native_memory_notes_deadline(ctx);RETURN answer;
END $$;
CREATE FUNCTION pactwoven.native_work_intent_recover(p_actor jsonb,p_site text,p_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE ctx jsonb;r pactwoven.native_work_intent_reviews;op pactwoven.native_work_intent_operations;readable boolean:=true;BEGIN
 PERFORM pactwoven.native_work_intent_require(pactwoven.native_memory_id(to_jsonb(p_site)) AND p_key ~ '^[A-Za-z0-9_-]{16,128}$','NW004');
 ctx:=pactwoven.native_delegation_actor_locked(p_actor,p_site,false);
 SELECT * INTO r FROM pactwoven.native_work_intent_reviews WHERE(environment,organization_id,actor_id,request_key,site_id)=(ctx->>'environment',ctx->>'organizationId',ctx->>'actorId',p_key,p_site);
 SELECT * INTO op FROM pactwoven.native_work_intent_operations WHERE(environment,organization_id,actor_id,request_key,site_id)=(ctx->>'environment',ctx->>'organizationId',ctx->>'actorId',p_key,p_site);
 IF r.id IS NOT NULL THEN readable:=pactwoven.native_work_intent_review_readable(ctx,r.input);END IF;
 PERFORM pactwoven.native_work_intent_require(readable OR op.id IS NOT NULL,'NW005');
 PERFORM pactwoven.native_memory_notes_deadline(ctx);RETURN jsonb_build_object('scope',pactwoven.native_memory_scope(ctx),
  'review',CASE WHEN readable THEN r.review ELSE NULL END,'operation',op.operation,'reviewUnavailable',NOT readable);
END $$;
CREATE FUNCTION pactwoven.native_work_intent_provenance(p_actor jsonb,q jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE ctx jsonb;items jsonb;BEGIN
 PERFORM pactwoven.native_work_intent_require(pactwoven.native_memory_object(q,ARRAY['siteId','ids']) AND pactwoven.native_memory_id(q->'siteId') AND jsonb_typeof(q->'ids')='array','NW004');
 PERFORM pactwoven.native_work_intent_require(jsonb_array_length(q->'ids')<=100 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(q->'ids') id WHERE NOT pactwoven.native_memory_id(id))
  AND (SELECT count(*)=count(DISTINCT id) FROM jsonb_array_elements(q->'ids') id),'NW004');
 ctx:=pactwoven.native_delegation_actor_locked(p_actor,q->>'siteId',false);
 SELECT coalesce(jsonb_agg(jsonb_build_object('provenanceId',provenance_id,'rootTaskId',root_task_id) ORDER BY provenance_id COLLATE "C"),'[]') INTO items
  FROM pactwoven.native_work_intent_operations WHERE(environment,organization_id,actor_id,site_id)=(ctx->>'environment',ctx->>'organizationId',ctx->>'actorId',ctx->>'siteId') AND q->'ids' ? provenance_id;
 PERFORM pactwoven.native_memory_notes_deadline(ctx);RETURN jsonb_build_object('scope',pactwoven.native_memory_scope(ctx),'items',items);
END $$;
CREATE FUNCTION pactwoven.native_work_intent_inert_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE e text;o text;target_id text;BEGIN
 IF TG_TABLE_NAME='native_tasks' THEN e:=OLD.environment;o:=OLD.organization_id;target_id:=OLD.id;
 ELSE e:=NEW.environment;o:=NEW.organization_id;target_id:=NEW.task_id;END IF;
 PERFORM pactwoven.native_work_intent_require(NOT EXISTS(SELECT 1 FROM pactwoven.native_work_intent_operations WHERE(environment,organization_id,provenance_id)=(e,o,target_id)),'NW008');
 IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
END $$;
CREATE TRIGGER native_work_provenance_inert BEFORE UPDATE OR DELETE ON pactwoven.native_tasks FOR EACH ROW EXECUTE FUNCTION pactwoven.native_work_intent_inert_guard();
CREATE TRIGGER native_work_provenance_no_dispatch BEFORE INSERT OR UPDATE ON pactwoven.native_dispatch_outbox FOR EACH ROW EXECUTE FUNCTION pactwoven.native_work_intent_inert_guard();
DO $$ DECLARE name text;f record;BEGIN
 FOREACH name IN ARRAY ARRAY['native_work_intent_reviews','native_work_intent_operations'] LOOP
  EXECUTE format('ALTER TABLE pactwoven.%I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('REVOKE ALL ON TABLE pactwoven.%I FROM PUBLIC,pactwoven_native_delegation_api,pactwoven_native_delegation_coordinator,pactwoven_native_delegation_worker,pactwoven_native_delegation_dispatcher',name);
  EXECUTE format('CREATE TRIGGER native_work_immutable BEFORE UPDATE OR DELETE ON pactwoven.%I FOR EACH ROW EXECUTE FUNCTION pactwoven.financial_immutable()',name);
  EXECUTE format('CREATE TRIGGER native_work_no_truncate BEFORE TRUNCATE ON pactwoven.%I FOR EACH STATEMENT EXECUTE FUNCTION pactwoven.financial_immutable()',name);
 END LOOP;
 FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='pactwoven' AND p.proname LIKE 'native_work_intent_%' LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature);
 END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION pactwoven.native_work_intent_prepare(jsonb,text,jsonb),pactwoven.native_work_intent_confirm(jsonb,text,jsonb,jsonb),
 pactwoven.native_work_intent_recover(jsonb,text,text),pactwoven.native_work_intent_provenance(jsonb,jsonb) TO pactwoven_native_delegation_api;
COMMIT;
