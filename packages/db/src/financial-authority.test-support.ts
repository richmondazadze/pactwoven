import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { Socket } from 'node:net';
import { TLSSocket } from 'node:tls';
import { Pool, type PoolClient, type PoolConfig } from 'pg';
import { FINANCE_DEVNET_ASSET, decodeSolanaBase58, type FinancialPolicyCommand, type FinancialPolicyResult, type FinancialGovernanceBundle, type FinancialDraftInput } from '@pactwoven/contracts';
import { financialBudgetAccountId, financialBudgetPeriodId, financialPolicyDecisionIntent } from '@pactwoven/domain';
import { loadMigrations } from './migrate.js';
import { PostgresFinancialPolicyRepository } from './financial-policy-repository.js';
import { PostgresFinancialAuthenticationRepository } from './financial-authentication-repository.js';
import type { FinancialAuthEvidence } from './financial-auth-evidence.js';
export const financialPolicyFixtureVariable='PACTWOVEN_FINANCIAL_POLICY_TEST_ADMIN_URL_FILE';
export const financialPolicyFixtureEnabled=Boolean(process.env[financialPolicyFixtureVariable]);
const database='pactwoven_financial_policy_fa1_test';
export const financialPolicyFixtureEnvironment=(env:NodeJS.ProcessEnv)=>Object.fromEntries(Object.entries(env).filter(([k])=>!k.startsWith('PG')&&!k.startsWith('PACTWOVEN_')));
type FinancialPolicyFixtureEnvironment={CI?:string;GITHUB_ACTIONS?:string};
const financialPolicyFixturePortAllowed=(port:number|undefined,environment:FinancialPolicyFixtureEnvironment)=>port===55439||
 (port===55440&&environment.CI==='true'&&environment.GITHUB_ACTIONS==='true');
export function financialPolicyFixtureConfig(input:string,environment:FinancialPolicyFixtureEnvironment=process.env):PoolConfig {const u=new URL(input),user=decodeURIComponent(u.username),password=decodeURIComponent(u.password);
  const port=u.port==='55439'?55439:u.port==='55440'?55440:undefined;
  if(!['postgres:','postgresql:'].includes(u.protocol)||u.hostname!=='127.0.0.1'||!financialPolicyFixturePortAllowed(port,environment)||u.pathname!==`/${database}`||u.search||u.hash||!user||!password||user.includes('\0')||password.includes('\0'))throw new Error('Exclusive financial policy loopback fixture required.');
  return {host:'127.0.0.1',port,database,user,password,ssl:false,max:8,connectionTimeoutMillis:3000,statement_timeout:10000};}
export async function readFinancialPolicyFixtureConfig(path:string){const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||(info.mode&0o777)!==0o600||info.size<1||info.size>8192)throw new Error('Protected regular fixture URL file required.');
  const fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const actual=await fd.stat();if(actual.dev!==info.dev||actual.ino!==info.ino||!actual.isFile()||(actual.mode&0o777)!==0o600)throw new Error('Fixture credential changed.');return financialPolicyFixtureConfig((await fd.readFile('utf8')).trim());}finally{await fd.close();}}
export async function assertFinancialPolicyFixture(c:PoolClient,config:PoolConfig){const stream=(c as PoolClient&{connection?:{stream?:unknown}}).connection?.stream;
 if(config.host!=='127.0.0.1'||!financialPolicyFixturePortAllowed(config.port,process.env)||config.database!==database||!(stream instanceof Socket)||stream instanceof TLSSocket||stream.destroyed||stream.readyState!=='open'||stream.remotePort!==config.port||!['127.0.0.1','::ffff:127.0.0.1'].includes(stream.remoteAddress??''))throw new Error('Exact financial policy socket required.');
 const r=(await c.query('SELECT current_database() AS database,current_user AS current,session_user AS session')).rows[0];if(r.database!==database||r.current!==config.user||r.session!==config.user)throw new Error('Exact financial policy database and authenticated principal required.');}
const literal=(v:string)=>`'${v.replaceAll("'","''")}'`;
const groups = ['pactwoven_runtime','pactwoven_provisioner','pactwoven_access_provisioner','pactwoven_mandate_writer','pactwoven_finance_observer',
  'pactwoven_custody_setup_writer','pactwoven_custody_setup_verifier','pactwoven_financial_authorizer','pactwoven_financial_verifier'];
async function roleSnapshot(admin: Pool, names = groups) {
  return (await admin.query(`SELECT rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls,rolconnlimit,rolvaliduntil,rolconfig,
    (SELECT coalesce(jsonb_agg(jsonb_build_object('role',p.rolname,'member',c.rolname,'admin',m.admin_option,'inherit',m.inherit_option,'set',m.set_option) ORDER BY p.rolname,c.rolname),'[]')
     FROM pg_auth_members m JOIN pg_roles p ON p.oid=m.roleid JOIN pg_roles c ON c.oid=m.member WHERE(m.roleid=r.oid OR m.member=r.oid) AND c.rolname NOT LIKE 'pactwoven_policy_test_%') AS grants
    FROM pg_roles r WHERE rolname=ANY($1) ORDER BY rolname`, [names])).rows;
}
export async function financialPolicyFixture() {
  const path = process.env[financialPolicyFixtureVariable];
  if (!path || Object.keys(process.env).some(k => k.startsWith('PG') || k.startsWith('PACTWOVEN_') && k !== financialPolicyFixtureVariable)) throw new Error('Use only the explicit policy fixture variable in a scrubbed environment.');
  const config = await readFinancialPolicyFixtureConfig(path), admin = new Pool(config), pools: Pool[] = [], roles: string[] = [];
  let lock: PoolClient | undefined, locked = false, original: Awaited<ReturnType<typeof roleSnapshot>> | undefined, closed = false;
  const close = async () => {
    if (closed) return; closed = true;
    await Promise.all(pools.map(p => p.end()));
    for (const role of roles) { await admin.query(`DROP OWNED BY "${role}"`); await admin.query(`DROP ROLE "${role}"`); }
    const preserved = !original || JSON.stringify(original) === JSON.stringify(await roleSnapshot(admin, original.map(r => r.rolname)));
    if (locked) await lock!.query("SELECT pg_advisory_unlock(hashtextextended('financial_policy_fixture',0))");
    lock?.release(); await admin.end(); if (!preserved) throw new Error('Shared role attributes or grants changed.');
  };
  try {
    lock = await admin.connect(); await assertFinancialPolicyFixture(lock, config);
    original = await roleSnapshot(admin); await lock.query('SET statement_timeout=0');
    await lock.query("SELECT pg_advisory_lock(hashtextextended('financial_policy_fixture',0))"); locked = true;
    const migrations = await loadMigrations();
    if (migrations.length !== 11 || migrations[10]?.filename !== '0011_financial_policy_authority.sql') throw new Error('Exactly the assigned eleven migrations required.');
    await admin.query('DROP SCHEMA IF EXISTS pactwoven CASCADE');
    for (const migration of migrations) {
      const c = await admin.connect();
      try { await c.query('BEGIN'); for (const [i, statement] of migration.statements.entries()) {
        try { await c.query(statement); } catch (error) { throw new Error(`Policy migration ${migration.number} statement ${i + 1} failed`, { cause: error }); }
      } await c.query('COMMIT'); } catch (error) { await c.query('ROLLBACK'); throw error; } finally { c.release(); }
    }
    const suffix = randomBytes(5).toString('hex');
    const login = async (label: string, group: string | null) => {
      const role = `pactwoven_policy_test_${suffix}_${label}`, password = randomBytes(32).toString('base64url');
      await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD ${literal(password)} NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`); roles.push(role);
      if (group) await admin.query(`GRANT "${group}" TO "${role}"`);
      const pool = new Pool({ ...config, user: role, password }); pools.push(pool);
      const c = await pool.connect(); try { await assertFinancialPolicyFixture(c, { ...config, user: role }); } finally { c.release(); }
      return { role, pool };
    };
    const authorizer = await login('authorizer', 'pactwoven_financial_authorizer'), verifier = await login('verifier', 'pactwoven_financial_verifier'), stranger = await login('stranger', null);
    await admin.query("INSERT INTO pactwoven.organizations(environment,id,external_organization_id,name,authority_epoch) VALUES('development','org_a','clerk_org_a','Synthetic policy fixture',2),('development','org_b','clerk_org_b','Other synthetic policy fixture',0)");
    await admin.query("INSERT INTO pactwoven.memberships(environment,organization_id,actor_id,external_subject,external_membership_id,roles,grant_basis) VALUES('development','org_a','owner_a','owner_a','membership_owner_a',ARRAY['owner'],'internal'),('development','org_a','owner_b','owner_b','membership_owner_b',ARRAY['owner'],'internal'),('development','org_a','finance_a','finance_a','membership_finance_a',ARRAY['finance'],'internal'),('development','org_a','operations_a','operations_a','membership_operations_a',ARRAY['operations'],'internal')");
    await admin.query("INSERT INTO pactwoven.sites VALUES('development','org_a','site_a','Synthetic site','America/Chicago'),('development','org_a','site_b','Other synthetic site','America/Chicago')");
    await admin.query("INSERT INTO pactwoven.site_memberships SELECT 'development','org_a',actor_id,'site_a' FROM pactwoven.memberships WHERE organization_id='org_a'");
    await admin.query("INSERT INTO pactwoven.member_action_sites SELECT 'development','org_a',actor_id,'site_a' FROM pactwoven.memberships WHERE organization_id='org_a'");
    await admin.query("INSERT INTO pactwoven.responsibilities(environment,organization_id,id,owner_id,site_id,title,description,starts_at,ends_at,time_zone,requirements,acceptance_policy) VALUES('development','org_a','responsibility_a','owner_a','site_a','Synthetic financial draft','',now(),now()+interval '2 days','America/Chicago','[]','No effective authority.')");
    const assetKey = '34ee730cf90d3d55ea2d34e911aa4ad941aafb29668bf4056cfa88c6cf0492e4';
    await admin.query('INSERT INTO pactwoven.finance_physical_assets(genesis,token_program,mint) VALUES($1,$2,$3)', [Buffer.from(decodeSolanaBase58(FINANCE_DEVNET_ASSET.genesis, 32)), Buffer.from(decodeSolanaBase58(FINANCE_DEVNET_ASSET.tokenProgram, 32)), Buffer.from(decodeSolanaBase58(FINANCE_DEVNET_ASSET.mint, 32))]);
    await admin.query("INSERT INTO pactwoven.finance_asset_versions VALUES($1,1,'solana-original-devnet-usdc-v1',6,$2,'synthetic_verifier','[]')", [assetKey, 'a'.repeat(64)]);
    await admin.query('INSERT INTO pactwoven.finance_asset_controls VALUES($1,1,true,null)', [assetKey]);
    for (const [role, capability] of [[authorizer.role, 'authorizer'], [verifier.role, 'verifier']]) await admin.query("INSERT INTO pactwoven.financial_policy_principals SELECT oid,rolname,'development','org_a',$1,1,true,now()+interval '1 day' FROM pg_roles WHERE rolname=$2", [capability, role]);
    const asset = (await admin.query('SELECT pactwoven.finance_hash(to_jsonb(v)) AS hash,f.generation FROM pactwoven.finance_asset_versions v JOIN pactwoven.financial_asset_fences f USING(asset_key) WHERE asset_key=$1', [assetKey])).rows[0];
    const assetPin = { key: assetKey, version: 1, recordHash: asset.hash as string, financialUseEpoch: asset.generation as number };
    const repository = new PostgresFinancialPolicyRepository(authorizer.pool), authentication = new PostgresFinancialAuthenticationRepository(verifier.pool);
    const identity = async (actorId = 'owner_a') => {
      const now = Date.now(), body: FinancialAuthEvidence = { schemaVersion: 1, id: crypto.randomUUID(), environment: 'development', organizationId: 'org_a', kind: 'identity', purpose: 'financial_policy_observation',
        actor: { actorId, membershipVersion: 1, subject: actorId, externalMembershipId: `membership_${actorId}`, sessionId: `session_${actorId}` },
        observedAt: new Date(now).toISOString(), expiresAt: new Date(now + 240_000).toISOString(), sessionExpiresAt: new Date(now + 240_000).toISOString(),
        externalOrganizationId: 'clerk_org_a', externalRole: 'org:member', issuer: 'https://synthetic.invalid', tokenHash: 'a'.repeat(64), tokenIssuedAt: new Date(now - 1000).toISOString() };
      await authentication.append(body); return body;
    };
    const base = (kind: FinancialPolicyCommand['kind'], id: string, responsibilityId: string | null = null) => ({ schemaVersion: 1 as const, environment: 'development' as const, organizationId: 'org_a', responsibilityId,
      organizationEpoch: 2, kind, id, previous: null, key: `policy_${crypto.randomUUID()}` });
    const saveDocument = async (purpose: 'financial_mandate' | 'budget_policy' | 'approval_policy', id = `document_${crypto.randomUUID()}`, actorId = 'owner_a') => {
      const command: FinancialPolicyCommand = { ...base('save_document', id, purpose === 'financial_mandate' ? 'responsibility_a' : null), kind: 'save_document', purpose, text: `Synthetic ${purpose} full terms. No spending authority.` };
      const result = await repository.mutate((await identity(actorId)).id, command); return { command, result };
    };
    const governance = async (id = `governance_${crypto.randomUUID()}`) => {
      const budget = await saveDocument('budget_policy'), approval = await saveDocument('approval_policy');
      const budgetAccountId = await financialBudgetAccountId('development', 'org_a', assetKey), startsAt = new Date(Math.floor(Date.now() / 86_400_000) * 86_400_000).toISOString(), endsAt = new Date(Date.parse(startsAt) + 7 * 86_400_000).toISOString();
      const bundle: FinancialGovernanceBundle = { budgetAccountId, asset: assetPin, category: 'supplier_principal', limits: { perOperation: '100', perResponsibility: '500', perPeriod: '1000' },
        period: { id: await financialBudgetPeriodId(budgetAccountId, startsAt, endsAt), startsAt, endsAt },
        approval: { requesterRoles: ['finance', 'operations', 'owner'], approverRoles: ['finance', 'owner'], independent: true, actionSiteIds: ['site_a'], action: 'allocate_funds', category: 'supplier_principal',
          thresholdBaseUnits: '100', maximumAuthenticationAgeSeconds: 300, maximumApprovalAgeSeconds: 300 },
        documents: [{ ...budget.result.target, purpose: 'budget_policy' }, { ...approval.result.target, purpose: 'approval_policy' }].sort((a, b) => a.id < b.id ? -1 : 1) as FinancialGovernanceBundle['documents'] };
      const control = (await admin.query('SELECT pactwoven.financial_policy_control($1) AS value', [budgetAccountId])).rows[0].value;
      const command: FinancialPolicyCommand = { ...base('propose_governance', id), kind: 'propose_governance', responsibilityId: null, bundle, expectedControl: control, expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
      const result = await repository.mutate((await identity()).id, command); return { command, result, budget, approval };
    };
    const prepareConsent = async (proposal: FinancialPolicyResult, approverId = 'finance_a') => {
      if (proposal.body.kind !== 'governance') throw new Error('Synthetic governance required.');
      const proposer = await identity(), approver = await identity(approverId), key = `accept_${crypto.randomUUID()}`;
      const details = await financialPolicyDecisionIntent(proposal.body, approver.actor, key, 2), now = Date.now();
      const evidence: FinancialAuthEvidence = { ...approver, id: crypto.randomUUID(), kind: 'mfa', purpose: 'financial_policy_authorization', ...details,
        observedAt: new Date(now).toISOString(), tokenIssuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 180_000).toISOString(),
        firstFactorAgeMinutes: 0, secondFactorAgeMinutes: 0, verifiedAt: new Date(now - 60_000).toISOString() };
      await authentication.append(evidence);
      const command: FinancialPolicyCommand = { ...base('accept_governance', proposal.body.id), kind: 'accept_governance', responsibilityId: null, key, previous: proposal.target,
        expectedControl: proposal.body.expectedControl, nonce: proposal.body.decisionNonce, proposerEvidenceId: proposer.id, mfaEvidenceId: evidence.id };
      return { proposer, approver, evidence, command };
    };
    const consent = async (proposal: FinancialPolicyResult, approverId = 'finance_a') => { const prepared = await prepareConsent(proposal, approverId); return { ...prepared, result: await repository.mutate(prepared.approver.id, prepared.command) }; };
    const draft = async (id = `draft_${crypto.randomUUID()}`, actorId = 'operations_a') => {
      const document = await saveDocument('financial_mandate', `document_${crypto.randomUUID()}`, actorId);
      const fence = (await admin.query("SELECT pactwoven.financial_authority_snapshot(f) AS authority,pactwoven.financial_authority_fence_hash(f) AS hash FROM pactwoven.financial_authority_fences f WHERE environment='development' AND organization_id='org_a' AND responsibility_id='responsibility_a'")).rows[0];
      const site = (await admin.query("SELECT site_id AS id,generation,record_hash AS \"recordHash\" FROM pactwoven.financial_site_fences WHERE environment='development' AND organization_id='org_a' AND site_id='site_a'")).rows[0];
      const input: FinancialDraftInput = { scope: { authority: fence.authority, authorityHash: fence.hash, site },
        terms: { mode: 'PREPARE_FOR_APPROVAL', actions: ['allocate_funds'], category: 'supplier_principal', allocation: 'responsibility_earmark', supplier: null, acceptedTerms: null, payee: null, tool: null, withdrawal: null, branch: null,
          communication: { recipients: [], purposes: [], kinds: [], allowanceBaseUnits: '0' } },
        documents: [{ ...document.result.target, purpose: 'financial_mandate' }], governance: null, asset: null, account: null, trust: null,
        startsAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
      const command: FinancialPolicyCommand = { ...base('save_draft', id, 'responsibility_a'), kind: 'save_draft', responsibilityId: 'responsibility_a', draft: input };
      const result = await repository.mutate((await identity(actorId)).id, command); return { command, result, document };
    };
    return { admin, authorizer, verifier, stranger, login, config, identity, base, saveDocument, governance, prepareConsent, consent, draft, assetPin, repository, authentication, close };
  } catch (error) { await close(); throw error; }
}
export type FinancialPolicyFixture = Awaited<ReturnType<typeof financialPolicyFixture>>;
