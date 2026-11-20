BEGIN;

-- Source-only admission extension. No runtime LOGIN, credential, private binding,
-- configured lane or supplier administrator is provisioned by this migration.
DO $$ DECLARE owner_oid oid;BEGIN
  SELECT oid INTO owner_oid FROM pg_roles WHERE rolname=current_user AND current_user=session_user;
  IF owner_oid IS NULL OR current_setting('server_version_num')::integer NOT IN(170011,170012)
    OR NOT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='pactwoven' AND nspowner=owner_oid)
    OR (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='pactwoven'
      AND c.relname IN('organizations','memberships','session_revocations','sites') AND c.relowner=owner_oid AND c.relkind='r'
      AND c.relrowsecurity AND (NOT c.relforcerowsecurity OR EXISTS(SELECT 1 FROM pg_roles WHERE oid=owner_oid AND (rolsuper OR rolbypassrls))))<>4
    OR (SELECT count(*) FROM pg_proc WHERE oid=ANY(ARRAY[to_regprocedure('pactwoven.supplier_base_identity(jsonb,jsonb,jsonb)'),
      to_regprocedure('pactwoven.supplier_observer_identity(text,text,jsonb)')]::oid[]) AND proowner=owner_oid AND prosecdef)<>2
    OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='pactwoven' AND c.relname LIKE 'supplier_admission_%') THEN
    RAISE EXCEPTION 'Supplier admission requires the exact qualified installation and unused namespace';
  END IF;
  IF NOT (SELECT rolsuper FROM pg_roles WHERE oid=owner_oid) THEN
    IF (SELECT count(*) FROM pg_auth_members m JOIN pg_roles g ON g.oid=m.grantor
      WHERE m.roleid IN('pactwoven_supplier_owner'::regrole,'pactwoven_supplier_executor'::regrole) AND m.member=owner_oid
        AND m.admin_option AND NOT m.inherit_option AND NOT m.set_option AND m.grantor=10 AND g.rolsuper)<>2 THEN
      RAISE EXCEPTION 'Exact administrative installation memberships required';
    END IF;
    EXECUTE format('GRANT pactwoven_supplier_owner,pactwoven_supplier_executor TO %I WITH INHERIT TRUE',current_user);
    EXECUTE format('GRANT pactwoven_supplier_owner,pactwoven_supplier_executor TO %I WITH SET TRUE',current_user);
    GRANT CREATE ON SCHEMA pactwoven TO pactwoven_supplier_owner,pactwoven_supplier_executor;
  END IF;
END $$;

CREATE FUNCTION pactwoven.supplier_admission_require(ok boolean,kind text DEFAULT 'denied') RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ BEGIN
  IF ok IS DISTINCT FROM true THEN
    IF kind='stale' THEN RAISE EXCEPTION USING ERRCODE='SA002',MESSAGE='Supplier admission stale';
    ELSIF kind='conflict' THEN RAISE EXCEPTION USING ERRCODE='SA003',MESSAGE='Supplier original conflict';
    ELSIF kind='invalid' THEN RAISE EXCEPTION USING ERRCODE='SA004',MESSAGE='Supplier admission invalid';
    ELSE RAISE EXCEPTION USING ERRCODE='SA001',MESSAGE='Supplier admission denied';END IF;
  END IF;
END $$;
CREATE FUNCTION pactwoven.supplier_admission_member_pin(v jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT pactwoven.supplier_object(v,ARRAY['actorId','membershipId','membershipVersion']) AND pactwoven.supplier_id(v->'actorId')
    AND pactwoven.supplier_id(v->'membershipId') AND pactwoven.supplier_integer(v->'membershipVersion',1,2147483647)
$$;
CREATE FUNCTION pactwoven.supplier_admission_observation(v jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ BEGIN
  RETURN pactwoven.supplier_object(v,ARRAY['observedAt','expiresAt']) AND pactwoven.supplier_time(v->'expiresAt')>pactwoven.supplier_time(v->'observedAt')
    AND pactwoven.supplier_time(v->'expiresAt')-pactwoven.supplier_time(v->'observedAt')<=interval '20 seconds';
EXCEPTION WHEN OTHERS THEN RETURN false;END $$;
-- AUTH-SQL-04: fixed reader under the exact legacy identity owner. Its broad
-- administrative privileges are disclosed, not confined by its function ACL.
-- Lock order: existing registry/binding, selected organization, revocations,
-- issuer/target memberships in C order. Command locks precede any grant write.
CREATE FUNCTION pactwoven.supplier_admission_identity(v jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='3s' AS $$
DECLARE e text:=v#>>'{actor,environment}';oid text:=v#>>'{actor,organizationId}';a jsonb:=v->'actor';
  o pactwoven.organizations;m pactwoven.memberships;t pactwoven.memberships;target jsonb:=v->'target';k record;at_time timestamptz;BEGIN
  PERFORM pactwoven.supplier_read_committed();
  PERFORM pactwoven.supplier_admission_require(pactwoven.supplier_admission_evidence_valid(v,clock_timestamp()));
  IF v#>>'{request,kind}'='enrollment-command' THEN
    PERFORM x.id FROM pactwoven.organizations x WHERE (x.environment,x.id)=(e,oid) FOR UPDATE;
  ELSE PERFORM x.id FROM pactwoven.organizations x WHERE (x.environment,x.id)=(e,oid) FOR SHARE;END IF;
  PERFORM pactwoven.supplier_admission_require(FOUND);
  LOCK TABLE pactwoven.session_revocations IN SHARE MODE;
  -- The selected organization lock also fences an absent local membership.
  IF v#>>'{request,kind}'='enrollment-command' THEN
    FOR k IN SELECT x.actor_id FROM pactwoven.memberships x WHERE x.environment=e AND x.organization_id=oid AND
      (x.actor_id=a->>'actorId' OR target<>'null'::jsonb AND
        (x.external_subject=target#>>'{observation,subject}' OR x.external_membership_id=target#>>'{observation,externalMembershipId}'))
      ORDER BY x.actor_id COLLATE "C" FOR UPDATE LOOP NULL;END LOOP;
  ELSE
    FOR k IN SELECT x.actor_id FROM pactwoven.memberships x WHERE x.environment=e AND x.organization_id=oid AND
      (x.actor_id=a->>'actorId' OR target<>'null'::jsonb AND
        (x.external_subject=target#>>'{observation,subject}' OR x.external_membership_id=target#>>'{observation,externalMembershipId}'))
      ORDER BY x.actor_id COLLATE "C" FOR SHARE LOOP NULL;END LOOP;
  END IF;
  SELECT * INTO o FROM pactwoven.organizations x WHERE (x.environment,x.id)=(e,oid);
  SELECT * INTO m FROM pactwoven.memberships x WHERE (x.environment,x.organization_id,x.actor_id)=(e,oid,a->>'actorId');
  at_time:=clock_timestamp();
  PERFORM pactwoven.supplier_admission_require(pactwoven.supplier_admission_evidence_valid(v,at_time)
    AND o.status='active' AND o.created_at<=at_time AND o.external_organization_id=a->>'externalOrganizationId'
    AND o.row_version=(a->>'organizationVersion')::integer AND o.authority_epoch=(a->>'organizationEpoch')::integer
    AND m.actor_id=a->>'membershipId' AND m.external_subject=a->>'subject' AND m.external_membership_id=a->>'externalMembershipId'
    AND m.row_version=(a->>'membershipVersion')::integer AND m.status='active' AND m.created_at<=at_time
    AND (m.expires_at IS NULL OR m.expires_at>at_time) AND 'owner'=ANY(m.roles) AND NOT('service'=ANY(m.roles))
    AND (m.grant_basis<>'clerk_admin_bootstrap' OR v#>>'{observation,externalRole}'='org:admin')
    AND NOT EXISTS(SELECT 1 FROM pactwoven.session_revocations r WHERE r.environment=e AND r.session_id=a->>'sessionId'));
  IF target<>'null'::jsonb THEN
    PERFORM pactwoven.supplier_admission_require((SELECT count(*)<=1 FROM pactwoven.memberships x WHERE x.environment=e AND x.organization_id=oid
      AND (x.external_subject=target#>>'{observation,subject}' OR x.external_membership_id=target#>>'{observation,externalMembershipId}')));
    SELECT * INTO t FROM pactwoven.memberships x WHERE x.environment=e AND x.organization_id=oid
      AND (x.external_subject=target#>>'{observation,subject}' OR x.external_membership_id=target#>>'{observation,externalMembershipId}');
    IF t.actor_id IS NOT NULL THEN
      PERFORM pactwoven.supplier_admission_require(t.external_subject=target#>>'{observation,subject}' AND t.external_membership_id=target#>>'{observation,externalMembershipId}'
        AND t.status='active' AND t.created_at<=at_time AND (t.expires_at IS NULL OR t.expires_at>at_time) AND NOT('service'=ANY(t.roles)));
    END IF;
  END IF;
  RETURN jsonb_build_object('organization',jsonb_build_object('id',o.id,'version',o.row_version,'authorityEpoch',o.authority_epoch,'name',o.name,'status','ACTIVE'),
    'issuer',jsonb_build_object('actorId',m.actor_id,'membershipId',m.actor_id,'membershipVersion',m.row_version),
    'issuerRoles',to_jsonb(m.roles),'issuerExpiresAt',pactwoven.supplier_instant(m.expires_at),
    'target',CASE WHEN t.actor_id IS NULL THEN NULL ELSE jsonb_build_object('member',jsonb_build_object('actorId',t.actor_id,'membershipId',t.actor_id,'membershipVersion',t.row_version),
      'roles',to_jsonb(t.roles),'expiresAt',pactwoven.supplier_instant(t.expires_at)) END);
END $$;
CREATE FUNCTION pactwoven.supplier_admission_selection(v jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ BEGIN
  RETURN CASE v->>'action'
    WHEN 'grant' THEN pactwoven.supplier_object(v,ARRAY['action','candidate','expiresAt']) AND pactwoven.supplier_reference(v->'candidate') AND pactwoven.supplier_time(v->'expiresAt') IS NOT NULL
    WHEN 'renew' THEN pactwoven.supplier_object(v,ARRAY['action','grant','expiresAt']) AND pactwoven.supplier_reference(v->'grant') AND pactwoven.supplier_time(v->'expiresAt') IS NOT NULL
    WHEN 'revoke' THEN pactwoven.supplier_object(v,ARRAY['action','grant']) AND pactwoven.supplier_reference(v->'grant') ELSE false END;
EXCEPTION WHEN OTHERS THEN RETURN false;END $$;
CREATE FUNCTION pactwoven.supplier_admission_basis(v jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ BEGIN
  RETURN pactwoven.supplier_object(v,ARRAY['environment','organization','issuer','target','previousGrant','observation'])
    AND v->>'environment' IN('simulation','development','staging','production')
    AND pactwoven.supplier_object(v->'organization',ARRAY['id','version','authorityEpoch']) AND pactwoven.supplier_id(v#>'{organization,id}')
    AND pactwoven.supplier_integer(v#>'{organization,version}',1,2147483647) AND pactwoven.supplier_integer(v#>'{organization,authorityEpoch}',0,2147483647)
    AND pactwoven.supplier_admission_member_pin(v->'issuer') AND pactwoven.supplier_object(v->'target',ARRAY['candidate','member'])
    AND pactwoven.supplier_reference(v#>'{target,candidate}')
    AND (v#>'{target,member}'='null'::jsonb OR pactwoven.supplier_admission_member_pin(v#>'{target,member}'))
    AND (v->'previousGrant'='null'::jsonb OR pactwoven.supplier_reference(v->'previousGrant'))
    AND pactwoven.supplier_admission_observation(v->'observation');
EXCEPTION WHEN OTHERS THEN RETURN false;END $$;
CREATE FUNCTION pactwoven.supplier_admission_command(v jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ DECLARE s jsonb:=v->'selection';b jsonb:=v->'basis';BEGIN
  RETURN octet_length(convert_to(v::text,'UTF8'))<=16384 AND pactwoven.supplier_object(v,ARRAY['schemaVersion','role','selection','basis','reviewHash'])
    AND v->'schemaVersion'='1'::jsonb AND v->>'role'='supplier_admin' AND v->>'reviewHash'~'^[a-f0-9]{64}$'
    AND pactwoven.supplier_admission_selection(s) AND pactwoven.supplier_admission_basis(b)
    AND CASE WHEN s->>'action'='grant' THEN b->'previousGrant'='null'::jsonb AND s->'candidate'=b#>'{target,candidate}'
      ELSE b->'previousGrant'<>'null'::jsonb AND b#>'{target,member}'<>'null'::jsonb AND s->'grant'=b->'previousGrant' END
    AND (s->>'action'='revoke' OR pactwoven.supplier_time(s->'expiresAt')>pactwoven.supplier_time(b#>'{observation,observedAt}')
      AND pactwoven.supplier_time(s->'expiresAt')-pactwoven.supplier_time(b#>'{observation,observedAt}')<=interval '30 days');
EXCEPTION WHEN OTHERS THEN RETURN false;END $$;
CREATE FUNCTION pactwoven.supplier_admission_recovery(v jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ DECLARE i jsonb:=v->'identity';BEGIN
  RETURN octet_length(convert_to(v::text,'UTF8'))<=8192 AND pactwoven.supplier_object(v,ARRAY['identity','action','target','previousGrant','publicRequestHash'])
    AND pactwoven.supplier_object(i,ARRAY['environment','organizationId','actorId','idempotencyKey'])
    AND i->>'environment' IN('simulation','development','staging','production') AND pactwoven.supplier_id(i->'organizationId') AND pactwoven.supplier_id(i->'actorId')
    AND i->>'idempotencyKey'~'^[A-Za-z0-9_-]{16,128}$' AND v->>'publicRequestHash'~'^[a-f0-9]{64}$'
    AND pactwoven.supplier_object(v->'target',ARRAY['candidate','member']) AND pactwoven.supplier_reference(v#>'{target,candidate}')
    AND (v#>'{target,member}'='null'::jsonb OR pactwoven.supplier_admission_member_pin(v#>'{target,member}'))
    AND CASE WHEN v->>'action'='grant' THEN v->'previousGrant'='null'::jsonb WHEN v->>'action' IN('renew','revoke')
      THEN pactwoven.supplier_reference(v->'previousGrant') AND v#>'{target,member}'<>'null'::jsonb ELSE false END;
EXCEPTION WHEN OTHERS THEN RETURN false;END $$;
CREATE FUNCTION pactwoven.supplier_admission_request(v jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ BEGIN
  RETURN octet_length(convert_to(v::text,'UTF8'))<=24576 AND CASE v->>'kind'
    WHEN 'context' THEN pactwoven.supplier_object(v,ARRAY['kind','purpose','query']) AND v->>'purpose'='supplier_admission_context' AND v->'query'='{}'::jsonb
    WHEN 'enrollment-review' THEN pactwoven.supplier_object(v,ARRAY['kind','purpose','query']) AND v->>'purpose'='supplier_administrator_review'
      AND pactwoven.supplier_object(v->'query',ARRAY['schemaVersion','selection']) AND v#>'{query,schemaVersion}'='1'::jsonb AND pactwoven.supplier_admission_selection(v#>'{query,selection}')
    WHEN 'enrollment-command' THEN pactwoven.supplier_object(v,ARRAY['kind','purpose','mutation']) AND v->>'purpose'='supplier_administrator_'||(v#>>'{mutation,command,selection,action}')
      AND pactwoven.supplier_object(v->'mutation',ARRAY['idempotencyKey','command']) AND v#>>'{mutation,idempotencyKey}'~'^[A-Za-z0-9_-]{16,128}$'
      AND pactwoven.supplier_admission_command(v#>'{mutation,command}')
    WHEN 'enrollment-recover' THEN pactwoven.supplier_object(v,ARRAY['kind','purpose','query']) AND v->>'purpose'='supplier_administrator_recover' AND pactwoven.supplier_admission_recovery(v->'query')
    ELSE false END;
EXCEPTION WHEN OTHERS THEN RETURN false;END $$;
CREATE FUNCTION pactwoven.supplier_admission_limitations() RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('authentication','NOT_ESTABLISHED','businessVerification','NOT_ESTABLISHED','payeeVerification','NOT_ESTABLISHED',
   'bookingAuthority',false,'contractualAcceptance',false,'paymentAuthority',false)
$$;

CREATE TABLE pactwoven.supplier_admission_lanes (
  id text NOT NULL,version bigint NOT NULL CHECK(version BETWEEN 1 AND 9007199254740991),hash text NOT NULL CHECK(hash~'^[a-f0-9]{64}$'),
  environment text NOT NULL,buyer_organization_id text NOT NULL,supplier_organization_id text NOT NULL,
  buyer_binding_id text NOT NULL,buyer_binding_version bigint NOT NULL,buyer_binding_hash text NOT NULL,
  supplier_binding_id text NOT NULL,supplier_binding_version bigint NOT NULL,supplier_binding_hash text NOT NULL,
  status text NOT NULL CHECK(status IN('ACTIVE','REVOKED')),valid_from timestamptz NOT NULL,expires_at timestamptz NOT NULL,body jsonb NOT NULL,
  PRIMARY KEY(id,version),UNIQUE(id,version,hash),CHECK(buyer_organization_id<>supplier_organization_id),CHECK(valid_from<expires_at),
  FOREIGN KEY(environment,buyer_organization_id) REFERENCES pactwoven.organizations(environment,id),
  FOREIGN KEY(environment,supplier_organization_id) REFERENCES pactwoven.organizations(environment,id),
  FOREIGN KEY(buyer_binding_id,buyer_binding_version,buyer_binding_hash) REFERENCES pactwoven.supplier_private_bindings(id,version,hash),
  FOREIGN KEY(supplier_binding_id,supplier_binding_version,supplier_binding_hash) REFERENCES pactwoven.supplier_private_bindings(id,version,hash)
);
CREATE TABLE pactwoven.supplier_admission_evidence (
  id uuid PRIMARY KEY,hash text NOT NULL CHECK(hash~'^[a-f0-9]{64}$'),binding_id text NOT NULL,binding_version bigint NOT NULL,binding_hash text NOT NULL,
  lane_id text NOT NULL,lane_version bigint NOT NULL,lane_hash text NOT NULL,environment text NOT NULL,organization_id text NOT NULL,actor_id text NOT NULL,
  observed_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,body jsonb NOT NULL,
  UNIQUE(id,hash),CHECK(observed_at<expires_at AND expires_at-observed_at<=interval '20 seconds'),
  FOREIGN KEY(binding_id,binding_version,binding_hash) REFERENCES pactwoven.supplier_private_bindings(id,version,hash),
  FOREIGN KEY(lane_id,lane_version,lane_hash) REFERENCES pactwoven.supplier_admission_lanes(id,version,hash)
);
CREATE TABLE pactwoven.supplier_admission_contexts (
  database_oid oid NOT NULL,session_user_oid oid NOT NULL,backend_pid integer NOT NULL,full_xid xid8 NOT NULL,
  evidence_id uuid NOT NULL,evidence_hash text NOT NULL,environment text NOT NULL,organization_id text NOT NULL,actor_id text NOT NULL,
  original_key text NOT NULL,material jsonb NOT NULL,
  PRIMARY KEY(database_oid,session_user_oid,backend_pid,full_xid),UNIQUE(evidence_id),
  FOREIGN KEY(evidence_id,evidence_hash) REFERENCES pactwoven.supplier_admission_evidence(id,hash)
);
CREATE TABLE pactwoven.supplier_admission_reviews (
  hash text PRIMARY KEY CHECK(hash~'^[a-f0-9]{64}$'),evidence_id uuid NOT NULL UNIQUE,environment text NOT NULL,organization_id text NOT NULL,actor_id text NOT NULL,
  material jsonb NOT NULL,FOREIGN KEY(evidence_id) REFERENCES pactwoven.supplier_admission_evidence(id)
);
CREATE TABLE pactwoven.supplier_administrator_grants (
  environment text NOT NULL,organization_id text NOT NULL,member_id text NOT NULL,id text NOT NULL,version bigint NOT NULL CHECK(version BETWEEN 1 AND 9007199254740991),
  hash text NOT NULL CHECK(hash~'^[a-f0-9]{64}$'),record jsonb NOT NULL,issuer_actor_id text NOT NULL,original_key text NOT NULL,
  context_database oid NOT NULL,context_session oid NOT NULL,context_backend integer NOT NULL,context_xid xid8 NOT NULL,
  PRIMARY KEY(environment,organization_id,member_id,version),UNIQUE(environment,organization_id,id,version,hash),
  UNIQUE(environment,organization_id,issuer_actor_id,original_key),
  FOREIGN KEY(environment,organization_id,member_id) REFERENCES pactwoven.memberships(environment,organization_id,actor_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(context_database,context_session,context_backend,context_xid) REFERENCES pactwoven.supplier_admission_contexts(database_oid,session_user_oid,backend_pid,full_xid)
);
CREATE TABLE pactwoven.supplier_admission_receipts (
  environment text NOT NULL,organization_id text NOT NULL,issuer_actor_id text NOT NULL,original_key text NOT NULL,
  member_id text NOT NULL,grant_id text NOT NULL,grant_version bigint NOT NULL,grant_hash text NOT NULL,
  mutation jsonb NOT NULL,receipt jsonb NOT NULL,
  PRIMARY KEY(environment,organization_id,issuer_actor_id,original_key),UNIQUE(environment,organization_id,member_id,grant_version),
  FOREIGN KEY(environment,organization_id,grant_id,grant_version,grant_hash) REFERENCES pactwoven.supplier_administrator_grants(environment,organization_id,id,version,hash) DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE pactwoven.supplier_administrator_grants ADD CONSTRAINT supplier_admission_reciprocal_receipt
  FOREIGN KEY(environment,organization_id,issuer_actor_id,original_key) REFERENCES pactwoven.supplier_admission_receipts(environment,organization_id,issuer_actor_id,original_key) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE pactwoven.supplier_admission_contexts ADD CONSTRAINT supplier_admission_context_consumed
  FOREIGN KEY(environment,organization_id,actor_id,original_key) REFERENCES pactwoven.supplier_admission_receipts(environment,organization_id,issuer_actor_id,original_key) DEFERRABLE INITIALLY DEFERRED;
CREATE VIEW pactwoven.supplier_administrator_current WITH(security_invoker=true) AS
  SELECT DISTINCT ON(environment,organization_id,member_id) environment,organization_id,member_id,id,version,hash,record
  FROM pactwoven.supplier_administrator_grants ORDER BY environment,organization_id,member_id,version DESC;

CREATE POLICY supplier_admission_lane_read ON pactwoven.supplier_admission_lanes FOR SELECT TO pactwoven_supplier_executor
  USING(EXISTS(SELECT 1 FROM pactwoven.supplier_private_bindings b WHERE b.id IN(buyer_binding_id,supplier_binding_id)));
CREATE POLICY supplier_admission_evidence_read ON pactwoven.supplier_admission_evidence FOR SELECT TO pactwoven_supplier_executor
  USING(EXISTS(SELECT 1 FROM pactwoven.supplier_private_bindings b WHERE b.id=binding_id AND b.version=binding_version AND b.hash=binding_hash));
CREATE POLICY supplier_admission_evidence_insert ON pactwoven.supplier_admission_evidence FOR INSERT TO pactwoven_supplier_executor
  WITH CHECK(EXISTS(SELECT 1 FROM pactwoven.supplier_private_bindings b WHERE b.id=binding_id AND b.version=binding_version AND b.hash=binding_hash AND b.verifier_oid=pactwoven.supplier_session_oid()));
CREATE POLICY supplier_admission_context_read ON pactwoven.supplier_admission_contexts FOR SELECT TO pactwoven_supplier_executor
  USING(database_oid=pactwoven.supplier_database_oid() AND session_user_oid=pactwoven.supplier_session_oid() AND backend_pid=pg_backend_pid() AND full_xid=pg_current_xact_id());
CREATE POLICY supplier_admission_context_insert ON pactwoven.supplier_admission_contexts FOR INSERT TO pactwoven_supplier_executor
  WITH CHECK(database_oid=pactwoven.supplier_database_oid() AND session_user_oid=pactwoven.supplier_session_oid() AND backend_pid=pg_backend_pid() AND full_xid=pg_current_xact_id());
CREATE POLICY supplier_admission_review_read ON pactwoven.supplier_admission_reviews FOR SELECT TO pactwoven_supplier_executor
  USING(EXISTS(SELECT 1 FROM pactwoven.supplier_private_bindings b WHERE b.environment=supplier_admission_reviews.environment AND b.effective_organization_id=supplier_admission_reviews.organization_id));
CREATE POLICY supplier_admission_review_insert ON pactwoven.supplier_admission_reviews FOR INSERT TO pactwoven_supplier_executor
  WITH CHECK(EXISTS(SELECT 1 FROM pactwoven.supplier_private_bindings b WHERE b.environment=supplier_admission_reviews.environment
    AND b.effective_organization_id=supplier_admission_reviews.organization_id AND b.authorizer_oid=pactwoven.supplier_session_oid()));
CREATE POLICY supplier_admission_grant_read ON pactwoven.supplier_administrator_grants FOR SELECT TO pactwoven_supplier_executor
  USING(EXISTS(SELECT 1 FROM pactwoven.supplier_admission_lanes l WHERE l.environment=supplier_administrator_grants.environment AND l.supplier_organization_id=supplier_administrator_grants.organization_id));
CREATE POLICY supplier_admission_grant_insert ON pactwoven.supplier_administrator_grants FOR INSERT TO pactwoven_supplier_executor
  WITH CHECK(EXISTS(SELECT 1 FROM pactwoven.supplier_admission_contexts c WHERE c.database_oid=context_database AND c.session_user_oid=context_session
    AND c.backend_pid=context_backend AND c.full_xid=context_xid AND c.material->'record'=record));
CREATE POLICY supplier_admission_receipt_read ON pactwoven.supplier_admission_receipts FOR SELECT TO pactwoven_supplier_executor
  USING(EXISTS(SELECT 1 FROM pactwoven.supplier_admission_lanes l WHERE l.environment=supplier_admission_receipts.environment AND l.supplier_organization_id=supplier_admission_receipts.organization_id));
CREATE POLICY supplier_admission_receipt_insert ON pactwoven.supplier_admission_receipts FOR INSERT TO pactwoven_supplier_executor
  WITH CHECK(EXISTS(SELECT 1 FROM pactwoven.supplier_admission_contexts c WHERE c.environment=supplier_admission_receipts.environment AND c.organization_id=supplier_admission_receipts.organization_id
    AND c.actor_id=supplier_admission_receipts.issuer_actor_id AND c.original_key=supplier_admission_receipts.original_key AND c.material->'receipt'=supplier_admission_receipts.receipt));

CREATE FUNCTION pactwoven.supplier_admission_lane_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE prior pactwoven.supplier_admission_lanes;b pactwoven.supplier_private_bindings;s pactwoven.supplier_private_bindings;v jsonb:=NEW.body;BEGIN
  PERFORM pactwoven.supplier_registry_fence(true);
  PERFORM pactwoven.supplier_lineage_fence(least(NEW.buyer_binding_id,NEW.supplier_binding_id));
  PERFORM pactwoven.supplier_lineage_fence(greatest(NEW.buyer_binding_id,NEW.supplier_binding_id));
  SELECT * INTO b FROM pactwoven.supplier_private_bindings WHERE id=NEW.buyer_binding_id ORDER BY version DESC LIMIT 1;
  SELECT * INTO s FROM pactwoven.supplier_private_bindings WHERE id=NEW.supplier_binding_id ORDER BY version DESC LIMIT 1;
  PERFORM pactwoven.supplier_admission_require(pactwoven.supplier_object(v,ARRAY['schemaVersion','reference','environment','buyerOrganizationId','supplierOrganizationId',
    'buyerBinding','supplierBinding','status','validFrom','expiresAt']) AND v->'schemaVersion'='1'::jsonb
    AND pactwoven.supplier_reference(v->'reference') AND pactwoven.supplier_reference(v->'buyerBinding') AND pactwoven.supplier_reference(v->'supplierBinding')
    AND (v->>'environment',v->>'buyerOrganizationId',v->>'supplierOrganizationId',v->>'status')=(NEW.environment,NEW.buyer_organization_id,NEW.supplier_organization_id,NEW.status)
    AND v->'reference'=jsonb_build_object('id',NEW.id,'version',NEW.version,'hash',NEW.hash)
    AND v->'buyerBinding'=b.body->'reference' AND v->'supplierBinding'=s.body->'reference'
    AND b.status='ACTIVE' AND s.status='ACTIVE' AND b.environment=NEW.environment AND s.environment=NEW.environment
    AND b.effective_organization_id=NEW.buyer_organization_id AND s.effective_organization_id=NEW.supplier_organization_id
    AND (NEW.buyer_binding_version,NEW.buyer_binding_hash)=(b.version,b.hash) AND (NEW.supplier_binding_version,NEW.supplier_binding_hash)=(s.version,s.hash)
    AND NEW.valid_from=pactwoven.supplier_time(v->'validFrom') AND NEW.expires_at=pactwoven.supplier_time(v->'expiresAt')
    AND NEW.valid_from>=greatest(b.valid_from,s.valid_from) AND NEW.expires_at<=least(b.expires_at,s.expires_at)
    AND NEW.hash=pactwoven.supplier_hash(jsonb_build_object('namespace','pactwoven/supplier-admission-lane/v1','lane',
      jsonb_set(v,'{reference}',jsonb_build_object('id',NEW.id,'version',NEW.version)))));
  SELECT * INTO prior FROM pactwoven.supplier_admission_lanes WHERE id=NEW.id ORDER BY version DESC LIMIT 1;
  PERFORM pactwoven.supplier_admission_require(NOT EXISTS(SELECT 1 FROM pactwoven.supplier_admission_lanes l WHERE l.id<>NEW.id
    AND (l.buyer_binding_id IN(NEW.buyer_binding_id,NEW.supplier_binding_id) OR l.supplier_binding_id IN(NEW.buyer_binding_id,NEW.supplier_binding_id))));
  IF prior.id IS NULL THEN PERFORM pactwoven.supplier_admission_require(NEW.version=1 AND NEW.status='ACTIVE');
  ELSE PERFORM pactwoven.supplier_admission_require(prior.status='ACTIVE' AND NEW.version=prior.version+1
    AND (NEW.environment,NEW.buyer_organization_id,NEW.supplier_organization_id,NEW.buyer_binding_id,NEW.supplier_binding_id)=
      (prior.environment,prior.buyer_organization_id,prior.supplier_organization_id,prior.buyer_binding_id,prior.supplier_binding_id));END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER supplier_admission_lane_append BEFORE INSERT ON pactwoven.supplier_admission_lanes FOR EACH ROW EXECUTE FUNCTION pactwoven.supplier_admission_lane_guard();

CREATE FUNCTION pactwoven.supplier_admission_current_lane(b pactwoven.supplier_private_bindings,expected jsonb) RETURNS pactwoven.supplier_admission_lanes
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog AS $$ DECLARE l pactwoven.supplier_admission_lanes;BEGIN
  SELECT * INTO l FROM pactwoven.supplier_admission_lanes WHERE supplier_binding_id=b.id ORDER BY version DESC LIMIT 1;
  PERFORM pactwoven.supplier_admission_require(l.id IS NOT NULL AND l.body=expected AND l.status='ACTIVE'
    AND l.environment=b.environment AND l.supplier_organization_id=b.effective_organization_id
    AND (l.supplier_binding_version,l.supplier_binding_hash)=(b.version,b.hash) AND l.valid_from<=clock_timestamp() AND l.expires_at>clock_timestamp());
  RETURN l;
END $$;
CREATE FUNCTION pactwoven.supplier_admission_grant_head(e text,o text,m text) RETURNS jsonb
LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$
  SELECT jsonb_build_object('record',g.record,'reference',jsonb_build_object('id',g.id,'version',g.version,'hash',g.hash))
  FROM pactwoven.supplier_administrator_grants g WHERE (g.environment,g.organization_id,g.member_id)=(e,o,m) ORDER BY g.version DESC LIMIT 1
$$;
-- Fixed grant prerequisite for the two existing identity readers and old approver
-- gate. It adds no policy/counterparty requirement to an authorized stop.
CREATE FUNCTION pactwoven.supplier_admission_grant_current(e text,o text,m text,mv integer,ov integer,ep integer,at_time timestamptz) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE g jsonb;r jsonb;BEGIN
  g:=pactwoven.supplier_admission_grant_head(e,o,m);r:=g->'record';
  IF g IS NULL OR r IS NULL OR r='null'::jsonb THEN RETURN false;END IF;
  RETURN coalesce(r->>'status'='ACTIVE' AND r->>'environment'=e AND r->>'organizationId'=o
    AND r#>>'{target,actorId}'=m AND r#>>'{target,membershipId}'=m AND (r#>>'{target,membershipVersion}')::integer=mv
    AND (r->>'organizationVersion')::integer<=ov AND (r->>'authorityEpoch')::integer<=ep
    AND pactwoven.supplier_time(r->'validFrom')<=at_time AND at_time<pactwoven.supplier_time(r->'expiresAt')
    AND g#>>'{reference,hash}'=pactwoven.supplier_hash(jsonb_build_object('namespace','pactwoven/supplier-administrator-grant/v1','record',r)),false);
END $$;
CREATE FUNCTION pactwoven.supplier_admission_evidence_valid(v jsonb,at_time timestamptz) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE a jsonb:=v->'actor';o jsonb:=v->'observation';t jsonb:=v->'target';q jsonb:=v->'request';s jsonb:=v->'source';keys text[];
  k text;command boolean:=q->>'kind'='enrollment-command';first_at timestamptz;second_at timestamptz;BEGIN
  keys:=ARRAY['schemaVersion','id','actor','binding','lane','request','requestDigest','mutationDigest','observation','target','observedAt','expiresAt','kind'];
  IF command THEN keys:=keys||ARRAY['source'];END IF;
  IF (octet_length(convert_to(v::text,'UTF8'))>65536 OR NOT pactwoven.supplier_object(v,keys) OR v->'schemaVersion'<>'1'::jsonb
    OR (v->>'id')::uuid::text<>v->>'id' OR NOT pactwoven.supplier_admission_request(q)
    OR (v->>'kind'='factors') IS DISTINCT FROM command OR v->>'kind' NOT IN('identity','factors')
    OR NOT pactwoven.supplier_object(a,ARRAY['actorId','membershipId','membershipVersion','environment','organizationId','organizationVersion','organizationEpoch','principalKind',
      'subject','externalOrganizationId','externalMembershipId','sessionId']) OR a->>'principalKind'<>'human'
    OR NOT pactwoven.supplier_integer(a->'membershipVersion',1,2147483647) OR NOT pactwoven.supplier_integer(a->'organizationVersion',1,2147483647)
    OR NOT pactwoven.supplier_integer(a->'organizationEpoch',0,2147483647) OR NOT pactwoven.supplier_observation_current(o,at_time)
    OR at_time-pactwoven.supplier_time(o->'membershipObservedAt')>=interval '20 seconds'
    OR at_time-pactwoven.supplier_time(o->'observedAt')>=interval '20 seconds'
    OR v->'observedAt'<>o->'observedAt' OR v->'expiresAt'<>o->'expiresAt'
    OR pactwoven.supplier_time(v->'expiresAt')-pactwoven.supplier_time(v->'observedAt')>interval '20 seconds'
    OR a->'environment'<>v#>'{binding,environment}' OR a->'environment'<>v#>'{lane,environment}'
    OR a->'organizationId'<>v#>'{binding,effectiveOrganizationId}' OR a->'organizationId'<>v#>'{lane,supplierOrganizationId}'
    OR v#>'{binding,reference}'<>v#>'{lane,supplierBinding}'
    OR pactwoven.supplier_time(v->'observedAt')<greatest(pactwoven.supplier_time(v#>'{binding,validFrom}'),pactwoven.supplier_time(v#>'{lane,validFrom}'))
    OR pactwoven.supplier_time(v->'expiresAt')>least(pactwoven.supplier_time(v#>'{binding,expiresAt}'),pactwoven.supplier_time(v#>'{lane,expiresAt}'))) IS NOT FALSE THEN RETURN false;END IF;
  FOREACH k IN ARRAY ARRAY['actorId','membershipId','organizationId'] LOOP IF (NOT pactwoven.supplier_id(a->k)) IS NOT FALSE THEN RETURN false;END IF;END LOOP;
  FOREACH k IN ARRAY ARRAY['subject','externalOrganizationId','externalMembershipId','sessionId'] LOOP
    IF (a->k IS DISTINCT FROM o->k) IS NOT FALSE THEN RETURN false;END IF;END LOOP;
  IF (v->>'requestDigest'<>pactwoven.supplier_hash(jsonb_build_object('namespace','pactwoven/supplier-admission-private-request/v1','request',q,
    'identity',jsonb_build_object('environment',a->'environment','organizationId',a->'organizationId','actorId',a->'actorId')))
    OR v->'mutationDigest' IS DISTINCT FROM CASE WHEN command THEN to_jsonb(pactwoven.supplier_hash(jsonb_build_object(
      'namespace','pactwoven/supplier-enrollment-public-request/v1','mutation',q->'mutation'))) ELSE 'null'::jsonb END
    OR (t<>'null'::jsonb) IS DISTINCT FROM (q->>'kind' IN('enrollment-review','enrollment-command'))) IS NOT FALSE THEN RETURN false;END IF;
  IF t<>'null'::jsonb THEN
    IF (NOT pactwoven.supplier_object(t,ARRAY['reference','principalKind','displayName','observation']) OR t->>'principalKind'<>'human'
      OR jsonb_typeof(t->'displayName')<>'string' OR length(t->>'displayName') NOT BETWEEN 1 AND 180 OR NOT pactwoven.supplier_reference(t->'reference')
      OR NOT pactwoven.supplier_membership_observation(t->'observation',at_time) OR t#>>'{observation,status}'<>'ACTIVE'
      OR t#>'{observation,issuer}'<>o->'issuer' OR t#>'{observation,externalOrganizationId}'<>o->'externalOrganizationId'
      OR pactwoven.supplier_time(t#>'{observation,observedAt}')>pactwoven.supplier_time(v->'observedAt')
      OR pactwoven.supplier_time(t#>'{observation,expiresAt}')<pactwoven.supplier_time(v->'expiresAt')
      OR at_time-pactwoven.supplier_time(t#>'{observation,observedAt}')>=interval '20 seconds'
      OR (t#>'{observation,subject}'=o->'subject') IS DISTINCT FROM (t#>'{observation,externalMembershipId}'=o->'externalMembershipId')
      OR t#>>'{reference,hash}'<>pactwoven.supplier_hash(jsonb_build_object('namespace','pactwoven/supplier-admission-candidate/v1','candidate',jsonb_build_object(
        'reference',(t->'reference')-'hash','environment',a->'environment','organizationId',a->'organizationId','issuer',t#>'{observation,issuer}',
        'subject',t#>'{observation,subject}','externalOrganizationId',t#>'{observation,externalOrganizationId}','externalMembershipId',t#>'{observation,externalMembershipId}')))) IS NOT FALSE THEN RETURN false;END IF;
  END IF;
  IF command THEN
    IF (NOT pactwoven.supplier_object(s,ARRAY['kind','tokenHash','tokenIssuedAt','firstFactorAgeMinutes','secondFactorAgeMinutes','firstFactorAt','secondFactorAt','verifiedAt'])
      OR s->>'kind'<>'CLERK_FVA' OR s->'tokenHash'<>o->'tokenHash' OR s->'tokenIssuedAt'<>o->'tokenIssuedAt'
      OR NOT pactwoven.supplier_integer(s->'firstFactorAgeMinutes',0,1000000) OR NOT pactwoven.supplier_integer(s->'secondFactorAgeMinutes',0,1000000)
      OR q#>'{mutation,command,basis,environment}'<>a->'environment' OR q#>'{mutation,command,basis,organization,id}'<>a->'organizationId'
      OR q#>'{mutation,command,basis,issuer,actorId}'<>a->'actorId' OR q#>'{mutation,command,basis,target,candidate}'<>t->'reference') IS NOT FALSE THEN RETURN false;END IF;
    first_at:=pactwoven.supplier_time(s->'tokenIssuedAt')-make_interval(mins=>(s->>'firstFactorAgeMinutes')::int+1);
    second_at:=pactwoven.supplier_time(s->'tokenIssuedAt')-make_interval(mins=>(s->>'secondFactorAgeMinutes')::int+1);
    IF (first_at<>pactwoven.supplier_time(s->'firstFactorAt') OR second_at<>pactwoven.supplier_time(s->'secondFactorAt')
      OR least(first_at,second_at)<>pactwoven.supplier_time(s->'verifiedAt') OR greatest(first_at,second_at)>at_time
      OR at_time-least(first_at,second_at)>=interval '5 minutes') IS NOT FALSE THEN RETURN false;END IF;
  END IF;
  IF q->>'kind'='enrollment-recover' AND (q#>'{query,identity,environment}'<>a->'environment' OR q#>'{query,identity,organizationId}'<>a->'organizationId'
    OR q#>'{query,identity,actorId}'<>a->'actorId') THEN RETURN false;END IF;
  RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;END $$;

CREATE FUNCTION pactwoven.supplier_admission_write_context() RETURNS pactwoven.supplier_admission_contexts
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT c FROM pactwoven.supplier_admission_contexts c WHERE c.database_oid=pactwoven.supplier_database_oid()
    AND c.session_user_oid=pactwoven.supplier_session_oid() AND c.backend_pid=pg_backend_pid() AND c.full_xid=pg_current_xact_id()
$$;
-- Root-approved fixed identity writer. AUTH-SQL-04 expands to this exact DML
-- function; the legacy owner remains broadly privileged. No runtime identity DML
-- privilege, configurable SQL, supplied GUC or JSON handle authorizes the write.
CREATE FUNCTION pactwoven.supplier_admission_identity_apply() RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='3s' AS $$
DECLARE c pactwoven.supplier_admission_contexts:=pactwoven.supplier_admission_write_context();v jsonb;facts jsonb;r jsonb;t jsonb;q jsonb;
  changed integer;desired_roles text[];BEGIN
  PERFORM pactwoven.supplier_admission_require(c.evidence_id IS NOT NULL AND current_setting('role')='none');
  v:=c.material->'evidence';r:=c.material->'record';q:=v->'request';
  PERFORM pactwoven.supplier_admission_require(q->>'kind'='enrollment-command' AND pactwoven.supplier_admission_evidence_valid(v,clock_timestamp())
    AND c.material->'mutation'=q->'mutation' AND c.environment=v#>>'{actor,environment}' AND c.organization_id=v#>>'{actor,organizationId}'
    AND c.actor_id=v#>>'{actor,actorId}' AND c.original_key=q#>>'{mutation,idempotencyKey}');
  facts:=pactwoven.supplier_admission_identity(v);t:=facts->'target';
  PERFORM pactwoven.supplier_admission_require(facts=c.material->'facts' AND r->'issuer'=facts->'issuer'
    AND (r->>'organizationVersion')::integer=(facts#>>'{organization,version}')::integer+1
    AND (r->>'authorityEpoch')::integer=(facts#>>'{organization,authorityEpoch}')::integer+1
    AND r->>'environment'=c.environment AND r->>'organizationId'=c.organization_id
    AND r->>'action'=q#>>'{mutation,command,selection,action}' AND r->>'role'='supplier_admin','stale');
  IF t='null'::jsonb THEN
    PERFORM pactwoven.supplier_admission_require(r->>'action'='grant' AND r#>'{target,membershipVersion}'='1'::jsonb
      AND r#>'{target,actorId}'=r#>'{target,membershipId}' AND pactwoven.supplier_id(r#>'{target,actorId}'));
    INSERT INTO pactwoven.memberships(environment,organization_id,actor_id,external_subject,external_membership_id,grant_basis,roles,status,row_version,display_name)
      VALUES(c.environment,c.organization_id,r#>>'{target,actorId}',v#>>'{target,observation,subject}',v#>>'{target,observation,externalMembershipId}',
        'owner_grant',ARRAY['supplier_admin'],'active',1,v#>>'{target,displayName}');
  ELSE
    PERFORM pactwoven.supplier_admission_require(r#>'{target,actorId}'=t#>'{member,actorId}' AND r#>'{target,membershipId}'=t#>'{member,membershipId}'
      AND (r#>>'{target,membershipVersion}')::integer=(t#>>'{member,membershipVersion}')::integer+1,'stale');
    SELECT array_agg(x ORDER BY n) INTO desired_roles FROM jsonb_array_elements_text(t->'roles') WITH ORDINALITY f(x,n);
    IF r->>'action'='revoke' THEN
      -- Keep only an inert existing flag when removing it would violate the
      -- installed nonempty-role constraint. Exact grant checks remain mandatory.
      IF cardinality(desired_roles)>1 THEN desired_roles:=array_remove(desired_roles,'supplier_admin');END IF;
    ELSIF NOT('supplier_admin'=ANY(desired_roles)) THEN desired_roles:=array_append(desired_roles,'supplier_admin');END IF;
    UPDATE pactwoven.memberships SET roles=desired_roles,row_version=(r#>>'{target,membershipVersion}')::integer
      WHERE environment=c.environment AND organization_id=c.organization_id AND actor_id=r#>>'{target,actorId}'
        AND row_version=(t#>>'{member,membershipVersion}')::integer;
    GET DIAGNOSTICS changed=ROW_COUNT;PERFORM pactwoven.supplier_admission_require(changed=1,'stale');
  END IF;
  UPDATE pactwoven.organizations SET authority_epoch=(r->>'authorityEpoch')::integer
    WHERE environment=c.environment AND id=c.organization_id AND authority_epoch=(facts#>>'{organization,authorityEpoch}')::integer
      AND row_version=(facts#>>'{organization,version}')::integer;
  GET DIAGNOSTICS changed=ROW_COUNT;PERFORM pactwoven.supplier_admission_require(changed=1,'stale');
  PERFORM pactwoven.supplier_admission_require(EXISTS(SELECT 1 FROM pactwoven.organizations WHERE environment=c.environment AND id=c.organization_id
    AND row_version=(r->>'organizationVersion')::integer AND authority_epoch=(r->>'authorityEpoch')::integer));
END $$;
CREATE FUNCTION pactwoven.supplier_admission_context_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE ev pactwoven.supplier_admission_evidence;b pactwoven.supplier_private_bindings;BEGIN
  b:=pactwoven.supplier_current_binding('authorizer');
  SELECT * INTO ev FROM pactwoven.supplier_admission_evidence WHERE id=NEW.evidence_id;
  PERFORM pactwoven.supplier_admission_require(NEW.database_oid=pactwoven.supplier_database_oid() AND NEW.session_user_oid=pactwoven.supplier_session_oid()
    AND NEW.backend_pid=pg_backend_pid() AND NEW.full_xid=pg_current_xact_id() AND ev.id IS NOT NULL AND ev.hash=NEW.evidence_hash
    AND ev.body->'binding'=b.body AND ev.body->>'kind'='factors' AND pactwoven.supplier_admission_evidence_valid(ev.body,clock_timestamp())
    AND pactwoven.supplier_object(NEW.material,ARRAY['evidence','facts','record','receipt','mutation']) AND NEW.material->'evidence'=ev.body
    AND NEW.material->'facts'=pactwoven.supplier_admission_identity(ev.body) AND NEW.material->'mutation'=ev.body#>'{request,mutation}'
    AND NEW.material#>'{receipt,result,record}'=NEW.material->'record'
    AND NEW.material#>>'{receipt,publicRequestHash}'=ev.body->>'mutationDigest'
    AND NEW.environment=ev.environment AND NEW.organization_id=ev.organization_id AND NEW.actor_id=ev.actor_id
    AND NEW.original_key=ev.body#>>'{request,mutation,idempotencyKey}');
  RETURN NEW;
END $$;
CREATE TRIGGER supplier_admission_context_append BEFORE INSERT ON pactwoven.supplier_admission_contexts FOR EACH ROW EXECUTE FUNCTION pactwoven.supplier_admission_context_guard();
CREATE FUNCTION pactwoven.supplier_admission_append_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE c pactwoven.supplier_admission_contexts:=pactwoven.supplier_admission_write_context();prior jsonb;r jsonb;BEGIN
  PERFORM pactwoven.supplier_admission_require(c.evidence_id IS NOT NULL AND pactwoven.supplier_admission_evidence_valid(c.material->'evidence',clock_timestamp()));
  r:=c.material->'record';
  IF TG_TABLE_NAME='supplier_administrator_grants' THEN
    prior:=pactwoven.supplier_admission_grant_head(NEW.environment,NEW.organization_id,NEW.member_id);
    PERFORM pactwoven.supplier_admission_require(NEW.record=r AND NEW.environment=c.environment AND NEW.organization_id=c.organization_id
      AND NEW.issuer_actor_id=c.actor_id AND NEW.original_key=c.original_key AND NEW.member_id=r#>>'{target,membershipId}'
      AND NEW.id=r->>'id' AND NEW.version=(r->>'version')::bigint AND NEW.hash=c.material#>>'{receipt,result,reference,hash}'
      AND NEW.hash=pactwoven.supplier_hash(jsonb_build_object('namespace','pactwoven/supplier-administrator-grant/v1','record',r))
      AND NEW.version=coalesce((prior#>>'{reference,version}')::bigint,0)+1
      AND r->'predecessor'=coalesce(prior->'reference','null'::jsonb)
      AND (prior IS NULL OR NEW.id=prior#>>'{reference,id}')
      AND (NEW.context_database,NEW.context_session,NEW.context_backend,NEW.context_xid)=(c.database_oid,c.session_user_oid,c.backend_pid,c.full_xid));
  ELSE
    PERFORM pactwoven.supplier_admission_require(NEW.environment=c.environment AND NEW.organization_id=c.organization_id AND NEW.issuer_actor_id=c.actor_id
      AND NEW.original_key=c.original_key AND NEW.member_id=r#>>'{target,membershipId}' AND NEW.grant_id=r->>'id' AND NEW.grant_version=(r->>'version')::bigint
      AND NEW.grant_hash=c.material#>>'{receipt,result,reference,hash}' AND NEW.mutation=c.material->'mutation' AND NEW.receipt=c.material->'receipt');
  END IF;RETURN NEW;
END $$;
CREATE TRIGGER supplier_admission_grant_append BEFORE INSERT ON pactwoven.supplier_administrator_grants FOR EACH ROW EXECUTE FUNCTION pactwoven.supplier_admission_append_guard();
CREATE TRIGGER supplier_admission_receipt_append BEFORE INSERT ON pactwoven.supplier_admission_receipts FOR EACH ROW EXECUTE FUNCTION pactwoven.supplier_admission_append_guard();

CREATE FUNCTION pactwoven.supplier_admission_record_evidence(v jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='3s' AS $$
DECLARE b pactwoven.supplier_private_bindings;l pactwoven.supplier_admission_lanes;h text;old pactwoven.supplier_admission_evidence;BEGIN
  PERFORM pactwoven.supplier_admission_require(current_setting('role')='none' AND pactwoven.supplier_admission_evidence_valid(v,clock_timestamp()));
  b:=pactwoven.supplier_current_binding('verifier');l:=pactwoven.supplier_admission_current_lane(b,v->'lane');
  PERFORM pactwoven.supplier_admission_require(v->'binding'=b.body);
  PERFORM pactwoven.supplier_admission_identity(v);
  b:=pactwoven.supplier_current_binding('verifier');l:=pactwoven.supplier_admission_current_lane(b,v->'lane');
  PERFORM pactwoven.supplier_admission_require(v->'binding'=b.body AND pactwoven.supplier_admission_evidence_valid(v,clock_timestamp()));
  h:=pactwoven.supplier_hash(jsonb_build_object('namespace','pactwoven/supplier-admission-evidence/v1','evidence',v));
  SELECT * INTO old FROM pactwoven.supplier_admission_evidence WHERE id=(v->>'id')::uuid;
  IF old.id IS NOT NULL THEN PERFORM pactwoven.supplier_admission_require(old.body=v AND old.hash=h,'conflict');
  ELSE
    INSERT INTO pactwoven.supplier_admission_evidence(id,hash,binding_id,binding_version,binding_hash,lane_id,lane_version,lane_hash,
      environment,organization_id,actor_id,observed_at,expires_at,body)
      VALUES((v->>'id')::uuid,h,b.id,b.version,b.hash,l.id,l.version,l.hash,b.environment,b.effective_organization_id,v#>>'{actor,actorId}',
        pactwoven.supplier_time(v->'observedAt'),pactwoven.supplier_time(v->'expiresAt'),v);
  END IF;
  RETURN jsonb_build_object('id',v->'id','version',1,'hash',h);
END $$;

CREATE FUNCTION pactwoven.supplier_admission_execute(eid uuid,q jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='3s' AS $$
DECLARE b pactwoven.supplier_private_bindings;l pactwoven.supplier_admission_lanes;ev pactwoven.supplier_admission_evidence;
  facts jsonb;old pactwoven.supplier_admission_receipts;review_row pactwoven.supplier_admission_reviews;previous jsonb;current_grant jsonb;
  selection jsonb;basis jsonb;material jsonb;review_hash text;record jsonb;receipt jsonb;result jsonb;original jsonb;locator jsonb;
  target_id text;grant_id text;grant_version bigint;member_version integer;organization_version integer;authority_epoch integer;
  at_time timestamptz;accepted_at text;expiry timestamptz;observation jsonb;admin_current boolean;request_key text;response jsonb;BEGIN
  PERFORM pactwoven.supplier_admission_require(current_setting('role')='none' AND pactwoven.supplier_admission_request(q));
  b:=pactwoven.supplier_current_binding('authorizer');
  SELECT * INTO ev FROM pactwoven.supplier_admission_evidence WHERE id=eid;
  PERFORM pactwoven.supplier_admission_require(ev.id IS NOT NULL AND ev.body->'binding'=b.body AND ev.body->'request'=q
    AND ev.hash=pactwoven.supplier_hash(jsonb_build_object('namespace','pactwoven/supplier-admission-evidence/v1','evidence',ev.body))
    AND pactwoven.supplier_admission_evidence_valid(ev.body,clock_timestamp()));
  l:=pactwoven.supplier_admission_current_lane(b,ev.body->'lane');facts:=pactwoven.supplier_admission_identity(ev.body);
  b:=pactwoven.supplier_current_binding('authorizer');l:=pactwoven.supplier_admission_current_lane(b,ev.body->'lane');
  PERFORM pactwoven.supplier_admission_require(ev.body->'binding'=b.body AND pactwoven.supplier_admission_evidence_valid(ev.body,clock_timestamp()));
  at_time:=clock_timestamp();accepted_at:=pactwoven.supplier_instant(at_time);
  observation:=jsonb_build_object('observedAt',accepted_at,'expiresAt',ev.body->'expiresAt');
  IF q->>'kind'='context' THEN
    current_grant:=pactwoven.supplier_admission_grant_head(ev.environment,ev.organization_id,ev.actor_id);
    admin_current:=pactwoven.supplier_admission_grant_current(ev.environment,ev.organization_id,ev.actor_id,
      (facts#>>'{issuer,membershipVersion}')::integer,(facts#>>'{organization,version}')::integer,(facts#>>'{organization,authorityEpoch}')::integer,at_time)
      AND facts->'issuerRoles' ? 'supplier_admin';
    expiry:=least(ev.expires_at,CASE WHEN facts->'issuerExpiresAt'='null'::jsonb THEN ev.expires_at ELSE pactwoven.supplier_time(facts->'issuerExpiresAt') END,
      CASE WHEN admin_current THEN pactwoven.supplier_time(current_grant#>'{record,expiresAt}') ELSE ev.expires_at END);
    -- A still-current context cannot outlive any current membership/grant end.
    observation:=jsonb_build_object('observedAt',accepted_at,'expiresAt',pactwoven.supplier_instant(expiry));
    PERFORM pactwoven.supplier_admission_require(expiry>at_time);
    RETURN jsonb_build_object('schemaVersion',1,'kind','SUPPLIER_ADMISSION_CONTEXT','environment',ev.environment,'party','supplier',
      'organization',facts->'organization','viewer',facts->'issuer','administration',jsonb_build_object('owner',true,'supplierAdministrator',admin_current,'grant',current_grant),
      'enrollment',jsonb_build_object('state','REVIEWABLE','blockers','[]'::jsonb),'observation',observation,'limitations',pactwoven.supplier_admission_limitations());
  END IF;
  IF q->>'kind' IN('enrollment-command','enrollment-recover') THEN
    request_key:=CASE WHEN q->>'kind'='enrollment-command' THEN q#>>'{mutation,idempotencyKey}' ELSE q#>>'{query,identity,idempotencyKey}' END;
    -- Broad original issuer/key lookup occurs before any target/action/hash comparison.
    SELECT * INTO old FROM pactwoven.supplier_admission_receipts r
      WHERE (r.environment,r.organization_id,r.issuer_actor_id,r.original_key)=(ev.environment,ev.organization_id,ev.actor_id,request_key);
    IF old.original_key IS NOT NULL THEN
      locator:=jsonb_build_object('identity',old.receipt->'identity','action',old.receipt->'action','target',old.mutation#>'{command,basis,target}',
        'previousGrant',old.mutation#>'{command,basis,previousGrant}','publicRequestHash',old.receipt->'publicRequestHash');
      PERFORM pactwoven.supplier_admission_require(CASE WHEN q->>'kind'='enrollment-command' THEN old.mutation=q->'mutation'
        AND old.receipt->'publicRequestHash'=ev.body->'mutationDigest' ELSE locator=q->'query' END,'conflict');
      current_grant:=pactwoven.supplier_admission_grant_head(ev.environment,ev.organization_id,old.member_id);
      PERFORM pactwoven.supplier_admission_require(current_grant IS NOT NULL AND old.receipt#>>'{result,reference,hash}'=old.grant_hash);
      original:=jsonb_build_object('exactPublicMutation',old.mutation,'receipt',old.receipt);
      response:=jsonb_build_object('request',locator,'observation',observation,'current',jsonb_build_object('status','AVAILABLE','grant',current_grant),
        'limitations',pactwoven.supplier_admission_limitations(),'original',original);
      RETURN response||CASE WHEN q->>'kind'='enrollment-command' THEN jsonb_build_object('kind','SUPPLIER_ENROLLMENT_COMMAND','outcome','EXACT_REPLAY')
        ELSE jsonb_build_object('kind','SUPPLIER_ENROLLMENT_RECOVERY','status','RECORDED') END;
    ELSIF q->>'kind'='enrollment-recover' THEN
      RETURN jsonb_build_object('kind','SUPPLIER_ENROLLMENT_RECOVERY','status','NOT_RECORDED','request',q->'query','observation',observation,
        'current',jsonb_build_object('status','UNAVAILABLE','grant',NULL),'original',NULL,'limitations',pactwoven.supplier_admission_limitations());
    END IF;
  END IF;
  selection:=CASE WHEN q->>'kind'='enrollment-review' THEN q#>'{query,selection}' ELSE q#>'{mutation,command,selection}' END;
  target_id:=facts#>>'{target,member,actorId}';
  previous:=CASE WHEN target_id IS NULL THEN NULL ELSE pactwoven.supplier_admission_grant_head(ev.environment,ev.organization_id,target_id) END;
  PERFORM pactwoven.supplier_admission_require(CASE WHEN selection->>'action'='grant' THEN previous IS NULL
      AND selection->'candidate'=ev.body#>'{target,reference}' AND NOT coalesce(facts#>'{target,roles}' ? 'supplier_admin',false)
    ELSE previous IS NOT NULL AND selection->'grant'=previous->'reference' END,'stale');
  IF selection->>'action'<>'revoke' THEN
    expiry:=pactwoven.supplier_time(selection->'expiresAt');
    PERFORM pactwoven.supplier_admission_require(expiry>at_time AND expiry-at_time<=interval '30 days'
      AND (facts->'target'='null'::jsonb OR facts#>'{target,expiresAt}'='null'::jsonb OR expiry<=pactwoven.supplier_time(facts#>'{target,expiresAt}')),'invalid');
  ELSE PERFORM pactwoven.supplier_admission_require(previous#>>'{record,status}'<>'REVOKED','stale');expiry:=at_time;END IF;
  basis:=jsonb_build_object('environment',ev.environment,'organization',(facts->'organization')-'name'-'status','issuer',facts->'issuer',
    'target',jsonb_build_object('candidate',ev.body#>'{target,reference}','member',facts#>'{target,member}'),
    'previousGrant',previous->'reference','observation',jsonb_build_object('observedAt',ev.body->'observedAt','expiresAt',ev.body->'expiresAt'));
  IF q->>'kind'='enrollment-command' THEN
    SELECT * INTO review_row FROM pactwoven.supplier_admission_reviews r WHERE r.hash=q#>>'{mutation,command,reviewHash}'
      AND (r.environment,r.organization_id,r.actor_id)=(ev.environment,ev.organization_id,ev.actor_id);
    PERFORM pactwoven.supplier_admission_require(review_row.hash IS NOT NULL AND review_row.material->'selection'=selection
      AND review_row.material->'basis'=q#>'{mutation,command,basis}'
      AND (review_row.material->'basis')-'observation'=basis-'observation'
      AND review_row.material->'previousGrant'=coalesce(previous,'null'::jsonb)
      AND review_row.material->'targetDisplayName'=ev.body#>'{target,displayName}'
      AND pactwoven.supplier_time(review_row.material#>'{basis,observation,observedAt}')<=at_time
      AND at_time<pactwoven.supplier_time(review_row.material#>'{basis,observation,expiresAt}'),'stale');
    basis:=review_row.material->'basis';
  END IF;
  material:=jsonb_build_object('schemaVersion',1,'role','supplier_admin','selection',selection,'basis',basis,
    'targetDisplayName',ev.body#>'{target,displayName}','previousGrant',previous);
  review_hash:=pactwoven.supplier_hash(jsonb_build_object('namespace','pactwoven/supplier-enrollment-review/v1','material',material));
  IF q->>'kind'='enrollment-review' THEN
    INSERT INTO pactwoven.supplier_admission_reviews(hash,evidence_id,environment,organization_id,actor_id,material)
      VALUES(review_hash,ev.id,ev.environment,ev.organization_id,ev.actor_id,material);
    PERFORM pactwoven.supplier_admission_require(pactwoven.supplier_admission_evidence_valid(ev.body,clock_timestamp()));
    RETURN jsonb_build_object('kind','SUPPLIER_ENROLLMENT_REVIEW','material',material,'reviewHash',review_hash,'state','REVIEWABLE','blockers','[]'::jsonb,
      'limitations',pactwoven.supplier_admission_limitations());
  END IF;
  PERFORM pactwoven.supplier_admission_require(q#>>'{mutation,command,reviewHash}'=review_hash AND ev.body->>'kind'='factors','stale');
  grant_version:=coalesce((previous#>>'{reference,version}')::bigint,0);
  member_version:=coalesce((facts#>>'{target,member,membershipVersion}')::integer,0);
  organization_version:=(facts#>>'{organization,version}')::integer;authority_epoch:=(facts#>>'{organization,authorityEpoch}')::integer;
  PERFORM pactwoven.supplier_admission_require(grant_version<9007199254740991 AND greatest(member_version,organization_version,authority_epoch)<2147483647,'stale');
  IF target_id IS NULL THEN target_id:=gen_random_uuid()::text;END IF;
  grant_id:=coalesce(previous#>>'{reference,id}',gen_random_uuid()::text);
  -- Effect time is taken only after all locks and before the mutually constrained write.
  at_time:=clock_timestamp();accepted_at:=pactwoven.supplier_instant(at_time);
  PERFORM pactwoven.supplier_admission_require(pactwoven.supplier_admission_evidence_valid(ev.body,at_time)
    AND at_time<pactwoven.supplier_time(basis#>'{observation,expiresAt}') AND (selection->>'action'='revoke' OR expiry>at_time),'stale');
  record:=jsonb_build_object('schemaVersion',1,'id',grant_id,'environment',ev.environment,'organizationId',ev.organization_id,'role','supplier_admin',
    'version',grant_version+1,'predecessor',previous->'reference','action',selection->'action','status',CASE WHEN selection->>'action'='revoke' THEN 'REVOKED' ELSE 'ACTIVE' END,
    'target',jsonb_build_object('actorId',target_id,'membershipId',target_id,'membershipVersion',member_version+1),'issuer',facts->'issuer',
    'organizationVersion',organization_version+1,'authorityEpoch',authority_epoch+1,'issuedAt',accepted_at,'validFrom',accepted_at,
    'expiresAt',CASE WHEN selection->>'action'='revoke' THEN to_jsonb(accepted_at) ELSE selection->'expiresAt' END);
  result:=jsonb_build_object('record',record,'reference',jsonb_build_object('id',grant_id,'version',grant_version+1,'hash',
    pactwoven.supplier_hash(jsonb_build_object('namespace','pactwoven/supplier-administrator-grant/v1','record',record))));
  receipt:=jsonb_build_object('identity',jsonb_build_object('environment',ev.environment,'organizationId',ev.organization_id,'actorId',ev.actor_id,'idempotencyKey',request_key),
    'action',selection->'action','publicRequestHash',ev.body->'mutationDigest','result',result,'recordedAt',accepted_at);
  INSERT INTO pactwoven.supplier_admission_contexts(database_oid,session_user_oid,backend_pid,full_xid,evidence_id,evidence_hash,environment,organization_id,actor_id,original_key,material)
    VALUES(pactwoven.supplier_database_oid(),pactwoven.supplier_session_oid(),pg_backend_pid(),pg_current_xact_id(),ev.id,ev.hash,ev.environment,ev.organization_id,ev.actor_id,request_key,
      jsonb_build_object('evidence',ev.body,'facts',facts,'record',record,'receipt',receipt,'mutation',q->'mutation'));
  PERFORM pactwoven.supplier_admission_identity_apply();
  INSERT INTO pactwoven.supplier_administrator_grants(environment,organization_id,member_id,id,version,hash,record,issuer_actor_id,original_key,
    context_database,context_session,context_backend,context_xid)
    VALUES(ev.environment,ev.organization_id,target_id,grant_id,grant_version+1,result#>>'{reference,hash}',record,ev.actor_id,request_key,
      pactwoven.supplier_database_oid(),pactwoven.supplier_session_oid(),pg_backend_pid(),pg_current_xact_id());
  INSERT INTO pactwoven.supplier_admission_receipts(environment,organization_id,issuer_actor_id,original_key,member_id,grant_id,grant_version,grant_hash,mutation,receipt)
    VALUES(ev.environment,ev.organization_id,ev.actor_id,request_key,target_id,grant_id,grant_version+1,result#>>'{reference,hash}',q->'mutation',receipt);
  locator:=jsonb_build_object('identity',receipt->'identity','action',receipt->'action','target',basis->'target','previousGrant',basis->'previousGrant','publicRequestHash',receipt->'publicRequestHash');
  RETURN jsonb_build_object('kind','SUPPLIER_ENROLLMENT_COMMAND','outcome','APPENDED','request',locator,
    'observation',jsonb_build_object('observedAt',pactwoven.supplier_instant(clock_timestamp()),'expiresAt',ev.body->'expiresAt'),
    'current',jsonb_build_object('status','AVAILABLE','grant',result),'original',jsonb_build_object('exactPublicMutation',q->'mutation','receipt',receipt),
    'limitations',pactwoven.supplier_admission_limitations());
END $$;

-- Canonical shared site descriptors. Existing site identity cannot be rebound,
-- hard-deleted or truncated and then recreated with an old version. A future
-- deletion workflow must use an independently reviewed tombstone contract.
CREATE FUNCTION pactwoven.site_descriptor_hash(e text,o text,i text,n text,t text,v integer) RETURNS text
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT pactwoven.supplier_hash(jsonb_build_object('namespace','pactwoven/site-descriptor/v1','descriptor',
    jsonb_build_object('environment',e,'organizationId',o,'id',i,'name',n,'timeZone',t,'version',v)))
$$;
ALTER TABLE pactwoven.sites ADD COLUMN row_version integer NOT NULL DEFAULT 1 CHECK(row_version>0);
ALTER TABLE pactwoven.sites ADD COLUMN record_hash text;
UPDATE pactwoven.sites SET record_hash=pactwoven.site_descriptor_hash(environment,organization_id,id,name,time_zone,row_version);
ALTER TABLE pactwoven.sites ALTER COLUMN record_hash SET NOT NULL;
ALTER TABLE pactwoven.sites ADD CONSTRAINT site_descriptor_hash_exact CHECK(record_hash=pactwoven.site_descriptor_hash(environment,organization_id,id,name,time_zone,row_version));
CREATE FUNCTION pactwoven.guard_site_descriptor_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
  IF TG_OP='DELETE' OR TG_OP='TRUNCATE' THEN RAISE EXCEPTION USING ERRCODE='SA004',MESSAGE='Site identity requires a reviewed tombstone';END IF;
  IF TG_OP='INSERT' THEN
    PERFORM pactwoven.supplier_admission_require(NEW.row_version=1,'invalid');
  ELSE
    PERFORM pactwoven.supplier_admission_require((NEW.environment,NEW.organization_id,NEW.id) IS NOT DISTINCT FROM (OLD.environment,OLD.organization_id,OLD.id),'invalid');
    IF (NEW.name,NEW.time_zone) IS DISTINCT FROM (OLD.name,OLD.time_zone) THEN
      PERFORM pactwoven.supplier_admission_require(OLD.row_version<2147483647 AND NEW.row_version IN(OLD.row_version,OLD.row_version+1),'stale');
      NEW.row_version:=OLD.row_version+1;
    ELSE PERFORM pactwoven.supplier_admission_require(NEW.row_version=OLD.row_version,'invalid');END IF;
  END IF;
  NEW.record_hash:=pactwoven.site_descriptor_hash(NEW.environment,NEW.organization_id,NEW.id,NEW.name,NEW.time_zone,NEW.row_version);
  RETURN NEW;
END $$;
CREATE TRIGGER site_descriptor_version BEFORE INSERT OR UPDATE OR DELETE ON pactwoven.sites FOR EACH ROW EXECUTE FUNCTION pactwoven.guard_site_descriptor_version();
CREATE TRIGGER site_no_identity_reuse BEFORE TRUNCATE ON pactwoven.sites FOR EACH STATEMENT EXECUTE FUNCTION pactwoven.guard_site_descriptor_version();

-- Forward replacements retain the frozen record/hash shapes, stop policy and
-- managed-creator role exception. Only the exact current-grant prerequisite and
-- two fixed admission entrypoint overloads are added.

-- Supplier enrollment does not confer generic all-site reads. Dedicated supplier
-- disclosure stays behind its fixed pair-bound entrypoints. Preserve unrelated
-- organization roles and explicit site grants exactly as installed.
CREATE OR REPLACE FUNCTION pactwoven.can_read_site(target_environment text,target_organization text,target_site text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT pactwoven.has_membership(target_environment,target_organization)
    AND (pactwoven.has_role(ARRAY['owner','finance','auditor']::text[]) OR EXISTS(
      SELECT 1 FROM pactwoven.site_memberships sm WHERE sm.environment=target_environment AND sm.organization_id=target_organization
        AND sm.site_id=target_site AND sm.actor_id=current_setting('pactwoven.actor_id',true)))
$$;

CREATE OR REPLACE FUNCTION pactwoven.supplier_base_identity(v jsonb,site_ids jsonb,approver_ids jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='3s' AS $$
DECLARE scope jsonb:=pactwoven.supplier_request_scope(v->'request');e text:=scope->>'environment';
  buyer text:=scope->>'buyerOrganizationId';supplier text:=scope->>'supplierOrganizationId';
  acting_org text:=v#>>'{actor,organizationId}';acting_actor text:=v#>>'{actor,actorId}';
  organizations jsonb:='{}';members jsonb:='[]';sites jsonb:='[]';actor_member jsonb;row_value record;member_value jsonb;requested jsonb;
BEGIN
  PERFORM pactwoven.supplier_require(pactwoven.supplier_request_valid(v->'request') AND acting_org IN (buyer,supplier)
    AND e=v#>>'{actor,environment}' AND jsonb_typeof(site_ids)='array' AND jsonb_array_length(site_ids)<=100
    AND jsonb_typeof(approver_ids)='array' AND jsonb_array_length(approver_ids)<=2
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(approver_ids) x WHERE NOT pactwoven.supplier_object(x,ARRAY['organizationId','actorId'])
      OR x->>'organizationId' NOT IN (buyer,supplier) OR NOT pactwoven.supplier_id(x->'actorId'))
    AND (SELECT count(*)=count(DISTINCT x) FROM jsonb_array_elements(approver_ids) x));
  requested:=CASE WHEN v#>>'{request,kind}'='policy-command' AND v#>>'{request,mutation,command,payload,action}' IN ('issue','replace')
    THEN v#>'{request,mutation,command,payload,terms,buyerSiteIds}' ELSE '[]'::jsonb END;
  -- Actor admission/replay resolves no sites. A new policy effect may resolve
  -- the complete exact requested set, never a caller-selected subset/list.
  PERFORM pactwoven.supplier_require(site_ids='[]'::jsonb OR site_ids=requested);
  FOR row_value IN SELECT o.environment,o.id,o.external_organization_id,o.status,o.authority_epoch,o.row_version,o.created_at
    FROM pactwoven.organizations o WHERE o.environment=e AND o.id IN (buyer,supplier) ORDER BY o.id COLLATE "C" FOR SHARE LOOP
    organizations:=organizations||jsonb_build_object(CASE WHEN row_value.id=buyer THEN 'buyer' ELSE 'supplier' END,
      jsonb_build_object('id',row_value.id,'environment',row_value.environment,'externalOrganizationId',row_value.external_organization_id,
        'version',row_value.row_version,'authorityEpoch',row_value.authority_epoch,'status',CASE row_value.status WHEN 'active' THEN 'ACTIVE' WHEN 'suspended' THEN 'SUSPENDED' ELSE 'REVOKED' END,
        'validFrom',pactwoven.supplier_instant(row_value.created_at),'expiresAt',NULL));
  END LOOP;
  PERFORM pactwoven.supplier_require(organizations ?& ARRAY['buyer','supplier']);
  LOCK TABLE pactwoven.session_revocations IN SHARE MODE;
  PERFORM pactwoven.supplier_require(NOT EXISTS(SELECT 1 FROM pactwoven.session_revocations r WHERE r.environment=e AND r.session_id=v#>>'{actor,sessionId}'));
  FOR row_value IN SELECT m.environment,m.organization_id,m.actor_id,m.external_subject,m.external_membership_id,m.grant_basis,
    m.roles,m.status,m.row_version,m.created_at,m.expires_at FROM pactwoven.memberships m WHERE m.environment=e
    AND ((m.organization_id=acting_org AND m.actor_id=acting_actor) OR EXISTS(SELECT 1 FROM jsonb_array_elements(approver_ids) x
      WHERE x->>'organizationId'=m.organization_id AND x->>'actorId'=m.actor_id))
    ORDER BY m.organization_id COLLATE "C",m.actor_id COLLATE "C" FOR SHARE LOOP
    member_value:=jsonb_build_object('environment',e,'organizationId',row_value.organization_id,'id',row_value.actor_id,'actorId',row_value.actor_id,
      'subject',row_value.external_subject,'externalMembershipId',row_value.external_membership_id,'grantBasis',row_value.grant_basis,
      'version',row_value.row_version,'organizationEpoch',organizations->CASE WHEN row_value.organization_id=buyer THEN 'buyer' ELSE 'supplier' END->'authorityEpoch',
      'roles',to_jsonb(row_value.roles),'principalKind',CASE WHEN 'service'=ANY(row_value.roles) THEN 'service' ELSE 'human' END,
      'status',upper(row_value.status),'validFrom',pactwoven.supplier_instant(row_value.created_at),'expiresAt',pactwoven.supplier_instant(row_value.expires_at));
    IF row_value.organization_id=acting_org AND row_value.actor_id=acting_actor THEN actor_member:=member_value;END IF;
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(approver_ids) x WHERE x->>'organizationId'=row_value.organization_id AND x->>'actorId'=row_value.actor_id)
      THEN members:=members||jsonb_build_array(member_value);END IF;
  END LOOP;
  PERFORM pactwoven.supplier_require(actor_member IS NOT NULL AND actor_member->>'id'=v#>>'{actor,membershipId}'
    AND actor_member->>'principalKind'='human' AND actor_member->>'status'='ACTIVE'
    AND pactwoven.supplier_time(actor_member->'validFrom')<=clock_timestamp()
    AND actor_member->'roles' ? CASE WHEN acting_org=buyer THEN 'owner' ELSE 'supplier_admin' END
    AND (acting_org=buyer OR pactwoven.supplier_admission_grant_current(e,acting_org,acting_actor,(actor_member->>'version')::integer,
      (organizations#>>'{supplier,version}')::integer,(organizations#>>'{supplier,authorityEpoch}')::integer,clock_timestamp()))
    AND (actor_member->'expiresAt'='null'::jsonb OR pactwoven.supplier_time(actor_member->'expiresAt')>clock_timestamp())
    AND actor_member->>'subject'=v#>>'{actor,subject}' AND actor_member->>'externalMembershipId'=v#>>'{actor,externalMembershipId}'
    AND actor_member->'version'=v#>'{actor,membershipVersion}' AND actor_member->'organizationEpoch'=v#>'{actor,organizationEpoch}'
    AND (actor_member->>'grantBasis'<>'clerk_admin_bootstrap' OR v#>>'{observation,externalRole}'='org:admin'));
  member_value:=organizations->CASE WHEN acting_org=buyer THEN 'buyer' ELSE 'supplier' END;
  PERFORM pactwoven.supplier_require(member_value->>'status'='ACTIVE' AND pactwoven.supplier_time(member_value->'validFrom')<=clock_timestamp() AND member_value->'version'=v#>'{actor,organizationVersion}'
    AND member_value->>'externalOrganizationId'=v#>>'{actor,externalOrganizationId}');
  FOR row_value IN SELECT s.environment,s.organization_id,s.id FROM pactwoven.sites s WHERE s.environment=e AND s.organization_id=buyer
    AND site_ids ? s.id ORDER BY s.id COLLATE "C" FOR SHARE LOOP
    sites:=sites||jsonb_build_array(jsonb_build_object('environment',row_value.environment,'organizationId',row_value.organization_id,'id',row_value.id));
  END LOOP;
  PERFORM pactwoven.supplier_require(jsonb_array_length(sites)=jsonb_array_length(site_ids));
  RETURN jsonb_build_object('organizations',organizations,'actingMembership',actor_member,'approverMemberships',members,'selectedBuyerSites',sites);
END $$;

CREATE OR REPLACE FUNCTION pactwoven.supplier_observer_identity(e text,target_organization text,v jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='3s' AS $$
DECLARE o record;m record;at_time timestamptz;BEGIN
  PERFORM pactwoven.supplier_read_committed();
  PERFORM pactwoven.supplier_require(e IN ('simulation','development','staging','production')
    AND pactwoven.supplier_id(to_jsonb(target_organization)) AND pactwoven.supplier_observation_current(v,clock_timestamp()));
  -- Lock order follows 0015: caller already holds registry and binding lineage,
  -- then exact organization, revocation table, exact membership. No provisioning.
  PERFORM org.id FROM pactwoven.organizations org WHERE org.environment=e AND org.id=target_organization
    AND org.external_organization_id=v->>'externalOrganizationId' FOR SHARE;
  PERFORM pactwoven.supplier_require(FOUND);
  LOCK TABLE pactwoven.session_revocations IN SHARE MODE;
  PERFORM member.actor_id FROM pactwoven.memberships member WHERE member.environment=e AND member.organization_id=target_organization
    AND member.external_subject=v->>'subject' AND member.external_membership_id=v->>'externalMembershipId' FOR SHARE;
  PERFORM pactwoven.supplier_require(FOUND);
  -- Separate READ COMMITTED statements after every lock wait observe the latest
  -- local versions. Held locks prevent a later local change until transaction end.
  SELECT org.id,org.environment,org.external_organization_id,org.status,org.created_at,org.row_version,org.authority_epoch
    INTO o FROM pactwoven.organizations org WHERE org.environment=e AND org.id=target_organization
      AND org.external_organization_id=v->>'externalOrganizationId';
  SELECT member.actor_id,member.external_subject,member.external_membership_id,member.status,member.roles,
    member.grant_basis,member.created_at,member.expires_at,member.row_version
    INTO m FROM pactwoven.memberships member WHERE member.environment=e AND member.organization_id=target_organization
      AND member.external_subject=v->>'subject' AND member.external_membership_id=v->>'externalMembershipId';
  at_time:=clock_timestamp();
  PERFORM pactwoven.supplier_require(pactwoven.supplier_observation_current(v,at_time)
    AND o.id IS NOT NULL AND o.status='active' AND o.created_at<=at_time
    AND m.actor_id IS NOT NULL AND m.status='active' AND m.created_at<=at_time
    AND (m.expires_at IS NULL OR m.expires_at>at_time)
    AND NOT('service'=ANY(m.roles)) AND ('owner'=ANY(m.roles) OR 'supplier_admin'=ANY(m.roles)
      AND pactwoven.supplier_admission_grant_current(e,o.id,m.actor_id,m.row_version,o.row_version,o.authority_epoch,at_time))
    AND (m.grant_basis<>'clerk_admin_bootstrap' OR v->>'externalRole'='org:admin')
    AND NOT EXISTS(SELECT 1 FROM pactwoven.session_revocations r WHERE r.environment=e AND r.session_id=v->>'sessionId'));
  -- This stamp is identity resolution, never request/party/business authority.
  -- The existing recorder and authorizer independently recheck it under locks.
  RETURN jsonb_build_object('environment',e,'organizationId',o.id,'actorId',m.actor_id,'principalKind','human',
    'membershipId',m.actor_id,'membershipVersion',m.row_version,'organizationVersion',o.row_version,'organizationEpoch',o.authority_epoch,
    'subject',m.external_subject,'externalOrganizationId',o.external_organization_id,
    'externalMembershipId',m.external_membership_id,'sessionId',v->>'sessionId');
END $$;

CREATE OR REPLACE FUNCTION pactwoven.supplier_approval_current(approval jsonb,facts jsonb,at_time timestamptz) RETURNS boolean
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog AS $$
DECLARE member jsonb;org jsonb;ob jsonb;BEGIN
  IF approval IS NULL OR approval='null'::jsonb THEN RETURN false;END IF;
  org:=facts->'organizations'->(approval->>'party');
  SELECT m INTO member FROM jsonb_array_elements(facts->'approverMemberships') m
    WHERE m->'id'=approval->'membershipId' AND m->'organizationId'=approval->'organizationId' AND m->'actorId'=approval->'actorId';
  SELECT x->'observation' INTO ob FROM jsonb_array_elements(facts->'approverObservations') x WHERE x->'approval'=approval;
  -- Resolution already proved observation availability and exact original identity.
  RETURN coalesce(org->>'status'='ACTIVE' AND pactwoven.supplier_time(org->'validFrom')<=at_time
    AND member->>'principalKind'='human' AND member->>'status'='ACTIVE' AND ob->>'status'='ACTIVE'
    AND pactwoven.supplier_membership_observation(ob,at_time)
    AND member->'version'=approval->'membershipVersion' AND member->'organizationEpoch'=approval->'organizationEpoch'
    AND org->'authorityEpoch'=approval->'organizationEpoch' AND org->'version'=approval->'organizationVersion'
    AND pactwoven.supplier_time(member->'validFrom')<=pactwoven.supplier_time(approval->'approvedAt')
    AND (member->'expiresAt'='null'::jsonb OR at_time<pactwoven.supplier_time(member->'expiresAt'))
    AND member->'roles' ? CASE WHEN approval->>'party'='buyer' THEN 'owner' ELSE 'supplier_admin' END
    AND (approval->>'party'='buyer' OR pactwoven.supplier_admission_grant_current(org->>'environment',org->>'id',member->>'actorId',
      (member->>'version')::integer,(org->>'version')::integer,(org->>'authorityEpoch')::integer,at_time))
    AND (member->>'grantBasis'<>'clerk_admin_bootstrap' OR ob->>'externalRole'='org:admin')
    AND pactwoven.supplier_time(approval->'approvedAt')<=at_time AND at_time<pactwoven.supplier_time(approval->'expiresAt'),false);
END $$;

CREATE OR REPLACE FUNCTION pactwoven.supplier_role_safe(who oid,capability text) RETURNS boolean
LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$
  SELECT coalesce((SELECT r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreatedb
    AND NOT r.rolcreaterole AND NOT r.rolreplication AND NOT r.rolinherit AND r.rolconfig IS NULL
    AND NOT EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid OR (m.roleid=r.oid AND NOT(
      m.admin_option AND NOT m.inherit_option AND NOT m.set_option
      -- OID 10 is PostgreSQL's original bootstrap superuser, not a role-name proxy.
      AND m.grantor=10 AND EXISTS(SELECT 1 FROM pg_roles g WHERE g.oid=m.grantor AND g.rolsuper)
      AND EXISTS(SELECT 1 FROM pg_namespace owner_schema WHERE owner_schema.nspname='pactwoven'
        AND owner_schema.nspowner=m.member
        AND (SELECT count(*) FROM pg_class c WHERE c.relnamespace=owner_schema.oid
          AND c.relname IN ('organizations','memberships','session_revocations','sites')
          AND c.relkind='r' AND c.relrowsecurity AND c.relowner=m.member)=4
        AND (SELECT count(*) FROM pg_proc f WHERE f.oid=ANY(ARRAY[
          to_regprocedure('pactwoven.supplier_base_identity(jsonb,jsonb,jsonb)'),
          to_regprocedure('pactwoven.supplier_observer_identity(text,text,jsonb)')]::oid[])
          AND f.proowner=m.member AND f.prosecdef)=2))))
    AND NOT has_database_privilege(r.oid,pactwoven.supplier_database_oid(),'CREATE')
    AND NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname!~'^pg_temp_' AND has_schema_privilege(r.oid,n.oid,'CREATE'))
    AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname!~'^pg_(temp|toast)'
      AND c.relkind IN ('r','p','v','m','f') AND (has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        OR has_any_column_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
    AND NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname!~'^pg_(temp|toast)'
      AND has_function_privilege(r.oid,p.oid,'EXECUTE') AND NOT
      (capability='verifier' AND p.oid=ANY(ARRAY[to_regprocedure('pactwoven.supplier_record_evidence(jsonb)'),to_regprocedure('pactwoven.supplier_resolve_observer(jsonb,jsonb)'),to_regprocedure('pactwoven.supplier_admission_record_evidence(jsonb)')]::oid[]) OR capability='authorizer' AND p.oid=ANY(ARRAY[
        to_regprocedure('pactwoven.supplier_scope_policy_command(uuid,jsonb)'),to_regprocedure('pactwoven.supplier_scope_policy_read(uuid,jsonb)'),
        to_regprocedure('pactwoven.supplier_relationship_command(uuid,jsonb)'),to_regprocedure('pactwoven.supplier_relationship_status(uuid,jsonb)'),
        to_regprocedure('pactwoven.supplier_relationship_recover(uuid,jsonb)'),to_regprocedure('pactwoven.supplier_admission_execute(uuid,jsonb)')]::oid[])))
    FROM pg_roles r WHERE r.oid=who),false)
$$;


-- Strip inherited/default ACLs from exactly the newly installed objects. The
-- four forward replacements retain their existing ownership/EXECUTE audiences.
DO $$ DECLARE legacy_owner oid;legacy_name text;table_name text;fn record;grant_row record;BEGIN
  SELECT c.relowner,r.rolname INTO legacy_owner,legacy_name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_roles r ON r.oid=c.relowner WHERE n.nspname='pactwoven' AND c.relname='organizations' AND r.rolname=current_user;
  IF legacy_owner IS NULL THEN RAISE EXCEPTION 'Exact supplier identity owner required';END IF;
  FOREACH table_name IN ARRAY ARRAY['supplier_admission_lanes','supplier_admission_evidence','supplier_admission_contexts',
    'supplier_admission_reviews','supplier_administrator_grants','supplier_admission_receipts'] LOOP
    FOR grant_row IN SELECT DISTINCT a.grantee,r.rolname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a LEFT JOIN pg_roles r ON r.oid=a.grantee
      WHERE n.nspname='pactwoven' AND c.relname=table_name AND a.grantee<>c.relowner LOOP
      EXECUTE format('REVOKE ALL ON TABLE pactwoven.%I FROM %s',table_name,CASE WHEN grant_row.grantee=0 THEN 'PUBLIC' ELSE quote_ident(grant_row.rolname) END);
    END LOOP;
    EXECUTE format('ALTER TABLE pactwoven.%I OWNER TO pactwoven_supplier_owner',table_name);
    EXECUTE format('ALTER TABLE pactwoven.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE pactwoven.%I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('REVOKE ALL ON TABLE pactwoven.%I FROM PUBLIC',table_name);
    EXECUTE format('GRANT SELECT ON TABLE pactwoven.%I TO pactwoven_supplier_executor',table_name);
    IF table_name<>'supplier_admission_lanes' THEN EXECUTE format('GRANT INSERT ON TABLE pactwoven.%I TO pactwoven_supplier_executor',table_name);END IF;
    EXECUTE format('CREATE TRIGGER supplier_admission_no_change BEFORE UPDATE OR DELETE ON pactwoven.%I FOR EACH ROW EXECUTE FUNCTION pactwoven.supplier_immutable()',table_name);
    EXECUTE format('CREATE TRIGGER supplier_admission_no_truncate BEFORE TRUNCATE ON pactwoven.%I FOR EACH STATEMENT EXECUTE FUNCTION pactwoven.supplier_immutable()',table_name);
  END LOOP;
  FOR grant_row IN SELECT DISTINCT a.grantee,r.rolname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a LEFT JOIN pg_roles r ON r.oid=a.grantee
    WHERE n.nspname='pactwoven' AND c.relname='supplier_administrator_current' AND a.grantee<>c.relowner LOOP
    EXECUTE format('REVOKE ALL ON TABLE pactwoven.supplier_administrator_current FROM %s',
      CASE WHEN grant_row.grantee=0 THEN 'PUBLIC' ELSE quote_ident(grant_row.rolname) END);
  END LOOP;
  ALTER VIEW pactwoven.supplier_administrator_current OWNER TO pactwoven_supplier_owner;
  REVOKE ALL ON pactwoven.supplier_administrator_current FROM PUBLIC;
  GRANT SELECT ON pactwoven.supplier_administrator_current TO pactwoven_supplier_executor;
  FOR fn IN SELECT p.oid,p.proowner,p.proname,p.oid::regprocedure AS identity FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='pactwoven' AND (p.proname LIKE 'supplier_admission_%' OR p.proname IN('site_descriptor_hash','guard_site_descriptor_version')) LOOP
    FOR grant_row IN SELECT DISTINCT a.grantee,r.rolname FROM pg_proc p
      CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a LEFT JOIN pg_roles r ON r.oid=a.grantee
      WHERE p.oid=fn.oid AND a.grantee<>p.proowner LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %s',fn.identity,CASE WHEN grant_row.grantee=0 THEN 'PUBLIC' ELSE quote_ident(grant_row.rolname) END);
    END LOOP;
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',fn.identity);
    IF fn.proname IN('supplier_admission_identity','supplier_admission_identity_apply','guard_site_descriptor_version') THEN
      EXECUTE format('ALTER FUNCTION %s OWNER TO %I',fn.identity,legacy_name);
      IF fn.proname<>'guard_site_descriptor_version' THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pactwoven_supplier_executor',fn.identity);END IF;
    ELSE EXECUTE format('ALTER FUNCTION %s OWNER TO pactwoven_supplier_executor',fn.identity);END IF;
  END LOOP;
  EXECUTE format('GRANT EXECUTE ON FUNCTION pactwoven.supplier_admission_require(boolean,text),
    pactwoven.supplier_admission_member_pin(jsonb),pactwoven.supplier_admission_observation(jsonb),
    pactwoven.supplier_admission_selection(jsonb),pactwoven.supplier_admission_basis(jsonb),
    pactwoven.supplier_admission_command(jsonb),pactwoven.supplier_admission_recovery(jsonb),pactwoven.supplier_admission_request(jsonb),
    pactwoven.supplier_admission_evidence_valid(jsonb,timestamptz),pactwoven.supplier_membership_observation(jsonb,timestamptz),
    pactwoven.supplier_hash(jsonb),pactwoven.supplier_canonical(jsonb),
    pactwoven.supplier_admission_grant_current(text,text,text,integer,integer,integer,timestamptz),
    pactwoven.supplier_admission_write_context(),pactwoven.site_descriptor_hash(text,text,text,text,text,integer) TO %I',legacy_name);
  -- This pure hash helper supports existing site writes. It cannot read a site,
  -- resolve a supplier, mint context or modify any row.
  GRANT EXECUTE ON FUNCTION pactwoven.site_descriptor_hash(text,text,text,text,text,integer) TO pactwoven_runtime;
  IF NOT (SELECT rolsuper FROM pg_roles WHERE oid=legacy_owner) THEN
    REVOKE CREATE ON SCHEMA pactwoven FROM pactwoven_supplier_owner,pactwoven_supplier_executor;
    EXECUTE format('REVOKE pactwoven_supplier_owner,pactwoven_supplier_executor FROM %I GRANTED BY %I',legacy_name,legacy_name);
  END IF;
END $$;

COMMIT;
