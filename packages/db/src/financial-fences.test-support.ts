import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { Socket } from 'node:net';
import { TLSSocket } from 'node:tls';
import { Pool, type PoolClient, type PoolConfig } from 'pg';
import { decodeSolanaBase58, FINANCE_DEVNET_ASSET, type CreateMandateDocumentRequest, type MandatePolicy, type MandateDecisionIntent,
  type MandateHead, type MandateAuthorityIntent, type MemberCandidate, type ProposeMandateCommand } from '@pactwoven/contracts';
import { physicalAssetKey, physicalAccountKey, commandDigest, mandateIntentHash, mandateHeadReference, mandateVersionReference } from '@pactwoven/domain';
import { loadMigrations, type Migration } from './migrate.js';
import { PostgresMandateRepository, mandateCommandHash } from './mandate-repository.js';
import type { VerifiedIdentity } from './repository.js';
import type { MandateMutation, VerifiedMandateCommand } from './mandate-schema.js';

export const financialFenceFixtureVariable = 'PACTWOVEN_FINANCIAL_FENCES_TEST_ADMIN_URL_FILE';
export const financialFenceFixtureEnabled = Boolean(process.env[financialFenceFixtureVariable]);
const database = 'pactwoven_financial_fences_fa0_test';
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
export function financialFenceFixtureEnvironment(input: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(input).filter(([key]) => !key.startsWith('PACTWOVEN_') && !key.startsWith('PG')));
}
type FixtureEnvironment = { CI?: string; GITHUB_ACTIONS?: string };
const financialFenceFixturePortAllowed = (port: number | undefined, environment: FixtureEnvironment) => port === 55439 ||
  (port === 55440 && environment.CI === 'true' && environment.GITHUB_ACTIONS === 'true');
export function financialFenceFixtureConfig(input: string, environment: FixtureEnvironment = process.env): PoolConfig {
  const url = new URL(input), user = decodeURIComponent(url.username), password = decodeURIComponent(url.password);
  // The sole additional transport is the fixed CI container port in explicit GitHub Actions context.
  const port = url.port === '55439' ? 55439 : url.port === '55440' ? 55440 : undefined;
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1' || !financialFenceFixturePortAllowed(port, environment) || url.pathname !== `/${database}` ||
    url.search || url.hash || !user || !password || user.includes('\0') || password.includes('\0')) throw new Error('Only the exclusive FA-0 loopback fixture is allowed.');
  return { host: '127.0.0.1', port, database, user, password, ssl: false, max: 8, connectionTimeoutMillis: 3000, statement_timeout: 10000 };
}
export async function readFinancialFenceFixtureConfig(path: string): Promise<PoolConfig> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600 || info.size < 1 || info.size > 8192) throw new Error('Protected regular FA-0 credential file required.');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const actual = await file.stat();
    if (actual.dev !== info.dev || actual.ino !== info.ino || !actual.isFile() || (actual.mode & 0o777) !== 0o600 || actual.size < 1 || actual.size > 8192) throw new Error('Credential file changed while opening.');
    return financialFenceFixtureConfig((await file.readFile('utf8')).trim());
  } finally { await file.close(); }
}
export async function assertFinancialFenceFixture(client: PoolClient, config: PoolConfig) {
  const stream = (client as PoolClient & { connection?: { stream?: unknown } }).connection?.stream;
  if (config.host !== '127.0.0.1' || !financialFenceFixturePortAllowed(config.port, process.env) || config.database !== database || !(stream instanceof Socket) || stream instanceof TLSSocket ||
    stream.destroyed || stream.readyState !== 'open' || stream.remotePort !== config.port || !['127.0.0.1', '::ffff:127.0.0.1'].includes(stream.remoteAddress ?? '')) throw new Error('Exact actual FA-0 loopback socket required.');
  const row = (await client.query('SELECT current_database() AS database,current_user AS current,session_user AS session,inet_server_addr()::text AS server,inet_server_port() AS port')).rows[0];
  if (row.database !== database || row.current !== config.user || row.session !== config.user) throw new Error('Exact FA-0 database and authenticated login required.');
  return { server: row.server as string, port: row.port as number };
}
export async function sharedFinancialCapabilityRoles(admin: Pool) {
  return (await admin.query(`SELECT r.rolname,r.rolsuper,r.rolinherit,r.rolcreaterole,r.rolcreatedb,r.rolcanlogin,r.rolreplication,r.rolbypassrls,r.rolconnlimit,r.rolvaliduntil,r.rolconfig,
    (SELECT coalesce(jsonb_agg(jsonb_build_object('role',parent.rolname,'member',child.rolname,'admin',m.admin_option,'inherit',m.inherit_option,'set',m.set_option) ORDER BY parent.rolname,child.rolname),'[]'::jsonb)
      FROM pg_auth_members m JOIN pg_roles parent ON parent.oid=m.roleid JOIN pg_roles child ON child.oid=m.member WHERE(m.roleid=r.oid OR m.member=r.oid) AND child.rolname NOT LIKE 'pactwoven_fa0_%') AS grants
    FROM pg_roles r WHERE r.rolname IN ('pactwoven_runtime','pactwoven_provisioner','pactwoven_access_provisioner','pactwoven_mandate_writer','pactwoven_finance_observer') ORDER BY r.rolname`)).rows;
}
export const fenceIdentity = (subject = 'finance_a'): VerifiedIdentity => ({ subject, externalOrganizationId: 'clerk_org_a', externalOrganizationName: 'Mandate test organization',
  externalMembershipId: `membership_${subject}`, externalRole: 'org:member', sessionId: `session_${subject}`,
  authenticatedAt: new Date(Date.now() - 3_600_000).toISOString(), membershipObservedAt: new Date().toISOString() });
const candidate = (): MemberCandidate => ({ externalOrganizationId: 'clerk_org_a', externalSubject: 'operations_a', externalMembershipId: 'membership_operations_a',
  externalRole: 'org:member', displayName: 'Operations', observedAt: new Date().toISOString() });
export async function fenceVerified(mutation: MandateMutation, key: string, subject = 'finance_a'): Promise<VerifiedMandateCommand> {
  const actor = fenceIdentity(subject), requestNonce = crypto.randomUUID();
  if ((mutation.kind !== 'decide' || mutation.intent.action !== 'AUTHORIZE') && (mutation.kind !== 'control' || mutation.intent.action !== 'RESUME')) {
    return { identity: actor, evidence: null, requestNonce, requesterObservation: mutation.kind === 'decide' ? candidate() : null };
  }
  const intent = mutation.intent, issued = Math.floor(Date.now() / 1000) * 1000, purpose = intent.action === 'AUTHORIZE' ? 'mandate_authorization' : 'mandate_control';
  return { identity: actor, requestNonce, requesterObservation: candidate(), evidence: { id: crypto.randomUUID(), purpose,
    subject: actor.subject, externalOrganizationId: actor.externalOrganizationId, externalMembershipId: actor.externalMembershipId, sessionId: actor.sessionId,
    issuer: 'https://fixture.clerk.accounts.dev', tokenHash: 'a'.repeat(64), tokenIssuedAt: new Date(issued).toISOString(), firstFactorAgeMinutes: 0, secondFactorAgeMinutes: 0,
    verifiedAt: new Date(issued - 60_000).toISOString(), observedAt: new Date().toISOString(), expiresAt: new Date(issued + 180_000).toISOString(), requestNonce,
    intentHash: await mandateIntentHash(intent), requestHash: await commandDigest({ schemaVersion: 1, purpose, request: { nonce: requestNonce, key, intent } }) } };
}

export async function financialFenceFixture(options: { beforeFence?: (input: { admin: Pool; mandate: Pool }) => Promise<void> } = {}) {
  const path = process.env[financialFenceFixtureVariable];
  if (!path || Object.keys(process.env).some(key => (key.startsWith('PACTWOVEN_') && key !== financialFenceFixtureVariable) || key.startsWith('PG'))) throw new Error('Use only the explicit FA-0 credential variable in a scrubbed environment.');
  const config = await readFinancialFenceFixtureConfig(path), admin = new Pool(config), lock = await admin.connect(), pools: Pool[] = [], roles: string[] = [];
  let locked = false;
  const originalRoles = await sharedFinancialCapabilityRoles(admin);
  const close = async () => {
    await Promise.all(pools.map(pool => pool.end()));
    for (const role of roles) { await admin.query(`DROP OWNED BY "${role}"`); await admin.query(`DROP ROLE "${role}"`); }
    const preserved = JSON.stringify(originalRoles) === JSON.stringify(await sharedFinancialCapabilityRoles(admin));
    if (locked) await lock.query("SELECT pg_advisory_unlock(hashtextextended('financial_fences_fa0_fixture',0))");
    lock.release(); await admin.end();
    if (!preserved) throw new Error('Shared capability role attributes or grants changed.');
  };
  try {
    const server = await assertFinancialFenceFixture(lock, config);
    if (originalRoles.length !== 5) throw new Error('The existing five shared capability roles must be provisioned before this exclusive fixture runs.');
    await lock.query('SET statement_timeout=0');
    await lock.query("SELECT pg_advisory_lock(hashtextextended('financial_fences_fa0_fixture',0))"); locked = true;
    await admin.query('DROP SCHEMA IF EXISTS pactwoven CASCADE');
    const migrations = await loadMigrations();
    if (migrations.length !== 8 || migrations[7]!.filename !== '0008_financial_authority_fences.sql') throw new Error('Exactly the allocated eight migrations are required.');
    const apply = async (migration: Migration) => {
      const client = await admin.connect();
      try { await client.query('BEGIN'); for (const [index, statement] of migration.statements.entries()) {
        try { await client.query(statement); } catch(error) { throw new Error(`FA-0 migration ${migration.filename} statement ${index + 1} failed: ${statement.slice(0,100)}`, { cause: error }); }
      } await client.query('COMMIT'); } catch(error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    };
    for (const migration of migrations.slice(0,7)) await apply(migration);
    const suffix = randomBytes(5).toString('hex');
    const makeLogin = async (label: string, group: string | null) => {
      const role = `pactwoven_fa0_${suffix}_${label}`, password = randomBytes(32).toString('base64url');
      await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD ${literal(password)} NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`); roles.push(role);
      if (group) await admin.query(`GRANT "${group}" TO "${role}"`);
      const pool = new Pool({ ...config, user: role, password }); pools.push(pool);
      const client = await pool.connect();
      try { const actual = await assertFinancialFenceFixture(client, { ...config, user: role }); if (actual.server !== server.server || actual.port !== server.port) throw new Error('Fixture principals reached different servers.'); } finally { client.release(); }
      return { role, pool };
    };
    const runtime = await makeLogin('runtime','pactwoven_runtime'), mandate = await makeLogin('mandate','pactwoven_mandate_writer'), observer = await makeLogin('observer','pactwoven_finance_observer'),
      access = await makeLogin('access','pactwoven_access_provisioner'), bootstrap = await makeLogin('bootstrap','pactwoven_provisioner'), stranger = await makeLogin('stranger',null);
    await admin.query("INSERT INTO pactwoven.organizations(environment,id,external_organization_id,name,authority_epoch) VALUES('development','org_a','clerk_org_a','FA-0 synthetic organization',2),('development','org_b','clerk_org_b','Other synthetic organization',0)");
    for (const [subject, role] of [['operations_a','operations'],['finance_a','finance'],['finance_b','finance'],['owner_a','owner'],['receiver_a','receiver'],['auditor_a','auditor']] as const) {
      await admin.query("INSERT INTO pactwoven.memberships(environment,organization_id,actor_id,external_subject,external_membership_id,roles,grant_basis) VALUES('development','org_a',$1,$1,$2,$3,'internal')",[subject,`membership_${subject}`,[role]]);
    }
    await admin.query("INSERT INTO pactwoven.sites VALUES('development','org_a','site_a','Site A','America/Chicago'),('development','org_a','site_b','Site B','America/Chicago')");
    await admin.query("INSERT INTO pactwoven.site_memberships SELECT environment,organization_id,actor_id,'site_a' FROM pactwoven.memberships WHERE organization_id='org_a'");
    await admin.query("INSERT INTO pactwoven.member_action_sites(environment,organization_id,actor_id,site_id) SELECT environment,organization_id,actor_id,'site_a' FROM pactwoven.memberships WHERE organization_id='org_a'");
    await admin.query("INSERT INTO pactwoven.responsibilities(environment,organization_id,id,owner_id,site_id,title,description,starts_at,ends_at,time_zone,requirements,acceptance_policy) VALUES('development','org_a','responsibility_a','operations_a','site_a','Event preparation','',now(),now()+interval '2 days','America/Chicago','[]','Signed delivery evidence.')");
    const assetKey = await physicalAssetKey(FINANCE_DEVNET_ASSET);
    await admin.query('INSERT INTO pactwoven.finance_physical_assets(genesis,token_program,mint) VALUES($1,$2,$3)',[Buffer.from(decodeSolanaBase58(FINANCE_DEVNET_ASSET.genesis,32)),Buffer.from(decodeSolanaBase58(FINANCE_DEVNET_ASSET.tokenProgram,32)),Buffer.from(decodeSolanaBase58(FINANCE_DEVNET_ASSET.mint,32))]);
    await admin.query("INSERT INTO pactwoven.finance_asset_versions VALUES($1,1,'solana-original-devnet-usdc-v1',6,$2,'fixture_verifier','[]')",[assetKey,'a'.repeat(64)]);
    await admin.query('INSERT INTO pactwoven.finance_asset_controls VALUES($1,1,true,null)',[assetKey]);
    const accountKeys: string[] = [];
    for (const [byte,org] of [[11,'org_a'],[12,'org_b']] as const) {
      const address = new Uint8Array(32).fill(byte), key = await physicalAccountKey({genesis:FINANCE_DEVNET_ASSET.genesis,address:(await import('@pactwoven/contracts')).encodeSolanaBase58(address)}); accountKeys.push(key);
      await admin.query("INSERT INTO pactwoven.finance_physical_accounts(genesis,address,environment,organization_id) VALUES($1,$2,'development',$3)",[Buffer.from(decodeSolanaBase58(FINANCE_DEVNET_ASSET.genesis,32)),Buffer.from(address),org]);
      await admin.query("INSERT INTO pactwoven.finance_account_versions VALUES($1,1,$2,$3,$4,'fixture_verifier','[]',null)",[key,assetKey,Buffer.from(new Uint8Array(32).fill(21)),'a'.repeat(64)]);
      await admin.query('INSERT INTO pactwoven.finance_account_controls VALUES($1,1,true,null)',[key]);
      await admin.query("INSERT INTO pactwoven.finance_sources VALUES($1,'development',$2)",[`source_${org}`,org]);
      await admin.query("INSERT INTO pactwoven.finance_source_versions VALUES($1,1,$2,'fixture_adapter','fixture_normalizer',$2,'fixture_verifier','[]')",[`source_${org}`,'a'.repeat(64)]);
      await admin.query('INSERT INTO pactwoven.finance_source_controls VALUES($1,1,true,null)',[`source_${org}`]);
      await admin.query("INSERT INTO pactwoven.finance_source_bindings SELECT $1,$2,'development',$3,oid,rolname,true,null FROM pg_roles WHERE rolname=$4",[`source_${org}`,key,org,observer.role]);
    }
    await options.beforeFence?.({admin,mandate:mandate.pool});
    await apply(migrations[7]!);
    return {admin,config,runtime,mandate,observer,access,bootstrap,stranger,assetKey,accountA:accountKeys[0]!,accountB:accountKeys[1]!,close,originalRoles,
      repository: new PostgresMandateRepository(mandate.pool,'development')};
  } catch(error) { await close(); throw error; }
}
export type FinancialFenceFixture = Awaited<ReturnType<typeof financialFenceFixture>>;
export async function waitForFinancialFenceBlock(admin: Pool, waiter: number, holder: number) {
  const deadline = Date.now()+2500;
  while (Date.now()<deadline) {
    if ((await admin.query('SELECT $2::int=ANY(pg_blocking_pids($1)) AS blocked',[waiter,holder])).rows[0].blocked) return;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  throw new Error('Expected actual PostgreSQL lock wait was not observed.');
}
export const fenceBackendPid = async (client: PoolClient) => (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
export async function authorizeFenceLegacy(pool: Pool) {
  const repository = new PostgresMandateRepository(pool,'development');
  const mutate = async (mutation: MandateMutation,key: string,subject='finance_a') => repository.mutate(await fenceVerified(mutation,key,subject),'responsibility_a',key,mutation,'fa0_test');
  const page = await repository.list(fenceIdentity(),'responsibility_a',{limit:25},'trace');
  const request: CreateMandateDocumentRequest = {responsibility:page.responsibilityReference,expectedOrganizationEpoch:page.organizationEpoch,
    command:{documentId:'acceptance_a',expectedVersion:0,previousVersion:null,purpose:'ACCEPTANCE_POLICY',text:page.responsibility.acceptancePolicy}};
  const acceptance = await mutate({kind:'document',request},'create_acceptance_0001','operations_a');
  const policyDocument = await mutate({kind:'document',request:{...request,command:{...request.command,documentId:'policy_a',purpose:'MANDATE_POLICY',text:'Advice only. No money.'}}},'create_policy_doc_0001','operations_a');
  const ref = ({id,version,hash}:{id:string;version:number;hash:string}) => ({id,version,hash}), expiresAt=new Date(Date.now()+3_600_000).toISOString();
  const policy: MandatePolicy = {mode:'ADVISE',siteIds:['site_a'],actions:[],budgets:[],supplierRelationshipIds:[],acceptancePolicy:ref(acceptance.target),
    communication:{recipientIds:[],purposes:[],messageKinds:[],maximumMessages:0,expiresAt},expiresAt};
  const command: ProposeMandateCommand = {proposalId:'proposal_a',expectedProposalVersion:0,previousProposal:null,mandateId:'mandate_a',responsibility:page.responsibilityReference,
    expectedOrganizationEpoch:page.organizationEpoch,previousAcceptedVersion:null,expectedHead:null,policy,policyDocument:ref(policyDocument.target),expiresAt};
  const proposal = await mutate({kind:'propose',command},'propose_mandate_0001','operations_a');
  const intent: MandateDecisionIntent = {schemaVersion:1,action:'AUTHORIZE',proposal:ref(proposal.target),expectedDecisionVersion:1,expectedOrganizationEpoch:page.organizationEpoch,expectedHead:null,reason:null};
  const mutation: MandateMutation = {kind:'decide',proposalId:'proposal_a',intent}, key='authorize_mandate_0001';
  const result = await mutate(mutation,key);
  const control = async (action: MandateAuthorityIntent['action'],controlKey: string) => {
    const review = await repository.review(fenceIdentity(),'responsibility_a','proposal_a',{version:1},'trace');
    const controlIntent: MandateAuthorityIntent = {schemaVersion:1,action,mandate:await mandateVersionReference(review.envelope.acceptedVersion!),head:await mandateHeadReference(review.envelope.head!),
      responsibility:review.envelope.responsibilityReference,expectedOrganizationEpoch:review.envelope.organizationEpoch,reason:'FA-0 authority control'};
    const controlMutation: MandateMutation = {kind:'control',mandateId:'mandate_a',intent:controlIntent};
    return {result:await mutate(controlMutation,controlKey),mutation:controlMutation,key:controlKey};
  };
  return {repository,mutate,control,result,mutation,key,request};
}

export async function directFenceControl(client: PoolClient, previous: MandateHead, action: 'PAUSE' | 'REVOKE', records = { operation: true, audit: true, outbox: true }, corrupt?: 'audit-scope' | 'audit-epoch' | 'operation-kind' | 'outbox-target') {
    const actor = fenceIdentity(), requestNonce = crypto.randomUUID(), operationId = crypto.randomUUID(), key = `direct_${crypto.randomUUID()}`;
    const context = (await client.query('SELECT pactwoven.mandate_resolve_context($1,$2::jsonb,$3,true,$4) AS response', ['development', JSON.stringify(actor), 'responsibility_a', 'direct_control'])).rows[0].response;
    const accepted = (await client.query("SELECT body FROM pactwoven.mandate_versions WHERE id='mandate_a' AND version=$1", [previous.mandateVersion])).rows[0].body;
    const head: MandateHead = { ...previous, state: action === 'PAUSE' ? 'PAUSED' : 'REVOKED', mandateEpoch: previous.mandateEpoch + 1 };
    const responsibility = { id: context.currentResponsibility.id, version: context.currentResponsibility.version, siteId: context.currentResponsibility.siteId, hash: await commandDigest(context.currentResponsibility) };
    const intent: MandateAuthorityIntent = { schemaVersion: 1, action, mandate: await mandateVersionReference(accepted), head: await mandateHeadReference(previous), responsibility, expectedOrganizationEpoch: context.organizationEpoch, reason: 'Direct SQL completeness test' };
    const mutation: MandateMutation = { kind: 'control', mandateId: 'mandate_a', intent };
    const commandHash = await mandateCommandHash({ environment: 'development', organizationId: 'org_a', actorId: 'finance_a', responsibilityId: 'responsibility_a' }, mutation), intentHash = await mandateIntentHash(intent), kind = `mandate.${action.toLowerCase()}`;
    const target = { kind: 'authority', id: 'mandate_a', version: head.mandateEpoch, hash: await commandDigest(head) };
    const result = { schemaVersion: 1, organizationId: 'org_a', responsibilityId: 'responsibility_a', kind, target, commandHash, intentHash, observedAt: context.now,
      operation: { id: operationId, environment: 'development', status: 'succeeded', aggregateId: 'mandate_a', aggregateVersion: head.mandateEpoch, financialState: null, evidenceRefs: [], nextCheckAt: null, error: null } };
    const effect = { identity: actor, evidence: null, requesterObservation: null, kind, responsibilityId: 'responsibility_a', responsibilitySnapshot: context.currentResponsibility, organizationEpoch: context.organizationEpoch,
      command: intent, intentHash, nonce: requestNonce, requestHash: null, operationId, key, commandHash, authorityExpiresAt: head.expiresAt };
    await client.query("SELECT pg_catalog.set_config('pactwoven.mandate_effect',$1,true)", [JSON.stringify(effect)]);
    if (records.operation) await client.query("INSERT INTO pactwoven.mandate_operations(environment,organization_id,responsibility_id,site_id,id,actor_id,kind,idempotency_key,command_hash,command,result,identity) VALUES('development','org_a','responsibility_a','site_a',$1,'finance_a',$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb)", [operationId, corrupt === 'operation-kind' ? 'mandate.revoke' : kind, key, commandHash, JSON.stringify(intent), JSON.stringify(result), JSON.stringify(actor)]);
    await client.query("UPDATE pactwoven.mandate_heads SET body=$1::jsonb WHERE environment='development' AND organization_id='org_a' AND id='mandate_a'", [JSON.stringify(head)]);
    const audit = { schemaVersion: 1, operationId, kind, actorId: 'finance_a', identity: actor, evidence: null, requestNonce, requestHash: null, requesterObservation: null, commandHash, intentHash, occurredAt: context.now,
      history: { head, previousHead: intent.head, action, actorId: 'finance_a', occurredAt: context.now, operationId, intent, evidence: null } };
    if (corrupt === 'audit-epoch') audit.history.head = { ...head, mandateEpoch: head.mandateEpoch + 1 };
    if (records.audit) await client.query("INSERT INTO pactwoven.mandate_audit(environment,organization_id,id,responsibility_id,site_id,operation_id,body) VALUES('development','org_a',$1,'responsibility_a',$4,$2,$3::jsonb)", [crypto.randomUUID(), operationId, JSON.stringify(audit), corrupt === 'audit-scope' ? 'site_b' : 'site_a']);
    if (records.outbox) await client.query("INSERT INTO pactwoven.mandate_outbox(environment,organization_id,id,responsibility_id,site_id,operation_id,event_type,payload) VALUES('development','org_a',$1,'responsibility_a','site_a',$2,$3,$4::jsonb)", [crypto.randomUUID(), operationId, kind, JSON.stringify({ schemaVersion: 1, operationId, kind, responsibilityId: 'responsibility_a', target: corrupt === 'outbox-target' ? { ...target, version: 99 } : target })]);
    return { head, audit, operationId, result, effect };
  }
