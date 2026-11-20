BEGIN;

-- Additive v2 data boundary. Existing v1 groups, functions, rows and outboxes
-- are unchanged. Only the separately admitted delegation profile uses this API.
DO $$ BEGIN
  IF to_regprocedure('pactwoven.native_delegation_task_context_locked(text,jsonb,text)') IS NULL
    OR to_regprocedure('pactwoven.native_delegation_actor_locked(jsonb,text,boolean)') IS NULL THEN
    RAISE EXCEPTION 'Native delegation storage must precede scoped memory';
  END IF;
END $$;

CREATE FUNCTION pactwoven.native_memory_require(ok boolean, code text DEFAULT 'NM004') RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION USING ERRCODE=code,MESSAGE='Scoped memory precondition not satisfied'; END IF;
END $$;
CREATE FUNCTION pactwoven.native_memory_object(v jsonb,keys text[]) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ BEGIN
  IF jsonb_typeof(v) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  RETURN coalesce(v ?& keys AND (SELECT count(*) FROM jsonb_object_keys(v))=cardinality(keys),false);
END $$;
CREATE FUNCTION pactwoven.native_memory_id(v jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT coalesce(jsonb_typeof(v)='string' AND v#>>'{}' ~ '^[A-Za-z0-9_-]{1,128}$',false)
$$;
CREATE FUNCTION pactwoven.native_memory_text(v jsonb,lo integer,hi integer) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT coalesce(jsonb_typeof(v)='string' AND char_length(v#>>'{}')+regexp_count(v#>>'{}',U&'[\+010000-\+10FFFF]') BETWEEN lo AND hi,false)
$$;
CREATE FUNCTION pactwoven.native_memory_revision(v jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ BEGIN
  IF jsonb_typeof(v) IS DISTINCT FROM 'number' OR v::text !~ '^[1-9][0-9]{0,15}$' THEN RETURN false;END IF;
  RETURN (v::text)::numeric<=9007199254740991;
END $$;
CREATE FUNCTION pactwoven.native_memory_time(v jsonb) RETURNS timestamptz
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ BEGIN
  IF jsonb_typeof(v) IS DISTINCT FROM 'string' OR v#>>'{}' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]{1,3})?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$' THEN RETURN NULL; END IF;
  RETURN (v#>>'{}')::timestamptz;
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RETURN NULL;
END $$;
CREATE FUNCTION pactwoven.native_memory_instant(v timestamptz) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT to_char(v AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') $$;
CREATE FUNCTION pactwoven.native_memory_canonical(v jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ DECLARE answer text; BEGIN
  CASE jsonb_typeof(v)
  WHEN 'object' THEN SELECT '{'||coalesce(string_agg(to_jsonb(k)::text||':'||pactwoven.native_memory_canonical(x),',' ORDER BY k COLLATE "C"),'')||'}'
    INTO answer FROM jsonb_each(v) q(k,x);RETURN answer;
  WHEN 'array' THEN SELECT '['||coalesce(string_agg(pactwoven.native_memory_canonical(x),',' ORDER BY n),'')||']'
    INTO answer FROM jsonb_array_elements(v) WITH ORDINALITY q(x,n);RETURN answer;
  WHEN 'number' THEN RETURN trim_scale((v::text)::numeric)::text;
  WHEN 'string','boolean','null' THEN RETURN v::text;
  ELSE RAISE EXCEPTION USING ERRCODE='NM004',MESSAGE='Canonical memory data required'; END CASE;
END $$;
CREATE FUNCTION pactwoven.native_memory_hash(v jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT encode(sha256(convert_to(pactwoven.native_memory_canonical(v),'UTF8')),'hex') $$;
CREATE FUNCTION pactwoven.native_memory_scope(v jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT jsonb_build_object('environment',v->'environment','organizationId',v->'organizationId','siteId',v->'siteId') $$;
CREATE FUNCTION pactwoven.native_memory_scope_valid(v jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT coalesce(v->>'environment' IN ('simulation','development','staging','production')
  AND pactwoven.native_memory_id(v->'organizationId') AND pactwoven.native_memory_id(v->'siteId'),false) $$;
CREATE FUNCTION pactwoven.native_memory_ref(v jsonb,source boolean DEFAULT false) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT pactwoven.native_memory_scope(v)||jsonb_build_object(CASE WHEN source THEN 'sourceId' ELSE 'memoryId' END,
    v->CASE WHEN source THEN 'sourceId' ELSE 'memoryId' END,'revision',v->'revision','digest',
    pactwoven.native_memory_hash(jsonb_build_object('namespace',CASE WHEN source THEN 'pactwoven/native-memory-source/v1' ELSE 'pactwoven/native-memory/v1' END,'record',v)))
$$;
CREATE FUNCTION pactwoven.native_memory_ref_valid(v jsonb,source boolean DEFAULT false) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT coalesce(
  pactwoven.native_memory_object(v,ARRAY['environment','organizationId','siteId',CASE WHEN source THEN 'sourceId' ELSE 'memoryId' END,'revision','digest'])
  AND pactwoven.native_memory_scope_valid(v) AND pactwoven.native_memory_id(v->CASE WHEN source THEN 'sourceId' ELSE 'memoryId' END)
  AND pactwoven.native_memory_revision(v->'revision') AND jsonb_typeof(v->'digest')='string' AND v->>'digest' ~ '^[a-f0-9]{64}$',false) $$;
CREATE FUNCTION pactwoven.native_memory_provenance_valid(v jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT coalesce(
  (v->>'kind'='user' AND pactwoven.native_memory_object(v,ARRAY['kind','actorId']) AND pactwoven.native_memory_id(v->'actorId')) OR
  (v->>'kind'='agent' AND pactwoven.native_memory_object(v,ARRAY['kind','agentId','taskId','handoffId']) AND pactwoven.native_memory_id(v->'agentId')
    AND pactwoven.native_memory_id(v->'taskId') AND pactwoven.native_memory_id(v->'handoffId')),false) $$;
CREATE FUNCTION pactwoven.native_memory_access_valid(v jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ DECLARE item jsonb;BEGIN
  IF NOT pactwoven.native_memory_object(v,ARRAY['readers','purposes']) OR jsonb_typeof(v->'readers')<>'array' OR jsonb_typeof(v->'purposes')<>'array' THEN RETURN false; END IF;
  IF jsonb_array_length(v->'readers') NOT BETWEEN 1 AND 100 OR jsonb_array_length(v->'purposes') NOT BETWEEN 1 AND 3
    OR (SELECT count(*)<>count(DISTINCT x) FROM jsonb_array_elements(v->'readers') x)
    OR (SELECT count(*)<>count(DISTINCT x) FROM jsonb_array_elements(v->'purposes') x) THEN RETURN false; END IF;
  FOR item IN SELECT x FROM jsonb_array_elements(v->'readers') x LOOP
    IF NOT pactwoven.native_memory_object(item,ARRAY['kind','id']) OR coalesce(item->>'kind','') NOT IN ('user','agent') OR NOT pactwoven.native_memory_id(item->'id') THEN RETURN false; END IF;
  END LOOP;
  RETURN NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v->'purposes') x WHERE jsonb_typeof(x)<>'string' OR x#>>'{}' NOT IN ('task_context','human_review','audit'));
END $$;
CREATE FUNCTION pactwoven.native_memory_record_valid(v jsonb,source boolean DEFAULT false) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ DECLARE r jsonb;k text;attr jsonb;BEGIN
  IF jsonb_typeof(v) IS DISTINCT FROM 'object' OR octet_length(v::text)>524288 OR v->'schemaVersion' IS DISTINCT FROM '1'::jsonb OR NOT pactwoven.native_memory_scope_valid(v)
    OR NOT pactwoven.native_memory_id(v->CASE WHEN source THEN 'sourceId' ELSE 'memoryId' END) OR NOT pactwoven.native_memory_revision(v->'revision')
    OR NOT pactwoven.native_memory_provenance_valid(v->'provenance') THEN RETURN false; END IF;
  IF source THEN
    RETURN coalesce(pactwoven.native_memory_object(v,ARRAY['schemaVersion','environment','organizationId','siteId','sourceId','revision','kind','status','contentDigest',
      'provenance','observedAt','validFrom','validUntil','access','conflict','verification'])
      AND v->>'kind' IN ('user_statement','document','provider_observation','verified_outcome') AND v->>'status' IN ('active','deleted','revoked')
      AND jsonb_typeof(v->'contentDigest')='string' AND v->>'contentDigest' ~ '^[a-f0-9]{64}$'
      AND pactwoven.native_memory_time(v->'observedAt') IS NOT NULL AND pactwoven.native_memory_time(v->'validFrom') IS NOT NULL
      AND pactwoven.native_memory_time(v->'validUntil')>pactwoven.native_memory_time(v->'observedAt')
      AND pactwoven.native_memory_time(v->'validUntil')>pactwoven.native_memory_time(v->'validFrom')
      AND pactwoven.native_memory_access_valid(v->'access') AND v->>'conflict' IN ('clear','unresolved') AND v->>'verification' IN ('unverified','verified'),false);
  END IF;
  IF NOT pactwoven.native_memory_object(v->'subject',ARRAY['kind','id']) OR coalesce(v#>>'{subject,kind}','') NOT IN ('supplier','site','preference','document','verified_outcome')
    OR NOT pactwoven.native_memory_id(v#>'{subject,id}') OR NOT pactwoven.native_memory_id(v->'key') OR pactwoven.native_memory_time(v->'recordedAt') IS NULL THEN RETURN false; END IF;
  IF v->'revision'='1'::jsonb THEN IF v->'previous' IS DISTINCT FROM 'null'::jsonb THEN RETURN false; END IF;
  ELSE
    r:=v->'previous';
    IF NOT pactwoven.native_memory_ref_valid(r) OR pactwoven.native_memory_scope(r)<>pactwoven.native_memory_scope(v)
      OR r->'memoryId'<>v->'memoryId' OR (r->>'revision')::bigint<>(v->>'revision')::bigint-1 THEN RETURN false; END IF;
  END IF;
  IF v->>'state'='tombstone' THEN RETURN v->'revision'<>'1'::jsonb AND v->>'reason' IN ('deleted','revoked') AND
    pactwoven.native_memory_object(v,ARRAY['schemaVersion','environment','organizationId','siteId','memoryId','revision','previous','subject','key','recordedAt','provenance','state','reason']);END IF;
  IF v->>'state' IS DISTINCT FROM 'active' OR NOT pactwoven.native_memory_object(v,ARRAY['schemaVersion','environment','organizationId','siteId','memoryId','revision',
    'previous','subject','key','recordedAt','provenance','state','content','access','validFrom','validUntil','confidence','conflict','inputs'])
    OR NOT pactwoven.native_memory_object(v->'content',ARRAY['title','summary','attributes'])
    OR NOT pactwoven.native_memory_text(v#>'{content,title}',1,180) OR NOT pactwoven.native_memory_text(v#>'{content,summary}',1,8000)
    OR v#>>'{content,title}' ~ U&'^[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]*$'
    OR v#>>'{content,summary}' ~ U&'^[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]*$'
    OR jsonb_typeof(v#>'{content,attributes}') IS DISTINCT FROM 'object' OR (SELECT count(*)>32 FROM jsonb_object_keys(v#>'{content,attributes}'))
    OR NOT pactwoven.native_memory_access_valid(v->'access') OR coalesce(v->>'confidence','') NOT IN ('low','medium','high') OR coalesce(v->>'conflict','') NOT IN ('clear','unresolved')
    OR pactwoven.native_memory_time(v->'validFrom') IS NULL OR pactwoven.native_memory_time(v->'validUntil') IS NULL OR pactwoven.native_memory_time(v->'validUntil')<=pactwoven.native_memory_time(v->'validFrom')
    OR pactwoven.native_memory_time(v->'validUntil')<=pactwoven.native_memory_time(v->'recordedAt')
    OR NOT pactwoven.native_memory_object(v->'inputs',ARRAY['sources','memories']) OR jsonb_typeof(v#>'{inputs,sources}')<>'array'
    OR jsonb_typeof(v#>'{inputs,memories}')<>'array' THEN RETURN false; END IF;
  FOR k,attr IN SELECT * FROM jsonb_each(v#>'{content,attributes}') LOOP
    IF k !~ '^[A-Za-z0-9_-]{1,128}$' OR NOT (jsonb_typeof(attr) IN ('boolean','null') OR pactwoven.native_memory_text(attr,0,2000) OR
      (jsonb_typeof(attr)='number' AND attr::text ~ '^-?(0|[1-9][0-9]{0,15})$' AND abs((attr::text)::numeric)<=9007199254740991)) THEN RETURN false;END IF;
  END LOOP;
  IF jsonb_array_length(v#>'{inputs,sources}')>32 OR jsonb_array_length(v#>'{inputs,memories}')>32
    OR jsonb_array_length(v#>'{inputs,sources}')+jsonb_array_length(v#>'{inputs,memories}')=0
    OR (SELECT count(*)<>count(DISTINCT x->>'sourceId') FROM jsonb_array_elements(v#>'{inputs,sources}') x)
    OR (SELECT count(*)<>count(DISTINCT x->>'memoryId') FROM jsonb_array_elements(v#>'{inputs,memories}') x) THEN RETURN false;END IF;
  FOR r IN SELECT x FROM jsonb_array_elements(v#>'{inputs,sources}') x LOOP
    IF NOT pactwoven.native_memory_ref_valid(r,true) OR pactwoven.native_memory_scope(r)<>pactwoven.native_memory_scope(v) THEN RETURN false;END IF;
  END LOOP;
  FOR r IN SELECT x FROM jsonb_array_elements(v#>'{inputs,memories}') x LOOP
    IF NOT pactwoven.native_memory_ref_valid(r) OR pactwoven.native_memory_scope(r)<>pactwoven.native_memory_scope(v) THEN RETURN false;END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;

CREATE TABLE pactwoven.native_memory_scope_fences (
  environment text NOT NULL,organization_id text NOT NULL,site_id text NOT NULL,generation bigint NOT NULL DEFAULT 1 CHECK(generation BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY(environment,organization_id,site_id),FOREIGN KEY(environment,organization_id,site_id) REFERENCES pactwoven.sites(environment,organization_id,id)
);
CREATE TABLE pactwoven.native_memory_revisions (
  environment text NOT NULL,organization_id text NOT NULL,site_id text NOT NULL,memory_id text NOT NULL,revision bigint NOT NULL,
  digest text NOT NULL,record jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(environment,organization_id,site_id,memory_id,revision),UNIQUE(environment,organization_id,site_id,memory_id,revision,digest),
  FOREIGN KEY(environment,organization_id,site_id) REFERENCES pactwoven.native_memory_scope_fences(environment,organization_id,site_id),
  CHECK(pactwoven.native_memory_record_valid(record) IS TRUE),CHECK(pactwoven.native_memory_ref(record)=jsonb_build_object('environment',environment,'organizationId',organization_id,
    'siteId',site_id,'memoryId',memory_id,'revision',revision,'digest',digest))
);
CREATE TABLE pactwoven.native_memory_heads (
  environment text NOT NULL,organization_id text NOT NULL,site_id text NOT NULL,memory_id text NOT NULL,revision bigint NOT NULL,digest text NOT NULL,state text NOT NULL CHECK(state IN ('active','tombstone')),
  PRIMARY KEY(environment,organization_id,site_id,memory_id),FOREIGN KEY(environment,organization_id,site_id,memory_id,revision,digest)
    REFERENCES pactwoven.native_memory_revisions(environment,organization_id,site_id,memory_id,revision,digest)
);
CREATE TABLE pactwoven.native_memory_source_revisions (
  environment text NOT NULL,organization_id text NOT NULL,site_id text NOT NULL,source_id text NOT NULL,revision bigint NOT NULL,digest text NOT NULL,record jsonb NOT NULL,
  previous_revision bigint,previous_digest text,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(environment,organization_id,site_id,source_id,revision),UNIQUE(environment,organization_id,site_id,source_id,revision,digest),
  FOREIGN KEY(environment,organization_id,site_id) REFERENCES pactwoven.native_memory_scope_fences(environment,organization_id,site_id),
  FOREIGN KEY(environment,organization_id,site_id,source_id,previous_revision,previous_digest)
    REFERENCES pactwoven.native_memory_source_revisions(environment,organization_id,site_id,source_id,revision,digest),
  CHECK((revision=1 AND previous_revision IS NULL AND previous_digest IS NULL) OR (revision>1 AND previous_revision=revision-1 AND previous_digest IS NOT NULL)),
  CHECK(pactwoven.native_memory_record_valid(record,true) IS TRUE),CHECK(pactwoven.native_memory_ref(record,true)=jsonb_build_object('environment',environment,'organizationId',organization_id,
    'siteId',site_id,'sourceId',source_id,'revision',revision,'digest',digest))
);
CREATE TABLE pactwoven.native_memory_source_heads (
  environment text NOT NULL,organization_id text NOT NULL,site_id text NOT NULL,source_id text NOT NULL,revision bigint NOT NULL,digest text NOT NULL,status text NOT NULL CHECK(status IN ('active','deleted','revoked')),
  PRIMARY KEY(environment,organization_id,site_id,source_id),FOREIGN KEY(environment,organization_id,site_id,source_id,revision,digest)
    REFERENCES pactwoven.native_memory_source_revisions(environment,organization_id,site_id,source_id,revision,digest)
);
CREATE TABLE pactwoven.native_memory_dependencies (
  environment text NOT NULL,organization_id text NOT NULL,site_id text NOT NULL,memory_id text NOT NULL,revision bigint NOT NULL,
  kind text NOT NULL CHECK(kind IN ('memory','source')),target_id text NOT NULL,target_revision bigint NOT NULL,target_digest text NOT NULL,
  PRIMARY KEY(environment,organization_id,site_id,memory_id,revision,kind,target_id),
  FOREIGN KEY(environment,organization_id,site_id,memory_id,revision) REFERENCES pactwoven.native_memory_revisions(environment,organization_id,site_id,memory_id,revision)
);
CREATE TABLE pactwoven.native_memory_requests (
  environment text NOT NULL,organization_id text NOT NULL,actor_id text NOT NULL,request_key text NOT NULL CHECK(request_key ~ '^[A-Za-z0-9_-]{16,128}$'),
  site_id text NOT NULL,kind text NOT NULL CHECK(kind IN ('source','memory')),request_digest text NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),original_reference jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(environment,organization_id,actor_id,request_key),
  FOREIGN KEY(environment,organization_id,actor_id) REFERENCES pactwoven.memberships(environment,organization_id,actor_id),
  FOREIGN KEY(environment,organization_id,site_id) REFERENCES pactwoven.native_memory_scope_fences(environment,organization_id,site_id)
);
CREATE TABLE pactwoven.native_memory_usages (
  id uuid PRIMARY KEY,environment text NOT NULL,organization_id text NOT NULL,site_id text NOT NULL,context jsonb NOT NULL,context_binding jsonb NOT NULL,
  selection jsonb NOT NULL,selection_digest text NOT NULL CHECK(selection_digest ~ '^[a-f0-9]{64}$'),scope_generation bigint NOT NULL,
  selected_at timestamptz NOT NULL,valid_until timestamptz NOT NULL CHECK(valid_until>selected_at),
  publication_digest text CHECK(publication_digest IS NULL OR publication_digest ~ '^[a-f0-9]{64}$'),published_at timestamptz,
  CHECK((publication_digest IS NULL)=(published_at IS NULL)),
  FOREIGN KEY(environment,organization_id,site_id) REFERENCES pactwoven.native_memory_scope_fences(environment,organization_id,site_id)
);
CREATE INDEX native_memory_usage_task_idx ON pactwoven.native_memory_usages(environment,organization_id,site_id,(context#>>'{usage,taskId}'),(context#>>'{usage,generation}'),(context#>>'{usage,handoffId}'));
CREATE TABLE pactwoven.native_memory_invalidation_outbox (
  environment text NOT NULL,organization_id text NOT NULL,site_id text NOT NULL,generation bigint NOT NULL,kind text NOT NULL CHECK(kind IN ('memory','source')),
  identity_id text NOT NULL,revision bigint NOT NULL,digest text NOT NULL,state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','complete')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(environment,organization_id,site_id,generation),
  FOREIGN KEY(environment,organization_id,site_id) REFERENCES pactwoven.native_memory_scope_fences(environment,organization_id,site_id)
);

CREATE FUNCTION pactwoven.native_memory_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN RAISE EXCEPTION USING ERRCODE='NM005',MESSAGE='Memory history and identities are retained';END $$;
CREATE FUNCTION pactwoven.native_memory_head_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE old_record jsonb;new_record jsonb;is_source boolean:=TG_TABLE_NAME='native_memory_source_heads';BEGIN
  IF TG_OP<>'INSERT' THEN
    PERFORM pactwoven.native_memory_require((to_jsonb(NEW)-ARRAY['revision','digest',CASE WHEN is_source THEN 'status' ELSE 'state' END])=
      (to_jsonb(OLD)-ARRAY['revision','digest',CASE WHEN is_source THEN 'status' ELSE 'state' END]) AND NEW.revision=OLD.revision+1,'NM005');
    PERFORM pactwoven.native_memory_require(CASE WHEN is_source THEN to_jsonb(OLD)->>'status'='active' ELSE to_jsonb(OLD)->>'state'='active' END,'NM005');
  ELSE PERFORM pactwoven.native_memory_require(NEW.revision=1,'NM005');END IF;
  IF is_source THEN
    SELECT record INTO new_record FROM pactwoven.native_memory_source_revisions WHERE (environment,organization_id,site_id,source_id,revision,digest)=
      (NEW.environment,NEW.organization_id,NEW.site_id,NEW.source_id,NEW.revision,NEW.digest);
    PERFORM pactwoven.native_memory_require(new_record IS NOT NULL AND new_record->>'status'=NEW.status,'NM009');
  ELSE
    SELECT record INTO new_record FROM pactwoven.native_memory_revisions WHERE (environment,organization_id,site_id,memory_id,revision,digest)=
      (NEW.environment,NEW.organization_id,NEW.site_id,NEW.memory_id,NEW.revision,NEW.digest);
    PERFORM pactwoven.native_memory_require(new_record IS NOT NULL AND new_record->>'state'=NEW.state,'NM009');
    IF TG_OP='UPDATE' THEN
      SELECT record INTO old_record FROM pactwoven.native_memory_revisions WHERE (environment,organization_id,site_id,memory_id,revision,digest)=
        (OLD.environment,OLD.organization_id,OLD.site_id,OLD.memory_id,OLD.revision,OLD.digest);
      PERFORM pactwoven.native_memory_require(new_record->'previous'=pactwoven.native_memory_ref(old_record) AND new_record->'subject'=old_record->'subject'
        AND new_record->'key'=old_record->'key','NM005');
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER native_memory_head_version BEFORE INSERT OR UPDATE ON pactwoven.native_memory_heads FOR EACH ROW EXECUTE FUNCTION pactwoven.native_memory_head_guard();
CREATE TRIGGER native_memory_source_head_version BEFORE INSERT OR UPDATE ON pactwoven.native_memory_source_heads FOR EACH ROW EXECUTE FUNCTION pactwoven.native_memory_head_guard();
CREATE FUNCTION pactwoven.native_memory_dependency_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE parent jsonb;ref jsonb;BEGIN
  IF NEW.kind='memory' THEN
    PERFORM 1 FROM pactwoven.native_memory_revisions WHERE (environment,organization_id,site_id,memory_id,revision,digest)=
      (NEW.environment,NEW.organization_id,NEW.site_id,NEW.target_id,NEW.target_revision,NEW.target_digest);
  ELSE
    PERFORM 1 FROM pactwoven.native_memory_source_revisions WHERE (environment,organization_id,site_id,source_id,revision,digest)=
      (NEW.environment,NEW.organization_id,NEW.site_id,NEW.target_id,NEW.target_revision,NEW.target_digest);
  END IF;
  PERFORM pactwoven.native_memory_require(FOUND,'NM009');
  SELECT record INTO parent FROM pactwoven.native_memory_revisions WHERE(environment,organization_id,site_id,memory_id,revision)=
    (NEW.environment,NEW.organization_id,NEW.site_id,NEW.memory_id,NEW.revision);
  ref:=jsonb_build_object('environment',NEW.environment,'organizationId',NEW.organization_id,'siteId',NEW.site_id,
    CASE WHEN NEW.kind='source' THEN 'sourceId' ELSE 'memoryId' END,NEW.target_id,'revision',NEW.target_revision,'digest',NEW.target_digest);
  PERFORM pactwoven.native_memory_require(parent#>ARRAY['inputs',CASE WHEN NEW.kind='source' THEN 'sources' ELSE 'memories' END] @> jsonb_build_array(ref),'NM009');RETURN NEW;
END $$;
CREATE TRIGGER native_memory_dependency_target BEFORE INSERT ON pactwoven.native_memory_dependencies FOR EACH ROW EXECUTE FUNCTION pactwoven.native_memory_dependency_guard();

CREATE FUNCTION pactwoven.native_memory_lock_scope(ctx jsonb,writing boolean) RETURNS bigint
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE version bigint;BEGIN
  PERFORM pactwoven.native_memory_require(current_setting('transaction_isolation')='read committed' AND pactwoven.native_memory_scope_valid(ctx),'NM001');
  IF writing THEN
    INSERT INTO pactwoven.native_memory_scope_fences(environment,organization_id,site_id) VALUES(ctx->>'environment',ctx->>'organizationId',ctx->>'siteId') ON CONFLICT DO NOTHING;
    SELECT generation INTO version FROM pactwoven.native_memory_scope_fences WHERE (environment,organization_id,site_id)=
      (ctx->>'environment',ctx->>'organizationId',ctx->>'siteId') FOR UPDATE;
  ELSE
    SELECT generation INTO version FROM pactwoven.native_memory_scope_fences WHERE (environment,organization_id,site_id)=
      (ctx->>'environment',ctx->>'organizationId',ctx->>'siteId') FOR SHARE;
  END IF;
  PERFORM pactwoven.native_memory_require(version IS NOT NULL,'NM002');
  PERFORM pactwoven.native_memory_require(ctx->'validUntil'='null'::jsonb OR pactwoven.native_memory_time(ctx->'validUntil')>clock_timestamp(),'NM008');RETURN version;
END $$;
CREATE FUNCTION pactwoven.native_memory_readable(record jsonb,ctx jsonb,observed text,at_time timestamptz) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
  PERFORM pactwoven.native_memory_require(pactwoven.native_memory_scope(record)=pactwoven.native_memory_scope(ctx)
    AND record#>'{access,readers}' @> jsonb_build_array(ctx->'reader') AND record#>'{access,purposes}' ? (ctx->>'purpose'),'NM001');
  PERFORM pactwoven.native_memory_require(record->>'conflict'='clear','NM006');
  PERFORM pactwoven.native_memory_require(pactwoven.native_memory_time(record->observed)<=at_time AND pactwoven.native_memory_time(record->'validFrom')<=at_time
    AND pactwoven.native_memory_time(record->'validUntil')>at_time,'NM008');
END $$;

-- Iterative postorder traversal visits each logical current head once, retains
-- complete typed closure and calculates subtree depth even for shared DAGs.
CREATE FUNCTION pactwoven.native_memory_evaluate_locked(ctx jsonb,root_ref jsonb,at_time timestamptz,structure_only boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE stack jsonb:=jsonb_build_array(jsonb_build_object('ref',root_ref,'expanded',false));cache jsonb:='{}';source_cache jsonb:='{}';visiting jsonb:='{}';
  frame jsonb;ref jsonb;r jsonb;child jsonb;cached jsonb;head_ref jsonb;closure jsonb;part jsonb;answer jsonb;source_record jsonb;
  e text:=ctx->>'environment';o text:=ctx->>'organizationId';s text:=ctx->>'siteId';id text;depth integer;deadline timestamptz;verified boolean;outcome boolean;memory_refs jsonb;source_refs jsonb;
BEGIN
  PERFORM pactwoven.native_memory_require(pactwoven.native_memory_ref_valid(root_ref) AND pactwoven.native_memory_scope(root_ref)=pactwoven.native_memory_scope(ctx),'NM004');
  WHILE jsonb_array_length(stack)>0 LOOP
    frame:=stack->(jsonb_array_length(stack)-1);ref:=frame->'ref';id:=ref->>'memoryId';
    IF NOT (frame->>'expanded')::boolean THEN
      SELECT v.record,pactwoven.native_memory_ref(v.record) INTO r,head_ref FROM pactwoven.native_memory_heads h JOIN pactwoven.native_memory_revisions v
        ON(v.environment,v.organization_id,v.site_id,v.memory_id,v.revision,v.digest)=(h.environment,h.organization_id,h.site_id,h.memory_id,h.revision,h.digest)
        WHERE(h.environment,h.organization_id,h.site_id,h.memory_id)=(e,o,s,id);
      PERFORM pactwoven.native_memory_require(r IS NOT NULL AND head_ref=ref,'NM005');
      PERFORM pactwoven.native_memory_require(r->>'state'='active','NM006');IF NOT structure_only THEN PERFORM pactwoven.native_memory_readable(r,ctx,'recordedAt',at_time);END IF;
      IF cache ? id THEN stack:=stack-(jsonb_array_length(stack)-1);CONTINUE;END IF;
      PERFORM pactwoven.native_memory_require(NOT visiting ? id,'NM007');visiting:=visiting||jsonb_build_object(id,true);
      PERFORM pactwoven.native_memory_require((SELECT count(*) FROM jsonb_object_keys(visiting))+(SELECT count(*) FROM jsonb_object_keys(cache))+
        (SELECT count(*) FROM jsonb_object_keys(source_cache))<=128,'NM007');
      stack:=jsonb_set(stack,ARRAY[(jsonb_array_length(stack)-1)::text],jsonb_build_object('ref',ref,'expanded',true,'record',r));
      FOR child IN SELECT x FROM jsonb_array_elements(r#>'{inputs,memories}') x LOOP stack:=stack||jsonb_build_array(jsonb_build_object('ref',child,'expanded',false));END LOOP;
    ELSE
      r:=frame->'record';closure:=jsonb_build_object('memory:'||id,ref);depth:=1;deadline:=pactwoven.native_memory_time(r->'validUntil');verified:=true;outcome:=false;
      FOR child IN SELECT x FROM jsonb_array_elements(r#>'{inputs,memories}') x LOOP
        cached:=cache->(child->>'memoryId');PERFORM pactwoven.native_memory_require(cached IS NOT NULL,'NM009');
        closure:=closure||(cached->'closure');depth:=greatest(depth,1+(cached->>'depth')::integer);deadline:=least(deadline,(cached->>'deadline')::timestamptz);
        verified:=verified AND (cached->>'verified')::boolean;outcome:=outcome OR (cached->>'outcome')::boolean;
      END LOOP;
      FOR child IN SELECT x FROM jsonb_array_elements(r#>'{inputs,sources}') x LOOP
        SELECT v.record,pactwoven.native_memory_ref(v.record,true) INTO source_record,head_ref FROM pactwoven.native_memory_source_heads h JOIN pactwoven.native_memory_source_revisions v
          ON(v.environment,v.organization_id,v.site_id,v.source_id,v.revision,v.digest)=(h.environment,h.organization_id,h.site_id,h.source_id,h.revision,h.digest)
          WHERE(h.environment,h.organization_id,h.site_id,h.source_id)=(e,o,s,child->>'sourceId');
        PERFORM pactwoven.native_memory_require(source_record IS NOT NULL AND head_ref=child,'NM005');
        PERFORM pactwoven.native_memory_require(source_record->>'status'='active','NM006');IF NOT structure_only THEN PERFORM pactwoven.native_memory_readable(source_record,ctx,'observedAt',at_time);END IF;
        source_cache:=source_cache||jsonb_build_object(child->>'sourceId',true);closure:=closure||jsonb_build_object('source:'||(child->>'sourceId'),child);
        deadline:=least(deadline,pactwoven.native_memory_time(source_record->'validUntil'));verified:=verified AND source_record->>'verification'='verified';
        outcome:=outcome OR source_record->>'kind'='verified_outcome';
      END LOOP;
      PERFORM pactwoven.native_memory_require(depth<=16 AND (SELECT count(*) FROM jsonb_object_keys(closure))<=128,'NM007');
      IF NOT structure_only THEN PERFORM pactwoven.native_memory_require(r#>>'{subject,kind}'<>'verified_outcome' OR (verified AND outcome),'NM006');END IF;
      cache:=cache||jsonb_build_object(id,jsonb_build_object('closure',closure,'depth',depth,'deadline',pactwoven.native_memory_instant(deadline),'verified',verified,'outcome',outcome));
      visiting:=visiting-id;stack:=stack-(jsonb_array_length(stack)-1);
    END IF;
  END LOOP;
  cached:=cache->(root_ref->>'memoryId');
  SELECT coalesce(jsonb_agg(value ORDER BY pactwoven.native_memory_canonical(value) COLLATE "C"),'[]') INTO memory_refs FROM jsonb_each(cached->'closure') WHERE key LIKE 'memory:%';
  SELECT coalesce(jsonb_agg(value ORDER BY pactwoven.native_memory_canonical(value) COLLATE "C"),'[]') INTO source_refs FROM jsonb_each(cached->'closure') WHERE key LIKE 'source:%';
  PERFORM pactwoven.native_memory_require(jsonb_array_length(source_refs)>0,'NM009');
  SELECT record INTO r FROM pactwoven.native_memory_revisions WHERE(environment,organization_id,site_id,memory_id,revision,digest)=
    (e,o,s,root_ref->>'memoryId',(root_ref->>'revision')::bigint,root_ref->>'digest');
  answer:=jsonb_build_object('schemaVersion',1,'context',ctx,'root',root_ref,'memories',memory_refs,'sources',source_refs,
    'selectedAt',pactwoven.native_memory_instant(at_time),'validUntil',cached->>'deadline');
  RETURN jsonb_build_object('selection',answer,'memory',jsonb_build_object('reference',root_ref,'content',r->'content','confidence',r->'confidence','provenance',r->'provenance'));
END $$;

CREATE FUNCTION pactwoven.native_memory_data_context(ctx jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT pactwoven.native_memory_scope(ctx)||jsonb_build_object('reader',ctx->'reader','purpose',ctx->'purpose','usage',ctx->'usage') $$;
CREATE FUNCTION pactwoven.native_memory_select_locked(ctx jsonb,reference jsonb,authority_until timestamptz) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE generation bigint;at_time timestamptz;result jsonb;selection jsonb;digest text;usage_id uuid:=gen_random_uuid();BEGIN
  generation:=pactwoven.native_memory_lock_scope(ctx,false);at_time:=date_trunc('milliseconds',clock_timestamp());
  PERFORM pactwoven.native_memory_require(authority_until IS NULL OR authority_until>clock_timestamp(),'NM008');
  result:=pactwoven.native_memory_evaluate_locked(pactwoven.native_memory_data_context(ctx),reference,at_time);selection:=result->'selection';
  digest:=pactwoven.native_memory_hash(jsonb_build_object('namespace','pactwoven/native-memory-selection/v1','selection',selection));
  IF ctx#>>'{usage,kind}'='task' THEN PERFORM pactwoven.native_memory_require((SELECT count(*) FROM pactwoven.native_memory_usages WHERE
    (environment,organization_id,site_id)=(ctx->>'environment',ctx->>'organizationId',ctx->>'siteId') AND context->'usage'=ctx->'usage')<128,'NM007');END IF;
  INSERT INTO pactwoven.native_memory_usages(id,environment,organization_id,site_id,context,context_binding,selection,selection_digest,scope_generation,selected_at,valid_until)
    VALUES(usage_id,ctx->>'environment',ctx->>'organizationId',ctx->>'siteId',pactwoven.native_memory_data_context(ctx),ctx-'validUntil',selection,digest,generation,at_time,pactwoven.native_memory_time(selection->'validUntil'));
  PERFORM pactwoven.native_memory_require(pactwoven.native_memory_time(selection->'validUntil')>clock_timestamp() AND (authority_until IS NULL OR authority_until>clock_timestamp()),'NM008');
  RETURN jsonb_build_object('usageId',usage_id,'receipt',jsonb_build_object('selection',selection,'digest',digest),'memory',result->'memory','observedAt',pactwoven.native_memory_instant(at_time),
    'validUntil',pactwoven.native_memory_instant(least(pactwoven.native_memory_time(selection->'validUntil'),authority_until)));
END $$;

CREATE FUNCTION pactwoven.native_memory_assert_usage_locked(p_environment text,ctx jsonb,usage_refs jsonb,publication_digest text) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE u pactwoven.native_memory_usages;actual jsonb;expected jsonb;current_selection jsonb;until_time timestamptz;data_until timestamptz;at_time timestamptz;BEGIN
  PERFORM pactwoven.native_memory_require(ctx->>'environment'=p_environment AND ctx#>>'{usage,kind}'='task' AND publication_digest ~ '^[a-f0-9]{64}$'
    AND jsonb_typeof(usage_refs)='array' AND jsonb_array_length(usage_refs)<=128,'NM004');
  PERFORM pactwoven.native_memory_require(NOT EXISTS(SELECT 1 FROM jsonb_array_elements(usage_refs) x WHERE
    NOT pactwoven.native_memory_object(x,ARRAY['usageId','selectionDigest']) OR coalesce(x->>'usageId','') !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
    OR coalesce(x->>'selectionDigest','') !~ '^[a-f0-9]{64}$') AND (SELECT count(*)=count(DISTINCT x->>'usageId') FROM jsonb_array_elements(usage_refs) x),'NM004');
  SELECT coalesce(jsonb_agg(jsonb_build_object('usageId',id,'selectionDigest',selection_digest) ORDER BY id),'[]') INTO actual
    FROM pactwoven.native_memory_usages WHERE (environment,organization_id,site_id)=(p_environment,ctx->>'organizationId',ctx->>'siteId')
      AND context->'usage'=ctx->'usage';
  SELECT coalesce(jsonb_agg(x ORDER BY x->>'usageId'),'[]') INTO expected FROM jsonb_array_elements(usage_refs) x;
  PERFORM pactwoven.native_memory_require(actual=expected,'NM005');
  until_time:=pactwoven.native_memory_time(ctx->'validUntil');PERFORM pactwoven.native_memory_require(until_time>clock_timestamp(),'NM008');
  IF jsonb_array_length(actual)=0 THEN RETURN jsonb_build_object('validUntil',ctx->'validUntil','dataValidUntil',NULL,'usageCount',0);END IF;
  PERFORM pactwoven.native_memory_lock_scope(ctx,false);at_time:=date_trunc('milliseconds',clock_timestamp());
  FOR u IN SELECT * FROM pactwoven.native_memory_usages WHERE (environment,organization_id,site_id)=(p_environment,ctx->>'organizationId',ctx->>'siteId')
      AND context->'usage'=ctx->'usage' ORDER BY id FOR UPDATE LOOP
    PERFORM pactwoven.native_memory_require(u.context_binding=ctx-'validUntil' AND (u.publication_digest IS NULL OR u.publication_digest=publication_digest),'NM005');
    current_selection:=pactwoven.native_memory_evaluate_locked(u.context,u.selection->'root',at_time)->'selection';
    PERFORM pactwoven.native_memory_require(u.selection=jsonb_set(current_selection,'{selectedAt}',u.selection->'selectedAt') AND u.valid_until>clock_timestamp(),'NM008');
    until_time:=least(until_time,u.valid_until);data_until:=least(data_until,u.valid_until);
  END LOOP;
  PERFORM pactwoven.native_memory_require(until_time>clock_timestamp(),'NM008');RETURN jsonb_build_object('validUntil',pactwoven.native_memory_instant(until_time),'dataValidUntil',pactwoven.native_memory_instant(data_until),'usageCount',jsonb_array_length(actual));
END $$;
CREATE FUNCTION pactwoven.native_memory_bind_artifact_locked(p_environment text,ctx jsonb,usage_refs jsonb,publication_digest text) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE checked jsonb;BEGIN
  checked:=pactwoven.native_memory_assert_usage_locked(p_environment,ctx,usage_refs,publication_digest);
  UPDATE pactwoven.native_memory_usages SET publication_digest=native_memory_bind_artifact_locked.publication_digest,published_at=coalesce(published_at,clock_timestamp())
    WHERE (environment,organization_id,site_id)=(p_environment,ctx->>'organizationId',ctx->>'siteId') AND context->'usage'=ctx->'usage';
  PERFORM pactwoven.native_memory_require(pactwoven.native_memory_time(checked->'validUntil')>clock_timestamp(),'NM008');RETURN checked;
END $$;

CREATE FUNCTION pactwoven.native_memory_human_read(p_actor jsonb,q jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE ctx jsonb;BEGIN
  PERFORM pactwoven.native_memory_require(pactwoven.native_memory_object(q,ARRAY['reference','requestId','purpose']) AND pactwoven.native_memory_ref_valid(q->'reference')
    AND pactwoven.native_memory_id(q->'requestId') AND q->>'purpose' IN ('human_review','audit'),'NM004');
  ctx:=pactwoven.native_delegation_actor_locked(p_actor,q#>>'{reference,siteId}',false);
  PERFORM pactwoven.native_memory_require(pactwoven.native_memory_scope(ctx)=pactwoven.native_memory_scope(q->'reference'),'NM001');
  IF q->>'purpose'='audit' THEN PERFORM pactwoven.native_memory_require(ctx->'roles' ?| ARRAY['owner','auditor'],'NM001');END IF;
  ctx:=ctx||jsonb_build_object('purpose',q->'purpose','usage',jsonb_build_object('kind','request','requestId',q->'requestId'));
  RETURN pactwoven.native_memory_select_locked(ctx,q->'reference',pactwoven.native_memory_time(ctx->'validUntil'));
END $$;
CREATE FUNCTION pactwoven.native_memory_task_read(p_environment text,p_selector jsonb,p_reference jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE ctx jsonb;BEGIN
  ctx:=pactwoven.native_delegation_task_context_locked(p_environment,p_selector,'memory_read');
  PERFORM pactwoven.native_memory_require(ctx->>'purpose'='task_context' AND ctx#>>'{reader,kind}'='agent' AND ctx#>>'{usage,handoffId}' IS NOT NULL,'NM001');
  RETURN pactwoven.native_memory_select_locked(ctx,p_reference,pactwoven.native_memory_time(ctx->'validUntil'));
END $$;

-- Recovery returns an immutable reference and current availability only. It
-- never replays a historical body whose head/ACL may have changed meanwhile.
CREATE FUNCTION pactwoven.native_memory_recovery_locked(ctx jsonb,saved pactwoven.native_memory_requests) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE r jsonb;ref jsonb;available boolean:=false;BEGIN
  PERFORM pactwoven.native_memory_require(ctx->'validUntil'='null'::jsonb OR pactwoven.native_memory_time(ctx->'validUntil')>clock_timestamp(),'NM008');
  IF saved.kind='source' THEN
    SELECT v.record INTO r FROM pactwoven.native_memory_source_heads h JOIN pactwoven.native_memory_source_revisions v
      USING(environment,organization_id,site_id,source_id,revision,digest)
      WHERE(h.environment,h.organization_id,h.site_id,h.source_id)=(saved.environment,saved.organization_id,saved.site_id,saved.original_reference->>'sourceId');
    IF r IS NOT NULL THEN ref:=pactwoven.native_memory_ref(r,true);available:=r->>'status'='active';END IF;
  ELSE
    SELECT v.record INTO r FROM pactwoven.native_memory_heads h JOIN pactwoven.native_memory_revisions v
      USING(environment,organization_id,site_id,memory_id,revision,digest)
      WHERE(h.environment,h.organization_id,h.site_id,h.memory_id)=(saved.environment,saved.organization_id,saved.site_id,saved.original_reference->>'memoryId');
    IF r IS NOT NULL THEN ref:=pactwoven.native_memory_ref(r);available:=r->>'state'='active';END IF;
  END IF;
  -- Do not disclose a changed head reference or current metadata to an actor
  -- excluded by its new ACL. The original receipt alone remains recoverable.
  IF NOT coalesce(available AND r#>'{access,readers}' @> jsonb_build_array(ctx->'reader'),false) THEN
    RETURN jsonb_build_object('kind',saved.kind,'originalReference',saved.original_reference,'currentReference',NULL,'availability','unavailable');
  END IF;
  RETURN jsonb_build_object('kind',saved.kind,'originalReference',saved.original_reference,'currentReference',ref,
    'availability',CASE WHEN ref<>saved.original_reference THEN 'superseded' WHEN r->>'conflict'<>'clear' OR
      pactwoven.native_memory_time(r->'validFrom')>clock_timestamp() OR pactwoven.native_memory_time(r->'validUntil')<=clock_timestamp() THEN 'unavailable' ELSE 'current' END);
END $$;
CREATE FUNCTION pactwoven.native_memory_human_recover(p_actor jsonb,p_site text,p_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE ctx jsonb;saved pactwoven.native_memory_requests;BEGIN
  PERFORM pactwoven.native_memory_require(p_key ~ '^[A-Za-z0-9_-]{16,128}$' AND pactwoven.native_memory_id(to_jsonb(p_site)),'NM004');
  ctx:=pactwoven.native_delegation_actor_locked(p_actor,p_site,false);
  PERFORM pactwoven.native_memory_lock_scope(ctx,false);
  SELECT * INTO saved FROM pactwoven.native_memory_requests WHERE(environment,organization_id,actor_id,site_id,request_key)=
    (ctx->>'environment',ctx->>'organizationId',ctx->>'actorId',p_site,p_key);
  IF NOT FOUND THEN RETURN NULL;END IF;
  RETURN pactwoven.native_memory_recovery_locked(ctx,saved);
END $$;
CREATE FUNCTION pactwoven.native_memory_advance_locked(ctx jsonb,kind text,ref jsonb) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE next_generation bigint;BEGIN
  UPDATE pactwoven.native_memory_scope_fences SET generation=generation+1 WHERE(environment,organization_id,site_id)=
    (ctx->>'environment',ctx->>'organizationId',ctx->>'siteId') RETURNING generation INTO next_generation;
  INSERT INTO pactwoven.native_memory_invalidation_outbox(environment,organization_id,site_id,generation,kind,identity_id,revision,digest)
    VALUES(ctx->>'environment',ctx->>'organizationId',ctx->>'siteId',next_generation,kind,
      ref->>CASE WHEN kind='source' THEN 'sourceId' ELSE 'memoryId' END,(ref->>'revision')::bigint,ref->>'digest');
END $$;
CREATE FUNCTION pactwoven.native_memory_human_source(p_actor jsonb,p_key text,q jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE ctx jsonb;r jsonb:=q->'record';old_record jsonb;old_ref jsonb;ref jsonb;request_digest text;saved pactwoven.native_memory_requests;BEGIN
  PERFORM pactwoven.native_memory_require(p_key ~ '^[A-Za-z0-9_-]{16,128}$' AND octet_length(q::text)<=524288
    AND pactwoven.native_memory_object(q,ARRAY['kind','expected','record']) AND q->>'kind' IN ('create','correct','delete')
    AND pactwoven.native_memory_record_valid(r,true),'NM004');
  ctx:=pactwoven.native_delegation_actor_locked(p_actor,r->>'siteId',true);
  PERFORM pactwoven.native_memory_require(pactwoven.native_memory_scope(r)=pactwoven.native_memory_scope(ctx)
    AND r->'provenance'=jsonb_build_object('kind','user','actorId',ctx->>'actorId')
    AND r->>'kind'='user_statement' AND r->>'verification'='unverified','NM001');
  PERFORM pactwoven.native_memory_lock_scope(ctx,true);
  request_digest:=pactwoven.native_memory_hash(jsonb_build_object('namespace','pactwoven/native-memory-source-request/v1','request',q));
  SELECT * INTO saved FROM pactwoven.native_memory_requests WHERE(environment,organization_id,actor_id,request_key)=
    (ctx->>'environment',ctx->>'organizationId',ctx->>'actorId',p_key);
  IF FOUND THEN
    PERFORM pactwoven.native_memory_require(saved.kind='source' AND saved.site_id=ctx->>'siteId' AND saved.request_digest=request_digest,'NM003');
    RETURN pactwoven.native_memory_recovery_locked(ctx,saved);
  END IF;
  SELECT v.record INTO old_record FROM pactwoven.native_memory_source_heads h JOIN pactwoven.native_memory_source_revisions v
    USING(environment,organization_id,site_id,source_id,revision,digest)
    WHERE(h.environment,h.organization_id,h.site_id,h.source_id)=(ctx->>'environment',ctx->>'organizationId',ctx->>'siteId',r->>'sourceId');
  IF q->>'kind'='create' THEN
    PERFORM pactwoven.native_memory_require(old_record IS NULL AND q->'expected'='null'::jsonb AND r->'revision'='1'::jsonb AND r->>'status'='active','NM005');
  ELSE
    PERFORM pactwoven.native_memory_require(old_record IS NOT NULL AND old_record->>'status'='active','NM005');
    old_ref:=pactwoven.native_memory_ref(old_record,true);
    PERFORM pactwoven.native_memory_require(q->'expected'=old_ref AND (r->>'revision')::bigint=(old_record->>'revision')::bigint+1
      AND old_record->>'kind'='user_statement' AND old_record->>'verification'='unverified'
      AND ((q->>'kind'='delete')=(r->>'status' IN ('deleted','revoked'))),'NM005');
    PERFORM pactwoven.native_memory_require(old_record#>'{access,readers}' @> jsonb_build_array(ctx->'reader'),'NM001');
  END IF;
  IF q->>'kind'='delete' THEN
    -- Keep the original observed chronology on terminal descriptors; deletion
    -- cannot relabel an observation or elevate its verification.
    PERFORM pactwoven.native_memory_require((r-ARRAY['revision','status','provenance'])=(old_record-ARRAY['revision','status','provenance']),'NM004');
  ELSE
    r:=jsonb_set(r,'{observedAt}',to_jsonb(pactwoven.native_memory_instant(date_trunc('milliseconds',clock_timestamp()))));
    PERFORM pactwoven.native_memory_require(r#>'{access,readers}' @> jsonb_build_array(ctx->'reader'),'NM001');
  END IF;
  PERFORM pactwoven.native_memory_require(pactwoven.native_memory_record_valid(r,true),'NM004');ref:=pactwoven.native_memory_ref(r,true);
  INSERT INTO pactwoven.native_memory_source_revisions(environment,organization_id,site_id,source_id,revision,digest,record,previous_revision,previous_digest)
    VALUES(ctx->>'environment',ctx->>'organizationId',ctx->>'siteId',r->>'sourceId',(r->>'revision')::bigint,ref->>'digest',r,(old_ref->>'revision')::bigint,old_ref->>'digest');
  IF old_record IS NULL THEN
  INSERT INTO pactwoven.native_memory_source_heads(environment,organization_id,site_id,source_id,revision,digest,status)
    VALUES(ctx->>'environment',ctx->>'organizationId',ctx->>'siteId',r->>'sourceId',(r->>'revision')::bigint,ref->>'digest',r->>'status');
  ELSE
    UPDATE pactwoven.native_memory_source_heads SET revision=(r->>'revision')::bigint,digest=ref->>'digest',status=r->>'status'
      WHERE(environment,organization_id,site_id,source_id)=(ctx->>'environment',ctx->>'organizationId',ctx->>'siteId',r->>'sourceId');
  END IF;
  PERFORM pactwoven.native_memory_advance_locked(ctx,'source',ref);
  INSERT INTO pactwoven.native_memory_requests(environment,organization_id,actor_id,request_key,site_id,kind,request_digest,original_reference)
    VALUES(ctx->>'environment',ctx->>'organizationId',ctx->>'actorId',p_key,ctx->>'siteId','source',request_digest,ref) RETURNING * INTO saved;
  RETURN pactwoven.native_memory_recovery_locked(ctx,saved);
END $$;
CREATE FUNCTION pactwoven.native_memory_human_mutate(p_actor jsonb,p_key text,q jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE ctx jsonb;r jsonb:=q->'record';old_record jsonb;old_ref jsonb;ref jsonb;request_digest text;saved pactwoven.native_memory_requests;dep jsonb;dep_record jsonb;BEGIN
  PERFORM pactwoven.native_memory_require(p_key ~ '^[A-Za-z0-9_-]{16,128}$' AND octet_length(q::text)<=524288
    AND pactwoven.native_memory_object(q,ARRAY['kind','expected','record']) AND q->>'kind' IN ('create','correct','delete')
    AND pactwoven.native_memory_record_valid(r),'NM004');
  ctx:=pactwoven.native_delegation_actor_locked(p_actor,r->>'siteId',true);
  PERFORM pactwoven.native_memory_require(pactwoven.native_memory_scope(r)=pactwoven.native_memory_scope(ctx)
    AND r->'provenance'=jsonb_build_object('kind','user','actorId',ctx->>'actorId'),'NM001');
  PERFORM pactwoven.native_memory_lock_scope(ctx,true);
  request_digest:=pactwoven.native_memory_hash(jsonb_build_object('namespace','pactwoven/native-memory-request/v1','request',q));
  SELECT * INTO saved FROM pactwoven.native_memory_requests WHERE(environment,organization_id,actor_id,request_key)=
    (ctx->>'environment',ctx->>'organizationId',ctx->>'actorId',p_key);
  IF FOUND THEN
    PERFORM pactwoven.native_memory_require(saved.kind='memory' AND saved.site_id=ctx->>'siteId' AND saved.request_digest=request_digest,'NM003');
    RETURN pactwoven.native_memory_recovery_locked(ctx,saved);
  END IF;
  SELECT v.record INTO old_record FROM pactwoven.native_memory_heads h JOIN pactwoven.native_memory_revisions v
    USING(environment,organization_id,site_id,memory_id,revision,digest)
    WHERE(h.environment,h.organization_id,h.site_id,h.memory_id)=(ctx->>'environment',ctx->>'organizationId',ctx->>'siteId',r->>'memoryId');
  IF q->>'kind'='create' THEN
    PERFORM pactwoven.native_memory_require(old_record IS NULL AND q->'expected'='null'::jsonb AND r->'revision'='1'::jsonb AND r->>'state'='active','NM005');
  ELSE
    PERFORM pactwoven.native_memory_require(old_record IS NOT NULL AND old_record->>'state'='active','NM005');old_ref:=pactwoven.native_memory_ref(old_record);
    PERFORM pactwoven.native_memory_require(q->'expected'=old_ref AND r->'previous'=old_ref AND (r->>'revision')::bigint=(old_record->>'revision')::bigint+1
      AND r->'subject'=old_record->'subject' AND r->'key'=old_record->'key' AND ((q->>'kind'='delete')=(r->>'state'='tombstone')),'NM005');
    PERFORM pactwoven.native_memory_require(old_record#>'{access,readers}' @> jsonb_build_array(ctx->'reader'),'NM001');
  END IF;
  r:=jsonb_set(r,'{recordedAt}',to_jsonb(pactwoven.native_memory_instant(date_trunc('milliseconds',clock_timestamp()))));
  PERFORM pactwoven.native_memory_require(pactwoven.native_memory_record_valid(r),'NM004');
  IF r->>'state'='active' THEN
    PERFORM pactwoven.native_memory_require(r#>'{access,readers}' @> jsonb_build_array(ctx->'reader'),'NM001');
    FOR dep IN SELECT x FROM jsonb_array_elements(r#>'{inputs,sources}') x LOOP
      SELECT v.record INTO dep_record FROM pactwoven.native_memory_source_heads h JOIN pactwoven.native_memory_source_revisions v
        USING(environment,organization_id,site_id,source_id,revision,digest)
        WHERE(h.environment,h.organization_id,h.site_id,h.source_id,h.revision,h.digest)=
          (ctx->>'environment',ctx->>'organizationId',ctx->>'siteId',dep->>'sourceId',(dep->>'revision')::bigint,dep->>'digest')
          AND pactwoven.native_memory_ref(v.record,true)=dep;
      PERFORM pactwoven.native_memory_require(dep_record IS NOT NULL AND dep_record->>'status'='active','NM005');
      PERFORM pactwoven.native_memory_require(dep_record#>'{access,readers}' @> jsonb_build_array(ctx->'reader'),'NM001');
    END LOOP;
    FOR dep IN SELECT x FROM jsonb_array_elements(r#>'{inputs,memories}') x LOOP
      PERFORM pactwoven.native_memory_require(dep->>'memoryId'<>r->>'memoryId','NM007');
      SELECT v.record INTO dep_record FROM pactwoven.native_memory_heads h JOIN pactwoven.native_memory_revisions v
        USING(environment,organization_id,site_id,memory_id,revision,digest)
        WHERE(h.environment,h.organization_id,h.site_id,h.memory_id,h.revision,h.digest)=
          (ctx->>'environment',ctx->>'organizationId',ctx->>'siteId',dep->>'memoryId',(dep->>'revision')::bigint,dep->>'digest')
          AND pactwoven.native_memory_ref(v.record)=dep;
      PERFORM pactwoven.native_memory_require(dep_record IS NOT NULL AND dep_record->>'state'='active','NM005');
      PERFORM pactwoven.native_memory_require(dep_record#>'{access,readers}' @> jsonb_build_array(ctx->'reader'),'NM001');
    END LOOP;
  END IF;
  ref:=pactwoven.native_memory_ref(r);
  INSERT INTO pactwoven.native_memory_revisions(environment,organization_id,site_id,memory_id,revision,digest,record)
    VALUES(ctx->>'environment',ctx->>'organizationId',ctx->>'siteId',r->>'memoryId',(r->>'revision')::bigint,ref->>'digest',r);
  IF r->>'state'='active' THEN
    INSERT INTO pactwoven.native_memory_dependencies(environment,organization_id,site_id,memory_id,revision,kind,target_id,target_revision,target_digest)
      SELECT ctx->>'environment',ctx->>'organizationId',ctx->>'siteId',r->>'memoryId',(r->>'revision')::bigint,'source',x->>'sourceId',(x->>'revision')::bigint,x->>'digest'
      FROM jsonb_array_elements(r#>'{inputs,sources}') x;
    INSERT INTO pactwoven.native_memory_dependencies(environment,organization_id,site_id,memory_id,revision,kind,target_id,target_revision,target_digest)
      SELECT ctx->>'environment',ctx->>'organizationId',ctx->>'siteId',r->>'memoryId',(r->>'revision')::bigint,'memory',x->>'memoryId',(x->>'revision')::bigint,x->>'digest'
      FROM jsonb_array_elements(r#>'{inputs,memories}') x;
  END IF;
  IF old_record IS NULL THEN
  INSERT INTO pactwoven.native_memory_heads(environment,organization_id,site_id,memory_id,revision,digest,state)
    VALUES(ctx->>'environment',ctx->>'organizationId',ctx->>'siteId',r->>'memoryId',(r->>'revision')::bigint,ref->>'digest',r->>'state');
  ELSE
    UPDATE pactwoven.native_memory_heads SET revision=(r->>'revision')::bigint,digest=ref->>'digest',state=r->>'state'
      WHERE(environment,organization_id,site_id,memory_id)=(ctx->>'environment',ctx->>'organizationId',ctx->>'siteId',r->>'memoryId');
  END IF;
  IF r->>'state'='active' THEN PERFORM pactwoven.native_memory_evaluate_locked(pactwoven.native_memory_data_context(ctx),ref,clock_timestamp(),true);END IF;
  PERFORM pactwoven.native_memory_advance_locked(ctx,'memory',ref);
  INSERT INTO pactwoven.native_memory_requests(environment,organization_id,actor_id,request_key,site_id,kind,request_digest,original_reference)
    VALUES(ctx->>'environment',ctx->>'organizationId',ctx->>'actorId',p_key,ctx->>'siteId','memory',request_digest,ref) RETURNING * INTO saved;
  RETURN pactwoven.native_memory_recovery_locked(ctx,saved);
END $$;

CREATE FUNCTION pactwoven.native_memory_history_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE r jsonb;prior jsonb;actual jsonb;expected jsonb;head_revision bigint;BEGIN
  IF TG_TABLE_NAME='native_memory_source_revisions' THEN
    SELECT revision INTO head_revision FROM pactwoven.native_memory_source_heads WHERE(environment,organization_id,site_id,source_id)=
      (NEW.environment,NEW.organization_id,NEW.site_id,NEW.source_id);
    PERFORM pactwoven.native_memory_require(head_revision>=NEW.revision,'NM009');
  ELSE
    r:=NEW.record;
    SELECT revision INTO head_revision FROM pactwoven.native_memory_heads WHERE(environment,organization_id,site_id,memory_id)=
      (NEW.environment,NEW.organization_id,NEW.site_id,NEW.memory_id);
    PERFORM pactwoven.native_memory_require(head_revision>=NEW.revision,'NM009');
    IF NEW.revision>1 THEN
      SELECT record INTO prior FROM pactwoven.native_memory_revisions WHERE(environment,organization_id,site_id,memory_id,revision)=
        (NEW.environment,NEW.organization_id,NEW.site_id,NEW.memory_id,NEW.revision-1);
      PERFORM pactwoven.native_memory_require(prior->>'state'='active' AND r->'previous'=pactwoven.native_memory_ref(prior)
        AND r->'subject'=prior->'subject' AND r->'key'=prior->'key' AND pactwoven.native_memory_time(r->'recordedAt')>=pactwoven.native_memory_time(prior->'recordedAt'),'NM009');
    END IF;
    SELECT coalesce(jsonb_agg(jsonb_build_object('kind',kind,'id',target_id,'revision',target_revision,'digest',target_digest) ORDER BY kind,target_id),'[]') INTO actual
      FROM pactwoven.native_memory_dependencies WHERE(environment,organization_id,site_id,memory_id,revision)=
        (NEW.environment,NEW.organization_id,NEW.site_id,NEW.memory_id,NEW.revision);
    SELECT coalesce(jsonb_agg(x ORDER BY x->>'kind',x->>'id'),'[]') INTO expected FROM (
      SELECT jsonb_build_object('kind','source','id',x->>'sourceId','revision',x->'revision','digest',x->>'digest') x FROM jsonb_array_elements(coalesce(r#>'{inputs,sources}','[]')) x
      UNION ALL SELECT jsonb_build_object('kind','memory','id',x->>'memoryId','revision',x->'revision','digest',x->>'digest') FROM jsonb_array_elements(coalesce(r#>'{inputs,memories}','[]')) x) q;
    PERFORM pactwoven.native_memory_require(actual=expected,'NM009');
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER native_memory_history_complete AFTER INSERT ON pactwoven.native_memory_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pactwoven.native_memory_history_guard();
CREATE CONSTRAINT TRIGGER native_memory_source_history_complete AFTER INSERT ON pactwoven.native_memory_source_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pactwoven.native_memory_history_guard();
CREATE FUNCTION pactwoven.native_memory_usage_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
  IF TG_OP='INSERT' THEN
    PERFORM pactwoven.native_memory_require(NEW.publication_digest IS NULL AND NEW.published_at IS NULL
      AND NEW.context=pactwoven.native_memory_data_context(NEW.context_binding) AND NEW.selection->'context'=NEW.context
      AND NEW.selected_at=pactwoven.native_memory_time(NEW.selection->'selectedAt') AND NEW.valid_until=pactwoven.native_memory_time(NEW.selection->'validUntil')
      AND pactwoven.native_memory_scope(NEW.context)=jsonb_build_object('environment',NEW.environment,'organizationId',NEW.organization_id,'siteId',NEW.site_id)
      AND NEW.selection_digest=pactwoven.native_memory_hash(jsonb_build_object('namespace','pactwoven/native-memory-selection/v1','selection',NEW.selection)),'NM009');
  ELSE
    PERFORM pactwoven.native_memory_require(to_jsonb(NEW)-ARRAY['publication_digest','published_at']=to_jsonb(OLD)-ARRAY['publication_digest','published_at']
      AND ((OLD.publication_digest IS NULL AND NEW.publication_digest IS NOT NULL AND NEW.published_at>=OLD.selected_at)
        OR (OLD.publication_digest=NEW.publication_digest AND OLD.published_at=NEW.published_at)),'NM009');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER native_memory_usage_integrity BEFORE INSERT OR UPDATE ON pactwoven.native_memory_usages FOR EACH ROW EXECUTE FUNCTION pactwoven.native_memory_usage_guard();
CREATE FUNCTION pactwoven.native_memory_fence_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
  PERFORM pactwoven.native_memory_require(to_jsonb(NEW)-'generation'=to_jsonb(OLD)-'generation' AND NEW.generation=OLD.generation+1,'NM009');RETURN NEW;
END $$;
CREATE TRIGGER native_memory_fence_monotonic BEFORE UPDATE ON pactwoven.native_memory_scope_fences FOR EACH ROW EXECUTE FUNCTION pactwoven.native_memory_fence_guard();

-- App roles have no row access. Security-definer entry points use a fixed
-- search path and only their distinct v2 group. No existing v1 ACL is changed.
DO $$ DECLARE t record;f record;BEGIN
  FOR t IN SELECT c.oid::regclass AS relation,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='pactwoven' AND c.relkind='r' AND c.relname LIKE 'native_memory_%' LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY',t.relation);
    EXECUTE format('REVOKE ALL ON TABLE %s FROM PUBLIC,pactwoven_runtime,pactwoven_native_task_api,pactwoven_native_task_worker,pactwoven_native_task_dispatcher,pactwoven_native_delegation_api,pactwoven_native_delegation_coordinator,pactwoven_native_delegation_worker,pactwoven_native_delegation_dispatcher',t.relation);
    EXECUTE format('CREATE TRIGGER memory_retain_rows BEFORE DELETE ON %s FOR EACH ROW EXECUTE FUNCTION pactwoven.native_memory_immutable()',t.relation);
    EXECUTE format('CREATE TRIGGER memory_retain_table BEFORE TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION pactwoven.native_memory_immutable()',t.relation);
    IF t.relname IN ('native_memory_revisions','native_memory_source_revisions','native_memory_dependencies','native_memory_requests','native_memory_invalidation_outbox') THEN
      EXECUTE format('CREATE TRIGGER memory_immutable_rows BEFORE UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION pactwoven.native_memory_immutable()',t.relation);
    END IF;
  END LOOP;
  FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='pactwoven' AND p.proname LIKE 'native_memory_%' LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,pactwoven_runtime,pactwoven_native_task_api,pactwoven_native_task_worker,pactwoven_native_task_dispatcher,pactwoven_native_delegation_api,pactwoven_native_delegation_coordinator,pactwoven_native_delegation_worker,pactwoven_native_delegation_dispatcher',f.signature);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION pactwoven.native_memory_human_read(jsonb,jsonb),pactwoven.native_memory_human_source(jsonb,text,jsonb),
  pactwoven.native_memory_human_mutate(jsonb,text,jsonb),pactwoven.native_memory_human_recover(jsonb,text,text) TO pactwoven_native_delegation_api;
GRANT EXECUTE ON FUNCTION pactwoven.native_memory_task_read(text,jsonb,jsonb) TO pactwoven_native_delegation_coordinator,pactwoven_native_delegation_worker;
COMMIT;

