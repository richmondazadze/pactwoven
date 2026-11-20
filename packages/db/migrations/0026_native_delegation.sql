BEGIN;

-- Advisory delegation is an additive authority family. No v1 row, trigger,
-- function body or service grant is changed by this migration.
DO $$ DECLARE r text; BEGIN
 FOREACH r IN ARRAY ARRAY['api','coordinator','worker','dispatcher'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='pactwoven_native_delegation_'||r) THEN
   EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS','pactwoven_native_delegation_'||r);
  END IF;
 END LOOP;
END $$;
GRANT USAGE ON SCHEMA pactwoven TO pactwoven_native_delegation_api,pactwoven_native_delegation_coordinator,pactwoven_native_delegation_worker,pactwoven_native_delegation_dispatcher;

CREATE TABLE pactwoven.native_delegation_services (
 environment text NOT NULL CHECK(environment IN ('simulation','development','staging','production')),
 service_id text NOT NULL CHECK(service_id ~ '^[A-Za-z0-9_-]{1,128}$'),
 identity jsonb NOT NULL, purpose text NOT NULL CHECK(purpose IN ('api','coordinator','worker','dispatcher')), enabled boolean NOT NULL DEFAULT true,
 PRIMARY KEY(environment,service_id)
);
CREATE TABLE pactwoven.native_delegation_service_bindings (
 role_name name NOT NULL,role_oid oid NOT NULL,environment text NOT NULL,purpose text NOT NULL,
 service_id text NOT NULL,enabled boolean NOT NULL DEFAULT true,
 PRIMARY KEY(role_name,environment,purpose),
 FOREIGN KEY(environment,service_id) REFERENCES pactwoven.native_delegation_services(environment,service_id),
 CHECK(purpose IN ('api','coordinator','worker','dispatcher'))
);
-- Owner-managed policy enrollment is explicit; absence denies issuance/work.
CREATE TABLE pactwoven.native_delegation_policies (
 environment text NOT NULL,organization_id text NOT NULL,version bigint NOT NULL CHECK(version BETWEEN 1 AND 9007199254740991),
 enabled boolean NOT NULL DEFAULT true,
 PRIMARY KEY(environment,organization_id),
 FOREIGN KEY(environment,organization_id) REFERENCES pactwoven.organizations(environment,id)
);
-- JavaScript canonical ordering uses UTF-16 code units, including astral keys.
-- This stored family admits only safe integer JSON numbers; fractional amounts
-- or measurements belong in exact decimal strings, not lossy JSON numbers.
CREATE FUNCTION pactwoven.native_delegation_utf16(v text) RETURNS bytea
LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE result bytea:=''::bytea;c integer;i integer;
BEGIN
 FOR i IN 1..char_length(v) LOOP
  c:=ascii(substr(v,i,1));
  IF c>65535 THEN
   c:=c-65536;result:=result||decode(lpad(to_hex(55296+c/1024),4,'0')||lpad(to_hex(56320+c%1024),4,'0'),'hex');
  ELSE result:=result||decode(lpad(to_hex(c),4,'0'),'hex'); END IF;
 END LOOP;RETURN result;
END $$;
CREATE FUNCTION pactwoven.native_delegation_canonical(v jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE t text:=jsonb_typeof(v);n numeric;result text;
BEGIN
 IF t='object' THEN
  SELECT '{'||coalesce(string_agg(to_jsonb(key)::text||':'||pactwoven.native_delegation_canonical(value),',' ORDER BY pactwoven.native_delegation_utf16(key)),'')||'}' INTO result FROM jsonb_each(v);
 ELSIF t='array' THEN
  SELECT '['||coalesce(string_agg(pactwoven.native_delegation_canonical(value),',' ORDER BY ordinality),'')||']' INTO result FROM jsonb_array_elements(v) WITH ORDINALITY;
 ELSIF t='number' THEN
  n:=(v#>>'{}')::numeric;
  IF n<>trunc(n) OR abs(n)>9007199254740991 THEN RAISE EXCEPTION USING ERRCODE='ND004',MESSAGE='Safe integer JSON numbers or exact decimal strings required'; END IF;
  result:=trim_scale(n)::text;
 ELSE result:=v::text;
 END IF;RETURN result;
END $$;
CREATE FUNCTION pactwoven.native_delegation_hash(v jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT encode(sha256(convert_to(pactwoven.native_delegation_canonical(v),'UTF8')),'hex')
$$;
CREATE FUNCTION pactwoven.native_delegation_schema(k text) RETURNS jsonb
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT $descriptors${"grant":{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{"schemaVersion":{"type":"number","const":1},"id":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"version":{"type":"integer","minimum":1,"maximum":9007199254740991},"revocationEpoch":{"type":"integer","minimum":0,"maximum":9007199254740991},"mode":{"type":"string","const":"advise"},"externalEffects":{"type":"string","const":"forbidden"},"scope":{"type":"object","properties":{"environment":{"type":"string","enum":["simulation","development","staging","production"]},"organizationId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"issuer":{"type":"object","properties":{"actorId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"providerIssuer":{"type":"string","maxLength":261,"pattern":"^https:\\/\\/(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+[a-z]{2,63}$"},"subject":{"type":"string","pattern":"^[A-Za-z0-9_-]{1,256}$"},"externalOrganizationId":{"type":"string","pattern":"^[A-Za-z0-9_-]{1,256}$"},"externalMembershipId":{"type":"string","pattern":"^[A-Za-z0-9_-]{1,256}$"},"membershipVersion":{"type":"integer","minimum":1,"maximum":9007199254740991}},"required":["actorId","providerIssuer","subject","externalOrganizationId","externalMembershipId","membershipVersion"],"additionalProperties":false},"organizationEpoch":{"type":"integer","minimum":0,"maximum":9007199254740991},"policyVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"purpose":{"type":"string","minLength":1,"maxLength":1000},"sites":{"minItems":1,"maxItems":64,"type":"array","items":{"type":"object","properties":{"siteId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"siteVersion":{"type":"integer","minimum":1,"maximum":9007199254740991}},"required":["siteId","siteVersion"],"additionalProperties":false}},"capabilityVersion":{"type":"number","const":1},"capabilities":{"minItems":1,"maxItems":3,"type":"array","items":{"type":"string","enum":["research_public_sources","read_scoped_memory","draft_advice"]}},"limits":{"type":"object","properties":{"maxDepth":{"type":"integer","minimum":0,"maximum":3},"maxConcurrentChildren":{"type":"integer","minimum":1,"maximum":3},"maxChildren":{"type":"integer","minimum":0,"maximum":32},"maxAttempts":{"type":"integer","minimum":1,"maximum":4},"taskTimeoutMs":{"type":"integer","minimum":1000,"maximum":300000}},"required":["maxDepth","maxConcurrentChildren","maxChildren","maxAttempts","taskTimeoutMs"],"additionalProperties":false}},"required":["environment","organizationId","issuer","organizationEpoch","policyVersion","purpose","sites","capabilityVersion","capabilities","limits"],"additionalProperties":false},"issuedAt":{"type":"string","format":"date-time","pattern":"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"},"expiresAt":{"type":"string","format":"date-time","pattern":"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"},"issuance":{"type":"object","properties":{"requestKey":{"type":"string","minLength":16,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"sessionId":{"type":"string","pattern":"^[A-Za-z0-9_-]{1,256}$"},"authenticatedAt":{"type":"string","format":"date-time","pattern":"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"},"confirmedAt":{"type":"string","format":"date-time","pattern":"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"},"scopeDigest":{"type":"string","pattern":"^[a-f0-9]{64}$"},"continuesAfterSignOut":{"type":"boolean","const":true}},"required":["requestKey","sessionId","authenticatedAt","confirmedAt","scopeDigest","continuesAfterSignOut"],"additionalProperties":false},"revocation":{"anyOf":[{"type":"object","properties":{"requestKey":{"type":"string","minLength":16,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"actorId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"revokedAt":{"type":"string","format":"date-time","pattern":"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"}},"required":["requestKey","actorId","revokedAt"],"additionalProperties":false},{"type":"null"}]}},"required":["schemaVersion","id","version","revocationEpoch","mode","externalEffects","scope","issuedAt","expiresAt","issuance","revocation"],"additionalProperties":false},"handoff":{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{"schemaVersion":{"type":"number","const":1},"handoffId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"environment":{"type":"string","enum":["simulation","development","staging","production"]},"organizationId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"siteId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"authority":{"type":"object","properties":{"kind":{"type":"string","const":"delegated"},"grantId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"grantVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"revocationEpoch":{"type":"integer","minimum":0,"maximum":9007199254740991},"grantDigest":{"type":"string","pattern":"^[a-f0-9]{64}$"}},"required":["kind","grantId","grantVersion","revocationEpoch","grantDigest"],"additionalProperties":false},"rootTaskId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"parentTaskId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"childTaskId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"assignmentVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"generation":{"type":"integer","minimum":1,"maximum":9007199254740991},"sender":{"type":"object","properties":{"serviceId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"serviceVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"workloadIdentityId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"}},"required":["serviceId","serviceVersion","workloadIdentityId"],"additionalProperties":false},"recipient":{"type":"object","properties":{"serviceId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"serviceVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"workloadIdentityId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"}},"required":["serviceId","serviceVersion","workloadIdentityId"],"additionalProperties":false},"capability":{"type":"string","enum":["research_public_sources","read_scoped_memory","draft_advice"]},"capabilityVersion":{"type":"number","const":1},"depth":{"type":"integer","minimum":1,"maximum":3},"attemptLimit":{"type":"integer","minimum":1,"maximum":4},"taskTimeoutMs":{"type":"integer","minimum":1000,"maximum":300000},"issuedAt":{"type":"string","format":"date-time","pattern":"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"},"deadlineAt":{"type":"string","format":"date-time","pattern":"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"},"inputArtifacts":{"maxItems":32,"type":"array","items":{"type":"object","properties":{"environment":{"type":"string","enum":["simulation","development","staging","production"]},"organizationId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"siteId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"artifactId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"revision":{"type":"integer","minimum":1,"maximum":9007199254740991},"digest":{"type":"string","pattern":"^[a-f0-9]{64}$"}},"required":["environment","organizationId","siteId","artifactId","revision","digest"],"additionalProperties":false}},"outputContract":{"type":"string","const":"advisory_artifacts_v1"},"correlationId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"}},"required":["schemaVersion","handoffId","environment","organizationId","siteId","authority","rootTaskId","parentTaskId","childTaskId","assignmentVersion","generation","sender","recipient","capability","capabilityVersion","depth","attemptLimit","taskTimeoutMs","issuedAt","deadlineAt","inputArtifacts","outputContract","correlationId"],"additionalProperties":false},"result":{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{"schemaVersion":{"type":"number","const":1},"resultId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"handoffId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"handoffDigest":{"type":"string","pattern":"^[a-f0-9]{64}$"},"environment":{"type":"string","enum":["simulation","development","staging","production"]},"organizationId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"siteId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"childTaskId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"assignmentVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"generation":{"type":"integer","minimum":1,"maximum":9007199254740991},"authority":{"type":"object","properties":{"kind":{"type":"string","const":"delegated"},"grantId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"grantVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"revocationEpoch":{"type":"integer","minimum":0,"maximum":9007199254740991},"grantDigest":{"type":"string","pattern":"^[a-f0-9]{64}$"}},"required":["kind","grantId","grantVersion","revocationEpoch","grantDigest"],"additionalProperties":false},"sender":{"type":"object","properties":{"serviceId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"serviceVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"workloadIdentityId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"}},"required":["serviceId","serviceVersion","workloadIdentityId"],"additionalProperties":false},"recipient":{"type":"object","properties":{"serviceId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"serviceVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"workloadIdentityId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"}},"required":["serviceId","serviceVersion","workloadIdentityId"],"additionalProperties":false},"attempt":{"type":"integer","minimum":1,"maximum":4},"outcome":{"type":"string","enum":["advice_ready","failed"]},"artifacts":{"maxItems":32,"type":"array","items":{"type":"object","properties":{"environment":{"type":"string","enum":["simulation","development","staging","production"]},"organizationId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"siteId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"artifactId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"revision":{"type":"integer","minimum":1,"maximum":9007199254740991},"digest":{"type":"string","pattern":"^[a-f0-9]{64}$"}},"required":["environment","organizationId","siteId","artifactId","revision","digest"],"additionalProperties":false}},"finishedAt":{"type":"string","format":"date-time","pattern":"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"},"evidenceValidUntil":{"anyOf":[{"type":"string","format":"date-time","pattern":"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"},{"type":"null"}]}},"required":["schemaVersion","resultId","handoffId","handoffDigest","environment","organizationId","siteId","childTaskId","assignmentVersion","generation","authority","sender","recipient","attempt","outcome","artifacts","finishedAt","evidenceValidUntil"],"additionalProperties":false},"reference":{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{"kind":{"type":"string","const":"delegated"},"grantId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"grantVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"revocationEpoch":{"type":"integer","minimum":0,"maximum":9007199254740991},"grantDigest":{"type":"string","pattern":"^[a-f0-9]{64}$"}},"required":["kind","grantId","grantVersion","revocationEpoch","grantDigest"],"additionalProperties":false},"service":{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{"serviceId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"serviceVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"workloadIdentityId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"}},"required":["serviceId","serviceVersion","workloadIdentityId"],"additionalProperties":false},"actor":{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{"actorId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"principalKind":{"type":"string","enum":["human","service"]},"organizationId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"environment":{"type":"string","enum":["simulation","development","staging","production"]},"roles":{"minItems":1,"type":"array","items":{"type":"string","enum":["owner","operations","finance","receiver","supplier_admin","supplier_dispatcher","auditor","support","service"]}},"siteIds":{"type":"array","items":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"}},"actionSiteIds":{"type":"array","items":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"}},"sessionId":{"type":"string","minLength":1,"maxLength":256},"authenticatedAt":{"type":"string","format":"date-time","pattern":"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"},"correlationId":{"type":"string","minLength":1,"maxLength":128}},"required":["actorId","principalKind","organizationId","environment","roles","siteIds","actionSiteIds","sessionId","authenticatedAt","correlationId"],"additionalProperties":false}}$descriptors$::jsonb->k
$$;
-- Frozen schema subset, with no UUID/time coercions. Time uses the shared exact
-- Instant parser, including calendar validation and millisecond semantics.
CREATE FUNCTION pactwoven.native_delegation_matches(v jsonb,s jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE t text; x jsonb; k text; item jsonb;
BEGIN
 IF v IS NULL OR s IS NULL THEN RETURN false; END IF;
 IF s ? 'anyOf' THEN
  FOR x IN SELECT value FROM jsonb_array_elements(s->'anyOf') LOOP
   IF pactwoven.native_delegation_matches(v,x) THEN RETURN true; END IF;
  END LOOP; RETURN false;
 END IF;
 t:=s->>'type';
 IF t='integer' THEN
  IF jsonb_typeof(v)<>'number' OR (v#>>'{}')::numeric<>trunc((v#>>'{}')::numeric) THEN RETURN false; END IF;
 ELSIF jsonb_typeof(v) IS DISTINCT FROM t THEN RETURN false; END IF;
 IF s ? 'const' AND v IS DISTINCT FROM s->'const' THEN RETURN false; END IF;
 IF s ? 'enum' AND NOT s->'enum' @> jsonb_build_array(v) THEN RETURN false; END IF;
 IF t IN ('number','integer') THEN
  IF s ? 'minimum' AND (v#>>'{}')::numeric<(s->>'minimum')::numeric THEN RETURN false; END IF;
  IF s ? 'maximum' AND (v#>>'{}')::numeric>(s->>'maximum')::numeric THEN RETURN false; END IF;
 ELSIF t='string' THEN
  IF s ? 'minLength' AND octet_length(pactwoven.native_delegation_utf16(v#>>'{}'))/2<(s->>'minLength')::integer THEN RETURN false; END IF;
  IF s ? 'maxLength' AND octet_length(pactwoven.native_delegation_utf16(v#>>'{}'))/2>(s->>'maxLength')::integer THEN RETURN false; END IF;
  IF s->>'format'='date-time' THEN
   IF pactwoven.supplier_time(v) IS NULL THEN RETURN false; END IF;
  ELSIF s->>'pattern'='^[A-Za-z0-9_-]{1,256}$' THEN
   IF char_length(v#>>'{}')>256 OR NOT (v#>>'{}') ~ '^[A-Za-z0-9_-]+$' THEN RETURN false; END IF;
  ELSIF s ? 'pattern' AND NOT (v#>>'{}') ~ (s->>'pattern') THEN RETURN false; END IF;
 ELSIF t='array' THEN
  IF s ? 'minItems' AND jsonb_array_length(v)<(s->>'minItems')::integer THEN RETURN false; END IF;
  IF s ? 'maxItems' AND jsonb_array_length(v)>(s->>'maxItems')::integer THEN RETURN false; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(v) LOOP
   IF NOT pactwoven.native_delegation_matches(item,s->'items') THEN RETURN false; END IF;
  END LOOP;
 ELSIF t='object' THEN
  IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(s->'required') q WHERE NOT v ? q) THEN RETURN false; END IF;
  FOR k,x IN SELECT * FROM jsonb_each(v) LOOP
   IF NOT s->'properties' ? k OR NOT pactwoven.native_delegation_matches(x,s->'properties'->k) THEN RETURN false; END IF;
  END LOOP;
 END IF;
 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
CREATE FUNCTION pactwoven.native_delegation_require(v jsonb,k text) RETURNS void
LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF octet_length(v::text)>524288 OR NOT pactwoven.native_delegation_matches(v,pactwoven.native_delegation_schema(k)) THEN
  RAISE EXCEPTION USING ERRCODE='ND004',MESSAGE='Invalid delegated record'; END IF;
END $$;
CREATE TABLE pactwoven.native_delegation_grants (
 environment text NOT NULL,organization_id text NOT NULL,id text NOT NULL,
 actor_id text NOT NULL,legacy_root_id text NOT NULL,root_task_id text NOT NULL,
 body jsonb NOT NULL,issue_body jsonb NOT NULL,
 digest text GENERATED ALWAYS AS(pactwoven.native_delegation_hash(body)) STORED,
 request_key text NOT NULL,children_created integer NOT NULL DEFAULT 0 CHECK(children_created BETWEEN 0 AND 32),
 active_children integer NOT NULL DEFAULT 0 CHECK(active_children BETWEEN 0 AND children_created),
 PRIMARY KEY(environment,organization_id,id),UNIQUE(environment,organization_id,actor_id,request_key),UNIQUE(environment,organization_id,root_task_id),
 FOREIGN KEY(environment,organization_id,actor_id) REFERENCES pactwoven.memberships(environment,organization_id,actor_id),
 FOREIGN KEY(environment,organization_id,legacy_root_id) REFERENCES pactwoven.native_tasks(environment,organization_id,id)
);
CREATE TABLE pactwoven.native_delegation_history (
 environment text NOT NULL,organization_id text NOT NULL,grant_id text NOT NULL,version bigint NOT NULL,body jsonb NOT NULL,
 PRIMARY KEY(environment,organization_id,grant_id,version),
 FOREIGN KEY(environment,organization_id,grant_id) REFERENCES pactwoven.native_delegation_grants(environment,organization_id,id)
);
CREATE TABLE pactwoven.native_delegation_tasks (
 environment text NOT NULL,organization_id text NOT NULL,id text NOT NULL,grant_id text NOT NULL,site_id text NOT NULL,
 root_task_id text NOT NULL,parent_task_id text,handoff_id text,ancestors text[] NOT NULL,depth integer NOT NULL CHECK(depth BETWEEN 0 AND 3),
 identity jsonb NOT NULL,authority jsonb NOT NULL,capability text NOT NULL CHECK(capability IN ('research_public_sources','read_scoped_memory','draft_advice')),
 state text NOT NULL CHECK(state IN ('ready','running','paused','cancelled','settled')),
 generation bigint NOT NULL DEFAULT 1 CHECK(generation BETWEEN 1 AND 9007199254740991),
 assignment_version bigint NOT NULL DEFAULT 1 CHECK(assignment_version BETWEEN 1 AND 9007199254740991),
 attempt integer NOT NULL DEFAULT 1 CHECK(attempt BETWEEN 1 AND 4),attempt_limit integer NOT NULL CHECK(attempt_limit BETWEEN 1 AND 4),
 deadline_at timestamptz NOT NULL,lease_token uuid,lease_until timestamptz,
 PRIMARY KEY(environment,organization_id,id),UNIQUE(environment,organization_id,handoff_id),
 FOREIGN KEY(environment,organization_id,grant_id) REFERENCES pactwoven.native_delegation_grants(environment,organization_id,id),
 FOREIGN KEY(environment,organization_id,site_id) REFERENCES pactwoven.sites(environment,organization_id,id),
 CHECK((depth=0 AND parent_task_id IS NULL AND handoff_id IS NULL AND root_task_id=id) OR(depth>0 AND parent_task_id IS NOT NULL AND handoff_id IS NOT NULL)),
 CHECK((lease_token IS NULL AND lease_until IS NULL) OR(lease_token IS NOT NULL AND lease_until IS NOT NULL AND state='running'))
);
CREATE TABLE pactwoven.native_delegation_envelopes (
 environment text NOT NULL,organization_id text NOT NULL,handoff_id text NOT NULL,assignment_version bigint NOT NULL,generation bigint NOT NULL,
 kind text NOT NULL CHECK(kind='handoff'),body jsonb NOT NULL,digest text GENERATED ALWAYS AS(pactwoven.native_delegation_hash(body)) STORED,
 PRIMARY KEY(environment,organization_id,handoff_id,assignment_version,generation,kind),
 FOREIGN KEY(environment,organization_id,handoff_id) REFERENCES pactwoven.native_delegation_tasks(environment,organization_id,handoff_id)
);
CREATE TABLE pactwoven.native_delegation_results (
 environment text NOT NULL,organization_id text NOT NULL,handoff_id text NOT NULL,result_id text NOT NULL,
 assignment_version bigint NOT NULL,generation bigint NOT NULL,publication jsonb NOT NULL,
 digest text GENERATED ALWAYS AS(pactwoven.native_delegation_hash(publication)) STORED,
 PRIMARY KEY(environment,organization_id,handoff_id),UNIQUE(environment,organization_id,result_id),
 FOREIGN KEY(environment,organization_id,handoff_id) REFERENCES pactwoven.native_delegation_tasks(environment,organization_id,handoff_id)
);
CREATE TABLE pactwoven.native_delegation_artifacts (
 environment text NOT NULL,organization_id text NOT NULL,id text NOT NULL,revision bigint NOT NULL,site_id text NOT NULL,
 task_id text NOT NULL,reference jsonb NOT NULL,body jsonb NOT NULL,valid_until timestamptz NOT NULL,memory_derived boolean NOT NULL,
 publication_digest text NOT NULL,
 PRIMARY KEY(environment,organization_id,id,revision),
 FOREIGN KEY(environment,organization_id,task_id) REFERENCES pactwoven.native_delegation_tasks(environment,organization_id,id)
);
CREATE TABLE pactwoven.native_delegation_proofs (
 environment text NOT NULL,organization_id text NOT NULL,task_id text NOT NULL,binding jsonb NOT NULL,
 verdict text NOT NULL DEFAULT 'unknown' CHECK(verdict IN ('unknown','allowed','denied')),valid_until timestamptz,
 barrier bigint NOT NULL DEFAULT 0,nonce uuid UNIQUE,nonce_barrier bigint,prepared_at timestamptz,deadline_at timestamptz,
 PRIMARY KEY(environment,organization_id,task_id),
 FOREIGN KEY(environment,organization_id,task_id) REFERENCES pactwoven.native_delegation_tasks(environment,organization_id,id),
 CHECK((verdict='allowed' AND valid_until IS NOT NULL) OR(verdict<>'allowed' AND valid_until IS NULL))
);
CREATE TABLE pactwoven.native_delegation_outbox (
 environment text NOT NULL,organization_id text NOT NULL,task_id text NOT NULL,generation bigint NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','publishing','published')),token uuid,lease_until timestamptz,
 PRIMARY KEY(environment,organization_id,task_id,generation),
 FOREIGN KEY(environment,organization_id,task_id) REFERENCES pactwoven.native_delegation_tasks(environment,organization_id,id)
);
CREATE FUNCTION pactwoven.native_delegation_binding(p_environment text,p_purpose text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM pactwoven.native_delegation_service_bindings b
  JOIN pg_catalog.pg_roles r ON(r.rolname,r.oid)=(b.role_name,b.role_oid)
  JOIN pactwoven.native_delegation_services s ON(s.environment,s.service_id,s.purpose)=(b.environment,b.service_id,b.purpose)
  WHERE b.role_name=session_user AND b.environment=p_environment AND b.purpose=p_purpose AND b.enabled AND s.enabled
   AND pactwoven.native_delegation_matches(s.identity,pactwoven.native_delegation_schema('service')) AND s.identity->>'serviceId'=s.service_id
   AND pg_catalog.pg_has_role(session_user,'pactwoven_native_delegation_'||p_purpose,'MEMBER'))
$$;
CREATE FUNCTION pactwoven.native_delegation_service(p_environment text,p_purposes text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v jsonb; n integer;
BEGIN
 PERFORM pactwoven.financial_require_read_committed();
 PERFORM 1 FROM pactwoven.native_delegation_service_bindings b JOIN pactwoven.native_delegation_services s ON(s.environment,s.service_id)=(b.environment,b.service_id)
  WHERE b.role_name=session_user AND b.environment=p_environment AND b.purpose=ANY(p_purposes) FOR SHARE OF b,s;
 SELECT count(*),(jsonb_agg(s.identity))->0 INTO n,v FROM pactwoven.native_delegation_service_bindings b
  JOIN pactwoven.native_delegation_services s ON(s.environment,s.service_id,s.purpose)=(b.environment,b.service_id,b.purpose)
  WHERE b.role_name=session_user AND b.environment=p_environment AND b.purpose=ANY(p_purposes)
   AND pactwoven.native_delegation_binding(p_environment,b.purpose);
 IF n<>1 THEN RAISE EXCEPTION USING ERRCODE='ND001',MESSAGE='Exact delegated service enrollment required'; END IF;
 RETURN v;
END $$;
CREATE FUNCTION pactwoven.native_delegation_actor_locked(p_actor jsonb,p_site text,p_write boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE live_roles text[];member_expiry timestamptz;
BEGIN
 PERFORM pactwoven.native_delegation_require(p_actor,'actor');
 PERFORM pactwoven.native_delegation_service(p_actor->>'environment',ARRAY['api']);
 IF p_actor->>'principalKind'<>'human' OR pactwoven.supplier_time(p_actor->'authenticatedAt')>clock_timestamp() THEN
  RAISE EXCEPTION USING ERRCODE='ND001',MESSAGE='Authenticated human required'; END IF;
 PERFORM set_config('pactwoven.environment',p_actor->>'environment',true),set_config('pactwoven.organization_id',p_actor->>'organizationId',true),
  set_config('pactwoven.actor_id',p_actor->>'actorId',true),set_config('pactwoven.session_id',p_actor->>'sessionId',true);
 PERFORM 1 FROM pactwoven.organizations WHERE(environment,id)=(p_actor->>'environment',p_actor->>'organizationId') FOR SHARE;
 LOCK TABLE pactwoven.session_revocations IN SHARE MODE;
 SELECT roles INTO live_roles FROM pactwoven.lock_actor();
 IF live_roles IS NULL OR NOT EXISTS(SELECT 1 FROM pactwoven.organizations WHERE(environment,id)=(p_actor->>'environment',p_actor->>'organizationId') AND status='active')
  OR NOT EXISTS(SELECT 1 FROM pactwoven.memberships WHERE(environment,organization_id,actor_id)=(p_actor->>'environment',p_actor->>'organizationId',p_actor->>'actorId') AND status='active' AND(expires_at IS NULL OR expires_at>clock_timestamp()))
  OR EXISTS(SELECT 1 FROM pactwoven.session_revocations WHERE(environment,session_id)=(p_actor->>'environment',p_actor->>'sessionId')) THEN
  RAISE EXCEPTION USING ERRCODE='ND001',MESSAGE='Current human membership required'; END IF;
 IF p_site IS NOT NULL THEN
  PERFORM 1 FROM pactwoven.sites WHERE(environment,organization_id,id)=(p_actor->>'environment',p_actor->>'organizationId',p_site) FOR SHARE;
  PERFORM 1 FROM pactwoven.financial_site_fences WHERE(environment,organization_id,site_id)=(p_actor->>'environment',p_actor->>'organizationId',p_site) AND active FOR SHARE;
  IF NOT FOUND OR NOT pactwoven.can_read_site(p_actor->>'environment',p_actor->>'organizationId',p_site) THEN
   RAISE EXCEPTION USING ERRCODE='ND001',MESSAGE='Current site access required'; END IF;
 END IF;
 IF p_write AND(NOT live_roles && ARRAY['owner','operations'] OR(p_site IS NOT NULL AND NOT EXISTS(SELECT 1 FROM pactwoven.member_action_sites WHERE(environment,organization_id,actor_id,site_id)=(p_actor->>'environment',p_actor->>'organizationId',p_actor->>'actorId',p_site)))) THEN
  RAISE EXCEPTION USING ERRCODE='ND001',MESSAGE='Current action-site authority required'; END IF;
 SELECT expires_at INTO member_expiry FROM pactwoven.memberships WHERE(environment,organization_id,actor_id)=(p_actor->>'environment',p_actor->>'organizationId',p_actor->>'actorId');
 IF member_expiry IS NOT NULL AND member_expiry<=clock_timestamp() THEN RAISE EXCEPTION USING ERRCODE='ND001',MESSAGE='Human membership expired while waiting'; END IF;
 RETURN jsonb_build_object('environment',p_actor->>'environment','organizationId',p_actor->>'organizationId','siteId',p_site,
  'reader',jsonb_build_object('kind','user','id',p_actor->>'actorId'),'actorId',p_actor->>'actorId','roles',live_roles,'sessionId',p_actor->>'sessionId','validUntil',CASE WHEN member_expiry IS NOT NULL THEN pactwoven.mandate_instant(member_expiry) END);
END $$;
-- All delegated writers use this lock prefix; no issuing-session lookup occurs.
CREATE FUNCTION pactwoven.native_delegation_scope_locked(p_scope jsonb) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE o pactwoven.organizations%ROWTYPE;m pactwoven.memberships%ROWTYPE;p pactwoven.native_delegation_policies%ROWTYPE;s jsonb;f pactwoven.financial_site_fences%ROWTYPE;
BEGIN
 SELECT * INTO o FROM pactwoven.organizations WHERE(environment,id)=(p_scope->>'environment',p_scope->>'organizationId') FOR SHARE;
 SELECT * INTO m FROM pactwoven.memberships WHERE(environment,organization_id,actor_id)=(p_scope->>'environment',p_scope->>'organizationId',p_scope#>>'{issuer,actorId}') FOR SHARE;
 IF p_scope->>'environment'<>'simulation' THEN
  -- Enrollment rotation/revocation must wait until the protected result or
  -- claim commits. A final reread alone leaves a post-check race.
  PERFORM 1 FROM pactwoven.native_provider_instances WHERE environment=p_scope->>'environment' FOR SHARE;
 END IF;
 IF o.id IS NULL OR m.actor_id IS NULL OR o.status<>'active' OR m.status<>'active' OR NOT m.roles && ARRAY['owner','operations']
  OR(m.expires_at IS NOT NULL AND m.expires_at<=clock_timestamp()) OR o.authority_epoch::text<>p_scope->>'organizationEpoch'
  OR m.row_version::text<>p_scope#>>'{issuer,membershipVersion}' OR m.external_subject<>p_scope#>>'{issuer,subject}'
  OR m.external_membership_id<>p_scope#>>'{issuer,externalMembershipId}' OR o.external_organization_id<>p_scope#>>'{issuer,externalOrganizationId}'
  OR(p_scope->>'environment'<>'simulation' AND NOT EXISTS(SELECT 1 FROM pactwoven.native_provider_instances WHERE environment=p_scope->>'environment' AND issuer=p_scope#>>'{issuer,providerIssuer}' AND enabled)) THEN
  RAISE EXCEPTION USING ERRCODE='ND001',MESSAGE='Delegated issuer authority changed'; END IF;
 FOR s IN SELECT value FROM jsonb_array_elements(p_scope->'sites') ORDER BY value->>'siteId' COLLATE "C" LOOP
  PERFORM 1 FROM pactwoven.sites WHERE(environment,organization_id,id)=(o.environment,o.id,s->>'siteId') FOR SHARE;
  SELECT * INTO f FROM pactwoven.financial_site_fences WHERE(environment,organization_id,site_id)=(o.environment,o.id,s->>'siteId') FOR SHARE;
  IF f.site_id IS NULL OR NOT f.active OR f.generation+1<>(s->>'siteVersion')::bigint
   OR NOT EXISTS(SELECT 1 FROM pactwoven.member_action_sites WHERE(environment,organization_id,actor_id,site_id)=(o.environment,o.id,m.actor_id,s->>'siteId'))
   OR(NOT 'owner'=ANY(m.roles) AND NOT EXISTS(SELECT 1 FROM pactwoven.site_memberships WHERE(environment,organization_id,actor_id,site_id)=(o.environment,o.id,m.actor_id,s->>'siteId'))) THEN
   RAISE EXCEPTION USING ERRCODE='ND001',MESSAGE='Delegated site authority changed'; END IF;
 END LOOP;
 SELECT * INTO p FROM pactwoven.native_delegation_policies WHERE(environment,organization_id)=(o.environment,o.id) FOR SHARE;
 IF p.organization_id IS NULL OR NOT p.enabled OR p.version::text<>p_scope->>'policyVersion' THEN
  RAISE EXCEPTION USING ERRCODE='ND001',MESSAGE='Delegated policy changed'; END IF;
 IF m.expires_at IS NOT NULL AND m.expires_at<=clock_timestamp() THEN RAISE EXCEPTION USING ERRCODE='ND001',MESSAGE='Membership expired while waiting'; END IF;
 RETURN m.expires_at;
END $$;
CREATE FUNCTION pactwoven.native_delegation_reference(g pactwoven.native_delegation_grants) RETURNS jsonb
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('kind','delegated','grantId',g.id,'grantVersion',g.body->'version','revocationEpoch',g.body->'revocationEpoch','grantDigest',g.digest)
$$;
CREATE FUNCTION pactwoven.native_delegation_grant_locked(e text,o text,gid text) RETURNS pactwoven.native_delegation_grants
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE g pactwoven.native_delegation_grants%ROWTYPE; expiry timestamptz;
BEGIN
 SELECT * INTO g FROM pactwoven.native_delegation_grants WHERE(environment,organization_id,id)=(e,o,gid);
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='ND001',MESSAGE='Delegation unavailable'; END IF;
 expiry:=pactwoven.native_delegation_scope_locked(g.body->'scope');
 SELECT * INTO g FROM pactwoven.native_delegation_grants WHERE(environment,organization_id,id)=(e,o,gid) FOR UPDATE;
 IF g.body->'revocation'<>'null'::jsonb OR pactwoven.supplier_time(g.body->'issuedAt')>clock_timestamp()
  OR pactwoven.supplier_time(g.body->'expiresAt')<=clock_timestamp() OR(expiry IS NOT NULL AND expiry<=clock_timestamp()) THEN
  RAISE EXCEPTION USING ERRCODE='ND001',MESSAGE='Delegation expired or revoked'; END IF;
 RETURN g;
END $$;
CREATE FUNCTION pactwoven.native_delegation_issue(p_actor jsonb,p_legacy_root text,p_grant jsonb,p_issuance jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE g pactwoven.native_delegation_grants%ROWTYPE;t pactwoven.native_tasks%ROWTYPE;s jsonb;scope jsonb;review jsonb;ref jsonb;issue_at timestamptz;expiry timestamptz;root_id text;
BEGIN
 PERFORM pactwoven.native_delegation_require(p_grant,'grant');
 scope:=p_grant->'scope';
 PERFORM pactwoven.native_delegation_service(p_actor->>'environment',ARRAY['api']);
 PERFORM pg_advisory_xact_lock(hashtextextended('native-delegation-issue:'||(p_actor->>'environment')||':'||(p_actor->>'organizationId'),0));
 PERFORM pactwoven.native_delegation_actor_locked(p_actor,NULL,true);
 IF NOT pactwoven.supplier_object(p_issuance,ARRAY['rootTaskId','service','sessionVerifiedAt','sessionExpiresAt'])
  OR coalesce(p_issuance->>'rootTaskId','')!~'^[A-Za-z0-9_-]{1,128}$' THEN RAISE EXCEPTION USING ERRCODE='ND004',MESSAGE='Exact root issuance required'; END IF;
 PERFORM pactwoven.native_delegation_require(p_issuance->'service','service');
 root_id:=p_issuance->>'rootTaskId';
 IF(scope->>'environment',scope->>'organizationId',scope#>>'{issuer,actorId}') IS DISTINCT FROM(p_actor->>'environment',p_actor->>'organizationId',p_actor->>'actorId')
  OR p_grant#>>'{issuance,sessionId}'<>p_actor->>'sessionId' OR p_grant#>'{issuance,authenticatedAt}' IS DISTINCT FROM p_actor->'authenticatedAt'
  OR pactwoven.supplier_time(p_issuance->'sessionVerifiedAt') IS NULL OR pactwoven.supplier_time(p_issuance->'sessionExpiresAt') IS NULL
  OR pactwoven.supplier_time(p_issuance->'sessionVerifiedAt')>clock_timestamp() OR pactwoven.supplier_time(p_issuance->'sessionVerifiedAt')<clock_timestamp()-interval '20 seconds'
  OR pactwoven.supplier_time(p_issuance->'sessionExpiresAt')<=clock_timestamp() THEN RAISE EXCEPTION USING ERRCODE='ND001',MESSAGE='Fresh signed-in consent required'; END IF;
 SELECT * INTO t FROM pactwoven.native_tasks WHERE(environment,organization_id,id)=(scope->>'environment',scope->>'organizationId',p_legacy_root);
 IF t.id IS NULL OR t.actor_id<>p_actor->>'actorId' OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(scope->'sites') a WHERE a->>'siteId'=t.site_id) OR root_id=t.id THEN
  RAISE EXCEPTION USING ERRCODE='ND001',MESSAGE='Same-scope legacy provenance required'; END IF;
 -- Serialize first issuance (including competing grant IDs using one request key).
 SELECT * INTO g FROM pactwoven.native_delegation_grants WHERE environment=t.environment AND organization_id=t.organization_id
  AND(id=p_grant->>'id' OR(actor_id=t.actor_id AND request_key=p_grant#>>'{issuance,requestKey}')) FOR UPDATE;
 IF FOUND THEN
  IF g.issue_body IS DISTINCT FROM p_grant OR g.legacy_root_id<>p_legacy_root OR g.root_task_id<>root_id
   OR NOT EXISTS(SELECT 1 FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(t.environment,t.organization_id,root_id) AND identity=p_issuance->'service') THEN
   RAISE EXCEPTION USING ERRCODE='ND009',MESSAGE='Issuance identity conflicts'; END IF;
  RETURN jsonb_build_object('kind','duplicate','grant',g.body,'rootTaskId',g.root_task_id,'authority',pactwoven.native_delegation_reference(g));
 END IF;
 expiry:=pactwoven.native_delegation_scope_locked(scope);issue_at:=pactwoven.supplier_time(p_grant->'issuedAt');
 IF p_grant->'version'<>'1'::jsonb OR p_grant->'revocationEpoch'<>'0'::jsonb OR p_grant->'revocation'<>'null'::jsonb
  OR issue_at>clock_timestamp() OR issue_at<clock_timestamp()-interval '20 seconds'
  OR pactwoven.supplier_time(p_grant->'expiresAt')<=clock_timestamp() OR pactwoven.supplier_time(p_grant->'expiresAt')>issue_at+interval '24 hours'
  OR pactwoven.supplier_time(p_grant#>'{issuance,authenticatedAt}')>pactwoven.supplier_time(p_grant#>'{issuance,confirmedAt}')
  OR pactwoven.supplier_time(p_grant#>'{issuance,confirmedAt}')>issue_at OR pactwoven.supplier_time(p_grant#>'{issuance,confirmedAt}')<clock_timestamp()-interval '5 minutes'
  OR jsonb_array_length(scope->'sites')<>(SELECT count(DISTINCT a->>'siteId') FROM jsonb_array_elements(scope->'sites') a)
  OR jsonb_array_length(scope->'capabilities')<>(SELECT count(DISTINCT a) FROM jsonb_array_elements(scope->'capabilities') a)
  OR btrim(scope->>'purpose')<>scope->>'purpose' OR NOT scope->'capabilities' ? 'draft_advice' THEN
  RAISE EXCEPTION USING ERRCODE='ND004',MESSAGE='Bounded advisory issuance required'; END IF;
 review:=jsonb_build_object('grantId',p_grant->'id','requestKey',p_grant#>'{issuance,requestKey}','mode','advise','externalEffects','forbidden',
  'scope',scope,'expiresAt',p_grant->'expiresAt','continuesAfterSignOut',true);
 IF pactwoven.native_delegation_hash(review)<>p_grant#>>'{issuance,scopeDigest}' THEN RAISE EXCEPTION USING ERRCODE='ND004',MESSAGE='Consent digest mismatch'; END IF;
 PERFORM 1 FROM pactwoven.native_delegation_services WHERE environment=t.environment AND service_id=p_issuance#>>'{service,serviceId}' FOR SHARE;
 IF NOT EXISTS(SELECT 1 FROM pactwoven.native_delegation_services WHERE environment=t.environment AND identity=p_issuance->'service' AND purpose='coordinator' AND enabled) THEN
  RAISE EXCEPTION USING ERRCODE='ND001',MESSAGE='Registered root coordinator required'; END IF;
 INSERT INTO pactwoven.native_delegation_grants(environment,organization_id,id,actor_id,legacy_root_id,root_task_id,body,issue_body,request_key)
  VALUES(t.environment,t.organization_id,p_grant->>'id',t.actor_id,p_legacy_root,root_id,p_grant,p_grant,p_grant#>>'{issuance,requestKey}') RETURNING * INTO g;
 ref:=pactwoven.native_delegation_reference(g);
 INSERT INTO pactwoven.native_delegation_history VALUES(t.environment,t.organization_id,g.id,1,g.body);
 INSERT INTO pactwoven.native_delegation_tasks(environment,organization_id,id,grant_id,site_id,root_task_id,ancestors,depth,identity,authority,capability,state,attempt_limit,deadline_at)
  VALUES(t.environment,t.organization_id,root_id,g.id,t.site_id,root_id,ARRAY[root_id],0,p_issuance->'service',ref,'draft_advice','ready',1,pactwoven.supplier_time(p_grant->'expiresAt'));
 INSERT INTO pactwoven.native_delegation_outbox(environment,organization_id,task_id,generation) VALUES(t.environment,t.organization_id,root_id,1);
 IF pactwoven.supplier_time(p_issuance->'sessionExpiresAt')<=clock_timestamp() OR pactwoven.supplier_time(p_issuance->'sessionVerifiedAt')<clock_timestamp()-interval '20 seconds'
  OR(expiry IS NOT NULL AND expiry<=clock_timestamp()) THEN RAISE EXCEPTION USING ERRCODE='ND001',MESSAGE='Consent expired while issuing'; END IF;
 RETURN jsonb_build_object('kind','issued','grant',g.body,'rootTaskId',root_id,'authority',ref);
END $$;
CREATE FUNCTION pactwoven.native_delegation_read(p_actor jsonb,p_grant_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE g pactwoven.native_delegation_grants%ROWTYPE;
BEGIN
 PERFORM pactwoven.native_delegation_actor_locked(p_actor,NULL,false);
 SELECT * INTO g FROM pactwoven.native_delegation_grants WHERE(environment,organization_id,id,actor_id)=(p_actor->>'environment',p_actor->>'organizationId',p_grant_id,p_actor->>'actorId');
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='ND001',MESSAGE='Delegation unavailable'; END IF;
 RETURN jsonb_build_object('grant',g.body,'rootTaskId',g.root_task_id,'childrenCreated',g.children_created,'activeChildren',g.active_children,
  'tasks',(SELECT coalesce(jsonb_agg(jsonb_build_object('taskId',id,'state',state,'generation',generation,'depth',depth,'service',identity,'handoffId',handoff_id) ORDER BY depth,id),'[]'::jsonb)
    FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,grant_id)=(g.environment,g.organization_id,g.id)));
END $$;
CREATE FUNCTION pactwoven.native_delegation_revoke(p_actor jsonb,p_request jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE g pactwoven.native_delegation_grants%ROWTYPE;
BEGIN
 PERFORM pactwoven.native_delegation_actor_locked(p_actor,NULL,false);
 IF NOT pactwoven.supplier_object(p_request,ARRAY['grantId','expectedVersion','expectedRevocationEpoch','requestKey'])
  OR coalesce(p_request->>'grantId','')!~'^[A-Za-z0-9_-]{1,128}$' OR coalesce(p_request->>'requestKey','')!~'^[A-Za-z0-9_-]{16,128}$'
  OR NOT pactwoven.supplier_integer(p_request->'expectedVersion',1,9007199254740990)
  OR NOT pactwoven.supplier_integer(p_request->'expectedRevocationEpoch',0,9007199254740990) THEN RAISE EXCEPTION USING ERRCODE='ND004',MESSAGE='Exact revocation required'; END IF;
 SELECT * INTO g FROM pactwoven.native_delegation_grants WHERE(environment,organization_id,id,actor_id)=(p_actor->>'environment',p_actor->>'organizationId',p_request->>'grantId',p_actor->>'actorId') FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='ND001',MESSAGE='Issuing human required'; END IF;
 IF g.body->'revocation'<>'null'::jsonb THEN
  IF g.body#>>'{revocation,requestKey}'=p_request->>'requestKey' AND(g.body->>'version')::bigint=(p_request->>'expectedVersion')::bigint+1
   AND(g.body->>'revocationEpoch')::bigint=(p_request->>'expectedRevocationEpoch')::bigint+1 THEN RETURN g.body; END IF;
  RAISE EXCEPTION USING ERRCODE='ND009',MESSAGE='Revocation identity conflicts';
 END IF;
 IF g.body->'version'<>p_request->'expectedVersion' OR g.body->'revocationEpoch'<>p_request->'expectedRevocationEpoch' THEN
  RAISE EXCEPTION USING ERRCODE='ND009',MESSAGE='Grant predecessor changed'; END IF;
 UPDATE pactwoven.native_delegation_grants SET body=body||jsonb_build_object('version',(body->>'version')::bigint+1,'revocationEpoch',(body->>'revocationEpoch')::bigint+1,
  'revocation',jsonb_build_object('requestKey',p_request->>'requestKey','actorId',p_actor->>'actorId','revokedAt',pactwoven.mandate_instant(clock_timestamp()))),active_children=0
  WHERE(environment,organization_id,id)=(g.environment,g.organization_id,g.id) RETURNING * INTO g;
 INSERT INTO pactwoven.native_delegation_history VALUES(g.environment,g.organization_id,g.id,(g.body->>'version')::bigint,g.body);
 UPDATE pactwoven.native_delegation_tasks SET state='cancelled',lease_token=NULL,lease_until=NULL WHERE(environment,organization_id,grant_id)=(g.environment,g.organization_id,g.id) AND state<>'settled';
 UPDATE pactwoven.native_delegation_proofs SET verdict='denied',valid_until=NULL,nonce=NULL,barrier=barrier+1
  WHERE environment=g.environment AND organization_id=g.organization_id AND task_id IN(SELECT id FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,grant_id)=(g.environment,g.organization_id,g.id));
 RETURN g.body;
END $$;
-- Binding has exact provider identity and grant/task generations but no session.
CREATE FUNCTION pactwoven.native_delegation_provider_binding(g pactwoven.native_delegation_grants,t pactwoven.native_delegation_tasks) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('authority',pactwoven.native_delegation_reference(g),'taskId',t.id,'generation',t.generation,'assignmentVersion',t.assignment_version,
  'providerIssuer',g.body#>>'{scope,issuer,providerIssuer}','subject',m.external_subject,'externalOrganizationId',o.external_organization_id,
  'externalMembershipId',m.external_membership_id,'requiredRole',CASE WHEN m.grant_basis='clerk_admin_bootstrap' THEN 'org:admin' ELSE NULL END,
  'memberExpiry',m.expires_at)
 FROM pactwoven.memberships m JOIN pactwoven.organizations o ON(o.environment,o.id)=(m.environment,m.organization_id)
 WHERE(m.environment,m.organization_id,m.actor_id)=(g.environment,g.organization_id,g.actor_id)
$$;
CREATE FUNCTION pactwoven.native_delegation_target(p_selector jsonb,p_claim boolean) RETURNS void
LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT pactwoven.supplier_object(p_selector,CASE WHEN p_claim THEN ARRAY['organizationId','taskId','generation','handoffId','leaseToken'] ELSE ARRAY['organizationId','taskId','generation'] END)
  OR coalesce(p_selector->>'organizationId','')!~'^[A-Za-z0-9_-]{1,128}$' OR coalesce(p_selector->>'taskId','')!~'^[A-Za-z0-9_-]{1,128}$'
  OR NOT pactwoven.supplier_integer(p_selector->'generation',1,9007199254740991)
  OR(p_claim AND(coalesce(p_selector->>'leaseToken','')!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
   OR(p_selector->'handoffId'<>'null'::jsonb AND coalesce(p_selector->>'handoffId','')!~'^[A-Za-z0-9_-]{1,128}$'))) THEN
  RAISE EXCEPTION USING ERRCODE='ND004',MESSAGE='Exact task selector required'; END IF;
END $$;
CREATE FUNCTION pactwoven.native_delegation_authority_prepare(p_environment text,p_selector jsonb,p_issuer text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE g pactwoven.native_delegation_grants%ROWTYPE;t pactwoven.native_delegation_tasks%ROWTYPE;a pactwoven.native_delegation_proofs%ROWTYPE;b jsonb;now_at timestamptz;
BEGIN
 PERFORM pactwoven.native_delegation_service(p_environment,ARRAY['api']);PERFORM pactwoven.native_delegation_target(p_selector,false);
 SELECT * INTO t FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(p_environment,p_selector->>'organizationId',p_selector->>'taskId');
 IF NOT FOUND THEN RETURN jsonb_build_object('kind','settled','result',jsonb_build_object('state','stale')); END IF;
 g:=pactwoven.native_delegation_grant_locked(t.environment,t.organization_id,t.grant_id);
 SELECT * INTO t FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(t.environment,t.organization_id,t.id) FOR UPDATE;
 IF t.generation::text<>p_selector->>'generation' OR t.state NOT IN('ready','running') THEN RETURN jsonb_build_object('kind','settled','result',jsonb_build_object('state','stale')); END IF;
 b:=pactwoven.native_delegation_provider_binding(g,t);
 IF p_issuer IS DISTINCT FROM b->>'providerIssuer' THEN RAISE EXCEPTION USING ERRCODE='ND001',MESSAGE='Canonical provider enrollment required'; END IF;
 INSERT INTO pactwoven.native_delegation_proofs(environment,organization_id,task_id,binding) VALUES(t.environment,t.organization_id,t.id,b) ON CONFLICT DO NOTHING;
 SELECT * INTO a FROM pactwoven.native_delegation_proofs WHERE(environment,organization_id,task_id)=(t.environment,t.organization_id,t.id) FOR UPDATE;
 IF a.binding=b AND a.nonce IS NOT NULL AND a.deadline_at>clock_timestamp() THEN RETURN jsonb_build_object('kind','pending','retryAfterMilliseconds',1000); END IF;
 now_at:=clock_timestamp();
 UPDATE pactwoven.native_delegation_proofs SET binding=b,verdict='unknown',valid_until=NULL,barrier=barrier+1,nonce_barrier=barrier+1,
  nonce=gen_random_uuid(),prepared_at=now_at,deadline_at=now_at+interval '8 seconds'
  WHERE(environment,organization_id,task_id)=(t.environment,t.organization_id,t.id) RETURNING * INTO a;
 RETURN jsonb_build_object('kind','prepared','target',p_selector,'nonce',a.nonce,'preparedAt',pactwoven.mandate_instant(a.prepared_at),'deadlineAt',pactwoven.mandate_instant(a.deadline_at),
  'providerIssuer',p_issuer,'context',b-ARRAY['authority','taskId','generation','assignmentVersion','providerIssuer','memberExpiry']);
END $$;
CREATE FUNCTION pactwoven.native_delegation_authority_finish(p_environment text,p_nonce uuid,p_verdict jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a pactwoven.native_delegation_proofs%ROWTYPE;g pactwoven.native_delegation_grants%ROWTYPE;t pactwoven.native_delegation_tasks%ROWTYPE;b jsonb;u timestamptz;st text;observed_start timestamptz;observed_end timestamptz;
BEGIN
 PERFORM pactwoven.native_delegation_service(p_environment,ARRAY['api']);
 IF NOT pactwoven.supplier_object(p_verdict,ARRAY['state','reason','observationStartedAt','observationCompletedAt']) THEN RAISE EXCEPTION USING ERRCODE='ND004',MESSAGE='Exact provider observation required'; END IF;
 st:=p_verdict->>'state';observed_start:=pactwoven.supplier_time(p_verdict->'observationStartedAt');observed_end:=pactwoven.supplier_time(p_verdict->'observationCompletedAt');
 IF st IS NULL OR st NOT IN('allowed','denied','unavailable') OR observed_start IS NULL OR observed_end IS NULL OR observed_end<observed_start
  OR coalesce(p_verdict->>'reason','')!~'^[a-z_]{1,64}$' OR(st='allowed' AND p_verdict->>'reason'<>'current') THEN RAISE EXCEPTION USING ERRCODE='ND004',MESSAGE='Invalid provider observation'; END IF;
 SELECT * INTO a FROM pactwoven.native_delegation_proofs WHERE environment=p_environment AND nonce=p_nonce;
 IF NOT FOUND THEN RETURN jsonb_build_object('state','stale'); END IF;
 SELECT * INTO t FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(a.environment,a.organization_id,a.task_id);
 -- Local policy revocation must never turn into an allow. Invalid scope throws,
 -- preserving an unknown result rather than accepting stale provider evidence.
 g:=pactwoven.native_delegation_grant_locked(t.environment,t.organization_id,t.grant_id);
 SELECT * INTO t FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(t.environment,t.organization_id,t.id) FOR UPDATE;
 SELECT * INTO a FROM pactwoven.native_delegation_proofs WHERE(environment,organization_id,task_id)=(t.environment,t.organization_id,t.id) FOR UPDATE;
 b:=pactwoven.native_delegation_provider_binding(g,t);
 IF a.nonce IS DISTINCT FROM p_nonce OR a.nonce_barrier<>a.barrier OR a.binding IS DISTINCT FROM b OR t.state NOT IN('ready','running') THEN RETURN jsonb_build_object('state','stale'); END IF;
 u:=least(a.prepared_at+interval '20 seconds',pactwoven.supplier_time(g.body->'expiresAt'),(b->>'memberExpiry')::timestamptz,t.deadline_at);
 IF a.deadline_at<=clock_timestamp() OR u<=clock_timestamp() THEN st:='unavailable'; END IF;
 UPDATE pactwoven.native_delegation_proofs SET verdict=CASE st WHEN 'allowed' THEN 'allowed' WHEN 'denied' THEN 'denied' ELSE 'unknown' END,
  valid_until=CASE WHEN st='allowed' THEN u END,nonce=NULL,nonce_barrier=NULL,barrier=barrier+CASE WHEN st='denied' THEN 1 ELSE 0 END
  WHERE(environment,organization_id,task_id)=(t.environment,t.organization_id,t.id);
 IF st='denied' THEN
  -- Provider denial fences the entire shared grant tree; it never revokes or
  -- touches the historical session-bound task.
  UPDATE pactwoven.native_delegation_tasks SET state='paused',lease_token=NULL,lease_until=NULL WHERE(environment,organization_id,grant_id)=(g.environment,g.organization_id,g.id) AND state IN('ready','running');
  UPDATE pactwoven.native_delegation_proofs SET verdict='denied',valid_until=NULL,nonce=NULL,barrier=barrier+1 WHERE environment=g.environment AND organization_id=g.organization_id
   AND task_id IN(SELECT id FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,grant_id)=(g.environment,g.organization_id,g.id));
 END IF;
 IF st='allowed' AND(u<=clock_timestamp() OR a.deadline_at<=clock_timestamp()) THEN
  UPDATE pactwoven.native_delegation_proofs SET verdict='unknown',valid_until=NULL WHERE(environment,organization_id,task_id)=(t.environment,t.organization_id,t.id);st:='unavailable'; END IF;
 RETURN jsonb_build_object('state',st,'observedAt',pactwoven.mandate_instant(a.prepared_at),'validUntil',CASE WHEN st='allowed' THEN pactwoven.mandate_instant(u) END);
END $$;
CREATE FUNCTION pactwoven.native_delegation_task_locked(e text,selector jsonb,with_lease boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE service jsonb;g pactwoven.native_delegation_grants%ROWTYPE;t pactwoven.native_delegation_tasks%ROWTYPE;a pactwoven.native_delegation_proofs%ROWTYPE;b jsonb;u timestamptz;
BEGIN
 service:=pactwoven.native_delegation_service(e,ARRAY['coordinator','worker']);PERFORM pactwoven.native_delegation_target(selector,with_lease);
 SELECT * INTO t FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(e,selector->>'organizationId',selector->>'taskId');
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='ND001',MESSAGE='Assigned task required'; END IF;
 g:=pactwoven.native_delegation_grant_locked(e,t.organization_id,t.grant_id);
 SELECT * INTO t FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(e,t.organization_id,t.id) FOR UPDATE;
 b:=pactwoven.native_delegation_provider_binding(g,t);
 SELECT * INTO a FROM pactwoven.native_delegation_proofs WHERE(environment,organization_id,task_id)=(e,t.organization_id,t.id) FOR SHARE;
 u:=least(pactwoven.supplier_time(g.body->'expiresAt'),t.deadline_at,(b->>'memberExpiry')::timestamptz,a.valid_until,CASE WHEN with_lease THEN t.lease_until END);
 IF t.identity IS DISTINCT FROM service OR t.authority IS DISTINCT FROM pactwoven.native_delegation_reference(g)
  OR t.generation::text<>selector->>'generation' OR t.state NOT IN('ready','running') OR u<=clock_timestamp()
  OR a.task_id IS NULL OR a.verdict<>'allowed' OR a.binding IS DISTINCT FROM b OR a.valid_until<=clock_timestamp()
  OR(with_lease AND(t.state<>'running' OR t.lease_token IS NULL OR t.lease_until<=clock_timestamp() OR t.lease_token::text IS DISTINCT FROM selector->>'leaseToken' OR t.handoff_id IS DISTINCT FROM selector->>'handoffId'))
  OR EXISTS(SELECT 1 FROM unnest(t.ancestors[1:cardinality(t.ancestors)-1]) ancestor(ancestor_id) LEFT JOIN pactwoven.native_delegation_tasks parent
    ON(parent.environment,parent.organization_id,parent.id)=(e,t.organization_id,ancestor.ancestor_id) WHERE parent.id IS NULL OR parent.state<>'running') THEN
  RAISE EXCEPTION USING ERRCODE='ND001',MESSAGE='Current assignment, grant and provider proof required'; END IF;
 RETURN jsonb_build_object('environment',e,'organizationId',t.organization_id,'siteId',t.site_id,'reader',jsonb_build_object('kind','agent','id',service->>'serviceId'),
  'purpose','task_context','usage',jsonb_build_object('kind','task','taskId',t.id,'generation',t.generation,'handoffId',t.handoff_id),
  'authority',t.authority,'assignmentVersion',t.assignment_version,'validUntil',pactwoven.mandate_instant(u));
END $$;
CREATE FUNCTION pactwoven.native_delegation_task_context_locked(p_environment text,p_selector jsonb,p_operation text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c jsonb;
BEGIN
 IF p_operation IS NULL OR p_operation NOT IN('memory_read','result_publish') THEN RAISE EXCEPTION USING ERRCODE='ND004',MESSAGE='Unsupported task context operation'; END IF;
 c:=pactwoven.native_delegation_task_locked(p_environment,p_selector,true);
 IF p_operation='memory_read' AND(p_selector->'handoffId'='null'::jsonb OR NOT EXISTS(SELECT 1 FROM pactwoven.native_delegation_grants g
  WHERE(g.environment,g.organization_id,g.id)=(p_environment,c->>'organizationId',c#>>'{authority,grantId}') AND g.body#>'{scope,capabilities}' ? 'read_scoped_memory')) THEN
  RAISE EXCEPTION USING ERRCODE='ND001',MESSAGE='Scoped memory capability and child task required'; END IF;
 RETURN c;
END $$;
CREATE FUNCTION pactwoven.native_delegation_claim(p_environment text,p_selector jsonb,p_lease_ms integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c jsonb;t pactwoven.native_delegation_tasks%ROWTYPE;u timestamptz;
BEGIN
 IF p_lease_ms IS NULL OR p_lease_ms NOT BETWEEN 1000 AND 30000 THEN RAISE EXCEPTION USING ERRCODE='ND004',MESSAGE='Bounded lease required'; END IF;
 c:=pactwoven.native_delegation_task_locked(p_environment,p_selector,false);
 SELECT * INTO t FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(p_environment,p_selector->>'organizationId',p_selector->>'taskId');
 IF t.state='running' AND(t.lease_token IS NULL OR t.lease_until<=clock_timestamp()) THEN RAISE EXCEPTION USING ERRCODE='ND009',MESSAGE='Fenced retry required after lease expiry'; END IF;
 IF t.state='ready' THEN
  u:=least(clock_timestamp()+p_lease_ms*interval '1 millisecond',pactwoven.supplier_time(c->'validUntil'));
  UPDATE pactwoven.native_delegation_tasks SET state='running',lease_token=gen_random_uuid(),lease_until=u WHERE(environment,organization_id,id)=(t.environment,t.organization_id,t.id) RETURNING * INTO t;
 END IF;
 IF t.lease_until<=clock_timestamp() THEN RAISE EXCEPTION USING ERRCODE='ND001',MESSAGE='Lease expired while claiming'; END IF;
 RETURN jsonb_build_object('selector',jsonb_build_object('organizationId',t.organization_id,'taskId',t.id,'generation',t.generation,'handoffId',t.handoff_id,'leaseToken',t.lease_token),
  'validUntil',pactwoven.mandate_instant(t.lease_until),'identity',t.identity,'authority',t.authority,'attempt',t.attempt,
  'handoff',(SELECT body FROM pactwoven.native_delegation_envelopes WHERE(environment,organization_id,handoff_id,assignment_version,generation,kind)=(t.environment,t.organization_id,t.handoff_id,t.assignment_version,t.generation,'handoff')));
END $$;
CREATE FUNCTION pactwoven.native_delegation_renew(p_environment text,p_selector jsonb,p_lease_ms integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c jsonb;u timestamptz;
BEGIN
 IF p_lease_ms IS NULL OR p_lease_ms NOT BETWEEN 1000 AND 30000 THEN RAISE EXCEPTION USING ERRCODE='ND004',MESSAGE='Bounded lease required'; END IF;
 c:=pactwoven.native_delegation_task_context_locked(p_environment,p_selector,'result_publish');
 -- The current lease must still be valid. New expiry may use the refreshed
 -- proof, but can never restore an expired/changed generation.
 SELECT least(clock_timestamp()+p_lease_ms*interval '1 millisecond',a.valid_until,t.deadline_at,pactwoven.supplier_time(g.body->'expiresAt'),m.expires_at) INTO u
  FROM pactwoven.native_delegation_tasks t JOIN pactwoven.native_delegation_grants g ON(g.environment,g.organization_id,g.id)=(t.environment,t.organization_id,t.grant_id)
  JOIN pactwoven.native_delegation_proofs a ON(a.environment,a.organization_id,a.task_id)=(t.environment,t.organization_id,t.id)
  JOIN pactwoven.memberships m ON(m.environment,m.organization_id,m.actor_id)=(g.environment,g.organization_id,g.actor_id)
  WHERE(t.environment,t.organization_id,t.id)=(p_environment,p_selector->>'organizationId',p_selector->>'taskId');
 UPDATE pactwoven.native_delegation_tasks SET lease_until=u WHERE(environment,organization_id,id)=(p_environment,p_selector->>'organizationId',p_selector->>'taskId');
 IF u<=clock_timestamp() OR pactwoven.supplier_time(c->'validUntil')<=clock_timestamp() THEN RAISE EXCEPTION USING ERRCODE='ND001',MESSAGE='Lease expired while renewing'; END IF;
 RETURN jsonb_build_object('validUntil',pactwoven.mandate_instant(u));
END $$;
CREATE FUNCTION pactwoven.native_delegation_inputs_locked(e text,o text,s text,refs jsonb) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE ref jsonb;a pactwoven.native_delegation_artifacts%ROWTYPE;u timestamptz;
BEGIN
 IF jsonb_array_length(refs)<>(SELECT count(DISTINCT value->>'artifactId') FROM jsonb_array_elements(refs)) THEN RAISE EXCEPTION USING ERRCODE='ND004',MESSAGE='Unique artifact inputs required'; END IF;
 FOR ref IN SELECT value FROM jsonb_array_elements(refs) ORDER BY value->>'artifactId' COLLATE "C" LOOP
  IF(ref->>'environment',ref->>'organizationId',ref->>'siteId') IS DISTINCT FROM(e,o,s) THEN RAISE EXCEPTION USING ERRCODE='ND001',MESSAGE='Same-scope inputs required'; END IF;
  SELECT * INTO a FROM pactwoven.native_delegation_artifacts WHERE(environment,organization_id,id,revision)=(e,o,ref->>'artifactId',(ref->>'revision')::bigint) FOR SHARE;
  IF a.id IS NULL OR a.reference IS DISTINCT FROM ref OR a.valid_until<=clock_timestamp() OR a.memory_derived THEN
   -- No transitive memory laundering. A future provenance closure must bind
   -- these original usages to this task before such inputs are eligible.
   RAISE EXCEPTION USING ERRCODE='ND001',MESSAGE='Current input artifact provenance required'; END IF;
  u:=least(u,a.valid_until);
 END LOOP;
 RETURN u;
END $$;
CREATE FUNCTION pactwoven.native_delegation_handoff(p_environment text,p_parent jsonb,p_handoff jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c jsonb;g pactwoven.native_delegation_grants%ROWTYPE;p pactwoven.native_delegation_tasks%ROWTYPE;old pactwoven.native_delegation_envelopes%ROWTYPE;input_until timestamptz;deadline timestamptz;issued timestamptz;
BEGIN
 PERFORM pactwoven.native_delegation_require(p_handoff,'handoff');
 c:=pactwoven.native_delegation_task_context_locked(p_environment,p_parent,'result_publish');
 SELECT * INTO p FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(p_environment,p_parent->>'organizationId',p_parent->>'taskId');
 SELECT * INTO g FROM pactwoven.native_delegation_grants WHERE(environment,organization_id,id)=(p.environment,p.organization_id,p.grant_id);
 IF(p_handoff->>'environment',p_handoff->>'organizationId',p_handoff->>'siteId',p_handoff->>'rootTaskId',p_handoff->>'parentTaskId') IS DISTINCT FROM(p.environment,p.organization_id,p.site_id,p.root_task_id,p.id)
  OR p_handoff->'authority' IS DISTINCT FROM p.authority OR p_handoff->'sender' IS DISTINCT FROM p.identity
  OR p_handoff#>>'{sender,serviceId}'=p_handoff#>>'{recipient,serviceId}' THEN RAISE EXCEPTION USING ERRCODE='ND001',MESSAGE='Authenticated same-scope parent required'; END IF;
 SELECT * INTO old FROM pactwoven.native_delegation_envelopes WHERE(environment,organization_id,handoff_id,assignment_version,generation,kind)=
  (p.environment,p.organization_id,p_handoff->>'handoffId',(p_handoff->>'assignmentVersion')::bigint,(p_handoff->>'generation')::bigint,'handoff');
 IF FOUND THEN
  IF old.body IS DISTINCT FROM p_handoff THEN RAISE EXCEPTION USING ERRCODE='ND009',MESSAGE='Handoff envelope conflicts'; END IF;
  RETURN jsonb_build_object('kind','duplicate','execution','none','digest',old.digest);
 END IF;
 PERFORM 1 FROM pactwoven.native_delegation_services WHERE environment=p.environment AND service_id=p_handoff#>>'{recipient,serviceId}' FOR SHARE;
 deadline:=pactwoven.supplier_time(p_handoff->'deadlineAt');issued:=pactwoven.supplier_time(p_handoff->'issuedAt');
 IF p_handoff->'assignmentVersion'<>'1'::jsonb OR p_handoff->'generation'<>'1'::jsonb OR p_handoff->>'childTaskId'=ANY(p.ancestors)
  OR(p_handoff->>'depth')::integer<>p.depth+1 OR(p_handoff->>'depth')::integer>(g.body#>>'{scope,limits,maxDepth}')::integer
  OR(p_handoff->>'attemptLimit')::integer>(g.body#>>'{scope,limits,maxAttempts}')::integer
  OR(p_handoff->>'taskTimeoutMs')::integer>(g.body#>>'{scope,limits,taskTimeoutMs}')::integer
  OR NOT g.body#>'{scope,capabilities}' ? (p_handoff->>'capability')
  OR issued>clock_timestamp() OR issued<clock_timestamp()-interval '20 seconds' OR deadline<=clock_timestamp()
  OR deadline<=issued OR deadline>issued+(p_handoff->>'taskTimeoutMs')::integer*interval '1 millisecond' OR deadline>p.deadline_at
  OR g.children_created>=(g.body#>>'{scope,limits,maxChildren}')::integer OR g.active_children>=(g.body#>>'{scope,limits,maxConcurrentChildren}')::integer
  OR NOT EXISTS(SELECT 1 FROM pactwoven.native_delegation_services WHERE environment=p.environment AND identity=p_handoff->'recipient' AND purpose IN('coordinator','worker') AND enabled)
  OR EXISTS(SELECT 1 FROM pactwoven.native_delegation_tasks WHERE environment=p.environment AND organization_id=p.organization_id AND(id=p_handoff->>'childTaskId' OR handoff_id=p_handoff->>'handoffId')) THEN
  RAISE EXCEPTION USING ERRCODE='ND009',MESSAGE='Handoff limits, lineage, identity or deadline changed'; END IF;
 input_until:=pactwoven.native_delegation_inputs_locked(p.environment,p.organization_id,p.site_id,p_handoff->'inputArtifacts');
 INSERT INTO pactwoven.native_delegation_tasks(environment,organization_id,id,grant_id,site_id,root_task_id,parent_task_id,handoff_id,ancestors,depth,identity,authority,capability,state,attempt_limit,deadline_at)
  VALUES(p.environment,p.organization_id,p_handoff->>'childTaskId',g.id,p.site_id,p.root_task_id,p.id,p_handoff->>'handoffId',p.ancestors||ARRAY[p_handoff->>'childTaskId'],p.depth+1,p_handoff->'recipient',p.authority,p_handoff->>'capability','ready',(p_handoff->>'attemptLimit')::integer,deadline);
 INSERT INTO pactwoven.native_delegation_envelopes VALUES(p.environment,p.organization_id,p_handoff->>'handoffId',1,1,'handoff',p_handoff);
 INSERT INTO pactwoven.native_delegation_outbox(environment,organization_id,task_id,generation) VALUES(p.environment,p.organization_id,p_handoff->>'childTaskId',1);
 UPDATE pactwoven.native_delegation_grants SET children_created=children_created+1,active_children=active_children+1 WHERE(environment,organization_id,id)=(g.environment,g.organization_id,g.id);
 IF pactwoven.supplier_time(c->'validUntil')<=clock_timestamp() OR deadline<=clock_timestamp() OR(input_until IS NOT NULL AND input_until<=clock_timestamp()) THEN
  RAISE EXCEPTION USING ERRCODE='ND001',MESSAGE='Handoff authority expired while reserving'; END IF;
 RETURN jsonb_build_object('kind','accepted','execution','advisory_only','digest',pactwoven.native_delegation_hash(p_handoff));
END $$;
CREATE FUNCTION pactwoven.native_delegation_retry(p_environment text,p_parent jsonb,p_handoff jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c jsonb;p pactwoven.native_delegation_tasks%ROWTYPE;t pactwoven.native_delegation_tasks%ROWTYPE;old jsonb;u timestamptz;
BEGIN
 PERFORM pactwoven.native_delegation_require(p_handoff,'handoff');c:=pactwoven.native_delegation_task_context_locked(p_environment,p_parent,'result_publish');
 SELECT * INTO p FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(p_environment,p_parent->>'organizationId',p_parent->>'taskId');
 SELECT * INTO t FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,handoff_id)=(p.environment,p.organization_id,p_handoff->>'handoffId') FOR UPDATE;
 IF t.id IS NULL OR t.parent_task_id<>p.id OR t.identity IS DISTINCT FROM p_handoff->'recipient' THEN RAISE EXCEPTION USING ERRCODE='ND001',MESSAGE='Retained parent assignment required'; END IF;
 SELECT body INTO old FROM pactwoven.native_delegation_envelopes WHERE(environment,organization_id,handoff_id,assignment_version,generation,kind)=(t.environment,t.organization_id,t.handoff_id,t.assignment_version,t.generation,'handoff');
 IF p_handoff=old THEN RETURN jsonb_build_object('kind','duplicate','execution','none','digest',pactwoven.native_delegation_hash(old)); END IF;
 IF(p_handoff-'generation') IS DISTINCT FROM(old-'generation') OR(p_handoff->>'generation')::bigint<>t.generation+1
  OR t.state<>'running' OR t.lease_until>clock_timestamp() OR t.attempt>=t.attempt_limit OR t.deadline_at<=clock_timestamp()
  OR EXISTS(SELECT 1 FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,parent_task_id)=(t.environment,t.organization_id,t.id)) THEN
  RAISE EXCEPTION USING ERRCODE='ND009',MESSAGE='Bounded fenced retry required'; END IF;
 u:=pactwoven.native_delegation_inputs_locked(t.environment,t.organization_id,t.site_id,p_handoff->'inputArtifacts');
 UPDATE pactwoven.native_delegation_tasks SET state='ready',generation=generation+1,attempt=attempt+1,lease_token=NULL,lease_until=NULL WHERE(environment,organization_id,id)=(t.environment,t.organization_id,t.id) RETURNING * INTO t;
 INSERT INTO pactwoven.native_delegation_envelopes VALUES(t.environment,t.organization_id,t.handoff_id,t.assignment_version,t.generation,'handoff',p_handoff);
 INSERT INTO pactwoven.native_delegation_outbox(environment,organization_id,task_id,generation) VALUES(t.environment,t.organization_id,t.id,t.generation);
 UPDATE pactwoven.native_delegation_proofs SET verdict='unknown',valid_until=NULL,nonce=NULL,barrier=barrier+1 WHERE(environment,organization_id,task_id)=(t.environment,t.organization_id,t.id);
 IF pactwoven.supplier_time(c->'validUntil')<=clock_timestamp() OR t.deadline_at<=clock_timestamp() OR(u IS NOT NULL AND u<=clock_timestamp()) THEN RAISE EXCEPTION USING ERRCODE='ND001',MESSAGE='Retry authority expired'; END IF;
 RETURN jsonb_build_object('kind','accepted','execution','advisory_only','digest',pactwoven.native_delegation_hash(p_handoff));
END $$;
CREATE FUNCTION pactwoven.native_delegation_result_commit(p_environment text,p_selector jsonb,p_publication jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c jsonb;service jsonb;r jsonb;g pactwoven.native_delegation_grants%ROWTYPE;t pactwoven.native_delegation_tasks%ROWTYPE;h pactwoven.native_delegation_envelopes%ROWTYPE;
 prior pactwoven.native_delegation_results%ROWTYPE;artifact jsonb;ref jsonb;publication_digest text;u timestamptz;finished timestamptz;evidence_until timestamptz;ignored jsonb;
BEGIN
 service:=pactwoven.native_delegation_service(p_environment,ARRAY['coordinator','worker']);PERFORM pactwoven.native_delegation_target(p_selector,true);
 IF NOT pactwoven.supplier_object(p_publication,ARRAY['result','artifacts','inputArtifacts','memoryUsage']) OR octet_length(p_publication::text)>524288
  OR jsonb_typeof(p_publication->'artifacts') IS DISTINCT FROM 'array' OR jsonb_array_length(p_publication->'artifacts')>32
  OR jsonb_typeof(p_publication->'inputArtifacts') IS DISTINCT FROM 'array' OR jsonb_array_length(p_publication->'inputArtifacts')>32
  OR jsonb_typeof(p_publication->'memoryUsage') IS DISTINCT FROM 'array' OR jsonb_array_length(p_publication->'memoryUsage')>128 THEN
  RAISE EXCEPTION USING ERRCODE='ND004',MESSAGE='Normalized result publication required'; END IF;
 r:=p_publication->'result';PERFORM pactwoven.native_delegation_require(r,'result');
 IF(r->>'environment',r->>'organizationId',r->>'childTaskId',r->>'handoffId',r->>'generation') IS DISTINCT FROM(p_environment,p_selector->>'organizationId',p_selector->>'taskId',p_selector->>'handoffId',p_selector->>'generation')
  OR r->'sender' IS DISTINCT FROM service THEN RAISE EXCEPTION USING ERRCODE='ND001',MESSAGE='Authenticated assigned result sender required'; END IF;
 publication_digest:=pactwoven.native_delegation_hash(p_publication);
 SELECT * INTO prior FROM pactwoven.native_delegation_results WHERE(environment,organization_id,handoff_id)=(p_environment,r->>'organizationId',r->>'handoffId');
 IF FOUND THEN
  IF prior.publication IS DISTINCT FROM p_publication THEN RAISE EXCEPTION USING ERRCODE='ND009',MESSAGE='Accepted result conflicts'; END IF;
  RETURN jsonb_build_object('kind','duplicate','execution','none','publicationDigest',prior.digest,'domainCompletion',false);
 END IF;
 SELECT * INTO t FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(p_environment,r->>'organizationId',r->>'childTaskId');
 IF t.id IS NULL THEN RAISE EXCEPTION USING ERRCODE='ND001',MESSAGE='Assigned result task required'; END IF;
 g:=pactwoven.native_delegation_grant_locked(t.environment,t.organization_id,t.grant_id);
 -- Grant lock serializes a concurrent unknown-ACK duplicate before inspection.
 SELECT * INTO prior FROM pactwoven.native_delegation_results WHERE(environment,organization_id,handoff_id)=(p_environment,r->>'organizationId',r->>'handoffId');
 IF FOUND THEN
  IF prior.publication IS DISTINCT FROM p_publication THEN RAISE EXCEPTION USING ERRCODE='ND009',MESSAGE='Accepted result conflicts'; END IF;
  RETURN jsonb_build_object('kind','duplicate','execution','none','publicationDigest',prior.digest,'domainCompletion',false);
 END IF;
 c:=pactwoven.native_delegation_task_context_locked(p_environment,p_selector,'result_publish');
 SELECT * INTO t FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(p_environment,r->>'organizationId',r->>'childTaskId');
 SELECT * INTO h FROM pactwoven.native_delegation_envelopes WHERE(environment,organization_id,handoff_id,assignment_version,generation,kind)=(t.environment,t.organization_id,t.handoff_id,t.assignment_version,t.generation,'handoff');
 finished:=pactwoven.supplier_time(r->'finishedAt');evidence_until:=CASE WHEN r->'evidenceValidUntil'<>'null'::jsonb THEN pactwoven.supplier_time(r->'evidenceValidUntil') END;
 IF h.handoff_id IS NULL OR r->'authority' IS DISTINCT FROM t.authority OR r->'recipient' IS DISTINCT FROM h.body->'sender'
  OR r->>'handoffDigest'<>h.digest OR(r->>'assignmentVersion')::bigint<>t.assignment_version OR(r->>'attempt')::integer<>t.attempt
  OR p_publication->'inputArtifacts' IS DISTINCT FROM h.body->'inputArtifacts'
  OR finished>clock_timestamp() OR finished<pactwoven.supplier_time(h.body->'issuedAt') OR finished>=t.deadline_at
  OR jsonb_array_length(r->'artifacts')<>(SELECT count(DISTINCT value->>'artifactId') FROM jsonb_array_elements(r->'artifacts'))
  OR(r->>'outcome'='advice_ready' AND(jsonb_array_length(r->'artifacts')=0 OR evidence_until IS NULL OR evidence_until<=clock_timestamp()))
  OR(r->>'outcome'='failed' AND(jsonb_array_length(r->'artifacts')<>0 OR r->'evidenceValidUntil'<>'null'::jsonb))
  OR jsonb_array_length(p_publication->'artifacts')<>jsonb_array_length(r->'artifacts')
  OR EXISTS(SELECT 1 FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,parent_task_id)=(t.environment,t.organization_id,t.id) AND state<>'settled') THEN
  RAISE EXCEPTION USING ERRCODE='ND009',MESSAGE='Exact current advisory result required'; END IF;
 u:=pactwoven.native_delegation_inputs_locked(t.environment,t.organization_id,t.site_id,h.body->'inputArtifacts');
 IF u IS NOT NULL AND evidence_until>u THEN RAISE EXCEPTION USING ERRCODE='ND001',MESSAGE='Result evidence outlives inputs'; END IF;
 FOR artifact IN SELECT value FROM jsonb_array_elements(p_publication->'artifacts') LOOP
  IF NOT pactwoven.supplier_object(artifact,ARRAY['reference','body']) OR jsonb_typeof(artifact->'body') IS DISTINCT FROM 'object' OR octet_length((artifact->'body')::text)>65536 THEN
   RAISE EXCEPTION USING ERRCODE='ND004',MESSAGE='Artifact body required'; END IF;
  ref:=artifact->'reference';
  IF NOT r->'artifacts' @> jsonb_build_array(ref) OR(ref->>'environment',ref->>'organizationId',ref->>'siteId') IS DISTINCT FROM(t.environment,t.organization_id,t.site_id)
   OR coalesce(ref->>'digest','')<>pactwoven.native_delegation_hash(artifact->'body') THEN RAISE EXCEPTION USING ERRCODE='ND004',MESSAGE='Artifact hash or scope mismatch'; END IF;
 END LOOP;
 IF(SELECT coalesce(jsonb_agg(value->'reference' ORDER BY ordinality),'[]'::jsonb) FROM jsonb_array_elements(p_publication->'artifacts') WITH ORDINALITY) IS DISTINCT FROM r->'artifacts' THEN
  RAISE EXCEPTION USING ERRCODE='ND004',MESSAGE='Exact ordered artifact bodies required'; END IF;
 -- Both helpers must exist together. Static names cannot be chosen by a caller.
 IF to_regprocedure('pactwoven.native_memory_assert_usage_locked(text,jsonb,jsonb,text)') IS NOT NULL
  AND to_regprocedure('pactwoven.native_memory_bind_artifact_locked(text,jsonb,jsonb,text)') IS NOT NULL THEN
  EXECUTE 'SELECT pactwoven.native_memory_assert_usage_locked($1,$2,$3,$4)' INTO ignored USING p_environment,c,p_publication->'memoryUsage',publication_digest;
  IF jsonb_array_length(p_publication->'memoryUsage')>0 THEN
   -- Source eligibility and provider authority have distinct clocks. Require
   -- the data-only closure deadline from the memory seam; an older seam that
   -- omits it fails closed rather than advertising evidence beyond its source.
   IF jsonb_typeof(ignored->'dataValidUntil') IS DISTINCT FROM 'string' OR pactwoven.supplier_time(ignored->'dataValidUntil')<=clock_timestamp()
    OR(evidence_until IS NOT NULL AND evidence_until>pactwoven.supplier_time(ignored->'dataValidUntil')) THEN
    RAISE EXCEPTION USING ERRCODE='ND001',MESSAGE='Result evidence outlives original memory data'; END IF;
  END IF;
 ELSIF p_publication->'memoryUsage'<>'[]'::jsonb OR to_regprocedure('pactwoven.native_memory_assert_usage_locked(text,jsonb,jsonb,text)') IS NOT NULL
  OR to_regprocedure('pactwoven.native_memory_bind_artifact_locked(text,jsonb,jsonb,text)') IS NOT NULL THEN
  RAISE EXCEPTION USING ERRCODE='ND001',MESSAGE='Memory provenance validation unavailable'; END IF;
 INSERT INTO pactwoven.native_delegation_results(environment,organization_id,handoff_id,result_id,assignment_version,generation,publication)
  VALUES(t.environment,t.organization_id,t.handoff_id,r->>'resultId',t.assignment_version,t.generation,p_publication);
 FOR artifact IN SELECT value FROM jsonb_array_elements(p_publication->'artifacts') LOOP
  ref:=artifact->'reference';
  INSERT INTO pactwoven.native_delegation_artifacts VALUES(t.environment,t.organization_id,ref->>'artifactId',(ref->>'revision')::bigint,t.site_id,t.id,ref,artifact->'body',evidence_until,
   p_publication->'memoryUsage'<>'[]'::jsonb,publication_digest);
 END LOOP;
 IF to_regprocedure('pactwoven.native_memory_bind_artifact_locked(text,jsonb,jsonb,text)') IS NOT NULL THEN
  EXECUTE 'SELECT pactwoven.native_memory_bind_artifact_locked($1,$2,$3,$4)' INTO ignored USING p_environment,c,p_publication->'memoryUsage',publication_digest;
 END IF;
 -- Re-observe deadlines after memory locks and all writes; exceptions roll back
 -- result, artifact, provenance binding and counters together.
 PERFORM pactwoven.native_delegation_task_context_locked(p_environment,p_selector,'result_publish');
 IF pactwoven.supplier_time(c->'validUntil')<=clock_timestamp() OR(u IS NOT NULL AND u<=clock_timestamp()) OR(evidence_until IS NOT NULL AND evidence_until<=clock_timestamp()) THEN
  RAISE EXCEPTION USING ERRCODE='ND001',MESSAGE='Result authority expired while publishing'; END IF;
 UPDATE pactwoven.native_delegation_tasks SET state='settled',lease_token=NULL,lease_until=NULL WHERE(environment,organization_id,id)=(t.environment,t.organization_id,t.id);
 UPDATE pactwoven.native_delegation_grants SET active_children=active_children-1 WHERE(environment,organization_id,id)=(t.environment,t.organization_id,t.grant_id);
 RETURN jsonb_build_object('kind','accepted','execution','advisory_only','publicationDigest',publication_digest,'domainCompletion',false);
END $$;
-- Dispatch is an at-least-once wake-up channel. An envelope never grants work:
-- claim always revalidates enrollment, current proof, assignment and ancestry.
CREATE FUNCTION pactwoven.native_delegation_outbox_claim(p_environment text,p_limit integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE d pactwoven.native_delegation_outbox%ROWTYPE;items jsonb:='[]'::jsonb;
BEGIN
 PERFORM pactwoven.native_delegation_service(p_environment,ARRAY['dispatcher']);
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 20 THEN RAISE EXCEPTION USING ERRCODE='ND004',MESSAGE='Bounded dispatch batch required'; END IF;
 FOR d IN SELECT * FROM pactwoven.native_delegation_outbox WHERE environment=p_environment AND(state='pending' OR(state='publishing' AND lease_until<=clock_timestamp()))
  ORDER BY organization_id,task_id,generation LIMIT p_limit FOR UPDATE SKIP LOCKED LOOP
  UPDATE pactwoven.native_delegation_outbox SET state='publishing',token=gen_random_uuid(),lease_until=clock_timestamp()+interval '15 seconds'
   WHERE(environment,organization_id,task_id,generation)=(d.environment,d.organization_id,d.task_id,d.generation) RETURNING * INTO d;
  items:=items||jsonb_build_array(jsonb_build_object('target',jsonb_build_object('organizationId',d.organization_id,'taskId',d.task_id,'generation',d.generation),'token',d.token));
 END LOOP;
 RETURN items;
END $$;
CREATE FUNCTION pactwoven.native_delegation_outbox_ack(p_environment text,p_selector jsonb,p_token uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 PERFORM pactwoven.native_delegation_service(p_environment,ARRAY['dispatcher']);PERFORM pactwoven.native_delegation_target(p_selector,false);
 UPDATE pactwoven.native_delegation_outbox SET state='published',lease_until=NULL WHERE(environment,organization_id,task_id,generation)=(p_environment,p_selector->>'organizationId',p_selector->>'taskId',(p_selector->>'generation')::bigint)
  AND state='publishing' AND token=p_token AND lease_until>clock_timestamp();RETURN FOUND;
END $$;

-- Immutable retained evidence is owner-written through the reviewed wrappers.
CREATE TRIGGER native_delegation_history_immutable BEFORE UPDATE OR DELETE ON pactwoven.native_delegation_history FOR EACH ROW EXECUTE FUNCTION pactwoven.financial_immutable();
CREATE TRIGGER native_delegation_envelope_immutable BEFORE UPDATE OR DELETE ON pactwoven.native_delegation_envelopes FOR EACH ROW EXECUTE FUNCTION pactwoven.financial_immutable();
CREATE TRIGGER native_delegation_result_immutable BEFORE UPDATE OR DELETE ON pactwoven.native_delegation_results FOR EACH ROW EXECUTE FUNCTION pactwoven.financial_immutable();
CREATE TRIGGER native_delegation_artifact_immutable BEFORE UPDATE OR DELETE ON pactwoven.native_delegation_artifacts FOR EACH ROW EXECUTE FUNCTION pactwoven.financial_immutable();
DO $$ DECLARE n text;r record;BEGIN
 FOREACH n IN ARRAY ARRAY['services','service_bindings','policies','grants','history','tasks','envelopes','results','artifacts','proofs','outbox'] LOOP
  EXECUTE format('ALTER TABLE pactwoven.%I ENABLE ROW LEVEL SECURITY','native_delegation_'||n);
  EXECUTE format('REVOKE ALL ON pactwoven.%I FROM PUBLIC,pactwoven_native_delegation_api,pactwoven_native_delegation_coordinator,pactwoven_native_delegation_worker,pactwoven_native_delegation_dispatcher','native_delegation_'||n);
 END LOOP;
 FOR r IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='pactwoven' AND p.proname LIKE 'native_delegation_%' LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,pactwoven_native_delegation_api,pactwoven_native_delegation_coordinator,pactwoven_native_delegation_worker,pactwoven_native_delegation_dispatcher',r.signature);
 END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION pactwoven.native_delegation_binding(text,text) TO pactwoven_native_delegation_api,pactwoven_native_delegation_coordinator,pactwoven_native_delegation_worker,pactwoven_native_delegation_dispatcher;
GRANT EXECUTE ON FUNCTION pactwoven.native_delegation_issue(jsonb,text,jsonb,jsonb),pactwoven.native_delegation_read(jsonb,text),pactwoven.native_delegation_revoke(jsonb,jsonb),
 pactwoven.native_delegation_authority_prepare(text,jsonb,text),pactwoven.native_delegation_authority_finish(text,uuid,jsonb) TO pactwoven_native_delegation_api;
GRANT EXECUTE ON FUNCTION pactwoven.native_delegation_claim(text,jsonb,integer),pactwoven.native_delegation_renew(text,jsonb,integer),pactwoven.native_delegation_handoff(text,jsonb,jsonb),
 pactwoven.native_delegation_retry(text,jsonb,jsonb),pactwoven.native_delegation_result_commit(text,jsonb,jsonb) TO pactwoven_native_delegation_coordinator,pactwoven_native_delegation_worker;
GRANT EXECUTE ON FUNCTION pactwoven.native_delegation_outbox_claim(text,integer),pactwoven.native_delegation_outbox_ack(text,jsonb,uuid) TO pactwoven_native_delegation_dispatcher;
COMMIT;
