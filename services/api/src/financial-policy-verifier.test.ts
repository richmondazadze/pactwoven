import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createFinancialPolicyApiVerifier, assertFinancialPolicyObservationFresh, validateFinancialPolicyObservation } from './financial-policy-verifier.js';
import type { FinancialPolicyReaderScope } from '@pactwoven/db';

const at = Date.parse('2026-11-15T12:00:00.000Z'), time = (delta: number) => new Date(at + delta).toISOString();
const token = 'synthetic.token.only', issuer = 'https://synthetic.invalid';
const observation = () => ({ identity: { subject: 'subject_a', externalOrganizationId: 'clerk_org_a', externalOrganizationName: 'Synthetic',
  externalMembershipId: 'membership_a', externalRole: 'org:member', sessionId: 'session_a', membershipObservedAt: time(-1000), authenticatedAt: time(-60_000) },
  observation: { issuer, tokenHash: createHash('sha256').update(token).digest('hex'), tokenIssuedAt: time(-30_000), observedAt: time(-500), expiresAt: time(600_000) } });
const scope = (): FinancialPolicyReaderScope => ({ environment: 'development', organizationId: 'org_a', externalOrganizationId: 'clerk_org_a',
  actor: { actorId: 'actor_a', membershipVersion: 7, subject: 'subject_a', externalMembershipId: 'membership_a', sessionId: 'session_a' },
  organizationEpoch: 4, roles: ['operations'], siteIds: ['site_a'], actionSiteIds: ['site_a'] });

describe('financial-policy identity-only verifier (synthetic authenticator)', () => {
  it('retains oldest observation and exact current local actor in identity evidence', async () => {
    const v = createFinancialPolicyApiVerifier({ environment: 'development', issuer, observe: async () => observation(), now: () => at,
      newId: () => '00000000-0000-0000-0000-000000000001' });
    const o = validateFinancialPolicyObservation(await v.observe(token), token, issuer, at);
    expect(o.observation.observedAt).toBe(time(-1000));
    expect(v.identityEvidence(o, scope())).toMatchObject({ kind: 'identity', purpose: 'financial_policy_observation', actor: scope().actor,
      environment: 'development', observedAt: time(-1000), expiresAt: time(299_000), sessionExpiresAt: time(600_000) });
    expect(Object.keys(v).sort()).toEqual(['identityEvidence', 'observe']);
  });
  it.each(['issuer', 'tokenHash', 'tokenIssuedAt', 'observedAt', 'expiresAt'] as const)('rejects forged or stale %s', async key => {
    const raw = observation(); raw.observation[key] = key === 'issuer' ? 'https://other.invalid' : key === 'tokenHash' ? 'f'.repeat(64) :
      key === 'expiresAt' ? time(0) : time(1);
    const v = createFinancialPolicyApiVerifier({ environment: 'development', issuer, observe: async () => raw, now: () => at });
    await expect(v.observe(token)).rejects.toBeDefined();
  });
  it.each(['membershipObservedAt', 'authenticatedAt'] as const)('rejects future %s and old membership', key => {
    const raw = observation(); raw.identity[key] = time(1);
    expect(() => validateFinancialPolicyObservation(raw, token, issuer, at)).toThrow();
    raw.identity[key] = time(-20_000);
    if (key === 'membershipObservedAt') expect(() => validateFinancialPolicyObservation(raw, token, issuer, at)).toThrow();
  });
  it.each(['environment', 'externalOrganizationId', 'subject', 'externalMembershipId', 'sessionId', 'roles'] as const)('binds %s to current local scope', key => {
    const o = validateFinancialPolicyObservation(observation(), token, issuer, at), s = scope();
    if (key === 'environment') s.environment = 'production';
    else if (key === 'externalOrganizationId') s.externalOrganizationId = 'other_org';
    else if (key === 'roles') s.roles = ['auditor'];
    else s.actor[key] = 'other_identity';
    expect(() => assertFinancialPolicyObservationFresh(o, s, 'development', at)).toThrow();
  });
  it('checks elapsed waits and does not renew an observation on reuse', async () => {
    let clock = at;
    const v = createFinancialPolicyApiVerifier({ environment: 'development', issuer, observe: async () => { clock += 20_000; return observation(); }, now: () => clock });
    await expect(v.observe(token)).rejects.toMatchObject({ code: 'FINANCIAL_POLICY_EXPIRED' });
    const o = validateFinancialPolicyObservation(observation(), token, issuer, at);
    expect(() => assertFinancialPolicyObservationFresh(o, scope(), 'development', at + 19_000)).toThrow();
    expect(o.observation.observedAt).toBe(time(-1000));
  });
  it('captures construction functions and issuer, and returns detached provider output', async () => {
    const raw = observation(), original = vi.fn(async () => raw);
    const dependencies = { environment: 'development' as const, issuer, observe: original, now: () => at };
    const v = createFinancialPolicyApiVerifier(dependencies);
    dependencies.observe = vi.fn(async () => { throw new Error('replacement'); }); dependencies.issuer = 'https://other.invalid';
    const result = validateFinancialPolicyObservation(await v.observe(token), token, issuer, at);
    raw.identity.subject = 'changed'; expect(result.identity.subject).toBe('subject_a'); expect(original).toHaveBeenCalledExactlyOnceWith(token);
  });
});
