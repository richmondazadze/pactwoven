BEGIN;

-- D08: runtime functions execute as a separate non-owner, not the table owner.
-- This migration installs no runtime login, password, membership or private
-- binding. Reserved names must be unused; offline enrollment is separate.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('pactwoven_supplier_owner','pactwoven_supplier_executor'))
    OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='pactwoven' AND p.proname LIKE 'supplier_%') THEN
    RAISE EXCEPTION 'Supplier authority namespace must be reserved and unused';
  END IF;
END $$;
CREATE ROLE pactwoven_supplier_owner NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE pactwoven_supplier_executor NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA pactwoven TO pactwoven_supplier_owner,pactwoven_supplier_executor;

CREATE FUNCTION pactwoven.supplier_require(ok boolean) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ BEGIN
  IF ok IS DISTINCT FROM true THEN
    RAISE EXCEPTION USING ERRCODE='SP001',MESSAGE='Supplier private boundary refused';
  END IF;
END $$;

CREATE FUNCTION pactwoven.supplier_object(v jsonb,ks text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT coalesce(jsonb_typeof(v)='object' AND v ?& ks AND
    NOT EXISTS(SELECT 1 FROM jsonb_object_keys(v) k WHERE NOT k=ANY(ks)),false)
$$;
CREATE FUNCTION pactwoven.supplier_id(v jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT coalesce(jsonb_typeof(v)='string' AND v#>>'{}' ~ '^[A-Za-z0-9_-]{1,128}$',false)
$$;
CREATE FUNCTION pactwoven.supplier_integer(v jsonb,lo numeric,hi numeric) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ BEGIN
  RETURN coalesce(jsonb_typeof(v)='number' AND (v::text)::numeric=trunc((v::text)::numeric)
    AND (v::text)::numeric BETWEEN lo AND hi,false);
EXCEPTION WHEN OTHERS THEN RETURN false;END $$;
-- Parse the frozen InstantSchema grammar without changing its hashed text.
-- Dates are proleptic Gregorian, including astronomical year 0000. Offsets are
-- +/-00:00 through +/-23:59. Seconds are required; leap seconds/24:00 are not.
-- Date.parse uses millisecond precision: extra fractional digits truncate, never
-- round. Compute civil days explicitly to avoid PostgreSQL's year-zero spelling,
-- session timezone/DST and microsecond rounding of a long epoch interval.
CREATE FUNCTION pactwoven.supplier_time(v jsonb) RETURNS timestamptz
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE parts text[];y integer;mo integer;d integer;hh integer;mi integer;ss integer;ms integer;offset_minutes integer:=0;
  leap boolean;month_days integer;days integer;epoch_ms bigint;t timestamptz;BEGIN
  PERFORM pactwoven.supplier_require(jsonb_typeof(v)='string');
  parts:=regexp_match(v#>>'{}','^([0-9]{4})-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):([0-5][0-9]):([0-5][0-9])(?:\.([0-9]+))?(Z|([+-])([01][0-9]|2[0-3]):([0-5][0-9]))$');
  PERFORM pactwoven.supplier_require(parts IS NOT NULL);
  y:=parts[1]::integer;mo:=parts[2]::integer;d:=parts[3]::integer;hh:=parts[4]::integer;mi:=parts[5]::integer;ss:=parts[6]::integer;
  ms:=rpad(left(coalesce(parts[7],''),3),3,'0')::integer;
  leap:=y%4=0 AND (y%100<>0 OR y%400=0);
  month_days:=(ARRAY[31,CASE WHEN leap THEN 29 ELSE 28 END,31,30,31,30,31,31,30,31,30,31])[mo];
  PERFORM pactwoven.supplier_require(d<=month_days);
  IF parts[8]<>'Z' THEN offset_minutes:=(parts[10]::integer*60+parts[11]::integer)*CASE WHEN parts[9]='+' THEN 1 ELSE -1 END;END IF;
  days:=365*y+floor((y-1)::numeric/4)::integer-floor((y-1)::numeric/100)::integer+floor((y-1)::numeric/400)::integer+1
    +(ARRAY[0,31,59,90,120,151,181,212,243,273,304,334])[mo]+CASE WHEN leap AND mo>2 THEN 1 ELSE 0 END+d-1-719528;
  epoch_ms:=((days::bigint*24+hh)*60+mi-offset_minutes)*60000+ss*1000+ms;
  PERFORM pactwoven.supplier_require(abs(epoch_ms)<=8640000000000000);
  t:=(timestamp '1970-01-01 00:00:00'+make_interval(days=>days,mins=>hh*60+mi-offset_minutes,secs=>ss+ms/1000.0)) AT TIME ZONE 'UTC';
  PERFORM pactwoven.supplier_require(isfinite(t));RETURN t;
END $$;
CREATE FUNCTION pactwoven.supplier_instant(v timestamptz) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT to_char(v AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;
CREATE FUNCTION pactwoven.supplier_canonical(v jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ DECLARE result text;BEGIN
  CASE jsonb_typeof(v)
    WHEN 'object' THEN SELECT '{'||coalesce(string_agg(to_jsonb(k)::text||':'||pactwoven.supplier_canonical(x),',' ORDER BY k COLLATE "C"),'')||'}'
      INTO result FROM jsonb_each(v) f(k,x);RETURN result;
    WHEN 'array' THEN SELECT '['||coalesce(string_agg(pactwoven.supplier_canonical(x),',' ORDER BY ord),'')||']'
      INTO result FROM jsonb_array_elements(v) WITH ORDINALITY f(x,ord);RETURN result;
    WHEN 'number' THEN RETURN trim_scale((v::text)::numeric)::text;
    WHEN 'string','boolean','null' THEN RETURN v::text;
    ELSE RAISE EXCEPTION USING ERRCODE='SP001',MESSAGE='Canonical supplier value required';
  END CASE;
END $$;
CREATE FUNCTION pactwoven.supplier_hash(v jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT encode(sha256(convert_to(pactwoven.supplier_canonical(v),'UTF8')),'hex')
$$;
CREATE FUNCTION pactwoven.supplier_binding_hash(v jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT pactwoven.supplier_hash(jsonb_build_object('namespace','pactwoven/supplier-private-binding/v1',
    'binding',jsonb_set(v,'{reference}',(v->'reference')-'hash'::text)))
$$;
CREATE FUNCTION pactwoven.supplier_evidence_hash(v jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT pactwoven.supplier_hash(jsonb_build_object('namespace','pactwoven/supplier-private-auth-evidence/v1','evidence',v))
$$;
CREATE FUNCTION pactwoven.supplier_pair(v jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT pactwoven.supplier_object(v,ARRAY['environment','buyerOrganizationId','supplierOrganizationId'])
    AND v->>'environment' IN ('simulation','development','staging','production')
    AND pactwoven.supplier_id(v->'buyerOrganizationId') AND pactwoven.supplier_id(v->'supplierOrganizationId')
    AND v->>'buyerOrganizationId'<>v->>'supplierOrganizationId'
$$;
CREATE FUNCTION pactwoven.supplier_scope(v jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT pactwoven.supplier_object(v,ARRAY['environment','buyerOrganizationId','supplierOrganizationId','supplierRelationshipId'])
    AND pactwoven.supplier_pair(v-'supplierRelationshipId') AND pactwoven.supplier_id(v->'supplierRelationshipId')
$$;
CREATE FUNCTION pactwoven.supplier_reference(v jsonb,is_policy boolean DEFAULT false) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT pactwoven.supplier_object(v,CASE WHEN is_policy THEN ARRAY['pair','version','hash'] ELSE ARRAY['id','version','hash'] END)
    AND CASE WHEN is_policy THEN pactwoven.supplier_pair(v->'pair') ELSE pactwoven.supplier_id(v->'id') END
    AND pactwoven.supplier_integer(v->'version',1,9007199254740991) AND v->>'hash' ~ '^[a-f0-9]{64}$'
$$;
CREATE FUNCTION pactwoven.supplier_ids(v jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ BEGIN
  RETURN jsonb_typeof(v)='array' AND jsonb_array_length(v) BETWEEN 1 AND 100
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v) x WHERE NOT pactwoven.supplier_id(x))
    AND (SELECT count(*)=count(DISTINCT x) FROM jsonb_array_elements(v) x);
EXCEPTION WHEN OTHERS THEN RETURN false;END $$;
CREATE FUNCTION pactwoven.supplier_category(v jsonb,stored boolean DEFAULT false) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT pactwoven.supplier_object(v,CASE WHEN stored THEN ARRAY['id','label','definition','definitionHash'] ELSE ARRAY['id','label','definition'] END)
    AND pactwoven.supplier_id(v->'id') AND jsonb_typeof(v->'label')='string' AND length(v->>'label') BETWEEN 1 AND 120
    AND jsonb_typeof(v->'definition')='string' AND length(v->>'definition') BETWEEN 1 AND 2000
    AND v->>'label'=normalize(btrim(v->>'label'),NFC) AND v->>'definition'=normalize(btrim(v->>'definition'),NFC)
    AND (NOT stored OR v->>'definitionHash' ~ '^[a-f0-9]{64}$')
$$;

-- Exact private requests are locators, not authenticated facts or capabilities.
CREATE FUNCTION pactwoven.supplier_request_valid(v jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE k text:=v->>'kind';c jsonb;a text;t jsonb;p jsonb;q jsonb;BEGIN
  IF (octet_length(convert_to(v::text,'UTF8'))>524288) IS NOT FALSE THEN RETURN false;END IF;
  IF k IN ('policy-command','relationship-command') THEN
    IF (NOT pactwoven.supplier_object(v,ARRAY['kind','purpose','mutation']) OR
      NOT pactwoven.supplier_object(v->'mutation',ARRAY['idempotencyKey','command']) OR
      v#>>'{mutation,idempotencyKey}' !~ '^[A-Za-z0-9_-]{16,128}$') IS NOT FALSE THEN RETURN false;END IF;
    c:=v#>'{mutation,command}';p:=c->'payload';a:=p->>'action';t:=p->'terms';
    IF k='policy-command' THEN
      IF (NOT pactwoven.supplier_object(c,ARRAY['pair','expectedVersion','predecessor','buyerOrganizationVersion','authorityEpoch','payload'])
        OR NOT pactwoven.supplier_pair(c->'pair') OR a NOT IN ('issue','replace','revoke')
        OR v->>'purpose'<>'supplier_scope_policy_'||a
        OR NOT pactwoven.supplier_integer(c->'buyerOrganizationVersion',1,9007199254740991)
        OR (a='issue' AND (c->'expectedVersion'<>'0'::jsonb OR c->'predecessor'<>'null'::jsonb))
        OR (a<>'issue' AND (NOT pactwoven.supplier_reference(c->'predecessor',true) OR c#>'{predecessor,pair}'<>c->'pair'
          OR c#>'{predecessor,version}'<>c->'expectedVersion'))) IS NOT FALSE THEN RETURN false;END IF;
      IF a<>'revoke' THEN
        IF (NOT pactwoven.supplier_object(t,ARRAY['buyerSiteIds','categories','requestedValidityMs']) OR NOT pactwoven.supplier_ids(t->'buyerSiteIds')
          OR NOT pactwoven.supplier_integer(t->'requestedValidityMs',1,2592000000)
          OR jsonb_typeof(t->'categories')<>'array' OR jsonb_array_length(t->'categories') NOT BETWEEN 1 AND 100
          OR EXISTS(SELECT 1 FROM jsonb_array_elements(t->'categories') x WHERE NOT pactwoven.supplier_category(x))
          OR (SELECT count(*)<>count(DISTINCT x->>'id') FROM jsonb_array_elements(t->'categories') x)) IS NOT FALSE THEN RETURN false;END IF;
      END IF;
      RETURN pactwoven.supplier_object(p,CASE WHEN a='revoke' THEN ARRAY['action'] ELSE ARRAY['action','terms'] END)
        AND pactwoven.supplier_integer(c->'expectedVersion',0,9007199254740990) AND pactwoven.supplier_integer(c->'authorityEpoch',0,9007199254740991);
    END IF;
    IF (NOT pactwoven.supplier_object(c,ARRAY['scope','expectedVersion','mandateVersion','authorityEpoch','targetProposal','payload'])
      OR NOT pactwoven.supplier_scope(c->'scope') OR c->'mandateVersion'<>'null'::jsonb
      OR a NOT IN ('create','revise','approve','suspend','revoke') OR v->>'purpose'<>'supplier_relationship_'||a
      OR NOT pactwoven.supplier_integer(c->'expectedVersion',0,9007199254740990)
      OR NOT pactwoven.supplier_integer(c->'authorityEpoch',0,9007199254740991)
      OR (a='create' AND (c->'expectedVersion'<>'0'::jsonb OR c->'targetProposal'<>'null'::jsonb))
      OR (a<>'create' AND ((c->>'expectedVersion')::bigint=0 OR NOT pactwoven.supplier_reference(c->'targetProposal')
        OR c#>>'{targetProposal,id}'<>c#>>'{scope,supplierRelationshipId}'))) IS NOT FALSE THEN RETURN false;END IF;
    IF a IN ('create','revise') THEN
      PERFORM pactwoven.supplier_time(t->'expiresAt');
      RETURN pactwoven.supplier_object(p,ARRAY['action','terms']) AND pactwoven.supplier_object(t,ARRAY['buyerSiteIds','serviceCategoryIds','expiresAt'])
        AND pactwoven.supplier_ids(t->'buyerSiteIds') AND pactwoven.supplier_ids(t->'serviceCategoryIds');
    ELSIF a='approve' THEN
      PERFORM pactwoven.supplier_time(p->'expiresAt');RETURN pactwoven.supplier_object(p,ARRAY['action','expiresAt']);
    END IF;RETURN pactwoven.supplier_object(p,ARRAY['action']);
  END IF;
  IF (NOT pactwoven.supplier_object(v,ARRAY['kind','purpose','query'])) IS NOT FALSE THEN RETURN false;END IF;q:=v->'query';
  IF k='policy-read' THEN RETURN v->>'purpose'='supplier_scope_policy_read' AND pactwoven.supplier_object(q,ARRAY['policy']) AND pactwoven.supplier_reference(q->'policy',true);
  ELSIF k='relationship-status' THEN RETURN v->>'purpose'='supplier_relationship_status' AND pactwoven.supplier_object(q,ARRAY['scope','revision'])
    AND pactwoven.supplier_scope(q->'scope') AND (q->'revision'='null'::jsonb OR pactwoven.supplier_integer(q->'revision',1,9007199254740991));
  ELSIF k='relationship-observation-plan' THEN RETURN v->>'purpose'='supplier_relationship_observation_plan'
    AND pactwoven.supplier_object(q,ARRAY['scope']) AND pactwoven.supplier_scope(q->'scope');
  ELSIF k='relationship-recover' THEN RETURN v->>'purpose'='supplier_relationship_recover' AND pactwoven.supplier_object(q,ARRAY['identity','commandDigest','action'])
    AND pactwoven.supplier_object(q->'identity',ARRAY['scope','organizationId','actorId','idempotencyKey']) AND pactwoven.supplier_scope(q#>'{identity,scope}')
    AND pactwoven.supplier_id(q#>'{identity,actorId}') AND q#>>'{identity,organizationId}' IN (q#>>'{identity,scope,buyerOrganizationId}',q#>>'{identity,scope,supplierOrganizationId}')
    AND q#>>'{identity,idempotencyKey}' ~ '^[A-Za-z0-9_-]{16,128}$' AND q->>'commandDigest' ~ '^[a-f0-9]{64}$'
    AND q->>'action' IN ('create','revise','approve','suspend','revoke');END IF;
  RETURN false;
EXCEPTION WHEN OTHERS THEN RETURN false;END $$;
CREATE FUNCTION pactwoven.supplier_request_scope(v jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT CASE v->>'kind'
  WHEN 'policy-command' THEN v#>'{mutation,command,pair}' WHEN 'policy-read' THEN v#>'{query,policy,pair}'
  WHEN 'relationship-command' THEN v#>'{mutation,command,scope}' WHEN 'relationship-status' THEN v#>'{query,scope}'
  WHEN 'relationship-observation-plan' THEN v#>'{query,scope}'
  WHEN 'relationship-recover' THEN v#>'{query,identity,scope}' END $$;
CREATE FUNCTION pactwoven.supplier_request_identity(v jsonb,o text,a text) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT jsonb_build_object('purpose',v->'purpose','pair',pactwoven.supplier_request_scope(v)-'supplierRelationshipId',
    'relationshipId',pactwoven.supplier_request_scope(v)->'supplierRelationshipId','effectiveOrganizationId',o,'actorId',a,
    'originalKey',CASE WHEN v->>'kind' IN ('policy-command','relationship-command') THEN v#>'{mutation,idempotencyKey}'
      WHEN v->>'kind'='relationship-recover' THEN v#>'{query,identity,idempotencyKey}' ELSE 'null'::jsonb END)
$$;
CREATE FUNCTION pactwoven.supplier_command_digest(v jsonb,o text,a text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT CASE v->>'kind'
  WHEN 'relationship-command' THEN pactwoven.supplier_hash(jsonb_build_object('namespace','pactwoven/supplier-relationship-command/v1',
    'identity',jsonb_build_object('scope',pactwoven.supplier_request_scope(v),'organizationId',o,'actorId',a,'idempotencyKey',v#>'{mutation,idempotencyKey}'),'command',v#>'{mutation,command}'))
  WHEN 'policy-command' THEN pactwoven.supplier_hash(jsonb_build_object('namespace','pactwoven/supplier-scope-policy-command/v1',
    'identity',jsonb_build_object('pair',pactwoven.supplier_request_scope(v),'organizationId',o,'actorId',a,'idempotencyKey',v#>'{mutation,idempotencyKey}'),'command',v#>'{mutation,command}')) END
$$;

CREATE TABLE pactwoven.supplier_private_bindings (
  id text NOT NULL,version bigint NOT NULL CHECK((version BETWEEN 1 AND 9007199254740991) IS TRUE),
  environment text NOT NULL,effective_organization_id text NOT NULL,verifier_oid oid NOT NULL,verifier_name text NOT NULL,
  authorizer_oid oid NOT NULL,authorizer_name text NOT NULL,status text NOT NULL CHECK((status IN ('ACTIVE','REVOKED')) IS TRUE),
  valid_from timestamptz NOT NULL,expires_at timestamptz NOT NULL,body jsonb NOT NULL,
  hash text GENERATED ALWAYS AS(pactwoven.supplier_binding_hash(body)) STORED,
  PRIMARY KEY(id,version),UNIQUE(id,version,hash),
  FOREIGN KEY(environment,effective_organization_id) REFERENCES pactwoven.organizations(environment,id),
  CHECK((verifier_oid<>authorizer_oid AND verifier_name<>authorizer_name AND isfinite(valid_from) AND isfinite(expires_at) AND valid_from<expires_at) IS TRUE),
  CHECK((pactwoven.supplier_object(body,ARRAY['reference','environment','effectiveOrganizationId','verifier','authorizer','status','validFrom','expiresAt'])) IS TRUE),
  CHECK((pactwoven.supplier_reference(body->'reference') AND body#>>'{reference,id}'=id AND (body#>>'{reference,version}')::bigint=version AND body#>>'{reference,hash}'=hash) IS TRUE),
  CHECK((body->>'environment'=environment AND body->>'effectiveOrganizationId'=effective_organization_id AND body->>'status'=status) IS TRUE),
  CHECK((pactwoven.supplier_object(body->'verifier',ARRAY['oid','name']) AND pactwoven.supplier_object(body->'authorizer',ARRAY['oid','name'])) IS TRUE),
  CHECK(((body#>>'{verifier,oid}')::oid=verifier_oid AND body#>>'{verifier,name}'=verifier_name AND (body#>>'{authorizer,oid}')::oid=authorizer_oid AND body#>>'{authorizer,name}'=authorizer_name) IS TRUE),
  CHECK((pactwoven.supplier_time(body->'validFrom')=valid_from AND pactwoven.supplier_time(body->'expiresAt')=expires_at) IS TRUE)
);
CREATE TABLE pactwoven.supplier_authentication_evidence (
  id uuid PRIMARY KEY,binding_id text NOT NULL,binding_version bigint NOT NULL,binding_hash text NOT NULL,
  environment text NOT NULL,effective_organization_id text NOT NULL,actor_id text NOT NULL,
  kind text NOT NULL CHECK((kind IN ('identity','factors')) IS TRUE),purpose text NOT NULL,request jsonb NOT NULL,request_digest text NOT NULL,
  mutation_digest text,observed_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,body jsonb NOT NULL,
  hash text GENERATED ALWAYS AS(pactwoven.supplier_evidence_hash(body)) STORED,
  FOREIGN KEY(binding_id,binding_version,binding_hash) REFERENCES pactwoven.supplier_private_bindings(id,version,hash),
  UNIQUE(id,hash),CHECK((pactwoven.supplier_request_valid(request)) IS TRUE),
  CHECK((body->>'id'=id::text AND body->>'kind'=kind AND body->'request'=request AND body->>'requestDigest'=request_digest) IS TRUE),
  CHECK((body#>>'{actor,environment}'=environment AND body#>>'{actor,organizationId}'=effective_organization_id AND body#>>'{actor,actorId}'=actor_id) IS TRUE),
  CHECK((body#>>'{binding,reference,id}'=binding_id AND (body#>>'{binding,reference,version}')::bigint=binding_version AND body#>>'{binding,reference,hash}'=binding_hash) IS TRUE),
  CHECK((body->>'mutationDigest' IS NOT DISTINCT FROM mutation_digest AND request->>'purpose'=purpose) IS TRUE),
  CHECK((pactwoven.supplier_time(body->'observedAt')=observed_at AND pactwoven.supplier_time(body->'expiresAt')=expires_at AND expires_at>observed_at AND expires_at-observed_at<=interval '30 seconds') IS TRUE)
);
CREATE TABLE pactwoven.supplier_access_contexts (
  database_oid oid NOT NULL,session_user_oid oid NOT NULL,backend_pid integer NOT NULL,full_xid xid8 NOT NULL,
  phase text NOT NULL CHECK((phase IN ('RESOLVE','WRITE')) IS TRUE),resolve_phase text NOT NULL DEFAULT 'RESOLVE' CHECK((resolve_phase='RESOLVE') IS TRUE),
  evidence_id uuid NOT NULL,evidence_hash text NOT NULL,binding_id text NOT NULL,binding_version bigint NOT NULL,binding_hash text NOT NULL,
  environment text NOT NULL,buyer_organization_id text NOT NULL,supplier_organization_id text NOT NULL,relationship_id text,
  effective_organization_id text NOT NULL,actor_id text NOT NULL,request jsonb NOT NULL,request_digest text NOT NULL,
  observed_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,"authorization" jsonb,
  PRIMARY KEY(database_oid,session_user_oid,backend_pid,full_xid,phase),
  FOREIGN KEY(database_oid,session_user_oid,backend_pid,full_xid,resolve_phase)
    REFERENCES pactwoven.supplier_access_contexts(database_oid,session_user_oid,backend_pid,full_xid,phase) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(evidence_id,evidence_hash) REFERENCES pactwoven.supplier_authentication_evidence(id,hash),
  FOREIGN KEY(binding_id,binding_version,binding_hash) REFERENCES pactwoven.supplier_private_bindings(id,version,hash),
  CHECK((buyer_organization_id<>supplier_organization_id AND effective_organization_id IN (buyer_organization_id,supplier_organization_id)) IS TRUE),
  CHECK(((phase='WRITE')=("authorization" IS NOT NULL)) IS TRUE),CHECK((pactwoven.supplier_request_valid(request)) IS TRUE),
  CHECK((expires_at>observed_at AND expires_at-observed_at<=interval '30 seconds') IS TRUE)
);
CREATE UNIQUE INDEX supplier_one_write_per_evidence ON pactwoven.supplier_access_contexts(evidence_id) WHERE phase='WRITE';

CREATE TABLE pactwoven.supplier_relationship_scope_policies (
  environment text NOT NULL,buyer_organization_id text NOT NULL,supplier_organization_id text NOT NULL,version bigint NOT NULL CHECK((version>0) IS TRUE),
  policy_hash text NOT NULL,record jsonb NOT NULL,receipt jsonb NOT NULL,actor_id text NOT NULL,original_key text NOT NULL,
  context_database oid NOT NULL,context_session oid NOT NULL,context_backend integer NOT NULL,context_xid xid8 NOT NULL,
  context_phase text NOT NULL DEFAULT 'WRITE' CHECK((context_phase='WRITE') IS TRUE),
  PRIMARY KEY(environment,buyer_organization_id,supplier_organization_id,version),UNIQUE(environment,buyer_organization_id,supplier_organization_id,version,policy_hash),
  UNIQUE(environment,buyer_organization_id,supplier_organization_id,actor_id,original_key),
  FOREIGN KEY(environment,buyer_organization_id) REFERENCES pactwoven.organizations(environment,id),
  FOREIGN KEY(environment,supplier_organization_id) REFERENCES pactwoven.organizations(environment,id),
  FOREIGN KEY(context_database,context_session,context_backend,context_xid,context_phase)
    REFERENCES pactwoven.supplier_access_contexts(database_oid,session_user_oid,backend_pid,full_xid,phase)
);
CREATE TABLE pactwoven.supplier_relationship_proposals (
  environment text NOT NULL,buyer_organization_id text NOT NULL,supplier_organization_id text NOT NULL,relationship_id text NOT NULL,version bigint NOT NULL CHECK((version>0) IS TRUE),
  proposal_hash text NOT NULL,policy_version bigint NOT NULL,policy_hash text NOT NULL,producing_revision bigint NOT NULL,body jsonb NOT NULL,
  PRIMARY KEY(environment,buyer_organization_id,supplier_organization_id,relationship_id,version),
  UNIQUE(environment,buyer_organization_id,supplier_organization_id,relationship_id,version,proposal_hash,policy_version,policy_hash),
  FOREIGN KEY(environment,buyer_organization_id,supplier_organization_id,policy_version,policy_hash)
    REFERENCES pactwoven.supplier_relationship_scope_policies(environment,buyer_organization_id,supplier_organization_id,version,policy_hash)
);
CREATE TABLE pactwoven.supplier_relationship_versions (
  environment text NOT NULL,buyer_organization_id text NOT NULL,supplier_organization_id text NOT NULL,relationship_id text NOT NULL,revision bigint NOT NULL CHECK((revision>0) IS TRUE),
  proposal_version bigint NOT NULL,proposal_hash text NOT NULL,policy_version bigint NOT NULL,policy_hash text NOT NULL,record jsonb NOT NULL,
  context_database oid NOT NULL,context_session oid NOT NULL,context_backend integer NOT NULL,context_xid xid8 NOT NULL,
  context_phase text NOT NULL DEFAULT 'WRITE' CHECK((context_phase='WRITE') IS TRUE),
  PRIMARY KEY(environment,buyer_organization_id,supplier_organization_id,relationship_id,revision),
  FOREIGN KEY(environment,buyer_organization_id,supplier_organization_id,relationship_id,proposal_version,proposal_hash,policy_version,policy_hash)
    REFERENCES pactwoven.supplier_relationship_proposals(environment,buyer_organization_id,supplier_organization_id,relationship_id,version,proposal_hash,policy_version,policy_hash) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(context_database,context_session,context_backend,context_xid,context_phase)
    REFERENCES pactwoven.supplier_access_contexts(database_oid,session_user_oid,backend_pid,full_xid,phase)
);
CREATE TABLE pactwoven.supplier_relationship_receipts (
  environment text NOT NULL,buyer_organization_id text NOT NULL,supplier_organization_id text NOT NULL,relationship_id text NOT NULL,
  effective_organization_id text NOT NULL,actor_id text NOT NULL,original_key text NOT NULL,revision bigint NOT NULL,mutation jsonb NOT NULL,body jsonb NOT NULL,
  PRIMARY KEY(environment,buyer_organization_id,supplier_organization_id,relationship_id,effective_organization_id,actor_id,original_key),
  UNIQUE(environment,buyer_organization_id,supplier_organization_id,relationship_id,revision),
  FOREIGN KEY(environment,buyer_organization_id,supplier_organization_id,relationship_id,revision)
    REFERENCES pactwoven.supplier_relationship_versions(environment,buyer_organization_id,supplier_organization_id,relationship_id,revision) DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE pactwoven.supplier_relationship_versions ADD CONSTRAINT supplier_version_receipt_reciprocal
  FOREIGN KEY(environment,buyer_organization_id,supplier_organization_id,relationship_id,revision)
  REFERENCES pactwoven.supplier_relationship_receipts(environment,buyer_organization_id,supplier_organization_id,relationship_id,revision) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE pactwoven.supplier_relationship_proposals ADD CONSTRAINT supplier_proposal_receipt_reciprocal
  FOREIGN KEY(environment,buyer_organization_id,supplier_organization_id,relationship_id,producing_revision)
  REFERENCES pactwoven.supplier_relationship_receipts(environment,buyer_organization_id,supplier_organization_id,relationship_id,revision) DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION pactwoven.supplier_session_oid() RETURNS oid LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT oid FROM pg_roles WHERE rolname=SESSION_USER
$$;
CREATE FUNCTION pactwoven.supplier_database_oid() RETURNS oid LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT oid FROM pg_database WHERE datname=current_database()
$$;
CREATE FUNCTION pactwoven.supplier_read_committed() RETURNS void LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog AS $$ BEGIN
  PERFORM pactwoven.supplier_require(current_setting('transaction_isolation')='read committed');
END $$;
CREATE FUNCTION pactwoven.supplier_registry_fence(exclusive_lock boolean) RETURNS void
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog AS $$ BEGIN
  PERFORM pactwoven.supplier_read_committed();
  IF exclusive_lock THEN PERFORM pg_advisory_xact_lock(hashtextextended('pactwoven/supplier-registry/'||pactwoven.supplier_database_oid()::text,0));
  ELSE PERFORM pg_advisory_xact_lock_shared(hashtextextended('pactwoven/supplier-registry/'||pactwoven.supplier_database_oid()::text,0));END IF;
END $$;
CREATE FUNCTION pactwoven.supplier_lineage_fence(binding_id text) RETURNS void
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog AS $$ BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('pactwoven/supplier-binding/'||pactwoven.supplier_database_oid()::text||'/'||binding_id,0));
END $$;
-- Lock order, shared by offline registration/revoke/rotation and every runtime
-- admission: registry (maintenance exclusive, runtime shared) -> binding lineage
-- -> organizations in environment/ID C order -> session-revocations SHARE ->
-- exact memberships in composite C order -> selected sites in C order.
-- All are transaction-held. No provider/network call belongs under these locks.
CREATE FUNCTION pactwoven.supplier_binding_append_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE prior pactwoven.supplier_private_bindings;BEGIN
  PERFORM pactwoven.supplier_registry_fence(true);PERFORM pactwoven.supplier_lineage_fence(NEW.id);
  PERFORM pactwoven.supplier_require(pactwoven.supplier_id(to_jsonb(NEW.id)) AND pactwoven.supplier_id(to_jsonb(NEW.effective_organization_id))
    AND NEW.environment IN ('simulation','development','staging','production')
    AND NEW.verifier_name ~ '^[a-z_][a-z0-9_]*$' AND length(NEW.verifier_name)<=63
    AND NEW.authorizer_name ~ '^[a-z_][a-z0-9_]*$' AND length(NEW.authorizer_name)<=63
    AND pactwoven.supplier_integer(NEW.body#>'{verifier,oid}',1,4294967295) AND pactwoven.supplier_integer(NEW.body#>'{authorizer,oid}',1,4294967295));
  SELECT * INTO prior FROM pactwoven.supplier_private_bindings WHERE id=NEW.id ORDER BY version DESC LIMIT 1;
  PERFORM pactwoven.supplier_require(NOT EXISTS(SELECT 1 FROM pactwoven.supplier_private_bindings b WHERE b.id<>NEW.id
    AND (b.verifier_oid IN (NEW.verifier_oid,NEW.authorizer_oid) OR b.authorizer_oid IN (NEW.verifier_oid,NEW.authorizer_oid))));
  IF prior.id IS NULL THEN PERFORM pactwoven.supplier_require(NEW.version=1 AND NEW.status='ACTIVE');
  ELSE PERFORM pactwoven.supplier_require(NEW.version=prior.version+1 AND prior.status='ACTIVE'
    AND (NEW.environment,NEW.effective_organization_id,NEW.verifier_oid,NEW.verifier_name,NEW.authorizer_oid,NEW.authorizer_name)
      IS NOT DISTINCT FROM (prior.environment,prior.effective_organization_id,prior.verifier_oid,prior.verifier_name,prior.authorizer_oid,prior.authorizer_name));END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER supplier_binding_append BEFORE INSERT ON pactwoven.supplier_private_bindings FOR EACH ROW EXECUTE FUNCTION pactwoven.supplier_binding_append_guard();

CREATE FUNCTION pactwoven.supplier_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
  RAISE EXCEPTION USING ERRCODE='SP003',MESSAGE='Supplier authority records are append only';
END $$;

-- The principal lane uses only actual SESSION_USER. It sees terminal versions;
-- it never queries itself or hides revocation by filtering status to ACTIVE.
CREATE POLICY supplier_binding_read ON pactwoven.supplier_private_bindings FOR SELECT TO pactwoven_supplier_executor
  USING(pactwoven.supplier_session_oid() IN (verifier_oid,authorizer_oid));
CREATE POLICY supplier_evidence_read ON pactwoven.supplier_authentication_evidence FOR SELECT TO pactwoven_supplier_executor
  USING(EXISTS(SELECT 1 FROM pactwoven.supplier_private_bindings b WHERE b.id=binding_id AND b.version=binding_version AND b.hash=binding_hash));
CREATE POLICY supplier_evidence_insert ON pactwoven.supplier_authentication_evidence FOR INSERT TO pactwoven_supplier_executor
  WITH CHECK((EXISTS(SELECT 1 FROM pactwoven.supplier_private_bindings b WHERE b.id=binding_id AND b.version=binding_version AND b.hash=binding_hash
    AND b.verifier_oid=pactwoven.supplier_session_oid())) IS TRUE);
CREATE POLICY supplier_context_read ON pactwoven.supplier_access_contexts FOR SELECT TO pactwoven_supplier_executor
  USING(database_oid=pactwoven.supplier_database_oid() AND session_user_oid=pactwoven.supplier_session_oid()
    AND backend_pid=pg_backend_pid() AND full_xid=pg_current_xact_id());
CREATE POLICY supplier_context_insert ON pactwoven.supplier_access_contexts FOR INSERT TO pactwoven_supplier_executor
  WITH CHECK((database_oid=pactwoven.supplier_database_oid() AND session_user_oid=pactwoven.supplier_session_oid()
    AND backend_pid=pg_backend_pid() AND full_xid=pg_current_xact_id()) IS TRUE);

-- Immutable transaction scope is not a fresh capability. Admission and WRITE
-- revalidate original evidence after waits; INSERT has its own freshness gate.
-- Retaining scope until transaction end lets deferred structural constraints
-- inspect an already accepted write even if its observation subsequently expires.
CREATE FUNCTION pactwoven.supplier_context() RETURNS pactwoven.supplier_access_contexts
LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$
  SELECT c FROM pactwoven.supplier_access_contexts c WHERE c.phase='RESOLVE'
    AND c.database_oid=pactwoven.supplier_database_oid() AND c.session_user_oid=pactwoven.supplier_session_oid()
    AND c.backend_pid=pg_backend_pid() AND c.full_xid=pg_current_xact_id()
$$;
CREATE FUNCTION pactwoven.supplier_business_visible(family text,e text,b text,s text,r text,version_number bigint,party text DEFAULT NULL,actor text DEFAULT NULL,original_key text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog AS $$
DECLARE c pactwoven.supplier_access_contexts:=pactwoven.supplier_context();BEGIN
  IF c.phase IS NULL OR (e,b,s) IS DISTINCT FROM (c.environment,c.buyer_organization_id,c.supplier_organization_id) THEN RETURN false;END IF;
  IF family='policy' THEN RETURN c.request->>'kind'<>'policy-read' OR version_number=(c.request#>>'{query,policy,version}')::bigint;END IF;
  IF r IS DISTINCT FROM c.relationship_id THEN RETURN false;END IF;
  IF family='receipt' THEN
    RETURN c.request->>'kind' IN ('relationship-command','relationship-recover') AND party=c.effective_organization_id AND actor=c.actor_id
      AND original_key=CASE WHEN c.request->>'kind'='relationship-command' THEN c.request#>>'{mutation,idempotencyKey}' ELSE c.request#>>'{query,identity,idempotencyKey}' END;
  END IF;
  RETURN family IN ('version','proposal') AND c.request->>'kind' IN ('relationship-command','relationship-status','relationship-recover','relationship-observation-plan');
END $$;

CREATE FUNCTION pactwoven.supplier_head(v jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT jsonb_build_object('scope',v#>'{proposal,scope}','revision',v->'revision','proposal',jsonb_build_object(
    'id',v#>'{proposal,scope,supplierRelationshipId}','version',v#>'{proposal,version}','hash',v->'proposalHash'),'status',v->'status')
$$;
CREATE FUNCTION pactwoven.supplier_approval_shape(v jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ DECLARE k text;BEGIN
  IF (NOT pactwoven.supplier_object(v,ARRAY['actorId','organizationId','membershipId','membershipVersion','organizationVersion','organizationEpoch',
    'party','proposal','approvedAt','expiresAt']) OR v->>'party' NOT IN ('buyer','supplier') OR NOT pactwoven.supplier_reference(v->'proposal')) IS NOT FALSE THEN RETURN false;END IF;
  FOREACH k IN ARRAY ARRAY['actorId','organizationId','membershipId'] LOOP IF (NOT pactwoven.supplier_id(v->k)) IS NOT FALSE THEN RETURN false;END IF;END LOOP;
  RETURN pactwoven.supplier_integer(v->'membershipVersion',1,9007199254740991) AND pactwoven.supplier_integer(v->'organizationVersion',1,9007199254740991)
    AND pactwoven.supplier_integer(v->'organizationEpoch',0,9007199254740991) AND pactwoven.supplier_time(v->'approvedAt')<pactwoven.supplier_time(v->'expiresAt');
EXCEPTION WHEN OTHERS THEN RETURN false;END $$;
CREATE FUNCTION pactwoven.supplier_membership_observation(v jsonb,at_time timestamptz) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ DECLARE k text;observed timestamptz;expiry timestamptz;BEGIN
  IF (NOT pactwoven.supplier_object(v,ARRAY['issuer','subject','externalOrganizationId','externalMembershipId','externalRole','status','observedAt','expiresAt'])
    OR v->>'status' NOT IN ('ACTIVE','INACTIVE','REVOKED') OR v->>'issuer' !~ '^https://[^[:space:]]+$' OR length(v->>'issuer')>2048) IS NOT FALSE THEN RETURN false;END IF;
  FOREACH k IN ARRAY ARRAY['subject','externalOrganizationId','externalMembershipId','externalRole'] LOOP
    IF (jsonb_typeof(v->k)<>'string' OR length(v->>k) NOT BETWEEN 1 AND 256) IS NOT FALSE THEN RETURN false;END IF;END LOOP;
  observed:=pactwoven.supplier_time(v->'observedAt');expiry:=pactwoven.supplier_time(v->'expiresAt');
  RETURN observed<=at_time AND at_time-observed<=interval '20 seconds' AND observed<expiry AND at_time<expiry AND expiry-observed<=interval '30 seconds';
EXCEPTION WHEN OTHERS THEN RETURN false;END $$;
CREATE FUNCTION pactwoven.supplier_evidence_valid(v jsonb,at_time timestamptz) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE keys text[]:=ARRAY['schemaVersion','id','actor','binding','observedBy','request','requestDigest','mutationDigest','observation','observedAt','expiresAt','kind'];
  a jsonb:=v->'actor';q jsonb:=v->'request';scope jsonb:=pactwoven.supplier_request_scope(q);ob jsonb:=v->'observation';source jsonb:=v->'source';
  factors boolean:=q->>'kind' IN ('policy-command','relationship-command');k text;first_time timestamptz;second_time timestamptz;entry jsonb;
BEGIN
  IF v ? 'approvers' THEN keys:=keys||ARRAY['approvers'];END IF;
  IF factors THEN keys:=keys||ARRAY['source'];END IF;
  IF (octet_length(convert_to(v::text,'UTF8'))>1048576 OR NOT pactwoven.supplier_object(v,keys) OR v->'schemaVersion'<>'1'::jsonb
    OR (v->>'id')::uuid::text<>v->>'id' OR NOT pactwoven.supplier_request_valid(q) OR (v->>'kind'='factors') IS DISTINCT FROM factors
    OR v->>'kind' NOT IN ('identity','factors') OR NOT pactwoven.supplier_observation_current(ob,at_time)
    OR NOT pactwoven.supplier_object(a,ARRAY['environment','organizationId','actorId','principalKind','membershipId','membershipVersion','organizationVersion','organizationEpoch',
      'subject','externalOrganizationId','externalMembershipId','sessionId']) OR a->>'principalKind'<>'human'
    OR a->>'environment'<>scope->>'environment' OR a->>'organizationId' NOT IN (scope->>'buyerOrganizationId',scope->>'supplierOrganizationId')
    OR (q->>'kind' IN ('policy-command','policy-read') AND a->>'organizationId'<>scope->>'buyerOrganizationId')) IS NOT FALSE THEN RETURN false;END IF;
  FOREACH k IN ARRAY ARRAY['actorId','organizationId','membershipId'] LOOP IF (NOT pactwoven.supplier_id(a->k)) IS NOT FALSE THEN RETURN false;END IF;END LOOP;
  FOREACH k IN ARRAY ARRAY['subject','externalOrganizationId','externalMembershipId','sessionId'] LOOP
    IF (a->k IS DISTINCT FROM ob->k OR jsonb_typeof(a->k)<>'string' OR length(a->>k) NOT BETWEEN 1 AND 256) IS NOT FALSE THEN RETURN false;END IF;END LOOP;
  IF (NOT pactwoven.supplier_integer(a->'membershipVersion',1,9007199254740991) OR NOT pactwoven.supplier_integer(a->'organizationVersion',1,9007199254740991)
    OR NOT pactwoven.supplier_integer(a->'organizationEpoch',0,9007199254740991) OR v->'observedAt'<>ob->'observedAt' OR v->'expiresAt'<>ob->'expiresAt'
    OR v->'observedBy'<>v#>'{binding,verifier}' OR a->>'environment'<>v#>>'{binding,environment}' OR a->>'organizationId'<>v#>>'{binding,effectiveOrganizationId}'
    OR pactwoven.supplier_time(v->'observedAt')<pactwoven.supplier_time(v#>'{binding,validFrom}')
    OR pactwoven.supplier_time(v->'expiresAt')>pactwoven.supplier_time(v#>'{binding,expiresAt}')
    OR v->>'requestDigest'<>pactwoven.supplier_hash(jsonb_build_object('namespace','pactwoven/supplier-private-request/v1',
      'identity',pactwoven.supplier_request_identity(q,a->>'organizationId',a->>'actorId'),'request',q))
    OR (v->>'mutationDigest') IS DISTINCT FROM pactwoven.supplier_command_digest(q,a->>'organizationId',a->>'actorId')) IS NOT FALSE THEN RETURN false;END IF;
  IF (q->>'kind'='relationship-recover' AND (q#>>'{query,identity,actorId}'<>a->>'actorId' OR q#>>'{query,identity,organizationId}'<>a->>'organizationId')) IS NOT FALSE THEN RETURN false;END IF;
  IF factors THEN
    IF (NOT pactwoven.supplier_object(source,ARRAY['kind','tokenHash','tokenIssuedAt','firstFactorAgeMinutes','secondFactorAgeMinutes','firstFactorAt','secondFactorAt','verifiedAt'])
      OR source->>'kind'<>'CLERK_FVA' OR source->'tokenHash'<>ob->'tokenHash' OR source->'tokenIssuedAt'<>ob->'tokenIssuedAt'
      OR NOT pactwoven.supplier_integer(source->'firstFactorAgeMinutes',0,1000000) OR NOT pactwoven.supplier_integer(source->'secondFactorAgeMinutes',0,1000000)) IS NOT FALSE THEN RETURN false;END IF;
    first_time:=pactwoven.supplier_time(source->'tokenIssuedAt')-make_interval(mins=>(source->>'firstFactorAgeMinutes')::int+1);
    second_time:=pactwoven.supplier_time(source->'tokenIssuedAt')-make_interval(mins=>(source->>'secondFactorAgeMinutes')::int+1);
    IF (first_time<>pactwoven.supplier_time(source->'firstFactorAt') OR second_time<>pactwoven.supplier_time(source->'secondFactorAt')
      OR least(first_time,second_time)<>pactwoven.supplier_time(source->'verifiedAt') OR greatest(first_time,second_time)>at_time
      OR at_time-least(first_time,second_time)>interval '5 minutes') IS NOT FALSE THEN RETURN false;END IF;
  END IF;
  IF v ? 'approvers' THEN
    IF (jsonb_typeof(v->'approvers')<>'array' OR jsonb_array_length(v->'approvers')>2
      OR (jsonb_array_length(v->'approvers')>0 AND q->>'kind' NOT IN ('relationship-command','relationship-status','relationship-recover'))
      OR (SELECT count(*)<>count(DISTINCT x#>>'{approval,party}') FROM jsonb_array_elements(v->'approvers') x)) IS NOT FALSE THEN RETURN false;END IF;
    FOR entry IN SELECT * FROM jsonb_array_elements(v->'approvers') LOOP
      IF (NOT pactwoven.supplier_object(entry,ARRAY['head','approval','observation'])
        OR NOT pactwoven.supplier_object(entry->'head',ARRAY['scope','revision','proposal','status']) OR entry#>'{head,scope}'<>scope
        OR NOT pactwoven.supplier_integer(entry#>'{head,revision}',1,9007199254740991) OR NOT pactwoven.supplier_reference(entry#>'{head,proposal}')
        OR entry->'head'<>v#>'{approvers,0,head}' OR entry#>>'{head,status}' NOT IN ('PROPOSED','ACTIVE')
        OR NOT pactwoven.supplier_approval_shape(entry->'approval') OR pactwoven.supplier_time(entry#>'{approval,approvedAt}')>at_time
        OR entry#>'{approval,proposal}'<>entry#>'{head,proposal}'
        OR entry#>>'{approval,organizationId}'<>scope->>CASE WHEN entry#>>'{approval,party}'='buyer' THEN 'buyerOrganizationId' ELSE 'supplierOrganizationId' END
        OR NOT pactwoven.supplier_membership_observation(entry->'observation',at_time) OR entry#>'{observation,issuer}'<>ob->'issuer'
        OR pactwoven.supplier_time(entry#>'{observation,observedAt}')>pactwoven.supplier_time(v->'observedAt')
        OR pactwoven.supplier_time(entry#>'{observation,expiresAt}')<pactwoven.supplier_time(v->'expiresAt')) IS NOT FALSE THEN RETURN false;END IF;
      IF (q->>'kind'='relationship-command' AND (entry#>'{head,revision}'<>q#>'{mutation,command,expectedVersion}'
        OR entry#>'{head,proposal}'<>q#>'{mutation,command,targetProposal}')) IS NOT FALSE THEN RETURN false;END IF;
    END LOOP;
  END IF;
  RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;END $$;

CREATE FUNCTION pactwoven.supplier_pair_fence(scope jsonb) RETURNS void LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog AS $$ BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('pactwoven/supplier-pair/'||pactwoven.supplier_database_oid()::text||'/'||
    pactwoven.supplier_canonical(scope-'supplierRelationshipId'),0));
END $$;
-- Pair fence follows the legacy identity fences and serializes policy renewal
-- with every relationship transition. Revalidate evidence after its wait.
CREATE FUNCTION pactwoven.supplier_begin(eid uuid,q jsonb) RETURNS pactwoven.supplier_access_contexts
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog AS $$
DECLARE b pactwoven.supplier_private_bindings;ev pactwoven.supplier_authentication_evidence;c pactwoven.supplier_access_contexts;
  scope jsonb;site_ids jsonb;BEGIN
  b:=pactwoven.supplier_current_binding('authorizer');
  PERFORM pactwoven.supplier_require(pactwoven.supplier_request_valid(q) AND NOT EXISTS(SELECT 1 FROM pactwoven.supplier_access_contexts));
  SELECT * INTO ev FROM pactwoven.supplier_authentication_evidence WHERE id=eid;
  PERFORM pactwoven.supplier_require(ev.id IS NOT NULL AND ev.body->'binding'=b.body AND ev.request=q AND pactwoven.supplier_evidence_valid(ev.body,clock_timestamp()));
  scope:=pactwoven.supplier_request_scope(q);
  site_ids:=CASE WHEN q->>'kind'='policy-command' AND q#>>'{mutation,command,payload,action}' IN ('issue','replace')
    THEN q#>'{mutation,command,payload,terms,buyerSiteIds}' ELSE '[]'::jsonb END;
  PERFORM pactwoven.supplier_base_identity(ev.body,'[]'::jsonb,'[]'::jsonb);
  PERFORM pactwoven.supplier_pair_fence(scope);
  b:=pactwoven.supplier_current_binding('authorizer');
  PERFORM pactwoven.supplier_require(ev.body->'binding'=b.body AND pactwoven.supplier_evidence_valid(ev.body,clock_timestamp()));
  INSERT INTO pactwoven.supplier_access_contexts(database_oid,session_user_oid,backend_pid,full_xid,phase,evidence_id,evidence_hash,binding_id,binding_version,binding_hash,
    environment,buyer_organization_id,supplier_organization_id,relationship_id,effective_organization_id,actor_id,request,request_digest,observed_at,expires_at)
  VALUES(pactwoven.supplier_database_oid(),pactwoven.supplier_session_oid(),pg_backend_pid(),pg_current_xact_id(),'RESOLVE',ev.id,ev.hash,b.id,b.version,b.hash,
    scope->>'environment',scope->>'buyerOrganizationId',scope->>'supplierOrganizationId',scope->>'supplierRelationshipId',ev.effective_organization_id,ev.actor_id,q,ev.request_digest,ev.observed_at,ev.expires_at)
  RETURNING * INTO c;
  RETURN c;
END $$;
CREATE FUNCTION pactwoven.supplier_add_write(c pactwoven.supplier_access_contexts,"authorization" jsonb) RETURNS void
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog AS $$
DECLARE ev pactwoven.supplier_authentication_evidence;b pactwoven.supplier_private_bindings;BEGIN
  b:=pactwoven.supplier_current_binding('authorizer');
  SELECT * INTO ev FROM pactwoven.supplier_authentication_evidence WHERE id=c.evidence_id;
  PERFORM pactwoven.supplier_require(c IS NOT DISTINCT FROM pactwoven.supplier_context() AND c.phase='RESOLVE'
    AND ev.kind='factors' AND ev.body->'binding'=b.body AND pactwoven.supplier_evidence_valid(ev.body,clock_timestamp())
    AND c.request->>'kind' IN ('relationship-command','policy-command')
    AND pactwoven.supplier_object("authorization",ARRAY['family','nextRevision','record','receipt','proposal'])
    AND "authorization"->>'family'=CASE WHEN c.request->>'kind'='policy-command' THEN 'policy' ELSE 'relationship' END
    AND ("authorization"->>'nextRevision')::bigint=(c.request#>>'{mutation,command,expectedVersion}')::bigint+1);
  INSERT INTO pactwoven.supplier_access_contexts SELECT c.database_oid,c.session_user_oid,c.backend_pid,c.full_xid,'WRITE','RESOLVE',c.evidence_id,c.evidence_hash,
    c.binding_id,c.binding_version,c.binding_hash,c.environment,c.buyer_organization_id,c.supplier_organization_id,c.relationship_id,c.effective_organization_id,c.actor_id,
    c.request,c.request_digest,c.observed_at,c.expires_at,"authorization";
END $$;
CREATE FUNCTION pactwoven.supplier_write_allowed(family text,e text,b text,s text,r text,n bigint) RETURNS boolean
LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$
  SELECT EXISTS(SELECT 1 FROM pactwoven.supplier_access_contexts c WHERE c.phase='WRITE'
    AND c.database_oid=pactwoven.supplier_database_oid() AND c.session_user_oid=pactwoven.supplier_session_oid()
    AND c.backend_pid=pg_backend_pid() AND c.full_xid=pg_current_xact_id() AND c.expires_at>clock_timestamp()
    AND (c.environment,c.buyer_organization_id,c.supplier_organization_id)=(e,b,s) AND c.relationship_id IS NOT DISTINCT FROM r
    AND c."authorization"->>'family'=family AND (c."authorization"->>'nextRevision')::bigint=n)
$$;

CREATE POLICY supplier_policy_read ON pactwoven.supplier_relationship_scope_policies FOR SELECT TO pactwoven_supplier_executor
  USING(pactwoven.supplier_business_visible('policy',environment,buyer_organization_id,supplier_organization_id,NULL,version));
CREATE POLICY supplier_policy_insert ON pactwoven.supplier_relationship_scope_policies FOR INSERT TO pactwoven_supplier_executor
  WITH CHECK((pactwoven.supplier_write_allowed('policy',environment,buyer_organization_id,supplier_organization_id,NULL,version)) IS TRUE);
CREATE POLICY supplier_proposal_read ON pactwoven.supplier_relationship_proposals FOR SELECT TO pactwoven_supplier_executor
  USING(pactwoven.supplier_business_visible('proposal',environment,buyer_organization_id,supplier_organization_id,relationship_id,version));
CREATE POLICY supplier_proposal_insert ON pactwoven.supplier_relationship_proposals FOR INSERT TO pactwoven_supplier_executor
  WITH CHECK((pactwoven.supplier_write_allowed('relationship',environment,buyer_organization_id,supplier_organization_id,relationship_id,producing_revision)) IS TRUE);
CREATE POLICY supplier_version_read ON pactwoven.supplier_relationship_versions FOR SELECT TO pactwoven_supplier_executor
  USING(pactwoven.supplier_business_visible('version',environment,buyer_organization_id,supplier_organization_id,relationship_id,revision));
CREATE POLICY supplier_version_insert ON pactwoven.supplier_relationship_versions FOR INSERT TO pactwoven_supplier_executor
  WITH CHECK((pactwoven.supplier_write_allowed('relationship',environment,buyer_organization_id,supplier_organization_id,relationship_id,revision)) IS TRUE);
CREATE POLICY supplier_receipt_read ON pactwoven.supplier_relationship_receipts FOR SELECT TO pactwoven_supplier_executor
  USING(pactwoven.supplier_business_visible('receipt',environment,buyer_organization_id,supplier_organization_id,relationship_id,revision,effective_organization_id,actor_id,original_key));
CREATE POLICY supplier_receipt_insert ON pactwoven.supplier_relationship_receipts FOR INSERT TO pactwoven_supplier_executor
  WITH CHECK((pactwoven.supplier_write_allowed('relationship',environment,buyer_organization_id,supplier_organization_id,relationship_id,revision)) IS TRUE);

CREATE FUNCTION pactwoven.supplier_role_safe(who oid,capability text) RETURNS boolean
LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$
  SELECT coalesce((SELECT r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreatedb
    AND NOT r.rolcreaterole AND NOT r.rolreplication AND NOT r.rolinherit AND r.rolconfig IS NULL
    AND NOT EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid OR m.roleid=r.oid)
    AND NOT has_database_privilege(r.oid,pactwoven.supplier_database_oid(),'CREATE')
    AND NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname!~'^pg_temp_' AND has_schema_privilege(r.oid,n.oid,'CREATE'))
    AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname!~'^pg_(temp|toast)'
      AND c.relkind IN ('r','p','v','m','f') AND (has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        OR has_any_column_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
    AND NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname!~'^pg_(temp|toast)'
      AND has_function_privilege(r.oid,p.oid,'EXECUTE') AND NOT
      (capability='verifier' AND p.oid=to_regprocedure('pactwoven.supplier_record_evidence(jsonb)') OR capability='authorizer' AND p.oid=ANY(ARRAY[
        to_regprocedure('pactwoven.supplier_scope_policy_command(uuid,jsonb)'),to_regprocedure('pactwoven.supplier_scope_policy_read(uuid,jsonb)'),
        to_regprocedure('pactwoven.supplier_relationship_command(uuid,jsonb)'),to_regprocedure('pactwoven.supplier_relationship_status(uuid,jsonb)'),
        to_regprocedure('pactwoven.supplier_relationship_recover(uuid,jsonb)')]::oid[])))
    FROM pg_roles r WHERE r.oid=who),false)
$$;
CREATE FUNCTION pactwoven.supplier_current_binding(capability text) RETURNS pactwoven.supplier_private_bindings
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog AS $$
DECLARE lineage text;b pactwoven.supplier_private_bindings;who oid:=pactwoven.supplier_session_oid();BEGIN
  PERFORM pactwoven.supplier_registry_fence(false);
  SELECT min(id) INTO lineage FROM pactwoven.supplier_private_bindings;
  PERFORM pactwoven.supplier_require(lineage IS NOT NULL AND (SELECT count(DISTINCT id)=1 FROM pactwoven.supplier_private_bindings));
  PERFORM pactwoven.supplier_lineage_fence(lineage);
  -- A separate READ COMMITTED statement AFTER the wait sees terminal revocation.
  SELECT * INTO b FROM pactwoven.supplier_private_bindings WHERE id=lineage ORDER BY version DESC LIMIT 1;
  PERFORM pactwoven.supplier_require(b.status='ACTIVE' AND b.valid_from<=clock_timestamp() AND b.expires_at>clock_timestamp()
    AND capability IN ('verifier','authorizer') AND who=CASE WHEN capability='verifier' THEN b.verifier_oid ELSE b.authorizer_oid END
    AND EXISTS(SELECT 1 FROM pg_roles WHERE oid=b.verifier_oid AND rolname=b.verifier_name)
    AND EXISTS(SELECT 1 FROM pg_roles WHERE oid=b.authorizer_oid AND rolname=b.authorizer_name)
    AND pactwoven.supplier_role_safe(b.verifier_oid,'verifier') AND pactwoven.supplier_role_safe(b.authorizer_oid,'authorizer'));
  RETURN b;
END $$;

CREATE FUNCTION pactwoven.supplier_observation_current(v jsonb,at_time timestamptz) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE observed timestamptz;expiry timestamptz;issued timestamptz;membership_time timestamptz;k text;BEGIN
  IF (NOT pactwoven.supplier_object(v,ARRAY['subject','externalOrganizationId','externalMembershipId','externalRole','sessionId',
    'authenticatedAt','membershipObservedAt','issuer','tokenHash','tokenIssuedAt','sessionExpiresAt','observedAt','expiresAt'])) IS NOT FALSE THEN RETURN false;END IF;
  FOREACH k IN ARRAY ARRAY['subject','externalOrganizationId','externalMembershipId','externalRole','sessionId'] LOOP
    IF (jsonb_typeof(v->k)<>'string' OR length(v->>k) NOT BETWEEN 1 AND 256) IS NOT FALSE THEN RETURN false;END IF;
  END LOOP;
  observed:=pactwoven.supplier_time(v->'observedAt');expiry:=pactwoven.supplier_time(v->'expiresAt');
  issued:=pactwoven.supplier_time(v->'tokenIssuedAt');membership_time:=pactwoven.supplier_time(v->'membershipObservedAt');
  RETURN v->>'issuer' ~ '^https://[^[:space:]]+$' AND length(v->>'issuer')<=2048 AND v->>'tokenHash' ~ '^[a-f0-9]{64}$'
    AND pactwoven.supplier_time(v->'authenticatedAt')<=issued AND issued<=observed AND membership_time<=observed
    AND observed<=at_time AND at_time-observed<=interval '20 seconds' AND at_time-membership_time<=interval '20 seconds'
    AND observed<expiry AND expiry-observed<=interval '30 seconds' AND at_time<expiry
    AND expiry<=pactwoven.supplier_time(v->'sessionExpiresAt');
EXCEPTION WHEN OTHERS THEN RETURN false;END $$;

-- Disclosed AUTH-SQL-04 trust: this one narrow reader runs as the existing
-- legacy identity owner, whose actual superuser attribute is checked at install.
-- Its new-table privileges are NOT confined by NOLOGIN or FORCE RLS. Fixed code,
-- exact relations and bounded arguments are the boundary. No dynamic SQL/DML,
-- provider call, raw session row, business/support-table read or row-to-JSON.
CREATE FUNCTION pactwoven.supplier_base_identity(v jsonb,site_ids jsonb,approver_ids jsonb) RETURNS jsonb
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

CREATE FUNCTION pactwoven.supplier_business_append_guard() RETURNS trigger
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog AS $$
DECLARE c pactwoven.supplier_access_contexts:=pactwoven.supplier_context();auth jsonb;last_number bigint;previous jsonb;x jsonb;expected_scope jsonb;BEGIN
  SELECT "authorization" INTO auth FROM pactwoven.supplier_access_contexts WHERE phase='WRITE';
  PERFORM pactwoven.supplier_require(c.phase='RESOLVE' AND auth IS NOT NULL AND
    (NEW.environment,NEW.buyer_organization_id,NEW.supplier_organization_id)=(c.environment,c.buyer_organization_id,c.supplier_organization_id));
  expected_scope:=pactwoven.supplier_request_scope(c.request);
  IF TG_TABLE_NAME='supplier_relationship_scope_policies' THEN
    SELECT version,record INTO last_number,previous FROM pactwoven.supplier_relationship_scope_policies
      WHERE (environment,buyer_organization_id,supplier_organization_id)=(c.environment,c.buyer_organization_id,c.supplier_organization_id) ORDER BY version DESC LIMIT 1;
    PERFORM pactwoven.supplier_require(auth->>'family'='policy' AND NEW.version=coalesce(last_number,0)+1
      AND NEW.version=(auth->>'nextRevision')::bigint AND NEW.record=auth->'record' AND NEW.receipt=auth->'receipt'
      AND NEW.actor_id=c.actor_id AND NEW.original_key=c.request#>>'{mutation,idempotencyKey}' AND NEW.record#>'{policy,pair}'=expected_scope
      AND NEW.policy_hash=NEW.record->>'policyHash' AND NEW.policy_hash=pactwoven.supplier_hash(jsonb_build_object('namespace','pactwoven/supplier-scope-policy/v1','policy',NEW.record->'policy'))
      AND (NEW.record#>>'{policy,version}')::bigint=NEW.version AND NEW.receipt->'result'=NEW.record
      AND NEW.receipt->'identity'=NEW.record#>'{policy,commandIdentity}' AND NEW.receipt->'recordedAt'=NEW.record#>'{policy,issuedAt}'
      AND NEW.receipt->>'commandDigest'=pactwoven.supplier_command_digest(c.request,c.effective_organization_id,c.actor_id)
      AND NEW.record#>>'{policy,commandDigest}'=NEW.receipt->>'commandDigest'
      AND NEW.record#>'{policy,predecessor}'=CASE WHEN previous IS NULL THEN 'null'::jsonb ELSE jsonb_build_object('pair',expected_scope,'version',previous#>'{policy,version}','hash',previous->'policyHash') END
      AND (NEW.context_database,NEW.context_session,NEW.context_backend,NEW.context_xid)=(c.database_oid,c.session_user_oid,c.backend_pid,c.full_xid));
    FOR x IN SELECT * FROM jsonb_array_elements(NEW.record#>'{policy,categories}') LOOP
      PERFORM pactwoven.supplier_require(pactwoven.supplier_category(x,true)
        AND x->>'definitionHash'=pactwoven.supplier_hash(jsonb_build_object('namespace','pactwoven/supplier-scope-category/v1','pair',expected_scope,'category',x-'definitionHash'))
        AND NOT EXISTS(SELECT 1 FROM pactwoven.supplier_relationship_scope_policies p,LATERAL jsonb_array_elements(p.record#>'{policy,categories}') prior_category
          WHERE (p.environment,p.buyer_organization_id,p.supplier_organization_id)=(c.environment,c.buyer_organization_id,c.supplier_organization_id)
            AND prior_category->>'id'=x->>'id' AND prior_category<>x));
    END LOOP;
  ELSIF TG_TABLE_NAME='supplier_relationship_proposals' THEN
    SELECT max(version) INTO last_number FROM pactwoven.supplier_relationship_proposals
      WHERE (environment,buyer_organization_id,supplier_organization_id,relationship_id)=(c.environment,c.buyer_organization_id,c.supplier_organization_id,c.relationship_id);
    PERFORM pactwoven.supplier_require(auth->>'family'='relationship' AND NEW.relationship_id=c.relationship_id AND NEW.version=coalesce(last_number,0)+1
      AND NEW.body=auth->'proposal' AND NEW.body=auth#>'{record,policyBinding}' AND NEW.body->'scope'=expected_scope
      AND NEW.body#>'{producingReceipt}'=auth#>'{receipt,receipt}' AND NEW.producing_revision=(auth->>'nextRevision')::bigint
      AND NEW.proposal_hash=NEW.body#>>'{proposal,hash}' AND NEW.version=(NEW.body#>>'{proposal,version}')::bigint
      AND NEW.policy_version=(NEW.body#>>'{policy,version}')::bigint AND NEW.policy_hash=NEW.body#>>'{policy,hash}');
  ELSIF TG_TABLE_NAME='supplier_relationship_versions' THEN
    SELECT max(revision) INTO last_number FROM pactwoven.supplier_relationship_versions
      WHERE (environment,buyer_organization_id,supplier_organization_id,relationship_id)=(c.environment,c.buyer_organization_id,c.supplier_organization_id,c.relationship_id);
    SELECT body INTO previous FROM pactwoven.supplier_relationship_proposals
      WHERE (environment,buyer_organization_id,supplier_organization_id,relationship_id,version)=(c.environment,c.buyer_organization_id,c.supplier_organization_id,c.relationship_id,NEW.proposal_version);
    PERFORM pactwoven.supplier_require(auth->>'family'='relationship' AND NEW.relationship_id=c.relationship_id AND NEW.revision=coalesce(last_number,0)+1
      AND NEW.revision=(auth->>'nextRevision')::bigint AND NEW.record=auth->'record' AND NEW.record->'policyBinding'=previous
      AND NEW.record#>'{snapshot,proposal,scope}'=expected_scope AND (NEW.record#>>'{snapshot,revision}')::bigint=NEW.revision
      AND NEW.proposal_version=(NEW.record#>>'{snapshot,proposal,version}')::bigint AND NEW.proposal_hash=NEW.record#>>'{snapshot,proposalHash}'
      AND NEW.proposal_hash=pactwoven.supplier_hash(jsonb_build_object('namespace','pactwoven/supplier-relationship-proposal/v1','proposal',NEW.record#>'{snapshot,proposal}'))
      AND NEW.policy_version=(previous#>>'{policy,version}')::bigint AND NEW.policy_hash=previous#>>'{policy,hash}'
      AND (NEW.context_database,NEW.context_session,NEW.context_backend,NEW.context_xid)=(c.database_oid,c.session_user_oid,c.backend_pid,c.full_xid));
  ELSIF TG_TABLE_NAME='supplier_relationship_receipts' THEN
    PERFORM pactwoven.supplier_require(auth->>'family'='relationship' AND NEW.relationship_id=c.relationship_id AND NEW.body=auth->'receipt'
      AND NEW.mutation=c.request->'mutation' AND NEW.revision=(auth->>'nextRevision')::bigint
      AND NEW.body#>'{receipt,result}'=pactwoven.supplier_head(auth#>'{record,snapshot}') AND NEW.body->'policy'=auth#>'{record,policyBinding,policy}'
      AND NEW.body#>'{receipt,identity}'=jsonb_build_object('scope',expected_scope,'organizationId',c.effective_organization_id,'actorId',c.actor_id,'idempotencyKey',c.request#>'{mutation,idempotencyKey}')
      AND NEW.body#>>'{receipt,commandDigest}'=pactwoven.supplier_command_digest(c.request,c.effective_organization_id,c.actor_id)
      AND NEW.body#>'{receipt,recordedAt}'=auth#>'{record,snapshot,updatedAt}'
      AND NEW.effective_organization_id=c.effective_organization_id AND NEW.actor_id=c.actor_id AND NEW.original_key=c.request#>>'{mutation,idempotencyKey}');
  ELSE RAISE EXCEPTION USING ERRCODE='SP001',MESSAGE='Unsupported supplier table family';END IF;
  RETURN NEW;
END $$;
-- Authorization linearizes at the checked acceptance/WRITE transition after
-- waits, not at physical COMMIT. Transaction-held fences and bounded transaction
-- lifetime remain required. This ordinary deferred trigger checks completeness;
-- SET CONSTRAINTS may flush it early, and it is not a commit-time freshness hook.
CREATE FUNCTION pactwoven.supplier_write_complete() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
  IF NEW.phase='WRITE' THEN
    IF NEW."authorization"->>'family'='policy' THEN
      PERFORM pactwoven.supplier_require(EXISTS(SELECT 1 FROM pactwoven.supplier_relationship_scope_policies p
        WHERE (p.context_database,p.context_session,p.context_backend,p.context_xid)=(NEW.database_oid,NEW.session_user_oid,NEW.backend_pid,NEW.full_xid)
          AND p.record=NEW."authorization"->'record' AND p.receipt=NEW."authorization"->'receipt'));
    ELSE
      PERFORM pactwoven.supplier_require(EXISTS(SELECT 1 FROM pactwoven.supplier_relationship_versions v JOIN pactwoven.supplier_relationship_receipts r
        USING(environment,buyer_organization_id,supplier_organization_id,relationship_id,revision)
        WHERE (v.context_database,v.context_session,v.context_backend,v.context_xid)=(NEW.database_oid,NEW.session_user_oid,NEW.backend_pid,NEW.full_xid)
          AND v.record=NEW."authorization"->'record' AND r.body=NEW."authorization"->'receipt'));
    END IF;
  END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER supplier_write_complete AFTER INSERT ON pactwoven.supplier_access_contexts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pactwoven.supplier_write_complete();

CREATE FUNCTION pactwoven.supplier_record_evidence(v jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='3s' AS $$
DECLARE b pactwoven.supplier_private_bindings;ev pactwoven.supplier_authentication_evidence;BEGIN
  b:=pactwoven.supplier_current_binding('verifier');
  PERFORM pactwoven.supplier_require(v->'binding'=b.body AND pactwoven.supplier_evidence_valid(v,clock_timestamp()));
  PERFORM pactwoven.supplier_base_identity(v,'[]'::jsonb,'[]'::jsonb);
  PERFORM pactwoven.supplier_require(pactwoven.supplier_evidence_valid(v,clock_timestamp()));
  INSERT INTO pactwoven.supplier_authentication_evidence(id,binding_id,binding_version,binding_hash,environment,effective_organization_id,actor_id,
    kind,purpose,request,request_digest,mutation_digest,observed_at,expires_at,body)
  VALUES((v->>'id')::uuid,b.id,b.version,b.hash,b.environment,b.effective_organization_id,v#>>'{actor,actorId}',v->>'kind',v#>>'{request,purpose}',
    v->'request',v->>'requestDigest',v->>'mutationDigest',pactwoven.supplier_time(v->'observedAt'),pactwoven.supplier_time(v->'expiresAt'),v)
  RETURNING * INTO ev;
  RETURN jsonb_build_object('id',ev.id::text,'version',1,'hash',ev.hash);
END $$;
CREATE FUNCTION pactwoven.supplier_scope_policy_read(eid uuid,q jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='3s' AS $$
DECLARE c pactwoven.supplier_access_contexts;result jsonb;BEGIN
  PERFORM pactwoven.supplier_require(q->>'kind'='policy-read');c:=pactwoven.supplier_begin(eid,q);
  SELECT record INTO result FROM pactwoven.supplier_relationship_scope_policies p
    WHERE (p.environment,p.buyer_organization_id,p.supplier_organization_id)=(c.environment,c.buyer_organization_id,c.supplier_organization_id)
      AND p.version=(q#>>'{query,policy,version}')::bigint AND p.policy_hash=q#>>'{query,policy,hash}';
  PERFORM pactwoven.supplier_require(result IS NOT NULL AND pactwoven.supplier_time(result#>'{policy,issuedAt}')<=clock_timestamp());
  RETURN jsonb_build_object('kind','policy-read','record',result);
END $$;
CREATE FUNCTION pactwoven.supplier_scope_policy_command(eid uuid,q jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='3s' AS $$
DECLARE c pactwoven.supplier_access_contexts;ev pactwoven.supplier_authentication_evidence;old pactwoven.supplier_relationship_scope_policies;
  current_row pactwoven.supplier_relationship_scope_policies;facts jsonb;cmd jsonb:=q#>'{mutation,command}';action text:=cmd#>>'{payload,action}';terms jsonb:=cmd#>'{payload,terms}';
  pair jsonb:=cmd->'pair';at_time timestamptz;expires timestamptz;at_text text;policy jsonb;record jsonb;receipt jsonb;identity jsonb;categories jsonb;issuer jsonb;
BEGIN
  PERFORM pactwoven.supplier_require(q->>'kind'='policy-command');c:=pactwoven.supplier_begin(eid,q);
  SELECT * INTO ev FROM pactwoven.supplier_authentication_evidence WHERE id=eid;
  SELECT * INTO current_row FROM pactwoven.supplier_relationship_scope_policies p
    WHERE (p.environment,p.buyer_organization_id,p.supplier_organization_id)=(c.environment,c.buyer_organization_id,c.supplier_organization_id) ORDER BY version DESC LIMIT 1;
  -- The policy lineage cannot follow a local pair into a different external
  -- buyer OR supplier identity, including an exact original command replay.
  -- The existing organization locks precede the pair fence and are still held.
  facts:=pactwoven.supplier_base_identity(ev.body,'[]'::jsonb,'[]'::jsonb);
  PERFORM pactwoven.supplier_require(current_row.version IS NULL OR
    (current_row.record#>'{policy,organizations,buyer,externalOrganizationId}'=facts#>'{organizations,buyer,externalOrganizationId}'
      AND current_row.record#>'{policy,organizations,supplier,externalOrganizationId}'=facts#>'{organizations,supplier,externalOrganizationId}'));
  SELECT * INTO old FROM pactwoven.supplier_relationship_scope_policies p
    WHERE (p.environment,p.buyer_organization_id,p.supplier_organization_id,p.actor_id,p.original_key)=(c.environment,c.buyer_organization_id,c.supplier_organization_id,c.actor_id,q#>>'{mutation,idempotencyKey}');
  IF old.version IS NOT NULL THEN
    PERFORM pactwoven.supplier_require(old.receipt->>'commandDigest'=ev.mutation_digest
      AND pactwoven.supplier_time(old.receipt->'recordedAt')<=pactwoven.supplier_time(current_row.record#>'{policy,issuedAt}')
      AND pactwoven.supplier_time(current_row.record#>'{policy,issuedAt}')<=clock_timestamp());
    RETURN jsonb_build_object('kind','policy-command','outcome','EXACT_REPLAY','receipt',old.receipt,'current',current_row.record);
  END IF;
  facts:=pactwoven.supplier_base_identity(ev.body,CASE WHEN action='revoke' THEN '[]'::jsonb ELSE terms->'buyerSiteIds' END,'[]'::jsonb);
  PERFORM pactwoven.supplier_require(cmd->'buyerOrganizationVersion'=facts#>'{organizations,buyer,version}' AND cmd->'authorityEpoch'=facts#>'{organizations,buyer,authorityEpoch}'
    AND (action='revoke' OR (facts#>>'{organizations,supplier,status}'='ACTIVE'
      AND pactwoven.supplier_time(facts#>'{organizations,supplier,validFrom}')<=clock_timestamp()))
    AND (cmd->>'expectedVersion')::bigint=coalesce(current_row.version,0)
    AND cmd->'predecessor'=CASE WHEN current_row.version IS NULL THEN 'null'::jsonb ELSE jsonb_build_object('pair',pair,'version',current_row.version,'hash',current_row.policy_hash) END
    AND (current_row.version IS NULL)=(action='issue') AND NOT(action='revoke' AND current_row.record#>>'{policy,status}'='REVOKED'));
  at_time:=date_trunc('milliseconds',clock_timestamp());at_text:=pactwoven.supplier_instant(at_time);
  PERFORM pactwoven.supplier_require(current_row.version IS NULL OR at_time>=pactwoven.supplier_time(current_row.record#>'{policy,issuedAt}'));
  IF action='revoke' THEN expires:=at_time;categories:=current_row.record#>'{policy,categories}';
  ELSE
    expires:=at_time+(terms->>'requestedValidityMs')::bigint*interval '1 millisecond';
    IF facts#>'{actingMembership,expiresAt}'<>'null'::jsonb THEN expires:=least(expires,pactwoven.supplier_time(facts#>'{actingMembership,expiresAt}'));END IF;
    PERFORM pactwoven.supplier_require(expires>at_time);
    SELECT jsonb_agg(x||jsonb_build_object('definitionHash',pactwoven.supplier_hash(jsonb_build_object('namespace','pactwoven/supplier-scope-category/v1','pair',pair,'category',x))) ORDER BY ord)
      INTO categories FROM jsonb_array_elements(terms->'categories') WITH ORDINALITY f(x,ord);
  END IF;
  identity:=jsonb_build_object('pair',pair,'organizationId',c.effective_organization_id,'actorId',c.actor_id,'idempotencyKey',q#>'{mutation,idempotencyKey}');
  issuer:=((ev.body->'actor')-'environment'::text-'principalKind'::text)||jsonb_build_object('factorEvidence',jsonb_build_object('id',ev.id::text,'version',1,'hash',ev.hash));
  policy:=jsonb_build_object('schemaVersion',1,'pair',pair,'version',coalesce(current_row.version,0)+1,'predecessor',cmd->'predecessor',
    'status',CASE WHEN action='revoke' THEN 'REVOKED' ELSE 'ACTIVE' END,'buyerSiteIds',CASE WHEN action='revoke' THEN current_row.record#>'{policy,buyerSiteIds}' ELSE terms->'buyerSiteIds' END,
    'categories',categories,'issuedAt',at_text,'validFrom',at_text,'expiresAt',pactwoven.supplier_instant(expires),'issuer',issuer,'commandIdentity',identity,'commandDigest',ev.mutation_digest,
    'organizations',jsonb_build_object('buyer',jsonb_build_object('externalOrganizationId',facts#>'{organizations,buyer,externalOrganizationId}','version',facts#>'{organizations,buyer,version}','authorityEpoch',facts#>'{organizations,buyer,authorityEpoch}'),
      'supplier',jsonb_build_object('externalOrganizationId',facts#>'{organizations,supplier,externalOrganizationId}','version',facts#>'{organizations,supplier,version}','authorityEpoch',facts#>'{organizations,supplier,authorityEpoch}')));
  record:=jsonb_build_object('policy',policy,'policyHash',pactwoven.supplier_hash(jsonb_build_object('namespace','pactwoven/supplier-scope-policy/v1','policy',policy)));
  receipt:=jsonb_build_object('identity',identity,'commandDigest',ev.mutation_digest,'result',record,'recordedAt',at_text);
  PERFORM pactwoven.supplier_add_write(c,jsonb_build_object('family','policy','nextRevision',coalesce(current_row.version,0)+1,'record',record,'receipt',receipt,'proposal',NULL));
  INSERT INTO pactwoven.supplier_relationship_scope_policies VALUES(c.environment,c.buyer_organization_id,c.supplier_organization_id,coalesce(current_row.version,0)+1,
    record->>'policyHash',record,receipt,c.actor_id,q#>>'{mutation,idempotencyKey}',c.database_oid,c.session_user_oid,c.backend_pid,c.full_xid,'WRITE');
  RETURN jsonb_build_object('kind','policy-command','outcome','APPENDED','receipt',receipt,'current',record);
END $$;

-- Only the already admitted exact relationship is resolved. The plan branch
-- obtains locators for provider observations; it does not evaluate approval truth.
CREATE FUNCTION pactwoven.supplier_approver_facts(ev jsonb,state jsonb,require_all boolean,planning boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog AS $$
DECLARE stamps jsonb;locators jsonb;facts jsonb;entry jsonb;member jsonb;organization jsonb;stamp jsonb;plan jsonb:='[]';
  supplied jsonb:=coalesce(ev->'approvers','[]'::jsonb);BEGIN
  SELECT coalesce(jsonb_agg(a ORDER BY a->>'party'),'[]') INTO stamps
    FROM jsonb_each(coalesce(state->'approvals','{}'::jsonb)) f(p,a) WHERE a<>'null'::jsonb;
  PERFORM pactwoven.supplier_require(NOT planning OR supplied='[]'::jsonb);
  IF require_all THEN PERFORM pactwoven.supplier_require(jsonb_array_length(supplied)=jsonb_array_length(stamps));END IF;
  FOR entry IN SELECT * FROM jsonb_array_elements(supplied) LOOP
    -- Missing/stale/changed-head observation is refusal, never a known negative gate.
    PERFORM pactwoven.supplier_require(state IS NOT NULL AND entry->'head'=pactwoven.supplier_head(state)
      AND stamps @> jsonb_build_array(entry->'approval') AND pactwoven.supplier_membership_observation(entry->'observation',clock_timestamp()));
  END LOOP;
  SELECT coalesce(jsonb_agg(jsonb_build_object('organizationId',a->'organizationId','actorId',a->'actorId')),'[]') INTO locators
    FROM jsonb_array_elements(CASE WHEN planning THEN stamps ELSE
      (SELECT coalesce(jsonb_agg(x->'approval'),'[]') FROM jsonb_array_elements(supplied) x) END) a;
  facts:=pactwoven.supplier_base_identity(ev,'[]'::jsonb,locators);
  PERFORM pactwoven.supplier_require(jsonb_array_length(facts->'approverMemberships')=jsonb_array_length(locators));
  FOR stamp IN SELECT * FROM jsonb_array_elements(CASE WHEN planning THEN stamps ELSE
      (SELECT coalesce(jsonb_agg(x->'approval'),'[]') FROM jsonb_array_elements(supplied) x) END) LOOP
    SELECT m INTO member FROM jsonb_array_elements(facts->'approverMemberships') m
      WHERE m->'organizationId'=stamp->'organizationId' AND m->'id'=stamp->'membershipId' AND m->'actorId'=stamp->'actorId';
    organization:=facts->'organizations'->(stamp->>'party');
    PERFORM pactwoven.supplier_require(member IS NOT NULL AND organization->'id'=stamp->'organizationId'
      AND member->>'subject' IS NOT NULL AND member->>'externalMembershipId' IS NOT NULL AND organization->>'externalOrganizationId' IS NOT NULL);
    IF planning THEN
      plan:=plan||jsonb_build_array(jsonb_build_object('approval',stamp,'externalOrganizationId',organization->'externalOrganizationId',
        'externalMembershipId',member->'externalMembershipId','subject',member->'subject'));
    ELSE
      SELECT x INTO entry FROM jsonb_array_elements(supplied) x WHERE x->'approval'=stamp;
      PERFORM pactwoven.supplier_require(entry#>'{observation,subject}'=member->'subject'
        AND entry#>'{observation,externalMembershipId}'=member->'externalMembershipId'
        AND entry#>'{observation,externalOrganizationId}'=organization->'externalOrganizationId');
    END IF;
  END LOOP;
  PERFORM pactwoven.supplier_require(pactwoven.supplier_evidence_valid(ev,clock_timestamp()));
  RETURN facts||jsonb_build_object('observationPlan',plan,'approverObservations',supplied);
END $$;
CREATE FUNCTION pactwoven.supplier_approval_current(approval jsonb,facts jsonb,at_time timestamptz) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
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
    AND (member->>'grantBasis'<>'clerk_admin_bootstrap' OR ob->>'externalRole'='org:admin')
    AND pactwoven.supplier_time(approval->'approvedAt')<=at_time AND at_time<pactwoven.supplier_time(approval->'expiresAt'),false);
END $$;
CREATE FUNCTION pactwoven.supplier_scope_current(policy jsonb,terms jsonb,facts jsonb,at_time timestamptz) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT coalesce(policy#>>'{policy,status}'='ACTIVE' AND pactwoven.supplier_time(policy#>'{policy,validFrom}')<=at_time
    AND at_time<pactwoven.supplier_time(policy#>'{policy,expiresAt}')
    AND facts#>>'{organizations,buyer,status}'='ACTIVE' AND facts#>>'{organizations,supplier,status}'='ACTIVE'
    AND pactwoven.supplier_time(facts#>'{organizations,buyer,validFrom}')<=at_time
    AND pactwoven.supplier_time(facts#>'{organizations,supplier,validFrom}')<=at_time
    AND policy#>'{policy,organizations,buyer,externalOrganizationId}'=facts#>'{organizations,buyer,externalOrganizationId}'
    AND policy#>'{policy,organizations,supplier,externalOrganizationId}'=facts#>'{organizations,supplier,externalOrganizationId}'
    AND (policy#>'{policy,buyerSiteIds}') @> (terms->'buyerSiteIds')
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(terms->'serviceCategoryIds') id WHERE NOT EXISTS(
      SELECT 1 FROM jsonb_array_elements(policy#>'{policy,categories}') category WHERE category->'id'=id)),false)
$$;
CREATE FUNCTION pactwoven.supplier_policy_reference(record jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT CASE WHEN record IS NULL THEN NULL ELSE jsonb_build_object('pair',record#>'{policy,pair}','version',record#>'{policy,version}','hash',record->'policyHash') END
$$;
CREATE FUNCTION pactwoven.supplier_actor_stamp(ev jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT jsonb_build_object('actorId',ev#>'{actor,actorId}','organizationId',ev#>'{actor,organizationId}','membershipId',ev#>'{actor,membershipId}',
    'membershipVersion',ev#>'{actor,membershipVersion}','organizationVersion',ev#>'{actor,organizationVersion}','organizationEpoch',ev#>'{actor,organizationEpoch}')
$$;

CREATE FUNCTION pactwoven.supplier_relationship_status(eid uuid,q jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='3s' AS $$
DECLARE c pactwoven.supplier_access_contexts;ev pactwoven.supplier_authentication_evidence;current_record jsonb;selected jsonb;facts jsonb;
  policy jsonb;state jsonb;current_head jsonb;current_revision boolean;reason text;projection jsonb;at_time timestamptz;BEGIN
  PERFORM pactwoven.supplier_require(q->>'kind' IN ('relationship-status','relationship-observation-plan'));c:=pactwoven.supplier_begin(eid,q);
  SELECT * INTO ev FROM pactwoven.supplier_authentication_evidence WHERE id=eid;
  SELECT record INTO current_record FROM pactwoven.supplier_relationship_versions v
    WHERE (v.environment,v.buyer_organization_id,v.supplier_organization_id,v.relationship_id)=(c.environment,c.buyer_organization_id,c.supplier_organization_id,c.relationship_id)
    ORDER BY revision DESC LIMIT 1;
  current_head:=CASE WHEN current_record IS NULL THEN NULL ELSE pactwoven.supplier_head(current_record->'snapshot') END;
  IF q->>'kind'='relationship-observation-plan' THEN
    facts:=pactwoven.supplier_approver_facts(ev.body,current_record->'snapshot',false,true);
    RETURN jsonb_build_object('kind','relationship-observation-plan','plan',jsonb_build_object('scope',q#>'{query,scope}',
      'head',current_head,'approvers',facts->'observationPlan'));
  END IF;
  PERFORM pactwoven.supplier_require(current_record IS NOT NULL);
  IF q#>'{query,revision}'='null'::jsonb THEN selected:=current_record;
  ELSE SELECT record INTO selected FROM pactwoven.supplier_relationship_versions v
    WHERE (v.environment,v.buyer_organization_id,v.supplier_organization_id,v.relationship_id,v.revision)=
      (c.environment,c.buyer_organization_id,c.supplier_organization_id,c.relationship_id,(q#>>'{query,revision}')::bigint);END IF;
  PERFORM pactwoven.supplier_require(selected IS NOT NULL);state:=selected->'snapshot';current_revision:=state->'revision'=current_head->'revision';
  facts:=pactwoven.supplier_approver_facts(ev.body,current_record->'snapshot',current_revision);
  SELECT record INTO policy FROM pactwoven.supplier_relationship_scope_policies p
    WHERE (p.environment,p.buyer_organization_id,p.supplier_organization_id)=(c.environment,c.buyer_organization_id,c.supplier_organization_id) ORDER BY version DESC LIMIT 1;
  at_time:=clock_timestamp();PERFORM pactwoven.supplier_require(pactwoven.supplier_time(state->'updatedAt')<=at_time);
  reason:=CASE WHEN NOT current_revision THEN 'NOT_CURRENT_REVISION' WHEN state->>'status'<>'ACTIVE' THEN 'NOT_ACTIVE'
    WHEN pactwoven.supplier_time(state#>'{proposal,terms,expiresAt}')<=at_time THEN 'PROPOSAL_EXPIRED'
    WHEN NOT pactwoven.supplier_scope_current(policy,state#>'{proposal,terms}',facts,at_time)
      OR selected#>'{policyBinding,policy}' IS DISTINCT FROM pactwoven.supplier_policy_reference(policy) THEN 'SCOPE_NOT_CURRENT'
    WHEN NOT pactwoven.supplier_approval_current(state#>'{approvals,buyer}',facts,at_time)
      OR NOT pactwoven.supplier_approval_current(state#>'{approvals,supplier}',facts,at_time) THEN 'APPROVAL_NOT_CURRENT' ELSE NULL END;
  projection:=pactwoven.supplier_head(state)||jsonb_build_object('kind','RELATIONSHIP_STATUS_ONLY','expiresAt',state#>'{proposal,terms,expiresAt}',
    'viewerParty',CASE WHEN c.effective_organization_id=c.buyer_organization_id THEN 'buyer' ELSE 'supplier' END,'current',current_revision,
    'approvalsRecorded',jsonb_build_object('buyer',state#>'{approvals,buyer}'<>'null'::jsonb,'supplier',state#>'{approvals,supplier}'<>'null'::jsonb),
    'relationshipGate',CASE WHEN reason IS NULL THEN 'SATISFIED' ELSE 'BLOCKED' END,'gateReason',reason,
    'authentication','NOT_ESTABLISHED','businessVerification','NOT_ESTABLISHED','payeeVerification','NOT_ESTABLISHED',
    'bookingAuthority',false,'contractualAcceptance',false,'paymentAuthority',false);
  PERFORM pactwoven.supplier_require(pactwoven.supplier_evidence_valid(ev.body,clock_timestamp()));
  RETURN jsonb_build_object('kind','relationship-status','projection',projection);
END $$;

-- Original rows, timestamps and policy pins are recovered as stored. Current
-- access is rechecked, but old authority is neither renewed nor re-evaluated.
CREATE FUNCTION pactwoven.supplier_original_relationship(c pactwoven.supplier_access_contexts,current_record jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog AS $$
DECLARE original pactwoven.supplier_relationship_receipts;record jsonb;receipt jsonb;producing jsonb;wanted text;BEGIN
  SELECT * INTO original FROM pactwoven.supplier_relationship_receipts r
    WHERE (r.environment,r.buyer_organization_id,r.supplier_organization_id,r.relationship_id,r.effective_organization_id,r.actor_id,r.original_key)=
      (c.environment,c.buyer_organization_id,c.supplier_organization_id,c.relationship_id,c.effective_organization_id,c.actor_id,
        CASE WHEN c.request->>'kind'='relationship-command' THEN c.request#>>'{mutation,idempotencyKey}' ELSE c.request#>>'{query,identity,idempotencyKey}' END);
  IF original.revision IS NULL THEN RETURN NULL;END IF;
  wanted:=CASE WHEN c.request->>'kind'='relationship-command' THEN pactwoven.supplier_command_digest(c.request,c.effective_organization_id,c.actor_id)
    ELSE c.request#>>'{query,commandDigest}' END;receipt:=original.body->'receipt';
  SELECT v.record INTO record FROM pactwoven.supplier_relationship_versions v
    WHERE (v.environment,v.buyer_organization_id,v.supplier_organization_id,v.relationship_id,v.revision)=
      (c.environment,c.buyer_organization_id,c.supplier_organization_id,c.relationship_id,original.revision);
  producing:=record#>'{policyBinding,producingReceipt}';
  PERFORM pactwoven.supplier_require(current_record IS NOT NULL AND record IS NOT NULL AND receipt->>'commandDigest'=wanted
    AND pactwoven.supplier_time(current_record#>'{snapshot,updatedAt}')<=clock_timestamp()
    AND (c.request->>'kind'<>'relationship-command' OR original.mutation=c.request->'mutation')
    AND (c.request->>'kind'<>'relationship-recover' OR original.mutation#>'{command,payload,action}'=c.request#>'{query,action}')
    AND receipt->'result'=pactwoven.supplier_head(record->'snapshot') AND original.body->'policy'=record#>'{policyBinding,policy}'
    AND receipt->'recordedAt'=record#>'{snapshot,updatedAt}'
    AND (receipt#>>'{result,revision}')::bigint<=(current_record#>>'{snapshot,revision}')::bigint
    AND pactwoven.supplier_time(receipt->'recordedAt')<=pactwoven.supplier_time(current_record#>'{snapshot,updatedAt}')
    AND pactwoven.supplier_time(producing->'recordedAt')<=pactwoven.supplier_time(receipt->'recordedAt')
    AND (receipt#>'{result,revision}'<>producing#>'{result,revision}' OR receipt=producing)
    AND (receipt#>'{result,proposal,version}'<>current_record#>'{snapshot,proposal,version}'
      OR (receipt#>'{result,proposal}'=pactwoven.supplier_head(current_record->'snapshot')->'proposal'
        AND original.body->'policy'=current_record#>'{policyBinding,policy}')));
  RETURN jsonb_build_object('mutation',original.mutation,'receipt',original.body,'record',record);
END $$;
CREATE FUNCTION pactwoven.supplier_relationship_recover(eid uuid,q jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='3s' AS $$
DECLARE c pactwoven.supplier_access_contexts;ev pactwoven.supplier_authentication_evidence;current_record jsonb;original jsonb;BEGIN
  PERFORM pactwoven.supplier_require(q->>'kind'='relationship-recover');c:=pactwoven.supplier_begin(eid,q);
  SELECT * INTO ev FROM pactwoven.supplier_authentication_evidence WHERE id=eid;
  SELECT record INTO current_record FROM pactwoven.supplier_relationship_versions v
    WHERE (v.environment,v.buyer_organization_id,v.supplier_organization_id,v.relationship_id)=(c.environment,c.buyer_organization_id,c.supplier_organization_id,c.relationship_id)
    ORDER BY revision DESC LIMIT 1;
  PERFORM pactwoven.supplier_approver_facts(ev.body,current_record->'snapshot',false);
  original:=pactwoven.supplier_original_relationship(c,current_record);
  RETURN jsonb_build_object('kind','relationship-recover','original',CASE WHEN original IS NULL THEN NULL ELSE jsonb_build_object(
    'mutation',original->'mutation','receipt',original->'receipt','binding',original#>'{record,policyBinding}',
    'currentHead',pactwoven.supplier_head(current_record->'snapshot')) END);
END $$;

CREATE FUNCTION pactwoven.supplier_relationship_command(eid uuid,q jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='3s' AS $$
DECLARE c pactwoven.supplier_access_contexts;ev pactwoven.supplier_authentication_evidence;current_record jsonb;state jsonb;original jsonb;facts jsonb;policy jsonb;
  cmd jsonb:=q#>'{mutation,command}';action text:=cmd#>>'{payload,action}';terms jsonb:=cmd#>'{payload,terms}';scope jsonb:=cmd->'scope';
  party text;other_party text;at_time timestamptz;at_text text;stamp jsonb;proposal jsonb;proposal_hash text;next_state jsonb;approvals jsonb;
  receipt jsonb;binding jsonb;record jsonb;persisted_receipt jsonb;new_revision bigint;new_proposal boolean;BEGIN
  PERFORM pactwoven.supplier_require(q->>'kind'='relationship-command');c:=pactwoven.supplier_begin(eid,q);
  SELECT * INTO ev FROM pactwoven.supplier_authentication_evidence WHERE id=eid;
  SELECT v.record INTO current_record FROM pactwoven.supplier_relationship_versions v
    WHERE (v.environment,v.buyer_organization_id,v.supplier_organization_id,v.relationship_id)=(c.environment,c.buyer_organization_id,c.supplier_organization_id,c.relationship_id)
    ORDER BY revision DESC LIMIT 1;
  state:=current_record->'snapshot';original:=pactwoven.supplier_original_relationship(c,current_record);
  facts:=pactwoven.supplier_approver_facts(ev.body,state,action='approve' AND original IS NULL);
  IF original IS NOT NULL THEN
    RETURN jsonb_build_object('kind','relationship-command','outcome','EXACT_REPLAY','receipt',original->'receipt','record',original->'record',
      'currentHead',pactwoven.supplier_head(state));
  END IF;
  PERFORM pactwoven.supplier_require(cmd->'authorityEpoch'=ev.body#>'{actor,organizationEpoch}'
    AND (cmd->>'expectedVersion')::bigint=coalesce((state->>'revision')::bigint,0)
    AND cmd->'targetProposal'=CASE WHEN state IS NULL THEN 'null'::jsonb ELSE pactwoven.supplier_head(state)->'proposal' END
    AND (state IS NULL)=(action='create') AND (state IS NULL OR state->>'status'<>'REVOKED'));
  at_time:=date_trunc('milliseconds',clock_timestamp());at_text:=pactwoven.supplier_instant(at_time);
  PERFORM pactwoven.supplier_require(state IS NULL OR at_time>=pactwoven.supplier_time(state->'updatedAt'));
  party:=CASE WHEN c.effective_organization_id=c.buyer_organization_id THEN 'buyer' ELSE 'supplier' END;
  other_party:=CASE WHEN party='buyer' THEN 'supplier' ELSE 'buyer' END;stamp:=pactwoven.supplier_actor_stamp(ev.body);
  new_revision:=coalesce((state->>'revision')::bigint,0)+1;new_proposal:=action IN ('create','revise');
  IF new_proposal OR action='approve' THEN
    SELECT p.record INTO policy FROM pactwoven.supplier_relationship_scope_policies p
      WHERE (p.environment,p.buyer_organization_id,p.supplier_organization_id)=(c.environment,c.buyer_organization_id,c.supplier_organization_id) ORDER BY version DESC LIMIT 1;
    PERFORM pactwoven.supplier_require(pactwoven.supplier_scope_current(policy,CASE WHEN new_proposal THEN terms ELSE state#>'{proposal,terms}' END,facts,at_time));
  END IF;
  IF new_proposal THEN
    PERFORM pactwoven.supplier_require(pactwoven.supplier_time(terms->'expiresAt')>at_time);
    proposal:=jsonb_build_object('schemaVersion',1,'scope',scope,'version',coalesce((state#>>'{proposal,version}')::bigint,0)+1,
      'previousVersionHash',state->'proposalHash','terms',terms,'createdBy',stamp,'createdAt',at_text);
    proposal_hash:=pactwoven.supplier_hash(jsonb_build_object('namespace','pactwoven/supplier-relationship-proposal/v1','proposal',proposal));
    next_state:=jsonb_build_object('schemaVersion',1,'revision',new_revision,'proposal',proposal,'proposalHash',proposal_hash,'status','PROPOSED',
      'approvals',jsonb_build_object('buyer',NULL,'supplier',NULL),'changedBy',stamp,'updatedAt',at_text);
  ELSE
    IF action='approve' THEN
      PERFORM pactwoven.supplier_require(state->>'status'='PROPOSED' AND state->'approvals'->party='null'::jsonb
        AND current_record#>'{policyBinding,policy}'=pactwoven.supplier_policy_reference(policy)
        AND (state->'approvals'->other_party='null'::jsonb OR pactwoven.supplier_approval_current(state->'approvals'->other_party,facts,at_time))
        AND pactwoven.supplier_time(cmd#>'{payload,expiresAt}')>at_time
        AND pactwoven.supplier_time(cmd#>'{payload,expiresAt}')<=pactwoven.supplier_time(state#>'{proposal,terms,expiresAt}')
        AND (facts#>'{actingMembership,expiresAt}'='null'::jsonb OR pactwoven.supplier_time(cmd#>'{payload,expiresAt}')<=pactwoven.supplier_time(facts#>'{actingMembership,expiresAt}')));
      approvals:=jsonb_set(state->'approvals',ARRAY[party],stamp||jsonb_build_object('party',party,'proposal',pactwoven.supplier_head(state)->'proposal',
        'approvedAt',at_text,'expiresAt',cmd#>'{payload,expiresAt}'));
      next_state:=state||jsonb_build_object('revision',new_revision,'approvals',approvals,'status',
        CASE WHEN approvals->'buyer'<>'null'::jsonb AND approvals->'supplier'<>'null'::jsonb THEN 'ACTIVE' ELSE 'PROPOSED' END,'changedBy',stamp,'updatedAt',at_text);
    ELSE
      PERFORM pactwoven.supplier_require(action<>'suspend' OR state->>'status'<>'SUSPENDED');
      next_state:=state||jsonb_build_object('revision',new_revision,'status',CASE WHEN action='suspend' THEN 'SUSPENDED' ELSE 'REVOKED' END,
        'approvals',jsonb_build_object('buyer',NULL,'supplier',NULL),'changedBy',stamp,'updatedAt',at_text);
    END IF;
  END IF;
  receipt:=jsonb_build_object('identity',jsonb_build_object('scope',scope,'organizationId',c.effective_organization_id,'actorId',c.actor_id,'idempotencyKey',q#>'{mutation,idempotencyKey}'),
    'commandDigest',ev.mutation_digest,'result',pactwoven.supplier_head(next_state),'recordedAt',at_text);
  binding:=CASE WHEN new_proposal THEN jsonb_build_object('schemaVersion',1,'scope',scope,'proposal',pactwoven.supplier_head(next_state)->'proposal',
    'policy',pactwoven.supplier_policy_reference(policy),'producingReceipt',receipt) ELSE current_record->'policyBinding' END;
  record:=jsonb_build_object('snapshot',next_state,'policyBinding',binding);persisted_receipt:=jsonb_build_object('receipt',receipt,'policy',binding->'policy');
  PERFORM pactwoven.supplier_add_write(c,jsonb_build_object('family','relationship','nextRevision',new_revision,'record',record,'receipt',persisted_receipt,
    'proposal',CASE WHEN new_proposal THEN binding ELSE NULL END));
  IF new_proposal THEN
    INSERT INTO pactwoven.supplier_relationship_proposals VALUES(c.environment,c.buyer_organization_id,c.supplier_organization_id,c.relationship_id,
      (next_state#>>'{proposal,version}')::bigint,next_state->>'proposalHash',(binding#>>'{policy,version}')::bigint,binding#>>'{policy,hash}',new_revision,binding);
  END IF;
  INSERT INTO pactwoven.supplier_relationship_versions VALUES(c.environment,c.buyer_organization_id,c.supplier_organization_id,c.relationship_id,new_revision,
    (next_state#>>'{proposal,version}')::bigint,next_state->>'proposalHash',(binding#>>'{policy,version}')::bigint,binding#>>'{policy,hash}',record,
    c.database_oid,c.session_user_oid,c.backend_pid,c.full_xid,'WRITE');
  INSERT INTO pactwoven.supplier_relationship_receipts VALUES(c.environment,c.buyer_organization_id,c.supplier_organization_id,c.relationship_id,c.effective_organization_id,c.actor_id,
    q#>>'{mutation,idempotencyKey}',new_revision,q->'mutation',persisted_receipt);
  RETURN jsonb_build_object('kind','relationship-command','outcome','APPENDED','receipt',persisted_receipt,'record',record,'currentHead',pactwoven.supplier_head(next_state));
END $$;

CREATE FUNCTION pactwoven.supplier_context_append_guard() RETURNS trigger
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog AS $$
DECLARE ev pactwoven.supplier_authentication_evidence;b pactwoven.supplier_private_bindings;r pactwoven.supplier_access_contexts;scope jsonb;BEGIN
  b:=pactwoven.supplier_current_binding('authorizer');
  SELECT * INTO ev FROM pactwoven.supplier_authentication_evidence WHERE id=NEW.evidence_id;
  scope:=pactwoven.supplier_request_scope(NEW.request);
  PERFORM pactwoven.supplier_require((NEW.database_oid,NEW.session_user_oid,NEW.backend_pid,NEW.full_xid)=
    (pactwoven.supplier_database_oid(),pactwoven.supplier_session_oid(),pg_backend_pid(),pg_current_xact_id())
    AND ev.hash=NEW.evidence_hash AND ev.body->'binding'=b.body AND pactwoven.supplier_evidence_valid(ev.body,clock_timestamp())
    AND (NEW.binding_id,NEW.binding_version,NEW.binding_hash)=(b.id,b.version,b.hash)
    AND NEW.request=ev.request AND NEW.request_digest=ev.request_digest
    AND (NEW.environment,NEW.buyer_organization_id,NEW.supplier_organization_id)=(scope->>'environment',scope->>'buyerOrganizationId',scope->>'supplierOrganizationId')
    AND NEW.relationship_id IS NOT DISTINCT FROM scope->>'supplierRelationshipId'
    AND NEW.effective_organization_id=ev.effective_organization_id AND NEW.actor_id=ev.actor_id
    AND NEW.observed_at=ev.observed_at AND NEW.expires_at=ev.expires_at);
  SELECT * INTO r FROM pactwoven.supplier_access_contexts WHERE phase='RESOLVE';
  IF NEW.phase='RESOLVE' THEN PERFORM pactwoven.supplier_require(r.phase IS NULL AND NEW."authorization" IS NULL);
  ELSE
    PERFORM pactwoven.supplier_require(r.phase='RESOLVE' AND ev.kind='factors'
      AND (NEW.evidence_id,NEW.evidence_hash,NEW.binding_id,NEW.binding_version,NEW.binding_hash)=
        (r.evidence_id,r.evidence_hash,r.binding_id,r.binding_version,r.binding_hash)
      AND NEW.request=r.request AND NEW.request_digest=r.request_digest AND NEW.observed_at=r.observed_at AND NEW.expires_at=r.expires_at
      AND NEW."authorization"->>'family'=CASE WHEN r.request->>'kind'='policy-command' THEN 'policy' WHEN r.request->>'kind'='relationship-command' THEN 'relationship' ELSE NULL END
      AND (NEW."authorization"->>'nextRevision')::bigint=(r.request#>>'{mutation,command,expectedVersion}')::bigint+1);
  END IF;RETURN NEW;
END $$;
CREATE TRIGGER supplier_context_append BEFORE INSERT ON pactwoven.supplier_access_contexts
  FOR EACH ROW EXECUTE FUNCTION pactwoven.supplier_context_append_guard();

-- Install only this packet's guards, owner split and exact table allowlist.
DO $$ DECLARE table_name text;fn record;grant_row record;legacy_owner oid;legacy_name text;BEGIN
  SELECT c.relowner,r.rolname INTO legacy_owner,legacy_name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner
    WHERE n.nspname='pactwoven' AND c.relname='organizations' AND r.rolsuper;
  IF legacy_owner IS NULL OR (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='pactwoven'
    AND c.relname IN ('organizations','memberships','session_revocations','sites') AND c.relowner=legacy_owner)<>4 THEN
    RAISE EXCEPTION 'Supplier legacy reader requires the disclosed shared broad superuser identity owner';
  END IF;
  FOREACH table_name IN ARRAY ARRAY['supplier_private_bindings','supplier_authentication_evidence','supplier_access_contexts',
    'supplier_relationship_scope_policies','supplier_relationship_proposals','supplier_relationship_versions','supplier_relationship_receipts'] LOOP
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
    IF table_name<>'supplier_private_bindings' THEN EXECUTE format('GRANT INSERT ON TABLE pactwoven.%I TO pactwoven_supplier_executor',table_name);END IF;
    EXECUTE format('CREATE TRIGGER supplier_no_change BEFORE UPDATE OR DELETE ON pactwoven.%I FOR EACH ROW EXECUTE FUNCTION pactwoven.supplier_immutable()',table_name);
    EXECUTE format('CREATE TRIGGER supplier_no_truncate BEFORE TRUNCATE ON pactwoven.%I FOR EACH STATEMENT EXECUTE FUNCTION pactwoven.supplier_immutable()',table_name);
    IF table_name IN ('supplier_relationship_scope_policies','supplier_relationship_proposals','supplier_relationship_versions','supplier_relationship_receipts') THEN
      EXECUTE format('CREATE TRIGGER supplier_business_append BEFORE INSERT ON pactwoven.%I FOR EACH ROW EXECUTE FUNCTION pactwoven.supplier_business_append_guard()',table_name);
    END IF;
  END LOOP;
  FOR fn IN SELECT p.oid,p.proowner,p.proname,p.oid::regprocedure AS identity FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='pactwoven' AND p.proname LIKE 'supplier_%' LOOP
    FOR grant_row IN SELECT DISTINCT a.grantee,r.rolname FROM pg_proc p
      CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a LEFT JOIN pg_roles r ON r.oid=a.grantee
      WHERE p.oid=fn.oid AND a.grantee<>p.proowner LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %s',fn.identity,CASE WHEN grant_row.grantee=0 THEN 'PUBLIC' ELSE quote_ident(grant_row.rolname) END);
    END LOOP;
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',fn.identity);
    IF fn.proname='supplier_base_identity' THEN
      -- This owner remains broadly privileged. FORCE RLS is no confinement claim.
      EXECUTE format('ALTER FUNCTION %s OWNER TO %I',fn.identity,legacy_name);
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pactwoven_supplier_executor',fn.identity);
    ELSE EXECUTE format('ALTER FUNCTION %s OWNER TO pactwoven_supplier_executor',fn.identity);END IF;
  END LOOP;
END $$;

-- Offline role/binding enrollment is deliberately absent. A separately reviewed
-- procedure must grant only the fixed recorder or the five authorizer functions
-- to an exact safe LOGIN and append a finite binding under the maintenance fences.
-- No runtime login, private credential, provider endpoint or registration is made.
COMMIT;
