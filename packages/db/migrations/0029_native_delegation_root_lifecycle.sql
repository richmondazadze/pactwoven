BEGIN;
-- Root lifecycle preserves historical migration source and every v1 routine.
-- Two approved managed-lifecycle v2 routine deltas are explicit below.
-- maxAttempts is TOTAL logical attempts, including the initial attempt.
CREATE TABLE pactwoven.native_delegation_root_runs (
 environment text NOT NULL,organization_id text NOT NULL,root_task_id text NOT NULL,grant_id text NOT NULL,site_id text NOT NULL,actor_id text NOT NULL,
 title text NOT NULL,prompt text NOT NULL,control_version bigint NOT NULL DEFAULT 1 CHECK(control_version BETWEEN 1 AND 9007199254740991),
 checkpoint_version bigint NOT NULL DEFAULT 0 CHECK(checkpoint_version BETWEEN 0 AND 9007199254740991),
 phase text NOT NULL CHECK(phase IN('ready','running','yielded','waiting_children','paused','cancelled','completed','blocked')),
 reason text NOT NULL DEFAULT 'none' CHECK(reason IN('none','manual_pause','authority','attempts_exhausted','continuation_limit','reconciliation')),
 managed boolean NOT NULL DEFAULT true,manual_paused boolean NOT NULL DEFAULT false,restart_required boolean NOT NULL DEFAULT false,
 wait_for text[] NOT NULL DEFAULT '{}',slice_count integer NOT NULL DEFAULT 0 CHECK(slice_count BETWEEN 0 AND 256),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(environment,organization_id,root_task_id),UNIQUE(environment,organization_id,grant_id),
 FOREIGN KEY(environment,organization_id,root_task_id) REFERENCES pactwoven.native_delegation_tasks(environment,organization_id,id),
 FOREIGN KEY(environment,organization_id,grant_id) REFERENCES pactwoven.native_delegation_grants(environment,organization_id,id)
);
CREATE TABLE pactwoven.native_delegation_root_commands (
 environment text NOT NULL,organization_id text NOT NULL,root_task_id text NOT NULL,request_key text NOT NULL,
 kind text NOT NULL CHECK(kind IN('checkpoint','yield','inputs','complete')),generation bigint NOT NULL,identity jsonb NOT NULL,intent jsonb NOT NULL,response jsonb NOT NULL,
 PRIMARY KEY(environment,organization_id,root_task_id,request_key),
 FOREIGN KEY(environment,organization_id,root_task_id) REFERENCES pactwoven.native_delegation_root_runs(environment,organization_id,root_task_id),
 CHECK(request_key ~ '^[A-Za-z0-9_-]{16,128}$')
);
CREATE TABLE pactwoven.native_delegation_root_checkpoints (
 environment text NOT NULL,organization_id text NOT NULL,root_task_id text NOT NULL,version bigint NOT NULL,generation bigint NOT NULL,
 body jsonb NOT NULL,planner_state text NOT NULL CHECK(octet_length(planner_state)<=65536),input_receipts jsonb NOT NULL,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(environment,organization_id,root_task_id,version),
 FOREIGN KEY(environment,organization_id,root_task_id) REFERENCES pactwoven.native_delegation_root_runs(environment,organization_id,root_task_id)
);
CREATE TABLE pactwoven.native_delegation_root_controls (
 environment text NOT NULL,organization_id text NOT NULL,actor_id text NOT NULL,request_key text NOT NULL,root_task_id text NOT NULL,intent jsonb NOT NULL,response jsonb NOT NULL,
 PRIMARY KEY(environment,organization_id,actor_id,request_key),
 FOREIGN KEY(environment,organization_id,root_task_id) REFERENCES pactwoven.native_delegation_root_runs(environment,organization_id,root_task_id),
 CHECK(request_key ~ '^[A-Za-z0-9_-]{16,128}$')
);
CREATE TABLE pactwoven.native_delegation_root_dispositions (
 environment text NOT NULL,organization_id text NOT NULL,root_task_id text NOT NULL,task_id text NOT NULL,generation bigint NOT NULL,
 reason text NOT NULL CHECK(reason IN('pause','cancel','crash')),recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(environment,organization_id,task_id,generation),
 FOREIGN KEY(environment,organization_id,root_task_id) REFERENCES pactwoven.native_delegation_root_runs(environment,organization_id,root_task_id)
);
CREATE TABLE pactwoven.native_delegation_root_inputs (
 environment text NOT NULL,organization_id text NOT NULL,root_task_id text NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),generation bigint NOT NULL,
 context_binding jsonb NOT NULL,body jsonb NOT NULL,digest text NOT NULL,data_valid_until timestamptz,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(environment,organization_id,root_task_id,id),UNIQUE(id),
 FOREIGN KEY(environment,organization_id,root_task_id) REFERENCES pactwoven.native_delegation_root_runs(environment,organization_id,root_task_id),
 CHECK(digest=pactwoven.native_delegation_hash(body))
);
CREATE TABLE pactwoven.native_delegation_root_completions (
 environment text NOT NULL,organization_id text NOT NULL,root_task_id text NOT NULL,generation bigint NOT NULL,publication jsonb NOT NULL,
 digest text NOT NULL,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(environment,organization_id,root_task_id),
 FOREIGN KEY(environment,organization_id,root_task_id) REFERENCES pactwoven.native_delegation_root_runs(environment,organization_id,root_task_id),
 CHECK(digest=pactwoven.native_delegation_hash(publication))
);
CREATE TABLE pactwoven.native_delegation_root_recoveries (
 environment text NOT NULL,organization_id text NOT NULL,root_task_id text NOT NULL,generation bigint NOT NULL,
 previous_generation bigint NOT NULL,attempt integer NOT NULL,reason text NOT NULL,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(environment,organization_id,root_task_id,generation),
 FOREIGN KEY(environment,organization_id,root_task_id) REFERENCES pactwoven.native_delegation_root_runs(environment,organization_id,root_task_id)
);
CREATE TABLE pactwoven.native_delegation_root_note_selections (
 environment text NOT NULL,organization_id text NOT NULL,root_task_id text NOT NULL,request_key text NOT NULL,intent jsonb NOT NULL,
 memory_references jsonb NOT NULL,descriptions jsonb NOT NULL,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(environment,organization_id,root_task_id),
 FOREIGN KEY(environment,organization_id,root_task_id) REFERENCES pactwoven.native_delegation_root_runs(environment,organization_id,root_task_id)
);
CREATE TABLE pactwoven.native_delegation_root_assignments (
 environment text NOT NULL,organization_id text NOT NULL,root_task_id text NOT NULL,task_id text NOT NULL,handoff_id text NOT NULL,request_key text NOT NULL,
 assignment_version bigint NOT NULL,generation bigint NOT NULL,intent jsonb NOT NULL,assignment jsonb NOT NULL,response jsonb NOT NULL,
 PRIMARY KEY(environment,organization_id,task_id),UNIQUE(environment,organization_id,root_task_id,request_key),
 FOREIGN KEY(environment,organization_id,task_id) REFERENCES pactwoven.native_delegation_tasks(environment,organization_id,id),
 FOREIGN KEY(environment,organization_id,root_task_id) REFERENCES pactwoven.native_delegation_root_runs(environment,organization_id,root_task_id)
);
CREATE INDEX native_delegation_root_due_idx ON pactwoven.native_delegation_root_runs(environment,phase,updated_at,organization_id,root_task_id);
ALTER TABLE pactwoven.native_delegation_outbox DROP CONSTRAINT native_delegation_outbox_state_check;
ALTER TABLE pactwoven.native_delegation_outbox ADD CONSTRAINT native_delegation_outbox_state_check CHECK(state IN('pending','publishing','published','suppressed'));

-- Command descriptors generated from native-root-lifecycle-schema.ts.
-- ROOT_COMMAND_DESCRIPTORS
CREATE FUNCTION pactwoven.native_delegation_root_schema(k text) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT $descriptors${"checkpoint":{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{"requestKey":{"type":"string","minLength":16,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"expectedCheckpointVersion":{"type":"integer","minimum":0,"maximum":9007199254740991},"checkpoint":{"type":"object","properties":{"stage":{"type":"string","enum":["planning","working","reviewing","ready"]},"summary":{"type":"string","minLength":1,"maxLength":4000,"pattern":"\\S"},"steps":{"maxItems":32,"type":"array","items":{"type":"object","properties":{"id":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"title":{"type":"string","minLength":1,"maxLength":180,"pattern":"\\S"},"state":{"type":"string","enum":["planned","active","done","blocked"]}},"required":["id","title","state"],"additionalProperties":false}}},"required":["stage","summary","steps"],"additionalProperties":false},"plannerState":{"type":"string","maxLength":65536},"inputReceipts":{"maxItems":128,"type":"array","items":{"type":"object","properties":{"receiptId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"digest":{"type":"string","pattern":"^[a-f0-9]{64}$"}},"required":["receiptId","digest"],"additionalProperties":false}}},"required":["requestKey","expectedCheckpointVersion","checkpoint","plannerState","inputReceipts"],"additionalProperties":false},"yield":{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{"requestKey":{"type":"string","minLength":16,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"expectedCheckpointVersion":{"type":"integer","minimum":0,"maximum":9007199254740991},"checkpoint":{"type":"object","properties":{"stage":{"type":"string","enum":["planning","working","reviewing","ready"]},"summary":{"type":"string","minLength":1,"maxLength":4000,"pattern":"\\S"},"steps":{"maxItems":32,"type":"array","items":{"type":"object","properties":{"id":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"title":{"type":"string","minLength":1,"maxLength":180,"pattern":"\\S"},"state":{"type":"string","enum":["planned","active","done","blocked"]}},"required":["id","title","state"],"additionalProperties":false}}},"required":["stage","summary","steps"],"additionalProperties":false},"plannerState":{"type":"string","maxLength":65536},"inputReceipts":{"maxItems":128,"type":"array","items":{"type":"object","properties":{"receiptId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"digest":{"type":"string","pattern":"^[a-f0-9]{64}$"}},"required":["receiptId","digest"],"additionalProperties":false}},"continuation":{"type":"string","enum":["continue","wait_children"]},"waitFor":{"maxItems":32,"type":"array","items":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"}}},"required":["requestKey","expectedCheckpointVersion","checkpoint","plannerState","inputReceipts","continuation","waitFor"],"additionalProperties":false},"control":{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{"rootTaskId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"expectedVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"action":{"type":"string","enum":["pause","resume","cancel"]}},"required":["rootTaskId","expectedVersion","action"],"additionalProperties":false},"inputs":{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{"requestKey":{"type":"string","minLength":16,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"results":{"minItems":1,"maxItems":32,"type":"array","items":{"type":"object","properties":{"handoffId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"publicationDigest":{"type":"string","pattern":"^[a-f0-9]{64}$"}},"required":["handoffId","publicationDigest"],"additionalProperties":false}}},"required":["requestKey","results"],"additionalProperties":false},"complete":{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{"requestKey":{"type":"string","minLength":16,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"expectedCheckpointVersion":{"type":"integer","minimum":0,"maximum":9007199254740991},"inputReceipts":{"maxItems":128,"type":"array","items":{"type":"object","properties":{"receiptId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"digest":{"type":"string","pattern":"^[a-f0-9]{64}$"}},"required":["receiptId","digest"],"additionalProperties":false}},"coverage":{"maxItems":32,"type":"array","items":{"type":"object","properties":{"taskId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"disposition":{"type":"string","enum":["advice_ready","failed","abandoned"]}},"required":["taskId","disposition"],"additionalProperties":false}},"result":{"type":"object","properties":{"outcome":{"type":"string","enum":["advice_ready","blocked"]},"title":{"type":"string","minLength":1,"maxLength":180,"pattern":"\\S"},"summary":{"type":"string","minLength":1,"maxLength":8000,"pattern":"\\S"},"artifacts":{"maxItems":16,"type":"array","items":{"type":"object","properties":{"id":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"title":{"type":"string","minLength":1,"maxLength":180,"pattern":"\\S"},"text":{"type":"string","minLength":1,"maxLength":16000,"pattern":"\\S"}},"required":["id","title","text"],"additionalProperties":false}},"evidenceValidUntil":{"anyOf":[{"type":"string","format":"date-time","pattern":"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"},{"type":"null"}]}},"required":["outcome","title","summary","artifacts","evidenceValidUntil"],"additionalProperties":false}},"required":["requestKey","expectedCheckpointVersion","inputReceipts","coverage","result"],"additionalProperties":false},"handoff":{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{"requestKey":{"type":"string","minLength":16,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"handoff":{"type":"object","properties":{"schemaVersion":{"type":"number","const":1},"handoffId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"environment":{"type":"string","enum":["simulation","development","staging","production"]},"organizationId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"siteId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"authority":{"type":"object","properties":{"kind":{"type":"string","const":"delegated"},"grantId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"grantVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"revocationEpoch":{"type":"integer","minimum":0,"maximum":9007199254740991},"grantDigest":{"type":"string","pattern":"^[a-f0-9]{64}$"}},"required":["kind","grantId","grantVersion","revocationEpoch","grantDigest"],"additionalProperties":false},"rootTaskId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"parentTaskId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"childTaskId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"assignmentVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"generation":{"type":"integer","minimum":1,"maximum":9007199254740991},"sender":{"type":"object","properties":{"serviceId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"serviceVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"workloadIdentityId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"}},"required":["serviceId","serviceVersion","workloadIdentityId"],"additionalProperties":false},"recipient":{"type":"object","properties":{"serviceId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"serviceVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"workloadIdentityId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"}},"required":["serviceId","serviceVersion","workloadIdentityId"],"additionalProperties":false},"capability":{"type":"string","enum":["research_public_sources","read_scoped_memory","draft_advice"]},"capabilityVersion":{"type":"number","const":1},"depth":{"type":"integer","minimum":1,"maximum":3},"attemptLimit":{"type":"integer","minimum":1,"maximum":4},"taskTimeoutMs":{"type":"integer","minimum":1000,"maximum":300000},"issuedAt":{"type":"string","format":"date-time","pattern":"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"},"deadlineAt":{"type":"string","format":"date-time","pattern":"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"},"inputArtifacts":{"maxItems":32,"type":"array","items":{"type":"object","properties":{"environment":{"type":"string","enum":["simulation","development","staging","production"]},"organizationId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"siteId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"artifactId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"revision":{"type":"integer","minimum":1,"maximum":9007199254740991},"digest":{"type":"string","pattern":"^[a-f0-9]{64}$"}},"required":["environment","organizationId","siteId","artifactId","revision","digest"],"additionalProperties":false}},"outputContract":{"type":"string","const":"advisory_artifacts_v1"},"correlationId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"}},"required":["schemaVersion","handoffId","environment","organizationId","siteId","authority","rootTaskId","parentTaskId","childTaskId","assignmentVersion","generation","sender","recipient","capability","capabilityVersion","depth","attemptLimit","taskTimeoutMs","issuedAt","deadlineAt","inputArtifacts","outputContract","correlationId"],"additionalProperties":false},"assignment":{"type":"object","properties":{"schemaVersion":{"type":"number","const":1},"stepId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"title":{"type":"string","minLength":1,"maxLength":180,"pattern":"\\S"},"brief":{"type":"string","minLength":1,"maxLength":8000,"pattern":"\\S"},"role":{"type":"string","enum":["research","planning","escalation"]},"memoryReferences":{"maxItems":32,"type":"array","items":{"type":"object","properties":{"environment":{"type":"string","enum":["simulation","development","staging","production"]},"organizationId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"siteId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"memoryId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"revision":{"type":"integer","minimum":1,"maximum":9007199254740991},"digest":{"type":"string","pattern":"^[a-f0-9]{64}$"}},"required":["environment","organizationId","siteId","memoryId","revision","digest"],"additionalProperties":false}}},"required":["schemaVersion","stepId","title","brief","role","memoryReferences"],"additionalProperties":false}},"required":["requestKey","handoff","assignment"],"additionalProperties":false},"bind_notes":{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{"rootTaskId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"selections":{"maxItems":32,"type":"array","items":{"type":"object","properties":{"noteId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"expected":{"type":"string","pattern":"^[a-f0-9]{64}$"}},"required":["noteId","expected"],"additionalProperties":false}}},"required":["rootTaskId","selections"],"additionalProperties":false}}$descriptors$::jsonb->k $$;
-- END_ROOT_COMMAND_DESCRIPTORS

CREATE FUNCTION pactwoven.native_delegation_root_require(q jsonb,k text) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF q IS NULL OR octet_length(q::text)>524288 OR NOT pactwoven.native_delegation_matches(q,pactwoven.native_delegation_root_schema(k)) THEN
  RAISE EXCEPTION USING ERRCODE='ND004',MESSAGE='Invalid root command';END IF;
END $$;
CREATE FUNCTION pactwoven.native_delegation_root_limit() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.depth=0 THEN SELECT (issue_body#>>'{scope,limits,maxAttempts}')::integer INTO NEW.attempt_limit
  FROM pactwoven.native_delegation_grants WHERE(environment,organization_id,id)=(NEW.environment,NEW.organization_id,NEW.grant_id);END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER native_root_initial_limit BEFORE INSERT ON pactwoven.native_delegation_tasks FOR EACH ROW EXECUTE FUNCTION pactwoven.native_delegation_root_limit();
CREATE FUNCTION pactwoven.native_delegation_root_initialize() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.depth=0 THEN INSERT INTO pactwoven.native_delegation_root_runs(environment,organization_id,root_task_id,grant_id,site_id,actor_id,title,prompt,phase)
  SELECT NEW.environment,NEW.organization_id,NEW.id,NEW.grant_id,NEW.site_id,g.actor_id,v.title,v.prompt,'ready'
  FROM pactwoven.native_delegation_grants g JOIN pactwoven.native_tasks v ON(v.environment,v.organization_id,v.id)=(g.environment,g.organization_id,g.legacy_root_id)
  WHERE(g.environment,g.organization_id,g.id)=(NEW.environment,NEW.organization_id,NEW.grant_id);END IF;RETURN NEW;
END $$;
CREATE TRIGGER native_root_initialize AFTER INSERT ON pactwoven.native_delegation_tasks FOR EACH ROW EXECUTE FUNCTION pactwoven.native_delegation_root_initialize();
UPDATE pactwoven.native_delegation_tasks t SET attempt_limit=(g.issue_body#>>'{scope,limits,maxAttempts}')::integer
 FROM pactwoven.native_delegation_grants g WHERE(t.environment,t.organization_id,t.grant_id)=(g.environment,g.organization_id,g.id) AND t.depth=0;
INSERT INTO pactwoven.native_delegation_root_runs(environment,organization_id,root_task_id,grant_id,site_id,actor_id,title,prompt,phase,reason,restart_required,managed)
 SELECT t.environment,t.organization_id,t.id,t.grant_id,t.site_id,g.actor_id,v.title,v.prompt,
  CASE WHEN t.state='settled' THEN 'blocked' ELSE t.state END,CASE WHEN t.state='settled' THEN 'reconciliation' WHEN t.state='paused' THEN 'authority' ELSE 'none' END,t.state='paused',false
 FROM pactwoven.native_delegation_tasks t JOIN pactwoven.native_delegation_grants g ON(g.environment,g.organization_id,g.id)=(t.environment,t.organization_id,t.grant_id)
 JOIN pactwoven.native_tasks v ON(v.environment,v.organization_id,v.id)=(g.environment,g.organization_id,g.legacy_root_id) WHERE t.depth=0;

CREATE FUNCTION pactwoven.native_delegation_root_wait_ready(r pactwoven.native_delegation_root_runs) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$ SELECT NOT EXISTS(SELECT 1 FROM unnest(r.wait_for) w(id)
 LEFT JOIN pactwoven.native_delegation_tasks t ON(t.environment,t.organization_id,t.id)=(r.environment,r.organization_id,w.id)
 WHERE t.id IS NULL OR t.root_task_id<>r.root_task_id OR t.state<>'settled') $$;
CREATE FUNCTION pactwoven.native_delegation_root_wait_stranded(r pactwoven.native_delegation_root_runs,at_time timestamptz) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$ SELECT EXISTS(SELECT 1 FROM pactwoven.native_delegation_tasks t
 WHERE(t.environment,t.organization_id,t.root_task_id)=(r.environment,r.organization_id,r.root_task_id) AND t.depth>0
  AND(t.id=ANY(r.wait_for) OR t.ancestors && r.wait_for) AND t.state<>'settled'
  AND(t.state IN('paused','cancelled') OR t.deadline_at<=at_time
   OR(t.state='running' AND(t.lease_token IS NULL OR t.lease_until<=at_time)))) $$;
CREATE FUNCTION pactwoven.native_delegation_root_wake(e text,o text,id text,generation bigint) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 INSERT INTO pactwoven.native_delegation_outbox(environment,organization_id,task_id,generation) VALUES(e,o,id,generation) ON CONFLICT DO NOTHING;
END $$;
CREATE FUNCTION pactwoven.native_delegation_root_task_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE r pactwoven.native_delegation_root_runs;t pactwoven.native_delegation_tasks;BEGIN
 IF NEW.state IN('paused','cancelled') THEN
  UPDATE pactwoven.native_delegation_outbox SET state='suppressed',token=NULL,lease_until=NULL
   WHERE(environment,organization_id,task_id)=(NEW.environment,NEW.organization_id,NEW.id) AND state<>'suppressed';
  IF NEW.depth=0 THEN
   UPDATE pactwoven.native_delegation_root_runs SET phase=NEW.state,reason=CASE WHEN NEW.state='paused' THEN 'authority' ELSE 'none' END,
    restart_required=restart_required OR OLD.lease_token IS NOT NULL,control_version=control_version+1,updated_at=clock_timestamp()
    WHERE(environment,organization_id,root_task_id)=(NEW.environment,NEW.organization_id,NEW.id) AND phase<>NEW.state;
  END IF;
 ELSIF NEW.depth=0 AND NEW.state='running' THEN
  UPDATE pactwoven.native_delegation_root_runs SET phase='running',updated_at=clock_timestamp()
   WHERE(environment,organization_id,root_task_id)=(NEW.environment,NEW.organization_id,NEW.id) AND phase='ready';
 ELSIF NEW.state='settled' AND NEW.depth>0 THEN
  SELECT * INTO r FROM pactwoven.native_delegation_root_runs WHERE(environment,organization_id,root_task_id)=(NEW.environment,NEW.organization_id,NEW.root_task_id);
  IF r.phase='waiting_children' AND NOT r.manual_paused AND pactwoven.native_delegation_root_wait_ready(r) THEN
   SELECT * INTO t FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(r.environment,r.organization_id,r.root_task_id);
   IF t.state='running' AND t.lease_token IS NULL THEN PERFORM pactwoven.native_delegation_root_wake(t.environment,t.organization_id,t.id,t.generation);END IF;
  END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER native_root_task_transition AFTER UPDATE OF state ON pactwoven.native_delegation_tasks FOR EACH ROW WHEN(OLD.state IS DISTINCT FROM NEW.state) EXECUTE FUNCTION pactwoven.native_delegation_root_task_transition();
CREATE FUNCTION pactwoven.native_delegation_root_coverage(e text,o text,id text) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$ SELECT coalesce(jsonb_agg(jsonb_build_object('taskId',t.id,'disposition',
 CASE WHEN t.state='settled' THEN coalesce(result.publication#>>'{result,outcome}','abandoned') ELSE 'abandoned' END) ORDER BY t.id COLLATE "C"),'[]')
 FROM pactwoven.native_delegation_tasks t LEFT JOIN pactwoven.native_delegation_results result ON(result.environment,result.organization_id,result.handoff_id)=(t.environment,t.organization_id,t.handoff_id)
 WHERE(t.environment,t.organization_id,t.root_task_id)=($1,$2,$3) AND t.depth>0 AND t.state IN('settled','cancelled') $$;
CREATE FUNCTION pactwoven.native_delegation_root_read(p_actor jsonb,p_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE r pactwoven.native_delegation_root_runs;t pactwoven.native_delegation_tasks;g pactwoven.native_delegation_grants;c pactwoven.native_delegation_root_checkpoints;
 input pactwoven.native_delegation_root_inputs;ctx jsonb;projection_ctx jsonb;checked jsonb;result_body jsonb;state text;reason text;unavailable boolean:=false;deadline timestamptz;projection_until timestamptz;BEGIN
 PERFORM pactwoven.native_delegation_actor_locked(p_actor,NULL,false);
 SELECT * INTO r FROM pactwoven.native_delegation_root_runs WHERE(environment,organization_id,root_task_id,actor_id)=(p_actor->>'environment',p_actor->>'organizationId',p_id,p_actor->>'actorId');
 PERFORM pactwoven.native_memory_require(FOUND,'ND001');ctx:=pactwoven.native_delegation_actor_locked(p_actor,r.site_id,false);
 SELECT * INTO g FROM pactwoven.native_delegation_grants WHERE(environment,organization_id,id)=(r.environment,r.organization_id,r.grant_id) FOR SHARE;
 SELECT * INTO t FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(r.environment,r.organization_id,p_id);
 SELECT * INTO r FROM pactwoven.native_delegation_root_runs WHERE(environment,organization_id,root_task_id)=(r.environment,r.organization_id,p_id);
 SELECT * INTO c FROM pactwoven.native_delegation_root_checkpoints WHERE(environment,organization_id,root_task_id,version)=(r.environment,r.organization_id,p_id,r.checkpoint_version);
 SELECT publication->'result' INTO result_body FROM pactwoven.native_delegation_root_completions WHERE(environment,organization_id,root_task_id)=(r.environment,r.organization_id,p_id);
 state:=r.phase;reason:=r.reason;
 IF state NOT IN('completed','cancelled') AND(g.body->'revocation'<>'null'::jsonb OR pactwoven.supplier_time(g.body->'expiresAt')<=clock_timestamp() OR t.authority<>pactwoven.native_delegation_reference(g)) THEN state:='blocked';reason:='authority';END IF;
 IF c.version IS NOT NULL OR result_body IS NOT NULL THEN
  BEGIN
   -- Stored plaintext may carry evidence from an earlier generation. Validate
   -- every consumed original publication, not only the latest receipt list.
   -- The original child context remains intact inside validate_inputs; only
   -- its separate root disclosure check uses the current human reader.
   projection_until:=least(pactwoven.native_memory_time(ctx->'validUntil'),clock_timestamp()+interval '1 minute');
   FOR input IN SELECT * FROM pactwoven.native_delegation_root_inputs WHERE(environment,organization_id,root_task_id)=(r.environment,r.organization_id,p_id) ORDER BY generation,id LOOP
    PERFORM pactwoven.native_memory_require(pactwoven.native_memory_scope(input.context_binding)=pactwoven.native_memory_scope(ctx)
     AND input.context_binding#>>'{usage,taskId}'=p_id AND input.context_binding#>>'{usage,generation}'=input.generation::text
     AND input.digest=pactwoven.native_delegation_hash(input.body),'NM009');
    projection_ctx:=input.context_binding||jsonb_build_object('reader',ctx->'reader','purpose','human_review','validUntil',pactwoven.mandate_instant(projection_until));
    checked:=pactwoven.native_delegation_root_validate_inputs(projection_ctx,input.body->'choices');
    PERFORM pactwoven.native_memory_require(checked->'results'=input.body->'results' AND checked->'dataValidUntil'=input.body->'dataValidUntil','NM005');
    deadline:=least(deadline,input.data_valid_until);
   END LOOP;
   deadline:=least(deadline,pactwoven.native_memory_time(result_body->'evidenceValidUntil'));
   PERFORM pactwoven.native_memory_require(projection_until>clock_timestamp() AND(deadline IS NULL OR deadline>clock_timestamp()),'NM008');
  EXCEPTION WHEN SQLSTATE 'NM001' OR SQLSTATE 'NM002' OR SQLSTATE 'NM004' OR SQLSTATE 'NM005' OR SQLSTATE 'NM006' OR SQLSTATE 'NM007' OR SQLSTATE 'NM008' OR SQLSTATE 'NM009' OR SQLSTATE 'ND001' THEN
   unavailable:=true;c.body:=NULL;result_body:=NULL;
  END;
 END IF;
 PERFORM pactwoven.native_memory_notes_deadline(ctx);
 RETURN jsonb_build_object('scope',pactwoven.native_memory_scope(ctx),'id',p_id,'title',r.title,'prompt',r.prompt,'controlVersion',r.control_version,'state',state,'reason',reason,
  'updatedAt',pactwoven.mandate_instant(r.updated_at),'expiresAt',g.body->'expiresAt','evidenceUnavailable',unavailable,
  'checkpointVersion',r.checkpoint_version,'checkpoint',c.body,'checkpointHistorical',coalesce(c.generation<>t.generation,false),'attempt',t.attempt,'attemptLimit',t.attempt_limit,'generation',t.generation,
  'coverage',pactwoven.native_delegation_root_coverage(r.environment,r.organization_id,p_id),
  'result',result_body,'domainCompletion',false);
END $$;
CREATE FUNCTION pactwoven.native_delegation_root_fence(r pactwoven.native_delegation_root_runs,why text,root_state text) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 PERFORM 1 FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,root_task_id)=(r.environment,r.organization_id,r.root_task_id) ORDER BY id COLLATE "C" FOR UPDATE;
 INSERT INTO pactwoven.native_delegation_root_dispositions(environment,organization_id,root_task_id,task_id,generation,reason)
  SELECT environment,organization_id,root_task_id,id,generation,why FROM pactwoven.native_delegation_tasks
  WHERE(environment,organization_id,root_task_id)=(r.environment,r.organization_id,r.root_task_id) AND depth>0 AND state NOT IN('settled','cancelled') ON CONFLICT DO NOTHING;
 UPDATE pactwoven.native_delegation_tasks SET state=CASE WHEN depth=0 THEN root_state ELSE 'cancelled' END,generation=generation+1,lease_token=NULL,lease_until=NULL
  WHERE(environment,organization_id,root_task_id)=(r.environment,r.organization_id,r.root_task_id) AND state NOT IN('settled','cancelled');
 UPDATE pactwoven.native_delegation_proofs SET verdict='unknown',valid_until=NULL,nonce=NULL,nonce_barrier=NULL,prepared_at=NULL,deadline_at=NULL,barrier=barrier+1
  WHERE(environment,organization_id)=(r.environment,r.organization_id) AND task_id IN(SELECT id FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,root_task_id)=(r.environment,r.organization_id,r.root_task_id));
 UPDATE pactwoven.native_delegation_outbox SET state='suppressed',token=NULL,lease_until=NULL WHERE(environment,organization_id)=(r.environment,r.organization_id)
  AND task_id IN(SELECT id FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,root_task_id)=(r.environment,r.organization_id,r.root_task_id));
 UPDATE pactwoven.native_delegation_grants SET active_children=0 WHERE(environment,organization_id,id)=(r.environment,r.organization_id,r.grant_id);
END $$;
CREATE FUNCTION pactwoven.native_delegation_root_control(p_actor jsonb,p_key text,q jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE r pactwoven.native_delegation_root_runs;t pactwoven.native_delegation_tasks;ctx jsonb;prior pactwoven.native_delegation_root_controls;response jsonb;next_state text;BEGIN
 PERFORM pactwoven.native_delegation_root_require(q,'control');PERFORM pactwoven.native_memory_require(p_key ~ '^[A-Za-z0-9_-]{16,128}$','ND004');
 PERFORM pactwoven.native_delegation_actor_locked(p_actor,NULL,true);
 SELECT * INTO r FROM pactwoven.native_delegation_root_runs WHERE(environment,organization_id,root_task_id,actor_id)=(p_actor->>'environment',p_actor->>'organizationId',q->>'rootTaskId',p_actor->>'actorId');
 PERFORM pactwoven.native_memory_require(FOUND,'ND001');ctx:=pactwoven.native_delegation_actor_locked(p_actor,r.site_id,true);
 PERFORM pg_advisory_xact_lock(hashtextextended(pactwoven.native_delegation_canonical(jsonb_build_array('native-root-control',r.environment,r.organization_id,r.actor_id,p_key)),0));
 IF q->>'action'='resume' THEN PERFORM pactwoven.native_delegation_grant_locked(r.environment,r.organization_id,r.grant_id);END IF;
 PERFORM 1 FROM pactwoven.native_delegation_grants WHERE(environment,organization_id,id)=(r.environment,r.organization_id,r.grant_id) FOR UPDATE;
 SELECT * INTO prior FROM pactwoven.native_delegation_root_controls WHERE(environment,organization_id,actor_id,request_key)=(r.environment,r.organization_id,r.actor_id,p_key);
 IF FOUND THEN PERFORM pactwoven.native_memory_require(prior.root_task_id=r.root_task_id AND prior.intent=q,'ND009');PERFORM pactwoven.native_memory_notes_deadline(ctx);RETURN prior.response;END IF;
 SELECT * INTO r FROM pactwoven.native_delegation_root_runs WHERE(environment,organization_id,root_task_id)=(r.environment,r.organization_id,r.root_task_id) FOR UPDATE;
 SELECT * INTO t FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(r.environment,r.organization_id,r.root_task_id) FOR UPDATE;
 PERFORM pactwoven.native_memory_require(r.control_version=(q->>'expectedVersion')::bigint AND r.phase NOT IN('cancelled','completed') AND NOT EXISTS
  (SELECT 1 FROM pactwoven.native_delegation_root_completions WHERE(environment,organization_id,root_task_id)=(r.environment,r.organization_id,r.root_task_id)),'ND009');
 IF q->>'action' IN('pause','cancel') THEN
  next_state:=CASE WHEN q->>'action'='pause' THEN 'paused' ELSE 'cancelled' END;
  UPDATE pactwoven.native_delegation_root_runs SET phase=next_state,reason=CASE WHEN next_state='paused' THEN 'manual_pause' ELSE 'none' END,
   manual_paused=next_state='paused',restart_required=restart_required OR t.lease_token IS NOT NULL,control_version=control_version+1,updated_at=clock_timestamp()
   WHERE(environment,organization_id,root_task_id)=(r.environment,r.organization_id,r.root_task_id);
  PERFORM pactwoven.native_delegation_root_fence(r,q->>'action',next_state);
 ELSE
  PERFORM pactwoven.native_memory_require(t.state='paused' AND r.phase='paused','ND009');
  -- Human resume requires the original live grant, but never old provider proof.
  next_state:=CASE WHEN r.restart_required AND t.attempt>=t.attempt_limit THEN 'blocked' ELSE 'ready' END;
  UPDATE pactwoven.native_delegation_root_runs SET phase=next_state,reason=CASE WHEN next_state='blocked' THEN 'attempts_exhausted' ELSE 'none' END,manual_paused=false,
   restart_required=false,wait_for='{}',control_version=control_version+1,updated_at=clock_timestamp() WHERE(environment,organization_id,root_task_id)=(r.environment,r.organization_id,r.root_task_id);
  PERFORM pactwoven.native_delegation_root_fence(r,'pause',CASE WHEN next_state='blocked' THEN 'paused' ELSE 'ready' END);
  UPDATE pactwoven.native_delegation_tasks SET state=CASE WHEN next_state='blocked' THEN 'paused' ELSE 'ready' END,
   attempt=attempt+CASE WHEN r.restart_required AND next_state='ready' THEN 1 ELSE 0 END,lease_token=NULL,lease_until=NULL WHERE(environment,organization_id,id)=(r.environment,r.organization_id,r.root_task_id);
  UPDATE pactwoven.native_delegation_proofs SET verdict='unknown',valid_until=NULL,nonce=NULL,nonce_barrier=NULL,prepared_at=NULL,deadline_at=NULL,barrier=barrier+1
   WHERE(environment,organization_id,task_id)=(r.environment,r.organization_id,r.root_task_id);
 END IF;
 SELECT * INTO t FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(r.environment,r.organization_id,r.root_task_id);
 SELECT * INTO r FROM pactwoven.native_delegation_root_runs WHERE(environment,organization_id,root_task_id)=(r.environment,r.organization_id,r.root_task_id);
 IF next_state='ready' THEN PERFORM pactwoven.native_delegation_root_wake(r.environment,r.organization_id,r.root_task_id,t.generation);END IF;
 response:=jsonb_build_object('scope',pactwoven.native_memory_scope(ctx),'operationId',gen_random_uuid(),'rootTaskId',r.root_task_id,'action',q->'action','controlVersion',r.control_version,'generation',t.generation,'state',next_state,'committedAt',pactwoven.mandate_instant(clock_timestamp()));
 INSERT INTO pactwoven.native_delegation_root_controls VALUES(r.environment,r.organization_id,r.actor_id,p_key,r.root_task_id,q,response);
 PERFORM pactwoven.native_memory_notes_deadline(ctx);RETURN response;
END $$;
CREATE FUNCTION pactwoven.native_delegation_root_control_recover(p_actor jsonb,p_id text,p_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE r pactwoven.native_delegation_root_runs;ctx jsonb;answer jsonb;BEGIN
 PERFORM pactwoven.native_delegation_actor_locked(p_actor,NULL,false);SELECT * INTO r FROM pactwoven.native_delegation_root_runs
  WHERE(environment,organization_id,root_task_id,actor_id)=(p_actor->>'environment',p_actor->>'organizationId',p_id,p_actor->>'actorId');
 PERFORM pactwoven.native_memory_require(FOUND,'ND001');ctx:=pactwoven.native_delegation_actor_locked(p_actor,r.site_id,false);
 SELECT response INTO answer FROM pactwoven.native_delegation_root_controls WHERE(environment,organization_id,actor_id,root_task_id,request_key)=(r.environment,r.organization_id,r.actor_id,p_id,p_key);
 PERFORM pactwoven.native_memory_notes_deadline(ctx);RETURN answer;
END $$;
CREATE FUNCTION pactwoven.native_delegation_root_context(e text,selector jsonb,leased boolean) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE ctx jsonb;r pactwoven.native_delegation_root_runs;t pactwoven.native_delegation_tasks;BEGIN
 PERFORM pactwoven.native_delegation_service(e,ARRAY['coordinator']);ctx:=pactwoven.native_delegation_task_locked(e,selector,leased);
 SELECT * INTO r FROM pactwoven.native_delegation_root_runs WHERE(environment,organization_id,root_task_id)=(e,selector->>'organizationId',selector->>'taskId') FOR UPDATE;
 SELECT * INTO t FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(e,selector->>'organizationId',selector->>'taskId');
 PERFORM pactwoven.native_memory_require(r.root_task_id IS NOT NULL AND r.managed AND t.depth=0 AND NOT r.manual_paused AND t.attempt<=t.attempt_limit
  AND r.phase IN('ready','running','yielded','waiting_children') AND(NOT leased OR r.phase IN('ready','running')),'ND001');
 RETURN ctx;
END $$;
CREATE FUNCTION pactwoven.native_delegation_root_claim(e text,selector jsonb,lease_ms integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE ctx jsonb;r pactwoven.native_delegation_root_runs;t pactwoven.native_delegation_tasks;u timestamptz;BEGIN
 PERFORM pactwoven.native_memory_require(lease_ms BETWEEN 1000 AND 30000,'ND004');ctx:=pactwoven.native_delegation_root_context(e,selector,false);
 SELECT * INTO r FROM pactwoven.native_delegation_root_runs WHERE(environment,organization_id,root_task_id)=(e,selector->>'organizationId',selector->>'taskId');
 SELECT * INTO t FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(e,selector->>'organizationId',selector->>'taskId');
 PERFORM pactwoven.native_memory_require(EXISTS(SELECT 1 FROM pactwoven.native_delegation_root_note_selections WHERE(environment,organization_id,root_task_id)=(e,t.organization_id,t.id)),'ND001');
 PERFORM pactwoven.native_memory_require(r.phase<>'waiting_children' OR pactwoven.native_delegation_root_wait_ready(r),'ND009');
 IF t.state='running' AND t.lease_token IS NOT NULL THEN
  RAISE EXCEPTION USING ERRCODE='ND009',MESSAGE='An active claim cannot be shared or an expired claim revived';
 ELSE
  PERFORM pactwoven.native_memory_require((t.state='ready' AND r.phase='ready') OR(t.state='running' AND t.lease_token IS NULL AND r.phase IN('yielded','waiting_children')),'ND009');
  u:=least(clock_timestamp()+lease_ms*interval '1 millisecond',pactwoven.supplier_time(ctx->'validUntil'));
  UPDATE pactwoven.native_delegation_tasks SET state='running',lease_token=gen_random_uuid(),lease_until=u WHERE(environment,organization_id,id)=(e,t.organization_id,t.id) RETURNING * INTO t;
 END IF;
 UPDATE pactwoven.native_delegation_root_runs SET phase='running',reason='none',wait_for='{}',updated_at=clock_timestamp() WHERE(environment,organization_id,root_task_id)=(e,t.organization_id,t.id);
 PERFORM pactwoven.native_memory_require(t.lease_until>clock_timestamp(),'ND001');
 RETURN jsonb_build_object('selector',jsonb_build_object('organizationId',t.organization_id,'taskId',t.id,'generation',t.generation,'handoffId',NULL,'leaseToken',t.lease_token),
  'validUntil',pactwoven.mandate_instant(t.lease_until),'identity',t.identity,'authority',t.authority,'attempt',t.attempt,'handoff',NULL);
END $$;

-- ROOT_CHECKPOINT_INPUT_COMPLETION_ROUTINES
CREATE FUNCTION pactwoven.native_delegation_root_validate_inputs(ctx jsonb,choices jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE choice jsonb;result pactwoven.native_delegation_results;t pactwoven.native_delegation_tasks;
 a pactwoven.native_delegation_artifacts;u pactwoven.native_memory_usages;bound_ctx jsonb;checked jsonb;root_checked jsonb;artifacts jsonb;items jsonb:='[]';until_time timestamptz;usage_count integer:=0;BEGIN
 PERFORM pactwoven.native_memory_require(jsonb_typeof(choices)='array' AND jsonb_array_length(choices) BETWEEN 1 AND 32 AND
  (SELECT count(*)=count(DISTINCT x->>'handoffId') FROM jsonb_array_elements(choices) x),'ND004');
 FOR choice IN SELECT x FROM jsonb_array_elements(choices) x LOOP
  SELECT * INTO result FROM pactwoven.native_delegation_results WHERE(environment,organization_id,handoff_id)=(ctx->>'environment',ctx->>'organizationId',choice->>'handoffId');
  SELECT * INTO t FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,handoff_id)=(ctx->>'environment',ctx->>'organizationId',choice->>'handoffId');
  PERFORM pactwoven.native_memory_require(result.handoff_id IS NOT NULL AND result.digest=choice->>'publicationDigest' AND t.root_task_id=ctx#>>'{usage,taskId}'
   AND t.depth>0 AND t.state='settled' AND t.site_id=ctx->>'siteId' AND t.authority=ctx->'authority'
   AND(t.generation,t.assignment_version)=(result.generation,result.assignment_version),'ND001');
  artifacts:='[]';
  FOR a IN SELECT stored.* FROM jsonb_array_elements(result.publication->'artifacts') WITH ORDINALITY item(value,position)
   JOIN pactwoven.native_delegation_artifacts stored ON(stored.environment,stored.organization_id,stored.id,stored.revision)=
    (t.environment,t.organization_id,item.value#>>'{reference,artifactId}',(item.value#>>'{reference,revision}')::bigint) ORDER BY item.position LOOP
   PERFORM pactwoven.native_memory_require(a.task_id=t.id AND a.site_id=t.site_id AND a.publication_digest=result.digest AND a.valid_until>clock_timestamp()
    AND a.reference->>'digest'=pactwoven.native_delegation_hash(a.body),'NM008');
   artifacts:=artifacts||jsonb_build_array(jsonb_build_object('reference',a.reference,'body',a.body));until_time:=least(until_time,a.valid_until);
  END LOOP;
  PERFORM pactwoven.native_memory_require(artifacts=result.publication->'artifacts','NM009');
  IF jsonb_array_length(result.publication->'memoryUsage')>0 THEN
   PERFORM pactwoven.native_memory_require(ctx->'authority'=t.authority AND EXISTS(SELECT 1 FROM pactwoven.native_delegation_grants g
    WHERE(g.environment,g.organization_id,g.id)=(t.environment,t.organization_id,t.grant_id) AND g.body#>'{scope,capabilities}' ? 'read_scoped_memory'),'ND001');
   SELECT * INTO u FROM pactwoven.native_memory_usages WHERE id=(result.publication#>>'{memoryUsage,0,usageId}')::uuid;
   PERFORM pactwoven.native_memory_require(u.id IS NOT NULL AND(u.environment,u.organization_id,u.site_id)=(t.environment,t.organization_id,t.site_id)
    AND u.context#>>'{usage,taskId}'=t.id AND u.context#>>'{usage,handoffId}'=t.handoff_id AND u.context#>>'{usage,generation}'=t.generation::text
    AND u.publication_digest=result.digest,'NM009');
   bound_ctx:=u.context_binding||jsonb_build_object('validUntil',ctx->'validUntil');
   checked:=pactwoven.native_memory_assert_usage_locked(t.environment,bound_ctx,result.publication->'memoryUsage',result.digest);
   until_time:=least(until_time,pactwoven.native_memory_time(checked->'dataValidUntil'));usage_count:=usage_count+(checked->>'usageCount')::integer;
   PERFORM pactwoven.native_memory_require(usage_count<=128,'NM007');
   FOR u IN SELECT * FROM pactwoven.native_memory_usages WHERE(environment,organization_id,site_id)=(t.environment,t.organization_id,t.site_id)
    AND context->'usage'=bound_ctx->'usage' ORDER BY id LOOP
    -- Re-evaluate the same immutable closure using the root's own reader ACL.
    -- This creates no ordinary memory usage or invented root handoff.
    root_checked:=pactwoven.native_memory_evaluate_locked(pactwoven.native_memory_data_context(ctx),u.selection->'root',date_trunc('milliseconds',clock_timestamp()));
    PERFORM pactwoven.native_memory_require(root_checked#>'{selection,memories}'=u.selection->'memories'
     AND root_checked#>'{selection,sources}'=u.selection->'sources','NM005');
    until_time:=least(until_time,pactwoven.native_memory_time(root_checked#>'{selection,validUntil}'));
   END LOOP;
  ELSE
   PERFORM pactwoven.native_memory_require(NOT EXISTS(SELECT 1 FROM pactwoven.native_memory_usages WHERE(environment,organization_id,site_id)=(t.environment,t.organization_id,t.site_id)
    AND context#>>'{usage,taskId}'=t.id AND context#>>'{usage,handoffId}'=t.handoff_id AND context#>>'{usage,generation}'=t.generation::text),'NM009');
  END IF;
  items:=items||jsonb_build_array(jsonb_build_object('handoffId',t.handoff_id,'publicationDigest',result.digest,'outcome',result.publication#>'{result,outcome}','artifacts',artifacts));
 END LOOP;
 PERFORM pactwoven.native_memory_require(octet_length(items::text)<=524288 AND pactwoven.native_memory_time(ctx->'validUntil')>clock_timestamp()
  AND(until_time IS NULL OR until_time>clock_timestamp()),'NM008');
 RETURN jsonb_build_object('results',items,'dataValidUntil',CASE WHEN until_time IS NOT NULL THEN pactwoven.mandate_instant(until_time) END);
END $$;
CREATE FUNCTION pactwoven.native_delegation_root_receipt_manifest(ctx jsonb,refs jsonb) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE actual jsonb;expected jsonb;BEGIN
 SELECT coalesce(jsonb_agg(jsonb_build_object('receiptId',id,'digest',digest) ORDER BY id),'[]') INTO actual FROM pactwoven.native_delegation_root_inputs
  WHERE(environment,organization_id,root_task_id,generation)=(ctx->>'environment',ctx->>'organizationId',ctx#>>'{usage,taskId}',(ctx#>>'{usage,generation}')::bigint);
 SELECT coalesce(jsonb_agg(x ORDER BY x->>'receiptId'),'[]') INTO expected FROM jsonb_array_elements(refs) x;
 PERFORM pactwoven.native_memory_require(actual=expected AND jsonb_array_length(actual)<=128,'NM005');
END $$;
CREATE FUNCTION pactwoven.native_delegation_root_receipts(ctx jsonb,refs jsonb) RETURNS timestamptz
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE r pactwoven.native_delegation_root_inputs;checked jsonb;deadline timestamptz;BEGIN
 PERFORM pactwoven.native_delegation_root_receipt_manifest(ctx,refs);
 FOR r IN SELECT * FROM pactwoven.native_delegation_root_inputs WHERE(environment,organization_id,root_task_id,generation)=
  (ctx->>'environment',ctx->>'organizationId',ctx#>>'{usage,taskId}',(ctx#>>'{usage,generation}')::bigint) ORDER BY id LOOP
  PERFORM pactwoven.native_memory_require(r.context_binding=ctx-'validUntil','NM005');
  checked:=pactwoven.native_delegation_root_validate_inputs(ctx,r.body->'choices');
  PERFORM pactwoven.native_memory_require(checked->'results'=r.body->'results' AND checked->'dataValidUntil'=r.body->'dataValidUntil','NM005');
  deadline:=least(deadline,r.data_valid_until);
 END LOOP;
 PERFORM pactwoven.native_memory_require(pactwoven.native_memory_time(ctx->'validUntil')>clock_timestamp() AND(deadline IS NULL OR deadline>clock_timestamp()),'NM008');RETURN deadline;
END $$;
CREATE FUNCTION pactwoven.native_delegation_root_inputs(e text,selector jsonb,q jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE ctx jsonb;t pactwoven.native_delegation_tasks;prior pactwoven.native_delegation_root_commands;r pactwoven.native_delegation_root_inputs;checked jsonb;body jsonb;answer jsonb;BEGIN
 PERFORM pactwoven.native_delegation_root_require(q,'inputs');ctx:=pactwoven.native_delegation_root_context(e,selector,true);
 SELECT * INTO t FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(e,selector->>'organizationId',selector->>'taskId');
 SELECT * INTO prior FROM pactwoven.native_delegation_root_commands WHERE(environment,organization_id,root_task_id,request_key)=(e,t.organization_id,t.id,q->>'requestKey');
 IF FOUND THEN
  PERFORM pactwoven.native_memory_require(prior.kind='inputs' AND prior.intent=q AND prior.generation=t.generation AND prior.identity=t.identity,'ND009');
  checked:=pactwoven.native_delegation_root_validate_inputs(ctx,q->'results');
  PERFORM pactwoven.native_memory_require(checked->'results'=prior.response->'results' AND checked->'dataValidUntil'=prior.response->'dataValidUntil','NM005');RETURN prior.response;
 END IF;
 PERFORM pactwoven.native_memory_require((SELECT count(*) FROM pactwoven.native_delegation_root_inputs WHERE(environment,organization_id,root_task_id,generation)=(e,t.organization_id,t.id,t.generation))<128,'NM007');
 checked:=pactwoven.native_delegation_root_validate_inputs(ctx,q->'results');
 body:=checked||jsonb_build_object('rootTaskId',t.id,'generation',t.generation,'choices',q->'results');
 INSERT INTO pactwoven.native_delegation_root_inputs(environment,organization_id,root_task_id,generation,context_binding,body,digest,data_valid_until)
  VALUES(e,t.organization_id,t.id,t.generation,ctx-'validUntil',body,pactwoven.native_delegation_hash(body),pactwoven.native_memory_time(checked->'dataValidUntil')) RETURNING * INTO r;
 answer:=checked||jsonb_build_object('receipt',jsonb_build_object('receiptId',r.id,'digest',r.digest),'generation',t.generation);
 INSERT INTO pactwoven.native_delegation_root_commands VALUES(e,t.organization_id,t.id,q->>'requestKey','inputs',t.generation,t.identity,q,answer);
 PERFORM pactwoven.native_delegation_root_context(e,selector,true);RETURN answer;
END $$;
CREATE FUNCTION pactwoven.native_delegation_root_checkpoint_write(e text,selector jsonb,q jsonb,yielding boolean) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE ctx jsonb;r pactwoven.native_delegation_root_runs;t pactwoven.native_delegation_tasks;prior pactwoven.native_delegation_root_commands;identity jsonb;kind text;answer jsonb;continuation text;waits text[];BEGIN
 kind:=CASE WHEN yielding THEN 'yield' ELSE 'checkpoint' END;PERFORM pactwoven.native_delegation_root_require(q,kind);
 identity:=pactwoven.native_delegation_service(e,ARRAY['coordinator']);PERFORM pactwoven.native_delegation_target(selector,true);
 SELECT * INTO t FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(e,selector->>'organizationId',selector->>'taskId');
 PERFORM pactwoven.native_memory_require(t.id IS NOT NULL AND t.depth=0 AND t.identity=identity,'ND001');
 PERFORM pactwoven.native_delegation_grant_locked(e,t.organization_id,t.grant_id);
 SELECT * INTO prior FROM pactwoven.native_delegation_root_commands WHERE(environment,organization_id,root_task_id,request_key)=(e,t.organization_id,t.id,q->>'requestKey');
 IF FOUND THEN PERFORM pactwoven.native_memory_require(prior.kind=kind AND prior.intent=q AND prior.identity=identity AND prior.generation=(selector->>'generation')::bigint,'ND009');RETURN prior.response;END IF;
 ctx:=pactwoven.native_delegation_root_context(e,selector,true);
 SELECT * INTO r FROM pactwoven.native_delegation_root_runs WHERE(environment,organization_id,root_task_id)=(e,t.organization_id,t.id);
 SELECT * INTO t FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(e,t.organization_id,t.id);
 PERFORM pactwoven.native_memory_require(r.checkpoint_version=(q->>'expectedCheckpointVersion')::bigint AND r.slice_count<256 AND octet_length(q->>'plannerState')<=65536,'ND009');
 PERFORM pactwoven.native_delegation_root_receipts(ctx,q->'inputReceipts');
 continuation:='running';waits:='{}';
 IF yielding THEN
  SELECT coalesce(array_agg(x ORDER BY x COLLATE "C"),'{}') INTO waits FROM jsonb_array_elements_text(q->'waitFor') x;
  PERFORM pactwoven.native_memory_require(cardinality(waits)=(SELECT count(DISTINCT x) FROM unnest(waits) x)
   AND((q->>'continuation'='continue' AND cardinality(waits)=0) OR(q->>'continuation'='wait_children' AND cardinality(waits)>0))
   AND NOT EXISTS(SELECT 1 FROM unnest(waits) w(id) LEFT JOIN pactwoven.native_delegation_tasks child ON(child.environment,child.organization_id,child.id)=(e,t.organization_id,w.id)
    WHERE child.id IS NULL OR child.root_task_id<>t.id OR child.depth=0 OR child.state IN('paused','cancelled')),'ND004');
  continuation:=CASE WHEN q->>'continuation'='continue' THEN 'yielded' ELSE 'waiting_children' END;
 END IF;
 INSERT INTO pactwoven.native_delegation_root_checkpoints(environment,organization_id,root_task_id,version,generation,body,planner_state,input_receipts)
  VALUES(e,t.organization_id,t.id,r.checkpoint_version+1,t.generation,q->'checkpoint',q->>'plannerState',q->'inputReceipts');
 UPDATE pactwoven.native_delegation_root_runs SET checkpoint_version=checkpoint_version+1,phase=continuation,wait_for=waits,slice_count=slice_count+1,updated_at=clock_timestamp()
  WHERE(environment,organization_id,root_task_id)=(e,t.organization_id,t.id) RETURNING * INTO r;
 PERFORM pactwoven.native_memory_require(pactwoven.native_memory_time(ctx->'validUntil')>clock_timestamp(),'NM008');
 IF yielding THEN
  UPDATE pactwoven.native_delegation_tasks SET generation=generation+1,lease_token=NULL,lease_until=NULL WHERE(environment,organization_id,id)=(e,t.organization_id,t.id) RETURNING * INTO t;
  UPDATE pactwoven.native_delegation_proofs SET verdict='unknown',valid_until=NULL,nonce=NULL,nonce_barrier=NULL,prepared_at=NULL,deadline_at=NULL,barrier=barrier+1 WHERE(environment,organization_id,task_id)=(e,t.organization_id,t.id);
  UPDATE pactwoven.native_delegation_outbox SET state='suppressed',token=NULL,lease_until=NULL WHERE(environment,organization_id,task_id)=(e,t.organization_id,t.id);
  IF continuation='yielded' OR pactwoven.native_delegation_root_wait_ready(r) THEN PERFORM pactwoven.native_delegation_root_wake(e,t.organization_id,t.id,t.generation);END IF;
 END IF;
 answer:=jsonb_build_object('checkpointVersion',r.checkpoint_version,'generation',t.generation,'attempt',t.attempt,'continuation',continuation,'requestKey',q->'requestKey');
 INSERT INTO pactwoven.native_delegation_root_commands VALUES(e,t.organization_id,t.id,q->>'requestKey',kind,(selector->>'generation')::bigint,t.identity,q,answer);RETURN answer;
END $$;
CREATE FUNCTION pactwoven.native_delegation_root_checkpoint(e text,selector jsonb,q jsonb) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT pactwoven.native_delegation_root_checkpoint_write(e,selector,q,false) $$;
CREATE FUNCTION pactwoven.native_delegation_root_yield(e text,selector jsonb,q jsonb) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT pactwoven.native_delegation_root_checkpoint_write(e,selector,q,true) $$;
CREATE FUNCTION pactwoven.native_delegation_root_complete(e text,selector jsonb,q jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE ctx jsonb;r pactwoven.native_delegation_root_runs;t pactwoven.native_delegation_tasks;prior pactwoven.native_delegation_root_completions;
 identity jsonb;coverage jsonb;deadline timestamptz;declared timestamptz;answer jsonb;BEGIN
 PERFORM pactwoven.native_delegation_root_require(q,'complete');identity:=pactwoven.native_delegation_service(e,ARRAY['coordinator']);PERFORM pactwoven.native_delegation_target(selector,true);
 SELECT * INTO t FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(e,selector->>'organizationId',selector->>'taskId');
 PERFORM pactwoven.native_memory_require(t.id IS NOT NULL AND t.depth=0 AND t.identity=identity,'ND001');PERFORM pactwoven.native_delegation_grant_locked(e,t.organization_id,t.grant_id);
 SELECT * INTO prior FROM pactwoven.native_delegation_root_completions WHERE(environment,organization_id,root_task_id)=(e,t.organization_id,t.id);
 IF FOUND THEN PERFORM pactwoven.native_memory_require(prior.publication=q AND prior.generation=(selector->>'generation')::bigint,'ND009');
  RETURN jsonb_build_object('kind','duplicate','publicationDigest',prior.digest,'rootTaskId',t.id,'execution','none','domainCompletion',false);END IF;
 ctx:=pactwoven.native_delegation_root_context(e,selector,true);SELECT * INTO r FROM pactwoven.native_delegation_root_runs WHERE(environment,organization_id,root_task_id)=(e,t.organization_id,t.id);
 PERFORM pactwoven.native_memory_require(r.checkpoint_version=(q->>'expectedCheckpointVersion')::bigint AND NOT EXISTS(SELECT 1 FROM pactwoven.native_delegation_tasks
  WHERE(environment,organization_id,root_task_id)=(e,t.organization_id,t.id) AND depth>0 AND(state NOT IN('settled','cancelled') OR(state='cancelled' AND NOT EXISTS
   (SELECT 1 FROM pactwoven.native_delegation_root_dispositions d WHERE(d.environment,d.organization_id,d.task_id)=(e,t.organization_id,native_delegation_tasks.id))))),'ND009');
 coverage:=pactwoven.native_delegation_root_coverage(e,t.organization_id,t.id);PERFORM pactwoven.native_memory_require(q->'coverage'=coverage,'ND009');
 IF q#>>'{result,outcome}'='blocked' THEN PERFORM pactwoven.native_delegation_root_receipt_manifest(ctx,q->'inputReceipts');
 ELSE deadline:=pactwoven.native_delegation_root_receipts(ctx,q->'inputReceipts');END IF;
 declared:=pactwoven.native_memory_time(q#>'{result,evidenceValidUntil}');
 PERFORM pactwoven.native_memory_require((q#>>'{result,outcome}'='blocked' AND q#>'{result,artifacts}'='[]'::jsonb AND q#>'{result,evidenceValidUntil}'='null'::jsonb
   AND q#>>'{result,title}'='Work needs review' AND q#>>'{result,summary}'='The work could not be completed with current, permitted evidence.')
  OR(q#>>'{result,outcome}'='advice_ready' AND jsonb_array_length(q#>'{result,artifacts}')>0 AND declared>clock_timestamp() AND(deadline IS NULL OR declared<=deadline)),'NM008');
 PERFORM pactwoven.native_memory_require((SELECT count(*)=count(DISTINCT x->>'id') FROM jsonb_array_elements(q#>'{result,artifacts}') x),'ND004');
 -- Every successful child must actually have been consumed in this generation.
 PERFORM pactwoven.native_memory_require(q#>>'{result,outcome}'='blocked' OR NOT EXISTS(SELECT 1 FROM pactwoven.native_delegation_results child JOIN pactwoven.native_delegation_tasks task
  ON(task.environment,task.organization_id,task.handoff_id)=(child.environment,child.organization_id,child.handoff_id)
  WHERE(task.environment,task.organization_id,task.root_task_id)=(e,t.organization_id,t.id) AND child.publication#>>'{result,outcome}'='advice_ready'
  AND NOT EXISTS(SELECT 1 FROM pactwoven.native_delegation_root_inputs i,jsonb_array_elements(i.body->'choices') c
   WHERE(i.environment,i.organization_id,i.root_task_id,i.generation)=(e,t.organization_id,t.id,t.generation) AND c->>'handoffId'=child.handoff_id AND c->>'publicationDigest'=child.digest)),'NM005');
 INSERT INTO pactwoven.native_delegation_root_completions VALUES(e,t.organization_id,t.id,t.generation,q,pactwoven.native_delegation_hash(q),clock_timestamp()) RETURNING * INTO prior;
 PERFORM pactwoven.native_delegation_root_context(e,selector,true);PERFORM pactwoven.native_memory_require((deadline IS NULL OR deadline>clock_timestamp()) AND(declared IS NULL OR declared>clock_timestamp()),'NM008');
 UPDATE pactwoven.native_delegation_root_runs SET phase=CASE WHEN q#>>'{result,outcome}'='blocked' THEN 'blocked' ELSE 'completed' END,
  reason=CASE WHEN q#>>'{result,outcome}'='blocked' THEN 'reconciliation' ELSE 'none' END,control_version=control_version+1,updated_at=clock_timestamp() WHERE(environment,organization_id,root_task_id)=(e,t.organization_id,t.id);
 UPDATE pactwoven.native_delegation_tasks SET state='settled',lease_token=NULL,lease_until=NULL WHERE(environment,organization_id,id)=(e,t.organization_id,t.id);
 UPDATE pactwoven.native_delegation_outbox SET state='suppressed',token=NULL,lease_until=NULL WHERE(environment,organization_id,task_id)=(e,t.organization_id,t.id);
 answer:=jsonb_build_object('kind','accepted','publicationDigest',prior.digest,'rootTaskId',t.id,'execution',CASE WHEN q#>>'{result,outcome}'='blocked' THEN 'none' ELSE 'advisory_only' END,'domainCompletion',false);
 INSERT INTO pactwoven.native_delegation_root_commands VALUES(e,t.organization_id,t.id,q->>'requestKey','complete',t.generation,t.identity,q,answer);RETURN answer;
END $$;
-- ROOT_RECOVERY_AND_PRIVILEGES
CREATE FUNCTION pactwoven.native_delegation_root_bind_notes(p_actor jsonb,p_key text,q jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE ctx jsonb;r pactwoven.native_delegation_root_runs;t pactwoven.native_delegation_tasks;
 prior pactwoven.native_delegation_root_note_selections;choice jsonb;n pactwoven.native_memory_notes;m jsonb;s jsonb;refs jsonb:='[]';descriptions jsonb:='[]';BEGIN
 PERFORM pactwoven.native_delegation_root_require(q,'bind_notes');PERFORM pactwoven.native_memory_require(p_key ~ '^[A-Za-z0-9_-]{16,128}$','ND004');
 PERFORM pactwoven.native_delegation_actor_locked(p_actor,NULL,true);SELECT * INTO r FROM pactwoven.native_delegation_root_runs
  WHERE(environment,organization_id,root_task_id,actor_id)=(p_actor->>'environment',p_actor->>'organizationId',q->>'rootTaskId',p_actor->>'actorId');
 PERFORM pactwoven.native_memory_require(FOUND,'ND001');ctx:=pactwoven.native_delegation_actor_locked(p_actor,r.site_id,true);
 PERFORM pactwoven.native_delegation_grant_locked(r.environment,r.organization_id,r.grant_id);
 SELECT * INTO prior FROM pactwoven.native_delegation_root_note_selections WHERE(environment,organization_id,root_task_id)=(r.environment,r.organization_id,r.root_task_id);
 IF FOUND THEN PERFORM pactwoven.native_memory_require(prior.request_key=p_key AND prior.intent=q,'ND009');PERFORM pactwoven.native_memory_notes_deadline(ctx);
  RETURN jsonb_build_object('rootTaskId',r.root_task_id,'selectedCount',jsonb_array_length(prior.memory_references));END IF;
 SELECT * INTO t FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(r.environment,r.organization_id,r.root_task_id) FOR UPDATE;
 PERFORM pactwoven.native_memory_require(t.state='ready' AND t.attempt=1 AND t.generation=1 AND t.lease_token IS NULL AND r.checkpoint_version=0
  AND NOT EXISTS(SELECT 1 FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,root_task_id)=(r.environment,r.organization_id,r.root_task_id) AND depth>0),'ND009');
 PERFORM pactwoven.native_memory_require((SELECT count(*)=count(DISTINCT x->>'noteId') FROM jsonb_array_elements(q->'selections') x),'ND004');
 IF jsonb_array_length(q->'selections')>0 THEN PERFORM pactwoven.native_memory_lock_scope(ctx,false);END IF;
 FOR choice IN SELECT x FROM jsonb_array_elements(q->'selections') x LOOP
  SELECT * INTO n FROM pactwoven.native_memory_notes WHERE(environment,organization_id,site_id,id,actor_id)=(r.environment,r.organization_id,r.site_id,choice->>'noteId',r.actor_id);
  PERFORM pactwoven.native_memory_require(FOUND,'ND001');
  SELECT v.record INTO m FROM pactwoven.native_memory_heads h JOIN pactwoven.native_memory_revisions v USING(environment,organization_id,site_id,memory_id,revision,digest)
   WHERE(h.environment,h.organization_id,h.site_id,h.memory_id)=(r.environment,r.organization_id,r.site_id,n.memory_id);
  SELECT v.record INTO s FROM pactwoven.native_memory_source_heads h JOIN pactwoven.native_memory_source_revisions v USING(environment,organization_id,site_id,source_id,revision,digest)
   WHERE(h.environment,h.organization_id,h.site_id,h.source_id)=(r.environment,r.organization_id,r.site_id,n.source_id);
  PERFORM pactwoven.native_memory_require(m IS NOT NULL AND s IS NOT NULL AND pactwoven.native_memory_notes_version(m,s)=choice->>'expected','NM005');
  PERFORM pactwoven.native_memory_require(pactwoven.native_memory_notes_project_locked(ctx,n.id)->>'status'='available','NM006');
  PERFORM pactwoven.native_memory_readable(m,ctx||jsonb_build_object('purpose','task_context'),'recordedAt',clock_timestamp());
  PERFORM pactwoven.native_memory_readable(s,ctx||jsonb_build_object('purpose','task_context'),'observedAt',clock_timestamp());
  refs:=refs||jsonb_build_array(pactwoven.native_memory_ref(m));
  descriptions:=descriptions||jsonb_build_array(jsonb_build_object('title',m#>'{content,title}','purpose',m#>'{content,attributes,purpose}'));
 END LOOP;
 INSERT INTO pactwoven.native_delegation_root_note_selections(environment,organization_id,root_task_id,request_key,intent,memory_references,descriptions)
  VALUES(r.environment,r.organization_id,r.root_task_id,p_key,q,refs,descriptions);
 UPDATE pactwoven.native_delegation_root_runs SET managed=true WHERE(environment,organization_id,root_task_id)=(r.environment,r.organization_id,r.root_task_id);
 PERFORM pactwoven.native_memory_notes_deadline(ctx);RETURN jsonb_build_object('rootTaskId',r.root_task_id,'selectedCount',jsonb_array_length(refs));
END $$;
CREATE FUNCTION pactwoven.native_delegation_root_work(e text,selector jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE ctx jsonb;r pactwoven.native_delegation_root_runs;c pactwoven.native_delegation_root_checkpoints;historical boolean:=false;answer jsonb;BEGIN
 ctx:=pactwoven.native_delegation_root_context(e,selector,true);SELECT * INTO r FROM pactwoven.native_delegation_root_runs
  WHERE(environment,organization_id,root_task_id)=(e,selector->>'organizationId',selector->>'taskId');
 SELECT * INTO c FROM pactwoven.native_delegation_root_checkpoints WHERE(environment,organization_id,root_task_id,version)=(e,r.organization_id,r.root_task_id,r.checkpoint_version);
 IF c.version IS NOT NULL THEN
  historical:=c.generation<>(selector->>'generation')::bigint;
  BEGIN
   -- Saved planner data can contain derived text. Historical status alone is
   -- not authorization to return it after original source/reader access loss.
   PERFORM pactwoven.native_delegation_root_receipts(jsonb_set(ctx,'{usage,generation}',to_jsonb(c.generation)),c.input_receipts);
  EXCEPTION WHEN SQLSTATE 'NM001' OR SQLSTATE 'NM005' OR SQLSTATE 'NM006' OR SQLSTATE 'NM007' OR SQLSTATE 'NM008' OR SQLSTATE 'NM009' OR SQLSTATE 'ND001' THEN
   c.body:=NULL;c.planner_state:=NULL;historical:=true;
  END;
 END IF;
 answer:=jsonb_build_object('title',r.title,'prompt',r.prompt,'siteId',r.site_id,
  'grant',(SELECT body FROM pactwoven.native_delegation_grants WHERE(environment,organization_id,id)=(e,r.organization_id,r.grant_id)),
  'checkpointVersion',r.checkpoint_version,'checkpoint',c.body,'plannerState',c.planner_state,'historical',historical,
  'children',(SELECT coalesce(jsonb_agg(jsonb_build_object('taskId',t.id,'handoffId',t.handoff_id,'generation',t.generation,'assignmentVersion',t.assignment_version,'state',t.state,
    'publicationDigest',result.digest,'outcome',result.publication#>'{result,outcome}','assignment',a.assignment) ORDER BY t.id COLLATE "C"),'[]') FROM pactwoven.native_delegation_tasks t
    LEFT JOIN pactwoven.native_delegation_root_assignments a ON(a.environment,a.organization_id,a.task_id)=(t.environment,t.organization_id,t.id)
    LEFT JOIN pactwoven.native_delegation_results result ON(result.environment,result.organization_id,result.handoff_id)=(t.environment,t.organization_id,t.handoff_id)
    WHERE(t.environment,t.organization_id,t.root_task_id)=(e,r.organization_id,r.root_task_id) AND t.depth>0),
  'inputReceipts',(SELECT coalesce(jsonb_agg(jsonb_build_object('receiptId',id,'digest',digest) ORDER BY id),'[]') FROM pactwoven.native_delegation_root_inputs
    WHERE(environment,organization_id,root_task_id,generation)=(e,r.organization_id,r.root_task_id,(selector->>'generation')::bigint)),
  'memoryReferences',(SELECT memory_references FROM pactwoven.native_delegation_root_note_selections WHERE(environment,organization_id,root_task_id)=(e,r.organization_id,r.root_task_id)));
 PERFORM pactwoven.native_memory_require(pactwoven.native_memory_time(ctx->'validUntil')>clock_timestamp(),'NM008');RETURN answer;
END $$;
CREATE FUNCTION pactwoven.native_delegation_root_handoff(e text,selector jsonb,q jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE ctx jsonb;r pactwoven.native_delegation_root_runs;a pactwoven.native_delegation_root_assignments;selected jsonb;answer jsonb;BEGIN
 PERFORM pactwoven.native_delegation_root_require(q,'handoff');ctx:=pactwoven.native_delegation_root_context(e,selector,true);
 SELECT * INTO r FROM pactwoven.native_delegation_root_runs WHERE(environment,organization_id,root_task_id)=(e,selector->>'organizationId',selector->>'taskId');
 SELECT * INTO a FROM pactwoven.native_delegation_root_assignments WHERE(environment,organization_id,root_task_id,request_key)=(e,r.organization_id,r.root_task_id,q->>'requestKey');
 IF FOUND THEN PERFORM pactwoven.native_memory_require(a.intent=q,'ND009');RETURN a.response;END IF;
 -- A new free-text brief could copy consumed child material without its
 -- original reader closure. Plan all assignments before consuming results.
 -- This barrier lasts for the root's lifetime, including yield/recovery;
 -- exact retained assignment replay above returns metadata only.
 PERFORM pactwoven.native_memory_require(NOT EXISTS(SELECT 1 FROM pactwoven.native_delegation_root_inputs
  WHERE(environment,organization_id,root_task_id)=(e,r.organization_id,r.root_task_id)),'ND001');
 SELECT memory_references INTO selected FROM pactwoven.native_delegation_root_note_selections WHERE(environment,organization_id,root_task_id)=(e,r.organization_id,r.root_task_id);
 PERFORM pactwoven.native_memory_require(selected IS NOT NULL AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(q#>'{assignment,memoryReferences}') ref WHERE NOT selected @> jsonb_build_array(ref))
  AND(SELECT count(*)=count(DISTINCT x->>'memoryId') FROM jsonb_array_elements(q#>'{assignment,memoryReferences}') x)
  AND(jsonb_array_length(q#>'{assignment,memoryReferences}')=0 OR q#>>'{handoff,capability}'='read_scoped_memory'),'ND001');
 answer:=pactwoven.native_delegation_handoff(e,selector,q->'handoff');
 INSERT INTO pactwoven.native_delegation_root_assignments VALUES(e,r.organization_id,r.root_task_id,q#>>'{handoff,childTaskId}',q#>>'{handoff,handoffId}',q->>'requestKey',
  (q#>>'{handoff,assignmentVersion}')::bigint,(q#>>'{handoff,generation}')::bigint,q,q->'assignment',answer);
 PERFORM pactwoven.native_delegation_root_context(e,selector,true);RETURN answer;
END $$;
CREATE FUNCTION pactwoven.native_delegation_root_materials(e text,selector jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE ctx jsonb;t pactwoven.native_delegation_tasks;r pactwoven.native_delegation_root_runs;a pactwoven.native_delegation_root_assignments;h jsonb;selected jsonb;artifacts jsonb;BEGIN
 ctx:=pactwoven.native_delegation_task_context_locked(e,selector,'result_publish');SELECT * INTO t FROM pactwoven.native_delegation_tasks
  WHERE(environment,organization_id,id)=(e,selector->>'organizationId',selector->>'taskId');
 SELECT * INTO r FROM pactwoven.native_delegation_root_runs WHERE(environment,organization_id,root_task_id)=(e,t.organization_id,t.root_task_id);
 SELECT * INTO a FROM pactwoven.native_delegation_root_assignments WHERE(environment,organization_id,task_id)=(e,t.organization_id,t.id);
 PERFORM pactwoven.native_memory_require(r.managed AND a.task_id IS NOT NULL AND(a.generation,a.assignment_version,a.handoff_id)=(t.generation,t.assignment_version,t.handoff_id),'ND001');
 SELECT memory_references INTO selected FROM pactwoven.native_delegation_root_note_selections WHERE(environment,organization_id,root_task_id)=(e,t.organization_id,t.root_task_id);
 PERFORM pactwoven.native_memory_require(selected IS NOT NULL AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(a.assignment->'memoryReferences') ref WHERE NOT selected @> jsonb_build_array(ref)),'ND001');
 SELECT body INTO h FROM pactwoven.native_delegation_envelopes WHERE(environment,organization_id,handoff_id,assignment_version,generation,kind)=(e,t.organization_id,t.handoff_id,t.assignment_version,t.generation,'handoff');
 PERFORM pactwoven.native_delegation_inputs_locked(e,t.organization_id,t.site_id,h->'inputArtifacts');
 SELECT coalesce(jsonb_agg(jsonb_build_object('reference',stored.reference,'body',stored.body) ORDER BY refs.position),'[]') INTO artifacts
  FROM jsonb_array_elements(h->'inputArtifacts') WITH ORDINALITY refs(ref,position) JOIN pactwoven.native_delegation_artifacts stored
   ON(stored.environment,stored.organization_id,stored.id,stored.revision)=(e,t.organization_id,refs.ref->>'artifactId',(refs.ref->>'revision')::bigint);
 PERFORM pactwoven.native_memory_require(pactwoven.native_memory_time(ctx->'validUntil')>clock_timestamp(),'NM008');
 RETURN jsonb_build_object('actorId',r.actor_id,'rootTitle',r.title,'rootPrompt',r.prompt,'assignment',a.assignment,'inputArtifacts',artifacts);
END $$;
-- Approved memory-loader delta: exact 0027 loader plus a managed-root
-- selection guard. Legacy status is an explicit pre-0029 backfill fact, never
-- inferred from absent assignment/binding rows. Its original ACL is preserved.
CREATE OR REPLACE FUNCTION pactwoven.native_memory_task_read(p_environment text,p_selector jsonb,p_reference jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE ctx jsonb;t pactwoven.native_delegation_tasks;r pactwoven.native_delegation_root_runs;a pactwoven.native_delegation_root_assignments;selected jsonb;BEGIN
  ctx:=pactwoven.native_delegation_task_context_locked(p_environment,p_selector,'memory_read');
  PERFORM pactwoven.native_memory_require(ctx->>'purpose'='task_context' AND ctx#>>'{reader,kind}'='agent' AND ctx#>>'{usage,handoffId}' IS NOT NULL,'NM001');
  SELECT * INTO t FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(p_environment,p_selector->>'organizationId',p_selector->>'taskId');
  SELECT * INTO r FROM pactwoven.native_delegation_root_runs WHERE(environment,organization_id,root_task_id)=(p_environment,t.organization_id,t.root_task_id);
  PERFORM pactwoven.native_memory_require(r.root_task_id IS NOT NULL,'NM001');
  IF r.managed THEN
   SELECT * INTO a FROM pactwoven.native_delegation_root_assignments WHERE(environment,organization_id,task_id)=(p_environment,t.organization_id,t.id);
   SELECT memory_references INTO selected FROM pactwoven.native_delegation_root_note_selections WHERE(environment,organization_id,root_task_id)=(p_environment,t.organization_id,t.root_task_id);
   PERFORM pactwoven.native_memory_require(a.task_id IS NOT NULL AND(a.generation,a.assignment_version,a.handoff_id)=(t.generation,t.assignment_version,t.handoff_id)
    AND selected @> jsonb_build_array(p_reference) AND a.assignment->'memoryReferences' @> jsonb_build_array(p_reference),'NM001');
  END IF;
  RETURN pactwoven.native_memory_select_locked(ctx,p_reference,pactwoven.native_memory_time(ctx->'validUntil'));
END $$;
-- Additional approved existing v2 delta: exclusive claims for managed tasks.
CREATE OR REPLACE FUNCTION pactwoven.native_delegation_claim(p_environment text,p_selector jsonb,p_lease_ms integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c jsonb;t pactwoven.native_delegation_tasks%ROWTYPE;u timestamptz;
BEGIN
 IF p_lease_ms IS NULL OR p_lease_ms NOT BETWEEN 1000 AND 30000 THEN RAISE EXCEPTION USING ERRCODE='ND004',MESSAGE='Bounded lease required'; END IF;
 c:=pactwoven.native_delegation_task_locked(p_environment,p_selector,false);
 SELECT * INTO t FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(p_environment,p_selector->>'organizationId',p_selector->>'taskId');
 IF NOT EXISTS(SELECT 1 FROM pactwoven.native_delegation_root_runs run WHERE(run.environment,run.organization_id,run.root_task_id)=(t.environment,t.organization_id,t.root_task_id)) THEN
  RAISE EXCEPTION USING ERRCODE='ND001',MESSAGE='Explicit managed or historical root classification required';END IF;
 -- Managed lifecycle deliveries are exclusive claims. The original legacy
 -- claim behavior remains below, including its retained duplicate semantics.
 IF EXISTS(SELECT 1 FROM pactwoven.native_delegation_root_runs run
  WHERE(run.environment,run.organization_id,run.root_task_id)=(t.environment,t.organization_id,t.root_task_id) AND run.managed) THEN
  IF t.depth>0 AND NOT EXISTS(SELECT 1 FROM pactwoven.native_delegation_root_assignments assignment
   WHERE(assignment.environment,assignment.organization_id,assignment.root_task_id,assignment.task_id,assignment.handoff_id,assignment.generation,assignment.assignment_version)=
    (t.environment,t.organization_id,t.root_task_id,t.id,t.handoff_id,t.generation,t.assignment_version)) THEN
   RAISE EXCEPTION USING ERRCODE='ND001',MESSAGE='Retained managed specialist assignment required';
  END IF;
  IF t.state='running' THEN RAISE EXCEPTION USING ERRCODE='ND009',MESSAGE='An active managed claim cannot be shared or an expired claim revived';END IF;
 END IF;
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

CREATE FUNCTION pactwoven.native_delegation_root_claim_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE r pactwoven.native_delegation_root_runs;BEGIN
 IF NEW.depth=0 AND OLD.state='ready' AND NEW.state='running' THEN
  SELECT * INTO r FROM pactwoven.native_delegation_root_runs WHERE(environment,organization_id,root_task_id)=(NEW.environment,NEW.organization_id,NEW.id);
  IF r.managed THEN PERFORM pactwoven.native_memory_require(EXISTS(SELECT 1 FROM pactwoven.native_delegation_root_note_selections
   WHERE(environment,organization_id,root_task_id)=(NEW.environment,NEW.organization_id,NEW.id)),'ND001');END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER native_root_claim_selection BEFORE UPDATE OF state ON pactwoven.native_delegation_tasks FOR EACH ROW EXECUTE FUNCTION pactwoven.native_delegation_root_claim_guard();
CREATE FUNCTION pactwoven.native_delegation_root_recover(e text,limit_n integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE candidate record;r pactwoven.native_delegation_root_runs;t pactwoven.native_delegation_tasks;answer jsonb:='[]';old_generation bigint;action text;stranded boolean;BEGIN
 PERFORM pactwoven.native_delegation_service(e,ARRAY['dispatcher']);PERFORM pactwoven.native_memory_require(limit_n BETWEEN 1 AND 20,'ND004');
 FOR candidate IN SELECT run.organization_id,run.root_task_id,run.grant_id FROM pactwoven.native_delegation_root_runs run
  JOIN pactwoven.native_delegation_tasks task ON(task.environment,task.organization_id,task.id)=(run.environment,run.organization_id,run.root_task_id)
  JOIN pactwoven.native_delegation_grants g ON(g.environment,g.organization_id,g.id)=(run.environment,run.organization_id,run.grant_id)
  WHERE run.environment=e AND run.managed AND NOT run.manual_paused AND run.phase IN('ready','running','yielded','waiting_children')
   AND g.body->'revocation'='null'::jsonb AND pactwoven.supplier_time(g.body->'expiresAt')>clock_timestamp()
   AND(task.state='ready' OR(task.state='running' AND(task.lease_until<=clock_timestamp() OR task.lease_token IS NULL)))
   AND(run.phase<>'waiting_children' OR pactwoven.native_delegation_root_wait_ready(run) OR pactwoven.native_delegation_root_wait_stranded(run,clock_timestamp()))
   AND((task.lease_token IS NOT NULL AND task.lease_until<=clock_timestamp()) OR(run.phase='waiting_children' AND pactwoven.native_delegation_root_wait_stranded(run,clock_timestamp()))
    OR NOT EXISTS(SELECT 1 FROM pactwoven.native_delegation_outbox outbox
    WHERE(outbox.environment,outbox.organization_id,outbox.task_id,outbox.generation)=(task.environment,task.organization_id,task.id,task.generation)
     AND(outbox.state='pending' OR(outbox.state='publishing' AND outbox.lease_until>clock_timestamp()))))
  ORDER BY run.updated_at,run.organization_id COLLATE "C",run.root_task_id COLLATE "C" LIMIT limit_n LOOP
  BEGIN
   PERFORM pactwoven.native_delegation_grant_locked(e,candidate.organization_id,candidate.grant_id);
   SELECT * INTO r FROM pactwoven.native_delegation_root_runs WHERE(environment,organization_id,root_task_id)=(e,candidate.organization_id,candidate.root_task_id) FOR UPDATE;
   SELECT * INTO t FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(e,candidate.organization_id,candidate.root_task_id) FOR UPDATE;
   IF r.manual_paused OR r.phase NOT IN('ready','running','yielded','waiting_children') OR t.state NOT IN('ready','running') THEN CONTINUE;END IF;
   IF t.state='running' AND t.lease_token IS NOT NULL AND t.lease_until>clock_timestamp() THEN CONTINUE;END IF;
   stranded:=r.phase='waiting_children' AND pactwoven.native_delegation_root_wait_stranded(r,clock_timestamp());
   IF r.phase='waiting_children' AND NOT pactwoven.native_delegation_root_wait_ready(r) AND NOT stranded THEN CONTINUE;END IF;
   old_generation:=t.generation;
   IF NOT stranded AND(t.state='ready' OR(t.lease_token IS NULL AND r.phase IN('yielded','waiting_children'))) THEN
    IF EXISTS(SELECT 1 FROM pactwoven.native_delegation_outbox WHERE(environment,organization_id,task_id,generation)=(e,t.organization_id,t.id,t.generation)
     AND(state='pending' OR(state='publishing' AND lease_until>clock_timestamp()))) THEN CONTINUE;END IF;
    PERFORM pactwoven.native_delegation_root_wake(e,t.organization_id,t.id,t.generation);
    UPDATE pactwoven.native_delegation_outbox SET state='pending',token=NULL,lease_until=NULL WHERE(environment,organization_id,task_id,generation)=(e,t.organization_id,t.id,t.generation);
    action:='redelivered';
   ELSE
    IF t.attempt>=t.attempt_limit OR r.slice_count>=256 THEN
     UPDATE pactwoven.native_delegation_root_runs SET phase='blocked',reason=CASE WHEN r.slice_count>=256 THEN 'continuation_limit' ELSE 'attempts_exhausted' END,updated_at=clock_timestamp(),control_version=control_version+1
      WHERE(environment,organization_id,root_task_id)=(e,t.organization_id,t.id);
     PERFORM pactwoven.native_delegation_root_fence(r,'crash','paused');
     -- The terminal block reason takes precedence over the generic pause hook.
     UPDATE pactwoven.native_delegation_root_runs SET phase='blocked',reason=CASE WHEN r.slice_count>=256 THEN 'continuation_limit' ELSE 'attempts_exhausted' END WHERE(environment,organization_id,root_task_id)=(e,t.organization_id,t.id);action:='blocked';
    ELSE
     PERFORM pactwoven.native_delegation_root_fence(r,'crash','ready');
     UPDATE pactwoven.native_delegation_tasks SET attempt=attempt+1 WHERE(environment,organization_id,id)=(e,t.organization_id,t.id);
     UPDATE pactwoven.native_delegation_root_runs SET phase='ready',reason='reconciliation',restart_required=false,wait_for='{}',control_version=control_version+1,updated_at=clock_timestamp()
      WHERE(environment,organization_id,root_task_id)=(e,t.organization_id,t.id);action:='recovered';
    END IF;
    SELECT * INTO t FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(e,t.organization_id,t.id);
    INSERT INTO pactwoven.native_delegation_root_recoveries VALUES(e,t.organization_id,t.id,t.generation,old_generation,t.attempt,action,clock_timestamp());
    IF action='recovered' THEN PERFORM pactwoven.native_delegation_root_wake(e,t.organization_id,t.id,t.generation);END IF;
   END IF;
   UPDATE pactwoven.native_delegation_root_runs SET updated_at=clock_timestamp() WHERE(environment,organization_id,root_task_id)=(e,t.organization_id,t.id);
   answer:=answer||jsonb_build_array(jsonb_build_object('rootTaskId',t.id,'generation',t.generation,'action',action,'attempt',t.attempt));
  EXCEPTION WHEN SQLSTATE 'ND001' THEN CONTINUE;
  END;
 END LOOP;RETURN answer;
END $$;
CREATE FUNCTION pactwoven.native_delegation_root_route(e text,selector jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE t pactwoven.native_delegation_tasks;r pactwoven.native_delegation_root_runs;BEGIN
 PERFORM pactwoven.native_delegation_service(e,ARRAY['dispatcher']);PERFORM pactwoven.native_delegation_target(selector,false);
 SELECT * INTO t FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id,generation)=(e,selector->>'organizationId',selector->>'taskId',(selector->>'generation')::bigint);
 IF NOT FOUND OR t.state NOT IN('ready','running') THEN RETURN NULL;END IF;
 SELECT * INTO r FROM pactwoven.native_delegation_root_runs WHERE(environment,organization_id,root_task_id)=(e,t.organization_id,t.root_task_id);
 IF r.root_task_id IS NULL OR NOT r.managed OR r.manual_paused OR r.phase IN('paused','cancelled','completed','blocked')
  OR(t.depth=0 AND r.phase='waiting_children' AND NOT pactwoven.native_delegation_root_wait_ready(r))
  OR(t.depth>0 AND NOT EXISTS(SELECT 1 FROM pactwoven.native_delegation_root_assignments WHERE(environment,organization_id,task_id,generation,assignment_version)=(e,t.organization_id,t.id,t.generation,t.assignment_version))) THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('kind',CASE WHEN t.depth=0 THEN 'root' ELSE 'specialist' END,'identity',t.identity);
END $$;
CREATE FUNCTION pactwoven.native_delegation_root_run_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 PERFORM pactwoven.native_memory_require((NEW.environment,NEW.organization_id,NEW.root_task_id,NEW.grant_id,NEW.site_id,NEW.actor_id,NEW.title,NEW.prompt)=
  (OLD.environment,OLD.organization_id,OLD.root_task_id,OLD.grant_id,OLD.site_id,OLD.actor_id,OLD.title,OLD.prompt)
  AND NEW.control_version>=OLD.control_version AND NEW.checkpoint_version>=OLD.checkpoint_version AND NEW.slice_count>=OLD.slice_count
  AND(NOT OLD.managed OR NEW.managed),'ND009');
 IF NOT OLD.managed AND NEW.managed THEN PERFORM pactwoven.native_memory_require(EXISTS(SELECT 1 FROM pactwoven.native_delegation_root_note_selections
  WHERE(environment,organization_id,root_task_id)=(NEW.environment,NEW.organization_id,NEW.root_task_id)),'ND009');END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER native_root_run_guard BEFORE UPDATE ON pactwoven.native_delegation_root_runs FOR EACH ROW EXECUTE FUNCTION pactwoven.native_delegation_root_run_guard();
DO $$ DECLARE relation record;routine record;BEGIN
 FOR relation IN SELECT c.oid::regclass AS name,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='pactwoven' AND c.relkind='r' AND c.relname LIKE 'native_delegation_root_%' LOOP
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY',relation.name);
  EXECUTE format('REVOKE ALL ON TABLE %s FROM PUBLIC,pactwoven_runtime,pactwoven_native_task_api,pactwoven_native_task_worker,pactwoven_native_task_dispatcher,pactwoven_native_delegation_api,pactwoven_native_delegation_coordinator,pactwoven_native_delegation_worker,pactwoven_native_delegation_dispatcher',relation.name);
  EXECUTE format('CREATE TRIGGER native_root_retain_rows BEFORE DELETE ON %s FOR EACH ROW EXECUTE FUNCTION pactwoven.financial_immutable()',relation.name);
  EXECUTE format('CREATE TRIGGER native_root_retain_table BEFORE TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION pactwoven.financial_immutable()',relation.name);
  IF relation.relname<>'native_delegation_root_runs' THEN EXECUTE format('CREATE TRIGGER native_root_immutable BEFORE UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION pactwoven.financial_immutable()',relation.name);END IF;
 END LOOP;
 FOR routine IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='pactwoven' AND p.proname LIKE 'native_delegation_root_%' LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,pactwoven_runtime,pactwoven_native_task_api,pactwoven_native_task_worker,pactwoven_native_task_dispatcher,pactwoven_native_delegation_api,pactwoven_native_delegation_coordinator,pactwoven_native_delegation_worker,pactwoven_native_delegation_dispatcher',routine.signature);
 END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION pactwoven.native_delegation_root_read(jsonb,text),pactwoven.native_delegation_root_control(jsonb,text,jsonb),
 pactwoven.native_delegation_root_control_recover(jsonb,text,text),pactwoven.native_delegation_root_bind_notes(jsonb,text,jsonb) TO pactwoven_native_delegation_api;
GRANT EXECUTE ON FUNCTION pactwoven.native_delegation_root_claim(text,jsonb,integer),pactwoven.native_delegation_root_work(text,jsonb),
 pactwoven.native_delegation_root_checkpoint(text,jsonb,jsonb),pactwoven.native_delegation_root_yield(text,jsonb,jsonb),pactwoven.native_delegation_root_inputs(text,jsonb,jsonb),
 pactwoven.native_delegation_root_complete(text,jsonb,jsonb),pactwoven.native_delegation_root_handoff(text,jsonb,jsonb) TO pactwoven_native_delegation_coordinator;
GRANT EXECUTE ON FUNCTION pactwoven.native_delegation_root_materials(text,jsonb) TO pactwoven_native_delegation_coordinator,pactwoven_native_delegation_worker;
GRANT EXECUTE ON FUNCTION pactwoven.native_delegation_root_recover(text,integer),pactwoven.native_delegation_root_route(text,jsonb) TO pactwoven_native_delegation_dispatcher;
COMMIT;
