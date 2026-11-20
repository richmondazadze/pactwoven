BEGIN;

-- Private configuration readers only; no new tables, principals, authority, funds or provider effects.
CREATE FUNCTION pactwoven.financial_policy_reader_schema(k text) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT CASE k
WHEN 'observation' THEN $schema${"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{"identity":{"type":"object","properties":{"subject":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"externalOrganizationId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"externalOrganizationName":{"type":"string","minLength":1,"maxLength":180},"externalMembershipId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"externalRole":{"type":"string","minLength":1,"maxLength":128},"membershipObservedAt":{"type":"string","pattern":"^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$"},"sessionId":{"type":"string","minLength":1,"maxLength":256},"authenticatedAt":{"type":"string","pattern":"^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$"}},"required":["subject","externalOrganizationId","externalOrganizationName","externalMembershipId","externalRole","membershipObservedAt","sessionId","authenticatedAt"],"additionalProperties":false},"observation":{"type":"object","properties":{"issuer":{"type":"string","maxLength":512,"format":"uri"},"tokenHash":{"type":"string","pattern":"^[a-f0-9]{64}$"},"tokenIssuedAt":{"type":"string","pattern":"^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$"},"observedAt":{"type":"string","pattern":"^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$"},"expiresAt":{"type":"string","pattern":"^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$"}},"required":["issuer","tokenHash","tokenIssuedAt","observedAt","expiresAt"],"additionalProperties":false}},"required":["identity","observation"],"additionalProperties":false}$schema$::jsonb
WHEN 'scope' THEN $schema${"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{"environment":{"type":"string","enum":["simulation","development","staging","production"]},"organizationId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"externalOrganizationId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"actor":{"type":"object","properties":{"actorId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"membershipVersion":{"type":"integer","minimum":1,"maximum":2147483647},"subject":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"externalMembershipId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"sessionId":{"type":"string","minLength":1,"maxLength":256}},"required":["actorId","membershipVersion","subject","externalMembershipId","sessionId"],"additionalProperties":false},"organizationEpoch":{"type":"integer","minimum":0,"maximum":2147483647},"roles":{"minItems":1,"maxItems":9,"type":"array","items":{"type":"string","enum":["owner","operations","finance","receiver","supplier_admin","supplier_dispatcher","auditor","support","service"]}},"siteIds":{"maxItems":100,"type":"array","items":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"}},"actionSiteIds":{"maxItems":100,"type":"array","items":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"}}},"required":["environment","organizationId","externalOrganizationId","actor","organizationEpoch","roles","siteIds","actionSiteIds"],"additionalProperties":false}$schema$::jsonb
WHEN 'context' THEN $schema${"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{"responsibilityId":{"anyOf":[{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},{"type":"null"}]},"assetKey":{"anyOf":[{"type":"string","pattern":"^[a-f0-9]{64}$"},{"type":"null"}]},"documents":{"maxItems":8,"type":"array","items":{"type":"object","properties":{"id":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"version":{"type":"integer","minimum":1,"maximum":2147483647},"recordHash":{"type":"string","pattern":"^[a-f0-9]{64}$"},"purpose":{"type":"string","enum":["financial_mandate","budget_policy","approval_policy"]}},"required":["id","version","recordHash","purpose"],"additionalProperties":false}}},"required":["responsibilityId","assetKey","documents"],"additionalProperties":false}$schema$::jsonb
WHEN 'index' THEN $schema${"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{"afterId":{"anyOf":[{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},{"type":"null"}]},"limit":{"type":"integer","minimum":1,"maximum":50}},"required":["afterId","limit"],"additionalProperties":false}$schema$::jsonb
WHEN 'original' THEN $schema${"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{"responsibilityId":{"anyOf":[{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},{"type":"null"}]},"kind":{"type":"string","enum":["save_document","save_draft","withdraw_draft","propose_governance","accept_governance","reject_governance"]},"key":{"type":"string","minLength":16,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"targetId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"}},"required":["responsibilityId","kind","key","targetId"],"additionalProperties":false}$schema$::jsonb
WHEN 'reference' THEN $schema${"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{"id":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"version":{"type":"integer","minimum":1,"maximum":2147483647},"recordHash":{"type":"string","pattern":"^[a-f0-9]{64}$"}},"required":["id","version","recordHash"],"additionalProperties":false}$schema$::jsonb
ELSE NULL END $$;

CREATE OR REPLACE FUNCTION pactwoven.financial_policy_role_safe(who oid,cap text) RETURNS boolean LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$
 WITH RECURSIVE reachable(oid) AS(SELECT who UNION SELECT m.roleid FROM pg_auth_members m JOIN reachable x ON x.oid=m.member),
 expected AS(SELECT to_regprocedure(name) AS oid FROM unnest(CASE cap WHEN 'verifier' THEN ARRAY['pactwoven.financial_policy_attest(jsonb)','pactwoven.financial_policy_resolve_observer(text,jsonb)']
  WHEN 'authorizer' THEN ARRAY['pactwoven.financial_policy_command(uuid,jsonb)','pactwoven.financial_policy_read(uuid,jsonb)','pactwoven.financial_policy_list(uuid,jsonb)','pactwoven.financial_policy_recover(uuid,jsonb)','pactwoven.financial_policy_read_context(uuid,jsonb,jsonb)','pactwoven.financial_policy_governance_index(uuid,jsonb,jsonb)','pactwoven.financial_policy_original_read(uuid,jsonb,jsonb)','pactwoven.financial_policy_proposer_observation(uuid,jsonb,jsonb)'] ELSE ARRAY[]::text[] END) name),
 relations AS(SELECT c.* FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='pactwoven' AND c.relkind IN('r','p','v','m','f','S')),
 routines AS(SELECT p.* FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='pactwoven' OR(p.prosecdef AND n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema'))
 SELECT cap IN('authorizer','verifier') AND coalesce(pactwoven.custody_system_privileges_safe(who),false)
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

-- Historical validation retains exact stored commands and proofs without renewing them.
CREATE FUNCTION pactwoven.financial_policy_original_checked(opid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE oid uuid:=opid;op pactwoven.financial_policy_operations%ROWTYPE;r pactwoven.financial_policy_records%ROWTYPE;prior jsonb;v jsonb;expected_kind text;ctrl record;before_ctrl jsonb;ev jsonb;
BEGIN
 SELECT * INTO op FROM pactwoven.financial_policy_operations WHERE id=oid;
 SELECT * INTO r FROM pactwoven.financial_policy_records WHERE operation_id=oid;
 v:=op.command;expected_kind:=CASE op.kind WHEN 'save_document' THEN 'document' WHEN 'save_draft' THEN 'draft' WHEN 'withdraw_draft' THEN 'draft'
  WHEN 'propose_governance' THEN 'governance' WHEN 'accept_governance' THEN 'governance' WHEN 'reject_governance' THEN 'governance' END;
 IF op.id IS NULL OR r.id IS NULL OR expected_kind IS NULL OR r.kind<>expected_kind OR r.environment<>op.environment OR r.organization_id<>op.organization_id
  OR r.responsibility_id IS DISTINCT FROM op.responsibility_id OR r.body#>>'{actor,actorId}'<>op.actor_id OR r.body->>'operationId'<>oid::text
  OR op.command_hash IS DISTINCT FROM pactwoven.financial_policy_command_hash(op.actor_id,v) OR v->>'kind' IS DISTINCT FROM op.kind OR v->>'key' IS DISTINCT FROM op.key
  OR v->>'environment' IS DISTINCT FROM op.environment OR v->>'organizationId' IS DISTINCT FROM op.organization_id OR v->>'responsibilityId' IS DISTINCT FROM op.responsibility_id
  OR v->>'id' IS DISTINCT FROM r.id OR v->'previous' IS DISTINCT FROM r.body->'predecessor' OR v->'organizationEpoch' IS DISTINCT FROM r.body->'organizationEpoch'
  OR op.result IS DISTINCT FROM jsonb_build_object('schemaVersion',1,'id',op.id,'environment',op.environment,'organizationId',op.organization_id,'actorId',op.actor_id,'responsibilityId',op.responsibility_id,
   'kind',op.kind,'key',op.key,'commandHash',op.command_hash,'target',pactwoven.financial_policy_ref(r.body),'body',r.body,'financialState',NULL,'effectiveAuthority',false)
  OR NOT EXISTS(SELECT 1 FROM pactwoven.financial_policy_audit WHERE operation_id=oid AND body=op.result-'body')
  OR NOT EXISTS(SELECT 1 FROM pactwoven.financial_policy_outbox WHERE operation_id=oid AND body=op.result-'body') THEN RAISE EXCEPTION USING ERRCODE='FP008',MESSAGE='Exact reciprocal policy record operation audit and outbox required';END IF;
 IF NOT coalesce(pactwoven.financial_policy_valid('command',v),false) OR NOT coalesce(pactwoven.financial_policy_valid('record',r.body),false)
 THEN RAISE EXCEPTION USING ERRCODE='FP008',MESSAGE='Exact valid original policy command and record required';END IF;
 SELECT body INTO ev FROM pactwoven.financial_policy_evidence WHERE id=(r.body#>>'{identityEvidence,id}')::uuid;
 IF ev IS NULL OR ev->>'kind'<>'identity' OR ev->>'environment'<>r.environment OR ev->>'organizationId'<>r.organization_id OR ev->'actor' IS DISTINCT FROM r.body->'actor'
  OR r.body->'identityEvidence' IS DISTINCT FROM jsonb_build_object('id',ev->'id','version',1,'recordHash',pactwoven.financial_policy_hash('evidence',ev))
 THEN RAISE EXCEPTION USING ERRCODE='FP008',MESSAGE='Exact original policy identity observation required';END IF;
 IF r.version>1 THEN SELECT body INTO prior FROM pactwoven.financial_policy_records WHERE environment=r.environment AND organization_id=r.organization_id AND id=r.id AND version=r.version-1;
  IF prior IS NULL OR pactwoven.financial_policy_ref(prior) IS DISTINCT FROM r.body->'predecessor' THEN RAISE EXCEPTION USING ERRCODE='FP008',MESSAGE='Exact intermediate policy history required';END IF;
 END IF;
 IF op.kind='save_document' THEN
  IF r.body->'text' IS DISTINCT FROM v->'text' OR r.body->'purpose' IS DISTINCT FROM v->'purpose' THEN RAISE EXCEPTION USING ERRCODE='FP008',MESSAGE='Exact policy document command required';END IF;
 ELSIF op.kind='save_draft' THEN
  IF r.body->'draft' IS DISTINCT FROM v->'draft' OR r.body->>'state'<>'DRAFT' OR r.body->'requester' IS DISTINCT FROM r.body->'actor' THEN RAISE EXCEPTION USING ERRCODE='FP008',MESSAGE='Exact policy draft command required';END IF;
 ELSIF op.kind='withdraw_draft' THEN
  IF prior IS NULL OR r.body->>'state'<>'WITHDRAWN' OR r.body->'draft' IS DISTINCT FROM prior->'draft' OR r.body->'requester' IS DISTINCT FROM prior->'requester' THEN RAISE EXCEPTION USING ERRCODE='FP008',MESSAGE='Exact withdrawn draft required';END IF;
 ELSIF op.kind='propose_governance' THEN
  IF r.body->'bundle' IS DISTINCT FROM v->'bundle' OR r.body->'expectedControl' IS DISTINCT FROM v->'expectedControl' OR r.body->'expiresAt' IS DISTINCT FROM v->'expiresAt'
   OR r.body->>'state'<>'OPEN' OR r.body->'proposer' IS DISTINCT FROM r.body->'actor' THEN RAISE EXCEPTION USING ERRCODE='FP008',MESSAGE='Exact governance proposal command required';END IF;
  IF NOT EXISTS(SELECT 1 FROM pactwoven.financial_budget_accounts WHERE id=r.body#>>'{bundle,budgetAccountId}' AND environment=r.environment AND organization_id=r.organization_id AND asset_key=r.body#>>'{bundle,asset,key}')
   OR NOT EXISTS(SELECT 1 FROM pactwoven.financial_budget_periods WHERE id=r.body#>>'{bundle,period,id}' AND budget_account_id=r.body#>>'{bundle,budgetAccountId}'
    AND starts_at=(r.body#>>'{bundle,period,startsAt}')::timestamptz AND ends_at=(r.body#>>'{bundle,period,endsAt}')::timestamptz) THEN RAISE EXCEPTION USING ERRCODE='FP008',MESSAGE='Stable budget and fixed period required';END IF;
 ELSE
  IF prior IS NULL OR r.body->>'state'<>(CASE op.kind WHEN 'accept_governance' THEN 'ACCEPTED' ELSE 'REJECTED' END)
   OR r.body->'expectedControl' IS DISTINCT FROM v->'expectedControl' OR r.body#>>'{decision,proposerObservation,id}' IS DISTINCT FROM v->>'proposerEvidenceId'
  THEN RAISE EXCEPTION USING ERRCODE='FP008',MESSAGE='Exact governance decision command required';END IF;
  SELECT body INTO ev FROM pactwoven.financial_policy_evidence WHERE id=(v->>'proposerEvidenceId')::uuid;
  IF ev IS NULL OR ev->'actor' IS DISTINCT FROM r.body->'proposer' OR r.body#>'{decision,proposerObservation}' IS DISTINCT FROM jsonb_build_object('id',ev->'id','version',1,'recordHash',pactwoven.financial_policy_hash('evidence',ev)) THEN RAISE EXCEPTION USING ERRCODE='FP008',MESSAGE='Exact proposer observation required';END IF;
  SELECT body INTO ev FROM pactwoven.financial_policy_evidence WHERE id=(r.body#>>'{decision,approverObservation,id}')::uuid;
  IF ev IS NULL OR ev->'actor' IS DISTINCT FROM r.body->'actor' OR r.body#>'{decision,approverObservation}' IS DISTINCT FROM jsonb_build_object('id',ev->'id','version',1,'recordHash',pactwoven.financial_policy_hash('evidence',ev)) THEN RAISE EXCEPTION USING ERRCODE='FP008',MESSAGE='Exact approver observation required';END IF;
 END IF;
 IF op.kind='accept_governance' THEN
  SELECT * INTO ctrl FROM pactwoven.financial_governance_controls WHERE operation_id=oid;
  IF ctrl.operation_id IS NULL OR ctrl.budget_account_id<>r.body#>>'{bundle,budgetAccountId}' OR ctrl.environment<>r.environment OR ctrl.organization_id<>r.organization_id
   OR ctrl.record_id<>r.id OR ctrl.record_version<>r.version OR ctrl.record_hash<>r.hash OR v->>'nonce' IS DISTINCT FROM r.body->>'decisionNonce'
  THEN RAISE EXCEPTION USING ERRCODE='FP008',MESSAGE='Exact consent configuration history required';END IF;
  SELECT jsonb_build_object('budgetAccountId',budget_account_id,'generation',generation,'accepted',jsonb_build_object('id',record_id,'version',record_version,'recordHash',record_hash)) INTO before_ctrl
   FROM pactwoven.financial_governance_controls WHERE budget_account_id=ctrl.budget_account_id AND generation=ctrl.generation-1;
  IF ctrl.generation=1 THEN before_ctrl:=jsonb_build_object('budgetAccountId',ctrl.budget_account_id,'generation',0,'accepted',NULL);END IF;
  IF before_ctrl IS NULL OR before_ctrl IS DISTINCT FROM r.body->'expectedControl' THEN RAISE EXCEPTION USING ERRCODE='FP008',MESSAGE='Exact prior governance configuration required';END IF;
  SELECT body INTO ev FROM pactwoven.financial_policy_evidence WHERE id=(v->>'mfaEvidenceId')::uuid;
  IF ev IS NULL OR ev->>'kind'<>'mfa' OR ev->'intent' IS DISTINCT FROM pactwoven.financial_policy_intent(prior,r.body->'actor',op.key,(r.body->>'organizationEpoch')::int)
   OR r.body#>'{decision,mfaEvidence}' IS DISTINCT FROM jsonb_build_object('id',ev->'id','version',1,'recordHash',pactwoven.financial_policy_hash('evidence',ev))
   OR r.body#>'{decision,intentHash}' IS DISTINCT FROM ev->'intentHash' OR r.body#>'{decision,requestHash}' IS DISTINCT FROM ev->'requestHash'
   OR NOT EXISTS(SELECT 1 FROM pactwoven.financial_policy_evidence_uses WHERE operation_id=oid AND evidence_id=(ev->>'id')::uuid)
  THEN RAISE EXCEPTION USING ERRCODE='FP008',MESSAGE='Exact consumed policy MFA required';END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM pactwoven.financial_governance_controls WHERE operation_id=oid) OR EXISTS(SELECT 1 FROM pactwoven.financial_policy_evidence_uses WHERE operation_id=oid) THEN RAISE EXCEPTION USING ERRCODE='FP008',MESSAGE='Only independent governance acceptance records configuration consent';END IF;
 END IF;
 RETURN jsonb_build_object('command',op.command,'result',op.result);
END $$;
CREATE FUNCTION pactwoven.financial_policy_reader_require(k text,v jsonb) RETURNS void LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
BEGIN IF NOT coalesce(pactwoven.financial_policy_matches(v,pactwoven.financial_policy_reader_schema(k)),false) THEN RAISE EXCEPTION USING ERRCODE='FP004',MESSAGE='Strict private policy reader input required';END IF;END $$;
CREATE FUNCTION pactwoven.financial_policy_reader_observation(v jsonb) RETURNS void LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog AS $$
DECLARE at_time timestamptz:=clock_timestamp();observed timestamptz;issued timestamptz;expires timestamptz;BEGIN
 PERFORM pactwoven.financial_policy_reader_require('observation',v);
 observed:=least((v#>>'{observation,observedAt}')::timestamptz,(v#>>'{identity,membershipObservedAt}')::timestamptz);
 issued:=(v#>>'{observation,tokenIssuedAt}')::timestamptz;expires:=(v#>>'{observation,expiresAt}')::timestamptz;
 IF(v#>>'{observation,observedAt}')::timestamptz>at_time OR(v#>>'{identity,membershipObservedAt}')::timestamptz>at_time
  OR(v#>>'{identity,authenticatedAt}')::timestamptz>at_time OR observed<at_time-interval '20 seconds' OR issued>observed OR expires<=at_time
 THEN RAISE EXCEPTION USING ERRCODE='FP001',MESSAGE='Current nonfuture verified observation required';END IF;
END $$;
CREATE FUNCTION pactwoven.financial_policy_reader_scope(v jsonb) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('environment',o.environment,'organizationId',o.id,'externalOrganizationId',o.external_organization_id,'actor',v->'actor','organizationEpoch',o.authority_epoch,
 'roles',(SELECT jsonb_agg(role ORDER BY role COLLATE "C") FROM unnest(m.roles) role),
 'siteIds',(SELECT coalesce(jsonb_agg(site_id ORDER BY site_id COLLATE "C"),'[]') FROM pactwoven.site_memberships WHERE environment=o.environment AND organization_id=o.id AND actor_id=m.actor_id),
 'actionSiteIds',(SELECT coalesce(jsonb_agg(site_id ORDER BY site_id COLLATE "C"),'[]') FROM pactwoven.member_action_sites WHERE environment=o.environment AND organization_id=o.id AND actor_id=m.actor_id))
 FROM pactwoven.organizations o JOIN pactwoven.memberships m ON m.environment=o.environment AND m.organization_id=o.id
 WHERE o.environment=v->>'environment' AND o.id=v->>'organizationId' AND m.actor_id=v#>>'{actor,actorId}'
$$;
CREATE FUNCTION pactwoven.financial_policy_resolve_observer(e text,v jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='3s' AS $$
DECLARE o pactwoven.organizations%ROWTYPE;m pactwoven.memberships%ROWTYPE;a jsonb;s jsonb;BEGIN
 PERFORM pactwoven.financial_require_read_committed();PERFORM pactwoven.financial_policy_reader_observation(v);
 IF e NOT IN('simulation','development','staging','production') OR e IS NULL THEN RAISE EXCEPTION USING ERRCODE='FP004',MESSAGE='Exact environment required';END IF;
 SELECT * INTO o FROM pactwoven.organizations WHERE environment=e AND external_organization_id=v#>>'{identity,externalOrganizationId}' FOR UPDATE;
 IF o.id IS NULL THEN RAISE EXCEPTION USING ERRCODE='FP001',MESSAGE='Current policy organization required';END IF;
 PERFORM pactwoven.financial_policy_principal(e,o.id,'verifier');LOCK TABLE pactwoven.session_revocations IN SHARE MODE;
 PERFORM actor_id FROM pactwoven.memberships WHERE environment=e AND organization_id=o.id ORDER BY actor_id COLLATE "C" FOR SHARE;
 SELECT * INTO m FROM pactwoven.memberships WHERE environment=e AND organization_id=o.id AND external_subject=v#>>'{identity,subject}' AND external_membership_id=v#>>'{identity,externalMembershipId}';
 PERFORM id FROM pactwoven.sites WHERE environment=e AND organization_id=o.id ORDER BY id COLLATE "C" FOR SHARE;
 a:=jsonb_build_object('actorId',m.actor_id,'membershipVersion',m.row_version,'subject',m.external_subject,'externalMembershipId',m.external_membership_id,'sessionId',v#>>'{identity,sessionId}');
 s:=jsonb_build_object('environment',e,'organizationId',o.id,'actor',a,'externalOrganizationId',o.external_organization_id,'externalRole',v#>>'{identity,externalRole}',
  'observedAt',pactwoven.mandate_instant(least((v#>>'{observation,observedAt}')::timestamptz,(v#>>'{identity,membershipObservedAt}')::timestamptz)),
  'expiresAt',pactwoven.mandate_instant(least((v#>>'{observation,expiresAt}')::timestamptz,least((v#>>'{observation,observedAt}')::timestamptz,(v#>>'{identity,membershipObservedAt}')::timestamptz)+interval '5 minutes')),
  'sessionExpiresAt',v#>>'{observation,expiresAt}','tokenIssuedAt',v#>>'{observation,tokenIssuedAt}');
 PERFORM pactwoven.financial_policy_reader_observation(v);
 IF NOT pactwoven.financial_policy_actor_current(s) THEN RAISE EXCEPTION USING ERRCODE='FP001',MESSAGE='Current local policy actor required';END IF;
 PERFORM pactwoven.financial_policy_principal(e,o.id,'verifier');s:=pactwoven.financial_policy_reader_scope(s);PERFORM pactwoven.financial_policy_reader_require('scope',s);RETURN s;
END $$;
CREATE FUNCTION pactwoven.financial_policy_reader_context(eid uuid,s jsonb,rid text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c jsonb;BEGIN PERFORM pactwoven.financial_policy_reader_require('scope',s);
 c:=pactwoven.financial_policy_context(eid,s->>'environment',s->>'organizationId',rid,'authorizer');
 IF s IS DISTINCT FROM pactwoven.financial_policy_reader_scope(c->'identity') THEN RAISE EXCEPTION USING ERRCODE='FP001',MESSAGE='Current exact reader actor and scope required';END IF;RETURN c;END $$;
CREATE FUNCTION pactwoven.financial_policy_reader_finish(c jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN PERFORM pactwoven.financial_policy_principal(c#>>'{identity,environment}',c#>>'{identity,organizationId}','authorizer');
 IF NOT pactwoven.financial_policy_actor_current(c->'identity') OR NOT pactwoven.financial_policy_evidence_current((c#>>'{identity,id}')::uuid) THEN RAISE EXCEPTION USING ERRCODE='FP001',MESSAGE='Policy reader observation expired while waiting';END IF;
END $$;
CREATE FUNCTION pactwoven.financial_policy_reader_control(e text,o text,a text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE control jsonb;v jsonb;op uuid;BEGIN
 control:=pactwoven.financial_policy_control(a);
 IF(control->>'generation')::int>0 THEN
  SELECT r.body,r.operation_id INTO v,op FROM pactwoven.financial_policy_records r JOIN pactwoven.financial_budget_accounts b ON b.id=a AND b.environment=e AND b.organization_id=o
   WHERE r.environment=e AND r.organization_id=o AND r.id=control#>>'{accepted,id}' AND r.version=(control#>>'{accepted,version}')::int;
  IF v IS NULL OR v->>'state'<>'ACCEPTED' OR v->>'kind'<>'governance' OR v#>>'{bundle,budgetAccountId}'<>a OR pactwoven.financial_policy_ref(v) IS DISTINCT FROM control->'accepted' THEN RAISE EXCEPTION USING ERRCODE='FP008',MESSAGE='Original configuration control is not reciprocal';END IF;
  PERFORM pactwoven.financial_policy_original_checked(op);
 END IF;RETURN control;
END $$;
CREATE FUNCTION pactwoven.financial_policy_read_context(eid uuid,s jsonb,q jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='3s' AS $$
DECLARE c jsonb;rid text;ds jsonb;asset jsonb;control jsonb;accepted jsonb;periods jsonb:='[]';documents jsonb:='[]';blockers jsonb:='["TRUST_UNAVAILABLE","FINANCIAL_AUTHORITY_UNAVAILABLE"]';
 x jsonb;v jsonb;previous_id text;account_id text;full_configuration boolean;f pactwoven.financial_authority_fences%ROWTYPE;site pactwoven.financial_site_fences%ROWTYPE;at_time timestamptz;BEGIN
 PERFORM pactwoven.financial_policy_reader_require('context',q);rid:=q->>'responsibilityId';c:=pactwoven.financial_policy_reader_context(eid,s,rid);
 full_configuration:=c->'roles' ?| ARRAY['owner','finance'];
 IF rid IS NULL AND NOT full_configuration THEN RAISE EXCEPTION USING ERRCODE='FP001',MESSAGE='Governance reviewer scope required';END IF;
 IF rid IS NOT NULL THEN
  SELECT * INTO f FROM pactwoven.financial_authority_fences WHERE environment=s->>'environment' AND organization_id=s->>'organizationId' AND responsibility_id=rid;
  SELECT * INTO site FROM pactwoven.financial_site_fences WHERE environment=s->>'environment' AND organization_id=s->>'organizationId' AND site_id=c#>>'{responsibility,siteId}';
  IF f.responsibility_id IS NULL OR site.site_id IS NULL THEN RAISE EXCEPTION USING ERRCODE='FP002',MESSAGE='Exact draft basis unavailable';END IF;
  ds:=jsonb_build_object('authority',pactwoven.financial_authority_snapshot(f),'authorityHash',pactwoven.financial_authority_fence_hash(f),'site',jsonb_build_object('id',site.site_id,'generation',site.generation,'recordHash',site.record_hash));
  IF NOT site.active THEN blockers:=blockers||'"SCOPE_CHANGED"'::jsonb;END IF;
 END IF;
 IF q->'assetKey'='null'::jsonb THEN blockers:=blockers||'"ASSET_MISSING"'::jsonb;
 ELSE
  PERFORM asset_key FROM pactwoven.finance_physical_assets WHERE asset_key=q->>'assetKey' FOR SHARE;
  PERFORM asset_key FROM pactwoven.finance_asset_controls WHERE asset_key=q->>'assetKey' FOR SHARE;
  PERFORM asset_key FROM pactwoven.financial_asset_fences WHERE asset_key=q->>'assetKey' FOR SHARE;
  SELECT jsonb_build_object('pin',jsonb_build_object('key',p.asset_key,'version',av.version,'recordHash',pactwoven.finance_hash(to_jsonb(av)),'financialUseEpoch',af.generation),
   'genesisHex',encode(p.genesis,'hex'),'tokenProgramHex',encode(p.token_program,'hex'),'mintHex',encode(p.mint,'hex'),'decimals',av.decimals,'policy',av.policy) INTO asset
  FROM pactwoven.finance_physical_assets p JOIN pactwoven.finance_asset_controls ac USING(asset_key) JOIN pactwoven.finance_asset_versions av ON av.asset_key=p.asset_key AND av.version=ac.current_version
  JOIN pactwoven.financial_asset_fences af ON af.asset_key=p.asset_key WHERE p.asset_key=q->>'assetKey' AND ac.accepts_observations AND ac.revoked_at IS NULL;
  IF asset IS NULL THEN blockers:=blockers||'"ASSET_CHANGED"'::jsonb;
  ELSE
   account_id:=pactwoven.financial_budget_account_id(s->>'environment',s->>'organizationId',q->>'assetKey');control:=pactwoven.financial_policy_reader_control(s->>'environment',s->>'organizationId',account_id);
   IF full_configuration AND control->'accepted'<>'null'::jsonb THEN SELECT pactwoven.financial_policy_projection(body) INTO accepted FROM pactwoven.financial_policy_records WHERE environment=s->>'environment' AND organization_id=s->>'organizationId' AND id=control#>>'{accepted,id}' AND version=(control#>>'{accepted,version}')::int;END IF;
   IF full_configuration THEN
   SELECT coalesce(jsonb_agg(p.v ORDER BY p.starts_at,p.id),'[]') INTO periods FROM(SELECT id,starts_at,jsonb_build_object('id',id,'startsAt',pactwoven.mandate_instant(starts_at),'endsAt',pactwoven.mandate_instant(ends_at)) v FROM pactwoven.financial_budget_periods WHERE budget_account_id=account_id ORDER BY starts_at,id LIMIT 51)p;
   IF jsonb_array_length(periods)>50 THEN RAISE EXCEPTION USING ERRCODE='FP006',MESSAGE='Budget period context exceeds bounded reader';END IF;END IF;
  END IF;
 END IF;
 IF control IS NULL OR control->'accepted'='null'::jsonb THEN blockers:=blockers||'"GOVERNANCE_MISSING"'::jsonb;END IF;
 FOR x IN SELECT * FROM jsonb_array_elements(q->'documents') LOOP
  IF x->>'purpose'<>'financial_mandate' AND NOT full_configuration THEN RAISE EXCEPTION USING ERRCODE='FP001',MESSAGE='Organization policy documents require governance reviewer scope';END IF;
  IF previous_id IS NOT NULL AND previous_id COLLATE "C">=(x->>'id') COLLATE "C" THEN RAISE EXCEPTION USING ERRCODE='FP004',MESSAGE='Sorted unique document references required';END IF;previous_id:=x->>'id';
  SELECT body INTO v FROM pactwoven.financial_policy_records WHERE environment=s->>'environment' AND organization_id=s->>'organizationId' AND id=x->>'id' AND version=(x->>'version')::int
   AND responsibility_id IS NOT DISTINCT FROM(CASE WHEN x->>'purpose'='financial_mandate' THEN rid ELSE NULL END);
  IF v IS NULL OR v->>'kind'<>'document' OR v->>'purpose'<>x->>'purpose' OR(x->>'purpose'='financial_mandate' AND rid IS NULL) OR pactwoven.financial_policy_ref(v) IS DISTINCT FROM(x-'purpose') THEN RAISE EXCEPTION USING ERRCODE='FP002',MESSAGE='Exact scoped document reference required';END IF;
  PERFORM pactwoven.financial_policy_original_checked((v->>'operationId')::uuid);v:=pactwoven.financial_policy_projection(v);documents:=documents||jsonb_build_array(v);
  IF NOT(v->>'current')::boolean THEN blockers:=blockers||'"DOCUMENT_CHANGED"'::jsonb;END IF;
 END LOOP;
 PERFORM pactwoven.financial_policy_reader_finish(c);at_time:=clock_timestamp();
 RETURN jsonb_build_object('scope',s,'responsibilityId',rid,'configurationVisibility',CASE WHEN full_configuration THEN 'full' ELSE 'references_only' END,'draftScope',ds,'asset',asset,'control',control,'acceptedConfiguration',accepted,'periods',periods,'documents',documents,'blockers',blockers,
 'observedAt',pactwoven.mandate_instant(at_time),'expiresAt',pactwoven.mandate_instant(least((c#>>'{identity,expiresAt}')::timestamptz,(c#>>'{identity,observedAt}')::timestamptz+interval '20 seconds')),'effectiveAuthority',false,'financialState',NULL);
END $$;
CREATE FUNCTION pactwoven.financial_policy_governance_index(eid uuid,s jsonb,q jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='3s' AS $$
DECLARE c jsonb;v jsonb;p jsonb;control jsonb;items jsonb:='[]';last_id text;more boolean:=false;BEGIN
 PERFORM pactwoven.financial_policy_reader_require('index',q);c:=pactwoven.financial_policy_reader_context(eid,s,NULL);
 IF NOT(c->'roles' ?| ARRAY['owner','finance']) THEN RAISE EXCEPTION USING ERRCODE='FP001',MESSAGE='Governance reviewer scope required';END IF;
 FOR v IN SELECT r.body FROM(SELECT DISTINCT ON(id) id,body FROM pactwoven.financial_policy_records WHERE environment=s->>'environment' AND organization_id=s->>'organizationId' AND responsibility_id IS NULL AND kind='governance' ORDER BY id,version DESC)r
  WHERE(q->'afterId'='null'::jsonb OR r.id COLLATE "C">(q->>'afterId') COLLATE "C") AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(r.body#>'{bundle,approval,actionSiteIds}') a(id)
   WHERE NOT EXISTS(SELECT 1 FROM pactwoven.site_memberships WHERE environment=s->>'environment' AND organization_id=s->>'organizationId' AND actor_id=s#>>'{actor,actorId}' AND site_id=a.id)
   OR NOT EXISTS(SELECT 1 FROM pactwoven.member_action_sites WHERE environment=s->>'environment' AND organization_id=s->>'organizationId' AND actor_id=s#>>'{actor,actorId}' AND site_id=a.id))
  ORDER BY r.id COLLATE "C" LIMIT(q->>'limit')::int+1 LOOP
  IF jsonb_array_length(items)=(q->>'limit')::int THEN more:=true;EXIT;END IF;
  PERFORM pactwoven.financial_policy_original_checked((v->>'operationId')::uuid);p:=pactwoven.financial_policy_projection(v);control:=pactwoven.financial_policy_reader_control(s->>'environment',s->>'organizationId',v#>>'{bundle,budgetAccountId}');
  items:=items||jsonb_build_array(jsonb_build_object('policy',p,'control',control,'currentBudgetConfiguration',control->'accepted'=p->'reference'));last_id:=v->>'id';
 END LOOP;
 PERFORM pactwoven.financial_policy_reader_finish(c);RETURN jsonb_build_object('items',items,'nextId',CASE WHEN more THEN last_id ELSE NULL END);
END $$;
CREATE FUNCTION pactwoven.financial_policy_original_read(eid uuid,s jsonb,q jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='3s' AS $$
DECLARE c jsonb;op uuid;v jsonb;BEGIN
 PERFORM pactwoven.financial_policy_reader_require('original',q);
 IF q->>'kind'<>'save_document' AND((q->'responsibilityId'<>'null'::jsonb)<>(q->>'kind' IN('save_draft','withdraw_draft'))) THEN RAISE EXCEPTION USING ERRCODE='FP004',MESSAGE='Exact operation scope required';END IF;
 c:=pactwoven.financial_policy_reader_context(eid,s,q->>'responsibilityId');
 IF q->'responsibilityId'='null'::jsonb AND NOT(c->'roles' ?| ARRAY['owner','finance']) THEN RAISE EXCEPTION USING ERRCODE='FP001',MESSAGE='Organization policy recovery requires governance reviewer scope';END IF;
 SELECT id INTO op FROM pactwoven.financial_policy_operations WHERE environment=s->>'environment' AND organization_id=s->>'organizationId' AND actor_id=s#>>'{actor,actorId}'
  AND responsibility_id IS NOT DISTINCT FROM(q->>'responsibilityId') AND kind=q->>'kind' AND key=q->>'key' AND command->>'id'=q->>'targetId';
 IF op IS NOT NULL THEN
  v:=pactwoven.financial_policy_original_checked(op);
  IF v#>>'{result,body,actor,subject}' IS DISTINCT FROM s#>>'{actor,subject}' OR v#>>'{result,body,actor,externalMembershipId}' IS DISTINCT FROM s#>>'{actor,externalMembershipId}' THEN RAISE EXCEPTION USING ERRCODE='FP001',MESSAGE='Original policy actor identity required';END IF;
  IF v#>>'{result,body,kind}'='governance' THEN
   IF NOT(c->'roles' ?| ARRAY['owner','finance']) THEN RAISE EXCEPTION USING ERRCODE='FP001',MESSAGE='Current governance reader required';END IF;
   PERFORM pactwoven.financial_policy_site_grants(s->>'environment',s->>'organizationId',s#>>'{actor,actorId}',v#>'{result,body,bundle,approval,actionSiteIds}',false);
  END IF;
 END IF;
 PERFORM pactwoven.financial_policy_reader_finish(c);RETURN v;
END $$;
CREATE FUNCTION pactwoven.financial_policy_proposer_observation(eid uuid,s jsonb,q jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='3s' AS $$
DECLARE c jsonb;p jsonb;control jsonb;v jsonb;result jsonb;BEGIN
 PERFORM pactwoven.financial_policy_reader_require('reference',q);c:=pactwoven.financial_policy_reader_context(eid,s,NULL);
 IF NOT(c->'roles' ?| ARRAY['owner','finance']) THEN RAISE EXCEPTION USING ERRCODE='FP001',MESSAGE='Current governance reader required';END IF;
 SELECT body INTO p FROM pactwoven.financial_policy_records WHERE environment=s->>'environment' AND organization_id=s->>'organizationId' AND id=q->>'id' ORDER BY version DESC LIMIT 1;
 IF p IS NULL OR p->>'kind'<>'governance' OR p->>'state'<>'OPEN' OR pactwoven.financial_policy_ref(p) IS DISTINCT FROM q THEN RAISE EXCEPTION USING ERRCODE='FP002',MESSAGE='Exact current open proposal required';END IF;
 PERFORM pactwoven.financial_policy_site_grants(s->>'environment',s->>'organizationId',s#>>'{actor,actorId}',p#>'{bundle,approval,actionSiteIds}',false);
 control:=pactwoven.financial_policy_reader_control(s->>'environment',s->>'organizationId',p#>>'{bundle,budgetAccountId}');
 IF p->'expectedControl' IS DISTINCT FROM control THEN RAISE EXCEPTION USING ERRCODE='FP002',MESSAGE='Proposal configuration was superseded';END IF;
 IF(p->>'expiresAt')::timestamptz<=clock_timestamp() THEN RAISE EXCEPTION USING ERRCODE='FP003',MESSAGE='Proposal expired';END IF;
 PERFORM pactwoven.financial_policy_original_checked((p->>'operationId')::uuid);
 PERFORM pactwoven.financial_policy_site_grants(s->>'environment',s->>'organizationId',p#>>'{proposer,actorId}',p#>'{bundle,approval,actionSiteIds}',false);
 SELECT body INTO v FROM pactwoven.financial_policy_evidence WHERE environment=s->>'environment' AND organization_id=s->>'organizationId' AND kind='identity' AND body->'actor'=p->'proposer'
  AND pactwoven.financial_policy_actor_current(body) AND pactwoven.financial_policy_evidence_current(id)
  AND EXISTS(SELECT 1 FROM pactwoven.memberships WHERE environment=s->>'environment' AND organization_id=s->>'organizationId' AND actor_id=p#>>'{proposer,actorId}' AND 'owner'=ANY(roles))
  ORDER BY(body->>'observedAt') COLLATE "C" DESC,id DESC LIMIT 1;
 PERFORM pactwoven.financial_policy_reader_finish(c);
 IF v IS NOT NULL THEN
  IF NOT pactwoven.financial_policy_actor_current(v) OR NOT pactwoven.financial_policy_evidence_current((v->>'id')::uuid) THEN RAISE EXCEPTION USING ERRCODE='FP001',MESSAGE='Proposer observation expired';END IF;
  result:=jsonb_build_object('proposal',q,'control',control,'observation',jsonb_build_object('id',v->'id','version',1,'recordHash',pactwoven.financial_policy_hash('evidence',v)),
   'observedAt',v->'observedAt','expiresAt',pactwoven.mandate_instant(least((v->>'expiresAt')::timestamptz,(v->>'observedAt')::timestamptz+interval '20 seconds',(p->>'expiresAt')::timestamptz)));
 END IF;RETURN result;
END $$;
DO $$ DECLARE routine regprocedure;BEGIN
 FOR routine IN SELECT oid::regprocedure FROM pg_proc WHERE pronamespace='pactwoven'::regnamespace AND(proname LIKE 'financial_policy_reader_%' OR proname IN('financial_policy_original_checked','financial_policy_resolve_observer','financial_policy_read_context','financial_policy_governance_index','financial_policy_original_read','financial_policy_proposer_observation')) LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,pactwoven_runtime,pactwoven_provisioner,pactwoven_access_provisioner,pactwoven_mandate_writer,pactwoven_finance_observer,pactwoven_custody_setup_writer,pactwoven_custody_setup_verifier,pactwoven_financial_authorizer,pactwoven_financial_verifier',routine);
 END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION pactwoven.financial_policy_resolve_observer(text,jsonb) TO pactwoven_financial_verifier;
GRANT EXECUTE ON FUNCTION pactwoven.financial_policy_read_context(uuid,jsonb,jsonb),pactwoven.financial_policy_governance_index(uuid,jsonb,jsonb),pactwoven.financial_policy_original_read(uuid,jsonb,jsonb),pactwoven.financial_policy_proposer_observation(uuid,jsonb,jsonb) TO pactwoven_financial_authorizer;
COMMIT;
