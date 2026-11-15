import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createClerkIdentityVerifier } from './auth.js';

describe('Clerk session verifier', () => {
  let privateKey: KeyObject;
  let publicPem: string;
  const issuer = 'https://pactwoven-test.clerk.accounts.dev';
  const origin = 'http://localhost:3001';
  const session = () => ({ id: 'sess_test', userId: 'user_test', status: 'active', expireAt: Date.now() + 60_000,
    createdAt: Date.now() - 3_600_000, lastActiveOrganizationId: 'org_test', actor: null });
  const membership = () => ({ id: 'membership_test', role: 'org:admin',
    organization: { id: 'org_test', name: 'Harbor Events' }, publicUserData: { userId: 'user_test' } });
  const membershipResult = () => ({ data: [membership()], totalCount: 1 });
  beforeAll(() => {
    const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
    privateKey = keys.privateKey;
    publicPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  });
  function token(overrides: Record<string, unknown> = {}) {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'local_test_key', cat: 'cl_B7d4PD111AAA' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ sub: 'user_test', sid: 'sess_test', iss: issuer, azp: origin,
      iat: now - 5, nbf: now - 5, exp: now + 60, v: 2, o: { id: 'org_test', rol: 'admin' }, ...overrides })).toString('base64url');
    return `${header}.${body}.${sign('RSA-SHA256', Buffer.from(`${header}.${body}`), privateKey).toString('base64url')}`;
  }
  function verifier(observedSession = session(), observedMembership = membershipResult()) {
    return createClerkIdentityVerifier({ secretKey: 'sk_test_local_fixture', issuer, authorizedParties: [origin], jwtKey: publicPem },
      async () => observedSession, async () => observedMembership);
  }
  it('verifies a signature and takes organization from the signed claim, not a role claim', async () => {
    const result = await verifier()(token());
    expect(result).toMatchObject({ subject: 'user_test', externalOrganizationId: 'org_test', sessionId: 'sess_test' });
    expect(Date.parse(result.authenticatedAt)).toBeLessThan(Date.now() - 3_500_000);
    expect(result).not.toHaveProperty('roles');
    expect(result).toMatchObject({ externalMembershipId: 'membership_test', externalRole: 'org:admin', externalOrganizationName: 'Harbor Events' });
  });
  it('rejects wrong issuer, wrong frontend audience, expired and tampered tokens', async () => {
    const verify = verifier();
    for (const candidate of [token({ iss: 'https://other.clerk.accounts.dev' }), token({ azp: 'https://attacker.example' }),
      token({ exp: Math.floor(Date.now() / 1000) - 1 }), `${token().split('.').slice(0, 2).join('.')}.invalidsignature`]) {
      await expect(verify(candidate)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    }
  });
  it('rejects inactive, mismatched or impersonated sessions', async () => {
    await expect(verifier({ ...session(), status: 'revoked' })(token())).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    await expect(verifier({ ...session(), userId: 'other_user' })(token())).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    await expect(verifier()(token({ act: { sub: 'impersonator' } }))).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    await expect(verifier()(token({ o: undefined, org_id: undefined }))).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });
  it('does not treat a provider outage as a valid session', async () => {
    const verify = createClerkIdentityVerifier({ secretKey: 'sk_test_local_fixture', issuer, authorizedParties: [origin], jwtKey: publicPem },
      async () => { throw new Error('provider timeout'); }, async () => membershipResult());
    await expect(verify(token())).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE', status: 503 });
    const memberFailure = createClerkIdentityVerifier({ secretKey: 'sk_test_local_fixture', issuer, authorizedParties: [origin], jwtKey: publicPem },
      async () => session(), async () => { throw new Error('private provider detail'); });
    await expect(memberFailure(token())).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE', status: 503 });
  });
  it('rejects missing, duplicated, wrong-organization and wrong-user live memberships', async () => {
    for (const result of [
      { data: [], totalCount: 0 },
      { data: [membership(), membership()], totalCount: 2 },
      { data: [{ ...membership(), organization: { id: 'other_org', name: 'Other' } }], totalCount: 1 },
      { data: [{ ...membership(), publicUserData: { userId: 'other_user' } }], totalCount: 1 },
    ]) await expect(verifier(session(), result)(token())).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('checks live membership on every call and never adopts token role claims', async () => {
    const member = membership();
    const lookup = vi.fn(async (org, subject) => {
      expect([org, subject]).toEqual(['org_test', 'user_test']);
      return { data: [member], totalCount: 1 };
    });
    const verify = createClerkIdentityVerifier({ secretKey: 'sk_test_local_fixture', issuer, authorizedParties: [origin], jwtKey: publicPem },
      async () => session(), lookup);
    const candidate = token();
    expect((await verify(candidate)).externalRole).toBe('org:admin');
    member.role = 'org:member';
    expect((await verify(candidate)).externalRole).toBe('org:member');
    expect(lookup).toHaveBeenCalledTimes(2);
  });
  it('rejects token or session expiry during provider verification', async () => {
    const observedSession = session();
    const verify = createClerkIdentityVerifier({ secretKey: 'sk_test_local_fixture', issuer, authorizedParties: [origin], jwtKey: publicPem },
      async () => ({ ...observedSession, expireAt: Date.now() - 1 }), async () => membershipResult());
    await expect(verify(token())).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    vi.useFakeTimers();
    try {
      const candidate = token();
      const tokenExpiresDuringLookup = createClerkIdentityVerifier(
        { secretKey: 'sk_test_local_fixture', issuer, authorizedParties: [origin], jwtKey: publicPem },
        async () => session(), async () => {
          vi.setSystemTime(Date.now() + 61_000);
          return membershipResult();
        });
      await expect(tokenExpiresDuringLookup(candidate)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    } finally { vi.useRealTimers(); }
  });
});
