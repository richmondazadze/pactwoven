BEGIN;

-- A closure is an immutable receipt for one original request key. It never creates a policy result.
CREATE FUNCTION pactwoven.financial_policy_closure_schema(k text) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT CASE k
 WHEN 'locator' THEN $schema${"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{"responsibilityId":{"anyOf":[{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},{"type":"null"}]},"kind":{"type":"string","enum":["save_document","save_draft"]},"key":{"type":"string","minLength":16,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"targetId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"publicRequestHash":{"type":"string","pattern":"^[a-f0-9]{64}$"}},"required":["responsibilityId","kind","key","targetId","publicRequestHash"],"additionalProperties":false}$schema$::jsonb
 WHEN 'intent' THEN $schema${"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{"schemaVersion":{"type":"number","const":1},"purpose":{"type":"string","const":"financial_policy_original_close"},"reason":{"type":"string","const":"original_input_unavailable"},"locator":{"type":"object","properties":{"responsibilityId":{"anyOf":[{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},{"type":"null"}]},"kind":{"type":"string","enum":["save_document","save_draft"]},"key":{"type":"string","minLength":16,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"targetId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"publicRequestHash":{"type":"string","pattern":"^[a-f0-9]{64}$"}},"required":["responsibilityId","kind","key","targetId","publicRequestHash"],"additionalProperties":false},"expected":{"type":"object","properties":{"organizationEpoch":{"type":"integer","minimum":0,"maximum":2147483647},"draftScope":{"anyOf":[{"type":"object","properties":{"authority":{"type":"object","properties":{"schemaVersion":{"type":"number","const":1},"environment":{"type":"string","enum":["simulation","development","staging","production"]},"organizationId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"responsibility":{"type":"object","properties":{"id":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"version":{"type":"integer","minimum":1,"maximum":2147483647},"hash":{"type":"string","pattern":"^[a-f0-9]{64}$"},"siteId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"}},"required":["id","version","hash","siteId"],"additionalProperties":false},"generation":{"type":"integer","minimum":0,"maximum":2147483647},"family":{"type":"string","enum":["none","legacy"]},"legacyHead":{"anyOf":[{"type":"object","properties":{"mandateId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"mandateVersion":{"type":"integer","minimum":1,"maximum":2147483647},"mandateEpoch":{"type":"integer","minimum":1,"maximum":2147483647},"hash":{"type":"string","pattern":"^[a-f0-9]{64}$"},"state":{"type":"string","enum":["ACTIVE","PAUSED","REVOKED","EXPIRED"]}},"required":["mandateId","mandateVersion","mandateEpoch","hash","state"],"additionalProperties":false},{"type":"null"}]}},"required":["schemaVersion","environment","organizationId","responsibility","generation","family","legacyHead"],"additionalProperties":false},"authorityHash":{"type":"string","pattern":"^[a-f0-9]{64}$"},"site":{"type":"object","properties":{"id":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"generation":{"type":"integer","minimum":0,"maximum":2147483647},"recordHash":{"type":"string","pattern":"^[a-f0-9]{64}$"}},"required":["id","generation","recordHash"],"additionalProperties":false}},"required":["authority","authorityHash","site"],"additionalProperties":false},{"type":"null"}]}},"required":["organizationEpoch","draftScope"],"additionalProperties":false}},"required":["schemaVersion","purpose","reason","locator","expected"],"additionalProperties":false}$schema$::jsonb
 WHEN 'receipt' THEN $schema${"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{"schemaVersion":{"type":"number","const":1},"id":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"environment":{"type":"string","enum":["simulation","development","staging","production"]},"organizationId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"actor":{"type":"object","properties":{"actorId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"membershipVersion":{"type":"integer","minimum":1,"maximum":2147483647}},"required":["actorId","membershipVersion"],"additionalProperties":false},"locator":{"type":"object","properties":{"responsibilityId":{"anyOf":[{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},{"type":"null"}]},"kind":{"type":"string","enum":["save_document","save_draft"]},"key":{"type":"string","minLength":16,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"targetId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"publicRequestHash":{"type":"string","pattern":"^[a-f0-9]{64}$"}},"required":["responsibilityId","kind","key","targetId","publicRequestHash"],"additionalProperties":false},"reason":{"type":"string","const":"original_input_unavailable"},"expected":{"type":"object","properties":{"environment":{"type":"string","enum":["simulation","development","staging","production"]},"organizationId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"actor":{"type":"object","properties":{"actorId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"membershipVersion":{"type":"integer","minimum":1,"maximum":2147483647}},"required":["actorId","membershipVersion"],"additionalProperties":false},"organizationEpoch":{"type":"integer","minimum":0,"maximum":2147483647},"draftScope":{"anyOf":[{"type":"object","properties":{"authority":{"type":"object","properties":{"schemaVersion":{"type":"number","const":1},"responsibility":{"type":"object","properties":{"id":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"version":{"type":"integer","minimum":1,"maximum":2147483647},"hash":{"type":"string","pattern":"^[a-f0-9]{64}$"},"siteId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"}},"required":["id","version","hash","siteId"],"additionalProperties":false},"generation":{"type":"integer","minimum":0,"maximum":2147483647},"family":{"type":"string","enum":["none","legacy"]},"legacyHead":{"anyOf":[{"type":"object","properties":{"mandateId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"mandateVersion":{"type":"integer","minimum":1,"maximum":2147483647},"mandateEpoch":{"type":"integer","minimum":1,"maximum":2147483647},"hash":{"type":"string","pattern":"^[a-f0-9]{64}$"},"state":{"type":"string","enum":["ACTIVE","PAUSED","REVOKED","EXPIRED"]}},"required":["mandateId","mandateVersion","mandateEpoch","hash","state"],"additionalProperties":false},{"type":"null"}]}},"required":["schemaVersion","responsibility","generation","family","legacyHead"],"additionalProperties":false},"authorityHash":{"type":"string","pattern":"^[a-f0-9]{64}$"},"site":{"type":"object","properties":{"id":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"generation":{"type":"integer","minimum":0,"maximum":2147483647},"recordHash":{"type":"string","pattern":"^[a-f0-9]{64}$"}},"required":["id","generation","recordHash"],"additionalProperties":false}},"required":["authority","authorityHash","site"],"additionalProperties":false},{"type":"null"}]}},"required":["environment","organizationId","actor","organizationEpoch","draftScope"],"additionalProperties":false},"closedAt":{"type":"string","pattern":"^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$"},"effectiveAuthority":{"type":"boolean","const":false},"financialState":{"type":"null"},"recordHash":{"type":"string","pattern":"^[a-f0-9]{64}$"}},"required":["schemaVersion","id","environment","organizationId","actor","locator","reason","expected","closedAt","effectiveAuthority","financialState","recordHash"],"additionalProperties":false}$schema$::jsonb
 END
$$;
CREATE FUNCTION pactwoven.financial_policy_closure_require(k text,v jsonb) RETURNS void LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE q jsonb;BEGIN
 IF NOT coalesce(pactwoven.financial_policy_matches(v,pactwoven.financial_policy_closure_schema(k)),false) OR octet_length(v::text)>8192
 THEN RAISE EXCEPTION USING ERRCODE='FP004',MESSAGE='Exact bounded original closure material required';END IF;
 q:=CASE WHEN k='locator' THEN v ELSE v->'locator' END;
 IF q->>'kind'='save_draft' AND(q->'responsibilityId'='null'::jsonb OR q->>'targetId'='context')
 THEN RAISE EXCEPTION USING ERRCODE='FP004',MESSAGE='Exact original request route required';END IF;
 IF k IN('intent','receipt') AND((q->'responsibilityId'='null'::jsonb)<>(v#>'{expected,draftScope}'='null'::jsonb)
  OR q->'responsibilityId'<>'null'::jsonb AND(v#>>'{expected,draftScope,authority,responsibility,id}' IS DISTINCT FROM q->>'responsibilityId'
   OR v#>>'{expected,draftScope,site,id}' IS DISTINCT FROM v#>>'{expected,draftScope,authority,responsibility,siteId}'))
 THEN RAISE EXCEPTION USING ERRCODE='FP004',MESSAGE='Exact closure responsibility basis required';END IF;
END $$;
CREATE FUNCTION pactwoven.financial_policy_closure_hash(v jsonb) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT pactwoven.finance_hash(jsonb_build_object('namespace','pactwoven:financial-policy-request-closure:v1','record',v))
$$;
CREATE FUNCTION pactwoven.financial_policy_closure_public_expected(s jsonb,i jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('environment',s->'environment','organizationId',s->'organizationId',
  'actor',jsonb_build_object('actorId',s#>'{actor,actorId}','membershipVersion',s#>'{actor,membershipVersion}'),
  'organizationEpoch',i#>'{expected,organizationEpoch}','draftScope',CASE WHEN i#>'{expected,draftScope}'='null'::jsonb THEN NULL
   ELSE jsonb_set(i#>'{expected,draftScope}','{authority}',(i#>'{expected,draftScope,authority}')-ARRAY['environment','organizationId']) END)
$$;
CREATE FUNCTION pactwoven.financial_policy_closure_public_hash(a text,v jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE input jsonb;route text;BEGIN
 PERFORM pactwoven.financial_policy_require('command',v);
 input:=jsonb_build_object('schemaVersion',1,'previous',v->'previous','organizationEpoch',v->'organizationEpoch');
 IF v->>'kind'='save_document' THEN
  input:=input||jsonb_build_object('purpose',v->'purpose','text',v->'text');
  route:=CASE WHEN v->'responsibilityId'='null'::jsonb THEN '/v1/financial-governance/documents/' ELSE '/v1/responsibilities/'||(v->>'responsibilityId')||'/financial-policy-documents/' END||(v->>'id');
 ELSIF v->>'kind'='save_draft' THEN
  IF v->>'id'='context' THEN RAISE EXCEPTION USING ERRCODE='FP008',MESSAGE='Original public route unavailable';END IF;
  input:=input||jsonb_build_object('draft',jsonb_set(v->'draft','{scope,authority}',(v#>'{draft,scope,authority}')-ARRAY['environment','organizationId']));
  route:='/v1/responsibilities/'||(v->>'responsibilityId')||'/financial-policies/'||(v->>'id');
 ELSE RAISE EXCEPTION USING ERRCODE='FP004',MESSAGE='Only original configuration saves can be closed';END IF;
 RETURN pactwoven.finance_hash(jsonb_build_object('namespace','pactwoven:financial-policy-http-request:v1','environment',v->'environment',
  'organizationId',v->'organizationId','actorId',a,'kind',v->'kind','route',route,'key',v->'key','input',input));
END $$;

CREATE TABLE pactwoven.financial_policy_request_fences(
 id uuid PRIMARY KEY,environment text NOT NULL,organization_id text NOT NULL,actor_id text NOT NULL,kind text NOT NULL CHECK(kind IN('save_document','save_draft')),key text NOT NULL,
 responsibility_id text,locator jsonb NOT NULL,intent jsonb NOT NULL,scope jsonb NOT NULL,context jsonb NOT NULL,
 identity_evidence_id uuid NOT NULL REFERENCES pactwoven.financial_policy_evidence(id),identity_evidence_hash text NOT NULL,
 authorizer_oid oid NOT NULL,authorizer_name text NOT NULL,authorizer_version integer NOT NULL CHECK(authorizer_version>0),
 closed_at timestamptz NOT NULL,body jsonb NOT NULL,
 record_hash text GENERATED ALWAYS AS(pactwoven.financial_policy_closure_hash(body)) STORED NOT NULL,
 UNIQUE(environment,organization_id,actor_id,kind,key),
 FOREIGN KEY(environment,organization_id,actor_id) REFERENCES pactwoven.memberships(environment,organization_id,actor_id),
 FOREIGN KEY(environment,organization_id) REFERENCES pactwoven.organizations(environment,id)
);

CREATE FUNCTION pactwoven.financial_policy_closure_current(c jsonb,s jsonb,i jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE rid text:=i#>>'{locator,responsibilityId}';f pactwoven.financial_authority_fences%ROWTYPE;site pactwoven.financial_site_fences%ROWTYPE;expected jsonb;BEGIN
 IF i#>'{expected,organizationEpoch}' IS DISTINCT FROM c->'organizationEpoch' OR i#>'{expected,organizationEpoch}' IS DISTINCT FROM s->'organizationEpoch'
 THEN RAISE EXCEPTION USING ERRCODE='FP002',MESSAGE='Current closure organization pins required';END IF;
 IF rid IS NULL THEN
  IF NOT(c->'roles' ? 'owner') THEN RAISE EXCEPTION USING ERRCODE='FP001',MESSAGE='Current original owner required for organization closure';END IF;
  expected:='null'::jsonb;
 ELSE
  SELECT * INTO f FROM pactwoven.financial_authority_fences WHERE environment=s->>'environment' AND organization_id=s->>'organizationId' AND responsibility_id=rid;
  SELECT * INTO site FROM pactwoven.financial_site_fences WHERE environment=s->>'environment' AND organization_id=s->>'organizationId' AND site_id=c#>>'{responsibility,siteId}' FOR SHARE;
  IF f.responsibility_id IS NULL OR site.site_id IS NULL OR NOT site.active THEN RAISE EXCEPTION USING ERRCODE='FP002',MESSAGE='Current closure responsibility unavailable';END IF;
  expected:=jsonb_build_object('authority',pactwoven.financial_authority_snapshot(f),'authorityHash',pactwoven.financial_authority_fence_hash(f),
   'site',jsonb_build_object('id',site.site_id,'generation',site.generation,'recordHash',site.record_hash));
 END IF;
 IF i#>'{expected,draftScope}' IS DISTINCT FROM expected THEN RAISE EXCEPTION USING ERRCODE='FP002',MESSAGE='Current exact closure authority and site pins required';END IF;
 PERFORM pactwoven.financial_policy_reader_finish(c);
END $$;

-- Historical validation uses retained immutable evidence and closing-time pins, never today's membership version.
CREATE FUNCTION pactwoven.financial_policy_closure_audit(f pactwoven.financial_policy_request_fences) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE e pactwoven.financial_policy_evidence%ROWTYPE;p pactwoven.financial_policy_principals%ROWTYPE;r jsonb;BEGIN
 PERFORM pactwoven.financial_policy_closure_require('locator',f.locator);PERFORM pactwoven.financial_policy_closure_require('intent',f.intent);
 PERFORM pactwoven.financial_policy_reader_require('scope',f.scope);
 r:=f.body||jsonb_build_object('recordHash',pactwoven.financial_policy_closure_hash(f.body));PERFORM pactwoven.financial_policy_closure_require('receipt',r);
 SELECT * INTO e FROM pactwoven.financial_policy_evidence WHERE id=f.identity_evidence_id;
 SELECT * INTO p FROM pactwoven.financial_policy_principals WHERE principal_oid=f.authorizer_oid AND environment=f.environment AND organization_id=f.organization_id AND version=f.authorizer_version;
 IF f.body ? 'recordHash' OR (f.record_hash IS NOT NULL AND f.record_hash<>r->>'recordHash') OR f.locator IS DISTINCT FROM f.intent->'locator'
  OR f.locator->>'kind' IS DISTINCT FROM f.kind OR f.locator->>'key' IS DISTINCT FROM f.key OR f.locator->>'responsibilityId' IS DISTINCT FROM f.responsibility_id
  OR f.scope->>'environment' IS DISTINCT FROM f.environment OR f.scope->>'organizationId' IS DISTINCT FROM f.organization_id OR f.scope#>>'{actor,actorId}' IS DISTINCT FROM f.actor_id
  OR e.id IS NULL OR e.kind<>'identity' OR e.environment<>f.environment OR e.organization_id<>f.organization_id OR e.hash IS DISTINCT FROM f.identity_evidence_hash
  OR NOT EXISTS(SELECT 1 FROM pactwoven.financial_policy_principals vp WHERE vp.principal_oid=e.principal_oid AND vp.principal_name=e.principal_name
   AND vp.environment=f.environment AND vp.organization_id=f.organization_id AND vp.version=e.principal_version AND vp.capability='verifier' AND vp.active AND vp.expires_at>f.closed_at)
  OR f.context->'identity' IS DISTINCT FROM e.body OR f.scope->'actor' IS DISTINCT FROM e.body->'actor' OR f.scope->'externalOrganizationId' IS DISTINCT FROM e.body->'externalOrganizationId'
  OR f.scope->'organizationEpoch' IS DISTINCT FROM f.context->'organizationEpoch'
  -- Reader roles are canonical; retained membership order is not. Sorting preserves duplicate evidence.
  OR f.scope->'roles' IS DISTINCT FROM (SELECT jsonb_agg(role ORDER BY role COLLATE "C") FROM jsonb_array_elements_text(f.context->'roles') AS retained(role))
  OR f.scope->'organizationEpoch' IS DISTINCT FROM f.intent#>'{expected,organizationEpoch}'
  OR f.responsibility_id IS NULL AND f.context->'responsibility'<>'null'::jsonb
  OR f.responsibility_id IS NOT NULL AND(
   f.intent#>>'{expected,draftScope,authority,responsibility,hash}' IS DISTINCT FROM pactwoven.finance_hash(f.context->'responsibility')
   OR f.intent#>>'{expected,draftScope,authorityHash}' IS DISTINCT FROM pactwoven.finance_hash(jsonb_build_object('namespace','pactwoven:financial-authority-fence:v1','record',f.intent#>'{expected,draftScope,authority}'))
   OR NOT EXISTS(SELECT 1 FROM pactwoven.financial_authority_history h WHERE h.environment=f.environment AND h.organization_id=f.organization_id
    AND h.responsibility_id=f.responsibility_id AND h.generation=(f.intent#>>'{expected,draftScope,authority,generation}')::int AND h.snapshot=f.intent#>'{expected,draftScope,authority}')
   OR NOT EXISTS(SELECT 1 FROM pactwoven.financial_site_history h WHERE h.environment=f.environment AND h.organization_id=f.organization_id
    AND h.site_id=f.intent#>>'{expected,draftScope,site,id}' AND h.generation=(f.intent#>>'{expected,draftScope,site,generation}')::int
    AND h.snapshot->>'recordHash'=f.intent#>>'{expected,draftScope,site,recordHash}' AND h.snapshot->'active'='true'::jsonb
    AND h.snapshot->>'recordHash'=pactwoven.financial_site_record_hash(h.record)))
  OR p.principal_oid IS NULL OR p.principal_name IS DISTINCT FROM f.authorizer_name OR p.capability<>'authorizer' OR NOT p.active OR p.expires_at<=f.closed_at
  OR NOT pactwoven.financial_policy_valid('evidence',e.body)
  OR (e.body->>'observedAt')::timestamptz>f.closed_at OR (e.body->>'observedAt')::timestamptz<f.closed_at-interval '20 seconds'
  OR (e.body->>'expiresAt')::timestamptz<=f.closed_at OR (e.body->>'sessionExpiresAt')::timestamptz<=f.closed_at
  OR f.body IS DISTINCT FROM jsonb_build_object('schemaVersion',1,'id',f.id,'environment',f.environment,'organizationId',f.organization_id,
   'actor',jsonb_build_object('actorId',f.actor_id,'membershipVersion',f.scope#>'{actor,membershipVersion}'),'locator',f.locator,'reason','original_input_unavailable',
   'expected',pactwoven.financial_policy_closure_public_expected(f.scope,f.intent),'closedAt',pactwoven.mandate_instant(f.closed_at),'effectiveAuthority',false,'financialState',NULL)
  OR EXISTS(SELECT 1 FROM pactwoven.financial_policy_operations WHERE environment=f.environment AND organization_id=f.organization_id AND actor_id=f.actor_id AND kind=f.kind AND key=f.key)
 THEN RAISE EXCEPTION USING ERRCODE='FP008',MESSAGE='Original closure audit is not reciprocal';END IF;
 RETURN r;
END $$;

CREATE FUNCTION pactwoven.financial_policy_closure_insert_guard() RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c jsonb;who oid;p pactwoven.financial_policy_principals%ROWTYPE;BEGIN
 PERFORM pactwoven.financial_require_read_committed();
 -- Separate volatile statements take a fresh READ COMMITTED snapshot after the shared organization lock wait.
 PERFORM id FROM pactwoven.organizations WHERE environment=NEW.environment AND id=NEW.organization_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='FP001',MESSAGE='Original request organization required';END IF;
 IF TG_TABLE_NAME='financial_policy_operations' THEN
  IF EXISTS(SELECT 1 FROM pactwoven.financial_policy_request_fences WHERE environment=NEW.environment AND organization_id=NEW.organization_id AND actor_id=NEW.actor_id AND kind=NEW.kind AND key=NEW.key)
  THEN RAISE EXCEPTION USING ERRCODE='FP005',MESSAGE='This original financial policy request key is closed';END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM pactwoven.financial_policy_operations WHERE environment=NEW.environment AND organization_id=NEW.organization_id AND actor_id=NEW.actor_id AND kind=NEW.kind AND key=NEW.key)
  THEN RAISE EXCEPTION USING ERRCODE='FP005',MESSAGE='An original financial policy result already exists';END IF;
  PERFORM pactwoven.financial_policy_closure_audit(NEW);
  c:=pactwoven.financial_policy_reader_context(NEW.identity_evidence_id,NEW.scope,NEW.responsibility_id);
  PERFORM pactwoven.financial_policy_closure_current(c,NEW.scope,NEW.intent);
  who:=pactwoven.financial_policy_principal(NEW.environment,NEW.organization_id,'authorizer');
  SELECT * INTO p FROM pactwoven.financial_policy_principals WHERE principal_oid=who AND environment=NEW.environment AND organization_id=NEW.organization_id ORDER BY version DESC LIMIT 1;
  IF NEW.context IS DISTINCT FROM c OR NEW.authorizer_oid<>who OR NEW.authorizer_name IS DISTINCT FROM p.principal_name OR NEW.authorizer_version<>p.version
   OR NEW.closed_at>clock_timestamp() OR NEW.closed_at<clock_timestamp()-interval '1 second'
  THEN RAISE EXCEPTION USING ERRCODE='FP008',MESSAGE='Exact current closure provenance required';END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER financial_policy_key_fence BEFORE INSERT ON pactwoven.financial_policy_operations FOR EACH ROW EXECUTE FUNCTION pactwoven.financial_policy_closure_insert_guard();
CREATE TRIGGER financial_policy_key_fence BEFORE INSERT ON pactwoven.financial_policy_request_fences FOR EACH ROW EXECUTE FUNCTION pactwoven.financial_policy_closure_insert_guard();
CREATE TRIGGER financial_policy_no_mutation BEFORE UPDATE OR DELETE ON pactwoven.financial_policy_request_fences FOR EACH ROW EXECUTE FUNCTION pactwoven.financial_policy_immutable();
CREATE TRIGGER financial_policy_no_truncate BEFORE TRUNCATE ON pactwoven.financial_policy_request_fences FOR EACH STATEMENT EXECUTE FUNCTION pactwoven.financial_policy_immutable();
ALTER TABLE pactwoven.financial_policy_request_fences ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pactwoven.financial_policy_request_fences FROM PUBLIC,pactwoven_runtime,pactwoven_provisioner,pactwoven_access_provisioner,pactwoven_mandate_writer,pactwoven_finance_observer,pactwoven_custody_setup_writer,pactwoven_custody_setup_verifier,pactwoven_financial_verifier,pactwoven_financial_authorizer;

CREATE FUNCTION pactwoven.financial_policy_closure_lookup(s jsonb,q jsonb) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE op uuid;v jsonb;f pactwoven.financial_policy_request_fences%ROWTYPE;BEGIN
 -- This broad key lookup MUST precede responsibility/target/hash comparisons. Absence is never inferred from a filtered lookup.
 SELECT id INTO op FROM pactwoven.financial_policy_operations WHERE environment=s->>'environment' AND organization_id=s->>'organizationId'
  AND actor_id=s#>>'{actor,actorId}' AND kind=q->>'kind' AND key=q->>'key';
 IF op IS NOT NULL THEN
  v:=pactwoven.financial_policy_original_checked(op);
  IF v#>>'{command,responsibilityId}' IS DISTINCT FROM q->>'responsibilityId' OR v#>>'{command,id}' IS DISTINCT FROM q->>'targetId'
   OR pactwoven.financial_policy_closure_public_hash(s#>>'{actor,actorId}',v->'command') IS DISTINCT FROM q->>'publicRequestHash'
  THEN RAISE EXCEPTION USING ERRCODE='FP005',MESSAGE='The original key names different reviewed material';END IF;
  IF v#>>'{result,body,actor,subject}' IS DISTINCT FROM s#>>'{actor,subject}' OR v#>>'{result,body,actor,externalMembershipId}' IS DISTINCT FROM s#>>'{actor,externalMembershipId}'
  THEN RAISE EXCEPTION USING ERRCODE='FP001',MESSAGE='Current original policy actor required';END IF;
  IF EXISTS(SELECT 1 FROM pactwoven.financial_policy_request_fences WHERE environment=s->>'environment' AND organization_id=s->>'organizationId' AND actor_id=s#>>'{actor,actorId}' AND kind=q->>'kind' AND key=q->>'key')
  THEN RAISE EXCEPTION USING ERRCODE='FP008',MESSAGE='Original request and closure are mutually exclusive';END IF;
  RETURN jsonb_build_object('status','recorded','original',v,'closure',NULL);
 END IF;
 SELECT * INTO f FROM pactwoven.financial_policy_request_fences WHERE environment=s->>'environment' AND organization_id=s->>'organizationId'
  AND actor_id=s#>>'{actor,actorId}' AND kind=q->>'kind' AND key=q->>'key';
 IF f.id IS NOT NULL THEN
  IF f.locator IS DISTINCT FROM q THEN RAISE EXCEPTION USING ERRCODE='FP005',MESSAGE='The closed key names different reviewed material';END IF;
  IF f.scope#>>'{actor,subject}' IS DISTINCT FROM s#>>'{actor,subject}' OR f.scope#>>'{actor,externalMembershipId}' IS DISTINCT FROM s#>>'{actor,externalMembershipId}'
  THEN RAISE EXCEPTION USING ERRCODE='FP001',MESSAGE='Current original closure actor required';END IF;
  RETURN jsonb_build_object('status','closed','original',NULL,'closure',pactwoven.financial_policy_closure_audit(f));
 END IF;
 RETURN jsonb_build_object('status','not_recorded','original',NULL,'closure',NULL);
END $$;
CREATE FUNCTION pactwoven.financial_policy_original_status(eid uuid,s jsonb,q jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='3s' AS $$
DECLARE c jsonb;r jsonb;BEGIN
 PERFORM pactwoven.financial_policy_closure_require('locator',q);c:=pactwoven.financial_policy_reader_context(eid,s,q->>'responsibilityId');
 IF q->'responsibilityId'='null'::jsonb AND NOT(c->'roles' ?| ARRAY['owner','finance']) THEN RAISE EXCEPTION USING ERRCODE='FP001',MESSAGE='Current organization policy reader required';END IF;
 r:=pactwoven.financial_policy_closure_lookup(s,q);PERFORM pactwoven.financial_policy_reader_finish(c);RETURN r;
END $$;
CREATE FUNCTION pactwoven.financial_policy_close_original(eid uuid,s jsonb,i jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='3s' AS $$
DECLARE c jsonb;r jsonb;q jsonb;who oid;p pactwoven.financial_policy_principals%ROWTYPE;f pactwoven.financial_policy_request_fences%ROWTYPE;BEGIN
 PERFORM pactwoven.financial_policy_closure_require('intent',i);q:=i->'locator';c:=pactwoven.financial_policy_reader_context(eid,s,q->>'responsibilityId');
 IF q->'responsibilityId'='null'::jsonb AND NOT(c->'roles' ?| ARRAY['owner','finance']) THEN RAISE EXCEPTION USING ERRCODE='FP001',MESSAGE='Current original organization reader required';END IF;
 r:=pactwoven.financial_policy_closure_lookup(s,q);
 IF r->>'status'<>'not_recorded' THEN PERFORM pactwoven.financial_policy_reader_finish(c);RETURN r;END IF;
 PERFORM pactwoven.financial_policy_closure_current(c,s,i);who:=pactwoven.financial_policy_principal(s->>'environment',s->>'organizationId','authorizer');
 SELECT * INTO p FROM pactwoven.financial_policy_principals WHERE principal_oid=who AND environment=s->>'environment' AND organization_id=s->>'organizationId' ORDER BY version DESC LIMIT 1;
 f.id:=gen_random_uuid();f.environment:=s->>'environment';f.organization_id:=s->>'organizationId';f.actor_id:=s#>>'{actor,actorId}';f.kind:=q->>'kind';f.key:=q->>'key';
 f.responsibility_id:=q->>'responsibilityId';f.locator:=q;f.intent:=i;f.scope:=s;f.context:=c;f.identity_evidence_id:=eid;
 f.identity_evidence_hash:=pactwoven.financial_policy_hash('evidence',c->'identity');f.authorizer_oid:=who;f.authorizer_name:=p.principal_name;f.authorizer_version:=p.version;
 f.closed_at:=date_trunc('milliseconds',clock_timestamp());
 f.body:=jsonb_build_object('schemaVersion',1,'id',f.id,'environment',f.environment,'organizationId',f.organization_id,
  'actor',jsonb_build_object('actorId',f.actor_id,'membershipVersion',s#>'{actor,membershipVersion}'),'locator',q,'reason','original_input_unavailable',
  'expected',pactwoven.financial_policy_closure_public_expected(s,i),'closedAt',pactwoven.mandate_instant(f.closed_at),'effectiveAuthority',false,'financialState',NULL);
 INSERT INTO pactwoven.financial_policy_request_fences(id,environment,organization_id,actor_id,kind,key,responsibility_id,locator,intent,scope,context,identity_evidence_id,identity_evidence_hash,authorizer_oid,authorizer_name,authorizer_version,closed_at,body)
 VALUES(f.id,f.environment,f.organization_id,f.actor_id,f.kind,f.key,f.responsibility_id,f.locator,f.intent,f.scope,f.context,f.identity_evidence_id,f.identity_evidence_hash,f.authorizer_oid,f.authorizer_name,f.authorizer_version,f.closed_at,f.body);
 RETURN pactwoven.financial_policy_closure_lookup(s,q);
END $$;

CREATE OR REPLACE FUNCTION pactwoven.financial_policy_role_safe(who oid,cap text) RETURNS boolean LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$
 WITH RECURSIVE reachable(oid) AS(SELECT who UNION SELECT m.roleid FROM pg_auth_members m JOIN reachable x ON x.oid=m.member),
 expected AS(SELECT to_regprocedure(name) AS oid FROM unnest(CASE cap WHEN 'verifier' THEN ARRAY['pactwoven.financial_policy_attest(jsonb)','pactwoven.financial_policy_resolve_observer(text,jsonb)']
  WHEN 'authorizer' THEN ARRAY['pactwoven.financial_policy_command(uuid,jsonb)','pactwoven.financial_policy_read(uuid,jsonb)','pactwoven.financial_policy_list(uuid,jsonb)','pactwoven.financial_policy_recover(uuid,jsonb)','pactwoven.financial_policy_read_context(uuid,jsonb,jsonb)','pactwoven.financial_policy_governance_index(uuid,jsonb,jsonb)','pactwoven.financial_policy_original_read(uuid,jsonb,jsonb)','pactwoven.financial_policy_proposer_observation(uuid,jsonb,jsonb)','pactwoven.financial_policy_prepare(uuid,jsonb,jsonb)','pactwoven.financial_policy_close_original(uuid,jsonb,jsonb)','pactwoven.financial_policy_original_status(uuid,jsonb,jsonb)'] ELSE ARRAY[]::text[] END) name),
 relations AS(SELECT c.* FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='pactwoven' AND c.relkind IN('r','p','v','m','f','S')),
 routines AS(SELECT p.* FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='pactwoven' OR(p.prosecdef AND n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema'))
 SELECT EXISTS(SELECT 1 FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='pactwoven' AND t.relname='financial_policy_request_fences' AND t.relkind='r' AND t.relrowsecurity AND t.relowner=n.nspowner)
  AND cap IN('authorizer','verifier') AND coalesce(pactwoven.custody_system_privileges_safe(who),false)
  AND EXISTS(SELECT 1 FROM pg_roles WHERE oid=who AND rolcanlogin) AND pg_has_role(who,'pactwoven_financial_'||cap,'USAGE')
  AND NOT EXISTS(SELECT 1 FROM reachable x JOIN pg_roles r ON r.oid=x.oid WHERE r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication
   OR r.rolname IN('pactwoven_runtime','pactwoven_provisioner','pactwoven_access_provisioner','pactwoven_mandate_writer','pactwoven_finance_observer','pactwoven_custody_setup_writer','pactwoven_custody_setup_verifier',
     CASE cap WHEN 'authorizer' THEN 'pactwoven_financial_verifier' ELSE 'pactwoven_financial_authorizer' END))
  AND NOT EXISTS(SELECT 1 FROM reachable r JOIN pg_database d ON d.datdba=r.oid WHERE d.datname=current_database())
  AND NOT EXISTS(SELECT 1 FROM reachable r WHERE pg_has_role(r.oid,'pg_database_owner','USAGE') OR has_database_privilege(r.oid,current_database(),'CREATE'))
  AND NOT EXISTS(SELECT 1 FROM reachable r CROSS JOIN pg_namespace n WHERE n.nspname IN('pactwoven','public') AND(n.nspowner=r.oid OR pg_has_role(r.oid,n.nspowner,'USAGE') OR has_schema_privilege(r.oid,n.oid,'CREATE')))
  AND NOT EXISTS(SELECT 1 FROM reachable r CROSS JOIN relations t WHERE t.relowner=r.oid OR(t.relkind='S' AND has_sequence_privilege(r.oid,t.oid,'USAGE,SELECT,UPDATE'))
    OR(t.relkind<>'S' AND(has_table_privilege(r.oid,t.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') OR has_any_column_privilege(r.oid,t.oid,'SELECT,INSERT,UPDATE,REFERENCES'))))
  AND NOT EXISTS(SELECT 1 FROM reachable r CROSS JOIN routines f WHERE f.proowner=r.oid OR(has_function_privilege(r.oid,f.oid,'EXECUTE') AND f.oid NOT IN(SELECT oid FROM expected WHERE oid IS NOT NULL)))
  AND NOT EXISTS(SELECT 1 FROM expected e LEFT JOIN routines f ON f.oid=e.oid WHERE f.oid IS NULL OR NOT f.prosecdef
    OR f.proowner<>(SELECT nspowner FROM pg_namespace WHERE nspname='pactwoven') OR NOT(coalesce(f.proconfig,ARRAY[]::text[]) @> ARRAY['search_path=pg_catalog']) OR NOT has_function_privilege(who,f.oid,'EXECUTE'))
$$;

DO $$DECLARE routine regprocedure;BEGIN
 FOR routine IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='pactwoven'
  AND(p.proname LIKE 'financial_policy_closure_%' OR p.proname IN('financial_policy_close_original','financial_policy_original_status')) LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,pactwoven_runtime,pactwoven_provisioner,pactwoven_access_provisioner,pactwoven_mandate_writer,pactwoven_finance_observer,pactwoven_custody_setup_writer,pactwoven_custody_setup_verifier,pactwoven_financial_verifier,pactwoven_financial_authorizer',routine);
 END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION pactwoven.financial_policy_close_original(uuid,jsonb,jsonb),pactwoven.financial_policy_original_status(uuid,jsonb,jsonb) TO pactwoven_financial_authorizer;
COMMIT;
