BEGIN;
-- Additive human note projection/intent boundary; 0026/0027 remain unchanged.
CREATE TABLE pactwoven.native_memory_notes (
 environment text NOT NULL,organization_id text NOT NULL,site_id text NOT NULL,id text NOT NULL,
 actor_id text NOT NULL,memory_id text NOT NULL,source_id text NOT NULL,created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(environment,organization_id,site_id,id),UNIQUE(environment,organization_id,site_id,memory_id),UNIQUE(environment,organization_id,site_id,source_id),
 FOREIGN KEY(environment,organization_id,actor_id) REFERENCES pactwoven.memberships(environment,organization_id,actor_id),
 FOREIGN KEY(environment,organization_id,site_id,memory_id) REFERENCES pactwoven.native_memory_heads(environment,organization_id,site_id,memory_id),
 FOREIGN KEY(environment,organization_id,site_id,source_id) REFERENCES pactwoven.native_memory_source_heads(environment,organization_id,site_id,source_id)
);
CREATE TABLE pactwoven.native_memory_note_operations (
 environment text NOT NULL,organization_id text NOT NULL,site_id text NOT NULL,actor_id text NOT NULL,request_key text NOT NULL,
 id uuid NOT NULL DEFAULT gen_random_uuid(),note_id text NOT NULL,intent jsonb NOT NULL,intent_digest text NOT NULL,
 source_reference jsonb NOT NULL,memory_reference jsonb NOT NULL,committed_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(environment,organization_id,actor_id,request_key),UNIQUE(id),
 FOREIGN KEY(environment,organization_id,site_id,note_id) REFERENCES pactwoven.native_memory_notes(environment,organization_id,site_id,id),
 CHECK(request_key ~ '^[A-Za-z0-9_-]{16,128}$'),CHECK(intent_digest=pactwoven.native_memory_hash(jsonb_build_object('namespace','pactwoven/human-memory-intent/v1','intent',intent))),
 CHECK(pactwoven.native_memory_ref_valid(source_reference,true) AND pactwoven.native_memory_ref_valid(memory_reference))
);
CREATE INDEX native_memory_notes_page_idx ON pactwoven.native_memory_notes(environment,organization_id,site_id,actor_id,created_at DESC,id);

CREATE FUNCTION pactwoven.native_memory_notes_operation_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE n pactwoven.native_memory_notes;m jsonb;s jsonb;BEGIN
 SELECT * INTO n FROM pactwoven.native_memory_notes WHERE(environment,organization_id,site_id,id,actor_id)=
  (NEW.environment,NEW.organization_id,NEW.site_id,NEW.note_id,NEW.actor_id);
 PERFORM pactwoven.native_memory_require(FOUND AND pactwoven.native_memory_notes_valid(NEW.intent),'NM009');
 PERFORM pactwoven.native_memory_require(NEW.intent->>'siteId'=NEW.site_id AND(NEW.intent->>'kind'='remember' OR NEW.intent->>'noteId'=NEW.note_id)
  AND NEW.memory_reference->>'memoryId'=n.memory_id AND NEW.source_reference->>'sourceId'=n.source_id
  AND pactwoven.native_memory_scope(NEW.memory_reference)=jsonb_build_object('environment',NEW.environment,'organizationId',NEW.organization_id,'siteId',NEW.site_id)
  AND pactwoven.native_memory_scope(NEW.source_reference)=pactwoven.native_memory_scope(NEW.memory_reference),'NM009');
 SELECT record INTO m FROM pactwoven.native_memory_revisions WHERE(environment,organization_id,site_id,memory_id,revision,digest)=
  (NEW.environment,NEW.organization_id,NEW.site_id,n.memory_id,(NEW.memory_reference->>'revision')::bigint,NEW.memory_reference->>'digest');
 SELECT record INTO s FROM pactwoven.native_memory_source_revisions WHERE(environment,organization_id,site_id,source_id,revision,digest)=
  (NEW.environment,NEW.organization_id,NEW.site_id,n.source_id,(NEW.source_reference->>'revision')::bigint,NEW.source_reference->>'digest');
 PERFORM pactwoven.native_memory_require(m IS NOT NULL AND s IS NOT NULL AND m#>>'{subject,id}'=n.id AND m->>'key'='human_note'
  AND m->'provenance'=jsonb_build_object('kind','user','actorId',n.actor_id) AND s->'provenance'=m->'provenance'
  AND s->>'kind'='user_statement' AND s->>'verification'='unverified','NM009');
 IF NEW.intent->>'kind'='remove' THEN
  PERFORM pactwoven.native_memory_require(m->>'state'='tombstone' AND s->>'status'='deleted','NM009');
 ELSE
  PERFORM pactwoven.native_memory_require(m->>'state'='active' AND s->>'status'='active' AND m#>'{inputs,sources}'=jsonb_build_array(NEW.source_reference)
   AND m#>'{inputs,memories}'='[]'::jsonb AND m#>'{content,title}'=NEW.intent->'title' AND m#>'{content,summary}'=NEW.intent->'text'
   AND m#>'{content,attributes,purpose}'=NEW.intent->'purpose' AND m->'validUntil'=NEW.intent->'reviewBy','NM009');
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER note_operation_integrity BEFORE INSERT ON pactwoven.native_memory_note_operations FOR EACH ROW EXECUTE FUNCTION pactwoven.native_memory_notes_operation_guard();

CREATE FUNCTION pactwoven.native_memory_notes_deadline(ctx jsonb) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 PERFORM pactwoven.native_memory_require(ctx->'validUntil'='null'::jsonb OR pactwoven.native_memory_time(ctx->'validUntil')>clock_timestamp(),'NM008');
END $$;
CREATE FUNCTION pactwoven.native_memory_notes_version(memory_record jsonb,source_record jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT pactwoven.native_memory_hash(jsonb_build_object('namespace','pactwoven/human-memory-edit/v1',
 'memory',pactwoven.native_memory_ref(memory_record),'source',pactwoven.native_memory_ref(source_record,true))) $$;
CREATE FUNCTION pactwoven.native_memory_notes_body(q jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT jsonb_build_object('title',q->'title','text',q->'text','purpose',q->'purpose') $$;
CREATE FUNCTION pactwoven.native_memory_notes_valid(q jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ BEGIN
 IF jsonb_typeof(q) IS DISTINCT FROM 'object' OR NOT pactwoven.native_memory_id(q->'siteId') OR octet_length(q::text)>65536 THEN RETURN false;END IF;
 IF q->>'kind'='remember' THEN
  IF NOT pactwoven.native_memory_object(q,ARRAY['kind','siteId','title','text','purpose','reviewBy']) THEN RETURN false;END IF;
 ELSIF q->>'kind'='correct' THEN
  IF NOT pactwoven.native_memory_object(q,ARRAY['kind','siteId','noteId','expected','title','text','purpose','reviewBy']) THEN RETURN false;END IF;
 ELSIF q->>'kind'='remove' THEN
  IF NOT pactwoven.native_memory_object(q,ARRAY['kind','siteId','noteId','expected']) THEN RETURN false;END IF;
 ELSE RETURN false;END IF;
 IF q->>'kind'<>'remember' AND(NOT pactwoven.native_memory_id(q->'noteId') OR coalesce(q->>'expected','') !~ '^[a-f0-9]{64}$') THEN RETURN false;END IF;
 IF q->>'kind'<>'remove' THEN
  IF NOT pactwoven.native_memory_text(q->'title',1,180) OR NOT pactwoven.native_memory_text(q->'text',1,8000)
   OR NOT pactwoven.native_memory_text(q->'purpose',1,1000) OR pactwoven.native_memory_time(q->'reviewBy') IS NULL THEN RETURN false;END IF;
  IF EXISTS(SELECT 1 FROM unnest(ARRAY[q->>'title',q->>'text',q->>'purpose']) v WHERE v ~ U&'^[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]*$') THEN RETURN false;END IF;
 END IF;RETURN true;
END $$;

-- Maintenance projection intentionally allows the author to inspect expired or
-- conflicted current data. It is never an agent retrieval/eligibility receipt.
CREATE FUNCTION pactwoven.native_memory_notes_project_locked(ctx jsonb,p_id text) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE n pactwoven.native_memory_notes;m jsonb;s jsonb;status text;writable boolean;site_name text;person text;matching_human boolean;source_label text;BEGIN
 SELECT * INTO n FROM pactwoven.native_memory_notes WHERE(environment,organization_id,site_id,id,actor_id)=
  (ctx->>'environment',ctx->>'organizationId',ctx->>'siteId',p_id,ctx->>'actorId');
 IF NOT FOUND THEN RETURN NULL;END IF;
 SELECT v.record INTO m FROM pactwoven.native_memory_heads h JOIN pactwoven.native_memory_revisions v USING(environment,organization_id,site_id,memory_id,revision,digest)
  WHERE(h.environment,h.organization_id,h.site_id,h.memory_id)=(n.environment,n.organization_id,n.site_id,n.memory_id);
 SELECT v.record INTO s FROM pactwoven.native_memory_source_heads h JOIN pactwoven.native_memory_source_revisions v USING(environment,organization_id,site_id,source_id,revision,digest)
  WHERE(h.environment,h.organization_id,h.site_id,h.source_id)=(n.environment,n.organization_id,n.site_id,n.source_id);
 PERFORM pactwoven.native_memory_require(m IS NOT NULL AND s IS NOT NULL,'NM009');
 -- Mapping ownership controls maintenance access, not authorship of later
 -- revisions admitted through the scoped low-level memory/source writers.
 matching_human:=coalesce(m#>>'{provenance,kind}'='user' AND s#>>'{provenance,kind}'='user'
  AND m->'provenance'=s->'provenance' AND s->>'kind'='user_statement' AND s->>'verification'='unverified',false);
 source_label:=CASE WHEN matching_human THEN 'Human statement — not independently verified' ELSE 'Source attribution needs review' END;
 IF m->>'state'='tombstone' OR s->>'status'<>'active' THEN status:='removed';
 ELSE
  IF NOT coalesce(m#>'{access,readers}' @> jsonb_build_array(ctx->'reader') AND s#>'{access,readers}' @> jsonb_build_array(ctx->'reader'),false) THEN RETURN NULL;END IF;
  status:=CASE WHEN m->>'conflict'='clear' AND s->>'conflict'='clear' AND pactwoven.native_memory_time(m->'validFrom')<=clock_timestamp()
    AND pactwoven.native_memory_time(s->'validFrom')<=clock_timestamp() AND pactwoven.native_memory_time(m->'validUntil')>clock_timestamp()
    AND pactwoven.native_memory_time(s->'validUntil')>clock_timestamp() AND m#>'{inputs,sources}'=jsonb_build_array(pactwoven.native_memory_ref(s,true))
    AND m#>'{inputs,memories}'='[]'::jsonb AND matching_human
    AND s->>'contentDigest'=pactwoven.native_memory_hash(jsonb_build_object('namespace','pactwoven/human-memory-statement/v1','body',
      jsonb_build_object('title',m#>'{content,title}','text',m#>'{content,summary}','purpose',m#>'{content,attributes,purpose}')))
    THEN 'available' ELSE 'needs_review' END;
 END IF;
 SELECT left(name,180) INTO site_name FROM pactwoven.sites WHERE(environment,organization_id,id)=(n.environment,n.organization_id,n.site_id);
 IF matching_human THEN
  SELECT left(nullif(btrim(display_name),''),180) INTO person FROM pactwoven.memberships
   WHERE(environment,organization_id,actor_id)=(n.environment,n.organization_id,m#>>'{provenance,actorId}')
    AND memberships.status='active' AND(expires_at IS NULL OR expires_at>clock_timestamp());
  person:=coalesce(person,'Workspace contributor');
 ELSE
  person:=CASE WHEN m#>>'{provenance,kind}'='user' AND s#>>'{provenance,kind}'='user'
    AND m->'provenance'<>s->'provenance' THEN 'Multiple contributors' ELSE 'Contributor needs review' END;
 END IF;
 writable:=status<>'removed' AND ctx->'roles' ?| ARRAY['owner','operations'] AND EXISTS(SELECT 1 FROM pactwoven.member_action_sites WHERE
  (environment,organization_id,actor_id,site_id)=(n.environment,n.organization_id,n.actor_id,n.site_id));
 PERFORM pactwoven.native_memory_notes_deadline(ctx);
 RETURN jsonb_build_object('id',n.id,'title',CASE WHEN status='removed' THEN 'Removed note' ELSE m#>>'{content,title}' END,'siteName',site_name,'suppliedBy',person,
  'updatedAt',m->'recordedAt','reviewBy',CASE WHEN status='removed' THEN NULL ELSE m->'validUntil' END,'status',status,
  'text',CASE WHEN status='removed' THEN NULL ELSE m#>'{content,summary}' END,'purpose',CASE WHEN status='removed' THEN NULL ELSE m#>'{content,attributes,purpose}' END,
  'editToken',CASE WHEN writable THEN pactwoven.native_memory_notes_version(m,s) ELSE NULL END,
  'sourceLabel',source_label,'usageLabel','For permitted work at this site','removalLabel','Remove from future work','historyRetained',true);
END $$;
CREATE FUNCTION pactwoven.native_memory_notes_get(p_actor jsonb,p_site text,p_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE ctx jsonb;note jsonb;BEGIN
 PERFORM pactwoven.native_memory_require(pactwoven.native_memory_id(to_jsonb(p_site)) AND pactwoven.native_memory_id(to_jsonb(p_id)),'NM004');
 ctx:=pactwoven.native_delegation_actor_locked(p_actor,p_site,false);PERFORM pactwoven.native_memory_lock_scope(ctx,false);
 note:=pactwoven.native_memory_notes_project_locked(ctx,p_id);PERFORM pactwoven.native_memory_require(note IS NOT NULL,'NM002');
 RETURN jsonb_build_object('scope',pactwoven.native_memory_scope(ctx),'note',note);
END $$;
CREATE FUNCTION pactwoven.native_memory_notes_operation_locked(ctx jsonb,op pactwoven.native_memory_note_operations) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 PERFORM pactwoven.native_memory_notes_deadline(ctx);
 RETURN jsonb_build_object('scope',pactwoven.native_memory_scope(ctx),'operationId',op.id,'noteId',op.note_id,'action',op.intent->'kind',
  'committedAt',pactwoven.native_memory_instant(op.committed_at),'current',pactwoven.native_memory_notes_project_locked(ctx,op.note_id));
END $$;
CREATE FUNCTION pactwoven.native_memory_notes_recover(p_actor jsonb,p_site text,p_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE ctx jsonb;op pactwoven.native_memory_note_operations;BEGIN
 PERFORM pactwoven.native_memory_require(pactwoven.native_memory_id(to_jsonb(p_site)) AND p_key ~ '^[A-Za-z0-9_-]{16,128}$','NM004');
 ctx:=pactwoven.native_delegation_actor_locked(p_actor,p_site,false);
 IF NOT EXISTS(SELECT 1 FROM pactwoven.native_memory_scope_fences WHERE(environment,organization_id,site_id)=(ctx->>'environment',ctx->>'organizationId',p_site)) THEN RETURN NULL;END IF;
 PERFORM pactwoven.native_memory_lock_scope(ctx,false);
 SELECT * INTO op FROM pactwoven.native_memory_note_operations WHERE(environment,organization_id,site_id,actor_id,request_key)=
  (ctx->>'environment',ctx->>'organizationId',p_site,ctx->>'actorId',p_key);
 IF NOT FOUND THEN RETURN NULL;END IF;RETURN pactwoven.native_memory_notes_operation_locked(ctx,op);
END $$;
CREATE FUNCTION pactwoven.native_memory_notes_list(p_actor jsonb,q jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE ctx jsonb;n pactwoven.native_memory_notes;note jsonb;items jsonb:='[]';last_row jsonb;more boolean:=false;limit_n integer;scanned integer:=0;BEGIN
 PERFORM pactwoven.native_memory_require(pactwoven.native_memory_object(q,ARRAY['siteId','status','limit','after']) AND pactwoven.native_memory_id(q->'siteId')
  AND q->>'status' IN ('all','available','needs_review','removed') AND pactwoven.native_memory_revision(q->'limit'),'NM004');
 PERFORM pactwoven.native_memory_require((q->>'limit')::bigint BETWEEN 1 AND 50,'NM004');limit_n:=(q->>'limit')::integer;
 PERFORM pactwoven.native_memory_require(q->'after'='null'::jsonb OR(pactwoven.native_memory_object(q->'after',ARRAY['createdAt','id'])
  AND pactwoven.native_memory_time(q#>'{after,createdAt}') IS NOT NULL AND pactwoven.native_memory_id(q#>'{after,id}')), 'NM004');
 ctx:=pactwoven.native_delegation_actor_locked(p_actor,q->>'siteId',false);
 IF EXISTS(SELECT 1 FROM pactwoven.native_memory_scope_fences WHERE(environment,organization_id,site_id)=(ctx->>'environment',ctx->>'organizationId',ctx->>'siteId')) THEN
  PERFORM pactwoven.native_memory_lock_scope(ctx,false);
  FOR n IN SELECT * FROM pactwoven.native_memory_notes WHERE(environment,organization_id,site_id,actor_id)=
   (ctx->>'environment',ctx->>'organizationId',ctx->>'siteId',ctx->>'actorId') AND(q->'after'='null'::jsonb OR
    created_at<pactwoven.native_memory_time(q#>'{after,createdAt}') OR(created_at=pactwoven.native_memory_time(q#>'{after,createdAt}') AND id>q#>>'{after,id}'))
   ORDER BY created_at DESC,id LIMIT 257 LOOP
    IF scanned=256 THEN more:=true;EXIT;END IF;
    note:=pactwoven.native_memory_notes_project_locked(ctx,n.id);
    IF note IS NOT NULL AND(q->>'status'='all' OR q->>'status'=note->>'status') AND jsonb_array_length(items)=limit_n THEN more:=true;EXIT;END IF;
    scanned:=scanned+1;last_row:=jsonb_build_object('createdAt',pactwoven.native_memory_instant(n.created_at),'id',n.id);
    IF note IS NULL OR(q->>'status'<>'all' AND q->>'status'<>note->>'status') THEN CONTINUE;END IF;
    items:=items||jsonb_build_array(note-ARRAY['text','purpose','editToken','sourceLabel','usageLabel','removalLabel','historyRetained']);
  END LOOP;
 END IF;
 PERFORM pactwoven.native_memory_notes_deadline(ctx);
 RETURN jsonb_build_object('scope',pactwoven.native_memory_scope(ctx),'items',items,'next',CASE WHEN more THEN last_row ELSE NULL END);
END $$;

CREATE FUNCTION pactwoven.native_memory_notes_command(p_actor jsonb,p_key text,q jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE ctx jsonb;n pactwoven.native_memory_notes;op pactwoven.native_memory_note_operations;intent_digest text;now_text text;note_id text;source_id text;memory_id text;
 old_m jsonb;old_s jsonb;old_m_ref jsonb;old_s_ref jsonb;new_s jsonb;new_m jsonb;source_result jsonb;memory_result jsonb;readers jsonb;access jsonb;provenance jsonb;body jsonb;source_key text;memory_key text;BEGIN
 PERFORM pactwoven.native_memory_require(p_key ~ '^[A-Za-z0-9_-]{16,128}$' AND pactwoven.native_memory_notes_valid(q),'NM004');
 ctx:=pactwoven.native_delegation_actor_locked(p_actor,q->>'siteId',true);
 -- Serialize a request key even if two concurrent calls name different sites.
 -- This mutex precedes memory scopes and carries no authorization semantics.
 PERFORM pg_advisory_xact_lock(hashtextextended(pactwoven.native_memory_canonical(jsonb_build_array('native-memory-note-request',ctx->'environment',ctx->'organizationId',ctx->'actorId',p_key)),0));
 intent_digest:=pactwoven.native_memory_hash(jsonb_build_object('namespace','pactwoven/human-memory-intent/v1','intent',q));
 PERFORM pactwoven.native_memory_lock_scope(ctx,true);
 SELECT * INTO op FROM pactwoven.native_memory_note_operations WHERE(environment,organization_id,actor_id,request_key)=
  (ctx->>'environment',ctx->>'organizationId',ctx->>'actorId',p_key);
 IF FOUND THEN
  PERFORM pactwoven.native_memory_require(op.site_id=ctx->>'siteId' AND op.intent_digest=intent_digest,'NM003');
  RETURN pactwoven.native_memory_notes_operation_locked(ctx,op);
 END IF;
 now_text:=pactwoven.native_memory_instant(date_trunc('milliseconds',clock_timestamp()));
 provenance:=jsonb_build_object('kind','user','actorId',ctx->>'actorId');
 IF q->>'kind'='remember' THEN
  note_id:=gen_random_uuid()::text;source_id:=gen_random_uuid()::text;memory_id:=gen_random_uuid()::text;
  SELECT jsonb_build_array(ctx->'reader')||coalesce(jsonb_agg(jsonb_build_object('kind','agent','id',service_id) ORDER BY service_id),'[]') INTO readers
   FROM pactwoven.native_delegation_services WHERE environment=ctx->>'environment' AND enabled AND purpose IN ('coordinator','worker');
  PERFORM pactwoven.native_memory_require(jsonb_array_length(readers)<=100,'NM007');
  access:=jsonb_build_object('readers',readers,'purposes',jsonb_build_array('human_review','audit','task_context'));
 ELSE
  note_id:=q->>'noteId';SELECT * INTO n FROM pactwoven.native_memory_notes WHERE(environment,organization_id,site_id,id,actor_id)=
   (ctx->>'environment',ctx->>'organizationId',ctx->>'siteId',note_id,ctx->>'actorId');
  PERFORM pactwoven.native_memory_require(FOUND,'NM002');source_id:=n.source_id;memory_id:=n.memory_id;
  SELECT v.record INTO old_m FROM pactwoven.native_memory_heads h JOIN pactwoven.native_memory_revisions v USING(environment,organization_id,site_id,memory_id,revision,digest)
   WHERE(h.environment,h.organization_id,h.site_id,h.memory_id)=(n.environment,n.organization_id,n.site_id,n.memory_id);
  SELECT v.record INTO old_s FROM pactwoven.native_memory_source_heads h JOIN pactwoven.native_memory_source_revisions v USING(environment,organization_id,site_id,source_id,revision,digest)
   WHERE(h.environment,h.organization_id,h.site_id,h.source_id)=(n.environment,n.organization_id,n.site_id,n.source_id);
  PERFORM pactwoven.native_memory_require(old_m->>'state'='active' AND old_s->>'status'='active' AND q->>'expected'=pactwoven.native_memory_notes_version(old_m,old_s),'NM005');
  PERFORM pactwoven.native_memory_require(old_m#>'{access,readers}' @> jsonb_build_array(ctx->'reader') AND old_s#>'{access,readers}' @> jsonb_build_array(ctx->'reader'),'NM001');
  old_m_ref:=pactwoven.native_memory_ref(old_m);old_s_ref:=pactwoven.native_memory_ref(old_s,true);
  -- Corrections never widen an ACL narrowed through a lower-level source or memory update.
  SELECT jsonb_build_object('readers',(SELECT jsonb_agg(x) FROM jsonb_array_elements(old_m#>'{access,readers}') x WHERE old_s#>'{access,readers}' @> jsonb_build_array(x)),
    'purposes',(SELECT jsonb_agg(x) FROM jsonb_array_elements(old_m#>'{access,purposes}') x WHERE old_s#>'{access,purposes}' @> jsonb_build_array(x))) INTO access;
 END IF;
 source_key:=pactwoven.native_memory_hash(jsonb_build_array('human-note-source',ctx->'environment',ctx->'organizationId',ctx->'actorId',p_key));
 memory_key:=pactwoven.native_memory_hash(jsonb_build_array('human-note-memory',ctx->'environment',ctx->'organizationId',ctx->'actorId',p_key));
 IF q->>'kind'='remove' THEN
  new_s:=old_s||jsonb_build_object('revision',(old_s->>'revision')::bigint+1,'status','deleted','provenance',provenance);
 ELSE
  PERFORM pactwoven.native_memory_require(pactwoven.native_memory_time(q->'reviewBy')>clock_timestamp(),'NM008');body:=pactwoven.native_memory_notes_body(q);
  new_s:=pactwoven.native_memory_scope(ctx)||jsonb_build_object('schemaVersion',1,'sourceId',source_id,'revision',coalesce((old_s->>'revision')::bigint,0)+1,
   'kind','user_statement','status','active','contentDigest',pactwoven.native_memory_hash(jsonb_build_object('namespace','pactwoven/human-memory-statement/v1','body',body)),
   'provenance',provenance,'observedAt',now_text,'validFrom',now_text,'validUntil',q->'reviewBy','access',access,'conflict','clear','verification','unverified');
 END IF;
 -- Reentry uses the identical already locked actor/site/session; no new
 -- authority or site is acquired after the memory fence. Both underlying
 -- public writes, mapping and parent operation remain in this transaction.
 source_result:=pactwoven.native_memory_human_source(p_actor,source_key,jsonb_build_object('kind',CASE WHEN q->>'kind'='remember' THEN 'create' WHEN q->>'kind'='correct' THEN 'correct' ELSE 'delete' END,
  'expected',old_s_ref,'record',new_s));
 IF q->>'kind'='remove' THEN
  new_m:=pactwoven.native_memory_scope(ctx)||jsonb_build_object('schemaVersion',1,'memoryId',memory_id,'revision',(old_m->>'revision')::bigint+1,'previous',old_m_ref,
   'subject',old_m->'subject','key',old_m->'key','recordedAt',now_text,'provenance',provenance,'state','tombstone','reason','deleted');
 ELSE
  new_m:=pactwoven.native_memory_scope(ctx)||jsonb_build_object('schemaVersion',1,'memoryId',memory_id,'revision',coalesce((old_m->>'revision')::bigint,0)+1,'previous',old_m_ref,
   'subject',coalesce(old_m->'subject',jsonb_build_object('kind','preference','id',note_id)),'key','human_note','recordedAt',now_text,'provenance',provenance,'state','active',
   'content',jsonb_build_object('title',q->'title','summary',q->'text','attributes',jsonb_build_object('purpose',q->'purpose')),
   'access',access,'validFrom',now_text,'validUntil',q->'reviewBy','confidence','low','conflict','clear',
   'inputs',jsonb_build_object('sources',jsonb_build_array(source_result->'originalReference'),'memories','[]'::jsonb));
 END IF;
 memory_result:=pactwoven.native_memory_human_mutate(p_actor,memory_key,jsonb_build_object('kind',CASE WHEN q->>'kind'='remember' THEN 'create' WHEN q->>'kind'='correct' THEN 'correct' ELSE 'delete' END,
  'expected',old_m_ref,'record',new_m));
 IF q->>'kind'='remember' THEN INSERT INTO pactwoven.native_memory_notes(environment,organization_id,site_id,id,actor_id,memory_id,source_id)
  VALUES(ctx->>'environment',ctx->>'organizationId',ctx->>'siteId',note_id,ctx->>'actorId',memory_id,source_id);END IF;
 INSERT INTO pactwoven.native_memory_note_operations(environment,organization_id,site_id,actor_id,request_key,note_id,intent,intent_digest,source_reference,memory_reference)
  VALUES(ctx->>'environment',ctx->>'organizationId',ctx->>'siteId',ctx->>'actorId',p_key,note_id,q,intent_digest,source_result->'originalReference',memory_result->'originalReference') RETURNING * INTO op;
 PERFORM pactwoven.native_memory_notes_deadline(ctx);RETURN pactwoven.native_memory_notes_operation_locked(ctx,op);
END $$;

DO $$ DECLARE t text;f record;BEGIN
 FOREACH t IN ARRAY ARRAY['native_memory_notes','native_memory_note_operations'] LOOP
  EXECUTE format('ALTER TABLE pactwoven.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON TABLE pactwoven.%I FROM PUBLIC,pactwoven_runtime,pactwoven_native_task_api,pactwoven_native_task_worker,pactwoven_native_task_dispatcher,pactwoven_native_delegation_api,pactwoven_native_delegation_coordinator,pactwoven_native_delegation_worker,pactwoven_native_delegation_dispatcher',t);
  EXECUTE format('CREATE TRIGGER retain_note_rows BEFORE UPDATE OR DELETE ON pactwoven.%I FOR EACH ROW EXECUTE FUNCTION pactwoven.native_memory_immutable()',t);
  EXECUTE format('CREATE TRIGGER retain_note_table BEFORE TRUNCATE ON pactwoven.%I FOR EACH STATEMENT EXECUTE FUNCTION pactwoven.native_memory_immutable()',t);
 END LOOP;
 FOR f IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='pactwoven' AND p.proname LIKE 'native_memory_notes_%' LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,pactwoven_runtime,pactwoven_native_task_api,pactwoven_native_task_worker,pactwoven_native_task_dispatcher,pactwoven_native_delegation_api,pactwoven_native_delegation_coordinator,pactwoven_native_delegation_worker,pactwoven_native_delegation_dispatcher',f.signature);
 END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION pactwoven.native_memory_notes_list(jsonb,jsonb),pactwoven.native_memory_notes_get(jsonb,text,text),
 pactwoven.native_memory_notes_command(jsonb,text,jsonb),pactwoven.native_memory_notes_recover(jsonb,text,text) TO pactwoven_native_delegation_api;
COMMIT;
