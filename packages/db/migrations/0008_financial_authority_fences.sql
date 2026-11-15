BEGIN;

-- No new family, authority grant, observer permission or financial executor is introduced.
CREATE FUNCTION pactwoven.financial_next_generation(value integer) RETURNS integer LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
BEGIN
 IF value IS NULL OR value<0 THEN RAISE EXCEPTION USING ERRCODE='FA004',MESSAGE='Bounded control generation required'; END IF;
 IF value=2147483647 THEN RAISE EXCEPTION USING ERRCODE='FA008',MESSAGE='Control generation exhausted'; END IF;
 RETURN value+1;
END $$;
CREATE FUNCTION pactwoven.financial_require_read_committed() RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION USING ERRCODE='FA001',MESSAGE='Fresh READ COMMITTED control observations required'; END IF;
END $$;
CREATE FUNCTION pactwoven.financial_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION USING ERRCODE='FA007',MESSAGE='Financial fence history and enduring identity are immutable'; END $$;
CREATE FUNCTION pactwoven.financial_legacy_reference(value jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT CASE WHEN value IS NULL THEN NULL ELSE jsonb_build_object('mandateId',value->>'mandateId','mandateVersion',value->'mandateVersion',
  'mandateEpoch',value->'mandateEpoch','state',value->>'state','hash',pactwoven.finance_hash(value)) END
$$;
CREATE TABLE pactwoven.financial_authority_fences (
 environment text NOT NULL, organization_id text NOT NULL, responsibility_id text NOT NULL,
 generation integer NOT NULL CHECK(generation>=0), family text NOT NULL CHECK(family IN ('none','legacy')),
 responsibility_version integer NOT NULL CHECK(responsibility_version>0), responsibility_hash text NOT NULL CHECK(responsibility_hash~'^[a-f0-9]{64}$'), site_id text NOT NULL,
 legacy_head jsonb,
 PRIMARY KEY(environment,organization_id,responsibility_id),
 FOREIGN KEY(environment,organization_id,responsibility_id,responsibility_version,site_id) REFERENCES pactwoven.mandate_responsibility_versions(environment,organization_id,responsibility_id,version,site_id) DEFERRABLE INITIALLY DEFERRED,
 CHECK((family='none' AND legacy_head IS NULL) OR (family='legacy' AND jsonb_typeof(legacy_head)='object'))
);
CREATE FUNCTION pactwoven.financial_authority_snapshot(f pactwoven.financial_authority_fences) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('schemaVersion',1,'environment',f.environment,'organizationId',f.organization_id,'responsibility',
  jsonb_build_object('id',f.responsibility_id,'version',f.responsibility_version,'hash',f.responsibility_hash,'siteId',f.site_id),
  'generation',f.generation,'family',f.family,'legacyHead',pactwoven.financial_legacy_reference(f.legacy_head))
$$;
CREATE FUNCTION pactwoven.financial_authority_fence_hash(f pactwoven.financial_authority_fences) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT pactwoven.finance_hash(jsonb_build_object('namespace','pactwoven:financial-authority-fence:v1','record',pactwoven.financial_authority_snapshot(f)))
$$;
CREATE TABLE pactwoven.financial_authority_history (
 environment text NOT NULL, organization_id text NOT NULL, responsibility_id text NOT NULL, generation integer NOT NULL CHECK(generation>=0),
 previous_snapshot jsonb, snapshot jsonb NOT NULL, basis text NOT NULL CHECK(basis IN ('initial','migration_backfill','responsibility_change','legacy_head')),
 operation_id text, legacy_body jsonb, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(environment,organization_id,responsibility_id,generation),
 FOREIGN KEY(environment,organization_id,responsibility_id) REFERENCES pactwoven.financial_authority_fences(environment,organization_id,responsibility_id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(environment,organization_id,operation_id) REFERENCES pactwoven.mandate_operations(environment,organization_id,id) DEFERRABLE INITIALLY DEFERRED,
 CHECK((snapshot->'generation'=to_jsonb(generation) AND snapshot->>'environment'=environment AND snapshot->>'organizationId'=organization_id AND snapshot#>>'{responsibility,id}'=responsibility_id) IS TRUE),
 CHECK((generation=0 AND previous_snapshot IS NULL AND basis IN ('initial','migration_backfill')) OR(generation>0 AND previous_snapshot IS NOT NULL AND basis IN ('responsibility_change','legacy_head'))),
 CHECK((basis='legacy_head' AND operation_id IS NOT NULL AND legacy_body IS NOT NULL) OR
  (basis='migration_backfill' AND (operation_id IS NULL)=(legacy_body IS NULL)) OR(basis IN ('initial','responsibility_change') AND operation_id IS NULL))
);

-- Backfill only what actually exists; generation zero is not a fabricated authority epoch.
INSERT INTO pactwoven.financial_authority_fences
 SELECT r.environment,r.organization_id,r.id,0,CASE WHEN h.id IS NULL THEN 'none' ELSE 'legacy' END,r.row_version,
  pactwoven.finance_hash(pactwoven.mandate_responsibility_body(r)),r.site_id,h.body
 FROM pactwoven.responsibilities r LEFT JOIN pactwoven.mandate_heads h ON(h.environment,h.organization_id,h.responsibility_id)=(r.environment,r.organization_id,r.id);
INSERT INTO pactwoven.financial_authority_history(environment,organization_id,responsibility_id,generation,previous_snapshot,snapshot,basis,operation_id,legacy_body)
 SELECT f.environment,f.organization_id,f.responsibility_id,0,NULL,pactwoven.financial_authority_snapshot(f),'migration_backfill',a.operation_id,f.legacy_head
 FROM pactwoven.financial_authority_fences f LEFT JOIN pactwoven.mandate_audit a ON(a.environment,a.organization_id,a.responsibility_id)=(f.environment,f.organization_id,f.responsibility_id)
 AND a.body#>'{history,head}'=f.legacy_head;

CREATE FUNCTION pactwoven.financial_authority_change_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF (NEW.environment,NEW.organization_id,NEW.responsibility_id) IS DISTINCT FROM (OLD.environment,OLD.organization_id,OLD.responsibility_id)
  OR NEW.generation<>pactwoven.financial_next_generation(OLD.generation) THEN RAISE EXCEPTION USING ERRCODE='FA007',MESSAGE='Exact authority fence predecessor required'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER financial_authority_change BEFORE UPDATE ON pactwoven.financial_authority_fences FOR EACH ROW EXECUTE FUNCTION pactwoven.financial_authority_change_guard();

CREATE FUNCTION pactwoven.financial_authority_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE f pactwoven.financial_authority_fences%ROWTYPE; h pactwoven.financial_authority_history%ROWTYPE; prior pactwoven.financial_authority_history%ROWTYPE;
 r pactwoven.responsibilities%ROWTYPE; v jsonb; head jsonb; audit pactwoven.mandate_audit%ROWTYPE;
BEGIN
 SELECT * INTO f FROM pactwoven.financial_authority_fences WHERE(environment,organization_id,responsibility_id)=(NEW.environment,NEW.organization_id,NEW.responsibility_id);
 SELECT * INTO h FROM pactwoven.financial_authority_history WHERE(environment,organization_id,responsibility_id,generation)=(NEW.environment,NEW.organization_id,NEW.responsibility_id,NEW.generation);
 IF h.snapshot IS NULL OR f.responsibility_id IS NULL OR f.generation<NEW.generation THEN RAISE EXCEPTION USING ERRCODE='FA007',MESSAGE='Every authority transition requires immutable history'; END IF;
 IF TG_TABLE_NAME='financial_authority_fences' THEN
  IF h.snapshot IS DISTINCT FROM pactwoven.financial_authority_snapshot(NEW) OR h.legacy_body IS DISTINCT FROM NEW.legacy_head THEN RAISE EXCEPTION USING ERRCODE='FA007',MESSAGE='Authority transition differs from its history'; END IF;
  IF TG_OP='UPDATE' AND h.previous_snapshot IS DISTINCT FROM pactwoven.financial_authority_snapshot(OLD) THEN RAISE EXCEPTION USING ERRCODE='FA007',MESSAGE='Authority history omitted a predecessor'; END IF;
 ELSE
  IF h.snapshot IS DISTINCT FROM NEW.snapshot OR h.previous_snapshot IS DISTINCT FROM NEW.previous_snapshot THEN RAISE EXCEPTION USING ERRCODE='FA007',MESSAGE='Immutable transition changed'; END IF;
 END IF;
 SELECT body INTO v FROM pactwoven.mandate_responsibility_versions WHERE(environment,organization_id,responsibility_id,version)=(h.environment,h.organization_id,h.responsibility_id,(h.snapshot#>>'{responsibility,version}')::integer);
 IF v IS NULL OR h.snapshot#>>'{responsibility,hash}' IS DISTINCT FROM pactwoven.finance_hash(v) OR h.snapshot#>>'{responsibility,siteId}' IS DISTINCT FROM v->>'siteId'
  OR h.snapshot->'legacyHead' IS DISTINCT FROM coalesce(pactwoven.financial_legacy_reference(h.legacy_body),'null'::jsonb)
  OR h.snapshot->>'family' IS DISTINCT FROM (CASE WHEN h.legacy_body IS NULL THEN 'none' ELSE 'legacy' END) THEN RAISE EXCEPTION USING ERRCODE='FA007',MESSAGE='Authority history requires exact source records'; END IF;
 IF h.generation>0 THEN
  SELECT * INTO prior FROM pactwoven.financial_authority_history WHERE(environment,organization_id,responsibility_id,generation)=(h.environment,h.organization_id,h.responsibility_id,h.generation-1);
  IF prior.snapshot IS NULL OR h.previous_snapshot IS DISTINCT FROM prior.snapshot THEN RAISE EXCEPTION USING ERRCODE='FA007',MESSAGE='Authority history must be contiguous'; END IF;
  IF h.basis='responsibility_change' AND (h.legacy_body IS DISTINCT FROM prior.legacy_body OR (h.snapshot#>>'{responsibility,version}')::integer<>(prior.snapshot#>>'{responsibility,version}')::integer+1) THEN RAISE EXCEPTION USING ERRCODE='FA007',MESSAGE='Responsibility invalidation cannot replace authority'; END IF;
  IF h.basis='legacy_head' AND h.snapshot->'responsibility' IS DISTINCT FROM prior.snapshot->'responsibility' THEN RAISE EXCEPTION USING ERRCODE='FA007',MESSAGE='Legacy authority cannot replace responsibility scope'; END IF;
 END IF;
 IF h.basis='initial' AND h.legacy_body IS NOT NULL THEN RAISE EXCEPTION USING ERRCODE='FA007',MESSAGE='New responsibilities begin with no authority'; END IF;
 IF h.legacy_body IS NOT NULL AND h.basis IN ('legacy_head','migration_backfill') THEN
  SELECT * INTO audit FROM pactwoven.mandate_audit WHERE(environment,organization_id,responsibility_id,operation_id)=(h.environment,h.organization_id,h.responsibility_id,h.operation_id) AND body#>'{history,head}'=h.legacy_body;
  IF audit.id IS NULL THEN RAISE EXCEPTION USING ERRCODE='FA007',MESSAGE='Legacy selection requires its original exact authority audit'; END IF;
  IF h.basis='legacy_head' AND audit.body#>'{history,previousHead}' IS DISTINCT FROM (CASE WHEN h.previous_snapshot->'legacyHead'='null'::jsonb THEN 'null'::jsonb ELSE (h.previous_snapshot->'legacyHead')-'state' END) THEN RAISE EXCEPTION USING ERRCODE='FA007',MESSAGE='Legacy selection omitted its exact prior head'; END IF;
 END IF;
 SELECT * INTO r FROM pactwoven.responsibilities WHERE(environment,organization_id,id)=(f.environment,f.organization_id,f.responsibility_id);
 SELECT body INTO head FROM pactwoven.mandate_heads WHERE(environment,organization_id,responsibility_id)=(f.environment,f.organization_id,f.responsibility_id);
 IF f.legacy_head IS DISTINCT FROM head OR f.responsibility_hash IS DISTINCT FROM pactwoven.finance_hash(pactwoven.mandate_responsibility_body(r))
  OR NOT EXISTS(SELECT 1 FROM pactwoven.financial_authority_history last WHERE(last.environment,last.organization_id,last.responsibility_id,last.generation)=(f.environment,f.organization_id,f.responsibility_id,f.generation)
   AND last.snapshot=pactwoven.financial_authority_snapshot(f) AND last.legacy_body IS NOT DISTINCT FROM f.legacy_head)
  OR EXISTS(SELECT 1 FROM pactwoven.financial_authority_history later WHERE(later.environment,later.organization_id,later.responsibility_id)=(f.environment,f.organization_id,f.responsibility_id) AND later.generation>f.generation)
 THEN RAISE EXCEPTION USING ERRCODE='FA007',MESSAGE='Canonical authority does not match current source and final history'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER financial_authority_complete AFTER INSERT OR UPDATE ON pactwoven.financial_authority_fences DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pactwoven.financial_authority_complete();
CREATE CONSTRAINT TRIGGER financial_authority_history_complete AFTER INSERT ON pactwoven.financial_authority_history DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pactwoven.financial_authority_complete();

CREATE FUNCTION pactwoven.financial_responsibility_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 PERFORM pactwoven.financial_require_read_committed();
 -- Raw owner DML cannot repair row-first ordering. Fail instead of waiting backwards.
 PERFORM id FROM pactwoven.organizations WHERE(environment,id)=(OLD.environment,OLD.organization_id) FOR UPDATE NOWAIT;
 PERFORM id FROM pactwoven.sites WHERE(environment,organization_id)=(OLD.environment,OLD.organization_id) AND id IN(OLD.site_id,NEW.site_id) ORDER BY id FOR SHARE;
 PERFORM responsibility_id FROM pactwoven.financial_authority_fences WHERE(environment,organization_id,responsibility_id)=(OLD.environment,OLD.organization_id,OLD.id) FOR UPDATE;
 RETURN NEW;
END $$;
CREATE TRIGGER financial_responsibility_before_update BEFORE UPDATE ON pactwoven.responsibilities FOR EACH ROW EXECUTE FUNCTION pactwoven.financial_responsibility_guard();
CREATE FUNCTION pactwoven.financial_capture_responsibility() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE f pactwoven.financial_authority_fences%ROWTYPE; previous jsonb;
BEGIN
 PERFORM pactwoven.financial_require_read_committed();
 IF TG_OP='INSERT' THEN
  -- Creation already holds the foundation scope; do not upgrade the organization SHARE lock.
  INSERT INTO pactwoven.financial_authority_fences VALUES(NEW.environment,NEW.organization_id,NEW.id,0,'none',NEW.row_version,pactwoven.finance_hash(pactwoven.mandate_responsibility_body(NEW)),NEW.site_id,NULL) RETURNING * INTO f;
 ELSE
  SELECT pactwoven.financial_authority_snapshot(x) INTO previous FROM pactwoven.financial_authority_fences x WHERE(environment,organization_id,responsibility_id)=(NEW.environment,NEW.organization_id,NEW.id);
  UPDATE pactwoven.financial_authority_fences SET generation=pactwoven.financial_next_generation(generation),responsibility_version=NEW.row_version,
   responsibility_hash=pactwoven.finance_hash(pactwoven.mandate_responsibility_body(NEW)),site_id=NEW.site_id
   WHERE(environment,organization_id,responsibility_id)=(NEW.environment,NEW.organization_id,NEW.id) RETURNING * INTO f;
  IF f.responsibility_id IS NULL THEN RAISE EXCEPTION USING ERRCODE='FA007',MESSAGE='Missing authority fence'; END IF;
 END IF;
 INSERT INTO pactwoven.financial_authority_history(environment,organization_id,responsibility_id,generation,previous_snapshot,snapshot,basis,legacy_body)
 VALUES(f.environment,f.organization_id,f.responsibility_id,f.generation,previous,pactwoven.financial_authority_snapshot(f),CASE WHEN TG_OP='INSERT' THEN 'initial' ELSE 'responsibility_change' END,f.legacy_head);
 RETURN NEW;
END $$;
CREATE TRIGGER financial_responsibility_capture AFTER INSERT OR UPDATE ON pactwoven.responsibilities FOR EACH ROW EXECUTE FUNCTION pactwoven.financial_capture_responsibility();

CREATE FUNCTION pactwoven.financial_site_record_hash(value jsonb) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT pactwoven.finance_hash(jsonb_build_object('namespace','pactwoven:financial-site-record:v1','record',value))
$$;
CREATE TABLE pactwoven.financial_site_fences (
 environment text NOT NULL, organization_id text NOT NULL, site_id text NOT NULL, generation integer NOT NULL CHECK(generation>=0),
 active boolean NOT NULL, record jsonb NOT NULL, record_hash text GENERATED ALWAYS AS(pactwoven.financial_site_record_hash(record)) STORED,
 PRIMARY KEY(environment,organization_id,site_id), FOREIGN KEY(environment,organization_id,site_id) REFERENCES pactwoven.sites(environment,organization_id,id)
);
CREATE FUNCTION pactwoven.financial_site_snapshot(f pactwoven.financial_site_fences) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('schemaVersion',1,'environment',f.environment,'organizationId',f.organization_id,'siteId',f.site_id,'generation',f.generation,'active',f.active,'recordHash',f.record_hash)
$$;
CREATE TABLE pactwoven.financial_site_history (
 environment text NOT NULL, organization_id text NOT NULL, site_id text NOT NULL, generation integer NOT NULL CHECK(generation>=0),
 previous_snapshot jsonb, snapshot jsonb NOT NULL, record jsonb NOT NULL, basis text NOT NULL CHECK(basis IN ('initial','migration_backfill','change')), recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(environment,organization_id,site_id,generation), FOREIGN KEY(environment,organization_id,site_id) REFERENCES pactwoven.financial_site_fences(environment,organization_id,site_id),
 CHECK((generation=0 AND previous_snapshot IS NULL AND basis IN ('initial','migration_backfill')) OR(generation>0 AND previous_snapshot IS NOT NULL AND basis='change'))
);
INSERT INTO pactwoven.financial_site_fences(environment,organization_id,site_id,generation,active,record) SELECT environment,organization_id,id,0,true,to_jsonb(s) FROM pactwoven.sites s;
INSERT INTO pactwoven.financial_site_history(environment,organization_id,site_id,generation,snapshot,record,basis)
 SELECT environment,organization_id,site_id,generation,pactwoven.financial_site_snapshot(f),record,'migration_backfill' FROM pactwoven.financial_site_fences f;
CREATE FUNCTION pactwoven.financial_site_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 PERFORM pactwoven.financial_require_read_committed();
 PERFORM id FROM pactwoven.organizations WHERE(environment,id)=(OLD.environment,OLD.organization_id) FOR UPDATE NOWAIT;
 IF (NEW.environment,NEW.organization_id,NEW.id) IS DISTINCT FROM (OLD.environment,OLD.organization_id,OLD.id) THEN RAISE EXCEPTION USING ERRCODE='FA007',MESSAGE='Site identity cannot be reassigned'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER financial_site_before_update BEFORE UPDATE ON pactwoven.sites FOR EACH ROW EXECUTE FUNCTION pactwoven.financial_site_guard();
CREATE FUNCTION pactwoven.financial_capture_site() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 PERFORM pactwoven.financial_require_read_committed();
 IF TG_OP='INSERT' THEN INSERT INTO pactwoven.financial_site_fences(environment,organization_id,site_id,generation,active,record) VALUES(NEW.environment,NEW.organization_id,NEW.id,0,true,to_jsonb(NEW));
 ELSIF to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
  UPDATE pactwoven.financial_site_fences SET generation=pactwoven.financial_next_generation(generation),record=to_jsonb(NEW) WHERE(environment,organization_id,site_id)=(NEW.environment,NEW.organization_id,NEW.id);
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='FA007',MESSAGE='Missing site fence'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER financial_site_capture AFTER INSERT OR UPDATE ON pactwoven.sites FOR EACH ROW EXECUTE FUNCTION pactwoven.financial_capture_site();
CREATE FUNCTION pactwoven.financial_site_fence_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF (NEW.environment,NEW.organization_id,NEW.site_id) IS DISTINCT FROM (OLD.environment,OLD.organization_id,OLD.site_id)
  OR NEW.generation<>pactwoven.financial_next_generation(OLD.generation) OR (NEW.active=OLD.active AND NEW.record=OLD.record) THEN RAISE EXCEPTION USING ERRCODE='FA007',MESSAGE='Exact changed site control required'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER financial_site_fence_change BEFORE UPDATE ON pactwoven.financial_site_fences FOR EACH ROW EXECUTE FUNCTION pactwoven.financial_site_fence_guard();
CREATE FUNCTION pactwoven.financial_capture_site_fence() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 INSERT INTO pactwoven.financial_site_history(environment,organization_id,site_id,generation,previous_snapshot,snapshot,record,basis)
 VALUES(NEW.environment,NEW.organization_id,NEW.site_id,NEW.generation,CASE WHEN TG_OP='UPDATE' THEN pactwoven.financial_site_snapshot(OLD) ELSE NULL END,
  pactwoven.financial_site_snapshot(NEW),NEW.record,CASE WHEN TG_OP='UPDATE' THEN 'change' ELSE 'initial' END);
 RETURN NEW;
END $$;
CREATE TRIGGER financial_site_fence_capture AFTER INSERT OR UPDATE ON pactwoven.financial_site_fences FOR EACH ROW EXECUTE FUNCTION pactwoven.financial_capture_site_fence();
CREATE FUNCTION pactwoven.financial_site_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE f pactwoven.financial_site_fences%ROWTYPE; h pactwoven.financial_site_history%ROWTYPE; body jsonb;
BEGIN
 SELECT * INTO f FROM pactwoven.financial_site_fences WHERE(environment,organization_id,site_id)=(NEW.environment,NEW.organization_id,NEW.site_id);
 SELECT * INTO h FROM pactwoven.financial_site_history WHERE(environment,organization_id,site_id,generation)=(NEW.environment,NEW.organization_id,NEW.site_id,NEW.generation);
 SELECT to_jsonb(s) INTO body FROM pactwoven.sites s WHERE(environment,organization_id,id)=(f.environment,f.organization_id,f.site_id);
 IF h.snapshot IS NULL OR f.generation<NEW.generation OR body IS DISTINCT FROM f.record OR
  h.snapshot IS DISTINCT FROM jsonb_build_object('schemaVersion',1,'environment',h.environment,'organizationId',h.organization_id,'siteId',h.site_id,'generation',h.generation,'active',h.snapshot->'active','recordHash',pactwoven.financial_site_record_hash(h.record)) OR jsonb_typeof(h.snapshot->'active') IS DISTINCT FROM 'boolean'
  THEN RAISE EXCEPTION USING ERRCODE='FA007',MESSAGE='Exact site source and control history required'; END IF;
 IF TG_TABLE_NAME='financial_site_fences' THEN
  IF h.snapshot IS DISTINCT FROM pactwoven.financial_site_snapshot(NEW) OR h.record IS DISTINCT FROM NEW.record THEN RAISE EXCEPTION USING ERRCODE='FA007',MESSAGE='Site transition missing history'; END IF;
  IF TG_OP='UPDATE' AND h.previous_snapshot IS DISTINCT FROM pactwoven.financial_site_snapshot(OLD) THEN RAISE EXCEPTION USING ERRCODE='FA007',MESSAGE='Site predecessor omitted'; END IF;
 END IF;
 IF h.generation>0 AND NOT EXISTS(SELECT 1 FROM pactwoven.financial_site_history p WHERE(p.environment,p.organization_id,p.site_id,p.generation)=(h.environment,h.organization_id,h.site_id,h.generation-1) AND p.snapshot=h.previous_snapshot)
  OR NOT EXISTS(SELECT 1 FROM pactwoven.financial_site_history last WHERE(last.environment,last.organization_id,last.site_id,last.generation)=(f.environment,f.organization_id,f.site_id,f.generation) AND last.snapshot=pactwoven.financial_site_snapshot(f))
  OR EXISTS(SELECT 1 FROM pactwoven.financial_site_history later WHERE(later.environment,later.organization_id,later.site_id)=(f.environment,f.organization_id,f.site_id) AND later.generation>f.generation)
 THEN RAISE EXCEPTION USING ERRCODE='FA007',MESSAGE='Site history is not contiguous and current'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER financial_site_complete AFTER INSERT OR UPDATE ON pactwoven.financial_site_fences DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pactwoven.financial_site_complete();
CREATE CONSTRAINT TRIGGER financial_site_history_complete AFTER INSERT ON pactwoven.financial_site_history DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pactwoven.financial_site_complete();

-- Exact legacy result recovery still resolves successfully; only new writes check the family.
CREATE OR REPLACE FUNCTION pactwoven.mandate_resolve_context(p_environment text,p_identity jsonb,p_responsibility text,p_write boolean,p_trace text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE o pactwoven.organizations%ROWTYPE; m pactwoven.memberships%ROWTYPE; r pactwoven.responsibilities%ROWTYPE; requesters jsonb; at_time timestamptz;
BEGIN
 IF p_environment NOT IN ('simulation','development','staging','production') OR p_identity IS NULL OR coalesce(p_identity->>'sessionId','')='' THEN RAISE EXCEPTION USING ERRCODE='PM001',MESSAGE='Verified current identity required'; END IF;
 IF p_write THEN
  PERFORM pactwoven.financial_require_read_committed();
  PERFORM set_config('lock_timeout','4s',true);
  SELECT * INTO o FROM pactwoven.organizations WHERE environment=p_environment AND external_organization_id=p_identity->>'externalOrganizationId' FOR UPDATE;
  LOCK TABLE pactwoven.session_revocations IN SHARE MODE;
 ELSE
  SELECT * INTO o FROM pactwoven.organizations WHERE environment=p_environment AND external_organization_id=p_identity->>'externalOrganizationId' FOR SHARE;
 END IF;
 IF o.id IS NULL OR o.status<>'active' THEN RAISE EXCEPTION USING ERRCODE='PM001',MESSAGE='Current organization required'; END IF;
 PERFORM actor_id FROM pactwoven.memberships WHERE environment=p_environment AND organization_id=o.id ORDER BY actor_id FOR SHARE;
 SELECT * INTO m FROM pactwoven.memberships WHERE environment=p_environment AND organization_id=o.id AND external_subject=p_identity->>'subject' AND external_membership_id=p_identity->>'externalMembershipId';
 at_time:=clock_timestamp();
 IF m.actor_id IS NULL OR m.status<>'active' OR(m.expires_at IS NOT NULL AND m.expires_at<=at_time)
  OR(m.grant_basis='clerk_admin_bootstrap' AND p_identity->>'externalRole' IS DISTINCT FROM 'org:admin')
  OR coalesce(p_identity->>'membershipObservedAt','')='' OR(p_identity->>'membershipObservedAt')::timestamptz>at_time
  OR(p_identity->>'membershipObservedAt')::timestamptz<at_time-interval '20 seconds'
  OR EXISTS(SELECT 1 FROM pactwoven.session_revocations WHERE environment=p_environment AND session_id=p_identity->>'sessionId') THEN
  RAISE EXCEPTION USING ERRCODE='PM001',MESSAGE='Current organization membership and session required'; END IF;
 PERFORM set_config('pactwoven.environment',p_environment,true),set_config('pactwoven.organization_id',o.id,true),set_config('pactwoven.actor_id',m.actor_id,true),set_config('pactwoven.session_id',p_identity->>'sessionId',true);
 IF p_responsibility IS NOT NULL THEN
  SELECT * INTO r FROM pactwoven.responsibilities WHERE environment=p_environment AND organization_id=o.id AND id=p_responsibility FOR SHARE;
  IF r.id IS NULL OR NOT pactwoven.mandate_can_read(p_environment,o.id,r.id,r.site_id) THEN RAISE EXCEPTION USING ERRCODE='PM001',MESSAGE='Current responsibility read access required'; END IF;
  PERFORM set_config('pactwoven.mandate_responsibility_id',r.id,true),set_config('pactwoven.mandate_site_id',r.site_id,true);
  PERFORM id FROM pactwoven.sites WHERE environment=p_environment AND organization_id=o.id ORDER BY id FOR SHARE;
  IF p_write THEN
   PERFORM responsibility_id FROM pactwoven.financial_authority_fences WHERE(environment,organization_id,responsibility_id)=(p_environment,o.id,r.id) FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='FA007',MESSAGE='Missing canonical authority fence'; END IF;
  END IF;
  SELECT coalesce(jsonb_agg(pactwoven.mandate_actor_snapshot(p_environment,o.id,p.requester_id,p.requester_identity,p_trace)),'[]'::jsonb) INTO requesters
   FROM(SELECT DISTINCT ON(requester_id) requester_id,requester_identity FROM pactwoven.mandate_proposals WHERE environment=p_environment AND organization_id=o.id AND responsibility_id=r.id ORDER BY requester_id,version DESC)p;
 END IF;
 at_time:=clock_timestamp();
 IF (m.expires_at IS NOT NULL AND m.expires_at<=at_time) OR(p_identity->>'membershipObservedAt')::timestamptz<at_time-interval '20 seconds'
  OR EXISTS(SELECT 1 FROM pactwoven.session_revocations WHERE environment=p_environment AND session_id=p_identity->>'sessionId') THEN
  RAISE EXCEPTION USING ERRCODE='PM001',MESSAGE='Identity expired or was revoked while resolving authority'; END IF;
 RETURN jsonb_build_object('organizationId',o.id,'organizationEpoch',o.authority_epoch,'organizationStatus',o.status,'now',pactwoven.mandate_instant(at_time),
  'reader',pactwoven.mandate_actor_snapshot(p_environment,o.id,m.actor_id,p_identity,p_trace),'requesters',coalesce(requesters,'[]'::jsonb),
  'currentResponsibility',CASE WHEN r.id IS NULL THEN NULL ELSE pactwoven.mandate_responsibility_body(r) END,
  'sites',coalesce((SELECT jsonb_agg(jsonb_build_object('id',s.id,'organizationId',s.organization_id,'environment',s.environment,'name',s.name,'timeZone',s.time_zone,'active',coalesce((SELECT f.active FROM pactwoven.financial_site_fences f WHERE(f.environment,f.organization_id,f.site_id)=(s.environment,s.organization_id,s.id)),false)) ORDER BY s.id)
   FROM pactwoven.sites s WHERE s.environment=p_environment AND s.organization_id=o.id),'[]'::jsonb));
END $$;


CREATE FUNCTION pactwoven.financial_guard_legacy_mandate_write() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE f pactwoven.financial_authority_fences%ROWTYPE; external_org text; c jsonb:=nullif(current_setting('pactwoven.mandate_effect',true),'')::jsonb;
BEGIN
 PERFORM pactwoven.financial_require_read_committed();
 IF NEW.environment IS DISTINCT FROM current_setting('pactwoven.environment',true) OR NEW.organization_id IS DISTINCT FROM current_setting('pactwoven.organization_id',true)
  OR NEW.responsibility_id IS DISTINCT FROM c->>'responsibilityId' THEN RAISE EXCEPTION USING ERRCODE='FA001',MESSAGE='Exact legacy effect scope required before locking'; END IF;
 -- Direct SQL may already hold a head row; never wait backwards for its organization.
 SELECT external_organization_id INTO external_org FROM pactwoven.organizations WHERE(environment,id)=(NEW.environment,NEW.organization_id) FOR UPDATE NOWAIT;
 IF external_org IS NULL OR external_org IS DISTINCT FROM c#>>'{identity,externalOrganizationId}' THEN RAISE EXCEPTION USING ERRCODE='FA001',MESSAGE='Legacy scope cannot redirect an organization lock'; END IF;
 PERFORM pactwoven.mandate_resolve_context(NEW.environment,c->'identity',NEW.responsibility_id,true,'financial_legacy_fence');
 SELECT * INTO f FROM pactwoven.financial_authority_fences WHERE(environment,organization_id,responsibility_id)=(NEW.environment,NEW.organization_id,NEW.responsibility_id) FOR UPDATE;
 IF f.responsibility_id IS NULL OR f.family NOT IN ('none','legacy') THEN RAISE EXCEPTION USING ERRCODE='FA001',MESSAGE='Legacy writes require the selected legacy authority family'; END IF;
 IF c->>'kind' NOT IN ('mandate.pause','mandate.revoke') AND NOT EXISTS(SELECT 1 FROM pactwoven.financial_site_fences WHERE(environment,organization_id,site_id)=(f.environment,f.organization_id,f.site_id) AND active) THEN
  RAISE EXCEPTION USING ERRCODE='FA001',MESSAGE='New legacy authority work requires an active site'; END IF;
 IF TG_TABLE_NAME='mandate_heads' THEN
  IF TG_OP='INSERT' THEN
   IF f.family<>'none' OR f.legacy_head IS NOT NULL THEN RAISE EXCEPTION USING ERRCODE='FA002',MESSAGE='Initial legacy authority requires an empty canonical predecessor'; END IF;
  ELSIF f.family<>'legacy' OR f.legacy_head IS DISTINCT FROM OLD.body THEN RAISE EXCEPTION USING ERRCODE='FA002',MESSAGE='Legacy head differs from the exact canonical predecessor'; END IF;
 END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE item text; BEGIN
 FOREACH item IN ARRAY ARRAY['mandate_operations','mandate_policy_documents','mandate_proposals','mandate_decisions','mandate_versions','mandate_audit','mandate_outbox','mandate_heads'] LOOP
  EXECUTE format('CREATE TRIGGER financial_legacy_family_guard BEFORE INSERT OR UPDATE ON pactwoven.%I FOR EACH ROW EXECUTE FUNCTION pactwoven.financial_guard_legacy_mandate_write()',item);
 END LOOP;
END $$;
CREATE FUNCTION pactwoven.financial_capture_legacy_head() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE f pactwoven.financial_authority_fences%ROWTYPE; previous jsonb; op text:=nullif(current_setting('pactwoven.mandate_effect',true),'')::jsonb->>'operationId';
BEGIN
 SELECT pactwoven.financial_authority_snapshot(x) INTO previous FROM pactwoven.financial_authority_fences x WHERE(environment,organization_id,responsibility_id)=(NEW.environment,NEW.organization_id,NEW.responsibility_id);
 UPDATE pactwoven.financial_authority_fences SET generation=pactwoven.financial_next_generation(generation),family='legacy',legacy_head=NEW.body
  WHERE(environment,organization_id,responsibility_id)=(NEW.environment,NEW.organization_id,NEW.responsibility_id) RETURNING * INTO f;
 IF f.responsibility_id IS NULL OR op IS NULL THEN RAISE EXCEPTION USING ERRCODE='FA007',MESSAGE='Exact canonical legacy transition required'; END IF;
 INSERT INTO pactwoven.financial_authority_history(environment,organization_id,responsibility_id,generation,previous_snapshot,snapshot,basis,operation_id,legacy_body)
 VALUES(f.environment,f.organization_id,f.responsibility_id,f.generation,previous,pactwoven.financial_authority_snapshot(f),'legacy_head',op,NEW.body);
 RETURN NEW;
END $$;
CREATE TRIGGER financial_legacy_head_capture AFTER INSERT OR UPDATE ON pactwoven.mandate_heads FOR EACH ROW EXECUTE FUNCTION pactwoven.financial_capture_legacy_head();
CREATE FUNCTION pactwoven.financial_legacy_head_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE h pactwoven.financial_authority_history%ROWTYPE; count integer;
BEGIN
 SELECT count(*) INTO count FROM pactwoven.financial_authority_history WHERE(environment,organization_id,responsibility_id)=(NEW.environment,NEW.organization_id,NEW.responsibility_id) AND basis='legacy_head' AND legacy_body=NEW.body;
 SELECT * INTO h FROM pactwoven.financial_authority_history WHERE(environment,organization_id,responsibility_id)=(NEW.environment,NEW.organization_id,NEW.responsibility_id) AND basis='legacy_head' AND legacy_body=NEW.body;
 IF count<>1 OR (TG_OP='INSERT' AND h.previous_snapshot->>'family' IS DISTINCT FROM 'none') OR
  (TG_OP='UPDATE' AND h.previous_snapshot->'legacyHead' IS DISTINCT FROM pactwoven.financial_legacy_reference(OLD.body)) THEN
  RAISE EXCEPTION USING ERRCODE='FA007',MESSAGE='Every legacy head transition needs its own exact reciprocal canonical history'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER financial_legacy_head_complete AFTER INSERT OR UPDATE ON pactwoven.mandate_heads DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pactwoven.financial_legacy_head_complete();

CREATE FUNCTION pactwoven.financial_registry_control_body(value jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT CASE WHEN value->>'revoked_at' IS NULL THEN value ELSE jsonb_set(value,'{revoked_at}',to_jsonb(
  CASE WHEN isfinite((value->>'revoked_at')::timestamptz) THEN to_char((value->>'revoked_at')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  ELSE (value->>'revoked_at')::timestamptz::text END)) END
$$;
CREATE FUNCTION pactwoven.financial_registry_control_hash(value jsonb) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT pactwoven.finance_hash(jsonb_build_object('namespace','pactwoven:financial-registry-control:v1','record',pactwoven.financial_registry_control_body(value)))
$$;
CREATE TABLE pactwoven.financial_registry_history (
 kind text NOT NULL CHECK(kind IN ('asset','account','source','binding')), control_key text NOT NULL, account_key text NOT NULL DEFAULT '',
 generation integer NOT NULL CHECK(generation>=0), previous_snapshot jsonb, snapshot jsonb NOT NULL, control jsonb NOT NULL,
 basis text NOT NULL CHECK(basis IN ('initial','migration_backfill','change')), recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(kind,control_key,account_key,generation), CHECK((kind='binding')=(account_key<>'')),
 CHECK((generation=0 AND previous_snapshot IS NULL AND basis IN ('initial','migration_backfill')) OR(generation>0 AND previous_snapshot IS NOT NULL AND basis='change'))
);
CREATE TABLE pactwoven.financial_asset_fences (
 asset_key text NOT NULL, generation integer NOT NULL CHECK(generation>=0), control jsonb NOT NULL,
 control_hash text GENERATED ALWAYS AS(pactwoven.financial_registry_control_hash(control)) STORED,
 PRIMARY KEY(asset_key), FOREIGN KEY(asset_key) REFERENCES pactwoven.finance_asset_controls(asset_key)
);
INSERT INTO pactwoven.financial_asset_fences(asset_key,generation,control) SELECT asset_key,0,pactwoven.financial_registry_control_body(to_jsonb(c)) FROM pactwoven.finance_asset_controls c;
CREATE TABLE pactwoven.financial_account_fences (
 account_key text NOT NULL, generation integer NOT NULL CHECK(generation>=0), control jsonb NOT NULL,
 control_hash text GENERATED ALWAYS AS(pactwoven.financial_registry_control_hash(control)) STORED,
 PRIMARY KEY(account_key), FOREIGN KEY(account_key) REFERENCES pactwoven.finance_account_controls(account_key)
);
INSERT INTO pactwoven.financial_account_fences(account_key,generation,control) SELECT account_key,0,pactwoven.financial_registry_control_body(to_jsonb(c)) FROM pactwoven.finance_account_controls c;
CREATE TABLE pactwoven.financial_source_fences (
 source_id text NOT NULL, generation integer NOT NULL CHECK(generation>=0), control jsonb NOT NULL,
 control_hash text GENERATED ALWAYS AS(pactwoven.financial_registry_control_hash(control)) STORED,
 PRIMARY KEY(source_id), FOREIGN KEY(source_id) REFERENCES pactwoven.finance_source_controls(source_id)
);
INSERT INTO pactwoven.financial_source_fences(source_id,generation,control) SELECT source_id,0,pactwoven.financial_registry_control_body(to_jsonb(c)) FROM pactwoven.finance_source_controls c;
CREATE TABLE pactwoven.financial_source_binding_fences (
 source_id text NOT NULL,account_key text NOT NULL, generation integer NOT NULL CHECK(generation>=0), control jsonb NOT NULL,
 control_hash text GENERATED ALWAYS AS(pactwoven.financial_registry_control_hash(control)) STORED,
 PRIMARY KEY(source_id,account_key), FOREIGN KEY(source_id,account_key) REFERENCES pactwoven.finance_source_bindings(source_id,account_key)
);
INSERT INTO pactwoven.financial_source_binding_fences(source_id,account_key,generation,control) SELECT source_id,account_key,0,pactwoven.financial_registry_control_body(to_jsonb(c)) FROM pactwoven.finance_source_bindings c;
CREATE FUNCTION pactwoven.financial_registry_snapshot(kind text, key text, account text, generation integer, control jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('schemaVersion',1,'kind',kind,'key',key,'accountKey',nullif(account,''),'generation',generation,'controlHash',pactwoven.financial_registry_control_hash(control))
$$;
INSERT INTO pactwoven.financial_registry_history(kind,control_key,account_key,generation,snapshot,control,basis)
 SELECT 'asset',asset_key,'',generation,pactwoven.financial_registry_snapshot('asset',asset_key,'',generation,control),control,'migration_backfill' FROM pactwoven.financial_asset_fences;
INSERT INTO pactwoven.financial_registry_history(kind,control_key,account_key,generation,snapshot,control,basis)
 SELECT 'account',account_key,'',generation,pactwoven.financial_registry_snapshot('account',account_key,'',generation,control),control,'migration_backfill' FROM pactwoven.financial_account_fences;
INSERT INTO pactwoven.financial_registry_history(kind,control_key,account_key,generation,snapshot,control,basis)
 SELECT 'source',source_id,'',generation,pactwoven.financial_registry_snapshot('source',source_id,'',generation,control),control,'migration_backfill' FROM pactwoven.financial_source_fences;
INSERT INTO pactwoven.financial_registry_history(kind,control_key,account_key,generation,snapshot,control,basis)
 SELECT 'binding',source_id,account_key,generation,pactwoven.financial_registry_snapshot('binding',source_id,account_key,generation,control),control,'migration_backfill' FROM pactwoven.financial_source_binding_fences;

CREATE FUNCTION pactwoven.financial_capture_registry_control() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE kind text:=TG_ARGV[0]; fence_table text:=TG_ARGV[1]; key_name text:=TG_ARGV[2]; key text:=to_jsonb(NEW)->>key_name;
 account text:=CASE WHEN kind='binding' THEN to_jsonb(NEW)->>'account_key' ELSE '' END; previous jsonb; next integer; row jsonb; predicate text;
BEGIN
 PERFORM pactwoven.financial_require_read_committed();
 IF TG_OP='UPDATE' AND to_jsonb(OLD)=to_jsonb(NEW) THEN RETURN NEW; END IF;
 predicate:=format('%I=$1',key_name)||CASE WHEN kind='binding' THEN ' AND account_key=$2' ELSE '' END;
 IF TG_OP='INSERT' THEN
  EXECUTE format('INSERT INTO pactwoven.%I(%I,%s generation,control) VALUES($1,%s 0,$3) RETURNING to_jsonb(%I.*)',fence_table,key_name,CASE WHEN kind='binding' THEN 'account_key,' ELSE '' END,CASE WHEN kind='binding' THEN '$2,' ELSE '' END,fence_table) INTO row USING key,account,pactwoven.financial_registry_control_body(to_jsonb(NEW));
 ELSE
  EXECUTE format('SELECT to_jsonb(f) FROM pactwoven.%I f WHERE %s FOR UPDATE',fence_table,predicate) INTO row USING key,account;
  IF row IS NULL THEN RAISE EXCEPTION USING ERRCODE='FA007',MESSAGE='Missing registry control generation'; END IF;
  previous:=pactwoven.financial_registry_snapshot(kind,key,account,(row->>'generation')::integer,row->'control');
  EXECUTE format('UPDATE pactwoven.%I SET generation=pactwoven.financial_next_generation(generation),control=$3 WHERE %s RETURNING to_jsonb(%I.*)',fence_table,predicate,fence_table) INTO row USING key,account,pactwoven.financial_registry_control_body(to_jsonb(NEW));
 END IF;
 next:=(row->>'generation')::integer;
 INSERT INTO pactwoven.financial_registry_history(kind,control_key,account_key,generation,previous_snapshot,snapshot,control,basis)
 VALUES(kind,key,account,next,previous,pactwoven.financial_registry_snapshot(kind,key,account,next,pactwoven.financial_registry_control_body(to_jsonb(NEW))),pactwoven.financial_registry_control_body(to_jsonb(NEW)),CASE WHEN TG_OP='INSERT' THEN 'initial' ELSE 'change' END);
 RETURN NEW;
END $$;
CREATE FUNCTION pactwoven.financial_registry_fence_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF (to_jsonb(NEW)-ARRAY['generation','control','control_hash']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['generation','control','control_hash'])
  OR NEW.generation<>pactwoven.financial_next_generation(OLD.generation) OR NEW.control=OLD.control THEN RAISE EXCEPTION USING ERRCODE='FA007',MESSAGE='Exact changed registry predecessor required'; END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION pactwoven.financial_registry_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE fence_kind text; key text; account text; fence_table text; base_table text; key_name text; predicate text; f jsonb; h pactwoven.financial_registry_history%ROWTYPE; base jsonb;
BEGIN
 IF TG_TABLE_NAME='financial_registry_history' THEN fence_kind:=NEW.kind; key:=NEW.control_key; account:=NEW.account_key;
 ELSE fence_kind:=TG_ARGV[0]; key:=to_jsonb(NEW)->>TG_ARGV[1]; account:=CASE WHEN fence_kind='binding' THEN to_jsonb(NEW)->>'account_key' ELSE '' END; END IF;
 CASE fence_kind WHEN 'asset' THEN fence_table:='financial_asset_fences'; base_table:='finance_asset_controls'; key_name:='asset_key';
 WHEN 'account' THEN fence_table:='financial_account_fences'; base_table:='finance_account_controls'; key_name:='account_key';
 WHEN 'source' THEN fence_table:='financial_source_fences'; base_table:='finance_source_controls'; key_name:='source_id';
 WHEN 'binding' THEN fence_table:='financial_source_binding_fences'; base_table:='finance_source_bindings'; key_name:='source_id';
 ELSE RAISE EXCEPTION USING ERRCODE='FA007',MESSAGE='Unknown registry control'; END CASE;
 predicate:=format('%I=$1',key_name)||CASE WHEN fence_kind='binding' THEN ' AND account_key=$2' ELSE '' END;
 EXECUTE format('SELECT to_jsonb(f) FROM pactwoven.%I f WHERE %s',fence_table,predicate) INTO f USING key,account;
 EXECUTE format('SELECT pactwoven.financial_registry_control_body(to_jsonb(c)) FROM pactwoven.%I c WHERE %s',base_table,predicate) INTO base USING key,account;
 SELECT * INTO h FROM pactwoven.financial_registry_history x WHERE(x.kind,x.control_key,x.account_key,x.generation)=(fence_kind,key,account,NEW.generation);
 IF h.snapshot IS NULL OR f IS NULL OR (f->>'generation')::integer<h.generation OR f->'control' IS DISTINCT FROM base OR
 h.snapshot IS DISTINCT FROM pactwoven.financial_registry_snapshot(fence_kind,key,account,h.generation,h.control) THEN RAISE EXCEPTION USING ERRCODE='FA007',MESSAGE='Exact registry control and history required'; END IF;
 IF TG_TABLE_NAME<>'financial_registry_history' THEN
  IF h.snapshot IS DISTINCT FROM pactwoven.financial_registry_snapshot(fence_kind,key,account,NEW.generation,NEW.control) OR h.control IS DISTINCT FROM NEW.control THEN RAISE EXCEPTION USING ERRCODE='FA007',MESSAGE='Registry transition missing history'; END IF;
  IF TG_OP='UPDATE' AND h.previous_snapshot IS DISTINCT FROM pactwoven.financial_registry_snapshot(fence_kind,key,account,OLD.generation,OLD.control) THEN RAISE EXCEPTION USING ERRCODE='FA007',MESSAGE='Registry predecessor omitted'; END IF;
 END IF;
 IF h.generation>0 AND NOT EXISTS(SELECT 1 FROM pactwoven.financial_registry_history p WHERE(p.kind,p.control_key,p.account_key,p.generation)=(fence_kind,key,account,h.generation-1) AND p.snapshot=h.previous_snapshot)
  OR NOT EXISTS(SELECT 1 FROM pactwoven.financial_registry_history last WHERE(last.kind,last.control_key,last.account_key,last.generation)=(fence_kind,key,account,(f->>'generation')::integer) AND last.snapshot=pactwoven.financial_registry_snapshot(fence_kind,key,account,(f->>'generation')::integer,base))
  OR EXISTS(SELECT 1 FROM pactwoven.financial_registry_history later WHERE(later.kind,later.control_key,later.account_key)=(fence_kind,key,account) AND later.generation>(f->>'generation')::integer)
 THEN RAISE EXCEPTION USING ERRCODE='FA007',MESSAGE='Registry history is not contiguous and current'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER financial_registry_history_complete AFTER INSERT ON pactwoven.financial_registry_history DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pactwoven.financial_registry_complete();
CREATE TRIGGER financial_registry_capture AFTER INSERT OR UPDATE ON pactwoven.finance_asset_controls FOR EACH ROW EXECUTE FUNCTION pactwoven.financial_capture_registry_control('asset','financial_asset_fences','asset_key');
CREATE TRIGGER financial_registry_change BEFORE UPDATE ON pactwoven.financial_asset_fences FOR EACH ROW EXECUTE FUNCTION pactwoven.financial_registry_fence_guard();
CREATE CONSTRAINT TRIGGER financial_registry_complete AFTER INSERT OR UPDATE ON pactwoven.financial_asset_fences DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pactwoven.financial_registry_complete('asset','asset_key');
CREATE TRIGGER financial_registry_capture AFTER INSERT OR UPDATE ON pactwoven.finance_account_controls FOR EACH ROW EXECUTE FUNCTION pactwoven.financial_capture_registry_control('account','financial_account_fences','account_key');
CREATE TRIGGER financial_registry_change BEFORE UPDATE ON pactwoven.financial_account_fences FOR EACH ROW EXECUTE FUNCTION pactwoven.financial_registry_fence_guard();
CREATE CONSTRAINT TRIGGER financial_registry_complete AFTER INSERT OR UPDATE ON pactwoven.financial_account_fences DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pactwoven.financial_registry_complete('account','account_key');
CREATE TRIGGER financial_registry_capture AFTER INSERT OR UPDATE ON pactwoven.finance_source_controls FOR EACH ROW EXECUTE FUNCTION pactwoven.financial_capture_registry_control('source','financial_source_fences','source_id');
CREATE TRIGGER financial_registry_change BEFORE UPDATE ON pactwoven.financial_source_fences FOR EACH ROW EXECUTE FUNCTION pactwoven.financial_registry_fence_guard();
CREATE CONSTRAINT TRIGGER financial_registry_complete AFTER INSERT OR UPDATE ON pactwoven.financial_source_fences DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pactwoven.financial_registry_complete('source','source_id');
CREATE TRIGGER financial_registry_capture AFTER INSERT OR UPDATE ON pactwoven.finance_source_bindings FOR EACH ROW EXECUTE FUNCTION pactwoven.financial_capture_registry_control('binding','financial_source_binding_fences','source_id');
CREATE TRIGGER financial_registry_change BEFORE UPDATE ON pactwoven.financial_source_binding_fences FOR EACH ROW EXECUTE FUNCTION pactwoven.financial_registry_fence_guard();
CREATE CONSTRAINT TRIGGER financial_registry_complete AFTER INSERT OR UPDATE ON pactwoven.financial_source_binding_fences DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pactwoven.financial_registry_complete('binding','source_id');

-- Trusted maintenance procedures remain invoker-rights and ungranted. The caller must
-- execute the entire operation on one held connection; no provider calls belong here.
CREATE FUNCTION pactwoven.financial_update_site_control(e text,o text,s text,expected_generation integer,expected_hash text,new_name text,new_zone text,new_active boolean)
 RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog SET lock_timeout='4s' AS $$
DECLARE f pactwoven.financial_site_fences%ROWTYPE;
BEGIN
 PERFORM pactwoven.financial_require_read_committed();
 PERFORM id FROM pactwoven.organizations WHERE(environment,id)=(e,o) FOR UPDATE;
 PERFORM id FROM pactwoven.sites WHERE(environment,organization_id,id)=(e,o,s) FOR UPDATE;
 SELECT * INTO f FROM pactwoven.financial_site_fences WHERE(environment,organization_id,site_id)=(e,o,s) FOR UPDATE;
 IF f.site_id IS NULL OR f.generation IS DISTINCT FROM expected_generation OR f.record_hash IS DISTINCT FROM expected_hash THEN RAISE EXCEPTION USING ERRCODE='FA002',MESSAGE='Site control changed'; END IF;
 IF new_active IS NULL OR new_name IS NULL OR new_zone IS NULL OR NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=new_zone) THEN RAISE EXCEPTION USING ERRCODE='FA004',MESSAGE='Exact site configuration required'; END IF;
 UPDATE pactwoven.sites SET name=new_name,time_zone=new_zone WHERE(environment,organization_id,id)=(e,o,s) AND (name,time_zone) IS DISTINCT FROM (new_name,new_zone);
 UPDATE pactwoven.financial_site_fences SET generation=pactwoven.financial_next_generation(generation),active=new_active WHERE(environment,organization_id,site_id)=(e,o,s) AND active<>new_active;
 SELECT * INTO f FROM pactwoven.financial_site_fences WHERE(environment,organization_id,site_id)=(e,o,s);
 RETURN pactwoven.financial_site_snapshot(f);
END $$;
CREATE FUNCTION pactwoven.financial_update_asset_control(k text,expected_generation integer,expected_hash text,new_version integer,new_accepts boolean,new_revoked timestamptz)
 RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog SET lock_timeout='4s' AS $$
DECLARE f pactwoven.financial_asset_fences%ROWTYPE;
BEGIN
 PERFORM pactwoven.financial_require_read_committed();
 -- Global asset exception: no tenant, account, source or outbox lock follows this path.
 PERFORM asset_key FROM pactwoven.finance_physical_assets WHERE asset_key=k FOR UPDATE;
 PERFORM asset_key FROM pactwoven.finance_asset_controls WHERE asset_key=k FOR UPDATE;
 SELECT * INTO f FROM pactwoven.financial_asset_fences WHERE asset_key=k FOR UPDATE;
 IF f.asset_key IS NULL OR f.generation IS DISTINCT FROM expected_generation OR f.control_hash IS DISTINCT FROM expected_hash THEN RAISE EXCEPTION USING ERRCODE='FA002',MESSAGE='Asset control changed'; END IF;
 UPDATE pactwoven.finance_asset_controls SET current_version=new_version,accepts_observations=new_accepts,revoked_at=new_revoked WHERE asset_key=k;
 SELECT * INTO f FROM pactwoven.financial_asset_fences WHERE asset_key=k;
 RETURN pactwoven.financial_registry_snapshot('asset',k,'',f.generation,f.control);
END $$;
CREATE FUNCTION pactwoven.financial_update_account_control(k text,expected_generation integer,expected_hash text,new_version integer,new_accepts boolean,new_revoked timestamptz)
 RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog SET lock_timeout='4s' AS $$
DECLARE a pactwoven.finance_physical_accounts%ROWTYPE; f pactwoven.financial_account_fences%ROWTYPE; old_version integer; locked_version integer; asset text; assets text[];
BEGIN
 PERFORM pactwoven.financial_require_read_committed();
 SELECT * INTO a FROM pactwoven.finance_physical_accounts WHERE account_key=k;
 IF a.account_key IS NULL THEN RAISE EXCEPTION USING ERRCODE='FA002',MESSAGE='Account unavailable'; END IF;
 PERFORM id FROM pactwoven.organizations WHERE(environment,id)=(a.environment,a.organization_id) FOR UPDATE;
 SELECT current_version INTO old_version FROM pactwoven.finance_account_controls WHERE account_key=k;
 SELECT array_agg(DISTINCT asset_key ORDER BY asset_key) INTO assets FROM pactwoven.finance_account_versions WHERE account_key=k AND version IN(old_version,new_version);
 IF assets IS NULL OR NOT EXISTS(SELECT 1 FROM pactwoven.finance_account_versions WHERE account_key=k AND version=new_version) THEN RAISE EXCEPTION USING ERRCODE='FA004',MESSAGE='Registered account version required'; END IF;
 FOREACH asset IN ARRAY assets LOOP
  PERFORM asset_key FROM pactwoven.finance_physical_assets WHERE asset_key=asset FOR UPDATE;
  PERFORM asset_key FROM pactwoven.finance_asset_controls WHERE asset_key=asset FOR UPDATE;
  PERFORM asset_key FROM pactwoven.financial_asset_fences WHERE asset_key=asset FOR UPDATE;
 END LOOP;
 PERFORM account_key FROM pactwoven.finance_physical_accounts WHERE account_key=k FOR UPDATE;
 SELECT current_version INTO locked_version FROM pactwoven.finance_account_controls WHERE account_key=k FOR UPDATE;
 SELECT * INTO f FROM pactwoven.financial_account_fences WHERE account_key=k FOR UPDATE;
 IF locked_version IS DISTINCT FROM old_version OR f.account_key IS NULL OR f.generation IS DISTINCT FROM expected_generation OR f.control_hash IS DISTINCT FROM expected_hash THEN RAISE EXCEPTION USING ERRCODE='FA002',MESSAGE='Account control changed'; END IF;
 UPDATE pactwoven.finance_account_controls SET current_version=new_version,accepts_observations=new_accepts,revoked_at=new_revoked WHERE account_key=k;
 SELECT * INTO f FROM pactwoven.financial_account_fences WHERE account_key=k;
 RETURN pactwoven.financial_registry_snapshot('account',k,'',f.generation,f.control);
END $$;
CREATE FUNCTION pactwoven.financial_update_source_control(k text,expected_generation integer,expected_hash text,new_version integer,new_accepts boolean,new_revoked timestamptz)
 RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog SET lock_timeout='4s' AS $$
DECLARE s pactwoven.finance_sources%ROWTYPE; f pactwoven.financial_source_fences%ROWTYPE;
BEGIN
 PERFORM pactwoven.financial_require_read_committed();
 SELECT * INTO s FROM pactwoven.finance_sources WHERE source_id=k;
 IF s.source_id IS NULL THEN RAISE EXCEPTION USING ERRCODE='FA002',MESSAGE='Source unavailable'; END IF;
 PERFORM id FROM pactwoven.organizations WHERE(environment,id)=(s.environment,s.organization_id) FOR UPDATE;
 -- Valid source-only subsequence: this routine never subsequently seeks an account/asset.
 PERFORM source_id FROM pactwoven.finance_sources WHERE source_id=k FOR UPDATE;
 PERFORM source_id FROM pactwoven.finance_source_controls WHERE source_id=k FOR UPDATE;
 SELECT * INTO f FROM pactwoven.financial_source_fences WHERE source_id=k FOR UPDATE;
 IF f.source_id IS NULL OR f.generation IS DISTINCT FROM expected_generation OR f.control_hash IS DISTINCT FROM expected_hash THEN RAISE EXCEPTION USING ERRCODE='FA002',MESSAGE='Source control changed'; END IF;
 UPDATE pactwoven.finance_source_controls SET current_version=new_version,accepts_observations=new_accepts,revoked_at=new_revoked WHERE source_id=k;
 SELECT * INTO f FROM pactwoven.financial_source_fences WHERE source_id=k;
 RETURN pactwoven.financial_registry_snapshot('source',k,'',f.generation,f.control);
END $$;
CREATE FUNCTION pactwoven.financial_update_source_binding_control(k text,a_key text,expected_generation integer,expected_hash text,new_accepts boolean,new_revoked timestamptz)
 RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog SET lock_timeout='4s' AS $$
DECLARE a pactwoven.finance_physical_accounts%ROWTYPE; f pactwoven.financial_source_binding_fences%ROWTYPE; asset text; old_version integer; locked_version integer;
BEGIN
 PERFORM pactwoven.financial_require_read_committed();
 SELECT * INTO a FROM pactwoven.finance_physical_accounts WHERE account_key=a_key;
 IF a.account_key IS NULL THEN RAISE EXCEPTION USING ERRCODE='FA002',MESSAGE='Binding account unavailable'; END IF;
 PERFORM id FROM pactwoven.organizations WHERE(environment,id)=(a.environment,a.organization_id) FOR UPDATE;
 SELECT c.current_version,v.asset_key INTO old_version,asset FROM pactwoven.finance_account_controls c JOIN pactwoven.finance_account_versions v ON(v.account_key,v.version)=(c.account_key,c.current_version) WHERE c.account_key=a_key;
 PERFORM asset_key FROM pactwoven.finance_physical_assets WHERE asset_key=asset FOR UPDATE;
 PERFORM asset_key FROM pactwoven.finance_asset_controls WHERE asset_key=asset FOR UPDATE;
 PERFORM asset_key FROM pactwoven.financial_asset_fences WHERE asset_key=asset FOR UPDATE;
 PERFORM account_key FROM pactwoven.finance_physical_accounts WHERE account_key=a_key FOR UPDATE;
 SELECT current_version INTO locked_version FROM pactwoven.finance_account_controls WHERE account_key=a_key FOR UPDATE;
 PERFORM account_key FROM pactwoven.financial_account_fences WHERE account_key=a_key FOR UPDATE;
 IF locked_version IS DISTINCT FROM old_version THEN RAISE EXCEPTION USING ERRCODE='FA002',MESSAGE='Binding account changed'; END IF;
 PERFORM source_id FROM pactwoven.finance_sources WHERE source_id=k AND (environment,organization_id)=(a.environment,a.organization_id) FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='FA002',MESSAGE='Same-tenant source required'; END IF;
 PERFORM source_id FROM pactwoven.finance_source_controls WHERE source_id=k FOR UPDATE;
 PERFORM source_id FROM pactwoven.financial_source_fences WHERE source_id=k FOR UPDATE;
 PERFORM source_id FROM pactwoven.finance_source_bindings WHERE(source_id,account_key)=(k,a_key) FOR UPDATE;
 SELECT * INTO f FROM pactwoven.financial_source_binding_fences WHERE(source_id,account_key)=(k,a_key) FOR UPDATE;
 IF f.source_id IS NULL OR f.generation IS DISTINCT FROM expected_generation OR f.control_hash IS DISTINCT FROM expected_hash THEN RAISE EXCEPTION USING ERRCODE='FA002',MESSAGE='Source binding changed'; END IF;
 UPDATE pactwoven.finance_source_bindings SET accepts_observations=new_accepts,revoked_at=new_revoked WHERE(source_id,account_key)=(k,a_key);
 SELECT * INTO f FROM pactwoven.financial_source_binding_fences WHERE(source_id,account_key)=(k,a_key);
 RETURN pactwoven.financial_registry_snapshot('binding',k,a_key,f.generation,f.control);
END $$;

SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
DO $$ DECLARE item text; routine regprocedure; BEGIN
 FOREACH item IN ARRAY ARRAY['financial_authority_fences','financial_authority_history','financial_site_fences','financial_site_history','financial_asset_fences','financial_account_fences','financial_source_fences','financial_source_binding_fences','financial_registry_history'] LOOP
  EXECUTE format('ALTER TABLE pactwoven.%I ENABLE ROW LEVEL SECURITY',item);
  EXECUTE format('REVOKE ALL ON pactwoven.%I FROM PUBLIC,pactwoven_runtime,pactwoven_provisioner,pactwoven_access_provisioner,pactwoven_mandate_writer,pactwoven_finance_observer',item);
  EXECUTE format('CREATE TRIGGER financial_no_truncate BEFORE TRUNCATE ON pactwoven.%I FOR EACH STATEMENT EXECUTE FUNCTION pactwoven.financial_immutable()',item);
  EXECUTE format('CREATE TRIGGER financial_no_delete BEFORE DELETE ON pactwoven.%I FOR EACH ROW EXECUTE FUNCTION pactwoven.financial_immutable()',item);
  IF item LIKE '%history' THEN EXECUTE format('CREATE TRIGGER financial_history_immutable BEFORE UPDATE ON pactwoven.%I FOR EACH ROW EXECUTE FUNCTION pactwoven.financial_immutable()',item); END IF;
 END LOOP;
 FOREACH item IN ARRAY ARRAY['sites','responsibilities'] LOOP
  EXECUTE format('CREATE TRIGGER financial_no_truncate BEFORE TRUNCATE ON pactwoven.%I FOR EACH STATEMENT EXECUTE FUNCTION pactwoven.financial_immutable()',item);
  EXECUTE format('CREATE TRIGGER financial_no_delete BEFORE DELETE ON pactwoven.%I FOR EACH ROW EXECUTE FUNCTION pactwoven.financial_immutable()',item);
 END LOOP;
 FOR routine IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='pactwoven' AND p.proname LIKE 'financial_%' LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,pactwoven_runtime,pactwoven_provisioner,pactwoven_access_provisioner,pactwoven_mandate_writer,pactwoven_finance_observer',routine);
 END LOOP;
END $$;

COMMIT;
