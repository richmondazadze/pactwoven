import { readFile, stat } from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';
import { commandDigest } from '@pactwoven/domain';
import type { CloseAccessRecoveryIntent, MemberCandidate } from '@pactwoven/contracts';
import type { VerifiedIdentity } from './repository.js';
import type { AccessMutation, VerifiedStepUpIdentity } from './access-repository.js';
import type { VerifiedAccessRecoveryStepUpIdentity, AccessRecoveryAuthorityScope } from './access-recovery-schema.js';

export const iso = (time: number) => new Date(time).toISOString();
export const identity = (subject = 'owner_a', organization = 'clerk_org_a'): VerifiedIdentity => ({ subject, externalOrganizationId: organization,
  externalOrganizationName: organization, externalMembershipId: `membership_${subject}`, externalRole: 'org:member',
  sessionId: `session_${subject}`, authenticatedAt: iso(Date.now() - 3_600_000), membershipObservedAt: iso(Date.now()) });
export const scopeFor = (actor = identity(), environment: AccessRecoveryAuthorityScope['environment'] = 'development'): AccessRecoveryAuthorityScope => ({
  environment, organizationId: actor.externalOrganizationId === 'clerk_org_a' ? 'org_a' : 'org_b', actorId: actor.subject,
  externalOrganizationId: actor.externalOrganizationId, externalMembershipId: actor.externalMembershipId,
});
export const intentFor = (kind: CloseAccessRecoveryIntent['kind'] = 'grant', actor = identity(), epoch = 0): CloseAccessRecoveryIntent => ({
  schemaVersion: 1, kind, reason: 'original_input_unavailable', expectedEnvironment: 'development',
  expectedOrganizationId: scopeFor(actor).organizationId, expectedActorId: actor.subject, expectedExternalMembershipId: actor.externalMembershipId, expectedAuthorityEpoch: epoch,
});
export function accessProof(actor = identity()): VerifiedStepUpIdentity {
  const issued = Math.floor(Date.now() / 1000) * 1000;
  return { identity: actor, evidence: { id: crypto.randomUUID(), purpose: 'member_access', subject: actor.subject,
    externalOrganizationId: actor.externalOrganizationId, externalMembershipId: actor.externalMembershipId, sessionId: actor.sessionId,
    issuer: 'https://fixture.clerk.accounts.dev', tokenHash: 'a'.repeat(64), tokenIssuedAt: iso(issued), firstFactorAgeMinutes: 0,
    secondFactorAgeMinutes: 0, verifiedAt: iso(issued - 60_000), observedAt: iso(Date.now()), expiresAt: iso(issued + 180_000) } };
}
export async function closeProof(key: string, intent = intentFor(), actor = identity(), scope = scopeFor(actor)): Promise<VerifiedAccessRecoveryStepUpIdentity> {
  const base = accessProof(actor), nonce = crypto.randomUUID(), request = { nonce, key, intent, scope }, purpose = 'member_access_recovery_close' as const;
  return { identity: actor, evidence: { ...base.evidence, purpose, requestNonce: nonce, kind: intent.kind, key, scope,
    intentHash: await commandDigest(intent), requestHash: await commandDigest({ schemaVersion: 1, purpose, request }) } };
}
export function grant(subject = 'finance_a', epoch = 0): AccessMutation {
  const target: MemberCandidate = { externalOrganizationId: 'clerk_org_a', externalMembershipId: `membership_${subject}`, externalSubject: subject, displayName: subject, externalRole: 'org:member', observedAt: iso(Date.now()) };
  return { kind: 'grant', target, command: { expectedVersion: 0, mandateVersion: null, authorityEpoch: epoch,
    payload: { externalMembershipId: target.externalMembershipId, externalSubject: subject, roles: ['finance'], siteIds: [], actionSiteIds: ['site_a'], expiresAt: null } } };
}
export async function rawClose(client: Pool | PoolClient, verified: VerifiedAccessRecoveryStepUpIdentity, key: string, intent: CloseAccessRecoveryIntent) {
  return (await client.query('SELECT pactwoven.close_access_recovery($1,$2::jsonb,$3::jsonb,$4,$5::jsonb,$6) AS response',
    ['development', JSON.stringify(verified.identity), JSON.stringify(verified.evidence), key, JSON.stringify(intent), 'recovery_test'])).rows[0].response;
}
export async function rawChange(client: Pool | PoolClient, verified: VerifiedStepUpIdentity, key: string, mutation: AccessMutation) {
  const actorId = mutation.kind === 'grant' ? null : mutation.actorId, hash = await commandDigest({ schemaVersion: 1, kind: `member.${mutation.kind}`, environment: 'development',
    externalOrganizationId: verified.identity.externalOrganizationId, subject: verified.identity.subject, actorId, command: mutation.command });
  return (await client.query('SELECT pactwoven.change_member_access($1,$2::jsonb,$3::jsonb,$4::jsonb,$5,$6,$7::jsonb,$8,$9,$10) AS response',
    ['development',JSON.stringify(verified.identity),JSON.stringify(verified.evidence),JSON.stringify(mutation.target),mutation.kind,actorId,JSON.stringify(mutation.command),key,hash,'recovery_test'])).rows[0].response;
}

const fixtureLabels = ['admin','runtime','bootstrap','access','mandate'] as const;
/** Test-only target allowlist; validation must finish before any Pool is created. */
export function validateRecoveryFixtureTargets(urls: readonly URL[], environment: NodeJS.ProcessEnv): void {
  const ci = environment.CI === 'true' && environment.GITHUB_ACTIONS === 'true';
  if (urls.length !== fixtureLabels.length) throw new Error('All five protected recovery fixture URLs are required.');
  for (const [index,url] of urls.entries()) {
    if (!['postgres:','postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1'
      || !(url.port === '55439' || (ci && url.port === '55440')) || url.pathname !== '/pactwoven_recovery_b1_test'
      || !url.username || url.search || url.hash) throw new Error('Only the exclusive recovery target is permitted.');
    if (index !== 0 && url.username !== `pactwoven_recovery_b1_test_${fixtureLabels[index]}`) throw new Error('Dedicated recovery login required.');
  }
  if (new Set(urls.map(url => url.port)).size !== 1) throw new Error('All five recovery URLs must select the same target.');
  if (new Set(urls.map(url => url.username)).size !== 5) throw new Error('Five distinct fixture identities required.');
}

export async function fixture() {
  const labels = fixtureLabels;
  const urls = await Promise.all(labels.map(async label => {
    const file = process.env[`PACTWOVEN_RECOVERY_TEST_${label.toUpperCase()}_URL_FILE`]; if (!file) throw new Error('Explicit protected recovery fixture credentials required.');
    if (((await stat(file)).mode & 0o777) !== 0o600) throw new Error('Recovery credentials must be protected.');
    const url = new URL((await readFile(file,'utf8')).trim());
    return url;
  }));
  validateRecoveryFixtureTargets(urls,process.env);
  const pools = urls.map(url => new Pool({ connectionString:url.href,max:6,statement_timeout:5000,connectionTimeoutMillis:3000 }));
  const [admin,runtime,bootstrap,access,mandate] = pools as [Pool,Pool,Pool,Pool,Pool];
  let lock: PoolClient | undefined;
  try {
    const row = (await admin.query("SELECT current_database() AS name,shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()")).rows[0];
    if (row.name !== 'pactwoven_recovery_b1_test' || row.marker !== 'Pactwoven RECOVERY-01B B1 exclusive fixture') throw new Error('Recognized task-owned recovery database required.');
    lock = await admin.connect(); await lock.query("SELECT pg_advisory_lock(hashtext('recovery_b1_author_qualification'))");
    await admin.query('DROP SCHEMA IF EXISTS pactwoven CASCADE');
    for (const file of ['0001_foundation.sql','0002_organization_bootstrap.sql','0003_identity_access.sql','0004_mandate_authority.sql','0005_access_acceptance.sql','0006_access_recovery_fences.sql']) {
      await admin.query(await readFile(new URL(`../migrations/${file}`, import.meta.url),'utf8'));
    }
  } catch(error) { if(lock) lock.release(); await Promise.all(pools.map(pool => pool.end())); throw error; }
  const close = async () => { await lock!.query("SELECT pg_advisory_unlock(hashtext('recovery_b1_author_qualification'))"); lock!.release(); await Promise.all(pools.map(pool => pool.end())); };
  const reset = async () => {
    // Only the administrator fixture may deliberately reset permanent test fences.
    await admin.query('ALTER TABLE pactwoven.member_access_key_fences DISABLE TRIGGER USER');
    try { await admin.query('TRUNCATE pactwoven.organizations,pactwoven.session_revocations CASCADE'); }
    finally { await admin.query('ALTER TABLE pactwoven.member_access_key_fences ENABLE TRIGGER USER'); }
    await admin.query("INSERT INTO pactwoven.organizations(environment,id,external_organization_id,name) VALUES('development','org_a','clerk_org_a','Recovery A'),('development','org_b','clerk_org_b','Recovery B')");
    await admin.query("INSERT INTO pactwoven.memberships(environment,organization_id,actor_id,external_subject,external_membership_id,roles,grant_basis) VALUES('development','org_a','owner_a','owner_a','membership_owner_a',ARRAY['owner'],'internal'),('development','org_a','owner_b','owner_b','membership_owner_b',ARRAY['owner'],'internal'),('development','org_a','observer_a','observer_a','membership_observer_a',ARRAY['auditor'],'internal'),('development','org_b','owner_c','owner_c','membership_owner_c',ARRAY['owner'],'internal')");
    await admin.query("INSERT INTO pactwoven.sites(environment,organization_id,id,name,time_zone) VALUES('development','org_a','site_a','Recovery site','UTC')");
  };
  return {admin,runtime,bootstrap,access,mandate,close,reset};
}
export type RecoveryFixture = Awaited<ReturnType<typeof fixture>>;
export async function snapshot(admin: Pool) {
  return (await admin.query(`SELECT jsonb_build_object('organizations',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM pactwoven.organizations t),
    'members',(SELECT jsonb_agg(to_jsonb(t) ORDER BY actor_id) FROM pactwoven.memberships t),
    'sites',(SELECT jsonb_agg(to_jsonb(t) ORDER BY actor_id,site_id) FROM pactwoven.site_memberships t),
    'actions',(SELECT jsonb_agg(to_jsonb(t) ORDER BY actor_id,site_id) FROM pactwoven.member_action_sites t),
    'operations',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM pactwoven.operations t),
    'history',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM pactwoven.member_access_history t),
    'outbox',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM pactwoven.outbox_events t)) AS state`)).rows[0].state;
}
export async function blockedBy(admin: Pool, waiter: PoolClient, holder: PoolClient) {
  const waiting = (await waiter.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  const holding = (await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  return { waiting, holding, wait: async () => {
    const deadline = Date.now()+3500;
    for (;;) {
      if ((await admin.query('SELECT $2::int=ANY(pg_blocking_pids($1)) AS yes',[waiting,holding])).rows[0].yes) return;
      if (Date.now()>deadline) throw new Error('Expected lock ordering not observed');
      await new Promise(resolve => setTimeout(resolve,10));
    }
  } };
}
