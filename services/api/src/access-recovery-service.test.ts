import { describe, expect, it, vi } from 'vitest';
import { AccessRecoveryResultSchema, type CloseAccessRecoveryIntent } from '@pactwoven/contracts';
import { AccessRecoveryMfaEvidenceSchema, type AccessRecoveryVerificationRequest, type VerifiedAccessRecoveryStepUpIdentity, type VerifiedIdentity } from '@pactwoven/db';
import { commandDigest, DomainError } from '@pactwoven/domain';
import { createAccessRecoveryGateway } from './access-recovery-service.js';

const key = 'original-access-key-001', nonce = '10000000-0000-4000-8000-000000000001';
const intent = (): CloseAccessRecoveryIntent => ({ schemaVersion: 1, kind: 'revise', reason: 'original_input_unavailable',
  expectedEnvironment: 'development', expectedOrganizationId: 'internal_org', expectedActorId: 'current_owner', expectedExternalMembershipId: 'provider_member', expectedAuthorityEpoch: 7 });
function fixture(disposition: 'recorded' | 'fenced' | 'not_recorded' = 'not_recorded') {
  const now = new Date().toISOString();
  const identity: VerifiedIdentity = { subject: 'provider_user', externalOrganizationId: 'provider_org', externalOrganizationName: 'Fixture organization',
    externalMembershipId: 'provider_member', externalRole: 'org:admin', membershipObservedAt: now, sessionId: 'provider_session', authenticatedAt: now };
  const envelope = { schemaVersion: 1 as const, environment: 'development' as const, organizationId: 'internal_org', externalOrganizationId: 'provider_org', kind: 'revise' as const, key,
    observedAt: now, reviewer: { actorId: 'current_owner', externalMembershipId: 'provider_member', authorityEpoch: 7 } };
  const fenced = { ...envelope, disposition: 'fenced' as const, fence: { id: 'fence_a', closedAt: now } };
  const recorded = { ...envelope, disposition: 'recorded' as const, operation: { id: 'operation_a', environment: 'development', status: 'succeeded',
    aggregateId: 'target_member', aggregateVersion: 2, financialState: null, evidenceRefs: [], nextCheckAt: null, error: null } };
  const read = AccessRecoveryResultSchema.parse(disposition === 'fenced' ? fenced : disposition === 'recorded' ? recorded : { ...envelope, disposition });
  const close = AccessRecoveryResultSchema.parse(disposition === 'recorded' ? recorded : fenced);
  const order: string[] = [];
  const repository = { get: vi.fn(async () => { order.push('read'); return structuredClone(read); }), close: vi.fn(async (_verified: VerifiedAccessRecoveryStepUpIdentity, _key: string, _intent: CloseAccessRecoveryIntent, _trace: string) => { order.push('close'); return structuredClone(close) as Exclude<typeof close, { disposition: 'not_recorded' }>; }) };
  const verifyIdentity = vi.fn(async () => structuredClone(identity));
  const verifyRecoveryStepUp = vi.fn(async (_token: string, request: AccessRecoveryVerificationRequest) => {
    order.push('verify'); const issued = Math.floor(Date.now() / 1000) * 1000;
    return { identity: structuredClone(identity), evidence: AccessRecoveryMfaEvidenceSchema.parse({ id: crypto.randomUUID(), purpose: 'member_access_recovery_close',
      requestNonce: request.nonce, kind: request.intent.kind, key: request.key, scope: request.scope, intentHash: await commandDigest(request.intent),
      requestHash: await commandDigest({ schemaVersion: 1, purpose: 'member_access_recovery_close', request }), subject: identity.subject,
      externalOrganizationId: identity.externalOrganizationId, externalMembershipId: identity.externalMembershipId, sessionId: identity.sessionId,
      issuer: 'https://fixture.clerk.accounts.dev', tokenHash: 'b'.repeat(64), tokenIssuedAt: new Date(issued).toISOString(),
      firstFactorAgeMinutes: 0, secondFactorAgeMinutes: 0, verifiedAt: new Date(issued - 60_000).toISOString(), observedAt: new Date().toISOString(), expiresAt: new Date(issued + 60_000).toISOString() }) };
  });
  const dependencies = { environment: 'development' as const, repository, verifyIdentity, verifyRecoveryStepUp, requestNonce: nonce };
  return { identity, read, close, order, repository, verifyIdentity, verifyRecoveryStepUp, dependencies, gateway: createAccessRecoveryGateway(dependencies) };
}
describe('current-owner access recovery gateway', () => {
  it('reads the exact original namespace under current identity without factor or mutation calls', async () => {
    const f = fixture(); const result = await f.gateway.get('original bearer', { kind: 'revise', key }, 'trace');
    expect(result.disposition).toBe('not_recorded'); expect(f.repository.get).toHaveBeenCalledWith(f.identity, { kind: 'revise', key }, 'trace');
    expect(f.verifyRecoveryStepUp).not.toHaveBeenCalled(); expect(f.repository.close).not.toHaveBeenCalled();
  });
  it('resolves owner scope, then verifies exact close purpose, then submits once', async () => {
    const f = fixture(); const result = await f.gateway.close('original bearer', key, intent(), 'trace');
    expect(result.disposition).toBe('fenced'); expect(f.order).toEqual(['read', 'verify', 'close']);
    expect(f.verifyRecoveryStepUp).toHaveBeenCalledWith('original bearer', { nonce, key, intent: intent(), scope: {
      environment: 'development', organizationId: 'internal_org', actorId: 'current_owner', externalOrganizationId: 'provider_org', externalMembershipId: 'provider_member' } });
    expect(f.repository.close).toHaveBeenCalledTimes(1);
  });
  it.each(['recorded', 'fenced'] as const)('requires fresh close verification for an existing %s result even after the review epoch changed', async disposition => {
    const f = fixture(disposition); f.read.reviewer.authorityEpoch = 9; f.close.reviewer.authorityEpoch = 9;
    const result = await f.gateway.close('original bearer', key, intent(), 'trace');
    expect(result.disposition).toBe(disposition); expect(result.reviewer.authorityEpoch).toBe(9); expect(f.order).toEqual(['read', 'verify', 'close']);
  });
  it('does not skip factors just because the original record is already present', async () => {
    const f = fixture('recorded'); f.verifyRecoveryStepUp.mockRejectedValueOnce(new DomainError('STEP_UP_REQUIRED', 403, 'Fresh verification required.'));
    await expect(f.gateway.close('original bearer', key, intent(), 'trace')).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' }); expect(f.repository.close).not.toHaveBeenCalled();
  });
  it.each(['expectedEnvironment', 'expectedOrganizationId', 'expectedActorId', 'expectedExternalMembershipId'] as const)('refuses a changed %s pin before factors or closure', async field => {
    const f = fixture(), changed = intent(); (changed as Record<string, unknown>)[field] = field === 'expectedEnvironment' ? 'staging' : 'different_id';
    await expect(f.gateway.close('original bearer', key, changed, 'trace')).rejects.toBeDefined(); expect(f.verifyRecoveryStepUp).not.toHaveBeenCalled(); expect(f.repository.close).not.toHaveBeenCalled();
  });
  it.each(['subject', 'sessionId', 'externalOrganizationId', 'externalMembershipId', 'externalRole'] as const)('refuses a changed verified %s after provider verification', async field => {
    const f = fixture(), real = f.verifyRecoveryStepUp.getMockImplementation()!;
    f.verifyRecoveryStepUp.mockImplementationOnce(async (token, request) => { const value = await real(token, request); value.identity[field] = 'changed'; return value; });
    await expect(f.gateway.close('original bearer', key, intent(), 'trace')).rejects.toMatchObject({ code: 'AUTH_REQUIRED' }); expect(f.repository.close).not.toHaveBeenCalled();
  });
  it.each(['environment', 'externalOrganizationId', 'kind', 'key'] as const)('refuses a foreign or malformed %s in a repository read', async field => {
    const f = fixture(); (f.read as Record<string, unknown>)[field] = field === 'kind' ? 'grant' : 'other';
    await expect(f.gateway.close('original bearer', key, intent(), 'trace')).rejects.toMatchObject({ code: 'DURABLE_SERVICE_UNAVAILABLE' }); expect(f.verifyRecoveryStepUp).not.toHaveBeenCalled();
  });
  it.each(['key', 'requestNonce', 'intentHash', 'requestHash'] as const)('refuses recovery proof with a mismatched %s', async field => {
    const f = fixture(), real = f.verifyRecoveryStepUp.getMockImplementation()!;
    f.verifyRecoveryStepUp.mockImplementationOnce(async (token, request) => { const result = await real(token, request); result.evidence[field] = field === 'key' ? 'different-access-key-002' : field === 'requestNonce' ? crypto.randomUUID() : 'c'.repeat(64); return result; });
    await expect(f.gateway.close('original bearer', key, intent(), 'trace')).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' }); expect(f.repository.close).not.toHaveBeenCalled();
  });
  it('preserves the original invocation snapshot through identity-provider waits', async () => {
    const f = fixture(), original = intent(); f.verifyIdentity.mockImplementationOnce(async () => { original.expectedAuthorityEpoch++; original.kind = 'revoke'; return f.identity; });
    await f.gateway.close('original bearer', key, original, 'trace');
    expect(f.repository.close.mock.calls[0]?.[2]).toEqual(intent());
  });
  it('does not let a verifier mutate the outer nonce into a different valid proof', async () => {
    const f = fixture(), real = f.verifyRecoveryStepUp.getMockImplementation()!;
    f.verifyRecoveryStepUp.mockImplementationOnce(async (token, request) => { request.nonce = crypto.randomUUID(); return real(token, request); });
    await expect(f.gateway.close('original bearer', key, intent(), 'trace')).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' }); expect(f.repository.close).not.toHaveBeenCalled();
  });
  it.each(['absence', 'foreignOrganization', 'foreignReviewer'] as const)('does not report closure for %s', async failure => {
    const f = fixture(); const result = structuredClone(f.close);
    if (failure === 'foreignOrganization') result.organizationId = 'other_org';
    if (failure === 'foreignReviewer') result.reviewer.actorId = 'other_owner';
    f.repository.close.mockResolvedValueOnce((failure === 'absence' ? f.read : result) as never);
    await expect(f.gateway.close('original bearer', key, intent(), 'trace')).rejects.toMatchObject({ code: 'DURABLE_SERVICE_UNAVAILABLE' });
  });
  it('leaves stale new-fence epoch enforcement at the repository and never automatically retries', async () => {
    const f = fixture(); f.repository.close.mockRejectedValueOnce(new DomainError('VERSION_CONFLICT', 409, 'Authority changed.'));
    await expect(f.gateway.close('original bearer', key, intent(), 'trace')).rejects.toMatchObject({ code: 'VERSION_CONFLICT' }); expect(f.repository.close).toHaveBeenCalledTimes(1);
  });
  it('uses a new nonce per direct Node invocation and refuses an invalid bound private nonce', async () => {
    const f = fixture(), { requestNonce: _, ...dependencies } = f.dependencies, gateway = createAccessRecoveryGateway(dependencies);
    await gateway.close('original bearer', key, intent(), 'trace'); await gateway.close('original bearer', key, intent(), 'trace');
    expect(f.verifyRecoveryStepUp.mock.calls[0]?.[1].nonce).not.toBe(f.verifyRecoveryStepUp.mock.calls[1]?.[1].nonce);
    expect(() => createAccessRecoveryGateway({ ...f.dependencies, requestNonce: 'invalid' })).toThrow();
  });
});
