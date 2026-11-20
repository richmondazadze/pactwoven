BEGIN;
-- A pending interaction outlives the initial proof; current creation and callback
-- proofs remain mandatory. This does not extend a session, grant, or absolute window.
CREATE OR REPLACE FUNCTION pactwoven.native_google_create_attempt(env text,a jsonb)RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_variable
DECLARE t timestamptz;old record;BEGIN
PERFORM pactwoven.native_google_lane(env,'auth');PERFORM pactwoven.native_google_validate(a,'attempt');PERFORM pactwoven.native_google_session(env,a->'session');t:=clock_timestamp();
PERFORM pactwoven.native_google_require(a#>>'{binding,environment}'=env AND a#>>'{binding,organizationId}'=a#>>'{session,actor,organizationId}' AND a#>>'{binding,actorId}'=a#>>'{session,actor,actorId}' AND a#>>'{binding,connectionVersion}'='1' AND a#>>'{binding,credentialVersion}'='1' AND(a->>'createdAt')::timestamptz<=t AND(a->>'createdAt')::timestamptz>t-interval '20 seconds' AND(a->>'expiresAt')::timestamptz>t AND(a->>'expiresAt')::timestamptz<=(a->>'createdAt')::timestamptz+interval '5 minutes');
INSERT INTO pactwoven.native_google_attempts(environment,id,state_hash,body)VALUES(env,a->>'id',a->>'stateHash',a)ON CONFLICT DO NOTHING;
SELECT * INTO old FROM pactwoven.native_google_attempts WHERE environment=env AND id=a->>'id' FOR UPDATE;PERFORM pactwoven.native_google_require(FOUND AND old.body=a AND old.status='pending','NG003');PERFORM pactwoven.native_google_session_fresh(a->'session');RETURN true;END $$;
COMMIT;
