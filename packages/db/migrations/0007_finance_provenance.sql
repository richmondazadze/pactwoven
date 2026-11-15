BEGIN;

DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='pactwoven_finance_observer') THEN
  CREATE ROLE pactwoven_finance_observer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
 END IF;
END $$;
GRANT USAGE ON SCHEMA pactwoven TO pactwoven_finance_observer;

CREATE FUNCTION pactwoven.finance_asset_key(g bytea,p bytea,m bytea) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT encode(sha256(convert_to('pactwoven:solana-asset:v1','UTF8')||decode('00','hex')||g||p||m),'hex')
$$;
CREATE FUNCTION pactwoven.finance_account_key(g bytea,a bytea) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT encode(sha256(convert_to('pactwoven:solana-account:v1','UTF8')||decode('00','hex')||g||a),'hex')
$$;
CREATE FUNCTION pactwoven.finance_u32le(v integer) RETURNS bytea LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT set_byte(set_byte(set_byte(set_byte(decode('00000000','hex'),0,v&255),1,(v>>8)&255),2,(v>>16)&255),3,(v>>24)&255)
$$;
CREATE FUNCTION pactwoven.finance_transfer_key(g bytea,s bytea,o integer,i integer) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT encode(sha256(convert_to('pactwoven:solana-transfer:v1','UTF8')||decode('00','hex')||g||s||pactwoven.finance_u32le(o)||
 CASE WHEN i IS NULL THEN decode('00','hex') ELSE decode('01','hex')||pactwoven.finance_u32le(i) END),'hex')
$$;
CREATE FUNCTION pactwoven.finance_effect_key(t text,a text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT encode(sha256(convert_to('pactwoven:solana-account-effect:v1','UTF8')||decode('00','hex')||decode(t,'hex')||decode(a,'hex')),'hex')
$$;
CREATE FUNCTION pactwoven.finance_base58(value text,size integer) RETURNS bytea LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE alphabet constant text:='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'; n numeric:=0; digit integer; zeros integer:=0; result bytea:=''::bytea; j integer;
BEGIN
 IF value IS NULL OR size NOT IN (32,64) OR length(value) NOT BETWEEN 1 AND (CASE WHEN size=32 THEN 44 ELSE 88 END) THEN RAISE EXCEPTION USING ERRCODE='PF004',MESSAGE='Invalid physical identity'; END IF;
 FOR j IN 1..length(value) LOOP digit:=strpos(alphabet,substr(value,j,1))-1; IF digit<0 THEN RAISE EXCEPTION USING ERRCODE='PF004',MESSAGE='Invalid base58 identity'; END IF; n:=n*58+digit; END LOOP;
 WHILE substr(value,zeros+1,1)='1' LOOP zeros:=zeros+1; END LOOP;
 WHILE n>0 LOOP result:=set_byte(decode('00','hex'),0,mod(n,256)::integer)||result; n:=div(n,256); END LOOP;
 result:=decode(repeat('00',zeros),'hex')||result;
 IF octet_length(result)<>size THEN RAISE EXCEPTION USING ERRCODE='PF004',MESSAGE='Noncanonical physical identity'; END IF;
 RETURN result;
END $$;
CREATE FUNCTION pactwoven.finance_canonical(value jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE result text;
BEGIN
 CASE jsonb_typeof(value)
 WHEN 'object' THEN SELECT '{'||coalesce(string_agg(to_jsonb(key)::text||':'||pactwoven.finance_canonical(val),',' ORDER BY key COLLATE "C"),'')||'}' INTO result FROM jsonb_each(value) fields(key,val); RETURN result;
 WHEN 'array' THEN SELECT '['||coalesce(string_agg(pactwoven.finance_canonical(val),',' ORDER BY ord),'')||']' INTO result FROM jsonb_array_elements(value) WITH ORDINALITY items(val,ord); RETURN result;
 WHEN 'number' THEN RETURN trim_scale((value::text)::numeric)::text;
 WHEN 'string','boolean','null' THEN RETURN value::text;
 ELSE RAISE EXCEPTION USING ERRCODE='PF004',MESSAGE='Invalid canonical evidence'; END CASE;
END $$;
CREATE FUNCTION pactwoven.finance_hash(value jsonb) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT encode(sha256(convert_to(pactwoven.finance_canonical(value),'UTF8')),'hex')
$$;

CREATE TABLE pactwoven.finance_physical_assets (
 genesis bytea NOT NULL CHECK(octet_length(genesis)=32), token_program bytea NOT NULL CHECK(octet_length(token_program)=32), mint bytea NOT NULL CHECK(octet_length(mint)=32),
 asset_key text GENERATED ALWAYS AS(pactwoven.finance_asset_key(genesis,token_program,mint)) STORED PRIMARY KEY,
 UNIQUE(genesis,token_program,mint)
);
CREATE TABLE pactwoven.finance_asset_versions (
 asset_key text NOT NULL REFERENCES pactwoven.finance_physical_assets(asset_key), version integer NOT NULL CHECK(version>0),
 policy text NOT NULL CHECK(policy='solana-original-devnet-usdc-v1'), decimals integer NOT NULL CHECK(decimals=6),
 policy_hash text NOT NULL CHECK(policy_hash~'^[a-f0-9]{64}$'), verifier_version text NOT NULL CHECK(verifier_version~'^[A-Za-z0-9_-]{1,128}$'),
 evidence jsonb NOT NULL CHECK(jsonb_typeof(evidence)='array' AND jsonb_array_length(evidence)<=16), PRIMARY KEY(asset_key,version)
);
CREATE TABLE pactwoven.finance_asset_controls (
 asset_key text PRIMARY KEY, current_version integer NOT NULL, accepts_observations boolean NOT NULL DEFAULT false, revoked_at timestamptz,
 FOREIGN KEY(asset_key,current_version) REFERENCES pactwoven.finance_asset_versions(asset_key,version)
);
CREATE TABLE pactwoven.finance_physical_accounts (
 genesis bytea NOT NULL CHECK(octet_length(genesis)=32), address bytea NOT NULL CHECK(octet_length(address)=32),
 account_key text GENERATED ALWAYS AS(pactwoven.finance_account_key(genesis,address)) STORED PRIMARY KEY,
 environment text NOT NULL, organization_id text NOT NULL, UNIQUE(genesis,address), UNIQUE(account_key,environment,organization_id),
 FOREIGN KEY(environment,organization_id) REFERENCES pactwoven.organizations(environment,id)
);
CREATE TABLE pactwoven.finance_account_versions (
 account_key text NOT NULL REFERENCES pactwoven.finance_physical_accounts(account_key), version integer NOT NULL CHECK(version>0),
 asset_key text NOT NULL REFERENCES pactwoven.finance_physical_assets(asset_key), expected_authority bytea NOT NULL CHECK(octet_length(expected_authority)=32),
 policy_hash text NOT NULL CHECK(policy_hash~'^[a-f0-9]{64}$'), verifier_version text NOT NULL CHECK(verifier_version~'^[A-Za-z0-9_-]{1,128}$'),
 evidence jsonb NOT NULL CHECK(jsonb_typeof(evidence)='array' AND jsonb_array_length(evidence)<=16), incarnation_evidence jsonb,
 PRIMARY KEY(account_key,version)
);
CREATE TABLE pactwoven.finance_account_controls (
 account_key text PRIMARY KEY, current_version integer NOT NULL, accepts_observations boolean NOT NULL DEFAULT false, revoked_at timestamptz,
 FOREIGN KEY(account_key,current_version) REFERENCES pactwoven.finance_account_versions(account_key,version)
);
CREATE TABLE pactwoven.finance_sources (
 source_id text PRIMARY KEY CHECK(source_id~'^[A-Za-z0-9_-]{1,128}$'), environment text NOT NULL, organization_id text NOT NULL,
 UNIQUE(source_id,environment,organization_id), FOREIGN KEY(environment,organization_id) REFERENCES pactwoven.organizations(environment,id)
);
CREATE TABLE pactwoven.finance_source_versions (
 source_id text NOT NULL REFERENCES pactwoven.finance_sources(source_id), version integer NOT NULL CHECK(version>0),
 endpoint_configuration_hash text NOT NULL CHECK(endpoint_configuration_hash~'^[a-f0-9]{64}$'),
 adapter_version text NOT NULL CHECK(adapter_version~'^[A-Za-z0-9_-]{1,128}$'), normalizer_version text NOT NULL CHECK(normalizer_version~'^[A-Za-z0-9_-]{1,128}$'),
 policy_hash text NOT NULL CHECK(policy_hash~'^[a-f0-9]{64}$'), verifier_version text NOT NULL CHECK(verifier_version~'^[A-Za-z0-9_-]{1,128}$'),
 evidence jsonb NOT NULL CHECK(jsonb_typeof(evidence)='array' AND jsonb_array_length(evidence)<=16), PRIMARY KEY(source_id,version)
);
CREATE TABLE pactwoven.finance_source_controls (
 source_id text PRIMARY KEY, current_version integer NOT NULL, accepts_observations boolean NOT NULL DEFAULT false, revoked_at timestamptz,
 FOREIGN KEY(source_id,current_version) REFERENCES pactwoven.finance_source_versions(source_id,version)
);
CREATE TABLE pactwoven.finance_source_bindings (
 source_id text NOT NULL, account_key text NOT NULL, environment text NOT NULL, organization_id text NOT NULL,
 principal_oid oid NOT NULL CHECK(principal_oid<>0), principal_name text NOT NULL CHECK(length(principal_name) BETWEEN 1 AND 63),
 accepts_observations boolean NOT NULL DEFAULT false, revoked_at timestamptz, PRIMARY KEY(source_id,account_key),
 FOREIGN KEY(source_id,environment,organization_id) REFERENCES pactwoven.finance_sources(source_id,environment,organization_id),
 FOREIGN KEY(account_key,environment,organization_id) REFERENCES pactwoven.finance_physical_accounts(account_key,environment,organization_id)
);
CREATE TABLE pactwoven.finance_transfer_facts (
 genesis bytea NOT NULL CHECK(octet_length(genesis)=32), signature bytea NOT NULL CHECK(octet_length(signature)=64),
 outer_index integer NOT NULL CHECK(outer_index BETWEEN 0 AND 65534), inner_index integer CHECK(inner_index BETWEEN 0 AND 65534),
 transfer_key text GENERATED ALWAYS AS(pactwoven.finance_transfer_key(genesis,signature,outer_index,inner_index)) STORED PRIMARY KEY,
 asset_key text NOT NULL REFERENCES pactwoven.finance_physical_assets(asset_key), fact jsonb NOT NULL,
 fact_hash text GENERATED ALWAYS AS(pactwoven.finance_hash(fact)) STORED,
 UNIQUE NULLS NOT DISTINCT(genesis,signature,outer_index,inner_index), UNIQUE(transfer_key,asset_key)
);
CREATE TABLE pactwoven.finance_account_effects (
 transfer_key text NOT NULL, account_key text NOT NULL REFERENCES pactwoven.finance_physical_accounts(account_key),
 effect_key text GENERATED ALWAYS AS(pactwoven.finance_effect_key(transfer_key,account_key)) STORED PRIMARY KEY,
 asset_key text NOT NULL, direction text NOT NULL CHECK(direction IN ('incoming','outgoing','self')),
 UNIQUE(transfer_key,account_key), FOREIGN KEY(transfer_key,asset_key) REFERENCES pactwoven.finance_transfer_facts(transfer_key,asset_key)
);
CREATE TABLE pactwoven.finance_deliveries (
 receipt_id uuid PRIMARY KEY, source_id text NOT NULL, account_key text NOT NULL, delivery_key text NOT NULL CHECK(length(delivery_key) BETWEEN 1 AND 256 AND delivery_key~'^[A-Za-z0-9._:/-]+$'),
 source_version integer NOT NULL, account_version integer NOT NULL, asset_key text NOT NULL, asset_version integer NOT NULL,
 payload bytea NOT NULL CHECK(octet_length(payload) BETWEEN 1 AND 131072), payload_hash text GENERATED ALWAYS AS(encode(sha256(payload),'hex')) STORED,
 input jsonb NOT NULL, input_hash text GENERATED ALWAYS AS(pactwoven.finance_hash(input)) STORED,
 received_at timestamptz NOT NULL, receipt jsonb NOT NULL, UNIQUE(source_id,account_key,delivery_key),
 FOREIGN KEY(source_id,account_key) REFERENCES pactwoven.finance_source_bindings(source_id,account_key),
 FOREIGN KEY(source_id,source_version) REFERENCES pactwoven.finance_source_versions(source_id,version),
 FOREIGN KEY(account_key,account_version) REFERENCES pactwoven.finance_account_versions(account_key,version),
 FOREIGN KEY(asset_key,asset_version) REFERENCES pactwoven.finance_asset_versions(asset_key,version)
);
CREATE TABLE pactwoven.finance_observation_links (
 receipt_id uuid PRIMARY KEY REFERENCES pactwoven.finance_deliveries(receipt_id), effect_key text NOT NULL REFERENCES pactwoven.finance_account_effects(effect_key)
);
CREATE TABLE pactwoven.finance_provenance_conflicts (
 conflict_id uuid PRIMARY KEY, source_id text NOT NULL, account_key text NOT NULL, delivery_key text NOT NULL,
 attempt_hash text NOT NULL CHECK(attempt_hash~'^[a-f0-9]{64}$'), original_receipt_id uuid NOT NULL REFERENCES pactwoven.finance_deliveries(receipt_id),
 reason text NOT NULL CHECK(reason IN ('DELIVERY_REUSE','TRANSFER_FACT_CONFLICT')), payload bytea NOT NULL CHECK(octet_length(payload) BETWEEN 1 AND 131072),
 input jsonb NOT NULL, received_at timestamptz NOT NULL, receipt jsonb NOT NULL,
 UNIQUE(source_id,account_key,delivery_key,attempt_hash), FOREIGN KEY(source_id,account_key) REFERENCES pactwoven.finance_source_bindings(source_id,account_key)
);

CREATE FUNCTION pactwoven.finance_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION USING ERRCODE='PF007',MESSAGE='Provenance history and physical bindings are immutable'; END $$;
CREATE FUNCTION pactwoven.finance_control_update() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF (to_jsonb(NEW)-ARRAY['current_version','accepts_observations','revoked_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['current_version','accepts_observations','revoked_at'])
  OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)
  OR (to_jsonb(NEW)->>'current_version')::integer<(to_jsonb(OLD)->>'current_version')::integer THEN
  RAISE EXCEPTION USING ERRCODE='PF007',MESSAGE='Physical binding and revocation cannot be reassigned'; END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE item text; BEGIN
 FOREACH item IN ARRAY ARRAY['finance_physical_assets','finance_asset_versions','finance_asset_controls','finance_physical_accounts','finance_account_versions','finance_account_controls','finance_sources','finance_source_versions','finance_source_controls','finance_source_bindings','finance_transfer_facts','finance_account_effects','finance_deliveries','finance_observation_links','finance_provenance_conflicts'] LOOP
  EXECUTE format('ALTER TABLE pactwoven.%I ENABLE ROW LEVEL SECURITY',item);
  EXECUTE format('REVOKE ALL ON pactwoven.%I FROM PUBLIC,pactwoven_runtime,pactwoven_provisioner,pactwoven_access_provisioner,pactwoven_mandate_writer,pactwoven_finance_observer',item);
  EXECUTE format('CREATE TRIGGER finance_no_truncate BEFORE TRUNCATE ON pactwoven.%I FOR EACH STATEMENT EXECUTE FUNCTION pactwoven.finance_immutable()',item);
  IF item IN ('finance_asset_controls','finance_account_controls','finance_source_controls','finance_source_bindings') THEN
   EXECUTE format('CREATE TRIGGER finance_no_delete BEFORE DELETE ON pactwoven.%I FOR EACH ROW EXECUTE FUNCTION pactwoven.finance_immutable()',item);
   EXECUTE format('CREATE TRIGGER finance_control_update BEFORE UPDATE ON pactwoven.%I FOR EACH ROW EXECUTE FUNCTION pactwoven.finance_control_update()',item);
  ELSE
   EXECUTE format('CREATE TRIGGER finance_no_change BEFORE UPDATE OR DELETE ON pactwoven.%I FOR EACH ROW EXECUTE FUNCTION pactwoven.finance_immutable()',item);
  END IF;
 END LOOP;
END $$;

CREATE FUNCTION pactwoven.finance_object(value jsonb,keys text[]) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT coalesce(jsonb_typeof(value)='object' AND value ?& keys AND value-keys='{}'::jsonb,false)
$$;
CREATE FUNCTION pactwoven.finance_evidence(value jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT pactwoven.finance_object(value,ARRAY['reference','sha256']) AND jsonb_typeof(value->'reference')='string' AND length(value->>'reference') BETWEEN 1 AND 512 AND jsonb_typeof(value->'sha256')='string' AND value->>'sha256'~'^[a-f0-9]{64}$'
$$;
CREATE FUNCTION pactwoven.finance_version(value jsonb) RETURNS integer LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
BEGIN
 IF jsonb_typeof(value) IS DISTINCT FROM 'number' OR value::text !~ '^[1-9][0-9]{0,9}$' OR (value::text)::numeric>2147483647 THEN RAISE EXCEPTION USING ERRCODE='PF004',MESSAGE='Bounded registry version required'; END IF;
 RETURN (value::text)::integer;
END $$;
CREATE FUNCTION pactwoven.finance_units(value jsonb) RETURNS numeric LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
BEGIN
 IF jsonb_typeof(value) IS DISTINCT FROM 'string' OR (value#>>'{}') !~ '^(0|[1-9][0-9]{0,19})$' OR (value#>>'{}')::numeric>18446744073709551615 THEN RAISE EXCEPTION USING ERRCODE='PF004',MESSAGE='Canonical u64 amount required'; END IF;
 RETURN (value#>>'{}')::numeric;
END $$;
CREATE FUNCTION pactwoven.finance_locator(value jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE o integer; i integer;
BEGIN
 IF NOT pactwoven.finance_object(value,ARRAY['genesis','signature','outerInstructionIndex','innerInstructionOrdinal']) OR jsonb_typeof(value->'genesis') IS DISTINCT FROM 'string' OR jsonb_typeof(value->'signature') IS DISTINCT FROM 'string'
  OR jsonb_typeof(value->'outerInstructionIndex') IS DISTINCT FROM 'number' OR value->>'outerInstructionIndex'!~'^(0|[1-9][0-9]{0,4})$' THEN RAISE EXCEPTION USING ERRCODE='PF004',MESSAGE='Exact transfer locator required'; END IF;
 o:=(value->>'outerInstructionIndex')::integer;
 IF value->'innerInstructionOrdinal'<>'null'::jsonb THEN
  IF jsonb_typeof(value->'innerInstructionOrdinal') IS DISTINCT FROM 'number' OR value->>'innerInstructionOrdinal'!~'^(0|[1-9][0-9]{0,4})$' THEN RAISE EXCEPTION USING ERRCODE='PF004',MESSAGE='Original inner instruction position required'; END IF;
  i:=(value->>'innerInstructionOrdinal')::integer;
 END IF;
 IF o>65534 OR i>65534 THEN RAISE EXCEPTION USING ERRCODE='PF004',MESSAGE='Unsupported instruction position'; END IF;
 RETURN pactwoven.finance_transfer_key(pactwoven.finance_base58(value->>'genesis',32),pactwoven.finance_base58(value->>'signature',64),o,i);
END $$;
CREATE FUNCTION pactwoven.finance_validate_input(value jsonb) RETURNS void LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE observation jsonb; context jsonb; fact jsonb; execution jsonb; raw bytea; amount numeric:=0; j integer; kind text;
BEGIN
 IF value IS NULL OR octet_length(value::text)>300000 OR NOT pactwoven.finance_object(value,ARRAY['schemaVersion','source','account','asset','deliveryKey','adapterVersion','normalizerVersion','payloadHex','payloadHash','evidence','providerMetadata','observation'])
  OR value->'schemaVersion' IS DISTINCT FROM '1'::jsonb OR NOT pactwoven.finance_object(value->'source',ARRAY['id','version'])
  OR NOT pactwoven.finance_object(value->'account',ARRAY['key','version']) OR NOT pactwoven.finance_object(value->'asset',ARRAY['key','version'])
  OR jsonb_typeof(value->'source'->'id') IS DISTINCT FROM 'string' OR value->'source'->>'id'!~'^[A-Za-z0-9_-]{1,128}$'
  OR jsonb_typeof(value->'account'->'key') IS DISTINCT FROM 'string' OR value->'account'->>'key'!~'^[a-f0-9]{64}$'
  OR jsonb_typeof(value->'asset'->'key') IS DISTINCT FROM 'string' OR value->'asset'->>'key'!~'^[a-f0-9]{64}$'
  OR jsonb_typeof(value->'deliveryKey') IS DISTINCT FROM 'string' OR length(value->>'deliveryKey') NOT BETWEEN 1 AND 256 OR value->>'deliveryKey'!~'^[A-Za-z0-9._:/-]+$'
  OR jsonb_typeof(value->'adapterVersion') IS DISTINCT FROM 'string' OR value->>'adapterVersion'!~'^[A-Za-z0-9_-]{1,128}$'
  OR jsonb_typeof(value->'normalizerVersion') IS DISTINCT FROM 'string' OR value->>'normalizerVersion'!~'^[A-Za-z0-9_-]{1,128}$'
  OR jsonb_typeof(value->'payloadHex') IS DISTINCT FROM 'string' OR length(value->>'payloadHex') NOT BETWEEN 2 AND 262144 OR value->>'payloadHex'!~'^(?:[0-9a-f]{2})+$'
  OR jsonb_typeof(value->'payloadHash') IS DISTINCT FROM 'string' OR value->>'payloadHash'!~'^[a-f0-9]{64}$'
  OR pactwoven.finance_evidence(value->'evidence') IS NOT TRUE OR jsonb_typeof(value->'providerMetadata') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION USING ERRCODE='PF004',MESSAGE='Exact bounded provenance delivery required'; END IF;
 IF (SELECT count(*) FROM jsonb_each(value->'providerMetadata'))>16 OR EXISTS(SELECT 1 FROM jsonb_each(value->'providerMetadata') f WHERE length(f.key) NOT BETWEEN 1 AND 64 OR f.key!~'^[A-Za-z0-9_.:-]+$' OR jsonb_typeof(f.value)<>'string' OR length(f.value#>>'{}')>512) THEN RAISE EXCEPTION USING ERRCODE='PF004',MESSAGE='Bounded source metadata required'; END IF;
 PERFORM pactwoven.finance_version(value->'source'->'version'); PERFORM pactwoven.finance_version(value->'account'->'version'); PERFORM pactwoven.finance_version(value->'asset'->'version');
 IF encode(sha256(decode(value->>'payloadHex','hex')),'hex')<>value->>'payloadHash' THEN RAISE EXCEPTION USING ERRCODE='PF004',MESSAGE='Delivery byte digest differs'; END IF;
 observation:=value->'observation'; context:=observation->'context'; kind:=observation->>'kind';
 IF kind='raw' THEN
  IF NOT pactwoven.finance_object(observation,ARRAY['kind','reason','detail']) OR jsonb_typeof(observation->'reason') IS DISTINCT FROM 'string'
   OR observation->>'reason' NOT IN ('unparsed','unsupported','source_error') OR jsonb_typeof(observation->'detail') IS DISTINCT FROM 'string' OR length(observation->>'detail')>512 THEN
   RAISE EXCEPTION USING ERRCODE='PF004',MESSAGE='Explicit unparsed evidence reason required'; END IF;
  RETURN;
 END IF;
 IF NOT pactwoven.finance_object(context,ARRAY['observedAt','slot','commitment','blockHash','evidence']) OR jsonb_typeof(context->'observedAt') IS DISTINCT FROM 'string'
  OR length(context->>'observedAt') NOT BETWEEN 20 AND 40 OR context->>'observedAt'!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
  OR jsonb_typeof(context->'commitment') IS DISTINCT FROM 'string' OR context->>'commitment' NOT IN ('processed','confirmed','finalized')
  OR pactwoven.finance_evidence(context->'evidence') IS NOT TRUE THEN RAISE EXCEPTION USING ERRCODE='PF004',MESSAGE='Exact observation context required'; END IF;
 PERFORM (context->>'observedAt')::timestamptz; PERFORM pactwoven.finance_units(context->'slot');
 IF context->'blockHash'<>'null'::jsonb THEN IF jsonb_typeof(context->'blockHash') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION USING ERRCODE='PF004',MESSAGE='Block identity required'; END IF; PERFORM pactwoven.finance_base58(context->>'blockHash',32); END IF;
 IF kind='balance' THEN
  IF NOT pactwoven.finance_object(observation,ARRAY['kind','context','amountBaseUnits','accountDataHex']) OR jsonb_typeof(observation->'accountDataHex') IS DISTINCT FROM 'string' OR length(observation->>'accountDataHex')<>330 OR observation->>'accountDataHex'!~'^[0-9a-f]+$' THEN RAISE EXCEPTION USING ERRCODE='PF004',MESSAGE='Exact standard token account bytes required'; END IF;
  raw:=decode(observation->>'accountDataHex','hex'); FOR j IN REVERSE 7..0 LOOP amount:=amount*256+get_byte(raw,64+j); END LOOP;
  IF amount<>pactwoven.finance_units(observation->'amountBaseUnits') OR substring(raw FROM 1 FOR 32)<>pactwoven.finance_base58('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',32)
   OR get_byte(raw,108)>2 OR substring(raw FROM 73 FOR 4) NOT IN (decode('00000000','hex'),decode('01000000','hex'))
   OR substring(raw FROM 110 FOR 4) NOT IN (decode('00000000','hex'),decode('01000000','hex')) OR substring(raw FROM 130 FOR 4) NOT IN (decode('00000000','hex'),decode('01000000','hex')) THEN RAISE EXCEPTION USING ERRCODE='PF004',MESSAGE='Token account bytes and balance differ'; END IF;
 ELSIF kind='transfer' THEN
  IF NOT pactwoven.finance_object(observation,ARRAY['kind','context','fact','execution']) THEN RAISE EXCEPTION USING ERRCODE='PF004',MESSAGE='Transfer evidence required'; END IF;
  fact:=observation->'fact'; execution:=observation->'execution';
  IF NOT pactwoven.finance_object(fact,ARRAY['locator','asset','source','destination','amountBaseUnits','instructionKind','checkedDecimals','instructionDataHash']) OR NOT pactwoven.finance_object(fact->'asset',ARRAY['genesis','tokenProgram','mint'])
   OR fact->'asset' IS DISTINCT FROM jsonb_build_object('genesis','EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG','tokenProgram','TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA','mint','4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU')
   OR fact->'locator'->'genesis' IS DISTINCT FROM fact->'asset'->'genesis' OR jsonb_typeof(fact->'source') IS DISTINCT FROM 'string' OR jsonb_typeof(fact->'destination') IS DISTINCT FROM 'string'
   OR jsonb_typeof(fact->'instructionDataHash') IS DISTINCT FROM 'string' OR fact->>'instructionDataHash'!~'^[a-f0-9]{64}$'
   OR jsonb_typeof(fact->'instructionKind') IS DISTINCT FROM 'string' OR NOT((fact->>'instructionKind'='Transfer' AND fact->'checkedDecimals'='null'::jsonb) OR(fact->>'instructionKind'='TransferChecked' AND fact->'checkedDecimals'='6'::jsonb))
   OR NOT pactwoven.finance_object(execution,ARRAY['transaction','invocation','evidence','outerInstructionCount','innerInstructionCount','stackHeight'])
   OR execution->'transaction' IS DISTINCT FROM '"succeeded"'::jsonb OR execution->'invocation' IS DISTINCT FROM '"succeeded"'::jsonb OR pactwoven.finance_evidence(execution->'evidence') IS NOT TRUE THEN RAISE EXCEPTION USING ERRCODE='PF004',MESSAGE='Exact inert transfer evidence required'; END IF;
  PERFORM pactwoven.finance_locator(fact->'locator'); PERFORM pactwoven.finance_base58(fact->>'source',32); PERFORM pactwoven.finance_base58(fact->>'destination',32); PERFORM pactwoven.finance_units(fact->'amountBaseUnits');
  IF jsonb_typeof(execution->'outerInstructionCount') IS DISTINCT FROM 'number' OR execution->>'outerInstructionCount'!~'^[1-9][0-9]{0,4}$'
   OR jsonb_typeof(execution->'innerInstructionCount') IS DISTINCT FROM 'number' OR execution->>'innerInstructionCount'!~'^(0|[1-9][0-9]{0,4})$'
   OR(execution->>'outerInstructionCount')::integer>65535 OR(execution->>'innerInstructionCount')::integer>65535
   OR(fact->'locator'->>'outerInstructionIndex')::integer>=(execution->>'outerInstructionCount')::integer
   OR(fact->'locator'->>'innerInstructionOrdinal')::integer>=(execution->>'innerInstructionCount')::integer THEN RAISE EXCEPTION USING ERRCODE='PF004',MESSAGE='Original instruction array positions required'; END IF;
  IF execution->'stackHeight'<>'null'::jsonb AND(jsonb_typeof(execution->'stackHeight') IS DISTINCT FROM 'number' OR execution->>'stackHeight'!~'^[1-9][0-9]?$' OR(execution->>'stackHeight')::integer>64) THEN RAISE EXCEPTION USING ERRCODE='PF004',MESSAGE='Invalid stack height'; END IF;
 ELSIF kind='finality' THEN
  IF NOT pactwoven.finance_object(observation,ARRAY['kind','context','locator','transactionStatus']) OR observation->'locator'->>'genesis' IS DISTINCT FROM 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG' OR jsonb_typeof(observation->'transactionStatus') IS DISTINCT FROM 'string' OR observation->>'transactionStatus' NOT IN ('succeeded','failed','unknown') THEN RAISE EXCEPTION USING ERRCODE='PF004',MESSAGE='Exact finality observation required'; END IF;
  PERFORM pactwoven.finance_locator(observation->'locator');
 ELSIF kind='transaction' THEN
  IF NOT pactwoven.finance_object(observation,ARRAY['kind','context','genesis','signature','transactionStatus','transactionVersion','executionEvidence']) OR observation->>'genesis' IS DISTINCT FROM 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'
   OR jsonb_typeof(observation->'signature') IS DISTINCT FROM 'string' OR jsonb_typeof(observation->'transactionStatus') IS DISTINCT FROM 'string' OR observation->>'transactionStatus' NOT IN ('succeeded','failed','unknown')
   OR observation->'transactionVersion' NOT IN ('"legacy"'::jsonb,'0'::jsonb) OR pactwoven.finance_evidence(observation->'executionEvidence') IS NOT TRUE THEN RAISE EXCEPTION USING ERRCODE='PF004',MESSAGE='Exact transaction observation required'; END IF;
  PERFORM pactwoven.finance_base58(observation->>'signature',64);
 ELSE RAISE EXCEPTION USING ERRCODE='PF004',MESSAGE='Unsupported observation kind'; END IF;
END $$;

CREATE FUNCTION pactwoven.finance_principal() RETURNS oid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE principal oid; safe boolean;
BEGIN
 IF current_setting('role')<>'none' OR current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION USING ERRCODE='PF001',MESSAGE='Original isolated observer login and READ COMMITTED required'; END IF;
 SELECT oid INTO principal FROM pg_roles WHERE rolname=SESSION_USER AND rolcanlogin;
 WITH RECURSIVE reachable(oid) AS(SELECT principal UNION SELECT m.roleid FROM pg_auth_members m JOIN reachable r ON r.oid=m.member)
 SELECT principal IS NOT NULL AND pg_has_role(principal,'pactwoven_finance_observer','USAGE') AND NOT EXISTS(SELECT 1 FROM reachable r JOIN pg_roles p ON p.oid=r.oid WHERE p.rolsuper OR p.rolbypassrls OR p.rolcreatedb OR p.rolcreaterole OR p.rolreplication OR p.rolname IN ('pactwoven_runtime','pactwoven_provisioner','pactwoven_access_provisioner','pactwoven_mandate_writer')) INTO safe;
 IF safe IS NOT TRUE THEN RAISE EXCEPTION USING ERRCODE='PF001',MESSAGE='Source-bound observer login required'; END IF;
 RETURN principal;
END $$;
CREATE FUNCTION pactwoven.append_finance_provenance(p_input jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='3s' AS $$
DECLARE principal oid; binding pactwoven.finance_source_bindings%ROWTYPE; asset pactwoven.finance_physical_assets%ROWTYPE; account pactwoven.finance_physical_accounts%ROWTYPE;
 ac pactwoven.finance_asset_controls%ROWTYPE; cc pactwoven.finance_account_controls%ROWTYPE; sc pactwoven.finance_source_controls%ROWTYPE; av pactwoven.finance_account_versions%ROWTYPE; sv pactwoven.finance_source_versions%ROWTYPE;
 org_status text; original pactwoven.finance_deliveries%ROWTYPE; prior_conflict pactwoven.finance_provenance_conflicts%ROWTYPE; observed_fact jsonb; locator jsonb;
 input_hash text; payload bytea; received timestamptz; receipt_id uuid; conflict_id uuid; response jsonb; conflict_response jsonb; scope jsonb;
 transfer_id text; effect_id text; direction text; stored_fact jsonb; disposition text:='recorded';
BEGIN
 principal:=pactwoven.finance_principal(); PERFORM pactwoven.finance_validate_input(p_input);
 SELECT * INTO binding FROM pactwoven.finance_source_bindings WHERE source_id=p_input->'source'->>'id' AND account_key=p_input->'account'->>'key' AND principal_oid=principal AND principal_name=SESSION_USER;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='PF001',MESSAGE='Delivery source and account are not bound to this login'; END IF;
 -- All writes serialize organization first, then stable asset/account/source order.
 SELECT status INTO org_status FROM pactwoven.organizations WHERE environment=binding.environment AND id=binding.organization_id FOR UPDATE;
 SELECT * INTO asset FROM pactwoven.finance_physical_assets WHERE asset_key=p_input->'asset'->>'key' FOR UPDATE;
 SELECT * INTO ac FROM pactwoven.finance_asset_controls WHERE asset_key=asset.asset_key FOR UPDATE;
 SELECT * INTO account FROM pactwoven.finance_physical_accounts WHERE account_key=binding.account_key FOR UPDATE;
 SELECT * INTO cc FROM pactwoven.finance_account_controls WHERE account_key=account.account_key FOR UPDATE;
 PERFORM 1 FROM pactwoven.finance_sources WHERE source_id=binding.source_id FOR UPDATE;
 SELECT * INTO sc FROM pactwoven.finance_source_controls WHERE source_id=binding.source_id FOR UPDATE;
 SELECT * INTO binding FROM pactwoven.finance_source_bindings WHERE source_id=binding.source_id AND account_key=binding.account_key FOR UPDATE;
 SELECT * INTO av FROM pactwoven.finance_account_versions WHERE account_key=account.account_key AND version=cc.current_version;
 SELECT * INTO sv FROM pactwoven.finance_source_versions WHERE source_id=binding.source_id AND version=sc.current_version;
 IF pactwoven.finance_principal()<>binding.principal_oid OR binding.principal_name<>SESSION_USER OR org_status IS DISTINCT FROM 'active'
  OR binding.accepts_observations IS DISTINCT FROM true OR binding.revoked_at IS NOT NULL OR ac.accepts_observations IS DISTINCT FROM true OR ac.revoked_at IS NOT NULL
  OR cc.accepts_observations IS DISTINCT FROM true OR cc.revoked_at IS NOT NULL OR sc.accepts_observations IS DISTINCT FROM true OR sc.revoked_at IS NOT NULL THEN RAISE EXCEPTION USING ERRCODE='PF001',MESSAGE='Observation intake is disabled or revoked'; END IF;
 IF ac.current_version IS DISTINCT FROM pactwoven.finance_version(p_input->'asset'->'version') OR cc.current_version IS DISTINCT FROM pactwoven.finance_version(p_input->'account'->'version')
  OR sc.current_version IS DISTINCT FROM pactwoven.finance_version(p_input->'source'->'version') OR av.asset_key IS DISTINCT FROM asset.asset_key
  OR sv.adapter_version IS DISTINCT FROM p_input->>'adapterVersion' OR sv.normalizer_version IS DISTINCT FROM p_input->>'normalizerVersion'
  OR asset.asset_key IS DISTINCT FROM '34ee730cf90d3d55ea2d34e911aa4ad941aafb29668bf4056cfa88c6cf0492e4' OR account.genesis IS DISTINCT FROM asset.genesis THEN RAISE EXCEPTION USING ERRCODE='PF002',MESSAGE='Current exact registry and source versions required'; END IF;
 input_hash:=pactwoven.finance_hash(p_input); payload:=decode(p_input->>'payloadHex','hex'); received:=clock_timestamp();
 scope:=jsonb_build_object('sourceId',binding.source_id,'accountKey',binding.account_key,'deliveryKey',p_input->>'deliveryKey','environment',binding.environment,'organizationId',binding.organization_id);
 SELECT * INTO original FROM pactwoven.finance_deliveries WHERE source_id=binding.source_id AND account_key=binding.account_key AND delivery_key=p_input->>'deliveryKey';
 IF FOUND THEN
  IF original.input_hash=input_hash AND original.payload=payload THEN RETURN original.receipt; END IF;
  SELECT * INTO prior_conflict FROM pactwoven.finance_provenance_conflicts WHERE source_id=binding.source_id AND account_key=binding.account_key AND delivery_key=p_input->>'deliveryKey' AND attempt_hash=input_hash;
  IF FOUND THEN RETURN prior_conflict.receipt; END IF;
  conflict_id:=gen_random_uuid(); response:=scope||jsonb_build_object('kind','conflict','conflictId',conflict_id,'reason','DELIVERY_REUSE','attemptHash',input_hash,'payloadHash',p_input->>'payloadHash','originalReceiptId',original.receipt_id,'receivedAt',to_char(received AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
  INSERT INTO pactwoven.finance_provenance_conflicts VALUES(conflict_id,binding.source_id,binding.account_key,p_input->>'deliveryKey',input_hash,original.receipt_id,'DELIVERY_REUSE',payload,p_input,received,response);
  RETURN response;
 END IF;
 IF p_input->'observation'->>'kind'='transfer' THEN
  observed_fact:=p_input->'observation'->'fact'; locator:=observed_fact->'locator'; transfer_id:=pactwoven.finance_locator(locator);
  IF account.address<>pactwoven.finance_base58(observed_fact->>'source',32) AND account.address<>pactwoven.finance_base58(observed_fact->>'destination',32) THEN RAISE EXCEPTION USING ERRCODE='PF004',MESSAGE='Transfer does not affect this bound account'; END IF;
  INSERT INTO pactwoven.finance_transfer_facts(genesis,signature,outer_index,inner_index,asset_key,fact) VALUES(asset.genesis,pactwoven.finance_base58(locator->>'signature',64),(locator->>'outerInstructionIndex')::integer,(locator->>'innerInstructionOrdinal')::integer,asset.asset_key,observed_fact) ON CONFLICT DO NOTHING;
  SELECT fact INTO stored_fact FROM pactwoven.finance_transfer_facts WHERE transfer_key=transfer_id;
  IF stored_fact IS DISTINCT FROM observed_fact THEN disposition:='quarantined'; conflict_id:=gen_random_uuid();
  ELSE
   direction:=CASE WHEN account.address=pactwoven.finance_base58(observed_fact->>'source',32) THEN CASE WHEN account.address=pactwoven.finance_base58(observed_fact->>'destination',32) THEN 'self' ELSE 'outgoing' END ELSE 'incoming' END;
   INSERT INTO pactwoven.finance_account_effects(transfer_key,account_key,asset_key,direction) VALUES(transfer_id,account.account_key,asset.asset_key,direction) ON CONFLICT DO NOTHING;
   effect_id:=pactwoven.finance_effect_key(transfer_id,account.account_key);
  END IF;
 ELSIF p_input->'observation'->>'kind'='finality' THEN
  transfer_id:=pactwoven.finance_locator(p_input->'observation'->'locator');
  SELECT effect_key INTO effect_id FROM pactwoven.finance_account_effects WHERE transfer_key=transfer_id AND account_key=account.account_key AND asset_key=asset.asset_key;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='PF004',MESSAGE='Finality must reference an existing account effect'; END IF;
 END IF;
 receipt_id:=gen_random_uuid(); response:=scope||jsonb_build_object('kind','delivery','receiptId',receipt_id,'sourceVersion',sc.current_version,'accountVersion',cc.current_version,
  'asset',p_input->'asset','payloadHash',p_input->>'payloadHash','inputHash',input_hash,'receivedAt',to_char(received AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'disposition',disposition,'observationKind',p_input->'observation'->>'kind','transferKey',transfer_id,'effectKey',effect_id,'conflictId',conflict_id);
 INSERT INTO pactwoven.finance_deliveries(receipt_id,source_id,account_key,delivery_key,source_version,account_version,asset_key,asset_version,payload,input,received_at,receipt)
  VALUES(receipt_id,binding.source_id,binding.account_key,p_input->>'deliveryKey',sc.current_version,cc.current_version,asset.asset_key,ac.current_version,payload,p_input,received,response);
 IF effect_id IS NOT NULL THEN INSERT INTO pactwoven.finance_observation_links VALUES(receipt_id,effect_id); END IF;
 IF conflict_id IS NOT NULL THEN
  conflict_response:=scope||jsonb_build_object('kind','conflict','conflictId',conflict_id,'reason','TRANSFER_FACT_CONFLICT','attemptHash',input_hash,'payloadHash',p_input->>'payloadHash','originalReceiptId',receipt_id,'receivedAt',response->>'receivedAt');
  INSERT INTO pactwoven.finance_provenance_conflicts VALUES(conflict_id,binding.source_id,binding.account_key,p_input->>'deliveryKey',input_hash,receipt_id,'TRANSFER_FACT_CONFLICT',payload,p_input,received,conflict_response);
 END IF;
 RETURN response;
END $$;
CREATE FUNCTION pactwoven.read_finance_provenance(p_source text,p_account text,p_key text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE principal oid; response jsonb;
BEGIN
 principal:=pactwoven.finance_principal();
 IF p_source IS NULL OR p_source!~'^[A-Za-z0-9_-]{1,128}$' OR p_account IS NULL OR p_account!~'^[a-f0-9]{64}$' OR p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 256 OR p_key!~'^[A-Za-z0-9._:/-]+$' THEN RAISE EXCEPTION USING ERRCODE='PF004',MESSAGE='Exact original delivery reference required'; END IF;
 -- Revocation stops new intake, not historical original receipt recovery by the same enduring login identity.
 IF NOT EXISTS(SELECT 1 FROM pactwoven.finance_source_bindings WHERE source_id=p_source AND account_key=p_account AND principal_oid=principal AND principal_name=SESSION_USER) THEN RAISE EXCEPTION USING ERRCODE='PF001',MESSAGE='Original source and account are not bound to this login'; END IF;
 SELECT receipt INTO response FROM pactwoven.finance_deliveries WHERE source_id=p_source AND account_key=p_account AND delivery_key=p_key;
 RETURN response;
END $$;
DO $$ DECLARE item regprocedure; BEGIN
 FOR item IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='pactwoven' AND(p.proname LIKE 'finance_%' OR p.proname IN ('append_finance_provenance','read_finance_provenance')) LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,pactwoven_runtime,pactwoven_provisioner,pactwoven_access_provisioner,pactwoven_mandate_writer,pactwoven_finance_observer',item);
 END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION pactwoven.append_finance_provenance(jsonb),pactwoven.read_finance_provenance(text,text,text) TO pactwoven_finance_observer;

COMMIT;
