BEGIN;
DO $$ BEGIN IF CURRENT_USER<>SESSION_USER OR NOT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='pactwoven' AND nspowner=CURRENT_USER::regrole) OR to_regprocedure('pactwoven.native_agent_work_list(jsonb,jsonb)') IS NULL THEN RAISE EXCEPTION 'Exact existing schema owner and migrations through 0031 required';END IF;END $$;
-- Source: .local/native-google-discovery/schema.sql
CREATE FUNCTION pactwoven.native_google_discovery_schema(k text) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT $schema${"begin":{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{"connectionId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"target":{"type":"object","properties":{"calendarId":{"type":"string","const":"primary"},"eventId":{"type":"string","pattern":"^[A-Za-z0-9_-]{1,128}$"}},"required":["calendarId","eventId"],"additionalProperties":false},"allowRead":{"type":"boolean","const":true}},"required":["connectionId","target","allowRead"],"additionalProperties":false},"event":{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{"kind":{"type":"string","const":"calendar#event"},"id":{"type":"string","pattern":"^[A-Za-z0-9_-]{1,128}$"},"etag":{"type":"string","minLength":1,"maxLength":512,"pattern":"^[^\\s\\u0000-\\u001f\\u007f]+$"},"status":{"type":"string","enum":["confirmed","tentative"]},"updated":{"type":"string","format":"date-time","pattern":"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"},"summary":{"type":"string","minLength":1,"maxLength":300},"start":{"type":"object","properties":{"dateTime":{"type":"string","format":"date-time","pattern":"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"}},"required":["dateTime"],"additionalProperties":false},"end":{"type":"object","properties":{"dateTime":{"type":"string","format":"date-time","pattern":"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"}},"required":["dateTime"],"additionalProperties":false}},"required":["kind","id","etag","status","updated","summary","start","end"],"additionalProperties":false},"prepare":{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{"baselineReference":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"taskReference":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"purpose":{"type":"string","minLength":1,"maxLength":1000},"durationMinutes":{"anyOf":[{"type":"number","const":15},{"type":"number","const":60},{"type":"number","const":240},{"type":"number","const":1440}]}},"required":["baselineReference","taskReference","purpose","durationMinutes"],"additionalProperties":false},"baseline":{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{"reference":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"eventName":{"type":"string","minLength":1,"maxLength":300},"calendarName":{"type":"string","const":"Primary calendar"},"startsAt":{"type":"string","format":"date-time","pattern":"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"},"endsAt":{"type":"string","format":"date-time","pattern":"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"},"validUntil":{"type":"string","format":"date-time","pattern":"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"}},"required":["reference","eventName","calendarName","startsAt","endsAt","validUntil"],"additionalProperties":false},"review":{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{"id":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"token":{"type":"string","pattern":"^[a-f0-9]{64}$"},"rootTitle":{"type":"string","minLength":1,"maxLength":300},"siteName":{"type":"string","minLength":1,"maxLength":300},"accountEmail":{"type":"string","const":"richverseecotech@gmail.com"},"eventName":{"type":"string","minLength":1,"maxLength":300},"calendarName":{"type":"string","const":"Primary calendar"},"startsAt":{"type":"string","format":"date-time","pattern":"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"},"endsAt":{"type":"string","format":"date-time","pattern":"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"},"purpose":{"type":"string","minLength":1,"maxLength":1000},"expiresAt":{"type":"string","format":"date-time","pattern":"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"},"confirmBy":{"type":"string","format":"date-time","pattern":"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"},"permission":{"type":"string","const":"read_single_calendar_event"},"outboundEffects":{"type":"string","const":"forbidden"},"continuesAfterSignOut":{"type":"boolean","const":true}},"required":["id","token","rootTitle","siteName","accountEmail","eventName","calendarName","startsAt","endsAt","purpose","expiresAt","confirmBy","permission","outboundEffects","continuesAfterSignOut"],"additionalProperties":false},"overview":{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{"availability":{"type":"string","enum":["ready","unavailable"]},"connections":{"maxItems":100,"type":"array","items":{"type":"object","properties":{"id":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"version":{"type":"integer","exclusiveMinimum":0,"maximum":9007199254740991},"email":{"type":"string","const":"richverseecotech@gmail.com"},"status":{"type":"string","enum":["connected","refreshing","revoked","unavailable"]}},"required":["id","version","email","status"],"additionalProperties":false}},"tasks":{"maxItems":500,"type":"array","items":{"type":"object","properties":{"reference":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"title":{"type":"string","minLength":1,"maxLength":300},"siteName":{"type":"string","minLength":1,"maxLength":300}},"required":["reference","title","siteName"],"additionalProperties":false}},"consents":{"maxItems":500,"type":"array","items":{"anyOf":[{"type":"object","properties":{"id":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"version":{"type":"integer","exclusiveMinimum":0,"maximum":9007199254740991},"rootTitle":{"type":"string","minLength":1,"maxLength":300},"expiresAt":{"type":"string","format":"date-time","pattern":"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"},"status":{"type":"string","enum":["prepared","approved","active","revoked"]},"details":{"type":"string","const":"available"},"eventName":{"type":"string","minLength":1,"maxLength":300},"calendarName":{"type":"string","const":"Primary calendar"},"startsAt":{"type":"string","format":"date-time","pattern":"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"},"endsAt":{"type":"string","format":"date-time","pattern":"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"}},"required":["id","version","rootTitle","expiresAt","status","details","eventName","calendarName","startsAt","endsAt"],"additionalProperties":false},{"type":"object","properties":{"id":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"version":{"type":"integer","exclusiveMinimum":0,"maximum":9007199254740991},"rootTitle":{"type":"string","minLength":1,"maxLength":300},"expiresAt":{"type":"string","format":"date-time","pattern":"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"},"status":{"type":"string","enum":["prepared","approved","active","revoked"]},"details":{"type":"string","const":"unavailable"},"preparedAt":{"type":"string","format":"date-time","pattern":"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"}},"required":["id","version","rootTitle","expiresAt","status","details","preparedAt"],"additionalProperties":false}]}}},"required":["availability","connections","tasks","consents"],"additionalProperties":false}}$schema$::jsonb->k $$;

-- Source: .local/native-google-discovery/draft.sql
-- New unnumbered discovery draft. Install only in the isolated qualification DB.
CREATE TABLE pactwoven.native_google_discovery_bindings(login name,role_oid oid NOT NULL,environment text,PRIMARY KEY(login,environment));
CREATE TABLE pactwoven.native_google_discovery_requests(
 environment text,id text,organization_id text NOT NULL,actor_id text NOT NULL,connection_id text NOT NULL,
 binding jsonb NOT NULL,session jsonb NOT NULL,target jsonb NOT NULL,producer name NOT NULL,producer_oid oid NOT NULL,
 state text NOT NULL CHECK(state IN('requested','reserved','complete','failed')),operation_id text,reader name,reader_oid oid,
 requested_at timestamptz NOT NULL,reserved_at timestamptz,expires_at timestamptz NOT NULL,refreshing boolean NOT NULL DEFAULT false,
 PRIMARY KEY(environment,id));
CREATE TABLE pactwoven.native_google_discovery_baselines(
 environment text,organization_id text,id text,request_id text NOT NULL,actor_id text NOT NULL,session_id text NOT NULL,
 authenticated_at timestamptz NOT NULL,connection_id text NOT NULL,binding jsonb NOT NULL,target jsonb NOT NULL,
 event jsonb NOT NULL,digest text NOT NULL,receipt jsonb NOT NULL,producer name NOT NULL,producer_oid oid NOT NULL,
 observed_at timestamptz NOT NULL,valid_until timestamptz NOT NULL,PRIMARY KEY(environment,organization_id,id),UNIQUE(environment,request_id));
CREATE TABLE pactwoven.native_google_discovery_preparations(
 environment text,organization_id text,actor_id text,request_key text,input jsonb NOT NULL,baseline_id text NOT NULL,
 review_id text NOT NULL,named_review jsonb NOT NULL,PRIMARY KEY(environment,organization_id,actor_id,request_key),UNIQUE(environment,organization_id,review_id));

CREATE FUNCTION pactwoven.native_google_discovery_validate(v jsonb,k text) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN PERFORM pactwoven.native_google_require(octet_length(v::text)<=262144 AND pactwoven.native_delegation_matches(v,pactwoven.native_google_discovery_schema(k))); END $$;
CREATE FUNCTION pactwoven.native_google_discovery_name(v text,maximum integer DEFAULT 300) RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
BEGIN
 PERFORM pactwoven.native_google_require(v IS NOT NULL AND length(v)>0 AND length(v)<=maximum AND v=btrim(v) AND v!~'[[:cntrl:]]'
  AND v!~*'(bearer[[:space:]]|access[_-]?token|client[_-]?secret|refresh[_-]?token|-----BEGIN|sk-[A-Za-z0-9]|https?://)'
  AND v!~*'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}' AND v!~'^[A-Za-z0-9_-]{32,}$'
  AND v!~'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+'
  AND v!~U&'[\202A-\202E\2066-\2069]','NG004');
 RETURN v;
END $$;
CREATE FUNCTION pactwoven.native_google_discovery_reader(env text,login_name name,login_oid oid) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 PERFORM 1 FROM pactwoven.native_google_discovery_bindings b JOIN pg_roles r ON r.oid=b.role_oid AND r.rolname=b.login
 WHERE b.environment=env AND b.login=login_name AND b.role_oid=login_oid AND NOT(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolbypassrls OR r.rolreplication) FOR SHARE OF b;
 PERFORM pactwoven.native_google_require(FOUND,'NG001');
END $$;
CREATE FUNCTION pactwoven.native_google_discovery_reader_lane(env text) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN PERFORM pactwoven.financial_require_read_committed();PERFORM set_config('lock_timeout','2000ms',true);PERFORM set_config('statement_timeout','8000ms',true);PERFORM pactwoven.native_google_discovery_reader(env,SESSION_USER,(SELECT oid FROM pg_roles WHERE rolname=SESSION_USER));END $$;
CREATE FUNCTION pactwoven.native_google_discovery_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION USING ERRCODE='NG003',MESSAGE='Immutable discovery receipt';END $$;
CREATE TRIGGER native_google_discovery_baseline_immutable BEFORE UPDATE OR DELETE ON pactwoven.native_google_discovery_baselines FOR EACH ROW EXECUTE FUNCTION pactwoven.native_google_discovery_immutable();
CREATE TRIGGER native_google_discovery_preparation_immutable BEFORE UPDATE OR DELETE ON pactwoven.native_google_discovery_preparations FOR EACH ROW EXECUTE FUNCTION pactwoven.native_google_discovery_immutable();

CREATE FUNCTION pactwoven.native_google_discovery_begin(env text,s jsonb,q jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c jsonb;stamp timestamptz;rid text:=gen_random_uuid()::text;until_at timestamptz;
BEGIN
 PERFORM pactwoven.native_google_access_lane(env,'api');PERFORM pactwoven.native_google_discovery_validate(q,'begin');
 c:=pactwoven.native_google_access_connection(env,q->>'connectionId');PERFORM pactwoven.native_google_access_session(env,s);
 PERFORM pactwoven.native_google_require(c->>'status'='connected' AND c#>>'{binding,environment}'=env AND c#>>'{binding,organizationId}'=s#>>'{actor,organizationId}' AND c#>>'{binding,actorId}'=s#>>'{actor,actorId}','NG001');
 PERFORM pactwoven.native_google_require((SELECT count(*) FROM pactwoven.native_google_discovery_requests WHERE environment=env AND connection_id=q->>'connectionId' AND state IN('requested','reserved') AND expires_at>clock_timestamp())<3,'NG003');
 stamp:=clock_timestamp();until_at:=LEAST(stamp+interval '15 seconds',(s->>'expiresAt')::timestamptz,(s->>'verifiedAt')::timestamptz+interval '20 seconds');
 INSERT INTO pactwoven.native_google_discovery_requests(environment,id,organization_id,actor_id,connection_id,binding,session,target,producer,producer_oid,state,requested_at,expires_at)
 VALUES(env,rid,s#>>'{actor,organizationId}',s#>>'{actor,actorId}',q->>'connectionId',c->'binding',s,q->'target',SESSION_USER,(SELECT oid FROM pg_roles WHERE rolname=SESSION_USER),'requested',stamp,until_at);
 PERFORM pactwoven.native_google_session_fresh(s);PERFORM pactwoven.native_google_require(until_at>clock_timestamp(),'NG008');
 RETURN jsonb_build_object('id',rid);
END $$;
CREATE FUNCTION pactwoven.native_google_discovery_locked(env text,rid text,op text) RETURNS pactwoven.native_google_discovery_requests LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE r pactwoven.native_google_discovery_requests;c jsonb;
BEGIN
 SELECT * INTO r FROM pactwoven.native_google_discovery_requests WHERE(environment,id)=(env,rid) FOR UPDATE;
 PERFORM pactwoven.native_google_require(FOUND AND r.state='reserved' AND r.operation_id=op AND r.reader=SESSION_USER AND r.reader_oid=(SELECT oid FROM pg_roles WHERE rolname=SESSION_USER),'NG001');
 PERFORM pactwoven.native_google_access_producer(env,r.producer,r.producer_oid,'api');PERFORM pactwoven.native_google_access_session(env,r.session);
 c:=pactwoven.native_google_access_connection(env,r.connection_id);
 PERFORM pactwoven.native_google_require(c->'binding'=r.binding AND c#>>'{binding,organizationId}'=r.organization_id AND c#>>'{binding,actorId}'=r.actor_id AND r.expires_at>clock_timestamp(),'NG008');
 RETURN r;
END $$;
CREATE FUNCTION pactwoven.native_google_discovery_lease(r pactwoven.native_google_discovery_requests,c jsonb) RETURNS jsonb LANGUAGE sql SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('id',r.id,'operationId',r.operation_id,'session',r.session,'target',r.target,'connection',c,'expiresAt',pactwoven.mandate_instant(r.expires_at)) $$;
CREATE FUNCTION pactwoven.native_google_discovery_claim(env text,rid text,op text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r pactwoven.native_google_discovery_requests;c jsonb;
BEGIN
 PERFORM pactwoven.native_google_discovery_reader_lane(env);PERFORM pactwoven.native_google_require(rid~'^[A-Za-z0-9_-]{1,128}$' AND op~'^[A-Za-z0-9_-]{1,128}$');
 SELECT * INTO r FROM pactwoven.native_google_discovery_requests WHERE(environment,id)=(env,rid)FOR UPDATE;
 PERFORM pactwoven.native_google_require(FOUND AND r.state='requested','NG001');
 PERFORM pactwoven.native_google_access_producer(env,r.producer,r.producer_oid,'api');PERFORM pactwoven.native_google_access_session(env,r.session);
 c:=pactwoven.native_google_access_connection(env,r.connection_id);PERFORM pactwoven.native_google_require(c->>'status'='connected' AND c->'binding'=r.binding AND c#>>'{binding,organizationId}'=r.organization_id AND c#>>'{binding,actorId}'=r.actor_id AND r.expires_at>clock_timestamp(),'NG001');
 UPDATE pactwoven.native_google_discovery_requests SET state='reserved',operation_id=op,reader=SESSION_USER,reader_oid=(SELECT oid FROM pg_roles WHERE rolname=SESSION_USER),reserved_at=clock_timestamp() WHERE(environment,id)=(env,rid) RETURNING * INTO r;
 PERFORM pactwoven.native_google_session_fresh(r.session);PERFORM pactwoven.native_google_require(r.expires_at>clock_timestamp(),'NG008');
 RETURN pactwoven.native_google_discovery_lease(r,c);
END $$;
CREATE FUNCTION pactwoven.native_google_discovery_reserve_refresh(env text,rid text,op text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r pactwoven.native_google_discovery_requests;c jsonb;
BEGIN
 PERFORM pactwoven.native_google_discovery_reader_lane(env);r:=pactwoven.native_google_discovery_locked(env,rid,op);c:=pactwoven.native_google_access_connection(env,r.connection_id);
 PERFORM pactwoven.native_google_require(NOT r.refreshing AND c->>'status'='connected','NG003');
 c:=jsonb_set(c,'{status}','"refreshing"');UPDATE pactwoven.native_google_connections SET body=c,refresh_operation=op,refresh_until=r.expires_at WHERE(environment,id)=(env,r.connection_id);
 UPDATE pactwoven.native_google_discovery_requests SET refreshing=true WHERE(environment,id)=(env,rid);
 PERFORM pactwoven.native_google_session_fresh(r.session);PERFORM pactwoven.native_google_require(r.expires_at>clock_timestamp(),'NG008');RETURN c;
END $$;
CREATE FUNCTION pactwoven.native_google_discovery_complete_refresh(env text,rid text,op text,c jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r pactwoven.native_google_discovery_requests;old jsonb;expected jsonb;refresh_id text;refresh_expiry timestamptz;
BEGIN
 PERFORM pactwoven.native_google_discovery_reader_lane(env);PERFORM pactwoven.native_google_validate(c,'connection');r:=pactwoven.native_google_discovery_locked(env,rid,op);old:=pactwoven.native_google_access_connection(env,r.connection_id);
 SELECT refresh_operation,refresh_until INTO refresh_id,refresh_expiry FROM pactwoven.native_google_connections WHERE(environment,id)=(env,r.connection_id);
 expected:=jsonb_set(r.binding,'{credentialVersion}',to_jsonb((r.binding->>'credentialVersion')::bigint+1));
 PERFORM pactwoven.native_google_require(r.refreshing AND refresh_id=op AND refresh_expiry>clock_timestamp() AND old->>'status'='refreshing' AND c->>'status'='connected' AND c->'binding'=expected AND(c-'tokens'-'binding'-'status')=(old-'tokens'-'binding'-'status'),'NG003');
 UPDATE pactwoven.native_google_connections SET body=c,refresh_operation=NULL,refresh_until=NULL WHERE(environment,id)=(env,r.connection_id);
 UPDATE pactwoven.native_google_discovery_requests SET binding=expected,refreshing=false WHERE(environment,id)=(env,rid)RETURNING * INTO r;
 PERFORM pactwoven.native_google_session_fresh(r.session);PERFORM pactwoven.native_google_require(r.expires_at>clock_timestamp(),'NG008');RETURN pactwoven.native_google_discovery_lease(r,c);
END $$;
CREATE FUNCTION pactwoven.native_google_discovery_fail(env text,rid text,op text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r pactwoven.native_google_discovery_requests;c jsonb;
BEGIN
 PERFORM pactwoven.native_google_discovery_reader_lane(env);
 SELECT * INTO r FROM pactwoven.native_google_discovery_requests WHERE(environment,id)=(env,rid)FOR UPDATE;
 PERFORM pactwoven.native_google_require(FOUND AND r.operation_id=op AND r.reader=SESSION_USER AND r.reader_oid=(SELECT oid FROM pg_roles WHERE rolname=SESSION_USER),'NG001');
 IF r.state='reserved' THEN
  IF r.refreshing THEN
   SELECT body INTO c FROM pactwoven.native_google_connections WHERE(environment,id)=(env,r.connection_id)FOR UPDATE;
   IF c->'binding'=r.binding AND c->>'status'='refreshing' THEN UPDATE pactwoven.native_google_connections SET body=jsonb_set(c,'{status}','"unavailable"'),refresh_operation=NULL,refresh_until=NULL WHERE(environment,id)=(env,r.connection_id) AND refresh_operation=op;END IF;
  END IF;
  UPDATE pactwoven.native_google_discovery_requests SET state='failed',refreshing=false WHERE(environment,id)=(env,rid);
 END IF;
 RETURN true;
END $$;
CREATE FUNCTION pactwoven.native_google_discovery_complete(env text,rid text,op text,s jsonb,event jsonb,observed timestamptz) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r pactwoven.native_google_discovery_requests;bid text:=gen_random_uuid()::text;receipt jsonb;target jsonb;until_at timestamptz;digest text;c jsonb;
BEGIN
 PERFORM pactwoven.native_google_discovery_reader_lane(env);PERFORM pactwoven.native_google_discovery_validate(event,'event');r:=pactwoven.native_google_discovery_locked(env,rid,op);
 PERFORM pactwoven.native_google_access_session(env,s);
 PERFORM pactwoven.native_google_require(s#>>'{actor,actorId}'=r.actor_id AND s#>>'{actor,organizationId}'=r.organization_id AND s#>>'{actor,sessionId}'=r.session#>>'{actor,sessionId}' AND s#>>'{actor,authenticatedAt}'=r.session#>>'{actor,authenticatedAt}','NG001');
 c:=pactwoven.native_google_access_connection(env,r.connection_id);
 PERFORM pactwoven.native_google_require(NOT r.refreshing AND c->>'status'='connected' AND event->>'id'=r.target->>'eventId' AND observed>=r.reserved_at AND observed<=clock_timestamp() AND(event->>'updated')::timestamptz<=observed AND(event#>>'{end,dateTime}')::timestamptz>(event#>>'{start,dateTime}')::timestamptz AND event->>'summary' NOT IN(event->>'id',event->>'etag'),'NG001');
 PERFORM pactwoven.native_google_discovery_name(event->>'summary');
 target:=r.target||jsonb_build_object('kind','calendar_change','expectedEtag',event->>'etag');until_at:=observed+interval '2 minutes';
 receipt:=jsonb_build_object('reference',bid,'eventName',event->>'summary','calendarName','Primary calendar','startsAt',event#>>'{start,dateTime}','endsAt',event#>>'{end,dateTime}','validUntil',pactwoven.mandate_instant(until_at));
 digest:=pactwoven.native_delegation_hash(jsonb_build_object('namespace','pactwoven/google-discovery-event/v1','event',event));PERFORM pactwoven.native_google_discovery_validate(receipt,'baseline');
 INSERT INTO pactwoven.native_google_discovery_baselines VALUES(env,r.organization_id,bid,rid,r.actor_id,r.session#>>'{actor,sessionId}',(r.session#>>'{actor,authenticatedAt}')::timestamptz,r.connection_id,r.binding,target,event,digest,receipt,SESSION_USER,(SELECT oid FROM pg_roles WHERE rolname=SESSION_USER),observed,until_at);
 UPDATE pactwoven.native_google_discovery_requests SET state='complete' WHERE(environment,id)=(env,rid);
 PERFORM pactwoven.native_google_session_fresh(r.session);PERFORM pactwoven.native_google_session_fresh(s);PERFORM pactwoven.native_google_require(r.expires_at>clock_timestamp() AND until_at>clock_timestamp(),'NG008');RETURN receipt;
END $$;

CREATE FUNCTION pactwoven.native_google_discovery_prepare(env text,s jsonb,key text,q jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_variable
DECLARE b pactwoven.native_google_discovery_baselines;prior pactwoven.native_google_discovery_preparations;old pactwoven.native_google_access_reviews;c jsonb;ctx jsonb;review jsonb;named jsonb;input jsonb;expiry timestamptz;site text;stamp timestamptz;
BEGIN
 PERFORM pactwoven.native_google_access_lane(env,'api');PERFORM pactwoven.native_google_discovery_validate(q,'prepare');PERFORM pactwoven.native_google_access_session(env,s);PERFORM pactwoven.native_google_require(key~'^[A-Za-z0-9_-]{16,128}$');PERFORM pactwoven.native_google_discovery_name(q->>'purpose',1000);
 -- Match the existing access bridge lock order: connection before request key.
 SELECT * INTO b FROM pactwoven.native_google_discovery_baselines WHERE(environment,organization_id,id,actor_id)=(env,s#>>'{actor,organizationId}',q->>'baselineReference',s#>>'{actor,actorId}')FOR SHARE;
 PERFORM pactwoven.native_google_require(FOUND AND b.session_id=s#>>'{actor,sessionId}' AND b.authenticated_at=(s#>>'{actor,authenticatedAt}')::timestamptz,'NG001');
 c:=pactwoven.native_google_access_connection(env,b.connection_id);
 PERFORM pg_advisory_xact_lock(hashtextextended(env||':'||(s#>>'{actor,organizationId}')||':'||(s#>>'{actor,actorId}')||':'||key,0));
 SELECT * INTO prior FROM pactwoven.native_google_discovery_preparations WHERE(environment,organization_id,actor_id,request_key)=(env,s#>>'{actor,organizationId}',s#>>'{actor,actorId}',key);
 IF FOUND THEN
  PERFORM pactwoven.native_google_require(prior.input=q,'NG003');SELECT * INTO old FROM pactwoven.native_google_access_reviews WHERE(environment,organization_id,id)=(env,prior.organization_id,prior.review_id);
  PERFORM pactwoven.native_google_require(FOUND,'NG001');review:=pactwoven.native_google_access_prepare(env,s,key,old.input);
  PERFORM pactwoven.native_google_require(review->>'id'=prior.review_id,'NG003');RETURN prior.named_review;
 END IF;
 SELECT * INTO b FROM pactwoven.native_google_discovery_baselines WHERE(environment,organization_id,id,actor_id)=(env,s#>>'{actor,organizationId}',q->>'baselineReference',s#>>'{actor,actorId}')FOR SHARE;
 PERFORM pactwoven.native_google_require(FOUND AND b.session_id=s#>>'{actor,sessionId}' AND b.authenticated_at=(s#>>'{actor,authenticatedAt}')::timestamptz AND b.valid_until>clock_timestamp(),'NG001');
 PERFORM pactwoven.native_google_discovery_reader(env,b.producer,b.producer_oid);
 c:=pactwoven.native_google_access_connection(env,b.connection_id);PERFORM pactwoven.native_google_require(c->>'status'='connected' AND c->'binding'=b.binding,'NG003');
 SELECT site_id INTO site FROM pactwoven.native_delegation_root_runs WHERE(environment,organization_id,root_task_id,actor_id)=(env,b.organization_id,q->>'taskReference',b.actor_id);PERFORM pactwoven.native_google_require(FOUND,'NG001');
 PERFORM pactwoven.native_google_access_session(env,s,site);ctx:=pactwoven.native_google_access_root(env,b.organization_id,b.actor_id,q->>'taskReference',site,false);stamp:=clock_timestamp();
 expiry:=LEAST(stamp+make_interval(mins=>(q->>'durationMinutes')::integer),(ctx#>>'{root,expiresAt}')::timestamptz);
 input:=jsonb_build_object('siteId',site,'rootTaskId',q->>'taskReference','connectionId',b.connection_id,'target',b.target,'purpose',q->>'purpose','expiresAt',pactwoven.mandate_instant(expiry));
 review:=pactwoven.native_google_access_prepare(env,s,key,input);
 PERFORM pactwoven.native_google_discovery_name(review->>'rootTitle');PERFORM pactwoven.native_google_discovery_name(review->>'siteName');
 PERFORM pactwoven.native_google_require(review->>'rootTitle'<>q->>'taskReference','NG004');
 named:=(review-'target'-'preparedAt')||(b.receipt-'reference'-'validUntil');PERFORM pactwoven.native_google_discovery_validate(named,'review');
 INSERT INTO pactwoven.native_google_discovery_preparations VALUES(env,b.organization_id,b.actor_id,key,q,b.id,review->>'id',named);
 PERFORM pactwoven.native_google_session_fresh(s);PERFORM pactwoven.native_google_require(b.valid_until>clock_timestamp() AND expiry>clock_timestamp(),'NG008');RETURN named;
END $$;

CREATE FUNCTION pactwoven.native_google_discovery_overview(env text,s jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE cfg pactwoven.native_google_access_settings;connections jsonb:='[]';tasks jsonb:='[]';consents jsonb:='[]';c record;r record;ctx jsonb;name text;site_name text;status text;version bigint;item jsonb;answer jsonb;
BEGIN
 PERFORM pactwoven.native_google_access_lane(env,'api');PERFORM pactwoven.native_google_access_session(env,s);cfg:=pactwoven.native_google_access_config(env);
 PERFORM pactwoven.native_google_require((SELECT count(*) FROM(SELECT 1 FROM pactwoven.native_delegation_root_runs WHERE(environment,organization_id,actor_id)=(env,s#>>'{actor,organizationId}',s#>>'{actor,actorId}')LIMIT 501)bounded)<=500,'NG004');
 PERFORM pactwoven.native_google_require((SELECT count(*) FROM(SELECT 1 FROM pactwoven.native_google_access_reviews WHERE(environment,organization_id,actor_id)=(env,s#>>'{actor,organizationId}',s#>>'{actor,actorId}')LIMIT 501)bounded)<=500,'NG004');
 FOR c IN SELECT id,body FROM pactwoven.native_google_connections WHERE environment=env AND body#>>'{binding,organizationId}'=s#>>'{actor,organizationId}' AND body#>>'{binding,actorId}'=s#>>'{actor,actorId}' AND body->>'clientId'=cfg.client_id AND body->>'accountEmail'=cfg.expected_email ORDER BY id LIMIT 101 LOOP
  connections:=connections||jsonb_build_array(jsonb_build_object('id',c.id,'version',c.body#>'{binding,connectionVersion}','email',c.body->>'accountEmail','status',c.body->>'status'));
 END LOOP;
 FOR r IN SELECT root_task_id,site_id,title FROM pactwoven.native_delegation_root_runs WHERE(environment,organization_id,actor_id)=(env,s#>>'{actor,organizationId}',s#>>'{actor,actorId}') ORDER BY root_task_id LOOP
  BEGIN
   PERFORM pactwoven.native_google_access_session(env,s,r.site_id);ctx:=pactwoven.native_google_access_root(env,s#>>'{actor,organizationId}',s#>>'{actor,actorId}',r.root_task_id,r.site_id,false);
   SELECT st.name INTO site_name FROM pactwoven.sites st WHERE(st.environment,st.organization_id,st.id)=(env,s#>>'{actor,organizationId}',r.site_id);
   PERFORM pactwoven.native_google_discovery_name(r.title);PERFORM pactwoven.native_google_discovery_name(site_name);PERFORM pactwoven.native_google_require(r.title<>r.root_task_id,'NG004');
   tasks:=tasks||jsonb_build_array(jsonb_build_object('reference',r.root_task_id,'title',r.title,'siteName',site_name));
  EXCEPTION WHEN SQLSTATE 'NG001' OR SQLSTATE 'NG008' OR SQLSTATE 'NG004' OR SQLSTATE 'ND001' THEN NULL;
  END;
 END LOOP;
 FOR r IN SELECT a.*,p.named_review FROM pactwoven.native_google_access_reviews a LEFT JOIN pactwoven.native_google_discovery_preparations p ON(p.environment,p.organization_id,p.review_id)=(a.environment,a.organization_id,a.id)
  WHERE(a.environment,a.organization_id,a.actor_id)=(env,s#>>'{actor,organizationId}',s#>>'{actor,actorId}') ORDER BY a.id LOOP
  BEGIN PERFORM pactwoven.native_google_access_session(env,s,r.request#>>'{scope,siteId}');EXCEPTION WHEN SQLSTATE 'NG001' OR SQLSTATE 'NG008' THEN CONTINUE;END;
  SELECT h.state,h.version INTO status,version FROM pactwoven.native_communication_heads h WHERE(h.environment,h.organization_id,h.id)=(env,r.organization_id,r.id);
  status:=COALESCE(status,CASE WHEN r.approval IS NULL THEN 'prepared' ELSE 'approved' END);version:=COALESCE(version,1);
  BEGIN name:=pactwoven.native_google_discovery_name(r.review->>'rootTitle');EXCEPTION WHEN SQLSTATE 'NG004' THEN name:='Task details unavailable';END;
  item:=jsonb_build_object('id',r.id,'version',version,'rootTitle',name,'expiresAt',r.review->>'expiresAt','status',status);
  IF r.named_review IS NULL THEN item:=item||jsonb_build_object('details','unavailable','preparedAt',r.review->>'preparedAt');
  ELSE item:=item||jsonb_build_object('details','available','eventName',r.named_review->>'eventName','calendarName',r.named_review->>'calendarName','startsAt',r.named_review->>'startsAt','endsAt',r.named_review->>'endsAt');END IF;
  consents:=consents||jsonb_build_array(item);
 END LOOP;
 answer:=jsonb_build_object('availability','ready','connections',connections,'tasks',tasks,'consents',consents);PERFORM pactwoven.native_google_discovery_validate(answer,'overview');PERFORM pactwoven.native_google_session_fresh(s);RETURN answer;
END $$;

-- Source: .local/native-google-production-integration/production-profiles.sql
-- Versioned enrollment protects the seven accepted Google service audiences.
-- No login, connection setting, provider grant, or service enrollment is created.
CREATE TABLE pactwoven.native_google_production_bindings(
 login name NOT NULL,role_oid oid NOT NULL,environment text NOT NULL CHECK(environment IN('simulation','development','staging','production')),
 lane text NOT NULL CHECK(lane IN('observer','api','review','content','auth','worker','reader')),
 enabled boolean NOT NULL DEFAULT true,PRIMARY KEY(login,environment,lane));
CREATE FUNCTION pactwoven.native_google_production_binding_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION USING ERRCODE='NG003',MESSAGE='Retain enrollment identity; disable the audience instead';END IF;
 PERFORM pactwoven.native_google_require((NEW.login,NEW.role_oid,NEW.environment,NEW.lane)=(OLD.login,OLD.role_oid,OLD.environment,OLD.lane),'NG003');RETURN NEW;
END $$;
CREATE TRIGGER native_google_production_binding_guard BEFORE UPDATE OR DELETE ON pactwoven.native_google_production_bindings FOR EACH ROW EXECUTE FUNCTION pactwoven.native_google_production_binding_guard();
CREATE FUNCTION pactwoven.native_google_production_current(env text,principal name,p_lane text) RETURNS boolean LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE enrolled boolean;BEGIN
 PERFORM pactwoven.financial_require_read_committed();
 PERFORM set_config('lock_timeout','2000ms',true);
 SELECT true INTO enrolled FROM pactwoven.native_google_production_bindings b JOIN pg_roles r ON r.oid=b.role_oid AND r.rolname=b.login
 WHERE b.environment=env AND b.login=principal AND b.lane=p_lane AND b.enabled AND NOT(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolbypassrls OR r.rolreplication)
 AND pactwoven.custody_system_privileges_safe(r.oid) FOR SHARE OF b;
 IF enrolled IS DISTINCT FROM true THEN RETURN false;END IF;
 IF p_lane IN('observer','api','review','content') THEN
  PERFORM 1 FROM pactwoven.native_google_access_bindings b JOIN pg_roles r ON r.oid=b.role_oid AND r.rolname=b.login WHERE b.environment=env AND b.login=principal AND b.lane=p_lane FOR SHARE OF b;IF NOT FOUND THEN RETURN false;END IF;
 ELSIF p_lane IN('auth','worker') THEN
  PERFORM 1 FROM pactwoven.native_google_bindings b WHERE b.environment=env AND b.login=principal AND b.lane=p_lane FOR SHARE OF b;IF NOT FOUND THEN RETURN false;END IF;
 ELSIF p_lane='reader' THEN
  PERFORM 1 FROM pactwoven.native_google_discovery_bindings b JOIN pg_roles r ON r.oid=b.role_oid AND r.rolname=b.login WHERE b.environment=env AND b.login=principal FOR SHARE OF b;IF NOT FOUND THEN RETURN false;END IF;
 ELSE RETURN false;END IF;
 IF p_lane IN('api','review') THEN
  PERFORM 1 FROM pactwoven.native_communication_bindings b WHERE b.environment=env AND b.login=principal AND b.lane=p_lane FOR SHARE OF b;IF NOT FOUND THEN RETURN false;END IF;
 END IF;
 -- Every statement before this point may have waited. READ COMMITTED gives
 -- this final statement a fresh catalog snapshot after all enrollment locks.
 -- No values evaluated before a row-lock wait authorize the returned verdict.
 RETURN EXISTS(SELECT 1 FROM pactwoven.native_google_production_bindings b
  JOIN pg_roles r ON r.oid=b.role_oid AND r.rolname=b.login
  WHERE b.environment=env AND b.login=principal AND b.lane=p_lane AND b.enabled
   AND NOT(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolbypassrls OR r.rolreplication)
   AND pactwoven.custody_system_privileges_safe(r.oid)
   AND CASE WHEN p_lane IN('observer','api','review','content') THEN EXISTS(
    SELECT 1 FROM pactwoven.native_google_access_bindings a
    WHERE a.environment=env AND a.login=principal AND a.role_oid=r.oid AND a.lane=p_lane)
   WHEN p_lane IN('auth','worker') THEN EXISTS(
    SELECT 1 FROM pactwoven.native_google_bindings a
    WHERE a.environment=env AND a.login=principal AND a.lane=p_lane)
   WHEN p_lane='reader' THEN EXISTS(
    SELECT 1 FROM pactwoven.native_google_discovery_bindings a
    WHERE a.environment=env AND a.login=principal AND a.role_oid=r.oid)
   ELSE false END
   AND (p_lane NOT IN('api','review') OR EXISTS(
    SELECT 1 FROM pactwoven.native_communication_bindings a
    WHERE a.environment=env AND a.login=principal AND a.lane=p_lane)));
END $$;
CREATE FUNCTION pactwoven.native_google_production_binding(env text,p_lane text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN RETURN pactwoven.native_google_production_current(env,SESSION_USER,p_lane);END $$;

-- New-family lane checks add permanent OID enrollment to the accepted bodies.
-- No existing numbered routine is changed. Full source deltas are generated.

CREATE OR REPLACE FUNCTION pactwoven.native_google_lane(env text,lane text)RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_variable
BEGIN 
 PERFORM pactwoven.native_google_require(pactwoven.native_google_production_current(env,SESSION_USER,lane),'NG001');
PERFORM set_config('lock_timeout','2000ms',true);
PERFORM 1 FROM pactwoven.native_google_bindings b JOIN pg_roles r ON r.rolname=b.login WHERE b.login=SESSION_USER AND b.environment=env AND b.lane=lane AND NOT(r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication)FOR SHARE OF b;
PERFORM pactwoven.native_google_require(FOUND,'NG001');END $$;
CREATE OR REPLACE FUNCTION pactwoven.native_communication_lane(env text,lane text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_variable
 BEGIN

 PERFORM pactwoven.native_communication_require(pactwoven.native_google_production_current(env,SESSION_USER,lane),'NC001');
 PERFORM set_config('lock_timeout','2000ms',true);
 PERFORM 1 FROM pactwoven.native_communication_bindings b JOIN pg_roles r ON r.rolname=b.login WHERE b.login=SESSION_USER AND b.environment=env AND b.lane=lane AND NOT(r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication) FOR SHARE OF b;
 PERFORM pactwoven.native_communication_require(FOUND,'NC001');
END $$;
CREATE OR REPLACE FUNCTION pactwoven.native_communication_producer_current(env text,producer name,lane text) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
#variable_conflict use_variable
 BEGIN

 PERFORM pactwoven.native_communication_require(pactwoven.native_google_production_current(env,producer,lane),'NC001');
 PERFORM 1 FROM pactwoven.native_communication_bindings b JOIN pg_roles r ON r.rolname=b.login WHERE b.login=producer AND b.environment=env AND b.lane=lane AND NOT(r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication) FOR SHARE OF b;
 PERFORM pactwoven.native_communication_require(FOUND,'NC001');
END $$;
CREATE OR REPLACE FUNCTION pactwoven.native_google_access_producer(env text,login_name name,login_oid oid,p_lane text)RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN 
 PERFORM pactwoven.native_google_require(pactwoven.native_google_production_current(env,login_name,p_lane),'NG001');
PERFORM 1 FROM pactwoven.native_google_access_bindings b JOIN pg_roles r ON r.oid=b.role_oid AND r.rolname=b.login WHERE b.environment=env AND b.login=login_name AND b.role_oid=login_oid AND b.lane=p_lane AND NOT(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolbypassrls OR r.rolreplication)FOR SHARE OF b;PERFORM pactwoven.native_google_require(FOUND,'NG001');END $$;
CREATE OR REPLACE FUNCTION pactwoven.native_google_discovery_reader(env text,login_name name,login_oid oid) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN

 PERFORM pactwoven.native_google_require(pactwoven.native_google_production_current(env,login_name,'reader'),'NG001');
 PERFORM 1 FROM pactwoven.native_google_discovery_bindings b JOIN pg_roles r ON r.oid=b.role_oid AND r.rolname=b.login
 WHERE b.environment=env AND b.login=login_name AND b.role_oid=login_oid AND NOT(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolbypassrls OR r.rolreplication) FOR SHARE OF b;
 PERFORM pactwoven.native_google_require(FOUND,'NG001');
END $$;
DO $$ DECLARE t record;f record;BEGIN
 FOR t IN SELECT c.oid::regclass relation,c.relname FROM pg_class c WHERE c.relnamespace='pactwoven'::regnamespace AND c.relkind='r' AND (c.relname LIKE 'native_google_discovery_%' OR c.relname LIKE 'native_google_production_%') LOOP
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY',t.relation);EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY',t.relation);
  EXECUTE format('REVOKE ALL ON TABLE %s FROM PUBLIC',t.relation);
  IF NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=t.relation AND polname='google_production_owner') THEN EXECUTE format('CREATE POLICY google_production_owner ON %s TO %I USING(true) WITH CHECK(true)',t.relation,CURRENT_USER);END IF;
 END LOOP;
 FOR f IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace='pactwoven'::regnamespace AND (proname LIKE 'native_google_discovery_%' OR proname LIKE 'native_google_production_%') LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature);END LOOP;
END $$;
COMMIT;
