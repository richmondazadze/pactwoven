import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as auth from './auth.js';
import { createSupplierRelationshipVerifier } from './supplier-relationship-verifier.js';

const sdk = vi.hoisted(() => ({ session: vi.fn(), membership: vi.fn() }));
vi.mock('@clerk/backend', async importOriginal => ({
  ...await importOriginal<typeof import('@clerk/backend')>(),
  createClerkClient: vi.fn(() => ({ sessions: { getSession: sdk.session }, organizations: { getOrganizationMembershipList: sdk.membership } })),
}));

// Real signed-token verification plus controlled SDK lookups, not live Clerk acceptance.
const NOW = Date.parse('2026-11-16T12:00:00.000Z'), issuer = 'https://pactwoven-test.clerk.accounts.dev', origin = 'http://localhost:3001';
const iso = (at: number) => new Date(at).toISOString();
const observer = () => ({ environment: 'simulation' as const, issuer, binding: {
  reference: { id: 'binding', version: 1, hash: 'a'.repeat(64) }, environment: 'simulation' as const, effectiveOrganizationId: 'buyer',
  verifier: { oid: 101, name: 'supplier_verifier' }, authorizer: { oid: 102, name: 'supplier_authorizer' },
  status: 'ACTIVE' as const, validFrom: iso(NOW - 3_600_000), expiresAt: iso(NOW + 3_600_000),
} });
const membership = () => ({ id: 'member_buyer', role: 'org:admin', organization: { id: 'org_buyer', name: 'Buyer' }, publicUserData: { userId: 'user_buyer' } });
const session = () => ({ id: 'session_buyer', userId: 'user_buyer', status: 'active', expireAt: NOW + 60_000,
  createdAt: NOW - 3_600_000, actor: null, lastActiveOrganizationId: 'org_buyer' });
let privateKey: KeyObject, publicPem: string;
function token(overrides: Record<string, unknown> = {}) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'local_test_key', cat: 'cl_B7d4PD111AAA' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ sub: 'user_buyer', sid: 'session_buyer', iss: issuer, azp: origin,
    iat: NOW / 1000 - 5, nbf: NOW / 1000 - 5, exp: NOW / 1000 + 60, v: 2, o: { id: 'org_buyer', rol: 'admin' }, fva: [0, 0], ...overrides })).toString('base64url');
  return `${header}.${body}.${sign('RSA-SHA256', Buffer.from(`${header}.${body}`), privateKey).toString('base64url')}`;
}
const config = () => ({ secretKey: 'sk_test_local_fixture', issuer, authorizedParties: [origin], jwtKey: publicPem });
const verifier = () => createSupplierRelationshipVerifier(config(), observer());
beforeAll(() => {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 }); privateKey = keys.privateKey;
  publicPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
});
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(NOW);
  sdk.session.mockReset().mockImplementation(async () => session());
  sdk.membership.mockReset().mockImplementation(async () => ({ totalCount: 1, data: [membership()] }));
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('private supplier genuine factor and identity verification', () => {
  it('retains exact bearer hash, signed time, original identity and conservative factors', async () => {
    const bearer = token(), verify = verifier(), identity = await verify.identity(bearer), factors = await verify.factors(bearer);
    expect(identity.observation).toEqual({ issuer, tokenHash: createHash('sha256').update(bearer).digest('hex'),
      tokenIssuedAt: iso(NOW - 5_000), observedAt: iso(NOW), expiresAt: iso(NOW + 60_000) });
    expect(factors.identity).toEqual(identity.identity);
    expect(factors.evidence).toMatchObject({ issuer, tokenHash: identity.observation.tokenHash, verifiedAt: iso(NOW - 65_000) });
    expect(Object.isFrozen(factors.evidence)).toBe(true);
    expect(factors.evidence).not.toHaveProperty('purpose');
    expect(JSON.stringify(factors)).not.toContain(bearer);
  });

  it('cannot substitute identity-only verification for a mutation or relabel other-purpose evidence', async () => {
    await expect(verifier().identity(token({ fva: undefined }))).resolves.toHaveProperty('observation');
    await expect(verifier().factors(token({ fva: undefined }))).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
    const factory = auth.createClerkFactorVerification;
    vi.spyOn(auth, 'createClerkFactorVerification').mockImplementation(configuration => {
      const verify = factory(configuration);
      return async bearer => { const result = await verify(bearer); return { ...result, evidence: { ...result.evidence, purpose: 'member_access' } }; };
    });
    await expect(verifier().factors(token())).rejects.toMatchObject({ code: 'SUPPLIER_VERIFICATION_REFUSED' });
  });

  it.each(['tokenHash', 'issuer'] as const)('independently rejects a wrong identity %s returned by the genuine factory seam', async field => {
    const factory = auth.createClerkIdentityObservationVerifier;
    vi.spyOn(auth, 'createClerkIdentityObservationVerifier').mockImplementation(configuration => {
      const verify = factory(configuration);
      return async bearer => { const value = await verify(bearer); value.observation[field] = field === 'issuer' ? 'https://foreign.invalid' : 'f'.repeat(64); return value; };
    });
    await expect(verifier().identity(token())).rejects.toMatchObject({ code: 'SUPPLIER_VERIFICATION_REFUSED' });
  });

  it.each(['tokenHash', 'issuer', 'subject', 'externalMembershipId', 'sessionId'] as const)('rejects factors with substituted %s', async field => {
    const factory = auth.createClerkFactorVerification;
    vi.spyOn(auth, 'createClerkFactorVerification').mockImplementation(configuration => {
      const verify = factory(configuration);
      return async bearer => { const value = await verify(bearer); value.evidence[field] = field === 'issuer' ? 'https://foreign.invalid' : field === 'tokenHash' ? 'f'.repeat(64) : 'foreign'; return value; };
    });
    await expect(verifier().factors(token())).rejects.toMatchObject({ code: 'SUPPLIER_VERIFICATION_REFUSED' });
  });

  it.each([20_000, 20_001])('retains independent membership freshness through a %i ms session lookup', async delay => {
    sdk.session.mockImplementation(async () => { vi.setSystemTime(NOW + delay); return session(); });
    const result = verifier().identity(token());
    if (delay === 20_000) expect((await result).observation.observedAt).toBe(iso(NOW));
    else await expect(result).rejects.toMatchObject({ code: 'SUPPLIER_VERIFICATION_REFUSED' });
  });

  it('rejects either factor at exactly five minutes and the exact provider expiry', async () => {
    await expect(verifier().factors(token({ iat: NOW / 1000, fva: [4, 0] }))).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
    await expect(verifier().factors(token({ iat: NOW / 1000, fva: [0, 4] }))).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
    sdk.session.mockResolvedValue({ ...session(), expireAt: NOW });
    await expect(verifier().identity(token())).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });

  it('captures configuration before provider waits and returns no provider diagnostics', async () => {
    const clerk = config(), privateConfig = observer(), verify = createSupplierRelationshipVerifier(clerk, privateConfig);
    clerk.issuer = 'https://changed.invalid'; clerk.authorizedParties[0] = 'https://changed.invalid'; privateConfig.binding.verifier.name = 'changed';
    await expect(verify.identity(token())).resolves.toMatchObject({ observation: { issuer } });
    sdk.membership.mockRejectedValue(new Error('SECRET_PROVIDER_DIAGNOSTIC'));
    await expect(verify.identity(token())).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE', message: 'Identity verification is temporarily unavailable.' });
  });

  it('copies SDK membership fields before the later session lookup can mutate its object', async () => {
    const held = membership();
    sdk.membership.mockResolvedValue({ totalCount: 1, data: [held] });
    sdk.session.mockImplementation(async () => { held.id = 'changed_after_observation'; held.role = 'org:member'; return session(); });
    const result = await verifier().identity(token());
    expect(result.identity).toMatchObject({ externalMembershipId: 'member_buyer', externalRole: 'org:admin' });
  });

  it('refuses invalid signatures, impersonation and wrong live subject/member/session', async () => {
    const jwt = token(), parts = jwt.split('.');
    parts[1] = Buffer.from(JSON.stringify({ sub: 'foreign' })).toString('base64url');
    await expect(verifier().identity(parts.join('.'))).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    await expect(verifier().identity(token({ act: { sub: 'admin' } }))).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    sdk.membership.mockResolvedValue({ totalCount: 1, data: [{ ...membership(), publicUserData: { userId: 'foreign' } }] });
    await expect(verifier().identity(token())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    sdk.membership.mockResolvedValue({ totalCount: 1, data: [membership()] });
    sdk.session.mockResolvedValue({ ...session(), id: 'foreign' });
    await expect(verifier().identity(token())).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });
});
