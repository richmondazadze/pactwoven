import { randomBytes } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { Socket } from 'node:net';
import { TLSSocket } from 'node:tls';
import { Pool, type PoolClient, type PoolConfig } from 'pg';
import { decodeSolanaBase58, encodeSolanaBase58, FINANCE_DEVNET_ASSET, type FinanceProvenanceAppend } from '@pactwoven/contracts';
import { physicalAccountKey, physicalAssetKey, provenanceHex } from '@pactwoven/domain';
import { loadMigrations } from './migrate.js';
import { PostgresFinanceProvenanceRepository } from './finance-provenance-repository.js';

export const financeFixtureEnabled = Boolean(process.env.PACTWOVEN_FINANCE_PROVENANCE_TEST_ADMIN_URL_FILE);
const fixtureDatabase = 'pactwoven_finance_provenance_b2a_test';
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
type FixtureEnvironment = { CI?: string; GITHUB_ACTIONS?: string };
const fixturePortAllowed = (port: number | undefined, environment: FixtureEnvironment) => port === 55439 ||
  (port === 55440 && environment.CI === 'true' && environment.GITHUB_ACTIONS === 'true');
export function financeFixtureConfig(value: string, environment: FixtureEnvironment = process.env): PoolConfig {
  const url = new URL(value);
  const user = decodeURIComponent(url.username), password = decodeURIComponent(url.password);
  // CI has one fixed loopback container port; environment variables cannot choose a target.
  const port = url.port === '55439' ? 55439 : url.port === '55440' ? 55440 : undefined;
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1' || !fixturePortAllowed(port, environment) || url.pathname !== `/${fixtureDatabase}` ||
    url.search || url.hash || !user || !password || user.includes('\0') || password.includes('\0')) throw new Error('Only the exclusive loopback provenance fixture is allowed.');
  return { host: '127.0.0.1', port, database: fixtureDatabase, user, password, ssl: false, max: 5, connectionTimeoutMillis: 3000, statement_timeout: 10000 };
}
export async function assertFinanceFixture(client: PoolClient, config: PoolConfig) {
  const stream = (client as PoolClient & { connection?: { stream?: unknown } }).connection?.stream;
  if (!fixturePortAllowed(config.port, process.env) || !(stream instanceof Socket) || stream instanceof TLSSocket || stream.destroyed || stream.readyState !== 'open' || stream.remotePort !== config.port ||
    !['127.0.0.1', '::ffff:127.0.0.1'].includes(stream.remoteAddress ?? '')) throw new Error('The actual fixture connection must terminate on the approved loopback port.');
  const row = (await client.query('SELECT current_database() AS database,current_user AS current,session_user AS session,inet_server_addr()::text AS server,inet_server_port() AS port')).rows[0];
  if (row.database !== fixtureDatabase || row.current !== config.user || row.session !== config.user) throw new Error('Exact fixture database and authenticated login required.');
  return { server: row.server as string, port: row.port as number };
}
export const fixtureEvidence = { reference: 'fixture:synthetic-input', sha256: 'a'.repeat(64) };
export const fixtureAddress = (value: number) => encodeSolanaBase58(new Uint8Array(32).fill(value));
export async function financeFixture() {
  const path = process.env.PACTWOVEN_FINANCE_PROVENANCE_TEST_ADMIN_URL_FILE;
  if (!path) throw new Error('Explicit protected provenance fixture URL is required.');
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600 || info.size > 8192) throw new Error('Protected regular fixture URL file required.');
  const config = financeFixtureConfig((await readFile(path, 'utf8')).trim());
  const admin = new Pool(config), lock = await admin.connect(), pools: Pool[] = [], roles: string[] = [];
  let locked = false;
  const cleanup = async () => {
    await Promise.all(pools.map(pool => pool.end()));
    for (const role of roles) { await admin.query(`DROP OWNED BY "${role}"`); await admin.query(`DROP ROLE "${role}"`); }
    if (locked) await lock.query("SELECT pg_advisory_unlock(hashtextextended('finance_provenance_b2a_fixture',0))");
    lock.release(); await admin.end();
  };
  try {
    const server = await assertFinanceFixture(lock, config);
    await lock.query('SET statement_timeout=0');
    await lock.query("SELECT pg_advisory_lock(hashtextextended('finance_provenance_b2a_fixture',0))"); locked = true;
    await admin.query('DROP SCHEMA IF EXISTS pactwoven CASCADE');
    const migrations = await loadMigrations();
    if (migrations.length !== 7) throw new Error('Exactly the allocated seven migrations are required.');
    for (const migration of migrations) {
      const client = await admin.connect();
      try { await client.query('BEGIN'); for (const [index,statement] of migration.statements.entries()) {
        try { await client.query(statement); } catch(error) { throw new Error(`Fixture migration ${migration.filename} statement ${index+1} failed: ${statement.slice(0,130)}`,{cause:error}); }
      } await client.query('COMMIT'); }
      catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }
    const initialRegistryRows = Number((await admin.query('SELECT (SELECT count(*) FROM pactwoven.finance_physical_assets)+(SELECT count(*) FROM pactwoven.finance_physical_accounts)+(SELECT count(*) FROM pactwoven.finance_sources)+(SELECT count(*) FROM pactwoven.finance_source_bindings) AS count')).rows[0].count);
    const suffix = randomBytes(5).toString('hex');
    const makeLogin = async (label: string, group: string | null) => {
      const role = `pactwoven_fin_b2a_${suffix}_${label}`, password = randomBytes(32).toString('base64url');
      await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD ${literal(password)} NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`); roles.push(role);
      if (group) await admin.query(`GRANT "${group}" TO "${role}"`);
      const pool = new Pool({ ...config, user: role, password }); pools.push(pool);
      const client = await pool.connect();
      try { const actual = await assertFinanceFixture(client, { ...config, user: role }); if (actual.server !== server.server || actual.port !== server.port) throw new Error('Fixture principals reached different servers.'); }
      finally { client.release(); }
      return { role, password, pool };
    };
    const a = await makeLogin('observer_a', 'pactwoven_finance_observer'), b = await makeLogin('observer_b', 'pactwoven_finance_observer'), c = await makeLogin('observer_c', 'pactwoven_finance_observer');
    const runtime = await makeLogin('runtime', 'pactwoven_runtime'), bootstrap = await makeLogin('bootstrap', 'pactwoven_provisioner'), access = await makeLogin('access', 'pactwoven_access_provisioner'), mandate = await makeLogin('mandate', 'pactwoven_mandate_writer'), stranger = await makeLogin('stranger', null);
    const assetKey = await physicalAssetKey(FINANCE_DEVNET_ASSET), accountA = await physicalAccountKey({ genesis: FINANCE_DEVNET_ASSET.genesis, address: fixtureAddress(11) }),
      accountB = await physicalAccountKey({ genesis: FINANCE_DEVNET_ASSET.genesis, address: fixtureAddress(12) }), accountC = await physicalAccountKey({ genesis: FINANCE_DEVNET_ASSET.genesis, address: fixtureAddress(13) });
    await admin.query("INSERT INTO pactwoven.organizations(environment,id,external_organization_id,name) VALUES('simulation','finance_org_a','finance_external_a','Synthetic provenance A'),('simulation','finance_org_b','finance_external_b','Synthetic provenance B'),('development','finance_org_a','finance_external_a_dev','Synthetic provenance other environment')");
    await admin.query('INSERT INTO pactwoven.finance_physical_assets(genesis,token_program,mint) VALUES($1,$2,$3)', [Buffer.from(decodeSolanaBase58(FINANCE_DEVNET_ASSET.genesis,32)), Buffer.from(decodeSolanaBase58(FINANCE_DEVNET_ASSET.tokenProgram,32)), Buffer.from(decodeSolanaBase58(FINANCE_DEVNET_ASSET.mint,32))]);
    await admin.query("INSERT INTO pactwoven.finance_asset_versions VALUES($1,1,'solana-original-devnet-usdc-v1',6,$2,'fixture_verifier','[]')", [assetKey, 'a'.repeat(64)]);
    await admin.query('INSERT INTO pactwoven.finance_asset_controls VALUES($1,1,true,null)', [assetKey]);
    for (const [address, org, key] of [[11,'finance_org_a',accountA],[12,'finance_org_a',accountB],[13,'finance_org_b',accountC]] as const) {
      await admin.query("INSERT INTO pactwoven.finance_physical_accounts(genesis,address,environment,organization_id) VALUES($1,$2,'simulation',$3)", [Buffer.from(decodeSolanaBase58(FINANCE_DEVNET_ASSET.genesis,32)), Buffer.from(new Uint8Array(32).fill(address)), org]);
      await admin.query("INSERT INTO pactwoven.finance_account_versions VALUES($1,1,$2,$3,$4,'fixture_verifier','[]',null)", [key,assetKey,Buffer.from(new Uint8Array(32).fill(21)),'a'.repeat(64)]);
      await admin.query('INSERT INTO pactwoven.finance_account_controls VALUES($1,1,true,null)',[key]);
    }
    for (const [id, login, org, accounts] of [['source_a',a,'finance_org_a',[accountA,accountB]],['source_b',b,'finance_org_a',[accountA]],['source_c',c,'finance_org_b',[accountC]]] as const) {
      await admin.query("INSERT INTO pactwoven.finance_sources VALUES($1,'simulation',$2)",[id,org]);
      await admin.query("INSERT INTO pactwoven.finance_source_versions VALUES($1,1,$2,'fixture_adapter','fixture_normalizer',$2,'fixture_verifier','[]')",[id,'a'.repeat(64)]);
      await admin.query('INSERT INTO pactwoven.finance_source_controls VALUES($1,1,true,null)',[id]);
      for (const account of accounts) await admin.query("INSERT INTO pactwoven.finance_source_bindings SELECT $1,$2,'simulation',$3,oid,rolname,true,null FROM pg_roles WHERE rolname=$4",[id,account,org,login.role]);
    }
    const input = async (key: string, kind: 'balance' | 'transfer' = 'balance'): Promise<FinanceProvenanceAppend> => {
      const bytes = new Uint8Array(165); bytes.set(decodeSolanaBase58(FINANCE_DEVNET_ASSET.mint,32)); bytes.set(new Uint8Array(32).fill(21),32); new DataView(bytes.buffer).setBigUint64(64,100n,true); bytes[108]=1;
      const payload = new TextEncoder().encode(`synthetic evidence ${key}`), payloadHash = provenanceHex(new Uint8Array(await crypto.subtle.digest('SHA-256',payload)));
      const context = { observedAt: new Date().toISOString(), slot:'522507643', commitment:'finalized' as const, blockHash:null, evidence:fixtureEvidence };
      return { schemaVersion:1,source:{id:'source_a',version:1},account:{key:accountA,version:1},asset:{key:assetKey,version:1},deliveryKey:key,
        adapterVersion:'fixture_adapter',normalizerVersion:'fixture_normalizer',payloadHex:provenanceHex(payload),payloadHash,evidence:fixtureEvidence,providerMetadata:{},
        observation:kind==='balance'?{kind,context,amountBaseUnits:'100',accountDataHex:provenanceHex(bytes)}:{kind,context,
          fact:{locator:{genesis:FINANCE_DEVNET_ASSET.genesis,signature:encodeSolanaBase58(new Uint8Array(64).fill(31)),outerInstructionIndex:0,innerInstructionOrdinal:null},
            asset:FINANCE_DEVNET_ASSET,source:fixtureAddress(12),destination:fixtureAddress(11),amountBaseUnits:'10',instructionKind:'TransferChecked',checkedDecimals:6,instructionDataHash:'b'.repeat(64)},
          execution:{transaction:'succeeded',invocation:'succeeded',evidence:fixtureEvidence,outerInstructionCount:1,innerInstructionCount:0,stackHeight:1}} };
    };
    return {admin,a,b,c,runtime,bootstrap,access,mandate,stranger,assetKey,accountA,accountB,accountC,input,close:cleanup,makeLogin,
      repository:new PostgresFinanceProvenanceRepository(a.pool), migrations:migrations.map(item=>item.filename),initialRegistryRows,config};
  } catch(error) { await cleanup(); throw error; }
}
export type FinanceFixture = Awaited<ReturnType<typeof financeFixture>>;
export const financeLookup = (input: FinanceProvenanceAppend) => ({sourceId:input.source.id,accountKey:input.account.key,deliveryKey:input.deliveryKey});
export async function rawFinanceAppend(client: Pool | PoolClient,input: unknown) { return (await client.query('SELECT pactwoven.append_finance_provenance($1::jsonb) AS response',[JSON.stringify(input)])).rows[0].response; }
export async function financeCounts(admin: Pool) {
  return (await admin.query(`SELECT jsonb_build_object('deliveries',(SELECT count(*) FROM pactwoven.finance_deliveries),'facts',(SELECT count(*) FROM pactwoven.finance_transfer_facts),
    'effects',(SELECT count(*) FROM pactwoven.finance_account_effects),'links',(SELECT count(*) FROM pactwoven.finance_observation_links),'conflicts',(SELECT count(*) FROM pactwoven.finance_provenance_conflicts),
    'operations',(SELECT count(*) FROM pactwoven.operations),'mandateOperations',(SELECT count(*) FROM pactwoven.mandate_operations),'outbox',(SELECT count(*) FROM pactwoven.outbox_events)) AS counts`)).rows[0].counts as Record<string,number>;
}
export async function waitForFinanceBlock(admin: Pool, waiter: number, holder: number) {
  const deadline = Date.now()+2500;
  while (Date.now()<deadline) { if ((await admin.query('SELECT $2::int=ANY(pg_blocking_pids($1)) AS blocked',[waiter,holder])).rows[0].blocked) return; await new Promise(resolve=>setTimeout(resolve,10)); }
  throw new Error('Expected actual PostgreSQL lock wait was not observed.');
}
