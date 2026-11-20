BEGIN;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='pactwoven_mandate_writer') THEN
    CREATE ROLE pactwoven_mandate_writer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;
GRANT USAGE ON SCHEMA pactwoven TO pactwoven_mandate_writer;

CREATE FUNCTION pactwoven.mandate_instant(value timestamptz) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT to_char(value AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;
CREATE FUNCTION pactwoven.mandate_responsibility_body(r pactwoven.responsibilities) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('id',r.id,'organizationId',r.organization_id,'environment',r.environment,'ownerId',r.owner_id,
  'siteId',r.site_id,'title',r.title,'description',r.description,'version',r.row_version,
  'window',jsonb_build_object('startsAt',pactwoven.mandate_instant(r.starts_at),'endsAt',pactwoven.mandate_instant(r.ends_at),'timeZone',r.time_zone),
  'requirements',r.requirements,'acceptancePolicy',r.acceptance_policy,'executionState',r.execution_state,'authorityState',r.authority_state,
  'coverageState',r.coverage_state,'createdAt',pactwoven.mandate_instant(r.created_at),'updatedAt',pactwoven.mandate_instant(r.updated_at))
$$;
CREATE FUNCTION pactwoven.mandate_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION USING ERRCODE='PM006',MESSAGE='Mandate history is immutable'; END $$;
CREATE TABLE pactwoven.mandate_responsibility_versions (
 environment text NOT NULL, organization_id text NOT NULL, responsibility_id text NOT NULL, version integer NOT NULL CHECK(version>0), site_id text NOT NULL,
 body jsonb NOT NULL CHECK(jsonb_typeof(body)='object'), captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 capture_basis text NOT NULL CHECK(capture_basis IN ('current_backfill','recorded_change')),
 PRIMARY KEY(environment,organization_id,responsibility_id,version),
 UNIQUE(environment,organization_id,responsibility_id,version,site_id),
 FOREIGN KEY(environment,organization_id,responsibility_id) REFERENCES pactwoven.responsibilities(environment,organization_id,id),
 FOREIGN KEY(environment,organization_id,site_id) REFERENCES pactwoven.sites(environment,organization_id,id)
);
CREATE TRIGGER mandate_responsibility_versions_immutable BEFORE UPDATE OR DELETE ON pactwoven.mandate_responsibility_versions FOR EACH ROW EXECUTE FUNCTION pactwoven.mandate_immutable();
CREATE FUNCTION pactwoven.mandate_capture_responsibility() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.environment IS DISTINCT FROM OLD.environment OR NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.id IS DISTINCT FROM OLD.id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.row_version<>OLD.row_version+1 OR NEW.updated_at<OLD.updated_at THEN
   RAISE EXCEPTION USING ERRCODE='PM002',MESSAGE='Responsibility changes require an immutable new version';
  END IF;
 END IF;
 INSERT INTO pactwoven.mandate_responsibility_versions(environment,organization_id,responsibility_id,version,site_id,body,capture_basis)
 VALUES(NEW.environment,NEW.organization_id,NEW.id,NEW.row_version,NEW.site_id,pactwoven.mandate_responsibility_body(NEW),'recorded_change');
 RETURN NEW;
END $$;
INSERT INTO pactwoven.mandate_responsibility_versions(environment,organization_id,responsibility_id,version,site_id,body,capture_basis)
 SELECT environment,organization_id,id,row_version,site_id,pactwoven.mandate_responsibility_body(r),'current_backfill' FROM pactwoven.responsibilities r;
CREATE TRIGGER mandate_responsibility_capture AFTER INSERT OR UPDATE ON pactwoven.responsibilities FOR EACH ROW EXECUTE FUNCTION pactwoven.mandate_capture_responsibility();

CREATE FUNCTION pactwoven.mandate_advise_only(policy jsonb,site text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT coalesce(jsonb_typeof(policy)='object' AND policy->>'mode'='ADVISE'
  AND policy-ARRAY['mode','siteIds','supplierRelationshipIds','actions','budgets','acceptancePolicy','communication','expiresAt']='{}'::jsonb
  AND policy->'siteIds'=jsonb_build_array(site) AND policy->'actions'='[]'::jsonb AND policy->'budgets'='[]'::jsonb
  AND policy->'supplierRelationshipIds'='[]'::jsonb AND jsonb_typeof(policy->'communication')='object'
  AND (policy->'communication')-ARRAY['recipientIds','purposes','messageKinds','maximumMessages','expiresAt']='{}'::jsonb
  AND policy#>'{communication,recipientIds}'='[]'::jsonb AND policy#>'{communication,purposes}'='[]'::jsonb
  AND policy#>'{communication,messageKinds}'='[]'::jsonb AND policy#>'{communication,maximumMessages}'='0'::jsonb
  AND jsonb_typeof(policy->'expiresAt')='string' AND jsonb_typeof(policy#>'{communication,expiresAt}')='string',false)
$$;
CREATE TABLE pactwoven.mandate_operations (
 environment text NOT NULL, organization_id text NOT NULL, id text NOT NULL, actor_id text NOT NULL, responsibility_id text NOT NULL, site_id text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('mandate.document.create','mandate.propose','mandate.authorize','mandate.reject','mandate.pause','mandate.revoke','mandate.resume')),
 idempotency_key text NOT NULL CHECK(idempotency_key ~ '^[A-Za-z0-9_-]{16,128}$'), command_hash text NOT NULL CHECK(command_hash ~ '^[a-f0-9]{64}$'),
 command jsonb NOT NULL CHECK(jsonb_typeof(command)='object'), result jsonb NOT NULL CHECK(jsonb_typeof(result)='object'),
 identity jsonb NOT NULL CHECK(jsonb_typeof(identity)='object'),
 effect_context jsonb NOT NULL CHECK(jsonb_typeof(effect_context)='object'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(environment,organization_id,id), UNIQUE(environment,organization_id,kind,idempotency_key),
 FOREIGN KEY(environment,organization_id,actor_id) REFERENCES pactwoven.memberships(environment,organization_id,actor_id),
 FOREIGN KEY(environment,organization_id,responsibility_id) REFERENCES pactwoven.responsibilities(environment,organization_id,id),
 FOREIGN KEY(environment,organization_id,site_id) REFERENCES pactwoven.sites(environment,organization_id,id),
 CHECK((result->>'organizationId'=organization_id AND result->>'responsibilityId'=responsibility_id AND result->>'kind'=kind
   AND result->>'commandHash'=command_hash AND result#>>'{operation,id}'=id AND result#>>'{operation,environment}'=environment
   AND result#>'{operation,financialState}'='null'::jsonb AND result#>>'{operation,status}'='succeeded') IS TRUE)
);
CREATE TABLE pactwoven.mandate_policy_documents (
 environment text NOT NULL, organization_id text NOT NULL, responsibility_id text NOT NULL, responsibility_version integer NOT NULL, site_id text NOT NULL, id text NOT NULL,
 version integer NOT NULL CHECK(version>0), hash text NOT NULL CHECK(hash ~ '^[a-f0-9]{64}$'), body jsonb NOT NULL, operation_id text NOT NULL,
 PRIMARY KEY(environment,organization_id,id,version),
 FOREIGN KEY(environment,organization_id,responsibility_id,responsibility_version,site_id) REFERENCES pactwoven.mandate_responsibility_versions(environment,organization_id,responsibility_id,version,site_id),
 FOREIGN KEY(environment,organization_id,site_id) REFERENCES pactwoven.sites(environment,organization_id,id),
 FOREIGN KEY(environment,organization_id,operation_id) REFERENCES pactwoven.mandate_operations(environment,organization_id,id) DEFERRABLE INITIALLY DEFERRED,
 CHECK((jsonb_typeof(body)='object' AND body->>'id'=id AND body->'version'=to_jsonb(version) AND body->>'hash'=hash
  AND body->>'organizationId'=organization_id AND body->>'environment'=environment AND body->>'normalization'='NFC_LF_V1'
  AND body->>'purpose' IN ('ACCEPTANCE_POLICY','MANDATE_POLICY') AND char_length(body->>'text') BETWEEN 1 AND 20000
  AND body->>'contentHash' ~ '^[a-f0-9]{64}$') IS TRUE)
);
CREATE TABLE pactwoven.mandate_proposals (
 environment text NOT NULL, organization_id text NOT NULL, responsibility_id text NOT NULL, responsibility_version integer NOT NULL, site_id text NOT NULL,
 id text NOT NULL, version integer NOT NULL CHECK(version>0), hash text NOT NULL CHECK(hash ~ '^[a-f0-9]{64}$'), mandate_id text NOT NULL,
 requester_id text NOT NULL, requester_identity jsonb NOT NULL, body jsonb NOT NULL, operation_id text NOT NULL,
 PRIMARY KEY(environment,organization_id,id,version),
 UNIQUE(environment,organization_id,id,version,responsibility_id,site_id),
 FOREIGN KEY(environment,organization_id,responsibility_id,responsibility_version,site_id) REFERENCES pactwoven.mandate_responsibility_versions(environment,organization_id,responsibility_id,version,site_id),
 FOREIGN KEY(environment,organization_id,site_id) REFERENCES pactwoven.sites(environment,organization_id,id),
 FOREIGN KEY(environment,organization_id,requester_id) REFERENCES pactwoven.memberships(environment,organization_id,actor_id),
 FOREIGN KEY(environment,organization_id,operation_id) REFERENCES pactwoven.mandate_operations(environment,organization_id,id) DEFERRABLE INITIALLY DEFERRED,
 CHECK((body->>'organizationId'=organization_id AND body->>'environment'=environment AND body->>'id'=id AND body->'version'=to_jsonb(version)
  AND body->>'hash'=hash AND body->>'mandateId'=mandate_id AND body->>'requesterId'=requester_id AND body#>>'{responsibility,id}'=responsibility_id
  AND body#>'{responsibility,version}'=to_jsonb(responsibility_version) AND body#>>'{responsibility,siteId}'=site_id
  AND pactwoven.mandate_advise_only(body->'policy',site_id)) IS TRUE)
);
CREATE TABLE pactwoven.mandate_decisions (
 environment text NOT NULL, organization_id text NOT NULL, responsibility_id text NOT NULL, site_id text NOT NULL,
 proposal_id text NOT NULL, proposal_version integer NOT NULL, version integer NOT NULL CHECK(version IN (1,2)), body jsonb NOT NULL, operation_id text NOT NULL,
 PRIMARY KEY(environment,organization_id,proposal_id,proposal_version,version),
 UNIQUE(environment,organization_id,proposal_id,proposal_version,version,responsibility_id,site_id),
 FOREIGN KEY(environment,organization_id,proposal_id,proposal_version,responsibility_id,site_id) REFERENCES pactwoven.mandate_proposals(environment,organization_id,id,version,responsibility_id,site_id),
 FOREIGN KEY(environment,organization_id,operation_id) REFERENCES pactwoven.mandate_operations(environment,organization_id,id) DEFERRABLE INITIALLY DEFERRED,
 CHECK((body#>>'{proposal,id}'=proposal_id AND body#>'{proposal,version}'=to_jsonb(proposal_version) AND body->'version'=to_jsonb(version)
   AND body->>'operationId'=operation_id AND ((version=1 AND body->>'state'='OPEN') OR (version=2 AND body->>'state' IN ('APPROVED','REJECTED','EXPIRED','SUPERSEDED')))) IS TRUE)
);
CREATE TABLE pactwoven.mandate_versions (
 environment text NOT NULL, organization_id text NOT NULL, responsibility_id text NOT NULL, site_id text NOT NULL, id text NOT NULL,
 version integer NOT NULL CHECK(version>0), proposal_id text NOT NULL, proposal_version integer NOT NULL, decision_version integer NOT NULL DEFAULT 2 CHECK(decision_version=2), body jsonb NOT NULL,
 PRIMARY KEY(environment,organization_id,id,version), UNIQUE(environment,organization_id,proposal_id,proposal_version),
 UNIQUE(environment,organization_id,id,version,responsibility_id),
 FOREIGN KEY(environment,organization_id,proposal_id,proposal_version,decision_version,responsibility_id,site_id) REFERENCES pactwoven.mandate_decisions(environment,organization_id,proposal_id,proposal_version,version,responsibility_id,site_id) DEFERRABLE INITIALLY DEFERRED,
 CHECK((body->>'id'=id AND body->'version'=to_jsonb(version) AND body->>'organizationId'=organization_id AND body->>'environment'=environment
  AND body->>'responsibilityId'=responsibility_id AND pactwoven.mandate_advise_only(body->'policy',site_id)) IS TRUE)
);
CREATE TABLE pactwoven.mandate_heads (
 environment text NOT NULL, organization_id text NOT NULL, responsibility_id text NOT NULL, id text NOT NULL, body jsonb NOT NULL,
 version integer GENERATED ALWAYS AS ((body->>'mandateVersion')::integer) STORED,
 epoch integer GENERATED ALWAYS AS ((body->>'mandateEpoch')::integer) STORED,
 PRIMARY KEY(environment,organization_id,id), UNIQUE(environment,organization_id,responsibility_id), CHECK(version>0 AND epoch>0),
 FOREIGN KEY(environment,organization_id,id,version,responsibility_id) REFERENCES pactwoven.mandate_versions(environment,organization_id,id,version,responsibility_id) DEFERRABLE INITIALLY DEFERRED,
 CHECK((body->>'mandateId'=id AND body->>'organizationId'=organization_id AND body->>'environment'=environment AND body->>'responsibilityId'=responsibility_id
  AND body->>'state' IN ('ACTIVE','PAUSED','REVOKED','EXPIRED')) IS TRUE)
);
CREATE TABLE pactwoven.mandate_audit (
 environment text NOT NULL, organization_id text NOT NULL, id text NOT NULL, responsibility_id text NOT NULL, site_id text NOT NULL,
 operation_id text NOT NULL, body jsonb NOT NULL,
 mandate_id text GENERATED ALWAYS AS (body#>>'{history,head,mandateId}') STORED,
 mandate_epoch integer GENERATED ALWAYS AS ((body#>>'{history,head,mandateEpoch}')::integer) STORED,
 PRIMARY KEY(environment,organization_id,id), UNIQUE(environment,organization_id,operation_id), UNIQUE(environment,organization_id,mandate_id,mandate_epoch),
 FOREIGN KEY(environment,organization_id,operation_id) REFERENCES pactwoven.mandate_operations(environment,organization_id,id) DEFERRABLE INITIALLY DEFERRED,
 CHECK((jsonb_typeof(body)='object' AND body->>'operationId'=operation_id AND body->>'kind' IN ('mandate.document.create','mandate.propose','mandate.authorize','mandate.reject','mandate.pause','mandate.revoke','mandate.resume')) IS TRUE)
);
CREATE TABLE pactwoven.mandate_outbox (
 environment text NOT NULL, organization_id text NOT NULL, id text NOT NULL, responsibility_id text NOT NULL, site_id text NOT NULL,
 operation_id text NOT NULL, event_type text NOT NULL CHECK(event_type IN ('mandate.document.create','mandate.propose','mandate.authorize','mandate.reject','mandate.pause','mandate.revoke','mandate.resume')),
 payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), delivered_at timestamptz CHECK(delivered_at IS NULL),
 PRIMARY KEY(environment,organization_id,id), UNIQUE(environment,organization_id,operation_id),
 FOREIGN KEY(environment,organization_id,operation_id) REFERENCES pactwoven.mandate_operations(environment,organization_id,id) DEFERRABLE INITIALLY DEFERRED
);

CREATE FUNCTION pactwoven.mandate_actor_snapshot(p_environment text,p_organization text,p_actor text,p_identity jsonb,p_trace text) RETURNS jsonb
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('actor',jsonb_build_object('actorId',m.actor_id,'principalKind','human','organizationId',m.organization_id,'environment',m.environment,
  'roles',m.roles,'siteIds',coalesce((SELECT jsonb_agg(s.id ORDER BY s.id) FROM pactwoven.sites s WHERE s.environment=m.environment AND s.organization_id=m.organization_id
   AND (m.roles&&ARRAY['owner','finance','auditor']::text[] OR EXISTS(SELECT 1 FROM pactwoven.site_memberships g WHERE(g.environment,g.organization_id,g.actor_id,g.site_id)=(m.environment,m.organization_id,m.actor_id,s.id)))),'[]'::jsonb),
  'actionSiteIds',coalesce((SELECT jsonb_agg(site_id ORDER BY site_id) FROM pactwoven.member_action_sites g WHERE(g.environment,g.organization_id,g.actor_id)=(m.environment,m.organization_id,m.actor_id)),'[]'::jsonb),
  'sessionId',p_identity->>'sessionId','authenticatedAt',p_identity->>'authenticatedAt','correlationId',p_trace),
  'status',m.status,'expiresAt',pactwoven.mandate_instant(m.expires_at),
  'assignedResponsibilityIds',coalesce((SELECT jsonb_agg(responsibility_id ORDER BY responsibility_id) FROM pactwoven.responsibility_assignments a
   WHERE(a.environment,a.organization_id,a.actor_id)=(m.environment,m.organization_id,m.actor_id)),'[]'::jsonb),
  'externalSubject',m.external_subject,'externalMembershipId',m.external_membership_id,'grantBasis',m.grant_basis)
 FROM pactwoven.memberships m WHERE(m.environment,m.organization_id,m.actor_id)=(p_environment,p_organization,p_actor)
$$;
CREATE FUNCTION pactwoven.mandate_can_read(p_environment text,p_organization text,p_responsibility text,p_site text) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT coalesce(p_environment=current_setting('pactwoven.environment',true) AND p_organization=current_setting('pactwoven.organization_id',true)
  AND EXISTS(SELECT 1 FROM pactwoven.memberships m JOIN pactwoven.organizations o ON(o.environment,o.id)=(m.environment,m.organization_id)
   WHERE m.environment=p_environment AND m.organization_id=p_organization AND m.actor_id=current_setting('pactwoven.actor_id',true)
    AND o.status='active' AND m.status='active' AND(m.expires_at IS NULL OR m.expires_at>clock_timestamp())
    AND NOT EXISTS(SELECT 1 FROM pactwoven.session_revocations v WHERE v.environment=p_environment AND v.session_id=current_setting('pactwoven.session_id',true))
    AND coalesce(current_setting('pactwoven.session_id',true),'')<>'' AND (m.roles&&ARRAY['owner','operations','finance','auditor']::text[]
     OR ('receiver'=ANY(m.roles) AND EXISTS(SELECT 1 FROM pactwoven.responsibility_assignments a WHERE(a.environment,a.organization_id,a.responsibility_id,a.actor_id)=(p_environment,p_organization,p_responsibility,m.actor_id))))
    AND(m.roles&&ARRAY['owner','finance','auditor']::text[] OR EXISTS(SELECT 1 FROM pactwoven.site_memberships g WHERE(g.environment,g.organization_id,g.actor_id,g.site_id)=(p_environment,p_organization,m.actor_id,p_site)))),false)
$$;
CREATE FUNCTION pactwoven.mandate_resolve_context(p_environment text,p_identity jsonb,p_responsibility text,p_write boolean,p_trace text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE o pactwoven.organizations%ROWTYPE; m pactwoven.memberships%ROWTYPE; r pactwoven.responsibilities%ROWTYPE; requesters jsonb; at_time timestamptz;
BEGIN
 IF p_environment NOT IN ('simulation','development','staging','production') OR p_identity IS NULL OR coalesce(p_identity->>'sessionId','')='' THEN RAISE EXCEPTION USING ERRCODE='PM001',MESSAGE='Verified current identity required'; END IF;
 IF p_write THEN
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
  SELECT coalesce(jsonb_agg(pactwoven.mandate_actor_snapshot(p_environment,o.id,p.requester_id,p.requester_identity,p_trace)),'[]'::jsonb) INTO requesters
   FROM(SELECT DISTINCT ON(requester_id) requester_id,requester_identity FROM pactwoven.mandate_proposals WHERE environment=p_environment AND organization_id=o.id AND responsibility_id=r.id ORDER BY requester_id,version DESC)p;
 END IF;
 RETURN jsonb_build_object('organizationId',o.id,'organizationEpoch',o.authority_epoch,'organizationStatus',o.status,'now',pactwoven.mandate_instant(at_time),
  'reader',pactwoven.mandate_actor_snapshot(p_environment,o.id,m.actor_id,p_identity,p_trace),'requesters',coalesce(requesters,'[]'::jsonb),
  'currentResponsibility',CASE WHEN r.id IS NULL THEN NULL ELSE pactwoven.mandate_responsibility_body(r) END,
  'sites',coalesce((SELECT jsonb_agg(jsonb_build_object('id',s.id,'organizationId',s.organization_id,'environment',s.environment,'name',s.name,'timeZone',s.time_zone,'active',true) ORDER BY s.id)
   FROM pactwoven.sites s WHERE s.environment=p_environment AND s.organization_id=o.id),'[]'::jsonb));
END $$;

CREATE FUNCTION pactwoven.mandate_assert_effect() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c jsonb:=nullif(current_setting('pactwoven.mandate_effect',true),'')::jsonb; i jsonb; e jsonb; q jsonb; o pactwoven.organizations%ROWTYPE;
 m pactwoven.memberships%ROWTYPE; requester pactwoven.memberships%ROWTYPE; r pactwoven.responsibilities%ROWTYPE; expected_requester text; at_time timestamptz:=clock_timestamp(); bound timestamptz; kind text;
BEGIN
 IF c IS NULL THEN RAISE EXCEPTION USING ERRCODE='PM001',MESSAGE='Private mandate effect context required'; END IF;
 i:=c->'identity'; e:=c->'evidence'; q:=c->'requesterObservation'; kind:=c->>'kind';
 IF kind NOT IN ('mandate.document.create','mandate.propose','mandate.authorize','mandate.reject','mandate.pause','mandate.revoke','mandate.resume') OR kind IS NULL THEN RAISE EXCEPTION USING ERRCODE='PM004',MESSAGE='Unsupported mandate command'; END IF;
 SELECT * INTO o FROM pactwoven.organizations WHERE environment=current_setting('pactwoven.environment',true) AND id=current_setting('pactwoven.organization_id',true);
 SELECT * INTO m FROM pactwoven.memberships WHERE environment=o.environment AND organization_id=o.id AND actor_id=current_setting('pactwoven.actor_id',true);
 SELECT * INTO r FROM pactwoven.responsibilities WHERE environment=o.environment AND organization_id=o.id AND id=c->>'responsibilityId';
 IF o.id IS NULL OR o.status<>'active' OR m.actor_id IS NULL OR m.status<>'active' OR r.id IS NULL
  OR(m.expires_at IS NOT NULL AND m.expires_at<=at_time) OR m.external_subject IS DISTINCT FROM i->>'subject' OR m.external_membership_id IS DISTINCT FROM i->>'externalMembershipId'
  OR o.external_organization_id IS DISTINCT FROM i->>'externalOrganizationId' OR i->>'sessionId' IS DISTINCT FROM current_setting('pactwoven.session_id',true)
  OR(m.grant_basis='clerk_admin_bootstrap' AND i->>'externalRole' IS DISTINCT FROM 'org:admin')
  OR coalesce(i->>'membershipObservedAt','')='' OR(i->>'membershipObservedAt')::timestamptz>at_time OR(i->>'membershipObservedAt')::timestamptz<at_time-interval '20 seconds'
  OR EXISTS(SELECT 1 FROM pactwoven.session_revocations WHERE environment=o.environment AND session_id=i->>'sessionId')
  OR NOT EXISTS(SELECT 1 FROM pactwoven.member_action_sites g WHERE(g.environment,g.organization_id,g.actor_id,g.site_id)=(o.environment,o.id,m.actor_id,r.site_id))
  OR NOT pactwoven.mandate_can_read(o.environment,o.id,r.id,r.site_id)
  OR NOT(m.roles && CASE WHEN kind IN ('mandate.document.create','mandate.propose') THEN ARRAY['owner','finance','operations']::text[] ELSE ARRAY['owner','finance']::text[] END) THEN
  RAISE EXCEPTION USING ERRCODE='PM001',MESSAGE='Current mandate capability required'; END IF;
 IF c->'responsibilitySnapshot' IS DISTINCT FROM pactwoven.mandate_responsibility_body(r) OR c->'organizationEpoch' IS DISTINCT FROM to_jsonb(o.authority_epoch) THEN RAISE EXCEPTION USING ERRCODE='PM002',MESSAGE='Responsibility or organization changed'; END IF;
 IF kind IN ('mandate.authorize','mandate.reject','mandate.resume') THEN
  IF kind='mandate.resume' THEN
   SELECT p.requester_id INTO expected_requester FROM pactwoven.mandate_versions v
    JOIN pactwoven.mandate_proposals p ON(p.environment,p.organization_id,p.id,p.version)=(v.environment,v.organization_id,v.proposal_id,v.proposal_version)
    WHERE v.environment=o.environment AND v.organization_id=o.id AND v.id=c#>>'{command,mandate,id}' AND v.version=(c#>>'{command,mandate,version}')::integer;
  ELSE
   SELECT requester_id INTO expected_requester FROM pactwoven.mandate_proposals WHERE environment=o.environment AND organization_id=o.id
    AND id=c#>>'{command,proposal,id}' AND version=(c#>>'{command,proposal,version}')::integer AND hash=c#>>'{command,proposal,hash}';
  END IF;
  SELECT * INTO requester FROM pactwoven.memberships WHERE environment=o.environment AND organization_id=o.id AND actor_id=expected_requester;
  IF requester.actor_id IS NULL OR requester.actor_id=m.actor_id OR requester.status<>'active' OR(requester.expires_at IS NOT NULL AND requester.expires_at<=at_time)
   OR NOT(requester.roles&&ARRAY['owner','finance','operations']::text[]) OR NOT EXISTS(SELECT 1 FROM pactwoven.member_action_sites g WHERE(g.environment,g.organization_id,g.actor_id,g.site_id)=(o.environment,o.id,requester.actor_id,r.site_id))
   OR q IS NULL OR q='null'::jsonb OR q->>'externalSubject' IS DISTINCT FROM requester.external_subject OR q->>'externalMembershipId' IS DISTINCT FROM requester.external_membership_id
   OR q->>'externalOrganizationId' IS DISTINCT FROM o.external_organization_id OR coalesce(q->>'observedAt','')='' OR(q->>'observedAt')::timestamptz>at_time OR(q->>'observedAt')::timestamptz<at_time-interval '20 seconds'
   OR(requester.grant_basis='clerk_admin_bootstrap' AND q->>'externalRole' IS DISTINCT FROM 'org:admin') THEN RAISE EXCEPTION USING ERRCODE='PM001',MESSAGE='Current independent requester required'; END IF;
 END IF;
 IF kind IN ('mandate.authorize','mandate.resume') THEN
  IF e IS NULL OR e='null'::jsonb OR e->>'purpose' IS DISTINCT FROM (CASE WHEN kind='mandate.authorize' THEN 'mandate_authorization' ELSE 'mandate_control' END)
   OR e->>'subject' IS DISTINCT FROM i->>'subject' OR e->>'sessionId' IS DISTINCT FROM i->>'sessionId' OR e->>'externalMembershipId' IS DISTINCT FROM i->>'externalMembershipId'
   OR e->>'externalOrganizationId' IS DISTINCT FROM i->>'externalOrganizationId' OR e->>'intentHash' IS DISTINCT FROM c->>'intentHash'
   OR e->>'requestNonce' IS DISTINCT FROM c->>'nonce' OR e->>'requestHash' IS DISTINCT FROM c->>'requestHash'
   OR coalesce(e->>'tokenHash','') !~ '^[a-f0-9]{64}$' OR coalesce(e->>'tokenIssuedAt','')='' OR coalesce(e->>'observedAt','')=''
   OR coalesce(e->>'verifiedAt','')='' OR coalesce(e->>'expiresAt','')='' OR coalesce(e->>'firstFactorAgeMinutes','') !~ '^[0-9]{1,7}$' OR coalesce(e->>'secondFactorAgeMinutes','') !~ '^[0-9]{1,7}$'
   OR(e->>'tokenIssuedAt')::timestamptz>at_time OR(e->>'observedAt')::timestamptz>at_time OR(e->>'observedAt')::timestamptz<at_time-interval '20 seconds' THEN RAISE EXCEPTION USING ERRCODE='PM005',MESSAGE='Exact verified mandate MFA required'; END IF;
  bound:=(e->>'tokenIssuedAt')::timestamptz-(greatest((e->>'firstFactorAgeMinutes')::integer,(e->>'secondFactorAgeMinutes')::integer)+1)*interval '1 minute';
  IF(e->>'verifiedAt')::timestamptz IS DISTINCT FROM bound OR(e->>'expiresAt')::timestamptz<=at_time OR(e->>'expiresAt')::timestamptz>bound+interval '5 minutes' OR bound+interval '5 minutes'<=at_time THEN RAISE EXCEPTION USING ERRCODE='PM005',MESSAGE='Mandate MFA expired before effect'; END IF;
 END IF;
 IF c->>'proposalExpiresAt' IS NOT NULL AND(c->>'proposalExpiresAt')::timestamptz<=at_time THEN RAISE EXCEPTION USING ERRCODE='PM002',MESSAGE='Proposal expired before effect'; END IF;
 IF c->>'authorityExpiresAt' IS NOT NULL AND(c->>'authorityExpiresAt')::timestamptz<=at_time THEN RAISE EXCEPTION USING ERRCODE='PM002',MESSAGE='Authority expired before effect'; END IF;
END $$;

CREATE FUNCTION pactwoven.mandate_guard_row() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c jsonb:=nullif(current_setting('pactwoven.mandate_effect',true),'')::jsonb; op pactwoven.mandate_operations%ROWTYPE; prior jsonb; p pactwoven.mandate_proposals%ROWTYPE; d pactwoven.mandate_policy_documents%ROWTYPE; accepted pactwoven.mandate_versions%ROWTYPE;
BEGIN
 PERFORM pactwoven.mandate_assert_effect();
 IF NEW.environment IS DISTINCT FROM current_setting('pactwoven.environment',true) OR NEW.organization_id IS DISTINCT FROM current_setting('pactwoven.organization_id',true)
  OR NEW.responsibility_id IS DISTINCT FROM c->>'responsibilityId' THEN RAISE EXCEPTION USING ERRCODE='PM001',MESSAGE='Mandate tenant and responsibility required'; END IF;
 IF TG_TABLE_NAME IN ('mandate_policy_documents','mandate_proposals','mandate_decisions','mandate_audit','mandate_outbox') THEN
  SELECT * INTO op FROM pactwoven.mandate_operations WHERE(environment,organization_id,id)=(NEW.environment,NEW.organization_id,NEW.operation_id);
  IF NEW.operation_id IS DISTINCT FROM c->>'operationId' OR op.id IS NULL OR op.responsibility_id IS DISTINCT FROM NEW.responsibility_id
   OR op.site_id IS DISTINCT FROM NEW.site_id OR op.kind IS DISTINCT FROM c->>'kind' OR op.actor_id IS DISTINCT FROM current_setting('pactwoven.actor_id',true)
   OR op.command IS DISTINCT FROM c->'command' OR op.identity IS DISTINCT FROM c->'identity'
   OR op.idempotency_key IS DISTINCT FROM c->>'key' OR op.command_hash IS DISTINCT FROM c->>'commandHash' THEN
   RAISE EXCEPTION USING ERRCODE='PM004',MESSAGE='Child records require their exact current mandate operation'; END IF;
 END IF;
 IF TG_TABLE_NAME='mandate_policy_documents' THEN
  IF c->>'kind'<>'mandate.document.create' OR NEW.body->>'createdBy' IS DISTINCT FROM current_setting('pactwoven.actor_id',true)
   OR NEW.site_id IS DISTINCT FROM c#>>'{responsibilitySnapshot,siteId}' OR NEW.responsibility_version IS DISTINCT FROM(c#>>'{responsibilitySnapshot,version}')::integer
   OR NEW.id IS DISTINCT FROM c#>>'{command,command,documentId}' OR NEW.version<>(c#>>'{command,command,expectedVersion}')::integer+1
   OR op.result->'target' IS DISTINCT FROM jsonb_build_object('kind','document','id',NEW.id,'version',NEW.version,'hash',NEW.hash) THEN RAISE EXCEPTION USING ERRCODE='PM004',MESSAGE='Exact document author and scope required'; END IF;
  IF NEW.version=1 THEN
   IF NEW.body->'previousVersion' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION USING ERRCODE='PM002',MESSAGE='Initial document predecessor must be empty'; END IF;
  ELSE
   SELECT * INTO d FROM pactwoven.mandate_policy_documents WHERE(environment,organization_id,id,version)=(NEW.environment,NEW.organization_id,NEW.id,NEW.version-1);
   IF d.id IS NULL OR NEW.body->'previousVersion' IS DISTINCT FROM jsonb_build_object('id',d.id,'version',d.version,'hash',d.hash)
    OR d.body->>'purpose' IS DISTINCT FROM NEW.body->>'purpose' OR d.site_id<>NEW.site_id OR d.responsibility_id<>NEW.responsibility_id THEN RAISE EXCEPTION USING ERRCODE='PM002',MESSAGE='Exact immutable document predecessor required'; END IF;
  END IF;
 ELSIF TG_TABLE_NAME='mandate_proposals' THEN
  IF c->>'kind'<>'mandate.propose' OR NEW.requester_id IS DISTINCT FROM current_setting('pactwoven.actor_id',true) OR NEW.requester_identity IS DISTINCT FROM c->'identity'
   OR NEW.site_id IS DISTINCT FROM c#>>'{responsibilitySnapshot,siteId}' OR NEW.responsibility_version IS DISTINCT FROM(c#>>'{responsibilitySnapshot,version}')::integer
   OR NEW.id IS DISTINCT FROM c#>>'{command,proposalId}' OR NEW.version<>(c#>>'{command,expectedProposalVersion}')::integer+1
   OR op.result->'target' IS DISTINCT FROM jsonb_build_object('kind','proposal','id',NEW.id,'version',NEW.version,'hash',NEW.hash) THEN RAISE EXCEPTION USING ERRCODE='PM004',MESSAGE='Exact mandate proposal scope required'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pactwoven.mandate_policy_documents doc WHERE(doc.environment,doc.organization_id,doc.responsibility_id,doc.site_id)=(NEW.environment,NEW.organization_id,NEW.responsibility_id,NEW.site_id)
   AND doc.id=NEW.body#>>'{policy,acceptancePolicy,id}' AND doc.version=(NEW.body#>>'{policy,acceptancePolicy,version}')::integer AND doc.hash=NEW.body#>>'{policy,acceptancePolicy,hash}' AND doc.body->>'purpose'='ACCEPTANCE_POLICY')
   OR NOT EXISTS(SELECT 1 FROM pactwoven.mandate_policy_documents doc WHERE(doc.environment,doc.organization_id,doc.responsibility_id,doc.site_id)=(NEW.environment,NEW.organization_id,NEW.responsibility_id,NEW.site_id)
   AND doc.id=NEW.body#>>'{policyDocument,id}' AND doc.version=(NEW.body#>>'{policyDocument,version}')::integer AND doc.hash=NEW.body#>>'{policyDocument,hash}' AND doc.body->>'purpose'='MANDATE_POLICY') THEN RAISE EXCEPTION USING ERRCODE='PM004',MESSAGE='Exact authoritative policy documents required'; END IF;
 ELSIF TG_TABLE_NAME='mandate_decisions' THEN
  SELECT * INTO p FROM pactwoven.mandate_proposals WHERE(environment,organization_id,id,version)=(NEW.environment,NEW.organization_id,NEW.proposal_id,NEW.proposal_version);
  IF p.id IS NULL OR NEW.body->'proposal' IS DISTINCT FROM jsonb_build_object('id',p.id,'version',p.version,'hash',p.hash) THEN RAISE EXCEPTION USING ERRCODE='PM004',MESSAGE='Exact proposal decision required'; END IF;
  IF NEW.version=1 THEN
   IF c->>'kind'<>'mandate.propose' OR NEW.body->'authorization' IS DISTINCT FROM 'null'::jsonb OR NEW.body->'actorId' IS DISTINCT FROM 'null'::jsonb
    OR op.result->'target' IS DISTINCT FROM jsonb_build_object('kind','proposal','id',p.id,'version',p.version,'hash',p.hash)
    OR p.operation_id IS DISTINCT FROM NEW.operation_id THEN RAISE EXCEPTION USING ERRCODE='PM004',MESSAGE='Initial decision must remain open'; END IF;
  ELSIF NEW.body->>'state'='SUPERSEDED' THEN
   IF c->>'kind'<>'mandate.propose' OR p.requester_id IS DISTINCT FROM current_setting('pactwoven.actor_id',true) OR NEW.body->>'actorId' IS DISTINCT FROM p.requester_id
    OR NEW.body#>>'{replacement,id}' IS DISTINCT FROM p.id OR(NEW.body#>>'{replacement,version}')::integer<>p.version+1
    OR NEW.body->'proposal' IS DISTINCT FROM c#>'{command,previousProposal}' OR NEW.body->'replacement' IS DISTINCT FROM (op.result->'target')-'kind' THEN RAISE EXCEPTION USING ERRCODE='PM004',MESSAGE='Exact requester replacement required'; END IF;
  ELSIF NEW.body->>'state' IN ('APPROVED','REJECTED') THEN
   IF c->>'kind' IS DISTINCT FROM (CASE WHEN NEW.body->>'state'='APPROVED' THEN 'mandate.authorize' ELSE 'mandate.reject' END)
    OR NEW.body->>'actorId' IS DISTINCT FROM current_setting('pactwoven.actor_id',true) OR p.requester_id=current_setting('pactwoven.actor_id',true)
    OR NEW.body->>'intentHash' IS DISTINCT FROM c->>'intentHash' OR NEW.body->'proposal' IS DISTINCT FROM c#>'{command,proposal}'
    OR NEW.version<>(c#>>'{command,expectedDecisionVersion}')::integer+1 OR op.result#>>'{target,kind}' IS DISTINCT FROM 'decision'
    OR op.result#>>'{target,id}' IS DISTINCT FROM NEW.proposal_id OR op.result#>'{target,version}' IS DISTINCT FROM to_jsonb(NEW.version) THEN RAISE EXCEPTION USING ERRCODE='PM001',MESSAGE='Exact independent decision required'; END IF;
   IF NEW.body->>'state'='APPROVED' AND(NEW.body#>>'{authorization,requesterId}' IS DISTINCT FROM p.requester_id
    OR NEW.body#>>'{authorization,approverId}' IS DISTINCT FROM current_setting('pactwoven.actor_id',true) OR NEW.body#>>'{authorization,purpose}' IS DISTINCT FROM 'mandate_authorization'
    OR NEW.body#>>'{authorization,intentHash}' IS DISTINCT FROM c->>'intentHash') THEN RAISE EXCEPTION USING ERRCODE='PM004',MESSAGE='Exact authorization receipt required'; END IF;
  ELSE RAISE EXCEPTION USING ERRCODE='PM004',MESSAGE='Unsupported terminal decision ingress'; END IF;
 ELSIF TG_TABLE_NAME='mandate_versions' THEN
  IF c->>'kind'<>'mandate.authorize' THEN RAISE EXCEPTION USING ERRCODE='PM001',MESSAGE='Only independent authorization creates accepted versions'; END IF;
  SELECT * INTO p FROM pactwoven.mandate_proposals WHERE(environment,organization_id,id,version)=(NEW.environment,NEW.organization_id,NEW.proposal_id,NEW.proposal_version);
  IF p.id IS NULL OR NEW.body->>'createdBy' IS DISTINCT FROM p.requester_id OR NEW.body->'policy' IS DISTINCT FROM p.body->'policy'
   OR NEW.body->>'policyHash' IS DISTINCT FROM p.body->>'policyHash' OR NEW.body->'organizationEpoch' IS DISTINCT FROM p.body->'organizationEpoch'
   OR NEW.id IS DISTINCT FROM p.mandate_id OR NEW.version<>coalesce((p.body#>>'{previousAcceptedVersion,version}')::integer,0)+1
   OR NEW.body->>'previousVersionHash' IS DISTINCT FROM p.body#>>'{previousAcceptedVersion,hash}'
   OR NEW.body->'mandateEpoch' IS DISTINCT FROM to_jsonb(coalesce((p.body#>>'{expectedHead,mandateEpoch}')::integer,0)+1)
   OR NOT EXISTS(SELECT 1 FROM pactwoven.mandate_decisions decision WHERE(decision.environment,decision.organization_id,decision.proposal_id,decision.proposal_version,decision.version)=(NEW.environment,NEW.organization_id,NEW.proposal_id,NEW.proposal_version,2)
    AND decision.body->>'state'='APPROVED' AND decision.body#>>'{authorization,acceptedVersion,id}'=NEW.id AND decision.body#>'{authorization,acceptedVersion,version}'=to_jsonb(NEW.version)
    AND decision.body->>'decidedAt'=NEW.body->>'createdAt' AND decision.operation_id=c->>'operationId'
    AND decision.body->'proposal'=c#>'{command,proposal}') THEN RAISE EXCEPTION USING ERRCODE='PM004',MESSAGE='Accepted authority must preserve the approved proposal'; END IF;
 ELSIF TG_TABLE_NAME='mandate_heads' THEN
  SELECT * INTO accepted FROM pactwoven.mandate_versions WHERE(environment,organization_id,id,version)=(NEW.environment,NEW.organization_id,NEW.id,(NEW.body->>'mandateVersion')::integer);
  IF accepted.id IS NULL OR accepted.responsibility_id IS DISTINCT FROM NEW.responsibility_id OR NEW.body->'organizationEpoch' IS DISTINCT FROM accepted.body->'organizationEpoch'
   OR NEW.body->'policyHash' IS DISTINCT FROM accepted.body->'policyHash' OR NEW.body->'expiresAt' IS DISTINCT FROM accepted.body#>'{policy,expiresAt}' THEN
   RAISE EXCEPTION USING ERRCODE='PM004',MESSAGE='Exact accepted authority head required'; END IF;
  IF TG_OP='UPDATE' AND(NEW.environment IS DISTINCT FROM OLD.environment OR NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.responsibility_id IS DISTINCT FROM OLD.responsibility_id OR NEW.id IS DISTINCT FROM OLD.id
   OR(NEW.body->>'mandateEpoch')::integer<>(OLD.body->>'mandateEpoch')::integer+1) THEN RAISE EXCEPTION USING ERRCODE='PM002',MESSAGE='Exact next authority epoch required'; END IF;
  IF c->>'kind'='mandate.authorize' THEN
   IF NEW.body->>'state'<>'ACTIVE' OR(TG_OP='INSERT' AND((NEW.body->>'mandateVersion')::integer<>1 OR(NEW.body->>'mandateEpoch')::integer<>1))
    OR NEW.body->'mandateEpoch' IS DISTINCT FROM accepted.body->'mandateEpoch'
    OR(TG_OP='UPDATE' AND(NEW.body->>'mandateVersion')::integer<>(OLD.body->>'mandateVersion')::integer+1) THEN RAISE EXCEPTION USING ERRCODE='PM002',MESSAGE='New accepted mandate version required'; END IF;
  ELSIF TG_OP<>'UPDATE' OR c->>'kind' NOT IN ('mandate.pause','mandate.revoke','mandate.resume') OR OLD.body->>'state' IN ('REVOKED','EXPIRED')
   OR NEW.body-ARRAY['state','mandateEpoch'] IS DISTINCT FROM OLD.body-ARRAY['state','mandateEpoch']
   OR(c->>'kind'='mandate.pause' AND(OLD.body->>'state'<>'ACTIVE' OR NEW.body->>'state'<>'PAUSED'))
   OR(c->>'kind'='mandate.revoke' AND NEW.body->>'state'<>'REVOKED') OR(c->>'kind'='mandate.resume' AND(OLD.body->>'state'<>'PAUSED' OR NEW.body->>'state'<>'ACTIVE')) THEN
   RAISE EXCEPTION USING ERRCODE='PM002',MESSAGE='Invalid current authority transition'; END IF;
 ELSIF TG_TABLE_NAME='mandate_operations' THEN
  IF NEW.actor_id IS DISTINCT FROM current_setting('pactwoven.actor_id',true) OR NEW.kind IS DISTINCT FROM c->>'kind' OR NEW.id IS DISTINCT FROM c->>'operationId'
   OR NEW.idempotency_key IS DISTINCT FROM c->>'key' OR NEW.command_hash IS DISTINCT FROM c->>'commandHash' OR NEW.command IS DISTINCT FROM c->'command'
   OR NEW.identity IS DISTINCT FROM c->'identity' THEN RAISE EXCEPTION USING ERRCODE='PM004',MESSAGE='Exact mandate operation required'; END IF;
  IF NEW.identity-ARRAY['subject','externalOrganizationId','externalOrganizationName','externalMembershipId','externalRole','membershipObservedAt','sessionId','authenticatedAt']<>'{}'::jsonb THEN
   RAISE EXCEPTION USING ERRCODE='PM004',MESSAGE='Only declared private identity metadata may be persisted'; END IF;
  IF jsonb_typeof(c->'evidence')='object' THEN
   IF(c->'evidence')-ARRAY['id','purpose','intentHash','requestNonce','requestHash','subject','externalOrganizationId','externalMembershipId','sessionId','issuer','tokenHash','tokenIssuedAt','firstFactorAgeMinutes','secondFactorAgeMinutes','verifiedAt','observedAt','expiresAt']<>'{}'::jsonb THEN
    RAISE EXCEPTION USING ERRCODE='PM004',MESSAGE='Only declared verified mandate evidence may be persisted'; END IF;
  ELSIF c->'evidence' IS NOT NULL AND c->'evidence'<>'null'::jsonb THEN RAISE EXCEPTION USING ERRCODE='PM004',MESSAGE='Verified evidence metadata must be an object or null'; END IF;
  IF jsonb_typeof(c->'requesterObservation')='object' THEN
   IF(c->'requesterObservation')-ARRAY['externalOrganizationId','externalMembershipId','externalSubject','displayName','externalRole','observedAt']<>'{}'::jsonb THEN
    RAISE EXCEPTION USING ERRCODE='PM004',MESSAGE='Only declared requester metadata may be persisted'; END IF;
  ELSIF c->'requesterObservation' IS NOT NULL AND c->'requesterObservation'<>'null'::jsonb THEN RAISE EXCEPTION USING ERRCODE='PM004',MESSAGE='Requester metadata must be an object or null'; END IF;
  -- Capture only the verified effect inputs, never arbitrary top-level connection context.
  -- The caller cannot replace this snapshot through an INSERT value or a later GUC update.
  NEW.effect_context:=jsonb_build_object('identity',NEW.identity,'evidence',c->'evidence','requesterObservation',c->'requesterObservation',
   'kind',NEW.kind,'responsibilityId',NEW.responsibility_id,'responsibilitySnapshot',c->'responsibilitySnapshot','organizationEpoch',c->'organizationEpoch',
   'command',NEW.command,'intentHash',c->'intentHash','nonce',c->'nonce','requestHash',c->'requestHash','operationId',NEW.id,'key',NEW.idempotency_key,
   'commandHash',NEW.command_hash,'proposalExpiresAt',c->'proposalExpiresAt','authorityExpiresAt',c->'authorityExpiresAt');
 ELSIF TG_TABLE_NAME='mandate_audit' THEN
  SELECT * INTO op FROM pactwoven.mandate_operations WHERE(environment,organization_id,id)=(NEW.environment,NEW.organization_id,NEW.operation_id);
  IF op.id IS NULL OR NEW.operation_id IS DISTINCT FROM c->>'operationId' OR NEW.body->>'kind' IS DISTINCT FROM op.kind
   OR NEW.body->>'actorId' IS DISTINCT FROM op.actor_id OR NEW.body->'identity' IS DISTINCT FROM op.identity OR NEW.body->'evidence' IS DISTINCT FROM c->'evidence'
   OR NEW.body->>'commandHash' IS DISTINCT FROM op.command_hash OR NEW.body->'intentHash' IS DISTINCT FROM op.result->'intentHash'
   OR NEW.body->'requesterObservation' IS DISTINCT FROM c->'requesterObservation' OR NEW.body->>'requestNonce' IS DISTINCT FROM c->>'nonce'
   OR NEW.body->'requestHash' IS DISTINCT FROM c->'requestHash' OR NEW.body->'occurredAt' IS DISTINCT FROM op.result->'observedAt' THEN
   RAISE EXCEPTION USING ERRCODE='PM004',MESSAGE='Exact immutable operation audit required'; END IF;
  IF op.kind IN ('mandate.authorize','mandate.pause','mandate.revoke','mandate.resume') THEN
   IF NEW.body#>>'{history,operationId}' IS DISTINCT FROM op.id OR NEW.body#>>'{history,actorId}' IS DISTINCT FROM op.actor_id
    OR NEW.body#>'{history,occurredAt}' IS DISTINCT FROM op.result->'observedAt'
    OR NEW.body#>>'{history,action}' IS DISTINCT FROM upper(substring(op.kind FROM 9))
    OR NOT EXISTS(SELECT 1 FROM pactwoven.mandate_heads h WHERE(h.environment,h.organization_id,h.responsibility_id)=(NEW.environment,NEW.organization_id,NEW.responsibility_id)
      AND h.body=NEW.body#>'{history,head}') THEN RAISE EXCEPTION USING ERRCODE='PM004',MESSAGE='Exact immutable authority history required'; END IF;
  ELSIF NEW.body->'history' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION USING ERRCODE='PM004',MESSAGE='Authority history requires an authority operation'; END IF;
 ELSIF TG_TABLE_NAME='mandate_outbox' THEN
  SELECT * INTO op FROM pactwoven.mandate_operations WHERE(environment,organization_id,id)=(NEW.environment,NEW.organization_id,NEW.operation_id);
  IF op.id IS NULL OR NEW.event_type IS DISTINCT FROM op.kind OR NEW.payload IS DISTINCT FROM jsonb_build_object('schemaVersion',1,'operationId',op.id,'kind',op.kind,'responsibilityId',op.responsibility_id,'target',op.result->'target') THEN
   RAISE EXCEPTION USING ERRCODE='PM004',MESSAGE='Only the exact mandate event is allowed'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION pactwoven.mandate_assert_operation_effect(op pactwoven.mandate_operations) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE saved_environment text:=current_setting('pactwoven.environment',true); saved_organization text:=current_setting('pactwoven.organization_id',true);
 saved_actor text:=current_setting('pactwoven.actor_id',true); saved_session text:=current_setting('pactwoven.session_id',true);
 saved_responsibility text:=current_setting('pactwoven.mandate_responsibility_id',true); saved_site text:=current_setting('pactwoven.mandate_site_id',true);
 saved_effect text:=current_setting('pactwoven.mandate_effect',true); c jsonb:=op.effect_context;
BEGIN
 IF c->'identity' IS DISTINCT FROM op.identity OR c->'command' IS DISTINCT FROM op.command OR c->>'kind' IS DISTINCT FROM op.kind
  OR c->>'responsibilityId' IS DISTINCT FROM op.responsibility_id OR c->>'operationId' IS DISTINCT FROM op.id
  OR c->>'key' IS DISTINCT FROM op.idempotency_key OR c->>'commandHash' IS DISTINCT FROM op.command_hash THEN
  RAISE EXCEPTION USING ERRCODE='PM004',MESSAGE='Original immutable operation context is required'; END IF;
 PERFORM set_config('pactwoven.environment',op.environment,true),set_config('pactwoven.organization_id',op.organization_id,true),
  set_config('pactwoven.actor_id',op.actor_id,true),set_config('pactwoven.session_id',op.identity->>'sessionId',true),
  set_config('pactwoven.mandate_responsibility_id',op.responsibility_id,true),set_config('pactwoven.mandate_site_id',op.site_id,true),
  set_config('pactwoven.mandate_effect',c::text,true);
 -- Same actual-time capability, provider evidence and expiry checks used at the initial effect.
 PERFORM pactwoven.mandate_assert_effect();
 PERFORM set_config('pactwoven.environment',coalesce(saved_environment,''),true),set_config('pactwoven.organization_id',coalesce(saved_organization,''),true),
  set_config('pactwoven.actor_id',coalesce(saved_actor,''),true),set_config('pactwoven.session_id',coalesce(saved_session,''),true),
  set_config('pactwoven.mandate_responsibility_id',coalesce(saved_responsibility,''),true),set_config('pactwoven.mandate_site_id',coalesce(saved_site,''),true),
  set_config('pactwoven.mandate_effect',coalesce(saved_effect,''),true);
EXCEPTION WHEN OTHERS THEN
 PERFORM set_config('pactwoven.environment',coalesce(saved_environment,''),true),set_config('pactwoven.organization_id',coalesce(saved_organization,''),true),
  set_config('pactwoven.actor_id',coalesce(saved_actor,''),true),set_config('pactwoven.session_id',coalesce(saved_session,''),true),
  set_config('pactwoven.mandate_responsibility_id',coalesce(saved_responsibility,''),true),set_config('pactwoven.mandate_site_id',coalesce(saved_site,''),true),
  set_config('pactwoven.mandate_effect',coalesce(saved_effect,''),true);
 RAISE;
END $$;
CREATE FUNCTION pactwoven.mandate_commit_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 PERFORM pactwoven.mandate_assert_operation_effect(NEW);
 IF NOT EXISTS(SELECT 1 FROM pactwoven.mandate_audit WHERE(environment,organization_id,operation_id)=(NEW.environment,NEW.organization_id,NEW.id))
  OR NOT EXISTS(SELECT 1 FROM pactwoven.mandate_outbox WHERE(environment,organization_id,operation_id)=(NEW.environment,NEW.organization_id,NEW.id)) THEN
  RAISE EXCEPTION USING ERRCODE='PM004',MESSAGE='Mandate operation, audit and outbox must commit together'; END IF;
 IF NEW.result#>>'{target,kind}' IS DISTINCT FROM (CASE WHEN NEW.kind='mandate.document.create' THEN 'document' WHEN NEW.kind='mandate.propose' THEN 'proposal'
  WHEN NEW.kind IN ('mandate.authorize','mandate.reject') THEN 'decision' ELSE 'authority' END)
  OR NEW.result#>>'{operation,aggregateId}' IS DISTINCT FROM NEW.result#>>'{target,id}'
  OR NEW.result#>'{operation,aggregateVersion}' IS DISTINCT FROM NEW.result#>'{target,version}' THEN
  RAISE EXCEPTION USING ERRCODE='PM004',MESSAGE='Exact mandate operation result required'; END IF;
 IF NEW.kind='mandate.document.create' THEN
  IF NOT EXISTS(SELECT 1 FROM pactwoven.mandate_policy_documents d WHERE(d.environment,d.organization_id,d.operation_id)=(NEW.environment,NEW.organization_id,NEW.id)
   AND d.id=NEW.result#>>'{target,id}' AND to_jsonb(d.version)=NEW.result#>'{target,version}' AND d.hash=NEW.result#>>'{target,hash}') THEN RAISE EXCEPTION USING ERRCODE='PM004',MESSAGE='Document operation target required'; END IF;
 ELSIF NEW.kind='mandate.propose' THEN
  IF NOT EXISTS(SELECT 1 FROM pactwoven.mandate_proposals p JOIN pactwoven.mandate_decisions d ON(d.environment,d.organization_id,d.proposal_id,d.proposal_version,d.version)=(p.environment,p.organization_id,p.id,p.version,1)
   WHERE(p.environment,p.organization_id,p.operation_id)=(NEW.environment,NEW.organization_id,NEW.id) AND p.id=NEW.result#>>'{target,id}' AND to_jsonb(p.version)=NEW.result#>'{target,version}' AND p.hash=NEW.result#>>'{target,hash}') THEN RAISE EXCEPTION USING ERRCODE='PM004',MESSAGE='Proposal and open decision target required'; END IF;
 ELSIF NEW.kind IN ('mandate.authorize','mandate.reject') THEN
  IF NOT EXISTS(SELECT 1 FROM pactwoven.mandate_decisions d WHERE(d.environment,d.organization_id,d.operation_id)=(NEW.environment,NEW.organization_id,NEW.id)
   AND d.proposal_id=NEW.result#>>'{target,id}' AND to_jsonb(d.version)=NEW.result#>'{target,version}') THEN RAISE EXCEPTION USING ERRCODE='PM004',MESSAGE='Decision operation target required'; END IF;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM pactwoven.mandate_audit a WHERE(a.environment,a.organization_id,a.operation_id)=(NEW.environment,NEW.organization_id,NEW.id)
   AND a.body#>'{history,head,mandateEpoch}'=NEW.result#>'{target,version}' AND a.body#>>'{history,head,mandateId}'=NEW.result#>>'{target,id}') THEN RAISE EXCEPTION USING ERRCODE='PM004',MESSAGE='Authority operation target required'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER mandate_operation_complete AFTER INSERT ON pactwoven.mandate_operations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pactwoven.mandate_commit_guard();

-- Reciprocal check: each queued NEW/OLD snapshot needs its own immutable history.
-- Neither the final mutable head nor the final session effect setting can satisfy a skipped intermediate event.
CREATE FUNCTION pactwoven.mandate_head_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE audit pactwoven.mandate_audit%ROWTYPE; op pactwoven.mandate_operations%ROWTYPE; event pactwoven.mandate_outbox%ROWTYPE;
 accepted pactwoven.mandate_versions%ROWTYPE; decision pactwoven.mandate_decisions%ROWTYPE; history jsonb; expected_site text;
BEGIN
 SELECT * INTO audit FROM pactwoven.mandate_audit WHERE(environment,organization_id,responsibility_id,mandate_id,mandate_epoch)
  =(NEW.environment,NEW.organization_id,NEW.responsibility_id,NEW.id,NEW.epoch) AND body#>'{history,head}'=NEW.body;
 IF audit.id IS NULL THEN RAISE EXCEPTION USING ERRCODE='PM004',MESSAGE='Every authority head snapshot requires its own immutable history'; END IF;
 history:=audit.body->'history';
 SELECT * INTO op FROM pactwoven.mandate_operations WHERE(environment,organization_id,id)=(NEW.environment,NEW.organization_id,audit.operation_id);
 SELECT * INTO event FROM pactwoven.mandate_outbox WHERE(environment,organization_id,operation_id)=(NEW.environment,NEW.organization_id,audit.operation_id);
 SELECT * INTO accepted FROM pactwoven.mandate_versions WHERE(environment,organization_id,id,version)=(NEW.environment,NEW.organization_id,NEW.id,NEW.version);
 SELECT * INTO decision FROM pactwoven.mandate_decisions WHERE(environment,organization_id,proposal_id,proposal_version,version)
  =(NEW.environment,NEW.organization_id,accepted.proposal_id,accepted.proposal_version,2);
 IF op.id IS NULL OR event.id IS NULL OR accepted.id IS NULL OR decision.body->>'state' IS DISTINCT FROM 'APPROVED'
  OR op.responsibility_id IS DISTINCT FROM NEW.responsibility_id OR event.responsibility_id IS DISTINCT FROM NEW.responsibility_id
  OR accepted.responsibility_id IS DISTINCT FROM NEW.responsibility_id OR op.kind NOT IN ('mandate.authorize','mandate.pause','mandate.revoke','mandate.resume')
  OR audit.body->>'operationId' IS DISTINCT FROM op.id OR history->>'operationId' IS DISTINCT FROM op.id
  OR audit.body->>'kind' IS DISTINCT FROM op.kind OR event.event_type IS DISTINCT FROM op.kind
  OR history->>'action' IS DISTINCT FROM upper(substring(op.kind FROM 9)) OR history->>'actorId' IS DISTINCT FROM op.actor_id
  OR audit.body->>'actorId' IS DISTINCT FROM op.actor_id OR audit.body->'identity' IS DISTINCT FROM op.identity
  OR audit.body->>'commandHash' IS DISTINCT FROM op.command_hash OR audit.body->'intentHash' IS DISTINCT FROM op.result->'intentHash'
  OR audit.body->'occurredAt' IS DISTINCT FROM op.result->'observedAt' OR history->'occurredAt' IS DISTINCT FROM op.result->'observedAt'
  OR event.payload IS DISTINCT FROM jsonb_build_object('schemaVersion',1,'operationId',op.id,'kind',op.kind,'responsibilityId',NEW.responsibility_id,'target',op.result->'target')
  OR NEW.body->>'state' IS DISTINCT FROM (CASE op.kind WHEN 'mandate.pause' THEN 'PAUSED' WHEN 'mandate.revoke' THEN 'REVOKED' ELSE 'ACTIVE' END) THEN
  RAISE EXCEPTION USING ERRCODE='PM004',MESSAGE='Authority history, operation and outbox must match the exact head snapshot'; END IF;
 IF TG_OP='INSERT' THEN
  IF history->'previousHead' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION USING ERRCODE='PM004',MESSAGE='Initial authority history cannot name a predecessor'; END IF;
 ELSE
  IF history#>>'{previousHead,mandateId}' IS DISTINCT FROM OLD.id OR history#>'{previousHead,mandateVersion}' IS DISTINCT FROM to_jsonb(OLD.version)
   OR history#>'{previousHead,mandateEpoch}' IS DISTINCT FROM to_jsonb(OLD.epoch)
   OR NOT EXISTS(SELECT 1 FROM pactwoven.mandate_audit prior WHERE(prior.environment,prior.organization_id,prior.responsibility_id,prior.mandate_id,prior.mandate_epoch)
    =(OLD.environment,OLD.organization_id,OLD.responsibility_id,OLD.id,OLD.epoch) AND prior.body#>'{history,head}'=OLD.body) THEN
   RAISE EXCEPTION USING ERRCODE='PM004',MESSAGE='Authority history requires the exact preceding snapshot'; END IF;
 END IF;
 IF op.kind='mandate.authorize' THEN
  expected_site:=accepted.site_id;
  IF decision.operation_id IS DISTINCT FROM op.id OR op.command->'proposal' IS DISTINCT FROM decision.body->'proposal'
   OR op.result#>>'{target,kind}' IS DISTINCT FROM 'decision' OR op.result#>>'{target,id}' IS DISTINCT FROM decision.proposal_id
   OR op.result#>'{target,version}' IS DISTINCT FROM to_jsonb(decision.version)
   OR history->'previousHead' IS DISTINCT FROM op.command->'expectedHead' OR history->'intent' IS DISTINCT FROM 'null'::jsonb
   OR NEW.body->'mandateEpoch' IS DISTINCT FROM accepted.body->'mandateEpoch'
   OR history->'occurredAt' IS DISTINCT FROM accepted.body->'createdAt'
   OR decision.body#>>'{authorization,acceptedHead,mandateId}' IS DISTINCT FROM NEW.id
   OR decision.body#>'{authorization,acceptedHead,mandateVersion}' IS DISTINCT FROM to_jsonb(NEW.version)
   OR decision.body#>'{authorization,acceptedHead,mandateEpoch}' IS DISTINCT FROM to_jsonb(NEW.epoch) THEN
   RAISE EXCEPTION USING ERRCODE='PM004',MESSAGE='Initial authority history requires its exact accepted decision'; END IF;
 ELSE
  expected_site:=op.command#>>'{responsibility,siteId}';
  IF history->'intent' IS DISTINCT FROM op.command OR history->'previousHead' IS DISTINCT FROM op.command->'head'
   OR op.command->'mandate' IS DISTINCT FROM decision.body#>'{authorization,acceptedVersion}'
   OR op.command#>>'{responsibility,id}' IS DISTINCT FROM NEW.responsibility_id
   OR op.result#>>'{target,kind}' IS DISTINCT FROM 'authority' OR op.result#>>'{target,id}' IS DISTINCT FROM NEW.id
   OR op.result#>'{target,version}' IS DISTINCT FROM to_jsonb(NEW.epoch) THEN
   RAISE EXCEPTION USING ERRCODE='PM004',MESSAGE='Control history requires its exact authority operation'; END IF;
 END IF;
 IF expected_site IS NULL OR op.site_id IS DISTINCT FROM expected_site OR audit.site_id IS DISTINCT FROM expected_site OR event.site_id IS DISTINCT FROM expected_site THEN
  RAISE EXCEPTION USING ERRCODE='PM004',MESSAGE='Authority operation, audit and outbox site scope must agree'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER mandate_head_history_complete AFTER INSERT OR UPDATE ON pactwoven.mandate_heads DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pactwoven.mandate_head_complete();

DO $$ DECLARE relation text; BEGIN
 FOREACH relation IN ARRAY ARRAY['mandate_responsibility_versions','mandate_policy_documents','mandate_proposals','mandate_decisions','mandate_versions','mandate_operations','mandate_audit','mandate_outbox'] LOOP
  EXECUTE format('ALTER TABLE pactwoven.%I ENABLE ROW LEVEL SECURITY',relation);
  EXECUTE format('CREATE POLICY mandate_read ON pactwoven.%I FOR SELECT TO pactwoven_mandate_writer USING(pactwoven.mandate_can_read(environment,organization_id,responsibility_id,site_id))',relation);
  EXECUTE format('GRANT SELECT ON pactwoven.%I TO pactwoven_mandate_writer',relation);
  IF relation<>'mandate_responsibility_versions' THEN
   EXECUTE format('CREATE POLICY mandate_insert ON pactwoven.%I FOR INSERT TO pactwoven_mandate_writer WITH CHECK(pactwoven.mandate_can_read(environment,organization_id,responsibility_id,site_id))',relation);
   EXECUTE format('GRANT INSERT ON pactwoven.%I TO pactwoven_mandate_writer',relation);
   EXECUTE format('CREATE TRIGGER mandate_before_insert BEFORE INSERT ON pactwoven.%I FOR EACH ROW EXECUTE FUNCTION pactwoven.mandate_guard_row()',relation);
   EXECUTE format('CREATE TRIGGER mandate_no_change BEFORE UPDATE OR DELETE ON pactwoven.%I FOR EACH ROW EXECUTE FUNCTION pactwoven.mandate_immutable()',relation);
  END IF;
 END LOOP;
END $$;
ALTER TABLE pactwoven.mandate_heads ENABLE ROW LEVEL SECURITY;
CREATE POLICY mandate_head_read ON pactwoven.mandate_heads FOR SELECT TO pactwoven_mandate_writer USING
 (environment=current_setting('pactwoven.environment',true) AND organization_id=current_setting('pactwoven.organization_id',true)
  AND responsibility_id=current_setting('pactwoven.mandate_responsibility_id',true)
  AND pactwoven.mandate_can_read(environment,organization_id,responsibility_id,current_setting('pactwoven.mandate_site_id',true)));
CREATE POLICY mandate_head_insert ON pactwoven.mandate_heads FOR INSERT TO pactwoven_mandate_writer WITH CHECK
 (environment=current_setting('pactwoven.environment',true) AND organization_id=current_setting('pactwoven.organization_id',true));
CREATE POLICY mandate_head_update ON pactwoven.mandate_heads FOR UPDATE TO pactwoven_mandate_writer USING
 (environment=current_setting('pactwoven.environment',true) AND organization_id=current_setting('pactwoven.organization_id',true)) WITH CHECK
 (environment=current_setting('pactwoven.environment',true) AND organization_id=current_setting('pactwoven.organization_id',true));
GRANT SELECT,INSERT ON pactwoven.mandate_heads TO pactwoven_mandate_writer;
GRANT UPDATE(body) ON pactwoven.mandate_heads TO pactwoven_mandate_writer;
CREATE TRIGGER mandate_head_guard BEFORE INSERT OR UPDATE ON pactwoven.mandate_heads FOR EACH ROW EXECUTE FUNCTION pactwoven.mandate_guard_row();
CREATE TRIGGER mandate_head_no_delete BEFORE DELETE ON pactwoven.mandate_heads FOR EACH ROW EXECUTE FUNCTION pactwoven.mandate_immutable();
REVOKE ALL ON FUNCTION pactwoven.mandate_instant(timestamptz),pactwoven.mandate_responsibility_body(pactwoven.responsibilities),pactwoven.mandate_immutable(),
 pactwoven.mandate_capture_responsibility(),pactwoven.mandate_advise_only(jsonb,text),pactwoven.mandate_actor_snapshot(text,text,text,jsonb,text),
 pactwoven.mandate_can_read(text,text,text,text),pactwoven.mandate_resolve_context(text,jsonb,text,boolean,text),pactwoven.mandate_assert_effect(),pactwoven.mandate_guard_row(),
 pactwoven.mandate_assert_operation_effect(pactwoven.mandate_operations),pactwoven.mandate_commit_guard(),pactwoven.mandate_head_complete() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pactwoven.mandate_can_read(text,text,text,text),pactwoven.mandate_resolve_context(text,jsonb,text,boolean,text),pactwoven.mandate_advise_only(jsonb,text) TO pactwoven_mandate_writer;
COMMIT;
