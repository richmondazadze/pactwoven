BEGIN;
-- Separate short-lived paid-tool authority; original advisory grants are read only.
DO $$ DECLARE p text; BEGIN FOREACH p IN ARRAY ARRAY['api','policy','signer','broadcaster','observer','delivery'] LOOP
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='pactwoven_paid_tool_'||p) THEN EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE','pactwoven_paid_tool_'||p); END IF;
 EXECUTE format('GRANT USAGE ON SCHEMA pactwoven TO %I','pactwoven_paid_tool_'||p);
END LOOP; END $$;
CREATE TABLE pactwoven.paid_tool_services(role_name name NOT NULL,role_oid oid NOT NULL,purpose text NOT NULL CHECK(purpose IN('api','policy','signer','broadcaster','observer','delivery')),enabled boolean NOT NULL DEFAULT false,PRIMARY KEY(role_name,purpose));
-- Owner-managed registry. Enrollment requires an independently qualified dedicated account.
-- Address is globally unique on this genesis, including across organizations/token types.
CREATE TABLE pactwoven.paid_tool_accounts(account_key text PRIMARY KEY,environment text NOT NULL DEFAULT 'development' CHECK(environment='development'),organization_id text NOT NULL,kind text NOT NULL CHECK(kind IN('token','fee')),genesis text NOT NULL CHECK(genesis='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'),address text NOT NULL,owner_address text NOT NULL,mint text,custody_evidence_ref text NOT NULL,exclusive_purpose text NOT NULL CHECK(exclusive_purpose='paid_tool_only'),enabled boolean NOT NULL DEFAULT false,UNIQUE(genesis,address),CHECK((kind='token' AND mint='4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU') OR(kind='fee' AND mint IS NULL)),FOREIGN KEY(environment,organization_id) REFERENCES pactwoven.organizations(environment,id) DEFERRABLE INITIALLY DEFERRED);
CREATE TABLE pactwoven.paid_tool_providers(provider_id text PRIMARY KEY,destination_account text NOT NULL,destination_owner text NOT NULL,resource_hash text NOT NULL,allowlist_hash text NOT NULL,delivery_hash text NOT NULL,maximum_price numeric(20,0) NOT NULL CHECK(maximum_price>0),maximum_fee numeric(20,0) NOT NULL CHECK(maximum_fee>0),enabled boolean NOT NULL DEFAULT false);
CREATE TABLE pactwoven.paid_tool_quotes(id text PRIMARY KEY,organization_id text NOT NULL,site_id text NOT NULL,root_task_id text NOT NULL,instruction_revision integer NOT NULL,provider_id text NOT NULL REFERENCES pactwoven.paid_tool_providers,body jsonb NOT NULL,request_body jsonb NOT NULL,resource_body jsonb NOT NULL,quote_hash text NOT NULL,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL,UNIQUE(provider_id,quote_hash));
CREATE TABLE pactwoven.paid_tool_observations(id text PRIMARY KEY,account_key text NOT NULL REFERENCES pactwoven.paid_tool_accounts,slot numeric(20,0) NOT NULL,amount numeric(20,0) NOT NULL,observed_at timestamptz NOT NULL,evidence_ref text NOT NULL,evidence_hash text NOT NULL,body jsonb NOT NULL,UNIQUE(account_key,id));
CREATE INDEX paid_tool_observation_head ON pactwoven.paid_tool_observations(account_key,slot DESC,observed_at DESC);
CREATE TABLE pactwoven.paid_tool_reviews(id text PRIMARY KEY,organization_id text NOT NULL,site_id text NOT NULL,root_task_id text NOT NULL,instruction_revision integer NOT NULL,actor_id text NOT NULL,session_id text NOT NULL,identity_evidence jsonb NOT NULL,quote_id text NOT NULL REFERENCES pactwoven.paid_tool_quotes,source_key text NOT NULL REFERENCES pactwoven.paid_tool_accounts,fee_key text NOT NULL REFERENCES pactwoven.paid_tool_accounts,maximum_fee numeric(20,0) NOT NULL,body jsonb NOT NULL,body_hash text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL,UNIQUE(organization_id,actor_id,id));
CREATE TABLE pactwoven.paid_tool_operations(id text PRIMARY KEY,review_id text NOT NULL UNIQUE REFERENCES pactwoven.paid_tool_reviews,quote_id text NOT NULL UNIQUE REFERENCES pactwoven.paid_tool_quotes,version bigint NOT NULL DEFAULT 1 CHECK(version>0),status text NOT NULL DEFAULT 'authorized' CHECK(status IN('authorized','reserved','signing','signed','submitting','payment_pending','outcome_unknown','payment_confirmed','completed','cancelled')),approved_at timestamptz NOT NULL,approval_key text NOT NULL,submitted_once boolean NOT NULL DEFAULT false,revoked_at timestamptz,message jsonb,attempt jsonb,payment jsonb,delivery jsonb,UNIQUE(review_id,approval_key));
CREATE TABLE pactwoven.paid_tool_allocations(account_key text NOT NULL REFERENCES pactwoven.paid_tool_accounts,operation_id text NOT NULL REFERENCES pactwoven.paid_tool_operations,amount numeric(20,0) NOT NULL CHECK(amount>=0),state text NOT NULL CHECK(state IN('held','settled','released')),settled_slot numeric(20,0),PRIMARY KEY(account_key,operation_id),CHECK((state='settled')=(settled_slot IS NOT NULL)));
CREATE TABLE pactwoven.paid_tool_commands(operation_id text NOT NULL REFERENCES pactwoven.paid_tool_operations,command_key text NOT NULL,command_hash text NOT NULL,body jsonb NOT NULL,receipt jsonb NOT NULL,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(operation_id,command_key));
CREATE TABLE pactwoven.paid_tool_quarantine(operation_id text PRIMARY KEY REFERENCES pactwoven.paid_tool_operations,wire_base64 text NOT NULL,wire_hash text NOT NULL UNIQUE,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE pactwoven.paid_tool_messages(message_hash text PRIMARY KEY,operation_id text NOT NULL UNIQUE REFERENCES pactwoven.paid_tool_operations);
CREATE TABLE pactwoven.paid_tool_heights(id text PRIMARY KEY,operation_id text NOT NULL REFERENCES pactwoven.paid_tool_operations,body jsonb NOT NULL,observed_at timestamptz NOT NULL);
CREATE INDEX paid_tool_height_head ON pactwoven.paid_tool_heights(operation_id,observed_at DESC);
CREATE TABLE pactwoven.paid_tool_signatures(signature text PRIMARY KEY,operation_id text NOT NULL UNIQUE REFERENCES pactwoven.paid_tool_operations);
CREATE TABLE pactwoven.paid_tool_redemptions(signature text PRIMARY KEY REFERENCES pactwoven.paid_tool_signatures,operation_id text NOT NULL UNIQUE REFERENCES pactwoven.paid_tool_operations,result_hash text NOT NULL,artifact_ref text NOT NULL,result_body jsonb NOT NULL,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE FUNCTION pactwoven.paid_tool_require(ok boolean) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION USING ERRCODE='PT004',MESSAGE='Paid-tool record rejected';END IF;END $$;
CREATE FUNCTION pactwoven.paid_tool_units(v text) RETURNS numeric LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ BEGIN
 PERFORM pactwoven.paid_tool_require(v ~ '^(0|[1-9][0-9]{0,19})$' AND v::numeric<=18446744073709551615);RETURN v::numeric;END $$;
CREATE FUNCTION pactwoven.paid_tool_principal(purposes text[]) RETURNS text LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE purpose text;BEGIN
 SELECT s.purpose INTO purpose FROM pactwoven.paid_tool_services s JOIN pg_roles p ON(p.rolname,p.oid)=(s.role_name,s.role_oid) WHERE s.role_name=session_user AND s.enabled AND s.purpose=ANY(purposes) ORDER BY s.purpose LIMIT 1;
 IF purpose IS NULL THEN RAISE EXCEPTION USING ERRCODE='PT001',MESSAGE='Private paid-tool service required';END IF;RETURN purpose;END $$;
CREATE FUNCTION pactwoven.paid_tool_keys(q jsonb,keys text[]) RETURNS void LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ BEGIN
 PERFORM pactwoven.paid_tool_require(jsonb_typeof(q)='object' AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(q) k)=(SELECT array_agg(k ORDER BY k) FROM unnest(keys) k));END $$;
CREATE FUNCTION pactwoven.paid_tool_locked(r pactwoven.paid_tool_reviews,new_effect boolean) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
 DECLARE root pactwoven.native_delegation_root_runs;g pactwoven.native_delegation_grants;task pactwoven.native_delegation_tasks;deadline timestamptz;site jsonb;BEGIN
 SELECT * INTO root FROM pactwoven.native_delegation_root_runs WHERE(environment,organization_id,root_task_id,site_id,actor_id)=('development',r.organization_id,r.root_task_id,r.site_id,r.actor_id);
 PERFORM pactwoven.paid_tool_require(root.root_task_id IS NOT NULL AND root.managed);
 SELECT * INTO g FROM pactwoven.native_delegation_grants WHERE(environment,organization_id,id)=('development',r.organization_id,root.grant_id);
 IF new_effect THEN deadline:=pactwoven.native_delegation_scope_locked(g.body->'scope');ELSE
  PERFORM 1 FROM pactwoven.organizations WHERE(environment,id)=('development',r.organization_id) FOR SHARE;
  PERFORM 1 FROM pactwoven.memberships WHERE(environment,organization_id,actor_id)=('development',r.organization_id,r.actor_id) FOR SHARE;
  PERFORM 1 FROM pactwoven.native_provider_instances WHERE environment='development' FOR SHARE;
  FOR site IN SELECT value FROM jsonb_array_elements(g.body#>'{scope,sites}') ORDER BY value->>'siteId' COLLATE "C" LOOP
   PERFORM 1 FROM pactwoven.sites WHERE(environment,organization_id,id)=('development',r.organization_id,site->>'siteId') FOR SHARE;
   PERFORM 1 FROM pactwoven.financial_site_fences WHERE(environment,organization_id,site_id)=('development',r.organization_id,site->>'siteId') FOR SHARE;
  END LOOP;
  PERFORM 1 FROM pactwoven.native_delegation_policies WHERE(environment,organization_id)=('development',r.organization_id) FOR SHARE;
 END IF;
 PERFORM 1 FROM pactwoven.native_delegation_grants WHERE(environment,organization_id,id)=('development',r.organization_id,root.grant_id) FOR UPDATE;
 SELECT * INTO g FROM pactwoven.native_delegation_grants WHERE(environment,organization_id,id)=('development',r.organization_id,root.grant_id);
 SELECT * INTO root FROM pactwoven.native_delegation_root_runs WHERE(environment,organization_id,root_task_id)=('development',r.organization_id,r.root_task_id) FOR SHARE;
 SELECT * INTO task FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=('development',r.organization_id,r.root_task_id);
 IF new_effect THEN
  PERFORM pactwoven.paid_tool_require(r.expires_at>clock_timestamp() AND (deadline IS NULL OR deadline>clock_timestamp()) AND root.phase IN('ready','running','yielded','waiting_children') AND NOT root.manual_paused AND task.deadline_at>clock_timestamp() AND g.body->'revocation'='null'::jsonb AND pactwoven.supplier_time(g.body->'expiresAt')>clock_timestamp() AND task.authority=pactwoven.native_delegation_reference(g) AND pactwoven.native_instruction_revision('development',r.organization_id,r.root_task_id)=r.instruction_revision);
 END IF;
END $$;
-- The observer accepts only output produced by the private account verifier. No
-- browser/agent/API routine can call it or supply a balance in any public command.
CREATE FUNCTION pactwoven.paid_tool_observe(q jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE a pactwoven.paid_tool_accounts;prior pactwoven.paid_tool_observations;BEGIN
 PERFORM pactwoven.paid_tool_principal(ARRAY['observer']);PERFORM pactwoven.paid_tool_keys(q,ARRAY['id','accountKey','slot','amountBaseUnits','observedAt','evidenceRef','evidenceHash']);
 SELECT * INTO a FROM pactwoven.paid_tool_accounts WHERE account_key=q->>'accountKey' FOR UPDATE;PERFORM pactwoven.paid_tool_require(a.enabled AND q->>'evidenceHash' ~ '^[a-f0-9]{64}$' AND length(q->>'evidenceRef') BETWEEN 1 AND 128);
 SELECT * INTO prior FROM pactwoven.paid_tool_observations WHERE id=q->>'id';IF FOUND THEN PERFORM pactwoven.paid_tool_require(prior.body=q);RETURN prior.body;END IF;
 PERFORM pactwoven.paid_tool_require(pactwoven.supplier_time(q->'observedAt')<=clock_timestamp() AND pactwoven.supplier_time(q->'observedAt')>clock_timestamp()-interval '30 seconds');
 PERFORM pactwoven.paid_tool_require(NOT EXISTS(SELECT 1 FROM pactwoven.paid_tool_observations WHERE account_key=a.account_key AND slot=pactwoven.paid_tool_units(q->>'slot') AND amount<>pactwoven.paid_tool_units(q->>'amountBaseUnits')));
 INSERT INTO pactwoven.paid_tool_observations VALUES(q->>'id',a.account_key,pactwoven.paid_tool_units(q->>'slot'),pactwoven.paid_tool_units(q->>'amountBaseUnits'),pactwoven.supplier_time(q->'observedAt'),q->>'evidenceRef',q->>'evidenceHash',q);RETURN q;END $$;
CREATE FUNCTION pactwoven.paid_tool_quote(q jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE p pactwoven.paid_tool_providers;prior pactwoven.paid_tool_quotes;b jsonb;root pactwoven.native_delegation_root_runs;BEGIN
 PERFORM pactwoven.paid_tool_principal(ARRAY['policy']);PERFORM pactwoven.paid_tool_keys(q,ARRAY['id','organizationId','siteId','rootTaskId','instructionRevision','quote','requestBody','resourceBody']);b:=q->'quote';
 SELECT * INTO p FROM pactwoven.paid_tool_providers WHERE provider_id=b->>'providerId' FOR SHARE;
 SELECT * INTO root FROM pactwoven.native_delegation_root_runs WHERE(environment,organization_id,root_task_id,site_id)=('development',q->>'organizationId',q->>'rootTaskId',q->>'siteId');
 PERFORM pactwoven.paid_tool_require(p.enabled AND root.managed AND b->>'providerId'='equipment_optimizer_v1' AND b#>>'{challenge,providerId}'=p.provider_id AND b#>>'{challenge,payee,recipient}'=p.destination_owner AND b#>>'{challenge,payee,environment}'='development' AND b#>>'{challenge,payee,network}'='solana-devnet' AND b#>>'{challenge,payee,mint}'='4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU' AND b#>>'{challenge,payee,tokenProgram}'='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' AND b#>>'{resource,hash}'=p.resource_hash AND b#>>'{allowlistPolicy,hash}'=p.allowlist_hash AND b#>>'{deliveryPolicy,hash}'=p.delivery_hash AND b#>>'{challenge,resourceHash}'=b#>>'{resource,hash}' AND b#>>'{challenge,requestHash}'=b#>>'{request,hash}' AND b#>>'{challenge,hash}'=pactwoven.native_delegation_hash(jsonb_build_object('namespace','pactwoven.paid-tools.challenge.v1','challenge',(b->'challenge')-'hash')));
 PERFORM pactwoven.paid_tool_require(b#>>'{request,hash}'=pactwoven.native_delegation_hash(jsonb_build_object('namespace','pactwoven.paid-tools.equipment-request.v1','request',q->'requestBody')) AND b#>>'{resource,hash}'=pactwoven.native_delegation_hash(jsonb_build_object('namespace','pactwoven.paid-tools.resource.v1','service','equipment_optimizer_v1','computation','minimum_total_then_fewest_offers_then_sorted_ids','oneOfEachOffer',true,'catalogueHash',pactwoven.native_delegation_hash(jsonb_build_object('namespace','pactwoven.paid-tools.equipment-catalogue.v1','catalogue',q->'resourceBody')))) AND pactwoven.paid_tool_units(b#>>'{challenge,amountBaseUnits}')<=p.maximum_price AND pactwoven.paid_tool_units(b#>>'{challenge,amountBaseUnits}')>0 AND (q->>'instructionRevision')::integer=pactwoven.native_instruction_revision('development',root.organization_id,root.root_task_id));
 SELECT * INTO prior FROM pactwoven.paid_tool_quotes WHERE id=q->>'id';IF FOUND THEN PERFORM pactwoven.paid_tool_require(prior.body=b AND prior.request_body=q->'requestBody' AND prior.resource_body=q->'resourceBody' AND prior.organization_id=root.organization_id AND prior.root_task_id=root.root_task_id AND prior.site_id=root.site_id AND prior.instruction_revision=(q->>'instructionRevision')::integer);RETURN jsonb_build_object('id',prior.id,'quoteHash',prior.quote_hash);END IF;
 PERFORM pactwoven.paid_tool_require(pactwoven.supplier_time(b#>'{challenge,expiresAt}')>clock_timestamp() AND pactwoven.supplier_time(b#>'{challenge,expiresAt}')<=clock_timestamp()+interval '10 minutes');
 INSERT INTO pactwoven.paid_tool_quotes VALUES(q->>'id',root.organization_id,root.site_id,root.root_task_id,(q->>'instructionRevision')::integer,p.provider_id,b,q->'requestBody',q->'resourceBody',b#>>'{challenge,hash}',clock_timestamp(),pactwoven.supplier_time(b#>'{challenge,expiresAt}'));RETURN jsonb_build_object('id',q->>'id','quoteHash',b#>>'{challenge,hash}');END $$;
CREATE FUNCTION pactwoven.paid_tool_review(p_actor jsonb,q jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE ctx jsonb;quote pactwoven.paid_tool_quotes;p pactwoven.paid_tool_providers;r pactwoven.paid_tool_reviews;source pactwoven.paid_tool_accounts;fee pactwoven.paid_tool_accounts;body jsonb;expiry timestamptz;BEGIN
 PERFORM pactwoven.paid_tool_principal(ARRAY['api']);PERFORM pactwoven.paid_tool_keys(q,ARRAY['id','quoteId','sourceKey','feeKey','maximumFeeLamports']);
 PERFORM pactwoven.paid_tool_require(p_actor->>'environment'='development');
 SELECT * INTO quote FROM pactwoven.paid_tool_quotes WHERE id=q->>'quoteId';PERFORM pactwoven.paid_tool_require(quote.organization_id=p_actor->>'organizationId');
 ctx:=pactwoven.native_instruction_actor(p_actor,quote.root_task_id,quote.site_id,true);
 SELECT * INTO r FROM pactwoven.paid_tool_reviews WHERE id=q->>'id';IF FOUND THEN PERFORM pactwoven.paid_tool_require(r.actor_id=p_actor->>'actorId' AND r.session_id=p_actor->>'sessionId' AND r.quote_id=quote.id AND r.source_key=q->>'sourceKey' AND r.fee_key=q->>'feeKey' AND r.maximum_fee=pactwoven.paid_tool_units(q->>'maximumFeeLamports'));RETURN r.body;END IF;
 SELECT * INTO p FROM pactwoven.paid_tool_providers WHERE provider_id=quote.provider_id FOR SHARE;
 SELECT * INTO source FROM pactwoven.paid_tool_accounts WHERE account_key=q->>'sourceKey';SELECT * INTO fee FROM pactwoven.paid_tool_accounts WHERE account_key=q->>'feeKey';
 PERFORM pactwoven.paid_tool_require(source.enabled AND fee.enabled AND source.organization_id=quote.organization_id AND fee.organization_id=quote.organization_id AND source.kind='token' AND fee.kind='fee' AND source.account_key<>fee.account_key AND source.owner_address=fee.address AND p.enabled AND pactwoven.paid_tool_units(q->>'maximumFeeLamports')>0 AND pactwoven.paid_tool_units(q->>'maximumFeeLamports')<=p.maximum_fee AND quote.instruction_revision=pactwoven.native_instruction_revision('development',quote.organization_id,quote.root_task_id));
 expiry:=least(quote.expires_at,clock_timestamp()+interval '5 minutes');PERFORM pactwoven.paid_tool_require(expiry>clock_timestamp());
 body:=jsonb_build_object('id',q->>'id','organizationId',quote.organization_id,'siteId',quote.site_id,'rootTaskId',quote.root_task_id,'instructionRevision',quote.instruction_revision,'quoteId',quote.id,'quoteHash',quote.quote_hash,'providerId',quote.provider_id,'amountBaseUnits',quote.body#>>'{challenge,amountBaseUnits}','maximumFeeLamports',q->>'maximumFeeLamports','sourceAccount',source.address,'sourceOwner',source.owner_address,'feePayer',fee.address,'destinationAccount',p.destination_account,'destinationOwner',p.destination_owner,'mint',source.mint,'tokenProgram','TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA','genesis',source.genesis,'expiresAt',pactwoven.mandate_instant(expiry));
 body:=body||jsonb_build_object('reviewHash',pactwoven.native_delegation_hash(body));
 INSERT INTO pactwoven.paid_tool_reviews VALUES(q->>'id',quote.organization_id,quote.site_id,quote.root_task_id,quote.instruction_revision,p_actor->>'actorId',p_actor->>'sessionId',jsonb_build_object('actor',p_actor,'verifiedContext',ctx,'recordedAt',pactwoven.mandate_instant(clock_timestamp())),quote.id,source.account_key,fee.account_key,pactwoven.paid_tool_units(q->>'maximumFeeLamports'),body,body->>'reviewHash',clock_timestamp(),expiry);
 PERFORM pactwoven.native_memory_notes_deadline(ctx);RETURN body;END $$;
CREATE FUNCTION pactwoven.paid_tool_snapshot(op pactwoven.paid_tool_operations) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('operationId',op.id,'review',r.body,'version',op.version,'status',op.status,'approvedAt',pactwoven.mandate_instant(op.approved_at),'revokedAt',CASE WHEN op.revoked_at IS NULL THEN NULL ELSE pactwoven.mandate_instant(op.revoked_at) END,'message',op.message,'attempt',op.attempt,'payment',op.payment,'delivery',op.delivery) FROM pactwoven.paid_tool_reviews r WHERE r.id=op.review_id $$;
CREATE FUNCTION pactwoven.paid_tool_human_snapshot(p_actor jsonb,p_id text) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
 DECLARE op pactwoven.paid_tool_operations;r pactwoven.paid_tool_reviews;frame jsonb;BEGIN
 SELECT * INTO op FROM pactwoven.paid_tool_operations WHERE id=p_id;SELECT * INTO r FROM pactwoven.paid_tool_reviews WHERE id=op.review_id;
 PERFORM pactwoven.paid_tool_require(p_actor->>'environment'='development' AND r.organization_id=p_actor->>'organizationId' AND r.actor_id=p_actor->>'actorId');
 frame:=pactwoven.native_delegation_root_read(p_actor,r.root_task_id);PERFORM pactwoven.paid_tool_require(frame#>>'{scope,siteId}'=r.site_id);
 -- Root reader retains grant share lock; refresh the operation after acquiring it.
 SELECT * INTO op FROM pactwoven.paid_tool_operations WHERE id=p_id;
 RETURN pactwoven.paid_tool_snapshot(op)||jsonb_build_object('currentInstructionRevision',pactwoven.native_instruction_revision('development',r.organization_id,r.root_task_id),'evidenceAvailable',NOT(frame->>'evidenceUnavailable')::boolean AND NOT(frame->>'checkpointHistorical')::boolean);END $$;
CREATE FUNCTION pactwoven.paid_tool_approve(p_actor jsonb,p_review text,p_key text,p_hash text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE ctx jsonb;r pactwoven.paid_tool_reviews;op pactwoven.paid_tool_operations;BEGIN
 PERFORM pactwoven.paid_tool_principal(ARRAY['api']);SELECT * INTO r FROM pactwoven.paid_tool_reviews WHERE id=p_review;
 PERFORM pactwoven.paid_tool_require(r.organization_id=p_actor->>'organizationId' AND p_actor->>'environment'='development' AND r.actor_id=p_actor->>'actorId' AND r.session_id=p_actor->>'sessionId' AND r.body_hash=p_hash AND p_key ~ '^[A-Za-z0-9_-]{1,128}$');
 ctx:=pactwoven.native_instruction_actor(p_actor,r.root_task_id,r.site_id,true);
 -- Serialize approvals on the original grant; one operation per reviewed permission.
 PERFORM pactwoven.paid_tool_locked(r,false);
 SELECT * INTO op FROM pactwoven.paid_tool_operations WHERE review_id=r.id;IF FOUND THEN PERFORM pactwoven.paid_tool_require(op.approval_key=p_key);RETURN pactwoven.paid_tool_human_snapshot(p_actor,op.id);END IF;
 PERFORM pactwoven.paid_tool_locked(r,true);
 INSERT INTO pactwoven.paid_tool_operations(id,review_id,quote_id,approved_at,approval_key) VALUES(gen_random_uuid()::text,r.id,r.quote_id,clock_timestamp(),p_key) RETURNING * INTO op;
 PERFORM pactwoven.native_memory_notes_deadline(ctx);RETURN pactwoven.paid_tool_human_snapshot(p_actor,op.id);END $$;
CREATE FUNCTION pactwoven.paid_tool_read(p_actor jsonb,p_id text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE ctx jsonb;r pactwoven.paid_tool_reviews;op pactwoven.paid_tool_operations;BEGIN
 PERFORM pactwoven.paid_tool_principal(ARRAY['api']);SELECT * INTO op FROM pactwoven.paid_tool_operations WHERE id=p_id;SELECT * INTO r FROM pactwoven.paid_tool_reviews WHERE id=op.review_id;
 PERFORM pactwoven.paid_tool_require(p_actor->>'environment'='development' AND r.organization_id=p_actor->>'organizationId' AND r.actor_id=p_actor->>'actorId');ctx:=pactwoven.native_instruction_actor(p_actor,r.root_task_id,r.site_id,false);
 PERFORM pactwoven.native_memory_notes_deadline(ctx);RETURN pactwoven.paid_tool_human_snapshot(p_actor,op.id);END $$;
-- Raw bytes are retained exactly once BEFORE validation. This does not label
-- bytes valid, clear the signing fence or authorize broadcast.
CREATE FUNCTION pactwoven.paid_tool_quarantine_wire(p_id text,p_wire text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE op pactwoven.paid_tool_operations;r pactwoven.paid_tool_reviews;prior pactwoven.paid_tool_quarantine;h text;BEGIN
 PERFORM pactwoven.paid_tool_principal(ARRAY['signer']);PERFORM pactwoven.paid_tool_require(length(p_wire) BETWEEN 1 AND 1700);
 SELECT * INTO op FROM pactwoven.paid_tool_operations WHERE id=p_id;SELECT * INTO r FROM pactwoven.paid_tool_reviews WHERE id=op.review_id;PERFORM pactwoven.paid_tool_locked(r,false);
 SELECT * INTO op FROM pactwoven.paid_tool_operations WHERE id=p_id FOR UPDATE;h:=encode(sha256(decode(p_wire,'base64')),'hex');
 SELECT * INTO prior FROM pactwoven.paid_tool_quarantine WHERE operation_id=p_id;IF FOUND THEN PERFORM pactwoven.paid_tool_require(prior.wire_hash=h AND prior.wire_base64=p_wire);RETURN jsonb_build_object('wireHash',h);END IF;
 PERFORM pactwoven.paid_tool_require(op.status IN('signing','outcome_unknown') AND op.message IS NOT NULL AND op.attempt IS NULL AND octet_length(decode(p_wire,'base64'))<=1232);
 INSERT INTO pactwoven.paid_tool_quarantine VALUES(p_id,p_wire,h,clock_timestamp());RETURN jsonb_build_object('wireHash',h);END $$;
CREATE FUNCTION pactwoven.paid_tool_record_height(q jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE op pactwoven.paid_tool_operations;prior pactwoven.paid_tool_heights;BEGIN
 PERFORM pactwoven.paid_tool_principal(ARRAY['broadcaster','observer']);PERFORM pactwoven.paid_tool_keys(q,ARRAY['id','operationId','messageHash','blockhash','lastValidBlockHeight','currentBlockHeight','observedAt','evidenceRef','evidenceHash']);
 SELECT * INTO op FROM pactwoven.paid_tool_operations WHERE id=q->>'operationId';PERFORM pactwoven.paid_tool_require(op.message IS NOT NULL AND q->>'messageHash'=op.message->>'messageHash' AND q->>'blockhash'=op.message->>'blockhash' AND q->>'lastValidBlockHeight'=op.message->>'lastValidBlockHeight' AND q->>'evidenceHash' ~ '^[a-f0-9]{64}$' AND length(q->>'evidenceRef') BETWEEN 1 AND 128);
 SELECT * INTO prior FROM pactwoven.paid_tool_heights WHERE id=q->>'id';IF FOUND THEN PERFORM pactwoven.paid_tool_require(prior.body=q);RETURN q;END IF;
 PERFORM pactwoven.paid_tool_require(pactwoven.supplier_time(q->'observedAt')<=clock_timestamp() AND pactwoven.supplier_time(q->'observedAt')>clock_timestamp()-interval '5 seconds');PERFORM pactwoven.paid_tool_units(q->>'currentBlockHeight');
 INSERT INTO pactwoven.paid_tool_heights VALUES(q->>'id',op.id,q,pactwoven.supplier_time(q->'observedAt'));RETURN q;END $$;
CREATE FUNCTION pactwoven.paid_tool_available(k text,ob pactwoven.paid_tool_observations) RETURNS numeric LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT ob.amount-coalesce(sum(a.amount) FILTER(WHERE a.state='held' OR(a.state='settled' AND a.settled_slot>ob.slot)),0) FROM pactwoven.paid_tool_allocations a WHERE a.account_key=k $$;
CREATE FUNCTION pactwoven.paid_tool_apply(q jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE op pactwoven.paid_tool_operations;r pactwoven.paid_tool_reviews;quote pactwoven.paid_tool_quotes;p pactwoven.paid_tool_providers;prior pactwoven.paid_tool_commands;source pactwoven.paid_tool_accounts;fee pactwoven.paid_tool_accounts;so pactwoven.paid_tool_observations;fo pactwoven.paid_tool_observations;quarantine pactwoven.paid_tool_quarantine;kind text:=q->>'kind';principal text;payload jsonb;payload_key text;command_hash text;receipt jsonb;amount numeric;fee_amount numeric;new_effect boolean;height pactwoven.paid_tool_heights;BEGIN
 payload_key:=CASE kind WHEN 'prepare_sign' THEN 'message' WHEN 'retain_signed' THEN 'attempt' WHEN 'confirm_payment' THEN 'payment' WHEN 'accept_delivery' THEN 'delivery' ELSE NULL END;
 PERFORM pactwoven.paid_tool_keys(q,ARRAY['operationId','commandKey','expectedVersion','kind']||CASE WHEN payload_key IS NULL THEN ARRAY[]::text[] ELSE ARRAY[payload_key] END);
 principal:=CASE kind WHEN 'reserve' THEN 'policy' WHEN 'prepare_sign' THEN 'signer' WHEN 'retain_signed' THEN 'signer' WHEN 'prepare_broadcast' THEN 'broadcaster' WHEN 'mark_submitted' THEN 'broadcaster' WHEN 'confirm_payment' THEN 'observer' WHEN 'accept_delivery' THEN 'delivery' ELSE NULL END;
 IF kind='mark_unknown' THEN PERFORM pactwoven.paid_tool_principal(ARRAY['signer','broadcaster','observer']);ELSE PERFORM pactwoven.paid_tool_principal(ARRAY[principal]);END IF;
 PERFORM pactwoven.paid_tool_require(q->>'operationId' ~ '^[A-Za-z0-9_-]{1,128}$' AND q->>'commandKey' ~ '^[A-Za-z0-9_-]{1,128}$' AND jsonb_typeof(q->'expectedVersion')='number');
 SELECT * INTO op FROM pactwoven.paid_tool_operations WHERE id=q->>'operationId';SELECT * INTO r FROM pactwoven.paid_tool_reviews WHERE id=op.review_id;PERFORM pactwoven.paid_tool_require(r.id IS NOT NULL);
 PERFORM pactwoven.paid_tool_locked(r,false);
 PERFORM 1 FROM pactwoven.paid_tool_accounts WHERE account_key IN(r.source_key,r.fee_key) ORDER BY account_key COLLATE "C" FOR UPDATE;
 SELECT * INTO op FROM pactwoven.paid_tool_operations WHERE id=q->>'operationId' FOR UPDATE;
 command_hash:=pactwoven.native_delegation_hash(jsonb_build_object('namespace','pactwoven.paid-tool-command.v1','command',q));
 SELECT * INTO prior FROM pactwoven.paid_tool_commands WHERE(operation_id,command_key)=(op.id,q->>'commandKey');IF FOUND THEN PERFORM pactwoven.paid_tool_require(prior.command_hash=command_hash AND prior.body=q);RETURN jsonb_build_object('snapshot',pactwoven.paid_tool_snapshot(op),'receipt',prior.receipt);END IF;
 PERFORM pactwoven.paid_tool_require(op.version=(q->>'expectedVersion')::bigint AND op.version<33);
 SELECT * INTO source FROM pactwoven.paid_tool_accounts WHERE account_key=r.source_key;SELECT * INTO fee FROM pactwoven.paid_tool_accounts WHERE account_key=r.fee_key;
 SELECT * INTO quote FROM pactwoven.paid_tool_quotes WHERE id=r.quote_id;SELECT * INTO p FROM pactwoven.paid_tool_providers WHERE provider_id=quote.provider_id FOR SHARE;
 amount:=pactwoven.paid_tool_units(quote.body#>>'{challenge,amountBaseUnits}');payload:=q->payload_key;new_effect:=kind IN('reserve','prepare_sign','prepare_broadcast');
 IF new_effect THEN
  PERFORM pactwoven.paid_tool_locked(r,true);
  PERFORM pactwoven.paid_tool_require(op.revoked_at IS NULL AND source.enabled AND fee.enabled AND p.enabled AND source.address=r.body->>'sourceAccount' AND source.owner_address=r.body->>'sourceOwner' AND fee.address=r.body->>'feePayer' AND p.destination_account=r.body->>'destinationAccount' AND p.destination_owner=r.body->>'destinationOwner' AND quote.expires_at>clock_timestamp() AND amount<=p.maximum_price AND r.maximum_fee<=p.maximum_fee AND p.resource_hash=quote.body#>>'{resource,hash}' AND p.allowlist_hash=quote.body#>>'{allowlistPolicy,hash}' AND p.delivery_hash=quote.body#>>'{deliveryPolicy,hash}');
 END IF;
 IF kind='reserve' THEN
  PERFORM pactwoven.paid_tool_require(op.status='authorized');
  SELECT * INTO so FROM pactwoven.paid_tool_observations WHERE account_key=r.source_key ORDER BY slot DESC,observed_at DESC,id COLLATE "C" DESC LIMIT 1;
  SELECT * INTO fo FROM pactwoven.paid_tool_observations WHERE account_key=r.fee_key ORDER BY slot DESC,observed_at DESC,id COLLATE "C" DESC LIMIT 1;
  PERFORM pactwoven.paid_tool_require(so.observed_at>clock_timestamp()-interval '30 seconds' AND fo.observed_at>clock_timestamp()-interval '30 seconds' AND so.slot=fo.slot AND so.evidence_ref=fo.evidence_ref AND so.evidence_hash=fo.evidence_hash AND pactwoven.paid_tool_available(source.account_key,so)>=amount AND pactwoven.paid_tool_available(fee.account_key,fo)>=r.maximum_fee);
  INSERT INTO pactwoven.paid_tool_allocations VALUES(r.source_key,op.id,amount,'held',NULL),(r.fee_key,op.id,r.maximum_fee,'held',NULL);op.status:='reserved';
 ELSIF kind='prepare_sign' THEN
  PERFORM pactwoven.paid_tool_keys(payload,ARRAY['messageHash','messageBase64','blockhash','lastValidBlockHeight','currentBlockHeight','heightObservedAt','heightEvidenceRef','heightEvidenceHash','feeLamports','sourceObservationId','feeObservationId']);
  PERFORM pactwoven.paid_tool_require(op.status='reserved' AND op.message IS NULL AND op.attempt IS NULL AND payload->>'messageHash'=encode(sha256(decode(payload->>'messageBase64','base64')),'hex') AND octet_length(decode(payload->>'messageBase64','base64')) BETWEEN 1 AND 1232 AND payload->>'blockhash' ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' AND pactwoven.paid_tool_units(payload->>'feeLamports')>0 AND pactwoven.paid_tool_units(payload->>'feeLamports')<=r.maximum_fee);
  PERFORM pactwoven.paid_tool_require(pactwoven.paid_tool_units(payload->>'currentBlockHeight')<=pactwoven.paid_tool_units(payload->>'lastValidBlockHeight') AND pactwoven.supplier_time(payload->'heightObservedAt')<=clock_timestamp() AND pactwoven.supplier_time(payload->'heightObservedAt')>clock_timestamp()-interval '5 seconds' AND payload->>'heightEvidenceHash' ~ '^[a-f0-9]{64}$' AND payload->>'heightEvidenceRef' ~ '^[A-Za-z0-9_-]{1,128}$');
  SELECT * INTO so FROM pactwoven.paid_tool_observations WHERE id=payload->>'sourceObservationId' AND account_key=r.source_key;SELECT * INTO fo FROM pactwoven.paid_tool_observations WHERE id=payload->>'feeObservationId' AND account_key=r.fee_key;
  PERFORM pactwoven.paid_tool_require(so.observed_at>clock_timestamp()-interval '30 seconds' AND fo.observed_at>clock_timestamp()-interval '30 seconds' AND so.slot=fo.slot AND so.evidence_ref=fo.evidence_ref AND so.evidence_hash=fo.evidence_hash AND pactwoven.paid_tool_available(r.source_key,so)>=0 AND pactwoven.paid_tool_available(r.fee_key,fo)>=0 AND NOT EXISTS(SELECT 1 FROM pactwoven.paid_tool_observations WHERE account_key IN(r.source_key,r.fee_key) AND slot>so.slot));
  INSERT INTO pactwoven.paid_tool_messages VALUES(payload->>'messageHash',op.id);op.message:=payload;op.status:='signing';
 ELSIF kind='retain_signed' THEN
  PERFORM pactwoven.paid_tool_keys(payload,ARRAY['id','messageHash','wireHash','signature','blockhash','lastValidBlockHeight']);
  SELECT * INTO quarantine FROM pactwoven.paid_tool_quarantine WHERE operation_id=op.id;
  PERFORM pactwoven.paid_tool_require(op.status IN('signing','outcome_unknown') AND op.message IS NOT NULL AND op.attempt IS NULL AND quarantine.operation_id=op.id AND payload->>'wireHash'=quarantine.wire_hash AND payload->>'messageHash'=op.message->>'messageHash' AND payload->>'blockhash'=op.message->>'blockhash' AND payload->>'lastValidBlockHeight'=op.message->>'lastValidBlockHeight' AND payload->>'signature' ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$' AND payload->>'id' ~ '^[A-Za-z0-9_-]{1,128}$');
  INSERT INTO pactwoven.paid_tool_signatures VALUES(payload->>'signature',op.id);op.attempt:=payload;op.status:='signed';
 ELSIF kind='prepare_broadcast' THEN
  PERFORM pactwoven.paid_tool_require(op.status='signed' AND op.attempt IS NOT NULL);
  SELECT * INTO so FROM pactwoven.paid_tool_observations WHERE account_key=r.source_key ORDER BY slot DESC,observed_at DESC,id COLLATE "C" DESC LIMIT 1;
  SELECT * INTO fo FROM pactwoven.paid_tool_observations WHERE account_key=r.fee_key ORDER BY slot DESC,observed_at DESC,id COLLATE "C" DESC LIMIT 1;
  SELECT * INTO height FROM pactwoven.paid_tool_heights WHERE operation_id=op.id ORDER BY observed_at DESC,id COLLATE "C" DESC LIMIT 1;
  PERFORM pactwoven.paid_tool_require(so.observed_at>clock_timestamp()-interval '30 seconds' AND fo.observed_at>clock_timestamp()-interval '30 seconds' AND so.slot=fo.slot AND so.evidence_ref=fo.evidence_ref AND so.evidence_hash=fo.evidence_hash AND pactwoven.paid_tool_available(r.source_key,so)>=0 AND pactwoven.paid_tool_available(r.fee_key,fo)>=0 AND height.observed_at>clock_timestamp()-interval '5 seconds' AND height.body->>'messageHash'=op.message->>'messageHash' AND pactwoven.paid_tool_units(height.body->>'currentBlockHeight')<=pactwoven.paid_tool_units(op.message->>'lastValidBlockHeight'));
  op.status:='submitting';
 ELSIF kind='mark_submitted' THEN
  PERFORM pactwoven.paid_tool_require(op.status IN('submitting','outcome_unknown') AND op.attempt IS NOT NULL AND NOT op.submitted_once);op.submitted_once:=true;op.status:='payment_pending';
 ELSIF kind='mark_unknown' THEN
  PERFORM pactwoven.paid_tool_require(op.status IN('signing','submitting','payment_pending'));op.status:='outcome_unknown';
 ELSIF kind='confirm_payment' THEN
  PERFORM pactwoven.paid_tool_keys(payload,ARRAY['status','signature','slot','observedAt','genesis','mint','tokenProgram','sourceAccount','sourceOwner','destinationAccount','destinationOwner','amountBaseUnits','feeLamports','messageHash','transactionEvidenceRef','transactionEvidenceHash','statusEvidenceRef','statusEvidenceHash']);
  PERFORM pactwoven.paid_tool_require(op.status IN('submitting','payment_pending','outcome_unknown') AND op.payment IS NULL AND op.attempt IS NOT NULL AND payload->>'status'='finalized_transfer' AND payload->>'signature'=op.attempt->>'signature' AND payload->>'messageHash'=op.message->>'messageHash' AND payload->>'genesis'=r.body->>'genesis' AND payload->>'mint'=r.body->>'mint' AND payload->>'tokenProgram'=r.body->>'tokenProgram' AND payload->>'sourceAccount'=r.body->>'sourceAccount' AND payload->>'sourceOwner'=r.body->>'sourceOwner' AND payload->>'destinationAccount'=r.body->>'destinationAccount' AND payload->>'destinationOwner'=r.body->>'destinationOwner' AND pactwoven.paid_tool_units(payload->>'amountBaseUnits')=amount AND pactwoven.paid_tool_units(payload->>'feeLamports')=pactwoven.paid_tool_units(op.message->>'feeLamports') AND payload->>'transactionEvidenceHash' ~ '^[a-f0-9]{64}$' AND payload->>'statusEvidenceHash' ~ '^[a-f0-9]{64}$' AND pactwoven.paid_tool_units(payload->>'slot')>=(SELECT slot FROM pactwoven.paid_tool_observations WHERE id=op.message->>'sourceObservationId') AND length(payload->>'transactionEvidenceRef') BETWEEN 1 AND 128 AND length(payload->>'statusEvidenceRef') BETWEEN 1 AND 128 AND pactwoven.supplier_time(payload->'observedAt')<=clock_timestamp() AND pactwoven.supplier_time(payload->'observedAt')>=op.approved_at);
  UPDATE pactwoven.paid_tool_allocations a SET state='settled',settled_slot=pactwoven.paid_tool_units(payload->>'slot'),amount=CASE WHEN a.account_key=r.fee_key THEN pactwoven.paid_tool_units(payload->>'feeLamports') ELSE a.amount END WHERE a.operation_id=op.id AND a.state='held';
  op.payment:=payload;op.status:='payment_confirmed';
 ELSIF kind='accept_delivery' THEN
  PERFORM pactwoven.paid_tool_keys(payload,ARRAY['artifactRef','resultHash','requestHash','resourceHash','paymentSignature','verifiedAt','resultBody']);
  PERFORM pactwoven.paid_tool_require(op.status='payment_confirmed' AND op.payment IS NOT NULL AND op.delivery IS NULL AND payload->>'paymentSignature'=op.payment->>'signature' AND payload->>'requestHash'=quote.body#>>'{request,hash}' AND payload->>'resourceHash'=quote.body#>>'{resource,hash}' AND payload->>'resultHash'=pactwoven.native_delegation_hash(jsonb_build_object('namespace','pactwoven.paid-tools.delivery.v1','result',payload->'resultBody')) AND pactwoven.supplier_time(payload->'verifiedAt')<=clock_timestamp() AND pactwoven.supplier_time(payload->'verifiedAt')>=pactwoven.supplier_time(op.payment->'observedAt') AND length(payload->>'artifactRef') BETWEEN 1 AND 128);
  INSERT INTO pactwoven.paid_tool_redemptions VALUES(payload->>'paymentSignature',op.id,payload->>'resultHash',payload->>'artifactRef',payload->'resultBody',clock_timestamp());op.delivery:=payload;op.status:='completed';
 ELSE PERFORM pactwoven.paid_tool_require(false);
 END IF;
 IF new_effect THEN PERFORM pactwoven.paid_tool_locked(r,true);PERFORM pactwoven.paid_tool_require(r.expires_at>clock_timestamp() AND quote.expires_at>clock_timestamp() AND so.observed_at>clock_timestamp()-interval '30 seconds' AND fo.observed_at>clock_timestamp()-interval '30 seconds');IF kind='prepare_sign' THEN PERFORM pactwoven.paid_tool_require(pactwoven.supplier_time(payload->'heightObservedAt')>clock_timestamp()-interval '5 seconds');ELSIF kind='prepare_broadcast' THEN PERFORM pactwoven.paid_tool_require(height.observed_at>clock_timestamp()-interval '5 seconds');END IF;END IF;
 receipt:=jsonb_build_object('commandKey',q->>'commandKey','commandHash',command_hash,'previousVersion',op.version,'version',op.version+1,'recordedAt',pactwoven.mandate_instant(clock_timestamp()),'status',op.status);
 op.version:=op.version+1;UPDATE pactwoven.paid_tool_operations SET version=op.version,status=op.status,submitted_once=op.submitted_once,message=op.message,attempt=op.attempt,payment=op.payment,delivery=op.delivery WHERE id=op.id;
 INSERT INTO pactwoven.paid_tool_commands VALUES(op.id,q->>'commandKey',command_hash,q,receipt,clock_timestamp());RETURN jsonb_build_object('snapshot',pactwoven.paid_tool_snapshot(op),'receipt',receipt);
END $$;
CREATE FUNCTION pactwoven.paid_tool_control(p_actor jsonb,q jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE r pactwoven.paid_tool_reviews;op pactwoven.paid_tool_operations;ctx jsonb;prior pactwoven.paid_tool_commands;h text;receipt jsonb;BEGIN
 PERFORM pactwoven.paid_tool_principal(ARRAY['api']);PERFORM pactwoven.paid_tool_keys(q,ARRAY['operationId','commandKey','expectedVersion','kind']);
 PERFORM pactwoven.paid_tool_require(q->>'kind' IN('cancel_before_signing','revoke') AND q->>'commandKey' ~ '^[A-Za-z0-9_-]{1,128}$');
 SELECT * INTO op FROM pactwoven.paid_tool_operations WHERE id=q->>'operationId';SELECT * INTO r FROM pactwoven.paid_tool_reviews WHERE id=op.review_id;
 PERFORM pactwoven.paid_tool_require(p_actor->>'environment'='development' AND r.organization_id=p_actor->>'organizationId' AND r.actor_id=p_actor->>'actorId');
 ctx:=pactwoven.native_instruction_actor(p_actor,r.root_task_id,r.site_id,true);PERFORM pactwoven.paid_tool_locked(r,false);
 PERFORM 1 FROM pactwoven.paid_tool_accounts WHERE account_key IN(r.source_key,r.fee_key) ORDER BY account_key COLLATE "C" FOR UPDATE;
 SELECT * INTO op FROM pactwoven.paid_tool_operations WHERE id=q->>'operationId' FOR UPDATE;h:=pactwoven.native_delegation_hash(jsonb_build_object('namespace','pactwoven.paid-tool-command.v1','command',q));
 SELECT * INTO prior FROM pactwoven.paid_tool_commands WHERE(operation_id,command_key)=(op.id,q->>'commandKey');IF FOUND THEN PERFORM pactwoven.paid_tool_require(prior.body=q AND prior.command_hash=h);RETURN jsonb_build_object('snapshot',pactwoven.paid_tool_human_snapshot(p_actor,op.id),'receipt',prior.receipt);END IF;
 PERFORM pactwoven.paid_tool_require(op.version=(q->>'expectedVersion')::bigint AND op.version<33);
 IF q->>'kind'='cancel_before_signing' THEN
  PERFORM pactwoven.paid_tool_require(op.status IN('authorized','reserved') AND op.message IS NULL AND op.attempt IS NULL);
  UPDATE pactwoven.paid_tool_allocations SET state='released' WHERE operation_id=op.id AND state='held';op.status:='cancelled';
 ELSE PERFORM pactwoven.paid_tool_require(op.revoked_at IS NULL);op.revoked_at:=clock_timestamp();END IF;
 receipt:=jsonb_build_object('commandKey',q->>'commandKey','commandHash',h,'previousVersion',op.version,'version',op.version+1,'recordedAt',pactwoven.mandate_instant(clock_timestamp()),'status',op.status);
 op.version:=op.version+1;UPDATE pactwoven.paid_tool_operations SET version=op.version,status=op.status,revoked_at=op.revoked_at WHERE id=op.id;
 INSERT INTO pactwoven.paid_tool_commands VALUES(op.id,q->>'commandKey',h,q,receipt,clock_timestamp());PERFORM pactwoven.native_memory_notes_deadline(ctx);RETURN jsonb_build_object('snapshot',pactwoven.paid_tool_human_snapshot(p_actor,op.id),'receipt',receipt);END $$;
CREATE FUNCTION pactwoven.paid_tool_private_read(p_id text,p_key text DEFAULT NULL,p_hash text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE op pactwoven.paid_tool_operations;r pactwoven.paid_tool_reviews;quote pactwoven.paid_tool_quotes;receipt pactwoven.paid_tool_commands;wire pactwoven.paid_tool_quarantine;purpose text;BEGIN
 purpose:=pactwoven.paid_tool_principal(ARRAY['policy','signer','broadcaster','observer','delivery']);SELECT * INTO op FROM pactwoven.paid_tool_operations WHERE id=p_id;PERFORM pactwoven.paid_tool_require(op.id IS NOT NULL);
 SELECT * INTO r FROM pactwoven.paid_tool_reviews WHERE id=op.review_id;SELECT * INTO quote FROM pactwoven.paid_tool_quotes WHERE id=r.quote_id;
 IF p_key IS NOT NULL THEN SELECT * INTO receipt FROM pactwoven.paid_tool_commands WHERE(operation_id,command_key)=(p_id,p_key);IF NOT FOUND THEN RETURN NULL;END IF;PERFORM pactwoven.paid_tool_require(receipt.command_hash=p_hash);END IF;
 SELECT * INTO wire FROM pactwoven.paid_tool_quarantine WHERE operation_id=p_id;
 RETURN jsonb_build_object('snapshot',pactwoven.paid_tool_snapshot(op),'quote',quote.body,'requestBody',quote.request_body,'resourceBody',quote.resource_body,'wireBase64',CASE WHEN purpose IN('signer','broadcaster','observer') THEN wire.wire_base64 ELSE NULL END,'receipt',receipt.receipt);END $$;
CREATE FUNCTION pactwoven.paid_tool_list(p_actor jsonb,p_root text,p_site text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE ctx jsonb;items jsonb;BEGIN
 PERFORM pactwoven.paid_tool_principal(ARRAY['api']);PERFORM pactwoven.paid_tool_require(p_actor->>'environment'='development');ctx:=pactwoven.native_instruction_actor(p_actor,p_root,p_site,false);
 SELECT coalesce(jsonb_agg(pactwoven.paid_tool_human_snapshot(p_actor,(x.op).id) ORDER BY x.approved_at,x.id),'[]'::jsonb) INTO items FROM(SELECT op,op.approved_at,op.id FROM pactwoven.paid_tool_operations op JOIN pactwoven.paid_tool_reviews r ON r.id=op.review_id WHERE(r.organization_id,r.site_id,r.root_task_id,r.actor_id)=(p_actor->>'organizationId',p_site,p_root,p_actor->>'actorId') ORDER BY op.approved_at DESC,op.id LIMIT 32)x;
 PERFORM pactwoven.native_memory_notes_deadline(ctx);RETURN jsonb_build_object('rootTaskId',p_root,'items',items);END $$;
CREATE FUNCTION pactwoven.paid_tool_recover(p_actor jsonb,p_root text,p_site text,q jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE ctx jsonb;r pactwoven.paid_tool_reviews;op pactwoven.paid_tool_operations;receipt pactwoven.paid_tool_commands;BEGIN
 PERFORM pactwoven.paid_tool_principal(ARRAY['api']);PERFORM pactwoven.paid_tool_require(p_actor->>'environment'='development');ctx:=pactwoven.native_instruction_actor(p_actor,p_root,p_site,false);
 IF q->>'kind'='approval' THEN
  PERFORM pactwoven.paid_tool_keys(q,ARRAY['kind','reviewId','commandKey','reviewHash']);SELECT * INTO r FROM pactwoven.paid_tool_reviews WHERE id=q->>'reviewId';
  PERFORM pactwoven.paid_tool_require((r.organization_id,r.site_id,r.root_task_id,r.actor_id)=(p_actor->>'organizationId',p_site,p_root,p_actor->>'actorId') AND r.body_hash=q->>'reviewHash');
  SELECT * INTO op FROM pactwoven.paid_tool_operations WHERE review_id=r.id;IF op.id IS NOT NULL THEN PERFORM pactwoven.paid_tool_require(op.approval_key=q->>'commandKey');END IF;
 ELSIF q->>'kind'='control' THEN
  PERFORM pactwoven.paid_tool_keys(q,ARRAY['kind','operationId','commandKey','commandHash']);SELECT * INTO op FROM pactwoven.paid_tool_operations WHERE id=q->>'operationId';SELECT * INTO r FROM pactwoven.paid_tool_reviews WHERE id=op.review_id;
  PERFORM pactwoven.paid_tool_require((r.organization_id,r.site_id,r.root_task_id,r.actor_id)=(p_actor->>'organizationId',p_site,p_root,p_actor->>'actorId'));
  SELECT * INTO receipt FROM pactwoven.paid_tool_commands WHERE(operation_id,command_key)=(op.id,q->>'commandKey');IF receipt.command_key IS NULL THEN RETURN NULL;END IF;PERFORM pactwoven.paid_tool_require(receipt.command_hash=q->>'commandHash');
 ELSE PERFORM pactwoven.paid_tool_require(false);END IF;
 PERFORM pactwoven.native_memory_notes_deadline(ctx);IF op.id IS NULL THEN RETURN NULL;END IF;RETURN jsonb_build_object('snapshot',pactwoven.paid_tool_human_snapshot(p_actor,op.id),'receipt',receipt.receipt);END $$;
CREATE FUNCTION pactwoven.paid_tool_budget_part(k text) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 WITH ob AS(SELECT * FROM pactwoven.paid_tool_observations WHERE account_key=k ORDER BY slot DESC,observed_at DESC,id COLLATE "C" DESC LIMIT 1),
 sums AS(SELECT coalesce(sum(amount) FILTER(WHERE state='held'),0) held,coalesce(sum(amount) FILTER(WHERE state='settled' AND settled_slot>coalesce((SELECT slot FROM ob),0)),0) unreflected,coalesce(sum(amount) FILTER(WHERE state='settled'),0) spent FROM pactwoven.paid_tool_allocations WHERE account_key=k)
 SELECT jsonb_build_object('state',CASE WHEN ob.id IS NULL THEN 'unobserved' WHEN ob.observed_at<=clock_timestamp()-interval '30 seconds' THEN 'stale' ELSE 'current' END,
 'observedBaseUnits',ob.amount::text,'observedAt',CASE WHEN ob.id IS NULL THEN NULL ELSE pactwoven.mandate_instant(ob.observed_at) END,'slot',ob.slot::text,
 'heldBaseUnits',sums.held::text,'unreflectedSpentBaseUnits',sums.unreflected::text,'settledSpendBaseUnits',sums.spent::text,
 'availableBaseUnits',CASE WHEN ob.id IS NULL THEN NULL ELSE greatest(0,ob.amount-sums.held-sums.unreflected)::text END,
 'shortfallBaseUnits',CASE WHEN ob.id IS NULL THEN NULL ELSE greatest(0,sums.held+sums.unreflected-ob.amount)::text END) FROM sums LEFT JOIN ob ON true $$;
CREATE FUNCTION pactwoven.paid_tool_budget_read(p_actor jsonb,p_id text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE ctx jsonb;r pactwoven.paid_tool_reviews;op pactwoven.paid_tool_operations;answer jsonb;BEGIN
 PERFORM pactwoven.paid_tool_principal(ARRAY['api']);SELECT * INTO op FROM pactwoven.paid_tool_operations WHERE id=p_id;SELECT * INTO r FROM pactwoven.paid_tool_reviews WHERE id=op.review_id;
 PERFORM pactwoven.paid_tool_require(p_actor->>'environment'='development' AND r.organization_id=p_actor->>'organizationId' AND r.actor_id=p_actor->>'actorId');ctx:=pactwoven.native_instruction_actor(p_actor,r.root_task_id,r.site_id,false);PERFORM pactwoven.paid_tool_locked(r,false);
 PERFORM 1 FROM pactwoven.paid_tool_accounts WHERE account_key IN(r.source_key,r.fee_key) ORDER BY account_key COLLATE "C" FOR SHARE;
 SELECT * INTO op FROM pactwoven.paid_tool_operations WHERE id=p_id FOR SHARE;
 answer:=jsonb_build_object('operationId',op.id,'version',op.version,'reviewHash',r.body_hash,'instructionRevision',r.instruction_revision,'observedAt',pactwoven.mandate_instant(clock_timestamp()),'token',pactwoven.paid_tool_budget_part(r.source_key),'fee',pactwoven.paid_tool_budget_part(r.fee_key));
 PERFORM pactwoven.native_memory_notes_deadline(ctx);RETURN answer;END $$;
CREATE FUNCTION pactwoven.paid_tool_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN RAISE EXCEPTION USING ERRCODE='PT004',MESSAGE='Original paid-tool evidence is immutable';END $$;
DO $$ DECLARE t text;owner name:=current_user;f record;BEGIN
 FOREACH t IN ARRAY ARRAY['paid_tool_services','paid_tool_accounts','paid_tool_providers','paid_tool_quotes','paid_tool_observations','paid_tool_reviews','paid_tool_operations','paid_tool_allocations','paid_tool_commands','paid_tool_quarantine','paid_tool_messages','paid_tool_heights','paid_tool_signatures','paid_tool_redemptions'] LOOP
  EXECUTE format('ALTER TABLE pactwoven.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE pactwoven.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY paid_tool_owner ON pactwoven.%I TO %I USING(true) WITH CHECK(true)',t,owner);
  EXECUTE format('REVOKE ALL ON pactwoven.%I FROM PUBLIC,pactwoven_runtime,pactwoven_paid_tool_api,pactwoven_paid_tool_policy,pactwoven_paid_tool_signer,pactwoven_paid_tool_broadcaster,pactwoven_paid_tool_observer,pactwoven_paid_tool_delivery',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['paid_tool_quotes','paid_tool_observations','paid_tool_reviews','paid_tool_commands','paid_tool_quarantine','paid_tool_messages','paid_tool_heights','paid_tool_signatures','paid_tool_redemptions'] LOOP
  EXECUTE format('CREATE TRIGGER paid_tool_keep_original BEFORE UPDATE OR DELETE ON pactwoven.%I FOR EACH ROW EXECUTE FUNCTION pactwoven.paid_tool_immutable()',t);
 END LOOP;
 FOR f IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace='pactwoven'::regnamespace AND proname LIKE 'paid_tool_%' LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,pactwoven_runtime,pactwoven_paid_tool_api,pactwoven_paid_tool_policy,pactwoven_paid_tool_signer,pactwoven_paid_tool_broadcaster,pactwoven_paid_tool_observer,pactwoven_paid_tool_delivery',f.signature);
 END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION pactwoven.paid_tool_review(jsonb,jsonb),pactwoven.paid_tool_approve(jsonb,text,text,text),pactwoven.paid_tool_read(jsonb,text),pactwoven.paid_tool_control(jsonb,jsonb) TO pactwoven_paid_tool_api;
GRANT EXECUTE ON FUNCTION pactwoven.paid_tool_quote(jsonb) TO pactwoven_paid_tool_policy;
GRANT EXECUTE ON FUNCTION pactwoven.paid_tool_observe(jsonb) TO pactwoven_paid_tool_observer;
GRANT EXECUTE ON FUNCTION pactwoven.paid_tool_quarantine_wire(text,text) TO pactwoven_paid_tool_signer;
GRANT EXECUTE ON FUNCTION pactwoven.paid_tool_apply(jsonb),pactwoven.paid_tool_private_read(text,text,text) TO pactwoven_paid_tool_policy,pactwoven_paid_tool_signer,pactwoven_paid_tool_broadcaster,pactwoven_paid_tool_observer,pactwoven_paid_tool_delivery;
GRANT EXECUTE ON FUNCTION pactwoven.paid_tool_list(jsonb,text,text),pactwoven.paid_tool_recover(jsonb,text,text,jsonb),pactwoven.paid_tool_budget_read(jsonb,text) TO pactwoven_paid_tool_api;
GRANT EXECUTE ON FUNCTION pactwoven.paid_tool_record_height(jsonb) TO pactwoven_paid_tool_broadcaster,pactwoven_paid_tool_observer;
COMMIT;
