import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { AccessMfaEvidenceSchema, MandateMfaEvidenceSchema, AccessRecoveryMfaEvidenceSchema,
  type AccessRecoveryVerificationRequest, type MandateVerificationRequest } from '@pactwoven/db';
import { commandDigest, mandateIntentHash } from '@pactwoven/domain';
import { createClerkIdentityVerifier, createClerkIdentityObservationVerifier, createClerkFactorVerification,
  createClerkStepUpVerifier, createClerkMandateStepUpVerifier, createClerkAccessRecoveryStepUpVerifier } from './auth.js';

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
  function stepUpVerifier(observedSession = session(), observedMembership = membershipResult()) {
    return createClerkStepUpVerifier({ secretKey: 'sk_test_local_fixture', issuer, authorizedParties: [origin], jwtKey: publicPem },
      async () => observedSession, async () => observedMembership);
  }
  function mandateVerifier(observedSession = session(), observedMembership = membershipResult()) {
    return createClerkMandateStepUpVerifier({ secretKey: 'sk_test_local_fixture', issuer, authorizedParties: [origin], jwtKey: publicPem },
      async () => observedSession, async () => observedMembership);
  }
  function recoveryVerifier(observedSession = session(), observedMembership = membershipResult()) {
    return createClerkAccessRecoveryStepUpVerifier({ secretKey: 'sk_test_local_fixture', issuer, authorizedParties: [origin], jwtKey: publicPem },
      async () => observedSession, async () => observedMembership);
  }
  function observationVerifier(observedSession = session(), observedMembership = membershipResult()) {
    return createClerkIdentityObservationVerifier({ secretKey: 'sk_test_local_fixture', issuer, authorizedParties: [origin], jwtKey: publicPem },
      async () => observedSession, async () => observedMembership);
  }
  it('exposes bounded identity observations without implying factors, local authority or wallet possession', async () => {
    const jwt = token(), result = await observationVerifier()(jwt);
    expect(result.identity).toMatchObject({ subject: 'user_test', externalMembershipId: 'membership_test', sessionId: 'sess_test' });
    expect(result.observation).toMatchObject({ issuer });
    expect(result.observation.tokenHash).toBe(Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(jwt))).toString('hex'));
    expect(Object.keys(result.observation).sort()).toEqual(['expiresAt', 'issuer', 'observedAt', 'tokenHash', 'tokenIssuedAt']);
    expect(JSON.stringify(result)).not.toContain(jwt);
    expect(result).not.toHaveProperty('evidence');
  });
  it('caps a verified identity observation at the earlier signed token or live session expiry', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-15T12:00:00.000Z'));
    try {
      const now = Date.now(), iat = now / 1000;
      const first = await observationVerifier({ ...session(), expireAt: now + 9_000 })(token({ iat, exp: iat + 60 }));
      expect(first.observation.expiresAt).toBe(new Date(now + 9_000).toISOString());
      const second = await observationVerifier({ ...session(), expireAt: now + 60_000 })(token({ iat, exp: iat + 8 }));
      expect(second.observation.expiresAt).toBe(new Date(now + 8_000).toISOString());
    } finally { vi.useRealTimers(); }
  });
  it('refuses missing issue time, revoked sessions and absent membership in the observation seam', async () => {
    for (const iat of [undefined, -1]) await expect(observationVerifier()(token({ iat }))).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    await expect(observationVerifier({ ...session(), status: 'revoked' })(token())).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    await expect(observationVerifier(session(), { data: [], totalCount: 0 })(token())).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('keeps the first membership observation time when later session verification waits', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-15T12:00:00.000Z'));
    try {
      const now = Date.now(), jwt = token(), observedSession = session();
      const verify = createClerkIdentityObservationVerifier({ secretKey: 'sk_test_local_fixture', issuer, authorizedParties: [origin], jwtKey: publicPem },
        async () => { vi.setSystemTime(now + 21_000); return observedSession; }, async () => membershipResult());
      const result = await verify(jwt);
      expect(result.identity.membershipObservedAt).toBe(new Date(now).toISOString());
      expect(result.observation.observedAt).toBe(new Date(now).toISOString());
    } finally { vi.useRealTimers(); }
  });
  it('shares conservative factors without supplying a reusable domain-purpose assertion', async () => {
    const verify = createClerkFactorVerification({ secretKey: 'sk_test_local_fixture', issuer, authorizedParties: [origin], jwtKey: publicPem },
      async () => session(), async () => membershipResult());
    const result = await verify(token({ fva: [0, 0] }));
    expect(result.evidence).not.toHaveProperty('purpose');
    expect(AccessMfaEvidenceSchema.safeParse(result.evidence).success).toBe(false);
    expect(MandateMfaEvidenceSchema.safeParse(result.evidence).success).toBe(false);
    expect(Date.parse(result.evidence.verifiedAt)).toBe(Date.parse(result.evidence.tokenIssuedAt) - 60_000);
    await expect(verify(token({ fva: [4, 0] }))).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
  });
  it('snapshots the verification configuration before provider waits', async () => {
    for (const factory of [createClerkIdentityObservationVerifier, createClerkFactorVerification]) {
      const config = { secretKey: 'sk_test_local_fixture', issuer, authorizedParties: [origin], jwtKey: publicPem };
      const verify = factory(config, async () => session(), async () => {
        config.issuer = 'https://changed.clerk.accounts.dev'; config.authorizedParties.splice(0, 1, 'https://changed.example.test');
        return membershipResult();
      });
      const result = await verify(token({ fva: [0, 0] }));
      const details = 'observation' in result ? result.observation : result.evidence;
      expect(details.issuer).toBe(issuer);
      await expect(verify(token({ fva: [0, 0] }))).resolves.toHaveProperty('identity');
    }
  });
  function recoveryRequest(): AccessRecoveryVerificationRequest {
    return { nonce: '10000000-0000-4000-8000-000000000001', key: 'original-access-key-001',
      scope: { environment: 'development', organizationId: 'internal_org', actorId: 'current_owner', externalOrganizationId: 'org_test', externalMembershipId: 'membership_test' },
      intent: { schemaVersion: 1, kind: 'revise', reason: 'original_input_unavailable', expectedEnvironment: 'development',
        expectedOrganizationId: 'internal_org', expectedActorId: 'current_owner', expectedExternalMembershipId: 'membership_test', expectedAuthorityEpoch: 7 } };
  }
  it('constructs dedicated recovery proof from signed factors with exact original key and resolved reviewer scope', async () => {
    const jwt = token({ fva: [0, 0] }), request = recoveryRequest(), result = await recoveryVerifier()(jwt, request);
    expect(result.evidence).toMatchObject({ purpose: 'member_access_recovery_close', key: request.key, kind: request.intent.kind,
      scope: request.scope, requestNonce: request.nonce, intentHash: await commandDigest(request.intent),
      requestHash: await commandDigest({ schemaVersion: 1, purpose: 'member_access_recovery_close', request }) });
    expect(AccessRecoveryMfaEvidenceSchema.safeParse(result.evidence).success).toBe(true);
    expect(AccessMfaEvidenceSchema.safeParse(result.evidence).success).toBe(false);
    expect(MandateMfaEvidenceSchema.safeParse(result.evidence).success).toBe(false);
    expect(AccessRecoveryMfaEvidenceSchema.safeParse((await stepUpVerifier()(jwt)).evidence).success).toBe(false);
    expect(JSON.stringify(result)).not.toContain(jwt);
  });
  it('keeps recovery intent and request hashes distinct and binds nonce, original key, kind and reviewer', async () => {
    const jwt = token({ fva: [0, 0] }), request = recoveryRequest(), verify = recoveryVerifier(), first = await verify(jwt, request);
    for (const field of ['nonce', 'key'] as const) {
      const changed = structuredClone(request); changed[field] = field === 'nonce' ? crypto.randomUUID() : 'original-access-key-002';
      const next = await verify(jwt, changed);
      expect(next.evidence.intentHash).toBe(first.evidence.intentHash); expect(next.evidence.requestHash).not.toBe(first.evidence.requestHash);
    }
    const changed = structuredClone(request); changed.intent.kind = 'revoke';
    const next = await verify(jwt, changed);
    expect(next.evidence.intentHash).not.toBe(first.evidence.intentHash); expect(next.evidence.requestHash).not.toBe(first.evidence.requestHash);
  });
  it('snapshots recovery input before provider awaits and never derives authoritative reviewer pins from later input mutation', async () => {
    const request = recoveryRequest(), original = structuredClone(request);
    const verify = createClerkAccessRecoveryStepUpVerifier({ secretKey: 'sk_test_local_fixture', issuer, authorizedParties: [origin], jwtKey: publicPem },
      async () => session(), async () => { request.key = 'changed-original-key-002'; request.scope.actorId = 'different_owner'; request.intent.expectedAuthorityEpoch++; return membershipResult(); });
    const result = await verify(token({ fva: [0, 0] }), request);
    expect(result.evidence.scope).toEqual(original.scope);
    expect(result.evidence.requestHash).toBe(await commandDigest({ schemaVersion: 1, purpose: 'member_access_recovery_close', request: original }));
  });
  it('refuses foreign recovery membership, mismatched current pins and public proof fields', async () => {
    const jwt = token({ fva: [0, 0] }), verify = recoveryVerifier();
    const foreign = recoveryRequest(); foreign.scope.externalOrganizationId = 'foreign_org';
    await expect(verify(jwt, foreign)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const changed = recoveryRequest(); changed.intent.expectedActorId = 'different_owner';
    await expect(verify(jwt, changed)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    for (const input of [{ ...recoveryRequest(), proof: {} }, { ...recoveryRequest(), nonce: 'bad' },
      { ...recoveryRequest(), intent: { ...recoveryRequest().intent, originalCommand: {} } }]) {
      await expect(verify(jwt, input as never)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    }
  });
  it('requires fresh real factor verification for recovery without accepting access evidence or stale and revoked sessions', async () => {
    const verify = recoveryVerifier(), request = recoveryRequest(), jwt = token({ fva: [0, 0] });
    for (const fva of [undefined, [0, -1], [4, 0], [0, 4]]) await expect(verify(token({ fva }), request)).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
    await expect(verify(JSON.stringify((await stepUpVerifier()(jwt)).evidence), request)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    await expect(recoveryVerifier({ ...session(), status: 'revoked' })(jwt, request)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });
  function mandateRequest(): MandateVerificationRequest {
    return { nonce: '10000000-0000-4000-8000-000000000001', key: 'mandate-request-key-001', intent: {
      schemaVersion: 1, action: 'AUTHORIZE', proposal: { id: '10000000-0000-4000-8000-000000000002', version: 1, hash: 'a'.repeat(64) },
      expectedDecisionVersion: 1, expectedOrganizationEpoch: 2, expectedHead: null, reason: null,
    } };
  }
  function resumeRequest(): MandateVerificationRequest {
    const id = '10000000-0000-4000-8000-000000000003';
    return { ...mandateRequest(), intent: {
      schemaVersion: 1, action: 'RESUME', mandate: { id, version: 1, hash: 'b'.repeat(64) },
      head: { mandateId: id, mandateVersion: 1, mandateEpoch: 2, hash: 'c'.repeat(64) },
      responsibility: { id: '10000000-0000-4000-8000-000000000004', version: 1, hash: 'd'.repeat(64), siteId: '10000000-0000-4000-8000-000000000005' },
      expectedOrganizationEpoch: 2, reason: 'Resume the accepted advice mandate.',
    } };
  }
  it('derives distinct mandate purposes from exact intents after fresh signed-factor verification', async () => {
    const jwt = token({ fva: [0, 0] });
    for (const request of [mandateRequest(), resumeRequest()]) {
      const result = await mandateVerifier()(jwt, request);
      const purpose = request.intent.action === 'AUTHORIZE' ? 'mandate_authorization' : 'mandate_control';
      expect(result.evidence).toMatchObject({ purpose, subject: 'user_test', externalOrganizationId: 'org_test',
        externalMembershipId: 'membership_test', sessionId: 'sess_test', requestNonce: request.nonce,
        intentHash: await mandateIntentHash(request.intent), requestHash: await commandDigest({ schemaVersion: 1, purpose, request }) });
      expect(result.evidence.tokenHash).toHaveLength(64);
      expect(JSON.stringify(result)).not.toContain(jwt);
      expect(AccessMfaEvidenceSchema.safeParse(result.evidence).success).toBe(false);
    }
    expect(MandateMfaEvidenceSchema.safeParse((await stepUpVerifier()(jwt)).evidence).success).toBe(false);
  });
  it('binds command, nonce and original key without making the key part of the domain intent', async () => {
    const jwt = token({ fva: [0, 0] }), verify = mandateVerifier(), request = mandateRequest();
    const original = (await verify(jwt, request)).evidence;
    for (const changed of [{ ...request, nonce: '10000000-0000-4000-8000-000000000009' }, { ...request, key: 'mandate-request-key-002' }]) {
      const evidence = (await verify(jwt, changed)).evidence;
      expect(evidence.intentHash).toBe(original.intentHash);
      expect(evidence.requestHash).not.toBe(original.requestHash);
    }
    const changed = structuredClone(request); changed.intent.expectedOrganizationEpoch++;
    const evidence = (await verify(jwt, changed)).evidence;
    expect(evidence.intentHash).not.toBe(original.intentHash);
    expect(evidence.requestHash).not.toBe(original.requestHash);
  });
  it('snapshots the exact mandate request before awaiting provider state', async () => {
    const request = mandateRequest(), initial = structuredClone(request);
    const verify = createClerkMandateStepUpVerifier({ secretKey: 'sk_test_local_fixture', issuer, authorizedParties: [origin], jwtKey: publicPem },
      async () => session(), async () => { request.intent.expectedOrganizationEpoch++; request.key = 'mandate-mutated-during-verification'; return membershipResult(); });
    const result = await verify(token({ fva: [0, 0] }), request);
    expect(result.evidence.intentHash).toBe(await mandateIntentHash(initial.intent));
    expect(result.evidence.requestHash).toBe(await commandDigest({ schemaVersion: 1, purpose: 'mandate_authorization', request: initial }));
  });
  it('rejects public proof/purpose injection and stop/reject intents at the mandate MFA entry', async () => {
    const verify = mandateVerifier(), request = mandateRequest(), resume = resumeRequest(), jwt = token({ fva: [0, 0] });
    for (const invalid of [
      { ...request, purpose: 'member_access' }, { ...request, evidence: { verifiedAt: new Date().toISOString() } },
      { ...request, nonce: 'bad' }, { ...request, key: '' },
      { ...request, intent: { ...request.intent, actorId: '10000000-0000-4000-8000-000000000009' } },
      { ...request, intent: { ...request.intent, action: 'REJECT', reason: 'Reject' } },
      ...['PAUSE', 'REVOKE'].map(action => ({ ...resume, intent: { ...resume.intent, action } })),
    ]) await expect(verify(jwt, invalid as never)).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });
  });
  it('does not substitute member-access proof or stale/password-only tokens for mandate verification', async () => {
    const verify = mandateVerifier();
    for (const fva of [undefined, [-1, -1], [0, -1], [0, 4], [4, 0], ['0', 0], [0]]) {
      await expect(verify(token({ fva }), mandateRequest())).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
    }
    const jwt = token({ fva: [0, 0] });
    await expect(verify(JSON.stringify((await stepUpVerifier()(jwt)).evidence), mandateRequest())).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    await expect(mandateVerifier({ ...session(), status: 'revoked' })(jwt, mandateRequest())).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    await expect(mandateVerifier(session(), { data: [], totalCount: 0 })(jwt, mandateRequest())).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('retains conservative factor deadlines and rejects internally inconsistent mandate evidence', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-15T12:00:00.000Z'));
    try {
      const iat = Math.floor(Date.now() / 1000), request = mandateRequest();
      await expect(mandateVerifier()(token({ fva: [3, 3], iat: iat - 60 }), request)).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
      const { evidence } = await mandateVerifier()(token({ fva: [3, 3], iat: iat - 59 }), request);
      expect(Date.parse(evidence.expiresAt) - Date.now()).toBe(1000);
      for (const changed of [
        { ...evidence, verifiedAt: evidence.observedAt },
        { ...evidence, expiresAt: evidence.observedAt },
        { ...evidence, expiresAt: new Date(Date.parse(evidence.verifiedAt) + 300_001).toISOString() },
        { ...evidence, firstFactorAgeMinutes: 4 },
      ]) expect(MandateMfaEvidenceSchema.safeParse(changed).success).toBe(false);
    } finally { vi.useRealTimers(); }
  });
  it('requires both signed factors without downgrade and binds sanitized evidence to the verified token', async () => {
    const jwt = token({ fva: [0, 0] });
    const verified = await stepUpVerifier()(jwt);
    expect(verified.evidence).toMatchObject({ purpose: 'member_access', subject: 'user_test', sessionId: 'sess_test', firstFactorAgeMinutes: 0, secondFactorAgeMinutes: 0 });
    expect(verified.evidence.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(verified)).not.toContain(jwt);
    expect(Date.parse(verified.evidence.verifiedAt)).toBe(Date.parse(verified.evidence.tokenIssuedAt) - 60_000);
    expect(Date.parse(verified.evidence.expiresAt)).toBeLessThanOrEqual(Date.parse(verified.evidence.verifiedAt) + 300_000);
    for (const fva of [undefined, [-1, -1], [0, -1], [-1, 0], [0], [0, 0, 0], ['0', 0], [0, 0.1], [0, 5]]) {
      await expect(stepUpVerifier()(token({ fva }))).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
    }
  });
  it('ages both factors from signed issue time and denies exact freshness boundaries, refresh and forged sessions', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-14T12:00:00.000Z'));
    try {
      const iat = Math.floor(Date.now() / 1000);
      await expect(stepUpVerifier()(token({ fva: [3, 3], iat: iat - 60 }))).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
      await expect(stepUpVerifier()(token({ fva: [3, 3], iat: iat - 59 }))).resolves.toHaveProperty('evidence');
      await expect(stepUpVerifier()(token({ fva: [4, 0], iat }))).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
      await expect(stepUpVerifier()(token({ fva: [0, 4], iat }))).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
      await expect(stepUpVerifier()(token({ fva: [0, 0], iat: undefined }))).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
      await expect(stepUpVerifier()(token({ fva: [0, 0], iat: iat + 1 }))).rejects.toBeDefined();
      await expect(stepUpVerifier({ ...session(), status: 'revoked' })(token({ fva: [0, 0] }))).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
      await expect(stepUpVerifier()(token({ fva: [0, 0], act: { sub: 'other' } }))).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    } finally { vi.useRealTimers(); }
  });
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
