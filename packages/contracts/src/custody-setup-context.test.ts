import { describe, expect, it } from 'vitest';
import { CustodyApiRecoveryContextSchema } from './custody-setup-context';
const at = Date.parse('2026-11-15T12:00:00.000Z');
const value = { schemaVersion: 1, environment: 'development', organizationId: 'org_a', externalOrganizationId: 'provider_a', responsibilityId: 'responsibility_a',
  owner: { actorId: 'actor_a', subject: 'user_a', sessionId: 'session_a', externalMembershipId: 'membership_a', membershipVersion: 1 },
  observedAt: new Date(at).toISOString(), expiresAt: new Date(at + 20000).toISOString() };
describe('public custody recovery context', () => {
  it('accepts only the bounded owner observation projection', () => { expect(CustodyApiRecoveryContextSchema.parse(value)).toEqual(value); });
  it.each([0, -1, 20001])('rejects an invalid %i ms lifetime', lifetime => {
    expect(CustodyApiRecoveryContextSchema.safeParse({ ...value, expiresAt: new Date(at + lifetime).toISOString() }).success).toBe(false);
  });
  it.each(['tokenHash', 'issuer', 'specification', 'wallet', 'permitsSigning'])('rejects extra %s authority or private metadata', field => {
    expect(CustodyApiRecoveryContextSchema.safeParse({ ...value, [field]: 'unexpected' }).success).toBe(false);
  });
  it('rejects invented membership versions and nondevelopment environments', () => {
    expect(CustodyApiRecoveryContextSchema.safeParse({ ...value, owner: { ...value.owner, membershipVersion: 0 } }).success).toBe(false);
    expect(CustodyApiRecoveryContextSchema.safeParse({ ...value, environment: 'production' }).success).toBe(false);
  });
});
