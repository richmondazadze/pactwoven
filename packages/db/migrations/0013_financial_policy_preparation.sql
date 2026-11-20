BEGIN;

-- Preparation observes configuration; it never calls a command or creates policy, money, consent or proof.
CREATE FUNCTION pactwoven.financial_policy_prepare_schema() RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT $schema${"type":"object","properties":{"responsibilityId":{"anyOf":[{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},{"type":"null"}]},"selection":{"oneOf":[{"type":"object","properties":{"schemaVersion":{"const":1},"action":{"const":"save_document"},"targetId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"previous":{"anyOf":[{"type":"object","properties":{"id":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"version":{"type":"integer","minimum":1,"maximum":2147483647},"recordHash":{"type":"string","pattern":"^[a-f0-9]{64}$"}},"required":["id","version","recordHash"],"additionalProperties":false},{"type":"null"}]},"purpose":{"type":"string","enum":["financial_mandate","budget_policy","approval_policy"]}},"required":["schemaVersion","action","targetId","previous","purpose"],"additionalProperties":false},{"type":"object","properties":{"schemaVersion":{"const":1},"action":{"const":"save_draft"},"targetId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"previous":{"anyOf":[{"type":"object","properties":{"id":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"version":{"type":"integer","minimum":1,"maximum":2147483647},"recordHash":{"type":"string","pattern":"^[a-f0-9]{64}$"}},"required":["id","version","recordHash"],"additionalProperties":false},{"type":"null"}]},"document":{"anyOf":[{"type":"object","properties":{"id":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"version":{"type":"integer","minimum":1,"maximum":2147483647},"recordHash":{"type":"string","pattern":"^[a-f0-9]{64}$"}},"required":["id","version","recordHash"],"additionalProperties":false},{"type":"null"}]}},"required":["schemaVersion","action","targetId","previous","document"],"additionalProperties":false},{"type":"object","properties":{"schemaVersion":{"const":1},"action":{"const":"withdraw_draft"},"targetId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"previous":{"type":"object","properties":{"id":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"version":{"type":"integer","minimum":1,"maximum":2147483647},"recordHash":{"type":"string","pattern":"^[a-f0-9]{64}$"}},"required":["id","version","recordHash"],"additionalProperties":false}},"required":["schemaVersion","action","targetId","previous"],"additionalProperties":false},{"type":"object","properties":{"schemaVersion":{"const":1},"action":{"const":"propose_governance"},"targetId":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"previous":{"anyOf":[{"type":"object","properties":{"id":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"version":{"type":"integer","minimum":1,"maximum":2147483647},"recordHash":{"type":"string","pattern":"^[a-f0-9]{64}$"}},"required":["id","version","recordHash"],"additionalProperties":false},{"type":"null"}]},"assetKey":{"anyOf":[{"type":"string","pattern":"^[a-f0-9]{64}$"},{"type":"null"}]},"budgetDocument":{"anyOf":[{"type":"object","properties":{"id":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"version":{"type":"integer","minimum":1,"maximum":2147483647},"recordHash":{"type":"string","pattern":"^[a-f0-9]{64}$"}},"required":["id","version","recordHash"],"additionalProperties":false},{"type":"null"}]},"approvalDocument":{"anyOf":[{"type":"object","properties":{"id":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"version":{"type":"integer","minimum":1,"maximum":2147483647},"recordHash":{"type":"string","pattern":"^[a-f0-9]{64}$"}},"required":["id","version","recordHash"],"additionalProperties":false},{"type":"null"}]}},"required":["schemaVersion","action","targetId","previous","assetKey","budgetDocument","approvalDocument"],"additionalProperties":false}]}},"required":["responsibilityId","selection"],"additionalProperties":false}$schema$::jsonb
$$;

CREATE OR REPLACE FUNCTION pactwoven.financial_policy_role_safe(who oid,cap text) RETURNS boolean LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$
 WITH RECURSIVE reachable(oid) AS(SELECT who UNION SELECT m.roleid FROM pg_auth_members m JOIN reachable x ON x.oid=m.member),
 expected AS(SELECT to_regprocedure(name) AS oid FROM unnest(CASE cap WHEN 'verifier' THEN ARRAY['pactwoven.financial_policy_attest(jsonb)','pactwoven.financial_policy_resolve_observer(text,jsonb)']
  WHEN 'authorizer' THEN ARRAY['pactwoven.financial_policy_command(uuid,jsonb)','pactwoven.financial_policy_read(uuid,jsonb)','pactwoven.financial_policy_list(uuid,jsonb)','pactwoven.financial_policy_recover(uuid,jsonb)','pactwoven.financial_policy_read_context(uuid,jsonb,jsonb)','pactwoven.financial_policy_governance_index(uuid,jsonb,jsonb)','pactwoven.financial_policy_original_read(uuid,jsonb,jsonb)','pactwoven.financial_policy_proposer_observation(uuid,jsonb,jsonb)','pactwoven.financial_policy_prepare(uuid,jsonb,jsonb)'] ELSE ARRAY[]::text[] END) name),
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

-- Called only from the scoped preparation transaction. Historical text is never replaced.
CREATE FUNCTION pactwoven.financial_policy_prepare_document(e text,o text,rid text,ref jsonb,purpose text,current_required boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v jsonb;projected jsonb;BEGIN
 IF ref IS NULL OR ref='null'::jsonb THEN RETURN NULL;END IF;
 PERFORM pactwoven.financial_policy_reader_require('reference',ref);
 SELECT body INTO v FROM pactwoven.financial_policy_records WHERE environment=e AND organization_id=o AND id=ref->>'id'
  AND version=(ref->>'version')::int AND responsibility_id IS NOT DISTINCT FROM rid;
 IF v IS NULL OR v->>'kind'<>'document' OR v->>'purpose'<>purpose THEN RETURN NULL;END IF;
 PERFORM pactwoven.financial_policy_original_checked((v->>'operationId')::uuid);
 IF pactwoven.financial_policy_ref(v) IS DISTINCT FROM ref THEN RETURN NULL;END IF;
 projected:=pactwoven.financial_policy_projection(v);
 IF current_required AND NOT(projected->>'current')::boolean THEN RETURN NULL;END IF;
 RETURN projected;
END $$;

CREATE FUNCTION pactwoven.financial_policy_prepare(eid uuid,s jsonb,q jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='3s' AS $$
DECLARE c jsonb;sel jsonb;rid text;action_name text;p jsonb;t jsonb;m jsonb;ctx jsonb;doc jsonb;x jsonb;
 target_state text;latest jsonb;view jsonb;history jsonb:='[]';target_control jsonb;original_matches boolean;
 reasons jsonb:='[]';warnings jsonb:='["TRUST_UNAVAILABLE","FINANCIAL_AUTHORITY_UNAVAILABLE"]';sites jsonb:='[]';site_active boolean;
 document jsonb;budget_document jsonb;approval_document jsonb;asset_query jsonb;deadline timestamptz;at_time timestamptz;result jsonb;
BEGIN
 PERFORM pactwoven.financial_require_read_committed();
 IF NOT coalesce(pactwoven.financial_policy_matches(q,pactwoven.financial_policy_prepare_schema()),false)
  OR octet_length(convert_to(q::text,'UTF8'))>8192 THEN RAISE EXCEPTION USING ERRCODE='FP004',MESSAGE='Strict bounded preparation query required';END IF;
 sel:=q->'selection';rid:=q->>'responsibilityId';action_name:=sel->>'action';
 IF (rid IS NOT NULL) IS DISTINCT FROM(action_name IN('save_draft','withdraw_draft') OR(action_name='save_document' AND sel->>'purpose'='financial_mandate'))
  OR(sel->'previous'<>'null'::jsonb AND sel#>>'{previous,id}'<>sel->>'targetId')
  OR(action_name IN('save_draft','withdraw_draft') AND sel->>'targetId'='context')
  OR(action_name='propose_governance' AND(sel->>'targetId' IN('context','documents','operations')
   OR(sel->'budgetDocument'<>'null'::jsonb AND sel->'approvalDocument'<>'null'::jsonb AND sel#>>'{budgetDocument,id}'=sel#>>'{approvalDocument,id}')))
 THEN RAISE EXCEPTION USING ERRCODE='FP004',MESSAGE='Exact supported preparation selection and route required';END IF;
 -- The accepted primitive locks organization, revocations, members, responsibility and sites in order.
 c:=pactwoven.financial_policy_reader_context(eid,s,rid);
 IF rid IS NULL AND NOT(c->'roles' ?| ARRAY['owner','finance']) THEN RAISE EXCEPTION USING ERRCODE='FP001',MESSAGE='Organization preparation disclosure denied';END IF;
 deadline:=least((c#>>'{identity,expiresAt}')::timestamptz,(c#>>'{identity,observedAt}')::timestamptz+interval '20 seconds');

 -- Occupancy deliberately has no kind/responsibility filter. The organization lock also covers writers.
 SELECT r.body INTO p FROM pactwoven.financial_policy_records r WHERE r.environment=s->>'environment' AND r.organization_id=s->>'organizationId'
  AND r.id=sel->>'targetId' ORDER BY r.version DESC LIMIT 1 FOR SHARE;
 IF p IS NULL THEN target_state:=CASE WHEN sel->'previous'='null'::jsonb THEN 'absent' ELSE 'unavailable' END;
 ELSIF p->>'responsibilityId' IS DISTINCT FROM rid
  OR p->>'kind'<>(CASE action_name WHEN 'save_document' THEN 'document' WHEN 'propose_governance' THEN 'governance' ELSE 'draft' END)
  OR(action_name='save_document' AND p->>'purpose'<>sel->>'purpose')
  OR(p->>'kind'='governance' AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(p#>'{bundle,approval,actionSiteIds}') a(id)
   WHERE NOT(s->'siteIds' ? a.id) OR NOT(s->'actionSiteIds' ? a.id))) THEN target_state:='unavailable';
 ELSE
  PERFORM pactwoven.financial_policy_original_checked((p->>'operationId')::uuid);
  latest:=pactwoven.financial_policy_ref(p);
  IF latest IS DISTINCT FROM sel->'previous' THEN target_state:='changed';
  ELSE
   target_state:='exact';view:=pactwoven.financial_policy_projection(p);
   IF p->>'kind'='governance' THEN target_control:=pactwoven.financial_policy_reader_control(s->>'environment',s->>'organizationId',p#>>'{bundle,budgetAccountId}');END IF;
   original_matches:=CASE WHEN p->>'kind'='document' THEN p#>>'{actor,actorId}'=s#>>'{actor,actorId}'
    WHEN p->>'kind'='draft' THEN p#>>'{requester,actorId}'=s#>>'{actor,actorId}' AND p#>>'{requester,subject}'=s#>>'{actor,subject}'
    ELSE p#>>'{proposer,actorId}'=s#>>'{actor,actorId}' AND p#>>'{proposer,subject}'=s#>>'{actor,subject}' END;
   FOR x IN SELECT * FROM jsonb_array_elements(CASE p->>'kind' WHEN 'draft' THEN p#>'{draft,documents}' WHEN 'governance' THEN p#>'{bundle,documents}' ELSE '[]'::jsonb END) LOOP
    doc:=pactwoven.financial_policy_prepare_document(s->>'environment',s->>'organizationId',CASE WHEN x->>'purpose'='financial_mandate' THEN rid ELSE NULL END,x-'purpose',x->>'purpose',false);
    IF doc IS NULL THEN RAISE EXCEPTION USING ERRCODE='FP008',MESSAGE='Exact historical preparation document unavailable';END IF;
    history:=history||jsonb_build_array(doc);
   END LOOP;
   warnings:=warnings||(view->'blockers');
   IF NOT original_matches THEN reasons:=reasons||'"ORIGINAL_ACTOR_REQUIRED"'::jsonb;END IF;
   IF(p->>'version')::int=2147483647 THEN reasons:=reasons||'"VERSION_EXHAUSTED"'::jsonb;END IF;
   IF p->>'kind'='draft' AND p->>'state'='WITHDRAWN' THEN reasons:=reasons||'"DRAFT_WITHDRAWN"'::jsonb;END IF;
   IF action_name='save_draft' AND(p#>'{draft,asset}'<>'null'::jsonb OR p#>'{draft,account}'<>'null'::jsonb OR p#>'{draft,governance}'<>'null'::jsonb OR p#>'{draft,trust}'<>'null'::jsonb)
    THEN reasons:=reasons||'"DRAFT_MATERIAL_UNSUPPORTED"'::jsonb;END IF;
   IF p->>'kind'='governance' AND p->>'state'<>'OPEN' THEN reasons:=reasons||'"CURRENT_RECORD_REQUIRED"'::jsonb;END IF;
  END IF;
 END IF;
 IF target_state='unavailable' THEN reasons:=reasons||'"TARGET_UNAVAILABLE"'::jsonb;latest:=NULL;END IF;
 IF target_state='changed' THEN reasons:=reasons||'"PREDECESSOR_CHANGED"'::jsonb;END IF;
 t:=jsonb_build_object('state',target_state,'latestReference',latest,'record',view,'historicalDocuments',history,'control',target_control);
 IF rid IS NULL AND NOT(c->'roles' ? 'owner') THEN reasons:=reasons||'"ROLE_REQUIRED"'::jsonb;END IF;

 IF action_name IN('save_document','save_draft') THEN
  IF rid IS NOT NULL THEN
   ctx:=pactwoven.financial_policy_read_context(eid,s,jsonb_build_object('responsibilityId',rid,'assetKey',NULL,'documents','[]'::jsonb));
   deadline:=least(deadline,(ctx->>'expiresAt')::timestamptz);
   SELECT active INTO site_active FROM pactwoven.financial_site_fences WHERE environment=s->>'environment' AND organization_id=s->>'organizationId' AND site_id=c#>>'{responsibility,siteId}';
   IF site_active IS NULL THEN RAISE EXCEPTION USING ERRCODE='FP008',MESSAGE='Exact preparation site basis unavailable';END IF;
   IF NOT site_active THEN reasons:=reasons||'"SCOPE_CHANGED"'::jsonb;END IF;
  END IF;
  IF action_name='save_document' THEN m:=jsonb_build_object('action',action_name,'purpose',sel->'purpose','organizationEpoch',s->'organizationEpoch','draftScope',ctx->'draftScope','siteActive',site_active);
  ELSE
   document:=pactwoven.financial_policy_prepare_document(s->>'environment',s->>'organizationId',rid,sel->'document','financial_mandate',true);
   IF sel->'document'='null'::jsonb THEN reasons:=reasons||'"DOCUMENT_REQUIRED"'::jsonb;
   ELSIF document IS NULL THEN reasons:=reasons||'"DOCUMENT_CHANGED"'::jsonb;END IF;
   warnings:=warnings||'["ASSET_MISSING","ACCOUNT_MISSING","GOVERNANCE_MISSING"]'::jsonb;
   m:=jsonb_build_object('action',action_name,'profile','incomplete','draftScope',ctx->'draftScope','siteActive',site_active,'document',document,'asset',NULL,'account',NULL,'governance',NULL,'trust',NULL);
  END IF;
 ELSIF action_name='withdraw_draft' THEN
  -- Current grants and the raw original requester are sufficient; do not reauthorize historical configuration.
  m:=jsonb_build_object('action',action_name);
 ELSE
  -- Only the accepted physical devnet asset is supported; registry lookup supplies all actual material.
  asset_query:=CASE WHEN sel->>'assetKey'='34ee730cf90d3d55ea2d34e911aa4ad941aafb29668bf4056cfa88c6cf0492e4' THEN sel->'assetKey' ELSE 'null'::jsonb END;
  ctx:=pactwoven.financial_policy_read_context(eid,s,jsonb_build_object('responsibilityId',NULL,'assetKey',asset_query,'documents','[]'::jsonb));
  deadline:=least(deadline,(ctx->>'expiresAt')::timestamptz);
  budget_document:=pactwoven.financial_policy_prepare_document(s->>'environment',s->>'organizationId',NULL,sel->'budgetDocument','budget_policy',true);
  approval_document:=pactwoven.financial_policy_prepare_document(s->>'environment',s->>'organizationId',NULL,sel->'approvalDocument','approval_policy',true);
  IF sel->'budgetDocument'='null'::jsonb OR sel->'approvalDocument'='null'::jsonb THEN reasons:=reasons||'"DOCUMENT_REQUIRED"'::jsonb;END IF;
  IF(sel->'budgetDocument'<>'null'::jsonb AND budget_document IS NULL) OR(sel->'approvalDocument'<>'null'::jsonb AND approval_document IS NULL) THEN reasons:=reasons||'"DOCUMENT_CHANGED"'::jsonb;END IF;
  IF sel->'assetKey'='null'::jsonb THEN reasons:=reasons||'"ASSET_MISSING"'::jsonb;ELSIF ctx->'asset'='null'::jsonb THEN reasons:=reasons||'"ASSET_CHANGED"'::jsonb;END IF;
  SELECT coalesce(jsonb_agg(v ORDER BY id COLLATE "C"),'[]') INTO sites FROM(
   SELECT f.site_id AS id,jsonb_build_object('id',f.site_id,'generation',f.generation,'recordHash',f.record_hash) v
   FROM pactwoven.financial_site_fences f WHERE f.environment=s->>'environment' AND f.organization_id=s->>'organizationId' AND f.active
    AND s->'siteIds' ? f.site_id AND s->'actionSiteIds' ? f.site_id ORDER BY f.site_id COLLATE "C" LIMIT 101) eligible;
  IF jsonb_array_length(sites)>100 THEN RAISE EXCEPTION USING ERRCODE='FP006',MESSAGE='Preparation sites exceed bounded reader';END IF;
  IF jsonb_array_length(sites)=0 THEN reasons:=reasons||'"SITE_ACCESS_REQUIRED"'::jsonb;END IF;
  IF target_state='exact' AND ctx#>>'{control,budgetAccountId}' IS NOT NULL AND p#>>'{bundle,budgetAccountId}'<>ctx#>>'{control,budgetAccountId}' THEN reasons:=reasons||'"GOVERNANCE_CHANGED"'::jsonb;END IF;
  warnings:=warnings||(CASE WHEN sel->'assetKey'<>'null'::jsonb AND asset_query='null'::jsonb THEN (ctx->'blockers')-'ASSET_MISSING'||'"ASSET_CHANGED"'::jsonb ELSE ctx->'blockers' END);
  m:=jsonb_build_object('action',action_name,'asset',ctx->'asset','budgetAccountId',ctx#>'{control,budgetAccountId}','control',ctx->'control',
   'acceptedConfiguration',ctx->'acceptedConfiguration','periods',ctx->'periods','budgetDocument',budget_document,'approvalDocument',approval_document,'eligibleActionSites',sites);
 END IF;
 SELECT coalesce(jsonb_agg(value ORDER BY value COLLATE "C"),'[]') INTO reasons FROM(SELECT DISTINCT value FROM jsonb_array_elements_text(reasons)) sorted;
 SELECT coalesce(jsonb_agg(value ORDER BY value COLLATE "C"),'[]') INTO warnings FROM(SELECT DISTINCT value FROM jsonb_array_elements_text(warnings)) sorted;
 PERFORM pactwoven.financial_policy_reader_finish(c);
 IF s IS DISTINCT FROM pactwoven.financial_policy_reader_scope(c->'identity') THEN RAISE EXCEPTION USING ERRCODE='FP001',MESSAGE='Preparation scope changed while waiting';END IF;
 at_time:=clock_timestamp();
 IF at_time>=deadline THEN RAISE EXCEPTION USING ERRCODE='FP001',MESSAGE='Original preparation observation expired while waiting';END IF;
 result:=jsonb_build_object('schemaVersion',1,'scope',s,'responsibilityId',rid,'selection',sel,'target',t,'material',m,'originalActorMatches',original_matches,
  'decision',jsonb_build_object('action',action_name,'state',CASE WHEN jsonb_array_length(reasons)=0 THEN 'reviewable' ELSE 'blocked' END,'reasons',reasons,'requiredAuthentication',NULL),
  'configurationWarnings',warnings,'observedAt',pactwoven.mandate_instant(at_time),'expiresAt',pactwoven.mandate_instant(deadline),'effectiveAuthority',false,'financialState',NULL);
 IF octet_length(convert_to(result::text,'UTF8'))>2097152 THEN RAISE EXCEPTION USING ERRCODE='FP006',MESSAGE='Preparation response exceeds bounded reader';END IF;
 PERFORM pactwoven.financial_policy_reader_finish(c);
 IF clock_timestamp()>=deadline THEN RAISE EXCEPTION USING ERRCODE='FP001',MESSAGE='Original preparation observation expired before return';END IF;
 RETURN result;
END $$;

REVOKE ALL ON FUNCTION pactwoven.financial_policy_prepare_schema(),pactwoven.financial_policy_prepare_document(text,text,text,jsonb,text,boolean),pactwoven.financial_policy_prepare(uuid,jsonb,jsonb)
 FROM PUBLIC,pactwoven_runtime,pactwoven_provisioner,pactwoven_access_provisioner,pactwoven_mandate_writer,pactwoven_finance_observer,pactwoven_custody_setup_writer,pactwoven_custody_setup_verifier,pactwoven_financial_authorizer,pactwoven_financial_verifier;
GRANT EXECUTE ON FUNCTION pactwoven.financial_policy_prepare(uuid,jsonb,jsonb) TO pactwoven_financial_authorizer;
COMMIT;
